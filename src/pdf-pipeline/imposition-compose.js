'use strict';

/**
 * imposition-compose — pdf-lib composition for N-up imposition. Consumes
 * an M1 layout (see imposition-layout.js), embeds the artwork PDF into
 * a new PDF whose pages are the sheet size, and step-and-repeats each
 * artwork page across the sheet at the layout's cell positions.
 *
 * Contract: bytes in, bytes out. No fs, no dispatch, no config knowledge.
 * The full read-me for this module lives in
 * docs/pdf-imposition-investigation.md §3 (design), §4 (dispatch flow),
 * §7 (decisions). The M1 layout module owns pure geometry; this module
 * owns pdf-lib. The rule "one implementation, same as buildDestFolder"
 * applies to deriveTrim: it is exported so M5 dispatch (which computes
 * the layout from the artwork) can call the same function that the
 * composer uses to place the artwork. A trim rule that drifts between
 * layout-time and compose-time silently mis-places every cell.
 *
 * Structure:
 *   - deriveTrim(page, artworkBleed)      — pure; TrimBox vs bleed-inset
 *   - planPlacements({quantity, layout,   — pure; row-major, front then
 *       mode})                              back per sheet
 *   - composeImposition({...})            — pdf-lib; wires the above
 *
 * The pure functions are the correctness surface: planPlacements is
 * exhaustively tested and composeImposition draws the plan verbatim.
 * Asserting exact drawn positions inside a PDF content stream is brittle
 * (pdf-lib may re-order transforms, use scale-and-rotate matrices, etc.);
 * tests instead exercise the plan directly and confirm structural
 * properties of the output (page count, MediaBox size, error posture).
 */

const { PDFDocument, degrees, rgb } = require('pdf-lib');

/**
 * Tolerance for the trim-vs-layout size check. 0.5 pt (~0.007 in) accepts
 * rounding drift between the design tool's declared TrimBox and the
 * layout's cell dimensions without accepting real mismatches (a 5×7 card
 * on a 6×8 layout would blow past this by hundreds of pt).
 */
const TRIM_TOLERANCE = 0.5;

/**
 * Tolerance for the "TrimBox is smaller than MediaBox" detection in
 * deriveTrim. Sub-pt precision — real TrimBoxes are usually integer or
 * half-pt values, so any real trim inset produces a difference many
 * orders of magnitude larger than this.
 */
const BOX_EPS = 0.001;

/**
 * Small epsilon for the crop-mark neighbour-trim check. Marks that touch
 * (or FP-nearly-touch) a neighbouring trim boundary are conservatively
 * omitted.
 */
const MARK_EDGE_EPS = 1e-6;

/**
 * Crop-mark geometry per §3.5 and the M2 spec.
 *   length: 12 pt
 *   thickness: 0.25 pt (as drawn)
 *   gap-from-trim: max(artworkBleed, 9 pt)  — never runs into the bleed
 */
const CROP_MARK_LENGTH  = 12;
const CROP_MARK_MIN_GAP = 9;
const CROP_MARK_THICKNESS = 0.25;

/**
 * deriveTrim(page, artworkBleed)
 *   → { x, y, width, height }
 *
 * Rule:
 *   - TrimBox present AND smaller than MediaBox → return TrimBox verbatim.
 *   - Otherwise → return MediaBox inset by artworkBleed on all sides
 *     (artworkBleed=0 means "MediaBox IS the trim").
 *
 * "Smaller than" means at least one dimension is strictly less than the
 * corresponding MediaBox dimension. pdf-lib's getTrimBox() falls back to
 * MediaBox when no /TrimBox key is present, so a size-equal comparison
 * covers both "no TrimBox" and "TrimBox explicitly = MediaBox" (both
 * mean the design tool has not staked a trim claim, so bleed inset is
 * the right derivation).
 *
 * IMPORTANT: this function must be called by BOTH sides of the imposition
 * pipeline (M5 dispatch reads the trim to compute the layout; this module
 * reads the same trim to place the artwork). Splitting it into two
 * copies is the same drift hazard as two implementations of
 * buildDestFolder — the M5 preview would show one grid and the composer
 * would place a different one. Fix here, both sides pick it up.
 */
