'use strict';

/**
 * src/main/services/fuji-pic-pro-monitor.js
 *
 * State-machine monitor for the Fuji PIC Pro OrderGateway handshake.
 * Companion to `fuji-pic-pro-file-writer.js` — the writer does the disk
 * I/O for each phase; the monitor picks the phase and re-issues the
 * next action as the previous one completes.
 *
 * The four phases and their transitions:
 *
 *   awaiting-gateway  {orderDataPath}/{orderId}.txt still on disk
 *                     → gone: transition to `delivering`
 *                     → age ≥ gatewayTimeoutMs: emit `failed`, drop
 *
 *   delivering        no watch; perform the DIGIN move now
 *                     → move succeeded: transition to `building`
 *                     → move failed: emit `failed`, drop
 *
 *   building          {diginPath}/{orderId} still on disk
 *                     AND (if mergeDataPath) {mergeDataPath}/{orderId}.con
 *                     OR {mergeDataPath}/{orderId}/ still on disk
 *                     → all cleared: transition to `releasing`
 *                     → age ≥ buildTimeoutMs: emit `timed_out`, drop
 *
 *   releasing         no watch; write [release]{orderId} if the
 *                     controller has sendReleaseCommand=true, otherwise
 *                     no-op → emit `accepted`, drop
 *
 * Why a queue and not an inline wait: `runAutoPrint()` dispatches jobs
 * sequentially, so an inline `await` on the handshake would stall
 * every subsequent job for the full timeout whenever OrderGateway is
 * stopped. And an app restart mid-wait would strand the order — .txt
 * consumed, images never delivered. Persisting state in an electron-
 * store lets a restart resume where the previous session left off.
 *
 * Sweep cadence:
 *   - 1 s while anything is pending — the file-vanish signal is what
 *     unblocks the next phase, so faster than 1 s means we spin, but
 *     slower than 1 s means an artificially-added latency per order.
 *   - 60 s when idle — heartbeat + cheap-enough to leave the interval
 *     armed. .unref() so it can't hold the Electron main process open.
 *   - `fs.watch` on both watched paths is added as a debounced
 *     accelerator inside try/catch. The interval sweep is the source
 *     of truth; watch is unreliable on SMB shares.
 *
 * Callback payload mirrors JobMaker so print-controller-service can
 * reuse its wiring:
 *
 *   { orderRef, status: 'accepted' | 'failed' | 'timed_out',
 *     phase, timestamp }
 *
 * See docs/fuji-pic-pro-claude-code-brief.md §M4 for the full design.
 */

const nodeFs = require('node:fs');
const path   = require('node:path');
const Store  = require('electron-store');

// Lazy require of the real file-writer module — falls through to
// `require('./fuji-pic-pro-file-writer')` only if the monitor
// instance has no `deps.fileWriter`. Kept as a module-level cache
// so multiple monitors on the same process share one require.
let _defaultFileWriter = null;
function _defaultWriter() {
  if (!_defaultFileWriter) _defaultFileWriter = require('./fuji-pic-pro-file-writer');
  return _defaultFileWriter;
}

// ── Constants ────────────────────────────────────────────────────────────────

// One electron-store file per controller so two `fujipicpro`
// controllers can't step on each other's queues. Pre-fix every
// monitor instance opened `fuji-picpro-pending.json` and wrote to
// the same `pending` key — each instance's `_persist()` erased the
// other's queue, and rehydrate rebuilt whichever won the last write.
// See docs/fuji-pic-pro-review-fixes.md item 6.
const STORE_NAME_PREFIX = 'fuji-picpro-pending';
const STORE_KEY         = 'pending';

/**
 * Sanitise a controllerId into a safe file-basename fragment. The
 * store name becomes the JSON file name on disk (via electron-store),
 * so any `/` `\` `..` etc. would be a path traversal. UUIDs are the
 * common case and pass through unchanged.
 */
function _sanitiseControllerIdForStoreName(controllerId) {
  return String(controllerId || 'unassigned')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
}

const DEFAULT_ACTIVE_SWEEP_MS = 1000;      // 1 s while anything is pending
const DEFAULT_IDLE_SWEEP_MS   = 60 * 1000; // 60 s heartbeat
const FS_WATCH_DEBOUNCE_MS    = 500;

