const { ipcMain, dialog, app, BrowserWindow, shell } = require('electron');
const updater = require('./updater');
const configService = require('./services/config-service');
const s3Service = require('./services/s3-service');
const jobService = require('./services/job-service');
const printService = require('./services/print-service');
const { DPOF_TYPES } = require('./services/controller-types');
const { awaitingReArmUpdates } = require('./services/awaiting-manifest');
const { runTest: runPrintControllerTest } = require('./services/test-print-controller');
const { printControllerStore } = require('./services/print-controller-store');
const routingService = require('./services/routing-service');
const { buildFolderCopyPreview } = require('./services/folder-copy-preview');
const processFolderService = require('./services/process-folder-service');
const fujiJobMakerConfig = require('./services/fuji-jobmaker-config');
const fujiPicProConfig   = require('./services/fuji-pic-pro-config');
const fujiPicProFileWriter = require('./services/fuji-pic-pro-file-writer');
const logger = require('./services/logger');
// Film Review panel (PW-007 Phase 1 — Milestone 4)
const frameMetadataStore = require('./services/frame-metadata-store');
const filmReviewPrefsStore = require('./services/film-review-prefs-store');
// App-wide UI prefs (theme) — lifted out of film-review-prefs during the
// 2026-04-29 theming consistency pass so a single header toggle can drive
// every panel.
const appPrefsStore = require('./services/app-prefs-store');
const folderWatchService = require('./services/folder-watch-service');
// AI Quality Gate (v1.2.0)
const jobDownloadService = require('./services/job-download-service');
const aiJobQualityOrchestrator = require('./services/ai-job-quality-orchestrator');
const aiQualityStore = require('./services/ai-quality-store');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');
const Store = require('electron-store');

// Persistent store for OHD-internal DPOF state (e.g. operator "Printed" flag).
// Separate from config-service so no schema validation is required.
const dpofStore = new Store({ name: 'dpof-state' });

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry-on-EPERM rename. Mirrors folder-watch-service's helper — keep them
 * in sync. The manual rotate IPC hits the same Windows+SMB hot spot when
 * sharp's writeFile leaves a brief handle on the destination, and JPGs
 * specifically race with Synology's photo indexer + Windows Defender.
 *
 * Up to 10 retries with capped exponential backoff (~22s total patience),
 * plus a final unlink+rename fallback in case the indexer holds a deny-write
 * handle that tolerates explicit delete.
 */
/**
 * Best-effort emit of `ohd:filmReview:roll-processed` so the renderer's
 * RollList re-fetches. Mirrors folder-watch-service's helper — keep them in
 * sync if either changes shape. Used by the approve-roll handler to push
 * status updates while an upload is in flight (so an operator who hops back
 * to the rolls list sees Uploading… → Uploaded without manual refresh).
 */
function emitFilmReviewRollUpdate(rollId) {
  try {
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (w && !w.isDestroyed()) {
        w.webContents.send('ohd:filmReview:roll-processed', { rollId });
      }
    }
  } catch (_) { /* best-effort */ }
}

async function renameWithRetry(src, dest, attempts = 10, baseDelay = 200, maxDelay = 4000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      const transient = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code);
      if (!transient) throw err;
      if (i < attempts - 1) {
        await _sleep(Math.min(baseDelay * Math.pow(2, i), maxDelay));
      }
    }
  }
  try {
    fs.unlinkSync(dest);
    fs.renameSync(src, dest);
    return;
  } catch (_) {
    throw lastErr;
  }
}

// Job Review Panel — main-process modules
const { loadSidecar, saveSidecar }             = require('./jobs/sidecarManager');
const { ensureWorkingSetup, ensureOriginals, resetImage, resetAllImages } = require('./jobs/originalsManager');
const { createReprint }                        = require('./jobs/reprintManager');
const { getJobOutputStatus }                   = require('./jobs/outputStatusManager');

// Phase 3 — AI Enhancement
const enhancementManager = require('./enhancement/enhancementManager');
const localEnhancementClient = require('./enhancement/localClient');

/**
 * Setup all IPC handlers
 */
