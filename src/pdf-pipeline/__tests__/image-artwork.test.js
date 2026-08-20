/**
 * Unit tests for image-artwork — the pure module that turns JPEG/PNG
 * into the same geometry shape the PDF path already produces.
 *
 * Fixtures are built inline: JPEG SOF headers and PNG IHDR chunks are
 * short and deterministic, so we hand-construct minimal valid byte
 * sequences rather than shipping fixture files. Every expected value
 * is derived from the invariant in the test title — not from observed
 * output (the M7a discipline the whole imposition suite follows).
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const {
  sniffFormat,
  readImageDimensions,
  cmykRejectMessage,
  computeBleedBox,
  chooseRotation,
  computeImageDrawArgs,
  effectiveDpi,
  lowDpiWarnMessage,
  DPI_WARN_THRESHOLD,
  DPI_RECOMMENDED,
} = require(path.join(REPO, 'src', 'pdf-pipeline', 'image-artwork.js'));

// ─── Fixture builders ────────────────────────────────────────────────────
// Minimal-but-valid byte streams for the parser tests. Extension is not
// consulted anywhere in the module under test.

/**
 * Build a JPEG containing SOI + a single SOF0 segment carrying the
 * requested dimensions and component count + EOI. Not a decodable
 * JPEG (no DHT/DQT/SOS), but the SOF-scanner only cares about the
 * SOF marker's payload — perfect for exercising _readJpegSof without
 * depending on a full JPEG encoder.
 */
function makeJpegSof({ width, height, components, sofMarker = 0xC0 }) {
  // SOF payload: precision(1) + height(2) + width(2) + components(1)
  //   + per-component 3-byte descriptors. Length INCLUDES the length
  //   bytes but not the marker.
  const compDescr = [];
  for (let i = 0; i < components; i++) {
    compDescr.push(i + 1, 0x22, 0x00);   // id, sampling, qtable
  }
  const payload = [
    0x08,                        // precision
    (height >> 8) & 0xFF, height & 0xFF,
    (width  >> 8) & 0xFF, width  & 0xFF,
    components,
    ...compDescr,
  ];
  const segLen = 2 + payload.length;    // includes the 2 length bytes
  return Buffer.from([
    0xFF, 0xD8,                  // SOI
    0xFF, sofMarker,             // SOF marker
    (segLen >> 8) & 0xFF, segLen & 0xFF,
    ...payload,
    0xFF, 0xD9,                  // EOI
  ]);
}

/**
 * Build a PNG containing just the 8-byte signature and an IHDR chunk
 * with the requested dims. IHDR CRC is left as zeroes — _readPngIhdr
 * doesn't verify CRC, and adding one would drag in zlib for a test.
 */
function makePngIhdr({ width, height, colorType = 2, bitDepth = 8 }) {
  return Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,   // signature
    0x00, 0x00, 0x00, 0x0D,                             // chunk length = 13
    0x49, 0x48, 0x44, 0x52,                             // 'IHDR'
    (width  >>> 24) & 0xFF, (width  >>> 16) & 0xFF, (width  >>> 8) & 0xFF, width  & 0xFF,
    (height >>> 24) & 0xFF, (height >>> 16) & 0xFF, (height >>> 8) & 0xFF, height & 0xFF,
    bitDepth,
    colorType,
    0x00, 0x00, 0x00,           // compression, filter, interlace
    0x00, 0x00, 0x00, 0x00,     // CRC (not verified by reader)
  ]);
}

// ═════════════════════════════════════════════════════════════════════════
// sniffFormat — magic bytes only, extension not trusted
// ═════════════════════════════════════════════════════════════════════════

test('sniffFormat: JPEG magic → "jpeg"', () => {
  assert.equal(sniffFormat(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0])), 'jpeg');
});

test('sniffFormat: PNG magic → "png"', () => {
  assert.equal(sniffFormat(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), 'png');
});

