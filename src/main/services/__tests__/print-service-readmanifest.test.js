'use strict';

/**
 * _readManifest retry (2026-06-24).
 *
 * FTP delivery to the watched share is non-atomic and OrderHub re-pushes an
 * order folder when later jobs are added to the same order. The manifest can
 * therefore momentarily vanish / be zero-byte / be half-written exactly when a
 * dispatch reads it (TOCTOU on the SMB share). Before this change the read was
 * a single existsSync that threw "Order manifest not found" on the first miss
 * and dropped the job into the sticky-error path even though the file
 * reappeared a moment later — the PRLE-EL2KTR-4/-5 Photo Print failures where
 * the canvas siblings in the same order received fine.
 *
 * _readManifest now retries 4 times, 250ms apart, before failing.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const fs       = require('node:fs');
const path    = require('node:path');

// print-service → logger → electron.app. Stub electron so the require chain
// resolves without booting the runtime (mirrors print-service-discarded.test).
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

const printService = require(path.join(__dirname, '..', 'print-service.js'));
const { ManifestNotFoundError } = require(path.join(__dirname, '..', 'awaiting-manifest.js'));

function makeTmpOrderFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-manifest-'));
}

const ORDER = 'PRLE-EL2KTR';
const MANIFEST = { jobs: [{ jobId: 42, images: [{ filename: 'a.jpg', size: '8x10', quantity: 1 }] }] };

test('_readManifest returns the parsed manifest when present from the start', async () => {
  const dir = makeTmpOrderFolder();
  fs.writeFileSync(path.join(dir, `${ORDER}.json`), JSON.stringify(MANIFEST));

  const result = await printService._readManifest(dir, ORDER);
  assert.deepEqual(result, MANIFEST);
});

test('_readManifest retries and succeeds when the manifest appears after the first attempt', async () => {
  const dir = makeTmpOrderFolder();
  const manifestPath = path.join(dir, `${ORDER}.json`);

  // Start the read with NO manifest on disk. The async fn runs its first
  // attempt synchronously (existsSync → false) then yields at the 250ms sleep,
  // returning the pending promise. We write the manifest now — well before the
  // timer fires — so the second attempt finds it. Deterministic: does not
  // depend on wall-clock alignment, only on the first attempt having already
  // missed before control returns here.
  const pending = printService._readManifest(dir, ORDER);
  assert.equal(fs.existsSync(manifestPath), false, 'first attempt should have run before the file exists');
  fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST));

  const result = await pending;
  assert.deepEqual(result, MANIFEST);
});

test('_readManifest retries past a zero-byte / half-written manifest, then parses it', async () => {
  const dir = makeTmpOrderFolder();
  const manifestPath = path.join(dir, `${ORDER}.json`);
  // Simulate an in-progress overwrite: file exists but is empty (size 0).
  fs.writeFileSync(manifestPath, '');

  const pending = printService._readManifest(dir, ORDER);
  // Complete the "write" before the retry budget elapses.
  fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST));

  const result = await pending;
  assert.deepEqual(result, MANIFEST);
});

test('_readManifest still throws the verbatim not-found message when the manifest never appears', async () => {
  const dir = makeTmpOrderFolder();
  const manifestPath = path.join(dir, `${ORDER}.json`);

  await assert.rejects(
    () => printService._readManifest(dir, ORDER),
    (err) => {
      assert.ok(err instanceof ManifestNotFoundError, 'typed so auto-print can re-arm awaiting');
      assert.match(err.message, /^Order manifest not found: /);
      assert.ok(err.message.includes(manifestPath), 'message preserves the full manifest path');
      assert.equal(err.manifestPath, manifestPath, 'carries the manifest path for the awaiting tooltip');
      return true;
    },
  );
});

test('_readManifest throws a plain (non-ManifestNotFound) error for a manifest that never parses', async () => {
  const dir = makeTmpOrderFolder();
  // Non-empty but invalid JSON for the whole retry budget — genuine corruption,
  // must stay terminal so the auto-print re-arm path leaves it alone.
  fs.writeFileSync(path.join(dir, `${ORDER}.json`), '{ not valid json');

  await assert.rejects(
    () => printService._readManifest(dir, ORDER),
    (err) => {
      assert.ok(!(err instanceof ManifestNotFoundError), 'parse failure is not a manifest-miss');
      assert.match(err.message, /^Failed to read order manifest: /);
      return true;
    },
  );
});
