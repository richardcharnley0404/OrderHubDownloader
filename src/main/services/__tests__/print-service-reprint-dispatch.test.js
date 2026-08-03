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
      dp:    printService._sendReprintViaDarkroomPro,
      fc:    printService._sendReprintViaFolderCopy,
      dpof:  printService._sendReprintViaDPOF,
      fuji:  printService._sendReprintViaFujiJobMaker,
      pp:    printService._sendReprintViaFujiPicPro,
      pdf:   printService._sendReprintViaPdfCopy,
      front: printService._sendReprintViaFrontline,
    };
    printService._sendReprintViaDarkroomPro  = async () => { calls.push('darkroompro');  return { success: true, method: 'darkroom-pro-reprint' }; };
    printService._sendReprintViaFolderCopy   = async () => { calls.push('folder_copy');  return { success: true, method: 'folder-copy-reprint' }; };
    printService._sendReprintViaDPOF         = async () => { calls.push('dpof');         return { success: true, method: 'dpof-reprint' }; };
    printService._sendReprintViaFujiJobMaker = async () => { calls.push('fujijobmaker'); return { success: true, method: 'fujijobmaker-reprint' }; };
    printService._sendReprintViaFujiPicPro   = async () => { calls.push('fujipicpro');   return { success: true, method: 'fujipicpro-reprint' }; };
    printService._sendReprintViaPdfCopy      = async () => { calls.push('pdf_copy');     return { success: true, method: 'pdf_copy-reprint' }; };
    printService._sendReprintViaFrontline    = async () => { calls.push('frontline');    return { success: true, method: 'frontline-reprint' }; };
    t.after(() => {
      printService._sendReprintViaDarkroomPro  = orig.dp;
      printService._sendReprintViaFolderCopy   = orig.fc;
      printService._sendReprintViaDPOF         = orig.dpof;
      printService._sendReprintViaFujiJobMaker = orig.fuji;
      printService._sendReprintViaFujiPicPro   = orig.pp;
      printService._sendReprintViaPdfCopy      = orig.pdf;
      printService._sendReprintViaFrontline    = orig.front;
      routingService.resolveRoute              = originalResolveRoute;
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

test('sendReprint: controllerType "fujijobmaker" dispatches to _sendReprintViaFujiJobMaker (Phase 3a)', withDispatchSpy(async (calls) => {
  stubRoute('fujijobmaker');
  const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['fujijobmaker'], 'must reach the Fuji JobMaker reprint pipeline');
  assert.equal(result.success, true);
}));

test('sendReprint: controllerType "fujipicpro" dispatches to _sendReprintViaFujiPicPro (M5)', withDispatchSpy(async (calls) => {
  stubRoute('fujipicpro');
  const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['fujipicpro'], 'must reach the Fuji PIC Pro reprint pipeline (not fall through to the unsupported branch)');
  assert.equal(result.success, true);
}));

test('sendReprint: controllerType "pdf_copy" dispatches to _sendReprintViaPdfCopy (Phase 3b)', withDispatchSpy(async (calls) => {
  stubRoute('pdf_copy');
  const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['pdf_copy'], 'must reach the PDF-copy reprint pipeline');
  assert.equal(result.success, true);
}));

test('sendReprint: controllerType "frontline" dispatches to _sendReprintViaFrontline (Phase 3c)', withDispatchSpy(async (calls) => {
  stubRoute('frontline');
  const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.deepEqual(calls, ['frontline'], 'must reach the Frontline reprint pipeline');
  assert.equal(result.success, true);
}));

// ── Matrix-complete assertion ────────────────────────────────────────────────
//
// Every controllerType the system can produce must route to a reprint
// dispatch arm. With Phase 3c landed the "not yet supported" branch should
// be unreachable for any configured controller — only truly-unknown types
// (e.g. typos, future-but-unwired types) should hit it.

test('sendReprint: reprint matrix is complete — every configured controllerType dispatches', withDispatchSpy(async (calls) => {
  const matrix = [
    { type: '',             arm: 'dpof'         }, // legacy untyped → DPOF
    { type: 'dpof',         arm: 'dpof'         },
    { type: 'noritsu',      arm: 'dpof'         },
    { type: 'epson',        arm: 'dpof'         },
    { type: 'darkroompro',  arm: 'darkroompro'  },
    { type: 'folder_copy',  arm: 'folder_copy'  },
    { type: 'fujijobmaker', arm: 'fujijobmaker' },
    { type: 'fujipicpro',   arm: 'fujipicpro'   },
    { type: 'pdf_copy',     arm: 'pdf_copy'     },
    { type: 'frontline',    arm: 'frontline'    },
  ];

  for (const { type, arm } of matrix) {
    calls.length = 0;
    stubRoute(type);
    const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
    assert.equal(result.success, true, `controllerType "${type}" must dispatch (matrix-complete invariant)`);
    assert.deepEqual(calls, [arm], `controllerType "${type}" must reach the "${arm}" reprint arm`);
  }
}));

test('sendReprint: truly-unknown controllerType still returns the not-yet-supported error (forward-compat)', withDispatchSpy(async (calls) => {
  // The unsupported branch isn't dead — it's the safety net for typos in
  // routing config or future controller types added to routing-service
  // ahead of their reprint dispatcher. Pinning the message keeps the
  // operator-facing error from regressing into a raw crash.
  stubRoute('totally-fictional-controller-type');
  const result = await printService.sendReprint(PARENT, REPRINT_PATH, 'r1', REPRINT_IMAGES);
  assert.equal(result.success, false);
  assert.match(result.error, /not yet supported for controller type/);
  assert.match(result.error, /totally-fictional-controller-type/);
  assert.deepEqual(calls, [], 'unknown types must not reach any dispatch arm');
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
  // M1 (Fuji PIC Pro brief): controller-types.js is the DPOF classifier
  // ONLY. fujipicpro is a non-DPOF controller — its dispatch pipeline
  // and monitor are separate from the DPOF path. Pinning this here so
  // a future change that accidentally adds it to DPOF_TYPES breaks
  // loudly rather than mis-routing PIC Pro jobs to the DPOF reprint
  // arm at runtime.
  assert.equal(isDpofType('fujipicpro'), false,
    'fujipicpro is NON-DPOF — see docs/fuji-pic-pro-claude-code-brief.md §M1');
});
