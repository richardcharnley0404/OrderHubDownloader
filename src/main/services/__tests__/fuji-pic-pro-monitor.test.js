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
 * all the paths from setupWorkspace + the monitor's own controller,
 * then simulates dispatch's post-write `markCommitted` call. Fix 11
 * split enqueue and commit into two steps; every pre-existing test
 * expects the "dispatch completed" state, so bake the commit into
 * the helper. The `fix 11 …` tests below bypass this and call
 * enqueue+commit directly to exercise the intermediate state.
 */
function enqueue(monitor, ws, orderId, overrides = {}) {
  const entry = monitor.enqueueSubmission({
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
  monitor.markCommitted(orderId);
  return entry;
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

test('awaiting-gateway → delivering when the .txt disappears from Order Data (across REQUIRED_ABSENT_OBSERVATIONS scans)', async (t) => {
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

  // Fix 3: transition requires two consecutive absent observations.
  // The first absent scan does not advance yet.
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
  const entry = monitor.getPending()[0];
  assert.ok(entry, 'entry still pending — should be in building');
  assert.equal(entry.phase, 'building',
    `must transition after ${_internals.REQUIRED_ABSENT_OBSERVATIONS} absent observations (delivering completes inline in the same scan)`);
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

  // Fast-forward through awaiting-gateway + delivering. Two scans
  // per transition per fix 3 (see REQUIRED_ABSENT_OBSERVATIONS).
  await fsp.unlink(path.join(ws.orderData, 'ORD-1.txt'));
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
  // Simulate PIC Pro consuming the DIGIN folder.
  await fsp.rm(path.join(ws.diginPath, 'ORD-1'), { recursive: true, force: true });
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }

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
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
  await fsp.rm(path.join(ws.diginPath, 'ORD-1'), { recursive: true, force: true });
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }

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

  // Advance through awaiting-gateway + delivering. Fix 3: two
  // absent observations required before advancing.
  await fsp.unlink(path.join(ws.orderData, 'ORD-B.txt'));
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
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
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    // Advance the clock a hair between observations but stay well
    // below the timeout — the fix requires N absent observations, so
    // "vanish beats the timeout" now means N observations complete
    // BEFORE the timeout window closes.
    clock.advance(1);
    await monitor._scanNow();
  }

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

  // Simulate OrderGateway consuming the .txt after restart. Fix 3:
  // absent-observation counter resets on rehydrate, so this still
  // needs the same two-scan gate as a fresh entry.
  await fsp.unlink(path.join(ws.orderData, 'ORD-R.txt'));
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await m2._scanNow();
  }

  assert.notEqual(m2.getPending()[0].phase, 'awaiting-gateway',
    'rehydrated entry must advance just like a fresh entry (both need two absent observations)');
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

// ── Fix 3 regression: existsSync=false ≠ absent ──────────────────────────

test('fix 3: awaiting-gateway does NOT advance after ONE absent observation (blip protection)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-BLIP' });

  const { monitor } = makeMonitor();
  monitor.startMonitoring({}, () => {});
  enqueue(monitor, ws, 'ORD-BLIP');

  await fsp.unlink(path.join(ws.orderData, 'ORD-BLIP.txt'));
  // Only ONE absent observation — must NOT advance.
  await monitor._scanNow();
  assert.equal(monitor.getPending()[0].phase, 'awaiting-gateway',
    'single absent observation is not enough — fix 3 requires two consecutive observations');

  // Second observation → transition. Delivering runs inline so we
  // land in building on the same scan.
  await monitor._scanNow();
  assert.equal(monitor.getPending()[0].phase, 'building');
  monitor.stopMonitoring();
});

