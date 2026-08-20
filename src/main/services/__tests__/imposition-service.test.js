/**
 * Unit tests for imposition-service — org-level electron-store CRUD +
 * save-time validation for paper sizes and imposition templates
 * (M3 of docs/pdf-imposition-investigation.md).
 *
 * Testing strategy:
 *   - Shim `electron-store` with an in-memory FakeStore so the module
 *     loads headless (same pattern as routing-picpro-order-merge.test.js).
 *   - Test the service functions directly. The IPC handlers in
 *     ipc-handlers.js are trivially thin wrappers over these functions,
 *     so validating the service covers the IPC boundary too.
 *   - EVERY reject rule gets an exact-message assertion — the renderer
 *     surfaces these strings verbatim to the operator; a drift in
 *     wording is an operator-visible regression.
 *   - Fit validation runs the REAL M1 engine (no spy) via a case that
 *     ONLY the real engine handles correctly: cell that fits only when
 *     rotated. A stubbed check that returns "fits" unconditionally
 *     would pass the autoRotate-off variant of this test; the real
 *     engine correctly rejects it.
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');

// ── FakeStore shim ───────────────────────────────────────────────────────

const __storeData = {};
function FakeStore() {
  return {
    get: (k, d) => (k in __storeData ? __storeData[k] : d),
    set: (k, v) => { __storeData[k] = v; },
    delete: (k) => { delete __storeData[k]; },
    has:  (k) => (k in __storeData),
  };
}
function __resetStore() {
  for (const k of Object.keys(__storeData)) delete __storeData[k];
}

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const {
  listPaperSizes, savePaperSize, deletePaperSize, validatePaperSize,
  listTemplates,  saveTemplate,  deleteTemplate,  validateTemplate,
  normaliseProductCodes,
  _KEY_PAPER, _KEY_TEMPLATES,
} = require(path.join(REPO, 'src', 'main', 'services', 'imposition-service.js'));

const { inchesToPoints } = require(
  path.join(REPO, 'src', 'pdf-pipeline', 'imposition-layout.js'),
);

// ─── Helpers ─────────────────────────────────────────────────────────────

const IN = inchesToPoints; // brevity in fixtures

function _seedPaperSize(overrides = {}) {
  const ps = {
    id:     'ps-12x18',
    name:   '12×18 in',
    width:  IN(12),
    height: IN(18),
    unit:   'in',
    ...overrides,
  };
  __storeData[_KEY_PAPER] = [ps];
  return ps;
}

// A well-formed template fixture (5×7 on the 12×18 seeded paper size,
// 4-up). Every reject-rule test starts from this and mutates ONE field.
function _validTemplateInput(overrides = {}) {
  return {
    name:        'Grad card 5×7',
    paperSizeId: 'ps-12x18',
    gutter:      IN(0.25),
    margins: {
      top: IN(0.25), right: IN(0.25), bottom: IN(0.25), left: IN(0.25),
    },
    expectedArtwork: { width: IN(5), height: IN(7) },
    autoRotate:      true,
    artworkBleed:    0,
    cropMarks:       true,
    mode:            'simplex',
    productCodes:    ['GRAD5X7'],
    outputSubfolder: '',
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// normaliseProductCodes — trims, dedupes case-insensitively
// ═════════════════════════════════════════════════════════════════════════

test('normaliseProductCodes: trims whitespace, drops empties, dedupes case-insensitively (first casing wins)', () => {
  const out = normaliseProductCodes(['  ABC  ', 'def', 'abc', '', '   ', 'ABC', 'DEF']);
  assert.deepEqual(out, ['ABC', 'def']);
});

test('normaliseProductCodes: non-array input → []', () => {
  assert.deepEqual(normaliseProductCodes(null),       []);
  assert.deepEqual(normaliseProductCodes(undefined),  []);
  assert.deepEqual(normaliseProductCodes('abc'),      []);
  assert.deepEqual(normaliseProductCodes({}),         []);
});

// ═════════════════════════════════════════════════════════════════════════
// Paper size — validate, save, delete
// ═════════════════════════════════════════════════════════════════════════

test('paperSize validate: name required', () => {
  const v = validatePaperSize({ width: 864, height: 1296, unit: 'in' });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Paper size name is required.');
});

test('paperSize validate: width must be positive number', () => {
  const v = validatePaperSize({ name: 'x', width: 0, height: 100, unit: 'in' });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Paper size width must be a positive number in points (got 0).');
});

test('paperSize validate: height must be positive number', () => {
  const v = validatePaperSize({ name: 'x', width: 100, height: -1, unit: 'in' });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Paper size height must be a positive number in points (got -1).');
});

test('paperSize validate: unit must be in or mm', () => {
  const v = validatePaperSize({ name: 'x', width: 100, height: 100, unit: 'cm' });
  assert.equal(v.ok, false);
  assert.equal(v.error, `Paper size unit must be 'in' or 'mm' (got "cm").`);
});

test('paperSize validate: accepts a well-formed input, returns normalised value with trimmed name', () => {
  const v = validatePaperSize({ name: '  12×18 in  ', width: 864, height: 1296, unit: 'in' });
  assert.equal(v.ok, true);
  assert.equal(v.value.name, '12×18 in');
  assert.equal(v.value.width, 864);
  assert.equal(v.value.height, 1296);
  assert.equal(v.value.unit, 'in');
});

test('paperSize save + list: accept path round-trips through the store stub', () => {
  __resetStore();
  const saved = savePaperSize({ name: '12×18 in', width: IN(12), height: IN(18), unit: 'in' });
  assert.ok(saved.id, 'save assigns an id on new records');
  const list = listPaperSizes();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], saved);
});

test('paperSize save: throws with the exact reject message on invalid input', () => {
  __resetStore();
  assert.throws(
    () => savePaperSize({ name: '', width: 100, height: 100, unit: 'in' }),
    { message: 'Paper size name is required.' },
  );
});

test('paperSize save: update preserves id when passed', () => {
  __resetStore();
  const saved = savePaperSize({ name: 'A', width: 100, height: 100, unit: 'in' });
  const updated = savePaperSize({ ...saved, name: 'B' });
  assert.equal(updated.id, saved.id);
  assert.equal(listPaperSizes().length, 1);
  assert.equal(listPaperSizes()[0].name, 'B');
});

test('paperSize delete: unused paper size is removed', () => {
  __resetStore();
  const saved = savePaperSize({ name: 'A', width: 100, height: 100, unit: 'in' });
  deletePaperSize(saved.id);
  assert.deepEqual(listPaperSizes(), []);
});

test('paperSize delete: BLOCKED when any template references it — error names the templates', () => {
  __resetStore();
  _seedPaperSize();
  const t1 = saveTemplate(_validTemplateInput({ name: 'Grad A' }));
  const t2 = saveTemplate(_validTemplateInput({ name: 'Grad B', productCodes: ['GRAD_B'] }));
  assert.throws(
    () => deletePaperSize('ps-12x18'),
    (err) => {
      // Names both templates so operator knows which to fix
      assert.match(err.message, /'Grad A'/);
      assert.match(err.message, /'Grad B'/);
      assert.match(err.message, /cannot be deleted/);
      return true;
    },
  );
  // Deletion did NOT happen
  assert.equal(listPaperSizes().length, 1);
  void t1; void t2;
});

// ═════════════════════════════════════════════════════════════════════════
// Template — every reject rule + accept round-trip
// ═════════════════════════════════════════════════════════════════════════

test('template validate: name required', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ name: '' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template name is required.');
});

test('template validate: paperSizeId must reference an existing paper size', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ paperSizeId: 'nope' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template paperSizeId does not exist (got "nope").');
});

test('template validate: gutter must be non-negative', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ gutter: -1 }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template gutter must be a non-negative number in points (got -1).');
});

test('template validate: margins.left must be non-negative', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({
    margins: { top: 0, right: 0, bottom: 0, left: -5 },
  }), { existingTemplates: [], paperSizes: listPaperSizes() });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template margins.left must be a non-negative number in points (got -5).');
});

test('template validate: artworkBleed must be non-negative', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ artworkBleed: -3 }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template artworkBleed must be a non-negative number in points (got -3).');
});

test('template validate: mode must be simplex or duplex', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ mode: 'sideways' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, `Template mode must be 'simplex' or 'duplex' (got "sideways").`);
});

test('template validate: duplex mode requires a valid flip edge', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ mode: 'duplex' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, `Template duplex mode requires duplexFlipEdge 'long' or 'short' (got undefined).`);
});

test('template validate: gutter < 2 × artworkBleed rejected with the overlap warning', () => {
  __resetStore();
  _seedPaperSize();
  // gutter 10 pt, bleed 6 pt → required 12 pt, missing by 2 pt.
  const v = validateTemplate(_validTemplateInput({
    gutter: 10, artworkBleed: 6,
  }), { existingTemplates: [], paperSizes: listPaperSizes() });
  assert.equal(v.ok, false);
  assert.match(v.error, /gutter \(10 pt\) must be at least 2× artworkBleed \(6 pt → 12 pt\)/);
  assert.match(v.error, /neighbouring bleeds would overlap/);
});

test('template validate: expectedArtwork is REQUIRED (§5.1) — missing rejects with dedicated message', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ expectedArtwork: undefined }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template expectedArtwork { width, height } is required (§5.1).');
});

test('template validate: expectedArtwork.width must be positive', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({
    expectedArtwork: { width: 0, height: 100 },
  }), { existingTemplates: [], paperSizes: listPaperSizes() });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template expectedArtwork.width must be a positive number in points (got 0).');
});

test('template validate: outputSubfolder rejects forward-slash path separators', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ outputSubfolder: 'foo/bar' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template outputSubfolder must be a single folder name, not a path (got "foo/bar").');
});

test('template validate: outputSubfolder rejects backslash path separators', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ outputSubfolder: 'foo\\bar' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /outputSubfolder must be a single folder name, not a path/);
});

test('template validate: outputSubfolder strips other unsafe chars (`:`, `*`, `?`, `<`, `>`, `|`, `"`)', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ outputSubfolder: 'card:*?<>|"' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.outputSubfolder, 'card');
});

test('template validate + save: accept path round-trips through the store stub', () => {
  __resetStore();
  _seedPaperSize();
  const saved = saveTemplate(_validTemplateInput());
  assert.ok(saved.id, 'save assigns an id on new records');
  assert.equal(saved.name, 'Grad card 5×7');
  assert.deepEqual(saved.expectedArtwork, { width: IN(5), height: IN(7) });
  const list = listTemplates();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], saved);
});

test('template save: duplex mode persists duplexFlipEdge; simplex nulls it', () => {
  __resetStore();
  _seedPaperSize();
  const simplexSaved = saveTemplate(_validTemplateInput({ name: 'S', productCodes: ['S1'] }));
  assert.equal(simplexSaved.duplexFlipEdge, null);
  const duplexSaved = saveTemplate(_validTemplateInput({
    name: 'D', productCodes: ['D1'],
    mode: 'duplex', duplexFlipEdge: 'long',
  }));
  assert.equal(duplexSaved.duplexFlipEdge, 'long');
});

// ─── M7: fillLastSheet ────────────────────────────────────────────────

test('template validate: fillLastSheet DEFAULTS TO TRUE when absent (M7 read-boundary default)', () => {
  __resetStore();
  _seedPaperSize();
  const input = _validTemplateInput();
  // Fixture already omits fillLastSheet — this asserts the omission
  // produces `true` on the persisted record, so a template written
  // via a UI that hasn't heard of the field yet still fills sheets.
  assert.equal(input.fillLastSheet, undefined, 'fixture omits fillLastSheet (guards against test drift)');
  const v = validateTemplate(input, { existingTemplates: [], paperSizes: listPaperSizes() });
  assert.equal(v.ok, true);
  assert.equal(v.value.fillLastSheet, true);
});

test('template validate: fillLastSheet explicit true accepted', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ fillLastSheet: true }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.fillLastSheet, true);
});

test('template validate: fillLastSheet explicit false accepted (opt-out for labs that want exact counts)', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ fillLastSheet: false }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.fillLastSheet, false);
});

test('template validate: fillLastSheet non-boolean REJECTS with exact message (strict boolean)', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ fillLastSheet: 'yes' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'Template fillLastSheet must be a boolean (got "yes").');
});

// ─── M8: outputPath, jobSubfolder, filenameTemplate ─────────────────

test('template validate: outputPath BLANK is fine (falls back to controller outputPath at dispatch)', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ outputPath: '' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.outputPath, '');
});

test('template validate: outputPath ABSOLUTE (POSIX or Win32) accepted', () => {
  __resetStore();
  _seedPaperSize();
  // Use a path that path.isAbsolute() accepts on both POSIX and Win32.
  // On POSIX '/press/hot' is absolute; on Win32 an absolute path needs
  // a drive letter or UNC. path.isAbsolute() is platform-aware, so
  // pick the shape for the running platform.
  const absPath = process.platform === 'win32' ? 'C:\\press\\hot' : '/press/hot';
  const v = validateTemplate(_validTemplateInput({ outputPath: absPath }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, true, `expected accept for ${absPath}: ${v.error}`);
  assert.equal(v.value.outputPath, absPath);
});

test('template validate: outputPath RELATIVE rejects with a message pointing at the fix', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ outputPath: 'press/hot' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /must be an absolute path/);
  assert.match(v.error, /Leave blank to use the controller's output path/);
});

test('template validate: jobSubfolder DEFAULTS TO FALSE when absent (M8 flat-output default)', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput(), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.jobSubfolder, false);
});

test('template validate: jobSubfolder explicit true accepted; non-boolean rejects with exact message', () => {
  __resetStore();
  _seedPaperSize();
  const vOk = validateTemplate(_validTemplateInput({ jobSubfolder: true }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(vOk.ok, true);
  assert.equal(vOk.value.jobSubfolder, true);

  const vBad = validateTemplate(_validTemplateInput({ jobSubfolder: 'on' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(vBad.ok, false);
  assert.equal(vBad.error, 'Template jobSubfolder must be a boolean (got "on").');
});

test('template validate: filenameTemplate blank is fine → default convention at dispatch', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ filenameTemplate: '' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.filenameTemplate, '');
});

test('template validate: filenameTemplate with {orderNumber} accepted', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ filenameTemplate: '{orderNumber}-{qty}of{impQty}' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.filenameTemplate, '{orderNumber}-{qty}of{impQty}');
});

test('template validate: filenameTemplate with only {qty}/{impQty} REJECTS — those are NOT distinguishing tokens', () => {
  // The flat-folder overwrite hazard: two jobs with the same totals
  // would collide on the same filename. The three distinguishing
  // tokens ({orderNumber}, {jobName}, {jobId}) are the only guards.
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ filenameTemplate: 'run-{qty}of{impQty}' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /must contain at least one of \{orderNumber\}, \{jobName\}, \{jobId\}/);
  assert.match(v.error, /files from different jobs don't overwrite each other/);
  assert.match(v.error, /\{qty\} and \{impQty\} are NOT sufficient/);
});

test('template validate: filenameTemplate without ANY distinguishing token REJECTS', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({ filenameTemplate: '{customerName}-{date}' }), {
    existingTemplates: [], paperSizes: listPaperSizes(),
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /must contain at least one of \{orderNumber\}, \{jobName\}, \{jobId\}/);
});

test('template validate: each of {jobName} / {jobId} alone also satisfies the distinguishing-token rule', () => {
  __resetStore();
  _seedPaperSize();
  for (const tpl of ['{jobName}-{qty}', 'job-{jobId}-{impQty}']) {
    const v = validateTemplate(_validTemplateInput({ filenameTemplate: tpl }), {
      existingTemplates: [], paperSizes: listPaperSizes(),
    });
    assert.equal(v.ok, true, `expected accept for ${tpl}: ${v.error}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Fit validation — driven through the REAL M1 engine.
//
// The test case: cell 8×3 pt on a 6×20 pt paper size. Unrotated the
// cell width (8) exceeds usable width (6) so 0 fit. Rotated (3×8) fits
// 2×2 = 4. Only the real engine gives this asymmetric answer; a
// stubbed-out fit checker returning "fits" unconditionally would pass
// BOTH the autoRotate-on and autoRotate-off variants and fail this
// suite's autoRotate-off assertion.
// ═════════════════════════════════════════════════════════════════════════

test('template fit validation: autoRotate ON — case that ONLY fits rotated SAVES (drives the real engine)', () => {
  __resetStore();
  const smallPaper = savePaperSize({ name: 'strip', width: 6, height: 20, unit: 'in' });
  const v = validateTemplate({
    name:        'rotated-only',
    paperSizeId: smallPaper.id,
    gutter:      0,
    margins:     { top: 0, right: 0, bottom: 0, left: 0 },
    expectedArtwork: { width: 8, height: 3 },
    autoRotate:  true,
    artworkBleed: 0,
    mode:        'simplex',
    productCodes: [],
  }, { existingTemplates: [], paperSizes: listPaperSizes() });
  assert.equal(v.ok, true, `expected accept but got: ${v.error}`);
});

test('template fit validation: autoRotate OFF — same case REJECTS with the engine\'s zero-fit message', () => {
  __resetStore();
  const smallPaper = savePaperSize({ name: 'strip', width: 6, height: 20, unit: 'in' });
  const v = validateTemplate({
    name:        'rotated-only-off',
    paperSizeId: smallPaper.id,
    gutter:      0,
    margins:     { top: 0, right: 0, bottom: 0, left: 0 },
    expectedArtwork: { width: 8, height: 3 },
    autoRotate:  false,
    artworkBleed: 0,
    mode:        'simplex',
    productCodes: [],
  }, { existingTemplates: [], paperSizes: listPaperSizes() });
  assert.equal(v.ok, false);
  // The message is prefixed by this module and then carries the M1
  // engine's own text — that concatenation is what proves the fit
  // check went through the real engine (not a hand-rolled reimplementation).
  assert.match(v.error, /Template does not fit paper size:/);
  assert.match(v.error, /0 cells per sheet/);
});

test('template fit validation: obvious oversize (13×19 on 12×18) rejects', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({
    expectedArtwork: { width: IN(13), height: IN(19) },
  }), { existingTemplates: [], paperSizes: listPaperSizes() });
  assert.equal(v.ok, false);
  assert.match(v.error, /Template does not fit paper size/);
});

// ═════════════════════════════════════════════════════════════════════════
// Product-code collision — BOTH directions
// ═════════════════════════════════════════════════════════════════════════

test('template product-code collision: new template collides with existing → REJECT names both templates', () => {
  __resetStore();
  _seedPaperSize();
  const existing = saveTemplate(_validTemplateInput({
    name:         'existing template',
    productCodes: ['ABC'],
  }));
  assert.throws(
    () => saveTemplate(_validTemplateInput({
      name:         'colliding new',
      productCodes: ['ABC'],
    })),
    (err) => {
      assert.match(err.message, /Product code 'ABC'/);
      assert.match(err.message, /'existing template'/);
      assert.match(err.message, /A product code may belong to only one template/);
      return true;
    },
  );
  // No side effect — only the original template is in the store
  assert.equal(listTemplates().length, 1);
  assert.equal(listTemplates()[0].id, existing.id);
});

test('template product-code collision: case-insensitive — new [abc] collides with existing [ABC]', () => {
  __resetStore();
  _seedPaperSize();
  saveTemplate(_validTemplateInput({ name: 'first', productCodes: ['ABC'] }));
  assert.throws(
    () => saveTemplate(_validTemplateInput({ name: 'second', productCodes: ['abc'] })),
    /Product code 'ABC'/,
  );
});

test('template product-code collision: OTHER DIRECTION — updating an existing template with a code claimed by another rejects', () => {
  __resetStore();
  _seedPaperSize();
  const a = saveTemplate(_validTemplateInput({ name: 'A', productCodes: ['A1'] }));
  const b = saveTemplate(_validTemplateInput({ name: 'B', productCodes: ['B1'] }));
  // Try to update A to also claim 'B1' — must reject naming B
  assert.throws(
    () => saveTemplate({ ...a, productCodes: ['A1', 'B1'] }),
    (err) => {
      assert.match(err.message, /Product code 'B1'/);
      assert.match(err.message, /'B'/);
      return true;
    },
  );
  // Neither template was mutated
  assert.deepEqual(listTemplates().find(t => t.id === a.id).productCodes, ['A1']);
  assert.deepEqual(listTemplates().find(t => t.id === b.id).productCodes, ['B1']);
});

test('template product-code collision: updating a template with ITS OWN existing codes does NOT collide (self-check)', () => {
  __resetStore();
  _seedPaperSize();
  const a = saveTemplate(_validTemplateInput({ name: 'A', productCodes: ['A1', 'A2'] }));
  // Re-save the same template with the same codes — must accept.
  // Without the self-check, the code list would collide with itself.
  const resaved = saveTemplate(a);
  assert.deepEqual(resaved.productCodes, ['A1', 'A2']);
});

// ═════════════════════════════════════════════════════════════════════════
// Template delete
// ═════════════════════════════════════════════════════════════════════════

test('template delete: existing template is removed', () => {
  __resetStore();
  _seedPaperSize();
  const t = saveTemplate(_validTemplateInput());
  deleteTemplate(t.id);
  assert.deepEqual(listTemplates(), []);
});

test('template delete: non-existent id is a no-op (does not throw)', () => {
  __resetStore();
  _seedPaperSize();
  saveTemplate(_validTemplateInput());
  deleteTemplate('never-saved-this-id');
  assert.equal(listTemplates().length, 1);
});

// ═════════════════════════════════════════════════════════════════════════
// Missing margins default to 0 (partial margins object legal)
// ═════════════════════════════════════════════════════════════════════════

test('template validate: partial margins object — missing edges default to 0', () => {
  __resetStore();
  _seedPaperSize();
  const v = validateTemplate(_validTemplateInput({
    margins: { bottom: IN(0.5) },  // only bottom supplied
  }), { existingTemplates: [], paperSizes: listPaperSizes() });
  assert.equal(v.ok, true);
  assert.equal(v.value.margins.top, 0);
  assert.equal(v.value.margins.right, 0);
  assert.equal(v.value.margins.left, 0);
  assert.equal(v.value.margins.bottom, IN(0.5));
});

// Restore Module.prototype.require so this test file doesn't leak the
// electron-store shim into other test files running in the same process.
// (Currently our npm test script sets --test-concurrency=1 and each
// file's shim is scoped to its own module cache, but restoring is
// cheap defence.)
test('teardown: restore original Module.prototype.require', () => {
  Module.prototype.require = __originalRequire;
  assert.ok(true);
});
