'use strict';

/**
 * Unit tests for src/shared/cropSizeDropdown.js.
 *
 * The merge rules here decide which routing override a Crop-to-Size
 * dropdown pick stamps on the job. Pre-fix
 * (fuji-pic-pro-review-fixes.md unverified section) the merge was
 * `{w, h}` last-write-wins: a Noritsu 4×6 + a Fuji 4×6 would
 * collapse into one dropdown row, and picking it silently rerouted
 * the job to the Fuji printer because Fuji was emitted last from
 * `getAllSizeOptions`.
 *
 * These tests lock the new contract:
 *   - DPOF + Darkroom still fold into the matching COMMON slot so
 *     the built-in 4×6 row keeps its routing-override function
 *     (byte-identical for these sources).
 *   - Fuji NEVER folds in; always renders as its own labelled row.
 *   - Two DPOF mappings at the same {w, h} → first folds, second
 *     becomes its own row.
 *   - Controller-name label suffix appears when a name is supplied,
 *     is omitted cleanly when not.
 *
 * Run via: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSizeOptions, COMMON_PRINT_SIZES } = require('../cropSizeDropdown');

// ── Fixtures ────────────────────────────────────────────────────────────

const DPOF_4X6 = {
  id: 'cm_dpof-4x6', source: 'dpof', w: 4, h: 6, label: '4×6"',
  channelMappingId: 'map-noritsu-4x6', channelNumber: 1,
};
const DPOF_4X6_B = {
  id: 'cm_dpof-4x6-b', source: 'dpof', w: 4, h: 6, label: '4×6"',
  channelMappingId: 'map-epson-4x6', channelNumber: 2,
};
const DARK_4X6 = {
  id: 'dt_DR1_POS', source: 'darkroom', w: 4, h: 6, label: '4×6"',
  darkroomSize: '4x6', darkroomControllerId: 'DR1', productCodePrefix: 'POS',
};
const FUJI_4X6 = {
  id: 'cm_fuji-4x6', source: 'fuji', w: 4, h: 6, label: '4×6"',
  channelMappingId: 'map-fuji-4x6', controllerId: 'CTRL-FUJI-1',
};
const FUJI_6X4 = {
  id: 'cm_fuji-6x4', source: 'fuji', w: 6, h: 4, label: '6×4"',
  channelMappingId: 'map-fuji-6x4', controllerId: 'CTRL-FUJI-1',
};
const DPOF_UNUSUAL = {
  id: 'cm_dpof-3.5x5', source: 'dpof', w: 3.5, h: 5, label: '3.5×5"',
  channelMappingId: 'map-noritsu-35x5', channelNumber: 5,
};

// ── COMMON_PRINT_SIZES sanity ─────────────────────────────────────────

test('COMMON_PRINT_SIZES: every default has unique id + valid w/h + label', () => {
  const ids = new Set();
  for (const s of COMMON_PRINT_SIZES) {
    assert.ok(!ids.has(s.id), `duplicate id: ${s.id}`);
    ids.add(s.id);
    assert.ok(typeof s.w === 'number' && s.w > 0);
    assert.ok(typeof s.h === 'number' && s.h > 0);
    assert.ok(typeof s.label === 'string' && s.label.length > 0);
  }
});

// ── DPOF + Darkroom fold-in (regression: byte-identical to pre-fix) ────

test('DPOF fold-in: DPOF 4×6 merges into the COMMON __4x6 row and gains channel info', () => {
  const result = buildSizeOptions([DPOF_4X6]);
  const fourSix = result.find(r => r.w === 4 && r.h === 6);
  // Pre-fix spread order (`{...common, ...opt}`) means opt.id
  // overwrites the COMMON id. Locking existing behaviour — the
  // COMMON slot is REPLACED, keeping its position but adopting
  // the backend fields (including id).
  assert.equal(fourSix.id, 'cm_dpof-4x6',
    'merge replaces the COMMON id with the backend id (pre-fix spread order)');
  assert.equal(fourSix.channelMappingId, 'map-noritsu-4x6',
    'the DPOF mapping id folds into the COMMON row so cropping to 4×6 stamps _channelMappingOverride');
  assert.equal(fourSix.channelNumber, 1);
  // Total row count stays 12 (COMMON size) — nothing new pushed.
  assert.equal(result.length, COMMON_PRINT_SIZES.length,
    'a single fold-in must not add a row');
});

test('Darkroom fold-in: Darkroom 4×6 folds into the same COMMON row and carries darkroomSize', () => {
  const result = buildSizeOptions([DARK_4X6]);
  const fourSix = result.find(r => r.w === 4 && r.h === 6);
  assert.equal(fourSix.darkroomSize, '4x6');
  assert.equal(fourSix.darkroomControllerId, 'DR1');
});

test('DPOF second mapping at same {w,h}: fresh row, does NOT overwrite the first fold-in', () => {
  const result = buildSizeOptions([DPOF_4X6, DPOF_4X6_B]);
  const fourSixRows = result.filter(r => r.w === 4 && r.h === 6);
  assert.equal(fourSixRows.length, 2,
    'a second DPOF 4×6 must appear as its OWN row rather than clobbering the fold-in');
  // First (folded into COMMON) keeps the first mapping's id.
  assert.equal(fourSixRows[0].channelMappingId, 'map-noritsu-4x6');
  // Second is its own row with the second mapping's id.
  assert.equal(fourSixRows[1].channelMappingId, 'map-epson-4x6');
});

// ── Fuji: NEVER folds in ───────────────────────────────────────────────

test('CRITICAL regression: Fuji 4×6 does NOT overwrite DPOF 4×6 in the COMMON slot', () => {
  // Pre-fix this was the silent reroute bug: DPOF 4×6 folds in first
  // → row.channelMappingId = 'map-noritsu-4x6'. Then Fuji 4×6 folds
  // in and the spread `{ ...existing, ...opt }` overwrites
  // channelMappingId with the Fuji id. Operator picks "4×6" → job
  // routes to Fuji instead of Noritsu.
  const result = buildSizeOptions([DPOF_4X6, FUJI_4X6]);
  // The DPOF-folded row is the entry with source:'dpof' at 4×6.
  const foldedDpof = result.find(r => r.source === 'dpof' && r.w === 4 && r.h === 6);
  assert.ok(foldedDpof, 'DPOF-folded row must exist at 4×6');
  assert.equal(foldedDpof.channelMappingId, 'map-noritsu-4x6',
    'the DPOF fold-in must remain intact — Fuji is not allowed to overwrite');

  // Fuji appears as its own row (source stays 'fuji') and its
  // channelMappingId is separate from the DPOF one.
  const fujiRows = result.filter(r => r.source === 'fuji');
  assert.equal(fujiRows.length, 1);
  assert.equal(fujiRows[0].channelMappingId, 'map-fuji-4x6');
  // Total row count = COMMON (12) + 1 extra Fuji row.
  assert.equal(result.length, COMMON_PRINT_SIZES.length + 1);
});

test('CRITICAL regression: Fuji 4×6 alone does NOT fold into the empty COMMON __4x6 slot', () => {
  // Even without a competing DPOF entry, Fuji must not fold — the
  // COMMON row's routing-override semantics belong to DPOF/Darkroom
  // only. Folding a Fuji row into __4x6 would let cropping to 4×6
  // stamp _channelMappingOverride, which useJobReview's Fuji-source
  // guard already blocks — but the two fixes together are the
  // belt-and-braces: neither the merge NOR the crop payload will
  // carry Fuji's channelMappingId into the override slot.
  const result = buildSizeOptions([FUJI_4X6]);
  const commonFourSix = result.find(r => r.id === '__4x6');
  assert.ok(commonFourSix, 'COMMON __4x6 row must still be present (Fuji did not consume it)');
  assert.equal(commonFourSix.channelMappingId, undefined,
    'COMMON __4x6 must stay unenriched by Fuji');
  const fujiRows = result.filter(r => r.source === 'fuji');
  assert.equal(fujiRows.length, 1, 'Fuji row is a separate entry');
  assert.equal(fujiRows[0].id, 'cm_fuji-4x6');
});

test('Fuji label carries a "— Fuji" suffix so it visually distinguishes from a DPOF row of the same size', () => {
  const result = buildSizeOptions([FUJI_4X6]);
  const fujiRow = result.find(r => r.source === 'fuji');
  assert.ok(fujiRow.label.endsWith(' — Fuji'),
    `Fuji label should end with " — Fuji"; got ${JSON.stringify(fujiRow.label)}`);
});

test('Fuji label includes the controller name when supplied via controllerNamesById', () => {
  const result = buildSizeOptions(
    [FUJI_4X6],
    new Map([['CTRL-FUJI-1', 'PIC Pro DL650']]),
  );
  const fujiRow = result.find(r => r.source === 'fuji');
  assert.equal(fujiRow.label, '4×6" — PIC Pro DL650 (Fuji)');
});

test('DPOF fallback (dimension not in COMMON) picks up controller-name label when supplied', () => {
  const result = buildSizeOptions(
    [DPOF_UNUSUAL],
    new Map([]),  // no name for the DPOF row
  );
  // 3.5×5 isn't in COMMON — the entry falls through to the push-as-
  // own-row branch. With no controller name in the map, the label
  // stays as the entry's own `3.5×5"`.
  const row = result.find(r => r.w === 3.5 && r.h === 5);
  assert.equal(row.label, '3.5×5"');
});

// ── Positional-parse consequence: 4x6 vs 6x4 are different {w,h} ──────

test('positional-parse consequence: DPOF `4x6` and Fuji `6x4` produce separate rows (no collision)', () => {
  // Real-world case surfaced in the fix investigation: labs that use
  // portrait convention for Fuji type `6x4`, which produces `{w:6,h:4}`
  // — not equal to DPOF's `{w:4,h:6}`. Both rows appear.
  const result = buildSizeOptions([DPOF_4X6, FUJI_6X4]);
  const dpofRow = result.find(r => r.source === 'dpof' && r.w === 4 && r.h === 6);
  assert.equal(dpofRow.channelMappingId, 'map-noritsu-4x6');
  // Fuji row is its own entry, labelled 6×4.
  const fujiRow = result.find(r => r.source === 'fuji');
  assert.equal(fujiRow.w, 6);
  assert.equal(fujiRow.h, 4);
});

test('every returned entry has a unique id', () => {
  // Callers use `id` as the React key + as the dropdown value —
  // collisions break selection.
  const result = buildSizeOptions([DPOF_4X6, DPOF_4X6_B, DARK_4X6, FUJI_4X6, FUJI_6X4, DPOF_UNUSUAL]);
  const ids = result.map(r => r.id);
  const uniq = new Set(ids);
  assert.equal(ids.length, uniq.size, `duplicate ids: ${ids.join(', ')}`);
});

test('empty input returns just COMMON defaults', () => {
  const result = buildSizeOptions([]);
  assert.equal(result.length, COMMON_PRINT_SIZES.length);
  assert.deepEqual(result.map(r => r.id), COMMON_PRINT_SIZES.map(r => r.id));
});
