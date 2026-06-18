/**
 * Unit test for folder-monitor.handlePrefixChange:
 * verifies the callback shape carries `jobId` (not the old `orderNumber` field)
 * and that the numeric captured group lines up with what
 * polling-service._handleFolderStatusChange and findJobById expect.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { FolderMonitor } = require('../folder-monitor.js');

test('handlePrefixChange emits { jobId, productCode, status, timestamp } — not orderNumber', () => {
  const monitor = new FolderMonitor();
  const events  = [];

  monitor.handlePrefixChange(
    'o38461218_PXDEMO-PFTAP4-1_4x6 Photo Print_lustre_full-bleed',
    'o',
    (event) => events.push(event)
  );

  assert.equal(events.length, 1);
  const e = events[0];

  assert.equal(e.jobId, '38461218', 'jobId field carries the digits captured after the prefix');
  assert.equal(e.orderNumber, undefined,
    'orderNumber field must be removed — leaving it would silently re-introduce mis-labelled reads');
  assert.equal(e.productCode, 'PXDEMO-PFTAP4-1_4x6 Photo Print_lustre_full-bleed');
  assert.equal(e.status, 'submitted', 'prefix "o" maps to "submitted"');
  assert.ok(e.timestamp instanceof Date);
});

test('handlePrefixChange maps each known prefix to its status', () => {
  const monitor = new FolderMonitor();
  const seen = {};

  for (const prefix of ['o', 'e', 'q']) {
    monitor.handlePrefixChange(
      `${prefix}38461218_PXDEMO-PFTAP4-1_4x6 Photo Print`,
      prefix,
      (event) => { seen[prefix] = event.status; }
    );
  }

  assert.deepEqual(seen, { o: 'submitted', e: 'accepted', q: 'failed' });
});

test('handlePrefixChange ignores folders without the {prefix}{digits}_ shape', () => {
  const monitor = new FolderMonitor();
  let called = false;

  monitor.handlePrefixChange(
    'oPXDEMO-NO-JOBID_4x6 Photo Print', // old-format folder, no leading digits
    'o',
    () => { called = true; }
  );

  assert.equal(called, false, 'old-format folder names must not fire the callback');
});
