/**
 * Regression test for the v1.7.10 fix.
 *
 * Background: pre-v1.7.10, PrintControllerService.startMonitoring(controllerId)
 * looked up the controller in the legacy printControllerStore only. Controllers
 * created via the modern Routing settings UI (which is everything except a
 * historical Darkroom Pro entry) were invisible to that lookup, so Fuji
 * JobMaker dispatch crashed with `Controller <id> not found` at the monitor-
 * registration step.
 *
 * v1.7.10 routes the lookup through routing-service first, falling back to
 * the legacy store. This test pins down that behaviour with a fake Fuji
 * controller present ONLY in routing-service.
 *
 * Loading print-controller-service requires electron-store at module load
 * (via the routing-service and printControllerStore transitive requires).
 * We stub every dependency via require.cache injection — same pattern as
 * ipc-handlers-auto-print.test.js — so the file loads without electron.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── Capture state ────────────────────────────────────────────────────────────

const FUJI_ID    = 'bf223599-e586-4ce9-a8f4-725adeca5849';
const FUJI_PATH  = 'C:\\OHD\\hot\\fuji';

let __fujiMonitorStartCalls = [];

// ── Stub modules ─────────────────────────────────────────────────────────────

// routing-service: the modern store carries the Fuji controller. Pre-v1.7.10
// the bug code didn't consult this — it only looked in printControllerStore
// (stubbed empty below) — and that's what produced "Controller <id> not found".
const fakeRoutingService = {
  getControllers: () => [
    {
      id:               FUJI_ID,
      name:             'Fuji Jobmaker',
      type:             'fujijobmaker',
      // routing-service entries carry `outputPath` — the v1.7.10 fix also
      // normalises field names so this is exercised. hotFolderPath also
      // exists on the live controller; we leave it off here to make sure
      // the fallback path works.
      outputPath:       FUJI_PATH,
      failureTimeoutMs: 60 * 1000,
      checkOrderStatus: false,
    },
  ],
  // Other exports the real routing-service offers — not exercised by
  // startMonitoring but referenced at module load via destructuring.
  resolvePrintSizeCode: () => 'KG',
};

// Legacy store: empty. Mirrors live state on Richard's machine where the
// modern Routing UI doesn't write here.
const fakePrintControllerStore = {
  printControllerStore: {
    getController: () => undefined,
  },
};

// Monitors — capture calls so the assertion below can check the path used.
const fakeFolderMonitor = {
  FolderMonitor: class { startMonitoring() {} },
};
const fakeDarkroomProMonitor = {
  DarkroomProMonitor: class { startMonitoring() {} },
};
const fakeFujiJobMakerMonitor = {
  FujiJobMakerMonitor: class {
    startMonitoring(hotFolderPath, options, _callback) {
      __fujiMonitorStartCalls.push({ hotFolderPath, options });
    }
  },
};

const fakeJobStore = { jobStore: { updateJobStatus: () => {} } };
const fakeDpofGenerator = { dpofGenerator: { generate: () => '' } };
const fakeOrderFolderWriter = { orderFolderWriter: { writeOrderFolder: async () => '' } };
const noopLogger = {
  info: () => {}, warn: () => {}, logError: () => {},
  logWarning: () => {},
};

stubInCache(path.join(SVC, 'routing-service.js'),         fakeRoutingService);
stubInCache(path.join(SVC, 'print-controller-store.js'),  fakePrintControllerStore);
stubInCache(path.join(SVC, 'folder-monitor.js'),          fakeFolderMonitor);
stubInCache(path.join(SVC, 'darkroom-pro-monitor.js'),    fakeDarkroomProMonitor);
stubInCache(path.join(SVC, 'fuji-jobmaker-monitor.js'),   fakeFujiJobMakerMonitor);
stubInCache(path.join(SVC, 'job-store.js'),               fakeJobStore);
stubInCache(path.join(SVC, 'dpof-generator.js'),          fakeDpofGenerator);
stubInCache(path.join(SVC, 'order-folder-writer.js'),     fakeOrderFolderWriter);
stubInCache(path.join(SVC, 'logger.js'),                  noopLogger);

// Now load the system under test. The transitive electron-store requires
// inside the real routing-service / printControllerStore never run because
// require.cache already has stubs at those resolved paths.
const { printControllerService } = require(path.join(SVC, 'print-controller-service.js'));


// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

test('startMonitoring resolves a Fuji controller via routing-service (v1.7.10 fix)', () => {
  __fujiMonitorStartCalls = [];

  // Pre-v1.7.10 this threw `Controller <id> not found` because only
  // printControllerStore was consulted and that store doesn't know about
  // Fuji controllers created via the modern Routing UI.
  assert.doesNotThrow(
    () => printControllerService.startMonitoring(FUJI_ID),
    'startMonitoring must accept a Fuji controller that exists only in routing-service',
  );

  assert.equal(__fujiMonitorStartCalls.length, 1, 'FujiJobMakerMonitor.startMonitoring was called once');
  assert.equal(
    __fujiMonitorStartCalls[0].hotFolderPath, FUJI_PATH,
    'monitor receives the controller hot folder path (normalised from outputPath when hotFolderPath is absent)',
  );
});

test('startMonitoring is idempotent — second call for the same controller is a no-op', () => {
  __fujiMonitorStartCalls = [];
  printControllerService.startMonitoring(FUJI_ID); // already monitored from prior test — early return

  assert.equal(__fujiMonitorStartCalls.length, 0,
    'no new monitor.startMonitoring call when controller is already being monitored');
});

test('startMonitoring throws when controller is unknown to BOTH stores', () => {
  assert.throws(
    () => printControllerService.startMonitoring('ghost-id-not-in-any-store'),
    /Controller ghost-id-not-in-any-store not found/,
  );
});
