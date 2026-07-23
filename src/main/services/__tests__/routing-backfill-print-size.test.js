/**
 * Tests for backfillLegacyPrintSizeCode in routing-service.js
 *
 * Step 2 of docs/orderhub-mandatory-print-size-plan.md — the one-time
 * migration that copies legacy `mapping.size` into `mapping.printSizeCode`
 * for DPOF/Noritsu channel mappings whose printSizeCode is blank. This
 * lets a follow-up commit drop the legacy-`size` fallback (and the `'KG'`
 * default) from resolvePrintSizeCode without changing what any existing
 * mapping resolves to.
 *
 * These tests pin down four properties:
 *   1. blank printSizeCode + legacy size    → backfilled (verbatim)
 *   2. existing printSizeCode               → untouched
 *   3. truly blank (no printSizeCode, no size) → left blank
 *   4. second run is a no-op                → guard flag prevents rewrites
 *
 * Plus a scope check: mappings on non-DPOF controllers (darkroompro /
 * fujijobmaker / frontline / folder_copy / pdf_copy) must be skipped
 * — those types don't consult `size` or `printSizeCode` and could carry
 * unrelated data in those fields.
 *
 * Store/electron are shimmed with a stateful in-memory FakeStore so the
 * backfill's store.get / store.set calls are visible to the assertions.
 * Same shape as routing-ignored-options.test.js.
 *
 * Run via: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

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
}

// Warning-capturing logger stub — required so the non-WxH warning
// assertion has something to inspect. Every other log method is a no-op.
const __warnings = [];
const fakeLogger = {
  info:    () => {}, warn:  () => {}, error:    () => {}, debug:    () => {},
  logInfo: () => {}, logError: () => {}, logDebug: () => {},
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

// Route the logger require to our spy BEFORE requiring routing-service so
// the spy is what routing-service (and its transitive requires like
// darkroom-pro-output) see at module load. require.cache is keyed by the
// resolved absolute path.
{
  const loggerPath = require.resolve(path.join(REPO, 'src', 'main', 'services', 'logger.js'));
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: fakeLogger };
}

const routingService = require(
  path.join(REPO, 'src', 'main', 'services', 'routing-service.js'),
);
const { backfillLegacyPrintSizeCode, resolvePrintSizeCode } = routingService;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NORITSU_CTRL   = { id: 'ctrl-noritsu', name: 'Noritsu QSS-37', type: 'noritsu',      outputPath: '/hot' };
const EPSON_CTRL     = { id: 'ctrl-epson',   name: 'Epson Surelab',  type: 'epson',        outputPath: '/hot' };
const DARKROOM_CTRL  = { id: 'ctrl-dark',    name: 'Darkroom Pro',   type: 'darkroompro',  outputPath: '/dr'  };
const FUJI_CTRL      = { id: 'ctrl-fuji',    name: 'Fuji JobMaker',  type: 'fujijobmaker', outputPath: '/fj'  };
const FRONTLINE_CTRL = { id: 'ctrl-front',   name: 'Frontline',      type: 'frontline',    outputPath: '/fl'  };
const FOLDER_CTRL    = { id: 'ctrl-folder',  name: 'Folder Copy',    type: 'folder_copy',  outputPath: '/fc'  };
const PDF_CTRL       = { id: 'ctrl-pdf',     name: 'PDF Copy',       type: 'pdf_copy',     outputPath: '/pdf' };


// ── Property tests ────────────────────────────────────────────────────────────

test('backfill: blank printSizeCode + legacy size → printSizeCode = size (verbatim)', () => {
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'PHOTO4X6',
        options: [], channelNumber: 1, printSizeCode: '', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();

  const [m] = __storeData.channelMappings;
  assert.equal(m.printSizeCode, '4x6',
    'legacy size must be copied verbatim (not pre-wrapped as NML -PSIZE — resolvePrintSizeCode does the wrap at read time)');
  assert.equal(m.size, '4x6', 'legacy size field is preserved as-is');
  assert.equal(__storeData._backfill_print_size_v1, true, 'guard flag set after successful run');
});


test('backfill: existing printSizeCode → untouched even if legacy size disagrees', () => {
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'PHOTO4X6',
        options: [], channelNumber: 1, printSizeCode: 'KG', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();

  const [m] = __storeData.channelMappings;
  assert.equal(m.printSizeCode, 'KG',
    'existing printSizeCode wins — legacy size is not allowed to overwrite the modern field');
});


test('backfill: whitespace-only printSizeCode counts as blank', () => {
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X',
        options: [], channelNumber: 1, printSizeCode: '   ', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();

  assert.equal(__storeData.channelMappings[0].printSizeCode, '4x6');
});


test('backfill: truly blank (no printSizeCode, no size) → left blank', () => {
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X',
        options: [], channelNumber: 1, printSizeCode: '', size: '' },
    ],
  });

  backfillLegacyPrintSizeCode();

  const [m] = __storeData.channelMappings;
  assert.equal(m.printSizeCode, '', 'no source to copy from → stays blank');
  assert.equal(m.size,          '', 'legacy size stays blank');
  // Guard is still set — subsequent startups skip the whole scan.
  assert.equal(__storeData._backfill_print_size_v1, true);
});


test('backfill: whitespace-only legacy size is not a source', () => {
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X',
        options: [], channelNumber: 1, printSizeCode: '', size: '   ' },
    ],
  });

  backfillLegacyPrintSizeCode();

  assert.equal(__storeData.channelMappings[0].printSizeCode, '',
    'whitespace-only legacy size is treated as blank — nothing to copy');
});


test('backfill: second run is a no-op (guard flag)', () => {
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X',
        options: [], channelNumber: 1, printSizeCode: '', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();
  assert.equal(__storeData.channelMappings[0].printSizeCode, '4x6');

  // Corrupt the mapping to prove the second call short-circuits before
  // touching channelMappings at all: seed a NEW eligible row (blank
  // printSizeCode + bare-WxH size) that the scan WOULD backfill if it
  // re-ran. It must NOT — the guard flag is authoritative.
  __storeData.channelMappings = [
    { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X',
      options: [], channelNumber: 1, printSizeCode: '', size: '9x9' },
  ];

  backfillLegacyPrintSizeCode();

  assert.equal(__storeData.channelMappings[0].printSizeCode, '',
    'second run must short-circuit on the guard flag — no rewrite even for an otherwise-eligible row');
});


test('backfill: rerun after clearing the guard is still idempotent (property test)', () => {
  // Belt-and-braces for the "idempotent even without the flag" claim in
  // the docblock. Clear the guard so the scan actually runs again; the
  // condition (blank printSizeCode + non-blank size) is now false for
  // every mapping, so the second scan makes no changes.
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: 'X',
        options: [], channelNumber: 1, printSizeCode: '', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();
  const afterFirst = JSON.stringify(__storeData.channelMappings);

  delete __storeData._backfill_print_size_v1;
  backfillLegacyPrintSizeCode();
  const afterSecond = JSON.stringify(__storeData.channelMappings);

  assert.equal(afterSecond, afterFirst,
    'a second scan finds nothing to backfill — the source condition is exhausted');
});


// ── Scope: non-DPOF controllers must be skipped ──────────────────────────────

test('backfill: darkroompro mapping is skipped even with blank printSizeCode + legacy size', () => {
  __seed({
    orderControllers: [DARKROOM_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-dark', productCode: 'DR-4x6',
        options: [], printSizeCode: '', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();

  assert.equal(__storeData.channelMappings[0].printSizeCode, '',
    'darkroompro derives size from controller.sizeTranslations, not from mapping.size — do not backfill');
});


test('backfill: fujijobmaker / frontline / folder_copy / pdf_copy mappings are all skipped', () => {
  __seed({
    orderControllers: [FUJI_CTRL, FRONTLINE_CTRL, FOLDER_CTRL, PDF_CTRL],
    channelMappings: [
      { id: 'fuji-1',  controllerId: 'ctrl-fuji',   printSizeCode: '', size: '4x6' },
      { id: 'front-1', controllerId: 'ctrl-front',  printSizeCode: '', size: '4x6' },
      { id: 'fold-1',  controllerId: 'ctrl-folder', printSizeCode: '', size: '4x6' },
      { id: 'pdf-1',   controllerId: 'ctrl-pdf',    printSizeCode: '', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();

  for (const m of __storeData.channelMappings) {
    assert.equal(m.printSizeCode, '',
      `${m.id} controller type is non-DPOF — must be left untouched`);
  }
});


test('backfill: epson counts as DPOF (same output path as noritsu)', () => {
  __seed({
    orderControllers: [EPSON_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-epson', printSizeCode: '', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();

  assert.equal(__storeData.channelMappings[0].printSizeCode, '4x6',
    'epson uses the same DPOF dispatch path — backfill applies');
});


test('backfill: mapping pointing at unknown controllerId is treated as DPOF-shaped', () => {
  // Matches what resolvePrintSizeCode does at runtime — it doesn't check
  // the controller type, it just reads the mapping fields. Backfilling
  // an orphaned mapping is safe because the mapping is still valid data
  // that could be re-linked to a Noritsu controller later.
  __seed({
    orderControllers: [],
    channelMappings: [
      { id: 'cm-orphan', controllerId: 'ctrl-was-deleted', printSizeCode: '', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();

  assert.equal(__storeData.channelMappings[0].printSizeCode, '4x6');
});


// ── Mixed store: only the eligible rows get touched ──────────────────────────

test('backfill: mixed store — only DPOF rows with blank printSizeCode + bare-WxH legacy size are rewritten', () => {
  __seed({
    orderControllers: [NORITSU_CTRL, FUJI_CTRL, DARKROOM_CTRL],
    channelMappings: [
      // eligible → backfilled
      { id: 'cm-eligible', controllerId: 'ctrl-noritsu', printSizeCode: '', size: '4x6' },
      // already set → untouched
      { id: 'cm-set',      controllerId: 'ctrl-noritsu', printSizeCode: 'KG', size: '' },
      // truly blank → left blank
      { id: 'cm-blank',    controllerId: 'ctrl-noritsu', printSizeCode: '', size: '' },
      // non-WxH legacy size → NOT backfilled (see dedicated tests below)
      { id: 'cm-code',     controllerId: 'ctrl-noritsu', printSizeCode: '', size: 'KG' },
      // non-DPOF → skipped
      { id: 'cm-fuji',     controllerId: 'ctrl-fuji',    printSizeCode: '', size: '4x6' },
      { id: 'cm-dark',     controllerId: 'ctrl-dark',    printSizeCode: '', size: '4x6' },
    ],
  });

  backfillLegacyPrintSizeCode();

  const byId = Object.fromEntries(__storeData.channelMappings.map(m => [m.id, m]));
  assert.equal(byId['cm-eligible'].printSizeCode, '4x6',  'DPOF + blank + bare-WxH → backfilled');
  assert.equal(byId['cm-set'].printSizeCode,      'KG',   'existing printSizeCode preserved');
  assert.equal(byId['cm-blank'].printSizeCode,    '',     'truly blank left blank');
  assert.equal(byId['cm-code'].printSizeCode,     '',     'non-WxH legacy size skipped (would silently change PSL output)');
  assert.equal(byId['cm-fuji'].printSizeCode,     '',     'Fuji mapping skipped');
  assert.equal(byId['cm-dark'].printSizeCode,     '',     'Darkroom mapping skipped');
});


test('backfill: empty channelMappings → sets flag and does nothing else', () => {
  __seed({ orderControllers: [NORITSU_CTRL], channelMappings: [] });

  backfillLegacyPrintSizeCode();

  assert.deepEqual(__storeData.channelMappings, [], 'no mappings → no changes');
  assert.equal(__storeData._backfill_print_size_v1, true, 'flag still set to skip future scans');
});


// ── Hardening: PSL-output equivalence + non-WxH refusal ──────────────────────

test('backfill equivalence lock: after backfill, PSL equals what the pre-step-3 legacy fallback used to emit', () => {
  // Historical contract we are protecting: before step 3, a mapping with
  //   printSizeCode: '', size: '8x8'
  // resolved via resolvePrintSizeCode's blank branch to `NML -PSIZE "8x8"`.
  // Step 3 removed that fallback; without the step-2 backfill running
  // first the same mapping would suddenly resolve to '' and every job
  // routed through it would fail the dispatch gate. The plan's commit
  // order (backfill first, fallback removal second) is what makes that
  // transition invisible at the printer — this test pins that invariant.
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', printSizeCode: '', size: '8x8' },
    ],
  });

  backfillLegacyPrintSizeCode();

  const [m] = __storeData.channelMappings;
  assert.equal(
    resolvePrintSizeCode(m),
    'NML -PSIZE "8x8"',
    'post-migration PSL must equal what the pre-step-3 legacy `size` fallback used to emit — the whole point of running the backfill before removing the fallback',
  );
});


test('backfill: whitespace / uppercase-X legacy size IS backfilled and resolves to the normalised NML form', () => {
  // The improvement the plan explicitly calls out: whitespace and
  // uppercase-X variants qualify for backfill. After backfill,
  // resolvePrintSizeCode normalises whitespace out (bare-WxH branch strips
  // \s and maps × → x); uppercase X stays as-is because that matches
  // resolvePrintSizeCode's existing behaviour on modern printSizeCode input.
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-spaces', controllerId: 'ctrl-noritsu', printSizeCode: '', size: '8 x 8' },
      { id: 'cm-upperX', controllerId: 'ctrl-noritsu', printSizeCode: '', size: '8X8' },
      { id: 'cm-unicode', controllerId: 'ctrl-noritsu', printSizeCode: '', size: '8×8' },
    ],
  });

  backfillLegacyPrintSizeCode();

  const byId = Object.fromEntries(__storeData.channelMappings.map(m => [m.id, m]));
  assert.equal(byId['cm-spaces'].printSizeCode,  '8 x 8', 'whitespace preserved in printSizeCode; resolve strips it');
  assert.equal(byId['cm-upperX'].printSizeCode,  '8X8',   'uppercase X preserved; matches resolve regex (case-insensitive)');
  assert.equal(byId['cm-unicode'].printSizeCode, '8×8',   'Unicode × preserved; resolve maps → x on emit');

  // The emitted PSL must be the normalised form for all three, matching
  // what resolvePrintSizeCode's bare-WxH branch produces:
  assert.equal(resolvePrintSizeCode(byId['cm-spaces']),  'NML -PSIZE "8x8"');
  assert.equal(resolvePrintSizeCode(byId['cm-upperX']),  'NML -PSIZE "8X8"',
    'uppercase X is not lowercased by resolvePrintSizeCode — existing behaviour, preserved here');
  assert.equal(resolvePrintSizeCode(byId['cm-unicode']), 'NML -PSIZE "8x8"');

  assert.equal(__warnings.length, 0, 'these are eligible → no non-WxH warning');
});


test('backfill: non-WxH legacy size ("KG") is NOT backfilled and a warning is logged', () => {
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-code', controllerId: 'ctrl-noritsu', productCode: 'PHOTO4X6',
        options: [], channelNumber: 1, printSizeCode: '', size: 'KG' },
    ],
  });

  backfillLegacyPrintSizeCode();

  assert.equal(__storeData.channelMappings[0].printSizeCode, '',
    'non-WxH legacy size must stay blank — backfilling it would silently change PSL output '
    + '(legacy `NML -PSIZE "KG"` → backfilled bare `KG` pass-through)');
  assert.equal(__storeData.channelMappings[0].size, 'KG', 'legacy field preserved as-is');

  const warn = __warnings.find(w => w.message.includes('not WxH'));
  assert.ok(warn, 'a warning must be logged for the skipped mapping so operators can find it');
  assert.equal(warn.meta.channelMappingId, 'cm-code');
  assert.equal(warn.meta.controllerId,     'ctrl-noritsu');
  assert.equal(warn.meta.productCode,      'PHOTO4X6');
  assert.equal(warn.meta.legacySize,       'KG');
});


test('backfill: pre-formatted NML legacy size is also not backfilled (not bare WxH)', () => {
  // A defensive case — historically nothing wrote pre-formatted NML into
  // the `size` field, but if it happened, backfilling it would double-wrap
  // on resolve (pass-through of the modern printSizeCode). Skip + warn.
  __seed({
    orderControllers: [NORITSU_CTRL],
    channelMappings: [
      { id: 'cm-nml', controllerId: 'ctrl-noritsu', productCode: 'X',
        options: [], printSizeCode: '', size: 'NML -PSIZE "8x4"' },
    ],
  });

  backfillLegacyPrintSizeCode();

  assert.equal(__storeData.channelMappings[0].printSizeCode, '');
  assert.equal(__warnings.length, 1);
});


// Restore require shim hygiene so unrelated tests in the same worker aren't
// affected by our electron/electron-store swaps.
test.after(() => { Module.prototype.require = __originalRequire; });
