'use strict';

/**
 * Unit tests for the M5 conditional /jobs/pending path (ohd-api v1.4.0).
 *
 * Follows the same module-level require.cache injection pattern used by
 * the other job-service-*.test.js files. Additional stubs:
 *   - server-capabilities exposes a configurable pending_etag flag.
 *   - routing-service.getRoutingHeldProcesses is settable per-test so
 *     the 304 re-derive test can flip a hold in the middle of a run.
 *   - _httpRequest is overridden per-test to return canned responses
 *     including the `headers` object M5a added.
 *
 * Test map (M5 brief):
 *   1. First fetch sends no If-None-Match; stores etag + presign_expires_at.
 *   2. Second fetch sends the stored etag verbatim (weak prefix preserved).
 *   3. 304 → jobs identity preserved, lastFetchTime advances, no JSON.parse of empty body.
 *   4. 304 → hold flags re-derived (flip routing-held set between polls).
 *   5. presign_expires_at inside safety margin → no If-None-Match sent.
 *   6. locationId change → etag dropped, full 200 requested.
 *   7. invalidatePendingEtag() → next fetch omits If-None-Match, then resumes.
 *   8. pending_etag feature off → never sends the header.
 *   9. A 500 leaves the stored etag intact.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── mutable test state ──────────────────────────────────────────────────────

let __locationId          = 'loc-A';
let __pendingEtagEnabled  = true;
let __routingHeldSet      = new Set();

const fakeServerCapabilities = {
  isEnabled(flag) {
    if (flag === 'pending_etag') return __pendingEtagEnabled;
    return false;
  },
  getPollIntervalMs:       () => 60000,
  getStatusPollIntervalMs: () => null,
  getStatusBatchMax:       () => 200,
};

const fakeConfigService = {
  get: () => undefined,
  getApiSettings: () => ({
    baseUrl:        'https://api.example.test/functions/v1/ohd-api',
    key:            'test-key',
    organizationId: 'org-1',
    locationId:     __locationId,
  }),
};

const fakeRoutingService = {
  // Called by job-service._getRoutingHeldProcesses.
  getRoutingHeldProcesses: () => __routingHeldSet,
};

const __log = { info: [], warn: [], error: [] };
const noopLogger = {
  info:       (...a) => __log.info.push(a),
  warn:       (...a) => __log.warn.push(a),
  logError:   (...a) => __log.error.push(a),
  logWarning: (...a) => __log.warn.push(a),
};

const FakeStore = function () {
  const data = {};
  return { get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } };
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'),        fakeConfigService);
stubInCache(path.join(SVC, 'logger.js'),                noopLogger);
stubInCache(path.join(SVC, 'routing-service.js'),       fakeRoutingService);
stubInCache(path.join(SVC, 'server-capabilities.js'),   { serverCapabilities: fakeServerCapabilities });
stubInCache(path.join(SVC, 'ohd-telemetry-headers.js'), { getOhdTelemetryHeaders: () => ({}) });

const jobService = require(path.join(SVC, 'job-service.js'));

// ── per-test helpers ────────────────────────────────────────────────────────

/**
 * Wipe the singleton's persisted M5 fields so every test starts fresh.
 * jobStore is in-memory (FakeStore) but shared across tests in this file.
 */
function reset() {
  jobService.jobs                     = [];
  jobService.lastFetchTime            = null;
  jobService._pendingEtag             = null;
  jobService._pendingEtagKey          = null;
  jobService._presignExpiresAt        = null;
  jobService._forcePendingRefresh     = false;
  __locationId                        = 'loc-A';
  __pendingEtagEnabled                = true;
  __routingHeldSet                    = new Set();
  __log.info.length  = 0;
  __log.warn.length  = 0;
  __log.error.length = 0;
  delete jobService._httpRequest;
}