const DEFAULT_GATEWAY_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_BUILD_TIMEOUT_MS   = 30 * 60 * 1000;

// Terminal state → the monitor drops the entry after emitting.
const TERMINAL_STATUSES = new Set(['accepted', 'failed', 'timed_out']);

// Fuji PIC Pro review fix 3 (2026-08-03).
// Require this many consecutive `_classifyPath === 'absent'` observations
// before treating a watched path as gone. A single missed stat under
// a transient network / permission blip on an SMB share is *not* the
// same signal as "OrderGateway consumed the file"; without this gate,
// a blip drives the next phase (DIGIN move / `[release]`) against an
// order that isn't ready. Value 2 is the minimum that filters a
// single-scan blip; larger values just add latency to happy-path
// transitions (1 s per extra observation at the active sweep cadence).
const REQUIRED_ABSENT_OBSERVATIONS = 2;

/**
 * Classify a filesystem path into 'present' | 'absent' | 'unknown'.
 * Only ENOENT counts as 'absent' — every other error (EACCES, EIO,
 * ENOTFOUND on an unmounted share, EBUSY, timeouts) is 'unknown', so
 * a phase gate can distinguish "confirmed gone" from "couldn't tell"
 * and keep the entry in its current phase until the answer is
 * unambiguous. See docs/fuji-pic-pro-review-fixes.md item 3.
 */
async function _classifyPath(fs, filePath) {
  try {
    await fs.promises.stat(filePath);
    return 'present';
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'absent';
    return 'unknown';
  }
}

// ── Monitor ─────────────────────────────────────────────────────────────────

class FujiPicProMonitor {
  /**
   * @param {object} [opts]
   * @param {object} [opts.deps] — {fs, fileWriter, store, logger, clock}
   *   All optional; defaults resolve to node:fs, the sibling file-
   *   writer module, a fresh electron-store, a no-op logger, and
   *   Date.now respectively. Tests inject to control time and
   *   filesystem shape.
   */
  constructor(opts = {}) {
    const deps = opts.deps || {};
    this._fs         = deps.fs         || nodeFs;
    this._fileWriter = deps.fileWriter || null;   // resolved lazily via _writer()
    this._store      = deps.store      || null;   // resolved lazily via _getStore()
    // Track whether the store was passed in by the caller (tests
    // typically pass an in-memory shim) vs lazy-created here so a
    // controllerId change doesn't discard a user-supplied store.
    this._storeIsUserSupplied = !!deps.store;
    this._logger     = deps.logger     || {
      info:       () => {}, warn:      () => {}, error:      () => {},
      logInfo:    () => {}, logWarning: () => {}, logError:  () => {},
    };
    this._clock      = deps.clock      || (() => Date.now());

    this._controller = null;   // active controller record (paths + timeouts + toggles)
    this._callback   = null;

    this._watchers   = new Map();  // path → fs.FSWatcher
    this._sweepTimer = null;
    this._sweepMs    = DEFAULT_IDLE_SWEEP_MS;
    this._watchDebounceTimer = null;
    // Fuji PIC Pro review fix 5. `_scan` is async and gets called from
    // both `setInterval` and the `fs.watch` debounce, neither of
    // which awaits. Without a mutex a DIGIN move that takes longer
    // than the 1 s sweep would re-enter and produce a half-copied
    // folder in DIGIN or drop the entry with no `[release]`. This
    // flag serialises scans across BOTH triggers.
    this._scanInFlight = false;

    // In-memory mirror of the persisted queue. Loaded on start,
    // rewritten to disk on every mutation.
    this._pending = new Map(); // orderId → entry
  }

