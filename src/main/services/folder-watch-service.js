const fs = require('fs');
const path = require('path');
const configService = require('./config-service');
const s3Service = require('./s3-service');
const logger = require('./logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry-on-EPERM rename. Sharp's writeFile occasionally leaves a brief
 * handle on the destination on Windows (and SMB shares amplify the window),
 * so the rename of `.rot.tmp` → original races with that handle and
 * antivirus/explorer thumbnail prefetch. JPGs hit this much harder than
 * TIFs because Synology's photo indexer + Windows Defender scan JPGs
 * aggressively (sometimes for tens of seconds) but mostly leave TIFFs alone.
 *
 * Strategy:
 *   1. Up to `attempts` direct rename retries with exponential backoff,
 *      capped at `maxDelay` per wait. Total patience ≈ 22s (was 5s).
 *   2. On the final attempt, try `unlink(dest) + rename(src, dest)` —
 *      explicit delete uses different lock semantics than overwrite-rename
 *      and sometimes squeezes through when the indexer has a deny-write
 *      handle but tolerates delete.
 *
 * Only retries the well-known transient codes (EPERM/EBUSY/EACCES/ENOTEMPTY);
 * anything else (ENOENT, EINVAL, etc) is a real bug and bubbles immediately.
 */
async function renameWithRetry(src, dest, attempts = 10, baseDelay = 200, maxDelay = 4000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      const transient = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code);
      if (!transient) throw err;
      if (i < attempts - 1) {
        await sleep(Math.min(baseDelay * Math.pow(2, i), maxDelay));
      }
    }
  }
  // Final fallback: explicit unlink + rename. unlink may itself EPERM, in
  // which case we re-throw the original rename error (we don't want to
  // pretend success after losing both the destination and the rename).
  try {
    fs.unlinkSync(dest);
    fs.renameSync(src, dest);
    return;
  } catch (_) {
    throw lastErr;
  }
}

class FolderWatchService {
  constructor() {
    this.lastSummary = { filmScans: null, fileUploads: null };
    this._filmScanProcessing = false;
    this._resumedUploads = false;
    // 2026-07-24 — authoritative in-process guard against concurrent uploads
    // of the same roll. _filmScanProcessing only prevents the film-scans
    // cycle from re-entering itself; but _uploadRollFromStorage is ALSO
    // called from pollJobs (auto-assign match cycle, on the main polling
    // timer — separate timer, no shared guard) and from the operator's
    // "upload-unmatched" IPC. Two callers arriving on the same roll at
    // the same tick would each start their own upload — this Set makes
    // the second one no-op. Entries are added on entry to
    // _uploadRollFromStorage and removed in a `finally` so a crash
    // mid-upload doesn't leak a permanent stuck entry.
    this._uploadingRolls = new Set();
    // 2026-07-23 — In-process registry of the currently-running film-scan
    // Perfectly Clear batch, if any. Held here (not per-cycle) so a
    // startup sweep AND an operator-triggered reset can both consult it
    // and, if the roll is live, abort via the AbortController rather
    // than clobbering a genuine enhance.
    //   { rollId, abortController, startedAt } | null
    this._activeFilmScanBatch = null;
  }

  async processAll() {
    const config = configService.getAll();

    if (config.filmScansEnabled) {
      this.lastSummary.filmScans = await this._processFilmScans(config);
    }

    return this.lastSummary;
  }

  /**
   * Public method for polling-service to call on the independent File Uploads timer.
   */
  async processFileUploads() {
    const config = configService.getAll();
    if (!config.fileUploadsEnabled) return null;
    this.lastSummary.fileUploads = await this._processFileUploads(config);
    return this.lastSummary.fileUploads;
  }

