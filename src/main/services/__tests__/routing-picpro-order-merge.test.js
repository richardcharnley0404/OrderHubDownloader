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
  __warnings.length = 0;
}

const fakeElectron = {
  app: { getPath: () => os.tmpdir(), on: () => {} },
};

// Warning-capturing logger stub — required for the M1 coercion warn
// assertions. Every other log method is a no-op.
const __warnings = [];
const fakeLogger = {
  info:       () => {},
  warn:       () => {},
  error:      () => {},
  debug:      () => {},
  logInfo:    () => {},
  logError:   () => {},
  logDebug:   () => {},
  logWarning: (message, meta = {}) => __warnings.push({ message, meta }),
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  if (req === 'electron')       return fakeElectron;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

// Route the logger require to our spy BEFORE requiring routing-service
// so the spy is what routing-service sees at module load. require.cache
// is keyed by resolved absolute path — same pattern as
// routing-backfill-print-size.test.js.
{
  const loggerPath = require.resolve(path.join(REPO, 'src', 'main', 'services', 'logger.js'));
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: fakeLogger };
}

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

// ── orderNumberPrefixRules (v1.12.2 → M7 → M7b) — pair array, both branches
//
// M7b renamed the field from stripOrderNumberPrefixes: string[] to
// orderNumberPrefixRules: Array<{from,to}>. The tolerant reader in
// printUtils.readOrderNumberPrefixRules accepts three shapes on the
// controller record (M7b pair array, M7 string[], 1.13.0 single
// string); the route literal ALWAYS surfaces the pair-array shape.
// Both fujipicpro literals (main branch + _channelMappingOverride
// branch) must agree — see the fujipicpro parity test near the bottom
// of this section.

test('fujipicpro route: orderNumberPrefixRules persists to the route', () => {
  seedPicPro({ orderNumberPrefixRules: [{ from: 'PXDEMO-', to: 'PX-' }] });
  const route = resolveRoute(JOB);
  assert.deepEqual(route.orderNumberPrefixRules, [{ from: 'PXDEMO-', to: 'PX-' }]);
});

test('fujipicpro route: absent orderNumberPrefixRules defaults to [] (no rules applied)', () => {
  seedPicPro();
  const route = resolveRoute(JOB);
  assert.deepEqual(route.orderNumberPrefixRules, [],
    'default is empty — the feature is opt-in per controller');
});

test('fujipicpro route: non-array orderNumberPrefixRules defaults to [] (no rules applied)', () => {
  // A malformed value from a bad IPC payload or a stale JSON edit must
  // fail closed to "no rules" rather than throwing at dispatch.
  for (const bad of [null, undefined, 42, true, {}]) {
    seedPicPro({ orderNumberPrefixRules: bad });
    const route = resolveRoute(JOB);
    assert.deepEqual(route.orderNumberPrefixRules, [], `bad value ${JSON.stringify(bad)} defaults to []`);
  }
});

test('M7b fujipicpro route: legacy M7 string[] stripOrderNumberPrefixes promoted to pair array with to:""', () => {
  seedPicPro({ stripOrderNumberPrefixes: ['PXDEMO-', 'ORD-'] });
  const route = resolveRoute(JOB);
  assert.deepEqual(route.orderNumberPrefixRules,
    [{ from: 'PXDEMO-', to: '' }, { from: 'ORD-', to: '' }]);
});

test('M7b fujipicpro route: legacy 1.13.0 single-string stripOrderNumberPrefix wrapped as single pair with to:""', () => {
  seedPicPro({ stripOrderNumberPrefix: 'PXDEMO-' });
  const route = resolveRoute(JOB);
  assert.deepEqual(route.orderNumberPrefixRules, [{ from: 'PXDEMO-', to: '' }]);
});

test('M7b fujipicpro route: multiple pair rules surface in configured order (helper does the sort at dispatch)', () => {
  seedPicPro({ orderNumberPrefixRules: [
    { from: 'ORD-',     to: '' },
    { from: 'PXDEMO-',  to: 'PX-' },
    { from: 'PXDEMO2-', to: 'PX-' },
  ] });
  const route = resolveRoute(JOB);
  assert.deepEqual(route.orderNumberPrefixRules, [
    { from: 'ORD-',     to: '' },
    { from: 'PXDEMO-',  to: 'PX-' },
    { from: 'PXDEMO2-', to: 'PX-' },
  ]);
});

test('M7b _channelMappingOverride fujipicpro branch carries orderNumberPrefixRules in parity with the main branch', () => {
  // Same drift-prevention posture as mergeOrderJobs above.
  seedPicPro({ orderNumberPrefixRules: [{ from: 'DIVPRINTS-', to: '' }] });
  const overrideJob = { ...JOB, _channelMappingOverride: 'cm-pp-1' };
  const route = resolveRoute(overrideJob);
  assert.deepEqual(route.orderNumberPrefixRules, [{ from: 'DIVPRINTS-', to: '' }],
    'override branch must surface orderNumberPrefixRules so reassigned jobs are transformed identically to the main path');
});

