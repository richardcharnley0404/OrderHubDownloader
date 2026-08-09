'use strict';

/**
 * src/shared/holdForReview.js
 *
 * Per-job "manual artwork — review before printing" derivation.
 *
 * Lives in /shared so the main process can call it from job-service.js
 * without dragging Electron into the dependency graph of node:test runs,
 * matching the placement of jobSchema.js.
 *
 * Canonical hold rule (S3 Artwork Channel brief §"Behaviour rules",
 * narrowed 2026-05-24 — see CHANGELOG Unreleased / hold-rule fix):
 *
 *   _holdForReview = true  if  job.artwork_source === 'manual'
 *                          OR  any artwork_files[i].source === 'manual'
 *
 * Auto-print dispatch consults this via ipc-handlers `runAutoPrint`;
 * operator-initiated dispatch (the explicit Send-to-Print path) is NOT
 * affected. The renderer surfaces a yellow chip on the job-list row using
 * `_holdReasons` to populate a multi-cause tooltip.
 *
 * Why no `production_ready: false` clause: OrderHub returns
 * `production_ready: false` as a DEFAULT state on Pixfizz-source
 * artwork_files (artwork_type values like 'pages' / 'text'), even though
 * those files are FTP-delivered and print-ready in practice. The original
 * brief intended the clause to catch "operator started a manual
 * replacement upload not yet finalised" — but in that scenario the file
 * is already `source: 'manual'`, already caught by the manual-file
 * clause. The not-finalised clause was both redundant and a false
 * positive on every Pixfizz job; M3 will surface "not finalised" as a
 * per-file display chip, not as an auto-print hold reason.
 *
 * Reason coalescing:
 *   - 'manual-source' (whole job is manual upload) implies
 *     'manual-file' (every file is therefore manual), so we suppress the
 *     redundant 'manual-file' reason in that case. 'manual-file' is only
 *     emitted on MIXED jobs where some-but-not-all files are manual.
 *
 * Edge cases handled gracefully (returns "not held" rather than throwing):
 *   - `job` is null/undefined
 *   - `job.artwork_files` missing or not an array
 *   - individual file entries null/undefined
 */

const REASON = Object.freeze({
  MANUAL_SOURCE:        'manual-source',
  MANUAL_FILE:          'manual-file',
  ROUTING_HOLD:         'routing-hold',
  OVER_BATCH_THRESHOLD: 'over-batch-threshold',
});

// Operator-readable text for each reason, used by the renderer to build the
// tooltip on the hold chip. Exported so the renderer reads from the same
// source of truth as the derivation.
const REASON_TEXT = Object.freeze({
  [REASON.MANUAL_SOURCE]:        'Manual upload',
  [REASON.MANUAL_FILE]:          'Contains a manually-uploaded file',
  [REASON.ROUTING_HOLD]:         'Held for manual routing — pick a controller',
  [REASON.OVER_BATCH_THRESHOLD]: 'Large job — total prints exceed this printer’s batch limit. Send to Print when ready.',
});

/**
 * Derive the hold state for a normalised job.
 *
 * @param {object} job - A job object from job-service._normalizeJob,
 *   carrying at least `artwork_source` (string|null) and `artwork_files`
 *   (Array<{ source?: string, … }>). For the routing-hold reason the job
 *   must also carry `process` (string) and may carry `_routingHoldReleased`
 *   (boolean) — the operator-side "released past this hold" flag persisted
 *   on the jobs-cache entry.
 * @param {object} [ctx] - Optional derivation context.
 * @param {Set<string>} [ctx.routingHeldProcesses] - Set of process names
 *   flagged "Hold for manual release" in Settings → Routing → Process
 *   Routing. Supplied by the caller (job-service / runAutoPrint) which
 *   reads it from routing-service.getRoutingHeldProcesses() — passed in
 *   so this module stays pure and electron-store-free for node:test.
 * @param {(job: object) => {cap:number, prints:number}|null} [ctx.batchThresholdCheck] -
 *   Per-job resolver returning both sides of the comparison already
 *   evaluated: the controller's maxPrintsPerJob cap (positive integer)
 *   AND the job's total print count. Returns null when the check
 *   cannot be made — no cap configured, route is not a
 *   darkroompro-family controller, the job is unrouted, or the print
 *   count cannot be determined (e.g. manifest not yet on disk).
 *
 *   The caller owns both sides so this module stays pure — no
 *   dependency on routing-service (electron-store) or fs.
 *
 *   Print count MUST come from the same source the M4 splitter reads
 *   (the on-disk manifest's per-image `quantity`), not from
 *   `job.quantity`: the latter carries different meanings across job
 *   sources (Pixfizz vs manual vs film) — see the M3 investigation
 *   notes and `s3-artwork-downloader.js:434-479`.
 *
 *   Backward-compatible: when the resolver is absent OR returns null,
 *   the batch-threshold reason is never emitted (M1 behaviour).
 * @returns {{ _holdForReview: boolean, _holdReasons: string[] }}
 *   `_holdForReview` is `_holdReasons.length > 0` (kept for read-site
 *   ergonomics; callers may also check the array length directly).
 *   `_holdReasons` is the canonical field — reasons stack so future
 *   hold dimensions can compose without a schema change.
 */
