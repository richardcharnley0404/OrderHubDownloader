'use strict';

/**
 * Unit tests for ftp-source-scheduler (M3 of docs/ftp-sources-brief.md).
 *
 * Strategy: fake timers via injected setInterval/clearInterval that
 * return opaque tokens and let the test explicitly fire ticks. No
 * `node:test.mock.timers` — the injected fake gives finer control
 * over which token fires and lets us assert on token identity
 * (unchanged-on-keep is invariant 4).
 *
 * The runner is a spy — tests inject a `runPass` that records every
 * source object it receives and can hold an unresolved promise to
 * simulate a slow FTP server (the overlap-skip test).
 *
 * Every invariant listed in the file docblock of
 * ftp-source-scheduler.js has at least one test here.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const os     = require('os');
const Module = require('node:module');

// Same electron-stub pattern as ftp-source-service.test.js —
// ftp-source-scheduler top-imports `./ftp-source-service`, which
// top-imports `./logger`, which top-imports `electron`.
const __origRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), on: () => {} },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
    };
  }
  return __origRequire.apply(this, arguments);
};

const { FtpSourceScheduler } = require('../ftp-source-scheduler');

Module.prototype.require = __origRequire;

// ── Fake timers ────────────────────────────────────────────────────────────

/**
 * A minimal fake `setInterval` / `clearInterval` pair that records
 * every timer and lets tests fire them on demand. Each timer returns
 * an opaque token object shaped like a real Node Timeout (has
 * `.unref()`), so the scheduler's `typeof timer.unref === 'function'`
 * branch runs the same way it does in production.
 */
function makeFakeTimers() {
  let nextId = 1;
  // Map<tokenObj, { fn, ms, unrefCalls }>
  const state = new Map();

  const api = {
    setInterval(fn, ms) {
      const token = { _id: nextId++ };
      token.unref = () => {
        const entry = state.get(token);
        if (entry) entry.unrefCalls++;
        return token;   // matches real Timeout return
      };
      state.set(token, { fn, ms, unrefCalls: 0 });
      return token;
    },
    clearInterval(token) {
      state.delete(token);
    },
    // Test-only introspection
    tokens()      { return Array.from(state.keys()); },
    intervalsMs() { return Array.from(state.values()).map((e) => e.ms); },
    unrefCallsFor(token) {
      const e = state.get(token);
      return e ? e.unrefCalls : 0;
    },
    async fire(token) {
      const entry = state.get(token);
      if (!entry) throw new Error(`fire(): no timer for token ${JSON.stringify(token)}`);
      await entry.fn();
    },
    size() { return state.size; },
  };
  return api;
}

/**
 * A pass-runner spy. Records every `runPass(source)` call. Can be
 * configured to return a specific summary or to hold an unresolved
 * promise so tests can drive the "still running when timer fires again"
 * overlap-skip case.
 */
function makeRunPassSpy(options = {}) {
  const calls = [];
  let holdResolver = null;
  const spy = async function (source) {
    calls.push(source);
    if (options.holdForever) {
      // Never resolves until the caller flips it via `resolveHold()`.
      return new Promise((resolve) => { holdResolver = resolve; });
    }
    if (options.throw) throw options.throw;
    return options.summary || { moved: 0, skipped: 0, failed: 0, errors: [] };
  };
  spy.calls = calls;
  spy.resolveHold = (summary = { moved: 0, skipped: 0, failed: 0, errors: [] }) => {
    if (holdResolver) { holdResolver(summary); holdResolver = null; }
  };
  return spy;
}

function makeLogger() {
  return {
    infoCalls:  [],
    warnCalls:  [],
    errorCalls: [],
    debugCalls: [],
    info:  function (msg, meta) { this.infoCalls.push({ msg, meta }); },
    warn:  function (msg, meta) { this.warnCalls.push({ msg, meta }); },
    error: function (msg, meta) { this.errorCalls.push({ msg, meta }); },
    debug: function (msg, meta) { this.debugCalls.push({ msg, meta }); },
    logInfo:    function (msg, meta) { this.infoCalls.push({ msg, meta }); },
    logWarning: function (msg, meta) { this.warnCalls.push({ msg, meta }); },
    logError:   function (msg, err, meta) { this.errorCalls.push({ msg, err, meta }); },
    logDebug:   function (msg, meta) { this.debugCalls.push({ msg, meta }); },
  };
}

