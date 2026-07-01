/**
 * Tests for per-controller "ignore these option names when matching" support.
 *
 * A controller may carry `ignoredOptionNames: string[]`. Options whose name is
 * on that list are stripped from BOTH the channel mapping and the job before
 * matching, so:
 *   - a mapping that still documents the ignored option no longer *requires* it
 *   - a job whose value for that option differs still matches
 *
 * Default (absent/empty list) must be byte-identical to the previous matcher.
 *
 * Store/electron are shimmed exactly like routingHold.test.js.
 *
 * Run via: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
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
const { resolveRoute, optionsMatchWithIgnore } = routingService;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FINISH = { name: 'finish-options', value: 'lustre' };

function seedFuji(ignoredOptionNames) {
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: 'ctrl-fuji' }],
    orderControllers: [{
      id: 'ctrl-fuji',
      name: 'Fuji Jobmaker',
      type: 'fujijobmaker',
      outputPath: '/out',
      ignoredOptionNames,
    }],
    channelMappings: [{
      id: 'cm1',
      controllerId: 'ctrl-fuji',
      productCode: '0406-cut-print',
      options: [FINISH, { name: 'layout-options', value: 'full-bleed' }],
      surface: 'Lustre',
      surfaceCode: 'L',
      printCode: '4x6',
    }],
  });
}

// Job carries lustre (matches) but a DIFFERENT layout value than the mapping.
const job = {
  id: 'j1',
  process: 'Lab',
  product_code: '0406-cut-print',
  options: [FINISH, { name: 'layout-options', value: 'white-border' }],
};

// ── resolveRoute integration ────────────────────────────────────────────────

test('without ignore: differing layout-options value → unrouted no-channel', () => {
  seedFuji([]);
  const route = resolveRoute(job);
  assert.equal(route.type, 'unrouted');
  assert.equal(route.reason, 'no-channel');
});

test('with ignore: layout-options stripped → mapping matches and routes', () => {
  seedFuji(['layout-options']);
  const route = resolveRoute(job);
  assert.equal(route.type, 'controller');
  assert.equal(route.controllerType, 'fujijobmaker');
  assert.equal(route.surface, 'Lustre');
  assert.equal(route.printCode, '4x6');
});

test('ignore name match is case-insensitive', () => {
  seedFuji(['Layout-Options']);
  const route = resolveRoute(job);
  assert.equal(route.type, 'controller');
});

test('ignore does not over-match: finish-options must still agree', () => {
  seedFuji(['layout-options']);
  const wrongFinish = {
    ...job,
    options: [{ name: 'finish-options', value: 'gloss' }, { name: 'layout-options', value: 'x' }],
  };
  const route = resolveRoute(wrongFinish);
  assert.equal(route.type, 'unrouted');
});

// ── optionsMatchWithIgnore unit ─────────────────────────────────────────────

test('helper: empty/absent ignore behaves as plain subset match', () => {
  const mapping = [FINISH];
  // Extra job option is already ignored by subset matching.
  assert.equal(
    optionsMatchWithIgnore(mapping, [FINISH, { name: 'layout-options', value: 'z' }], {}),
    true,
  );
  // Mapping option absent from job → no match.
  assert.equal(optionsMatchWithIgnore([{ name: 'finish-options', value: 'matte' }], [FINISH], null), false);
});

test('helper: ignored name stripped from both sides', () => {
  const mapping = [FINISH, { name: 'layout-options', value: 'full-bleed' }];
  const jobOpts = [FINISH, { name: 'layout-options', value: 'white-border' }];
  assert.equal(optionsMatchWithIgnore(mapping, jobOpts, { ignoredOptionNames: ['layout-options'] }), true);
  assert.equal(optionsMatchWithIgnore(mapping, jobOpts, { ignoredOptionNames: [] }), false);
});

// Restore require shim hygiene for any later-loaded modules in the same worker.
test.after(() => { Module.prototype.require = __originalRequire; });
