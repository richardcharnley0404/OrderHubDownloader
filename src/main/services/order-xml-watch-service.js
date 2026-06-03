/**
 * Order XML hot folder watcher (Mode 4).
 *
 * Watches one or more hot folders concurrently — one chokidar instance per
 * enabled hot-folder config — and orchestrates the per-file lifecycle:
 *
 *   chokidar 'add' → read XML → parser.matches() sniff → parser.parse() →
 *   apiClient.submitOrder() → classify result → move file to processed/ or
 *   failed/ → emit ingestion record via onResult callback.
 *
 * The service is self-contained: dependencies (api client, parser registry,
 * config-service, logger, clock) are injected via constructor, so tests can
 * drive it end-to-end against a localhost mock OrderHub plus a real temp dir.
 *
 * Retry model (recap from the planning chat):
 *   - Parse error from truncated XML  → setTimeout retry: 1s, 2s, 4s, 8s, 16s.
 *     After 5 attempts → failed/ with code 'PARSE_ERROR'.
 *   - Validation error (DELETED_PRODUCT, MISSING_*) → failed/ immediately.
 *   - API success / 409 duplicate → processed/<MMDDYYYY>/.
 *   - API 4xx (validation_error / auth_error) → failed/.
 *   - API 5xx / network error → retry up to maxRetries (default 3, per-folder
 *     override allowed via config). After max → failed/.
 *
 * What this service deliberately does NOT do:
 *   - Persist ingestion records. That's the ingestion store (chunk 4); the
 *     watcher emits records to an `onResult` callback the caller plugs in.
 *   - Manage its own polling timer. The polling-service drives processAll()
 *     so file-watch and polling stay coordinated with the rest of OHD.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Backoff schedule for parse-error retries (XML may be mid-write). Each entry
// is the delay BEFORE the corresponding retry. After this many attempts the
// file moves to failed/ with the original parse error.
const PARSE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

// chokidar uses polling on Windows network shares; reuse the 2s interval that
// folder-monitor.js settled on.
const CHOKIDAR_POLL_INTERVAL_MS = 2000;

// Result statuses written into ingestion records. The panel groups by these.
const RESULT_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  DUPLICATE: 'duplicate',
  FAILED:    'failed',
});

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

class OrderXmlWatchService {
  /**
   * @param {object} deps
   * @param {object} deps.configService    - getEnabledHotFolders, getHotFolderMaxRetries, get('orderhubApiKey')
   * @param {object} deps.parserRegistry   - get(id), has(id)
   * @param {object} deps.apiClient        - submitOrder({ apiKey, request })
   * @param {object} [deps.chokidar]       - injectable for tests
   * @param {object} [deps.logger]
   * @param {function} [deps.onResult]     - called with each completed ingestion record
   * @param {function} [deps.now]          - clock fn for deterministic timestamps in tests
   */
  constructor(deps) {
    if (!deps || !deps.configService || !deps.parserRegistry || !deps.apiClient) {
      throw new Error(
        'OrderXmlWatchService: configService, parserRegistry, apiClient are required'
      );
    }
    this.configService  = deps.configService;
    this.parserRegistry = deps.parserRegistry;
    this.apiClient      = deps.apiClient;
    this.chokidar       = deps.chokidar  || require('chokidar');
    this.logger         = deps.logger    || _silentLogger();
    this.onResult       = deps.onResult  || (() => {});
    this.now            = deps.now       || (() => new Date());

    // hotFolderId → chokidar watcher
    this._watchers = new Map();
    // hotFolderId → { id, label, ...config }  (snapshot at start time)
    this._hotFolders = new Map();
    // Set of "filePath" currently being processed — guards against duplicate
    // chokidar add events firing for the same file.
    this._inFlight = new Set();
    // hotFolderId → Map<filePath, { attempts, lastError }>
    // Tracks submit-retry counters across processAll() ticks. Parse-retry uses
    // setTimeout instead so we don't block the polling tick.
    this._submitRetryCounts = new Map();

    this._started = false;
  }

  /**
   * Start watchers for every currently-enabled hot folder. Idempotent.
   */
  start() {
    if (this._started) return;
    this._started = true;
    this.reconcile();
  }

  /**
   * Stop every watcher and clear in-memory queues. Safe to call repeatedly.
   * Returns a promise that resolves when chokidar has fully closed.
   */
  async stop() {
    this._started = false;
    const closing = [];
    for (const [id, watcher] of this._watchers) {
      closing.push(this._safeClose(watcher, id));
    }
    this._watchers.clear();
    this._hotFolders.clear();
    this._inFlight.clear();
    this._submitRetryCounts.clear();
    await Promise.all(closing);
  }

  /**
   * Diff the current watcher set against the latest config. Adds missing
   * watchers, removes ones whose hot folder was disabled or deleted, and
   * restarts watchers whose watchFolder path changed.
   *
   * Called from start() and from the IPC settings-save handler.
   */
  async reconcile() {
    if (!this._started) return;
    const desired = this.configService.getEnabledHotFolders();
    const desiredIds = new Set(desired.map((hf) => hf.id));

    // Stop watchers that are no longer wanted, or whose path changed.
    for (const [id, watcher] of [...this._watchers]) {
      const current  = this._hotFolders.get(id);
      const wanted   = desired.find((hf) => hf.id === id);
      const stillOn  = wanted && wanted.watchFolder === (current && current.watchFolder);
      if (!desiredIds.has(id) || !stillOn) {
        await this._safeClose(watcher, id);
        this._watchers.delete(id);
        this._hotFolders.delete(id);
        this._submitRetryCounts.delete(id);
      }
    }

    // Start watchers that aren't running yet.
    for (const hf of desired) {
      if (!this._watchers.has(hf.id)) {
        this._startWatcher(hf);
      }
    }
  }

  /**
   * Drain submit-retry queue for every hot folder. Called by polling-service
   * on its tick. Files with parse-retry pending are NOT touched here — those
   * are owned by the setTimeout in _scheduleParseRetry.
   */
  async processAll() {
    if (!this._started) return;
    for (const [, hotFolder] of this._hotFolders) {
      const queue = this._submitRetryCounts.get(hotFolder.id);
      if (!queue || queue.size === 0) continue;
      // Snapshot first — entries may mutate during processing.
      const pending = [...queue.keys()];
      for (const filePath of pending) {
        if (this._inFlight.has(filePath)) continue;
        if (!fs.existsSync(filePath)) {
          // File vanished (operator deleted or external move) — drop counter.
          queue.delete(filePath);
          continue;
        }
        await this._processFile(hotFolder, filePath);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private — watcher lifecycle
  // -------------------------------------------------------------------------

  _startWatcher(hotFolder) {
    const watchPath = hotFolder.watchFolder;
    if (!watchPath) {
      this.logger.logWarning(`order-xml-watch: hot folder "${hotFolder.label}" has no watchFolder, skipping`);
      return;
    }

    // Make sure the destination subfolders exist so the first move doesn't fail
    // on a fresh install. processedFolder is the parent; date subfolders are
    // created on demand by _resolveDestPath.
    try { fs.mkdirSync(hotFolder.processedFolder, { recursive: true }); } catch (_) {}

    this.logger.info(
      `order-xml-watch: starting watcher for "${hotFolder.label}" on ${watchPath}`
    );

    const watcher = this.chokidar.watch(watchPath, {
      depth:         0,                  // only top-level files, no subfolders
      usePolling:    true,
      pollInterval:  CHOKIDAR_POLL_INTERVAL_MS,
      ignoreInitial: false,              // pick up files dropped while OHD was off
      persistent:    true,
      // chokidar fires 'add' as soon as it sees the inode; for read-then-validate
      // we let _processFile detect truncation rather than waiting on awaitWriteFinish.
    });

    watcher.on('add', (filePath) => {
      // Filter to *.xml only — chokidar would happily pick up sidecar files.
      if (!/\.xml$/i.test(filePath)) return;
      // Files inside processed/ or failed/ subfolders should never trigger us.
      // depth: 0 prevents that, but defend in case chokidar mis-reports.
      const dir = path.dirname(filePath);
      if (path.resolve(dir) !== path.resolve(watchPath)) return;
      this._processFile(hotFolder, filePath).catch((err) => {
        this.logger.logError(
          `order-xml-watch: unhandled error processing ${filePath}`,
          err
        );
      });
    });

    watcher.on('error', (err) => {
      this.logger.logError(`order-xml-watch: watcher error on ${watchPath}`, err);
    });

    this._watchers.set(hotFolder.id, watcher);
    this._hotFolders.set(hotFolder.id, { ...hotFolder });
    this._submitRetryCounts.set(hotFolder.id, new Map());
  }

  async _safeClose(watcher, id) {
    try {
      await watcher.close();
    } catch (err) {
      this.logger.logWarning(
        `order-xml-watch: error closing watcher for hot folder ${id}: ${err && err.message}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private — per-file processing
  // -------------------------------------------------------------------------

  /**
   * Read, parse, submit, and move a single XML file. Idempotent: re-entry
   * while already processing the same file is a no-op.
   */
  async _processFile(hotFolder, filePath) {
    if (this._inFlight.has(filePath)) return;
    this._inFlight.add(filePath);

    const filename = path.basename(filePath);
    let parser;
    let parseResult;

    try {
      parser = this.parserRegistry.get(hotFolder.sourceFormat);
    } catch (err) {
      // Misconfigured hot folder (sourceFormat doesn't exist). The watcher
      // shouldn't have started, but guard anyway.
      await this._handleHardFailure(hotFolder, filePath, 'CONFIG_ERROR',
        `Misconfigured hot folder: ${err.message}`, 0);
      this._inFlight.delete(filePath);
      return;
    }

    let xmlString;
    try {
      xmlString = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // Read failure (file vanished mid-handle, locked) — let chokidar fire
      // again later. Don't move the file or mark failure.
      this.logger.logWarning(
        `order-xml-watch: read failed for ${filePath}: ${err && err.message}`
      );
      this._inFlight.delete(filePath);
      return;
    }

    // Parse + validate. We thread the per-format productMap into the
    // hotFolderConfig so the parser's UNMAPPED_PRODUCTS gate (chunk 7a) can
    // hold back orders whose vendor codes the operator hasn't mapped yet.
    // Pulled fresh on every parse so settings changes apply immediately
    // without an app restart.
    // Prefer the config service (production path) over a productMap that
    // came in on the hot folder object directly (test path / legacy). Only
    // fall through to hotFolder.productMap when the config service hasn't
    // exposed getProductMappingsFor — keeps tests using the watcher
    // constructor without a full config service shim working.
    let productMap = hotFolder.productMap || new Map();
    if (typeof this.configService.getProductMappingsFor === 'function') {
      try {
        const fromCfg = this.configService.getProductMappingsFor(hotFolder.sourceFormat);
        if (fromCfg) productMap = fromCfg;
      } catch (mapErr) {
        this.logger.logWarning(
          `order-xml-watch: failed to load productMap for ${hotFolder.sourceFormat}: ${mapErr && mapErr.message}`
        );
      }
    }
    // Customer directory (RetailerDealerCode → name/email). Same pull-fresh
    // pattern as productMap so settings changes apply on the next file without
    // needing a watcher restart.
    let customerMap = hotFolder.customerMap || new Map();
    if (typeof this.configService.getCustomerMap === 'function') {
      try {
        const fromCfg = this.configService.getCustomerMap();
        if (fromCfg) customerMap = fromCfg;
      } catch (mapErr) {
        this.logger.logWarning(
          `order-xml-watch: failed to load customerMap: ${mapErr && mapErr.message}`
        );
      }
    }
    // Pickup location UUID — the lab's default location (one per OHD install).
    // Re-uses the existing `locationId` config from the polling settings since
    // the same value identifies "this lab" for both inbound polling and
    // pickup-order routing. Parser throws MISSING_PICKUP_LOCATION if a pickup
    // order is detected and this is empty.
    let pickupLocationId = hotFolder.pickupLocationId || '';
    if (this.configService.get) {
      try { pickupLocationId = String(this.configService.get('locationId') || '').trim() || pickupLocationId; }
      catch (_) { /* keep whatever the hotFolder carries */ }
    }
    const hotFolderForParser = { ...hotFolder, productMap, customerMap, pickupLocationId };

    try {
      parseResult = parser.parse(xmlString, hotFolderForParser);
    } catch (err) {
      this._inFlight.delete(filePath);
      if (err && err.code === 'PARSE_ERROR') {
        // Truncated / malformed XML — could be mid-write. Schedule a retry.
        this._scheduleParseRetry(hotFolder, filePath, err);
      } else {
        // Validation error — bad XML, no retry. Pass through err.details so
        // the panel's "Add Mapping" affordance has structured data to work
        // with (e.g. the unmappedCodes array on UNMAPPED_PRODUCTS errors).
        await this._handleHardFailure(
          hotFolder, filePath,
          (err && err.code) || 'VALIDATION_ERROR',
          (err && err.message) || 'Validation failed',
          0,
          null,
          err && err.details
        );
      }
      return;
    }

    // Submit to OrderHub.
    const apiKey = this.configService.get && this.configService.get('orderhubApiKey');
    if (!apiKey) {
      this.logger.logWarning(
        `order-xml-watch: no OrderHub API key configured; leaving ${filename} in place`
      );
      this._inFlight.delete(filePath);
      return;
    }

    let result;
    try {
      result = await this.apiClient.submitOrder({
        apiKey,
        request: parseResult.request,
        // Hot-folder orders are pre-paid + pre-validated by PhotoFinale, so
        // we auto-confirm them on submit. /api-webhook creates orders in
        // 'pending'; the chained call to /update-order-status bumps them
        // to 'confirmed' so the lab doesn't need a manual click. Confirm
        // failure is logged but doesn't fail the overall submission.
        confirmAfterSubmit: true,
      });
    } catch (err) {
      // submitOrder() should not throw on network failures (it returns
      // network_error classification). A throw here means programmer error.
      await this._handleHardFailure(
        hotFolder, filePath, 'API_CLIENT_ERROR',
        (err && err.message) || 'API client error', 0
      );
      this._inFlight.delete(filePath);
      return;
    }

    const queue = this._submitRetryCounts.get(hotFolder.id) || new Map();
    const attemptsSoFar = queue.get(filePath) ? queue.get(filePath).attempts + 1 : 1;

    if (result.classification === 'success') {
      queue.delete(filePath);
      await this._handleSuccess(hotFolder, filePath, parseResult, result, attemptsSoFar);
    } else if (result.classification === 'duplicate') {
      queue.delete(filePath);
      await this._handleDuplicate(hotFolder, filePath, parseResult, result, attemptsSoFar);
    } else if (result.classification === 'validation_error' ||
               result.classification === 'auth_error') {
      // Hard fail — won't get better on retry.
      queue.delete(filePath);
      await this._handleHardFailure(
        hotFolder, filePath,
        result.classification === 'auth_error' ? 'AUTH_ERROR' : 'VALIDATION_ERROR',
        result.errorMessage || `API rejected order (${result.statusCode})`,
        attemptsSoFar,
        parseResult
      );
    } else {
      // server_error / network_error — eligible for retry on next polling tick.
      const max = this.configService.getHotFolderMaxRetries(hotFolder);
      if (attemptsSoFar >= max) {
        queue.delete(filePath);
        await this._handleHardFailure(
          hotFolder, filePath,
          result.classification === 'network_error' ? 'NETWORK_ERROR' : 'SERVER_ERROR',
          result.errorMessage || `Submission failed after ${attemptsSoFar} attempt(s)`,
          attemptsSoFar,
          parseResult
        );
      } else {
        queue.set(filePath, { attempts: attemptsSoFar, lastError: result.errorMessage });
        this._submitRetryCounts.set(hotFolder.id, queue);
        this.logger.info(
          `order-xml-watch: ${filename} → transient ${result.classification} ` +
          `(attempt ${attemptsSoFar}/${max}); will retry on next tick`
        );
      }
    }

    this._inFlight.delete(filePath);
  }

  // -------------------------------------------------------------------------
  // Private — outcome handlers
  // -------------------------------------------------------------------------

  async _handleSuccess(hotFolder, filePath, parseResult, apiResult, attempts) {
    const filename = path.basename(filePath);
    const dest = await this._moveTo(filePath, hotFolder.processedFolder);
    this.logger.info(
      `order-xml-watch: submitted ${filename} → order_id=${apiResult.orderhubOrderId} ` +
      `(processed → ${dest})`
    );
    this._emit({
      hotFolderId:     hotFolder.id,
      hotFolderLabel:  hotFolder.label,
      sourceFormat:    hotFolder.sourceFormat,
      filename, filePath: dest,
      externalId:      parseResult.summary.externalId,
      customer:        parseResult.summary.customer,
      customerEmail:   parseResult.summary.customerEmail,
      total:           parseResult.summary.total,
      productSummary:  parseResult.summary.productSummary,
      lineItemCount:   parseResult.summary.lineItemCount,
      shippingMethod:  parseResult.summary.shippingMethod,
      status:          RESULT_STATUS.SUBMITTED,
      orderhubOrderId: apiResult.orderhubOrderId,
      errorMessage:    null,
      errorCode:       null,
      attempts,
      ingestedAt:      this.now().toISOString(),
      submittedAt:     this.now().toISOString(),
    });
  }

  async _handleDuplicate(hotFolder, filePath, parseResult, apiResult, attempts) {
    const filename = path.basename(filePath);
    const dest = await this._moveTo(filePath, hotFolder.processedFolder);
    this.logger.info(
      `order-xml-watch: duplicate ${filename} → existing_order_id=${apiResult.orderhubOrderId} ` +
      `(processed → ${dest})`
    );
    this._emit({
      hotFolderId:     hotFolder.id,
      hotFolderLabel:  hotFolder.label,
      sourceFormat:    hotFolder.sourceFormat,
      filename, filePath: dest,
      externalId:      parseResult.summary.externalId,
      customer:        parseResult.summary.customer,
      customerEmail:   parseResult.summary.customerEmail,
      total:           parseResult.summary.total,
      productSummary:  parseResult.summary.productSummary,
      lineItemCount:   parseResult.summary.lineItemCount,
      shippingMethod:  parseResult.summary.shippingMethod,
      status:          RESULT_STATUS.DUPLICATE,
      orderhubOrderId: apiResult.orderhubOrderId,
      errorMessage:    null,
      errorCode:       null,
      attempts,
      ingestedAt:      this.now().toISOString(),
      submittedAt:     this.now().toISOString(),
    });
  }

  /**
   * Move XML to <processedFolder>/failed/<MMDDYYYY>/ with a sidecar that
   * captures the error so the operator can act without diving into logs.
   */
  async _handleHardFailure(hotFolder, filePath, errorCode, errorMessage, attempts, parseResult = null, errorDetails = null) {
    const filename = path.basename(filePath);
    const failedRoot = path.join(hotFolder.processedFolder, 'failed');
    const dest = await this._moveTo(filePath, failedRoot);
    await this._writeErrorSidecar(dest, errorCode, errorMessage, attempts, errorDetails);
    this.logger.logWarning(
      `order-xml-watch: ${filename} → failed (${errorCode}: ${errorMessage}); ` +
      `moved to ${dest}`
    );
    const summary = (parseResult && parseResult.summary) || {};
    this._emit({
      hotFolderId:     hotFolder.id,
      hotFolderLabel:  hotFolder.label,
      sourceFormat:    hotFolder.sourceFormat,
      filename, filePath: dest,
      externalId:      summary.externalId      || null,
      customer:        summary.customer        || null,
      customerEmail:   summary.customerEmail   || null,
      total:           summary.total           || 0,
      productSummary:  summary.productSummary  || '',
      lineItemCount:   summary.lineItemCount   || 0,
      shippingMethod:  summary.shippingMethod  || '',
      status:          RESULT_STATUS.FAILED,
      orderhubOrderId: null,
      errorMessage,
      errorCode,
      // Structured error details (e.g. unmappedCodes for UNMAPPED_PRODUCTS).
      // Lets the panel's "Add Mapping" action seed the settings UI with the
      // exact codes that need a Pixfizz mapping, without parsing free-text.
      errorDetails:    errorDetails || null,
      attempts,
      ingestedAt:      this.now().toISOString(),
      submittedAt:     null,
    });
  }

  // -------------------------------------------------------------------------
  // Private — parse-retry (truncated-write) timer
  // -------------------------------------------------------------------------

  _scheduleParseRetry(hotFolder, filePath, lastError, attempt = 0) {
    if (attempt >= PARSE_RETRY_DELAYS_MS.length) {
      // Out of retries — treat as hard failure.
      this._handleHardFailure(
        hotFolder, filePath, 'PARSE_ERROR',
        `Parse failed after ${attempt} retries: ${lastError && lastError.message}`,
        attempt
      ).catch((err) => {
        this.logger.logError('order-xml-watch: handleHardFailure threw', err);
      });
      return;
    }
    const delay = PARSE_RETRY_DELAYS_MS[attempt];
    this.logger.info(
      `order-xml-watch: ${path.basename(filePath)} parse failed (attempt ${attempt + 1}/${PARSE_RETRY_DELAYS_MS.length}); retrying in ${delay}ms`
    );
    const timer = setTimeout(async () => {
      // File may have vanished while we waited.
      if (!fs.existsSync(filePath)) return;
      try {
        const xml = fs.readFileSync(filePath, 'utf8');
        // Re-run the parser; on success, fall through to submit by re-entering
        // _processFile (it'll see in-flight is clear and run end-to-end).
        // We pass productMap here too so a UNMAPPED_PRODUCTS-shaped failure
        // surfaces with the right code (the alternative — getting PARSE_ERROR
        // back from the same XML — would loop the parse-retry forever).
        const parser = this.parserRegistry.get(hotFolder.sourceFormat);
        let productMap = new Map();
        if (this.configService.getProductMappingsFor) {
          try { productMap = this.configService.getProductMappingsFor(hotFolder.sourceFormat) || new Map(); }
          catch (_) { /* fall through with empty map */ }
        }
        let customerMap = new Map();
        if (this.configService.getCustomerMap) {
          try { customerMap = this.configService.getCustomerMap() || new Map(); }
          catch (_) { /* fall through with empty map */ }
        }
        let pickupLocationId = '';
        if (this.configService.get) {
          try { pickupLocationId = String(this.configService.get('locationId') || '').trim(); }
          catch (_) { /* fall through with empty string */ }
        }
        parser.parse(xml, { ...hotFolder, productMap, customerMap, pickupLocationId });
        // OK — let normal _processFile do submit + move.
        this._processFile(hotFolder, filePath).catch((err) => {
          this.logger.logError('order-xml-watch: post-retry processFile threw', err);
        });
      } catch (err) {
        if (err && err.code === 'PARSE_ERROR') {
          this._scheduleParseRetry(hotFolder, filePath, err, attempt + 1);
        } else {
          // Now it's parsing but failing validation — hard fail.
          this._handleHardFailure(
            hotFolder, filePath,
            (err && err.code) || 'VALIDATION_ERROR',
            (err && err.message) || 'Validation failed',
            attempt + 1
          ).catch((e) => this.logger.logError('order-xml-watch: handleHardFailure threw', e));
        }
      }
    }, delay);
    // Make the timer non-blocking on app exit.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // -------------------------------------------------------------------------
  // Private — file move helpers
  // -------------------------------------------------------------------------

  /**
   * Move filePath into <destDir>/<MMDDYYYY>/. Creates the date subfolder if
   * needed. Returns the new absolute path. Resolves filename collisions by
   * appending _1, _2, ... before the extension.
   */
  async _moveTo(filePath, destDir) {
    const dateSub = this._getDateSubfolder();
    const target  = path.join(destDir, dateSub);
    fs.mkdirSync(target, { recursive: true });
    const finalPath = this._resolveDestPath(target, path.basename(filePath));
    // Use rename when possible (same volume); fall back to copy+unlink.
    try {
      fs.renameSync(filePath, finalPath);
    } catch (err) {
      if (err.code === 'EXDEV') {
        // Cross-device — copy then unlink.
        fs.copyFileSync(filePath, finalPath);
        fs.unlinkSync(filePath);
      } else {
        throw err;
      }
    }
    return finalPath;
  }

  /**
   * MMDDYYYY date subfolder, matching the existing filmScans / fileUploads
   * convention (see folder-watch-service.js _getDateSubfolder).
   */
  _getDateSubfolder() {
    const d = this.now();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear());
    return `${mm}${dd}${yy}`;
  }

  _resolveDestPath(dir, filename) {
    let candidate = path.join(dir, filename);
    if (!fs.existsSync(candidate)) return candidate;
    const ext  = path.extname(filename);
    const base = path.basename(filename, ext);
    let n = 1;
    while (true) { // eslint-disable-line no-constant-condition
      candidate = path.join(dir, `${base}_${n}${ext}`);
      if (!fs.existsSync(candidate)) return candidate;
      n++;
    }
  }

  /**
   * Write a sidecar JSON file next to the failed XML capturing the error.
   */
  async _writeErrorSidecar(failedXmlPath, errorCode, errorMessage, attempts, errorDetails = null) {
    const sidecarPath = `${failedXmlPath}.error.json`;
    const sidecar = {
      errorCode, errorMessage, attempts,
      // errorDetails carries structured context (e.g. { unmappedCodes: [...] })
      // so retry tooling and offline triage have the same data the panel does.
      errorDetails: errorDetails || null,
      failedAt:   this.now().toISOString(),
      originalFile: path.basename(failedXmlPath),
    };
    try {
      fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
    } catch (err) {
      this.logger.logWarning(
        `order-xml-watch: could not write error sidecar at ${sidecarPath}: ${err && err.message}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private — result emission
  // -------------------------------------------------------------------------

  _emit(record) {
    try {
      this.onResult(record);
    } catch (err) {
      this.logger.logError('order-xml-watch: onResult callback threw', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _silentLogger() {
  const noop = () => {};
  return { info: noop, logError: noop, logWarning: noop };
}

// ---------------------------------------------------------------------------

let _singleton = null;

function getOrderXmlWatchService() {
  if (_singleton) return _singleton;
  const configService  = require('./config-service');
  const parserRegistry = require('./order-xml-parsers');
  const ingestionStore = require('./order-xml-ingestion-store').getDefaultInstance();
  const logger         = require('./logger');
  const apiClient      = require('./orderhub-api-client').default;
  _singleton = new OrderXmlWatchService({
    configService, parserRegistry, apiClient, logger,
    onResult: (record) => ingestionStore.add(record),
  });
  return _singleton;
}

module.exports = {
  OrderXmlWatchService,
  RESULT_STATUS,
  PARSE_RETRY_DELAYS_MS,
  getOrderXmlWatchService,
};
