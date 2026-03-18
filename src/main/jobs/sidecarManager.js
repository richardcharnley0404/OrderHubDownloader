'use strict';

/**
 * src/main/jobs/sidecarManager.js
 *
 * Read and write the JSON sidecar file for a job.
 *
 * Responsibilities:
 *   - Load an existing sidecar from disk, or create + persist a fresh one
 *     by scanning /working/ for images.
 *   - Reconcile on load: any image files present on disk but absent from the
 *     sidecar get a new entry added (handles files added after initial creation).
 *   - Save (persist) a sidecar, always stamping modifiedAt via touchSidecar.
 *
 * File system contract:
 *   - Sidecar lives at  {jobPath}/{jobId}.json
 *   - Images live in    {jobPath}/working/
 *   - All I/O uses      fs/promises (async, no sync calls)
 *
 * Depends on: src/shared/jobSchema.js
 */

const fs   = require('fs/promises');
const path = require('path');
const {
  createImageEntry,
  createSidecar,
  touchSidecar,
} = require('../../shared/jobSchema');

// ── Constants ─────────────────────────────────────────────────────────────────

/** File extensions treated as printable images (case-insensitive). */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the absolute path to the sidecar JSON file for a job.
 *
 * @param {string} jobId
 * @param {string} jobPath - Root folder of the job
 * @returns {string}
 */
function sidecarPath(jobId, jobPath) {
  return path.join(jobPath, `${jobId}.json`);
}

/**
 * Scan the /working/ sub-folder of a job and return an alphabetically sorted
 * array of bare filenames for all recognised image files.
 *
 * Returns an empty array if /working/ does not exist (ENOENT), so callers
 * don't need special-case handling for brand-new job folders.
 *
 * @param {string} jobPath - Root folder of the job
 * @returns {Promise<string[]>}
 */
async function scanWorkingImages(jobPath) {
  const workingDir = path.join(jobPath, 'working');

  let entries;
  try {
    entries = await fs.readdir(workingDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  return entries
    .filter(e => e.isFile()
      && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase())
      && !e.name.endsWith('_corrected.jpg'))
    .map(e => e.name)
    .sort();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load (or create) the sidecar for a job.
 *
 * Behaviour:
 *   1. Scan /working/ to discover what image files actually exist on disk.
 *   2. Try to read {jobPath}/{jobId}.json.
 *      a. If found: parse it.  If any on-disk filenames are missing from the
 *         sidecar's images array, add fresh entries for them and re-save.
 *      b. If not found (ENOENT): build a fresh sidecar from the scanned
 *         filenames and save it immediately.
 *   3. Return { sidecar, filenames } so callers get both in one call.
 *
 * @param {string}           jobId
 * @param {string}           jobPath      - Root folder of the job
 * @param {Map<string,number>} [quantityMap] - Optional map of bare filename →
 *   authoritative quantity from the order manifest.  When supplied, new image
 *   entries (both on first creation and during reconcile) use the mapped
 *   quantity instead of defaulting to 1.  Existing sidecar entries are never
 *   overwritten — operator changes are preserved.
 * @returns {Promise<{ sidecar: object, filenames: string[] }>}
 */
async function loadSidecar(jobId, jobPath, quantityMap = null) {
  const filenames = await scanWorkingImages(jobPath);
  const jsonPath  = sidecarPath(jobId, jobPath);

  // Resolve quantity for a filename: use the map if provided, otherwise 1.
  const resolveQty = (fn) => (quantityMap && quantityMap.get(fn)) || 1;

  let sidecar;

  try {
    const raw = await fs.readFile(jsonPath, 'utf8');
    sidecar = JSON.parse(raw);

    // Reconcile: add entries for files that exist on disk but not in sidecar.
    // This handles images added to /working/ after the sidecar was first created.
    const known      = new Set(sidecar.images.map(img => img.filename));
    const newEntries = filenames
      .filter(fn => !known.has(fn))
      .map(fn => createImageEntry(fn, resolveQty(fn)));

    if (newEntries.length > 0) {
      sidecar = { ...sidecar, images: [...sidecar.images, ...newEntries] };
      sidecar = await saveSidecar(sidecar, jobPath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;

    // No sidecar on disk yet — build a fresh one from scanned images,
    // using manifest quantities where available.
    const images = filenames.map(fn => createImageEntry(fn, resolveQty(fn)));
    sidecar = createSidecar(jobId, images);
    sidecar = await saveSidecar(sidecar, jobPath);
  }

  return { sidecar, filenames };
}

/**
 * Persist a sidecar to disk.
 *
 * Always stamps modifiedAt to the current time via touchSidecar before
 * writing.  Returns the persisted copy (with the updated timestamp) so
 * callers can keep their in-memory reference consistent.
 *
 * @param {object} sidecar - Sidecar object conforming to jobSchema
 * @param {string} jobPath - Root folder of the job
 * @returns {Promise<object>} The persisted sidecar (with fresh modifiedAt)
 */
async function saveSidecar(sidecar, jobPath) {
  const touched  = touchSidecar(sidecar);
  const jsonPath = sidecarPath(sidecar.jobId, jobPath);
  await fs.writeFile(jsonPath, JSON.stringify(touched, null, 2), 'utf8');
  return touched;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  loadSidecar,
  saveSidecar,
  scanWorkingImages,
  sidecarPath,
};
