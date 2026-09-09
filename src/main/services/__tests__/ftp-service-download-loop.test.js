'use strict';

/**
 * Tests for ftp-service._downloadDirectory's remote-side behaviour, focused
 * on the copy-mode change (`ftpKeepFilesOnServer`).
 *
 * TRIPWIRE tests (prefix "TRIPWIRE (delete mode):") lock today's behaviour
 * so a rollout of the copy-mode option cannot silently regress the default
 * (delete = move) path a single-location lab depends on. These must pass
 * BEFORE the copy-mode change and AFTER — that is the no-change lock.
 *
 * COPY tests (prefix "copy mode:") drive the new behaviour: no per-file
 * delete on the download path, no delete on the skip path, no parent-
 * folder removal. Same-tree second scan must still dedupe (no repeat
 * downloads), and a size-mismatched cache miss must still re-download.
 *
 * WIRING tests (prefix "wiring:") confirm both callers (polling-service
 * scheduled scan + ipc-handlers manual scan) read `ftpKeepFilesOnServer`
 * from the current config on every call and pass it through to
 * `scanAndDownload` — a manual scan must behave identically to a
 * scheduled one. Same discipline as fujiImageRoot / omitJobId — a fresh
 * install with no field in the config file behaves exactly as today.
 *
 * All assertions come from invariants: call-count on the fake client's
 * `remove` / `removeDir` / `downloadTo` methods, and per-path capture
 * of the exact arguments — never from observed log strings.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const os      = require('node:os');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Logger + sidecarManager stubs so ftp-service loads headless ────────────

function stubViaCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubViaCache(path.join(SVC, 'logger.js'), {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
});

const ftpService = require(path.join(SVC, 'ftp-service.js'));

// ── Fake basic-ftp Client for _downloadDirectory ──────────────────────────
//
// Records every mutating call (`remove`, `removeDir`, `downloadTo`) so tests
// can assert exact counts + argument shapes. `list` and `downloadTo` are
// backed by an in-memory "remote tree" so a second-scan test can prove the
// tree was left intact.
//
// Remote tree shape (nested):
//   {
//     '/root': {
//       files: { 'a.jpg': Buffer(...), 'b.jpg': Buffer(...) },
//       dirs:  { 'sub': { files: { 'c.jpg': Buffer(...) }, dirs: {} } },
//     },
//   }

function makeRemoteTree(spec) {
  // Deep-clone the spec so a test can mutate its remoteTree without
  // affecting a sibling test.
  const clone = {};
  for (const [remotePath, node] of Object.entries(spec)) {
    clone[remotePath] = _cloneNode(node);
  }
  return clone;
}

function _cloneNode(node) {
  return {
    files: Object.fromEntries(
      Object.entries(node.files || {}).map(([n, b]) => [n, Buffer.from(b)]),
    ),
    dirs: Object.fromEntries(
      Object.entries(node.dirs || {}).map(([n, sub]) => [n, _cloneNode(sub)]),
    ),
  };
}

function makeFakeClient({ remoteTree, removeErrorFor = {}, downloadBytesFor = null }) {
  const calls = {
    list:       [],
    downloadTo: [],
    remove:     [],
    removeDir:  [],
  };

  function getNode(remotePath) {
    const norm = remotePath.replace(/\/+$/, '');
    return remoteTree[norm];
  }

  function findParentEntry(remotePath) {
    // Locate the parent's `files` or `dirs` map that contains this entry
    // by name. Used by remove / removeDir to actually mutate the tree.
    const norm = remotePath.replace(/\/+$/, '');
    const parts = norm.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const name = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parentNode = remoteTree[parentPath];
    if (!parentNode) return null;
    return { parentNode, name };
  }

  const client = {
    async list(remotePath) {
      calls.list.push(remotePath);
      const node = getNode(remotePath);
      if (!node) return [];
      const out = [];
      for (const name of Object.keys(node.dirs)) {
        out.push({ name, isDirectory: true, size: 0 });
      }
      for (const [name, buf] of Object.entries(node.files)) {
        out.push({ name, isDirectory: false, size: buf.length });
      }
      return out;
    },

    async downloadTo(localPath, remotePath) {
      calls.downloadTo.push({ localPath, remotePath });
      // Look up the file bytes in the remote tree, or use the per-test
      // override so a size-mismatch scenario can write short bytes.
      let bytes;
      if (typeof downloadBytesFor === 'function') {
        bytes = downloadBytesFor(remotePath);
      }
      if (!bytes) {
        const parent = findParentEntry(remotePath);
        if (!parent || !(parent.name in parent.parentNode.files)) {
          throw new Error(`fake FTP: no file at ${remotePath}`);
        }
        bytes = parent.parentNode.files[parent.name];
      }
      fs.writeFileSync(localPath, bytes);
      return { size: bytes.length };
    },

    async remove(remotePath) {
      calls.remove.push(remotePath);
      if (removeErrorFor[remotePath]) throw removeErrorFor[remotePath];
      const parent = findParentEntry(remotePath);
      if (parent && parent.name in parent.parentNode.files) {
        delete parent.parentNode.files[parent.name];
      }
    },

    async removeDir(remotePath) {
      calls.removeDir.push(remotePath);
      const norm = remotePath.replace(/\/+$/, '');
      const node = remoteTree[norm];
      if (node && Object.keys(node.files).length === 0 && Object.keys(node.dirs).length === 0) {
        delete remoteTree[norm];
        // Also remove from parent's dirs map so a subsequent list of the
        // parent doesn't show the removed subfolder.
        const parent = findParentEntry(remotePath);
        if (parent && parent.name in parent.parentNode.dirs) {
          delete parent.parentNode.dirs[parent.name];
        }
      }
    },
  };

  return { client, calls };
}

// ── Per-test helpers ──────────────────────────────────────────────────────

function makeLocalBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-ftp-copy-'));
}

// Minimal 2-byte payloads so length-based assertions are unambiguous.
const JPG_A = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]); // JPEG-magic start
const JPG_B = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08]); // JPEG-magic start
const JPG_C = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x12]); // JPEG-magic start

function ftp550(remotePath) {
  const err = new Error(`550 Delete failed: ${remotePath}`);
  err.code = 550;
  err.name = 'FTPError';
  return err;
}

// A canonical remote tree used by many tests: /root has a.jpg + b.jpg,
// plus a `sub/` subfolder with c.jpg.
function canonicalTreeSpec() {
  return {
    '/root': {
      files: { 'a.jpg': JPG_A, 'b.jpg': JPG_B },
      dirs:  { 'sub': {} },
    },
    '/root/sub': {
      files: { 'c.jpg': JPG_C },
      dirs:  {},
    },
  };
}

// ─── TRIPWIRE (delete mode) ────────────────────────────────────────────────

test('TRIPWIRE (delete mode): 2-file + 1-subfolder tree — every file removed, empty subfolder removed', async () => {
  const remoteTree = makeRemoteTree(canonicalTreeSpec());
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };

  // isSubfolder=false at the top level — matches scanAndDownload's own
  // call at line 341 of ftp-service.js.
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, summary, false);

  // Every non-directory file is downloaded once.
  assert.equal(calls.downloadTo.length, 3, 'a.jpg + b.jpg + sub/c.jpg downloaded');
  assert.equal(summary.downloaded, 3);
  assert.equal(summary.skipped, 0);

  // Every downloaded file is removed post-download (site A).
  const removedPaths = calls.remove.slice().sort();
  assert.deepEqual(removedPaths,
    ['/root/a.jpg', '/root/b.jpg', '/root/sub/c.jpg'],
    'all three files removed post-download');

  // Subfolder is removed once it is empty (site C). Root is NOT removed —
  // the recursion is called with isSubfolder=false at the top.
  assert.deepEqual(calls.removeDir, ['/root/sub'],
    'only the subfolder is removed; root is not (isSubfolder=false at top)');

  // Local files landed with the expected bytes.
  assert.deepEqual(fs.readFileSync(path.join(localBase, 'a.jpg')),        JPG_A);
  assert.deepEqual(fs.readFileSync(path.join(localBase, 'b.jpg')),        JPG_B);
  assert.deepEqual(fs.readFileSync(path.join(localBase, 'sub', 'c.jpg')), JPG_C);
});

test('TRIPWIRE (delete mode): second scan finds cached files — skip-path delete (site B) fires per file', async () => {
  const remoteTree = makeRemoteTree(canonicalTreeSpec());
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();

  // Pre-seed the local directory with the same bytes so the size-match
  // skip path fires for every file.
  fs.mkdirSync(path.join(localBase, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(localBase, 'a.jpg'),        JPG_A);
  fs.writeFileSync(path.join(localBase, 'b.jpg'),        JPG_B);
  fs.writeFileSync(path.join(localBase, 'sub', 'c.jpg'), JPG_C);

  const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, summary, false);

  // No downloads on a fully-cached tree.
  assert.equal(calls.downloadTo.length, 0, 'nothing re-downloaded when local sizes match');
  assert.equal(summary.skipped, 3);
  assert.equal(summary.downloaded, 0);

  // Every file still removed via the skip path (site B).
  const removedPaths = calls.remove.slice().sort();
  assert.deepEqual(removedPaths,
    ['/root/a.jpg', '/root/b.jpg', '/root/sub/c.jpg'],
    'skip-path delete (site B) fires for every cached file');

  // Subfolder still removed after skip-path cleared its contents (site C).
  assert.deepEqual(calls.removeDir, ['/root/sub']);
});

test('TRIPWIRE (delete mode): expected 550 on /original-files/ keeps allFilesSucceeded true — parent block still entered', async () => {
  // Build a subfolder whose only file lives under /original-files/. A DELE
  // will 550; _handleFtpDeleteFailure returns {expected:true}; site A must
  // NOT flip allFilesSucceeded; the parent removal block MUST be entered
  // (client.list called again), and it MUST short-circuit because the
  // file is still there.
  const OF_FILE = '/root/order/original-files/img.jpg';
  const remoteTree = makeRemoteTree({
    '/root': { files: {}, dirs: { 'order': {} } },
    '/root/order': { files: {}, dirs: { 'original-files': {} } },
    '/root/order/original-files': { files: { 'img.jpg': JPG_A }, dirs: {} },
  });
  const { client, calls } = makeFakeClient({
    remoteTree,
    removeErrorFor: { [OF_FILE]: ftp550(OF_FILE) },
  });

  const localBase = makeLocalBase();
  const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, summary, false);

  // The file DELE was attempted and threw.
  assert.deepEqual(calls.remove, [OF_FILE], 'DELE attempted on the read-only file');

  // Parent-removal block MUST have been entered for the innermost
  // subfolder — evidenced by a SECOND list call on it (initial scan +
  // re-check before removeDir).
  const listCalls = calls.list.filter((p) => p === '/root/order/original-files');
  assert.equal(listCalls.length, 2,
    'parent-removal block re-listed the folder → allFilesSucceeded stayed true');

  // removeDir must NOT have been called on the /original-files/ folder
  // because the DELE-failed file is still present.
  assert.equal(calls.removeDir.includes('/root/order/original-files'), false,
    'removeDir skipped when list() shows the undeletable file still there');
});

// ─── copy mode ────────────────────────────────────────────────────────────

test('copy mode: no remove, no removeDir on download path — the whole tree is left intact', async () => {
  const remoteTree = makeRemoteTree(canonicalTreeSpec());
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();

  const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, summary, false, { keepFilesOnServer: true });

  assert.equal(calls.downloadTo.length, 3, 'all three files still downloaded');
  assert.equal(summary.downloaded, 3);
  assert.equal(calls.remove.length,    0, 'ZERO client.remove calls');
  assert.equal(calls.removeDir.length, 0, 'ZERO client.removeDir calls');

  // Remote tree unchanged.
  assert.ok('/root'     in remoteTree);
  assert.ok('/root/sub' in remoteTree);
  assert.ok('a.jpg'     in remoteTree['/root'].files);
  assert.ok('b.jpg'     in remoteTree['/root'].files);
  assert.ok('sub'       in remoteTree['/root'].dirs);
  assert.ok('c.jpg'     in remoteTree['/root/sub'].files);
});

test('copy mode: no remove on the skip path either — a cached file does not trigger a delete', async () => {
  const remoteTree = makeRemoteTree(canonicalTreeSpec());
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();

  // Pre-seed local so every file is a size-match cache hit.
  fs.mkdirSync(path.join(localBase, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(localBase, 'a.jpg'),        JPG_A);
  fs.writeFileSync(path.join(localBase, 'b.jpg'),        JPG_B);
  fs.writeFileSync(path.join(localBase, 'sub', 'c.jpg'), JPG_C);

  const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, summary, false, { keepFilesOnServer: true });

  assert.equal(summary.skipped, 3, 'all cached');
  assert.equal(calls.downloadTo.length, 0);
  assert.equal(calls.remove.length,     0, 'skip-path delete (site B) is suppressed');
  assert.equal(calls.removeDir.length,  0, 'parent removal (site C) is suppressed');
});

test('copy mode: second scan of the same tree — zero downloads, zero deletes, dedup holds', async () => {
  const remoteTree = makeRemoteTree(canonicalTreeSpec());
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();

  // First scan populates local, leaves remote untouched.
  const s1 = { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, s1, false, { keepFilesOnServer: true });
  assert.equal(s1.downloaded, 3);
  assert.equal(calls.remove.length,    0);
  assert.equal(calls.removeDir.length, 0);

  // Second scan against the still-populated remote tree: dedup MUST hit
  // every file, no downloads and no deletes.
  const s2 = { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  const beforeDownloads = calls.downloadTo.length;
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, s2, false, { keepFilesOnServer: true });

  assert.equal(s2.downloaded, 0, 'nothing re-downloaded on second scan');
  assert.equal(s2.skipped,    3, 'all three skipped');
  assert.equal(calls.downloadTo.length, beforeDownloads,
    'downloadTo call-count unchanged from first scan');
  assert.equal(calls.remove.length,    0);
  assert.equal(calls.removeDir.length, 0);
});

test('copy mode: size-mismatched local file still re-downloads — integrity path not weakened', async () => {
  const remoteTree = makeRemoteTree(canonicalTreeSpec());
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();

  // Pre-seed local a.jpg with WRONG length so the size-match cache check
  // fails. b.jpg and c.jpg not seeded (fresh download).
  fs.mkdirSync(path.join(localBase, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(localBase, 'a.jpg'), Buffer.from([0x00])); // 1 byte, real is 6

  const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, summary, false, { keepFilesOnServer: true });

  // Size-mismatch triggers a fresh download for a.jpg alongside b.jpg + c.jpg.
  assert.equal(calls.downloadTo.length, 3, 'a.jpg re-downloaded due to size mismatch');
  assert.equal(summary.downloaded, 3);
  assert.equal(summary.skipped, 0);

  // But NO removes: copy mode overrides the post-download delete.
  assert.equal(calls.remove.length,    0);
  assert.equal(calls.removeDir.length, 0);

  // Local a.jpg now has the correct bytes.
  assert.deepEqual(fs.readFileSync(path.join(localBase, 'a.jpg')), JPG_A);
});

test('copy mode: options omitted entirely → defaults to delete mode (migration discipline)', async () => {
  // The whole point of the discipline shape (fujiImageRoot, omitJobId):
  // an existing config with no new field behaves EXACTLY as before.
  // scanAndDownload / _downloadDirectory called without an options arg
  // must fall through to the delete path, not silently flip to copy.
  const remoteTree = makeRemoteTree(canonicalTreeSpec());
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };

  // NO 7th arg at all — matches how a legacy caller (or a future caller
  // that forgot to thread the option) invokes _downloadDirectory.
  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, summary, false);

  assert.equal(calls.remove.length, 3, 'no options → delete mode');
  assert.deepEqual(calls.removeDir, ['/root/sub']);
});

test('copy mode: options with keepFilesOnServer=false → delete mode (explicit false is not truthy)', async () => {
  const remoteTree = makeRemoteTree(canonicalTreeSpec());
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };

  await ftpService._downloadDirectory(client, '/root', localBase,
    () => {}, summary, false, { keepFilesOnServer: false });

  assert.equal(calls.remove.length, 3, 'explicit false → delete mode');
  assert.deepEqual(calls.removeDir, ['/root/sub']);
});

// ─── wiring: both callers must thread the option from config ──────────────
//
// Verifies the OTHER two "call sites" the spec named: polling-service's
// scheduled scanFtp and ipc-handlers' manual ftp:scanAndDownload. Both
// must read `ftpKeepFilesOnServer` from configService on every call and
// pass it through as `options.keepFilesOnServer`. A manual scan MUST
// behave identically to a scheduled one.

test('wiring: polling-service.scanFtp reads ftpKeepFilesOnServer from config and passes it to scanAndDownload', async () => {
  // Stub configService with a per-test config object.
  const cfg = {
    ftpHost: 'h', ftpUsername: 'u', ftpPassword: 'p', ftpPort: 21,
    ftpRemotePath: '/r',
    downloadDirectory: makeLocalBase(),
    ftpKeepFilesOnServer: true,
  };
  stubViaCache(path.join(SVC, 'config-service.js'), {
    get(key) { return cfg[key]; },
    getAll() { return { ...cfg }; },
    getFtpCredentials() {
      return { host: cfg.ftpHost, port: cfg.ftpPort, user: cfg.ftpUsername, password: cfg.ftpPassword };
    },
  });

  // Also stub ftp-service.scanAndDownload to capture the args and return
  // a summary. Restore afterwards.
  const original = ftpService.scanAndDownload.bind(ftpService);
  const captured = [];
  ftpService.scanAndDownload = async function (creds, remotePath, localBase, onProgress, opts) {
    captured.push({ creds, remotePath, localBase, opts });
    return { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  };

  try {
    // Fresh require of polling-service so it picks up the stubs.
    delete require.cache[require.resolve(path.join(SVC, 'polling-service.js'))];
    const pollingService = require(path.join(SVC, 'polling-service.js'));
    await pollingService.scanFtp();

    assert.equal(captured.length, 1, 'scanAndDownload called exactly once');
    assert.ok(captured[0].opts, 'options object was passed');
    assert.equal(captured[0].opts.keepFilesOnServer, true,
      'polling-service threaded config ftpKeepFilesOnServer=true');
  } finally {
    ftpService.scanAndDownload = original;
  }
});

test('wiring: polling-service.scanFtp with ftpKeepFilesOnServer=false passes false through', async () => {
  const cfg = {
    ftpHost: 'h', ftpUsername: 'u', ftpPassword: 'p', ftpPort: 21,
    ftpRemotePath: '/r',
    downloadDirectory: makeLocalBase(),
    ftpKeepFilesOnServer: false,
  };
  stubViaCache(path.join(SVC, 'config-service.js'), {
    get(key) { return cfg[key]; },
    getAll() { return { ...cfg }; },
    getFtpCredentials() {
      return { host: cfg.ftpHost, port: cfg.ftpPort, user: cfg.ftpUsername, password: cfg.ftpPassword };
    },
  });

  const original = ftpService.scanAndDownload.bind(ftpService);
  const captured = [];
  ftpService.scanAndDownload = async function (creds, remotePath, localBase, onProgress, opts) {
    captured.push({ creds, remotePath, localBase, opts });
    return { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  };

  try {
    delete require.cache[require.resolve(path.join(SVC, 'polling-service.js'))];
    const pollingService = require(path.join(SVC, 'polling-service.js'));
    await pollingService.scanFtp();

    assert.equal(captured.length, 1);
    // false / undefined / missing are all functionally equivalent to
    // "delete mode" — the important invariant is that we don't silently
    // send `true`.
    assert.notEqual(captured[0].opts?.keepFilesOnServer, true,
      'must not send true when config says false');
  } finally {
    ftpService.scanAndDownload = original;
  }
});

// Source-inspection tripwire for the manual-scan handler. The functional
// wiring test above exercises the scheduled scanFtp path; standing up
// setupIpcHandlers requires ~15 module stubs (see ipc-ftp-sources.test.js),
// which is disproportionate for the one-line assertion "the manual handler
// reads ftpKeepFilesOnServer and passes it as options.keepFilesOnServer".
// Same shape as the M2-fix audit meta-test in folder-copy-filename.test.js
// — read the source file, regex-check the wiring, fail loudly if it drifts.
// The class of bug this prevents: a refactor updates the scheduled path but
// forgets the manual path, and a manual scan silently uses the wrong mode.
test('wiring (source-inspection): ipc-handlers.js manual ftp:scanAndDownload reads ftpKeepFilesOnServer and passes options.keepFilesOnServer', () => {
  const MAIN = path.join(REPO, 'src', 'main');
  const src = fs.readFileSync(path.join(MAIN, 'ipc-handlers.js'), 'utf8');

  // Isolate the ftp:scanAndDownload handler body. Anchor: from the
  // ipcMain.handle('ftp:scanAndDownload', ...) line to the matching
  // `});` handler-close. A regex on the whole file would be too loose.
  const start = src.indexOf("ipcMain.handle('ftp:scanAndDownload'");
  assert.notEqual(start, -1, 'manual ftp:scanAndDownload handler must exist');
  const handlerSlice = src.slice(start, start + 2500);

  assert.ok(
    /configService\.get\(\s*['"]ftpKeepFilesOnServer['"]\s*\)/.test(handlerSlice),
    'manual handler must read ftpKeepFilesOnServer from configService',
  );
  // Match `keepFilesOnServer` as an identifier appearing inside the
  // scanAndDownload call args. Accepts both shorthand
  // (`{ keepFilesOnServer }`) and explicit (`{ keepFilesOnServer: v }`)
  // property forms. Bounded distance so we don't accidentally match a
  // far-away later occurrence in the file.
  assert.ok(
    /ftpService\.scanAndDownload\s*\([\s\S]{0,600}\bkeepFilesOnServer\b/.test(handlerSlice),
    'manual handler must pass keepFilesOnServer in the options arg to scanAndDownload',
  );
});

test('wiring: polling-service.scanFtp with missing ftpKeepFilesOnServer key → delete mode (migration discipline)', async () => {
  const cfg = {
    ftpHost: 'h', ftpUsername: 'u', ftpPassword: 'p', ftpPort: 21,
    ftpRemotePath: '/r',
    downloadDirectory: makeLocalBase(),
    // ftpKeepFilesOnServer deliberately absent — mimics an existing
    // config file predating this feature.
  };
  stubViaCache(path.join(SVC, 'config-service.js'), {
    get(key) { return cfg[key]; },
    getAll() { return { ...cfg }; },
    getFtpCredentials() {
      return { host: cfg.ftpHost, port: cfg.ftpPort, user: cfg.ftpUsername, password: cfg.ftpPassword };
    },
  });

  const original = ftpService.scanAndDownload.bind(ftpService);
  const captured = [];
  ftpService.scanAndDownload = async function (creds, remotePath, localBase, onProgress, opts) {
    captured.push({ creds, remotePath, localBase, opts });
    return { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  };

  try {
    delete require.cache[require.resolve(path.join(SVC, 'polling-service.js'))];
    const pollingService = require(path.join(SVC, 'polling-service.js'));
    await pollingService.scanFtp();

    assert.equal(captured.length, 1);
    assert.notEqual(captured[0].opts?.keepFilesOnServer, true,
      'missing config key must never be treated as truthy — existing installs stay on delete mode');
  } finally {
    ftpService.scanAndDownload = original;
  }
});
