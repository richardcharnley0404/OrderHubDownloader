/**
 * Unit tests for src/main/services/fuji-jobmaker-monitor.js.
 *
 * Most assertions go through `_scanNow()` rather than waiting for fs.watch
 * to fire. fs.watch is platform-flaky (especially over network shares — which
 * is exactly where Fuji hot folders typically live) and the monitor treats
 * its periodic scan as the source of truth. Testing the scan logic directly
 * mirrors how the monitor actually delivers correctness in production.
 *
 * One integration-style test still uses fs.watch to confirm the wiring works
 * end-to-end on the local FS.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { FujiJobMakerMonitor } = require('../fuji-jobmaker-monitor');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeHotFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fuji-mon-'));
}

function writeTxt(hot, filename, body = 'data\r\n') {
  const p = path.join(hot, filename);
  fs.writeFileSync(p, body);
  return p;
}

/**
 * Start a monitor and collect every callback into an array. Stops cleanly via
 * the returned `stop()` even if assertions throw mid-test.
 */
function startCapturing(hot, opts = {}) {
  const events = [];
  const mon = new FujiJobMakerMonitor();
  mon.startMonitoring(hot, opts, (event) => events.push(event));
  return {
    mon,
    events,
    stop: () => mon.stopMonitoring(),
  };
}

// ── 1. Submission tracking ───────────────────────────────────────────────────

test('trackSubmission records the file with its orderRef + surface', () => {
  const hot = makeHotFolder();
  const { mon, stop } = startCapturing(hot);
  try {
    mon.trackSubmission({
      orderRef: 'BALLY-Q7F39E',
      surface:  'Lustre',
      filename: 'BALLY-Q7F39E_Lustre.txt',
    });
    assert.equal(mon.trackedFiles.size, 1);
  } finally { stop(); }
});

test('trackSubmission requires filename', () => {
  const hot = makeHotFolder();
  const { mon, stop } = startCapturing(hot);
  try {
    assert.throws(
      () => mon.trackSubmission({ orderRef: 'X', surface: 'Lustre' }),
      /filename/
    );
  } finally { stop(); }
});

// ── 2. Accepted (file disappears) ────────────────────────────────────────────

test("scan fires 'accepted' when a tracked file no longer exists", () => {
  const hot = makeHotFolder();
  const { mon, events, stop } = startCapturing(hot);
  try {
    // Simulate a submission: file present, registered.
    writeTxt(hot, 'BALLY-Q7F39E_Lustre.txt');
    mon.trackSubmission({
      orderRef: 'BALLY-Q7F39E',
      surface:  'Lustre',
      filename: 'BALLY-Q7F39E_Lustre.txt',
    });

    // Nothing fires while the file is still there.
    mon._scanNow();
    assert.equal(events.length, 0);

    // Frontier "consumes" the file.
    fs.unlinkSync(path.join(hot, 'BALLY-Q7F39E_Lustre.txt'));

    mon._scanNow();
    assert.equal(events.length, 1);
    assert.deepEqual(
      { orderRef: events[0].orderRef, surface: events[0].surface, status: events[0].status, filename: events[0].filename },
      { orderRef: 'BALLY-Q7F39E', surface: 'Lustre', status: 'accepted', filename: 'BALLY-Q7F39E_Lustre.txt' }
    );
    assert.ok(events[0].timestamp instanceof Date);

    // Tracked entry has been removed.
    assert.equal(mon.trackedFiles.size, 0);
  } finally { stop(); }
});

test('accepted fires only once even if subsequent scans run', () => {
  const hot = makeHotFolder();
  const { mon, events, stop } = startCapturing(hot);
  try {
    writeTxt(hot, 'X_Lustre.txt');
    mon.trackSubmission({ orderRef: 'X', surface: 'Lustre', filename: 'X_Lustre.txt' });
    fs.unlinkSync(path.join(hot, 'X_Lustre.txt'));

    mon._scanNow();
    mon._scanNow();
    mon._scanNow();

    assert.equal(events.length, 1);
  } finally { stop(); }
});