function makeSource(overrides = {}) {
  return {
    id:                  'src-1',
    name:                'Test Source',
    enabled:             true,
    host:                'ftp.example.com',
    port:                21,
    username:            'u',
    passwordEncrypted:   'ENC[abc]',
    secure:              false,
    remotePath:          '/remote',
    localPath:           'C:/local',
    intervalMinutes:     5,
    deleteAfterDownload: true,
    ...overrides,
  };
}

function makeScheduler(overrides = {}) {
  const timers  = makeFakeTimers();
  const runPass = overrides.runPass || makeRunPassSpy();
  const log     = overrides.log     || makeLogger();
  const now     = overrides.now     || (() => 1_700_000_000_000);   // deterministic
  const sched   = new FtpSourceScheduler({
    setInterval:   timers.setInterval,
    clearInterval: timers.clearInterval,
    runPass,
    logger:        log,
    now,
  });
  return { sched, timers, runPass, log, now };
}

// ── Invariant 1: .unref() on every timer ───────────────────────────────────

test('every created timer has .unref() called exactly once — FTP polling must not hold the process open', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([
    makeSource({ id: 'a', intervalMinutes: 5 }),
    makeSource({ id: 'b', intervalMinutes: 7, name: 'B' }),
  ]);
  const [t1, t2] = timers.tokens();
  assert.equal(timers.unrefCallsFor(t1), 1, 'first timer unref\'d');
  assert.equal(timers.unrefCallsFor(t2), 1, 'second timer unref\'d');
});

// ── Invariant 2: no pass runs on reconcile ────────────────────────────────

test('reconcile does NOT invoke runPass — first pass fires on first tick per brief §M3', () => {
  const { sched, runPass } = makeScheduler();
  sched.reconcile([makeSource()]);
  assert.equal(runPass.calls.length, 0, 'reconcile is a pure schedule mutation');
});

// ── Basic scheduling ───────────────────────────────────────────────────────

test('one timer per enabled source, at that source\'s own intervalMinutes', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([
    makeSource({ id: 'a', intervalMinutes: 3 }),
    makeSource({ id: 'b', intervalMinutes: 15, name: 'B' }),
  ]);
  assert.equal(timers.size(), 2);
  // interval in ms == minutes * 60_000
  const ms = timers.intervalsMs().sort((x, y) => x - y);
  assert.deepEqual(ms, [3 * 60_000, 15 * 60_000]);
});

test('disabled sources get no timer', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([
    makeSource({ id: 'a', enabled: true }),
    makeSource({ id: 'b', enabled: false, name: 'B' }),
  ]);
  assert.equal(timers.size(), 1, 'only the enabled source scheduled');
  assert.deepEqual([...sched._activeSourceIds()], ['a']);
});

test('empty source list is a no-op — no timers created', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([]);
  assert.equal(timers.size(), 0);
});

test('nullish / non-array input tolerated (defensive) — no timers, no throw', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile(null);
  sched.reconcile(undefined);
  sched.reconcile('not-an-array');
  assert.equal(timers.size(), 0);
});

// ── Reconcile transitions (invariant 4 hidden test lives further down) ─────

test('reconcile add: new source between passes → new timer, existing left alone', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([makeSource({ id: 'a' })]);
  const tokenA1 = timers.tokens()[0];

  sched.reconcile([
    makeSource({ id: 'a' }),
    makeSource({ id: 'b', name: 'B' }),
  ]);
  assert.equal(timers.size(), 2);
  const tokenA2 = timers.tokens().find((t) => t === tokenA1);
  assert.strictEqual(tokenA2, tokenA1, 'existing source\'s timer must be reused');
});

