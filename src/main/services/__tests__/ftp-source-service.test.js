'use strict';

/**
 * Unit tests for ftp-source-service.runFtpSourcePass (M2 of
 * docs/ftp-sources-brief.md).
 *
 * Strategy: real filesystem in an os.tmpdir subfolder per test (so
 * fs.link + fs.unlink are exercised for real — the whole "never
 * overwrite" contract lives in those two syscalls), stub the FTP
 * client + encryption-service + logger via the deps object the
 * service exposes for exactly this purpose.
 *
 * Each test's stub client records access/list/download/remove calls
 * for assertion; the download stub writes real content to the caller-
 * supplied local (temp) path so the subsequent link + unlink step
 * runs on a genuine file. This catches the same class of "the fs
 * rename primitive I thought was atomic isn't" bug that a fully-
 * mocked fs test would silently pass.
 *
 * Coverage matches the brief's M2 test list plus the extras a real
 * implementation opens up (whole-pass failure branches, listing
 * filtering, cross-reference to ftp-service's `secure: false` mirror).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const Module = require('node:module');

// ftp-source-service top-imports `./logger`, which top-imports `electron`
// for the userData path. Under node:test that's undefined and blows up
// at load time — swap electron for a no-op app before the module loads.
// Mirrors the pattern in ipc-handlers-auto-print.test.js.
const __origRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), on: () => {} },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
    };
  }
  return __origRequire.apply(this, arguments);
};

const {
  runFtpSourcePass,
  testSourceConnection,
  _joinRemotePath,
  _clearFallbackLoggedForTests,
  _scrubPasswordFromString,
} = require('../ftp-source-service');

// Restore for any sibling test files loaded after this one.
Module.prototype.require = __origRequire;

// Reset the module-scoped "which sources have logged the rename
// fallback" set between tests so the log-once assertions below don't
// inherit stale state from a prior test that also fell back.
test.beforeEach(() => {
  _clearFallbackLoggedForTests();
});

// ── Scaffolding ────────────────────────────────────────────────────────────

const __testDirs = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), 'ohd-ftp-src-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  __testDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (__testDirs.length) {
    const d = __testDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

function noopLogger() {
  return {
    info:       () => {},
    warn:       () => {},
    error:      () => {},
    logInfo:    () => {},
    logWarning: () => {},
    logError:   () => {},
    logDebug:   () => {},
  };
}

function stubEncryption(plaintext = 'decrypted-secret') {
  return {
    decrypt:     () => plaintext,
    encrypt:     (p) => p,
    isAvailable: () => true,
  };
}

/**
 * Build a stub basic-ftp Client + a factory returning it. Config controls
 * per-test behaviour. All calls are recorded on the client object so
 * tests can assert on them directly.
 */
function makeClient(config = {}) {
  const client = {
    ftp: { verbose: null },   // set by service; test can assert on it
    accessCalls:    [],
    listCalls:      [],
    downloadCalls: [],
    removeCalls:   [],
    closeCalls:    0,
    async access(cfg) {
      this.accessCalls.push(cfg);
      if (config.onAccess) return config.onAccess(cfg);
    },
    async list(remotePath) {
      this.listCalls.push(remotePath);
      if (config.onList) return config.onList(remotePath);
      return config.listing || [];
    },
    async downloadTo(localPath, remotePath) {
      this.downloadCalls.push({ localPath, remotePath });
      if (config.onDownload) return config.onDownload(localPath, remotePath);
      // Default: write real content so link+unlink runs on a real file.
      fs.writeFileSync(localPath, 'content-of-' + path.basename(remotePath));
    },
    async remove(remotePath) {
      this.removeCalls.push(remotePath);
      if (config.onRemove) return config.onRemove(remotePath);
    },
    close() {
      this.closeCalls++;
    },
  };
  return { client, factory: () => client };
}

function makeSource(overrides = {}) {
  return {
    id:                  'src-1',
    name:                'Labworks XML',
    enabled:             true,
    host:                'ftp.example.com',
    port:                21,
    username:            'lab',
    passwordEncrypted:   'ENC[deadbeef]',
    secure:              false,
    remotePath:          '/remote',
    localPath:           makeTempDir(),
    intervalMinutes:     5,
    deleteAfterDownload: true,
    ...overrides,
  };
}

function stdDeps(clientFactory) {
  return {
    createClient:      clientFactory,
    fs,
    encryptionService: stubEncryption(),
    logger:            noopLogger(),
  };
}

/**
 * Real fs for everything EXCEPT link — link is stubbed to throw the
 * given error code. Lets tests exercise the rename-fallback branch on
 * a real filesystem (so fs.rename actually moves the temp for real,
 * catching any subtle wiring bug that a fully-mocked fs would hide).
 */
