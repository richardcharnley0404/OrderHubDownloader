/**
 * src/main/services/ai-inference-models/orientation-loader.js
 *
 * Model-specific configuration for the PW-007 orientation model
 * (EfficientNetV2-S, 4-class image-rotation classifier).
 *
 * This module is consumed by `ai-inference-host.js` running inside the
 * utilityProcess. It owns:
 *   - Path resolution for the bundled .onnx file.
 *   - Constants (input/output names, image size, normalization stats).
 *   - `prepareTensor(imagePath, ort)` — sharp preprocessing → ort.Tensor.
 *   - `postprocess(rawOutputArray)` → { predictedClass, predictedAngle,
 *                                        confidence, classScores }
 *
 * The shape and numeric contract MUST match the original
 * `orientation-service.js` implementation byte-for-byte — Step 3's parity
 * check is the gate for shipping the refactor.
 *
 * This file is loaded INSIDE the utility process, so it can require
 * native deps (sharp, onnxruntime-node) freely. It must not require
 * anything from the main-process service tree (config-service, logger,
 * etc) — those don't exist in the utility-process world.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// IMPORTANT: keep these constants in sync with orientation-service.js.
// They are duplicated by design — orientation-service still owns the
// caller-side contract, this module owns the inference-side contract.
// Step 3 will keep the constants only here once orientation-service stops
// loading ONNX directly.
const MODEL_FILE = 'orientation_model_v2_0.9882.onnx';
const INPUT_NAME = 'input';
const OUTPUT_NAME = 'output';
const IMG_SIZE = 384;

// ImageNet normalisation (EfficientNetV2 pretraining convention — the
// orientation fine-tune kept the same transforms).
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD  = [0.229, 0.224, 0.225];

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk path to the orientation model file.
 *
 * In a packaged Electron app, `process.resourcesPath` resolves to the
 * Electron resources directory. Because `resources/models/**` is in
 * electron-builder's `asarUnpack` list, the .onnx file is unpacked to the
 * real filesystem and readable by onnxruntime-node.
 *
 * In dev, we resolve relative to the repo root: ../../../../resources/models
 * (from src/main/services/ai-inference-models/).
 *
 * `override` (optional): an absolute path passed in from main via the
 * fork() options. orientation-service used to honour
 * `filmScanRotationModelPath` from config; that override is now passed
 * across the IPC boundary in Step 3.
 */
function resolveModelPath(override) {
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }

  // Packaged: <app>/resources/models/orientation/<MODEL_FILE>
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'models'))) {
    return path.join(process.resourcesPath, 'models', 'orientation', MODEL_FILE);
  }

  // Dev fallback — four levels up from src/main/services/ai-inference-models/
  return path.join(__dirname, '..', '..', '..', '..', 'resources', 'models', 'orientation', MODEL_FILE);
}

// ---------------------------------------------------------------------------
// Preprocessing — image → [1, 3, 384, 384] float32 tensor
// ---------------------------------------------------------------------------

/**
 * Decode an image file and prepare it as an [1, 3, 384, 384] float32 tensor
 * in ImageNet-normalised NCHW order.
 *
 * sharp options (replicated 1:1 from orientation-service for parity):
 *   - limitInputPixels: false — high-res scanner JPGs/TIFFs routinely exceed
 *     sharp's default 268MP cap.
 *   - failOn: 'none' — tolerate truncated trailers / non-fatal libvips
 *     warnings (common on scanner output).
 *   - removeAlpha + flatten('#ffffff') — collapse any alpha to a white BG.
 *   - resize(IMG_SIZE, IMG_SIZE, { fit: 'fill' }) — stretch, do NOT crop;
 *     edge features matter for orientation classification.
 */
async function prepareTensor(imagePath, ort) {
  const { data } = await sharp(imagePath, { limitInputPixels: false, failOn: 'none' })
    .removeAlpha()
    .flatten({ background: '#ffffff' })
    .resize(IMG_SIZE, IMG_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // data is HWC interleaved uint8, length = IMG_SIZE*IMG_SIZE*3.
  // Transpose to CHW and normalise per channel in one pass.
  const plane = IMG_SIZE * IMG_SIZE;
  const out = new Float32Array(3 * plane);

  for (let i = 0; i < plane; i++) {
    const src = i * 3;
    out[i]             = (data[src]     / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    out[i + plane]     = (data[src + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    out[i + 2 * plane] = (data[src + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  return new ort.Tensor('float32', out, [1, 3, IMG_SIZE, IMG_SIZE]);
}

// ---------------------------------------------------------------------------
// Postprocessing — logits → caller result shape
// ---------------------------------------------------------------------------

function softmax(arr) {
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  const exps = new Array(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const e = Math.exp(arr[i] - max);
    exps[i] = e;
    sum += e;
  }
  for (let i = 0; i < exps.length; i++) exps[i] /= sum;
  return exps;
}

function argmax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}

function classToAngle(predictedClass) {
  switch (predictedClass) {
    case 1:  return 90;
    case 2:  return 180;
    case 3:  return 270;
    case 0:
    default: return 0;
  }
}

/**
 * Convert raw logits (length-4 number array) into the shape orientation-service
 * exposes to its callers. NB: `inferenceMs` is appended by the host after
 * timing the full prepare→run→postprocess loop.
 */
function postprocess(logits) {
  if (!logits || logits.length !== 4) {
    throw new Error(`unexpected output length ${logits ? logits.length : 'null'} (expected 4)`);
  }
  const scores = softmax(logits);
  const predictedClass = argmax(scores);
  const confidence = scores[predictedClass];
  const predictedAngle = classToAngle(predictedClass);
  return {
    predictedClass,
    predictedAngle,
    confidence,
    classScores: scores,
  };
}

// ---------------------------------------------------------------------------
// Public surface for the host
// ---------------------------------------------------------------------------

module.exports = {
  modelId: 'orientation',
  modelFile: MODEL_FILE,
  inputName: INPUT_NAME,
  outputName: OUTPUT_NAME,
  imageSize: IMG_SIZE,
  resolveModelPath,
  prepareTensor,
  postprocess,
  // Exported for Step 3's parity-check tests.
  _internal: { softmax, argmax, classToAngle },
};
