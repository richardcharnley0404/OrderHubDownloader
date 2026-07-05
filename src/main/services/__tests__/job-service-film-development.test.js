'use strict';

/**
 * Unit tests for the Film Development Auto Assignment additions to
 * job-service:
 *   - _mapApiJob captures is_film_development + twin_checks.
 *   - getLocalJobs filters film-dev jobs out (single choke point).
 *   - getFilmDevelopmentJobs returns only film-dev jobs.
 *   - _mergeJobs retention: film-dev jobs behave like any other pending
 *     job (retained while still returned by the API; dropped when not).
 *
 * Mirrors the harness used in job-service-date-format.test.js and
 * job-service-merge-retention.test.js — module-level stubs plus a
 * direct call into the module.
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

const fakeConfigService = { get: () => undefined };
const noopLogger = { info: () => {}, warn: () => {}, logError: () => {}, logWarning: () => {} };

const FakeStore = function () {
  const data = {};
  return { get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } };
};
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'),  fakeConfigService);
stubInCache(path.join(SVC, 'logger.js'),          noopLogger);
stubInCache(path.join(SVC, 'routing-service.js'), { getRoutingHeldProcesses: () => [] });

const jobService = require(path.join(SVC, 'job-service.js'));

// ── _mapApiJob field capture ────────────────────────────────────────────────

test('_mapApiJob defaults is_film_development to false and twin_checks to []', () => {
  const mapped = jobService._mapApiJob({
    job_id: 'JOB-1', order_number: 'PX-1', order_id: 'ord-1',
  });
  assert.equal(mapped.is_film_development, false);
  assert.deepEqual(mapped.twin_checks, []);
});

test('_mapApiJob captures is_film_development: true and preserves twin_checks as strings', () => {
  const mapped = jobService._mapApiJob({
    job_id: 'JOB-2', order_number: 'PX-2', order_id: 'ord-2',
    is_film_development: true,
    twin_checks: ['1847', '2053'],
  });
  assert.equal(mapped.is_film_development, true);
  assert.deepEqual(mapped.twin_checks, ['1847', '2053']);
});

test('_mapApiJob coerces numeric twin_checks to strings (OrderHub sends numerics unquoted)', () => {
  const mapped = jobService._mapApiJob({
    job_id: 'JOB-3', order_number: 'PX-3', order_id: 'ord-3',
    is_film_development: true,
    twin_checks: [1847, 2053],
  });
  assert.deepEqual(mapped.twin_checks, ['1847', '2053']);
});

test('_mapApiJob: twin_checks non-array → [] (defensive against contract drift)', () => {
  const mapped = jobService._mapApiJob({
    job_id: 'JOB-4', order_number: 'PX-4', order_id: 'ord-4',
    is_film_development: true,
    twin_checks: '1847,2053',
  });
  assert.deepEqual(mapped.twin_checks, []);
});

test('_mapApiJob: is_film_development coerced to boolean', () => {
  const truthy = jobService._mapApiJob({
    job_id: 'JOB-5', order_number: 'PX-5', order_id: 'ord-5',
    is_film_development: 1,
  });
  assert.equal(truthy.is_film_development, true);
  const falsy = jobService._mapApiJob({
    job_id: 'JOB-6', order_number: 'PX-6', order_id: 'ord-6',
    is_film_development: null,
  });
  assert.equal(falsy.is_film_development, false);
});

// ── getLocalJobs filter + getFilmDevelopmentJobs accessor ────────────────────

test('getLocalJobs hides film-dev jobs from the operator queue', () => {
  jobService.jobs = [
    { id: 1, order_number: 'A', is_film_development: false },
    { id: 2, order_number: 'B', is_film_development: true },
    { id: 3, order_number: 'C', is_film_development: false },
  ];
  const { jobs } = jobService.getLocalJobs();
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => j.id), [1, 3]);
});

test('getLocalJobs tolerates missing is_film_development (legacy jobs stay visible)', () => {
  jobService.jobs = [
    { id: 1, order_number: 'A' /* no is_film_development at all */ },
    { id: 2, order_number: 'B', is_film_development: true },
  ];
  const { jobs } = jobService.getLocalJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 1);
});

test('getFilmDevelopmentJobs returns only film-dev jobs', () => {
  jobService.jobs = [
    { id: 1, order_number: 'A', is_film_development: false },
    { id: 2, order_number: 'B', is_film_development: true, twin_checks: ['1847'] },
    { id: 3, order_number: 'C', is_film_development: false },
    { id: 4, order_number: 'D', is_film_development: true, twin_checks: ['2053', '2099'] },
  ];
  const filmDev = jobService.getFilmDevelopmentJobs();
  assert.equal(filmDev.length, 2);
  assert.deepEqual(filmDev.map(j => j.id).sort(), [2, 4]);
});

test('getFilmDevelopmentJobs returns [] when cache is empty', () => {
  jobService.jobs = [];
  assert.deepEqual(jobService.getFilmDevelopmentJobs(), []);
});

// ── _mergeJobs retention for film-dev jobs ───────────────────────────────────

test('_mergeJobs: film-dev job returned by API is retained (normal merge)', () => {
  jobService.jobs = [{
    id: 100, order_number: 'FD-100', order_id: 'o100',
    is_film_development: true, twin_checks: ['1847'], _status: 'pending',
  }];
  const merged = jobService._mergeJobs([
    jobService._mapApiJob({
      job_id: 100, order_number: 'FD-100', order_id: 'o100',
      is_film_development: true, twin_checks: ['1847'],
    }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].is_film_development, true);
  assert.deepEqual(merged[0].twin_checks, ['1847']);
});

test('_mergeJobs: film-dev job dropped by API is NOT retained (matches plain pending rule)', () => {
  jobService.jobs = [{
    id: 101, order_number: 'FD-101', order_id: 'o101',
    is_film_development: true, twin_checks: ['1847'], _status: 'pending',
  }];
  const merged = jobService._mergeJobs([]); // API returned nothing
  assert.equal(merged.length, 0,
    'film-dev jobs follow the same drop-if-pending rule as prints jobs');
});
