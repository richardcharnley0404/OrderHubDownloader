'use strict';

/**
 * src/main/services/server-capabilities.js
 *
 * Single source of truth for the per-organisation values ohd-api v1.4.0
 * hands back on /checkin: the two polling cadences and the feature flag
 * bundle. Persisted to its own electron-store so a restart before the
 * first check-in still behaves the way the last check-in configured us.
 *
 * Callers:
 *   - updater._checkIn writes here (updateFromCheckin).
 *   - polling-service reads getPollIntervalMs / getStatusPollIntervalMs.
 *   - job-service reads isEnabled('status_batch') / getStatusBatchMax and
 *     may call disableFeatureForSession('status_batch') on a 404 fallback.
 *
 * disableFeatureForSession is deliberately in-memory only: one bad server
 * response should not stick across restarts.
 *
 * Exported singleton is lazy so the class can be require()'d in tests
 * without paying the `new Store()` cost (which pulls electron.app).
 */

const Store = require('electron-store');

const DEFAULT_FEATURES = Object.freeze({
  status_batch:     false,
  pending_etag:     false,
  presign_expiry:   false,
  status_batch_max: 200,
});

// Validation ranges from the brief.
const POLL_MIN            = 10;
const POLL_MAX            = 600;
const STATUS_POLL_MIN     = 30;
const STATUS_POLL_MAX     = 3600;
const BATCH_MAX_MIN       = 1;
const BATCH_MAX_MAX       = 200;
const CONFIG_FALLBACK_SEC = 60;

