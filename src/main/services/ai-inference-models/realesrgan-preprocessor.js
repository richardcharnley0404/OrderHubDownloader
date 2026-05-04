/**
 * src/main/services/ai-inference-models/realesrgan-preprocessor.js
 *
 * Tile-and-stitch geometry for the Real-ESRGAN super-resolution model.
 * Companion to `realesrgan-loader.js`. Pure data-plumbing — no ORT, no
 * sharp, no fs. Designed to be unit-testable in isolation and re-usable
 * by both the M2 localClient (utility-process tile loop) and any future
 * dispatcher.
 *
 * Why this exists: naive whole-image inference at 4× upscale OOMs on a
 * 12 MP source. Every code path that reaches the model goes through the
 * tiling preprocessor.
 *
 * Algorithm (canonical, matches upscaler.js / Real-ESRGAN tile_process
 * convention — "do not innovate", per the implementation plan §7.1):
 *
 *   1. Plan tiles. For each axis, advance with stride = tileSize - overlap
 *      from origin 0 until the right/bottom edge is reached. The final
 *      tile in each axis is shifted inward to (srcDim - tileSize) so it
 *      sits flush with the canvas edge. Sources smaller than tileSize
 *      produce one partial tile (model accepts dynamic spatial dims).
 *
 *   2. Extract. For each plan, copy out the tileW*tileH*3 HWC region
 *      from the source raw buffer.
 *
 *   3. Stitch. Output canvas is scale*srcW × scale*srcH. Each tile's
 *      float32 CHW output (~[0,1]) is composited into the canvas with
 *      linear edge feathering of width `scale * overlap` pixels on any
 *      side that has a neighbour. Sides that touch the canvas boundary
 *      keep weight 1.0 to the edge. Per-pixel weights are accumulated in
 *      a parallel buffer; final pass divides RGB by weight, clamps and
 *      rounds to uint8 HWC.
 *
 * Reference algorithms:
 *   - github.com/thekevinscott/UpscalerJS  (JS canon)
 *   - xinntao/Real-ESRGAN realesrgan_utils.py  RealESRGANer.tile_process
 *
 * The plan's spec also calls for reflection padding of edge tiles up to
 * tileSize. That is unnecessary here because the model accepts dynamic
 * H/W and last-tile-shift-inward (above) keeps every tile full-size on
 * sources >= tileSize, removing any edge effect from the model's
 * receptive field. Reflection padding is therefore only a possible
 * future optimisation, not a current requirement.
 */

'use strict';

const DEFAULT_TILE_SIZE    = 256;
const DEFAULT_TILE_OVERLAP = 16;
const DEFAULT_SCALE        = 4;

// ---------------------------------------------------------------------------
// 1D tile origin planner
// ---------------------------------------------------------------------------

/**
 * Plan tile origins along a single axis.
 *
 * @param {number} srcDim     source size on this axis (px)
 * @param {number} tileSize   tile size (px)
 * @param {number} overlap    overlap between adjacent tiles (px)
 * @returns {Array<{src:number, len:number}>}  one entry per tile
 */
function plan1D(srcDim, tileSize, overlap) {
  if (srcDim <= 0)        throw new Error(`plan1D: srcDim must be positive, got ${srcDim}`);
  if (tileSize <= 0)      throw new Error(`plan1D: tileSize must be positive, got ${tileSize}`);
  if (overlap < 0)        throw new Error(`plan1D: overlap must be >= 0, got ${overlap}`);
  if (overlap >= tileSize) throw new Error(`plan1D: overlap (${overlap}) must be < tileSize (${tileSize})`);

  // Single-tile cases: the whole axis fits inside one (possibly partial) tile.
  if (srcDim <= tileSize) {
    return [{ src: 0, len: srcDim }];
  }

  const stride = tileSize - overlap;
  const origins = [0];
  // Advance by stride until the latest tile's right edge reaches srcDim.
  // If the next regular-stride origin would push the tile past srcDim,
  // place the tile flush with the right/bottom edge instead. That trailing
  // tile may overlap its predecessor by more than `overlap` px when srcDim
  // is not on a stride boundary — feathering handles arbitrary overlap.
  while (origins[origins.length - 1] + tileSize < srcDim) {
    const candidate = origins[origins.length - 1] + stride;
    const next = (candidate + tileSize > srcDim) ? srcDim - tileSize : candidate;
    origins.push(next);
  }

  return origins.map((s) => ({ src: s, len: tileSize }));
}

// ---------------------------------------------------------------------------
// 2D tile plan
// ---------------------------------------------------------------------------

