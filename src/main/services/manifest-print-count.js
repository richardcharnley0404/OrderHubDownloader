'use strict';

const fs   = require('fs');
const path = require('path');

const configService                = require('./config-service');
const logger                       = require('./logger');
const { resolveManifestPath }      = require('./manifest-path');

/**
 * src/main/services/manifest-print-count.js
 *
 * Sync helper that returns the total print count for a job by summing
 * per-image `quantity` fields in the order manifest. This is the SAME
 * source _sendViaDarkroomProRouted uses at dispatch time
 * (print-service.js:1938 — `manifestImg.quantity || 1`), so the M3 hold
 * gate and the M4 splitter agree by construction. See
 * docs/batch-splitting-darkroom-pro-brief.md and the M3 investigation:
 * job.quantity is unreliable across sources (film / manual / Pixfizz
 * treat it differently) and artwork_files[].copies sums to 0 on FTP
 * Pixfizz jobs until the manifest lands — the manifest is the only
 * source that matches the splitter for every job type.
 *
 * The read is synchronous because both entry points want a scalar:
 *   - job-service._stampPrintCount calls it once per job then caches
 *     the result on `job._totalPrintCount` — subsequent polls avoid
 *     the disk hit entirely (SMB-safe; the labs' downloadDirectory is
 *     typically a share).
 *   - runAutoPrint's resolver calls it fresh at decision time; the
 *     cost is one small-file read per eligible job per cycle, and the
 *     awaiting-manifest gate above guarantees the file is on disk by
 *     the time we get here.
 *
 * Failure modes all return null (fail-open): missing downloadDirectory,
 * missing order fields, manifest not present, non-empty read errors,
 * parse errors, jobId not found in the manifest, images array missing.
 * The caller (holdForReview via the batchThresholdCheck resolver) then
 * skips the over-batch-threshold reason — matching the existing
 * "missing ctx yields today's behaviour" contract on the derivation.
 *
 * A failed read here does NOT block dispatch — print-service._readManifest
 * has its own 4-attempt retry that will surface a genuine "manifest
 * never arrived" case as an error. This helper is deliberately quiet.
 */

/**
 * @param {object} job - Local job object (post-mapping); must carry
 *   `order_number`, `order_id`, `id`, optionally `internal_job_id`.
 * @returns {number|null} total prints, or null when the count cannot
 *   be determined for any reason.
 */
function readManifestPrintCountSync(job) {
  if (!job || !job.order_number || !job.order_id || job.id == null) {
    return null;
  }

  const downloadDirectory = configService.get('downloadDirectory');
  if (!downloadDirectory) return null;

  const orderFolderPath = path.join(downloadDirectory, `${job.order_number}_${job.order_id}`);
  const manifestPath    = resolveManifestPath(orderFolderPath, job.order_number);

  let raw;
  try {
    // Existence + non-empty check first — cheaper than a doomed readFile
    // on a large network share, and mirrors checkLocalFiles.hasManifest's
    // gate (job-download-service.js:97) which is the reason we ever land
    // here in the first place.
    if (!fs.existsSync(manifestPath)) return null;
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size === 0) return null;
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (_e) {
    // ENOENT / EPERM / EBUSY on SMB — quiet, next call retries.
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (parseErr) {
    // Partial write mid-FTP-stream — same race print-service._readManifest
    // handles with its 4-attempt retry. Log once at debug level so a
    // persistent parse failure is visible without spamming.
    logger.logWarning('[manifest-print-count] manifest present but not JSON — treating as unknown', {
      jobId:        job.id,
      manifestPath,
      error:        parseErr.message,
    });
    return null;
  }

  if (!manifest || !Array.isArray(manifest.jobs)) return null;

  const jobIdStr        = String(job.id);
  const internalJobIdStr = job.internal_job_id != null ? String(job.internal_job_id) : null;

  const entry = manifest.jobs.find((j) => {
    if (!j || j.jobId == null) return false;
    const mid = String(j.jobId);
    return mid === jobIdStr || (internalJobIdStr && mid === internalJobIdStr);
  });
  if (!entry || !Array.isArray(entry.images)) return null;

  let total = 0;
  for (const img of entry.images) {
    const q = img && Number.isFinite(img.quantity) && img.quantity > 0 ? img.quantity : 1;
    total += q;
  }
  return total;
}

/**
 * First-write cache wrapper for readManifestPrintCountSync. Sets
 * `job._totalPrintCount` on the passed-in object the first time we
 * successfully compute the count, and returns the cached value on
 * subsequent calls. A FAILED read (manifest not on disk yet, parse
 * error, jobId not in manifest, etc.) MUST leave the field genuinely
 * unset — a fresh job's manifest is absent on almost every first poll
 * (that's the `_awaitingManifest` state), so a stray null/0 write
 * would poison the cache forever and the Jobs-grid badge would never
 * appear for anything. Guarded by `Number.isFinite(x) && x >= 0`,
 * which returns false for `undefined` (never set), `null`, and `NaN`,
 * so a failed read simply falls through and the next poll re-reads.
 * The `manifest missing → returns null → field unset → retries next
 * poll` sequence is locked by manifest-print-count.test.js.
 *
 * Only job-service uses this. runAutoPrint deliberately reads fresh
 * via readManifestPrintCountSync directly (dispatch correctness matters
 * more than the SMB read cost).
 *
 * @param {object} job - Mutated in place on successful read. Safe to
 *   pass any object; a stamp on undefined/null returns null and
 *   nothing is mutated.
 * @returns {number|null}
 */
function stampPrintCount(job) {
  if (!job || typeof job !== 'object') return null;
  if (Number.isFinite(job._totalPrintCount) && job._totalPrintCount >= 0) {
    return job._totalPrintCount;
  }
  const n = readManifestPrintCountSync(job);
  if (Number.isFinite(n) && n >= 0) {
    job._totalPrintCount = n;
    return n;
  }
  return null;
}

module.exports = { readManifestPrintCountSync, stampPrintCount };
