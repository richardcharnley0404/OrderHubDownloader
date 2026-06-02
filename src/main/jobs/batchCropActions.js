'use strict';

/**
 * src/main/jobs/batchCropActions.js
 *
 * M5b — Batch crop pipeline for manual-source jobs.
 *
 * Two surfaces:
 *
 *   1. `_applyCropToSingleImage(opts)` — pure helper extracted verbatim
 *      from the body of `ohd:job:crop-image` (ipc-handlers.js:1499 before
 *      M5b). Both that IPC and the new `ohd:job:batch-crop-apply` IPC
 *      call this helper so there's exactly ONE place sharp.extract is
 *      invoked. Source code change is mechanical — extracted as-is and
 *      gained two optional params (cropOrientation, cropSource,
 *      cropAppliedAt) that default-null when omitted, so the M5a
 *      contract tests for the per-image handler stay green.
 *
 *   2. `applyBatchCrop(opts)` — public batch driver. Serialises through
 *      `_applyCropToSingleImage`, computes the per-image PIXEL rect from
 *      the supplied fractional rect + that image's source dimensions,
 *      persists the sidecar per-image (mirrors M5a's atomic-per-image
 *      contract), emits a progress event per-image, and at the very end
 *      stamps the job-level `batchCropDefault*` fields so an OHD restart
 *      restores the operator's defaults.
 *
 * Failure policy is **continue-best-effort** (Richard, 2026-05-25):
 * a per-image sharp/fs/save failure surfaces in the result's `failed[]`
 * but does NOT stop subsequent images. Rationale:
 *   - 100+ image jobs will see per-image failures (corrupt uploads,
 *     unreadable EXIF, individual libvips errors), not systemic ones.
 *   - Operator wants all failures surfaced in one batch run, not
 *     discovered serially.
 *   - Successful crops persist either way; the next batch run skips
 *     them via M5a's `cropApplied` gate (the renderer also filters).
 * Safety belt: if 10 consecutive failures share the same `error.code`,
 * abort the remainder under reason `consecutive-same-error`. Cheap to
 * add, prevents a runaway systemic failure (network drive unmounted,
 * sharp init crash, etc.) from spinning through 100 images.
 *
 * Concurrency: strictly serial within a job. libvips holds a process-
 * wide cache and SMB write paths are sensitive to concurrent rename
 * operations on the same parent directory; we don't parallelise.
 *
 * Dep injection: all heavyweight imports (sharp, fs, saveSidecar,
 * logger, jobService) are accepted via opts so tests can stub the
 * full stack without touching real disk or invoking sharp.
 *
 * @see src/main/services/__tests__/batchCrop.test.js
 * @see OHD_ManualCropping_ClaudeCode_Brief.md  §M5b
 */

const path       = require('node:path');
const fsCallback = require('node:fs');
const fsPromises = require('node:fs/promises');

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Abort the batch after N consecutive failures sharing the same
 * `error.code`. Set to 10 per the spec — high enough that per-image
 * corrupt-file failures don't trip it, low enough that a systemic
 * failure (network drive vanished, sharp init crash) doesn't waste a
 * 100-image batch.
 */
const CONSECUTIVE_SAME_ERROR_LIMIT = 10;

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Convert an image-relative fractional rect to a pixel rect for an image
 * of the given source dimensions.
 *
 *   fractional: { x: 0..1, y: 0..1, w: 0..1, h: 0..1 } (image-relative)
 *   returns:    { x: int, y: int, w: int >= 1, h: int >= 1 }
 *
 * Math:
 *   px.x = round(fr.x * srcW)
 *   px.y = round(fr.y * srcH)
 *   px.w = round(fr.w * srcW)
 *   px.h = round(fr.h * srcH)
 *
 * Then clamped to the source's actual bounds, mirroring the
 * pre-M5a clamping in `ohd:job:crop-image` so the same libvips
 * "extract_area: bad extract area" hard-fail is avoided when the
 * fractional rect is slightly over 1.0 (a UI drag past the edge).
 *
 * Returns at minimum a 1×1 rect — never zero — so libvips never
 * sees a degenerate extract.
 *
 * @param {{x:number,y:number,w:number,h:number}} fractional
 * @param {number} srcWidth   - source image width in pixels
 * @param {number} srcHeight  - source image height in pixels
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function _fractionalToPixelRect(fractional, srcWidth, srcHeight) {
  const x = Math.round(fractional.x * srcWidth);
  const y = Math.round(fractional.y * srcHeight);
  const w = Math.round(fractional.w * srcWidth);
  const h = Math.round(fractional.h * srcHeight);
  // Clamp to source bounds; ensure at least 1 px.
  const left   = Math.min(Math.max(0, x), Math.max(0, srcWidth  - 1));
  const top    = Math.min(Math.max(0, y), Math.max(0, srcHeight - 1));
  const width  = Math.min(Math.max(1, w), srcWidth  - left);
  const height = Math.min(Math.max(1, h), srcHeight - top);
  return { x: left, y: top, w: width, h: height };
}

