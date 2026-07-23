'use strict';

/**
 * M5a regression tests — single-image crop pipeline for manual-source files.
 *
 * Locks the four-point functional contract from
 * `OHD_ManualCropping_ClaudeCode_Brief.md` §M5a against the existing
 * `ohd:job:crop-image` handler (ipc-handlers.js:1499):
 *
 *   1. After crop, `working/{filename}` exists, is a valid JPEG, with
 *      dimensions matching the requested cropRect.
 *   2. The raw upload at the flat job folder root (`{jobPath}/{filename}`)
 *      is byte-identical before and after — audit trail preserved.
 *   3. Sidecar entry gains `cropApplied: true` + `croppedPath` (absolute,
 *      pointing at `working/{filename}`) + `cropRect` verbatim +
 *      `channelMappingId` from the payload. The entry's `filename` field
 *      stays unchanged — the in-place-overwrite model is the de-facto
 *      contract, NOT the brief's aspirational `_cropped.jpeg`-suffix
 *      rewrite. See the brief's "Brief vs. as-built" subsection.
 *   4. The next `_getEnhancedPathMap` call substitutes `croppedPath` for
 *      `filename` so dispatch sends the cropped pixels (covered in
 *      sibling test file `manualCrop.dispatch.test.js`).
 *
 * The handler is registered inside `setupIpcHandlers()`. We stub
 * `ipcMain.handle` to capture every channel→handler pair, then invoke
 * the `ohd:job:crop-image` handler directly with controlled inputs. Real
 * `sharp` + real `fs` + real `sidecarManager.{load,save}Sidecar`; only
 * the heavy electron-side services are stubbed.
 *
 * Run via:
 *   npm test
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs/promises');
const fssync  = require('node:fs');
const path    = require('node:path');
const os      = require('node:os');
const Module  = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');
const MAIN = path.join(REPO, 'src', 'main');

// ── Stub plumbing ────────────────────────────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
};

// Records every IPC handler registered by setupIpcHandlers, keyed by channel.
const capturedHandlers = new Map();

// Fake electron — capture handlers, no-op the rest. Note: setupIpcHandlers
// also calls ipcMain.on() for a couple of events; absorb those as no-ops.
const fakeElectron = {
  ipcMain: {
    handle: (channel, fn) => { capturedHandlers.set(channel, fn); },
    on:     () => {},
  },
  dialog:  { showOpenDialog: async () => ({ canceled: true }) },
  app:     { getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() },
  BrowserWindow: function () {},
  shell:   {
    openExternal:      async () => ({ ok: true }),
    openPath:          async () => '',
    showItemInFolder:  () => {},
  },
};

// Fake electron-store constructor — in-memory.
function FakeStore() {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
    delete: (k)    => { delete data[k]; },
  };
}

// jobService.updateJobLocally is called by the handler when ohJobId +
// channelMappingId|darkroomSize are both supplied. We pass ohJobId=undefined
// so the branch is skipped, but stub the method shape regardless.
const fakeJobService = {
  updateJobLocally: () => {},
  // Other methods are referenced at top of ipc-handlers but not by the
  // crop-image handler — stub as no-ops.
  getLocalJobs:        () => ({ jobs: [] }),
  findJobByOrderNumber:() => null,
  markCompleted:       async () => ({}),
};

// Stub heavy services BEFORE requiring ipc-handlers so the top-level
// requires resolve to these no-ops. sidecarManager is intentionally
// NOT stubbed — we want the real load/save behaviour.
stubInCache(path.join(SVC, 'config-service.js'),                    { get: () => undefined, set: () => {} });
stubInCache(path.join(SVC, 'logger.js'),                            noopLogger);
stubInCache(path.join(SVC, 'job-service.js'),                       fakeJobService);
stubInCache(path.join(SVC, 'print-service.js'),                     {});
stubInCache(path.join(SVC, 'routing-service.js'),                   {
  getControllers: () => [],
  resolveRoute: () => null,
  // setupIpcHandlers invokes these at top level on every load.
  migrateFromPrintControllerStore: () => {},
  backfillLegacyPrintSizeCode:     () => {},
  validateDPOFPrintSizeCode:       () => ({ valid: true }),
  stripDeprecatedConfigJsonKeys:   () => {},
});
stubInCache(path.join(SVC, 's3-service.js'),                        {});
stubInCache(path.join(SVC, 'test-print-controller.js'),             { runTest: async () => ({}) });
stubInCache(path.join(SVC, 'print-controller-store.js'),            { printControllerStore: { get: () => [], set: () => {} } });
stubInCache(path.join(SVC, 'process-folder-service.js'),            {});
stubInCache(path.join(SVC, 'fuji-jobmaker-config.js'),              {});
stubInCache(path.join(SVC, 'frame-metadata-store.js'),              {});
stubInCache(path.join(SVC, 'film-review-prefs-store.js'),           {});
stubInCache(path.join(SVC, 'app-prefs-store.js'),                   {});
stubInCache(path.join(SVC, 'folder-watch-service.js'),              {});
stubInCache(path.join(SVC, 'job-download-service.js'),              { checkLocalFiles: () => ({ found: false }) });
stubInCache(path.join(SVC, 'ai-job-quality-orchestrator.js'),       { scoreJob: async () => ({ ok: true, held: false }) });
stubInCache(path.join(SVC, 'ai-quality-store.js'),                  { getJobQuality: async () => [], deriveHeld: () => false });
stubInCache(path.join(MAIN, 'updater.js'),                          { setMainWindow: () => {}, startUpdateSchedule: () => {} });

// Override electron + electron-store via Module.prototype.require so
// ipc-handlers' top-level imports resolve to our fakes without booting
// the real Electron runtime.
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron')        return fakeElectron;
  if (req === 'electron-store')  return FakeStore;
  return __originalRequire.apply(this, arguments);
};

// Now safe to load ipc-handlers. Calling setupIpcHandlers populates
// capturedHandlers.
const { setupIpcHandlers } = require(path.join(MAIN, 'ipc-handlers.js'));
setupIpcHandlers(
  /* pollingService */ {
    start: () => {}, stop: () => {},
    isRunning: () => false, getStatus: () => ({ running: false }),
    restartFolderMonitors:   () => {},
    setJobsUpdatedCallback:  () => {},
    setAutoPrintCallback:    () => {},
  },
  /* ftpService     */ {
    testConnection:  async () => ({ success: true }),
    scanAndDownload: async () => ({ downloaded: 0, skipped: 0, failed: 0, errors: [] }),
  },
  /* windowManager  */ { getWindow: () => null, getMainWindow: () => null },
);

