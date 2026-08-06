/**
 * M4 — status-sync cadence.
 *
 * pollJobs() must only run jobService.syncJobStatusFromOH() when either:
 *   (a) server-capabilities has NOT advertised a status_poll_interval
 *       (pre-1.4.0 fallback ⇒ every cycle, today's behaviour), or
 *   (b) enough real time has passed since the last attempt.
 *
 * The bookkeeping (lastStatusSyncAt) must advance in a `finally`, so
 * that a throwing sync can't collapse the cadence back to every cycle.
 *
 * Tests use an injected clock (pollingService._now) so cycle counts and
 * elapsed times are deterministic without patching Date.now globally.
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

// ── mutable test state ──────────────────────────────────────────────────────

let __statusIntervalMs = null;   // what serverCapabilities.getStatusPollIntervalMs returns
let __syncBehaviour   = 'ok';    // 'ok' | 'throw'
const __syncCalls     = [];

const fakeServerCapabilities = {
  getStatusPollIntervalMs: () => __statusIntervalMs,
  getPollIntervalMs:       () => 60000,
  isEnabled:               () => false,
  getStatusBatchMax:       () => 200,
};

const fakeConfigService = {
  get: (key) => {
    if (key === 'awaitingManifestTimeoutMs') return 600000;
    if (key === 'downloadDirectory')          return '';
    if (key === 'orderXmlAutoSyncMinutes')    return 1;
    return undefined;
  },
  getAll: () => ({
    pollingEnabled:              true,
    filmScansEnabled:            false,
    fileUploadsEnabled:          false,
    orderXmlEnabled:             false,
    orderhubApiKey:              null,
    filmScanAutoAssignEnabled:   false,
  }),
  isConfigured: () => false,
};

const fakeJobService = {
  fetchJobs: async () => [],
  getLocalJobs: () => ({ jobs: [], lastFetchTime: null }),
  syncJobStatusFromOH: async () => {
    __syncCalls.push(Date.now());
    if (__syncBehaviour === 'throw') throw new Error('boom');
  },
  updateJobLocally: () => {},
  markReceived:     async () => {},
  markCompleted:    async () => {},
  findJobById:      () => null,
};

const fakeLogger = {
  info: () => {}, warn: () => {}, error: () => {},
  logError: () => {}, logWarning: () => {},
};

stubInCache(path.join(SVC, 'server-capabilities.js'),   { serverCapabilities: fakeServerCapabilities });
stubInCache(path.join(SVC, 'config-service.js'),        fakeConfigService);
stubInCache(path.join(SVC, 'job-service.js'),           fakeJobService);
stubInCache(path.join(SVC, 'job-download-service.js'),  { checkLocalFiles: () => ({ hasFiles: false, hasManifest: false }) });
stubInCache(path.join(SVC, 'ftp-service.js'),           {});
stubInCache(path.join(SVC, 'folder-watch-service.js'),  {});
stubInCache(path.join(SVC, 's3-artwork-downloader.js'), {
  createS3ArtworkDownloader: () => ({ downloadJobArtwork: async () => ({ failed: [] }) }),
});
stubInCache(path.join(SVC, 'print-controller-store.js'),   { printControllerStore: { getAllControllers: () => [] } });
stubInCache(path.join(SVC, 'routing-service.js'),          { getControllers: () => [], getRoutingHeldProcesses: () => new Set() });
stubInCache(path.join(SVC, 'print-controller-service.js'), { printControllerService: { startAllPicProMonitors: () => {} } });
stubInCache(path.join(SVC, 'folder-monitor.js'),           { FolderMonitor: class { startMonitoring() {} stopMonitoring() {} } });
stubInCache(path.join(SVC, 'logger.js'),                   fakeLogger);

const pollingService = require(path.join(SVC, 'polling-service.js'));

// ── per-test helpers ────────────────────────────────────────────────────────

function reset() {
  __statusIntervalMs = null;
  __syncBehaviour    = 'ok';
  __syncCalls.length = 0;
  pollingService.lastStatusSyncAt = null;
}

/** Install a deterministic clock at `nowMs`. Advance via `advance(dt)`. */
function withFakeClock(startMs) {
  let cur = startMs;
  pollingService._now = () => cur;
  return {
    advance: (dt) => { cur += dt; },
    at: () => cur,
    restore: () => { pollingService._now = () => Date.now(); },
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

test('getStatusPollIntervalMs() === null → sync runs on every pollJobs()', async () => {
  reset();
  const clock = withFakeClock(1_000_000);
  __statusIntervalMs = null;

  try {
    for (let i = 0; i < 4; i++) {
      await pollingService.pollJobs();
      clock.advance(60_000); // 60s between cycles
    }
  } finally {
    clock.restore();
  }

  assert.equal(__syncCalls.length, 4, 'ran on every cycle');
  assert.equal(pollingService.lastStatusSyncAt, clock.at() - 60_000, 'stamped on last cycle');
});

test('300s advertised → runs on cycle 1, skipped on 2–5, runs again on cycle 6', async () => {
  reset();
  const clock = withFakeClock(2_000_000);
  __statusIntervalMs = 300_000; // 5 minutes

  // Cycles are 60s apart — matches the default poll interval.
  try {
    for (let i = 0; i < 6; i++) {
      await pollingService.pollJobs();
      clock.advance(60_000);
    }
  } finally {
    clock.restore();
  }

  // Cycle 1: due (lastStatusSyncAt was null) → sync.
  // Cycles 2 (60s elapsed) through 5 (240s) → skip.
  // Cycle 6 (300s elapsed) → due again → sync.
  assert.equal(__syncCalls.length, 2, 'exactly two syncs across six cycles');
});

test('a throwing sync still advances lastStatusSyncAt (finally-guaranteed)', async () => {
  reset();
  const clock = withFakeClock(3_000_000);
  __statusIntervalMs = 300_000;
  __syncBehaviour    = 'throw';

  try {
    await pollingService.pollJobs();
  } finally {
    clock.restore();
  }

  assert.equal(__syncCalls.length, 1, 'sync was attempted');
  assert.equal(pollingService.lastStatusSyncAt, 3_000_000, 'timestamp advanced despite throw');

  // Subsequent cycle before the interval elapses must skip, proving the
  // finally-set timestamp actually gates future cycles even after failure.
  const clock2 = withFakeClock(3_060_000); // +60s
  __syncBehaviour = 'ok';
  try {
    await pollingService.pollJobs();
  } finally {
    clock2.restore();
  }
  assert.equal(__syncCalls.length, 1, 'no sync — under 300s since last attempt');
});

test('getStatus() surfaces lastStatusSync alongside lastCheck', async () => {
  reset();
  const clock = withFakeClock(4_000_000);
  __statusIntervalMs = null;

  try {
    await pollingService.pollJobs();
  } finally {
    clock.restore();
  }

  const s = pollingService.getStatus();
  assert.equal(s.lastStatusSync, 4_000_000, 'lastStatusSync populated');
  assert.ok('lastCheck' in s, 'lastCheck still present');
});