function fsWithLinkFail(linkErrorCode) {
  return {
    existsSync: fs.existsSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    promises: {
      link: async () => {
        const err = new Error(`stub-fs: link ${linkErrorCode}`);
        err.code = linkErrorCode;
        throw err;
      },
      unlink: fs.promises.unlink.bind(fs.promises),
      rename: fs.promises.rename.bind(fs.promises),
    },
  };
}

/**
 * Logger that records every info/warn/error call for assertion.
 * Same surface as noopLogger; substitute for tests that need to check
 * whether a specific line fired.
 */
function spyLogger() {
  return {
    infoCalls:  [],
    warnCalls:  [],
    errorCalls: [],
    info:       function (msg, meta) { this.infoCalls.push({ msg, meta }); },
    warn:       function (msg, meta) { this.warnCalls.push({ msg, meta }); },
    error:      function (msg, meta) { this.errorCalls.push({ msg, meta }); },
    logInfo:    function (msg, meta) { this.infoCalls.push({ msg, meta }); },
    logWarning: function (msg, meta) { this.warnCalls.push({ msg, meta }); },
    logError:   function (msg, err, meta) { this.errorCalls.push({ msg, err, meta }); },
    logDebug:   () => {},
  };
}

// ── Brief §M2 test list ────────────────────────────────────────────────────

test('happy path: files downloaded, renamed to real names, remote deleted', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    listing: [
      { name: 'a.xml', isFile: true },
      { name: 'b.xml', isFile: true },
    ],
  });

  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.deepEqual(result, {
    moved: 2, skipped: 0, failed: 0, errors: [],
  });

  // Files at final names.
  assert.equal(fs.readFileSync(path.join(source.localPath, 'a.xml'), 'utf8'), 'content-of-a.xml');
  assert.equal(fs.readFileSync(path.join(source.localPath, 'b.xml'), 'utf8'), 'content-of-b.xml');

  // No leftover .part files.
  assert.ok(!fs.existsSync(path.join(source.localPath, '.a.xml.part')));
  assert.ok(!fs.existsSync(path.join(source.localPath, '.b.xml.part')));

  // Remote deleted for both.
  assert.deepEqual(client.removeCalls.slice().sort(), ['/remote/a.xml', '/remote/b.xml']);

  // Session closed exactly once.
  assert.equal(client.closeCalls, 1);
});

test('download fails mid-file: NO real-named file at destination, remote NOT deleted, counted as failed', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    listing: [{ name: 'broken.xml', isFile: true }],
    onDownload: (localPath /*, remotePath */) => {
      // Simulate a partial write, then throw. The "half-transferred file
      // must never appear at the destination under its real name"
      // guarantee lives in the rename step — we're checking here that
      // the download-throw path never reaches the rename.
      fs.writeFileSync(localPath, 'partial-content');
      throw new Error('connection dropped mid-transfer');
    },
  });

  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.moved,   0);
  assert.equal(result.failed,  1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, 'broken.xml');
  assert.match(result.errors[0].message, /connection dropped/);

  // Real-named file MUST NOT exist — the brief's headline invariant.
  assert.ok(!fs.existsSync(path.join(source.localPath, 'broken.xml')),
    'a half-transferred file must never appear at the destination under its real name');

  // Temp cleanup ran (best-effort) — the .part file is gone.
  assert.ok(!fs.existsSync(path.join(source.localPath, '.broken.xml.part')),
    'per-file cleanup removes the temp so a hung .part does not accumulate on retry');

  // Remote MUST NOT be deleted — data loss is worse than duplicate delivery.
  assert.equal(client.removeCalls.length, 0);
});

test('rename fails (race collision): temp cleaned up, existing file untouched, remote NOT deleted', async () => {
  // Race window: the pre-check saw the destination as absent, but by
  // the time we finished downloading, another process wrote to it.
  // The link step MUST refuse to overwrite; the failure path MUST leave
  // the other process's file exactly as it was.
  const source    = makeSource();
  const finalPath = path.join(source.localPath, 'race.xml');

  const { client, factory } = makeClient({
    listing: [{ name: 'race.xml', isFile: true }],
    onDownload: (localPath /*, remotePath */) => {
      fs.writeFileSync(localPath, 'our-download');
      // Simulate the racing writer — writes finalPath BETWEEN our
      // pre-check and our rename.
      fs.writeFileSync(finalPath, 'other-process-wrote-this');
    },
  });

  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.moved,  0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].filename, 'race.xml');

  // Existing file MUST be untouched — the "never clobber a file
  // someone else's process is using" invariant.
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'other-process-wrote-this');

  // Our temp cleaned up in the link-fail branch.
  assert.ok(!fs.existsSync(path.join(source.localPath, '.race.xml.part')));

  // Remote NOT deleted.
  assert.equal(client.removeCalls.length, 0);
});

