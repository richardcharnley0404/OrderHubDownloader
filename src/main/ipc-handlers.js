const { ipcMain, dialog, app, BrowserWindow, shell } = require('electron');
const updater = require('./updater');
const configService = require('./services/config-service');
const s3Service = require('./services/s3-service');
const jobService = require('./services/job-service');
const printService = require('./services/print-service');
const { runTest: runPrintControllerTest } = require('./services/test-print-controller');
const { printControllerStore } = require('./services/print-controller-store');
const routingService = require('./services/routing-service');
const processFolderService = require('./services/process-folder-service');
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
      const anyModeEnabled = config.pollingEnabled || config.filmScansEnabled || config.fileUploadsEnabled;
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

      // ── New routing system ─────────────────────────────────────────────────
      // Attempt to resolve via the routing-service decision tree first.
      // Fall back to the old printControllerStore path if the job is unrouted.
      const route = routingService.resolveRoute(job);
      let result;

      if (route.type === 'process-folder') {
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

      const route = routingService.resolveRoute(job);
      if (route.type === 'controller') {
        // New system: routingService controller with outputPath
        const ctrl = routingService.getControllers().find(c => c.id === route.controllerId);
        outputFolderPath = ctrl ? ctrl.outputPath : null;
      } else if (route.type !== 'process-folder') {
        // Fallback: old configService + printControllerStore
        const mapping = configService.getProcessMapping(job.process);
        if (mapping.controllerId) {
          const ctrl = printControllerStore.getController(mapping.controllerId);
          outputFolderPath = ctrl ? ctrl.hotFolderPath : null;
        }
      }

      if (!outputFolderPath) return null;

      const status = await getJobOutputStatus(job, outputFolderPath);
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

      const route = routingService.resolveRoute(job);
      if (route.type === 'controller') {
        const ctrl = routingService.getControllers().find(c => c.id === route.controllerId);
        outputFolderPath = ctrl ? ctrl.outputPath : null;
      } else if (route.type !== 'process-folder') {
        const mapping = configService.getProcessMapping(job.process);
        if (mapping.controllerId) {
          const ctrl = printControllerStore.getController(mapping.controllerId);
          outputFolderPath = ctrl ? ctrl.hotFolderPath : null;
        }
      }

      if (!outputFolderPath) {
        return { success: false, error: 'Controller or output folder not found.' };
      }

      const status = await getJobOutputStatus(job, outputFolderPath);
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
          'Either set the option key on the controller or clear the translations.';
        logger.logWarning('[routing] save-controller rejected — translations without option key', {
          controllerId:        controller.id,
          name:                controller.name,
          mediaTranslations:   controller.mediaTranslations.length,
          mediaOptionKey:      controller.mediaOptionKey || '(empty)',
        });
        return { success: false, error: msg };
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
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:save-controller error', error);
      return { success: false, error: error.message };
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

  ipcMain.handle('ohd:routing:save-channel-mapping', async (event, mapping) => {
    try {
      routingService.saveChannelMapping(mapping);
      // A new channel mapping may make previously-unrouted jobs eligible for auto-print
      runAutoPrint().catch(err => logger.logError('[auto-print] post-channel-mapping check failed', err));
      return { success: true };
    } catch (error) {
      logger.logError('ohd:routing:save-channel-mapping error', error);
      return { success: false, error: error.message };
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

      if (mediaTranslation && mediaTranslation.from) {
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
        sizeCountBefore:  sizeBefore,
        sizeCountAfter:   (controller.sizeTranslations  || []).length,
        mediaCountBefore: mediaBefore,
        mediaCountAfter:  (controller.mediaTranslations || []).length,
      });
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

      // Build a filename→quantity map from the order manifest so that first-time
      // sidecar creation uses the ordered quantity rather than defaulting to 1.
      // If the manifest is missing or unreadable, the map is empty and loadSidecar
      // falls back to qty = 1 as before.
      const quantityMap = await _buildManifestQuantityMap(jobId, jobPath);

      const { sidecar, filenames } = await loadSidecar(jobId, jobPath, quantityMap);
      return { success: true, sidecar, filenames };
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
  ipcMain.handle('ohd:job:crop-image', async (event, { jobPath, sidecar, filename, cropRect, channelMappingId, darkroomSize, ohJobId }) => {
    try {
      let sharp;
      try {
        sharp = require('sharp');
      } catch (e) {
        return { success: false, error: 'sharp is not installed — cannot crop. Run: npm install sharp' };
      }

      // Prefer the working copy; fall back to originals if working/ was never written.
      const workingDir  = path.join(jobPath, 'working');
      const workingPath = path.join(workingDir, filename);
      const originalsPath = path.join(jobPath, 'originals', filename);

      let sourcePath;
      if (fs.existsSync(workingPath)) {
        sourcePath = workingPath;
      } else if (fs.existsSync(originalsPath)) {
        sourcePath = originalsPath;
      } else {
        return { success: false, error: `Source image not found: ${filename}` };
      }

      // Ensure /working/ exists
      await fsPromises.mkdir(workingDir, { recursive: true });

      // Crop via Sharp — write to a temp file then rename so we never leave a
      // half-written file at the destination path.
      const tempPath = workingPath + '.crop_tmp';
      await sharp(sourcePath)
        .extract({
          left:   Math.max(0, cropRect.x),
          top:    Math.max(0, cropRect.y),
          width:  Math.max(1, cropRect.w),
          height: Math.max(1, cropRect.h),
        })
        .jpeg({ quality: 95 })
        .toFile(tempPath);

      // Atomic rename: replace working copy with the cropped version
      await fsPromises.rename(tempPath, workingPath);

      logger.info('Crop applied', {
        filename, cropRect,
        channelMappingId,
        ohJobId,
        croppedPath: workingPath,
      });

      // Update the sidecar image entry
      const updatedSidecar = {
        ...sidecar,
        images: sidecar.images.map(img => {
          if (img.filename !== filename) return img;
          return {
            ...img,
            cropApplied:      true,
            croppedPath:      workingPath,
            cropRect:         { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h },
            channelMappingId,
          };
        }),
      };

      const saved = await saveSidecar(updatedSidecar, jobPath);

      // Store routing overrides on the in-memory job cache.
      // DPOF controllers: _channelMappingOverride → routes to the specific channel.
      // Darkroom Pro:     _darkroomProSize        → overrides the size sent to Darkroom.
      // Plain-size crops (no source mapping) leave routing unchanged.
      if (ohJobId && (channelMappingId || darkroomSize)) {
        const numericId = Number(ohJobId);
        if (!isNaN(numericId)) {
          const updates = {};
          if (channelMappingId) updates._channelMappingOverride = channelMappingId;
          if (darkroomSize)     updates._darkroomProSize        = darkroomSize;
          jobService.updateJobLocally(numericId, updates);
        }
      }

      return { success: true, sidecar: saved };
    } catch (error) {
      logger.logError('ohd:job:crop-image error', error, { filename, cropRect });
      return { success: false, error: error.message };
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

      // Send through the full DPOF print pipeline with the reprint suffix.
      // Images are read from result.reprintJobPath/originals/.
      const printResult = await printService._sendReprintViaDPOF(
        parentJob,
        result.reprintJobPath,
        reprintSuffix,
        result.reprintSidecar.images
      );

      if (!printResult.success) {
        logger.logWarning('Reprint folder created but print send failed', {
          reprintJobId,
          error: printResult.error
        });
      }

      // If the reprint was sent to a DPOF controller, resume status polling.
      if (printResult && printResult.success) {
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

async function _pollAwaitingJobs() {
  if (!_pollWindowManager) return;

  const mainWindow = _pollWindowManager.getWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { jobs } = jobService.getLocalJobs();

  // Collect { job, outputFolderPath } pairs for all DPOF jobs.
  // New routing system takes priority; old printControllerStore is the fallback.
  const dpofJobs = [];
  for (const job of jobs) {
    const route = routingService.resolveRoute(job);
    if (route.type === 'controller') {
      // New routing system — get outputPath from routingService
      const ctrl = routingService.getControllers().find(c => c.id === route.controllerId);
      if (ctrl && ctrl.outputPath) {
        dpofJobs.push({ job, outputFolderPath: ctrl.outputPath });
      }
    } else {
      // Fallback: old configService + printControllerStore
      const mapping = configService.getProcessMapping(job.process);
      if (mapping.controllerId) {
        const ctrl = printControllerStore.getController(mapping.controllerId);
        if (ctrl && ctrl.type !== 'darkroompro' && ctrl.hotFolderPath) {
          dpofJobs.push({ job, outputFolderPath: ctrl.hotFolderPath });
        }
      }
    }
  }

  let hasAwaitingJobs = false;

  for (const { job, outputFolderPath } of dpofJobs) {
    try {
      const status     = await getJobOutputStatus(job, outputFolderPath);

      if (!status) continue;

      const jid = String(job.id);

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

async function runAutoPrint() {
  if (_autoPrintRunning) return;
  _autoPrintRunning = true;
  try {
    const { jobs } = jobService.getLocalJobs();
    const controllers = routingService.getControllers();

    const daysBack = configService.get('jobDateRange') ?? 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);

    for (const job of jobs) {
      if (job._status !== 'received' && job._status !== 'pending') continue;
      if (job.created_at && new Date(job.created_at) < cutoff) continue;

      // AI Quality Gate (v1.2.0) — score the job before dispatching. If
      // any image fails the threshold, the job is held this pass.
      // Operator releases via the Quality flag on the Jobs grid (M2).
      // Flag-OFF behaviour: this whole block is skipped, byte-identical
      // to pre-feature behaviour.
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

      const route = routingService.resolveRoute(job);

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
      const DPOF_TYPES = new Set(['noritsu', 'epson', 'dpof']);
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
        // Generalized in v1.3.2 — the previous manifest-only special case
        // was added to break a retry loop on that specific error, but every
        // other dispatch error class still retry-looped. The eligibility
        // filter at line 1704 excludes jobs in _status: 'error' from future
        // cycles, so propagating the error message AND setting status to
        // 'error' breaks the retry loop for ALL error classes consistently.
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

    // Build filename (basename) → quantity map
    const map = new Map();
    for (const img of (jobEntry.images || [])) {
      const basename = path.basename(img.filename);
      const qty      = Number(img.quantity);
      if (basename && Number.isFinite(qty) && qty > 0) {
        map.set(basename, qty);
      }
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
    const s3Config = folderWatchService._buildS3Config(config, roll.locationId);
    if (!s3Config) {
      return { ok: false, error: 'S3 is not configured (check Connection settings)' };
    }

    // Mark uploading so concurrent panel reads can show a spinner / disable
    // the button. The renderer also disables locally on click but the store
    // value matters if the user reopens the panel mid-upload.
    frameMetadataStore.updateRoll(rollId, { uploadStatus: 'uploading', uploadError: null });
    emitFilmReviewRollUpdate(rollId);

    let result;
    try {
      result = await s3Service.uploadFolder(roll.storagePath, roll.s3Prefix, s3Config, (progress) => {
        logger.info(`[filmReview] approve-roll ${rollId}: ${progress.message}`);
      });
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
