'use strict';

/**
 * Manifest-extra integration tests for folder-watch-service.
 *
 * Verifies the film-scan → S3 completion manifest carries the matched job
 * and twin-check block when auto-assign has stamped a match on the roll,
 * and stays byte-identical to the pre-feature shape otherwise. Also
 * verifies the File-Uploads pipeline never emits the extra block (its
 * manifest must remain unchanged).
 *
 * The s3-service stub captures the 5th arg to uploadFolder (manifestExtra)
 * so the tests can assert exactly what the s3-service would merge into
 * the manifest — the deep manifest content is covered by
 * s3-service-manifest.test.js.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const fs      = require('node:fs');
const path    = require('node:path');

const __originalRequire = Module.prototype.require;

let __s3Calls = [];  // { localFolderPath, s3Prefix, credentials, manifestExtra }

const __userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-mext-ud-'));

Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: { getPath: (_key) => __userDataDir, getVersion: () => '9.9.9-test' },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (req === 'sharp') {
    const makeSharp = () => {
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
  async uploadFolder(localFolderPath, s3Prefix, credentials, _progressCallback, manifestExtra) {
    __s3Calls.push({ localFolderPath, s3Prefix, credentials, manifestExtra });
    return { uploaded: 1, failed: 0, total: 1 };
  },
});

stubViaCache(path.join(SVC, 'orientation-service.js'), {
  async init() { return true; },
  getModelVersion() { return 'stub-orient-v1'; },
  async predictOrientation() {
    return {
      predictedClass: 0, predictedAngle: 0, confidence: 0.95,
      classScores: [0.95, 0.02, 0.02, 0.01], inferenceMs: 5, error: null,
    };
  },
});

const ENH = path.resolve(__dirname, '..', '..', 'enhancement');
stubViaCache(path.join(ENH, 'perfectlyClearClient.js'), {
  async processBatch() { return []; },
});

const folderWatchService = require(path.join(SVC, 'folder-watch-service.js'));
const frameMetadataStore = require(path.join(SVC, 'frame-metadata-store.js'));

function resetSharedState() {
  __config = {};
  __s3Calls = [];
  try {
    const rolls = frameMetadataStore.store.get('rolls', {});
    for (const rollId of Object.keys(rolls)) frameMetadataStore.deleteRoll(rollId);
  } catch (_) { /* best-effort */ }
}