function deriveTrim(page, artworkBleed = 0) {
  const media = page.getMediaBox();
  const trim  = page.getTrimBox();
  const trimIsSmaller =
    trim.width  < media.width  - BOX_EPS ||
    trim.height < media.height - BOX_EPS;
  if (trimIsSmaller) {
    return { x: trim.x, y: trim.y, width: trim.width, height: trim.height };
  }
  const b = Number.isFinite(artworkBleed) && artworkBleed > 0 ? artworkBleed : 0;
  return {
    x:      media.x + b,
    y:      media.y + b,
    width:  media.width  - 2 * b,
    height: media.height - 2 * b,
  };
}

/**
 * planPlacements({quantity, layout, mode}) — pure, deterministic.
 *   → { plan, sheets, placedPerSheet }
 *
 * The plan is the source of truth for what goes where. Each entry is
 * { sheet, side, cellIndex, x, y, rotated }; the composer walks it in
 * order and draws each placement. Blank cells on a partial last sheet
 * produce NO plan entry (the composer therefore draws nothing there).
 *
 * For duplex the plan always includes back entries (front then back per
 * sheet, in row-major cell order). Whether the back has artwork to draw
 * is a composer concern — a 1-page artwork on a duplex layout produces
 * blank backs (§7.2 decision), but the plan still lists the back cells
 * so a caller inspecting the plan sees the intended geometry.
 *
 * Ordering rules (locked; the tests assert them):
 *   1. Sheets in ascending order (0, 1, …).
 *   2. Within a sheet, all fronts first, then all backs (for duplex).
 *   3. Within a side, cells in row-major layout order (which matches
 *      layout.front[]/layout.back[]).
 *   4. On the partial last sheet, only lastSheetCount cells per side;
 *      back-mirroring still applies (back[i] only for placed i).
 */
function planPlacements({ quantity, layout, mode }) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`planPlacements: quantity must be a positive integer (got ${quantity})`);
  }
  if (mode !== 'simplex' && mode !== 'duplex') {
    throw new Error(`planPlacements: mode must be 'simplex' or 'duplex' (got ${JSON.stringify(mode)})`);
  }
  if (!layout || !Array.isArray(layout.front) ||
      !Number.isInteger(layout.perSheet) || layout.perSheet <= 0) {
    throw new Error('planPlacements: layout must be a computeLayout() result');
  }
  if (mode === 'duplex' && !Array.isArray(layout.back)) {
    throw new Error(
      'planPlacements: duplex mode requires layout.back — the passed layout was ' +
      'computed for simplex (mode mismatch). Recompute the layout with mode:"duplex".'
    );
  }

  const perSheet = layout.perSheet;
  const sheets   = Math.ceil(quantity / perSheet);
  const rotated  = !!layout.rotated;
  const plan     = [];
  let placed = 0;

  for (let s = 0; s < sheets; s++) {
    const remaining = quantity - placed;
    const thisSheet = Math.min(perSheet, remaining);

    for (let i = 0; i < thisSheet; i++) {
      const cell = layout.front[i];
      plan.push({
        sheet:     s,
        side:      'front',
        cellIndex: i,
        x:         cell.x,
        y:         cell.y,
        rotated,
      });
    }

    if (mode === 'duplex') {
      for (let i = 0; i < thisSheet; i++) {
        const cell = layout.back[i];
        plan.push({
          sheet:     s,
          side:      'back',
          cellIndex: i,
          x:         cell.x,
          y:         cell.y,
          rotated,
        });
      }
    }

    placed += thisSheet;
  }

  return { plan, sheets, placedPerSheet: perSheet };
}

/**
 * Given the layout's cell dimensions and rotation flag, return the
 * (width, height) the artwork's TRIM must have. When rotated, the
 * artwork is placed 90° CCW into the cell, so the artwork's natural
 * trim dimensions are the SWAP of the post-rotation cell dims.
 */
function _expectedTrimSize(cellW, cellH, rotated) {
  return rotated
    ? { width: cellH, height: cellW }
    : { width: cellW, height: cellH };
}

