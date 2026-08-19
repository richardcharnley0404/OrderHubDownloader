'use strict';

/**
 * imposition-layout — pure geometry for N-up press-sheet layout.
 *
 * All internal units are PDF points (1/72 inch). Callers convert to points
 * with `inchesToPoints` or `mmToPoints` before invoking `computeLayout`;
 * per §7.7 the paper size stores its display unit but the engine only
 * speaks points.
 *
 * Zero side effects: no fs, no electron, no pdf-lib. This module is where
 * the correctness of the imposition feature lives, and — deliberately —
 * where it must be exhaustively testable without an app running. Same
 * discipline as folder-copy-filename.js. M2 (pdf-lib composition), M4
 * (live template preview), and M5 (dispatch wiring) all call THIS module
 * for their geometry. Never a parallel implementation: a preview that
 * shows a different grid than dispatch produces is worse than no preview
 * at all (M5a lesson).
 *
 * See docs/pdf-imposition-investigation.md §3 for the design and §7 for
 * the 2026-08-19 decisions this module encodes.
 */

const POINTS_PER_INCH = 72;
const POINTS_PER_MM   = 72 / 25.4;

/**
 * Tolerance for floating-point comparisons in the fit calculation.
 *
 * A cell that exactly fills the usable dimension after margin/gutter
 * arithmetic can produce a division result like 4.999999999 due to IEEE
 * 754 rounding; without an epsilon Math.floor then returns 4 and a whole
 * column of the layout disappears silently. 1e-9 is generous relative to
 * any realistic sheet dimension in points (< 10^4) and tight enough that
 * a genuinely-too-large cell still fails the fit check.
 */
const FP_EPS = 1e-9;

function inchesToPoints(inches) {
  return inches * POINTS_PER_INCH;
}

function mmToPoints(mm) {
  return mm * POINTS_PER_MM;
}

/**
 * How many `w × h` cells fit in `usableW × usableH` with `gutter` between
 * neighbours. Returns { cols, rows }. A cell larger than the usable area
 * in either dimension yields { 0, 0 } — the caller decides whether that's
 * a configuration error or just "this orientation doesn't fit."
 */
function _fit(usableW, usableH, w, h, gutter) {
  if (w > usableW + FP_EPS || h > usableH + FP_EPS) return { cols: 0, rows: 0 };
  const cols = Math.floor((usableW + gutter + FP_EPS) / (w + gutter));
  const rows = Math.floor((usableH + gutter + FP_EPS) / (h + gutter));
  return { cols: Math.max(0, cols), rows: Math.max(0, rows) };
}

/**
 * Row-major list of cell lower-left corners for a centred grid.
 *
 * Row 0 = the TOP row (highest Y, since PDF's origin is bottom-left).
 * Reading order matches how a human describes a sheet: "top-left, then
 * across, then next row down." Callers that number cells for the operator
 * therefore get the same 1..N sequence the operator sees on paper.
 */
function _positions({ sheetWidth, sheetHeight, margins, gutter, cellW, cellH, cols, rows }) {
  const usableW = sheetWidth  - margins.left - margins.right;
  const usableH = sheetHeight - margins.top  - margins.bottom;
  const gridW   = cols * cellW + (cols - 1) * gutter;
  const gridH   = rows * cellH + (rows - 1) * gutter;
  const leftOffset   = margins.left   + (usableW - gridW) / 2;
  const bottomOffset = margins.bottom + (usableH - gridH) / 2;

  const out = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = leftOffset   + c * (cellW + gutter);
      const y = bottomOffset + (rows - 1 - r) * (cellH + gutter);
      out[r * cols + c] = { x, y };
    }
  }
  return out;
}