// =============================================================================
// Source-path resolution
// =============================================================================

/**
 * Resolve the absolute path to read pixels from for a given filename.
 *
 *   sourceFrom === 'working'  (default — M5a contract, Pixfizz Customer
 *                              Originals Phase 2, reset-from-original,
 *                              reprintManager): prefer /working/<filename>,
 *                              fall back to /originals/<filename>.
 *
 *   sourceFrom === 'originals' (Manual Crop redesign 2026-06-02): prefer
 *                              /originals/<filename> so a SECOND approve
 *                              doesn't crop the FIRST approve's output;
 *                              fall back to /working/<filename> with a
 *                              warn log if /originals/ is missing
 *                              (defensive — ensureWorkingSetup normally
 *                              guarantees it exists for every job).
 *
 * Returns null when neither file exists; caller emits SOURCE_MISSING.
 *
 * @param {string}  jobPath
 * @param {string}  filename
 * @param {'working'|'originals'} sourceFrom
 * @param {object}  fs   - node:fs-compatible
 * @param {object}  log  - logger with logWarning/warn
 * @returns {string|null}
 */
function _resolveSourcePath(jobPath, filename, sourceFrom, fs, log) {
  const workingPath   = path.join(jobPath, 'working',   filename);
  const originalsPath = path.join(jobPath, 'originals', filename);

  if (sourceFrom === 'originals') {
    if (fs.existsSync(originalsPath)) return originalsPath;
    if (fs.existsSync(workingPath)) {
      (log.logWarning || log.warn || (() => {})).call(log,
        '[crop] sourceFrom=originals requested but /originals/<filename> missing; falling back to /working/',
        { filename, jobPath });
      return workingPath;
    }
    return null;
  }

  // Default: 'working' — M5a legacy preference.
  if (fs.existsSync(workingPath))   return workingPath;
  if (fs.existsSync(originalsPath)) return originalsPath;
  return null;
}

// ─── Single-image primitive (extracted from ipc-handlers.js:1499 pre-M5b) ──

/**
 * The crop primitive. Reads the source image, applies the pixel-space
 * crop via sharp, atomically renames into working/<filename>, mutates +
 * persists the sidecar, and (when ohJobId+channelMappingId/darkroomSize
 * are present) stamps the job-service cache with the routing override.
 *
 * Returns the post-save sidecar so the caller can chain mutations.
 *
 * All M5b additions are optional opts with null defaults so the
 * per-image IPC's behaviour is identical to its pre-M5b shape; only
 * the batch handler supplies cropOrientation / cropSource:'batch' /
 * cropAppliedAt.
 *
 * @param {object}   opts
 * @param {string}   opts.jobPath          - absolute job folder root
 * @param {object}   opts.sidecar          - in-memory sidecar (we re-save)
 * @param {string}   opts.filename         - entry.filename to crop
 * @param {{x,y,w,h}} opts.cropRect        - PIXEL-space rect (already scaled if from a fractional source)
 * @param {string|null} [opts.channelMappingId]
 * @param {string|null} [opts.darkroomSize]
 * @param {string|number|null} [opts.ohJobId]
 * @param {'portrait'|'landscape'|null} [opts.cropOrientation]   M5b — flat sidecar sibling
 * @param {'batch'|'per-image'} [opts.cropSource='per-image']    M5b — which UX produced this crop
 * @param {string} [opts.cropAppliedAt]    ISO timestamp — defaults to now
 * @param {0|90|180|270} [opts.cropRotation=0]
 *   M5c (2026-05-26) — per-image rotation baked into the production
 *   file. When 0 (default), the sharp chain is byte-identical to M5a's
 *   pre-rotation behaviour and the regression-lock test
 *   `M5c regression: cropRotation:0 byte-identical to no-rotation`
 *   guarantees this. When 90/180/270, the chain becomes
 *   `sharp(src).rotate(rotation).extract(rect)...` — rotation happens
 *   BEFORE extract so the rect's coordinates are interpreted in the
 *   POST-rotation image space (per the brief's implementer note).
 * @param {'working'|'originals'} [opts.sourceFrom='working']
 *   Manual Crop redesign (2026-06-02). Which on-disk folder to source
 *   pristine pixels from. Default 'working' preserves M5a semantics for
 *   all pre-existing callers (Pixfizz Customer Originals Phase 2,
 *   reset-from-original, reprintManager). 'originals' is set by
 *   ManualCropMode so re-approves source the pristine /originals/<filename>
 *   instead of the previous crop's output in /working/<filename>.
 *   Falls back to /working/ with a warn log if /originals/ is missing.
 * @param {object} [opts.deps]             dep injection (sharp, fs, fsPromises, saveSidecar, jobService, logger)
 * @returns {Promise<{success:boolean, sidecar?:object, croppedPath?:string, pixelRect?:object, error?:string, errorCode?:string}>}
 */
