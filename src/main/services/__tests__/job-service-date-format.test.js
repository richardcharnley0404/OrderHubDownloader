/**
 * Unit tests for the date_format pass-through in job-service:
 *   - _normaliseDateFormat: pass-through, casing/whitespace normalization,
 *     unknown/empty/null guard.
 *   - _mapApiJob: stamps date_format from ctx; falls back to null when ctx
 *     omits it.
 *
 * Run via:  npm test
 */

'use strict';

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

// ── Stubs (same minimal set as job-service-merge-retention.test.js) ──────────

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
const { _normaliseDateFormat } = jobService;

// ── _normaliseDateFormat ─────────────────────────────────────────────────────

test('_normaliseDateFormat: DMY/YMD/MDY pass through verbatim', () => {
  assert.equal(_normaliseDateFormat('DMY'), 'DMY');
  assert.equal(_normaliseDateFormat('YMD'), 'YMD');
  assert.equal(_normaliseDateFormat('MDY'), 'MDY');
});

test('_normaliseDateFormat: lowercase variants normalize to upper enum', () => {
  assert.equal(_normaliseDateFormat('dmy'), 'DMY');
  assert.equal(_normaliseDateFormat('ymd'), 'YMD');
  assert.equal(_normaliseDateFormat('mdy'), 'MDY');
});

test('_normaliseDateFormat: mixed case + surrounding whitespace normalize', () => {
  assert.equal(_normaliseDateFormat(' Dmy '),  'DMY');
  assert.equal(_normaliseDateFormat('\tyMd\n'), 'YMD');
  assert.equal(_normaliseDateFormat('  MdY '), 'MDY');
});

test('_normaliseDateFormat: unknown string → null (renderer falls back to its DMY default)', () => {
  assert.equal(_normaliseDateFormat('ISO'),       null);
  assert.equal(_normaliseDateFormat('dd/mm/yyyy'), null);
  assert.equal(_normaliseDateFormat('XYZ'),       null);
});

test('_normaliseDateFormat: empty string → null', () => {
  assert.equal(_normaliseDateFormat(''),     null);
  assert.equal(_normaliseDateFormat('   '),  null);
});

test('_normaliseDateFormat: non-string inputs → null (null, undefined, number, object)', () => {
  assert.equal(_normaliseDateFormat(null),        null);
  assert.equal(_normaliseDateFormat(undefined),   null);
  assert.equal(_normaliseDateFormat(123),         null);
  assert.equal(_normaliseDateFormat({ x: 'DMY' }), null);
});

// ── _mapApiJob: date_format stamping ─────────────────────────────────────────

function minimalApiJob(overrides = {}) {
  return {
    job_id: 100,
    order_id: 'ord-1',
    order_number: 'PXTEST-DATEFMT',
    job_name: 'PXTEST-DATEFMT-1',
    created_at: '2026-05-21T13:21:20Z',
    due_date:   '2026-05-22T13:21:15Z',
    ...overrides,
  };
}

test('_mapApiJob: stamps date_format from ctx onto the mapped job', () => {
  const mapped = jobService._mapApiJob(minimalApiJob(), { dateFormat: 'MDY' });
  assert.equal(mapped.date_format, 'MDY');
});

test('_mapApiJob: date_format falls back to null when ctx omits it', () => {
  const mapped = jobService._mapApiJob(minimalApiJob(), {});
  assert.equal(mapped.date_format, null,
    'absent ctx.dateFormat must not produce undefined — renderer treats null as "use built-in DMY default"');
});

test('_mapApiJob: date_format falls back to null when ctx is omitted entirely', () => {
  const mapped = jobService._mapApiJob(minimalApiJob());
  assert.equal(mapped.date_format, null);
});
