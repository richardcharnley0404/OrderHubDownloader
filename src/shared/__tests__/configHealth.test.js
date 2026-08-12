'use strict';

/**
 * Tests for src/shared/configHealth.js — the DPOF-family "no print
 * size" health check.
 *
 * The check runs on every launch and every Settings-open (M6 wiring),
 * unguarded by any flag, so it must be pure and cheap and it must
 * agree with the dispatch-time gate at print-service.js:253 (which is
 * exactly the condition `validateDPOFPrintSizeCode` rejects at save).
 *
 * Coverage matches the M5 brief plus extras that the M6 UI depends on
 * (deterministic ordering, orphan-mapping handling, purity across
 * repeated calls).
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const { findUnroutableMappings, REASON } = require(
  path.join(__dirname, '..', 'configHealth.js'),
);

// ── Fixtures ────────────────────────────────────────────────────────────────

const NORITSU_CTRL   = { id: 'ctrl-noritsu', name: 'Noritsu QSS-37', type: 'noritsu' };
const EPSON_CTRL     = { id: 'ctrl-epson',   name: 'Epson Surelab',  type: 'epson' };
const DARKROOM_CTRL  = { id: 'ctrl-dark',    name: 'Darkroom Pro',   type: 'darkroompro' };
const FUJI_JM_CTRL   = { id: 'ctrl-fj',      name: 'Fuji JobMaker',  type: 'fujijobmaker' };
const FUJI_PP_CTRL   = { id: 'ctrl-pp',      name: 'Fuji PIC Pro',   type: 'fujipicpro' };
const FRONTLINE_CTRL = { id: 'ctrl-front',   name: 'Frontline',      type: 'frontline' };
const FOLDER_CTRL    = { id: 'ctrl-folder',  name: 'Folder Copy',    type: 'folder_copy' };
const PDF_CTRL       = { id: 'ctrl-pdf',     name: 'PDF Copy',       type: 'pdf_copy' };
const UNTYPED_CTRL   = { id: 'ctrl-untyped', name: 'Legacy row'                             };

// ── DPOF-family + blank printSizeCode → flagged ─────────────────────────────

test('findUnroutableMappings: DPOF (noritsu) + blank printSizeCode → flagged', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'PHOTO4X6', printSizeCode: '' },
  ];
  const findings = findUnroutableMappings(mappings, [NORITSU_CTRL]);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    mappingId:      'cm-1',
    controllerId:   'ctrl-noritsu',
    controllerName: 'Noritsu QSS-37',
    productCode:    'PHOTO4X6',
    reason:         REASON.NO_PRINT_SIZE,
  });
});

test('findUnroutableMappings: DPOF (epson) + blank printSizeCode → flagged (epson is DPOF family)', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-epson', productCode: 'PHOTO4X6', printSizeCode: '' },
  ];
  const findings = findUnroutableMappings(mappings, [EPSON_CTRL]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].controllerName, 'Epson Surelab');
});

test('findUnroutableMappings: whitespace-only printSizeCode counts as blank', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X', printSizeCode: '   ' },
  ];
  const findings = findUnroutableMappings(mappings, [NORITSU_CTRL]);
  assert.equal(findings.length, 1);
});

test('findUnroutableMappings: null / undefined printSizeCode counts as blank', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'A', printSizeCode: null      },
    { id: 'cm-2', controllerId: 'ctrl-noritsu', productCode: 'B', printSizeCode: undefined },
    { id: 'cm-3', controllerId: 'ctrl-noritsu', productCode: 'C'                            },
  ];
  const findings = findUnroutableMappings(mappings, [NORITSU_CTRL]);
  assert.equal(findings.length, 3);
});

test('findUnroutableMappings: DPOF + populated printSizeCode → NOT flagged', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X', printSizeCode: 'KG'              },
    { id: 'cm-2', controllerId: 'ctrl-noritsu', productCode: 'Y', printSizeCode: '4x6'             },
    { id: 'cm-3', controllerId: 'ctrl-noritsu', productCode: 'Z', printSizeCode: 'NML -PSIZE "8x4"' },
  ];
  assert.deepEqual(findUnroutableMappings(mappings, [NORITSU_CTRL]), []);
});

// ── Non-DPOF controllers → never flagged ────────────────────────────────────

test('findUnroutableMappings: darkroompro + blank printSizeCode → NOT flagged (size lives in sizeTranslations)', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-dark', productCode: 'X', printSizeCode: '' },
  ];
  assert.deepEqual(findUnroutableMappings(mappings, [DARKROOM_CTRL]), []);
});

test('findUnroutableMappings: fujijobmaker + blank printSizeCode → NOT flagged (Fuji validator owns this)', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-fj', productCode: 'X', printSizeCode: '' },
  ];
  assert.deepEqual(findUnroutableMappings(mappings, [FUJI_JM_CTRL]), []);
});

test('findUnroutableMappings: fujipicpro + blank printSizeCode → NOT flagged', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-pp', productCode: 'X', printSizeCode: '' },
  ];
  assert.deepEqual(findUnroutableMappings(mappings, [FUJI_PP_CTRL]), []);
});

test('findUnroutableMappings: frontline / folder_copy / pdf_copy + blank printSizeCode → NOT flagged', () => {
  const mappings = [
    { id: 'cm-front',  controllerId: 'ctrl-front',  productCode: 'A', printSizeCode: '' },
    { id: 'cm-folder', controllerId: 'ctrl-folder', productCode: 'B', printSizeCode: '' },
    { id: 'cm-pdf',    controllerId: 'ctrl-pdf',    productCode: 'C', printSizeCode: '' },
  ];
  assert.deepEqual(findUnroutableMappings(mappings, [FRONTLINE_CTRL, FOLDER_CTRL, PDF_CTRL]), []);
});

test('findUnroutableMappings: non-DPOF WITH a populated printSizeCode is still not flagged (M5 scope, not a value check)', () => {
  // A populated printSizeCode on a Fuji row is harmless (validator
  // ignores it, dispatch ignores it) — the health check must not
  // suddenly treat it as suspect.
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-fj', productCode: 'X', printSizeCode: 'KG-from-old-import' },
  ];
  assert.deepEqual(findUnroutableMappings(mappings, [FUJI_JM_CTRL]), []);
});

// ── Unknown controllerId → treated as DPOF-shaped ───────────────────────────

test('findUnroutableMappings: mapping pointing at unknown controllerId + blank printSizeCode → flagged', () => {
  // Matches validateDPOFPrintSizeCode + resolvePrintSizeCode: an
  // orphan mapping is treated as DPOF-shaped so it's evaluated by the
  // same rules that would apply if it were re-linked to a Noritsu
  // controller later. The controllerName is blank on the finding —
  // the M6 UI shows that as "(no controller)" or similar so the
  // operator can decide whether to delete the row or re-link it.
  const mappings = [
    { id: 'cm-orphan', controllerId: 'ctrl-was-deleted', productCode: 'X', printSizeCode: '' },
  ];
  const findings = findUnroutableMappings(mappings, [/* no controllers */]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].mappingId,      'cm-orphan');
  assert.equal(findings[0].controllerName, '');
});

