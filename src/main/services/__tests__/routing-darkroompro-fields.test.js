/**
 * Tests for the Darkroom Pro route literal parity — resolveRoute vs
 * resolveRouteForController.
 *
 * There are THREE darkroompro route literals in routing-service.js that must
 * agree on shape and defaults, or a darkroompro job dispatched through the
 * "wrong" entry point silently emits a .TXT with different values than the
 * same job dispatched through the "right" entry point:
 *
 *   1. Main resolveRoute darkroompro branch          (~routing-service.js:522)
 *   2. resolveRoute _channelMappingOverride override (~routing-service.js:296)
 *   3. resolveRouteForController darkroompro branch  (~routing-service.js:880)
 *
 * All three feed the same downstream dispatch code (_sendViaDarkroomProRouted
 * at print-service.js:2502, which reads route.artworkRootPath and
 * route.orderLastNameFormat directly off the route object at :2573-2574).
 *
 * Existing coverage:
 *   - routing-override-darkroompro.test.js locks parity between #1 and #2.
 *
 * This file locks parity between #1 and #3, and additionally covers the
 * three-way (#1 vs #2 vs #3) invariant so a future refactor cannot drift
 * any single branch without one of these tests firing. The failure mode
 * being guarded against is silent — undefined fields dropped from a
 * reassigned route produce .TXT files with default order-name formatting
 * regardless of the operator's configured value, and the emitter's own
 * `|| 'orderRef_lastName'` fallback (darkroom-pro-output.js:71) masks the
 * problem from every observability signal we have (no error, no .err, no
 * FAILED monitor event — just wrong output).
 *
 * Test style: full-shape parity via Object.keys(...).sort() deepEqual — the
 * same tripwire pattern used by routing-folder-copy-fields.test.js and
 * routing-pdf-copy-fields.test.js. Fields that legitimately differ between
 * the three literals are documented on an explicit exception list (see
 * FIELDS_DELIBERATELY_ABSENT_FROM_FORCONTROLLER below) rather than by
 * omission from the assertion.
 *
 * Store/electron shimmed the same way the sibling routing tests do.
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

const routingService = require(
  path.join(REPO, 'src', 'main', 'services', 'routing-service.js'),
);
const { resolveRoute, resolveRouteForController } = routingService;

// ── Fixtures ────────────────────────────────────────────────────────────────

const CTRL_ID    = 'ctrl-dp';
const PRODUCT    = '0406-photo-print';
const MAPPING_ID = 'cm-dp-1';

function seedDarkroomPro(controllerOverrides = {}, mappingOverrides = {}) {
  const controller = {
    id:                   CTRL_ID,
    name:                 'Darkroom Pro Station 1',
    type:                 'darkroompro',
    outputPath:           'C:\\dp\\hot',
    artworkRootPath:      'Z:\\Pixfizz\\Artwork',
    orderLastNameFormat:  'labCode_orderRef_lastName',
    checkOrderStatus:     true,
    ...controllerOverrides,
  };
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers:          [controller],
    channelMappings:           [{
      id:           MAPPING_ID,
      controllerId: CTRL_ID,
      productCode:  PRODUCT,
      options:      [],
      ...mappingOverrides,
    }],
  });
  return controller;
}

const JOB = { id: 'j1', product_code: PRODUCT, process: 'Lab', options: [] };

// ═════════════════════════════════════════════════════════════════════════
// Route literal parity — the tripwire
// ═════════════════════════════════════════════════════════════════════════
//
// The exception list documents fields that legitimately differ between
// resolveRoute and resolveRouteForController for darkroompro. Empty today
// — every field must agree. If a future field is genuinely one-side-only,
// add it here with a comment saying why, not by weakening the assertion.
const FIELDS_DELIBERATELY_ABSENT_FROM_FORCONTROLLER = [];
const FIELDS_DELIBERATELY_ABSENT_FROM_RESOLVEROUTE  = [];

test('darkroompro route parity: resolveRoute and resolveRouteForController produce the same keys', () => {
  seedDarkroomPro();
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, CTRL_ID);

  assert.equal(viaJob.type,           'controller');
  assert.equal(viaJob.controllerType, 'darkroompro');
  assert.equal(viaCtrl.type,          'controller');
  assert.equal(viaCtrl.controllerType, 'darkroompro');

  const keysJob  = Object.keys(viaJob).sort()
    .filter(k => !FIELDS_DELIBERATELY_ABSENT_FROM_FORCONTROLLER.includes(k));
  const keysCtrl = Object.keys(viaCtrl).sort()
    .filter(k => !FIELDS_DELIBERATELY_ABSENT_FROM_RESOLVEROUTE.includes(k));

  assert.deepEqual(keysCtrl, keysJob,
    'both darkroompro literals must expose the same key set — see the note ' +
    'at the resolveRouteForController darkroompro branch and the main ' +
    'resolveRoute darkroompro branch');
});

test('darkroompro route parity: BOTH literals carry artworkRootPath and orderLastNameFormat', () => {
  seedDarkroomPro();
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, CTRL_ID)]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(route, 'artworkRootPath'),
      'artworkRootPath must be present — _sendViaDarkroomProRouted reads it off the route at print-service.js:2573',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(route, 'orderLastNameFormat'),
      'orderLastNameFormat must be present — _sendViaDarkroomProRouted reads it off the route at print-service.js:2574',
    );
  }
});

test('darkroompro route parity: identical values in both literals for the same controller', () => {
  seedDarkroomPro();
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, CTRL_ID);

  assert.equal(viaJob.controllerId,        viaCtrl.controllerId);
  assert.equal(viaJob.controllerName,      viaCtrl.controllerName);
  assert.equal(viaJob.outputPath,          viaCtrl.outputPath);
  assert.equal(viaJob.artworkRootPath,     viaCtrl.artworkRootPath);
  assert.equal(viaJob.orderLastNameFormat, viaCtrl.orderLastNameFormat);
  assert.equal(viaJob.channelMappingId,    viaCtrl.channelMappingId);
  assert.equal(viaJob.channelNumber,       viaCtrl.channelNumber);
  assert.equal(viaJob.printSizeCode,       viaCtrl.printSizeCode);
  assert.equal(viaJob.bannerSheet,         viaCtrl.bannerSheet);
  assert.equal(viaJob.checkOrderStatus,    viaCtrl.checkOrderStatus);
  assert.equal(viaJob.maxPrintsPerJob,     viaCtrl.maxPrintsPerJob);
  assert.equal(viaJob.autoSendBatches,     viaCtrl.autoSendBatches);
});

test('darkroompro route parity: non-default orderLastNameFormat survives BOTH paths', () => {
  // The one field where a value-drift is silently absorbed by the emitter's
  // own default fallback (darkroom-pro-output.js:71). Explicit test so a
  // future regression that drops orderLastNameFormat from one branch is
  // caught by *this* assertion, not by an operator finding a wrong-format
  // OrderLastName= line in a lab dispatch.
  seedDarkroomPro({ orderLastNameFormat: 'labCode_orderRef_lastName' });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, CTRL_ID);
  assert.equal(viaJob.orderLastNameFormat,  'labCode_orderRef_lastName');
  assert.equal(viaCtrl.orderLastNameFormat, 'labCode_orderRef_lastName',
    'reassignment path must not silently fall back to the default order-name format');
});

test('darkroompro route parity: non-empty artworkRootPath survives BOTH paths', () => {
  seedDarkroomPro({ artworkRootPath: 'Z:\\LabArtwork\\2026' });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, CTRL_ID);
  assert.equal(viaJob.artworkRootPath,  'Z:\\LabArtwork\\2026');
  assert.equal(viaCtrl.artworkRootPath, 'Z:\\LabArtwork\\2026');
});

test('darkroompro defaults: absent artworkRootPath / orderLastNameFormat resolve identically via BOTH paths', () => {
  // Bare controller — the pre-configuration state. Both literals must
  // produce the same defaults; the emitter's own `|| 'orderRef_lastName'`
  // fallback (darkroom-pro-output.js:71) means default equality is the
  // only reason the defect stayed invisible until this fix, so lock it.
  seedDarkroomPro({ artworkRootPath: undefined, orderLastNameFormat: undefined });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, CTRL_ID);
  assert.equal(viaJob.artworkRootPath,      '');
  assert.equal(viaCtrl.artworkRootPath,     '');
  assert.equal(viaJob.orderLastNameFormat,  'orderRef_lastName');
  assert.equal(viaCtrl.orderLastNameFormat, 'orderRef_lastName');
});

test('darkroompro defaults: absent checkOrderStatus defaults to true via BOTH paths', () => {
  seedDarkroomPro({ checkOrderStatus: undefined });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, CTRL_ID);
  assert.equal(viaJob.checkOrderStatus,  true);
  assert.equal(viaCtrl.checkOrderStatus, true);
});

test('darkroompro maxPrintsPerJob + autoSendBatches carry through BOTH paths', () => {
  seedDarkroomPro({ maxPrintsPerJob: 25, autoSendBatches: true });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, CTRL_ID);
  assert.equal(viaJob.maxPrintsPerJob,  25);
  assert.equal(viaCtrl.maxPrintsPerJob, 25);
  assert.equal(viaJob.autoSendBatches,  true);
  assert.equal(viaCtrl.autoSendBatches, true);
});

// ═════════════════════════════════════════════════════════════════════════
// Three-way parity — resolveRoute × _channelMappingOverride × forController
// ═════════════════════════════════════════════════════════════════════════
//
// The routing:releaseHold reassign path uses resolveRouteForController.
// The crop-to-size flow uses _channelMappingOverride inside resolveRoute.
// A fresh dispatch uses the main resolveRoute branch. All three feed the
// same _sendViaDarkroomProRouted consumer. If any two drift, DP labs get
// dispatch behaviour that depends on the entry point — a class of bug the
// codebase has hit twice already (once for _channelMappingOverride, once
// for resolveRouteForController).

test('darkroompro three-way parity: main / _channelMappingOverride / resolveRouteForController same key set', () => {
  seedDarkroomPro();
  const viaMain     = resolveRoute(JOB);
  const viaOverride = resolveRoute({ ...JOB, _channelMappingOverride: MAPPING_ID });
  const viaCtrl     = resolveRouteForController(JOB, CTRL_ID);

  const keysMain     = Object.keys(viaMain).sort();
  const keysOverride = Object.keys(viaOverride).sort();
  const keysCtrl     = Object.keys(viaCtrl).sort();

  assert.deepEqual(keysOverride, keysMain, 'override must match main');
  assert.deepEqual(keysCtrl,     keysMain, 'forController must match main');
});

test('darkroompro three-way parity: all three carry identical values for a configured controller', () => {
  seedDarkroomPro({
    orderLastNameFormat: 'labCode_orderRef_lastName',
    artworkRootPath:     'Z:\\LabArtwork\\2026',
    maxPrintsPerJob:     25,
    autoSendBatches:     true,
  });
  const viaMain     = resolveRoute(JOB);
  const viaOverride = resolveRoute({ ...JOB, _channelMappingOverride: MAPPING_ID });
  const viaCtrl     = resolveRouteForController(JOB, CTRL_ID);

  for (const field of [
    'artworkRootPath', 'orderLastNameFormat', 'outputPath',
    'checkOrderStatus', 'maxPrintsPerJob', 'autoSendBatches',
    'bannerSheet', 'controllerId', 'controllerName', 'controllerType', 'type',
  ]) {
    assert.equal(viaOverride[field], viaMain[field], `override ${field} must match main`);
    assert.equal(viaCtrl[field],     viaMain[field], `forController ${field} must match main`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// No-channel — reassignment to a controller with no mapping for the job
// ═════════════════════════════════════════════════════════════════════════

test('darkroompro forController: no mapping → unrouted no-channel with controller surfaced', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers:          [{
      id:                  CTRL_ID,
      name:                'Bare DP',
      type:                'darkroompro',
      outputPath:          'C:\\dp\\hot',
      artworkRootPath:     'Z:\\Art',
      orderLastNameFormat: 'orderRef_lastName',
    }],
    // No channelMappings for this controller.
    channelMappings: [],
  });
  const route = resolveRouteForController(JOB, CTRL_ID);
  assert.equal(route.type,   'unrouted');
  assert.equal(route.reason, 'no-channel');
  assert.equal(route.controller && route.controller.id, CTRL_ID);
});

test.after(() => { Module.prototype.require = __originalRequire; });
