'use strict';

/**
 * IPC-level tests for the `ohd:job:retry` handler introduced in M8 of
 * docs/missing-print-size-recovery-brief.md.
 *
 * The handler:
 *   - resets an errored job's _status back to 'received' and clears
 *     _errorMessage, so runAutoPrint's eligibility gate
 *     (ipc-handlers.js: `_status !== 'received' && _status !== 'pending'`)
 *     picks it up on the next cycle;
 *   - does NOT dispatch directly — every existing gate (AI quality,
 *     routing hold, hold-for-review) must still apply;
 *   - is idempotent — retrying a non-errored job is a no-op that
 *     returns {success:true, changed:false} rather than surfacing an
 *     error;
 *   - is defensive on unknown ids — surfaces {success:false, error}
 *     rather than crashing.
 *
 * Stub set mirrors ipc-handlers-send-to-print-guard.test.js — only
 * what ipc-handlers' top-level require chain touches, plus a spy on
 * jobService.updateJobLocally so the state-mutation assertions can
 * inspect what the handler did (or didn't) call it with.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MAIN = path.join(REPO, 'src', 'main');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Capture state ────────────────────────────────────────────────────────────

const __ipcHandlers = new Map();   // channel → handler fn
let   __jobs         = [];
const __updateCalls  = [];         // [{ id, updates }] — spies on updateJobLocally

function resetState() {
  __jobs = [];
  __updateCalls.length = 0;
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
  fetchJobs:    async () => __jobs,
  syncJobStatusFromOH: async () => {},
  markReceived:  async () => {},
  markCompleted: async () => {},
  updateJobLocally: (id, updates) => { __updateCalls.push({ id, updates }); },
  findJobByOrderNumber: () => undefined,
  findJobById:          () => undefined,
};

const fakeJobDownloadService = {
  checkLocalFiles: () => ({ found: false, hasFiles: false, hasManifest: false }),
};

const fakePrintService = {
  sendToPrint:       async () => ({ success: true }),
  sendViaDPOFRouted: async () => ({ success: true }),
  _sendViaFolderCopyRouted: async () => ({ success: true }),
};

const fakeRoutingService = {
  resolveRoute: () => ({ type: 'unrouted' }),
  getControllers: () => [],
  getChannelMappings: () => [],
  getRoutingHeldProcesses: () => new Set(),
  resolvePrintSizeCode: () => 'KG',
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

const retryJob = __ipcHandlers.get('ohd:job:retry');

function makeJob(overrides = {}) {
  return {
    id: 12345, order_number: 'PXSTAGE-XYZ', order_id: 'ord-1',
    _status: 'received',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('ohd:job:retry handler is registered', () => {
  assert.equal(typeof retryJob, 'function', 'M8 handler was registered by setupIpcHandlers');
});

test('errored job → _status flipped to "received", _errorMessage cleared, changed:true', async () => {
  resetState();
  __jobs = [makeJob({ _status: 'error', _errorMessage: 'Dispatch failed: no print size' })];

  const result = await retryJob(null, { jobId: 12345 });

  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.equal(__updateCalls.length, 1, 'updateJobLocally called exactly once');
  assert.equal(__updateCalls[0].id, 12345);
  assert.deepEqual(__updateCalls[0].updates, {
    _status: 'received',
    _errorMessage: null,
  }, 'exact update shape — _status flipped, _errorMessage explicitly null so the UI hint clears');
});

test('non-errored job (status "received") → no update, changed:false, success:true', async () => {
  // Idempotent no-op: a stale button click or a devtools invocation
  // should not fail loudly. The renderer's error branch renders the
  // Retry button only for _status === 'error', but the handler must
  // still be safe for the race case.
  resetState();
  __jobs = [makeJob({ _status: 'received' })];

  const result = await retryJob(null, { jobId: 12345 });

  assert.equal(result.success, true);
  assert.equal(result.changed, false);
  assert.equal(__updateCalls.length, 0, 'must NOT mutate a non-errored job');
});

test('non-errored job (status "completed") → no update, changed:false', async () => {
  // Belt-and-braces — the guard is `_status !== "error"`, so every
  // other status is left alone. Locked explicitly so a future
  // refactor that switches on a subset of statuses catches this
  // regression.
  resetState();
  __jobs = [makeJob({ _status: 'completed' })];

  const result = await retryJob(null, { jobId: 12345 });

  assert.equal(result.success, true);
  assert.equal(result.changed, false);
  assert.equal(__updateCalls.length, 0);
});

test('non-errored job (status "in_production") → no update, changed:false', async () => {
  resetState();
  __jobs = [makeJob({ _status: 'in_production' })];

  const result = await retryJob(null, { jobId: 12345 });

  assert.equal(result.success, true);
  assert.equal(result.changed, false);
  assert.equal(__updateCalls.length, 0);
});

test('unknown jobId → success:false with descriptive error, no update', async () => {
  resetState();
  __jobs = [makeJob({ id: 12345 })];

  const result = await retryJob(null, { jobId: 99999 });

  assert.equal(result.success, false);
  assert.match(result.error, /not found/i);
  assert.match(result.error, /99999/);
  assert.equal(__updateCalls.length, 0);
});

test('string jobId from renderer matches numeric jobId in local store', async () => {
  // The renderer sends jobId as a string via data-attribute; the
  // local store carries the API's numeric id. The handler coerces
  // both sides to String — same pattern as ohd:reprint:create at
  // :2076. Regression guard for a future refactor that swaps the
  // comparison to === without coercion.
  resetState();
  __jobs = [makeJob({ id: 12345, _status: 'error', _errorMessage: 'x' })];

  const result = await retryJob(null, { jobId: '12345' });

  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.equal(__updateCalls[0].id, 12345, 'updateJobLocally called with the numeric id from the store, not the string from the click');
});

test('handler accepts payload = raw jobId (not wrapped in an object)', async () => {
  // Defensive parameter unpacking — the preload wraps as
  // { jobId } but a direct devtools invocation might pass the id
  // directly. The handler shape `payload && payload.jobId != null
  // ? payload.jobId : payload` covers both.
  resetState();
  __jobs = [makeJob({ id: 12345, _status: 'error' })];

  const result = await retryJob(null, 12345);

  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.equal(__updateCalls.length, 1);
});
