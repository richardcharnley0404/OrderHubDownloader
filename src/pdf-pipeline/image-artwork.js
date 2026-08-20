'use strict';

/**
 * image-artwork — pure module that turns a JPEG/PNG file into the same
 * shape the PDF imposition path already expects, so that everything
 * downstream (planPlacements, duplex mirror, crop marks, master mode)
 * works UNCHANGED. Same discipline as imposition-layout.js and
 * imposition-filename.js: no fs, no electron, no pdf-lib, fully
 * testable without an app running.
 *
 * The load-bearing rule (Richard's words, 2026-08-20):
 *   "the images will have to fit in the finished size + bleed - so
 *    they can be expanded to fit and stretch. We need this to allow
 *    for guillotine cutting"
 *
 * So the image is drawn at EXACTLY the template's bleed box —
 * `trimW + 2×bleed × trimH + 2×bleed` — with non-uniform scale
 * allowed. Aspect-ratio distortion is deliberate; the alternative
 * (scale-to-cover + centre-crop) would leave uncovered corners
 * against a guillotine cutter, which is the failure mode the
 * "expand to fit and stretch" rule exists to prevent.
 *
 * ── Rotation ──
 *
 * When the image's pixel orientation opposes the cell's orientation
 * (one landscape, the other portrait), we rotate the image 90° CCW
 * before stretching. This minimises distortion — the more the pixel
 * aspect matches the cell aspect, the less stretch is applied per
 * axis. A square image or a square cell means "no rotation".
 *
 * ── Rotation formula derivation (analytical, not fitted) ──
 *
 * pdf-lib's drawImage({x, y, width, height, rotate}) applies rotation
 * FIRST around the artwork origin, THEN translates so the artwork's
 * original (0, 0) lands at (x, y). The user-visible width/height
 * arguments are the PRE-ROTATION size.
 *
 * Unrotated case (the common one): draw the whole image at the bleed
 * box. Bleed box lower-left is at (cellX - bleed, cellY - bleed);
 * bleed box size is (bleedW, bleedH). pdf-lib args:
 *   x       = cellX - bleed
 *   y       = cellY - bleed
 *   width   = bleedW
 *   height  = bleedH
 *
 * Rotated 90° CCW case: pre-rotation size must be (bleedH, bleedW) so
 * the post-rotation bounding box comes out as (bleedW, bleedH). Take
 * the four corners of the pre-rotation image, rotate 90° CCW around
 * origin, then translate by (x, y):
 *
 *   corner           pre-rot          rotated              translated
 *   LL (0, 0)     → (0, 0)         → (0, 0)              → (x, y)
 *   LR (bleedH,0) → (bleedH, 0)    → (0, bleedH)         → (x, y+bleedH)
 *   UL (0,bleedW) → (0, bleedW)    → (-bleedW, 0)        → (x-bleedW, y)
 *   UR (bleedH,   → (bleedH,       → (-bleedW, bleedH)   → (x-bleedW,
 *       bleedW)      bleedW)                                y+bleedH)
 *
 * The rotated bounding box is x from (x - bleedW) to x; y from y to
 * (y + bleedH). We want this to equal the bleed box: LL at
 * (cellX - bleed, cellY - bleed), UR at (cellX - bleed + bleedW,
 * cellY - bleed + bleedH). So:
 *   x - bleedW = cellX - bleed   →  x = cellX - bleed + bleedW
 *   y          = cellY - bleed
 *
 * The tests hand-compute the resulting corner coordinates for a
 * specific asymmetric-margins case and assert them, so a sign error
 * fails there before it prints wrong-orientation images on real
 * artwork.
 */

// ── Magic bytes ─────────────────────────────────────────────────────────

const MAGIC_JPEG = [0xFF, 0xD8, 0xFF];             // SOI + first byte of the next marker
const MAGIC_PNG  = [0x89, 0x50, 0x4E, 0x47];       // \x89 P N G (first 4 of the 8-byte signature)

/**
 * Sniff the image format from magic bytes. The file extension is NOT
 * trusted — a `.jpg` file that's actually a PNG (browser-download
 * mislabelling is common) still gets embedded correctly this way.
 * Returns 'jpeg' | 'png' | null.
 */
function sniffFormat(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 4) return null;
  if (bytes[0] === MAGIC_JPEG[0] && bytes[1] === MAGIC_JPEG[1] && bytes[2] === MAGIC_JPEG[2]) return 'jpeg';
  if (bytes[0] === MAGIC_PNG[0]  && bytes[1] === MAGIC_PNG[1]  && bytes[2] === MAGIC_PNG[2] && bytes[3] === MAGIC_PNG[3]) return 'png';
  return null;
}

