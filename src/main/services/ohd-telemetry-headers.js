'use strict';

// Version + instance-id headers ohd-api v1.4.0 records on every request.
// The server requires the pair — send both or neither.
//
// Must never throw and must be require-able headless (tests). instance.js
// requires electron at module load, so its require is deferred to call time
// and wrapped in try/catch.

let _memoised = null;

function _resolve() {
  let version = null;
  try {
    version = require('electron').app.getVersion();
  } catch (_) {
    try {
      version = require('../../../package.json').version;
    } catch (_) { /* leave null */ }
  }

  let instanceId = null;
  try {
    instanceId = require('./instance').getInstanceId();
  } catch (_) { /* leave null */ }

  if (!version || !instanceId) return {};
  return {
    'X-OHD-Version': version,
    'X-OHD-Instance-ID': instanceId,
  };
}

function getOhdTelemetryHeaders() {
  if (_memoised) return _memoised;
  const headers = _resolve();
  if (headers['X-OHD-Version'] && headers['X-OHD-Instance-ID']) {
    _memoised = headers;
  }
  return headers;
}

// Test-only: clear the memoisation so each case can drive its own outcome.
function _resetForTests() { _memoised = null; }

module.exports = { getOhdTelemetryHeaders, _resetForTests };
