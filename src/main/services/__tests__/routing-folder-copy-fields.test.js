/**
 * Tests for the three per-controller Folder Copy fields surfaced on the
 * resolved route (M3 of docs/folder-copy-filename-templates-brief.md):
 *   - filenameTemplate:       string, default ''
 *   - destinationLayout:      'job' | 'root', default 'job'
 *   - orderNumberPrefixRules: Array<{from,to}>, default [] (M7b; legacy
 *     stripOrderNumberPrefixes string[] and 1.13.0 stripOrderNumberPrefix
 *     single-string still readable via the tolerant reader in
 *     printUtils.readOrderNumberPrefixRules)
 *
 * The critical tripwire (§11 #2 of the brief) is that both folder_copy
 * route literals — resolveRoute (~routing-service.js:410) and
 * resolveRouteForController (~:783) — must produce the SAME shape for
 * the SAME controller. The 1.12.0 PIC Pro merge bug and the epson
 * nameOpts.batch drop were both this exact class: two places that must
 * agree, one of them updated. A parity test that walks both branches
 * and compares their keys catches the whole class.
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

const FC_ID = 'ctrl-fc';

function seedFolderCopy(overrides = {}) {
  const controller = {
    id:         FC_ID,
    name:       'Folder Copy — Wide Format',
    type:       'folder_copy',
    outputPath: 'C:\\wf\\out',
    ...overrides,
  };
  __seed({
    processControllerMappings: [{ process: 'Wide Format', controllerId: FC_ID }],
    orderControllers:          [controller],
    channelMappings:           [],
  });
  return controller;
}

const JOB = { id: 7, product_code: 'CANVAS8X10', process: 'Wide Format', options: [] };

// ═════════════════════════════════════════════════════════════════════════
// Route literal parity — the tripwire (§11 #2 of the brief)
// ═════════════════════════════════════════════════════════════════════════

test('folder_copy route parity: resolveRoute and resolveRouteForController produce the same keys', () => {
  seedFolderCopy({
    filenameTemplate:       '{orderNumber}_{product}_{indexPadded}',
    destinationLayout:      'root',
    orderNumberPrefixRules: [{ from: 'PXDEMO-', to: 'PX-' }],
  });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, FC_ID);

  const keysJob  = Object.keys(viaJob).sort();
  const keysCtrl = Object.keys(viaCtrl).sort();
  assert.deepEqual(keysCtrl, keysJob,
    'both literals must expose the same key set — see the NOTE at both call sites');
});

test('folder_copy route parity: BOTH literals carry the three M3 fields', () => {
  seedFolderCopy({
    filenameTemplate:       'x',
    destinationLayout:      'job',
    orderNumberPrefixRules: [{ from: 'A-', to: '' }],
  });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.equal(typeof route.filenameTemplate,          'string');
    assert.equal(typeof route.destinationLayout,         'string');
    assert.ok(Array.isArray(route.orderNumberPrefixRules));
  }
});

test('folder_copy route parity: identical values in both literals for the same controller', () => {
  seedFolderCopy({
    filenameTemplate:       '{jobId}_{index}',
    destinationLayout:      'root',
    orderNumberPrefixRules: [{ from: 'PXDEMO-', to: 'PX-' }],
  });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, FC_ID);
  assert.equal(viaJob.filenameTemplate,       viaCtrl.filenameTemplate);
  assert.equal(viaJob.destinationLayout,      viaCtrl.destinationLayout);
  assert.deepEqual(viaJob.orderNumberPrefixRules, viaCtrl.orderNumberPrefixRules);
  assert.equal(viaJob.outputPath,             viaCtrl.outputPath);
});

// ═════════════════════════════════════════════════════════════════════════
// Read-time defaults — pre-M3 controller record must behave like today
// ═════════════════════════════════════════════════════════════════════════

test('folder_copy defaults: controller with none of the three fields → "" / "job" / []', () => {
  // No overrides — this is what a controller record saved before M3
  // shipped looks like. The three fields must resolve to their defaults
  // via BOTH literals (parity again — the tripwire also fires here).
  seedFolderCopy();
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.equal(route.filenameTemplate,                 '');
    assert.equal(route.destinationLayout,                'job');
    assert.deepEqual(route.orderNumberPrefixRules,       []);
  }
});

test('folder_copy defaults: non-string filenameTemplate falls back to blank', () => {
  seedFolderCopy({ filenameTemplate: 12345 });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.equal(route.filenameTemplate, '');
  }
});

test('folder_copy defaults: non-array orderNumberPrefixRules falls back to []', () => {
  seedFolderCopy({ orderNumberPrefixRules: true });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.deepEqual(route.orderNumberPrefixRules, []);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// M7b tolerant reader — three input shapes, one output shape
// ═════════════════════════════════════════════════════════════════════════
//
// The route literal ALWAYS surfaces orderNumberPrefixRules as
// Array<{from,to}>. The reader promotes the two legacy shapes
// (stripOrderNumberPrefixes: string[] from M7; stripOrderNumberPrefix:
// string from 1.13.0) into the pair-array shape with to:'' so downstream
// callers never have to handle the legacy shapes directly. Verifies via
// BOTH route literals.

test('M7b folder_copy: legacy M7 string[] stripOrderNumberPrefixes promoted to pair array with to:""', () => {
  seedFolderCopy({ stripOrderNumberPrefixes: ['PXDEMO-', 'ORD-'] });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.deepEqual(route.orderNumberPrefixRules,
      [{ from: 'PXDEMO-', to: '' }, { from: 'ORD-', to: '' }]);
  }
});

test('M7b folder_copy: legacy 1.13.0 single-string stripOrderNumberPrefix wrapped as single pair with to:""', () => {
  seedFolderCopy({ stripOrderNumberPrefix: 'PXDEMO-' });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.deepEqual(route.orderNumberPrefixRules, [{ from: 'PXDEMO-', to: '' }]);
  }
});

test('M7b folder_copy: new pair-array field wins when M7 string[] AND legacy string are also present', () => {
  seedFolderCopy({
    orderNumberPrefixRules:   [{ from: 'PXDEMO-', to: 'PX-' }],
    stripOrderNumberPrefixes: ['ORD', 'POS'],       // stale — must be ignored
    stripOrderNumberPrefix:   'LEGACY-',            // stale — must be ignored
  });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.deepEqual(route.orderNumberPrefixRules, [{ from: 'PXDEMO-', to: 'PX-' }]);
  }
});

test('M7b folder_copy: replacement rule surfaces the operator-typed `to` verbatim on both literals', () => {
  seedFolderCopy({
    orderNumberPrefixRules: [
      { from: 'PXDEMO-',  to: 'PX-' },
      { from: 'PXDEMO2-', to: 'PX-' },
      { from: 'ORD-',     to: '' },
    ],
  });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.deepEqual(route.orderNumberPrefixRules, [
      { from: 'PXDEMO-',  to: 'PX-' },
      { from: 'PXDEMO2-', to: 'PX-' },
      { from: 'ORD-',     to: '' },
    ]);
  }
});

test('folder_copy defaults: destinationLayout anything other than "root" resolves to "job"', () => {
  // Belt-and-braces read-time coercion — save-time validation is the
  // primary guard, but a stored controller that predates M3 or came in
  // via a hand-edited JSON should not silently switch to root.
  for (const bad of [undefined, null, '', 'JOB', 'Root', 'unknown', 0, false]) {
    seedFolderCopy({ destinationLayout: bad });
    for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
      assert.equal(route.destinationLayout, 'job',
        `destinationLayout ${JSON.stringify(bad)} must fall back to "job"`);
    }
  }
});

test('folder_copy: valid destinationLayout "root" passes through both literals', () => {
  seedFolderCopy({ destinationLayout: 'root' });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, FC_ID)]) {
    assert.equal(route.destinationLayout, 'root');
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Scope: non-folder_copy controllers must NOT carry these fields
// ═════════════════════════════════════════════════════════════════════════

test('non-folder_copy controllers do NOT carry the three M3 fields on their routes', () => {
  // Even if the operator (or a stale UI) somehow stored these on a
  // Darkroom Pro record, the route must not surface them — the fields
  // are folder_copy-scoped. Same shape-scoping the mergeOrderJobs tests
  // do for fujipicpro.
  const dr = {
    id:         'ctrl-dr',
    name:       'Darkroom Pro',
    type:       'darkroompro',
    outputPath: 'C:\\dr\\hot',
    filenameTemplate:       'should-not-leak',
    destinationLayout:      'root',
    orderNumberPrefixRules: [{ from: 'X-', to: '' }],
  };
  __seed({
    processControllerMappings: [{ process: 'Wide Format', controllerId: 'ctrl-dr' }],
    orderControllers:          [dr],
    channelMappings:           [{
      id:           'cm-dr-1',
      controllerId: 'ctrl-dr',
      productCode:  'CANVAS8X10',
      options:      [],
    }],
  });
  const route = resolveRoute(JOB);
  assert.equal(route.controllerType, 'darkroompro');
  assert.equal(route.filenameTemplate,          undefined);
  assert.equal(route.destinationLayout,         undefined);
  assert.equal(route.orderNumberPrefixRules,    undefined);
});
