/**
 * Persistence layer for Order XML hot folder ingestion records.
 *
 * Each XML the watcher processes — successfully or not — produces one record.
 * Records are persisted via electron-store (separate file from the main app
 * config so churn doesn't bloat config.json) and surfaced to the renderer via
 * IPC for the Order XML panel.
 *
 * Retention: records are pruned to the last 30 days on every add() and on
 * every explicit prune() call (the polling-service drives a tick-time prune
 * to avoid surprise growth on idle days). 30 days is plenty for operator
 * triage; longer-term reporting is OrderHub's job.
 *
 * Indexing strategy: linear scan over an in-memory array. A busy lab does
 * <1000 orders/day; even at the 30-day cap that's ≤30k records, which is
 * trivial for in-memory filter/sort. No real index until volume justifies it.
 *
 * Test-friendliness: Store is dependency-injected so unit tests can pass an
 * in-memory fake; production code uses the real electron-store singleton at
 * the bottom of the file.
 */

'use strict';

const { randomUUID } = require('node:crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION_DAYS = 30;
const STORE_KEY = 'records';
const ELECTRON_STORE_NAME = 'order-xml-ingestion';

// Valid status values — kept in sync with order-xml-watch-service.js's
// RESULT_STATUS. Duplicated here to avoid a require-cycle between the watcher
// and the store.
const STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  DUPLICATE: 'duplicate',
  FAILED:    'failed',
  PENDING:   'pending', // reserved for in-flight rows the panel may surface later
});

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

class OrderXmlIngestionStore {
  /**
   * @param {object} [opts]
   * @param {object} [opts.store]         - electron-store-compatible instance
   *   ({ get(k, default), set(k, v), delete(k) }). Tests pass an in-memory fake.
   * @param {number} [opts.retentionDays] - drop records older than this on prune
   * @param {function} [opts.now]         - clock fn for deterministic tests
   */
  constructor(opts = {}) {
    this.store         = opts.store || _defaultStore();
    this.retentionDays = opts.retentionDays || DEFAULT_RETENTION_DAYS;
    this.now           = opts.now || (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Append a record. If the record has no `id`, one is generated. Returns the
   * stored record (with the id filled in). Always prunes after writing so the
   * store size stays bounded even if the operator never opens the panel.
   */
  add(record) {
    if (!record || typeof record !== 'object') {
      throw new Error('OrderXmlIngestionStore.add: record must be an object');
    }
    const id = record.id || randomUUID();
    const stored = {
      id,
      // Defensive copy; never share a reference with the caller (the watcher
      // emits records that other components — logger, panel — may inspect).
      ...record,
      id, // keep id last so spread can't accidentally clobber the generated one
    };
    const records = this._load();
    records.push(stored);
    const pruned = this._pruneArray(records);
    this._save(pruned);
    return stored;
  }

  /**
   * Patch a record by id. Returns the updated record, or null if not found.
   * Useful when a retry succeeds (status: 'failed' → 'submitted').
   */
  updateById(id, patch) {
    if (!id) return null;
    const records = this._load();
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    records[idx] = { ...records[idx], ...patch, id }; // id stays canonical
    this._save(records);
    return records[idx];
  }

  /**
   * Drop a record by id. Returns true if a row was removed.
   */
  removeById(id) {
    if (!id) return false;
    const records = this._load();
    const next = records.filter((r) => r.id !== id);
    if (next.length === records.length) return false;
    this._save(next);
    return true;
  }

  /**
   * Wipe every record. Used by the panel's "Clear" action and by tests.
   */
  clear() {
    this._save([]);
  }

  /**
   * Drop records older than retentionDays. Safe to call frequently —
   * polling-service runs it on every tick. Returns the number of records
   * removed.
   */
  prune() {
    const records = this._load();
    const pruned = this._pruneArray(records);
    if (pruned.length !== records.length) {
      this._save(pruned);
    }
    return records.length - pruned.length;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * List records matching `filters`, newest-first. Supports light pagination
   * via `limit` and `offset`. Filter values are exact-match on the named
   * fields; absent / falsy filter keys are ignored.
   *
   * @param {object} [opts]
   * @param {object} [opts.filters] - { hotFolderId?, sourceFormat?, status? }
   * @param {number} [opts.limit]   - max rows to return (default: all)
   * @param {number} [opts.offset]  - rows to skip from the top (default 0)
   * @returns {object[]} matching records (newest-first)
   */
  list(opts = {}) {
    const filters = opts.filters || {};
    const offset  = Math.max(0, parseInt(opts.offset, 10) || 0);
    const limit   = Math.max(0, parseInt(opts.limit,  10) || 0);

    const all = this._load();

    const filtered = all.filter((r) => {
      if (filters.hotFolderId  && r.hotFolderId  !== filters.hotFolderId)  return false;
      if (filters.sourceFormat && r.sourceFormat !== filters.sourceFormat) return false;
      if (filters.status       && r.status       !== filters.status)       return false;
      return true;
    });

    // Newest-first by ingestedAt (fallback to id for stable ordering when
    // timestamps tie — randomUUID is good enough as a tiebreaker).
    filtered.sort((a, b) => {
      const ta = a.ingestedAt || '';
      const tb = b.ingestedAt || '';
      if (tb < ta) return -1;
      if (tb > ta) return 1;
      return (a.id || '').localeCompare(b.id || '');
    });

    if (offset || limit) {
      const end = limit ? offset + limit : undefined;
      return filtered.slice(offset, end);
    }
    return filtered;
  }

  /**
   * Count records matching `filters`. Cheaper than list() when the panel just
   * needs a badge number.
   */
  count(filters = {}) {
    return this.list({ filters }).length;
  }

  /** Look up a single record by its id. */
  getById(id) {
    if (!id) return null;
    return this._load().find((r) => r.id === id) || null;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  _load() {
    const raw = this.store.get(STORE_KEY, []);
    return Array.isArray(raw) ? raw : [];
  }

  _save(records) {
    this.store.set(STORE_KEY, records);
  }

  _pruneArray(records) {
    const cutoff = new Date(this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000);
    return records.filter((r) => {
      if (!r.ingestedAt) return true; // tolerate missing timestamps
      const ts = Date.parse(r.ingestedAt);
      if (!Number.isFinite(ts)) return true;
      return ts >= cutoff.getTime();
    });
  }
}

// ---------------------------------------------------------------------------
// Default singleton (production)
// ---------------------------------------------------------------------------

let _singleton = null;

function _defaultStore() {
  // Lazy require — keeps tests that pass their own store from triggering
  // electron-store's electron require at module load.
  const Store = require('electron-store');
  return new Store({ name: ELECTRON_STORE_NAME, defaults: { [STORE_KEY]: [] } });
}

/**
 * Production singleton. Lazy so unit tests that import `OrderXmlIngestionStore`
 * don't trigger electron-store via the side-effect of requiring this module.
 */
function getDefaultInstance() {
  if (!_singleton) _singleton = new OrderXmlIngestionStore();
  return _singleton;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  OrderXmlIngestionStore,
  STATUS,
  DEFAULT_RETENTION_DAYS,
  getDefaultInstance,
};
