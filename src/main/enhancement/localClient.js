'use strict';

/**
 * src/main/enhancement/localClient.js
 *
 * Local (on-device) AI image-enhancement client — branded "Pixfizz AI
 * Enhancement", powered by Real-ESRGAN's `realesr-general-x4v3` model
 * loaded into the existing utility-process inference host.
 *
 * Sibling to topazClient.js. Both providers expose the same four-function
 * surface so enhancementManager.js can route uniformly:
 *
 *   enhance(destPath, options)             → Promise<void>  (overwrites destPath)
 *   startEnhancement(destPath, options)    → Promise<jobId>
 *   checkEnhancement(jobId)                → { status, outputPath?, progress?, error? }
 *   cancelEnhancement(jobId)               → void
 *
 * Internally:
 *   1. sharp(.removeAlpha().raw()) decodes the source image to an HWC
 *      uint8 buffer.
 *   2. realesrgan-preprocessor.planTiles() lays out a grid of overlapping
 *      256² tiles with last-tile-shift-inward.
 *   3. For each tile: extractTile → ai-inference-client.runTile (one
 *      session.run() per tile, sequential — the EP is the bottleneck;
 *      parallelism would oversubscribe).
 *   4. Stitcher.addTile blends each tile's float32 CHW output into the
 *      4× canvas with linear edge feathering. Stitcher.finalise produces
 *      the final HWC uint8 buffer.
 *   5. sharp encodes the canvas as a JPEG, written atomically (temp + rename)
 *      and overwrites destPath. Same output-path contract as topazClient.
 *
 * Cancellation is cooperative: cancelEnhancement(jobId) sets a flag the
 * tile loop checks between tiles. In-flight per-tile inferences run to
 * completion (no IPC interrupt path); typical worst case is the loop
 * terminates after the current ~500 ms tile.
 *
 * The synthetic job ID format is `local_<ms>_<rand>` — mirrors the
 * `topaz_<ms>_<rand>` pattern used elsewhere so enhancementManager can
 * dispatch by ID prefix.
 */

const fs   = require('fs/promises');
const path = require('path');
const os   = require('os');
const sharp = require('sharp');

const aiInferenceClient = require('../services/ai-inference-client');
const preprocessor = require('../services/ai-inference-models/realesrgan-preprocessor');
const realesrganLoader = require('../services/ai-inference-models/realesrgan-loader');
const configService = require('../services/config-service');
const logger = require('../services/logger');

const MODEL_ID = 'realesrgan';
const JPEG_QUALITY = 95;

// Map<jobId, JobState>
const jobs = new Map();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function newJobId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readTileSizeFromConfig() {
  const v = configService.get && configService.get('enhancementLocalTileSize');
  return Number.isInteger(v) && v >= 64 && v <= 1024 ? v : realesrganLoader.defaultTileSize;
}

function readTileOverlapFromConfig() {
  const v = configService.get && configService.get('enhancementLocalTileOverlap');
  return Number.isInteger(v) && v >= 0 && v < 256 ? v : realesrganLoader.defaultTileOverlap;
}

async function decodeSourceHwc(srcPath) {
  // sharp options mirror orientation-service's tolerant defaults — high-res
  // scanner output and corrupted-trailer JPEGs are common in the lab.
  const { data, info } = await sharp(srcPath, { limitInputPixels: false, failOn: 'none' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`expected 3-channel image after removeAlpha, got ${info.channels}`);
  }
  return { data, w: info.width, h: info.height };
}

