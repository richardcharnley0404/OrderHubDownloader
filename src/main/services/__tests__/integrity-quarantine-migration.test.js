/**
 * Unit tests for the v1.3.2 integrity-quarantine startup migration.
 *
 * Run via:
 *   npm test
 *
 * These tests exercise the pure `_migrate(downloadDirectory, log)` worker —
 * not the production `runIntegrityQuarantineMigration()` entry point — so
 * they don't need to touch electron-store config or the electron-bound
 * logger. The production wrapper just adds:
 *   1. A `_integrityQuarantineMigratedAt` config flag check up front
 *   2. The same flag set after `_migrate` returns
 *   3. Routing log calls through the real logger
 * All of that is trivial glue around `_migrate`; the substantive behavior
 * (walk, rename, sidecar update, archive) lives in `_migrate` and is what
 * we test here.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  _migrate,
  _QUARANTINE_SUFFIX,
  _LEGACY_MANIFEST,
  _ARCHIVED_MANIFEST,
} = require('../integrity-quarantine-migration');

const NULL_LOG = { info: () => {}, warn: () => {}, error: () => {} };


/**
 * Build a v1.3.0-shaped fixture inside a tmp downloadDirectory. Returns the
 * paths the tests need to assert against.
 *
 *   <tmpRoot>/<orderName>/                    ← outer order folder
 *     _ohd-quarantine.json (optional)         ← legacy manifest
 *     <jobName>/                              ← inner job folder = sidecar jobId
 *       img1.jpeg.quarantine                  ← legacy renamed file
 *       img2.jpeg.quarantine
 *       ...
 */
function makeFixture({ withManifest, fileCount = 1, manifestEntries = null }) {
  const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-mig-'));
  const orderName = 'PXTEST-ORDER_abc123';
  const jobName   = 'PXTEST-ORDER_001';
  const orderDir  = path.join(root, orderName);
  const jobDir    = path.join(orderDir, jobName);
  fs.mkdirSync(jobDir, { recursive: true });

  const filenames = [];
  for (let i = 1; i <= fileCount; i++) {
    const fn = `img${i}.jpeg`;
    fs.writeFileSync(path.join(jobDir, fn + _QUARANTINE_SUFFIX), Buffer.alloc(8));
    filenames.push(fn);
  }

  if (withManifest) {
    const entries = manifestEntries || filenames.map((fn) => ({
      filename:      fn,
      quarantinedAt: '2026-04-28T00:00:00.000Z',
      ftpRemotePath: `/the-root/${orderName}/${jobName}/${fn}`,
      expectedSize:  1234,
      actualSize:    1234,
      firstBytes:    '0000000000000000',
      expectedMagic: 'JPEG (FF D8 FF) or PNG (89 50 4E 47 0D 0A 1A 0A)',
      reason:        'magic-byte-mismatch',
    }));
    const manifest = { version: 1, entries };
    fs.writeFileSync(
      path.join(orderDir, _LEGACY_MANIFEST),
      JSON.stringify(manifest, null, 2),
    );
  }

  return { root, orderDir, jobDir, jobName, filenames };
}


test('_migrate: restores files, populates integritySuspect from manifest, archives manifest', async () => {
  const { root, orderDir, jobDir, jobName, filenames } =
    makeFixture({ withManifest: true, fileCount: 2 });

  const result = await _migrate(root, NULL_LOG);

  assert.deepEqual(
    { restored: result.restored, archived: result.archived, jobsTouched: result.jobsTouched },
    { restored: 2, archived: 1, jobsTouched: 1 },
    'two files restored from one job, one manifest archived',
  );
  assert.equal(typeof result.elapsedMs, 'number');

  // 1. Files renamed back to their real extensions, no .quarantine remnants.
  for (const fn of filenames) {
    assert.equal(fs.existsSync(path.join(jobDir, fn)), true,
      `${fn} restored to its original extension`);
    assert.equal(fs.existsSync(path.join(jobDir, fn + _QUARANTINE_SUFFIX)), false,
      `${fn}.quarantine no longer present`);
  }

  // 2. Manifest archived (renamed, not deleted).
  assert.equal(fs.existsSync(path.join(orderDir, _LEGACY_MANIFEST)), false,
    'active manifest must be gone');
  assert.equal(fs.existsSync(path.join(orderDir, _ARCHIVED_MANIFEST)), true,
    'archived manifest preserves the historical record');

  // 3. Sidecar populated with manifest-sourced diagnostic data.
  const sidecar = JSON.parse(
    await fsp.readFile(path.join(jobDir, `${jobName}.json`), 'utf8'),
  );
  for (const fn of filenames) {
    const entry = sidecar.images.find((i) => i.filename === fn);
    assert.ok(entry, `entry exists for ${fn}`);
    assert.equal(entry.integritySuspect.detected, true);
    assert.equal(entry.integritySuspect.detectedAt,    '2026-04-28T00:00:00.000Z');
    assert.equal(entry.integritySuspect.firstBytesHex, '0000000000000000');
    assert.match(entry.integritySuspect.expectedMagic, /JPEG.*PNG/);
    assert.match(entry.integritySuspect.ftpRemotePath, /^\/the-root\/PXTEST-ORDER_abc123\//);
  }
});


test('_migrate: re-running on already-migrated state is a no-op', async () => {
  const { root } = makeFixture({ withManifest: true, fileCount: 3 });

  const first = await _migrate(root, NULL_LOG);
  assert.equal(first.restored, 3);
  assert.equal(first.archived, 1);

  const second = await _migrate(root, NULL_LOG);
  assert.deepEqual(
    { restored: second.restored, archived: second.archived, jobsTouched: second.jobsTouched },
    { restored: 0, archived: 0, jobsTouched: 0 },
    're-run finds nothing to do because .quarantine files and active manifests are gone',
  );
});


test('_migrate: .quarantine file with no manifest writes minimal integritySuspect block', async () => {
  // Edge case from the Phase-0 spec: a .quarantine file might predate or
  // outlive its corresponding _ohd-quarantine.json (manual cleanup, partial
  // copies, etc). The detected flag is the load-bearing signal — restore
  // the file regardless, write minimal data for the rest.
  const { root, jobDir, jobName, filenames } =
    makeFixture({ withManifest: false, fileCount: 1 });

  const result = await _migrate(root, NULL_LOG);

  assert.equal(result.restored, 1);
  assert.equal(result.archived, 0, 'no manifest to archive');
  assert.equal(result.jobsTouched, 1);

  const sidecar = JSON.parse(
    await fsp.readFile(path.join(jobDir, `${jobName}.json`), 'utf8'),
  );
  const entry = sidecar.images.find((i) => i.filename === filenames[0]);
  assert.ok(entry);
  assert.deepEqual(
    entry.integritySuspect,
    {
      detected:      true,
      detectedAt:    null,
      firstBytesHex: null,
      expectedMagic: null,
      ftpRemotePath: null,
    },
    'all manifest-sourced fields null; only `detected: true` is load-bearing',
  );
});