test('fix 3: an EACCES / permission blip mid-window resets the counter, does NOT advance', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-EACCES' });

  // Inject an fs whose promises.stat throws EACCES the SECOND time
  // called for the .txt path — the first observation returns ENOENT
  // (absent) so the counter ticks to 1, the second returns 'unknown'
  // (EACCES) so the counter must reset instead of advancing.
  let statCalls = 0;
  const injectedFs = {
    ...fs,
    // fs.watch / fs.existsSync stay real — deliverToDigin uses fs directly.
    existsSync: fs.existsSync.bind(fs),
    watch:      fs.watch.bind(fs),
    promises: {
      ...fs.promises,
      stat: async (p) => {
        statCalls++;
        if (statCalls === 2) {
          const err = new Error('EACCES simulated permission blip');
          err.code = 'EACCES';
          throw err;
        }
        return fs.promises.stat(p);
      },
    },
  };

  const monitor = new FujiPicProMonitor({
    deps: { fs: injectedFs, logger: silentLogger, store: makeInMemoryStore(), clock: makeClock(), fileWriter },
  });
  monitor.startMonitoring({}, () => {});
  enqueue(monitor, ws, 'ORD-EACCES');

  // Delete the .txt so stat returns ENOENT for observations that get
  // through — but the EACCES on the 2nd stat call must reset the
  // counter.
  await fsp.unlink(path.join(ws.orderData, 'ORD-EACCES.txt'));

  await monitor._scanNow();  // call 1: absent (ENOENT) → ticks to 1
  assert.equal(monitor.getPending()[0].phase, 'awaiting-gateway');
  assert.equal(monitor.getPending()[0]._absentTicks, 1);

  await monitor._scanNow();  // call 2: 'unknown' (EACCES) → counter resets to 0
  assert.equal(monitor.getPending()[0].phase, 'awaiting-gateway',
    'permission blip must NOT trigger advancement — the whole point of fix 3');
  assert.equal(monitor.getPending()[0]._absentTicks, 0,
    'counter must reset to 0 on any non-absent classification');

  // Then two consecutive absent observations recover normally.
  await monitor._scanNow();  // call 3: absent → 1
  await monitor._scanNow();  // call 4: absent → 2 → advance
  assert.equal(monitor.getPending()[0].phase, 'building',
    'after the blip resets the counter, two clean absent observations still advance');
  monitor.stopMonitoring();
});

test('fix 3: _classifyPath returns present/absent/unknown for the three cases', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const realPath    = path.join(dir, 'exists.txt');
  const missingPath = path.join(dir, 'gone.txt');
  await fsp.writeFile(realPath, 'x');

  // Real fs against real paths for the two clear cases.
  assert.equal(await _internals._classifyPath(fs, realPath),    'present');
  assert.equal(await _internals._classifyPath(fs, missingPath), 'absent');

  // Injected fs to force the "unknown" third case (any non-ENOENT).
  const errorFs = { promises: { stat: async () => {
    const e = new Error('EIO simulated'); e.code = 'EIO'; throw e;
  } } };
  assert.equal(await _internals._classifyPath(errorFs, '/anything'), 'unknown',
    'any non-ENOENT error must map to unknown — fix 3 depends on distinguishing this from absent');
});

