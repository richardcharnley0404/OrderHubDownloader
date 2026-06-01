'use strict';

/**
 * M5a regression tests — dispatch-side substitution contract.
 *
 * `print-service._getEnhancedPathMap` (print-service.js:1861) is the
 * single load-bearing reader that decides whether dispatch sends the
 * cropped pixels or the original/uncropped working file. The crop pipe-
 * line tested in manualCrop.test.js writes `cropApplied + croppedPath`
 * onto the sidecar; this file pins the read-side contract so that:
 *
 *   1. Crop takes priority over enhancement (`cropApplied + croppedPath`
 *      wins over `enhanced + enhancedPath` for the same row).
 *   2. The file-existence gate (`fs.existsSync(croppedPath)`) prevents a
 *      stale sidecar pointer from short-circuiting dispatch when the
 *      file has been deleted out from under us.
 *   3. Plain rows (neither cropped nor enhanced) produce no map entry,
 *      so dispatch falls back to the original `/working/{filename}` read.
 *   4. Multiple rows in one job each get their own correct entry.
 *
 * Strategy: stub the few heavy deps print-service pulls in (config-
 * service, electron-store, the controller-side generators that aren't
 * exercised by `_getEnhancedPathMap`), then call the method directly
 * on the singleton with a real sidecar JSON on disk + real files
 * representing the cropped / enhanced outputs.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs/promises');
const path    = require('node:path');
const os      = require('node:os');
const Module  = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');
const MAIN = path.join(REPO, 'src', 'main');

// ── Stub plumbing (minimal — only what print-service touches at load) ───────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
};

// Stub the electron + electron-store imports that config-service pulls in
// before print-service loads. config-service itself is the trickier one —
// it instantiates electron-store at top level, which calls electron's
// `app.getPath('userData')`. Provide both.
function FakeStore() {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
    delete: (k)    => { delete data[k]; },
    store: data,
  };
}

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      ipcMain:       { handle: () => {}, on: () => {} },
      dialog:        { showOpenDialog: async () => ({ canceled: true }) },
      app:           { getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() },
      BrowserWindow: function () {},
      shell:         { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    };
  }
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'logger.js'), noopLogger);

// Now safe to load print-service. It auto-singletons at the bottom of the
// file (`module.exports = new PrintService()`).
const printService = require(path.join(SVC, 'print-service.js'));

// ── Fixture helpers ─────────────────────────────────────────────────────────

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'm5a-dispatch-'));
}

/**
 * Write a minimal sidecar + the job folder shape `_getEnhancedPathMap`'s
 * loadSidecar call expects.
 *
 *   {downloadDir}/{orderFolderName}/{jobFolderName}/{jobId}.json
 *
 * jobId === jobFolderName (codebase-wide convention; see
 * s3-artwork-downloader.js header comment).
 */
async function writeSidecar(downloadDir, { orderFolderName, jobFolderName, images }) {
  const jobPath  = path.join(downloadDir, orderFolderName, jobFolderName);
  await fs.mkdir(jobPath, { recursive: true });

  const sidecar = {
    jobId: jobFolderName,
    schemaVersion: 1,
    createdAt:  '2026-05-25T00:00:00.000Z',
    modifiedAt: '2026-05-25T00:00:00.000Z',
    reprintOf:  null,
    s3ArtworkFileIdsKnown: [],
    images: images.map((i) => ({
      filename: i.filename,
      qtyOriginal: 1, qtyCurrent: 1,
      corrections: { cyan: 0, magenta: 0, yellow: 0 },
      reprint: false, reprintJobId: null,
      enhanced: !!i.enhanced, enhancementSource: i.enhanced ? 'topaz-direct' : null,
      enhancedPath: i.enhancedPath || null,
      enhancedAt: i.enhanced ? '2026-05-25T00:00:00.000Z' : null,
      enhancementModel: i.enhanced ? 'Standard V2' : null,
      integritySuspect: null,
      aiQuality: {
        scored: false, score: null, thresholdAtScoreTime: null, passed: true,
        modelVersion: null, inferenceMs: null, scoredAt: null, error: null,
        fixupHistory: [], operatorDecision: { kind: 'none', decidedAt: null, note: null },
      },
      originalFilename: null, recropPath: null, recropOf: null, recroppedAt: null,
      artworkFileId: null, artworkSource: null, artworkType: null,
      productionReady: null, originalFileName: null, copies: null,
      // M5a fields under test:
      cropApplied: !!i.cropApplied,
      croppedPath: i.croppedPath || null,
      cropRect:    i.cropRect    || null,
    })),
  };

  await fs.writeFile(path.join(jobPath, `${jobFolderName}.json`), JSON.stringify(sidecar, null, 2), 'utf8');
  return { jobPath, jobFolderName };
}

async function touchFile(absPath, content = 'X') {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('M5a dispatch: cropped row maps filename → croppedPath when the file exists on disk', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const orderFolderName = 'POS-DISP_orderid';
  const jobFolderName   = 'POS-DISP_jobid';
  const filename        = 'one.jpg';
  const croppedPath     = path.join(dl, orderFolderName, jobFolderName, 'working', filename);
  await touchFile(croppedPath, 'CROPPED-PIXELS');

  const { jobPath } = await writeSidecar(dl, {
    orderFolderName, jobFolderName,
    images: [{ filename, cropApplied: true, croppedPath, cropRect: { x: 0, y: 0, w: 10, h: 10 } }],
  });

  const map = await printService._getEnhancedPathMap(jobFolderName, jobPath);
  assert.equal(map.size, 1);
  assert.equal(map.get(filename), croppedPath,
    'cropped row must produce filename → croppedPath substitution so dispatch sends the cropped pixels');
});

