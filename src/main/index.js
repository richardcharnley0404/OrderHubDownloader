const { app } = require('electron');
const windowManager = require('./window-manager');
const trayManager = require('./tray-manager');
const { setupIpcHandlers } = require('./ipc-handlers');
const pollingService = require('./services/polling-service');
const ftpService = require('./services/ftp-service');
const configService = require('./services/config-service');
const orientationService = require('./services/orientation-service');
const logger = require('./services/logger');
const updater = require('./updater');

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

  // This method will be called when Electron has finished initialization
  app.whenReady().then(() => {
    logger.info('Application starting', { version: app.getVersion() });

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
    const anyModeEnabled = (config.pollingEnabled && configService.isConfigured()) ||
      config.filmScansEnabled || config.fileUploadsEnabled;
    if (anyModeEnabled) {
      logger.info('Auto-starting polling service');
      try {
        pollingService.start();
      } catch (error) {
        logger.logError('Failed to auto-start polling', error);
      }
    }

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

    // Stop polling
    if (pollingService.isRunning()) {
      pollingService.stop();
    }

    // Release the ONNX inference session (no-op in the Milestone 1 skeleton).
    // Fire-and-forget - we don't want a slow .release() blocking app shutdown.
    try {
      orientationService.shutdown().catch(() => { /* ignored */ });
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