// ── JPEG SOF scan ────────────────────────────────────────────────────────

/**
 * JPEG Start-of-Frame markers that carry sample dimensions and
 * component count. Every valid JPEG has exactly one SOF-family marker
 * (typically SOF0 = baseline, SOF2 = progressive). SOF4/8/12 are DHT/
 * DAC/DRI and are NOT SOF variants — hence the gaps.
 */
function _isSofMarker(byte) {
  // 0xC0..0xC3, 0xC5..0xC7, 0xC9..0xCB, 0xCD..0xCF
  if (byte >= 0xC0 && byte <= 0xC3) return true;
  if (byte >= 0xC5 && byte <= 0xC7) return true;
  if (byte >= 0xC9 && byte <= 0xCB) return true;
  if (byte >= 0xCD && byte <= 0xCF) return true;
  return false;
}

/**
 * Walk a JPEG's segment stream to find the SOF marker, then read
 * height, width, and component count. Returns
 *   { width, height, components } | null on parse failure.
 *
 * Segment layout: 0xFF <marker> [2-byte big-endian length] [payload].
 * The length INCLUDES the two length bytes but NOT the marker bytes.
 * SOI (0xFFD8) and EOI (0xFFD9) and RSTn (0xFFD0..0xFFD7) carry no
 * length; they're skipped as bare 2-byte tokens. TEM (0xFF01) is also
 * length-less.
 */
function _readJpegSof(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  let i = 2;
  while (i < bytes.length - 1) {
    // Skip stuffing bytes; a real marker starts with 0xFF followed
    // by a non-zero, non-0xFF byte.
    while (i < bytes.length && bytes[i] !== 0xFF) i++;
    while (i < bytes.length && bytes[i] === 0xFF) i++;
    if (i >= bytes.length) break;
    const marker = bytes[i]; i++;
    // Markers without a length payload.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) continue;
    if (i + 1 >= bytes.length) return null;
    const segLen = (bytes[i] << 8) | bytes[i + 1];
    if (segLen < 2 || i + segLen > bytes.length) return null;
    if (_isSofMarker(marker)) {
      // SOF payload: precision(1), height(2), width(2), components(1).
      // We need at least 6 bytes of payload past the length.
      if (segLen < 8) return null;
      const height     = (bytes[i + 3] << 8) | bytes[i + 4];
      const width      = (bytes[i + 5] << 8) | bytes[i + 6];
      const components =  bytes[i + 7];
      return { width, height, components };
    }
    i += segLen;
  }
  return null;
}

// ── PNG IHDR ─────────────────────────────────────────────────────────────

/**
 * Read a PNG's IHDR chunk. The IHDR chunk MUST be the first chunk
 * after the 8-byte signature (PNG spec 11.2.2). Returns
 *   { width, height, bitDepth, colorType } | null on parse failure.
 *
 * PNG is never CMYK (color types are 0/2/3/4/6 — grayscale, RGB,
 * palette, grayscale+alpha, RGBA) so we don't return a components
 * count here; the caller only needs dimensions.
 */
function _readPngIhdr(bytes) {
  // Signature (8) + chunk length (4) + 'IHDR' (4) + payload (13) = 29 minimum.
  if (bytes.length < 29) return null;
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  // First chunk header at offset 8.
  const chunkLen = (bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11];
  if (chunkLen !== 13) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width     = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height    = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  const bitDepth  = bytes[24];
  const colorType = bytes[25];
  return { width: width >>> 0, height: height >>> 0, bitDepth, colorType };
}

// ── Public: dimensions + colour-space check ─────────────────────────────

/**
 * readImageDimensions(bytes, format) →
 *   { width, height, colorSpace }
 *
 * `colorSpace` is 'grayscale' | 'rgb' | 'cmyk' | 'unknown' for JPEG
 * (based on the SOF component count: 1/3/4/other), and 'rgb' for
 * every PNG (color type doesn't distinguish RGB vs RGBA for our
 * pdf-lib embed path — both go through embedPng — and CMYK is
 * impossible in PNG).
 *
 * Throws on unparseable bytes with an operator-facing message.
 */
