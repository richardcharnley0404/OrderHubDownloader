'use strict';

/**
 * imposition-preview — the thinnest possible wrapper over the real M1
 * `computeLayout` engine, exposed via IPC so the renderer's live layout
 * preview can render the SAME grid the save-time validator (M3) and
 * dispatch (M5) will produce.
 *
 * "The preview IS the engine, never a parallel implementation" (the
 * M5a lesson from folder-copy-preview and buildDestFolder). A preview
 * that computes a different grid than dispatch is worse than no
 * preview — it lulls the operator into believing a template is right
 * exactly when it isn't. So this module does NOT reimplement any part
 * of the fit logic; it validates the in-edit shape enough to give a
 * helpful "specify X" message for missing required fields, then calls
 * computeLayout and returns its result verbatim (or its error message
 * verbatim on zero-fit).
 *
 * Response shape:
 *   { ok: true,
 *     sheetWidth, sheetHeight, margins, gutter,   // echoed from input
 *     mode, duplexFlipEdge,                        // for renderer caption
 *     layout: <computeLayout result> }
 *   { ok: false, error: <string> }
 *
 * Renderer draws a scaled SVG from the returned layout (sheet outline,
 * usable-area shading from margins, grid cells with gutter visible,
 * caption "N per sheet — rotated/unrotated"). Duplex draws the FRONT
 * grid only in v1 with a caption "backs mirror across the long/short
 * edge" — see §6.2 of docs/pdf-imposition-investigation.md and the
 * M4 spec.
 */

const { computeLayout } = require('../../pdf-pipeline/imposition-layout');

/**
 * Preview inputs — all in POINTS. The renderer converts from the paper
 * size's operator-facing unit (in / mm) using the M1 helpers before
 * invoking this.
 *
 * @param {object} input
 * @param {{width:number, height:number}} input.paperSize
 * @param {{top:number, right:number, bottom:number, left:number}} [input.margins]
 * @param {number} [input.gutter]
 * @param {{width:number, height:number}} input.expectedArtwork
 * @param {boolean} [input.autoRotate]
 * @param {'simplex'|'duplex'} input.mode
 * @param {'long'|'short'} [input.duplexFlipEdge]
 */
async function previewLayout(input = {}) {
  // Shape checks — cheap, and produce operator-friendly "pick X"
  // messages rather than the engine's more terse validator errors when
  // the user simply hasn't finished entering fields yet.
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Preview input is required.' };
  }
  if (!input.paperSize ||
      !Number.isFinite(input.paperSize.width) ||
      !Number.isFinite(input.paperSize.height) ||
      input.paperSize.width  <= 0 ||
      input.paperSize.height <= 0) {
    return { ok: false, error: 'Pick a paper size to preview the layout.' };
  }
  if (!input.expectedArtwork ||
      !Number.isFinite(input.expectedArtwork.width) ||
      !Number.isFinite(input.expectedArtwork.height) ||
      input.expectedArtwork.width  <= 0 ||
      input.expectedArtwork.height <= 0) {
    return { ok: false, error: 'Enter an expected artwork size (width × height) to preview the layout.' };
  }
  if (input.mode !== 'simplex' && input.mode !== 'duplex') {
    return { ok: false, error: `Pick a mode (simplex or duplex) to preview the layout.` };
  }
  if (input.mode === 'duplex' && input.duplexFlipEdge !== 'long' && input.duplexFlipEdge !== 'short') {
    return { ok: false, error: `Pick a duplex flip edge (long or short) to preview the layout.` };
  }

  // Delegate to the real engine — the whole point. Any zero-fit / other
  // engine-level error surfaces verbatim so the operator sees exactly
  // what save-time validation will say.
  try {
    const layout = computeLayout({
      sheetWidth:     input.paperSize.width,
      sheetHeight:    input.paperSize.height,
      margins:        input.margins || {},
      gutter:         Number.isFinite(input.gutter) ? input.gutter : 0,
      cellWidth:      input.expectedArtwork.width,
      cellHeight:     input.expectedArtwork.height,
      autoRotate:     !!input.autoRotate,
      mode:           input.mode,
      duplexFlipEdge: input.duplexFlipEdge,
    });
    return {
      ok: true,
      sheetWidth:     input.paperSize.width,
      sheetHeight:    input.paperSize.height,
      margins: {
        top:    (input.margins && Number.isFinite(input.margins.top))    ? input.margins.top    : 0,
        right:  (input.margins && Number.isFinite(input.margins.right))  ? input.margins.right  : 0,
        bottom: (input.margins && Number.isFinite(input.margins.bottom)) ? input.margins.bottom : 0,
        left:   (input.margins && Number.isFinite(input.margins.left))   ? input.margins.left   : 0,
      },
      gutter:         Number.isFinite(input.gutter) ? input.gutter : 0,
      mode:           input.mode,
      duplexFlipEdge: input.mode === 'duplex' ? input.duplexFlipEdge : null,
      layout,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { previewLayout };
