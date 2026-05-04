/**
 * Unit tests for realesrgan-preprocessor.js — tile geometry and stitching.
 *
 * Covered (per implementation plan §3, "New files"):
 *   - tile counts for various source sizes
 *   - edge tiles (right/bottom partial coverage; sub-tile sources)
 *   - no seam artefacts at overlap boundaries
 *   - output dimensions exactly 4× input
 *
 * Run with the Node built-in test runner:
 *   node --test src/main/services/ai-inference-models/__tests__/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TILE_SIZE,
  DEFAULT_TILE_OVERLAP,
  DEFAULT_SCALE,
  plan1D,
  planTiles,
  extractTile,
  Stitcher,
  _internal: { computeAxisFeather, clampRoundU8 },
} = require('../realesrgan-preprocessor');


// =============================================================================
// plan1D — single axis tile origins
// =============================================================================

test('plan1D: single tile when source <= tileSize', () => {
  assert.deepEqual(plan1D(256, 256, 16), [{ src: 0, len: 256 }]);
  assert.deepEqual(plan1D(200, 256, 16), [{ src: 0, len: 200 }]);
  assert.deepEqual(plan1D(1, 256, 16),   [{ src: 0, len: 1 }]);
});

test('plan1D: 257 → 2 tiles, last shifted to 1', () => {
  // Just-over-tileSize edge case.
  assert.deepEqual(plan1D(257, 256, 16), [
    { src: 0, len: 256 },
    { src: 1, len: 256 },
  ]);
});

test('plan1D: 4000 / 256 / 16 → 17 tiles, last shifted to 3744', () => {
  // Matches bench-tile-latency.js projection.
  const r = plan1D(4000, 256, 16);
  assert.equal(r.length, 17);
  assert.equal(r[0].src, 0);
  assert.equal(r[15].src, 3600);   // 15 * 240
  assert.equal(r[16].src, 3744);   // 4000 - 256
});

test('plan1D: 3000 / 256 / 16 → 13 tiles, no coverage gap', () => {
  const r = plan1D(3000, 256, 16);
  assert.equal(r.length, 13);
  // Verify every byte of the source [0, srcDim) is covered by at least one tile.
  const covered = new Uint8Array(3000);
  for (const t of r) {
    for (let x = t.src; x < t.src + t.len; x++) covered[x] = 1;
  }
  assert.equal(covered.indexOf(0), -1, 'every source pixel must be covered');
});

test('plan1D: every adjacent pair overlaps by >= overlap on a 12 MP-like axis', () => {
  const r = plan1D(4000, 256, 16);
  for (let i = 1; i < r.length; i++) {
    const prevEnd = r[i - 1].src + r[i - 1].len;   // exclusive right edge
    const overlap = prevEnd - r[i].src;
    assert.ok(overlap >= 16, `tile ${i - 1}/${i} overlap ${overlap} < 16`);
    assert.ok(r[i].src > r[i - 1].src, 'origins must be strictly increasing');
  }
});

test('plan1D: rejects bad inputs', () => {
  assert.throws(() => plan1D(0, 256, 16), /srcDim must be positive/);
  assert.throws(() => plan1D(100, 0, 16), /tileSize must be positive/);
  assert.throws(() => plan1D(100, 256, -1), /overlap must be >= 0/);
  assert.throws(() => plan1D(100, 256, 256), /overlap.*must be <.*tileSize/);
  assert.throws(() => plan1D(100, 256, 300), /overlap.*must be <.*tileSize/);
});

test('plan1D: zero overlap collapses to non-overlapping tiles when source is multiple of tileSize', () => {
  // Special case: srcDim multiple of tileSize, overlap=0 → exact tiling.
  const r = plan1D(1024, 256, 0);
  assert.deepEqual(r.map((t) => t.src), [0, 256, 512, 768]);
});


// =============================================================================
// planTiles — full 2D plan
// =============================================================================

test('planTiles: defaults match plan §0 product decisions', () => {
  assert.equal(DEFAULT_TILE_SIZE, 256);
  assert.equal(DEFAULT_TILE_OVERLAP, 16);
  assert.equal(DEFAULT_SCALE, 4);
});

test('planTiles: 12 MP source → 17 × 13 = 221 tiles (matches bench)', () => {
  const plan = planTiles(4000, 3000);
  assert.equal(plan.tilesX, 17);
  assert.equal(plan.tilesY, 13);
  assert.equal(plan.tiles.length, 221);
  assert.equal(plan.scaledW, 16000);
  assert.equal(plan.scaledH, 12000);
  assert.equal(plan.featherPx, 64);
});

test('planTiles: tile under-tileSize source → single partial tile', () => {
  const plan = planTiles(200, 200);
  assert.equal(plan.tilesX, 1);
  assert.equal(plan.tilesY, 1);
  assert.equal(plan.tiles.length, 1);
  const t = plan.tiles[0];
  assert.equal(t.w, 200);
  assert.equal(t.h, 200);
  assert.equal(t.scaledW, 800);
  assert.equal(t.scaledH, 800);
  assert.equal(plan.scaledW, 800);
  assert.equal(plan.scaledH, 800);
  assert.deepEqual(t.neighbors, { left: false, top: false, right: false, bottom: false });
});

test('planTiles: extreme panorama (6000×800) → rectangular grid handled', () => {
  const plan = planTiles(6000, 800);
  // 6000 with stride 240: ceil((6000-256)/240)+1 = 25 + 1? Let's compute via plan1D.
  const xs = plan1D(6000, 256, 16);
  const ys = plan1D(800, 256, 16);
  assert.equal(plan.tilesX, xs.length);
  assert.equal(plan.tilesY, ys.length);
  assert.ok(plan.tilesX > plan.tilesY, 'panorama: more tiles in X than Y');
  assert.equal(plan.scaledW, 24000);
  assert.equal(plan.scaledH, 3200);
});

test('planTiles: corner tiles have correct neighbour flags', () => {
  const plan = planTiles(1024, 768);
  const grid = {};
  for (const t of plan.tiles) grid[`${t.ix},${t.iy}`] = t;

  const tl = grid['0,0'];
  const tr = grid[`${plan.tilesX - 1},0`];
  const bl = grid[`0,${plan.tilesY - 1}`];
  const br = grid[`${plan.tilesX - 1},${plan.tilesY - 1}`];

  assert.deepEqual(tl.neighbors, { left: false, top: false, right: true,  bottom: true  });
  assert.deepEqual(tr.neighbors, { left: true,  top: false, right: false, bottom: true  });
  assert.deepEqual(bl.neighbors, { left: false, top: true,  right: true,  bottom: false });
  assert.deepEqual(br.neighbors, { left: true,  top: true,  right: false, bottom: false });
});

test('planTiles: every output pixel of the canvas is covered by at least one tile', () => {
  // Coverage check on a moderately sized source: 800×600 → 3200×2400 canvas.
  const plan = planTiles(800, 600);
  const cov = new Uint8Array(plan.scaledW * plan.scaledH);
  for (const t of plan.tiles) {
    for (let dy = 0; dy < t.scaledH; dy++) {
      for (let dx = 0; dx < t.scaledW; dx++) {
        cov[(t.dstSy + dy) * plan.scaledW + (t.dstSx + dx)] = 1;
      }
    }
  }
  const uncovered = cov.indexOf(0);
  assert.equal(uncovered, -1, `pixel index ${uncovered} not covered by any tile`);
});

test('planTiles: dstSx/dstSy and scaledW/scaledH are exactly 4× src', () => {
  const plan = planTiles(1234, 567, { tileSize: 256, tileOverlap: 16, scale: 4 });
  for (const t of plan.tiles) {
    assert.equal(t.dstSx, t.srcX * 4);
    assert.equal(t.dstSy, t.srcY * 4);
    assert.equal(t.scaledW, t.w * 4);
    assert.equal(t.scaledH, t.h * 4);
  }
  assert.equal(plan.scaledW, 1234 * 4);
  assert.equal(plan.scaledH, 567 * 4);
});


// =============================================================================
// extractTile — bytes copied correctly
// =============================================================================

test('extractTile: copies the right HWC region', () => {
  // Build a 4×3 image where each pixel's R = x, G = y, B = 0 (uint8 fits 0-255).
  const W = 4, H = 3;
  const buf = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      buf[i]     = x;
      buf[i + 1] = y;
      buf[i + 2] = 0;
    }
  }

  const tile = { srcX: 1, srcY: 1, w: 2, h: 2 };
  const t = extractTile(buf, W, H, tile);
  assert.equal(t.length, 2 * 2 * 3);
  // Top-left of tile = (1,1) in source: R=1, G=1, B=0
  assert.equal(t[0], 1); assert.equal(t[1], 1); assert.equal(t[2], 0);
  // Top-right of tile = (2,1): R=2, G=1, B=0
  assert.equal(t[3], 2); assert.equal(t[4], 1); assert.equal(t[5], 0);
  // Bottom-left of tile = (1,2): R=1, G=2, B=0
  assert.equal(t[6], 1); assert.equal(t[7], 2); assert.equal(t[8], 0);
  // Bottom-right of tile = (2,2): R=2, G=2, B=0
  assert.equal(t[9], 2); assert.equal(t[10], 2); assert.equal(t[11], 0);
});

test('extractTile: rejects out-of-bounds tiles', () => {
  const buf = new Uint8Array(10 * 10 * 3);
  assert.throws(() => extractTile(buf, 10, 10, { srcX: 5, srcY: 5, w: 10, h: 10 }), /out of source bounds/);
  assert.throws(() => extractTile(buf, 10, 10, { srcX: -1, srcY: 0, w: 5, h: 5 }), /out of source bounds/);
});

test('extractTile: rejects buffer of wrong length', () => {
  const buf = new Uint8Array(99);
  assert.throws(() => extractTile(buf, 10, 10, { srcX: 0, srcY: 0, w: 5, h: 5 }), /source buffer length/);
});


// =============================================================================
// computeAxisFeather — weight ramps
// =============================================================================

test('computeAxisFeather: no neighbours → weight 1.0 everywhere', () => {
  const w = computeAxisFeather(20, 4, false, false);
  for (const v of w) assert.equal(v, 1.0);
});

test('computeAxisFeather: left neighbour ramps from 1/(2F) at x=0 to 1.0 at x=F', () => {
  const F = 8;
  const w = computeAxisFeather(20, F, true, false);
  // Linear ramp on the left half of the band.
  assert.ok(w[0] > 0 && w[0] < 1, `w[0]=${w[0]} should be small but >0`);
  assert.ok(w[F - 1] < 1, `w[F-1]=${w[F - 1]} should still be < 1`);
  assert.equal(w[F], 1.0);
  assert.equal(w[19], 1.0);
});

test('computeAxisFeather: both neighbours → minimum of two ramps, peak = 1.0 in middle', () => {
  const F = 4;
  const len = 20;
  const w = computeAxisFeather(len, F, true, true);
  assert.equal(w[len / 2], 1.0);
  assert.ok(w[0] < 0.5);
  assert.ok(w[len - 1] < 0.5);
  // Symmetric.
  for (let i = 0; i < len / 2; i++) {
    assert.ok(Math.abs(w[i] - w[len - 1 - i]) < 1e-6, `asymmetry at i=${i}`);
  }
});


// =============================================================================
// Stitcher — no seams when tiles agree
// =============================================================================

/**
 * Build a synthetic CHW float32 tile of given dims, all values = `value`.
 */
