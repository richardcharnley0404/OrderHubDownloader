'use strict';

/**
 * Tests for src/main/services/fuji-pic-pro-monitor.js.
 *
 * Uses real os.tmpdir I/O so the state-machine transitions can be
 * exercised end-to-end via file existence, but injects an in-memory
 * store shim (electron-store isn't loadable outside Electron in a
 * node --test run) and a controllable clock. The monitor's `_scanNow`
 * hook drives each transition deterministically.
 *
 * Coverage:
 *   Phase transitions
 *     - awaiting-gateway → delivering (file vanishes)
 *     - delivering → building (DIGIN move completes)
 *     - building → releasing (folder + containers cleared)
 *     - releasing → complete (with + without sendReleaseCommand)
 *
 *   Timeouts
 *     - gatewayTimeoutMs → status 'failed'
 *     - buildTimeoutMs   → status 'timed_out' (and NO [release] written)
 *
 *   Callback safety
 *     - A throwing callback does not break the monitor's next scan
 *
 *   Restart recovery
 *     - Pre-populated pending store rehydrates on startMonitoring
 *
 *   Idempotency + lifecycle hygiene
 *     - startMonitoring twice does not double-schedule sweeps or leak
 *       watchers
 *     - stopMonitoring cleans up timers + watchers
 *
 *   Merge Data check
 *     - Both {orderId}.con AND {orderId}/ variants held tracked; only
 *       when BOTH are gone does the entry advance to releasing
 *
 * Run via: npm test
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const fsp    = require('node:fs/promises');
const path   = require('node:path');
const os     = require('node:os');

const { FujiPicProMonitor, _internals } = require('../fuji-pic-pro-monitor');
const fileWriter = require('../fuji-pic-pro-file-writer');

// ── Fixture helpers ────────────────────────────────────────────────────────

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {},
};

async function makeTempDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'fpp-mon-'));
}

/**
 * Minimal in-memory store shim so the monitor can persist without
 * needing electron-store. Only supports `.get(key, def)` and
 * `.set(key, value)` — that's all the monitor uses.
 */
function makeInMemoryStore(seed = {}) {
  const data = { ...seed };
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
    has: (k) => k in data,
    _dump: () => ({ ...data }),
  };
}

/**
 * Controllable clock helper. `advance(ms)` moves the clock forward
 * synchronously so timeout branches can be triggered without real
 * setTimeout delays.
 */
function makeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  now.set    = (ms) => { t  = ms; };
  return now;
}

/**
 * Layout a temp workspace with three folders (order-data, digin,
 * staging) plus a per-order staging subfolder with `count` JPEGs. The
 * monitor will consume this staging folder in the `delivering` phase.
 */
async function setupWorkspace(dir, { orderId, imageCount = 2 } = {}) {
  const orderData    = path.join(dir, 'order-data'); await fsp.mkdir(orderData);
  const diginPath    = path.join(dir, 'digin');      await fsp.mkdir(diginPath);
  const stagingRoot  = path.join(dir, 'staging');    await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, orderId); await fsp.mkdir(stagingFolder);
  for (let i = 1; i <= imageCount; i++) {
    await fsp.writeFile(path.join(stagingFolder, `${String(i).padStart(4, '0')}.jpg`), `bytes-${i}`);
  }
  // Simulate the .txt in Order Data — the monitor's awaiting-gateway
  // phase watches this file. Tests remove it to represent OrderGateway
  // consuming it.
  await fsp.writeFile(path.join(orderData, `${orderId}.txt`), `[Order]\r\nOrderId=${orderId}\r\n`);
  return { orderData, diginPath, stagingFolder, stagingRoot };
}

/**
 * Enqueue helper — thin wrapper over enqueueSubmission that fills in
 * all the paths from setupWorkspace + the monitor's own controller.
 */
function enqueue(monitor, ws, orderId, overrides = {}) {
  return monitor.enqueueSubmission({
    orderId,
    orderRef:            orderId,
    stagingFolder:       ws.stagingFolder,
    orderDataPath:       ws.orderData,
    diginPath:           ws.diginPath,
    controllerId:        'ctrl-test',
    gatewayTimeoutMs:    30_000,
    buildTimeoutMs:      600_000,
    sendReleaseCommand:  false,
    mergeDataPath:       '',
    ...overrides,
  });
}

function makeMonitor(overrides = {}) {
  const clock  = overrides.clock  || makeClock();
  const store  = overrides.store  || makeInMemoryStore();
  const logger = overrides.logger || silentLogger;
  const monitor = new FujiPicProMonitor({
    deps: { store, logger, clock, fs, fileWriter },
  });
  return { monitor, clock, store, logger };
}

