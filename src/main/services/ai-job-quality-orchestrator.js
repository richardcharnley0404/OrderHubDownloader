/**
 * src/main/services/ai-job-quality-orchestrator.js
 *
 * Job-level orchestration for the AI Quality Gate (M1+M2).
 *
 * Sits between the autoprint dispatch loop and ai-quality-service. The
 * autoprint loop calls `scoreJob(jobId, jobPath)` once per pending job;
 * the orchestrator scores every image, writes per-image results to the
 * sidecar, and returns whether the job should be held back from routing.
 *
 * Public API:
 *   await orchestrator.scoreJob(jobId, jobPath) → { ok, held, summary }
 *   await orchestrator.canRoute(jobId, jobPath) → boolean
 *   await orchestrator.listHeldJobs()           → [{ jobId, ... }]
 *   await orchestrator.releaseJob(jobId, jobPath) → { ok, releasedCount }
 *   await orchestrator.approveImage(jobId, jobPath, filename, note?)
 *
 * Phase 1 design notes:
 *   - Scoring is post-download, pre-routing (NOT pipelined with download).
 *     A 400-image job pays scoring time on top of download time. Acceptable
 *     for v1.2.0; revisit in Phase 2 if pilot data shows real lag.
 *   - Score is computed once per image. Re-scoring (e.g. after a fixup)
 *     happens in M4 via ai-fixup-service, not here.
 *   - When the feature flag is OFF, scoreJob() is a no-op; the autoprint
 *     loop's canRoute() check always returns true.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configService = require('./config-service');
const logger = require('./logger');
const aiQualityService = require('./ai-quality-service');
const aiQualityStore = require('./ai-quality-store');

// Image file extensions we score. Mirrors sidecarManager's IMAGE_EXTENSIONS
// but operates on the job-root directly because most jobs land their images
// at root level (Mode 1 FTP polling), not inside a /working/ subfolder.
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

/**
 * Discover the actual image files for a job by scanning the job folder.
 * Looks at the root of jobPath first; if that's empty, falls back to
 * {jobPath}/working/ (the Job-Review-touched layout).
 *
 * Returns an array of bare filenames (no directory component).
 */
function _scanJobImages(jobPath) {
  let entries;
  try {
    entries = fs.readdirSync(jobPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const rootImages = entries
    .filter((e) => e.isFile()
      && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase())
      && !e.name.endsWith('_corrected.jpg'))
    .map((e) => e.name);

  if (rootImages.length > 0) return rootImages.sort();

  // Fallback to /working/ for Job-Review-touched jobs.
  try {
    const workingDir = path.join(jobPath, 'working');
    return fs.readdirSync(workingDir, { withFileTypes: true })
      .filter((e) => e.isFile()
        && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase())
        && !e.name.endsWith('_corrected.jpg'))
      .map((e) => e.name)
      .sort();
  } catch (_) {
    return [];
  }
}

class AIJobQualityOrchestrator {
  constructor() {
    // In-memory tracker of jobs currently being scored — prevents the
    // autoprint loop from re-entering scoreJob for the same job before
    // the previous pass finishes.
    this._scoringInFlight = new Map(); // jobId → Promise<scoreJob result>
  }

  /**
   * Score every image in a job, write per-image results to the sidecar,
   * and return whether the job should be held.
   *
   * Idempotent: re-running on a job that's already been scored is cheap
   * (the orchestrator skips images whose `aiQuality.scored === true`).
   */
  async scoreJob(jobId, jobPath) {
    if (!configService.get('aiQualityEnabled')) {
      return { ok: true, held: false, summary: { skipped: true } };
    }

    // Coalesce duplicate concurrent calls.
    if (this._scoringInFlight.has(jobId)) {
      return this._scoringInFlight.get(jobId);
    }

    const promise = this._runScoreJob(jobId, jobPath).finally(() => {
      this._scoringInFlight.delete(jobId);
    });
    this._scoringInFlight.set(jobId, promise);
    return promise;
  }

