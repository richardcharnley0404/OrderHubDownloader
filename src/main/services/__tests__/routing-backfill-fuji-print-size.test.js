/**
 * Tests for backfillFujiPrintSize in routing-service.js.
 *
 * M0 of the Fuji PIC Pro brief. Companion to
 * routing-backfill-print-size.test.js (DPOF `size` → `printSizeCode`
 * backfill); same in-memory store shim, same idempotency guarantees.
 *
 * The migration copies a bare-WxH `mapping.printCode` (e.g. "6x4",
 * "3.5x5") into the new `mapping.printSize` field for Fuji-family
 * channel mappings whose `printSize` is blank. `printSize` drives the
 * Manual Crop aspect ratio — before M0, Fuji jobs had no target size
 * and Manual Crop fell back to 1:1 squares.
 *
 * Properties pinned here:
 *   1. blank printSize + bare-WxH printCode → backfilled verbatim
 *   2. existing printSize                    → untouched
 *   3. non-WxH printCode                     → left blank + warned
 *   4. second run is a no-op                 → guard flag prevents rewrites
 *   5. non-Fuji controllers                  → always skipped
 *   6. both fujijobmaker + fujipicpro types  → eligible (once M1 lands
 *      operators can already have PIC Pro mappings sitting there)
 *
 * Run via: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

// ── In-memory store shim (mirrors routing-backfill-print-size.test.js) ──────

const __storeData = {};
function FakeStore() {
  return {
    get: (k, d) => (k in __storeData ? __storeData[k] : d),
    set: (k, v) => { __storeData[k] = v; },
    delete: (k) => { delete __storeData[k]; },
    has:  (k) => (k in __storeData),
    get path() { return '/fake/routing.json'; },
  };
}
function __seed(data) {
  for (const k of Object.keys(__storeData)) delete __storeData[k];
  Object.assign(__storeData, data);
  __warnings.length = 0;
  __infoLines.length = 0;
}

const __warnings = [];
const __infoLines = [];
const fakeLogger = {
  info:    (message, meta = {}) => __infoLines.push({ message, meta }),
  warn:    () => {}, error: () => {}, debug: () => {},
  logInfo: (message, meta = {}) => __infoLines.push({ message, meta }),
  logError: () => {}, logDebug: () => {},
  logWarning: (message, meta = {}) => __warnings.push({ message, meta }),
};

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

{
  const loggerPath = require.resolve(path.join(REPO, 'src', 'main', 'services', 'logger.js'));
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: fakeLogger };
}

const routingService = require(
  path.join(REPO, 'src', 'main', 'services', 'routing-service.js'),
);
const { backfillFujiPrintSize } = routingService;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FUJI_JM_CTRL    = { id: 'ctrl-fj',    name: 'Fuji JobMaker',  type: 'fujijobmaker', outputPath: '/fj' };
const FUJI_PICPRO_CTRL = { id: 'ctrl-pp',   name: 'Fuji PIC Pro',   type: 'fujipicpro',   outputPath: '/pp' };
const NORITSU_CTRL     = { id: 'ctrl-nor',  name: 'Noritsu QSS-37', type: 'noritsu',      outputPath: '/nor' };
const DARKROOM_CTRL    = { id: 'ctrl-dr',   name: 'Darkroom Pro',   type: 'darkroompro',  outputPath: '/dr' };
const FRONTLINE_CTRL   = { id: 'ctrl-fl',   name: 'Frontline',      type: 'frontline',    outputPath: '/fl' };
const FOLDER_CTRL      = { id: 'ctrl-fold', name: 'Folder Copy',    type: 'folder_copy',  outputPath: '/fc' };
const PDF_CTRL         = { id: 'ctrl-pdf',  name: 'PDF Copy',       type: 'pdf_copy',     outputPath: '/pdf' };


// ── Property tests ────────────────────────────────────────────────────────────

test('backfillFuji: blank printSize + bare-WxH printCode → printSize = printCode (verbatim)', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-fj', productCode: 'P',
        options: [], printCode: '6x4', printSize: '', surface: 'Lustre' },
    ],
  });

  backfillFujiPrintSize();

  const [m] = __storeData.channelMappings;
  assert.equal(m.printSize, '6x4',
    'bare-WxH printCode must be copied verbatim; the shared regex accepts it as-is on read too');
  assert.equal(m.printCode, '6x4', 'printCode field is preserved as-is');
  assert.equal(__storeData._backfill_fuji_print_size_v1, true, 'guard flag set after successful run');
});


test('backfillFuji: existing printSize → untouched even if printCode disagrees', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-fj', productCode: 'P',
        options: [], printCode: '6x4', printSize: '8x10', surface: 'Lustre' },
    ],
  });

  backfillFujiPrintSize();

  const [m] = __storeData.channelMappings;
  assert.equal(m.printSize, '8x10',
    'operator-set printSize wins — backfill never overwrites an existing value');
});


test('backfillFuji: whitespace-only printSize counts as blank', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-fj', productCode: 'P',
        options: [], printCode: '3.5x5', printSize: '   ', surface: 'L' },
    ],
  });

  backfillFujiPrintSize();

  assert.equal(__storeData.channelMappings[0].printSize, '3.5x5');
});


test('backfillFuji: non-WxH printCode is NOT backfilled and a warning is logged', () => {
  // Some labs assign codes like "KG" that don't parse as a size — the
  // crop aspect can't be inferred, so backfill must skip them and log
  // so the amber routing-list badge (M0.6) surfaces them for the
  // operator to fix.
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-code', controllerId: 'ctrl-fj', productCode: 'PROD',
        options: [], printCode: 'KG', printSize: '', surface: 'Lustre' },
    ],
  });

  backfillFujiPrintSize();

  assert.equal(__storeData.channelMappings[0].printSize, '',
    'non-WxH printCode must stay unbackfilled — the operator has to supply the crop aspect explicitly');
  assert.equal(__storeData.channelMappings[0].printCode, 'KG', 'original printCode preserved');

  const warn = __warnings.find(w => w.message.includes('printCode is not WxH'));
  assert.ok(warn, 'a warning must be logged for the skipped mapping so the badge/operator can find it');
  assert.equal(warn.meta.channelMappingId, 'cm-code');
  assert.equal(warn.meta.controllerId,     'ctrl-fj');
  assert.equal(warn.meta.controllerType,   'fujijobmaker');
  assert.equal(warn.meta.productCode,      'PROD');
  assert.equal(warn.meta.printCode,        'KG');
});


test('backfillFuji: blank printSize + blank printCode → left blank (nothing to copy)', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-fj', productCode: 'P',
        options: [], printCode: '', printSize: '', surface: 'L' },
    ],
  });

  backfillFujiPrintSize();

  assert.equal(__storeData.channelMappings[0].printSize, '');
  assert.equal(__storeData._backfill_fuji_print_size_v1, true, 'guard still set so future startups skip the scan');
});


test('backfillFuji: fujipicpro mappings are eligible (M1 forward-compat)', () => {
  // When M1 registers fujipicpro as a controller type, operators can
  // already have mappings sitting in the store from dev builds. The
  // backfill must include them so a fresh install doesn't leave them
  // with a missing crop aspect.
  __seed({
    orderControllers: [FUJI_PICPRO_CTRL],
    channelMappings: [
      { id: 'cm-pp', controllerId: 'ctrl-pp', productCode: 'P',
        options: [], printCode: '4x6', printSize: '', surface: 'Lustre' },
    ],
  });

  backfillFujiPrintSize();

  assert.equal(__storeData.channelMappings[0].printSize, '4x6',
    'fujipicpro mappings share the JobMaker shape; the backfill must treat them the same way');
});


test('backfillFuji: mixed Fuji types in one store — both are backfilled independently', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL, FUJI_PICPRO_CTRL],
    channelMappings: [
      { id: 'cm-fj-eligible', controllerId: 'ctrl-fj', printCode: '6x4',  printSize: '', surface: 'L' },
      { id: 'cm-fj-set',      controllerId: 'ctrl-fj', printCode: '6x4',  printSize: '5x7', surface: 'L' },
      { id: 'cm-pp-eligible', controllerId: 'ctrl-pp', printCode: '8x10', printSize: '', surface: 'G' },
      { id: 'cm-pp-non-wxh',  controllerId: 'ctrl-pp', printCode: 'KG',   printSize: '', surface: 'G' },
    ],
  });

  backfillFujiPrintSize();

  const byId = Object.fromEntries(__storeData.channelMappings.map(m => [m.id, m]));
  assert.equal(byId['cm-fj-eligible'].printSize, '6x4',  'JobMaker: bare WxH backfilled');
  assert.equal(byId['cm-fj-set'].printSize,      '5x7',  'JobMaker: existing preserved');
  assert.equal(byId['cm-pp-eligible'].printSize, '8x10', 'PIC Pro: bare WxH backfilled');
  assert.equal(byId['cm-pp-non-wxh'].printSize,  '',     'PIC Pro: non-WxH left blank');
});


// ── Scope: non-Fuji controllers must be skipped ──────────────────────────────

test('backfillFuji: DPOF / darkroom / frontline / folder_copy / pdf_copy mappings are all skipped', () => {
  __seed({
    orderControllers: [NORITSU_CTRL, DARKROOM_CTRL, FRONTLINE_CTRL, FOLDER_CTRL, PDF_CTRL],
    channelMappings: [
      // Deliberately give each one a bare-WxH `printCode` — the backfill
      // must STILL skip them because their controller isn't Fuji-family.
      { id: 'cm-nor',  controllerId: 'ctrl-nor',  printCode: '4x6', printSize: '' },
      { id: 'cm-dr',   controllerId: 'ctrl-dr',   printCode: '4x6', printSize: '' },
      { id: 'cm-fl',   controllerId: 'ctrl-fl',   printCode: '4x6', printSize: '' },
      { id: 'cm-fold', controllerId: 'ctrl-fold', printCode: '4x6', printSize: '' },
      { id: 'cm-pdf',  controllerId: 'ctrl-pdf',  printCode: '4x6', printSize: '' },
    ],
  });

  backfillFujiPrintSize();

  for (const m of __storeData.channelMappings) {
    assert.equal(m.printSize, '',
      `${m.id}: non-Fuji controller type must be left untouched by the Fuji backfill`);
  }
});


test('backfillFuji: mapping pointing at unknown controllerId is skipped (defensive)', () => {
  // The Fuji backfill can't infer intent from an orphaned mapping — the
  // DPOF backfill treats orphans as DPOF-shaped, but here we'd risk
  // silently populating a non-Fuji mapping's printSize. Safer to skip
  // and rely on the amber badge once the mapping is re-linked.
  __seed({
    orderControllers: [],
    channelMappings: [
      { id: 'cm-orphan', controllerId: 'ctrl-was-deleted', printCode: '4x6', printSize: '' },
    ],
  });

  backfillFujiPrintSize();

  assert.equal(__storeData.channelMappings[0].printSize, '');
});


// ── Idempotency ──────────────────────────────────────────────────────────────

test('backfillFuji: second run is a no-op (guard flag)', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-fj', printCode: '6x4', printSize: '', surface: 'L' },
    ],
  });

  backfillFujiPrintSize();
  assert.equal(__storeData.channelMappings[0].printSize, '6x4');

  // Corrupt the mapping to prove the second call short-circuits before
  // touching channelMappings at all: seed a NEW eligible row (blank
  // printSize + bare-WxH printCode) that the scan WOULD backfill if it
  // re-ran. It must NOT — the guard flag is authoritative.
  __storeData.channelMappings = [
    { id: 'cm-1', controllerId: 'ctrl-fj', printCode: '9x9', printSize: '', surface: 'L' },
  ];

  backfillFujiPrintSize();

  assert.equal(__storeData.channelMappings[0].printSize, '',
    'second run must short-circuit on the guard flag — no rewrite even for an otherwise-eligible row');
});


test('backfillFuji: rerun after clearing the guard is still idempotent (property test)', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-fj', printCode: '6x4', printSize: '', surface: 'L' },
    ],
  });

  backfillFujiPrintSize();
  const afterFirst = JSON.stringify(__storeData.channelMappings);

  delete __storeData._backfill_fuji_print_size_v1;
  backfillFujiPrintSize();
  const afterSecond = JSON.stringify(__storeData.channelMappings);

  assert.equal(afterSecond, afterFirst,
    'a second scan finds nothing to backfill — the source condition is exhausted after the first pass');
});


test('backfillFuji: empty channelMappings → sets flag and does nothing else', () => {
  __seed({ orderControllers: [FUJI_JM_CTRL], channelMappings: [] });

  backfillFujiPrintSize();

  assert.deepEqual(__storeData.channelMappings, [], 'no mappings → no changes');
  assert.equal(__storeData._backfill_fuji_print_size_v1, true, 'flag still set to skip future scans');
});


test('backfillFuji: whitespace / uppercase-X / Unicode-× printCode variants ARE backfilled', () => {
  // The shared isBareWxH regex accepts all three variants; the backfill
  // must too — otherwise a mapping typed with an "8 x 10" or "8×8"
  // printCode would fail to derive its crop aspect for no good reason.
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-spaces',  controllerId: 'ctrl-fj', printCode: '8 x 10', printSize: '', surface: 'L' },
      { id: 'cm-upperX',  controllerId: 'ctrl-fj', printCode: '8X8',    printSize: '', surface: 'L' },
      { id: 'cm-unicode', controllerId: 'ctrl-fj', printCode: '8×8',    printSize: '', surface: 'L' },
    ],
  });

  backfillFujiPrintSize();

  const byId = Object.fromEntries(__storeData.channelMappings.map(m => [m.id, m]));
  assert.equal(byId['cm-spaces'].printSize,  '8 x 10');
  assert.equal(byId['cm-upperX'].printSize,  '8X8');
  assert.equal(byId['cm-unicode'].printSize, '8×8');
  assert.equal(__warnings.length, 0, 'these are eligible → no non-WxH warning');
});


// ── M4: unfixable counter + summary-level warn ───────────────────────────────
//
// Same shape as the DPOF backfill's M4 tests. Pre-M4 a Fuji-family
// mapping with BOTH blank printSize and blank printCode returned
// silently — no counter, no log. The operator only found out later
// when Manual Crop silently fell back to a 1:1 square. These tests
// pin that the summary now names the count and a warn-level log
// mentioning Manual Crop fires when it's > 0.

test('M4: healthy Fuji store — unfixable=0 in summary, no warn-level log fires', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-ok', controllerId: 'ctrl-fj', printCode: '6x4', printSize: '' },
    ],
  });

  backfillFujiPrintSize();

  const summary = __infoLines.find(l => /Fuji printSize backfill complete/.test(l.message));
  assert.ok(summary, 'info-level summary line still fires');
  assert.equal(summary.meta.unfixable, 0);
  assert.equal(summary.meta.backfilled, 1);

  const cropWarn = __warnings.find(w => /Manual Crop will fall back to a square/.test(w.message));
  assert.equal(cropWarn, undefined, 'summary-level Manual Crop warn must not fire when unfixable=0');
});

test('M4: N sizeless Fuji mappings — summary counts them + warn fires with total', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL, FUJI_PICPRO_CTRL],
    channelMappings: [
      { id: 'cm-fj1',  controllerId: 'ctrl-fj', productCode: 'A', printSize: '', printCode: '' },
      { id: 'cm-fj2',  controllerId: 'ctrl-fj', productCode: 'B', printSize: '', printCode: '' },
      { id: 'cm-pp1',  controllerId: 'ctrl-pp', productCode: 'C', printSize: '', printCode: '' },
      // Healthy alongside — proves the counter doesn't double-count.
      { id: 'cm-ok',   controllerId: 'ctrl-fj', productCode: 'D', printSize: '6x4' },
    ],
  });

  backfillFujiPrintSize();

  const summary = __infoLines.find(l => /Fuji printSize backfill complete/.test(l.message));
  assert.equal(summary.meta.unfixable,     3, 'each blank+blank Fuji-family row counts once');
  assert.equal(summary.meta.backfilled,    0);
  assert.equal(summary.meta.skippedNonWxH, 0);
  assert.equal(summary.meta.totalMappings, 4);

  const cropWarn = __warnings.find(w => /Manual Crop will fall back to a square/.test(w.message));
  assert.ok(cropWarn, 'summary-level Manual Crop warn must fire when unfixable > 0');
  assert.equal(cropWarn.meta.unfixable,     3);
  assert.equal(cropWarn.meta.totalMappings, 4);
});

test('M4: eligibility unchanged — an unfixable Fuji mapping is returned untouched', () => {
  __seed({
    orderControllers: [FUJI_JM_CTRL],
    channelMappings: [
      { id: 'cm-unfix', controllerId: 'ctrl-fj', productCode: 'X',
        options: [], printSize: '', printCode: '', surface: 'Lustre' },
    ],
  });

  backfillFujiPrintSize();

  const [m] = __storeData.channelMappings;
  assert.equal(m.printSize, '', 'unfixable mapping stays blank — no phantom value');
  assert.equal(m.printCode, '', 'printCode stays blank');
  assert.equal(m.surface,   'Lustre', 'other fields untouched');
});

test('M4: unfixable count excludes non-Fuji controllers (scope preserved)', () => {
  __seed({
    orderControllers: [NORITSU_CTRL, DARKROOM_CTRL],
    channelMappings: [
      { id: 'cm-nor',  controllerId: 'ctrl-nor', printSize: '', printCode: '' },
      { id: 'cm-dark', controllerId: 'ctrl-dr',  printSize: '', printCode: '' },
    ],
  });

  backfillFujiPrintSize();

  const summary = __infoLines.find(l => /Fuji printSize backfill complete/.test(l.message));
  assert.equal(summary.meta.unfixable, 0, 'non-Fuji rows must not count as unfixable');

  const cropWarn = __warnings.find(w => /Manual Crop will fall back to a square/.test(w.message));
  assert.equal(cropWarn, undefined);
});

// Restore require shim hygiene so unrelated tests in the same worker aren't
// affected by our electron/electron-store swaps.
test.after(() => { Module.prototype.require = __originalRequire; });
