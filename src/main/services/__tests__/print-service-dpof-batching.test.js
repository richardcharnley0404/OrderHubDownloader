'use strict';

/**
 * Tests for sendViaDPOFRouted's M3 batch-splitting behaviour
 * (docs/epson-batch-splitting-brief.md).
 *
 * Cover the M3 verification checklist plus the M1-review carry:
 *
 *   1. Under-cap (single batch) → exactly one writeOrderFolder call,
 *      nameOpts.batch is UNDEFINED. This is the "never 1of1 in the
 *      wild" invariant: buildFolderName must never see a batch
 *      descriptor when the job wasn't actually split, pinned at the
 *      dispatcher rather than the naming layer. (M1 review carry.)
 *   2. 40 prints qty 1 / cap 20 → 2 writeOrderFolder calls, each with
 *      nameOpts.batch = { index, total }. Folder names carry the
 *      _NofM discriminator so the two batches don't collide in the
 *      hot folder.
 *   3. Cap counts PRINTS, not images: 20 images × qty 3 / cap 20 → 3
 *      batches. Mirrors the DP invariant.
 *   4. Per-job prep (_readManifest / _findJobInManifest / enhanced /
 *      corrections / applyCorrections) runs exactly ONCE regardless
 *      of batch count. _applyCorrectionsToImageFiles WRITES corrected
 *      JPEGs to /working/; running it per-batch would do N× the disk
 *      churn for identical output.
 *   5. Ledger persisted after EVERY batch — not once at end. Snapshot
 *      the persisted store at the moment batch 2's writer is called
 *      and assert batch 1 is already recorded.
 *   6. Mid-loop write failure — batch 2 of 3 throws → ledger records
 *      batch 1 success + batch 2 error, job stamped errored naming
 *      1..1 landed vs 2..3 didn't, {success:false} returned. Neither
 *      _markCompleted nor _markInProduction fires.
 *   7. Banner sheet ON + split → generateBannerSheet called per
 *      batch with the batch descriptor, distinct filenames prevent
 *      the parallel-batches temp-path collision.
 *
 * Harness pattern: same as darkroom-pro-batching.test.js — monkey-patch
 * the print-service singleton's per-job prep helpers, stub
 * orderFolderWriter.writeOrderFolder (this is the DPOF equivalent of
 * the DP path's this._emitDarkroomProFile emitter seam), spy on
 * jobService.updateJobLocally so ledger writes are observable.
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

const printService       = require(path.join(__dirname, '..', 'print-service.js'));
const jobService         = require(path.join(__dirname, '..', 'job-service.js'));
const configService      = require(path.join(__dirname, '..', 'config-service.js'));
const routingService     = require(path.join(__dirname, '..', 'routing-service.js'));
const { orderFolderWriter } = require(path.join(__dirname, '..', 'order-folder-writer.js'));

// ── Harness ──────────────────────────────────────────────────────────────────

function withDpofBatchingHarness(fn) {
  return async (t) => {
    const orig = {
      readManifest:                 printService._readManifest,
      findJobInManifest:            printService._findJobInManifest,
      getEnhancedPathMap:           printService._getEnhancedPathMap,
      getCorrectionsMap:            printService._getCorrectionsMap,
      applyCorrectionsToImageFiles: printService._applyCorrectionsToImageFiles,
      markCompleted:                printService._markCompleted,
      markInProduction:             printService._markInProduction,
      writeOrderFolder:             orderFolderWriter.writeOrderFolder,
      configGet:                    configService.get,
      updateJobLocally:             jobService.updateJobLocally,
      getControllers:               routingService.getControllers,
      existsSync:                   require('fs').existsSync,
    };

    const calls = {
      readManifest:                 0,
      findJobInManifest:            0,
      getEnhancedPathMap:           0,
      getCorrectionsMap:            0,
      applyCorrectionsToImageFiles: 0,
      markCompleted:                0,
      markInProduction:             0,
      writes:                       [], // [{ outputPath, job, dpofContent, imageFiles, extra, nameOpts, snapshotAtEntry }]
      updateJobLocally:             [], // [{ jobId, updates }]
    };

    // In-memory job store — every updateJobLocally write is merged.
    const jobStore = new Map();

    configService.get             = (key) => (key === 'downloadDirectory' ? '/tmp/dl' : undefined);
    require('fs').existsSync      = () => true;
    routingService.getControllers = () => [{ id: 'CTRL-DPOF', name: 'Noritsu-1' }];

    printService._readManifest       = async () => { calls.readManifest++; return { jobs: [{ jobId: 42, images: [] }] }; };
    printService._findJobInManifest  = (manifest, _job) => { calls.findJobInManifest++; return manifest.jobs[0]; };
    printService._getEnhancedPathMap = async () => { calls.getEnhancedPathMap++; return new Map(); };
    printService._getCorrectionsMap  = async () => { calls.getCorrectionsMap++; return new Map(); };
    printService._applyCorrectionsToImageFiles = async (files) => { calls.applyCorrectionsToImageFiles++; return files; };
    printService._markCompleted      = async () => { calls.markCompleted++; };
    printService._markInProduction   = async () => { calls.markInProduction++; };

    // Default writer stub — records the call, returns a synthetic result.
    // Tests override for the failure case.
    orderFolderWriter.writeOrderFolder = async (outputPath, job, dpofContent, imageFiles, _extra, nameOpts) => {
      // Snapshot the persisted store at the moment this writer is entered —
      // supports the "ledger persisted after every batch" test (it reads
      // snapshotAtEntry for the second batch's call and asserts batch 1 is
      // already recorded).
      const snapshotAtEntry = JSON.parse(JSON.stringify(jobStore.get(job.id) || {}));
      const batch = nameOpts && nameOpts.batch;
      const folderName = batch
        ? `p${job.id}_${batch.index}of${batch.total}_folder`
        : `p${job.id}_folder`;
      calls.writes.push({
        outputPath,
        jobId:           job.id,
        dpofContent,
        imageFiles:      imageFiles.map(f => f.filename),
        nameOpts:        JSON.parse(JSON.stringify(nameOpts || {})),
        folderName,
        snapshotAtEntry,
      });
      return { folderPath: path.join(outputPath, folderName), folderName };
    };

    jobService.updateJobLocally = (jobId, updates) => {
      calls.updateJobLocally.push({ jobId, updates: JSON.parse(JSON.stringify(updates)) });
      const cur = jobStore.get(jobId) || {};
      jobStore.set(jobId, { ...cur, ...JSON.parse(JSON.stringify(updates)) });
    };

    t.after(() => {
      Object.assign(printService, orig);
      orderFolderWriter.writeOrderFolder = orig.writeOrderFolder;
      configService.get                  = orig.configGet;
      jobService.updateJobLocally        = orig.updateJobLocally;
      routingService.getControllers      = orig.getControllers;
      require('fs').existsSync           = orig.existsSync;
    });

    await fn(t, calls, jobStore);
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeJob() {
  return {
    id:            42,
    order_id:      'oid-42',
    order_number:  'PXTEST-XYZ',
    job_name:      'PXTEST-XYZ-1',
    product_code:  'P',
    customer_name: 'Alice B',
    options:       [],
  };
}

function makeRoute(overrides = {}) {
  return {
    type:                    'controller',
    controllerType:          'noritsu',
    controllerId:            'CTRL-DPOF',
    controllerName:          'Noritsu-1',
    outputPath:              '/hot',
    channelNumber:           '001',
    printSizeCode:           '6x4',
    checkOrderStatus:        true,
    maxPrintsPerJob:         null,
    bannerSheet:             false,
    includeCustomerInFolder: true,
    ...overrides,
  };
}

function images(n, qty = 1) {
  return Array.from({ length: n }, (_, i) => ({
    filename: `img-${i + 1}.jpg`,
    quantity: qty,
  }));
}

function stubImagesOnFindJob(imagesArr, calls) {
  printService._findJobInManifest = () => {
    if (calls) calls.findJobInManifest++;
    return { jobId: 42, images: imagesArr };
  };
}

// ── 1. Unsplit dispatch → nameOpts.batch UNDEFINED (M1 review carry) ─────────

test('cap null → single writeOrderFolder call, nameOpts.batch UNDEFINED, no ledger', withDpofBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(3, 1), calls);
  const result = await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: null }));

  assert.equal(calls.writes.length, 1);
  const w = calls.writes[0];
  // The heart of the M1 review carry — pinned at the dispatcher.
  assert.equal('batch' in w.nameOpts, false,
    'unsplit dispatch MUST NOT pass a batch descriptor to buildFolderName — no _1of1 in the wild');
  assert.equal(w.nameOpts.includeCustomerName, true);
  assert.equal(w.nameOpts.customerName,        'Alice B');

  // Return shape parity — no ledger, no batches on the unsplit path.
  assert.equal(result.success, true);
  assert.equal('batches' in result, false);
  assert.equal('ledger'  in result, false);

  // No ledger writes.
  const ledgerWrites = calls.updateJobLocally.filter(c => c.updates._batchLedger);
  assert.equal(ledgerWrites.length, 0, 'no ledger writes on unsplit dispatch');
  assert.equal(store.size, 0);
}));

test('cap 0 / cap negative → treated as feature-off, unsplit path (no batch descriptor)', withDpofBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(50, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 0 }));
  assert.equal(calls.writes.length, 1);
  assert.equal('batch' in calls.writes[0].nameOpts, false);

  calls.writes.length = 0;
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: -5 }));
  assert.equal(calls.writes.length, 1);
  assert.equal('batch' in calls.writes[0].nameOpts, false);
}));

// ── 2. 40 prints qty 1 / cap 20 → 2 batches with proper descriptors ──────────

test('cap 20, 40 × qty 1 → 2 writeOrderFolder calls, each with nameOpts.batch = {index,total}', withDpofBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(40, 1), calls);
  const result = await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));

  assert.equal(calls.writes.length, 2);
  assert.deepEqual(calls.writes[0].nameOpts.batch, { index: 1, total: 2 });
  assert.deepEqual(calls.writes[1].nameOpts.batch, { index: 2, total: 2 });

  // Folder names are distinct — matters because both land in the same hot folder.
  assert.notEqual(calls.writes[0].folderName, calls.writes[1].folderName);

  // Every image landed exactly once, order preserved, no image lost or duplicated.
  const allImagesAcrossBatches = calls.writes.flatMap(w => w.imageFiles);
  assert.equal(allImagesAcrossBatches.length, 40, 'no image lost or duplicated');
  assert.equal(new Set(allImagesAcrossBatches).size, 40, 'no duplicates');
  assert.equal(allImagesAcrossBatches[0],  'img-1.jpg',  'preserves manifest order');
  assert.equal(allImagesAcrossBatches[39], 'img-40.jpg', 'preserves manifest order');

  // Return shape carries batches + ledger on split.
  assert.equal(result.success, true);
  assert.equal(result.batches, 2);
  assert.ok(result.ledger);
  assert.equal(result.ledger.totalBatches, 2);
  assert.equal(result.ledger.totalPrints,  40);
  assert.equal(result.ledger.cap,          20);
  assert.equal(result.ledger.batches.length, 2);
  assert.ok(result.ledger.completedAt, 'completedAt stamped on all-batches-landed');

  // Lifecycle fired once.
  assert.equal(calls.markInProduction, 1);
  assert.equal(calls.markCompleted,    0);
}));

// ── 3. Cap counts PRINTS, not images ─────────────────────────────────────────

test('cap 20, 20 × qty 3 → 3 batches (cap counts prints, not images)', withDpofBatchingHarness(async (t, calls) => {
  // 60 total prints, cap 20 → splitIntoBatches partitions so no batch's
  // print count exceeds cap. Exact partition depends on splitter internals;
  // assert only the invariant: total prints preserved, no batch over cap.
  stubImagesOnFindJob(images(20, 3), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));

  assert.ok(calls.writes.length >= 3, `expected ≥3 batches for 60 prints @ cap 20, got ${calls.writes.length}`);
  const perBatchPrints = calls.writes.map(w => w.imageFiles.length * 3);
  assert.equal(perBatchPrints.reduce((a, b) => a + b, 0), 60, 'total prints preserved');
  for (const p of perBatchPrints) {
    assert.ok(p <= 20, `no batch may exceed cap: got ${p}`);
  }
}));

// ── 4. Per-job prep runs ONCE, not per batch ─────────────────────────────────

test('per-job prep (manifest / enhanced / corrections / applyCorrections) runs exactly ONCE regardless of batch count', withDpofBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(200, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));

  assert.equal(calls.readManifest,                 1, '_readManifest must not run per batch');
  assert.equal(calls.findJobInManifest,            1, '_findJobInManifest must not run per batch');
  assert.equal(calls.getEnhancedPathMap,           1, '_getEnhancedPathMap must not run per batch');
  assert.equal(calls.getCorrectionsMap,            1, '_getCorrectionsMap must not run per batch');
  assert.equal(calls.applyCorrectionsToImageFiles, 1, '_applyCorrectionsToImageFiles WRITES to /working/ — must not run per batch');
  assert.equal(calls.writes.length,               10, 'writer is the only per-batch call (200 / 20 = 10)');
}));

// ── 5. Ledger persisted after EVERY batch, not once at end ───────────────────

test('ledger is persisted after EVERY batch — at the moment batch 2 starts, batch 1 is already on disk', withDpofBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(40, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));

  assert.equal(calls.writes.length, 2);
  const secondCallSnapshot = calls.writes[1].snapshotAtEntry;
  assert.ok(secondCallSnapshot._batchLedger, 'batch 1 write must persist ledger before batch 2 starts');
  assert.equal(secondCallSnapshot._batchLedger.batches.length, 1, 'batch 1 is recorded before batch 2 attempts');
  assert.equal(secondCallSnapshot._batchLedger.batches[0].outcome, 'success');
  assert.equal(secondCallSnapshot._batchLedger.batches[0].index,   1);
}));

// ── 6. Mid-loop failure — batch 2 of 3 throws ────────────────────────────────

test('batch 2 of 3 throws → ledger records batch 1 success + batch 2 error, job errored, {success:false}, no lifecycle fires', withDpofBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(60, 1), calls);
  let callN = 0;
  orderFolderWriter.writeOrderFolder = async (outputPath, job, _dpof, imageFiles, _extra, nameOpts) => {
    callN++;
    const batch = nameOpts && nameOpts.batch;
    const folderName = batch ? `p${job.id}_${batch.index}of${batch.total}_folder` : `p${job.id}_folder`;
    calls.writes.push({ nameOpts, folderName, imageCount: imageFiles.length });
    if (callN === 2) throw new Error('ENOSPC: hot folder full');
    return { folderPath: path.join(outputPath, folderName), folderName };
  };

  const result = await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));

  // 2 writes attempted (1 succeeded, 2 threw); loop stopped after the throw.
  assert.equal(calls.writes.length, 2);

  // Return contract.
  assert.equal(result.success, false);
  assert.equal(result.batchesSucceeded, 1);
  assert.equal(result.batchesTotal,     3);
  assert.match(result.error, /batch 2\/3/i);
  assert.match(result.error, /Batches 1\.\.1 were written/i);
  assert.match(result.error, /batches 2\.\.3 did NOT/i);

  // Ledger reflects the truth: 1 success + 1 error.
  const stored = store.get(42);
  const ledger = stored._batchLedger;
  assert.ok(ledger);
  assert.equal(ledger.totalBatches, 3);
  assert.equal(ledger.batches.length, 2);
  assert.equal(ledger.batches[0].outcome, 'success');
  assert.equal(ledger.batches[0].index,   1);
  assert.equal(ledger.batches[1].outcome, 'error');
  assert.equal(ledger.batches[1].index,   2);
  assert.match(ledger.batches[1].error,   /ENOSPC/);
  assert.equal(ledger.completedAt, null, 'completedAt must not be set on partial failure');

  // Job stamped errored.
  assert.equal(stored._status, 'error');
  assert.match(stored._errorMessage, /DPOF batch 2\/3 failed/);

  // Neither lifecycle marker fires on partial failure — completion only
  // when every batch has succeeded.
  assert.equal(calls.markCompleted,    0);
  assert.equal(calls.markInProduction, 0);
}));

// ── 7. Banner sheet ON + split → per-batch banner with batch descriptor ──────

test('banner sheet ON + split → generateBannerSheet called per batch with the batch descriptor, distinct filenames', withDpofBatchingHarness(async (t, calls) => {
  // Stub banner-sheet-service via require.cache so print-service's inline
  // `require('../banner-sheet-service')` returns our stub. Also stub jimp
  // + fs.mkdir/writeFile so the banner code path can execute without
  // touching disk or loading native libvips bindings.
  const bannerCalls = [];
  const bannerModulePath = require.resolve(path.join(__dirname, '..', '..', 'banner-sheet-service.js'));
  const jimpModulePath   = require.resolve('jimp');
  const origBannerCache  = require.cache[bannerModulePath];
  const origJimpCache    = require.cache[jimpModulePath];

  require.cache[bannerModulePath] = {
    id:       bannerModulePath,
    filename: bannerModulePath,
    loaded:   true,
    exports:  {
      generateBannerSheet: async (jobCode, w, h, opts) => {
        bannerCalls.push({ jobCode, w, h, batch: (opts && opts.batch) || null });
        return Buffer.from('fake-banner');
      },
    },
  };
  require.cache[jimpModulePath] = {
    id:       jimpModulePath,
    filename: jimpModulePath,
    loaded:   true,
    exports:  {
      read: async () => ({ getWidth: () => 1800, getHeight: () => 1200 }),
    },
  };

  const origMkdir     = require('fs').promises.mkdir;
  const origWriteFile = require('fs').promises.writeFile;
  require('fs').promises.mkdir     = async () => {};
  require('fs').promises.writeFile = async () => {};

  t.after(() => {
    if (origBannerCache) require.cache[bannerModulePath] = origBannerCache;
    else                 delete require.cache[bannerModulePath];
    if (origJimpCache)   require.cache[jimpModulePath]   = origJimpCache;
    else                 delete require.cache[jimpModulePath];
    require('fs').promises.mkdir     = origMkdir;
    require('fs').promises.writeFile = origWriteFile;
  });

  stubImagesOnFindJob(images(40, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20, bannerSheet: true }));

  // Per-batch banner — one call per split batch, each carrying the batch
  // descriptor so the banner text reads `<jobCode>  (N of M)`.
  assert.equal(bannerCalls.length, 2);
  assert.deepEqual(bannerCalls[0].batch, { index: 1, total: 2 });
  assert.deepEqual(bannerCalls[1].batch, { index: 2, total: 2 });

  // First image in each writer call is the banner; distinct filenames so
  // the two batches don't collide on /working/BANNER*.JPG when written
  // concurrently by a future refactor.
  assert.equal(calls.writes.length, 2);
  const b1 = calls.writes[0].imageFiles[0];
  const b2 = calls.writes[1].imageFiles[0];
  assert.equal(b1, 'BANNER_1of2.JPG');
  assert.equal(b2, 'BANNER_2of2.JPG');
  assert.notEqual(b1, b2);

  // Banner should be batch 1's first image (unshifted at index 0), so the
  // batch's actual image list starts at index 1.
  assert.equal(calls.writes[0].imageFiles[1], 'img-1.jpg');
  assert.equal(calls.writes[1].imageFiles[1], 'img-21.jpg');
}));

// ── Banner sheet ON + UNSPLIT → BANNER.JPG unchanged from pre-M3 ─────────────

test('banner sheet ON + unsplit → plain BANNER.JPG filename, no batch descriptor on the banner', withDpofBatchingHarness(async (t, calls) => {
  const bannerCalls = [];
  const bannerModulePath = require.resolve(path.join(__dirname, '..', '..', 'banner-sheet-service.js'));
  const jimpModulePath   = require.resolve('jimp');
  const origBannerCache  = require.cache[bannerModulePath];
  const origJimpCache    = require.cache[jimpModulePath];

  require.cache[bannerModulePath] = {
    id: bannerModulePath, filename: bannerModulePath, loaded: true,
    exports: {
      generateBannerSheet: async (jobCode, w, h, opts) => {
        bannerCalls.push({ jobCode, w, h, batch: (opts && opts.batch) || null });
        return Buffer.from('fake-banner');
      },
    },
  };
  require.cache[jimpModulePath] = {
    id: jimpModulePath, filename: jimpModulePath, loaded: true,
    exports: { read: async () => ({ getWidth: () => 1800, getHeight: () => 1200 }) },
  };

  const origMkdir     = require('fs').promises.mkdir;
  const origWriteFile = require('fs').promises.writeFile;
  require('fs').promises.mkdir     = async () => {};
  require('fs').promises.writeFile = async () => {};

  t.after(() => {
    if (origBannerCache) require.cache[bannerModulePath] = origBannerCache;
    else                 delete require.cache[bannerModulePath];
    if (origJimpCache)   require.cache[jimpModulePath]   = origJimpCache;
    else                 delete require.cache[jimpModulePath];
    require('fs').promises.mkdir     = origMkdir;
    require('fs').promises.writeFile = origWriteFile;
  });

  stubImagesOnFindJob(images(5, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: null, bannerSheet: true }));

  // One banner call, no batch descriptor → banner text stays as the
  // pre-M3 orderCode.
  assert.equal(bannerCalls.length, 1);
  assert.equal(bannerCalls[0].batch, null);

  // Filename is plain BANNER.JPG — no _NofM suffix.
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].imageFiles[0], 'BANNER.JPG');
}));

// ── Lifecycle — checkOrderStatus === false marks completed instead ───────────

test('split success + checkOrderStatus false → _markCompleted fires (not _markInProduction)', withDpofBatchingHarness(async (t, calls) => {
  stubImagesOnFindJob(images(40, 1), calls);
  const route = makeRoute({ maxPrintsPerJob: 20, checkOrderStatus: false });
  const result = await printService.sendViaDPOFRouted(makeJob(), route);
  assert.equal(result.success, true);
  assert.equal(calls.markCompleted,    1);
  assert.equal(calls.markInProduction, 0);
}));

// ── M4: per-batch image storage on the ledger (resend source of truth) ───────

test('split success → each ledger entry carries its batch\'s image set (M4 resend contract)', withDpofBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(40, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));

  const stored = store.get(42);
  assert.ok(stored._batchLedger);
  const ledger = stored._batchLedger;
  assert.equal(ledger.batches.length, 2);

  // Batch 1 → images 1..20; batch 2 → images 21..40. Preserves input order.
  const b1Files = ledger.batches[0].images.map(im => im.filename);
  const b2Files = ledger.batches[1].images.map(im => im.filename);
  assert.equal(b1Files.length, 20);
  assert.equal(b2Files.length, 20);
  assert.equal(b1Files[0],  'img-1.jpg');
  assert.equal(b1Files[19], 'img-20.jpg');
  assert.equal(b2Files[0],  'img-21.jpg');
  assert.equal(b2Files[19], 'img-40.jpg');
  // Quantity carried too.
  for (const im of ledger.batches[0].images) assert.equal(im.quantity, 1);
}));

// ── M4: resendDpofBatch — happy path (previously-errored batch) ──────────────

test('resendDpofBatch: batch previously in error → writes one folder, resets ledger entry to success', withDpofBatchingHarness(async (t, calls, store) => {
  // Set up initial split dispatch where batch 2 fails.
  stubImagesOnFindJob(images(40, 1), calls);
  let firstPassCall = 0;
  orderFolderWriter.writeOrderFolder = async (outputPath, job, _dpof, imageFiles, _extra, nameOpts) => {
    firstPassCall++;
    const batch = nameOpts && nameOpts.batch;
    const folderName = batch ? `p${job.id}_${batch.index}of${batch.total}_folder` : `p${job.id}_folder`;
    const snapshotAtEntry = JSON.parse(JSON.stringify(store.get(job.id) || {}));
    calls.writes.push({ nameOpts: JSON.parse(JSON.stringify(nameOpts)), folderName, imageFiles: imageFiles.map(f => f.filename), snapshotAtEntry });
    if (firstPassCall === 2) throw new Error('ENOSPC hot folder full');
    return { folderPath: path.join(outputPath, folderName), folderName };
  };
  const firstResult = await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));
  assert.equal(firstResult.success, false);
  const ledgerAfterFirstPass = store.get(42)._batchLedger;
  assert.equal(ledgerAfterFirstPass.batches[1].outcome, 'error');
  assert.match(ledgerAfterFirstPass.batches[1].error, /ENOSPC/);

  // Reset writer to always-succeed for the resend pass.
  const resendWrites = [];
  orderFolderWriter.writeOrderFolder = async (outputPath, job, _dpof, imageFiles, _extra, nameOpts) => {
    const batch = nameOpts && nameOpts.batch;
    const folderName = batch ? `p${job.id}_${batch.index}of${batch.total}_resent` : `p${job.id}_resent`;
    resendWrites.push({ nameOpts: JSON.parse(JSON.stringify(nameOpts)), folderName, imageFiles: imageFiles.map(f => f.filename) });
    return { folderPath: path.join(outputPath, folderName), folderName };
  };

  // Wire the manifest lookup: printService.resendDpofBatch calls
  // findJobById to read the (now-stamped) job with its ledger.
  const jobFromStore = { ...makeJob(), ...(store.get(42) || {}) };
  jobService.findJobById = (id) => (String(id) === '42' ? jobFromStore : null);
  // resolveRoute must return the split route.
  const route = makeRoute({ maxPrintsPerJob: 20 });
  const routingService = require(path.join(__dirname, '..', 'routing-service.js'));
  const origResolveRoute = routingService.resolveRoute;
  routingService.resolveRoute = () => route;
  t.after(() => { routingService.resolveRoute = origResolveRoute; });

  const result = await printService.resendDpofBatch({ jobId: 42, batchIndex: 2 });
  assert.equal(result.success, true, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.batchIndex, 2);
  assert.equal(result.batchTotal, 2);
  assert.equal(result.folderName, 'p42_2of2_resent');

  // Exactly one write, for batch 2 with the ORIGINAL batch descriptor.
  assert.equal(resendWrites.length, 1);
  assert.deepEqual(resendWrites[0].nameOpts.batch, { index: 2, total: 2 });
  // Image set matches ledger's batch-2 images (imgs 21..40, no banner).
  assert.equal(resendWrites[0].imageFiles.length, 20);
  assert.equal(resendWrites[0].imageFiles[0],  'img-21.jpg');
  assert.equal(resendWrites[0].imageFiles[19], 'img-40.jpg');

  // Ledger entry now flipped back to success, error cleared, filename swapped.
  const ledgerAfterResend = store.get(42)._batchLedger;
  assert.equal(ledgerAfterResend.batches[1].outcome, 'success');
  assert.equal('error' in ledgerAfterResend.batches[1], false);
  assert.equal(ledgerAfterResend.batches[1].filename, 'p42_2of2_resent');
  // completedAt cleared (resend re-opens the pass).
  assert.equal(ledgerAfterResend.completedAt, null);
}));

// ── M4: resendDpofBatch — double-print guard on an already-accepted batch ────

test('resendDpofBatch: batch already at "e" (accepted) → refuses without `confirmed`, returns needsConfirm', withDpofBatchingHarness(async (t, calls, store) => {
  // Set up a completed split, then stamp batch 1 as accepted.
  stubImagesOnFindJob(images(40, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));
  const { recordBatchAccepted } = require(path.join(__dirname, '..', '..', '..', 'shared', 'batchLedger.js'));
  const ledger = store.get(42)._batchLedger;
  recordBatchAccepted(ledger, { index: 1, prefix: 'e' });
  recordBatchAccepted(ledger, { index: 2, prefix: 'e' });
  store.set(42, { ...store.get(42), _batchLedger: ledger });

  const jobFromStore = { ...makeJob(), ...(store.get(42) || {}) };
  jobService.findJobById = (id) => (String(id) === '42' ? jobFromStore : null);
  const routingService = require(path.join(__dirname, '..', 'routing-service.js'));
  const origResolveRoute = routingService.resolveRoute;
  routingService.resolveRoute = () => makeRoute({ maxPrintsPerJob: 20 });
  t.after(() => { routingService.resolveRoute = origResolveRoute; });

  // Track any writer calls — there must be NONE on the refused resend.
  const writesBeforeResend = calls.writes.length;

  const result = await printService.resendDpofBatch({ jobId: 42, batchIndex: 1 });
  assert.equal(result.success,      false);
  assert.equal(result.needsConfirm, true);
  assert.equal(result.batchIndex,   1);
  assert.equal(result.currentPrefix, 'e');
  // No new writer calls — the guard bailed before any I/O.
  assert.equal(calls.writes.length, writesBeforeResend, 'no write attempted when confirmation required');

  // With confirmed:true → proceeds.
  const result2 = await printService.resendDpofBatch({ jobId: 42, batchIndex: 1, opts: { confirmed: true } });
  assert.equal(result2.success, true);
  assert.equal(result2.batchIndex, 1);
}));

// ── M4: resendDpofBatch — validation & missing-image cases ───────────────────

test('resendDpofBatch: unknown jobId → success:false, no write', withDpofBatchingHarness(async (t, calls) => {
  jobService.findJobById = () => null;
  const result = await printService.resendDpofBatch({ jobId: 999, batchIndex: 1 });
  assert.equal(result.success, false);
  assert.match(result.error, /not found/i);
  assert.equal(calls.writes.length, 0);
}));

test('resendDpofBatch: job has no ledger → success:false (not a split dispatch)', withDpofBatchingHarness(async (t, calls) => {
  jobService.findJobById = () => ({ id: 42, order_number: 'X' });
  const result = await printService.resendDpofBatch({ jobId: 42, batchIndex: 1 });
  assert.equal(result.success, false);
  assert.match(result.error, /no batch ledger/i);
}));

test('resendDpofBatch: batch index out of range → success:false', withDpofBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(40, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));
  const jobFromStore = { ...makeJob(), ...(store.get(42) || {}) };
  jobService.findJobById = (id) => (String(id) === '42' ? jobFromStore : null);
  const result = await printService.resendDpofBatch({ jobId: 42, batchIndex: 99 });
  assert.equal(result.success, false);
  assert.match(result.error, /batch 99 not found/i);
}));

test('resendDpofBatch: ledger predates M4 (no images stored on entry) → refuses cleanly', withDpofBatchingHarness(async (t, calls, store) => {
  // Construct a pre-M4 ledger by manually building an entry with no images.
  const preM4Ledger = {
    cap: 20, totalBatches: 2, totalPrints: 40,
    startedAt: '2026-08-14T09:00:00.000Z', completedAt: null,
    batches: [
      { index: 1, total: 2, filename: 'p42_1of2', destPath: '/hot/p42_1of2', dispatchedAt: '2026-08-14T09:00:01.000Z', outcome: 'error', error: 'boom', acceptedAt: null, acceptedPrefix: null },
    ],
  };
  jobService.findJobById = () => ({ id: 42, order_number: 'X', _batchLedger: preM4Ledger });
  const result = await printService.resendDpofBatch({ jobId: 42, batchIndex: 1 });
  assert.equal(result.success, false);
  assert.match(result.error, /predates M4/i);
}));

test('resendDpofBatch: a stored image is missing from the current manifest → cleanly refuses naming the missing file(s)', withDpofBatchingHarness(async (t, calls, store) => {
  stubImagesOnFindJob(images(40, 1), calls);
  await printService.sendViaDPOFRouted(makeJob(), makeRoute({ maxPrintsPerJob: 20 }));

  // Rebuild jobFromStore, then swap findJobInManifest to return a shorter
  // manifest that no longer contains img-25.jpg.
  const jobFromStore = { ...makeJob(), ...(store.get(42) || {}) };
  jobService.findJobById = (id) => (String(id) === '42' ? jobFromStore : null);
  const routingService = require(path.join(__dirname, '..', 'routing-service.js'));
  const origResolveRoute = routingService.resolveRoute;
  routingService.resolveRoute = () => makeRoute({ maxPrintsPerJob: 20 });
  t.after(() => { routingService.resolveRoute = origResolveRoute; });

  const shortManifest = images(40, 1).filter(img => img.filename !== 'img-25.jpg');
  printService._findJobInManifest = () => ({ jobId: 42, images: shortManifest });

  const result = await printService.resendDpofBatch({ jobId: 42, batchIndex: 2 });
  assert.equal(result.success, false);
  assert.match(result.error, /no longer in the manifest/i);
  assert.match(result.error, /img-25\.jpg/);
}));