  async _runScoreJob(jobId, jobPath) {
    const startedAt = Date.now();
    try {
      const ready = await aiQualityService.init();
      if (!ready) {
        // Service couldn't init (no host, no model — whatever). Fail open:
        // do not hold the job, log clearly.
        logger.logWarning(`[ai-quality] orchestrator: service not ready for job ${jobId} — passing through`);
        return { ok: true, held: false, summary: { skipped: true, reason: 'service-not-ready' } };
      }

      const threshold = parseInt(configService.get('aiQualityThreshold'), 10) || 75;
      // Debug knob: when aiQualityForceScore > 0, always re-score so the
      // forced value takes effect against any pre-existing sidecar entries.
      // Without this, a sidecar written before the operator set forceScore
      // would stick its "passed" verdict and the gate could never trip.
      const forceRescore = (parseInt(configService.get('aiQualityForceScore'), 10) || 0) > 0;

      // Discover images by scanning the job folder directly. We don't trust
      // the sidecar's `images` array because the legacy sidecarManager only
      // populates it from /working/ — which is empty for Mode-1 jobs that
      // haven't been touched by Job Review. Scanning the actual filesystem
      // is the only reliable source.
      const imageFilenames = _scanJobImages(jobPath);
      if (imageFilenames.length === 0) {
        return { ok: true, held: false, summary: { scored: 0, passed: 0, failed: 0, total: 0, threshold, elapsedMs: Date.now() - startedAt, errors: [], reason: 'no-images-found' } };
      }

      // Existing per-image quality (may be empty for fresh jobs). We use this
      // only to skip already-scored images when forceRescore is off.
      const imageRows = await aiQualityStore.getJobQuality(jobId, jobPath);
      const existingByName = new Map(imageRows.map((r) => [r.filename, r.aiQuality]));

      let scoredCount = 0;
      let failedCount = 0;
      let passedCount = 0;
      const errors = [];

      for (const filename of imageFilenames) {
        const existing = existingByName.get(filename);
        if (existing && existing.scored && !forceRescore) {
          // Already scored — count it and move on.
          if (existing.passed) passedCount++; else failedCount++;
          continue;
        }

        const imagePath = path.join(jobPath, filename);
        if (!fs.existsSync(imagePath)) {
          errors.push({ filename, error: 'image not found' });
          continue;
        }

        const result = await aiQualityService.scoreImage(imagePath);
        const passed = result.score >= threshold;

        await aiQualityStore.setImageQuality(jobId, jobPath, filename, {
          scored: true,
          score: result.score,
          thresholdAtScoreTime: threshold,
          passed,
          modelVersion: result.modelVersion,
          inferenceMs: result.inferenceMs,
          scoredAt: new Date().toISOString(),
          error: result.error,
        });

        scoredCount++;
        if (passed) passedCount++; else failedCount++;
      }

      // Re-read post-write to derive held state from the latest sidecar.
      const finalRows = await aiQualityStore.getJobQuality(jobId, jobPath);
      const held = aiQualityStore.deriveHeld(finalRows);

      const elapsed = Date.now() - startedAt;
      logger.info(
        `[ai-quality] job ${jobId} scored: ${scoredCount} new, ` +
        `${passedCount}/${imageFilenames.length} passing, ` +
        `${failedCount} failing, held=${held}, ${elapsed}ms`
      );

      return {
        ok: true,
        held,
        summary: {
          scored: scoredCount,
          passed: passedCount,
          failed: failedCount,
          total: imageFilenames.length,
          threshold,
          elapsedMs: elapsed,
          errors,
        },
      };
    } catch (err) {
      logger.logError(`[ai-quality] orchestrator: scoreJob failed for ${jobId} — passing through`, err);
      // Fail open. We never want to block routing on infrastructure failure.
      return { ok: false, held: false, summary: { error: err.message } };
    }
  }

  /**
   * Quick decision used by the autoprint dispatch loop:
   *   - feature OFF → true (route as today)
   *   - sidecar missing or unreadable → true (don't block on infra failures)
   *   - any image scored & failed without operator override → false
   *   - otherwise → true
   *
   * Does NOT trigger scoring. The autoprint loop should call scoreJob first.
   */
  async canRoute(jobId, jobPath) {
    if (!configService.get('aiQualityEnabled')) return true;
    try {
      const rows = await aiQualityStore.getJobQuality(jobId, jobPath);
      return !aiQualityStore.deriveHeld(rows);
    } catch (err) {
      logger.logWarning(`[ai-quality] canRoute: sidecar read failed for ${jobId} — allowing route`);
      return true;
    }
  }

  /**
   * Operator action: mark every failed image in a job as approved-as-is,
   * which clears the held state. The job's next autoprint pass will route.
   */
  async releaseJob(jobId, jobPath, note) {
    const rows = await aiQualityStore.getJobQuality(jobId, jobPath);
    let released = 0;
    for (const row of rows) {
      const aq = row.aiQuality || {};
      if (!aq.scored || aq.passed) continue;
      const decision = (aq.operatorDecision && aq.operatorDecision.kind) || 'none';
      if (decision === 'fixed' || decision === 'approved_as_is') continue;
      await aiQualityStore.setOperatorDecision(jobId, jobPath, row.filename, {
        kind: 'approved_as_is',
        note: note || 'released by operator',
      });
      released++;
    }
    logger.info(`[ai-quality] job ${jobId} released by operator (${released} images approved-as-is)`);
    return { ok: true, releasedCount: released };
  }

  /**
   * Operator action on a single image. M3+M4 will use this from the
   * Quality Review tab.
   */
  async approveImage(jobId, jobPath, filename, note) {
    await aiQualityStore.setOperatorDecision(jobId, jobPath, filename, {
      kind: 'approved_as_is',
      note: note || null,
    });
    return { ok: true };
  }
}

module.exports = new AIJobQualityOrchestrator();
