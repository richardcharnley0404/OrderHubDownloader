'use strict';

/**
 * Regression tests for the v1.7.11 → v1.7.12 Noritsu reprint fix.
 *
 * Background: sendReprint's dispatch switch matched only
 * `controllerType === 'dpof'` (or empty) for the DPOF path. Typed Noritsu
 * and Epson controllers (controllerType 'noritsu' / 'epson') fell through
 * to the "Reprints are not yet supported for controller type X" error
 * branch even though _sendReprintViaDPOF handles them correctly. Fix:
 * use the shared DPOF_TYPES classifier from services/controller-types.
 *
 * Run via:  npm test
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const path    = require('node:path');

// print-service → logger → electron.app. Same minimal fake the sibling
// print-service-discarded.test.js uses.
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

const printService = require(path.join(__dirname, '..', 'print-service.js'));

// ── Test harness ─────────────────────────────────────────────────────────────
//
// Stub routing-service.resolveRoute and the three per-type reprint methods
// so we can observe which dispatch arm sendReprint takes for each
// controllerType. The reprint methods are monkey-patched on the singleton
// before each test and restored after.

const routingService = require(path.join(__dirname, '..', 'routing-service.js'));
const originalResolveRoute = routingService.resolveRoute;

function withDispatchSpy(fn) {
  return async (t) => {
    const calls = [];
    const orig = {
      dp:  printService._sendReprintViaDarkroomPro,
      fc:  printService._sendReprintViaFolderCopy,
      dpof: printService._sendReprintViaDPOF,
    };
    printService._sendReprintViaDarkroomPro = async () => { calls.push('darkroompro'); return { success: true, method: 'darkroom-pro-reprint' }; };
    printService._sendReprintViaFolderCopy  = async () => { calls.push('folder_copy'); return { success: true, method: 'folder-copy-reprint' }; };
    printService._sendReprintViaDPOF        = async () => { calls.push('dpof');        return { success: true, method: 'dpof-reprint' }; };
    t.after(() => {
      printService._sendReprintViaDarkroomPro = orig.dp;
      printService._sendReprintViaFolderCopy  = orig.fc;
      printService._sendReprintViaDPOF        = orig.dpof;
      routingService.resolveRoute             = originalResolveRoute;
    });
    await fn(calls);
  };
}

function stubRoute(controllerType) {
  routingService.resolveRoute = () => ({
    type: 'controller',
    controllerId:   'CTRL-1',
    controllerName: 'Test',
    controllerType,
    outputPath:     '/tmp/out',
  });
}

const PARENT = { id: 1, job_name: 'PXT-1', product_code: 'P', process: 'Lab', options: [] };
const REPRINT_PATH = '/tmp/reprint';
const REPRINT_IMAGES = [{ filename: 'a.jpg', qtyCurrent: 1 }];

// ── Tests ────────────────────────────────────────────────────────────────────

test('sendReprint: controllerType "noritsu" dispatches to _sendReprintViaDPOF (the v1.7.11 bug)', withDispatchSpy(async (calls) => {
  stubRoute('noritsu');
  const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['dpof'], 'must reach the DPOF reprint pipeline, not the unsupported branch');
  assert.equal(result.success, true);
}));

test('sendReprint: controllerType "epson" dispatches to _sendReprintViaDPOF', withDispatchSpy(async (calls) => {
  stubRoute('epson');
  const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['dpof']);
  assert.equal(result.success, true);
}));

test('sendReprint: literal "dpof" still dispatches to _sendReprintViaDPOF (back-compat)', withDispatchSpy(async (calls) => {
  stubRoute('dpof');
  await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['dpof']);
}));

test('sendReprint: empty controllerType dispatches to _sendReprintViaDPOF (legacy untyped fallback)', withDispatchSpy(async (calls) => {
  stubRoute('');
  await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['dpof']);
}));

test('sendReprint: controllerType "darkroompro" still dispatches to its own method (regression guard)', withDispatchSpy(async (calls) => {
  stubRoute('darkroompro');
  await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['darkroompro']);
}));

test('sendReprint: controllerType "folder_copy" still dispatches to its own method (regression guard)', withDispatchSpy(async (calls) => {
  stubRoute('folder_copy');
  await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['folder_copy']);
}));

test('sendReprint: still-unsupported types return the not-yet-supported error', withDispatchSpy(async (calls) => {
  for (const t of ['frontline', 'fujijobmaker', 'pdf_copy']) {
    stubRoute(t);
    const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
    assert.equal(result.success, false, `${t} must not dispatch`);
    assert.match(result.error, /not yet supported for controller type/);
    assert.match(result.error, new RegExp(t));
  }
  assert.deepEqual(calls, [], 'none of the unsupported types should reach a dispatch arm');
}));

test('sendReprint: unrouted parent fails before the dispatch switch', withDispatchSpy(async (calls) => {
  routingService.resolveRoute = () => ({ type: 'unrouted', reason: 'no-controller' });
  const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.equal(result.success, false);
  assert.match(result.error, /no usable route/);
  assert.deepEqual(calls, []);
}));

// ── Shared classifier sanity ────────────────────────────────────────────────

test('controller-types.DPOF_TYPES contains noritsu, epson, dpof (single source of truth)', () => {
  const { DPOF_TYPES, isDpofType } = require(path.join(__dirname, '..', 'controller-types.js'));
  assert.equal(DPOF_TYPES.has('noritsu'), true);
  assert.equal(DPOF_TYPES.has('epson'), true);
  assert.equal(DPOF_TYPES.has('dpof'), true);
  assert.equal(DPOF_TYPES.has('darkroompro'), false);
  assert.equal(DPOF_TYPES.has('folder_copy'), false);
  // isDpofType: empty / null / undefined → true (back-compat with legacy untyped controllers)
  assert.equal(isDpofType(''),        true);
  assert.equal(isDpofType(null),      true);
  assert.equal(isDpofType(undefined), true);
  assert.equal(isDpofType('noritsu'), true);
  assert.equal(isDpofType('epson'),   true);
  assert.equal(isDpofType('dpof'),    true);
  assert.equal(isDpofType('darkroompro'),  false);
  assert.equal(isDpofType('frontline'),    false);
  assert.equal(isDpofType('fujijobmaker'), false);
});
