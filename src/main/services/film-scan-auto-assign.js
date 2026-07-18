'use strict';

/**
 * src/main/services/film-scan-auto-assign.js
 *
 * Matcher for the Film Development Auto Assignment feature.
 *
 * Compares held film-scan rolls against cached Film Development jobs and
 * fires an upload via folder-watch-service._uploadRollFromStorage when
 * both gates on the roll pass:
 *   Gate A — reviewPassed:  set by the folder-watch hold step (trivially
 *            true for Auto / Smart-confident / rotation-off scopes; false
 *            when the roll would otherwise be held for operator review).
 *   Gate B — matchedJobId:  filled in by this matcher.
 *
 * The matcher itself is idempotent — safe to call at any time, cheap when
 * there's nothing to do, and safe to call from multiple triggers on the
 * same tick.
 *
 * Trigger sites (all use runMatchCycle):
 *   - End of folder-watch-service._processFilmScans (a new roll may have
 *     just been held).
 *   - End of polling-service.pollJobs (a matching film-dev job may have
 *     just arrived).
 *   - End of the ipc:filmReview:approve-roll handler (Gate A just passed
 *     for a roll that may already be matched).
 *
 * Job polling dependency: film-scan-only PCs run with pollingEnabled:false,
 * so fetchJobs never runs on its own. runMatchCycle fetches jobs directly
 * (fetchJobs only — no syncJobStatusFromOH, no artwork download, no
 * received-marking) when auto-assign is on and polling is off but an API
 * key is configured, so the matcher isn't starved.
 *
 * Twin-check normalisation (locked in the brief):
 *   norm(x) = digits-only(strip trailing '_N')/leading-zero-stripped
 *   e.g. "00001847_1" and "1847"  both  → "1847"
 *
 * Design notes:
 *   - Contract stays narrow: one exported runMatchCycle(config, logger).
 *   - Deps injected lazily via require() at call time so tests can stub
 *     job-service and folder-watch-service via require.cache without
 *     needing this module to accept them as arguments.
 *   - Never throws to the caller — a matcher failure must never wedge the
 *     film-scan pipeline or the poll loop.
 */

const configService     = require('./config-service');
const frameMetadataStore = require('./frame-metadata-store');

// ── Digit normalisation for twin-check matching ──────────────────────────────

/**
 * Normalise a folder name or twin-check ID to its comparison form:
 *   - strip a single trailing `_N` suffix (`_1`, `_23` — from
 *     _resolveStoragePath's re-scan disambiguation)
 *   - drop every non-digit character
 *   - drop leading zeros
 *
 * Returns '' for anything that has no digits at all — never match empty
 * against empty (otherwise every non-numeric roll would match every
 * non-numeric twin check).
 */
function _normalise(value) {
  if (value == null) return '';
  let s = String(value);
  // Trailing _N stripped BEFORE digit-only filter so the underscore
  // and any digits after it don't leak into the compared form.
  s = s.replace(/_\d+$/, '');
  // Strip non-digits.
  s = s.replace(/\D+/g, '');
  // Strip leading zeros.
  s = s.replace(/^0+/, '');
  return s;
}

// ── Match cycle ──────────────────────────────────────────────────────────────

/**
 * Run one match cycle. `logger` is optional — falls back to the shared
 * logger singleton so callers can pass their own if they want a scoped
 * variant. Always resolves; never throws.
 */
