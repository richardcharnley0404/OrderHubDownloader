'use strict';

/**
 * src/main/enhancement/enhancementManager.js
 *
 * Orchestration layer for AI image enhancement.
 *
 * Routes enhancement calls to the configured provider:
 *
 *   local   — Pixfizz AI Enhancement (Real-ESRGAN, runs in the inference
 *             utility process). No API key. Default for fresh installs.
 *   topaz   — Topaz Image API (cloud, premium). Requires topazApiKey.
 *
 * The legacy Replicate provider was removed in M2 of the local-enhancement
 * plan. The defensive remap in getProvider() silently treats stored
 * `enhancementProvider: 'replicate'` as `'local'` until M3's config
 * migration rewrites the value on disk.
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
 * Universal rescore (per Phase 1 plan §0.6): every successful enhancement
 * runs a MUSIQ scoring pass before and after, regardless of provider. The
 * `scoreBefore` is captured from the working file just before enhancement
 * kicks off; `scoreAfter` from the enhanced cache file just after. Both
 * land in the per-image sidecar entry alongside the existing enhancement
 * metadata. Operators see "Score: 38 → 67" in the Job Review drawer.
 *
 * Job-ID dispatch (checkEnhancement / cancelEnhancement):
 *   prefix `topaz_` → topazJobs map, in-memory state
 *   prefix `local_` → localJobs map, in-memory state
 *
 * Exports:
 *   enhanceImage(jobId, jobPath, filename, options)          → cachePath
 *   startEnhancement(jobId, jobPath, filename, options)      → jobId string
 *   checkEnhancement(jobId)                                  → { status, outputPath?, ... }
 *   cancelEnhancement(jobId)                                 → void
 *   validateApiKey(apiKey, provider)                         → { valid, error? }
 */

const path = require('path');
const fs   = require('fs/promises');

const topazClient = require('./topazClient');
const localClient = require('./localClient');

const { loadSidecar, saveSidecar } = require('../jobs/sidecarManager');
const originalsManager = require('../jobs/originalsManager');
const aiQualityService = require('../services/ai-quality-service');
const aiInferenceClient = require('../services/ai-inference-client');
const configService = require('../services/config-service');
const logger = require('../services/logger');

// ── In-memory registries ──────────────────────────────────────────────────────

/**
 * Topaz: maps syntheticId → { status, jobId, jobPath, filename, cachePath, model,
 *                              outputPath?, error?, scoreBefore? }
 * 'status' values: 'processing' | 'succeeded' | 'failed'
 */
const topazJobs = new Map();

/**
 * Local (Pixfizz AI): maps syntheticId → same shape as topazJobs plus the
 * tile-pipeline metadata returned by localClient.enhance().
 */
const localJobs = new Map();

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
 * Mark an image in the sidecar as successfully enhanced. Extends the
 * existing enhancement fields with optional rescore + provider-specific
 * pipeline metadata (tile counts, EP, model version) — older sidecar
 * consumers tolerate field absence.
 */
async function updateSidecarEnhancement(jobId, jobPath, filename, cachePath, extras = {}) {
  const { sidecar } = await loadSidecar(jobId, jobPath);

  const updatedImages = sidecar.images.map(img => {
    if (img.filename !== filename) return img;
    const next = {
      ...img,
      enhanced:          true,
      enhancementSource: extras.source || 'local',
      enhancedPath:      cachePath,
      enhancedAt:        new Date().toISOString(),
      enhancementModel:  extras.model || null,
    };
    if (typeof extras.scoreBefore === 'number') next.scoreBefore = extras.scoreBefore;
    if (typeof extras.scoreAfter  === 'number') next.scoreAfter  = extras.scoreAfter;
    if (extras.scoreModel)     next.scoreModel = extras.scoreModel;
    if (extras.triggeredBy)    next.enhancementTriggeredBy = extras.triggeredBy;
    if (extras.providerMeta && typeof extras.providerMeta === 'object') {
      // Flatten provider-specific fields directly onto the image entry —
      // matches the sidecar shape in plan §5 (tileCount, tileSize, etc.
      // sit alongside the existing enhancement fields).
      Object.assign(next, extras.providerMeta);
    }
    return next;
  });

  await saveSidecar({ ...sidecar, images: updatedImages }, jobPath);
}

