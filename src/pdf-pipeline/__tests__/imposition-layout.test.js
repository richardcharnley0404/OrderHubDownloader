/**
 * Unit tests for imposition-layout — the pure geometry module for N-up
 * press-sheet imposition. Zero fs, zero electron, zero pdf-lib; portable
 * across Windows and the human's shell of the moment.
 *
 * The M7a rule applies with money attached here: assertions derive from
 * the geometric invariant, never from observed output. Every hand-computed
 * expected value in this file is a paper-and-pencil calculation shown in
 * the test comment above the assertion — if it fails, the code is wrong,
 * not the number. A test titled "layout for X" that just asserts whatever
 * X currently returns turns an untested area into a falsely-confident one.
 *
 * Test order follows §3 (design) and §7 (decisions) of
 * docs/pdf-imposition-investigation.md.
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const {
  inchesToPoints,
  mmToPoints,
  computeLayout,
  sheetsFor,
} = require(path.join(REPO, 'src', 'pdf-pipeline', 'imposition-layout.js'));

// ═════════════════════════════════════════════════════════════════════════
// Conversion helpers — §7.7. Locked exactly for inches (72 is representable),
// approximately for mm (72/25.4 is not).
// ═════════════════════════════════════════════════════════════════════════

test('inchesToPoints: 1 in === 72 pt (exact)', () => {
  assert.equal(inchesToPoints(1), 72);
});

test('inchesToPoints: 12 in === 864 pt (exact)', () => {
  assert.equal(inchesToPoints(12), 864);
});

test('inchesToPoints: 0 in === 0 pt', () => {
  assert.equal(inchesToPoints(0), 0);
});

test('mmToPoints: 25.4 mm ≈ 72 pt (within FP tolerance)', () => {
  // 25.4 mm is 1 inch by definition, so mmToPoints(25.4) should equal
  // inchesToPoints(1) === 72. IEEE 754 rounds (72/25.4)*25.4 to
  // 72.00000000000001, so we can't assert exact equality — 1e-9 is
  // orders of magnitude tighter than the difference and picks up any
  // real regression.
  assert.ok(Math.abs(mmToPoints(25.4) - 72) < 1e-9);
});

test('mmToPoints: 0 mm === 0 pt', () => {
  assert.equal(mmToPoints(0), 0);
});

// ═════════════════════════════════════════════════════════════════════════
// Worked example — 12×18 in sheet, 0.25 in margins, 0.25 in gutter,
// 5×7 in cell, autoRotate ON. Every expected number computed by hand
// below; do NOT edit an expected value to match observed output.
// ═════════════════════════════════════════════════════════════════════════

/*
Sheet 12×18 in → 864 × 1296 pt
Margins 0.25 in all round → 18 pt on each edge
Gutter 0.25 in → 18 pt
Usable = 864-36 × 1296-36 = 828 × 1260 pt

Cell 5×7 in → 360 × 504 pt

Unrotated (360 × 504):
  cols = floor((828 + 18) / (360 + 18)) = floor(846 / 378) = floor(2.238…) = 2
  rows = floor((1260 + 18) / (504 + 18)) = floor(1278 / 522) = floor(2.448…) = 2
  perSheet = 4

Rotated (504 × 360):
  cols = floor((828 + 18) / (504 + 18)) = floor(846 / 522) = floor(1.62) = 1
  rows = floor((1260 + 18) / (360 + 18)) = floor(1278 / 378) = floor(3.38…) = 3
  perSheet = 3

autoRotate ON → unrotated wins (4 > 3). rotated=false, cellW=360, cellH=504.

Grid (2 × 2):
  gridW = 2*360 + 1*18 = 738
  gridH = 2*504 + 1*18 = 1026
  leftOffset   = 18 + (828 - 738) / 2 = 18 + 45  = 63
  bottomOffset = 18 + (1260 - 1026) / 2 = 18 + 117 = 135

Positions (row-major, row 0 = TOP row):
  Front[0] c=0 r=0 (top-left)     x = 63,  y = 135 + (2-1-0)*(504+18) = 657
  Front[1] c=1 r=0 (top-right)    x = 63 + (360+18) = 441, y = 657
  Front[2] c=0 r=1 (bottom-left)  x = 63,  y = 135
  Front[3] c=1 r=1 (bottom-right) x = 441, y = 135
*/

