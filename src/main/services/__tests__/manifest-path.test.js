'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { resolveManifestPath } = require(path.join(__dirname, '..', 'manifest-path.js'));

const ORDER = 'PRLE-EL2KTR';

function tmpOrderDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-manifest-path-'));
}

test('returns {orderNumber}.json when it exists', () => {
  const dir = tmpOrderDir();
  const primary = path.join(dir, `${ORDER}.json`);
  fs.writeFileSync(primary, '{}');
  assert.equal(resolveManifestPath(dir, ORDER), primary);
});

test('falls back to order.json when the primary name is absent', () => {
  const dir = tmpOrderDir();
  const fallback = path.join(dir, 'order.json');
  fs.writeFileSync(fallback, '{}');
  assert.equal(resolveManifestPath(dir, ORDER), fallback);
});

test('prefers {orderNumber}.json over order.json when both exist', () => {
  const dir = tmpOrderDir();
  const primary = path.join(dir, `${ORDER}.json`);
  fs.writeFileSync(primary, '{}');
  fs.writeFileSync(path.join(dir, 'order.json'), '{}');
  assert.equal(resolveManifestPath(dir, ORDER), primary);
});

test('returns the primary path when neither file exists (for error messaging)', () => {
  const dir = tmpOrderDir();
  assert.equal(resolveManifestPath(dir, ORDER), path.join(dir, `${ORDER}.json`));
});
