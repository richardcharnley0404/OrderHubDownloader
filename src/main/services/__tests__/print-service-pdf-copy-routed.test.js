'use strict';

/**
 * Integration tests for _sendViaPdfCopyRouted after the M5 imposition
 * rework. Follows the discipline of print-service-folder-copy-routed:
 * REAL fs writer against a real temp directory, REAL manifest reader,
 * REAL pdf-lib composition. The epson batch-name bug (v1.13.x) shipped
 * past every unit test it had because the writer was stubbed and the
 * tests never saw what actually landed on disk; the imposition writer
 * has the same failure surface (a compose bug that "returns success"
 * but writes the wrong bytes) so this suite exercises the whole chain.
 *
 * Test 1 is the no-change lock and runs FIRST — if it fails, no other
 * M5 test is worth reading. Every existing pdf_copy lab is protected
 * by that assertion.
 *
 * Stubs: config-service (downloadDirectory), routing-service (no auto-
 * print loop), print-controller-store, printService._markCompleted
 * (no OH API call). electron-store is FakeStore-shimmed so imposition-
 * service loads with a controllable, in-memory paperSizes /
 * impositionTemplates dataset.
 *
 * Run via: npm test
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const fs      = require('node:fs');
const fsp     = require('node:fs/promises');
const os      = require('node:os');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── FakeStore shim (before any require that transitively loads electron-store) ──

const __storeData = {};
function FakeStore() {
  return {
    get: (k, d) => (k in __storeData ? __storeData[k] : d),
    set: (k, v) => { __storeData[k] = v; },
    delete: (k) => { delete __storeData[k]; },
    has:  (k) => (k in __storeData),
  };
}
function seedImposition(data) {
  __storeData.paperSizes         = data.paperSizes         || [];
  __storeData.impositionTemplates = data.impositionTemplates || [];
}

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  if (req === 'electron')       return { app: { getPath: () => os.tmpdir() } };
  return __originalRequire.apply(this, arguments);
};

// ── Warning-capturing logger stub — the expectedArtwork-divergence test
// asserts logWarning was called. Every other log method is a no-op.
const __warnings = [];
const fakeLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  logInfo: () => {}, logError: () => {}, logDebug: () => {},
  logWarning: (message, meta = {}) => __warnings.push({ message, meta }),
};
stubInCache(path.join(SVC, 'logger.js'), fakeLogger);

let __downloadDirectory = null;
const fakeConfigService = {
  get: (key) => (key === 'downloadDirectory' ? __downloadDirectory : undefined),
  getProcessMapping:    () => ({}),
  getApiSettings:       () => ({ baseUrl: '', key: '' }),
};

const fakePrintControllerStore = {
  printControllerStore: {
    getController:      () => null,
    findChannelForJob:  () => null,
    getAllControllers:  () => [],
  },
};

const fakeRoutingService = {
  resolveRoute:            () => ({ type: 'unrouted' }),
  resolvePrintSizeCode:    () => '',
  getRoutingHeldProcesses: () => new Set(),
  getControllers:          () => [],
};

stubInCache(path.join(SVC, 'config-service.js'),         fakeConfigService);
stubInCache(path.join(SVC, 'print-controller-store.js'), fakePrintControllerStore);
stubInCache(path.join(SVC, 'routing-service.js'),        fakeRoutingService);

const printService = require(path.join(SVC, 'print-service.js'));

// Spy on _markCompleted so we can assert dispatch reached the end without
// making a real OH API call. jobService.updateJobLocally is a no-op for
// these tests too — imposition failure sets `_status: 'error'` on the job
// via updateJobLocally, but we assert the return-value contract instead.
const __markCompletedCalls = [];
printService._markCompleted = async (jobId) => {
  __markCompletedCalls.push(jobId);
  return undefined;
};
const __jobUpdates = [];
const jobService = require(path.join(SVC, 'job-service.js'));
jobService.updateJobLocally = (id, patch) => { __jobUpdates.push({ id, patch }); };

// ── pdf-lib fixture helpers ─────────────────────────────────────────────

const { PDFDocument, rgb } = require('pdf-lib');

/**
 * Build a PDF whose media (and, if trimBox not supplied, trim) is
 * `mediaW × mediaH` points, with `pages` pages. Every page gets a 1 pt
 * white square so pdf-lib's embedPages doesn't refuse the fixture for
 * missing /Contents (learned in the M2 test suite).
 */
async function makeArtwork({ mediaW, mediaH, pages = 1, trimBox = null }) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([mediaW, mediaH]);
    if (trimBox) p.setTrimBox(trimBox.x, trimBox.y, trimBox.width, trimBox.height);
    p.drawRectangle({ x: 0, y: 0, width: 1, height: 1, color: rgb(1, 1, 1) });
  }
  return Buffer.from(await doc.save());
}

const IN = (v) => v * 72;

/**
 * Lay out a fixture like the ingester would, but with PDF images
 * instead of jpegs. Writes each image to `{jobFolderPath}/originals/`
 * so the resolver picks them up.
 */
