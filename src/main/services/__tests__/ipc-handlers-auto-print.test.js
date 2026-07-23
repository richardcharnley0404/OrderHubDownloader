/**
 * Unit tests for the v1.3.2 generalized auto-print catch handler.
 *
 * Run via:
 *   npm test
 *
 * Background: prior to v1.3.2, the auto-print loop's catch handler at
 * ipc-handlers.js:1796 had a hardcoded special case that only set
 * _status: 'error' + _errorMessage for "Order manifest not found" errors.
 * Every other dispatch error class was logged-and-skipped, leaving the
 * job in 'received' status — which made the eligibility filter at line
 * 1704 re-admit it on the next auto-print cycle, retry-spamming the same
 * broken job once per polling interval.
 *
 * v1.3.2 generalizes the catch: ALL dispatch errors set _status: 'error'
 * and _errorMessage from err.message, breaking the retry loop for every
 * error class consistently. These tests pin down that contract so a
 * future refactor can't quietly re-introduce the special case.
 *
 * ipc-handlers requires electron + ~15 service modules. We stub them all
 * via Module.prototype.require + require.cache injection, then exercise
 * the exposed _runAutoPrint test hook.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');
const MAIN = path.join(REPO, 'src', 'main');

// ----- Mutable test state read by the stubs -----

let __jobs = [];
let __controllers = [];
let __routeForJob = null;        // overridden per-test
let __dispatchBehavior = null;   // 'throw' | 'success-false' | 'success' | 'folder-throw' | 'folder-success-false'
let __dispatchError = null;      // err to throw, or string for result.error
let __updateCalls = [];
let __dispatchCalls = [];        // call log for sendViaDPOFRouted — dispatched-or-skipped assertions
// Fix 1 (2026-05-24) state — exercises the M2 hold + AI Quality interaction.
let __aiQualityEnabled = false;
let __scoreJobCalls = [];        // call log for aiJobQualityOrchestrator.scoreJob
let __scoreJobResult = { ok: true, held: false };
let __checkLocalFilesResult = { found: false };

function resetState() {
  __jobs = [];
  __controllers = [];
  __routeForJob = null;
  __dispatchBehavior = null;
  __dispatchError = null;
  __updateCalls = [];
  __dispatchCalls = [];
  __aiQualityEnabled = false;
  __scoreJobCalls = [];
  __scoreJobResult = { ok: true, held: false };
  __checkLocalFilesResult = { found: false };
}

// ----- Stubs registered into require.cache -----

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
    const idx = __jobs.findIndex((j) => j.id === jobId);
    if (idx !== -1) __jobs[idx] = { ...__jobs[idx], ...updates };
  },
  findJobByOrderNumber: () => null,
  markCompleted: async () => ({}),
};

const fakeRoutingService = {
  getControllers: () => __controllers,
  resolveRoute: () => __routeForJob,
  // v1.7.8 — runAutoPrint passes this into computeHoldForReview as ctx. Empty
  // set means "no process is on hold", which is the right default for every
  // existing test in this file (none of them exercise the routing-hold gate).
  getRoutingHeldProcesses: () => new Set(),
};

const fakeConfigService = {
  get: (key) => {
    if (key === 'aiQualityEnabled') return __aiQualityEnabled;
    if (key === 'jobDateRange')     return 365;
    return undefined;
  },
};

const fakePrintService = {
  sendViaDPOFRouted: async (job, route) => {
    __dispatchCalls.push({ jobId: job.id, controllerType: route.controllerType });
    if (__dispatchBehavior === 'throw') throw __dispatchError;
    if (__dispatchBehavior === 'success-false') return { success: false, error: __dispatchError };
    return { success: true, method: 'dpof' };
  },
  _sendViaFolderCopyRouted: async () => {
    if (__dispatchBehavior === 'folder-throw') throw __dispatchError;
    if (__dispatchBehavior === 'folder-success-false') return { success: false, error: __dispatchError };
    return { success: true, method: 'folder_copy' };
  },
};

// Stub electron-store as a constructor returning an in-memory store. The
// auto-print path doesn't touch the dpof-state store, but ipc-handlers'
// top-level code constructs one at require time.
function FakeStore() {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
    delete: (k)    => { delete data[k]; },
  };
}

// Resolve service paths through require.resolve so the cache key matches
// however ipc-handlers requires them.
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
stubInCache(path.join(SVC,  'job-download-service.js'),              { checkLocalFiles: () => __checkLocalFilesResult });
stubInCache(path.join(SVC,  'ai-job-quality-orchestrator.js'),       { scoreJob: async (jobId, jobPath) => {
  __scoreJobCalls.push({ jobId, jobPath });
  return __scoreJobResult;
} });
stubInCache(path.join(SVC,  'ai-quality-store.js'),                  { getJobQuality: async () => [], deriveHeld: () => false });
stubInCache(path.join(MAIN, 'updater.js'),                           { setMainWindow: () => {}, startUpdateSchedule: () => {} });

// Override electron + electron-store via Module.prototype.require so
// ipc-handlers' top-level imports resolve to no-ops without triggering
// the real Electron runtime.
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      ipcMain:       { handle: () => {}, on: () => {} },
      dialog:        { showOpenDialog: async () => ({ canceled: true }) },
      app:           { getVersion: () => '1.3.2-test', getPath: () => '/' },
      BrowserWindow: function () {},
      shell:         { openExternal: async () => {} },
    };
  }
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

// Now safe to load ipc-handlers. The test hook _runAutoPrint exposes the
// otherwise-internal auto-print loop we want to exercise.
const { _runAutoPrint } = require(path.join(MAIN, 'ipc-handlers.js'));


function makeJob(overrides = {}) {
  return {
    id:            'JOB-1',
    order_number:  'PXTEST-AUTO',
    order_id:      'order-1',
    process:       'Lab',
    product_code:  'TestProduct',
    options:       [],
    customer_name: 'Test',
    created_at:    new Date().toISOString(),
    _status:       'received',
    ...overrides,
  };
}

function makeDpofRoute(overrides = {}) {
  return {
    type:             'controller',
    controllerType:   'noritsu',
    controllerId:     'CTRL-1',
    controllerName:   'Test Controller',
    outputPath:       '/tmp/out',
    channelNumber:    1,
    printSizeCode:    'KG',
    bannerSheet:      false,
    skipAutoPrint:    false,
    checkOrderStatus: false,
    ...overrides,
  };
}

function makeFolderCopyRoute(overrides = {}) {
  return {
    type:             'process-folder',
    folderPath:       '/tmp/folder',
    ...overrides,
  };
}


// ─────────────────────────────────────────────────────────────────────────
// DPOF dispatch — catch handler (the central regression test)
// ─────────────────────────────────────────────────────────────────────────

test('auto-print guard rail: is_film_development job is skipped — no route lookup, no dispatch, no update', async () => {
  // Belt-and-braces: getLocalJobs already hides film-dev jobs, but the
  // in-loop guard must also fire so a direct in-memory injection can't
  // accidentally route a film-dev job.
  resetState();
  __jobs = [makeJob({ id: 'JOB-FD', is_film_development: true })];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'success';

  await _runAutoPrint();

  assert.equal(__dispatchCalls.length, 0, 'no dispatch attempted');
  assert.equal(__updateCalls.length, 0, 'no updateJobLocally calls — nothing to update');
});


test('auto-print catch: a generic dispatch throw flips job to error + sets _errorMessage', async () => {
  resetState();
  __jobs = [makeJob()];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'throw';
  __dispatchError = new Error('Some unexpected dispatch failure');

  await _runAutoPrint();

  const update = __updateCalls.find((c) => c.jobId === 'JOB-1');
  assert.ok(update, 'updateJobLocally must be called for the failed job');
  assert.equal(update.updates._status, 'error',
    'Status must flip to "error" so the eligibility filter (line 1704) excludes the job from future cycles');
  assert.equal(update.updates._errorMessage, 'Some unexpected dispatch failure',
    'Error message text must be propagated from err.message — not hardcoded, not silently dropped');
});


test('auto-print catch: missing-print-size throw (the print-service DPOF mapping gate) propagates verbatim', async () => {
  // Pins down the mapping-based print-size gate: when a job's resolved
  // route has no printSizeCode (blank / unconfigured channel mapping),
  // the print-service throws with an actionable, product-code-aware
  // message. The operator-friendly text must reach the job's
  // _errorMessage so the renderer's warning-state UI shows what's
  // actually wrong.
  //
  // Replaces the earlier "size is missing on one or more images" gate,
  // which read the upstream manifest's img.size — vestigial, since the
  // DPOF size actually emitted to the printer comes from
  // route.printSizeCode (resolved by routing-service from the product's
  // channel mapping). See docs/orderhub-mandatory-print-size-plan.md §3.1.
  resetState();
  __jobs = [makeJob()];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'throw';
  __dispatchError = new Error(
    'No print size configured for product "TestProduct". ' +
    'Set the Print Size Code on this product\'s channel mapping in Settings → Routing.'
  );

  await _runAutoPrint();

  const update = __updateCalls.find((c) => c.jobId === 'JOB-1');
  assert.ok(update);
  assert.equal(update.updates._status, 'error');
  assert.match(update.updates._errorMessage, /No print size configured/);
});


test('auto-print catch: manifest-not-found is no longer special-cased — same general path', async () => {
  // Pre-v1.3.2 this exact error string had its own branch that hardcoded
  // _errorMessage to the literal "Manifest not found". Post-v1.3.2 the
  // catch handler is uniform — manifest-not-found follows the same path
  // as every other error class, taking the message verbatim from err.message.
  resetState();
  __jobs = [makeJob()];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'throw';
  __dispatchError = new Error('Order manifest not found: /some/path/manifest.json');

  await _runAutoPrint();

  const update = __updateCalls.find((c) => c.jobId === 'JOB-1');
  assert.ok(update);
  assert.equal(update.updates._status, 'error');
  assert.equal(update.updates._errorMessage, 'Order manifest not found: /some/path/manifest.json',
    'Verbatim message — no longer collapsed to the hardcoded "Manifest not found" string');
});


test('auto-print: result.success === false also flips job to error with result.error', async () => {
  // Service-layer return-with-failure (no throw) was the second silent
  // retry path before v1.3.2. Same general handler now covers it.
  resetState();
  __jobs = [makeJob()];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'success-false';
  __dispatchError = 'Service-side error string';

  await _runAutoPrint();

  const update = __updateCalls.find((c) => c.jobId === 'JOB-1');
  assert.ok(update);
  assert.equal(update.updates._status, 'error');
  assert.equal(update.updates._errorMessage, 'Service-side error string');
});


// ─────────────────────────────────────────────────────────────────────────
// Folder-copy / process-folder dispatch — same generalization
// ─────────────────────────────────────────────────────────────────────────

test('auto-print folder-copy catch: throw flips job to error (POS-FUN9N5 retry-spam fix)', async () => {
  // The case observed in the live dev session: POS-FUN9N5 routed to a
  // process-folder with a missing _readManifest source, throwing once per
  // poll cycle for the entire app lifetime. The folder-copy catch was
  // never special-cased for manifest-not-found so the bug went unfixed
  // when the DPOF catch got its narrow special case. v1.3.2 fixes both.
  resetState();
  __jobs = [makeJob()];
  __controllers = [];  // route resolves to process-folder, controller list irrelevant
  __routeForJob = makeFolderCopyRoute();
  __dispatchBehavior = 'folder-throw';
  __dispatchError = new Error('Order manifest not found: /tmp/missing/manifest.json');

  await _runAutoPrint();

  const update = __updateCalls.find((c) => c.jobId === 'JOB-1');
  assert.ok(update, 'folder-copy catch must also propagate error to job state');
  assert.equal(update.updates._status, 'error');
  assert.match(update.updates._errorMessage, /manifest not found/i);
});


test('auto-print folder-copy: result.success === false flips job to error with result.error', async () => {
  resetState();
  __jobs = [makeJob()];
  __controllers = [];
  __routeForJob = makeFolderCopyRoute();
  __dispatchBehavior = 'folder-success-false';
  __dispatchError = 'Disk full';

  await _runAutoPrint();

  const update = __updateCalls.find((c) => c.jobId === 'JOB-1');
  assert.ok(update);
  assert.equal(update.updates._status, 'error');
  assert.equal(update.updates._errorMessage, 'Disk full');
});


// ─────────────────────────────────────────────────────────────────────────
// Negative cases — ensure the generalization doesn't fire on success or
// when the eligibility filter should already exclude the job.
// ─────────────────────────────────────────────────────────────────────────

test('auto-print: successful dispatch does NOT mark the job as error', async () => {
  resetState();
  __jobs = [makeJob()];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'success';

  await _runAutoPrint();

  const errorUpdate = __updateCalls.find(
    (c) => c.jobId === 'JOB-1' && c.updates._status === 'error',
  );
  assert.equal(errorUpdate, undefined,
    'no error-status write on the success path — only the catch handler should produce one');
});


test('auto-print: a job already in _status: error is excluded by the eligibility filter', async () => {
  // Verifies the retry-loop break — once flipped to 'error', the loop
  // skips the job on subsequent runs.
  resetState();
  __jobs = [makeJob({ _status: 'error', _errorMessage: 'previous failure' })];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'throw';
  __dispatchError = new Error('this should never be hit');

  await _runAutoPrint();

  assert.equal(__updateCalls.length, 0,
    'jobs already in error state must be filtered out before dispatch');
});


// ─────────────────────────────────────────────────────────────────────────
// Channel-number gate (v1.3.2 latent-bug fix)
//
// Pre-fix, the gate `(ctrl.type || 'dpof') !== 'folder_copy'` classified
// every non-folder_copy controller as DPOF, silently skipping darkroompro,
// pdf_copy, and frontline jobs whose `route.channelNumber` is null. Bug
// hid behind the renderer's direct sendToPrint call until yesterday's
// autoprint pivot routed darkroompro through this loop for the first time.
//
// Post-fix, the gate explicitly enumerates DPOF types
// (noritsu/epson/dpof/untyped-legacy) and only requires channelNumber for
// those. Five controller types × null/non-null channelNumber gives a
// truth table this block pins down end-to-end.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a route + controller for a given combination, run the loop, and
 * return whether `printService.sendViaDPOFRouted` was reached. The route
 * is always type='controller' so the default-folder branch above doesn't
 * intercept; channelNumber is the variable under test.
 */
