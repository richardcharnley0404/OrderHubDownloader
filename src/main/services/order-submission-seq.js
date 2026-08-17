'use strict';

/**
 * src/main/services/order-submission-seq.js
 *
 * Persistent per-order-number submission counter for Fuji PIC Pro's
 * order-level merging. Follows the class + lazy-singleton pattern of
 * server-capabilities.js (own electron-store, injectable dependencies
 * for tests).
 *
 *   nextSubmissionId('ORD-1234') → 'ORD-1234'      (first time)
 *   nextSubmissionId('ORD-1234') → 'ORD-1234-2'    (subsequent)
 *   nextSubmissionId('ORD-1234') → 'ORD-1234-3'
 *
 * Why this must be persistent
 *   fuji-pic-pro-file-writer.stageImages does `rm -rf` on
 *   `{imageStagingRoot}/{orderId}` before staging (review fix 8). If
 *   an id ever gets reused, the previous submission's staged images
 *   are deleted — and PIC Pro may not have moved them into DIGIN yet.
 *   The counter therefore MUST survive a restart. Deriving it from
 *   the in-flight monitor state (fuji-pic-pro-monitor.js) is not safe
 *   because the monitor is transient by design.
 *
 * Why per-order-number, not per-controller
 *   The `rm -rf` hazard is scoped to `{imageStagingRoot}/{orderId}`,
 *   and two PIC Pro controllers on the same host could easily share
 *   a staging root. A single per-order-number counter guarantees no
 *   collision regardless of which controller wrote the id.
 *
 * No reset is exposed
 *   The store bounds itself by pruning old entries on load. A reset
 *   button would only exist to solve a problem that pruning already
 *   solves, and it would be a very sharp foot-gun.
 *
 * Prune horizon: max(jobDateRange, 90) days
 *   Pruning an order's entry destroys the never-reissue guarantee for
 *   that order — the next allocation would hand back the unsuffixed id
 *   and stageImages would `rm -rf` the folder named after it. Auto-print
 *   skips jobs past `jobDateRange`, so a naive "prune at jobDateRange"
 *   is safe for that path. Manual Process does NOT check that cutoff:
 *   an operator can process a job weeks past `jobDateRange` and, if the
 *   counter has been pruned in the meantime, the reissued unsuffixed id
 *   collides with whatever is (or was) staged for that order. The
 *   90-day floor gives manual Process a large enough safety margin
 *   without letting the store grow indefinitely, and the `max(...)`
 *   respects operators who have deliberately widened the window past
 *   90 days for a lab-specific reason.
 */

const Store = require('electron-store');

const DEFAULT_JOB_DATE_RANGE_DAYS = 30;
const MIN_PRUNE_HORIZON_DAYS      = 90;
const MS_PER_DAY                  = 24 * 60 * 60 * 1000;

