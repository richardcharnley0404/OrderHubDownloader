'use strict';

/**
 * M3 integration tests for the Film Development Auto Assignment hold at
 * folder-watch-service._processFilmScans Step 3.
 *
 * Assertions:
 *   - Feature OFF (existing installs): no behavioural change. Rolls do
 *     not carry awaitingAssignment/reviewPassed stamps; upload defer
 *     matches pre-feature semantics for every review mode.
 *   - Feature ON + rotation ON + review mode 'never': roll defers with
 *     awaitingAssignment:true, reviewPassed:true (Gate A trivially
 *     passed), no upload attempted.
 *   - Feature ON + rotation ON + review mode 'always': roll defers with
 *     awaitingAssignment:true, reviewPassed:false (needs approval).
 *   - Feature ON + rotation ON + review mode 'smart' (confident roll):
 *     roll defers with reviewPassed:true (Gate A trivially passed
 *     because Smart would have let it upload).
 *   - Feature ON + rotation OFF: a minimal roll record is written with
 *     uploadStatus:'pending', awaitingAssignment:true, reviewPassed:true
 *     (no review surface → Gate A trivially passed).
 *   - S3 upload is NEVER attempted while auto-assign is holding.
 *
 * Harness mirrors folder-watch-perfectly-clear.test.js:
 *   - stub electron, sharp, s3-service, orientation-service, PC client
 *   - real frame-metadata-store on a real temp dir
 *   - backdate freshly-written files so the stability check passes
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const fs      = require('node:fs');
const path    = require('node:path');

const __originalRequire = Module.prototype.require;

let __s3Calls = [];   // captured s3Service.uploadFolder invocations

// Isolate this test file's frame-metadata-store JSON from other test files
// that also stub electron.app.getPath to a tempdir — otherwise they race
// on the same shared file when npm test runs the whole suite.
const __userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-aa-ud-'));

Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: { getPath: (_key) => __userDataDir },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (req === 'sharp') {
    const makeSharp = (_src, _opts) => {
      const chain = {
        rotate: () => chain,
        resize: () => chain,
        jpeg:   () => chain,
        tiff:   () => chain,
        async toFile(dest) {
          try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) { /* ignore */ }
          fs.writeFileSync(dest, Buffer.from(`FAKE-${path.basename(dest)}`));
          return { size: 1 };
        },
      };
      return chain;
    };
    return makeSharp;
  }
  return __originalRequire.apply(this, arguments);
};

function stubViaCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SVC = path.resolve(__dirname, '..');

stubViaCache(path.join(SVC, 'logger.js'), {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
});

let __config = {};
stubViaCache(path.join(SVC, 'config-service.js'), {
  get(key) { return __config[key]; },
  getAll() { return { ...__config }; },
});

stubViaCache(path.join(SVC, 's3-service.js'), {
  async uploadFolder(localFolderPath, s3Prefix, credentials) {
    __s3Calls.push({ localFolderPath, s3Prefix, credentials });
    return { uploaded: 1, failed: 0, total: 1 };
  },
});

stubViaCache(path.join(SVC, 'orientation-service.js'), {
  async init() { return true; },
  getModelVersion() { return 'stub-orient-v1'; },
  async predictOrientation(_imagePath) {
    return {
      predictedClass: 0, predictedAngle: 0, confidence: 0.95,
      classScores: [0.95, 0.02, 0.02, 0.01], inferenceMs: 5, error: null,
    };
  },
});

// PC client — never called by these tests (no PC config), but stub for load-safety.
const ENH = path.resolve(__dirname, '..', '..', 'enhancement');
stubViaCache(path.join(ENH, 'perfectlyClearClient.js'), {
  async processBatch() { return []; },
});

const folderWatchService = require(path.join(SVC, 'folder-watch-service.js'));
const frameMetadataStore = require(path.join(SVC, 'frame-metadata-store.js'));

function resetSharedState() {
  __config = {};
  __s3Calls = [];
  frameMetadataStore._clearAll();
  try {
    const rolls = frameMetadataStore.store.get('rolls', {});
    for (const rollId of Object.keys(rolls)) frameMetadataStore.deleteRoll(rollId);
  } catch (_) { /* best-effort */ }
}

