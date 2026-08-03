/**
 * Unit test for the manual `jobs:sendToPrint` IPC handler's defensive
 * awaiting-manifest guard. Even with the renderer hiding the Process
 * button while _awaitingManifest is true, a direct IPC call from devtools
 * (or a stale click) would still hit print-service._readManifest and
 * throw "Order manifest not found", entering the sticky-error path.
 *
 * Guard returns { success:false, error:'Manifest not yet received' }
 * before the dispatch is attempted.
 *
 * Run via:  npm test
 *
 * Stub set mirrors ipc-handlers-auto-print.test.js verbatim — the only
 * stubs needed are the ones ipc-handlers' top-level require chain touches.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MAIN = path.join(REPO, 'src', 'main');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Capture state ────────────────────────────────────────────────────────────

const __ipcHandlers = new Map();   // channel → handler fn
let __jobs           = [];
let __checkResult    = { found: false, hasFiles: false, hasManifest: false };
const __dispatchCalls = [];

function resetState() {
  __jobs = [];
  __checkResult = { found: false, hasFiles: false, hasManifest: false };
  __dispatchCalls.length = 0;
}

// ── Stubs ────────────────────────────────────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const fakeConfigService = {
  get: () => undefined,
  getApiSettings: () => ({ baseUrl: '', key: '', organizationId: '', locationId: '' }),
  getFtpCredentials: () => ({ host: '', user: '', password: '', port: 21, secure: false }),
};

const fakeJobService = {
  getLocalJobs: () => ({ jobs: __jobs, lastFetchTime: null }),
  fetchJobs: async () => __jobs,
  syncJobStatusFromOH: async () => {},
  markReceived: async () => {},
  markCompleted: async () => {},
  updateJobLocally: () => {},
  findJobByOrderNumber: () => undefined,
  findJobById: () => undefined,
};

const fakeJobDownloadService = {
  checkLocalFiles: () => __checkResult,
};

const fakePrintService = {
  sendToPrint: async (job) => { __dispatchCalls.push({ via: 'sendToPrint', jobId: job.id }); return { success: true }; },
  sendViaDPOFRouted: async (job) => { __dispatchCalls.push({ via: 'sendViaDPOFRouted', jobId: job.id }); return { success: true }; },
  _sendViaFolderCopyRouted: async (job) => { __dispatchCalls.push({ via: 'folderCopy', jobId: job.id }); return { success: true }; },
};

const fakeRoutingService = {
  resolveRoute: () => ({ type: 'unrouted' }),   // forces sendToPrint legacy path
  getControllers: () => [],
  getRoutingHeldProcesses: () => [],
  resolvePrintSizeCode: () => 'KG',
  // Startup-time methods called from setupIpcHandlers
  migrateFromPrintControllerStore: () => {},
  backfillLegacyPrintSizeCode: () => {},
  backfillFujiPrintSize: () => {},
  validateDPOFPrintSizeCode: () => ({ valid: true }),
  stripDeprecatedConfigJsonKeys: () => {},
};

const noopLogger = { info: () => {}, warn: () => {}, logError: () => {}, logWarning: () => {} };

function FakeStore() {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
    delete: (k)    => { delete data[k]; },
  };
}

// Same proven set as ipc-handlers-auto-print.test.js — only what
// ipc-handlers' top-level requires touch.
stubInCache(path.join(SVC,  'config-service.js'),                    fakeConfigService);
stubInCache(path.join(SVC,  'logger.js'),                            noopLogger);
stubInCache(path.join(SVC,  'job-service.js'),                       fakeJobService);
stubInCache(path.join(SVC,  'print-service.js'),                     fakePrintService);
stubInCache(path.join(SVC,  'routing-service.js'),                   fakeRoutingService);
stubInCache(path.join(SVC,  's3-service.js'),                        {});
stubInCache(path.join(SVC,  'test-print-controller.js'),             { runTest: async () => ({}) });
stubInCache(path.join(SVC,  'print-controller-store.js'),            { printControllerStore: { get: () => [], set: () => {} } });
stubInCache(path.join(SVC,  'process-folder-service.js'),            {});
stubInCache(path.join(SVC,  'frame-metadata-store.js'),              {});
stubInCache(path.join(SVC,  'film-review-prefs-store.js'),           {});
stubInCache(path.join(SVC,  'folder-watch-service.js'),              {});
stubInCache(path.join(SVC,  'job-download-service.js'),              fakeJobDownloadService);
stubInCache(path.join(SVC,  'ai-job-quality-orchestrator.js'),       { scoreJob: async () => ({ ok: true, held: false }) });
stubInCache(path.join(SVC,  'ai-quality-store.js'),                  { getJobQuality: async () => [], deriveHeld: () => false });
stubInCache(path.join(MAIN, 'updater.js'),                           { setMainWindow: () => {}, startUpdateSchedule: () => {} });

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      ipcMain:       { handle: (ch, fn) => __ipcHandlers.set(ch, fn), on: () => {} },
      dialog:        { showOpenDialog: async () => ({ canceled: true }) },
      app:           { getVersion: () => 'test', getPath: () => '/' },
      BrowserWindow: function () {},
      shell:         { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    };
  }
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

// Load ipc-handlers and invoke setupIpcHandlers — registration populates
// __ipcHandlers via the ipcMain.handle stub above.
const { setupIpcHandlers } = require(path.join(MAIN, 'ipc-handlers.js'));
const noopPollingService = {
  isRunning: () => false, getStatus: () => ({ running: false }),
  restartFolderMonitors: () => {}, setJobsUpdatedCallback: () => {},
  setAutoPrintCallback: () => {}, setOnAutoPrint: () => {},
  start: () => {}, stop: () => {},
};
const noopFtpService = {};
const noopWindowManager = { getWindow: () => null };
setupIpcHandlers(noopPollingService, noopFtpService, noopWindowManager);

const sendToPrint = __ipcHandlers.get('jobs:sendToPrint');

function makeJob(overrides = {}) {
  return {
    id: 'JOB-1', order_number: 'PXSTAGE-XYZ', order_id: 'ord-1',
    _status: 'received', ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('jobs:sendToPrint handler registered (loaded without error)', () => {
  assert.equal(typeof sendToPrint, 'function', 'ipc handler was registered');
});

test('sendToPrint guard: hasFiles && !hasManifest → { success:false, error:"Manifest not yet received" }', async () => {
  resetState();
  __jobs = [makeJob()];
  __checkResult = { found: true, hasFiles: true, hasManifest: false, localPath: '/tmp/job', manifestPath: '/tmp/PXSTAGE-XYZ.json' };

  const result = await sendToPrint(null, 'JOB-1');

  assert.equal(result.success, false);
  assert.equal(result.error, 'Manifest not yet received');
  assert.equal(__dispatchCalls.length, 0, 'dispatch must NOT run — guard fires before print-service');
});

test('sendToPrint guard: hasFiles && hasManifest → dispatch proceeds', async () => {
  resetState();
  __jobs = [makeJob()];
  __checkResult = { found: true, hasFiles: true, hasManifest: true, localPath: '/tmp/job', manifestPath: '/tmp/PXSTAGE-XYZ.json' };

  const result = await sendToPrint(null, 'JOB-1');

  assert.equal(result.success, true);
  assert.equal(__dispatchCalls.length, 1, 'dispatch ran — manifest present');
});

test('sendToPrint guard: !hasFiles → dispatch proceeds (guard scope is the files-present-no-manifest race only)', async () => {
  resetState();
  __jobs = [makeJob()];
  __checkResult = { found: false, hasFiles: false, hasManifest: false };

  const result = await sendToPrint(null, 'JOB-1');

  assert.equal(result.success, true);
  assert.equal(__dispatchCalls.length, 1);
});
