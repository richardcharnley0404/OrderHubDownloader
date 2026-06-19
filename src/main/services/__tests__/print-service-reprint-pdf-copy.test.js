'use strict';

/**
 * Integration tests for _sendReprintViaPdfCopy (Phase 3b).
 *
 * Mirrors the print-service-reprint-fujijobmaker.test.js harness —
 * stubs routing-service, the pdf-pipeline applyPdfPipeline helper, the
 * legacy print-controller-store, and config-service, then exercises
 * sendReprint end-to-end so the test also pins the dispatch arm and
 * the route-field plumbing.
 *
 * Pins:
 *   - Routing-service-only setup succeeds (no legacy-store dependencies).
 *   - Reprint suffix lands in the destination folder name (…_{id}-r{n}/).
 *   - Sidecar's .pdf entries flow into the dispatch (non-PDF entries filtered).
 *   - jobContext (jobNumber/orderId/qty/customerName) sourced from parentJob.
 *   - Three branches: pipeline configured → applyPdfPipeline runs; no
 *     pipeline but bannerSheet true → _prependBannerPageToPdf runs;
 *     neither → plain copy.
 *   - Route validation guard rejects missing outputPath cleanly.
 *   - _markCompleted NOT called (reprint stays invisible to parent
 *     lifecycle).
 *
 * Run via:  npm test
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
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ── Capture state ────────────────────────────────────────────────────────────

const __pipelineCalls         = []; // applyPdfPipeline args
const __markCompletedCalls    = [];
let   __routeForReturn        = null;
let   __pipelineReturn        = null;  // override applyPdfPipeline return bytes

function resetCaptures() {
  __pipelineCalls.length      = 0;
  __markCompletedCalls.length = 0;
  __routeForReturn            = null;
  __pipelineReturn            = null;
}

// ── Stubs (require.cache injection) ──────────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const fakeConfigService = {
  get:                  () => undefined,
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
  resolveRoute:         () => __routeForReturn,
  resolvePrintSizeCode: () => '',
  getRoutingHeldProcesses: () => new Set(),
  getControllers:       () => [],
};

const fakePipelineModule = {
  applyPdfPipeline: async (bytes, pipelineConfig, jobContext) => {
    __pipelineCalls.push({ bytes, pipelineConfig, jobContext });
    return __pipelineReturn || new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
  },
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'),         fakeConfigService);
stubInCache(path.join(SVC, 'print-controller-store.js'), fakePrintControllerStore);
stubInCache(path.join(SVC, 'routing-service.js'),        fakeRoutingService);
stubInCache(path.join(ROOT, 'src', 'pdf-pipeline', 'pipeline.js'), fakePipelineModule);

const printService = require(path.join(SVC, 'print-service.js'));

// Spy on _markCompleted so the negative assertion bites if the reprint path
// accidentally advances parent lifecycle.
const origMarkCompleted = printService._markCompleted;
printService._markCompleted = async (jobId) => {
  __markCompletedCalls.push(jobId);
  return origMarkCompleted ? origMarkCompleted.call(printService, jobId) : undefined;
};

// Stub _prependBannerPageToPdf so the banner branch can be exercised without
// dragging pdf-lib + qrcode + sharp. Returns a marker buffer so tests can
// distinguish "banner ran" from "plain copy" output bytes.
let __bannerThrowOnce = false;
printService._prependBannerPageToPdf = async (pdfPath, job) => {
  if (__bannerThrowOnce) { __bannerThrowOnce = false; throw new Error('banner-failed'); }
  return Buffer.from(`banner+${path.basename(pdfPath)}+${job.id}`);
};

// ── Helpers ─────────────────────────────────────────────────────────────────

async function makeReprintFolder() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pdf-rp-'));
  // The reprint folder name itself drives the destination subfolder.
  const reprintFolder = path.join(root, 'PXTEST-PDF_77001-r1');
  await fsp.mkdir(path.join(reprintFolder, 'originals'), { recursive: true });
  await fsp.mkdir(path.join(reprintFolder, 'working'),   { recursive: true });
  await fsp.writeFile(path.join(reprintFolder, 'originals', 'a.pdf'), 'pdf-bytes-a');
  await fsp.writeFile(path.join(reprintFolder, 'originals', 'b.pdf'), 'pdf-bytes-b');
  return { root, reprintFolder };
}

async function makeHotFolder() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pdf-hot-'));
}

const PARENT = {
  id:             77001,
  job_name:       'PXTEST-PDF-1',
  order_number:   'PXTEST-PDF',
  order_id:       'ord-pdf-9',
  product_code:   'WIDEFORMAT-PDF',
  process:        'Wide Format',
  options:        [],
  customer_name:  'PDF Customer',
  qty:            3,
};

function pdfRoute(outputPath, overrides = {}) {
  return {
    type:           'controller',
    controllerType: 'pdf_copy',
    controllerId:   'CTRL-PDF-1',
    controllerName: 'WideFormat PDF',
    outputPath,
    pdfPipeline:    null,
    bannerSheet:    false,
    checkOrderStatus: false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('PDF reprint: dispatch via sendReprint with routing-service-only setup succeeds', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot);

  const result = await printService.sendReprint(
    PARENT,
    reprintFolder,
    'r1',
    [{ filename: 'a.pdf', qtyCurrent: 1 }],
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method, 'pdf_copy-reprint');
});

test('PDF reprint: destination folder is {outputPath}/{reprint-folder-basename}', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot);

  const result = await printService.sendReprint(PARENT, reprintFolder, 'r1', [{ filename: 'a.pdf', qtyCurrent: 1 }]);

  // Destination must include the …-r1 suffix from the reprint folder name,
  // distinct from the parent's …_{id} folder.
  const expectedDest = path.join(hot, 'PXTEST-PDF_77001-r1');
  assert.equal(result.destPath, expectedDest);
  assert.ok(fs.existsSync(expectedDest), 'destination folder created');
  assert.ok(fs.existsSync(path.join(expectedDest, 'a.pdf')), 'PDF landed in destination folder');
});

test('PDF reprint: only sidecar .pdf entries are dispatched; non-PDF entries are filtered out', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot);

  // Sidecar contains one PDF and one JPEG. Only the PDF should be copied.
  await fsp.writeFile(path.join(reprintFolder, 'originals', 'noise.jpg'), 'jpg-noise');
  const result = await printService.sendReprint(PARENT, reprintFolder, 'r1', [
    { filename: 'a.pdf',     qtyCurrent: 1 },
    { filename: 'noise.jpg', qtyCurrent: 1 },
  ]);

  assert.equal(result.success, true);
  assert.ok(fs.existsSync(path.join(result.destPath, 'a.pdf')));
  assert.equal(fs.existsSync(path.join(result.destPath, 'noise.jpg')), false,
    'non-PDF sidecar entry must NOT be copied');
});

test('PDF reprint: pipeline configured → applyPdfPipeline runs with jobContext sourced from parentJob', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot, { pdfPipeline: { steps: [{ type: 'banner', config: {} }] } });
  __pipelineReturn = new Uint8Array(Buffer.from('pipeline-output'));

  await printService.sendReprint(PARENT, reprintFolder, 'r1', [{ filename: 'a.pdf', qtyCurrent: 1 }]);

  assert.equal(__pipelineCalls.length, 1, 'applyPdfPipeline invoked');
  const ctx = __pipelineCalls[0].jobContext;
  assert.equal(ctx.jobNumber,    'PXTEST-PDF-1',    'jobNumber from parentJob.job_name');
  assert.equal(ctx.orderId,      'ord-pdf-9',       'orderId from parentJob.order_id (string-coerced)');
  assert.equal(ctx.qty,          3,                 'qty from parentJob.qty');
  assert.equal(ctx.customerName, 'PDF Customer',    'customerName from parentJob.customer_name');

  // Pipeline output bytes land in the destination file.
  const written = await fsp.readFile(path.join(hot, 'PXTEST-PDF_77001-r1', 'a.pdf'));
  assert.equal(written.toString(), 'pipeline-output');
});

test('PDF reprint: no pipeline + bannerSheet:true → _prependBannerPageToPdf runs with parentJob', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot, { bannerSheet: true });

  await printService.sendReprint(PARENT, reprintFolder, 'r1', [{ filename: 'a.pdf', qtyCurrent: 1 }]);

  assert.equal(__pipelineCalls.length, 0, 'no pipeline → applyPdfPipeline NOT called');
  // Banner stub returns `banner+{basename}+{job.id}` so we can prove it ran
  // against the parentJob (not a synthesised reprint-job).
  const written = await fsp.readFile(path.join(hot, 'PXTEST-PDF_77001-r1', 'a.pdf'));
  assert.equal(written.toString(), 'banner+a.pdf+77001',
    'banner ran with parentJob — id matches and basename preserved');
});

test('PDF reprint: banner failure falls back to plain copy (not an error)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot, { bannerSheet: true });
  __bannerThrowOnce = true;

  const result = await printService.sendReprint(PARENT, reprintFolder, 'r1', [{ filename: 'a.pdf', qtyCurrent: 1 }]);

  assert.equal(result.success, true, 'banner failure must NOT fail the dispatch');
  const written = await fsp.readFile(path.join(hot, 'PXTEST-PDF_77001-r1', 'a.pdf'));
  assert.equal(written.toString(), 'pdf-bytes-a', 'falls back to plain copy of original PDF bytes');
});

test('PDF reprint: no pipeline + no bannerSheet → plain copy (verbatim source bytes)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot);

  await printService.sendReprint(PARENT, reprintFolder, 'r1', [
    { filename: 'a.pdf', qtyCurrent: 1 },
    { filename: 'b.pdf', qtyCurrent: 1 },
  ]);

  assert.equal(__pipelineCalls.length, 0);
  const writtenA = await fsp.readFile(path.join(hot, 'PXTEST-PDF_77001-r1', 'a.pdf'));
  const writtenB = await fsp.readFile(path.join(hot, 'PXTEST-PDF_77001-r1', 'b.pdf'));
  assert.equal(writtenA.toString(), 'pdf-bytes-a');
  assert.equal(writtenB.toString(), 'pdf-bytes-b');
});

// ── Negative assertion — parent lifecycle untouched ─────────────────────────

test('PDF reprint: NEVER calls _markCompleted (parent lifecycle untouched)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot);

  await printService.sendReprint(PARENT, reprintFolder, 'r1', [{ filename: 'a.pdf', qtyCurrent: 1 }]);

  assert.equal(__markCompletedCalls.length, 0,
    'reprint must not advance parent to completed — that\'s the normal-send path\'s job');
});

// ── Route validation guard ──────────────────────────────────────────────────

test('PDF reprint: route missing outputPath → success:false (descriptive error)', async (t) => {
  resetCaptures();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  __routeForReturn = pdfRoute('');

  const result = await printService.sendReprint(PARENT, reprintFolder, 'r1', [{ filename: 'a.pdf', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /outputPath/);
  assert.match(result.error, /Settings → Routing/);
});

// ── Sidecar edge cases ──────────────────────────────────────────────────────

test('PDF reprint: empty reprintImages → success:false (no images to send)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot);

  const result = await printService.sendReprint(PARENT, reprintFolder, 'r1', []);

  assert.equal(result.success, false);
  assert.match(result.error, /no images/i);
});

test('PDF reprint: sidecar with no .pdf entries → success:false (filtered to zero)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot);

  // Only JPEGs in the sidecar — none should reach a pdf_copy controller.
  await fsp.writeFile(path.join(reprintFolder, 'originals', 'x.jpg'), 'jpg');
  const result = await printService.sendReprint(PARENT, reprintFolder, 'r1', [
    { filename: 'x.jpg', qtyCurrent: 1 },
  ]);

  assert.equal(result.success, false);
  assert.match(result.error, /no PDF files/);
});

test('PDF reprint: PDF missing on disk → success:false naming the missing path', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const { root, reprintFolder } = await makeReprintFolder();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = pdfRoute(hot);

  const result = await printService.sendReprint(PARENT, reprintFolder, 'r1', [
    { filename: 'never-exists.pdf', qtyCurrent: 1 },
  ]);

  assert.equal(result.success, false);
  assert.match(result.error, /Reprint PDF not found/);
  assert.match(result.error, /never-exists\.pdf/);
});
