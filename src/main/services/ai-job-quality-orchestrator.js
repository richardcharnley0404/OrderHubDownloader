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
 *   - Score is computed once per image. Re-scoring after a fixup happens
 *     in ai-fixup-service.js (the M4 milestone delivered alongside the
 *     local-enhancement plan), not here. This orchestrator triggers fixup
 *     when aiQualityMode === 'block' AND enhancementAutoEnhance === true.
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
const aiFixupService = require('./ai-fixup-service');

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

      const threshold = parseInt(configService.get('aiQualityThreshold'), 10) || 50;
      // Mode is read once up-front so it can be stamped into each per-image
      // sidecar entry as `modeAtScoreTime`. The job-level held gating below
      // re-uses the same value.
      const mode = configService.get('aiQualityMode') || 'warn';
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
        const imagePath = path.join(jobPath, filename);
        const existing = existingByName.get(filename);

        // Skip-vs-rescore decision for an already-scored image.
        //
        //   - clean previous score (no error)              → skip
        //   - errored previous score, file unchanged       → skip
        //         (no point re-running on the same broken file every poll)
        //   - errored previous score, mtime/size changed   → fall through
        //         (file was replaced — likely after the Phase-2 quarantine
        //         flow surfaced corruption and the operator dropped a fresh
        //         copy in place)
        //   - forceRescore debug knob set                  → fall through
        if (existing && existing.scored && !forceRescore) {
          if (!existing.error) {
            if (existing.passed) passedCount++; else failedCount++;
            continue;
          }
          // Errored — only re-run if the file fingerprint changed.
          let fileChanged = false;
          try {
            const st = fs.statSync(imagePath);
            const prevSize = existing.fileSizeAtScoreTime;
            const prevMtime = existing.fileMtimeAtScoreTime;
            if (prevSize != null && prevMtime != null) {
              fileChanged = (st.size !== prevSize) || (st.mtimeMs !== prevMtime);
            }
            // If the previous entry lacked the fingerprint fields (legacy
            // sidecar from before Phase 3), we can't tell — leave it alone.
          } catch (_) {
            // Stat failed → can't tell → skip.
          }
          if (!fileChanged) {
            if (existing.passed) passedCount++; else failedCount++;
            continue;
          }
          logger.info(
            `[ai-quality] re-scoring ${filename} (file changed since previous error: ` +
            `${existing.error})`
          );
        }

        if (!fs.existsSync(imagePath)) {
          errors.push({ filename, error: 'image not found' });
          continue;
        }

        // Capture file fingerprint at score time so a future poll can decide
        // whether to re-score (see skip-vs-rescore comment above).
        let stat;
        try {
          stat = fs.statSync(imagePath);
        } catch (statErr) {
          errors.push({ filename, error: `stat failed: ${statErr.message}` });
          continue;
        }

        const result = await aiQualityService.scoreImage(imagePath);
        const passed = result.score >= threshold;

        await aiQualityStore.setImageQuality(jobId, jobPath, filename, {
          scored: true,
          score: result.score,
          thresholdAtScoreTime: threshold,
          modeAtScoreTime: mode,
          passed,
          modelVersion: result.modelVersion,
          inferenceMs: result.inferenceMs,
          scoredAt: new Date().toISOString(),
          fileSizeAtScoreTime: stat.size,
          fileMtimeAtScoreTime: stat.mtimeMs,
          error: result.error,
        });

        scoredCount++;
        if (passed) passedCount++; else failedCount++;
      }

      // Re-read post-write to derive held state from the latest sidecar.
      let finalRows = await aiQualityStore.getJobQuality(jobId, jobPath);
      let qualityHeld = aiQualityStore.deriveHeld(finalRows);

      // ── Auto-enhance fixup (Phase 1 plan §8.2) ───────────────────────────
      // When the gate is in block-mode AND the operator opted into
      // enhancementAutoEnhance, apply the configured provider to every
      // held image BEFORE deciding whether the job stays held. The fixup
      // service rescores after enhancement and updates aiQuality.score /
      // aiQuality.passed in the sidecar, so the post-fixup deriveHeld()
      // call below naturally reflects the new state.
      //
      // Fixup is skipped — even in block-mode — when:
      //   - enhancementAutoEnhance is unset (operator hasn't opted in)
      //   - qualityHeld is false (nothing to fix)
      //   - mode === 'warn' (never blocks routing, so fixup is moot)
      //
      // Per-image failures DO NOT abort the loop. Each fixup is
      // independently graceful — see ai-fixup-service.js for the failure
      // contract. An image whose fixup throws or doesn't cross threshold
      // simply remains held; deriveHeld() handles both cases identically.
      let fixupAttempts = 0;
      let fixupSucceeded = 0;
      let fixupFailed = 0;
      const autoEnhance = configService.get('enhancementAutoEnhance') === true;
      if (mode === 'block' && qualityHeld && autoEnhance) {
        const provider = configService.get('enhancementProvider') || 'local';
        const heldRows = finalRows.filter((r) => {
          const aq = r.aiQuality || {};
          if (!aq.scored || aq.passed) return false;
          const decision = (aq.operatorDecision && aq.operatorDecision.kind) || 'none';
          return decision === 'none';
        });

        logger.info(
          `[ai-quality] auto-enhance ON, provider=${provider}, ` +
          `applying fixup to ${heldRows.length} held image(s) in job ${jobId}`
        );

        for (const row of heldRows) {
          fixupAttempts++;
          try {
            const result = await aiFixupService.applyFixup(jobId, jobPath, row.filename, { provider });
            if (result.error) {
              fixupFailed++;
              logger.logWarning(
                `[ai-quality] fixup error for ${row.filename}: ${result.error} ` +
                `(scoreBefore=${result.beforeScore}, scoreAfter=${result.afterScore ?? 'n/a'})`
              );
            } else if (result.crossedThreshold) {
              fixupSucceeded++;
            } else {
              fixupFailed++;
              logger.info(
                `[ai-quality] fixup did not clear threshold for ${row.filename} ` +
                `(${result.beforeScore?.toFixed?.(1) ?? '?'} → ${result.afterScore?.toFixed?.(1) ?? '?'} ` +
                `< ${threshold}) — image remains held`
              );
            }
          } catch (err) {
            // applyFixup is contract-bound to never throw, but defence-in-
            // depth: a thrown exception leaves the image in its pre-fixup
            // held state — which is exactly the right fallback behaviour.
            fixupFailed++;
            logger.logError(
              `[ai-quality] fixup threw for ${row.filename} — image remains held`,
              err,
            );
          }
        }

        // Re-read after the fixup pass so the held decision reflects the
        // post-fixup sidecar.
        finalRows = await aiQualityStore.getJobQuality(jobId, jobPath);
        qualityHeld = aiQualityStore.deriveHeld(finalRows);
      }

      // Mode gates whether qualityHeld becomes the returned `held`:
      //   - 'warn'  → never block routing on quality grounds. Sub-threshold
      //               images are still written to sidecars (passed: false) and
      //               surface in the Quality Review tab, but auto-print and
      //               manual print proceed normally. This is the v1.2.0 default;
      //               we want field data from production scoring before
      //               flipping the gate to actually block.
      //   - 'block' → preserve the original M1+M2 gating: any unfixed
      //               sub-threshold image holds the job until operator action.
      // (mode was read once at the top of this function and stamped into each
      //  per-image entry as modeAtScoreTime; same value used here.)
      const held = (mode === 'block') && qualityHeld;

      const subThresholdCount = finalRows.filter((r) => {
        const aq = r.aiQuality || {};
        return aq.scored && !aq.passed;
      }).length;

      const elapsed = Date.now() - startedAt;
      logger.info(
        `[ai-quality] job ${jobId} scored: ${scoredCount} new, ` +
        `${passedCount}/${imageFilenames.length} passing, ` +
        `${failedCount} failing, mode=${mode}, qualityHeld=${qualityHeld}, held=${held}, ${elapsed}ms`
      );

      // Warn-mode visibility: when the gate would have held the job in
      // block-mode, surface the same information at info level so the
      // operator can spot it in logs without needing to open the UI.
      if (mode === 'warn' && subThresholdCount > 0) {
        logger.info(
          `[ai-quality] warn-mode: jobId=${jobId}, total=${imageFilenames.length}, ` +
          `sub-threshold=${subThresholdCount}, routing proceeds`
        );
      }

      return {
        ok: true,
        held,
        summary: {
          scored: scoredCount,
          passed: passedCount,
          failed: failedCount,
          total: imageFilenames.length,
          threshold,
          mode,
          qualityHeld,
          subThreshold: subThresholdCount,
          // Fixup counts populated when auto-enhance ran; all zero otherwise.
          fixupAttempts,
          fixupSucceeded,
          fixupFailed,
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
    // Warn-mode never blocks routing — match scoreJob's held=false return.
    const mode = configService.get('aiQualityMode') || 'warn';
    if (mode !== 'block') return true;
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

const orchestrator = new AIJobQualityOrchestrator();
// Exposed for the aiQuality:listHeldJobs IPC handler in ipc-handlers.js —
// it needs the same disk-truth image enumeration the orchestrator uses
// internally so the scoring-progress `total` field reflects what's
// actually on disk, not what the sidecar happens to have entries for.
// (See bugfixes.md 2026-04-28 entry on the Bug A regression for context.)
orchestrator._scanJobImages = _scanJobImages;

module.exports = orchestrator;
