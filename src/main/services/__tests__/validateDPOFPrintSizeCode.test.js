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


// ── Rejection cases: DPOF-family + blank field ───────────────────────────────

test('validateDPOFPrintSizeCode: noritsu + blank printSizeCode + blank size → invalid', () => {
  const result = validateDPOFPrintSizeCode({ printSizeCode: '', size: '' }, 'noritsu');
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

test('validateDPOFPrintSizeCode: noritsu + blank printSizeCode BUT populated legacy size → valid', () => {
  // Belt-and-braces: legacy `size` counts as a source. This should be
  // rare after the step-2 backfill (which copies bare-WxH `size` into
  // `printSizeCode` at startup), but the check still passes so a
  // save via a code path that predates the migration keeps working.
  const result = validateDPOFPrintSizeCode({ printSizeCode: '', size: '4x6' }, 'noritsu');
  assert.equal(result.valid, true);
});


// ── Scope: non-DPOF controller types are always valid ────────────────────────

test('validateDPOFPrintSizeCode: darkroompro + blank → valid (out of scope — size lives in sizeTranslations)', () => {
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '' }, 'darkroompro'), { valid: true });
});

test('validateDPOFPrintSizeCode: fujijobmaker + blank → valid (out of scope — Fuji validator owns this)', () => {
  assert.deepEqual(validateDPOFPrintSizeCode({ printSizeCode: '' }, 'fujijobmaker'), { valid: true });
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
