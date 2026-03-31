'use strict';

/**
 * src/main/enhancement/enhancementManager.js
 *
 * Orchestration layer for AI image enhancement.
 *
 * Routes enhancement calls to the correct provider based on the
 * 'enhancementProvider' config key ('replicate' or 'topaz').
 *
 * Two operation modes (shared by both providers):
 *
 *   Blocking  — enhanceImage()       runs a full enhancement pipeline in one
 *               await.  Suitable for scripted or test use.
 *
 *   Polling   — startEnhancement()   starts an enhancement job and returns a
 *               job ID immediately (does not block the caller).
 *               checkEnhancement()   polls status; when 'succeeded' the
 *               result is already on disk and the sidecar is updated.
 *               cancelEnhancement()  cancels / removes from registry.
 *
 * Provider behaviour:
 *
 *   replicate — startUpscale() returns a Replicate prediction ID immediately;
 *               the renderer polls checkEnhancement() which in turn polls the
 *               Replicate API.  IDs are plain strings like "abc123xyz".
 *
 *   topaz     — topazClient.enhance() blocks internally (polls Topaz API).
 *               A synthetic ID prefixed "topaz_" is returned immediately;
 *               the job runs in a background promise tracked in topazJobs.
 *               The renderer polls checkEnhancement() which reads topazJobs.
 *               IDs look like "topaz_1712345678901_a3f".
 *
 * Exports:
 *   enhanceImage(jobId, jobPath, filename, options)          → cachePath
 *   startEnhancement(jobId, jobPath, filename, options)      → jobId string
 *   checkEnhancement(jobId)                                  → { status, outputPath? }
 *   cancelEnhancement(jobId)                                 → void
 *   validateApiKey(apiKey, provider)                         → { valid, error? }
 */

const path = require('path');
const fs   = require('fs/promises');
const fsSync = require('fs');

const replicateClient = require('./replicateClient');
const topazClient     = require('./topazClient');

const { loadSidecar, saveSidecar } = require('../jobs/sidecarManager');
const configService = require('../services/config-service');

// ── In-memory registries ──────────────────────────────────────────────────────

/**
 * Replicate: maps predictionId → { jobId, jobPath, filename, cachePath, model }
 * Lost if Electron restarts — acceptable, operator can re-run.
 */
const activePredictions = new Map();

/**
 * Topaz: maps syntheticId → { status, jobId, jobPath, filename, cachePath, model, outputPath?, error? }
 * 'status' values: 'processing' | 'succeeded' | 'failed'
 */
const topazJobs = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the /cache/ path where the enhanced version of a file is stored.
 * Pattern: {jobPath}/cache/{baseName}_enhanced.jpg
 */
function buildCachePath(jobPath, filename) {
  const ext      = path.extname(filename);
  const baseName = path.basename(filename, ext);
  return path.join(jobPath, 'cache', `${baseName}_enhanced.jpg`);
}

/**
 * Mark an image in the sidecar as successfully enhanced.
 *
 * @param {string} jobId
 * @param {string} jobPath
 * @param {string} filename
 * @param {string} cachePath   Absolute path to the enhanced file
 * @param {string} [model]     Model display name, e.g. "Standard V2"
 * @param {string} [source]    Provider label, e.g. "Replicate/Topaz" or "Topaz Direct"
 */
async function updateSidecarEnhancement(jobId, jobPath, filename, cachePath, model, source) {
  const { sidecar } = await loadSidecar(jobId, jobPath);

  const updatedImages = sidecar.images.map(img => {
    if (img.filename !== filename) return img;
    return {
      ...img,
      enhanced:          true,
      enhancementSource: source || 'Replicate/Topaz',
      enhancedPath:      cachePath,
      enhancedAt:        new Date().toISOString(),
      enhancementModel:  model || null,
    };
  });

  await saveSidecar({ ...sidecar, images: updatedImages }, jobPath);
}

/**
 * Return the active enhancement provider ('replicate' or 'topaz').
 * Defaults to 'replicate' if not configured.
 */
function getProvider() {
  return configService.get('enhancementProvider') || 'replicate';
}

/**
 * Read the Replicate API key from config; throw if missing.
 */
