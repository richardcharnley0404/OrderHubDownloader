'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const { isRecoverableManifestError, recoverManifestErrors } =
  require(path.join(__dirname, '..', 'manifestErrorRecovery.js'));

test('isRecoverableManifestError: matches a sticky dispatch-path not-found error', () => {
  assert.equal(
    isRecoverableManifestError({ _status: 'error', _errorMessage: 'Order manifest not found: R:\\pixfizz\\PRLE-EL2KTR_1\\PRLE-EL2KTR.json' }),
    true,
  );
});

test('isRecoverableManifestError: does NOT match the awaiting-manifest timeout escalation', () => {
  assert.equal(
    isRecoverableManifestError({ _status: 'error', _errorMessage: 'Order manifest not received within 10 minutes — check FTP / S3 delivery (R:\\...\\x.json)' }),
    false,
  );
});

test('isRecoverableManifestError: does NOT match a corrupt-manifest parse error', () => {
  assert.equal(
    isRecoverableManifestError({ _status: 'error', _errorMessage: 'Failed to read order manifest: Unexpected token } in JSON' }),
    false,
  );
});

test('isRecoverableManifestError: false for non-error status or missing message', () => {
  assert.equal(isRecoverableManifestError({ _status: 'pending', _errorMessage: 'Order manifest not found: x' }), false);
  assert.equal(isRecoverableManifestError({ _status: 'error' }), false);
  assert.equal(isRecoverableManifestError({ _status: 'error', _errorMessage: null }), false);
  assert.equal(isRecoverableManifestError(null), false);
});

test('recoverManifestErrors: resets matching jobs to pending and clears stamps, leaving others untouched', () => {
  const jobs = [
    { id: 'A', _status: 'error', _errorMessage: 'Order manifest not found: x.json', _awaitingManifest: false, _awaitingManifestSince: '2026-06-24T10:00:00Z', _awaitingManifestPath: 'x.json' },
    { id: 'B', _status: 'error', _errorMessage: 'Dispatch failed: controller offline' },
    { id: 'C', _status: 'received' },
    { id: 'D', _status: 'error', _errorMessage: 'Order manifest not received within 10 minutes (x)' },
    { id: 'E', _status: 'error', _errorMessage: 'order MANIFEST not FOUND: y.json' }, // case-insensitive
  ];

  const recovered = recoverManifestErrors(jobs);
  assert.equal(recovered, 2, 'only A and E qualify');

  // A reset cleanly
  assert.equal(jobs[0]._status, 'pending');
  assert.equal('_errorMessage' in jobs[0], false);
  assert.equal('_awaitingManifest' in jobs[0], false);
  assert.equal('_awaitingManifestSince' in jobs[0], false);
  assert.equal('_awaitingManifestPath' in jobs[0], false);

  // E reset
  assert.equal(jobs[4]._status, 'pending');

  // Others untouched
  assert.equal(jobs[1]._status, 'error');         // non-manifest error
  assert.equal(jobs[2]._status, 'received');       // not an error
  assert.equal(jobs[3]._status, 'error');          // escalation — left terminal
});

test('recoverManifestErrors: tolerates non-array input', () => {
  assert.equal(recoverManifestErrors(null), 0);
  assert.equal(recoverManifestErrors(undefined), 0);
});