test('sniffFormat: file that CLAIMS extension .jpg but is actually PNG is detected as PNG (extension not trusted)', () => {
  // Real-world: browser downloads that rename PNGs to .jpg. Extension
  // is not consulted; magic bytes decide.
  const pngBytes = makePngIhdr({ width: 100, height: 100 });
  assert.equal(sniffFormat(pngBytes), 'png');
});

test('sniffFormat: garbage / other formats → null', () => {
  assert.equal(sniffFormat(Buffer.from([0x00, 0x00, 0x00, 0x00])), null);
  assert.equal(sniffFormat(Buffer.from([0x42, 0x4D, 0x00, 0x00])), null);   // BMP magic
  assert.equal(sniffFormat(Buffer.from([])), null);
  assert.equal(sniffFormat(null), null);
  assert.equal(sniffFormat(undefined), null);
});

// ═════════════════════════════════════════════════════════════════════════
// JPEG SOF scan — dimensions + component count (RGB / CMYK / grayscale)
// ═════════════════════════════════════════════════════════════════════════

test('readImageDimensions: JPEG RGB (3 components) → dimensions + colorSpace "rgb"', () => {
  const bytes = makeJpegSof({ width: 1200, height: 800, components: 3 });
  const dims = readImageDimensions(bytes, 'jpeg');
  assert.equal(dims.width, 1200);
  assert.equal(dims.height, 800);
  assert.equal(dims.colorSpace, 'rgb');
});

test('readImageDimensions: JPEG grayscale (1 component) → colorSpace "grayscale"', () => {
  const bytes = makeJpegSof({ width: 100, height: 100, components: 1 });
  assert.equal(readImageDimensions(bytes, 'jpeg').colorSpace, 'grayscale');
});

test('readImageDimensions: JPEG CMYK/YCCK (4 components) → colorSpace "cmyk"', () => {
  // pdf-lib cannot embed CMYK JPEGs correctly; the dispatch layer
  // rejects on colorSpace === 'cmyk'.
  const bytes = makeJpegSof({ width: 500, height: 500, components: 4 });
  assert.equal(readImageDimensions(bytes, 'jpeg').colorSpace, 'cmyk');
});

test('readImageDimensions: JPEG SOF2 progressive marker also parses', () => {
  const bytes = makeJpegSof({ width: 640, height: 480, components: 3, sofMarker: 0xC2 });
  const dims = readImageDimensions(bytes, 'jpeg');
  assert.equal(dims.width, 640);
  assert.equal(dims.height, 480);
});

test('readImageDimensions: truncated JPEG (SOI but no SOF) throws operator-facing message', () => {
  assert.throws(
    () => readImageDimensions(Buffer.from([0xFF, 0xD8]), 'jpeg'),
    /Could not read JPEG dimensions/,
  );
});

test('readImageDimensions: PNG IHDR → dimensions + colorSpace "rgb"', () => {
  const bytes = makePngIhdr({ width: 2000, height: 1500 });
  const dims = readImageDimensions(bytes, 'png');
  assert.equal(dims.width, 2000);
  assert.equal(dims.height, 1500);
  assert.equal(dims.colorSpace, 'rgb');
});

test('readImageDimensions: truncated PNG throws operator-facing message', () => {
  assert.throws(
    () => readImageDimensions(Buffer.from([0x89, 0x50, 0x4E, 0x47]), 'png'),
    /Could not read PNG dimensions/,
  );
});

test('readImageDimensions: unsupported format throws', () => {
  assert.throws(
    () => readImageDimensions(Buffer.from([0, 1, 2, 3]), 'bmp'),
    /unsupported format/,
  );
});

// ═════════════════════════════════════════════════════════════════════════
// CMYK reject message — exact wording locked (operator sees it verbatim)
// ═════════════════════════════════════════════════════════════════════════

test('cmykRejectMessage: names the file and points at the fix', () => {
  const msg = cmykRejectMessage('photo.jpg');
  assert.match(msg, /Image 'photo\.jpg' is a CMYK JPEG which cannot be imposed/);
  assert.match(msg, /Re-export as RGB from the original artwork tool/);
  assert.match(msg, /Photoshop:.*RGB Color/);
});