// ── Callback recording helper ──────────────────────────────────────────────

function recorderCallback() {
  const events = [];
  const cb = (event) => { events.push({ ...event }); };
  cb.events = events;
  return cb;
}

// ── Phase transitions ─────────────────────────────────────────────────────

test('awaiting-gateway → delivering when the .txt disappears from Order Data', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-1' });

  const { monitor } = makeMonitor();
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-1');

  // .txt still present → no advance
  await monitor._scanNow();
  assert.equal(monitor.getPending()[0].phase, 'awaiting-gateway');

  // Simulate OrderGateway consuming it
  await fsp.unlink(path.join(ws.orderData, 'ORD-1.txt'));

  // First scan should advance to `delivering`, kick off deliverToDigin,
  // and then transition to `building` on the same scan (delivering has
  // no wait — it performs the move inline).
  await monitor._scanNow();
  const entry = monitor.getPending()[0];
  assert.ok(entry, 'entry still pending — should be in building');
  assert.equal(entry.phase, 'building');
  assert.ok(fs.existsSync(path.join(ws.diginPath, 'ORD-1')),
    'DIGIN folder must exist after the delivering step ran');
  assert.equal(fs.existsSync(ws.stagingFolder), false,
    'staging folder must be gone after the DIGIN rename');

  monitor.stopMonitoring();
});

test('building → releasing → accepted (release toggle off) removes the entry', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-1' });

  const { monitor } = makeMonitor();
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-1', { sendReleaseCommand: false });

  // Fast-forward through awaiting-gateway + delivering.
  await fsp.unlink(path.join(ws.orderData, 'ORD-1.txt'));
  await monitor._scanNow();       // → building (via delivering inline)
  // Simulate PIC Pro consuming the DIGIN folder.
  await fsp.rm(path.join(ws.diginPath, 'ORD-1'), { recursive: true, force: true });
  await monitor._scanNow();       // → releasing → accepted

  assert.equal(monitor.getPending().length, 0, 'entry should be resolved and removed');
  assert.equal(cb.events.length, 1, 'exactly one terminal callback');
  assert.equal(cb.events[0].status, 'accepted');
  assert.equal(cb.events[0].orderRef, 'ORD-1');
  // No [release] file — the toggle is off.
  const orderDataFiles = await fsp.readdir(ws.orderData);
  assert.deepEqual(orderDataFiles, [],
    'no command file may be written when sendReleaseCommand is off');
  monitor.stopMonitoring();
});

test('releasing writes [release]{orderId} when sendReleaseCommand=true', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-1' });

  const { monitor } = makeMonitor();
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-1', { sendReleaseCommand: true });

  await fsp.unlink(path.join(ws.orderData, 'ORD-1.txt'));
  await monitor._scanNow();
  await fsp.rm(path.join(ws.diginPath, 'ORD-1'), { recursive: true, force: true });
  await monitor._scanNow();

  assert.equal(cb.events[0].status, 'accepted');
  const files = await fsp.readdir(ws.orderData);
  assert.equal(files.length, 1, 'exactly one command file expected');
  assert.match(files[0], /^ohd_release_ORD-1_/, 'filename includes the release command and orderId');
  const bytes = await fsp.readFile(path.join(ws.orderData, files[0]), 'utf-8');
  assert.equal(bytes, '[release]ORD-1');
  monitor.stopMonitoring();
});

// ── Timeouts ──────────────────────────────────────────────────────────────

test('gatewayTimeoutMs expiring while the .txt is still present emits status "failed"', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-T' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-T', { gatewayTimeoutMs: 5_000 });

  // Below the timeout — still pending
  clock.advance(4_000);
  await monitor._scanNow();
  assert.equal(monitor.getPending().length, 1);
  assert.equal(cb.events.length, 0);

  // Cross the timeout
  clock.advance(2_000);
  await monitor._scanNow();
  assert.equal(monitor.getPending().length, 0, 'entry removed');
  assert.equal(cb.events.length, 1);
  assert.equal(cb.events[0].status, 'failed');
  assert.equal(cb.events[0].phase, 'awaiting-gateway',
    'phase in the payload reflects where the failure happened');

  monitor.stopMonitoring();
});

