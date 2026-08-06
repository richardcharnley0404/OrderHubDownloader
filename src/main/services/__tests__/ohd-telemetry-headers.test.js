/**
 * Unit tests for ohd-telemetry-headers.js
 *
 * The module must:
 *   - Return { X-OHD-Version, X-OHD-Instance-ID } when both values resolve.
 *   - Return {} (omit both) when either half fails.
 *   - Never throw, even when `electron` isn't loadable.
 *
 * We drive it by monkey-patching Module.prototype.require so the module's
 * lazy requires for `electron` and `./instance` return whatever the test
 * needs. Between cases we clear the module's memoisation via
 * `_resetForTests` AND drop it from require.cache, so the module reloads
 * against the freshly-patched require.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const MODULE_PATH = require.resolve('../ohd-telemetry-headers');
const INSTANCE_PATH = require.resolve('../../instance');
const PKG_PATH = require.resolve('../../../../package.json');

const __origRequire = Module.prototype.require;

function withRequireStub(handler, fn) {
  Module.prototype.require = function (req) {
    const stub = handler(req);
    if (stub !== undefined) return stub;
    return __origRequire.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    Module.prototype.require = __origRequire;
  }
}

function freshModule() {
  delete require.cache[MODULE_PATH];
  delete require.cache[INSTANCE_PATH];
  // package.json is a fallback path in the module; drop it so a case that
  // wants the fallback to fail (e.g. by throwing on require) can do so.
  delete require.cache[PKG_PATH];
  return require('../ohd-telemetry-headers');
}

test('returns both keys when version and instance id resolve', () => {
  const headers = withRequireStub(
    (req) => {
      if (req === 'electron') return { app: { getVersion: () => '1.8.0' } };
      if (req === './instance') return { getInstanceId: () => 'inst-abc-123' };
      return undefined;
    },
    () => freshModule().getOhdTelemetryHeaders()
  );

  assert.deepEqual(headers, {
    'X-OHD-Version': '1.8.0',
    'X-OHD-Instance-ID': 'inst-abc-123',
  });
});

test('returns {} when getInstanceId throws', () => {
  const headers = withRequireStub(
    (req) => {
      if (req === 'electron') return { app: { getVersion: () => '1.8.0' } };
      if (req === './instance') {
        return { getInstanceId: () => { throw new Error('userData unavailable'); } };
      }
      return undefined;
    },
    () => freshModule().getOhdTelemetryHeaders()
  );

  assert.deepEqual(headers, {});
});

test('never throws when electron is absent from the require cache', () => {
  // Simulate a fully headless load: electron require throws, package.json
  // fallback also throws, and instance.js require throws. The module must
  // still return {} rather than propagate.
  let headers;
  assert.doesNotThrow(() => {
    headers = withRequireStub(
      (req) => {
        if (req === 'electron') throw new Error('Cannot find module electron');
        if (req === './instance') throw new Error('Cannot find module ./instance');
        if (req.endsWith('package.json')) throw new Error('no package.json');
        return undefined;
      },
      () => freshModule().getOhdTelemetryHeaders()
    );
  });
  assert.deepEqual(headers, {});
});