test('existing destination file is skipped, not overwritten (pre-download check)', async () => {
  const source    = makeSource();
  const finalPath = path.join(source.localPath, 'already-here.xml');
  fs.writeFileSync(finalPath, 'existing-content');

  const { client, factory } = makeClient({
    listing: [{ name: 'already-here.xml', isFile: true }],
  });

  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.skipped, 1);
  assert.equal(result.moved,   0);
  assert.equal(result.failed,  0);
  assert.deepEqual(result.errors, []);

  // Download NOT even attempted — the pre-check saves the network hit.
  assert.equal(client.downloadCalls.length, 0);
  // Remote delete NOT attempted — we can't move a file we didn't move.
  assert.equal(client.removeCalls.length, 0);
  // Existing content preserved.
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'existing-content');
});

test('deleteAfterDownload: false leaves the remote intact', async () => {
  const source = makeSource({ deleteAfterDownload: false });
  const { client, factory } = makeClient({
    listing: [{ name: 'copy-me.xml', isFile: true }],
  });

  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.moved, 1);
  assert.equal(client.downloadCalls.length, 1, 'download still happens');
  assert.equal(client.removeCalls.length,   0, 'but remote delete is suppressed');
  assert.ok(fs.existsSync(path.join(source.localPath, 'copy-me.xml')));
});

test('empty listing is a no-op — no downloads, no deletes, no errors', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({ listing: [] });

  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.deepEqual(result, { moved: 0, skipped: 0, failed: 0, errors: [] });
  assert.equal(client.downloadCalls.length, 0);
  assert.equal(client.removeCalls.length,   0);
  // But the session was still opened and closed cleanly.
  assert.equal(client.accessCalls.length, 1);
  assert.equal(client.closeCalls,         1);
});

// ── Beyond the brief's explicit list ──────────────────────────────────────

test('listing filters to files only: directories and other entries are skipped', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    listing: [
      { name: 'a.xml',   isFile: true,  isDirectory: false },
      { name: 'subdir',  isFile: false, isDirectory: true  },
      { name: 'b.xml',   isFile: true,  isDirectory: false },
      { name: 'weird',   isFile: false, isDirectory: false },   // symlink / socket / unknown
    ],
  });
  const result = await runFtpSourcePass(source, stdDeps(factory));
  assert.equal(result.moved, 2, 'directories + non-file entries filtered out');
  assert.equal(client.downloadCalls.length, 2);
});

test('whole-pass failure (access rejects): summary.errors carries a null-filename entry', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    onAccess: () => { throw new Error('530 login incorrect'); },
  });
  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.moved, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, null,
    'null filename discriminates whole-pass failures for M5 logging (ERROR vs WARN)');
  assert.match(result.errors[0].message, /530 login incorrect/);

  // Client still closed even though access threw.
  assert.equal(client.closeCalls, 1);
});

test('whole-pass failure (list rejects after auth): null-filename error, session still closed', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    onList: () => { throw new Error('550 no such directory'); },
  });
  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.moved, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, null);
  assert.match(result.errors[0].message, /list .* 550/);
  assert.equal(client.closeCalls, 1);
});

test('remote delete failure: file is counted as moved (it IS local), warn logged, not failed', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    listing: [{ name: 'stubborn.xml', isFile: true }],
    onRemove: () => { throw new Error('550 permission denied'); },
  });
  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.moved,  1, 'the local file did land — remote delete failure is orthogonal');
  assert.equal(result.failed, 0, 'a remote delete failure is not a per-file failure');
  assert.equal(result.errors.length, 0);
  assert.ok(fs.existsSync(path.join(source.localPath, 'stubborn.xml')));
});

test('multiple files: one fails, others succeed independently', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    listing: [
      { name: 'ok1.xml', isFile: true },
      { name: 'bad.xml', isFile: true },
      { name: 'ok2.xml', isFile: true },
    ],
    onDownload: (localPath, remotePath) => {
      if (path.basename(remotePath) === 'bad.xml') throw new Error('this one broke');
      fs.writeFileSync(localPath, 'ok');
    },
  });
  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.moved,   2);
  assert.equal(result.failed,  1);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, 'bad.xml');

  assert.ok( fs.existsSync(path.join(source.localPath, 'ok1.xml')));
  assert.ok( fs.existsSync(path.join(source.localPath, 'ok2.xml')));
  assert.ok(!fs.existsSync(path.join(source.localPath, 'bad.xml')),
    'the failed file must not leak to the destination');

  // Only the two successful downloads produce remote deletes.
  assert.deepEqual(client.removeCalls.slice().sort(), ['/remote/ok1.xml', '/remote/ok2.xml']);
});

test('stale .part left over from a previous crash is cleaned up before download starts', async () => {
  const source    = makeSource();
  const stalePath = path.join(source.localPath, '.retry.xml.part');
  fs.writeFileSync(stalePath, 'stale-remnant-from-prior-crash');

  const { client, factory } = makeClient({
    listing: [{ name: 'retry.xml', isFile: true }],
  });
  const result = await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(result.moved, 1);
  const finalContent = fs.readFileSync(path.join(source.localPath, 'retry.xml'), 'utf8');
  assert.notEqual(finalContent, 'stale-remnant-from-prior-crash',
    'the stale .part must not become the final file — sweep-then-download');
  assert.equal(finalContent, 'content-of-retry.xml');
});

