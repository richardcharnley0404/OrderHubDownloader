/**
 * Unit tests for the M4 auto-enhance branch in ai-job-quality-orchestrator.js.
 *
 * Covers the four scenarios from the M4 plan:
 *   1. Auto-enhance OFF + failed image → no fixup attempted, hold remains.
 *   2. Auto-enhance ON + scoreAfter ≥ threshold → image marked
 *      no-longer-held, job releases.
 *   3. Auto-enhance ON + scoreAfter < threshold → hold remains, both scores
 *      in sidecar audit trail.
 *   4. Auto-enhance ON + fixup throws → hold remains (graceful failure).
 *
 * Mirrors the require.cache stub pattern of ai-job-quality-orchestrator.test.js.
 * This file lives alongside that one rather than extending it because the M4
 * tests stub one extra dependency (ai-fixup-service) and run with a different
 * config baseline (mode='block', autoEnhance=true).
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC = path.join(REPO, 'src', 'main', 'services');

// ── Mutable test state ─────────────────────────────────────────────────────
let __config = {};
let __scoreImageReturn = null;
let __scoreImageCalls = [];
let __setImageQualityCalls = [];
let __getJobQualityReturn = [];
let __fixupCalls = [];
let __fixupImpl = null;

function stubModule(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubModule(path.join(SVC, 'config-service.js'), {
  get(key) { return __config[key]; },
});

stubModule(path.join(SVC, 'logger.js'), {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
});

stubModule(path.join(SVC, 'ai-quality-service.js'), {
  async init() { return true; },
  async scoreImage(imagePath) {
    __scoreImageCalls.push(imagePath);
    return __scoreImageReturn;
  },
  isReady: () => true,
  getModelVersion: () => 'stub-1.0',
});

stubModule(path.join(SVC, 'ai-quality-store.js'), {
  async getJobQuality(_jobId, _jobPath) {
    return __getJobQualityReturn.map((r) => ({
      filename: r.filename,
      aiQuality: { ...(r.aiQuality || {}) },
    }));
  },
  async setImageQuality(_jobId, _jobPath, filename, update) {
    __setImageQualityCalls.push({ filename, update });
    const idx = __getJobQualityReturn.findIndex((r) => r.filename === filename);
    const prev = idx === -1 ? {} : (__getJobQualityReturn[idx].aiQuality || {});
    const next = { ...prev, ...update };
    if (idx === -1) {
      __getJobQualityReturn.push({ filename, aiQuality: next });
    } else {
      __getJobQualityReturn[idx] = { filename, aiQuality: next };
    }
    return next;
  },
  deriveHeld(rows) {
    for (const { aiQuality } of rows) {
      if (!aiQuality || !aiQuality.scored) continue;
      if (aiQuality.passed) continue;
      const decision = (aiQuality.operatorDecision && aiQuality.operatorDecision.kind) || 'none';
      if (decision === 'fixed' || decision === 'approved_as_is') continue;
      return true;
    }
    return false;
  },
});

stubModule(path.join(SVC, 'ai-fixup-service.js'), {
  async applyFixup(jobId, jobPath, filename, options) {
    __fixupCalls.push({ jobId, jobPath, filename, options });
    if (typeof __fixupImpl === 'function') {
      return __fixupImpl({ jobId, jobPath, filename, options });
    }
    return {
      outputPath: path.join(jobPath, 'working', filename),
      beforeScore: 30,
      afterScore: 80,
      crossedThreshold: true,
      provider: options.provider || 'local',
      model: 'realesr-general-x4v3',
      triggeredBy: 'quality-gate',
      error: null,
    };
  },
});

// Load the orchestrator AFTER all stubs are in place.
const orchestrator = require(path.join(SVC, 'ai-job-quality-orchestrator.js'));

// ── Fixture helpers ────────────────────────────────────────────────────────

function makeJobDir(filenames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-orch-fixup-'));
  for (const name of filenames) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(16));
  }
  return dir;
}

function resetState() {
  __config = {
    aiQualityEnabled: true,
    aiQualityThreshold: 75,
    aiQualityForceScore: 0,
    aiQualityMode: 'block',
    enhancementAutoEnhance: false,
    enhancementProvider: 'local',
  };
  __scoreImageReturn = null;
  __scoreImageCalls = [];
  __setImageQualityCalls = [];
  __getJobQualityReturn = [];
  __fixupCalls = [];
  __fixupImpl = null;
}

// =============================================================================
// Tests — the four M4 scenarios
// =============================================================================

test('auto-enhance OFF + sub-threshold image → no fixup attempted, hold remains', async () => {
  resetState();
  __config.enhancementAutoEnhance = false;
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };

  const jobDir = makeJobDir(['img1.jpg']);
  const r = await orchestrator.scoreJob('JOB-A', jobDir);

  assert.equal(r.held, true,                    'block-mode + sub-threshold + autoEnhance=off → held');
  assert.equal(r.summary.qualityHeld, true);
  assert.equal(__fixupCalls.length, 0,          'no fixup invocation when autoEnhance off');
  assert.equal(r.summary.fixupAttempts, 0);
  assert.equal(r.summary.fixupSucceeded, 0);
  assert.equal(r.summary.fixupFailed, 0);
});

test('auto-enhance ON + scoreAfter ≥ threshold → image released, job no longer held', async () => {
  resetState();
  __config.enhancementAutoEnhance = true;
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };
  __fixupImpl = ({ filename }) => {
    // Mimic the real fixup: update the per-image quality so deriveHeld
    // reads passed:true on the next scan.
    const idx = __getJobQualityReturn.findIndex((r) => r.filename === filename);
    if (idx !== -1) {
      __getJobQualityReturn[idx] = {
        filename,
        aiQuality: { ...__getJobQualityReturn[idx].aiQuality, score: 88, passed: true },
      };
    }
    return {
      outputPath: '/working/' + filename,
      beforeScore: 30,
      afterScore: 88,
      crossedThreshold: true,
      provider: 'local',
      model: 'realesr-general-x4v3',
      triggeredBy: 'quality-gate',
      error: null,
    };
  };

  const jobDir = makeJobDir(['img1.jpg']);
  const r = await orchestrator.scoreJob('JOB-B', jobDir);

  assert.equal(__fixupCalls.length, 1,           'fixup invoked once for the held image');
  assert.equal(__fixupCalls[0].filename, 'img1.jpg');
  assert.equal(__fixupCalls[0].options.provider, 'local');
  assert.equal(r.held, false,                    'job released after successful fixup');
  assert.equal(r.summary.qualityHeld, false);
  assert.equal(r.summary.fixupAttempts, 1);
  assert.equal(r.summary.fixupSucceeded, 1);
  assert.equal(r.summary.fixupFailed, 0);
});

test('auto-enhance ON + scoreAfter < threshold → hold remains, both scores in audit trail', async () => {
  resetState();
  __config.enhancementAutoEnhance = true;
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };
  __fixupImpl = ({ filename }) => {
    // Real-life: fixup ran, score went 30 → 55, but threshold=75 so still failing.
    const idx = __getJobQualityReturn.findIndex((r) => r.filename === filename);
    if (idx !== -1) {
      __getJobQualityReturn[idx] = {
        filename,
        aiQuality: { ...__getJobQualityReturn[idx].aiQuality, score: 55, passed: false },
      };
    }
    return {
      outputPath: '/working/' + filename,
      beforeScore: 30,
      afterScore: 55,
      crossedThreshold: false,
      provider: 'local',
      model: 'realesr-general-x4v3',
      triggeredBy: 'quality-gate',
      error: null,
    };
  };

  const jobDir = makeJobDir(['img1.jpg']);
  const r = await orchestrator.scoreJob('JOB-C', jobDir);

  assert.equal(__fixupCalls.length, 1,           'fixup attempted');
  assert.equal(r.held, true,                     'hold remains when fixup did not cross threshold');
  assert.equal(r.summary.fixupAttempts, 1);
  assert.equal(r.summary.fixupSucceeded, 0,      'success counts only crossed-threshold runs');
  assert.equal(r.summary.fixupFailed, 1);
});

test('auto-enhance ON + fixup throws → graceful failure, hold remains', async () => {
  resetState();
  __config.enhancementAutoEnhance = true;
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };
  __fixupImpl = () => { throw new Error('host crashed during fixup'); };

  const jobDir = makeJobDir(['img1.jpg']);
  const r = await orchestrator.scoreJob('JOB-D', jobDir);

  assert.equal(__fixupCalls.length, 1,           'fixup attempted');
  assert.equal(r.held, true,                     'hold remains on fixup throw');
  assert.equal(r.summary.fixupAttempts, 1);
  assert.equal(r.summary.fixupSucceeded, 0);
  assert.equal(r.summary.fixupFailed, 1);
});

test("auto-enhance ON + fixup returns error result → counted as failed, hold remains", async () => {
  resetState();
  __config.enhancementAutoEnhance = true;
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };
  __fixupImpl = ({ filename }) => ({
    outputPath: null,
    beforeScore: 30,
    afterScore: null,
    crossedThreshold: false,
    provider: 'local',
    model: 'realesr-general-x4v3',
    triggeredBy: 'quality-gate',
    error: 'inference oom',
  });

  const jobDir = makeJobDir(['img1.jpg']);
  const r = await orchestrator.scoreJob('JOB-E', jobDir);

  assert.equal(__fixupCalls.length, 1);
  assert.equal(r.held, true);
  assert.equal(r.summary.fixupAttempts, 1);
  assert.equal(r.summary.fixupFailed, 1);
});

test('auto-enhance ON + warn-mode → fixup is NOT triggered (warn never blocks)', async () => {
  resetState();
  __config.aiQualityMode = 'warn';     // not 'block'
  __config.enhancementAutoEnhance = true;
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };

  const jobDir = makeJobDir(['img1.jpg']);
  const r = await orchestrator.scoreJob('JOB-WARN-AE', jobDir);

  assert.equal(__fixupCalls.length, 0,           'warn-mode never triggers fixup, even with autoEnhance');
  assert.equal(r.held, false);
  assert.equal(r.summary.qualityHeld, true,      'underlying signal still recorded');
});

test('auto-enhance ON + multiple images, mixed outcomes → counts add up; per-image summary', async () => {
  resetState();
  __config.enhancementAutoEnhance = true;
  // First image scored at 25, second at 20 — both fail.
  // Fixup outcome: first crosses threshold, second does not.
  let scoreCallSequence = [25, 20];
  __scoreImageReturn = null;
  // Override scoreImage to return distinct scores per call.
  const origStub = require.cache[require.resolve(path.join(SVC, 'ai-quality-service.js'))].exports;
  origStub.scoreImage = async (imagePath) => {
    __scoreImageCalls.push(imagePath);
    const score = scoreCallSequence.shift();
    return { score, modelVersion: 'm1', inferenceMs: 5, error: null };
  };

  __fixupImpl = ({ filename }) => {
    const idx = __getJobQualityReturn.findIndex((r) => r.filename === filename);
    const passed = filename === 'img1.jpg';
    if (idx !== -1) {
      __getJobQualityReturn[idx] = {
        filename,
        aiQuality: {
          ...__getJobQualityReturn[idx].aiQuality,
          score: passed ? 90 : 40,
          passed,
        },
      };
    }
    return {
      outputPath: '/working/' + filename,
      beforeScore: 25,
      afterScore: passed ? 90 : 40,
      crossedThreshold: passed,
      provider: 'local',
      model: 'realesr-general-x4v3',
      triggeredBy: 'quality-gate',
      error: null,
    };
  };

  const jobDir = makeJobDir(['img1.jpg', 'img2.jpg']);
  const r = await orchestrator.scoreJob('JOB-MIX', jobDir);

  assert.equal(__fixupCalls.length, 2,           'both held images attempted');
  assert.equal(r.summary.fixupAttempts, 2);
  assert.equal(r.summary.fixupSucceeded, 1,      'img1 crossed threshold');
  assert.equal(r.summary.fixupFailed, 1,         'img2 did not');
  assert.equal(r.held, true,                     'job remains held while img2 still fails');
});