function constantTile(w, h, value) {
  const buf = new Float32Array(w * h * 3);
  buf.fill(value);
  return buf;
}

test('Stitcher: constant-value tiles stitch to constant canvas (no seams)', () => {
  // 2×2 tile grid covering 512×384 source → 2048×1536 canvas. All tiles
  // emit the same constant value; the stitched output must be uniform.
  const plan = planTiles(512, 384);
  assert.ok(plan.tiles.length >= 4, 'need a multi-tile plan to test seams');

  const stitcher = new Stitcher(plan.scaledW, plan.scaledH, plan.featherPx);
  const VALUE = 0.4;  // → uint8 102
  for (const t of plan.tiles) {
    const data = constantTile(t.scaledW, t.scaledH, VALUE);
    stitcher.addTile(data, t);
  }
  const out = stitcher.finalise();
  assert.equal(out.length, plan.scaledW * plan.scaledH * 3);

  // Every output byte should be Math.round(0.4 * 255) = 102.
  // Allow 1-step tolerance for float division noise in feather regions.
  let mismatch = 0;
  let maxStep = 0;
  for (let i = 0; i < out.length; i++) {
    const d = Math.abs(out[i] - 102);
    if (d > 0) { mismatch++; if (d > maxStep) maxStep = d; }
  }
  // The constant should be exact almost everywhere; allow tiny float-noise tolerance.
  assert.ok(maxStep <= 1, `max byte deviation ${maxStep} > 1 (uniform constant blew up)`);
  // Vast majority of pixels should be exact.
  const totalPx = plan.scaledW * plan.scaledH * 3;
  assert.ok(mismatch / totalPx < 0.02, `mismatch ratio ${mismatch}/${totalPx} too high`);
});