// ── Connection-setup mirror with ftp-service.js ─────────────────────────────

test('access() is called with secure:false hardcoded, even when source.secure is true', async () => {
  // This test is the linchpin of the "mirror ftp-service.js" contract:
  // the file-top comments in both files say any change to `secure` MUST
  // be mirrored. If this test fails after a future edit, whoever
  // changed one file forgot to update the other.
  const source = makeSource({ secure: true });
  const { client, factory } = makeClient({ listing: [] });
  await runFtpSourcePass(source, stdDeps(factory));

  assert.equal(client.accessCalls.length, 1);
  assert.equal(client.accessCalls[0].secure, false,
    'ftp-service hardcodes secure:false — mirror or one FTP server will work only via one caller');
});

test('access() defaults port to 21 when source.port is missing (matches ftp-service)', async () => {
  const source = makeSource({ port: undefined });
  const { client, factory } = makeClient({ listing: [] });
  await runFtpSourcePass(source, stdDeps(factory));
  assert.equal(client.accessCalls[0].port, 21);
});

test('access() forwards host / user / password from decrypted source', async () => {
  const source = makeSource({ host: 'ftp.foo', username: 'usr', passwordEncrypted: 'ENC[…]' });
  const { client, factory } = makeClient({ listing: [] });
  await runFtpSourcePass(source, {
    createClient:      factory,
    fs,
    encryptionService: { decrypt: () => 'the-actual-password', encrypt: () => '', isAvailable: () => true },
    logger:            noopLogger(),
  });
  assert.equal(client.accessCalls[0].host,     'ftp.foo');
  assert.equal(client.accessCalls[0].user,     'usr');
  assert.equal(client.accessCalls[0].password, 'the-actual-password');
});

test('client.ftp.verbose is set false (matches ftp-service.js)', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({ listing: [] });
  await runFtpSourcePass(source, stdDeps(factory));
  assert.equal(client.ftp.verbose, false);
});

test('client.close is always called — even on whole-pass failure via access() throw', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    onAccess: () => { throw new Error('boom'); },
  });
  await runFtpSourcePass(source, stdDeps(factory));
  assert.equal(client.closeCalls, 1, 'the finally block runs regardless of where the pass fails');
});

// ── _joinRemotePath ────────────────────────────────────────────────────────

test('_joinRemotePath: no trailing slash on dir → single slash between', () => {
  assert.equal(_joinRemotePath('/remote', 'a.xml'), '/remote/a.xml');
});

test('_joinRemotePath: trailing slash on dir → no double slash', () => {
  assert.equal(_joinRemotePath('/remote/', 'a.xml'), '/remote/a.xml');
});

test('_joinRemotePath: empty dir → just the filename (defensive)', () => {
  assert.equal(_joinRemotePath('', 'a.xml'), 'a.xml');
});

test('remote path with trailing slash produces clean remote file paths', async () => {
  const source = makeSource({ remotePath: '/incoming/' });
  const { client, factory } = makeClient({
    listing: [{ name: 'a.xml', isFile: true }],
  });
  await runFtpSourcePass(source, stdDeps(factory));
  assert.equal(client.downloadCalls[0].remotePath, '/incoming/a.xml',
    'no double slash between dir and filename regardless of trailing-slash convention');
});

// ── link/rename fallback (SMB/UNC destinations) ────────────────────────────
//
// fs.link doesn't work on SMB/UNC — the primary case for this feature.
// The primary path uses link (portable "move iff target doesn't exist"),
// the fallback path uses rename after a re-check. Never silently degrade
// without a log — one INFO per source when the fallback fires. Test
// both paths and every failure branch of the fallback.

test('happy-path link succeeds → no rename-fallback INFO log fires', async () => {
  // Baseline for the log-once tests below: on a local NTFS/tmpfs where
  // link works (Windows dev box, Linux CI), the INFO must NOT fire.
  // If this test starts logging, someone made link fail on a filesystem
  // that supports it — probably by mis-stubbing fs.
  const source = makeSource();
  const { factory } = makeClient({ listing: [{ name: 'a.xml', isFile: true }] });
  const log = spyLogger();
  const result = await runFtpSourcePass(source, {
    createClient:      factory,
    fs,
    encryptionService: stubEncryption(),
    logger:            log,
  });
  assert.equal(result.moved, 1);
  assert.equal(log.infoCalls.length, 0, 'no fallback INFO expected when the primary link path works');
});