function requireReplicateApiKey() {
  const apiKey = configService.get('replicateApiKey');
  if (!apiKey) {
    throw new Error('Replicate API key is not configured. Add it in Settings → AI Enhancement.');
  }
  return apiKey;
}

/**
 * Read the Topaz API key from config; throw if missing.
 */
function requireTopazApiKey() {
  const apiKey = configService.get('topazApiKey');
  if (!apiKey) {
    throw new Error('Topaz API key is not configured. Add it in Settings → AI Enhancement.');
  }
  return apiKey;
}

// ── Public API — blocking ─────────────────────────────────────────────────────

/**
 * Run a full enhancement pipeline synchronously (blocking).
 * Routes to the configured provider.
 *
 * @param {string} jobId
 * @param {string} jobPath
 * @param {string} filename  Bare filename, e.g. "IMG_001.jpg"
 * @param {object} [options] { model, faceEnhancement, ... }
 * @returns {Promise<string>} Absolute path to the cached enhanced file
 */
async function enhanceImage(jobId, jobPath, filename, options = {}) {
  const provider  = getProvider();
  const cacheDir  = path.join(jobPath, 'cache');
  const cachePath = buildCachePath(jobPath, filename);

  await fs.mkdir(cacheDir, { recursive: true });

  if (provider === 'topaz') {
    const apiKey    = requireTopazApiKey();
    const inputPath = path.join(jobPath, 'working', filename);
    // Copy working file to cache as the source; enhance() overwrites it in place.
    await fs.copyFile(inputPath, cachePath);
    await topazClient.enhance(cachePath, {
      model:            options.model           || configService.get('topazDefaultModel') || 'Standard V2',
      face_enhancement: Boolean(options.faceEnhancement),
    }, apiKey);
    await fs.copyFile(cachePath, path.join(jobPath, 'working', filename));
    await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, options.model, 'topaz-direct');
  } else {
    const apiKey    = requireReplicateApiKey();
    const inputPath = path.join(jobPath, 'working', filename);
    await replicateClient.runUpscale(apiKey, inputPath, cachePath, options);
    await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, options.model, 'Replicate/Topaz');
  }

  return cachePath;
}

// ── Public API — non-blocking polling ────────────────────────────────────────

/**
 * Start an enhancement job without waiting for it to finish.
 * Returns a job ID string immediately; the caller polls checkEnhancement().
 *
 * Replicate: returns a Replicate prediction ID.
 * Topaz:     returns a synthetic "topaz_..." ID; the job runs in the background.
 *
 * @param {string} jobId
 * @param {string} jobPath
 * @param {string} filename
 * @param {object} [options]  { model, faceEnhancement, ... }
 * @returns {Promise<string>} Job/prediction ID
 */
