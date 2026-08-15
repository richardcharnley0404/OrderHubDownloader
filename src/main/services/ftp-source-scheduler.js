'use strict';

const logger              = require('./logger');
const { runFtpSourcePass } = require('./ftp-source-service');

/**
 * src/main/services/ftp-source-scheduler.js
 *
 * M3 of docs/ftp-sources-brief.md — one timer per enabled FTP source,
 * at that source's own `intervalMinutes` cadence. Owns the map from
 * source id → { source, timer, intervalMs, running } and exposes:
 *
 *   - `reconcile(sources)` — called from the M4 IPC handler after any
 *     per-source save/delete, and once from the app boot with
 *     configService.getFtpSources(). Walks the incoming list against
 *     the current map: adds new timers, removes disabled/deleted ones,
 *     restarts any whose interval changed, and — CRITICALLY — always
 *     swaps the STORED source object for a kept timer so the next tick
 *     picks up current credentials, paths, etc. See "Source-swap on
 *     keep" below for the invariant test that guards this.
 *
 *   - `stop()` — clear every timer, empty the map. Called on shutdown.
 *
 * Design invariants — every one has a test in ftp-source-scheduler.test.js:
 *
 *   1. `.unref()` on every timer, immediately after creation. FTP-source
 *      polling MUST NOT be the reason the main process stays open —
 *      the polling service and window lifecycle own that.
 *
 *   2. No pass runs on reconcile — first pass on first tick per brief §M3.
 *      Reconcile is a pure schedule mutation; the runner only ever fires
 *      from setInterval callbacks.
 *
 *   3. Never overlap two passes for the same source. If a tick fires
 *      while `running` is already true, skip + log at debug. A slow or
 *      hung FTP server MUST NOT stack up passes. `running` is set true
 *      before the mover is awaited and reset in a finally so an
 *      unexpected throw still frees the source for its next tick.
 *
 *   4. Source-swap on keep. When an operator edits a source (new
 *      password, new remotePath, new host) without changing the
 *      interval, we KEEP the timer token but REPLACE the stored source
 *      object in the same map entry. The next tick reads the fresh
 *      source and passes it to the mover. Without this, a credential
 *      rotation would silently keep authenticating with the old
 *      password until the interval or the enabled flag also changed.
 *      Test: `reconcile mid-schedule swaps the source object`.
 *
 *   5. Reconciling a source AWAY mid-tick does NOT abort the running
 *      pass — the mover has no cancellation surface and killing the
 *      TCP session mid-download would leave a `.part` on disk that
 *      M2's stale-`.part` sweep cleans up on the next pass anyway.
 *      The running pass finishes, its result is logged, then goes
 *      nowhere useful (source is gone from the map by then). No data
 *      loss, no hung timer.
 *
 * Injectable deps for tests: setInterval / clearInterval (production
 * defaults to the real globals), runPass (defaults to runFtpSourcePass
 * from M2), logger. Everything else is internal.
 *
 * Scope boundary. This service NEVER touches job-service,
 * routing-service, print-service, or runAutoPrint. Same guarantee as
 * the mover it schedules.
 */