async function makeFixture({ orderNumber, orderId, jobId, images }) {
  const downloadRoot   = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dl-'));
  const outputRoot     = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-out-'));
  const orderFolderName = `${orderNumber}_${orderId}`;
  const jobFolderName   = `${orderNumber}_${jobId}`;
  const orderFolderPath = path.join(downloadRoot, orderFolderName);
  const jobFolderPath   = path.join(orderFolderPath, jobFolderName);
  await fsp.mkdir(path.join(jobFolderPath, 'originals'), { recursive: true });

  for (const img of images) {
    await fsp.writeFile(path.join(jobFolderPath, 'originals', img.filename), img.body);
  }
  await fsp.writeFile(
    path.join(orderFolderPath, `${orderNumber}.json`),
    JSON.stringify({
      jobs: [{
        jobId: String(jobId),
        images: images.map(img => ({
          filename:         img.filename,
          quantity:         img.quantity ?? 1,
          originalFilename: img.originalFilename ?? img.filename,
        })),
      }],
    }),
  );
  return { downloadRoot, orderFolderPath, jobFolderPath, outputRoot, jobFolderName };
}

function cleanup(t, ...dirs) {
  t.after(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  });
}

// A common template setup used by matched-path tests: 12×18 in sheet,
// 5×7 in cell → 2×2 = 4-up (locked by M1 hand-computed).
function seedWorked5x7Template(overrides = {}) {
  seedImposition({
    paperSizes: [{
      id: 'ps-12x18', name: '12x18', unit: 'in',
      width:  IN(12),  height: IN(18),
    }],
    impositionTemplates: [{
      id: 'tpl-5x7',
      name: 'Grad card 5x7',
      paperSizeId: 'ps-12x18',
      gutter:      IN(0.25),
      margins:     { top: IN(0.25), right: IN(0.25), bottom: IN(0.25), left: IN(0.25) },
      expectedArtwork: { width: IN(5), height: IN(7) },
      autoRotate:  true,
      artworkBleed: 0,
      cropMarks:    false,
      mode:         'simplex',
      duplexFlipEdge: null,
      productCodes: ['GRAD5X7'],
      outputSubfolder: '',
      ...overrides,
    }],
  });
}

function resetGlobals() {
  __markCompletedCalls.length = 0;
  __jobUpdates.length = 0;
  __warnings.length = 0;
}

// ═════════════════════════════════════════════════════════════════════════
// TEST 1 (FIRST): no-change lock — applyImpositions off writes byte-identical
// output to today's pdf_copy path.
// ═════════════════════════════════════════════════════════════════════════

