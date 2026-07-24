'use strict';

/**
 * Unit tests for src/main/services/s3-service.js retry behaviour
 * (2026-07-24 lab-safety pass).
 *
 * Covers:
 *   - _uploadWithRetry: transient HTTP 5xx / 429 retried; 4xx (non-429) fatal.
 *   - _isTransientPutError classifier: known-good status parsing.
 *   - _truncateReason: HTML body noise stripped, capped at 120 chars.
 *   - _uploadFolderPixfizz second-pass: presign flaps once → recovery → errors:0.
 *   - _uploadFolderPixfizz: persistent presign 502 → early-abort under budget.
 *   - _uploadFolderPixfizz: manifest carries failed_files[] with truncated reasons.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const os      = require('node:os');
const path    = require('node:path');
const fs      = require('node:fs');
const Module  = require('node:module');

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), getVersion: () => '9.9.9-test' },
    };
  }
  return __originalRequire.apply(this, arguments);
};

const SVC = path.resolve(__dirname, '..');

function stubViaCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubViaCache(path.join(SVC, 'logger.js'), {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
});

stubViaCache(path.join(SVC, 'config-service.js'), {
  getApiSettings() { return { baseUrl: 'https://oh.test/api', key: 'test-key' }; },
});

// presign-service stub — per-test scripting via __presignScript.
let __presignScript = null;
stubViaCache(path.join(SVC, 'presign-service.js'), {
  async getPresignedUrls(fileDescriptors, _locationId) {
    if (!__presignScript) {
      // Default: succeed with a fake URL per file.
      return fileDescriptors.map((d) => ({
        name:       d.name,
        s3_key:     `k/${d.name}`,
        upload_url: `https://s3.test/${d.name}`,
      }));
    }
    return __presignScript(fileDescriptors);
  },
});

const s3Service = require(path.join(SVC, 's3-service.js'));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWorkspace(files = { 'a.jpg': 'a', 'b.jpg': 'b' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-s3retry-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// Track calls to the low-level PUT primitive so tests can script per-attempt failures.
let __putScript = null;
let __putBufferScript = null;
const __origPut = s3Service._uploadFileViaPresignedUrl.bind(s3Service);
const __origPutBuffer = s3Service._uploadBufferViaPresignedUrl.bind(s3Service);
s3Service._uploadFileViaPresignedUrl = async function (filePath, url) {
  if (__putScript) return __putScript(filePath, url);
  return __origPut(filePath, url);
};
s3Service._uploadBufferViaPresignedUrl = async function (buffer, contentType, url) {
  if (__putBufferScript) return __putBufferScript(buffer, contentType, url);
  return __origPutBuffer(buffer, contentType, url);
};

function resetState() {
  __presignScript = null;
  __putScript = null;
  __putBufferScript = null;
}

// ── _uploadWithRetry ────────────────────────────────────────────────────────

test('_uploadWithRetry: PUT 502 twice then 200 → succeeds after 3 attempts (5xx now retried)', async (t) => {
  resetState();
  const dir = makeWorkspace({ 'a.jpg': 'a' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'a.jpg');

  let attempts = 0;
  __putScript = async () => {
    attempts++;
    if (attempts < 3) throw new Error('Upload failed: HTTP 502 — bad gateway');
    return;
  };

  // Speed up the retry backoffs so the test doesn't wait ~11 s.
  const origBackoffsSource = s3Service._uploadWithRetry.toString();
  assert.ok(/BACKOFFS_MS/.test(origBackoffsSource), 'BACKOFFS_MS lives in _uploadWithRetry');
  // (No direct table export — we rely on the small backoff being tolerable in tests.
  //  With backoffs 1s+3s+7s + jitter, MAX_ATTEMPTS=4, this test tolerates ~11s worst-case.)

  await s3Service._uploadWithRetry(filePath, 'https://s3.test/a', 'a.jpg');
  assert.equal(attempts, 3);
});

test('_uploadWithRetry: PUT 403 → throws immediately, NO retry (fatal 4xx)', async (t) => {
  resetState();
  const dir = makeWorkspace({ 'a.jpg': 'a' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'a.jpg');

  let attempts = 0;
  __putScript = async () => {
    attempts++;
    throw new Error('Upload failed: HTTP 403 — SignatureDoesNotMatch');
  };

  await assert.rejects(
    () => s3Service._uploadWithRetry(filePath, 'https://s3.test/a', 'a.jpg'),
    /HTTP 403/,
  );
  assert.equal(attempts, 1, 'auth errors do not get better with retries');
});

test('_uploadWithRetry: PUT 429 → retried', async (t) => {
  resetState();
  const dir = makeWorkspace({ 'a.jpg': 'a' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let attempts = 0;
  __putScript = async () => {
    attempts++;
    if (attempts === 1) throw new Error('Upload failed: HTTP 429 — slow down');
    return;
  };

  await s3Service._uploadWithRetry(path.join(dir, 'a.jpg'), 'https://s3.test/a', 'a.jpg');
  assert.equal(attempts, 2);
});

test('_isTransientPutError: classification of HTTP status codes and network patterns', () => {
  // 5xx / 429 → transient
  for (const s of [500, 502, 503, 504, 429]) {
    assert.equal(
      s3Service._isTransientPutError(new Error(`Upload failed: HTTP ${s} — x`)),
      true,
      `HTTP ${s} should be transient`,
    );
  }
  // 4xx (non-429) → fatal
  for (const s of [400, 401, 403, 404]) {
    assert.equal(
      s3Service._isTransientPutError(new Error(`Upload failed: HTTP ${s} — x`)),
      false,
      `HTTP ${s} should be fatal`,
    );
  }
  // Network patterns → transient
  for (const msg of ['socket hang up', 'ECONNRESET x', 'ETIMEDOUT', 'network stalled', 'EAI_AGAIN']) {
    assert.equal(
      s3Service._isTransientPutError(new Error(msg)),
      true,
      `${msg} should be transient`,
    );
  }
  // Random other errors → fatal
  assert.equal(s3Service._isTransientPutError(new Error('some random thing')), false);
});

// ── _truncateReason ─────────────────────────────────────────────────────────

test('_truncateReason: drops everything past the first newline (kills HTML body noise)', () => {
  const err = new Error('Presign request failed: HTTP 502 — <html>\n<body>Very long HTML body here…</body>\n</html>');
  const r = s3Service._truncateReason(err);
  assert.equal(r, 'Presign request failed: HTTP 502 — <html>');
});

test('_truncateReason: caps at 120 chars with an ellipsis on truncation', () => {
  const long = 'x'.repeat(500);
  const r = s3Service._truncateReason(new Error(long));
  assert.equal(r.length, 120);
  assert.ok(r.endsWith('…'));
});

test('_truncateReason: null / undefined error → "unknown"', () => {
  assert.equal(s3Service._truncateReason(null), 'unknown');
  assert.equal(s3Service._truncateReason(undefined), 'unknown');
});

// ── _uploadFolderPixfizz: second-pass recovery ──────────────────────────────

test('_uploadFolderPixfizz: presign fails file A once then succeeds on second pass → errors:0, failed_files empty', async (t) => {
  resetState();
  const dir = makeWorkspace({ 'a.jpg': 'a', 'b.jpg': 'b' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Track manifest so we can inspect it.
  let manifestBody = null;
  __putBufferScript = async (buffer, contentType) => {
    if (contentType === 'application/json') {
      manifestBody = JSON.parse(buffer.toString('utf8'));
    }
    return;
  };
  __putScript = async () => { /* PUT of image files → always OK */ };

  let calls = 0;
  __presignScript = async (descs) => {
    calls++;
    // On the very first call (a.jpg pass 1), pretend presign fails.
    if (calls === 1 && descs[0].name === 'a.jpg') {
      throw new Error('Presign request failed: HTTP 502 — Bad Gateway');
    }
    // Everything else: success.
    return descs.map((d) => ({ name: d.name, s3_key: `k/${d.name}`, upload_url: `https://s3.test/${d.name}` }));
  };

  const result = await s3Service._uploadFolderPixfizz(
    dir, 'film-scans/loc/', { provider: 'pixfizz', locationId: 'loc' },
  );

  assert.equal(result.uploaded, 2, 'both files uploaded eventually');
  assert.equal(result.failed, 0, 'no failures after second-pass recovery');
  assert.equal(result.failedFiles.length, 0);
  assert.ok(manifestBody, 'manifest was uploaded');
  assert.equal(manifestBody.errors, 0);
  assert.deepEqual(manifestBody.failed_files, []);
});

