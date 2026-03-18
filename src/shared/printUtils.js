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
 * Build a DPOF output folder name from a job object.
 *
 * Format:  {prefix}{jobNo}[_{reprintSuffix}]_{product}_{optionValues}
 *
 * Examples:
 *   buildFolderName('p', job)
 *     → 'pPXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed'
 *
 *   buildFolderName('o', job)
 *     → 'oPXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed'
 *
 *   buildFolderName('o', job, 'r1')
 *     → 'oPXDEMO-DR2PE0-1_r1_4x6 Photo Print_lustre_full-bleed'
 *
 * Field mapping (confirmed against live job object):
 *   jobNo   ← job.job_name   e.g. "PXDEMO-DR2PE0-1"
 *   product ← job.product    e.g. '4x6" Photo Print'
 *   options ← job.options    e.g. [{ name: "finish-options", value: "lustre" }, ...]
 *
 * @param {string}      prefix        - Single prefix char: 'p', 'o', 'q', or 'e'
 * @param {object}      job           - Job object from OrderHub API / local cache
 * @param {string|null} reprintSuffix - Optional reprint suffix, e.g. 'r1', 'r2'
 * @returns {string}
 */
function buildFolderName(prefix, job, reprintSuffix = null) {
  const jobNo   = (job.job_name || '').replace(UNSAFE_CHARS, '');
  const reprint = reprintSuffix ? `_${reprintSuffix.replace(UNSAFE_CHARS, '')}` : '';
  const product = (job.product  || '').replace(UNSAFE_CHARS, '').trim();

  const options = (job.options || [])
    .map(opt => (opt.value || '').replace(UNSAFE_CHARS, '').trim())
    .filter(Boolean)
    .join('_');

  const segments = [`${jobNo}${reprint}`, product, options].filter(Boolean).join('_');
  return `${prefix}${segments}`;
}

module.exports = { buildFolderName };
