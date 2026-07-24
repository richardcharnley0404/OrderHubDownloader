'use strict';

/**
 * Unit tests for src/main/services/presign-service.js retry behaviour
 * (2026-07-24 lab-safety pass).
 *
 * Presign is idempotent → safe to retry on transient failures. Retries
 * fire on network errors, HTTP 429, and HTTP 5xx; 4xx (except 429)
 * throws immediately.
 *
 * Test technique:
 *   - Stub electron-store + logger + config-service before loading
 *     presign-service (module-level singletons that the service
 *     require()s on load).
 *   - Monkey-patch presignService._httpRequest per test to control
 *     status codes and simulate transient failures. This is cleaner
 *     than stubbing the underlying https module for the same shape.
 *   - Shrink the backoff table so each test finishes in <100 ms
 *     instead of the production ~11 s.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const os      = require('node:os');
const path    = require('node:path');
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

const presignService = require(path.join(SVC, 'presign-service.js'));
const { isRetryableOutcome } = presignService;

// Speed up the retry loop so tests finish quickly. The real values are
// [1000, 3000, 7000] + up to 500 ms jitter; we shrink to single-digit
// millis so the full 4-attempt ladder is a few ms of wall clock.
presignService.RETRY_BACKOFFS_MS.splice(0, presignService.RETRY_BACKOFFS_MS.length, 1, 1, 1);

const FILES = [{ name: 'a.jpg', folder: 'film-scans', sub_path: 'roll/1', size: 100, type: 'image/jpeg' }];

/**
 * Install a scripted _httpRequest that consumes `responses` one per
 * call. Each entry is either an { statusCode, body } object (server
 * response) or an Error instance (transport failure). Returns a
 * `calls` array populated with the same shape (successful / thrown)
 * so tests can assert attempt counts.
 */
function scriptHttp(responses) {
  const calls = [];
  presignService._httpRequest = async function (method, url, apiKey, body, extraHeaders) {
    calls.push({ method, url, body });
    const next = responses.shift();
    if (!next) throw new Error(`scripted _httpRequest exhausted after ${calls.length} calls`);
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}

// ── isRetryableOutcome ──────────────────────────────────────────────────────

test('isRetryableOutcome: transport error → retry', () => {
  assert.equal(isRetryableOutcome({ transportError: new Error('socket hang up') }), true);
});

test('isRetryableOutcome: 429 → retry, 500/502/503/504 → retry, 599 → retry', () => {
  for (const s of [429, 500, 502, 503, 504, 599]) {
    assert.equal(isRetryableOutcome({ statusCode: s }), true, `HTTP ${s} should retry`);
  }
});

test('isRetryableOutcome: 200 / 201 / 3xx / 400 / 401 / 403 / 404 → do NOT retry', () => {
  for (const s of [200, 201, 302, 400, 401, 403, 404]) {
    assert.equal(isRetryableOutcome({ statusCode: s }), false, `HTTP ${s} should not retry`);
  }
});

test('isRetryableOutcome: null / undefined / empty → false', () => {
  assert.equal(isRetryableOutcome(null), false);
  assert.equal(isRetryableOutcome(undefined), false);
  assert.equal(isRetryableOutcome({}), false);
});

// ── retry orchestration ────────────────────────────────────────────────────

test('getPresignedUrls: 502 once then 200 → succeeds after 2 attempts', async () => {
  const calls = scriptHttp([
    { statusCode: 502, body: '<html>bad gateway</html>' },
    { statusCode: 200, body: JSON.stringify({ uploads: [{ file_name: 'a.jpg', file_key: 'film-scans/loc/roll/1/a.jpg', upload_url: 'https://s3.test/x' }] }) },
  ]);
  const results = await presignService.getPresignedUrls(FILES, 'loc');
  assert.equal(calls.length, 2, 'exactly 2 HTTP calls (retry once)');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'a.jpg');
  assert.equal(results[0].upload_url, 'https://s3.test/x');
});