function computeHoldForReview(job, ctx = {}) {
  const reasons = [];

  if (!job || typeof job !== 'object') {
    return { _holdForReview: false, _holdReasons: reasons };
  }

  const isManualJob = job.artwork_source === 'manual';
  if (isManualJob) {
    reasons.push(REASON.MANUAL_SOURCE);
  }

  const files = Array.isArray(job.artwork_files) ? job.artwork_files : [];

  // 'manual-file' is only emitted on MIXED jobs — when the job-level source
  // is not 'manual' but at least one file is. For a wholly-manual job,
  // 'manual-source' is the stronger statement and we don't repeat it.
  if (!isManualJob && files.some((f) => f && f.source === 'manual')) {
    reasons.push(REASON.MANUAL_FILE);
  }

  // Routing hold (v1.7.8): process is flagged "Hold for manual release" in
  // Process Routing AND the operator hasn't released this specific job yet.
  // Released flag is per-job, persisted on the jobs-cache by the
  // routing:releaseHold IPC handler. Toggling the process hold OFF in
  // Settings drops this reason on the next derive — released flag is sticky
  // and unaffected.
  const heldProcesses = ctx && ctx.routingHeldProcesses;
  if (
    heldProcesses &&
    typeof heldProcesses.has === 'function' &&
    !job._routingHoldReleased &&
    heldProcesses.has(job.process)
  ) {
    reasons.push(REASON.ROUTING_HOLD);
  }

  // Over-batch-threshold (M3, 2026-08-09): the job's total print count
  // exceeds the controller's maxPrintsPerJob cap. Darkroom Pro only in
  // this milestone.
  //
  // The resolver returns { cap, prints } only when BOTH are known — the
  // route carries a positive cap AND the caller has determined a total
  // print count (typically by reading the manifest, the same source the
  // M4 splitter uses). Returns null otherwise; the reason is then
  // skipped. This makes the derivation trivially pure: no fs, no store,
  // no per-source arithmetic.
  //
  // The operator's manual Send-to-Print click is the release trigger —
  // ipc-handlers.jobs:sendToPrint does not consult this gate. Only the
  // auto-print loop and the routing-hold flow read _holdForReview.
  //
  // Backward-compatible: no resolver, or a resolver that returns null,
  // means the reason is not emitted (M1 behaviour).
  const check = ctx && ctx.batchThresholdCheck;
  if (typeof check === 'function') {
    const r = check(job);
    if (
      r
      && Number.isFinite(r.cap) && r.cap > 0
      && Number.isFinite(r.prints) && r.prints > r.cap
    ) {
      reasons.push(REASON.OVER_BATCH_THRESHOLD);
    }
  }

  return { _holdForReview: reasons.length > 0, _holdReasons: reasons };
}

/**
 * Format the reasons array as a single tooltip string. Operator-friendly,
 * semicolon-separated. Returns the empty string when not held — callers
 * should typically gate the chip render on `_holdForReview`, not on the
 * tooltip presence.
 *
 * @param {string[]} reasons
 * @returns {string}
 */
function formatHoldReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return '';
  return reasons.map((r) => REASON_TEXT[r] || r).join('; ');
}

module.exports = {
  computeHoldForReview,
  formatHoldReasons,
  REASON,
  REASON_TEXT,
};
