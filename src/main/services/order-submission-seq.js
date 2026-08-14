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

    // Prune on load. Horizon is max(jobDateRange, 90) days — see the
    // module doc-comment for the rationale. Short version: pruning an
    // entry destroys the never-reissue guarantee for that order, and
    // manual Process is not gated by jobDateRange, so the horizon has
    // to cover any realistic manual re-Process window.
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
    let pruned = 0;
    for (const key of Object.keys(this._entries)) {
      const entry = this._entries[key];
      const ts = entry && entry.lastIssuedAt ? Date.parse(entry.lastIssuedAt) : NaN;
      // Missing / unparseable timestamps get pruned too — they carry
      // no evidence of recency, and keeping them would only grow the
      // store forever. If a legitimate entry ever loses its timestamp,
      // the worst that happens is the next id for that order is
      // unsuffixed instead of `-N`; the operator sees a fresh order.
      if (!Number.isFinite(ts) || ts < cutoffMs) {
        delete this._entries[key];
        pruned++;
      }
    }
    if (pruned > 0) {
      this._logger.info('[order-submission-seq] pruned old entries on load', { pruned, days });
    }
  }

  _persist() {
    this._store.set('entries', this._entries);
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
