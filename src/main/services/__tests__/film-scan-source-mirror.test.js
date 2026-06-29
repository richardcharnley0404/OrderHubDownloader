'use strict';

/**
 * Scanner source mirror — copies new/changed stable folders from the lab's
 * pristine scanner folder into the watch folder, without ever modifying the
 * source, and without re-copying folders it has already ingested.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const fs      = require('node:fs');
const path    = require('node:path');

// electron-store → electron.app. Stub so the ledger store loads headless.
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return __originalRequire.apply(this, arguments);
};

const mirrorModule = require(path.join(__dirname, '..', 'film-scan-source-mirror.js'));
const { folderSignature, decideIngest, discoverRollFolders, FilmScanSourceMirror } = mirrorModule;

const STABLE_AGE_MS = 20 * 60 * 1000; // older than a 5-min watchguard

function makeFolder(parent, name, files) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - STABLE_AGE_MS);
  for (const [fname, content] of Object.entries(files)) {
    const p = path.join(dir, fname);
    fs.writeFileSync(p, content);
    fs.utimesSync(p, past, past); // backdate so it passes the stability cutoff
  }
  return dir;
}

function makeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-srcmirror-'));
  const source = path.join(base, 'scanner');
  const watch  = path.join(base, 'watch');
  fs.mkdirSync(source);
  fs.mkdirSync(watch);
  return { base, source, watch };
}

function newService() {
  const svc = new FilmScanSourceMirror();
  svc._clearLedger(); // isolate from prior runs (the store file persists)
  return svc;
}

// Stability uses max(mtime, birthtime); Node's utimesSync can't backdate
// birthtime, so a freshly-created test file never reads as "old enough". A
// NEGATIVE watchguard puts the cutoff in the future, so every file counts as
// stable — the clean way to exercise the copy path without sleeping. (Real
// scanner files age past a positive watchguard normally.)
function stableConfig(source, watch) {
  return { filmScansSourceFolder: source, filmScansWatchFolder: watch, filmScansWatchguardMinutes: -10 };
}

test('decideIngest covers all four outcomes', () => {
  assert.equal(decideIngest({ stable: false, watchExists: false, ledgerSig: null, currentSig: 'x' }), 'skip-unstable');
  assert.equal(decideIngest({ stable: true,  watchExists: true,  ledgerSig: null, currentSig: 'x' }), 'skip-watch-busy');
  assert.equal(decideIngest({ stable: true,  watchExists: false, ledgerSig: 'x',  currentSig: 'x' }), 'skip-unchanged');
  assert.equal(decideIngest({ stable: true,  watchExists: false, ledgerSig: 'x',  currentSig: 'y' }), 'copy'); // changed
  assert.equal(decideIngest({ stable: true,  watchExists: false, ledgerSig: null, currentSig: 'y' }), 'copy'); // unseen
});

test('folderSignature changes when content changes', () => {
  const { source } = makeBase();
  const dir = makeFolder(source, 'R', { 'a.tif': 'aaa' });
  const sig1 = folderSignature(dir);
  fs.writeFileSync(path.join(dir, 'b.tif'), 'bbbb');
  assert.notEqual(sig1, folderSignature(dir));
});

test('mirror copies a new stable folder once, then never re-copies it', async () => {
  const { source, watch } = makeBase();
  makeFolder(source, 'ROLL-1', { '1.tif': 'x', '2.tif': 'y' });
  const svc = newService();
  const config = stableConfig(source, watch);

  const r1 = await svc.mirror(config, null);
  assert.equal(r1.copied, 1);
  assert.ok(fs.existsSync(path.join(watch, 'ROLL-1', '1.tif')));

  // Simulate the pipeline consuming the watch copy (delete from watch).
  fs.rmSync(path.join(watch, 'ROLL-1'), { recursive: true, force: true });

  const r2 = await svc.mirror(config, null);
  assert.equal(r2.copied, 0, 'unchanged source must not be re-copied');
  assert.equal(fs.existsSync(path.join(watch, 'ROLL-1')), false);

  // Source is never modified — pristine archive.
  assert.ok(fs.existsSync(path.join(source, 'ROLL-1', '1.tif')));
});

test('mirror does not re-copy while a prior copy still sits in the watch folder', async () => {
  const { source, watch } = makeBase();
  makeFolder(source, 'ROLL-2', { '1.tif': 'x' });
  const svc = newService();
  const config = stableConfig(source, watch);

  assert.equal((await svc.mirror(config, null)).copied, 1);
  assert.equal((await svc.mirror(config, null)).copied, 0); // still in watch + ledgered
});

test('mirror re-copies when the source content changes under the same name', async () => {
  const { source, watch } = makeBase();
  makeFolder(source, 'ROLL-3', { '1.tif': 'x' });
  const svc = newService();
  const config = stableConfig(source, watch);

  await svc.mirror(config, null);
  fs.rmSync(path.join(watch, 'ROLL-3'), { recursive: true, force: true }); // consume

  // Re-scan: same name, new (backdated) content.
  const past = new Date(Date.now() - STABLE_AGE_MS);
  const f = path.join(source, 'ROLL-3', '2.tif');
  fs.writeFileSync(f, 'new');
  fs.utimesSync(f, past, past);

  assert.equal((await svc.mirror(config, null)).copied, 1);
});

test('mirror skips a folder the scanner is still writing (not stable)', async () => {
  const { source, watch } = makeBase();
  // Fresh files (mtime = now) → not older than the watchguard cutoff.
  const dir = path.join(source, 'ROLL-4');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '1.tif'), 'x'); // NOT backdated
  const svc = newService();
  const config = { filmScansSourceFolder: source, filmScansWatchFolder: watch, filmScansWatchguardMinutes: 5 };

  const r = await svc.mirror(config, null);
  assert.equal(r.copied, 0);
  assert.equal(fs.existsSync(path.join(watch, 'ROLL-4')), false);
});

test('mirror is a no-op when no source folder is configured', async () => {
  const { watch } = makeBase();
  const svc = newService();
  const r = await svc.mirror({ filmScansSourceFolder: '', filmScansWatchFolder: watch }, null);
  assert.deepEqual(r, { copied: 0, skipped: 0, errors: [] });
});

test('discoverRollFolders handles both flat and date-nested layouts', () => {
  const { source } = makeBase();
  makeFolder(source, 'FLATROLL', { '1.tif': 'x' });               // flat roll (has files)
  makeFolder(path.join(source, '06272026'), '00000004', { '1.tif': 'y' }); // date-nested
  makeFolder(path.join(source, '06272026'), '00000005', { '1.tif': 'z' });
  const found = discoverRollFolders(source).map(r => `${r.relPath}|${r.leaf}`).sort();
  assert.deepEqual(found, [
    '06272026/00000004|00000004',
    '06272026/00000005|00000005',
    'FLATROLL|FLATROLL',
  ]);
});

test('mirror flattens date-nested roll folders into the watch folder', async () => {
  const { source, watch } = makeBase();
  makeFolder(path.join(source, '06272026'), '00000004', { '1.tif': 'a' });
  makeFolder(path.join(source, '06272026'), '00000005', { '1.tif': 'b' });
  makeFolder(path.join(source, '06282026'), '00000006', { '1.tif': 'c' });
  const svc = newService();
  const config = stableConfig(source, watch);

  const r = await svc.mirror(config, null);
  assert.equal(r.copied, 3);
  // Leaf roll folders land flat in the watch folder...
  assert.ok(fs.existsSync(path.join(watch, '00000004', '1.tif')));
  assert.ok(fs.existsSync(path.join(watch, '00000005', '1.tif')));
  assert.ok(fs.existsSync(path.join(watch, '00000006', '1.tif')));
  // ...and the date level is NOT recreated in the watch folder.
  assert.equal(fs.existsSync(path.join(watch, '06272026')), false);
  assert.equal(fs.existsSync(path.join(watch, '06282026')), false);
  // Source untouched.
  assert.ok(fs.existsSync(path.join(source, '06272026', '00000004', '1.tif')));
});
