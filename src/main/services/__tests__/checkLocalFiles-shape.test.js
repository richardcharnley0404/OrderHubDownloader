/**
 * Unit tests for jobDownloadService.checkLocalFiles — pins the rich
 * three-state shape that polling-service depends on for the
 * awaiting-manifest gate.
 *
 *   hasManifest                 → markReceived
 *   hasFiles && !hasManifest    → stamp _awaitingManifest
 *   !hasFiles                   → still downloading
 *
 * `found` is preserved as an alias for hasFiles for backward compat with
 * the AI Quality Gate call sites (ipc-handlers.js:518, 2590).
 *
 * Run via:  npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const fsp    = require('node:fs/promises');
const path   = require('node:path');
const os     = require('node:os');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// Stub config-service + logger BEFORE loading the SUT so its module-load
// `require('./config-service')` is intercepted.
let __downloadDirectory = '';
const fakeConfigService = { get: (key) => key === 'downloadDirectory' ? __downloadDirectory : undefined };
const noopLogger = { info: () => {}, warn: () => {}, logError: () => {}, logWarning: () => {} };

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubInCache(path.join(SVC, 'config-service.js'), fakeConfigService);
stubInCache(path.join(SVC, 'logger.js'),         noopLogger);

const jobDownloadService = require(path.join(SVC, 'job-download-service.js'));

// ── Helpers ─────────────────────────────────────────────────────────────────

const JOB = { id: 38461218, order_id: 'ord-1', order_number: 'PXSTAGE-XYZ' };

async function makeWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-clf-'));
  __downloadDirectory = root;
  const orderFolder = path.join(root, `${JOB.order_number}_${JOB.order_id}`);
  const jobFolder   = path.join(orderFolder, `${JOB.order_number}_${JOB.id}`);
  await fsp.mkdir(jobFolder, { recursive: true });
  return { root, orderFolder, jobFolder };
}

async function dropFile(dir, name) {
  await fsp.writeFile(path.join(dir, name), 'x');
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('downloadDirectory unset → { found:false, hasFiles:false, hasManifest:false }', () => {
  __downloadDirectory = '';
  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.deepEqual(r, { found: false, hasFiles: false, hasManifest: false });
});

test('order folder missing → { found:false, hasFiles:false, hasManifest:false } + paths', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));
  // Delete the inner job folder to simulate "still downloading"
  await fsp.rm(ws.jobFolder, { recursive: true, force: true });

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.found, false);
  assert.equal(r.hasFiles, false);
  assert.equal(r.hasManifest, false);
  assert.ok(r.localPath);
  assert.ok(r.manifestPath);
});

test('folder exists but empty → hasFiles:false, hasManifest:false', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.hasFiles, false);
  assert.equal(r.hasManifest, false);
  assert.equal(r.found, false);
});

test('files present, manifest absent → hasFiles:true, hasManifest:false (the race window)', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));
  await dropFile(ws.jobFolder, 'photo-001.jpg');

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.hasFiles, true);
  assert.equal(r.hasManifest, false);
  assert.equal(r.found, true, 'found === hasFiles for backward compat with AI Quality Gate');
  assert.equal(r.manifestPath, path.join(ws.orderFolder, `${JOB.order_number}.json`));
  assert.equal(r.fileCount, 1);
});

test('files + manifest present → hasFiles:true, hasManifest:true', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));
  await dropFile(ws.jobFolder, 'photo-001.jpg');
  await fsp.writeFile(path.join(ws.orderFolder, `${JOB.order_number}.json`), '{}');

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.hasFiles, true);
  assert.equal(r.hasManifest, true);
  assert.equal(r.found, true);
});

test('manifest present but no files → hasFiles:false, hasManifest:true (defensive)', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));
  // Write a *valid JSON* manifest — bare existence isn't enough since
  // hasManifest also requires non-empty + parseable (see partial-write tests).
  await fsp.writeFile(path.join(ws.orderFolder, `${JOB.order_number}.json`), '{}');

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.hasFiles, false);
  assert.equal(r.hasManifest, true,
    'manifest existence is independent of file count — both fields stand alone');
});

// ── FTP partial-write race tests ───────────────────────────────────────────
//
// FTP delivery is NOT atomic: basic-ftp's downloadTo writes directly to the
// destination path (ftp-service.js:429). During the stream the manifest is
// observable with 0 bytes or partial content. bare existsSync would
// pass → markReceived → dispatch parses → throws. hasManifest hardens
// against this by requiring non-empty + JSON-parseable.

test('partial-write race: 0-byte manifest → hasManifest:false (treat as not-yet-ready)', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));
  await dropFile(ws.jobFolder, 'photo-001.jpg');
  // basic-ftp opens the destination file at the start of the stream;
  // for a brief window the file exists at zero bytes.
  await fsp.writeFile(path.join(ws.orderFolder, `${JOB.order_number}.json`), '');

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.hasFiles, true);
  assert.equal(r.hasManifest, false,
    '0-byte manifest must not pass the gate — polling loop retries next cycle');
});

test('partial-write race: truncated JSON manifest → hasManifest:false', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));
  await dropFile(ws.jobFolder, 'photo-001.jpg');
  // Mid-stream snapshot: opening brace + partial key, no terminator.
  await fsp.writeFile(
    path.join(ws.orderFolder, `${JOB.order_number}.json`),
    '{"orderNumber":"PXSTAGE-XYZ","jobs":[{"jobId":"38'
  );

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.hasFiles, true);
  assert.equal(r.hasManifest, false,
    'partial JSON must not pass the gate — without this the next dispatch throws a parse error');
});

test('complete JSON manifest → hasManifest:true', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));
  await dropFile(ws.jobFolder, 'photo-001.jpg');
  await fsp.writeFile(
    path.join(ws.orderFolder, `${JOB.order_number}.json`),
    JSON.stringify({ orderNumber: 'PXSTAGE-XYZ', orderId: 'ord-1', jobs: [{ jobId: '38461218', images: [] }] })
  );

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.hasManifest, true, 'fully-written JSON passes — gate is "ready for dispatch"');
});

test('non-JSON garbage in manifest → hasManifest:false', async (t) => {
  // Pathological case — protects against the file being something other than
  // JSON (e.g. an HTML error page from a misconfigured FTP server). Same path
  // as the truncated case: false → retry next poll → timeout escalates.
  const ws = await makeWorkspace();
  t.after(() => fs.rmSync(ws.root, { recursive: true, force: true }));
  await dropFile(ws.jobFolder, 'photo-001.jpg');
  await fsp.writeFile(
    path.join(ws.orderFolder, `${JOB.order_number}.json`),
    '<html><body>404 Not Found</body></html>'
  );

  const r = jobDownloadService.checkLocalFiles(JOB);
  assert.equal(r.hasManifest, false);
});
