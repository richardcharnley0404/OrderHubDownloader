'use strict';

/**
 * IPC-level tests for the Fuji PIC Pro order-level submission
 * validation added to `ohd:routing:save-controller` in M1 of
 * docs/order-level-submission-picpro-brief.md.
 *
 * The handler now rejects an out-of-range or non-integer
 * `orderMergeWaitMinutes` on a fujipicpro controller — the renderer
 * already validates on save, but the IPC mirror is the belt-and-braces
 * check against a future renderer bug or an external caller that would
 * otherwise persist a value that stretches every order-merge wait to
 * hours. Null is a valid value meaning "use the 30-minute default" and
 * must NOT be rejected.
 *
 * Same shape as ipc-darkroom-translations-guard.test.js — full
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
// sees writes back. That's what makes "controller was / was not saved"
// directly assertable — the same pattern
// ipc-darkroom-translations-guard.test.js uses.
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

stubInCache(path.join(SVC,  'config-service.js'),                    fakeConfigService);
stubInCache(path.join(SVC,  'logger.js'),                            captureLogger);
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
setupIpcHandlers(noopPollingService, {}, { getWindow: () => null });

const saveController = __ipcHandlers.get('ohd:routing:save-controller');

function makePicPro(overrides = {}) {
  return {
    id:                'ctrl-pp-1',
    name:              'Fuji PIC Pro — Lab',
    type:              'fujipicpro',
    orderDataPath:     'C:\\pp\\order',
    diginPath:         'C:\\pp\\digin',
    mergeDataPath:     'C:\\pp\\merge',
    imageStagingRoot:  'C:\\pp\\stage',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('ohd:routing:save-controller handler is registered', () => {
  assert.equal(typeof saveController, 'function');
});

// ── Valid values pass through ────────────────────────────────────────────────

test('valid orderMergeWaitMinutes persists to the store (accepts 1, 30, 60, 1440)', async () => {
  for (const good of [1, 30, 60, 1440]) {
    resetState();
    const result = await saveController(null, makePicPro({ mergeOrderJobs: true, orderMergeWaitMinutes: good }));
    assert.equal(result.success, true, `${good} must be accepted`);
    assert.equal(__controllers[0].orderMergeWaitMinutes, good);
    assert.equal(__controllers[0].mergeOrderJobs, true);
  }
});

test('null orderMergeWaitMinutes is accepted (means "use the default")', async () => {
  resetState();
  const result = await saveController(null, makePicPro({ mergeOrderJobs: true, orderMergeWaitMinutes: null }));
  assert.equal(result.success, true, 'null must NOT be rejected — it means "use the 30-minute default"');
  assert.equal(__controllers[0].orderMergeWaitMinutes, null);
});

test('absent orderMergeWaitMinutes is accepted (same as null — default at read time)', async () => {
  resetState();
  const ctrl = makePicPro({ mergeOrderJobs: true });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  assert.equal('orderMergeWaitMinutes' in __controllers[0], false);
});

// ── Rejections ───────────────────────────────────────────────────────────────

test('out-of-range orderMergeWaitMinutes is rejected (0, -5, 1441, 5000)', async () => {
  for (const bad of [0, -5, 1441, 5000]) {
    resetState();
    const result = await saveController(null, makePicPro({ orderMergeWaitMinutes: bad }));
    assert.equal(result.success, false, `${bad} must be rejected`);
    assert.match(result.error, /between 1 and 1440/);
    assert.equal(__controllers.length, 0, `controller must not persist when ${bad} is rejected`);

    const warn = __warns.find(w => /invalid orderMergeWaitMinutes/.test(w.msg));
    assert.ok(warn, `rejection at ${bad} must log at warn level`);
    assert.equal(warn.meta.orderMergeWaitMinutes, bad);
  }
});

test('non-integer orderMergeWaitMinutes is rejected (3.14, NaN, "10", "thirty")', async () => {
  for (const bad of [3.14, NaN, '10', 'thirty']) {
    resetState();
    const result = await saveController(null, makePicPro({ orderMergeWaitMinutes: bad }));
    assert.equal(result.success, false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(__controllers.length, 0);
  }
});

// ── Scope: non-picpro controllers unaffected ─────────────────────────────────

test('non-picpro controller with a bad orderMergeWaitMinutes is NOT rejected by this guard (scope check)', async () => {
  // The guard is fujipicpro-scoped. If any other controller type ever
  // carried an orderMergeWaitMinutes value (leftover from an editor
  // typo or manual JSON edit), this guard must not reject it — the
  // field is meaningless there and the operator's other-controller
  // save shouldn't fail on it. Use `noritsu` because darkroompro
  // and fujijobmaker have their own save-path validators / dual-writes
  // that would complicate the assertion; the scope point stands for
  // any non-picpro type.
  resetState();
  const noritsuCtrl = {
    id:                    'ctrl-nor-1',
    name:                  'Noritsu QSS-37',
    type:                  'noritsu',
    outputPath:            'C:\\nor\\hot',
    orderMergeWaitMinutes: 9999,   // out of the picpro range
  };
  const result = await saveController(null, noritsuCtrl);
  assert.equal(result.success, true,
    'the picpro guard must not fire on a non-picpro controller');
  assert.equal(__controllers[0].orderMergeWaitMinutes, 9999,
    'the value is persisted as-is; it has no effect on non-picpro dispatch');

  const warn = __warns.find(w => /invalid orderMergeWaitMinutes/.test(w.msg));
  assert.equal(warn, undefined, 'no picpro-guard warn on a non-picpro controller');
});

test('fujipicpro controller with a valid maxPrintsPerJob-shaped value is NOT rejected (the picpro guard only checks its own field)', async () => {
  // Belt-and-braces: the two darkroompro / fujipicpro guards must be
  // strictly scoped by controller type and not tangle. A picpro save
  // with the darkroompro guard's field absent shouldn't accidentally
  // trip through the wrong branch.
  resetState();
  const result = await saveController(null, makePicPro({
    mergeOrderJobs: true,
    orderMergeWaitMinutes: 60,
  }));
  assert.equal(result.success, true);
  const warn = __warns.find(w => /invalid maxPrintsPerJob/.test(w.msg));
  assert.equal(warn, undefined, 'the darkroompro maxPrintsPerJob guard must not fire on a picpro save');
});