function makeWorkspace() {
  const base    = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-aa-'));
  const watch   = path.join(base, 'watch');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(watch,   { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
  return { base, watch, storage };
}

function seedRoll(watchDir, name, files) {
  const rollDir = path.join(watchDir, name);
  fs.mkdirSync(rollDir, { recursive: true });
  for (const [fname, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(rollDir, fname), content);
  }
  return rollDir;
}

function baseFilmConfig(watch, storage, overrides = {}) {
  return {
    filmScansEnabled: true,
    filmScansWatchFolder: watch,
    filmScansStorageFolder: storage,
    filmScansWatchguardMinutes: -1,          // fresh files count as stable
    filmScanRotationEnabled: true,
    filmScanRotationConfidenceThreshold: 0.9,
    filmScanReviewMode: 'never',
    filmScanAutoAssignEnabled: false,
    locationId: 'loc-1',
    s3BucketName: null,                      // block S3 upload path
    ...overrides,
  };
}

// ── Feature OFF: existing installs must be byte-identical ────────────────────

test('feature OFF + rotation on + Auto mode: no auto-assign stamps on the roll record', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanAutoAssignEnabled: false });

  const rollName = 'ROLL-OFF-AUTO';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.ok(rec, 'roll record written');
  assert.equal(rec.awaitingAssignment, undefined, 'no stamp when feature off');
  assert.equal(rec.reviewPassed,       undefined, 'no stamp when feature off');
  // s3BucketName is null → no s3Config → upload skipped, but shouldDefer=false
  // (Auto mode + feature off) so summary.processed++ on the upload branch,
  // not on the defer branch. Roll record has no uploadStatus stamp on this path.
  assert.equal(rec.uploadStatus, undefined, 'Auto mode with feature off does not defer');
});

test('feature OFF + rotation on + Always mode: roll defers via review only, no auto-assign stamps', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanReviewMode: 'always', filmScanAutoAssignEnabled: false,
  });

  const rollName = 'ROLL-OFF-ALWAYS';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus, 'pending', 'Always mode still defers');
  assert.equal(rec.awaitingAssignment, undefined);
  assert.equal(rec.reviewPassed,       undefined);
});

// ── Feature ON + rotation ON ─────────────────────────────────────────────────

test('feature ON + rotation on + never: defers with reviewPassed:true (Gate A trivially passed)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanReviewMode: 'never', filmScanAutoAssignEnabled: true,
  });

  const rollName = 'ROLL-ON-NEVER';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.ok(rec, 'roll record written');
  assert.equal(rec.uploadStatus,       'pending', 'auto-assign forces defer');
  assert.equal(rec.awaitingAssignment, true);
  assert.equal(rec.reviewPassed,       true, 'Gate A trivially passed for never mode');
  assert.equal(rec.matchedJobId,       null, 'Gate B not yet passed');
  assert.equal(__s3Calls.length, 0, 'no S3 upload while held');
});

test('feature ON + rotation on + always: defers with reviewPassed:false (needs approval)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanReviewMode: 'always', filmScanAutoAssignEnabled: true,
  });

  const rollName = 'ROLL-ON-ALWAYS';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus,       'pending');
  assert.equal(rec.awaitingAssignment, true);
  assert.equal(rec.reviewPassed,       false, 'Gate A requires operator approval');
  assert.equal(__s3Calls.length, 0);
});

test('feature ON + rotation on + smart (confident roll): defers with reviewPassed:true', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanReviewMode: 'smart',
    filmScanRotationConfidenceThreshold: 0.5, // sample confidence 0.95 → confident
    filmScanAutoAssignEnabled: true,
  });

  const rollName = 'ROLL-ON-SMART-OK';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus,       'pending', 'auto-assign forces defer');
  assert.equal(rec.awaitingAssignment, true);
  assert.equal(rec.reviewPassed,       true, 'Smart-confident → Gate A passed');
});

// ── Feature ON + rotation OFF: minimal roll record ──────────────────────────

test('feature ON + rotation OFF: minimal roll record stamped (uploadStatus pending, both gates open)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    filmScanReviewMode: 'never',
    filmScanAutoAssignEnabled: true,
  });

  const rollName = 'ROLL-ROT-OFF-ON';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.ok(rec, 'minimal roll record written for auto-assign hold');
  assert.equal(rec.uploadStatus,       'pending');
  assert.equal(rec.awaitingAssignment, true);
  assert.equal(rec.reviewPassed,       true, 'no review surface → Gate A trivially passed');
  assert.equal(rec.matchedJobId,       null);
  assert.ok(rec.storagePath, 'storagePath captured for _uploadRollFromStorage');
  assert.equal(rec.locationId, 'loc-1');
  assert.ok(rec.s3Prefix, 's3Prefix captured');
  assert.equal(__s3Calls.length, 0, 'no S3 upload while held');
});

test('feature OFF + rotation OFF: no minimal roll record written (pre-feature behaviour)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    filmScanReviewMode: 'never',
    filmScanAutoAssignEnabled: false,
  });

  const rollName = 'ROLL-ROT-OFF-OFF';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  // getRoll returns null (not undefined) when the roll doesn't exist.
  assert.equal(rec, null,
    'no roll record with rotation off + auto-assign off — matches pre-feature semantics');
});
