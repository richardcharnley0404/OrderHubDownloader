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

test('1.16.2 IPC ADVISORY (was: reject): root layout with blank template → saves + warning', async () => {
  // Pre-1.16.2 this test asserted a HARD BLOCK on Root+blank-template
  // ("A filename template is required..."). 1.16.2 replaces the block
  // with an advisory: dispatch's on-disk dedupe pass (see
  // print-service._sendViaFolderCopyRouted → dedupeAgainstDisk)
  // guarantees no overwrite regardless of the template shape, so the
  // save-time block was a 1.15.0-shape mistake. The advisory still
  // fires so the operator understands what shape they picked, but the
  // save succeeds and the controller persists.
  resetState();
  const ctrl = makeFolderCopyCtrl({ destinationLayout: 'root', filenameTemplate: '' });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true, '1.16.2 — save succeeds; the block became an advisory');
  assert.equal(__controllers.length, 1, 'controller persists in 1.16.2');
  assert.ok(Array.isArray(result.warnings), 'warnings array returned');
  const w = result.warnings.find(w => w.kind === 'folder-copy-root-blank-template');
  assert.ok(w, 'blank-template advisory MUST be in warnings');
  assert.match(w.text, /Root layout with no filename template/);
  assert.match(w.text, /_2\/_3 suffixes at write time/);
});

test('1.16.2 IPC ADVISORY (was: reject): root layout with template lacking any job-distinguishing token → saves + warning', async () => {
  // Pre-1.16.2 this rejected `{product}_{index}` under Root. 1.16.2:
  // save succeeds, advisory fires. The never-overwrite dispatch guarantee
  // covers the safety of cross-job collisions with _2/_3 suffixing.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'root',
    filenameTemplate:  '{product}_{index}',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  assert.equal(__controllers.length, 1);
  const w = (result.warnings || []).find(w => w.kind === 'folder-copy-root-no-distinguisher');
  assert.ok(w, 'no-distinguisher advisory MUST be in warnings');
  assert.match(w.text, /does not include any of/);
  assert.match(w.text, /\{orderNumber\}/);
  assert.match(w.text, /\{jobName\}/);
  assert.match(w.text, /\{jobId\}/);
});

test('1.16.2 IPC ADVISORY (was: reject): root layout + {filename} → saves + warning (per-image token does not count as job-distinguishing)', async () => {
  // M3a rationale still holds: {filename} resolves to a manifest basename
  // ("5_IMG.jpg") and camera filenames repeat across orders. The
  // pre-1.16.2 HARD BLOCK on this shape becomes a 1.16.2 advisory. The
  // dispatch-time dedupe pass keeps files safe with suffixing.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'root',
    filenameTemplate:  '{filename}_{index}',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true, '1.16.2 — no hard block on {filename} under Root');
  assert.equal(__controllers.length, 1);
  const w = (result.warnings || []).find(w => w.kind === 'folder-copy-root-no-distinguisher');
  assert.ok(w, 'no-distinguisher advisory fires because {filename} is not a job-distinguisher');
});

test('1.16.2 IPC ADVISORY (was: reject): root layout + {originalFilename} → saves + warning', async () => {
  // {originalFilename} strictly weaker than {filename} for cross-job
  // distinguishing (M3a rationale). Same 1.16.2 advisory shape.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'root',
    filenameTemplate:  '{originalFilename}',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  assert.equal(__controllers.length, 1);
  const w = (result.warnings || []).find(w => w.kind === 'folder-copy-root-no-distinguisher');
  assert.ok(w, '{originalFilename} triggers the no-distinguisher advisory');
});

test('1.16.2 IPC ADVISORY: omitJobId + per-job + template lacks per-image distinguisher → saves + warning', async () => {
  // Item 5 of 1.16.2. omitJobId=true under Per-job layout means two jobs
  // on the same order share the `{orderNumber}/` folder. If the template
  // also produces the same set of resolved filenames per job, every image
  // collides across jobs. Dispatch's dedupeAgainstDisk still saves it
  // with _2 suffixes — advisory, not a block. This test locks the
  // exact wording of the operator-visible message so future edits to
  // the string trip the tripwire the first time they run.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'job',
    omitJobId:         true,
    filenameTemplate:  '{product}',       // no {index}/{indexPadded}/{filename}/{jobName}/{jobId}
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true, 'advisory, not a block');
  assert.equal(__controllers.length, 1);
  const w = (result.warnings || []).find(w => w.kind === 'folder-copy-omitjobid-no-image-distinguisher');
  assert.ok(w, 'omitJobId + no per-image distinguisher MUST fire an advisory');
  assert.match(w.text, /Omit OrderHub job Id/);
  assert.match(w.text, /share the \{orderNumber\} folder/);
  assert.match(w.text, /_2\/_3/);
  assert.match(w.text, /\{index\} \/ \{indexPadded\}/);
});

test('1.16.2 IPC no advisory: omitJobId + per-job + template already has {index} → no per-image warning', async () => {
  // {index} makes every filename unique per image within a job. Combined
  // with omitJobId=true, two jobs on the same order will still land in
  // `{orderNumber}/` but their images resolve to distinct names. No
  // advisory needed. Locks the negative case so an overly-eager future
  // widening of the regex trips a test.
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'job',
    omitJobId:         true,
    filenameTemplate:  '{product}_{index}',
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  const w = (result.warnings || []).find(w => w.kind === 'folder-copy-omitjobid-no-image-distinguisher');
  assert.equal(w, undefined, 'template with {index} MUST NOT trigger the omitJobId advisory');
});

test('1.16.2 IPC omitJobId strict === true migration at the IPC boundary', async () => {
  // The IPC handler coerces omitJobId to a strict boolean (`=== true`).
  // Any other input value MUST persist as false so a pre-1.16.2 controller
  // resaved after upgrade keeps the pre-1.16.2 destination-folder shape.
  // Pair to the read-side migration test in routing-folder-copy-fields.test.js.
  for (const v of [undefined, 'true', 1, 0, null, false, 'yes', '']) {
    resetState();
    const overrides = { destinationLayout: 'job', filenameTemplate: '' };
    if (v !== undefined) overrides.omitJobId = v;
    const ctrl = makeFolderCopyCtrl(overrides);
    const result = await saveController(null, ctrl);
    assert.equal(result.success, true, `omitJobId=${JSON.stringify(v)} — save must succeed`);
    assert.equal(__controllers[0].omitJobId, false,
      `omitJobId=${JSON.stringify(v)} MUST persist as strict boolean false at the IPC boundary`);
  }
});

test('1.16.2 IPC omitJobId strict === true migration: only the literal true persists as true', async () => {
  resetState();
  const ctrl = makeFolderCopyCtrl({
    destinationLayout: 'job',
    filenameTemplate:  '{orderNumber}_{index}',
    omitJobId:         true,
  });
  const result = await saveController(null, ctrl);
  assert.equal(result.success, true);
  assert.equal(__controllers[0].omitJobId, true, 'literal true persists as true');
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
