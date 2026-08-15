'use strict';

/**
 * IPC-level tests for the FTP-sources handlers (M4a of
 * docs/ftp-sources-brief.md). Covers the four per-source handlers:
 *   - ohd:ftp-sources:list-sources
 *   - ohd:ftp-sources:save-source
 *   - ohd:ftp-sources:delete-source
 *   - ohd:ftp-sources:test-connection
 *
 * Two contract-shaped tests every ftp-sources IPC test exists to
 * anchor:
 *   1. save/delete reconcile the scheduler on success. Per Option F,
 *      the general Settings save doesn't touch ftpSources — so if the
 *      per-source save doesn't reconcile, timers never update after
 *      a config change until app restart (the "works until first
 *      restart" cousin failure).
 *   2. test-connection's plaintext password never leaks into the IPC
 *      return value on ANY path (success, auth-fail, list-fail,
 *      encrypted-source, or a defensive unexpected throw). This is
 *      the one place in the feature where a secret is in flight in
 *      the clear.
 *
 * Harness pattern: full ipc-handlers.js load with all service deps
 * stubbed via require.cache — same shape as
 * ipc-save-controller-auto-send-batches.test.js.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MAIN = path.join(REPO, 'src', 'main');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Capture state ────────────────────────────────────────────────────────

const __ipcHandlers = new Map();
let   __sourcesInStore   = [];    // what getFtpSources returns
let   __saveCalls        = [];    // what saveFtpSource was called with
let   __saveThrow        = null;
let   __deleteCalls      = [];    // what deleteFtpSource was called with
let   __deleteResult     = { existed: true };
let   __reconcileCalls   = [];
let   __schedulerStatuses = [];
let   __testConnectionCalls  = [];
let   __testConnectionResult = { success: true, fileCount: 0, remotePath: '/' };
let   __testConnectionThrow  = null;
const __logs = [];

function resetState() {
  __sourcesInStore    = [];
  __saveCalls         = [];
  __saveThrow         = null;
  __deleteCalls       = [];
  __deleteResult      = { existed: true };
  __reconcileCalls    = [];
  __schedulerStatuses = [];
  __testConnectionCalls  = [];
  __testConnectionResult = { success: true, fileCount: 0, remotePath: '/' };
  __testConnectionThrow  = null;
  __logs.length = 0;
}

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── Stubs ────────────────────────────────────────────────────────────────

const fakeConfigService = {
  get: () => undefined,
  getApiSettings:    () => ({ baseUrl: '', key: '', organizationId: '', locationId: '' }),
  getFtpCredentials: () => ({ host: '', user: '', password: '', port: 21, secure: false }),
  getFtpSources: () => __sourcesInStore,
  saveFtpSource: (source) => {
    __saveCalls.push(source);
    if (__saveThrow) throw __saveThrow;
    // Simulate the sanitiser: return the incoming shape with a
    // possibly-encrypted password.
    const saved = { ...source };
    if (typeof source.password === 'string' && source.password.length > 0) {
      saved.passwordEncrypted = `ENC[${source.password}]`;
      delete saved.password;
    }
    return saved;
  },
  deleteFtpSource: (id) => {
    __deleteCalls.push(id);
    return __deleteResult;
  },
};

const fakeScheduler = {
  reconcile: (sources) => { __reconcileCalls.push(sources); },
  getStatuses: () => __schedulerStatuses,
  stop: () => {},
};

const fakeFtpSourceService = {
  testSourceConnection: async (source) => {
    __testConnectionCalls.push(source);
    if (__testConnectionThrow) throw __testConnectionThrow;
    return __testConnectionResult;
  },
  _scrubPasswordFromString: (text, password) => {
    if (!password || !text) return text;
    return String(text).split(password).join('[password redacted]');
  },
};

const captureLogger = {
  info:       (msg, meta) => { __logs.push({ level: 'info', msg, meta }); },
  warn:       (msg, meta) => { __logs.push({ level: 'warn', msg, meta }); },
  error:      (msg, meta) => { __logs.push({ level: 'error', msg, meta }); },
  debug:      (msg, meta) => { __logs.push({ level: 'debug', msg, meta }); },
  logInfo:    (msg, meta) => { __logs.push({ level: 'info', msg, meta }); },
  logWarning: (msg, meta) => { __logs.push({ level: 'warn', msg, meta }); },
  logError:   (msg, err, meta) => { __logs.push({ level: 'error', msg, err, meta }); },
  logDebug:   (msg, meta) => { __logs.push({ level: 'debug', msg, meta }); },
};

function FakeStore() {
  const data = {};
  return {
    get: (k, dflt) => (k in data ? data[k] : dflt),
    set: (k, v)    => { data[k] = v; },
    delete: (k)    => { delete data[k]; },
  };
}

stubInCache(path.join(SVC, 'config-service.js'),                    fakeConfigService);
stubInCache(path.join(SVC, 'logger.js'),                            captureLogger);
stubInCache(path.join(SVC, 'ftp-source-scheduler.js'),              fakeScheduler);
stubInCache(path.join(SVC, 'ftp-source-service.js'),                fakeFtpSourceService);
// Rest of ipc-handlers.js's service imports — no-op stubs to keep load safe.
stubInCache(path.join(SVC, 'job-service.js'),                       {
  getLocalJobs: () => ({ jobs: [], lastFetchTime: null }),
  fetchJobs:    async () => [],
  syncJobStatusFromOH: async () => {},
  markReceived:  async () => {},
  markCompleted: async () => {},
  updateJobLocally: () => {},
  findJobByOrderNumber: () => undefined,
  findJobById:          () => undefined,
});
stubInCache(path.join(SVC, 'print-service.js'),                     {
  sendToPrint:              async () => ({ success: true }),
  sendViaDPOFRouted:        async () => ({ success: true }),
  _sendViaFolderCopyRouted: async () => ({ success: true }),
});
stubInCache(path.join(SVC, 'routing-service.js'),                   {
  resolveRoute:     () => ({ type: 'unrouted' }),
  getControllers:   () => [],
  saveController:   () => {},
  getChannelMappings: () => [],
  getRoutingHeldProcesses: () => new Set(),
  resolvePrintSizeCode: () => 'KG',
  migrateFromPrintControllerStore: () => {},
  backfillLegacyPrintSizeCode:     () => {},
  backfillFujiPrintSize:           () => {},
  validateDPOFPrintSizeCode:       () => ({ valid: true }),
  stripDeprecatedConfigJsonKeys:   () => {},
});
stubInCache(path.join(SVC, 's3-service.js'),                        {});
stubInCache(path.join(SVC, 'test-print-controller.js'),             { runTest: async () => ({}) });
stubInCache(path.join(SVC, 'print-controller-store.js'),            { printControllerStore: { get: () => [], set: () => {} } });
stubInCache(path.join(SVC, 'process-folder-service.js'),            {});
stubInCache(path.join(SVC, 'frame-metadata-store.js'),              {});
stubInCache(path.join(SVC, 'film-review-prefs-store.js'),           {});
stubInCache(path.join(SVC, 'folder-watch-service.js'),              {});
stubInCache(path.join(SVC, 'job-download-service.js'),              { checkLocalFiles: () => ({ found: false }) });
stubInCache(path.join(SVC, 'ai-job-quality-orchestrator.js'),       { scoreJob: async () => ({ ok: true, held: false }) });
stubInCache(path.join(SVC, 'ai-quality-store.js'),                  { getJobQuality: async () => [], deriveHeld: () => false });
stubInCache(path.join(MAIN, 'updater.js'),                          { setMainWindow: () => {}, startUpdateSchedule: () => {} });

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      ipcMain:       { handle: (ch, fn) => __ipcHandlers.set(ch, fn), on: () => {} },
      dialog:        { showOpenDialog: async () => ({ canceled: true }) },
      app:           { getVersion: () => 'test', getPath: () => '/' },
      BrowserWindow: function () {},
      shell:         { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    };
  }
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

const { setupIpcHandlers } = require(path.join(MAIN, 'ipc-handlers.js'));
const noopPollingService = {
  isRunning: () => false, getStatus: () => ({ running: false }),
  restartFolderMonitors: () => {}, setJobsUpdatedCallback: () => {},
  setAutoPrintCallback: () => {}, setOnAutoPrint: () => {},
  start: () => {}, stop: () => {},
};
setupIpcHandlers(noopPollingService, {}, { getWindow: () => null });

const listSources     = __ipcHandlers.get('ohd:ftp-sources:list-sources');
const saveSource      = __ipcHandlers.get('ohd:ftp-sources:save-source');
const deleteSource    = __ipcHandlers.get('ohd:ftp-sources:delete-source');
const testConnection  = __ipcHandlers.get('ohd:ftp-sources:test-connection');

test('all four handlers are registered', () => {
  assert.equal(typeof listSources,    'function');
  assert.equal(typeof saveSource,     'function');
  assert.equal(typeof deleteSource,   'function');
  assert.equal(typeof testConnection, 'function');
});

// ── list-sources ─────────────────────────────────────────────────────────

test('list-sources: strips passwordEncrypted, adds hasPassword, merges scheduler status', async () => {
  resetState();
  __sourcesInStore = [
    { id: 'a', name: 'A', enabled: true,  host: 'h', username: 'u', localPath: 'C:/a', passwordEncrypted: 'ENC[.]', intervalMinutes: 5, deleteAfterDownload: true, port: 21, secure: false, remotePath: '/a' },
    { id: 'b', name: 'B', enabled: false,                                                                            intervalMinutes: 5, deleteAfterDownload: true, port: 21, secure: false, remotePath: '', localPath: 'C:/b' },
  ];
  __schedulerStatuses = [
    { sourceId: 'a', name: 'A', running: false, intervalMs: 300000, lastRunAt: 1_700_000_000_000, lastResult: { moved: 3, skipped: 0, failed: 0, errors: [] } },
    // b is disabled → no scheduler entry.
  ];

  const result = await listSources();
  assert.equal(result.success, true);
  assert.equal(result.sources.length, 2);
  const a = result.sources.find((s) => s.id === 'a');
  const b = result.sources.find((s) => s.id === 'b');

  assert.equal(a.hasPassword, true);
  assert.equal(a.passwordEncrypted, undefined, 'ciphertext MUST NOT reach the renderer via list-sources');
  assert.equal(a.password,          undefined);
  assert.equal(a.lastRunAt,  1_700_000_000_000);
  assert.deepEqual(a.lastResult, { moved: 3, skipped: 0, failed: 0, errors: [] });
  assert.equal(a.running, false);

  assert.equal(b.hasPassword, false, 'row without ciphertext → hasPassword:false');
  assert.equal(b.lastRunAt,   null,  'disabled source has no scheduler status');
  assert.equal(b.lastResult,  null);
  assert.equal(b.running,     false);
});

test('list-sources: empty store returns empty array without error', async () => {
  resetState();
  const result = await listSources();
  assert.deepEqual(result, { success: true, sources: [] });
});

// ── save-source ──────────────────────────────────────────────────────────

test('save-source: success → configService.saveFtpSource called + scheduler.reconcile fires', async () => {
  resetState();
  __sourcesInStore = [];
  const incoming = { name: 'New', enabled: false, localPath: 'C:/new', password: 'the-secret' };
  const result = await saveSource(null, incoming);

  assert.equal(result.success, true);
  assert.equal(__saveCalls.length,      1);
  assert.equal(__reconcileCalls.length, 1,
    'per Option F: save handler MUST reconcile — general Settings save no longer touches ftpSources');
  // Renderer response never carries the ciphertext.
  assert.equal(result.source.passwordEncrypted, undefined);
  assert.equal(result.source.hasPassword,       true, 'hasPassword flag replaces the ciphertext');
});

test('save-source: validation throw → returns {success:false, error}, does NOT reconcile', async () => {
  resetState();
  __saveThrow = new Error('FTP source "X": name is required');
  const result = await saveSource(null, { name: '', enabled: false, localPath: 'C:/x' });

  assert.equal(result.success, false);
  assert.match(result.error, /name is required/);
  assert.equal(__reconcileCalls.length, 0,
    'never reconcile after a failed save — a rejected row must not cause scheduler churn');
});

// ── delete-source ────────────────────────────────────────────────────────

test('delete-source: existing id → configService.deleteFtpSource + scheduler.reconcile', async () => {
  resetState();
  __deleteResult = { existed: true };
  const result = await deleteSource(null, 'src-1');

  assert.equal(result.success, true);
  assert.equal(result.existed, true);
  assert.deepEqual(__deleteCalls, ['src-1']);
  assert.equal(__reconcileCalls.length, 1);
});

test('delete-source: unknown id → success:true with existed:false, still reconciles', async () => {
  resetState();
  __deleteResult = { existed: false };
  const result = await deleteSource(null, 'never-existed');
  assert.equal(result.success, true);
  assert.equal(result.existed, false);
  assert.equal(__reconcileCalls.length, 1, 'reconcile even on no-op delete — cheap and keeps state consistent');
});

test('delete-source: missing id → {success:false, error} without reconciling', async () => {
  resetState();
  const result = await deleteSource(null, '');
  assert.equal(result.success, false);
  assert.match(result.error, /id is required/);
  assert.equal(__reconcileCalls.length, 0);
});

test('delete-source: non-string id → {success:false, error}', async () => {
  resetState();
  const result = await deleteSource(null, 12345);
  assert.equal(result.success, false);
  assert.match(result.error, /id is required/);
});

// ── test-connection — plaintext-scrub contract ─────────────────────────────

const DISTINCTIVE_PASSWORD = 'ipc-test-secret-a1b2c3-DO-NOT-LEAK';

function assertNoLeakAcrossHandler(result, plaintext) {
  const returnJson = JSON.stringify(result);
  assert.ok(!returnJson.includes(plaintext),
    `plaintext leaked into IPC return: ${returnJson}`);
  for (const log of __logs) {
    const logJson = JSON.stringify(log);
    assert.ok(!logJson.includes(plaintext),
      `plaintext leaked into a log line: ${logJson}`);
  }
}

test('test-connection: happy path forwards to testSourceConnection, no plaintext leak', async () => {
  resetState();
  __testConnectionResult = { success: true, fileCount: 3, remotePath: '/incoming' };
  const source = { name: 'S', host: 'h', username: 'u', password: DISTINCTIVE_PASSWORD, remotePath: '/incoming' };
  const result = await testConnection(null, source);

  assert.equal(result.success,   true);
  assert.equal(result.fileCount, 3);
  assertNoLeakAcrossHandler(result, DISTINCTIVE_PASSWORD);
});

test('test-connection: service returns success:false → passed through, no leak', async () => {
  resetState();
  __testConnectionResult = { success: false, error: '530 Login incorrect' };
  const source = { name: 'S', host: 'h', username: 'u', password: DISTINCTIVE_PASSWORD, remotePath: '/x' };
  const result = await testConnection(null, source);

  assert.equal(result.success, false);
  assert.equal(result.error,   '530 Login incorrect');
  assertNoLeakAcrossHandler(result, DISTINCTIVE_PASSWORD);
});

test('test-connection: DEFENSIVE — testSourceConnection throwing → scrubbed error, no plaintext leak', async () => {
  // testSourceConnection is DESIGNED to never throw (catches everything
  // and returns {success:false}). But if a future regression makes it
  // throw, the IPC handler's own catch scrubs before returning — this
  // test locks that defence.
  resetState();
  __testConnectionThrow = new Error(`unexpected: threw with password "${DISTINCTIVE_PASSWORD}" in the message`);
  const source = { name: 'S', host: 'h', username: 'u', password: DISTINCTIVE_PASSWORD, remotePath: '/x' };
  const result = await testConnection(null, source);

  assert.equal(result.success, false);
  assert.match(result.error, /\[password redacted\]/, 'redaction marker present');
  assertNoLeakAcrossHandler(result, DISTINCTIVE_PASSWORD);
});

test('test-connection: null / non-object source → clear error, no crash, no leak', async () => {
  resetState();
  const r1 = await testConnection(null, null);
  const r2 = await testConnection(null, 'not-an-object');
  const r3 = await testConnection(null, undefined);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.success, false);
    assert.match(r.error, /source is required/);
  }
});

test('test-connection: forwards the exact source payload to testSourceConnection', async () => {
  resetState();
  const source = { name: 'X', host: 'h', username: 'u', password: DISTINCTIVE_PASSWORD, remotePath: '/x', port: 2121 };
  await testConnection(null, source);
  assert.equal(__testConnectionCalls.length, 1);
  assert.strictEqual(__testConnectionCalls[0], source,
    'handler forwards the source object as-is when no id-lookup path applies');
});

// ── test-connection: id-lookup for saved sources without a re-typed password ─

test('test-connection: saved source without re-typed password → looks up stored ciphertext by id', async () => {
  // The M4b UX flow: operator opens edit modal for a saved source,
  // clicks Test WITHOUT typing the password again. Renderer sends
  // {id, host, username, remotePath, ...} with NO password field
  // (the renderer never has the ciphertext). Handler must look up
  // the stored ciphertext by id, merge it in, and pass the enriched
  // payload to testSourceConnection.
  resetState();
  __sourcesInStore = [
    { id: 'saved-1', name: 'Saved', enabled: true, host: 'h', username: 'u', localPath: 'C:/x', remotePath: '/x', passwordEncrypted: 'ENC[stored-cipher]', intervalMinutes: 5, deleteAfterDownload: true, port: 21, secure: false },
  ];
  const payload = { id: 'saved-1', name: 'Saved', host: 'h', username: 'u', remotePath: '/x' };
  await testConnection(null, payload);

  assert.equal(__testConnectionCalls.length, 1);
  const forwarded = __testConnectionCalls[0];
  assert.equal(forwarded.passwordEncrypted, 'ENC[stored-cipher]',
    'stored ciphertext must be merged in when payload has no password material');
  assert.equal(forwarded.password, undefined, 'no plaintext appears just because we merged the ciphertext');
});

test('test-connection: freshly-typed password wins over stored ciphertext (Test-before-Save flow)', async () => {
  // Operator rotates the credential in the modal, clicks Test before
  // Save. Payload has BOTH the new plaintext AND an id (edit mode).
  // The handler must NOT merge the stored ciphertext (which would go
  // ignored anyway due to testSourceConnection's precedence, but
  // sending it is a data-flow noise). The plaintext wins cleanly.
  resetState();
  __sourcesInStore = [
    { id: 'saved-1', name: 'Saved', enabled: true, passwordEncrypted: 'ENC[STALE-cipher]', host: 'h', username: 'u', localPath: 'C:/x', remotePath: '/x', intervalMinutes: 5, deleteAfterDownload: true, port: 21, secure: false },
  ];
  const payload = { id: 'saved-1', host: 'h', username: 'u', remotePath: '/x', password: 'FRESH-TYPED-PLAINTEXT' };
  await testConnection(null, payload);

  assert.equal(__testConnectionCalls[0].password,          'FRESH-TYPED-PLAINTEXT');
  assert.equal(__testConnectionCalls[0].passwordEncrypted, undefined,
    'handler must NOT merge stored ciphertext when the payload already carries a plaintext');
});

test('test-connection: id lookup on an unknown id → payload forwarded as-is, testSourceConnection returns no-password error', async () => {
  // If the id doesn't match any stored source, the handler just
  // forwards the payload. testSourceConnection then returns the
  // "No password supplied" error — the operator sees a clear message
  // instead of a cryptic auth failure.
  resetState();
  __sourcesInStore = [];   // empty store
  __testConnectionResult = { success: false, error: 'No password supplied' };
  const payload = { id: 'unknown', host: 'h', username: 'u', remotePath: '/x' };
  const result = await testConnection(null, payload);
  assert.equal(__testConnectionCalls[0].passwordEncrypted, undefined,
    'no merge happens when the id isn\'t found');
  assert.equal(result.success, false);
  assert.match(result.error, /No password supplied/);
});

test('test-connection: id-lookup takes ONLY the ciphertext from the store — every other field comes from the payload', async () => {
  // The specific concern: operator edits a saved source's host from
  // A to B (fixing a typo), clicks Test WITHOUT re-typing the
  // password. The enriched payload passed to testSourceConnection
  // must carry host B (not the stored host A). If a future refactor
  // ever swapped the spread order — `{ ...stored, ...source }`
  // vs `{ ...source, passwordEncrypted: stored.pwEnc }` — the typed
  // fields would be silently overwritten by stale stored values and
  // the operator would get a green tick from the wrong host.
  //
  // Test locks: only passwordEncrypted comes from the store. Every
  // other field flows from the payload verbatim.
  resetState();
  __sourcesInStore = [{
    id:                'saved-1',
    name:              'Saved (stale name)',
    enabled:           true,
    host:              'STORED-HOST.example.com',
    port:              9999,
    username:          'stored-user',
    remotePath:        '/stored/remote/path',
    localPath:         'C:/stored-local',
    passwordEncrypted: 'ENC[stored-cipher]',
    intervalMinutes:   30,
    deleteAfterDownload: false,
    secure:            false,
  }];
  // Renderer sends the currently-edited fields with NO password.
  const typedPayload = {
    id:              'saved-1',
    name:            'Saved (fresh name)',
    host:            'TYPED-HOST.example.com',   // ← changed from stored
    port:            2121,                        // ← changed from stored
    username:        'typed-user',                // ← changed from stored
    remotePath:      '/typed/remote/path',        // ← changed from stored
    localPath:       'D:/typed-local',            // ← changed from stored
    intervalMinutes: 5,
    deleteAfterDownload: true,
    // No password / passwordEncrypted on payload — triggers the
    // id-lookup path.
  };
  await testConnection(null, typedPayload);

  assert.equal(__testConnectionCalls.length, 1);
  const forwarded = __testConnectionCalls[0];

  // Every field from the TYPED payload — the operator's current edit
  // must win. If any of these read `STORED-...` values the fix
  // failed and an operator gets a green tick from the wrong config.
  assert.equal(forwarded.host,                'TYPED-HOST.example.com', 'host must come from the typed payload');
  assert.equal(forwarded.port,                2121,                     'port must come from the typed payload');
  assert.equal(forwarded.username,            'typed-user',             'username must come from the typed payload');
  assert.equal(forwarded.remotePath,          '/typed/remote/path',     'remotePath must come from the typed payload');
  assert.equal(forwarded.localPath,           'D:/typed-local',         'localPath must come from the typed payload');
  assert.equal(forwarded.name,                'Saved (fresh name)',     'name must come from the typed payload');
  assert.equal(forwarded.intervalMinutes,     5,                        'intervalMinutes must come from the typed payload');
  assert.equal(forwarded.deleteAfterDownload, true,                     'deleteAfterDownload must come from the typed payload');

  // ONLY the ciphertext is grafted from the store.
  assert.equal(forwarded.passwordEncrypted, 'ENC[stored-cipher]',
    'passwordEncrypted (the only field the renderer never has) must come from the store');
  assert.equal(forwarded.password, undefined,
    'no plaintext appears just because we merged the ciphertext');
});

test('test-connection: source with no id and no password → forwarded as-is (create-mode with empty pw field)', async () => {
  // Create-mode Test click before typing a password. No id, no
  // password → handler forwards the payload untouched; the service
  // returns the no-password error.
  resetState();
  __testConnectionResult = { success: false, error: 'No password supplied' };
  const payload = { name: 'New', host: 'h', username: 'u', remotePath: '/x' };
  await testConnection(null, payload);
  assert.strictEqual(__testConnectionCalls[0], payload,
    'no id-lookup, no mutation — payload forwarded as-is');
});