function readImageDimensions(bytes, format) {
  if (format === 'jpeg') {
    const sof = _readJpegSof(bytes);
    if (!sof) throw new Error('Could not read JPEG dimensions — file may be truncated or malformed.');
    let colorSpace = 'unknown';
    if (sof.components === 1)      colorSpace = 'grayscale';
    else if (sof.components === 3) colorSpace = 'rgb';
    else if (sof.components === 4) colorSpace = 'cmyk';
    return { width: sof.width, height: sof.height, colorSpace };
  }
  if (format === 'png') {
    const ihdr = _readPngIhdr(bytes);
    if (!ihdr) throw new Error('Could not read PNG dimensions — file may be truncated or malformed.');
    return { width: ihdr.width, height: ihdr.height, colorSpace: 'rgb' };
  }
  throw new Error(`readImageDimensions: unsupported format ${JSON.stringify(format)}.`);
}

/**
 * The exact message the dispatch layer surfaces when it hits a CMYK
 * JPEG. Exported so tests can lock the wording (operator sees it
 * verbatim) without depending on the dispatch call path.
 */
function cmykRejectMessage(filename) {
  return (
    `Image '${filename}' is a CMYK JPEG which cannot be imposed. ` +
    `Re-export as RGB from the original artwork tool (Photoshop: ` +
    `Image → Mode → RGB Color; Illustrator: File → Document Color ` +
    `Mode → RGB Color; then re-save as JPEG) and re-upload.`
  );
}

// ── Bleed box + synthetic trim ──────────────────────────────────────────

/**
 * computeBleedBox({trimWidth, trimHeight, artworkBleed}) →
 *   { trimWidth, trimHeight, bleed, bleedWidth, bleedHeight, syntheticTrim }
 *
 * All in POINTS. The synthetic trim is what the compose validator
 * checks: by construction it equals the template's expected artwork
 * (Finished Size), so the "trim vs layout" mismatch check on the PDF
 * path passes trivially on the image path too. The bleed box is what
 * the image is DRAWN at.
 */
function computeBleedBox({ trimWidth, trimHeight, artworkBleed }) {
  if (!Number.isFinite(trimWidth) || trimWidth <= 0) {
    throw new Error(`computeBleedBox: trimWidth must be a positive number (got ${trimWidth})`);
  }
  if (!Number.isFinite(trimHeight) || trimHeight <= 0) {
    throw new Error(`computeBleedBox: trimHeight must be a positive number (got ${trimHeight})`);
  }
  const bleed = (Number.isFinite(artworkBleed) && artworkBleed >= 0) ? artworkBleed : 0;
  const bleedWidth  = trimWidth  + 2 * bleed;
  const bleedHeight = trimHeight + 2 * bleed;
  return {
    trimWidth, trimHeight, bleed, bleedWidth, bleedHeight,
    // syntheticTrim matches deriveTrim's return shape so callers can
    // interchange PDF trims and image trims.
    syntheticTrim: { x: bleed, y: bleed, width: trimWidth, height: trimHeight },
  };
}

// ── Rotation choice + draw args ─────────────────────────────────────────

/**
 * chooseRotation(imgW, imgH, cellW, cellH) → 0 | 90
 *
 * Returns 90 when the image's pixel orientation OPPOSES the cell's
 * orientation (one landscape, the other portrait). Returns 0 in every
 * other case, INCLUDING squares (either side square → no benefit to
 * rotating). Purpose: minimise the per-axis stretch — a portrait
 * image on a portrait cell needs less distortion than the same
 * portrait image on a landscape cell.
 *
 * "Orientation" uses strict > / < ; equal dimensions on either side
 * mean "square-ish" and no rotation happens.
 */
function chooseRotation(imgWidth, imgHeight, cellWidth, cellHeight) {
  if (imgWidth === imgHeight || cellWidth === cellHeight) return 0;
  const imgLandscape  = imgWidth  > imgHeight;
  const cellLandscape = cellWidth > cellHeight;
  return (imgLandscape === cellLandscape) ? 0 : 90;
}

/**
 * computeImageDrawArgs({cellX, cellY, bleed, bleedWidth, bleedHeight, rotation})
 *   → { x, y, width, height, rotate? }
 *
 * The pdf-lib drawImage argument object. See the top-of-file rotation
 * derivation for how the rotated case's x/y/width/height are computed.
 *
 * `rotate` is included ONLY when rotation !== 0 so the unrotated
 * argument object stays exactly the same shape as the PDF path's
 * drawPage call — a defensive test that reads the .rotate key doesn't
 * accidentally see a zero-degree rotation object on the common path.
 */
