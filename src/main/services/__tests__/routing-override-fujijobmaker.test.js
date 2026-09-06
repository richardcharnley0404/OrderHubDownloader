/**
 * Tests for the fujijobmaker branch of resolveRoute's `_channelMappingOverride`
 * short-circuit — parity with the main fujijobmaker branch.
 *
 * Two literals in `resolveRoute` return a JobMaker route: the main Layer-3
 * return AFTER the override check, and the `_channelMappingOverride`
 * short-circuit that fires when a job carries the override key (used by
 * `ohd:routing:release-hold` and by crop-to-size stamping the mapping id).
 *
 * These tests lock:
 *   1. Same field SET on both branches — CLAUDE.md landmine class. If a
 *      field is added to one and forgotten on the other, downstream
 *      dispatch reading `route.<field>` gets undefined on the reassigned
 *      job but the correct value on the freshly-dispatched job — silent
 *      drift that only surfaces under an operator action that happens
 *      to hit the override path.
 *   2. `fujiImageRoot` (1.16.1) is present on BOTH branches with the
 *      correct fallback semantics: falls back to `imageStagingRoot` for
 *      controllers that predate the migration and haven't been re-saved.
 *
 * `resolveRouteForController` does NOT currently return a JobMaker-shaped
 * route — its fall-through returns a generic DPOF shape, and its
 * docstring explicitly notes that "Fuji reassignment can be added later
 * if the use case emerges". Adding fujiImageRoot to a JobMaker branch
 * that does not exist would be feature creep; the field is guaranteed
 * to reach the dispatcher via `resolveRoute`'s _channelMappingOverride
 * branch (which fires the moment the override key is persisted on the
 * job, which is what the release-hold IPC handler does immediately
 * after validating with `resolveRouteForController`).
 *
 * Store/electron shim mirrors routing-override-darkroompro.test.js.
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

const CTRL_ID     = 'ctrl-fjm';
const PRODUCT     = '0406-photo-print';
const MAPPING_ID  = 'cm-fjm-1';
const STAGING_ROOT = 'C:\\Users\\op\\Documents\\OrderHub Controllers\\Fuji Jobmaker\\Artwork';
const FUJI_ROOT    = '\\\\labserver1\\Pixfizz\\Artwork';

function seedJobMakerWithFujiRoot() {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers: [{
      id:                CTRL_ID,
      name:              'Fuji JobMaker Station 1',
      type:              'fujijobmaker',
      outputPath:        '/hot',
      imageStagingRoot:  STAGING_ROOT,
      fujiImageRoot:     FUJI_ROOT,      // configured post-1.16.1
      printerName:       'DL650-A1',
      autoCorrect:       true,
      backprintMode:     'text',
      backprintTemplate: '{jobName} {customerName}',
      checkOrderStatus:  true,
    }],
    channelMappings: [{
      id:          MAPPING_ID,
      controllerId: CTRL_ID,
      productCode:  PRODUCT,
      options:      [],
      surface:      'Lustre',
      surfaceCode:  'L',
      printCode:    '4x6',
    }],
  });
}

function seedJobMakerPreMigration() {
  // Simulates a controller that predates 1.16.1: `fujiImageRoot`
  // absent, only `imageStagingRoot` set. Migration default rule: the
  // route MUST still carry a usable fujiImageRoot, falling back to
  // imageStagingRoot.
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers: [{
      id:                CTRL_ID,
      name:              'Fuji JobMaker (pre-1.16.1)',
      type:              'fujijobmaker',
      outputPath:        '/hot',
      imageStagingRoot:  STAGING_ROOT,
      // fujiImageRoot deliberately absent
    }],
    channelMappings: [{
      id:          MAPPING_ID,
      controllerId: CTRL_ID,
      productCode:  PRODUCT,
      options:      [],
      surface:      'Lustre',
      surfaceCode:  'L',
      printCode:    '4x6',
    }],
  });
}

const baseJob = {
  id: 'j1',
  process: 'Lab',
  product_code: PRODUCT,
  options: [],
};

// ── Parity: override JobMaker route has the same field set as non-override ──

test('override fujijobmaker route has the same field set as the non-override route', () => {
  seedJobMakerWithFujiRoot();

  const nonOverride = resolveRoute(baseJob);
  const override    = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });

  assert.equal(nonOverride.type,           'controller');
  assert.equal(nonOverride.controllerType, 'fujijobmaker');
  assert.equal(override.type,              'controller');
  assert.equal(override.controllerType,    'fujijobmaker');

  // Same key set on both — the CLAUDE.md-recorded landmine class. Any
  // future field added to one branch must be added to the other, or
  // this test fails.
  assert.deepEqual(
    Object.keys(override).sort(),
    Object.keys(nonOverride).sort(),
    'override branch MUST carry the same field set as the main fujijobmaker branch',
  );
});

// ── fujiImageRoot on both branches ──────────────────────────────────────────

test('fujiImageRoot: non-override JobMaker route carries the configured value', () => {
  seedJobMakerWithFujiRoot();
  const route = resolveRoute(baseJob);
  assert.equal(route.fujiImageRoot, FUJI_ROOT,
    'non-override route MUST expose fujiImageRoot as configured');
});

test('fujiImageRoot: override JobMaker route carries the configured value', () => {
  seedJobMakerWithFujiRoot();
  const route = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });
  assert.equal(route.fujiImageRoot, FUJI_ROOT,
    'override route MUST expose fujiImageRoot as configured — release-hold reassignment must not silently drop the new field');
});

test('fujiImageRoot migration: absent field falls back to imageStagingRoot on both branches', () => {
  // Invariant (1.16.1 migration rule): a pre-1.16.1 controller has no
  // `fujiImageRoot`. On the route, the field must be pre-filled from
  // `imageStagingRoot` so that an existing controller — which by
  // definition ran with imageStagingRoot both as the write path AND as
  // the ImagePath= source — keeps working with no operator action.
  //
  // Locked on BOTH branches: the same-machine equivalence must hold
  // whether the job is dispatched fresh (main branch) or reassigned
  // by the operator (_channelMappingOverride branch).
  seedJobMakerPreMigration();
  const nonOverride = resolveRoute(baseJob);
  const override    = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });
  assert.equal(nonOverride.fujiImageRoot, STAGING_ROOT,
    'non-override route MUST fall back to imageStagingRoot when fujiImageRoot is absent (migration rule)');
  assert.equal(override.fujiImageRoot, STAGING_ROOT,
    'override route MUST fall back to imageStagingRoot when fujiImageRoot is absent (migration rule)');
});

test('fujiImageRoot: empty string on the controller falls back to imageStagingRoot on both branches', () => {
  // Guard against a persisted-with-empty-value shape (a form submit
  // that cleared the field). Same fallback as "field absent".
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID }],
    orderControllers: [{
      id:                CTRL_ID,
      name:              'Fuji JobMaker (blank fujiImageRoot)',
      type:              'fujijobmaker',
      outputPath:        '/hot',
      imageStagingRoot:  STAGING_ROOT,
      fujiImageRoot:     '',   // persisted blank
    }],
    channelMappings: [{
      id:          MAPPING_ID,
      controllerId: CTRL_ID,
      productCode:  PRODUCT,
      options:      [],
      surface:      'Lustre',
      surfaceCode:  'L',
      printCode:    '4x6',
    }],
  });
  const nonOverride = resolveRoute(baseJob);
  const override    = resolveRoute({ ...baseJob, _channelMappingOverride: MAPPING_ID });
  assert.equal(nonOverride.fujiImageRoot, STAGING_ROOT);
  assert.equal(override.fujiImageRoot,    STAGING_ROOT);
});

test.after(() => { Module.prototype.require = __originalRequire; });