test('rename fallback: link throws EPERM → rename completes, file lands at final name, INFO logged once', async () => {
  const source = makeSource();
  const { client, factory } = makeClient({
    listing: [{ name: 'unc.xml', isFile: true }],
  });
  const log = spyLogger();

  const result = await runFtpSourcePass(source, {
    createClient:      factory,
    fs:                fsWithLinkFail('EPERM'),
    encryptionService: stubEncryption(),
    logger:            log,
  });

  assert.equal(result.moved, 1, 'rename fallback delivered the file to its final name');
  assert.equal(result.failed, 0);
  assert.deepEqual(result.errors, []);

  // File is at the real name (via rename, not link+unlink).
  assert.ok(fs.existsSync(path.join(source.localPath, 'unc.xml')));
  // Temp gone — rename moved it, no separate cleanup needed.
  assert.ok(!fs.existsSync(path.join(source.localPath, '.unc.xml.part')));

  // INFO log fired exactly once and names the source + linkErrorCode
  // so the operator can grep for the mode and confirm which sources
  // are on the fallback path.
  assert.equal(log.infoCalls.length, 1, 'INFO log fires once on the first fallback');
  assert.match(log.infoCalls[0].msg, /falling back to fs\.rename/);
  assert.equal(log.infoCalls[0].meta.sourceName,    source.name);
  assert.equal(log.infoCalls[0].meta.linkErrorCode, 'EPERM');

  // Remote still deleted normally.
  assert.deepEqual(client.removeCalls, ['/remote/unc.xml']);
});

test('rename fallback: fires for every code in _RENAME_FALLBACK_CODES (EPERM, ENOTSUP, ENOSYS, EXDEV)', async () => {
  // Loop through each code so a future edit that adds a new code but
  // forgets to update this loop will fail loudly. Keeps the "primary
  // trigger is SMB/UNC EPERM but the list is broader on purpose"
  // discipline visible in the test surface.
  for (const code of ['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV']) {
    _clearFallbackLoggedForTests();
    const source = makeSource({ id: `src-${code}` });
    const { factory } = makeClient({ listing: [{ name: 'x.xml', isFile: true }] });
    const log = spyLogger();
    const result = await runFtpSourcePass(source, {
      createClient:      factory,
      fs:                fsWithLinkFail(code),
      encryptionService: stubEncryption(),
      logger:            log,
    });
    assert.equal(result.moved, 1, `rename fallback must fire on ${code}`);
    assert.equal(log.infoCalls.length, 1, `INFO log fires on ${code}`);
    assert.equal(log.infoCalls[0].meta.linkErrorCode, code);
  }
});

test('rename fallback: an unrelated link error (e.g. EACCES on a totally broken share) does NOT fall back', async () => {
  // The fallback list is deliberately narrow — codes that specifically
  // mean "hard-link creation not supported on this destination". A
  // truly broken destination (permission denied on directory access,
  // disk full) should NOT silently degrade to rename; it should surface
  // as a per-file failure so the operator sees it.
  const source = makeSource();
  const { factory } = makeClient({ listing: [{ name: 'bad.xml', isFile: true }] });
  const log = spyLogger();
  const result = await runFtpSourcePass(source, {
    createClient:      factory,
    fs:                fsWithLinkFail('EACCES'),
    encryptionService: stubEncryption(),
    logger:            log,
  });
  assert.equal(result.moved,  0);
  assert.equal(result.failed, 1);
  assert.equal(log.infoCalls.length, 0, 'EACCES is not on the fallback list — do not degrade silently');
});

test('rename fallback race: target appears between download and re-check → refuse to overwrite, temp cleaned up, no rename', async () => {
  // The re-check narrows the race but doesn't eliminate it on POSIX.
  // If someone writes to finalPath between our pre-download check and
  // the fallback re-check, we must refuse to overwrite — same
  // never-clobber contract as the primary path.
  const source    = makeSource();
  const finalPath = path.join(source.localPath, 'race.xml');

  // Compose a custom fs stub: link throws EPERM (triggers fallback),
  // BUT the download step (via the real client stub) writes to
  // finalPath before returning — simulating the racing writer.
  const stubFs = fsWithLinkFail('EPERM');

  const { client, factory } = makeClient({
    listing: [{ name: 'race.xml', isFile: true }],
    onDownload: (localPath /*, remotePath */) => {
      fs.writeFileSync(localPath, 'our-download');
      fs.writeFileSync(finalPath, 'other-process-wrote-this');
    },
  });

  const log = spyLogger();
  const result = await runFtpSourcePass(source, {
    createClient:      factory,
    fs:                stubFs,
    encryptionService: stubEncryption(),
    logger:            log,
  });

  assert.equal(result.moved,  0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].filename, 'race.xml');
  assert.match(result.errors[0].message, /appeared during download/i);
  assert.equal(result.errors[0].message.includes(finalPath), true,
    'error must name the destination path so the operator can find the collision');

  // Other process's file untouched.
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'other-process-wrote-this');
  // Temp cleaned up.
  assert.ok(!fs.existsSync(path.join(source.localPath, '.race.xml.part')));
  // Remote NOT deleted.
  assert.equal(client.removeCalls.length, 0);
  // Fallback INFO does NOT fire — we bailed BEFORE the log-once
  // point (which sits after the re-check). Also correct: the source
  // hasn't actually fallen back yet, we've only observed one link
  // failure that never resolved to a successful rename.
  assert.equal(log.infoCalls.length, 0,
    'INFO fires only when the fallback actually delivered a file, not on a failed attempt');
});

