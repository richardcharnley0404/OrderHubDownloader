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
 * Format:  {prefix}{jobId}_{jobNo}[_{surname}][_{discriminator}]_{product}_{optionValues}
 *
 * The discriminator slot carries EITHER a reprint suffix (`r1`, `r2`) OR
 * a batch marker (`2of5`). Reprints and batches share the same slot on
 * purpose — an unsplit non-reprint job has NO discriminator at all, and
 * its folder name is byte-identical to the pre-batch-splitting output
 * (locked by a regression test in printUtils.test.js). See M1 of
 * docs/epson-batch-splitting-brief.md for the "unsplit folder name
 * must not change" constraint.
 *
 * The two are mutually exclusive: supplying BOTH `reprintSuffix` AND
 * `opts.batch` throws — reprints of split jobs don't exist as a
 * scenario yet (per-batch resend from the ledger is M4, and that
 * reuses the original batch's folder name unchanged).
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
 *   buildFolderName('o', job, null, { batch: { index: 2, total: 5 } })
 *     → 'o38461218_PXDEMO-DR2PE0-1_2of5_4x6 Photo Print_lustre_full-bleed'
 *
 * Batch marker choice (`_2of5`). Compact (4 chars for 5-batch splits),
 * NTFS-safe (no reserved chars), and self-describing at a glance in a
 * folder listing — a person watching the hot folder can read
 * "2 of 5" without knowing anything about OHD internals. The brief
 * called out that a person reads these names at this lab; the marker
 * has to survive that constraint.
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
 * @param {{index:number, total:number}} [opts.batch]    - Batch descriptor for split
 *   dispatches. Renders as `_{index}of{total}` in the discriminator slot
 *   (same position as reprintSuffix). MUST NOT be passed alongside a
 *   non-null reprintSuffix — throws in that case. Absent = unsplit
 *   (folder name is byte-identical to pre-M1 output).
 * @returns {string}
 */
function buildFolderName(prefix, job, reprintSuffix = null, opts = {}) {
  const batch = opts.batch;
  if (reprintSuffix && batch) {
    // Mutually exclusive per the "same slot" rule. If we ever need
    // reprint-of-a-split-job this throw is the tripwire that will
    // surface the design decision — don't paper over it silently.
    throw new Error('buildFolderName: reprintSuffix and opts.batch are mutually exclusive');
  }
  if (batch) {
    if (!Number.isInteger(batch.index) || batch.index < 1
        || !Number.isInteger(batch.total) || batch.total < 1
        || batch.index > batch.total) {
      throw new Error(`buildFolderName: opts.batch must be {index:integer≥1, total:integer≥index}; got ${JSON.stringify(batch)}`);
    }
  }

  const rawJobId = (job.id !== undefined && job.id !== null && job.id !== '')
    ? job.id
    : (job.order_number || '');
  const jobId   = String(rawJobId).replace(UNSAFE_CHARS, '');
  const jobNo   = (job.job_name || '').replace(UNSAFE_CHARS, '');
  const product = (job.product  || '').replace(UNSAFE_CHARS, '').trim();

  const options = (job.options || [])
    .map(opt => (opt.value || '').replace(UNSAFE_CHARS, '').trim())
    .filter(Boolean)
    .join('_');

  // Discriminator: reprint XOR batch XOR nothing. Slot sits between
  // (jobNo[_surname]) and product — same position it sat in pre-M1
  // for reprints, so the format string is stable.
  let discriminator = '';
  if (reprintSuffix) {
    discriminator = `_${reprintSuffix.replace(UNSAFE_CHARS, '')}`;
  } else if (batch) {
    discriminator = `_${batch.index}of${batch.total}`;
  }

  // Surname segment — falls between jobNo and the discriminator so
  // reprints (and now batches) stay adjacent to the product (matches
  // operator request 2026-05-18).
  let surnameSeg = '';
  if (opts.includeCustomerName) {
    const surname = extractSurname(opts.customerName);
    if (surname) surnameSeg = `_${surname}`;
  }

  const segments = [`${jobNo}${surnameSeg}${discriminator}`, product, options].filter(Boolean).join('_');
  return `${prefix}${jobId}_${segments}`;
}

/**
 * Parse a DPOF folder name back into its structured parts. Inverse of
 * `buildFolderName` for the fields the folder-monitor needs to
 * attribute a status event to the right job (and the right batch /
 * reprint within it). Callers that just want to know "which prefix"
 * can grab it from `.prefix`; callers that need to distinguish a
 * batch-2-of-5 event from a batch-1-of-5 event use `.batch`.
 *
 * Returns null when the folder name doesn't match the DPOF shape at
 * all (a foreign folder someone dropped into the hot folder, a
 * partial rename mid-atomicity, etc). Callers should treat null as
 * "not one of ours; ignore".
 *
 * Extraction of the batch and reprint markers is anchored — the token
 * has to be surrounded by `_` on both sides and the batch integers
 * are simple (`\d+of\d+`) so a jobNo that happens to contain a
 * substring like `10of20` inside product text doesn't false-match.
 * Batch and reprint markers cannot both appear (buildFolderName
 * throws on that shape); if both somehow appear the batch wins for
 * parsing purposes and a note is left in the docblock rather than a
 * silent misattribution.
 *
 * @param {string} folderName - e.g. 'o38461218_PXDEMO-1_2of5_4x6 Photo Print_lustre'
 * @returns {{prefix:string, jobId:string, batch:{index:number,total:number}|null, reprintSuffix:string|null, rest:string}|null}
 */
function parseFolderName(folderName) {
  if (typeof folderName !== 'string' || folderName.length === 0) return null;
  // Prefix + jobId + everything else. Tightened from the pre-M1 shape
  // (which called the trailing group `productCode` — misleading; it's
  // job-name + optional surname + optional discriminator + product +
  // options). We take the "rest" and dig for markers inside.
  const outer = folderName.match(/^([poeq])(\d+)_(.+)$/);
  if (!outer) return null;
  const [, prefix, jobId, rest] = outer;

  // Batch marker: `_{index}of{total}` preceded and followed by `_`
  // (or end-of-string on the trailing side — belt-and-braces even
  // though buildFolderName always emits `_product_...` after).
  const batchMatch = rest.match(/_(\d+)of(\d+)(?=_|$)/);
  let batch = null;
  if (batchMatch) {
    const index = parseInt(batchMatch[1], 10);
    const total = parseInt(batchMatch[2], 10);
    if (Number.isInteger(index) && Number.isInteger(total)
        && index >= 1 && total >= 1 && index <= total) {
      batch = { index, total };
    }
  }

  // Reprint marker: `_r{n}` preceded and followed by `_` (or EOL).
  // `r` immediately followed by digits, `r1` through `r999+`. We
  // deliberately don't allow arbitrary letters after `r` — the
  // reprint suffix in the codebase is always `r` + integer.
  const reprintMatch = rest.match(/_(r\d+)(?=_|$)/);
  const reprintSuffix = batch ? null : (reprintMatch ? reprintMatch[1] : null);

  return { prefix, jobId, batch, reprintSuffix, rest };
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

module.exports = { buildFolderName, parseFolderName, extractSurname, stripOrderNumberPrefix };
