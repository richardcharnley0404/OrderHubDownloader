'use strict';

/**
 * Startup self-heal for jobs stuck in a sticky "Order manifest not found"
 * error (2026-06-24).
 *
 * Background: before the dispatch-path retry + awaiting re-arm fix, a transient
 * FTP re-push blip on the watched share could make a job's order manifest
 * momentarily vanish exactly when dispatch read it — throwing
 * `Order manifest not found: {path}` (print-service._readManifest) and dropping
 * the job into a terminal `_status:'error'`. That state is preserved across
 * every poll (_mergeJobs) and skipped by auto-print, so it never clears on its
 * own — even though the manifest is back on disk seconds later. Customers on
 * pre-fix builds accumulate a backlog of these.
 *
 * This module resets those jobs back to `'pending'` on launch so the normal
 * ingestion gate re-attempts them. By the time the app next starts the manifest
 * has almost always landed, so the re-attempt succeeds. If it genuinely hasn't,
 * the awaiting-manifest gate re-protects the job and the bounded escalation
 * returns it to error after the timeout — so this is safe to run every launch
 * and can't hard-loop or retry-spam.
 *
 * Deliberately NOT matched (left terminal on purpose):
 *   - "Order manifest not received within N minutes…" — the awaiting-manifest
 *     escalation, which already represents a genuine 10-minute wait. Resetting
 *     it would bounce truly-missing jobs every restart.
 *   - "Failed to read order manifest…" — corrupt / half-written JSON, a real
 *     data problem rather than a delivery blip.
 */

/**
 * @param {object} job
 * @returns {boolean} true if the job is a sticky manifest-not-found error that
 *   is safe to reset to pending for a re-attempt.
 */
function isRecoverableManifestError(job) {
  return !!(
    job &&
    job._status === 'error' &&
    typeof job._errorMessage === 'string' &&
    /manifest not found/i.test(job._errorMessage)
  );
}

/**
 * Reset every recoverable job in the array (in place) back to 'pending',
 * clearing the error message and any awaiting-manifest stamps so the
 * poll / auto-print path re-evaluates it from a clean state.
 *
 * @param {object[]} jobs
 * @returns {number} how many jobs were reset
 */
function recoverManifestErrors(jobs) {
  if (!Array.isArray(jobs)) return 0;
  let recovered = 0;
  for (const job of jobs) {
    if (!isRecoverableManifestError(job)) continue;
    job._status = 'pending';
    delete job._errorMessage;
    delete job._awaitingManifest;
    delete job._awaitingManifestSince;
    delete job._awaitingManifestPath;
    recovered += 1;
  }
  return recovered;
}

module.exports = { isRecoverableManifestError, recoverManifestErrors };
