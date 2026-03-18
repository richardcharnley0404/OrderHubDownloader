'use strict';

/**
 * src/main/enhancement/enhancementManager.js
 *
 * Orchestration layer for AI image enhancement.
 *
 * Reads the Replicate API key from electron-store via configService, delegates
 * to replicateClient for API calls, saves results to /cache/, and updates the
 * job sidecar.
 *
 * Two operation modes:
 *
 *   Blocking  — enhanceImage()       runs a full enhancement pipeline in one
 *               await.  Suitable for scripted or test use.
 *
 *   Polling   — startEnhancement()   starts a prediction and returns a
 *               predictionId immediately (does not block).
 *               checkEnhancement()   polls status; when 'succeeded' it
 *               downloads the result and updates the sidecar automatically.
 *               cancelEnhancement()  cancels and cleans up.
 *
 * The polling mode is used by the IPC handlers so the main process is never
 * blocked for the 30–60 s that a Topaz enhancement takes.
 *
 * Exports:
 *   enhanceImage(jobId, jobPath, filename, options)          → cachePath
 *   startEnhancement(jobId, jobPath, filename, options)      → predictionId
 *   checkEnhancement(predictionId)                           → { status, outputPath? }
 *   cancelEnhancement(predictionId)                          → void
 *   validateApiKey(apiKey)                                   → { valid, error? }
 */

const path = require('path');
const fs   = require('fs/promises');

const {
  runUpscale,
  startUpscale,
  getPrediction,
  cancelPrediction,
  downloadFile,
  validateApiKey,
} = require('./replicateClient');

const { loadSidecar, saveSidecar } = require('../jobs/sidecarManager');
const configService = require('../services/config-service');

// ── In-memory prediction registry ────────────────────────────────────────────
//
// Tracks active (in-progress) predictions for the current process lifetime.
// Each entry maps a Replicate predictionId to the metadata needed to
// download and record the result once the prediction succeeds.
//
// Entry shape: { jobId, jobPath, filename, cachePath, model }
//
// Note: this map is lost if the Electron process restarts mid-enhancement.
// That is acceptable for Phase 3 — the operator sees "processing" turn into
// nothing and can re-run if needed.

const activePredictions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the /cache/ path where the enhanced version of a file is stored.
 * Pattern: {jobPath}/cache/{baseName}_enhanced.jpg
 *
 * @param {string} jobPath
 * @param {string} filename  Bare filename, e.g. "IMG_001.jpg"
 * @returns {string}
 */
function buildCachePath(jobPath, filename) {
  const ext      = path.extname(filename);
  const baseName = path.basename(filename, ext);
  return path.join(jobPath, 'cache', `${baseName}_enhanced.jpg`);
}

/**
 * Update the sidecar for a successfully enhanced image.
 * Marks enhanced: true, records the model, cache path, and timestamp.
 * Uses immutable update — never mutates the loaded sidecar object.
 *
 * @param {string} jobId
 * @param {string} jobPath
 * @param {string} filename
 * @param {string} cachePath   Absolute path to the saved enhanced file
 * @param {string} [model]     Model display name, e.g. "Standard V2"
 * @returns {Promise<void>}
 */
async function updateSidecarEnhancement(jobId, jobPath, filename, cachePath, model) {
  const { sidecar } = await loadSidecar(jobId, jobPath);

  const updatedImages = sidecar.images.map(img => {
    if (img.filename !== filename) return img;
    return {
      ...img,
      enhanced:          true,
      enhancementSource: 'Replicate/Topaz',
      enhancedPath:      cachePath,
      enhancedAt:        new Date().toISOString(),
      enhancementModel:  model || null,
    };
  });

  await saveSidecar({ ...sidecar, images: updatedImages }, jobPath);
}

/**
 * Read the Replicate API key from electron-store.
 * Throws a descriptive error if the key is not configured so callers can
 * surface a clear message to the operator.
 *
 * @returns {string}
 */
function requireApiKey() {
  const apiKey = configService.get('replicateApiKey');
  if (!apiKey) {
    throw new Error('Replicate API key is not configured. Add it in Settings → AI Enhancement.');
  }
  return apiKey;
}

// ── Public API — blocking ────────────────────────────────────────────────────

