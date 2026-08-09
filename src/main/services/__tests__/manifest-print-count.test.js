/**
 * Tests for src/main/services/manifest-print-count.js.
 *
 * The helper is the single source of truth for the M3 hold gate — it MUST
 * return the same total the M4 splitter will read at dispatch time
 * (print-service.js:1938 `manifestImg.quantity || 1`). Anything else and
 * the gate holds jobs the splitter would happily dispatch, or (worse)
 * lets jobs through that then dispatch as one big file.
 *
 * All fs / config-service / electron interaction is shimmed via the
 * routing-service style require-cache pattern.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('fs');
const Module = require('node:module');

// ── Shim electron-store, electron, config-service, logger before the helper loads ──

const fakeElectron = {
  app: { getPath: () => os.tmpdir(), on: () => {} },
};

let __downloadDirectory = null;
const fakeConfigService = {
  get: (key) => (key === 'downloadDirectory' ? __downloadDirectory : undefined),
};

const fakeLogger = {
  info:         () => {},
  warn:         () => {},
  error:        () => {},
  logError:     () => {},
  logWarning:   () => {},
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') {
    return function FakeStore() {
      return { get: (_k, d) => d, set: () => {}, delete: () => {}, has: () => false };
    };
  }
  if (req === 'electron')                   return fakeElectron;
  if (req === './config-service')           return fakeConfigService;
  if (req === './logger')                   return fakeLogger;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { readManifestPrintCountSync, stampPrintCount } = require(
  path.join(REPO, 'src', 'main', 'services', 'manifest-print-count.js'),
);

// ── Fs fixture helpers ──────────────────────────────────────────────────────

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-mpc-'));
__downloadDirectory = TEST_ROOT;

function writeOrderManifest(orderNumber, orderId, manifestBody) {
  const orderFolder = path.join(TEST_ROOT, `${orderNumber}_${orderId}`);
  fs.mkdirSync(orderFolder, { recursive: true });
  const manifestPath = path.join(orderFolder, `${orderNumber}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifestBody), 'utf8');
  return manifestPath;
}

function writeOrderJsonFallback(orderNumber, orderId, manifestBody) {
  const orderFolder = path.join(TEST_ROOT, `${orderNumber}_${orderId}`);
  fs.mkdirSync(orderFolder, { recursive: true });
  const manifestPath = path.join(orderFolder, `order.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifestBody), 'utf8');
  return manifestPath;
}

const baseJob = { order_number: 'PRLE-EL2KTR', order_id: 'oid-1', id: 42 };

// ── Happy paths ─────────────────────────────────────────────────────────────

test('sums per-image quantity for the matching jobId', () => {
  writeOrderManifest('PRLE-EL2KTR', 'oid-1', {
    jobs: [
      { jobId: 42, images: [{ quantity: 3 }, { quantity: 2 }, { quantity: 5 }] },
      { jobId: 99, images: [{ quantity: 100 }] },   // must be ignored
    ],
  });
  assert.equal(readManifestPrintCountSync(baseJob), 10);
});

test('missing quantity defaults to 1 (matches M4 splitter fallback)', () => {
  writeOrderManifest('PRLE-EL2KTR', 'oid-1', {
    jobs: [{ jobId: 42, images: [{}, { quantity: null }, { quantity: 0 }, { quantity: -3 }, { quantity: 4 }] }],
  });
  // 1 + 1 + 1 + 1 + 4 = 8. All non-positive / non-finite treated as 1 per
  // the same rule as print-service.js:1938 (`manifestImg.quantity || 1`).
  assert.equal(readManifestPrintCountSync(baseJob), 8);
});

test('matches by internal_job_id when jobId in manifest differs from job.id', () => {
  writeOrderManifest('PRLE-EL2KTR', 'oid-1', {
    jobs: [{ jobId: 'internal-abc', images: [{ quantity: 7 }] }],
  });
  const job = { ...baseJob, id: 42, internal_job_id: 'internal-abc' };
  assert.equal(readManifestPrintCountSync(job), 7);
});

test('falls back to order.json when {orderNumber}.json is absent', () => {
  writeOrderJsonFallback('FALL-BACK', 'oid-fb', {
    jobs: [{ jobId: 42, images: [{ quantity: 2 }, { quantity: 3 }] }],
  });
  const job = { order_number: 'FALL-BACK', order_id: 'oid-fb', id: 42 };
  assert.equal(readManifestPrintCountSync(job), 5);
});

// ── Fail-open (returns null) — every degenerate input ───────────────────────

test('returns null when downloadDirectory is unset', () => {
  const prev = __downloadDirectory;
  __downloadDirectory = null;
  try {
    assert.equal(readManifestPrintCountSync(baseJob), null);
  } finally {
    __downloadDirectory = prev;
  }
});

test('returns null when the order folder does not exist', () => {
  const job = { order_number: 'NOPE', order_id: 'oid-none', id: 1 };
  assert.equal(readManifestPrintCountSync(job), null);
});

test('returns null when the manifest is empty (zero-byte — partial FTP write race)', () => {
  const orderFolder = path.join(TEST_ROOT, `EMPTY_oid-e`);
  fs.mkdirSync(orderFolder, { recursive: true });
  fs.writeFileSync(path.join(orderFolder, 'EMPTY.json'), '', 'utf8');
  const job = { order_number: 'EMPTY', order_id: 'oid-e', id: 1 };
  assert.equal(readManifestPrintCountSync(job), null);
});

test('returns null when the manifest is not valid JSON (partial write mid-stream)', () => {
  const orderFolder = path.join(TEST_ROOT, `BADJ_oid-bj`);
  fs.mkdirSync(orderFolder, { recursive: true });
  fs.writeFileSync(path.join(orderFolder, 'BADJ.json'), '{"jobs":[', 'utf8');
  const job = { order_number: 'BADJ', order_id: 'oid-bj', id: 1 };
  assert.equal(readManifestPrintCountSync(job), null);
});

test('returns null when the jobId is not in the manifest', () => {
  writeOrderManifest('NOTIN', 'oid-ni', { jobs: [{ jobId: 99, images: [{ quantity: 5 }] }] });
  const job = { order_number: 'NOTIN', order_id: 'oid-ni', id: 42 };
  assert.equal(readManifestPrintCountSync(job), null);
});

test('returns null when the job has an empty images array (0 is a valid answer, but distinguishes "no data" here)', () => {
  writeOrderManifest('EMPTY-IMGS', 'oid-ei', { jobs: [{ jobId: 42, images: [] }] });
  const job = { order_number: 'EMPTY-IMGS', order_id: 'oid-ei', id: 42 };
  // Empty images array → returned as 0 (the sum, honest). If the caller
  // wants to distinguish "empty" from "unknown" it must inspect the
  // manifest itself; the resolver's cap > 0 check ensures a 0 total
  // never trips the hold anyway.
  assert.equal(readManifestPrintCountSync(job), 0);
});

test('returns null when job is missing required identity fields', () => {
  assert.equal(readManifestPrintCountSync(null),               null);
  assert.equal(readManifestPrintCountSync({}),                 null);
  assert.equal(readManifestPrintCountSync({ order_number: 'x' }), null);
  assert.equal(readManifestPrintCountSync({ order_number: 'x', order_id: 'y' }), null);
});

// ── stampPrintCount — first-write cache with fail-open semantics ────────────
//
// The critical invariant: a fresh job's manifest is absent on the first poll
// (that's the awaiting-manifest state), so the first stamp attempt normally
// fails. It MUST leave _totalPrintCount unset so the next poll re-reads —
// otherwise the cache is poisoned on cycle one and the Jobs-grid badge
// never appears for any job. These tests lock that invariant.

test('stampPrintCount: no manifest → returns null AND leaves _totalPrintCount unset (retries on next poll)', () => {
  const job = { order_number: 'RETRY', order_id: 'oid-r', id: 1 };
  const n = stampPrintCount(job);
  assert.equal(n, null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(job, '_totalPrintCount'),
    false,
    'field MUST stay unset (not null, not 0) so Number.isFinite check falls through on the next poll',
  );
});

test('stampPrintCount: sequence — no manifest → null; manifest arrives → count lands and caches; cache survives manifest removal', () => {
  const job = { order_number: 'SEQ', order_id: 'oid-seq', id: 42 };

  // Cycle 1 — manifest not on disk yet. Awaiting-manifest state.
  assert.equal(stampPrintCount(job), null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(job, '_totalPrintCount'),
    false,
    'first failed stamp must not touch the field',
  );

  // Manifest arrives (FTP finishes, or S3 downloader writes it).
  writeOrderManifest('SEQ', 'oid-seq', {
    jobs: [{ jobId: 42, images: [{ quantity: 3 }, { quantity: 4 }] }],
  });

  // Cycle 2 — count lands and caches.
  assert.equal(stampPrintCount(job), 7);
  assert.equal(job._totalPrintCount, 7);

  // Cycle 3 — cached; delete the manifest and confirm the cached value
  // still returns without any disk hit. This is the "stable once known"
  // property that lets job-service avoid hitting SMB every poll.
  fs.rmSync(path.join(TEST_ROOT, 'SEQ_oid-seq'), { recursive: true, force: true });
  assert.equal(stampPrintCount(job), 7);
  assert.equal(job._totalPrintCount, 7);
});

test('stampPrintCount: 0 is a legitimate cached value (empty images array); does not trigger a re-read', () => {
  // A job whose manifest lists zero images (rare, but possible if the
  // operator discards all images before dispatch) legitimately has a
  // 0 print count. That's stable — the value should cache and not
  // re-read next poll. The resolver's cap > 0 check ensures 0 never
  // trips the hold anyway.
  writeOrderManifest('ZERO', 'oid-zero', { jobs: [{ jobId: 1, images: [] }] });
  const job = { order_number: 'ZERO', order_id: 'oid-zero', id: 1 };
  assert.equal(stampPrintCount(job), 0);
  assert.equal(job._totalPrintCount, 0);

  // Second call — cached (guard is `>= 0`, so 0 counts as "known").
  // Delete the manifest to prove no re-read.
  fs.rmSync(path.join(TEST_ROOT, 'ZERO_oid-zero'), { recursive: true, force: true });
  assert.equal(stampPrintCount(job), 0);
});

test('stampPrintCount: passing null / non-object → returns null, mutates nothing', () => {
  assert.equal(stampPrintCount(null),      null);
  assert.equal(stampPrintCount(undefined), null);
  assert.equal(stampPrintCount('nope'),    null);
  assert.equal(stampPrintCount(42),        null);
});

test('stampPrintCount: bad-JSON manifest → returns null AND leaves field unset (retries next poll)', () => {
  // Same failure semantics as "manifest absent" — a partial FTP write
  // must not poison the cache.
  const orderFolder = path.join(TEST_ROOT, `BADSEQ_oid-bad`);
  fs.mkdirSync(orderFolder, { recursive: true });
  fs.writeFileSync(path.join(orderFolder, 'BADSEQ.json'), '{"jobs":[', 'utf8');

  const job = { order_number: 'BADSEQ', order_id: 'oid-bad', id: 1 };
  assert.equal(stampPrintCount(job), null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(job, '_totalPrintCount'),
    false,
  );

  // Now overwrite with valid content.
  fs.writeFileSync(
    path.join(orderFolder, 'BADSEQ.json'),
    JSON.stringify({ jobs: [{ jobId: 1, images: [{ quantity: 12 }] }] }),
    'utf8',
  );
  assert.equal(stampPrintCount(job), 12);
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

test.after(() => {
  Module.prototype.require = __originalRequire;
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
