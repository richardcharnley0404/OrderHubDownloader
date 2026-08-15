'use strict';

/**
 * Tests for _sendViaDarkroomProRouted's M4 batch-splitting behaviour.
 *
 * Cover the M4 verification checklist from
 * docs/batch-splitting-darkroom-pro-brief.md:
 *
 *   1. Cap null → exactly one generateDarkroomProFile call, filename
 *      unchanged (no _1 suffix). Regression guarantee for every lab
 *      that hasn't set a cap.
 *   2. Cap 100, 600 images qty 1 → 6 calls, stems _1.._6, images
 *      partitioned correctly with none lost or duplicated.
 *   3. Cap 100, qty 2 → 12 calls of 50 images each.
 *   4. Corrections / enhanced-map preparation runs ONCE, not once per
 *      batch. This is the disk-churn invariant.
 *   5. Discarded images are excluded before splitting, and boundaries
 *      reflect that (covered via _findJobInManifest applying the
 *      filter — asserted indirectly by asserting the input to the
 *      split matches the post-filter manifest).
 *   6. Batch 4 throwing → ledger records 1-3 succeeded, job stamped
 *      error naming them, {success:false} returned.
 *   7. Ledger survives a simulated restart (re-read from the store).
 *
 * The print-service singleton is monkey-patched: helpers are replaced
 * with stubs that record calls, and the batched emitter uses the
 * this._emitDarkroomProFile seam introduced in M4. Same pattern as
 * print-service-reprint-dispatch.test.js. jobService.updateJobLocally
 * is spied so the ledger writes are observable.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const path    = require('node:path');

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

const printService = require(path.join(__dirname, '..', 'print-service.js'));
const jobService   = require(path.join(__dirname, '..', 'job-service.js'));
const configService = require(path.join(__dirname, '..', 'config-service.js'));
const routingService = require(path.join(__dirname, '..', 'routing-service.js'));

// ── Harness ──────────────────────────────────────────────────────────────────
// Every test installs the same set of stubs on the print-service singleton
// (per-job helpers) and shared services, then restores originals via t.after.

function withBatchingHarness(fn) {
  return async (t) => {
    // Save originals.
    const orig = {
      readManifest:                printService._readManifest,
      findJobInManifest:           printService._findJobInManifest,
      getEnhancedPathMap:          printService._getEnhancedPathMap,
      getCorrectionsMap:           printService._getCorrectionsMap,
      applyCorrectionsToImageFiles: printService._applyCorrectionsToImageFiles,
      markCompleted:               printService._markCompleted,
      markInProduction:            printService._markInProduction,
      emitDarkroomProFile:         printService._emitDarkroomProFile,
      configGet:                   configService.get,
      updateJobLocally:            jobService.updateJobLocally,
      getControllers:              routingService.getControllers,
      existsSync:                  require('fs').existsSync,
    };

    // Call counters.
    const calls = {
      readManifest:                 0,
      findJobInManifest:            0,
      getEnhancedPathMap:           0,
      getCorrectionsMap:            0,
      applyCorrectionsToImageFiles: 0,
      markCompleted:                0,
      markInProduction:             0,
      emit:                         [], // [{ stem, images, throwOnce? }]
      updateJobLocally:             [], // [{ jobId, updates }]
    };

    // configService — pretend the download directory exists.
    configService.get = (key) => (key === 'downloadDirectory' ? '/tmp/dl' : undefined);
    require('fs').existsSync = () => true;

    // routing-service — return an empty controller list; the fetch is used
    // only to pluck translation tables, absent in these tests.
    routingService.getControllers = () => [{ id: 'CTRL-DP', name: 'DP1', type: 'darkroompro' }];

    // Per-job prep stubs.
    printService._readManifest       = async () => { calls.readManifest++; return { jobs: [{ jobId: 42, images: [] }] }; };
    printService._findJobInManifest  = (_manifest, _job) => { calls.findJobInManifest++; return _manifest.jobs[0]; };
    printService._getEnhancedPathMap = async () => { calls.getEnhancedPathMap++; return new Map(); };
    printService._getCorrectionsMap  = async () => { calls.getCorrectionsMap++; return new Map(); };
    printService._applyCorrectionsToImageFiles = async (files) => { calls.applyCorrectionsToImageFiles++; return files; };
    printService._markCompleted      = async () => { calls.markCompleted++; };
    printService._markInProduction   = async () => { calls.markInProduction++; };

    // Emitter — default just records the call. Tests override for failure.
    printService._emitDarkroomProFile = async (dpJob, _controller) => {
      calls.emit.push({
        stem:     dpJob.outputFilenameStem,
        images:   dpJob.lineItems.reduce((acc, li) => acc + li.images.length, 0),
        lineItems: dpJob.lineItems.map((li) => ({ qty: li.qty, images: li.images.map((i) => i.filename) })),
      });
      return `/hot/${dpJob.outputFilenameStem}.txt`;
    };

    // In-memory replacement for updateJobLocally so the ledger is
    // observable without touching electron-store. Persists the last-known
    // state per jobId in a Map — the "simulated restart" test reads back
    // from this Map after the dispatch returns.
    const jobStore = new Map();
    jobService.updateJobLocally = (jobId, updates) => {
      calls.updateJobLocally.push({ jobId, updates });
      const cur = jobStore.get(jobId) || {};
      jobStore.set(jobId, { ...cur, ...updates });
    };

    t.after(() => {
      Object.assign(printService,   orig);
      configService.get             = orig.configGet;
      jobService.updateJobLocally   = orig.updateJobLocally;
      routingService.getControllers = orig.getControllers;
      require('fs').existsSync      = orig.existsSync;
    });

    await fn(t, calls, jobStore);
  };
}

// Fixtures.
function makeJob() {
  return {
    id:           42,
    order_id:     'oid-42',
    order_number: 'PXTEST-XYZ',
    job_name:     'PXTEST-XYZ-1',
    product_code: 'P',
    customer_name: 'A B',
    options:      [],
  };
}
function makeRoute(overrides = {}) {
  return {
    type:             'controller',
    controllerType:   'darkroompro',
    controllerId:     'CTRL-DP',
    controllerName:   'DP1',
    outputPath:       '/hot',
    checkOrderStatus: true,
    maxPrintsPerJob:  null,
    ...overrides,
  };
}
function images(n, qty = 1) {
  return Array.from({ length: n }, (_, i) => ({
    filename: `img-${i + 1}.jpg`,
    quantity: qty,
  }));
}

// Override _findJobInManifest to return a manifest job with the given images.
// Preserves the harness's per-call counter so the "runs exactly once"
// assertion in the prep-hoist test still holds.
function stubImagesOnFindJob(imagesArr, calls) {
  printService._findJobInManifest = () => {
    if (calls) calls.findJobInManifest++;
    return { jobId: 42, images: imagesArr };
  };
}

// ── 1. Cap null → single emit, filename unchanged (regression guarantee) ─────

test('cap null → exactly one emit, stem = job_name, no _1 suffix, no ledger', withBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(3, 1), calls);
  const result = await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: null }));
  assert.equal(calls.emit.length, 1);
  assert.equal(calls.emit[0].stem, 'PXTEST-XYZ-1', 'stem must be unsuffixed when cap is off');
  assert.equal(result.success, true);
  // Return shape parity — no `batches`, no `destPaths`, no `ledger`.
  assert.equal('batches' in result,   false);
  assert.equal('destPaths' in result, false);
  assert.equal('ledger' in result,    false);
  // No ledger persisted.
  const ledgerWrites = calls.updateJobLocally.filter(c => c.updates._batchLedger);
  assert.equal(ledgerWrites.length, 0, 'no ledger writes on unsplit dispatch');
  // Job not stored beyond markInProduction (which is stubbed here, so store stays empty).
  assert.equal(store.size, 0);
}));

test('cap 0 / cap negative → treated as feature-off (single emit, no suffix)', withBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(3, 1), calls);
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 0 }));
  assert.equal(calls.emit.length, 1);
  assert.equal(calls.emit[0].stem, 'PXTEST-XYZ-1');

  calls.emit.length = 0;
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: -5 }));
  assert.equal(calls.emit.length, 1);
  assert.equal(calls.emit[0].stem, 'PXTEST-XYZ-1');
}));

// ── 2. Cap 100, 600 × qty 1 → 6 emits, stems _1.._6, partition correct ───────

test('cap 100, 600 × qty 1 → 6 emits with stems _1.._6 and correct partition', withBatchingHarness(async (t, calls) => {
  const img = images(600, 1);
  stubImagesOnFindJob(img);
  const result = await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100 }));

  assert.equal(calls.emit.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(calls.emit[i].stem, `PXTEST-XYZ-1_${i + 1}`);
    assert.equal(calls.emit[i].images, 100, `batch ${i + 1} must carry 100 images`);
  }
  // No image lost, no image duplicated.
  const allFilenames = calls.emit.flatMap(e => e.lineItems.flatMap(li => li.images));
  assert.equal(allFilenames.length, 600);
  assert.equal(new Set(allFilenames).size, 600, 'no duplicates across batches');
  // Order preserved.
  assert.equal(allFilenames[0],   'img-1.jpg');
  assert.equal(allFilenames[599], 'img-600.jpg');

  assert.equal(result.success, true);
  assert.equal(result.batches, 6);
  assert.equal(result.destPaths.length, 6);
}));

// ── 3. Cap 100, 600 × qty 2 → 12 emits of 50 images each ─────────────────────

test('cap 100, 600 × qty 2 → 12 emits of 50 images each (cap counts prints, not images)', withBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(600, 2), calls);
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100 }));

  assert.equal(calls.emit.length, 12);
  for (let i = 0; i < 12; i++) {
    assert.equal(calls.emit[i].images, 50, `batch ${i + 1} must carry 50 images (100 prints)`);
    assert.equal(calls.emit[i].lineItems.length, 1, 'all in one qty group');
    assert.equal(calls.emit[i].lineItems[0].qty, 2);
  }
}));

// ── 4. Corrections / enhanced-map prep runs ONCE, not per batch ──────────────

test('per-job prep (manifest / enhanced / corrections / applyCorrections) runs exactly ONCE regardless of batch count', withBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(600, 1), calls);
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100 }));

  assert.equal(calls.readManifest,                 1, '_readManifest must not run per batch');
  assert.equal(calls.findJobInManifest,            1, '_findJobInManifest must not run per batch');
  assert.equal(calls.getEnhancedPathMap,           1, '_getEnhancedPathMap must not run per batch');
  assert.equal(calls.getCorrectionsMap,            1, '_getCorrectionsMap must not run per batch');
  assert.equal(calls.applyCorrectionsToImageFiles, 1, '_applyCorrectionsToImageFiles WRITES to /working/ — must not run per batch');
  assert.equal(calls.emit.length,                  6, 'emitter is the only per-batch call');
}));

// ── 5. Discarded images already filtered by _findJobInManifest ───────────────

test('discarded images are excluded BEFORE splitting — batch boundaries reflect the post-discard image list', withBatchingHarness(async (t, calls) => {
  // Manifest carries 250 raw images; the operator-discarded filter (inside
  // _findJobInManifest) leaves 200. Cap 100 must yield 2 batches of 100
  // — not 3 batches (which is what splitting on the raw list would give).
  const rawImages = images(250, 1);
  const filteredImages = rawImages.slice(0, 200); // pretend 50 were discarded
  printService._findJobInManifest = () => ({ jobId: 42, images: filteredImages });

  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100 }));

  assert.equal(calls.emit.length, 2, 'split runs on the post-discard list');
  assert.equal(calls.emit[0].images, 100);
  assert.equal(calls.emit[1].images, 100);
}));

// ── 6. Partial failure — batch 4 throws ──────────────────────────────────────

test('batch 4 of 6 throws → ledger records 1-3 succeeded + batch 4 error, job stamped error naming batches, {success:false}', withBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(600, 1), calls);
  let callN = 0;
  printService._emitDarkroomProFile = async (dpJob) => {
    callN++;
    calls.emit.push({ stem: dpJob.outputFilenameStem, images: dpJob.lineItems.reduce((a, li) => a + li.images.length, 0) });
    if (callN === 4) throw new Error('ENOSPC: hot folder full');
    return `/hot/${dpJob.outputFilenameStem}.txt`;
  };

  const result = await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100 }));

  // 4 emits attempted (1-3 succeeded, 4 threw); loop stopped after the throw.
  assert.equal(calls.emit.length, 4);

  // Return contract.
  assert.equal(result.success, false);
  assert.equal(result.batchesSucceeded, 3);
  assert.equal(result.batchesTotal,     6);
  assert.match(result.error, /batch 4\/6/i);
  assert.match(result.error, /batches 1\.\.3 were written/i);

  // Ledger reflects the truth: 3 successes + 1 error entry. Read from the
  // in-memory store (last write wins per key).
  const stored = store.get(42);
  const ledger = stored._batchLedger;
  assert.ok(ledger);
  assert.equal(ledger.totalBatches, 6);
  assert.equal(ledger.batches.length, 4);
  for (let i = 0; i < 3; i++) {
    assert.equal(ledger.batches[i].outcome, 'success');
    assert.equal(ledger.batches[i].index,   i + 1);
    assert.equal(ledger.batches[i].filename, `PXTEST-XYZ-1_${i + 1}.txt`);
  }
  assert.equal(ledger.batches[3].outcome, 'error');
  assert.equal(ledger.batches[3].index,   4);
  assert.match(ledger.batches[3].error,   /ENOSPC/);
  assert.equal(ledger.completedAt, null, 'completedAt must not be set on partial failure');

  // Job stamped errored.
  assert.equal(stored._status, 'error');
  assert.match(stored._errorMessage, /Darkroom Pro batch 4\/6 failed/);

  // Neither lifecycle marker fires on partial failure.
  assert.equal(calls.markCompleted,    0, '_markCompleted must NOT fire on partial failure');
  assert.equal(calls.markInProduction, 0, '_markInProduction must NOT fire on partial failure');
}));

// ── Persist-per-batch invariant — not persist-once-at-end ────────────────────
//
// The dispatch loop writes the ledger after every successful batch, not just
// after the loop completes. This test snapshots the persisted store at the
// moment batch 4's emit is called (before batch 4 does anything) and asserts
// batches 1-3 are already recorded as success. If someone regressed the loop
// to persist once at the end, batches 1-3 would be absent from the snapshot
// and a process death mid-loop would leave files in the hot folder with no
// record on disk.

test('ledger is persisted after EVERY batch — at the moment batch 4 starts, batches 1-3 are already on disk', withBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(600, 1), calls);

  let snapshotAtBatch4Start = null;
  printService._emitDarkroomProFile = async (dpJob) => {
    const callN = calls.emit.length + 1;
    calls.emit.push({ stem: dpJob.outputFilenameStem, images: dpJob.lineItems.reduce((a, li) => a + li.images.length, 0) });
    if (callN === 4) {
      // Deep-clone the current store entry BEFORE we throw or return. This
      // is what a process death between batch 3's write and batch 4's emit
      // would leave on disk. `store.get(42)` here is the in-memory
      // jobs-cache surrogate the harness maintains.
      const stored = store.get(42);
      snapshotAtBatch4Start = stored && stored._batchLedger
        ? JSON.parse(JSON.stringify(stored._batchLedger))
        : null;
      throw new Error('simulated crash before batch 4 completes');
    }
    return `/hot/${dpJob.outputFilenameStem}.txt`;
  };

  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100 }));

  assert.ok(snapshotAtBatch4Start, 'ledger must have been persisted at least once before batch 4 started');
  assert.equal(snapshotAtBatch4Start.totalBatches, 6);
  assert.equal(snapshotAtBatch4Start.batches.length, 3, 'batches 1-3 must be persisted by the time batch 4 begins');
  for (let i = 0; i < 3; i++) {
    assert.equal(snapshotAtBatch4Start.batches[i].outcome, 'success');
    assert.equal(snapshotAtBatch4Start.batches[i].index,   i + 1);
    assert.equal(snapshotAtBatch4Start.batches[i].filename, `PXTEST-XYZ-1_${i + 1}.txt`);
    assert.ok(snapshotAtBatch4Start.batches[i].dispatchedAt);
  }
  // completedAt is only set once every batch succeeds — not at any point
  // during the loop.
  assert.equal(snapshotAtBatch4Start.completedAt, null);
}));

// ── 7. Ledger survives a simulated restart ───────────────────────────────────

test('ledger survives a simulated restart — the stored jobs-cache entry carries the last-persisted ledger', withBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(300, 1), calls);
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100 }));

  // Simulate restart: the in-process print-service is gone; the harness's
  // in-memory jobStore is the persistent jobs-cache surrogate. Read back
  // whatever the last updateJobLocally write persisted.
  const stored = store.get(42);
  assert.ok(stored, 'jobs-cache entry survives');
  const ledger = stored._batchLedger;
  assert.ok(ledger, 'ledger is on the persisted entry');
  assert.equal(ledger.totalBatches, 3);
  assert.equal(ledger.batches.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(ledger.batches[i].outcome, 'success');
    assert.equal(ledger.batches[i].filename, `PXTEST-XYZ-1_${i + 1}.txt`);
    assert.ok(ledger.batches[i].dispatchedAt, 'each batch entry carries a dispatchedAt');
    assert.ok(ledger.batches[i].destPath,     'success entries carry destPath');
  }
  assert.ok(ledger.completedAt, 'completedAt set once every batch has succeeded');
  assert.ok(ledger.startedAt);
  assert.equal(ledger.cap, 100);
  assert.equal(ledger.totalPrints, 300);
}));

// ── Lifecycle: single-batch and split settle correctly ───────────────────────

test('lifecycle: single batch + checkOrderStatus=false → _markCompleted once, _markInProduction zero', withBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(3, 1), calls);
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ checkOrderStatus: false }));
  assert.equal(calls.markCompleted,    1);
  assert.equal(calls.markInProduction, 0);
}));

test('lifecycle: single batch + checkOrderStatus=true → _markInProduction once', withBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(3, 1), calls);
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ checkOrderStatus: true }));
  assert.equal(calls.markInProduction, 1);
  assert.equal(calls.markCompleted,    0);
}));

test('lifecycle: 6 batches all succeed + checkOrderStatus=false → _markCompleted once (not per batch)', withBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(600, 1), calls);
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100, checkOrderStatus: false }));
  assert.equal(calls.emit.length,      6);
  assert.equal(calls.markCompleted,    1);
  assert.equal(calls.markInProduction, 0);
}));

test('lifecycle: 6 batches all succeed + checkOrderStatus=true → _markInProduction once (not per batch)', withBatchingHarness(async (t, calls) => {
  // M5 checklist item 2. If the lifecycle branch were still inside the loop
  // (or accidentally called per-batch), _markInProduction would fire 6 times
  // and the operator's "in production" indicator would be meaningless. It
  // must fire exactly once, after every batch has landed successfully.
  stubImagesOnFindJob(images(600, 1), calls);
  await printService._sendViaDarkroomProRouted(makeJob(), makeRoute({ maxPrintsPerJob: 100, checkOrderStatus: true }));
  assert.equal(calls.emit.length,      6);
  assert.equal(calls.markInProduction, 1);
  assert.equal(calls.markCompleted,    0);
}));

// ── Cleanup: restore require shim ────────────────────────────────────────────

test.after(() => { Module.prototype.require = __originalRequire; });
