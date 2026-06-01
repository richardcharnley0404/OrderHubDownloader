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
 *
 * Customer-originals fields (Customer Originals Phase 1, schema-bumped here
 * with the Phase 2 fields so we only mutate the shape once):
 *
 *     originalFilename      Manifest-relative path to the uncropped customer
 *                           upload, e.g. "PXDEMO-XYZ_123/original-files/1-IMG.jpg".
 *                           null when the order didn't ship an original (non-
 *                           Pixfizz, or just missing from the manifest). Stored
 *                           verbatim from the manifest — do not bake the
 *                           "original-files" folder name into OHD code paths.
 *     recropPath            Phase 2: absolute path to a re-cropped JPEG written
 *                           by the operator from the customer original. null
 *                           until first re-crop. Not surfaced in UI yet.
 *     recropOf              Phase 2: bare basename of the customer original
 *                           used as the source for the re-crop.
 *     recroppedAt           Phase 2: ISO 8601 timestamp of the re-crop.
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const CORRECTION_RANGE = Object.freeze({ min: -20, max: 20 });

// ── Factories ─────────────────────────────────────────────────────────────────

/**
 * Create a single image entry for the sidecar images array.
 *
 * @param {string}      filename            - Bare filename, e.g. "IMG_001.jpg"
 * @param {number}      [qty=1]             - Initial quantity (becomes both qtyOriginal and qtyCurrent)
 * @param {string|null} [originalFilename]  - Manifest-relative path to the
 *   uncropped customer upload, or null when the order didn't ship one.
 *   Stored verbatim from the manifest (e.g. "PXDEMO-XYZ_123/original-files/1-IMG.jpg")
 *   so OHD stays agnostic to where Pixfizz Core puts the files.
 * @param {object|null} [s3Fields]          - S3 artwork channel metadata
 *   (M1, 2026-05-24; +copies in M3). All six fields default to null when
 *   omitted, so FTP-delivered entries round-trip unchanged. Renderer uses
 *   `null` to distinguish "legacy FTP file" from "S3 file with explicit
 *   metadata".
 *   Shape:
 *     {
 *       artworkFileId:    string,        // UUID from /pending-jobs artwork_files[].id
 *       artworkSource:    'pixfizz'|'manual',
 *       artworkType:      'optimized'|'manipulated'|'original' (or any string
 *                                        // the API ships — values like 'pages' /
 *                                        // 'text' also appear; persisted verbatim,
 *                                        // unknowns are NOT filtered)
 *       productionReady:  boolean,
 *       originalFileName: string,        // API's file_name verbatim; distinct from
 *                                        // `originalFilename` (lowercase n) above
 *       copies:           number,        // M3: API's `copies` (default 1 when
 *                                        // absent). Drives qtyOriginal math
 *                                        // (job.quantity × file.copies) at
 *                                        // entry creation; persisted so the
 *                                        // renderer can show a "×N copies"
 *                                        // chip on the file row.
 *     }
 * @returns {ImageEntry}
 */