test('reconcile remove: source deleted → timer cleared, no leak', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([
    makeSource({ id: 'a' }),
    makeSource({ id: 'b', name: 'B' }),
  ]);
  assert.equal(timers.size(), 2);

  sched.reconcile([makeSource({ id: 'a' })]);   // b removed
  assert.equal(timers.size(), 1, 'removed source\'s timer must be cleared, not orphaned');
  assert.deepEqual([...sched._activeSourceIds()], ['a']);
});

test('reconcile disable: source flipped enabled:false → timer cleared', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([makeSource({ id: 'a' })]);
  assert.equal(timers.size(), 1);

  sched.reconcile([makeSource({ id: 'a', enabled: false })]);
  assert.equal(timers.size(), 0, 'disabled source is treated as removed');
});

test('reconcile re-enable: previously-disabled source enabled → fresh timer', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([makeSource({ id: 'a', enabled: false })]);
  assert.equal(timers.size(), 0);

  sched.reconcile([makeSource({ id: 'a', enabled: true })]);
  assert.equal(timers.size(), 1);
});

test('reconcile re-interval: interval changed → old timer cleared, new one at the new interval', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([makeSource({ id: 'a', intervalMinutes: 5 })]);
  const tokenOld = timers.tokens()[0];
  assert.equal(timers.intervalsMs()[0], 5 * 60_000);

  sched.reconcile([makeSource({ id: 'a', intervalMinutes: 10 })]);
  const tokenNew = timers.tokens()[0];
  assert.notStrictEqual(tokenNew, tokenOld, 'interval change restarts the timer');
  assert.equal(timers.intervalsMs()[0], 10 * 60_000);
  assert.equal(timers.size(), 1, 'no leak — exactly one timer for this source');
});

// ── Invariant 4: source-swap on keep ───────────────────────────────────────

test('reconcile mid-schedule swaps the source object even when the timer is kept (invariant 4)', async () => {
  // The test the user specifically asked for. Change the password and
  // remotePath but NOT the interval. Reconcile. Fire the timer. The
  // pass must receive the NEW source, and the timer token must be
  // unchanged.
  const runPass = makeRunPassSpy();
  const { sched, timers } = makeScheduler({ runPass });

  const before = makeSource({
    id:                'src-swap',
    passwordEncrypted: 'ENC[OLD-cred]',
    remotePath:        '/old/path',
    intervalMinutes:   5,
  });
  sched.reconcile([before]);
  const tokenBefore = timers.tokens()[0];

  const after = makeSource({
    id:                'src-swap',
    passwordEncrypted: 'ENC[NEW-cred]',
    remotePath:        '/new/path',
    intervalMinutes:   5,   // UNCHANGED
  });
  sched.reconcile([after]);
  const tokenAfter = timers.tokens()[0];

  assert.strictEqual(tokenAfter, tokenBefore,
    'timer token MUST be unchanged when the interval didn\'t change');
  assert.equal(timers.size(), 1, 'no orphaned timer');

  // Fire the timer — the pass must see the NEW source.
  await timers.fire(tokenAfter);
  assert.equal(runPass.calls.length, 1);
  assert.equal(runPass.calls[0].passwordEncrypted, 'ENC[NEW-cred]',
    'next tick must use the updated credentials');
  assert.equal(runPass.calls[0].remotePath, '/new/path',
    'next tick must use the updated remotePath');
});

