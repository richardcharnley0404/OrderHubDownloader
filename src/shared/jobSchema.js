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
 *
 * Optional enhancement fields (Phase 1 local-enhancement plan, M2+):
 *   The enhancement block is extended at write time with extra fields when
 *   the enhancement runs. Older sidecars never had them; consumers must
 *   tolerate field absence. createImageEntry() does NOT pre-populate these
 *   so that legacy sidecars stay byte-equivalent on round-trip.
 *
 *     provider              'local' | 'topaz' | (legacy 'replicate')
 *     modelVersion          model file stem, e.g. 'realesr-general-x4v3'
 *     scoreBefore           MUSIQ score of the working file pre-enhance, 0-100
 *     scoreAfter            MUSIQ score of the cache file post-enhance, 0-100
 *     scoreModel            MUSIQ model version that produced the scores
 *     enhancementTriggeredBy 'operator' | 'quality-gate'
 *
 *   Local-provider only (Real-ESRGAN tile-and-stitch):
 *     inferenceMs           wall-clock for the tile loop, ms
 *     tileCount             total tiles processed
 *     tileSize              tile edge in source pixels (default 256)
 *     tileOverlap           feather overlap in source pixels (default 16)
 *     executionProvider     'cpu' (DirectML deferred to Phase 1.1)
 *     sourceWidth           source pixel dims
 *     sourceHeight
 *     outputWidth           4× source dims (after upscale)
 *     outputHeight
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
    // successful enhancement run. All null/false until enhanced. The
    // additional optional fields (provider, scoreBefore/After, tileCount,
    // executionProvider, etc — see header comment) are added flat at
    // write time, not pre-allocated here, so legacy sidecars round-trip
    // unchanged.
    enhanced:          false,
    enhancementSource: null,   // 'local' | 'topaz-direct' | (legacy 'Replicate/Topaz')
    enhancedPath:      null,   // absolute path to /cache/{baseName}_enhanced.jpg
    enhancedAt:        null,   // ISO 8601 timestamp of enhancement
    enhancementModel:  null,   // e.g. 'realesr-general-x4v3' (local) or 'Standard V2' (topaz)

    // Integrity-suspect flag (v1.3.2 pivot) — written by ftp-service.js when
    // a downloaded file fails the magic-byte check. The file keeps its
    // original extension and flows through the print pipeline normally; this
    // field is the forensic record of why the operator might want to give it
    // a closer look. `null` means the file passed the check (or was never
    // checked — non-image extensions bypass entirely).
    //
    // Shape when set:
    //   {
    //     detected:      true,
    //     detectedAt:    ISO 8601 timestamp,
    //     firstBytesHex: hex of leading bytes seen, or null on read-error,
    //     expectedMagic: human-readable description of what was expected,
    //     ftpRemotePath: source path for upstream investigation,
    //   }
    integritySuspect: null,

    // AI Quality Gate (v1.2.0) — written by ai-job-quality-orchestrator.js
    // after each scoring pass. `scored: false` means scoring hasn't been
    // attempted yet (or was skipped because the feature flag is OFF).
    aiQuality: {
      scored:               false,
      score:                null,    // 0–100 (MUSIQ); null until scored
      thresholdAtScoreTime: null,    // threshold in effect when scored
      passed:               true,    // true if score >= threshold OR not scored
      modelVersion:         null,    // e.g. 'musiq-spaq-v1.0.0'
      inferenceMs:          null,
      scoredAt:             null,    // ISO 8601 timestamp
      error:                null,    // graceful-failure message; null on success
      // Fixup history populated in M4. Empty array on Phase 1 / no-fixups runs.
      fixupHistory:         [],
      // Operator decision populated when operator overrides the gate.
      operatorDecision:     {
        kind:      'none',  // 'none' | 'fixed' | 'approved_as_is' | 'reverted'
        decidedAt: null,
        note:      null,
      },
    },
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