/**
 * Compute the (x, y) to pass to pdf-lib's drawPage for a placement.
 *
 * PDF drawPage semantics:
 *   - Un-rotated: (x, y) is where the ARTWORK MEDIA's lower-left corner
 *     lands. To put the TRIM's lower-left at (cellX, cellY), we offset
 *     media LL back by the trim's inset within media:
 *       drawX = cellX − trim.x
 *       drawY = cellY − trim.y
 *
 *   - 90° CCW rotated: pdf-lib rotates first (around artwork origin),
 *     then translates so the artwork's original (0,0) lands at (x, y).
 *     Working out the bounding-box arithmetic (see the derivation in
 *     the M2 test comments): to put the ROTATED trim's lower-left at
 *     (cellX, cellY),
 *       drawX = cellX + trim.y + trim.height
 *       drawY = cellY − trim.x
 *
 * The no-bleed common case (trim.x = trim.y = 0, trim = media):
 *   - Un-rotated: drawX = cellX, drawY = cellY  (the obvious case)
 *   - Rotated:    drawX = cellX + cellW, drawY = cellY
 */
function _drawXY(cellX, cellY, trim, rotated) {
  if (rotated) {
    return {
      x: cellX + trim.y + trim.height,
      y: cellY - trim.x,
    };
  }
  return {
    x: cellX - trim.x,
    y: cellY - trim.y,
  };
}

/**
 * All eight candidate crop-mark lines for one cell's trim (2 marks × 4
 * corners). Each mark is a line segment { x1, y1, x2, y2 } where
 * (x1, y1) is the endpoint NEAR the trim and (x2, y2) is the FAR
 * endpoint.
 *
 * gap = max(artworkBleed, CROP_MARK_MIN_GAP) — the mark starts past
 * the bleed so it never overlaps drawn artwork.
 */
function _cropMarkCandidates(trim, artworkBleed) {
  const gap = Math.max(Number.isFinite(artworkBleed) ? artworkBleed : 0, CROP_MARK_MIN_GAP);
  const L   = CROP_MARK_LENGTH;
  const x0 = trim.x;
  const y0 = trim.y;
  const x1 = trim.x + trim.width;   // right edge
  const y1 = trim.y + trim.height;  // top edge

  return [
    // Lower-Left corner
    { x1: x0 - gap,     y1: y0,         x2: x0 - gap - L, y2: y0 },          // H, extends left
    { x1: x0,           y1: y0 - gap,   x2: x0,           y2: y0 - gap - L }, // V, extends down
    // Lower-Right corner
    { x1: x1 + gap,     y1: y0,         x2: x1 + gap + L, y2: y0 },          // H, extends right
    { x1: x1,           y1: y0 - gap,   x2: x1,           y2: y0 - gap - L }, // V, extends down
    // Upper-Left corner
    { x1: x0 - gap,     y1: y1,         x2: x0 - gap - L, y2: y1 },          // H, extends left
    { x1: x0,           y1: y1 + gap,   x2: x0,           y2: y1 + gap + L }, // V, extends up
    // Upper-Right corner
    { x1: x1 + gap,     y1: y1,         x2: x1 + gap + L, y2: y1 },          // H, extends right
    { x1: x1,           y1: y1 + gap,   x2: x1,           y2: y1 + gap + L }, // V, extends up
  ];
}

/**
 * Point (x, y) inside any of `trims` except `excludeIdx`? Inclusive of
 * the trim boundary within MARK_EDGE_EPS — a mark that just touches a
 * neighbouring trim is conservatively counted as entering it, because
 * "on the edge" reads as a cut-line into a neighbour when it's printed.
 */
function _pointInAnyOtherTrim(x, y, trims, excludeIdx) {
  for (let i = 0; i < trims.length; i++) {
    if (i === excludeIdx) continue;
    const t = trims[i];
    if (x >= t.x - MARK_EDGE_EPS && x <= t.x + t.width  + MARK_EDGE_EPS &&
        y >= t.y - MARK_EDGE_EPS && y <= t.y + t.height + MARK_EDGE_EPS) {
      return true;
    }
  }
  return false;
}

/**
 * Draw crop marks for every layout cell on `page`. Marks that would
 * enter another cell's trim are omitted (§3.5: "Marks must never enter
 * a neighbouring cell's trim"). Marks are drawn on FRONT and BACK pages
 * alike — the operator cuts to trim regardless of which side is up, and
 * marks appear at the same trim positions per side.
 *
 * `cellPositions` is layout.front OR layout.back (both use the same
 * cellW/cellH). `sheetWidth`/`sheetHeight` unused here directly, but
 * kept for symmetry with the API if a future rule needs to clip against
 * sheet borders as well.
 */
