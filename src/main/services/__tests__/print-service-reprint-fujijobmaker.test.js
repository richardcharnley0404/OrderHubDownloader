'use strict';

/**
 * Integration tests for _sendReprintViaFujiJobMaker (Phase 3a).
 *
 * Mirrors print-service-reprint-dpof-route.test.js's harness — stubs
 * routing-service, fuji-jobmaker-generator, fuji-jobmaker-file-writer,
 * config-service and the legacy print-controller-store, then exercises
 * sendReprint end-to-end so the test also pins the dispatch arm and
 * the route-field plumbing.
 *
 * Pins:
 *   - Routing-service-only setup succeeds (no legacy-store dependencies).
 *   - Reprint suffix lands in orderRef / surface filenames / staging folder.
 *   - reprintSidecar images + qtyCurrent flow into the surfaceGroups.
 *   - Route fields (outputPath, imageStagingRoot, surface/printCode/etc.)
 *     reach the generator + writer.
 *   - Route validation guard rejects malformed routes cleanly.
 *   - _markCompleted / _markInProduction NOT called.
 *   - printControllerService monitor NOT registered (reprint stays invisible
 *     so it doesn't mutate the parent's status).
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

const __generateCalls            = []; // generateFujiJobMakerFiles args
const __writeCalls               = []; // fujiJobMakerFileWriter.writeOrderFiles args
const __markCompletedCalls       = [];
const __markInProductionCalls    = [];
const __startMonitoringCalls     = [];
const __trackSubmissionCalls     = [];
let   __routeForReturn           = null;

function resetCaptures() {
  __generateCalls.length         = 0;
  __writeCalls.length            = 0;
  __markCompletedCalls.length    = 0;
  __markInProductionCalls.length = 0;
  __startMonitoringCalls.length  = 0;
  __trackSubmissionCalls.length  = 0;
  __routeForReturn               = null;
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

const fakeFujiGenerator = {
  generateFujiJobMakerFiles: (fujiJob, controllerCfg) => {
    __generateCalls.push({ fujiJob, controllerCfg });
    // One surface file per surface group, matching the v0 shape.
    return fujiJob.surfaceGroups.map(g => ({
      filename: `${fujiJob.orderRef}_${g.surface}.txt`,
      contents: '<fake>',
    }));
  },
};

const fakeFujiWriter = {
  fujiJobMakerFileWriter: {
    writeOrderFiles: async (args) => {
      __writeCalls.push(args);
      return {
        writtenFiles:       args.surfaceFiles.map(sf => path.join(args.hotFolderPath, sf.filename)),
        copiedImages:       args.imageFiles.map(im => im.filename),
        imageStagingFolder: path.join(args.imageStagingRoot, args.orderRef),
      };
    },
  },
};

// printControllerService.startMonitoring / getMonitor.trackSubmission must
// not fire for reprints — instrument both so the negative assertion bites
// if anyone wires them in.
const fakePrintControllerService = {
  printControllerService: {
    startMonitoring: (controllerId) => { __startMonitoringCalls.push(controllerId); },
    getMonitor:      () => ({ trackSubmission: (s) => { __trackSubmissionCalls.push(s); } }),
  },
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'),            fakeConfigService);
stubInCache(path.join(SVC, 'print-controller-store.js'),    fakePrintControllerStore);
stubInCache(path.join(SVC, 'routing-service.js'),           fakeRoutingService);
stubInCache(path.join(SVC, 'fuji-jobmaker-generator.js'),   fakeFujiGenerator);
stubInCache(path.join(SVC, 'fuji-jobmaker-file-writer.js'), fakeFujiWriter);
stubInCache(path.join(SVC, 'print-controller-service.js'),  fakePrintControllerService);

const printService = require(path.join(SVC, 'print-service.js'));

// Sidestep sharp — corrections aren't the unit under test here.
printService._applyCorrectionsToImageFiles = async (imageFiles) => imageFiles;

// Spy on the lifecycle hooks so the negative assertions bite if a future
// edit accidentally calls them from the reprint path.
const origMarkCompleted    = printService._markCompleted;
const origMarkInProduction = printService._markInProduction;
printService._markCompleted    = async (jobId) => { __markCompletedCalls.push(jobId);    return origMarkCompleted    ? origMarkCompleted.call(printService, jobId)    : undefined; };
printService._markInProduction = async (jobId) => { __markInProductionCalls.push(jobId); return origMarkInProduction ? origMarkInProduction.call(printService, jobId) : undefined; };

// ── Helpers ─────────────────────────────────────────────────────────────────

async function makeReprintFolder() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-fuji-rp-'));
  await fsp.mkdir(path.join(root, 'originals'), { recursive: true });
  await fsp.mkdir(path.join(root, 'working'),   { recursive: true });
  await fsp.writeFile(path.join(root, 'originals', 'a.jpg'), 'fake-jpeg-a');
  await fsp.writeFile(path.join(root, 'originals', 'b.jpg'), 'fake-jpeg-b');
  return root;
}

const PARENT = {
  id:             55501,
  job_name:       'PXTEST-FUJI-1',
  order_number:   'PXTEST-FUJI',
  order_id:       'ord-1',
  product_code:   'FUJI4X6',
  process:        'Lab',
  options:        [{ name: 'finish', value: 'lustre' }],
  customer_name:  'Test Customer',
  customer_email: 'a@b.c',
};

function fujiRoute(overrides = {}) {
  return {
    type:              'controller',
    controllerType:    'fujijobmaker',
    controllerId:      'CTRL-FUJI-1',
    controllerName:    'Fuji JobMaker A',
    outputPath:        'C:\\hot\\fuji',
    imageStagingRoot:  'C:\\fuji\\staging',
    printerName:       'Frontier-1',
    autoCorrect:       null,
    backprintMode:     'none',
    backprintTemplate: '',
    surface:           'Lustre',
    surfaceCode:       'L',
    printCode:         'PC-4x6-L',
    checkOrderStatus:  false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('Fuji reprint: dispatch via sendReprint with routing-service-only setup succeeds', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(
    PARENT,
    reprintPath,
    'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }],
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method, 'fujijobmaker-reprint');
  assert.equal(__writeCalls.length, 1, 'reached fujiJobMakerFileWriter');
  assert.equal(__generateCalls.length, 1, 'reached generateFujiJobMakerFiles');
});

test('Fuji reprint: orderRef carries the reprint suffix', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r2', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__generateCalls[0].fujiJob.orderRef, 'PXTEST-FUJI-r2');
  assert.equal(__writeCalls[0].orderRef,           'PXTEST-FUJI-r2',
    'writer orderRef drives surface filenames AND staging folder name');
});

test('Fuji reprint: surface filenames and staging folder both reprint-suffixed', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute({ surface: 'Lustre' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  // Surface file in the hot folder
  assert.equal(result.destPaths.length, 1);
  assert.equal(path.basename(result.destPaths[0]), 'PXTEST-FUJI-r1_Lustre.txt');
  assert.match(result.destPaths[0], /hot\\fuji\\PXTEST-FUJI-r1_Lustre\.txt$/);
  // Staging folder
  assert.match(result.stagedFolder, /staging\\PXTEST-FUJI-r1$/);
});

test('Fuji reprint: reprintImages + qtyCurrent flow into surfaceGroups.images', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute({ printCode: 'PC-XL' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [
    { filename: 'a.jpg', qtyCurrent: 3 },
    { filename: 'b.jpg', qtyCurrent: 1 },
  ]);

  const groups = __generateCalls[0].fujiJob.surfaceGroups;
  assert.equal(groups.length, 1, 'single surface group in v0');
  assert.deepEqual(groups[0].images.map(i => i.filename), ['a.jpg', 'b.jpg']);
  assert.deepEqual(groups[0].images.map(i => i.quantity), [3, 1],
    'qtyCurrent from reprint sidecar drives surface-group quantities');
  assert.equal(groups[0].images[0].printCode, 'PC-XL', 'printCode sourced from route');
  assert.equal(groups[0].surface,     'Lustre');
  assert.equal(groups[0].surfaceCode, 'L');
});

test('Fuji reprint: controllerCfg fields plumbed from route (printerName, autoCorrect, backprint*)', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute({
    printerName:       'Frontier-7',
    autoCorrect:       true,
    backprintMode:     'image',
    backprintTemplate: '{orderRef}',
    imageStagingRoot:  'D:\\staging\\fuji',
  });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  const cfg = __generateCalls[0].controllerCfg;
  assert.equal(cfg.printerName,       'Frontier-7');
  assert.equal(cfg.autoCorrect,       true);
  assert.equal(cfg.backprintMode,     'image');
  assert.equal(cfg.backprintTemplate, '{orderRef}');
  assert.equal(cfg.imageStagingRoot,  'D:\\staging\\fuji');

  // Writer also receives the staging root + hot folder
  assert.equal(__writeCalls[0].hotFolderPath,    'C:\\hot\\fuji');
  assert.equal(__writeCalls[0].imageStagingRoot, 'D:\\staging\\fuji');
});

test('Fuji reprint: customer + jobName + parent.id flow through (parent identity preserved)', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  const fujiJob = __generateCalls[0].fujiJob;
  assert.equal(fujiJob.id,                 55501,         'id stays the parent.id (only orderRef gets suffixed)');
  assert.equal(fujiJob.jobName,            'PXTEST-FUJI-1');
  assert.equal(fujiJob.customer.fullName,  'Test Customer');
  assert.equal(fujiJob.customer.email,     'a@b.c');
});

// ── Negative-assertion suite — reprint MUST stay invisible to lifecycle/monitor

test('Fuji reprint: NEVER calls _markCompleted or _markInProduction (parent lifecycle untouched)', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__markCompletedCalls.length,    0, 'reprint must not advance parent to completed');
  assert.equal(__markInProductionCalls.length, 0, 'reprint must not advance parent to in-production');
});

test('Fuji reprint: NEVER calls startMonitoring or trackSubmission (monitor must stay focused on parent)', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__startMonitoringCalls.length, 0,
    'reprint must NOT register with the monitor — its accept/timeout would mutate parent status');
  assert.equal(__trackSubmissionCalls.length, 0,
    'reprint must NOT trackSubmission for its surface files');
});

// ── Route-validation guard ──────────────────────────────────────────────────

test('Fuji reprint: route missing outputPath → success:false (descriptive error)', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute({ outputPath: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /outputPath/);
  assert.equal(__writeCalls.length, 0);
});

test('Fuji reprint: route missing imageStagingRoot → success:false', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute({ imageStagingRoot: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /imageStagingRoot/);
});

test('Fuji reprint: route missing surface → success:false (channel-mapping gap on target)', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute({ surface: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /surface/);
  assert.match(result.error, /Add a channel mapping/);
});

test('Fuji reprint: route missing printCode → success:false', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute({ printCode: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /printCode/);
});

// ── Sidecar edge cases ──────────────────────────────────────────────────────

test('Fuji reprint: empty reprintImages → success:false (no images to send)', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', []);

  assert.equal(result.success, false);
  assert.match(result.error, /no images/i);
  assert.equal(__writeCalls.length, 0);
});

test('Fuji reprint: image missing on disk → success:false with the missing path', async (t) => {
  resetCaptures();
  __routeForReturn = fujiRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [
    { filename: 'never-exists.jpg', qtyCurrent: 1 },
  ]);

  assert.equal(result.success, false);
  assert.match(result.error, /Reprint image not found/);
  assert.match(result.error, /never-exists\.jpg/);
});
