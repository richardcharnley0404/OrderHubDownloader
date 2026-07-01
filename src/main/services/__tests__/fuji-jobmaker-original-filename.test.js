/**
 * Tests for the Fuji JobMaker {originalFilename} back-print token.
 *
 * generateFujiJobMakerFiles is a pure function (only depends on the pure
 * template-tokens module), so no electron shims are needed. This same generator
 * serves first-print and reprint — the reprint path just feeds a subset of
 * images each carrying its own originalFilename — so per-image correctness here
 * covers both.
 *
 * Run via: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { generateFujiJobMakerFiles } = require(
  path.join(REPO, 'src', 'main', 'services', 'fuji-jobmaker-generator.js'),
);

const controller = {
  imageStagingRoot:  '\\\\MASTER\\Pixfizz\\Artwork',
  backprintMode:     'text',
  backprintTemplate: '{originalFilename}',
};

function fujiJob(images) {
  return {
    orderRef: 'ORD-TEST-1',
    id: 'JOB1',
    jobName: 'ORD-TEST-1',
    customer: { fullName: 'Rich C', email: '', phone: '' },
    surfaceGroups: [{ surface: 'Lustre', surfaceCode: 'L', images }],
  };
}

test('BackPrint emits each image\'s own {originalFilename} (index-prefix stripped)', () => {
  const [file] = generateFujiJobMakerFiles(fujiJob([
    { filename: 'a.jpg', printCode: '4x6', quantity: 1, originalFilename: 'ORD-TEST_1/original-files/1_576629810001.jpg' },
    { filename: 'b.jpg', printCode: '4x6', quantity: 1, originalFilename: 'ORD-TEST_1/original-files/2-DSC_0002.jpg' },
  ]), controller);

  assert.ok(file.contents.includes('BackPrint=576629810001.jpg'), 'image 1 original');
  assert.ok(file.contents.includes('BackPrint=DSC_0002.jpg'),     'image 2 original');
});

test('missing originalFilename omits the BackPrint line (template resolves blank)', () => {
  const [file] = generateFujiJobMakerFiles(fujiJob([
    { filename: 'a.jpg', printCode: '4x6', quantity: 1, originalFilename: null },
  ]), controller);

  assert.ok(!file.contents.includes('BackPrint='), 'no BackPrint line when blank');
});