async function startEnhancement(jobId, jobPath, filename, options = {}) {
  const provider  = getProvider();
  const cacheDir  = path.join(jobPath, 'cache');
  const cachePath = buildCachePath(jobPath, filename);

  await fs.mkdir(cacheDir, { recursive: true });

  // ── Topaz Direct path ──────────────────────────────────────────────────────
  if (provider === 'topaz') {
    const apiKey    = requireTopazApiKey();
    const inputPath = path.join(jobPath, 'working', filename);
    const model     = options.model || configService.get('topazDefaultModel') || 'Standard V2';

    // Copy working file to the cache path — topazClient.enhance() will upload
    // that file and overwrite it with the enhanced result.
    await fs.copyFile(inputPath, cachePath);

    const syntheticId = `topaz_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    topazJobs.set(syntheticId, {
      status: 'processing',
      jobId, jobPath, filename, cachePath, model,
    });

    // Fire and forget — the IPC caller will poll checkEnhancement()
    topazClient.enhance(cachePath, {
      model,
      face_enhancement: Boolean(options.faceEnhancement),
    }, apiKey)
      .then(async () => {
        await fs.copyFile(cachePath, path.join(jobPath, 'working', filename));
        await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, model, 'topaz-direct');
        topazJobs.set(syntheticId, { status: 'succeeded', outputPath: cachePath });
      })
      .catch(err => {
        topazJobs.set(syntheticId, { status: 'failed', error: err.message });
      });

    return syntheticId;
  }

  // ── Replicate path ─────────────────────────────────────────────────────────
  const apiKey    = requireReplicateApiKey();
  const inputPath = path.join(jobPath, 'working', filename);

  const predictionId = await replicateClient.startUpscale(apiKey, inputPath, options);

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
 * Poll the status of an active enhancement job.
 *
 * For Topaz jobs (ID starts with "topaz_"): reads from the in-memory topazJobs Map.
 * For Replicate jobs: polls the Replicate API.
 *
 * When status is 'succeeded':
 *   - outputPath is set (absolute path to enhanced file)
 *   - sidecar has already been updated
 *   - Job is removed from the registry
 *
 * @param {string} id  Job/prediction ID returned by startEnhancement()
 * @returns {Promise<{ status: string, outputPath?: string, error?: string }>}
 */
async function checkEnhancement(id) {
  // ── Topaz path ─────────────────────────────────────────────────────────────
  if (id.startsWith('topaz_')) {
    const job = topazJobs.get(id);
    if (!job) {
      return { status: 'failed', error: 'Enhancement job not found — the app may have restarted.' };
    }
    if (job.status === 'succeeded') {
      topazJobs.delete(id);
      return { status: 'succeeded', outputPath: job.outputPath };
    }
    if (job.status === 'failed') {
      topazJobs.delete(id);
      return { status: 'failed', error: job.error };
    }
    // 'processing' — still running
    return { status: 'processing' };
  }

  // ── Replicate path ─────────────────────────────────────────────────────────
  const apiKey = requireReplicateApiKey();
  const meta   = activePredictions.get(id);

  const prediction = await replicateClient.getPrediction(apiKey, id);
  const { status, outputUrl, error } = prediction;

  if (status === 'succeeded') {
    if (meta && outputUrl) {
      await replicateClient.downloadFile(outputUrl, meta.cachePath);
      await updateSidecarEnhancement(
        meta.jobId, meta.jobPath, meta.filename, meta.cachePath, meta.model, 'Replicate/Topaz',
      );
    }
    activePredictions.delete(id);
    return { status: 'succeeded', outputPath: meta ? meta.cachePath : undefined };
  }

  if (status === 'failed' || status === 'canceled') {
    activePredictions.delete(id);
    return { status, error };
  }

  // 'starting' or 'processing' — still in progress
  return { status };
}

/**
 * Cancel an in-progress enhancement job.
 *
 * For Topaz jobs: removes from the registry (the HTTP pipeline cannot be
 * interrupted, but the result will simply be discarded when it arrives).
 * For Replicate jobs: calls the cancel API, then removes from registry.
 *
 * @param {string} id  Job/prediction ID returned by startEnhancement()
 * @returns {Promise<void>}
 */
async function cancelEnhancement(id) {
  // ── Topaz path ─────────────────────────────────────────────────────────────
  if (id.startsWith('topaz_')) {
    // Cannot interrupt in-flight HTTP; just deregister so checkEnhancement()
    // returns 'not found' if the renderer ever polls again.
    topazJobs.delete(id);
    return;
  }

  // ── Replicate path ─────────────────────────────────────────────────────────
  const apiKey = requireReplicateApiKey();
  try {
    await replicateClient.cancelPrediction(apiKey, id);
  } finally {
    activePredictions.delete(id);
  }
}

/**
 * Validate an API key for the given provider.
 * Used by the ohd:enhancement:test IPC handler.
 * The key is passed directly from the Settings form — requireXxxApiKey() is NOT used.
 *
 * @param {string} apiKey
 * @param {string} [provider]  'replicate' | 'topaz' — defaults to configured provider
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
async function validateApiKey(apiKey, provider) {
  const p = provider || getProvider();
  if (p === 'topaz') {
    return topazClient.testApiKey(apiKey);
  }
  return replicateClient.validateApiKey(apiKey);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Blocking
  enhanceImage,

  // Non-blocking polling
  startEnhancement,
  checkEnhancement,
  cancelEnhancement,

  // Key validation (re-exported for ohd:enhancement:test IPC handler)
  validateApiKey,
};