const DEFAULT_DEPS = Object.freeze({
  setInterval:   (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
  runPass:       runFtpSourcePass,
  logger:        logger,
});

class FtpSourceScheduler {
  constructor(deps = {}) {
    this._deps    = { ...DEFAULT_DEPS, ...deps };
    // Map<sourceId, { source, timer, intervalMs, running }>.
    this._entries = new Map();
  }

  /**
   * Reconcile the schedule against a fresh list of sources — typically
   * `configService.getFtpSources()` immediately after a per-source
   * save/delete. Enabled sources get timers, disabled/missing sources
   * lose them. Kept timers always have their stored source object
   * REPLACED so a credential/path change without an interval change
   * still takes effect on the next tick. See invariant 4 in the file
   * docblock.
   *
   * @param {Array<object>} sources - raw store shape from
   *   configService.getFtpSources() (includes `passwordEncrypted`).
   */
  reconcile(sources) {
    const list    = Array.isArray(sources) ? sources : [];
    const nextIds = new Set();

    for (const source of list) {
      if (!source || !source.enabled) continue;
      if (!source.id) continue;   // defensive; sanitiser ensures otherwise
      if (!Number.isInteger(source.intervalMinutes)
          || source.intervalMinutes < 1
          || source.intervalMinutes > 1440) {
        // Defence-in-depth against a hand-edited config that dodged M1's
        // sanitiser. Log at warn so the operator sees why an enabled
        // source stopped polling; do not throw.
        this._deps.logger.logWarning('[ftp-sources] skipping source with invalid intervalMinutes', {
          sourceName:      source.name,
          intervalMinutes: source.intervalMinutes,
        });
        continue;
      }

      nextIds.add(source.id);
      const intervalMs = source.intervalMinutes * 60 * 1000;
      const existing   = this._entries.get(source.id);

      if (existing && existing.intervalMs === intervalMs) {
        // Interval unchanged → KEEP the timer token. But always
        // replace the stored source object (invariant 4): a
        // credential/path/host edit must take effect on the next
        // tick even though the timer stays the same.
        existing.source = source;
        continue;
      }

      // New source OR interval changed → restart from scratch.
      if (existing) {
        this._deps.clearInterval(existing.timer);
      }
      // Note the arrow closure captures source.id, NOT source — so the
      // tick reads the LATEST source object out of the map at fire time
      // (invariant 4). Never dereference `source` inside the callback.
      // Expression body (no braces) so the tick's promise is RETURNED
      // from the callback — real setInterval ignores the return value,
      // but the unit-test fake awaits it so tests can deterministically
      // observe the completion of an async tick.
      const timer = this._deps.setInterval(() => this._tick(source.id), intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._entries.set(source.id, {
        source,
        timer,
        intervalMs,
        running: false,
      });
    }

    // Stop timers for sources no longer in the enabled set (either
    // deleted or disabled). A running pass on a removed source is left
    // to finish naturally — see invariant 5.
    for (const [id, entry] of this._entries.entries()) {
      if (!nextIds.has(id)) {
        this._deps.clearInterval(entry.timer);
        this._entries.delete(id);
      }
    }
  }

  /**
   * Kill every timer and empty the map. Intended for app shutdown.
   * Safe to call multiple times; in-flight passes are left to finish
   * on their own (see invariant 5).
   */
  stop() {
    for (const entry of this._entries.values()) {
      this._deps.clearInterval(entry.timer);
    }
    this._entries.clear();
  }

  /**
   * Internal tick handler. Wired from `setInterval` at reconcile time.
   * Reads the CURRENT source from the map (invariant 4 relies on this),
   * enforces the no-overlap guarantee, invokes the mover, and logs a
   * one-line summary per pass. Any unexpected throw is caught so the
   * `running` flag never gets stuck true.
   *
   * @param {string} sourceId
   */
  async _tick(sourceId) {
    const entry = this._entries.get(sourceId);
    if (!entry) {
      // Reconciled away between the tick firing and this callback
      // running — nothing to do. Defensive; the clearInterval in
      // reconcile SHOULD prevent the fire, but tolerate the race.
      return;
    }

    if (entry.running) {
      // Invariant 3: never stack two passes for the same source.
      this._deps.logger.debug('[ftp-sources] tick skipped — previous pass still running', {
        sourceName: entry.source.name,
      });
      return;
    }

    entry.running = true;
    try {
      // Read the source out of the entry at fire time — NOT captured
      // when the timer was created. This is what makes invariant 4
      // (source-swap on keep) actually take effect.
      const source  = entry.source;
      const summary = await this._deps.runPass(source);

      // M3-scope INFO summary. M5 refines the warn/error surface for
      // per-file and whole-pass failures; this line stays the
      // "did anything happen this pass" signal.
      this._deps.logger.info('[ftp-sources] pass complete', {
        sourceName: source.name,
        moved:      summary.moved,
        skipped:    summary.skipped,
        failed:     summary.failed,
        errors:     summary.errors.length,
      });
    } catch (err) {
      // Should not happen — runFtpSourcePass catches every error
      // itself and rolls them into `summary.errors`. But if a future
      // change ever regresses that guarantee, we MUST NOT leave
      // `running` stuck true (which would silently mute this source's
      // ticks forever). Log at error, then let the finally clear the
      // flag.
      this._deps.logger.logError('[ftp-sources] runPass threw (unexpected — runFtpSourcePass should catch its own)', err, {
        sourceName: entry.source.name,
      });
    } finally {
      // Re-read from the map: reconcile may have removed the entry
      // while we were awaiting. If so, there's nothing to clear.
      const currentEntry = this._entries.get(sourceId);
      if (currentEntry) currentEntry.running = false;
    }
  }

  // ── Test-only introspection ─────────────────────────────────────────────
  // Prefixed with `_` to keep them off the production surface.

  _activeSourceIds() {
    return new Set(this._entries.keys());
  }

  _entryFor(sourceId) {
    return this._entries.get(sourceId);
  }

  _isRunning(sourceId) {
    const e = this._entries.get(sourceId);
    return e ? e.running : false;
  }

  _intervalMsFor(sourceId) {
    const e = this._entries.get(sourceId);
    return e ? e.intervalMs : undefined;
  }
}

// Shared production instance — M4's IPC boot wires this and every
// per-source save handler calls `ftpSourceScheduler.reconcile(...)`.
// Tests construct their own `new FtpSourceScheduler({...deps})` so
// they don't fight over module-scoped state.
const ftpSourceScheduler = new FtpSourceScheduler();

module.exports = ftpSourceScheduler;
module.exports.FtpSourceScheduler = FtpSourceScheduler;