function makeWorkspace() {
  const base    = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-mext-'));
  const storage = path.join(base, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  return { base, storage };
}

function seedRollStorage(storage, rollId, files = { 'a.jpg': 'x' }) {
  const rollDir = path.join(storage, rollId);
  fs.mkdirSync(rollDir, { recursive: true });
  for (const [fname, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(rollDir, fname), content);
  }
  return rollDir;
}

function baseFilmConfig(overrides = {}) {
  return {
    filmScansEnabled: true,
    filmScanRotationEnabled: true,
    filmScanReviewMode: 'never',
    filmScanAutoAssignEnabled: true,
    locationId: 'loc-1',
    s3Provider: 'pixfizz',
    s3BucketName: 'test-bucket',
    ...overrides,
  };
}

// ── _uploadRollFromStorage: matched roll carries the block ──────────────────

test('_uploadRollFromStorage: auto-assigned roll → manifestExtra carries twin_check + job block', async () => {
  resetSharedState();
  const { storage } = makeWorkspace();
  __config = baseFilmConfig();

  const rollId = '1847';
  const storagePath = seedRollStorage(storage, rollId);

  frameMetadataStore.recordRoll(rollId, {
    storagePath,
    locationId: 'loc-1',
    s3Prefix:   'film-scans/loc-1/',
    uploadStatus: 'pending',
    matchedJobId:       'JOB-PXDEMO-1',
    matchedJobNumber:   'PXDEMO-WT6L0M-1',
    matchedOrderId:     'ORD-DEMO',
    matchedOrderNumber: 'PXDEMO-WT6L0M',
    matchedTwinCheck:   '1847',
    matchedAt:          '2026-07-17T10:00:00.000Z',
    awaitingAssignment: false,
    reviewPassed:       true,
  });

  await folderWatchService._uploadRollFromStorage(rollId, __config);

  assert.equal(__s3Calls.length, 1, 'upload fired');
  const extra = __s3Calls[0].manifestExtra;
  assert.ok(extra && typeof extra === 'object', 'manifestExtra is a plain object');
  assert.deepEqual(extra, {
    twin_check:    '1847',
    job_id:        'JOB-PXDEMO-1',
    job_number:    'PXDEMO-WT6L0M-1',
    order_id:      'ORD-DEMO',
    order_number:  'PXDEMO-WT6L0M',
    matched_at:    '2026-07-17T10:00:00.000Z',
    auto_assigned: true,
  });
});

// ── _uploadRollFromStorage: unmatched roll → no block ───────────────────────

test('_uploadRollFromStorage: roll with no match → manifestExtra is null', async () => {
  resetSharedState();
  const { storage } = makeWorkspace();
  __config = baseFilmConfig();

  const rollId = 'NOMATCH-9999';
  const storagePath = seedRollStorage(storage, rollId);

  frameMetadataStore.recordRoll(rollId, {
    storagePath,
    locationId: 'loc-1',
    s3Prefix:   'film-scans/loc-1/',
    uploadStatus: 'pending',
    matchedJobId:       null,
    matchedJobNumber:   null,
    matchedOrderId:     null,
    matchedOrderNumber: null,
    matchedTwinCheck:   null,
    matchedAt:          null,
    awaitingAssignment: false,
    reviewPassed:       true,
  });

  await folderWatchService._uploadRollFromStorage(rollId, __config);

  assert.equal(__s3Calls.length, 1, 'upload fired');
  assert.equal(__s3Calls[0].manifestExtra, null,
    'no match → no extras → manifest stays byte-identical to pre-feature shape');
});

// ── _uploadRollFromStorage: legacy roll (no matched fields at all) → null ───

test('_uploadRollFromStorage: legacy roll without any matched* fields → manifestExtra is null', async () => {
  resetSharedState();
  const { storage } = makeWorkspace();
  __config = baseFilmConfig({ filmScanAutoAssignEnabled: false });

  const rollId = 'LEGACY-ROLL';
  const storagePath = seedRollStorage(storage, rollId);

  // No matched* stamps at all — simulates a pre-feature roll record still in
  // storage from an older version.
  frameMetadataStore.recordRoll(rollId, {
    storagePath,
    locationId: 'loc-1',
    s3Prefix:   'film-scans/loc-1/',
    uploadStatus: 'pending',
  });

  await folderWatchService._uploadRollFromStorage(rollId, __config);

  assert.equal(__s3Calls.length, 1, 'upload fired');
  assert.equal(__s3Calls[0].manifestExtra, null);
});

// ── _processFileUploads: never carries film-scan extras ─────────────────────

test('_processFileUploads: uploadFolder invoked WITHOUT manifestExtra (undefined)', async () => {
  resetSharedState();
  const base    = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-mext-fu-'));
  const watch   = path.join(base, 'watch');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(watch,   { recursive: true });
  fs.mkdirSync(storage, { recursive: true });

  const folderName = 'FU-FOLDER';
  const src = path.join(watch, folderName);
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.jpg'), 'x');

  __config = {
    fileUploadsWatchFolder:      watch,
    fileUploadsStorageFolder:    storage,
    fileUploadsWatchguardMinutes: -1,   // fresh files count as stable
    s3Provider:   'pixfizz',
    s3BucketName: 'test-bucket',
    locationId:   'loc-1',
    // No filmScan auto-assign — this pipeline is unrelated to film-scan matches
    perfectlyClear: { fileUploads: { enabled: false } },
  };

  await folderWatchService._processFileUploads(__config);

  assert.equal(__s3Calls.length, 1, 'file-uploads S3 upload fired');
  // The 5th arg is either omitted or explicitly undefined — both are
  // equivalent (default parameter falls back to null inside s3-service).
  assert.equal(__s3Calls[0].manifestExtra, undefined,
    'file-uploads path does not pass manifestExtra — its manifest stays unchanged');
});
