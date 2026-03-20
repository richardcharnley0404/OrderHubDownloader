const fs = require('fs');
const path = require('path');
const configService = require('./config-service');
const ftpService = require('./ftp-service');
const folderWatchService = require('./folder-watch-service');
const jobService = require('./job-service');
const jobDownloadService = require('./job-download-service');
const { printControllerStore } = require('./print-controller-store');
const routingService = require('./routing-service');
const { FolderMonitor } = require('./folder-monitor');
const logger = require('./logger');

class PollingService {
  constructor() {
    this.intervalId = null;
    this.isPolling = false;
    this.lastCheckTime = null;
    this.lastSummary = null;
    this.lastFolderWatchSummary = null;
    this.lastJobPollSummary = null;
    this.onJobsUpdated = null; // callback to notify renderer
    this.onAutoPrint   = null; // callback to trigger auto-print check
    // Independent Film Scans timer
    this.filmScansIntervalId = null;
    this.lastFilmScansCheckTime = null;
    // Independent File Uploads timer
    this.fileUploadsIntervalId = null;
    this.lastFileUploadsCheckTime = null;
    // Hot folder monitors (controllerId -> FolderMonitor)
    this.folderMonitors = new Map();
  }

  /**
   * Get polling interval from config (in milliseconds)
   */
  getPollingInterval() {
    const seconds = configService.get('pollingInterval') || 60;
    return seconds * 1000;
  }

  /**
   * Get Film Scans auto-sync interval from config (in milliseconds)
   */
  getFilmScansInterval() {
    const minutes = configService.get('filmScansAutoSyncMinutes') || 5;
    return minutes * 60 * 1000;
  }

  /**
   * Get File Uploads auto-sync interval from config (in milliseconds)
   */
  getFileUploadsInterval() {
    const minutes = configService.get('fileUploadsAutoSyncMinutes') || 5;
    return minutes * 60 * 1000;
  }

  /**
   * Start polling service
   */
  start() {
    if (this.isPolling) {
      logger.logWarning('Polling service already running');
      return;
    }

    const config = configService.getAll();
    const anyModeEnabled = config.pollingEnabled || config.filmScansEnabled || config.fileUploadsEnabled;

    if (!anyModeEnabled) {
      logger.logError('Cannot start polling: no modes enabled');
      throw new Error('No modes enabled');
    }

    logger.info('Starting polling service');
    this.isPolling = true;

    // Perform initial check immediately
    this.runAllModes();

    // Set up interval for subsequent checks
    const interval = this.getPollingInterval();
    this.intervalId = setInterval(() => {
      this.runAllModes();
    }, interval);

    logger.info('Polling service started', {
      interval: `${interval / 1000} seconds`
    });

    // Film Scans: independent timer
    if (config.filmScansEnabled) {
      this._startFilmScansTimer();
    }

    // File Uploads: independent timer
    if (config.fileUploadsEnabled) {
      this._startFileUploadsTimer();
    }

    // Hot folder monitors for print controllers
    this._startFolderMonitors();
  }

  /**
   * Stop polling service
   */
  stop() {
    if (!this.isPolling) {
      logger.logWarning('Polling service not running');
      return;
    }

    logger.info('Stopping polling service');

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this._stopFilmScansTimer();
    this._stopFileUploadsTimer();
    this._stopFolderMonitors();

    this.isPolling = false;
    logger.info('Polling service stopped');
  }

  /**
   * Run all enabled modes
   */
  async runAllModes() {
    this.lastCheckTime = Date.now();

    const config = configService.getAll();

    // Mode 1: FTP scan & download (downloads artwork files to local disk)
    if (config.pollingEnabled && configService.isConfigured()) {
      await this.scanFtp();
    }

    // Job polling: fetch pending jobs from API, check local files, mark received
    if (config.pollingEnabled && config.orderhubApiKey) {
      await this.pollJobs();
    }

    // Mode 2 & 3 now have their own independent timers
  }