test('reconcile mid-schedule swaps host / username / localPath / deleteAfterDownload too', async () => {
  // Extends the swap invariant beyond credentials to every field that
  // affects the mover. If any of these silently kept its old value
  // after reconcile, an operator's edit would appear to save but never
  // take effect until the next interval change.
  const runPass = makeRunPassSpy();
  const { sched, timers } = makeScheduler({ runPass });

  sched.reconcile([makeSource({
    id: 'src-1',
    host:                'old.example.com',
    username:            'old-user',
    localPath:           'C:/old-local',
    deleteAfterDownload: true,
    intervalMinutes:     10,
  })]);
  const token = timers.tokens()[0];

  sched.reconcile([makeSource({
    id: 'src-1',
    host:                'new.example.com',
    username:            'new-user',
    localPath:           'D:/new-local',
    deleteAfterDownload: false,
    intervalMinutes:     10,   // still unchanged
  })]);
  assert.strictEqual(timers.tokens()[0], token, 'same timer');

  await timers.fire(token);
  const seen = runPass.calls[0];
  assert.equal(seen.host,                'new.example.com');
  assert.equal(seen.username,            'new-user');
  assert.equal(seen.localPath,           'D:/new-local');
  assert.equal(seen.deleteAfterDownload, false);
});

// ── Invariant 3: no overlap ────────────────────────────────────────────────

test('overlapping tick is skipped — previous pass still running → new pass NOT invoked, debug log fires', async () => {
  // Hold the first pass unresolved to simulate a hung FTP server, then
  // fire the timer a second time and assert the mover is NOT invoked
  // again.
  const runPass = makeRunPassSpy({ holdForever: true });
  const log     = makeLogger();
  const { sched, timers } = makeScheduler({ runPass, log });
  sched.reconcile([makeSource({ id: 'slow' })]);
  const token = timers.tokens()[0];

  // First fire — pass starts and does not resolve.
  // Do NOT await it (would wait forever); just kick it off.
  const firstTick = timers.fire(token);
  // Yield so the tick's async body has a chance to set `running = true`.
  await Promise.resolve();
  assert.equal(runPass.calls.length, 1, 'first tick invoked runPass');
  assert.equal(sched._isRunning('slow'), true, 'internal running flag set');

  // Second fire — MUST be a no-op.
  await timers.fire(token);
  assert.equal(runPass.calls.length, 1, 'overlapping tick did NOT invoke runPass again');
  assert.equal(log.debugCalls.length, 1, 'skip logged at debug');
  assert.match(log.debugCalls[0].msg, /tick skipped/);
  assert.equal(log.debugCalls[0].meta.sourceName, 'Test Source');

  // Let the first pass finish so we don't leave a pending promise.
  runPass.resolveHold();
  await firstTick;
  assert.equal(sched._isRunning('slow'), false, 'running flag cleared after first pass finished');
});

test('after a running pass finishes, the next tick runs normally', async () => {
  const runPass = makeRunPassSpy();   // resolves immediately
  const { sched, timers } = makeScheduler({ runPass });
  sched.reconcile([makeSource()]);
  const token = timers.tokens()[0];

  await timers.fire(token);
  assert.equal(runPass.calls.length, 1);
  assert.equal(sched._isRunning('src-1'), false);

  await timers.fire(token);
  assert.equal(runPass.calls.length, 2, 'second tick after first finished must fire');
});

test('runPass throw does NOT leave `running` stuck true (unexpected-throw safety)', async () => {
  const runPass = makeRunPassSpy({ throw: new Error('nope') });
  const log     = makeLogger();
  const { sched, timers } = makeScheduler({ runPass, log });
  sched.reconcile([makeSource()]);
  const token = timers.tokens()[0];

  await timers.fire(token);
  assert.equal(runPass.calls.length, 1);
  assert.equal(sched._isRunning('src-1'), false,
    'even a throwing runPass must not permanently mute this source');
  assert.equal(log.errorCalls.length, 1, 'unexpected throw logged at error');
  assert.match(log.errorCalls[0].msg, /runPass threw/);

  // Next tick still works.
  runPass.calls.length = 0;   // reset spy for clarity
  await timers.fire(token);
  assert.equal(runPass.calls.length, 1, 'next tick runs after a throw');
});

// ── Pass summary logging (M3-scope) ────────────────────────────────────────