test('fix 3: building phase — an EACCES on the Merge Data check keeps the entry in building', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-M2' });
  const mergeData = path.join(dir, 'merge-data'); await fsp.mkdir(mergeData);

  // Only fail Merge Data stats; let DIGIN + Order Data stats succeed.
  const injectedFs = {
    ...fs,
    existsSync: fs.existsSync.bind(fs),
    watch:      fs.watch.bind(fs),
    promises: {
      ...fs.promises,
      stat: async (p) => {
        if (String(p).startsWith(mergeData)) {
          const err = new Error('EACCES on merge share'); err.code = 'EACCES';
          throw err;
        }
        return fs.promises.stat(p);
      },
    },
  };

  const monitor = new FujiPicProMonitor({
    deps: { fs: injectedFs, logger: silentLogger, store: makeInMemoryStore(), clock: makeClock(), fileWriter },
  });
  monitor.startMonitoring({}, () => {});
  enqueue(monitor, ws, 'ORD-M2', { mergeDataPath: mergeData });

  // Drive to `building`.
  await fsp.unlink(path.join(ws.orderData, 'ORD-M2.txt'));
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
  assert.equal(monitor.getPending()[0].phase, 'building');

  // Remove the DIGIN folder — but merge-data stats still throw EACCES.
  // The classifier returns 'unknown' for both merge paths so
  // mergeAbsent is false, keeping the entry in building even though
  // DIGIN is genuinely gone. `[release]` MUST NOT fire.
  await fsp.rm(path.join(ws.diginPath, 'ORD-M2'), { recursive: true, force: true });
  for (let i = 0; i < 4; i++) {
    await monitor._scanNow();
  }
  assert.equal(monitor.getPending()[0].phase, 'building',
    'EACCES on Merge Data must NOT advance to releasing — treating unknown as absent would fire [release] on an unbuilt order');
  monitor.stopMonitoring();
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

  // Drive through awaiting-gateway + delivering (two absent obs).
  await fsp.unlink(path.join(ws.orderData, 'ORD-M.txt'));
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
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

  // Remove the subdir — build is finally complete. Fix 3: two absent
  // observations required.
  await fsp.rm(path.join(mergeData, 'ORD-M'), { recursive: true, force: true });
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
  assert.equal(monitor.getPending().length, 0);
  assert.equal(cb.events[0].status, 'accepted');
  monitor.stopMonitoring();
});

// ── Fix 11 regression: two-phase enqueue → write → markCommitted ─────────

test('fix 11: an entry without txtCommitted does NOT advance even if the .txt is absent', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-UNC' });

  const { monitor } = makeMonitor();
  monitor.startMonitoring({}, () => {});
  // Enqueue WITHOUT markCommitted — simulates the mid-dispatch state
  // between `enqueueSubmission` and `markCommitted`.
  monitor.enqueueSubmission({
    orderId:             'ORD-UNC',
    orderRef:            'ORD-UNC',
    stagingFolder:       ws.stagingFolder,
    orderDataPath:       ws.orderData,
    diginPath:           ws.diginPath,
    controllerId:        'ctrl-x',
    gatewayTimeoutMs:    30_000,
    buildTimeoutMs:      600_000,
    sendReleaseCommand:  false,
    mergeDataPath:       '',
  });
  // Delete the .txt so the classifier would return absent AND the
  // 2-observation counter would tick. Pre-fix, the entry would
  // advance to delivering after two scans — moving images into
  // DIGIN with no OrderGateway order behind them.
  await fsp.unlink(path.join(ws.orderData, 'ORD-UNC.txt'));

  for (let i = 0; i < 5; i++) {
    await monitor._scanNow();
  }
  assert.equal(monitor.getPending()[0].phase, 'awaiting-gateway',
    'entry must stay in awaiting-gateway until markCommitted flips the flag');
  monitor.stopMonitoring();
});

test('fix 11: markCommitted flips the flag AND resets phaseStartedAt from commit time', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-MC' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  monitor.startMonitoring({}, () => {});
  monitor.enqueueSubmission({
    orderId:'ORD-MC', orderRef:'ORD-MC',
    stagingFolder: ws.stagingFolder, orderDataPath: ws.orderData, diginPath: ws.diginPath,
    controllerId: 'x', gatewayTimeoutMs: 5_000, buildTimeoutMs: 600_000, sendReleaseCommand: false,
  });
  const startedAtBefore = monitor.getPending()[0].phaseStartedAt;
  clock.advance(1_000);
  monitor.markCommitted('ORD-MC');
  const startedAtAfter = monitor.getPending()[0].phaseStartedAt;

  assert.equal(monitor.getPending()[0].txtCommitted, true);
  assert.notEqual(startedAtBefore, startedAtAfter,
    'phaseStartedAt must reset from the commit moment so gateway timeout measures from when OrderGateway can actually act');
  monitor.stopMonitoring();
});