/** Presign expiry ISO 30 min in the future — safely outside the 5-min window. */
function futurePresign() {
  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

/** Fake apiJob body shape close enough to what _mapApiJob needs. */
function apiJob(overrides = {}) {
  return {
    job_id:       'job-1',
    order_id:     'ord-1',
    order_number: 'PX-1',
    locations:    ['loc-A'],
    ...overrides,
  };
}

function installHttpSpy(handler) {
  const calls = [];
  jobService._httpRequest = async (method, url, apiKey, body, extraHeaders) => {
    const call = { method, url, apiKey, body, extraHeaders };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return calls;
}

// ── tests ───────────────────────────────────────────────────────────────────

test('first fetch sends no If-None-Match; stores etag + presign_expires_at', async () => {
  reset();
  const presign = futurePresign();
  const calls = installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"abc123"' },
    body: JSON.stringify({
      jobs: [apiJob()],
      etag: 'W/"abc123"',
      presign_expires_at: presign,
    }),
  }));

  await jobService.fetchJobs();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].extraHeaders['If-None-Match'], undefined, 'no conditional on first fetch');
  assert.equal(jobService._pendingEtag,      'W/"abc123"');
  assert.equal(jobService._presignExpiresAt, presign);
  assert.equal(jobService._pendingEtagKey,   'loc-A|false');
  assert.equal(jobService._forcePendingRefresh, false);
});

test('second fetch sends the stored etag verbatim (weak prefix preserved)', async () => {
  reset();
  const presign = futurePresign();
  const calls = installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"abc123"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"abc123"', presign_expires_at: presign }),
  }));

  await jobService.fetchJobs();       // primes state
  await jobService.fetchJobs();       // second call — should carry If-None-Match

  assert.equal(calls[1].extraHeaders['If-None-Match'], 'W/"abc123"', 'weak tag sent verbatim');
});

test('304 → jobs identity preserved, lastFetchTime advances, no JSON.parse of empty body', async () => {
  reset();
  const presign = futurePresign();

  // Prime: 200 with a job so we have state to preserve.
  installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"v1"' },
    body: JSON.stringify({ jobs: [apiJob({ job_id: 'j1' })], etag: 'W/"v1"', presign_expires_at: presign }),
  }));
  await jobService.fetchJobs();
  const priorJobsSnapshot = jobService.jobs.map(j => ({ id: j.id, _status: j._status }));
  const priorFetchTime    = jobService.lastFetchTime;

  // Bump the clock a hair so lastFetchTime is meaningfully greater.
  await new Promise(r => setTimeout(r, 5));

  // Next fetch: 304 with an EMPTY body. If job-service tries to JSON.parse('')
  // it will throw and we'd never make it to the assertions.
  installHttpSpy(() => ({ statusCode: 304, headers: { etag: 'W/"v1"' }, body: '' }));
  await jobService.fetchJobs();

  // Content preserved (the brief itself uses `.map` to re-derive hold
  // flags, so array reference identity isn't guaranteed — but the set
  // of jobs is unchanged and unaffected by the empty response body).
  assert.equal(jobService.jobs.length, 1, 'no jobs added or removed');
  assert.deepEqual(
    jobService.jobs.map(j => ({ id: j.id, _status: j._status })),
    priorJobsSnapshot,
    'jobs preserved by id + local status',
  );
  assert.ok(jobService.lastFetchTime > priorFetchTime, 'lastFetchTime advanced');
});

test('304 → hold flags re-derived (routing-held set change flips _holdForReview)', async () => {
  reset();
  const presign = futurePresign();

  installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"v1"' },
    body: JSON.stringify({
      jobs: [apiJob({ job_id: 'j1', process: 'noritsu-4x6' })],
      etag: 'W/"v1"',
      presign_expires_at: presign,
    }),
  }));
  await jobService.fetchJobs();
  assert.equal(jobService.jobs[0]._holdForReview, false, 'no hold before we flip the set');

  // Operator flips a routing hold ON between polls.
  __routingHeldSet = new Set(['noritsu-4x6']);

  installHttpSpy(() => ({ statusCode: 304, headers: {}, body: '' }));
  await jobService.fetchJobs();

  assert.equal(jobService.jobs[0]._holdForReview, true, '304 re-derived the hold flags');
  assert.ok(
    Array.isArray(jobService.jobs[0]._holdReasons) && jobService.jobs[0]._holdReasons.includes('routing-hold'),
    'routing-hold reason present'
  );
});