  /**
   * Poll OrderHub API for pending jobs and check if files exist locally.
   * If files found → mark job as received via API.
   */
  async pollJobs() {
    try {
      logger.info('Polling: fetching jobs from API');

      const jobs = await jobService.fetchJobs();
      const pendingJobs = jobs.filter(j => j._status === 'pending');

      logger.info('Polling: job poll complete', {
        totalJobs: jobs.length,
        pendingJobs: pendingJobs.length
      });

      this.lastJobPollSummary = {
        totalJobs: jobs.length,
        pendingJobs: pendingJobs.length,
        receivedCount: 0,
        failedCount: 0
      };

      // For each pending job, check if files exist locally
      for (const job of pendingJobs) {
        const result = jobDownloadService.checkLocalFiles(job);

        if (result.found) {
          // Check manifest for images with missing size fields before marking received.
          // A missing size means the product is misconfigured in Pixfizz Core and the
          // job cannot be printed — flag it as a warning rather than receiving it.
          let hasMissingSize = false;
          const orderFolderPath = path.dirname(result.localPath);
          const manifestPath = path.join(orderFolderPath, `${job.order_number}.json`);
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            const jobEntry = (manifest.jobs || []).find(j => String(j.jobId) === String(job.id));
            if (jobEntry && Array.isArray(jobEntry.images) && jobEntry.images.some(img => !img.size)) {
              hasMissingSize = true;
            }
          } catch (manifestErr) {
            // Manifest not yet present or unreadable — proceed and let markReceived handle it
            logger.logWarning('Polling: could not read manifest for size check', {
              jobId: job.id,
              error: manifestErr.message
            });
          }

          if (hasMissingSize) {
            jobService.updateJobLocally(job.id, {
              _status: 'warning',
              _warningMessage: 'One or more images are missing a size — check product configuration in Pixfizz Core'
            });
            logger.logWarning('Polling: job has missing image sizes, marking as warning', {
              jobId: job.id,
              orderNumber: job.order_number
            });
            this.lastJobPollSummary.failedCount++;
            continue;
          }

          try {
            await jobService.markReceived(job.id, {
              timestamp: new Date().toISOString(),
              local_path: result.localPath,
              file_count: result.fileCount
            });
            this.lastJobPollSummary.receivedCount++;
            logger.info('Polling: job marked as received', {
              jobId: job.id,
              orderNumber: job.order_number,
              localPath: result.localPath,
              fileCount: result.fileCount
            });
          } catch (error) {
            this.lastJobPollSummary.failedCount++;
            logger.logError('Polling: failed to mark job as received', error, { jobId: job.id });
          }
        }
      }

      // Notify renderer of updated job list
      this._notifyJobsUpdated();

      // Trigger auto-print check for any newly-received jobs
      if (this.onAutoPrint) {
        this.onAutoPrint().catch(err => logger.logError('[auto-print] callback error', err));
      }

    } catch (error) {
      logger.logError('Polling: error polling jobs', error);
    }
  }

  /**
   * Scan FTP and download new files (legacy Mode 1)
   */
  async scanFtp() {
    try {
      logger.info('Polling: scanning FTP for new files');

      const credentials = configService.getFtpCredentials();
      const remotePath = configService.get('ftpRemotePath') || '/';
      const localBasePath = configService.get('downloadDirectory');

      if (!localBasePath) {
        logger.logError('Polling: download directory not configured');
        return;
      }

      const summary = await ftpService.scanAndDownload(
        credentials,
        remotePath,
        localBasePath,
        (progress) => {
          logger.info('Polling progress: ' + progress.message);
        }
      );

      this.lastSummary = summary;
      logger.info('Polling: scan complete', summary);
    } catch (error) {
      logger.logError('Polling: error scanning FTP', error);
    }
  }

  // ── Film Scans independent timer ───────────────────────────

  _startFilmScansTimer() {
    this._stopFilmScansTimer(); // clear if already running

    // Run immediately
    this._runFilmScans();

    const interval = this.getFilmScansInterval();
    this.filmScansIntervalId = setInterval(() => {
      this._runFilmScans();
    }, interval);

    logger.info('Film scans timer started', { interval: `${interval / 60000} minutes` });
  }

  _stopFilmScansTimer() {
    if (this.filmScansIntervalId) {
      clearInterval(this.filmScansIntervalId);
      this.filmScansIntervalId = null;
    }
  }

  async _runFilmScans() {
    this.lastFilmScansCheckTime = Date.now();
    try {
      const summary = await folderWatchService.processAll();
      if (summary) {
        this.lastFolderWatchSummary = {
          ...this.lastFolderWatchSummary,
          filmScans: summary.filmScans
        };
        logger.info('Film scans: processing complete', summary);
      }
    } catch (error) {
      logger.logError('Film scans: error processing', error);
    }
  }

  // ── File Uploads independent timer ──────────────────────────

  _startFileUploadsTimer() {
    this._stopFileUploadsTimer(); // clear if already running

    // Run immediately
    this._runFileUploads();

    const interval = this.getFileUploadsInterval();
    this.fileUploadsIntervalId = setInterval(() => {
      this._runFileUploads();
    }, interval);

    logger.info('File uploads timer started', { interval: `${interval / 60000} minutes` });
  }

  _stopFileUploadsTimer() {
    if (this.fileUploadsIntervalId) {
      clearInterval(this.fileUploadsIntervalId);
      this.fileUploadsIntervalId = null;
    }
  }

  async _runFileUploads() {
    this.lastFileUploadsCheckTime = Date.now();
    try {
      const summary = await folderWatchService.processFileUploads();
      if (summary) {
        this.lastFolderWatchSummary = {
          ...this.lastFolderWatchSummary,
          fileUploads: summary
        };
        logger.info('File uploads: processing complete', summary);
      }
    } catch (error) {
      logger.logError('File uploads: error processing', error);
    }
  }

  // ── Callbacks ─────────────────────────────────────────────

  /**
   * Set callback for job updates (used by IPC to send to renderer)
   */
  setJobsUpdatedCallback(callback) {
    this.onJobsUpdated = callback;
  }

  /**
   * Set callback invoked after each job poll cycle completes.
   * Used by the auto-print feature to dispatch eligible jobs.
   */
  setAutoPrintCallback(callback) {
    this.onAutoPrint = callback;
  }

  /**
   * Notify renderer of updated jobs
   */
  _notifyJobsUpdated() {
    if (this.onJobsUpdated) {
      try {
        this.onJobsUpdated(jobService.getLocalJobs());
      } catch (error) {
        logger.logError('Error notifying jobs updated', error);
      }
    }
  }

  /**
   * Get polling status
   */
  getStatus() {
    return {
      isRunning: this.isPolling,
      lastCheck: this.lastCheckTime,
      lastFilmScansCheck: this.lastFilmScansCheckTime,
      lastFileUploadsCheck: this.lastFileUploadsCheckTime,
      lastSummary: this.lastSummary,
      lastFolderWatchSummary: this.lastFolderWatchSummary,
      lastJobPollSummary: this.lastJobPollSummary,
      interval: this.getPollingInterval()
    };
  }

  /**
   * Check if polling is running
   */
  isRunning() {
    return this.isPolling;
  }

  // ── Hot Folder Monitors ──

  /**
   * Start monitoring hot folders for all active print controllers.
   * Detects when the printer renames folders (o->e accepted, o->q failed).
   *
   * Sources:
   *  - DPOF controllers: routingService.orderControllers (outputPath)
   *  - Darkroom Pro + legacy DPOF controllers: printControllerStore (hotFolderPath)
   *    Darkroom Pro entries are only in printControllerStore, never migrated.
   */
  _startFolderMonitors() {
    this._stopFolderMonitors(); // clean up any existing

    try {
      // Build a unified list of { id, name, folderPath } for all active DPOF controllers.
      // New routing-system controllers take precedence; old store fills the gaps.
      const monitorTargets = new Map(); // id → { id, name, folderPath }

      // 1. New routing-system DPOF controllers
      const orderControllers = routingService.getControllers();
      for (const c of orderControllers) {
        if (c.outputPath) {
          monitorTargets.set(c.id, { id: c.id, name: c.name, folderPath: c.outputPath });
        } else {
          logger.logWarning('Hot folder monitor skipped — no output path configured', { controller: c.name, id: c.id });
        }
      }

      // 2. Old printControllerStore — Darkroom Pro entries (and any not yet migrated)
      const legacyControllers = printControllerStore.getAllControllers();
      for (const c of legacyControllers) {
        if (c.isActive && c.hotFolderPath && !monitorTargets.has(c.id)) {
          monitorTargets.set(c.id, { id: c.id, name: c.name, folderPath: c.hotFolderPath });
        }
      }

      if (monitorTargets.size === 0) return;

      for (const target of monitorTargets.values()) {
        const monitor = new FolderMonitor();

        monitor.startMonitoring(target.folderPath, (statusUpdate) => {
          this._handleFolderStatusChange(statusUpdate, target);
        });

        this.folderMonitors.set(target.id, monitor);

        logger.info('Hot folder monitor started', {
          controller: target.name,
          path: target.folderPath,
        });
      }

      logger.info(`Started ${this.folderMonitors.size} hot folder monitor(s)`);
    } catch (error) {
      logger.logError('Error starting folder monitors', error);
    }
  }

  /**
   * Public: stop and restart all hot folder monitors.
   * Called whenever the controller list changes (save or delete) so monitors
   * reflect the current configuration without requiring an app restart.
   */
  restartFolderMonitors() {
    logger.info('Restarting hot folder monitors');
    this._startFolderMonitors();
  }

  /**
   * Stop all hot folder monitors.
   */
  _stopFolderMonitors() {
    if (this.folderMonitors.size === 0) return;

    for (const [controllerId, monitor] of this.folderMonitors) {
      monitor.stopMonitoring();
    }
    this.folderMonitors.clear();
    logger.info('All hot folder monitors stopped');
  }

  /**
   * Handle a folder status change from a hot folder monitor.
   * Maps printer folder renames to job status updates.
   */
  _handleFolderStatusChange(statusUpdate, controller) {
    const { orderNumber, productCode, status, timestamp } = statusUpdate;

    logger.info('Hot folder status change detected', {
      controller: controller.name,
      orderNumber,
      productCode,
      status
    });

    // Find the matching job in the local jobs list
    const job = jobService.findJobByOrderNumber(orderNumber);

    if (!job) {
      logger.logWarning('Hot folder status change for unknown job', {
        orderNumber,
        productCode,
        status
      });
      return;
    }

    // Map folder status to job updates
    if (status === 'accepted') {
      jobService.updateJobLocally(job.id, {
        _dpofAccepted: true,
        _dpofAcceptedAt: timestamp.toISOString()
      });
      logger.info('Job DPOF accepted by printer', { jobId: job.id, orderNumber });
    } else if (status === 'failed') {
      jobService.updateJobLocally(job.id, {
        _dpofFailed: true,
        _dpofFailedAt: timestamp.toISOString()
      });
      logger.logWarning('Job DPOF rejected by printer', { jobId: job.id, orderNumber });
    }

    // Push update to renderer immediately
    this._notifyJobsUpdated();
  }
}

module.exports = new PollingService();
