/**
 * Unit tests for validateDPOFPrintSizeCode in routing-service.js
 *
 * Step 3 of docs/orderhub-mandatory-print-size-plan.md — the save-time
 * validator that rejects a channel-mapping save whose parent is a
 * DPOF/Noritsu controller and whose printSizeCode (and legacy `size`)
 * is blank. Wired into the `ohd:routing:save-channel-mapping` IPC
 * handler alongside the existing Fuji `validateProductMappingConfig`,
 * so it covers both the modal save path and the CSV import path
 * (both go through the same IPC handler).
 *
 * This is a pure function — no store, no logger — so the test file is
 * kept minimal. Same shim shape as resolvePrintSizeCode.test.js.
 *
 * Run via: npm test
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
  app: { getPath: () => os.tmpdir(), on: () => {} },
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  if (req === 'electron')       return fakeElectron;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { validateDPOFPrintSizeCode } = require(
  path.join(REPO, 'src', 'main', 'services', 'routing-service.js'),
);


// ── Rejection cases: DPOF-family + blank printSizeCode ───────────────────────

test('validateDPOFPrintSizeCode: noritsu + blank printSizeCode → invalid', () => {
  const result = validateDPOFPrintSizeCode({ printSizeCode: '' }, 'noritsu');
  assert.equal(result.valid, false);
  assert.match(result.error, /Print Size Code is required/);
});

test('validateDPOFPrintSizeCode: noritsu + whitespace-only printSizeCode → invalid', () => {
  const result = validateDPOFPrintSizeCode({ printSizeCode: '   ' }, 'noritsu');
  assert.equal(result.valid, false);
});

test('validateDPOFPrintSizeCode: epson + blank → invalid (epson is DPOF family)', () => {
  const result = validateDPOFPrintSizeCode({ printSizeCode: '' }, 'epson');
  assert.equal(result.valid, false);
});

test('validateDPOFPrintSizeCode: untyped controller + blank → invalid (defaults to DPOF-shaped)', () => {
  // Matches what resolvePrintSizeCode does at runtime — an unset/unknown
  // controller type is treated as DPOF-shaped for the size field.
  assert.equal(validateDPOFPrintSizeCode({ printSizeCode: '' }, '').valid,        false);
  assert.equal(validateDPOFPrintSizeCode({ printSizeCode: '' }, undefined).valid, false);
  assert.equal(validateDPOFPrintSizeCode({ printSizeCode: '' }, null).valid,      false);
});


// ── Acceptance cases: DPOF-family + populated field ──────────────────────────

test('validateDPOFPrintSizeCode: noritsu + populated printSizeCode → valid', () => {
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: 'KG'  }, 'noritsu'), { valid: true });
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '4x6' }, 'noritsu'), { valid: true });
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: 'NML -PSIZE "8x4"' }, 'noritsu'), { valid: true });
});

// M3 (missing-print-size-recovery): the pre-M3 validator accepted
// `printSizeCode || size` — a mapping with `size='4x6'` and blank
// `printSizeCode` saved cleanly, then failed at dispatch because
// `resolvePrintSizeCode` reads only `printSizeCode`. Removed. Badge,
// validator, and resolver now all agree.
//
// The bare-WxH backfill (`backfillLegacyPrintSizeCode`) still runs at
// startup, so an existing DPOF-family mapping whose legacy `size` was
// a bare WxH shape has its `printSizeCode` populated by the backfill
// before the first save call reaches this validator — so removing
// the `|| size` fallback here does not break bare-WxH installs.
// The case that WAS silently allowed and now is not: `size='KG'` (or
// any non-bare-WxH string) with blank `printSizeCode`, which the
// backfill never copies and would still fail at dispatch.

test('validateDPOFPrintSizeCode: noritsu + blank printSizeCode + populated legacy `size` bare WxH → INVALID (M3)', () => {
  // Pre-M3 this returned valid. Post-M3 it does not — the operator
  // must type the code into `printSizeCode` proper, matching what the
  // dispatch-time resolver reads.
  const result = validateDPOFPrintSizeCode({ printSizeCode: '', size: '4x6' }, 'noritsu');
  assert.equal(result.valid, false);
  assert.match(result.error, /Print Size Code is required/);
});

test('validateDPOFPrintSizeCode: noritsu + blank printSizeCode + populated legacy `size` short code → INVALID (M3)', () => {
  // The pre-M3 leniency's real damage: `size='KG'` (not backfillable
  // because the backfill only copies bare-WxH values) would pass the
  // validator, save cleanly, show the amber badge, and then throw at
  // dispatch. Post-M3 the operator sees the rejection at save time
  // and can fix the mapping in place.
  const result = validateDPOFPrintSizeCode({ printSizeCode: '', size: 'KG' }, 'noritsu');
  assert.equal(result.valid, false);
  assert.match(result.error, /Print Size Code is required/);
});

test('validateDPOFPrintSizeCode: legacy `size` field is IGNORED — presence does not affect the verdict', () => {
  // Regression guard for the M3 tightening. `size` is no longer a
  // fallback source under any circumstances; only `printSizeCode` is
  // consulted.
  assert.equal(validateDPOFPrintSizeCode({ printSizeCode: 'KG', size: 'wrong' }, 'noritsu').valid, true,
    'populated printSizeCode passes even when legacy size disagrees');
  assert.equal(validateDPOFPrintSizeCode({ printSizeCode: '',   size: 'KG'    }, 'noritsu').valid, false,
    'blank printSizeCode fails even when legacy size is populated');
});


// ── Scope: non-DPOF controller types are always valid ────────────────────────

test('validateDPOFPrintSizeCode: darkroompro + blank → valid (out of scope — size lives in sizeTranslations)', () => {
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '' }, 'darkroompro'), { valid: true });
});

test('validateDPOFPrintSizeCode: fujijobmaker + blank → valid (out of scope — Fuji validator owns this)', () => {
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '' }, 'fujijobmaker'), { valid: true });
});

test('validateDPOFPrintSizeCode: fujipicpro + blank → valid (out of scope — PIC Pro validator owns this)', () => {
  // M1 (Fuji PIC Pro brief). PIC Pro mappings never carry a DPOF-style
  // printSizeCode — their crop aspect lives in the shared `printSize`
  // field, validated by fuji-pic-pro-config.validateProductMappingConfig.
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '' }, 'fujipicpro'), { valid: true });
});

test('validateDPOFPrintSizeCode: frontline + blank → valid (uses batchCode, not printSizeCode)', () => {
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '' }, 'frontline'), { valid: true });
});

test('validateDPOFPrintSizeCode: folder_copy + blank → valid (no print size at all)', () => {
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '' }, 'folder_copy'), { valid: true });
});

test('validateDPOFPrintSizeCode: pdf_copy + blank → valid (no print size at all)', () => {
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '' }, 'pdf_copy'), { valid: true });
});


// ── Defensive: null/undefined mapping ────────────────────────────────────────

test('validateDPOFPrintSizeCode: null/undefined mapping on DPOF controller → invalid', () => {
  assert.equal(validateDPOFPrintSizeCode(null,      'noritsu').valid, false);
  assert.equal(validateDPOFPrintSizeCode(undefined, 'noritsu').valid, false);
});


// Restore require shim hygiene so unrelated tests in the same worker aren't
// affected by our electron/electron-store swaps.
test.after(() => { Module.prototype.require = __originalRequire; });