test('Stitcher: per-pixel accumulated weight is positive everywhere on the canvas', () => {
  // After adding all tiles for a multi-tile plan, no pixel should be
  // unweighted (else finalise would emit black pixels).
  const plan = planTiles(800, 600);
  const stitcher = new Stitcher(plan.scaledW, plan.scaledH, plan.featherPx);
  for (const t of plan.tiles) {
    const data = constantTile(t.scaledW, t.scaledH, 0.5);
    stitcher.addTile(data, t);
  }
  const W = plan.scaledW, H = plan.scaledH;
  // Sample every 64th pixel for speed; full canvas is 9.2 M pixels.
  for (let y = 0; y < H; y += 64) {
    for (let x = 0; x < W; x += 64) {
      assert.ok(stitcher.weight[y * W + x] > 0, `unweighted pixel at (${x},${y})`);
    }
  }
});

test('Stitcher: gradient tiles (R = lx within tile) stitch to a smooth canvas-wide gradient', () => {
  // Stronger seam test: each tile emits a gradient based on its position
  // in the canvas (not the local tile) — adjacent tiles' overlap regions
  // should agree, so blending must produce no banding.
  const plan = planTiles(800, 600);
  const stitcher = new Stitcher(plan.scaledW, plan.scaledH, plan.featherPx);

  const W = plan.scaledW;
  const H = plan.scaledH;

  for (const t of plan.tiles) {
    const tw = t.scaledW;
    const th = t.scaledH;
    const buf = new Float32Array(tw * th * 3);
    const plane = tw * th;
    for (let ly = 0; ly < th; ly++) {
      for (let lx = 0; lx < tw; lx++) {
        const cx = t.dstSx + lx;
        const cy = t.dstSy + ly;
        const idx = ly * tw + lx;
        // R varies with canvas X, G with canvas Y, B constant — so adjacent
        // tiles agree on the overlap region.
        buf[idx]             = cx / W;            // R
        buf[idx + plane]     = cy / H;            // G
        buf[idx + 2 * plane] = 0.5;               // B
      }
    }
    stitcher.addTile(buf, t);
  }
  const out = stitcher.finalise();

  // Spot-check: along a vertical line down the canvas centre, R should be
  // nearly constant (matches W/2). Along a horizontal line at canvas centre,
  // G should be nearly constant. No tile boundary should produce a step
  // greater than 1 byte.
  const cx = Math.floor(W / 2);
  const expectedR = clampRoundU8(cx / W * 255);
  let maxRdiff = 0;
  for (let y = 0; y < H; y++) {
    const r = out[(y * W + cx) * 3];
    const d = Math.abs(r - expectedR);
    if (d > maxRdiff) maxRdiff = d;
  }
  assert.ok(maxRdiff <= 1, `R column drift ${maxRdiff} > 1 — seams in gradient`);

  const cy = Math.floor(H / 2);
  const expectedG = clampRoundU8(cy / H * 255);
  let maxGdiff = 0;
  for (let x = 0; x < W; x++) {
    const g = out[(cy * W + x) * 3 + 1];
    const d = Math.abs(g - expectedG);
    if (d > maxGdiff) maxGdiff = d;
  }
  assert.ok(maxGdiff <= 1, `G row drift ${maxGdiff} > 1 — seams in gradient`);
});

