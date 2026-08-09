/**
 * Tests for the darkroompro branch of resolveRoute's `_channelMappingOverride`
 * short-circuit.
 *
 * Before this fix, `_channelMappingOverride` for a darkroompro job fell into
 * the "DPOF and other controller types" fallthrough literal, which silently
 * omitted `artworkRootPath`, `orderLastNameFormat`, and `channelMappingId`
 * from the returned route. `_sendViaDarkroomProRouted` reads
 * artworkRootPath + orderLastNameFormat straight off the route
 * (print-service.js:1983-1984), so reassigned darkroompro jobs got broken
 * artwork paths and defaulted order-name formatting.
 *
 * The override path is used by:
 *   - `ohd:routing:release-hold` (ipc-handlers.js:1390) — operator releases
 *     a held job to a specific controller.
 *   - `batchCropActions.js:362` — crop-to-size stamps the mapping id.
 *
 * The tests here lock the fix: an override-resolved darkroompro route must
 * carry every field the non-override darkroompro path carries, so downstream
 * dispatch cannot tell the difference between the two entry points.
 *
 * Store/electron are shimmed exactly like routing-ignored-options.test.js.
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const os     = require('node:os');
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

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  if (req === 'electron')       return fakeElectron;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const routingService = require(
  path.join(REPO, 'src', 'main', 'services', 'routing-service.js'),
);
const { resolveRoute } = routingService;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CTRL_ID = 'ctrl-dp';
const PRODUCT = '0406-photo-print';
const MAPPING_ID = 'cm-dp-1';

function seedDarkroomPro() {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers: [{
      id:                   CTRL_ID,
      name:                 'Darkroom Pro Station 1',
      type:                 'darkroompro',
      outputPath:           '/hot',
      artworkRootPath:      'Z:\\Pixfizz\\Artwork',
      orderLastNameFormat:  'labCode_orderRef_lastName',
      checkOrderStatus:     true,
    }],
    channelMappings: [{
      id:            MAPPING_ID,
      controllerId:  CTRL_ID,
      productCode:   PRODUCT,
      options:       [],
    }],
  });
}

const baseJob = {
  id: 'j1',
  process: 'Lab',
  product_code: PRODUCT,
  options: [],
};

// ── Shape parity: override route matches non-override route ───────────────────

test('override darkroompro route has the same field set as non-override route', () => {
  seedDarkroomPro();

  const nonOverride = resolveRoute(baseJob);
  const override    = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });

  assert.equal(nonOverride.type,           'controller');
  assert.equal(nonOverride.controllerType, 'darkroompro');
  assert.equal(override.type,              'controller');
  assert.equal(override.controllerType,    'darkroompro');

  // Same key set on both. This is the regression lock — any future field
  // added to one branch must be added to the other, or this fails.
  assert.deepEqual(
    Object.keys(override).sort(),
    Object.keys(nonOverride).sort(),
    'override branch must carry the same field set as the main darkroompro branch',
  );
});

test('override darkroompro route carries artworkRootPath from the controller', () => {
  seedDarkroomPro();
  const route = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });
  assert.equal(route.artworkRootPath, 'Z:\\Pixfizz\\Artwork');
});

test('override darkroompro route carries orderLastNameFormat from the controller', () => {
  seedDarkroomPro();
  const route = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });
  assert.equal(route.orderLastNameFormat, 'labCode_orderRef_lastName');
});

test('override darkroompro route carries channelMappingId = overrideMapping.id', () => {
  seedDarkroomPro();
  const route = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });
  assert.equal(route.channelMappingId, MAPPING_ID);
});

test('override darkroompro route carries checkOrderStatus from the controller', () => {
  seedDarkroomPro();
  const route = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });
  assert.equal(route.checkOrderStatus, true);
});

test('override darkroompro: absent artworkRootPath / orderLastNameFormat use the same defaults as the main branch', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers: [{
      id:         CTRL_ID,
      name:       'Bare DP',
      type:       'darkroompro',
      outputPath: '/hot',
      // artworkRootPath, orderLastNameFormat deliberately omitted.
    }],
    channelMappings: [{
      id: MAPPING_ID, controllerId: CTRL_ID, productCode: PRODUCT, options: [],
    }],
  });
  const nonOverride = resolveRoute(baseJob);
  const override    = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });
  assert.equal(override.artworkRootPath,     nonOverride.artworkRootPath);
  assert.equal(override.orderLastNameFormat, nonOverride.orderLastNameFormat);
  assert.equal(override.orderLastNameFormat, 'orderRef_lastName',
    'default order-last-name format must match the main branch default');
});

// ── Negative — other controller types are not touched by this fix ────────────

test('override for a DPOF controller still uses the generic fallthrough shape', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-dpof' }],
    orderControllers: [{
      id: 'ctrl-dpof', name: 'Epson', type: 'epson', outputPath: '/dpof',
    }],
    channelMappings: [{
      id: 'cm-dpof', controllerId: 'ctrl-dpof', productCode: PRODUCT,
      options: [], channelNumber: 3, printSizeCode: 'KG',
    }],
  });
  const route = resolveRoute({ ...baseJob, _channelMappingOverride: 'cm-dpof' });
  assert.equal(route.type, 'controller');
  assert.equal(route.controllerType, 'epson');
  assert.equal(route.channelNumber, 3);
  assert.equal(route.printSizeCode, 'KG');
  // The darkroompro-only fields must not have leaked into a DPOF route.
  assert.equal(Object.prototype.hasOwnProperty.call(route, 'artworkRootPath'),     false);
  assert.equal(Object.prototype.hasOwnProperty.call(route, 'orderLastNameFormat'), false);
});

test.after(() => { Module.prototype.require = __originalRequire; });
