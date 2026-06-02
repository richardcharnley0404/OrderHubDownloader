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
 *         sidecar's images array, add fresh entries for them.  Also back-fill
 *         `originalFilename` on any existing entry whose value is null when
 *         the manifest now supplies one (sidecars created before the
 *         Customer Originals feature shipped pick the field up on next
 *         load).  Re-save when anything changed.
 *      b. If not found (ENOENT): build a fresh sidecar from the scanned
 *         filenames and save it immediately.
 *   3. Return { sidecar, filenames } so callers get both in one call.
 *
 * Reconcile principle: operator-mutable fields are never re-applied from
 * the manifest (qtyCurrent may have been adjusted, corrections, reprint flag,
 * aiQuality, integritySuspect, etc).  `originalFilename` is the one field
 * that's safe to back-fill precisely because nothing else writes to it —
 * it's null on legacy entries and the manifest is the authoritative source.
 * Defence-in-depth: if a legacy entry already has a different
 * `originalFilename` from what the manifest now provides, leave it alone
 * (first-write wins — keeps the no-clobber contract clean).
 *
 * @param {string} jobId
 * @param {string} jobPath - Root folder of the job
 * @param {Map<string, number|{qty:number, originalFilename:(string|null)}>} [metaMap]
 *   Optional map keyed by bare working-filename:
 *     - legacy form: `Map<filename, qty>` — quantity only
 *     - new form:    `Map<filename, { qty, originalFilename }>` — quantity
 *                    plus the manifest-relative path to the uncropped
 *                    customer upload (null when not present in the manifest)
 *   When supplied, new image entries (both on first creation and during
 *   reconcile) use the mapped quantity instead of defaulting to 1, and
 *   originalFilename is populated from the meta.  Existing sidecar entries
 *   are never overwritten — operator changes are preserved.
 * @returns {Promise<{ sidecar: object, filenames: string[] }>}
 */
