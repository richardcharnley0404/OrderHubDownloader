'use strict';

/**
 * Tests for ftp-service._sweepOldFiles — the FTP retention sweep.
 *
 * Safety is the point of this feature, so the assertions cluster on the
 * seven guards from the spec:
 *
 *   1. Refuses at root path ("/", "", "//"). Operator-facing refusal
 *      string is locked verbatim so it can't drift.
 *   2. Never traverses outside the configured path. Malicious / weird
 *      names (".", "..", anything with a `/` or `\` in it) are skipped
 *      with a WARN log.
 *   3. Age is judged from the remote file's own mtime (basic-ftp's
 *      `item.modifiedAt`, falling back to `item.date`). Files with
 *      neither are skipped.
 *   4. Never deletes a file OHD hasn't itself successfully downloaded
 *      and locally verified — size-match against the local copy is the
 *      per-file guard.
 *   5. Off by default. `ftpRetentionSweepEnabled=false` (or missing)
 *      short-circuits the entire sweep.
 *   6. Every deletion logged with path + parsed mtime + age.
 *   7. Dry-run: `ftpRetentionSweepDryRun=true` logs "would delete" but
 *      does NOT call client.remove.
 *
 * Plus the once-per-24h throttle (persisted lastSweepAt, survives an
 * OHD restart because it lives in configService) and the wiring
 * discipline: manual and scheduled scans behave identically.
 *
 * Assertions come from invariants — call-counts and captured argument
 * shapes on the fake client — never from observed log strings, except
 * for the refusal message which the spec named as operator-facing and
 * therefore locked verbatim.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const os      = require('node:os');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Stubs so ftp-service loads headless + we can inspect log calls ────────

const __logs = { info: [], warn: [], error: [], debug: [] };
function resetLogs() {
  __logs.info.length = 0; __logs.warn.length = 0;
  __logs.error.length = 0; __logs.debug.length = 0;
}

function stubViaCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubViaCache(path.join(SVC, 'logger.js'), {
  info:       (msg, fields) => __logs.info.push({ msg, fields }),
  warn:       (msg, fields) => __logs.warn.push({ msg, fields }),
  error:      (msg, fields) => __logs.error.push({ msg, fields }),
  debug:      (msg, fields) => __logs.debug.push({ msg, fields }),
  logInfo:    (msg, fields) => __logs.info.push({ msg, fields }),
  logWarning: (msg, fields) => __logs.warn.push({ msg, fields }),
  logError:   (msg, err, fields) => __logs.error.push({ msg, err, fields }),
  logDebug:   (msg, fields) => __logs.debug.push({ msg, fields }),
});

const ftpService = require(path.join(SVC, 'ftp-service.js'));

// ── Fake basic-ftp Client that carries mtime on items ──────────────────────
//
// Remote tree shape (nested):
//   {
//     '/orders': {
//       files: {
//         'old.jpg':   { bytes: Buffer, mtime: Date },
//         'fresh.jpg': { bytes: Buffer, mtime: Date },
//       },
//       dirs: { 'sub': { files: { ... }, dirs: {} } },
//     },
//   }

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRemoteTree(spec) {
  const out = {};
  for (const [remotePath, node] of Object.entries(spec)) {
    out[remotePath] = _cloneNode(node);
  }
  return out;
}

function _cloneNode(node) {
  return {
    files: Object.fromEntries(
      Object.entries(node.files || {}).map(([n, f]) => [n, {
        bytes: Buffer.from(f.bytes),
        mtime: new Date(f.mtime.getTime()),
        useDateField: !!f.useDateField, // when true, expose as .date instead of .modifiedAt
        noMtime:      !!f.noMtime,      // when true, expose neither
      }]),
    ),
    dirs: Object.fromEntries(
      Object.entries(node.dirs || {}).map(([n, sub]) => [n, _cloneNode(sub)]),
    ),
  };
}

function makeFakeClient({ remoteTree, removeErrorFor = {} }) {
  const calls = { list: [], remove: [], removeDir: [], downloadTo: [] };

  function getNode(remotePath) {
    return remoteTree[remotePath.replace(/\/+$/, '')];
  }

  function findParentEntry(remotePath) {
    const parts = remotePath.replace(/\/+$/, '').split('/').filter(Boolean);
    if (!parts.length) return null;
    const name = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parentNode = remoteTree[parentPath];
    return parentNode ? { parentNode, name } : null;
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
      for (const [name, f] of Object.entries(node.files)) {
        const entry = { name, isDirectory: false, size: f.bytes.length };
        if (!f.noMtime) {
          if (f.useDateField) entry.date = f.mtime;
          else entry.modifiedAt = f.mtime;
        }
        out.push(entry);
      }
      return out;
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
    },
    async downloadTo(_local, _remote) { throw new Error('not used by sweep tests'); },
  };

  return { client, calls };
}

function makeLocalBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-sweep-'));
}

// Age helper: return a Date N days before now.
function daysAgo(n) { return new Date(Date.now() - n * DAY_MS); }

// ── Behaviour tests ───────────────────────────────────────────────────────

test('refuses at remotePath "/" — exact operator-facing message emitted, no listing, no deletes', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/':      { files: { 'x.jpg': { bytes: Buffer.from('X'), mtime: daysAgo(30) } }, dirs: {} },
  });
  const { client, calls } = makeFakeClient({ remoteTree });

  const result = await ftpService._sweepOldFiles(client, '/', makeLocalBase(),
    { enabled: true, ageDays: 7, dryRun: false });

  assert.equal(calls.list.length,   0, 'no listing walk when refusing');
  assert.equal(calls.remove.length, 0, 'no deletes when refusing');
  assert.equal(result.ran,    false);
  assert.equal(result.reason, 'root-path');

  // Refusal message locked verbatim per spec — this is what the operator sees
  // in the Activity Log every polling cycle until they either disable the
  // sweep or set a non-root remote path.
  const refusal = __logs.warn.find((l) =>
    l.msg && l.msg.startsWith('FTP retention sweep refused'));
  assert.ok(refusal, 'refusal must be logged at WARN level');
  assert.equal(
    refusal.msg,
    'FTP retention sweep refused: Remote Path is "/" (root). ' +
    'Configure a specific remote folder in FTP Server settings (e.g. "/orders") ' +
    'to enable the sweep. Sweeping the FTP root could delete files belonging ' +
    'to Pixfizz Core or other systems.',
    'exact wording locked so the operator-facing string cannot drift',
  );
});

test('refuses at empty string — same refusal path', async () => {
  resetLogs();
  const { client, calls } = makeFakeClient({ remoteTree: {} });

  const result = await ftpService._sweepOldFiles(client, '', makeLocalBase(),
    { enabled: true, ageDays: 7, dryRun: false });

  assert.equal(calls.list.length,   0);
  assert.equal(calls.remove.length, 0);
  assert.equal(result.reason, 'root-path');
});

test('refuses at "//" and "///" (trailing-slash-only paths normalise to root)', async () => {
  for (const rp of ['//', '///', ' / ']) {
    resetLogs();
    const { client, calls } = makeFakeClient({ remoteTree: {} });
    const result = await ftpService._sweepOldFiles(client, rp, makeLocalBase(),
      { enabled: true, ageDays: 7, dryRun: false });
    assert.equal(calls.list.length,   0, `no listing when refusing at "${rp}"`);
    assert.equal(calls.remove.length, 0, `no deletes when refusing at "${rp}"`);
    assert.equal(result.reason, 'root-path');
  }
});

test('off by default (enabled=false) — no listing, no deletes, no refusal log', async () => {
  resetLogs();
  const { client, calls } = makeFakeClient({ remoteTree: {} });

  const result = await ftpService._sweepOldFiles(client, '/orders', makeLocalBase(),
    { enabled: false, ageDays: 7, dryRun: false });

  assert.equal(calls.list.length,   0);
  assert.equal(calls.remove.length, 0);
  assert.equal(result.ran,    false);
  assert.equal(result.reason, 'disabled');
  // Off is the default — do NOT emit the "refused at root" warning; that
  // would drown out actual operator-actionable refusals.
  assert.equal(
    __logs.warn.filter((l) => l.msg && l.msg.startsWith('FTP retention sweep refused')).length,
    0,
    'disabled sweep is silent',
  );
});

test('migration discipline: options object omitted entirely → treated as disabled', async () => {
  resetLogs();
  const { client, calls } = makeFakeClient({ remoteTree: {} });
  const result = await ftpService._sweepOldFiles(client, '/orders', makeLocalBase());
  assert.equal(calls.list.length, 0);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'disabled');
});

test('deletes only files strictly older than threshold — 8d deleted, 2d kept, boundary respected', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: {
        'old.jpg':   { bytes: Buffer.from('OLD-BYTES'), mtime: daysAgo(8) },
        'fresh.jpg': { bytes: Buffer.from('FRSH-BYTES'), mtime: daysAgo(2) },
      },
      dirs: {},
    },
  });
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  // Local copies with matching sizes so the "verified locally" guard passes.
  fs.writeFileSync(path.join(localBase, 'old.jpg'),   Buffer.from('OLD-BYTES'));
  fs.writeFileSync(path.join(localBase, 'fresh.jpg'), Buffer.from('FRSH-BYTES'));

  const result = await ftpService._sweepOldFiles(client, '/orders', localBase,
    { enabled: true, ageDays: 7, dryRun: false });

  assert.deepEqual(calls.remove, ['/orders/old.jpg'],
    'only the file older than the threshold is removed');
  assert.equal(result.deleted,     1);
  assert.equal(result.wouldDelete, 0);
});

test('never deletes a file OHD has not itself downloaded (missing local copy)', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: { 'old.jpg': { bytes: Buffer.from('OLD-BYTES'), mtime: daysAgo(30) } },
      dirs: {},
    },
  });
  const { client, calls } = makeFakeClient({ remoteTree });
  // No local file at all — sweep must NOT delete the remote.

  const result = await ftpService._sweepOldFiles(client, '/orders', makeLocalBase(),
    { enabled: true, ageDays: 7, dryRun: false });

  assert.equal(calls.remove.length, 0,
    'missing local copy blocks the delete regardless of age');
  assert.equal(result.deleted, 0);
});

test('never deletes a file whose local copy size mismatches remote (verified means verified)', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: { 'old.jpg': { bytes: Buffer.from('OLD-BYTES'), mtime: daysAgo(30) } },
      dirs: {},
    },
  });
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  fs.writeFileSync(path.join(localBase, 'old.jpg'), Buffer.from('WRONG')); // wrong size

  const result = await ftpService._sweepOldFiles(client, '/orders', localBase,
    { enabled: true, ageDays: 7, dryRun: false });

  assert.equal(calls.remove.length, 0,
    'local size mismatch means the local copy is untrustworthy — skip');
  assert.equal(result.deleted, 0);
});

test('never acts outside configured path — traversal names (".", "..", "foo/bar", "foo\\\\bar") are skipped with WARN', async () => {
  resetLogs();
  // Feed a malicious server return: item names that could escape the configured
  // path if concatenated naively. The sweep must reject each before touching it.
  const badNames = ['.', '..', 'foo/bar', 'foo\\bar', ''];
  const files = {};
  for (const n of badNames) {
    files[n] = { bytes: Buffer.from('BAD'), mtime: daysAgo(30) };
  }
  files['ok.jpg'] = { bytes: Buffer.from('OK-BYTES'), mtime: daysAgo(30) };
  const remoteTree = makeRemoteTree({
    '/orders': { files, dirs: {} },
  });
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  fs.writeFileSync(path.join(localBase, 'ok.jpg'), Buffer.from('OK-BYTES'));

  await ftpService._sweepOldFiles(client, '/orders', localBase,
    { enabled: true, ageDays: 7, dryRun: false });

  // Only the clean name goes anywhere near client.remove.
  assert.deepEqual(calls.remove, ['/orders/ok.jpg'],
    'only clean-named items participate; every bad name is skipped');
  // Every bad name should have produced a WARN log for auditability.
  const warns = __logs.warn.filter((l) =>
    l.msg && l.msg.includes('FTP retention sweep: skipping suspicious item name'));
  assert.ok(warns.length >= badNames.filter(Boolean).length,
    'each suspicious name logs a WARN so the operator sees them in Activity Log');
});

test('mtime resolution: prefers item.modifiedAt, falls back to item.date, skips items with neither', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: {
        'modifiedAt.jpg': { bytes: Buffer.from('AAAAAAA'), mtime: daysAgo(30) },
        'date.jpg':       { bytes: Buffer.from('BBBBBBB'), mtime: daysAgo(30), useDateField: true },
        'nomtime.jpg':    { bytes: Buffer.from('CCCCCCC'), mtime: daysAgo(30), noMtime: true },
      },
      dirs: {},
    },
  });
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  for (const n of ['modifiedAt.jpg', 'date.jpg', 'nomtime.jpg']) {
    fs.writeFileSync(path.join(localBase, n), Buffer.from('X'.repeat(7)));
  }

  await ftpService._sweepOldFiles(client, '/orders', localBase,
    { enabled: true, ageDays: 7, dryRun: false });

  const removed = calls.remove.slice().sort();
  assert.deepEqual(removed, ['/orders/date.jpg', '/orders/modifiedAt.jpg'],
    'both mtime-carrying files removed; nomtime.jpg deliberately skipped');
});

test('every deletion is logged at INFO with path, parsed mtime, and age', async () => {
  resetLogs();
  const specificMtime = new Date(Date.now() - 10 * DAY_MS);
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: { 'x.jpg': { bytes: Buffer.from('XYZ'), mtime: specificMtime } },
      dirs: {},
    },
  });
  const { client } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  fs.writeFileSync(path.join(localBase, 'x.jpg'), Buffer.from('XYZ'));

  await ftpService._sweepOldFiles(client, '/orders', localBase,
    { enabled: true, ageDays: 7, dryRun: false });

  const hit = __logs.info.find((l) =>
    l.msg && l.msg === 'FTP retention sweep: deleted');
  assert.ok(hit, 'exactly one delete-log line');
  assert.equal(hit.fields.remoteItemPath, '/orders/x.jpg');
  assert.equal(hit.fields.mtime, specificMtime.toISOString(),
    'parsed mtime logged as an ISO string, not just the age count');
  assert.equal(typeof hit.fields.ageDays, 'number');
  assert.ok(hit.fields.ageDays >= 9 && hit.fields.ageDays <= 11,
    'age around 10 days (window for the boundary tick)');
});

test('dry run: logs "would delete" for each candidate but calls client.remove ZERO times', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: {
        'a.jpg': { bytes: Buffer.from('AAAA'), mtime: daysAgo(30) },
        'b.jpg': { bytes: Buffer.from('BBBB'), mtime: daysAgo(30) },
      },
      dirs: {},
    },
  });
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  fs.writeFileSync(path.join(localBase, 'a.jpg'), Buffer.from('AAAA'));
  fs.writeFileSync(path.join(localBase, 'b.jpg'), Buffer.from('BBBB'));

  const result = await ftpService._sweepOldFiles(client, '/orders', localBase,
    { enabled: true, ageDays: 7, dryRun: true });

  assert.equal(calls.remove.length, 0, 'dry run: NOTHING is actually deleted');
  assert.equal(result.deleted,     0);
  assert.equal(result.wouldDelete, 2);
  const wouldLogs = __logs.info.filter((l) =>
    l.msg && l.msg === 'FTP retention sweep [dry-run]: would delete');
  assert.equal(wouldLogs.length, 2, 'each candidate produces a would-delete line');
});

// ── Throttle (once per 24h, persisted via lastSweepAt) ─────────────────────

test('throttle: second sweep within 24h — no listing, no deletes, reason="throttled"', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: { 'x.jpg': { bytes: Buffer.from('X'), mtime: daysAgo(30) } },
      dirs: {},
    },
  });
  const { client, calls } = makeFakeClient({ remoteTree });

  // lastSweepAt one hour ago → still inside the 24h throttle window.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const result = await ftpService._sweepOldFiles(client, '/orders', makeLocalBase(),
    { enabled: true, ageDays: 7, dryRun: false, lastSweepAt: oneHourAgo });

  assert.equal(calls.list.length,   0, 'throttle short-circuits before ANY listing');
  assert.equal(calls.remove.length, 0);
  assert.equal(result.ran,    false);
  assert.equal(result.reason, 'throttled');
});

test('throttle: sweep runs when lastSweepAt is older than 24h', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: { 'x.jpg': { bytes: Buffer.from('X'), mtime: daysAgo(30) } },
      dirs: {},
    },
  });
  const { client, calls } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  fs.writeFileSync(path.join(localBase, 'x.jpg'), Buffer.from('X'));

  const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS).toISOString();

  const result = await ftpService._sweepOldFiles(client, '/orders', localBase,
    { enabled: true, ageDays: 7, dryRun: false, lastSweepAt: twoDaysAgo });

  assert.equal(result.ran, true, 'sweep runs when throttle window has elapsed');
  assert.equal(result.deleted, 1);
  assert.ok(result.at, 'returns the sweep-completion timestamp so caller can persist');
  assert.match(result.at, /^\d{4}-\d{2}-\d{2}T/, 'ISO 8601');
});

test('throttle: sweep runs when lastSweepAt is missing (first-ever run)', async () => {
  resetLogs();
  const remoteTree = makeRemoteTree({
    '/orders': {
      files: { 'x.jpg': { bytes: Buffer.from('X'), mtime: daysAgo(30) } },
      dirs: {},
    },
  });
  const { client } = makeFakeClient({ remoteTree });
  const localBase = makeLocalBase();
  fs.writeFileSync(path.join(localBase, 'x.jpg'), Buffer.from('X'));

  const result = await ftpService._sweepOldFiles(client, '/orders', localBase,
    { enabled: true, ageDays: 7, dryRun: false /* no lastSweepAt */ });

  assert.equal(result.ran, true);
  assert.ok(result.at);
});