class OrderSubmissionSeq {
  /**
   * @param {object} [opts]
   * @param {object} [opts.store] injected electron-store-shaped object
   *   (get/set/delete). Tests supply a plain in-memory stub.
   * @param {object} [opts.logger] injected logger with info/logWarning
   * @param {function} [opts.getJobDateRangeDays] returns days; called
   *   once at load time to prune old entries. Lazy-resolved to
   *   configService by default so tests don't have to mock config
   *   at module load.
   * @param {function} [opts.now] returns Date.now()-shaped ms. Tests
   *   inject a clock so pruning is deterministic.
   */
  constructor(opts = {}) {
    this._store = opts.store || new Store({
      name: 'order-submission-seq',
      defaults: { entries: {} },
    });
    this._logger = opts.logger || require('./logger');
    this._now    = typeof opts.now === 'function' ? opts.now : (() => Date.now());
    this._getJobDateRangeDays = opts.getJobDateRangeDays ||
      (() => {
        const v = require('./config-service').get('jobDateRange');
        return Number.isFinite(v) && v > 0 ? v : DEFAULT_JOB_DATE_RANGE_DAYS;
      });

    const stored = this._store.get('entries', {});
    this._entries = (stored && typeof stored === 'object' && !Array.isArray(stored))
      ? { ...stored }
      : {};

    // M7 raw-order → issued-id idempotence map. Same rawOrderId in →
    // same issued id out, every time, forever (subject to the shared
    // prune horizon below). Keeps the single-job PIC Pro path safe
    // under multi-prefix without changing retry semantics: a retry
    // finds the raw in this map and returns the SAME id, so
    // stageImages' rm -rf targets the folder it already knows about
    // rather than orphaning it.
    //
    // Format: { [rawOrderId]: { issuedId, issuedAt } }.
    const storedRawIds = this._store.get('rawIds', {});
    this._rawIds = (storedRawIds && typeof storedRawIds === 'object' && !Array.isArray(storedRawIds))
      ? { ...storedRawIds }
      : {};

    // Prune on load. Horizon is max(jobDateRange, 90) days — see the
    // module doc-comment for the rationale. Short version: pruning an
    // entry destroys the never-reissue guarantee for that order, and
    // manual Process is not gated by jobDateRange, so the horizon has
    // to cover any realistic manual re-Process window.
    //
    // BOTH maps prune together on the SAME horizon. Pruning the raw-id
    // map without pruning the counter (or vice versa) would leave one
    // map dangling: a re-dispatch of a pruned raw would either see
    // "no entry" and allocate a fresh unsuffixed id (collision with
    // whatever remains keyed on the counter), or find an entry keyed
    // on the counter but no matching raw and hand back an id whose
    // provenance is unknown. Joint prune closes that gap.
    const jobDays = this._getJobDateRangeDays();
    const horizon = Math.max(jobDays, MIN_PRUNE_HORIZON_DAYS);
    this._pruneOlderThan(horizon);
    this._persist();
  }

  /**
   * Allocate the next submission id for this order number, persistently.
   * First call → `displayBase` verbatim (defaults to `orderNumber`).
   * Subsequent calls → `-2`, `-3`… appended to `displayBase`.
   *
   * The counter is keyed on `base` — i.e. on `displayBase` if supplied,
   * otherwise on `orderNumber`. That is deliberate: the returned id
   * names the staging folder, the .txt filename, and the DIGIN folder,
   * so uniqueness has to be enforced on the returned string. Two
   * different raw orders that strip to the same displayBase MUST share
   * a counter — otherwise both would get the unsuffixed base, both
   * would name the same folder, and stageImages would `rm -rf` the
   * previous submission's staging directory. That collision is exactly
   * what the -2/-3 suffix scheme exists to prevent.
   *
   * @param {string} orderNumber   e.g. 'ORD-1234' — used as the default
   *   base when no displayBase is supplied. Passing the raw order
   *   number here is required by the argument shape but the counter is
   *   NOT keyed on it when displayBase is supplied.
   * @param {string} [displayBase] optional display base for the returned
   *   id. Defaults to `orderNumber`. When supplied (typically the
   *   post-strip form for the fujipicpro controller's Strip Order
   *   Number Prefix field), the id reads
   *   `displayBase` / `displayBase-2` / `displayBase-3`, and the
   *   counter is keyed on `displayBase` too so uniqueness holds on
   *   the returned string.
   * @returns {string}
   * @throws {Error} on missing/blank orderNumber — this is a caller bug,
   *   not a runtime condition. The alternative (silently generate a
   *   nonsense id) is exactly the class of hazard this whole module
   *   exists to prevent.
   */
  nextSubmissionId(orderNumber, displayBase) {
    if (typeof orderNumber !== 'string' || orderNumber.trim().length === 0) {
      throw new Error('nextSubmissionId requires a non-empty orderNumber string');
    }
    // displayBase, when supplied, must also be a non-empty string —
    // defence-in-depth against a caller passing '' or a non-string
    // (the whole point of the caller-side stripPrefix guard is that it
    // never returns empty, but this module can't rely on that).
    const base = (typeof displayBase === 'string' && displayBase.length > 0)
      ? displayBase
      : orderNumber;
    // Key on the RETURNED id's base — see method doc-comment for why.
    // Prior to v1.12.2 this was keyed on `orderNumber`; the bug was
    // that two orders stripping to the same displayBase each got their
    // own counter, both issued the unsuffixed base as the id, and the
    // second staging call rm -rf'd the first's folder.
    const key = base;
    const entry = this._entries[key];

    // If entry exists but lastSeq is corrupt, assume seq 1 was already
    // issued and bump to 2. Chance of collision at seq 2 is far lower
    // than at seq 1, and the alternative (throw) leaves the app dead
    // on a single bad on-disk value. Log so it's not silent.
    let lastSeq;
    if (entry) {
      if (Number.isInteger(entry.lastSeq) && entry.lastSeq >= 1) {
        lastSeq = entry.lastSeq;
      } else {
        this._logger.logWarning(
          '[order-submission-seq] corrupt entry — assuming seq 1 already issued',
          { orderNumber, key, entry },
        );
        lastSeq = 1;
      }
    } else {
      lastSeq = 0;   // no entry → first issue is unsuffixed
    }

    const nextSeq = lastSeq + 1;
    const id = nextSeq === 1 ? base : `${base}-${nextSeq}`;

    this._entries[key] = {
      lastSeq:      nextSeq,
      lastIssuedAt: new Date(this._now()).toISOString(),
    };
    this._persist();
    return id;
  }