async function _applyCropToSingleImage(opts) {
  const {
    jobPath, sidecar, filename, cropRect,
    channelMappingId = null,
    darkroomSize     = null,
    ohJobId          = null,
    cropOrientation  = null,
    cropSource       = 'per-image',
    cropAppliedAt,
    cropRotation     = 0,
    sourceFrom       = 'working',
    deps = {},
  } = opts;

  // Lazy dep resolution. Tests inject everything; production callers
  // get sharp / fs / sidecarManager / logger / jobService for free.
  let sharp;
  if (deps.sharp) {
    sharp = deps.sharp;
  } else {
    try {
      // eslint-disable-next-line global-require
      sharp = require('sharp');
    } catch (e) {
      return { success: false, error: 'sharp is not installed — cannot crop. Run: npm install sharp', errorCode: 'NO_SHARP' };
    }
  }
  const fs            = deps.fs            || fsCallback;
  const fsPromisesDep = deps.fsPromises    || fsPromises;
  const saveSidecar   = deps.saveSidecar   || require('./sidecarManager').saveSidecar; // eslint-disable-line global-require
  const log           = deps.logger        || { info: () => {}, warn: () => {}, logWarning: () => {}, logError: () => {} };
  const jobService    = deps.jobService    || null; // optional — only used for routing override stamp

  // Source resolution — see _resolveSourcePath header for the policy.
  // /working/ stays the destination regardless; only the READ source
  // varies by sourceFrom.
  const workingDir  = path.join(jobPath, 'working');
  const workingPath = path.join(workingDir, filename);
  const sourcePath  = _resolveSourcePath(jobPath, filename, sourceFrom, fs, log);
  if (!sourcePath) {
    return { success: false, error: `Source image not found: ${filename}`, errorCode: 'SOURCE_MISSING' };
  }

  try {
    await fsPromisesDep.mkdir(workingDir, { recursive: true });

    // Validate rotation value — 0/90/180/270 only. Anything else gets
    // normalised to 0 so a malformed payload degrades to "no rotation"
    // rather than throwing. ROT_NONE branch below preserves the M5a
    // byte-identical chain exactly.
    const rotNormalised = ([0, 90, 180, 270].includes(Number(cropRotation)))
      ? Number(cropRotation)
      : 0;

    // Source dimensions for clamping. When a rotation is requested,
    // the EFFECTIVE source dimensions are swapped at 90/270 — the
    // cropRect's coordinates are interpreted in the post-rotation
    // image space (per the M5c brief implementer note: "rect's
    // coordinates are relative to the rotated image"). Clamping uses
    // those rotated dims so an over-edge rect doesn't hard-fail libvips.
    const srcMeta = await sharp(sourcePath).metadata();
    const isAxisSwapped = (rotNormalised === 90 || rotNormalised === 270);
    const effW = isAxisSwapped ? srcMeta.height : srcMeta.width;
    const effH = isAxisSwapped ? srcMeta.width  : srcMeta.height;
    const exLeft   = Math.min(Math.max(0, Math.round(cropRect.x)), effW - 1);
    const exTop    = Math.min(Math.max(0, Math.round(cropRect.y)), effH - 1);
    const exWidth  = Math.min(Math.max(1, Math.round(cropRect.w)), effW - exLeft);
    const exHeight = Math.min(Math.max(1, Math.round(cropRect.h)), effH - exTop);
    if (exLeft !== Math.round(cropRect.x) || exTop !== Math.round(cropRect.y)
        || exWidth !== Math.round(cropRect.w) || exHeight !== Math.round(cropRect.h)) {
      (log.logWarning || log.warn || (() => {})).call(log, 'Crop rect exceeded source bounds — clamped', {
        filename,
        sourceSize: `${effW}x${effH}` + (isAxisSwapped ? ` (rotated from ${srcMeta.width}x${srcMeta.height})` : ''),
        requested:  { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h },
        clamped:    { left: exLeft, top: exTop, width: exWidth, height: exHeight },
        cropRotation: rotNormalised,
      });
    }

    // Atomic .crop_tmp + rename — same pattern as M5a so a process
    // kill mid-crop never leaves a half-written file at workingPath.
    //
    // M5c regression-lock contract (2026-05-26): when rotNormalised
    // is 0 we MUST NOT call .rotate(0) — sharp's pipeline must be
    // byte-identical to the pre-M5c chain (`sharp(src).extract().jpeg()`).
    // The test `M5c regression: cropRotation:0 byte-identical to
    // no-rotation` in batchCrop.test.js locks this contract. Branch
    // explicitly on rotNormalised === 0 so a future refactor can't
    // accidentally collapse the branches and break byte-identity.
    const tempPath = workingPath + '.crop_tmp';
    if (rotNormalised === 0) {
      await sharp(sourcePath)
        .extract({ left: exLeft, top: exTop, width: exWidth, height: exHeight })
        .jpeg({ quality: 95 })
        .toFile(tempPath);
    } else {
      // sharp.rotate(N) BEFORE extract — rect coords are in post-rotation space.
      await sharp(sourcePath)
        .rotate(rotNormalised)
        .extract({ left: exLeft, top: exTop, width: exWidth, height: exHeight })
        .jpeg({ quality: 95 })
        .toFile(tempPath);
    }
    await fsPromisesDep.rename(tempPath, workingPath);

    (log.info || (() => {})).call(log, 'Crop applied', {
      filename, cropRect, channelMappingId, ohJobId,
      croppedPath: workingPath,
      cropSource,
      cropRotation: rotNormalised,
    });

    // Sidecar mutation — preserves pre-M5b shape (filename, cropApplied,
    // croppedPath, cropRect, channelMappingId) and adds the new M5b
    // flat siblings (cropOrientation, cropSource, cropAppliedAt) +
    // the M5c sibling cropRotation. The M5a tests assert presence +
    // values of the pre-M5b fields and check `filename` is unchanged
    // — both contracts still hold.
    //
    // cropRotation persistence policy: ALWAYS write the normalised
    // value (0 included), not just when non-zero. This makes the
    // field meaningful on every cropped entry — "0" explicitly says
    // "no rotation was applied" rather than null/missing which on
    // legacy entries means "unknown / pre-M5c". The renderer can
    // distinguish a pre-M5c null from a post-M5c 0.
    const stampedAt = cropAppliedAt || new Date().toISOString();
    const persistedRect = { x: exLeft, y: exTop, w: exWidth, h: exHeight };
    const updatedSidecar = {
      ...sidecar,
      images: sidecar.images.map((img) => {
        if (img.filename !== filename) return img;
        return {
          ...img,
          // Pre-M5b (M5a-locked contract):
          cropApplied:      true,
          croppedPath:      workingPath,
          cropRect:         persistedRect,
          channelMappingId,
          // M5b flat siblings:
          cropOrientation,
          cropSource,
          cropAppliedAt:    stampedAt,
          // M5c flat sibling:
          cropRotation:     rotNormalised,
        };
      }),
    };

    const saved = await saveSidecar(updatedSidecar, jobPath);

    // Routing override stamp on the job-service cache. Pre-M5b
    // behaviour preserved verbatim — only fires when ohJobId AND one of
    // (channelMappingId, darkroomSize) are present.
    if (jobService && ohJobId && (channelMappingId || darkroomSize)) {
      const numericId = Number(ohJobId);
      if (!Number.isNaN(numericId)) {
        const updates = {};
        if (channelMappingId) updates._channelMappingOverride = channelMappingId;
        if (darkroomSize)     updates._darkroomProSize        = darkroomSize;
        try { jobService.updateJobLocally(numericId, updates); } catch (_) { /* best-effort */ }
      }
    }

    return { success: true, sidecar: saved, croppedPath: workingPath, pixelRect: persistedRect };
  } catch (err) {
    (log.logError || log.error || (() => {})).call(log, '[batch-crop] single-image crop failed', err, { filename });
    return {
      success: false,
      error:   err && err.message ? err.message : String(err),
      errorCode: err && err.code ? err.code : 'CROP_FAILED',
    };
  }
}