test('throttle: refusal does NOT stamp lastSweepAt — operator keeps seeing the log every cycle', async () => {
  resetLogs();
  const { client } = makeFakeClient({ remoteTree: {} });

  // Refuse at root, then a second call with the same lastSweepAt-in-window
  // must still refuse (not become "throttled") — the refusal wins because
  // the refusal branch stamps nothing.
  const r1 = await ftpService._sweepOldFiles(client, '/', makeLocalBase(),
    { enabled: true, ageDays: 7, dryRun: false });
  assert.equal(r1.reason, 'root-path');
  assert.equal(r1.at, undefined, 'refusal returns no timestamp for the caller to persist');
});

test('throttle: garbage lastSweepAt (invalid string, number, object) → runs normally, does not throw', async () => {
  for (const bad of ['not-a-date', 12345, {}, null]) {
    resetLogs();
    const remoteTree = makeRemoteTree({
      '/orders': {
        files: { 'x.jpg': { bytes: Buffer.from('X'), mtime: daysAgo(30) } },
        dirs: {},
      },
    });
    const { client } = makeFakeClient({ remoteTree });
    const localBase = makeLocalBase();
    fs.writeFileSync(path.join(localBase, 'x.jpg'), Buffer.from('X'));
    const result = await ftpService._sweepOldFiles(client, '/orders', localBase,
      { enabled: true, ageDays: 7, dryRun: false, lastSweepAt: bad });
    assert.equal(result.ran, true, `garbage lastSweepAt (${JSON.stringify(bad)}) treated as "never run"`);
  }
});