/**
 * Return the active enhancement provider, normalised. Stored
 * `enhancementProvider: 'replicate'` (legacy) is silently treated as
 * `'local'`; the warning is logged once per call for traceability until
 * M3's config migration rewrites the stored value.
 */
function getProvider() {
  const stored = configService.get('enhancementProvider') || 'local';
  if (stored === 'replicate') {
    logger.logWarning(
      '[enhancement] enhancementProvider="replicate" is no longer supported and is being ' +
      'treated as "local"; the value will be migrated to "local" on next config save.'
    );
    return 'local';
  }
  if (stored === 'topaz' || stored === 'local') return stored;
  logger.logWarning(`[enhancement] unknown enhancementProvider="${stored}", falling back to "local"`);
  return 'local';
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

/**
 * Optionally rescore an image with MUSIQ. Returns `{ score, modelVersion }`
 * on success, `null` if rescoring is disabled, the AI Quality service is
 * unavailable, or the underlying scoreImage call returns an error.
 *
 * Rescoring is governed by `enhancementRescoreAfter` (default true). When
 * disabled, both before and after passes are skipped.
 */
async function maybeRescore(imagePath) {
  if (configService.get('enhancementRescoreAfter') === false) return null;
  try {
    const result = await aiQualityService.scoreImage(imagePath);
    if (result && typeof result.score === 'number' && !result.error) {
      return { score: result.score, modelVersion: result.modelVersion || null };
    }
    return null;
  } catch (err) {
    logger.logError(`[enhancement] rescore failed for ${path.basename(imagePath)}`, err);
    return null;
  }
}

// ── Public API — blocking ─────────────────────────────────────────────────────

/**
 * Run a full enhancement pipeline synchronously (blocking).
 * Routes to the configured provider, wraps with the universal rescore
 * hook, and writes one consolidated sidecar update on success.
 *
 * @param {string} jobId
 * @param {string} jobPath
 * @param {string} filename  Bare filename, e.g. "IMG_001.jpg"
 * @param {object} [options] { model, faceEnhancement, triggeredBy?, ... }
 * @returns {Promise<string>} Absolute path to the cached enhanced file
 */
async function enhanceImage(jobId, jobPath, filename, options = {}) {
  const provider  = getProvider();
  const cacheDir  = path.join(jobPath, 'cache');
  const cachePath = buildCachePath(jobPath, filename);
  const inputPath = path.join(jobPath, 'working', filename);

  await fs.mkdir(cacheDir, { recursive: true });
  await originalsManager.ensureOriginals(jobPath);

  // Capture pre-enhancement quality score from the working file. This
  // happens before any provider work so the score reflects the actual
  // input the provider sees.
  const before = await maybeRescore(inputPath);

  if (provider === 'topaz') {
    const apiKey = requireTopazApiKey();
    await fs.copyFile(inputPath, cachePath);
    await topazClient.enhance(cachePath, {
      model:            options.model           || configService.get('topazDefaultModel') || 'Standard V2',
      face_enhancement: Boolean(options.faceEnhancement),
    }, apiKey);
    await fs.copyFile(cachePath, inputPath);

    const after = await maybeRescore(cachePath);
    await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, {
      model:       options.model,
      source:      'topaz-direct',
      scoreBefore: before && before.score,
      scoreAfter:  after  && after.score,
      scoreModel:  (after && after.modelVersion) || (before && before.modelVersion),
      triggeredBy: options.triggeredBy || 'operator',
      providerMeta: { provider: 'topaz' },
    });
    return cachePath;
  }

  // Local (Pixfizz AI Enhancement) — only remaining branch.
  await fs.copyFile(inputPath, cachePath);
  const meta = await localClient.enhance(cachePath, {
    tileSize:    options.tileSize,
    tileOverlap: options.tileOverlap,
  });
  await fs.copyFile(cachePath, inputPath);

  const after = await maybeRescore(cachePath);
  await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, {
    model:       'realesr-general-x4v3',
    source:      'local',
    scoreBefore: before && before.score,
    scoreAfter:  after  && after.score,
    scoreModel:  (after && after.modelVersion) || (before && before.modelVersion),
    triggeredBy: options.triggeredBy || 'operator',
    providerMeta: {
      provider:          'local',
      modelVersion:      'realesr-general-x4v3',
      inferenceMs:       meta.inferenceMs,
      tileCount:         meta.tileCount,
      tileSize:          meta.tileSize,
      tileOverlap:       meta.tileOverlap,
      executionProvider: meta.executionProvider,
      sourceWidth:       meta.sourceWidth,
      sourceHeight:      meta.sourceHeight,
      outputWidth:       meta.outputWidth,
      outputHeight:      meta.outputHeight,
    },
  });
  return cachePath;
}