test('buildTimeoutMs expiring while DIGIN still holds the folder emits "timed_out" and does NOT release', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-B' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-B', {
    sendReleaseCommand: true,   // even with the toggle on, a timeout must NOT release
    buildTimeoutMs:     10_000,
  });

  // Advance through awaiting-gateway + delivering
  await fsp.unlink(path.join(ws.orderData, 'ORD-B.txt'));
  await monitor._scanNow();
  assert.equal(monitor.getPending()[0].phase, 'building');

  // Simulate DIGIN not clearing for long enough
  clock.advance(11_000);
  await monitor._scanNow();

  assert.equal(monitor.getPending().length, 0);
  assert.equal(cb.events[0].status, 'timed_out',
    'a stuck build must NOT be treated as accepted — the containers may still be incomplete');
  // No [release] file — releasing an incomplete build would print
  // garbage.
  const cmdFiles = (await fsp.readdir(ws.orderData)).filter(n => n.startsWith('ohd_release_'));
  assert.deepEqual(cmdFiles, [],
    'no release command may be written on a build timeout, even with the release toggle on');
  monitor.stopMonitoring();
});

test('a file that vanishes before its timeout is captured on the next scan (no premature failure)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-V' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-V', { gatewayTimeoutMs: 5_000 });

  clock.advance(4_999);          // just before the timeout
  await fsp.unlink(path.join(ws.orderData, 'ORD-V.txt'));
  await monitor._scanNow();      // vanish beats the timeout

  const entry = monitor.getPending()[0];
  assert.ok(entry, 'still tracked (now in a later phase)');
  assert.notEqual(entry.phase, 'awaiting-gateway',
    'must have advanced out of awaiting-gateway rather than been marked failed');
  assert.equal(cb.events.length, 0, 'no terminal callback yet — only phase advance');
  monitor.stopMonitoring();
});

// ── Restart recovery ──────────────────────────────────────────────────────

test('restart recovery: startMonitoring rehydrates entries from the persisted store', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-R' });

  // First session — enqueue and stop before the .txt vanishes.
  const store = makeInMemoryStore();
  const clock1 = makeClock(1_000_000);
  const { monitor: m1 } = makeMonitor({ store, clock: clock1 });
  m1.startMonitoring({}, () => {});
  enqueue(m1, ws, 'ORD-R');
  m1.stopMonitoring();

  // Simulate app restart: fresh monitor + fresh callback, same store.
  const clock2 = makeClock(1_010_000);
  const { monitor: m2 } = makeMonitor({ store, clock: clock2 });
  const cb = recorderCallback();
  m2.startMonitoring({}, cb);

  const pending = m2.getPending();
  assert.equal(pending.length, 1, 'entry must be rehydrated from the persisted store');
  assert.equal(pending[0].orderId, 'ORD-R');
  assert.equal(pending[0].phase, 'awaiting-gateway',
    'phase preserved across restart');

  // Simulate OrderGateway consuming the .txt after restart.
  await fsp.unlink(path.join(ws.orderData, 'ORD-R.txt'));
  await m2._scanNow();

  assert.notEqual(m2.getPending()[0].phase, 'awaiting-gateway',
    'rehydrated entry must advance on the next scan just like a fresh entry');
  m2.stopMonitoring();
});

test('a persisted entry with a bogus phase falls back to awaiting-gateway rather than crashing', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-U' });

  const store = makeInMemoryStore({
    pending: [{
      orderId: 'ORD-U', orderRef: 'ORD-U',
      stagingFolder: ws.stagingFolder,
      orderDataPath: ws.orderData,
      diginPath:     ws.diginPath,
      phase: 'this-does-not-exist',
      submittedAt: 100, phaseStartedAt: 100,
      gatewayTimeoutMs: 30_000, buildTimeoutMs: 600_000,
    }],
  });
  const { monitor } = makeMonitor({ store });
  monitor.startMonitoring({}, () => {});
  const rehydrated = monitor.getPending()[0];
  assert.equal(rehydrated.phase, 'awaiting-gateway',
    'unknown-phase defensive fallback so a corrupt store cannot brick startup');
  monitor.stopMonitoring();
});

// ── Callback safety ──────────────────────────────────────────────────────

