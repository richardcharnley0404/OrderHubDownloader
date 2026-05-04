'use strict';

/**
 * src/main/services/ai-fixup-service.js
 *
 * Quality-gate-triggered enhancement path (Phase 1 plan §8.2). Sister of
 * `enhancementManager.js` — both reach the same provider clients
 * (`localClient`, `topazClient`) and produce the same per-image sidecar
 * shape, but this service is invoked by `ai-job-quality-orchestrator.js`
 * when an image fails the gate and `enhancementAutoEnhance === true`.
 *
 * Distinct from the manager-level path because:
 *
 *   1. The orchestrator already manages job-level state, so we go direct
 *      to the provider client. Routing through the manager would create
 *      ambiguity about which write wins on the sidecar (plan §8.2).
 *
 *   2. `triggeredBy: 'quality-gate'` is recorded on the sidecar so future
 *      audits can distinguish auto-fixed images from operator-initiated
 *      enhancements.
 *
 *   3. We DO NOT make held-vs-routed decisions here. We return the score
 *      delta and `crossedThreshold` flag; the orchestrator decides what to
 *      do with it.
 *
 * Public API:
 *
 *   await applyFixup(jobId, jobPath, filename, options) → {
 *     outputPath,        // absolute path to enhanced /working/ file
 *     beforeScore,       // MUSIQ score before (read from existing sidecar)
 *     afterScore,        // MUSIQ score after (or null if rescore failed)
 *     crossedThreshold,  // afterScore >= configured threshold
 *     provider,          // 'local' | 'topaz'
 *     model,
 *     triggeredBy: 'quality-gate',
 *     error?,            // populated on enhancement or rescore failure
 *   }
 *
 * Graceful failure modes (plan §1, "Graceful failure everywhere"):
 *
 *   - Enhancement throws → no working-file mutation, no sidecar update
 *     of flat enhancement fields. A `fixupHistory` entry is appended to
 *     `aiQuality.fixupHistory[]` recording the attempt + error so the
 *     audit trail is complete. The orchestrator falls back to the
 *     original held-state semantics.
 *
 *   - Rescore throws → sidecar gets `afterScore: null` + `error` field,
 *     `aiQuality.score` keeps the previous (pre-enhance) value, and
 *     `aiQuality.passed` stays false. The orchestrator treats this as
 *     "no improvement" and the job remains held — operator decides.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const localClient = require('../enhancement/localClient');
const topazClient = require('../enhancement/topazClient');
const originalsManager = require('../jobs/originalsManager');
const { loadSidecar, saveSidecar } = require('../jobs/sidecarManager');
const aiQualityStore = require('./ai-quality-store');
const aiQualityService = require('./ai-quality-service');
const configService = require('./config-service');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCachePath(jobPath, filename) {
  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);
  return path.join(jobPath, 'cache', `${baseName}_enhanced.jpg`);
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Mirror enhancementManager.updateSidecarEnhancement(): write the flat
 * enhancement fields directly on the per-image entry. This is the same
 * shape both paths produce (plan §5) — only `enhancementTriggeredBy`
 * differs between user-initiated and quality-gate-triggered runs.
 *
 * Implementation note: aiQualityStore writes through sidecarManager but
 * scopes to `aiQuality.*`. The flat enhancement fields (enhanced,
 * scoreBefore, etc.) sit on the image entry root, outside the aiQuality
 * block. So we go directly to sidecarManager for this write.
 */