// ── Public API — non-blocking polling ────────────────────────────────────────

/**
 * Start an enhancement job without waiting for it to finish.
 * Returns a synthetic job ID string immediately; the caller polls
 * checkEnhancement().
 *
 *   local:  "local_..." ID; tile-and-stitch runs in the inference host.
 *   topaz:  "topaz_..." ID; HTTP pipeline runs in a background promise.
 */
async function startEnhancement(jobId, jobPath, filename, options = {}) {
  const provider  = getProvider();
  const cacheDir  = path.join(jobPath, 'cache');
  const cachePath = buildCachePath(jobPath, filename);
  const inputPath = path.join(jobPath, 'working', filename);

  await fs.mkdir(cacheDir, { recursive: true });
  await originalsManager.ensureOriginals(jobPath);

  const before = await maybeRescore(inputPath);

  // ── Local (Pixfizz AI) path ─────────────────────────────────────────────────
  if (provider === 'local') {
    await fs.copyFile(inputPath, cachePath);

    const syntheticId = `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localJobs.set(syntheticId, {
      status: 'processing',
      jobId, jobPath, filename, cachePath,
      model: 'realesr-general-x4v3',
      scoreBefore: before && before.score,
    });

    // Fire and forget — checkEnhancement() observes the registry.
    localClient.enhance(cachePath, {
      tileSize:    options.tileSize,
      tileOverlap: options.tileOverlap,
    })
      .then(async (meta) => {
        await fs.copyFile(cachePath, inputPath);
        const after = await maybeRescore(cachePath);
        await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, {
          model:       'realesr-general-x4v3',
          source:      'local',
          scoreBefore: before && before.score,
          scoreAfter:  after  && after.score,
          scoreModel:  (after && after.modelVersion) || (before && before.modelVersion),
          triggeredBy: options.triggeredBy || 'operator',
          providerMeta: {
            provider:          'local',
            modelVersion:      'realesr-general-x4v3',
            inferenceMs:       meta.inferenceMs,
            tileCount:         meta.tileCount,
            tileSize:          meta.tileSize,
            tileOverlap:       meta.tileOverlap,
            executionProvider: meta.executionProvider,
            sourceWidth:       meta.sourceWidth,
            sourceHeight:      meta.sourceHeight,
            outputWidth:       meta.outputWidth,
            outputHeight:      meta.outputHeight,
          },
        });
        localJobs.set(syntheticId, {
          status: 'succeeded',
          outputPath: cachePath,
          scoreBefore: before && before.score,
          scoreAfter:  after  && after.score,
          meta,
        });
      })
      .catch((err) => {
        localJobs.set(syntheticId, { status: 'failed', error: err.message });
        logger.logError(`[enhancement] local job ${syntheticId} failed`, err);
      });

    return syntheticId;
  }

  // ── Topaz Direct path ──────────────────────────────────────────────────────
  const apiKey = requireTopazApiKey();
  const model  = options.model || configService.get('topazDefaultModel') || 'Standard V2';

  await fs.copyFile(inputPath, cachePath);

  const syntheticId = `topaz_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  topazJobs.set(syntheticId, {
    status: 'processing',
    jobId, jobPath, filename, cachePath, model,
    scoreBefore: before && before.score,
  });

  topazClient.enhance(cachePath, {
    model,
    face_enhancement: Boolean(options.faceEnhancement),
  }, apiKey)
    .then(async () => {
      await fs.copyFile(cachePath, inputPath);
      const after = await maybeRescore(cachePath);
      await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, {
        model,
        source:      'topaz-direct',
        scoreBefore: before && before.score,
        scoreAfter:  after  && after.score,
        scoreModel:  (after && after.modelVersion) || (before && before.modelVersion),
        triggeredBy: options.triggeredBy || 'operator',
        providerMeta: { provider: 'topaz' },
      });
      topazJobs.set(syntheticId, {
        status: 'succeeded',
        outputPath: cachePath,
        scoreBefore: before && before.score,
        scoreAfter:  after  && after.score,
      });
    })
    .catch((err) => {
      topazJobs.set(syntheticId, { status: 'failed', error: err.message });
    });

  return syntheticId;
}

