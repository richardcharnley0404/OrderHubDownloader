/**
 * Smoke test for order-folder-writer.js
 *
 * Asserts the on-disk DPOF folder layout matches the spec:
 *   {prefix}{jobId}_{jobNo}_..._{options}/
 *     IMAGES/    ← image files (v1.7.7+ renamed from IMAGE singular per DPOF spec)
 *     MISC/
 *       AUTPRINT.MRK
 *
 * Guards against a silent regression where the IMAGES subdir name drifts back
 * to IMAGE (which the spec doc explicitly disallowed pre-v1.7.7, then
 * explicitly required from v1.7.7).
 *
 * Run via:
 *   npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const fsp    = require('node:fs/promises');
const path   = require('node:path');
const os     = require('node:os');

const { OrderFolderWriter } = require('../order-folder-writer');


test('writeOrderFolder creates IMAGES/ (plural) subdir per DPOF spec', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-ofw-'));
  try {
    // Stage a fake source image so copyFile has something to read.
    const srcImage = path.join(tmpRoot, 'source.jpg');
    await fsp.writeFile(srcImage, 'fake-jpeg-bytes');

    const hotFolder = path.join(tmpRoot, 'hot');
    await fsp.mkdir(hotFolder, { recursive: true });

    const job = {
      job_name:      'PXDEMO-IMGSPEC-1',
      product:       '4x6 Photo Print',
      options:       [],
      customer_name: '',
    };
    const dpofContent = '[HDR]\r\nGEN REV=01.00\r\n';
    const imageFiles  = [{ sourcePath: srcImage, filename: 'photo-001.jpg' }];

    const writer = new OrderFolderWriter();
    const { folderPath } = await writer.writeOrderFolder(
      hotFolder, job, dpofContent, imageFiles, null, {}
    );

    assert.equal(
      fs.existsSync(path.join(folderPath, 'IMAGES')), true,
      'IMAGES/ subdirectory must exist (DPOF spec — plural)'
    );
    assert.equal(
      fs.existsSync(path.join(folderPath, 'IMAGE')), false,
      'IMAGE/ (singular, pre-v1.7.7) must NOT exist'
    );
    assert.equal(
      fs.existsSync(path.join(folderPath, 'IMAGES', 'photo-001.jpg')), true,
      'image file must be copied into IMAGES/'
    );
    assert.equal(
      fs.existsSync(path.join(folderPath, 'MISC', 'AUTPRINT.MRK')), true,
      'AUTPRINT.MRK must be written to MISC/'
    );
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

// ── nameOpts.batch forwarded end-to-end (regression lock) ────────────────────
//
// The M3 batching tests stub writeOrderFolder and assert on the nameOpts
// handed to it. That missed a live bug: writeOrderFolder rebuilt its own
// `resolvedOpts` by cherry-picking includeCustomerName + customerName and
// silently dropped `batch`. Every batch of a split job produced the
// identical folder name — batch 1 renamed p→o, batch 2 hit EPERM on the
// rename (Windows) or overwrote (POSIX) and never reached the printer.
//
// This test hits the REAL writeOrderFolder against a temp directory and
// asserts two batches produce two DISTINCT folders on disk with the
// _1of2 / _2of2 markers, and that a sequential batch-1 + batch-2
// dispatch pair leaves both folders side-by-side rather than colliding.

test('writeOrderFolder forwards nameOpts.batch to buildFolderName → two batches, two distinct folders on disk', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-ofw-batch-'));
  try {
    const srcImage = path.join(tmpRoot, 'source.jpg');
    await fsp.writeFile(srcImage, 'fake-jpeg-bytes');

    const hotFolder = path.join(tmpRoot, 'hot');
    await fsp.mkdir(hotFolder, { recursive: true });

    const job = {
      id:            42,
      job_name:      'PXDEMO-BATCH-1',
      product:       '4x6 Photo Print',
      options:       [],
      customer_name: '',
    };
    const dpofContent = '[HDR]\r\nGEN REV=01.00\r\n';
    const imageFiles  = [{ sourcePath: srcImage, filename: 'photo-001.jpg' }];

    const writer = new OrderFolderWriter();

    // Batch 1 of 2 — writes p42_..._1of2_..., renames to o42_..._1of2_...
    const r1 = await writer.writeOrderFolder(
      hotFolder, job, dpofContent, imageFiles, null,
      { batch: { index: 1, total: 2 } }
    );
    // Batch 2 of 2 — MUST NOT collide. Pre-fix this threw EPERM on
    // Windows (rename source and destination were identical to batch 1).
    const r2 = await writer.writeOrderFolder(
      hotFolder, job, dpofContent, imageFiles, null,
      { batch: { index: 2, total: 2 } }
    );

    // Distinct folder names.
    assert.notEqual(r1.folderName, r2.folderName,
      'each batch must produce a distinct folder name (pre-fix: identical name → EPERM on Windows rename)');
    assert.match(r1.folderName, /_1of2(_|$)/, 'batch 1 folder carries the _1of2 marker');
    assert.match(r2.folderName, /_2of2(_|$)/, 'batch 2 folder carries the _2of2 marker');

    // Both folders exist ON DISK side-by-side, both with the o- prefix
    // (rename succeeded on both). This is the trap: stubbed tests would
    // pass the nameOpts through unchanged and never observe that the
    // real writer flattened them back to an identical name.
    assert.equal(fs.existsSync(r1.folderPath), true, 'batch 1 folder must exist after rename');
    assert.equal(fs.existsSync(r2.folderPath), true, 'batch 2 folder must exist after rename');
    assert.ok(path.basename(r1.folderPath).startsWith('o'), 'batch 1 folder must have o- prefix (rename succeeded)');
    assert.ok(path.basename(r2.folderPath).startsWith('o'), 'batch 2 folder must have o- prefix (rename succeeded)');

    // No p- leftover in the hot folder (both renames landed).
    const contents = await fsp.readdir(hotFolder);
    const stragglers = contents.filter((n) => n.startsWith('p'));
    assert.deepEqual(stragglers, [], 'no p- temp folders left over — both writes completed and renamed');

    // Contents copied into each batch's own IMAGES/.
    assert.equal(fs.existsSync(path.join(r1.folderPath, 'IMAGES', 'photo-001.jpg')), true);
    assert.equal(fs.existsSync(path.join(r2.folderPath, 'IMAGES', 'photo-001.jpg')), true);
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('writeOrderFolder: single unsplit call is byte-identical to today (no nameOpts.batch → no 1of1 marker)', async () => {
  // Guards the "unsplit folder name must not change" invariant at the
  // writer layer. The fix used a spread rather than an explicit
  // `if (nameOpts.batch)` — a stray `batch: undefined` on nameOpts must
  // not accidentally activate the marker via the spread.
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-ofw-unsplit-'));
  try {
    const srcImage = path.join(tmpRoot, 'source.jpg');
    await fsp.writeFile(srcImage, 'fake-jpeg-bytes');

    const hotFolder = path.join(tmpRoot, 'hot');
    await fsp.mkdir(hotFolder, { recursive: true });

    const job = {
      id:            42,
      job_name:      'PXDEMO-UNSPLIT-1',
      product:       '4x6 Photo Print',
      options:       [],
      customer_name: '',
    };
    const writer = new OrderFolderWriter();

    // No nameOpts.batch at all.
    const rBare = await writer.writeOrderFolder(
      hotFolder, job, 'x', [{ sourcePath: srcImage, filename: 'p.jpg' }], null, {}
    );
    await fsp.rm(rBare.folderPath, { recursive: true, force: true });

    // Explicit undefined on nameOpts.batch — trap for the spread path.
    const rUndef = await writer.writeOrderFolder(
      hotFolder, job, 'x', [{ sourcePath: srcImage, filename: 'p.jpg' }], null,
      { batch: undefined }
    );

    assert.equal(rBare.folderName, rUndef.folderName,
      'nameOpts.batch = undefined must produce the same name as nameOpts with no batch key at all');
    assert.doesNotMatch(rBare.folderName, /_\d+of\d+/,
      'unsplit dispatch must never produce a NofM marker');
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});