async function dispatchReached(controllerType, channelNumber) {
  resetState();
  __jobs = [makeJob()];
  __controllers = [{
    id: 'CTRL-1',
    autoprint: true,
    // `controllerType === undefined` exercises the legacy "no type set"
    // case — historically treated as DPOF via the `(ctrl.type || 'dpof')`
    // fallback, preserved post-fix via `!ctrl.type` in the new gate.
    ...(controllerType === undefined ? {} : { type: controllerType }),
  }];
  __routeForJob = {
    type:             'controller',
    controllerType:   controllerType || 'dpof',
    controllerId:     'CTRL-1',
    controllerName:   'Test',
    outputPath:       '/tmp/out',
    channelNumber,
    bannerSheet:      false,
    skipAutoPrint:    false,
    checkOrderStatus: false,
  };
  __dispatchBehavior = 'success';

  await _runAutoPrint();

  return __dispatchCalls.length > 0;
}


test('channel-number gate: noritsu with channelNumber=42 dispatches (DPOF, channel set)', async () => {
  assert.equal(await dispatchReached('noritsu', 42), true);
});

test('channel-number gate: noritsu with channelNumber=null is skipped (DPOF needs channel)', async () => {
  assert.equal(await dispatchReached('noritsu', null), false,
    'DPOF without a channel mapping must skip — operator hasn\'t finished setup');
});