function _drawCropMarks(page, cellPositions, cellW, cellH, artworkBleed) {
  const trims = cellPositions.map(({ x, y }) => ({ x, y, width: cellW, height: cellH }));
  const black = rgb(0, 0, 0);
  for (let i = 0; i < trims.length; i++) {
    const marks = _cropMarkCandidates(trims[i], artworkBleed);
    for (const m of marks) {
      if (_pointInAnyOtherTrim(m.x2, m.y2, trims, i)) continue;
      page.drawLine({
        start:     { x: m.x1, y: m.y1 },
        end:       { x: m.x2, y: m.y2 },
        thickness: CROP_MARK_THICKNESS,
        color:     black,
      });
    }
  }
}

/**
 * composeImposition({...}) → { pdfBytes, sheets, placedPerSheet }
 *
 * Bytes in, bytes out. See top-of-file for the contract.
 *
 * Params (all dimensions in PDF points, per §7.7):
 *   artworkBytes    — one design's PDF bytes (Uint8Array or Buffer)
 *   quantity        — copies of THIS design (per-image manifest qty; §3.4)
 *   layout          — computeLayout() result
 *   sheetWidth/Height — press-sheet dims; MUST match the layout's sheet
 *   mode            — 'simplex' | 'duplex'
 *   cropMarks       — bool; corner crop marks per cell trim
 *   artworkBleed    — points, used for bleed-inset derivation AND the
 *                     crop-mark gap. 0 = trust the boxes.
 *   logger          — optional; if provided and 1-page artwork lands on
 *                     a duplex template, logger.logWarning(msg) is called
 *                     once. Never throws when logger is absent.
 *
 * Errors (throw):
 *   - artwork page count vs mode:
 *       simplex with >1 page              — v1 rejects (§7.2)
 *       duplex with >2 pages              — v1 rejects (§7.2)
 *   - trim derived from the artwork does not match layout.cellW/cellH
 *     (within TRIM_TOLERANCE)             — the layout was computed for
 *                                           different artwork; refuse to
 *                                           silently mis-place.
 *
 * Never throws just because a logger is missing.
 */