test('pass complete logs one INFO summary with counts', async () => {
  const runPass = makeRunPassSpy({
    summary: { moved: 3, skipped: 1, failed: 2, errors: [{ filename: 'a', message: 'x' }, { filename: null, message: 'pass' }] },
  });
  const log = makeLogger();
  const { sched, timers } = makeScheduler({ runPass, log });
  sched.reconcile([makeSource()]);
  await timers.fire(timers.tokens()[0]);

  assert.equal(log.infoCalls.length, 1);
  assert.match(log.infoCalls[0].msg, /pass complete/);
  assert.equal(log.infoCalls[0].meta.moved,   3);
  assert.equal(log.infoCalls[0].meta.skipped, 1);
  assert.equal(log.infoCalls[0].meta.failed,  2);
  assert.equal(log.infoCalls[0].meta.errors,  2, 'errors count is length, not the array itself');
});

// ── Invariant 5: reconciling a source AWAY mid-tick ────────────────────────

test('reconciling a source away while its pass is running does not throw or leak', async () => {
  const runPass = makeRunPassSpy({ holdForever: true });
  const { sched, timers } = makeScheduler({ runPass });
  sched.reconcile([makeSource({ id: 'mid' })]);
  const token = timers.tokens()[0];

  // Start a pass that never resolves.
  const inflight = timers.fire(token);
  await Promise.resolve();
  assert.equal(sched._isRunning('mid'), true);

  // Reconcile the source AWAY while the pass is still in flight.
  sched.reconcile([]);
  assert.equal(sched._activeSourceIds().size, 0, 'source removed from schedule');
  assert.equal(timers.size(), 0, 'timer cleared');

  // Let the in-flight pass finish. The finally block reads the entry
  // from the map — which has been deleted — so `running` cleanup just
  // no-ops. Must NOT throw.
  runPass.resolveHold();
  await inflight;   // any throw here would fail the test
});

// ── stop() ────────────────────────────────────────────────────────────────

test('stop() clears every timer and empties the map', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([
    makeSource({ id: 'a' }),
    makeSource({ id: 'b', name: 'B' }),
    makeSource({ id: 'c', name: 'C' }),
  ]);
  assert.equal(timers.size(), 3);

  sched.stop();
  assert.equal(timers.size(), 0);
  assert.equal(sched._activeSourceIds().size, 0);
});

test('stop() is idempotent — calling it twice does not throw', () => {
  const { sched } = makeScheduler();
  sched.reconcile([makeSource()]);
  sched.stop();
  sched.stop();   // must not throw
});

// ── Defensive: invalid intervalMinutes ─────────────────────────────────────

// ── lastRun tracking + getStatuses (M4a additions) ────────────────────────

test('getStatuses(): empty when no sources scheduled', () => {
  const { sched } = makeScheduler();
  assert.deepEqual(sched.getStatuses(), []);
});

test('getStatuses(): one entry per scheduled source, running=false + lastRunAt=null before first tick', () => {
  const { sched, timers } = makeScheduler();
  sched.reconcile([
    makeSource({ id: 'a', name: 'A' }),
    makeSource({ id: 'b', name: 'B', intervalMinutes: 10 }),
  ]);
  const statuses = sched.getStatuses().sort((x, y) => x.sourceId.localeCompare(y.sourceId));
  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].sourceId,   'a');
  assert.equal(statuses[0].name,       'A');
  assert.equal(statuses[0].running,    false);
  assert.equal(statuses[0].intervalMs, 5 * 60_000);
  assert.equal(statuses[0].lastRunAt,  null, 'no pass has run yet');
  assert.equal(statuses[0].lastResult, null);
  assert.equal(statuses[1].intervalMs, 10 * 60_000);
});

test('lastRun stamped after a successful pass — at + summary populated', async () => {
  const runPass = makeRunPassSpy({
    summary: { moved: 2, skipped: 0, failed: 0, errors: [] },
  });
  const now = () => 1_700_000_000_000;
  const { sched, timers } = makeScheduler({ runPass, now });
  sched.reconcile([makeSource({ id: 's' })]);

  await timers.fire(timers.tokens()[0]);

  const [status] = sched.getStatuses();
  assert.equal(status.lastRunAt, 1_700_000_000_000);
  assert.deepEqual(status.lastResult, { moved: 2, skipped: 0, failed: 0, errors: [] });
});

