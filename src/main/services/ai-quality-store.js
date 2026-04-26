/**
 * src/main/services/ai-quality-store.js
 *
 * Thin wrapper over sidecarManager for the per-image `aiQuality` block.
 *
 * Why a wrapper exists: sidecarManager is the broad sidecar I/O layer;
 * this module isolates AI-Quality-specific reads/writes so the sidecar
 * shape can evolve independently of how scoring code looks up image
 * entries. All Quality Gate code goes through this module — never edit
 * `image.aiQuality.*` from outside it.
 *
 * Reads/writes are sidecar-grained: each call loads + saves the whole
 * sidecar JSON. That's the same pattern enhancementManager etc use; it's
 * cheap because sidecars are small.
 */

'use strict';

const { loadSidecar, saveSidecar } = require('../jobs/sidecarManager');

/**
 * Read the aiQuality blocks for every image in a job.
 *
 * Returns a flat array suitable for orchestration / UI rendering:
 *   [
 *     { filename, aiQuality: { scored, score, passed, ... } },
 *     ...
 *   ]
 */
async function getJobQuality(jobId, jobPath) {
  const { sidecar } = await loadSidecar(jobId, jobPath);
  return (sidecar.images || []).map((img) => ({
    filename: img.filename,
    aiQuality: img.aiQuality || _defaultBlock(),
  }));
}

/**
 * Persist a single image's aiQuality fields. Performs a partial merge —
 * existing fields not present in `update` are preserved (e.g. fixupHistory
 * when only score is being updated).
 */
async function setImageQuality(jobId, jobPath, filename, update) {
  const { sidecar } = await loadSidecar(jobId, jobPath);
  if (!Array.isArray(sidecar.images)) sidecar.images = [];

  let idx = sidecar.images.findIndex((img) => img.filename === filename);
  if (idx === -1) {
    // Upsert: legacy sidecarManager only auto-populates entries from the
    // /working/ subfolder, but Mode-1 jobs land their images at the job root.
    // Create a minimal entry for AI-Quality bookkeeping; other subsystems
    // (enhancement, corrections, etc) will populate their own fields when
    // the operator interacts with the image.
    sidecar.images.push({
      filename,
      qtyOriginal: 1,
      qtyCurrent: 1,
      corrections: { cyan: 0, magenta: 0, yellow: 0 },
      reprint: false,
      reprintJobId: null,
      enhanced: false,
      enhancementSource: null,
      enhancedPath: null,
      enhancedAt: null,
      enhancementModel: null,
      aiQuality: _defaultBlock(),
    });
    idx = sidecar.images.length - 1;
  }

  const current = sidecar.images[idx].aiQuality || _defaultBlock();
  sidecar.images[idx] = {
    ...sidecar.images[idx],
    aiQuality: {
      ...current,
      ...update,
    },
  };

  await saveSidecar(sidecar, jobPath);
  return sidecar.images[idx].aiQuality;
}

/**
 * Append a fixup-history entry for a single image. Phase 1 doesn't run
 * fixups, but the API exists from M1 so M4 can plug in without further
 * sidecar surgery.
 */
async function appendFixupHistory(jobId, jobPath, filename, entry) {
  const { sidecar } = await loadSidecar(jobId, jobPath);

  const idx = (sidecar.images || []).findIndex((img) => img.filename === filename);
  if (idx === -1) {
    throw new Error(`ai-quality-store: image '${filename}' not found in sidecar for job '${jobId}'`);
  }

  const current = sidecar.images[idx].aiQuality || _defaultBlock();
  const history = Array.isArray(current.fixupHistory) ? current.fixupHistory : [];
  sidecar.images[idx] = {
    ...sidecar.images[idx],
    aiQuality: {
      ...current,
      fixupHistory: [...history, entry],
    },
  };

  await saveSidecar(sidecar, jobPath);
  return sidecar.images[idx].aiQuality;
}

/**
 * Set the operator decision for a single image. Used when the operator
 * approves-as-is or reverts a fixup.
 */
async function setOperatorDecision(jobId, jobPath, filename, decision) {
  return setImageQuality(jobId, jobPath, filename, {
    operatorDecision: {
      kind:      decision.kind || 'none',
      decidedAt: decision.decidedAt || new Date().toISOString(),
      note:      decision.note || null,
    },
  });
}

/**
 * Compute the held-state for a job from its per-image data.
 * A job is held iff at least one image has scored AND failed AND
 * has no overriding operator decision.
 */
function deriveHeld(imageQualityList) {
  for (const { aiQuality } of imageQualityList) {
    if (!aiQuality || !aiQuality.scored) continue;
    if (aiQuality.passed) continue;
    const decision = (aiQuality.operatorDecision && aiQuality.operatorDecision.kind) || 'none';
    if (decision === 'fixed' || decision === 'approved_as_is') continue;
    return true;
  }
  return false;
}

function _defaultBlock() {
  return {
    scored: false,
    score: null,
    thresholdAtScoreTime: null,
    passed: true,
    modelVersion: null,
    inferenceMs: null,
    scoredAt: null,
    error: null,
    fixupHistory: [],
    operatorDecision: { kind: 'none', decidedAt: null, note: null },
  };
}

module.exports = {
  getJobQuality,
  setImageQuality,
  appendFixupHistory,
  setOperatorDecision,
  deriveHeld,
};