test('rename fallback log-once: two passes for the same source → INFO fires exactly once total', async () => {
  const source = makeSource();
  const log    = spyLogger();

  // Two independent passes for the same source id.
  for (let i = 0; i < 2; i++) {
    const { factory } = makeClient({ listing: [{ name: `f${i}.xml`, isFile: true }] });
    await runFtpSourcePass(source, {
      createClient:      factory,
      fs:                fsWithLinkFail('EPERM'),
      encryptionService: stubEncryption(),
      logger:            log,
    });
  }

  assert.equal(log.infoCalls.length, 1,
    'brief §"Log the fallback once per source at info" — two passes must not spam two log lines');
});

test('rename fallback log-once: two different sources → INFO fires once per source', async () => {
  const log = spyLogger();

  for (const id of ['src-A', 'src-B']) {
    const source = makeSource({ id, name: `Source ${id}` });
    const { factory } = makeClient({ listing: [{ name: 'x.xml', isFile: true }] });
    await runFtpSourcePass(source, {
      createClient:      factory,
      fs:                fsWithLinkFail('EPERM'),
      encryptionService: stubEncryption(),
      logger:            log,
    });
  }

  assert.equal(log.infoCalls.length, 2, 'log-once is scoped per source id, not global');
  const names = log.infoCalls.map((c) => c.meta.sourceName).sort();
  assert.deepEqual(names, ['Source src-A', 'Source src-B']);
});

test('rename fallback: subsequent files in the SAME pass do not re-log (log-once is per source, not per file)', async () => {
  const source = makeSource();
  const log    = spyLogger();
  const { factory } = makeClient({
    listing: [
      { name: 'a.xml', isFile: true },
      { name: 'b.xml', isFile: true },
      { name: 'c.xml', isFile: true },
    ],
  });
  const result = await runFtpSourcePass(source, {
    createClient:      factory,
    fs:                fsWithLinkFail('EPERM'),
    encryptionService: stubEncryption(),
    logger:            log,
  });

  assert.equal(result.moved, 3, 'all three fell back to rename successfully');
  assert.equal(log.infoCalls.length, 1,
    'three files fall back — only one INFO log; brief §"once per source" is per source, not per file');
});

// ── testSourceConnection (M4a) — plaintext-in-flight scrubbing ─────────────
//
// The single place in the feature where a secret is in the clear. Every
// return path — success, listing-fail, connect-fail, auth-fail, thrown
// before-access — MUST scrub the plaintext password from:
//   - the returned `error` string
//   - every log-line meta (info / warn / error)
// AND the password must never appear as its own field in the return
// value. Tests deliberately use a highly-distinctive plaintext so a
// leak fails loudly.

const DISTINCTIVE_PASSWORD = 'ohd-test-password-a1b2c3-DO-NOT-LEAK';

/**
 * Assert that neither the return value nor ANY spy-logger call
 * contains the given plaintext. Deep-scans every string in the return
 * object + every log meta value. Called at the end of every test-
 * connection test so we don't repeat the same assertions six times.
 */
function assertNoLeak(returnValue, log, plaintext) {
  const returnJson = JSON.stringify(returnValue);
  assert.ok(!returnJson.includes(plaintext),
    `plaintext password leaked into return value: ${returnJson}`);

  const allLogs = [
    ...(log.infoCalls || []),
    ...(log.warnCalls || []),
    ...(log.errorCalls || []),
    ...(log.debugCalls || []),
  ];
  for (const entry of allLogs) {
    const json = JSON.stringify(entry);
    assert.ok(!json.includes(plaintext),
      `plaintext password leaked into a log line: ${json}`);
  }
}

test('testSourceConnection: happy path returns success + fileCount, no plaintext leak', async () => {
  const source = makeSource({ password: DISTINCTIVE_PASSWORD, passwordEncrypted: undefined });
  const { client, factory } = makeClient({
    listing: [
      { name: 'a.xml', isFile: true },
      { name: 'b.xml', isFile: true },
      { name: 'dir',   isFile: false, isDirectory: true },
    ],
  });
  const log = spyLogger();
  const result = await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: stubEncryption(),
    logger:            log,
  });

  assert.equal(result.success,   true);
  assert.equal(result.fileCount, 2, 'directory entry excluded from file count');
  assert.equal(result.remotePath, source.remotePath);
  // Password IS what basic-ftp sees (contract: we forward the plaintext to access()).
  assert.equal(client.accessCalls[0].password, DISTINCTIVE_PASSWORD);
  // …but MUST NOT be in the return value or any log line.
  assertNoLeak(result, log, DISTINCTIVE_PASSWORD);
});

