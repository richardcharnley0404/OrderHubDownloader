'use strict';

/**
 * Unit tests for the ohd:filmReview:approve-roll IPC handler's manifest-extra
 * wiring (Stage 2 of the film-scan twin-check upload recording feature).
 *
 * Contract asserted:
 *   - When the roll has matchedJobId set, approve-roll passes a manifestExtra
 *     block (twin_check, job_id, job_number, order_id, order_number,
 *     matched_at, auto_assigned:true) as the 5th arg to s3Service.uploadFolder.
 *   - When the roll has no match, the 5th arg is null (byte-identical
 *     manifest to the pre-feature shape).
 *
 * The core _buildFilmScanManifestExtra helper is already unit-tested in
 * folder-watch-manifest-extra.test.js — this test file specifically covers
 * the approve-roll → s3-service wiring that lives in ipc-handlers.js and
 * cannot be exercised by the folder-watch tests.
 *
 * Harness pattern mirrors ipc-handlers-auto-print.test.js: stub every
 * service via require.cache injection, capture ipcMain.handle() invocations
 * so we can invoke the approve-roll handler directly, and instrument the
 * s3-service stub to record the 5th arg.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const Module  = require('node:module');
const fs      = require('node:fs');
const os      = require('node:os');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');
const MAIN = path.join(REPO, 'src', 'main');

// ── Mutable test state ──────────────────────────────────────────────────────

let __rolls       = new Map();   // rollId → record
let __s3Calls     = [];          // { localFolderPath, s3Prefix, credentials, manifestExtra }
let __config      = {};
let __capturedHandlers = new Map(); // channelName → handler fn
let __s3ConfigForBuild = { provider: 'pixfizz', bucketName: 'test-bucket', locationId: 'loc-1' };
let __tempStoragePaths = [];     // cleanup

function resetState() {
  __rolls = new Map();
  __s3Calls = [];
  __config = { filmScanAutoAssignEnabled: false };
  // Handlers are captured once at setupIpcHandlers time; we don't clear them.
  __s3ConfigForBuild = { provider: 'pixfizz', bucketName: 'test-bucket', locationId: 'loc-1' };
}

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function makeTempRollDir(rollId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ohd-approve-${rollId}-`));
  fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
  __tempStoragePaths.push(dir);
  return dir;
}

// ── Service stubs ───────────────────────────────────────────────────────────

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
};

const fakeFrameMetadataStore = {
  getRoll(rollId) { return __rolls.get(rollId) || null; },
  updateRoll(rollId, patch) {
    const cur = __rolls.get(rollId) || { rollId };
    __rolls.set(rollId, { ...cur, ...patch });
  },
  markRollReviewed() { /* no-op */ },
  // Called by the folder-watch-service stub's _buildFilmScanManifestExtra pass-through,
  // but the ipc-handlers path uses its own require of the store; identical shape.
};

// The real _buildFilmScanManifestExtra is the shape we want to assert, so
// mirror its behaviour here in the folder-watch stub. That mirrors what
// ipc-handlers.js calls at line ~3651: folderWatchService._buildFilmScanManifestExtra(rollId).
const fakeFolderWatchService = {
  _buildS3Config() { return __s3ConfigForBuild; },
  _buildFilmScanManifestExtra(rollId) {
    const rec = __rolls.get(rollId);
    if (!rec || !rec.matchedJobId) return null;
    return {
      twin_check:    rec.matchedTwinCheck,
      job_id:        rec.matchedJobId,
      job_number:    rec.matchedJobNumber,
      order_id:      rec.matchedOrderId,
      order_number:  rec.matchedOrderNumber,
      matched_at:    rec.matchedAt,
      auto_assigned: true,
    };
  },
};

const fakeS3Service = {
  async uploadFolder(localFolderPath, s3Prefix, credentials, _progressCallback, manifestExtra) {
    __s3Calls.push({ localFolderPath, s3Prefix, credentials, manifestExtra });
    return { uploaded: 1, failed: 0, total: 1 };
  },
};

const fakeConfigService = {
  get(k) { return __config[k]; },
  getAll() { return { ...__config }; },
};

function FakeStore() {
  const data = {};
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
  };
}

