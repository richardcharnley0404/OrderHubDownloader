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

// fuji-pic-pro-file-writer is required by the save-controller handler
// for isSameVolume (advisory volume check, v1.15.1 three-state).
// Stubbed here with a mutable result so the existing merge-validation
// tests don't fail on the fake C:\pp\... paths, and the co-location
// tests can flip it per-case. Default: certain-same (co-located, no
// warning). Sync — mirrors the real isSameVolume shape.
let __volumeResult = { verdict: 'certain-same' };
function __setVolumeResult(r) { __volumeResult = r; }
const fakePicProWriter = {
  isSameVolume:    () => __volumeResult,
  // Other exports are unused by this test file; give the shape so the
  // IPC handler's require doesn't fault on missing methods if anything
  // touches them.
  stageImages:     async () => ({}),
  writeOrderFile:  async () => ({}),
  deliverToDigin:  async () => ({}),
  writeCommandFile: async () => ({}),
  _internals: {},
};

stubInCache(path.join(SVC,  'config-service.js'),                    fakeConfigService);
stubInCache(path.join(SVC,  'fuji-pic-pro-file-writer.js'),          fakePicProWriter);
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

// ═════════════════════════════════════════════════════════════════════════
// PIC Pro volume check — ADVISORY only (v1.15.1)
// ═════════════════════════════════════════════════════════════════════════
//
// v1.15.0 shipped this as a hard reject keyed on isSameVolume's
// boolean-ish return, and a real lab was blocked from saving a valid
// controller — two UNC paths on the same server (`\\labserver1\Pixfizz
// Digin Staging` alongside `\\labserver1\Digin`), very likely the same
// physical volume, but the string compare called them cross-volume and
// refused the save. Their DIGIN path is a share ROOT so there is no
// other folder on that share to stage into — no workaround.
//
// v1.15.1 rule: EVERY verdict SAVES. `certain-same` saves silently;
// every other verdict (certain-different AND indeterminate) saves and
// surfaces a warning naming both paths. The dispatch-time EXDEV throw
// in deliverToDigin is now the ONLY authoritative check. Tests below
// lock the contract: no volume verdict rejects a save.

test('v1.15.1: certain-different does NOT reject; save succeeds with a warning', async () => {
  resetState();
  __setVolumeResult({ verdict: 'certain-different', code: 'different-drives' });
  try {
    const result = await saveController(null, makePicPro({
      imageStagingRoot: 'C:\\pp\\stage',
      diginPath:        'D:\\pp\\digin',
    }));
    assert.equal(result.success, true, 'certain-different MUST NOT block the save (v1.15.1)');
    assert.equal(__controllers.length, 1, 'controller MUST persist');
    assert.ok(Array.isArray(result.warnings) && result.warnings.length >= 1,
      'result MUST carry a warnings array with the co-location advisory');
    const w = result.warnings.find(x => x.kind === 'picpro-volume-uncertain');
    assert.ok(w, 'warning kind must be picpro-volume-uncertain');
    assert.match(w.text, /may be on different volumes/);
    assert.match(w.text, /dispatch will stop with an error/,
      'warning must point operators at the dispatch-time behaviour');
    assert.match(w.text, /C:\\pp\\stage/, 'warning must name Image Staging Root');
    assert.match(w.text, /D:\\pp\\digin/, 'warning must name DIGIN Path');
    // Warn-level log for the Activity Log, with the verdict + code
    // metadata for diagnostics.
    const logged = __warns.find(x => /volume verdict is not certain-same/.test(x.msg));
    assert.ok(logged, 'must log advisory at warn level');
    assert.equal(logged.meta.verdict, 'certain-different');
    assert.equal(logged.meta.code,    'different-drives');
  } finally {
    __setVolumeResult({ verdict: 'certain-same' });
  }
});

