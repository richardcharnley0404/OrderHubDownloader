'use strict';

/**
 * src/main/jobs/customerRecropActions.js
 *
 * Customer Originals — Phase 2.
 *
 * Re-crop a customer's uncropped upload through the existing crop pipeline:
 *
 *   1. Read {orderRoot}/{originalFilename} (manifest-relative, resolved to abs).
 *   2. sharp.extract() + .jpeg({ quality: 95 }) → atomic temp + rename into
 *      {jobPath}/recrops/{baseNoExt}_{YYYYMMDD-HHMMSS}.jpeg   (canonical audit record)
 *   3. Copy the same bytes to {jobPath}/working/{newBasename}     (active source for
 *      print dispatch, AI scoring, originals snapshot — sees the new file via the
 *      unchanged /working/{filename} read paths)
 *   4. Mutate the sidecar entry per the locked decisions in
 *      OHD_CustomerOriginals_ClaudeCode_Brief.md §"Phase 2".
 *
 * Sidecar mutation rule (see `_mutateImageEntryForRecrop`):
 *
 *   Pixel-data-derived fields RESET when the pixels are replaced —
 *   aiQuality (full block incl. operatorDecision), the enhancement block
 *   (enhanced + 4 siblings), integritySuspect, corrections.
 *
 *   Operator-intent fields for the row PERSIST through the re-crop —
 *   qtyOriginal, qtyCurrent, reprint, reprintJobId, originalFilename.
 *
 * The encoding + file I/O is dependency-injected (sharp + fs) so tests can
 * stub the heavy work without touching real disk. Production wiring lives in
 * `createCustomerRecropActions` and is consumed by ipc-handlers.js.
 *
 * Locked-decision cross-references (brief):
 *   §"Keep both files on re-crop"          — customer's printable JPEG stays on disk.
 *   §"Per-image modal cropper"             — no batch UI; this module exposes one action.
 *   §"Unified cropper with a source toggle"— renderer responsibility; we just receive the rect.
 *   §"Re-score on re-crop"                 — aiQuality:{scored:false,...} forces re-score on next pass.
 *   §"Pixfizz orders only"                 — guarded indirectly: originalFilename only exists on Pixfizz manifests.
 */

const path = require('node:path');
const fsPromises = require('node:fs/promises');
const { createImageEntry } = require('../../shared/jobSchema');

// =============================================================================
// Filename helpers
// =============================================================================

/**
 * Build a re-crop output basename. Stable, sortable, collision-resistant:
 *
 *   1-IMG-20240602-WA0013b.jpg → 1-IMG-20240602-WA0013b_20260515-143022.jpeg
 *
 * Always uses .jpeg (we re-encode as JPEG q=95 regardless of the source ext).
 */