  /**
   * Idempotent-by-rawOrderId allocation (M7). Same rawOrderId in →
   * SAME issued id out, every time, forever (until the shared prune
   * horizon reaches the entry). Different rawOrderIds that strip to
   * the same displayBase go through the counter and get -2, -3, …
   * — exactly the same suffix scheme as nextSubmissionId.
   *
   * Used by the PIC Pro single-job path (print-service.js:3095-3096).
   * The order-level merge path deliberately uses nextSubmissionId
   * instead: it wants a new id per dispatch (the documented
   * resubmission suffix). Do NOT reroute merge through here.
   *
   * Why not just nextSubmissionId? nextSubmissionId is a pure
   * incrementing counter (docstring above says so): calling it twice
   * for the same rawOrderId returns two different ids. That means a
   * retry of the same job would orphan the previously-staged folder
   * and print the order twice. This method fixes that: the raw-order
   * map is consulted first; only on a MISS do we increment the
   * counter.
   *
   * Cross-prefix collision (the reason M7 needs this at all):
   * one OHD install talks to one OrderHub org, but the org can ship
   * orders with several different prefixes distinguishing the source
   * website (e.g. `ORD-`, `PXDEMO-`, `POS-`). Two raw order ids
   * `PXDEMO-091YEC` and `POS-091YEC` strip to the same displayBase
   * `091YEC`. The counter keyed on displayBase distinguishes them:
   * first call gets `091YEC`, second gets `091YEC-2`. Each raw id
   * remembers ITS id via _rawIds so retries are idempotent per raw.
   *
   * @param {string} rawOrderId — the unstripped id (typically
   *   `job.job_name` for single-job PIC Pro).
   * @param {string} [displayBase] — the post-strip form. Used ONLY
   *   when allocating a new id (rawOrderId not seen before). Ignored
   *   on the idempotent hit path.
   * @returns {string}
   * @throws {Error} on missing/blank rawOrderId — caller bug.
   */
  getOrCreateSubmissionId(rawOrderId, displayBase) {
    if (typeof rawOrderId !== 'string' || rawOrderId.trim().length === 0) {
      throw new Error('getOrCreateSubmissionId requires a non-empty rawOrderId string');
    }
    // Idempotent hit: return the id already issued to this raw id.
    // No counter increment, no folder churn. This is the retry path.
    const existing = this._rawIds[rawOrderId];
    if (existing && typeof existing.issuedId === 'string' && existing.issuedId.length > 0) {
      return existing.issuedId;
    }
    // First time we've seen this raw id → allocate via the same
    // counter logic nextSubmissionId uses, then remember the pairing.
    // Note: this DOES call nextSubmissionId, so the counter's per-
    // base entry is bumped exactly once per unique raw. The rawIds
    // entry captures the returned id so future calls for the SAME
    // raw are the idempotent hit path above.
    const issuedId = this.nextSubmissionId(rawOrderId, displayBase);
    this._rawIds[rawOrderId] = {
      issuedId,
      issuedAt: new Date(this._now()).toISOString(),
    };
    this._persist();
    return issuedId;
  }