test('M7b fujipicpro parity: main and override branches produce the SAME key set', () => {
  // The load-bearing parity test. Both fujipicpro literals in
  // routing-service.js are hand-written; if any future field is added
  // to one and not the other, THIS test catches it (the darkroompro
  // fix's original class of bug). Analogous to the folder_copy parity
  // test in routing-folder-copy-fields.test.js.
  seedPicPro({
    mergeOrderJobs:         true,
    orderMergeWaitMinutes:  45,
    orderNumberPrefixRules: [{ from: 'PXDEMO-', to: 'PX-' }, { from: 'POS-', to: '' }],
  });
  const mainRoute     = resolveRoute(JOB);
  const overrideRoute = resolveRoute({ ...JOB, _channelMappingOverride: 'cm-pp-1' });

  const keysMain     = Object.keys(mainRoute).sort();
  const keysOverride = Object.keys(overrideRoute).sort();
  assert.deepEqual(keysOverride, keysMain,
    'the two fujipicpro literals must expose the same key set — see the NOTE at both call sites');

  // Also confirm the specific M7b field values match — key-set parity
  // alone doesn't lock the VALUE. This is the drift-prevention pair.
  assert.deepEqual(mainRoute.orderNumberPrefixRules, overrideRoute.orderNumberPrefixRules);
  assert.equal(mainRoute.mergeOrderJobs,        overrideRoute.mergeOrderJobs);
  assert.equal(mainRoute.orderMergeWaitMinutes, overrideRoute.orderMergeWaitMinutes);
});

test('darkroompro route: orderNumberPrefixRules is NOT on the route (fujipicpro/folder_copy-scoped)', () => {
  const controller = {
    id:         'ctrl-dr',
    name:       'Darkroom Pro',
    type:       'darkroompro',
    outputPath: 'C:\\dr\\hot',
    // Even if this field somehow ends up on a darkroompro record (stale
    // UI, hand-edited JSON), it must not leak onto the route.
    orderNumberPrefixRules: [{ from: 'PXDEMO-', to: '' }],
  };
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-dr' }],
    orderControllers:          [controller],
    channelMappings:           [{ id: 'cm-dr-1', controllerId: 'ctrl-dr', productCode: PRODUCT, options: [] }],
  });
  const route = resolveRoute({ ...JOB });
  assert.equal(route.controllerType, 'darkroompro');
  assert.equal('orderNumberPrefixRules' in route, false,
    'darkroompro routes must not carry orderNumberPrefixRules — the field is fujipicpro/folder_copy-scoped');
});

// ── Read-time coercion warn (M1 follow-up) ──────────────────────────────────
//
// A silent coercion of orderMergeWaitMinutes to 30 hides a
// misconfiguration. Read-time warn fires when the stored value is
// defined-but-invalid; null / undefined / valid values stay silent.
// Deduped per (controllerId, value) so a corrupt controller doesn't
// flood the log across the ~1440 resolveRoute calls in a 24h period.
//
// Each test that exercises the warn uses a distinct controller id so
// the module-level dedup Set doesn't cross-contaminate tests.

function seedPicProWithId(id, overrides = {}) {
  const controller = {
    id,
    name:              `PIC Pro ${id}`,
    type:              'fujipicpro',
    orderDataPath:     'C:\\pp\\order',
    diginPath:         'C:\\pp\\digin',
    mergeDataPath:     'C:\\pp\\merge',
    imageStagingRoot:  'C:\\pp\\stage',
    ...overrides,
  };
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: id }],
    orderControllers:          [controller],
    channelMappings:           [{
      id: `cm-${id}`, controllerId: id, productCode: PRODUCT, options: [],
      surface: 'Lustre', surfaceCode: 'L', printCode: 'KG', color: 'C', printSize: '6x4',
    }],
  });
}

test('read-time coercion warn: corrupt orderMergeWaitMinutes → warn with meta, route still resolves to 30', () => {
  seedPicProWithId('ctrl-pp-warn-1', { orderMergeWaitMinutes: 9999 });
  const route = resolveRoute(JOB);
  assert.equal(route.orderMergeWaitMinutes, 30, 'route still coerces to 30');
  const warn = __warnings.find(w => /orderMergeWaitMinutes coerced/i.test(w.message));
  assert.ok(warn, 'a warn must fire when the stored value is out of range');
  assert.equal(warn.meta.controllerId,          'ctrl-pp-warn-1');
  assert.equal(warn.meta.name,                  'PIC Pro ctrl-pp-warn-1');
  assert.equal(warn.meta.orderMergeWaitMinutes, 9999);
  assert.equal(warn.meta.appliedDefault,        30);
});

test('read-time coercion warn: null does NOT warn (legitimate "use default")', () => {
  seedPicProWithId('ctrl-pp-warn-null', { orderMergeWaitMinutes: null });
  resolveRoute(JOB);
  const warn = __warnings.find(w => /orderMergeWaitMinutes coerced/i.test(w.message));
  assert.equal(warn, undefined, 'null is the explicit "use default" — no warn');
});