test('getPresignedUrls: 502 twice then 200 → succeeds after 3 attempts', async () => {
  const calls = scriptHttp([
    { statusCode: 502, body: 'x' },
    { statusCode: 502, body: 'x' },
    { statusCode: 200, body: JSON.stringify({ uploads: [{ file_name: 'a.jpg', file_key: 'k', upload_url: 'u' }] }) },
  ]);
  const results = await presignService.getPresignedUrls(FILES, 'loc');
  assert.equal(calls.length, 3);
  assert.equal(results.length, 1);
});

test('getPresignedUrls: 500 four times → throws after MAX_ATTEMPTS with the last error', async () => {
  const calls = scriptHttp([
    { statusCode: 500, body: 'fail 1' },
    { statusCode: 500, body: 'fail 2' },
    { statusCode: 500, body: 'fail 3' },
    { statusCode: 500, body: 'fail 4' },
  ]);
  await assert.rejects(
    () => presignService.getPresignedUrls(FILES, 'loc'),
    /HTTP 500/,
  );
  assert.equal(calls.length, 4, 'exactly MAX_ATTEMPTS = 4 calls');
});

test('getPresignedUrls: 429 once then 200 → retry succeeds', async () => {
  const calls = scriptHttp([
    { statusCode: 429, body: 'rate limited' },
    { statusCode: 200, body: JSON.stringify({ uploads: [{ file_name: 'a.jpg', file_key: 'k', upload_url: 'u' }] }) },
  ]);
  const results = await presignService.getPresignedUrls(FILES, 'loc');
  assert.equal(calls.length, 2);
  assert.equal(results.length, 1);
});

test('getPresignedUrls: 401 → throws immediately, NO retry (fast fail on 4xx)', async () => {
  const calls = scriptHttp([
    { statusCode: 401, body: 'unauthorized' },
  ]);
  await assert.rejects(
    () => presignService.getPresignedUrls(FILES, 'loc'),
    /HTTP 401/,
  );
  assert.equal(calls.length, 1, 'no retry — auth errors do not get better');
});

test('getPresignedUrls: 403 → throws immediately, NO retry', async () => {
  const calls = scriptHttp([
    { statusCode: 403, body: 'forbidden' },
  ]);
  await assert.rejects(
    () => presignService.getPresignedUrls(FILES, 'loc'),
    /HTTP 403/,
  );
  assert.equal(calls.length, 1);
});

test('getPresignedUrls: transport error (ECONNRESET) once then 200 → retry succeeds', async () => {
  const err = new Error('socket hang up');
  err.code = 'ECONNRESET';
  const calls = scriptHttp([
    err,
    { statusCode: 200, body: JSON.stringify({ uploads: [{ file_name: 'a.jpg', file_key: 'k', upload_url: 'u' }] }) },
  ]);
  const results = await presignService.getPresignedUrls(FILES, 'loc');
  assert.equal(calls.length, 2);
  assert.equal(results.length, 1);
});

test('getPresignedUrls: transport error four times → throws after MAX_ATTEMPTS', async () => {
  const err = () => new Error('ETIMEDOUT');
  const calls = scriptHttp([err(), err(), err(), err()]);
  await assert.rejects(
    () => presignService.getPresignedUrls(FILES, 'loc'),
    /ETIMEDOUT/,
  );
  assert.equal(calls.length, 4);
});

test('getPresignedUrls: 2xx with success:false → throws immediately (non-retryable)', async () => {
  const calls = scriptHttp([
    { statusCode: 200, body: JSON.stringify({ success: false, error: 'files array empty' }) },
  ]);
  await assert.rejects(
    () => presignService.getPresignedUrls(FILES, 'loc'),
    /files array empty/,
  );
  assert.equal(calls.length, 1, 'success:false is a request bug, not a transient blip — no retry');
});

test('getPresignedUrls: 2xx with unparseable body → throws immediately (non-retryable)', async () => {
  const calls = scriptHttp([
    { statusCode: 200, body: 'not-json{{{' },
  ]);
  await assert.rejects(
    () => presignService.getPresignedUrls(FILES, 'loc'),
    /not valid JSON/,
  );
  assert.equal(calls.length, 1);
});