function _buildRecropFilename(originalBasename, date) {
  const base = String(originalBasename).replace(/\.[^.]+$/, '');
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${base}_${stamp}.jpeg`;
}

/**
 * Resolve the customer original's absolute path. originalFilename is stored
 * verbatim from the manifest and is relative to the order root, which is
 * `path.dirname(jobPath)` (jobPath is the per-job subfolder).
 */
function _resolveOriginalAbs(jobPath, originalFilename) {
  return path.join(path.dirname(jobPath), originalFilename);
}

// =============================================================================
// Sidecar mutation
// =============================================================================

/**
 * Return a new images array with the target entry's pixel-data-derived fields
 * reset and the re-crop bookkeeping fields populated.
 *
 *   Heuristic for future readers: anything derived from the image contents
 *   resets when the contents are replaced; anything declaring the operator's
 *   intent for this row persists.
 *
 * @param {object[]} images       - sidecar.images
 * @param {string}   matchFilename- the entry to mutate, by current `filename`
 * @param {object}   mutation
 * @param {string}   mutation.newFilename   - basename in /working/ to re-point to
 * @param {string}   mutation.recropPath    - absolute path to the /recrops/ file
 * @param {string}   mutation.recropOf      - bare basename of the customer original
 * @param {string}   mutation.recroppedAt   - ISO 8601 timestamp
 * @returns {object[]}
 */
function _mutateImageEntryForRecrop(images, matchFilename, mutation) {
  // Pixel-data-derived blocks taken straight from a freshly-created entry so
  // the reset stays in lock-step with `createImageEntry` if the schema is
  // ever extended.
  const fresh = createImageEntry('placeholder', 1);

  return images.map((entry) => {
    if (entry.filename !== matchFilename) return entry;
    return {
      ...entry,

      // Re-point to the new working copy. The OLD printable JPEG stays on
      // disk in /working/ (untouched) — operator can still find it; the
      // sidecar just no longer references it.
      filename: mutation.newFilename,

      // Pixel-data-derived — RESET (pixels replaced):
      corrections:      { ...fresh.corrections },
      enhanced:         fresh.enhanced,
      enhancementSource: fresh.enhancementSource,
      enhancedPath:     fresh.enhancedPath,
      enhancedAt:       fresh.enhancedAt,
      enhancementModel: fresh.enhancementModel,
      integritySuspect: fresh.integritySuspect,
      // Full block, including operatorDecision — that decision was about a
      // different pixel source.
      aiQuality:        { ...fresh.aiQuality, operatorDecision: { ...fresh.aiQuality.operatorDecision } },

      // Operator-intent — PRESERVE (these are decisions about the row, not
      // the pixels):  qtyOriginal, qtyCurrent, reprint, reprintJobId,
      // originalFilename, reprintOf (already untouched by the spread above).

      // Re-crop bookkeeping:
      recropPath:  mutation.recropPath,
      recropOf:    mutation.recropOf,
      recroppedAt: mutation.recroppedAt,
    };
  });
}

// =============================================================================
// Public surface
// =============================================================================

/**
 * Build the recropFromOriginal action. Deps are injected so tests can stub
 * sharp + fs + a clock without touching real disk.
 *
 * @param {object} deps
 * @param {object} deps.sharp     - sharp factory (e.g. require('sharp'))
 * @param {object} [deps.fs]      - fs/promises-compatible (defaults to node:fs/promises)
 * @param {() => Date} [deps.now] - clock injector for filename timestamps + recroppedAt
 * @param {(side, data) => Promise<object>} [deps.saveSidecar]
 *   - saver fn for the mutated sidecar; defaults to sidecarManager.saveSidecar
 *   - signature: `(sidecar, jobPath) => Promise<sidecar>`  (matches sidecarManager)
 * @param {object} [deps.logger]  - winston-like { info, warn, logError } — best-effort
 * @returns {{ recropFromOriginal: Function }}
 */
function createCustomerRecropActions(deps = {}) {
  if (!deps.sharp || typeof deps.sharp !== 'function') {
    throw new Error('createCustomerRecropActions: `sharp` is required');
  }
  const sharp = deps.sharp;
  const fs = deps.fs || fsPromises;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const log = deps.logger || { info: () => {}, warn: () => {}, logError: () => {} };
  // Lazy default so the test path can supply its own saver without dragging
  // sidecarManager into the require graph.
  const saveSidecar = typeof deps.saveSidecar === 'function'
    ? deps.saveSidecar
    // eslint-disable-next-line global-require
    : require('./sidecarManager').saveSidecar;

  /**
   * Re-crop the customer original behind `filename` to the supplied rectangle.
   *
   * @param {object} args
   * @param {string} args.jobPath       - absolute path to the job root
   * @param {object} args.sidecar       - in-memory sidecar (caller-fresh; we re-save it)
   * @param {string} args.filename      - current `entry.filename` (printable JPEG)
   * @param {{x:number,y:number,w:number,h:number}} args.cropRect
   *   - image-space pixel rect against the customer original
   * @returns {Promise<{success:boolean, sidecar?:object, recropPath?:string,
   *                    workingPath?:string, newFilename?:string, error?:string}>}
   */
  async function recropFromOriginal({ jobPath, sidecar, filename, cropRect } = {}) {
    if (!jobPath || typeof jobPath !== 'string') {
      return { success: false, error: 'jobPath is required' };
    }
    if (!sidecar || !Array.isArray(sidecar.images)) {
      return { success: false, error: 'sidecar with images array is required' };
    }
    if (!filename || typeof filename !== 'string') {
      return { success: false, error: 'filename is required' };
    }
    if (!cropRect || ['x', 'y', 'w', 'h'].some((k) => !Number.isFinite(cropRect[k]))) {
      return { success: false, error: 'cropRect must be { x, y, w, h } with finite numbers' };
    }

    const entry = sidecar.images.find((i) => i.filename === filename);
    if (!entry) {
      return { success: false, error: `No sidecar entry for filename "${filename}"` };
    }
    if (!entry.originalFilename) {
      return { success: false, error: 'This image has no customer original to re-crop from' };
    }

    const originalAbs = _resolveOriginalAbs(jobPath, entry.originalFilename);
    try {
      await fs.access(originalAbs);
    } catch {
      return { success: false, error: 'Customer original is not on disk anymore' };
    }

    const stamp = now();
    const originalBasename = path.basename(entry.originalFilename);
    const newBasename = _buildRecropFilename(originalBasename, stamp);

    const recropsDir = path.join(jobPath, 'recrops');
    const workingDir = path.join(jobPath, 'working');
    const recropPath = path.join(recropsDir, newBasename);
    const workingPath = path.join(workingDir, newBasename);
    const tempPath = recropPath + '.recrop_tmp';

    try {
      await fs.mkdir(recropsDir, { recursive: true });
      await fs.mkdir(workingDir, { recursive: true });

      // Sharp's extract is half-open + integer-pixel. Round AND clamp to the
      // original's real bounds — an overshooting rect would hard-fail libvips
      // ("extract_area: bad extract area"). Clamp degrades gracefully; warn
      // for telemetry on the upstream bad rect.
      const srcMeta  = await sharp(originalAbs).metadata();
      const exLeft   = Math.min(Math.max(0, Math.round(cropRect.x)), srcMeta.width  - 1);
      const exTop    = Math.min(Math.max(0, Math.round(cropRect.y)), srcMeta.height - 1);
      const exWidth  = Math.min(Math.max(1, Math.round(cropRect.w)), srcMeta.width  - exLeft);
      const exHeight = Math.min(Math.max(1, Math.round(cropRect.h)), srcMeta.height - exTop);
      if (exLeft !== Math.max(0, Math.round(cropRect.x)) || exTop !== Math.max(0, Math.round(cropRect.y))
          || exWidth !== Math.max(1, Math.round(cropRect.w)) || exHeight !== Math.max(1, Math.round(cropRect.h))) {
        log.warn?.('[recrop-from-original] cropRect exceeded source bounds — clamped', {
          originalAbs,
          sourceSize: `${srcMeta.width}x${srcMeta.height}`,
          requested:  { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h },
          clamped:    { left: exLeft, top: exTop, width: exWidth, height: exHeight },
        });
      }
      await sharp(originalAbs)
        .extract({ left: exLeft, top: exTop, width: exWidth, height: exHeight })
        .jpeg({ quality: 95 })
        .toFile(tempPath);

      // Atomic rename into /recrops/ (canonical audit record).
      await fs.rename(tempPath, recropPath);

      // Now also place a copy under /working/ so the unchanged scoring
      // scanner + sendReprint dispatch path see the new source via the
      // existing `/working/{filename}` reads (locked decision Option A).
      await fs.copyFile(recropPath, workingPath);
    } catch (err) {
      // Best-effort cleanup of half-written outputs.
      await fs.unlink(tempPath).catch(() => { /* ignore */ });
      // Don't unlink the recrop file if the rename already succeeded but the
      // working copy failed — the recrop is still a valid audit artifact.
      log.logError('[recrop-from-original] encoding/write failed', err, {
        originalAbs, recropPath, workingPath,
      });
      return { success: false, error: err.message || String(err) };
    }

    // Mutate the sidecar and save.
    const recroppedAt = stamp.toISOString();
    const nextImages = _mutateImageEntryForRecrop(sidecar.images, filename, {
      newFilename: newBasename,
      recropPath,
      recropOf: originalBasename,
      recroppedAt,
    });
    const nextSidecar = { ...sidecar, images: nextImages };

    let saved;
    try {
      saved = await saveSidecar(nextSidecar, jobPath);
    } catch (err) {
      log.logError('[recrop-from-original] sidecar save failed', err);
      return { success: false, error: err.message || 'sidecar save failed' };
    }

    log.info?.('[recrop-from-original] applied', {
      jobPath, oldFilename: filename, newFilename: newBasename,
      recropPath, workingPath,
    });

    return {
      success: true,
      sidecar: saved,
      recropPath,
      workingPath,
      newFilename: newBasename,
    };
  }

  return { recropFromOriginal };
}

module.exports = {
  createCustomerRecropActions,
  // Exported for direct unit-testing without standing up the full action.
  _buildRecropFilename,
  _resolveOriginalAbs,
  _mutateImageEntryForRecrop,
};
