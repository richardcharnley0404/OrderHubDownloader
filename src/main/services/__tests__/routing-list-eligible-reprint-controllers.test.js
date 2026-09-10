/**
 * Tests for `routingService.listEligibleReprintControllers(job)`.
 *
 * The function powers the rush-reprint picker in the Job Review drawer.
 * Its job is to make the no-channel-mapping dead-end unreachable by
 * construction — a controller that would fail dispatch is not offered.
 *
 * Design: docs/rush-reprint-controller-selection-investigation.md §Q4.
 *
 * Eligibility is DERIVED from `resolveRouteForController(job, id).type ===
 * 'controller'`, not re-implemented; a `resolveRouteForController` change
 * (or the shape parity locked in routing-darkroompro-fields.test.js
 * subtly shifting) propagates here without a code change.
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
  if (req === 'electron')       return fakeElectron;
  if (req === 'electron-store') return FakeStore;
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
const { listEligibleReprintControllers } = routingService;

// ── Fixtures ────────────────────────────────────────────────────────────────

const PRODUCT = '0406-print';

function dpController(id, name, extra = {}) {
  return {
    id, name,
    type:                'darkroompro',
    outputPath:          `C:\\dp\\${id}\\out`,
    artworkRootPath:     'Z:\\Art',
    orderLastNameFormat: 'orderRef_lastName',
    checkOrderStatus:    true,
    ...extra,
  };
}

function dpMapping(id, controllerId) {
  return { id, controllerId, productCode: PRODUCT, options: [] };
}

const JOB = { id: 1, product_code: PRODUCT, process: 'Lab', options: [] };

// ═════════════════════════════════════════════════════════════════════════
// Basic listing
// ═════════════════════════════════════════════════════════════════════════

test('returns [] when the parent job has no controller route at all', () => {
  // No process→controller mapping seeded → resolveRoute yields unrouted.
  __seed({
    processControllerMappings: [],
    orderControllers:          [dpController('dp-1', 'DP')],
    channelMappings:           [dpMapping('cm-1', 'dp-1')],
  });
  assert.deepEqual(listEligibleReprintControllers(JOB), []);
});

test('returns only the parent-route controller when it is the only DP configured', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-1' }],
    orderControllers:          [dpController('dp-1', 'DP-650')],
    channelMappings:           [dpMapping('cm-1', 'dp-1')],
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id,   'dp-1');
  assert.equal(eligible[0].name, 'DP-650');
  assert.equal(eligible[0].isParentRoute, true);
});

test('returns both siblings when both DP controllers can take the job, parent marked isParentRoute:true', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers:          [dpController('dp-650', 'DP-650'), dpController('dp-400', 'DP-400')],
    channelMappings:           [dpMapping('cm-650', 'dp-650'), dpMapping('cm-400', 'dp-400')],
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 2);
  const byId = Object.fromEntries(eligible.map(e => [e.id, e]));
  assert.equal(byId['dp-650'].isParentRoute, true,  'the process-mapped controller must be marked as parent route');
  assert.equal(byId['dp-400'].isParentRoute, false, 'sibling controllers must be marked isParentRoute:false');
});

// ═════════════════════════════════════════════════════════════════════════
// The load-bearing filter — no-mapping controllers do NOT appear
// ═════════════════════════════════════════════════════════════════════════

test('a sibling DP controller with NO channel mapping for this product is EXCLUDED', () => {
  // DP-400 exists as a controller but has no mapping for PRODUCT — the
  // picker must not offer it because dispatch would fail no-channel.
  // This is the "make the dead-end unreachable" property.
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers:          [dpController('dp-650', 'DP-650'), dpController('dp-400', 'DP-400')],
    channelMappings:           [dpMapping('cm-650', 'dp-650')], // no DP-400 mapping
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, 'dp-650');
});

test('a sibling DP controller with a mapping for a DIFFERENT product is EXCLUDED', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers:          [dpController('dp-650', 'DP-650'), dpController('dp-400', 'DP-400')],
    channelMappings:           [
      dpMapping('cm-650', 'dp-650'),
      { id: 'cm-400-other', controllerId: 'dp-400', productCode: 'DIFFERENT-PRODUCT', options: [] },
    ],
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, 'dp-650');
});

test('a sibling DP controller whose mapping requires a specific option NOT on the job is EXCLUDED', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers:          [dpController('dp-650', 'DP-650'), dpController('dp-400', 'DP-400')],
    channelMappings: [
      dpMapping('cm-650', 'dp-650'),
      { id: 'cm-400', controllerId: 'dp-400', productCode: PRODUCT, options: [{ name: 'finish', value: 'Metallic' }] },
    ],
  });
  // Job has no `finish` option → cm-400's options requirement fails.
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, 'dp-650');
});

// ═════════════════════════════════════════════════════════════════════════
// Cross-type — a DPOF/Fuji/folder_copy sibling is NOT offered for a DP parent
// ═════════════════════════════════════════════════════════════════════════

test('a DPOF sibling controller is NOT offered when the parent routes to a DP controller', () => {
  // The whole design premise: same-type siblings only. Cross-type
  // "reprints" (e.g. DP → folder_copy) are not a defined workflow.
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers:          [
      dpController('dp-650', 'DP-650'),
      { id: 'dpof-1', name: 'Epson', type: 'epson', outputPath: '/e/out' },
    ],
    channelMappings: [
      dpMapping('cm-650', 'dp-650'),
      { id: 'cm-dpof', controllerId: 'dpof-1', productCode: PRODUCT, options: [], channelNumber: 1, printSizeCode: 'KG' },
    ],
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, 'dp-650');
});

// ═════════════════════════════════════════════════════════════════════════
// Consistency — the list drives the picker; every entry in it must actually
// dispatch. This test is the audit that ties list-eligible to sendReprint
// via resolveRouteForController — if any entry in the list would fail
// resolveRouteForController, the picker would lie.
// ═════════════════════════════════════════════════════════════════════════

test('every controller returned by listEligibleReprintControllers resolves to a controller route', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers: [
      dpController('dp-650', 'DP-650'),
      dpController('dp-400', 'DP-400'),
      dpController('dp-800', 'DP-800'),
    ],
    channelMappings: [
      dpMapping('cm-650', 'dp-650'),
      dpMapping('cm-400', 'dp-400'),
      // dp-800 has NO mapping — must be excluded.
    ],
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 2);
  for (const entry of eligible) {
    const route = routingService.resolveRouteForController(JOB, entry.id);
    assert.equal(route.type, 'controller',
      `list-eligible offered ${entry.id} but resolveRouteForController returned ${route.type}/${route.reason || ''}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Translations-only — the picker-inert-at-every-lab regression
// ═════════════════════════════════════════════════════════════════════════
//
// The rush-reprint feature shipped with a subtle bug: listEligibleReprint-
// Controllers derives its list from resolveRouteForController, which
// pre-fix required a channel mapping upstream of the darkroompro branch.
// A translations-only DP install (the common case at labs using the
// translation-tables UI) therefore returned an EMPTY list, the chevron
// never rendered, and the picker was inert everywhere. All the earlier
// list-eligible fixtures supplied a channel mapping, so the suite passed.
// Fixed by moving the darkroompro branch ahead of the mapping gate and
// giving it resolveRoute's routability rule. These tests cover the
// configuration the earlier fixtures did not.

function dpTranslationsOnly(id, name, extra = {}) {
  return {
    id, name,
    type:                'darkroompro',
    outputPath:          `C:\\dp\\${id}\\out`,
    artworkRootPath:     'Z:\\Art',
    orderLastNameFormat: 'orderRef_lastName',
    checkOrderStatus:    true,
    sizeTranslations:    [{ productCodePrefix: PRODUCT, darkroomSize: '4x6' }],
    mediaOptionKey:      '',
    mediaTranslations:   [],
    ...extra,
  };
}

test('translations-only: single DP controller with a matched sizeTranslation is ELIGIBLE (was empty pre-fix)', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-1' }],
    orderControllers:          [dpTranslationsOnly('dp-1', 'Darkroom')],
    channelMappings:           [],  // DELIBERATELY empty
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 1,
    'A translations-only DP controller with a size translation that resolves ' +
    'this product must appear in the eligible list. Pre-fix this returned [] ' +
    'because resolveRouteForController required a channel mapping — that ' +
    'defect made the rush-reprint chevron inert at every translations-only lab.');
  assert.equal(eligible[0].id,   'dp-1');
  assert.equal(eligible[0].name, 'Darkroom');
  assert.equal(eligible[0].isParentRoute, true);
});

test('translations-only: two DP siblings both eligible when translations resolve for both', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers:          [
      dpTranslationsOnly('dp-650', 'DP-650'),
      dpTranslationsOnly('dp-400', 'DP-400'),
    ],
    channelMappings:           [],
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 2);
  const byId = Object.fromEntries(eligible.map(e => [e.id, e]));
  assert.equal(byId['dp-650'].isParentRoute, true);
  assert.equal(byId['dp-400'].isParentRoute, false);
});

test('translations-only: DP sibling whose translations cannot resolve THIS product is EXCLUDED', () => {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers:          [
      dpTranslationsOnly('dp-650', 'DP-650'),
      // DP-400 translations don't cover PRODUCT.
      dpTranslationsOnly('dp-400', 'DP-400', {
        sizeTranslations: [{ productCodePrefix: 'DIFFERENT-PRODUCT', darkroomSize: '8x10' }],
      }),
    ],
    channelMappings:           [],
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 1,
    'Only DP-650 (whose translations resolve THIS product) should be eligible. ' +
    'DP-400 having translations for a different product must not smuggle it into ' +
    'the picker — a dispatch would fail no-channel and the picker\'s job is to ' +
    'make that dead-end unreachable by construction.');
  assert.equal(eligible[0].id, 'dp-650');
});

test('translations-only + one sibling with a mapping: BOTH eligible (mixed configuration)', () => {
  // Real-world variant: one lab controller is configured via translations,
  // another via a channel mapping. Both must appear in the picker.
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'dp-650' }],
    orderControllers:          [
      dpTranslationsOnly('dp-650', 'DP-650'),
      dpTranslationsOnly('dp-400', 'DP-400'),  // reuses same translations shape
    ],
    channelMappings: [
      // Explicit mapping ONLY for DP-400. DP-650 relies on its translations.
      dpMapping('cm-400', 'dp-400'),
    ],
  });
  const eligible = listEligibleReprintControllers(JOB);
  assert.equal(eligible.length, 2);
});

test.after(() => { Module.prototype.require = __originalRequire; });
