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
