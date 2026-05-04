/**
 * Unit tests for src/main/services/ai-fixup-service.js — the quality-gate-
 * triggered enhancement path.
 *
 * Stubs every dependency the fixup service requires so the tests run fast
 * and don't touch the inference host, sharp, or a real ONNX model. Same
 * pattern as enhancementManager.test.js / ai-job-quality-orchestrator.test.js.
 *
 * Coverage:
 *   - Local provider happy path: low score → enhance → high score →
 *     crossedThreshold true; sidecar gets the new score, fixupHistory entry,
 *     flat enhancement fields with triggeredBy='quality-gate'.
 *   - Topaz provider happy path: same shape, different client.
 *   - Enhancement failure: client throws → no working-file mutation, no
 *     flat-fields write, fixupHistory records the error.
 *   - Rescore failure: enhance succeeds, scoreImage throws → afterScore=null,
 *     aiQuality.passed stays false, sidecar audit captures the error.
 *   - Originals snapshot triggered before working-file modification.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC = path.join(REPO, 'src', 'main', 'services');
const ENH = path.join(REPO, 'src', 'main', 'enhancement');
const JOBS = path.join(REPO, 'src', 'main', 'jobs');

// ── Mutable test state read by the stubs ─────────────────────────────────────
let __config = {};
let __scoreSequence = [];
let __scoreCalls = [];
let __localEnhanceCalls = [];
let __topazEnhanceCalls = [];
let __localEnhanceMeta = null;
let __localEnhanceImpl = null;
let __topazEnhanceImpl = null;
let __ensureWorkingSetupCalls = [];
let __ensureOriginalsCalls = [];
let __sidecar = null;
let __savedSidecars = [];

function stubModule(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubModule(path.join(SVC, 'logger.js'), {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
});

stubModule(path.join(SVC, 'config-service.js'), {
  get(key) { return __config[key]; },
});

stubModule(path.join(SVC, 'ai-quality-service.js'), {
  async init() { return true; },
  async scoreImage(imagePath) {
    __scoreCalls.push(imagePath);
    if (__scoreSequence.length === 0) {
      return { score: 50, modelVersion: 'stub-musiq-v1', error: null };
    }
    const next = __scoreSequence.shift();
    if (next instanceof Error) throw next;
    return next;
  },
  isReady: () => true,
  getModelVersion: () => 'stub-musiq-v1',
});

stubModule(path.join(SVC, 'ai-inference-client.js'), {
  async init() { return true; },
  hasModel() { return true; },
  async runTile() { throw new Error('runTile not used in fixup tests'); },
  getExecutionProvider() { return 'cpu'; },
});

stubModule(path.join(JOBS, 'originalsManager.js'), {
  async ensureWorkingSetup(jobPath) {
    __ensureWorkingSetupCalls.push(jobPath);
    // Mimic real behaviour: if /working/ is empty, populate from job root.
    const wDir = path.join(jobPath, 'working');
    const oDir = path.join(jobPath, 'originals');
    await fsp.mkdir(wDir, { recursive: true });
    await fsp.mkdir(oDir, { recursive: true });
    const wEntries = await fsp.readdir(wDir).catch(() => []);
    if (wEntries.length === 0) {
      const rootEntries = await fsp.readdir(jobPath).catch(() => []);
      for (const name of rootEntries) {
        if (!/\.(jpg|jpeg|png|tif|tiff)$/i.test(name)) continue;
        const src = path.join(jobPath, name);
        const stat = await fsp.stat(src).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        await fsp.copyFile(src, path.join(wDir, name));
        await fsp.copyFile(src, path.join(oDir, name));
      }
    }
  },
  async ensureOriginals(jobPath) {
    __ensureOriginalsCalls.push(jobPath);
    const wDir = path.join(jobPath, 'working');
    const oDir = path.join(jobPath, 'originals');
    await fsp.mkdir(oDir, { recursive: true });
    const entries = await fsp.readdir(wDir).catch(() => []);
    for (const name of entries) {
      const dst = path.join(oDir, name);
      try { await fsp.access(dst); }
      catch { await fsp.copyFile(path.join(wDir, name), dst); }
    }
  },
});

stubModule(path.join(JOBS, 'sidecarManager.js'), {
  async loadSidecar(jobId, _jobPath) {
    if (!__sidecar) {
      __sidecar = {
        jobId,
        version: 1,
        images: [{
          filename: 'test.jpg',
          enhanced: false,
          aiQuality: {
            scored: true,
            score: 25,
            passed: false,
            modelVersion: 'stub-musiq-v1',
            fixupHistory: [],
            operatorDecision: { kind: 'none', decidedAt: null, note: null },
          },
        }],
      };
    }
    return {
      sidecar: JSON.parse(JSON.stringify(__sidecar)),
      filenames: __sidecar.images.map((i) => i.filename),
    };
  },
  async saveSidecar(sidecar, _jobPath) {
    __savedSidecars.push(JSON.parse(JSON.stringify(sidecar)));
    __sidecar = JSON.parse(JSON.stringify(sidecar));
    return sidecar;
  },
});

stubModule(path.join(ENH, 'localClient.js'), {
  async enhance(destPath, options) {
    __localEnhanceCalls.push({ destPath, options });
    if (typeof __localEnhanceImpl === 'function') {
      await __localEnhanceImpl(destPath, options);
    }
    return __localEnhanceMeta;
  },
  async startEnhancement() { return 'local_x'; },
  async checkEnhancement() { return { status: 'succeeded' }; },
  async cancelEnhancement() {},
  async selfTest() { return { ok: true, durationMs: 1 }; },
});

stubModule(path.join(ENH, 'topazClient.js'), {
  async enhance(destPath, options, _apiKey) {
    __topazEnhanceCalls.push({ destPath, options });
    if (typeof __topazEnhanceImpl === 'function') {
      await __topazEnhanceImpl(destPath, options);
    }
  },
  async testApiKey() { return { valid: true }; },
});

// ai-quality-store is real — stubs above provide its sidecarManager dep.
const aiFixupService = require(path.join(SVC, 'ai-fixup-service.js'));

// ── Test fixture helpers ─────────────────────────────────────────────────────

async function setupJobDir(filename = 'test.jpg') {
  const jobPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-fixup-test-'));
  // Place a fake "image" file at the job root (Mode-1 layout) so
  // ensureWorkingSetup bootstraps both /working/ and /originals/.
  await fsp.writeFile(path.join(jobPath, filename), Buffer.from('fake-jpeg-pre-' + filename));
  return jobPath;
}

function resetStubs() {
  __config = {
    enhancementProvider: 'local',
    aiQualityThreshold: 50,
    aiQualityMode: 'block',
  };
  __scoreSequence = [];
  __scoreCalls = [];
  __localEnhanceCalls = [];
  __topazEnhanceCalls = [];
  __localEnhanceMeta = null;
  __localEnhanceImpl = null;
  __topazEnhanceImpl = null;
  __ensureWorkingSetupCalls = [];
  __ensureOriginalsCalls = [];
  __sidecar = null;
  __savedSidecars = [];
}

// Convenience: set the sidecar's existing aiQuality.score for the fixture.
function setExistingScore(scoreValue, modelVersion = 'stub-musiq-v1') {
  __sidecar = {
    jobId: 'JOB1',
    version: 1,
    images: [{
      filename: 'test.jpg',
      enhanced: false,
      aiQuality: {
        scored: true,
        score: scoreValue,
        passed: scoreValue >= 50,
        modelVersion,
        fixupHistory: [],
        operatorDecision: { kind: 'none', decidedAt: null, note: null },
      },
    }],
  };
}

// =============================================================================
// Tests
// =============================================================================

test("applyFixup('local'): low → enhance → high → crossedThreshold true; full sidecar update", async () => {
  resetStubs();
  setExistingScore(28);
  __scoreSequence = [
    { score: 76, modelVersion: 'stub-musiq-v1', error: null }, // post-enhance rescore
  ];
  __localEnhanceMeta = {
    inferenceMs: 5000,
    tileCount: 4,
    tileSize: 256,
    tileOverlap: 16,
    executionProvider: 'cpu',
    sourceWidth: 320, sourceHeight: 400,
    outputWidth: 1280, outputHeight: 1600,
  };

  const jobPath = await setupJobDir();
  const result = await aiFixupService.applyFixup('JOB1', jobPath, 'test.jpg');

  assert.equal(result.error, null,        'no error on happy path');
  assert.equal(result.beforeScore, 28,    'beforeScore read from sidecar');
  assert.equal(result.afterScore, 76,     'afterScore from rescore');
  assert.equal(result.crossedThreshold, true, 'crossedThreshold true');
  assert.equal(result.provider, 'local');
  assert.equal(result.model, 'realesr-general-x4v3');
  assert.equal(result.triggeredBy, 'quality-gate');

  // ensureWorkingSetup ran before any modification.
  assert.equal(__ensureWorkingSetupCalls.length, 1);
  assert.equal(__ensureWorkingSetupCalls[0], jobPath);
  // /originals/ snapshot exists.
  assert.ok(fs.existsSync(path.join(jobPath, 'originals', 'test.jpg')));
  // localClient.enhance called on the cache path.
  assert.equal(__localEnhanceCalls.length, 1);
  assert.match(__localEnhanceCalls[0].destPath, /cache[/\\]test_enhanced\.jpg$/);

  // Sidecar reflects the fixup. The aiQuality block was updated and a flat
  // enhancement record was written; final saved sidecar has both.
  const final = __savedSidecars[__savedSidecars.length - 1];
  const img = final.images.find(i => i.filename === 'test.jpg');
  assert.equal(img.aiQuality.score, 76,   'aiQuality.score updated');
  assert.equal(img.aiQuality.passed, true,'aiQuality.passed set');
  assert.equal(img.enhanced, true,        'flat enhanced field set');
  assert.equal(img.enhancementSource, 'local');
  assert.equal(img.scoreBefore, 28);
  assert.equal(img.scoreAfter, 76);
  assert.equal(img.scoreModel, 'stub-musiq-v1');
  assert.equal(img.enhancementTriggeredBy, 'quality-gate');
  assert.equal(img.provider, 'local');
  assert.equal(img.tileCount, 4);
  assert.equal(img.executionProvider, 'cpu');

  // fixupHistory has at least one entry.
  assert.ok(Array.isArray(img.aiQuality.fixupHistory));
  const last = img.aiQuality.fixupHistory[img.aiQuality.fixupHistory.length - 1];
  assert.equal(last.provider, 'local');
  assert.equal(last.triggeredBy, 'quality-gate');
  assert.equal(last.scoreBefore, 28);
  assert.equal(last.scoreAfter, 76);
  assert.equal(last.crossedThreshold, true);
  assert.equal(last.error, null);
});

test("applyFixup('topaz'): low → enhance → high → crossedThreshold true; topaz path used", async () => {
  resetStubs();
  __config.enhancementProvider = 'topaz';
  __config.topazApiKey = 'tpz-real';
  __config.topazDefaultModel = 'Standard V2';
  setExistingScore(33);
  __scoreSequence = [
    { score: 81, modelVersion: 'stub-musiq-v1', error: null },
  ];

  const jobPath = await setupJobDir();
  const result = await aiFixupService.applyFixup('JOB1', jobPath, 'test.jpg');

  assert.equal(result.error, null);
  assert.equal(result.crossedThreshold, true);
  assert.equal(result.provider, 'topaz');
  assert.equal(result.beforeScore, 33);
  assert.equal(result.afterScore, 81);
  assert.equal(result.triggeredBy, 'quality-gate');
  assert.equal(__topazEnhanceCalls.length, 1, 'topazClient called');
  assert.equal(__localEnhanceCalls.length, 0, 'localClient NOT called');

  const final = __savedSidecars[__savedSidecars.length - 1];
  const img = final.images.find(i => i.filename === 'test.jpg');
  assert.equal(img.enhancementSource, 'topaz-direct');
  assert.equal(img.provider, 'topaz');
  // Topaz does not populate local-only fields.
  assert.equal(img.tileCount, undefined);
});

test("applyFixup: enhancement throws → no working-file mutation, fixupHistory records error", async () => {
  resetStubs();
  setExistingScore(20);
  __localEnhanceImpl = async () => { throw new Error('inference oom'); };
  __localEnhanceMeta = null;

  const jobPath = await setupJobDir();
  const workingPath = path.join(jobPath, 'working', 'test.jpg');

  // Capture the working file's pre-enhance bytes — must not change after failed fixup.
  // (ensureWorkingSetup runs first and copies root → working, so the bytes
  // here reflect the bootstrap.)
  // Read after the test runs.
  const result = await aiFixupService.applyFixup('JOB1', jobPath, 'test.jpg');

  assert.match(result.error || '', /inference oom/);
  assert.equal(result.afterScore, null);
  assert.equal(result.crossedThreshold, false);
  // Rescore was NOT attempted because enhancement failed.
  assert.equal(__scoreCalls.length, 0);

  // The working file content should equal /originals/ content (unmutated).
  const workingBytes = fs.readFileSync(workingPath);
  const originalsBytes = fs.readFileSync(path.join(jobPath, 'originals', 'test.jpg'));
  assert.deepEqual(workingBytes, originalsBytes, 'working file unchanged on failure');

  // Sidecar records the failed attempt in fixupHistory; the flat
  // enhancement fields are NOT written.
  // (loadSidecar/saveSidecar may have been called by the fixupHistory append
  //  path — verify by reading the latest sidecar state.)
  const finalImg = __sidecar.images.find(i => i.filename === 'test.jpg');
  assert.equal(finalImg.enhanced, false, 'enhanced flag not flipped');
  assert.equal(finalImg.scoreAfter, undefined, 'scoreAfter not written');
  // fixupHistory has one error entry.
  const history = finalImg.aiQuality.fixupHistory;
  assert.ok(Array.isArray(history) && history.length >= 1);
  assert.match(history[history.length - 1].error || '', /inference oom/);
});

test('applyFixup: rescore throws → afterScore=null, error captured, image stays held', async () => {
  resetStubs();
  setExistingScore(30);
  __localEnhanceMeta = {
    inferenceMs: 100, tileCount: 1, tileSize: 256, tileOverlap: 16,
    executionProvider: 'cpu',
    sourceWidth: 100, sourceHeight: 100, outputWidth: 400, outputHeight: 400,
  };
  // Rescore returns an error result rather than throwing — the contract for
  // ai-quality-service.scoreImage is "never throws"; the .error field signals
  // failure. The fixup service treats both as "no usable score".
  __scoreSequence = [
    { score: 0, modelVersion: null, error: 'host crashed mid-rescore' },
  ];

  const jobPath = await setupJobDir();
  const result = await aiFixupService.applyFixup('JOB1', jobPath, 'test.jpg');

  assert.equal(result.afterScore, null);
  assert.equal(result.crossedThreshold, false);
  assert.match(result.error || '', /host crashed/);
  // Enhancement DID complete (working file was overwritten with cache).
  // We don't strictly need to assert the bytes, but rescore was attempted.
  assert.equal(__scoreCalls.length, 1, 'rescore was attempted');

  // Sidecar: aiQuality.passed remains false, aiQuality.error captures the rescore error.
  const final = __savedSidecars[__savedSidecars.length - 1];
  const img = final.images.find(i => i.filename === 'test.jpg');
  assert.equal(img.aiQuality.passed, false, 'image stays not-passed when rescore fails');
  assert.match(img.aiQuality.error || '', /host crashed/);
  // aiQuality.score keeps the pre-fixup value (we have no fresh number).
  assert.equal(img.aiQuality.score, 30);
});

test('applyFixup: ensureWorkingSetup is called before any working-file modification', async () => {
  resetStubs();
  setExistingScore(20);
  __localEnhanceMeta = {
    inferenceMs: 100, tileCount: 1, tileSize: 256, tileOverlap: 16,
    executionProvider: 'cpu',
    sourceWidth: 100, sourceHeight: 100, outputWidth: 400, outputHeight: 400,
  };
  __scoreSequence = [{ score: 70, modelVersion: 'stub-musiq-v1', error: null }];

  const jobPath = await setupJobDir();
  await aiFixupService.applyFixup('JOB1', jobPath, 'test.jpg');

  assert.equal(__ensureWorkingSetupCalls.length, 1);
  assert.ok(fs.existsSync(path.join(jobPath, 'originals', 'test.jpg')),
    'originals snapshot exists post-fixup');
});

test('applyFixup: image not found → graceful failure, no provider call', async () => {
  resetStubs();
  setExistingScore(20);
  __localEnhanceMeta = null;

  const jobPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-fixup-empty-'));
  // No images in the job — ensureWorkingSetup creates empty /working/ + /originals/.
  const result = await aiFixupService.applyFixup('JOB1', jobPath, 'missing.jpg');

  assert.match(result.error || '', /image not found/);
  assert.equal(__localEnhanceCalls.length, 0, 'provider NOT called');
  assert.equal(result.afterScore, null);
});

test("applyFixup('topaz'): missing api key → graceful failure, history records error", async () => {
  resetStubs();
  __config.enhancementProvider = 'topaz';
  __config.topazApiKey = ''; // unset
  setExistingScore(30);

  const jobPath = await setupJobDir();
  const result = await aiFixupService.applyFixup('JOB1', jobPath, 'test.jpg');

  assert.match(result.error || '', /Topaz API key/);
  assert.equal(result.crossedThreshold, false);
  assert.equal(__topazEnhanceCalls.length, 0, 'topaz client NOT called when key missing');
});
