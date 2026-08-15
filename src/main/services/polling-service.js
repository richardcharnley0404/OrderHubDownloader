const configService = require('./config-service');
const ftpService = require('./ftp-service');
const folderWatchService = require('./folder-watch-service');
const jobService = require('./job-service');
const jobDownloadService = require('./job-download-service');
const { createS3ArtworkDownloader } = require('./s3-artwork-downloader');
const { printControllerStore } = require('./print-controller-store');
const routingService = require('./routing-service');
const { printControllerService } = require('./print-controller-service');
const { FolderMonitor } = require('./folder-monitor');
const {
  CANONICAL_FIELD:  BATCH_LEDGER_FIELD,
  recordBatchAccepted,
  completeLedger,
  allBatchesAccepted,
  readLedger,
} = require('../../shared/batchLedger');
const logger = require('./logger');

// S3 artwork downloader — singleton, sibling of the FTP channel.
// M1 (2026-05-24); subsequent milestones extend the per-job hold gate
// + quantity math + Customer Originals plumbing.
const s3ArtworkDownloader = createS3ArtworkDownloader();

class PollingService {
  constructor() {
    this.intervalId = null;
    // Interval (ms) the currently-armed setInterval was created with.
    // Distinct from getPollingInterval() so applyServerCadence() can log
    // the true old→new delta after capabilities have already been merged
    // (updateFromCheckin fires first; without this the "old" reading would
    // already be the new value).
    this._activeIntervalMs = null;
    this.isPolling = false;
    this.lastCheckTime = null;
    // Wall-clock timestamp of the last completed syncJobStatusFromOH attempt
    // (M4 / ohd-api v1.4.0). null until the first attempt; also reset by
    // stop(). Set in a `finally` so a throwing sync still advances it and
    // can't spin every cycle.
    this.lastStatusSyncAt = null;
    // Injectable clock so cadence tests can drive time without patching
    // Date.now globally. Production always uses Date.now.
    this._now = () => Date.now();
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
   * Get polling interval in milliseconds.
   *
   * Routes through server-capabilities so the server-advertised value wins
   * everywhere it's read — start() at boot (including restarts against a
   * persisted value), applyServerCadence() on the fly, and getStatus() in
   * the UI. server-capabilities.getPollIntervalMs() falls back to
   * configService.get('pollingInterval') when nothing has been advertised.
   *
   * Lazy require to avoid pulling electron-store into polling-service at
   * module load — server-capabilities' Store constructor reads electron.app.
   */
  getPollingInterval() {
    const { serverCapabilities } = require('./server-capabilities');
    return serverCapabilities.getPollIntervalMs();
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
    this._activeIntervalMs = interval;

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
   * Re-clock the polling timer to the server-advertised interval, if any.
   * No-op unless polling is currently running — a change while stopped will
   * take effect on the next start() via serverCapabilities.getPollIntervalMs().
   *
   * Called by updater._checkIn when serverCapabilities.updateFromCheckin
   * reports that the poll cadence changed. Lazy-requires server-capabilities
   * to avoid pulling electron-store here at module load.
   */
  applyServerCadence() {
    if (!this.isPolling) return;
    const newMs = this.getPollingInterval();
    const oldMs = this._activeIntervalMs;
    if (newMs === oldMs) return;
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.intervalId = setInterval(() => {
      this.runAllModes();
    }, newMs);
    this._activeIntervalMs = newMs;
    logger.info('Polling interval updated from server', {
      oldSeconds: oldMs != null ? Math.round(oldMs / 1000) : null,
      newSeconds: Math.round(newMs / 1000),
    });
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
    this._activeIntervalMs = null;

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
      //
      // Cadence (M4 / ohd-api v1.4.0): when the server advertises
      // status_poll_interval_seconds, the sync only runs at that cadence
      // instead of every pollJobs cycle. When unadvertised, we fall back
      // to today's every-cycle behaviour (pre-1.4.0 servers).
      //
      // Accepted trade-off: at the default 300s cadence, a job completed
      // in OrderHub can take up to that long to clear from Awaiting
      // Processing. TODO: if that lag becomes annoying, a
      // forceStatusSyncNext() hook that resets lastStatusSyncAt to null
      // could be called after operator actions (mark complete, retry,
      // etc.) — do not build until asked.
      const { serverCapabilities } = require('./server-capabilities');
      const statusIntervalMs = serverCapabilities.getStatusPollIntervalMs();
      const nowMs = this._now();
      const statusDue = statusIntervalMs === null
        || this.lastStatusSyncAt === null
        || (nowMs - this.lastStatusSyncAt) >= statusIntervalMs;

      if (statusDue) {
        try {
          await jobService.syncJobStatusFromOH();
        } catch (syncErr) {
          logger.logWarning('Polling: syncJobStatusFromOH error', { error: syncErr.message });
        } finally {
          // Advance in finally so a throwing sync doesn't spin every cycle.
          this.lastStatusSyncAt = this._now();
        }
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
        // Track cross-job failures so we invalidate the pending etag at
        // most once per cycle. Any presign URL in the last /jobs/pending
        // response could be stale — a fresh 200 next cycle reissues them.
        let anyDownloadFailed = false;
        for (const job of pendingJobs) {
          if (Array.isArray(job.artwork_files) && job.artwork_files.length > 0) {
            try {
              const result = await s3ArtworkDownloader.downloadJobArtwork(job, downloadDirectory);
              if (result && Array.isArray(result.failed) && result.failed.length > 0) {
                anyDownloadFailed = true;
              }
            } catch (err) {
              // downloadJobArtwork never throws by contract, but defence-
              // in-depth: catch + log so a bug here can't take down the
              // poll cycle. checkLocalFiles will still run for the rest.
              logger.logError('[s3-artwork] downloadJobArtwork threw', err, { jobId: job.id });
              anyDownloadFailed = true;
            }
          }
        }
        if (anyDownloadFailed) {
          // Force the next fetchJobs to omit If-None-Match so we get a
          // fresh 200 with new presigned URLs, rather than 304ing against
          // the URLs that just failed. Self-heals expired-URL failures on
          // the very next cycle instead of waiting for the presign safety
          // window.
          jobService.invalidatePendingEtag();
        }
      }

      // Awaiting-manifest timeout (ms). Default 10 min, configurable via
      // electron-store. See config-service schema for rationale.
      const awaitingTimeoutMs = configService.get('awaitingManifestTimeoutMs');

      // For each pending job, check if files exist locally. Three-way decision:
      //   hasManifest                 → existing markReceived flow
      //   hasFiles && !hasManifest    → stamp _awaitingManifest; escalate to
      //                                 error if older than the timeout
      //   neither                     → still downloading, leave as-is
      for (const job of pendingJobs) {
        const result = jobDownloadService.checkLocalFiles(job);

        if (result.hasManifest) {
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
            // Manifest arrived — clear any prior awaiting-manifest stamps so
            // the renderer's badge/action branches return to the standard
            // received/pending state.
            if (job._awaitingManifest) {
              jobService.updateJobLocally(job.id, {
                _awaitingManifest: false,
                _awaitingManifestSince: null,
                _awaitingManifestPath: null,
              });
              logger.info('Polling: manifest arrived for previously-awaiting job', {
                jobId: job.id,
                orderNumber: job.order_number,
              });
            }
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
          continue;
        }

        if (result.hasFiles) {
          // Files present but manifest missing. Stamp _awaitingManifest on
          // first observation; on subsequent observations, check the timeout.
          if (!job._awaitingManifest) {
            const nowIso = new Date().toISOString();
            jobService.updateJobLocally(job.id, {
              _awaitingManifest: true,
              _awaitingManifestSince: nowIso,
              _awaitingManifestPath: result.manifestPath,
            });
            logger.info('Polling: job awaiting manifest', {
              jobId: job.id,
              orderNumber: job.order_number,
              manifestPath: result.manifestPath,
            });
            continue;
          }

          const sinceMs = Date.parse(job._awaitingManifestSince);
          if (Number.isFinite(sinceMs) && (Date.now() - sinceMs) > awaitingTimeoutMs) {
            // Bounded escalation — the existing sticky-error path takes over
            // (excluded from auto-print eligibility and OH-sync ACTIVE_LOCAL_STATUSES).
            jobService.updateJobLocally(job.id, {
              _status: 'error',
              _errorMessage: `Order manifest not received within ${Math.round(awaitingTimeoutMs / 60000)} minutes — check FTP / S3 delivery (${result.manifestPath})`,
              _awaitingManifest: false,
              _awaitingManifestSince: null,
              _awaitingManifestPath: null,
            });
            logger.logWarning('Polling: awaiting-manifest job escalated to error after timeout', {
              jobId: job.id,
              orderNumber: job.order_number,
              awaitingTimeoutMs,
              awaitingSince: job._awaitingManifestSince,
              manifestPath: result.manifestPath,
            });
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

    // M4: run one film-scan auto-assign match cycle after every job poll.
    // A newly-arrived film-dev job may match a roll that's already held,
    // so the matcher wants to catch it on the same tick rather than
    // waiting for the film-scans timer. Safe when the feature is off
    // (matcher no-ops on the config flag). Never throws to the caller.
    try {
      const config = configService.getAll();
      if (config.filmScanAutoAssignEnabled) {
        const filmScanAutoAssign = require('./film-scan-auto-assign');
        await filmScanAutoAssign.runMatchCycle(config, logger);
      }
    } catch (matcherErr) {
      logger.logError('Polling: auto-assign match cycle threw', matcherErr);
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
      lastStatusSync: this.lastStatusSyncAt,
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
        // Fuji-family types have their own dedicated monitors
        // (fuji-jobmaker-monitor + fuji-pic-pro-monitor) started
        // via `printControllerService.startMonitoring` — don't also
        // attach a DPOF FolderMonitor to them (it would look for
        // folder-rename events the Fuji IC never fires). PIC Pro
        // in particular sets `outputPath: ''` in its route, so
        // without this skip we'd log the spurious "no output path"
        // warning on every restart.
        if (c.type === 'fujijobmaker' || c.type === 'fujipicpro') continue;
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

    // Fuji PIC Pro review fix 4: boot / restart PIC Pro state-machine
    // monitors alongside the DPOF folder monitors so a persisted
    // pending queue rehydrates. Idempotent — `startMonitoring`
    // short-circuits on an already-running monitor, so this is safe
    // to call from `restartFolderMonitors` after every save.
    try {
      printControllerService.startAllPicProMonitors();
    } catch (err) {
      logger.logError('Error starting PIC Pro monitors at boot', err);
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

    // M1 (docs/epson-batch-splitting-brief.md) renamed the payload's
    // `productCode` → `rest`. Read both for graceful transition; the
    // field is used only in a diagnostic log line.
    const { jobId, batch, reprintSuffix, status, timestamp } = statusUpdate;
    const rest = statusUpdate.rest || statusUpdate.productCode;

    if (status !== 'accepted' && status !== 'failed') return;

    const job = jobService.findJobById(jobId);
    if (!job) {
      logger.info('Hot folder status change for job not in local cache — ignored', {
        controller: controller.name,
        jobId,
        rest,
        batch,
        reprintSuffix,
        status,
      });
      return;
    }

    // M1-review carry: a reprint folder must NOT mark the parent job
    // completed. The reprint's `_rN` sits in the folder-name
    // discriminator slot and comes through as `reprintSuffix` on the
    // callback. Log and stop — a reprint's terminal state is not the
    // parent's completion signal.
    if (reprintSuffix) {
      logger.info('Hot folder status change for a REPRINT folder — parent-job completion NOT stamped', {
        controller: controller.name,
        jobId:      job.id,
        reprintSuffix,
        status,
      });
      return;
    }

    // M4 completion roll-up (docs/epson-batch-splitting-brief.md).
    // Split-dispatch jobs carry a batch ledger; a single-batch signal
    // must NOT complete the parent — that only happens when every
    // batch reaches `e`. Any `q` marks the job errored (with the
    // failing batch named) but leaves the ledger visible for a
    // targeted resend.
    const ledger = readLedger(job);
    if (ledger && batch && Number.isInteger(batch.index)) {
      recordBatchAccepted(ledger, {
        index:  batch.index,
        prefix: status === 'accepted' ? 'e' : 'q',
        at:     timestamp.toISOString(),
      });
      jobService.updateJobLocally(job.id, { [BATCH_LEDGER_FIELD]: ledger });

      if (status === 'failed') {
        jobService.updateJobLocally(job.id, {
          _dpofFailed:   true,
          _dpofFailedAt: timestamp.toISOString(),
          _status:       'error',
          _errorMessage: `Batch ${batch.index} of ${batch.total} was rejected by the printer. Resend that batch from the job's actions.`,
        });
        logger.logWarning(`[dpof-batch] batch ${batch.index}/${batch.total} rejected`, {
          jobId: job.id, controller: controller.name,
        });
        this._notifyJobsUpdated();
        return;
      }

      // status === 'accepted' → check roll-up.
      if (allBatchesAccepted(ledger)) {
        completeLedger(ledger, timestamp.toISOString());
        jobService.updateJobLocally(job.id, {
          [BATCH_LEDGER_FIELD]: ledger,
          _dpofAccepted:        true,
          _dpofAcceptedAt:      timestamp.toISOString(),
        });
        logger.info('All batches accepted by printer — auto-marking split job as completed', {
          jobId:        job.id,
          totalBatches: ledger.totalBatches,
        });
        jobService.markCompleted(job.id)
          .then(() => this._notifyJobsUpdated())
          .catch((err) => {
            logger.logWarning('DPOF auto-complete API call failed — split job left uncompleted for manual retry', {
              jobId: job.id, error: err.message,
            });
            this._notifyJobsUpdated();
          });
        return;
      }

      logger.info(`[dpof-batch] batch ${batch.index}/${batch.total} accepted — awaiting remaining batches`, {
        jobId:            job.id,
        controller:       controller.name,
        acceptedSoFar:    ledger.batches.filter((b) => b && b.acceptedPrefix === 'e').length,
        totalBatches:     ledger.totalBatches,
      });
      this._notifyJobsUpdated();
      return;
    }

    // Unsplit dispatch (no ledger, or a monitor event without a batch
    // descriptor) — pre-M4 behaviour, byte-identical.
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