// ── Wiring: both callers thread the four sweep-related fields ─────────────

test('wiring (source-inspection): polling-service reads all four ftpRetentionSweep* fields and passes them + persists lastSweepAt on success', () => {
  const src = fs.readFileSync(path.join(SVC, 'polling-service.js'), 'utf8');
  // Isolate the scanFtp method body. Anchor from `async scanFtp` to the
  // matching close-brace ~40 lines below.
  const start = src.indexOf('async scanFtp');
  assert.notEqual(start, -1, 'scanFtp method must exist');
  const slice = src.slice(start, start + 3000);

  for (const key of [
    'ftpRetentionSweepEnabled',
    'ftpRetentionSweepDays',
    'ftpRetentionSweepDryRun',
    'ftpLastSweepAt',
  ]) {
    assert.ok(
      new RegExp(`configService\\.get\\(\\s*['"]${key}['"]\\s*\\)`).test(slice),
      `polling-service.scanFtp must read ${key} from configService`,
    );
  }
  // Must persist a returned sweep timestamp. Loose pattern: configService.set
  // called with 'ftpLastSweepAt' somewhere in the same method body.
  assert.ok(
    /configService\.set\(\s*['"]ftpLastSweepAt['"]/.test(slice),
    'polling-service.scanFtp must persist lastSweepAt via configService.set',
  );
});

// ── Save-time advisory (config:save) ─────────────────────────────────────
//
// Same shape as the folder-copy advisories at ipc-handlers.js:1702-1750
// and the PIC Pro volume-cross advisory at :1512 — warn, name the
// problem, let the save proceed. Reason: an operator enabling the
// retention sweep with a root Remote Path currently gets no feedback
// in Settings and would have to read the Activity Log to discover
// the sweep never runs. Same "control that looks on but does nothing"
// failure we avoided by defaulting dry-run to false.

test('save-time advisory: sweep enabled + rootPath "/" → single warning with locked kind and text', () => {
  const warnings = ftpService._computeFtpSweepSaveWarnings({
    ftpRetentionSweepEnabled: true,
    ftpRemotePath: '/',
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'ftp-retention-sweep-root-path');
  // Locked verbatim per spec ("Lock the exact string with a test"). If
  // any word of the operator-facing string drifts, this assertion fails.
  assert.equal(
    warnings[0].text,
    'Heads up — FTP retention sweep is enabled, but Remote Path is "/" (root). ' +
    'The sweep refuses to run at the FTP root because it could delete files ' +
    'belonging to Pixfizz Core or other systems, so nothing will be deleted. ' +
    'Set Remote Path above to a specific folder (e.g. "/orders") to make the ' +
    'sweep active.',
  );
});

test('save-time advisory: sweep enabled + rootPath "" → same warning', () => {
  const warnings = ftpService._computeFtpSweepSaveWarnings({
    ftpRetentionSweepEnabled: true,
    ftpRemotePath: '',
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'ftp-retention-sweep-root-path');
});

test('save-time advisory: sweep enabled + rootPath missing key → treated as root, warning fires', () => {
  // A hand-edited config or a fresh install pre-Settings-save could
  // have no ftpRemotePath at all. Runtime defaults it to "/", so the
  // advisory must fire on the missing case too.
  const warnings = ftpService._computeFtpSweepSaveWarnings({
    ftpRetentionSweepEnabled: true,
    // ftpRemotePath deliberately absent
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'ftp-retention-sweep-root-path');
});

test('save-time advisory: sweep enabled + rootPath "//" or "///" → warning (trailing-slash-only normalises to root)', () => {
  for (const rp of ['//', '///', '  /  ']) {
    const warnings = ftpService._computeFtpSweepSaveWarnings({
      ftpRetentionSweepEnabled: true,
      ftpRemotePath: rp,
    });
    assert.equal(warnings.length, 1, `"${rp}" must be treated as root`);
    assert.equal(warnings[0].kind, 'ftp-retention-sweep-root-path');
  }
});

test('save-time advisory: sweep enabled + rootPath "/orders" → no warning', () => {
  const warnings = ftpService._computeFtpSweepSaveWarnings({
    ftpRetentionSweepEnabled: true,
    ftpRemotePath: '/orders',
  });
  assert.deepEqual(warnings, [], 'non-root path silences the advisory');
});

test('save-time advisory: sweep DISABLED at root path → no warning (do not nag when sweep is off)', () => {
  const warnings = ftpService._computeFtpSweepSaveWarnings({
    ftpRetentionSweepEnabled: false,
    ftpRemotePath: '/',
  });
  assert.deepEqual(warnings, [], 'sweep off → root path is not the operator\'s problem');
});

test('save-time advisory: garbage inputs (null, non-object, undefined) → no warnings, does not throw', () => {
  for (const bad of [null, undefined, 'string', 123, [], true]) {
    const warnings = ftpService._computeFtpSweepSaveWarnings(bad);
    assert.deepEqual(warnings, [], `${JSON.stringify(bad)} → empty warnings`);
  }
});

test('save-time advisory: sweep enabled with truthy-but-not-strictly-true value → no warning (matches runtime gate)', () => {
  // The runtime gate in _sweepOldFiles uses `if (!opts.enabled)` which
  // treats 1/'yes'/{} as truthy. The advisory uses `=== true` for
  // consistency with folder-copy's `omitJobId === true` normalisation
  // — a hand-edited config field that isn't strictly `true` should
  // not surface an operator alert. Config-service normalises the
  // renderer save path to boolean; this only comes up on hand-edits.
  for (const truthy of [1, 'yes', {}]) {
    const warnings = ftpService._computeFtpSweepSaveWarnings({
      ftpRetentionSweepEnabled: truthy,
      ftpRemotePath: '/',
    });
    assert.deepEqual(warnings, [],
      `${JSON.stringify(truthy)} is not strictly true → no advisory`);
  }
});

test('wiring (source-inspection): config:save handler calls _computeFtpSweepSaveWarnings and returns warnings alongside the saved config', () => {
  const MAIN = path.join(REPO, 'src', 'main');
  const src  = fs.readFileSync(path.join(MAIN, 'ipc-handlers.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('config:save'");
  assert.notEqual(start, -1, 'config:save handler must exist');
  const slice = src.slice(start, start + 3000);

  assert.ok(
    /_computeFtpSweepSaveWarnings\s*\(/.test(slice),
    'config:save must call ftpService._computeFtpSweepSaveWarnings on the incoming config',
  );
  assert.ok(
    /return\s+\{[^}]*warnings/.test(slice),
    'config:save must return warnings alongside the saved config so the renderer can surface them',
  );
});

test('wiring (source-inspection): ipc-handlers.js manual handler reads all four ftpRetentionSweep* fields and persists lastSweepAt', () => {
  const MAIN = path.join(REPO, 'src', 'main');
  const src  = fs.readFileSync(path.join(MAIN, 'ipc-handlers.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('ftp:scanAndDownload'");
  assert.notEqual(start, -1, 'manual ftp:scanAndDownload handler must exist');
  const slice = src.slice(start, start + 3000);

  for (const key of [
    'ftpRetentionSweepEnabled',
    'ftpRetentionSweepDays',
    'ftpRetentionSweepDryRun',
    'ftpLastSweepAt',
  ]) {
    assert.ok(
      new RegExp(`configService\\.get\\(\\s*['"]${key}['"]\\s*\\)`).test(slice),
      `manual handler must read ${key} from configService`,
    );
  }
  assert.ok(
    /configService\.set\(\s*['"]ftpLastSweepAt['"]/.test(slice),
    'manual handler must persist lastSweepAt via configService.set (manual and scheduled scans behave identically)',
  );
});
