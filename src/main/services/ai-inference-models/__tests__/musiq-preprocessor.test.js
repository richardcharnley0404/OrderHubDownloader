/**
 * Unit tests for the two bug-risk units in musiq-preprocessor.js:
 *   - extract_32x32_patches (custom row-major patch extraction with SAME pad)
 *   - hashed_spatial_pos_emb_indexes (TF NN-resize emulation)
 *
 * Run with the Node built-in test runner:
 *   node --test src/main/services/ai-inference-models/__tests__/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  extract_32x32_patches,
  hashed_spatial_pos_emb_indexes,
  PATCH_SIZE,
  PATCH_PIXEL_COUNT,
  HSE_GRID_SIZE,
} = require('../musiq-preprocessor');


// =============================================================================
// extract_32x32_patches
// =============================================================================

/**
 * Build a synthetic RGB float32 buffer with each pixel set to a constant
 * (r, g, b) per quadrant. Layout matches sharp's raw output: row-major,
 * channels innermost.
 */
function buildQuadrantImage(size, colors) {
  // colors: { tl, tr, bl, br } each [r, g, b] in [0, 255]
  const buf = new Float32Array(size * size * 3);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const off = (y * size + x) * 3;
      let c;
      if (y < half && x < half) c = colors.tl;
      else if (y < half && x >= half) c = colors.tr;
      else if (y >= half && x < half) c = colors.bl;
      else c = colors.br;
      buf[off]     = c[0];
      buf[off + 1] = c[1];
      buf[off + 2] = c[2];
    }
  }
  return buf;
}


test('extract_32x32_patches: 64x64 image with 4 colored quadrants -> 4 patches in row-major order', () => {
  const RED   = [255, 0, 0];
  const GREEN = [0, 255, 0];
  const BLUE  = [0, 0, 255];
  const BLACK = [0, 0, 0];

  const img = buildQuadrantImage(64, { tl: RED, tr: GREEN, bl: BLUE, br: BLACK });
  const { patches, count_h, count_w } = extract_32x32_patches(img, 64, 64);

  assert.equal(count_h, 2);
  assert.equal(count_w, 2);
  assert.equal(patches.length, 4 * PATCH_PIXEL_COUNT);

  // Patch row-major order: [0]=(0,0)=TL=red, [1]=(0,1)=TR=green,
  //                        [2]=(1,0)=BL=blue, [3]=(1,1)=BR=black
  const expected = [RED, GREEN, BLUE, BLACK];
  for (let p = 0; p < 4; p++) {
    const off = p * PATCH_PIXEL_COUNT;
    const [er, eg, eb] = expected[p];
    for (let i = 0; i < PATCH_SIZE * PATCH_SIZE; i++) {
      assert.equal(patches[off + i * 3],     er, `patch ${p} pixel ${i} R`);
      assert.equal(patches[off + i * 3 + 1], eg, `patch ${p} pixel ${i} G`);
      assert.equal(patches[off + i * 3 + 2], eb, `patch ${p} pixel ${i} B`);
    }
  }
});


test('extract_32x32_patches: within-patch layout is row-major spatial, channels innermost', () => {
  // A 32x32 image with each pixel given a uniquely-identifiable value:
  //   R = y, G = x, B = 0 for pixel at (y, x).
  const buf = new Float32Array(32 * 32 * 3);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const off = (y * 32 + x) * 3;
      buf[off]     = y;
      buf[off + 1] = x;
      buf[off + 2] = 0;
    }
  }

  const { patches, count_h, count_w } = extract_32x32_patches(buf, 32, 32);

  assert.equal(count_h, 1);
  assert.equal(count_w, 1);

  // Within-patch index for pixel (dy, dx) channel c:
  //   off = (dy * 32 + dx) * 3 + c
  for (let dy = 0; dy < 32; dy++) {
    for (let dx = 0; dx < 32; dx++) {
      const off = (dy * 32 + dx) * 3;
      assert.equal(patches[off],     dy, `pixel (${dy},${dx}) R should be y=${dy}`);
      assert.equal(patches[off + 1], dx, `pixel (${dy},${dx}) G should be x=${dx}`);
      assert.equal(patches[off + 2], 0,  `pixel (${dy},${dx}) B should be 0`);
    }
  }
});


