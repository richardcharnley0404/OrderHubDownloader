'use strict';

/**
 * src/shared/printUtils.js
 *
 * Shared utilities for the DPOF print pipeline.
 * Used by both main process (print-service, outputStatusManager)
 * and shared logic (reprint pipeline).
 */

// Characters that are unsafe in Windows/NTFS folder names.
// Spaces are intentionally left — they improve readability.
const UNSAFE_CHARS = /["/\\:*?<>|]/g;

/**
 * Extract the surname (last whitespace-separated token) from a full
 * customer name. Falls back to the full name when the input contains
 * a single token (no whitespace).
 *
 * @param {string} customerName  - e.g. "Richard Charnley", "Cher"
 * @returns {string}             - sanitised surname (NTFS-safe), or '' for empty input
 */
function extractSurname(customerName) {
  const safe = (customerName || '').replace(UNSAFE_CHARS, '').trim();
  if (!safe) return '';
  const tokens = safe.split(/\s+/);
  return tokens.length > 1 ? tokens[tokens.length - 1] : safe;
}

/**
 * Build a DPOF output folder name from a job object.
 *
 * Format:  {prefix}{jobId}_{jobNo}[_{surname}][_{reprintSuffix}]_{product}_{optionValues}
 *
 * Examples:
 *   buildFolderName('o', job)
 *     → 'o38461218_PXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed'
 *
 *   buildFolderName('o', job, null, { includeCustomerName: true, customerName: 'Richard Charnley' })
 *     → 'o38461218_PXDEMO-DR2PE0-1_Charnley_4x6 Photo Print_lustre_full-bleed'
 *
 *   buildFolderName('o', job, 'r1', { includeCustomerName: true, customerName: 'Richard Charnley' })
 *     → 'o38461218_PXDEMO-DR2PE0-1_Charnley_r1_4x6 Photo Print_lustre_full-bleed'
 *
 *   buildFolderName('o', job, 'r1')
 *     → 'o38461218_PXDEMO-DR2PE0-1_r1_4x6 Photo Print_lustre_full-bleed'
 *
 * Field mapping (confirmed against live job object):
 *   jobId   ← job.id         e.g. 38461218 (numeric OH job id; same value emitted as USR CID)
 *   jobNo   ← job.job_name   e.g. "PXDEMO-DR2PE0-1"
 *   product ← job.product    e.g. '4x6" Photo Print'
 *   options ← job.options    e.g. [{ name: "finish-options", value: "lustre" }, ...]
 *
 * Job-id fallback: if job.id is missing/empty, falls back to job.order_number — mirrors
 * the CID fallback in dpof-generator.js so the folder segment and USR CID stay aligned.
 *
 * @param {string}      prefix        - Single prefix char: 'p', 'o', 'q', or 'e'
 * @param {object}      job           - Job object from OrderHub API / local cache
 * @param {string|null} reprintSuffix - Optional reprint suffix, e.g. 'r1', 'r2'
 * @param {object}      [opts]        - Optional behavior flags
 * @param {boolean}     [opts.includeCustomerName=false] - Insert surname after jobNo
 * @param {string}      [opts.customerName='']           - Source name; surname is extracted from this
 * @returns {string}
 */
function buildFolderName(prefix, job, reprintSuffix = null, opts = {}) {
  const rawJobId = (job.id !== undefined && job.id !== null && job.id !== '')
    ? job.id
    : (job.order_number || '');
  const jobId   = String(rawJobId).replace(UNSAFE_CHARS, '');
  const jobNo   = (job.job_name || '').replace(UNSAFE_CHARS, '');
  const reprint = reprintSuffix ? `_${reprintSuffix.replace(UNSAFE_CHARS, '')}` : '';
  const product = (job.product  || '').replace(UNSAFE_CHARS, '').trim();

  const options = (job.options || [])
    .map(opt => (opt.value || '').replace(UNSAFE_CHARS, '').trim())
    .filter(Boolean)
    .join('_');

  // Surname segment — falls between jobNo and reprintSuffix so reprints stay
  // adjacent to the product (matches operator request 2026-05-18).
  let surnameSeg = '';
  if (opts.includeCustomerName) {
    const surname = extractSurname(opts.customerName);
    if (surname) surnameSeg = `_${surname}`;
  }

  const segments = [`${jobNo}${surnameSeg}${reprint}`, product, options].filter(Boolean).join('_');
  return `${prefix}${jobId}_${segments}`;
}

/**
 * Strip a leading, case-insensitive prefix from an order number when
 * building the submission id that becomes the filesystem path in
 * `{imageStagingRoot}/{id}`, `{orderDataPath}/{id}.txt`, and
 * `{diginPath}/{id}`. Purely a display / naming transform — the caller
 * (order-submission-seq) still keys its counter on the ORIGINAL order
 * number so two prefixed orders that strip to the same base can't
 * collide.
 *
 * Rules (matching the per-controller Strip Order Number Prefix field):
 *   - Blank / null / undefined prefix → return the order number unchanged.
 *     (Blank is the default — the field is opt-in per controller.)
 *   - Non-string order number → return it verbatim (defensive; caller
 *     shape errors are the caller's problem, not ours).
 *   - Leading match only. `stripOrderNumberPrefix('AAA-1', 'AAA-')` → `'1'`;
 *     `stripOrderNumberPrefix('X-AAA-1', 'AAA-')` → `'X-AAA-1'` (prefix is
 *     not at the start).
 *   - Case-insensitive on the prefix match — but the returned value
 *     preserves the ORIGINAL order-number casing for whatever survives
 *     the strip. So `stripOrderNumberPrefix('pxdemo-1234', 'PXDEMO-')`
 *     → `'1234'`; `stripOrderNumberPrefix('PXDEMO-Abc9', 'pxdemo-')`
 *     → `'Abc9'`.
 *   - Never strip down to an empty string. If the prefix matches the
 *     whole order number (e.g. `'PXDEMO-'` against `'PXDEMO-'`), return
 *     the order number unchanged — a submission id must have SOMETHING
 *     to name the folder after.
 *
 * @param {string} orderNumber
 * @param {string} [prefix] — the per-controller Strip Order Number
 *   Prefix. Blank / null / undefined means "no stripping".
 * @returns {string}
 */
function stripOrderNumberPrefix(orderNumber, prefix) {
  if (typeof orderNumber !== 'string' || orderNumber.length === 0) return orderNumber;
  if (typeof prefix !== 'string' || prefix.length === 0) return orderNumber;
  if (orderNumber.length < prefix.length) return orderNumber;
  const head = orderNumber.slice(0, prefix.length);
  if (head.toLowerCase() !== prefix.toLowerCase()) return orderNumber;
  const stripped = orderNumber.slice(prefix.length);
  if (stripped.length === 0) return orderNumber;   // never strip to empty
  return stripped;
}

module.exports = { buildFolderName, extractSurname, stripOrderNumberPrefix };