async function composeImposition({
  artworkBytes,
  quantity,
  layout,
  sheetWidth,
  sheetHeight,
  mode,
  cropMarks    = false,
  artworkBleed = 0,
  logger       = null,
} = {}) {
  if (!artworkBytes) {
    throw new Error('composeImposition: artworkBytes is required');
  }
  if (mode !== 'simplex' && mode !== 'duplex') {
    throw new Error(`composeImposition: mode must be 'simplex' or 'duplex' (got ${JSON.stringify(mode)})`);
  }
  if (!layout || !Array.isArray(layout.front) ||
      !Number.isInteger(layout.perSheet) || layout.perSheet <= 0 ||
      !Number.isFinite(layout.cellW) || !Number.isFinite(layout.cellH)) {
    throw new Error('composeImposition: layout must be a computeLayout() result');
  }
  if (mode === 'duplex' && !Array.isArray(layout.back)) {
    throw new Error('composeImposition: duplex mode requires layout.back (layout was computed for simplex)');
  }
  if (!Number.isFinite(sheetWidth) || !Number.isFinite(sheetHeight) ||
      sheetWidth <= 0 || sheetHeight <= 0) {
    throw new Error(
      `composeImposition: sheetWidth/sheetHeight must be positive numbers ` +
      `(got ${sheetWidth} × ${sheetHeight})`
    );
  }

  const srcDoc     = await PDFDocument.load(artworkBytes);
  const srcPages   = srcDoc.getPages();
  const nSrcPages  = srcPages.length;

  // Page-count vs mode validation (§7.2)
  if (mode === 'simplex' && nSrcPages !== 1) {
    throw new Error(
      `composeImposition: simplex template requires a 1-page artwork PDF ` +
      `(got ${nSrcPages} pages) — v1 rejects multi-page simplex per §7.2`
    );
  }
  if (mode === 'duplex' && (nSrcPages < 1 || nSrcPages > 2)) {
    throw new Error(
      `composeImposition: duplex template requires a 1- or 2-page artwork PDF ` +
      `(got ${nSrcPages} pages) — v1 rejects >2-page duplex per §7.2`
    );
  }

  // Trim derivation per source page + validation against layout
  const bleed    = Number.isFinite(artworkBleed) && artworkBleed > 0 ? artworkBleed : 0;
  const expected = _expectedTrimSize(layout.cellW, layout.cellH, !!layout.rotated);
  const trims    = srcPages.map(p => deriveTrim(p, bleed));
  trims.forEach((t, i) => {
    const dw = Math.abs(t.width  - expected.width);
    const dh = Math.abs(t.height - expected.height);
    if (dw > TRIM_TOLERANCE || dh > TRIM_TOLERANCE) {
      throw new Error(
        `composeImposition: artwork page ${i + 1} trim ` +
        `${t.width.toFixed(3)} × ${t.height.toFixed(3)} pt does not match ` +
        `layout cell ${expected.width} × ${expected.height} pt ` +
        `(rotated=${!!layout.rotated}, tolerance=${TRIM_TOLERANCE} pt) — ` +
        `the layout was computed for different artwork`
      );
    }
  });

  // 1-page duplex → blank backs + WARN (§7.2 decision)
  const blankBacks = (mode === 'duplex' && nSrcPages === 1);
  if (blankBacks && logger && typeof logger.logWarning === 'function') {
    logger.logWarning(
      '[imposition] duplex template with 1-page artwork — back pages will be blank'
    );
  }

  // Plan (pure, deterministic)
  const { plan, sheets, placedPerSheet } = planPlacements({ quantity, layout, mode });

  // Output doc, sheet-per-page (2× for duplex)
  const outDoc = await PDFDocument.create();

  // Embed source pages once — each embed produces a PDFEmbeddedPage that
  // pdf-lib can drawPage() many times cheaply.
  const embeddedPages = await outDoc.embedPages(srcPages);

  // Add empty output pages first so we can index into them by (sheet, side).
  // Ordering: sheet 0 front, sheet 0 back, sheet 1 front, sheet 1 back, …
  const outPages = [];
  for (let s = 0; s < sheets; s++) {
    outPages.push(outDoc.addPage([sheetWidth, sheetHeight]));  // front
    if (mode === 'duplex') {
      outPages.push(outDoc.addPage([sheetWidth, sheetHeight])); // back
    }
  }

  const pageStride = (mode === 'duplex') ? 2 : 1;

  // Crop marks: one pass per output page, using the layout's full cell
  // set (not the plan) — the operator wants uniform marks on every sheet,
  // even the partial last one (see §3.5 rationale). Draw before artwork
  // so heavy artwork ink doesn't obscure the fine marks.
  if (cropMarks) {
    for (let s = 0; s < sheets; s++) {
      const frontPage = outPages[s * pageStride];
      _drawCropMarks(frontPage, layout.front, layout.cellW, layout.cellH, bleed);
      if (mode === 'duplex') {
        const backPage = outPages[s * pageStride + 1];
        _drawCropMarks(backPage, layout.back, layout.cellW, layout.cellH, bleed);
      }
    }
  }

  // Walk the plan, draw each placement.
  for (const entry of plan) {
    const isBackSide = (entry.side === 'back');
    const sourceIdx  = isBackSide ? (nSrcPages > 1 ? 1 : null) : 0;
    if (sourceIdx === null) continue;  // blank back: no source page to draw
    const targetPage = outPages[entry.sheet * pageStride + (isBackSide ? 1 : 0)];
    const emb        = embeddedPages[sourceIdx];
    const trim       = trims[sourceIdx];
    const { x, y }   = _drawXY(entry.x, entry.y, trim, entry.rotated);
    if (entry.rotated) {
      targetPage.drawPage(emb, { x, y, rotate: degrees(90) });
    } else {
      targetPage.drawPage(emb, { x, y });
    }
  }

  const pdfBytes = await outDoc.save();
  return { pdfBytes, sheets, placedPerSheet };
}

module.exports = {
  deriveTrim,
  planPlacements,
  composeImposition,
  // Exposed for the M2 test suite. Not a public API — do not build on
  // these from dispatch or UI code.
  _internal: {
    TRIM_TOLERANCE,
    BOX_EPS,
    CROP_MARK_LENGTH,
    CROP_MARK_MIN_GAP,
    CROP_MARK_THICKNESS,
    _expectedTrimSize,
    _drawXY,
    _cropMarkCandidates,
    _pointInAnyOtherTrim,
  },
};
