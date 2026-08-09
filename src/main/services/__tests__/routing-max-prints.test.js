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

// Restore require shim hygiene for any later-loaded modules in the same worker.
test.after(() => { Module.prototype.require = __originalRequire; });