test('Stitcher: rejects mis-shaped tile data', () => {
  const plan = planTiles(300, 300);
  const s = new Stitcher(plan.scaledW, plan.scaledH, plan.featherPx);
  const t = plan.tiles[0];
  const wrong = new Float32Array(t.scaledW * t.scaledH * 3 - 1);
  assert.throws(() => s.addTile(wrong, t), /data length/);
});

test('Stitcher: rejects bad canvas dims', () => {
  assert.throws(() => new Stitcher(0, 100, 0),    /invalid canvas/);
  assert.throws(() => new Stitcher(100, 0, 0),    /invalid canvas/);
  assert.throws(() => new Stitcher(100, 100, -1), /featherPx must be >= 0/);
});


// =============================================================================
// clampRoundU8 — postprocess byte conversion
// =============================================================================

test('clampRoundU8: clamps and rounds (matches python np.clip(np.round, 0, 255))', () => {
  assert.equal(clampRoundU8(-5), 0);
  assert.equal(clampRoundU8(0), 0);
  assert.equal(clampRoundU8(0.4), 0);
  assert.equal(clampRoundU8(0.5), 1);
  assert.equal(clampRoundU8(127.4), 127);
  assert.equal(clampRoundU8(127.6), 128);
  assert.equal(clampRoundU8(255), 255);
  assert.equal(clampRoundU8(255.4), 255);
  assert.equal(clampRoundU8(300), 255);
});
