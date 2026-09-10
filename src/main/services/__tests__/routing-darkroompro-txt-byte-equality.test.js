/**
 * Byte-equality invariant for Darkroom Pro dispatch: a DP job routed via
 * resolveRouteForController must produce a .TXT byte-identical to the same
 * job routed via resolveRoute when both resolve to the same controller.
 *
 * This is the invariant that ACTUALLY matters — the field-parity test in
 * routing-darkroompro-fields.test.js locks the route object's shape, but
 * the operator-visible artefact is the .TXT the emitter writes. If those
 * two disagreed for any reason (a value coercion in one branch, a null-vs-
 * empty-string difference the emitter's readers treated differently, a
 * future emitter field derived from a shape-difference we didn't notice
 * yet) it would surface here as a byte-level diff, catching the class of
 * defect that field-parity alone can miss.
 *
 * Concrete example: the pre-fix defect this test would have caught.
 * `resolveRouteForController` dropped `orderLastNameFormat` from the route
 * for a darkroompro controller, so a controller configured with
 * `orderLastNameFormat: 'labCode_orderRef_lastName'` produced the correct
 * `OrderLastName=LAB-REF-Smith` line when routed via resolveRoute and the
 * WRONG `OrderLastName=REF Smith` line when routed via
 * resolveRouteForController (the emitter's own `|| 'orderRef_lastName'`
 * fallback at darkroom-pro-output.js:71 masked the drop, silently
 * degrading to the default). A byte-diff on the emitted .TXT is the only
 * signal that would have shown up before an operator saw wrong labels on
 * printed photos.
 *
 * The controller here deliberately uses a NON-DEFAULT orderLastNameFormat
 * — with the default value both routes coincidentally agree because the
 * emitter's fallback matches resolveRoute's default. The non-default
 * fixture is the one that exercises the divergence.
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');
const Module = require('node:module');

const __storeData = {};
function FakeStore() {
  return {
    get: (k, d) => (k in __storeData ? __storeData[k] : d),
    set: (k, v) => { __storeData[k] = v; },
    delete: (k) => { delete __storeData[k]; },
    has:  (k) => (k in __storeData),
  };
}
function __seed(data) {
  for (const k of Object.keys(__storeData)) delete __storeData[k];
  Object.assign(__storeData, data);
}

const fakeElectron = {
  app: { getPath: () => os.tmpdir(), on: () => {} },
};

const fakeLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  logInfo: () => {}, logError: () => {}, logDebug: () => {},
  logWarning: () => {},
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  if (req === 'electron')       return fakeElectron;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

{
  const loggerPath = require.resolve(path.join(REPO, 'src', 'main', 'services', 'logger.js'));
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: fakeLogger };
}

const { resolveRoute, resolveRouteForController } = require(
  path.join(REPO, 'src', 'main', 'services', 'routing-service.js'),
);
const { generateDarkroomProFile } = require(
  path.join(REPO, 'src', 'main', 'services', 'darkroom-pro-output.js'),
);

// ── Fixtures ────────────────────────────────────────────────────────────────

const CTRL_ID    = 'ctrl-dp';
const PRODUCT    = '0406-print';
const MAPPING_ID = 'cm-dp';

/**
 * Build a Darkroom Pro controller with a NON-DEFAULT orderLastNameFormat.
 * The default (`orderRef_lastName`) is what the emitter falls back to when
 * the field is undefined — testing against the default would give a false
 * positive.
 */
function seedDp(overrides = {}) {
  const controller = {
    id:                   CTRL_ID,
    name:                 'DP Station',
    type:                 'darkroompro',
    outputPath:           fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-dp-byteq-')),
    artworkRootPath:      'Z:\\LabArtwork\\2026',
    orderLastNameFormat:  'labCode_orderRef_lastName',
    checkOrderStatus:     true,
    sizeTranslations:     [{ productCodePrefix: PRODUCT, darkroomSize: '4x6' }],
    mediaOptionKey:       'finish',
    mediaTranslations:    [{ from: 'Lustre', to: 'Thick Luster' }],
    photoLines:           [],
    ...overrides,
  };
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers:          [controller],
    channelMappings:           [{
      id:           MAPPING_ID,
      controllerId: CTRL_ID,
      productCode:  PRODUCT,
      options:      [{ name: 'finish', value: 'Lustre' }],
    }],
  });
  return controller;
}

const JOB = {
  id:           'j1',
  order_number: 'PXDEMO-REF',
  order_id:     42,
  job_name:     'PXDEMO-REF-1',
  process:      'Lab',
  product_code: PRODUCT,
  options:      [{ name: 'finish', value: 'Lustre' }],
  customer_name: 'Jane Smith',
  customer_email: 'jane@example.com',
  created_at:   '2026-01-15T10:00:00.000Z',
  website:      'LAB',
};

/**
 * Build the emitter's `controller` argument from a resolved route object,
 * exactly the way _sendViaDarkroomProRouted does at print-service.js:2572.
 * This lets us test that the two route objects, when consumed by real
 * dispatch construction, produce byte-identical .TXT output.
 */
