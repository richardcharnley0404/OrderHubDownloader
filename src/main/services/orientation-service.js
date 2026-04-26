/**
 * src/main/services/orientation-service.js
 *
 * Wraps the ONNX Runtime inference session for the Film Scan AI Rotation
 * feature (PW-007 Phase 1).
 *
 * MILESTONE 2: real inference is live. init() loads the .onnx session via
 * onnxruntime-node, runs a warmup pass, then serves per-frame predictions.
 * The feature is still flag-gated (filmScanRotationEnabled) so OFF remains
 * a zero-cost no-op — onnxruntime-node is only require()'d when the flag is
 * on.
 *
 * Model class convention (from the upstream HuggingFace model card):
 *   Class 0 = already correct     → rotate 0°
 *   Class 1 = needs 90° CW        → rotate 90°
 *   Class 2 = needs 180°          → rotate 180°
 *   Class 3 = needs 90° CCW       → rotate 270° (or -90°)
 *
 * Model contract (verified from orientation_model_v2_0.9882.onnx metadata):
 *   input  "input"  [B, 3, 384, 384] float32 (NCHW, ImageNet-normalized)
 *   output "output" [B, 4]           float32 (pre-softmax logits)
 *
 * See docs/phase-1-implementation-plan.md § 2, 8, 10 for the full context.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const configService = require('./config-service');
const logger = require('./logger');

// Filename of the bundled model. Preserve the version + accuracy suffix
// so provenance is traceable from the build artefact alone.
// Swap this one line when rolling a new model revision.
const MODEL_FILE = 'orientation_model_v2_0.9882.onnx';

// Model I/O contract — verified against the .onnx file. If you re-export
// the model and these change, update here.
const INPUT_NAME = 'input';
const OUTPUT_NAME = 'output';
const IMG_SIZE = 384;

// ImageNet normalization (EfficientNetV2 pretraining convention — the
// orientation fine-tune kept the same transforms).
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD  = [0.229, 0.224, 0.225];

class OrientationService {
  constructor() {
    this.session = null;          // ort.InferenceSession — null until init()
    this.ort = null;              // onnxruntime-node module, lazy-loaded
    this.initialised = false;     // true once init() has run successfully
    this.modelAbsPath = null;     // resolved path to the .onnx file
    this.modelVersion = null;     // filename-derived version string
    this._inFlight = null;        // single-flight guard — onnxruntime-node
                                  // sessions aren't guaranteed thread-safe
                                  // under parallel calls
  }

  /**
   * Resolve the on-disk path to the model file.
   *
   * Respects `filmScanRotationModelPath` from config if set. Otherwise falls
   * back to the bundled default under `resources/models/orientation/`.
   *
   * In a packaged app, `process.resourcesPath` resolves to the Electron
   * resources directory. Because `resources/models/**` is in electron-builder's
   * `asarUnpack` list, the .onnx file is unpacked to the real filesystem and
   * readable by onnxruntime-node.
   *
   * In dev, we resolve relative to the repo root.
   */
  _resolveModelPath() {
    const override = configService.get('filmScanRotationModelPath');
    if (override && override.trim()) {
      return path.resolve(override.trim());
    }

    // Packaged: <app>/resources/models/orientation/<MODEL_FILE>
    if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'models'))) {
      return path.join(process.resourcesPath, 'models', 'orientation', MODEL_FILE);
    }

    // Dev fallback — three levels up from src/main/services/
    return path.join(__dirname, '..', '..', '..', 'resources', 'models', 'orientation', MODEL_FILE);
  }

  /**
   * Initialise the inference session. Idempotent — safe to call multiple times.
   *
   * Returns true if ready to serve predictions, false if not (e.g. flag OFF,
   * model missing, runtime failure). Callers should treat `false` as "feature
   * effectively OFF" and skip rotation for the frame.
   */
  async init() {
    if (this.initialised) return true;

    try {
      const enabled = configService.get('filmScanRotationEnabled');
      if (!enabled) {
        logger.info('[orientation] feature flag OFF — skipping init');
        return false;
      }

      this.modelAbsPath = this._resolveModelPath();

      if (!fs.existsSync(this.modelAbsPath)) {
        logger.logError(`[orientation] model file not found at ${this.modelAbsPath} — feature will be disabled at runtime`);
        return false;
      }

      // Lazy-load onnxruntime-node ONLY when the flag is on — keeps OFF-path
      // at zero cost and avoids pulling native bindings unless needed.
      const t0 = Date.now();
      this.ort = require('onnxruntime-node');
      this.session = await this.ort.InferenceSession.create(this.modelAbsPath);
      const loadMs = Date.now() - t0;

      this.modelVersion = path.basename(this.modelAbsPath, '.onnx');

      // Warmup: first inference pays for JIT/graph compilation. Burn that
      // cost now so the first real frame isn't artificially slow.
      const warmupMs = await this._warmup();

      this.initialised = true;
      logger.info(
        `[orientation] ready — loaded ${MODEL_FILE} in ${loadMs}ms, warmup ${warmupMs}ms, ` +
        `inputs=${this.session.inputNames.join(',')}, outputs=${this.session.outputNames.join(',')}`
      );
      return true;

    } catch (err) {
      logger.logError('[orientation] init failed — feature will be disabled at runtime', err);
      // Make sure we don't half-initialise — clear any partial state so a
      // later retry starts clean.
      this.session = null;
      this.ort = null;
      return false;
    }
  }

  /**
   * Run one dummy inference with a zero-filled tensor to trigger JIT/graph
   * compilation. Returns elapsed ms so init() can log it.
   */
  async _warmup() {
    const t0 = Date.now();
    const zeros = new Float32Array(3 * IMG_SIZE * IMG_SIZE);
    const tensor = new this.ort.Tensor('float32', zeros, [1, 3, IMG_SIZE, IMG_SIZE]);
    try {
      await this.session.run({ [INPUT_NAME]: tensor });
    } catch (err) {
      logger.logError('[orientation] warmup inference failed', err);
      // Don't re-throw — the session is loaded, warmup is best-effort.
    }
    return Date.now() - t0;
  }

  /**
   * Predict the orientation class for a single image file.
   *
   * Return shape (stable contract):
   *   {
   *     predictedClass: 0 | 1 | 2 | 3,
   *     predictedAngle: 0 | 90 | 180 | 270,   // degrees to rotate CW to correct
   *     confidence: number,                   // softmax score of predictedClass
   *     classScores: [number, number, number, number],  // full softmax distribution
   *     inferenceMs: number,
   *     error: string | null                  // non-null on graceful failure
   *   }
   */
  async predictOrientation(imagePath) {
    const startedAt = Date.now();

    // Ensure init has been attempted — if it fails, we still return a
    // well-formed "no rotation" result so callers never have to deal with
    // null or exceptions.
    if (!this.initialised) {
      const ok = await this.init();
      if (!ok) {
        return this._noRotationResult(Date.now() - startedAt, 'orientation-service not initialised');
      }
    }

    // Single-flight guard — coalesce accidental parallel calls. onnxruntime-node
    // sessions are not guaranteed thread-safe; one-at-a-time is the safe default.
    if (this._inFlight) {
      try { await this._inFlight; } catch (_) { /* ignored */ }
    }

    this._inFlight = this._runPrediction(imagePath, startedAt);
    try {
      return await this._inFlight;
    } finally {
      this._inFlight = null;
    }
  }

  async _runPrediction(imagePath, startedAt) {
    try {
      if (!fs.existsSync(imagePath)) {
        return this._noRotationResult(Date.now() - startedAt, `image not found: ${imagePath}`);
      }

      // --- Preprocess ---------------------------------------------------
      const tensor = await this._prepareTensor(imagePath);

      // --- Inference ----------------------------------------------------
      const output = await this.session.run({ [INPUT_NAME]: tensor });
      const logits = Array.from(output[OUTPUT_NAME].data);  // Float32Array → number[]

      if (logits.length !== 4) {
        return this._noRotationResult(
          Date.now() - startedAt,
          `unexpected output length ${logits.length} (expected 4)`
        );
      }

      // --- Postprocess --------------------------------------------------
      const scores = softmax(logits);
      const predictedClass = argmax(scores);
      const confidence = scores[predictedClass];
      const predictedAngle = OrientationService.classToAngle(predictedClass);

      const result = {
        predictedClass,
        predictedAngle,
        confidence,
        classScores: scores,
        inferenceMs: Date.now() - startedAt,
        error: null,
      };

      if (configService.get('filmScanRotationDebugLog')) {
        logger.info(
          `[orientation] ${path.basename(imagePath)} → class ${predictedClass} ` +
          `angle ${predictedAngle}° conf ${confidence.toFixed(3)} (${result.inferenceMs}ms)`
        );
      }
      return result;

    } catch (err) {
      logger.logError(`[orientation] prediction failed for ${imagePath}`, err);
      return this._noRotationResult(Date.now() - startedAt, err.message || String(err));
    }
  }

  /**
   * Decode an image file and prepare it as an [1, 3, 384, 384] float32 tensor
   * in ImageNet-normalised NCHW order.
   *
   * sharp handles TIFF via libtiff (8-bit RGB LZW is the standard film-scan
   * layout; 16-bit TIFFs are auto-converted to 8-bit via sharp's default).
   * We stretch-resize to 384x384 rather than crop, because cropping could
   * discard rotation-indicating features near the image edges.
   */
  async _prepareTensor(imagePath) {
    // limitInputPixels: false — high-res scanner JPGs (especially 6×7 / large
    // format) routinely exceed sharp's default 268MP cap, which would throw
    // "Input image exceeds pixel limit" and bubble up as `rotation.error` on
    // the frame. The rest of the pipeline (folder-watch rotate + thumbnail)
    // already disables the cap; matching that here removes the false-failure
    // mode for high-res rolls.
    //
    // failOn: 'none' — sharp's default rejects images with truncated trailers
    // or recoverable warnings (common on scanner output where the tail bytes
    // are sometimes incomplete). 'none' tells libvips to swallow non-fatal
    // warnings and decode whatever it can, which matches what an image viewer
    // would do. We'd rather classify a slightly-degraded image than fail it.
    const { data } = await sharp(imagePath, { limitInputPixels: false, failOn: 'none' })
      .removeAlpha()
      .flatten({ background: '#ffffff' })
      .resize(IMG_SIZE, IMG_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // data is HWC interleaved uint8, length = IMG_SIZE*IMG_SIZE*3.
    // Transpose to CHW and normalise per channel in one pass.
    const plane = IMG_SIZE * IMG_SIZE;
    const out = new Float32Array(3 * plane);

    for (let i = 0; i < plane; i++) {
      const src = i * 3;
      out[i]             = (data[src]     / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      out[i + plane]     = (data[src + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      out[i + 2 * plane] = (data[src + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }

    return new this.ort.Tensor('float32', out, [1, 3, IMG_SIZE, IMG_SIZE]);
  }

  /**
   * Build a "no rotation" result — used when inference is disabled, the model
   * is missing, the image can't be read, or inference throws. Calling code
   * should treat a non-null `error` as a graceful-failure signal and record
   * `rotation.applied: false` in frame metadata.
   */
  _noRotationResult(inferenceMs, errorMessage) {
    return {
      predictedClass: 0,
      predictedAngle: 0,
      confidence: 0,
      classScores: [0, 0, 0, 0],
      inferenceMs,
      error: errorMessage || null,
    };
  }

  /**
   * Map a predicted class index to the number of degrees to rotate CW.
   */
  static classToAngle(predictedClass) {
    switch (predictedClass) {
      case 1:  return 90;
      case 2:  return 180;
      case 3:  return 270;
      case 0:
      default: return 0;
    }
  }

  getModelVersion() {
    return this.modelVersion;
  }

  isReady() {
    return this.initialised;
  }

  async shutdown() {
    if (this.session && typeof this.session.release === 'function') {
      try { await this.session.release(); } catch (_) { /* ignored */ }
    }
    this.session = null;
    this.ort = null;
    this.initialised = false;
  }
}

// --- Local numeric helpers -------------------------------------------------

/**
 * Numerically-stable softmax over a small array.
 */
function softmax(arr) {
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  const exps = new Array(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const e = Math.exp(arr[i] - max);
    exps[i] = e;
    sum += e;
  }
  for (let i = 0; i < exps.length; i++) exps[i] /= sum;
  return exps;
}

function argmax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}

module.exports = new OrientationService();