// The many services ipc-handlers requires at load time; empty stubs for
// the ones we don't exercise.
stubInCache(path.join(SVC, 'logger.js'),                          noopLogger);
stubInCache(path.join(SVC, 'config-service.js'),                  fakeConfigService);
stubInCache(path.join(SVC, 's3-service.js'),                      fakeS3Service);
stubInCache(path.join(SVC, 'job-service.js'),                     { getLocalJobs: () => ({ jobs: [] }), updateJobLocally: () => {}, findJobByOrderNumber: () => null, markCompleted: async () => ({}) });
stubInCache(path.join(SVC, 'print-service.js'),                   { sendViaDPOFRouted: async () => ({}), _sendViaFolderCopyRouted: async () => ({}) });
stubInCache(path.join(SVC, 'controller-types.js'),                { DPOF_TYPES: [] });
stubInCache(path.join(SVC, 'awaiting-manifest.js'),               { awaitingReArmUpdates: () => {} });
stubInCache(path.join(SVC, 'test-print-controller.js'),           { runTest: async () => ({}) });
stubInCache(path.join(SVC, 'print-controller-store.js'),          { printControllerStore: { get: () => [], set: () => {} } });
stubInCache(path.join(SVC, 'routing-service.js'),                 { migrateFromPrintControllerStore: () => {}, backfillLegacyPrintSizeCode: () => {}, validateDPOFPrintSizeCode: () => ({ valid: true }), stripDeprecatedConfigJsonKeys: () => {}, getControllers: () => [], resolveRoute: () => null, getRoutingHeldProcesses: () => new Set() });
stubInCache(path.join(SVC, 'process-folder-service.js'),          {});
stubInCache(path.join(SVC, 'fuji-jobmaker-config.js'),            {});
stubInCache(path.join(SVC, 'frame-metadata-store.js'),            fakeFrameMetadataStore);
stubInCache(path.join(SVC, 'film-review-prefs-store.js'),         {});
stubInCache(path.join(SVC, 'app-prefs-store.js'),                 { get: () => undefined, set: () => {} });
stubInCache(path.join(SVC, 'folder-watch-service.js'),            fakeFolderWatchService);
stubInCache(path.join(SVC, 'job-download-service.js'),            { checkLocalFiles: () => ({ found: false }) });
stubInCache(path.join(SVC, 'ai-job-quality-orchestrator.js'),     { scoreJob: async () => ({ ok: true }) });
stubInCache(path.join(SVC, 'ai-quality-store.js'),                { getJobQuality: async () => [], deriveHeld: () => false });
stubInCache(path.join(MAIN, 'updater.js'),                        { setMainWindow: () => {}, startUpdateSchedule: () => {} });
stubInCache(path.join(MAIN, 'jobs', 'sidecarManager.js'),         { loadSidecar: () => null, saveSidecar: () => {} });
stubInCache(path.join(MAIN, 'jobs', 'originalsManager.js'),       { ensureWorkingSetup: () => {}, ensureOriginals: () => {}, resetImage: () => {}, resetAllImages: () => {} });
stubInCache(path.join(MAIN, 'jobs', 'reprintManager.js'),         { createReprint: () => {} });
stubInCache(path.join(MAIN, 'jobs', 'outputStatusManager.js'),    { getJobOutputStatus: () => ({}) });
stubInCache(path.join(MAIN, 'enhancement', 'enhancementManager.js'), {});
stubInCache(path.join(MAIN, 'enhancement', 'localClient.js'),     {});

// electron + electron-store stubs. ipcMain.handle captures each handler by
// channel name into __capturedHandlers so the tests can invoke them directly.
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      ipcMain: {
        handle: (channel, fn) => { __capturedHandlers.set(channel, fn); },
        on: () => {},
      },
      dialog: { showOpenDialog: async () => ({ canceled: true }) },
      app: { getVersion: () => '1.0.0-test', getPath: () => os.tmpdir() },
      BrowserWindow: {
        getAllWindows: () => [],
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
        showItemInFolder: () => {},
      },
    };
  }
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