/**
 * Mirror the front positions across the press's flip axis to produce the
 * back positions of a duplex sheet.
 *
 * long-edge flip → the press flips the sheet over its LONG edge; the back
 *   is mirrored LEFT-RIGHT relative to the front. `back[i].x = sheetW -
 *   front[i].x - cellW`, y unchanged.
 * short-edge flip → mirrored TOP-BOTTOM. `back[i].y = sheetH - front[i].y
 *   - cellH`, x unchanged.
 *
 * `back[i]` is the physical partner of `front[i]` — the same array index,
 * so callers walk both arrays together. A sign error here prints every
 * back on the wrong card; tests assert the numerical mirror invariant for
 * every position on both flip edges (see the mirror-correctness section
 * of the test file).
 *
 * Which mapping the operator wants is a per-template setting because it
 * must match the press's physical duplex configuration; the engine does
 * not try to guess.
 */
function _mirror(front, flipEdge, sheetWidth, sheetHeight, cellW, cellH) {
  return front.map(({ x, y }) => (
    flipEdge === 'long'
      ? { x: sheetWidth - x - cellW, y }
      : { x, y: sheetHeight - y - cellH }
  ));
}

/**
 * computeLayout({ ... }) → the layout for one sheet of a step-and-repeat
 * imposition, plus (for duplex) the mirrored back positions.
 *
 * See the top-of-file docstring for the units contract and design notes.
 *
 * Inputs (all dimensions in PDF points):
 *   sheetWidth, sheetHeight       — press-sheet dims
 *   margins { top, right,         — defaults to 0 on any missing edge
 *             bottom, left }
 *   gutter                        — spacing between neighbouring cells, ≥ 0
 *   cellWidth, cellHeight         — TRIM size of one placed item
 *   autoRotate                    — pick the better-fitting orientation
 *   mode                          — 'simplex' | 'duplex'
 *   duplexFlipEdge                — 'long' | 'short', required when duplex
 *
 * Returns:
 *   rotated    — bool. TRUE only when auto-rotate chose the 90° fit.
 *   cols, rows — of the chosen grid
 *   perSheet   — cols × rows (never 0; a 0-fit throws)
 *   cellW, cellH — post-rotation cell dimensions actually placed
 *   front      — [{ x, y }] cell lower-left corners, row-major, row 0 = top
 *   back       — [{ x, y }] duplex partner of front[i], or null for simplex
 *
 * Contract:
 * - Grid is centred in the usable area (usable = sheet − margins).
 * - `perSheet === 0` after considering allowed orientations throws with a
 *   message naming the cell and usable dimensions. A template that fits
 *   nothing is a configuration error the caller must surface; a silent
 *   empty sheet is exactly the failure mode a press hot folder cannot
 *   recover from.
 * - autoRotate tie → UNROTATED (arbitrary but stable; matches the design
 *   doc §3.2 and gives operators a deterministic default).
 */
