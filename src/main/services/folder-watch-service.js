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

          // M8-3: stability passed — flip the provisional record to
          // 'processing' so the panel pill changes from Watching → Processing.
          if (config.filmScanRotationEnabled) {
            try {
              const frameMetadataStore = require('./frame-metadata-store');
              const existing = frameMetadataStore.getRoll(folder.name);
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
                  // M8-3: the provisional record (created at detection) was
                  // keyed by folder.name (the watch-folder basename). The real
                  // rollId is path.basename(storagePath) — usually identical,
                  // but _resolveStoragePath may append `_1` if the date folder
                  // already had a same-named roll. recordRoll() overwrites the
                  // record at `rollId`; if `rollId !== folder.name` we delete
                  // the provisional one so it doesn't linger as a ghost
                  // "processing" card forever.
                  const reviewMode = config.filmScanReviewMode || 'never';
                  const smartTriggered = reviewMode === 'smart' && (lowConfCount > 0 || rotErrorCount > 0);
                  const deferUpload = reviewMode === 'always' || smartTriggered;
                  if (reviewMode === 'smart') {
                    logger.info(
                      `filmScans: ${rollId} smart-check — lowConf=${lowConfCount} rotErr=${rotErrorCount} → ${deferUpload ? 'pending review' : 'auto upload'}`
                    );
                  }
                  try {
                    frameMetadataStore.recordRoll(rollId, {
                      storagePath,
                      locationId,
                      s3Prefix,
                      uploadStatus: deferUpload ? 'pending' : undefined,
                      uploadError: null,
                      uploadedAt: null,
                      processingStatus: null,
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
              for (const tiffFile of tiffFiles) {
                const srcPath  = path.join(storagePath, tiffFile);
                const jpgFile  = path.basename(tiffFile, path.extname(tiffFile)) + '.jpg';
                const destPath = path.join(storagePath, jpgFile);
                try {
                  await sharp(srcPath).jpeg({ quality: 90 }).toFile(destPath);
                  logger.info(`filmScans: converted ${tiffFile} -> ${jpgFile}`);
                } catch (convErr) {
                  logger.logError(`filmScans: failed to convert ${tiffFile} to JPEG - skipping`, convErr);
                }
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
            let shouldDefer = false;
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
                    frameMetadataStore.updateRoll(rollId, {
                      uploadStatus: 'uploading',
                      uploadError: null,
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
                while (attempt < MAX_ATTEMPTS) {
                  attempt += 1;
                  try {
                    result = await s3Service.uploadFolder(storagePath, s3Prefix, s3Config, (progress) => {
                      logger.info(`filmScans: ${progress.message}`);
                    });
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
                      frameMetadataStore.updateRoll(rollId, {
                        uploadStatus: 'uploaded',
                        uploadError: null,
                        uploadedAt: new Date().toISOString(),
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

          break;
        }
      } catch (error) {
        logger.logError('filmScans: error scanning watch folder', error);
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
