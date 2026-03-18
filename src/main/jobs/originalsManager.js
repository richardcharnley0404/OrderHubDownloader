'use strict';

/**
 * src/main/jobs/originalsManager.js
 *
 * Manages the /originals/ backup folder for a job.
 *
 * Rules (from brief):
 *   - On the FIRST edit of any image in a job, ALL images from /working/ are
 *     copied into /originals/.  This folder is then the permanent, unmodified
 *     source of truth and is never written to again.
 *   - Reset (single image): copy /originals/{filename} → /working/{filename},
 *     then reset that image's sidecar entry to its original defaults.
 *   - Reset (full job):     copy ALL files from /originals/ → /working/,
 *     then reset every image entry in the sidecar.
 *
 * All file I/O uses fs/promises (no sync calls).
 *
 * Depends on: sidecarManager.js, src/shared/jobSchema.js
 */

const fs   = require('fs/promises');
const path = require('path');
const { resetImageEntry } = require('../../shared/jobSchema');
const { saveSidecar }     = require('./sidecarManager');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the absolute path to the /originals/ sub-folder for a job.
 *
 * @param {string} jobPath
 * @returns {string}
 */
function originalsDir(jobPath) {
  return path.join(jobPath, 'originals');
}

/**
 * Return the absolute path to the /working/ sub-folder for a job.
 *
 * @param {string} jobPath
 * @returns {string}
 */
function workingDir(jobPath) {
  return path.join(jobPath, 'working');
}

/**
 * Return true if /originals/ already exists for this job.
 *
 * @param {string} jobPath
 * @returns {Promise<boolean>}
 */
async function originalsExist(jobPath) {
  try {
    await fs.access(originalsDir(jobPath));
    return true;
  } catch {
    return false;
  }
}

/** File extensions treated as printable images (case-insensitive). */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * First-run setup for a job that was downloaded directly into its root folder.
 *
 * OHD's FTP polling places image files directly in the job root rather than
 * in a /working/ sub-folder.  On the first Review Panel open we need to
 * create the expected folder structure before loadSidecar runs.
 *
 * Behaviour:
 *   - If /working/ already exists → no-op (safe to call on every open).
 *   - If /working/ does not exist:
 *       1. Scan the job root for recognised image files.
 *       2. Create /working/ and /originals/.
 *       3. Copy every found image into BOTH sub-folders.
 *
 * After this call, loadSidecar will find images in /working/ and
 * ensureOriginals() becomes a no-op because /originals/ is already populated.
 *
 * @param {string} jobPath - Root folder of the job
 * @returns {Promise<void>}
 */
async function ensureWorkingSetup(jobPath) {
  // No-op if /working/ already exists.
  try {
    await fs.access(workingDir(jobPath));
    return;
  } catch {
    // /working/ does not exist — proceed with first-run setup.
  }

  // Scan the job root for image files.
  let entries;
  try {
    entries = await fs.readdir(jobPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return; // Job root doesn't exist — nothing to do.
    throw err;
  }

  const imageFiles = entries.filter(
    e => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase())
  );

  if (imageFiles.length === 0) return; // No images in root — nothing to set up.

  // Create /working/ and /originals/ in parallel.
  await Promise.all([
    fs.mkdir(workingDir(jobPath),    { recursive: true }),
    fs.mkdir(originalsDir(jobPath),  { recursive: true }),
  ]);

  // Copy each image into both sub-folders.
  await Promise.all(
    imageFiles.flatMap(e => [
      fs.copyFile(
        path.join(jobPath, e.name),
        path.join(workingDir(jobPath),   e.name),
      ),
      fs.copyFile(
        path.join(jobPath, e.name),
        path.join(originalsDir(jobPath), e.name),
      ),
    ])
  );
}

/**
 * Ensure /originals/ exists and is populated.
 *
 * Must be called before the first edit to any image in a job.  If /originals/
 * already exists the function is a no-op (safe to call multiple times).
 *
 * Steps:
 *   1. Check if /originals/ exists.
 *   2. If not: create the folder and copy every file from /working/ into it.
 *
 * @param {string} jobPath - Root folder of the job
 * @returns {Promise<void>}
 */
async function ensureOriginals(jobPath) {
  if (await originalsExist(jobPath)) return;

  const src  = workingDir(jobPath);
  const dest = originalsDir(jobPath);

  await fs.mkdir(dest, { recursive: true });

  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return; // /working/ doesn't exist yet — nothing to copy
    throw err;
  }

  // Copy all files (not sub-directories) from /working/ to /originals/.
  await Promise.all(
    entries
      .filter(e => e.isFile())
      .map(e => fs.copyFile(
        path.join(src,  e.name),
        path.join(dest, e.name),
      ))
  );
}

/**
 * Reset a single image:
 *   1. Copy /originals/{filename} → /working/{filename} (overwrites current).
 *   2. Reset that image's sidecar entry to original defaults.
 *   3. Persist the updated sidecar and return the new entry.
 *
 * Throws if /originals/{filename} does not exist (caller should call
 * ensureOriginals before any edit so this should always succeed).
 *
 * @param {string}   jobPath  - Root folder of the job
 * @param {object}   sidecar  - Current sidecar object
 * @param {string}   filename - Bare filename, e.g. "IMG_001.jpg"
 * @returns {Promise<{ sidecar: object, entry: object }>}
 */
async function resetImage(jobPath, sidecar, filename) {
  // Restore file from originals.
  await fs.copyFile(
    path.join(originalsDir(jobPath), filename),
    path.join(workingDir(jobPath),   filename),
  );

  // Reset the sidecar entry.
  const updatedImages = sidecar.images.map(img =>
    img.filename === filename ? resetImageEntry(img) : img
  );

  const updatedSidecar = await saveSidecar(
    { ...sidecar, images: updatedImages },
    jobPath,
  );

  const entry = updatedSidecar.images.find(img => img.filename === filename);
  return { sidecar: updatedSidecar, entry };
}

/**
 * Reset all images in a job:
 *   1. Copy EVERY file from /originals/ → /working/ (overwrites all).
 *   2. Reset every image entry in the sidecar to original defaults.
 *   3. Persist the updated sidecar and return it.
 *
 * @param {string} jobPath - Root folder of the job
 * @param {object} sidecar - Current sidecar object
 * @returns {Promise<object>} The fully-reset, persisted sidecar
 */
async function resetAllImages(jobPath, sidecar) {
  const src  = originalsDir(jobPath);
  const dest = workingDir(jobPath);

  // Copy all originals back to working.
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      // /originals/ doesn't exist — nothing to restore, just reset sidecar.
      entries = [];
    } else {
      throw err;
    }
  }

  await Promise.all(
    entries
      .filter(e => e.isFile())
      .map(e => fs.copyFile(
        path.join(src,  e.name),
        path.join(dest, e.name),
      ))
  );

  // Reset all sidecar entries.
  const resetImages   = sidecar.images.map(resetImageEntry);
  const updatedSidecar = await saveSidecar(
    { ...sidecar, images: resetImages },
    jobPath,
  );

  return updatedSidecar;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  ensureWorkingSetup,
  ensureOriginals,
  resetImage,
  resetAllImages,
  originalsDir,
  workingDir,
};
