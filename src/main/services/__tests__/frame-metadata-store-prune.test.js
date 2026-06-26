'use strict';

/**
 * Film Review history retention — isRollPrunable decides which rolls the
 * retention sweep (pruneOldRolls) may drop. Only finished ('reviewed') rolls
 * older than the cutoff qualify; everything in-flight, awaiting, uploading, or
 * failed is kept regardless of age.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const path    = require('node:path');

// frame-metadata-store → electron-store → electron.app. Stub electron so the
// require chain resolves headless (mirrors print-service-discarded.test).
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return __originalRequire.apply(this, arguments);
};

const { isRollPrunable } = require(path.join(__dirname, '..', 'frame-metadata-store.js'));

const CUTOFF = Date.parse('2026-06-01T00:00:00Z');
const OLD = '2026-05-01T00:00:00Z'; // before cutoff
const NEW = '2026-06-20T00:00:00Z'; // after cutoff

test('prunes a reviewed roll older than the cutoff (by uploadedAt)', () => {
  assert.equal(isRollPrunable({ rollId: 'r', status: 'reviewed', uploadedAt: OLD }, CUTOFF), true);
});

test('keeps a reviewed roll newer than the cutoff', () => {
  assert.equal(isRollPrunable({ rollId: 'r', status: 'reviewed', uploadedAt: NEW }, CUTOFF), false);
});

test('falls back to lastSeenAt when uploadedAt is absent', () => {
  assert.equal(isRollPrunable({ rollId: 'r', status: 'reviewed', lastSeenAt: OLD }, CUTOFF), true);
});

test('never prunes a not-yet-reviewed roll, however old', () => {
  assert.equal(isRollPrunable({ rollId: 'r', status: 'ready_for_review', lastSeenAt: OLD }, CUTOFF), false);
});

test('never prunes an awaiting / uploading / failed roll', () => {
  assert.equal(isRollPrunable({ rollId: 'r', status: 'ready_for_review', uploadStatus: 'pending',   lastSeenAt: OLD }, CUTOFF), false);
  assert.equal(isRollPrunable({ rollId: 'r', status: 'ready_for_review', uploadStatus: 'uploading', lastSeenAt: OLD }, CUTOFF), false);
  assert.equal(isRollPrunable({ rollId: 'r', status: 'ready_for_review', uploadStatus: 'failed',    lastSeenAt: OLD }, CUTOFF), false);
});

test('false for missing rollId or unparseable timestamps', () => {
  assert.equal(isRollPrunable({ status: 'reviewed', uploadedAt: OLD }, CUTOFF), false);
  assert.equal(isRollPrunable({ rollId: 'r', status: 'reviewed' }, CUTOFF), false);
  assert.equal(isRollPrunable(null, CUTOFF), false);
});