test('worked example: 12×18 sheet, 5×7 cell, autoRotate on — 2×2 unrotated, positions locked by hand', () => {
  const out = computeLayout({
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:     inchesToPoints(0.25),
    cellWidth:  inchesToPoints(5),
    cellHeight: inchesToPoints(7),
    autoRotate: true,
    mode:       'simplex',
  });
  assert.equal(out.rotated,  false);
  assert.equal(out.cols,     2);
  assert.equal(out.rows,     2);
  assert.equal(out.perSheet, 4);
  assert.equal(out.cellW,    360);
  assert.equal(out.cellH,    504);
  assert.deepEqual(out.front, [
    { x:  63, y: 657 },
    { x: 441, y: 657 },
    { x:  63, y: 135 },
    { x: 441, y: 135 },
  ]);
  assert.equal(out.back, null);
});

/*
Same sheet, same margins, same gutter, but cell 7×5 in → 504 × 360 pt, autoRotate ON.

Unrotated (504 × 360):
  cols = floor(846 / 522) = 1
  rows = floor(1278 / 378) = 3
  perSheet = 3

Rotated (360 × 504) — this is the same as the 5×7 unrotated shape:
  cols = 2, rows = 2, perSheet = 4

autoRotate ON → rotated wins (4 > 3). rotated=true, cellW=360, cellH=504.
Positions IDENTICAL to the 5×7-autoRotate-on case above (the rotated 7×5
cell just IS the 5×7 cell).
*/

test('worked example, rotated orientation: 7×5 cell autoRotate on → same 2×2 layout as 5×7', () => {
  const out = computeLayout({
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:     inchesToPoints(0.25),
    cellWidth:  inchesToPoints(7),
    cellHeight: inchesToPoints(5),
    autoRotate: true,
    mode:       'simplex',
  });
  assert.equal(out.rotated,  true);
  assert.equal(out.cols,     2);
  assert.equal(out.rows,     2);
  assert.equal(out.perSheet, 4);
  assert.equal(out.cellW,    360);
  assert.equal(out.cellH,    504);
  assert.deepEqual(out.front, [
    { x:  63, y: 657 },
    { x: 441, y: 657 },
    { x:  63, y: 135 },
    { x: 441, y: 135 },
  ]);
});

/*
Same sheet/margins/gutter, but cell 7×5 in with autoRotate OFF.
Locks the LOSING orientation so we know its geometry too — same sheet,
same operator, different template. If a lab pins orientation (grain
direction), this is the layout they get.

Unrotated (504 × 360):
  cols = 1, rows = 3, perSheet = 3
  gridW = 1*504 = 504
  gridH = 3*360 + 2*18 = 1116
  leftOffset   = 18 + (828 - 504) / 2 = 18 + 162 = 180
  bottomOffset = 18 + (1260 - 1116) / 2 = 18 + 72  = 90

Positions (1 × 3, row 0 = top):
  Front[0] c=0 r=0 (top)    x = 180, y = 90 + (3-1-0)*(360+18) = 90 + 756 = 846
  Front[1] c=0 r=1 (middle) x = 180, y = 90 + (3-1-1)*378 = 90 + 378 = 468
  Front[2] c=0 r=2 (bottom) x = 180, y = 90
*/