async function writeJpegAtomic(hwc, w, h, destPath) {
  // Write to a sibling .tmp file then rename, so a crash partway through
  // never leaves a partial JPEG at destPath.
  const tmp = destPath + '.tmp.' + process.pid + '.' + Date.now();
  try {
    await sharp(hwc, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
      .toFile(tmp);
    await fs.rename(tmp, destPath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core: run tile-and-stitch for a single image
// ---------------------------------------------------------------------------

/**
 * Run the full tile-and-stitch enhancement pipeline. Mutates jobState
 * progress fields as it goes; checks jobState.cancelRequested between
 * tiles for cooperative cancellation.
 *
 * @param {object} jobState
 * @param {string} srcPath
 * @param {string} destPath
 * @param {object} [options]   { tileSize?, tileOverlap? }
 * @returns {Promise<{ inferenceMs: number, tileCount: number, tileSize: number,
 *                     tileOverlap: number, executionProvider: string }>}
 */
async function runTileAndStitch(jobState, srcPath, destPath, options = {}) {
  // Make sure the host is up before we time anything.
  await aiInferenceClient.init();
  if (!aiInferenceClient.hasModel(MODEL_ID)) {
    const err = new Error(
      `Pixfizz AI Enhancement is unavailable: model '${MODEL_ID}' is not loaded by the inference host. ` +
      `Check that resources/models/realesrgan/${realesrganLoader.modelFile} is present.`
    );
    err.code = 'MODEL_NOT_LOADED';
    throw err;
  }

  const tileSize    = options.tileSize    || readTileSizeFromConfig();
  const tileOverlap = options.tileOverlap != null ? options.tileOverlap : readTileOverlapFromConfig();

  const decoded = await decodeSourceHwc(srcPath);
  const plan = preprocessor.planTiles(decoded.w, decoded.h, { tileSize, tileOverlap, scale: realesrganLoader.scale });
  jobState.tilesTotal = plan.tiles.length;
  jobState.tileSize = tileSize;
  jobState.tileOverlap = tileOverlap;

  logger.info(
    `[local-enhancement] ${path.basename(srcPath)} ${decoded.w}x${decoded.h} → ` +
    `${plan.scaledW}x${plan.scaledH} via ${plan.tilesX}x${plan.tilesY}=${plan.tiles.length} tiles ` +
    `(tile=${tileSize}, overlap=${tileOverlap}, ep=${aiInferenceClient.getExecutionProvider()})`
  );

  const stitcher = new preprocessor.Stitcher(plan.scaledW, plan.scaledH, plan.featherPx);

  const t0 = Date.now();
  let totalInferenceMs = 0;
  for (let i = 0; i < plan.tiles.length; i++) {
    if (jobState.cancelRequested) {
      const err = new Error('enhancement cancelled by operator');
      err.code = 'CANCELLED';
      throw err;
    }

    const tile = plan.tiles[i];
    const tileHwc = preprocessor.extractTile(decoded.data, decoded.w, decoded.h, tile);

    const result = await aiInferenceClient.runTile(MODEL_ID, tileHwc, tile.w, tile.h);
    totalInferenceMs += result.inferenceMs || 0;

    // Sanity: the host returns scaledW/scaledH derived from loader.scale,
    // which must match our plan's scaledW/scaledH for this tile.
    if (result.scaledW !== tile.scaledW || result.scaledH !== tile.scaledH) {
      throw new Error(
        `host returned tile of ${result.scaledW}x${result.scaledH}, expected ${tile.scaledW}x${tile.scaledH}`
      );
    }

    stitcher.addTile(result.chwData, tile);
    jobState.tilesDone = i + 1;
  }

  const stitched = stitcher.finalise();

  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await writeJpegAtomic(stitched, plan.scaledW, plan.scaledH, destPath);

  const wallMs = Date.now() - t0;
  return {
    inferenceMs: wallMs,
    perTileInferenceMs: totalInferenceMs,
    tileCount: plan.tiles.length,
    tileSize,
    tileOverlap,
    executionProvider: aiInferenceClient.getExecutionProvider() || 'cpu',
    sourceWidth: decoded.w,
    sourceHeight: decoded.h,
    outputWidth: plan.scaledW,
    outputHeight: plan.scaledH,
  };
}

// ---------------------------------------------------------------------------
// Public API — blocking
// ---------------------------------------------------------------------------

/**
 * Run a full enhancement pipeline synchronously (blocking).
 *
 * Reads from `destPath`, runs tile-and-stitch, overwrites `destPath`
 * with the 4×-upscaled output. Mirrors topazClient.enhance()'s shape
 * so enhancementManager can swap providers transparently.
 *
 * @param {string} destPath  Absolute path; read and overwritten in place.
 * @param {object} [options] { tileSize?, tileOverlap? }
 * @returns {Promise<object>} {
 *   inferenceMs, tileCount, tileSize, tileOverlap, executionProvider,
 *   sourceWidth, sourceHeight, outputWidth, outputHeight
 * }
 */
async function enhance(destPath, options = {}) {
  const jobId = newJobId();
  const state = {
    status: 'running',
    srcPath: destPath,
    destPath,
    tilesDone: 0,
    tilesTotal: 0,
    cancelRequested: false,
    startedAt: Date.now(),
  };
  jobs.set(jobId, state);
  try {
    const meta = await runTileAndStitch(state, destPath, destPath, options);
    state.status = 'succeeded';
    state.outputPath = destPath;
    state.meta = meta;
    return meta;
  } catch (err) {
    state.status = err.code === 'CANCELLED' ? 'cancelled' : 'failed';
    state.error = err.message;
    throw err;
  } finally {
    // Keep the entry in the map for one tick so a concurrent checkEnhancement
    // observation can still read terminal state, then evict to bound memory.
    setTimeout(() => jobs.delete(jobId), 5000);
  }
}

// ---------------------------------------------------------------------------
// Public API — non-blocking polling
// ---------------------------------------------------------------------------

/**
 * Start an enhancement job without waiting for it to finish.
 * Returns a `local_*` job ID; the caller polls checkEnhancement() and
 * may call cancelEnhancement() to abort cooperatively.
 *
 * @param {string} destPath  Absolute path; read and overwritten in place.
 * @param {object} [options] { tileSize?, tileOverlap? }
 * @returns {Promise<string>}  Job ID of the form `local_<ms>_<rand>`.
 */
async function startEnhancement(destPath, options = {}) {
  const jobId = newJobId();
  const state = {
    status: 'running',
    srcPath: destPath,
    destPath,
    tilesDone: 0,
    tilesTotal: 0,
    cancelRequested: false,
    startedAt: Date.now(),
  };
  jobs.set(jobId, state);

  // Fire-and-forget. checkEnhancement() reads the state map.
  runTileAndStitch(state, destPath, destPath, options)
    .then((meta) => {
      state.status = 'succeeded';
      state.outputPath = destPath;
      state.meta = meta;
    })
    .catch((err) => {
      state.status = err.code === 'CANCELLED' ? 'cancelled' : 'failed';
      state.error = err.message;
      logger.logError(`[local-enhancement] job ${jobId} ${state.status}`, err);
    });

  return jobId;
}

/**
 * Poll the status of an active enhancement job. Terminal states
 * (succeeded/failed/cancelled) cause the job to be evicted from the
 * map after this call returns, so the caller must capture outputPath
 * on the same poll that observes 'succeeded'.
 *
 * Status values:
 *   'running'     — tiles still being processed
 *   'succeeded'   — outputPath populated
 *   'failed'      — error populated
 *   'cancelled'   — cooperative cancellation completed
 *   'unknown'     — job ID not in registry (host restart, evicted, never existed)
 *
 * @param {string} jobId
 * @returns {Promise<{status, outputPath?, progress?, error?, meta?}>}
 */
async function checkEnhancement(jobId) {
  const state = jobs.get(jobId);
  if (!state) {
    return { status: 'unknown', error: 'job not found — the app may have restarted.' };
  }

  const progress = state.tilesTotal > 0
    ? { done: state.tilesDone, total: state.tilesTotal, fraction: state.tilesDone / state.tilesTotal }
    : undefined;

  if (state.status === 'succeeded') {
    jobs.delete(jobId);
    return { status: 'succeeded', outputPath: state.outputPath, meta: state.meta, progress };
  }
  if (state.status === 'failed') {
    jobs.delete(jobId);
    return { status: 'failed', error: state.error };
  }
  if (state.status === 'cancelled') {
    jobs.delete(jobId);
    return { status: 'cancelled' };
  }
  return { status: 'running', progress };
}

/**
 * Request cancellation of an in-progress job. The tile loop checks the
 * flag between tiles; in-flight inference runs to completion.
 */
async function cancelEnhancement(jobId) {
  const state = jobs.get(jobId);
  if (!state) return;
  state.cancelRequested = true;
}

// ---------------------------------------------------------------------------
// Test/dev helper — verify the pipeline end-to-end on a small fixture
// ---------------------------------------------------------------------------

/**
 * Light smoke-test of the local pipeline. Used by the Settings "Test"
 * button (M3) and by integration tests. Runs one tile through the
 * pipeline on a small synthesised fixture and reports timing + success.
 */
async function selfTest() {
  await aiInferenceClient.init();
  if (!aiInferenceClient.hasModel(MODEL_ID)) {
    return { ok: false, error: `model '${MODEL_ID}' not loaded` };
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohd-localclient-selftest-'));
  const src = path.join(tmpDir, 'selftest-in.png');
  try {
    // 64×64 synthetic image — single tile, fast; exercises decode → tile →
    // model → stitch → encode end-to-end.
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 64, b: 200 } },
    }).png().toFile(src);
    const t0 = Date.now();
    const meta = await enhance(src, {});
    return { ok: true, durationMs: Date.now() - t0, meta };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  enhance,
  startEnhancement,
  checkEnhancement,
  cancelEnhancement,
  selfTest,
};
