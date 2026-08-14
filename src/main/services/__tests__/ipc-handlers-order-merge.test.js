'use strict';

/**
 * Integration tests for the M5 auto-print pre-pass:
 * _runFujiPicProOrderMergePass in src/main/ipc-handlers.js.
 *
 * Coverage from docs/order-level-submission-picpro-brief.md §M5 test list:
 *   - A fully-eligible order dispatches once with all members.
 *   - A partially-eligible order does not dispatch and stamps
 *     _orderMergeHeldSince on the eligible members only.
 *   - Past the cap it dispatches the eligible subset; log the stragglers.
 *   - The same order with the setting OFF takes the per-job path
 *     unchanged (byte-identical to today).
 *   - A non-PIC-Pro controller is never grouped.
 *
 * Plus per the brief update (2026-08-14):
 *   - A NaN / unparseable _orderMergeHeldSince re-stamps to now rather
 *     than passing NaN through evaluateOrderGroup (which would skip
 *     the cap check and wait forever — the outcome decision 1 rules
 *     out).
 *
 * Plus load-bearing edge cases:
 *   - Manifest read failure defers the group (no dispatch, no crash).
 *   - Successful dispatch clears _orderMergeHeldSince on active members
 *     so the next late-arriver group starts a fresh clock.
 *
 * Stub shape mirrors ipc-handlers-auto-print.test.js: require.cache
 * injection for services + Module.prototype.require intercept for
 * electron / electron-store, then exercise via the exported _runAutoPrint
 * test hook.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');
const MAIN = path.join(REPO, 'src', 'main');

// ── Mutable test state ─────────────────────────────────────────────────────

let __jobs = [];
let __controllers = [];
let __routeByJobId = new Map();
let __updateCalls = [];
let __manifestByOrderNumber = new Map();
let __manifestThrowByOrderNumber = new Map();
let __orderDispatchCalls = [];       // args passed to _sendViaFujiPicProOrderRouted
let __orderDispatchResults = [];     // one per call
let __singleJobDispatchCalls = [];   // args passed to sendViaDPOFRouted

function resetState() {
  __jobs = [];
  __controllers = [];
  __routeByJobId = new Map();
  __updateCalls = [];
  __manifestByOrderNumber = new Map();
  __manifestThrowByOrderNumber = new Map();
  __orderDispatchCalls = [];
  __orderDispatchResults = [];
  __singleJobDispatchCalls = [];
}

// ── Stubs ──────────────────────────────────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
};

const fakeJobService = {
  getLocalJobs: () => ({ jobs: __jobs }),
  updateJobLocally: (jobId, updates) => {
    __updateCalls.push({ jobId, updates });
    const idx = __jobs.findIndex(j => j.id === jobId);
    if (idx !== -1) __jobs[idx] = { ...__jobs[idx], ...updates };
  },
  findJobByOrderNumber: () => null,
  markCompleted: async () => ({}),
};

const fakeRoutingService = {
  getControllers: () => __controllers,
  resolveRoute:   (job) => __routeByJobId.get(job.id) || { type: 'unrouted' },
  getRoutingHeldProcesses: () => new Set(),
};

const fakeConfigService = {
  get: (key) => {
    if (key === 'jobDateRange')      return 365;
    if (key === 'aiQualityEnabled')  return false;
    if (key === 'downloadDirectory') return '/tmp/download';
    return undefined;
  },
};

const fakePrintService = {
  sendViaDPOFRouted: async (job, route) => {
    __singleJobDispatchCalls.push({ jobId: job.id, controllerType: route.controllerType });
    return { success: true, method: route.controllerType || 'dpof' };
  },
  _sendViaFujiPicProOrderRouted: async (items) => {
    __orderDispatchCalls.push({ items: items.map(it => ({ jobId: it.job.id, printCode: it.route.printCode })) });
    const preplanned = __orderDispatchResults.shift();
    if (preplanned) return preplanned;
    // Default: success with every member active.
    return {
      success:            true,
      method:             'fujipicpro-order-routed',
      orderId:            items[0].job.order_number,
      memberJobIds:       items.map(it => it.job.id),
      activeJobIds:       items.map(it => it.job.id),
      droppedByExclusion: [],
    };
  },
  _readManifest: async (orderFolderPath, orderNumber) => {
    if (__manifestThrowByOrderNumber.has(orderNumber)) {
      throw new Error(__manifestThrowByOrderNumber.get(orderNumber));
    }
    return __manifestByOrderNumber.get(orderNumber) || { jobs: [] };
  },
};

function FakeStore() {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
    delete: (k)    => { delete data[k]; },
  };
}

stubInCache(path.join(SVC,  'config-service.js'),                    fakeConfigService);
stubInCache(path.join(SVC,  'logger.js'),                            noopLogger);
stubInCache(path.join(SVC,  'job-service.js'),                       fakeJobService);
stubInCache(path.join(SVC,  'print-service.js'),                     fakePrintService);
stubInCache(path.join(SVC,  'routing-service.js'),                   fakeRoutingService);
stubInCache(path.join(SVC,  's3-service.js'),                        {});
stubInCache(path.join(SVC,  'test-print-controller.js'),             { runTest: async () => ({}) });
stubInCache(path.join(SVC,  'print-controller-store.js'),            { printControllerStore: { get: () => [], set: () => {} } });
stubInCache(path.join(SVC,  'process-folder-service.js'),            {});
stubInCache(path.join(SVC,  'frame-metadata-store.js'),              {});
stubInCache(path.join(SVC,  'film-review-prefs-store.js'),           {});
stubInCache(path.join(SVC,  'folder-watch-service.js'),              {});
stubInCache(path.join(SVC,  'job-download-service.js'),              { checkLocalFiles: () => ({ found: true, localPath: '/tmp/x' }) });
stubInCache(path.join(SVC,  'ai-job-quality-orchestrator.js'),       { scoreJob: async () => ({ ok: true, held: false }) });
stubInCache(path.join(SVC,  'ai-quality-store.js'),                  { getJobQuality: async () => [], deriveHeld: () => false });
stubInCache(path.join(MAIN, 'updater.js'),                           { setMainWindow: () => {}, startUpdateSchedule: () => {} });

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      ipcMain:       { handle: () => {}, on: () => {} },
      dialog:        { showOpenDialog: async () => ({ canceled: true }) },
      app:           { getVersion: () => 'm5-test', getPath: () => '/' },
      BrowserWindow: function () {},
      shell:         { openExternal: async () => {} },
    };
  }
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

const { _runAutoPrint } = require(path.join(MAIN, 'ipc-handlers.js'));

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeJob(id, orderNumber, overrides = {}) {
  return {
    id,
    order_number:  orderNumber,
    order_id:      'ord-1',
    job_name:      `${orderNumber}-${id}`,
    process:       'Lab',
    product_code:  'PP4X6',
    options:       [],
    customer_name: 'Test',
    created_at:    new Date().toISOString(),
    _status:       'received',
    ...overrides,
  };
}

function picProRoute(overrides = {}) {
  return {
    type:               'controller',
    controllerType:     'fujipicpro',
    controllerId:       'CTRL-PP',
    controllerName:     'PIC Pro DL650',
    orderDataPath:      '\\\\Labserver\\Order Data',
    diginPath:          '\\\\Labserver\\DIGIN1',
    mergeDataPath:      '\\\\Labserver\\Merge Data',
    imageStagingRoot:   'C:\\pp\\staging',
    printCode:          '64',
    printSize:          '6x4',
    color:              'C',
    surface:            'Lustre',
    checkOrderStatus:   true,
    skipAutoPrint:      false,
    ...overrides,
  };
}

function picProController(overrides = {}) {
  return {
    id:                    'CTRL-PP',
    name:                  'PIC Pro DL650',
    type:                  'fujipicpro',
    mergeOrderJobs:        true,
    orderMergeWaitMinutes: 30,
    autoprint:             true,
    ...overrides,
  };
}

// ── Brief test 1: fully-eligible order → dispatches once with all members ─

test('fully-eligible order dispatches ONCE with all members via _sendViaFujiPicProOrderRouted', async () => {
  resetState();
  const orderNumber = 'ORD-FE';
  __jobs = [
    makeJob(101, orderNumber),
    makeJob(102, orderNumber),
    makeJob(103, orderNumber),
  ];
  __controllers = [picProController()];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute({ printCode: String(60 + j.id) }));
  __manifestByOrderNumber.set(orderNumber, { jobs: [{ jobId: 101 }, { jobId: 102 }, { jobId: 103 }] });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 1,
    'exactly one order-level dispatch for a fully-eligible bucket');
  assert.deepEqual(
    __orderDispatchCalls[0].items.map(i => i.jobId).sort(),
    [101, 102, 103],
  );
  assert.equal(__singleJobDispatchCalls.length, 0,
    'the per-job path must NOT dispatch merge-eligible jobs (would bypass order-level semantics)');
});

// ── Brief test 2: partially-eligible order → NO dispatch, stamps stamp ────

test('partially-eligible order does not dispatch and stamps _orderMergeHeldSince on eligible members', async () => {
  resetState();
  const orderNumber = 'ORD-PE';
  __jobs = [
    makeJob(101, orderNumber),
    makeJob(102, orderNumber),
    makeJob(103, orderNumber),   // will be missing from manifest siblings — blocks the group
    makeJob(104, orderNumber, { _awaitingManifest: true }),   // ineligible (per-job gate)
  ];
  __controllers = [picProController()];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set(orderNumber, {
    // 4 siblings listed, but 105 is missing from local — blocks readiness.
    jobs: [{ jobId: 101 }, { jobId: 102 }, { jobId: 103 }, { jobId: 104 }, { jobId: 105 }],
  });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 0, 'nothing dispatched — group not ready');

  // Eligible members (101, 102, 103) got stamps. 104 (_awaitingManifest) did not.
  const stampedIds = __updateCalls
    .filter(c => c.updates._orderMergeHeldSince)
    .map(c => c.jobId).sort();
  assert.deepEqual(stampedIds, [101, 102, 103],
    'only ELIGIBLE members carry the merge stamp; per-job-held members do not');
  const nonStampedIds = [104];
  for (const id of nonStampedIds) {
    assert.equal(
      __updateCalls.some(c => c.jobId === id && c.updates._orderMergeHeldSince),
      false,
      `job ${id} must not be stamped (it was held by its own gate, not by merging)`,
    );
  }
});

// ── Brief test 3: past the cap → dispatches eligible subset, logs stragglers

test('past the cap → dispatches the eligible subset; the group has been stamped long enough for the cap to elapse', async () => {
  resetState();
  const orderNumber = 'ORD-CAP';
  // Stamp two members 60 minutes ago; the cap is 30 minutes → past cap.
  const capMs   = 30 * 60 * 1000;
  const longAgo = new Date(Date.now() - (capMs * 2)).toISOString();
  __jobs = [
    makeJob(101, orderNumber, { _orderMergeHeldSince: longAgo }),
    makeJob(102, orderNumber, { _orderMergeHeldSince: longAgo }),
    // 103 is listed in the manifest but has no local record — the missing
    // straggler.
  ];
  __controllers = [picProController({ orderMergeWaitMinutes: 30 })];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set(orderNumber, {
    jobs: [{ jobId: 101 }, { jobId: 102 }, { jobId: 103 }],
  });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 1,
    'cap expired → the eligible subset dispatches even though a manifest sibling is missing');
  assert.deepEqual(
    __orderDispatchCalls[0].items.map(i => i.jobId).sort(),
    [101, 102],
  );

  // Post-dispatch stamp clear: the fake _sendViaFujiPicProOrderRouted
  // returns activeJobIds; the pre-pass clears _orderMergeHeldSince on
  // each so the next late-arriver group starts a fresh clock.
  const clearCalls = __updateCalls
    .filter(c => c.updates._orderMergeHeldSince === null)
    .map(c => c.jobId).sort();
  assert.deepEqual(clearCalls, [101, 102]);
});

// ── Brief test 4: setting OFF → per-job path unchanged ────────────────────

test('setting OFF (mergeOrderJobs=false) → jobs take the per-job path, never grouped', async () => {
  resetState();
  const orderNumber = 'ORD-OFF';
  __jobs = [
    makeJob(101, orderNumber),
    makeJob(102, orderNumber),
  ];
  __controllers = [picProController({ mergeOrderJobs: false })];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set(orderNumber, { jobs: [{ jobId: 101 }, { jobId: 102 }] });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 0,
    'order-level dispatch must NEVER run when the setting is off');
  assert.equal(__singleJobDispatchCalls.length, 2,
    'both jobs take the per-job path exactly as they would without this feature');
  const perJobIds = __singleJobDispatchCalls.map(c => c.jobId).sort();
  assert.deepEqual(perJobIds, [101, 102]);
});

// ── Brief test 5: non-PIC-Pro controller is never grouped ──────────────────

test('a non-PIC-Pro controller is never grouped, even if a controller with mergeOrderJobs exists', async () => {
  resetState();
  // Two controllers: a PIC Pro with merge on (no jobs routed to it) and
  // a Noritsu that IS receiving jobs. The Noritsu jobs must not touch
  // the order-level path.
  __controllers = [
    picProController({ id: 'CTRL-PP', mergeOrderJobs: true }),
    { id: 'CTRL-DPOF', name: 'Noritsu', type: 'noritsu', autoprint: true },
  ];
  const orderNumber = 'ORD-NORITSU';
  __jobs = [makeJob(101, orderNumber), makeJob(102, orderNumber)];
  for (const j of __jobs) {
    __routeByJobId.set(j.id, {
      type:           'controller',
      controllerType: 'noritsu',
      controllerId:   'CTRL-DPOF',
      controllerName: 'Noritsu',
      channelNumber:  1,
      outputPath:     '/tmp/n',
    });
  }
  // Manifest set for completeness; the pre-pass won't read it because
  // the jobs' route isn't a merge-controller.
  __manifestByOrderNumber.set(orderNumber, { jobs: [{ jobId: 101 }, { jobId: 102 }] });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 0,
    'DPOF jobs must never route through _sendViaFujiPicProOrderRouted');
  assert.equal(__singleJobDispatchCalls.length, 2,
    'both DPOF jobs take the per-job path');
});

// ── Brief update: NaN _orderMergeHeldSince re-stamps to now ────────────────

test('NaN / unparseable _orderMergeHeldSince → re-stamped to now (never wait forever)', async () => {
  resetState();
  const orderNumber = 'ORD-NAN';
  __jobs = [
    // These stamps would make evaluateOrderGroup skip the cap check
    // outright — the brief update rules that out (would wait forever).
    makeJob(101, orderNumber, { _orderMergeHeldSince: 'nonsense-not-an-iso' }),
    makeJob(102, orderNumber, { _orderMergeHeldSince: '' }),
    // 103 is listed in the manifest but not local — blocks readiness.
  ];
  __controllers = [picProController()];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set(orderNumber, {
    jobs: [{ jobId: 101 }, { jobId: 102 }, { jobId: 103 }],
  });

  await _runAutoPrint();

  // No dispatch — group is not ready (103 is missing).
  assert.equal(__orderDispatchCalls.length, 0);

  // Both 101 and 102 got their stamps rewritten to a parseable ISO
  // (their pre-existing garbage was replaced, not left in place).
  const restamped = __updateCalls
    .filter(c => c.updates._orderMergeHeldSince)
    .filter(c => c.jobId === 101 || c.jobId === 102);
  assert.equal(restamped.length, 2, 'both garbage stamps were re-stamped');
  for (const c of restamped) {
    assert.ok(typeof c.updates._orderMergeHeldSince === 'string');
    assert.ok(
      Number.isFinite(Date.parse(c.updates._orderMergeHeldSince)),
      `restamped value must be a parseable ISO — got ${c.updates._orderMergeHeldSince}`,
    );
  }
});

// ── Edge: manifest read failure defers the group ───────────────────────────

test('manifest read failure defers the group — no dispatch, no crash', async () => {
  resetState();
  const orderNumber = 'ORD-BADMAN';
  __jobs = [makeJob(101, orderNumber), makeJob(102, orderNumber)];
  __controllers = [picProController()];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestThrowByOrderNumber.set(orderNumber, 'fake manifest ENOENT');

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 0,
    'without a manifest we cannot know sibling counts — defer, do not guess');
  assert.equal(__singleJobDispatchCalls.length, 0,
    'the per-job loop also skips merge-eligible controllers, so nothing dispatches this pass');
});

// ── Edge: single-job order on a merge-enabled controller uses order-level ─

test('single-job order on a merge-enabled controller uses the order-level path (id = order number)', async () => {
  resetState();
  const orderNumber = 'ORD-SOLO';
  __jobs = [makeJob(101, orderNumber)];
  __controllers = [picProController()];
  __routeByJobId.set(101, picProRoute());
  __manifestByOrderNumber.set(orderNumber, { jobs: [{ jobId: 101 }] });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 1,
    'the brief spells this out: when on, every submission is identified by the order number — including single-job orders');
  assert.equal(__singleJobDispatchCalls.length, 0);
});

// ── Edge: multiple orders on the same controller are bucketed separately ──

test('two different orders on the same merge-enabled controller dispatch separately (one file each)', async () => {
  resetState();
  __controllers = [picProController()];
  __jobs = [
    makeJob(101, 'ORD-A'),
    makeJob(102, 'ORD-A'),
    makeJob(201, 'ORD-B'),
    makeJob(202, 'ORD-B'),
  ];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set('ORD-A', { jobs: [{ jobId: 101 }, { jobId: 102 }] });
  __manifestByOrderNumber.set('ORD-B', { jobs: [{ jobId: 201 }, { jobId: 202 }] });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 2, 'two orders → two dispatches, not one merged mess');
  const perDispatchIds = __orderDispatchCalls.map(c => c.items.map(i => i.jobId).sort());
  perDispatchIds.sort((a, b) => a[0] - b[0]);
  assert.deepEqual(perDispatchIds[0], [101, 102]);
  assert.deepEqual(perDispatchIds[1], [201, 202]);
});

// ── Edge: an already-stamped eligible member keeps its stamp on next pass ──

test('an already-stamped stamp is preserved on subsequent passes (does not reset the clock)', async () => {
  resetState();
  const orderNumber = 'ORD-STAMP';
  const stampedIso  = new Date(Date.now() - 60_000).toISOString();
  __jobs = [
    makeJob(101, orderNumber, { _orderMergeHeldSince: stampedIso }),
  ];
  __controllers = [picProController()];
  __routeByJobId.set(101, picProRoute());
  __manifestByOrderNumber.set(orderNumber, {
    jobs: [{ jobId: 101 }, { jobId: 102 }],   // 102 missing → not ready
  });

  await _runAutoPrint();

  // No dispatch (waiting on 102). The stamp on 101 was NOT rewritten —
  // it was already a valid ISO, so the pre-pass leaves it alone. That
  // is what makes the wait cap meaningful across cycles.
  assert.equal(__orderDispatchCalls.length, 0);
  const rewriteOn101 = __updateCalls
    .filter(c => c.jobId === 101 && c.updates._orderMergeHeldSince);
  assert.equal(rewriteOn101.length, 0,
    'a valid pre-existing stamp must not be rewritten — that would reset the cap clock every pass');
});

// ── Fold: ineligible member's absence from the manifest doesn't matter ────

test('an eligible member awaiting-manifest counts as a blocker (not ready)', async () => {
  // Distinct from "missing local record" — this member EXISTS locally
  // but is held by _awaitingManifest. It's a member with eligibility=false,
  // which prevents the all-ready path.
  resetState();
  const orderNumber = 'ORD-AWAIT';
  __jobs = [
    makeJob(101, orderNumber),
    makeJob(102, orderNumber, { _awaitingManifest: true }),
  ];
  __controllers = [picProController()];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set(orderNumber, { jobs: [{ jobId: 101 }, { jobId: 102 }] });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 0,
    'a held member blocks the group even though every manifest id has a local record');
  // 101 gets stamped (eligible + held for merging). 102 does not (its
  // own gate held it, not the merge).
  const stamped101 = __updateCalls.some(c => c.jobId === 101 && c.updates._orderMergeHeldSince);
  const stamped102 = __updateCalls.some(c => c.jobId === 102 && c.updates._orderMergeHeldSince);
  assert.equal(stamped101, true);
  assert.equal(stamped102, false);
});

// ── Fix 1 (2026-08-14): stale stamp when merging is disabled ───────────────
//
// A job stamped during a period when mergeOrderJobs was on must not stay
// held-for-review indefinitely after the operator disables the setting.
// The per-job loop clears the stale stamp on its next tick AND takes the
// job through the per-job dispatch path.

test('stale _orderMergeHeldSince is cleared when the controller no longer has mergeOrderJobs on', async () => {
  resetState();
  const orderNumber = 'ORD-STALE';
  const stamp = new Date(Date.now() - 60_000).toISOString();
  __jobs = [
    makeJob(101, orderNumber, { _orderMergeHeldSince: stamp }),
    makeJob(102, orderNumber, { _orderMergeHeldSince: stamp }),
  ];
  // Setting was on when the stamps were written, but the operator has
  // since disabled it. The pre-pass is now a no-op for this controller.
  __controllers = [picProController({ mergeOrderJobs: false })];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set(orderNumber, { jobs: [{ jobId: 101 }, { jobId: 102 }] });

  await _runAutoPrint();

  // The per-job loop cleared both stale stamps AND dispatched both jobs
  // via the per-job single-job path.
  const clearedIds = __updateCalls
    .filter(c => c.updates._orderMergeHeldSince === null)
    .map(c => c.jobId).sort();
  assert.deepEqual(clearedIds, [101, 102],
    'stale stamps must be cleared on the next auto-print tick after merging is disabled');
  assert.equal(__orderDispatchCalls.length, 0,
    'no order-level dispatch — merging is off');
  assert.equal(__singleJobDispatchCalls.length, 2,
    'both jobs took the per-job dispatch path — stale stamp did not strand them');
});

test('stale stamp when route no longer resolves to a merge-enabled controller (route change)', async () => {
  // Same scenario as above but from a different angle: the job's route
  // moved to a different (non-merge) controller. The stamp is stale
  // in a different way — same guarantee.
  resetState();
  const orderNumber = 'ORD-REROUTED';
  const stamp = new Date(Date.now() - 60_000).toISOString();
  __jobs = [makeJob(101, orderNumber, { _orderMergeHeldSince: stamp })];
  __controllers = [
    // Merge-enabled controller exists but the job doesn't route to it.
    picProController({ id: 'CTRL-PP-MERGE', mergeOrderJobs: true }),
    { id: 'CTRL-DPOF', name: 'Noritsu', type: 'noritsu', autoprint: true },
  ];
  __routeByJobId.set(101, {
    type:           'controller',
    controllerType: 'noritsu',
    controllerId:   'CTRL-DPOF',
    channelNumber:  1,
    outputPath:     '/tmp/n',
  });

  await _runAutoPrint();

  const cleared = __updateCalls.find(c => c.jobId === 101 && c.updates._orderMergeHeldSince === null);
  assert.ok(cleared, 'the stamp must be cleared — the job\'s current controller is not merge-enabled');
  assert.equal(__singleJobDispatchCalls.length, 1,
    'the job dispatched via the per-job DPOF path');
});

// ── Fix 2 (2026-08-14): clear stamps on failed group dispatch ──────────────
//
// An errored member should not keep a "Waiting for order" chip. As soon
// as we decide to dispatch a group, the wait is over — success or fail.

test('failed group dispatch clears _orderMergeHeldSince on every dispatched member', async () => {
  resetState();
  const orderNumber = 'ORD-FAIL';
  const stamp = new Date(Date.now() - 60_000).toISOString();
  __jobs = [
    makeJob(101, orderNumber, { _orderMergeHeldSince: stamp }),
    makeJob(102, orderNumber, { _orderMergeHeldSince: stamp }),
  ];
  __controllers = [picProController()];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set(orderNumber, { jobs: [{ jobId: 101 }, { jobId: 102 }] });

  // Preplanned failure from the order-level dispatcher.
  __orderDispatchResults.push({
    success:      false,
    error:        'fake staging failure',
    memberJobIds: [101, 102],
    activeJobIds: [101, 102],
    droppedByExclusion: [],
  });

  await _runAutoPrint();

  assert.equal(__orderDispatchCalls.length, 1, 'the group was dispatched (and failed)');
  const clearedIds = __updateCalls
    .filter(c => c.updates._orderMergeHeldSince === null)
    .map(c => c.jobId).sort();
  assert.deepEqual(clearedIds, [101, 102],
    'both members had their stamps cleared even though the dispatch failed — errored jobs must not keep the Waiting-for-order chip');
});

test('a group dispatch that throws also clears the stamps', async () => {
  resetState();
  const orderNumber = 'ORD-THROW';
  const stamp = new Date(Date.now() - 60_000).toISOString();
  __jobs = [
    makeJob(101, orderNumber, { _orderMergeHeldSince: stamp }),
    makeJob(102, orderNumber, { _orderMergeHeldSince: stamp }),
  ];
  __controllers = [picProController()];
  for (const j of __jobs) __routeByJobId.set(j.id, picProRoute());
  __manifestByOrderNumber.set(orderNumber, { jobs: [{ jobId: 101 }, { jobId: 102 }] });

  // Swap in a throwing dispatcher for this test only.
  const orig = fakePrintService._sendViaFujiPicProOrderRouted;
  fakePrintService._sendViaFujiPicProOrderRouted = async (items) => {
    __orderDispatchCalls.push({ items: items.map(it => ({ jobId: it.job.id, printCode: it.route.printCode })) });
    throw new Error('boom');
  };

  try {
    await _runAutoPrint();
  } finally {
    fakePrintService._sendViaFujiPicProOrderRouted = orig;
  }

  const clearedIds = __updateCalls
    .filter(c => c.updates._orderMergeHeldSince === null)
    .map(c => c.jobId).sort();
  assert.deepEqual(clearedIds, [101, 102],
    'stamps are cleared BEFORE the dispatch call, so a throw does not leave them behind');
  const errored = __updateCalls.filter(c => c.updates._status === 'error').map(c => c.jobId).sort();
  assert.deepEqual(errored, [101, 102],
    'both members are also marked errored (the pre-pass fallback for pre-marking throws)');
});
