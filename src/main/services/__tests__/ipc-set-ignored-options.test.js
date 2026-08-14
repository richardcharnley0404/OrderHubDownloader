'use strict';

/**
 * IPC-level tests for the `ohd:routing:set-ignored-options` handler
 * introduced in M3 of docs/darkroom-media-lock-brief.md.
 *
 * The handler is a narrow write that patches only `ignoredOptionNames`
 * on the stored controller. Its whole point is to bypass the
 * whole-controller guards in ohd:routing:save-controller — the media-
 * lock guard was firing on per-job Ignore-tick edits and eating the
 * operator's Save & Assign. The load-bearing invariant is that a
 * controller in the media-lock state (translations + blank Paper Type
 * Option Key) still accepts an ignore-only write here.
 *
 * Payload validation is scoped to shape only: controllerId string,
 * ignoredOptionNames array of non-empty strings, dedup case-
 * insensitively, controller must exist.
 *
 * Stub scaffold mirrors ipc-darkroom-translations-guard.test.js —
 * full ipc-handlers.js load with a small stateful routing-service
 * stub so persistence is directly assertable.
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

function resetState() {
  __controllers = [];
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
setupIpcHandlers(noopPollingService, {}, { getWindow: () => null });

const setIgnoredOptions = __ipcHandlers.get('ohd:routing:set-ignored-options');

function makeCtrl(overrides = {}) {
  return {
    id:                  'ctrl-dp-1',
    name:                'Darkroom Pro — Lab',
    type:                'darkroompro',
    outputPath:          'C:\\hot\\dp',
    mediaOptionKey:      'paper-type',
    sizeTranslations:    [{ productCodePrefix: 'PHOTO4X6', darkroomSize: '4x6' }],
    mediaTranslations:   [{ from: 'lustre', to: 'Luster' }],
    ignoredOptionNames:  ['legacy'],
    checkOrderStatus:    true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('ohd:routing:set-ignored-options handler is registered', () => {
  assert.equal(typeof setIgnoredOptions, 'function');
});

// ── Ignore list persists ────────────────────────────────────────────────────

test('valid payload persists ignoredOptionNames on the stored controller', async () => {
  resetState();
  __controllers = [makeCtrl({ ignoredOptionNames: ['old'] })];

  const result = await setIgnoredOptions(null, {
    controllerId: 'ctrl-dp-1',
    ignoredOptionNames: ['finish-options', 'layout'],
  });

  assert.equal(result.success, true);
  assert.deepEqual(__controllers[0].ignoredOptionNames, ['finish-options', 'layout']);
});

test('empty ignoredOptionNames array is valid (clearing all ignore flags)', async () => {
  resetState();
  __controllers = [makeCtrl({ ignoredOptionNames: ['finish-options', 'layout'] })];

  const result = await setIgnoredOptions(null, {
    controllerId: 'ctrl-dp-1',
    ignoredOptionNames: [],
  });

  assert.equal(result.success, true);
  assert.deepEqual(__controllers[0].ignoredOptionNames, []);
});

test('case-insensitive dedup preserves the first-seen display form', async () => {
  resetState();
  __controllers = [makeCtrl()];

  const result = await setIgnoredOptions(null, {
    controllerId: 'ctrl-dp-1',
    ignoredOptionNames: ['finish-options', 'Finish-Options', 'FINISH-OPTIONS', 'layout'],
  });

  assert.equal(result.success, true);
  assert.deepEqual(__controllers[0].ignoredOptionNames, ['finish-options', 'layout'],
    'first-seen display form wins; case-variants collapse into it');
});

// ── Full key-set comparison: other controller fields untouched ──────────────

test('other controller fields are untouched — full key-set comparison, not spot-check', async () => {
  // Locks the "narrow write" guarantee: this handler must not
  // side-effect any field beyond `ignoredOptionNames`. Any drift here
  // (a new required field forgotten in the spread; a validator that
  // silently normalises a different field) fails the assert.
  resetState();
  const original = makeCtrl({
    ignoredOptionNames: ['old'],
    orderLastNameFormat: 'orderRef_lastName',
    artworkRootPath:     'C:\\artwork',
    bannerSheet:         false,
    maxPrintsPerJob:     null,
    photoLines:          [{ line: 1, format: 'X' }],
  });
  __controllers = [{ ...original }];

  await setIgnoredOptions(null, {
    controllerId: 'ctrl-dp-1',
    ignoredOptionNames: ['new'],
  });

  const stored = __controllers[0];
  const beforeKeys = new Set(Object.keys(original));
  const afterKeys  = new Set(Object.keys(stored));
  assert.deepEqual([...afterKeys].sort(), [...beforeKeys].sort(),
    'key set must be identical — no fields added or removed');
  for (const k of beforeKeys) {
    if (k === 'ignoredOptionNames') continue;
    assert.deepEqual(stored[k], original[k],
      `field \`${k}\` must be byte-identical after an ignore-only write`);
  }
  assert.deepEqual(stored.ignoredOptionNames, ['new']);
});

// ── Load-bearing: controller in the media-lock state still accepts ─────────

test('locked media-state controller (translations + blank Paper Type Option Key) STILL accepts an ignore-only write', async () => {
  // This is the entire point of the milestone. Pre-M3 a per-job
  // Ignore-tick edit routed through saveOrderController and hit the
  // media-lock guard, so any Save & Assign click on this controller
  // failed. Post-M3 the narrow IPC bypasses the guard — the operator
  // can toggle ignores and complete their per-job action while the
  // controller-level misconfiguration is fixed separately.
  resetState();
  __controllers = [makeCtrl({
    mediaOptionKey:    '',      // blank — locked state
    mediaTranslations: [{ from: 'lustre', to: 'Luster' }],  // triggers the guard when routed through save-controller
  })];

  const result = await setIgnoredOptions(null, {
    controllerId: 'ctrl-dp-1',
    ignoredOptionNames: ['finish-options'],
  });

  assert.equal(result.success, true,
    'narrow IPC must accept even when the controller is in the media-lock state');
  assert.deepEqual(__controllers[0].ignoredOptionNames, ['finish-options']);
  // The bad state is preserved as-is — this handler is not the place
  // to fix it (M4's "Clear media translations" button is).
  assert.equal(__controllers[0].mediaOptionKey, '');
  assert.equal(__controllers[0].mediaTranslations.length, 1);
});

// ── Malformed payload rejected ──────────────────────────────────────────────

test('unknown controllerId → success:false with descriptive error, no writes', async () => {
  resetState();
  __controllers = [makeCtrl({ id: 'ctrl-a' })];

  const result = await setIgnoredOptions(null, {
    controllerId: 'ctrl-nope',
    ignoredOptionNames: ['x'],
  });

  assert.equal(result.success, false);
  assert.match(result.error, /not found/i);
  assert.equal(__controllers[0].ignoredOptionNames.length, 1, 'existing controller untouched');
  assert.deepEqual(__controllers[0].ignoredOptionNames, ['legacy']);
});

test('missing controllerId → success:false', async () => {
  resetState();
  const result = await setIgnoredOptions(null, { ignoredOptionNames: ['x'] });
  assert.equal(result.success, false);
  assert.match(result.error, /controllerId/i);
});

test('non-array ignoredOptionNames → success:false', async () => {
  resetState();
  __controllers = [makeCtrl()];
  for (const bad of [null, undefined, 'nope', 42, {}, { 0: 'x' }]) {
    const result = await setIgnoredOptions(null, {
      controllerId: 'ctrl-dp-1',
      ignoredOptionNames: bad,
    });
    assert.equal(result.success, false, `${JSON.stringify(bad)} must be rejected`);
    assert.match(result.error, /array/);
  }
});

test('array entries must be non-empty strings — one bad entry rejects the whole payload', async () => {
  resetState();
  __controllers = [makeCtrl({ ignoredOptionNames: ['existing'] })];

  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    const result = await setIgnoredOptions(null, {
      controllerId: 'ctrl-dp-1',
      ignoredOptionNames: ['finish-options', bad, 'layout'],
    });
    assert.equal(result.success, false, `entry ${JSON.stringify(bad)} must reject`);
    assert.match(result.error, /non-empty strings/);
    assert.deepEqual(__controllers[0].ignoredOptionNames, ['existing'],
      'reject-not-filter — the well-formed entries must not persist alongside a bad one');
  }
});

test('null payload → success:false (defensive)', async () => {
  const result = await setIgnoredOptions(null, null);
  assert.equal(result.success, false);
});

// ── Media guard NOT run (regression guard) ──────────────────────────────────

test('media-lock guard from ohd:routing:save-controller is NOT run here (regression guard)', async () => {
  // The whole reason this handler exists. If a future refactor
  // shares the save-controller guard code with this path (or routes
  // this handler through it), the test breaks because a locked
  // controller would reject the ignore-only write with the
  // "Paper Type Option Key is required..." message.
  resetState();
  __controllers = [makeCtrl({
    mediaOptionKey:    '',
    mediaTranslations: [{ from: 'a', to: 'b' }],
  })];

  const result = await setIgnoredOptions(null, {
    controllerId: 'ctrl-dp-1',
    ignoredOptionNames: ['x'],
  });

  assert.equal(result.success, true);
  assert.equal(/Paper Type Option Key/.test(result.error || ''), false,
    'the media-lock error text must not appear on the ignore-only write path');
});