test('fix 11: an uncommitted entry that ages past gatewayTimeoutMs is resolved as failed', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-STUCK' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  monitor.enqueueSubmission({
    orderId: 'ORD-STUCK', orderRef: 'ORD-STUCK',
    stagingFolder: ws.stagingFolder, orderDataPath: ws.orderData, diginPath: ws.diginPath,
    controllerId: 'x', gatewayTimeoutMs: 5_000, buildTimeoutMs: 600_000, sendReleaseCommand: false,
  });
  // Simulate a crash between enqueue and write: markCommitted is
  // NEVER called. The entry should time out via the existing
  // gateway timeout.
  clock.advance(6_000);
  await monitor._scanNow();

  assert.equal(monitor.getPending().length, 0);
  assert.equal(cb.events[0].status, 'failed',
    'stranded-uncommitted entry must eventually resolve as failed rather than sit forever');
  monitor.stopMonitoring();
});

test('fix 11: dequeue removes an entry without firing a callback', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-DQ' });

  const { monitor } = makeMonitor();
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-DQ');
  assert.equal(monitor.getPending().length, 1);

  const removed = monitor.dequeue('ORD-DQ');
  assert.equal(removed, true);
  assert.equal(monitor.getPending().length, 0);
  assert.equal(cb.events.length, 0,
    'dequeue must be silent — the dispatch caller handles the error surfacing directly');

  // Unknown id returns false without throwing.
  assert.equal(monitor.dequeue('nope'), false);
  monitor.stopMonitoring();
});

test('fix 11 part B: gateway timeout best-effort unlinks the .txt', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-CLEANUP' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  monitor.startMonitoring({}, () => {});
  enqueue(monitor, ws, 'ORD-CLEANUP', { gatewayTimeoutMs: 5_000 });

  // The .txt is still on disk (setupWorkspace writes it). Simulate
  // OrderGateway never consuming: clock past the timeout.
  clock.advance(6_000);
  await monitor._scanNow();

  assert.equal(monitor.getPending().length, 0);
  assert.equal(fs.existsSync(path.join(ws.orderData, 'ORD-CLEANUP.txt')), false,
    'gateway-timeout cleanup must unlink the abandoned .txt so OrderGateway does not later pick up an order OHD gave up on');
  monitor.stopMonitoring();
});

// ── Fix 9 regression: enqueueSubmission dedupe ───────────────────────────

test('fix 9: enqueueSubmission throws on a duplicate orderId (does not silently overwrite)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-DUP' });

  const { monitor } = makeMonitor();
  monitor.startMonitoring({}, () => {});
  enqueue(monitor, ws, 'ORD-DUP');

  // Second dispatch with the same orderId while the first is still
  // in-flight must fail loudly. Pre-fix `.set()` overwrote silently,
  // dropping the first entry's [release] / timeout tracking while
  // new staging writes ran into the folder the first delivery was
  // still renaming.
  let caught = null;
  try {
    enqueue(monitor, ws, 'ORD-DUP');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'duplicate enqueue must throw');
  assert.equal(caught.code, 'FUJI_PICPRO_DUPLICATE_SUBMISSION');
  assert.match(caught.message, /already in-flight/);
  assert.equal(caught.existingPhase, 'awaiting-gateway',
    'the throw includes the phase of the existing entry so the caller can log meaningfully');

  // Queue still holds exactly one entry — the ORIGINAL — not a
  // silently-replaced second one.
  assert.equal(monitor.getPending().length, 1);
  monitor.stopMonitoring();
});

test('fix 9: enqueue succeeds again after the previous entry resolves (fresh retry allowed)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-REDO' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  monitor.startMonitoring({}, () => {});
  enqueue(monitor, ws, 'ORD-REDO', { gatewayTimeoutMs: 5_000 });

  // Timeout the first entry → resolved as `failed` → dropped from
  // the queue. The dedupe check must NOT block a subsequent legit
  // dispatch with the same orderId.
  clock.advance(6_000);
  await monitor._scanNow();
  assert.equal(monitor.getPending().length, 0, 'first entry resolved');

  assert.doesNotThrow(() => enqueue(monitor, ws, 'ORD-REDO'),
    'a fresh dispatch of the same orderId after the previous entry resolved must be allowed');
  monitor.stopMonitoring();
});

