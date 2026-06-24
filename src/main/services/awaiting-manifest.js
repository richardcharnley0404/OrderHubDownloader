'use strict';

/**
 * Awaiting-manifest re-arm support (2026-06-24).
 *
 * Background: the order manifest can momentarily vanish / be zero-byte /
 * be half-written on the watched share when OrderHub re-pushes an order
 * folder (non-atomic FTP), exactly when a dispatch reads it. The 4×250ms
 * retry in print-service._readManifest absorbs short blips, but anything
 * longer than ~750ms still throws. Before this module, that throw landed
 * the job in a terminal _status:'error' that the auto-print eligibility
 * filter (ipc-handlers: only received/pending are admitted) never retries —
 * so the job stayed stuck even after the manifest reappeared.
 *
 * This makes a dispatch-time manifest miss NON-terminal: instead of going
 * to error, the job is re-armed into the same awaiting-manifest state the
 * polling loop already manages (polling-service.js ~293-330). On the next
 * poll it either clears (manifest back → markReceived) or, if the manifest
 * genuinely never returns, escalates to a real error after the bounded
 * awaitingManifestTimeoutMs (default 10 min). Other dispatch failures
 * (controller offline, copy failed, parse error on a corrupt manifest)
 * stay terminal exactly as before.
 */

/**
 * Typed error thrown by print-service._readManifest when the manifest is
 * absent after the retry budget. `.message` is preserved verbatim
 * ("Order manifest not found: {path}") for backward-compat with the
 * renderer's error display and existing tests; `.manifestPath` lets the
 * re-arm path stamp the awaiting tooltip without re-deriving it.
 */
class ManifestNotFoundError extends Error {
  constructor(manifestPath) {
    super(`Order manifest not found: ${manifestPath}`);
    this.name = 'ManifestNotFoundError';
    this.manifestPath = manifestPath;
  }
}

/**
 * Decide how a dispatch-path error should update a job.
 *
 * Returns the updateJobLocally payload that re-arms the awaiting-manifest
 * wait when `err` is a manifest miss, or `null` when it is any other error
 * (the caller should then fall through to its existing terminal-error
 * handling).
 *
 * The job is set back to _status:'pending' because the polling loop's
 * pending set is `jobs.filter(j => j._status === 'pending')` — that is what
 * re-checks the manifest and runs the bounded escalation. The original
 * `_awaitingManifestSince` is preserved when already set so the 10-minute
 * bound spans the whole episode rather than restarting on each dispatch
 * miss (prevents an indefinite awaiting↔dispatch bounce).
 *
 * @param {object} job - the job being dispatched (read-only)
 * @param {Error}  err - the error thrown by the dispatch attempt
 * @param {string} [nowIso] - injectable clock for tests
 * @returns {object|null}
 */
function awaitingReArmUpdates(job, err, nowIso = new Date().toISOString()) {
  if (!(err instanceof ManifestNotFoundError)) return null;

  const updates = {
    _status: 'pending',
    _awaitingManifest: true,
    _awaitingManifestPath: err.manifestPath,
  };

  if (!job || !job._awaitingManifestSince) {
    updates._awaitingManifestSince = nowIso;
  }

  return updates;
}

module.exports = { ManifestNotFoundError, awaitingReArmUpdates };
