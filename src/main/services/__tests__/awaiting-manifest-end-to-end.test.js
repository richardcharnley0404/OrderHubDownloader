/**
 * End-to-end test for the awaiting-manifest cache-retention + escalation
 * interaction. Loads the REAL job-service + polling-service so the actual
 * _mergeJobs retention exception interacts with the actual escalation loop
 * in pollJobs(). Stubs only the I/O boundary (configService, logger,
 * job-download-service, etc.).
 *
 * Scenario (the user's explicit ask): an awaiting-manifest job drops out
 * of /pending-jobs mid-window. Without the merge exception, the job would
 * vanish from the cache silently. With the exception, the job is retained
 * → polling loop's threshold check fires → _status:'error' surfaces the
 * failure to the operator.
 *
 * Run via:  npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── State controlled by tests ────────────────────────────────────────────────

let __timeoutMs   = 600000;
let __checkResult = { found: false, hasFiles: false, hasManifest: false };

const fakeConfigService = {
  get: (key) => {
    if (key === 'awaitingManifestTimeoutMs') return __timeoutMs;
    return undefined;
  },
};

const noopLogger = { info: () => {}, warn: () => {}, logError: () => {}, logWarning: () => {} };

const fakeJobDownloadService = { checkLocalFiles: () => __checkResult };

// electron-store stub so JobService constructs without dragging Electron in.
const FakeStore = function () {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
  };
};
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

// Module-load stubs — minimal set polling-service + its REAL job-service touch.
stubInCache(path.join(SVC, 'config-service.js'),         fakeConfigService);
stubInCache(path.join(SVC, 'logger.js'),                 noopLogger);
stubInCache(path.join(SVC, 'job-download-service.js'),   fakeJobDownloadService);
stubInCache(path.join(SVC, 'ftp-service.js'),            {});
stubInCache(path.join(SVC, 'folder-watch-service.js'),   {});
stubInCache(path.join(SVC, 's3-artwork-downloader.js'),  { createS3ArtworkDownloader: () => ({ downloadJobArtwork: async () => {} }) });
stubInCache(path.join(SVC, 'print-controller-store.js'), { printControllerStore: { getAllControllers: () => [] } });
stubInCache(path.join(SVC, 'routing-service.js'),        { getControllers: () => [], getRoutingHeldProcesses: () => [] });
stubInCache(path.join(SVC, 'folder-monitor.js'),         { FolderMonitor: class { startMonitoring() {} stopMonitoring() {} } });

// REAL job-service + polling-service.
const jobService     = require(path.join(SVC, 'job-service.js'));
const pollingService = require(path.join(SVC, 'polling-service.js'));
pollingService._notifyJobsUpdated = () => {};

// ── Test ─────────────────────────────────────────────────────────────────────

test('end-to-end: awaiting job drops from API → retained by exception → polling escalates after threshold', async () => {
  __timeoutMs = 1000; // 1 s — make timeout immediate for the test
  const stampedAt = new Date(Date.now() - 60_000).toISOString(); // 60 s ago, well past 1 s threshold

  // Seed the cache with one awaiting job. Status pending, files present,
  // manifest absent, awaiting flag stamped a minute ago.
  jobService.jobs = [{
    id: 38461218,
    order_id: 'ord-1',
    order_number: 'PXSTAGE-XYZ',
    _status: 'pending',
    _awaitingManifest: true,
    _awaitingManifestSince: stampedAt,
    _awaitingManifestPath: '/tmp/PXSTAGE-XYZ.json',
  }];

  __checkResult = {
    found: true, hasFiles: true, hasManifest: false,
    localPath: '/tmp/PXSTAGE-XYZ_ord-1/PXSTAGE-XYZ_38461218',
    manifestPath: '/tmp/PXSTAGE-XYZ.json',
    fileCount: 1,
  };

  // Simulate the API dropping the job: fetchJobs returns an empty array.
  // This is the critical condition — without the merge exception, the next
  // _mergeJobs call would drop the job from the cache before the polling
  // escalation loop in the same pollJobs() tick could fire.
  jobService.fetchJobs = async () => {
    const fetched = []; // API no longer returns this job
    jobService.jobs = jobService._mergeJobs(fetched);
    return jobService.jobs;
  };

  // syncJobStatusFromOH would hit OH for our pending job; stub it out for
  // this test so a missing API key doesn't trip the path. (Its behaviour
  // for missing-from-OH is separately covered — see job-service.js:531.)
  jobService.syncJobStatusFromOH = async () => 0;

  await pollingService.pollJobs();

  // The job must still be present in the cache (merge exception worked) AND
  // flipped to _status:'error' (escalation fired).
  const job = jobService.jobs.find(j => j.id === 38461218);
  assert.ok(job, 'job retained by the merge exception — not silently dropped');
  assert.equal(job._status, 'error',
    'escalation loop fired on the same tick — past-timeout awaiting job surfaces as a real error');
  assert.match(job._errorMessage, /Order manifest not received within/);
  assert.equal(job._awaitingManifest, false, 'awaiting flag cleared on escalation');
});
