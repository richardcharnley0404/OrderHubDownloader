const { app } = require('electron');
const windowManager = require('./window-manager');
const trayManager = require('./tray-manager');
const { setupIpcHandlers } = require('./ipc-handlers');
const pollingService = require('./services/polling-service');
const ftpService = require('./services/ftp-service');
const configService = require('./services/config-service');
const orientationService = require('./services/orientation-service');
const aiInferenceClient = require('./services/ai-inference-client');
const logger = require('./services/logger');
const updater = require('./updater');
const { runIntegrityQuarantineMigration } = require('./services/integrity-quarantine-migration');
const backupServiceModule = require('./services/backup-service');

// Disable libvips' operation cache. The cache retains file descriptors on
// recently-read images so subsequent passes are faster — but on a slow SMB
// share (Synology) the retained handle on a JPG races with our write+rename
// cycle in the rotation pipeline, surfacing as EPERM on rename. JPGs hit
// this much harder than TIFFs because libvips uses different loaders for
// the two formats. Throughput cost is small for our workload (each frame
// is read at most twice — once for prediction, once for rotation/thumb)
// and avoids the EPERM rabbit hole entirely. See M8-4 in the smoke-test doc.
require('sharp').cache(false);

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window
    logger.info('Second instance detected, showing window');
    windowManager.showWindow();
  });

  // Hourly backup interval handle — created inside whenReady() once the app
  // is up; cleared in the existing before-quit handler so it doesn't keep
  // the event loop alive during shutdown.
  let backupIntervalHandle = null;

  // This method will be called when Electron has finished initialization
  app.whenReady().then(async () => {
    logger.info('Application starting', { version: app.getVersion() });

    // v1.3.2 integrity-quarantine pivot — one-shot migration that restores
    // any legacy `<file>.quarantine` artifacts left by older builds and
    // archives their `_ohd-quarantine.json` manifests. Awaited (not
    // fire-and-forget) so the first FTP sweep sees the restored files in
    // their normal extensions; the walk is bounded to the download
    // directory and short on a typical install. Idempotent on re-launch
    // via the `_integrityQuarantineMigratedAt` config flag. Failures here
    // do NOT block startup — the flag stays unset so we retry next launch.
    try {
      await runIntegrityQuarantineMigration();
    } catch (err) {
      logger.logError('[migration] Integrity-quarantine migration threw — flag stays unset, will retry on next launch', err);
    }

    // Setup IPC handlers (pass windowManager so jobs:updated events can reach renderer)
    setupIpcHandlers(pollingService, ftpService, windowManager);

    // Create main window
    windowManager.createWindow();

    // Give the updater a reference to the window, then start the check-in schedule
    updater.setMainWindow(windowManager.getWindow());
    updater.startUpdateSchedule();

    // Create system tray
    trayManager.create(pollingService);

    // Start polling if any mode is configured and enabled
    const config = configService.getAll();

    // 2026-07-23 — Perfectly Clear enhancement recovery. Any roll left at
    // processingStatus:'enhancing' from a previous session is by
    // definition NOT backed by a live batch in this fresh process, so
    // sweep it into review before the polling service starts. Runs
    // BEFORE pollingService.start() so a wedge-recovered roll is in the
    // panel by the time the first film-scans cycle fires. Best-effort;
    // failures never block startup — the roll would just remain
    // 'enhancing' until the next launch (or an operator reset).
    try {
      const folderWatchService = require('./services/folder-watch-service');
      await folderWatchService.sweepStaleEnhancingRolls();
    } catch (err) {
      logger.logError('filmScans: startup enhancement sweep threw', err);
    }

    const anyModeEnabled = (config.pollingEnabled && configService.isConfigured()) ||
      config.filmScansEnabled || config.fileUploadsEnabled || config.orderXmlEnabled;
    if (anyModeEnabled) {
      logger.info('Auto-starting polling service');
      try {
        pollingService.start();
      } catch (error) {
        logger.logError('Failed to auto-start polling', error);
      }
    }

    // Daily backup launch trigger. Defer 30s so a network share has time to
    // come back online after the PC resumes from sleep. Fire-and-forget — a
    // failed backup must never disrupt startup. Gated on backupEnabled + a
    // configured folder; the service itself also short-circuits when the
    // last successful run was <24h ago.
    if (config.backupEnabled && config.backupFolderPath) {
      setTimeout(() => {
        try {
          const backupService = backupServiceModule.getDefault();
          if (backupService._shouldRunDailyBackup()) {
            backupService.runBackup({ trigger: 'launch-stale' }).catch((err) => {
              logger.logError('[backup] launch-stale backup threw', err);
            });
          }
        } catch (err) {
          logger.logError('[backup] launch-stale wiring failed', err);
        }
      }, 30_000);
    }

    // Daily backup background interval. The launch trigger above handles
    // "PC was off, just came on"; this hourly tick handles "PC has been on
    // for days, no restart" — without it, _shouldRunDailyBackup() never
    // re-runs after the first launch check, so a long-running instance
    // stops backing up entirely.
    //
    // Re-reads config on every tick (configService.get(...) goes back to
    // the disk-backed store) so a runtime backupEnabled toggle in Settings
    // is honoured without restart. Gates and call shape mirror the launch
    // trigger; only the trigger string differs so log analysis can tell
    // launch-fired backups from interval-fired ones.
    //
    // No jitter: only one lab PC per backup root in current deployments,
    // and the 24h gate is the real throttle even if multiple PCs ticked
    // simultaneously. Add small jitter here if a fleet ever shares a root.
    backupIntervalHandle = setInterval(() => {
      try {
        if (!configService.get('backupEnabled')) return;
        if (!configService.get('backupFolderPath')) return;
        const backupService = backupServiceModule.getDefault();
        if (!backupService._shouldRunDailyBackup()) return; // silent — gate closed
        backupService.runBackup({ trigger: 'interval-daily' }).catch((err) => {
          logger.logError('[backup] interval-daily backup threw', err);
        });
      } catch (err) {
        logger.logError('[backup] interval-daily tick failed', err);
      }
    }, 60 * 60 * 1000);

    // Film Scan AI Rotation (PW-007 Phase 1) — warm the ONNX orientation
    // service at startup when the feature flag is ON. init() is idempotent
    // and flag-gated internally, so calling it unconditionally is safe and
    // becomes a no-op when the flag is OFF. Fire-and-forget: boot must not
    // block on model loading (in Milestone 2 this will load ~77 MB of ONNX).
    orientationService.init()
      .then((ready) => {
        if (ready) {
          logger.info('[orientation] service warmed at startup');
        }
      })
      .catch((err) => {
        logger.logError('[orientation] startup init threw — feature will stay off at runtime', err);
      });


    // Update tray status periodically
    setInterval(() => {
      trayManager.updateStatus();
    }, 5000);

    app.on('activate', () => {
      // On macOS, re-create window when dock icon is clicked
      if (windowManager.getWindow() === null) {
        windowManager.createWindow();
      }
    });

    logger.info('Application ready');
  });

  // Prevent app from quitting when all windows are closed (system tray app)
  app.on('window-all-closed', () => {
    // Don't quit - keep running in tray
    logger.debug('All windows closed, app continues in tray');
  });

  // Handle app quit
  app.on('before-quit', () => {
    logger.info('Application quitting');

    // Clear the hourly backup interval so it doesn't keep the event loop
    // alive (or fire one more tick) during shutdown.
    if (backupIntervalHandle) {
      clearInterval(backupIntervalHandle);
      backupIntervalHandle = null;
    }

    // Stop polling
    if (pollingService.isRunning()) {
      pollingService.stop();
    }

    // Release the orientation-service handle and tear down the AI inference
    // host (utilityProcess). Fire-and-forget — we don't want a slow shutdown
    // blocking app quit. The host's own 2-second grace window will hard-kill
    // it if it doesn't honour the shutdown message.
    try {
      orientationService.shutdown().catch(() => { /* ignored */ });
    } catch (_) { /* ignored */ }
    try {
      aiInferenceClient.shutdown().catch(() => { /* ignored */ });
    } catch (_) { /* ignored */ }

    // Allow window to close
    const mainWindow = windowManager.getWindow();
    if (mainWindow) {
      mainWindow.removeAllListeners('close');
    }

    // Destroy tray
    trayManager.destroy();
  });

  app.on('quit', () => {
    logger.info('Application quit');
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.logError('Uncaught exception', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.logError('Unhandled rejection', new Error(String(reason)));
  });
}
