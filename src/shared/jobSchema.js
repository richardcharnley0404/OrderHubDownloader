/**
 * src/shared/jobSchema.js
 *
 * Single source of truth for the OHD job sidecar JSON structure.
 *
 * Imported by:
 *   - Main process: sidecarManager.js (read/write), reprintManager.js
 *   - Renderer:     useJobReview.js (state initialisation)
 *
 * Rules enforced here:
 *   - qtyOriginal is set once at creation and must never be mutated
 *   - corrections are integers clamped to CORRECTION_RANGE
 *   - enhancement fields (enhanced, enhancementSource, enhancedPath,
 *     enhancedAt, enhancementModel) are written by enhancementManager.js
 *     and intentionally preserved on reset — a reset restores the source
 *     image and corrections, but does not remove an existing enhancement
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const CORRECTION_RANGE = Object.freeze({ min: -20, max: 20 });

// ── Factories ─────────────────────────────────────────────────────────────────

/**
 * Create a single image entry for the sidecar images array.
 *
 * @param {string} filename   - Bare filename, e.g. "IMG_001.jpg"
 * @param {number} qty        - Initial quantity (becomes both qtyOriginal and qtyCurrent)
 * @returns {ImageEntry}
 */
function createImageEntry(filename, qty = 1) {
  if (!filename || typeof filename !== 'string') {
    throw new Error('createImageEntry: filename must be a non-empty string');
  }
  const quantity = Math.max(0, Math.round(qty));

  return {
    filename,
    qtyOriginal: quantity,   // set once — never overwritten after creation
    qtyCurrent:  quantity,
    corrections: {
      cyan:    0,
      magenta: 0,
      yellow:  0,
    },
    reprint:           false,
    reprintJobId:      null,

    // AI Enhancement (Phase 3) — written by enhancementManager.js after a
    // successful Replicate upscale.  All null/false until enhanced.
    enhanced:          false,
    enhancementSource: null,   // e.g. 'Replicate/Topaz'
    enhancedPath:      null,   // absolute path to /cache/{baseName}_enhanced.jpg
    enhancedAt:        null,   // ISO 8601 timestamp of enhancement
    enhancementModel:  null,   // e.g. 'Standard V2'
  };
}

/**
 * Create a fresh top-level sidecar object for a job.
 *
 * @param {string}       jobId      - Job identifier, e.g. "JOB-00452"
 * @param {ImageEntry[]} [images]   - Pre-built image entries (defaults to empty array)
 * @param {string|null}  [reprintOf]- Parent jobId if this is a reprint job; null otherwise
 * @returns {Sidecar}
 */
function createSidecar(jobId, images = [], reprintOf = null) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('createSidecar: jobId must be a non-empty string');
  }

  const now = new Date().toISOString();

  return {
    jobId,
    schemaVersion: SCHEMA_VERSION,
    createdAt:     now,
    modifiedAt:    now,
    reprintOf:     reprintOf || null,
    images:        images,
  };
}

/**
 * Return a copy of a sidecar with modifiedAt stamped to now.
 * Use this before every save — do not mutate the original.
 *
 * @param {Sidecar} sidecar
 * @returns {Sidecar}
 */
function touchSidecar(sidecar) {
  return { ...sidecar, modifiedAt: new Date().toISOString() };
}

/**
 * Return a fresh (reset) copy of an ImageEntry with corrections and qty
 * restored to their original values. Does not mutate the input.
 *
 * @param {ImageEntry} entry
 * @returns {ImageEntry}
 */
function resetImageEntry(entry) {
  return {
    ...entry,
    qtyCurrent: entry.qtyOriginal,
    corrections: { cyan: 0, magenta: 0, yellow: 0 },
    reprint:          false,
    reprintJobId:     null,
    // All five enhancement fields (enhanced, enhancementSource, enhancedPath,
    // enhancedAt, enhancementModel) are intentionally preserved on reset.
    // Resetting an image restores the working file and clears corrections, but
    // the enhanced version in /cache/ is still valid and should not be discarded.
  };
}

/**
 * Clamp a correction value to the allowed range.
 *
 * @param {number} value
 * @returns {number}
 */
function clampCorrection(value) {
  return Math.max(CORRECTION_RANGE.min, Math.min(CORRECTION_RANGE.max, Math.round(value)));
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  SCHEMA_VERSION,
  CORRECTION_RANGE,
  createImageEntry,
  createSidecar,
  touchSidecar,
  resetImageEntry,
  clampCorrection,
};
