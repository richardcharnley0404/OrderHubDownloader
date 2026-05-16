'use strict';

const fs = require('fs');
const path = require('path');

/**
 * FujiJobMakerFileWriter
 *
 * Stages images for a Fuji JobMaker order and writes the per-surface `.txt`
 * files into Frontier's hot folder.
 *
 * Two distinct destinations are involved:
 *   1. `imageStagingRoot\{orderRef}\`  — where the JPEGs go. Frontier reads
 *      these via the `ImagePath=` field. One folder per order; multiple
 *      surface files share the same staged images.
 *   2. `hotFolderPath\{orderRef}_{Surface}.txt`  — where the order files go.
 *      Frontier consumes these from the watch folder.
 *
 * Write ordering (important):
 *   Images are staged FIRST. Only once every image is on disk do we write the
 *   `.txt` files. If we wrote the `.txt` first, Frontier could pick it up
 *   before the images existed and reject the order.
 *
 * Atomic-ish `.txt` writes:
 *   Each `.txt` is written to a `.txt.tmp` sibling first, then renamed to its
 *   final name. Within a single volume the rename is atomic on Windows, so
 *   Frontier never sees a partial file in its watch folder.
 *
 * Failure behaviour:
 *   On any I/O error we throw. Partially-staged images and any `.txt.tmp`
 *   leftovers stay on disk for operator review — same convention as the
 *   Darkroom Pro writer. Cleanup is intentionally manual so the operator can
 *   inspect what went wrong before retrying.
 *
 * See: docs/print-controllers/FUJI-JOBMAKER-FORMAT.md
 */

const TMP_SUFFIX = '.tmp';

class FujiJobMakerFileWriter {
  /**
   * Write a complete Fuji JobMaker submission for one order.
   *
   * @param {object} args
   * @param {string} args.hotFolderPath     Absolute path to Frontier's watch folder.
   * @param {string} args.imageStagingRoot  Absolute path under which the per-order
   *                                        image folder is created.
   * @param {string} args.orderRef          Order number (used for the staging
   *                                        subfolder and the `.txt` filename stem).
   * @param {Array<{sourcePath:string, filename:string}>} args.imageFiles
   *                                        All images this order references — both
   *                                        front images and (in image-mode
   *                                        BackPrint) back-print images. Deduped
   *                                        by `filename` before copying.
   * @param {Array<{filename:string, contents:string}>} args.surfaceFiles
   *                                        Output of `generateFujiJobMakerFiles`.
   *                                        One entry per surface group.
   * @returns {Promise<{
   *   imageStagingFolder: string,
   *   copiedImages:       string[],
   *   writtenFiles:       string[],
   * }>}
   * @throws on any I/O failure — partial state is left on disk for operator review.
   */
  async writeOrderFiles({
    hotFolderPath,
    imageStagingRoot,
    orderRef,
    imageFiles,
    surfaceFiles,
  }) {
    this._validateArgs({ hotFolderPath, imageStagingRoot, orderRef, imageFiles, surfaceFiles });

    // ── 1. Stage images ──────────────────────────────────────────────────
    const imageStagingFolder = path.join(imageStagingRoot, orderRef);
    await fs.promises.mkdir(imageStagingFolder, { recursive: true });

    const copiedImages = await this._copyImages(imageFiles, imageStagingFolder);

    // ── 2. Write surface .txt files (atomic rename) ──────────────────────
    // Hot folder must exist — we don't auto-create it because a missing hot
    // folder usually means the controller is misconfigured and we want to
    // surface that to the operator rather than silently creating an empty
    // folder Frontier isn't watching.
    if (!fs.existsSync(hotFolderPath)) {
      throw new Error(`Fuji JobMaker hot folder does not exist: ${hotFolderPath}`);
    }

    const writtenFiles = [];
    for (const surfaceFile of surfaceFiles) {
      const finalPath = path.join(hotFolderPath, surfaceFile.filename);
      const tmpPath = finalPath + TMP_SUFFIX;

      // utf-8 is correct for ASCII printable + extended Windows characters
      // that Frontier accepts in CustomerName, BackPrint etc.
      await fs.promises.writeFile(tmpPath, surfaceFile.contents, 'utf-8');
      await fs.promises.rename(tmpPath, finalPath);

      writtenFiles.push(finalPath);
    }

    return { imageStagingFolder, copiedImages, writtenFiles };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────

  _validateArgs({ hotFolderPath, imageStagingRoot, orderRef, imageFiles, surfaceFiles }) {
    if (!hotFolderPath)    throw new Error('Fuji JobMaker writer: `hotFolderPath` is required');
    if (!imageStagingRoot) throw new Error('Fuji JobMaker writer: `imageStagingRoot` is required');
    if (!orderRef)         throw new Error('Fuji JobMaker writer: `orderRef` is required');
    if (!Array.isArray(imageFiles)) {
      throw new Error('Fuji JobMaker writer: `imageFiles` must be an array');
    }
    if (!Array.isArray(surfaceFiles) || surfaceFiles.length === 0) {
      throw new Error('Fuji JobMaker writer: `surfaceFiles` must contain at least one file');
    }
    for (const img of imageFiles) {
      if (!img || !img.sourcePath || !img.filename) {
        throw new Error('Fuji JobMaker writer: every `imageFiles` entry needs { sourcePath, filename }');
      }
    }
    for (const sf of surfaceFiles) {
      if (!sf || !sf.filename || typeof sf.contents !== 'string') {
        throw new Error('Fuji JobMaker writer: every `surfaceFiles` entry needs { filename, contents }');
      }
    }
  }

  /**
   * Copy every unique image into the staging folder. Duplicates (same target
   * filename) are copied once — useful when several surface files reference
   * the same back-print image, or when a job has the same source image used
   * for multiple prints.
   *
   * @returns {Promise<string[]>} absolute destination paths in input order
   *                              (with duplicates collapsed)
   */
  async _copyImages(imageFiles, destFolder) {
    const seen = new Set();
    const copied = [];

    for (const img of imageFiles) {
      if (seen.has(img.filename)) continue;
      seen.add(img.filename);

      const destPath = path.join(destFolder, img.filename);
      await fs.promises.copyFile(img.sourcePath, destPath);
      copied.push(destPath);
    }

    return copied;
  }
}

const fujiJobMakerFileWriter = new FujiJobMakerFileWriter();
module.exports = { fujiJobMakerFileWriter, FujiJobMakerFileWriter };
