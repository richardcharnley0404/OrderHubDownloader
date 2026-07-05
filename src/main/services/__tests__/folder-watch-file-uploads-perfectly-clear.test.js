'use strict';

/**
 * M5 integration tests: Perfectly Clear auto-apply for File Uploads.
 *
 * Exercises folder-watch-service._processFileUploads with a mocked
 * perfectlyClearClient. File Uploads has no review surface and no
 * per-image revert, so the policy is deliberately simple:
 *
 *   - Enabled + autoApplyConfigId → every image round-trips through
 *     the client and is replaced in-place on success.
 *   - Rejected / timeout / cancelled → original bytes preserved and
 *     a warning lands in the Activity Log.
 *   - Client-level throw → no wedge; every file falls back to
 *     originals and the pipeline continues to the S3 upload step.
 *   - Disabled scope (or no autoApplyConfigId) → strict no-op: bytes
 *     in the storage folder are byte-identical to what we copied in.
 *
 * s3-service is stubbed to record its call so we can assert the upload
 * step still runs regardless of PC outcome.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const fs      = require('node:fs');
const path    = require('node:path');

// ── Module-level require interceptor + singleton stubs ───────────────────────

const __originalRequire = Module.prototype.require;

let __pcResults = null;   // ({config, files, timeoutMs}) => Promise<results[]>
let __pcCalls   = [];     // captured processBatch args
let __pcShouldThrow = null; // Error to throw from processBatch (client-level failure)
let __s3Calls   = [];     // captured uploadFolder invocations
let __warnings  = [];     // captured logger.logWarning messages
let __errors    = [];     // captured logger.logError messages

// Per-file userData sandbox — see the same block in
// folder-watch-perfectly-clear.test.js for the rationale.
const __userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-pcupload-ud-'));

Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: { getPath: (_key) => __userDataDir },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return __originalRequire.apply(this, arguments);
};

function stubViaCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SVC = path.resolve(__dirname, '..');
const ENH = path.resolve(__dirname, '..', '..', 'enhancement');

stubViaCache(path.join(SVC, 'logger.js'), {
  info:       () => {},
  warn:       () => {},
  error:      () => {},
  logInfo:    () => {},
  logDebug:   () => {},
  logWarning: (msg) => { __warnings.push(String(msg)); },
  logError:   (msg) => { __errors.push(String(msg)); },
});

let __config = {};
stubViaCache(path.join(SVC, 'config-service.js'), {
  get(key) { return __config[key]; },
  getAll() { return { ...__config }; },
});

stubViaCache(path.join(SVC, 's3-service.js'), {
  async uploadFolder(localFolderPath, s3Prefix, credentials, progressCallback) {
    __s3Calls.push({ localFolderPath, s3Prefix, credentials });
    void progressCallback;
    return { uploaded: 0, failed: 0, total: 0 };
  },
});

// perfectlyClearClient — primary target. Optionally throws (for the
// client-level-failure test) or returns per-file statuses via __pcResults.
stubViaCache(path.join(ENH, 'perfectlyClearClient.js'), {
  async processBatch(opts) {
    __pcCalls.push({
      config:    opts.config,
      files:     opts.files.map(f => ({ sourcePath: f.sourcePath, destPath: f.destPath })),
      timeoutMs: opts.timeoutMs,
    });
    if (__pcShouldThrow) throw __pcShouldThrow;
    if (typeof __pcResults === 'function') return await __pcResults(opts);
    // Default: every file enhanced — overwrite destPath with a marker so
    // tests can byte-verify the replacement.
    const out = [];
    for (const f of opts.files) {
      fs.writeFileSync(f.destPath, Buffer.from(`PC-ENHANCED-${path.basename(f.destPath)}`));
      out.push({ sourcePath: f.sourcePath, destPath: f.destPath, status: 'enhanced' });
    }
    return out;
  },
});

// Load folder-watch AFTER the stubs so its require() calls hit them.
const folderWatchService = require(path.join(SVC, 'folder-watch-service.js'));

// ── Per-test helpers ─────────────────────────────────────────────────────────

function resetSharedState() {
  __config = {};
  __pcResults = null;
  __pcShouldThrow = null;
  __pcCalls = [];
  __s3Calls = [];
  __warnings = [];
  __errors = [];
}

function makeWorkspace() {
  const base    = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-pcupload-'));
  const watch   = path.join(base, 'watch');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(watch,   { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
  return { base, watch, storage };
}

/**
 * Seed a folder under the watch root. `files` maps relative paths to
 * Buffer contents; keys like 'sub/a.jpg' are supported.
 */
