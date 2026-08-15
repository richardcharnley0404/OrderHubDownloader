/**
 * Unit tests for folder-monitor.handlePrefixChange.
 *
 * Verifies the callback payload shape:
 *   - `jobId` (numeric string captured after the prefix)
 *   - `batch` ({index, total}) or null for unsplit folders
 *   - `reprintSuffix` ('r1' etc) or null for parent folders
 *   - `rest` (everything after jobId_) — the pre-M1 field was called
 *     `productCode` which was misleading; it's job-name + optional
 *     surname + optional discriminator + product + options concatenated
 *   - `status` mapped from prefix (submitted / accepted / failed)
 *   - `timestamp`
 *
 * The batch + reprint fields were added in M1 of
 * docs/epson-batch-splitting-brief.md so downstream consumers can
 * attribute an event to the RIGHT folder-for-a-job, not just the
 * parent job id — the precondition for batch splitting (M3+) and the
 * fix for the reprint-attribution risk the brief flags.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { FolderMonitor } = require('../folder-monitor.js');
const { buildFolderName } = require('../../../shared/printUtils.js');

const baseJob = {
  id:           38461218,
  order_number: 'PXDEMO-PFTAP4',
  job_name:     'PXDEMO-PFTAP4-1',
  product:      '4x6 Photo Print',
  options: [
    { name: 'finish-options', value: 'lustre' },
    { name: 'layout-options', value: 'full-bleed' },
  ],
};

function captureOne(monitor, folderName, prefix) {
  const events = [];
  monitor.handlePrefixChange(folderName, prefix, (event) => events.push(event));
  return events;
}

test('handlePrefixChange emits { jobId, batch, reprintSuffix, rest, status, timestamp } for an unsplit folder', () => {
  const monitor = new FolderMonitor();
  const events  = captureOne(
    monitor,
    'o38461218_PXDEMO-PFTAP4-1_4x6 Photo Print_lustre_full-bleed',
    'o',
  );

  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.jobId,         '38461218', 'jobId is the digits captured after the prefix');
  assert.equal(e.batch,         null,       'unsplit folder has no batch marker');
  assert.equal(e.reprintSuffix, null,       'parent folder has no reprint suffix');
  assert.equal(e.rest,          'PXDEMO-PFTAP4-1_4x6 Photo Print_lustre_full-bleed');
  assert.equal(e.status,        'submitted', 'prefix "o" maps to "submitted"');
  assert.ok(e.timestamp instanceof Date);

  // Regression lock: the pre-M1 `orderNumber` field was removed
  // (would silently re-introduce mis-labelled reads); the pre-M1
  // `productCode` field was renamed to `rest` (misleading name).
  assert.equal(e.orderNumber, undefined,
    'orderNumber must be absent — leaving it would silently re-introduce mis-labelled reads');
  assert.equal(e.productCode, undefined,
    'productCode was renamed to `rest` in M1 — the old name was misleading');
});

test('handlePrefixChange maps each known prefix to its status', () => {
  const monitor = new FolderMonitor();
  const seen = {};

  for (const prefix of ['o', 'e', 'q']) {
    const [event] = captureOne(
      monitor,
      `${prefix}38461218_PXDEMO-PFTAP4-1_4x6 Photo Print`,
      prefix,
    );
    seen[prefix] = event.status;
  }

  assert.deepEqual(seen, { o: 'submitted', e: 'accepted', q: 'failed' });
});

test('handlePrefixChange ignores folders without the {prefix}{digits}_ shape', () => {
  const monitor = new FolderMonitor();
  let called = false;

  monitor.handlePrefixChange(
    'oPXDEMO-NO-JOBID_4x6 Photo Print', // pre-M1 shape, no leading digits
    'o',
    () => { called = true; }
  );

  assert.equal(called, false, 'old-format folder names must not fire the callback');
});

test('handlePrefixChange returns batch descriptor for a split folder', () => {
  // M1 of docs/epson-batch-splitting-brief.md: the callback payload
  // carries the batch identity so consumers can attribute an event
  // to the RIGHT folder-for-a-job, not just the parent job id.
  const monitor = new FolderMonitor();
  const [event] = captureOne(
    monitor,
    'e38461218_PXDEMO-PFTAP4-1_2of5_4x6 Photo Print_lustre_full-bleed',
    'e',
  );
  assert.equal(event.jobId,         '38461218');
  assert.deepEqual(event.batch,     { index: 2, total: 5 });
  assert.equal(event.reprintSuffix, null);
  assert.equal(event.status,        'accepted');
});

test('handlePrefixChange returns reprintSuffix for a reprint folder — NOT confused with the parent', () => {
  // The reprint-attribution risk the brief flags. Pre-M1 the callback
  // said "jobId 38461218 was accepted" for BOTH the parent folder and
  // the reprint folder — the two are indistinguishable to any consumer
  // that just reads jobId. Post-M1 the reprint's payload carries
  // reprintSuffix: 'r1', so a consumer can tell them apart and NOT
  // mark the parent completed when only the reprint accepted.
  const monitor = new FolderMonitor();
  const [event] = captureOne(
    monitor,
    'e38461218_PXDEMO-PFTAP4-1_r1_4x6 Photo Print_lustre_full-bleed',
    'e',
  );
  assert.equal(event.jobId,         '38461218',
    'jobId is still the parent job id — reprints inherit their parent\'s job.id (that has always been true)');
  assert.equal(event.reprintSuffix, 'r1',
    'reprintSuffix disambiguates a reprint folder from its parent — the precondition for correct attribution');
  assert.equal(event.batch,         null);
});

test('handlePrefixChange round-trips buildFolderName output for every writer combination', () => {
  // The full round-trip. Anything buildFolderName can produce,
  // handlePrefixChange must attribute correctly. The set of cases
  // matches the writer's actual output surface: unsplit / reprint /
  // batched / with-surname / with-surname-and-batch. Every case for
  // every prefix.
  const monitor = new FolderMonitor();
  const cases = [
    { desc: 'unsplit',           args: [null, {}],                                                                        expect: { batch: null, reprintSuffix: null } },
    { desc: 'reprint r1',        args: ['r1', {}],                                                                        expect: { batch: null, reprintSuffix: 'r1' } },
    { desc: 'batch 2/5',         args: [null, { batch: { index: 2, total: 5 } }],                                         expect: { batch: { index: 2, total: 5 }, reprintSuffix: null } },
    { desc: 'unsplit + surname', args: [null, { includeCustomerName: true, customerName: 'Alice Bee' }],                  expect: { batch: null, reprintSuffix: null } },
    { desc: 'batch + surname',   args: [null, { batch: { index: 3, total: 4 }, includeCustomerName: true, customerName: 'Alice Bee' }], expect: { batch: { index: 3, total: 4 }, reprintSuffix: null } },
    { desc: 'reprint + surname', args: ['r2', { includeCustomerName: true, customerName: 'Alice Bee' }],                  expect: { batch: null, reprintSuffix: 'r2' } },
  ];

  for (const c of cases) {
    for (const prefix of ['o', 'e', 'q']) {
      const folderName = buildFolderName(prefix, baseJob, c.args[0], c.args[1]);
      const [event]    = captureOne(monitor, folderName, prefix);
      assert.ok(event, `${c.desc} (prefix ${prefix}): no event fired for "${folderName}"`);
      assert.equal(event.jobId,         '38461218', `${c.desc} (${prefix}): jobId`);
      assert.deepEqual(event.batch,     c.expect.batch,         `${c.desc} (${prefix}): batch`);
      assert.equal(event.reprintSuffix, c.expect.reprintSuffix, `${c.desc} (${prefix}): reprintSuffix`);
    }
  }
});