// ─── Batch driver ───────────────────────────────────────────────────────────

/**
 * Apply a fractional crop rect to every supplied filename, serialised
 * through `_applyCropToSingleImage`. Skips filenames already cropped
 * (defensive — the renderer should filter, but a redundant filter here
 * means a stale renderer state can't double-crop). Persists the
 * job-level batchCropDefault* fields once at the end so OHD restart
 * restores the workflow state.
 *
 * @param {object} opts
 * @param {string} opts.jobPath
 * @param {object} opts.sidecar
 * @param {string[]} opts.filenames    - subset to process (renderer-decided)
 * @param {{x,y,w,h}} opts.fractionalRect - image-relative fractions
 * @param {'portrait'|'landscape'} opts.orientation
 * @param {string|null} [opts.channelMappingId]
 * @param {string|null} [opts.darkroomSize]
 * @param {string|number|null} [opts.ohJobId]
 * @param {(progress:{completed:number,total:number,filename:string,ok:boolean,error?:string}) => void} [opts.onProgress]
 * @param {'working'|'originals'} [opts.sourceFrom='working']
 *   Manual Crop redesign (2026-06-02) — see _applyCropToSingleImage's
 *   sourceFrom docs. Forwarded verbatim to every per-image apply, and
 *   also governs this driver's per-image dimension read (which it does
 *   to project fractionalSpec → pixel rect).
 * @param {object} [opts.deps]
 * @returns {Promise<{
 *   success: true,
 *   sidecar: object,
 *   succeeded: Array<{ filename:string, pixelRect:object }>,
 *   failed:    Array<{ filename:string, error:string, errorCode?:string }>,
 *   skipped:   Array<{ filename:string, reason:'already-cropped'|'not-found' }>,
 *   aborted?:  { reason:'consecutive-same-error', errorCode:string, count:number },
 * }>}
 */