test('presign_expires_at inside safety margin → no If-None-Match sent', async () => {
  reset();

  // Prime with a presign that's only 2 minutes away — inside the 5-min window.
  const soon = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"v1"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"v1"', presign_expires_at: soon }),
  }));
  await jobService.fetchJobs();

  // Next fetch — even though we have an etag, presign is about to expire.
  const calls = installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"v2"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"v2"', presign_expires_at: futurePresign() }),
  }));
  await jobService.fetchJobs();

  assert.equal(calls[0].extraHeaders['If-None-Match'], undefined, 'skipped conditional to refresh URLs');
});

test('locationId change → etag dropped, full 200 requested', async () => {
  reset();
  const presign = futurePresign();

  installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"loc-A-tag"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"loc-A-tag"', presign_expires_at: presign }),
  }));
  await jobService.fetchJobs();

  // Operator switches location — the stored etag belongs to loc-A, not loc-B.
  __locationId = 'loc-B';

  const calls = installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"loc-B-tag"' },
    body: JSON.stringify({ jobs: [], etag: 'W/"loc-B-tag"', presign_expires_at: presign }),
  }));
  await jobService.fetchJobs();

  assert.equal(calls[0].extraHeaders['If-None-Match'], undefined, 'no conditional after location change');
  assert.equal(calls[0].extraHeaders['X-Location-ID'], 'loc-B');
  assert.equal(jobService._pendingEtag,    'W/"loc-B-tag"');
  assert.equal(jobService._pendingEtagKey, 'loc-B|false');
});

test('invalidatePendingEtag() → next fetch omits If-None-Match, then resumes', async () => {
  reset();
  const presign = futurePresign();

  installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"v1"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"v1"', presign_expires_at: presign }),
  }));
  await jobService.fetchJobs();

  jobService.invalidatePendingEtag();

  const calls = installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"v2"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"v2"', presign_expires_at: presign }),
  }));
  await jobService.fetchJobs();

  assert.equal(calls[0].extraHeaders['If-None-Match'], undefined, 'forced refresh cycle omits conditional');
  assert.equal(jobService._forcePendingRefresh, false, 'flag cleared after successful 200');

  const calls2 = installHttpSpy(() => ({
    statusCode: 304,
    headers:    {},
    body:       '',
  }));
  await jobService.fetchJobs();

  assert.equal(calls2[0].extraHeaders['If-None-Match'], 'W/"v2"', 'conditional resumes on the cycle after');
});

test('pending_etag feature off → never sends the header at all', async () => {
  reset();
  __pendingEtagEnabled = false;
  const presign = futurePresign();

  installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"v1"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"v1"', presign_expires_at: presign }),
  }));
  await jobService.fetchJobs();      // stores etag even so — cheap and future-proof

  const calls = installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"v2"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"v2"', presign_expires_at: presign }),
  }));
  await jobService.fetchJobs();

  assert.equal(calls[0].extraHeaders['If-None-Match'], undefined, 'flag gates the whole send');
});

test('a 500 leaves the stored etag intact', async () => {
  reset();
  const presign = futurePresign();

  installHttpSpy(() => ({
    statusCode: 200,
    headers:    { etag: 'W/"good"' },
    body: JSON.stringify({ jobs: [apiJob()], etag: 'W/"good"', presign_expires_at: presign }),
  }));
  await jobService.fetchJobs();
  const priorEtag = jobService._pendingEtag;

  installHttpSpy(() => ({
    statusCode: 500,
    headers:    {},
    body:       'internal error',
  }));
  await jobService.fetchJobs();

  assert.equal(jobService._pendingEtag, priorEtag, 'etag preserved after transient 5xx');
});
