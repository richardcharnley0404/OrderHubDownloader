/**
 * src/main/services/ai-quality-service.js
 *
 * Domain service for AI image-quality scoring (AI Quality Gate, M1+M2).
 *
 * Public API:
 *   await aiQualityService.scoreImage(imagePath)
 *     → { score, modelVersion, inferenceMs, error }
 *
 *   aiQualityService.isReady()         // true when MUSIQ model is loaded
 *   aiQualityService.getModelVersion()
 *
 * The service is the single chokepoint between callers (the orchestrator)
 * and the inference host. It owns:
 *   - The feature flag check (`aiQualityEnabled`).
 *   - The "force score" debug knob (`aiQualityForceScore`) — bypasses
 *     inference entirely, returns the configured value. Used to test the
 *     held-job path without needing a deliberately-bad image.
 *   - Graceful failure: if the host throws, the model isn't loaded, or the
 *     image is unreadable, we return `{ score: 100, error: '...' }` so the
 *     job continues through the existing pipeline (treat scoring failures
 *     as pass).
 */

'use strict';

const path = require('path');
const configService = require('./config-service');
const logger = require('./logger');
const aiInferenceClient = require('./ai-inference-client');

const MODEL_ID = 'musiq';

class AIQualityService {
  constructor() {
    this.initialised = false;
    this.modelVersion = null;
    // Single-flight guard at the service level — multiple concurrent jobs
    // would otherwise race the host's single MUSIQ session.
    this._inFlight = null;
  }

  async init() {
    if (this.initialised) return true;

    try {
      const enabled = configService.get('aiQualityEnabled');
      if (!enabled) {
        logger.info('[ai-quality] feature flag OFF — skipping init');
        return false;
      }

      // Spawning the host is idempotent; orientation may already have done it.
      await aiInferenceClient.init();

      if (!aiInferenceClient.hasModel(MODEL_ID)) {
        // Not a fatal error — without the model, the service still runs but
        // every score returns 100 (or the forced value). This lets the
        // plumbing ship before the .onnx file is bundled.
        logger.logWarning(
          `[ai-quality] '${MODEL_ID}' model not loaded by inference host — ` +
          `scoring will return passing scores until the model is added at ` +
          `resources/models/musiq/model.onnx`
        );
        this.initialised = true;
        return true;
      }

      this.modelVersion = aiInferenceClient.getModelVersion(MODEL_ID);
      this.initialised = true;
      logger.info(
        `[ai-quality] ready via ai-inference-host — modelVersion=${this.modelVersion}, ` +
        `ep=${aiInferenceClient.getExecutionProvider()}`
      );
      return true;

    } catch (err) {
      logger.logError('[ai-quality] init failed — feature will be disabled at runtime', err);
      this.initialised = false;
      return false;
    }
  }

  isReady() {
    return this.initialised;
  }

  getModelVersion() {
    return this.modelVersion;
  }

  /**
   * Score a single image. Always returns a well-formed result; never throws.
   *
   * Return shape (stable contract):
   *   {
   *     score: number          // 0-100; 100 means "treat as pass"
   *     modelVersion: string|null
   *     inferenceMs: number
   *     error: string | null
   *   }
   */
  async scoreImage(imagePath) {
    const startedAt = Date.now();

    if (!this.initialised) {
      const ok = await this.init();
      if (!ok) {
        return this._passResult(Date.now() - startedAt, 'service not initialised');
      }
    }

    // Debug override — short-circuits real inference.
    const forced = configService.get('aiQualityForceScore');
    if (forced && forced > 0) {
      const result = {
        score: forced,
        modelVersion: 'forced',
        inferenceMs: Date.now() - startedAt,
        error: null,
      };
      this._maybeDebugLog(imagePath, result, 'forced');
      return result;
    }

    // No model loaded — every score passes.
    if (!aiInferenceClient.hasModel(MODEL_ID)) {
      return this._passResult(Date.now() - startedAt, null);
    }

    // Single-flight: serialise concurrent calls so the host's single MUSIQ
    // session is never hit in parallel.
    if (this._inFlight) {
      try { await this._inFlight; } catch (_) { /* ignored */ }
    }
    this._inFlight = this._runScore(imagePath, startedAt);
    try {
      return await this._inFlight;
    } finally {
      this._inFlight = null;
    }
  }

  async _runScore(imagePath, startedAt) {
    try {
      const result = await aiInferenceClient.run(MODEL_ID, { imagePath });
      const out = {
        score: typeof result.score === 'number' ? result.score : 100,
        modelVersion: this.modelVersion,
        inferenceMs: result.inferenceMs || (Date.now() - startedAt),
        error: null,
      };
      this._maybeDebugLog(imagePath, out, 'real');
      return out;
    } catch (err) {
      const code = err && err.code ? err.code : 'UNKNOWN';
      logger.logError(`[ai-quality] scoring failed for ${imagePath} (${code})`, err);
      return this._passResult(Date.now() - startedAt, err.message || String(err));
    }
  }

  _passResult(inferenceMs, errorMessage) {
    return {
      score: 100,
      modelVersion: null,
      inferenceMs,
      error: errorMessage || null,
    };
  }

  _maybeDebugLog(imagePath, result, source) {
    if (!configService.get('aiQualityDebugLog')) return;
    logger.info(
      `[ai-quality] ${path.basename(imagePath)} → score ${result.score} ` +
      `(${result.inferenceMs}ms, ${source})`
    );
  }
}

module.exports = new AIQualityService();
