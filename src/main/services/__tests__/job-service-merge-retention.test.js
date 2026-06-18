/**
 * Unit tests for JobService._mergeJobs — focused on the narrow
 * awaiting-manifest retention exception.
 *
 * Default rule (unchanged): kept-local jobs are retained iff
 * _status !== 'pending'.
 *
 * Exception: also retain when _status === 'pending' AND
 * _awaitingManifest === true AND still within awaitingManifestTimeoutMs.
 * This keeps awaiting-manifest jobs in the cache long enough for the
 * polling escalation loop to fire — without it, a job whose API record
 * drops mid-awaiting vanishes silently, leaving the partial manifest
 * on disk with no error trace.
 *
 * Past timeout, the exception stops applying: the escalation should
 * already have flipped _status to 'error' (which the general rule
 * catches). A still-pending past-timeout job indicates broken
 * escalation; dropping prevents indefinite cache retention.
 *
 * Run via:  npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── Stubs ────────────────────────────────────────────────────────────────────

let __timeoutMs = 600000;

const fakeConfigService = {
  get: (key) => {
    if (key === 'awaitingManifestTimeoutMs') return __timeoutMs;
    return undefined;
  },
};

const noopLogger = { info: () => {}, warn: () => {}, logError: () => {}, logWarning: () => {} };

// electron-store stub — JobService constructs one at module load.
const FakeStore = function () {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
  };
};
const Module = require('node:module');
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'), fakeConfigService);
stubInCache(path.join(SVC, 'logger.js'),         noopLogger);
// routing-service is lazy-required inside _getRoutingHeldProcesses;
// stub it so _mergeJobs can call computeHoldForReview without dragging
// in the real routing layer.
stubInCache(path.join(SVC, 'routing-service.js'), { getRoutingHeldProcesses: () => [] });

const jobService = require(path.join(SVC, 'job-service.js'));

// ── Helpers ──────────────────────────────────────────────────────────────────

function setCache(jobs) { jobService.jobs = jobs.map(j => ({ ...j })); }
function awaitingJob(overrides = {}) {
  return {
    id: 38461218,
    order_number: 'PXSTAGE-XYZ',
    order_id: 'ord-1',
    _status: 'pending',
    _awaitingManifest: true,
    _awaitingManifestSince: new Date(Date.now() - 30000).toISOString(), // 30 s ago
    _awaitingManifestPath: '/tmp/PXSTAGE-XYZ.json',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('pre-existing rule: plain pending job dropped from API → dropped from cache', () => {
  __timeoutMs = 600000;
  setCache([{
    id: 1, order_number: 'A', _status: 'pending',
  }]);

  const merged = jobService._mergeJobs([]); // API returned nothing

  assert.equal(merged.length, 0, 'plain pending jobs are NOT retained when the API drops them');
});

test('pre-existing rule: received job dropped from API → retained', () => {
  setCache([{
    id: 2, order_number: 'B', _status: 'received',
  }]);

  const merged = jobService._mergeJobs([]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]._status, 'received');
});

test('pre-existing rule: error job dropped from API → retained (sticky-error path)', () => {
  setCache([{
    id: 3, order_number: 'C', _status: 'error', _errorMessage: 'historical',
  }]);

  const merged = jobService._mergeJobs([]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]._status, 'error');
});

test('exception: awaiting+pending job dropped from API, within timeout → retained', () => {
  setCache([awaitingJob()]); // stamped 30 s ago

  const merged = jobService._mergeJobs([]);

  assert.equal(merged.length, 1, 'awaiting job kept long enough for polling loop to fire');
  assert.equal(merged[0]._status, 'pending');
  assert.equal(merged[0]._awaitingManifest, true);
  assert.equal(merged[0]._awaitingManifestPath, '/tmp/PXSTAGE-XYZ.json',
    'awaiting metadata preserved verbatim');
});

test('exception: awaiting+pending job dropped from API, past timeout → STILL retained', () => {
  // Critical: even past timeout, the merge retains. The polling escalation
  // loop runs after the merge in the same pollJobs() tick and flips
  // _status to 'error'. If the merge dropped past-timeout awaiting jobs
  // here, the escalation would never fire and the job would vanish
  // silently — the exact failure mode the merge exception exists to
  // prevent. The bound on awaiting lives in the polling escalation, not
  // in the merge filter. End-to-end interaction covered by
  // awaiting-manifest-end-to-end.test.js.
  setCache([awaitingJob({ _awaitingManifestSince: new Date(Date.now() - 60000).toISOString() })]);

  const merged = jobService._mergeJobs([]);

  assert.equal(merged.length, 1,
    'past-timeout awaiting job is retained so the polling loop can escalate it on the same tick');
});

test('exception: awaiting+pending job still in API → kept (existing _mergeJobs preservation)', () => {
  // Sanity: the exception only matters when the API drops the job. When
  // the API still includes it, the standard newJobs map → existingMap
  // merge path takes over and retains the job entry.
  setCache([awaitingJob()]);

  const merged = jobService._mergeJobs([{
    id: 38461218, order_number: 'PXSTAGE-XYZ', order_id: 'ord-1',
  }]);

  assert.equal(merged.length, 1);
});

test('exception scoped to _awaitingManifest:true — a plain pending job is still dropped', () => {
  // Guards against the exception leaking to non-awaiting pending jobs.
  // The general "drop pending on API drop" rule must still apply for
  // jobs that never entered the awaiting state.
  setCache([{ id: 99, order_number: 'X', _status: 'pending' /* no _awaitingManifest */ }]);

  const merged = jobService._mergeJobs([]);

  assert.equal(merged.length, 0,
    'exception is narrow — only triggers when _awaitingManifest === true');
});