// Loading ipc-handlers registers every handler once. We then extract the
// approve-roll one and invoke it per-test.
const { setupIpcHandlers } = require(path.join(MAIN, 'ipc-handlers.js'));
setupIpcHandlers(
  {
    start: () => {}, stop: () => {}, getStatus: () => ({}), poll: async () => ({}),
    isRunning: () => false,
    setJobsUpdatedCallback: () => {},
    setAutoPrintCallback:   () => {},
    restartFolderMonitors:  () => {},
  },                                                                    // pollingService
  { scanAndDownload: async () => ({}), testConnection: async () => ({}) }, // ftpService
  { getMainWindow: () => null },                                        // windowManager
);

const approveRoll = __capturedHandlers.get('ohd:filmReview:approve-roll');
assert.ok(approveRoll, 'ohd:filmReview:approve-roll handler must be registered');

function invoke(rollId) {
  // ipcMain.handle passes (event, ...args); simulate that here.
  return approveRoll({}, rollId);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('approve-roll: matched roll → manifestExtra block passed as 5th arg to uploadFolder', async () => {
  resetState();
  const rollId = 'ROLL-MATCH-1847';
  __rolls.set(rollId, {
    rollId,
    storagePath: makeTempRollDir(rollId),
    s3Prefix:    'film-scans/loc-1/',
    locationId:  'loc-1',
    uploadStatus: 'pending',
    awaitingAssignment: false,
    reviewPassed:       true,
    matchedJobId:       'JOB-PXDEMO-1',
    matchedJobNumber:   'PXDEMO-WT6L0M-1',
    matchedOrderId:     'ORD-DEMO',
    matchedOrderNumber: 'PXDEMO-WT6L0M',
    matchedTwinCheck:   '1847',
    matchedAt:          '2026-07-17T10:00:00.000Z',
  });

  const res = await invoke(rollId);
  assert.equal(res.ok, true, `approve-roll should succeed; got ${JSON.stringify(res)}`);
  assert.equal(__s3Calls.length, 1, 'exactly one uploadFolder call');

  const extra = __s3Calls[0].manifestExtra;
  assert.ok(extra && typeof extra === 'object', 'manifestExtra is a plain object');
  assert.deepEqual(extra, {
    twin_check:    '1847',
    job_id:        'JOB-PXDEMO-1',
    job_number:    'PXDEMO-WT6L0M-1',
    order_id:      'ORD-DEMO',
    order_number:  'PXDEMO-WT6L0M',
    matched_at:    '2026-07-17T10:00:00.000Z',
    auto_assigned: true,
  });
});

test('approve-roll: unmatched roll → manifestExtra is null (byte-identical legacy manifest)', async () => {
  resetState();
  const rollId = 'ROLL-NOMATCH';
  __rolls.set(rollId, {
    rollId,
    storagePath: makeTempRollDir(rollId),
    s3Prefix:    'film-scans/loc-1/',
    locationId:  'loc-1',
    uploadStatus: 'pending',
    awaitingAssignment: false,
    reviewPassed:       true,
    matchedJobId:       null,
  });

  const res = await invoke(rollId);
  assert.equal(res.ok, true);
  assert.equal(__s3Calls.length, 1);
  assert.equal(__s3Calls[0].manifestExtra, null,
    'no match → null manifestExtra so the manifest stays byte-identical to the pre-feature shape');
});

test('approve-roll: legacy roll without any matched* fields → manifestExtra is null', async () => {
  // Simulates a roll record persisted from a pre-feature build: no
  // matchedJobId key at all. approve-roll must fall through cleanly and
  // pass null (no crash on undefined field access).
  resetState();
  const rollId = 'ROLL-LEGACY';
  __rolls.set(rollId, {
    rollId,
    storagePath: makeTempRollDir(rollId),
    s3Prefix:    'film-scans/loc-1/',
    locationId:  'loc-1',
    uploadStatus: 'pending',
  });

  const res = await invoke(rollId);
  assert.equal(res.ok, true);
  assert.equal(__s3Calls.length, 1);
  assert.equal(__s3Calls[0].manifestExtra, null);
});

// Cleanup temp dirs at process exit.
process.on('exit', () => {
  for (const p of __tempStoragePaths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
});
