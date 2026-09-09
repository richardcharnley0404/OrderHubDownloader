'use strict';

/**
 * Tests for the removal of the global "Default Folder" (config key
 * `processFolderPath`, formerly Settings → Downloads → Process Folders).
 *
 * TRIPWIRE tests (prefix "TRIPWIRE:") lock behaviour that must NOT
 * change when the default-folder fallback is removed:
 *
 *   - A valid controller mapping routes exactly as today.
 *   - A process-folder exception (Layer 1, per-exception folders
 *     configured in Routing) is completely unaffected. That is a
 *     distinct feature backed by `processFolderExceptions`; the
 *     removal touches only `processFolderPath`, so Layer 1 must
 *     stay green before AND after.
 *
 * NEW tests (prefix "no-fallback:") drive the removal:
 *
 *   - A job whose process has NO mapping resolves to `unrouted`,
 *     even if a stale `processFolderPath` value is still in the
 *     routing store (orphan post-removal).
 *   - A job whose mapping points at a DELETED controller ALSO
 *     resolves to `unrouted` rather than being silently copied to
 *     the default folder and marked Completed. That was the defect
 *     the default folder was actively hiding — the routing failure
 *     needs to surface as `unrouted` so the operator sees it in the
 *     jobs grid.
 *
 * Test-run behaviour before AND after the code change:
 *   - Pre-change (current code): tripwires PASS. `no-fallback:` tests
 *     FAIL, because resolveRoute currently returns `default-folder`
 *     when `processFolderPath` is set (regardless of whether the
 *     process has a mapping or the mapped controller exists).
 *   - Post-change: everything PASSES. Removing the
 *     `defaultFolderFallback` branch turns both failure modes into
 *     `{ type: 'unrouted', reason: 'no-controller' }`.
 *
 * Harness copied from routingHold.test.js: FakeStore backing every
 * `new Store(...)` via a Module.prototype.require shim so tests can
 * `__seed()` mappings and controllers directly.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const os     = require('node:os');
const Module = require('node:module');

const __storeData = {};
function FakeStore() {
  return {
    get: (k, d) => (k in __storeData ? __storeData[k] : d),
    set: (k, v) => { __storeData[k] = v; },
    delete: (k) => { delete __storeData[k]; },
    has:  (k) => (k in __storeData),
  };
}
function __seed(data) {
  for (const k of Object.keys(__storeData)) delete __storeData[k];
  Object.assign(__storeData, data);
}

const fakeElectron = {
  app: { getPath: () => os.tmpdir(), on: () => {} },
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') return FakeStore;
  if (req === 'electron')       return fakeElectron;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const routingService = require(
  path.join(REPO, 'src', 'main', 'services', 'routing-service.js'),
);

// ── TRIPWIRES ─────────────────────────────────────────────────────────────

test('TRIPWIRE: a job with a valid controller mapping routes to type="controller" — the removal must not touch this path', () => {
  __seed({
    orderControllers: [{
      id: 'ctrl-A',
      name: 'Fuji A',
      type: 'noritsu',
      outputPath: 'C:/hot',
    }],
    processControllerMappings: [
      { process: 'Print', controllerId: 'ctrl-A' },
    ],
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-A', productCode: '0406', options: [], channelNumber: 5, printSizeCode: 'KG' },
    ],
    // Default folder deliberately set — must NOT reroute a job that has
    // a real controller mapping through it.
    processFolderPath: 'C:/should-not-be-used',
  });

  const job = { id: 1, process: 'Print', product_code: '0406', options: [] };
  const route = routingService.resolveRoute(job);

  assert.equal(route.type, 'controller');
  assert.equal(route.controllerId, 'ctrl-A');
  assert.equal(route.channelNumber, 5);
  assert.equal(route.printSizeCode, 'KG');
});

test('TRIPWIRE: process-folder exception (Layer 1) is unaffected — distinct feature, must stay green', () => {
  // Layer 1 matches on productCode + options (see routing-service.js
  // :360-366), not on process. resolveRoute returns
  // { type: 'process-folder', folderPath } for these BEFORE the
  // mapping/controller layers run — completely independent of
  // processFolderPath (the "Default Folder" we're removing).
  __seed({
    processFolderExceptions: [
      { id: 'exc-1', productCode: '0406', options: [], folderPath: 'C:/framed-jobs' },
    ],
    // Bait: default folder also set. The exception must win because
    // Layer 1 runs first.
    processFolderPath: 'C:/should-not-be-used',
    // And a mapping that would otherwise route to a controller — the
    // exception must ALSO win over Layer 2.
    orderControllers: [{ id: 'ctrl-B', name: 'B', type: 'noritsu', outputPath: 'C:/hot' }],
    processControllerMappings: [
      { process: 'Framed', controllerId: 'ctrl-B' },
    ],
  });

  const job = { id: 2, process: 'Framed', product_code: '0406', options: [] };
  const route = routingService.resolveRoute(job);

  assert.equal(route.type, 'process-folder',
    'Layer 1 exception must return type=process-folder regardless of downstream layers');
  assert.equal(route.folderPath, 'C:/framed-jobs');
});

// ── NEW: no-fallback (fail pre-change, pass post-change) ──────────────────

test('no-fallback: a job whose process has NO mapping resolves to unrouted (not default-folder), even with a stale processFolderPath in the store', () => {
  __seed({
    // No processControllerMappings at all.
    orderControllers: [],
    processControllerMappings: [],
    // Stale processFolderPath left in the routing store — post-removal
    // orphan behaviour. Must NOT reroute this job to a default-folder
    // shape; the removal takes that fallback path off the table.
    processFolderPath: 'C:/orphan-default-folder',
  });

  const job = { id: 3, process: 'Print', product_code: '0406', options: [] };
  const route = routingService.resolveRoute(job);

  assert.equal(route.type, 'unrouted');
  // The old fallback returned reason:'no-default-folder' when the
  // processFolderPath was empty AND reason was implicit for the
  // default-folder shape. After the removal there is exactly one
  // unrouted reason for the "no mapping" case — locked here.
  assert.equal(route.reason, 'no-controller');
});

test('no-fallback: DELETED-CONTROLLER defect — mapping points at a controller that no longer exists → unrouted (not silently copied to default folder and marked Completed)', () => {
  // This is the load-bearing defect the default-folder fallback was
  // hiding. Pre-removal:
  //   - Operator deletes / accidentally clears a controller from Routing.
  //   - Every subsequent job whose mapping pointed at that controller
  //     resolves to `default-folder` (routing-service.js pre-removal).
  //   - Auto-print silently copies the job files to the default folder
  //     and calls _markCompleted. Jobs go green in the grid. No printer
  //     ever printed anything. Files pile up in the default folder
  //     with nobody watching.
  //
  // Post-removal: the same broken state resolves to `unrouted`.
  //   - Auto-print skips silently.
  //   - Manual Send-to-Print surfaces a visible error.
  //   - The Jobs grid shows the operator-actionable text next to the
  //     job. The problem is visible, not hidden.
  //
  // Named as its own test because it's a defect being fixed, not just
  // a feature being removed.
  __seed({
    orderControllers: [
      // 'ctrl-DELETED' is intentionally NOT in this list — simulates
      // the operator having deleted it from Routing after the mapping
      // was already created.
    ],
    processControllerMappings: [
      { process: 'Print', controllerId: 'ctrl-DELETED' },
    ],
    // Bait: default folder set. Pre-removal this makes the failure
    // silent (silently copies to folder + marks Completed). Post-
    // removal, the folder value is ignored and the failure surfaces
    // as unrouted.
    processFolderPath: 'C:/would-hide-the-defect',
  });

  const job = { id: 4, process: 'Print', product_code: '0406', options: [] };
  const route = routingService.resolveRoute(job);

  assert.equal(route.type, 'unrouted',
    'a mapping pointing at a deleted controller must surface as unrouted, not be silently rerouted to the default folder');
  assert.equal(route.reason, 'no-controller');
});

test('no-fallback: mapping present + controller present + NO channel → unrouted with reason=no-channel (existing behaviour, not affected by the removal)', () => {
  // Sanity check that removing the default-folder fallback does not
  // regress the DPOF-family no-channel case. Layer 3 has its own
  // unrouted reason ('no-channel') and its own downstream handling
  // (Assign button in the renderer) — must stay untouched.
  __seed({
    orderControllers: [{
      id: 'ctrl-C',
      name: 'C',
      type: 'noritsu',
      outputPath: 'C:/hot',
    }],
    processControllerMappings: [
      { process: 'Print', controllerId: 'ctrl-C' },
    ],
    channelMappings: [], // No channels — Layer 3 misses.
    processFolderPath: 'C:/must-not-catch-no-channel',
  });

  const job = { id: 5, process: 'Print', product_code: '0406', options: [] };
  const route = routingService.resolveRoute(job);

  assert.equal(route.type, 'unrouted');
  assert.equal(route.reason, 'no-channel',
    'the no-channel case must keep its distinct reason so the renderer can show the Assign button, not the "No routing" text');
});