test('no-change lock: applyImpositions off — output is byte-identical to pre-M5 pdf_copy', async (t) => {
  resetGlobals();
  const pdfA = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const pdfB = await makeArtwork({ mediaW: 400, mediaH: 300 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-NCL',
    orderId:     'ORD-NCL',
    jobId:       501,
    images: [
      { filename: 'a.pdf', body: pdfA, quantity: 1 },
      { filename: 'b.pdf', body: pdfB, quantity: 2 },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 501, order_number: 'PXT-NCL', order_id: 'ORD-NCL', product_code: 'ANY' },
    { outputPath: outputRoot, controllerName: 'PC-Base' },   // NO M5 fields
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method, 'pdf_copy', 'must NOT report pdf_copy_imposition');

  // Pre-M5 folder = `${outputRoot}/${orderNumber}_${jobId}`; filenames
  // are the source basenames, contents are the source bytes.
  const expectedFolder = path.join(outputRoot, jobFolderName);
  assert.ok(fs.existsSync(expectedFolder), 'pre-M5 job subfolder must exist');
  assert.deepEqual(fs.readdirSync(expectedFolder).sort(), ['a.pdf', 'b.pdf']);
  assert.ok(fs.readFileSync(path.join(expectedFolder, 'a.pdf')).equals(pdfA), 'a.pdf bytes must match source');
  assert.ok(fs.readFileSync(path.join(expectedFolder, 'b.pdf')).equals(pdfB), 'b.pdf bytes must match source');
  assert.equal(__markCompletedCalls.length, 1);
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 2: applyImpositions on, no template, unmatchedBehaviour 'root'
// (default) — behaves EXACTLY like the no-change lock (§7.4 "pass-through
// means untouched, not relocated").
// ═════════════════════════════════════════════════════════════════════════

test('unmatched (root): applyImpositions on but no template for product_code → pass-through, byte-identical to today', async (t) => {
  resetGlobals();
  seedWorked5x7Template();  // template exists but claims 'GRAD5X7', not 'UNMATCHED'
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-UR',
    orderId:     'ORD-UR',
    jobId:       601,
    images: [{ filename: 'a.pdf', body: pdfBytes, quantity: 1 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 601, order_number: 'PXT-UR', order_id: 'ORD-UR', product_code: 'UNMATCHED' },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-Root',
      applyImpositions:   true,
      unmatchedBehaviour: 'root',
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method, 'pdf_copy',
    'pass-through must report pdf_copy (not pdf_copy_imposition)');

  const expectedFolder = path.join(outputRoot, jobFolderName);
  assert.ok(fs.existsSync(expectedFolder));
  assert.ok(fs.readFileSync(path.join(expectedFolder, 'a.pdf')).equals(pdfBytes),
    'unmatched-root pass-through must write the source bytes byte-identical');
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 3: applyImpositions on, no template, unmatchedBehaviour
// 'productCodeSubfolder' — same output nested one level deeper under a
// UNSAFE_CHARS-sanitised product-code folder.
// ═════════════════════════════════════════════════════════════════════════

test('unmatched (productCodeSubfolder): output nests under a sanitised product-code folder', async (t) => {
  resetGlobals();
  seedWorked5x7Template();
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-US',
    orderId:     'ORD-US',
    jobId:       602,
    images: [{ filename: 'a.pdf', body: pdfBytes, quantity: 1 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    // product_code carries a Win32-unsafe char (`:`) — must be stripped.
    { id: 602, order_number: 'PXT-US', order_id: 'ORD-US', product_code: 'foo:bar' },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-Sub',
      applyImpositions:   true,
      unmatchedBehaviour: 'productCodeSubfolder',
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // Sanitised: 'foobar' (UNSAFE_CHARS strips ':'). Nested inside outputRoot.
  const expectedFolder = path.join(outputRoot, 'foobar', jobFolderName);
  assert.ok(fs.existsSync(expectedFolder), `nested folder must exist: ${expectedFolder}`);
  assert.ok(fs.readFileSync(path.join(expectedFolder, 'a.pdf')).equals(pdfBytes));
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 4: matched simplex, MULTI-DESIGN (2 PDFs, qty 5 + qty 3, 4-up):
// ONE output PDF, designs sequential, 2 + 1 sheets = 3 pages, filename
// ..._QTY8_IMPQTY3.pdf.
// ═════════════════════════════════════════════════════════════════════════

test('matched simplex multi-design: qty 5 + qty 3 on 4-up → ONE PDF, 3 pages, filename QTY8/IMPQTY3', async (t) => {
  resetGlobals();
  seedWorked5x7Template();
  // Both designs must match the template's cell (5×7 in = 360×504 pt).
  const pdfA = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const pdfB = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-MD',
    orderId:     'ORD-MD',
    jobId:       701,
    images: [
      { filename: 'design_A.pdf', body: pdfA, quantity: 5 },
      { filename: 'design_B.pdf', body: pdfB, quantity: 3 },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 701, order_number: 'PXT-MD', order_id: 'ORD-MD', product_code: 'GRAD5X7' },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-Impose',
      applyImpositions:   true,
      unmatchedBehaviour: 'root',
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method, 'pdf_copy_imposition');
  // Design totals verified by hand:
  //   qty 5 on 4-up = ceil(5/4) = 2 sheets
  //   qty 3 on 4-up = ceil(3/4) = 1 sheet
  //   totalCopies = 5 + 3 = 8
  //   totalSheets = 2 + 1 = 3
  assert.equal(result.totalCopies, 8);
  assert.equal(result.totalSheets, 3);
  assert.equal(result.designs, 2);

  // M8: flat default — jobSubfolder is FALSE unless explicitly true.
  // ONE output file directly at {outputRoot}/{orderNumber}_{jobId}_QTY8_IMPQTY3.pdf.
  const expectedFile = path.join(outputRoot, 'PXT-MD_701_QTY8_IMPQTY3.pdf');
  assert.ok(fs.existsSync(expectedFile), `imposed PDF must exist at ${expectedFile}`);
  // The imposed output is a single press-ready sheet PDF (§7.5); check
  // no accidental job subfolder was created either.
  assert.ok(!fs.existsSync(path.join(outputRoot, jobFolderName)),
    'no per-job subfolder — flat default (M8)');

  // Reopen the imposed PDF and confirm the page count matches totalSheets
  // (simplex: pages = sheets). If the concatenation stage regresses and
  // drops a design, this catches it.
  const reopened = await PDFDocument.load(fs.readFileSync(expectedFile));
  assert.equal(reopened.getPageCount(), 3);

  assert.equal(__markCompletedCalls.length, 1);
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 5: matched duplex — page count = 2 × sheets, filename IMPQTY still
// tracks sheets not pages (§7.5 rule).
// ═════════════════════════════════════════════════════════════════════════

test('matched duplex: qty 5 on 4-up → 2 sheets → 4 pages in the PDF; filename IMPQTY2', async (t) => {
  resetGlobals();
  seedWorked5x7Template({ mode: 'duplex', duplexFlipEdge: 'long' });
  // Duplex template needs a 2-page artwork PDF (front/back).
  const duplexArt = await makeArtwork({ mediaW: 360, mediaH: 504, pages: 2 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-DX',
    orderId:     'ORD-DX',
    jobId:       801,
    images: [{ filename: 'card.pdf', body: duplexArt, quantity: 5 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 801, order_number: 'PXT-DX', order_id: 'ORD-DX', product_code: 'GRAD5X7' },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-Duplex',
      applyImpositions:   true,
      unmatchedBehaviour: 'root',
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.totalSheets, 2);   // 5 on 4-up = 2 sheets
  assert.equal(result.totalCopies, 5);
  // M8 flat default — no per-job subfolder.
  const expectedFile = path.join(outputRoot, 'PXT-DX_801_QTY5_IMPQTY2.pdf');
  assert.ok(fs.existsSync(expectedFile), `duplex imposed PDF must exist at ${expectedFile}`);
  void jobFolderName;

  const reopened = await PDFDocument.load(fs.readFileSync(expectedFile));
  assert.equal(reopened.getPageCount(), 4,
    'duplex: pages = 2 × sheets. If this is 2, back pages were dropped.');
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 6: quantity comes from MANIFEST per-image qty, NOT job.qty.
// Fixture where the two differ — assert IMPQTY reflects the manifest qty.
// ═════════════════════════════════════════════════════════════════════════

test('quantity source: uses manifest per-image quantity, NOT job.quantity (§3.4 rule)', async (t) => {
  resetGlobals();
  seedWorked5x7Template();
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-QT',
    orderId:     'ORD-QT',
    jobId:       901,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 8 }],   // manifest says 8
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    // job.quantity is deliberately WRONG (1) to prove dispatch reads
    // from the manifest per-image qty, not job.quantity. If dispatch
    // regresses to job.qty, sheets would be 1 and filename would be
    // ..._QTY1_IMPQTY1 instead of ..._QTY8_IMPQTY2.
    { id: 901, order_number: 'PXT-QT', order_id: 'ORD-QT', product_code: 'GRAD5X7', qty: 1, quantity: 1 },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-Qty',
      applyImpositions:   true,
      unmatchedBehaviour: 'root',
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.totalCopies, 8);   // manifest qty
  assert.equal(result.totalSheets, 2);   // 8 on 4-up = 2 sheets
  // M8 flat default.
  const expectedFile = path.join(outputRoot, 'PXT-QT_901_QTY8_IMPQTY2.pdf');
  assert.ok(fs.existsSync(expectedFile));
  void jobFolderName;
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 7: zero-fit at dispatch — the job errors and NO output file is
// written (must not silently fall back to raw PDF; §7.4).
// ═════════════════════════════════════════════════════════════════════════

test('zero-fit at dispatch: job errors with the engine\'s message and nothing is written', async (t) => {
  resetGlobals();
  // A template where autoRotate is OFF and the artwork won't fit
  // unrotated. Paper 6×20 pt, cell 8×3 pt (from artwork trim). Rotated
  // would fit but autoRotate is off — engine returns zero-fit.
  seedImposition({
    paperSizes: [{ id: 'ps-tiny', name: 'strip', unit: 'in', width: 6, height: 20 }],
    impositionTemplates: [{
      id: 'tpl-strip', name: 'strip', paperSizeId: 'ps-tiny',
      gutter: 0, margins: { top: 0, right: 0, bottom: 0, left: 0 },
      expectedArtwork: { width: 8, height: 3 },
      autoRotate: false, artworkBleed: 0, cropMarks: false,
      mode: 'simplex', duplexFlipEdge: null,
      productCodes: ['STRIP'], outputSubfolder: '',
    }],
  });
  const pdfBytes = await makeArtwork({ mediaW: 8, mediaH: 3 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-ZF',
    orderId:     'ORD-ZF',
    jobId:       1001,
    images: [{ filename: 'strip.pdf', body: pdfBytes, quantity: 4 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1001, order_number: 'PXT-ZF', order_id: 'ORD-ZF', product_code: 'STRIP' },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-ZF',
      applyImpositions:   true,
      unmatchedBehaviour: 'root',
    },
  );

  assert.equal(result.success, false, 'zero-fit must FAIL the dispatch (never silent success)');
  assert.match(result.error, /0 cells per sheet|does not fit/);
  // No file written under the job folder. The imposition folder may not
  // even exist; if it does, it must be empty.
  const jobDest = path.join(outputRoot, jobFolderName);
  if (fs.existsSync(jobDest)) {
    assert.deepEqual(fs.readdirSync(jobDest), [], 'no imposed PDF may be written on zero-fit');
  }
  // _markCompleted must NOT have been called; jobService.updateJobLocally
  // was called with _status: 'error' (the error posture matches other
  // dispatch failures).
  assert.equal(__markCompletedCalls.length, 0);
  const errored = __jobUpdates.find(u => u.id === 1001 && u.patch && u.patch._status === 'error');
  assert.ok(errored, 'job must be marked error via updateJobLocally');
  assert.match(errored.patch._errorMessage, /Imposition failed for job 1001/);
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 8: expectedArtwork divergence — dispatch SUCCEEDS but logWarning
// fires with both sizes named. Layout used the REAL trim so the output
// is correct; the warn tells the lab their template's design assumption
// drifted.
// ═════════════════════════════════════════════════════════════════════════

test('expectedArtwork divergence: real trim differs > 0.5 pt — logWarning fired, dispatch succeeds', async (t) => {
  resetGlobals();
  seedWorked5x7Template();   // expectedArtwork = 5×7 in = 360×504 pt
  // Artwork trim is 361 × 505 — 1 pt bigger each dimension. > 0.5 pt in
  // both. Layout runs on the real trim, so 2×2 still fits with a slightly
  // smaller effective margin — no zero-fit. Dispatch succeeds; WARN fires.
  const pdfBytes = await makeArtwork({ mediaW: 361, mediaH: 505 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-DIV',
    orderId:     'ORD-DIV',
    jobId:       1101,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 4 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1101, order_number: 'PXT-DIV', order_id: 'ORD-DIV', product_code: 'GRAD5X7' },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-Div',
      applyImpositions:   true,
      unmatchedBehaviour: 'root',
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.expectedArtworkWarn, true, 'divergence flag must be set on the result');
  // M8 flat default.
  const expectedFile = path.join(outputRoot, 'PXT-DIV_1101_QTY4_IMPQTY1.pdf');
  assert.ok(fs.existsSync(expectedFile), 'output must still be written — divergence is a WARN, not a FAIL');
  void jobFolderName;

  // The captured warning must name both the real trim and the template's
  // expected size so the lab can see what drifted.
  const divergenceWarn = __warnings.find(w =>
    typeof w.message === 'string' && /differs from template/.test(w.message));
  assert.ok(divergenceWarn, 'expected a logWarning about expectedArtwork divergence');
  assert.match(divergenceWarn.message, /361\.00 × 505\.00 pt/);
  assert.match(divergenceWarn.message, /expectedArtwork 360 × 504 pt/);
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 9: template.outputSubfolder wraps the imposed output — §7.4/§7.5.
// ═════════════════════════════════════════════════════════════════════════

test('template.outputSubfolder: imposed output nests one level deeper', async (t) => {
  resetGlobals();
  seedWorked5x7Template({ outputSubfolder: 'imposed' });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-OS',
    orderId:     'ORD-OS',
    jobId:       1201,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 4 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1201, order_number: 'PXT-OS', order_id: 'ORD-OS', product_code: 'GRAD5X7' },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-OS',
      applyImpositions:   true,
      unmatchedBehaviour: 'root',
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // M8 flat default: nested one level deeper under 'imposed', but no
  // per-job subfolder underneath.
  const expectedFile = path.join(outputRoot, 'imposed', 'PXT-OS_1201_QTY4_IMPQTY1.pdf');
  assert.ok(fs.existsSync(expectedFile), `subfolder-wrapped file must exist at ${expectedFile}`);
  void jobFolderName;
});

// ═════════════════════════════════════════════════════════════════════════
// TEST 10 (M7): fillLastSheet on — filename semantics UNCHANGED. QTY
// stays the ordered qty, IMPQTY stays the sheet count; only the empty
// cells on the last sheet stop existing.
// ═════════════════════════════════════════════════════════════════════════

test('M7 fillLastSheet on: qty 10 on 4-up → filename still _QTY10_IMPQTY3 (fill removes blanks, never changes QTY or IMPQTY)', async (t) => {
  resetGlobals();
  seedWorked5x7Template({ fillLastSheet: true });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-FLS',
    orderId:     'ORD-FLS',
    jobId:       1301,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 10 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1301, order_number: 'PXT-FLS', order_id: 'ORD-FLS', product_code: 'GRAD5X7' },
    {
      outputPath:         outputRoot,
      controllerName:     'PC-Fill',
      applyImpositions:   true,
      unmatchedBehaviour: 'root',
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // The whole M7 filename contract in one line: QTY tracks the customer's
  // ordered quantity (10), IMPQTY tracks the sheet count (ceil(10/4)=3).
  // Neither changes when the last sheet is filled — filling replaces
  // blanks with overs, not sheets with sheets.
  assert.equal(result.totalCopies, 10);
  assert.equal(result.totalSheets, 3);
  // M8 flat default.
  const expectedFile = path.join(outputRoot, 'PXT-FLS_1301_QTY10_IMPQTY3.pdf');
  assert.ok(fs.existsSync(expectedFile), `filename must NOT change with fill on: expected ${expectedFile}`);
  const reopened = await PDFDocument.load(fs.readFileSync(expectedFile));
  assert.equal(reopened.getPageCount(), 3, 'simplex sheet count unchanged by fill');
  void jobFolderName;
});

// ═════════════════════════════════════════════════════════════════════════
// M8: output destination + filename templates
// ═════════════════════════════════════════════════════════════════════════

test('M8 default-path lock: all M8 fields blank/false → destination is the CONTROLLER outputPath, flat (no job subfolder), M7 filename', async (t) => {
  // The exact M8 default shape: baseDest = controller.outputPath (no
  // template override); no outputSubfolder; jobSubfolder OFF (the new
  // default); default M7 convention filename. This locks the "byte-
  // identical to M7 EXCEPT no job subfolder" invariant Richard called.
  resetGlobals();
  seedWorked5x7Template();  // no M8 fields set on fixture
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-M8D',
    orderId:     'ORD-M8D',
    jobId:       1401,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 4 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1401, order_number: 'PXT-M8D', order_id: 'ORD-M8D', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M8D', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  const expectedFile = path.join(outputRoot, 'PXT-M8D_1401_QTY4_IMPQTY1.pdf');
  assert.ok(fs.existsSync(expectedFile), `flat default: file must exist at ${expectedFile}`);
  // No per-job subfolder created — the flat default's whole point.
  assert.ok(!fs.existsSync(path.join(outputRoot, jobFolderName)),
    'no per-job subfolder in the M8 default shape');
  // outputRoot contains ONLY the imposed file (plus nothing).
  assert.deepEqual(fs.readdirSync(outputRoot), ['PXT-M8D_1401_QTY4_IMPQTY1.pdf']);
});

test('M8 jobSubfolder=true: opt-in restores the pre-M8 per-job subfolder shape', async (t) => {
  resetGlobals();
  seedWorked5x7Template({ jobSubfolder: true });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-M8J',
    orderId:     'ORD-M8J',
    jobId:       1402,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 4 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1402, order_number: 'PXT-M8J', order_id: 'ORD-M8J', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M8J', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  const expectedFile = path.join(outputRoot, jobFolderName, 'PXT-M8J_1402_QTY4_IMPQTY1.pdf');
  assert.ok(fs.existsSync(expectedFile), `jobSubfolder true → nested under ${jobFolderName}`);
});

test('M8 template.outputPath override: absolute path replaces the controller outputPath', async (t) => {
  resetGlobals();
  // outputPath must be absolute — makeFixture returns an absolute tmp
  // dir, so we can reuse it as the override target.
  const overrideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-m8ov-'));
  seedWorked5x7Template({ outputPath: overrideDir });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M8O',
    orderId:     'ORD-M8O',
    jobId:       1403,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 4 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot, overrideDir);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1403, order_number: 'PXT-M8O', order_id: 'ORD-M8O', product_code: 'GRAD5X7' },
    // controller outputPath deliberately different — the override wins.
    { outputPath: outputRoot, controllerName: 'PC-M8O', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  const expectedFile = path.join(overrideDir, 'PXT-M8O_1403_QTY4_IMPQTY1.pdf');
  assert.ok(fs.existsSync(expectedFile), `template outputPath override: file at ${expectedFile}`);
  // Controller outputPath must NOT have received the imposed file — the
  // whole point of the override is that press hot folders can live
  // anywhere, not under the controller root.
  assert.equal(fs.readdirSync(outputRoot).length, 0,
    'no imposed output under the controller outputPath when the template overrides it');
});

test('M8 custom filenameTemplate: tokens resolve, sanitised, .pdf appended once', async (t) => {
  resetGlobals();
  seedWorked5x7Template({ filenameTemplate: '{orderNumber}-{qty}of{impQty}' });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M8F',
    orderId:     'ORD-M8F',
    jobId:       1404,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 10 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1404, order_number: 'PXT-M8F', order_id: 'ORD-M8F', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M8F', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // qty=10 on 4-up = 3 sheets → filename resolves to "PXT-M8F-10of3.pdf".
  const expectedFile = path.join(outputRoot, 'PXT-M8F-10of3.pdf');
  assert.ok(fs.existsSync(expectedFile), `custom filename: file at ${expectedFile}`);
});

test('M8 empty resolution at dispatch: filenameTemplate that resolves to empty falls back to the default convention + logWarning', async (t) => {
  resetGlobals();
  // {product} is present in the shared token set but blank on this job
  // — dispatch below sends no product field. Sanitisation strips the
  // hyphen-only remainder to empty; fallback kicks in with a WARN. The
  // template still passes save-time validation (it contains
  // {orderNumber}... wait, that would make sanitisation non-empty).
  //
  // For a test-controlled empty resolution we use {product} + {options}
  // (both blank on the job) AND — since the save-time distinguishing-
  // token rule would reject this template — we seed the template
  // DIRECTLY into the store bypassing the validator. That's honest:
  // this test covers the dispatch fallback behaviour for a template
  // that somehow reached dispatch with no distinguishing content
  // (hand-edited JSON, future refactor gap).
  seedImposition({
    paperSizes: [{ id: 'ps-12x18', name: '12x18', unit: 'in', width: IN(12), height: IN(18) }],
    impositionTemplates: [{
      id: 'tpl-empty',
      name: 'Empty-resolve',
      paperSizeId: 'ps-12x18',
      gutter: IN(0.25),
      margins: { top: IN(0.25), right: IN(0.25), bottom: IN(0.25), left: IN(0.25) },
      expectedArtwork: { width: IN(5), height: IN(7) },
      autoRotate: true, artworkBleed: 0, cropMarks: false,
      fillLastSheet: true,
      mode: 'simplex', duplexFlipEdge: null,
      productCodes: ['EMPTY'],
      // Contains {jobId} to bypass validator, but leading only-punctuation
      // stripped by sanitisation. Actually: since we bypass validation,
      // use a template that truly sanitises to empty — {product} alone
      // on a job with no product field.
      filenameTemplate: '{product}',
      outputSubfolder: '',
    }],
  });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M8E',
    orderId:     'ORD-M8E',
    jobId:       1405,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 4 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    // No product field on the job → {product} resolves to '' → empty.
    { id: 1405, order_number: 'PXT-M8E', order_id: 'ORD-M8E', product_code: 'EMPTY' },
    { outputPath: outputRoot, controllerName: 'PC-M8E', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // Fallback = M7 default convention.
  const expectedFile = path.join(outputRoot, 'PXT-M8E_1405_QTY4_IMPQTY1.pdf');
  assert.ok(fs.existsSync(expectedFile), `empty-resolution fallback: file at ${expectedFile}`);
  // WARN fired naming the falling-back template.
  const warn = __warnings.find(w =>
    typeof w.message === 'string' && /resolved to empty/.test(w.message) && /\{product\}/.test(w.message));
  assert.ok(warn, 'expected a logWarning about empty resolution');
});

test('M8 filenameTemplate {qty}/{impQty} — multi-design totals (cross-design sums per §7.5)', async (t) => {
  resetGlobals();
  seedWorked5x7Template({ filenameTemplate: '{orderNumber}-J{jobId}-total{qty}-sheets{impQty}' });
  const pdfA = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const pdfB = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M8Q',
    orderId:     'ORD-M8Q',
    jobId:       1406,
    images: [
      { filename: 'design_A.pdf', body: pdfA, quantity: 5 },
      { filename: 'design_B.pdf', body: pdfB, quantity: 3 },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1406, order_number: 'PXT-M8Q', order_id: 'ORD-M8Q', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M8Q', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // Cross-design totals: 5+3=8 copies; 2+1=3 sheets.
  const expectedFile = path.join(outputRoot, 'PXT-M8Q-J1406-total8-sheets3.pdf');
  assert.ok(fs.existsSync(expectedFile), `cross-design totals: file at ${expectedFile}`);
});

// ═════════════════════════════════════════════════════════════════════════
// M9: outputSheets 'all' vs 'master' — proof-then-multiply workflow
// ═════════════════════════════════════════════════════════════════════════

test('M9 outputSheets="all" (default) byte-identical to M8 — the lock', async (t) => {
  // The pre-M9 shape: full document, page count = sheets, filename QTY/IMPQTY
  // report the RUN totals. All existing dispatch tests above run without
  // setting outputSheets and already prove this; this test locks it
  // EXPLICITLY with outputSheets: 'all' set so a refactor that shifts
  // the default away from 'all' fails here rather than in every M4-M8 test.
  resetGlobals();
  seedWorked5x7Template({ outputSheets: 'all' });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M9A',
    orderId:     'ORD-M9A',
    jobId:       1501,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 10 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1501, order_number: 'PXT-M9A', order_id: 'ORD-M9A', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M9A', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.notEqual(result.outputSheets, 'master', 'all mode must NOT report master');
  // Same filename shape as M7 default (default fillLastSheet=true → last
  // sheet filled to 12, but IMPQTY still tracks ordered/perSheet=3).
  const expectedFile = path.join(outputRoot, 'PXT-M9A_1501_QTY10_IMPQTY3.pdf');
  assert.ok(fs.existsSync(expectedFile), `all-mode file at ${expectedFile}`);
  const reopened = await PDFDocument.load(fs.readFileSync(expectedFile));
  assert.equal(reopened.getPageCount(), 3, 'all mode: pages = sheets (simplex)');
});

test('M9 master simplex qty 10 on 4-up: ONE file, ONE page, filename _QTY10_IMPQTY3', async (t) => {
  // Master mode: file contains ONE fully-filled sheet. IMPQTY=3 is
  // the run length the operator sets on the press; QTY=10 is what
  // the customer ordered.
  resetGlobals();
  seedWorked5x7Template({ outputSheets: 'master' });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M9M',
    orderId:     'ORD-M9M',
    jobId:       1502,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 10 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1502, order_number: 'PXT-M9M', order_id: 'ORD-M9M', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M9M', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.outputSheets, 'master');
  // Single-design master gets NO _D suffix.
  const expectedFile = path.join(outputRoot, 'PXT-M9M_1502_QTY10_IMPQTY3.pdf');
  assert.ok(fs.existsSync(expectedFile), `master file at ${expectedFile}`);
  const reopened = await PDFDocument.load(fs.readFileSync(expectedFile));
  assert.equal(reopened.getPageCount(), 1,
    'master simplex: ONE page (the master sheet). The press copy count multiplies it.');
});

test('M9 master duplex: TWO pages (that sheet\'s front + its mirrored back)', async (t) => {
  // Duplex master = one physical sheet = 2 output pages. The mirror
  // pairing is enforced by the shared layout+planPlacements+composer
  // chain (locked by the M1a asymmetric-margin tests and the M2
  // duplex mirror tests). Structural assertion here: 2 pages
  // exactly, each with the sheet's MediaBox.
  resetGlobals();
  seedWorked5x7Template({ outputSheets: 'master', mode: 'duplex', duplexFlipEdge: 'long' });
  const duplexArt = await makeArtwork({ mediaW: 360, mediaH: 504, pages: 2 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M9D',
    orderId:     'ORD-M9D',
    jobId:       1503,
    images: [{ filename: 'card.pdf', body: duplexArt, quantity: 10 }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1503, order_number: 'PXT-M9D', order_id: 'ORD-M9D', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M9D', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  const expectedFile = path.join(outputRoot, 'PXT-M9D_1503_QTY10_IMPQTY3.pdf');
  assert.ok(fs.existsSync(expectedFile), `duplex master at ${expectedFile}`);
  const reopened = await PDFDocument.load(fs.readFileSync(expectedFile));
  assert.equal(reopened.getPageCount(), 2, 'duplex master: 2 pages (front + mirrored back)');
  // MediaBox on both pages equals the sheet size.
  for (let i = 0; i < 2; i++) {
    const media = reopened.getPage(i).getMediaBox();
    assert.equal(media.width,  864);
    assert.equal(media.height, 1296);
  }
});

test('M9 master IGNORES fillLastSheet=false: the sheet is still fully placed', async (t) => {
  // Master mode can't represent a partial sheet — the whole "run
  // IMPQTY copies" workflow assumes each copy is identical to the
  // proof. fillLastSheet=false on the template is deliberately
  // ignored in master mode. Structural check: 1-page output that
  // reopens cleanly (a partial-sheet regression would either drop
  // pages or write garbage that fails to reopen).
  resetGlobals();
  seedWorked5x7Template({ outputSheets: 'master', fillLastSheet: false });
  const pdfBytes = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M9F',
    orderId:     'ORD-M9F',
    jobId:       1504,
    images: [{ filename: 'card.pdf', body: pdfBytes, quantity: 2 }],  // partial in 'all' mode
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1504, order_number: 'PXT-M9F', order_id: 'ORD-M9F', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M9F', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // qty=2 on 4-up: ceil(2/4)=1 sheet. Filename QTY2/IMPQTY1.
  const expectedFile = path.join(outputRoot, 'PXT-M9F_1504_QTY2_IMPQTY1.pdf');
  assert.ok(fs.existsSync(expectedFile), `master ignoring fill: file at ${expectedFile}`);
  const reopened = await PDFDocument.load(fs.readFileSync(expectedFile));
  assert.equal(reopened.getPageCount(), 1, 'master: still exactly 1 sheet');
});

test('M9 master multi-design (qty 5 + qty 3 on 4-up): TWO files with _D1 / _D2 suffixes, per-design QTY/IMPQTY', async (t) => {
  // The multi-design payoff: one file per design, each with the
  // design's own totals. Operator runs D1 sheet 2 times, D2 sheet 1
  // time — that's proof-then-multiply per design.
  resetGlobals();
  seedWorked5x7Template({ outputSheets: 'master' });
  const pdfA = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const pdfB = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M9X',
    orderId:     'ORD-M9X',
    jobId:       1505,
    images: [
      { filename: 'design_A.pdf', body: pdfA, quantity: 5 },
      { filename: 'design_B.pdf', body: pdfB, quantity: 3 },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1505, order_number: 'PXT-M9X', order_id: 'ORD-M9X', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M9X', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  const fileD1 = path.join(outputRoot, 'PXT-M9X_1505_QTY5_IMPQTY2_D1.pdf');
  const fileD2 = path.join(outputRoot, 'PXT-M9X_1505_QTY3_IMPQTY1_D2.pdf');
  assert.ok(fs.existsSync(fileD1), `design A master at ${fileD1}`);
  assert.ok(fs.existsSync(fileD2), `design B master at ${fileD2}`);
  // The dispatch result carries the full list.
  assert.equal(result.destFiles.length, 2);
  assert.equal(result.destFiles[0].filename, 'PXT-M9X_1505_QTY5_IMPQTY2_D1.pdf');
  assert.equal(result.destFiles[1].filename, 'PXT-M9X_1505_QTY3_IMPQTY1_D2.pdf');
  // Both are single-sheet simplex.
  for (const f of [fileD1, fileD2]) {
    const doc = await PDFDocument.load(fs.readFileSync(f));
    assert.equal(doc.getPageCount(), 1, `${path.basename(f)}: one full sheet`);
  }
});

test('M9 master custom filenameTemplate: {qty}/{impQty} are the PER-DESIGN totals', async (t) => {
  // In master multi-design mode, {qty} and {impQty} in the custom
  // template resolve to the per-design values, NOT the cross-design
  // sums. The operator needs "5 copies on 2 sheets" per file, not
  // "8 copies on 3 sheets" for D1.
  resetGlobals();
  seedWorked5x7Template({
    outputSheets:     'master',
    filenameTemplate: '{orderNumber}-J{jobId}-qty{qty}-runs{impQty}',
  });
  const pdfA = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const pdfB = await makeArtwork({ mediaW: 360, mediaH: 504 });
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-M9C',
    orderId:     'ORD-M9C',
    jobId:       1506,
    images: [
      { filename: 'design_A.pdf', body: pdfA, quantity: 5 },
      { filename: 'design_B.pdf', body: pdfB, quantity: 3 },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaPdfCopyRouted(
    { id: 1506, order_number: 'PXT-M9C', order_id: 'ORD-M9C', product_code: 'GRAD5X7' },
    { outputPath: outputRoot, controllerName: 'PC-M9C', applyImpositions: true, unmatchedBehaviour: 'root' },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // D1: qty 5, runs 2. D2: qty 3, runs 1.
  const fileD1 = path.join(outputRoot, 'PXT-M9C-J1506-qty5-runs2_D1.pdf');
  const fileD2 = path.join(outputRoot, 'PXT-M9C-J1506-qty3-runs1_D2.pdf');
  assert.ok(fs.existsSync(fileD1), `D1 custom filename at ${fileD1}`);
  assert.ok(fs.existsSync(fileD2), `D2 custom filename at ${fileD2}`);
});