test('channel-number gate: epson with channelNumber=42 dispatches (DPOF, channel set)', async () => {
  assert.equal(await dispatchReached('epson', 42), true);
});

test('channel-number gate: untyped legacy controller with channelNumber=null is skipped (DPOF default)', async () => {
  // `(ctrl.type || 'dpof')` previously meant unset-type = DPOF. The post-fix
  // gate preserves this via `!ctrl.type` so legacy configs from before the
  // type field existed continue to require a channel mapping.
  assert.equal(await dispatchReached(undefined, null), false);
});

test('channel-number gate: folder_copy with channelNumber=null dispatches (no channel needed)', async () => {
  // Was already handled correctly pre-fix — the only type the old gate
  // explicitly excluded. Pinning down so a future refactor doesn't lose it.
  assert.equal(await dispatchReached('folder_copy', null), true);
});

test('channel-number gate: pdf_copy with channelNumber=null dispatches (no channel needed)', async () => {
  // Pre-fix: silently skipped (pdf_copy hardcodes channelNumber=null in
  // routing-service.js:165). Pre-fix this didn't matter because pdf_copy
  // was never auto-printed via this loop, but the latent bug was there.
  assert.equal(await dispatchReached('pdf_copy', null), true);
});

test('channel-number gate: darkroompro with channelNumber=null dispatches (the v1.3.2 regression)', async () => {
  // The actual regression. Yesterday's autoprint pivot routed darkroompro
  // jobs through this loop for the first time; the pre-fix gate skipped
  // them because routing-service.js:247 sets channelNumber=null for the
  // type and the gate misclassified that as "DPOF without channel".
  assert.equal(await dispatchReached('darkroompro', null), true,
    'darkroompro must dispatch — channelNumber=null is the type\'s normal state');
});

