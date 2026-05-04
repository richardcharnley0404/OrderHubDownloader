/**
 * src/main/services/ai-inference-models/musiq-preprocessor.js
 *
 * JS port of the MUSIQ-SPAQ preprocessing pipeline. Produces the
 * (1, 1217, 3075) Float32Array that musiq-loader.js feeds to the
 * bundled ONNX (musiq-spaq-3scale-cap1024.onnx).
 *
 * The contract is fixed by tools/onnx-export/musiq-spaq-3scale-cap1024.model.json
 * and explained in docs/ai-quality-gate/conversion-audit.md. Per-scale
 * patch counts and the row-width breakdown:
 *
 *   Total patches: 1217  ( 49 + 144 + 1024 )
 *   Row width:     3075  ( 32*32*3 RGB pixels + [hash_id, scale_id, mask] )
 *
 * The pipeline mirrors google-research/musiq/model/preprocessing.py:
 *   1) for each scale L in [224, 384]:
 *        aspect-preserving resize so longer-side = L  (Gaussian kernel)
 *        normalize pixels to [-1, 1]
 *        extract 32x32 patches at stride 32 (SAME padding)
 *        compute hashed spatial pos indexes (10x10 grid)
 *        tag rows with [hash_id, scale_id=index, mask=1] -> width 3075
 *        pad/cut to per-scale max ( 49 for 224, 144 for 384 )
 *   2) native scale:
 *        aspect-preserving resize so longer-side <= 1024
 *        same patch / hash / tag pipeline, scale_id = 2
 *        pad to 1024 patches
 *   3) concat the three scale arrays into (1, 1217, 3075) flattened
 *
 * Step 4a deliverable: this file plus __tests__/musiq-preprocessor.test.js.
 * Step 4b verifies element-wise vs the JAX reference. Step 4c verifies the
 * end-to-end JS-preprocess -> ONNX-inference score against JAX.
 */

'use strict';

const sharp = require('sharp');

// ---- Contract constants (mirror the model.json sidecar) ------------------

const PATCH_SIZE = 32;
const PATCH_STRIDE = 32;
const HSE_GRID_SIZE = 10;
const SHORT_SCALES = [224, 384];                          // longer-side targets
const NATIVE_LONGER_SIDE_CAP = 1024;
const NATIVE_MAX_PATCHES = 1024;
const SHORT_SCALE_MAX_PATCHES = SHORT_SCALES.map(
  (L) => Math.ceil(L / PATCH_STRIDE) ** 2
);                                                         // [49, 144]
const TOTAL_MAX_PATCHES =
  SHORT_SCALE_MAX_PATCHES.reduce((a, b) => a + b, 0) + NATIVE_MAX_PATCHES; // 1217
const PATCH_PIXEL_COUNT = PATCH_SIZE * PATCH_SIZE * 3;     // 3072
const PATCH_ROW_DIM = PATCH_PIXEL_COUNT + 3;               // 3075

// ---- 1. Image decode + Lanczos3 aspect-preserving resize ----------------
//
// The production preprocessor uses sharp's built-in Lanczos3 kernel for
// the 224 and 384 short-scale downsamples. Although the trained MUSIQ
// reference uses tf2.image.resize(method=GAUSSIAN), Step 4b-redo-1 of
// the conversion audit empirically established that the model is robust
// to this kernel substitution: max score delta of 0.72 points across 5
// test images, well within the OHD quality-gate's operating tolerance.
// See docs/ai-quality-gate/conversion-audit.md for the full reasoning.
//
// A pure-JS Gaussian implementation lives at
//   tools/onnx-export/_diagnostics/gaussian_resize_reference.js
// (gitignored) for reproducibility if the kernel choice is ever revisited.

/**
 * Decode an image file via sharp into raw Float32 RGB pixels at the file's
 * native resolution. Pixel values are in [0, 255] (no normalization yet).
 * Returns { buffer: Float32Array of shape h*w*3, h, w }.
 *
 * Used by the native-scale path (no resize). Short-scale paths use
 * decode_and_resize_lanczos3 below, which fuses decode + resize into a
 * single sharp pipeline.
 */
async function decode_to_rgb_float(imagePath) {
  const { data, info } = await sharp(imagePath, { failOn: 'none' })
    .removeAlpha()
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i];
  }
  return { buffer: out, h: info.height, w: info.width };
}

