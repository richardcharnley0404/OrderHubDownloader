'use strict';

/**
 * Integration tests for _sendReprintViaFrontline (Phase 3c).
 *
 * Mirrors the Fuji / PDF reprint test harness — stubs routing-service,
 * frontline-generator, frontline-file-writer, config-service, and the
 * legacy print-controller-store, then exercises sendReprint end-to-end
 * so the test also pins the dispatch arm + the route-field plumbing.
 *
 * Pins:
 *   - Routing-service-only setup succeeds.
 *   - Reprint-suffixed jobId appears in BOTH the XML's customerID
 *     (via the generator input) AND the writer's folder/filename
 *     (`{outputPath}/{id}-r{n}/{id}-r{n}.xml`).
 *   - Reprint-suffixed job_name flows through (operator-facing log lines
 *     + backPrint placeholders).
 *   - Sidecar images + qtyCurrent flow into the generator input.
 *   - Route fields (outputPath/device/backPrint1/backPrint2/batchCode/
 *     sortString) reach controllerConfig + channelConfig + writer.
 *   - Route validation guard rejects malformed routes cleanly.
 *   - _markCompleted NOT called.
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

// ── Capture state ────────────────────────────────────────────────────────────

const __generateCalls       = []; // frontlineGenerator.generate args
const __writeCalls          = []; // frontlineFileWriter.writeJobFolder args
const __markCompletedCalls  = [];
let   __routeForReturn      = null;

function resetCaptures() {
  __generateCalls.length      = 0;
  __writeCalls.length         = 0;
  __markCompletedCalls.length = 0;
  __routeForReturn            = null;
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

const fakeFrontlineGenerator = {
  frontlineGenerator: {
    generate: (controllerConfig, channelConfig, frontlineJob) => {
      __generateCalls.push({ controllerConfig, channelConfig, frontlineJob });
      // Marker XML so writer-arg assertions can confirm pass-through.
      return `<?xml version="1.0"?><Order customerID="${frontlineJob.id}"/>`;
    },
  },
};

const fakeFrontlineWriter = {
  frontlineFileWriter: {
    writeJobFolder: async (outputPath, jobId, xmlContent, imageFiles) => {
      __writeCalls.push({ outputPath, jobId, xmlContent, imageFiles });
      const jobFolderPath = path.join(outputPath, String(jobId));
      // Honour the existence-check the real writer does so the test
      // doesn't silently mask an outputPath misroute.
      if (!fs.existsSync(outputPath)) {
        throw new Error(`Frontline hot folder does not exist: ${outputPath}`);
      }
      await fsp.mkdir(jobFolderPath, { recursive: true });
      const xmlPath = path.join(jobFolderPath, `${jobId}.xml`);
      await fsp.writeFile(xmlPath, xmlContent, 'utf-8');
      for (const img of imageFiles) {
        await fsp.copyFile(img.sourcePath, path.join(jobFolderPath, img.filename));
      }
      return { jobFolderPath, xmlPath };
    },
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
stubInCache(path.join(SVC, 'frontline-generator.js'),    fakeFrontlineGenerator);
stubInCache(path.join(SVC, 'frontline-file-writer.js'),  fakeFrontlineWriter);

const printService = require(path.join(SVC, 'print-service.js'));

// Sidestep sharp — corrections aren't the unit under test here.
printService._applyCorrectionsToImageFiles = async (imageFiles) => imageFiles;

// Spy on _markCompleted so the negative assertion bites if the reprint
// path accidentally advances parent lifecycle.
const origMarkCompleted = printService._markCompleted;
printService._markCompleted = async (jobId) => {
  __markCompletedCalls.push(jobId);
  return origMarkCompleted ? origMarkCompleted.call(printService, jobId) : undefined;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

async function makeReprintFolder() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-front-rp-'));
  await fsp.mkdir(path.join(root, 'originals'), { recursive: true });
  await fsp.mkdir(path.join(root, 'working'),   { recursive: true });
  await fsp.writeFile(path.join(root, 'originals', 'a.jpg'), 'jpeg-a');
  await fsp.writeFile(path.join(root, 'originals', 'b.jpg'), 'jpeg-b');
  return root;
}

async function makeHotFolder() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-front-hot-'));
}

const PARENT = {
  id:             88812,
  job_name:       'PXTEST-FRONT-1',
  order_number:   'PXTEST-FRONT',
  order_id:       'ord-front-3',
  product_code:   'FRONT-4X6',
  process:        'Lab',
  options:        [{ name: 'finish', value: 'gloss' }],
  customer_name:  'Frontline Customer',
};

function frontlineRoute(outputPath, overrides = {}) {
  return {
    type:             'controller',
    controllerType:   'frontline',
    controllerId:     'CTRL-FRONT-1',
    controllerName:   'Frontline A',
    outputPath,
    device:           'Pixfizz',
    backPrint1:       '{jobName}  {customerName}',
    backPrint2:       '{jobId}  {filename}',
    batchCode:        'BATCH-A',
    sortString:       'SORT-1',
    checkOrderStatus: false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('Frontline reprint: dispatch via sendReprint with routing-service-only setup succeeds', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  const result = await printService.sendReprint(
    PARENT,
    reprintPath,
    'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }],
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method, 'frontline-reprint');
  assert.equal(__writeCalls.length, 1);
  assert.equal(__generateCalls.length, 1);
});

test('Frontline reprint: reprint-suffixed jobId is identical in generator input + writer folder + XML filename', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  const result = await printService.sendReprint(PARENT, reprintPath, 'r2', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  const expectedJobId = '88812-r2';
  // Generator input
  assert.equal(__generateCalls[0].frontlineJob.id, expectedJobId,
    'generator receives the suffixed id → drives XML <customerID>');
  // Writer args
  assert.equal(__writeCalls[0].jobId, expectedJobId,
    'writer receives the suffixed id → drives folder name + XML filename');
  // Actual on-disk shape
  assert.equal(result.destPath, path.join(hot, '88812-r2'));
  assert.ok(fs.existsSync(path.join(hot, '88812-r2', '88812-r2.xml')));
  // Parent's slot is untouched
  assert.equal(fs.existsSync(path.join(hot, '88812')), false,
    'parent-id folder must NOT have been created — reprint must stay distinct');
});

test('Frontline reprint: reprint-suffixed job_name flows into the generator (backPrint placeholder source)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__generateCalls[0].frontlineJob.job_name, 'PXTEST-FRONT-1-r1',
    'job_name carries the reprint suffix so {jobName} backPrint expansion reads as a distinct reprint');
});

test('Frontline reprint: reprintImages + qtyCurrent flow into generator.images', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  await printService.sendReprint(PARENT, reprintPath, 'r1', [
    { filename: 'a.jpg', qtyCurrent: 2 },
    { filename: 'b.jpg', qtyCurrent: 5 },
  ]);

  const imgs = __generateCalls[0].frontlineJob.images;
  assert.deepEqual(imgs.map(i => i.filename),      ['a.jpg', 'b.jpg']);
  assert.deepEqual(imgs.map(i => i.quantity),      [2, 5],
    'qtyCurrent from reprint sidecar drives generator quantities');
  assert.deepEqual(imgs.map(i => i.rotationAngle), [0, 0],
    'rotationAngle defaults to 0 (matches normal-send shape)');
});

test('Frontline reprint: controllerConfig fields plumbed from route (device/backPrint1/backPrint2)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot, {
    device:     'Frontier-XYZ',
    backPrint1: 'CUSTOM1-{customerName}',
    backPrint2: 'CUSTOM2-{filename}',
  });

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  const cfg = __generateCalls[0].controllerConfig;
  assert.equal(cfg.device,     'Frontier-XYZ');
  assert.equal(cfg.backPrint1, 'CUSTOM1-{customerName}');
  assert.equal(cfg.backPrint2, 'CUSTOM2-{filename}');
});

test('Frontline reprint: channelConfig fields plumbed from route (batchCode/sortString)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot, { batchCode: 'BATCH-77', sortString: 'SORT-99' });

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  const cfg = __generateCalls[0].channelConfig;
  assert.equal(cfg.batchCode,  'BATCH-77');
  assert.equal(cfg.sortString, 'SORT-99');
});

test('Frontline reprint: writer receives route.outputPath as the hot folder', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__writeCalls[0].outputPath, hot,
    'writer outputPath arg sourced from route.outputPath');
});

test('Frontline reprint: customer + parent.id preserved (only id+job_name are suffixed)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  const fj = __generateCalls[0].frontlineJob;
  assert.equal(fj.id,            '88812-r1');
  assert.equal(fj.order_number,  'PXTEST-FRONT', 'order_number is the parent\'s, not suffixed');
  assert.equal(fj.customer_name, 'Frontline Customer');
});

// ── Negative assertion — parent lifecycle untouched ─────────────────────────

test('Frontline reprint: NEVER calls _markCompleted (parent lifecycle untouched)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__markCompletedCalls.length, 0,
    'reprint must not advance parent to completed');
});

// ── Route validation guard ──────────────────────────────────────────────────

test('Frontline reprint: route missing outputPath → success:false', async (t) => {
  resetCaptures();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));
  __routeForReturn = frontlineRoute('');

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /outputPath/);
});

test('Frontline reprint: route missing batchCode → success:false (channel-mapping gap on target)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot, { batchCode: '' });

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /batchCode/);
  assert.match(result.error, /Add a channel mapping/);
});

test('Frontline reprint: route missing sortString → success:false', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot, { sortString: '' });

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /sortString/);
});

// ── Sidecar edge cases ──────────────────────────────────────────────────────

test('Frontline reprint: empty reprintImages → success:false (no images to send)', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', []);

  assert.equal(result.success, false);
  assert.match(result.error, /no images/i);
});

test('Frontline reprint: image missing on disk → success:false with the missing path', async (t) => {
  resetCaptures();
  const hot = await makeHotFolder();
  const reprintPath = await makeReprintFolder();
  t.after(() => { fs.rmSync(reprintPath, { recursive: true, force: true }); fs.rmSync(hot, { recursive: true, force: true }); });
  __routeForReturn = frontlineRoute(hot);

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [
    { filename: 'never-exists.jpg', qtyCurrent: 1 },
  ]);

  assert.equal(result.success, false);
  assert.match(result.error, /Reprint image not found/);
  assert.match(result.error, /never-exists\.jpg/);
});