test('extract_32x32_patches: SAME-padding behaviour for non-divisible dimensions (TF semantics)', () => {
  // 33x33 image filled with 7.0. ceil(33/32) = 2 -> 2x2 patch grid (4 patches).
  // TF's SAME-padding semantics:
  //   total_pad = 2*32 - 33 = 31
  //   pad_top = floor(31/2) = 15  pad_bottom = 16
  //   pad_left = 15               pad_right = 16
  // So image[r, c] appears in the padded layout at row r+15, col c+15.
  //
  // For a 32x32 patch starting at padded (0, 0):  covers padded rows 0..31,
  // cols 0..31. Image content (rows 0..16, cols 0..16) lives at padded
  // rows 15..31, cols 15..31 — the BOTTOM-RIGHT 17x17 of the patch.
  //
  // For patch (0, 1) at padded (0, 32): covers padded cols 32..63 = image
  // cols 17..48. Only image cols 17..32 (16 cols) are real; cols 33..48
  // are right-pad (zero). Image rows still need 15 top-pad rows.
  //
  // This is what we verify here, byte-exactly to TF's tf.image.extract_patches.
  const buf = new Float32Array(33 * 33 * 3).fill(7.0);
  const { patches, count_h, count_w } = extract_32x32_patches(buf, 33, 33);

  assert.equal(count_h, 2);
  assert.equal(count_w, 2);

  // Helper: read R-channel value at patch[p] pixel (dy, dx).
  const getR = (p, dy, dx) =>
    patches[p * PATCH_PIXEL_COUNT + (dy * PATCH_SIZE + dx) * 3];

  // Patch (0, 0): bottom-right 17x17 (dy>=15, dx>=15) is image content (=7).
  // Top 15 rows and left 15 cols are zero pad.
  for (let dy = 0; dy < 32; dy++) {
    for (let dx = 0; dx < 32; dx++) {
      const expected = (dy >= 15 && dx >= 15) ? 7.0 : 0.0;
      assert.equal(
        getR(0, dy, dx),
        expected,
        `patch (0,0) pix(${dy},${dx}): expected ${expected} got ${getR(0, dy, dx)}`
      );
    }
  }

  // Patch (0, 1): patch covers padded cols 32..63 = image cols 17..48 (with
  // pad_right offsetting). Only image cols 17..32 (16 cols) are real, sitting
  // at patch dx 0..15. Top 15 rows still pad; bottom 17 rows are real for
  // those 16 cols.
  for (let dy = 0; dy < 32; dy++) {
    for (let dx = 0; dx < 32; dx++) {
      const expected = (dy >= 15 && dx <= 15) ? 7.0 : 0.0;
      assert.equal(
        getR(1, dy, dx),
        expected,
        `patch (0,1) pix(${dy},${dx}): expected ${expected} got ${getR(1, dy, dx)}`
      );
    }
  }

  // Patch (1, 0): symmetric to (0, 1), but for the height axis instead.
  // Image rows 17..32 sit at patch dy 0..15. Left 15 cols are pad.
  for (let dy = 0; dy < 32; dy++) {
    for (let dx = 0; dx < 32; dx++) {
      const expected = (dy <= 15 && dx >= 15) ? 7.0 : 0.0;
      assert.equal(
        getR(2, dy, dx),
        expected,
        `patch (1,0) pix(${dy},${dx}): expected ${expected} got ${getR(2, dy, dx)}`
      );
    }
  }

  // Patch (1, 1): top-left 16x16 (dy<=15, dx<=15) is image content (image
  // rows 17..32, cols 17..32). Bottom-right is bottom/right pad.
  for (let dy = 0; dy < 32; dy++) {
    for (let dx = 0; dx < 32; dx++) {
      const expected = (dy <= 15 && dx <= 15) ? 7.0 : 0.0;
      assert.equal(
        getR(3, dy, dx),
        expected,
        `patch (1,1) pix(${dy},${dx}): expected ${expected} got ${getR(3, dy, dx)}`
      );
    }
  }
});


// =============================================================================
// hashed_spatial_pos_emb_indexes
// =============================================================================

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'hash_indexes.json');
const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));


for (const [name, fx] of Object.entries(fixtures)) {
  test(`hashed_spatial_pos_emb_indexes: byte-exact match TF reference [${name}]`, () => {
    const result = hashed_spatial_pos_emb_indexes(fx.count_h, fx.count_w, fx.grid_size);
    assert.equal(
      result.length,
      fx.expected.length,
      `length: got ${result.length}, expected ${fx.expected.length}`
    );
    for (let i = 0; i < fx.expected.length; i++) {
      assert.equal(
        result[i],
        fx.expected[i],
        `${name} index ${i}: got ${result[i]}, expected ${fx.expected[i]}`
      );
    }
  });
}


test('hashed_spatial_pos_emb_indexes: identity mapping for grid==count', () => {
  // count_h = count_w = grid_size = 10 -> indexes are [0, 1, ..., 99]
  const result = hashed_spatial_pos_emb_indexes(10, 10, 10);
  for (let i = 0; i < 100; i++) {
    assert.equal(result[i], i);
  }
});


test('hashed_spatial_pos_emb_indexes: row-major output order', () => {
  // count_h=2, count_w=3, grid_size=10
  //   h_hash[0] = floor(0*10/2) = 0
  //   h_hash[1] = floor(1*10/2) = 5
  //   w_hash[0] = floor(0*10/3) = 0
  //   w_hash[1] = floor(1*10/3) = 3
  //   w_hash[2] = floor(2*10/3) = 6
  //   indexes = [0*10+0, 0*10+3, 0*10+6, 5*10+0, 5*10+3, 5*10+6] = [0, 3, 6, 50, 53, 56]
  const result = hashed_spatial_pos_emb_indexes(2, 3, 10);
  assert.deepEqual(Array.from(result), [0, 3, 6, 50, 53, 56]);
});
