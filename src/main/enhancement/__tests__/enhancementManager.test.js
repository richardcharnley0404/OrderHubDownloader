/**
 * Integration-style tests for src/main/enhancement/enhancementManager.js.
 *
 * The manager depends on a chain of disk + native services (logger,
 * config-service, ai-quality-service, ai-inference-client, originalsManager,
 * sidecarManager, localClient, topazClient). To keep tests fast and free
 * of native ML deps, all of those are stubbed via require.cache before the
 * manager is loaded — same pattern as ai-job-quality-orchestrator.test.js.
 *
 * What these tests cover:
 *   - Provider routing for 'local' and 'topaz' through enhanceImage().
 *   - Originals snapshot on first enhancement of a job.
 *   - Universal rescore: scoreBefore captured from working file, scoreAfter
 *     captured from cache after enhancement, both written to the sidecar.
 *   - Provider-specific sidecar metadata (tileCount, modelVersion,
 *     executionProvider for local; just provider tag for topaz).
 *   - Defensive remap of stored 'replicate' provider value to 'local'.
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

// ── Stub state read by mocked modules ────────────────────────────────────────
let __config = {};
let __scoreSequence = [];          // shift()ed by ai-quality-service.scoreImage
let __scoreCalls = [];
let __localEnhanceCalls = [];
let __topazEnhanceCalls = [];
let __localEnhanceMeta = null;     // returned by localClient.enhance()
let __localEnhanceImpl = null;     // optional override that runs custom code on the cache file
let __ensureOriginalsCalls = [];
let __sidecarStore = null;         // { sidecar, filenames }
let __savedSidecars = [];

function stubModule(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Stub before requiring the manager.
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
    return __scoreSequence.shift();
  },
  isReady: () => true,
  getModelVersion: () => 'stub-musiq-v1',
});

stubModule(path.join(SVC, 'ai-inference-client.js'), {
  async init() { return true; },
  hasModel(_id) { return true; },
  async runTile() { throw new Error('runTile not used in these tests'); },
  getExecutionProvider() { return 'cpu'; },
});

stubModule(path.join(JOBS, 'originalsManager.js'), {
  async ensureOriginals(jobPath) {
    __ensureOriginalsCalls.push(jobPath);
    // Mimic real behaviour: copy /working/ → /originals/ on first call.
    const wDir = path.join(jobPath, 'working');
    const oDir = path.join(jobPath, 'originals');
    try {
      await fsp.mkdir(oDir, { recursive: true });
      const entries = await fsp.readdir(wDir);
      for (const name of entries) {
        const src = path.join(wDir, name);
        const dst = path.join(oDir, name);
        try { await fsp.access(dst); } catch { await fsp.copyFile(src, dst); }
      }
    } catch (_) { /* ignore — directory may not exist in some tests */ }
  },
});