async function applyBatchCrop(opts) {
  const {
    jobPath, filenames,
    // 2026-05-25 spec rewrite: payload now carries a FractionalSpec
    // { centerX, centerY, scale } + sizeOption { w, h, ... } instead of
    // the old { x, y, w, h } fractional rect. The per-image pixel rect
    // is computed by specToPixelRect, which respects the TARGET aspect
    // (square targets give square crops regardless of source aspect).
    fractionalSpec,
    orientation,
    sizeOption,
    channelMappingId = null,
    darkroomSize     = null,
    ohJobId          = null,
    sourceFrom       = 'working',
    onProgress,
    deps = {},
  } = opts;

  if (!jobPath || typeof jobPath !== 'string') {
    return { success: false, error: 'jobPath is required', succeeded: [], failed: [], skipped: [] };
  }
  if (!opts.sidecar || !Array.isArray(opts.sidecar.images)) {
    return { success: false, error: 'sidecar with images[] is required', succeeded: [], failed: [], skipped: [] };
  }
  if (!Array.isArray(filenames)) {
    return { success: false, error: 'filenames must be an array', succeeded: [], failed: [], skipped: [] };
  }
  if (!fractionalSpec
      || !['centerX', 'centerY', 'scale'].every((k) => Number.isFinite(fractionalSpec[k]))) {
    return { success: false, error: 'fractionalSpec must be { centerX, centerY, scale } with finite numbers', succeeded: [], failed: [], skipped: [] };
  }
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    return { success: false, error: 'orientation must be "portrait" or "landscape"', succeeded: [], failed: [], skipped: [] };
  }
  if (!sizeOption || !Number.isFinite(sizeOption.w) || !Number.isFinite(sizeOption.h)
      || sizeOption.w <= 0 || sizeOption.h <= 0) {
    return { success: false, error: 'sizeOption with positive w/h is required', succeeded: [], failed: [], skipped: [] };
  }

  let sharp;
  if (deps.sharp) {
    sharp = deps.sharp;
  } else {
    try { sharp = require('sharp'); } // eslint-disable-line global-require
    catch (e) {
      return { success: false, error: 'sharp is not installed — cannot batch crop', succeeded: [], failed: [], skipped: [] };
    }
  }
  const fs            = deps.fs            || fsCallback;
  const fsPromisesDep = deps.fsPromises    || fsPromises;
  const log           = deps.logger        || { info: () => {}, warn: () => {}, logWarning: () => {}, logError: () => {} };
  const saveSidecar   = deps.saveSidecar   || require('./sidecarManager').saveSidecar; // eslint-disable-line global-require
  const jobService    = deps.jobService    || null;

  // Working in-memory sidecar — each successful crop replaces it with
  // the persisted post-save copy from `_applyCropToSingleImage`.
  let sidecar = opts.sidecar;

  const succeeded = [];
  const failed    = [];
  const skipped   = [];
  let consecutiveSameErrorCode = null;
  let consecutiveSameErrorCount = 0;
  let abortInfo = null;
  // Stamp ONE timestamp for the whole batch so the post-loop job-level
  // batchCropLastAppliedAt and every per-image cropAppliedAt line up.
  const batchAppliedAt = new Date().toISOString();

  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];

    // Defensive idempotency — skip filenames already cropped. The
    // renderer filters before calling but a stale UI state could
    // double-include; this keeps the post-condition predictable.
    const entry = sidecar.images.find((img) => img && img.filename === filename);
    if (!entry) {
      skipped.push({ filename, reason: 'not-found' });
      if (onProgress) {
        onProgress({ completed: succeeded.length + failed.length + skipped.length, total: filenames.length, filename, ok: false, skipped: true });
      }
      continue;
    }
    if (entry.cropApplied === true) {
      skipped.push({ filename, reason: 'already-cropped' });
      if (onProgress) {
        onProgress({ completed: succeeded.length + failed.length + skipped.length, total: filenames.length, filename, ok: true, skipped: true });
      }
      continue;
    }

    // Read per-image source dimensions to scale fractional → pixel rect.
    // The crop primitive itself also reads metadata (for clamping); we
    // do it once here to compute the rect, and the primitive does it
    // again to clamp. Two reads is fine — sharp caches metadata cheaply.
    const sourcePath = _resolveSourcePath(jobPath, filename, sourceFrom, fs, log);
    if (!sourcePath) {
      failed.push({ filename, error: `Source image not found: ${filename}`, errorCode: 'SOURCE_MISSING' });
      // Track for safety belt.
      if (consecutiveSameErrorCode === 'SOURCE_MISSING') {
        consecutiveSameErrorCount++;
      } else {
        consecutiveSameErrorCode = 'SOURCE_MISSING';
        consecutiveSameErrorCount = 1;
      }
      if (onProgress) {
        onProgress({ completed: succeeded.length + failed.length + skipped.length, total: filenames.length, filename, ok: false, error: 'SOURCE_MISSING' });
      }
      if (consecutiveSameErrorCount >= CONSECUTIVE_SAME_ERROR_LIMIT) {
        abortInfo = { reason: 'consecutive-same-error', errorCode: consecutiveSameErrorCode, count: consecutiveSameErrorCount };
        break;
      }
      continue;
    }

    let pixelRect;
    try {
      const meta = await sharp(sourcePath).metadata();
      // 2026-05-25: compute per-image pixel rect from the
      // FractionalSpec via specToPixelRect, which honours the TARGET
      // aspect (sizeOption + orientation). Output rect's pixel
      // dimensions always match target aspect — square targets give
      // square crops regardless of source image aspect.
      // eslint-disable-next-line global-require
      const { specToPixelRect } = require('../../shared/cropRectMath');
      pixelRect = specToPixelRect(fractionalSpec, sizeOption, orientation, meta.width, meta.height);
      if (!pixelRect) {
        throw new Error('specToPixelRect returned null — invalid spec or image dimensions');
      }
    } catch (err) {
      const errorCode = err && err.code ? err.code : 'METADATA_FAILED';
      failed.push({ filename, error: err && err.message ? err.message : String(err), errorCode });
      if (consecutiveSameErrorCode === errorCode) {
        consecutiveSameErrorCount++;
      } else {
        consecutiveSameErrorCode = errorCode;
        consecutiveSameErrorCount = 1;
      }
      (log.logError || log.error || (() => {})).call(log, '[batch-crop] metadata read failed', err, { filename });
      if (onProgress) {
        onProgress({ completed: succeeded.length + failed.length + skipped.length, total: filenames.length, filename, ok: false, error: errorCode });
      }
      if (consecutiveSameErrorCount >= CONSECUTIVE_SAME_ERROR_LIMIT) {
        abortInfo = { reason: 'consecutive-same-error', errorCode: consecutiveSameErrorCode, count: consecutiveSameErrorCount };
        break;
      }
      continue;
    }

    const result = await _applyCropToSingleImage({
      jobPath,
      sidecar,
      filename,
      cropRect:        pixelRect,
      channelMappingId,
      darkroomSize,
      ohJobId,
      cropOrientation: orientation,
      cropSource:      'batch',
      cropAppliedAt:   batchAppliedAt,
      sourceFrom,
      deps: { sharp, fs, fsPromises: fsPromisesDep, saveSidecar, jobService, logger: log },
    });

    if (result.success) {
      sidecar = result.sidecar;
      succeeded.push({ filename, pixelRect: result.pixelRect });
      consecutiveSameErrorCode = null;
      consecutiveSameErrorCount = 0;
      if (onProgress) {
        onProgress({ completed: succeeded.length + failed.length + skipped.length, total: filenames.length, filename, ok: true });
      }
    } else {
      const errorCode = result.errorCode || 'CROP_FAILED';
      failed.push({ filename, error: result.error, errorCode });
      if (consecutiveSameErrorCode === errorCode) {
        consecutiveSameErrorCount++;
      } else {
        consecutiveSameErrorCode = errorCode;
        consecutiveSameErrorCount = 1;
      }
      if (onProgress) {
        onProgress({ completed: succeeded.length + failed.length + skipped.length, total: filenames.length, filename, ok: false, error: errorCode });
      }
      if (consecutiveSameErrorCount >= CONSECUTIVE_SAME_ERROR_LIMIT) {
        abortInfo = { reason: 'consecutive-same-error', errorCode: consecutiveSameErrorCode, count: consecutiveSameErrorCount };
        break;
      }
    }
  }

  // Stamp job-level batchCropLastAppliedAt once at the end. Persist
  // regardless of per-image successes — even a failed run is useful
  // telemetry (e.g. retry after fixing a corrupt-file issue).
  //
  // Manual Crop redesign (2026-06-01): the two batchCropDefault* fields
  // (`Rect`, `Orientation`) were removed when per-image pending state
  // replaced the shared spec. The renderer no longer reads them and
  // sidecarManager.js Reconcile E drops them from any legacy sidecar
  // on load; writing them back here would re-introduce dead data.
  sidecar = {
    ...sidecar,
    batchCropLastAppliedAt: batchAppliedAt,
  };
  try {
    sidecar = await saveSidecar(sidecar, jobPath);
  } catch (err) {
    (log.logError || log.error || (() => {})).call(log, '[batch-crop] job-level defaults save failed', err, { jobPath });
    // Non-fatal — per-image saves already landed. Disk recovers on next
    // meaningful save.
  }

  const result = { success: true, sidecar, succeeded, failed, skipped };
  if (abortInfo) result.aborted = abortInfo;
  return result;
}