test('findUnroutableMappings: untyped controller + blank printSizeCode → flagged (defaults to DPOF-shaped)', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-untyped', productCode: 'X', printSizeCode: '' },
  ];
  const findings = findUnroutableMappings(mappings, [UNTYPED_CTRL]);
  assert.equal(findings.length, 1);
});

// ── Defensive input ─────────────────────────────────────────────────────────

test('findUnroutableMappings: null / undefined mappings → []', () => {
  assert.deepEqual(findUnroutableMappings(null,      [NORITSU_CTRL]), []);
  assert.deepEqual(findUnroutableMappings(undefined, [NORITSU_CTRL]), []);
});

test('findUnroutableMappings: non-array mappings → [] (never throws)', () => {
  assert.deepEqual(findUnroutableMappings('garbage',  [NORITSU_CTRL]), []);
  assert.deepEqual(findUnroutableMappings(42,         [NORITSU_CTRL]), []);
  assert.deepEqual(findUnroutableMappings({ x: 1 },   [NORITSU_CTRL]), []);
});

test('findUnroutableMappings: empty mappings → []', () => {
  assert.deepEqual(findUnroutableMappings([], [NORITSU_CTRL]), []);
});

test('findUnroutableMappings: null / non-array controllers → mappings still evaluated as DPOF-shaped', () => {
  // No controllers to look up → every mapping is orphan → every
  // DPOF-shaped blank one flags. Never throws on the missing input.
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-any', productCode: 'X', printSizeCode: '' },
  ];
  assert.equal(findUnroutableMappings(mappings, null).length,      1);
  assert.equal(findUnroutableMappings(mappings, undefined).length, 1);
  assert.equal(findUnroutableMappings(mappings, 'nope').length,    1);
});

test('findUnroutableMappings: null / non-object entries in the mappings array are skipped', () => {
  const mappings = [
    null,
    undefined,
    'garbage',
    42,
    { id: 'cm-real', controllerId: 'ctrl-noritsu', productCode: 'X', printSizeCode: '' },
  ];
  const findings = findUnroutableMappings(mappings, [NORITSU_CTRL]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].mappingId, 'cm-real');
});

test('findUnroutableMappings: controller entries without an id are skipped (no lookup crash)', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X', printSizeCode: '' },
  ];
  const controllers = [
    null,
    undefined,
    { name: 'orphan controller' },   // no id
    NORITSU_CTRL,
  ];
  const findings = findUnroutableMappings(mappings, controllers);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].controllerName, 'Noritsu QSS-37');
});

// ── Deterministic ordering ──────────────────────────────────────────────────