stubModule(path.join(JOBS, 'sidecarManager.js'), {
  async loadSidecar(jobId, jobPath) {
    if (!__sidecarStore) {
      __sidecarStore = {
        sidecar: { jobId, version: 1, images: [{ filename: 'test.jpg', enhanced: false }] },
        filenames: ['test.jpg'],
      };
    }
    // Deep-clone so tests can assert against the saved value separately.
    return {
      sidecar: JSON.parse(JSON.stringify(__sidecarStore.sidecar)),
      filenames: [...__sidecarStore.filenames],
    };
  },
  async saveSidecar(sidecar, _jobPath) {
    __savedSidecars.push(JSON.parse(JSON.stringify(sidecar)));
    __sidecarStore.sidecar = JSON.parse(JSON.stringify(sidecar));
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
  async startEnhancement(_destPath, _options) { return 'local_stub_id'; },
  async checkEnhancement(_id) { return { status: 'succeeded' }; },
  async cancelEnhancement(_id) {},
});

stubModule(path.join(ENH, 'topazClient.js'), {
  async enhance(destPath, options, _apiKey) {
    __topazEnhanceCalls.push({ destPath, options });
    // Simulate Topaz overwriting the cache file in place — actually do
    // nothing since the file was just copied from working/.
  },
  async testApiKey(_apiKey) { return { valid: true }; },
});

// Now load the manager — all its require() calls hit the stubs above.
const enhancementManager = require(path.join(ENH, 'enhancementManager.js'));

// ── Test fixture helpers ─────────────────────────────────────────────────────

async function setupJobDir(filename = 'test.jpg') {
  const jobPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-mgr-test-'));
  const wDir = path.join(jobPath, 'working');
  await fsp.mkdir(wDir);
  // The "image" doesn't need to be real — manager.copyFile handles bytes.
  await fsp.writeFile(path.join(wDir, filename), Buffer.from('fake-jpeg-bytes-' + filename));
  return jobPath;
}

function resetStubs() {
  __config = {};
  __scoreSequence = [];
  __scoreCalls = [];
  __localEnhanceCalls = [];
  __topazEnhanceCalls = [];
  __localEnhanceMeta = null;
  __localEnhanceImpl = null;
  __ensureOriginalsCalls = [];
  __sidecarStore = null;
  __savedSidecars = [];
}

// =============================================================================
// Tests
// =============================================================================

test("enhanceImage('local'): full happy path — originals snapshot, cache file, scoreBefore/After, provider meta", async () => {
  resetStubs();
  __config.enhancementProvider = 'local';
  __config.enhancementRescoreAfter = true;
  __scoreSequence = [
    { score: 38, modelVersion: 'stub-musiq-v1', error: null }, // before
    { score: 67, modelVersion: 'stub-musiq-v1', error: null }, // after
  ];
  __localEnhanceMeta = {
    inferenceMs: 12345,
    tileCount: 4,
    tileSize: 256,
    tileOverlap: 16,
    executionProvider: 'cpu',
    sourceWidth: 320,
    sourceHeight: 400,
    outputWidth: 1280,
    outputHeight: 1600,
  };

  const jobPath = await setupJobDir();

  const cachePath = await enhancementManager.enhanceImage('JOB1', jobPath, 'test.jpg');

  // 1. Originals snapshot triggered.
  assert.equal(__ensureOriginalsCalls.length, 1, 'originalsManager.ensureOriginals called once');
  assert.equal(__ensureOriginalsCalls[0], jobPath);
  // 2. /originals/ has the snapshot.
  assert.ok(fs.existsSync(path.join(jobPath, 'originals', 'test.jpg')), '/originals/test.jpg exists');
  // 3. Cache file written.
  assert.ok(fs.existsSync(cachePath), 'cache file exists');
  assert.equal(cachePath, path.join(jobPath, 'cache', 'test_enhanced.jpg'));
  // 4. localClient.enhance was the one called, not topaz.
  assert.equal(__localEnhanceCalls.length, 1);
  assert.equal(__topazEnhanceCalls.length, 0);
  assert.equal(__localEnhanceCalls[0].destPath, cachePath);
  // 5. Working file overwritten with cache content (we just verify the bytes
  //    are now whatever was in the cache after enhance — for our stub, the
  //    cache is a copy of working, so no change in bytes; we verify size).
  const wBytes = fs.readFileSync(path.join(jobPath, 'working', 'test.jpg'));
  const cBytes = fs.readFileSync(cachePath);
  assert.deepEqual(wBytes, cBytes, 'working/ file was updated from cache');
  // 6. Sidecar reflects scores + provider meta.
  assert.ok(__savedSidecars.length >= 1);
  const final = __savedSidecars[__savedSidecars.length - 1];
  const img = final.images.find(i => i.filename === 'test.jpg');
  assert.ok(img, 'image entry in sidecar');
  assert.equal(img.enhanced, true);
  assert.equal(img.scoreBefore, 38);
  assert.equal(img.scoreAfter, 67);
  assert.equal(img.scoreModel, 'stub-musiq-v1');
  assert.equal(img.enhancementSource, 'local');
  assert.equal(img.enhancementModel, 'realesr-general-x4v3');
  assert.equal(img.provider, 'local');
  assert.equal(img.modelVersion, 'realesr-general-x4v3');
  assert.equal(img.tileCount, 4);
  assert.equal(img.tileSize, 256);
  assert.equal(img.tileOverlap, 16);
  assert.equal(img.executionProvider, 'cpu');
  assert.equal(img.outputWidth, 1280);
  assert.equal(img.enhancementTriggeredBy, 'operator');
});

test("enhanceImage('topaz'): Topaz path runs and writes scoreBefore/After (universal rescore)", async () => {
  resetStubs();
  __config.enhancementProvider = 'topaz';
  __config.topazApiKey = 'fake-key';
  __config.topazDefaultModel = 'Standard V2';
  __config.enhancementRescoreAfter = true;
  __scoreSequence = [
    { score: 55, modelVersion: 'stub-musiq-v1', error: null },
    { score: 78, modelVersion: 'stub-musiq-v1', error: null },
  ];

  const jobPath = await setupJobDir();
  const cachePath = await enhancementManager.enhanceImage('JOB2', jobPath, 'test.jpg');

  assert.equal(__topazEnhanceCalls.length, 1, 'topazClient.enhance called');
  assert.equal(__localEnhanceCalls.length, 0, 'localClient.enhance NOT called');
  assert.ok(fs.existsSync(cachePath));
  const final = __savedSidecars[__savedSidecars.length - 1];
  const img = final.images.find(i => i.filename === 'test.jpg');
  assert.equal(img.scoreBefore, 55);
  assert.equal(img.scoreAfter, 78);
  assert.equal(img.enhancementSource, 'topaz-direct');
  assert.equal(img.provider, 'topaz');
  assert.equal(img.scoreModel, 'stub-musiq-v1');
  // Topaz path should NOT have local-only fields.
  assert.equal(img.tileCount, undefined);
  assert.equal(img.executionProvider, undefined);
});

test("enhanceImage('local'): rescore disabled → scoreBefore/After absent, scoring service not called", async () => {
  resetStubs();
  __config.enhancementProvider = 'local';
  __config.enhancementRescoreAfter = false;
  __localEnhanceMeta = {
    inferenceMs: 100, tileCount: 1, tileSize: 256, tileOverlap: 16,
    executionProvider: 'cpu',
    sourceWidth: 100, sourceHeight: 100, outputWidth: 400, outputHeight: 400,
  };
  const jobPath = await setupJobDir();

  await enhancementManager.enhanceImage('JOB3', jobPath, 'test.jpg');

  assert.equal(__scoreCalls.length, 0, 'scoreImage not called when rescore disabled');
  const final = __savedSidecars[__savedSidecars.length - 1];
  const img = final.images.find(i => i.filename === 'test.jpg');
  assert.equal(img.scoreBefore, undefined);
  assert.equal(img.scoreAfter, undefined);
  assert.equal(img.enhanced, true, 'still marked enhanced');
});

test("enhanceImage('local'): scoring failure does not block enhancement", async () => {
  resetStubs();
  __config.enhancementProvider = 'local';
  __config.enhancementRescoreAfter = true;
  // Both calls return error: maybeRescore should swallow and return null.
  __scoreSequence = [
    { score: 100, modelVersion: null, error: 'mock failure' },
    { score: 100, modelVersion: null, error: 'mock failure' },
  ];
  __localEnhanceMeta = {
    inferenceMs: 100, tileCount: 1, tileSize: 256, tileOverlap: 16,
    executionProvider: 'cpu',
    sourceWidth: 100, sourceHeight: 100, outputWidth: 400, outputHeight: 400,
  };
  const jobPath = await setupJobDir();

  const cachePath = await enhancementManager.enhanceImage('JOB4', jobPath, 'test.jpg');

  assert.ok(fs.existsSync(cachePath), 'cache still written despite scoring failures');
  const final = __savedSidecars[__savedSidecars.length - 1];
  const img = final.images.find(i => i.filename === 'test.jpg');
  assert.equal(img.enhanced, true);
  assert.equal(img.scoreBefore, undefined);
  assert.equal(img.scoreAfter, undefined);
});

test("enhanceImage(): defensive remap — stored 'replicate' provider routes to local", async () => {
  resetStubs();
  __config.enhancementProvider = 'replicate'; // legacy stored value
  __config.enhancementRescoreAfter = false;
  __localEnhanceMeta = {
    inferenceMs: 100, tileCount: 1, tileSize: 256, tileOverlap: 16,
    executionProvider: 'cpu',
    sourceWidth: 100, sourceHeight: 100, outputWidth: 400, outputHeight: 400,
  };
  const jobPath = await setupJobDir();

  await enhancementManager.enhanceImage('JOB5', jobPath, 'test.jpg');

  // Should have routed to local, not topaz, not any other path.
  assert.equal(__localEnhanceCalls.length, 1, 'remapped to local');
  assert.equal(__topazEnhanceCalls.length, 0);
  const final = __savedSidecars[__savedSidecars.length - 1];
  const img = final.images.find(i => i.filename === 'test.jpg');
  assert.equal(img.provider, 'local');
});

test("validateApiKey('local'): returns valid:true when realesrgan is loaded", async () => {
  resetStubs();
  __config.enhancementProvider = 'local';
  const result = await enhancementManager.validateApiKey('', 'local');
  assert.equal(result.valid, true);
});

test("startEnhancement('local'): returns local_* synthetic ID immediately", async () => {
  resetStubs();
  __config.enhancementProvider = 'local';
  __config.enhancementRescoreAfter = false;
  __localEnhanceMeta = {
    inferenceMs: 50, tileCount: 1, tileSize: 256, tileOverlap: 16,
    executionProvider: 'cpu',
    sourceWidth: 64, sourceHeight: 64, outputWidth: 256, outputHeight: 256,
  };
  const jobPath = await setupJobDir();

  const id = await enhancementManager.startEnhancement('JOB6', jobPath, 'test.jpg');
  assert.match(id, /^local_\d+_[a-z0-9]+$/, 'synthetic local_* ID');

  // Drain the in-flight promise so checkEnhancement observes terminal state.
  // Wait for the .then() chain to write the sidecar by polling briefly.
  for (let i = 0; i < 50; i++) {
    const status = await enhancementManager.checkEnhancement(id);
    if (status.status === 'succeeded') {
      assert.ok(status.outputPath);
      return;
    }
    if (status.status === 'failed') {
      throw new Error(`unexpected failure: ${status.error}`);
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('startEnhancement did not converge to succeeded');
});