const cropImageHandler = capturedHandlers.get('ohd:job:crop-image');
assert.ok(cropImageHandler, 'expected ohd:job:crop-image handler to be registered');

// ── Test fixture helpers ─────────────────────────────────────────────────────

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'm5a-crop-'));
}

/**
 * Produce a real test JPEG via sharp — a 200x150 solid-color image so we
 * can verify the post-crop dimensions match the requested rect.
 */
async function writeTestJpeg(destPath, { width = 200, height = 150 } = {}) {
  // Lazy-require so the stub plumbing above is fully in place first.
  // eslint-disable-next-line global-require
  const sharp = __originalRequire.call(module, 'sharp');
  await sharp({
    create: {
      width, height, channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg({ quality: 90 })
    .toFile(destPath);
}

/**
 * Build the minimal sidecar shape the handler reads/writes. Mirrors what
 * sidecarManager.loadSidecar would produce for a one-image manual job
 * before any crop is applied.
 */
function makeSidecar(jobId, filename) {
  return {
    jobId,
    schemaVersion: 1,
    createdAt:  '2026-05-25T00:00:00.000Z',
    modifiedAt: '2026-05-25T00:00:00.000Z',
    reprintOf:  null,
    s3ArtworkFileIdsKnown: ['fake-id-1'],
    images: [{
      filename,
      qtyOriginal: 1,
      qtyCurrent:  1,
      corrections: { cyan: 0, magenta: 0, yellow: 0 },
      reprint: false, reprintJobId: null,
      enhanced: false, enhancementSource: null, enhancedPath: null, enhancedAt: null, enhancementModel: null,
      integritySuspect: null,
      aiQuality: {
        scored: false, score: null, thresholdAtScoreTime: null, passed: true,
        modelVersion: null, inferenceMs: null, scoredAt: null, error: null,
        fixupHistory: [], operatorDecision: { kind: 'none', decidedAt: null, note: null },
      },
      originalFilename: null, recropPath: null, recropOf: null, recroppedAt: null,
      artworkFileId: 'fake-id-1',
      artworkSource: 'manual', artworkType: 'optimized',
      productionReady: true, originalFileName: filename, copies: 1,
    }],
  };
}

/**
 * Set up a job folder shaped like a real M1-downloaded manual job that has
 * been opened in Job Review (so ensureWorkingSetup has already run):
 *
 *   {jobPath}/{filename}                 ← raw upload (audit copy at flat root)
 *   {jobPath}/working/{filename}         ← pre-crop working copy
 *   {jobPath}/{jobId}.json               ← sidecar
 *
 * Returns the absolute jobPath + raw upload bytes captured for the
 * before-vs-after byte-identity assertion.
 */
async function setupManualJobFolder(downloadDir, {
  orderNumber = 'POS-M5A',
  orderId     = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  jobId       = '11111111-2222-3333-4444-555555555555',
  filename    = 'manual-upload.jpg',
} = {}) {
  const jobFolderName = `${orderNumber}_${jobId}`;
  const jobPath       = path.join(downloadDir, `${orderNumber}_${orderId}`, jobFolderName);
  const sidecarJobId  = jobFolderName;
  await fs.mkdir(path.join(jobPath, 'working'), { recursive: true });

  const flatPath    = path.join(jobPath, filename);
  const workingPath = path.join(jobPath, 'working', filename);

  // Real JPEG at the flat root (audit copy) AND inside working/ (the source
  // the handler will read from).
  await writeTestJpeg(flatPath);
  await fs.copyFile(flatPath, workingPath);

  const sidecar = makeSidecar(sidecarJobId, filename);
  const sidecarPath = path.join(jobPath, `${sidecarJobId}.json`);
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');

  const flatBytes = await fs.readFile(flatPath);

  return { jobPath, sidecarPath, sidecarJobId, filename, flatPath, workingPath, sidecar, flatBytes };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('M5a: crop on a manual file writes cropped pixels to working/<filename> with cropRect-matching dimensions', async (t) => {
  const downloadDir = await makeTempDir();
  t.after(() => fs.rm(downloadDir, { recursive: true, force: true }));

  const ctx = await setupManualJobFolder(downloadDir);
  const cropRect = { x: 30, y: 20, w: 100, h: 80 };

  const result = await cropImageHandler(
    /* event */ null,
    {
      jobPath:  ctx.jobPath,
      sidecar:  ctx.sidecar,
      filename: ctx.filename,
      cropRect,
      // Routing override fields are exercised by Scenario 4 below; here
      // we just want the bare crop.
      channelMappingId: null,
      darkroomSize:     null,
      ohJobId:          null,
    },
  );

  assert.equal(result.success, true, `handler must succeed; got ${JSON.stringify(result)}`);

  // Working file dimensions match the requested rect.
  // eslint-disable-next-line global-require
  const sharp = __originalRequire.call(module, 'sharp');
  const meta = await sharp(ctx.workingPath).metadata();
  assert.equal(meta.width,  cropRect.w, 'cropped width must equal cropRect.w');
  assert.equal(meta.height, cropRect.h, 'cropped height must equal cropRect.h');
  assert.equal(meta.format, 'jpeg',     'output must be JPEG');
});

test('M5a: raw upload at flat job folder root is byte-identical before/after crop (audit preserved)', async (t) => {
  const downloadDir = await makeTempDir();
  t.after(() => fs.rm(downloadDir, { recursive: true, force: true }));

  const ctx = await setupManualJobFolder(downloadDir);

  await cropImageHandler(null, {
    jobPath: ctx.jobPath, sidecar: ctx.sidecar, filename: ctx.filename,
    cropRect: { x: 10, y: 10, w: 50, h: 50 },
    channelMappingId: null, darkroomSize: null, ohJobId: null,
  });

  const flatBytesAfter = await fs.readFile(ctx.flatPath);
  assert.deepEqual(flatBytesAfter, ctx.flatBytes,
    'raw upload at flat job folder root MUST be byte-identical after crop — audit copy is load-bearing');
});

test('M5a: sidecar gains cropApplied + croppedPath + cropRect + channelMappingId; filename stays unchanged', async (t) => {
  const downloadDir = await makeTempDir();
  t.after(() => fs.rm(downloadDir, { recursive: true, force: true }));

  const ctx = await setupManualJobFolder(downloadDir);
  const cropRect = { x: 25, y: 15, w: 120, h: 90 };
  const channelMappingId = 'test-channel-mapping-uuid';

  const result = await cropImageHandler(null, {
    jobPath: ctx.jobPath, sidecar: ctx.sidecar, filename: ctx.filename,
    cropRect, channelMappingId, darkroomSize: null, ohJobId: null,
  });

  assert.equal(result.success, true);

  // Read sidecar from disk to confirm persistence (handler returns the
  // in-memory copy; we want to lock the on-disk shape too).
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const entry = onDisk.images.find((i) => i.filename === ctx.filename);
  assert.ok(entry, 'sidecar entry for the cropped filename must still be findable by basename');

  assert.equal(entry.cropApplied, true,             '`cropApplied` flag must flip to true');
  assert.equal(typeof entry.croppedPath, 'string',  '`croppedPath` must be a string (absolute path to working/<filename>)');
  assert.equal(entry.croppedPath, ctx.workingPath,  '`croppedPath` must point at the working/ copy that received the in-place overwrite');
  assert.deepEqual(entry.cropRect, cropRect,        '`cropRect` must be persisted verbatim from the payload');
  assert.equal(entry.channelMappingId, channelMappingId, '`channelMappingId` must be persisted on the entry for the routing override');

  // The load-bearing contract assertion: filename DOES NOT change. M5b
  // depends on this — `originalsManager.resetImage(filename)` reads
  // `originals/<filename>`; AI scoring's `_scanJobImages` enumerates
  // `working/` and keys by basename; reprint manager keys by basename.
  // If a future refactor rewrites filename to a `_cropped.jpeg` suffix,
  // those readers silently break. This assertion locks the contract.
  assert.equal(entry.filename, ctx.filename,
    'M5a contract: sidecar entry.filename must remain the original basename after crop. '
    + 'The cropped pixels live at the same path (in-place overwrite of working/<filename>); '
    + 'the rename-to-_cropped.jpeg wording in the brief was aspirational and conflicts with '
    + 'originalsManager.resetImage + _scanJobImages + reprint manager which all key by basename. '
    + 'See OHD_ManualCropping_ClaudeCode_Brief.md §"Brief vs. as-built".');
});

test('M5a: re-crop on an already-cropped file overwrites working/<filename> with new pixels in-place', async (t) => {
  // The renderer can fire crop multiple times. Each call overwrites the
  // working copy via the atomic .crop_tmp + rename pattern; the previous
  // cropped JPEG is discarded (no history). cropRect persists from the
  // latest call.
  const downloadDir = await makeTempDir();
  t.after(() => fs.rm(downloadDir, { recursive: true, force: true }));

  const ctx = await setupManualJobFolder(downloadDir);

  // First crop — 100×80.
  let result = await cropImageHandler(null, {
    jobPath: ctx.jobPath, sidecar: ctx.sidecar, filename: ctx.filename,
    cropRect: { x: 30, y: 20, w: 100, h: 80 },
    channelMappingId: null, darkroomSize: null, ohJobId: null,
  });
  assert.equal(result.success, true);
  const firstSidecar = result.sidecar;

  // Second crop — 60×40 on the already-cropped working file.
  // (The cropRect is interpreted against the source the handler reads,
  // which is now the already-cropped 100×80 image.)
  result = await cropImageHandler(null, {
    jobPath: ctx.jobPath, sidecar: firstSidecar, filename: ctx.filename,
    cropRect: { x: 5, y: 5, w: 60, h: 40 },
    channelMappingId: null, darkroomSize: null, ohJobId: null,
  });
  assert.equal(result.success, true);

  // Verify the working file is now 60×40 (the second crop's rect).
  // eslint-disable-next-line global-require
  const sharp = __originalRequire.call(module, 'sharp');
  const meta = await sharp(ctx.workingPath).metadata();
  assert.equal(meta.width,  60, 're-crop must produce the new width');
  assert.equal(meta.height, 40, 're-crop must produce the new height');

  // Sidecar cropRect reflects the latest call.
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const entry  = onDisk.images.find((i) => i.filename === ctx.filename);
  assert.deepEqual(entry.cropRect, { x: 5, y: 5, w: 60, h: 40 },
    're-crop must replace the cropRect with the latest call\'s values — no history kept');
});

test('M5a: dispatch substitution map keys filename→croppedPath after crop (regression against the print-service contract)', async (t) => {
  // This assertion is structural: a sidecar entry with cropApplied +
  // croppedPath + an extant file at croppedPath must produce a map
  // entry { filename → croppedPath }. The sibling test file
  // manualCrop.dispatch.test.js exercises print-service._getEnhancedPathMap
  // directly; here we just re-state the data shape it relies on, so a
  // regression in the crop-image handler that drops one of those fields
  // surfaces immediately rather than only via the dispatch-side test.
  const downloadDir = await makeTempDir();
  t.after(() => fs.rm(downloadDir, { recursive: true, force: true }));

  const ctx = await setupManualJobFolder(downloadDir);

  const result = await cropImageHandler(null, {
    jobPath: ctx.jobPath, sidecar: ctx.sidecar, filename: ctx.filename,
    cropRect: { x: 10, y: 10, w: 80, h: 60 },
    channelMappingId: null, darkroomSize: null, ohJobId: null,
  });
  assert.equal(result.success, true);

  // Three independent conditions the dispatch substitution relies on:
  //   1. entry.cropApplied truthy
  //   2. entry.croppedPath truthy
  //   3. fs.existsSync(entry.croppedPath) === true
  // If any drops, _getEnhancedPathMap.map.set() never fires → dispatch
  // would send the original (uncropped) pixels.
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const entry  = onDisk.images.find((i) => i.filename === ctx.filename);
  assert.ok(entry.cropApplied, 'cropApplied: truthy gate');
  assert.ok(entry.croppedPath, 'croppedPath: truthy gate');
  assert.equal(fssync.existsSync(entry.croppedPath), true, 'croppedPath: file-exists gate');
});
