/**
 * Unit tests for the shared {token} resolver, focused on the new
 * {originalFilename} token (and a guard that the existing tokens still work).
 *
 * template-tokens.js has no electron/electron-store deps, so no shims needed.
 *
 * Run via: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { resolveTemplate, SUPPORTED_TOKENS } = require(
  path.join(REPO, 'src', 'main', 'services', 'template-tokens.js'),
);

test('{originalFilename} resolves from ctx', () => {
  assert.equal(
    resolveTemplate('{originalFilename}', {}, { originalFilename: '576629810005.jpg' }),
    '576629810005.jpg',
  );
});

test('{originalFilename} resolves blank when absent (no throw)', () => {
  assert.equal(resolveTemplate('{originalFilename}', {}, {}), '');
  assert.equal(resolveTemplate('{originalFilename}', {}), '');
});

test('{originalFilename} composes with other tokens', () => {
  const out = resolveTemplate(
    '{jobName} / {filename} / {originalFilename}',
    { job_name: 'PXDEMO-1' },
    { filename: 'a.jpg', originalFilename: 'orig.jpg' },
  );
  assert.equal(out, 'PXDEMO-1 / a.jpg / orig.jpg');
});

test('SUPPORTED_TOKENS advertises {originalFilename}', () => {
  assert.ok(SUPPORTED_TOKENS.includes('{originalFilename}'));
});

test('existing tokens unaffected', () => {
  assert.equal(
    resolveTemplate('{customerName}|{firstName}|{lastName}', { customer_name: 'Richard Charnley' }),
    'Richard Charnley|Richard|Charnley',
  );
});