// ── Fix 6 regression: per-controller pending store namespace ──────────────

test('fix 6: two monitors on different controllers get different store filenames', async (t) => {
  // Instantiate two monitors with a factory-shim `store` that records
  // its own name → prove that each monitor sees a distinct
  // namespaced file. Without fix 6 both would open
  // fuji-picpro-pending.json and each `_persist()` would erase the
  // other's queue.
  const storesByName = new Map();
  // Track the file name each Store instance was opened with. We
  // build a fake electron-store constructor that records the name
  // it receives — the monitor's own `deps.store` accepts a
  // ready-made store, so we test the lazy-created branch by NOT
  // passing `deps.store`. Instead we override the real electron-store
  // constructor via Module.prototype.require.
  const Module = require('node:module');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (req) {
    if (req === 'electron-store') {
      return function FakeStore(opts) {
        const name = opts && opts.name;
        const data = {};
        const impl = {
          _name: name,
          get: (k, d) => (k in data ? data[k] : d),
          set: (k, v) => { data[k] = v; },
          delete: (k) => { delete data[k]; },
          has: (k) => k in data,
          _dump: () => ({ ...data }),
        };
        storesByName.set(name, impl);
        return impl;
      };
    }
    return originalRequire.apply(this, arguments);
  };
  t.after(() => { Module.prototype.require = originalRequire; });

  // Clear the module cache so the monitor re-imports electron-store
  // through our shim.
  const monitorModulePath = require.resolve('../fuji-pic-pro-monitor');
  delete require.cache[monitorModulePath];
  const { FujiPicProMonitor: FreshMonitor } = require('../fuji-pic-pro-monitor');
  t.after(() => { delete require.cache[monitorModulePath]; });

  const m1 = new FreshMonitor({ deps: { fs, logger: silentLogger, clock: makeClock(), fileWriter } });
  const m2 = new FreshMonitor({ deps: { fs, logger: silentLogger, clock: makeClock(), fileWriter } });

  // Start with distinct controller ids → each triggers _getStore()
  // via _loadFromStore → each creates a FakeStore with a namespaced
  // filename.
  m1.startMonitoring({ id: 'ctrl-lab1' }, () => {});
  m2.startMonitoring({ id: 'ctrl-lab2' }, () => {});

  assert.ok(storesByName.has('fuji-picpro-pending-ctrl-lab1'),
    'ctrl-lab1 must open its own namespaced store file');
  assert.ok(storesByName.has('fuji-picpro-pending-ctrl-lab2'),
    'ctrl-lab2 must open its own namespaced store file — pre-fix both would share fuji-picpro-pending.json');

  m1.stopMonitoring();
  m2.stopMonitoring();
});

test('fix 6: filename sanitiser strips path-traversal characters', () => {
  const s = _internals._sanitiseControllerIdForStoreName;
  assert.equal(s('normal-uuid-1234'), 'normal-uuid-1234');
  assert.equal(s('bf223599-e586-4ce9'), 'bf223599-e586-4ce9', 'UUIDs pass through unchanged');
  assert.equal(s('../etc/passwd'), '___etc_passwd',
    'path traversal characters must be replaced — the sanitiser is the last line of defense before electron-store makes it a filename');
  assert.equal(s('a\\b/c'), 'a_b_c');
  assert.equal(s(''), 'unassigned', 'blank id falls back to a sentinel rather than an empty filename');
  assert.equal(s(null), 'unassigned');
  assert.equal(s('x'.repeat(200)).length, 128, 'clamped to a reasonable max length');
});

// ── Fix 5 regression: _scan reentrancy guard ─────────────────────────────

