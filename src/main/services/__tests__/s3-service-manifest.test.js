'use strict';

/**
 * Unit tests for src/main/services/s3-service.js::_buildManifestPayload.
 *
 * Covers:
 *   - Base manifest (no manifestExtra): existing fields present, no extras.
 *   - manifestExtra shallow-merged after built-ins, without overwriting them.
 *   - Null / non-object manifestExtra is safely ignored.
 *   - Collision guard: caller cannot overwrite folder / total_files / etc.
 *   - tiff/jpg counters still work correctly with mixed file lists.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const os      = require('node:os');
const path    = require('node:path');
const Module  = require('node:module');

const __originalRequire = Module.prototype.require;

// _buildManifestPayload lazily requires('electron') for app.getVersion();
// logger.js (transitively required by s3-service) needs app.getPath('userData').
// Stub the whole electron module so the test doesn't need Electron at runtime.
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: {
        getVersion: () => '9.9.9-test',
        getPath: (_key) => os.tmpdir(),
      },
    };
  }
  return __originalRequire.apply(this, arguments);
};

const SVC = path.resolve(__dirname, '..');
const s3Service = require(path.join(SVC, 's3-service.js'));

function decode(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}

// ── Base manifest (backwards-compat) ─────────────────────────────────────────

test('_buildManifestPayload: base manifest — no manifestExtra keeps the pre-feature shape', () => {
  const files = ['/x/a.tif', '/x/b.tiff', '/x/c.jpg', '/x/d.jpeg', '/x/e.dng'];
  const { name, buffer } = s3Service._buildManifestPayload('ROLL-123', files, 0);

  assert.equal(name, 'ROLL-123.json');
  const body = decode(buffer);
  assert.equal(body.folder,      'ROLL-123');
  assert.equal(body.total_files, 5);
  assert.equal(body.tiff_count,  2);
  assert.equal(body.jpg_count,   2);
  assert.equal(body.errors,      0);
  assert.equal(body.ohd_version, '9.9.9-test');
  assert.ok(typeof body.completed_at === 'string' && body.completed_at.length > 0);

  // No auto-assign keys leak into the base manifest.
  assert.equal(body.twin_check,   undefined);
  assert.equal(body.job_id,       undefined);
  assert.equal(body.auto_assigned, undefined);
});

test('_buildManifestPayload: base manifest — undefined manifestExtra == null (default arg branch)', () => {
  const files = ['/x/a.tif'];
  const { buffer } = s3Service._buildManifestPayload('R', files, 0);
  const body = decode(buffer);
  assert.deepEqual(Object.keys(body).sort(), [
    'completed_at', 'errors', 'folder', 'jpg_count', 'ohd_version', 'tiff_count', 'total_files',
  ]);
});

test('_buildManifestPayload: errors count propagates unchanged', () => {
  const { buffer } = s3Service._buildManifestPayload('R', ['/x/a.tif'], 3);
  const body = decode(buffer);
  assert.equal(body.errors, 3);
  assert.equal(body.total_files, 1);
});

// ── manifestExtra merge ──────────────────────────────────────────────────────

test('_buildManifestPayload: manifestExtra shallow-merged after built-ins', () => {
  const files = ['/x/a.tif'];
  const extra = {
    twin_check:    '1847',
    job_id:        'JOB-PXDEMO-1',
    job_number:    'PXDEMO-WT6L0M-1',
    order_id:      'ORD-DEMO',
    order_number:  'PXDEMO-WT6L0M',
    matched_at:    '2026-07-17T10:00:00.000Z',
    auto_assigned: true,
  };
  const { buffer } = s3Service._buildManifestPayload('ROLL-A', files, 0, extra);
  const body = decode(buffer);

  // Built-ins still present.
  assert.equal(body.folder,      'ROLL-A');
  assert.equal(body.total_files, 1);
  assert.equal(body.errors,      0);
  assert.equal(body.ohd_version, '9.9.9-test');

  // All extras present and unmodified.
  assert.equal(body.twin_check,    '1847');
  assert.equal(body.job_id,        'JOB-PXDEMO-1');
  assert.equal(body.job_number,    'PXDEMO-WT6L0M-1');
  assert.equal(body.order_id,      'ORD-DEMO');
  assert.equal(body.order_number,  'PXDEMO-WT6L0M');
  assert.equal(body.matched_at,    '2026-07-17T10:00:00.000Z');
  assert.equal(body.auto_assigned, true);
});

// ── Collision guard ─────────────────────────────────────────────────────────

test('_buildManifestPayload: collision guard — extras cannot overwrite built-in keys', () => {
  const files = ['/x/a.tif', '/x/b.jpg'];
  const malicious = {
    folder:       'HIJACKED',
    total_files:  9999,
    tiff_count:   -1,
    jpg_count:    -1,
    errors:       -1,
    completed_at: 'not-a-timestamp',
    ohd_version:  '0.0.0',
    // legit extras alongside the malicious keys — those should still get through
    twin_check:   '1847',
    job_id:       'JOB-1',
  };
  const { buffer } = s3Service._buildManifestPayload('REAL-ROLL', files, 2, malicious);
  const body = decode(buffer);

  // Built-ins won on every collision.
  assert.equal(body.folder,      'REAL-ROLL');
  assert.equal(body.total_files, 2);
  assert.equal(body.tiff_count,  1);
  assert.equal(body.jpg_count,   1);
  assert.equal(body.errors,      2);
  assert.equal(body.ohd_version, '9.9.9-test');
  assert.notEqual(body.completed_at, 'not-a-timestamp');

  // Non-colliding extras still merged.
  assert.equal(body.twin_check, '1847');
  assert.equal(body.job_id,     'JOB-1');
});

// ── Null-safety ─────────────────────────────────────────────────────────────

test('_buildManifestPayload: null manifestExtra is ignored (no crash, base shape)', () => {
  const { buffer } = s3Service._buildManifestPayload('R', ['/x/a.tif'], 0, null);
  const body = decode(buffer);
  assert.equal(body.folder, 'R');
  assert.equal(Object.keys(body).length, 7);
});

test('_buildManifestPayload: non-object manifestExtra (string / array) is ignored', () => {
  const strBody = decode(s3Service._buildManifestPayload('R', ['/x/a.tif'], 0, 'oops').buffer);
  const arrBody = decode(s3Service._buildManifestPayload('R', ['/x/a.tif'], 0, ['a', 'b']).buffer);
  assert.equal(strBody.folder, 'R');
  assert.equal(arrBody.folder, 'R');
  assert.equal(Object.keys(strBody).length, 7);
  assert.equal(Object.keys(arrBody).length, 7);
});

test('_buildManifestPayload: empty-object manifestExtra produces the base shape', () => {
  const { buffer } = s3Service._buildManifestPayload('R', ['/x/a.tif'], 0, {});
  const body = decode(buffer);
  assert.equal(Object.keys(body).length, 7);
  assert.equal(body.folder, 'R');
});
