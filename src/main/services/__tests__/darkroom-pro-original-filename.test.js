/**
 * Tests for the Darkroom Pro {originalFilename} photo-line token.
 *
 *   - originalDisplayName: index-prefix stripping + path handling (pure).
 *   - generateDarkroomProFile: end-to-end, asserts each per-image block emits
 *     that image's own original filename (this same generator serves both
 *     first-print and reprint, so it covers the reprint case too — reprints
 *     just feed a subset of images with their own originalFilename).
 *
 * electron/electron-store shimmed like routingHold.test.js (logger pulls in
 * electron at require time).
 *
 * Run via: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Module = require('node:module');

const fakeElectron = { app: { getPath: () => os.tmpdir(), on: () => {} } };
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron')       return fakeElectron;
  if (req === 'electron-store') return function FakeStore() { return { get: (_k, d) => d, set: () => {}, has: () => false, delete: () => {} }; };
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { generateDarkroomProFile, originalDisplayName } = require(
  path.join(REPO, 'src', 'main', 'services', 'darkroom-pro-output.js'),
);

// ── originalDisplayName (pure) ──────────────────────────────────────────────

test('originalDisplayName strips a leading "N-" or "N_" index prefix', () => {
  assert.equal(originalDisplayName('order/original-files/5_576629810005.jpg'), '576629810005.jpg');
  assert.equal(originalDisplayName('order/original-files/5-576629810005.jpg'), '576629810005.jpg');
  assert.equal(originalDisplayName('order/original-files/12-DSC_0421.jpg'),   'DSC_0421.jpg');
});

test('originalDisplayName handles Windows separators and bare names', () => {
  assert.equal(originalDisplayName('order\\original-files\\3_IMG.jpg'), 'IMG.jpg');
  assert.equal(originalDisplayName('7_plain.jpg'), 'plain.jpg');
});

test('originalDisplayName returns "" for missing/blank', () => {
  assert.equal(originalDisplayName(null), '');
  assert.equal(originalDisplayName(''), '');
  assert.equal(originalDisplayName(undefined), '');
});

// ── generateDarkroomProFile end-to-end ──────────────────────────────────────

test('per-image blocks each emit their own {originalFilename}', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-orig-'));
  const job = {
    id: 'JOB1',
    orderRef: 'PXDEMO-TEST',
    outputFilenameStem: 'PXDEMO-TEST-1',
    productCode: '0406-cut-print',
    customer: { firstName: 'Rich', lastName: 'C', email: 'x@y.z' },
    orderDate: new Date('2026-07-01T00:00:00Z'),
    _sizeOverride: '6x4',    // avoids needing a size translation table
    _mediaOverride: null,
    lineItems: [
      {
        qty: 1,
        options: [],
        images: [
          { sourcePath: 'C:\\x\\a.jpg', filename: 'a.jpg', originalFilename: 'PXDEMO-TEST_1/original-files/1_576629810001.jpg' },
          { sourcePath: 'C:\\x\\b.jpg', filename: 'b.jpg', originalFilename: 'PXDEMO-TEST_1/original-files/2-DSC_0002.jpg' },
        ],
      },
    ],
  };
  const controller = {
    outputPath: outDir,
    sizeTranslations: [],
    mediaOptionKey: '',      // media not required
    mediaTranslations: [],
    photoLines: [{ darkroomField: 'Photo.OriginalName', ohdTemplate: '{originalFilename}' }],
  };

  const destPath = await generateDarkroomProFile(job, controller);
  const content  = fs.readFileSync(destPath, 'utf8');

  assert.ok(content.includes('Photo.OriginalName=576629810001.jpg'), 'image 1 original');
  assert.ok(content.includes('Photo.OriginalName=DSC_0002.jpg'),     'image 2 original');
});

test('missing originalFilename emits a blank token, not a throw', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-orig-'));
  const job = {
    id: 'JOB2', orderRef: 'PX2', outputFilenameStem: 'PX2-1', productCode: 'p',
    customer: { firstName: 'A', lastName: 'B', email: '' },
    orderDate: new Date('2026-07-01T00:00:00Z'),
    _sizeOverride: '6x4', _mediaOverride: null,
    lineItems: [{ qty: 1, options: [], images: [{ sourcePath: 'C:\\x\\a.jpg', filename: 'a.jpg', originalFilename: null }] }],
  };
  const controller = {
    outputPath: outDir, sizeTranslations: [], mediaOptionKey: '', mediaTranslations: [],
    photoLines: [{ darkroomField: 'Photo.OriginalName', ohdTemplate: '{originalFilename}' }],
  };
  const destPath = await generateDarkroomProFile(job, controller);
  const content  = fs.readFileSync(destPath, 'utf8');
  assert.ok(content.includes('Photo.OriginalName='), 'line present');
  assert.ok(!/Photo\.OriginalName=\S/.test(content), 'value is blank');
});

test.after(() => { Module.prototype.require = __originalRequire; });
