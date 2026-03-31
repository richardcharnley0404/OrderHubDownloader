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

// ─── HELPER ───────────────────────────────────────────────────────────────
async function copyFileWithRetry(src, dest, attempts = 3, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.copyFile(src, dest);
      return;
    } catch (err) {
      const isLast = i === attempts - 1;
      const isTransient = ['ECANCELED', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code);
      if (isLast || !isTransient) {
        err.message = `Failed to copy ${path.basename(src)} after ${i + 1} attempt(s): ${err.message}`;
        throw err;
      }
      console.warn(`[originalsManager] copyFile attempt ${i + 1} failed (${err.code}), retrying in ${delayMs * (i + 1)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
}

// ─── UPDATED ensureWorkingSetup ───────────────────────────────────────────
async function ensureWorkingSetup(jobPath) {
  const workingDir   = path.join(jobPath, 'working');
  const originalsDir = path.join(jobPath, 'originals');

  console.log('[ensureWorkingSetup] called with:', jobPath);
  console.log('[ensureWorkingSetup] workingDir:', workingDir);

  // Check if working/ already contains at least one image — if so, already initialised
  try {
    const existing  = await fs.readdir(workingDir);
    console.log('[ensureWorkingSetup] working/ contents:', existing);
    const hasImages = existing.some(f => /\.(jpg|jpeg|png|tif|tiff)$/i.test(f));
    if (hasImages) return; // already healthy, nothing to do
  } catch {
    // working/ doesn't exist — fall through to create it
  }

  // Create working/ and originals/ if needed (safe if already exists)
  await fs.mkdir(workingDir,   { recursive: true });
  await fs.mkdir(originalsDir, { recursive: true });

  // Find all images in the job root
  const jobRootFiles = await fs.readdir(jobPath);
  console.log('[ensureWorkingSetup] job root contents:', jobRootFiles);
  const imageFiles   = jobRootFiles.filter(f => /\.(jpg|jpeg|png|tif|tiff)$/i.test(f));
  console.log('[ensureWorkingSetup] imageFiles found:', imageFiles);

  if (imageFiles.length === 0) {
    console.warn(`[originalsManager] No images found in job root: ${jobPath}`);
    return;
  }

  // Copy each image into both working/ and originals/ with retry
  const errors = [];
  for (const filename of imageFiles) {
    const src = path.join(jobPath, filename);
    try {
      await copyFileWithRetry(src, path.join(workingDir,   filename));
      await copyFileWithRetry(src, path.join(originalsDir, filename));
    } catch (err) {
      console.error(`[originalsManager] ${err.message}`);
      errors.push(filename);
    }
  }

  if (errors.length > 0) {
    // Partial failure — log clearly but don't throw, so Job Review can
    // still open with whatever images did copy successfully
    console.error(`[originalsManager] ${errors.length} image(s) failed to copy: ${errors.join(', ')}`);
  } else {
    console.log(`[originalsManager] Initialised working/ and originals/ for ${path.basename(jobPath)} (${imageFiles.length} image(s))`);
  }
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