  /**
   * Start monitoring for a specific controller. Idempotent — calling
   * again for the same controller re-attaches watchers without
   * losing the pending queue. Loads any pending entries persisted by
   * a previous session so an OHD restart mid-handshake resumes.
   *
   * @param {object} controller — the resolved routing controller object
   *   Must carry orderDataPath, diginPath, mergeDataPath (optional),
   *   sendReleaseCommand, gatewayTimeoutMs, buildTimeoutMs. The values
   *   in individual pending entries take precedence for that entry's
   *   own timeouts + paths (so a mid-flight order isn't affected by an
   *   operator editing the controller before its build completes).
   * @param {Function} callback — invoked per terminal transition:
   *   { orderRef, status, phase, timestamp }
   */
  startMonitoring(controller, callback) {
    if (this._sweepTimer) {
      // Idempotency — tear down before rebuilding.
      this.stopMonitoring();
    }
    // If the controllerId changed between starts, drop the cached
    // store so `_getStore()` computes a new namespaced filename
    // for the new controllerId. Only relevant for the lazy-created
    // store; a user-supplied store (tests) stays untouched.
    // In practice print-controller-service keeps one monitor per
    // controllerId so this rarely fires — the guard just keeps
    // `_getStore` internally consistent.
    const prevId = this._controller && this._controller.id;
    const nextId = controller && controller.id;
    if (prevId !== nextId && !this._storeIsUserSupplied) {
      this._store = null;
    }
    this._controller = controller || {};
    this._callback   = callback;

    // Restore persisted queue.
    this._loadFromStore();

    // Watch order-data + digin paths as accelerators. Watchers on
    // missing paths are silently skipped — the sweep is the source of
    // truth so this only affects latency.
    this._attachWatchers();

    // Kick off the sweep timer. Cadence flips between active/idle
    // based on _pending size.
    this._rescheduleSweep();
  }

