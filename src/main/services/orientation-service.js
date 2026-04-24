/**
 * src/main/services/orientation-service.js
 *
 * Wraps the ONNX Runtime inference session for the Film Scan AI Rotation
 * feature (PW-007 Phase 1).
 *
 * This is the MILESTONE 1 SKELETON — it exposes the full interface but does
 * not yet run real inference. `predictOrientation()` always resolves to
 * "class 0 / no rotation needed / confidence 1.0", which means with the
 * feature flag ON, pipeline code paths are exercised but no TIFF is ever
 * actually rotated. This gives us a safe environment to validate the
 * plumbing before the real model is wired up in Milestone 2.
 *
 * Model class convention (from the upstream HuggingFace model card):
 *   Class 0 = already correct     → rotate 0°
 *   Class 1 = needs 90° CW        → rotate 90°
 *   Class 2 = needs 180°          → rotate 180°
 *   Class 3 = needs 90° CCW       → rotate 270° (or -90°)
 *
 * See docs/phase-1-implementation-plan.md § 2, 8, 10 for the full context.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const configService = require('./config-service');
const logger = require('./logger');

// Filename of the bundled model. Preserve the version + accuracy suffix
// so provenance is traceable from the build artefact alone.
// Swap this one line when rolling a new model revision.
const MODEL_FILE = 'orientation_model_v2_0.9882.onnx';

class OrientationService {
  constructor() {
    this.session = null;          // will hold the ort.InferenceSession in Milestone 2
    this.initialised = false;     // true once init() has run successfully
    this.modelAbsPath = null;     // resolved path to the .onnx file
    this.modelVersion = null;     // hash or filename-derived version string
    this._inFlight = null;        // single-flight guard — onnxruntime-node sessions
                                  // are not guaranteed thread-safe under parallel calls
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
    // We drop the extraResources under `models/` (see electron-builder.yml).
    // Dev: <repo>/resources/models/orientation/<MODEL_FILE>
    if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'models'))) {
      return path.join(process.resourcesPath, 'models', 'orientation', MODEL_FILE);
    }

    // Dev fallback — two levels up from src/main/services/
    return path.join(__dirname, '..', '..', '..', 'resources', 'models', 'orientation', MODEL_FILE);
  }

  /**
   * Initialise the inference session. Idempotent — safe to call multiple times.
   *
   * In Milestone 1 this only validates that the model file is present and
   * logs a warning if not. It does NOT load onnxruntime-node yet.
   *
   * Returns true if ready to serve predictions, false if not (e.g. model
   * missing, runtime failure). Callers should treat `false` as "feature
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

      // Milestone 2 will load onnxruntime-node here:
      //   const ort = require('onnxruntime-node');
      //   this.session = await ort.InferenceSession.create(this.modelAbsPath);
      //   await this._warmup();
      //
      // For Milestone 1 we only log and mark initialised.

      this.modelVersion = path.basename(this.modelAbsPath, '.onnx');  // e.g. "orientation_model_v2_0.9882"
      this.initialised = true;
      logger.info(`[orientation] SKELETON ready — model file present at ${this.modelAbsPath} (version ${this.modelVersion}). Inference is stubbed and will always return class 0.`);
      return true;

    } catch (err) {
      logger.logError('[orientation] init failed — feature will be disabled at runtime', err);
      return false;
    }
  }

  /**
   * Predict the orientation class for a single image file.
   *
   * Return shape (contract for both skeleton and Milestone 2):
   *   {
   *     predictedClass: 0 | 1 | 2 | 3,
   *     predictedAngle: 0 | 90 | 180 | 270,   // degrees to rotate CW to correct
   *     confidence: number,                   // softmax score of predictedClass
   *     classScores: [number, number, number, number],  // full softmax distribution
   *     inferenceMs: number,
   *     error: string | null                  // non-null on graceful failure
   *   }
   *
   * MILESTONE 1 BEHAVIOUR:
   *   Always resolves to class 0 / angle 0 / confidence 1.0. Never throws.
   *   This lets the pipeline code exercise rotation paths and write per-frame
   *   metadata without ever actually rotating anything.
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

    // Single-flight guard — coalesce accidental parallel calls. Harmless in
    // the skeleton, useful once real inference is running.
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

      // ==== MILESTONE 2 REPLACES THIS BLOCK ========================================
      // const tensor = await this._prepareTensor(imagePath);
      // const output = await this.session.run({ [inputName]: tensor });
      // const scores = softmax(Array.from(output[outputName].data));
      // const predictedClass = argmax(scores);
      // ============================================================================

      // Skeleton: pretend the model fired and said "class 0, fully confident".
      const result = {
        predictedClass: 0,
        predictedAngle: 0,
        confidence: 1.0,
        classScores: [1.0, 0.0, 0.0, 0.0],
        inferenceMs: Date.now() - startedAt,
        error: null,
      };

      if (configService.get('filmScanRotationDebugLog')) {
        logger.info(`[orientation] SKELETON predict ${path.basename(imagePath)} → class 0 (${result.inferenceMs}ms)`);
      }
      return result;

    } catch (err) {
      logger.logError(`[orientation] prediction failed for ${imagePath}`, err);
      return this._noRotationResult(Date.now() - startedAt, err.message || String(err));
    }
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
   * Exposed as a helper so pipeline code doesn't hard-code the mapping.
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

  /**
   * Version tag suitable for stamping into per-frame metadata. Stable across
   * the lifetime of the session — changes only when the model file changes.
   */
  getModelVersion() {
    return this.modelVersion;
  }

  /**
   * Whether the service is ready to serve predictions (real or stub).
   */
  isReady() {
    return this.initialised;
  }

  /**
   * Release the inference session. Called on app shutdown.
   * No-op in the skeleton.
   */
  async shutdown() {
    if (this.session && typeof this.session.release === 'function') {
      try { await this.session.release(); } catch (_) { /* ignored */ }
    }
    this.session = null;
    this.initialised = false;
  }
}

module.exports = new OrientationService();