test('_uploadFolderPixfizz: presign persistently 502 on file A → early-abort under budget, failed_files carries truncated reason', async (t) => {
  resetState();
  const dir = makeWorkspace({ 'a.jpg': 'a', 'b.jpg': 'b', 'c.jpg': 'c', 'd.jpg': 'd', 'e.jpg': 'e' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let manifestBody = null;
  __putBufferScript = async (buffer, contentType) => {
    if (contentType === 'application/json') manifestBody = JSON.parse(buffer.toString('utf8'));
  };
  __putScript = async () => { /* always OK */ };

  // Every presign call for 'a.jpg' fails 502; everything else succeeds.
  __presignScript = async (descs) => {
    // Reject anything mentioning a.jpg first — will hit the early-abort budget.
    if (descs[0].name === 'a.jpg') {
      throw new Error('Presign request failed: HTTP 502 — <html>\n<body>bad gateway</body></html>');
    }
    if (descs[0].name === 'b.jpg') {
      throw new Error('Presign request failed: HTTP 502 — <html>bad gateway</html>');
    }
    return descs.map((d) => ({ name: d.name, s3_key: `k/${d.name}`, upload_url: `https://s3.test/${d.name}` }));
  };

  const result = await s3Service._uploadFolderPixfizz(
    dir, 'film-scans/loc/', { provider: 'pixfizz', locationId: 'loc' },
  );

  // NET_ABORT = 2 → after 2 consecutive transient failures the pass bails
  // and marks the rest as "not attempted". Combined with 2 second-pass
  // retries (each also aborts fast) the whole batch is failed.
  assert.equal(result.failed, 5, 'all files failed in the aborted-passes scenario');
  assert.ok(manifestBody);
  assert.equal(manifestBody.errors, 5);
  assert.equal(manifestBody.failed_files.length, 5);
  // The reason string on files that were actually attempted must be the
  // truncated first-line 502 message, not the full HTML body.
  const aEntry = manifestBody.failed_files.find((f) => f.name === 'a.jpg');
  assert.ok(aEntry, 'a.jpg present in failed_files');
  assert.match(aEntry.reason, /HTTP 502/);
  assert.ok(!aEntry.reason.includes('\n'), 'reason must be single-line');
  assert.ok(aEntry.reason.length <= 120, `reason length must be ≤120, got ${aEntry.reason.length}`);
});

test('_uploadFolderPixfizz: single-file blip recovers cleanly → manifest errors:0', async (t) => {
  resetState();
  const dir = makeWorkspace({ 'a.jpg': 'a' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let manifestBody = null;
  __putBufferScript = async (buffer, contentType) => {
    if (contentType === 'application/json') manifestBody = JSON.parse(buffer.toString('utf8'));
  };

  // First PUT fails 502, second succeeds — proves the inner _uploadWithRetry
  // now handles 5xx. Presign succeeds every call.
  let putAttempts = 0;
  __putScript = async () => {
    putAttempts++;
    if (putAttempts === 1) throw new Error('Upload failed: HTTP 502 — bad gateway');
    return;
  };

  const result = await s3Service._uploadFolderPixfizz(
    dir, 'film-scans/loc/', { provider: 'pixfizz', locationId: 'loc' },
  );

  assert.equal(result.failed, 0);
  assert.equal(result.uploaded, 1);
  assert.ok(manifestBody);
  assert.equal(manifestBody.errors, 0);
  assert.deepEqual(manifestBody.failed_files, []);
});