test('v1.15.1: indeterminate (same-server-different-share) does NOT reject; save succeeds with a warning', async () => {
  // The exact 1.15.0 hard-block regression: a real lab configured
  // \\labserver1\Pixfizz Digin Staging and \\labserver1\Digin — two
  // shares on the same server. The 1.15.0 string check called that
  // cross-volume and refused the save. Under v1.15.1 the verdict is
  // indeterminate (could be same physical volume, could not — you
  // can't tell from names) and the save proceeds with a warning.
  resetState();
  __setVolumeResult({ verdict: 'indeterminate', code: 'same-server-different-share' });
  try {
    const result = await saveController(null, makePicPro({
      imageStagingRoot: '\\\\labserver1\\Pixfizz Digin Staging',
      diginPath:        '\\\\labserver1\\Digin',
    }));
    assert.equal(result.success, true, 'indeterminate (same-server-different-share) MUST NOT block the save');
    assert.equal(__controllers.length, 1, 'the exact 1.15.0 hard-block config MUST now persist');
    assert.ok(result.warnings && result.warnings.length >= 1);
    const logged = __warns.find(x => /volume verdict is not certain-same/.test(x.msg));
    assert.equal(logged.meta.verdict, 'indeterminate');
    assert.equal(logged.meta.code,    'same-server-different-share');
  } finally {
    __setVolumeResult({ verdict: 'certain-same' });
  }
});

test('v1.15.1: certain-same saves silently — no warning', async () => {
  resetState();
  // Default fake result is already certain-same; be explicit.
  __setVolumeResult({ verdict: 'certain-same' });
  const result = await saveController(null, makePicPro({
    imageStagingRoot: 'C:\\pp\\stage',
    diginPath:        'C:\\pp\\digin',
  }));
  assert.equal(result.success, true);
  assert.equal(__controllers.length, 1);
  assert.ok(Array.isArray(result.warnings), 'warnings MUST always be an array (even when empty) — renderer branches on length');
  const volumeWarning = (result.warnings || []).find(x => x.kind === 'picpro-volume-uncertain');
  assert.equal(volumeWarning, undefined, 'certain-same MUST NOT produce a volume warning');
  const logged = __warns.find(x => /volume verdict/.test(x.msg));
  assert.equal(logged, undefined, 'certain-same MUST NOT log the advisory');
});

test('v1.15.1: no volume verdict can ever cause a save rejection (contract lock)', async () => {
  // Property test — every verdict the helper can emit must produce a
  // successful save from the handler. Locks the "advisory only"
  // contract so a future maintainer who re-adds boolean rejection has
  // to break this too.
  const verdicts = [
    { verdict: 'certain-same' },
    { verdict: 'certain-different', code: 'different-drives' },
    { verdict: 'certain-different', code: 'different-servers' },
    { verdict: 'indeterminate',     code: 'same-server-different-share' },
    { verdict: 'indeterminate',     code: 'local-vs-unc' },
    { verdict: 'indeterminate',     code: 'unparseable-a' },
    { verdict: 'indeterminate',     code: 'unparseable-b' },
  ];
  for (const v of verdicts) {
    resetState();
    __setVolumeResult(v);
    try {
      const result = await saveController(null, makePicPro());
      assert.equal(result.success, true,
        `verdict ${JSON.stringify(v)} MUST NOT reject the save — advisory-only contract`);
    } finally {
      __setVolumeResult({ verdict: 'certain-same' });
    }
  }
});

test('v1.15.1: containment checks (staging inside DIGIN etc.) STILL reject — only the volume verdict is advisory', async () => {
  // The sync validator (validateControllerConfig) rejects overlapping
  // paths — that's string-certain and knowable, so it stays a hard
  // reject. Locks that the v1.15.1 change scoped only to the volume
  // verdict and did not soften the containment guardrail.
  resetState();
  __setVolumeResult({ verdict: 'certain-same' }); // volume ok — isolate the containment path
  const overlap = makePicPro({
    imageStagingRoot: 'C:\\pp\\digin\\stage',  // nested inside diginPath
    diginPath:        'C:\\pp\\digin',
  });
  const result = await saveController(null, overlap);
  assert.equal(result.success, false, 'containment overlap MUST still reject the save');
  assert.equal(__controllers.length, 0);
});

test('v1.15.1: sync validator still runs BEFORE the volume check — a missing diginPath rejects with its own error, not with the volume advisory', async () => {
  resetState();
  // Volume check would produce a warning if it ran — the sync validator
  // must reject FIRST, before the volume check gets a chance.
  __setVolumeResult({ verdict: 'certain-different', code: 'different-servers' });
  try {
    const bad = makePicPro();
    delete bad.diginPath;
    const result = await saveController(null, bad);
    assert.equal(result.success, false);
    assert.match(result.error, /diginPath is required/,
      'sync validator must catch the missing field BEFORE the volume check runs');
    assert.doesNotMatch(result.error, /may be on different volumes/,
      'the volume advisory must not appear in the sync-validator rejection');
  } finally {
    __setVolumeResult({ verdict: 'certain-same' });
  }
});
