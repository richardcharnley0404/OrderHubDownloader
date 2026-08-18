/**
 * IPC-level tests for the `ohd:routing:save-controller` folder_copy
 * validation added in M3 of docs/folder-copy-filename-templates-brief.md.
 *
 * These are the defence-in-depth checks that mirror the renderer-side
 * guards in ocSaveBtn. The three rules from §5.3:
 *
 *   1. destinationLayout must be exactly 'job' or 'root'.
 *   2. destinationLayout === 'root' requires a non-blank filenameTemplate.
 *   3. destinationLayout === 'root' requires the template to contain at
 *      least one job-distinguishing token: {orderNumber}, {jobName},
 *      {jobId}, {filename} or {originalFilename}.
 *
 * Plus type guards so a malformed payload (non-string filenameTemplate
 * or stripOrderNumberPrefix) is rejected rather than persisted.
 *
 * Round-trip test: save all three fields via the REAL IPC handler, then
 * read them back through the same fake routing service and assert every
 * one persisted. That is the test the 1.12.0 PIC Pro merge bug didn't
 * have — a field assigned to the wrong type block that silently never
 * persisted — and it's why §5.4 calls it out explicitly.
 *
 * Stub scaffold mirrors ipc-darkroom-translations-guard.test.js.
 *
 * Run via: npm test
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

const __ipcHandlers = new Map();
let   __controllers = [];   // stateful — fake routing service mutates this
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

const fakeJobDownloadService = {
  checkLocalFiles: () => ({ found: false, hasFiles: false, hasManifest: false }),
};

const captureLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  logInfo: () => {}, logError: () => {}, logDebug: () => {},
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

function makeFolderCopyCtrl(overrides = {}) {
  return {
    id:         'ctrl-fc-1',
    name:       'Wide Format — Roll 1',
    type:       'folder_copy',
    outputPath: 'C:\\wf\\out',
    ...overrides,
  };
}

// ── Sanity ──────────────────────────────────────────────────────────────────

test('ohd:routing:save-controller handler is registered', () => {
  assert.equal(typeof saveController, 'function');
});

// ═════════════════════════════════════════════════════════════════════════
// IPC REJECTS — the three §5.3 rules, each with the exact error text
// ═════════════════════════════════════════════════════════════════════════

test('IPC rejects: destinationLayout other than "job" or "root"', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({ destinationLayout: 'nope' });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /Destination layout must be "job" or "root"/);
  // Not persisted.
  assert.equal(__controllers.length, 0, 'invalid controller must not persist');
  const warn = __warns.find(w => /invalid destinationLayout/i.test(w.msg));
  assert.ok(warn, 'rejection must log at warn level with the controller context');
});

test('IPC rejects: root layout with blank template — error names the fix', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({ destinationLayout: 'root', filenameTemplate: '' });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  // Error names the fix, per §5.3 spec (M3a-narrowed set).
  assert.match(result.error, /filename template is required/);
  assert.match(result.error, /root of the copy-to folder/);
  assert.match(result.error, /\{orderNumber\}/);
  assert.match(result.error, /\{jobName\}/);
  assert.match(result.error, /\{jobId\}/);
  // The narrower set explicitly does NOT include per-image tokens.
  assert.doesNotMatch(result.error, /\{filename\}/);
  assert.doesNotMatch(result.error, /\{originalFilename\}/);
  assert.equal(__controllers.length, 0);
});

test('IPC rejects: root layout with template lacking any distinguishing token', async () => {
  resetState();
  // {product} + {index} — both resolve identically across dispatches that
  // share the same product; would overwrite across jobs in a root layout.
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'root',
    filenameTemplate:  '{product}_{index}',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /must include at least one of/);
  assert.match(result.error, /overwrite each other/);
  assert.equal(__controllers.length, 0);
});

test('IPC rejects: root layout + {filename} — per-image token does NOT count as job-distinguishing', async () => {
  // M3a correction. {filename} resolves to a manifest basename like
  // "5_IMG.jpg" — an index-prefixed customer filename. Camera filenames
  // (IMG_0001.jpg) repeat across orders constantly, so two orders each
  // carrying that name at the same slot resolve identically and would
  // overwrite in root layout. The initial M3 accepted {filename} here
  // and this test was originally a positive case — the reject flip is
  // the fix.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'root',
    filenameTemplate:  '{filename}_{index}',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false, '{filename} does not distinguish jobs — cameras produce the same names');
  assert.match(result.error, /\{orderNumber\}/);
  assert.equal(__controllers.length, 0);
});

test('IPC rejects: root layout + {originalFilename} — same repeat problem, strictly weaker than {filename}', async () => {
  // {originalFilename} is {filename} with the leading "N_" index prefix
  // stripped, so it is strictly WEAKER at distinguishing across jobs.
  // Also a reject after M3a.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'root',
    filenameTemplate:  '{originalFilename}',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.equal(__controllers.length, 0);
});

test('IPC rejects: filenameTemplate that is not a string', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({ filenameTemplate: 12345 });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /filenameTemplate must be a string/);
});

test('M7b IPC rejects: orderNumberPrefixRules that is not an array', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({ orderNumberPrefixRules: 'PXDEMO-' });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /orderNumberPrefixRules must be an array of \{from, to\} pairs/);
});

test('M7b IPC rejects: orderNumberPrefixRules entry without a string `from`', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    orderNumberPrefixRules: [{ from: 'PXDEMO-', to: '' }, { to: 'PX-' }],
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /orderNumberPrefixRules entries must be objects/);
});

test('M7b IPC rejects: orderNumberPrefixRules entry with non-string `to`', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    orderNumberPrefixRules: [{ from: 'PXDEMO-', to: 42 }],
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /orderNumberPrefixRules entries must be objects/);
});

test('M7 IPC rejects: legacy stripOrderNumberPrefixes that is not an array', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({ stripOrderNumberPrefixes: 'PXDEMO-' });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /legacy field.*must be an array of strings/);
});

test('M7 IPC rejects: legacy stripOrderNumberPrefixes with a non-string entry', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({ stripOrderNumberPrefixes: ['PXDEMO-', 42] });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /array of strings/);
});

test('legacy 1.13.0 IPC rejects: stripOrderNumberPrefix (string field) with wrong type', async () => {
  // Legacy field still valid when present-and-string; wrong type rejected.
  resetState();
  const ctrl = makeFolderCopyCtrl({ stripOrderNumberPrefix: true });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, false);
  assert.match(result.error, /legacy field.*must be a string/);
});

// ═════════════════════════════════════════════════════════════════════════
// IPC ACCEPTS — the existing-installation case and the two valid shapes
// ═════════════════════════════════════════════════════════════════════════

test('IPC accepts: "job" layout + blank template (the existing-installation case)', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl();  // no M3 fields at all
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true, 'a pre-M3 folder_copy controller must still save');
  assert.equal(__controllers.length, 1);
});

test('IPC accepts: "job" layout + non-blank template', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'job',
    filenameTemplate:  '{product}_{index}',  // no distinguishing token — but not required for "job"
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true,
    'per §5.3, a distinguishing-token check applies to "root" only — "job" gets a per-job subfolder that already disambiguates');
});

test('IPC accepts: "root" layout with a template carrying a distinguishing token', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'root',
    filenameTemplate:  '{orderNumber}_{product}_{indexPadded}',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
});

test('IPC accepts: "root" layout + template with EACH allowed distinguishing token in turn', async () => {
  // M3a — the accepted set is narrowed to job-level identifiers only.
  // See the {filename}/{originalFilename} reject tests above for why
  // per-image tokens are excluded, and the regex comment in
  // ipc-handlers.js for the token-by-token audit.
  for (const token of ['{orderNumber}', '{jobName}', '{jobId}']) {
    resetState();
    const ctrl = makeFolderCopyCtrl({
      destinationLayout: 'root',
      filenameTemplate:  `prefix_${token}_suffix`,
    });
    const result = await saveController(null, ctrl);
    assert.equal(result.success, true, `${token} must be accepted as a distinguishing token`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Round-trip — the test 1.12.0 PIC Pro merge bug didn't have
// ═════════════════════════════════════════════════════════════════════════

test('round-trip: save all three fields via IPC → read back via getControllers, all three persist', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    filenameTemplate:       '{orderNumber}_{product}_{indexPadded}',
    destinationLayout:      'root',
    orderNumberPrefixRules: [{ from: 'PXDEMO-', to: 'PX-' }],
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);

  // Read back via the same store the fake routing service exposes. If any
  // field was accidentally scoped to the wrong type block in a future
  // refactor (the 1.12.0 shape), it would be silently missing here.
  const persisted = __controllers.find(c => c.id === 'ctrl-fc-1');
  assert.ok(persisted, 'controller must persist');
  assert.equal(persisted.filenameTemplate,   '{orderNumber}_{product}_{indexPadded}');
  assert.equal(persisted.destinationLayout,  'root');
  assert.deepEqual(persisted.orderNumberPrefixRules, [{ from: 'PXDEMO-', to: 'PX-' }]);
});

test('M7b IPC round-trip: multi-rule pair array persists as an array of pairs', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    filenameTemplate:       '{orderNumber}_{index}',
    destinationLayout:      'root',
    orderNumberPrefixRules: [
      { from: 'ORD',    to: '' },
      { from: 'PXDEMO', to: 'PX' },
      { from: 'POS',    to: '' },
    ],
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  const persisted = __controllers.find(c => c.id === 'ctrl-fc-1');
  assert.deepEqual(persisted.orderNumberPrefixRules, [
    { from: 'ORD',    to: '' },
    { from: 'PXDEMO', to: 'PX' },
    { from: 'POS',    to: '' },
  ]);
});

test('M7b IPC normalises: from/to trimmed, empty-from dropped, case-insens dedupe on from', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    filenameTemplate:       '{orderNumber}_{index}',
    destinationLayout:      'root',
    orderNumberPrefixRules: [
      { from: '  PXDEMO-  ', to: '  PX-  ' },  // both trimmed
      { from: '',            to: 'X' },        // empty from → dropped
      { from: 'ORD',         to: '' },
      { from: 'pxdemo-',     to: 'IGNORED' },  // duplicate on from (case-insens) → dropped
      { from: 'ORD',         to: 'STALE' },    // duplicate on from → dropped
    ],
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  const persisted = __controllers.find(c => c.id === 'ctrl-fc-1');
  // First 'PXDEMO-' wins with to:'PX-'. ORD appears once with to:''.
  assert.deepEqual(persisted.orderNumberPrefixRules, [
    { from: 'PXDEMO-', to: 'PX-' },
    { from: 'ORD',     to: '' },
  ]);
});

test('M3a: whitespace-only filenameTemplate under "job" layout is stored as "" (trim at store time)', async () => {
  // The specific bug the M3a trim fix closes. Pre-fix, the renderer
  // stored the raw string; validation ran on the trimmed value so a
  // "   " template passed under 'job' layout — then M2 later saw a
  // truthy template, tried to resolve it, produced blank, and sent
  // every image down the empty-resolution fallback. Both the renderer
  // (fast feedback) and the IPC handler (defence-in-depth) now trim.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'job',
    filenameTemplate:  '   ',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  const persisted = __controllers.find(c => c.id === ctrl.id);
  assert.equal(persisted.filenameTemplate, '',
    'whitespace-only template must NOT persist as a truthy string — M2 would treat it as a real template and fallback every image');
});

test('M3a: leading/trailing whitespace on a real template is trimmed at store time', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'root',
    filenameTemplate:  '  {orderNumber}_{index}  ',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  const persisted = __controllers.find(c => c.id === ctrl.id);
  assert.equal(persisted.filenameTemplate, '{orderNumber}_{index}',
    'leading/trailing whitespace stripped — the inner content is preserved verbatim');
});

test('M3a: whitespace-only legacy stripOrderNumberPrefix is trimmed to blank at IPC boundary', async () => {
  // Symmetric with the filenameTemplate trim. Legacy single-string
  // field still trimmed for the downgrade-friendly write path.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout:      'job',
    stripOrderNumberPrefix: '   ',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  const persisted = __controllers.find(c => c.id === ctrl.id);
  assert.equal(persisted.stripOrderNumberPrefix, '');
});

test('round-trip: update-then-read preserves the three fields (no silent drop on edit)', async () => {
  resetState();
  // First save — the "add" path.
  await saveController(null, makeFolderCopyCtrl({
    filenameTemplate:       '{orderNumber}',
    destinationLayout:      'root',
    orderNumberPrefixRules: [],
  }));
  // Second save — the "edit" path. Different template, same id.
  const edited = makeFolderCopyCtrl({
    filenameTemplate:       '{jobName}_{indexPadded}',
    destinationLayout:      'job',
    orderNumberPrefixRules: [{ from: 'PXDEMO-', to: 'PX-' }],
  });
  const result = await saveController(null, edited);
  assert.equal(result.success, true);
  const persisted = __controllers.find(c => c.id === 'ctrl-fc-1');
  assert.equal(persisted.filenameTemplate,   '{jobName}_{indexPadded}');
  assert.equal(persisted.destinationLayout,  'job');
  assert.deepEqual(persisted.orderNumberPrefixRules, [{ from: 'PXDEMO-', to: 'PX-' }]);
});
