'use strict';

/**
 * IPC-level tests for the Darkroom Pro `autoSendBatches` validation
 * added to `ohd:routing:save-controller` in M2 of
 * docs/auto-batch-and-ui-tidy-brief.md.
 *
 * The handler now rejects a non-boolean `autoSendBatches` on a
 * darkroompro controller. Renderer always sends `checkbox.checked`
 * (strict boolean); the IPC mirror is the belt-and-braces check
 * against a future renderer bug or an external caller that would
 * otherwise persist a truthy non-boolean that silently disables
 * the operator-review gate on every over-cap job.
 *
 * Same shape as ipc-save-controller-picpro-merge.test.js — full
 * ipc-handlers.js load with a small stateful routing-service stub so
 * "persisted" vs "rejected" is directly assertable via what did or
 * didn't reach saveController.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MAIN = path.join(REPO, 'src', 'main');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Capture state ────────────────────────────────────────────────────────────

const __ipcHandlers = new Map();
let   __controllers = [];   // stateful — saveController mutates in place
const __warns       = [];

function resetState() {
  __controllers = [];
  __warns.length = 0;
}

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── Stubs ────────────────────────────────────────────────────────────────────

const fakeConfigService = {
  get: () => undefined,
  getApiSettings: () => ({ baseUrl: '', key: '', organizationId: '', locationId: '' }),
  getFtpCredentials: () => ({ host: '', user: '', password: '', port: 21, secure: false }),
};

const fakeJobService = {
  getLocalJobs: () => ({ jobs: [], lastFetchTime: null }),
  fetchJobs:    async () => [],
  syncJobStatusFromOH: async () => {},
  markReceived:  async () => {},
  markCompleted: async () => {},
  updateJobLocally: () => {},
  findJobByOrderNumber: () => undefined,
  findJobById:          () => undefined,
};

const fakePrintService = {
  sendToPrint:              async () => ({ success: true }),
  sendViaDPOFRouted:        async () => ({ success: true }),
  _sendViaFolderCopyRouted: async () => ({ success: true }),
};

// Stateful routing service. saveController rewrites the entry in
// __controllers; getControllers returns the live array so the handler
// sees writes back — same pattern as ipc-save-controller-picpro-merge.
const fakeRoutingService = {
  resolveRoute: () => ({ type: 'unrouted' }),
  getControllers: () => __controllers,
  saveController: (ctrl) => {
    const idx = __controllers.findIndex(c => c.id === ctrl.id);
    if (idx >= 0) __controllers[idx] = ctrl;
    else __controllers.push(ctrl);
  },
  getChannelMappings: () => [],
  getRoutingHeldProcesses: () => new Set(),
  resolvePrintSizeCode: () => 'KG',
  migrateFromPrintControllerStore: () => {},
  backfillLegacyPrintSizeCode: () => {},
  backfillFujiPrintSize: () => {},
  validateDPOFPrintSizeCode: () => ({ valid: true }),
  stripDeprecatedConfigJsonKeys: () => {},
};

const fakeJobDownloadService = { checkLocalFiles: () => ({ found: false, hasFiles: false, hasManifest: false }) };

const captureLogger = {
  info:       () => {},
  warn:       () => {},
  logError:   () => {},
  logWarning: (msg, meta) => { __warns.push({ msg, meta }); },
};

function FakeStore() {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
    delete: (k)    => { delete data[k]; },
  };
}

// The darkroompro save path dual-writes to printControllerStore. Stub
// the whole surface so we don't chase an unrelated failure.
const fakePrintControllerStore = {
  printControllerStore: {
    getController: () => null,
    updateController: () => {},
    store: {
      get: () => ({}),
      set: () => {},
    },
  },
};

stubInCache(path.join(SVC,  'config-service.js'),                    fakeConfigService);
stubInCache(path.join(SVC,  'logger.js'),                            captureLogger);
stubInCache(path.join(SVC,  'job-service.js'),                       fakeJobService);
stubInCache(path.join(SVC,  'print-service.js'),                     fakePrintService);
stubInCache(path.join(SVC,  'routing-service.js'),                   fakeRoutingService);
stubInCache(path.join(SVC,  's3-service.js'),                        {});
stubInCache(path.join(SVC,  'test-print-controller.js'),             { runTest: async () => ({}) });
stubInCache(path.join(SVC,  'print-controller-store.js'),            fakePrintControllerStore);
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
setupIpcHandlers(noopPollingService, {}, { getWindow: () => null });

const saveController = __ipcHandlers.get('ohd:routing:save-controller');

function makeDarkroomPro(overrides = {}) {
  return {
    id:                  'ctrl-dp-1',
    name:                'Darkroom Pro Station 1',
    type:                'darkroompro',
    outputPath:          'C:\\dp\\hot',
    processedFolderName: 'processed',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('ohd:routing:save-controller handler is registered', () => {
  assert.equal(typeof saveController, 'function');
});

// ── Valid values persist ─────────────────────────────────────────────────────

test('autoSendBatches: true persists to the store', async () => {
  resetState();
  const result = await saveController(null, makeDarkroomPro({
    maxPrintsPerJob: 100,
    autoSendBatches: true,
  }));
  assert.equal(result.success, true);
  assert.equal(__controllers[0].autoSendBatches, true);
});

test('autoSendBatches: false persists to the store', async () => {
  resetState();
  const result = await saveController(null, makeDarkroomPro({
    maxPrintsPerJob: 100,
    autoSendBatches: false,
  }));
  assert.equal(result.success, true);
  assert.equal(__controllers[0].autoSendBatches, false);
});

test('autoSendBatches: absent is accepted (existing controllers must save unchanged)', async () => {
  resetState();
  const ctrl = makeDarkroomPro();   // no autoSendBatches
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true, 'omitting the field must not fail — pre-M2 controllers');
  assert.equal('autoSendBatches' in __controllers[0], false);
});

test('autoSendBatches: true also persists WITHOUT a cap set (renderer disables the tick, but IPC accepts either)', async () => {
  // The renderer disables the tick when the cap is blank as a UX hint,
  // but the IPC handler doesn't second-guess: an on-flag without a cap
  // is a no-op at hold-derivation time (the resolver returns null when
  // there's no cap, so autoSendBatches is never even inspected). The
  // save must therefore succeed — refusing it here would create a
  // renderer-vs-IPC skew.
  resetState();
  const result = await saveController(null, makeDarkroomPro({ autoSendBatches: true }));
  assert.equal(result.success, true);
  assert.equal(__controllers[0].autoSendBatches, true);
});

// ── Rejections ───────────────────────────────────────────────────────────────

test('autoSendBatches: non-boolean is rejected with a clear message', async () => {
  for (const bad of ['true', 1, 0, 'yes', {}, [], null]) {
    resetState();
    const result = await saveController(null, makeDarkroomPro({
      maxPrintsPerJob: 100,
      autoSendBatches: bad,
    }));
    assert.equal(result.success, false, `${JSON.stringify(bad)} must be rejected`);
    assert.match(result.error, /autoSendBatches/);
    assert.equal(__controllers.length, 0,
      `controller must not persist when autoSendBatches=${JSON.stringify(bad)} is rejected`);

    const warn = __warns.find(w => /invalid autoSendBatches/.test(w.msg));
    assert.ok(warn, `rejection at ${JSON.stringify(bad)} must log at warn level`);
    assert.equal(warn.meta.autoSendBatches, bad);
  }
});

// ── Scoping ──────────────────────────────────────────────────────────────────

test('autoSendBatches: guard is scoped to darkroompro — non-darkroompro controllers with the field save unchanged', async () => {
  // Meaningless field on other types, but the guard must not fire — an
  // operator-added leftover from an editor typo or hand-edited JSON
  // shouldn't fail an unrelated controller save. Same posture as the
  // orderMergeWaitMinutes scope test in ipc-save-controller-picpro-merge.
  resetState();
  const noritsuCtrl = {
    id:              'ctrl-nor-1',
    name:            'Noritsu QSS-37',
    type:            'noritsu',
    outputPath:      'C:\\nor\\hot',
    autoSendBatches: 'garbage',   // would be rejected on a darkroompro controller
  };
  const result = await saveController(null, noritsuCtrl);
  assert.equal(result.success, true,
    'the darkroompro guard must not fire on a non-darkroompro controller');
  assert.equal(__controllers[0].autoSendBatches, 'garbage',
    'the value is persisted as-is; it has no effect on non-darkroompro dispatch');

  const warn = __warns.find(w => /invalid autoSendBatches/.test(w.msg));
  assert.equal(warn, undefined, 'no darkroompro-guard warn on a non-darkroompro controller');
});

test('autoSendBatches: darkroompro guard does not tangle with the maxPrintsPerJob guard', async () => {
  // Belt-and-braces: two darkroompro-scoped guards must not confuse each
  // other. A valid maxPrintsPerJob with an invalid autoSendBatches should
  // fail the autoSendBatches check specifically.
  resetState();
  const result = await saveController(null, makeDarkroomPro({
    maxPrintsPerJob: 100,
    autoSendBatches: 'true',   // truthy string, must be rejected
  }));
  assert.equal(result.success, false);
  assert.match(result.error, /autoSendBatches/);
  assert.doesNotMatch(result.error, /Maximum prints per job/);
});
