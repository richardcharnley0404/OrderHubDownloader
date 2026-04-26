/**
 * src/main/services/orientation-service.js
 *
 * Caller-facing API for the Film Scan AI Rotation feature (PW-007 Phase 1).
 *
 * REFACTORED (utilityProcess Step 3): this service no longer loads ONNX or
 * runs inference itself. All ONNX work lives in `ai-inference-host.js`,
 * spawned and managed by `ai-inference-client.js` in a separate OS process.
 * orientation-service is now a thin wrapper that:
 *   - Honours the same feature flag (`filmScanRotationEnabled`).
 *   - Delegates predictions to `aiInferenceClient.run('orientation', ...)`.
 *   - Preserves the exact result contract callers depend on.
 *   - Preserves graceful failure: any error path returns a "no rotation"
 *     result with `error` populated, never throws.
 *
 * The public API is unchanged from before the refactor — folder-watch-service
 * and index.js need no edits beyond benefiting automatically from the
 * out-of-process inference.
 *
 * Model class convention (from the upstream HuggingFace model card):
 *   Class 0 = already correct     → rotate 0°
 *   Class 1 = needs 90° CW        → rotate 90°
 *   Class 2 = needs 180°          → rotate 180°
 *   Class 3 = needs 90° CCW       → rotate 270° (or -90°)
 *
 * See docs/phase-1-implementation-plan.md and
 * docs/refactor-onnx-utilityprocess.md for the full context.
 */

'use strict';

const configService = require('./config-service');
const logger = require('./logger');
const aiInferenceClient = require('./ai-inference-client');
const path = require('path');

const MODEL_ID = 'orientation';

class OrientationService {
  constructor() {
    this.initialised = false;     // true once init() has confirmed the host loaded the model
    this.modelVersion = null;     // cached from the host's ready message
    this._inFlight = null;        // single-flight guard — preserved from
                                  // pre-refactor behaviour. Two rolls landing
                                  // at once on a busy watcher serialise here
                                  // rather than racing into the host's single
                                  // session simultaneously.
  }

  /**
   * Initialise the inference path. Idempotent — safe to call multiple times.
   *
   * Returns true if ready to serve predictions, false if not (flag OFF, host
   * spawn failed, model failed to load in the host). Callers should treat
   * `false` as "feature effectively OFF" and skip rotation for the frame.
   */
  async init() {
    if (this.initialised) return true;

    try {
      const enabled = configService.get('filmScanRotationEnabled');
      if (!enabled) {
        logger.info('[orientation] feature flag OFF — skipping init');
        return false;
      }

      // Spawn the inference host (idempotent — shared with any other
      // AI feature that uses the host).
      await aiInferenceClient.init();

      if (!aiInferenceClient.hasModel(MODEL_ID)) {
        logger.logError(
          `[orientation] inference host did not load the '${MODEL_ID}' model — ` +
          `feature will be disabled at runtime`
        );
        return false;
      }

      this.modelVersion = aiInferenceClient.getModelVersion(MODEL_ID);
      this.initialised = true;
      logger.info(
        `[orientation] ready via ai-inference-host — modelVersion=${this.modelVersion}, ` +
        `ep=${aiInferenceClient.getExecutionProvider()}`
      );
      return true;

    } catch (err) {
      logger.logError('[orientation] init failed — feature will be disabled at runtime', err);
      this.initialised = false;
      return false;
    }
  }

  /**
   * Predict the orientation class for a single image file.
   *
   * Return shape (stable contract — DO NOT change without audit of every
   * caller, in particular folder-watch-service.js):
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

    // Single-flight: wait for any in-flight prediction to finish before
    // starting a new one. Preserves the pre-refactor serialisation behaviour.
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
      // The host owns: file existence check, sharp preprocessing, ONNX
      // inference, postprocessing. We just receive the result.
      const result = await aiInferenceClient.run(MODEL_ID, { imagePath });

      // Host returns inferenceMs measured inside the host process. That
      // matches the original behaviour (original measured around the ORT
      // call). The IPC overhead is invisible to this number — that's
      // intentional, callers care about model-time, not transport-time.
      const out = {
        predictedClass: result.predictedClass,
        predictedAngle: result.predictedAngle,
        confidence: result.confidence,
        classScores: result.classScores,
        inferenceMs: result.inferenceMs,
        error: null,
      };

      if (configService.get('filmScanRotationDebugLog')) {
        logger.info(
          `[orientation] ${path.basename(imagePath)} → class ${out.predictedClass} ` +
          `angle ${out.predictedAngle}° conf ${out.confidence.toFixed(3)} (${out.inferenceMs}ms)`
        );
      }
      return out;

    } catch (err) {
      // Distinguishable error codes from the host: BAD_INPUT, MODEL_NOT_LOADED,
      // INFERENCE_FAILED, TIMEOUT, OOM. All map to graceful "no rotation".
      const code = err && err.code ? err.code : 'UNKNOWN';
      logger.logError(`[orientation] prediction failed for ${imagePath} (${code})`, err);
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

  getModelVersion() {
    return this.modelVersion;
  }

  isReady() {
    return this.initialised;
  }

  /**
   * Shutdown is a no-op from orientation-service's perspective — the
   * inference host's lifecycle is owned by the client and torn down in
   * index.js's app.before-quit handler. Kept for API compatibility with
   * the pre-refactor implementation.
   */
  async shutdown() {
    this.initialised = false;
    this.modelVersion = null;
  }
}

module.exports = new OrientationService();