/**
 * Poll the status of an active enhancement job.
 *
 * Dispatch by job-ID prefix:
 *   "local_..." → localJobs map
 *   "topaz_..." → topazJobs map
 *
 * Any other prefix is treated as an unknown / stale ID — most likely a
 * leftover Replicate prediction ID from a pre-M2 install — and reported
 * as failed-not-found.
 */
async function checkEnhancement(id) {
  if (id.startsWith('local_')) {
    const job = localJobs.get(id);
    if (!job) {
      return { status: 'failed', error: 'Enhancement job not found — the app may have restarted.' };
    }
    if (job.status === 'succeeded') {
      localJobs.delete(id);
      return {
        status: 'succeeded',
        outputPath: job.outputPath,
        scoreBefore: job.scoreBefore,
        scoreAfter:  job.scoreAfter,
        meta: job.meta,
      };
    }
    if (job.status === 'failed') {
      localJobs.delete(id);
      return { status: 'failed', error: job.error };
    }
    return { status: 'processing' };
  }

  if (id.startsWith('topaz_')) {
    const job = topazJobs.get(id);
    if (!job) {
      return { status: 'failed', error: 'Enhancement job not found — the app may have restarted.' };
    }
    if (job.status === 'succeeded') {
      topazJobs.delete(id);
      return {
        status: 'succeeded',
        outputPath: job.outputPath,
        scoreBefore: job.scoreBefore,
        scoreAfter:  job.scoreAfter,
      };
    }
    if (job.status === 'failed') {
      topazJobs.delete(id);
      return { status: 'failed', error: job.error };
    }
    return { status: 'processing' };
  }

  return {
    status: 'failed',
    error: `Unrecognised enhancement job ID '${id}'. Legacy Replicate jobs are no longer supported.`,
  };
}

/**
 * Cancel an in-progress enhancement job.
 *
 * Local: cooperative — drops the manager-side bookkeeping. The tile loop
 *        in localClient continues unless the renderer also calls
 *        localClient.cancel directly. M5 polish will plumb a cancel flag
 *        through the manager; for now, dropping the registry entry is
 *        sufficient for the existing renderer flow.
 * Topaz: cannot interrupt in-flight HTTP; just deregister so the result
 *        is discarded when it arrives.
 */
async function cancelEnhancement(id) {
  if (id.startsWith('local_')) {
    localJobs.delete(id);
    return;
  }
  if (id.startsWith('topaz_')) {
    topazJobs.delete(id);
    return;
  }
  // Unknown / legacy ID — silent no-op.
}

/**
 * Validate an API key for the given provider.
 *
 * For 'local' there is no key — the validator returns `{ valid: true }` if
 * the inference host has the realesrgan model loaded, `{ valid: false }`
 * otherwise. Used by the Settings "Test" button.
 */
async function validateApiKey(apiKey, provider) {
  const p = provider || getProvider();
  if (p === 'local') {
    try {
      await aiInferenceClient.init();
      if (aiInferenceClient.hasModel('realesrgan')) {
        return { valid: true };
      }
      return { valid: false, error: 'Pixfizz AI Enhancement model is not loaded by the inference host.' };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }
  if (p === 'topaz') {
    return topazClient.testApiKey(apiKey);
  }
  return { valid: false, error: `Unknown provider '${p}'.` };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  enhanceImage,
  startEnhancement,
  checkEnhancement,
  cancelEnhancement,
  validateApiKey,
};