test('channel-number gate: frontline with channelNumber=null dispatches (no channel needed)', async () => {
  // Same latent bug as darkroompro/pdf_copy — frontline hardcodes
  // channelNumber=null in routing-service.js:277. Pinning down so the
  // explicit-DPOF-enumeration gate can\'t regress for any non-DPOF type.
  assert.equal(await dispatchReached('frontline', null), true);
});


// ─────────────────────────────────────────────────────────────────────────
// M2 hold gate × AI Quality Gate interaction (Fix 1, 2026-05-24)
//
// Regression: an earlier placement of the M2 manual-review hold ahead of
// the AI Quality block in runAutoPrint short-circuited `scoreJob()` for
// every held job. Result: `sidecar.aiQuality.scored` stayed false →
// renderer thumbnail chip showed "AI scoring…" indefinitely for all
// manual-source / not-finalised jobs (POS-EFZ9UK-1, PXDEMO-AUXZWJ-1).
//
// Post-fix, the M2 gate runs AFTER scoring, so the sidecar gets populated
// for held jobs (chips render), but dispatch is still skipped on the hold
// reason. This test pins both invariants down.
// ─────────────────────────────────────────────────────────────────────────

test('Fix 1: held manual-source job still gets AI-scored, but dispatch is skipped', async () => {
  resetState();
  __aiQualityEnabled = true;
  __checkLocalFilesResult = { found: true, localPath: '/tmp/manual-job-path' };
  __scoreJobResult = { ok: true, held: false }; // scoring itself doesn't hold
  __jobs = [makeJob({
    // Manual-source → M2 hold gate fires (rule in src/shared/holdForReview.js).
    artwork_source: 'manual',
    artwork_files: [{ id: 'f1', source: 'manual', production_ready: true }],
  })];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'success';

  await _runAutoPrint();

  assert.equal(__scoreJobCalls.length, 1,
    'scoreJob MUST run on the manual-source job — held jobs still need per-image scoring '
    + 'so the renderer chip / Review tab can populate. Pre-fix this was zero.');
  assert.equal(__dispatchCalls.length, 0,
    'M2 hold still skips DPOF dispatch — the gate continues to prevent auto-print '
    + 'of unreviewed manual artwork after scoring completes.');
});


