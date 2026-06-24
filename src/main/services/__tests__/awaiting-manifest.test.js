'use strict';

/**
 * awaitingReArmUpdates — decides whether a dispatch-path error should re-arm
 * the awaiting-manifest wait (non-terminal, self-healing via polling-service)
 * or fall through to the existing terminal-error handling.
 *
 * This is the pure core of the auto-print catch-block change; unit-testing it
 * here keeps the contract locked without booting ipc-handlers (which pulls in
 * sharp and can't load headless in CI/sandbox).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const { ManifestNotFoundError, awaitingReArmUpdates } =
  require(path.join(__dirname, '..', 'awaiting-manifest.js'));

const MANIFEST_PATH = '/share/pixfizz/PRLE-EL2KTR_999/PRLE-EL2KTR.json';

test('returns null for a non-manifest error (stays terminal)', () => {
  const job = { id: 'J1' };
  assert.equal(awaitingReArmUpdates(job, new Error('Controller offline')), null);
});

test('returns null for a manifest parse failure (terminal corruption)', () => {
  const job = { id: 'J1' };
  // A plain Error from the "Failed to read order manifest" path must NOT re-arm.
  assert.equal(awaitingReArmUpdates(job, new Error('Failed to read order manifest: x')), null);
});

test('re-arms awaiting for a ManifestNotFoundError, setting status back to pending', () => {
  const job = { id: 'J1' };
  const updates = awaitingReArmUpdates(job, new ManifestNotFoundError(MANIFEST_PATH), '2026-06-24T10:00:00.000Z');

  assert.equal(updates._status, 'pending', 'must be pending so the polling loop re-checks it');
  assert.equal(updates._awaitingManifest, true);
  assert.equal(updates._awaitingManifestPath, MANIFEST_PATH);
  assert.equal(updates._awaitingManifestSince, '2026-06-24T10:00:00.000Z');
});

test('preserves the original _awaitingManifestSince so the 10-min bound spans the whole episode', () => {
  const job = { id: 'J1', _awaitingManifestSince: '2026-06-24T09:55:00.000Z' };
  const updates = awaitingReArmUpdates(job, new ManifestNotFoundError(MANIFEST_PATH), '2026-06-24T10:00:00.000Z');

  // Clock must NOT be reset — otherwise an awaiting↔dispatch bounce could
  // defer escalation indefinitely.
  assert.ok(!('_awaitingManifestSince' in updates), 'existing wait-start is left untouched');
  assert.equal(updates._awaitingManifest, true);
});