test('fix 5: concurrent _scan invocations do not double-run the same entry (in-flight guard)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-CONC' });

  // Inject a fileWriter whose deliverToDigin is slow — 50 ms of
  // await — so the second _scan tick fires while the first is
  // still inside the delivering step. Without the in-flight guard
  // the second scan would call deliverToDigin a second time and
  // either half-copy a folder or error on a name collision.
  let deliverToDiginCalls = 0;
  const slowFileWriter = {
    ...fileWriter,
    deliverToDigin: async (args) => {
      deliverToDiginCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return fileWriter.deliverToDigin(args);
    },
  };

  const monitor = new FujiPicProMonitor({
    deps: { fs, logger: silentLogger, store: makeInMemoryStore(), clock: makeClock(), fileWriter: slowFileWriter },
  });
  monitor.startMonitoring({}, () => {});
  enqueue(monitor, ws, 'ORD-CONC');

  // Get the entry past awaiting-gateway so the next scan enters
  // `delivering` — that's where the slow move happens.
  await fsp.unlink(path.join(ws.orderData, 'ORD-CONC.txt'));
  await monitor._scanNow();  // absent count 1
  // Fire two scans concurrently. The second one should see
  // _scanInFlight === true and return immediately.
  const [first, second] = await Promise.all([
    monitor._scanNow(),      // advances counter to 2 → delivering → slow move → building
    monitor._scanNow(),      // must short-circuit (guard set by first)
  ]);
  void first; void second;

  assert.equal(deliverToDiginCalls, 1,
    'deliverToDigin must run exactly once even when two scans race — the fix 5 in-flight guard is what makes this true');
  assert.equal(monitor.getPending()[0].phase, 'building',
    'entry must advance normally despite the guarded second call');
  monitor.stopMonitoring();
});

test('fix 5: _scanInFlight is cleared even when a scan throws (no permanent lock)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-BOOM' });

  const explodingFileWriter = {
    ...fileWriter,
    deliverToDigin: async () => { throw new Error('simulated fatal delivery error'); },
  };
  const monitor = new FujiPicProMonitor({
    deps: { fs, logger: silentLogger, store: makeInMemoryStore(), clock: makeClock(), fileWriter: explodingFileWriter },
  });
  monitor.startMonitoring({}, () => {});
  enqueue(monitor, ws, 'ORD-BOOM');

  await fsp.unlink(path.join(ws.orderData, 'ORD-BOOM.txt'));
  // Two observations to reach `delivering`; the delivering step
  // throws, the entry is resolved as `failed`, and the guard MUST
  // clear so the next scan can process fresh work.
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
  assert.equal(monitor._scanInFlight, false,
    'the finally block must clear _scanInFlight even after an exception path');

  // Enqueue a new order and confirm the monitor still processes it.
  const ws2 = await setupWorkspace(await makeTempDir(), { orderId: 'ORD-NEXT' });
  t.after(() => fsp.rm(path.dirname(ws2.orderData), { recursive: true, force: true }));
  enqueue(monitor, ws2, 'ORD-NEXT');
  await monitor._scanNow();
  assert.equal(monitor.getPending().length, 1,
    'monitor stays functional post-exception — the guard is not stuck');
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

// ── 1.15.3 silent-stall fix (C) ──────────────────────────────────────────
//
// The monitor emits `errorMessage` and `jobIds` on every failure /
// timed_out callback so the print-controller-service adapter can call
// jobService.updateJobLocally({_status:'error',_errorMessage}) instead
// of letting the job sit at "in production" indefinitely. These tests
// lock the exact wording per site (per the task brief — every message
// gets its own test) and the jobIds threading.

test('1.15.3 silent-stall: enqueueSubmission persists jobIds on the entry', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-JIDS' });

  const { monitor } = makeMonitor();
  monitor.startMonitoring({}, () => {});
  const entry = monitor.enqueueSubmission({
    orderId:       'ORD-JIDS',
    orderRef:      'ORD-JIDS',
    stagingFolder: ws.stagingFolder,
    orderDataPath: ws.orderData,
    diginPath:     ws.diginPath,
    controllerId:  'ctrl-jids',
    jobIds:        ['job-1', 'job-2', 'job-3'],
  });
  assert.deepEqual(entry.jobIds, ['job-1', 'job-2', 'job-3'],
    'entry must record jobIds so the terminal callback can name every job to error');

  const pending = monitor.getPending()[0];
  assert.deepEqual(pending.jobIds, ['job-1', 'job-2', 'job-3'],
    'persisted entry carries jobIds through rehydrate');
  monitor.stopMonitoring();
});