test('testSourceConnection: auth failure — scrubbed error returned + logged, no plaintext leak', async () => {
  // Simulate a pathological FTP server that echoes the credentials in
  // its error text — the exact scenario the scrubber exists for.
  const source = makeSource({ password: DISTINCTIVE_PASSWORD, passwordEncrypted: undefined });
  const { factory } = makeClient({
    onAccess: () => {
      throw new Error(`530 Login incorrect (tried password "${DISTINCTIVE_PASSWORD}")`);
    },
  });
  const log = spyLogger();
  const result = await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: stubEncryption(),
    logger:            log,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /530 Login incorrect/);
  assert.match(result.error, /\[password redacted\]/,
    'the redaction marker must be present where the plaintext used to be');
  assertNoLeak(result, log, DISTINCTIVE_PASSWORD);
});

test('testSourceConnection: list failure post-auth — scrubbed error, no plaintext leak', async () => {
  const source = makeSource({ password: DISTINCTIVE_PASSWORD, passwordEncrypted: undefined });
  const { factory } = makeClient({
    onList: () => {
      // Some servers echo request context in list errors; simulate that
      // to prove the scrub works past the connect phase too.
      throw new Error(`550 no such directory (auth as "user" password "${DISTINCTIVE_PASSWORD}")`);
    },
  });
  const log = spyLogger();
  const result = await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: stubEncryption(),
    logger:            log,
  });

  assert.equal(result.success, false);
  assertNoLeak(result, log, DISTINCTIVE_PASSWORD);
});

test('testSourceConnection: bland error (no plaintext in message) → returned verbatim, still logged, still no leak', async () => {
  // The common case — a well-behaved server just says "530 Login
  // incorrect". Scrub is a no-op here (nothing to redact); the test
  // pins that the scrub doesn't corrupt a bland message.
  const source = makeSource({ password: DISTINCTIVE_PASSWORD, passwordEncrypted: undefined });
  const { factory } = makeClient({
    onAccess: () => { throw new Error('530 Login incorrect'); },
  });
  const log = spyLogger();
  const result = await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: stubEncryption(),
    logger:            log,
  });
  assert.equal(result.error, '530 Login incorrect', 'bland message passed through verbatim');
  assertNoLeak(result, log, DISTINCTIVE_PASSWORD);
});

test('testSourceConnection: encrypted-source path decrypts via encryption-service, no plaintext leak', async () => {
  // Path (b) — saved source with only passwordEncrypted. Test that the
  // decrypted plaintext still doesn't leak via the same scrub path.
  const source = makeSource({
    password:          undefined,   // renderer sent no plaintext (no edit)
    passwordEncrypted: 'ENC[whatever]',
  });
  const { client, factory } = makeClient({ listing: [] });
  const log = spyLogger();
  const result = await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: { decrypt: () => DISTINCTIVE_PASSWORD, encrypt: () => '', isAvailable: () => true },
    logger:            log,
  });
  assert.equal(result.success, true);
  assert.equal(client.accessCalls[0].password, DISTINCTIVE_PASSWORD, 'decrypted plaintext reaches access()');
  assertNoLeak(result, log, DISTINCTIVE_PASSWORD);
});

test('testSourceConnection: encrypted-source path + auth failure — scrubs decrypted plaintext', async () => {
  const source = makeSource({
    password:          undefined,
    passwordEncrypted: 'ENC[whatever]',
  });
  const { factory } = makeClient({
    onAccess: () => { throw new Error(`530 Login incorrect (password: ${DISTINCTIVE_PASSWORD})`); },
  });
  const log = spyLogger();
  const result = await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: { decrypt: () => DISTINCTIVE_PASSWORD, encrypt: () => '', isAvailable: () => true },
    logger:            log,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /\[password redacted\]/);
  assertNoLeak(result, log, DISTINCTIVE_PASSWORD);
});

test('testSourceConnection: neither password nor passwordEncrypted → clear error, no crash', async () => {
  const source = makeSource({ password: undefined, passwordEncrypted: undefined });
  const { factory } = makeClient();
  const log = spyLogger();
  const result = await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: stubEncryption(),
    logger:            log,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /No password supplied/);
});

test('testSourceConnection: plaintext takes precedence over ciphertext (renderer typed a new password)', async () => {
  const NEW_TYPED = 'freshly-typed-in-modal';
  const source = makeSource({
    password:          NEW_TYPED,
    passwordEncrypted: 'ENC[STALE-should-not-be-used]',
  });
  const { client, factory } = makeClient({ listing: [] });
  await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: { decrypt: () => 'STALE-should-not-be-used', encrypt: () => '', isAvailable: () => true },
    logger:            spyLogger(),
  });
  assert.equal(client.accessCalls[0].password, NEW_TYPED,
    'plaintext from the modal wins over stored ciphertext — matches "Test before Save" UX');
});