function seedFolder(watchDir, folderName, files) {
  const dir = path.join(watchDir, folderName);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, buf] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
  }
  return dir;
}

function baseUploadConfig(watch, storage, overrides = {}) {
  return {
    fileUploadsEnabled:            true,
    fileUploadsWatchFolder:        watch,
    fileUploadsStorageFolder:      storage,
    // Negative watchguard → cutoff sits in the future → fresh files count
    // as stable on the first cycle. (Same trick the M4 test uses because
    // Node can't backdate birthtime on Windows.)
    fileUploadsWatchguardMinutes:  -1,
    fileStabilityMinutes:          -1,
    s3BucketName:                  null, // _buildS3Config → null → no upload
    ...overrides,
  };
}

function pcConfigFixture(overrides = {}) {
  return {
    jobs:        { enabled: false, autoApplyConfigId: null, configs: [] },
    filmScans:   { enabled: false, autoApplyConfigId: null, configs: [] },
    fileUploads: {
      enabled: true,
      autoApplyConfigId: 'cfg-uploads-1',
      configs: [{
        id: 'cfg-uploads-1',
        friendlyName: 'Uploads Standard',
        inputFolder:  '/tmp/pc-in',
        outputFolder: '/tmp/pc-out',
        rejectedFolder: '/tmp/pc-rej',
      }],
      ...overrides,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('auto-apply: every image enhanced — storage bytes replaced, S3 upload still runs on the enhanced folder', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseUploadConfig(watch, storage, {
    perfectlyClear: pcConfigFixture(),
    // Turn S3 back on so the assertion below can prove the pipeline
    // reached uploadFolder AFTER the PC step.
    s3BucketName: 'fake-bucket',
    s3Provider:   'pixfizz',
  });

  const folderName = 'upload-001';
  const origA = Buffer.from('ORIG-A');
  const origB = Buffer.from('ORIG-B');
  seedFolder(watch, folderName, { 'a.jpg': origA, 'b.png': origB });

  await folderWatchService.processFileUploads();

  // PC called exactly once with both images.
  assert.equal(__pcCalls.length, 1, 'processBatch called once');
  assert.equal(__pcCalls[0].config.friendlyName, 'Uploads Standard');
  assert.equal(__pcCalls[0].files.length, 2);
  const sentBases = __pcCalls[0].files.map(f => path.basename(f.sourcePath)).sort();
  assert.deepEqual(sentBases, ['a.jpg', 'b.png']);
  // dest == source (in-place replace).
  for (const f of __pcCalls[0].files) assert.equal(f.sourcePath, f.destPath);
  // Timeout floor honoured.
  assert.ok(__pcCalls[0].timeoutMs >= 5 * 60 * 1000);

  // Storage bytes replaced with the marker the client stub writes.
  const finalA = fs.readFileSync(path.join(storage, folderName, 'a.jpg'));
  const finalB = fs.readFileSync(path.join(storage, folderName, 'b.png'));
  assert.deepEqual(finalA, Buffer.from('PC-ENHANCED-a.jpg'));
  assert.deepEqual(finalB, Buffer.from('PC-ENHANCED-b.png'));

  // Watch folder cleaned up.
  assert.equal(fs.existsSync(path.join(watch, folderName)), false);

  // S3 upload was invoked on the enhanced storage folder — proves the PC
  // step ran BEFORE upload, not after.
  assert.equal(__s3Calls.length, 1, 'uploadFolder called');
  assert.equal(__s3Calls[0].localFolderPath, path.join(storage, folderName));
  assert.equal(__s3Calls[0].s3Prefix, 'file-uploads/');

  // No reject/timeout warnings on the happy path.
  assert.equal(
    __warnings.filter(w => /PC (rejected|timeout|cancelled)/.test(w)).length,
    0,
    'no reject/timeout warnings on happy path'
  );
});

test('reject: rejected file keeps original bytes and logs a warning to the Activity Log', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseUploadConfig(watch, storage, { perfectlyClear: pcConfigFixture() });

  // Enhance a.jpg; reject b.jpg. b.jpg's destPath is NOT touched by the
  // client — the on-disk bytes must remain what we seeded.
  __pcResults = async (opts) => {
    const results = [];
    for (const f of opts.files) {
      const base = path.basename(f.sourcePath);
      if (base === 'a.jpg') {
        fs.writeFileSync(f.destPath, Buffer.from('PC-ENHANCED-a.jpg'));
        results.push({ sourcePath: f.sourcePath, destPath: f.destPath, status: 'enhanced' });
      } else {
        results.push({
          sourcePath: f.sourcePath,
          destPath:   f.destPath,
          status:     'rejected',
          error:      'unsupported input',
        });
      }
    }
    return results;
  };

  const folderName = 'upload-mixed';
  const origB = Buffer.from('ORIG-BYTES-B');
  seedFolder(watch, folderName, { 'a.jpg': Buffer.from('OA'), 'b.jpg': origB });

  await folderWatchService.processFileUploads();

  const finalA = fs.readFileSync(path.join(storage, folderName, 'a.jpg'));
  const finalB = fs.readFileSync(path.join(storage, folderName, 'b.jpg'));
  assert.deepEqual(finalA, Buffer.from('PC-ENHANCED-a.jpg'), 'a enhanced');
  assert.deepEqual(finalB, origB, 'b kept its original bytes');

  const rejectWarnings = __warnings.filter(w => /PC rejected b\.jpg/.test(w));
  assert.equal(rejectWarnings.length, 1, 'exactly one reject warning surfaced');
  assert.match(rejectWarnings[0], /uploading original/);
  assert.match(rejectWarnings[0], /unsupported input/);
});

test('timeout: dead QuickServer never wedges the pipeline — all files upload as originals with warnings', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseUploadConfig(watch, storage, {
    perfectlyClear: pcConfigFixture(),
    s3BucketName: 'fake-bucket',
    s3Provider:   'pixfizz',
  });

  __pcResults = async (opts) => (opts.files || []).map(f => ({
    sourcePath: f.sourcePath,
    destPath:   f.destPath,
    status:     'timeout',
  }));

  const folderName = 'upload-timeout';
  const origA = Buffer.from('ORIG-TIMEOUT-A');
  const origB = Buffer.from('ORIG-TIMEOUT-B');
  seedFolder(watch, folderName, { 'a.jpg': origA, 'b.jpg': origB });

  await folderWatchService.processFileUploads();

  // Originals preserved verbatim.
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'a.jpg')),
    origA,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'b.jpg')),
    origB,
  );

  // One warning per timed-out file.
  const timeoutWarnings = __warnings.filter(w => /PC timeout/.test(w));
  assert.equal(timeoutWarnings.length, 2, 'both timeouts warned');

  // S3 upload STILL ran — pipeline did not wedge.
  assert.equal(__s3Calls.length, 1, 'upload proceeded despite PC timeouts');
});

