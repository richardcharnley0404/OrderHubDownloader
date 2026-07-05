'use strict';

/**
 * Unit tests for the Film Development Auto Assignment additions to
 * config-service.js (filmScanAutoAssignEnabled schema entry, getAll
 * exposure, saveConfig round-trip).
 *
 * Strategy mirrors config-service-order-xml.test.js — stubs `electron`
 * and `electron-store` via Module.prototype.require so the real
 * config-service module runs against an in-memory fake store.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');

const __origRequire = Module.prototype.require;

function freshConfigService() {
  const fakeData = {};
  Module.prototype.require = function (req) {
    if (req === 'electron') return { app: { getPath: () => '/tmp' } };
    if (req === 'electron-store') {
      return class FakeStore {
        constructor(opts) { this._opts = opts; this._d = fakeData; }
        get(key, fallback) {
          if (this._d[key] !== undefined) return this._d[key];
          const def = this._opts && this._opts.schema && this._opts.schema[key] &&
                      this._opts.schema[key].default;
          return def !== undefined ? def : fallback;
        }
        set(key, value) { this._d[key] = value; }
        delete(key) { delete this._d[key]; }
        get store() { return this._d; }
      };
    }
    return __origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve('../config-service')];
  return require('../config-service');
}

test.afterEach(() => { Module.prototype.require = __origRequire; });

test('defaults: filmScanAutoAssignEnabled is false so existing installs stay inert', () => {
  const cs = freshConfigService();
  const all = cs.getAll();
  assert.equal(all.filmScanAutoAssignEnabled, false);
});

test('save round-trip: true persists', async () => {
  const cs = freshConfigService();
  await cs.save({ filmScanAutoAssignEnabled: true });
  assert.equal(cs.getAll().filmScanAutoAssignEnabled, true);
});

test('save round-trip: false persists', async () => {
  const cs = freshConfigService();
  await cs.save({ filmScanAutoAssignEnabled: true });
  await cs.save({ filmScanAutoAssignEnabled: false });
  assert.equal(cs.getAll().filmScanAutoAssignEnabled, false);
});

test('save coerces truthy non-boolean values via Boolean()', async () => {
  const cs = freshConfigService();
  await cs.save({ filmScanAutoAssignEnabled: 'yes' });
  assert.equal(cs.getAll().filmScanAutoAssignEnabled, true);
  await cs.save({ filmScanAutoAssignEnabled: 0 });
  assert.equal(cs.getAll().filmScanAutoAssignEnabled, false);
});

test('save without the key leaves the stored value untouched', async () => {
  const cs = freshConfigService();
  await cs.save({ filmScanAutoAssignEnabled: true });
  await cs.save({ filmScanReviewMode: 'smart' });
  assert.equal(cs.getAll().filmScanAutoAssignEnabled, true,
    'unrelated save must not clear the auto-assign flag');
  assert.equal(cs.getAll().filmScanReviewMode, 'smart');
});
