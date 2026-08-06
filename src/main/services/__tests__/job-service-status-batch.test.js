'use strict';

/**
 * Unit tests for job-service's batch status-sync path (ohd-api v1.4.0).
 *
 * Follows the module-level require.cache injection pattern used by the
 * other job-service-*.test.js files. Additional stubs vs those tests:
 *   - server-capabilities is stubbed with a fake whose feature flag and
 *     batch-max are controlled per-test via __caps.
 *   - _httpRequest is overridden per-test to capture requests and return
 *     canned responses without touching the network.
 *
 * Coverage maps to the M3 brief's nine cases:
 *   1. 250 active jobs → 3 sequential requests, ids as strings, split correctly.
 *   2. Mixed-case terminal status → both collapse to _status='completed'.
 *   3. errors[] 400 → _status='error' with the exact legacy message.
 *   4. errors[] 404 → warning only, job untouched.
 *   5. Out-of-order requested_job_id still maps to the right local job.
 *   6. Numeric local job.id matches a string requested_job_id.
 *   7. success:false → returns 0, no job mutated.
 *   8. Endpoint 404 → feature disabled for session AND per-job path runs.
 *   9. status_batch:false → per-job path only, zero batch requests.
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

// ── shared mutable state ────────────────────────────────────────────────────

const __caps = {
  statusBatch:     true,
  statusBatchMax:  100,
  disabledCalls:   [],
};

const __log = { info: [], warn: [], error: [] };

const noopLogger = {
  info:       (...a) => __log.info.push(a),
  warn:       (...a) => __log.warn.push(a),
  logError:   (...a) => __log.error.push(a),
  logWarning: (...a) => __log.warn.push(a),
};

const fakeConfigService = {
  get: () => undefined,
  getApiSettings: () => ({
    baseUrl:        'https://api.example.test/functions/v1/ohd-api',
    key:            'test-key',
    organizationId: 'org-1',
    locationId:     'loc-1',
  }),
};

const fakeServerCapabilities = {
  isEnabled(flag) {
    if (flag === 'status_batch') return __caps.statusBatch;
    return false;
  },
  getStatusBatchMax() { return __caps.statusBatchMax; },
  disableFeatureForSession(flag) { __caps.disabledCalls.push(flag); },
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
stubInCache(path.join(SVC, 'routing-service.js'),       { getRoutingHeldProcesses: () => [] });
stubInCache(path.join(SVC, 'server-capabilities.js'),   { serverCapabilities: fakeServerCapabilities });
stubInCache(path.join(SVC, 'ohd-telemetry-headers.js'), { getOhdTelemetryHeaders: () => ({}) });

const jobService = require(path.join(SVC, 'job-service.js'));

// ── per-test helpers ────────────────────────────────────────────────────────

function reset() {
  jobService.jobs = [];
  __caps.statusBatch    = true;
  __caps.statusBatchMax = 100;
  __caps.disabledCalls.length = 0;
  __log.info.length  = 0;
  __log.warn.length  = 0;
  __log.error.length = 0;
  // Restore _httpRequest each test — some tests override.
  delete jobService._httpRequest;
}

/**
 * Install an _httpRequest spy that records calls and returns responses
 * from a handler.  Handler receives (call) and returns { statusCode, body }.
 */
