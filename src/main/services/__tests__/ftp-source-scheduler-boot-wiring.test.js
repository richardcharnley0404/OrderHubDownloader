'use strict';

/**
 * Boot-wiring test for the FTP-source scheduler.
 *
 * Why this file exists. The "works until the first restart and then
 * silently never runs again" failure mode is invisible to every other
 * test — every scheduler unit test and every IPC handler test can pass
 * while main/index.js has NO call to `ftpSourceScheduler.reconcile(
 * configService.getFtpSources())` at boot. This test loads
 * src/main/index.js with everything stubbed, awaits the whenReady
 * callback chain, and asserts:
 *
 *   1. `ftpSourceScheduler.reconcile(...)` was called exactly once
 *      during boot, AFTER `setupIpcHandlers` (so the IPC surface is
 *      already up when the first tick could fire).
 *   2. The list passed to reconcile is the exact array
 *      `configService.getFtpSources()` returned.
 *   3. `ftpSourceScheduler.stop()` runs when the `before-quit`
 *      handler fires.
 *
 * If someone deletes the two-line boot wire and unit-tests still pass,
 * these three assertions fail. That is the entire point of the file.
 *
 * Approach: stub every module `main/index.js` requires (electron, sharp,
 * every service, the scheduler itself) so the file loads without side
 * effects, and inspect the resulting call sequence.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MAIN = path.join(REPO, 'src', 'main');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Test-mutable state ────────────────────────────────────────────────────

let __whenReadyResolve = null;
let __appOnHandlers    = new Map();
let __sourcesReturned  = [];
let __reconcileCalls   = [];
let __stopCalls        = 0;
let __setupIpcHandlersCallCount = 0;
let __reconcileCalledAfterIpcSetup = null;

function noop() {}

const noopLogger = {
  info: noop, warn: noop, error: noop, debug: noop,
  logInfo: noop, logWarning: noop, logError: noop, logDebug: noop,
};

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports,
  };
}

// ── Stubs for every module main/index.js requires ─────────────────────────
//
// Each stub is the minimal no-throw surface main/index.js touches. The
// TWO stubs that carry the assertion signal are `config-service` (whose
// getFtpSources return value we control) and `ftp-source-scheduler`
// (whose reconcile / stop we spy on). Everything else is a benign no-op.

stubInCache(path.join(SVC,  'polling-service.js'), {
  isRunning: () => false,
  start:     noop,
  stop:      noop,
  setAutoPrintCallback:   noop,
  setJobsUpdatedCallback: noop,
  setOnAutoPrint:         noop,
});
stubInCache(path.join(SVC,  'ftp-service.js'),                        {});
stubInCache(path.join(SVC,  'config-service.js'),                     {
  getAll:        () => ({}),
  getFtpSources: () => __sourcesReturned,
  isConfigured:  () => false,
  get:           () => undefined,
});
stubInCache(path.join(SVC,  'orientation-service.js'),                {
  init:     async () => false,
  shutdown: async () => {},
});
stubInCache(path.join(SVC,  'ai-inference-client.js'),                {
  shutdown: async () => {},
});
stubInCache(path.join(SVC,  'logger.js'),                             noopLogger);
stubInCache(path.join(MAIN, 'updater.js'),                            {
  setMainWindow:       noop,
  startUpdateSchedule: noop,
});
stubInCache(path.join(SVC,  'integrity-quarantine-migration.js'),     {
  runIntegrityQuarantineMigration: async () => {},
});
stubInCache(path.join(SVC,  'backup-service.js'),                     {
  getDefault: () => ({
    _shouldRunDailyBackup: () => false,
    runBackup:             async () => {},
  }),
});
// The scheduler stub is the spy — records reconcile invocations and
// notes whether IPC setup happened before them. `stop()` count feeds
// the shutdown assertion.
stubInCache(path.join(SVC,  'ftp-source-scheduler.js'),               {
  reconcile: (sources) => {
    __reconcileCalledAfterIpcSetup = __setupIpcHandlersCallCount > 0;
    __reconcileCalls.push(sources);
  },
  stop: () => { __stopCalls++; },
});
stubInCache(path.join(MAIN, 'window-manager.js'), {
  createWindow: noop,
  getWindow:    () => null,
  showWindow:   noop,
});
stubInCache(path.join(MAIN, 'tray-manager.js'),   {
  create:       noop,
  destroy:      noop,
  updateStatus: noop,
});
// setupIpcHandlers is another signal — bumping the counter here lets
// the scheduler stub above assert that reconcile came AFTER IPC setup.
stubInCache(path.join(MAIN, 'ipc-handlers.js'), {
  setupIpcHandlers: () => { __setupIpcHandlersCallCount++; },
});

// electron + sharp are third-party modules; override at Module.prototype
// so the require chain sees the stubs before main/index.js touches them.
const __origRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: {
        requestSingleInstanceLock: () => true,
        on: (name, fn) => { __appOnHandlers.set(name, fn); },
        whenReady: () => new Promise((resolve) => { __whenReadyResolve = resolve; }),
        getVersion: () => 'boot-wire-test',
        getPath:    () => '/tmp',
        setLoginItemSettings: noop,
        quit: noop,
      },
    };
  }
  if (req === 'sharp') return { cache: noop };
  return __origRequire.apply(this, arguments);
};

// ── Boot helper — reset state, load main/index.js, drive whenReady ───────

async function loadIndexAndAwaitBoot() {
  __whenReadyResolve = null;
  __appOnHandlers    = new Map();
  __reconcileCalls   = [];
  __stopCalls        = 0;
  __setupIpcHandlersCallCount = 0;
  __reconcileCalledAfterIpcSetup = null;

  // Force a fresh load so each test gets a fresh whenReady.
  delete require.cache[require.resolve(path.join(MAIN, 'index.js'))];
  require(path.join(MAIN, 'index.js'));

  // The whenReady callback is async — resolve it, then spin the
  // microtask queue until reconcile fires OR we exceed the loop cap.
  __whenReadyResolve();
  for (let i = 0; i < 50 && __reconcileCalls.length === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('boot wire: scheduler.reconcile() is called during whenReady', async () => {
  __sourcesReturned = [
    { id: 'a', name: 'A', enabled: true,  intervalMinutes: 5, host: 'h', username: 'u', localPath: 'C:/a', passwordEncrypted: 'ENC[.]' },
    { id: 'b', name: 'B', enabled: false, intervalMinutes: 5,                                                          localPath: 'C:/b' },
  ];
  await loadIndexAndAwaitBoot();
  assert.equal(__reconcileCalls.length, 1,
    'reconcile MUST be called exactly once at boot — "works until first restart" is the failure mode this test guards against');
});

test('boot wire: reconcile receives the exact array configService.getFtpSources returned', async () => {
  const distinctive = [
    { id: 'test-src-1', name: 'The Only Source', enabled: true, intervalMinutes: 3, host: 'h', username: 'u', localPath: 'C:/x', passwordEncrypted: 'ENC[.]' },
  ];
  __sourcesReturned = distinctive;
  await loadIndexAndAwaitBoot();
  assert.equal(__reconcileCalls.length, 1);
  assert.strictEqual(__reconcileCalls[0], distinctive,
    'reconcile received the same array reference — proves the boot wire reads getFtpSources at call time');
});

test('boot wire: reconcile runs AFTER setupIpcHandlers registers the surface', async () => {
  // Sequence matters: if reconcile ran BEFORE setupIpcHandlers, the
  // first scheduled tick could fire before the IPC surface is up (via
  // scheduler.reconcile pushing to renderer, or via a Test-connection
  // response race). Not fatal but is a footgun. Pin the order here.
  __sourcesReturned = [
    { id: 'x', name: 'X', enabled: true, intervalMinutes: 5, host: 'h', username: 'u', localPath: 'C:/x', passwordEncrypted: 'ENC[.]' },
  ];
  await loadIndexAndAwaitBoot();
  assert.equal(__reconcileCalledAfterIpcSetup, true,
    'reconcile must run after setupIpcHandlers so the IPC surface is up before any tick could fire');
});

test('boot wire: empty source list is still reconciled (baseline — the array is what getFtpSources returned)', async () => {
  __sourcesReturned = [];
  await loadIndexAndAwaitBoot();
  assert.equal(__reconcileCalls.length, 1);
  assert.deepEqual(__reconcileCalls[0], []);
});

test('shutdown wire: before-quit handler calls scheduler.stop()', async () => {
  __sourcesReturned = [];
  await loadIndexAndAwaitBoot();

  const beforeQuitFn = __appOnHandlers.get('before-quit');
  assert.ok(beforeQuitFn, 'main/index.js MUST register a before-quit handler');
  beforeQuitFn();

  assert.equal(__stopCalls, 1,
    'scheduler.stop MUST run on quit — a stray tick post-quit could try to write to a share Windows is already tearing down');
});

test('shutdown wire: scheduler.stop failure does not throw out of before-quit', async () => {
  // If some future change makes scheduler.stop throw, we must NOT let
  // it crash the quit path — the try/catch around it in main/index.js
  // is the safety net. Simulate a throwing stop and assert the handler
  // returns normally.
  const throwingStop = () => { throw new Error('stop went wrong'); };
  const priorStub    = require.cache[require.resolve(path.join(SVC, 'ftp-source-scheduler.js'))];
  require.cache[require.resolve(path.join(SVC, 'ftp-source-scheduler.js'))] = {
    id: priorStub.id, filename: priorStub.filename, loaded: true,
    exports: {
      reconcile: () => {},
      stop:      throwingStop,
    },
  };
  __sourcesReturned = [];
  try {
    await loadIndexAndAwaitBoot();
    const beforeQuitFn = __appOnHandlers.get('before-quit');
    assert.doesNotThrow(() => beforeQuitFn(),
      'a throwing scheduler.stop must not crash before-quit');
  } finally {
    // Restore the spy stub so subsequent tests see the same shape.
    require.cache[require.resolve(path.join(SVC, 'ftp-source-scheduler.js'))] = priorStub;
  }
});

// Restore Module.prototype.require for other test files loaded in the same worker.
test.after(() => {
  Module.prototype.require = __origRequire;
});