test('M5a dispatch: crop takes priority over enhancement on the same row', async (t) => {
  // Both cropApplied AND enhanced are true. The map MUST point at
  // croppedPath, NOT enhancedPath — operator-chosen crop is canonical;
  // enhancement is a side-channel.
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const orderFolderName = 'POS-PRIO_orderid';
  const jobFolderName   = 'POS-PRIO_jobid';
  const filename        = 'priority.jpg';
  const jobAbs          = path.join(dl, orderFolderName, jobFolderName);
  const croppedPath     = path.join(jobAbs, 'working', filename);
  const enhancedPath    = path.join(jobAbs, 'cache',   `priority_enhanced.jpg`);
  await touchFile(croppedPath,  'CROPPED');
  await touchFile(enhancedPath, 'ENHANCED');

  const { jobPath } = await writeSidecar(dl, {
    orderFolderName, jobFolderName,
    images: [{
      filename,
      cropApplied: true,  croppedPath,
      enhanced:    true,  enhancedPath,
      cropRect: { x: 0, y: 0, w: 5, h: 5 },
    }],
  });

  const map = await printService._getEnhancedPathMap(jobFolderName, jobPath);
  assert.equal(map.get(filename), croppedPath,
    'crop > enhance priority: when both branches qualify, croppedPath wins. '
    + 'Regression here would silently send enhanced (uncropped) pixels to the controller — '
    + 'observable as "I cropped this and the print came out uncropped after enhancement".');
});

test('M5a dispatch: enhancement-only row maps filename → enhancedPath (no regression on the enhance branch)', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const orderFolderName = 'POS-ENH_orderid';
  const jobFolderName   = 'POS-ENH_jobid';
  const filename        = 'enh.jpg';
  const jobAbs          = path.join(dl, orderFolderName, jobFolderName);
  const enhancedPath    = path.join(jobAbs, 'cache', 'enh_enhanced.jpg');
  await touchFile(enhancedPath, 'ENHANCED');

  const { jobPath } = await writeSidecar(dl, {
    orderFolderName, jobFolderName,
    images: [{ filename, enhanced: true, enhancedPath }],
  });

  const map = await printService._getEnhancedPathMap(jobFolderName, jobPath);
  assert.equal(map.get(filename), enhancedPath,
    'enhancement-only row falls through to the enhanced branch (else-if)');
});

test('M5a dispatch: plain row (no crop, no enhance) produces no map entry — dispatch reads the working file', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const orderFolderName = 'POS-PLAIN_orderid';
  const jobFolderName   = 'POS-PLAIN_jobid';
  const filename        = 'plain.jpg';

  const { jobPath } = await writeSidecar(dl, {
    orderFolderName, jobFolderName,
    images: [{ filename }],
  });

  const map = await printService._getEnhancedPathMap(jobFolderName, jobPath);
  assert.equal(map.size, 0,
    'plain row must not appear in the substitution map — dispatch falls back to the standard working/<filename> read');
});

test('M5a dispatch: stale croppedPath (sidecar pointer + missing file) is gated out — no entry produced', async (t) => {
  // Defensive contract: a sidecar that points at a croppedPath which has
  // been deleted/moved out from under us must NOT short-circuit
  // dispatch. The fs.existsSync gate at print-service.js:1867 prevents
  // map.set(); dispatch then falls back to the standard read of
  // /working/<filename>, which may or may not exist itself — but at
  // least we don't dereference a stale pointer.
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const orderFolderName = 'POS-STALE_orderid';
  const jobFolderName   = 'POS-STALE_jobid';
  const filename        = 'stale.jpg';
  const ghostPath       = path.join(dl, orderFolderName, jobFolderName, 'working', filename);
  // Deliberately do NOT touch ghostPath — leave it absent.

  const { jobPath } = await writeSidecar(dl, {
    orderFolderName, jobFolderName,
    images: [{ filename, cropApplied: true, croppedPath: ghostPath, cropRect: { x: 0, y: 0, w: 1, h: 1 } }],
  });

  const map = await printService._getEnhancedPathMap(jobFolderName, jobPath);
  assert.equal(map.size, 0,
    'stale croppedPath (sidecar says cropApplied but file is gone) MUST be gated out by fs.existsSync');
});

test('M5a dispatch: multi-image job — each row resolves independently', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const orderFolderName = 'POS-MULTI_orderid';
  const jobFolderName   = 'POS-MULTI_jobid';
  const jobAbs          = path.join(dl, orderFolderName, jobFolderName);

  const cropped   = path.join(jobAbs, 'working', 'a.jpg');
  const enhanced  = path.join(jobAbs, 'cache',   'b_enhanced.jpg');
  await touchFile(cropped,  'A');
  await touchFile(enhanced, 'B');

  const { jobPath } = await writeSidecar(dl, {
    orderFolderName, jobFolderName,
    images: [
      { filename: 'a.jpg', cropApplied: true, croppedPath: cropped,  cropRect: { x: 0, y: 0, w: 1, h: 1 } },
      { filename: 'b.jpg', enhanced:    true, enhancedPath: enhanced },
      { filename: 'c.jpg' /* plain — no entry */ },
    ],
  });

  const map = await printService._getEnhancedPathMap(jobFolderName, jobPath);
  assert.equal(map.size, 2,        'two of three rows produce entries; the plain row does not');
  assert.equal(map.get('a.jpg'), cropped);
  assert.equal(map.get('b.jpg'), enhanced);
  assert.equal(map.has('c.jpg'), false);
});