function createImageEntry(filename, qty = 1, originalFilename = null, s3Fields = null) {
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

    // Customer Originals (Phase 1 — schema-only here).
    //
    // `originalFilename` is the manifest-relative path to the uncropped
    // customer upload. Stored verbatim from the manifest so OHD doesn't
    // bake the Pixfizz "original-files/" folder name into its code. null
    // when the order didn't ship one (non-Pixfizz, pre-feature orders,
    // or simply missing from the manifest); UI treats any falsy value
    // as "no original available" and degrades silently.
    //
    // The three `recrop*` fields land here as null defaults so Phase 2
    // can write into them without a second schema bump — see the header
    // comment for the Phase 2 lifecycle.
    originalFilename: originalFilename || null,
    recropPath:       null,
    recropOf:         null,
    recroppedAt:      null,

    // S3 artwork channel (M1, 2026-05-24).
    //
    // Five fields populated only when the entry came from the new S3
    // download path; null for FTP-delivered entries. Renderer uses null
    // to distinguish "legacy FTP file" from "S3 file with explicit metadata".
    //
    // NOTE the casing: `originalFileName` (capital F-N) is the API's
    // `file_name` for the S3 file, preserved so the renderer can show the
    // original upload name when our on-disk name was collision-renamed
    // (e.g. "IMG_0123.jpg" while disk has "IMG_0123__a1b2c3d4.jpg").
    // DISTINCT from `originalFilename` (lowercase n) above, which is the
    // manifest-relative path to the customer's pre-crop upload for the
    // Customer Originals subsystem. Unrelated concepts.
    artworkFileId:    (s3Fields && s3Fields.artworkFileId)    || null,
    artworkSource:    (s3Fields && s3Fields.artworkSource)    || null,
    artworkType:      (s3Fields && s3Fields.artworkType)      || null,
    productionReady:  s3Fields && typeof s3Fields.productionReady === 'boolean'
                        ? s3Fields.productionReady
                        : null,
    originalFileName: (s3Fields && s3Fields.originalFileName) || null,
    // M3 (2026-05-24): per-file copies multiplier. Null for FTP-delivered
    // entries and any pre-M3 sidecar that didn't ship the field — distinct
    // from `1` (explicit single copy) so the renderer "×N copies" chip
    // suppresses for both legacy entries and the common copies=1 case.
    copies:           s3Fields && Number.isFinite(s3Fields.copies) && s3Fields.copies > 0
                        ? s3Fields.copies
                        : null,

    // M5b (Manual Cropping, 2026-05-25): batch-crop metadata. Flat
    // sibling fields — NOT nested under crop:{...} — so the existing
    // M5a fields (cropApplied / croppedPath / cropRect / channelMappingId)
    // and the new ones live alongside each other and no on-disk sidecar
    // migration is needed. See OHD_ManualCropping_ClaudeCode_Brief.md
    // §"Brief vs. as-built" under M5a for the casing trap (NB:
    // cropOrientation lowercase) and rationale.
    //
    //   cropOrientation  'portrait' | 'landscape' (null on legacy / pre-M5b entries)
    //   cropSource       'batch' | 'per-image' — which UX produced the crop
    //   cropAppliedAt    ISO 8601 timestamp of the crop apply
    //   cropRotation     0|90|180|270 — M5c will bake into the file; null here
    cropOrientation:  null,
    cropSource:       null,
    cropAppliedAt:    null,
    cropRotation:     null,

    // Manual Crop redesign (2026-06-01): per-image pending in-progress state.
    // Holds the operator's not-yet-approved crop while they walk through the
    // thumbnail rail, persisted to sidecar so closing the drawer mid-job
    // restores progress on reopen. Cleared on successful Approve — replaced
    // by the canonical applied cropRect / cropRotation / cropOrientation
    // fields on the same entry.
    //
    //   pendingCropRect    { x, y, w, h } image-space pixels, same coord
    //                      system as the applied cropRect
    //   pendingRotation    0|90|180|270
    //   pendingOrientation 'portrait' | 'landscape' | null
    pendingCropRect:    null,
    pendingRotation:    null,
    pendingOrientation: null,
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

    // S3 artwork channel — job-level set of artwork_files[].id values that
    // OHD has already materialised on disk (M1, 2026-05-24). The downloader
    // diffs against this on each poll to decide which files are new. Empty
    // for FTP-only jobs and for fresh sidecars; sidecarManager hydrates the
    // field on legacy sidecars that pre-date the schema bump.
    s3ArtworkFileIdsKnown: [],

    // M5b → Manual Crop redesign (2026-06-01): the two job-level batch-crop
    // defaults (`batchCropDefaultRect`, `batchCropDefaultOrientation`) were
    // removed when per-image pending state replaced the shared spec. Each
    // image now carries its own pendingCropRect / pendingRotation /
    // pendingOrientation. `batchCropLastAppliedAt` survives as job-level
    // telemetry — stamped by jobBatchCropApply on a successful "Apply
    // Default to All" run.
    batchCropLastAppliedAt: null,  // ISO 8601
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
