/**
 * Tests for the per-controller Fuji PIC Pro order-level submission
 * settings surfaced on the resolved route (M1 of
 * docs/order-level-submission-picpro-brief.md).
 *
 * A `fujipicpro` controller may carry:
 *   - `mergeOrderJobs: boolean`      — default false at read time.
 *   - `orderMergeWaitMinutes: number|null` — default 30 at read time.
 *     Null and undefined both mean "use the default". Absent, non-integer
 *     or out-of-range (< 1 or > 1440) all resolve to 30 — deliberately
 *     NOT treated as "wait forever" per the brief.
 *
 * Both fields must appear on the resolved route so the dispatch method
 * can read them; both fujipicpro literals in resolveRoute (the Layer-3
 * main branch AND the `_channelMappingOverride` short-circuit) must
 * agree. `resolveRouteForController` has no fujipicpro branch today so
 * it isn't exercised here.
 *
 * Non-picpro controllers (darkroompro, dpof, frontline, ...) must NOT
 * surface these fields on their routes — the settings are scoped to
 * fujipicpro. Same shape-scoping the maxPrintsPerJob tests enforce for
 * darkroompro (`routing-max-prints.test.js`).
 *
 * Store/electron shimmed the same way routing-max-prints.test.js does.
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

// ── Fixtures ────────────────────────────────────────────────────────────────

const PICPRO_ID = 'ctrl-pp';
const PRODUCT   = 'PHOTO4X6';

function seedPicPro(overrides = {}) {
  const controller = {
    id:                PICPRO_ID,
    name:              'Fuji PIC Pro',
    type:              'fujipicpro',
    orderDataPath:     'C:\\pp\\order',
    diginPath:         'C:\\pp\\digin',
    mergeDataPath:     'C:\\pp\\merge',
    imageStagingRoot:  'C:\\pp\\stage',
    ...overrides,
  };
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: PICPRO_ID }],
    orderControllers:          [controller],
    channelMappings:           [{
      id:           'cm-pp-1',
      controllerId: PICPRO_ID,
      productCode:  PRODUCT,
      options:      [],
      surface:      'Lustre',
      surfaceCode:  'L',
      printCode:    'KG',
      color:        'C',
      printSize:    '6x4',
    }],
  });
}

const JOB = { id: 42, product_code: PRODUCT, process: 'Lab', options: [] };

// ── Defaults on absent fields ────────────────────────────────────────────────

test('fujipicpro route defaults: absent mergeOrderJobs → false; absent orderMergeWaitMinutes → 30', () => {
  seedPicPro();
  const route = resolveRoute(JOB);
  assert.equal(route.mergeOrderJobs,        false, 'default off when not stored');
  assert.equal(route.orderMergeWaitMinutes, 30,    'default 30 when not stored');
});

test('fujipicpro route: null orderMergeWaitMinutes means "use the default 30" — not "wait forever"', () => {
  seedPicPro({ orderMergeWaitMinutes: null });
  const route = resolveRoute(JOB);
  assert.equal(route.orderMergeWaitMinutes, 30);
});

test('fujipicpro route: non-integer or out-of-range orderMergeWaitMinutes → default 30 (never NaN, never Infinity)', () => {
  // A stray non-numeric or out-of-range value in the store should not
  // propagate. Reject-at-save is the primary line of defence; this is
  // read-time belt-and-braces.
  for (const bad of [0, -5, 1441, 5000, 3.14, NaN, Infinity, '10', 'thirty', true, [], {}]) {
    seedPicPro({ orderMergeWaitMinutes: bad });
    const route = resolveRoute(JOB);
    assert.equal(route.orderMergeWaitMinutes, 30, `bad value ${JSON.stringify(bad)} must fall back to 30`);
  }
});

// ── Valid values pass through ────────────────────────────────────────────────

test('fujipicpro route: mergeOrderJobs=true persists to the route', () => {
  seedPicPro({ mergeOrderJobs: true });
  const route = resolveRoute(JOB);
  assert.equal(route.mergeOrderJobs, true);
});

test('fujipicpro route: mergeOrderJobs=true only for boolean true (not truthy strings/numbers)', () => {
  // Persisted config comes from user-editable JSON; strict-boolean read
  // stops "true" (string) or 1 from silently enabling the feature.
  for (const bad of ['true', 1, 'yes', 'on']) {
    seedPicPro({ mergeOrderJobs: bad });
    assert.equal(resolveRoute(JOB).mergeOrderJobs, false, `truthy non-boolean ${JSON.stringify(bad)} must not enable merging`);
  }
});

test('fujipicpro route: valid orderMergeWaitMinutes values persist', () => {
  for (const good of [1, 15, 30, 60, 720, 1440]) {
    seedPicPro({ orderMergeWaitMinutes: good });
    assert.equal(resolveRoute(JOB).orderMergeWaitMinutes, good);
  }
});

// ── Non-picpro controllers must NOT carry these fields ───────────────────────

test('darkroompro route: mergeOrderJobs / orderMergeWaitMinutes are NOT on the route (scope check)', () => {
  const controller = {
    id:         'ctrl-dr',
    name:       'Darkroom Pro',
    type:       'darkroompro',
    outputPath: 'C:\\dr\\hot',
    // Even if the operator somehow set these on a darkroompro record
    // (via a stale UI or a JSON edit), they must not leak onto the
    // route — the settings are fujipicpro-only.
    mergeOrderJobs:        true,
    orderMergeWaitMinutes: 60,
  };
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-dr' }],
    orderControllers:          [controller],
    channelMappings:           [{ id: 'cm-dr-1', controllerId: 'ctrl-dr', productCode: PRODUCT, options: [] }],
  });

  const route = resolveRoute({ ...JOB });
  assert.equal(route.controllerType,          'darkroompro');
  assert.equal('mergeOrderJobs'        in route, false,
    'darkroompro routes must not carry mergeOrderJobs — the field is fujipicpro-scoped');
  assert.equal('orderMergeWaitMinutes' in route, false,
    'darkroompro routes must not carry orderMergeWaitMinutes — the field is fujipicpro-scoped');
});

// ── Override branch parity ──────────────────────────────────────────────────

test('_channelMappingOverride fujipicpro branch surfaces the same fields as the main branch', () => {
  // The override literal at ~routing-service.js:168 exists specifically
  // so reassigned jobs (crop-to-size, routing-hold release) still hit a
  // fujipicpro-shape route. If it drifts from the main literal — the
  // exact class of bug the darkroompro override branch fix documented —
  // reassigned jobs on a merge-enabled controller would silently miss
  // the merge because the field would be undefined.
  seedPicPro({ mergeOrderJobs: true, orderMergeWaitMinutes: 45 });
  const overrideJob = {
    ...JOB,
    _channelMappingOverride: 'cm-pp-1',
  };
  const route = resolveRoute(overrideJob);
  assert.equal(route.controllerType,          'fujipicpro');
  assert.equal(route.mergeOrderJobs,          true,
    'override branch must surface mergeOrderJobs — reassigned jobs must not silently miss the merge');
  assert.equal(route.orderMergeWaitMinutes,   45);
});

test('_channelMappingOverride fujipicpro branch defaults match the main branch defaults', () => {
  // Absent-field default must be identical on both paths.
  seedPicPro();
  const overrideJob = { ...JOB, _channelMappingOverride: 'cm-pp-1' };
  const route = resolveRoute(overrideJob);
  assert.equal(route.mergeOrderJobs,          false);
  assert.equal(route.orderMergeWaitMinutes,   30);
});

// Restore require shim hygiene so unrelated tests in the same worker
// aren't affected by our electron/electron-store swaps.
test.after(() => { Module.prototype.require = __originalRequire; });
