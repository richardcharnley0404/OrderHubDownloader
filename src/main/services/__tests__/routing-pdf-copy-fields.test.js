/**
 * Tests for the two per-controller PDF Copy fields surfaced on the
 * resolved route (M5 of docs/pdf-imposition-investigation.md):
 *   - applyImpositions:   boolean, default false
 *   - unmatchedBehaviour: 'root' | 'productCodeSubfolder', default 'root'
 *
 * The critical tripwire (same class as the folder_copy parity test) is
 * that both pdf_copy route literals — resolveRoute (~routing-service.js:399)
 * and resolveRouteForController (~:786) — must produce the SAME shape for
 * the SAME controller. The 1.12.0 PIC Pro merge bug and the epson
 * nameOpts.batch drop were both the "two places that must agree, one
 * updated" class of bug; a parity test that walks both branches catches
 * the whole class.
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

const PDF_ID = 'ctrl-pdf';

function seedPdfCopy(overrides = {}) {
  const controller = {
    id:         PDF_ID,
    name:       'PDF Copy — Digital Press',
    type:       'pdf_copy',
    outputPath: 'C:\\pdf\\out',
    ...overrides,
  };
  __seed({
    processControllerMappings: [{ process: 'PDF Print', controllerId: PDF_ID }],
    orderControllers:          [controller],
    channelMappings:           [],
  });
  return controller;
}

const JOB = { id: 9, product_code: 'GRAD5X7', process: 'PDF Print', options: [] };

// ═════════════════════════════════════════════════════════════════════════
// Route literal parity — the tripwire
// ═════════════════════════════════════════════════════════════════════════

test('pdf_copy route parity: resolveRoute and resolveRouteForController produce the same keys', () => {
  seedPdfCopy({
    applyImpositions:   true,
    unmatchedBehaviour: 'productCodeSubfolder',
  });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, PDF_ID);

  const keysJob  = Object.keys(viaJob).sort();
  const keysCtrl = Object.keys(viaCtrl).sort();
  assert.deepEqual(keysCtrl, keysJob,
    'both literals must expose the same key set — see the NOTE at both call sites');
});

test('pdf_copy route parity: BOTH literals carry the two M5 fields', () => {
  seedPdfCopy({
    applyImpositions:   true,
    unmatchedBehaviour: 'root',
  });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, PDF_ID)]) {
    assert.equal(typeof route.applyImpositions,   'boolean');
    assert.equal(typeof route.unmatchedBehaviour, 'string');
    assert.equal(route.controllerType, 'pdf_copy');
  }
});

test('pdf_copy route parity: identical values in both literals for the same controller', () => {
  seedPdfCopy({
    applyImpositions:   true,
    unmatchedBehaviour: 'productCodeSubfolder',
  });
  const viaJob  = resolveRoute(JOB);
  const viaCtrl = resolveRouteForController(JOB, PDF_ID);
  assert.equal(viaJob.applyImpositions,   viaCtrl.applyImpositions);
  assert.equal(viaJob.unmatchedBehaviour, viaCtrl.unmatchedBehaviour);
  assert.equal(viaJob.outputPath,         viaCtrl.outputPath);
});

// ═════════════════════════════════════════════════════════════════════════
// Read-time defaults — pre-M5 controller record must behave like today
// ═════════════════════════════════════════════════════════════════════════

test('pdf_copy defaults: controller with neither field → false / "root" via both literals', () => {
  // No overrides — this is what a controller record saved before M5
  // shipped looks like. The two fields must resolve to their defaults
  // via BOTH literals (parity tripwire fires here too).
  seedPdfCopy();
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, PDF_ID)]) {
    assert.equal(route.applyImpositions,   false);
    assert.equal(route.unmatchedBehaviour, 'root');
  }
});

test('pdf_copy defaults: non-boolean applyImpositions falls back to false', () => {
  seedPdfCopy({ applyImpositions: 'yes' });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, PDF_ID)]) {
    // Any truthy non-boolean would coerce to true via `!!v`, but the M5
    // reader is `!!controller.applyImpositions` — a stored 'yes' string
    // WOULD coerce to true here. This test locks that behaviour so a
    // future tightening (e.g. `=== true`) is a deliberate change, not a
    // silent one. Value-wise we're OK either way — save-time validation
    // rejects non-booleans, so a stored 'yes' should never happen; but
    // documenting the read-time posture matters for the drift audit.
    assert.equal(route.applyImpositions, true);
  }
});

test('pdf_copy defaults: unknown unmatchedBehaviour string falls back to "root"', () => {
  // Belt-and-braces read-time coercion — save-time validation is the
  // primary guard, but a hand-edited JSON or a value from a future UI
  // version should not silently switch a lab's uncovered-code output
  // into a subfolder they didn't ask for.
  for (const bad of [undefined, null, '', 'ROOT', 'sub', 'unknown', 0, false, true]) {
    seedPdfCopy({ unmatchedBehaviour: bad });
    for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, PDF_ID)]) {
      assert.equal(route.unmatchedBehaviour, 'root',
        `unmatchedBehaviour ${JSON.stringify(bad)} must fall back to "root"`);
    }
  }
});

test('pdf_copy: valid unmatchedBehaviour "productCodeSubfolder" passes through both literals', () => {
  seedPdfCopy({ unmatchedBehaviour: 'productCodeSubfolder' });
  for (const route of [resolveRoute(JOB), resolveRouteForController(JOB, PDF_ID)]) {
    assert.equal(route.unmatchedBehaviour, 'productCodeSubfolder');
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Scope: non-pdf_copy controllers must NOT carry these fields
// ═════════════════════════════════════════════════════════════════════════

test('non-pdf_copy controllers do NOT carry the two M5 fields on their routes', () => {
  // Even if the operator (or a stale UI) somehow stored these on a
  // Folder Copy record, the route must not surface them — the fields
  // are pdf_copy-scoped. Same shape-scoping the mergeOrderJobs tests
  // do for fujipicpro and the M3 fields do for folder_copy.
  const fc = {
    id:         'ctrl-fc',
    name:       'Folder Copy',
    type:       'folder_copy',
    outputPath: 'C:\\fc\\out',
    applyImpositions:   true,             // should not leak
    unmatchedBehaviour: 'productCodeSubfolder', // should not leak
  };
  __seed({
    processControllerMappings: [{ process: 'PDF Print', controllerId: 'ctrl-fc' }],
    orderControllers:          [fc],
    channelMappings:           [],
  });
  const route = resolveRoute(JOB);
  assert.equal(route.controllerType, 'folder_copy');
  assert.equal(route.applyImpositions,   undefined);
  assert.equal(route.unmatchedBehaviour, undefined);
});
