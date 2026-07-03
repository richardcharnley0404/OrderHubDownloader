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
const perfectlyClearClient = require('./perfectlyClearClient');

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
 * Return the /cache/ path for the pre-Perfectly-Clear backup of a file.
 * Pattern: {jobPath}/cache/{baseName}_pre_pc.jpg
 *
 * First-enhancement-wins: the backup is created only if the file is not
 * already present. Subsequent PC runs on the same file leave the earliest
 * pre-PC snapshot intact, so revert always returns to the operator's first
 * pre-enhancement state regardless of how many times they re-enhanced.
 */
function buildPrePcPath(jobPath, filename) {
  const ext      = path.extname(filename);
  const baseName = path.basename(filename, ext);
  return path.join(jobPath, 'cache', `${baseName}_pre_pc.jpg`);
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
    if (extras.preEnhancePath) next.preEnhancePath = extras.preEnhancePath;
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
 * Return the active enhancement provider, normalised.
 *
 * Perfectly Clear (Jobs scope) overrides `enhancementProvider` whenever the
 * scope is enabled AND has at least one hot-folder config — disabling PC in
 * settings lets the legacy Topaz / Pixfizz-AI providers surface again, per
 * the M3 decision. Stored `enhancementProvider: 'replicate'` (legacy) is
 * silently treated as `'local'`; the warning is logged once per call for
 * traceability until M3's config migration rewrites the stored value.
 */
function getProvider() {
  // Perfectly Clear override (M3): Jobs scope enabled AND ≥1 config.
  try {
    const pc = configService.get('perfectlyClear');
    if (pc && pc.jobs && pc.jobs.enabled && Array.isArray(pc.jobs.configs) && pc.jobs.configs.length > 0) {
      return 'perfectly-clear';
    }
  } catch (_) { /* config-service unavailable — fall through to legacy path */ }

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
 * Resolve which Perfectly Clear Jobs config to use for a given call.
 *
 * Precedence (per M3 plan):
 *   1. Explicit `configId` from the caller (Job Review dropdown).
 *   2. `perfectlyClear.jobs.autoApplyConfigId` — kept for shape symmetry
 *      even though Jobs is manual-only by decision; harmless fallback.
 *   3. First config in the list.
 *
 * Returns `null` when PC.jobs is disabled or has no configs — callers
 * should treat that as "provider unavailable" and surface a settings hint.
 */
function _resolveJobsPcConfig(configId) {
  let pc;
  try {
    pc = configService.get('perfectlyClear');
  } catch (_) { return null; }
  if (!pc || !pc.jobs) return null;
  const configs = Array.isArray(pc.jobs.configs) ? pc.jobs.configs : [];
  if (!pc.jobs.enabled || configs.length === 0) return null;
  if (configId) {
    const explicit = configs.find(c => c && c.id === configId);
    if (explicit) return explicit;
  }
  if (pc.jobs.autoApplyConfigId) {
    const auto = configs.find(c => c && c.id === pc.jobs.autoApplyConfigId);
    if (auto) return auto;
  }
  return configs[0];
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

  if (provider === 'perfectly-clear') {
    const pcConfig = _resolveJobsPcConfig(options.configId);
    if (!pcConfig) {
      throw new Error('Perfectly Clear is enabled for Jobs but no configurations are available.');
    }
    await fs.copyFile(inputPath, cachePath);
    const results = await perfectlyClearClient.processBatch({
      config: pcConfig,
      files: [{ sourcePath: cachePath, destPath: cachePath }],
      timeoutMs: options.timeoutMs,
      signal:    options.signal,
    });
    const result = results && results[0];
    if (!result || result.status !== 'enhanced') {
      const reason = (result && result.status) || 'unknown';
      const detail = result && result.error ? ` (${result.error})` : '';
      throw new Error(`Perfectly Clear did not enhance ${filename}: ${reason}${detail}`);
    }

    // First-enhancement-wins backup: copy the current working file to
    // {baseName}_pre_pc.jpg BEFORE the cache→working copy-back below.
    // Subsequent PC runs on the same file leave this snapshot alone.
    const prePcPath = buildPrePcPath(jobPath, filename);
    let hasPrePc = false;
    try { await fs.access(prePcPath); hasPrePc = true; } catch (_) { hasPrePc = false; }
    if (!hasPrePc) {
      await fs.copyFile(inputPath, prePcPath);
    }

    await fs.copyFile(cachePath, inputPath);

    const after = await maybeRescore(cachePath);
    await updateSidecarEnhancement(jobId, jobPath, filename, cachePath, {
      model:          pcConfig.friendlyName || '(unnamed)',
      source:         'perfectly-clear',
      scoreBefore:    before && before.score,
      scoreAfter:     after  && after.score,
      scoreModel:     (after && after.modelVersion) || (before && before.modelVersion),
      triggeredBy:    options.triggeredBy || 'operator',
      preEnhancePath: prePcPath,
      providerMeta:   { provider: 'perfectly-clear', pcConfigId: pcConfig.id },
    });
    return cachePath;
  }

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

// ── Perfectly Clear — batch API (M3) ──────────────────────────────────────────
//
// Job Review can select one, many, or all images and hand them to the shared
// perfectlyClearClient as a single QuickServer batch. This keeps hot-folder
// round-trip overhead down to one shared subfolder regardless of image count
// and lets `processBatch` do its per-file accounting once.
//
// Each per-file result still flows through the same cache→working copy-back +
// sidecar update the single-image path uses, so partial batches (some
// enhanced, some rejected, some timed-out) land on disk exactly like their
// single-image counterparts. `enhancedPath` sidecar field is unchanged, so
// `print-service._getEnhancedPathMap` needs zero updates.
//
// Registry lives in-memory only — a crash mid-batch loses per-file state but
// leaves any already-copied-back files intact; the operator sees the AI badge
// on the reloaded job and can re-enhance the stragglers.

const pcBatches = new Map(); // batchId → { files: Map<filename,state>, counts, finished, abortController, jobId, jobPath, configId }

function _makeBatchId() {
  return `pc_batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Kick off a Perfectly Clear batch for a set of filenames in one job.
 * Returns a synthetic batch ID; caller polls checkBatchStatus() (typical
 * ~1.5 s cadence, matching the client's default poll interval).
 *
 * Per-file state values: 'queued' → 'enhanced' | 'rejected' | 'timeout' | 'cancelled' | 'error'.
 * ('error' is client-side — e.g. cache staging failed — distinct from a
 * QuickServer verdict of 'rejected'.)
 */
async function startBatchEnhancement({ jobId, jobPath, filenames, configId, timeoutMs, triggeredBy }) {
  if (!Array.isArray(filenames) || filenames.length === 0) {
    throw new Error('startBatchEnhancement requires a non-empty filenames array');
  }
  const pcConfig = _resolveJobsPcConfig(configId);
  if (!pcConfig) {
    throw new Error('Perfectly Clear is enabled for Jobs but no configurations are available.');
  }

  const cacheDir = path.join(jobPath, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  await originalsManager.ensureOriginals(jobPath);

  // Stage each filename: capture the pre-score, copy working→cache, and
  // build the per-file state entry that both the poller and the copy-back
  // handler share.
  const perFile = new Map();
  const files = []; // for perfectlyClearClient.processBatch
  const cachePathToFilename = new Map();
  for (const filename of filenames) {
    const inputPath = path.join(jobPath, 'working', filename);
    const cachePath = buildCachePath(jobPath, filename);
    try {
      await fs.copyFile(inputPath, cachePath);
    } catch (err) {
      // Staging error — record but keep going so a bad filename doesn't
      // kill the whole batch. State is 'error' so the UI can distinguish
      // this from a legitimate QuickServer verdict.
      perFile.set(filename, {
        status: 'error',
        error:  err.message,
        cachePath,
      });
      continue;
    }
    const before = await maybeRescore(inputPath);
    perFile.set(filename, {
      status:      'queued',
      cachePath,
      scoreBefore: before && before.score,
      scoreModel:  before && before.modelVersion,
    });
    cachePathToFilename.set(cachePath, filename);
    files.push({ sourcePath: cachePath, destPath: cachePath });
  }

  const abortController = new AbortController();
  const batchId = _makeBatchId();
  const batchState = {
    id:              batchId,
    jobId, jobPath, filenames: [...filenames],
    configId:        pcConfig.id,
    friendlyName:    pcConfig.friendlyName || '(unnamed)',
    files:           perFile,
    finished:        false,
    startedAt:       new Date().toISOString(),
    abortController,
    triggeredBy:     triggeredBy || 'operator',
  };
  pcBatches.set(batchId, batchState);

  // Fire the client. If there are no files to actually send (every one
  // failed staging), resolve immediately with the errored state.
  if (files.length === 0) {
    batchState.finished = true;
    return batchId;
  }

  // Kick the batch in the background; per-file completion is handled in
  // onFileDone (which runs the cache→working copy-back + sidecar update).
  perfectlyClearClient.processBatch({
    config:    { ...pcConfig, friendlyName: batchState.friendlyName },
    files,
    timeoutMs,
    signal:    abortController.signal,
    onFileDone: async ({ sourcePath, status, error }) => {
      const filename = cachePathToFilename.get(sourcePath);
      if (!filename) return;
      const st = batchState.files.get(filename);
      if (!st) return;
      if (status === 'enhanced') {
        try {
          const inputPath = path.join(jobPath, 'working', filename);
          const prePcPath = buildPrePcPath(jobPath, filename);
          let hasPrePc = false;
          try { await fs.access(prePcPath); hasPrePc = true; } catch (_) { hasPrePc = false; }
          if (!hasPrePc) {
            await fs.copyFile(inputPath, prePcPath);
          }
          await fs.copyFile(st.cachePath, inputPath);

          const after = await maybeRescore(st.cachePath);
          await updateSidecarEnhancement(jobId, jobPath, filename, st.cachePath, {
            model:          batchState.friendlyName,
            source:         'perfectly-clear',
            scoreBefore:    st.scoreBefore,
            scoreAfter:     after && after.score,
            scoreModel:     (after && after.modelVersion) || st.scoreModel,
            triggeredBy:    batchState.triggeredBy,
            preEnhancePath: prePcPath,
            providerMeta:   { provider: 'perfectly-clear', pcConfigId: pcConfig.id },
          });
          st.status = 'enhanced';
        } catch (err) {
          st.status = 'error';
          st.error  = err.message;
          logger.logError(`pc: batch ${batchId} copy-back/sidecar failed for ${filename}`, err);
        }
      } else {
        st.status = status; // 'rejected' | 'timeout' | 'cancelled'
        if (error) st.error = error;
      }
    },
  })
    .catch((err) => {
      logger.logError(`pc: batch ${batchId} client threw`, err);
      // Mark any remaining queued files as errored so the UI stops polling.
      for (const [name, st] of batchState.files) {
        if (st.status === 'queued') {
          st.status = 'error';
          st.error  = err.message;
        }
        void name;
      }
    })
    .finally(() => {
      batchState.finished = true;
    });

  return batchId;
}

/**
 * Poll a batch's per-file states. Once `finished` is true, the caller
 * should stop polling; the manager keeps the entry around indefinitely so
 * a late poll can still read the final state.
 */
async function checkBatchStatus(batchId) {
  const batch = pcBatches.get(batchId);
  if (!batch) {
    return { success: false, error: 'Batch not found — the app may have restarted.' };
  }
  const files = [];
  const counts = { queued: 0, enhanced: 0, rejected: 0, timeout: 0, cancelled: 0, error: 0 };
  for (const [filename, st] of batch.files) {
    const entry = { filename, status: st.status };
    if (st.error) entry.error = st.error;
    files.push(entry);
    counts[st.status] = (counts[st.status] || 0) + 1;
  }
  return {
    success:      true,
    batchId,
    friendlyName: batch.friendlyName,
    files,
    counts,
    finished:     batch.finished,
  };
}

/**
 * Signal a batch's AbortController. Files that have already resolved keep
 * their terminal status; still-queued files eventually resolve to
 * 'cancelled' when the client sees the abort.
 */
async function cancelBatch(batchId) {
  const batch = pcBatches.get(batchId);
  if (!batch) return { success: false, error: 'Batch not found.' };
  try { batch.abortController.abort(); } catch (_) { /* ignore */ }
  return { success: true, cancelled: true };
}

// ── Perfectly Clear — revert (M3) ────────────────────────────────────────────
//
// Restore /working/{filename} from the earliest pre-PC snapshot and strip
// the enhancement bookkeeping fields from the sidecar. Crop fields are
// deliberately left untouched — crop still wins over enhancement at
// dispatch and is orthogonal to whether we're using the enhanced pixels.

async function revertEnhancement({ jobId, jobPath, filename }) {
  const { sidecar } = await loadSidecar(jobId, jobPath);
  const img = (sidecar.images || []).find(i => i.filename === filename);
  if (!img) {
    throw new Error(`Image ${filename} not found in sidecar`);
  }
  if (!img.enhanced || img.enhancementSource !== 'perfectly-clear') {
    throw new Error(`Image ${filename} is not currently enhanced via Perfectly Clear — nothing to revert.`);
  }

  // Fall back to the buildPrePcPath convention if the sidecar didn't record
  // one (older sidecar written before this field was standard).
  const prePcPath = img.preEnhancePath || buildPrePcPath(jobPath, filename);
  try {
    await fs.access(prePcPath);
  } catch (_) {
    throw new Error(`Pre-enhance snapshot missing for ${filename} — cannot revert.`);
  }
  const inputPath = path.join(jobPath, 'working', filename);
  await fs.copyFile(prePcPath, inputPath);

  const updatedImages = sidecar.images.map(i => {
    if (i.filename !== filename) return i;
    // Follow the plan exactly: strip enhanced / enhancedPath /
    // enhancementSource / enhancementModel / preEnhancePath. Clear
    // enhancedAt as the timestamp companion of `enhanced`. Leave crop
    // fields (cropApplied, cropRect, croppedPath, cropRotation,
    // cropOrientation, pendingCropRect, …) untouched — crop is
    // orthogonal per the M3 decision.
    const next = { ...i };
    delete next.enhanced;
    delete next.enhancedPath;
    delete next.enhancementSource;
    delete next.enhancementModel;
    delete next.enhancedAt;
    delete next.preEnhancePath;
    return next;
  });
  const nextSidecar = { ...sidecar, images: updatedImages };
  await saveSidecar(nextSidecar, jobPath);
  return { success: true, sidecar: nextSidecar };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  enhanceImage,
  startEnhancement,
  checkEnhancement,
  cancelEnhancement,
  validateApiKey,
  // Perfectly Clear (M3) — batch + revert.
  startBatchEnhancement,
  checkBatchStatus,
  cancelBatch,
  revertEnhancement,
  // Test-only handle.
  _getProvider: getProvider,
};