test('read-time coercion warn: undefined does NOT warn (absent field)', () => {
  seedPicProWithId('ctrl-pp-warn-absent');   // no orderMergeWaitMinutes at all
  resolveRoute(JOB);
  const warn = __warnings.find(w => /orderMergeWaitMinutes coerced/i.test(w.message));
  assert.equal(warn, undefined, 'absent field is the "use default" state — no warn');
});

test('read-time coercion warn: valid value does NOT warn', () => {
  seedPicProWithId('ctrl-pp-warn-valid', { orderMergeWaitMinutes: 60 });
  resolveRoute(JOB);
  const warn = __warnings.find(w => /orderMergeWaitMinutes coerced/i.test(w.message));
  assert.equal(warn, undefined, 'a valid in-range integer is fine — no warn');
});

test('read-time coercion warn: dedup — same (controllerId, value) warns once across many resolves', () => {
  // Dedup prevents ~1440 warns/day on a single stuck controller.
  seedPicProWithId('ctrl-pp-warn-dedup', { orderMergeWaitMinutes: 5000 });
  for (let i = 0; i < 10; i++) resolveRoute(JOB);
  const warns = __warnings.filter(w => /orderMergeWaitMinutes coerced/i.test(w.message));
  assert.equal(warns.length, 1, '10 resolves on the same corrupt config must produce exactly 1 warn');
});

test('read-time coercion warn: dedup key includes VALUE — a changed corrupt value warns again', () => {
  // If the store is edited between resolves (e.g. an external process
  // wrote a different bad value), the new value should re-warn. The
  // dedup key is (controllerId, JSON.stringify(value)) — different
  // values on the same controller are treated as separate misconfigs.
  const id = 'ctrl-pp-warn-changing';
  seedPicProWithId(id, { orderMergeWaitMinutes: 2000 });
  resolveRoute(JOB);
  // Mutate the stored value in place (simulating a corrupt config
  // change without a full re-seed, so the earlier dedup entry stays
  // recorded).
  __storeData.orderControllers[0].orderMergeWaitMinutes = 3000;
  resolveRoute(JOB);
  const warns = __warnings.filter(w =>
    /orderMergeWaitMinutes coerced/i.test(w.message)
    && w.meta.controllerId === id
  );
  assert.equal(warns.length, 2, 'a different bad value must produce a fresh warn');
  assert.deepEqual(warns.map(w => w.meta.orderMergeWaitMinutes), [2000, 3000]);
});

test('read-time coercion warn: two different controllers with the same corrupt value each warn once', () => {
  // Prove the dedup key includes controllerId — otherwise a shared
  // corrupt value across two controllers would surface only one.
  const id1 = 'ctrl-pp-warn-multi-a';
  const id2 = 'ctrl-pp-warn-multi-b';
  const controllers = [
    { id: id1, name: `PIC Pro ${id1}`, type: 'fujipicpro',
      orderDataPath: '/o', diginPath: '/d', mergeDataPath: '/m', imageStagingRoot: '/s',
      orderMergeWaitMinutes: 7777 },
    { id: id2, name: `PIC Pro ${id2}`, type: 'fujipicpro',
      orderDataPath: '/o', diginPath: '/d', mergeDataPath: '/m', imageStagingRoot: '/s',
      orderMergeWaitMinutes: 7777 },
  ];
  const mappings = controllers.map(c => ({
    id: `cm-${c.id}`, controllerId: c.id, productCode: PRODUCT, options: [],
    surface: 'Lustre', surfaceCode: 'L', printCode: 'KG', color: 'C', printSize: '6x4',
  }));
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: id1 }],
    orderControllers:          controllers,
    channelMappings:           mappings,
  });
  resolveRoute({ ...JOB, process: 'Lab' });
  // resolveRouteForController not exercised here — the second one
  // rides in via the same resolveRoute path by targeting a different
  // process mapping. Easier: swap the process mapping to id2 and
  // resolve again.
  __storeData.processControllerMappings = [{ process: 'Lab', controllerId: id2 }];
  resolveRoute({ ...JOB, process: 'Lab' });

  const warnsA = __warnings.filter(w =>
    /orderMergeWaitMinutes coerced/i.test(w.message) && w.meta.controllerId === id1
  );
  const warnsB = __warnings.filter(w =>
    /orderMergeWaitMinutes coerced/i.test(w.message) && w.meta.controllerId === id2
  );
  assert.equal(warnsA.length, 1, `${id1} must warn exactly once`);
  assert.equal(warnsB.length, 1, `${id2} must warn exactly once (different controller, same value → separate dedup key)`);
});

// Restore require shim hygiene so unrelated tests in the same worker
// aren't affected by our electron/electron-store swaps.
test.after(() => { Module.prototype.require = __originalRequire; });