// ═════════════════════════════════════════════════════════════════════════
// computeBleedBox — stretch target + synthetic trim
// ═════════════════════════════════════════════════════════════════════════

test('computeBleedBox: no bleed → syntheticTrim at (0,0), bleed box = trim exactly', () => {
  // trim 5×7 in (360×504 pt), bleed 0 → syntheticTrim at origin, no
  // outset. The bleed box IS the trim. Numeric values hand-computed.
  const b = computeBleedBox({ trimWidth: 360, trimHeight: 504, artworkBleed: 0 });
  assert.equal(b.bleed, 0);
  assert.equal(b.bleedWidth, 360);
  assert.equal(b.bleedHeight, 504);
  assert.deepEqual(b.syntheticTrim, { x: 0, y: 0, width: 360, height: 504 });
});

test('computeBleedBox: 9 pt bleed → syntheticTrim inset by 9, bleed box = trim + 18 in each axis', () => {
  // Hand-computed: 360 + 2×9 = 378; 504 + 2×9 = 522.
  const b = computeBleedBox({ trimWidth: 360, trimHeight: 504, artworkBleed: 9 });
  assert.equal(b.bleed, 9);
  assert.equal(b.bleedWidth, 378);
  assert.equal(b.bleedHeight, 522);
  assert.deepEqual(b.syntheticTrim, { x: 9, y: 9, width: 360, height: 504 });
});

test('computeBleedBox: rejects non-positive trim dims', () => {
  assert.throws(() => computeBleedBox({ trimWidth: 0,   trimHeight: 100, artworkBleed: 0 }), /trimWidth/);
  assert.throws(() => computeBleedBox({ trimWidth: 100, trimHeight: -1,  artworkBleed: 0 }), /trimHeight/);
});

