'use strict';

/**
 * src/shared/batchCropTrigger.js
 *
 * Pure predicate: should Job Review enter Batch Crop mode for this job?
 *
 * Lives in /shared so both the renderer (mode routing in
 * `views/JobReview/index.jsx`) and the main process (defensive logging in
 * `ipc-handlers.js`'s batch-crop endpoint) can call it without diverging
 * on the answer. Mirrors `holdForReview.js`'s placement + style.
 *
 * Canonical rule (Manual Cropping brief §"Behaviour rules"):
 *
 *   shouldEnterBatchCropMode(job, sidecar) =
 *        (job.artwork_source === 'manual'
 *         OR any sidecar.images[i].artworkSource === 'manual')
 *     AND any sidecar.images[i].cropApplied !== true
 *
 * The decision returns three modes:
 *   - 'auto'     — drawer opens DIRECTLY in batch crop mode (zero images
 *                  cropped yet). Caller renders <BatchCropMode> instead of
 *                  the standard body.
 *   - 'button'   — drawer opens in standard mode but with a prominent
 *                  "Batch Crop Remaining (X)" CTA above the grid. Some
 *                  images already cropped; operator gets to finish the
 *                  remainder via the same UX.
 *   - 'standard' — no manual source, OR every image already cropped. The
 *                  standard Job Review drawer with Send to Print enabled.
 *
 * Edge cases handled gracefully (return 'standard' rather than throwing):
 *   - job null/undefined
 *   - sidecar null/undefined or images[] missing
 *   - mixed-source jobs (one or more files with source='manual' on an
 *     otherwise Pixfizz job): still enters batch mode — per brief,
 *     manual files anywhere in the job trigger the crop UX. This matches
 *     `holdForReview.js`'s manual-file clause.
 */

const MODE = Object.freeze({
  AUTO:     'auto',
  BUTTON:   'button',
  STANDARD: 'standard',
});

/**
 * @param {object|null} job
 *   Normalised job from job-service. We read `artwork_source` only.
 * @param {object|null} sidecar
 *   Loaded sidecar. We read `images[]` for cropApplied/artworkSource.
 * @returns {{
 *   enter:          boolean,    // mode !== 'standard'
 *   mode:           'auto'|'button'|'standard',
 *   uncroppedCount: number,
 *   totalCount:     number,
 *   reason:         'pixfizz'|'no-images'|'all-cropped'|'manual-uncropped'|'manual-partial',
 * }}
 */
function shouldEnterBatchCropMode(job, sidecar) {
  // Degenerate inputs → standard mode. Defensive — the renderer calls
  // this on every render and shouldn't crash on a partially-loaded job.
  if (!sidecar || !Array.isArray(sidecar.images) || sidecar.images.length === 0) {
    return {
      enter: false, mode: MODE.STANDARD,
      uncroppedCount: 0, totalCount: 0,
      reason: 'no-images',
    };
  }

  const totalCount = sidecar.images.length;

  // Manual-source signal: job-level OR any per-image. Mirrors the
  // holdForReview manual-file clause exactly so the two surfaces agree
  // about which jobs are "manual" (and therefore which see the crop UX).
  const jobIsManual    = job && job.artwork_source === 'manual';
  const anyManualImage = sidecar.images.some(
    (img) => img && img.artworkSource === 'manual'
  );
  if (!jobIsManual && !anyManualImage) {
    return {
      enter: false, mode: MODE.STANDARD,
      uncroppedCount: 0, totalCount,
      reason: 'pixfizz',
    };
  }

  // Count uncropped. cropApplied is the M5a contract gate — the same
  // field print-service._getEnhancedPathMap reads to decide dispatch
  // substitution. `=== true` (not truthy) so a stray non-boolean value
  // doesn't accidentally pass.
  const uncroppedCount = sidecar.images.filter(
    (img) => img && img.cropApplied !== true
  ).length;

  if (uncroppedCount === 0) {
    return {
      enter: false, mode: MODE.STANDARD,
      uncroppedCount: 0, totalCount,
      reason: 'all-cropped',
    };
  }

  // Some uncropped — pick auto vs button.
  //   - 100% uncropped (fresh job)            → mode='auto'
  //   - 0% < uncropped < 100% (partial state) → mode='button'
  // The brief specifies this split explicitly; the partial-state CTA
  // avoids surprising the operator who already started a batch and may
  // want to review the cropped images before processing the remainder.
  if (uncroppedCount === totalCount) {
    return {
      enter: true, mode: MODE.AUTO,
      uncroppedCount, totalCount,
      reason: 'manual-uncropped',
    };
  }

  return {
    enter: true, mode: MODE.BUTTON,
    uncroppedCount, totalCount,
    reason: 'manual-partial',
  };
}

module.exports = {
  shouldEnterBatchCropMode,
  MODE,
};