function installHttpSpy(handler) {
  const calls = [];
  jobService._httpRequest = async (method, url, apiKey, body, extraHeaders) => {
    const call = { method, url, apiKey, body, extraHeaders };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return calls;
}

function activeJob(overrides = {}) {
  return {
    id:            'job-1',
    order_id:      'ord-1',
    order_number:  'PX-1',
    _status:       'pending',
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

test('250 active jobs → 3 sequential requests at max 100 each; ids stringified', async () => {
  reset();
  __caps.statusBatchMax = 100;
  jobService.jobs = Array.from({ length: 250 }, (_, i) =>
    activeJob({ id: 1000 + i, order_number: `PX-${i}` }));

  const calls = installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({ success: true, jobs: [], errors: [] }),
  }));

  await jobService.syncJobStatusFromOH();

  assert.equal(calls.length, 3, 'three sequential batches');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/jobs\/status-batch$/);

  assert.equal(calls[0].body.job_ids.length, 100);
  assert.equal(calls[1].body.job_ids.length, 100);
  assert.equal(calls[2].body.job_ids.length, 50);

  // Ids are strings — server matches by string requested_job_id.
  for (const id of calls[0].body.job_ids) assert.equal(typeof id, 'string');
  assert.equal(calls[0].body.job_ids[0], '1000');
  assert.equal(calls[2].body.job_ids[49], '1249');

  // Location and organisation headers propagated.
  assert.equal(calls[0].extraHeaders['X-Organization-ID'], 'org-1');
  assert.equal(calls[0].extraHeaders['X-Location-ID'], 'loc-1');
});

test('mixed-case terminal status collapses to _status="completed"; returned count is right', async () => {
  reset();
  jobService.jobs = [
    activeJob({ id: 'A' }),
    activeJob({ id: 'B' }),
    activeJob({ id: 'C' }),
  ];

  installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      jobs: [
        { requested_job_id: 'A', status: 'Completed' },
        { requested_job_id: 'B', status: 'cancelled' },
        { requested_job_id: 'C', status: 'InProduction' },
      ],
      errors: [],
    }),
  }));

  const count = await jobService.syncJobStatusFromOH();

  assert.equal(count, 2);
  const byId = Object.fromEntries(jobService.jobs.map(j => [j.id, j]));
  assert.equal(byId.A._status, 'completed');
  assert.equal(byId.B._status, 'completed');
  assert.equal(byId.C._status, 'pending', 'non-terminal status left alone');
});

test('errors[] 400 → _status="error" with the exact legacy message', async () => {
  reset();
  jobService.jobs = [activeJob({ id: 'X' })];

  installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      jobs: [],
      errors: [{ requested_job_id: 'X', status: 400, error: 'Invalid job_id format.' }],
    }),
  }));

  await jobService.syncJobStatusFromOH();

  const job = jobService.jobs[0];
  assert.equal(job._status, 'error');
  assert.equal(
    job._errorMessage,
    'OrderHub no longer recognizes this job (HTTP 400 on status sync) — it may have been deleted upstream.'
  );
});

test('errors[] 404 → warning only, job untouched (must NOT mark as error)', async () => {
  reset();
  jobService.jobs = [activeJob({ id: 'Y', _status: 'in_production' })];

  installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      jobs: [],
      errors: [{ requested_job_id: 'Y', status: 404, error: 'Job not found.' }],
    }),
  }));

  await jobService.syncJobStatusFromOH();

  const job = jobService.jobs[0];
  assert.equal(job._status, 'in_production', 'status preserved');
  assert.equal(job._errorMessage, undefined, 'no error message stamped');
  assert.ok(
    __log.warn.some(a => JSON.stringify(a).includes('Failed to fetch job status from OH')),
    'warning was logged'
  );
});

test('out-of-order requested_job_id still maps to the right local job', async () => {
  reset();
  jobService.jobs = [
    activeJob({ id: 'first'  }),
    activeJob({ id: 'second' }),
    activeJob({ id: 'third'  }),
  ];

  installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      jobs: [
        { requested_job_id: 'third',  status: 'Completed' },
        { requested_job_id: 'first',  status: 'pending' },
        { requested_job_id: 'second', status: 'Cancelled' },
      ],
      errors: [],
    }),
  }));

  const count = await jobService.syncJobStatusFromOH();

  assert.equal(count, 2);
  const byId = Object.fromEntries(jobService.jobs.map(j => [j.id, j]));
  assert.equal(byId.first._status,  'pending');
  assert.equal(byId.second._status, 'completed');
  assert.equal(byId.third._status,  'completed');
});

