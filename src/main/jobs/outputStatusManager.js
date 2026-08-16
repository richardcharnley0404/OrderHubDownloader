'use strict';

/**
 * src/main/jobs/outputStatusManager.js
 *
 * Reads the DPOF output folder for a job and returns which prefix
 * (p / o / q / e) is currently present on disk.
 *
 * Prefix → status mapping:
 *   p  Import Error      (write failed midway — file transfer incomplete)
 *   o  Awaiting Import   (successfully written, waiting for controller)
 *   q  Failed Import     (controller attempted import but failed)
 *   e  Printed           (operator has confirmed job is printed)
 */

const fs   = require('fs');
const path = require('path');
const { buildFolderName } = require('../../shared/printUtils');

// Ordered list — checked in sequence.
const PREFIXES = ['p', 'o', 'q', 'e'];

/**
 * Scan destBasePath for a folder matching any known prefix + the job's base name.
 *
 * @param {object} job          - Job object (needs job_name, product, options)
 * @param {string} destBasePath - Hot folder / output base path for the controller
 * @param {string|null} reprintSuffix - e.g. 'r1', or null for a normal job
 * @param {object}      [nameOpts]    - Forwarded to buildFolderName
 *   - includeCustomerName: boolean (default false)
 *   - customerName: string (default job.customer_name)
 *   - batch: {index, total}  (M4) — when set, looks for the batch-suffixed
 *     folder name (e.g. `e{jobStuff}_2of5_{rest}`). When absent, behaves
 *     as pre-M4 (single-folder-per-job lookup).
 * @returns {Promise<{ prefix: string, folderName: string, folderPath: string }|null>}
 *          Returns null if no matching folder is found (job not yet sent).
 */
async function getJobOutputStatus(job, destBasePath, reprintSuffix = null, nameOpts = {}) {
  // Spread FIRST so any current or future field on nameOpts flows through
  // to buildFolderName; then normalise the two we defensively coerce.
  // Same posture as order-folder-writer.js — see the fix commit for the
  // bug where the pre-spread cherry-pick silently dropped `batch` and
  // every batch of a split job produced the same folder name.
  const resolvedOpts = {
    ...nameOpts,
    includeCustomerName: !!nameOpts.includeCustomerName,
    customerName:        nameOpts.customerName != null ? nameOpts.customerName : (job.customer_name || ''),
  };
  const baseName = buildFolderName('', job, reprintSuffix, resolvedOpts); // no prefix

  for (const prefix of PREFIXES) {
    const folderName = `${prefix}${baseName}`;
    const folderPath = path.join(destBasePath, folderName);
    try {
      await fs.promises.access(folderPath);
      return { prefix, folderName, folderPath };
    } catch {
      // Folder not present — try next prefix
    }
  }

  return null; // Job not yet sent to this controller
}

module.exports = { getJobOutputStatus };