test('client-level throw: falls back to originals for the whole batch, logs, and does not wedge upload', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseUploadConfig(watch, storage, {
    perfectlyClear: pcConfigFixture(),
    s3BucketName: 'fake-bucket',
    s3Provider:   'pixfizz',
  });

  __pcShouldThrow = new Error('QuickServer channel unreachable');

  const folderName = 'upload-throw';
  const orig = Buffer.from('ORIG-THROW');
  seedFolder(watch, folderName, { 'a.jpg': orig });

  await folderWatchService.processFileUploads();

  // Original untouched.
  assert.deepEqual(fs.readFileSync(path.join(storage, folderName, 'a.jpg')), orig);

  // Error surfaced to logger.logError, warning surfaced to Activity Log.
  assert.ok(__errors.some(e => /PC processBatch threw/.test(e)));
  assert.ok(__warnings.some(w => /PC unavailable/.test(w)));

  // Upload ran.
  assert.equal(__s3Calls.length, 1, 'upload proceeded after PC throw');
});

test('disabled scope: strict no-op — no processBatch call, storage bytes byte-identical to the source', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  const pc = pcConfigFixture();
  pc.fileUploads.enabled = false;              // scope OFF
  __config = baseUploadConfig(watch, storage, { perfectlyClear: pc });

  const folderName = 'upload-noop';
  const orig = Buffer.from('DISABLED-NO-OP');
  seedFolder(watch, folderName, { 'a.jpg': orig, 'notes.txt': Buffer.from('t') });

  await folderWatchService.processFileUploads();

  assert.equal(__pcCalls.length, 0, 'processBatch not called at all');
  assert.deepEqual(fs.readFileSync(path.join(storage, folderName, 'a.jpg')), orig);
  // Non-image file also untouched (regression guard against accidental
  // scope-wide rewrites).
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'notes.txt')),
    Buffer.from('t'),
  );
  assert.equal(__warnings.length, 0, 'no PC warnings on strict no-op');
});

