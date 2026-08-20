/**
 * Unit tests for imposition-compose — deriveTrim + planPlacements +
 * composeImposition. Fixture PDFs are built inline with pdf-lib inside
 * each test (no golden-file bytes checked into the repo, per the M2
 * spec) and, where the composer produces output, the output bytes are
 * REOPENED with pdf-lib and asserted STRUCTURALLY (page count, MediaBox
 * size, error posture) — never by inspecting content-stream operators,
 * which would be brittle to pdf-lib version changes.
 *
 * The correctness surface for positions is planPlacements (pure), which
 * this file covers exhaustively; the composer draws the plan verbatim.
 *
 * M7a discipline: each expected value derives from the geometric or
 * structural invariant its test title states — nothing is copied from
 * observed output.
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const { PDFDocument, rgb } = require('pdf-lib');

const {
  deriveTrim,
  planPlacements,
  composeImposition,
  _internal,
} = require(path.join(REPO, 'src', 'pdf-pipeline', 'imposition-compose.js'));

const {
  computeLayout,
  inchesToPoints,
} = require(path.join(REPO, 'src', 'pdf-pipeline', 'imposition-layout.js'));

// ─── Fixture helpers ─────────────────────────────────────────────────────
// Small, focused helpers that build in-memory artwork PDFs. Each test
// composes its own fixture inline so failures point at ONE thing, not at
// a shared setup.

async function _makeArtwork({ mediaW, mediaH, pages = 1, trimBox = null }) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([mediaW, mediaH]);
    if (trimBox) {
      page.setTrimBox(trimBox.x, trimBox.y, trimBox.width, trimBox.height);
    }
    // pdf-lib's embedPages refuses a page with no /Contents object — a
    // real design tool always produces one, but a freshly-added blank
    // page does not. Draw a 1 pt white square so the fixture is
    // embed-legal without introducing visible noise.
    page.drawRectangle({ x: 0, y: 0, width: 1, height: 1, color: rgb(1, 1, 1) });
  }
  return doc.save();
}

// A minimal synthetic layout that satisfies planPlacements' contract
// without needing computeLayout to be involved. Keeps the pure-plan
// tests isolated from the layout module.
function _synthLayout({ perSheet, front, back = null, rotated = false }) {
  return {
    rotated,
    cols: front.length,   // shape doesn't matter for planPlacements
    rows: 1,
    perSheet,
    cellW: 100,
    cellH: 100,
    front,
    back,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// deriveTrim — four rule cases (§3.1)
// ═════════════════════════════════════════════════════════════════════════

test('deriveTrim: explicit TrimBox smaller than MediaBox → TrimBox returned verbatim', async () => {
  // Media 380×524, Trim inset by 10 on all sides → 360×504 at (10, 10).
  // Per §3.1: TrimBox present and smaller than MediaBox → use TrimBox.
  const doc = await PDFDocument.create();
  const page = doc.addPage([380, 524]);
  page.setTrimBox(10, 10, 360, 504);
  const trim = deriveTrim(page, 0);
  assert.deepEqual(trim, { x: 10, y: 10, width: 360, height: 504 });
});

test('deriveTrim: explicit TrimBox smaller than MediaBox — bleed argument is IGNORED', async () => {
  // With TrimBox present, artworkBleed is not consulted: the design tool
  // has already stated the trim, so we honour it. A stale artworkBleed
  // setting on the template must not silently re-inset a page that
  // already has a good TrimBox.
  const doc = await PDFDocument.create();
  const page = doc.addPage([380, 524]);
  page.setTrimBox(10, 10, 360, 504);
  const trim = deriveTrim(page, 25); // non-zero bleed, should be ignored
  assert.deepEqual(trim, { x: 10, y: 10, width: 360, height: 504 });
});

test('deriveTrim: no explicit TrimBox, artworkBleed 0 → MediaBox returned as trim', async () => {
  // pdf-lib's getTrimBox() falls back to MediaBox when no /TrimBox is
  // set — so this case is indistinguishable from "TrimBox = MediaBox
  // explicitly", which is exactly the right behaviour (both mean the
  // design tool has not staked a trim claim distinct from media).
  const doc = await PDFDocument.create();
  const page = doc.addPage([360, 504]);
  const trim = deriveTrim(page, 0);
  assert.deepEqual(trim, { x: 0, y: 0, width: 360, height: 504 });
});

test('deriveTrim: no explicit TrimBox, artworkBleed 5 → MediaBox inset by 5 on all sides', async () => {
  // Template says "these files carry 5 pt bleed but no TrimBox" — the
  // caller's escape hatch for hobbyist-designed cards (§3.1). Derived
  // trim is media minus 2×bleed in each dimension, offset by bleed.
  const doc = await PDFDocument.create();
  const page = doc.addPage([370, 514]);
  const trim = deriveTrim(page, 5);
  assert.deepEqual(trim, { x: 5, y: 5, width: 360, height: 504 });
});

test('deriveTrim: TrimBox equal to MediaBox (redundant explicit set) → treated as no-trim', async () => {
  // A page with TrimBox set explicitly to MediaBox conveys no extra
  // information vs no TrimBox at all — both fall through to the bleed-
  // inset branch. The comparison uses BOX_EPS so a same-size explicit
  // TrimBox at a different origin (rare) is still treated as absent
  // when its dimensions equal the media's.
  const doc = await PDFDocument.create();
  const page = doc.addPage([360, 504]);
  page.setTrimBox(0, 0, 360, 504);
  const trim = deriveTrim(page, 3);
  // Falls through to bleed-inset branch: media inset by 3.
  assert.deepEqual(trim, { x: 3, y: 3, width: 354, height: 498 });
});

// ═════════════════════════════════════════════════════════════════════════
// planPlacements — pure, exhaustive. Synthetic layouts keep these
// tests isolated from computeLayout.
// ═════════════════════════════════════════════════════════════════════════

test('planPlacements: simplex qty 1 on 1-up → 1 entry, sheets 1', () => {
  const layout = _synthLayout({
    perSheet: 1,
    front: [{ x: 10, y: 20 }],
  });
  const out = planPlacements({ quantity: 1, layout, mode: 'simplex' });
  assert.equal(out.sheets, 1);
  assert.equal(out.placedPerSheet, 1);
  assert.deepEqual(out.plan, [
    { sheet: 0, side: 'front', cellIndex: 0, x: 10, y: 20, rotated: false },
  ]);
});

test('planPlacements: simplex qty 4 on 4-up → 4 entries, all sheet 0, row-major', () => {
  const layout = _synthLayout({
    perSheet: 4,
    front: [
      { x:  0, y: 100 },
      { x: 50, y: 100 },
      { x:  0, y:   0 },
      { x: 50, y:   0 },
    ],
  });
  const out = planPlacements({ quantity: 4, layout, mode: 'simplex' });
  assert.equal(out.sheets, 1);
  assert.equal(out.plan.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(out.plan[i].sheet,     0,       `entry ${i} sheet`);
    assert.equal(out.plan[i].side,      'front', `entry ${i} side`);
    assert.equal(out.plan[i].cellIndex, i,       `entry ${i} cellIndex`);
    assert.equal(out.plan[i].x, layout.front[i].x);
    assert.equal(out.plan[i].y, layout.front[i].y);
  }
});

test('planPlacements: simplex qty 5 on 4-up → partial last sheet has 1 entry (§ partial-sheet rule)', () => {
  // Locks: sheet=1 gets exactly (5-4)=1 entry at cellIndex 0, not
  // sprayed across the layout's cells.
  const layout = _synthLayout({
    perSheet: 4,
    front: [
      { x:  0, y: 100 },
      { x: 50, y: 100 },
      { x:  0, y:   0 },
      { x: 50, y:   0 },
    ],
  });
  const out = planPlacements({ quantity: 5, layout, mode: 'simplex' });
  assert.equal(out.sheets, 2);
  assert.equal(out.plan.length, 5);
  // Sheet 0: 4 entries, cellIndex 0..3
  for (let i = 0; i < 4; i++) {
    assert.equal(out.plan[i].sheet, 0);
    assert.equal(out.plan[i].cellIndex, i);
  }
  // Sheet 1: 1 entry, cellIndex 0
  assert.equal(out.plan[4].sheet, 1);
  assert.equal(out.plan[4].cellIndex, 0);
  assert.equal(out.plan[4].x, layout.front[0].x);
  assert.equal(out.plan[4].y, layout.front[0].y);
});

test('planPlacements: duplex qty 4 on 4-up → 8 entries; ALL fronts THEN all backs per sheet', () => {
  // Order lock per the spec: "within a sheet, all fronts first, then
  // all backs (for duplex)". Composer relies on this order to draw
  // onto the correct target page.
  const layout = _synthLayout({
    perSheet: 4,
    front: [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 0, y: 0 }, { x: 50, y: 0 }],
    back:  [{ x: 50, y: 100 }, { x: 0, y: 100 }, { x: 50, y: 0 }, { x: 0, y: 0 }],
  });
  const out = planPlacements({ quantity: 4, layout, mode: 'duplex' });
  assert.equal(out.sheets, 1);
  assert.equal(out.plan.length, 8);
  // First 4 entries all fronts, row-major
  for (let i = 0; i < 4; i++) {
    assert.equal(out.plan[i].side, 'front', `entry ${i} should be front`);
    assert.equal(out.plan[i].cellIndex, i);
    assert.equal(out.plan[i].x, layout.front[i].x);
    assert.equal(out.plan[i].y, layout.front[i].y);
  }
  // Next 4 entries all backs, row-major
  for (let i = 0; i < 4; i++) {
    assert.equal(out.plan[4 + i].side, 'back', `entry ${4 + i} should be back`);
    assert.equal(out.plan[4 + i].cellIndex, i);
    assert.equal(out.plan[4 + i].x, layout.back[i].x);
    assert.equal(out.plan[4 + i].y, layout.back[i].y);
  }
});

test('planPlacements: duplex qty 5 on 4-up → sheet 0 has 4F+4B, sheet 1 has 1F+1B (back-mirroring on partial sheet)', () => {
  // Spec: "Same back-mirroring on the partial sheet — back[i] only for
  // placed i." Partial sheet has back entries ONLY for the placed
  // cellIndex, not for all 4 layout back positions.
  const layout = _synthLayout({
    perSheet: 4,
    front: [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 0, y: 0 }, { x: 50, y: 0 }],
    back:  [{ x: 50, y: 100 }, { x: 0, y: 100 }, { x: 50, y: 0 }, { x: 0, y: 0 }],
  });
  const out = planPlacements({ quantity: 5, layout, mode: 'duplex' });
  assert.equal(out.sheets, 2);
  assert.equal(out.plan.length, 10);  // (4F+4B) + (1F+1B) = 10
  // Sheet 0: 4 front then 4 back
  const s0 = out.plan.filter(e => e.sheet === 0);
  assert.equal(s0.length, 8);
  assert.equal(s0.filter(e => e.side === 'front').length, 4);
  assert.equal(s0.filter(e => e.side === 'back').length,  4);
  // Sheet 1: 1 front + 1 back (NOT 4 back)
  const s1 = out.plan.filter(e => e.sheet === 1);
  assert.equal(s1.length, 2);
  assert.equal(s1[0].side, 'front');
  assert.equal(s1[0].cellIndex, 0);
  assert.equal(s1[1].side, 'back');
  assert.equal(s1[1].cellIndex, 0);
  assert.equal(s1[1].x, layout.back[0].x);
  assert.equal(s1[1].y, layout.back[0].y);
});

// ─── M7: fillLastSheet — Richard's call, reversing §8 ────────────────────
//
// The four tests below lock the fill behaviour together with the ONE
// edge that MUST NOT regress: filling never adds a sheet. Existing
// partial-sheet tests above run WITHOUT the flag (default false) and
// still pass byte-identical — the no-change lock for the pre-M7 shape.

test('planPlacements fillLastSheet=true: simplex qty 10 on 4-up → 3 sheets, 12 placements, last sheet has 4', () => {
  // Ordered qty = 10; perSheet = 4; ceil(10/4) = 3 sheets. Without fill
  // the last sheet would be a partial 2 (10 - 8). With fill it's 4, so
  // total placements = 4 + 4 + 4 = 12. The extra two are overs — the
  // sheet prints anyway, so the operator gets 2 free copies.
  const layout = _synthLayout({
    perSheet: 4,
    front: [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 0, y: 0 }, { x: 50, y: 0 }],
  });
  const out = planPlacements({ quantity: 10, layout, mode: 'simplex', fillLastSheet: true });
  assert.equal(out.sheets, 3, 'sheet count is unchanged by fill (ordered qty / perSheet)');
  assert.equal(out.plan.length, 12);
  const s2 = out.plan.filter(e => e.sheet === 2);
  assert.equal(s2.length, 4, 'last sheet must be filled to perSheet');
  assert.deepEqual(s2.map(e => e.cellIndex), [0, 1, 2, 3],
    'filled overs use cellIndex 0..perSheet-1 in row-major order');
});

test('planPlacements fillLastSheet=true: duplex qty 10 on 4-up → 24 entries; last sheet 4F+4B; mirror invariant holds through the filled cells', () => {
  // Extends the existing "mirror on partial sheet" test to the filled
  // case: with 4 backs on the last sheet (up from 2), each back's
  // (x, y) must still equal the mirror of its paired front pulled
  // from layout.back[cellIndex]. The user's spec: "12 backs, every
  // one still the sheet-mirror of its front (extend the existing
  // mirror invariant test to the filled sheet)."
  const layout = _synthLayout({
    perSheet: 4,
    front: [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 0, y: 0 }, { x: 50, y: 0 }],
    // back positions are the layout's own mirror decisions — the plan
    // simply pulls from layout.back[cellIndex]. Constructed here so
    // each back[i] is a visibly-distinct mirror of front[i], not a
    // repeat of the front value.
    back:  [{ x: 50, y: 100 }, { x: 0, y: 100 }, { x: 50, y: 0 }, { x: 0, y: 0 }],
  });
  const out = planPlacements({ quantity: 10, layout, mode: 'duplex', fillLastSheet: true });
  assert.equal(out.sheets, 3);
  assert.equal(out.plan.length, 24, '3 sheets × (4 fronts + 4 backs) = 24 entries with fill');
  // For each sheet, exactly 4 fronts then 4 backs, row-major cellIndex.
  for (let s = 0; s < 3; s++) {
    const onSheet = out.plan.filter(e => e.sheet === s);
    assert.equal(onSheet.length, 8, `sheet ${s} filled to 4F+4B`);
    for (let i = 0; i < 4; i++) {
      assert.equal(onSheet[i].side,      'front', `sheet ${s} entry ${i}`);
      assert.equal(onSheet[i].cellIndex, i);
      assert.equal(onSheet[i].x, layout.front[i].x);
      assert.equal(onSheet[i].y, layout.front[i].y);
    }
    for (let i = 0; i < 4; i++) {
      const backEntry = onSheet[4 + i];
      assert.equal(backEntry.side,      'back', `sheet ${s} back entry ${i}`);
      assert.equal(backEntry.cellIndex, i);
      // The invariant: back[i] in the plan equals layout.back[i]
      // verbatim — the LAYOUT computes the sheet-centreline mirror
      // (locked by the M1a asymmetric-margin tests), and the plan
      // never reinterprets it. If a fill regression tried to
      // recompute mirror positions instead of pulling from the
      // layout, THAT would be a wrong-back-on-wrong-front bug and
      // this equality would catch it.
      assert.equal(backEntry.x, layout.back[i].x, `sheet ${s} back ${i} .x`);
      assert.equal(backEntry.y, layout.back[i].y, `sheet ${s} back ${i} .y`);
    }
  }
});

test('planPlacements fillLastSheet=true: EXACT-FIT qty 8 on 4-up → 2 sheets (no phantom extra sheet)', () => {
  // The edge that goes wrong quietly: an implementation that thinks
  // "fill means always add overs" would treat exact-fit qty as needing
  // an extra sheet full of overs. Richard's rule is filling REMOVES
  // BLANKS from an existing sheet — it never adds a sheet. Fill on or
  // off, qty 8 on 4-up = 2 full sheets = 8 placements.
  const layout = _synthLayout({
    perSheet: 4,
    front: [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 0, y: 0 }, { x: 50, y: 0 }],
  });
  const filled  = planPlacements({ quantity: 8, layout, mode: 'simplex', fillLastSheet: true });
  const partial = planPlacements({ quantity: 8, layout, mode: 'simplex', fillLastSheet: false });
  assert.equal(filled.sheets,  2, 'fill on: exact-fit stays 2 sheets');
  assert.equal(partial.sheets, 2, 'fill off: exact-fit is also 2 sheets');
  assert.equal(filled.plan.length,  8);
  assert.equal(partial.plan.length, 8);
  assert.deepEqual(filled.plan.map(e => ({ s: e.sheet, i: e.cellIndex })),
                   partial.plan.map(e => ({ s: e.sheet, i: e.cellIndex })),
                   'fill on vs off produces identical plans when the qty exactly fills perSheet × sheets');
});

test('planPlacements: fillLastSheet defaults to false — pre-M7 caller shape is byte-identical to explicit false', () => {
  // The default matters: the pre-M7 behaviour (partial last sheet) must
  // be preserved when the CALLER omits the option. The template's own
  // fillLastSheet default is TRUE (M3 read boundary), but the engine's
  // default is FALSE so that a hand-written caller who wrote
  // planPlacements({q, l, m}) before M7 keeps getting the pre-M7 shape.
  const layout = _synthLayout({
    perSheet: 4,
    front: [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 0, y: 0 }, { x: 50, y: 0 }],
  });
  const omitted   = planPlacements({ quantity: 10, layout, mode: 'simplex' });
  const explicit  = planPlacements({ quantity: 10, layout, mode: 'simplex', fillLastSheet: false });
  assert.equal(omitted.plan.length, 10);
  assert.deepEqual(omitted, explicit);
});

test('planPlacements: rotated flag flows from layout to every plan entry', () => {
  const layout = _synthLayout({
    perSheet: 2,
    front: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    rotated: true,
  });
  const out = planPlacements({ quantity: 2, layout, mode: 'simplex' });
  assert.ok(out.plan.every(e => e.rotated === true));
});

test('planPlacements: QTY100 4-up → 25 sheets, 100 placements (decision 5 example)', () => {
  // The canonical worked example: exact-division sheet count, all cells
  // full on every sheet including the last. sheetsFor's equivalent test
  // locks the same case at the layout module — planPlacements should
  // agree in the count of emitted plan entries.
  const layout = _synthLayout({
    perSheet: 4,
    front: [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 0, y: 0 }, { x: 50, y: 0 }],
  });
  const out = planPlacements({ quantity: 100, layout, mode: 'simplex' });
  assert.equal(out.sheets, 25);
  assert.equal(out.plan.length, 100);
  assert.equal(out.placedPerSheet, 4);
});

// planPlacements validation

test('planPlacements: throws on non-positive-integer quantity', () => {
  const layout = _synthLayout({ perSheet: 1, front: [{ x: 0, y: 0 }] });
  assert.throws(() => planPlacements({ quantity: 0,    layout, mode: 'simplex' }), /quantity/);
  assert.throws(() => planPlacements({ quantity: -1,   layout, mode: 'simplex' }), /quantity/);
  assert.throws(() => planPlacements({ quantity: 1.5,  layout, mode: 'simplex' }), /quantity/);
  assert.throws(() => planPlacements({ quantity: NaN,  layout, mode: 'simplex' }), /quantity/);
  assert.throws(() => planPlacements({ quantity: '10', layout, mode: 'simplex' }), /quantity/);
});

test('planPlacements: throws on invalid mode', () => {
  const layout = _synthLayout({ perSheet: 1, front: [{ x: 0, y: 0 }] });
  assert.throws(() => planPlacements({ quantity: 1, layout, mode: 'foo' }), /mode/);
});

test('planPlacements: throws when layout is missing required shape', () => {
  assert.throws(() => planPlacements({ quantity: 1, layout: null,    mode: 'simplex' }), /layout/);
  assert.throws(() => planPlacements({ quantity: 1, layout: {},      mode: 'simplex' }), /layout/);
  assert.throws(() => planPlacements({ quantity: 1, layout: { front: [], perSheet: 0 }, mode: 'simplex' }), /layout/);
});

test('planPlacements: throws when duplex mode passed a simplex layout (no back)', () => {
  // Guard against a caller who computed a simplex layout and later
  // switched mode to duplex without recomputing. Silent NPE-like
  // behaviour here would let the compose step produce single-sided
  // sheets on a duplex press, which is exactly the wrong-side-on-cards
  // failure mode this whole feature exists to avoid.
  const layout = _synthLayout({ perSheet: 1, front: [{ x: 0, y: 0 }], back: null });
  assert.throws(
    () => planPlacements({ quantity: 1, layout, mode: 'duplex' }),
    /duplex mode requires layout\.back/,
  );
});

// ═════════════════════════════════════════════════════════════════════════
// composeImposition — end-to-end structural tests.
//
// Test the OUTPUT is a valid PDF with the right number of pages and
// the right MediaBox on each. Never assert exact drawn positions
// (per M2 spec: brittle). The planPlacements tests above lock the
// positional contract; the composer draws the plan verbatim.
// ═════════════════════════════════════════════════════════════════════════

// A common 12×18 in sheet + 5×7 in cell layout used by many tests below.
// This produces perSheet=4 (2×2 unrotated) per the M1 worked example.
function _worked5x7Layout(mode = 'simplex') {
  return computeLayout({
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    margins: {
      top: inchesToPoints(0.25), right: inchesToPoints(0.25),
      bottom: inchesToPoints(0.25), left: inchesToPoints(0.25),
    },
    gutter:     inchesToPoints(0.25),
    cellWidth:  inchesToPoints(5),
    cellHeight: inchesToPoints(7),
    autoRotate: true,
    mode,
    duplexFlipEdge: mode === 'duplex' ? 'long' : undefined,
  });
}

test('composeImposition: simplex qty 4 → output has 1 page, MediaBox = sheet size', async () => {
  const layout = _worked5x7Layout('simplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504 });
  const out = await composeImposition({
    artworkBytes,
    quantity:    4,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'simplex',
  });
  assert.equal(out.sheets, 1);
  assert.equal(out.placedPerSheet, 4);

  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 1);           // simplex: pages = sheets
  const media = outDoc.getPage(0).getMediaBox();
  assert.equal(media.width,  864);
  assert.equal(media.height, 1296);
});

test('composeImposition: simplex qty 5 → 2 pages (last sheet partial)', async () => {
  const layout = _worked5x7Layout('simplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504 });
  const out = await composeImposition({
    artworkBytes,
    quantity:    5,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'simplex',
  });
  assert.equal(out.sheets, 2);
  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 2);
  for (let i = 0; i < 2; i++) {
    const media = outDoc.getPage(i).getMediaBox();
    assert.equal(media.width,  864);
    assert.equal(media.height, 1296);
  }
});

test('composeImposition: duplex qty 4 → 2 output pages (front + back for 1 sheet)', async () => {
  const layout = _worked5x7Layout('duplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504, pages: 2 });
  const out = await composeImposition({
    artworkBytes,
    quantity:    4,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'duplex',
  });
  assert.equal(out.sheets, 1);
  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 2);            // duplex: pages = 2 × sheets
});

test('composeImposition: duplex qty 5 → 4 output pages (2 sheets × 2)', async () => {
  const layout = _worked5x7Layout('duplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504, pages: 2 });
  const out = await composeImposition({
    artworkBytes,
    quantity:    5,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'duplex',
  });
  assert.equal(out.sheets, 2);
  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 4);
});

test('composeImposition: QTY 100 on 4-up simplex → 25 output pages (decision 5 canonical case)', async () => {
  // The canonical multi-sheet run: exact division, all sheets full.
  // Combined with planPlacements' "qty 100 → 100 placements" assertion
  // above, this locks that the composer generates the correct sheet
  // count AND emits one output page per sheet.
  const layout = _worked5x7Layout('simplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504 });
  const out = await composeImposition({
    artworkBytes,
    quantity:    100,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'simplex',
  });
  assert.equal(out.sheets, 25);
  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 25);
});

// Validation and error posture

test('composeImposition: throws when derived trim size does not match layout cell', async () => {
  // Layout expects 5×7 (360×504); artwork is 6×8 (432×576). deriveTrim
  // returns the media (no TrimBox, no bleed) → 432×576 which is 72 pt
  // wider than layout — many multiples of TRIM_TOLERANCE (0.5 pt).
  const layout = _worked5x7Layout('simplex');
  const artworkBytes = await _makeArtwork({ mediaW: 432, mediaH: 576 });
  await assert.rejects(
    () => composeImposition({
      artworkBytes,
      quantity:    1,
      layout,
      sheetWidth:  inchesToPoints(12),
      sheetHeight: inchesToPoints(18),
      mode:        'simplex',
    }),
    /trim.*does not match layout cell|layout cell/,
  );
});

test('composeImposition: 2-page simplex artwork → throws (v1 rejects, §7.2)', async () => {
  const layout = _worked5x7Layout('simplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504, pages: 2 });
  await assert.rejects(
    () => composeImposition({
      artworkBytes,
      quantity:    1,
      layout,
      sheetWidth:  inchesToPoints(12),
      sheetHeight: inchesToPoints(18),
      mode:        'simplex',
    }),
    /simplex template requires a 1-page/,
  );
});

test('composeImposition: 3-page duplex artwork → throws (v1 rejects, §7.2)', async () => {
  const layout = _worked5x7Layout('duplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504, pages: 3 });
  await assert.rejects(
    () => composeImposition({
      artworkBytes,
      quantity:    1,
      layout,
      sheetWidth:  inchesToPoints(12),
      sheetHeight: inchesToPoints(18),
      mode:        'duplex',
    }),
    /duplex template requires a 1- or 2-page/,
  );
});

test('composeImposition: 1-page duplex → blank backs + logger.logWarning called once', async () => {
  const layout = _worked5x7Layout('duplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504, pages: 1 });
  const warnings = [];
  const logger = { logWarning: (msg) => warnings.push(msg) };
  const out = await composeImposition({
    artworkBytes,
    quantity:    4,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'duplex',
    logger,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplex.*1-page.*blank/);
  // Output still has both front AND back pages — the operator's duplex
  // press needs paper turned regardless of whether the back is inked.
  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 2);
});

test('composeImposition: 1-page duplex without a logger → no throw (blank backs still produced)', async () => {
  // logger is optional; missing logger must not crash the compose call.
  // Locks the "never throws just because a logger is missing" guarantee
  // in the module's docstring.
  const layout = _worked5x7Layout('duplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504, pages: 1 });
  const out = await composeImposition({
    artworkBytes,
    quantity:    4,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'duplex',
  });
  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 2);
});

test('composeImposition: rotated layout — artwork sized to swapped cell dims is accepted', async () => {
  // With autoRotate on and a landscape-natural cell (7×5), the engine
  // picks the rotated orientation and layout.cellW/cellH become 5×7.
  // The artwork's TRIM must match the pre-rotation size (7×5 = 504×360)
  // — that's what _expectedTrimSize swaps for when rotated=true.
  const layout = computeLayout({
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    margins: {
      top: inchesToPoints(0.25), right: inchesToPoints(0.25),
      bottom: inchesToPoints(0.25), left: inchesToPoints(0.25),
    },
    gutter:     inchesToPoints(0.25),
    cellWidth:  inchesToPoints(7),
    cellHeight: inchesToPoints(5),
    autoRotate: true,
    mode:       'simplex',
  });
  assert.equal(layout.rotated, true, 'sanity: this layout should be rotated');
  // Artwork must be 7×5 (natural) = 504×360, NOT 5×7 (post-rotation).
  const artworkBytes = await _makeArtwork({ mediaW: 504, mediaH: 360 });
  const out = await composeImposition({
    artworkBytes,
    quantity:    4,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'simplex',
  });
  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 1);
});

test('composeImposition: cropMarks on doesn\'t crash and still produces correct page count', async () => {
  // Smoke test: crop marks are a substantial piece of drawing code but
  // its correctness is best validated visually by the operator. Lock
  // that turning them on produces a valid PDF with unchanged structure.
  const layout = _worked5x7Layout('simplex');
  const artworkBytes = await _makeArtwork({ mediaW: 360, mediaH: 504 });
  const out = await composeImposition({
    artworkBytes,
    quantity:    4,
    layout,
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    mode:        'simplex',
    cropMarks:   true,
    artworkBleed: 0,
  });
  const outDoc = await PDFDocument.load(out.pdfBytes);
  assert.equal(outDoc.getPageCount(), 1);
});

// ═════════════════════════════════════════════════════════════════════════
// _internal helpers — tests that would otherwise need to reach through
// the public surface. Kept small; the public contract is what matters.
// ═════════════════════════════════════════════════════════════════════════

test('_expectedTrimSize: not-rotated returns cell dims as-is', () => {
  const s = _internal._expectedTrimSize(360, 504, false);
  assert.deepEqual(s, { width: 360, height: 504 });
});

test('_expectedTrimSize: rotated swaps cell dims (artwork is placed 90° CCW)', () => {
  const s = _internal._expectedTrimSize(360, 504, true);
  assert.deepEqual(s, { width: 504, height: 360 });
});

test('_drawXY: not-rotated, trim at origin → drawXY = cell (identity)', () => {
  // No bleed, trim = media at (0, 0). Drawing at cell (100, 200)
  // should place media LL at (100, 200) which puts trim LL there too.
  const { x, y } = _internal._drawXY(100, 200, { x: 0, y: 0, width: 360, height: 504 }, false);
  assert.equal(x, 100);
  assert.equal(y, 200);
});

test('_drawXY: not-rotated, trim inset by 10 → media LL back-offset by 10', () => {
  // Trim LL at (10, 10) in artwork coords; we want trim LL at cell
  // (100, 200) → media LL at (90, 190).
  const { x, y } = _internal._drawXY(100, 200, { x: 10, y: 10, width: 340, height: 484 }, false);
  assert.equal(x, 90);
  assert.equal(y, 190);
});

test('_drawXY: rotated no-bleed → drawX = cellX + trim.height (the derivation)', () => {
  // Artwork 504×360 rotated CCW 90° into a cell at (cellX, cellY).
  // drawX = cellX + trim.y + trim.height = cellX + 0 + 360 = cellX + 360.
  // drawY = cellY - trim.x = cellY.
  const { x, y } = _internal._drawXY(100, 200, { x: 0, y: 0, width: 504, height: 360 }, true);
  assert.equal(x, 100 + 360);
  assert.equal(y, 200);
});
