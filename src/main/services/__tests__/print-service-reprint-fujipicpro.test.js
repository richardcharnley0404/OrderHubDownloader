'use strict';

/**
 * Integration tests for _sendReprintViaFujiPicPro (M5 of the Fuji PIC
 * Pro brief).
 *
 * Mirrors print-service-reprint-fujijobmaker.test.js — stubs
 * routing-service, fuji-pic-pro-generator, fuji-pic-pro-file-writer,
 * config-service, print-controller-service and the legacy print-
 * controller-store, then exercises sendReprint end-to-end so the
 * test also pins the dispatch arm and the route-field plumbing.
 *
 * Pins:
 *   - Routing-service-only setup succeeds.
 *   - orderId = `{parentJobName}-{reprintSuffix}` — used for the
 *     order.txt filename AND the staging folder name.
 *   - Reprint sidecar images + qtyCurrent + originalFilename flow
 *     into the generator's `images` array with the right
 *     printCode / color from the route.
 *   - Route fields (three paths + timeouts + release toggle) reach
 *     the writer + monitor.
 *   - Route validation guard rejects malformed routes cleanly.
 *   - _markCompleted / _markInProduction NOT called (parent
 *     lifecycle untouched — same posture as JobMaker reprints).
 *   - Monitor IS started + submission IS enqueued (PIC Pro reprints
 *     need the DIGIN handshake to complete; without the monitor the
 *     images would sit in staging forever). This is the one
 *     divergence from JobMaker's reprint contract.
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

// ── Capture state ────────────────────────────────────────────────────────────

const __stageCalls               = []; // stageImages args
const __generateCalls            = []; // generateFujiPicProOrderFile args
const __writeOrderFileCalls      = []; // writeOrderFile args
const __markCompletedCalls       = [];
const __markInProductionCalls    = [];
const __startMonitoringCalls     = [];
const __enqueueCalls             = [];
let   __routeForReturn           = null;

function resetCaptures() {
  __stageCalls.length            = 0;
  __generateCalls.length         = 0;
  __writeOrderFileCalls.length   = 0;
  __markCompletedCalls.length    = 0;
  __markInProductionCalls.length = 0;
  __startMonitoringCalls.length  = 0;
  __enqueueCalls.length          = 0;
  __routeForReturn               = null;
}

// ── Stubs (require.cache injection) ──────────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const fakeConfigService = {
  get:               () => undefined,
  getProcessMapping: () => ({}),
  getApiSettings:    () => ({ baseUrl: '', key: '' }),
};

const fakePrintControllerStore = {
  printControllerStore: {
    getController:     () => null,
    findChannelForJob: () => null,
    getAllControllers: () => [],
  },
};

const fakeRoutingService = {
  resolveRoute:         () => __routeForReturn,
  resolvePrintSizeCode: () => '',
  getRoutingHeldProcesses: () => new Set(),
  getControllers:       () => [],
};

const fakePicProGenerator = {
  generateFujiPicProOrderFile: (job, controller) => {
    __generateCalls.push({ job, controller });
    return {
      filename: `${job.orderId}.txt`,
      contents: '<fake>',
    };
  },
};

const fakePicProFileWriter = {
  stageImages: async (args) => {
    __stageCalls.push(args);
    return {
      stagingFolder: path.join(args.imageStagingRoot, args.orderId),
      negNumberMap:  args.imageFiles.map((img, i) => ({
        negNumber:        String(i + 1).padStart(4, '0'),
        sourcePath:       img.sourcePath,
        originalFilename: img.originalFilename || '',
        stagedName:       `${String(i + 1).padStart(4, '0')}.jpg`,
        stagedPath:       path.join(args.imageStagingRoot, args.orderId, `${String(i + 1).padStart(4, '0')}.jpg`),
      })),
    };
  },
  writeOrderFile: async (args) => {
    __writeOrderFileCalls.push(args);
    return { writtenPath: path.join(args.orderDataPath, args.filename) };
  },
  // deliverToDigin / writeCommandFile aren't reached by the reprint
  // path directly — the monitor calls them later. Empty impls in case
  // any lazy require probes them.
  deliverToDigin:   async () => ({ destFolder: '', method: 'rename' }),
  writeCommandFile: async () => ({ writtenPath: '' }),
};

const fakePrintControllerService = {
  printControllerService: {
    startMonitoring: (controllerId) => { __startMonitoringCalls.push(controllerId); },
    getMonitor:      () => ({
      enqueueSubmission: (entry) => { __enqueueCalls.push(entry); return entry; },
    }),
  },
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'),               fakeConfigService);
stubInCache(path.join(SVC, 'print-controller-store.js'),       fakePrintControllerStore);
stubInCache(path.join(SVC, 'routing-service.js'),              fakeRoutingService);
stubInCache(path.join(SVC, 'fuji-pic-pro-generator.js'),       fakePicProGenerator);
stubInCache(path.join(SVC, 'fuji-pic-pro-file-writer.js'),     fakePicProFileWriter);
stubInCache(path.join(SVC, 'print-controller-service.js'),     fakePrintControllerService);

const printService = require(path.join(SVC, 'print-service.js'));

// Sidestep sharp — corrections aren't the unit under test here.
printService._applyCorrectionsToImageFiles = async (imageFiles) => imageFiles;

const origMarkCompleted    = printService._markCompleted;
const origMarkInProduction = printService._markInProduction;
printService._markCompleted    = async (jobId) => {
  __markCompletedCalls.push(jobId);
  return origMarkCompleted    ? origMarkCompleted.call(printService, jobId)    : undefined;
};
printService._markInProduction = async (jobId) => {
  __markInProductionCalls.push(jobId);
  return origMarkInProduction ? origMarkInProduction.call(printService, jobId) : undefined;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

async function makeReprintFolder() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pp-rp-'));
  await fsp.mkdir(path.join(root, 'originals'), { recursive: true });
  await fsp.mkdir(path.join(root, 'working'),   { recursive: true });
  await fsp.writeFile(path.join(root, 'originals', 'a.jpg'), 'fake-jpeg-a');
  await fsp.writeFile(path.join(root, 'originals', 'b.jpg'), 'fake-jpeg-b');
  return root;
}

const PARENT = {
  id:             77701,
  job_name:       'PXTEST-PP-1',
  order_number:   'PXTEST-PP',
  order_id:       'ord-1',
  product_code:   'PP4X6',
  process:        'Lab',
  options:        [{ name: 'finish', value: 'lustre' }],
  customer_name:  'Test Customer',
  customer_email: 'a@b.c',
};

function picProRoute(overrides = {}) {
  return {
    type:                'controller',
    controllerType:      'fujipicpro',
    controllerId:        'CTRL-PP-1',
    controllerName:      'PIC Pro DL650',
    orderDataPath:       '\\\\Labserver1\\Order Data',
    diginPath:           '\\\\Labserver1\\DIGIN1',
    mergeDataPath:       '\\\\Labserver1\\Merge Data',
    imageStagingRoot:    'C:\\pp\\staging',
    gatewayTimeoutMs:    120000,
    buildTimeoutMs:      1800000,
    sendReleaseCommand:  true,
    backprintMode:       'text',
    backprintTemplate:   '{originalFilename}',
    backprintTemplate2:  '',
    includeCustomerName: false,
    surface:             'Lustre',
    surfaceCode:         'L',
    printCode:           '64',
    color:               'C',
    checkOrderStatus:    false,
    printSize:           '6x4',
    channelMappingId:    'cm-pp-1',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('PIC Pro reprint: dispatch via sendReprint with routing-service-only setup succeeds', async (t) => {
  resetCaptures();
  __routeForReturn = picProRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(
    PARENT, reprintPath, 'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }],
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method, 'fujipicpro-reprint');
  assert.equal(__stageCalls.length, 1,          'reached stageImages');
  assert.equal(__generateCalls.length, 1,       'reached generateFujiPicProOrderFile');
  assert.equal(__writeOrderFileCalls.length, 1, 'reached writeOrderFile');
});

test('PIC Pro reprint: orderId is {parentJobName}-{reprintSuffix}', async (t) => {
  resetCaptures();
  __routeForReturn = picProRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r2',
    [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__generateCalls[0].job.orderId, 'PXTEST-PP-1-r2',
    'generator receives the reprint-suffixed orderId (creates a NEW PIC Pro order, not [restart] of the parent)');
  assert.equal(__stageCalls[0].orderId, 'PXTEST-PP-1-r2',
    'staging folder inherits the same reprint-suffixed name to avoid colliding with the parent');
  assert.equal(__writeOrderFileCalls[0].filename, 'PXTEST-PP-1-r2.txt',
    'order.txt filename carries the reprint suffix');
});

test('PIC Pro reprint: sidecar images + qty flow to the generator; route.printCode + route.color propagate', async (t) => {
  resetCaptures();
  __routeForReturn = picProRoute({ printCode: '64', color: 'B' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [
    { filename: 'a.jpg', qtyCurrent: 2, originalFilename: 'DSC_1.jpg' },
    { filename: 'b.jpg', qtyCurrent: 5, originalFilename: 'DSC_2.jpg' },
  ]);

  const genJob = __generateCalls[0].job;
  assert.equal(genJob.images.length, 2);
  assert.equal(genJob.images[0].negNumber, '0001', 'sequence-renamed via stageImages');
  assert.equal(genJob.images[0].printCode, '64',   'printCode sourced from route');
  assert.equal(genJob.images[0].color,     'B',    'color sourced from route');
  assert.equal(genJob.images[0].quantity,  2);
  assert.equal(genJob.images[0].originalFilename, 'DSC_1.jpg',
    'originalFilename flows from the reprint sidecar so {originalFilename} back-print token still shows the customer file');
  assert.equal(genJob.images[1].quantity,  5);
});

test('PIC Pro reprint (regression, fix 1): qty + originalFilename survive `_applyCorrectionsToImageFiles` field-stripping', async (t) => {
  // Reproduces the review defect: `_applyCorrectionsToImageFiles`
  // returns only { sourcePath, filename } whenever a CMY correction
  // is applied (print-service.js line ~3075), dropping every other
  // per-image key. Pre-fix the reprint arm read qty + originalFilename
  // off that stripped array, so any B&W-tinted reprint quietly became
  // Qty=1 with a blank Backprint1.
  //
  // Simulate the real function's field-stripping by installing a
  // stub that behaves identically for corrected rows. Then assert
  // the emitted generator payload still carries the manifest-source
  // values.
  const origApply = printService._applyCorrectionsToImageFiles;
  printService._applyCorrectionsToImageFiles = async (imageFiles, _wp, correctionsMap) => {
    return imageFiles.map((img) => {
      const c = (correctionsMap && correctionsMap.get(img.filename)) || {};
      const hasCorrection = (c.cyan || 0) !== 0 || (c.magenta || 0) !== 0 || (c.yellow || 0) !== 0;
      // Matches the real function at print-service.js `_applyCorrectionsToImageFiles`.
      return hasCorrection
        ? { sourcePath: img.sourcePath, filename: img.filename }
        : img;
    });
  };
  t.after(() => { printService._applyCorrectionsToImageFiles = origApply; });

  resetCaptures();
  __routeForReturn = picProRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [
    // qtyCurrent 3 + a non-zero magenta so the stub strips the row.
    // Pre-fix: image[0].quantity comes back undefined and the
    // generator defaults it to 1 — customer gets one print instead
    // of three. Backprint1 also loses `DSC_9.jpg`.
    { filename: 'a.jpg', qtyCurrent: 3, originalFilename: 'DSC_9.jpg', corrections: { magenta: 12 } },
  ]);

  const genImg = __generateCalls[0].job.images[0];
  assert.equal(genImg.quantity, 3,
    'Qty must survive `_applyCorrectionsToImageFiles` — pre-fix this came back undefined and defaulted to 1');
  assert.equal(genImg.originalFilename, 'DSC_9.jpg',
    '{originalFilename} must survive — pre-fix Backprint1 rendered blank on any corrected image');

  // Also assert stageImages saw the original filename so
  // negNumberMap.originalFilename is populated for the dispatch record.
  assert.equal(__stageCalls[0].imageFiles[0].originalFilename, 'DSC_9.jpg');
});

test('PIC Pro reprint: monitor IS started + submission IS enqueued (needed for the DIGIN handshake)', async (t) => {
  // This is the one deliberate divergence from the JobMaker reprint
  // contract. JobMaker reprints skip the monitor because dropping the
  // .txt in the hot folder is the whole handshake. PIC Pro reprints
  // NEED the monitor — without it, deliverToDigin never runs and the
  // images stay in staging forever.
  resetCaptures();
  __routeForReturn = picProRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.deepEqual(__startMonitoringCalls, ['CTRL-PP-1'],
    'printControllerService.startMonitoring must be called with the controller id');
  assert.equal(__enqueueCalls.length, 1,
    'the reprint submission must be enqueued so the monitor can complete DIGIN + optional release');
  assert.equal(__enqueueCalls[0].orderId, 'PXTEST-PP-1-r1');
  assert.equal(__enqueueCalls[0].sendReleaseCommand, true,
    'sendReleaseCommand toggle flows through so the reprint respects the operator preference');
  assert.equal(__enqueueCalls[0].mergeDataPath, '\\\\Labserver1\\Merge Data');
});

test('PIC Pro reprint: parent job lifecycle untouched — no _markCompleted / _markInProduction', async (t) => {
  resetCaptures();
  __routeForReturn = picProRoute({ checkOrderStatus: false });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.deepEqual(__markCompletedCalls,    [],
    'reprint must NOT mark the parent completed (parent status is a sibling concept)');
  assert.deepEqual(__markInProductionCalls, [],
    'reprint must NOT mark the parent in-production either — mirrors the JobMaker reprint contract');
});

test('PIC Pro reprint: empty reprintImages returns { success:false }', async (t) => {
  resetCaptures();
  __routeForReturn = picProRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', []);
  assert.equal(result.success, false);
  assert.match(result.error, /Reprint has no images/);
  assert.equal(__stageCalls.length, 0, 'must fail before touching stageImages');
});

test('PIC Pro reprint: missing image on disk returns { success:false } before staging', async (t) => {
  resetCaptures();
  __routeForReturn = picProRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1',
    [{ filename: 'not-on-disk.jpg', qtyCurrent: 1 }]);
  assert.equal(result.success, false);
  assert.match(result.error, /Reprint image not found on disk/);
});

test('PIC Pro reprint: route validation — missing orderDataPath rejects cleanly', async (t) => {
  resetCaptures();
  __routeForReturn = picProRoute({ orderDataPath: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }]);
  assert.equal(result.success, false);
  assert.match(result.error, /route missing required fields/);
  assert.match(result.error, /orderDataPath/);
});

test('PIC Pro reprint: missing printCode rejects (guard against a stale pre-M1 mapping)', async (t) => {
  resetCaptures();
  __routeForReturn = picProRoute({ printCode: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }]);
  assert.equal(result.success, false);
  assert.match(result.error, /printCode/);
});
