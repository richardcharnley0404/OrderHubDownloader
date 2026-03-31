'use strict';

/**
 * src/main/services/process-folder-service.js
 *
 * Handles the "process-folder" routing type: copies a job's artwork files
 * flat into a destination folder, then marks the job as Sent immediately.
 *
 * This is Layer 1 of the routing decision tree (processFolderExceptions).
 * Jobs handled here skip the DPOF pipeline entirely — no IMAGES/MISC
 * structure, no prefix-swap, no hot-folder monitoring.
 *
 * Folder naming follows the same convention as DPOF for consistency:
 *   {jobNo}[_{reprintSuffix}]_{product}_{optionValues}
 * with no prefix character (since there is no p/o/q/e lifecycle here).
 */

const fs   = require('fs');
const path = require('path');

const configService = require('./config-service');
const jobService    = require('./job-service');
const logger        = require('./logger');
const { buildFolderName } = require('../../shared/printUtils');

class ProcessFolderService {
  /**
   * Copy a job's artwork files to a flat destination folder.
   *
   * Source images are located by the same path convention as the DPOF
   * pipeline — the job folder inside the download directory.
   *
   * @param {object} job           - Job object from the OH API / job-service cache.
   * @param {string} destFolderPath - Root process folder path (from the exception config).
   * @returns {Promise<{ success: boolean, folderPath?: string, error?: string }>}
   */
  async copyToFolder(job, destFolderPath) {
    if (!destFolderPath) {
      return { success: false, error: 'No destination folder path configured for this exception.' };
    }

    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      return { success: false, error: 'Download directory is not configured.' };
    }

    const orderFolderName = `${job.order_number || ''}_${job.order_id}`;
    const jobFolderName   = `${job.order_number || ''}_${job.id}`;
    const sourcePath      = path.join(downloadDirectory, orderFolderName, jobFolderName);

    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: `Job folder not found: ${sourcePath}` };
    }

    // Build the destination sub-folder name — same naming as DPOF but no prefix.
    const folderName = buildFolderName('', job); // empty prefix
    const destPath   = path.join(destFolderPath, folderName);

    logger.info('Copying job to process folder', {
      jobId:       job.id,
      orderNumber: job.order_number,
      source:      sourcePath,
      dest:        destPath,
    });

    try {
      await fs.promises.mkdir(destPath, { recursive: true });

      // Copy all files from the job folder flat — no IMAGES/MISC sub-structure.
      // Sub-folders (originals, working, cache) are skipped; only the top-level
      // image files and any existing files in the root are copied.
      const entries = await fs.promises.readdir(sourcePath, { withFileTypes: true });
      let copied = 0;

      for (const entry of entries) {
        if (!entry.isFile()) continue; // skip sub-folders

        const src  = path.join(sourcePath, entry.name);
        const dest = path.join(destPath,   entry.name);
        await fs.promises.copyFile(src, dest);
        copied++;
      }

      // If no files were at the job root, fall back to copying from /working/
      // (which is where images land after the first Job Review open).
      if (copied === 0) {
        const workingPath = path.join(sourcePath, 'working');
        if (fs.existsSync(workingPath)) {
          const workingEntries = await fs.promises.readdir(workingPath, { withFileTypes: true });
          for (const entry of workingEntries) {
            if (!entry.isFile()) continue;
            const src  = path.join(workingPath, entry.name);
            const dest = path.join(destPath,    entry.name);
            await fs.promises.copyFile(src, dest);
            copied++;
          }
        }
      }

      logger.info('Process folder copy complete', {
        jobId:     job.id,
        destPath,
        fileCount: copied,
      });
    } catch (err) {
      logger.logError('Process folder copy failed', err, { jobId: job.id, destPath });
      return { success: false, error: `Copy failed: ${err.message}` };
    }

    // Mark as completed immediately — no p/o/q/e lifecycle for process-folder jobs.
    try {
      await jobService.markCompleted(job.id);
    } catch (err) {
      logger.logWarning('Process folder job sent but API status update failed', {
        jobId: job.id,
        error: err.message,
      });
      jobService.updateJobLocally(job.id, { _status: 'completed' });
    }

    return { success: true, folderPath: destPath };
  }
}

module.exports = new ProcessFolderService();
