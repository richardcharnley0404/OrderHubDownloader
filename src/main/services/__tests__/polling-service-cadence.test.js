/**
 * Confirms that polling-service reads its cadence through
 * server-capabilities, not directly from configService — so the
 * server-advertised value wins at start() on boot (including restarts
 * against a persisted value), through getStatus(), and via
 * applyServerCadence() on live changes.
 *
 * server-capabilities is stubbed via require.cache so we can dictate the
 * "advertised" value without spinning up an electron-store. global.setInterval
 * is monkey-patched around start() to capture the ms the timer was armed
 * with — that's the fact the fix actually turns on.
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

// ── Capabilities stub — the value under test ────────────────────────────────

let __advertisedMs = 60000;

const fakeServerCapabilities = {
  getPollIntervalMs: () => __advertisedMs,
  // Not exercised here but polling-service may touch these on other paths;
  // provide safe defaults so the test file doesn't accidentally break when
  // more callers land in later milestones.
  getStatusPollIntervalMs: () => null,
  isEnabled: () => false,
  getStatusBatchMax: () => 200,
};

stubInCache(path.join(SVC, 'server-capabilities.js'), {
  serverCapabilities: fakeServerCapabilities,
});

// ── Everything else start() touches — stub to a no-op shape ─────────────────

const fakeConfigService = {
  get: (key) => (key === 'orderXmlAutoSyncMinutes' ? 1 : undefined),
  getAll: () => ({
    // Exactly one mode enabled so start() proceeds past its "no modes" guard.
    pollingEnabled:    true,
    filmScansEnabled:  false,
    fileUploadsEnabled: false,
    orderXmlEnabled:   false,
    orderhubApiKey:    null, // suppress pollJobs
  }),
  isConfigured: () => false, // suppress scanFtp
};

const fakeLogger = {
  info: () => {}, warn: () => {}, error: () => {},
  logError: () => {}, logWarning: () => {},
};

stubInCache(path.join(SVC, 'config-service.js'),         fakeConfigService);
stubInCache(path.join(SVC, 'ftp-service.js'),            {});
stubInCache(path.join(SVC, 'folder-watch-service.js'),   {});
stubInCache(path.join(SVC, 'job-service.js'),            {
  fetchJobs: async () => [], getLocalJobs: () => ({ jobs: [], lastFetchTime: null }),
  syncJobStatusFromOH: async () => {}, updateJobLocally: () => {},
  markReceived: async () => {}, findJobById: () => null, markCompleted: async () => {},
});
stubInCache(path.join(SVC, 'job-download-service.js'),   { checkLocalFiles: () => ({}) });
stubInCache(path.join(SVC, 's3-artwork-downloader.js'),  {
  createS3ArtworkDownloader: () => ({ downloadJobArtwork: async () => ({ failed: [] }) }),
});
stubInCache(path.join(SVC, 'print-controller-store.js'), { printControllerStore: { getAllControllers: () => [] } });
stubInCache(path.join(SVC, 'routing-service.js'),        { getControllers: () => [], getRoutingHeldProcesses: () => new Set() });
stubInCache(path.join(SVC, 'print-controller-service.js'),{ printControllerService: { startAllPicProMonitors: () => {} } });
stubInCache(path.join(SVC, 'folder-monitor.js'),         { FolderMonitor: class { startMonitoring() {} stopMonitoring() {} } });
stubInCache(path.join(SVC, 'logger.js'),                 fakeLogger);

const pollingService = require(path.join(SVC, 'polling-service.js'));

// ── helper: run start() with global.setInterval spied ───────────────────────

function withSetIntervalSpy(fn) {
  const captured = [];
  const origSet   = global.setInterval;
  const origClear = global.clearInterval;
  global.setInterval   = (cb, ms) => { captured.push(ms); return { _fake: true, unref: () => {} }; };
  global.clearInterval = () => {};
  try {
    fn(captured);
  } finally {
    global.setInterval   = origSet;
    global.clearInterval = origClear;
  }
  return captured;
}

// ── tests ───────────────────────────────────────────────────────────────────

test('start() clocks the initial timer to the server-advertised value when one is persisted', () => {
  __advertisedMs = 120000; // simulate a persisted server-capabilities value
  if (pollingService.isPolling) pollingService.stop();

  const captured = withSetIntervalSpy(() => {
    pollingService.start();
  });

  // First setInterval call is the main polling timer; extra calls (film
  // scans / file uploads / order XML) are gated off in the fake config.
  assert.equal(captured[0], 120000, 'start() used serverCapabilities.getPollIntervalMs()');
  assert.equal(pollingService._activeIntervalMs, 120000, 'active interval tracked');

  // Clean up so subsequent tests get a fresh state machine.
  pollingService.stop();
});

test('getStatus().interval reflects the server-advertised value', () => {
  __advertisedMs = 90000;
  assert.equal(pollingService.getStatus().interval, 90000);
});

test('applyServerCadence() re-clocks when the advertised value changes, and no-ops when it does not', () => {
  __advertisedMs = 60000;
  if (pollingService.isPolling) pollingService.stop();

  // Prime an initial timer at 60s.
  withSetIntervalSpy(() => pollingService.start());
  assert.equal(pollingService._activeIntervalMs, 60000);

  // Server pushes 30s → applyServerCadence should re-arm.
  __advertisedMs = 30000;
  const captured = withSetIntervalSpy(() => pollingService.applyServerCadence());
  assert.deepEqual(captured, [30000], 'setInterval re-armed once at the new value');
  assert.equal(pollingService._activeIntervalMs, 30000);

  // No advertised change → no re-arm.
  const capturedNoop = withSetIntervalSpy(() => pollingService.applyServerCadence());
  assert.deepEqual(capturedNoop, [], 'no-op when new === old');
  assert.equal(pollingService._activeIntervalMs, 30000);

  pollingService.stop();
  assert.equal(pollingService._activeIntervalMs, null, 'stop() clears the active-interval bookkeeping');
});
