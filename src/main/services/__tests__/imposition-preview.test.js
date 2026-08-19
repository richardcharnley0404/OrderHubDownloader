/**
 * Unit tests for imposition-preview — the main-process layout previewer
 * powering the M4 template editor. The preview MUST return exactly what
 * the real M1 engine returns (the whole point of the module) so these
 * tests assert equality against `computeLayout` directly, NOT against
 * hand-copied literals.
 *
 * If a future change breaks the equality-with-engine contract, this file
 * catches it before the operator sees a preview grid that disagrees with
 * dispatch — the failure mode this module exists to prevent (§6.2 "never
 * a parallel implementation"; the M5a lesson from folder-copy-preview).
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { previewLayout } = require(
  path.join(REPO, 'src', 'main', 'services', 'imposition-preview.js'),
);
const { computeLayout, inchesToPoints } = require(
  path.join(REPO, 'src', 'pdf-pipeline', 'imposition-layout.js'),
);

const IN = inchesToPoints;

// A worked-example template (5×7 cell on 12×18 sheet, 0.25 in margins &
// gutter, autoRotate on, simplex). Locked at M1 to a 2×2 unrotated
// layout with perSheet=4. The preview must reproduce that same result.
const WORKED_5x7 = {
  paperSize:       { width: IN(12), height: IN(18) },
  margins: {
    top:    IN(0.25),
    right:  IN(0.25),
    bottom: IN(0.25),
    left:   IN(0.25),
  },
  gutter:          IN(0.25),
  expectedArtwork: { width: IN(5), height: IN(7) },
  autoRotate:      true,
  mode:            'simplex',
};

// ═════════════════════════════════════════════════════════════════════════
// Equality-with-engine: valid template → preview.layout === computeLayout()
// ═════════════════════════════════════════════════════════════════════════

test('preview: valid simplex template — returned layout equals computeLayout() with the same inputs (the whole point)', async () => {
  const out = await previewLayout(WORKED_5x7);
  assert.equal(out.ok, true);

  const direct = computeLayout({
    sheetWidth:  WORKED_5x7.paperSize.width,
    sheetHeight: WORKED_5x7.paperSize.height,
    margins:     WORKED_5x7.margins,
    gutter:      WORKED_5x7.gutter,
    cellWidth:   WORKED_5x7.expectedArtwork.width,
    cellHeight:  WORKED_5x7.expectedArtwork.height,
    autoRotate:  WORKED_5x7.autoRotate,
    mode:        WORKED_5x7.mode,
  });

  // Deep equality against the engine's return — proves the preview IS
  // the engine, not a lookalike. Also implicitly locks the "layout"
  // property name so the renderer's SVG code has a stable contract.
  assert.deepEqual(out.layout, direct);
});

test('preview: valid duplex template — returned layout equals computeLayout() including the back array', async () => {
  const duplex = { ...WORKED_5x7, mode: 'duplex', duplexFlipEdge: 'long' };
  const out = await previewLayout(duplex);
  assert.equal(out.ok, true);

  const direct = computeLayout({
    sheetWidth:  duplex.paperSize.width,
    sheetHeight: duplex.paperSize.height,
    margins:     duplex.margins,
    gutter:      duplex.gutter,
    cellWidth:   duplex.expectedArtwork.width,
    cellHeight:  duplex.expectedArtwork.height,
    autoRotate:  duplex.autoRotate,
    mode:        duplex.mode,
    duplexFlipEdge: duplex.duplexFlipEdge,
  });

  assert.deepEqual(out.layout, direct);
  // Renderer needs to caption "backs mirror across the long/short edge"
  // — it reads this off the response, not the input.
  assert.equal(out.duplexFlipEdge, 'long');
});

test('preview: echoes sheetWidth/sheetHeight/margins/gutter/mode back to the renderer', async () => {
  const out = await previewLayout(WORKED_5x7);
  assert.equal(out.sheetWidth,  WORKED_5x7.paperSize.width);
  assert.equal(out.sheetHeight, WORKED_5x7.paperSize.height);
  assert.deepEqual(out.margins, WORKED_5x7.margins);
  assert.equal(out.gutter,      WORKED_5x7.gutter);
  assert.equal(out.mode,        'simplex');
  assert.equal(out.duplexFlipEdge, null);   // simplex → null (renderer can suppress the caption)
});

// ═════════════════════════════════════════════════════════════════════════
// Zero-fit — the preview surfaces the ENGINE's error message verbatim
// so what the operator sees in the preview panel is the exact string
// they'll see if they try to Save (§6.2 rule).
// ═════════════════════════════════════════════════════════════════════════

test('preview: zero-fit template surfaces the ENGINE\'s error message verbatim', async () => {
  // Cell 13×19 in on a 12×18 in sheet — bigger than the paper.
  const oversized = {
    ...WORKED_5x7,
    expectedArtwork: { width: IN(13), height: IN(19) },
  };
  const out = await previewLayout(oversized);
  assert.equal(out.ok, false);

  // Get the engine's OWN error text for the same inputs and compare.
  let engineMessage = null;
  try {
    computeLayout({
      sheetWidth:  oversized.paperSize.width,
      sheetHeight: oversized.paperSize.height,
      margins:     oversized.margins,
      gutter:      oversized.gutter,
      cellWidth:   oversized.expectedArtwork.width,
      cellHeight:  oversized.expectedArtwork.height,
      autoRotate:  oversized.autoRotate,
      mode:        oversized.mode,
    });
  } catch (err) {
    engineMessage = err.message;
  }
  assert.ok(engineMessage, 'engine must have thrown for the equality check to be meaningful');
  assert.equal(out.error, engineMessage);
});

test('preview: autoRotate-only-fits-rotated case saves rotated=true (drives the real engine)', async () => {
  // The M3-flavour proof case: cell 8×3 on 6×20 sheet fits ONLY when
  // rotated. autoRotate:true → rotated=true, perSheet=4. A stubbed
  // "fits" check that returns a made-up layout would fail this test
  // because the rotated flag drives from the engine's own decision.
  const rotatedOnly = {
    paperSize:       { width: 6, height: 20 },
    margins:         { top: 0, right: 0, bottom: 0, left: 0 },
    gutter:          0,
    expectedArtwork: { width: 8, height: 3 },
    autoRotate:      true,
    mode:            'simplex',
  };
  const out = await previewLayout(rotatedOnly);
  assert.equal(out.ok, true);
  assert.equal(out.layout.rotated, true);
  assert.equal(out.layout.perSheet, 4);
});

test('preview: autoRotate OFF on the same case rejects with the engine\'s zero-fit message', async () => {
  const rotatedOffButNeedsRotation = {
    paperSize:       { width: 6, height: 20 },
    margins:         { top: 0, right: 0, bottom: 0, left: 0 },
    gutter:          0,
    expectedArtwork: { width: 8, height: 3 },
    autoRotate:      false,
    mode:            'simplex',
  };
  const out = await previewLayout(rotatedOffButNeedsRotation);
  assert.equal(out.ok, false);
  assert.match(out.error, /0 cells per sheet/);
});

// ═════════════════════════════════════════════════════════════════════════
// Shape-check messages — "pick X" wording for missing/incomplete inputs.
// These fire before the engine is called (a valid engine call requires
// all the fields), so an operator who has half-typed a template gets a
// specific "you're missing X" message instead of a confusing engine error.
// ═════════════════════════════════════════════════════════════════════════

test('preview: missing paperSize → "pick a paper size" message', async () => {
  const out = await previewLayout({ ...WORKED_5x7, paperSize: null });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'Pick a paper size to preview the layout.');
});

test('preview: missing expectedArtwork → "enter an expected artwork size" message', async () => {
  const out = await previewLayout({ ...WORKED_5x7, expectedArtwork: null });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'Enter an expected artwork size (width × height) to preview the layout.');
});

test('preview: missing mode → "pick a mode" message', async () => {
  const out = await previewLayout({ ...WORKED_5x7, mode: undefined });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'Pick a mode (simplex or duplex) to preview the layout.');
});

test('preview: duplex without a flip edge → "pick a flip edge" message', async () => {
  const out = await previewLayout({ ...WORKED_5x7, mode: 'duplex' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'Pick a duplex flip edge (long or short) to preview the layout.');
});

test('preview: no input at all → clear error, does NOT throw', async () => {
  const out = await previewLayout();
  assert.equal(out.ok, false);
  assert.ok(out.error);
});
