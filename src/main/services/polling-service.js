const configService = require('./config-service');
const ftpService = require('./ftp-service');
const folderWatchService = require('./folder-watch-service');
const jobService = require('./job-service');
const jobDownloadService = require('./job-download-service');
const { createS3ArtworkDownloader } = require('./s3-artwork-downloader');
const { printControllerStore } = require('./print-controller-store');
const routingService = require('./routing-service');
const { FolderMonitor } = require('./folder-monitor');
const logger = require('./logger');

// S3 artwork downloader — singleton, sibling of the FTP channel.
// M1 (2026-05-24); subsequent milestones extend the per-job hold gate
// + quantity math + Customer Originals plumbing.
const s3ArtworkDownloader = createS3ArtworkDownloader();

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
    // Independent Order XML timer (Mode 4)
    this.orderXmlIntervalId = null;
    this.lastOrderXmlCheckTime = null;
    // Hot folder monitors (controllerId -> FolderMonitor)
    this.folderMonitors = new Map();
  }

  /**
   * Get Order XML auto-sync interval from config (in milliseconds).
   * The chokidar watchers fire on file events; this timer's job is just to
   * drain the submit-retry queue and prune the ingestion store.
   */
  getOrderXmlInterval() {
    const minutes = configService.get('orderXmlAutoSyncMinutes') || 1;
    return minutes * 60 * 1000;
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
    const anyModeEnabled = config.pollingEnabled || config.filmScansEnabled ||
                           config.fileUploadsEnabled || config.orderXmlEnabled;

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

    // Order XML hot folders: independent timer + chokidar watchers
    if (config.orderXmlEnabled) {
      this._startOrderXmlTimer();
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
    this._stopOrderXmlTimer();
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
   *
   * Also sync local pending/received/in_production jobs against OH's
   * authoritative status — picks up out-of-band completion (job marked
   * complete or cancelled in OH UI / by another OHD instance / by an
   * integration) and clears the row from Awaiting Processing without
   * requiring a manual refresh.
   */
  async pollJobs() {
    try {
      logger.info('Polling: fetching jobs from API');

      const jobs = await jobService.fetchJobs();

      // Out-of-band completion sync. Runs after fetchJobs so any newly-
      // returned jobs are eligible, and before the file-presence loop so
      // a job that OH already considers terminal isn't re-marked received
      // on the same cycle. syncJobStatusFromOH is internally chunked and
      // tolerant of per-job failures, so it can't take down the cycle.
      try {
        await jobService.syncJobStatusFromOH();
      } catch (syncErr) {
        logger.logWarning('Polling: syncJobStatusFromOH error', { error: syncErr.message });
      }

      const pendingJobs = jobService.getLocalJobs().jobs.filter(j => j._status === 'pending');

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

      // S3 artwork channel (M1, 2026-05-24): download artwork for any
      // pending job with non-empty artwork_files[] BEFORE the
      // checkLocalFiles loop runs. Jobs with empty artwork_files[] are a
      // no-op; FTP-delivered jobs continue through the parallel FTP path
      // (scanFtp) unchanged. Errors here MUST NOT bail the poll cycle —
      // per-file failures land in the downloader's failed[] array, and the
      // next poll retries any file whose id isn't yet in the sidecar's
      // s3ArtworkFileIdsKnown. Serialised across jobs by design (V1);
      // each job runs up to 4 downloads in parallel internally.
      const downloadDirectory = configService.get('downloadDirectory');
      if (downloadDirectory) {
        for (const job of pendingJobs) {
          if (Array.isArray(job.artwork_files) && job.artwork_files.length > 0) {
            try {
              await s3ArtworkDownloader.downloadJobArtwork(job, downloadDirectory);
            } catch (err) {
              // downloadJobArtwork never throws by contract, but defence-
              // in-depth: catch + log so a bug here can't take down the
              // poll cycle. checkLocalFiles will still run for the rest.
              logger.logError('[s3-artwork] downloadJobArtwork threw', err, { jobId: job.id });
            }
          }
        }
      }

      // For each pending job, check if files exist locally
      for (const job of pendingJobs) {
        const result = jobDownloadService.checkLocalFiles(job);

        if (result.found) {
          // Receive-time missing-size validation removed in v1.3.2.
          // The check was over-broad — it fired for all controller types,
          // but missing image-level size only matters for DPOF dispatch.
          // The canonical missing-size validation lives at
          // print-service.js:236 (DPOF-scoped) and now propagates a clear
          // operator message via the generalized auto-print catch handlers
          // (see ipc-handlers.js:~1796).
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

  // ── Order XML hot folders independent timer (Mode 4) ──────

  /**
   * The chokidar watchers in OrderXmlWatchService handle file-arrival events
   * directly; this timer's job is to drain the submit-retry queue (transient
   * 5xx / network failures) and to prune the ingestion store. Cadence is
   * controlled by orderXmlAutoSyncMinutes (default 1 min).
   *
   * Lazy-required so the service file isn't loaded at app startup unless the
   * mode is actually enabled — keeps cold-start cheap.
   */
  _startOrderXmlTimer() {
    this._stopOrderXmlTimer();

    // Lazy-load so test environments and Mode-4-disabled installs don't pay
    // the chokidar require cost.
    const { getOrderXmlWatchService } = require('./order-xml-watch-service');
    const ingestionStore = require('./order-xml-ingestion-store').getDefaultInstance();
    const watcher = getOrderXmlWatchService();
    watcher.start();

    this._runOrderXml(); // initial drain

    const interval = this.getOrderXmlInterval();
    this.orderXmlIntervalId = setInterval(() => {
      this._runOrderXml();
    }, interval);

    logger.info('Order XML timer started', {
      interval: `${interval / 60000} minutes`,
      hotFolders: configService.getEnabledHotFolders().length
    });

    // Held for the stop() path so we can call ingestionStore.prune() and
    // watcher.stop() without re-requiring.
    this._orderXmlWatcher = watcher;
    this._orderXmlIngestionStore = ingestionStore;
  }

  _stopOrderXmlTimer() {
    if (this.orderXmlIntervalId) {
      clearInterval(this.orderXmlIntervalId);
      this.orderXmlIntervalId = null;
    }
    if (this._orderXmlWatcher) {
      // Fire-and-forget: stop() is async but we don't want to block app shutdown.
      this._orderXmlWatcher.stop().catch((err) => {
        logger.logWarning('Order XML watcher stop error', { error: err && err.message });
      });
      this._orderXmlWatcher = null;
    }
    this._orderXmlIngestionStore = null;
  }

  async _runOrderXml() {
    this.lastOrderXmlCheckTime = Date.now();
    if (!this._orderXmlWatcher) return;
    try {
      // Settings may have changed since the last tick (operator added/removed
      // a hot folder via the panel). Reconcile picks that up cheaply.
      await this._orderXmlWatcher.reconcile();
      await this._orderXmlWatcher.processAll();
      // Bound the ingestion store: drop anything older than retentionDays.
      if (this._orderXmlIngestionStore) {
        const removed = this._orderXmlIngestionStore.prune();
        if (removed > 0) {
          logger.info(`Order XML: pruned ${removed} record(s) past retention`);
        }
      }
    } catch (error) {
      logger.logError('Order XML: tick error', error);
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
      lastOrderXmlCheck: this.lastOrderXmlCheckTime,
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
        if (c.checkOrderStatus === false) {
          logger.info('Hot folder monitor skipped — checkOrderStatus disabled', { controller: c.name, id: c.id });
          continue;
        }
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
   *
   * Gated by config flag `autoCompleteOnPrinterAccept` (default false).
   * When OFF this is a full no-op — no log, no local writes, no API call.
   * When ON:
   *   - 'submitted' (p→o)  → ignored; the submission already pushed a UI update.
   *   - 'accepted'  (o→e)  → write _dpofAccepted/_dpofAcceptedAt, POST
   *                          {baseUrl}/jobs/{jobId}/completed, notify renderer.
   *                          On API failure: log warning, notify renderer, but
   *                          do NOT force-mark the job complete locally — leave
   *                          it visible and recoverable.
   *   - 'failed'    (o→q)  → write _dpofFailed/_dpofFailedAt, notify renderer.
   *   - unknown jobId      → silent (info log only, no warning spam).
   *
   * `findJobById` does Number() coercion at the boundary — the jobId from
   * folder-monitor is a regex group (string), the API's job.id is numeric.
   */
  _handleFolderStatusChange(statusUpdate, controller) {
    if (!configService.get('autoCompleteOnPrinterAccept')) return;

    const { jobId, productCode, status, timestamp } = statusUpdate;

    if (status !== 'accepted' && status !== 'failed') return;

    const job = jobService.findJobById(jobId);
    if (!job) {
      logger.info('Hot folder status change for job not in local cache — ignored', {
        controller: controller.name,
        jobId,
        productCode,
        status
      });
      return;
    }

    if (status === 'accepted') {
      jobService.updateJobLocally(job.id, {
        _dpofAccepted: true,
        _dpofAcceptedAt: timestamp.toISOString()
      });
      logger.info('Job DPOF accepted by printer — auto-marking as completed', { jobId: job.id });
      jobService.markCompleted(job.id)
        .then(() => this._notifyJobsUpdated())
        .catch(err => {
          logger.logWarning('DPOF auto-complete API call failed — job left uncompleted for manual retry', {
            jobId: job.id, error: err.message,
          });
          this._notifyJobsUpdated();
        });
    } else {
      jobService.updateJobLocally(job.id, {
        _dpofFailed: true,
        _dpofFailedAt: timestamp.toISOString()
      });
      logger.logWarning('Job DPOF rejected by printer', { jobId: job.id });
    }

    this._notifyJobsUpdated();
  }
}

module.exports = new PollingService();