// ─── Target-size resolver (M5b bug-1 fix, 2026-05-25) ──────────────────────
//
// Map a route to a canonical `sizeOption` entry. Three independent
// lookup paths in order; only returns `{ ok: false, reason:
// 'no-size-translation' }` when ALL THREE fail, so we're robust to
// route shape variation across controller types.
//
//   1. DPOF: route.controllerId + route.channelNumber →
//      walk channelMappings to find the mapping → match sizeOption by
//      channelMappingId.
//   2. Darkroom: route.controllerType === 'darkroompro' + job.product_code →
//      walk the controller's sizeTranslations for a productCodePrefix
//      match → parse the matching translation's darkroomSize → match
//      sizeOption by {w, h}.
//   3. Fallback: parse a {w, h} pair out of route.printSizeCode (or
//      route.darkroomSize) using the same regex getAllSizeOptions uses
//      internally → match sizeOption by {w, h}.
//
// The pre-fix matcher tried to compare route.printSizeCode against
// sizeOption.id and sizeOption.label — both wrong-shape (id is always
// `cm_<uuid>` / `dt_<…>` and label is `'4×6"'` with U+00D7 + inch
// mark). That meant every routed manual job returned
// 'no-size-translation', leaving BatchCropMode partly-broken in the UI.
// See OHD_ManualCropping brief §M5b regression notes (2026-05-25).
//
// `deps` are injectable so tests can drive the matcher without the real
// routing-service singleton.
const _SIZE_RE = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i;