// ── 3. Timeout sweep ─────────────────────────────────────────────────────────

test("scan fires 'timed_out' for files older than failureTimeoutMs that still exist", () => {
  const hot = makeHotFolder();
  // 10-second timeout so tests are deterministic.
  const { mon, events, stop } = startCapturing(hot, { failureTimeoutMs: 10_000 });
  try {
    writeTxt(hot, 'STUCK_Lustre.txt');
    mon.trackSubmission({ orderRef: 'STUCK', surface: 'Lustre', filename: 'STUCK_Lustre.txt' });
    const submittedAt = mon.trackedFiles.get('stuck_lustre.txt').submittedAt;

    // 5s after submit — under threshold, file still present → no event.
    mon._scanNow(submittedAt + 5_000);
    assert.equal(events.length, 0);

    // 10s exactly — at threshold → fires.
    mon._scanNow(submittedAt + 10_000);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'timed_out');
    assert.equal(events[0].orderRef, 'STUCK');
    assert.equal(mon.trackedFiles.size, 0);
  } finally { stop(); }
});

test('timed_out does not fire if the file disappears before the threshold', () => {
  const hot = makeHotFolder();
  const { mon, events, stop } = startCapturing(hot, { failureTimeoutMs: 10_000 });
  try {
    writeTxt(hot, 'PASS_Lustre.txt');
    mon.trackSubmission({ orderRef: 'PASS', surface: 'Lustre', filename: 'PASS_Lustre.txt' });
    const submittedAt = mon.trackedFiles.get('pass_lustre.txt').submittedAt;

    // 5s in, Frontier consumes the file → accepted.
    fs.unlinkSync(path.join(hot, 'PASS_Lustre.txt'));
    mon._scanNow(submittedAt + 5_000);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'accepted');

    // 30s in — too late, but tracking is already cleared.
    mon._scanNow(submittedAt + 30_000);
    assert.equal(events.length, 1);
  } finally { stop(); }
});

// ── 4. Multi-surface independence ────────────────────────────────────────────

test('tracked surface files are independent — one timing out does not affect siblings', () => {
  const hot = makeHotFolder();
  const { mon, events, stop } = startCapturing(hot, { failureTimeoutMs: 10_000 });
  try {
    writeTxt(hot, 'ORDER_Lustre.txt');
    writeTxt(hot, 'ORDER_Glossy.txt');

    mon.trackSubmission({ orderRef: 'ORDER', surface: 'Lustre', filename: 'ORDER_Lustre.txt' });
    mon.trackSubmission({ orderRef: 'ORDER', surface: 'Glossy', filename: 'ORDER_Glossy.txt' });

    const submittedAt = mon.trackedFiles.get('order_lustre.txt').submittedAt;

    // Glossy is consumed quickly, Lustre is stuck.
    fs.unlinkSync(path.join(hot, 'ORDER_Glossy.txt'));
    mon._scanNow(submittedAt + 5_000);

    assert.equal(events.length, 1);
    assert.equal(events[0].surface, 'Glossy');
    assert.equal(events[0].status, 'accepted');

    // Lustre eventually times out.
    mon._scanNow(submittedAt + 11_000);

    assert.equal(events.length, 2);
    assert.equal(events[1].surface, 'Lustre');
    assert.equal(events[1].status, 'timed_out');
  } finally { stop(); }
});

// ── 5. fs.watch integration (end-to-end on local FS) ─────────────────────────

