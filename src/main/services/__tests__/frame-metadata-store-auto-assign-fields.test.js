'use strict';

/**
 * frame-metadata-store.listRollsWithSummary must surface the eight
 * Film Development Auto Assignment fields so the Film Review renderer
 * (RollList pills + RollReview button-state derivation) can read them
 * off the summary. Legacy rolls without those fields must yield
 * undefined for each — pre-feature behaviour preserved.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const Module  = require('node:module');

// Per-file userData sandbox so this test file's on-disk store can't
// race with any other test file that also stubs electron.app.getPath
// to a tempdir. Mirrors the folder-watch test isolation pattern.
const __userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-fms-aa-'));

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') return { app: { getPath: () => __userDataDir } };
  return __originalRequire.apply(this, arguments);
};

const frameMetadataStore = require(path.join(__dirname, '..', 'frame-metadata-store.js'));

function resetStore() {
  frameMetadataStore._clearAll();
  try {
    const rolls = frameMetadataStore.store.get('rolls', {});
    for (const rollId of Object.keys(rolls)) frameMetadataStore.deleteRoll(rollId);
  } catch (_) { /* best-effort */ }
}

test('summary surfaces the 8 auto-assign fields when they are set on the roll record', () => {
  resetStore();
  frameMetadataStore.record('R1_0', {
    rollId: 'R1', frameIndex: 0, fileName: 'a.jpg', originalPath: '/tmp/a.jpg',
  });
  frameMetadataStore.recordRoll('R1', {
    storagePath: '/tmp/R1', s3Prefix: 'film-scans/loc/', locationId: 'loc',
    uploadStatus: 'pending',
    awaitingAssignment: true,
    reviewPassed:       false,
    matchedJobId:       'JOB-42',
    matchedJobNumber:   'PXDEMO-42',
    matchedOrderId:     'ORD-42',
    matchedOrderNumber: 'PXORD-42',
    matchedTwinCheck:   '1847',
    matchedAt:          '2026-07-05T12:00:00Z',
  });

  const summaries = frameMetadataStore.listRollsWithSummary();
  const R1 = summaries.find(s => s.rollId === 'R1');
  assert.ok(R1);
  assert.equal(R1.uploadStatus,       'pending');
  assert.equal(R1.awaitingAssignment, true);
  assert.equal(R1.reviewPassed,       false);
  assert.equal(R1.matchedJobId,       'JOB-42');
  assert.equal(R1.matchedJobNumber,   'PXDEMO-42');
  assert.equal(R1.matchedOrderId,     'ORD-42');
  assert.equal(R1.matchedOrderNumber, 'PXORD-42');
  assert.equal(R1.matchedTwinCheck,   '1847');
  assert.equal(R1.matchedAt,          '2026-07-05T12:00:00Z');
});

test('legacy roll (no auto-assign fields on record) yields undefined for each field', () => {
  resetStore();
  frameMetadataStore.record('R2_0', {
    rollId: 'R2', frameIndex: 0, fileName: 'a.jpg', originalPath: '/tmp/a.jpg',
  });
  frameMetadataStore.recordRoll('R2', {
    storagePath: '/tmp/R2', s3Prefix: 'film-scans/loc/', locationId: 'loc',
    uploadStatus: 'pending',
  });

  const summaries = frameMetadataStore.listRollsWithSummary();
  const R2 = summaries.find(s => s.rollId === 'R2');
  assert.ok(R2);
  assert.equal(R2.awaitingAssignment, undefined);
  assert.equal(R2.reviewPassed,       undefined);
  assert.equal(R2.matchedJobId,       undefined);
  assert.equal(R2.matchedJobNumber,   undefined);
  assert.equal(R2.matchedOrderId,     undefined);
  assert.equal(R2.matchedOrderNumber, undefined);
  assert.equal(R2.matchedTwinCheck,   undefined);
  assert.equal(R2.matchedAt,          undefined);
});

test('roll with no record at all (frames only, pre-M7) yields undefined for every roll-level field', () => {
  resetStore();
  frameMetadataStore.record('R3_0', {
    rollId: 'R3', frameIndex: 0, fileName: 'a.jpg', originalPath: '/tmp/a.jpg',
  });
  // Do NOT call recordRoll — legacy path.

  const summaries = frameMetadataStore.listRollsWithSummary();
  const R3 = summaries.find(s => s.rollId === 'R3');
  assert.ok(R3);
  assert.equal(R3.awaitingAssignment, undefined);
  assert.equal(R3.matchedJobId,       undefined);
});