/**
 * Aspect-preserving Lanczos3 resize. Decodes the image and resizes in a
 * single sharp pipeline so the output matches `tf.image.resize(method=
 * LANCZOS3)` up to sharp's uint8 quantization (~1/255 absolute per
 * channel after normalisation; the empirical bound from Step 4b-redo-2
 * lands well under the 1e-3 acceptance threshold).
 *
 * Output dimensions are computed deterministically: longer-side =
 * `longerSide`, shorter-side = round(other_dim * ratio). This matches
 * TF's resize_preserve_aspect_ratio rounding rule exactly (round-half-
 * to-even is JS's default; TF uses half-to-nearest-even too).
 *
 * Returns { buffer: Float32Array of shape h_out*w_out*3 in [0, 255], h, w }.
 */
async function decode_and_resize_lanczos3(imagePath, longerSide) {
  const meta = await sharp(imagePath).metadata();
  const ratio = longerSide / Math.max(meta.width, meta.height);
  const outW = Math.round(meta.width * ratio);
  const outH = Math.round(meta.height * ratio);

  const { data, info } = await sharp(imagePath, { failOn: 'none' })
    .removeAlpha()
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .resize(outW, outH, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i];
  }
  return { buffer: out, h: info.height, w: info.width };
}

// ---- 2. Pixel-range normalization ---------------------------------------

/**
 * Map [0, 255] pixel values to [-1, 1].
 * Mirrors TF's normalize_value_range(image, vmin=-1, vmax=1, in_min=0, in_max=255).
 */
function normalize_to_signed_unit(buffer) {
  const out = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    out[i] = buffer[i] / 127.5 - 1.0;
  }
  return out;
}

// ---- 3. Patch extraction (32x32, stride 32, SAME padding) ---------------

/**
 * Extract 32x32 patches at stride 32 with SAME padding. Mirrors TF's
 * tf.image.extract_patches with sizes=(1,32,32,1), strides=(1,32,32,1),
 * rates=(1,1,1,1), padding='SAME'.
 *
 * Input: float32 RGB buffer of shape h*w*3 (row-major, channels innermost).
 * Output: { patches: Float32Array of shape (count_h * count_w * 32*32*3),
 *           count_h, count_w }
 *
 * SAME-padding semantics — IMPORTANT: TF splits the required total pad
 * symmetrically across both edges of each axis, not just the bottom/right.
 * For input size N and stride 32:
 *
 *   count    = ceil(N / 32)
 *   total    = count * 32 - N
 *   pad_low  = floor(total / 2)              (top or left)
 *   pad_high = total - pad_low                (bottom or right)
 *
 * Patches are extracted from the *padded* layout, so patch (0,0) starts
 * at image coordinates (-pad_low_h, -pad_low_w). Pixels at negative
 * coordinates and at coordinates >= original h/w are zero (the
 * out-buffer is zero-initialised; this function just skips those reads).
 *
 * For an input whose dimensions are exact multiples of 32 (e.g. 512x512,
 * 640x800, 1024x1024), total = 0 on both axes and behaviour collapses
 * to the simple "no padding" case. The asymmetric edges are only
 * material for non-multiple-of-32 dimensions — which is, in practice,
 * almost every real customer photo (4032x3024, 3000x4000, etc.).
 *
 * Within-patch layout: row-major over 32x32 spatial extent, channels
 * innermost (R, G, B per pixel) — matches TF's per-patch flatten order.
 */
function extract_32x32_patches(buffer, h, w) {
  const count_h = Math.ceil(h / PATCH_STRIDE);
  const count_w = Math.ceil(w / PATCH_STRIDE);
  const numPatches = count_h * count_w;
  const out = new Float32Array(numPatches * PATCH_PIXEL_COUNT);

  // SAME padding: split total pad on each axis, low half on top/left.
  const totalPadH = count_h * PATCH_STRIDE - h;
  const totalPadW = count_w * PATCH_STRIDE - w;
  const padLowH = Math.floor(totalPadH / 2);
  const padLowW = Math.floor(totalPadW / 2);

  for (let py = 0; py < count_h; py++) {
    for (let px = 0; px < count_w; px++) {
      const patchIdx = py * count_w + px;
      const patchOff = patchIdx * PATCH_PIXEL_COUNT;
      // Top-left of this patch in the padded layout.
      const yStartPadded = py * PATCH_STRIDE;
      const xStartPadded = px * PATCH_STRIDE;
      for (let dy = 0; dy < PATCH_SIZE; dy++) {
        // Translate from padded coord to image coord.
        const iy = yStartPadded + dy - padLowH;
        if (iy < 0 || iy >= h) continue;     // top or bottom pad → leave zero
        for (let dx = 0; dx < PATCH_SIZE; dx++) {
          const ix = xStartPadded + dx - padLowW;
          if (ix < 0 || ix >= w) continue;   // left or right pad → leave zero
          const src = (iy * w + ix) * 3;
          const dst = patchOff + (dy * PATCH_SIZE + dx) * 3;
          out[dst] = buffer[src];
          out[dst + 1] = buffer[src + 1];
          out[dst + 2] = buffer[src + 2];
        }
      }
    }
  }

  return { patches: out, count_h, count_w };
}

