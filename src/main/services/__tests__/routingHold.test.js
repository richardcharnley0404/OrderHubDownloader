/**
 * Edge-case integration tests for the v1.7.8 routing-hold flow.
 *
 * Covers:
 *   1. Hold toggle ON with in-flight jobs — re-derive flips reasons on/off
 *      based on the routingHeldProcesses set.
 *   2. Release-then-delete-controller — resolveRoute falls through to Layer 2
 *      when _channelMappingOverride references a now-deleted mapping (same
 *      defence as the crop-to-size feature relies on).
 *   3. Reassign-then-no-channel — resolveRouteForController surfaces
 *      no-channel so the renderer can chain into the Assign modal.
 *   4. Reassign overwrites _channelMappingOverride — silent overwrite is the
 *      documented v1.7.8 behaviour. If the operator had a crop-to-size route
 *      pinned via the same field, reassigning replaces it. Documented in
 *      v1.7.8 commit; this test pins the contract.
 *
 * routing-service requires electron + electron-store at module load. Pattern
 * mirrors resolvePrintSizeCode.test.js + config-service-bom.test.js: shim
 * both via Module.prototype.require, then drive the in-memory FakeStore
 * directly so each test can seed its own mappings + controllers.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

// In-memory shared store — every `new Store(...)` returned by the shim is
// backed by the same object so tests can poke data via __seed below.
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
  app: {
    getPath: () => os.tmpdir(),
    on: () => {},
  },
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
const { computeHoldForReview, REASON } = require(
  path.join(REPO, 'src', 'shared', 'holdForReview.js'),
);


// ──────────────────────────────────────────────────────────────────────────────
// Edge case 1 — hold toggle ON with in-flight jobs
// ──────────────────────────────────────────────────────────────────────────────

test('Edge 1: hold toggle ON with in-flight jobs — re-derive flips reasons', () => {
  // Seed two processes; only one is on hold initially.
  __seed({
    processControllerMappings: [
      { process: 'Lab',    controllerId: 'ctrl-noritsu', hold: true  },
      { process: 'Dyesub', controllerId: 'ctrl-fuji',    hold: false },
    ],
  });

  const held = routingService.getRoutingHeldProcesses();
  assert.deepEqual([...held].sort(), ['Lab']);

  // Two in-flight jobs, neither released yet.
  const labJob    = { id: 1, process: 'Lab',    artwork_source: 'pixfizz', artwork_files: [] };
  const dyesubJob = { id: 2, process: 'Dyesub', artwork_source: 'pixfizz', artwork_files: [] };

  const labHold    = computeHoldForReview(labJob,    { routingHeldProcesses: held });
  const dyesubHold = computeHoldForReview(dyesubJob, { routingHeldProcesses: held });
  assert.deepEqual(labHold._holdReasons,    [REASON.ROUTING_HOLD], 'Lab job picks up the hold immediately');
  assert.deepEqual(dyesubHold._holdReasons, [], 'Dyesub is unaffected');

  // Now toggle hold OFF for Lab — the re-derive must drop the reason on the
  // SAME in-flight job (no need to re-poll OH).
  __storeData.processControllerMappings = [
    { process: 'Lab',    controllerId: 'ctrl-noritsu', hold: false },
    { process: 'Dyesub', controllerId: 'ctrl-fuji',    hold: false },
  ];
  const heldAfter = routingService.getRoutingHeldProcesses();
  assert.equal(heldAfter.size, 0);

  const labHoldAfter = computeHoldForReview(labJob, { routingHeldProcesses: heldAfter });
  assert.deepEqual(labHoldAfter._holdReasons, [], 'flipping the process flag off drops the hold on the next derive');
});


// ──────────────────────────────────────────────────────────────────────────────
// Edge case 2 — release-then-delete-controller (override falls through)
// ──────────────────────────────────────────────────────────────────────────────

test('Edge 2: _channelMappingOverride pointing to a deleted mapping → resolveRoute falls through to Layer 2', () => {
  __seed({
    orderControllers: [
      { id: 'ctrl-noritsu',  name: 'Noritsu', type: 'noritsu', outputPath: '/tmp/noritsu' },
    ],
    processControllerMappings: [
      { process: 'Lab', controllerId: 'ctrl-noritsu', hold: false },
    ],
    // No channel mapping with id 'cm-deleted' — simulates the operator
    // deleting the channel mapping after a routing-hold release reassigned
    // a job to it.
    channelMappings: [
      { id: 'cm-live', controllerId: 'ctrl-noritsu', productCode: '0406', options: [], channelNumber: 1, printSizeCode: 'KG' },
    ],
  });

  const job = {
    id: 1,
    process: 'Lab',
    product_code: '0406',
    options: [],
    _channelMappingOverride: 'cm-deleted',
  };

  const route = routingService.resolveRoute(job);
  // Override is logged + ignored; falls through to Layer 2 (process → Noritsu)
  // → Layer 3 (channel mapping for 0406 = cm-live).
  assert.equal(route.type, 'controller');
  assert.equal(route.controllerId, 'ctrl-noritsu');
  assert.equal(route.channelNumber, 1);
});


// ──────────────────────────────────────────────────────────────────────────────
// Edge case 3 — reassign-then-no-channel
// ──────────────────────────────────────────────────────────────────────────────

test('Edge 3: resolveRouteForController returns no-channel when target controller lacks a mapping', () => {
  __seed({
    orderControllers: [
      { id: 'ctrl-noritsu', name: 'Noritsu', type: 'noritsu', outputPath: '/tmp/n' },
      { id: 'ctrl-epson',   name: 'Epson',   type: 'epson',   outputPath: '/tmp/e' },
    ],
    // Channel mapping exists ONLY for Noritsu — reassigning to Epson must
    // surface no-channel so the renderer can chain into Assign.
    channelMappings: [
      { id: 'cm-1', controllerId: 'ctrl-noritsu', productCode: '0406', options: [], channelNumber: 1 },
    ],
  });

  const job = { id: 1, product_code: '0406', options: [] };
  const route = routingService.resolveRouteForController(job, 'ctrl-epson');
  assert.equal(route.type, 'unrouted');
  assert.equal(route.reason, 'no-channel');
  assert.ok(route.controller, 'no-channel must carry the target controller so the renderer can pre-fill the Assign modal');
  assert.equal(route.controller.id, 'ctrl-epson');
});

test('Edge 3b: resolveRouteForController returns no-controller when the id is unknown', () => {
  __seed({
    orderControllers: [
      { id: 'ctrl-noritsu', name: 'Noritsu', type: 'noritsu', outputPath: '/tmp/n' },
    ],
    channelMappings: [],
  });
  const route = routingService.resolveRouteForController({ id: 1, product_code: '0406', options: [] }, 'ctrl-ghost');
  assert.equal(route.type, 'unrouted');
  assert.equal(route.reason, 'no-controller');
});


// ──────────────────────────────────────────────────────────────────────────────
// Edge case 4 — reassign overwrites _channelMappingOverride (silent)
// ──────────────────────────────────────────────────────────────────────────────
//
// Documented v1.7.8 behaviour: if the job had a _channelMappingOverride set
// by another flow (crop-to-size), reassigning via routing-hold replaces it.
// This is the simplest contract; a nudge dialog can be added later if it
// turns out operators routinely combine the two flows.
//
// We exercise the contract by checking that resolveRoute honours whatever
// _channelMappingOverride is currently set on the job — the IPC handler
// overwrites the field in-place, so subsequent route resolution sees the
// new value.

test('Edge 4: _channelMappingOverride is the resolveRoute short-circuit — last write wins', () => {
  __seed({
    orderControllers: [
      { id: 'ctrl-noritsu', name: 'Noritsu', type: 'noritsu', outputPath: '/tmp/n' },
      { id: 'ctrl-epson',   name: 'Epson',   type: 'epson',   outputPath: '/tmp/e' },
    ],
    processControllerMappings: [
      { process: 'Lab', controllerId: 'ctrl-noritsu', hold: false },
    ],
    channelMappings: [
      { id: 'cm-crop',     controllerId: 'ctrl-noritsu', productCode: '0406', options: [], channelNumber: 1, printSizeCode: 'KG' },
      { id: 'cm-reassign', controllerId: 'ctrl-epson',   productCode: '0406', options: [], channelNumber: 2, printSizeCode: '4x6' },
    ],
  });

  // Step 1: crop-to-size pinned the job to cm-crop (Noritsu, channel 1).
  const job = {
    id: 1,
    process: 'Lab',
    product_code: '0406',
    options: [],
    _channelMappingOverride: 'cm-crop',
  };
  const route1 = routingService.resolveRoute(job);
  assert.equal(route1.controllerId,  'ctrl-noritsu');
  assert.equal(route1.channelNumber, 1);

  // Step 2: operator reassigns via the routing-hold flow. The IPC handler
  // sets job._channelMappingOverride = 'cm-reassign'. Next resolve picks up
  // the new value — silent overwrite of the previous crop pin.
  job._channelMappingOverride = 'cm-reassign';
  const route2 = routingService.resolveRoute(job);
  assert.equal(route2.controllerId,  'ctrl-epson',
    'reassign overwrites the previous _channelMappingOverride — documented v1.7.8 behaviour');
  assert.equal(route2.channelNumber, 2);
});


// Restore module require so subsequent tests in the same node process aren't
// affected by our shim. (node:test runs each test file in its own process by
// default, but defence-in-depth.)
Module.prototype.require = __originalRequire;
