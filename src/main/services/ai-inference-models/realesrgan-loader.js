/**
 * src/main/services/ai-inference-models/realesrgan-loader.js
 *
 * Host-side loader for the Real-ESRGAN super-resolution model
 * (`realesr-general-x4v3`). Mirrors the structure of `musiq-loader.js`
 * and `orientation-loader.js`, but the input/output contract is tile-
 * shaped rather than whole-image:
 *
 *   prepareTensor(rgbHwcU8, tileW, tileH, ort) → ort.Tensor
 *     ([1, 3, tileH, tileW] float32 in [0, 1])
 *   postprocess(rawData, scaledW, scaledH) → Buffer
 *     (HWC interleaved uint8, length scaledW*scaledH*3)
 *
 * This signature divergence is intentional. The model is invoked tile-
 * by-tile from the M2 `localClient` (one model.run() per tile, sequential
 * dispatch within a single high-level enhancement request). The standard
 * `handleInference({ imagePath })` path in `ai-inference-host.js` is not
 * used for `realesrgan` — a tile-aware dispatcher is added in M2.
 *
 * Bundled artefact: realesr-general-x4v3.onnx (~4.6 MB, opset 18).
 *   - source:        github.com/xinntao/Real-ESRGAN @ v0.2.5.0
 *   - architecture:  SRVGGNetCompact (num_feat=64, num_conv=32, scale=4,
 *                    act_type='prelu')
 *   - input  shape:  [1, 3, H, W]    (dynamic H/W, any spatial dims)
 *   - output shape:  [1, 3, 4*H, 4*W] (residual upsample)
 *   - input  range:  [0, 1] float32, NCHW, RGB channel order
 *   - output range:  ~[-0.15, 1.17] float32 — clamp to [0, 1] in postprocess
 *   - parity:        max abs diff vs upstream PyTorch reference is 3.3e-5
 *                    on the test fixture; well under the 1/255 threshold.
 *                    See tools/onnx-export/_realesrgan_src/validate-parity.py.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const MODEL_FILE     = 'realesr-general-x4v3.onnx';
const INPUT_NAME     = 'input';
const OUTPUT_NAME    = 'output';
const SCALE          = 4;

// Defaults — overridable via config (see §0.10 of the implementation plan).
const DEFAULT_TILE_SIZE    = 256;
const DEFAULT_TILE_OVERLAP = 16;

function resolveModelPath(override) {
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'models'))) {
    return path.join(process.resourcesPath, 'models', 'realesrgan', MODEL_FILE);
  }
  return path.join(__dirname, '..', '..', '..', '..', 'resources', 'models', 'realesrgan', MODEL_FILE);
}

/**
 * Convert an HWC interleaved RGB uint8 buffer (sharp's `.raw()` output)
 * into a [1, 3, tileH, tileW] float32 NCHW tensor in [0, 1].
 *
 * The Real-ESRGAN model expects RGB channel order; sharp emits RGB by
 * default after `removeAlpha()`. The buffer length must be exactly
 * tileW * tileH * 3.
 */
function prepareTensor(rgbHwcU8, tileW, tileH, ort) {
  const expected = tileW * tileH * 3;
  if (!rgbHwcU8 || rgbHwcU8.length !== expected) {
    throw new Error(
      `realesrgan prepareTensor: buffer length ${rgbHwcU8 ? rgbHwcU8.length : 'null'} ` +
      `!= expected ${expected} (${tileW}x${tileH}x3)`
    );
  }
  if (tileW <= 0 || tileH <= 0) {
    throw new Error(`realesrgan prepareTensor: invalid tile dims ${tileW}x${tileH}`);
  }

  const plane = tileW * tileH;
  const out = new Float32Array(3 * plane);

  for (let i = 0; i < plane; i++) {
    const src = i * 3;
    out[i]             = rgbHwcU8[src]     / 255;
    out[i + plane]     = rgbHwcU8[src + 1] / 255;
    out[i + 2 * plane] = rgbHwcU8[src + 2] / 255;
  }

  return new ort.Tensor('float32', out, [1, 3, tileH, tileW]);
}

/**
 * Convert raw model output (Float32Array, CHW, ~[0, 1]) into an HWC
 * interleaved uint8 Buffer ready to composite into the stitched canvas.
 *
 * Real-ESRGAN's residual upsample can land slightly outside [0, 1] (the
 * smoke-test fixture sees ~[-0.14, 1.17]). Clamping to [0, 255] uint8 is
 * the standard postprocess; rounding (not truncation) matches the
 * Python reference's `np.clip(np.round(x * 255), 0, 255)` semantics —
 * verified to within 1 step on 99.9987% of pixels by validate-parity.py.
 */
function postprocess(rawData, scaledW, scaledH) {
  const expected = scaledW * scaledH * 3;
  if (!rawData || rawData.length !== expected) {
    throw new Error(
      `realesrgan postprocess: data length ${rawData ? rawData.length : 'null'} ` +
      `!= expected ${expected} (${scaledW}x${scaledH}x3)`
    );
  }

  const plane = scaledW * scaledH;
  const out = Buffer.alloc(expected);

  for (let i = 0; i < plane; i++) {
    const dst = i * 3;
    out[dst]     = clampRoundU8(rawData[i]             * 255);
    out[dst + 1] = clampRoundU8(rawData[i + plane]     * 255);
    out[dst + 2] = clampRoundU8(rawData[i + 2 * plane] * 255);
  }
  return out;
}

function clampRoundU8(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

module.exports = {
  modelId: 'realesrgan',
  modelFile: MODEL_FILE,
  inputName: INPUT_NAME,
  outputName: OUTPUT_NAME,
  scale: SCALE,
  defaultTileSize: DEFAULT_TILE_SIZE,
  defaultTileOverlap: DEFAULT_TILE_OVERLAP,
  // imageSize lets ai-inference-host.warmupSession allocate a zero tensor
  // at the default tile dimensions and pay JIT/graph-compilation cost up
  // front. Cuts the first real-tile latency by ~10 % in bench measurement.
  imageSize: DEFAULT_TILE_SIZE,
  resolveModelPath,
  prepareTensor,
  postprocess,
  // Exposed for tests.
  _internal: { clampRoundU8 },
};
