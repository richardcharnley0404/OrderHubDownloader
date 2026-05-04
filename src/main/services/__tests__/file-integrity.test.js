/**
 * Unit tests for src/main/services/file-integrity.js.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { checkImageMagic } = require('../file-integrity');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIX = path.join(REPO, 'node_modules', 'gifwrap', 'test', 'fixtures');


/** Write `buf` to a fresh temp file and return the path. */
function tmpWrite(name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileinteg-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}


test('checkImageMagic: clean JPEG (hairstreak.jpg fixture) -> valid jpeg', () => {
  const r = checkImageMagic(path.join(FIX, 'hairstreak.jpg'));
  assert.equal(r.valid, true);
  assert.equal(r.format, 'jpeg');
  assert.match(r.magicHex, /^ffd8ff/, 'JPEG magicHex should start with ffd8ff');
});


test('checkImageMagic: clean PNG (lenna.png fixture) -> valid png', () => {
  const r = checkImageMagic(path.join(FIX, 'lenna.png'));
  assert.equal(r.valid, true);
  assert.equal(r.format, 'png');
  assert.equal(r.magicHex, '89504e470d0a1a0a');
});


test('checkImageMagic: corrupt leading-zeros JPEG (1KB zeros + real JPEG content) -> invalid', () => {
  // Simulates the production failure mode: leading bytes are zero-allocation
  // padding from an interrupted upstream write, real JPEG content trails it.
  // The real bytes are unreachable from offset 0.
  const realJpeg = fs.readFileSync(path.join(FIX, 'hairstreak.jpg'));
  const corrupt = Buffer.concat([Buffer.alloc(1024), realJpeg]);
  const p = tmpWrite('corrupt.jpg', corrupt);

  const r = checkImageMagic(p);
  assert.equal(r.valid, false);
  assert.equal(r.format, null);
  assert.equal(r.magicHex, '0000000000000000');
});


test('checkImageMagic: random bytes -> invalid', () => {
  const buf = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
  const p = tmpWrite('random.bin', buf);

  const r = checkImageMagic(p);
  assert.equal(r.valid, false);
  assert.equal(r.format, null);
  assert.equal(r.magicHex, '123456789abcdef0');
});


test('checkImageMagic: 0-byte file -> invalid', () => {
  const p = tmpWrite('empty.bin', Buffer.alloc(0));

  const r = checkImageMagic(p);
  assert.equal(r.valid, false);
  assert.equal(r.format, null);
  assert.equal(r.magicHex, '');
});


test('checkImageMagic: 7-byte file (truncated PNG signature) -> invalid', () => {
  // Bytes 0-6 of a real PNG signature, missing the final byte.
  // Even though the prefix matches, an incomplete signature is invalid.
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
  const p = tmpWrite('seven.bin', buf);

  const r = checkImageMagic(p);
  assert.equal(r.valid, false);
  assert.equal(r.format, null);
  assert.equal(r.magicHex, '89504e470d0a1a');
});


test('checkImageMagic: nonexistent file -> invalid with error', () => {
  const fakePath = path.join(os.tmpdir(), 'definitely-not-a-real-file-' + Math.random());
  const r = checkImageMagic(fakePath);
  assert.equal(r.valid, false);
  assert.equal(r.format, null);
  assert.equal(r.magicHex, null);
  assert.ok(r.error, 'error message should be populated');
});


test('checkImageMagic: 2-byte file (FF D8 only, no third byte) -> invalid', () => {
  // The first two bytes of JPEG SOI but missing the application-marker prefix.
  // Verifies the JPEG check requires all 3 bytes, not just the SOI pair.
  const buf = Buffer.from([0xff, 0xd8]);
  const p = tmpWrite('two.bin', buf);

  const r = checkImageMagic(p);
  assert.equal(r.valid, false);
  assert.equal(r.format, null);
  assert.equal(r.magicHex, 'ffd8');
});
