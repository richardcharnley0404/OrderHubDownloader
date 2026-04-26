/**
 * src/main/services/ai-inference-models/musiq-loader.js
 *
 * Host-side loader for the MUSIQ image-quality model
 * (AI Quality Gate, M2). Mirrors the structure of orientation-loader.js.
 *
 * NOTE — model file NOT YET BUNDLED.
 * The .onnx file is expected at resources/models/musiq/model.onnx but is
 * not in the repo as of v1.2.0-rc1. When the file is missing, the host's
 * load attempt fails gracefully, the model is absent from `loadedModels`,
 * and ai-quality-service falls back to its "always pass / forced score"
 * behaviour.
 *
 * Tensor contract — the values below are PLACEHOLDERS until verified
 * against the real .onnx file metadata. When the model is bundled, run
 * `node -e "require('onnxruntime-node').InferenceSession.create('path/to/model.onnx').then(s=>console.log(s.inputNames, s.outputNames))"`
 * and update INPUT_NAME / OUTPUT_NAME / IMG_SIZE here. The MUSIQ-SPAQ
 * variant typically uses 384x384 RGB input and outputs a single scalar
 * 0–100 quality score.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const MODEL_FILE = 'model.onnx';

// PLACEHOLDERS — verify against the actual .onnx file when bundled.
const INPUT_NAME  = 'input';
const OUTPUT_NAME = 'output';
const IMG_SIZE    = 384;

// MUSIQ-SPAQ uses standard ImageNet normalisation. If the actual model
// requires different stats, update here.
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD  = [0.229, 0.224, 0.225];

function resolveModelPath(override) {
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'models'))) {
    return path.join(process.resourcesPath, 'models', 'musiq', MODEL_FILE);
  }
  return path.join(__dirname, '..', '..', '..', '..', 'resources', 'models', 'musiq', MODEL_FILE);
}

async function prepareTensor(imagePath, ort) {
  const { data } = await sharp(imagePath, { limitInputPixels: false, failOn: 'none' })
    .removeAlpha()
    .flatten({ background: '#ffffff' })
    .resize(IMG_SIZE, IMG_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

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

/**
 * Convert raw model output into the caller-facing shape:
 *   { score: number (0-100) }
 *
 * MUSIQ output is typically a single scalar in some range — could be
 * 0–1 (needs *100), 0–10 (needs *10), or already 0–100 depending on the
 * exported variant. Verify against the actual model when bundled and
 * adjust the scaling here.
 */
function postprocess(rawOutput) {
  if (!rawOutput || rawOutput.length < 1) {
    throw new Error('musiq postprocess: empty output');
  }
  let raw = rawOutput[0];
  // PLACEHOLDER scaling — verify when the real model lands.
  // If the model already outputs 0–100, this is a no-op.
  // If the model outputs 0–1, multiply by 100.
  // If the model outputs 0–10, multiply by 10.
  let score = raw;
  if (raw <= 1.0) {
    score = raw * 100;
  } else if (raw <= 10.0) {
    score = raw * 10;
  }
  // Clamp to [0, 100] just in case.
  score = Math.max(0, Math.min(100, score));
  return { score };
}

module.exports = {
  modelId: 'musiq',
  modelFile: MODEL_FILE,
  inputName: INPUT_NAME,
  outputName: OUTPUT_NAME,
  imageSize: IMG_SIZE,
  resolveModelPath,
  prepareTensor,
  postprocess,
};