function computeImageDrawArgs({ cellX, cellY, bleed, bleedWidth, bleedHeight, rotation }) {
  if (!Number.isFinite(cellX) || !Number.isFinite(cellY)) {
    throw new Error('computeImageDrawArgs: cellX and cellY must be finite numbers');
  }
  if (!Number.isFinite(bleed) || bleed < 0) {
    throw new Error(`computeImageDrawArgs: bleed must be non-negative (got ${bleed})`);
  }
  if (!Number.isFinite(bleedWidth) || bleedWidth <= 0 || !Number.isFinite(bleedHeight) || bleedHeight <= 0) {
    throw new Error(`computeImageDrawArgs: bleedWidth/bleedHeight must be positive (got ${bleedWidth} × ${bleedHeight})`);
  }
  if (rotation === 0) {
    return {
      x:      cellX - bleed,
      y:      cellY - bleed,
      width:  bleedWidth,
      height: bleedHeight,
    };
  }
  if (rotation === 90) {
    // See top-of-file derivation.
    return {
      x:        cellX - bleed + bleedWidth,
      y:        cellY - bleed,
      width:    bleedHeight,  // pre-rotation width
      height:   bleedWidth,   // pre-rotation height
      rotation: 90,           // caller wraps into pdf-lib's degrees() at draw time
    };
  }
  throw new Error(`computeImageDrawArgs: rotation must be 0 or 90 (got ${rotation})`);
}

// ── Effective DPI ────────────────────────────────────────────────────────

const DPI_WARN_THRESHOLD = 150;     // strictly BELOW this warns; 150 does not
const DPI_RECOMMENDED    = 300;

/**
 * effectiveDpi({pixelWidth, pixelHeight, stretchWidthPt, stretchHeightPt})
 *   → { dpiX, dpiY, worstAxis, worstDpi, belowThreshold }
 *
 * Computed against the STRETCHED size — the "effective" DPI the press
 * sees, not the DPI implied by the image file's own metadata. Rotation
 * is applied BEFORE this is called (caller passes stretch dims that
 * already reflect the rotated orientation), so no rotation math here.
 *
 * `worstAxis` picks the axis with the lower DPI — that's the one an
 * operator cares about, because a card that's 300 DPI horizontally
 * and 100 DPI vertically will still print jagged on the low axis.
 *
 * `belowThreshold` is true when worstDpi is STRICTLY BELOW
 * DPI_WARN_THRESHOLD (150). 150.0 exactly does NOT warn — that's a
 * common "just enough" case and warning on it would train operators
 * to ignore the message.
 */
function effectiveDpi({ pixelWidth, pixelHeight, stretchWidthPt, stretchHeightPt }) {
  if (!Number.isFinite(pixelWidth) || pixelWidth <= 0 ||
      !Number.isFinite(pixelHeight) || pixelHeight <= 0) {
    throw new Error(`effectiveDpi: pixelWidth/pixelHeight must be positive (got ${pixelWidth} × ${pixelHeight})`);
  }
  if (!Number.isFinite(stretchWidthPt) || stretchWidthPt <= 0 ||
      !Number.isFinite(stretchHeightPt) || stretchHeightPt <= 0) {
    throw new Error(`effectiveDpi: stretchWidthPt/stretchHeightPt must be positive`);
  }
  const stretchInchesW = stretchWidthPt  / 72;
  const stretchInchesH = stretchHeightPt / 72;
  const dpiX = pixelWidth  / stretchInchesW;
  const dpiY = pixelHeight / stretchInchesH;
  const worstAxis = dpiX <= dpiY ? 'x' : 'y';
  const worstDpi  = Math.min(dpiX, dpiY);
  return {
    dpiX,
    dpiY,
    worstAxis,
    worstDpi,
    belowThreshold: worstDpi < DPI_WARN_THRESHOLD,
  };
}

/**
 * The exact WARN wording the dispatch layer emits when effective DPI
 * falls below the threshold. Exported so tests can lock it without
 * threading a spy logger through the whole compose stack.
 */
function lowDpiWarnMessage({ filename, dpiX, dpiY, worstAxis }) {
  return (
    `Image '${filename}' effective DPI ${dpiX.toFixed(0)}×${dpiY.toFixed(0)} ` +
    `(worst axis: ${worstAxis}) is below the ${DPI_WARN_THRESHOLD} DPI recommended threshold ` +
    `(${DPI_RECOMMENDED} DPI recommended). The output will still print — supply higher-resolution ` +
    `artwork to improve quality.`
  );
}

module.exports = {
  sniffFormat,
  readImageDimensions,
  cmykRejectMessage,
  computeBleedBox,
  chooseRotation,
  computeImageDrawArgs,
  effectiveDpi,
  lowDpiWarnMessage,
  // Constants exposed for tests that want to lock the boundary.
  DPI_WARN_THRESHOLD,
  DPI_RECOMMENDED,
};
