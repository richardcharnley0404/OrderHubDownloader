'use strict';

/**
 * Integration tests for _sendViaFujiPicProOrderRouted (M4 of
 * docs/order-level-submission-picpro-brief.md).
 *
 * Same shape as print-service-reprint-fujipicpro.test.js —
 * require.cache stubs for the collaborating modules, then load the
 * live print-service and exercise the new method end-to-end.
 *
 * Pins from the brief §M4 test list:
 *   - two jobs with different printCodes produce one file with both
 *     `Code=` values in the right per-image positions;
 *   - NegNumber sequence continues across jobs (0001…000N);
 *   - one `stageImages` call for the whole group;
 *   - all member jobs marked in_production;
 *   - a staging failure errors every member and writes no `.txt`;
 *   - a group whose routes disagree on controller fails loudly.
 *
 * Plus the load-bearing "all-or-nothing" and rollback behaviours the
 * brief calls out as guardrails.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const fs      = require('node:fs');
const fsp     = require('node:fs/promises');
const os      = require('node:os');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Capture state ────────────────────────────────────────────────────────────

const __stageCalls               = [];
const __generateCalls            = [];
const __writeOrderFileCalls      = [];
const __markCompletedCalls       = [];
const __markInProductionCalls    = [];
const __startMonitoringCalls     = [];
const __enqueueCalls             = [];
const __markCommittedCalls       = [];
const __dequeueCalls             = [];
const __updateJobLocallyCalls    = [];
const __seqCalls                 = [];   // orderNumber -> id issued
let   __seqCounters              = {};   // orderNumber -> lastSeq
let   __stageThrows              = null;
let   __writeThrows              = null;
let   __enqueueThrows            = null;
let   __manifestOverride         = null;

function resetCaptures() {
  __stageCalls.length            = 0;
  __generateCalls.length         = 0;
  __writeOrderFileCalls.length   = 0;
  __markCompletedCalls.length    = 0;
  __markInProductionCalls.length = 0;
  __startMonitoringCalls.length  = 0;
  __enqueueCalls.length          = 0;
  __markCommittedCalls.length    = 0;
  __dequeueCalls.length          = 0;
  __updateJobLocallyCalls.length = 0;
  __seqCalls.length              = 0;
  __seqCounters                  = {};
  __stageThrows                  = null;
  __writeThrows                  = null;
  __enqueueThrows                = null;
  __manifestOverride             = null;
}

// ── Stubs via require.cache injection ───────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const fakeConfigService = {
  get:               (key) => key === 'downloadDirectory' ? __downloadRoot : undefined,
  getProcessMapping: () => ({}),
  getApiSettings:    () => ({ baseUrl: '', key: '' }),
};

const fakePrintControllerStore = {
  printControllerStore: {
    getController:     () => null,
    findChannelForJob: () => null,
    getAllControllers: () => [],
  },
};

const fakeRoutingService = {
  resolveRoute:         () => null,
  resolvePrintSizeCode: () => '',
  getRoutingHeldProcesses: () => new Set(),
  getControllers:       () => [],
};

const fakeJobService = {
  updateJobLocally: (jobId, patch) => {
    __updateJobLocallyCalls.push({ jobId, patch });
  },
  // Not reached by the order-level path, but stubs cheaply.
  markReceived:  async () => {},
  markCompleted: async () => {},
  findJobById:   () => undefined,
};

const fakePicProGenerator = {
  generateFujiPicProOrderFile: (job, controller) => {
    __generateCalls.push({ job, controller });
    // Return a fake contents string that embeds every image's
    // negNumber + Code so tests can assert on ordering / values.
    const body = job.images.map(img =>
      `NegNumber=${img.negNumber}\nCode=${img.printCode}\nColor=${img.color}\nQty=${img.quantity}\nBackprint1=${img.originalFilename || ''}\n`
    ).join('---\n');
    return {
      filename: `${job.orderId}.txt`,
      contents: `[order]\nOrderId=${job.orderId}\n---\n${body}`,
    };
  },
};

const fakePicProFileWriter = {
  stageImages: async (args) => {
    __stageCalls.push(args);
    if (__stageThrows) throw __stageThrows;
    return {
      stagingFolder: path.join(args.imageStagingRoot, args.orderId),
      negNumberMap:  args.imageFiles.map((img, i) => ({
        negNumber:        String(i + 1).padStart(4, '0'),
        sourcePath:       img.sourcePath,
        originalFilename: img.originalFilename || '',
        stagedName:       `${String(i + 1).padStart(4, '0')}.jpg`,
        stagedPath:       path.join(args.imageStagingRoot, args.orderId, `${String(i + 1).padStart(4, '0')}.jpg`),
      })),
    };
  },
  writeOrderFile: async (args) => {
    __writeOrderFileCalls.push(args);
    if (__writeThrows) throw __writeThrows;
    return { writtenPath: path.join(args.orderDataPath, args.filename) };
  },
  deliverToDigin:   async () => ({ destFolder: '', method: 'rename' }),
  writeCommandFile: async () => ({ writtenPath: '' }),
};

const fakePrintControllerService = {
  printControllerService: {
    startMonitoring: (controllerId) => { __startMonitoringCalls.push(controllerId); },
    getMonitor:      () => ({
      enqueueSubmission: (entry) => {
        __enqueueCalls.push(entry);
        if (__enqueueThrows) throw __enqueueThrows;
        return entry;
      },
      markCommitted: (orderId) => { __markCommittedCalls.push(orderId); },
      dequeue:       (orderId) => { __dequeueCalls.push(orderId); return true; },
    }),
  },
};

// The M3 module. Simple in-memory counter — matches the real API:
// nextSubmissionId returns the base (displayBase if supplied, else
// orderNumber) for the first call, then -2/-3… appended for
// subsequent calls sharing the same base. The counter is keyed on
// the base, NOT on the raw order number — this is the v1.12.2
// collision-prevention fix: two orders that strip to the same base
// MUST share a counter, otherwise both would issue the unsuffixed
// base and stageImages would rm -rf the first submission's folder.
const fakeOrderSubmissionSeq = {
  orderSubmissionSeq: {
    nextSubmissionId: (orderNumber, displayBase) => {
      __seqCalls.push({ orderNumber, displayBase });
      const base = (typeof displayBase === 'string' && displayBase.length > 0)
        ? displayBase
        : orderNumber;
      const key = base;
      const prev = __seqCounters[key] || 0;
      const next = prev + 1;
      __seqCounters[key] = next;
      return next === 1 ? base : `${base}-${next}`;
    },
    peek: (key) => {
      const lastSeq = __seqCounters[key] || null;
      return lastSeq
        ? { lastSeq, lastIssuedAt: '2026-01-01T00:00:00.000Z', lastId: lastSeq === 1 ? key : `${key}-${lastSeq}` }
        : null;
    },
  },
  OrderSubmissionSeq: function () {},
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'),               fakeConfigService);
stubInCache(path.join(SVC, 'print-controller-store.js'),       fakePrintControllerStore);
stubInCache(path.join(SVC, 'routing-service.js'),              fakeRoutingService);
stubInCache(path.join(SVC, 'job-service.js'),                  fakeJobService);
stubInCache(path.join(SVC, 'fuji-pic-pro-generator.js'),       fakePicProGenerator);
stubInCache(path.join(SVC, 'fuji-pic-pro-file-writer.js'),     fakePicProFileWriter);
stubInCache(path.join(SVC, 'print-controller-service.js'),     fakePrintControllerService);
stubInCache(path.join(SVC, 'order-submission-seq.js'),         fakeOrderSubmissionSeq);

const printService = require(path.join(SVC, 'print-service.js'));

// Sidestep sharp — corrections aren't the unit under test.
printService._applyCorrectionsToImageFiles = async (imageFiles) => imageFiles;

// Intercept lifecycle hooks so tests can assert on them.
printService._markCompleted    = async (jobId) => { __markCompletedCalls.push(jobId); };
printService._markInProduction = async (jobId) => { __markInProductionCalls.push(jobId); };

// Stub manifest-read helpers so we don't need on-disk manifests. The
// order-level method calls _readManifest ONCE per order — assert that
// too by counting invocations.
let __manifestReadCount = 0;
printService._readManifest = async (orderFolderPath, orderNumber) => {
  __manifestReadCount++;
  if (__manifestOverride === 'throw') {
    const err = new Error('fake manifest read error');
    throw err;
  }
  return __manifestOverride || DEFAULT_MANIFEST;
};
// Mirrors the real _findJobInManifest (print-service.js:3559-3581): find by
// job id AND apply the operator-discard filter (job._excludedFilenames).
// The stub has to do this because the whole exclusion-drop branch in
// _sendViaFujiPicProOrderRouted trips on the POST-filter images.length.
printService._findJobInManifest = (manifest, job) => {
  const found = manifest.jobs.find(j => String(j.id) === String(job.id));
  if (!found) return null;
  const excluded = job && job._excludedFilenames;
  if (!excluded || typeof excluded.size !== 'number' || excluded.size === 0) return found;
  return {
    ...found,
    images: (found.images || []).filter((img) => {
      const base = path.basename(img && img.filename ? img.filename : '');
      return !excluded.has(base);
    }),
  };
};
printService._getEnhancedPathMap = async () => new Map();
printService._getCorrectionsMap  = async () => new Map();

// ── Fixtures ────────────────────────────────────────────────────────────────

let __downloadRoot;

async function makeOrderFolder(orderNumber, orderId, jobIds) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pp-order-'));
  __downloadRoot = root;
  const orderFolder = path.join(root, `${orderNumber}_${orderId}`);
  await fsp.mkdir(orderFolder, { recursive: true });
  for (const jobId of jobIds) {
    const jobFolder = path.join(orderFolder, `${orderNumber}_${jobId}`);
    await fsp.mkdir(path.join(jobFolder, 'originals'), { recursive: true });
    await fsp.mkdir(path.join(jobFolder, 'working'),   { recursive: true });
    // Land the images in /originals/ so resolveDispatchImageSource
    // finds them via the third fallback (root and /working/ empty).
    // Mirrors the pipeline shape at dispatch time — the raw copy
    // sits in /originals/, /working/ holds the cropped set, and the
    // flat root is empty for a "no crop applied" case.
    await fsp.writeFile(path.join(jobFolder, 'originals', 'a.jpg'), 'fake-jpeg-a');
    await fsp.writeFile(path.join(jobFolder, 'originals', 'b.jpg'), 'fake-jpeg-b');
  }
  return root;
}

function makeJob(id, orderNumber, overrides = {}) {
  return {
    id,
    job_name:       `${orderNumber}-${id}`,
    order_number:   orderNumber,
    order_id:       'ord-1',
    product_code:   'PP4X6',
    process:        'Lab',
    options:        [{ name: 'finish', value: 'lustre' }],
    customer_name:  'Test Customer',
    customer_email: 'a@b.c',
    ...overrides,
  };
}

function picProRoute(overrides = {}) {
  return {
    type:                'controller',
    controllerType:      'fujipicpro',
    controllerId:        'CTRL-PP-1',
    controllerName:      'PIC Pro DL650',
    orderDataPath:       '\\\\Labserver1\\Order Data',
    diginPath:           '\\\\Labserver1\\DIGIN1',
    mergeDataPath:       '\\\\Labserver1\\Merge Data',
    imageStagingRoot:    'C:\\pp\\staging',
    gatewayTimeoutMs:    120000,
    buildTimeoutMs:      1800000,
    sendReleaseCommand:  true,
    backprintMode:       'text',
    backprintTemplate:   '{originalFilename}',
    backprintTemplate2:  '',
    includeCustomerName: false,
    surface:             'Lustre',
    surfaceCode:         'L',
    printCode:           '64',
    color:               'C',
    checkOrderStatus:    true,
    printSize:           '6x4',
    channelMappingId:    'cm-pp-1',
    ...overrides,
  };
}

// Default manifest — two jobs, two images each.
const DEFAULT_MANIFEST = {
  jobs: [
    { id: 101, images: [
      { filename: 'a.jpg', quantity: 2, originalFilename: 'A1.jpg' },
      { filename: 'b.jpg', quantity: 1, originalFilename: 'A2.jpg' },
    ] },
    { id: 102, images: [
      { filename: 'a.jpg', quantity: 3, originalFilename: 'B1.jpg' },
      { filename: 'b.jpg', quantity: 4, originalFilename: 'B2.jpg' },
    ] },
  ],
};

async function setupTwoJobGroup(t, options = {}) {
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = options.orderNumber || 'ORD-M4';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101, 102]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const items = [
    { job: makeJob(101, orderNumber), route: picProRoute({ printCode: '64', color: 'C' }) },
    { job: makeJob(102, orderNumber), route: picProRoute({ printCode: '77', color: 'B' }) },
  ];
  return { items, orderNumber };
}

// ── Brief case: two jobs with different printCodes → one file, both codes ──

test('two jobs with different printCodes produce ONE file with both Code= values in per-image position', async (t) => {
  const { items, orderNumber } = await setupTwoJobGroup(t);

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method,  'fujipicpro-order-routed');
  assert.equal(__writeOrderFileCalls.length, 1, 'exactly ONE .txt written for the whole order');
  assert.equal(__generateCalls.length,      1, 'exactly ONE generator invocation');

  const genJob = __generateCalls[0].job;
  assert.equal(genJob.orderId, orderNumber,
    'first submission for the order uses the unsuffixed order number as id');
  assert.equal(genJob.jobName, orderNumber);

  // Two images per job × 2 jobs = 4 images total.
  assert.equal(genJob.images.length, 4);

  // Per-image printCode: first 2 from job 101 (code 64), next 2 from job 102 (code 77).
  // The order-level concatenation preserves the caller's item order,
  // then per-job the manifest image order.
  assert.equal(genJob.images[0].printCode, '64', 'image 0 from job 101');
  assert.equal(genJob.images[1].printCode, '64', 'image 1 from job 101');
  assert.equal(genJob.images[2].printCode, '77', 'image 2 from job 102');
  assert.equal(genJob.images[3].printCode, '77', 'image 3 from job 102');

  // Per-image color follows the same per-job mapping.
  assert.equal(genJob.images[0].color, 'C');
  assert.equal(genJob.images[2].color, 'B');
});

// ── Brief case: NegNumber sequence continues across jobs ───────────────────

test('NegNumber sequence continues across the whole group (0001…000N, no per-job restart)', async (t) => {
  const { items } = await setupTwoJobGroup(t);

  const result = await printService._sendViaFujiPicProOrderRouted(items);
  const genJob = __generateCalls[0].job;

  assert.equal(genJob.images[0].negNumber, '0001');
  assert.equal(genJob.images[1].negNumber, '0002');
  assert.equal(genJob.images[2].negNumber, '0003',
    'sequence must continue into the next member — not restart at 0001');
  assert.equal(genJob.images[3].negNumber, '0004');

  // Same continuity reflected in the returned negNumberMap, plus the
  // per-frame jobId attribution for the audit log.
  assert.equal(result.negNumberMap.length, 4);
  assert.equal(result.negNumberMap[0].jobId, 101);
  assert.equal(result.negNumberMap[1].jobId, 101);
  assert.equal(result.negNumberMap[2].jobId, 102);
  assert.equal(result.negNumberMap[3].jobId, 102);
});

// ── Brief case: one stageImages call for the whole group ──────────────────

test('exactly ONE stageImages call for the whole group', async (t) => {
  const { items } = await setupTwoJobGroup(t);

  await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(__stageCalls.length, 1,
    'staging happens once per order, not once per member — that is what gives NegNumber continuity');
  assert.equal(__stageCalls[0].imageFiles.length, 4,
    'the concatenated image list reaches stageImages in one call');
});

test('manifest is read ONCE per order, not once per member', async (t) => {
  const { items } = await setupTwoJobGroup(t);

  await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(__manifestReadCount, 1,
    'the whole point of order-level dispatch is one _readManifest per order');
});

// ── Brief case: all member jobs marked in_production ───────────────────────

test('all member jobs are marked in_production (default checkOrderStatus)', async (t) => {
  const { items } = await setupTwoJobGroup(t);

  await printService._sendViaFujiPicProOrderRouted(items);

  assert.deepEqual(__markInProductionCalls.sort(), [101, 102]);
  assert.equal(__markCompletedCalls.length, 0);
});

test('checkOrderStatus === false marks every member completed immediately', async (t) => {
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = 'ORD-COS';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101, 102]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const items = [
    { job: makeJob(101, orderNumber), route: picProRoute({ printCode: '64', checkOrderStatus: false }) },
    { job: makeJob(102, orderNumber), route: picProRoute({ printCode: '77', checkOrderStatus: false }) },
  ];

  await printService._sendViaFujiPicProOrderRouted(items);

  assert.deepEqual(__markCompletedCalls.sort(),   [101, 102]);
  assert.equal(__markInProductionCalls.length, 0);
});

// ── Brief case: staging failure errors every member, no .txt written ───────

test('staging failure errors EVERY member with the same message and writes no .txt', async (t) => {
  const { items } = await setupTwoJobGroup(t);
  __stageThrows = new Error('fake staging error');

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, false);
  assert.match(result.error, /fake staging error/);
  assert.equal(__writeOrderFileCalls.length, 0,
    'no .txt must be written when staging failed');
  assert.equal(__markCommittedCalls.length, 0);

  // All members errored with the same message. Order-agnostic — the
  // guarantee is that every jobId got an error stamp, not any
  // particular one.
  const erroredJobIds = __updateJobLocallyCalls
    .filter(c => c.patch._status === 'error')
    .map(c => c.jobId)
    .sort();
  assert.deepEqual(erroredJobIds, [101, 102]);
  for (const call of __updateJobLocallyCalls) {
    assert.match(call.patch._errorMessage, /fake staging error/);
  }
});

// ── Brief case: routes disagree on controller → fail loudly ────────────────

test('group whose routes disagree on controllerId fails loudly, marks all errored, writes nothing', async (t) => {
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = 'ORD-DIS';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101, 102]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const items = [
    { job: makeJob(101, orderNumber), route: picProRoute({ controllerId: 'CTRL-A' }) },
    { job: makeJob(102, orderNumber), route: picProRoute({ controllerId: 'CTRL-B' }) },
  ];

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, false);
  assert.match(result.error, /controllerId/);
  assert.match(result.error, /disagree/);
  assert.equal(__stageCalls.length,          0, 'fails BEFORE staging');
  assert.equal(__writeOrderFileCalls.length, 0);
  assert.equal(__seqCalls.length,            0, 'no id must be allocated for a rejected group');

  const erroredJobIds = __updateJobLocallyCalls
    .filter(c => c.patch._status === 'error')
    .map(c => c.jobId)
    .sort();
  assert.deepEqual(erroredJobIds, [101, 102]);
});

test('group whose routes disagree on orderDataPath / diginPath / imageStagingRoot also fails', async (t) => {
  for (const field of ['orderDataPath', 'diginPath', 'imageStagingRoot']) {
    resetCaptures();
    __manifestReadCount = 0;
    const orderNumber = `ORD-${field.slice(0, 4).toUpperCase()}`;
    const root = await makeOrderFolder(orderNumber, 'ord-1', [101, 102]);

    const items = [
      { job: makeJob(101, orderNumber), route: picProRoute() },
      { job: makeJob(102, orderNumber), route: picProRoute({ [field]: '\\\\other\\path' }) },
    ];

    const result = await printService._sendViaFujiPicProOrderRouted(items);
    assert.equal(result.success, false, `disagreement on ${field} must fail`);
    assert.match(result.error, new RegExp(field));
    assert.equal(__stageCalls.length, 0);

    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('group whose members disagree on order_number fails loudly', async (t) => {
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = 'ORD-M';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const items = [
    { job: makeJob(101, 'ORD-A'), route: picProRoute() },
    { job: makeJob(102, 'ORD-B'), route: picProRoute() },
  ];

  const result = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(result.success, false);
  assert.match(result.error, /order_number/);
  assert.equal(__seqCalls.length, 0, 'no id allocated for a mismatched-order group');
});

// ── Missing printCode on any member ─────────────────────────────────────────

test('a member missing route.printCode errors the WHOLE group (all-or-nothing)', async (t) => {
  const { items } = await setupTwoJobGroup(t);
  items[1].route.printCode = '';   // second member missing

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, false);
  assert.match(result.error, /printCode/i);
  const erroredJobIds = __updateJobLocallyCalls
    .filter(c => c.patch._status === 'error')
    .map(c => c.jobId)
    .sort();
  assert.deepEqual(erroredJobIds, [101, 102],
    'the blast-radius message names every member, so the operator sees the whole group failed');
  assert.equal(__stageCalls.length, 0);
});

// ── Manifest read failure ───────────────────────────────────────────────────

test('a manifest read failure errors every member and never stages', async (t) => {
  const { items } = await setupTwoJobGroup(t);
  __manifestOverride = 'throw';

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, false);
  assert.match(result.error, /manifest/i);
  assert.equal(__stageCalls.length, 0);
  const erroredJobIds = __updateJobLocallyCalls
    .filter(c => c.patch._status === 'error')
    .map(c => c.jobId)
    .sort();
  assert.deepEqual(erroredJobIds, [101, 102]);
});

// ── Write failure rolls back enqueue via monitor.dequeue ───────────────────

test('write failure dequeues the monitor entry (Fix 11 rollback) and errors every member', async (t) => {
  const { items } = await setupTwoJobGroup(t);
  __writeThrows = new Error('fake write error');

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, false);
  assert.match(result.error, /fake write error/);
  assert.equal(__enqueueCalls.length, 1);
  assert.equal(__dequeueCalls.length, 1,
    'enqueue happened, then write failed — dequeue is the rollback');
  assert.equal(__markCommittedCalls.length, 0);

  const erroredJobIds = __updateJobLocallyCalls
    .filter(c => c.patch._status === 'error')
    .map(c => c.jobId)
    .sort();
  assert.deepEqual(erroredJobIds, [101, 102]);
});

// ── Enqueue failure never writes the .txt ──────────────────────────────────

test('enqueue failure never writes the .txt', async (t) => {
  const { items } = await setupTwoJobGroup(t);
  __enqueueThrows = new Error('fake enqueue error (duplicate orderId)');

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, false);
  assert.equal(__writeOrderFileCalls.length, 0,
    'refusing to write on enqueue failure — Fix 9');
  assert.equal(__markCommittedCalls.length, 0);
});

// ── Empty / malformed group ────────────────────────────────────────────────

test('empty group throws (caller bug, not runtime condition)', async () => {
  await assert.rejects(
    () => printService._sendViaFujiPicProOrderRouted([]),
    /empty group/,
  );
  await assert.rejects(
    () => printService._sendViaFujiPicProOrderRouted(null),
    /empty group/,
  );
});

test('malformed item (missing job or route) throws', async () => {
  await assert.rejects(
    () => printService._sendViaFujiPicProOrderRouted([{ job: makeJob(101, 'X') }]),
    /malformed group item/,
  );
});

// ── Order id from the persistent store — first unsuffixed, subsequent -N ──

test('the first submission for an order uses the unsuffixed order number as its id', async (t) => {
  const { items, orderNumber } = await setupTwoJobGroup(t);

  const result = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(result.orderId, orderNumber);
  assert.equal(__seqCalls[0].orderNumber, orderNumber, 'seq store consulted with the order number');
  assert.equal(__stageCalls[0].orderId, orderNumber,
    'stageImages folder is named for the order id (the rm -rf target)');
  assert.equal(__writeOrderFileCalls[0].filename, `${orderNumber}.txt`);
});

test('a subsequent late-arriver batch for the same order gets a -N suffix', async (t) => {
  const { items, orderNumber } = await setupTwoJobGroup(t);

  const first  = await printService._sendViaFujiPicProOrderRouted(items);
  const second = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(first.orderId,  orderNumber);
  assert.equal(second.orderId, `${orderNumber}-2`,
    'the counter increments — never reuse an id (rm -rf hazard)');
  assert.equal(__stageCalls[1].orderId, `${orderNumber}-2`,
    'the second staging folder is separate from the first');
});

// ── Empty-images guard (defence-in-depth) ──────────────────────────────────

test('a group whose members collectively have zero images refuses to dispatch', async (t) => {
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = 'ORD-EMPTY';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101, 102]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  __manifestOverride = {
    jobs: [
      { id: 101, images: [] },
      { id: 102, images: [] },
    ],
  };

  const items = [
    { job: makeJob(101, orderNumber), route: picProRoute() },
    { job: makeJob(102, orderNumber), route: picProRoute() },
  ];

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, false);
  assert.match(result.error, /no images/);
  assert.equal(__stageCalls.length,          0,
    'never dispatch an empty submission — the never-empty invariant is load-bearing');
  assert.equal(__writeOrderFileCalls.length, 0);
});

// ── Manifest quantity + originalFilename flow through concatenation ───────

test('per-image quantity + originalFilename come from the manifest, per member', async (t) => {
  const { items } = await setupTwoJobGroup(t);

  await printService._sendViaFujiPicProOrderRouted(items);

  const genJob = __generateCalls[0].job;
  assert.equal(genJob.images[0].quantity,         2, 'job 101 image 0 quantity');
  assert.equal(genJob.images[0].originalFilename, 'A1.jpg');
  assert.equal(genJob.images[1].quantity,         1);
  assert.equal(genJob.images[2].quantity,         3, 'job 102 image 0 quantity');
  assert.equal(genJob.images[2].originalFilename, 'B1.jpg');
  assert.equal(genJob.images[3].quantity,         4);
});

// ── Success path plumbs monitor + enqueue with the right shape ─────────────

// ── Operator-discard drop (all images excluded for a member) ───────────────

test('a member whose images are ALL excluded by the operator is dropped; other members dispatch', async (t) => {
  // Four-member group. One member has every image in _excludedFilenames.
  // Expected: the other three dispatch as one .txt, the excluded member's
  // status is deliberately untouched, and its printCode never appears
  // in the file.
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = 'ORD-EXC';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101, 102, 103, 104]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  __manifestOverride = {
    jobs: [
      { id: 101, images: [{ filename: 'a.jpg', quantity: 1, originalFilename: 'J1-A.jpg' }] },
      { id: 102, images: [{ filename: 'a.jpg', quantity: 2, originalFilename: 'J2-A.jpg' }] },
      // Job 103 has two images — both will be excluded by the operator.
      { id: 103, images: [
        { filename: 'a.jpg', quantity: 5, originalFilename: 'EXCLUDED-A.jpg' },
        { filename: 'b.jpg', quantity: 5, originalFilename: 'EXCLUDED-B.jpg' },
      ] },
      { id: 104, images: [{ filename: 'a.jpg', quantity: 3, originalFilename: 'J4-A.jpg' }] },
    ],
  };

  // Stamp job._excludedFilenames on member 103 as a non-enumerable
  // Set — same shape the IPC handler uses (ipc-handlers.js:604).
  const job103 = makeJob(103, orderNumber);
  Object.defineProperty(job103, '_excludedFilenames', {
    value:        new Set(['a.jpg', 'b.jpg']),
    enumerable:   false,
    configurable: true,
    writable:     false,
  });

  const items = [
    { job: makeJob(101, orderNumber), route: picProRoute({ printCode: '64' }) },
    { job: makeJob(102, orderNumber), route: picProRoute({ printCode: '77' }) },
    // Deliberately use a printCode that must not appear in the output —
    // if the exclusion-drop logic breaks and this member still contributes,
    // the assertion below on the generator's images catches it.
    { job: job103,                    route: picProRoute({ printCode: 'DROPPED-999' }) },
    { job: makeJob(104, orderNumber), route: picProRoute({ printCode: '88' }) },
  ];

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method,  'fujipicpro-order-routed');
  assert.deepEqual(result.activeJobIds,       [101, 102, 104]);
  assert.deepEqual(result.droppedByExclusion, [103],
    'member 103 was dropped by the exclusion filter');
  // memberJobIds still names the original group (auditability).
  assert.deepEqual(result.memberJobIds, [101, 102, 103, 104]);

  // Generator saw only the three active members.
  const genJob = __generateCalls[0].job;
  assert.equal(genJob.images.length, 3,
    'the excluded member contributes zero images to the .txt');
  const printCodesInFile = genJob.images.map(img => img.printCode);
  assert.deepEqual(printCodesInFile, ['64', '77', '88']);
  assert.equal(printCodesInFile.includes('DROPPED-999'), false,
    'the dropped member\'s printCode must never reach the .txt');

  // NegNumber sequences 0001…0003 across the 3 active members only.
  assert.equal(genJob.images[0].negNumber, '0001');
  assert.equal(genJob.images[1].negNumber, '0002');
  assert.equal(genJob.images[2].negNumber, '0003');

  // Lifecycle transitions apply only to the active members. Member 103
  // is deliberately absent — its status is left untouched for the
  // per-job path or the operator to handle.
  assert.deepEqual(__markInProductionCalls.sort(), [101, 102, 104]);
  assert.equal(__markCompletedCalls.length, 0);
  const touchedJobIds = __updateJobLocallyCalls.map(c => c.jobId);
  assert.equal(touchedJobIds.includes(103), false,
    'member 103 must have zero updateJobLocally calls — its status is untouched');
});

test('every member is fully excluded → no dispatch, no one errored, no staging', async (t) => {
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = 'ORD-ALL-EXC';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101, 102]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  __manifestOverride = {
    jobs: [
      { id: 101, images: [{ filename: 'a.jpg', quantity: 1, originalFilename: 'X.jpg' }] },
      { id: 102, images: [{ filename: 'a.jpg', quantity: 1, originalFilename: 'Y.jpg' }] },
    ],
  };

  const job101 = makeJob(101, orderNumber);
  const job102 = makeJob(102, orderNumber);
  for (const j of [job101, job102]) {
    Object.defineProperty(j, '_excludedFilenames', {
      value: new Set(['a.jpg']), enumerable: false, configurable: true, writable: false,
    });
  }

  const items = [
    { job: job101, route: picProRoute() },
    { job: job102, route: picProRoute() },
  ];

  const result = await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'all-members-excluded');
  assert.match(result.error, /excluded by the operator/i);

  // No dispatch happened: nothing staged, nothing written, no id
  // burnt through the seq store (allocation happens before the drop
  // decision but this test asserts on the DISPATCH outcome, not the
  // allocation — the id is consumed and the NEXT attempt will get -2,
  // which is the intended safe-side of the never-reuse guarantee).
  assert.equal(__stageCalls.length,          0);
  assert.equal(__writeOrderFileCalls.length, 0);
  assert.equal(__markCommittedCalls.length,  0);

  // Nobody's status was touched — no _markInProduction, no _markCompleted,
  // no error stamp. The operator's discard-everything action is not a
  // failure to attribute; the members will be revisited by the next
  // auto-print pass or by manual Process.
  assert.equal(__markInProductionCalls.length, 0);
  assert.equal(__markCompletedCalls.length,    0);
  assert.equal(__updateJobLocallyCalls.length, 0,
    'no jobs must be errored — the exclusion is an operator action, not a dispatch failure');
});

// ── Success path plumbs monitor + enqueue with the right shape ─────────────

test('successful dispatch enqueues + markCommitted in the correct order', async (t) => {
  const { items, orderNumber } = await setupTwoJobGroup(t);

  await printService._sendViaFujiPicProOrderRouted(items);

  assert.equal(__startMonitoringCalls[0], 'CTRL-PP-1');
  assert.equal(__enqueueCalls.length, 1);
  assert.equal(__enqueueCalls[0].orderId,      orderNumber);
  assert.equal(__enqueueCalls[0].orderRef,     orderNumber);
  assert.equal(__enqueueCalls[0].controllerId, 'CTRL-PP-1');
  assert.equal(__markCommittedCalls[0], orderNumber,
    'markCommitted follows a successful write');
  // Ordering: enqueue before write, write before markCommitted — the
  // fix 11 shape carried over into the order-level method.
  assert.ok(__enqueueCalls.length === 1);
  assert.ok(__writeOrderFileCalls.length === 1);
  assert.ok(__markCommittedCalls.length === 1);
});

// ── stripOrderNumberPrefix — v1.13.0 ────────────────────────────────────────
//
// Per-controller Strip Order Number Prefix on a Fuji PIC Pro
// controller. All three consumers of `orderId` — the staging folder
// (stageImages), the .txt filename (via the generator), and the enqueue
// orderId that drives DIGIN delivery — MUST see the same value.
// Divergence breaks the OrderGateway handshake (the .txt names one
// folder and the images end up in another). The tests below assert
// all three in the same call so a future refactor that pipes any of
// them from a different source blows up loudly.
//
// The pure `stripOrderNumberPrefix` helper is covered in
// printUtils.test.js; the `nextSubmissionId(orderNumber, displayBase)`
// invariant is covered in order-submission-seq.test.js. These tests
// pin the end-to-end wiring.

function stripAllThree(result, expectedId) {
  // Assert every plumbing carries the same orderId.
  assert.equal(result.orderId,                              expectedId, 'result.orderId');
  assert.equal(__generateCalls[0].job.orderId,              expectedId, 'generator was told orderId');
  assert.equal(__stageCalls[0].orderId,                     expectedId, 'stageImages folder = {imageStagingRoot}/{orderId}');
  assert.equal(__enqueueCalls[0].orderId,                   expectedId, 'enqueue orderId — the monitor uses this to build the DIGIN folder path');
  assert.equal(__writeOrderFileCalls[0].filename,           `${expectedId}.txt`, 'writeOrderFile filename');
  assert.equal(__markCommittedCalls[0],                     expectedId, 'markCommitted also names the same id');
}

test('stripOrderNumberPrefix: no prefix set → id is the full order number (default behaviour)', async (t) => {
  const { items, orderNumber } = await setupTwoJobGroup(t);
  // picProRoute() default does not set stripOrderNumberPrefix — verify
  // the field is absent on the route and the resulting id is untouched.
  assert.equal(items[0].route.stripOrderNumberPrefix, undefined,
    'the test fixture defaults to no prefix — this is the byte-identical-when-off contract');

  const result = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  stripAllThree(result, orderNumber);
});

test('stripOrderNumberPrefix: matching leading prefix → id has the prefix stripped in all three plumbings', async (t) => {
  const { items } = await setupTwoJobGroup(t, { orderNumber: 'PXDEMO-M6-A' });
  for (const it of items) it.route.stripOrderNumberPrefix = 'PXDEMO-';

  const result = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  // Order number was "PXDEMO-M6-A"; stripped id is "M6-A". All three
  // plumbings carry the stripped form — that is the load-bearing
  // OrderGateway-handshake invariant.
  stripAllThree(result, 'M6-A');

  // The counter is keyed on displayBase — uniqueness of the RETURNED
  // id is what matters (that string names the staging folder, the
  // .txt and the DIGIN folder). Two raw orders stripping to the same
  // base MUST share a counter; that shared-counter guarantee is
  // covered directly in the M3 unit tests. Here just verify what the
  // caller (print-service) passes to nextSubmissionId.
  assert.equal(__seqCalls[0].orderNumber, 'PXDEMO-M6-A',
    'orderNumber arg is the raw value from the manifest');
  assert.equal(__seqCalls[0].displayBase, 'M6-A',
    'displayBase arg is the post-strip form — used both for the returned id AND as the counter key');
});

test('stripOrderNumberPrefix: prefix set but not matching → id is the full order number', async (t) => {
  // Order number does not start with the prefix — stripping is a no-op.
  const { items, orderNumber } = await setupTwoJobGroup(t, { orderNumber: 'DIVPRINTS-99' });
  for (const it of items) it.route.stripOrderNumberPrefix = 'PXDEMO-';

  const result = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(result.success, true);
  stripAllThree(result, orderNumber);
});

test('stripOrderNumberPrefix: prefix equal to the whole order number → NOT stripped (never empty)', async (t) => {
  // Would strip to '' — which would name folders '' and break every
  // filesystem operation. The stripping helper refuses; verify that
  // refusal reaches the dispatch id.
  const { items, orderNumber } = await setupTwoJobGroup(t, { orderNumber: 'PXDEMO-' });
  for (const it of items) it.route.stripOrderNumberPrefix = 'PXDEMO-';

  const result = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(result.success, true);
  // The id is the FULL order number, not empty.
  stripAllThree(result, orderNumber);
  assert.equal(result.orderId, 'PXDEMO-',
    'never-strip-to-empty guardrail must be honoured at dispatch time');
});

test('stripOrderNumberPrefix: suffixed resubmission — the -N suffix is appended to the stripped base', async (t) => {
  // Dispatch twice; the second call must get -2 on the STRIPPED form,
  // and every plumbing must carry it consistently. The M3 counter is
  // still keyed on the raw order number so a fresh dispatch after this
  // (for a different raw order that strips to the same base) would
  // start from 1 again — covered in the M3 unit tests.
  const { items } = await setupTwoJobGroup(t, { orderNumber: 'PXDEMO-Q9' });
  for (const it of items) it.route.stripOrderNumberPrefix = 'PXDEMO-';

  const first = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(first.success, true);
  stripAllThree(first, 'Q9');

  // Reset per-call captures BUT NOT the seq counter — that's the whole
  // point of the persistent counter across attempts.
  __stageCalls.length          = 0;
  __generateCalls.length       = 0;
  __writeOrderFileCalls.length = 0;
  __enqueueCalls.length        = 0;
  __markCommittedCalls.length  = 0;

  const second = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(second.success, true);
  stripAllThree(second, 'Q9-2');
});

test('stripOrderNumberPrefix: case-insensitive match — casing of the tail is preserved', async (t) => {
  // Lowercase order number, uppercase prefix — match still fires and
  // the tail keeps its original casing (matches the pure-helper
  // contract in printUtils.test.js).
  const { items } = await setupTwoJobGroup(t, { orderNumber: 'pxdemo-AbC9' });
  for (const it of items) it.route.stripOrderNumberPrefix = 'PXDEMO-';

  const result = await printService._sendViaFujiPicProOrderRouted(items);
  assert.equal(result.success, true);
  stripAllThree(result, 'AbC9');
});

// ── Single-job dispatch: unique id fallback when job_name is blank ─────────
//
// Guards `_sendViaFujiPicProRouted` (the mergeOrderJobs-OFF path) against
// two jobs of one order both falling back to bare `order_number` for their
// orderId. That id names the staging folder; stageImages rm -rf's it before
// staging. If two jobs collide on the id, the second dispatch wipes the
// first's staged images before OrderGateway has delivered them — one blank
// order at the printer and one good one. The fallback shape
// `${order_number}_${id}` is what Darkroom Pro's dispatcher already uses at
// print-service.js:2003 for exactly this reason.
//
// In production every OrderHub API response observed populates job_name
// (cache surveyed 2026-08-14: 517/517 populated across 60 multi-job
// orders), so this is a defensive fix. The test locks the guarantee in.

test('single-job dispatch: two jobs of one order with blank job_name get DIFFERENT orderIds — no staging-folder collision', async (t) => {
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = 'ORD-BLANK-JN';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101, 102]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Two jobs, same order_number, DIFFERENT ids, BOTH with blank job_name.
  // Old fallback (`job.job_name || job.order_number`) would give both the
  // same orderId = 'ORD-BLANK-JN' and stageImages would rm -rf the first
  // submission's folder. New fallback (`${order_number}_${id}`) is
  // unique per job.
  const jobA = makeJob(101, orderNumber, { job_name: '' });
  const jobB = makeJob(102, orderNumber, { job_name: '' });
  const route = picProRoute();

  const resA = await printService._sendViaFujiPicProRouted(jobA, route);
  const resB = await printService._sendViaFujiPicProRouted(jobB, route);

  assert.equal(resA.success, true, `job A dispatch failed: ${resA.error}`);
  assert.equal(resB.success, true, `job B dispatch failed: ${resB.error}`);

  // Two staging calls, two DIFFERENT orderIds. The load-bearing
  // assertion — without the fix, both would be 'ORD-BLANK-JN' and this
  // would fail with "expected ORD-BLANK-JN_101 !== ORD-BLANK-JN_102".
  assert.equal(__stageCalls.length, 2, 'both dispatches reached stageImages');
  const stagedIds = __stageCalls.map(c => c.orderId);
  assert.notEqual(stagedIds[0], stagedIds[1],
    'staging folder names must be unique per job — otherwise rm -rf wipes the first submission');
  assert.equal(stagedIds[0], `${orderNumber}_101`, 'job A id follows the Darkroom Pro-style fallback');
  assert.equal(stagedIds[1], `${orderNumber}_102`, 'job B id follows the same shape with its own job.id');

  // Consistency across the three plumbings — same check the strip tests
  // above make. If the id ever diverges between staging / .txt / enqueue
  // the OrderGateway handshake breaks.
  assert.equal(__writeOrderFileCalls[0].filename, `${orderNumber}_101.txt`);
  assert.equal(__writeOrderFileCalls[1].filename, `${orderNumber}_102.txt`);
  assert.equal(__enqueueCalls[0].orderId,         `${orderNumber}_101`);
  assert.equal(__enqueueCalls[1].orderId,         `${orderNumber}_102`);
});

test('single-job dispatch: populated job_name still wins over the fallback (regression guard)', async (t) => {
  // The fallback fires only when job_name is blank. If OrderHub returns
  // a real job_name (the 100% path in production), it must still drive
  // the orderId — not the new `${order_number}_${id}` shape.
  resetCaptures();
  __manifestReadCount = 0;
  const orderNumber = 'ORD-NAMED';
  const root = await makeOrderFolder(orderNumber, 'ord-1', [101]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const job = makeJob(101, orderNumber);   // job_name defaults to 'ORD-NAMED-101' via makeJob
  const res = await printService._sendViaFujiPicProRouted(job, picProRoute());

  assert.equal(res.success, true);
  assert.equal(__stageCalls[0].orderId, 'ORD-NAMED-101',
    'populated job_name is the orderId — fallback is only used when job_name is blank');
});
