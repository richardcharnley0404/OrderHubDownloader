/**
 * src/main/services/ai-inference-models/musiq-loader.js
 *
 * Host-side loader for the AI Quality Gate scoring model. Mirrors the
 * structure of orientation-loader.js — exports a `prepareTensor` and a
 * `postprocess` plus the model-file metadata that ai-inference-host
 * uses to load and invoke the ONNX session.
 *
 * Bundled model:
 *   Google MUSIQ-SPAQ, **3-scale variant** (native + 224 + 384 resolution
 *   scales, ResNet-50 backbone + multi-scale Transformer). Source weights:
 *   gs://gresearch/musiq/spaq_ckpt.npz (Apache 2.0). The .onnx file is
 *   the result of a JAX -> TF SavedModel -> ONNX conversion pipeline
 *   documented in docs/ai-quality-gate/conversion-audit.md.
 *
 * Production preprocessing diverges from MUSIQ's training-time pipeline
 * in one specific way: the JS preprocessor uses sharp's Lanczos3 kernel
 * for the 224 and 384 short-scale resamples, where the trained MUSIQ
 * pipeline uses tf.image.resize(method=GAUSSIAN). This substitution was
 * empirically validated as score-equivalent within ~0.7 points across
 * a 5-image test set (canonical Gaussian reference vs the Lanczos
 * production pipeline). See conversion-audit.md § "Resize Pivot" for
 * the reasoning.
 *
 * Bundled artefact: musiq-spaq-3scale-cap1024-v1.onnx (131 MB, opset 18).
 *   - cap = 1024 native patches (sequence length total = 1217)
 *   - input  shape: [1, 1217, 3075]  (patch tensor — see preprocessor)
 *   - output shape: [1, 1]           (MOS score directly in [0, 100])
 *
 * The "v1" suffix in the filename anchors the modelVersion string written
 * to each image's sidecar (ai-inference-host derives it via
 * path.basename(loader.modelFile, '.onnx')). When a future revision is
 * bundled (e.g. recalibrated, re-trained, or re-exported with a different
 * cap), bump to -v2 so historical operator-decision data stays attributed
 * to the model that actually scored each image.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const preprocessor = require('./musiq-preprocessor');

const MODEL_FILE = 'musiq-spaq-3scale-cap1024-v1.onnx';

// Verified against the bundled ONNX — see conversion script at
// tools/onnx-export/_musiq_src/convert_3scale_capped.py and the sidecar
// metadata at tools/onnx-export/musiq-spaq-3scale-cap1024.model.json.
const INPUT_NAME  = 'input';
const OUTPUT_NAME = 'output';
const INPUT_SHAPE = [1, preprocessor.TOTAL_MAX_PATCHES, preprocessor.PATCH_ROW_DIM];

function resolveModelPath(override) {
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'models'))) {
    return path.join(process.resourcesPath, 'models', 'musiq', MODEL_FILE);
  }
  return path.join(__dirname, '..', '..', '..', '..', 'resources', 'models', 'musiq', MODEL_FILE);
}

/**
 * Run the JS preprocessor on the image and return an ort.Tensor ready for
 * the bundled MUSIQ-SPAQ ONNX. The preprocessor handles aspect-preserving
 * Lanczos3 resizes for the 224 and 384 short scales, native-resolution
 * patch extraction for the third scale, hashed-spatial-pos-embedding
 * indexes, scale-id tagging, and mask-aware row-major truncation/padding
 * up to the 1217-row cap.
 *
 * Image inputs whose dimensions are not multiples of 32 are handled
 * correctly via the SAME-padding semantics implemented in
 * musiq-preprocessor.extract_32x32_patches (verified byte-exact against
 * tf.image.extract_patches; see conversion-audit.md § "SAME-Padding Bug
 * Discovery" for why this matters).
 */
async function prepareTensor(imagePath, ort) {
  const buf = await preprocessor.preprocess(imagePath);
  return new ort.Tensor('float32', buf, INPUT_SHAPE);
}

/**
 * Convert raw model output into the caller-facing shape:
 *   { score: number (0-100) }
 *
 * MUSIQ-SPAQ's head outputs a Mean Opinion Score directly in [0, 100];
 * no scaling is needed. The TOPIQ-era `*100` heuristic that was here
 * before is removed — for MUSIQ-SPAQ a clamp is the only required step.
 */
function postprocess(rawOutput) {
  if (!rawOutput || rawOutput.length < 1) {
    throw new Error('musiq postprocess: empty output');
  }
  const raw = rawOutput[0];
  const score = Math.max(0, Math.min(100, raw));
  return { score };
}

module.exports = {
  modelId: 'musiq',
  modelFile: MODEL_FILE,
  inputName: INPUT_NAME,
  outputName: OUTPUT_NAME,
  // imageSize is no longer meaningful for MUSIQ (input is a patch tensor,
  // not a fixed-shape image), but ai-inference-host's warmup helper reads
  // this field to allocate a zero tensor for warmup. Skip warmup by not
  // exposing imageSize — host code already handles the fallback.
  resolveModelPath,
  prepareTensor,
  postprocess,
};