async function _writeFlatEnhancementFields(jobId, jobPath, filename, cachePath, fields) {
  const { sidecar } = await loadSidecar(jobId, jobPath);
  const updatedImages = (sidecar.images || []).map((img) => {
    if (img.filename !== filename) return img;
    const next = {
      ...img,
      enhanced: true,
      enhancementSource: fields.source || 'local',
      enhancedPath: cachePath,
      enhancedAt: new Date().toISOString(),
      enhancementModel: fields.model || null,
    };
    if (typeof fields.scoreBefore === 'number') next.scoreBefore = fields.scoreBefore;
    if (typeof fields.scoreAfter === 'number') next.scoreAfter = fields.scoreAfter;
    if (fields.scoreModel) next.scoreModel = fields.scoreModel;
    if (fields.triggeredBy) next.enhancementTriggeredBy = fields.triggeredBy;
    if (fields.providerMeta && typeof fields.providerMeta === 'object') {
      Object.assign(next, fields.providerMeta);
    }
    return next;
  });
  await saveSidecar({ ...sidecar, images: updatedImages }, jobPath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply the configured enhancement provider to a single quality-gate-failed
 * image, then re-score against the threshold. Always async-safe — never
 * throws to the caller; failures are returned in the result object via the
 * `error` field.
 *
 * @param {string} jobId
 * @param {string} jobPath
 * @param {string} filename
 * @param {object} [options]
 * @param {'local'|'topaz'} [options.provider]   defaults to enhancementProvider config
 * @param {string} [options.model]               defaults per-provider
 * @param {boolean} [options.faceEnhancement]    Topaz-only
 * @param {number} [options.tileSize]            local-only
 * @param {number} [options.tileOverlap]         local-only
 * @returns {Promise<object>}
 */
async function applyFixup(jobId, jobPath, filename, options = {}) {
  const provider = options.provider || configService.get('enhancementProvider') || 'local';
  const triggeredBy = 'quality-gate';
  const threshold = parseInt(configService.get('aiQualityThreshold'), 10) || 50;

  // ── Read existing pre-enhance MUSIQ score from the sidecar ───────────────
  // Plan §8.2 step 1 — do NOT re-score here. The orchestrator already wrote
  // the score during its earlier pass; reading it from the sidecar keeps the
  // audit trail consistent and avoids charging an extra inference.
  let beforeScore = null;
  let beforeScoreModel = null;
  try {
    const rows = await aiQualityStore.getJobQuality(jobId, jobPath);
    const row = rows.find((r) => r.filename === filename);
    if (row && row.aiQuality && typeof row.aiQuality.score === 'number') {
      beforeScore = row.aiQuality.score;
      beforeScoreModel = row.aiQuality.modelVersion || null;
    }
  } catch (err) {
    logger.logWarning(
      `[ai-fixup] sidecar read failed for ${filename} — proceeding with beforeScore=null (${err.message})`
    );
  }

  // ── Bootstrap /working/ + /originals/ (idempotent) ───────────────────────
  // ensureWorkingSetup handles both layouts:
  //   - Mode 1 (FTP-polled jobs at root):       copies root → /working/ + /originals/
  //   - Job-Review-touched jobs:                no-op (already initialised)
  // ensureOriginals then guarantees the snapshot regardless.
  try {
    await originalsManager.ensureWorkingSetup(jobPath);
    await originalsManager.ensureOriginals(jobPath);
  } catch (err) {
    return _earlyFailure({
      provider, triggeredBy, beforeScore, model: options.model || null,
      error: `originals snapshot failed: ${err.message}`,
    });
  }

  // ── Resolve the canonical working-file path ─────────────────────────────
  const workingPath = path.join(jobPath, 'working', filename);
  if (!await fileExists(workingPath)) {
    return _earlyFailure({
      provider, triggeredBy, beforeScore, model: options.model || null,
      error: `image not found at ${workingPath}`,
    });
  }

  // ── Run the configured provider on a cache-path copy ────────────────────
  const cachePath = buildCachePath(jobPath, filename);
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.copyFile(workingPath, cachePath);
  } catch (err) {
    return _earlyFailure({
      provider, triggeredBy, beforeScore, model: options.model || null,
      error: `cache copy failed: ${err.message}`,
    });
  }

  let providerResult = null;
  let providerError = null;
  try {
    if (provider === 'local') {
      providerResult = await localClient.enhance(cachePath, {
        tileSize: options.tileSize,
        tileOverlap: options.tileOverlap,
      });
    } else if (provider === 'topaz') {
      const apiKey = configService.get('topazApiKey');
      if (!apiKey) throw new Error('Topaz API key is not configured');
      const model = options.model || configService.get('topazDefaultModel') || 'Standard V2';
      await topazClient.enhance(cachePath, {
        model,
        face_enhancement: Boolean(options.faceEnhancement),
      }, apiKey);
      providerResult = { model };
    } else {
      throw new Error(`unknown enhancement provider: '${provider}'`);
    }
  } catch (err) {
    providerError = err;
  }

  if (providerError) {
    // Per plan §1: graceful failure. Audit-trail the attempt, leave the
    // working file untouched, do NOT write the flat enhancement fields.
    try {
      await aiQualityStore.appendFixupHistory(jobId, jobPath, filename, {
        attemptedAt: new Date().toISOString(),
        provider,
        triggeredBy,
        scoreBefore: beforeScore,
        scoreAfter: null,
        crossedThreshold: false,
        error: providerError.message,
      });
    } catch (_) { /* sidecar write failure here is non-fatal — already logging */ }

    logger.logError(
      `[ai-fixup] ${provider} enhancement failed for ${filename} — image remains held`,
      providerError,
    );
    return {
      outputPath: workingPath,
      beforeScore,
      afterScore: null,
      crossedThreshold: false,
      provider,
      model: options.model || (provider === 'local' ? 'realesr-general-x4v3' : null),
      triggeredBy,
      error: providerError.message,
    };
  }

  // ── Promote enhanced cache → working file ───────────────────────────────
  try {
    await fs.copyFile(cachePath, workingPath);
  } catch (err) {
    return _earlyFailure({
      provider, triggeredBy, beforeScore,
      model: providerResult.model || (provider === 'local' ? 'realesr-general-x4v3' : null),
      error: `working copy-back failed: ${err.message}`,
    });
  }

  // ── Re-score the post-enhance working file ──────────────────────────────
  let afterScore = null;
  let afterScoreModel = null;
  let rescoreError = null;
  try {
    const rescore = await aiQualityService.scoreImage(workingPath);
    if (rescore && typeof rescore.score === 'number' && !rescore.error) {
      afterScore = rescore.score;
      afterScoreModel = rescore.modelVersion || null;
    } else {
      rescoreError = (rescore && rescore.error) || 'rescore returned no usable score';
    }
  } catch (err) {
    rescoreError = err.message;
  }

  const crossedThreshold = afterScore != null && afterScore >= threshold;
  const model = providerResult.model || (provider === 'local' ? 'realesr-general-x4v3' : 'Standard V2');

  // ── Build the provider-specific meta object (mirrors M2 manager path) ───
  const providerMeta = { provider };
  if (provider === 'local' && providerResult) {
    providerMeta.modelVersion = 'realesr-general-x4v3';
    providerMeta.inferenceMs = providerResult.inferenceMs;
    providerMeta.tileCount = providerResult.tileCount;
    providerMeta.tileSize = providerResult.tileSize;
    providerMeta.tileOverlap = providerResult.tileOverlap;
    providerMeta.executionProvider = providerResult.executionProvider;
    providerMeta.sourceWidth = providerResult.sourceWidth;
    providerMeta.sourceHeight = providerResult.sourceHeight;
    providerMeta.outputWidth = providerResult.outputWidth;
    providerMeta.outputHeight = providerResult.outputHeight;
  }

  // ── Write the consolidated sidecar entry ─────────────────────────────────
  // Three updates, all keyed off the same image. Order matters: aiQuality
  // FIRST (so deriveHeld picks up the new state), then flat enhancement
  // fields, then fixupHistory append. Each saveSidecar load+save is a
  // separate read-modify-write — sidecars are small enough that the cost
  // is negligible.

  // (a) aiQuality.* update — orchestrator's deriveHeld reads from here.
  //     If rescore failed we keep the pre-fixup score so the gate continues
  //     to hold the image; treat it as not passed.
  try {
    await aiQualityStore.setImageQuality(jobId, jobPath, filename, {
      score: afterScore != null ? afterScore : (beforeScore != null ? beforeScore : 0),
      passed: crossedThreshold,
      thresholdAtScoreTime: threshold,
      modeAtScoreTime: configService.get('aiQualityMode') || 'warn',
      modelVersion: afterScoreModel || beforeScoreModel,
      scoredAt: new Date().toISOString(),
      error: rescoreError,
    });
  } catch (err) {
    logger.logError(`[ai-fixup] sidecar aiQuality update failed for ${filename}`, err);
  }

  // (b) Flat enhancement fields — same shape M2 manager-level path writes.
  try {
    await _writeFlatEnhancementFields(jobId, jobPath, filename, cachePath, {
      model,
      source: provider === 'topaz' ? 'topaz-direct' : 'local',
      scoreBefore: beforeScore != null ? beforeScore : undefined,
      scoreAfter: afterScore != null ? afterScore : undefined,
      scoreModel: afterScoreModel || beforeScoreModel || undefined,
      triggeredBy,
      providerMeta,
    });
  } catch (err) {
    logger.logError(`[ai-fixup] flat-fields write failed for ${filename}`, err);
  }

  // (c) Append to aiQuality.fixupHistory[] for the per-image audit trail.
  try {
    await aiQualityStore.appendFixupHistory(jobId, jobPath, filename, {
      attemptedAt: new Date().toISOString(),
      provider,
      triggeredBy,
      model,
      scoreBefore: beforeScore,
      scoreAfter: afterScore,
      crossedThreshold,
      error: rescoreError,
    });
  } catch (err) {
    logger.logError(`[ai-fixup] fixupHistory append failed for ${filename}`, err);
  }

  logger.info(
    `[ai-fixup] ${provider} fixup applied: ${filename} ` +
    `score ${beforeScore != null ? beforeScore.toFixed(1) : '?'} → ` +
    `${afterScore != null ? afterScore.toFixed(1) : '? (rescore failed)'} ` +
    `(threshold ${threshold}, crossed=${crossedThreshold})`
  );

  return {
    outputPath: workingPath,
    beforeScore,
    afterScore,
    crossedThreshold,
    provider,
    model,
    triggeredBy,
    error: rescoreError,
  };
}

/**
 * Build a result object for early-failure paths (snapshot/copy/etc) that
 * happen before the provider runs. The working file and sidecar are left
 * untouched — the orchestrator simply observes the held image as still
 * held and continues with the original semantics.
 */
function _earlyFailure({ provider, triggeredBy, beforeScore, model, error }) {
  logger.logWarning(`[ai-fixup] early failure: ${error}`);
  return {
    outputPath: null,
    beforeScore,
    afterScore: null,
    crossedThreshold: false,
    provider,
    model,
    triggeredBy,
    error,
  };
}

module.exports = {
  applyFixup,
};