test('computeBleedBox: coerces non-finite or negative bleed to 0', () => {
  // Defensive against hand-edited templates. A negative bleed can't
  // "un-stretch" — coerce to 0 rather than throw.
  const bNeg  = computeBleedBox({ trimWidth: 100, trimHeight: 100, artworkBleed: -5 });
  const bNaN  = computeBleedBox({ trimWidth: 100, trimHeight: 100, artworkBleed: NaN });
  const bMiss = computeBleedBox({ trimWidth: 100, trimHeight: 100 });
  for (const b of [bNeg, bNaN, bMiss]) {
    assert.equal(b.bleed, 0);
    assert.equal(b.bleedWidth, 100);
    assert.equal(b.bleedHeight, 100);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// chooseRotation — orientation matching, square = no rotation
// ═════════════════════════════════════════════════════════════════════════

test('chooseRotation: landscape image on landscape cell → 0', () => {
  assert.equal(chooseRotation(1000, 500, 800, 400), 0);
});

test('chooseRotation: portrait image on portrait cell → 0', () => {
  assert.equal(chooseRotation(500, 1000, 400, 800), 0);
});

test('chooseRotation: landscape image on portrait cell → 90 (aspect mismatch, rotate to reduce distortion)', () => {
  assert.equal(chooseRotation(1000, 500, 400, 800), 90);
});

test('chooseRotation: portrait image on landscape cell → 90', () => {
  assert.equal(chooseRotation(500, 1000, 800, 400), 90);
});

test('chooseRotation: square image → 0 (rotating doesn\'t help)', () => {
  assert.equal(chooseRotation(500, 500, 800, 400), 0);
});

test('chooseRotation: square cell → 0', () => {
  assert.equal(chooseRotation(1000, 500, 500, 500), 0);
});

// ═════════════════════════════════════════════════════════════════════════
// computeImageDrawArgs — the pdf-lib drawImage args, both rotations
//
// Hand-computed corner geometry from the top-of-file derivation. If the
// rotation formula regresses, the exact corner coords in the rotated
// test fail — a sign error can't sneak past.
// ═════════════════════════════════════════════════════════════════════════

test('computeImageDrawArgs: rotation=0, no bleed → args land the image lower-left at the cell', () => {
  // Cell at (100, 200), bleed box = 360×504 (== trim). Draw args:
  //   x = 100 − 0 = 100
  //   y = 200 − 0 = 200
  //   width = 360, height = 504
  //   no rotation key on the return
  const args = computeImageDrawArgs({
    cellX: 100, cellY: 200, bleed: 0, bleedWidth: 360, bleedHeight: 504, rotation: 0,
  });
  assert.deepEqual(args, { x: 100, y: 200, width: 360, height: 504 });
  assert.equal(args.rotation, undefined, 'no rotation key on unrotated path');
});

test('computeImageDrawArgs: rotation=0, 9 pt bleed → args back-offset by bleed so the trim (not media) lands on the cell', () => {
  // Cell at (100, 200), bleed 9, bleed box 378×522. The bleed box
  // extends 9 pt outside the cell on each side, so its LL is at
  // (100−9, 200−9) = (91, 191).
  const args = computeImageDrawArgs({
    cellX: 100, cellY: 200, bleed: 9, bleedWidth: 378, bleedHeight: 522, rotation: 0,
  });
  assert.deepEqual(args, { x: 91, y: 191, width: 378, height: 522 });
});

test('computeImageDrawArgs: rotation=90 → hand-derived corners land the bleed box exactly on the cell', () => {
  // Cell at (100, 200), bleed 9, bleed box 378×522.
  // Rotation formula (from the top-of-file derivation):
  //   x = cellX − bleed + bleedWidth  = 100 − 9 + 378 = 469
  //   y = cellY − bleed               = 200 − 9        = 191
  //   pre-rotation width  = bleedHeight = 522
  //   pre-rotation height = bleedWidth  = 378
  const args = computeImageDrawArgs({
    cellX: 100, cellY: 200, bleed: 9, bleedWidth: 378, bleedHeight: 522, rotation: 90,
  });
  assert.equal(args.x, 469);
  assert.equal(args.y, 191);
  assert.equal(args.width, 522);
  assert.equal(args.height, 378);
  assert.equal(args.rotation, 90);

  // The corner-coord post-condition: after pdf-lib rotates the pre-
  // rotation rectangle by 90° CCW around origin and translates by
  // (x, y), the four corners land at these positions. Hand-derived:
  //   pre-rot LL (0, 0)     → rotated (0, 0)         → translated (469, 191)
  //   pre-rot LR (522, 0)   → rotated (0, 522)       → translated (469, 713)
  //   pre-rot UL (0, 378)   → rotated (-378, 0)      → translated ( 91, 191)
  //   pre-rot UR (522, 378) → rotated (-378, 522)    → translated ( 91, 713)
  // Bounding box: x ∈ [91, 469]; y ∈ [191, 713]. Width 378, height 522.
  // That's exactly the bleed box — LL at (100−9, 200−9), size 378×522. ✓
  const w = args.width, h = args.height;
  const cornersPre = [
    { X: 0,        Y: 0 },
    { X: w,        Y: 0 },
    { X: 0,        Y: h },
    { X: w,        Y: h },
  ];
  const cornersOut = cornersPre.map(({ X, Y }) => ({
    // 90° CCW around origin: (X, Y) → (-Y, X); then translate.
    x: args.x + (-Y),
    y: args.y + X,
  }));
  const xs = cornersOut.map(c => c.x);
  const ys = cornersOut.map(c => c.y);
  assert.equal(Math.min(...xs), 91,  'bleed box LL.x');
  assert.equal(Math.max(...xs), 469, 'bleed box UR.x');
  assert.equal(Math.min(...ys), 191, 'bleed box LL.y');
  assert.equal(Math.max(...ys), 713, 'bleed box UR.y');
});

test('computeImageDrawArgs: rejects rotation values other than 0/90', () => {
  assert.throws(
    () => computeImageDrawArgs({
      cellX: 0, cellY: 0, bleed: 0, bleedWidth: 100, bleedHeight: 100, rotation: 180,
    }),
    /rotation must be 0 or 90/,
  );
});

// ═════════════════════════════════════════════════════════════════════════
// effectiveDpi — worst-axis wins; 149 warns, 150 does NOT (the boundary
// case that keeps the WARN meaningful)
// ═════════════════════════════════════════════════════════════════════════

test('effectiveDpi: 300 dpi on both axes → belowThreshold false', () => {
  // 1500 px stretched over 5 in = 300 dpi per axis. Stretch length in
  // points: 5 × 72 = 360.
  const r = effectiveDpi({ pixelWidth: 1500, pixelHeight: 2100, stretchWidthPt: 360, stretchHeightPt: 504 });
  assert.equal(r.dpiX, 300);
  assert.equal(r.dpiY, 300);
  assert.equal(r.belowThreshold, false);
});

test('effectiveDpi: 150 dpi exactly on the worst axis → belowThreshold FALSE (boundary not warned)', () => {
  // Locks the ">= 150 doesn't warn" rule. 150 is "just enough" and a
  // warning there would train operators to ignore the message.
  //   pxW = 750, stretchW = 5 in (360 pt) → 750 / 5 = 150 dpi
  //   pxH = 1050, stretchH = 7 in (504 pt) → 1050 / 7 = 150 dpi
  const r = effectiveDpi({ pixelWidth: 750, pixelHeight: 1050, stretchWidthPt: 360, stretchHeightPt: 504 });
  assert.equal(r.dpiX, 150);
  assert.equal(r.dpiY, 150);
  assert.equal(r.belowThreshold, false);
});

test('effectiveDpi: 149 dpi on either axis → belowThreshold TRUE', () => {
  // Slightly under 150. Worst axis is whichever is lower; the WARN
  // fires. Fixture: X = 745 / 5 = 149, Y = 1050 / 7 = 150 → worst = X.
  const r = effectiveDpi({ pixelWidth: 745, pixelHeight: 1050, stretchWidthPt: 360, stretchHeightPt: 504 });
  assert.equal(r.dpiX, 149);
  assert.equal(r.dpiY, 150);
  assert.equal(r.worstAxis, 'x');
  assert.equal(r.worstDpi, 149);
  assert.equal(r.belowThreshold, true);
});

test('effectiveDpi: worstAxis picks the LOWER of the two — locks that 300×100 doesn\'t look like 200 average', () => {
  // px 1500 × 500 stretched to 360 × 504 pt (5×7 in).
  //   dpiX = 1500 / 5   = 300
  //   dpiY =  500 / 7   ≈  71.43  → worst
  const r = effectiveDpi({ pixelWidth: 1500, pixelHeight: 500, stretchWidthPt: 360, stretchHeightPt: 504 });
  assert.equal(r.dpiX, 300);
  assert.equal(r.worstAxis, 'y');
  assert.ok(r.worstDpi < DPI_WARN_THRESHOLD);
  assert.equal(r.belowThreshold, true);
});

test('effectiveDpi: constants — WARN at 150, RECOMMENDED at 300', () => {
  assert.equal(DPI_WARN_THRESHOLD, 150);
  assert.equal(DPI_RECOMMENDED,    300);
});

test('lowDpiWarnMessage: exact wording locked (operator sees it verbatim in logs)', () => {
  const msg = lowDpiWarnMessage({ filename: 'photo.jpg', dpiX: 149, dpiY: 150, worstAxis: 'x' });
  assert.match(msg, /Image 'photo\.jpg' effective DPI 149×150/);
  assert.match(msg, /worst axis: x/);
  assert.match(msg, /below the 150 DPI recommended threshold/);
  assert.match(msg, /300 DPI recommended/);
  assert.match(msg, /output will still print/);
});