/**
 * Run a full enhancement pipeline synchronously (blocking — ~30–60 s).
 *
 * Reads the API key from settings, runs the Topaz upscale via Replicate,
 * saves the result to /cache/, and updates the sidecar.
 *
 * @param {string} jobId
 * @param {string} jobPath
 * @param {string} filename  Bare filename, e.g. "IMG_001.jpg"
 * @param {object} [options] { model, faceEnhancement, sharpen, denoise, fixCompression }
 * @returns {Promise<string>} Absolute path to the cached enhanced file
 */
async function enhanceImage(jobId, jobPath, filename, options = {}) {
  const apiKey    = requireApiKey();
  const inputPath = path.join(jobPath, 'working', filename);
  const cacheDir  = path.join(jobPath, 'cache');

  await fs.mkdir(cacheDir, { recursive: true });

  const cachePath = buildCachePath(jobPath, filename);

  await runUpscale(apiKey, inputPath, cachePath, options);
  await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, options.model);

  return cachePath;
}

// ── Public API — non-blocking polling ────────────────────────────────────────

/**
 * Start an enhancement prediction without waiting for it to finish.
 * Returns the Replicate prediction ID so the caller can poll via
 * checkEnhancement().
 *
 * Used by the ohd:enhancement:run IPC handler.
 *
 * @param {string} jobId
 * @param {string} jobPath
 * @param {string} filename
 * @param {object} [options]  { model, faceEnhancement, ... }
 * @returns {Promise<string>} predictionId
 */
async function startEnhancement(jobId, jobPath, filename, options = {}) {
  const apiKey    = requireApiKey();
  const inputPath = path.join(jobPath, 'working', filename);
  const cacheDir  = path.join(jobPath, 'cache');

  await fs.mkdir(cacheDir, { recursive: true });

  const cachePath    = buildCachePath(jobPath, filename);
  const predictionId = await startUpscale(apiKey, inputPath, options);

  // Register in the in-memory map so checkEnhancement() knows what to do
  // when the prediction succeeds.
  activePredictions.set(predictionId, {
    jobId,
    jobPath,
    filename,
    cachePath,
    model: options.model || 'Standard V2',
  });

  return predictionId;
}

/**
 * Poll the status of an active prediction.
 *
 * When status is 'succeeded':
 *   - Downloads the output image to /cache/
 *   - Updates the sidecar (enhanced: true, model, path, timestamp)
 *   - Removes the prediction from the in-memory registry
 *   - Returns { status: 'succeeded', outputPath }
 *
 * When status is 'starting' or 'processing':
 *   - Returns { status } with no outputPath (still in progress)
 *
 * When status is 'failed' or 'canceled':
 *   - Removes from registry
 *   - Returns { status, error? }
 *
 * Used by the ohd:enhancement:status IPC handler (called on a ~3 s interval
 * by the renderer).
 *
 * @param {string} predictionId
 * @returns {Promise<{ status: string, outputPath?: string, error?: string }>}
 */
async function checkEnhancement(predictionId) {
  const apiKey = requireApiKey();
  const meta   = activePredictions.get(predictionId);

  const prediction = await getPrediction(apiKey, predictionId);
  const { status, outputUrl, error } = prediction;

  if (status === 'succeeded') {
    if (meta && outputUrl) {
      await downloadFile(outputUrl, meta.cachePath);
      await updateSidecarEnhancement(
        meta.jobId, meta.jobPath, meta.filename, meta.cachePath, meta.model,
      );
    }
    activePredictions.delete(predictionId);
    return { status: 'succeeded', outputPath: meta ? meta.cachePath : undefined };
  }

  if (status === 'failed' || status === 'canceled') {
    activePredictions.delete(predictionId);
    return { status, error };
  }

  // 'starting' or 'processing' — still in progress.
  return { status };
}

/**
 * Cancel an in-progress prediction.
 * Removes it from the in-memory registry regardless of the API result.
 *
 * Used by the ohd:enhancement:cancel IPC handler.
 *
 * @param {string} predictionId
 * @returns {Promise<void>}
 */
async function cancelEnhancement(predictionId) {
  const apiKey = requireApiKey();

  try {
    await cancelPrediction(apiKey, predictionId);
  } finally {
    // Always remove from registry — even if the cancel API call fails (e.g.
    // the prediction already completed between the UI click and this call).
    activePredictions.delete(predictionId);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Blocking
  enhanceImage,

  // Non-blocking polling
  startEnhancement,
  checkEnhancement,
  cancelEnhancement,

  // Re-exported for the ohd:enhancement:test IPC handler.
  // Note: the IPC handler passes the apiKey directly from the Settings form
  // so the user can test a key before saving it — requireApiKey() is not used.
  validateApiKey,
};