test('Fix 1 (post hold-rule narrowing 2026-05-24): Pixfizz job with all files production_ready=false is scored AND dispatched', async () => {
  // The PXDEMO-AUXZWJ-1 case after the hold-rule narrowing:
  // artwork_source: 'pixfizz' with every artwork_file at
  // production_ready: false is NOT held — OrderHub returns that as a
  // default state on Pixfizz-source files. Auto-print proceeds.
  //
  // This test preserves the AI-scoring regression coverage of the
  // previous "held not-finalised Pixfizz" test (scoreJob must reach
  // these jobs) but flips the dispatch expectation: dispatch DOES
  // happen because the M2 hold gate no longer fires on production_ready.
  resetState();
  __aiQualityEnabled = true;
  __checkLocalFilesResult = { found: true, localPath: '/tmp/pixfizz-not-finalised' };
  __scoreJobResult = { ok: true, held: false };
  __jobs = [makeJob({
    artwork_source: 'pixfizz',
    artwork_files: [{ id: 'f1', source: 'pixfizz', production_ready: false, artwork_type: 'pages' }],
  })];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'success';

  await _runAutoPrint();

  assert.equal(__scoreJobCalls.length, 1,
    'scoreJob must run on Pixfizz jobs with production_ready: false — they are no longer held, but scoring is a per-image quality signal regardless.');
  assert.equal(__dispatchCalls.length, 1,
    'Pixfizz job with all files production_ready: false MUST dispatch — that flag is a default API state, not a hold reason.');
});


