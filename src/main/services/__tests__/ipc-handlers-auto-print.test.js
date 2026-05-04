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

function resetState() {
  __jobs = [];
  __controllers = [];
  __routeForJob = null;
  __dispatchBehavior = null;
  __dispatchError = null;
  __updateCalls = [];
  __dispatchCalls = [];
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
};

const fakeConfigService = {
  get: (key) => {
    if (key === 'aiQualityEnabled') return false;
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
stubInCache(path.join(SVC,  'job-download-service.js'),              { checkLocalFiles: () => ({ found: false }) });
stubInCache(path.join(SVC,  'ai-job-quality-orchestrator.js'),       { scoreJob: async () => ({ ok: true, held: false }) });
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


test('auto-print catch: missing-size throw (the print-service:236 contract) propagates verbatim', async () => {
  // Pins down the v1.3.2 fix-B contract: when the polling-service's
  // receive-time missing-size check is gone, the canonical missing-size
  // validation lives at print-service.js:236 and surfaces here. The
  // operator-friendly text must reach the job's _errorMessage so the
  // renderer's warning-state UI shows what's actually wrong.
  resetState();
  __jobs = [makeJob()];
  __controllers = [{ id: 'CTRL-1', autoprint: true, type: 'noritsu' }];
  __routeForJob = makeDpofRoute();
  __dispatchBehavior = 'throw';
  __dispatchError = new Error(
    'Cannot print — size is missing on one or more images. Check product configuration in Pixfizz Core.'
  );

  await _runAutoPrint();

  const update = __updateCalls.find((c) => c.jobId === 'JOB-1');
  assert.ok(update);
  assert.equal(update.updates._status, 'error');
  assert.match(update.updates._errorMessage, /size is missing/);
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