test('numeric local job.id matches a string requested_job_id', async () => {
  reset();
  jobService.jobs = [activeJob({ id: 38526437 })]; // numeric like Pixfizz

  const calls = installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      jobs: [{ requested_job_id: '38526437', status: 'Completed' }],
      errors: [],
    }),
  }));

  await jobService.syncJobStatusFromOH();

  assert.equal(calls[0].body.job_ids[0], '38526437', 'sent as string');
  assert.equal(jobService.jobs[0]._status, 'completed', 'string→number match worked');
});

test('{ success: false } → returns 0, no job mutated', async () => {
  reset();
  jobService.jobs = [activeJob({ id: 'Z' })];

  installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({ success: false, error: 'Missing job_ids' }),
  }));

  const count = await jobService.syncJobStatusFromOH();

  assert.equal(count, 0);
  assert.equal(jobService.jobs[0]._status, 'pending', 'left alone');
  assert.equal(jobService.jobs[0]._errorMessage, undefined);
});

test('endpoint 404 → feature disabled for session AND per-job path runs the cycle', async () => {
  reset();
  jobService.jobs = [
    activeJob({ id: 'p1' }),
    activeJob({ id: 'p2' }),
  ];

  // Per-job requests come in as GETs; the batch attempt is a POST that 404s.
  const calls = installHttpSpy((call) => {
    if (call.method === 'POST' && /status-batch/.test(call.url)) {
      return { statusCode: 404, body: 'Not found' };
    }
    // Per-job GET: report both as Completed so we can see the per-job path
    // actually ran and mutated state.
    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'Completed' }),
    };
  });

  const count = await jobService.syncJobStatusFromOH();

  assert.deepEqual(__caps.disabledCalls, ['status_batch'], 'feature muted for session');
  assert.equal(count, 2, 'per-job path returned two auto-completions');
  assert.equal(jobService.jobs[0]._status, 'completed');
  assert.equal(jobService.jobs[1]._status, 'completed');

  // Sanity: exactly one batch attempt, then per-job GETs for each active job.
  const batchCalls = calls.filter(c => /status-batch/.test(c.url));
  const perJobCalls = calls.filter(c => !/status-batch/.test(c.url));
  assert.equal(batchCalls.length, 1);
  assert.equal(perJobCalls.length, 2);
  for (const c of perJobCalls) assert.equal(c.method, 'GET');
});

test('requested id absent from both jobs[] and errors[] → warning only, job untouched', async () => {
  reset();
  jobService.jobs = [
    activeJob({ id: 'present' }),
    activeJob({ id: 'ghost',   _status: 'in_production' }),
  ];

  installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      // Server responded about 'present' only — 'ghost' silently omitted.
      jobs:   [{ requested_job_id: 'present', status: 'pending' }],
      errors: [],
    }),
  }));

  await jobService.syncJobStatusFromOH();

  const byId = Object.fromEntries(jobService.jobs.map(j => [j.id, j]));
  assert.equal(byId.present._status, 'pending', 'echoed non-terminal → untouched');
  assert.equal(byId.ghost._status,   'in_production', 'omitted job left alone');
  assert.equal(byId.ghost._errorMessage, undefined, 'no error stamp on the omitted job');

  const omitWarnings = __log.warn.filter(a =>
    JSON.stringify(a).includes('status-batch response omitted requested job')
  );
  assert.equal(omitWarnings.length, 1);
  assert.ok(
    JSON.stringify(omitWarnings[0]).includes('ghost'),
    'warning names the omitted job id'
  );
});

test('status_batch flag off → per-job path only, zero batch requests', async () => {
  reset();
  __caps.statusBatch = false;
  jobService.jobs = [activeJob({ id: 'q1' }), activeJob({ id: 'q2' })];

  const calls = installHttpSpy(() => ({
    statusCode: 200,
    body: JSON.stringify({ status: 'pending' }),
  }));

  await jobService.syncJobStatusFromOH();

  assert.ok(calls.length > 0, 'per-job path ran');
  for (const c of calls) {
    assert.equal(c.method, 'GET', 'per-job path uses GET');
    assert.doesNotMatch(c.url, /status-batch/, 'no batch endpoint touched');
  }
});