test('lastRun updated on each subsequent pass — old summary is replaced', async () => {
  // now() returns a different timestamp on each call — mirrors real time.
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const runPass = makeRunPassSpy();

  const { sched, timers } = makeScheduler({
    runPass,
    now,
  });
  sched.reconcile([makeSource()]);
  const token = timers.tokens()[0];

  runPass.calls.length = 0;
  await timers.fire(token);
  clock += 60_000;
  const after1 = sched.getStatuses()[0];
  assert.equal(after1.lastRunAt, 1_700_000_000_000, 'stamped at fire-1 time');

  await timers.fire(token);
  const after2 = sched.getStatuses()[0];
  assert.equal(after2.lastRunAt, 1_700_000_060_000, 'stamped at fire-2 time — old value replaced');
});

test('lastRun stamped even when runPass throws — surfaces the error to the UI so operators see the shouldn\'t-happen', async () => {
  // Invariant-3 safety net: if runFtpSourcePass regresses and throws
  // instead of catching, the scheduler still updates lastRun with a
  // synthetic error summary so the M4 UI shows "something went wrong"
  // instead of leaving the last-result cell frozen at the previous
  // successful pass.
  const runPass = makeRunPassSpy({ throw: new Error('regression: threw instead of caught') });
  const now = () => 1_700_000_000_000;
  const { sched, timers } = makeScheduler({ runPass, now });
  sched.reconcile([makeSource()]);
  await timers.fire(timers.tokens()[0]);

  const [status] = sched.getStatuses();
  assert.equal(status.lastRunAt, 1_700_000_000_000);
  assert.equal(status.lastResult.moved,   0);
  assert.equal(status.lastResult.failed,  0);
  assert.equal(status.lastResult.errors.length, 1);
  assert.equal(status.lastResult.errors[0].filename, null,
    'synthetic error uses filename:null to mark it as a whole-pass failure');
  assert.match(status.lastResult.errors[0].message, /regression/);
});

test('lastRun NOT stamped if the source was reconciled away mid-tick — no revived entry', async () => {
  // Invariant-5 corollary: if the source is removed while its pass is
  // running, the finally block's re-read finds nothing to stamp. Must
  // NOT re-create the entry (that would leak a scheduled-away source
  // back into getStatuses).
  const runPass = makeRunPassSpy({ holdForever: true });
  const { sched, timers } = makeScheduler({ runPass });
  sched.reconcile([makeSource({ id: 'gone' })]);
  const token = timers.tokens()[0];

  const inflight = timers.fire(token);
  await Promise.resolve();
  sched.reconcile([]);   // remove mid-pass
  runPass.resolveHold();
  await inflight;

  assert.deepEqual(sched.getStatuses(), [],
    'removed source must not resurface in getStatuses via the finally block');
});

// ── invalid intervalMinutes (existing test, kept below for locality) ───────

test('source with invalid intervalMinutes is skipped with a warn — not scheduled, not throwing', () => {
  // M1's sanitiser prevents this from ever reaching the scheduler in
  // practice, but a hand-edited config could still produce it. The
  // scheduler must skip + warn rather than throw and take out the
  // whole reconcile.
  const log = makeLogger();
  const { sched, timers } = makeScheduler({ log });
  sched.reconcile([
    makeSource({ id: 'bad-1', intervalMinutes: 0,  name: 'zero'    }),
    makeSource({ id: 'bad-2', intervalMinutes: 1441, name: 'huge'   }),
    makeSource({ id: 'bad-3', intervalMinutes: 3.14, name: 'float'  }),
    makeSource({ id: 'good',  intervalMinutes: 5,   name: 'legit'   }),
  ]);
  assert.equal(timers.size(), 1, 'only the legit source scheduled');
  assert.equal(sched._activeSourceIds().has('good'), true);
  assert.equal(log.warnCalls.length, 3, 'each bad row logged at warn');
});