test('Fix 1: unheld pixfizz job gets scored AND dispatched (regression guard the other way)', async () => {
  // Make sure the re-ordering didn't break the happy path: a fully
  // production_ready Pixfizz job should still get scored AND dispatched.
  resetState();
  __aiQualityEnabled = true;
  __checkLocalFilesResult = { found: true, localPath: '/tmp/pixfizz-ready' };
  __scoreJobResult = { ok: true, held: false };
  __jobs = [makeJob({
    artwork_source: 'pixfizz',
    artwork_files: [{ id: 'f1', source: 'pixfizz', production_ready: true, artwork_type: 'pages' }],
  })];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'success';

  await _runAutoPrint();

  assert.equal(__scoreJobCalls.length, 1, 'happy-path job scored');
  assert.equal(__dispatchCalls.length, 1, 'happy-path job dispatched');
});


// ─────────────────────────────────────────────────────────────────────────
// Awaiting-manifest gate — auto-print MUST skip jobs flagged
// _awaitingManifest:true. polling-service tracks the wait + bounded
// escalation; if auto-print proceeded it would throw "Order manifest not
// found" inside _readManifest and enter the sticky-error path before the
// manifest had a chance to land.
// ─────────────────────────────────────────────────────────────────────────

test('awaiting-manifest gate: _awaitingManifest:true jobs are not dispatched', async () => {
  resetState();
  __jobs = [makeJob({ _awaitingManifest: true })];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'success';

  await _runAutoPrint();

  assert.equal(__dispatchCalls.length, 0,
    'auto-print must skip awaiting-manifest jobs — dispatch would throw before manifest lands');
  const errorUpdate = __updateCalls.find((c) => c.updates && c.updates._status === 'error');
  assert.equal(errorUpdate, undefined,
    'skipped jobs must NOT flip to error — the sticky-error path was the bug we are gating against');
});

test('awaiting-manifest gate: flag cleared → job dispatches normally', async () => {
  // Mirrors the auto-recovery flow once polling-service detects manifest arrival.
  resetState();
  __jobs = [makeJob({ _awaitingManifest: false })];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'success';

  await _runAutoPrint();

  assert.equal(__dispatchCalls.length, 1, 'cleared flag → normal dispatch path');
});