/**
 * Build the full tile plan for an image.
 *
 * @param {number} srcW     source image width (px)
 * @param {number} srcH     source image height (px)
 * @param {object} [options]
 * @param {number} [options.tileSize=256]
 * @param {number} [options.tileOverlap=16]
 * @param {number} [options.scale=4]
 * @returns {object} {
 *   srcW, srcH,
 *   scale, tileSize, tileOverlap,
 *   scaledW, scaledH,
 *   featherPx,
 *   tilesX, tilesY,
 *   tiles: Array<{
 *     ix, iy,                   // grid coordinates
 *     srcX, srcY, w, h,         // source region (HWC bytes)
 *     dstSx, dstSy,             // destination in scaled canvas (top-left)
 *     scaledW, scaledH,         // 4*w, 4*h
 *     neighbors: { left, top, right, bottom }
 *   }>
 * }
 */
function planTiles(srcW, srcH, options = {}) {
  const tileSize    = options.tileSize    || DEFAULT_TILE_SIZE;
  const tileOverlap = options.tileOverlap != null ? options.tileOverlap : DEFAULT_TILE_OVERLAP;
  const scale       = options.scale       || DEFAULT_SCALE;

  const xs = plan1D(srcW, tileSize, tileOverlap);
  const ys = plan1D(srcH, tileSize, tileOverlap);

  const tiles = [];
  for (let iy = 0; iy < ys.length; iy++) {
    for (let ix = 0; ix < xs.length; ix++) {
      const x = xs[ix];
      const y = ys[iy];
      tiles.push({
        ix,
        iy,
        srcX:    x.src,
        srcY:    y.src,
        w:       x.len,
        h:       y.len,
        dstSx:   x.src * scale,
        dstSy:   y.src * scale,
        scaledW: x.len * scale,
        scaledH: y.len * scale,
        neighbors: {
          left:   ix > 0,
          top:    iy > 0,
          right:  ix < xs.length - 1,
          bottom: iy < ys.length - 1,
        },
      });
    }
  }

  return {
    srcW,
    srcH,
    scale,
    tileSize,
    tileOverlap,
    scaledW: srcW * scale,
    scaledH: srcH * scale,
    featherPx: tileOverlap * scale,
    tilesX: xs.length,
    tilesY: ys.length,
    tiles,
  };
}

// ---------------------------------------------------------------------------
// Tile extraction
// ---------------------------------------------------------------------------

/**
 * Copy out a tile region from an HWC interleaved RGB source buffer.
 *
 * @param {Uint8Array|Buffer} rawHwc   source bytes, length srcW*srcH*3
 * @param {number} srcW
 * @param {number} srcH
 * @param {object} tile                one entry from planTiles().tiles
 * @returns {Uint8Array} length tile.w*tile.h*3
 */