  /**
   * Read-only snapshot of the raw-order → issued-id map for one raw
   * id, for logging and tests. Returns null when no id has ever been
   * issued for that raw id.
   */
  peekRawId(rawOrderId) {
    if (typeof rawOrderId !== 'string' || rawOrderId.length === 0) return null;
    const entry = this._rawIds[rawOrderId];
    if (!entry || typeof entry.issuedId !== 'string' || entry.issuedId.length === 0) return null;
    return {
      issuedId: entry.issuedId,
      issuedAt: entry.issuedAt || null,
    };
  }

  /**
   * Read-only snapshot of the counter for one key, for logging and
   * tests. Returns null if no id has ever been issued under that key.
   * Never mutates.
   *
   * The parameter is the counter KEY — same string the caller passed
   * (or would pass) to nextSubmissionId as its effective base. When a
   * caller allocated with `nextSubmissionId(orderNumber, displayBase)`
   * the counter is keyed on `displayBase`, so `peek(displayBase)` is
   * what returns the entry. When no displayBase was used the key
   * equals the raw order number, so `peek(orderNumber)` works as it
   * always has.
   *
   * `lastId` derives from that key + suffix — matching what
   * nextSubmissionId would return for the equivalent next-call state.
   *
   * @param {string} key  the counter key — displayBase if that was
   *   used at allocation time, otherwise the raw order number.
   * @returns {null | { lastSeq: number, lastIssuedAt: string, lastId: string }}
   */
  peek(key) {
    if (typeof key !== 'string' || key.length === 0) return null;
    const entry = this._entries[key];
    if (!entry) return null;
    const lastSeq = Number.isInteger(entry.lastSeq) && entry.lastSeq >= 1
      ? entry.lastSeq : null;
    return {
      lastSeq,
      lastIssuedAt: entry.lastIssuedAt || null,
      lastId:       lastSeq === 1 ? key
                  : lastSeq       ? `${key}-${lastSeq}`
                  : null,
    };
  }

  _pruneOlderThan(days) {
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoffMs = this._now() - (days * MS_PER_DAY);
    let prunedEntries = 0;
    let prunedRawIds  = 0;
    // Prune the counter map. Missing / unparseable timestamps get
    // pruned too — no evidence of recency, and keeping them would
    // grow the store forever.
    for (const key of Object.keys(this._entries)) {
      const entry = this._entries[key];
      const ts = entry && entry.lastIssuedAt ? Date.parse(entry.lastIssuedAt) : NaN;
      if (!Number.isFinite(ts) || ts < cutoffMs) {
        delete this._entries[key];
        prunedEntries++;
      }
    }
    // M7: prune the raw-order map on the SAME horizon. Doing this in
    // one pass — not two separate calls — is deliberate: any drift
    // between the two prune horizons would leave one map dangling
    // (see the constructor docstring's "joint prune" note).
    for (const key of Object.keys(this._rawIds)) {
      const entry = this._rawIds[key];
      const ts = entry && entry.issuedAt ? Date.parse(entry.issuedAt) : NaN;
      if (!Number.isFinite(ts) || ts < cutoffMs) {
        delete this._rawIds[key];
        prunedRawIds++;
      }
    }
    if (prunedEntries > 0 || prunedRawIds > 0) {
      this._logger.info('[order-submission-seq] pruned old entries on load', {
        // `pruned` preserved as the counter-map count for back-compat
        // with existing test assertions and any log-analysis tooling.
        // `prunedRawIds` is the M7 addition.
        pruned:        prunedEntries,
        prunedEntries,
        prunedRawIds,
        days,
      });
    }
  }

  _persist() {
    this._store.set('entries', this._entries);
    this._store.set('rawIds',  this._rawIds);
  }
}

let _singleton = null;
function _getSingleton() {
  if (!_singleton) _singleton = new OrderSubmissionSeq();
  return _singleton;
}

module.exports = {
  OrderSubmissionSeq,
  DEFAULT_JOB_DATE_RANGE_DAYS,
  get orderSubmissionSeq() { return _getSingleton(); },
};
