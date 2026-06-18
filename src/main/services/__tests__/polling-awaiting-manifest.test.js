/**
 * Unit tests for polling-service's awaiting-manifest three-way decision.
 * Exercises just the pending-jobs loop body inside pollJobs() — fetchJobs,
 * S3 download, OH-sync, and the FTP/scan path are stubbed to no-ops.
 *
 * Cases:
 *   1. hasFiles && !hasManifest, first observation       → stamps flag + timestamp, stays pending
 *   2. hasFiles && !hasManifest, repeat under threshold  → flag preserved, NOT re-stamped
 *   3. hasFiles && hasManifest, was awaiting             → markReceived + flag cleared
 *   4. hasFiles && !hasManifest, past threshold          → _status:'error' + flag cleared
 *   5. !hasFiles                                          → no stamping, no markReceived
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

// ── Capture state ────────────────────────────────────────────────────────────

let __jobs           = [];
let __checkResult    = { found: false, hasFiles: false, hasManifest: false };
let __timeoutMs      = 600000;
const __markReceivedCalls = [];
const __updateCalls       = [];
const __logCalls          = { info: [], warn: [], error: [] };

function resetState() {
  __jobs = [];
  __checkResult = { found: false, hasFiles: false, hasManifest: false };
  __timeoutMs = 600000;
  __markReceivedCalls.length = 0;
  __updateCalls.length       = 0;
  __logCalls.info.length  = 0;
  __logCalls.warn.length  = 0;
  __logCalls.error.length = 0;
}

// ── Stubs ────────────────────────────────────────────────────────────────────

const fakeConfigService = {
  get(key) {
    if (key === 'awaitingManifestTimeoutMs') return __timeoutMs;
    if (key === 'downloadDirectory') return '';
    return undefined;
  },
};

const fakeJobService = {
  fetchJobs: async () => __jobs,
  getLocalJobs: () => ({ jobs: __jobs, lastFetchTime: null }),
  syncJobStatusFromOH: async () => {},
  markReceived: async (jobId, payload) => { __markReceivedCalls.push({ jobId, payload }); },
  updateJobLocally: (jobId, updates) => {
    __updateCalls.push({ jobId, updates });
    const job = __jobs.find(j => j.id === jobId);
    if (job) Object.assign(job, updates);
  },
};

const fakeJobDownloadService = {
  checkLocalFiles: () => __checkResult,
};

const fakeLogger = {
  info:       (...a) => __logCalls.info.push(a),
  warn:       (...a) => __logCalls.warn.push(a),
  logError:   (...a) => __logCalls.error.push(a),
  logWarning: (...a) => __logCalls.warn.push(a),
};

const noopExports = {};
const fakeS3Artwork = { createS3ArtworkDownloader: () => ({ downloadJobArtwork: async () => {} }) };
const fakeFolderMonitor = { FolderMonitor: class { startMonitoring() {} stopMonitoring() {} } };

stubInCache(path.join(SVC, 'config-service.js'),         fakeConfigService);
stubInCache(path.join(SVC, 'ftp-service.js'),            noopExports);
stubInCache(path.join(SVC, 'folder-watch-service.js'),   noopExports);
stubInCache(path.join(SVC, 'job-service.js'),            fakeJobService);
stubInCache(path.join(SVC, 'job-download-service.js'),   fakeJobDownloadService);
stubInCache(path.join(SVC, 's3-artwork-downloader.js'),  fakeS3Artwork);
stubInCache(path.join(SVC, 'print-controller-store.js'), { printControllerStore: { getAllControllers: () => [] } });
stubInCache(path.join(SVC, 'routing-service.js'),        { getControllers: () => [] });
stubInCache(path.join(SVC, 'folder-monitor.js'),         fakeFolderMonitor);
stubInCache(path.join(SVC, 'logger.js'),                 fakeLogger);

const pollingService = require(path.join(SVC, 'polling-service.js'));
pollingService._notifyJobsUpdated = () => {};

// ── Fixtures ─────────────────────────────────────────────────────────────────

function pendingJob(overrides = {}) {
  return {
    id: 38461218,
    order_id: 'ord-1',
    order_number: 'PXSTAGE-XYZ',
    _status: 'pending',
    ...overrides,
  };
}

const MANIFEST_PATH = '/tmp/PXSTAGE-XYZ_ord-1/PXSTAGE-XYZ.json';
const LOCAL_PATH    = '/tmp/PXSTAGE-XYZ_ord-1/PXSTAGE-XYZ_38461218';

// ── Tests ────────────────────────────────────────────────────────────────────

test('first observation with files+no-manifest → stamps _awaitingManifest + timestamp; job stays pending', async () => {
  resetState();
  __jobs = [pendingJob()];
  __checkResult = {
    found: true, hasFiles: true, hasManifest: false,
    localPath: LOCAL_PATH, manifestPath: MANIFEST_PATH, fileCount: 1,
  };

  await pollingService.pollJobs();

  assert.equal(__markReceivedCalls.length, 0, 'no markReceived without manifest');
  const stamps = __updateCalls.filter(c => c.updates._awaitingManifest === true);
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].updates._awaitingManifestPath, MANIFEST_PATH);
  assert.ok(stamps[0].updates._awaitingManifestSince, 'timestamp stamped on first observation');
  assert.equal(__jobs[0]._status, 'pending', 'job stays pending — no error escalation yet');
});

test('repeat observation under threshold → flag preserved, timestamp NOT re-stamped', async () => {
  resetState();
  const sinceIso = new Date(Date.now() - 30000).toISOString(); // 30 s ago — well under default
  __jobs = [pendingJob({
    _awaitingManifest: true,
    _awaitingManifestSince: sinceIso,
    _awaitingManifestPath: MANIFEST_PATH,
  })];
  __checkResult = {
    found: true, hasFiles: true, hasManifest: false,
    localPath: LOCAL_PATH, manifestPath: MANIFEST_PATH, fileCount: 1,
  };

  await pollingService.pollJobs();

  assert.equal(__markReceivedCalls.length, 0);
  assert.equal(__updateCalls.length, 0, 'no updates — already stamped + still under threshold');
  assert.equal(__jobs[0]._awaitingManifestSince, sinceIso, 'timestamp preserved verbatim');
});

test('manifest arrives for previously-awaiting job → markReceived + flags cleared', async () => {
  resetState();
  __jobs = [pendingJob({
    _awaitingManifest: true,
    _awaitingManifestSince: new Date(Date.now() - 60000).toISOString(),
    _awaitingManifestPath: MANIFEST_PATH,
  })];
  __checkResult = {
    found: true, hasFiles: true, hasManifest: true,
    localPath: LOCAL_PATH, manifestPath: MANIFEST_PATH, fileCount: 1,
  };

  await pollingService.pollJobs();

  assert.equal(__markReceivedCalls.length, 1, 'markReceived fired on manifest arrival');
  assert.equal(__markReceivedCalls[0].jobId, 38461218);

  const clear = __updateCalls.find(c => c.updates._awaitingManifest === false);
  assert.ok(clear, 'awaiting-manifest flag cleared after markReceived');
  assert.equal(clear.updates._awaitingManifestSince, null);
  assert.equal(clear.updates._awaitingManifestPath, null);
});

test('past threshold → escalates to _status:"error" with timeout message, flags cleared', async () => {
  resetState();
  __timeoutMs = 1000; // 1 s for the test
  __jobs = [pendingJob({
    _awaitingManifest: true,
    _awaitingManifestSince: new Date(Date.now() - 60000).toISOString(), // 60 s ago
    _awaitingManifestPath: MANIFEST_PATH,
  })];
  __checkResult = {
    found: true, hasFiles: true, hasManifest: false,
    localPath: LOCAL_PATH, manifestPath: MANIFEST_PATH, fileCount: 1,
  };

  await pollingService.pollJobs();

  assert.equal(__markReceivedCalls.length, 0);
  const errorUpdate = __updateCalls.find(c => c.updates._status === 'error');
  assert.ok(errorUpdate, 'job escalated to _status:"error"');
  assert.match(errorUpdate.updates._errorMessage, /Order manifest not received within \d+ minutes/);
  assert.match(errorUpdate.updates._errorMessage, /PXSTAGE-XYZ\.json/);
  assert.equal(errorUpdate.updates._awaitingManifest, false, 'flag cleared on escalation');
  assert.equal(errorUpdate.updates._awaitingManifestSince, null);
  assert.equal(errorUpdate.updates._awaitingManifestPath, null);
});

test('no files yet → no stamping, no markReceived, no escalation', async () => {
  resetState();
  __jobs = [pendingJob()];
  __checkResult = { found: false, hasFiles: false, hasManifest: false };

  await pollingService.pollJobs();

  assert.equal(__markReceivedCalls.length, 0);
  assert.equal(__updateCalls.length, 0, 'still-downloading state — no writes');
});

test('manifest arrives for never-awaiting job → markReceived; no _awaitingManifest clear', async () => {
  // Sanity: the manifest-arrived branch must only emit the clear when the
  // job actually had the flag set. Spurious clear writes would churn the
  // electron-store and renderer for no reason.
  resetState();
  __jobs = [pendingJob()]; // no _awaitingManifest
  __checkResult = {
    found: true, hasFiles: true, hasManifest: true,
    localPath: LOCAL_PATH, manifestPath: MANIFEST_PATH, fileCount: 1,
  };

  await pollingService.pollJobs();

  assert.equal(__markReceivedCalls.length, 1);
  const clearCalls = __updateCalls.filter(c => 'awaitingManifest' in c.updates || c.updates._awaitingManifest === false);
  assert.equal(clearCalls.length, 0, 'no clear write when there was nothing to clear');
});