function _parseSizeStr(str) {
  if (!str) return null;
  const m = String(str).match(_SIZE_RE);
  if (!m) return null;
  return { w: parseFloat(m[1]), h: parseFloat(m[2]) };
}

function _sameSize(a, b) {
  // Tolerant equality — DPOF sizes are typically integers, but
  // Darkroom translations can carry "4.5 x 6.5" etc. Round to 0.01.
  return Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
}

/**
 * Resolve a target size for a job. Returns one of:
 *   { ok: true,  sizeOption: { w, h, label, … } }
 *   { ok: false, reason: 'unrouted'|'pdf-or-folder-copy'|'no-size-translation'|'error', error? }
 *
 * @param {object} job  - normalised job object
 * @param {object} deps - { resolveRoute, getAllSizeOptions, getChannelMappings, getControllers, logger }
 */
function resolveTargetSize(job, deps = {}) {
  const log = deps.logger || { logError: () => {}, info: () => {} };
  try {
    if (!job) return { ok: false, reason: 'no-job' };
    if (typeof deps.resolveRoute !== 'function') {
      return { ok: false, reason: 'error', error: 'resolveRoute dependency missing' };
    }

    const route = deps.resolveRoute(job);
    if (!route || route.type === 'unrouted') {
      return { ok: false, reason: 'unrouted' };
    }

    // folder_copy + pdf_copy carry no print size — operator must assign a
    // sized route or crop via a different surface.
    if (route.controllerType === 'folder_copy' || route.controllerType === 'pdf_copy') {
      return { ok: false, reason: 'pdf-or-folder-copy' };
    }

    const sizes = (typeof deps.getAllSizeOptions === 'function') ? (deps.getAllSizeOptions() || []) : [];

    // ── Path 1: DPOF channel-mapping lookup ─────────────────────────────────
    //
    // The DPOF route carries controllerId + channelNumber. The
    // channelMappings store is the source of truth that ties those two
    // back to a specific mapping id; that id is exactly what
    // sizeOption.channelMappingId carries.
    if (route.controllerId && route.channelNumber != null
        && typeof deps.getChannelMappings === 'function') {
      const mappings = deps.getChannelMappings() || [];
      const mapping = mappings.find((m) =>
           m && m.controllerId === route.controllerId
        && Number(m.channelNumber) === Number(route.channelNumber)
      );
      if (mapping) {
        const match = sizes.find((s) =>
          s && s.channelMappingId === mapping.id
        );
        if (match) return { ok: true, sizeOption: match };
      }
    }

    // ── Path 2: Darkroom sizeTranslations lookup ────────────────────────────
    //
    // The Darkroom route's controller has a sizeTranslations table that
    // maps productCodePrefix → darkroomSize. Find the matching entry
    // for THIS job's product_code, parse its size string, then match
    // sizeOption by {w, h}.
    //
    // CONTROLLER-SCOPED MATCH: multiple sizeOptions can share {w, h}
    // (e.g. one DPOF cm_dpof-4x6 + one Darkroom dt_DR1_POS, both 4×6).
    // For a Darkroom route, prefer the sizeOption whose
    // darkroomControllerId matches the route's controllerId before
    // falling back to a bare {w, h} match. Without this, a Darkroom
    // 4×6 job would match the DPOF 4×6 sizeOption first (find() is
    // first-match), producing the wrong controller's sizeOption.
    if (route.controllerType === 'darkroompro'
        && job.product_code
        && route.controllerId
        && typeof deps.getControllers === 'function') {
      const controllers = deps.getControllers() || [];
      const ctrl = controllers.find((c) => c && c.id === route.controllerId);
      if (ctrl && Array.isArray(ctrl.sizeTranslations)) {
        const trans = ctrl.sizeTranslations.find((t) =>
          t && t.productCodePrefix
          && String(job.product_code).toUpperCase().startsWith(String(t.productCodePrefix).toUpperCase())
        );
        if (trans) {
          const sz = _parseSizeStr(trans.darkroomSize);
          if (sz) {
            // Scoped match first.
            const scoped = sizes.find((s) =>
              s && s.darkroomControllerId === route.controllerId && _sameSize(s, sz)
            );
            if (scoped) return { ok: true, sizeOption: scoped };
            // Fall back to any sizeOption with matching {w, h}.
            const match = sizes.find((s) => s && _sameSize(s, sz));
            if (match) return { ok: true, sizeOption: match };
          }
        }
      }
    }

    // ── Path 3: printSizeCode / darkroomSize regex parse fallback ──────────
    //
    // Last resort: parse a {w, h} pair out of whatever size string the
    // route carries and find ANY sizeOption with matching dimensions.
    // Less precise (could match a sizeOption belonging to a different
    // controller) but recovers when the channel/mapping lookups fail
    // due to data drift (deleted mapping, renamed controller, etc.).
    const candidateStrings = [
      route.printSizeCode,
      route.darkroomSize,
    ].filter(Boolean);
    for (const s of candidateStrings) {
      // Strip NML -PSIZE wrapper if present.
      const stripped = String(s).replace(/^NML\s+-PSIZE\s+"|"$/g, '').trim();
      const sz = _parseSizeStr(stripped);
      if (sz) {
        const match = sizes.find((opt) => opt && _sameSize(opt, sz));
        if (match) return { ok: true, sizeOption: match };
      }
    }

    return { ok: false, reason: 'no-size-translation' };
  } catch (err) {
    log.logError && log.logError('[batch-crop] resolveTargetSize threw', err);
    return { ok: false, reason: 'error', error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  applyBatchCrop,
  _applyCropToSingleImage,
  _fractionalToPixelRect,
  resolveTargetSize,
  CONSECUTIVE_SAME_ERROR_LIMIT,
};