test('testSourceConnection: client.close() always called even on early return via no-password branch', async () => {
  // The no-password branch returns BEFORE the client is created (short
  // circuit above the createClient call). Verifies we didn't
  // accidentally construct then leak a client.
  const source = makeSource({ password: undefined, passwordEncrypted: undefined });
  const { client, factory } = makeClient();
  await testSourceConnection(source, {
    createClient:      factory,
    fs,
    encryptionService: stubEncryption(),
    logger:            spyLogger(),
  });
  assert.equal(client.closeCalls, 0, 'no client created — no close to call');
  assert.equal(client.accessCalls.length, 0);
});

test('testSourceConnection: client.close() called on happy path AND on failure', async () => {
  const source = makeSource({ password: DISTINCTIVE_PASSWORD, passwordEncrypted: undefined });

  // happy
  {
    const { client, factory } = makeClient({ listing: [] });
    await testSourceConnection(source, {
      createClient:      factory,
      fs,
      encryptionService: stubEncryption(),
      logger:            spyLogger(),
    });
    assert.equal(client.closeCalls, 1);
  }

  // failure — close still runs (finally)
  {
    const { client, factory } = makeClient({ onAccess: () => { throw new Error('nope'); } });
    await testSourceConnection(source, {
      createClient:      factory,
      fs,
      encryptionService: stubEncryption(),
      logger:            spyLogger(),
    });
    assert.equal(client.closeCalls, 1);
  }
});

// ── _scrubPasswordFromString unit tests ─────────────────────────────────────

test('_scrubPasswordFromString: replaces every occurrence, non-regex (metachars safe)', () => {
  const text  = 'auth failed for pw=$^.*|(?)[+] and again $^.*|(?)[+]';
  const pw    = '$^.*|(?)[+]';
  const clean = _scrubPasswordFromString(text, pw);
  assert.equal(clean, 'auth failed for pw=[password redacted] and again [password redacted]',
    'split+join must handle regex metachars in the password without corruption');
});

test('_scrubPasswordFromString: no-op on empty inputs', () => {
  assert.equal(_scrubPasswordFromString('some error', ''),      'some error');
  assert.equal(_scrubPasswordFromString('some error', null),    'some error');
  assert.equal(_scrubPasswordFromString('',           'x'),     '');
  assert.equal(_scrubPasswordFromString(null,         'x'),     null);
});

test('_scrubPasswordFromString: undefined password is a no-op (anonymous-FTP / no-password path)', () => {
  // Explicit test for `undefined` since the decrypt-then-scrub flow can
  // reach here with an unset value if `encryptionService.decrypt`
  // returns undefined on empty input. Must NOT touch the text.
  const text = 'connection reset by peer';
  assert.equal(_scrubPasswordFromString(text, undefined), text);
});

test('_scrubPasswordFromString: empty-string password is a no-op (anonymous-FTP / no-password path)', () => {
  // Explicit test — same code path as above but with an empty string
  // rather than absent. This is the "anonymous FTP" case the user
  // flagged: basic-ftp accepts empty passwords, and if a source ever
  // reaches this function with `password: ''` the guard must NOT
  // fall through to split — `text.split('').join(marker)` inserts
  // the marker between EVERY character and turns a log line into
  // garbage.
  const text = 'connection reset by peer';
  assert.equal(_scrubPasswordFromString(text, ''), text,
    'empty password must never trigger the between-every-character corruption');
});

test('_scrubPasswordFromString: whitespace-only passwords do not corrupt the text (single space, tab, mixed)', () => {
  // The bug this guards against: `text.split(' ').join(marker)`
  // replaces every space with the redaction marker, corrupting an
  // innocent error message. Guard applies to any password that trims
  // to empty — space, tab, newline, or mixed whitespace all count.
  const text = 'hello world tab\tseparated newline\nseparated';

  assert.equal(_scrubPasswordFromString(text, ' '),      text, 'single space must not split-on-space');
  assert.equal(_scrubPasswordFromString(text, '\t'),     text, 'single tab must not split-on-tab');
  assert.equal(_scrubPasswordFromString(text, '   '),    text, 'multi-space still trims to empty');
  assert.equal(_scrubPasswordFromString(text, ' \t\n '), text, 'mixed whitespace still trims to empty');
});

test('_scrubPasswordFromString: password containing leading/trailing whitespace but with real content IS scrubbed', () => {
  // Defence-in-depth for the whitespace guard. A password of "  actualpw  "
  // (someone pasted with padding) has real content — must scrub the whole
  // thing, not skip. The guard is only on trims-to-empty, not on any
  // whitespace at all.
  const password = '  actualpw  ';
  const text     = 'error mentioning "  actualpw  " here';
  const scrubbed = _scrubPasswordFromString(text, password);
  assert.equal(scrubbed, 'error mentioning "[password redacted]" here',
    'a password with real content plus padding still scrubs — only trims-to-empty is a no-op');
});

test('_scrubPasswordFromString: no-op when password does not appear in text', () => {
  assert.equal(_scrubPasswordFromString('530 Login incorrect', 'my-pw'), '530 Login incorrect');
});
