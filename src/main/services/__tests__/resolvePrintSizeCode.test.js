/**
 * Unit tests for resolvePrintSizeCode in routing-service.js
 *
 * Resolves a channel mapping's Print Size Code into the exact value emitted
 * as `PRT PSL=...` in DPOF AUTPRINT.MRK files. Background: Noritsu rejects
 * bare sizes like `4x6` — they must be wrapped as `NML -PSIZE "4x6"`.
 * Standard codes (KG, 2L, A4) and operator-pre-formatted NML strings must
 * pass through unchanged.
 *
 * routing-service requires electron + electron-store at module load. We
 * shim both via Module.prototype.require so the file loads without an
 * electron runtime — same pattern as config-service-bom.test.js.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

function FakeStore() {
  return { get: (_k, d) => d, set: () => {}, delete: () => {}, has: () => false };
}

const fakeElectron = {
  app: {
    getPath: () => os.tmpdir(),
    on: () => {},
  },
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  if (req === 'electron')       return fakeElectron;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { resolvePrintSizeCode } = require(
  path.join(REPO, 'src', 'main', 'services', 'routing-service.js')
);


test('resolvePrintSizeCode: blank → empty string (no fallback to KG)', () => {
  // The blank-branch fallback to 'KG' was removed in step 3 of the
  // mandatory-print-size plan. A blank/whitespace printSizeCode now
  // returns '' so the step-1 dispatch gate in print-service fires with
  // an operator-actionable error instead of silently printing at KG.
  // Save-time validation prevents new blank mappings from being persisted;
  // the step-2 backfill migration cleaned up existing installs.
  assert.equal(resolvePrintSizeCode({ printSizeCode: '' }),    '');
  assert.equal(resolvePrintSizeCode({ printSizeCode: null }),  '');
  assert.equal(resolvePrintSizeCode({}),                       '');
  assert.equal(resolvePrintSizeCode({ printSizeCode: '   ' }), '');
});

test('resolvePrintSizeCode: blank + legacy size field → empty string (legacy fallback removed)', () => {
  // Previously a blank printSizeCode with a populated `size` returned
  // `NML -PSIZE "<size>"`. That fallback was removed in step 3; the
  // step-2 backfill has already copied bare-WxH legacy sizes into
  // `printSizeCode` so this path only fires now for mappings that
  // were mis-configured (non-WxH legacy value the backfill skipped) or
  // never touched at all.
  assert.equal(resolvePrintSizeCode({ size: '4x6' }), '');
  assert.equal(resolvePrintSizeCode({ size: 'KG'  }), '');
});

test('resolvePrintSizeCode: standard short code passes through', () => {
  assert.equal(resolvePrintSizeCode({ printSizeCode: 'KG' }), 'KG');
  assert.equal(resolvePrintSizeCode({ printSizeCode: '2L' }), '2L');
  assert.equal(resolvePrintSizeCode({ printSizeCode: 'A4' }), 'A4');
});

test('resolvePrintSizeCode: bare WxH gets wrapped as NML -PSIZE', () => {
  assert.equal(resolvePrintSizeCode({ printSizeCode: '4x6' }),  'NML -PSIZE "4x6"');
  assert.equal(resolvePrintSizeCode({ printSizeCode: '8x10' }), 'NML -PSIZE "8x10"');
});

test('resolvePrintSizeCode: Unicode × normalised to ASCII x', () => {
  assert.equal(resolvePrintSizeCode({ printSizeCode: '4×6' }), 'NML -PSIZE "4x6"');
});

test('resolvePrintSizeCode: decimal sizes wrap correctly', () => {
  assert.equal(resolvePrintSizeCode({ printSizeCode: '4.5x6.5' }), 'NML -PSIZE "4.5x6.5"');
});

test('resolvePrintSizeCode: whitespace tolerated and stripped', () => {
  assert.equal(resolvePrintSizeCode({ printSizeCode: '8 x 10' }),   'NML -PSIZE "8x10"');
  assert.equal(resolvePrintSizeCode({ printSizeCode: '  4x6  ' }),  'NML -PSIZE "4x6"');
});

test('resolvePrintSizeCode: pre-formatted NML -PSIZE passes through unchanged', () => {
  assert.equal(
    resolvePrintSizeCode({ printSizeCode: 'NML -PSIZE "8x4"' }),
    'NML -PSIZE "8x4"'
  );
});


// Restore the original require so subsequent tests in the same node process
// aren't affected by our shim.
Module.prototype.require = __originalRequire;
