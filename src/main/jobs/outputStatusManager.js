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
 * @returns {Promise<{ prefix: string, folderName: string, folderPath: string }|null>}
 *          Returns null if no matching folder is found (job not yet sent).
 */
async function getJobOutputStatus(job, destBasePath, reprintSuffix = null) {
  const baseName = buildFolderName('', job, reprintSuffix); // no prefix

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