test('1.15.3 silent-stall: enqueueSubmission defaults jobIds to [] when caller omits (reprint pattern)', async (t) => {
  // Reprints do NOT stamp the parent job to error on failure. This
  // locks the default so a caller that forgets to pass jobIds
  // doesn't accidentally trigger the wrong parent-error behaviour.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-DEF' });

  const { monitor } = makeMonitor();
  monitor.startMonitoring({}, () => {});
  const entry = monitor.enqueueSubmission({
    orderId:       'ORD-DEF',
    orderRef:      'ORD-DEF',
    stagingFolder: ws.stagingFolder,
    orderDataPath: ws.orderData,
    diginPath:     ws.diginPath,
    controllerId:  'ctrl-def',
  });
  assert.deepEqual(entry.jobIds, []);
  monitor.stopMonitoring();
});

test('1.15.3 silent-stall: gateway-timeout callback carries jobIds AND an operator-readable errorMessage', async (t) => {
  // Message must name (a) the orderId, (b) the timeout in seconds,
  // (c) the configured Order Data path, and (d) suggest checking
  // OrderGateway.exe. Each of these is a piece of information the
  // lab operator needs to act on the failure without opening the
  // Activity Log.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-GT' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-GT', { gatewayTimeoutMs: 5_000 });

  // Force the gateway timeout branch by leaving the .txt in place.
  clock.advance(6_000);
  await monitor._scanNow();

  assert.equal(cb.events[0].status, 'failed');
  assert.deepEqual(cb.events[0].jobIds, [],
    'jobIds echoed on the event so the adapter can iterate them');
  assert.match(cb.events[0].errorMessage, /ORD-GT/,
    'errorMessage names the orderId');
  assert.match(cb.events[0].errorMessage, /5s/,
    'errorMessage names the actual timeout in seconds (5000ms → 5s)');
  assert.match(cb.events[0].errorMessage, /OrderGateway\.exe/,
    'errorMessage points the operator at OrderGateway.exe');
  assert.match(
    cb.events[0].errorMessage,
    new RegExp(ws.orderData.replace(/[\\/]/g, '\\$&')),
    'errorMessage names the configured Order Data path');
  monitor.stopMonitoring();
});

test('1.15.3 silent-stall: build-timeout callback carries an operator-readable errorMessage naming DIGIN + minutes', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-BT' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-BT', {
    buildTimeoutMs: 600_000,
    // No mergeDataPath — locks the "no merge suffix" branch too.
  });

  // Advance through awaiting-gateway + delivering.
  await fsp.unlink(path.join(ws.orderData, 'ORD-BT.txt'));
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
  assert.equal(monitor.getPending()[0].phase, 'building');

  // Cross the build timeout with DIGIN still holding the folder.
  clock.advance(601_000);
  await monitor._scanNow();

  assert.equal(cb.events[0].status, 'timed_out',
    'a stuck build is timed_out, not failed');
  assert.match(cb.events[0].errorMessage, /ORD-BT/);
  assert.match(cb.events[0].errorMessage, /10 minutes/,
    'errorMessage names the build timeout as minutes (600000ms → 10 min)');
  assert.match(cb.events[0].errorMessage,
    new RegExp(ws.diginPath.replace(/[\\/]/g, '\\$&')),
    'errorMessage names the DIGIN path so the operator knows where to look');
  assert.match(cb.events[0].errorMessage, /No \[release\] command was sent/,
    'errorMessage tells the operator that no [release] was written (no accidental print of an incomplete build)');
  monitor.stopMonitoring();
});