async function runMatchCycle(config, logger) {
  const log = logger || require('./logger');

  try {
    if (!config || !config.filmScanAutoAssignEnabled) return { skipped: true };

    // Polling-off PCs still need job data — fetch directly (no side effects).
    // Never throws: a fetch failure just means "no new matches this cycle".
    if (!config.pollingEnabled && config.orderhubApiKey) {
      try {
        const jobService = require('./job-service');
        await jobService.fetchJobs();
      } catch (fetchErr) {
        log.logWarning && log.logWarning(
          `filmScans: auto-assign fetchJobs failed (${fetchErr.message}) — matching against last-known jobs`
        );
      }
    }

    const jobService = require('./job-service');
    const filmDevJobs = jobService.getFilmDevelopmentJobs() || [];

    // Held rolls: uploadStatus 'pending' + awaitingAssignment flag. The
    // awaitingAssignment flag distinguishes auto-assign holds from
    // legacy review holds (which don't set it), so we never trip on a
    // roll that predates the feature toggle.
    const summaries = frameMetadataStore.listRollsWithSummary();
    const heldRolls = summaries.filter(s =>
      s && s.uploadStatus === 'pending' && s.awaitingAssignment === true
    );

    if (heldRolls.length === 0) return { held: 0, matched: 0, uploaded: 0 };
    if (filmDevJobs.length === 0) {
      log.info && log.info(
        `filmScans: auto-assign — ${heldRolls.length} roll(s) held, no film-dev jobs cached`
      );
      return { held: heldRolls.length, matched: 0, uploaded: 0 };
    }

    // Build a twin-check → job index. If two distinct LIVE film-dev jobs
    // map to the same normalised code we refuse to guess: drop the code
    // from the index and remember the collision so the match loop can
    // skip any roll that hits it and log a clear ambiguity warning.
    const jobByTwin = new Map();
    const ambiguousTwins = new Map(); // norm → Set of contributing job ids
    for (const job of filmDevJobs) {
      if (!Array.isArray(job.twin_checks)) continue;
      for (const twin of job.twin_checks) {
        const norm = _normalise(twin);
        if (!norm) continue;
        const collision = ambiguousTwins.get(norm);
        if (collision) {
          collision.add(job.id);
          continue;
        }
        const existing = jobByTwin.get(norm);
        if (existing && existing.job.id !== job.id) {
          ambiguousTwins.set(norm, new Set([existing.job.id, job.id]));
          jobByTwin.delete(norm);
          continue;
        }
        if (!existing) jobByTwin.set(norm, { job, twin });
      }
    }
    if (jobByTwin.size === 0 && ambiguousTwins.size === 0) {
      return { held: heldRolls.length, matched: 0, uploaded: 0 };
    }

    let matched = 0;
    let uploaded = 0;
    let queued = 0;
    // Track which twin checks were consumed this cycle so two rolls
    // sharing the same twin (rare — indicates a re-scan) don't both fire.
    const twinsConsumed = new Set();
    // Track which rolls to upload — do the upload OUTSIDE the loop so the
    // metadata-store write happens before we hand off to the upload path
    // (which reads the record back).
    const uploadQueue = [];

    for (const roll of heldRolls) {
      const rollNorm = _normalise(roll.rollId);
      if (!rollNorm) continue;
      if (ambiguousTwins.has(rollNorm)) {
        const jobIds = Array.from(ambiguousTwins.get(rollNorm)).sort();
        log.logWarning && log.logWarning(
          `filmScans: auto-assign — ambiguous twin match: code ${rollNorm} on jobs ${jobIds.join(',')} — not auto-assigning roll ${roll.rollId}`
        );
        continue;
      }
      const hit = jobByTwin.get(rollNorm);
      if (!hit) continue;
      if (twinsConsumed.has(rollNorm)) continue;
      twinsConsumed.add(rollNorm);
      matched += 1;

      // Stash job context on the roll now so the future S3-payload
      // enrichment feature is a pure additive change. Order/job fields
      // come from the mapped job in the local cache.
      frameMetadataStore.updateRoll(roll.rollId, {
        matchedJobId:       hit.job.id           || null,
        matchedJobNumber:   hit.job.job_name     || hit.job.id     || null,
        matchedOrderId:     hit.job.order_id     || null,
        matchedOrderNumber: hit.job.order_number || null,
        matchedTwinCheck:   String(hit.twin),
        matchedAt:          new Date().toISOString(),
      });

      log.info && log.info(
        `filmScans: auto-assign matched ${roll.rollId} → ` +
        `job ${hit.job.id} (twin ${hit.twin}) — ` +
        `${roll.reviewPassed ? 'both gates pass, queuing upload' : 'awaiting review'}`
      );

      if (roll.reviewPassed === true) {
        uploadQueue.push(roll.rollId);
      }

      // Emit a UI refresh so the panel flips to "Matched" (or
      // "Matched — awaiting review") without operator navigation.
      try {
        const folderWatchService = require('./folder-watch-service');
        folderWatchService._emitFilmReviewRoll(roll.rollId);
      } catch (_) { /* best-effort */ }
    }

    // Kick uploads outside the match loop. Serialise them (small batches;
    // network + S3 retry chain makes parallel unattractive here) and
    // clear awaitingAssignment on entry so a concurrent runMatchCycle
    // doesn't try to re-upload.
    if (uploadQueue.length > 0) {
      const folderWatchService = require('./folder-watch-service');
      for (const rollId of uploadQueue) {
        try {
          frameMetadataStore.updateRoll(rollId, { awaitingAssignment: false });
          queued += 1;
          await folderWatchService._uploadRollFromStorage(rollId, config);
          uploaded += 1;
        } catch (upErr) {
          log.logError && log.logError(
            `filmScans: auto-assign upload failed for ${rollId}`, upErr
          );
        }
      }
    }

    if (matched === 0) {
      log.info && log.info(
        `filmScans: auto-assign — ${heldRolls.length} roll(s) held, no matching film-dev job this cycle`
      );
    }

    return { held: heldRolls.length, matched, queued, uploaded };
  } catch (err) {
    try {
      log.logError && log.logError('filmScans: auto-assign runMatchCycle failed', err);
    } catch (_) { /* logger stub */ }
    return { error: err.message };
  }
}

// Retained for tests that may want to override configService in-place.
function _configService() { return configService; }

module.exports = {
  runMatchCycle,
  // Test-only handles — not part of the public API.
  _normalise,
  _configService,
};
