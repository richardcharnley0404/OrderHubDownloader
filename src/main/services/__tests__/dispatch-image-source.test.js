'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { resolveDispatchImageSource } =
  require(path.join(__dirname, '..', 'dispatch-image-source.js'));

const BASENAME = 'foo.jpg';

function makeJobFolder() {
  const jobFolderPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-dispatch-src-'));
  fs.mkdirSync(path.join(jobFolderPath, 'working'));
  fs.mkdirSync(path.join(jobFolderPath, 'originals'));
  return jobFolderPath;
}

test('returns the root path when the root image exists', () => {
  const jobFolderPath = makeJobFolder();
  const rootPath = path.join(jobFolderPath, BASENAME);
  fs.writeFileSync(rootPath, 'x');
  assert.equal(resolveDispatchImageSource({ rootPath, jobFolderPath, basename: BASENAME }), rootPath);
});

test('falls back to /working/ when the root is missing', () => {
  const jobFolderPath = makeJobFolder();
  const rootPath = path.join(jobFolderPath, BASENAME);
  const workingPath = path.join(jobFolderPath, 'working', BASENAME);
  fs.writeFileSync(workingPath, 'x');
  assert.equal(resolveDispatchImageSource({ rootPath, jobFolderPath, basename: BASENAME }), workingPath);
});

test('falls back to /originals/ when root and /working/ are both missing', () => {
  const jobFolderPath = makeJobFolder();
  const rootPath = path.join(jobFolderPath, BASENAME);
  const originalsPath = path.join(jobFolderPath, 'originals', BASENAME);
  fs.writeFileSync(originalsPath, 'x');
  assert.equal(resolveDispatchImageSource({ rootPath, jobFolderPath, basename: BASENAME }), originalsPath);
});

test('prefers root over working/originals when all exist', () => {
  const jobFolderPath = makeJobFolder();
  const rootPath = path.join(jobFolderPath, BASENAME);
  fs.writeFileSync(rootPath, 'x');
  fs.writeFileSync(path.join(jobFolderPath, 'working', BASENAME), 'x');
  fs.writeFileSync(path.join(jobFolderPath, 'originals', BASENAME), 'x');
  assert.equal(resolveDispatchImageSource({ rootPath, jobFolderPath, basename: BASENAME }), rootPath);
});

test('enhancedPath always wins when provided', () => {
  const jobFolderPath = makeJobFolder();
  const rootPath = path.join(jobFolderPath, BASENAME);
  fs.writeFileSync(rootPath, 'x'); // root exists, but enhanced should still win
  const enhancedPath = '/some/enhanced/foo.jpg';
  assert.equal(
    resolveDispatchImageSource({ rootPath, jobFolderPath, basename: BASENAME, enhancedPath }),
    enhancedPath,
  );
});

test('returns the root path (for error messaging) when nothing exists', () => {
  const jobFolderPath = makeJobFolder();
  const rootPath = path.join(jobFolderPath, BASENAME);
  assert.equal(resolveDispatchImageSource({ rootPath, jobFolderPath, basename: BASENAME }), rootPath);
});