  stopMonitoring() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    if (this._watchDebounceTimer) {
      clearTimeout(this._watchDebounceTimer);
      this._watchDebounceTimer = null;
    }
    for (const w of this._watchers.values()) {
      try { w.close(); } catch (_) { /* already closed */ }
    }
    this._watchers.clear();
    this._callback = null;
    // Keep _pending + _store so a subsequent startMonitoring can pick
    // up where we left off.
  }

  /**
   * Drop every tracked entry. Persist the empty state so a restart
   * doesn't rehydrate them.
   */
  clearTracked() {
    this._pending.clear();
    this._persist();
  }

  /**
   * Enqueue one submission. Called by the dispatch method
   * (`_sendViaFujiPicProRouted`, M5) immediately after
   * `writeOrderFile` returns. The entry's initial phase is
   * `awaiting-gateway` — the sweep will notice the .txt vanishing and
   * drive it forward.
   *
   * All the fields the state machine needs are captured on the entry
   * so mid-flight orders don't change behaviour if the operator edits
   * the parent controller (paths, timeouts, release toggle).
   *
   * @param {object} args
   * @param {string} args.orderRef       — human-readable identifier
   * @param {string} args.orderId        — used for filesystem paths
   * @param {string} args.stagingFolder  — output of stageImages
   * @param {string} args.controllerId
   * @param {string} args.orderDataPath
   * @param {string} args.diginPath
   * @param {string} [args.mergeDataPath]
   * @param {number} [args.gatewayTimeoutMs]
   * @param {number} [args.buildTimeoutMs]
   * @param {boolean} [args.sendReleaseCommand]
   * @param {string[]} [args.jobIds] — JobStore ids to stamp with
   *   `_status:'error'` if this submission terminates in failure.
   *   Single-job dispatch passes `[job.id]`; order-level dispatch
   *   passes every active job id in the group. Reprint dispatch
   *   leaves this empty so the parent job isn't errored by a
   *   sibling reprint's failure.
   * @returns {object} the persisted entry
   */
  enqueueSubmission(args) {
    if (!args || !args.orderId) {
      throw new Error('Fuji PIC Pro monitor: enqueueSubmission requires `orderId`');
    }
    if (!args.stagingFolder || !args.orderDataPath || !args.diginPath) {
      throw new Error('Fuji PIC Pro monitor: enqueueSubmission requires stagingFolder, orderDataPath, diginPath');
    }
    // Fuji PIC Pro review fix 9. An orderId already in-flight cannot
    // be replaced silently — pre-fix `.set()` overwrote the prior
    // entry, dropping its `[release]` + timeout tracking while new
    // staging writes ran into the folder the first delivery was
    // still renaming. Reject and let the caller decide: legitimate
    // retry after a resolve, or a caller bug.
    if (this._pending.has(args.orderId)) {
      const existing = this._pending.get(args.orderId);
      const err = new Error(
        `Fuji PIC Pro monitor: submission for orderId "${args.orderId}" is already in-flight (phase: ${existing.phase}). ` +
        'Wait for the terminal callback before re-enqueueing, or call clearTracked() first.'
      );
      err.code = 'FUJI_PICPRO_DUPLICATE_SUBMISSION';
      err.existingPhase = existing.phase;
      throw err;
    }

    const now = this._clock();
    const entry = {
      orderRef:            args.orderRef || args.orderId,
      orderId:             args.orderId,
      controllerId:        args.controllerId || null,
      // 1.15.3 silent-stall fix: capture the JobStore ids so a
      // terminal-failure callback can stamp `_status:'error'`
      // via jobService.updateJobLocally in print-controller-service.
      // Kept as an array (order-level dispatch passes many) with
      // an empty default for reprints (which do not error the
      // parent) and older callers that don't know about the field.
      jobIds:              Array.isArray(args.jobIds) ? [...args.jobIds] : [],
      stagingFolder:       args.stagingFolder,
      orderDataPath:       args.orderDataPath,
      diginPath:           args.diginPath,
      mergeDataPath:       args.mergeDataPath || '',
      gatewayTimeoutMs:    Number.isFinite(args.gatewayTimeoutMs) ? args.gatewayTimeoutMs : DEFAULT_GATEWAY_TIMEOUT_MS,
      buildTimeoutMs:      Number.isFinite(args.buildTimeoutMs)   ? args.buildTimeoutMs   : DEFAULT_BUILD_TIMEOUT_MS,
      sendReleaseCommand:  args.sendReleaseCommand === true,
      phase:               'awaiting-gateway',
      submittedAt:         now,
      phaseStartedAt:      now,
      // Fuji PIC Pro review fix 11. The dispatch enqueues BEFORE
      // writing the .txt so a kill in the tiny gap leaves an
      // entry (recoverable via the timeout) rather than an
      // orphaned .txt that OrderGateway consumed with no tracking.
      // Monitor scans skip advancing until `markCommitted` flips
      // this flag; the awaiting-gateway timeout is the backstop.
      txtCommitted:        false,
    };

    this._pending.set(entry.orderId, entry);
    this._persist();
    this._rescheduleSweep();

    return entry;
  }

  /**
   * Fix 11 — signal to the monitor that the dispatch has finished
   * writing `{orderDataPath}/{orderId}.txt`. Only after this call
   * does `_stepAwaitingGateway` start observing the file for
   * OrderGateway consumption. Reset `phaseStartedAt` so the gateway
   * timeout window measures from commit time (which is when
   * OrderGateway can actually pick up the file), not from enqueue.
   *
   * Silent no-op when the orderId is unknown — the entry may have
   * been resolved (dropped from `_pending`) between enqueue and
   * commit, in which case there's nothing to update.
   */
  markCommitted(orderId) {
    const entry = this._pending.get(orderId);
    if (!entry) return;
    entry.txtCommitted   = true;
    entry.phaseStartedAt = this._clock();
    this._persist();
  }

  /**
   * Fix 11 — remove an in-flight submission without firing a
   * callback. Used by dispatch when `writeOrderFile` throws AFTER
   * `enqueueSubmission` succeeded, so the caller decides how to
   * surface the failure (via its own `_status:'error'` stamp on
   * the job) rather than the monitor emitting a redundant
   * terminal callback.
   */
  dequeue(orderId) {
    const removed = this._pending.delete(orderId);
    if (removed) this._persist();
    return removed;
  }

  /** Return a snapshot of the queue (test / debug hook). */
  getPending() {
    return [...this._pending.values()].map((e) => ({ ...e }));
  }

  // ── Test hook ────────────────────────────────────────────────────────────

  /**
   * Force one sweep cycle with a caller-supplied `now`. Returns a
   * promise so tests can await the async transitions
   * (delivering / releasing perform I/O).
   */
  async _scanNow(now) {
    return await this._scan(now === undefined ? this._clock() : now);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _attachWatchers() {
    const paths = new Set();
    if (this._controller.orderDataPath) paths.add(this._controller.orderDataPath);
    if (this._controller.diginPath)     paths.add(this._controller.diginPath);
    if (this._controller.mergeDataPath) paths.add(this._controller.mergeDataPath);

    for (const p of paths) {
      try {
        // Skip missing paths silently — the sweep can still detect
        // transitions the moment the path is created.
        if (!this._fs.existsSync(p)) continue;
        const watcher = this._fs.watch(p, () => {
          if (this._watchDebounceTimer) clearTimeout(this._watchDebounceTimer);
          this._watchDebounceTimer = setTimeout(() => {
            this._watchDebounceTimer = null;
            this._scan(this._clock()).catch(() => { /* logged inside */ });
          }, FS_WATCH_DEBOUNCE_MS);
        });
        watcher.on('error', () => {
          try { watcher.close(); } catch (_) { /* ignore */ }
          this._watchers.delete(p);
        });
        this._watchers.set(p, watcher);
      } catch (_) {
        // Non-fatal — watchers are accelerators; the sweep will still fire.
      }
    }
  }

  _rescheduleSweep() {
    const desired = this._pending.size > 0
      ? DEFAULT_ACTIVE_SWEEP_MS
      : DEFAULT_IDLE_SWEEP_MS;
    if (this._sweepTimer && this._sweepMs === desired) return;
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this._sweepMs    = desired;
    this._sweepTimer = setInterval(() => {
      this._scan(this._clock()).catch(() => { /* logged inside */ });
    }, this._sweepMs);
    if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
  }

  async _scan(now) {
    if (!this._callback) return;
    // Fuji PIC Pro review fix 5. Serialise scans — a slow DIGIN move
    // MUST NOT be re-entered by the next interval tick or the watch
    // debounce. If a scan is already in flight, skip: the in-flight
    // scan re-checks the queue on completion (via `_rescheduleSweep`
    // at the end + the fact that the next interval fires 1 s later
    // anyway), so no work is lost.
    if (this._scanInFlight) return;
    this._scanInFlight = true;
    try {
      // Snapshot to avoid mutating-while-iterating when a callback
      // enqueues a new order.
      const entries = [...this._pending.values()];
      for (const entry of entries) {
        try {
          // Keep advancing the same entry as long as each step
          // transitioned synchronously — `delivering` and `releasing`
          // have no wait signal (they perform their own I/O), so one
          // sweep should carry an entry through them without pausing.
          // The wait phases (`awaiting-gateway`, `building`) return
          // without changing the phase and break the loop naturally.
          let previousPhase;
          do {
            previousPhase = entry.phase;
            await this._stepEntry(entry, now);
            // Terminal → the entry has been deleted from _pending.
          } while (this._pending.has(entry.orderId) && entry.phase !== previousPhase);
        } catch (err) {
          (this._logger.logError || this._logger.error || (() => {})).call(
            this._logger,
            '[fuji-pic-pro] entry step failed — emitting failed status',
            err,
            { orderId: entry.orderId, phase: entry.phase },
          );
          // Preserve the original error's message so the operator
          // sees exactly what step blew up, rather than a generic
          // "delivery failed" text.
          this._resolveEntry(entry, 'failed', now, err);
        }
      }
      // Fast → slow cadence switch when the queue drains.
      this._rescheduleSweep();
    } finally {
      // Always clear the flag, even if the loop throws — otherwise
      // one bad scan permanently locks the monitor.
      this._scanInFlight = false;
    }
  }

  async _stepEntry(entry, now) {
    switch (entry.phase) {
      case 'awaiting-gateway':
        return this._stepAwaitingGateway(entry, now);
      case 'delivering':
        return this._stepDelivering(entry, now);
      case 'building':
        return this._stepBuilding(entry, now);
      case 'releasing':
        return this._stepReleasing(entry, now);
      default:
        // Unknown phase — safety net. Drop the entry.
        this._resolveEntry(entry, 'failed', now, new Error(
          `Fuji PIC Pro monitor entered an unknown phase "${entry.phase}" for order ${entry.orderId}. ` +
          'This is a programmer error — please report it. The order was abandoned; retry the dispatch.'
        ));
        return undefined;
    }
  }

  async _stepAwaitingGateway(entry, now) {
    // Fuji PIC Pro review fix 11. Two-phase enqueue:
    //   1. Dispatch calls enqueueSubmission (entry created,
    //      txtCommitted=false).
    //   2. Dispatch writes the .txt.
    //   3. Dispatch calls markCommitted (txtCommitted=true, phase
    //      timer reset).
    // Without this gate, a crash between (2) and (3), or between
    // (1) and (2), would let the classifier see 'absent' → advance
    // to delivering → move images into DIGIN with no OrderGateway
    // order behind them. Skip the observation entirely until
    // dispatch signals it committed.
    if (!entry.txtCommitted) {
      if ((now - entry.phaseStartedAt) >= entry.gatewayTimeoutMs) {
        // Never committed by the gateway timeout — the write must
        // have failed AND dispatch didn't dequeue (crash between
        // enqueue and write). Resolve as failed. No .txt cleanup
        // needed because there's nothing on disk to unlink.
        this._resolveEntry(entry, 'failed', now, new Error(
          `Fuji PIC Pro dispatch was aborted between the enqueue and the .txt write for order ${entry.orderId}. ` +
          'No order file was submitted to OrderGateway. This usually means OHD was killed (or crashed) mid-dispatch, ' +
          'or the .txt write failed with an error that was already surfaced on the Jobs grid. Retry the dispatch.'
        ));
      }
      return;
    }

    const txtPath = path.join(entry.orderDataPath, `${entry.orderId}.txt`);
    const state   = await _classifyPath(this._fs, txtPath);

    if (state === 'absent') {
      // Fuji PIC Pro review fix 3: require two consecutive absent
      // observations before advancing so a single momentary SMB
      // blip can't drive delivery of images to DIGIN while the
      // OrderGateway hasn't actually consumed the .txt yet. Counter
      // lives in memory only — a restart resets to 0 so a rehydrated
      // entry re-observes before moving.
      entry._absentTicks = (entry._absentTicks || 0) + 1;
      if (entry._absentTicks >= REQUIRED_ABSENT_OBSERVATIONS) {
        entry._absentTicks = 0;
        this._advance(entry, 'delivering', now);
      }
      return;
    }

    // Any state that isn't "absent" — including 'present' AND
    // 'unknown' (EACCES / EIO / ENOTFOUND / etc.) — must reset the
    // counter and stay in phase. The whole point of the fix is that
    // existsSync-returns-false is not the same signal as
    // "OrderGateway consumed the file". The timeout below is the
    // backstop for a genuinely stuck Gateway.
    entry._absentTicks = 0;

    if ((now - entry.phaseStartedAt) >= entry.gatewayTimeoutMs) {
      // Fix 11 part B: best-effort clean up the .txt so it doesn't
      // sit in Order Data waiting for a future run that will never
      // come. If OrderGateway did consume it just before our
      // timeout, the unlink is a harmless ENOENT.
      try {
        await this._fs.promises.unlink(txtPath);
        (this._logger.info || (() => {})).call(this._logger,
          '[fuji-pic-pro] cleaned up unconsumed .txt after gateway timeout',
          { orderId: entry.orderId, txtPath },
        );
      } catch (unlinkErr) {
        if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          (this._logger.logWarning || this._logger.warn || (() => {})).call(this._logger,
            '[fuji-pic-pro] failed to clean up .txt after gateway timeout',
            { orderId: entry.orderId, txtPath, error: unlinkErr && unlinkErr.message },
          );
        }
      }
      const gatewayTimeoutSec = Math.round(entry.gatewayTimeoutMs / 1000);
      this._resolveEntry(entry, 'failed', now, new Error(
        `OrderGateway did not consume the order file within ${gatewayTimeoutSec}s for order ${entry.orderId}. ` +
        `Check that OrderGateway.exe is running and configured to watch Order Data at: ${entry.orderDataPath}. ` +
        `Also confirm the machine can reach that path (permissions / SMB share still mounted). ` +
        `The stale order file was cleaned up automatically — you can safely retry the dispatch once OrderGateway is back.`
      ));
    }
  }

  async _stepDelivering(entry, now) {
    // No filesystem watch to wait on — perform the DIGIN move now.
    // The writer picks path based on the outcome: same-volume rename
    // returns immediately, EXDEV triggers the N-lite cross-volume
    // path (copy to inbox + intra-DIGIN rename). See
    // `docs/picpro-cross-volume-investigation.md`.
    try {
      const { deliverToDigin } = this._fileWriter || _defaultWriter();
      await deliverToDigin({
        stagingFolder: entry.stagingFolder,
        diginPath:     entry.diginPath,
        orderId:       entry.orderId,
        controllerId:  entry.controllerId,
        deps:          { logger: this._logger, fs: this._fs },
      });
    } catch (err) {
      (this._logger.logError || this._logger.error || (() => {})).call(
        this._logger,
        '[fuji-pic-pro] DIGIN delivery failed',
        err,
        { orderId: entry.orderId, stagingFolder: entry.stagingFolder, diginPath: entry.diginPath },
      );
      this._resolveEntry(entry, 'failed', now, err);
      return;
    }
    this._advance(entry, 'building', now);
  }

  async _stepBuilding(entry, now) {
    const diginFolder = path.join(entry.diginPath, entry.orderId);
    const diginState  = await _classifyPath(this._fs, diginFolder);

    let mergeAbsent;
    if (entry.mergeDataPath) {
      // Spec (p. 369) — the containers may be flat (`{orderId}.con`)
      // or under a per-order subdirectory (`{orderId}/`) depending on
      // whether "Container Path Use Subdirs" is ticked in
      // OrderGateway. Check both — the build is only complete when
      // BOTH are ABSENT. An 'unknown' from either path (permission /
      // network blip) blocks advancement so `[release]` can't fire
      // against an order that hasn't actually finished building.
      const conPath    = path.join(entry.mergeDataPath, `${entry.orderId}.con`);
      const subdirPath = path.join(entry.mergeDataPath, entry.orderId);
      const conState    = await _classifyPath(this._fs, conPath);
      const subdirState = await _classifyPath(this._fs, subdirPath);
      mergeAbsent = (conState === 'absent') && (subdirState === 'absent');
    } else {
      mergeAbsent = true;
    }

    const cleared = (diginState === 'absent') && mergeAbsent;

    if (cleared) {
      entry._absentTicks = (entry._absentTicks || 0) + 1;
      if (entry._absentTicks >= REQUIRED_ABSENT_OBSERVATIONS) {
        entry._absentTicks = 0;
        this._advance(entry, 'releasing', now);
      }
      return;
    }
    entry._absentTicks = 0;

    if ((now - entry.phaseStartedAt) >= entry.buildTimeoutMs) {
      // Timed out — don't send [release] (the build hasn't finished,
      // releasing an incomplete order is worse than not printing at
      // all).
      const buildTimeoutMin = Math.round(entry.buildTimeoutMs / 60000);
      const mergeSuffix = entry.mergeDataPath
        ? ` and Merge Data path: ${entry.mergeDataPath}`
        : '';
      this._resolveEntry(entry, 'timed_out', now, new Error(
        `PIC Pro did not finish building order ${entry.orderId} within ${buildTimeoutMin} minutes. ` +
        `The DIGIN folder and any merge container are still present — PIC Pro is stalled or the operator ` +
        `console has manually held the job. Check PIC Pro's queue, then inspect DIGIN path: ${entry.diginPath}${mergeSuffix}. ` +
        `No [release] command was sent — releasing an incomplete build is worse than not printing at all. ` +
        `Retry the dispatch once PIC Pro is unblocked.`
      ));
    }
  }

  async _stepReleasing(entry, now) {
    if (entry.sendReleaseCommand === true) {
      try {
        const { writeCommandFile } = this._fileWriter || _defaultWriter();
        await writeCommandFile({
          orderDataPath: entry.orderDataPath,
          command:       'release',
          orderId:       entry.orderId,
          deps:          { fs: this._fs, clock: this._clock },
        });
      } catch (err) {
        (this._logger.logError || this._logger.error || (() => {})).call(
          this._logger,
          '[fuji-pic-pro] failed to write [release] command file',
          err,
          { orderId: entry.orderId },
        );
        // A failed release write is still an accepted order — the
        // operator can drop the release manually. Log + treat as
        // accepted rather than fail.
      }
    }
    this._resolveEntry(entry, 'accepted', now);
  }

  _advance(entry, nextPhase, now) {
    entry.phase          = nextPhase;
    entry.phaseStartedAt = now;
    // Reset the absent-observation counter on every transition so the
    // NEXT phase's gate starts from zero (and to avoid confusing a
    // stale counter from a previous phase's classifier).
    entry._absentTicks   = 0;
    this._persist();
  }

  /**
   * @param {object} entry
   * @param {'accepted'|'failed'|'timed_out'} status
   * @param {number} now
   * @param {Error} [err] — 1.15.3 silent-stall fix. Non-null for
   *   every failure/timed_out site so the callback (and downstream
   *   `jobService.updateJobLocally`) surfaces an operator-readable
   *   message on the Jobs grid instead of leaving the job at "in
   *   production" indefinitely. `accepted` calls pass `null`.
   */
  _resolveEntry(entry, status, now, err = null) {
    this._pending.delete(entry.orderId);
    this._persist();
    if (!TERMINAL_STATUSES.has(status)) {
      // Programmer error — treat as failed.
      status = 'failed';
    }
    this._emit(entry, status, now, err);
  }

  _emit(entry, status, now, err = null) {
    if (!this._callback) return;
    try {
      this._callback({
        orderRef:     entry.orderRef,
        jobIds:       Array.isArray(entry.jobIds) ? [...entry.jobIds] : [],
        status,
        phase:        entry.phase,
        timestamp:    new Date(now),
        // Present on every failure/timed_out; null on accepted.
        // Downstream adapter (print-controller-service.onPicProStatus)
        // passes this into jobService.updateJobLocally.
        errorMessage: err && err.message ? String(err.message) : null,
      });
    } catch (cbErr) {
      // Never let a callback throw take down the monitor. Log so it's
      // visible — a silent swallow makes debugging hopeless.
      (this._logger.logError || this._logger.error || (() => {})).call(
        this._logger,
        '[fuji-pic-pro] callback threw — swallowing so the monitor stays alive',
        cbErr,
        { orderRef: entry.orderRef, status },
      );
    }
  }

  _getStore() {
    if (this._store) return this._store;
    // Namespace by the active controller's id — fix 6. Falls back to
    // 'unassigned' when the monitor is somehow being started with no
    // controller (test path); production always has a controllerId
    // because print-controller-service.startMonitoring resolves one
    // before calling us.
    const controllerId = this._controller && this._controller.id;
    const storeName = `${STORE_NAME_PREFIX}-${_sanitiseControllerIdForStoreName(controllerId)}`;
    this._store = new Store({ name: storeName });
    return this._store;
  }

  _loadFromStore() {
    try {
      const persisted = this._getStore().get(STORE_KEY, []);
      if (!Array.isArray(persisted)) return;
      for (const entry of persisted) {
        if (entry && entry.orderId) {
          // Freeze-thaw is a good moment to blame any stray future
          // phase strings — treat as awaiting-gateway so the state
          // machine can reason about them without crashing.
          if (!['awaiting-gateway', 'delivering', 'building', 'releasing']
                .includes(entry.phase)) {
            entry.phase = 'awaiting-gateway';
            entry.phaseStartedAt = this._clock();
          }
          // The absent-observation counter is transient and must
          // reset on rehydrate — otherwise a persisted `_absentTicks: 1`
          // after a hard crash could let a fresh session advance on
          // the very first scan, silently defeating the two-observation
          // gate. Explicitly zero so post-restart still needs the full
          // observation window.
          entry._absentTicks = 0;
          this._pending.set(entry.orderId, entry);
        }
      }
    } catch (err) {
      (this._logger.logError || this._logger.error || (() => {})).call(
        this._logger,
        '[fuji-pic-pro] failed to load pending store on start — continuing with empty queue',
        err,
      );
    }
  }

  _persist() {
    try {
      this._getStore().set(STORE_KEY, [...this._pending.values()]);
    } catch (err) {
      (this._logger.logError || this._logger.error || (() => {})).call(
        this._logger,
        '[fuji-pic-pro] failed to persist pending queue — restart-safety compromised for this cycle',
        err,
      );
    }
  }
}

module.exports = {
  FujiPicProMonitor,
  _internals: {
    STORE_NAME_PREFIX,
    STORE_KEY,
    DEFAULT_ACTIVE_SWEEP_MS,
    DEFAULT_IDLE_SWEEP_MS,
    DEFAULT_GATEWAY_TIMEOUT_MS,
    DEFAULT_BUILD_TIMEOUT_MS,
    TERMINAL_STATUSES,
    REQUIRED_ABSENT_OBSERVATIONS,
    _classifyPath,
    _sanitiseControllerIdForStoreName,
  },
};