function extractTile(rawHwc, srcW, srcH, tile) {
  if (!rawHwc || rawHwc.length !== srcW * srcH * 3) {
    throw new Error(`extractTile: source buffer length ${rawHwc ? rawHwc.length : 'null'} != ${srcW * srcH * 3}`);
  }
  if (tile.srcX < 0 || tile.srcY < 0 || tile.srcX + tile.w > srcW || tile.srcY + tile.h > srcH) {
    throw new Error(
      `extractTile: tile region (${tile.srcX},${tile.srcY},${tile.w}x${tile.h}) ` +
      `is out of source bounds ${srcW}x${srcH}`
    );
  }

  const tileW = tile.w;
  const tileH = tile.h;
  const out = new Uint8Array(tileW * tileH * 3);
  const srcStride = srcW * 3;
  const dstStride = tileW * 3;

  for (let row = 0; row < tileH; row++) {
    const srcStart = (tile.srcY + row) * srcStride + tile.srcX * 3;
    out.set(rawHwc.subarray(srcStart, srcStart + dstStride), row * dstStride);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stitcher — accumulates weighted tile outputs into the final canvas
// ---------------------------------------------------------------------------

class Stitcher {
  /**
   * @param {number} scaledW    canvas width  (= srcW * scale)
   * @param {number} scaledH    canvas height (= srcH * scale)
   * @param {number} featherPx  feather distance in output pixels (= overlap * scale)
   */
  constructor(scaledW, scaledH, featherPx) {
    if (scaledW <= 0 || scaledH <= 0) {
      throw new Error(`Stitcher: invalid canvas ${scaledW}x${scaledH}`);
    }
    if (featherPx < 0) {
      throw new Error(`Stitcher: featherPx must be >= 0, got ${featherPx}`);
    }
    this.W = scaledW;
    this.H = scaledH;
    this.featherPx = featherPx;
    // RGB accumulator (HWC layout, float32) and per-pixel weight accumulator.
    this.rgb    = new Float32Array(scaledW * scaledH * 3);
    this.weight = new Float32Array(scaledW * scaledH);
  }

  /**
   * Composite a single tile's float32 CHW output into the canvas with
   * linear edge feathering. The model's raw output (in ~[0,1]) is added
   * verbatim, *not* clamped — clamping happens in finalise() after the
   * weighted average. This avoids cumulative clamp error in overlap
   * regions where multiple tiles' contributions are blended.
   *
   * @param {Float32Array} chwData    length tileW*tileH*3, CHW order
   * @param {object} tile             one entry from planTiles().tiles
   */
  addTile(chwData, tile) {
    const tileW = tile.scaledW;
    const tileH = tile.scaledH;
    const expected = tileW * tileH * 3;
    if (!chwData || chwData.length !== expected) {
      throw new Error(
        `Stitcher.addTile: data length ${chwData ? chwData.length : 'null'} ` +
        `!= expected ${expected} (tile ${tileW}x${tileH}x3 CHW)`
      );
    }

    const { dstSx, dstSy, neighbors } = tile;
    const W = this.W;
    const featherPx = this.featherPx;
    const plane = tileW * tileH;

    // Precompute X feather weights once per row (row-invariant).
    const wxRow = computeAxisFeather(tileW, featherPx, neighbors.left, neighbors.right);

    for (let ly = 0; ly < tileH; ly++) {
      // Y feather.
      let wy = 1.0;
      if (neighbors.top && ly < featherPx) {
        wy = (ly + 0.5) / featherPx;
      }
      if (neighbors.bottom) {
        const db = tileH - 1 - ly;
        if (db < featherPx) wy = Math.min(wy, (db + 0.5) / featherPx);
      }
      if (wy <= 0) continue;

      const dstY = dstSy + ly;
      const dstRowBase = dstY * W;
      const tileRowBase = ly * tileW;

      for (let lx = 0; lx < tileW; lx++) {
        const w = wxRow[lx] * wy;
        if (w < 1e-6) continue;

        const dstX = dstSx + lx;
        const dstLin = dstRowBase + dstX;
        const dstRgb = dstLin * 3;
        const srcLin = tileRowBase + lx;

        this.rgb[dstRgb]     += chwData[srcLin]             * w;
        this.rgb[dstRgb + 1] += chwData[srcLin + plane]     * w;
        this.rgb[dstRgb + 2] += chwData[srcLin + 2 * plane] * w;
        this.weight[dstLin]  += w;
      }
    }
  }

  /**
   * Normalise the accumulator and return the final HWC uint8 Buffer.
   * Pixels with zero weight (should never occur if planTiles covers the
   * canvas, but defensive) are set to 0.
   *
   * @returns {Buffer} length W*H*3
   */
  finalise() {
    const npx = this.W * this.H;
    const out = Buffer.alloc(npx * 3);
    for (let i = 0; i < npx; i++) {
      const w = this.weight[i];
      const dst = i * 3;
      if (w > 0) {
        out[dst]     = clampRoundU8(this.rgb[dst]     / w * 255);
        out[dst + 1] = clampRoundU8(this.rgb[dst + 1] / w * 255);
        out[dst + 2] = clampRoundU8(this.rgb[dst + 2] / w * 255);
      } // else zero — Buffer.alloc already zeroed
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Feathering helpers
// ---------------------------------------------------------------------------

/**
 * Compute per-pixel feather weights along a single axis.
 * Sides without a neighbour stay at 1.0 across the entire feather band.
 */
function computeAxisFeather(len, featherPx, hasLeftNeighbor, hasRightNeighbor) {
  const out = new Float32Array(len);
  for (let x = 0; x < len; x++) {
    let w = 1.0;
    if (hasLeftNeighbor && x < featherPx) {
      w = (x + 0.5) / featherPx;
    }
    if (hasRightNeighbor) {
      const dr = len - 1 - x;
      if (dr < featherPx) w = Math.min(w, (dr + 0.5) / featherPx);
    }
    out[x] = w;
  }
  return out;
}

function clampRoundU8(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

module.exports = {
  DEFAULT_TILE_SIZE,
  DEFAULT_TILE_OVERLAP,
  DEFAULT_SCALE,
  plan1D,
  planTiles,
  extractTile,
  Stitcher,
  // Exposed for tests.
  _internal: { computeAxisFeather, clampRoundU8 },
};