test('no autoApplyConfigId: strict no-op even when scope enabled', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  const pc = pcConfigFixture();
  pc.fileUploads.enabled = true;
  pc.fileUploads.autoApplyConfigId = null;     // no default config selected
  __config = baseUploadConfig(watch, storage, { perfectlyClear: pc });

  const folderName = 'upload-noauto';
  const orig = Buffer.from('NO-AUTO-APPLY');
  seedFolder(watch, folderName, { 'a.jpg': orig });

  await folderWatchService.processFileUploads();

  assert.equal(__pcCalls.length, 0, 'processBatch not called');
  assert.deepEqual(fs.readFileSync(path.join(storage, folderName, 'a.jpg')), orig);
});

test('only image files are sent through PC; other file types pass through unchanged', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseUploadConfig(watch, storage, { perfectlyClear: pcConfigFixture() });

  const folderName = 'upload-mixed-types';
  seedFolder(watch, folderName, {
    'photo.jpg':  Buffer.from('IMG'),
    'scan.tiff':  Buffer.from('TIF'),
    'shot.png':   Buffer.from('PNG'),
    'notes.txt':  Buffer.from('TXT'),
    'sheet.pdf':  Buffer.from('PDF'),
  });

  await folderWatchService.processFileUploads();

  assert.equal(__pcCalls.length, 1);
  const sent = __pcCalls[0].files.map(f => path.basename(f.sourcePath)).sort();
  assert.deepEqual(sent, ['photo.jpg', 'scan.tiff', 'shot.png']);

  // Non-image files pass through untouched.
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'notes.txt')),
    Buffer.from('TXT'),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'sheet.pdf')),
    Buffer.from('PDF'),
  );
});

test('nested subdirs: images inside subfolders are enhanced too', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseUploadConfig(watch, storage, { perfectlyClear: pcConfigFixture() });

  const folderName = 'upload-nested';
  seedFolder(watch, folderName, {
    'top.jpg':               Buffer.from('T'),
    'sub/inner.jpg':         Buffer.from('I'),
    'sub/deeper/deep.jpg':   Buffer.from('D'),
  });

  await folderWatchService.processFileUploads();

  assert.equal(__pcCalls.length, 1);
  assert.equal(__pcCalls[0].files.length, 3, 'walker descended into subdirs');

  // All three replaced in place, preserving directory layout.
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'top.jpg')),
    Buffer.from('PC-ENHANCED-top.jpg'),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'sub', 'inner.jpg')),
    Buffer.from('PC-ENHANCED-inner.jpg'),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'sub', 'deeper', 'deep.jpg')),
    Buffer.from('PC-ENHANCED-deep.jpg'),
  );
});

test('duplicate basename across subfolders: first enhances, later duplicates upload as originals with a warning', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseUploadConfig(watch, storage, { perfectlyClear: pcConfigFixture() });

  const folderName = 'upload-dup';
  const dupOriginal = Buffer.from('DUPLICATE-ORIG');
  seedFolder(watch, folderName, {
    'a.jpg':        Buffer.from('FIRST'),
    'sub/a.jpg':    dupOriginal,   // basename collision
    'unique.jpg':   Buffer.from('UNIQ'),
  });

  await folderWatchService.processFileUploads();

  assert.equal(__pcCalls.length, 1, 'one batch call — no client-side throw');
  const sentBases = __pcCalls[0].files.map(f => path.basename(f.sourcePath)).sort();
  assert.deepEqual(sentBases, ['a.jpg', 'unique.jpg']);

  // First a.jpg enhanced, duplicate sub/a.jpg untouched.
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'a.jpg')),
    Buffer.from('PC-ENHANCED-a.jpg'),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(storage, folderName, 'sub', 'a.jpg')),
    dupOriginal,
    'duplicate basename copy left as original',
  );

  const dupWarnings = __warnings.filter(w => /duplicate basename/.test(w));
  assert.equal(dupWarnings.length, 1, 'exactly one duplicate warning');
});
