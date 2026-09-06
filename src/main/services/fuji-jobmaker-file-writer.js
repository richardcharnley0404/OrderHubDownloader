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

/**
 * Resolve the default logger safely — the production service logger
 * requires electron at load time, so a bare require throws under
 * `node:test`. This wrapper falls back to a no-op stub so the writer
 * can run headlessly without an injected logger.
 */
function _defaultLogger() {
  try {
    // eslint-disable-next-line global-require
    return require('./logger');
  } catch (_) {
    return {
      info:       () => {},
      warn:       () => {},
      error:      () => {},
      logInfo:    () => {},
      logWarning: () => {},
      logError:   () => {},
    };
  }
}

class FujiJobMakerFileWriter {
  /**
   * Write a complete Fuji JobMaker submission for one order.
   *
   * @param {object} args
   * @param {string} args.hotFolderPath     Absolute path to Frontier's watch folder.
   * @param {string} args.imageStagingRoot  Absolute path under which the per-order
   *                                        image folder is created.
   * @param {string} [args.fujiImageRoot]   1.16.1 — the artwork root as the Fuji
   *                                        JobMaker machine reaches it. When set
   *                                        AND different from imageStagingRoot,
   *                                        the writer runs a dispatch-time
   *                                        reachability check between staging
   *                                        and .txt write; see
   *                                        `_verifyFujiReachability` for the
   *                                        hard-vs-soft failure discrimination.
   *                                        When absent OR equal to
   *                                        imageStagingRoot, the check is a no-op.
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
   * @param {object} [args.deps]            Optional dependency injection for tests.
   *                                        { fs, logger }
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
    fujiImageRoot,
    orderRef,
    imageFiles,
    surfaceFiles,
    deps = {},
  }) {
    this._validateArgs({ hotFolderPath, imageStagingRoot, orderRef, imageFiles, surfaceFiles });
    const fsMod  = deps.fs     || fs;
    // Lazy-loaded no-op-safe default logger. The real service logger
    // requires electron at load time so a bare `require('./logger')`
    // throws in `node:test` runs; wrap the require in try/catch so the
    // writer can be exercised headlessly without an injected logger.
    const logger = deps.logger || _defaultLogger();

    // ── 1. Stage images ──────────────────────────────────────────────────
    const imageStagingFolder = path.join(imageStagingRoot, orderRef);
    await fsMod.promises.mkdir(imageStagingFolder, { recursive: true });

    const copiedImages = await this._copyImages(imageFiles, imageStagingFolder, fsMod);

    // ── 1b. 1.16.1 — verify fujiImageRoot reachability (only when it
    //     differs from imageStagingRoot). Hard-fail if the Fuji-view
    //     path resolves the ROOT from OHD's side but not the order
    //     subfolder — that is a real configuration bug (fujiImageRoot
    //     points at a different folder than imageStagingRoot). Soft-warn
    //     if OHD cannot see the root at all — OHD may legitimately be
    //     unable to reach a share the Fuji machine can. See docstring
    //     on _verifyFujiReachability.
    if (fujiImageRoot && this._normalizeForCompare(fujiImageRoot) !== this._normalizeForCompare(imageStagingRoot)) {
      await this._verifyFujiReachability({
        fujiImageRoot,
        imageStagingRoot,
        orderRef,
        fs: fsMod,
        logger,
      });
    }

    // ── 2. Write surface .txt files (atomic rename) ──────────────────────
    // Hot folder must exist — we don't auto-create it because a missing hot
    // folder usually means the controller is misconfigured and we want to
    // surface that to the operator rather than silently creating an empty
    // folder Frontier isn't watching.
    if (!fsMod.existsSync(hotFolderPath)) {
      throw new Error(`Fuji JobMaker hot folder does not exist: ${hotFolderPath}`);
    }

    const writtenFiles = [];
    for (const surfaceFile of surfaceFiles) {
      const finalPath = path.join(hotFolderPath, surfaceFile.filename);
      const tmpPath = finalPath + TMP_SUFFIX;

      // utf-8 is correct for ASCII printable + extended Windows characters
      // that Frontier accepts in CustomerName, BackPrint etc.
      await fsMod.promises.writeFile(tmpPath, surfaceFile.contents, 'utf-8');
      await fsMod.promises.rename(tmpPath, finalPath);

      writtenFiles.push(finalPath);
    }

    return { imageStagingFolder, copiedImages, writtenFiles };
  }

  // ───────────────────────────────────────────────────────────────────────
  // 1.16.1 dispatch-time reachability check for fujiImageRoot
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Verify the order's artwork folder resolves via the Fuji-view root
   * (`fujiImageRoot`). Runs AFTER images have been staged into
   * `imageStagingRoot/orderRef/`, BEFORE the `.txt` files land in the
   * hot folder.
   *
   * The check discriminates two states so a working cross-machine
   * config is never blocked by an OHD-side visibility gap:
   *
   *   1. Root RESOLVES from OHD but order subfolder is missing →
   *      HARD FAIL. This is a real configuration bug: fujiImageRoot
   *      points at a different folder than imageStagingRoot. Fuji
   *      will read the emitted `.txt`'s `ImagePath=` line and look
   *      for artwork that isn't there; the order would sit in the
   *      hot folder until Frontier's failure timeout without ever
   *      printing. Fail loudly at dispatch so the operator sees an
   *      immediate red job with an actionable message, not a silent
   *      30-minute stall.
   *
   *   2. Root does NOT resolve from OHD (any error — ENOENT,
   *      EACCES, ETIMEDOUT, network unreachable) → SOFT WARN,
   *      dispatch proceeds. OHD cannot tell "the operator's path
   *      is wrong" from "OHD's machine legitimately cannot see a
   *      share the Fuji machine reaches". Blocking here would kill
   *      a working configuration in the latter case — the 1.15.1
   *      mistake. Log a warning naming the path so a real bug still
   *      leaves a trail, then let Fuji be the authoritative check.
   *
   * The same-machine case (fujiImageRoot === imageStagingRoot) is
   * excluded by the caller — this method is only invoked when the
   * two roots differ.
   */
  async _verifyFujiReachability({ fujiImageRoot, imageStagingRoot, orderRef, fs, logger }) {
    const fujiOrderFolder = path.join(fujiImageRoot, orderRef);

    // (2) can OHD see the root at all?
    let rootResolvable = false;
    try {
      await fs.promises.stat(fujiImageRoot);
      rootResolvable = true;
    } catch (rootErr) {
      // OHD can't resolve fujiImageRoot from its side. That may be
      // a wrong path or a share OHD legitimately can't reach — we
      // cannot tell. Warn and let dispatch proceed; Fuji is the
      // authoritative check for the ImagePath value.
      (logger.logWarning || logger.warn || (() => {})).call(logger,
        `[fuji-jobmaker] fujiImageRoot not resolvable from OHD's side — dispatch proceeding without confirming the path. ` +
        `fujiImageRoot: ${fujiImageRoot}. Underlying error: ${rootErr && rootErr.code} ${rootErr && rootErr.message}. ` +
        `If the order does not print, check that fujiImageRoot on the controller points at the same folder as imageStagingRoot (${imageStagingRoot}) expressed as the Fuji JobMaker machine reaches it.`,
      );
      return;
    }

    // (1) root resolves. now the order subfolder MUST exist too.
    try {
      await fs.promises.stat(fujiOrderFolder);
      return;
    } catch (orderErr) {
      if (orderErr && orderErr.code === 'ENOENT') {
        // Root exists, subfolder missing — real configuration bug.
        throw new Error(
          `Fuji JobMaker dispatch stopped: the order's artwork folder is not visible via the configured fujiImageRoot. ` +
          `OHD wrote the images to ${path.join(imageStagingRoot, orderRef)}, but ${fujiOrderFolder} does not exist. ` +
          `This means fujiImageRoot on the controller does not point at the same folder as imageStagingRoot. ` +
          `Fix: check that fujiImageRoot resolves to the same physical folder as imageStagingRoot, expressed as the Fuji JobMaker machine reaches it. ` +
          `If both OHD and Fuji JobMaker run on the same machine, the two must be equal.`
        );
      }
      // Any other error (EACCES / ETIMEDOUT / EBUSY / …) — same
      // posture as an unreachable root: warn, let dispatch proceed.
      (logger.logWarning || logger.warn || (() => {})).call(logger,
        `[fuji-jobmaker] fujiImageRoot resolved but the order subfolder stat failed with a non-ENOENT error — dispatch proceeding. ` +
        `fujiOrderFolder: ${fujiOrderFolder}. Underlying error: ${orderErr && orderErr.code} ${orderErr && orderErr.message}.`,
      );
    }
  }

  /**
   * Normalise a path for comparison (same-volume same-folder detection
   * before running the reachability check). Strips trailing separators
   * and lowercases — the Fuji machine's Windows share is
   * case-insensitive, and forward vs back slash difference is preserved
   * by design (`_buildImagePath` in the generator does not convert).
   *
   * This is NOT full path equivalence — a mapped drive and its UNC
   * source will normalise differently and the check will still run.
   * That is the desired behaviour: the two roots are not literally
   * equal, so verifying the extra reachability layer is cheap
   * insurance.
   */
  _normalizeForCompare(p) {
    return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
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
  async _copyImages(imageFiles, destFolder, fsMod = fs) {
    const seen = new Set();
    const copied = [];

    for (const img of imageFiles) {
      if (seen.has(img.filename)) continue;
      seen.add(img.filename);

      const destPath = path.join(destFolder, img.filename);
      await fsMod.promises.copyFile(img.sourcePath, destPath);
      copied.push(destPath);
    }

    return copied;
  }
}

const fujiJobMakerFileWriter = new FujiJobMakerFileWriter();
module.exports = { fujiJobMakerFileWriter, FujiJobMakerFileWriter };
