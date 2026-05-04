/**
 * Unit test for the v1.3.2 UTF-8 BOM defensive fix in config-service.
 *
 * Run via:
 *   npm test
 *
 * Background: electron-store / conf reads config.json with `JSON.parse`,
 * which throws on a leading UTF-8 BOM. PowerShell `Set-Content -Encoding UTF8`,
 * Notepad, and most Windows editors prepend a BOM by default. During v1.3.2
 * development a BOM bricked the app at startup; the fix passes a custom
 * `deserialize` to the Store constructor that strips the BOM before parsing.
 *
 * config-service requires electron-store + electron at module-load time, so
 * we capture the `deserialize` option via a Module.prototype.require override
 * that intercepts both. The test then exercises the captured callback
 * directly without needing a real Store instance.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

let __capturedOptions = null;

// Fake electron-store: captures the options passed to the constructor.
function FakeStore(options) {
  __capturedOptions = options;
  return {
    get: (k, d) => d,
    set: () => {},
    delete: () => {},
  };
}

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

// Loading config-service fires `new Store({ schema, deserialize })` and
// captures the options. Subsequent calls to `_migrateReviewMode` use the
// fake store's no-op get/set; nothing on disk is touched.
require(path.join(SVC, 'config-service.js'));


test('BOM-strip: deserialize option is passed to Store', () => {
  assert.ok(__capturedOptions, 'Store was constructed with options');
  assert.equal(typeof __capturedOptions.deserialize, 'function',
    'deserialize must be a function — without it, conf falls back to plain JSON.parse and BOMs crash');
});


test('BOM-strip: BOM-prefixed JSON parses correctly', () => {
  const original = { ftpHost: 'ftp.example.com', ftpPort: 21, downloadDirectory: 'C:\\OHD' };
  const jsonStr = JSON.stringify(original);
  const bomPrefixed = '﻿' + jsonStr;

  const parsed = __capturedOptions.deserialize(bomPrefixed);
  assert.deepEqual(parsed, original,
    'BOM-prefixed JSON must round-trip identically to BOM-less JSON');
});


test('BOM-strip: non-BOM JSON parses identically (no regression)', () => {
  const original = { foo: 'bar', n: 42, nested: { a: [1, 2, 3] } };
  const jsonStr = JSON.stringify(original);

  const parsed = __capturedOptions.deserialize(jsonStr);
  assert.deepEqual(parsed, original);
});


test('BOM-strip: invalid JSON still throws (BOM strip is defensive, not lenient)', () => {
  // Make sure the BOM strip doesn't accidentally swallow real parse errors.
  // A future contributor adding "lenient parsing" to fix some other bug
  // shouldn't be able to do so without explicitly editing this test.
  assert.throws(
    () => __capturedOptions.deserialize('﻿not valid json {{{'),
    SyntaxError,
  );
  assert.throws(
    () => __capturedOptions.deserialize('not valid json {{{'),
    SyntaxError,
  );
});


test('BOM-strip: leading whitespace is preserved (BOM is exactly U+FEFF, not "any whitespace")', () => {
  // Leading whitespace before JSON is technically valid per JSON spec; the
  // strip should ONLY remove U+FEFF, not arbitrary leading whitespace, so
  // we don't mask a different class of JSON corruption.
  const parsed = __capturedOptions.deserialize('  \n  {"k":"v"}');
  assert.deepEqual(parsed, { k: 'v' });
});