function setupIpcHandlers(pollingService, ftpService, windowManager) {
  // One-time migration: copy DPOF controllers from the old print-controller-store
  // into the new routing-service data structures on first startup.
  routingService.migrateFromPrintControllerStore();

  // One-time backfill: copy legacy `mapping.size` into `mapping.printSizeCode`
  // for DPOF/Noritsu channel mappings whose printSizeCode is blank, so the
  // legacy-`size` fallback in resolvePrintSizeCode can be dropped in a
  // follow-up commit without changing what any mapping resolves to. Runs
  // AFTER the print-controller-store migration so it sees any mappings
  // freshly copied out of the old store on this same startup.
  routingService.backfillLegacyPrintSizeCode();

  // One-time backfill: copy bare-WxH `mapping.printCode` into `mapping.printSize`
  // for Fuji-family channel mappings so the new Manual Crop aspect resolver
  // (M0 of the Fuji PIC Pro brief) has a size to look up. Idempotent, guarded
  // by its own flag; non-WxH printCodes are left blank + logged so operators
  // can fix them via the amber badge on the routing list.
  routingService.backfillFujiPrintSize();

  // One-time cleanup: remove the now-deprecated routing keys from config.json
  // (orderControllers, processControllerMappings, channelMappings, ...).
  // Routing data lives exclusively in routing.json since the store split, but
  // the leftover stale duplicates in config.json have repeatedly misled
  // anyone debugging routing issues. Gated by its own flag so it runs once.
  routingService.stripDeprecatedConfigJsonKeys();

  // Configuration handlers
  ipcMain.handle('config:get', async () => {
    try {
      return configService.getAll();
    } catch (error) {
      logger.logError('Error getting config', error);
      throw error;
    }
  });

  ipcMain.handle('config:save', async (event, config) => {
    try {
      logger.info('Saving configuration');

      // Save configuration
      const savedConfig = configService.save(config);

      // Update Windows startup setting
      app.setLoginItemSettings({
        openAtLogin: config.launchOnStartup,
        path: process.execPath
      });

      // Restart or stop polling based on any mode being enabled
      const anyModeEnabled = config.pollingEnabled || config.filmScansEnabled ||
                             config.fileUploadsEnabled || config.orderXmlEnabled;
      if (anyModeEnabled) {
        if (pollingService.isRunning()) {
          pollingService.stop();
        }
        logger.info('Starting polling service');
        pollingService.start();
      } else {
        logger.info('Stopping polling service');
        pollingService.stop();
      }

      logger.info('Configuration saved successfully');
      // A changed default folder may unblock previously-unrouted jobs
      runAutoPrint().catch(err => logger.logError('[auto-print] post-config-save check failed', err));
      return savedConfig;
    } catch (error) {
      logger.logError('Error saving config', error);
      throw error;
    }
  });

  // Directory picker
  ipcMain.handle('dialog:selectDirectory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled) {
        return null;
      }

      return result.filePaths[0];
    } catch (error) {
      logger.logError('Error selecting directory', error);
      throw error;
    }
  });

  // CSV file picker (for channel mapping import)
  ipcMain.handle('dialog:selectCsvFile', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      const content = fs.readFileSync(result.filePaths[0], 'utf-8');
      return { canceled: false, filePath: result.filePaths[0], content };
    } catch (error) {
      logger.logError('Error selecting CSV file', error);
      throw error;
    }
  });

  ipcMain.handle('dialog:selectPdfFile', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePaths.length) return null;
      return result.filePaths[0];
    } catch (error) {
      logger.logError('Error selecting PDF file', error);
      throw error;
    }
  });

  // Save CSV export to file
  ipcMain.handle('dialog:exportCsv', async (event, { defaultName, content }) => {
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: defaultName || 'export.csv',
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      fs.writeFileSync(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    } catch (error) {
      logger.logError('Error exporting CSV', error);
      return { success: false, error: error.message };
    }
  });

  // FTP connection test
  ipcMain.handle('ftp:testConnection', async (event, credentials) => {
    try {
      logger.info('Testing FTP connection', { host: credentials.host });
      await ftpService.testConnection(credentials);
      logger.info('FTP connection test successful');
      return { success: true };
    } catch (error) {
      logger.logError('FTP connection test failed', error);
      return { success: false, error: error.message };
    }
  });

  // API connection test (uses hardcoded base URL, only needs API key)
  ipcMain.handle('api:testConnection', async (event, key) => {
    try {
      const { baseUrl } = configService.getApiSettings();
      logger.info('Testing API connection', { url: baseUrl });

      const result = await testApiConnection(baseUrl, key);

      if (result.success) {
        logger.info('API connection test successful');
      } else {
        logger.logWarning('API connection test failed', { error: result.error });
      }

      return result;
    } catch (error) {
      logger.logError('API connection test error', error);
      return { success: false, error: error.message };
    }
  });

  // FTP scan and download
  ipcMain.handle('ftp:scanAndDownload', async (event) => {
    try {
      const credentials = configService.getFtpCredentials();
      const remotePath = configService.get('ftpRemotePath') || '/';
      const localBasePath = configService.get('downloadDirectory');

      if (!credentials.host || !credentials.user || !credentials.password) {
        return { success: false, error: 'FTP credentials not configured' };
      }

      if (!localBasePath) {
        return { success: false, error: 'Download directory not configured' };
      }

      logger.info('Starting FTP scan and download', { remotePath, localBasePath });

      const sender = event.sender;
      const summary = await ftpService.scanAndDownload(
        credentials,
        remotePath,
        localBasePath,
        (progress) => {
          sender.send('ftp:downloadProgress', progress);
        }
      );

      logger.info('FTP scan and download complete', summary);
      return { success: true, summary };
    } catch (error) {
      logger.logError('FTP scan and download failed', error);
      return { success: false, error: error.message };
    }
  });

  // Polling status
  ipcMain.handle('polling:getStatus', () => {
    return pollingService.getStatus();
  });

  // Toggle polling
  ipcMain.handle('polling:toggle', () => {
    try {
      if (pollingService.isRunning()) {
        pollingService.stop();
        logger.info('Polling stopped by user');
      } else {
        if (!configService.isConfigured()) {
          throw new Error('Configuration incomplete');
        }
        pollingService.start();
        logger.info('Polling started by user');
      }
      return pollingService.getStatus();
    } catch (error) {
      logger.logError('Error toggling polling', error);
      throw error;
    }
  });

  // File Uploads status (last check time)
  ipcMain.handle('fileUploads:getStatus', () => {
    const status = pollingService.getStatus();
    return {
      lastCheckTime: status.lastFileUploadsCheck
    };
  });

  // ── Order XML hot folders (Mode 4) ────────────────────────
  // Lazy-required so disabled installs don't load the watcher / ingestion
  // store / chokidar at IPC-handler-registration time.
  const orderXmlHelpers = require('./services/order-xml-ipc-helpers');

  ipcMain.handle('orderXml:listRecords', async (event, args) => {
    try {
      const ingestionStore = require('./services/order-xml-ingestion-store').getDefaultInstance();
      return orderXmlHelpers.listRecords({ ingestionStore }, args || {});
    } catch (err) {
      logger.logError('orderXml:listRecords failed', err);
      return { ok: false, error: err.message, records: [], total: 0 };
    }
  });

  ipcMain.handle('orderXml:getStatus', async () => {
    try {
      const ingestionStore = require('./services/order-xml-ingestion-store').getDefaultInstance();
      return orderXmlHelpers.getStatus({ ingestionStore, configService, pollingService });
    } catch (err) {
      logger.logError('orderXml:getStatus failed', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('orderXml:clearRecords', async () => {
    try {
      const ingestionStore = require('./services/order-xml-ingestion-store').getDefaultInstance();
      return orderXmlHelpers.clearRecords({ ingestionStore });
    } catch (err) {
      logger.logError('orderXml:clearRecords failed', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('orderXml:retryFailed', async (event, args) => {
    try {
      const ingestionStore = require('./services/order-xml-ingestion-store').getDefaultInstance();
      return orderXmlHelpers.retryFailed(
        { ingestionStore, configService },
        args || {}
      );
    } catch (err) {
      logger.logError('orderXml:retryFailed failed', err);
      return { ok: false, error: err.message };
    }
  });

  // Returns the registered parser formats. Used by the settings UI dropdown
  // when the operator picks a sourceFormat for a hot folder. Whatever this
  // returns IS the dropdown — adding ROES/dotphoto later means dropping a
  // parser file in src/main/services/order-xml-parsers/ and the UI updates
  // automatically.
  ipcMain.handle('orderXml:listParserFormats', async () => {
    try {
      const registry = require('./services/order-xml-parsers');
      return { ok: true, formats: registry.list() };
    } catch (err) {
      logger.logError('orderXml:listParserFormats failed', err);
      return { ok: false, error: err.message, formats: [] };
    }
  });

  // Returns the operator-managed hot folder configs. Used by both the panel
  // (filter-by-folder dropdown) and the settings UI (list editor).
  ipcMain.handle('orderXml:getHotFolders', async () => {
    try {
      return { ok: true, hotFolders: configService.getAllHotFolders() };
    } catch (err) {
      logger.logError('orderXml:getHotFolders failed', err);
      return { ok: false, error: err.message, hotFolders: [] };
    }
  });

  // Open a hot folder's directory in the OS file manager.
  // `which` is 'watch' | 'processed' | 'failed' — failed/ resolves to
  // <processedFolder>/failed.
  ipcMain.handle('orderXml:openFolder', async (event, args) => {
    try {
      const which = args && args.which;
      const id    = args && args.id;
      if (!id || !which) return { ok: false, error: 'id and which are required' };
      const hf = configService.getAllHotFolders().find((h) => h.id === id);
      if (!hf) return { ok: false, error: `hot folder ${id} not found` };
      let target = null;
      if (which === 'watch')     target = hf.watchFolder;
      if (which === 'processed') target = hf.processedFolder;
      if (which === 'failed')    target = hf.processedFolder ? path.join(hf.processedFolder, 'failed') : null;
      if (!target) return { ok: false, error: `hot folder has no ${which} path` };
      const result = await shell.openPath(target);
      // shell.openPath returns '' on success and an error string on failure.
      if (result) return { ok: false, error: result };
      return { ok: true };
    } catch (err) {
      logger.logError('orderXml:openFolder failed', err);
      return { ok: false, error: err.message };
    }
  });

  // ── FTP Sources (M4a of docs/ftp-sources-brief.md) ─────────────────────
  //
  // Per-source IPC per Option F: general Settings save NEVER round-trips
  // ftpSources — each source is saved individually through save-source /
  // delete-source below. One bad row can only reject its own save, not
  // every other setting in the Downloads / Connection / Order XML blocks.
  //
  // After any successful save or delete, we reconcile the scheduler so
  // timers reflect current state without an app restart.
  //
  // Scope boundary: none of these handlers touch job-service,
  // routing-service, print-service, or runAutoPrint. Files moved by
  // this feature never become jobs.

  const ftpSourceScheduler   = require('./services/ftp-source-scheduler');
  const { testSourceConnection } = require('./services/ftp-source-service');

  // Return the full list of sources, ciphertext stripped, merged with
  // per-source scheduler status (running / lastRunAt / lastResult). The
  // renderer polls this on Downloads tab load + after each save/delete.
  ipcMain.handle('ohd:ftp-sources:list-sources', async () => {
    try {
      const rawSources = configService.getFtpSources();
      const statusById = new Map(
        ftpSourceScheduler.getStatuses().map((s) => [s.sourceId, s]),
      );
      const sources = rawSources.map((s) => {
        const { passwordEncrypted, ...rest } = s;
        const status = statusById.get(s.id) || null;
        return {
          ...rest,
          hasPassword: Boolean(passwordEncrypted),
          running:    status ? status.running    : false,
          lastRunAt:  status ? status.lastRunAt  : null,
          lastResult: status ? status.lastResult : null,
        };
      });
      return { success: true, sources };
    } catch (err) {
      logger.logError('[ftp-sources] list failed', err);
      return { success: false, error: err.message };
    }
  });

  // Save (create or update) one source. Validation lives inside
  // _sanitiseFtpSources via configService.saveFtpSource — reject-on-
  // invalid with a useful message. Reconciles the scheduler on success
  // so the operator's edit takes effect without a restart.
  ipcMain.handle('ohd:ftp-sources:save-source', async (event, source) => {
    try {
      const saved = configService.saveFtpSource(source);
      // Never send ciphertext back to the renderer — same boundary as
      // ohd:ftp-sources:list-sources above.
      const { passwordEncrypted, ...rest } = saved;
      const clean = { ...rest, hasPassword: Boolean(passwordEncrypted) };

      ftpSourceScheduler.reconcile(configService.getFtpSources());
      return { success: true, source: clean };
    } catch (err) {
      // The sanitiser's throws are already operator-actionable (M1 audit:
      // every throw names the source + wrong field). Log at warn so
      // repeated invalid saves are traceable without spamming error.
      logger.logWarning('[ftp-sources] save rejected', {
        sourceName: source && source.name,
        error:      err.message,
      });
      return { success: false, error: err.message };
    }
  });

  // Delete one source by id. Idempotent — deleting a non-existent id
  // returns success with `existed:false` so the renderer can distinguish
  // "operator raced two delete clicks" from "actually removed" for its
  // toast text if it cares.
  ipcMain.handle('ohd:ftp-sources:delete-source', async (event, id) => {
    try {
      if (typeof id !== 'string' || !id) {
        return { success: false, error: 'id is required' };
      }
      const result = configService.deleteFtpSource(id);
      ftpSourceScheduler.reconcile(configService.getFtpSources());
      return { success: true, existed: result.existed };
    } catch (err) {
      logger.logError('[ftp-sources] delete failed', err, { id });
      return { success: false, error: err.message };
    }
  });

  // Test-connection button (brief §M4: "the single highest-value control
  // in the feature"). Accepts a source shape with either freshly-typed
  // `password` plaintext OR stored `passwordEncrypted` — see
  // testSourceConnection docblock for the precedence rule.
  //
  // Saved-source lookup by id (M4b UX fix). The renderer never receives
  // the stored ciphertext (list-sources strips it — the "never render
  // a stored password back into the DOM" invariant). So when the
  // operator opens an edit modal for a saved source and clicks Test
  // WITHOUT re-typing the password, the payload has neither `password`
  // nor `passwordEncrypted`. Without the lookup below, the response
  // would be "No password supplied" — the most common test-connection
  // flow ("something is failing, let me test the config as saved")
  // silently unusable. Fix: when `id` is present and no password
  // material is on the payload, look up the ciphertext by id from the
  // store and merge it in before calling testSourceConnection. New
  // passwords typed in the modal still take precedence (the payload's
  // `password` field wins — see testSourceConnection's precedence).
  //
  // PLAINTEXT-IN-FLIGHT: this is the one place in the feature where the
  // password crosses the IPC boundary in the clear. The service function
  // handles scrubbing on every error path; this handler adds a defensive
  // wrapper that scrubs any accidental throw from OUTSIDE
  // testSourceConnection (unusual, but the invariant matters more than
  // the belt-and-braces cost). NEVER log the password field.
  ipcMain.handle('ohd:ftp-sources:test-connection', async (event, source) => {
    try {
      if (!source || typeof source !== 'object') {
        return { success: false, error: 'source is required' };
      }
      let payload = source;
      const hasPlaintext  = typeof source.password === 'string' && source.password.length > 0;
      const hasCiphertext = Boolean(source.passwordEncrypted);
      if (source.id && !hasPlaintext && !hasCiphertext) {
        const stored = configService.getFtpSources().find((s) => s.id === source.id);
        if (stored && stored.passwordEncrypted) {
          // Merge WITHOUT mutating the caller's object. testSourceConnection
          // will decrypt via encryption-service and scrub as usual.
          payload = { ...source, passwordEncrypted: stored.passwordEncrypted };
        }
        // If no stored ciphertext exists either, we fall through to
        // testSourceConnection which returns the "No password
        // supplied" error — correct for a saved source with no
        // password (draft) that the operator hasn't finished
        // configuring.
      }
      return await testSourceConnection(payload);
    } catch (err) {
      // Defensive: testSourceConnection is designed to never throw
      // (returns {success:false} on every error path), but a require
      // failure or programmer error could bubble up here. Scrub the
      // password from whatever the message says before returning.
      const { _scrubPasswordFromString } = require('./services/ftp-source-service');
      const plaintext = (typeof source.password === 'string' && source.password.length > 0)
        ? source.password
        : null;   // encryptedcase — no plaintext available here to scrub
      const raw   = err && err.message ? String(err.message) : 'Unknown error';
      const safe  = plaintext ? _scrubPasswordFromString(raw, plaintext) : raw;
      logger.logError('[ftp-sources] test-connection threw (unexpected)', err, {
        sourceName: source.name,
      });
      return { success: false, error: safe };
    }
  });

  // Test S3 connection
  ipcMain.handle('s3:testConnection', async (event, s3Config) => {
    try {
      const provider = s3Config.provider || 'pixfizz';
      logger.info('Testing S3 connection', { provider, bucketName: s3Config.bucketName });

      let credentials;
      if (provider === 'amazon') {
        credentials = {
          provider: 'amazon',
          accessKeyId: s3Config.accessKeyId,
          secretAccessKey: s3Config.secretAccessKey,
          bucketName: s3Config.bucketName,
          region: s3Config.region
        };
      } else {
        credentials = {
          provider: 'pixfizz',
          bucketName: s3Config.bucketName,
          locationId: s3Config.locationId || null
        };
      }

      const result = await s3Service.testConnection(credentials);
      return result;
    } catch (error) {
      logger.logError('S3 connection test error', error);
      return { success: false, error: error.message };
    }
  });

  // ── Job management handlers ──

  // Get cached jobs
  ipcMain.handle('jobs:getAll', async () => {
    try {
      return jobService.getLocalJobs();
    } catch (error) {
      logger.logError('Error getting jobs', error);
      return { jobs: [], lastFetchTime: null };
    }
  });

  // Refresh jobs from API
  // Sync active jobs (pending / received / in_production) against OH and push
  // jobs:updated if any were auto-completed or auto-cancelled out-of-band.
  async function syncAndNotify() {
    try {
      const count = await jobService.syncJobStatusFromOH();
      if (count > 0 && windowManager) {
        const win = windowManager.getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('jobs:updated', jobService.getLocalJobs());
        }
      }
    } catch (err) {
      logger.logWarning('[sync] syncAndNotify error', { error: err.message });
    }
  }

  ipcMain.handle('jobs:refresh', async () => {
    try {
      await syncAndNotify();
      const jobs = await jobService.fetchJobs();
      return { jobs, lastFetchTime: jobService.lastFetchTime };
    } catch (error) {
      logger.logError('Error refreshing jobs', error);
      return { jobs: [], lastFetchTime: null, error: error.message };
    }
  });

  // Send job to print
  ipcMain.handle('jobs:sendToPrint', async (event, jobId) => {
    try {
      // Find job in local cache
      const { jobs } = jobService.getLocalJobs();
      const job = jobs.find(j => j.id === jobId);

      if (!job) {
        return { success: false, error: 'Job not found' };
      }

      if (job._status !== 'received' && job._status !== 'pending') {
        return { success: false, error: `Job cannot be sent to print (status: ${job._status})` };
      }

      // Defensive: even though the renderer hides the Process button for
      // awaiting-manifest jobs, a direct IPC call from devtools or a stale
      // button click would still hit print-service._readManifest and throw.
      // Surface a clean error here instead.
      {
        const local = jobDownloadService.checkLocalFiles(job);
        if (local.hasFiles && !local.hasManifest) {
          return { success: false, error: 'Manifest not yet received' };
        }
      }

      // AI Quality Gate (v1.2.0) — also gate manual Process clicks so the
      // workflow is consistent: operators must release a held job via the
      // Quality flag before manual dispatch will work.
      if (configService.get('aiQualityEnabled')) {
        const local = jobDownloadService.checkLocalFiles(job);
        if (local.found) {
          try {
            // Sidecars are keyed by composite jobId (`${order_number}_${id}`)
            // — see _resolveSidecarJobId. Every orchestrator + ai-quality-store
            // entry point on the IPC boundary translates here so the storage
            // layer doesn't see the OrderHub numeric `job.id`.
            const sidecarJobId = _resolveSidecarJobId(job);
            const scoring = await aiJobQualityOrchestrator.scoreJob(sidecarJobId, local.localPath);
            if (scoring.held) {
              logger.info('[ai-quality] manual dispatch blocked — job held', { jobId: job.id, summary: scoring.summary });
              if (windowManager) {
                const mainWindow = windowManager.getWindow();
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('aiQuality:jobHeld', {
                    jobId: job.id,
                    summary: scoring.summary,
                  });
                }
              }
              return {
                success: false,
                error: `Job held by AI Quality — use the RELEASE button in the FLAGS column`,
                held: true,
                summary: scoring.summary,
              };
            }
          } catch (err) {
            logger.logError('[ai-quality] scoreJob threw on manual dispatch — passing through', err, { jobId: job.id });
          }
        }
      }

      await _stampDiscardedImageFilter(job);

      // ── New routing system ─────────────────────────────────────────────────
      // Attempt to resolve via the routing-service decision tree first.
      // Fall back to the old printControllerStore path if the job is unrouted.
      const route = routingService.resolveRoute(job);
      let result;

      // M5 (order-level-submission-picpro-brief): if the clicked job
      // routes to a merge-enabled Fuji PIC Pro controller, dispatch all
      // currently-eligible siblings from the same order as one
      // submission. Operator Process is the manual escape hatch — no
      // new button, and the clicked job is always included even if the
      // per-job hold gates would have blocked it (existing manual
      // Send-to-Print contract). Siblings only join if they'd pass the
      // gates in the auto-print loop.
      const mergeController = route && route.type === 'controller'
        && route.controllerType === 'fujipicpro'
        && (() => {
          const ctrl = routingService.getControllers().find(c => c.id === route.controllerId);
          return ctrl && ctrl.mergeOrderJobs === true ? ctrl : null;
        })();

      if (mergeController) {
        result = await _dispatchFujiPicProOrderMerge_Manual(job, route, jobs);
      } else if (route.type === 'process-folder') {
        result = await processFolderService.copyToFolder(job, route.folderPath);
      } else if (route.type === 'controller') {
        // Route resolved by the new routing engine — pass the full route so
        // print-service uses route.outputPath and route.channelNumber directly,
        // bypassing the legacy printControllerStore channel lookup.
        result = await printService.sendViaDPOFRouted(job, route);
      } else {
        // Unrouted — fall back to old system (printControllerStore + configService)
        result = await printService.sendToPrint(job);
      }

      // If the job was sent to a DPOF controller, resume the status poll so
      // we detect when the controller imports (or fails to import) the folder.
      if (result.success && result.method === 'dpof') {
        startStatusPolling(windowManager);
      }

      // Notify renderer with updated jobs
      if (windowManager) {
        const mainWindow = windowManager.getWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
        }
      }

      return result;
    } catch (error) {
      logger.logError('Error sending job to print', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  // Mark job as completed (printed)
  ipcMain.handle('jobs:markCompleted', async (event, jobId) => {
    try {
      const { jobs } = jobService.getLocalJobs();
      const job = jobs.find(j => j.id === jobId);

      if (!job) {
        return { success: false, error: 'Job not found' };
      }

      if (job._status !== 'in_production') {
        return { success: false, error: `Job cannot be marked as completed (status: ${job._status})` };
      }

      await jobService.markCompleted(jobId);

      // Notify renderer with updated jobs
      if (windowManager) {
        const mainWindow = windowManager.getWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
        }
      }

      return { success: true };
    } catch (error) {
      logger.logError('Error marking job as completed', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  // ── DPOF output status handlers ──

  /**
   * ohd:job:get-output-status
   * Payload:  { jobId }
   * Returns:  { prefix, folderName, folderPath } | null
   *
   * Scans the controller's hot folder for a p/o/q/e prefixed folder
   * matching this job. Returns null if the job has not yet been sent.
   */
  ipcMain.handle('ohd:job:get-output-status', async (event, { jobId }) => {
    try {
      const { jobs } = jobService.getLocalJobs();
      const job = jobs.find(j => String(j.id) === String(jobId));
      if (!job) return null;

      // Resolve the output folder path via the new routing system first.
      // Fall back to the old configService + printControllerStore path for
      // Darkroom Pro or any job that predates the new routing system.
      let outputFolderPath = null;

      let includeCustomerInFolder = true;
      const route = routingService.resolveRoute(job);
      if (route.type === 'controller') {
        // New system: routingService controller with outputPath
        const ctrl = routingService.getControllers().find(c => c.id === route.controllerId);
        outputFolderPath = ctrl ? ctrl.outputPath : null;
        if (ctrl) includeCustomerInFolder = ctrl.includeCustomerInFolder !== false;
      } else if (route.type !== 'process-folder') {
        // Fallback: old configService + printControllerStore
        const mapping = configService.getProcessMapping(job.process);
        if (mapping.controllerId) {
          const ctrl = printControllerStore.getController(mapping.controllerId);
          outputFolderPath = ctrl ? ctrl.hotFolderPath : null;
          if (ctrl) includeCustomerInFolder = ctrl.includeCustomerInFolder !== false;
        }
      }

      if (!outputFolderPath) return null;

      const status = await getJobOutputStatus(job, outputFolderPath, null, { includeCustomerName: includeCustomerInFolder });
      if (!status) return null;

      // Check if operator has manually marked this job as printed (OHD-internal flag).
      if (dpofStore.get(`printed.${String(jobId)}`)) {
        return { ...status, printed: true };
      }
      return status;
    } catch (error) {
      logger.logError('ohd:job:get-output-status error', error, { jobId });
      return null;
    }
  });

  /**
   * ohd:job:mark-printed
   * Payload:  { jobId }
   * Returns:  { success: true } | { success: false, error: string }
   *
   * OHD-internal "Printed" flag — no disk changes.
   * Records the job ID in electron-store (dpof-state) so the status persists
   * across app restarts.  Only valid when the current folder prefix is "e"
   * (Imported — controller has successfully imported the job).
   */
  ipcMain.handle('ohd:job:mark-printed', async (event, { jobId }) => {
    try {
      const { jobs } = jobService.getLocalJobs();
      const job = jobs.find(j => String(j.id) === String(jobId));
      if (!job) return { success: false, error: 'Job not found.' };

      // Resolve output folder via new routing system, fall back to old system.
      let outputFolderPath = null;
      let includeCustomerInFolder = true;

      const route = routingService.resolveRoute(job);
      if (route.type === 'controller') {
        const ctrl = routingService.getControllers().find(c => c.id === route.controllerId);
        outputFolderPath = ctrl ? ctrl.outputPath : null;
        if (ctrl) includeCustomerInFolder = ctrl.includeCustomerInFolder !== false;
      } else if (route.type !== 'process-folder') {
        const mapping = configService.getProcessMapping(job.process);
        if (mapping.controllerId) {
          const ctrl = printControllerStore.getController(mapping.controllerId);
          outputFolderPath = ctrl ? ctrl.hotFolderPath : null;
          if (ctrl) includeCustomerInFolder = ctrl.includeCustomerInFolder !== false;
        }
      }

      if (!outputFolderPath) {
        return { success: false, error: 'Controller or output folder not found.' };
      }

      const status = await getJobOutputStatus(job, outputFolderPath, null, { includeCustomerName: includeCustomerInFolder });
      if (!status) {
        return { success: false, error: 'Output folder not found for this job.' };
      }
      if (status.prefix !== 'e') {
        return { success: false, error: `Job is in "${status.prefix}" status — can only mark as printed from "e" (Imported).` };
      }

      // Record OHD-internal printed flag — no folder rename, no API call
      dpofStore.set(`printed.${String(jobId)}`, true);

      logger.info('Job marked as printed (OHD-internal)', { jobId });
      return { success: true };
    } catch (error) {
      logger.logError('ohd:job:mark-printed error', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:resend
   * Payload:  { jobId }
   * Returns:  { success: true, ... } | { success: false, error: string }
   *
   * Re-sends a DPOF job through the full print pipeline regardless of its
   * current _status. Used by the "Resend" (q status) and "Retry" (p status)
   * action buttons. A new p folder is written and renamed to o on success.
   */
  ipcMain.handle('ohd:job:resend', async (event, { jobId }) => {
    try {
      const { jobs } = jobService.getLocalJobs();
      const job = jobs.find(j => String(j.id) === String(jobId));
      if (!job) return { success: false, error: 'Job not found.' };

      // Clear any terminal-state tracking so the new o→e/q cycle is reported.
      _terminalJobs.delete(String(jobId));
      jobService.updateJobLocally(job.id, { _dpofNotified: false });

      // Bypass the _status === 'received' guard — resend is intentional.
      // Route via new routing system, fall back to old system if unrouted.
      const route = routingService.resolveRoute(job);
      let result;

      if (route.type === 'process-folder') {
        result = await processFolderService.copyToFolder(job, route.folderPath);
      } else if (route.type === 'controller') {
        result = await printService.sendViaDPOFRouted(job, route);
      } else {
        result = await printService.sendToPrint(job);
      }

      if (result.success && result.method === 'dpof') {
        startStatusPolling(windowManager);
      }

      if (windowManager) {
        const mainWindow = windowManager.getWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
        }
      }

      return result;
    } catch (error) {
      logger.logError('ohd:job:resend error', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:resend-dpof-batch
   * Payload:  { jobId, batchIndex, confirmed? }
   * Returns:  { success: true, folderName, destPath, batchIndex, batchTotal }
   *         | { success: false, needsConfirm: true, batchIndex, currentPrefix, error }
   *         | { success: false, error }
   *
   * Resends a SINGLE batch of a previously split DPOF dispatch
   * (docs/epson-batch-splitting-brief.md M4). Delegates to
   * printService.resendDpofBatch which reads the batch's stored
   * image set from the ledger (does NOT re-split the current
   * manifest — that would send different content under the same
   * batch number if the manifest changed since dispatch).
   *
   * Double-print guard: a batch already at acceptedPrefix === 'e'
   * refuses without `confirmed === true`. Renderer prompts and
   * re-invokes with `confirmed:true`.
   *
   * Clears the per-batch and per-job terminal-tracking state so the
   * resent batch's new o→e/q cycle is picked up by the poller and
   * pushed to the renderer.
   */
  ipcMain.handle('ohd:job:resend-dpof-batch', async (event, { jobId, batchIndex, confirmed } = {}) => {
    try {
      if (jobId === undefined || jobId === null) return { success: false, error: 'jobId required.' };
      if (!Number.isInteger(batchIndex) || batchIndex < 1) return { success: false, error: 'batchIndex must be a positive integer.' };

      const result = await printService.resendDpofBatch({
        jobId,
        batchIndex,
        opts: { confirmed: confirmed === true },
      });

      if (result.success) {
        // Clear terminal-state trackers so the poller re-notifies on
        // the new o→e/q cycle for this batch AND for the job as a whole
        // (allBatchesAccepted may fire again once every batch settles).
        _terminalJobs.delete(String(jobId));
        _terminalJobs.delete(`${jobId}:${batchIndex}`);
        jobService.updateJobLocally(jobId, { _dpofNotified: false });
        startStatusPolling(windowManager);

        if (windowManager) {
          const mainWindow = windowManager.getWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
          }
        }
      }

      return result;
    } catch (error) {
      logger.logError('ohd:job:resend-dpof-batch error', error, { jobId, batchIndex });
      return { success: false, error: error.message };
    }
  });

  // ── Activity log handlers ──

  // Read and parse log file
  ipcMain.handle('logs:read', async (event, options = {}) => {
    try {
      const logsDir = path.join(app.getPath('userData'), 'logs');
      const logFile = path.join(logsDir, 'app.log');

      if (!fs.existsSync(logFile)) {
        logger.info('Activity log: log file not found', { path: logFile });
        return { entries: [], totalLines: 0 };
      }

      const content = fs.readFileSync(logFile, 'utf-8');
      // Normalize line endings (handle \r\n, \r, \n) then split
      const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(line => line.trim());

      // Match Winston format: "2024-01-15 10:30:00 [INFO]: message"
      const lineRegex = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\]:\s*(.*)$/i;
      let entries = [];

      for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(lineRegex);
        if (match) {
          entries.push({
            timestamp: match[1],
            level: match[2].toLowerCase(),
            message: match[3],
            stack: ''
          });
        } else if (entries.length > 0) {
          // Only append genuine stack trace / continuation lines (not timestamped entries)
          entries[entries.length - 1].stack += (entries[entries.length - 1].stack ? '\n' : '') + trimmed;
        }
      }

      const totalLines = entries.length;
      const rawLineCount = lines.length;

      // Filter by level if specified
      if (options.level && options.level !== 'all') {
        const filterLevel = options.level.toLowerCase();
        entries = entries.filter(e => e.level === filterLevel);
      }

      // Reverse to show newest first, cap at 500
      entries.reverse();
      entries = entries.slice(0, 500);

      return { entries, totalLines, rawLineCount };
    } catch (error) {
      logger.logError('Error reading log file', error);
      return { entries: [], totalLines: 0, error: error.message };
    }
  });

  // Get logs directory path
  ipcMain.handle('logs:getPath', async () => {
    return path.join(app.getPath('userData'), 'logs');
  });

  // Export logs to file
  ipcMain.handle('logs:export', async (event, content) => {
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: 'orderhub-activity.log',
        filters: [
          { name: 'Log Files', extensions: ['log', 'txt'] }
        ]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      fs.writeFileSync(result.filePath, content, 'utf-8');
      logger.info('Activity log exported', { path: result.filePath });
      return { success: true, path: result.filePath };
    } catch (error) {
      logger.logError('Error exporting log', error);
      return { success: false, error: error.message };
    }
  });

  // Set up polling callback to send job updates to renderer
  if (windowManager) {
    pollingService.setJobsUpdatedCallback((jobData) => {
      const mainWindow = windowManager.getWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('jobs:updated', jobData);
      }
    });
  }

  // Set up auto-print callback — runs after each job poll cycle
  _autoPrintWindowManager = windowManager;
  pollingService.setAutoPrintCallback(() => runAutoPrint());

  // ── Print Controllers ──
  ipcMain.handle('printControllers:getAll', async () => {
    try {
      const controllers = printControllerStore.getAllControllers();
      return controllers.map(c => ({
        ...c,
        productMappings: printControllerStore.getProductMappingsByController(c.id)
      }));
    } catch (error) {
      logger.logError('Error getting print controllers', error);
      throw error;
    }
  });

  ipcMain.handle('printControllers:add', async (event, data) => {
    try {
      const id = printControllerStore.addController(data);
      logger.info(`Print controller added: ${data.name} (${id})`);
      return printControllerStore.getController(id);
    } catch (error) {
      logger.logError('Error adding print controller', error);
      throw error;
    }
  });

  ipcMain.handle('printControllers:update', async (event, { id, updates }) => {
    try {
      printControllerStore.updateController(id, updates);
      logger.info(`Print controller updated: ${id}`);
      return printControllerStore.getController(id);
    } catch (error) {
      logger.logError('Error updating print controller', error);
      throw error;
    }
  });

  ipcMain.handle('printControllers:delete', async (event, id) => {
    try {
      printControllerStore.deleteController(id);
      logger.info(`Print controller deleted: ${id}`);
      return true;
    } catch (error) {
      logger.logError('Error deleting print controller', error);
      throw error;
    }
  });

  ipcMain.handle('printControllers:addProductMapping', async (event, data) => {
    try {
      const id = printControllerStore.addProductMapping(data);
      logger.info(`Product mapping added for controller ${data.controllerId}: ${data.productCode}`);
      return printControllerStore.getProductMapping(id);
    } catch (error) {
      logger.logError('Error adding product mapping', error);
      throw error;
    }
  });

  ipcMain.handle('printControllers:getKnownOptions', async () => {
    try {
      return printControllerStore.getKnownOptions();
    } catch (error) {
      logger.logError('Error getting known options', error);
      throw error;
    }
  });

  ipcMain.handle('printControllers:deleteProductMapping', async (event, id) => {
    try {
      printControllerStore.deleteProductMapping(id);
      logger.info(`Product mapping deleted: ${id}`);
      return true;
    } catch (error) {
      logger.logError('Error deleting product mapping', error);
      throw error;
    }
  });

  // ── Order Routing ──

  ipcMain.handle('ohd:routing:resolve', async (event, { job }) => {
    try {
      return routingService.resolveRoute(job);
    } catch (error) {
      logger.logError('ohd:routing:resolve error', error);
      return { type: 'unrouted', reason: 'no-controller' };
    }
  });

  ipcMain.handle('ohd:routing:get-controllers', async () => {
    return routingService.getControllers();
  });

  ipcMain.handle('ohd:routing:save-controller', async (event, controller) => {
    try {
      // Advisory warnings accumulated across the handler and returned
      // alongside `success: true` when the save proceeds. Distinct from
      // the `error` return, which signals rejection. Only ADD to this;
      // never let a warning short-circuit the save (v1.15.1 made the
      // Fuji PIC Pro volume check advisory after 1.15.0 hard-blocked a
      // real lab from saving a valid controller — see the isSameVolume
      // block below).
      const warnings = [];

      // Defence-in-depth mirror of the renderer-side guard in
      // src/renderer/renderer.js (ocSaveBtn handler). A Darkroom Pro
      // controller with mediaTranslations defined but mediaOptionKey empty
      // is misconfigured by construction — resolveMedia short-circuits on
      // empty mediaOptionKey before it ever reads the translations array,
      // so dispatched .txt files end up with `Media=` blank and customers
      // get whatever Darkroom Pro defaults to. Reject the save so a
      // malformed IPC payload (or a future renderer bug) can't slip past.
      if (
        controller &&
        controller.type === 'darkroompro' &&
        Array.isArray(controller.mediaTranslations) &&
        controller.mediaTranslations.length > 0 &&
        !(controller.mediaOptionKey && controller.mediaOptionKey.trim())
      ) {
        const msg =
          'Paper Type Option Key is required when Media Translations are defined. ' +
          'Either set the option key on the controller, or delete the Media Translation rows in Settings → Routing.';
        logger.logWarning('[routing] save-controller rejected — translations without option key', {
          controllerId:        controller.id,
          name:                controller.name,
          mediaTranslations:   controller.mediaTranslations.length,
          mediaOptionKey:      controller.mediaOptionKey || '(empty)',
        });
        return { success: false, error: msg };
      }

      // Defence-in-depth: batch-splitting cap must be null/absent OR an
      // integer in [1, 10000]. Renderer already enforces this; the same
      // check at the IPC boundary stops a malformed payload (future
      // renderer bug, external caller) from persisting a value that
      // would silently split every job.
      //
      // Scope: darkroompro + epson (M5 of docs/epson-batch-splitting-
      // brief.md added epson). noritsu and untyped-dpof aren't in the
      // set — a stale value on those types is harmless (route literals
      // deliberately don't advertise the field for them) but there's
      // no reason to persist one either, so the guard also runs there
      // by NOT running (we only reject when the type is in the batch-
      // capable set; other types pass the field through untouched).
      const isBatchCapableType = controller && (controller.type === 'darkroompro' || controller.type === 'epson');
      if (
        isBatchCapableType &&
        controller.maxPrintsPerJob !== undefined &&
        controller.maxPrintsPerJob !== null
      ) {
        const n = controller.maxPrintsPerJob;
        if (!Number.isInteger(n) || n < 1 || n > 10000) {
          const msg = 'Maximum prints per job must be an integer between 1 and 10000, or null.';
          logger.logWarning('[routing] save-controller rejected — invalid maxPrintsPerJob', {
            controllerId:    controller.id,
            name:            controller.name,
            controllerType:  controller.type,
            maxPrintsPerJob: n,
          });
          return { success: false, error: msg };
        }
      }

      // M2 (2026-08-15) DP + M5 epson: autoSendBatches must be a strict
      // boolean when present. Renderer sends checkbox.checked (always
      // boolean); the IPC mirror stops a malformed payload (external
      // caller, hand-edited JSON round-tripped through the config) from
      // persisting a truthy non-boolean that would then silently
      // suppress the operator-review gate on every over-cap job.
      // Undefined is fine — existing controllers behave as before
      // (feature off).
      if (
        isBatchCapableType &&
        controller.autoSendBatches !== undefined &&
        typeof controller.autoSendBatches !== 'boolean'
      ) {
        const msg = 'autoSendBatches must be a boolean.';
        logger.logWarning('[routing] save-controller rejected — invalid autoSendBatches', {
          controllerId:    controller.id,
          name:            controller.name,
          controllerType:  controller.type,
          autoSendBatches: controller.autoSendBatches,
        });
        return { success: false, error: msg };
      }

      // Fuji PIC Pro — order-level submission wait cap. Same posture as
      // the darkroompro cap above: renderer already validates, the IPC
      // mirror stops a malformed payload (future renderer bug, external
      // caller) from persisting a value that would silently stretch
      // every order merge to hours. Null is a valid value meaning
      // "use the default" — do NOT reject it, and do not conflate it
      // with "wait forever".
      if (
        controller &&
        controller.type === 'fujipicpro' &&
        controller.orderMergeWaitMinutes !== undefined &&
        controller.orderMergeWaitMinutes !== null
      ) {
        const n = controller.orderMergeWaitMinutes;
        if (!Number.isInteger(n) || n < 1 || n > 1440) {
          const msg = 'Order-merge wait cap must be an integer between 1 and 1440 minutes, or null for the default.';
          logger.logWarning('[routing] save-controller rejected — invalid orderMergeWaitMinutes', {
            controllerId:          controller.id,
            name:                  controller.name,
            orderMergeWaitMinutes: n,
          });
          return { success: false, error: msg };
        }
      }

      // Fuji JobMaker — single source of truth for required-field rules and
      // defaults lives in fuji-jobmaker-config.js. Run it at the save boundary
      // so a malformed payload (from a future renderer bug, an external IPC
      // call, or a stale dev build) can't persist invalid state. Merge the
      // normalised shape back into the record we hand to routingService.
      if (controller && controller.type === 'fujijobmaker') {
        const { valid, errors, normalized } = fujiJobMakerConfig.validateControllerConfig(controller);
        if (!valid) {
          logger.logWarning('[routing] save-controller rejected — Fuji JobMaker validation', {
            controllerId: controller.id,
            name:         controller.name,
            errors,
          });
          return { success: false, error: errors.join('; ') };
        }
        Object.assign(controller, normalized);
      }

      // Fuji PIC Pro — same posture as JobMaker, different validator.
      // Enforces the three explicit paths (orderData / digin / staging),
      // the two timeouts, and the sendReleaseCommand toggle. See
      // fuji-pic-pro-config.js docblock for the full field table.
      if (controller && controller.type === 'fujipicpro') {
        const { valid, errors, normalized } = fujiPicProConfig.validateControllerConfig(controller);
        if (!valid) {
          logger.logWarning('[routing] save-controller rejected — Fuji PIC Pro validation', {
            controllerId: controller.id,
            name:         controller.name,
            errors,
          });
          return { success: false, error: errors.join('; ') };
        }
        Object.assign(controller, normalized);

        // Fuji PIC Pro co-location — ADVISORY only (v1.15.1).
        //
        // Original requirement (M7b, 2026-08-18): Image Staging Root
        // and DIGIN Path must be on the same volume, otherwise the
        // atomic rename in deliverToDigin returns EXDEV. Pre-M7b's
        // slow-path fallback wrote `.ohdtmp` into DIGIN and PIC Pro
        // ingested it as a blank duplicate — the slow path is gone,
        // dispatch throws EXDEV loudly at run time with an actionable
        // message. That dispatch-time throw remains the authoritative
        // check.
        //
        // 1.15.0 shipped this as a save-time HARD REJECT keyed on
        // isSameVolume's boolean-ish return. Real lab hit it: two UNC
        // paths on the same server (`\\labserver1\Pixfizz Digin
        // Staging` + `\\labserver1\Digin`), very likely the same
        // physical volume, string check called cross-volume — save
        // blocked with no workaround (their DIGIN path is a share
        // root so there's no other folder on that share to stage
        // into). v1.15.1 makes the check advisory: `certain-same`
        // saves silently; every other verdict (`certain-different`
        // AND `indeterminate`) saves and surfaces a warning. Dispatch
        // decides.
        const volume = fujiPicProFileWriter.isSameVolume(
          controller.imageStagingRoot,
          controller.diginPath,
        );
        if (volume.verdict !== 'certain-same') {
          const text =
            'Image Staging Root and DIGIN Path may be on different volumes. ' +
            'If they are, dispatch will stop with an error — OHD can\'t tell ' +
            'for certain from network paths alone. ' +
            `Image Staging Root: ${controller.imageStagingRoot}. ` +
            `DIGIN Path: ${controller.diginPath}.`;
          warnings.push({ kind: 'picpro-volume-uncertain', text });
          logger.logWarning('[routing] save-controller — PIC Pro volume verdict is not certain-same (advisory)', {
            controllerId:     controller.id,
            name:             controller.name,
            imageStagingRoot: controller.imageStagingRoot,
            diginPath:        controller.diginPath,
            verdict:          volume.verdict,
            code:             volume.code,
          });
        }
      }

      // Folder Copy — filename template + destination layout guards
      // (§5.3 of docs/folder-copy-filename-templates-brief.md). IPC
      // mirror of the renderer-side check in ocSaveBtn. A blank
      // template + 'job' layout is the existing-installation shape
      // and must pass; a 'root' layout requires a non-blank template
      // that carries at least one job-distinguishing token, otherwise
      // files from different jobs would silently overwrite each other
      // in the shared root folder (within-dispatch de-dup cannot see
      // that by design — the guard has to be at save time).
      //
      // Error strings NAME THE FIX rather than the rule; they surface
      // in the renderer via showToast when the IPC returns
      // {success:false, error}, so an operator who somehow bypassed
      // the renderer-side check gets the same actionable message here.
      if (controller && controller.type === 'folder_copy') {
        const layout = controller.destinationLayout;
        if (layout !== undefined && layout !== 'job' && layout !== 'root') {
          const msg = 'Destination layout must be "job" or "root".';
          logger.logWarning('[routing] save-controller rejected — invalid destinationLayout', {
            controllerId: controller.id,
            name:         controller.name,
            destinationLayout: layout,
          });
          return { success: false, error: msg };
        }
        // M7b: orderNumberPrefixRules is Array<{from,to}>. Reject
        // shapes that aren't a pair array so a malformed payload can't
        // persist. Legacy M7 (stripOrderNumberPrefixes: string[]) and
        // 1.13.0 (stripOrderNumberPrefix: string) shapes are still
        // accepted as inputs — the route literal's tolerant reader picks
        // up whichever is present. Renderer normally sends only the new
        // field.
        if (
          controller.orderNumberPrefixRules !== undefined &&
          !Array.isArray(controller.orderNumberPrefixRules)
        ) {
          const msg = 'orderNumberPrefixRules must be an array of {from, to} pairs.';
          logger.logWarning('[routing] save-controller rejected — invalid orderNumberPrefixRules', {
            controllerId: controller.id,
            name:         controller.name,
            orderNumberPrefixRules: controller.orderNumberPrefixRules,
          });
          return { success: false, error: msg };
        }
        if (
          Array.isArray(controller.orderNumberPrefixRules) &&
          controller.orderNumberPrefixRules.some(
            r => !r || typeof r !== 'object' || typeof r.from !== 'string' ||
                 (r.to !== undefined && r.to !== null && typeof r.to !== 'string')
          )
        ) {
          const msg = 'orderNumberPrefixRules entries must be objects with a string `from` (and optional string `to`).';
          logger.logWarning('[routing] save-controller rejected — malformed orderNumberPrefixRules entry', {
            controllerId: controller.id,
            name:         controller.name,
          });
          return { success: false, error: msg };
        }
        // Legacy M7 shape still accepted at the boundary — reject only
        // wrong TYPE (not-array); array-of-strings passes through and
        // is coerced at read time by readOrderNumberPrefixRules.
        if (
          controller.stripOrderNumberPrefixes !== undefined &&
          !Array.isArray(controller.stripOrderNumberPrefixes)
        ) {
          const msg = 'stripOrderNumberPrefixes (legacy field) must be an array of strings.';
          logger.logWarning('[routing] save-controller rejected — invalid legacy stripOrderNumberPrefixes', {
            controllerId: controller.id,
            name:         controller.name,
            stripOrderNumberPrefixes: controller.stripOrderNumberPrefixes,
          });
          return { success: false, error: msg };
        }
        if (
          Array.isArray(controller.stripOrderNumberPrefixes) &&
          controller.stripOrderNumberPrefixes.some(p => typeof p !== 'string')
        ) {
          const msg = 'stripOrderNumberPrefixes (legacy field) must be an array of strings.';
          logger.logWarning('[routing] save-controller rejected — non-string entry in legacy stripOrderNumberPrefixes', {
            controllerId: controller.id,
            name:         controller.name,
          });
          return { success: false, error: msg };
        }
        if (
          controller.stripOrderNumberPrefix !== undefined &&
          typeof controller.stripOrderNumberPrefix !== 'string'
        ) {
          const msg = 'stripOrderNumberPrefix (legacy field) must be a string when present.';
          logger.logWarning('[routing] save-controller rejected — invalid legacy stripOrderNumberPrefix', {
            controllerId: controller.id,
            name:         controller.name,
            stripOrderNumberPrefix: controller.stripOrderNumberPrefix,
          });
          return { success: false, error: msg };
        }
        const rawTemplate = typeof controller.filenameTemplate === 'string'
          ? controller.filenameTemplate
          : '';
        if (
          controller.filenameTemplate !== undefined &&
          typeof controller.filenameTemplate !== 'string'
        ) {
          const msg = 'filenameTemplate must be a string.';
          logger.logWarning('[routing] save-controller rejected — invalid filenameTemplate type', {
            controllerId: controller.id,
            name:         controller.name,
          });
          return { success: false, error: msg };
        }
        // Normalise at the IPC boundary — trim leading/trailing whitespace
        // on filenameTemplate so a payload from a future renderer bug (or
        // an external caller) can't persist a truthy whitespace-only value
        // that M2 would treat as a real template and resolve to blank on
        // every image. Symmetric with orderNumberPrefixRules. This runs
        // BEFORE the layout-specific checks so the "blank template under
        // root" rule fires on the normalised value.
        const trimmedTemplate = rawTemplate.trim();
        controller.filenameTemplate = trimmedTemplate;
        // M7b: trim from/to + dedupe (case-insensitive on `from`) + drop
        // rules whose `from` goes empty after trim. `to` empty after trim
        // is legal — that means "pure strip". Same posture as the
        // renderer save path so a payload that bypassed the renderer
        // trims to the same shape.
        if (Array.isArray(controller.orderNumberPrefixRules)) {
          const seen = new Set();
          controller.orderNumberPrefixRules = controller.orderNumberPrefixRules
            .map(r => ({
              from: (r && typeof r.from === 'string') ? r.from.trim() : '',
              to:   (r && typeof r.to   === 'string') ? r.to.trim()   : '',
            }))
            .filter(r => r.from.length > 0)
            .filter(r => {
              const key = r.from.toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
        }
        // Legacy M7 string[] field also trimmed for symmetry (kept on
        // the record for downgrade-friendly reads).
        if (Array.isArray(controller.stripOrderNumberPrefixes)) {
          const seen = new Set();
          controller.stripOrderNumberPrefixes = controller.stripOrderNumberPrefixes
            .map(p => (typeof p === 'string' ? p.trim() : ''))
            .filter(p => p.length > 0)
            .filter(p => {
              const key = p.toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
        }
        // Legacy 1.13.0 single-string field also trimmed for symmetry.
        if (typeof controller.stripOrderNumberPrefix === 'string') {
          controller.stripOrderNumberPrefix = controller.stripOrderNumberPrefix.trim();
        }
        if (layout === 'root') {
          const trimmed = trimmedTemplate;
          if (!trimmed) {
            const msg =
              'A filename template is required when files go in the root of the copy-to folder, ' +
              'and it must include at least one of {orderNumber}, {jobName} or {jobId} so files ' +
              'from different jobs don\'t overwrite each other.';
            logger.logWarning('[routing] save-controller rejected — root layout with blank template', {
              controllerId: controller.id,
              name:         controller.name,
            });
            return { success: false, error: msg };
          }
          // M3a: only {orderNumber}/{jobName}/{jobId} distinguish across
          // jobs. Per-image tokens ({filename}/{originalFilename}) resolve
          // to manifest basenames like "5_IMG.jpg" — camera filenames
          // repeat across orders constantly, so two orders each carrying
          // an IMG_0001.jpg at the same index resolve identically and
          // would overwrite in root layout. Do NOT widen this regex —
          // see the matching comment in renderer.js ocSaveBtn for the
          // full reasoning and the token-by-token audit.
          if (!/\{(?:orderNumber|jobName|jobId)\}/.test(trimmed)) {
            const msg =
              'The filename template must include at least one of {orderNumber}, {jobName} ' +
              'or {jobId} when files go in the root of the copy-to folder — otherwise files ' +
              'from different jobs will overwrite each other.';
            logger.logWarning('[routing] save-controller rejected — root layout template lacks distinguishing token', {
              controllerId: controller.id,
              name:         controller.name,
              filenameTemplate: rawTemplate,
            });
            return { success: false, error: msg };
          }
        }
      }

      routingService.saveController(controller);

      // Darkroom Pro controllers are dual-written to the legacy printControllerStore
      // so DarkroomProMonitor and the fallback resolution in ipc-handlers continue to work.
      if (controller.type === 'darkroompro') {
        const existing = printControllerStore.getController(controller.id);
        const legacyData = {
          name:                controller.name,
          type:                'darkroompro',
          hotFolderPath:       controller.outputPath,
          processedFolderName: controller.processedFolderName || 'processed',
        };
        if (existing) {
          printControllerStore.updateController(controller.id, legacyData);
        } else {
          // Preserve the same UUID so ipc-handlers fallback lookups resolve correctly
          const controllers = printControllerStore.store.get('controllers', {});
          controllers[controller.id] = {
            ...legacyData,
            id:        controller.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          printControllerStore.store.set('controllers', controllers);
        }
        logger.info('Darkroom Pro controller synced to printControllerStore', { id: controller.id });
      }

      pollingService.restartFolderMonitors();
      // `warnings` is always an array; empty on the silent-success path.
      // Renderer decides whether to render the modal warnings panel
      // based on `warnings.length > 0`.
      return { success: true, warnings };
    } catch (error) {
      logger.logError('ohd:routing:save-controller error', error);
      return { success: false, error: error.message };
    }
  });

  // ── Live preview for Folder Copy filename templates (M5) ──────────────
  //
  // Given the three modal-editable fields (+ outputPath + optional
  // controllerId), returns 2-3 resolved sample filenames plus the full
  // destination path plus warnings synthesised from the M2 stats. The
  // heavy lifting is in folder-copy-preview.js — deliberately in a
  // testable module rather than inline here — and the sample source
  // is deps-injected so tests can pin sample selection without touching
  // real cached jobs or the on-disk manifest.
  //
  // READ-ONLY. The service module and the deps below never write.
  ipcMain.handle('ohd:folder-copy:preview', async (event, payload) => {
    try {
      return await buildFolderCopyPreview(payload || {}, {
        listJobs:             () => {
          const snap = jobService.getLocalJobs();
          return (snap && Array.isArray(snap.jobs)) ? snap.jobs : [];
        },
        resolveRouteFor:      (job) => routingService.resolveRoute(job),
        getDownloadDirectory: () => configService.get('downloadDirectory'),
      });
    } catch (err) {
      logger.logError('[folder-copy:preview] failed', err);
      // A preview failure should not block the modal — surface a shape
      // the renderer can safely render as "preview unavailable".
      return { error: err.message || String(err) };
    }
  });

  ipcMain.handle('ohd:routing:delete-controller', async (event, { id }) => {
    try {
      // Check type before deleting from routing store
      const controllers = routingService.getControllers();
      const ctrl = controllers.find(c => c.id === id);

      routingService.deleteController(id);

      // Mirror deletion in legacy printControllerStore for Darkroom Pro controllers
      if (ctrl && ctrl.type === 'darkroompro') {
        printControllerStore.deleteController(id);
        logger.info('Darkroom Pro controller removed from printControllerStore', { id });
      }

      pollingService.restartFolderMonitors();
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:delete-controller error', error);
      return { success: false, error: error.message };
    }
  });

  // Narrow ignore-list write for reconcileControllerIgnore (M3 of
  // docs/darkroom-media-lock-brief.md). Patches only
  // `ignoredOptionNames` on the stored controller — deliberately
  // BYPASSES the whole-controller media / max-prints / Fuji guards
  // in ohd:routing:save-controller. That is the entire point: a
  // per-job Ignore-tick edit must not fail because the operator's
  // controller has an unrelated misconfiguration (translations +
  // blank Paper Type Option Key is the reported one). See §2 of
  // docs/darkroom-media-lock-plan.md for the failure trace.
  //
  // Validation is scoped to the payload only: array of non-empty
  // strings, deduplicated case-insensitively, controller must exist.
  ipcMain.handle('ohd:routing:set-ignored-options', async (event, payload) => {
    try {
      const controllerId       = payload && payload.controllerId;
      const ignoredOptionNames = payload && payload.ignoredOptionNames;

      if (typeof controllerId !== 'string' || controllerId.length === 0) {
        return { success: false, error: 'controllerId is required' };
      }
      if (!Array.isArray(ignoredOptionNames)) {
        return { success: false, error: 'ignoredOptionNames must be an array' };
      }
      // Every entry must be a non-empty trimmed string. Reject rather
      // than filter-and-continue so a malformed payload doesn't get
      // silently coerced — same posture as the darkroompro cap guard.
      for (const n of ignoredOptionNames) {
        if (typeof n !== 'string' || n.trim().length === 0) {
          return { success: false, error: 'ignoredOptionNames entries must be non-empty strings' };
        }
      }
      // Dedup case-insensitively while preserving the first-seen
      // display form (mirrors the display-form preservation
      // reconcileControllerIgnore uses on the renderer side).
      const byLower = new Map();
      for (const n of ignoredOptionNames) {
        const trimmed = n.trim();
        const key = trimmed.toLowerCase();
        if (!byLower.has(key)) byLower.set(key, trimmed);
      }
      const normalised = Array.from(byLower.values());

      const controllers = routingService.getControllers();
      const controller  = controllers.find(c => c.id === controllerId);
      if (!controller) {
        return { success: false, error: `Controller ${controllerId} not found` };
      }

      const patched = { ...controller, ignoredOptionNames: normalised };
      routingService.saveController(patched);
      logger.info('[routing] set-ignored-options', {
        controllerId,
        name:  controller.name,
        count: normalised.length,
      });
      return { success: true, controller: patched };
    } catch (error) {
      logger.logError('ohd:routing:set-ignored-options error', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ohd:routing:get-process-mappings', async () => {
    return routingService.getProcessMappings();
  });

  ipcMain.handle('ohd:routing:save-process-mapping', async (event, mapping) => {
    try {
      routingService.saveProcessMapping(mapping);
      // A changed process→controller mapping may unblock previously-unrouted jobs
      runAutoPrint().catch(err => logger.logError('[auto-print] post-process-mapping check failed', err));
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:save-process-mapping error', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ohd:routing:delete-process-mapping', async (event, { process }) => {
    try {
      routingService.deleteProcessMapping(process);
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:delete-process-mapping error', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ohd:routing:get-channel-mappings', async () => {
    return routingService.getChannelMappings();
  });

  ipcMain.handle('ohd:routing:get-all-size-options', async () => {
    return routingService.getAllSizeOptions();
  });

  // Parse a Channel Mappings CSV. Called by the Settings → Routing CSV
  // import handler in the renderer. The parser is a pure module
  // (src/shared/csvChannelMappingsParser.js) — kept out of the renderer
  // because renderer.js loads under context isolation and cannot
  // require(), which would have forced a second inline copy of the
  // logic. See docs/csv-channel-mappings.md for the format contract.
  // Lazy-require so ipc-handlers' load-time surface doesn't widen for
  // this rarely-used code path.
  ipcMain.handle('ohd:routing:parse-mappings-csv', async (event, csv) => {
    const { parseChannelMappingsCsv } = require('../shared/csvChannelMappingsParser');
    return parseChannelMappingsCsv(csv);
  });

  // Operator-initiated retry on an errored job (M8 of
  // missing-print-size-recovery). Resets _status back to 'received'
  // and clears _errorMessage so the next runAutoPrint cycle picks
  // the job up through the normal path — including every existing
  // gate (AI quality hold, routing hold, hold-for-review). Do NOT
  // dispatch directly from here; bypassing those gates would be a
  // new hole. See the sticky-error comment in runAutoPrint for why
  // auto-print itself never resets _status.
  //
  // Idempotent: retrying a non-errored job is a no-op that returns
  // {success:true, changed:false} — a stale button click or a
  // devtools invocation shouldn't fail loudly.
  ipcMain.handle('ohd:job:retry', async (event, payload) => {
    const jobId = payload && payload.jobId != null ? payload.jobId : payload;
    try {
      const { jobs } = jobService.getLocalJobs();
      // String coercion on both sides — the renderer sends the id as
      // a string via data-attribute; the local store carries the
      // API's numeric id. Same pattern as ohd:reprint:create's
      // apiJobId lookup at :2076.
      const job = (jobs || []).find(j => String(j.id) === String(jobId));
      if (!job) {
        return { success: false, error: `Job ${jobId} not found in local cache.` };
      }
      if (job._status !== 'error') {
        return { success: true, changed: false };
      }
      jobService.updateJobLocally(job.id, {
        _status: 'received',
        _errorMessage: null,
      });
      logger.info('[retry] Operator reset errored job — auto-print will pick up on next cycle', {
        jobId: job.id,
        previousError: job._errorMessage || '',
      });
      // Fire-and-forget — auto-print returns quickly if there's
      // nothing to dispatch, and the renderer refreshes via loadJobs()
      // after the retry response either way.
      runAutoPrint().catch(err => logger.logError('[auto-print] post-retry check failed', err));
      return { success: true, changed: true };
    } catch (error) {
      logger.logError('ohd:job:retry error', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  // Routing health check (M5/M6 of missing-print-size-recovery). Reads
  // the current routing store and returns the array of unroutable
  // mappings — DPOF-family with a blank printSizeCode that will fail at
  // dispatch. Called on every launch (fed into the startup banner) and
  // every Settings → Routing open (fed into the roll-up). Deliberately
  // unguarded and unmemoised — the M4 backfill's warning fires only on
  // launches that actually run the backfill, so installs whose
  // _backfill_* flag is already set never see it. This is the only
  // mechanism that surfaces the problem on those installs, including
  // the lab that triggered this piece of work. Lazy-require to keep
  // ipc-handlers' load-time surface minimal.
  ipcMain.handle('ohd:routing:check-health', async () => {
    const { findUnroutableMappings } = require('../shared/configHealth');
    return findUnroutableMappings(
      routingService.getChannelMappings(),
      routingService.getControllers(),
    );
  });

  // ohd-api v1.4.0 — server-capabilities snapshot. Used by the Settings
  // panel to decide whether the polling-interval input is operator-editable
  // or centrally-managed. Lazy-require: server-capabilities pulls
  // electron-store at singleton-instantiation, and we don't want to widen
  // ipc-handlers' load-time surface for this one read.
  ipcMain.handle('ohd:server:get-capabilities', async () => {
    const { serverCapabilities } = require('./services/server-capabilities');
    return serverCapabilities.getSnapshot();
  });

  ipcMain.handle('ohd:routing:save-channel-mapping', async (event, mapping) => {
    try {
      // Fuji JobMaker mappings get validated against fuji-jobmaker-config so
      // printCode/surface are required and surfaceCode defaults from surface's
      // first letter. Look up the parent controller to decide whether to apply
      // the Fuji rules — other controller types keep their existing behaviour.
      //
      // Options shape: the legacy renderer/routingService stores
      // `options: [{ name, value }, …]` but the Fuji validator expects the
      // spec form `{ name: value }`. Convert just for validation; keep the
      // persisted shape unchanged so the existing matcher keeps working.
      if (mapping && mapping.controllerId) {
        const parentCtrl = routingService.getControllers().find(c => c.id === mapping.controllerId);
        if (parentCtrl && parentCtrl.type === 'fujijobmaker') {
          const optionsObj = Array.isArray(mapping.options)
            ? mapping.options.reduce((acc, { name, value }) => {
                if (name) acc[name] = value;
                return acc;
              }, {})
            : (mapping.options || {});
          const validationInput = { ...mapping, options: optionsObj };
          const { valid, errors, normalized } = fujiJobMakerConfig.validateProductMappingConfig(validationInput);
          if (!valid) {
            logger.logWarning('[routing] save-channel-mapping rejected — Fuji JobMaker validation', {
              controllerId: mapping.controllerId,
              productCode:  mapping.productCode,
              errors,
            });
            return { success: false, error: errors.join('; ') };
          }
          // Adopt the validator's normalised Fuji-specific fields. Leave
          // `options` alone — the persisted array form is what the matcher
          // expects.
          mapping.printCode   = normalized.printCode;
          mapping.printSize   = normalized.printSize;
          mapping.surface     = normalized.surface;
          mapping.surfaceCode = normalized.surfaceCode;
        } else if (parentCtrl && parentCtrl.type === 'fujipicpro') {
          // Same convert-options-to-object step as JobMaker so the shared
          // validator shape works on the persisted array form.
          const optionsObj = Array.isArray(mapping.options)
            ? mapping.options.reduce((acc, { name, value }) => {
                if (name) acc[name] = value;
                return acc;
              }, {})
            : (mapping.options || {});
          const validationInput = { ...mapping, options: optionsObj };
          const { valid, errors, normalized } = fujiPicProConfig.validateProductMappingConfig(validationInput);
          if (!valid) {
            logger.logWarning('[routing] save-channel-mapping rejected — Fuji PIC Pro validation', {
              controllerId: mapping.controllerId,
              productCode:  mapping.productCode,
              errors,
            });
            return { success: false, error: errors.join('; ') };
          }
          mapping.printCode   = normalized.printCode;
          mapping.printSize   = normalized.printSize;
          mapping.surface     = normalized.surface;
          mapping.surfaceCode = normalized.surfaceCode;
          mapping.color       = normalized.color;
        } else if (parentCtrl) {
          // DPOF/Noritsu family — printSizeCode is now mandatory. See
          // routing-service.validateDPOFPrintSizeCode for the scope
          // (non-DPOF controller types are a no-op). Covers both the
          // modal save path and the CSV import path — both go through
          // this IPC handler.
          const dpofCheck = routingService.validateDPOFPrintSizeCode(mapping, parentCtrl.type);
          if (!dpofCheck.valid) {
            logger.logWarning('[routing] save-channel-mapping rejected — DPOF print-size validation', {
              controllerId: mapping.controllerId,
              productCode:  mapping.productCode,
              error:        dpofCheck.error,
            });
            return { success: false, error: dpofCheck.error };
          }
        }
      }

      routingService.saveChannelMapping(mapping);
      // A new channel mapping may make previously-unrouted jobs eligible for auto-print
      runAutoPrint().catch(err => logger.logError('[auto-print] post-channel-mapping check failed', err));
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:save-channel-mapping error', error);
      return { success: false, error: error.message };
    }
  });

  // v1.7.8 — Routing-hold release.
  //
  // Called by the renderer's Resolve Hold modal. Two modes:
  //   { controllerId: null }            → Release to default controller (the
  //                                        process→controller mapping decides
  //                                        the route at dispatch time).
  //   { controllerId: <string> }        → Reassign to <controllerId>; before
  //                                        persisting, validate that a channel
  //                                        mapping exists for the job's
  //                                        productCode + options under that
  //                                        controller. On no-channel return
  //                                        a payload the renderer chains into
  //                                        the existing Assign Channel modal
  //                                        (same flow as the unrouted-job
  //                                        Assign button).
  //
  // Persists _routingHoldReleased=true (sticky), _routingReleasedAt (ISO
  // timestamp for the audit-trail line), _routingReleasedTo (controller name
  // for the same audit line). Reassignment ALSO sets _channelMappingOverride
  // — same field the crop-to-size feature uses, which resolveRoute already
  // short-circuits on.
  ipcMain.handle('ohd:routing:release-hold', async (event, payload) => {
    const { jobId, controllerId } = payload || {};
    try {
      const localJobs = jobService.getLocalJobs().jobs || [];
      const job = localJobs.find(j => String(j.id) === String(jobId));
      if (!job) {
        return { ok: false, reason: 'job-not-found' };
      }

      const updates = {
        _routingHoldReleased: true,
        _routingReleasedAt:   new Date().toISOString(),
      };

      if (controllerId) {
        // Reassign path — must validate the channel mapping exists for this
        // controller. resolveRouteForController returns the same shape
        // resolveRoute does so callers handle no-channel identically.
        const route = routingService.resolveRouteForController(job, controllerId);
        if (route.type === 'unrouted' && route.reason === 'no-channel') {
          // Don't persist — let the renderer surface the Assign modal first.
          return { ok: false, reason: 'no-channel', controller: route.controller };
        }
        if (route.type === 'unrouted') {
          return { ok: false, reason: route.reason };
        }

        // Find the channel mapping id so we can persist the override (same
        // mechanism crop-to-size uses; resolveRoute short-circuits on it).
        const channelMappings = routingService.getChannelMappings();
        const productCode = job.product_code;
        const options     = job.options || [];
        const matching = channelMappings.find(m =>
          m.controllerId === controllerId &&
          m.productCode  === productCode  &&
          (function optsMatch() {
            // Inline match to avoid coupling — see routing-service.optionsMatch
            // for the canonical implementation; identical contract.
            if (!Array.isArray(m.options) || m.options.length === 0) return true;
            return m.options.every(mo =>
              options.some(jo => jo.name === mo.name && jo.value === mo.value),
            );
          })(),
        );
        if (matching) {
          updates._channelMappingOverride = matching.id;
        }
        updates._routingReleasedTo = route.controllerName;
      } else {
        // Release-to-default path — leave _channelMappingOverride alone (the
        // process→controller mapping picks at dispatch time). Audit line
        // still records the default controller name for operator clarity.
        const route = routingService.resolveRoute(job);
        updates._routingReleasedTo = route && route.controllerName ? route.controllerName : '';
      }

      jobService.updateJobLocally(jobId, updates);

      // Hold gate may now pass — push to renderer + kick auto-print.
      if (windowManager) {
        const mainWindow = windowManager.getWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
        }
      }
      runAutoPrint().catch(err => logger.logError('[auto-print] post-routing-hold-release check failed', err));

      logger.info('[routing-hold] released', {
        jobId,
        mode:         controllerId ? 'reassign' : 'default',
        controllerId: controllerId || null,
        releasedTo:   updates._routingReleasedTo,
      });
      return { ok: true, releasedTo: updates._routingReleasedTo };
    } catch (error) {
      logger.logError('ohd:routing:release-hold error', error, { jobId, controllerId });
      return { ok: false, reason: 'error', error: error.message };
    }
  });

  // Darkroom Pro manual assignment — stores a per-job channel mapping override.
  // Unlike DPOF (which creates a permanent channel mapping), Darkroom Pro assign
  // stores the selected mapping ID directly on the job so the routing can resolve it.
  ipcMain.handle('jobs:assignDarkroomChannel', async (event, { jobId, channelMappingId }) => {
    try {
      jobService.updateJobLocally(jobId, { _darkroomProChannelMappingId: channelMappingId });
      logger.info('[DarkroomPro] Manual channel assignment stored', { jobId, channelMappingId });
      // Notify renderer so the job row re-renders with updated route
      if (windowManager) {
        const mainWindow = windowManager.getWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
        }
      }
      return { success: true };
    } catch (error) {
      logger.logError('jobs:assignDarkroomChannel error', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  // Darkroom Pro manual size+media assignment — stores per-job overrides so the
  // job can be dispatched without a matching translation table entry.
  ipcMain.handle('jobs:assignDarkroomSizeMedia', async (event, { jobId, size, media }) => {
    try {
      jobService.updateJobLocally(jobId, { _darkroomProSize: size, _darkroomProMedia: media });
      logger.info('[DarkroomPro] Manual size/media assignment stored', { jobId, size, media });
      if (windowManager) {
        const mainWindow = windowManager.getWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
        }
      }
      // Now that this job has its size/media overrides set, it may be eligible
      // for auto-print. Mirror the DPOF saveChannelMapping pattern: fire-and-
      // forget runAutoPrint so the auto-print loop's gate (ipc-handlers.js
      // ~1771: `if (!ctrl || !ctrl.autoprint) continue`) is the single source
      // of truth for whether dispatch happens. Renderer no longer calls
      // sendToPrint directly — that bypassed the autoprint flag (see
      // docs/orderhub/bugfixes.md, 2026-04-28 entry on assign-and-save).
      runAutoPrint().catch(err => logger.logError('[auto-print] post-darkroom-assign check failed', err));
      return { success: true };
    } catch (error) {
      logger.logError('jobs:assignDarkroomSizeMedia error', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  // Add size/media translation entries to a Darkroom Pro controller without
  // going through the full Settings save flow.
  ipcMain.handle('controllers:updateDarkroomTranslations', async (event, { controllerId, sizeTranslation, mediaTranslation }) => {
    try {
      const controllers = routingService.getControllers();
      const controller  = controllers.find(c => c.id === controllerId);
      if (!controller) {
        logger.logWarning('[DarkroomPro] updateDarkroomTranslations: controller not found', { controllerId, knownIds: controllers.map(c => c.id) });
        return { success: false, error: 'Controller not found' };
      }

      const sizeBefore  = (controller.sizeTranslations  || []).length;
      const mediaBefore = (controller.mediaTranslations || []).length;

      // M1 (darkroom-media-lock-brief): refuse a media translation when
      // this controller has no Paper Type Option Key. Same rule the
      // controller-save guard at ipc-handlers.js:1057-1073 enforces; the
      // reason this back door needs its own copy is that this handler
      // calls routingService.saveController directly and bypasses the
      // guard, which is how a controller with translations + blank key
      // was getting created in the first place. See
      // docs/darkroom-media-lock-plan.md §3 for the full path.
      //
      // Size and media are independent: a size translation in the same
      // call is still applied. Silently dropping it would be a new
      // instance of the same "back door that skips validation" bug
      // class this milestone exists to close.
      const mediaOptionKey    = String(controller.mediaOptionKey || '').trim();
      const wantsMediaWrite   = !!(mediaTranslation && mediaTranslation.from);
      const mediaRejected     = wantsMediaWrite && !mediaOptionKey;

      if (mediaRejected) {
        logger.logWarning('[DarkroomPro] updateDarkroomTranslations: media translation rejected — controller has no mediaOptionKey', {
          controllerId,
          controllerName: controller.name,
          from:           mediaTranslation.from,
          to:             mediaTranslation.to,
        });
      }

      if (sizeTranslation && sizeTranslation.productCodePrefix) {
        if (!Array.isArray(controller.sizeTranslations)) controller.sizeTranslations = [];
        const alreadyExists = controller.sizeTranslations.some(
          t => t.productCodePrefix &&
               t.productCodePrefix.toLowerCase() === sizeTranslation.productCodePrefix.toLowerCase()
        );
        if (!alreadyExists) {
          controller.sizeTranslations.push(sizeTranslation);
        } else {
          logger.info('[DarkroomPro] Size translation already exists — not duplicating', { productCodePrefix: sizeTranslation.productCodePrefix });
        }
      }

      if (wantsMediaWrite && !mediaRejected) {
        if (!Array.isArray(controller.mediaTranslations)) controller.mediaTranslations = [];
        const alreadyExists = controller.mediaTranslations.some(
          t => t.from && t.from.toLowerCase() === mediaTranslation.from.toLowerCase()
        );
        if (!alreadyExists) {
          controller.mediaTranslations.push(mediaTranslation);
        } else {
          logger.info('[DarkroomPro] Media translation already exists — not duplicating', { from: mediaTranslation.from });
        }
      }

      routingService.saveController(controller);
      logger.info('[DarkroomPro] Translation tables updated via assign modal', {
        controllerId,
        sizeTranslation,
        mediaTranslation,
        mediaRejected,
        sizeCountBefore:  sizeBefore,
        sizeCountAfter:   (controller.sizeTranslations  || []).length,
        mediaCountBefore: mediaBefore,
        mediaCountAfter:  (controller.mediaTranslations || []).length,
      });

      if (mediaRejected) {
        // Success:false so the caller surfaces the media problem
        // (renderer.js:1973 throws on this branch). The controller is
        // still returned so the caller's cache-update logic can pick up
        // the size change on the branches that don't throw. Error text
        // names the remedy AND states whether the size translation was
        // saved, so the operator isn't left wondering.
        const sizeApplied = !!(sizeTranslation && sizeTranslation.productCodePrefix);
        const remedy = 'Set the Paper Type Option Key on this controller in Settings → Routing first, then try again.';
        const error = sizeApplied
          ? `Media translation not saved — this controller has no Paper Type Option Key. ${remedy} The size translation was saved.`
          : `Media translation not saved — this controller has no Paper Type Option Key. ${remedy}`;
        return { success: false, error, controller };
      }
      return { success: true, controller };
    } catch (error) {
      logger.logError('controllers:updateDarkroomTranslations error', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ohd:routing:delete-channel-mapping', async (event, { id }) => {
    try {
      routingService.deleteChannelMapping(id);
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:delete-channel-mapping error', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ohd:routing:get-exceptions', async () => {
    return routingService.getExceptions();
  });

  ipcMain.handle('ohd:routing:save-exception', async (event, exception) => {
    try {
      routingService.saveException(exception);
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:save-exception error', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ohd:routing:delete-exception', async (event, { id }) => {
    try {
      routingService.deleteException(id);
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:delete-exception error', error);
      return { success: false, error: error.message };
    }
  });

  // Returns distinct process values: union of job cache (auto-discovery) + existing process mappings.
  // This ensures process types persist in the UI even after jobs are completed/removed from the cache,
  // and that manually-added process types (with no matching jobs yet) always appear.
  ipcMain.handle('ohd:routing:get-process-values', async () => {
    try {
      const { jobs } = jobService.getLocalJobs();
      // Strip surrounding quote characters so the UI displays "Wide Format" not '"Wide Format"'.
      const stripQuotes = p => (p || '').trim().replace(/^"|"$/g, '');
      const jobProcesses     = jobs.map(j => j.process).filter(Boolean).map(stripQuotes).filter(Boolean);
      const mappingProcesses = routingService.getProcessMappings().map(m => m.process).filter(Boolean);
      return [...new Set([...jobProcesses, ...mappingProcesses])].sort();
    } catch (error) {
      return [];
    }
  });

  // ── Shell ──

  ipcMain.handle('shell:openExternal', (event, url) => {
    shell.openExternal(url);
  });

  // ── App version & update state ──

  ipcMain.handle('app:getVersion', () => {
    return {
      version: app.getVersion(),
      updateReady: updater.isUpdateReady()
    };
  });

  // ── Test: Print Controller Services ──
  ipcMain.handle('test:printController', async () => {
    try {
      logger.info('Running print controller test...');
      const result = await runPrintControllerTest();
      logger.info(`Print controller test ${result.success ? 'PASSED' : 'FAILED'}`);
      return result;
    } catch (error) {
      logger.logError('Print controller test error', error);
      return { success: false, output: '', error: error.message };
    }
  });

  // ── Window controls (frameless window) ──
  // Use ipcMain.on (one-way) — no return value needed for minimise/close

  ipcMain.on('window:minimise', () => {
    const win = windowManager.getWindow();
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.on('window:maximise', () => {
    const win = windowManager.getWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.on('window:close', () => {
    const win = windowManager.getWindow();
    // close() triggers the existing 'close' handler in window-manager.js,
    // which calls event.preventDefault() + hide() — so this minimises to tray
    // rather than destroying the window, consistent with the tray app behaviour.
    if (win && !win.isDestroyed()) win.close();
  });

  // ── Job Review Panel ─────────────────────────────────────────────────────────
  // All channels prefixed `ohd:` per the brief.

  /**
   * ohd:job:load
   * Payload:  { jobId: string, jobPath: string }
   * Returns:  { sidecar, filenames }
   *
   * Loads (or creates) the job sidecar and returns it alongside the
   * list of image filenames present in /working/.
   * Also ensures /cache/ exists (Phase 3 hook — left empty).
   *
   * On first load (no sidecar yet), reads per-image quantities from the
   * order manifest JSON so qtyOriginal/qtyCurrent reflect the ordered
   * quantity rather than defaulting to 1.
   */
  ipcMain.handle('ohd:job:load', async (event, { jobId, jobPath }) => {
    console.log('[job:load] jobPath received:', jobPath);
    try {
      // First-run setup: if images sit in the job root (no /working/ yet),
      // copy them into /working/ and /originals/ before loadSidecar runs.
      await ensureWorkingSetup(jobPath);

      // Ensure the /cache/ folder exists (Phase 3 hook — always empty for now).
      await fsPromises.mkdir(path.join(jobPath, 'cache'), { recursive: true });

      // Build a filename→{qty, originalFilename} meta map from the order
      // manifest so first-time sidecar creation uses both ordered quantity
      // and the manifest-relative path to the customer's uncropped upload.
      // If the manifest is missing or unreadable, the map is empty and
      // loadSidecar falls back to qty=1 / originalFilename=null as before.
      // Reconcile inside loadSidecar back-fills `originalFilename` on
      // sidecars created before this feature shipped.
      const metaMap = await _buildManifestImageMetaMap(jobId, jobPath);

      const { sidecar, filenames } = await loadSidecar(jobId, jobPath, metaMap);

      // Count existing reprint siblings (-r1, -r2, …) so the renderer can
      // label the next Send-button suffix correctly when the panel is
      // re-opened after a previous reprint was dispatched. The reprint
      // create handler derives its own suffix the same way; this is a
      // display-only seed for the Job Review UI.
      const parentDir = path.dirname(jobPath);
      let reprintCount = 0;
      while (true) { // eslint-disable-line no-constant-condition
        const candidate = path.join(parentDir, `${jobId}-r${reprintCount + 1}`);
        try {
          await fsPromises.access(candidate);
          reprintCount++;
        } catch {
          break;
        }
      }

      return { success: true, sidecar, filenames, reprintCount };
    } catch (error) {
      logger.logError('ohd:job:load error', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:save
   * Payload:  Full sidecar object (must include jobId)
   * Returns:  { success: true, sidecar }
   *
   * Before saving, ensures /originals/ is backed up so any subsequent
   * reset can restore from a clean copy.  ensureOriginals() is a no-op
   * after the first call.
   */
  ipcMain.handle('ohd:job:save', async (event, { sidecar, jobPath }) => {
    try {
      await ensureOriginals(jobPath);
      const saved = await saveSidecar(sidecar, jobPath);
      return { success: true, sidecar: saved };
    } catch (error) {
      logger.logError('ohd:job:save error', error, { jobId: sidecar && sidecar.jobId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:reset-image
   * Payload:  { jobId, jobPath, sidecar, filename }
   * Returns:  { success: true, sidecar, entry }
   *
   * Restores a single image from /originals/ and resets its sidecar entry.
   */
  ipcMain.handle('ohd:job:reset-image', async (event, { jobPath, sidecar, filename }) => {
    try {
      const { sidecar: updated, entry } = await resetImage(jobPath, sidecar, filename);
      return { success: true, sidecar: updated, entry };
    } catch (error) {
      logger.logError('ohd:job:reset-image error', error, { filename });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:reset-all
   * Payload:  { jobPath, sidecar }
   * Returns:  { success: true, sidecar }
   *
   * Restores all images from /originals/ and resets every sidecar entry.
   */
  ipcMain.handle('ohd:job:reset-all', async (event, { jobPath, sidecar }) => {
    try {
      const updated = await resetAllImages(jobPath, sidecar);
      return { success: true, sidecar: updated };
    } catch (error) {
      logger.logError('ohd:job:reset-all error', error, { jobId: sidecar && sidecar.jobId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:crop-image
   * Payload:  { jobPath, sidecar, filename, cropRect, channelMappingId, ohJobId }
   *   cropRect: { x, y, w, h } — image-space pixels (passed directly to Sharp)
   *   ohJobId: numeric OrderHub job ID (string) — used to store the channel override
   * Returns:  { success: true, sidecar }
   *
   * 1. Sources the image from /working/ (or /originals/ if working copy absent).
   * 2. Applies the crop rectangle using Sharp and writes back to /working/filename.
   * 3. Updates the sidecar entry: cropApplied, croppedPath, cropRect, channelMappingId.
   * 4. Stores _channelMappingOverride on the job-service cache so that when the
   *    job is next sent to print the overridden channel is used automatically.
   */
  ipcMain.handle('ohd:job:crop-image', async (event, { jobPath, sidecar, filename, cropRect, channelMappingId, darkroomSize, ohJobId, cropRotation, sourceFrom }) => {
    // M5b (2026-05-25): the 75-line crop body that used to live here has
    // been extracted to `batchCropActions._applyCropToSingleImage` so the
    // new batch IPC can reuse the same primitive. Behaviour is
    // byte-identical from the IPC contract's perspective — the M5a tests
    // (manualCrop.test.js + manualCrop.dispatch.test.js) lock the
    // contract and exercise this wrapper end-to-end on every run.
    // `cropSource: 'per-image'` differentiates from batch in the sidecar.
    //
    // M5c (2026-05-26): optional `cropRotation` (0/90/180/270, default 0)
    // routes the sharp pipeline through `.rotate(N).extract(...)` when
    // non-zero. Default 0 keeps the byte-identical chain — locked by
    // the M5c regression test in batchCrop.test.js.
    try {
      // eslint-disable-next-line global-require
      const { _applyCropToSingleImage } = require('./jobs/batchCropActions');
      const result = await _applyCropToSingleImage({
        jobPath, sidecar, filename, cropRect,
        channelMappingId, darkroomSize, ohJobId,
        cropSource: 'per-image',
        cropRotation,  // optional — pass through; helper normalises invalid values to 0
        sourceFrom,    // Manual Crop redesign (2026-06-02) — 'originals' from ManualCropMode
        deps: { jobService, logger },
      });
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true, sidecar: result.sidecar };
    } catch (error) {
      logger.logError('ohd:job:crop-image error', error, { filename, cropRect });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:batch-crop-apply  (M5b — 2026-05-25)
   * Payload:  { jobPath, sidecar, filenames, fractionalSpec, sizeOption, orientation,
   *             perImageOrientations?, channelMappingId?, darkroomSize?, ohJobId?,
   *             sourceFrom? }
   * Returns:  { success, sidecar, succeeded:[], failed:[], skipped:[], aborted? }
   *
   * 2026-07-23 — orientation now accepts 'portrait' | 'landscape' | 'auto'.
   * With 'auto' the batch driver picks each image's crop-box orientation
   * from its own source aspect (bestFitOrientation), falling back to the
   * target size's orientation for square sources. An optional
   * perImageOrientations map ({ [filename]: 'portrait'|'landscape' })
   * overrides auto per file — the sidecar's persisted cropOrientation
   * always records the RESOLVED value, never the top-level 'auto' literal.
   * See docs/manual-crop-best-fit-orientation.md.
   *
   * Loops the M5a crop primitive over `filenames`, computing the per-image
   * pixel rect from `fractionalRect` × that image's source dimensions.
   * Strictly serial — libvips cache + SMB sensitivity make parallelism
   * risky. Per-image progress events emit on `ohd:batch-crop:progress`
   * for the renderer's live progress bar; one job-level sidecar save at
   * the end stamps the batchCropDefault* fields.
   *
   * Failure policy is continue-best-effort (Richard, 2026-05-25):
   * per-image failures land in `failed[]` and do NOT abort the batch.
   * Safety belt: 10 consecutive failures sharing the same error.code →
   * abort under reason 'consecutive-same-error'. See
   * batchCropActions.applyBatchCrop for the canonical comment.
   */
  ipcMain.handle('ohd:job:batch-crop-apply', async (event, payload = {}) => {
    try {
      // eslint-disable-next-line global-require
      const { applyBatchCrop } = require('./jobs/batchCropActions');
      const onProgress = (progress) => {
        // Best-effort emit to the sender. event.sender may be destroyed
        // mid-batch (window closed) — guard the send so we don't crash
        // the worker loop.
        try {
          if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('ohd:batch-crop:progress', progress);
          }
        } catch (_) { /* best-effort */ }
      };
      const result = await applyBatchCrop({
        ...payload,
        onProgress,
        deps: { jobService, logger },
      });
      return result;
    } catch (error) {
      logger.logError('ohd:job:batch-crop-apply error', error, { jobPath: payload && payload.jobPath });
      return { success: false, error: error.message, succeeded: [], failed: [], skipped: [] };
    }
  });

  /**
   * ohd:job:save-pending-crops  (Manual Crop redesign — 2026-06-01)
   *
   * Payload:  { jobPath, sidecar, updates: [{ filename, pendingCropRect,
   *             pendingRotation, pendingOrientation }] }
   * Returns:  { success: true, sidecar } | { success: false, error }
   *
   * Persists per-image in-progress crop state to the sidecar without
   * touching anything on /working/. Called from the manual-crop drawer
   * when the operator closes mid-job — drains the in-memory perImageState
   * deltas so reopening restores progress.
   *
   * Strictly a partial mutation: only the three pendingCrop* fields on
   * matched image entries are written. cropApplied / cropRect / cropRotation /
   * cropOrientation are NEVER touched here — those are owned by
   * `ohd:job:crop-image` (per-image Approve) and `ohd:job:batch-crop-apply`
   * (Apply Default to All). Updates against filenames missing from the
   * sidecar are silently skipped (renamed-since-load race).
   *
   * No `_applyCropToSingleImage` reuse — no sharp call, no disk I/O on
   * /working/. The whole operation is one sidecar JSON write.
   */
  ipcMain.handle('ohd:job:save-pending-crops', async (event, payload = {}) => {
    const { jobPath, sidecar, updates } = payload;
    try {
      if (!jobPath || !sidecar || !Array.isArray(sidecar.images)) {
        return { success: false, error: 'invalid-payload' };
      }
      if (!Array.isArray(updates) || updates.length === 0) {
        // No-op — return the sidecar unchanged. Renderer can treat this
        // as success; saves a disk write when there's nothing to persist.
        return { success: true, sidecar };
      }
      const byFilename = new Map();
      for (const u of updates) {
        if (u && typeof u.filename === 'string') byFilename.set(u.filename, u);
      }
      const nextImages = sidecar.images.map((img) => {
        const u = byFilename.get(img.filename);
        if (!u) return img;
        // Normalise: accept null / undefined / absent → null. Accept
        // explicit values only when they parse cleanly. Rotation must be
        // a finite multiple of 90; orientation must be one of the two
        // known strings. Anything else is coerced to null rather than
        // round-tripping garbage to disk.
        const rectOk = u.pendingCropRect
          && Number.isFinite(u.pendingCropRect.x)
          && Number.isFinite(u.pendingCropRect.y)
          && Number.isFinite(u.pendingCropRect.w)
          && Number.isFinite(u.pendingCropRect.h);
        const rotOk = Number.isFinite(u.pendingRotation)
          && [0, 90, 180, 270].includes(u.pendingRotation);
        const orientOk = u.pendingOrientation === 'portrait' || u.pendingOrientation === 'landscape';
        return {
          ...img,
          pendingCropRect:    rectOk   ? { x: u.pendingCropRect.x, y: u.pendingCropRect.y, w: u.pendingCropRect.w, h: u.pendingCropRect.h } : null,
          pendingRotation:    rotOk    ? u.pendingRotation    : null,
          pendingOrientation: orientOk ? u.pendingOrientation : null,
        };
      });
      const saved = await saveSidecar({ ...sidecar, images: nextImages }, jobPath);
      return { success: true, sidecar: saved };
    } catch (error) {
      logger.logError('ohd:job:save-pending-crops error', error, { jobPath });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:set-image-discarded  (Manual Crop redesign — 2026-06-02)
   *
   * Payload:  { jobPath, sidecar, filename, discarded: boolean }
   * Returns:  { success: true, sidecar } | { success: false, error }
   *
   * Toggles the operator-driven `discarded` flag on a single sidecar image
   * entry and persists the sidecar. Recoverable — the entry's
   * cropApplied / cropRect / pendingCropRect are LEFT INTACT so a restore
   * (discarded:false) recovers the prior approval state exactly. No file
   * deletion on disk.
   *
   * Discarded images are excluded from Send to Print's gate and the
   * print-service dispatch pipelines (see Step 10).
   */
  ipcMain.handle('ohd:job:set-image-discarded', async (event, payload = {}) => {
    const { jobPath, sidecar, filename, discarded } = payload;
    try {
      if (!jobPath || !sidecar || !Array.isArray(sidecar.images)) {
        return { success: false, error: 'invalid-payload' };
      }
      if (typeof filename !== 'string' || !filename) {
        return { success: false, error: 'filename is required' };
      }
      let found = false;
      const nextImages = sidecar.images.map((img) => {
        if (img.filename !== filename) return img;
        found = true;
        return { ...img, discarded: discarded === true };
      });
      if (!found) {
        return { success: false, error: `filename not in sidecar: ${filename}` };
      }
      const saved = await saveSidecar({ ...sidecar, images: nextImages }, jobPath);
      return { success: true, sidecar: saved };
    } catch (error) {
      logger.logError('ohd:job:set-image-discarded error', error, { jobPath, filename });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:job:resolve-target-size  (M5b — 2026-05-25)
   * Payload:  { job }
   * Returns:  { ok: true, sizeOption: { w, h, label, ...routeMeta } }
   *           | { ok: false, reason: 'unrouted'|'no-size-translation'|'no-channel'|'pdf-or-folder-copy' }
   *
   * Used by the batch crop UI for the read-only target-size pill. Calls
   * routingService.resolveRoute(job) and derives a canonical { w, h }
   * from the resolved route. If no route OR no resolvable size, returns
   * a structured reason so the renderer can show an actionable tooltip
   * (and disable batch mode) — NEVER falls back to a silent default.
   */
  ipcMain.handle('ohd:job:resolve-target-size', async (event, { job } = {}) => {
    // M5b bug-1 fix (2026-05-25): matcher logic extracted to
    // batchCropActions.resolveTargetSize so it can be unit-tested
    // without the IPC layer + real routing-service singleton. Three
    // independent lookup paths (DPOF channel-mapping, Darkroom
    // sizeTranslations, regex-on-printSizeCode fallback) — only
    // returns 'no-size-translation' when ALL three fail.
    // eslint-disable-next-line global-require
    const { resolveTargetSize } = require('./jobs/batchCropActions');
    return resolveTargetSize(job, {
      resolveRoute:        routingService.resolveRoute,
      getAllSizeOptions:   routingService.getAllSizeOptions,
      getChannelMappings:  routingService.getChannelMappings,
      getControllers:      routingService.getControllers,
      logger,
    });
  });

  // ── Customer Originals (Phase 1) ─────────────────────────────────────────
  //
  //   ohd:original:open     → shell.openPath          (default viewer)
  //   ohd:original:reveal   → shell.showItemInFolder  (Explorer/Finder, file selected)
  //
  // Both validate existence first so a race / partial download / manual
  // deletion produces a structured `{ ok:false, error:'not-found' }` rather
  // than a silent shell call that does nothing visible to the operator.
  //
  // The resolve + access + shell-out logic lives in
  // `src/main/jobs/customerOriginalsActions.js` so it can be unit-tested
  // without standing up the whole IPC layer.
  const { createCustomerOriginalsActions } = require('./jobs/customerOriginalsActions');
  const _customerOriginalsActions = createCustomerOriginalsActions({ shell, logger });

  ipcMain.handle('ohd:original:open',   (event, args) => _customerOriginalsActions.openOriginal(args || {}));
  ipcMain.handle('ohd:original:reveal', (event, args) => _customerOriginalsActions.revealOriginal(args || {}));

  // ── Customer Originals (Phase 2) — re-crop from original ─────────────────
  //
  // Re-crops the customer's uncropped upload through sharp into
  //   {jobPath}/recrops/{baseNoExt}_{ts}.jpeg      (canonical audit record)
  // and copies it to
  //   {jobPath}/working/{newBasename}              (active source — sendReprint /
  //                                                  scoring scanner / originals
  //                                                  manager all read /working/
  //                                                  unchanged, see locked
  //                                                  decision Option A in the brief)
  // Sidecar `entry.filename` re-points to the new basename; pixel-derived
  // fields reset; operator-intent fields persist. See
  // src/main/jobs/customerRecropActions.js for the contract.
  //
  // Lazy-required so the renderer-only flow doesn't drag sharp into the
  // module graph at app boot.
  let _customerRecropActions = null;
  function _getCustomerRecropActions() {
    if (_customerRecropActions) return _customerRecropActions;
    let sharp;
    try {
      sharp = require('sharp');
    } catch {
      return null;
    }
    const { createCustomerRecropActions } = require('./jobs/customerRecropActions');
    _customerRecropActions = createCustomerRecropActions({ sharp, logger });
    return _customerRecropActions;
  }

  ipcMain.handle('ohd:job:recrop-from-original', async (event, args = {}) => {
    const actions = _getCustomerRecropActions();
    if (!actions) {
      return { success: false, error: 'sharp is not installed — cannot re-crop. Run: npm install sharp' };
    }
    try {
      return await actions.recropFromOriginal(args);
    } catch (err) {
      logger.logError('[ohd:job:recrop-from-original] handler threw', err);
      return { success: false, error: err.message || String(err) };
    }
  });

  /**
   * ohd:reprint:create
   * Payload:  { jobId, jobPath }
   * Returns:  { success: true, reprintJobId, reprintJobPath, printResult }
   *
   * Loads the current sidecar from disk (which should have been saved with
   * reprint flags set), derives the next reprint suffix by scanning the
   * parent directory for existing -r* siblings, creates the reprint job
   * folder, sends it through the full DPOF print pipeline, then clears
   * the reprint flags in the parent sidecar.
   */
  ipcMain.handle('ohd:reprint:create', async (event, { jobId, jobPath }) => {
    try {
      // Load the current sidecar to read reprint flags.
      const { sidecar } = await loadSidecar(jobId, jobPath);

      // Look up the parent job from the local cache to get API-level fields
      // (job_name, product, options, process) needed for folder naming + DPOF.
      //
      // The jobId arriving here is in sidecar format: "{orderNumber}_{apiJobId}"
      // (e.g. "PXDEMO-R9F091_38348645").  The local job cache uses the numeric
      // API job ID only, so we must extract it by splitting on the last underscore.
      const { jobs } = jobService.getLocalJobs();
      const rawJobId = String(jobId);
      const lastUnderscore = rawJobId.lastIndexOf('_');
      const apiJobId = lastUnderscore !== -1
        ? rawJobId.substring(lastUnderscore + 1)
        : rawJobId;

      const parentJob = jobs.find(j => String(j.id) === apiJobId);
      if (!parentJob) {
        return { success: false, error: `Parent job ${jobId} (apiJobId: ${apiJobId}) not found in local cache. Try refreshing the job list.` };
      }

      // Derive the next reprint suffix (r1, r2, …) by checking what already exists.
      const parentDir = path.dirname(jobPath);
      let n = 1;
      while (true) { // eslint-disable-line no-constant-condition
        const candidate = path.join(parentDir, `${jobId}-r${n}`);
        try {
          await fsPromises.access(candidate);
          n++; // folder already exists — try next
        } catch {
          break; // folder does not exist — use this n
        }
      }
      const reprintJobId  = `${jobId}-r${n}`;
      const reprintSuffix = `r${n}`;

      // Create the local reprint job folder (originals/, working/, cache/, sidecar)
      const result = await createReprint({
        parentJobId:   jobId,
        parentJobPath: jobPath,
        sidecar,
        reprintJobId,
      });

      // Dispatch through the reprint orchestrator. It resolves the parent
      // job's route and picks the right controller-type pipeline (Darkroom
      // Pro, DPOF, …). The folder is already built at this point — if
      // dispatch fails the folder stays on disk so the operator can fix
      // the routing config and try again (the next attempt will create
      // -r2 / -r3 as the folder-name scan loop sees the orphaned -r1).
      const printResult = await printService.sendReprint(
        parentJob,
        result.reprintJobPath,
        reprintSuffix,
        result.reprintSidecar.images
      );

      if (!printResult.success) {
        // Surface the print failure to the renderer instead of returning
        // success: true with a warning. Pre-2026-05-12 the handler swallowed
        // dispatch errors here, which meant operators sending Darkroom Pro
        // reprints saw the "JOB-r1 sent ✓" pill but no .txt ever landed in
        // the hot folder. See bugfixes.md 2026-05-12 entry.
        logger.logWarning('Reprint folder created but print dispatch failed', {
          reprintJobId,
          error: printResult.error,
        });
        return {
          success: false,
          error: `Reprint folder ${reprintJobId} created but dispatch failed: ${printResult.error}`,
          // Surface the folder ID so the renderer can show a useful message
          // and so future "retry dispatch" logic (not implemented today)
          // can pick up where this attempt left off.
          reprintJobId: result.reprintJobId,
          reprintJobPath: result.reprintJobPath,
        };
      }

      // If the reprint was sent to a DPOF controller, resume status polling.
      if (printResult.method === 'dpof-reprint') {
        startStatusPolling(windowManager);
      }

      // Clear reprint flags in the parent sidecar after a successful reprint.
      const clearedImages = sidecar.images.map(img => ({
        ...img,
        reprint: false,
        reprintJobId: result.reprintJobId
      }));
      await saveSidecar({ ...sidecar, images: clearedImages }, jobPath);

      return { success: true, ...result, printResult };
    } catch (error) {
      logger.logError('ohd:reprint:create error', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:reprint:createSingle
   * Payload:  { jobId, jobPath, imageFilename }
   * Returns:  { success, reprintJobId, reprintJobPath, printResult } | { success:false, error }
   *
   * Single-image reprint — dispatches JUST one image, without bundling the
   * other flagged images. Backs the crop modal's "Apply & Send Reprint"
   * button. Mirrors ohd:reprint:create; the differences:
   *   - The sidecar handed to createReprint is filtered to the one target
   *     entry with reprint:true forced — createReprint re-filters its input
   *     on `reprint === true` and throws on an empty set (reprintManager.js).
   *   - On success only the dispatched image's reprint flag is cleared;
   *     other flagged images stay flagged for the bundle flow.
   *
   * `imageFilename` is the POST-apply sidecar filename (a re-crop re-points
   * it) — the caller applies the crop first, then calls this.
   *
   * Source-file precedence: single-image reprints inherit reprintManager's
   * /originals/ → /working/ copy precedence (see the reprintManager.js file
   * header for the full explanation). For a job that has a separate customer
   * original, an in-place customer-mode re-crop is NOT reflected in the
   * dispatched file — the uncropped /originals/ copy takes precedence. For
   * that case the operator must use the crop modal's "Original" mode, which
   * re-points the entry to a /working/-only basename that the precedence
   * then resolves to the recropped pixels. (Decision A — documented limitation.)
   */
  ipcMain.handle('ohd:reprint:createSingle', async (event, { jobId, jobPath, imageFilename }) => {
    try {
      // Load the current sidecar (post-apply — the crop is already saved).
      const { sidecar } = await loadSidecar(jobId, jobPath);

      // Identify the target entry by filename — the identifier convention
      // used throughout the recrop flow (customerRecropActions.js).
      const targetImage = sidecar.images.find(img => img.filename === imageFilename);
      if (!targetImage) {
        return { success: false, error: `Image "${imageFilename}" not in sidecar` };
      }

      // Resolve the parent API job from the local cache (same id split as
      // ohd:reprint:create).
      const { jobs } = jobService.getLocalJobs();
      const rawJobId = String(jobId);
      const lastUnderscore = rawJobId.lastIndexOf('_');
      const apiJobId = lastUnderscore !== -1
        ? rawJobId.substring(lastUnderscore + 1)
        : rawJobId;

      const parentJob = jobs.find(j => String(j.id) === apiJobId);
      if (!parentJob) {
        return { success: false, error: `Parent job ${jobId} (apiJobId: ${apiJobId}) not found in local cache. Try refreshing the job list.` };
      }

      // Derive the next reprint suffix (r1, r2, …).
      const parentDir = path.dirname(jobPath);
      let n = 1;
      while (true) { // eslint-disable-line no-constant-condition
        const candidate = path.join(parentDir, `${jobId}-r${n}`);
        try {
          await fsPromises.access(candidate);
          n++;
        } catch {
          break;
        }
      }
      const reprintJobId  = `${jobId}-r${n}`;
      const reprintSuffix = `r${n}`;

      // Sidecar filtered to JUST the target image. reprint:true is forced so
      // createReprint's internal `reprint === true` filter keeps it even if
      // the operator never ticked the reprint checkbox.
      const singleImageSidecar = {
        ...sidecar,
        images: [{ ...targetImage, reprint: true }],
      };

      // Build the reprint folder — contains only the one image.
      const result = await createReprint({
        parentJobId:   jobId,
        parentJobPath: jobPath,
        sidecar:       singleImageSidecar,
        reprintJobId,
      });

      // Dispatch through the reprint orchestrator (folder_copy, darkroompro,
      // dpof; other types fall through to its catch-all, same as the bundle).
      const printResult = await printService.sendReprint(
        parentJob,
        result.reprintJobPath,
        reprintSuffix,
        result.reprintSidecar.images
      );

      if (!printResult.success) {
        logger.logWarning('Single-image reprint folder created but print dispatch failed', {
          reprintJobId,
          imageFilename,
          error: printResult.error,
        });
        return {
          success: false,
          error: `Reprint folder ${reprintJobId} created but dispatch failed: ${printResult.error}`,
          reprintJobId: result.reprintJobId,
          reprintJobPath: result.reprintJobPath,
        };
      }

      if (printResult.method === 'dpof-reprint') {
        startStatusPolling(windowManager);
      }

      logger.info('Single-image reprint sent', {
        reprintJobId,
        imageFilename,
        jobId,
        method: printResult.method,
      });

      // Clear the reprint flag for ONLY the dispatched image — other flagged
      // images stay flagged for the bundle flow.
      const clearedImages = sidecar.images.map(img =>
        img.filename === imageFilename
          ? { ...img, reprint: false, reprintJobId: result.reprintJobId }
          : img
      );
      await saveSidecar({ ...sidecar, images: clearedImages }, jobPath);

      return { success: true, ...result, printResult };
    } catch (error) {
      logger.logError('ohd:reprint:createSingle error', error, { jobId, imageFilename });
      return { success: false, error: error.message };
    }
  });

  // ── AI Enhancement (Phase 3) ─────────────────────────────────────────────────
  // All channels prefixed `ohd:enhancement:`.

  /**
   * ohd:enhancement:test
   * Payload:  { apiKey, provider? }
   * Returns:  { valid: true, durationMs?, executionProvider?, meta? }
   *           | { valid: false, error: string }
   *
   * For provider === 'topaz': validates the supplied API key with a pure
   * network check (no file I/O, no sidecar). The apiKey is passed directly
   * from the Settings form so the operator can test it before saving.
   *
   * For provider === 'local' (Pixfizz AI Enhancement): runs a real one-tile
   * inference on a synthesised 64×64 fixture via localClient.selfTest().
   * Returns timing + execution-provider metadata so the UI can display
   * "Model loaded successfully in Xms (CPU)".
   *
   * The apiKey field is never logged.
   */
  ipcMain.handle('ohd:enhancement:test', async (event, { apiKey, provider }) => {
    try {
      if (provider === 'local') {
        const r = await localEnhancementClient.selfTest();
        if (r.ok) {
          return {
            valid: true,
            durationMs: r.durationMs,
            executionProvider: r.meta && r.meta.executionProvider,
            meta: r.meta,
          };
        }
        return { valid: false, error: r.error || 'self-test failed' };
      }
      return await enhancementManager.validateApiKey(apiKey, provider);
    } catch (error) {
      // Do NOT log apiKey — keep it out of the activity log.
      logger.logError('ohd:enhancement:test error', error);
      return { valid: false, error: error.message };
    }
  });

  /**
   * ohd:config:clear-replicate-migration-toast
   * Payload:  none
   * Returns:  { success: true }
   *
   * Called by the renderer once the post-upgrade Replicate-removal toast has
   * been displayed. Flips the one-shot `_migratedFromReplicate` flag back to
   * false so the toast doesn't re-show on subsequent launches. The migration
   * itself remains stamped via `_replicateProviderMigratedAt`.
   */
  ipcMain.handle('ohd:config:clear-replicate-migration-toast', async () => {
    try {
      const configService = require('./services/config-service');
      configService.clearReplicateMigrationToast();
      return { success: true };
    } catch (error) {
      logger.logError('ohd:config:clear-replicate-migration-toast error', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:pc:testConfig  (Perfectly Clear QuickServer — M1)
   * Payload:  { inputFolder, outputFolder, rejectedFolder }
   * Returns:  { ok: true } | { ok: false, error: <operator-readable> }
   *
   * Checks:
   *   1. All three folders exist on disk.
   *   2. inputFolder is writable — via a temp probe file
   *      `ohd_probe_{ts}.txt`. QuickServer classifies .txt as a
   *      "skipped" non-image and passes it through to Output; the
   *      handler makes a best-effort attempt to delete the mirrored
   *      copy if it materialises (doesn't fail the test if it doesn't).
   *
   * No write probe on output/rejected — QuickServer owns those
   * directories, and permission model on shares typically differs
   * (OHD writes only to input).
   */
  ipcMain.handle('ohd:pc:testConfig', async (_event, payload) => {
    const p = payload || {};
    const inputFolder    = typeof p.inputFolder    === 'string' ? p.inputFolder.trim()    : '';
    const outputFolder   = typeof p.outputFolder   === 'string' ? p.outputFolder.trim()   : '';
    const rejectedFolder = typeof p.rejectedFolder === 'string' ? p.rejectedFolder.trim() : '';

    if (!inputFolder || !outputFolder || !rejectedFolder) {
      return { ok: false, error: 'All three folders (input, output, rejected) are required.' };
    }

    for (const [role, folder] of [['input', inputFolder], ['output', outputFolder], ['rejected', rejectedFolder]]) {
      if (!fs.existsSync(folder)) {
        return { ok: false, error: `${role} folder does not exist: ${folder}` };
      }
    }

    // Input writable — probe via temp file. .txt tolerated by QuickServer
    // per its "skipped file" documentation; a copy MAY appear in output.
    const path = require('path');
    const probeName = `ohd_probe_${Date.now()}.txt`;
    const probePath = path.join(inputFolder, probeName);
    try {
      await fsPromises.writeFile(probePath, 'ohd perfectly clear probe\n', 'utf8');
    } catch (err) {
      return { ok: false, error: `Input folder is not writable: ${err.message}` };
    }
    // Clean up the probe. Best-effort — if QuickServer already consumed it
    // (input side deletion is instantaneous for skipped files on some setups)
    // that's fine.
    try { await fsPromises.unlink(probePath); } catch (_) { /* best-effort */ }
    // Best-effort cleanup of any output mirror.
    try { await fsPromises.unlink(path.join(outputFolder, probeName)); } catch (_) { /* best-effort */ }

    return { ok: true };
  });

  /**
   * ohd:enhancement:run
   * Payload:  { jobId, jobPath, filename, model, options }
   * Returns:  { success: true, status: 'started', predictionId }
   *
   * Starts an enhancement job and returns immediately with a synthetic job
   * ID (`local_*` for Pixfizz AI, `topaz_*` for the Topaz Image API). The
   * renderer polls ohd:enhancement:status until the job completes. The
   * IPC field name `predictionId` is preserved for renderer compatibility.
   *
   * `model` is hoisted out of `options` for convenience so the renderer
   * component can pass it as a top-level field from the model dropdown.
   */
  ipcMain.handle('ohd:enhancement:run', async (event, { jobId, jobPath, filename, model, options = {} }) => {
    try {
      logger.info('ohd:enhancement:run started', { jobId, filename, model });
      const mergedOptions = { ...options, model: model || options.model || 'Standard V2' };
      const predictionId  = await enhancementManager.startEnhancement(
        jobId, jobPath, filename, mergedOptions,
      );
      return { success: true, status: 'started', predictionId };
    } catch (error) {
      logger.logError('ohd:enhancement:run error', error, { jobId, filename });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:enhancement:status
   * Payload:  { predictionId }
   * Returns:  { success: true, status, outputPath? } | { success: false, error }
   *
   * Called by the renderer on a polling interval (~3 s) after a run is started.
   * When status is 'succeeded', the manager downloads the result, updates the
   * sidecar, and returns the local outputPath so the renderer can refresh the
   * preview.  The renderer should stop polling on 'succeeded', 'failed', or
   * 'canceled'.
   */
  ipcMain.handle('ohd:enhancement:status', async (event, { predictionId }) => {
    try {
      const result = await enhancementManager.checkEnhancement(predictionId);
      return { success: true, ...result };
    } catch (error) {
      logger.logError('ohd:enhancement:status error', error, { predictionId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:enhancement:cancel
   * Payload:  { predictionId }
   * Returns:  { success: true, cancelled: true } | { success: false, error }
   *
   * Cancels an in-progress enhancement job and removes it from the
   * in-memory registry. Safe to call on a job that has already completed.
   * For Pixfizz AI Enhancement (`local_*` IDs), cancellation is
   * cooperative — the tile loop terminates after the current ~500 ms tile
   * finishes inferring.
   */
  ipcMain.handle('ohd:enhancement:cancel', async (event, { predictionId }) => {
    try {
      await enhancementManager.cancelEnhancement(predictionId);
      return { success: true, cancelled: true };
    } catch (error) {
      logger.logError('ohd:enhancement:cancel error', error, { predictionId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:enhancement:batchRun  (Perfectly Clear — M3)
   * Payload:  { jobId, jobPath, filenames: string[], configId?, timeoutMs?, triggeredBy? }
   * Returns:  { success: true, batchId } | { success: false, error }
   *
   * Kicks off a Perfectly Clear batch through the shared hot-folder client
   * and returns a synthetic batch ID. Per-file completion runs the same
   * cache→working copy-back + sidecar update the single-image path uses,
   * so partial batches (some enhanced, some rejected) land on disk exactly
   * like the single-image case — `_getEnhancedPathMap` needs zero changes.
   *
   * The renderer polls `ohd:enhancement:batchStatus` and can abort via
   * `ohd:enhancement:batchCancel`.
   */
  ipcMain.handle('ohd:enhancement:batchRun', async (event, payload = {}) => {
    const { jobId, jobPath, filenames, configId, timeoutMs, triggeredBy } = payload;
    try {
      logger.info('ohd:enhancement:batchRun started', {
        jobId, count: Array.isArray(filenames) ? filenames.length : 0, configId,
      });
      const batchId = await enhancementManager.startBatchEnhancement({
        jobId, jobPath, filenames, configId, timeoutMs, triggeredBy,
      });
      return { success: true, batchId };
    } catch (error) {
      logger.logError('ohd:enhancement:batchRun error', error, { jobId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:enhancement:batchStatus  (Perfectly Clear — M3)
   * Payload:  { batchId }
   * Returns:  { success, batchId, files: [{filename, status, error?}], counts, finished }
   */
  ipcMain.handle('ohd:enhancement:batchStatus', async (event, { batchId } = {}) => {
    try {
      return await enhancementManager.checkBatchStatus(batchId);
    } catch (error) {
      logger.logError('ohd:enhancement:batchStatus error', error, { batchId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:enhancement:batchCancel  (Perfectly Clear — M3)
   * Payload:  { batchId }
   * Returns:  { success, cancelled? } | { success: false, error }
   *
   * Cooperative cancel: files already resolved keep their terminal status;
   * still-queued files eventually resolve to 'cancelled' when the client
   * sees the abort. In-flight staged copies at QuickServer aren't recalled.
   */
  ipcMain.handle('ohd:enhancement:batchCancel', async (event, { batchId } = {}) => {
    try {
      return await enhancementManager.cancelBatch(batchId);
    } catch (error) {
      logger.logError('ohd:enhancement:batchCancel error', error, { batchId });
      return { success: false, error: error.message };
    }
  });

  /**
   * ohd:enhancement:revert  (Perfectly Clear — M3)
   * Payload:  { jobId, jobPath, filename }
   * Returns:  { success, sidecar } | { success: false, error }
   *
   * Restore /working/{filename} from the pre-PC snapshot in /cache/ and
   * strip the enhancement bookkeeping fields from the sidecar. Crop fields
   * are deliberately left untouched — crop still wins over enhancement at
   * dispatch and is orthogonal per the M3 decision.
   */
  ipcMain.handle('ohd:enhancement:revert', async (event, { jobId, jobPath, filename } = {}) => {
    try {
      logger.info('ohd:enhancement:revert', { jobId, filename });
      return await enhancementManager.revertEnhancement({ jobId, jobPath, filename });
    } catch (error) {
      logger.logError('ohd:enhancement:revert error', error, { jobId, filename });
      return { success: false, error: error.message };
    }
  });

  // ── Backup & Restore (v1.6+) ──
  //
  // Lazy-init the backup-service singleton so a broken backup module never
  // breaks the rest of IPC registration. All channels validate input and
  // surface errors as `{success:false, error}` rather than throwing — the
  // renderer can rely on a structured response.
  const backupServiceModule = require('./services/backup-service');

  ipcMain.handle('ohd:backup:run-now', async (event, args = {}) => {
    // `takeOverFolder` is the explicit operator opt-in to delete a colliding
    // hostname's existing backups on the share and write a fresh one — used
    // when an old PC's backups must be replaced by this PC's. Everything
    // else flows through the normal collision check.
    const overrides = {
      takeOverFolder: Boolean(args && args.takeOverFolder),
    };
    try {
      return await backupServiceModule.getDefault().runBackup({
        trigger: 'manual',
        overrides,
      });
    } catch (err) {
      logger.logError('[backup] run-now handler threw', err);
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('ohd:backup:list', async (event, args = {}) => {
    try {
      const folderPath = args && typeof args.folderPath === 'string' && args.folderPath
        ? args.folderPath
        : undefined;
      const allHosts = Boolean(args && args.allHosts);
      return await backupServiceModule.getDefault().listBackups(folderPath, { allHosts });
    } catch (err) {
      logger.logError('[backup] list handler threw', err);
      return [];
    }
  });

  ipcMain.handle('ohd:backup:read', async (event, args = {}) => {
    if (!args || typeof args.filePath !== 'string' || !args.filePath) {
      return { envelope: null, error: 'filePath is required' };
    }
    try {
      return await backupServiceModule.getDefault().readBackup(args.filePath);
    } catch (err) {
      logger.logError('[backup] read handler threw', err);
      return { envelope: null, error: err.message || String(err) };
    }
  });

  ipcMain.handle('ohd:backup:restore', async (event, args = {}) => {
    if (!args || typeof args.filePath !== 'string' || !args.filePath) {
      return { success: false, error: 'filePath is required' };
    }
    const selections = args.selections && typeof args.selections === 'object'
      ? args.selections
      : undefined;
    try {
      return await backupServiceModule.getDefault().restore({
        filePath: args.filePath,
        selections,
      });
    } catch (err) {
      logger.logError('[backup] restore handler threw', err);
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('ohd:backup:relaunch', async () => {
    logger.info('[backup] relaunching to apply restored configuration');
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.handle('ohd:backup:validate-folder', async (event, args = {}) => {
    const folderPath = args && typeof args.folderPath === 'string' ? args.folderPath : '';
    try {
      return await backupServiceModule.getDefault().validateFolder(folderPath);
    } catch (err) {
      logger.logError('[backup] validate-folder handler threw', err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('ohd:backup:choose-folder', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Backup Folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      return { canceled: false, path: result.filePaths[0] };
    } catch (err) {
      logger.logError('[backup] choose-folder failed', err);
      return { canceled: true, error: err.message };
    }
  });

  ipcMain.handle('ohd:backup:choose-file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Choose Backup File to Restore',
        properties: ['openFile'],
        filters: [{ name: 'OHD Backup Files', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      return { canceled: false, path: result.filePaths[0] };
    } catch (err) {
      logger.logError('[backup] choose-file failed', err);
      return { canceled: true, error: err.message };
    }
  });

  // Start DPOF output status polling on app launch.
  // It will self-pause when no jobs are in "o" (Awaiting Import) status and
  // resume each time a job is successfully sent to a DPOF controller.
  startStatusPolling(windowManager);

  // OH→OHD background sync: wait 30 s for the app to settle, then run once,
  // then repeat every 5 minutes.
  setTimeout(async () => {
    await syncAndNotify();
    setInterval(syncAndNotify, 5 * 60 * 1000);
  }, 30000);

  logger.info('IPC handlers registered');
}

// ── DPOF Output Status Polling ─────────────────────────────────────────────────
//
// Polls every 10 seconds for jobs currently in "o" (Awaiting Import) status.
// When the controller renames a folder to "e" (Imported) or "q" (Failed Import)
// an ohd:job:status-changed event is pushed to the renderer — exactly once per
// job per terminal transition.  Jobs are tracked in _terminalJobs so they are
// never re-notified on subsequent poll cycles.  Polling self-pauses when no jobs
// remain in "o" status.

let _pollTimer          = null;
let _pollWindowManager  = null;

// Job IDs that have already reached a terminal folder state (e or q).
// Prevents the renderer receiving repeated "Imported" / "Failed Import" toasts
// on every 10-second poll cycle for the same job.
// Cleared per job when the operator resends it so the new o→e/q cycle is tracked.
const _terminalJobs = new Set();

// M4 of docs/epson-batch-splitting-brief.md — this poller is now
// batch-aware. Two paths:
//
//   - Unsplit job (no _batchLedger): single getJobOutputStatus lookup,
//     terminal state notified once per job. Pre-M4 behaviour, unchanged.
//   - Split job (with _batchLedger): iterate ledger.batches, poll each
//     batch's folder. Notify per-batch (composite terminal key
//     `${jobId}:${batchIndex}`) so a batch already at `e` isn't
//     re-toasted while its siblings are still pending. Aggregate:
//       - `Imported` UI event only when EVERY batch has reached `e`
//         (matches polling-service._handleFolderStatusChange's roll-up
//         via allBatchesAccepted — the event-driven path is the
//         primary; this fs-based poll is the safety net).
//       - `Failed Import (batch N)` when any batch is at `q`.
//
// The reprint-attribution risk the brief flags (a reprint's folder
// might be confused with the parent's) is closed at THIS layer by
// getJobOutputStatus's per-baseName lookup: it builds
// buildFolderName('', job, reprintSuffix=null) and matches exactly,
// so a reprint's folder (which has `_r1_` in the middle) never matches
// the parent's baseName. Any future refactor that switches to
// jobId-prefix matching must preserve this invariant.
async function _pollAwaitingJobs() {
  if (!_pollWindowManager) return;

  const mainWindow = _pollWindowManager.getWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { jobs } = jobService.getLocalJobs();
  const { readLedger } = require('../shared/batchLedger');

  // Collect { job, outputFolderPath } pairs for all DPOF jobs.
  // New routing system takes priority; old printControllerStore is the fallback.
  const dpofJobs = [];
  for (const job of jobs) {
    const route = routingService.resolveRoute(job);
    if (route.type === 'controller') {
      // New routing system — get outputPath from routingService
      const ctrl = routingService.getControllers().find(c => c.id === route.controllerId);
      if (ctrl && ctrl.outputPath) {
        dpofJobs.push({ job, outputFolderPath: ctrl.outputPath, includeCustomerInFolder: ctrl.includeCustomerInFolder !== false });
      }
    } else {
      // Fallback: old configService + printControllerStore
      const mapping = configService.getProcessMapping(job.process);
      if (mapping.controllerId) {
        const ctrl = printControllerStore.getController(mapping.controllerId);
        if (ctrl && ctrl.type !== 'darkroompro' && ctrl.hotFolderPath) {
          dpofJobs.push({ job, outputFolderPath: ctrl.hotFolderPath, includeCustomerInFolder: ctrl.includeCustomerInFolder !== false });
        }
      }
    }
  }

  let hasAwaitingJobs = false;

  for (const { job, outputFolderPath, includeCustomerInFolder } of dpofJobs) {
    try {
      const jid    = String(job.id);
      const ledger = readLedger(job);

      // ── Split-job path (M4) ───────────────────────────────────────
      if (ledger && Array.isArray(ledger.batches) && ledger.batches.length > 0) {
        // Poll every batch's folder-for-a-batch. Track per-batch
        // terminal state via composite key so a `Failed Import
        // (batch N)` for one batch doesn't gate the poll on unrelated
        // batches, and a batch already at `e` doesn't re-toast on
        // every cycle.
        let anyPending = false;
        let anyFailed  = null;   // { batchIndex, total }
        let allAccepted = true;
        for (const entry of ledger.batches) {
          if (!entry || !Number.isInteger(entry.index)) continue;
          const batchDescr = { index: entry.index, total: entry.total };
          const status = await getJobOutputStatus(job, outputFolderPath, null, {
            includeCustomerName: includeCustomerInFolder,
            batch:               batchDescr,
          });
          if (!status) { allAccepted = false; continue; }
          const bkey = `${jid}:${entry.index}`;
          if (status.prefix === 'o') { anyPending = true; allAccepted = false; }
          else if (status.prefix === 'p') { anyPending = true; allAccepted = false; }
          else if (status.prefix === 'q') {
            allAccepted = false;
            if (!anyFailed) anyFailed = { batchIndex: entry.index, total: entry.total };
            if (!_terminalJobs.has(bkey)) _terminalJobs.add(bkey);
          } else if (status.prefix === 'e') {
            if (!_terminalJobs.has(bkey)) _terminalJobs.add(bkey);
          }
        }

        if (anyPending) hasAwaitingJobs = true;

        // Per-job (not per-batch) UI notification — same channel the
        // renderer already listens on, exactly-once per terminal
        // transition. Guarded by `_dpofNotified` for restart-safety.
        if (anyFailed && !_terminalJobs.has(jid)) {
          _terminalJobs.add(jid);
          jobService.updateJobLocally(job.id, { _dpofNotified: true });
          mainWindow.webContents.send('ohd:job:status-changed', {
            jobId:      jid,
            status:     `Failed Import (batch ${anyFailed.batchIndex}/${anyFailed.total})`,
            prefix:     'q',
            batchIndex: anyFailed.batchIndex,
            batchTotal: anyFailed.total,
          });
        } else if (allAccepted && !anyFailed && !_terminalJobs.has(jid)) {
          _terminalJobs.add(jid);
          jobService.updateJobLocally(job.id, { _dpofNotified: true });
          mainWindow.webContents.send('ohd:job:status-changed', {
            jobId:   jid,
            status:  'Imported',
            prefix:  'e',
            batches: ledger.totalBatches,
          });
        }
        continue;
      }

      // ── Unsplit-job path (pre-M4 behaviour, unchanged) ────────────
      const status = await getJobOutputStatus(job, outputFolderPath, null, { includeCustomerName: includeCustomerInFolder });

      if (!status) continue;

      if (status.prefix === 'o') {
        hasAwaitingJobs = true;
      } else if (status.prefix === 'e' && !_terminalJobs.has(jid)) {
        // Controller successfully imported — notify renderer once, then stop tracking
        _terminalJobs.add(jid);
        jobService.updateJobLocally(job.id, { _dpofNotified: true }); // persist across restarts
        mainWindow.webContents.send('ohd:job:status-changed', {
          jobId:  jid,
          status: 'Imported',
          prefix: 'e'
        });
      } else if (status.prefix === 'q' && !_terminalJobs.has(jid)) {
        // Controller flagged a failed import — notify renderer once, then stop tracking
        _terminalJobs.add(jid);
        jobService.updateJobLocally(job.id, { _dpofNotified: true }); // persist across restarts
        mainWindow.webContents.send('ohd:job:status-changed', {
          jobId:  jid,
          status: 'Failed Import',
          prefix: 'q'
        });
      }
      // Jobs already in _terminalJobs (e or q) are silently skipped — no repeat events
    } catch (err) {
      // Don't let a single job error break the whole poll cycle
      logger.logError('Status poll error for job', err, { jobId: job.id });
    }
  }

  // No jobs awaiting import — pause the timer (startStatusPolling re-arms it)
  if (!hasAwaitingJobs) {
    stopStatusPolling();
  }
}

function startStatusPolling(windowManager) {
  _pollWindowManager = windowManager;
  if (_pollTimer) return; // Already running — nothing to do

  // Pre-populate _terminalJobs from persisted state so jobs that were already
  // imported before this session started do not re-trigger notifications.
  const { jobs: persistedJobs } = jobService.getLocalJobs();
  for (const j of persistedJobs) {
    if (j._dpofNotified) _terminalJobs.add(String(j.id));
  }
  if (_terminalJobs.size > 0) {
    logger.info('DPOF status polling: pre-seeded terminal jobs from persisted state', { count: _terminalJobs.size });
  }

  _pollTimer = setInterval(() => {
    _pollAwaitingJobs().catch(err => logger.logError('Status polling cycle error', err));
  }, 10000);
  logger.info('DPOF status polling started (10 s interval)');
}

function stopStatusPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    logger.info('DPOF status polling paused — no jobs awaiting import');
  }
}

// ── Auto-Print ────────────────────────────────────────────────────────────────
//
// Scans all jobs in 'received' or 'pending' status and dispatches any that are
// routed to a controller with autoprint: true, provided a valid route exists.
// Called after each job-poll cycle and after any channel mapping is saved.

let _autoPrintWindowManager = null;

let _autoPrintRunning = false;

/**
 * Manual Crop redesign (2026-06-02). Stamp the operator-discarded
 * basename set onto the job as a non-enumerable property so the print
 * pipelines filter it out without needing a signature change. The set
 * is read at every _findJobInManifest call plus _copyFolder + process-
 * folder-service. No-op for jobs without sidecars or without any
 * discarded images.
 *
 * Extracted from jobs:sendToPrint for reuse in the M5 order-level PIC
 * Pro merge dispatch — siblings pulled into a merge group need the
 * same filter applied so their discards don't leak into the shared
 * order.txt.
 */
async function _stampDiscardedImageFilter(job) {
  try {
    const sidecarJobId  = _resolveSidecarJobId(job);
    const jobFolderPath = _resolveJobPath(job);
    if (!sidecarJobId || !jobFolderPath || !fsPromises) return;
    const sidecarPath = path.join(jobFolderPath, `${sidecarJobId}.json`);
    let raw;
    try {
      raw = await fsPromises.readFile(sidecarPath, 'utf8');
    } catch (readErr) {
      if (readErr.code !== 'ENOENT') throw readErr;
      return;
    }
    if (!raw) return;
    const sc = JSON.parse(raw);
    const discardedBasenames = (sc.images || [])
      .filter((img) => img && img.discarded === true && typeof img.filename === 'string')
      .map((img) => img.filename);
    if (discardedBasenames.length === 0) return;
    Object.defineProperty(job, '_excludedFilenames', {
      value:        new Set(discardedBasenames),
      enumerable:   false,
      configurable: true,
    });
    logger.info('[send-to-print] applying discarded-image filter', {
      jobId:          job.id,
      discardedCount: discardedBasenames.length,
    });
  } catch (err) {
    logger.logWarning('[send-to-print] failed to load discarded-image set; proceeding without filter', {
      jobId: job.id,
      error: err.message,
    });
  }
}

/**
 * M5 Manual Process for order-level PIC Pro merge. The operator clicked
 * Process on ONE job in a merge-enabled Fuji PIC Pro order; dispatch
 * that job + every currently-eligible sibling as a single submission.
 *
 * Contract from the brief:
 *   - The clicked job is always included (matches Send-to-Print's
 *     existing hold-gate bypass — the operator explicitly asked).
 *   - Siblings only join if they'd pass the auto-print gates:
 *     received/pending status, not film-dev, has local files, AI
 *     Quality passes (if enabled), computeHoldForReview clears,
 *     controller autoprint doesn't matter (this is a manual click),
 *     route.printCode present.
 *   - Discarded-image filter is stamped on every included job.
 *   - _orderMergeHeldSince is cleared on dispatch success for every
 *     active member so the next late-arriver group starts a fresh clock.
 *
 * autoprint OFF: honour it for SIBLINGS (they wouldn't be caught by
 * auto-print anyway); the clicked job is exempt because the operator's
 * click IS the "print now" signal.
 */
async function _dispatchFujiPicProOrderMerge_Manual(clickedJob, clickedRoute, allJobs) {
  const items = [{ job: clickedJob, route: clickedRoute }];

  const { computeHoldForReview } = require('../shared/holdForReview');
  const routingHeldProcesses = routingService.getRoutingHeldProcesses();

  for (const other of allJobs) {
    if (!other || other.id === clickedJob.id) continue;
    if (other.order_number !== clickedJob.order_number) continue;
    if (other._status !== 'received' && other._status !== 'pending') continue;
    if (other.is_film_development) continue;
    if (other._awaitingManifest) continue;

    const otherRoute = routingService.resolveRoute(other);
    if (!(otherRoute && otherRoute.type === 'controller')) continue;
    if (otherRoute.controllerId !== clickedRoute.controllerId) continue;
    if (!otherRoute.printCode) continue;

    // AI Quality gate on siblings — parity with auto-print. If the
    // sibling is held, it stays behind; the operator can Process it
    // later on its own.
    if (configService.get('aiQualityEnabled')) {
      const local = jobDownloadService.checkLocalFiles(other);
      if (!local.found) continue;
      try {
        const sidecarJobId = _resolveSidecarJobId(other);
        const scoring = await aiJobQualityOrchestrator.scoreJob(sidecarJobId, local.localPath);
        if (scoring.held) continue;
      } catch (err) {
        logger.logError('[send-to-print][merge] sibling scoreJob threw — skipping', err, { jobId: other.id });
        continue;
      }
    }

    // computeHoldForReview WITHOUT orderMergeCheck — the whole point of
    // the manual click is to bypass the "waiting for order" hold, so we
    // must not consult it here. All other reasons (manual-source,
    // routing-hold, batch-threshold) still hold the sibling back.
    const hold = computeHoldForReview(other, { routingHeldProcesses });
    if (hold._holdForReview) continue;

    await _stampDiscardedImageFilter(other);
    items.push({ job: other, route: otherRoute });
  }

  // Clicked job also gets the filter (the caller already did this for
  // the sendToPrint path, but _dispatchFujiPicProOrderMerge_Manual
  // may be invoked from other paths in future — cheap idempotent call).
  await _stampDiscardedImageFilter(clickedJob);

  logger.info('[send-to-print][merge] manual order-level dispatch', {
    orderNumber:  clickedJob.order_number,
    controllerId: clickedRoute.controllerId,
    memberJobIds: items.map(it => it.job.id),
  });

  // Clear stamps up front — the wait is over as soon as we decide to
  // dispatch, regardless of success/failure. Same reasoning as the
  // auto-print pre-pass: an errored member should not keep a "Waiting
  // for order" chip. Also clears the M6 sibling-count stamps.
  for (const it of items) {
    jobService.updateJobLocally(it.job.id, {
      _orderMergeHeldSince:     null,
      _orderMergeTotalCount:    null,
      _orderMergeMissingCount:  null,
      _orderMergeMissingJobIds: null,
    });
  }

  return await printService._sendViaFujiPicProOrderRouted(items);
}

/**
 * M5 (order-level-submission-picpro-brief) — pre-pass for Fuji PIC Pro
 * order-level merging. For every fujipicpro controller with
 * `mergeOrderJobs` on, bucket local jobs by (order_number, controllerId),
 * evaluate per-job eligibility using the same gates the per-job loop
 * uses (awaiting-manifest, AI Quality, computeHoldForReview,
 * autoprint/skipAutoPrint/channel-mapping), then hand each bucket to
 * `evaluateOrderGroup`. If ready, dispatch as one order-level
 * submission and clear `_orderMergeHeldSince` on the members that
 * went out. If not ready, stamp `_orderMergeHeldSince` on eligible
 * members so the wait cap has a start time.
 *
 * The per-job loop in runAutoPrint skips merge-eligible controllers
 * (see the isMergeEligible gate at the dispatch site) so this pre-pass
 * is the ONLY dispatch path for them when the setting is on. With the
 * setting off, this function is a no-op and the per-job loop takes
 * every fujipicpro job unchanged (byte-identical to today).
 *
 * NaN-safe _orderMergeHeldSince: `evaluateOrderGroup` skips the cap
 * check when heldSince is not a finite number — that would make a
 * corrupt stamp wait forever, which the brief explicitly rules out.
 * So any eligible member whose stamp is missing or unparseable is
 * re-stamped to now BEFORE the check, giving the cap a real starting
 * point.
 *
 * Manifest-read failures are logged and the bucket is deferred to the
 * next auto-print pass — safer than guessing sibling counts.
 */
async function _runFujiPicProOrderMergePass(jobs, controllers, cutoff) {
  const mergeControllers = controllers.filter(
    c => c && c.type === 'fujipicpro' && c.mergeOrderJobs === true,
  );
  if (mergeControllers.length === 0) return;   // feature off — no-op path
  const mergeControllerIds = new Set(mergeControllers.map(c => c.id));

  const { evaluateOrderGroup } = require('../shared/orderGrouping');
  const { computeHoldForReview } = require('../shared/holdForReview');

  // ── Bucketing + per-job eligibility ────────────────────────────────────
  // Same gates as the per-job loop, in the same order, so a job's
  // eligibility is identical to what the per-job path would decide —
  // the merge feature must never dispatch a job the per-job path
  // would have held. Do NOT pass `orderMergeCheck` into
  // computeHoldForReview here: that ctx hook exists so downstream
  // callers can SURFACE order-merge-waiting as a hold reason; letting
  // the pre-pass consult it would re-hold every merge-waiting job as
  // ineligible on the next cycle.
  const routingHeldProcesses = routingService.getRoutingHeldProcesses();
  const batchThresholdCheck = (j) => {
    try {
      const r = routingService.resolveRoute(j);
      if (!(r && r.type === 'controller'
          && Number.isFinite(r.maxPrintsPerJob) && r.maxPrintsPerJob > 0)) return null;
      const { readManifestPrintCountSync } = require('./services/manifest-print-count');
      const prints = readManifestPrintCountSync(j);
      if (prints == null) {
        // Fail-safe (2026-08-15): parity with the runAutoPrint gate
        // below. If we can't size the job, it's ineligible for the
        // merge pre-pass — treating it as "no batch reason" here would
        // let it into a bucket the per-job loop would then hold via
        // the same resolver, resulting in a stuck merge decision. Hold
        // it uniformly.
        logger.logWarning('[auto-print][merge] batch cap set but manifest print-count unreadable — holding job', {
          jobId:       j.id,
          jobName:     j.job_name || j.name || '(unnamed)',
          orderNumber: j.order_number,
          cap:         r.maxPrintsPerJob,
        });
        return {
          cap:             r.maxPrintsPerJob,
          prints:          null,
          unsizable:       true,
          autoSendBatches: r.autoSendBatches === true,
        };
      }
      // M2 (2026-08-15): forward autoSendBatches so the per-job
      // eligibility gate matches the dispatch gate (both must agree —
      // an autosendable job is dispatched immediately, not treated as
      // ineligible for the merge-order pre-pass).
      return { cap: r.maxPrintsPerJob, prints, autoSendBatches: r.autoSendBatches === true };
    } catch (err) {
      // Parity with the runAutoPrint gate resolver below. Silent catches
      // hid a MODULE_NOT_FOUND for ~six days in the sibling; the same
      // failure mode here would silently skip the batch gate for merge
      // buckets. Log at ERROR so programmer errors are audible on the
      // first cycle.
      logger.logError('[auto-print][merge] batchThresholdCheck threw — returning null (bucket eligibility may be wrong)', err, {
        jobId: j && j.id,
      });
      return null;
    }
  };

  const buckets = new Map();   // key -> { orderNumber, controllerId, controller, items[], eligibility Map }

  for (const job of jobs) {
    if (job._status !== 'received' && job._status !== 'pending') continue;
    if (job.is_film_development) continue;
    if (job.created_at && new Date(job.created_at) < cutoff) continue;

    const route = routingService.resolveRoute(job);
    if (!(route && route.type === 'controller')) continue;
    if (!mergeControllerIds.has(route.controllerId)) continue;

    const ctrl = mergeControllers.find(c => c.id === route.controllerId);

    // Per-job eligibility — every gate the per-job loop applies before
    // dispatch. Any false → this job is a member but not eligible;
    // group readiness treats it as a blocker.
    let eligible = true;

    if (job._awaitingManifest) eligible = false;

    if (eligible && configService.get('aiQualityEnabled')) {
      const local = jobDownloadService.checkLocalFiles(job);
      if (!local.found) {
        eligible = false;
      } else {
        try {
          const sidecarJobId = _resolveSidecarJobId(job);
          const scoring = await aiJobQualityOrchestrator.scoreJob(sidecarJobId, local.localPath);
          if (scoring.held) eligible = false;
        } catch (err) {
          logger.logError('[ai-quality][merge] scoreJob threw — treating as ineligible', err, { jobId: job.id });
          eligible = false;
        }
      }
    }

    if (eligible) {
      const hold = computeHoldForReview(job, {
        routingHeldProcesses,
        batchThresholdCheck,
      });
      if (hold._holdForReview) eligible = false;
    }

    if (eligible) {
      if (!ctrl || !ctrl.autoprint) eligible = false;
      if (route.skipAutoPrint)       eligible = false;
      if (!route.printCode)          eligible = false;   // no channel mapping
    }

    const key = `${job.order_number}::${route.controllerId}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        orderNumber:  job.order_number,
        controllerId: route.controllerId,
        controller:   ctrl,
        items:        [],
        eligibility:  new Map(),
      });
    }
    const b = buckets.get(key);
    b.items.push({ job, route });
    b.eligibility.set(String(job.id), eligible);
  }

  if (buckets.size === 0) return;

  const NOW    = Date.now();
  const nowIso = new Date(NOW).toISOString();

  for (const bucket of buckets.values()) {
    // Read the order manifest to know every sibling jobId — including
    // ones that route to a different controller (they still block this
    // group's readiness until they have a local record).
    let manifestJobIds = [];
    try {
      const downloadDirectory = configService.get('downloadDirectory');
      if (!downloadDirectory) {
        logger.logWarning('[auto-print][order-merge] downloadDirectory not configured — deferring group', {
          orderNumber: bucket.orderNumber, controllerId: bucket.controllerId,
        });
        continue;
      }
      const orderFolderName = `${bucket.orderNumber}_${bucket.items[0].job.order_id}`;
      const orderFolderPath = path.join(downloadDirectory, orderFolderName);
      const manifest = await printService._readManifest(orderFolderPath, bucket.orderNumber);
      manifestJobIds = (manifest && Array.isArray(manifest.jobs) ? manifest.jobs : [])
        .map(j => j.jobId)
        .filter(id => id != null);
    } catch (readErr) {
      logger.logWarning('[auto-print][order-merge] manifest read failed — deferring group evaluation', {
        orderNumber:  bucket.orderNumber,
        controllerId: bucket.controllerId,
        error:        readErr.message,
      });
      continue;
    }

    // NaN-safe stamp handling. Any eligible member with a missing or
    // unparseable _orderMergeHeldSince gets re-stamped to now; the
    // brief update spells out why (never wait forever). After this
    // loop every eligible member has a finite ms parse.
    const eligibleItems = bucket.items.filter(it => bucket.eligibility.get(String(it.job.id)) === true);
    for (const it of eligibleItems) {
      const raw = it.job._orderMergeHeldSince;
      const ms  = typeof raw === 'string' ? Date.parse(raw) : NaN;
      if (!Number.isFinite(ms)) {
        jobService.updateJobLocally(it.job.id, { _orderMergeHeldSince: nowIso });
        it.job._orderMergeHeldSince = nowIso;   // local mirror for the check below
      }
    }
    // Oldest stamp across eligible members is the group's clock.
    const heldSince = eligibleItems.length > 0
      ? Math.min(...eligibleItems.map(it => Date.parse(it.job._orderMergeHeldSince)))
      : NaN;

    // Cap: minutes → ms. Null/absent/invalid → 30-minute default (per
    // the brief; null is NOT "wait forever"). Same rule the routing
    // read-time coercion applies.
    const rawCap = bucket.controller && bucket.controller.orderMergeWaitMinutes;
    const capMinutes = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 30;
    const capMs = capMinutes * 60 * 1000;

    const result = evaluateOrderGroup({
      manifestJobIds,
      localJobs:    bucket.items.map(it => it.job),
      eligibility:  bucket.eligibility,
      controllerId: bucket.controllerId,
      heldSince,
      nowMs:        NOW,
      capMs,
    });

    if (!result.ready) {
      // Nothing else to do this pass — eligible members carry the
      // stamp so the cap can measure from it, ineligible members
      // stay stamp-free (they're not "waiting for the order" from
      // the operator's viewpoint; they're waiting for their own
      // per-job gate to clear).
      //
      // M6: stamp the sibling-count fields the renderer reads to build
      // "Waiting for order — X of Y jobs" and the tooltip listing
      // outstanding sibling job ids. Total is the manifest sibling
      // count (all jobs in the order per the manifest, regardless of
      // which controller they route to) — matches the operator's
      // mental model of "how many jobs are in this order". Missing is
      // whatever evaluateOrderGroup identified as blocking readiness
      // (ineligible members + manifest ids with no local record).
      // Stamped on ELIGIBLE members only — a member that's ineligible
      // for its own reason (AI Quality, awaiting-manifest, etc.) is
      // not the one waiting for siblings, and its own hold reason
      // already tells the operator what's up with it.
      const totalCount   = manifestJobIds.length;
      const missingCount = result.missingJobIds.length;
      const missingIds   = result.missingJobIds;
      for (const it of eligibleItems) {
        jobService.updateJobLocally(it.job.id, {
          _orderMergeTotalCount:   totalCount,
          _orderMergeMissingCount: missingCount,
          _orderMergeMissingJobIds: missingIds,
        });
      }
      continue;
    }

    // Ready — dispatch.
    const memberSet = new Set(result.memberJobIds.map(String));
    const dispatchItems = bucket.items.filter(it => memberSet.has(String(it.job.id)));

    logger.info('[auto-print][order-merge] dispatching order-level group', {
      orderNumber:  bucket.orderNumber,
      controllerId: bucket.controllerId,
      reason:       result.reason,
      memberJobIds: result.memberJobIds,
      missing:      result.missingJobIds,
      capMinutes,
    });

    // Once we decide to dispatch, the wait is over regardless of the
    // outcome. Clear _orderMergeHeldSince AND the M6 sibling-count
    // stamps on every dispatched item up front — this covers both the
    // success path (member goes to in_production / completed) and the
    // failure paths (member is errored inside
    // _sendViaFujiPicProOrderRouted). Leaving the stamps on an errored
    // member would keep it showing "Waiting for order" in the Jobs
    // grid even though it's not waiting for anything.
    for (const it of dispatchItems) {
      jobService.updateJobLocally(it.job.id, {
        _orderMergeHeldSince:     null,
        _orderMergeTotalCount:    null,
        _orderMergeMissingCount:  null,
        _orderMergeMissingJobIds: null,
      });
    }

    let dispatchResult;
    try {
      dispatchResult = await printService._sendViaFujiPicProOrderRouted(dispatchItems);
    } catch (dispatchErr) {
      logger.logError('[auto-print][order-merge] dispatch threw', dispatchErr, {
        orderNumber:  bucket.orderNumber,
        controllerId: bucket.controllerId,
        memberJobIds: result.memberJobIds,
      });
      // The method already errors its members via _markGroupErrored,
      // but if the throw is BEFORE that (e.g. downloadDirectory not
      // set), fall back to stamping errored ourselves.
      for (const it of dispatchItems) {
        jobService.updateJobLocally(it.job.id, {
          _status:       'error',
          _errorMessage: dispatchErr.message || 'Order-level dispatch threw',
        });
      }
      continue;
    }

    if (dispatchResult && dispatchResult.success
        && result.reason === 'cap-expired' && result.missingJobIds.length > 0) {
      // A silent partial dispatch is the failure mode most likely to
      // be blamed on the printer. Warn loudly with both halves so the
      // audit log carries what went and what did not.
      logger.logWarning('[auto-print][order-merge] cap expired — partial dispatch, stragglers will follow separately', {
        orderNumber:     bucket.orderNumber,
        controllerId:    bucket.controllerId,
        capMinutes,
        dispatched:      dispatchResult.activeJobIds,
        stragglerJobIds: result.missingJobIds,
      });
    }

    if (_autoPrintWindowManager) {
      const mainWindow = _autoPrintWindowManager.getWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
      }
    }
  }
}

async function runAutoPrint() {
  if (_autoPrintRunning) return;
  _autoPrintRunning = true;
  try {
    const { jobs } = jobService.getLocalJobs();
    const controllers = routingService.getControllers();

    const daysBack = configService.get('jobDateRange') ?? 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);

    // M5 order-level PIC Pro merging pre-pass. No-op when no controller
    // has mergeOrderJobs on — the byte-identical-when-off contract.
    // Runs BEFORE the per-job loop so any dispatch or stamp writes
    // land in the jobs cache before the per-job loop re-fetches
    // (via the skip check that reads route.controllerId).
    await _runFujiPicProOrderMergePass(jobs, controllers, cutoff);

    // Re-fetch after the pre-pass so the per-job loop sees any
    // _orderMergeHeldSince / _status updates the pre-pass made.
    const jobsAfterMergePass = jobService.getLocalJobs().jobs;
    const mergeControllerIds = new Set(
      controllers.filter(c => c && c.type === 'fujipicpro' && c.mergeOrderJobs === true).map(c => c.id),
    );

    for (const job of jobsAfterMergePass) {
      if (job._status !== 'received' && job._status !== 'pending') continue;
      // Belt-and-braces: film-dev jobs are already filtered out by
      // getLocalJobs, but a future direct caller (or a stale in-memory
      // list) could bypass that. Auto-print must NEVER route a film-dev
      // job — they have no artwork, no controller mapping, and no
      // print destination.
      if (job.is_film_development) continue;
      if (job.created_at && new Date(job.created_at) < cutoff) continue;

      // Awaiting-manifest gate. Files have arrived but the .json manifest
      // hasn't yet; polling-service is tracking the wait + bounded escalation.
      // Skipping here keeps dispatch from throwing "Order manifest not found"
      // and entering the sticky-error path before the manifest has a chance
      // to land. The flag is cleared by polling-service when the manifest
      // appears OR by the timeout escalation path.
      if (job._awaitingManifest) continue;

      // AI Quality Gate (v1.2.0) — score the job before dispatching. If
      // any image fails the threshold, the job is held this pass.
      // Operator releases via the Quality flag on the Jobs grid (M2).
      // Flag-OFF behaviour: this whole block is skipped, byte-identical
      // to pre-feature behaviour.
      //
      // Ordering note (2026-05-24): this block runs BEFORE the S3-channel
      // manual-review hold gate below. AI scoring is a per-image quality
      // signal that needs to populate the sidecar (and the per-image
      // chip / Review tab) for EVERY job that has files on disk, including
      // manual-source jobs that the M2 hold gate will skip from dispatch.
      // An earlier placement of the M2 gate ahead of this block caused
      // "AI scoring…" to stick in the UI indefinitely for held jobs —
      // see CHANGELOG Unreleased / Fix 1.
      if (configService.get('aiQualityEnabled')) {
        const local = jobDownloadService.checkLocalFiles(job);
        if (!local.found) {
          // Files not local yet — the next autoprint cycle will pick this
          // job up after download completes. Don't dispatch unscored work.
          continue;
        }
        try {
          // See _resolveSidecarJobId — sidecars are composite-keyed.
          const sidecarJobId = _resolveSidecarJobId(job);
          const scoring = await aiJobQualityOrchestrator.scoreJob(sidecarJobId, local.localPath);
          if (scoring.held) {
            logger.info('[auto-print] job held by AI Quality Gate', {
              jobId: job.id,
              summary: scoring.summary,
            });
            // Push the held state to the renderer so the Jobs grid badge
            // refreshes without waiting for the next polling tick.
            if (_autoPrintWindowManager) {
              const mainWindow = _autoPrintWindowManager.getWindow();
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('aiQuality:jobHeld', {
                  jobId: job.id,
                  summary: scoring.summary,
                });
              }
            }
            continue;
          }
        } catch (err) {
          logger.logError('[ai-quality] scoreJob threw — passing through', err, { jobId: job.id });
        }
      }

      // Route resolution moved earlier (from the original position below
      // computeHoldForReview) so the stale-stamp clear + orderMergeCheck
      // can consult it. Cheap — resolveRoute is memoised on the routing
      // decision tree, not an fs call.
      const route = routingService.resolveRoute(job);
      const isOnMergeEnabledCtrl = !!(route && route.type === 'controller'
        && mergeControllerIds.has(route.controllerId));

      // M5 fix: clear a stale _orderMergeHeldSince if the job is no
      // longer routing to a merge-enabled controller. Without this,
      // disabling mergeOrderJobs on a controller strands every job
      // stamped during the prior enabled period — the stamp holds it
      // via order-merge-waiting, the per-job loop skips it, and it
      // never dispatches until the operator manually clears the field.
      // Also covers a job whose route changed to a different controller
      // (e.g. reprocess mapping) that isn't merge-enabled.
      //
      // M6: also clear the sibling-count stamps so the "Waiting for
      // order — X of Y jobs" chip goes with them.
      if (job._orderMergeHeldSince && !isOnMergeEnabledCtrl) {
        jobService.updateJobLocally(job.id, {
          _orderMergeHeldSince:     null,
          _orderMergeTotalCount:    null,
          _orderMergeMissingCount:  null,
          _orderMergeMissingJobIds: null,
        });
        job._orderMergeHeldSince = null;   // local mirror for the check below
      }

      // S3 Artwork Channel M2 (2026-05-24): per-job manual-review hold.
      // Derive fresh from artwork_source + artwork_files instead of trusting
      // the pre-set `_holdForReview` on the job object. job-service does set
      // the field in _mapApiJob and _mergeJobs, but jobs that pre-date the
      // M2 schema in the persistent cache (jobs-cache.json) can come through
      // missing the field — surfaced by POS-5MAMUF retest 2026-05-24 where
      // legacy-cached manual jobs got dispatched. Re-deriving here is cheap,
      // idempotent, and guarantees the gate's correctness regardless of
      // cache state. See src/shared/holdForReview.js for the rule.
      //
      // Skips AUTO dispatch only; operator Send-to-Print is unaffected.
      // Runs AFTER the AI Quality block above so held jobs still get
      // scored (so the per-image chips populate); only the dispatch is
      // skipped.
      const { computeHoldForReview } = require('../shared/holdForReview');
      const hold = computeHoldForReview(job, {
        routingHeldProcesses: routingService.getRoutingHeldProcesses(),
        // M3 batch-splitting hold. Reads the manifest FRESH per job per
        // cycle — no _totalPrintCount cache. runAutoPrint is the last gate
        // before dispatch, so correctness matters more than the SMB read
        // cost (one small-file read per eligible job per 60s cycle). The
        // awaiting-manifest gate above guarantees the manifest is on
        // disk by the time we get here; if the read STILL fails past
        // that gate (parse error, permission race, jobId not found in
        // manifest, transient EBUSY on SMB), the resolver returns the
        // `unsizable: true` sentinel so holdForReview HOLDS the job
        // rather than dispatching a size-unknown Darkroom Pro job past
        // the cap. Fail-safe fix (2026-08-15): the previous return of
        // `null` here fell open and the job dispatched, disagreeing
        // with the Jobs-grid chip (which reads the stamped cache).
        batchThresholdCheck: (j) => {
          try {
            const r = routingService.resolveRoute(j);
            if (!(r && r.type === 'controller'
                && Number.isFinite(r.maxPrintsPerJob) && r.maxPrintsPerJob > 0)) return null;
            // Path fix (2026-08-15): was `../services/manifest-print-count`,
            // which resolved to src/services/manifest-print-count (nonexistent)
            // and threw MODULE_NOT_FOUND every cycle since M3 shipped in
            // v1.10.0. The pre-fix catch below silently returned null, so the
            // over-batch-threshold reason never fired in production and every
            // over-cap Darkroom Pro job dispatched unheld. All 31 other
            // require() sites in this file use the correct `./services/…`
            // prefix — this was the odd one out.
            const { readManifestPrintCountSync } = require('./services/manifest-print-count');
            const prints = readManifestPrintCountSync(j);
            if (prints == null) {
              logger.logWarning('[auto-print] batch cap set but manifest print-count unreadable — holding job', {
                jobId:       j.id,
                jobName:     j.job_name || j.name || '(unnamed)',
                orderNumber: j.order_number,
                cap:         r.maxPrintsPerJob,
              });
              return {
                cap:             r.maxPrintsPerJob,
                prints:          null,
                unsizable:       true,
                autoSendBatches: r.autoSendBatches === true,
              };
            }
            // M2 (2026-08-15): autoSendBatches suppresses the hold so
            // this dispatch gate lets the job through and the existing
            // splitter writes _1.txt, _2.txt… unchanged. Strict === true
            // so a malformed stored value defaults to feature-off.
            return { cap: r.maxPrintsPerJob, prints, autoSendBatches: r.autoSendBatches === true };
          } catch (err) {
            // Do NOT swallow silently. The pre-fix catch here masked the
            // MODULE_NOT_FOUND above for ~six days in production. Anything
            // that lands here is either a programmer error (bad require
            // path, undefined method on a stubbed service) or an
            // unexpected runtime failure — both classes are worth an
            // ERROR log so the next occurrence is audible on the first
            // cycle. Return null to preserve the caller contract (feature
            // off when we can't evaluate); the log makes the silence
            // visible.
            logger.logError('[auto-print] batchThresholdCheck threw — returning null (job may dispatch unheld)', err, {
              jobId: j && j.id,
            });
            return null;
          }
        },
        // M5 order-merge-waiting: a stamped _orderMergeHeldSince means
        // the pre-pass decided this job is waiting for siblings on a
        // merge-enabled PIC Pro controller. Gated on the current
        // controller state (isOnMergeEnabledCtrl) so a stale stamp from
        // a period when the setting was on can't hold the job — the
        // stale-stamp branch above will also have cleared it, this
        // check is defence-in-depth.
        orderMergeCheck: (j) => !!(j && j._orderMergeHeldSince) && isOnMergeEnabledCtrl,
      });
      if (hold._holdForReview) {
        logger.info('[auto-print] job held for review', {
          jobId:   job.id,
          reasons: hold._holdReasons,
        });
        continue;
      }

      // M5: hard-skip merge-eligible fujipicpro controllers here as a
      // belt-and-braces guard against the pre-pass deferring a bucket
      // (e.g. manifest read failed). Without this, a merge-enabled job
      // with no _orderMergeHeldSince stamp would fall through to
      // sendViaDPOFRouted below and get dispatched as a SINGLE-job PIC
      // Pro submission — violating the "when on, every submission is
      // identified by the order number" contract. The pre-pass owns
      // the ONLY dispatch path for these controllers.
      if (isOnMergeEnabledCtrl) {
        continue;
      }

      // --- NEW: default-folder / process-folder dispatch ---
      if (route.type === 'default-folder' || route.type === 'process-folder') {
        const labelName = route.type === 'default-folder' ? 'Default Folder' : 'Process Folder';
        let result;
        try {
          result = await printService._sendViaFolderCopyRouted(job, {
            outputPath:     route.folderPath,
            controllerName: labelName,
          });
        } catch (err) {
          // Manifest missing at dispatch (re-push blip outlasting the
          // _readManifest retry) — re-arm the awaiting-manifest wait instead
          // of going terminal, so polling-service self-heals or escalates.
          const reArm = awaitingReArmUpdates(job, err);
          if (reArm) {
            jobService.updateJobLocally(job.id, reArm);
            logger.logWarning('[auto-print] Folder copy: manifest missing — re-armed as awaiting', { jobId: job.id, manifestPath: err.manifestPath });
            continue;
          }
          logger.logError('[auto-print] Folder copy failed for job ' + job.id, err, { jobId: job.id });
          jobService.updateJobLocally(job.id, {
            _status: 'error',
            _errorMessage: err.message || 'Folder copy failed',
          });
          continue;
        }
        if (result.success) {
          logger.info(`[auto-print] No controller for process "${job.process}" — copied to ${labelName}: ${route.folderPath}`, { jobId: job.id });
          if (_autoPrintWindowManager) {
            const mainWindow = _autoPrintWindowManager.getWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
            }
          }
        } else {
          logger.logError('[auto-print] Folder copy returned failure for job ' + job.id, null, { jobId: job.id, error: result.error });
          jobService.updateJobLocally(job.id, {
            _status: 'error',
            _errorMessage: result.error || 'Folder copy returned failure',
          });
        }
        continue;
      }
      // --- END NEW ---

      if (route.type !== 'controller') continue; // unrouted — skip silently

      const ctrl = controllers.find(c => c.id === route.controllerId);
      if (!ctrl || !ctrl.autoprint) continue;

      // Channel number is only required for DPOF controllers (noritsu, epson,
      // or legacy untyped controllers). Other controller types (folder_copy,
      // pdf_copy, darkroompro, frontline) don't have channel mappings and
      // route via their own dispatch paths.
      //
      // Latent regression note (v1.3.2): the previous gate
      // `(ctrl.type || 'dpof') !== 'folder_copy'` misclassified every
      // non-folder_copy controller as DPOF, silently skipping
      // darkroompro/pdf_copy/frontline jobs whose channelNumber is null.
      // Surfaced when yesterday's autoprint pivot routed darkroompro through
      // this loop for the first time (previously bypassed via direct
      // sendToPrint at renderer).
      // DPOF_TYPES imported from services/controller-types — single source
      // of truth shared with print-service.sendReprint's dispatch switch.
      const isDpofCtrl = DPOF_TYPES.has(ctrl.type) || !ctrl.type;
      if (isDpofCtrl && !route.channelNumber) continue;

      // Channel-level opt-out — skip without logging an error
      if (route.skipAutoPrint) {
        logger.info('[auto-print] Skipping job — channel marked skip auto-print', { jobId: job.id, controller: ctrl.name });
        continue;
      }

      logger.info('[auto-print] Dispatching job', { jobId: job.id, controller: ctrl.name });

      let result;
      try {
        result = await printService.sendViaDPOFRouted(job, route);
      } catch (err) {
        // Manifest missing at dispatch (a re-push blip that outlasted the
        // _readManifest retry budget) is NOT terminal — re-arm the
        // awaiting-manifest wait so the next poll re-checks and either
        // markReceived's it or escalates after awaitingManifestTimeoutMs.
        // This is the one case that must NOT enter the sticky-error path,
        // because the manifest typically reappears within seconds.
        const reArm = awaitingReArmUpdates(job, err);
        if (reArm) {
          jobService.updateJobLocally(job.id, reArm);
          logger.logWarning('[auto-print] Dispatch: manifest missing — re-armed as awaiting', { jobId: job.id, manifestPath: err.manifestPath });
          continue;
        }
        // Generalized in v1.3.2 — the previous manifest-only special case
        // was added to break a retry loop on that specific error, but every
        // other dispatch error class still retry-looped. The eligibility
        // filter at line 1704 excludes jobs in _status: 'error' from future
        // cycles, so propagating the error message AND setting status to
        // 'error' breaks the retry loop for ALL error classes consistently.
        //
        // M8 (missing-print-size-recovery) adds the operator escape hatch
        // that was missing: `ohd:job:retry` resets _status back to
        // 'received' so the next cycle picks the job up. Do NOT switch
        // auto-print to reset _status itself — the sticky behaviour is
        // deliberate and load-bearing, and an operator-initiated reset
        // is the correct point to signal "the config is fixed now".
        logger.logError('[auto-print] Dispatch failed', err, { jobId: job.id });
        jobService.updateJobLocally(job.id, {
          _status: 'error',
          _errorMessage: err.message || 'Dispatch failed',
        });
        continue;
      }

      if (!result.success) {
        logger.logError('[auto-print] Dispatch returned failure', null, {
          jobId: job.id,
          error: result.error,
        });
        jobService.updateJobLocally(job.id, {
          _status: 'error',
          _errorMessage: result.error || 'Dispatch returned failure',
        });
        continue;
      }

      logger.info('[auto-print] Job dispatched successfully', { jobId: job.id, method: result.method });

      // Re-arm DPOF status polling if a DPOF job was just sent
      if (result.method === 'dpof') {
        startStatusPolling(_autoPrintWindowManager);
      }

      // Push updated job list to renderer
      if (_autoPrintWindowManager) {
        const mainWindow = _autoPrintWindowManager.getWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', jobService.getLocalJobs());
        }
      }
    }
  } catch (err) {
    logger.logError('[auto-print] runAutoPrint error', err);
  } finally {
    _autoPrintRunning = false;
  }
}

/**
 * Test API connection by hitting the health endpoint
 * GET {baseUrl} returns { success: true, name: "OrderHub Downloader API", version: "1.0.0", ... }
 */
function testApiConnection(baseUrl, apiKey) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(baseUrl);
      const protocol = urlObj.protocol === 'https:' ? https : http;

      const extraHeaders = {};
      const config = configService.getAll();
      if (config.organizationId) extraHeaders['X-Organization-ID'] = config.organizationId;
      if (config.locationId) extraHeaders['X-Location-ID'] = config.locationId;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
          ...extraHeaders
        },
        timeout: 10000
      };

      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = JSON.parse(data);
              if (json.success) {
                resolve({ success: true, version: json.version || '' });
              } else {
                resolve({ success: false, error: json.error || 'Unknown error' });
              }
            } catch (e) {
              resolve({ success: true }); // 2xx but non-JSON is still OK
            }
          } else if (res.statusCode === 401) {
            resolve({ success: false, error: 'Invalid API key' });
          } else {
            resolve({
              success: false,
              error: `HTTP ${res.statusCode}: ${res.statusMessage}`
            });
          }
        });
      });

      req.on('error', (error) => {
        resolve({ success: false, error: error.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Connection timeout' });
      });

      req.end();
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });
}

/**
 * Build a Map<filename, quantity> from the order manifest JSON for a given job.
 *
 * Used by ohd:job:load so that first-time sidecar creation uses the ordered
 * quantity from the manifest rather than defaulting to 1.
 *
 * Path derivation:
 *   jobId      = "{orderNumber}_{apiJobId}"   e.g. "PXDEMO-DR2PE0_38334718"
 *   jobPath    = "{downloadDir}/{orderFolder}/{jobFolder}"
 *   orderDir   = path.dirname(jobPath)
 *   manifest   = "{orderDir}/{orderNumber}.json"
 *
 * Returns an empty Map on any error (missing manifest, parse failure, etc.)
 * so that callers fall back gracefully to qty = 1.
 *
 * @param {string} jobId   - Sidecar job ID, format "{orderNumber}_{apiJobId}"
 * @param {string} jobPath - Absolute path to the job's root folder
 * @returns {Promise<Map<string, number>>}
 */
async function _buildManifestQuantityMap(jobId, jobPath) {
  // Legacy thin wrapper — preserved so any external caller that only wanted
  // qtys keeps working. Internal callers should use _buildManifestImageMetaMap
  // and read .qty from the per-filename meta record.
  const meta = await _buildManifestImageMetaMap(jobId, jobPath);
  const out = new Map();
  for (const [name, m] of meta.entries()) {
    if (Number.isFinite(m.qty) && m.qty > 0) out.set(name, m.qty);
  }
  return out;
}

/**
 * Parse the order manifest and return a Map keyed by the printable JPEG
 * basename → { qty, originalFilename }.
 *
 *   qty               number  ordered quantity from manifest (1 fallback)
 *   originalFilename  string  manifest-relative path to the uncropped
 *                             customer upload, e.g.
 *                             "PXDEMO-AD31D5_38432891/original-files/1-IMG-….jpg"
 *                             or null when the manifest doesn't carry one
 *                             (non-Pixfizz orders, pre-feature manifests).
 *
 * Path stays manifest-relative on purpose — OHD resolves to absolute via
 *   path.join(path.dirname(jobPath), originalFilename)
 * at the point of use, so a future Pixfizz Core change to the folder
 * layout (e.g. renaming "original-files/") is transparent to OHD.
 *
 * Returns an empty Map on any error (missing manifest, parse failure, etc.)
 * so callers fall back gracefully — first-time sidecar creation still uses
 * qty=1 / originalFilename=null when the manifest can't be read.
 *
 * @param {string} jobId   - Sidecar job ID, format "{orderNumber}_{apiJobId}"
 * @param {string} jobPath - Absolute path to the job's root folder
 * @returns {Promise<Map<string, { qty: number, originalFilename: string|null }>>}
 */
async function _buildManifestImageMetaMap(jobId, jobPath) {
  try {
    const sep          = jobId.lastIndexOf('_');
    if (sep === -1) return new Map();

    const orderNumber  = jobId.substring(0, sep);
    const apiJobId     = jobId.substring(sep + 1);
    const orderDir     = path.dirname(jobPath);
    const manifestPath = path.join(orderDir, `${orderNumber}.json`);

    const raw      = await fsPromises.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    // Locate the matching job entry in the manifest
    const jobEntry = (manifest.jobs || []).find(j => String(j.jobId) === apiJobId);
    if (!jobEntry) return new Map();

    // Build basename → { qty, originalFilename } map
    const map = new Map();
    for (const img of (jobEntry.images || [])) {
      const basename = path.basename(img.filename);
      if (!basename) continue;
      const qtyNum   = Number(img.quantity);
      const qty      = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1;
      const original = (typeof img.originalFilename === 'string' && img.originalFilename)
        ? img.originalFilename
        : null;
      map.set(basename, { qty, originalFilename: original });
    }
    return map;
  } catch {
    // Manifest not found, not readable, or not valid JSON — proceed without quantities
    return new Map();
  }
}

// ── Dismissed jobs ──
ipcMain.handle('store:getDismissedJobs', () => {
  return configService.get('dismissedJobs') || [];
});

ipcMain.handle('store:dismissJob', (event, jobId) => {
  const dismissed = configService.get('dismissedJobs') || [];
  const strId = String(jobId);
  if (!dismissed.includes(strId)) {
    dismissed.push(strId);
    configService.set('dismissedJobs', dismissed);
  }
  return dismissed;
});

ipcMain.handle('store:undismissJob', (event, jobId) => {
  const dismissed = configService.get('dismissedJobs') || [];
  const updated = dismissed.filter(id => id !== String(jobId));
  configService.set('dismissedJobs', updated);
  return updated;
});

// ── Job date range ──
ipcMain.handle('store:getJobDateRange', () => {
  return configService.get('jobDateRange') ?? 30;
});

ipcMain.handle('store:setJobDateRange', (event, days) => {
  configService.set('jobDateRange', Number(days));
  return Number(days);
});

// ── Film Review panel (PW-007 Phase 1 — Milestone 4) ──
//
// IPC contract lives under the `ohd:filmReview:*` namespace. Queries are
// read-only summaries for the renderer; commands mutate the metadata store
// and return the updated record so the renderer can optimistically patch
// its local state. Tweaks persist to a dedicated electron-store, so a
// density/theme change never races with config.json writes.
//
// Paired event: `ohd:filmReview:roll-processed` is emitted by
// folder-watch-service when Mode 2 finishes a roll — NOT from here.

// Queries
ipcMain.handle('ohd:filmReview:list-rolls', () => {
  try {
    return frameMetadataStore.listRollsWithSummary();
  } catch (err) {
    logger.logError('[filmReview] list-rolls failed', err);
    return [];
  }
});

ipcMain.handle('ohd:filmReview:get-roll', (event, rollId) => {
  try {
    return frameMetadataStore.getRollWithFrames(rollId);
  } catch (err) {
    logger.logError('[filmReview] get-roll failed', err);
    return null;
  }
});

ipcMain.handle('ohd:filmReview:get-frame', (event, frameId) => {
  try {
    return frameMetadataStore.get(frameId);
  } catch (err) {
    logger.logError('[filmReview] get-frame failed', err);
    return null;
  }
});

// Renderer cannot load arbitrary absolute paths via <img src="file://...">
// under the default Electron security config. This handler returns a
// file:// URL that the renderer's <img> tag will resolve via the
// app's custom protocol / fs allowances. If the frame has no thumbnail
// (very old records from before Milestone 4, or a thumbnail that failed
// to generate), we return null so the UI can show a placeholder.
ipcMain.handle('ohd:filmReview:get-thumbnail', (event, frameId) => {
  try {
    const rec = frameMetadataStore.get(frameId);
    if (!rec || !rec.thumbnailPath) return null;
    // Normalise Windows backslashes for file:// URLs.
    const urlPath = rec.thumbnailPath.replace(/\\/g, '/');
    return `file:///${urlPath.replace(/^\/+/, '')}`;
  } catch (err) {
    logger.logError('[filmReview] get-thumbnail failed', err);
    return null;
  }
});

// Commands
ipcMain.handle('ohd:filmReview:flag-frame', (event, payload) => {
  try {
    const { frameId, flag } = payload || {};
    return frameMetadataStore.appendFlag(frameId, flag);
  } catch (err) {
    logger.logError('[filmReview] flag-frame failed', err);
    return null;
  }
});

ipcMain.handle('ohd:filmReview:unflag-frame', (event, payload) => {
  try {
    const { frameId, flagIndex } = payload || {};
    return frameMetadataStore.removeFlag(frameId, flagIndex);
  } catch (err) {
    logger.logError('[filmReview] unflag-frame failed', err);
    return null;
  }
});

ipcMain.handle('ohd:filmReview:mark-roll-reviewed', (event, rollId) => {
  try {
    return frameMetadataStore.markRollReviewed(rollId);
  } catch (err) {
    logger.logError('[filmReview] mark-roll-reviewed failed', err);
    return 0;
  }
});

// Open the roll's source folder in the OS file browser. We derive the
// folder path from the first frame's originalPath rather than storing it
// on the roll record — Mode 2 pipelines can move files around, so the
// record is the source of truth.
ipcMain.handle('ohd:filmReview:open-folder', (event, rollId) => {
  try {
    const frames = frameMetadataStore.listByRoll(rollId);
    if (!frames.length || !frames[0].originalPath) return false;
    const folderPath = path.dirname(frames[0].originalPath);
    // shell.openPath returns a Promise<string>; empty string on success.
    return shell.openPath(folderPath).then((errMsg) => !errMsg);
  } catch (err) {
    logger.logError('[filmReview] open-folder failed', err);
    return false;
  }
});

// Tweaks (persistent UI preferences — density, theme, kbd-hint visibility)
ipcMain.handle('ohd:filmReview:get-tweaks', () => {
  try {
    return filmReviewPrefsStore.getAll();
  } catch (err) {
    logger.logError('[filmReview] get-tweaks failed', err);
    return null;
  }
});

ipcMain.handle('ohd:filmReview:set-tweak', (event, payload) => {
  try {
    const { key, value } = payload || {};
    return filmReviewPrefsStore.set(key, value);
  } catch (err) {
    logger.logError('[filmReview] set-tweak failed', err);
    return false;
  }
});

// App-wide theme (light | dark). Drives the body.app-theme-dark class swap
// in the renderer; both Job Review and Film Review pick up the resulting
// --app-* token overrides automatically.
ipcMain.handle('ohd:app:get-theme', () => {
  try {
    return appPrefsStore.get('theme');
  } catch (err) {
    logger.logError('[app] get-theme failed', err);
    return 'light';
  }
});

ipcMain.handle('ohd:app:set-theme', (event, value) => {
  try {
    return appPrefsStore.set('theme', value);
  } catch (err) {
    logger.logError('[app] set-theme failed', err);
    return false;
  }
});

/**
 * Manual rotation (Milestone 4e): apply a 90° increment to the TIFF on disk,
 * regenerate the 512px thumbnail, and persist the cumulative operator rotation
 * on the frame record. Auto-creates (or updates in place) a rotation-type flag
 * so the rotate buttons double as training-data capture — every manual rotate
 * is a labelled "the correct orientation is X°" example.
 *
 * Mirrors folder-watch-service Step 2a.5 for file IO: sharp → .rot.tmp →
 * renameSync → regenerate thumb. Valid deltas: 90, -90, 180.
 *
 * Training-data semantics:
 *   rotation.predictedAngle    — what the model said for the ORIGINAL scan
 *   rotation.applied           — true if the model rotated the file on disk
 *   rotation.operatorRotation  — cumulative operator rotation on TOP of that
 *   operatorFlags[*].correctRotation — same as operatorRotation (convenience copy)
 *
 *   Ground-truth-from-original (for retraining) =
 *     rotation.applied
 *       ? (predictedAngle + operatorRotation) mod 360
 *       :  operatorRotation
 */
ipcMain.handle('ohd:filmReview:rotate-frame', async (event, payload) => {
  try {
    const { frameId, delta } = payload || {};
    if (!frameId) return null;
    const VALID_DELTAS = [90, -90, 180];
    if (!VALID_DELTAS.includes(delta)) return null;

    const rec = frameMetadataStore.get(frameId);
    if (!rec || !rec.originalPath) return null;

    const imagePath = rec.originalPath;
    if (!fs.existsSync(imagePath)) {
      logger.logError(`[filmReview] rotate-frame: source image missing at ${imagePath}`);
      return null;
    }

    const sharp = require('sharp');
    const ext = path.extname(imagePath).toLowerCase();
    const isTiff = ext === '.tif' || ext === '.tiff';
    const tmpPath = imagePath + '.rot.tmp';

    // Step 1: rotate the original in place. TIF: lossless LZW + horizontal
    // predictor (matches folder-watch). JPG: q90 re-encode (lossy but acceptable
    // — operators rarely rotate the same JPG more than once or twice).
    try {
      const pipeline = sharp(imagePath, { limitInputPixels: false, failOn: 'none' }).rotate(delta);
      if (isTiff) {
        await pipeline.tiff({ compression: 'lzw', predictor: 'horizontal' }).toFile(tmpPath);
      } else {
        await pipeline.jpeg({ quality: 90 }).toFile(tmpPath);
      }
      // Retry rename — same EPERM race as folder-watch's auto rotation.
      // Sharp/AV/explorer can hold a brief handle on the destination on
      // Windows + SMB shares; backoff handles it.
      await renameWithRetry(tmpPath, imagePath);
    } catch (rotErr) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* ignored */ }
      logger.logError('[filmReview] rotate-frame: sharp rotation failed', rotErr);
      return null;
    }

    // Step 1b (TIF only): keep the sibling JPG in sync. The folder-watch
    // pipeline writes a `<basename>.jpg` next to every TIF (Step 2b) and
    // S3 upload takes both. If we don't re-encode the JPG here, the TIF
    // would be uploaded rotated but the JPG would still be stale — and
    // the customer-facing gallery uses the JPG. Best-effort: failure is
    // logged but the rotation still counts.
    if (isTiff) {
      const siblingJpg = path.join(
        path.dirname(imagePath),
        path.basename(imagePath, path.extname(imagePath)) + '.jpg'
      );
      try {
        await sharp(imagePath, { limitInputPixels: false, failOn: 'none' })
          .jpeg({ quality: 90 })
          .toFile(siblingJpg);
      } catch (jpgErr) {
        logger.logError(`[filmReview] rotate-frame: sibling JPG re-encode failed for ${siblingJpg}`, jpgErr);
      }
    }

    // Step 2: regenerate the 512px thumbnail so the grid + FocusedFrame reflect
    // the new orientation immediately. Non-fatal if it fails — the UI can
    // still show the (now-stale) previous thumbnail and a manual refresh fixes.
    if (rec.thumbnailPath) {
      try {
        await sharp(imagePath, { limitInputPixels: false, failOn: 'none' })
          .resize(512, null, { withoutEnlargement: true, fit: 'inside' })
          .jpeg({ quality: 85 })
          .toFile(rec.thumbnailPath);
      } catch (thumbErr) {
        logger.logError('[filmReview] rotate-frame: thumbnail regen failed', thumbErr);
      }
    }

    // Step 3: update cumulative operator rotation, mod 360. JavaScript % can
    // return negatives; double-mod normalises.
    const prevOp = (rec.rotation && typeof rec.rotation.operatorRotation === 'number')
      ? rec.rotation.operatorRotation
      : 0;
    const nextOp = (((prevOp + delta) % 360) + 360) % 360;

    const nextRotation = {
      ...(rec.rotation || {}),
      operatorRotation: nextOp,
      operatorRotationAt: new Date().toISOString(),
    };

    // Step 4: upsert the auto-generated rotation flag. Marker `__auto: true`
    // lets us find-and-update rather than spamming a new flag on every tap.
    // Manual flags (type 'rotation' without __auto) are left alone.
    const flags = Array.isArray(rec.operatorFlags) ? [...rec.operatorFlags] : [];
    const autoIdx = flags.findIndex((f) => f && f.type === 'rotation' && f.__auto === true);
    const stamp = new Date().toISOString();
    const autoFlag = {
      type: 'rotation',
      note: null,
      correctRotation: nextOp,
      flaggedAt: stamp,
      __auto: true,
    };
    if (autoIdx >= 0) flags[autoIdx] = autoFlag;
    else              flags.push(autoFlag);

    const updated = frameMetadataStore.update(frameId, {
      rotation: nextRotation,
      operatorFlags: flags,
    });

    logger.info(`[filmReview] rotate-frame: ${frameId} delta=${delta} cumulative=${nextOp}`);
    return updated;
  } catch (err) {
    logger.logError('[filmReview] rotate-frame failed', err);
    return null;
  }
});

/**
 * Permanently delete a single frame from a roll that has NOT been uploaded.
 *
 * Use case: the scanner's first few frames are leader/blank scans the operator
 * drops before upload. Removes EVERY on-disk copy of that frame — the image in
 * storage plus its sibling format (TIFF ⇄ JPEG) and its thumbnail — and the
 * metadata record, so the frame never reaches S3 or the gallery. Hard delete,
 * no recycle. Refused once the roll is uploaded / uploading (the gallery is
 * already built from what was sent).
 *
 * Returns { ok:true, rollId, removedCount } or { ok:false, error }.
 */
ipcMain.handle('ohd:filmReview:delete-frame', async (event, frameIdRaw) => {
  const frameId = typeof frameIdRaw === 'string' ? frameIdRaw : (frameIdRaw && frameIdRaw.frameId);
  try {
    if (!frameId) return { ok: false, error: 'frameId is required' };

    const rec = frameMetadataStore.get(frameId);
    if (!rec) return { ok: false, error: 'Frame not found' };
    const rollId = rec.rollId;

    // Gate: never delete from an uploaded / in-flight roll.
    const roll = frameMetadataStore.getRoll(rollId);
    const us = roll && roll.uploadStatus;
    if (us === 'uploaded' || us === 'uploading') {
      return { ok: false, error: 'This roll has already been uploaded — frames can only be deleted before upload.' };
    }

    // Remove every on-disk copy of this frame: the image in any format and its
    // thumbnail. Best-effort per file; a missing file isn't an error.
    const removed = [];
    const tryUnlink = (p) => {
      try {
        if (p && fs.existsSync(p)) { fs.unlinkSync(p); removed.push(p); }
      } catch (err) {
        logger.logWarning(`[filmReview] delete-frame: failed to remove ${p}`, { error: err.message });
      }
    };
    if (rec.originalPath) {
      const dir  = path.dirname(rec.originalPath);
      const stem = path.basename(rec.originalPath, path.extname(rec.originalPath));
      for (const ext of ['.tif', '.tiff', '.jpg', '.jpeg']) {
        tryUnlink(path.join(dir, stem + ext));
      }
    }
    tryUnlink(rec.thumbnailPath);

    // Drop the frame record; if the roll is now empty, drop the roll record too.
    frameMetadataStore.deleteFrame(frameId);
    const remaining = frameMetadataStore.listByRoll(rollId);
    if (remaining.length === 0) {
      frameMetadataStore.deleteRoll(rollId);
    }

    logger.info(`[filmReview] delete-frame ${frameId}: removed ${removed.length} file(s)`, { rollId, remaining: remaining.length });

    // Refresh the panel (list view re-fetches; detail view re-fetches on return value).
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w && !w.isDestroyed()) w.webContents.send('ohd:filmReview:roll-processed', { rollId });
      }
    } catch (_) { /* best-effort */ }

    return { ok: true, rollId, removedCount: removed.length, rollEmptied: remaining.length === 0 };
  } catch (err) {
    logger.logError('[filmReview] delete-frame failed', err);
    return { ok: false, error: err.message };
  }
});

/**
 * Permanently delete MANY frames at once (multi-select in the roll grid).
 * Same rules as delete-frame, applied per frame, with one roll-cleanup + one
 * panel refresh at the end. Frames whose roll is already uploaded are skipped
 * (reported in `errors`). Returns { ok, deleted, errors, rollId, rollEmptied }.
 */
ipcMain.handle('ohd:filmReview:delete-frames', async (event, payload) => {
  const frameIds = Array.isArray(payload) ? payload : (payload && payload.frameIds);
  try {
    if (!Array.isArray(frameIds) || frameIds.length === 0) return { ok: false, error: 'No frames selected' };

    let rollId = null;
    let deleted = 0;
    const errors = [];
    const tryUnlink = (p) => {
      try { if (p && fs.existsSync(p)) fs.unlinkSync(p); }
      catch (err) { logger.logWarning(`[filmReview] delete-frames: failed to remove ${p}`, { error: err.message }); }
    };

    for (const frameId of frameIds) {
      const rec = frameMetadataStore.get(frameId);
      if (!rec) { errors.push(`${frameId}: not found`); continue; }
      if (!rollId) rollId = rec.rollId;
      const roll = frameMetadataStore.getRoll(rec.rollId);
      const us = roll && roll.uploadStatus;
      if (us === 'uploaded' || us === 'uploading') { errors.push(`${frameId}: roll already uploaded`); continue; }

      if (rec.originalPath) {
        const dir  = path.dirname(rec.originalPath);
        const stem = path.basename(rec.originalPath, path.extname(rec.originalPath));
        for (const ext of ['.tif', '.tiff', '.jpg', '.jpeg']) tryUnlink(path.join(dir, stem + ext));
      }
      tryUnlink(rec.thumbnailPath);
      frameMetadataStore.deleteFrame(frameId);
      deleted++;
    }

    let rollEmptied = false;
    if (rollId) {
      const remaining = frameMetadataStore.listByRoll(rollId);
      if (remaining.length === 0) { frameMetadataStore.deleteRoll(rollId); rollEmptied = true; }
      try {
        for (const w of BrowserWindow.getAllWindows()) {
          if (w && !w.isDestroyed()) w.webContents.send('ohd:filmReview:roll-processed', { rollId });
        }
      } catch (_) { /* best-effort */ }
    }

    logger.info(`[filmReview] delete-frames: removed ${deleted} frame(s)`, { rollId, errorCount: errors.length });
    return { ok: deleted > 0, deleted, errors, rollId, rollEmptied };
  } catch (err) {
    logger.logError('[filmReview] delete-frames failed', err);
    return { ok: false, error: err.message };
  }
});

/**
 * Approve a roll for S3 upload (PW-007 M7 — Manual Review mode).
 *
 * Called from RollReview's "Approve & Upload" button when the roll is in the
 * 'pending' uploadStatus — set by folder-watch when filmScanReviewMode is
 * 'always' or when 'smart' triggered on a low-conf / rotation-error frame.
 * Looks up the deferred storage context the folder-watch step stashed on the
 * roll record, runs s3Service.uploadFolder, and stamps the result back onto
 * the roll record so the panel can hide / retry / show error.
 *
 * Returns:
 *   { ok: true,  uploaded, total }                — success
 *   { ok: false, error: string, uploaded?, total? } — failure (operator can retry)
 *
 * Errors mid-IPC (missing roll record, bad config) return ok:false with a
 * descriptive error rather than throwing — keeps the renderer's error path
 * uniform.
 */
ipcMain.handle('ohd:filmReview:approve-roll', async (event, rollIdRaw) => {
  // Accept both `rollId` string and `{ rollId }` object — preload calls it
  // with a bare string; future callers may want to pass options.
  const rollId = typeof rollIdRaw === 'string' ? rollIdRaw : (rollIdRaw && rollIdRaw.rollId);
  if (!rollId) return { ok: false, error: 'rollId is required' };

  try {
    const roll = frameMetadataStore.getRoll(rollId);
    if (!roll) {
      return { ok: false, error: `No roll record found for ${rollId} (was it processed in Manual mode?)` };
    }
    if (!roll.storagePath || !fs.existsSync(roll.storagePath)) {
      return { ok: false, error: `Storage folder missing on disk: ${roll.storagePath}` };
    }

    const config = configService.getAll();

    // M5: two-gate integration for Film Development Auto Assignment.
    // A roll with awaitingAssignment:true was held at Step 3 by the
    // auto-assign feature; the operator's approval closes Gate A
    // (reviewPassed), but upload only proceeds when Gate B
    // (matchedJobId) is also set. If Gate B is still open we stamp
    // reviewPassed:true, mark the roll reviewed (so it leaves the
    // "Ready to review" filter), keep uploadStatus:'pending', and
    // return heldForMatch:true so the renderer can show "Approved —
    // awaiting job match" instead of an upload result. Then we kick a
    // match cycle immediately in case the job is already cached.
    // Rolls without awaitingAssignment (feature off, or held pre-
    // toggle) fall through to the legacy approve-and-upload path
    // byte-identically.
    if (roll.awaitingAssignment && config.filmScanAutoAssignEnabled) {
      if (!roll.matchedJobId) {
        frameMetadataStore.updateRoll(rollId, { reviewPassed: true });
        try { frameMetadataStore.markRollReviewed(rollId); } catch (_) { /* best-effort */ }
        emitFilmReviewRollUpdate(rollId);
        logger.info(`[filmReview] approve-roll ${rollId}: Gate A passed, awaiting job match`);
        try {
          const filmScanAutoAssign = require('./services/film-scan-auto-assign');
          await filmScanAutoAssign.runMatchCycle(config, logger);
        } catch (matchErr) {
          logger.logError('[filmReview] approve-roll: post-approval match cycle threw', matchErr);
        }
        // The match cycle above may have flipped the roll to 'uploaded'
        // (job was already cached). Report both cases distinctly.
        const post = frameMetadataStore.getRoll(rollId) || {};
        if (post.uploadStatus === 'uploaded') {
          return { ok: true, uploaded: post.uploadedCount || 0, total: post.uploadedTotal || 0 };
        }
        return { ok: true, heldForMatch: true };
      }
      // Both gates now pass — proceed to the S3 upload path below,
      // clearing awaitingAssignment so no concurrent match cycle can
      // race to re-upload the same roll.
      frameMetadataStore.updateRoll(rollId, {
        reviewPassed:       true,
        awaitingAssignment: false,
      });
    }

    const s3Config = folderWatchService._buildS3Config(config, roll.locationId);
    if (!s3Config) {
      return { ok: false, error: 'S3 is not configured (check Connection settings)' };
    }

    // Mark uploading so concurrent panel reads can show a spinner / disable
    // the button. The renderer also disables locally on click but the store
    // value matters if the user reopens the panel mid-upload.
    frameMetadataStore.updateRoll(rollId, { uploadStatus: 'uploading', uploadError: null });
    emitFilmReviewRollUpdate(rollId);

    // Carry the matched job / twin-check context into the completion manifest
    // (same block the auto/auto-assign upload paths write) so OrderHub can
    // record the upload against the correct job and twin check. Null when the
    // roll has no match, keeping the manifest byte-identical to the legacy shape.
    const manifestExtra = folderWatchService._buildFilmScanManifestExtra(rollId);

    let result;
    try {
      result = await s3Service.uploadFolder(roll.storagePath, roll.s3Prefix, s3Config, (progress) => {
        logger.info(`[filmReview] approve-roll ${rollId}: ${progress.message}`);
      }, manifestExtra);
    } catch (uploadErr) {
      const msg = uploadErr && uploadErr.message ? uploadErr.message : String(uploadErr);
      logger.logError(`[filmReview] approve-roll: uploadFolder threw for ${rollId}`, uploadErr);
      frameMetadataStore.updateRoll(rollId, { uploadStatus: 'failed', uploadError: msg });
      emitFilmReviewRollUpdate(rollId);
      return { ok: false, error: msg };
    }

    if (result.failed > 0) {
      const msg = `Upload incomplete: ${result.uploaded}/${result.total} files uploaded, ${result.failed} failed`;
      logger.logWarning(`[filmReview] approve-roll ${rollId}: ${msg}`, result);
      frameMetadataStore.updateRoll(rollId, { uploadStatus: 'failed', uploadError: msg });
      emitFilmReviewRollUpdate(rollId);
      return { ok: false, error: msg, uploaded: result.uploaded, total: result.total };
    }

    frameMetadataStore.updateRoll(rollId, {
      uploadStatus: 'uploaded',
      uploadError: null,
      uploadedAt: new Date().toISOString(),
    });
    // Manual-mode rolls only enter the panel because the operator has to
    // sign off before upload. Once that sign-off succeeds the roll has, by
    // definition, been reviewed — so flip every frame to reviewed too.
    // This mirrors the Auto/Off "Mark reviewed" button and lets the existing
    // status filter naturally hide approved rolls from "Ready to review".
    try {
      frameMetadataStore.markRollReviewed(rollId);
    } catch (markErr) {
      // Non-fatal: the upload succeeded, the cosmetic status flip can be
      // retried by the operator from the panel.
      logger.logWarning(`[filmReview] approve-roll ${rollId}: markRollReviewed failed (non-fatal)`, markErr);
    }
    logger.info(`[filmReview] approve-roll ${rollId}: upload complete (${result.uploaded}/${result.total})`);
    emitFilmReviewRollUpdate(rollId);
    return { ok: true, uploaded: result.uploaded, total: result.total };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.logError('[filmReview] approve-roll failed', err);
    try { frameMetadataStore.updateRoll(rollId, { uploadStatus: 'failed', uploadError: msg }); } catch (_) { /* ignored */ }
    emitFilmReviewRollUpdate(rollId);
    return { ok: false, error: msg };
  }
});

/**
 * ohd:filmReview:upload-unmatched  (Film Development Auto Assignment — M5)
 * Payload:  rollId (string) or { rollId }
 * Returns:  { ok: true, uploaded, total } | { ok: false, error }
 *
 * Explicit operator override for the two-gate rule: force-upload a
 * reviewed roll whose Gate B (matchedJobId) never got filled in — the
 * usual walk-in / mis-scanned / typo-in-twin-check case. Without this
 * there is no escape hatch for a held roll whose job never arrives.
 *
 * Preconditions:
 *   - Roll must exist and have awaitingAssignment:true (feature-off or
 *     legacy rolls should use the normal approve-roll path).
 *   - matchedJobId must NOT be set. If it is, the operator should use
 *     approve-roll instead — the match already exists.
 *
 * Effect: stamps reviewPassed:true, clears awaitingAssignment, and
 * hands off to _uploadRollFromStorage which reuses the same retry
 * chain + markRollReviewed hook the auto-triggered upload uses.
 */
ipcMain.handle('ohd:filmReview:upload-unmatched', async (event, rollIdRaw) => {
  const rollId = typeof rollIdRaw === 'string' ? rollIdRaw : (rollIdRaw && rollIdRaw.rollId);
  if (!rollId) return { ok: false, error: 'rollId is required' };

  try {
    const roll = frameMetadataStore.getRoll(rollId);
    if (!roll) return { ok: false, error: `No roll record found for ${rollId}` };
    if (!roll.awaitingAssignment) {
      return { ok: false, error: 'This roll is not held by Auto Assignment — use Approve instead.' };
    }
    if (roll.matchedJobId) {
      return { ok: false, error: 'This roll has a matched job — use Approve instead.' };
    }

    const config = configService.getAll();
    // Clear both gates so the upload path runs unconditionally and the
    // matcher can never race back in and try to fire it a second time.
    frameMetadataStore.updateRoll(rollId, {
      reviewPassed:       true,
      awaitingAssignment: false,
    });
    logger.info(`[filmReview] upload-unmatched ${rollId}: operator override — bypassing match`);
    await folderWatchService._uploadRollFromStorage(rollId, config);

    // Read post-upload state so we can report an accurate outcome.
    const post = frameMetadataStore.getRoll(rollId) || {};
    if (post.uploadStatus === 'uploaded') {
      return { ok: true, uploaded: true };
    }
    return {
      ok: false,
      error: post.uploadError || 'Upload did not complete — check Activity Log.',
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.logError('[filmReview] upload-unmatched failed', err);
    return { ok: false, error: msg };
  }
});

/**
 * Delete a Film Review roll.
 *
 * Cleans up all local state for a roll the operator has decided is junk
 * (mis-scan, wrong slot, test scan that shouldn't ship to S3). Steps:
 *
 *   1. Refuse if uploadStatus === 'uploaded' — the roll is already on S3
 *      and a local-only delete would leave the operator with the wrong
 *      mental model. They can re-trigger from the bucket if needed.
 *   2. Resolve the storage folder. Prefer the roll record's storagePath
 *      (always set by folder-watch in M7+); fall back to the dirname of
 *      any frame's originalPath for legacy rolls without a roll record.
 *   3. Rename the storage folder to `<basename>__DELETED__<ISO>`. This is
 *      a soft delete — the JPGs survive on disk so an accidental click
 *      is recoverable. Operator (or a future cleanup job) can purge the
 *      __DELETED__ folders later. Uses renameWithRetry for SMB safety
 *      (same EPERM race that bites the rotation pipeline).
 *   4. Delete the userData thumbnails directory for this roll. Cheap to
 *      regenerate, no point retaining once the roll is gone from the panel.
 *   5. Delete the frame records and the roll record from frame-metadata.
 *      This is what actually guarantees "won't go to S3" — approve-roll
 *      reads getRoll(rollId) and refuses if it's missing.
 *   6. Emit roll-processed so RollList re-fetches and the card disappears.
 *
 * Returns:
 *   { ok: true,  framesRemoved, deletedFolderPath }    — success
 *   { ok: false, error: string }                       — refused / failed
 *
 * Folder-rename failures are NOT fatal: the metadata is still scrubbed so
 * the panel and upload path forget the roll. We surface the rename error
 * so the operator knows to clean up the folder manually if it survives.
 */
ipcMain.handle('ohd:filmReview:delete-roll', async (event, rollIdRaw) => {
  const rollId = typeof rollIdRaw === 'string' ? rollIdRaw : (rollIdRaw && rollIdRaw.rollId);
  if (!rollId) return { ok: false, error: 'rollId is required' };

  try {
    const roll = frameMetadataStore.getRoll(rollId);

    // Refuse uploaded rolls — they're already on S3 and a local-only
    // delete would mislead the operator.
    if (roll && roll.uploadStatus === 'uploaded') {
      return {
        ok: false,
        error: 'This roll has already been uploaded to S3. Delete it from the bucket if needed; the local copy will be cleaned up automatically.',
      };
    }

    // Resolve storage folder. Prefer the roll record; fall back to the
    // dirname of any frame's originalPath (legacy rolls / Off-mode rolls
    // that pre-date the M7 roll record).
    let storagePath = roll && roll.storagePath ? roll.storagePath : null;
    if (!storagePath) {
      const frames = frameMetadataStore.listByRoll(rollId);
      if (frames.length && frames[0].originalPath) {
        storagePath = path.dirname(frames[0].originalPath);
      }
    }

    // Rename the folder to the __DELETED__ form. Best-effort: if the
    // folder is already gone (operator deleted it manually) or the rename
    // fails for some reason, we still proceed with the metadata scrub so
    // the panel + upload path forget about it.
    let renameError = null;
    let deletedFolderPath = null;
    if (storagePath && fs.existsSync(storagePath)) {
      try {
        const parent  = path.dirname(storagePath);
        const baseDir = path.basename(storagePath);
        const stamp   = new Date().toISOString().replace(/[:.]/g, '-');
        deletedFolderPath = path.join(parent, `${baseDir}__DELETED__${stamp}`);
        await renameWithRetry(storagePath, deletedFolderPath);
        logger.info(`[filmReview] delete-roll ${rollId}: folder renamed → ${deletedFolderPath}`);
      } catch (err) {
        renameError = err && err.message ? err.message : String(err);
        logger.logError(`[filmReview] delete-roll: folder rename failed for ${rollId} (continuing with metadata scrub)`, err);
        deletedFolderPath = null;
      }
    } else if (storagePath) {
      logger.info(`[filmReview] delete-roll ${rollId}: storage folder already absent (${storagePath})`);
    } else {
      logger.info(`[filmReview] delete-roll ${rollId}: no storage path resolvable, scrubbing metadata only`);
    }

    // Best-effort thumbnail dir cleanup. Thumbnails are regenerable cache.
    try {
      const { app } = require('electron');
      const thumbDir = path.join(app.getPath('userData'), 'thumbnails', rollId);
      if (fs.existsSync(thumbDir)) {
        fs.rmSync(thumbDir, { recursive: true, force: true });
        logger.info(`[filmReview] delete-roll ${rollId}: thumbnails directory removed`);
      }
    } catch (err) {
      // Non-fatal — thumbnails will just be orphaned cache.
      logger.logWarning(`[filmReview] delete-roll ${rollId}: thumbnail cleanup failed (non-fatal)`, err);
    }

    // Scrub metadata. This is the bit that guarantees "won't ever upload".
    const framesRemoved = frameMetadataStore.deleteFramesByRoll(rollId);
    frameMetadataStore.deleteRoll(rollId);

    emitFilmReviewRollUpdate(rollId);

    logger.info(`[filmReview] delete-roll ${rollId}: ${framesRemoved} frame records removed`);

    if (renameError) {
      // Metadata scrub succeeded but the folder is still on disk under its
      // original name — the operator should know.
      return {
        ok: true,
        framesRemoved,
        deletedFolderPath: null,
        warning: `Local files were not renamed (${renameError}). The roll has been removed from the panel but the folder is still on disk under its original name.`,
      };
    }
    return { ok: true, framesRemoved, deletedFolderPath };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.logError('[filmReview] delete-roll failed', err);
    return { ok: false, error: msg };
  }
});

/**
 * ohd:filmScans:reset-enhancement  (2026-07-23)
 *
 * Operator-triggered "Skip / Reset enhancement" for a roll currently
 * showing as enhancing in the Film Scans panel. Aborts a live in-flight
 * batch via AbortController (the folder-watch continuation then falls
 * through its existing cancel path → uploadStatus:'pending'). When the
 * roll is stuck at 'enhancing' with no live batch (phantom / crash-
 * recovered), does the same recovery patch the startup sweep does.
 *
 * Payload: string rollId  OR  { rollId }
 * Returns: { success: boolean, wasLive: boolean, error?: string }
 */
ipcMain.handle('ohd:filmScans:reset-enhancement', async (event, payload) => {
  const rollId = typeof payload === 'string' ? payload : (payload && payload.rollId);
  if (!rollId) return { success: false, wasLive: false, error: 'rollId is required' };
  try {
    return await folderWatchService.resetEnhancingRoll(rollId);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.logError('[filmScans] reset-enhancement threw', err, { rollId });
    return { success: false, wasLive: false, error: msg };
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Film Scan — Perfectly Clear per-frame IPC (M4, 2026-07-03)
// ──────────────────────────────────────────────────────────────────────────────
//
// Complements the folder-watch auto-apply path: gives the operator a manual
// Enhance / Revert action on any focused frame in Film Review. Uses the same
// shared perfectlyClearClient as auto-apply (one-file processBatch), so the
// on-disk contract is identical:
//
//   Enhance: capture `{storagePath}/pre-enhance/{filename}` if not already
//            present (first-enhancement-wins), then round-trip the storage
//            file through QuickServer (sourcePath == destPath), regenerate
//            the 512px thumbnail, and stamp per-frame metadata.
//   Revert:  restore the storage file from the pre-enhance/ backup, regen
//            the thumbnail, and clear the PC metadata (leaves rotation +
//            operatorFlags fields alone).
//
// Concurrency guard: a small in-memory Set tracks frames currently mid-
// enhance so a second click can't kick a racing batch on the same file.
// Not persisted — an app restart mid-enhance loses the guard, but the
// storage file is either the un-touched original or the (fully-written)
// enhanced version thanks to the client's temp+rename copy-back.

const _pcInFlightFrames = new Set();

/**
 * Resolve the Perfectly Clear Film Scans config to use for a per-frame call.
 * Precedence: explicit configId → autoApplyConfigId → first config. Returns
 * null if the scope is disabled / empty (caller surfaces the operator hint).
 */
function _resolveFilmScanPcConfig(configId) {
  let pc;
  try { pc = configService.get('perfectlyClear'); } catch (_) { return null; }
  if (!pc || !pc.filmScans) return null;
  const scope = pc.filmScans;
  const configs = Array.isArray(scope.configs) ? scope.configs : [];
  if (!scope.enabled || configs.length === 0) return null;
  if (configId) {
    const explicit = configs.find(c => c && c.id === configId);
    if (explicit) return explicit;
  }
  if (scope.autoApplyConfigId) {
    const auto = configs.find(c => c && c.id === scope.autoApplyConfigId);
    if (auto) return auto;
  }
  return configs[0];
}

/**
 * Regenerate the 512px thumbnail for a frame from the current storage file.
 * Best-effort — logs on failure, doesn't throw. Mirrors the folder-watch
 * rotation step's thumbnail call (line ~349 of folder-watch-service.js).
 */
async function _regenFilmScanThumbnail(rec) {
  if (!rec || !rec.thumbnailPath || !rec.originalPath) return;
  try {
    const sharp = require('sharp');
    await sharp(rec.originalPath, { limitInputPixels: false, failOn: 'none' })
      .resize(512, null, { withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality: 85 })
      .toFile(rec.thumbnailPath);
  } catch (thumbErr) {
    logger.logError(`[filmScan] PC thumbnail regen failed for ${rec.frameId}`, thumbErr);
  }
}

/**
 * ohd:filmscan:enhanceFrame  (Perfectly Clear — M4)
 * Payload:  { frameId, configId? }
 * Returns:  { ok: true, status: 'enhanced'|'rejected'|'timeout'|'cancelled'|'error',
 *              frame? }  |  { ok: false, error }
 *
 * Blocks until the one-file processBatch returns. The renderer shows a local
 * spinner while awaiting. Enhanced result: storage file replaced (by the
 * client), thumbnail regenerated, metadata stamped pcEnhanced. Non-enhanced
 * result: storage file left untouched, pcRejected stamped.
 */
ipcMain.handle('ohd:filmscan:enhanceFrame', async (event, payload = {}) => {
  const { frameId, configId } = payload;
  if (!frameId) return { ok: false, error: 'frameId is required' };
  if (_pcInFlightFrames.has(frameId)) {
    return { ok: false, error: 'Enhancement already in progress for this frame' };
  }

  const rec = frameMetadataStore.get(frameId);
  if (!rec || !rec.originalPath) return { ok: false, error: `Unknown frame ${frameId}` };
  if (!fs.existsSync(rec.originalPath)) {
    return { ok: false, error: `Storage file missing on disk: ${rec.originalPath}` };
  }

  const pcCfg = _resolveFilmScanPcConfig(configId);
  if (!pcCfg) {
    return { ok: false, error: 'Perfectly Clear is not configured for Film Scans (Settings → AI Enhancement)' };
  }

  const storagePath  = path.dirname(rec.originalPath);
  const filename     = path.basename(rec.originalPath);
  const preEnhanceDir = path.join(storagePath, 'pre-enhance');
  const preEnhance   = path.join(preEnhanceDir, filename);

  _pcInFlightFrames.add(frameId);
  try {
    // First-enhancement-wins backup so Revert can restore the exact bytes
    // the frame arrived with (matches the auto-apply pipeline's convention).
    try { fs.mkdirSync(preEnhanceDir, { recursive: true }); } catch (_) { /* best-effort */ }
    try {
      if (!fs.existsSync(preEnhance)) fs.copyFileSync(rec.originalPath, preEnhance);
    } catch (backupErr) {
      logger.logError(`[filmScan] PC pre-enhance backup failed for ${frameId}`, backupErr);
      return { ok: false, error: `Pre-enhance backup failed: ${backupErr.message}` };
    }

    // Wall-clock timeout: single-file batches still deserve breathing room.
    // The auto-apply path uses max(5min, 30s × frameCount); for one frame
    // that's 5 min, which matches per-frame QuickServer expectations.
    const timeoutMs = 5 * 60 * 1000;
    let results = [];
    try {
      const perfectlyClearClient = require('./enhancement/perfectlyClearClient');
      results = await perfectlyClearClient.processBatch({
        config: pcCfg,
        files:  [{ sourcePath: rec.originalPath, destPath: rec.originalPath }],
        timeoutMs,
      });
    } catch (clientErr) {
      logger.logError(`[filmScan] PC client threw for ${frameId}`, clientErr);
      const updated = frameMetadataStore.update(frameId, {
        pcEnhanced:     false,
        pcRejected:     true,
        pcRejectReason: 'error',
        pcRejectError:  clientErr.message,
      });
      return { ok: true, status: 'error', frame: updated, error: clientErr.message };
    }

    const r = (results && results[0]) || null;
    if (!r) {
      return { ok: false, error: 'processBatch returned no result' };
    }

    if (r.status === 'enhanced') {
      await _regenFilmScanThumbnail(rec);
      const updated = frameMetadataStore.update(frameId, {
        pcEnhanced:     true,
        pcConfigName:   pcCfg.friendlyName || null,
        pcConfigId:     pcCfg.id,
        pcEnhancedAt:   new Date().toISOString(),
        pcRejected:     false,
        pcRejectReason: null,
        pcRejectError:  null,
      });
      logger.info(`[filmScan] PC enhance ${frameId} (config="${pcCfg.friendlyName}") — ok`);
      return { ok: true, status: 'enhanced', frame: updated };
    }

    const updated = frameMetadataStore.update(frameId, {
      pcEnhanced:     false,
      pcRejected:     true,
      pcRejectReason: r.status,
      pcRejectError:  r.error || null,
    });
    logger.logWarning(`[filmScan] PC enhance ${frameId} → ${r.status}${r.error ? ` (${r.error})` : ''}`);
    return { ok: true, status: r.status, frame: updated, error: r.error || null };
  } catch (err) {
    logger.logError(`[filmScan] enhance-frame failed for ${frameId}`, err);
    return { ok: false, error: err.message };
  } finally {
    _pcInFlightFrames.delete(frameId);
  }
});

/**
 * ohd:filmscan:revertFrame  (Perfectly Clear — M4)
 * Payload:  { frameId }
 * Returns:  { ok, frame? } | { ok: false, error }
 *
 * Restores the storage file from `{storagePath}/pre-enhance/{filename}`
 * (byte-identical), regenerates the thumbnail, and clears the pcEnhanced /
 * pcRejected metadata. Leaves rotation + operatorFlags fields alone —
 * revert is orthogonal to those, matching the M3 Jobs decision.
 */
ipcMain.handle('ohd:filmscan:revertFrame', async (event, payload = {}) => {
  const { frameId } = payload;
  if (!frameId) return { ok: false, error: 'frameId is required' };
  if (_pcInFlightFrames.has(frameId)) {
    return { ok: false, error: 'Enhancement in progress — wait for it to finish before reverting' };
  }

  const rec = frameMetadataStore.get(frameId);
  if (!rec || !rec.originalPath) return { ok: false, error: `Unknown frame ${frameId}` };

  const storagePath  = path.dirname(rec.originalPath);
  const filename     = path.basename(rec.originalPath);
  const preEnhance   = path.join(storagePath, 'pre-enhance', filename);

  if (!fs.existsSync(preEnhance)) {
    return { ok: false, error: `Pre-enhance backup not found — cannot revert (${preEnhance})` };
  }

  try {
    // Copy via temp + rename so the storage file is never seen half-written.
    const tmp = rec.originalPath + '.revert.tmp';
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    fs.copyFileSync(preEnhance, tmp);
    await renameWithRetry(tmp, rec.originalPath);

    await _regenFilmScanThumbnail(rec);

    // Clear PC bookkeeping; leave rotation + operatorFlags alone.
    const updated = frameMetadataStore.update(frameId, {
      pcEnhanced:     false,
      pcConfigName:   null,
      pcConfigId:     null,
      pcEnhancedAt:   null,
      pcRejected:     false,
      pcRejectReason: null,
      pcRejectError:  null,
    });
    logger.info(`[filmScan] PC revert ${frameId} — restored from pre-enhance/`);
    return { ok: true, frame: updated };
  } catch (err) {
    logger.logError(`[filmScan] revert-frame failed for ${frameId}`, err);
    return { ok: false, error: err.message };
  }
});

/**
 * ohd:filmscan:enhanceStatus  (Perfectly Clear — M4)
 * Payload:  { frameId }
 * Returns:  { ok, inFlight, frame? } | { ok: false, error }
 *
 * Lightweight companion to enhanceFrame. Renderer typically shows a local
 * spinner while awaiting enhanceFrame; enhanceStatus is here for the case
 * where the operator returns to a panel that had an enhance in flight
 * (e.g. mid-batch across a panel close). `frame` is the current metadata
 * so the caller can inspect pcEnhanced / pcRejected without a second call.
 */
ipcMain.handle('ohd:filmscan:enhanceStatus', async (event, payload = {}) => {
  const { frameId } = payload;
  if (!frameId) return { ok: false, error: 'frameId is required' };
  const rec = frameMetadataStore.get(frameId);
  return { ok: true, inFlight: _pcInFlightFrames.has(frameId), frame: rec || null };
});

// ──────────────────────────────────────────────────────────────────────────────
// AI Quality Gate (v1.2.0) — held-job IPC
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the absolute job folder path for a given job. Mirrors
 * job-download-service.checkLocalFiles' resolution logic but returns the
 * path even when the folder doesn't yet exist (so callers can decide
 * how to handle missing-folder errors themselves).
 */
/**
 * Resolve the composite sidecar jobId for a job — `${order_number}_${id}`.
 *
 * This is the convention used by the React Job Review drawer and matches the
 * inner-job folder name on disk. The orchestrator and ai-quality-store key
 * sidecars by this composite form, so any IPC handler invoking those layers
 * MUST translate from the OrderHub numeric `job.id` (which the renderer and
 * jobService cache use as the canonical identifier) into the composite form
 * before calling in.
 *
 * Returns null if the job is missing the inputs needed to build a composite.
 * Callers should treat null as "can't address the sidecar" and bail out.
 */
function _resolveSidecarJobId(job) {
  if (!job || !job.order_number || job.id == null) return null;
  return `${job.order_number}_${job.id}`;
}

function _resolveJobPath(job) {
  const downloadDirectory = configService.get('downloadDirectory');
  if (!downloadDirectory) return null;
  const orderNumber = job.order_number || '';
  const orderId = job.order_id;
  const jobId = job.id;
  if (!orderNumber || !orderId || !jobId) return null;
  return path.join(
    downloadDirectory,
    `${orderNumber}_${orderId}`,
    `${orderNumber}_${jobId}`
  );
}

/**
 * Return per-job AI Quality status for every received/pending job.
 *
 * Two related concerns served by one IPC iteration:
 *   - Held-state badge UI (originally the only consumer; jobs with
 *     unfixed sub-threshold images surface here with `failedImages > 0`).
 *   - Scoring-progress for the Jobs-grid action-button gating (Bug 2 of
 *     the 2026-04-28 maintenance fixes — buttons disable while
 *     `phase === 'scoring'`, re-enable on `phase === 'scored'`).
 *
 * Each entry shape:
 *   {
 *     jobId,                  // numeric OrderHub id (matches grid's job.id key)
 *     jobCode, customer,
 *     totalImages,            // sidecar image count
 *     scoredCount,            // images with aiQuality.scored === true
 *     phase,                  // 'scoring' (partial/none) | 'scored' (all done)
 *     failedImages,           // unfixed sub-threshold images (held signal)
 *     oldestHoldAt,           // job.created_at, for held-state ordering
 *   }
 *
 * Renderer derives:
 *   - aiQualityHeldByJobId map: entries where failedImages > 0
 *   - aiQualityScoringStatusByJobId map: every entry, keyed by `phase`
 *
 * Jobs absent from the response (no sidecar yet, files not local, etc.)
 * are treated by the renderer as "pending AI Quality" when the feature
 * flag is on.
 */
ipcMain.handle('aiQuality:listHeldJobs', async () => {
  try {
    const { jobs } = jobService.getLocalJobs();
    const out = [];
    for (const job of jobs) {
      // Surface AI Quality scoring data for every job that has it, not
      // just the ones still in the autoprint pool. Earlier this skipped
      // anything whose status wasn't 'received' or 'pending', which made
      // the FLAGS column empty for processed jobs and lost the historical
      // record of "this job had X failed images at process time". The
      // renderer differentiates by status: pending/received → live held
      // badge with Release button; processed/printed/dismissed → muted
      // historical badge, count only.
      const jobPath = _resolveJobPath(job);
      if (!jobPath || !fs.existsSync(jobPath)) continue;
      const sidecarJobId = _resolveSidecarJobId(job);
      if (!sidecarJobId) continue;
      let rows;
      try {
        rows = await aiQualityStore.getJobQuality(sidecarJobId, jobPath);
      } catch (_) {
        continue;
      }
      // `total` is **disk truth** (count of image-extension files in the
      // job folder), not `rows.length` (sidecar-entry count).
      //
      // Why: the orchestrator's setImageQuality upserts a sidecar entry
      // per image as it scores. For a fresh Mode-1 job whose sidecar
      // started empty (no Job-Review-touched /working/ folder to seed
      // entries from), `rows.length` equals "images so far scored",
      // making `scored === rows.length` a tautology mid-loop. The IPC
      // would report `phase: 'scored'` from the very first image and
      // the renderer's button gate would re-enable buttons before
      // scoring actually finished. See bugfixes.md 2026-04-28 entry on
      // Bug A for the full diagnostic.
      //
      // Disk-truth `_scanJobImages(jobPath).length` correctly reflects
      // the orchestrator's iteration target — phase='scoring' until the
      // sidecar's scored count catches up to the disk count, then
      // phase='scored'. Quarantined files (.quarantine extension) are
      // excluded from this count by IMAGE_EXTENSIONS — they're out of
      // scope for scoring; their visibility is handled separately
      // (Bug B / quarantinedCount field below).
      const total = aiJobQualityOrchestrator._scanJobImages(jobPath).length;
      if (total === 0) continue;
      const scored = rows.filter((r) => r.aiQuality && r.aiQuality.scored).length;
      const failed = rows.filter((r) => {
        const aq = r.aiQuality || {};
        if (!aq.scored || aq.passed) return false;
        // Mirror deriveHeld() in ai-quality-store.js: an operator decision of
        // 'fixed' or 'approved_as_is' clears the failure.
        const decision = (aq.operatorDecision && aq.operatorDecision.kind) || 'none';
        return decision !== 'fixed' && decision !== 'approved_as_is';
      }).length;
      out.push({
        jobId: job.id,
        jobCode: job.order_number || '',
        customer: job.customer_name || '',
        totalImages: total,
        scoredCount: scored,
        phase: scored >= total ? 'scored' : 'scoring',
        failedImages: failed,
        oldestHoldAt: job.created_at || null,
      });
    }
    return out;
  } catch (err) {
    logger.logError('[aiQuality] listHeldJobs failed', err);
    return [];
  }
});

/**
 * Per-image quality detail for a single job — drives the M3 Quality
 * Review focused-image view. Phase 1 returns score + passed + history.
 */
ipcMain.handle('aiQuality:getJobQuality', async (event, jobId) => {
  try {
    const { jobs } = jobService.getLocalJobs();
    const job = jobs.find((j) => String(j.id) === String(jobId));
    if (!job) return { jobId, held: false, images: [] };
    const jobPath = _resolveJobPath(job);
    if (!jobPath || !fs.existsSync(jobPath)) {
      return { jobId, held: false, images: [] };
    }
    // Renderer addresses jobs by numeric `job.id`; storage layer is keyed by
    // composite. Translate at this IPC boundary; preserve the renderer's
    // numeric jobId in the response shape.
    const sidecarJobId = _resolveSidecarJobId(job);
    if (!sidecarJobId) return { jobId, held: false, images: [] };
    const rows = await aiQualityStore.getJobQuality(sidecarJobId, jobPath);
    return {
      jobId,
      held: aiQualityStore.deriveHeld(rows),
      images: rows,
    };
  } catch (err) {
    logger.logError(`[aiQuality] getJobQuality failed for ${jobId}`, err);
    return { jobId, held: false, images: [], error: err.message };
  }
});

/**
 * Operator action: release the entire job. Marks every failed image as
 * approved-as-is. Subsequent autoprint cycles will route normally.
 */
ipcMain.handle('aiQuality:releaseJob', async (event, payload) => {
  try {
    const jobId = payload && payload.jobId;
    const note = payload && payload.note;
    if (!jobId) return { ok: false, error: 'jobId required' };
    const { jobs } = jobService.getLocalJobs();
    const job = jobs.find((j) => String(j.id) === String(jobId));
    if (!job) return { ok: false, error: 'job not found' };
    const jobPath = _resolveJobPath(job);
    if (!jobPath) return { ok: false, error: 'job path unresolvable' };
    // Translate numeric → composite at the IPC boundary (see _resolveSidecarJobId).
    const sidecarJobId = _resolveSidecarJobId(job);
    if (!sidecarJobId) return { ok: false, error: 'sidecar jobId unresolvable' };
    return await aiJobQualityOrchestrator.releaseJob(sidecarJobId, jobPath, note);
  } catch (err) {
    logger.logError('[aiQuality] releaseJob failed', err);
    return { ok: false, error: err.message };
  }
});

/**
 * Operator action: approve a single image as-is (override the gate
 * for that image only). Used by M3's FocusedImage view.
 */
ipcMain.handle('aiQuality:approveImage', async (event, payload) => {
  try {
    const jobId = payload && payload.jobId;
    const filename = payload && payload.filename;
    const note = payload && payload.note;
    if (!jobId || !filename) return { ok: false, error: 'jobId and filename required' };
    const { jobs } = jobService.getLocalJobs();
    const job = jobs.find((j) => String(j.id) === String(jobId));
    if (!job) return { ok: false, error: 'job not found' };
    const jobPath = _resolveJobPath(job);
    if (!jobPath) return { ok: false, error: 'job path unresolvable' };
    // Translate numeric → composite at the IPC boundary (see _resolveSidecarJobId).
    const sidecarJobId = _resolveSidecarJobId(job);
    if (!sidecarJobId) return { ok: false, error: 'sidecar jobId unresolvable' };
    return await aiJobQualityOrchestrator.approveImage(sidecarJobId, jobPath, filename, note);
  } catch (err) {
    logger.logError('[aiQuality] approveImage failed', err);
    return { ok: false, error: err.message };
  }
});

module.exports = {
  setupIpcHandlers,
  // Exposed for unit tests of the v1.3.2 generalized catch handler — see
  // src/main/services/__tests__/ipc-handlers-auto-print.test.js. Production
  // callers go through the IPC + polling-service callback wiring.
  _runAutoPrint: runAutoPrint,
};
