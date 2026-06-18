/**
 * Unit tests for PollingService._handleFolderStatusChange — the DPOF hot-folder
 * auto-completion handler. Covers flag gate, lookup, accepted/failed branches,
 * and the unknown-jobId silent path.
 *
 * Stubs every transitive module polling-service.js loads, so this test runs
 * without electron. Same require.cache-injection pattern used by
 * print-controller-service.test.js.
 *
 * Run via:
 *   npm test
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

// ── Capture state ────────────────────────────────────────────────────────────

let __flagEnabled            = false;
let __jobsById               = new Map();
const __updateLocallyCalls   = [];
const __markCompletedCalls   = [];
let   __markCompletedImpl    = () => Promise.resolve({});
const __logCalls             = { info: [], warn: [], error: [] };

function resetCaptures() {
  __flagEnabled = false;
  __jobsById.clear();
  __updateLocallyCalls.length = 0;
  __markCompletedCalls.length = 0;
  __markCompletedImpl = () => Promise.resolve({});
  __logCalls.info.length  = 0;
  __logCalls.warn.length  = 0;
  __logCalls.error.length = 0;
}

// ── Stub modules ─────────────────────────────────────────────────────────────

const fakeConfigService = {
  get(key) {
    if (key === 'autoCompleteOnPrinterAccept') return __flagEnabled;
    return undefined;
  },
};

const fakeJobService = {
  findJobById(jobId) {
    const numeric = Number(jobId);
    if (!Number.isFinite(numeric)) return undefined;
    return __jobsById.get(numeric);
  },
  updateJobLocally(jobId, updates) {
    __updateLocallyCalls.push({ jobId, updates });
  },
  markCompleted(jobId) {
    __markCompletedCalls.push(jobId);
    return __markCompletedImpl(jobId);
  },
  getLocalJobs() { return { jobs: Array.from(__jobsById.values()), lastFetchTime: null }; },
};

const fakeLogger = {
  info:       (...args) => __logCalls.info.push(args),
  warn:       (...args) => __logCalls.warn.push(args),
  logError:   (...args) => __logCalls.error.push(args),
  logWarning: (...args) => __logCalls.warn.push(args),
};

// Heavy modules polling-service requires at load — replaced with no-op shapes.
const noopExports = {};

stubInCache(path.join(SVC, 'config-service.js'),        fakeConfigService);
stubInCache(path.join(SVC, 'ftp-service.js'),           noopExports);
stubInCache(path.join(SVC, 'folder-watch-service.js'),  noopExports);
stubInCache(path.join(SVC, 'job-service.js'),           fakeJobService);
stubInCache(path.join(SVC, 'job-download-service.js'),  noopExports);
stubInCache(path.join(SVC, 's3-artwork-downloader.js'), { createS3ArtworkDownloader: () => ({}) });
stubInCache(path.join(SVC, 'print-controller-store.js'),{ printControllerStore: { getAllControllers: () => [] } });
stubInCache(path.join(SVC, 'routing-service.js'),       { getControllers: () => [] });
stubInCache(path.join(SVC, 'folder-monitor.js'),        { FolderMonitor: class { startMonitoring() {} stopMonitoring() {} } });
stubInCache(path.join(SVC, 'logger.js'),                fakeLogger);

const pollingService = require(path.join(SVC, 'polling-service.js'));

// Replace the renderer-notify side effect so we can assert it without
// crossing into the real renderer plumbing.
let __notifyCalls = 0;
pollingService._notifyJobsUpdated = () => { __notifyCalls += 1; };

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONTROLLER = { id: 'ctl-1', name: 'Noritsu QSS' };
const TIMESTAMP  = new Date('2026-06-18T12:00:00.000Z');

const acceptedUpdate = {
  jobId:       '38461218',
  productCode: 'PXDEMO-PFTAP4-1_4x6 Photo Print_lustre_full-bleed',
  status:      'accepted',
  timestamp:   TIMESTAMP,
};
const failedUpdate    = { ...acceptedUpdate, status: 'failed' };
const submittedUpdate = { ...acceptedUpdate, status: 'submitted' };

function seedJob(job) { __jobsById.set(job.id, job); }
function resetAll() { resetCaptures(); __notifyCalls = 0; }

// ── Tests ────────────────────────────────────────────────────────────────────

test('flag OFF — handler is a full no-op (no lookup, no log, no notify)', () => {
  resetAll();
  seedJob({ id: 38461218, order_number: 'PXDEMO-PFTAP4-1', _status: 'pending' });
  __flagEnabled = false;

  pollingService._handleFolderStatusChange(acceptedUpdate, CONTROLLER);

  assert.equal(__markCompletedCalls.length, 0, 'markCompleted must not be called when flag is OFF');
  assert.equal(__updateLocallyCalls.length, 0, 'no local _dpof writes when flag is OFF');
  assert.equal(__notifyCalls, 0, 'no renderer notify when flag is OFF');
  assert.equal(__logCalls.info.length + __logCalls.warn.length, 0, 'no log output when flag is OFF');
});

test('flag ON — accepted → markCompleted called with numeric job.id', async () => {
  resetAll();
  seedJob({ id: 38461218, order_number: 'PXDEMO-PFTAP4-1', _status: 'pending' });
  __flagEnabled = true;

  pollingService._handleFolderStatusChange(acceptedUpdate, CONTROLLER);

  assert.deepEqual(__markCompletedCalls, [38461218],
    'markCompleted invoked once with the numeric job.id (not the string from the regex)');
  assert.equal(__updateLocallyCalls.length, 1, 'one local update for the accepted flag');
  assert.equal(__updateLocallyCalls[0].jobId, 38461218);
  assert.equal(__updateLocallyCalls[0].updates._dpofAccepted, true);
  assert.equal(__updateLocallyCalls[0].updates._dpofAcceptedAt, TIMESTAMP.toISOString());

  // Drain the markCompleted promise so any .then chain runs.
  await new Promise(r => setImmediate(r));
});

test('flag ON — failed → local _dpofFailed write, NO completion API call', () => {
  resetAll();
  seedJob({ id: 38461218, order_number: 'PXDEMO-PFTAP4-1', _status: 'pending' });
  __flagEnabled = true;

  pollingService._handleFolderStatusChange(failedUpdate, CONTROLLER);

  assert.equal(__markCompletedCalls.length, 0, 'markCompleted MUST NOT fire on failed');
  assert.equal(__updateLocallyCalls.length, 1);
  assert.equal(__updateLocallyCalls[0].updates._dpofFailed, true);
  assert.equal(__updateLocallyCalls[0].updates._dpofAcceptedAt, undefined,
    'accepted-flag fields must not be touched on the failed branch');

  // The duplicated "Job DPOF rejected by printer" log from the old body must
  // not return — exactly one warning, not two.
  const rejectionWarnings = __logCalls.warn.filter(
    args => typeof args[0] === 'string' && args[0].includes('rejected by printer')
  );
  assert.equal(rejectionWarnings.length, 1, 'rejection warning must be logged exactly once');
});

test('flag ON, accepted + markCompleted REJECTS → no force-complete, warning fires, renderer notified', async () => {
  // Pins the dropped-fallback correctness fix:
  // Old behaviour wrote _status:'completed' locally even on genuine
  // non-"already" API failures (HTTP 500, network down). New behaviour
  // leaves the job uncompleted so the failure stays visible/recoverable.
  resetAll();
  seedJob({ id: 38461218, order_number: 'PXDEMO-PFTAP4-1', _status: 'pending' });
  __flagEnabled = true;
  __markCompletedImpl = () => Promise.reject(new Error('HTTP 500'));

  pollingService._handleFolderStatusChange(acceptedUpdate, CONTROLLER);

  // After the synchronous body runs, the renderer is notified once at the
  // function tail. The async catch handler hasn't run yet.
  assert.equal(__notifyCalls, 1, 'renderer notified once synchronously at function tail');

  // Drain the markCompleted catch handler.
  await new Promise(r => setImmediate(r));

  // Forced-complete write MUST NOT exist anywhere in the update log.
  const forcedComplete = __updateLocallyCalls.find(
    c => c.updates && c.updates._status === 'completed'
  );
  assert.equal(forcedComplete, undefined,
    'API failure must NOT write _status:"completed" — job must stay visible/recoverable');

  // Only the accepted-flag write should be present, not a completion write.
  assert.equal(__updateLocallyCalls.length, 1, 'only the initial _dpofAccepted write — no second forced-complete update');
  assert.equal(__updateLocallyCalls[0].updates._dpofAccepted, true);

  // Failure warning was logged.
  const failureWarn = __logCalls.warn.find(
    args => typeof args[0] === 'string' && args[0].includes('auto-complete API call failed')
  );
  assert.ok(failureWarn, 'failure path must log a warning');

  // Renderer notified a second time from the .catch handler so the UI
  // refreshes after the API attempt resolves (success OR failure).
  assert.equal(__notifyCalls, 2,
    'renderer notified again from the .catch handler after the API rejects');
});

test('flag ON — unknown jobId is silent (info log, no warning, no writes)', () => {
  resetAll();
  __flagEnabled = true;
  // No job seeded — findJobById returns undefined.

  pollingService._handleFolderStatusChange(acceptedUpdate, CONTROLLER);

  assert.equal(__markCompletedCalls.length, 0);
  assert.equal(__updateLocallyCalls.length, 0);
  assert.equal(__logCalls.warn.length, 0,
    'unknown jobId must not warn — the spammy "unknown job" warning is what the early-return guard was added to suppress');
  assert.equal(__logCalls.info.length, 1, 'unknown jobId logs a single info line for traceability');
});

test('flag ON — submitted (p→o) is ignored entirely', () => {
  resetAll();
  seedJob({ id: 38461218, order_number: 'PXDEMO-PFTAP4-1', _status: 'pending' });
  __flagEnabled = true;

  pollingService._handleFolderStatusChange(submittedUpdate, CONTROLLER);

  assert.equal(__markCompletedCalls.length, 0);
  assert.equal(__updateLocallyCalls.length, 0);
  assert.equal(__notifyCalls, 0, 'submitted must NOT trigger a renderer refresh');
  assert.equal(__logCalls.info.length + __logCalls.warn.length, 0);
});

test('flag ON — non-numeric jobId string is rejected cleanly by findJobById', () => {
  resetAll();
  __flagEnabled = true;

  pollingService._handleFolderStatusChange(
    { ...acceptedUpdate, jobId: 'not-a-number' },
    CONTROLLER
  );

  // Falls into the "unknown jobId" branch — info log only.
  assert.equal(__markCompletedCalls.length, 0);
  assert.equal(__updateLocallyCalls.length, 0);
  assert.equal(__logCalls.warn.length, 0);
});