test('a throwing callback does not break the monitor — subsequent scans still fire callbacks', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws1 = await setupWorkspace(dir, { orderId: 'ORD-A' });
  // Second workspace under a separate scratch dir since setupWorkspace
  // creates fixed subfolder names.
  const dir2 = await makeTempDir();
  t.after(() => fsp.rm(dir2, { recursive: true, force: true }));
  const ws2 = await setupWorkspace(dir2, { orderId: 'ORD-B' });

  const events = [];
  let throwOnce = true;
  const cb = (event) => {
    if (throwOnce) {
      throwOnce = false;
      events.push({ ...event, threw: true });
      throw new Error('callback simulated failure');
    }
    events.push({ ...event, threw: false });
  };

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws1, 'ORD-A', { gatewayTimeoutMs: 5_000 });

  clock.advance(6_000);           // trip the first gateway timeout
  await monitor._scanNow();

  assert.equal(events.length, 1, 'first callback fired');
  assert.equal(events[0].threw, true);

  // Enqueue a second order — the monitor must still work.
  enqueue(monitor, ws2, 'ORD-B', {
    orderDataPath: ws2.orderData, diginPath: ws2.diginPath,
    gatewayTimeoutMs: 5_000,
  });
  clock.advance(6_000);
  await monitor._scanNow();

  assert.equal(events.length, 2, 'second callback fired — monitor survived the throw');
  assert.equal(events[1].threw, false);
  monitor.stopMonitoring();
});

// ── Lifecycle hygiene ────────────────────────────────────────────────────

test('startMonitoring is idempotent — calling twice does not leak timers or watchers', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-I' });

  const { monitor } = makeMonitor();
  monitor.startMonitoring({ orderDataPath: ws.orderData, diginPath: ws.diginPath }, () => {});
  const firstSweep    = monitor._sweepTimer;
  const firstWatchers = new Set(monitor._watchers.keys());
  monitor.startMonitoring({ orderDataPath: ws.orderData, diginPath: ws.diginPath }, () => {});
  const secondSweep    = monitor._sweepTimer;
  const secondWatchers = new Set(monitor._watchers.keys());
  assert.notEqual(firstSweep, secondSweep,
    'second start must swap in a new timer (proving the old one was cleared)');
  assert.deepEqual([...firstWatchers].sort(), [...secondWatchers].sort(),
    'watcher set is deterministic — no accumulation across starts');

  monitor.stopMonitoring();
  assert.equal(monitor._sweepTimer, null);
  assert.equal(monitor._watchers.size, 0);
});

// ── Merge Data check ─────────────────────────────────────────────────────

test('building holds until BOTH mergeData variants (`{orderId}.con` and `{orderId}/`) are absent', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-M' });
  const mergeData = path.join(dir, 'merge-data'); await fsp.mkdir(mergeData);

  const { monitor } = makeMonitor();
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-M', { mergeDataPath: mergeData });

  // Drive through awaiting-gateway + delivering.
  await fsp.unlink(path.join(ws.orderData, 'ORD-M.txt'));
  await monitor._scanNow();
  assert.equal(monitor.getPending()[0].phase, 'building');

  // Simulate PIC Pro removing the DIGIN folder but leaving containers.
  await fsp.rm(path.join(ws.diginPath, 'ORD-M'), { recursive: true, force: true });
  await fsp.writeFile(path.join(mergeData, 'ORD-M.con'), '');   // flat container
  await monitor._scanNow();
  assert.equal(monitor.getPending()[0].phase, 'building',
    'DIGIN cleared but flat `{orderId}.con` still present → still building');

  // Remove the flat container; introduce a per-order subdir.
  await fsp.unlink(path.join(mergeData, 'ORD-M.con'));
  await fsp.mkdir(path.join(mergeData, 'ORD-M'));
  await monitor._scanNow();
  assert.equal(monitor.getPending()[0].phase, 'building',
    'other variant still present → still building (spec p. 369 — the two variants depend on "Container Path Use Subdirs")');

  // Remove the subdir — build is finally complete.
  await fsp.rm(path.join(mergeData, 'ORD-M'), { recursive: true, force: true });
  await monitor._scanNow();
  assert.equal(monitor.getPending().length, 0);
  assert.equal(cb.events[0].status, 'accepted');
  monitor.stopMonitoring();
});

// ── Sweep cadence ─────────────────────────────────────────────────────────

test('sweep cadence flips between active (1s) and idle (60s) as the queue drains', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-C' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  monitor.startMonitoring({}, () => {});
  assert.equal(monitor._sweepMs, _internals.DEFAULT_IDLE_SWEEP_MS,
    'idle cadence with empty queue');

  enqueue(monitor, ws, 'ORD-C');
  assert.equal(monitor._sweepMs, _internals.DEFAULT_ACTIVE_SWEEP_MS,
    'active cadence as soon as the queue has an entry');

  // Drain the entry via a timeout to check the flip back to idle.
  clock.advance(_internals.DEFAULT_GATEWAY_TIMEOUT_MS + 1000);
  await monitor._scanNow();
  assert.equal(monitor.getPending().length, 0);
  assert.equal(monitor._sweepMs, _internals.DEFAULT_IDLE_SWEEP_MS,
    'flips back to idle when the queue empties');
  monitor.stopMonitoring();
});