function controllerFromRoute(route, fullController) {
  return {
    artworkRootPath:     route.artworkRootPath,
    orderLastNameFormat: route.orderLastNameFormat,
    outputPath:          route.outputPath,
    sizeTranslations:    fullController.sizeTranslations  || [],
    mediaOptionKey:      fullController.mediaOptionKey    || '',
    mediaTranslations:   fullController.mediaTranslations || [],
    photoLines:          fullController.photoLines        || [],
  };
}

/**
 * Build the emitter's `job` argument the way _sendViaDarkroomProRouted
 * does. Constant across both routes so the only thing that can differ is
 * the controller-side inputs.
 */
function dpJobFromParent(parent) {
  const fullName  = (parent.customer_name || '').trim();
  const spaceIdx  = fullName.indexOf(' ');
  const firstName = spaceIdx === -1 ? fullName : fullName.substring(0, spaceIdx);
  const lastName  = spaceIdx === -1 ? ''        : fullName.substring(spaceIdx + 1).trim();

  return {
    id:                 parent.id,
    orderRef:           parent.order_number,
    outputFilenameStem: parent.job_name,
    productCode:        parent.product_code,
    customer:           { firstName, lastName, email: parent.customer_email },
    labCode:            parent.website,
    orderDate:          new Date(parent.created_at),
    lineItems: [{
      qty:     1,
      options: parent.options,
      images: [{
        sourcePath: 'Z:\\LabArtwork\\2026\\PXDEMO-REF\\img1.jpg',
        filename:   'img1.jpg',
      }],
    }],
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Byte equality — the invariant that matters
// ═════════════════════════════════════════════════════════════════════════

test('darkroompro .TXT byte equality: resolveRoute and resolveRouteForController produce byte-identical output for the same job + controller', async () => {
  const controller = seedDp();

  const routeMain = resolveRoute(JOB);
  const routeCtrl = resolveRouteForController(JOB, CTRL_ID);

  assert.equal(routeMain.controllerType, 'darkroompro');
  assert.equal(routeCtrl.controllerType, 'darkroompro');

  // Route each to its OWN output folder so the two writes don't overwrite
  // each other. The output PATHS will differ (each route was written into
  // a distinct mkdtemp folder); the file CONTENTS must be identical.
  const outMain = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-dp-main-'));
  const outCtrl = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-dp-ctrl-'));

  const emitterCtrlMain = { ...controllerFromRoute(routeMain, controller), outputPath: outMain };
  const emitterCtrlCtrl = { ...controllerFromRoute(routeCtrl, controller), outputPath: outCtrl };

  const dpJob = dpJobFromParent(JOB);

  const destMain = await generateDarkroomProFile(dpJob, emitterCtrlMain);
  const destCtrl = await generateDarkroomProFile(dpJob, emitterCtrlCtrl);

  const bytesMain = fs.readFileSync(destMain);
  const bytesCtrl = fs.readFileSync(destCtrl);

  assert.equal(
    bytesCtrl.equals(bytesMain),
    true,
    'byte-diff between the two routes: this is the exact class of defect ' +
    'the field-parity test cannot catch alone. Inspect the two files:\n' +
    `  main:         ${destMain}\n` +
    `  forController: ${destCtrl}`,
  );
});

test('darkroompro .TXT byte equality: OrderLastName= line uses the configured format on BOTH routes', async () => {
  // Explicit anchor for the pre-fix defect. Independent of the byte-equal
  // check above so a future test-runner that shows one assertion at a time
  // still surfaces the actionable failure.
  const controller = seedDp({ orderLastNameFormat: 'labCode_orderRef_lastName' });

  const routeMain = resolveRoute(JOB);
  const routeCtrl = resolveRouteForController(JOB, CTRL_ID);

  const outMain = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-dp-ln-main-'));
  const outCtrl = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-dp-ln-ctrl-'));

  const emitterCtrlMain = { ...controllerFromRoute(routeMain, controller), outputPath: outMain };
  const emitterCtrlCtrl = { ...controllerFromRoute(routeCtrl, controller), outputPath: outCtrl };

  const dpJob = dpJobFromParent(JOB);

  const destMain = await generateDarkroomProFile(dpJob, emitterCtrlMain);
  const destCtrl = await generateDarkroomProFile(dpJob, emitterCtrlCtrl);

  const textMain = fs.readFileSync(destMain, 'utf8');
  const textCtrl = fs.readFileSync(destCtrl, 'utf8');

  const lineMain = textMain.split('\r\n').find(l => l.startsWith('OrderLastName='));
  const lineCtrl = textCtrl.split('\r\n').find(l => l.startsWith('OrderLastName='));

  // 'labCode_orderRef_lastName' with fixture data produces: LAB-PXDEMO-REF - Smith
  assert.equal(lineMain, 'OrderLastName=LAB-PXDEMO-REF - Smith');
  assert.equal(lineCtrl, 'OrderLastName=LAB-PXDEMO-REF - Smith',
    'reassignment path must not silently emit the default OrderLastName format');
});

test.after(() => { Module.prototype.require = __originalRequire; });
