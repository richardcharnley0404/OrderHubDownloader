'use strict';

/**
 * src/main/enhancement/replicateClient.js
 *
 * Wraps the Replicate Node.js SDK (v1.x) for AI image upscaling via the
 * Topaz Labs image-upscale model on Replicate.
 *
 * Two usage modes:
 *
 *   Blocking  — runUpscale()    waits for the prediction to finish and saves
 *               the result to disk in one call.  Simple; blocks for ~60 s.
 *
 *   Polling   — startUpscale()  creates a prediction and returns immediately
 *               with a predictionId.  The caller polls getPrediction() for
 *               status and calls downloadFile() when 'succeeded'.
 *               Use this from IPC handlers to avoid blocking the main process.
 *
 * Exports:
 *   runUpscale(apiKey, inputPath, cachePath, options)
 *   startUpscale(apiKey, inputPath, options)            → predictionId
 *   getPrediction(apiKey, predictionId)                 → { status, outputUrl?, error? }
 *   cancelPrediction(apiKey, predictionId)
 *   downloadFile(url, destPath)
 *   validateApiKey(apiKey)                              → { valid, error? }
 */

const Replicate = require('replicate');
const fs        = require('fs');
const https     = require('https');
const path      = require('path');

const MODEL = 'topazlabs/image-upscale';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read an image from disk and return it as a base64 data URI.
 * Replicate accepts data URIs as model inputs when uploading via the SDK.
 *
 * @param {string} inputPath  Absolute path to a .jpg/.jpeg/.png image
 * @returns {Promise<string>} Data URI, e.g. "data:image/jpeg;base64,..."
 */
async function toDataUri(inputPath) {
  const imageBuffer = await fs.promises.readFile(inputPath);
  const base64      = imageBuffer.toString('base64');
  const ext         = path.extname(inputPath).replace('.', '').toLowerCase();
  const mimeType    = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Build the input object for the topazlabs/image-upscale model.
 * Only includes optional tuning params when explicitly provided (null/undefined → omit).
 *
 * Available models:
 *   'Standard V2'       (default — best for most photos)
 *   'High Fidelity V2'
 *   'Low Resolution V2'
 *   'Recovery V2'
 *
 * @param {string} dataUri
 * @param {object} [options]  { model, faceEnhancement, sharpen, denoise, fixCompression }
 * @returns {object}
 */
function buildInput(dataUri, options = {}) {
  const input = {
    image:            dataUri,
    model:            options.model             || 'Standard V2',
    output_format:    'jpg',
    output_quality:   95,
    face_enhancement: options.faceEnhancement   || false,
  };

  // Optional fine-tuning params — only sent when the caller explicitly sets them.
  if (options.sharpen        != null) input.sharpen         = options.sharpen;
  if (options.denoise        != null) input.denoise         = options.denoise;
  if (options.fixCompression != null) input.fix_compression = options.fixCompression;

  return input;
}

// ── File download ─────────────────────────────────────────────────────────────

/**
 * Download a URL to a local file path.
 * Used to save the enhanced image output from Replicate to /cache/.
 *
 * @param {string} url       HTTPS URL of the output image
 * @param {string} destPath  Absolute destination path
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run an upscale prediction to completion (blocking — waits ~30–60 s).
 * Downloads the result to cachePath and returns that path.
 *
 * Uses `useFileOutput: false` so run() returns a raw URL string (not a
 * FileOutput object) — compatible with downloadFile() directly.
 *
 * @param {string} apiKey
 * @param {string} inputPath   Absolute path to source image (from /working/)
 * @param {string} cachePath   Destination path for enhanced output (in /cache/)
 * @param {object} [options]   { model, faceEnhancement, sharpen, denoise, fixCompression }
 * @returns {Promise<string>}  cachePath on success
 */
async function runUpscale(apiKey, inputPath, cachePath, options = {}) {
  const replicate = new Replicate({ auth: apiKey, useFileOutput: false });
  const dataUri   = await toDataUri(inputPath);
  const input     = buildInput(dataUri, options);

  // replicate.run() blocks until the prediction completes.
  // With useFileOutput: false, output is a plain URL string.
  const output = await replicate.run(MODEL, { input });

  await downloadFile(output, cachePath);
  return cachePath;
}

/**
 * Start an upscale prediction without waiting for it to finish.
 * Returns the Replicate prediction ID immediately so the caller can poll
 * status via getPrediction() and download the result when 'succeeded'.
 *
 * Use this from IPC handlers to avoid blocking the main process.
 *
 * @param {string} apiKey
 * @param {string} inputPath  Absolute path to source image
 * @param {object} [options]  { model, faceEnhancement, sharpen, denoise, fixCompression }
 * @returns {Promise<string>} Replicate prediction ID
 */
async function startUpscale(apiKey, inputPath, options = {}) {
  const replicate = new Replicate({ auth: apiKey });
  const dataUri   = await toDataUri(inputPath);
  const input     = buildInput(dataUri, options);

  // Resolve the latest published version ID for the model.
  const model      = await replicate.models.get('topazlabs', 'image-upscale');
  const versionId  = model.latest_version.id;

  const prediction = await replicate.predictions.create({ version: versionId, input });
  return prediction.id;
}

/**
 * Poll the current status of a prediction.
 *
 * Replicate prediction statuses:
 *   'starting'   — queued, not yet running
 *   'processing' — actively running
 *   'succeeded'  — complete; outputUrl contains the result URL
 *   'failed'     — error; error field contains the message
 *   'canceled'   — cancelled by the client
 *
 * @param {string} apiKey
 * @param {string} predictionId
 * @returns {Promise<{ status: string, outputUrl?: string, error?: string }>}
 */
async function getPrediction(apiKey, predictionId) {
  // useFileOutput: false so output is a plain URL string if present.
  const replicate  = new Replicate({ auth: apiKey, useFileOutput: false });
  const prediction = await replicate.predictions.get(predictionId);

  return {
    status:    prediction.status,
    outputUrl: prediction.output ? String(prediction.output) : undefined,
    error:     prediction.error  || undefined,
  };
}

/**
 * Cancel a running or queued prediction.
 * Safe to call on an already-completed prediction (Replicate ignores it).
 *
 * @param {string} apiKey
 * @param {string} predictionId
 * @returns {Promise<void>}
 */
async function cancelPrediction(apiKey, predictionId) {
  const replicate = new Replicate({ auth: apiKey });
  await replicate.predictions.cancel(predictionId);
}

/**
 * Validate a Replicate API key by fetching the Topaz model metadata.
 * Does not run any inference — fast, safe, and cost-free.
 *
 * Used by the Settings screen "Test" button (ohd:enhancement:test IPC).
 *
 * @param {string} apiKey
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
async function validateApiKey(apiKey) {
  try {
    const replicate = new Replicate({ auth: apiKey });
    await replicate.models.get('topazlabs', 'image-upscale');
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  runUpscale,
  startUpscale,
  getPrediction,
  cancelPrediction,
  downloadFile,
  validateApiKey,
};