test('fs.watch accelerates detection when a tracked file is removed', async () => {
  const hot = makeHotFolder();
  const { mon, events, stop } = startCapturing(hot, {
    // Long sweep interval — we want the proof to come from fs.watch, not the timer.
    sweepIntervalMs: 60_000,
    failureTimeoutMs: 60_000,
  });
  try {
    writeTxt(hot, 'WATCH_Lustre.txt');
    mon.trackSubmission({ orderRef: 'WATCH', surface: 'Lustre', filename: 'WATCH_Lustre.txt' });

    // Trigger the watch path.
    fs.unlinkSync(path.join(hot, 'WATCH_Lustre.txt'));

    // Wait long enough for debounce (500ms) + the synchronous scan that follows.
    await new Promise((r) => setTimeout(r, 900));

    assert.equal(events.length, 1, 'fs.watch should have driven a scan');
    assert.equal(events[0].status, 'accepted');
  } finally { stop(); }
});

// ── 6. Lifecycle / safety ────────────────────────────────────────────────────

test('startMonitoring is idempotent — calling twice does not leak watchers or timers', () => {
  const hot = makeHotFolder();
  const mon = new FujiJobMakerMonitor();
  try {
    mon.startMonitoring(hot, {}, () => {});
    const firstWatcher = mon.watcher;
    const firstTimer = mon.sweepTimer;

    mon.startMonitoring(hot, {}, () => {});
    // Old timer reference should have been replaced.
    assert.notEqual(mon.sweepTimer, firstTimer);
    // Old watcher should be gone (replaced or closed).
    if (firstWatcher) {
      assert.notEqual(mon.watcher, firstWatcher);
    }
  } finally {
    mon.stopMonitoring();
  }
});

test('a throwing callback does not stop subsequent scans from working', () => {
  const hot = makeHotFolder();
  let calls = 0;
  const mon = new FujiJobMakerMonitor();
  mon.startMonitoring(hot, { failureTimeoutMs: 10_000 }, () => {
    calls += 1;
    throw new Error('callback exploded');
  });
  try {
    writeTxt(hot, 'A_Lustre.txt');
    mon.trackSubmission({ orderRef: 'A', surface: 'Lustre', filename: 'A_Lustre.txt' });
    fs.unlinkSync(path.join(hot, 'A_Lustre.txt'));

    mon._scanNow();
    assert.equal(calls, 1);

    // Second file — monitor must still work.
    writeTxt(hot, 'B_Glossy.txt');
    mon.trackSubmission({ orderRef: 'B', surface: 'Glossy', filename: 'B_Glossy.txt' });
    fs.unlinkSync(path.join(hot, 'B_Glossy.txt'));

    mon._scanNow();
    assert.equal(calls, 2);
  } finally {
    mon.stopMonitoring();
  }
});

test('stopMonitoring preserves tracked files; clearTracked drops them', () => {
  const hot = makeHotFolder();
  const mon = new FujiJobMakerMonitor();
  mon.startMonitoring(hot, {}, () => {});
  mon.trackSubmission({ orderRef: 'X', surface: 'Lustre', filename: 'X_Lustre.txt' });

  mon.stopMonitoring();
  assert.equal(mon.trackedFiles.size, 1, 'stop keeps tracking so mid-flight orders survive restart');

  mon.clearTracked();
  assert.equal(mon.trackedFiles.size, 0);
});

// ── 7. Order ref containing underscores is preserved exactly ────────────────

test('tracked file names with underscores in the orderRef are matched correctly', () => {
  const hot = makeHotFolder();
  const { mon, events, stop } = startCapturing(hot);
  try {
    // orderRef intentionally contains an underscore.
    writeTxt(hot, 'PXDEMO_091YEC-1_Lustre.txt');
    mon.trackSubmission({
      orderRef: 'PXDEMO_091YEC-1',
      surface:  'Lustre',
      filename: 'PXDEMO_091YEC-1_Lustre.txt',
    });
    fs.unlinkSync(path.join(hot, 'PXDEMO_091YEC-1_Lustre.txt'));

    mon._scanNow();
    assert.equal(events.length, 1);
    assert.equal(events[0].orderRef, 'PXDEMO_091YEC-1');
    assert.equal(events[0].surface,  'Lustre');
  } finally { stop(); }
});