  async _processFilmScans(config) {
    if (this._filmScanProcessing) {
      logger.info('filmScans: previous processing still running, skipping this cycle');
      return { processed: 0, skipped: 0, failed: 0, errors: [] };
    }

    this._filmScanProcessing = true;
    const summary = { processed: 0, skipped: 0, failed: 0, errors: [] };
    try {
      // Scanner source mirror (optional, additive, UPSTREAM). If a scanner
      // source folder is configured, copy new/changed stable folders from it
      // into the watch folder; the existing pipeline below then consumes them
      // exactly as before. The source folder is never modified — it stays the
      // lab's pristine archive. Best-effort; never breaks the cycle. The whole
      // consume/rotate/upload path below is intentionally left untouched.
      try {
        const filmScanSourceMirror = require('./film-scan-source-mirror');
        const mirrorResult = await filmScanSourceMirror.mirror(config, logger);
        if (mirrorResult.copied > 0 || mirrorResult.errors.length > 0) {
          logger.info(`filmScans: scanner mirror — copied ${mirrorResult.copied}, skipped ${mirrorResult.skipped}, error(s) ${mirrorResult.errors.length}`);
        }
      } catch (mirrorErr) {
        logger.logWarning('filmScans: scanner source mirror failed', { error: mirrorErr.message });
      }

      // Retention sweep — drop reviewed rolls older than the configured window
      // from the Film Review history. Removes metadata + the thumbnail cache
      // only; the scan files in the permanent storage folder are NEVER touched
      // — with one exception (M4): the `{storagePath}/pre-enhance/` folder
      // Perfectly Clear stashes original bytes into is scoped to the review
      // lifecycle, so we sweep it here alongside the rest.
      //
      // Best-effort, once per cycle so the history self-trims as the lab works.
      try {
        const frameMetadataStore = require('./frame-metadata-store');
        const { isRollPrunable } = frameMetadataStore;
        const days = Number(config.filmScansRetentionDays);
        // Capture the storagePath of each roll that WILL be pruned so we can
        // clean up its pre-enhance/ folder after pruneOldRolls wipes the
        // roll record. Safe when days is invalid — the filter still evaluates
        // but produces an empty list.
        let preEnhanceFolders = [];
        try {
          if (Number.isFinite(days) && days > 0) {
            const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
            const summaries = frameMetadataStore.listRollsWithSummary();
            for (const s of summaries) {
              if (isRollPrunable && isRollPrunable(s, cutoffMs) && s.storagePath) {
                preEnhanceFolders.push(path.join(s.storagePath, 'pre-enhance'));
              }
            }
          }
        } catch (_) { /* best-effort */ }

        const prunedRolls = frameMetadataStore.pruneOldRolls(config.filmScansRetentionDays);
        if (prunedRolls.length > 0) {
          const { app } = require('electron');
          const thumbsRoot = path.join(app.getPath('userData'), 'thumbnails');
          for (const rollId of prunedRolls) {
            try { this._deleteFolderRecursive(path.join(thumbsRoot, rollId)); } catch (_) { /* best-effort */ }
          }
          for (const preDir of preEnhanceFolders) {
            try { this._deleteFolderRecursive(preDir); } catch (_) { /* best-effort */ }
          }
          logger.info(`filmScans: retention pruned ${prunedRolls.length} old roll(s) from Film Review history`);
        }
      } catch (pruneErr) {
        logger.logWarning('filmScans: retention prune failed', { error: pruneErr.message });
      }

      // 2026-07-24 — run every cycle (was once-per-launch). Two categories:
      //   - Rolls stuck at 'uploading' from a prior crash/hang → resume.
      //   - Rolls at 'failed' → self-heal, rate-limited to 10 min per roll
      //     via lastUploadRetryAt so a broken roll doesn't spam the API.
      // The rate-limit lives inside _resumeInterruptedUploads and covers
      // both branches, so calling every cycle is safe (an in-flight upload
      // that just began has lastUploadRetryAt < 10 min → skipped).
      try {
        await this._resumeInterruptedUploads(config);
      } catch (resumeErr) {
        logger.logWarning('filmScans: resume interrupted uploads failed', { error: resumeErr.message });
      }

      const watchFolder = config.filmScansWatchFolder;
      const storageFolder = config.filmScansStorageFolder;
      const stabilityMinutes = config.filmScansWatchguardMinutes || config.fileStabilityMinutes;
      const locationId = config.locationId;

      if (!watchFolder || !fs.existsSync(watchFolder)) {
        logger.logWarning(`filmScans: watch folder not configured or missing: ${watchFolder}`);
        return summary;
      }

      if (!storageFolder) {
        logger.logWarning('filmScans: storage folder not configured');
        return summary;
      }

      const s3Prefix = `film-scans/${locationId}/`;

      // M8-3: small helper so the renderer refreshes the rolls list as
      // provisional records (detected / processing) appear and transition.
      // Best-effort — same pattern as the existing roll-processed emit.
      const emitRollUpdate = (rollId) => {
        try {
          const { BrowserWindow } = require('electron');
          const wins = BrowserWindow.getAllWindows();
          for (const w of wins) {
            if (w && !w.isDestroyed()) {
              w.webContents.send('ohd:filmReview:roll-processed', { rollId });
            }
          }
        } catch (_) { /* best-effort */ }
      };

      try {
        const entries = fs.readdirSync(watchFolder, { withFileTypes: true });
        const folders = entries.filter((e) => e.isDirectory());

        if (folders.length > 0) {
          logger.info(`filmScans: ${folders.length} folder(s) in watch folder this cycle`);
        }

        for (const folder of folders) {
          const watchPath = path.join(watchFolder, folder.name);

          // M8-3: provisional roll record. Surfaces the folder in the Film
          // Review panel as "Watching" while the watchguard timer ticks down,
          // so operators can see their scan was detected even before
          // processing begins. Only emit when AI rotation is enabled — that's
          // the only mode where the panel is meaningful (Off mode hides the
          // panel entirely; Auto mode users typically don't open it).
          // recordRoll is idempotent (it overwrites), but we only want to
          // create a record if no real one exists yet — otherwise we'd
          // clobber upload state on a roll the operator is mid-review on.
          if (config.filmScanRotationEnabled) {
            try {
              const frameMetadataStore = require('./frame-metadata-store');
              const existing = frameMetadataStore.getRoll(folder.name);
              if (!existing) {
                frameMetadataStore.recordRoll(folder.name, {
                  processingStatus: 'detected',
                  detectedAt: new Date().toISOString(),
                  watchPath,
                });
                emitRollUpdate(folder.name);
              }
            } catch (provErr) {
              logger.logWarning(`filmScans: failed to write provisional roll record for ${folder.name}`, { error: provErr.message });
            }
          }

          if (!this._isFolderStable(watchPath, stabilityMinutes)) {
            logger.info(`filmScans: folder not yet stable: ${folder.name}`);
            continue;
          }

          // v2 timing (2026-06-24): capture per-stage timestamps so the Film
          // Review panel can show where each roll spends its time and flag the
          // slowest stage. Purely additive — written to the roll record's
          // `timeline`; never affects the pipeline. stableAt is "now" because
          // the watchguard just passed.
          const tStableIso = new Date().toISOString();
          let tDetectedIso = null;
          let tCopiedIso   = null;
          let tRotatedIso  = null;

          // M8-3: stability passed — flip the provisional record to
          // 'processing' so the panel pill changes from Watching → Processing.
          if (config.filmScanRotationEnabled) {
            try {
              const frameMetadataStore = require('./frame-metadata-store');
              const existing = frameMetadataStore.getRoll(folder.name);
              if (existing) tDetectedIso = existing.detectedAt || null;
              if (existing && existing.processingStatus === 'detected') {
                frameMetadataStore.updateRoll(folder.name, { processingStatus: 'processing' });
                emitRollUpdate(folder.name);
              }
            } catch (procErr) {
              logger.logWarning(`filmScans: failed to mark ${folder.name} as processing`, { error: procErr.message });
            }
          }

          try {
            const dateSubfolder = this._getDateSubfolder();
            const dateStorageDir = path.join(storageFolder, dateSubfolder);
            fs.mkdirSync(dateStorageDir, { recursive: true });

            const storagePath = this._resolveStoragePath(dateStorageDir, folder.name);

            // Step 1: Copy to permanent storage
            await this._copyFolder(watchPath, storagePath);
            tCopiedIso = new Date().toISOString();
            logger.info(`filmScans: copied ${folder.name} to storage (${storagePath})`);

            // Step 2: Delete from watch folder
            this._deleteFolderRecursive(watchPath);
            logger.info(`filmScans: deleted ${folder.name} from watch folder`);

            // Step 2a.5: Film Scan AI Rotation (PW-007 Phase 1, feature-flag gated).
            // Uses ONNX EfficientNetV2-S orientation model; only rotates when confidence
            // >= threshold. Wrapped in try/catch so failures never break the pipeline.
            if (config.filmScanRotationEnabled) {
              try {
                const orientationService = require('./orientation-service');
                const frameMetadataStore = require('./frame-metadata-store');
                const sharpRot = require('sharp');

                const ready = await orientationService.init();
                if (!ready) {
                  logger.info('filmScans: orientation service not ready - skipping rotation step for this folder');
                } else {
                  const rollId    = path.basename(storagePath);
                  const threshold = typeof config.filmScanRotationConfidenceThreshold === 'number'
                    ? config.filmScanRotationConfidenceThreshold
                    : 0.9;
                  const modelVersion = orientationService.getModelVersion();

                  // Thumbnails for the Film Review panel live in OHD's userData, not
                  // in the shared storage folder — they are a display cache regenerable
                  // from the TIFFs at any time, and keeping them out of storagePath
                  // means the S3 upload step doesn't waste bandwidth on them.
                  const { app } = require('electron');
                  const thumbnailDir = path.join(app.getPath('userData'), 'thumbnails', rollId);
                  try { fs.mkdirSync(thumbnailDir, { recursive: true }); } catch (_) { /* best-effort */ }

                  // Broadened in M7 to also accept JPG inputs — most film scanner
                  // output is JPG-only (TIF rolls are the exception, paid-for by
                  // the customer). Both formats flow through the orientation pass
                  // and are eligible for AI rotation + Film Review.
                  const imageFiles = fs.readdirSync(storagePath)
                    .filter(f => {
                      const ext = path.extname(f).toLowerCase();
                      return ext === '.tif' || ext === '.tiff' || ext === '.jpg' || ext === '.jpeg';
                    })
                    .sort();

                  // M9 — Smart Check counters. Tracked across the frame loop so
                  // the per-roll uploadStatus decision below knows whether any
                  // frame had a low-confidence prediction or a rotation error.
                  // Both are operator-actionable signals: low conf may need a
                  // manual rotate, rot errors mean a file would otherwise upload
                  // un-rotated. Used only when filmScanReviewMode === 'smart'.
                  let lowConfCount = 0;
                  let rotErrorCount = 0;

                  for (let frameIndex = 0; frameIndex < imageFiles.length; frameIndex++) {
                    const imageFile = imageFiles[frameIndex];
                    const imagePath = path.join(storagePath, imageFile);
                    const frameId   = `${rollId}_${frameIndex}`;
                    const ext       = path.extname(imageFile).toLowerCase();
                    const isTiff    = ext === '.tif' || ext === '.tiff';

                    try {
                      const prediction = await orientationService.predictOrientation(imagePath);

                      let applied = false;
                      let rotationError = prediction.error;

                      if (!prediction.error
                          && prediction.predictedAngle > 0
                          && prediction.confidence >= threshold) {
                        const tmpPath = imagePath + '.rot.tmp';
                        try {
                          // Format-preserving rotation. TIF: lossless LZW + horizontal
                          // predictor (full fidelity for the customer's deliverable).
                          // JPG: q90 re-encode (lossy but typical for one-off rotations;
                          // operators rarely rotate the same JPG more than once).
                          const pipeline = sharpRot(imagePath, { limitInputPixels: false, failOn: 'none' })
                            .rotate(prediction.predictedAngle);
                          if (isTiff) {
                            await pipeline.tiff({ compression: 'lzw', predictor: 'horizontal' }).toFile(tmpPath);
                          } else {
                            await pipeline.jpeg({ quality: 90 }).toFile(tmpPath);
                          }
                          // Retry rename — Windows + SMB shares hit EPERM
                          // intermittently here because sharp/AV/explorer
                          // briefly hold a handle on the destination file.
                          await renameWithRetry(tmpPath, imagePath);
                          applied = true;
                          logger.info(`filmScans: rotated ${imageFile} by ${prediction.predictedAngle} deg (confidence ${prediction.confidence.toFixed(3)})`);
                        } catch (rotErr) {
                          rotationError = rotErr.message || String(rotErr);
                          logger.logError(`filmScans: failed to rotate ${imageFile} - leaving original`, rotErr);
                          try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* ignored */ }
                        }
                      }

                      // Thumbnail generation — runs after any rotation so the thumb
                      // reflects the final orientation. Failure does not break the
                      // pipeline; thumbnailPath is left null and the UI will fall back.
                      const thumbnailPath = path.join(thumbnailDir, `${frameId}.jpg`);
                      let thumbnailError = null;
                      try {
                        await sharpRot(imagePath, { limitInputPixels: false, failOn: 'none' })
                          .resize(512, null, { withoutEnlargement: true, fit: 'inside' })
                          .jpeg({ quality: 85 })
                          .toFile(thumbnailPath);
                      } catch (thumbErr) {
                        thumbnailError = thumbErr.message || String(thumbErr);
                        logger.logError(`filmScans: failed to generate thumbnail for ${imageFile} - continuing`, thumbErr);
                      }

                      // M9 Smart Check tally. Mirrors the UI's count buckets
                      // (frame-metadata-store.js uses the same thresholds for
                      // its lowConfidenceCount / rotationErrorCount summary).
                      // Counted here so the per-roll uploadStatus decision
                      // below can branch without re-reading the store.
                      if (rotationError) {
                        rotErrorCount += 1;
                      } else if (typeof prediction.confidence === 'number' && prediction.confidence < 0.75) {
                        lowConfCount += 1;
                      }

                      frameMetadataStore.record(frameId, {
                        rollId,
                        frameIndex,
                        fileName: imageFile,
                        originalPath: imagePath,
                        thumbnailPath: thumbnailError ? null : thumbnailPath,
                        thumbnailError,
                        rotation: {
                          applied,
                          predictedClass: prediction.predictedClass,
                          predictedAngle: prediction.predictedAngle,
                          confidence: prediction.confidence,
                          classScores: prediction.classScores,
                          confidenceThreshold: threshold,
                          modelVersion,
                          inferenceMs: prediction.inferenceMs,
                          error: rotationError,
                        },
                        operatorFlags: [],
                      });

                      if (config.filmScanRotationDebugLog) {
                        logger.info(`filmScans: frame ${frameId} -> class ${prediction.predictedClass} angle ${prediction.predictedAngle} conf ${prediction.confidence.toFixed(3)} applied=${applied}`);
                      }
                    } catch (frameErr) {
                      // Whole-pipeline failure for this frame — counts as a
                      // rotation error for Smart Check trigger purposes.
                      rotErrorCount += 1;
                      logger.logError(`filmScans: orientation pipeline failed for ${imageFile} - continuing`, frameErr);
                      try {
                        frameMetadataStore.record(frameId, {
                          rollId,
                          frameIndex,
                          fileName: imageFile,
                          originalPath: imagePath,
                          thumbnailPath: null,
                          thumbnailError: null,
                          rotation: {
                            applied: false,
                            modelVersion,
                            error: frameErr.message || String(frameErr),
                          },
                          operatorFlags: [],
                        });
                      } catch (_) { /* ignored */ }
                    }
                  }

                  // ── M4: Perfectly Clear auto-apply (Film Scans) ─────────
                  // Runs AFTER rotation/thumbnails and BEFORE the review-gate
                  // decision below. When enabled + autoApplyConfigId is set,
                  // batches the roll's storage files through one QuickServer
                  // channel via the shared perfectlyClearClient. Enhanced
                  // frames get their storage file replaced in-place (client
                  // uses temp+rename) and their thumbnail regenerated;
                  // rejected/timeout frames keep their original.
                  //
                  // Pre-enhance backups live under `{storagePath}/pre-enhance/`
                  // (first-enhancement-wins) so per-frame Revert restores the
                  // exact rotation-output that PC saw.
                  //
                  // Timeout / cancel treated as review-escalation signals so a
                  // dead QuickServer can never wedge the pipeline: the roll
                  // enters review with whatever enhanced frames landed.
                  let pcRejectedCount = 0;
                  let pcTimedOut      = false;
                  let pcEnhancedCount = 0;
                  let pcEnhanceStartedIso = null;
                  let pcEnhancedIso       = null;
                  const pcCfg = (() => {
                    const pc = config.perfectlyClear && config.perfectlyClear.filmScans;
                    if (!pc || !pc.enabled || !pc.autoApplyConfigId) return null;
                    const configs = Array.isArray(pc.configs) ? pc.configs : [];
                    return configs.find(c => c && c.id === pc.autoApplyConfigId) || null;
                  })();
                  if (pcCfg && imageFiles.length > 0) {
                    pcEnhanceStartedIso = new Date().toISOString();
                    try {
                      frameMetadataStore.updateRoll(rollId, {
                        processingStatus: 'enhancing',
                        timeline: { ...(frameMetadataStore.getRoll(rollId)?.timeline || {}), pcEnhanceStartedAt: pcEnhanceStartedIso },
                      });
                      emitRollUpdate(rollId);
                    } catch (_) { /* best-effort */ }

                    // Stage pre-enhance/ backups (first-enhancement-wins).
                    const preEnhanceDir = path.join(storagePath, 'pre-enhance');
                    try { fs.mkdirSync(preEnhanceDir, { recursive: true }); } catch (_) { /* best-effort */ }
                    const files = [];
                    for (const imageFile of imageFiles) {
                      const src = path.join(storagePath, imageFile);
                      const pre = path.join(preEnhanceDir, imageFile);
                      try {
                        if (!fs.existsSync(pre)) fs.copyFileSync(src, pre);
                      } catch (backupErr) {
                        // If we can't backup, don't send this frame — revert
                        // would be impossible. Log and skip.
                        logger.logError(`filmScans: PC pre-enhance backup failed for ${imageFile} — skipping enhancement for this frame`, backupErr);
                        continue;
                      }
                      // TIF in, TIF out — QuickServer preserves the extension,
                      // so sourcePath == destPath == storage file.
                      files.push({ sourcePath: src, destPath: src });
                    }

                    if (files.length === 0) {
                      // Nothing stageable → skip enhancement entirely.
                      try {
                        frameMetadataStore.updateRoll(rollId, { processingStatus: null });
                        emitRollUpdate(rollId);
                      } catch (_) { /* best-effort */ }
                    } else {
                      // 2026-07-23 — timeout is configurable. When
                      // `perfectlyClearFilmScanTimeoutMs` is a positive
                      // number, use it verbatim; otherwise fall back to
                      // the M4 derived formula max(5 min, 30 s × frames).
                      // Same for per-op cap — configurable, defaults to
                      // the client's DEFAULT_PER_OP_TIMEOUT_MS. A
                      // legitimately slow but working QuickServer can
                      // raise the ceiling; the point is that it can never
                      // hang forever, not that it must be short.
                      const cfgTimeoutMs = Number(config.perfectlyClearFilmScanTimeoutMs);
                      const timeoutMs    = Number.isFinite(cfgTimeoutMs) && cfgTimeoutMs > 0
                        ? cfgTimeoutMs
                        : Math.max(5 * 60 * 1000, 30 * 1000 * files.length);
                      const cfgPerOpMs   = Number(config.perfectlyClearFilmScanPerOpTimeoutMs);
                      const perOpTimeoutMs = Number.isFinite(cfgPerOpMs) && cfgPerOpMs > 0
                        ? cfgPerOpMs
                        : undefined; // client picks its default
                      logger.info(`filmScans: ${rollId} PC enhance starting (config="${pcCfg.friendlyName}", files=${files.length}, timeoutMs=${timeoutMs}${perOpTimeoutMs ? `, perOpMs=${perOpTimeoutMs}` : ''})`);

                      // 2026-07-23 — register this batch so a startup
                      // sweep or an operator "Reset enhancement" IPC can
                      // abort it via signal rather than clobbering a
                      // genuine in-flight enhance. Cleared in finally
                      // regardless of outcome (throw, success, cancel).
                      const abortController = new AbortController();
                      this._activeFilmScanBatch = {
                        rollId,
                        abortController,
                        startedAt: Date.now(),
                      };

                      let pcResults = [];
                      try {
                        const perfectlyClearClient = require('../enhancement/perfectlyClearClient');
                        pcResults = await perfectlyClearClient.processBatch({
                          config: pcCfg,
                          files,
                          timeoutMs,
                          perOpTimeoutMs,
                          signal: abortController.signal,
                        });
                      } catch (pcErr) {
                        // Client-level throw — treat every file as errored so
                        // we still fall through to review gate + defer.
                        logger.logError(`filmScans: PC processBatch threw for ${rollId} — continuing with originals`, pcErr);
                        pcResults = files.map(f => ({ sourcePath: f.sourcePath, destPath: f.destPath, status: 'timeout', error: pcErr.message }));
                        pcTimedOut = true;
                      } finally {
                        // Clear registry BEFORE the per-file loop below so a
                        // concurrent reset for this roll (edge case) sees
                        // "not live" and takes the phantom-cleanup path.
                        if (this._activeFilmScanBatch && this._activeFilmScanBatch.rollId === rollId) {
                          this._activeFilmScanBatch = null;
                        }
                      }

                      // Per-file: enhanced → regen thumbnail + stamp metadata;
                      // rejected/timeout → keep original + stamp pcRejected.
                      const sharpForPc = require('sharp');
                      for (const r of pcResults) {
                        const imageFile = path.basename(r.sourcePath);
                        const frameIdx  = imageFiles.indexOf(imageFile);
                        if (frameIdx < 0) continue;
                        const frameId = `${rollId}_${frameIdx}`;
                        if (r.status === 'enhanced') {
                          pcEnhancedCount += 1;
                          const rec = frameMetadataStore.get(frameId);
                          if (rec && rec.thumbnailPath) {
                            try {
                              await sharpForPc(r.destPath, { limitInputPixels: false, failOn: 'none' })
                                .resize(512, null, { withoutEnlargement: true, fit: 'inside' })
                                .jpeg({ quality: 85 })
                                .toFile(rec.thumbnailPath);
                            } catch (thumbErr) {
                              logger.logError(`filmScans: PC thumbnail regen failed for ${imageFile}`, thumbErr);
                            }
                          }
                          frameMetadataStore.update(frameId, {
                            pcEnhanced:     true,
                            pcConfigName:   pcCfg.friendlyName || null,
                            pcConfigId:     pcCfg.id,
                            pcEnhancedAt:   new Date().toISOString(),
                            pcRejected:     false,
                            pcRejectReason: null,
                          });
                        } else {
                          pcRejectedCount += 1;
                          if (r.status === 'timeout' || r.status === 'cancelled') pcTimedOut = true;
                          frameMetadataStore.update(frameId, {
                            pcEnhanced:     false,
                            pcRejected:     true,
                            pcRejectReason: r.status,
                            pcRejectError:  r.error || null,
                          });
                          // Per-frame operator-readable line so a mixed
                          // batch is diagnosable from the Activity Log
                          // without opening Film Review. The summary line
                          // below still gives the aggregate counts.
                          logger.logWarning(
                            `filmScans: ${rollId} PC ${r.status} for ${imageFile} — kept original` +
                            (r.error ? ` (${r.error})` : '')
                          );
                        }
                      }

                      pcEnhancedIso = new Date().toISOString();
                      try {
                        // Clear 'enhancing' immediately so the UI reflects the
                        // batch end even before recordRoll below writes the
                        // full record. recordRoll is a full-replace, so the
                        // pcEnhancedAt stamp itself is added into the timeline
                        // block passed to recordRoll (a few lines further down).
                        frameMetadataStore.updateRoll(rollId, {
                          processingStatus: null,
                          timeline: { ...(frameMetadataStore.getRoll(rollId)?.timeline || {}), pcEnhancedAt: pcEnhancedIso },
                        });
                        emitRollUpdate(rollId);
                      } catch (_) { /* best-effort */ }
                      logger.info(`filmScans: ${rollId} PC enhance complete — enhanced=${pcEnhancedCount}, rejected=${pcRejectedCount}, timedOut=${pcTimedOut}`);
                      if (pcTimedOut) {
                        logger.logWarning(`filmScans: ${rollId} PC timeout/cancel — escalating to review regardless of review mode`);
                      }
                      // 2026-07-23 — when the whole batch produced ZERO
                      // enhanced results and at least one file was sent,
                      // that's a strong signal that QuickServer isn't
                      // watching this input folder, isn't running, or is
                      // configured for a different channel. Naming the
                      // folder in the log gives the operator (or Claude
                      // in a next session) an actionable diagnostic
                      // without needing to open PC's own logs.
                      if (pcEnhancedCount === 0 && files.length > 0) {
                        logger.logWarning(
                          `filmScans: ${rollId} PC batch produced zero enhanced frames ` +
                          `(files=${files.length}, rejected=${pcRejectedCount}). ` +
                          `Check QuickServer is watching "${pcCfg.inputFolder}" and hasn't stalled or misrouted this channel.`
                        );
                      }
                    }
                  }

                  // M7: write a roll-level record so the Film Review panel and
                  // the deferred-upload IPC have the upload context they need.
                  //
                  // M9: review mode is now tri-state (filmScanReviewMode):
                  //   'always' — every roll starts 'pending' (Manual).
                  //   'smart'  — pending only if any frame is low-confidence or
                  //              had a rotation error; otherwise upload as in
                  //              Auto. Confident rolls fall through.
                  //   'never'  — Auto: uploadStatus left unset; Step 3 below
                  //              stamps 'uploaded'/'failed'.
                  //
                  // M4: PC additions — pcTimedOut forces review escalation
                  // regardless of mode (dead QuickServer can never wedge the
                  // pipeline); pcRejectedCount participates in Smart Check
                  // like lowConfCount / rotErrorCount so mixed batches surface
                  // to the operator.
                  //
                  // M8-3: the provisional record (created at detection) was
                  // keyed by folder.name (the watch-folder basename). The real
                  // rollId is path.basename(storagePath) — usually identical,
                  // but _resolveStoragePath may append `_1` if the date folder
                  // already had a same-named roll. recordRoll() overwrites the
                  // record at `rollId`; if `rollId !== folder.name` we delete
                  // the provisional one so it doesn't linger as a ghost
                  // "processing" card forever.
                  const reviewMode = config.filmScanReviewMode || 'never';
                  const smartTriggered = reviewMode === 'smart' && (lowConfCount > 0 || rotErrorCount > 0 || pcRejectedCount > 0);
                  // Film Development Auto Assignment (M3) — two-gate model.
                  // Gate A (reviewPassed): trivially true when the review mode
                  // wouldn't have held the roll AND PC didn't time out; false
                  // when the roll would otherwise be held for operator review.
                  // Gate B (matchedJobId): filled in later by the matcher.
                  // A roll defers at Step 3 when EITHER gate is still open —
                  // review hold or auto-assign hold. Both gates must pass
                  // before upload fires.
                  const reviewHold  = reviewMode === 'always' || smartTriggered || pcTimedOut;
                  const autoAssignOn = Boolean(config.filmScanAutoAssignEnabled);
                  const deferUpload = reviewHold || autoAssignOn;
                  const reviewPassed = !reviewHold;
                  if (reviewMode === 'smart') {
                    logger.info(
                      `filmScans: ${rollId} smart-check — lowConf=${lowConfCount} rotErr=${rotErrorCount} pcRej=${pcRejectedCount} → ${deferUpload ? 'pending review' : 'auto upload'}`
                    );
                  }
                  // Rotation + thumbnail pass complete — stamp it for the timeline.
                  tRotatedIso = new Date().toISOString();
                  try {
                    frameMetadataStore.recordRoll(rollId, {
                      storagePath,
                      locationId,
                      s3Prefix,
                      uploadStatus: deferUpload ? 'pending' : undefined,
                      uploadError: null,
                      uploadedAt: null,
                      processingStatus: null,
                      // M3: two-gate stamps. Only present when auto-assign
                      // is enabled — feature-off installs never see them,
                      // preserving byte-for-byte behaviour for legacy
                      // deployments. Gate A (reviewPassed) is set from the
                      // review-hold branch above; Gate B (matchedJobId)
                      // starts null and is filled in by the matcher.
                      ...(autoAssignOn ? {
                        awaitingAssignment: true,
                        reviewPassed,
                        matchedJobId:       null,
                        matchedJobNumber:   null,
                        matchedOrderId:     null,
                        matchedOrderNumber: null,
                        matchedTwinCheck:   null,
                        matchedAt:          null,
                      } : {}),
                      timeline: {
                        detectedAt: tDetectedIso,
                        stableAt:   tStableIso,
                        copiedAt:   tCopiedIso,
                        rotatedAt:  tRotatedIso,
                        // M4: PC stamps only present when PC ran on this roll.
                        // recordRoll is a full-replace, so we must fold them
                        // into the same timeline object rather than relying on
                        // the earlier updateRoll's write to survive.
                        ...(pcEnhanceStartedIso ? { pcEnhanceStartedAt: pcEnhanceStartedIso } : {}),
                        ...(pcEnhancedIso       ? { pcEnhancedAt:       pcEnhancedIso       } : {}),
                      },
                    });
                    if (rollId !== folder.name) {
                      frameMetadataStore.deleteRoll(folder.name);
                    }
                  } catch (rollErr) {
                    logger.logError(`filmScans: failed to write roll record for ${rollId}`, rollErr);
                  }

                  // Notify the Film Review panel that a new roll has landed.
                  // Emitting after the rotation+thumbnail loop (not after S3 upload)
                  // so the UI can show the roll as soon as frame metadata exists —
                  // the S3 step is orthogonal to review. Best-effort: if no window
                  // is open the event simply has no listener.
                  try {
                    const { BrowserWindow } = require('electron');
                    const wins = BrowserWindow.getAllWindows();
                    for (const w of wins) {
                      if (w && !w.isDestroyed()) {
                        w.webContents.send('ohd:filmReview:roll-processed', { rollId });
                      }
                    }
                  } catch (emitErr) {
                    logger.logWarning('filmScans: failed to emit roll-processed event', { error: emitErr.message });
                  }
                }
              } catch (outerErr) {
                logger.logError('filmScans: rotation step failed outright - continuing without rotation', outerErr);
              }
            }

            // Step 2b: Convert any TIFF files in storage to JPEG (quality 90).
            {
              const sharp = require('sharp');
              const tiffFiles = fs.readdirSync(storagePath).filter(f => {
                const ext = path.extname(f).toLowerCase();
                return ext === '.tif' || ext === '.tiff';
              });
              const convRollId  = path.basename(storagePath);
              // TIFF→JPEG is the heaviest non-upload step and only happens on
              // TIFF rolls. Surface it as a distinct live phase ("Converting…"
              // on the card) and time it on its own so the "TIFF→JPEG" stat
              // measures just this work. Only meaningful when rotation is on
              // (that's when a roll record exists); JPEG-only rolls skip it.
              const trackConvert = config.filmScanRotationEnabled && tiffFiles.length > 0;

              if (trackConvert) {
                try {
                  const fms = require('./frame-metadata-store');
                  const rec = fms.getRoll(convRollId);
                  fms.updateRoll(convRollId, {
                    processingStatus: 'converting',
                    timeline: { ...((rec && rec.timeline) || {}), convertStartedAt: new Date().toISOString() },
                  });
                  emitRollUpdate(convRollId);
                } catch (_) { /* best-effort */ }
              }

              for (const tiffFile of tiffFiles) {
                const srcPath  = path.join(storagePath, tiffFile);
                const jpgFile  = path.basename(tiffFile, path.extname(tiffFile)) + '.jpg';
                const destPath = path.join(storagePath, jpgFile);
                try {
                  // Match the rotation/thumbnail steps' lenient options:
                  // failOn:'none' tolerates the libvips warnings that big,
                  // layered, touched-up TIFFs trigger (which the strict default
                  // turns fatal), and limitInputPixels:false allows very large
                  // scans past sharp's ~268MP guard. Without these, big/layered
                  // TIFFs failed to convert and uploaded with no JPEG.
                  await sharp(srcPath, { limitInputPixels: false, failOn: 'none' })
                    .jpeg({ quality: 90 })
                    .toFile(destPath);
                  logger.info(`filmScans: converted ${tiffFile} -> ${jpgFile}`);
                } catch (convErr) {
                  logger.logError(`filmScans: failed to convert ${tiffFile} to JPEG - skipping`, convErr);
                }
              }

              if (trackConvert) {
                try {
                  const fms = require('./frame-metadata-store');
                  const rec = fms.getRoll(convRollId);
                  fms.updateRoll(convRollId, {
                    processingStatus: null,
                    timeline: { ...((rec && rec.timeline) || {}), convertedAt: new Date().toISOString() },
                  });
                  emitRollUpdate(convRollId);
                } catch (_) { /* best-effort */ }
              }
            }

            // Step 3: Upload from storage to S3.
            //
            // M7+M9: skip this step when the roll has been deferred for review.
            // 'always' mode defers every roll; 'smart' mode defers only rolls
            // with at least one low-conf or rotation-error frame; 'never' (and
            // Off mode, where AI is disabled and no roll record exists) always
            // uploads here. The decision was made above when writing the roll
            // record — re-derive it here so this branch can also handle the AI-
            // off case (no `deferUpload` in scope unless rotation ran).
            //
            // M3 (Film Development Auto Assignment): when auto-assign is on,
            // every roll defers at Step 3 regardless of review mode — the
            // matcher (Gate B) or a subsequent operator approval (Gate A)
            // will trigger the actual upload via _uploadRollFromStorage.
            // With rotation OFF there is no roll record yet, so we write a
            // minimal one here so the matcher can find it in listRollsWithSummary.
            // Legacy paths (auto-assign off) are unchanged byte-for-byte.
            let shouldDefer = false;
            const autoAssignOnStep3 = Boolean(config.filmScanAutoAssignEnabled);
            if (config.filmScanRotationEnabled) {
              const rm = config.filmScanReviewMode || 'never';
              if (rm === 'always') {
                shouldDefer = true;
              } else if (rm === 'smart') {
                // Re-read the roll record we just wrote — its uploadStatus
                // reflects the smart decision (pending vs undefined). If the
                // recordRoll write failed for any reason we fall through to
                // upload (fail-open, since the file would be lost otherwise).
                try {
                  const rec = require('./frame-metadata-store').getRoll(path.basename(storagePath));
                  shouldDefer = !!(rec && rec.uploadStatus === 'pending');
                } catch (_) { /* fail-open */ }
              }
              // Auto-assign forces defer even when the review mode wouldn't —
              // Gate B has to pass before we upload.
              if (autoAssignOnStep3) shouldDefer = true;
            } else if (autoAssignOnStep3) {
              // Rotation-off + auto-assign-on: no roll record exists yet.
              // Write a minimal one so the matcher can enumerate this roll
              // via listRollsWithSummary + trigger _uploadRollFromStorage
              // on match. There is no review surface here, so Gate A
              // (reviewPassed) is trivially true.
              const rollId = path.basename(storagePath);
              try {
                require('./frame-metadata-store').recordRoll(rollId, {
                  storagePath,
                  locationId,
                  s3Prefix,
                  uploadStatus:       'pending',
                  uploadError:        null,
                  uploadedAt:         null,
                  processingStatus:   null,
                  awaitingAssignment: true,
                  reviewPassed:       true,
                  matchedJobId:       null,
                  matchedJobNumber:   null,
                  matchedOrderId:     null,
                  matchedOrderNumber: null,
                  matchedTwinCheck:   null,
                  matchedAt:          null,
                  timeline: { detectedAt: tDetectedIso, stableAt: tStableIso, copiedAt: tCopiedIso },
                });
              } catch (recErr) {
                logger.logError(`filmScans: failed to write minimal roll record for auto-assign hold ${rollId}`, recErr);
              }
              // Nudge the Film Review panel so the held-for-match roll
              // appears immediately rather than after the next scan tick.
              this._emitFilmReviewRoll(rollId);
              shouldDefer = true;
            }

            if (shouldDefer) {
              logger.info(`filmScans: ${folder.name} held for review (upload deferred)`);
              summary.processed++;
            } else {
              const s3Config = this._buildS3Config(config, locationId);
              if (s3Config) {
                // M9.1: Auto-retry the upload on transient failure. The
                // operator never sees Auto / Smart-confident rolls until
                // they fail, so a one-shot S3 blip would otherwise dump a
                // perfectly fine roll into the Ready filter for a manual
                // retry it didn't really warrant. Three attempts with a
                // 30s → 90s backoff covers the common case (network
                // hiccup, brief throttling) without burning operator time.
                // Stamp 'uploading' up-front so the panel shows the live
                // state during the (potentially multi-minute) retry chain.
                const rollId = path.basename(storagePath);
                if (config.filmScanRotationEnabled) {
                  try {
                    const frameMetadataStore = require('./frame-metadata-store');
                    const _rec = frameMetadataStore.getRoll(rollId);
                    frameMetadataStore.updateRoll(rollId, {
                      uploadStatus: 'uploading',
                      uploadError: null,
                      timeline: { ...((_rec && _rec.timeline) || {}), uploadStartedAt: new Date().toISOString() },
                    });
                  } catch (_) { /* best-effort */ }
                  try {
                    const { BrowserWindow } = require('electron');
                    for (const w of BrowserWindow.getAllWindows()) {
                      if (w && !w.isDestroyed()) {
                        w.webContents.send('ohd:filmReview:roll-processed', { rollId });
                      }
                    }
                  } catch (_) { /* best-effort */ }
                }

                const MAX_ATTEMPTS = 3;
                const BACKOFFS_MS = [30_000, 90_000]; // gap between attempts
                let result;
                let attempt = 0;
                const manifestExtra = this._buildFilmScanManifestExtra(rollId);
                while (attempt < MAX_ATTEMPTS) {
                  attempt += 1;
                  try {
                    result = await s3Service.uploadFolder(storagePath, s3Prefix, s3Config, (progress) => {
                      logger.info(`filmScans: ${progress.message}`);
                    }, manifestExtra);
                  } catch (uploadError) {
                    const totalFiles = require('fs').readdirSync(storagePath).length;
                    logger.logError(`filmScans: uploadFolder threw unexpectedly for ${folder.name} (attempt ${attempt}/${MAX_ATTEMPTS})`, uploadError);
                    result = { uploaded: 0, failed: totalFiles, total: totalFiles };
                  }
                  if (result.failed === 0) break;
                  if (attempt < MAX_ATTEMPTS) {
                    const wait = BACKOFFS_MS[attempt - 1];
                    logger.logWarning(`filmScans: ${folder.name} upload attempt ${attempt}/${MAX_ATTEMPTS} had ${result.failed} failure(s), retrying in ${wait / 1000}s`);
                    await new Promise(r => setTimeout(r, wait));
                  }
                }

                if (result.failed > 0) {
                  const msg = `S3 upload incomplete for ${folder.name}: ${result.uploaded}/${result.total} uploaded, ${result.failed} file(s) failed after ${attempt}/${MAX_ATTEMPTS} attempts`;
                  logger.logWarning(`filmScans: ${msg}`, result);
                  summary.failed++;
                  summary.errors.push(msg);
                  // Stamp the roll record so the panel can hide it (Auto mode)
                  // or let the operator retry. Best-effort only — no roll
                  // record exists in Off mode (no AI rotation = no metadata).
                  if (config.filmScanRotationEnabled) {
                    try {
                      const frameMetadataStore = require('./frame-metadata-store');
                      frameMetadataStore.updateRoll(rollId, {
                        uploadStatus: 'failed',
                        uploadError: msg,
                      });
                    } catch (_) { /* best-effort */ }
                    // Refresh the panel so the card flips to "Upload failed"
                    // without operator navigation.
                    try {
                      const { BrowserWindow } = require('electron');
                      const wins = BrowserWindow.getAllWindows();
                      for (const w of wins) {
                        if (w && !w.isDestroyed()) {
                          w.webContents.send('ohd:filmReview:roll-processed', { rollId });
                        }
                      }
                    } catch (emitErr) {
                      logger.logWarning('filmScans: failed to emit roll-processed event after upload failure', { error: emitErr.message });
                    }
                  }
                } else {
                  logger.info(`filmScans: S3 upload complete for ${folder.name} (attempt ${attempt}/${MAX_ATTEMPTS})`, result);
                  summary.processed++;
                  if (config.filmScanRotationEnabled) {
                    try {
                      const frameMetadataStore = require('./frame-metadata-store');
                      const _rec = frameMetadataStore.getRoll(rollId);
                      const _now = new Date().toISOString();
                      frameMetadataStore.updateRoll(rollId, {
                        uploadStatus: 'uploaded',
                        uploadError: null,
                        uploadedAt: _now,
                        timeline: { ...((_rec && _rec.timeline) || {}), uploadedAt: _now },
                      });
                      // M9: Auto and Smart-confident rolls bypass the operator
                      // panel entirely. Once the auto-upload succeeds the roll
                      // is, by definition, "done" — flip every frame to
                      // reviewed so the existing status filter naturally hides
                      // it from "Ready to review". Mirrors the same call the
                      // approve-roll IPC makes for Manual mode.
                      try {
                        frameMetadataStore.markRollReviewed(rollId);
                      } catch (markErr) {
                        logger.logWarning(`filmScans: ${rollId} markRollReviewed failed (non-fatal)`, { error: markErr.message });
                      }
                    } catch (_) { /* best-effort */ }
                    // Nudge the renderer so the rolls list refreshes — the
                    // card should disappear from Ready and reappear under
                    // Reviewed/Uploaded without manual navigation.
                    try {
                      const { BrowserWindow } = require('electron');
                      const wins = BrowserWindow.getAllWindows();
                      for (const w of wins) {
                        if (w && !w.isDestroyed()) {
                          w.webContents.send('ohd:filmReview:roll-processed', { rollId });
                        }
                      }
                    } catch (emitErr) {
                      logger.logWarning('filmScans: failed to emit roll-processed event after upload', { error: emitErr.message });
                    }
                  }
                }
              } else {
                summary.processed++;
              }
            }
          } catch (error) {
            summary.failed++;
            summary.errors.push(`${folder.name}: ${error.message}`);
            logger.logError(`filmScans: error processing ${folder.name}`, error);

            // M8-3: don't leave the provisional "processing" record stuck if
            // the outer block threw before the AI rotation step had a chance
            // to write the real roll record. Best-effort cleanup.
            if (config.filmScanRotationEnabled) {
              try {
                const frameMetadataStore = require('./frame-metadata-store');
                const stillProvisional = frameMetadataStore.getRoll(folder.name);
                if (stillProvisional && stillProvisional.processingStatus) {
                  frameMetadataStore.deleteRoll(folder.name);
                  emitRollUpdate(folder.name);
                }
              } catch (_) { /* best-effort */ }
            }
          }

          // Throughput fix (2026-06-24): this loop previously `break`-ed here,
          // processing only ONE stable roll per cycle. With the film-scans
          // timer at filmScansAutoSyncMinutes (default 5 min), a batch of scans
          // drained at ~1 roll / 5 min, so a day's scanning backed up for
          // hours. We now process EVERY stable folder in this cycle's snapshot.
          // Safe because: unstable folders still `continue` (retried next
          // cycle); the per-roll try/catch above isolates failures so one bad
          // roll can't halt the rest; the readdir snapshot is taken once at
          // cycle start so the loop is bounded (folders arriving mid-cycle are
          // picked up next tick); and the _filmScanProcessing guard prevents
          // overlapping cycles.
        }
      } catch (error) {
        logger.logError('filmScans: error scanning watch folder', error);
      }

      // M4: run one film-scan auto-assign match cycle after every
      // _processFilmScans pass. A roll may have just landed in the held
      // state (awaitingAssignment:true) this cycle and the matcher wants
      // to catch it immediately rather than wait for the next poll. Safe
      // when the feature is off (matcher no-ops on the config flag), and
      // safe if the matcher itself throws (it catches internally).
      try {
        const filmScanAutoAssign = require('./film-scan-auto-assign');
        await filmScanAutoAssign.runMatchCycle(config, logger);
      } catch (matcherErr) {
        logger.logError('filmScans: auto-assign match cycle threw', matcherErr);
      }

      return summary;
    } finally {
      this._filmScanProcessing = false;
    }
  }

  async _processFileUploads(config) {
    const summary = { processed: 0, skipped: 0, failed: 0, errors: [] };
    const watchFolder = config.fileUploadsWatchFolder;
    const storageFolder = config.fileUploadsStorageFolder;
    const stabilityMinutes = config.fileUploadsWatchguardMinutes || config.fileStabilityMinutes;

    if (!watchFolder || !fs.existsSync(watchFolder)) {
      logger.logWarning(`fileUploads: watch folder not configured or missing: ${watchFolder}`);
      return summary;
    }

    if (!storageFolder) {
      logger.logWarning('fileUploads: storage folder not configured');
      return summary;
    }

    const s3Prefix = 'file-uploads/';

    try {
      const entries = fs.readdirSync(watchFolder, { withFileTypes: true });
      const folders = entries.filter((e) => e.isDirectory());

      for (const folder of folders) {
        const watchPath = path.join(watchFolder, folder.name);

        if (!this._isFolderStable(watchPath, stabilityMinutes)) {
          logger.info(`fileUploads: folder not yet stable: ${folder.name}`);
          continue;
        }

        try {
          const storagePath = path.join(storageFolder, folder.name);

          await this._copyFolder(watchPath, storagePath);
          logger.info(`fileUploads: copied ${folder.name} to storage`);

          this._deleteFolderRecursive(watchPath);
          logger.info(`fileUploads: deleted ${folder.name} from watch folder`);

          // ── M5: Perfectly Clear auto-apply (File Uploads) ───────
          // Runs AFTER stability + copy-to-storage and BEFORE S3
          // upload. Enabled + autoApplyConfigId → batch every image
          // in the storage folder through one QuickServer channel
          // via the shared perfectlyClearClient. Enhanced files
          // replace their storage bytes in-place (client uses
          // temp+rename); rejected/timeout files keep their originals
          // and warn to Activity Log — there is no review surface,
          // so the policy is "upload what QuickServer returns".
          // Disabled scope (or no autoApplyConfigId) is a strict
          // no-op — the storage folder is untouched. A dead
          // QuickServer must NEVER wedge the file-uploads pipeline,
          // so the wall-clock timeout is max(5 min, 30 s × count)
          // and any client-level throw falls back to originals.
          await this._runFileUploadsPerfectlyClear(folder.name, storagePath, config);

          const s3Config = this._buildS3Config(config, null);
          if (s3Config) {
            const result = await s3Service.uploadFolder(storagePath, s3Prefix, s3Config, (progress) => {
              logger.info(`fileUploads: ${progress.message}`);
            });

            if (result.failed > 0) {
              const msg = `S3 upload incomplete for ${folder.name}: ${result.uploaded}/${result.total} uploaded, ${result.failed} file(s) had no pre-signed URL and were skipped`;
              logger.logWarning(`fileUploads: ${msg}`, result);
              summary.failed++;
              summary.errors.push(msg);
            } else {
              logger.info(`fileUploads: S3 upload complete for ${folder.name}`, result);
              summary.processed++;
            }
          } else {
            summary.processed++;
          }
        } catch (error) {
          summary.failed++;
          summary.errors.push(`${folder.name}: ${error.message}`);
          logger.logError(`fileUploads: error processing ${folder.name}`, error);
        }
      }
    } catch (error) {
      logger.logError('fileUploads: error scanning watch folder', error);
    }

    return summary;
  }

  /**
   * M5: File Uploads Perfectly Clear auto-apply step. Extracted from the
   * per-folder loop above so the disabled-scope no-op is a plain early
   * return and the batch/reject/timeout accounting has room to breathe.
   *
   * Contract:
   *   - Disabled scope OR no autoApplyConfigId OR no matching config
   *     → return without touching storage. Strict no-op.
   *   - Enhanced files: bytes replaced in-place by the client
   *     (temp+rename). Rejected / timeout / cancelled files: original
   *     bytes untouched, per-file warning to Activity Log.
   *   - Client-level throw: fall back to originals for every file,
   *     log an error, and RESOLVE (do NOT rethrow) — the outer
   *     per-folder try/catch below must still reach the S3 upload
   *     step. A dead QuickServer can never wedge this pipeline.
   *
   * Duplicate basenames within one storage folder (possible when the
   * user drops a nested structure with same-named files in different
   * subdirs) cannot round-trip through a single flat batch subfolder,
   * so we deduplicate: first-occurrence wins, later duplicates upload
   * as originals with a warning. Rare in practice for file uploads.
   */
  async _runFileUploadsPerfectlyClear(folderName, storagePath, config) {
    const pc = config.perfectlyClear && config.perfectlyClear.fileUploads;
    if (!pc || !pc.enabled || !pc.autoApplyConfigId) return;
    const configs = Array.isArray(pc.configs) ? pc.configs : [];
    const pcCfg = configs.find(c => c && c.id === pc.autoApplyConfigId) || null;
    if (!pcCfg) return;

    // Recursively enumerate image files under the storage folder.
    // File uploads can include subdirs (s3-service walks recursively at
    // upload time), so we mirror that here rather than only top-level
    // files. QuickServer channel formats supported: JPEG, PNG, TIFF.
    const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);
    const walk = (dir, out) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return out;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, out);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (IMAGE_EXTS.has(ext)) out.push(full);
        }
      }
      return out;
    };
    const imagePaths = walk(storagePath, []);
    if (imagePaths.length === 0) return;

    // Deduplicate by basename — perfectlyClearClient throws if a batch
    // contains two files with the same basename (its batch subfolder is
    // flat under Input). First occurrence enhances; later duplicates
    // upload as originals with a warning.
    const seen = new Set();
    const files = [];
    for (const p of imagePaths) {
      const base = path.basename(p);
      if (seen.has(base)) {
        logger.logWarning(
          `fileUploads: ${folderName} PC — duplicate basename '${base}' in a subfolder — uploading this copy as original`
        );
        continue;
      }
      seen.add(base);
      files.push({ sourcePath: p, destPath: p });
    }
    if (files.length === 0) return;

    // Wall-clock timeout: mirror M4's formula. The floor covers a
    // single-file batch (QuickServer startup latency) and the linear
    // term covers larger drops without blowing past a reasonable ceiling.
    const timeoutMs = Math.max(5 * 60 * 1000, 30 * 1000 * files.length);
    logger.info(
      `fileUploads: ${folderName} PC enhance starting ` +
      `(config="${pcCfg.friendlyName}", files=${files.length}, timeoutMs=${timeoutMs})`
    );

    let pcResults = [];
    try {
      const perfectlyClearClient = require('../enhancement/perfectlyClearClient');
      pcResults = await perfectlyClearClient.processBatch({
        config: pcCfg,
        files,
        timeoutMs,
      });
    } catch (pcErr) {
      // A client-level throw is a systemic failure (bad config, staging
      // I/O error, etc.). Fall back to originals for every file so the
      // outer S3 upload step still runs; the pipeline must never wedge.
      logger.logError(
        `fileUploads: ${folderName} PC processBatch threw — continuing with originals`,
        pcErr
      );
      logger.logWarning(
        `fileUploads: ${folderName} PC unavailable — uploading ${files.length} file(s) as originals`
      );
      return;
    }

    let enhCount = 0;
    let rejCount = 0;
    let toCount = 0;
    for (const r of pcResults) {
      const base = path.basename(r.sourcePath);
      if (r.status === 'enhanced') {
        enhCount++;
      } else if (r.status === 'timeout' || r.status === 'cancelled') {
        toCount++;
        logger.logWarning(
          `fileUploads: ${folderName} PC ${r.status} for ${base} — uploading original`
        );
      } else {
        rejCount++;
        logger.logWarning(
          `fileUploads: ${folderName} PC rejected ${base} — uploading original` +
          (r.error ? ` (${r.error})` : '')
        );
      }
    }
    logger.info(
      `fileUploads: ${folderName} PC enhance complete — ` +
      `enhanced=${enhCount}, rejected=${rejCount}, timeout=${toCount}`
    );
  }

  /**
   * Build the film-scan completion-manifest extras from a roll record. When
   * auto-assign has stamped a match on the roll (matchedJobId set), return an
   * object of snake_case keys the s3-service will shallow-merge into the
   * manifest JSON so OrderHub can record the upload against the correct job
   * and twin check. When there's no match, return null so the manifest stays
   * byte-identical to the pre-feature format.
   */
  _buildFilmScanManifestExtra(rollId) {
    try {
      const frameMetadataStore = require('./frame-metadata-store');
      const rec = frameMetadataStore.getRoll(rollId);
      if (!rec || !rec.matchedJobId) return null;
      return {
        twin_check:    rec.matchedTwinCheck,
        job_id:        rec.matchedJobId,
        job_number:    rec.matchedJobNumber,
        order_id:      rec.matchedOrderId,
        order_number:  rec.matchedOrderNumber,
        matched_at:    rec.matchedAt,
        auto_assigned: true,
      };
    } catch (_) {
      return null;
    }
  }

  // Best-effort emit of the Film Review roll-processed event (class-level twin
  // of the per-cycle emitRollUpdate closure, for use outside _processFilmScans).
  _emitFilmReviewRoll(rollId) {
    try {
      const { BrowserWindow } = require('electron');
      for (const w of BrowserWindow.getAllWindows()) {
        if (w && !w.isDestroyed()) w.webContents.send('ohd:filmReview:roll-processed', { rollId });
      }
    } catch (_) { /* best-effort */ }
  }

  // ── PC enhancement recovery (2026-07-23) ───────────────────────────────
  //
  // Two lab-safety mechanisms so a Perfectly Clear enhance can never
  // permanently wedge a roll at processingStatus:'enhancing':
  //
  //   sweepStaleEnhancingRolls()  — runs once at startup. Every roll in
  //     'enhancing' at boot time is by definition NOT backed by a live
  //     in-process batch (this process just started). Belt-and-braces
  //     guard: only clear entries whose pcEnhanceStartedAt is stale
  //     against the configured PC timeout (or missing entirely), so a
  //     hypothetical second OHD instance racing against a shared
  //     electron-store can't clobber a genuinely-live enhance from that
  //     other process.
  //
  //   resetEnhancingRoll(rollId)  — operator-triggered from the Film
  //     Scans UI ("Reset enhancement" button on an enhancing roll).
  //     Aborts a live in-flight batch via AbortController; the client's
  //     cancel path falls back into the existing pcTimedOut branch and
  //     the roll escalates to review naturally. When the roll is stuck
  //     at 'enhancing' but no live batch is registered (phantom state,
  //     e.g. a sweep raced ahead), does the same cleanup as the sweep.
  //
  // Both converge on the same recovered-roll state:
  //   - processingStatus: null (badge stops showing "Enhancing")
  //   - uploadStatus: 'pending' when the roll record has a storagePath,
  //     'failed' with an explanatory error otherwise (crash pre-recordRoll:
  //     the S3 metadata is missing so no automatic upload is possible).
  //   - timeline: { ...prev, pcRecoveredAt, pcRecoveredReason }
  // Either way the roll ends up visible in Film Review, and 'pending'
  // guarantees no silent auto-upload can ever fire on a recovered roll —
  // matching the existing pcTimedOut-escalates-regardless-of-mode rule.

  /**
   * On startup, sweep frameMetadataStore.rolls for any roll left in
   * processingStatus:'enhancing' that (a) is not backed by a live
   * in-process batch (always the case at startup — the registry was
   * just constructed empty) and (b) has a stale-or-missing
   * pcEnhanceStartedAt timestamp. Each qualifying roll is cleared and
   * escalated to review. Best-effort — never throws.
   *
   * @param {object} [options]
   * @param {number} [options.now]  now-ms override (tests)
   * @returns {Promise<{swept: string[], skipped: string[]}>}
   */
  async sweepStaleEnhancingRolls({ now } = {}) {
    const frameMetadataStore = require('./frame-metadata-store');
    const nowMs = Number.isFinite(now) ? now : Date.now();
    const swept   = [];
    const skipped = [];

    let rollsMap;
    try {
      // No listRolls-with-processingStatus API; read the raw dict off the
      // underlying store. Legacy stores (pre-M4) have no processingStatus
      // key on any roll so the filter yields the empty set — cheap no-op.
      rollsMap = frameMetadataStore.store.get('rolls', {}) || {};
    } catch (err) {
      logger.logError('filmScans: sweepStaleEnhancingRolls could not read rolls store', err);
      return { swept, skipped };
    }

    // Resolve the same timeout the PC block would have used for the
    // staleness cut-off. Prefer the explicit config override so a lab
    // running a slower QuickServer doesn't false-recover a genuinely
    // live enhance; fall back to a conservative floor (the derived
    // formula's minimum) when no config value is set.
    const cfg = configService.getAll();
    const cfgTimeoutMs = Number(cfg.perfectlyClearFilmScanTimeoutMs);
    const stalenessMs  = Number.isFinite(cfgTimeoutMs) && cfgTimeoutMs > 0
      ? cfgTimeoutMs
      : 5 * 60 * 1000;

    for (const rollId of Object.keys(rollsMap)) {
      const rec = rollsMap[rollId];
      if (!rec || rec.processingStatus !== 'enhancing') continue;

      // Never clobber a batch this process is actually running. On
      // startup this is trivially empty, but the method is safe to
      // call at any time (e.g. after a crash-recovery mid-session).
      if (this._activeFilmScanBatch && this._activeFilmScanBatch.rollId === rollId) {
        skipped.push(rollId);
        continue;
      }

      // Staleness guard. Missing/unparseable → treat as maximally stale
      // (a crashed process before the timestamp was written is a valid
      // recovery target). Present and younger than the timeout → skip.
      const startedIso = rec.timeline && rec.timeline.pcEnhanceStartedAt;
      const startedMs  = startedIso ? Date.parse(startedIso) : NaN;
      const ageMs      = Number.isFinite(startedMs) ? (nowMs - startedMs) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(startedMs) && ageMs < stalenessMs) {
        skipped.push(rollId);
        continue;
      }

      const hasStoragePath = !!rec.storagePath;
      const recoveredIso   = new Date().toISOString();
      const patch = {
        processingStatus: null,
        // 'pending' forces the roll into review even in Auto ('never')
        // mode — matches the existing pcTimedOut-escalates-regardless-of-mode
        // rule so a wedge-recovered roll never silently auto-uploads.
        // If the crash landed BEFORE recordRoll() wrote storagePath /
        // locationId / s3Prefix, the upload plumbing is missing and
        // 'pending' would fail when the operator clicked Approve —
        // surface that as 'failed' with an actionable error message so
        // the operator sees the honest state, not a mysterious later
        // upload failure.
        uploadStatus: hasStoragePath ? 'pending' : 'failed',
        ...(hasStoragePath ? {} : { uploadError: 'Recovered from wedged enhancement; roll data incomplete — please re-scan or delete this roll.' }),
        timeline: {
          ...(rec.timeline || {}),
          pcRecoveredAt: recoveredIso,
          pcRecoveredReason: Number.isFinite(startedMs) ? 'stale-enhancing-on-startup' : 'enhancing-without-timestamp',
        },
      };

      try {
        frameMetadataStore.updateRoll(rollId, patch);
        this._emitFilmReviewRoll(rollId);
        swept.push(rollId);
        logger.logWarning(
          `filmScans: recovered wedged roll ${rollId} from processingStatus:'enhancing' ` +
          `(age=${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + 's' : 'unknown'}, ` +
          `uploadStatus='${patch.uploadStatus}', hasStoragePath=${hasStoragePath})`
        );
      } catch (err) {
        logger.logError(`filmScans: sweepStaleEnhancingRolls failed to patch ${rollId}`, err);
      }
    }

    if (swept.length > 0) {
      logger.info(`filmScans: startup enhancement sweep recovered ${swept.length} roll(s)${skipped.length ? `, skipped ${skipped.length} still-live` : ''}`);
    }
    return { swept, skipped };
  }

  /**
   * Operator-triggered "Skip / Reset enhancement" for a roll currently
   * showing as enhancing. Aborts the live batch when in-process; falls
   * back to the sweep's recovery patch when the state is a phantom
   * (roll in 'enhancing' but no batch registered — sweep already
   * cleared it, or a stale record from a previous crash the startup
   * sweep hasn't seen yet).
   *
   * @param {string} rollId
   * @returns {Promise<{success: boolean, wasLive: boolean, error?: string}>}
   */
  async resetEnhancingRoll(rollId) {
    if (!rollId || typeof rollId !== 'string') {
      return { success: false, wasLive: false, error: 'rollId is required' };
    }

    // Live-batch branch. Aborting the controller causes the client to
    // return status:'cancelled' for every remaining record; the folder-
    // watch PC block already treats 'cancelled' as pcTimedOut → the roll
    // escalates to review through the normal recordRoll path with
    // uploadStatus:'pending' AND storagePath / locationId / s3Prefix
    // properly filled in. So this branch does NOT need to touch the
    // sidecar itself — the natural continuation is authoritative.
    if (this._activeFilmScanBatch && this._activeFilmScanBatch.rollId === rollId) {
      try {
        this._activeFilmScanBatch.abortController.abort();
        logger.logWarning(`filmScans: operator reset enhancement for ${rollId} — aborting live batch`);
        return { success: true, wasLive: true };
      } catch (err) {
        return { success: false, wasLive: true, error: err && err.message ? err.message : String(err) };
      }
    }

    // Phantom branch. Sidecar shows 'enhancing' but no batch is
    // running. Do the same cleanup patch the sweep does, without the
    // staleness guard (operator intent is authoritative here — they've
    // decided the roll is stuck).
    const frameMetadataStore = require('./frame-metadata-store');
    const rec = frameMetadataStore.getRoll(rollId);
    if (!rec) {
      return { success: false, wasLive: false, error: `roll ${rollId} not found` };
    }
    if (rec.processingStatus !== 'enhancing') {
      return { success: false, wasLive: false, error: `roll ${rollId} is not enhancing (status=${rec.processingStatus || 'null'})` };
    }

    const hasStoragePath = !!rec.storagePath;
    const recoveredIso   = new Date().toISOString();
    try {
      frameMetadataStore.updateRoll(rollId, {
        processingStatus: null,
        uploadStatus: hasStoragePath ? 'pending' : 'failed',
        ...(hasStoragePath ? {} : { uploadError: 'Recovered from wedged enhancement; roll data incomplete — please re-scan or delete this roll.' }),
        timeline: {
          ...(rec.timeline || {}),
          pcRecoveredAt: recoveredIso,
          pcRecoveredReason: 'operator-reset-phantom',
        },
      });
      this._emitFilmReviewRoll(rollId);
      logger.logWarning(
        `filmScans: operator reset enhancement for ${rollId} — phantom cleanup ` +
        `(uploadStatus='${hasStoragePath ? 'pending' : 'failed'}', hasStoragePath=${hasStoragePath})`
      );
      return { success: true, wasLive: false };
    } catch (err) {
      return { success: false, wasLive: false, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * Re-attempt uploads for two categories of stuck rolls:
   *
   *   1. uploadStatus:'uploading' — normal flow never leaves a roll
   *      here; only persists if a prior upload was interrupted
   *      (network hang, crash, force-quit). Always retried.
   *
   *   2. uploadStatus:'failed'  — 2026-07-24 self-heal. Instead of
   *      needing an operator to manually re-try a poisoned roll,
   *      the film-scans cycle re-attempts on its own with a 10-minute
   *      rate-limit (via lastUploadRetryAt) so we don't hammer a
   *      genuinely-broken roll every minute. Combined with the inner
   *      presign / PUT / second-pass retries this means a transient
   *      blip (502 wave, brief SMB hiccup) can never permanently kill
   *      a roll — worst case is a 10-minute delay before automatic
   *      recovery.
   *
   *      Recovery depends on the OrderHub server treating a re-emitted
   *      manifest at the same S3 key as authoritative (i.e. an errors:0
   *      re-write supersedes a prior errors:1). See the plan doc for
   *      the open question on server-side ingest semantics.
   *
   * Called on startup AND on every film-scans polling cycle.
   */
  async _resumeInterruptedUploads(config) {
    if (!config.filmScanRotationEnabled) return; // roll records only exist then
    const frameMetadataStore = require('./frame-metadata-store');
    const FAILED_RETRY_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 min rate-limit for 'failed' rolls
    const nowMs = Date.now();

    let candidates = [];
    try {
      candidates = frameMetadataStore.listRollsWithSummary().filter((r) => {
        if (r.uploadStatus !== 'uploading' && r.uploadStatus !== 'failed') return false;
        // Rate-limit both branches so we don't re-fire on an in-flight upload
        // (uploading rolls have a freshly-stamped lastUploadRetryAt), and don't
        // hammer a genuinely-broken failed roll every cycle.
        const rec = frameMetadataStore.getRoll(r.rollId);
        const lastMs = rec && rec.lastUploadRetryAt ? Date.parse(rec.lastUploadRetryAt) : NaN;
        if (!Number.isFinite(lastMs)) return true; // never retried before → try now
        return (nowMs - lastMs) >= FAILED_RETRY_MIN_INTERVAL_MS;
      });
    } catch (_) {
      return;
    }
    if (candidates.length === 0) return;

    const stuckCount  = candidates.filter((r) => r.uploadStatus === 'uploading').length;
    const failedCount = candidates.filter((r) => r.uploadStatus === 'failed').length;
    logger.logWarning(
      `filmScans: retrying upload for ${candidates.length} roll(s) ` +
      `— ${stuckCount} interrupted, ${failedCount} previously-failed (self-heal, min ${FAILED_RETRY_MIN_INTERVAL_MS / 60000} min interval)`
    );
    for (const r of candidates) {
      try {
        await this._uploadRollFromStorage(r.rollId, config);
      } catch (err) {
        logger.logError(`filmScans: resume upload threw for ${r.rollId}`, err);
      }
    }
  }

  /**
   * Re-upload one roll from its permanent-storage copy. Mirrors the inline
   * Step 3 upload: stamps 'uploading', retries 3× with backoff, then
   * 'uploaded' + markRollReviewed, or 'failed'. Best-effort; never throws.
   */
  async _uploadRollFromStorage(rollId, config) {
    const frameMetadataStore = require('./frame-metadata-store');
    const rec = frameMetadataStore.getRoll(rollId);
    if (!rec) return;

    // 2026-07-24 — concurrent-upload guard. Cheap check BEFORE the
    // expensive work so the second caller in a race no-ops cleanly.
    // The state / rate-limit guards elsewhere are timestamp-based and
    // can be read stale by two callers arriving on independent timers
    // (main-poll auto-assign + film-scans self-heal, for example);
    // this in-process Set is authoritative regardless.
    if (this._uploadingRolls.has(rollId)) {
      logger.info(`filmScans: skipping ${rollId} — an upload is already in flight in this process`);
      return;
    }

    // M4 ordering guard: a roll mid-Perfectly-Clear enhancement is not safe
    // to upload — the storage files may be part-replaced. Defensive belt+
    // braces on top of the fact that the pipeline never sets both
    // uploadStatus:'uploading' AND processingStatus:'enhancing', so this
    // branch only fires if something upstream set them out of order.
    if (rec.processingStatus === 'enhancing') {
      logger.logWarning(`filmScans: refusing to upload ${rollId} — still enhancing (processingStatus='enhancing')`);
      return;
    }

    const storagePath = rec.storagePath;
    if (!storagePath || !fs.existsSync(storagePath)) {
      frameMetadataStore.updateRoll(rollId, {
        uploadStatus: 'failed',
        uploadError: 'Cannot resume upload — stored files not found',
      });
      this._emitFilmReviewRoll(rollId);
      logger.logWarning(`filmScans: cannot resume upload for ${rollId} — storage path missing (${storagePath})`);
      return;
    }

    const locationId = (rec.locationId != null) ? rec.locationId : config.locationId;
    const s3Prefix   = rec.s3Prefix || `film-scans/${locationId}/`;
    const s3Config   = this._buildS3Config(config, locationId);
    if (!s3Config) {
      logger.logWarning(`filmScans: cannot resume upload for ${rollId} — S3 not configured`);
      return;
    }

    // 2026-07-24 — mark this roll as in-flight IN THIS PROCESS. Any
    // concurrent caller (main-poll auto-assign, film-scans self-heal,
    // operator IPC) that arrives on the same roll while we're mid-upload
    // will hit the has(rollId) guard at the top of this method and
    // no-op. Removal is finally-guarded so a throw mid-upload doesn't
    // leak a permanent stuck entry.
    this._uploadingRolls.add(rollId);
    try {

    // 2026-07-24 — stamp lastUploadRetryAt so the 10-min self-heal in
    // _resumeInterruptedUploads doesn't re-fire before this attempt
    // has had a chance to complete (or to fail with a fresh error).
    frameMetadataStore.updateRoll(rollId, {
      uploadStatus: 'uploading',
      uploadError: null,
      lastUploadRetryAt: new Date().toISOString(),
      timeline: { ...((rec.timeline) || {}), uploadStartedAt: new Date().toISOString() },
    });
    this._emitFilmReviewRoll(rollId);

    // 2026-07-24 — outer roll-level retry trimmed from 3× (30s/90s) to
    // 2× (15s) now that presign / PUT / second-pass retries at the
    // inner layers absorb most transient blips. Each outer attempt
    // re-uploads the whole folder (uploadFolder rescans localFolderPath),
    // so shrinking the ladder avoids grinding through already-succeeded
    // files a third time. Rolls that still fail after both attempts
    // fall to the 10-minute self-heal in _resumeInterruptedUploads.
    const MAX_ATTEMPTS = 2;
    const BACKOFFS_MS = [15_000];
    let result;
    let attempt = 0;
    const manifestExtra = this._buildFilmScanManifestExtra(rollId);
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      try {
        result = await s3Service.uploadFolder(storagePath, s3Prefix, s3Config, (progress) => {
          logger.info(`filmScans: (resume) ${progress.message}`);
        }, manifestExtra);
      } catch (uploadError) {
        const totalFiles = fs.readdirSync(storagePath).length;
        logger.logError(`filmScans: (resume) uploadFolder threw for ${rollId} (attempt ${attempt}/${MAX_ATTEMPTS})`, uploadError);
        result = { uploaded: 0, failed: totalFiles, total: totalFiles };
      }
      if (result.failed === 0) break;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt - 1]));
      }
    }

    if (result.failed > 0) {
      const msg = `Resumed upload incomplete for ${rollId}: ${result.uploaded}/${result.total} uploaded, ${result.failed} file(s) failed after ${attempt}/${MAX_ATTEMPTS} attempts`;
      frameMetadataStore.updateRoll(rollId, { uploadStatus: 'failed', uploadError: msg });
      logger.logWarning(`filmScans: ${msg}`);
    } else {
      const nowIso = new Date().toISOString();
      const cur = frameMetadataStore.getRoll(rollId) || {};
      frameMetadataStore.updateRoll(rollId, {
        uploadStatus: 'uploaded',
        uploadError: null,
        uploadedAt: nowIso,
        timeline: { ...((cur.timeline) || {}), uploadedAt: nowIso },
      });
      try { frameMetadataStore.markRollReviewed(rollId); } catch (_) { /* best-effort */ }
      logger.info(`filmScans: (resume) upload complete for ${rollId}`);
    }
    this._emitFilmReviewRoll(rollId);
    } finally {
      // Always release the in-process lock so a subsequent legitimate
      // retry (via self-heal, auto-assign, or IPC) can pick this roll up.
      this._uploadingRolls.delete(rollId);
    }
  }

  _getDateSubfolder() {
    const now  = new Date();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const dd   = String(now.getDate()).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    return `${mm}${dd}${yyyy}`;
  }

  _resolveStoragePath(dateStorageDir, folderName) {
    let candidate = path.join(dateStorageDir, folderName);
    if (!fs.existsSync(candidate)) return candidate;
    let n = 1;
    while (true) { // eslint-disable-line no-constant-condition
      candidate = path.join(dateStorageDir, `${folderName}_${n}`);
      if (!fs.existsSync(candidate)) return candidate;
      n++;
    }
  }

  _isFolderStable(folderPath, stabilityMinutes) {
    const cutoff = Date.now() - (stabilityMinutes * 60 * 1000);
    return this._checkAllFilesOlderThan(folderPath, cutoff);
  }

  _checkAllFilesOlderThan(dirPath, cutoffMs) {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      if (entries.length === 0) return false;

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (!this._checkAllFilesOlderThan(fullPath, cutoffMs)) return false;
        } else {
          const stat = fs.statSync(fullPath);
          const latestMs = Math.max(stat.mtimeMs, stat.birthtimeMs);
          if (latestMs > cutoffMs) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async _copyFolder(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this._copyFolder(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  _deleteFolderRecursive(folderPath) {
    if (!fs.existsSync(folderPath)) return;

    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        this._deleteFolderRecursive(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    fs.rmdirSync(folderPath);
  }

  _buildS3Config(config, locationId) {
    if (!config.s3BucketName) {
      return null;
    }

    const provider = config.s3Provider || 'pixfizz';

    if (provider === 'amazon') {
      if (!config.s3Region || !config.s3AccessKeyId || !config.s3SecretAccessKey) {
        return null;
      }
      return {
        provider: 'amazon',
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
        bucketName: config.s3BucketName,
        region: config.s3Region
      };
    }

    return {
      provider: 'pixfizz',
      bucketName: config.s3BucketName,
      locationId: locationId || null
    };
  }

  getStatus() {
    return this.lastSummary;
  }
}

module.exports = new FolderWatchService();
