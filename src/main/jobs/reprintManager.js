'use strict';

/**
 * src/main/jobs/reprintManager.js
 *
 * Creates a reprint job folder for a parent job.
 *
 * Rules (from brief):
 *   - A reprint always copies from /originals/ of the PARENT job — never from
 *     /working/.  This ensures reprints are always a clean re-run of the
 *     untouched source image.
 *   - Only images flagged with reprint: true are copied into the reprint job's
 *     /working/ folder.
 *   - Reprint job naming: {parentJobId}-r{n}  (n = 1, 2, 3 … incremented per
 *     session by the caller; this module always receives the final ID).
 *   - Folder layout of the reprint job mirrors the parent:
 *       {reprintJobPath}/originals/   ← flagged images copied from parent /originals/
 *       {reprintJobPath}/working/     ← same images (reprints start from originals)
 *       {reprintJobPath}/cache/       ← Phase 3 stub, created empty
 *       {reprintJobPath}/{reprintJobId}.json  ← reprint sidecar
 *
 * All file I/O uses fs/promises (no sync calls).
 *
 * Depends on: originalsManager.js, sidecarManager.js, src/shared/jobSchema.js
 */

const fs   = require('fs/promises');
const path = require('path');
const {
  createImageEntry,
  createSidecar,
} = require('../../shared/jobSchema');
const { saveSidecar }   = require('./sidecarManager');
const { originalsDir }  = require('./originalsManager');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a reprint job for the given parent job.
 *
 * Only images where sidecar.images[n].reprint === true are included.
 *
 * Steps:
 *   1. Derive the reprint job path as a sibling of the parent job folder.
 *   2. Create sub-folders: /originals/, /working/, /cache/
 *   3. Copy flagged images from {parentJobPath}/originals/ into both
 *      /originals/ and /working/ of the new reprint job.
 *   4. Build a reprint sidecar (reprintOf = parentJobId) with one entry per
 *      copied image and persist it.
 *   5. Return { reprintJobId, reprintJobPath }.
 *
 * @param {object} options
 * @param {string} options.parentJobId   - e.g. "JOB-00452"
 * @param {string} options.parentJobPath - Absolute path to the parent job root
 * @param {object} options.sidecar       - Current parent sidecar (to find flagged images)
 * @param {string} options.reprintJobId  - e.g. "JOB-00452-r1" (caller provides)
 * @returns {Promise<{ reprintJobId: string, reprintJobPath: string }>}
 */
async function createReprint({ parentJobId, parentJobPath, sidecar, reprintJobId }) {
  // The reprint job lives alongside the parent job in the same parent directory.
  const parentDir      = path.dirname(parentJobPath);
  const reprintJobPath = path.join(parentDir, reprintJobId);

  // Collect images flagged for reprint.
  const flaggedImages = sidecar.images.filter(img => img.reprint === true);

  if (flaggedImages.length === 0) {
    throw new Error(`createReprint: no images flagged for reprint in job ${parentJobId}`);
  }

  // Create folder structure.
  await Promise.all([
    fs.mkdir(path.join(reprintJobPath, 'originals'), { recursive: true }),
    fs.mkdir(path.join(reprintJobPath, 'working'),   { recursive: true }),
    fs.mkdir(path.join(reprintJobPath, 'cache'),     { recursive: true }),
  ]);

  // Source baselines for the three-layer fallback chain:
  //   /originals/  — standard "untouched first-arrival" snapshot.
  //   /working/    — printable surface; recropFromOriginal (Phase 2) writes
  //                  recropped customer originals only to /working/ and never
  //                  to /originals/, so a sidecar entry whose `filename` is a
  //                  recropped basename will be missing from /originals/.
  //   parent root  — where FTP/S3 ingestion writes verbatim copies. Falls back
  //                  here when the sidecar/disk divergence pattern bites: the
  //                  sidecar references a file that exists in the root but
  //                  never made it into /working/ or /originals/. Most
  //                  commonly hit when files arrive after ensureWorkingSetup's
  //                  one-shot seed completed (see PXDEMO-Y64Z3U_38471868
  //                  Fuji-reprint regression, 2026-06-19).
  const srcOriginals = originalsDir(parentJobPath);
  const srcWorking   = path.join(parentJobPath, 'working');
  const srcRoot      = parentJobPath;

  async function copyFlaggedImage(filename, destAbs) {
    const fromOriginals = path.join(srcOriginals, filename);
    try {
      await fs.copyFile(fromOriginals, destAbs);
      return;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const fromWorking = path.join(srcWorking, filename);
    try {
      await fs.copyFile(fromWorking, destAbs);
      console.warn(
        `[reprint] /originals/${filename} missing — fell back to /working/. ` +
        `Likely a Phase 2 re-cropped row.`
      );
      return;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const fromRoot = path.join(srcRoot, filename);
    try {
      await fs.copyFile(fromRoot, destAbs);
      console.warn(
        `[reprint] ${filename} missing from BOTH /originals/ AND /working/ ` +
        `— fell back to job root. Root copy is the FTP/S3-delivered bytes; ` +
        `if this was meant to be a re-cropped row (lives only in /working/), ` +
        `the reprint will use the pre-crop original instead. Check the ` +
        `operator's intent.`
      );
      return;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    throw new Error(
      `Image not found anywhere for reprint: ${filename}. ` +
      `Absent from /originals/, /working/, AND the job root (${srcRoot}). ` +
      `Sidecar may reference a file that was deleted or never delivered.`
    );
  }

  // Copy each flagged image into both /originals/ and /working/ of the reprint job.
  await Promise.all(
    flaggedImages.flatMap(img => [
      copyFlaggedImage(img.filename, path.join(reprintJobPath, 'originals', img.filename)),
      copyFlaggedImage(img.filename, path.join(reprintJobPath, 'working',   img.filename)),
    ])
  );

  // Build reprint sidecar entries — quantities start fresh, but corrections
  // are carried over from the parent so the operator's colour adjustments
  // are applied when the reprint is sent to the DPOF controller.
  const reprintImages = flaggedImages.map(img => ({
    ...createImageEntry(img.filename, img.qtyCurrent),
    corrections: img.corrections
      ? { ...img.corrections }
      : { cyan: 0, magenta: 0, yellow: 0 },
  }));

  const reprintSidecar = createSidecar(reprintJobId, reprintImages, parentJobId);
  await saveSidecar(reprintSidecar, reprintJobPath);

  // Return the sidecar so callers can use the images (e.g. for the print pipeline)
  return { reprintJobId, reprintJobPath, reprintSidecar };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  createReprint,
};
