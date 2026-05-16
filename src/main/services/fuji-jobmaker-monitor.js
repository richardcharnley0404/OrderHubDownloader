'use strict';

const fs = require('fs');
const path = require('path');

/**
 * FujiJobMakerMonitor
 *
 * Watches a Frontier JobMaker hot folder for status transitions on submitted
 * `.txt` order files.
 *
 * Frontier offers only ONE in-band signal:
 *
 *   ACCEPTED: the tracked `.txt` disappears from the hot folder root.
 *             Frontier consumes the file once ingest succeeds.
 *
 * There is no failure marker — a rejected file simply remains in the hot folder
 * and an entry is appended to Frontier's universal log. To surface stuck files
 * the monitor runs a periodic scan: any tracked file still present after
 * `failureTimeoutMs` is reported with status `'timed_out'` for operator
 * attention. This is intentionally a weaker signal than DPOF folder renames or
 * Darkroom Pro `.err` files — see docs/print-controllers/FUJI-JOBMAKER-FORMAT.md
 * "Status Detection Mechanism".
 *
 * Periodic scan as source of truth:
 *   `fs.watch` is an *accelerator* — it triggers an immediate scan when an event
 *   fires. The interval-driven scan is what we trust for correctness, since
 *   fs.watch is unreliable on network shares (which is exactly where Frontier
 *   hot folders typically live). If fs.watch fails to attach we fall back to
 *   pure polling.
 *
 * Lifecycle:
 *   1. startMonitoring(hotFolderPath, options, callback)
 *   2. trackSubmission({ orderRef, surface, filename }) — call once per .txt
 *      written, immediately after the writer returns.
 *   3. Callback fires per tracked file as it transitions.
 *   4. stopMonitoring()
 *
 * Callback shape:
 *   {
 *     orderRef:  string,
 *     surface:   string,
 *     filename:  string,
 *     status:    'accepted' | 'timed_out',
 *     timestamp: Date,
 *   }
 *
 * Not a singleton — PrintControllerService creates one instance per Fuji
 * JobMaker controller, mirroring DarkroomProMonitor.
 */

const DEFAULT_FAILURE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min — matches spec default
const DEFAULT_SWEEP_INTERVAL_MS  = 60 * 1000;       // 60 s scan cadence
const FS_WATCH_DEBOUNCE_MS       = 500;             // settle time after a watch event

class FujiJobMakerMonitor {
  constructor() {
    this.hotFolderPath = null;
    this.callback = null;
    this.failureTimeoutMs = DEFAULT_FAILURE_TIMEOUT_MS;
    this.sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS;

    this.watcher = null;
    this.sweepTimer = null;
    this.watchDebounceTimer = null;

    // Map of filename (lowercase) → { orderRef, surface, filename, submittedAt }
    this.trackedFiles = new Map();
  }

  /**
   * Start monitoring. Idempotent — calling twice on the same instance closes
   * the previous watcher first.
   *
   * @param {string} hotFolderPath  Absolute path to Frontier's watch folder.
   * @param {object} [options]
   *   failureTimeoutMs  number  - default 30 * 60 * 1000
   *   sweepIntervalMs   number  - default 60 * 1000
   * @param {Function} callback   Called per status transition (see file docs).
   */
  startMonitoring(hotFolderPath, options, callback) {
    if (this.watcher || this.sweepTimer) {
      this.stopMonitoring();
    }

    this.hotFolderPath = hotFolderPath;
    this.callback = callback;
    this.failureTimeoutMs = (options && options.failureTimeoutMs) || DEFAULT_FAILURE_TIMEOUT_MS;
    this.sweepIntervalMs = (options && options.sweepIntervalMs) || DEFAULT_SWEEP_INTERVAL_MS;

    // Try to attach fs.watch. On network shares this can fail or fire spuriously;
    // we tolerate both — the sweep is the source of truth.
    try {
      this.watcher = fs.watch(hotFolderPath, (_eventType, _filename) => {
        // Debounce: many file system events fire in clusters for a single
        // logical change. Coalesce into one scan per quiet period.
        if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = setTimeout(() => {
          this.watchDebounceTimer = null;
          this._scan();
        }, FS_WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => {
        // Don't crash on a transient watch error. The sweep continues.
        this._closeWatcher();
      });
    } catch (_err) {
      // fs.watch unavailable on this filesystem — relying purely on the sweep.
      this.watcher = null;
    }

    this.sweepTimer = setInterval(() => this._scan(), this.sweepIntervalMs);
    // Don't keep the event loop alive for the sake of the timer alone — the
    // Electron main process has its own lifecycle.
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  /**
   * Register a file OHD just submitted. Call after FujiJobMakerFileWriter
   * succeeds for each surface file in the order.
   */
  trackSubmission({ orderRef, surface, filename }) {
    if (!filename) {
      throw new Error('Fuji JobMaker monitor: trackSubmission requires `filename`');
    }
    this.trackedFiles.set(filename.toLowerCase(), {
      orderRef: orderRef || null,
      surface:  surface  || null,
      filename,
      submittedAt: Date.now(),
    });
  }

  /**
   * Stop all watchers and timers. Tracked files are NOT cleared — restarting
   * the monitor (e.g. after a config change) re-uses the same tracking so
   * mid-flight orders aren't lost. Call `clearTracked()` to also drop those.
   */
  stopMonitoring() {
    this._closeWatcher();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    this.callback = null;
    this.hotFolderPath = null;
  }

  /**
   * Wipe tracking — useful when reconfiguring a controller. Existing in-flight
   * files will then be silently dropped from observation.
   */
  clearTracked() {
    this.trackedFiles.clear();
  }

  // ───────────────────────────────────────────────────────────────────────
  // Public for testing only
  // ───────────────────────────────────────────────────────────────────────

  /** Force an immediate scan. Used by tests to deterministically trigger logic. */
  _scanNow(now = Date.now()) {
    return this._scan(now);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Walk every tracked file and fire callbacks for transitions.
   *
   * For each tracked file:
   *   - If the file has disappeared from the hot folder → 'accepted'
   *   - If the file is still present and was submitted more than
   *     failureTimeoutMs ago → 'timed_out'
   *
   * Both outcomes remove the file from tracking so we don't fire the same
   * callback twice.
   */
  _scan(now = Date.now()) {
    if (!this.hotFolderPath || !this.callback) return;

    // Snapshot to avoid mutating-while-iterating issues if callbacks mutate state.
    const entries = [...this.trackedFiles.values()];

    for (const entry of entries) {
      const filePath = path.join(this.hotFolderPath, entry.filename);
      const exists = fs.existsSync(filePath);

      if (!exists) {
        this.trackedFiles.delete(entry.filename.toLowerCase());
        this._emit(entry, 'accepted', now);
        continue;
      }

      const age = now - entry.submittedAt;
      if (age >= this.failureTimeoutMs) {
        this.trackedFiles.delete(entry.filename.toLowerCase());
        this._emit(entry, 'timed_out', now);
      }
    }
  }

  _emit(entry, status, nowMs) {
    try {
      this.callback({
        orderRef:  entry.orderRef,
        surface:   entry.surface,
        filename:  entry.filename,
        status,
        timestamp: new Date(nowMs),
      });
    } catch (_err) {
      // Don't let a misbehaving callback take down the monitor.
    }
  }

  _closeWatcher() {
    if (this.watcher) {
      try { this.watcher.close(); } catch (_err) { /* already closed */ }
      this.watcher = null;
    }
  }
}

module.exports = { FujiJobMakerMonitor };
