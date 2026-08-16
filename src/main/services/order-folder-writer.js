'use strict';

/**
 * src/main/services/order-folder-writer.js
 *
 * Writes a DPOF job to a controller hot folder using the safe prefix-swap pattern.
 *
 * Folder structure written:
 *   {prefix}{jobId}_{jobNo}_{product}_{options}/
 *     IMAGES/          ← all image files copied here (DPOF spec: plural)
 *     MISC/
 *       AUTPRINT.MRK   ← DPOF instruction file
 *
 * Prefix swap:
 *   1. Folder created with prefix "p" (in-progress — controller ignores it)
 *   2. All files written successfully
 *   3. Folder renamed p → o (signals controller the job is ready to import)
 *   4. On any write error: leave as "p" (operator sees "Import Error" status)
 */

const fs   = require('fs');
const path = require('path');
const { buildFolderName } = require('../../shared/printUtils');

class OrderFolderWriter {
  /**
   * Write a DPOF job to the controller's hot folder.
   *
   * @param {string}      hotFolderPath  - Controller's hot folder base path
   * @param {object}      job            - Job object (needs job_name, product, options)
   * @param {string}      dpofContent    - Generated DPOF content (written to MISC/AUTPRINT.MRK)
   * @param {Array}       imageFiles     - Array of { sourcePath: string, filename: string }
   * @param {string|null} reprintSuffix  - e.g. 'r1', 'r2', or null for a normal job
   * @param {object}      [nameOpts]     - Forwarded to buildFolderName
   *   - includeCustomerName: boolean (default false)
   *   - customerName:        string  (default job.customer_name)
   *   - batch:               {index,total} (M3 of docs/epson-batch-splitting-brief.md
   *                          — writer must forward this to buildFolderName or every
   *                          batch of a split job produces the same folder name and
   *                          batch 2's p→o rename collides with batch 1 on Windows
   *                          [EPERM])
   * @returns {Promise<{ folderPath: string, folderName: string }>}
   * @throws  On any I/O error — temp "p" folder is left in place for operator review
   */
  async writeOrderFolder(hotFolderPath, job, dpofContent, imageFiles, reprintSuffix = null, nameOpts = {}) {
    // Spread FIRST so any current or future field on nameOpts flows through
    // to buildFolderName (M3 `batch`, plus anything M-something adds later);
    // then normalise the two we defensively coerce. The pre-fix cherry-pick
    // dropped `batch` silently and every batch of a split job produced the
    // same folder name — batch 1 renamed p→o, batch 2 hit EPERM on the
    // rename and never reached the printer. See fix commit for the
    // trap-job test that pins this.
    const resolvedOpts = {
      ...nameOpts,
      includeCustomerName: !!nameOpts.includeCustomerName,
      customerName:        nameOpts.customerName != null ? nameOpts.customerName : (job.customer_name || ''),
    };
    const tempName  = buildFolderName('p', job, reprintSuffix, resolvedOpts);
    const finalName = buildFolderName('o', job, reprintSuffix, resolvedOpts);
    const tempPath  = path.join(hotFolderPath, tempName);
    const finalPath = path.join(hotFolderPath, finalName);

    // Create IMAGES/ and MISC/ subdirectories (DPOF spec: IMAGES, plural)
    await fs.promises.mkdir(path.join(tempPath, 'IMAGES'), { recursive: true });
    await fs.promises.mkdir(path.join(tempPath, 'MISC'),   { recursive: true });

    // Copy all image files into IMAGES/
    for (const img of imageFiles) {
      await fs.promises.copyFile(
        img.sourcePath,
        path.join(tempPath, 'IMAGES', img.filename)
      );
    }

    // Write DPOF instruction file into MISC/
    await fs.promises.writeFile(
      path.join(tempPath, 'MISC', 'AUTPRINT.MRK'),
      dpofContent,
      'utf-8'
    );

    // All files written — rename p → o (atomic signal to controller)
    await fs.promises.rename(tempPath, finalPath);

    return { folderPath: finalPath, folderName: finalName };
  }
}

const orderFolderWriter = new OrderFolderWriter();
module.exports = { orderFolderWriter, OrderFolderWriter };