function _isIntInRange(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

class ServerCapabilities {
  /**
   * @param {object} [opts]
   * @param {object} [opts.store] injected electron-store-shaped object (get/set)
   * @param {object} [opts.logger] injected logger with logWarning/info
   * @param {function} [opts.getPollingIntervalFallback] returns seconds from
   *   the user-config store; called only when no server value is stored.
   *   Lazy-resolved to configService by default so tests don't have to mock
   *   electron-store at module load.
   */
  constructor(opts = {}) {
    this._store = opts.store || new Store({
      name: 'server-capabilities',
      defaults: {
        pollIntervalSeconds:       null,
        statusPollIntervalSeconds: null,
        features:                  { ...DEFAULT_FEATURES },
        lastCheckinAt:             null,
      },
    });

    this._logger = opts.logger || require('./logger');

    this._getPollingIntervalFallback = opts.getPollingIntervalFallback ||
      (() => require('./config-service').get('pollingInterval') || CONFIG_FALLBACK_SEC);

    // Load persisted state.
    this.pollIntervalSeconds       = this._store.get('pollIntervalSeconds', null);
    this.statusPollIntervalSeconds = this._store.get('statusPollIntervalSeconds', null);
    const storedFeatures           = this._store.get('features', null);
    this.features = {
      ...DEFAULT_FEATURES,
      ...(storedFeatures && typeof storedFeatures === 'object' ? storedFeatures : {}),
    };
    this.lastCheckinAt = this._store.get('lastCheckinAt', null);

    // In-memory only — never persisted.
    this._sessionDisabledFeatures = new Set();
  }

  /**
   * Merge a /checkin response into the stored capabilities.
   * - Absent fields leave the stored value untouched.
   * - Present-but-invalid fields are ignored with a logWarning.
   * @returns {boolean} true iff the effective poll cadence changed.
   */
  updateFromCheckin(data) {
    if (!data || typeof data !== 'object') return false;
    const prevPoll = this.pollIntervalSeconds;

    if (Object.prototype.hasOwnProperty.call(data, 'poll_interval_seconds')) {
      const v = data.poll_interval_seconds;
      if (_isIntInRange(v, POLL_MIN, POLL_MAX)) {
        this.pollIntervalSeconds = v;
      } else {
        this._logger.logWarning('[server-capabilities] Ignoring invalid poll_interval_seconds', { value: v });
      }
    }

    if (Object.prototype.hasOwnProperty.call(data, 'status_poll_interval_seconds')) {
      const v = data.status_poll_interval_seconds;
      if (_isIntInRange(v, STATUS_POLL_MIN, STATUS_POLL_MAX)) {
        this.statusPollIntervalSeconds = v;
      } else {
        this._logger.logWarning('[server-capabilities] Ignoring invalid status_poll_interval_seconds', { value: v });
      }
    }

    if (data.features && typeof data.features === 'object') {
      for (const flag of ['status_batch', 'pending_etag', 'presign_expiry']) {
        if (Object.prototype.hasOwnProperty.call(data.features, flag)) {
          const v = data.features[flag];
          if (typeof v === 'boolean') {
            this.features[flag] = v;
          } else {
            this._logger.logWarning('[server-capabilities] Ignoring invalid feature flag', { flag, value: v });
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(data.features, 'status_batch_max')) {
        const v = data.features.status_batch_max;
        if (_isIntInRange(v, BATCH_MAX_MIN, BATCH_MAX_MAX)) {
          this.features.status_batch_max = v;
        } else {
          this._logger.logWarning('[server-capabilities] Ignoring invalid status_batch_max', { value: v });
        }
      }
    }

    this.lastCheckinAt = new Date().toISOString();
    this._persist();

    return this.pollIntervalSeconds !== prevPoll;
  }

  isEnabled(flag) {
    if (this._sessionDisabledFeatures.has(flag)) return false;
    return this.features[flag] === true;
  }

  getPollIntervalMs() {
    const seconds = this.pollIntervalSeconds != null
      ? this.pollIntervalSeconds
      : (this._getPollingIntervalFallback() || CONFIG_FALLBACK_SEC);
    return seconds * 1000;
  }

  getStatusPollIntervalMs() {
    return this.statusPollIntervalSeconds != null
      ? this.statusPollIntervalSeconds * 1000
      : null;
  }

  getStatusBatchMax() {
    return this.features.status_batch_max || DEFAULT_FEATURES.status_batch_max;
  }

  disableFeatureForSession(flag) {
    this._sessionDisabledFeatures.add(flag);
  }

  /**
   * Read-only view for IPC / diagnostics. Session-disabled flags are
   * reflected in isEnabled() but not mutated in the returned features
   * bag, so the snapshot still shows what the server advertised.
   */
  getSnapshot() {
    return {
      pollIntervalSeconds:       this.pollIntervalSeconds,
      statusPollIntervalSeconds: this.statusPollIntervalSeconds,
      features:                  { ...this.features },
      lastCheckinAt:             this.lastCheckinAt,
    };
  }

  _persist() {
    this._store.set('pollIntervalSeconds',       this.pollIntervalSeconds);
    this._store.set('statusPollIntervalSeconds', this.statusPollIntervalSeconds);
    this._store.set('features',                  this.features);
    this._store.set('lastCheckinAt',             this.lastCheckinAt);
  }
}

/**
 * Build the meta bag for the [ohd-api] /checkin log line. Extracted so
 * updater._checkIn stays a one-liner and so the shape is unit-tested.
 * The value is always the same set of keys regardless of what came
 * back — features collapses to the sentinel string 'absent' when the
 * server didn't send the block at all, so a grep for
 * `features:'absent'` (or `features: absent` in the Winston-formatted
 * activity log) surfaces pre-1.4.0 servers immediately.
 *
 * Contract: never throws, never touches the API key (data is the
 * check-in RESPONSE body, which doesn't carry credentials — but the
 * function still avoids blindly spreading `data` so if that ever
 * changes, the log stays bounded to the fields listed here).
 */
function formatCheckinCapabilitiesForLog(data) {
  const src = (data && typeof data === 'object') ? data : {};
  const f = src.features;
  const hasFeatures = f && typeof f === 'object';
  return {
    poll_interval_seconds:        src.poll_interval_seconds        ?? null,
    status_poll_interval_seconds: src.status_poll_interval_seconds ?? null,
    features: hasFeatures ? {
      status_batch:     f.status_batch     ?? null,
      pending_etag:     f.pending_etag     ?? null,
      presign_expiry:   f.presign_expiry   ?? null,
      status_batch_max: f.status_batch_max ?? null,
    } : 'absent',
  };
}

let _singleton = null;
function _getSingleton() {
  if (!_singleton) _singleton = new ServerCapabilities();
  return _singleton;
}

module.exports = {
  ServerCapabilities,
  DEFAULT_FEATURES,
  formatCheckinCapabilitiesForLog,
  get serverCapabilities() { return _getSingleton(); },
};