// ---- 4. Hashed spatial position embedding indexes -----------------------

/**
 * Compute hashed-position indexes for a count_h * count_w patch grid.
 *
 * Mirrors get_hashed_spatial_pos_emb_index in google-research/musiq/model/
 * preprocessing.py, which uses tf.image.resize with NEAREST_NEIGHBOR
 * (align_corners=False, half_pixel_centers=False — the TF1 legacy default
 * preserved by the code path used). For each output index i in [0, N),
 * the source grid index is:
 *
 *   src_i = floor(i * grid_size / N)
 *
 * The final index for grid position (h, w) is h_hash[h] * grid_size +
 * w_hash[w]. Output is row-major (Int32) of length count_h * count_w.
 *
 * Verified byte-exact against TF on 9 reference cases — see
 * __tests__/fixtures/hash_indexes.json.
 */
function hashed_spatial_pos_emb_indexes(count_h, count_w, gridSize = HSE_GRID_SIZE) {
  const h_hash = new Int32Array(count_h);
  const w_hash = new Int32Array(count_w);
  for (let i = 0; i < count_h; i++) {
    h_hash[i] = Math.floor((i * gridSize) / count_h);
  }
  for (let j = 0; j < count_w; j++) {
    w_hash[j] = Math.floor((j * gridSize) / count_w);
  }
  const out = new Int32Array(count_h * count_w);
  for (let i = 0; i < count_h; i++) {
    for (let j = 0; j < count_w; j++) {
      out[i * count_w + j] = h_hash[i] * gridSize + w_hash[j];
    }
  }
  return out;
}

// ---- 5. Tag patches with [hash_id, scale_id, mask=1] --------------------

/**
 * Append [hash_id, scale_id, mask=1.0] to each patch row, producing rows
 * of width 3075. Returns Float32Array shape (numPatches * 3075).
 */
function tag_scale_and_mask(patches, hashIndexes, scaleId) {
  const numPatches = hashIndexes.length;
  if (patches.length !== numPatches * PATCH_PIXEL_COUNT) {
    throw new Error(
      `tag_scale_and_mask: patches length ${patches.length} != ` +
      `${numPatches} * ${PATCH_PIXEL_COUNT}`
    );
  }
  const out = new Float32Array(numPatches * PATCH_ROW_DIM);
  for (let p = 0; p < numPatches; p++) {
    const src = p * PATCH_PIXEL_COUNT;
    const dst = p * PATCH_ROW_DIM;
    // Copy pixel data (3072 floats).
    for (let k = 0; k < PATCH_PIXEL_COUNT; k++) {
      out[dst + k] = patches[src + k];
    }
    // Append metadata (3 floats).
    out[dst + PATCH_PIXEL_COUNT]     = hashIndexes[p];  // hash_id
    out[dst + PATCH_PIXEL_COUNT + 1] = scaleId;          // scale_id
    out[dst + PATCH_PIXEL_COUNT + 2] = 1.0;              // mask=1 (real patch)
  }
  return out;
}

// ---- 6. Concat per-scale arrays + pad to max sequence length ------------

/**
 * Concatenate the per-scale row arrays (each already PRE-PADDED to its
 * per-scale max — see _pad_or_cut_per_scale below) and produce a single
 * Float32Array of shape (1, maxSeqLen, 3075) flattened.
 *
 * Asserts the concatenated length == maxSeqLen * 3075. Caller is
 * responsible for ensuring each scale array has the right per-scale max
 * (49, 144, 1024 for the standard 3-scale config). That separation keeps
 * this function "trivial concatenation" as the user spec'd.
 */
