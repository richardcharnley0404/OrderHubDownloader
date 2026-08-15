/**
 * Tests for the per-controller `maxPrintsPerJob` batch-splitting cap.
 *
 * A Darkroom Pro controller may carry `maxPrintsPerJob: <positive integer>`.
 * The value is read from the store on every resolveRoute and surfaced on the
 * returned route so the dispatch method (`_sendViaDarkroomProRouted`) can
 * decide whether to split. No migration — an absent, null, non-numeric or
 * non-positive field must be treated as "feature off" and surface as `null`
 * on the route.
 *
 * The DPOF and other controller types deliberately do NOT surface the field
 * on their routes in this milestone — the Epson batching release adds it
 * there.
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
const { resolveRoute, resolveRouteForController } = routingService;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CTRL_ID = 'ctrl-dp';
const PRODUCT = '0406-photo-print';

function seedDarkroomPro(maxPrintsPerJob) {
  const controller = {
    id:         CTRL_ID,
    name:       'Darkroom Pro Station 1',
    type:       'darkroompro',
    outputPath: '/out',
  };
  if (maxPrintsPerJob !== undefined) controller.maxPrintsPerJob = maxPrintsPerJob;

  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers: [controller],
    channelMappings: [{
      id:            'cm1',
      controllerId:  CTRL_ID,
      productCode:   PRODUCT,
      options:       [],
    }],
  });
}

const job = {
  id: 'j1',
  process: 'Lab',
  product_code: PRODUCT,
  options: [],
};

// ── resolveRoute — Darkroom Pro branch ────────────────────────────────────────

test('absent maxPrintsPerJob → route carries null', () => {
  seedDarkroomPro(undefined);
  const route = resolveRoute(job);
  assert.equal(route.type, 'controller');
  assert.equal(route.controllerType, 'darkroompro');
  assert.equal(route.maxPrintsPerJob, null);
});

test('valid positive integer → route carries the value', () => {
  seedDarkroomPro(100);
  const route = resolveRoute(job);
  assert.equal(route.maxPrintsPerJob, 100);
});

test('valid large integer within range → route carries the value', () => {
  seedDarkroomPro(9999);
  const route = resolveRoute(job);
  assert.equal(route.maxPrintsPerJob, 9999);
});

for (const bad of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'abc', '100', null, false, true, {}, []]) {
  test(`invalid maxPrintsPerJob (${JSON.stringify(bad)}) → route carries null (not clamped)`, () => {
    seedDarkroomPro(bad);
    const route = resolveRoute(job);
    assert.equal(route.type, 'controller');
    // Feature-off, never a clamped/coerced value.
    assert.equal(route.maxPrintsPerJob, null);
  });
}

// ── resolveRouteForController — Darkroom Pro branch ───────────────────────────

test('resolveRouteForController: darkroompro carries maxPrintsPerJob when valid', () => {
  seedDarkroomPro(50);
  const route = resolveRouteForController(job, CTRL_ID);
  assert.equal(route.type, 'controller');
  assert.equal(route.controllerType, 'darkroompro');
  assert.equal(route.maxPrintsPerJob, 50);
});

test('resolveRouteForController: darkroompro surfaces null when absent', () => {
  seedDarkroomPro(undefined);
  const route = resolveRouteForController(job, CTRL_ID);
  assert.equal(route.maxPrintsPerJob, null);
});

// ── _channelMappingOverride branch — must carry maxPrintsPerJob too ─────────
// The pre-fix commit (fix(routing): carry darkroompro fields on
// _channelMappingOverride path) added a darkroompro branch to the override
// short-circuit. That branch is on the same "reassigned darkroompro job"
// code path as resolveRouteForController and must not silently drop the cap
// either — otherwise a job released from routing-hold to a darkroompro
// controller would dispatch as one big file even though the cap is set.

test('resolveRoute via _channelMappingOverride (darkroompro) carries maxPrintsPerJob', () => {
  seedDarkroomPro(75);
  const route = resolveRoute({ ...job, _channelMappingOverride: 'cm1' });
  assert.equal(route.type, 'controller');
  assert.equal(route.controllerType, 'darkroompro');
  assert.equal(route.maxPrintsPerJob, 75);
});

test('resolveRoute via _channelMappingOverride (darkroompro) surfaces null when absent', () => {
  seedDarkroomPro(undefined);
  const route = resolveRoute({ ...job, _channelMappingOverride: 'cm1' });
  assert.equal(route.maxPrintsPerJob, null);
});

test('resolveRouteForController: DPOF controller does NOT surface maxPrintsPerJob (Epson release adds it)', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-dpof' }],
    orderControllers: [{
      id:              'ctrl-dpof',
      name:            'Epson SureLab',
      type:            'epson',
      outputPath:      '/dpof',
      // Even if a stale/legacy setting is present on a non-darkroompro
      // controller, it must not be advertised on the route in M1.
      maxPrintsPerJob: 100,
    }],
    channelMappings: [{
      id:           'cmd',
      controllerId: 'ctrl-dpof',
      productCode:  PRODUCT,
      options:      [],
      channelNumber: 1,
      printSizeCode: 'KG',
    }],
  });
  const route = resolveRouteForController(job, 'ctrl-dpof');
  assert.equal(route.type, 'controller');
  assert.equal(route.controllerType, 'epson');
  assert.equal(Object.prototype.hasOwnProperty.call(route, 'maxPrintsPerJob'), false);
});

// ── autoSendBatches (M2, 2026-08-15) ─────────────────────────────────────────
//
// Companion to maxPrintsPerJob: darkroompro-only opt-in that suppresses the
// over-batch-threshold operator-review gate so auto-print dispatches the
// job and the existing splitter writes _1.txt / _2.txt files unchanged. All
// three darkroompro literals (main resolveRoute, _channelMappingOverride,
// resolveRouteForController) carry the field so a reassigned or overridden
// route sees the same behaviour as the primary path — drift on any of them
// would silently split-and-hold jobs the operator explicitly opted OUT of
// reviewing.
//
// Strict === true coercion: a stray non-boolean (hand-edited config,
// external caller, legacy fixture) surfaces as `false`, matching the
// M2 "feature must fail closed" posture in holdForReview.js.

function seedDarkroomProAuto(autoSendBatches, maxPrintsPerJob = 100) {
  const controller = {
    id:              CTRL_ID,
    name:            'Darkroom Pro Station 1',
    type:            'darkroompro',
    outputPath:      '/out',
    maxPrintsPerJob,
  };
  if (autoSendBatches !== undefined) controller.autoSendBatches = autoSendBatches;
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers: [controller],
    channelMappings: [{
      id:            'cm1',
      controllerId:  CTRL_ID,
      productCode:   PRODUCT,
      options:       [],
    }],
  });
}

test('autoSendBatches: absent on the controller → route carries `false`', () => {
  seedDarkroomProAuto(undefined);
  const route = resolveRoute(job);
  assert.equal(route.controllerType, 'darkroompro');
  assert.equal(route.autoSendBatches, false, 'default state must be feature-off');
});

test('autoSendBatches: `true` on the controller → route carries `true`', () => {
  seedDarkroomProAuto(true);
  assert.equal(resolveRoute(job).autoSendBatches, true);
});

test('autoSendBatches: `false` on the controller → route carries `false`', () => {
  seedDarkroomProAuto(false);
  assert.equal(resolveRoute(job).autoSendBatches, false);
});

for (const bad of [1, 'true', 'yes', {}, [], null]) {
  test(`autoSendBatches: non-boolean ${JSON.stringify(bad)} coerces to false on the route`, () => {
    seedDarkroomProAuto(bad);
    assert.equal(resolveRoute(job).autoSendBatches, false,
      'strict === true coercion — anything else is feature-off');
  });
}

test('autoSendBatches: _channelMappingOverride branch carries the field too', () => {
  // The override branch is a separate literal that must stay in parity
  // with the main branch — see the "drift on that branch has caused a
  // live bug before" comment in the brief.
  seedDarkroomProAuto(true);
  const route = resolveRoute({ ...job, _channelMappingOverride: 'cm1' });
  assert.equal(route.controllerType, 'darkroompro');
  assert.equal(route.autoSendBatches, true);
});

test('autoSendBatches: _channelMappingOverride branch defaults to false when absent', () => {
  seedDarkroomProAuto(undefined);
  const route = resolveRoute({ ...job, _channelMappingOverride: 'cm1' });
  assert.equal(route.autoSendBatches, false);
});

test('autoSendBatches: resolveRouteForController darkroompro branch carries the field', () => {
  seedDarkroomProAuto(true);
  const route = resolveRouteForController(job, CTRL_ID);
  assert.equal(route.autoSendBatches, true);
});

test('autoSendBatches: resolveRouteForController darkroompro branch defaults to false when absent', () => {
  seedDarkroomProAuto(undefined);
  const route = resolveRouteForController(job, CTRL_ID);
  assert.equal(route.autoSendBatches, false);
});

test('autoSendBatches: non-darkroompro routes do NOT surface the field', () => {
  // Same scoping discipline as maxPrintsPerJob — the field is meaningless
  // on other controller types (no splitter to skip a hold for). A stale
  // value must not be advertised on the route.
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-dpof' }],
    orderControllers: [{
      id:               'ctrl-dpof',
      name:             'Epson SureLab',
      type:             'epson',
      outputPath:       '/dpof',
      autoSendBatches:  true,
    }],
    channelMappings: [{
      id:            'cmd',
      controllerId:  'ctrl-dpof',
      productCode:   PRODUCT,
      options:       [],
      channelNumber: 1,
      printSizeCode: 'KG',
    }],
  });
  const route = resolveRoute(job);
  assert.equal(route.type, 'controller');
  assert.equal(route.controllerType, 'epson');
  assert.equal(Object.prototype.hasOwnProperty.call(route, 'autoSendBatches'), false);

  const rrfc = resolveRouteForController(job, 'ctrl-dpof');
  assert.equal(Object.prototype.hasOwnProperty.call(rrfc, 'autoSendBatches'), false);
});

// Restore require shim hygiene for any later-loaded modules in the same worker.
test.after(() => { Module.prototype.require = __originalRequire; });
