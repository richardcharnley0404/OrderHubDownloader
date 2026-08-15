/**
 * Tests for the per-controller `maxPrintsPerJob` batch-splitting cap.
 *
 * Darkroom Pro (v1.10) and Epson (M5 of docs/epson-batch-splitting-
 * brief.md) carry `maxPrintsPerJob: <positive integer>`. The value is
 * read from the store on every resolveRoute and surfaced on the returned
 * route so the dispatch method (`_sendViaDarkroomProRouted` for DP,
 * `sendViaDPOFRouted` for Epson) can decide whether to split. No
 * migration — an absent, null, non-numeric or non-positive field must
 * be treated as "feature off" and surface as `null` on the route.
 *
 * `noritsu` and untyped-dpof controllers deliberately do NOT surface
 * the field on their routes — the brief scopes this release to Epson
 * OrderController. A stale value on those types must NOT reach the
 * route (advertising it would let holdForReview raise a reason a
 * downstream dispatcher can't act on).
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

// ── M5 of docs/epson-batch-splitting-brief.md — epson controllers ───────────
//
// Epson now surfaces both fields on its route literals (main, override,
// resolveRouteForController). Same read-time defaults as darkroompro.
// noritsu and untyped-dpof stay excluded.

function seedEpson({ maxPrintsPerJob, autoSendBatches } = {}) {
  const controller = {
    id:              'ctrl-eps',
    name:            'Epson SureLab',
    type:            'epson',
    outputPath:      '/eps',
  };
  if (maxPrintsPerJob !== undefined) controller.maxPrintsPerJob = maxPrintsPerJob;
  if (autoSendBatches !== undefined) controller.autoSendBatches = autoSendBatches;
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-eps' }],
    orderControllers:          [controller],
    channelMappings:           [{
      id:            'cme',
      controllerId:  'ctrl-eps',
      productCode:   PRODUCT,
      options:       [],
      channelNumber: 1,
      printSizeCode: 'KG',
    }],
  });
}

test('resolveRoute: epson carries maxPrintsPerJob when valid (M5 parity with darkroompro)', () => {
  seedEpson({ maxPrintsPerJob: 100 });
  const route = resolveRoute(job);
  assert.equal(route.type,           'controller');
  assert.equal(route.controllerType, 'epson');
  assert.equal(route.maxPrintsPerJob, 100);
});

test('resolveRoute: epson surfaces null when absent (M5 read-time default)', () => {
  seedEpson({});
  const route = resolveRoute(job);
  assert.equal(route.maxPrintsPerJob, null);
});

for (const bad of [0, -1, Number.NaN, 'abc', {}, [], false, true]) {
  test(`resolveRoute epson: invalid maxPrintsPerJob (${JSON.stringify(bad)}) → null on the route`, () => {
    seedEpson({ maxPrintsPerJob: bad });
    assert.equal(resolveRoute(job).maxPrintsPerJob, null);
  });
}

test('resolveRouteForController: epson carries maxPrintsPerJob when valid (M5)', () => {
  seedEpson({ maxPrintsPerJob: 50 });
  const route = resolveRouteForController(job, 'ctrl-eps');
  assert.equal(route.type,            'controller');
  assert.equal(route.controllerType,  'epson');
  assert.equal(route.maxPrintsPerJob, 50);
});

test('resolveRouteForController: epson surfaces null when absent (M5)', () => {
  seedEpson({});
  const route = resolveRouteForController(job, 'ctrl-eps');
  assert.equal(route.maxPrintsPerJob, null);
});

test('resolveRoute via _channelMappingOverride (epson) carries maxPrintsPerJob (M5)', () => {
  seedEpson({ maxPrintsPerJob: 75 });
  const route = resolveRoute({ ...job, _channelMappingOverride: 'cme' });
  assert.equal(route.controllerType,  'epson');
  assert.equal(route.maxPrintsPerJob, 75);
});

test('resolveRoute via _channelMappingOverride (epson) surfaces null when absent (M5)', () => {
  seedEpson({});
  const route = resolveRoute({ ...job, _channelMappingOverride: 'cme' });
  assert.equal(route.maxPrintsPerJob, null);
});

test('resolveRouteForController: noritsu still does NOT surface maxPrintsPerJob (scope guard)', () => {
  // The M5 scope is Epson OrderController. A noritsu controller with a
  // stale maxPrintsPerJob must NOT advertise the field — advertising it
  // would let holdForReview raise the over-batch-threshold reason on a
  // controller whose dispatcher has no splitter to consume it.
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-nor' }],
    orderControllers:          [{
      id:              'ctrl-nor',
      name:            'Noritsu QSS',
      type:            'noritsu',
      outputPath:      '/nor',
      maxPrintsPerJob: 100,   // stale — must not surface
    }],
    channelMappings:           [{
      id:            'cmn',
      controllerId:  'ctrl-nor',
      productCode:   PRODUCT,
      options:       [],
      channelNumber: 1,
      printSizeCode: 'KG',
    }],
  });
  const route = resolveRoute(job);
  assert.equal(route.controllerType, 'noritsu');
  assert.equal(Object.prototype.hasOwnProperty.call(route, 'maxPrintsPerJob'), false);

  const rrfc = resolveRouteForController(job, 'ctrl-nor');
  assert.equal(Object.prototype.hasOwnProperty.call(rrfc, 'maxPrintsPerJob'), false);
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

test('autoSendBatches: epson routes surface the field (M5 parity with darkroompro)', () => {
  seedEpson({ autoSendBatches: true, maxPrintsPerJob: 100 });
  const route = resolveRoute(job);
  assert.equal(route.controllerType,  'epson');
  assert.equal(route.autoSendBatches, true);
});

test('autoSendBatches: epson defaults to false when absent (M5 read-time default)', () => {
  seedEpson({ maxPrintsPerJob: 100 });
  const route = resolveRoute(job);
  assert.equal(route.autoSendBatches, false);
});

for (const bad of [1, 'true', 'yes', {}, [], null]) {
  test(`autoSendBatches epson: non-boolean ${JSON.stringify(bad)} coerces to false on the route`, () => {
    seedEpson({ autoSendBatches: bad, maxPrintsPerJob: 100 });
    assert.equal(resolveRoute(job).autoSendBatches, false,
      'strict === true coercion — anything else is feature-off');
  });
}

test('autoSendBatches: _channelMappingOverride branch (epson) carries the field (M5)', () => {
  seedEpson({ autoSendBatches: true, maxPrintsPerJob: 50 });
  const route = resolveRoute({ ...job, _channelMappingOverride: 'cme' });
  assert.equal(route.controllerType,  'epson');
  assert.equal(route.autoSendBatches, true);
});

test('autoSendBatches: resolveRouteForController (epson) carries the field (M5)', () => {
  seedEpson({ autoSendBatches: true, maxPrintsPerJob: 30 });
  const route = resolveRouteForController(job, 'ctrl-eps');
  assert.equal(route.autoSendBatches, true);
});

test('autoSendBatches: noritsu still does NOT surface the field (M5 scope guard)', () => {
  // The field is meaningless on noritsu — no splitter for that type.
  // A stale value must not be advertised on the route (advertising would
  // let holdForReview raise a reason a downstream dispatcher can't act on).
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-nor' }],
    orderControllers:          [{
      id:               'ctrl-nor',
      name:             'Noritsu QSS',
      type:             'noritsu',
      outputPath:       '/nor',
      autoSendBatches:  true,   // stale — must not surface
    }],
    channelMappings:           [{
      id:            'cmn',
      controllerId:  'ctrl-nor',
      productCode:   PRODUCT,
      options:       [],
      channelNumber: 1,
      printSizeCode: 'KG',
    }],
  });
  const route = resolveRoute(job);
  assert.equal(route.controllerType, 'noritsu');
  assert.equal(Object.prototype.hasOwnProperty.call(route, 'autoSendBatches'), false);

  const rrfc = resolveRouteForController(job, 'ctrl-nor');
  assert.equal(Object.prototype.hasOwnProperty.call(rrfc, 'autoSendBatches'), false);
});

// Restore require shim hygiene for any later-loaded modules in the same worker.
test.after(() => { Module.prototype.require = __originalRequire; });