test('worked example, autoRotate OFF: 7×5 cell — 1×3 unrotated, positions locked by hand', () => {
  const out = computeLayout({
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:     inchesToPoints(0.25),
    cellWidth:  inchesToPoints(7),
    cellHeight: inchesToPoints(5),
    autoRotate: false,
    mode:       'simplex',
  });
  assert.equal(out.rotated,  false);
  assert.equal(out.cols,     1);
  assert.equal(out.rows,     3);
  assert.equal(out.perSheet, 3);
  assert.equal(out.cellW,    504);
  assert.equal(out.cellH,    360);
  assert.deepEqual(out.front, [
    { x: 180, y: 846 },
    { x: 180, y: 468 },
    { x: 180, y:  90 },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════
// Mirror correctness — THE most important tests in this file. A sign
// error in _mirror prints every back on the wrong card.
// ═════════════════════════════════════════════════════════════════════════

/*
Same worked-example layout (2×2, cellW=360, cellH=504), duplex long-edge.

Long-edge flip mirrors across the vertical centerline:
  back[i].x = sheetW - front[i].x - cellW
  back[i].y = front[i].y

sheetW = 864, cellW = 360.
  Back[0]: 864 - 63  - 360 = 441, y = 657
  Back[1]: 864 - 441 - 360 = 63,  y = 657
  Back[2]: 864 - 63  - 360 = 441, y = 135
  Back[3]: 864 - 441 - 360 = 63,  y = 135
*/

test('duplex long-edge flip: back positions locked by hand', () => {
  const out = computeLayout({
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:         inchesToPoints(0.25),
    cellWidth:      inchesToPoints(5),
    cellHeight:     inchesToPoints(7),
    autoRotate:     true,
    mode:           'duplex',
    duplexFlipEdge: 'long',
  });
  assert.deepEqual(out.back, [
    { x: 441, y: 657 },
    { x:  63, y: 657 },
    { x: 441, y: 135 },
    { x:  63, y: 135 },
  ]);
});

/*
Same layout, duplex short-edge.

Short-edge flip mirrors across the horizontal centerline:
  back[i].x = front[i].x
  back[i].y = sheetH - front[i].y - cellH

sheetH = 1296, cellH = 504.
  Back[0]: x =  63, y = 1296 - 657 - 504 = 135
  Back[1]: x = 441, y = 135
  Back[2]: x =  63, y = 1296 - 135 - 504 = 657
  Back[3]: x = 441, y = 657
*/

test('duplex short-edge flip: back positions locked by hand', () => {
  const out = computeLayout({
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:         inchesToPoints(0.25),
    cellWidth:      inchesToPoints(5),
    cellHeight:     inchesToPoints(7),
    autoRotate:     true,
    mode:           'duplex',
    duplexFlipEdge: 'short',
  });
  assert.deepEqual(out.back, [
    { x:  63, y: 135 },
    { x: 441, y: 135 },
    { x:  63, y: 657 },
    { x: 441, y: 657 },
  ]);
});

test('mirror invariant, long-edge: back[i].x = sheetW - front[i].x - cellW; y unchanged (for every i)', () => {
  const sheetWidth  = inchesToPoints(12);
  const sheetHeight = inchesToPoints(18);
  const out = computeLayout({
    sheetWidth, sheetHeight,
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:         inchesToPoints(0.25),
    cellWidth:      inchesToPoints(5),
    cellHeight:     inchesToPoints(7),
    autoRotate:     true,
    mode:           'duplex',
    duplexFlipEdge: 'long',
  });
  assert.equal(out.front.length, out.back.length);
  for (let i = 0; i < out.front.length; i++) {
    const f = out.front[i];
    const b = out.back[i];
    assert.equal(b.x, sheetWidth - f.x - out.cellW, `back[${i}].x mirror`);
    assert.equal(b.y, f.y,                          `back[${i}].y unchanged`);
  }
});

test('mirror invariant, short-edge: back[i].y = sheetH - front[i].y - cellH; x unchanged (for every i)', () => {
  const sheetWidth  = inchesToPoints(12);
  const sheetHeight = inchesToPoints(18);
  const out = computeLayout({
    sheetWidth, sheetHeight,
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:         inchesToPoints(0.25),
    cellWidth:      inchesToPoints(5),
    cellHeight:     inchesToPoints(7),
    autoRotate:     true,
    mode:           'duplex',
    duplexFlipEdge: 'short',
  });
  for (let i = 0; i < out.front.length; i++) {
    const f = out.front[i];
    const b = out.back[i];
    assert.equal(b.x, f.x,                            `back[${i}].x unchanged`);
    assert.equal(b.y, sheetHeight - f.y - out.cellH, `back[${i}].y mirror`);
  }
});

test('physical alignment, long-edge: dist(front[i], left) === dist(back[i], right); same y', () => {
  // The property test that catches a subtle sign error in _mirror even
  // when the numeric formula test above passes — expresses the invariant
  // physically. If front[0] is 63 pt in from the left, back[0] must be
  // 63 pt in from the right, on the same horizontal line.
  const sheetWidth  = inchesToPoints(12);
  const sheetHeight = inchesToPoints(18);
  const out = computeLayout({
    sheetWidth, sheetHeight,
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:         inchesToPoints(0.25),
    cellWidth:      inchesToPoints(5),
    cellHeight:     inchesToPoints(7),
    autoRotate:     true,
    mode:           'duplex',
    duplexFlipEdge: 'long',
  });
  for (let i = 0; i < out.front.length; i++) {
    const f = out.front[i];
    const b = out.back[i];
    const distFrontFromLeft  = f.x;
    const distBackFromRight  = sheetWidth - (b.x + out.cellW);
    assert.equal(distFrontFromLeft, distBackFromRight, `pair ${i} horizontal alignment`);
    assert.equal(f.y, b.y,                             `pair ${i} same vertical line`);
  }
});

test('physical alignment, short-edge: dist(front[i], top) === dist(back[i], bottom); same x', () => {
  // Same property, rotated 90° for short-edge. Front[0] some distance
  // from the top edge → back[0] the same distance from the bottom edge,
  // same x. Locks the other flip against the same silent sign error.
  const sheetWidth  = inchesToPoints(12);
  const sheetHeight = inchesToPoints(18);
  const out = computeLayout({
    sheetWidth, sheetHeight,
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:         inchesToPoints(0.25),
    cellWidth:      inchesToPoints(5),
    cellHeight:     inchesToPoints(7),
    autoRotate:     true,
    mode:           'duplex',
    duplexFlipEdge: 'short',
  });
  for (let i = 0; i < out.front.length; i++) {
    const f = out.front[i];
    const b = out.back[i];
    const distFrontFromTop    = sheetHeight - (f.y + out.cellH);
    const distBackFromBottom  = b.y;
    assert.equal(distFrontFromTop, distBackFromBottom, `pair ${i} vertical alignment`);
    assert.equal(f.x, b.x,                              `pair ${i} same vertical line`);
  }
});

// ─── M1a: asymmetric-margin mirror tests ─────────────────────────────────
//
// The mirror-invariant tests above use symmetric margins (0.25 in all
// round). With symmetric margins, "mirror about the sheet centreline"
// (correct — what the physical duplex flip does) and "mirror about the
// usable-area centre" (a plausible wrong implementation) produce
// IDENTICAL positions, so the suite cannot distinguish them. These two
// tests use asymmetric margins to break that coincidence: they PASS with
// the sheet-centreline mirror and FAIL with the usable-area mirror.
// The current implementation is correct; these tests exist to catch a
// silent regression to the wrong formula.

/*
Test A: long-edge, asymmetric horizontal margins {left:1.0, others:0.25}.

Sheet 864 × 1296. Margins l=72, r=18, t=18, b=18. Gutter 18. Cell 5×7 (360×504).
usableW = 864 − 72 − 18 = 774
usableH = 1296 − 36        = 1260

Unrotated (360×504):
  cols = floor((774+18)/(360+18)) = floor(792/378) = 2
  rows = floor((1260+18)/(504+18)) = 2
  perSheet = 4    (unrotated wins over rotated's 3)

gridW = 738, gridH = 1026
leftOffset   = 72 + (774 − 738)/2  = 90     (NOT 63 — that was the symmetric case)
bottomOffset = 18 + (1260 − 1026)/2 = 135

Front positions:
  (90, 657), (468, 657), (90, 135), (468, 135)

Sheet-mirror back (correct — mirrors about sheet centreline x=432):
  back.x = 864 − front.x − 360
    → (414, 657), (36, 657), (414, 135), (36, 135)

Usable-mirror back (WRONG — mirrors about usable centreline x=(72+846)/2=459):
  back.x = 2·459 − front.x − 360 = 918 − front.x − 360
    → (468, 657), (90, 657), (468, 135), (90, 135)

The sheet-mirror and usable-mirror values differ by exactly (m.left − m.right)
= 72 − 18 = 54 pt per position. That divergence is what this test relies on.
*/

test('M1a: mirror invariant, long-edge, asymmetric horizontal margins — sheet-centreline mirror (not usable-area)', () => {
  const sheetWidth  = inchesToPoints(12);
  const sheetHeight = inchesToPoints(18);
  const out = computeLayout({
    sheetWidth, sheetHeight,
    margins: {
      top:    inchesToPoints(0.25),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(1.0),
    },
    gutter:         inchesToPoints(0.25),
    cellWidth:      inchesToPoints(5),
    cellHeight:     inchesToPoints(7),
    autoRotate:     true,
    mode:           'duplex',
    duplexFlipEdge: 'long',
  });
  // Sanity-check the front geometry — the asymmetric leftOffset is what
  // makes the sheet-vs-usable mirror difference detectable at all.
  assert.equal(out.front[0].x, 90);
  for (let i = 0; i < out.front.length; i++) {
    const f = out.front[i];
    const b = out.back[i];
    assert.equal(b.x, sheetWidth - f.x - out.cellW, `back[${i}].x sheet-mirror`);
    assert.equal(b.y, f.y,                          `back[${i}].y unchanged`);
  }
});

/*
Test B: short-edge, asymmetric vertical margins {top:1.0, others:0.25}.

Sheet 864 × 1296. Margins t=72, r=18, b=18, l=18. Gutter 18. Cell 5×7.
usableW = 828
usableH = 1296 − 72 − 18 = 1206

Unrotated (360×504):
  cols = floor(846/378) = 2
  rows = floor((1206+18)/(504+18)) = floor(1224/522) = 2
  perSheet = 4    (unrotated wins over rotated's 3)

gridW = 738, gridH = 1026
leftOffset   = 63
bottomOffset = 18 + (1206 − 1026)/2 = 108   (NOT 135 — asymmetric case)

Front positions:
  (63, 630), (441, 630), (63, 108), (441, 108)

Sheet-mirror back (correct — mirrors about sheet centreline y=648):
  back.y = 1296 − front.y − 504
    → (63, 162), (441, 162), (63, 684), (441, 684)

Usable-mirror back (WRONG — mirrors about usable centreline y=(18+1224)/2=621):
  back.y = 2·621 − front.y − 504 = 1242 − front.y − 504
    → (63, 108), (441, 108), (63, 630), (441, 630)

Sheet-mirror and usable-mirror values differ by (m.top − m.bottom) = 54 pt.
*/

test('M1a: mirror invariant, short-edge, asymmetric vertical margins — sheet-centreline mirror (not usable-area)', () => {
  const sheetWidth  = inchesToPoints(12);
  const sheetHeight = inchesToPoints(18);
  const out = computeLayout({
    sheetWidth, sheetHeight,
    margins: {
      top:    inchesToPoints(1.0),
      right:  inchesToPoints(0.25),
      bottom: inchesToPoints(0.25),
      left:   inchesToPoints(0.25),
    },
    gutter:         inchesToPoints(0.25),
    cellWidth:      inchesToPoints(5),
    cellHeight:     inchesToPoints(7),
    autoRotate:     true,
    mode:           'duplex',
    duplexFlipEdge: 'short',
  });
  // Sanity-check the front geometry — the asymmetric bottomOffset is what
  // makes the sheet-vs-usable mirror difference detectable at all.
  assert.equal(out.front[0].y, 630);
  for (let i = 0; i < out.front.length; i++) {
    const f = out.front[i];
    const b = out.back[i];
    assert.equal(b.x, f.x,                           `back[${i}].x unchanged`);
    assert.equal(b.y, sheetHeight - f.y - out.cellH, `back[${i}].y sheet-mirror`);
  }
});

test('simplex layout returns back === null (never an empty array)', () => {
  const out = computeLayout({
    sheetWidth:  inchesToPoints(12),
    sheetHeight: inchesToPoints(18),
    gutter:      inchesToPoints(0.25),
    cellWidth:   inchesToPoints(5),
    cellHeight:  inchesToPoints(7),
    mode:        'simplex',
  });
  assert.equal(out.back, null);
});

// ═════════════════════════════════════════════════════════════════════════
// Rotate / autoRotate cases
// ═════════════════════════════════════════════════════════════════════════

/*
Tie case: cell 3×4 pt on 7×7 pt sheet, no margins, no gutter.

Unrotated (3 × 4):
  cols = floor(7/3) = 2, rows = floor(7/4) = 1, perSheet = 2
Rotated (4 × 3):
  cols = floor(7/4) = 1, rows = floor(7/3) = 2, perSheet = 2

TIE → unrotated wins (rotated=false), cellW=3, cellH=4.
*/

test('autoRotate tie → unrotated (deterministic default per §3.2)', () => {
  const out = computeLayout({
    sheetWidth:  7,
    sheetHeight: 7,
    cellWidth:   3,
    cellHeight:  4,
    autoRotate:  true,
    mode:        'simplex',
  });
  assert.equal(out.rotated,  false);
  assert.equal(out.perSheet, 2);
  assert.equal(out.cellW,    3);
  assert.equal(out.cellH,    4);
});

/*
Rotation-wins case: cell 4×3 pt on 7×10 pt sheet, no margins, no gutter.

Unrotated (4 × 3):
  cols = floor(7/4) = 1, rows = floor(10/3) = 3, perSheet = 3
Rotated (3 × 4):
  cols = floor(7/3) = 2, rows = floor(10/4) = 2, perSheet = 4

autoRotate ON  → rotated=true, perSheet=4, cellW=3, cellH=4
autoRotate OFF → rotated=false, perSheet=3, cellW=4, cellH=3
  (grain-direction case: even though rotation would fit better, the
  template pins orientation and we honour it)
*/

test('autoRotate ON: rotation-wins case picks rotated=true, perSheet=4', () => {
  const out = computeLayout({
    sheetWidth:  7,
    sheetHeight: 10,
    cellWidth:   4,
    cellHeight:  3,
    autoRotate:  true,
    mode:        'simplex',
  });
  assert.equal(out.rotated,  true);
  assert.equal(out.perSheet, 4);
  assert.equal(out.cellW,    3);
  assert.equal(out.cellH,    4);
});

test('autoRotate OFF: grain-direction pin — ignores the better rotated fit', () => {
  const out = computeLayout({
    sheetWidth:  7,
    sheetHeight: 10,
    cellWidth:   4,
    cellHeight:  3,
    autoRotate:  false,
    mode:        'simplex',
  });
  assert.equal(out.rotated,  false);
  assert.equal(out.perSheet, 3);
  assert.equal(out.cellW,    4);
  assert.equal(out.cellH,    3);
});

// ═════════════════════════════════════════════════════════════════════════
// Zero-fit and edge cases
// ═════════════════════════════════════════════════════════════════════════

test('zero-fit throws, message names cell and usable dimensions', () => {
  // Cell 100×100 pt on 10×10 pt sheet — bigger than usable both ways.
  // Fails loudly so the operator sees which template + sheet mismatch.
  assert.throws(
    () => computeLayout({
      sheetWidth:  10,
      sheetHeight: 10,
      cellWidth:   100,
      cellHeight:  100,
      autoRotate:  true,
      mode:        'simplex',
    }),
    /100.*10|10.*100/,
  );
});

test('zero-fit with autoRotate off ignores the rotated-would-fit case (still throws)', () => {
  // Cell 8×3 on 6×20 sheet: unrotated fails (cell width 8 > usable 6),
  // rotated (3×8) would fit 2×2. With autoRotate off we must still throw.
  assert.throws(
    () => computeLayout({
      sheetWidth:  6,
      sheetHeight: 20,
      cellWidth:   8,
      cellHeight:  3,
      autoRotate:  false,
      mode:        'simplex',
    }),
    /0 cells per sheet/,
  );
});

test('single cell exactly filling the sheet — gutter 0, margins 0', () => {
  // Sheet 5×7 pt, cell 5×7 pt. cols=1, rows=1, position (0,0).
  // The pathological "everything cancels out" case that catches a
  // divide-by-zero or off-by-one in the centring math.
  const out = computeLayout({
    sheetWidth:  5,
    sheetHeight: 7,
    cellWidth:   5,
    cellHeight:  7,
    mode:        'simplex',
  });
  assert.equal(out.rotated,  false);
  assert.equal(out.cols,     1);
  assert.equal(out.rows,     1);
  assert.equal(out.perSheet, 1);
  assert.deepEqual(out.front, [{ x: 0, y: 0 }]);
});

// ═════════════════════════════════════════════════════════════════════════
// Centring invariant — for every layout, computed FROM the returned
// positions (not from the internal formulas). Locks that the grid is
// symmetric in the usable area regardless of how the arithmetic gets
// rearranged.
// ═════════════════════════════════════════════════════════════════════════

function _centringGaps(out, sheetWidth, sheetHeight, margins) {
  // Leftmost position (col 0) is on any row; we take front[0] which is
  // (col=0, row=0) in row-major order. Rightmost in the same row is
  // front[cols - 1]. Similarly bottom row starts at index cols*(rows-1).
  const topLeft     = out.front[0];
  const topRight    = out.front[out.cols - 1];
  const bottomLeft  = out.front[out.cols * (out.rows - 1)];
  const leftGap     = topLeft.x - margins.left;
  const rightGap    = sheetWidth - (topRight.x + out.cellW) - margins.right;
  const bottomGap   = bottomLeft.y - margins.bottom;
  const topGap      = sheetHeight - (topLeft.y + out.cellH) - margins.top;
  return { leftGap, rightGap, bottomGap, topGap };
}

test('centring invariant: leftGap === rightGap and bottomGap === topGap (worked example)', () => {
  const sheetWidth  = inchesToPoints(12);
  const sheetHeight = inchesToPoints(18);
  const margins = {
    top:    inchesToPoints(0.25),
    right:  inchesToPoints(0.25),
    bottom: inchesToPoints(0.25),
    left:   inchesToPoints(0.25),
  };
  const out = computeLayout({
    sheetWidth, sheetHeight, margins,
    gutter:     inchesToPoints(0.25),
    cellWidth:  inchesToPoints(5),
    cellHeight: inchesToPoints(7),
    autoRotate: true,
    mode:       'simplex',
  });
  const { leftGap, rightGap, bottomGap, topGap } = _centringGaps(out, sheetWidth, sheetHeight, margins);
  assert.ok(Math.abs(leftGap   - rightGap) < 1e-9, `leftGap ${leftGap} !== rightGap ${rightGap}`);
  assert.ok(Math.abs(bottomGap - topGap)   < 1e-9, `bottomGap ${bottomGap} !== topGap ${topGap}`);
});

test('centring invariant: asymmetric margins — grid centred in the USABLE area (not the sheet)', () => {
  // Grip-edge case: bottom margin larger than top. Grid centres in the
  // area MINUS the margins, not the whole sheet — the operator wants
  // grip-clear space to be honoured, not averaged.
  const sheetWidth  = inchesToPoints(12);
  const sheetHeight = inchesToPoints(18);
  const margins = {
    top:    inchesToPoints(0.25),
    right:  inchesToPoints(0.25),
    bottom: inchesToPoints(0.5),   // grip edge
    left:   inchesToPoints(0.25),
  };
  const out = computeLayout({
    sheetWidth, sheetHeight, margins,
    gutter:     inchesToPoints(0.25),
    cellWidth:  inchesToPoints(5),
    cellHeight: inchesToPoints(7),
    autoRotate: true,
    mode:       'simplex',
  });
  const { leftGap, rightGap, bottomGap, topGap } = _centringGaps(out, sheetWidth, sheetHeight, margins);
  assert.ok(Math.abs(leftGap   - rightGap) < 1e-9);
  assert.ok(Math.abs(bottomGap - topGap)   < 1e-9);
});

test('centring invariant: 1×1 layout (single cell) — gaps still equal on both axes', () => {
  const out = computeLayout({
    sheetWidth:  10,
    sheetHeight: 20,
    cellWidth:   4,
    cellHeight:  6,
    mode:        'simplex',
  });
  const { leftGap, rightGap, bottomGap, topGap } =
    _centringGaps(out, 10, 20, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.ok(Math.abs(leftGap   - rightGap) < 1e-9);
  assert.ok(Math.abs(bottomGap - topGap)   < 1e-9);
});

test('centring invariant: zero gutter, zero margins, multi-cell — still centred', () => {
  // Sheet 10×10, cell 3×3, gutter 0, margins 0.
  //   cols = floor(10/3) = 3, rows = 3, gridW = gridH = 9.
  //   Gaps = (10-9)/2 = 0.5 on each side.
  const out = computeLayout({
    sheetWidth:  10,
    sheetHeight: 10,
    cellWidth:   3,
    cellHeight:  3,
    gutter:      0,
    mode:        'simplex',
  });
  const { leftGap, rightGap, bottomGap, topGap } =
    _centringGaps(out, 10, 10, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.equal(leftGap,   0.5);
  assert.equal(rightGap,  0.5);
  assert.equal(bottomGap, 0.5);
  assert.equal(topGap,    0.5);
});

// ═════════════════════════════════════════════════════════════════════════
// Input validation — every guard clause has its own test. A silently
// accepted bad value here becomes a silently wrong layout, which is the
// exact class of failure the fail-loudly (in-engine) posture exists for.
// ═════════════════════════════════════════════════════════════════════════

test('throws when sheetWidth/sheetHeight are not positive', () => {
  assert.throws(() => computeLayout({ sheetWidth: 0,    sheetHeight: 10, cellWidth: 1, cellHeight: 1 }), /sheetWidth.*sheetHeight/);
  assert.throws(() => computeLayout({ sheetWidth: -5,   sheetHeight: 10, cellWidth: 1, cellHeight: 1 }), /sheetWidth.*sheetHeight/);
  assert.throws(() => computeLayout({ sheetWidth: NaN,  sheetHeight: 10, cellWidth: 1, cellHeight: 1 }), /sheetWidth.*sheetHeight/);
  assert.throws(() => computeLayout({ sheetWidth: 10,   sheetHeight: 0,  cellWidth: 1, cellHeight: 1 }), /sheetWidth.*sheetHeight/);
});

test('throws when cellWidth/cellHeight are not positive', () => {
  assert.throws(() => computeLayout({ sheetWidth: 10, sheetHeight: 10, cellWidth: 0, cellHeight: 1 }), /cellWidth.*cellHeight/);
  assert.throws(() => computeLayout({ sheetWidth: 10, sheetHeight: 10, cellWidth: 1, cellHeight: -1 }), /cellWidth.*cellHeight/);
});

test('throws when gutter is negative', () => {
  assert.throws(
    () => computeLayout({ sheetWidth: 10, sheetHeight: 10, cellWidth: 1, cellHeight: 1, gutter: -1 }),
    /gutter/,
  );
});

test('throws when mode is not simplex or duplex', () => {
  assert.throws(
    () => computeLayout({ sheetWidth: 10, sheetHeight: 10, cellWidth: 1, cellHeight: 1, mode: 'foo' }),
    /mode/,
  );
});

test('throws when duplex mode without a valid flip edge', () => {
  assert.throws(
    () => computeLayout({
      sheetWidth: 10, sheetHeight: 10, cellWidth: 1, cellHeight: 1,
      mode: 'duplex',
    }),
    /duplexFlipEdge/,
  );
  assert.throws(
    () => computeLayout({
      sheetWidth: 10, sheetHeight: 10, cellWidth: 1, cellHeight: 1,
      mode: 'duplex', duplexFlipEdge: 'diagonal',
    }),
    /duplexFlipEdge/,
  );
});

test('throws when margins consume the entire sheet', () => {
  assert.throws(
    () => computeLayout({
      sheetWidth: 10, sheetHeight: 10,
      margins: { top: 5, right: 0, bottom: 5, left: 0 },
      cellWidth: 1, cellHeight: 1,
    }),
    /margins consume/,
  );
});

test('missing margin edges default to 0 (partial margins object is legal)', () => {
  // Only bottom margin supplied — top/left/right default to 0.
  const out = computeLayout({
    sheetWidth:  10,
    sheetHeight: 10,
    margins:     { bottom: 2 },
    cellWidth:   3,
    cellHeight:  3,
    mode:        'simplex',
  });
  // usableW = 10, usableH = 8. cols = floor(10/3)=3, rows = floor(8/3)=2.
  assert.equal(out.cols, 3);
  assert.equal(out.rows, 2);
});

// ═════════════════════════════════════════════════════════════════════════
// sheetsFor — including the QTY100 / 4-up → 25 sheets example from
// Richard's decision 5.
// ═════════════════════════════════════════════════════════════════════════

test('sheetsFor: qty 100 on 4-up → 25 sheets, last sheet full (decision 5 example)', () => {
  // Exact division: 100/4 = 25 sheets, last sheet uses all 4 cells.
  // lastSheetCount is NEVER 0 even on exact division — the last sheet
  // is populated, not empty, so operators asking "how many on the
  // final sheet" get a truthful answer.
  assert.deepEqual(sheetsFor(100, 4), { sheets: 25, lastSheetCount: 4 });
});

test('sheetsFor: qty 101 on 4-up → 26 sheets, last sheet 1', () => {
  assert.deepEqual(sheetsFor(101, 4), { sheets: 26, lastSheetCount: 1 });
});

test('sheetsFor: qty 3 on 4-up → 1 sheet, last sheet 3 (qty < perSheet)', () => {
  assert.deepEqual(sheetsFor(3, 4), { sheets: 1, lastSheetCount: 3 });
});

test('sheetsFor: qty 1 on 100-up → 1 sheet, last sheet 1', () => {
  assert.deepEqual(sheetsFor(1, 100), { sheets: 1, lastSheetCount: 1 });
});

test('sheetsFor: another exact division — qty 200 on 25-up → 8 sheets, last sheet 25', () => {
  assert.deepEqual(sheetsFor(200, 25), { sheets: 8, lastSheetCount: 25 });
});

test('sheetsFor: throws on non-positive-integer qty', () => {
  assert.throws(() => sheetsFor(0,    4), /qty/);
  assert.throws(() => sheetsFor(-1,   4), /qty/);
  assert.throws(() => sheetsFor(1.5,  4), /qty/);
  assert.throws(() => sheetsFor(NaN,  4), /qty/);
  assert.throws(() => sheetsFor('10', 4), /qty/);
});

test('sheetsFor: throws on non-positive-integer perSheet', () => {
  assert.throws(() => sheetsFor(100, 0),   /perSheet/);
  assert.throws(() => sheetsFor(100, -1),  /perSheet/);
  assert.throws(() => sheetsFor(100, 1.5), /perSheet/);
});
