'use strict';

/**
 * IPC-level tests for the `controllers:updateDarkroomTranslations` guard
 * introduced in M1 of docs/darkroom-media-lock-brief.md.
 *
 * Background: a lab without a paper-type option ends up with
 * `mediaTranslations` rows AND a blank `mediaOptionKey`, a state the
 * controller-save guard refuses. The state is only reachable because
 * this IPC handler pushes onto mediaTranslations and calls
 * routingService.saveController directly, bypassing the two guards
 * that would have caught it (renderer.js:5670-5680, ipc-handlers.js:1057-1073).
 *
 * The M1 fix closes that back door:
 *   - Refuse mediaTranslation when the controller's mediaOptionKey is
 *     blank/whitespace.
 *   - Apply a sizeTranslation in the same call regardless — size and
 *     media are independent; silently dropping size would be the same
 *     class of bug this milestone exists to close.
 *   - Return {success:false, error} so the renderer surfaces the media
 *     problem; the error text names the concrete remedy and states
 *     whether the size translation was saved.
 *
 * Stub scaffold mirrors ipc-handlers-retry-job.test.js. The routing
 * service is upgraded from a no-op stub to a small stateful mock so
 * saveController writes to an inspectable store — that's what makes
 * "controller's mediaTranslations unchanged on disk" assertable.
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
// sees writes back. This is the minimum needed to assert "mediaTranslations
// unchanged on disk" after a rejected media save.
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
  // Only logWarning is inspected — the guard-rejection path fires warn
  // (not error). Any other level stays a no-op.
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

const updateDarkroomTranslations = __ipcHandlers.get('controllers:updateDarkroomTranslations');

function makeCtrl(overrides = {}) {
  return {
    id:                  'ctrl-dp-1',
    name:                'Darkroom Pro — Lab',
    type:                'darkroompro',
    outputPath:          'C:\\hot\\dp',
    // Deliberately blank in the default fixture — the reproduction
    // condition for the M1 lock. Tests that need a key set override.
    mediaOptionKey:      '',
    sizeTranslations:    [],
    mediaTranslations:   [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('controllers:updateDarkroomTranslations handler is registered', () => {
  assert.equal(typeof updateDarkroomTranslations, 'function', 'M1 handler was registered by setupIpcHandlers');
});

// M1 brief case 1
test('blank mediaOptionKey + mediaTranslation → success:false, controller.mediaTranslations unchanged on disk', async () => {
  resetState();
  __controllers = [makeCtrl({ mediaOptionKey: '', mediaTranslations: [] })];

  const result = await updateDarkroomTranslations(null, {
    controllerId: 'ctrl-dp-1',
    mediaTranslation: { from: 'full bleed', to: 'Luster' },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Media translation not saved/);
  assert.match(result.error, /Paper Type Option Key/);
  assert.match(result.error, /Settings → Routing/);
  assert.equal(__controllers[0].mediaTranslations.length, 0,
    'mediaTranslations must be unchanged when the media save is rejected');

  const warn = __warns.find(w => /media translation rejected/i.test(w.msg));
  assert.ok(warn, 'guard rejection must log at warn level');
  assert.equal(warn.meta.controllerId,   'ctrl-dp-1');
  assert.equal(warn.meta.controllerName, 'Darkroom Pro — Lab');
  assert.equal(warn.meta.from,           'full bleed');
  assert.equal(warn.meta.to,             'Luster');
});

// M1 brief case 2
test('blank mediaOptionKey + sizeTranslation + mediaTranslation → size persisted, media rejected', async () => {
  resetState();
  __controllers = [makeCtrl({ mediaOptionKey: '', sizeTranslations: [], mediaTranslations: [] })];

  const result = await updateDarkroomTranslations(null, {
    controllerId: 'ctrl-dp-1',
    sizeTranslation:  { productCodePrefix: 'PHOTO4X6', darkroomSize: '4x6' },
    mediaTranslation: { from: 'full bleed',            to: 'Luster'         },
  });

  assert.equal(result.success, false, 'response must surface the media rejection to the caller');
  assert.match(result.error, /size translation was saved/i,
    'error text must state that the size translation was saved so the operator is not left wondering');
  assert.deepEqual(__controllers[0].sizeTranslations, [
    { productCodePrefix: 'PHOTO4X6', darkroomSize: '4x6' },
  ], 'sizeTranslations must persist even when media is rejected');
  assert.equal(__controllers[0].mediaTranslations.length, 0,
    'mediaTranslations must not persist when the key is blank');
});

// M1 brief case 3
test('populated mediaOptionKey + mediaTranslation → media persists (no regression on the healthy path)', async () => {
  resetState();
  __controllers = [makeCtrl({ mediaOptionKey: 'paper-type', mediaTranslations: [] })];

  const result = await updateDarkroomTranslations(null, {
    controllerId: 'ctrl-dp-1',
    mediaTranslation: { from: 'lustre', to: 'Luster' },
  });

  assert.equal(result.success, true);
  assert.deepEqual(__controllers[0].mediaTranslations, [
    { from: 'lustre', to: 'Luster' },
  ]);
  assert.equal(__warns.filter(w => /rejected/i.test(w.msg)).length, 0,
    'no rejection warn on the healthy path');
});

// M1 brief case 4
test('whitespace-only mediaOptionKey is treated as blank', async () => {
  resetState();
  __controllers = [makeCtrl({ mediaOptionKey: '   ', mediaTranslations: [] })];

  const result = await updateDarkroomTranslations(null, {
    controllerId: 'ctrl-dp-1',
    mediaTranslation: { from: 'lustre', to: 'Luster' },
  });

  assert.equal(result.success, false);
  assert.equal(__controllers[0].mediaTranslations.length, 0);
});

// Baseline: a size-only call on a blank-key controller is fine — the guard
// is scoped to media. Locks the "size and media are independent" contract.
test('blank mediaOptionKey + sizeTranslation only → success, size persisted (no media touch at all)', async () => {
  resetState();
  __controllers = [makeCtrl({ mediaOptionKey: '', sizeTranslations: [], mediaTranslations: [] })];

  const result = await updateDarkroomTranslations(null, {
    controllerId: 'ctrl-dp-1',
    sizeTranslation: { productCodePrefix: 'PHOTO4X6', darkroomSize: '4x6' },
  });

  assert.equal(result.success, true, 'size-only calls are unaffected by the M1 guard');
  assert.deepEqual(__controllers[0].sizeTranslations, [
    { productCodePrefix: 'PHOTO4X6', darkroomSize: '4x6' },
  ]);
  assert.equal(__controllers[0].mediaTranslations.length, 0);
});

// Idempotency preserved on the healthy path — a mediaTranslation whose `from`
// already exists doesn't duplicate. Pre-existing behaviour; locked so the
// M1 refactor didn't drift it.
test('populated mediaOptionKey + duplicate mediaTranslation → not re-added, still success', async () => {
  resetState();
  __controllers = [makeCtrl({
    mediaOptionKey:    'paper-type',
    mediaTranslations: [{ from: 'lustre', to: 'Luster' }],
  })];

  const result = await updateDarkroomTranslations(null, {
    controllerId: 'ctrl-dp-1',
    mediaTranslation: { from: 'LUSTRE', to: 'Luster' },
  });

  assert.equal(result.success, true);
  assert.equal(__controllers[0].mediaTranslations.length, 1,
    'case-insensitive dup detection preserved from pre-M1 behaviour');
});

// Missing controller path preserved — the guard's added blank-key check
// must not shadow the "controller not found" branch.
test('unknown controllerId → success:false with descriptive error, no writes', async () => {
  resetState();
  __controllers = [makeCtrl({ mediaOptionKey: '' })];

  const result = await updateDarkroomTranslations(null, {
    controllerId: 'ctrl-does-not-exist',
    mediaTranslation: { from: 'lustre', to: 'Luster' },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Controller not found/);
});
