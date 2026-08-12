'use strict';

/**
 * Regression tests for the v1.7.11 → v1.7.12 Noritsu reprint fix —
 * second leg.
 *
 * Background: even after the dispatch switch was widened to dispatch
 * 'noritsu' / 'epson' into _sendReprintViaDPOF, the method itself
 * re-resolved its controller via the LEGACY stores —
 * configService.getProcessMapping → printControllerStore.getController →
 * printControllerStore.findChannelForJob — and threw "no controller
 * mapping for process X" / "no product mapping for product Y" for jobs
 * whose routing lives only in the modern routing-service store
 * (Settings → Routing). Fix: _sendReprintViaDPOF now takes the route
 * resolved by sendReprint and consumes route.outputPath /
 * channelNumber / printSizeCode / controllerType /
 * includeCustomerInFolder directly — mirroring the normal
 * sendViaDPOFRouted path.
 *
 * This file pins:
 *   1. A parent routed ONLY via routing-service (legacy stores empty)
 *      reprints successfully — no "no controller mapping" error.
 *   2. The route's outputPath / channelNumber / printSizeCode /
 *      controllerType / includeCustomerInFolder are what the DPOF
 *      dispatch actually feeds to dpofGenerator + orderFolderWriter.
 *   3. The new route-validation guard rejects malformed routes cleanly
 *      (returns success:false instead of crashing in dpof-generator).
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

const __generateCalls   = []; // dpofGenerator.generate args
const __writeCalls      = []; // orderFolderWriter.writeOrderFolder args
let   __routeForReturn  = null;

function resetCaptures() {
  __generateCalls.length = 0;
  __writeCalls.length    = 0;
  __routeForReturn       = null;
}

// ── Stubs (require.cache injection) ──────────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// The two legacy stores _sendReprintViaDPOF USED to consult. We make them
// return the "nothing here" responses they would on a clean routing-service-
// only setup, so any code path that accidentally re-introduces the legacy
// lookup will fail loudly.
const fakeConfigService = {
  get:                  () => undefined,
  getProcessMapping:    () => ({}),                       // empty — no controllerId
  getApiSettings:       () => ({ baseUrl: '', key: '' }),
};

const fakePrintControllerStore = {
  printControllerStore: {
    getController:      () => null,                       // not found in legacy store
    findChannelForJob:  () => null,                       // no channel in legacy store
    getAllControllers:  () => [],
  },
};

const fakeRoutingService = {
  resolveRoute:         () => __routeForReturn,
  resolvePrintSizeCode: (m) => (m && m.printSizeCode) || '',
  getRoutingHeldProcesses: () => new Set(),
};

const fakeDpofGenerator = {
  dpofGenerator: {
    generate: (args) => { __generateCalls.push(args); return '<dpof>\r\n'; },
  },
};

const fakeOrderFolderWriter = {
  orderFolderWriter: {
    writeOrderFolder: async (hotFolderPath, parentJob, dpofContent, imageFiles, reprintSuffix, nameOpts) => {
      __writeCalls.push({ hotFolderPath, parentJob, dpofContent, imageFiles, reprintSuffix, nameOpts });
      return {
        folderPath: path.join(hotFolderPath, 'o-fake'),
        folderName: 'o-fake',
      };
    },
  },
};

// print-service → logger → electron.app. Replace `electron` so the require
// chain resolves without booting the runtime.
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'),        fakeConfigService);
stubInCache(path.join(SVC, 'print-controller-store.js'), fakePrintControllerStore);
stubInCache(path.join(SVC, 'routing-service.js'),       fakeRoutingService);
stubInCache(path.join(SVC, 'dpof-generator.js'),        fakeDpofGenerator);
stubInCache(path.join(SVC, 'order-folder-writer.js'),   fakeOrderFolderWriter);

const printService = require(path.join(SVC, 'print-service.js'));

// _applyCorrectionsToImageFiles uses sharp under the hood. Short-circuit to
// pass-through so we don't drag the image-processing dep into a dispatch test.
printService._applyCorrectionsToImageFiles = async (imageFiles) => imageFiles;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function makeReprintFolder() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-reprint-'));
  await fsp.mkdir(path.join(root, 'originals'), { recursive: true });
  await fsp.mkdir(path.join(root, 'working'),   { recursive: true });
  await fsp.writeFile(path.join(root, 'originals', 'a.jpg'), 'fake-jpeg');
  return root;
}

const PARENT = {
  id:            12345,
  job_name:      'PXTEST-NORI-1',
  order_number:  'PXTEST-NORI',
  product_code:  'PHOTO4X6',
  process:       'Lab',
  options:       [{ name: 'finish-options', value: 'lustre' }],
  customer_name: 'Test',
};

function noritsuRoute(overrides = {}) {
  return {
    type:                    'controller',
    controllerType:          'noritsu',
    controllerId:            'CTRL-1',
    controllerName:          'Noritsu QSS-37',
    outputPath:              'C:\\hot\\noritsu',
    channelNumber:           42,
    printSizeCode:           'KG',
    bannerSheet:             false,
    skipAutoPrint:           false,
    checkOrderStatus:        true,
    includeCustomerInFolder: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('reprint via DPOF: parent routed ONLY via routing-service (legacy stores empty) succeeds', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute();
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  // Pre-fix this would fail with:
  //   "Parent job ... has no controller mapping for process \"Lab\"."
  // because configService.getProcessMapping returns {} and the method
  // re-resolved through it. Post-fix it uses the route directly.
  const result = await printService.sendReprint(
    PARENT,
    reprintPath,
    'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }],
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method, 'dpof-reprint');
  assert.equal(__writeCalls.length, 1, 'reached orderFolderWriter');
});

test('reprint via DPOF: dpofGenerator receives route.channelNumber + route.printSizeCode + route.controllerType', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ channelNumber: 7, printSizeCode: 'NML -PSIZE "8x4"', controllerType: 'noritsu' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 2 }]);

  assert.equal(__generateCalls.length, 1);
  const args = __generateCalls[0];
  assert.equal(args.channelNumber, 7,          'channelNumber sourced from route, not from a legacy findChannelForJob lookup');
  assert.equal(args.printSizeCode, 'NML -PSIZE "8x4"', 'printSizeCode sourced from route (pre-resolved by routing-service)');
  assert.equal(args.controllerType, 'noritsu', 'controllerType sourced from route');
  assert.equal(args.jobId, 12345,              'jobId comes from parentJob.id');
  assert.equal(args.orderNumber, 'PXTEST-NORI');
  assert.deepEqual(args.images, [{ filename: 'a.jpg', quantity: 2 }]);
});

test('reprint via DPOF: orderFolderWriter receives route.outputPath as the hot folder', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ outputPath: 'C:\\custom\\hotfolder' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__writeCalls.length, 1);
  assert.equal(__writeCalls[0].hotFolderPath, 'C:\\custom\\hotfolder',
    'writeOrderFolder hot-folder arg sourced from route.outputPath');
});

test('reprint via DPOF: nameOpts.includeCustomerName follows route.includeCustomerInFolder', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ includeCustomerInFolder: false });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(__writeCalls[0].nameOpts.includeCustomerName, false,
    'includeCustomerInFolder:false on the route flows through to nameOpts');
});

test('reprint via DPOF: epson controllerType also dispatches successfully via the same path', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ controllerType: 'epson', controllerName: 'Epson Surelab' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, true);
  assert.equal(__generateCalls[0].controllerType, 'epson');
});

// ── Route-validation guard ──────────────────────────────────────────────────

test('reprint via DPOF: route missing outputPath → success:false with descriptive error', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ outputPath: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /route missing required fields/i);
  assert.match(result.error, /outputPath: missing/);
  assert.equal(__writeCalls.length, 0, 'must not reach orderFolderWriter with a malformed route');
});

test('reprint via DPOF: route missing channelNumber → success:false', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ channelNumber: null });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /channelNumber: missing/);
});

// ── Print-size guard (M1, missing-print-size-recovery-brief.md) ────────────
//
// Pre-M1 a reprint against a sizeless DPOF-family mapping wrote a literal
// `PRT PSL=` line to the AUTPRINT.MRK, orderFolderWriter succeeded, and OHD
// reported the reprint as sent. Post-M1 the reprint fails with the same
// operator-facing message shape as first send, and never touches the
// generator or the writer. These tests pin that.

test('reprint via DPOF: blank printSizeCode → success:false naming the product, no file written, generator not called', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ printSizeCode: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /No print size configured/i, 'error message uses the first-send guard shape');
  assert.match(result.error, /"PHOTO4X6"/,               'error names the product_code so operators know which mapping to fix');
  assert.match(result.error, /Settings → Routing/,        'error tells the operator where to fix it');
  assert.equal(__generateCalls.length, 0, 'must not reach dpofGenerator with a sizeless route');
  assert.equal(__writeCalls.length,    0, 'must not reach orderFolderWriter with a sizeless route');
});

test('reprint via DPOF: whitespace-only printSizeCode is treated as blank', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ printSizeCode: '   ' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /No print size configured/i);
  assert.equal(__generateCalls.length, 0);
});

test('reprint via DPOF: null printSizeCode is treated as blank', async (t) => {
  resetCaptures();
  __routeForReturn = noritsuRoute({ printSizeCode: null });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /No print size configured/i);
});

test('reprint via DPOF: parent with no product_code renders the "(none)" fallback', async (t) => {
  // Matches the first-send guard's `job.product_code || '(none)'` shape so
  // the operator sees a coherent error even for a job whose product_code
  // failed to hydrate onto the cache entry — an edge, but the first-send
  // guard covers it too and this parity keeps operator training uniform.
  resetCaptures();
  __routeForReturn = noritsuRoute({ printSizeCode: '' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const parentNoProduct = { ...PARENT, product_code: '' };
  const result = await printService.sendReprint(parentNoProduct, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.error, /"\(none\)"/);
});

test('reprint via DPOF: valid printSizeCode still dispatches (guard does not misfire)', async (t) => {
  // Guarantees the guard rejects blanks without spuriously rejecting a
  // valid code — the existing suite's success-path tests already imply this,
  // but an explicit regression pin makes the intent obvious.
  resetCaptures();
  __routeForReturn = noritsuRoute({ printSizeCode: 'KG' });
  const reprintPath = await makeReprintFolder();
  t.after(() => fs.rmSync(reprintPath, { recursive: true, force: true }));

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', [{ filename: 'a.jpg', qtyCurrent: 1 }]);

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(__generateCalls.length, 1);
  assert.equal(__generateCalls[0].printSizeCode, 'KG');
});

test('reprint via DPOF: darkroompro route received by this method (defensive) returns clean error', async () => {
  resetCaptures();
  const result = await printService._sendReprintViaDPOF(
    PARENT,
    { type: 'controller', controllerType: 'darkroompro', outputPath: '/x', channelNumber: 1 },
    '/tmp/r',
    'r1',
    [{ filename: 'a.jpg', qtyCurrent: 1 }],
  );

  assert.equal(result.success, false);
  assert.match(result.error, /Darkroom Pro.*must go through sendReprint/);
});