async function loadSidecar(jobId, jobPath, metaMap = null) {
  const filenames = await scanWorkingImages(jobPath);
  const jsonPath  = sidecarPath(jobId, jobPath);

  // Normalise the meta lookup so callers can pass either shape.  Returns
  // `{ qty, originalFilename }` with `qty=1, originalFilename=null` as the
  // fallback when nothing was supplied for this filename.
  const resolveMeta = (fn) => {
    if (!metaMap) return { qty: 1, originalFilename: null };
    const v = metaMap.get(fn);
    if (v == null) return { qty: 1, originalFilename: null };
    if (typeof v === 'number') return { qty: v, originalFilename: null };
    return {
      qty: Number.isFinite(v.qty) && v.qty > 0 ? v.qty : 1,
      originalFilename: (typeof v.originalFilename === 'string' && v.originalFilename) || null,
    };
  };

  let sidecar;

  try {
    const raw = await fs.readFile(jsonPath, 'utf8');
    sidecar = JSON.parse(raw);

    // Reconcile A: add entries for files that exist on disk but not in sidecar.
    // This handles images added to /working/ after the sidecar was first created.
    const known      = new Set(sidecar.images.map(img => img.filename));
    const newEntries = filenames
      .filter(fn => !known.has(fn))
      .map(fn => {
        const meta = resolveMeta(fn);
        return createImageEntry(fn, meta.qty, meta.originalFilename);
      });

    // Reconcile B: back-fill `originalFilename` on existing entries created
    // before the Customer Originals feature shipped.  Touch only this one
    // field, and only when the existing value is null — never clobber an
    // already-set value, even if it differs from what the manifest says.
    let backfilledAny = false;
    const reconciledExisting = sidecar.images.map(entry => {
      const desired = resolveMeta(entry.filename).originalFilename;
      if (!desired) return entry;
      // Tolerate sidecars that pre-date the schema bump and have no key.
      const current = Object.prototype.hasOwnProperty.call(entry, 'originalFilename')
        ? entry.originalFilename
        : null;
      if (current != null) return entry; // first-write wins, even if mismatched
      backfilledAny = true;
      return { ...entry, originalFilename: desired };
    });

    // Reconcile C: hydrate S3-artwork-channel fields on entries / job-level
    // that pre-date the M1 schema bump (2026-05-24). Missing fields are set
    // to null defaults (job-level array → []); already-populated values are
    // never touched. The defaults round-trip cleanly on subsequent loads.
    const S3_DEFAULTS = {
      artworkFileId:    null,
      artworkSource:    null,
      artworkType:      null,
      productionReady:  null,
      originalFileName: null,
      // M3 (2026-05-24): per-file copies multiplier. Same null-default
      // pattern as the M1 fields — hydration adds the key in-memory so
      // consumers can read `entry.copies` uniformly; never triggers a
      // save (preserved "no spurious save" contract).
      copies:           null,
    };
    let migratedS3Any = false;
    const s3MigratedExisting = reconciledExisting.map(entry => {
      let next = entry;
      for (const k of Object.keys(S3_DEFAULTS)) {
        if (!Object.prototype.hasOwnProperty.call(next, k)) {
          if (next === entry) next = { ...entry };
          next[k] = S3_DEFAULTS[k];
          migratedS3Any = true;
        }
      }
      return next;
    });
    let s3ArtworkFileIdsKnown = sidecar.s3ArtworkFileIdsKnown;
    let migratedS3Job = false;
    if (!Array.isArray(s3ArtworkFileIdsKnown)) {
      s3ArtworkFileIdsKnown = [];
      migratedS3Job = true;
    }

    // Reconcile D: hydrate M5b (Manual Cropping, 2026-05-25) batch-crop
    // metadata on entries / job-level that pre-date the schema bump.
    // Same null-default + no-spurious-save pattern as Reconcile C.
    //
    // Per-image flat siblings: cropOrientation, cropSource, cropAppliedAt,
    // cropRotation. Note these are siblings of the pre-existing
    // cropApplied / croppedPath / cropRect / channelMappingId — NOT
    // nested under a crop:{...} object (would force a migration that the
    // brief explicitly rejected). Casing trap warning: `cropOrientation`
    // lowercase; distinct from `croppedPath` (different concept).
    //
    // Manual Crop redesign (2026-06-01): three new per-image pending
    // fields hold the operator's in-progress (not-yet-approved) crop so
    // closing the drawer mid-job restores progress on reopen. Cleared by
    // `ohd:job:crop-image` on Approve. Hydrated null on legacy entries.
    //
    // Job-level: batchCropLastAppliedAt only — `batchCropDefaultRect`
    // and `batchCropDefaultOrientation` were removed in the redesign
    // (replaced by per-image pending state) and are dropped from any
    // legacy sidecar on load via Reconcile E below.
    const M5B_IMAGE_DEFAULTS = {
      cropOrientation:    null,
      cropSource:         null,
      cropAppliedAt:      null,
      cropRotation:       null,
      pendingCropRect:    null,
      pendingRotation:    null,
      pendingOrientation: null,
    };
    let migratedM5bAny = false;
    const m5bMigratedExisting = s3MigratedExisting.map((entry) => {
      let next = entry;
      for (const k of Object.keys(M5B_IMAGE_DEFAULTS)) {
        if (!Object.prototype.hasOwnProperty.call(next, k)) {
          if (next === entry) next = { ...entry };
          next[k] = M5B_IMAGE_DEFAULTS[k];
          migratedM5bAny = true;
        }
      }
      return next;
    });
    const M5B_JOB_DEFAULTS = {
      batchCropLastAppliedAt: null,
    };
    let migratedM5bJob = false;
    const m5bJobFields = {};
    for (const k of Object.keys(M5B_JOB_DEFAULTS)) {
      if (!Object.prototype.hasOwnProperty.call(sidecar, k)) {
        m5bJobFields[k] = M5B_JOB_DEFAULTS[k];
        migratedM5bJob = true;
      }
    }

    // Reconcile F: hydrate Manual Crop redesign (2026-06-02) `discarded`
    // field on legacy entries that pre-date the schema bump. Same null-
    // default + no-spurious-save pattern as Reconcile C/D. Default `false`
    // (not null) because `discarded` is a boolean by contract, and the
    // renderer reads it with strict === true semantics.
    const M6_IMAGE_DEFAULTS = { discarded: false };
    let migratedM6Any = false;
    const m6MigratedExisting = m5bMigratedExisting.map((entry) => {
      let next = entry;
      for (const k of Object.keys(M6_IMAGE_DEFAULTS)) {
        if (!Object.prototype.hasOwnProperty.call(next, k)) {
          if (next === entry) next = { ...entry };
          next[k] = M6_IMAGE_DEFAULTS[k];
          migratedM6Any = true;
        }
      }
      return next;
    });

    // Reconcile E: Manual Crop redesign (2026-06-01) — drop legacy job-level
    // batch-crop defaults. The old shape was a fractional {centerX, centerY,
    // scale} for one shared rect; the new model has per-image pendingCropRect
    // (image-space pixels), so the shared rect is meaningless. We don't try
    // to convert — the old shape required imageAspect to project per-image,
    // and M5b was only a week in production. Operators redo any in-flight
    // crops. Unlike hydrate, this DOES trigger a save so disk is cleaned up
    // immediately rather than carrying orphaned data until the next
    // unrelated save.
    let droppedLegacyM5bDefaults = false;
    let legacyM5bShape = null;
    if (Object.prototype.hasOwnProperty.call(sidecar, 'batchCropDefaultRect')
        || Object.prototype.hasOwnProperty.call(sidecar, 'batchCropDefaultOrientation')) {
      legacyM5bShape = {
        hadRect:        Object.prototype.hasOwnProperty.call(sidecar, 'batchCropDefaultRect'),
        hadOrientation: Object.prototype.hasOwnProperty.call(sidecar, 'batchCropDefaultOrientation'),
      };
      droppedLegacyM5bDefaults = true;
    }

    // In-memory hydration is ALWAYS applied so consumers of loadSidecar see
    // the hydrated shape (S3 fields present, job-level array present, M5b
    // fields present). Persistence, by contrast, is gated on the original
    // reconcile triggers (new files on disk / originalFilename back-fill) —
    // NOT on the S3 / M5b hydration alone, otherwise every load of a
    // legacy sidecar would write unnecessarily (regression caught by
    // sidecarManager.test.js "no spurious save"). Disk catches up on the
    // next meaningful save, e.g. when the S3 downloader appends an entry
    // or batch crop persists per-image.
    //
    // EXCEPTION: Reconcile E (legacy batch-crop default drop) DOES force a
    // save. The legacy fields are dead data; leaving them on disk means
    // they survive indefinitely until some other write happens, which on
    // a stable job may be never. Save now and be done with it.
    const assembled = {
      ...sidecar,
      ...m5bJobFields,
      images: [...m6MigratedExisting, ...newEntries],
      s3ArtworkFileIdsKnown,
    };
    if (droppedLegacyM5bDefaults) {
      delete assembled.batchCropDefaultRect;
      delete assembled.batchCropDefaultOrientation;
      // eslint-disable-next-line no-console
      console.warn('[sidecar] dropped legacy M5b batch-crop default fields', {
        jobId:          assembled.jobId,
        hadRect:        legacyM5bShape && legacyM5bShape.hadRect,
        hadOrientation: legacyM5bShape && legacyM5bShape.hadOrientation,
      });
    }
    sidecar = assembled;
    if (newEntries.length > 0 || backfilledAny || droppedLegacyM5bDefaults) {
      sidecar = await saveSidecar(sidecar, jobPath);
    }
    // Hydration flags intentionally not in the save condition.
    void migratedS3Any; void migratedS3Job;
    void migratedM5bAny; void migratedM5bJob;
    void migratedM6Any;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;

    // No sidecar on disk yet — build a fresh one from scanned images,
    // using manifest quantities + originalFilename where available.
    const images = filenames.map(fn => {
      const meta = resolveMeta(fn);
      return createImageEntry(fn, meta.qty, meta.originalFilename);
    });
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
