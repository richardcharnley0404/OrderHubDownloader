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

// Lazy require so tests that stub-in the file writer don't pull the
// real fsPromises stack until needed.
let _fileWriter = null;
function _writer() {
  if (!_fileWriter) _fileWriter = require('./fuji-pic-pro-file-writer');
  return _fileWriter;
}

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_NAME = 'fuji-picpro-pending';
const STORE_KEY  = 'pending';

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
   * @returns {object} the persisted entry
   */
  enqueueSubmission(args) {
    if (!args || !args.orderId) {
      throw new Error('Fuji PIC Pro monitor: enqueueSubmission requires `orderId`');
    }
    if (!args.stagingFolder || !args.orderDataPath || !args.diginPath) {
      throw new Error('Fuji PIC Pro monitor: enqueueSubmission requires stagingFolder, orderDataPath, diginPath');
    }

    const now = this._clock();
    const entry = {
      orderRef:            args.orderRef || args.orderId,
      orderId:             args.orderId,
      controllerId:        args.controllerId || null,
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
    };

    this._pending.set(entry.orderId, entry);
    this._persist();
    this._rescheduleSweep();

    return entry;
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
        this._resolveEntry(entry, 'failed', now);
      }
    }
    // Fast → slow cadence switch when the queue drains.
    this._rescheduleSweep();
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
        this._resolveEntry(entry, 'failed', now);
        return undefined;
    }
  }

  async _stepAwaitingGateway(entry, now) {
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
      this._resolveEntry(entry, 'failed', now);
    }
  }

  async _stepDelivering(entry, now) {
    // No filesystem watch to wait on — perform the DIGIN move now.
    try {
      const { deliverToDigin } = _writer();
      await deliverToDigin({
        stagingFolder: entry.stagingFolder,
        diginPath:     entry.diginPath,
        orderId:       entry.orderId,
        deps:          { logger: this._logger, fs: this._fs },
      });
    } catch (err) {
      (this._logger.logError || this._logger.error || (() => {})).call(
        this._logger,
        '[fuji-pic-pro] DIGIN delivery failed',
        err,
        { orderId: entry.orderId, stagingFolder: entry.stagingFolder, diginPath: entry.diginPath },
      );
      this._resolveEntry(entry, 'failed', now);
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
      this._resolveEntry(entry, 'timed_out', now);
    }
  }

  async _stepReleasing(entry, now) {
    if (entry.sendReleaseCommand === true) {
      try {
        const { writeCommandFile } = _writer();
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

  _resolveEntry(entry, status, now) {
    this._pending.delete(entry.orderId);
    this._persist();
    if (!TERMINAL_STATUSES.has(status)) {
      // Programmer error — treat as failed.
      status = 'failed';
    }
    this._emit(entry, status, now);
  }

  _emit(entry, status, now) {
    if (!this._callback) return;
    try {
      this._callback({
        orderRef:  entry.orderRef,
        status,
        phase:     entry.phase,
        timestamp: new Date(now),
      });
    } catch (err) {
      // Never let a callback throw take down the monitor. Log so it's
      // visible — a silent swallow makes debugging hopeless.
      (this._logger.logError || this._logger.error || (() => {})).call(
        this._logger,
        '[fuji-pic-pro] callback threw — swallowing so the monitor stays alive',
        err,
        { orderRef: entry.orderRef, status },
      );
    }
  }

  _getStore() {
    if (this._store) return this._store;
    this._store = new Store({ name: STORE_NAME });
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
    STORE_NAME,
    STORE_KEY,
    DEFAULT_ACTIVE_SWEEP_MS,
    DEFAULT_IDLE_SWEEP_MS,
    DEFAULT_GATEWAY_TIMEOUT_MS,
    DEFAULT_BUILD_TIMEOUT_MS,
    TERMINAL_STATUSES,
    REQUIRED_ABSENT_OBSERVATIONS,
    _classifyPath,
  },
};