function computeLayout({
  sheetWidth,
  sheetHeight,
  margins = {},
  gutter = 0,
  cellWidth,
  cellHeight,
  autoRotate = false,
  mode = 'simplex',
  duplexFlipEdge,
} = {}) {
  const isPos = v => Number.isFinite(v) && v > 0;
  const isNN  = v => Number.isFinite(v) && v >= 0;

  if (!isPos(sheetWidth) || !isPos(sheetHeight)) {
    throw new Error(
      `computeLayout: sheetWidth and sheetHeight must be positive numbers ` +
      `(got ${sheetWidth} × ${sheetHeight})`
    );
  }
  if (!isPos(cellWidth) || !isPos(cellHeight)) {
    throw new Error(
      `computeLayout: cellWidth and cellHeight must be positive numbers ` +
      `(got ${cellWidth} × ${cellHeight})`
    );
  }
  if (!isNN(gutter)) {
    throw new Error(`computeLayout: gutter must be a non-negative number (got ${gutter})`);
  }
  if (mode !== 'simplex' && mode !== 'duplex') {
    throw new Error(`computeLayout: mode must be 'simplex' or 'duplex' (got ${JSON.stringify(mode)})`);
  }
  if (mode === 'duplex' && duplexFlipEdge !== 'long' && duplexFlipEdge !== 'short') {
    throw new Error(
      `computeLayout: duplex requires duplexFlipEdge 'long' or 'short' ` +
      `(got ${JSON.stringify(duplexFlipEdge)})`
    );
  }

  const m = {
    top:    isNN(margins.top)    ? margins.top    : 0,
    right:  isNN(margins.right)  ? margins.right  : 0,
    bottom: isNN(margins.bottom) ? margins.bottom : 0,
    left:   isNN(margins.left)   ? margins.left   : 0,
  };
  const usableW = sheetWidth  - m.left - m.right;
  const usableH = sheetHeight - m.top  - m.bottom;
  if (usableW <= 0 || usableH <= 0) {
    throw new Error(
      `computeLayout: margins consume the entire sheet ` +
      `(usable ${usableW} × ${usableH} pt)`
    );
  }

  // Try both orientations. When autoRotate is off the rotated candidate
  // is not evaluated at all — a grain-direction-pinned template must never
  // silently rotate just because rotation would fit better.
  const un = _fit(usableW, usableH, cellWidth,  cellHeight, gutter);
  const rt = autoRotate
    ? _fit(usableW, usableH, cellHeight, cellWidth, gutter)
    : { cols: 0, rows: 0 };
  const unCount = un.cols * un.rows;
  const rtCount = rt.cols * rt.rows;

  // Strict > → tie goes to unrotated. Deterministic and matches §3.2.
  const useRotated = rtCount > unCount;

  const chosenGrid = useRotated ? rt : un;
  const cellW      = useRotated ? cellHeight : cellWidth;
  const cellH      = useRotated ? cellWidth  : cellHeight;
  const perSheet   = chosenGrid.cols * chosenGrid.rows;

  if (perSheet === 0) {
    throw new Error(
      `computeLayout: cell ${cellWidth} × ${cellHeight} pt does not fit ` +
      `usable area ${usableW} × ${usableH} pt ` +
      `(gutter ${gutter} pt, autoRotate ${autoRotate}) — 0 cells per sheet`
    );
  }

  const front = _positions({
    sheetWidth, sheetHeight,
    margins: m,
    gutter,
    cellW, cellH,
    cols: chosenGrid.cols,
    rows: chosenGrid.rows,
  });

  const back = mode === 'duplex'
    ? _mirror(front, duplexFlipEdge, sheetWidth, sheetHeight, cellW, cellH)
    : null;

  return {
    rotated: useRotated,
    cols:    chosenGrid.cols,
    rows:    chosenGrid.rows,
    perSheet,
    cellW,
    cellH,
    front,
    back,
  };
}

/**
 * sheetsFor(qty, perSheet) → { sheets, lastSheetCount }
 *
 * `qty` = the per-image manifest quantity — the true print count. Do NOT
 * pass `job.quantity`; that field is unreliable for the same reasons the
 * batch splitter and print-count gate consume the manifest number instead
 * (film jobs are per-image, manual is total, Pixfizz recomputes it — see
 * design doc §3.4).
 *
 * `perSheet` is the value returned by computeLayout.
 *
 * `lastSheetCount` is the number of cells USED on the FINAL sheet — never
 * 0 even for an exact division. qty=100 on a 4-up layout returns
 * { sheets: 25, lastSheetCount: 4 } (the last sheet is fully populated),
 * not lastSheetCount: 0 which would be surprising to callers expecting
 * "how many cells to place on the last sheet."
 */
function sheetsFor(qty, perSheet) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`sheetsFor: qty must be a positive integer (got ${qty})`);
  }
  if (!Number.isInteger(perSheet) || perSheet <= 0) {
    throw new Error(`sheetsFor: perSheet must be a positive integer (got ${perSheet})`);
  }
  const sheets    = Math.ceil(qty / perSheet);
  const remainder = qty % perSheet;
  const lastSheetCount = remainder === 0 ? perSheet : remainder;
  return { sheets, lastSheetCount };
}

module.exports = {
  inchesToPoints,
  mmToPoints,
  computeLayout,
  sheetsFor,
};