function concat_and_pad_to_max_seq(scaleArrays, maxSeqLen = TOTAL_MAX_PATCHES) {
  const expected = maxSeqLen * PATCH_ROW_DIM;
  let total = 0;
  for (const a of scaleArrays) total += a.length;
  if (total !== expected) {
    throw new Error(
      `concat_and_pad_to_max_seq: total length ${total} != maxSeqLen*rowDim ${expected}. ` +
      `Each scale must be pre-padded to its per-scale max before concat.`
    );
  }
  const out = new Float32Array(expected);
  let pos = 0;
  for (const a of scaleArrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

/**
 * Internal helper: pad a per-scale tagged row array to maxRows by
 * appending mask=0 zero rows, or truncate if the row count exceeds
 * maxRows. Used inside preprocess() before concat_and_pad_to_max_seq.
 */
function _pad_or_cut_per_scale(scaleArray, maxRows) {
  const currentRows = scaleArray.length / PATCH_ROW_DIM;
  const out = new Float32Array(maxRows * PATCH_ROW_DIM);
  if (currentRows >= maxRows) {
    out.set(scaleArray.subarray(0, maxRows * PATCH_ROW_DIM));
  } else {
    out.set(scaleArray);
    // Remaining rows stay zero (mask=0 -> ignored by the model).
  }
  return out;
}

// ---- Top-level orchestrator ---------------------------------------------

/**
 * Run the full preprocessor on an image file. Returns a Float32Array of
 * length 1217 * 3075 = 3,742,275 ready to be wrapped in an
 * ort.Tensor('float32', buf, [1, 1217, 3075]) and fed to the bundled
 * MUSIQ-SPAQ ONNX.
 *
 * IMPORTANT — native-scale behaviour mirrors Google's reference code in
 * google-research/musiq/model/preprocessing.py:
 *
 *   for longer_size in [224, 384]:
 *       resize aspect-preserving to longer_size, extract patches, pad/cut
 *   # native pass
 *   extract patches from the ORIGINAL image (no resize),
 *   then truncate the patch sequence to NATIVE_MAX_PATCHES (1024) in
 *   row-major order.
 *
 * For images with native longer-side > ~1024, this means roughly the
 * top 1024 row-major patches are kept and the rest of the image is
 * dropped (a 4032x3024 phone photo has ~12000 native patches; only the
 * top 8.1 patch-rows = top 260 px out of 3024 are used). This matches
 * what the bundled ONNX was trained on. See conversion-audit.md and the
 * Step 4b report for the discussion about whether to revisit this for
 * production (would require re-exporting the ONNX with a different
 * preprocessing config — currently a deferred design question).
 */
async function preprocess(imagePath) {
  const scaleArrays = [];

  // Two short scales: 224 and 384. Each does its own decode+resize via
  // sharp's Lanczos3 — fused in one pipeline per scale.
  for (let i = 0; i < SHORT_SCALES.length; i++) {
    const L = SHORT_SCALES[i];
    const r = await decode_and_resize_lanczos3(imagePath, L);
    const norm = normalize_to_signed_unit(r.buffer);
    const ext = extract_32x32_patches(norm, r.h, r.w);
    const hashes = hashed_spatial_pos_emb_indexes(ext.count_h, ext.count_w);
    const tagged = tag_scale_and_mask(ext.patches, hashes, i);
    scaleArrays.push(_pad_or_cut_per_scale(tagged, SHORT_SCALE_MAX_PATCHES[i]));
  }

  // Native scale: NO resize. Decode once, extract patches at native
  // resolution (matches TF reference at preprocessing.py:242-245), then
  // row-major truncate to NATIVE_MAX_PATCHES via _pad_or_cut_per_scale.
  {
    const decoded = await decode_to_rgb_float(imagePath);
    const norm = normalize_to_signed_unit(decoded.buffer);
    const ext = extract_32x32_patches(norm, decoded.h, decoded.w);
    const hashes = hashed_spatial_pos_emb_indexes(ext.count_h, ext.count_w);
    const tagged = tag_scale_and_mask(ext.patches, hashes, SHORT_SCALES.length); // scale_id = 2
    scaleArrays.push(_pad_or_cut_per_scale(tagged, NATIVE_MAX_PATCHES));
  }

  return concat_and_pad_to_max_seq(scaleArrays, TOTAL_MAX_PATCHES);
}

module.exports = {
  // Public unit-testable functions
  decode_to_rgb_float,
  decode_and_resize_lanczos3,
  normalize_to_signed_unit,
  extract_32x32_patches,
  hashed_spatial_pos_emb_indexes,
  tag_scale_and_mask,
  concat_and_pad_to_max_seq,
  preprocess,

  // Constants (also useful to loader and tests)
  PATCH_SIZE,
  PATCH_STRIDE,
  HSE_GRID_SIZE,
  SHORT_SCALES,
  NATIVE_LONGER_SIDE_CAP,
  NATIVE_MAX_PATCHES,
  SHORT_SCALE_MAX_PATCHES,
  TOTAL_MAX_PATCHES,
  PATCH_PIXEL_COUNT,
  PATCH_ROW_DIM,
};