test('1.15.3 silent-stall: txt-commit gap → operator-readable errorMessage names the abort condition', async (t) => {
  // The txtCommitted-false timeout branch fires when dispatch crashed
  // between enqueueSubmission and writeOrderFile. Message must say
  // WHAT happened and WHAT the operator should do (retry).
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-COMMIT' });

  const clock = makeClock(1_000_000);
  const { monitor } = makeMonitor({ clock });
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  // Enqueue directly, do NOT call markCommitted — simulates the
  // dispatch-crashed-between-enqueue-and-write state.
  monitor.enqueueSubmission({
    orderId:       'ORD-COMMIT',
    orderRef:      'ORD-COMMIT',
    stagingFolder: ws.stagingFolder,
    orderDataPath: ws.orderData,
    diginPath:     ws.diginPath,
    controllerId:  'ctrl-commit',
    gatewayTimeoutMs: 5_000,
  });

  clock.advance(6_000);
  await monitor._scanNow();

  assert.equal(cb.events[0].status, 'failed');
  assert.match(cb.events[0].errorMessage, /ORD-COMMIT/);
  assert.match(cb.events[0].errorMessage, /between the enqueue and the \.txt write/,
    'errorMessage explains the specific abort condition');
  assert.match(cb.events[0].errorMessage, /Retry the dispatch/,
    'errorMessage tells the operator to retry');
  monitor.stopMonitoring();
});

test('1.15.3 silent-stall: delivery-failure callback propagates the writer\'s specific error message', async (t) => {
  // The writer throws domain-specific errors (EXDEV pre-1.15.3
  // co-location, EPERM, EACCES, "diginPath does not exist", etc.).
  // The monitor must NOT swallow these into a generic "delivery
  // failed" — the specific message is what the operator needs.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-DF' });

  const clock = makeClock(1_000_000);
  // Inject a file writer whose deliverToDigin throws a specific
  // error, so we lock the propagation regardless of what the real
  // writer emits today.
  const fakeWriter = {
    ...fileWriter,
    deliverToDigin: async () => {
      throw new Error('SPECIFIC-WRITER-ERROR-MESSAGE-abc123');
    },
  };
  const store  = makeInMemoryStore();
  const monitor = new FujiPicProMonitor({
    deps: { store, logger: silentLogger, clock, fs, fileWriter: fakeWriter },
  });

  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-DF');

  await fsp.unlink(path.join(ws.orderData, 'ORD-DF.txt'));
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }

  assert.equal(cb.events[0].status, 'failed');
  assert.match(cb.events[0].errorMessage, /SPECIFIC-WRITER-ERROR-MESSAGE-abc123/,
    'the writer error text reaches the callback verbatim so the operator sees the exact reason');
  monitor.stopMonitoring();
});

test('1.15.3 silent-stall: accepted callback has null errorMessage (no false positives on happy path)', async (t) => {
  // Locks that a successful delivery does NOT set errorMessage to
  // something truthy, which would cause the adapter to error the
  // job even after acceptance. Regression guard against a future
  // refactor that leaks a stale err through the wrong branch.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await setupWorkspace(dir, { orderId: 'ORD-HAPPY' });

  const { monitor } = makeMonitor();
  const cb = recorderCallback();
  monitor.startMonitoring({}, cb);
  enqueue(monitor, ws, 'ORD-HAPPY');

  await fsp.unlink(path.join(ws.orderData, 'ORD-HAPPY.txt'));
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }
  await fsp.rm(path.join(ws.diginPath, 'ORD-HAPPY'), { recursive: true, force: true });
  for (let i = 0; i < _internals.REQUIRED_ABSENT_OBSERVATIONS; i++) {
    await monitor._scanNow();
  }

  assert.equal(cb.events[0].status, 'accepted');
  assert.equal(cb.events[0].errorMessage, null,
    'accepted callbacks must NOT carry an error message');
  monitor.stopMonitoring();
});