test('findUnroutableMappings: results sort by (controllerName, productCode, mappingId)', () => {
  // Locked so the M6 Settings roll-up displays mappings grouped by
  // controller, and diffing two runs of the check is meaningful.
  const mappings = [
    { id: 'cm-z', controllerId: 'ctrl-epson',   productCode: 'PROD-A', printSizeCode: '' },
    { id: 'cm-a', controllerId: 'ctrl-noritsu', productCode: 'PROD-B', printSizeCode: '' },
    { id: 'cm-m', controllerId: 'ctrl-noritsu', productCode: 'PROD-A', printSizeCode: '' },
    { id: 'cm-b', controllerId: 'ctrl-noritsu', productCode: 'PROD-A', printSizeCode: '' },
  ];
  const findings = findUnroutableMappings(mappings, [NORITSU_CTRL, EPSON_CTRL]);
  assert.equal(findings.length, 4);
  // Controllers sort first — Epson Surelab < Noritsu QSS-37
  assert.equal(findings[0].mappingId, 'cm-z');
  // Then within Noritsu, PROD-A < PROD-B
  assert.equal(findings[1].productCode, 'PROD-A');
  assert.equal(findings[2].productCode, 'PROD-A');
  assert.equal(findings[3].productCode, 'PROD-B');
  // And within same controller+product, mappingId ascending: cm-b < cm-m
  assert.equal(findings[1].mappingId, 'cm-b');
  assert.equal(findings[2].mappingId, 'cm-m');
});

test('findUnroutableMappings: orphan mappings (empty controllerName) sort to the top', () => {
  // Documented convention — orphans stand out visually in the M6
  // roll-up because empty string sorts before every non-empty name.
  const mappings = [
    { id: 'cm-real',   controllerId: 'ctrl-noritsu',     productCode: 'X', printSizeCode: '' },
    { id: 'cm-orphan', controllerId: 'ctrl-was-deleted', productCode: 'X', printSizeCode: '' },
  ];
  const findings = findUnroutableMappings(mappings, [NORITSU_CTRL]);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].mappingId,      'cm-orphan');
  assert.equal(findings[0].controllerName, '');
});

// ── Purity: safe to call on every launch + every Settings open ──────────────

test('findUnroutableMappings: pure — repeated calls with same input yield deep-equal results', () => {
  // The M6 wiring calls this unguarded on every launch and every
  // Settings open. Locking purity here means adding a memo or a
  // caching wrapper later is a caller-side choice, not something the
  // check has silently developed.
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X', printSizeCode: '' },
    { id: 'cm-2', controllerId: 'ctrl-noritsu', productCode: 'Y', printSizeCode: 'KG' },
  ];
  const a = findUnroutableMappings(mappings, [NORITSU_CTRL]);
  const b = findUnroutableMappings(mappings, [NORITSU_CTRL]);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'each call returns a fresh array — no shared reference');
});

test('findUnroutableMappings: does not mutate its inputs', () => {
  const mappings = [
    { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X', printSizeCode: '' },
  ];
  const controllers = [NORITSU_CTRL];
  const beforeM = JSON.stringify(mappings);
  const beforeC = JSON.stringify(controllers);
  findUnroutableMappings(mappings, controllers);
  assert.equal(JSON.stringify(mappings),    beforeM);
  assert.equal(JSON.stringify(controllers), beforeC);
});

// ── Mixed store realism ─────────────────────────────────────────────────────

test('findUnroutableMappings: mixed real-world-shape store — only DPOF blanks flag', () => {
  const controllers = [NORITSU_CTRL, EPSON_CTRL, DARKROOM_CTRL, FUJI_JM_CTRL];
  const mappings = [
    // Healthy DPOF
    { id: 'cm-ok-1',  controllerId: 'ctrl-noritsu', productCode: 'PROD-A', printSizeCode: 'KG' },
    // Sizeless DPOF — flag
    { id: 'cm-bad-1', controllerId: 'ctrl-noritsu', productCode: 'PROD-B', printSizeCode: '' },
    // Sizeless Epson — flag
    { id: 'cm-bad-2', controllerId: 'ctrl-epson',   productCode: 'PROD-C', printSizeCode: '' },
    // Darkroom Pro (no printSizeCode field expected) — do not flag
    { id: 'cm-dr-1',  controllerId: 'ctrl-dark',    productCode: 'PROD-D', printSizeCode: '' },
    // Fuji (owns its own validator) — do not flag
    { id: 'cm-fj-1',  controllerId: 'ctrl-fj',      productCode: 'PROD-E', printSizeCode: '' },
    // Orphan DPOF — flag
    { id: 'cm-orphan', controllerId: 'ctrl-gone',   productCode: 'PROD-F', printSizeCode: '' },
  ];

  const findings = findUnroutableMappings(mappings, controllers);
  const ids = findings.map(f => f.mappingId);
  assert.deepEqual(ids, ['cm-orphan', 'cm-bad-2', 'cm-bad-1'],
    'orphan first, then Epson Surelab, then Noritsu QSS-37 — sort-by-controllerName order');
});
