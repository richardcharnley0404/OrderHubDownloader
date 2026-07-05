'use strict';

/**
 * Unit tests for src/main/services/s3-artwork-downloader.js.
 *
 * Run via:
 *   npm test
 *
 * Strategy: stand up a localhost HTTP server with canned responses keyed by
 * request path. The downloader receives a `http://127.0.0.1:${port}/${path}`
 * URL per file; the real `http` module routes through the test server (the
 * downloader picks protocol from urlObj.protocol). Real fs, real sidecar
 * I/O, all under a per-test tempdir cleaned up via t.after.
 *
 * Covers:
 *   - Pure logic: collision rule, orphan .tmp sweep, sidecar field migration.
 *   - All 7 brief M1 scenarios (single, collision, idempotent re-poll,
 *     incremental new id, empty artwork_files, mixed-source coexist with
 *     FTP files on disk, network-failure cleanup + retry).
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs/promises');
const fssync  = require('node:fs');
const path    = require('node:path');
const os      = require('node:os');
const http    = require('node:http');

const { createS3ArtworkDownloader } = require('../s3-artwork-downloader');
const sidecarManager = require('../../jobs/sidecarManager');

// ── Test helpers ─────────────────────────────────────────────────────────────

// Silent logger so test runs don't spam stdout.
const silentLogger = {
  info:        () => {},
  warn:        () => {},
  error:       () => {},
  logInfo:     () => {},
  logWarning:  () => {},
  logError:    () => {},
};

function newDownloader() {
  return createS3ArtworkDownloader({ logger: silentLogger });
}

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-test-'));
}

/**
 * Spin up a localhost HTTP server with canned responses keyed by req.url.
 * Route shape: { body: Buffer } or { status: number, body?: Buffer }.
 */
async function startTestServer(routes) {
  const server = http.createServer((req, res) => {
    const route = routes.get(req.url);
    if (!route) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(route.status || 200, { 'Content-Type': 'application/octet-stream' });
    res.end(route.body || Buffer.from(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url(p) { return `http://127.0.0.1:${port}${p}`; },
    close() { return new Promise(r => server.close(r)); },
  };
}

function makeJob({
  id = 'JOB-1',
  order_id = 'ORD-1',
  order_number = 'PX-001',
  quantity = 3,
  artwork_source = 'manual',
  artwork_files = [],
} = {}) {
  return { id, order_id, order_number, quantity, artwork_source, artwork_files };
}

function makeArtworkFile({
  id,
  file_name,
  file_url,
  artwork_type = 'optimized',
  source = 'manual',
  production_ready = true,
  copies = 1,
} = {}) {
  return { id, file_name, file_url, artwork_type, source, production_ready, copies };
}

function jobPathOf(downloadDir, job) {
  return path.join(downloadDir, `${job.order_number}_${job.order_id}`, `${job.order_number}_${job.id}`);
}

// ── Pure-logic tests ─────────────────────────────────────────────────────────

test('Guard rail: is_film_development job → no downloads, no folders created', async (t) => {
  const downloadDir = await makeTempDir();
  t.after(async () => { await fs.rm(downloadDir, { recursive: true, force: true }); });

  // Give it a normally-download-worthy artwork_files list so we can prove
  // the film-dev short-circuit fires BEFORE any download attempt.
  const job = makeJob({
    id: 'JOB-FD',
    order_id: 'ORD-FD',
    order_number: 'PX-FD',
    artwork_files: [
      makeArtworkFile({ id: 'ffffffff-1111-2222-3333-444444444444', file_name: 'roll_001.zip', file_url: 'http://example.invalid/roll' }),
    ],
  });
  job.is_film_development = true;

  const result = await newDownloader().downloadJobArtwork(job, downloadDir);
  assert.deepEqual(result, { downloaded: [], skipped: [], failed: [] },
    'film-dev short-circuit returns empty result — no download attempts');

  // No job folder was created (short-circuit fires before mkdir).
  const jobPath = jobPathOf(downloadDir, job);
  assert.equal(fssync.existsSync(jobPath), false, 'no artwork folder for film-dev jobs');
});

test('Pure: collision rule renames second file with __id8 suffix', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/a', { body: Buffer.from('AAA') }],
    ['/b', { body: Buffer.from('BBB') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const job = makeJob({
    artwork_files: [
      makeArtworkFile({ id: 'aaaaaaaa-1111-2222-3333-444444444444', file_name: 'img.jpg', file_url: srv.url('/a') }),
      makeArtworkFile({ id: 'bbbbbbbb-1111-2222-3333-444444444444', file_name: 'img.jpg', file_url: srv.url('/b') }),
    ],
  });

  const result = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(result.downloaded.length, 2);
  assert.equal(result.failed.length, 0);

  const jobPath = jobPathOf(downloadDir, job);
  assert.equal(fssync.existsSync(path.join(jobPath, 'img.jpg')), true);
  assert.equal(fssync.existsSync(path.join(jobPath, 'img__bbbbbbbb.jpg')), true);

  const { sidecar } = await sidecarManager.loadSidecar(`${job.order_number}_${job.id}`, jobPath);
  assert.equal(sidecar.s3ArtworkFileIdsKnown.length, 2);
});

test('Pure: orphan .tmp in the job folder is swept before downloads start', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/a', { body: Buffer.from('AAA') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [makeArtworkFile({ id: 'orph-1111-2222-3333-4444-555555555555', file_name: 'a.jpg', file_url: srv.url('/a') })],
  });
  const jobPath = jobPathOf(downloadDir, job);
  await fs.mkdir(jobPath, { recursive: true });
  const orphanPath = path.join(jobPath, 'a.jpg.tmp');
  await fs.writeFile(orphanPath, 'STALE');

  await newDownloader().downloadJobArtwork(job, downloadDir);

  assert.equal(fssync.existsSync(orphanPath), false, 'orphan .tmp should be unlinked at start of downloadJobArtwork');
  assert.equal(fssync.existsSync(path.join(jobPath, 'a.jpg')), true);
});

test('Pure: sidecarManager hydrates legacy sidecars with S3 field defaults', async (t) => {
  const downloadDir = await makeTempDir();
  t.after(() => fs.rm(downloadDir, { recursive: true, force: true }));

  const job = makeJob();
  const jobPath = jobPathOf(downloadDir, job);
  await fs.mkdir(jobPath, { recursive: true });

  // Hand-craft a sidecar that pre-dates the M1 schema bump: no S3 fields on
  // the image entry, no job-level s3ArtworkFileIdsKnown.
  const legacy = {
    jobId: `${job.order_number}_${job.id}`,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    reprintOf: null,
    images: [{
      filename: 'legacy.jpg',
      qtyOriginal: 2, qtyCurrent: 2,
      corrections: { cyan: 0, magenta: 0, yellow: 0 },
      reprint: false, reprintJobId: null,
      enhanced: false, enhancementSource: null, enhancedPath: null, enhancedAt: null, enhancementModel: null,
      integritySuspect: null,
      aiQuality: {
        scored: false, score: null, thresholdAtScoreTime: null, passed: true,
        modelVersion: null, inferenceMs: null, scoredAt: null, error: null,
        fixupHistory: [], operatorDecision: { kind: 'none', decidedAt: null, note: null },
      },
      originalFilename: null, recropPath: null, recropOf: null, recroppedAt: null,
      // NB: no artworkFileId/artworkSource/artworkType/productionReady/originalFileName
    }],
    // NB: no s3ArtworkFileIdsKnown
  };
  await fs.writeFile(path.join(jobPath, `${job.order_number}_${job.id}.json`), JSON.stringify(legacy, null, 2));

  const { sidecar } = await sidecarManager.loadSidecar(`${job.order_number}_${job.id}`, jobPath);
  assert.deepEqual(sidecar.s3ArtworkFileIdsKnown, []);
  const img = sidecar.images.find(i => i.filename === 'legacy.jpg');
  assert.ok(img);
  assert.equal(img.artworkFileId,    null);
  assert.equal(img.artworkSource,    null);
  assert.equal(img.artworkType,      null);
  assert.equal(img.productionReady,  null);
  assert.equal(img.originalFileName, null);

  // Round-trip: hydrated fields persist on subsequent loads.
  const { sidecar: again } = await sidecarManager.loadSidecar(`${job.order_number}_${job.id}`, jobPath);
  assert.deepEqual(again.s3ArtworkFileIdsKnown, []);
  assert.equal(again.images[0].artworkFileId, null);
});

// ── Brief M1 scenarios (1–7) ─────────────────────────────────────────────────

test('Scenario 1: manual job, single file, fresh poll → file + sidecar entry + id appended', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/img', { body: Buffer.from('FAKE_JPEG_BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const job = makeJob({
    quantity: 3,
    artwork_files: [makeArtworkFile({
      id: 'uuid-aaaa-1111-2222-3333-444444444444',
      file_name: 'img.jpg', file_url: srv.url('/img'),
      artwork_type: 'optimized', source: 'manual', production_ready: true,
    })],
  });

  const result = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.downloaded[0].diskName,        'img.jpg');
  assert.equal(result.downloaded[0].artworkType,     'optimized');
  assert.equal(result.downloaded[0].source,          'manual');
  assert.equal(result.downloaded[0].productionReady, true);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.failed.length,  0);

  const jobPath  = jobPathOf(downloadDir, job);
  const filePath = path.join(jobPath, 'img.jpg');
  assert.equal(fssync.existsSync(filePath), true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'FAKE_JPEG_BYTES');

  const { sidecar } = await sidecarManager.loadSidecar(`${job.order_number}_${job.id}`, jobPath);
  assert.deepEqual(sidecar.s3ArtworkFileIdsKnown, ['uuid-aaaa-1111-2222-3333-444444444444']);
  const entry = sidecar.images.find(i => i.filename === 'img.jpg');
  assert.ok(entry, 'expected sidecar entry for img.jpg');
  assert.equal(entry.artworkFileId,    'uuid-aaaa-1111-2222-3333-444444444444');
  assert.equal(entry.artworkSource,    'manual');
  assert.equal(entry.artworkType,      'optimized');
  assert.equal(entry.productionReady,  true);
  assert.equal(entry.originalFileName, 'img.jpg');
  // M3 qty fix (2026-05-25): qtyOriginal = file.copies (default 1).
  // job.quantity is informational only — no multiplication. See the
  // M3 qty-math fix in s3-artwork-downloader.js _buildImageEntry.
  assert.equal(entry.qtyOriginal, 1);
  assert.equal(entry.qtyCurrent,  1);
});

test('Scenario 2: two files with identical file_name → collision rename second', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/a', { body: Buffer.from('AAA') }],
    ['/b', { body: Buffer.from('BBB') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const job = makeJob({
    artwork_files: [
      makeArtworkFile({ id: 'aaaaaaaa-1111-2222-3333-444444444444', file_name: 'photo.jpg', file_url: srv.url('/a') }),
      makeArtworkFile({ id: 'bbbbbbbb-1111-2222-3333-444444444444', file_name: 'photo.jpg', file_url: srv.url('/b') }),
    ],
  });

  const result = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(result.downloaded.length, 2);
  const diskNames = result.downloaded.map(d => d.diskName).sort();
  assert.deepEqual(diskNames, ['photo.jpg', 'photo__bbbbbbbb.jpg']);

  const jobPath = jobPathOf(downloadDir, job);
  assert.equal(fssync.existsSync(path.join(jobPath, 'photo.jpg')),           true);
  assert.equal(fssync.existsSync(path.join(jobPath, 'photo__bbbbbbbb.jpg')), true);

  const { sidecar } = await sidecarManager.loadSidecar(`${job.order_number}_${job.id}`, jobPath);
  assert.equal(sidecar.images.length, 2);
  const collEntry = sidecar.images.find(i => i.filename === 'photo__bbbbbbbb.jpg');
  assert.ok(collEntry);
  // The renderer needs originalFileName so it can still show "photo.jpg"
  // (the operator-known upload name) next to the collision-renamed file.
  assert.equal(collEntry.originalFileName, 'photo.jpg');
});

test('Scenario 3: same job polled twice → second poll is an idempotent no-op', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/a', { body: Buffer.from('AAA') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const job = makeJob({
    artwork_files: [makeArtworkFile({ id: 'idem-1111-2222-3333-4444-555555555555', file_name: 'one.jpg', file_url: srv.url('/a') })],
  });

  const first = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(first.downloaded.length, 1);

  const second = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(second.downloaded.length, 0);
  assert.equal(second.failed.length,     0);
  assert.equal(second.skipped.length,    1);
  assert.equal(second.skipped[0].reason, 'already-known');
});

test('Scenario 4: new file added between polls → only the new id downloads', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/a', { body: Buffer.from('AAA') }],
    ['/b', { body: Buffer.from('BBB') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const fileA = makeArtworkFile({ id: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', file_name: 'a.jpg', file_url: srv.url('/a') });
  const fileB = makeArtworkFile({ id: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', file_name: 'b.jpg', file_url: srv.url('/b') });

  // First poll: only A is known.
  let job = makeJob({ artwork_files: [fileA] });
  const first = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(first.downloaded.length, 1);
  assert.equal(first.downloaded[0].id, fileA.id);

  // Second poll: A + B (B uploaded between polls).
  job = makeJob({ artwork_files: [fileA, fileB] });
  const second = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(second.downloaded.length, 1);
  assert.equal(second.downloaded[0].id, fileB.id);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0].id, fileA.id);

  const jobPath = jobPathOf(downloadDir, job);
  assert.equal(fssync.existsSync(path.join(jobPath, 'a.jpg')), true);
  assert.equal(fssync.existsSync(path.join(jobPath, 'b.jpg')), true);

  const { sidecar } = await sidecarManager.loadSidecar(`${job.order_number}_${job.id}`, jobPath);
  assert.equal(sidecar.s3ArtworkFileIdsKnown.length, 2);
  assert.ok(sidecar.s3ArtworkFileIdsKnown.includes(fileA.id));
  assert.ok(sidecar.s3ArtworkFileIdsKnown.includes(fileB.id));
});

test('Scenario 5: empty artwork_files[] → no-op, no folder created', async (t) => {
  const downloadDir = await makeTempDir();
  t.after(() => fs.rm(downloadDir, { recursive: true, force: true }));

  const job = makeJob({ artwork_source: 'pixfizz', artwork_files: [] });
  const result = await newDownloader().downloadJobArtwork(job, downloadDir);

  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length,    0);
  assert.equal(result.failed.length,     0);
  assert.equal(
    fssync.existsSync(jobPathOf(downloadDir, job)),
    false,
    'no job folder should be created when artwork_files is empty',
  );
});

test('Scenario 6: Pixfizz job with FTP files on disk + manual replacement → only manual downloads; FTP untouched', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/manual', { body: Buffer.from('MANUAL-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  // Mixed-source: job-level pixfizz, one manual replacement file in artwork_files[].
  const job = makeJob({
    artwork_source: 'pixfizz',
    artwork_files: [makeArtworkFile({
      id: 'mixrepl-aaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      file_name: 'replacement.jpg', file_url: srv.url('/manual'),
      artwork_type: 'optimized', source: 'manual', production_ready: true,
    })],
  });

  // Simulate the parallel FTP path having already landed two files in the
  // job folder before the S3 downloader runs.
  const jobPath = jobPathOf(downloadDir, job);
  await fs.mkdir(jobPath, { recursive: true });
  const ftpA = Buffer.from('FTP-A-DO-NOT-TOUCH');
  const ftpB = Buffer.from('FTP-B-DO-NOT-TOUCH');
  await fs.writeFile(path.join(jobPath, 'ftp-pages1.jpg'), ftpA);
  await fs.writeFile(path.join(jobPath, 'ftp-pages2.jpg'), ftpB);

  const result = await newDownloader().downloadJobArtwork(job, downloadDir);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.downloaded[0].diskName, 'replacement.jpg');
  assert.equal(result.downloaded[0].source,   'manual');

  // FTP files present + byte-identical (untouched).
  assert.deepEqual(await fs.readFile(path.join(jobPath, 'ftp-pages1.jpg')), ftpA);
  assert.deepEqual(await fs.readFile(path.join(jobPath, 'ftp-pages2.jpg')), ftpB);
  // Manual file present.
  assert.equal(
    await fs.readFile(path.join(jobPath, 'replacement.jpg'), 'utf8'),
    'MANUAL-BYTES',
  );
});

test('Scenario 7a: network failure → no final file, no lingering .tmp, sidecar id not recorded', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/bad', { status: 500, body: Buffer.from('upstream error') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [makeArtworkFile({ id: 'fail-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', file_name: 'will-fail.jpg', file_url: srv.url('/bad') })],
  });

  const result = await newDownloader().downloadJobArtwork(job, downloadDir);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.failed.length,     1);
  assert.match(result.failed[0].error, /HTTP 500/);

  const jobPath = jobPathOf(downloadDir, job);
  assert.equal(fssync.existsSync(path.join(jobPath, 'will-fail.jpg')),     false, 'final file should not exist');
  assert.equal(fssync.existsSync(path.join(jobPath, 'will-fail.jpg.tmp')), false, '.tmp should be cleaned');

  // Tightened 2026-05-24: the job folder MUST be completely empty after a
  // failed-only poll — including no sidecar. checkLocalFiles._countFiles
  // counts every file recursively, so even an empty sidecar would trip
  // `markReceived` despite zero artwork landing (POS-5MAMUF-1 regression).
  const entries = await fs.readdir(jobPath);
  assert.equal(entries.length, 0,
    `job folder must be empty after a failed-only poll; got: ${entries.join(', ')}`);
});

test('Scenario 7b: next poll after failure → orphan .tmp swept, retry succeeds', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/retry', { body: Buffer.from('RECOVERED-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [makeArtworkFile({
      id: 'retr-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      file_name: 'will-retry.jpg', file_url: srv.url('/retry'),
    })],
  });

  // Simulate a previous failed attempt: orphan .tmp lingering, no final.
  const jobPath = jobPathOf(downloadDir, job);
  await fs.mkdir(jobPath, { recursive: true });
  await fs.writeFile(path.join(jobPath, 'will-retry.jpg.tmp'), 'STALE-PARTIAL');

  const result = await newDownloader().downloadJobArtwork(job, downloadDir);
  assert.equal(result.downloaded.length, 1);
  assert.equal(fssync.existsSync(path.join(jobPath, 'will-retry.jpg.tmp')), false, 'orphan .tmp swept');
  assert.equal(
    await fs.readFile(path.join(jobPath, 'will-retry.jpg'), 'utf8'),
    'RECOVERED-BYTES',
  );

  const { sidecar } = await sidecarManager.loadSidecar(`${job.order_number}_${job.id}`, jobPath);
  assert.equal(sidecar.s3ArtworkFileIdsKnown[0], 'retr-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

// ── Path + sidecar contract regressions (M1 fix 2026-05-24, POS-5MAMUF-1) ───

test('Path contract: downloader writes at the same path checkLocalFiles would scan', async (t) => {
  // Locks the byte-identical agreement between the two services. The
  // downloader and job-download-service.checkLocalFiles must use the same
  // ${order_number}_${order_id}/${order_number}_${id} formula; if they
  // ever drift, markReceived will never fire on S3-delivered artwork.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/x', { body: Buffer.from('FILE-X') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    order_number: 'POS-PATHX',
    order_id: '05e7b8f1-83d2-42a0-b812-4854e60009ab',
    id: '4cc1e55d-8857-405d-9bc6-b78b7cec99aa',
    artwork_files: [makeArtworkFile({
      id: 'pthx-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      file_name: 'x.jpg', file_url: srv.url('/x'),
    })],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  // Independent recomputation of checkLocalFiles' formula
  // (job-download-service.js:38-40). Any drift between this and the
  // downloader's path construction would fail here.
  const checkLocalFilesPath = path.join(downloadDir,
    `${job.order_number}_${job.order_id}`,
    `${job.order_number}_${job.id}`);
  assert.equal(
    fssync.existsSync(path.join(checkLocalFilesPath, 'x.jpg')),
    true,
    'downloader and checkLocalFiles must agree on the job folder path',
  );
});

test('Diagnostic: 4xx response body captured + truncated; logged via WARN by id only', async (t) => {
  // S3 / Supabase return XML or JSON error envelopes on 4xx (AccessDenied,
  // RequestExpired, signature mismatches). Without an explicit body read
  // these are dropped on the floor — leaving us with just "HTTP 403" in
  // the log, no actionable detail. Capture: read the body upstream of
  // reject in _downloadToTmp; surface via WARN at the caller. Truncate
  // at ~500 bytes so a hostile or accidentally-huge body can't flood
  // the log.
  const downloadDir = await makeTempDir();
  // Build a body > 500 bytes so we can assert truncation.
  const tail = 'X'.repeat(1000);
  const errorXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Error><Code>AccessDenied</Code>' +
    '<Message>The request signature we calculated does not match the signature you provided.</Message>' +
    `<Detail>${tail}</Detail></Error>`;
  assert.ok(errorXml.length > 500, 'test body must exceed 500 to exercise truncation');
  const srv = await startTestServer(new Map([
    ['/forbidden', { status: 403, body: Buffer.from(errorXml) }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const warnCalls = [];
  const capturingLogger = {
    ...silentLogger,
    logWarning: (msg, meta) => warnCalls.push({ msg, meta }),
  };
  const downloader = createS3ArtworkDownloader({ logger: capturingLogger });

  const job = makeJob({
    artwork_files: [makeArtworkFile({
      id: 'bdy-1111-2222-3333-4444-555555555555',
      file_name: 'denied.jpg', file_url: srv.url('/forbidden'),
    })],
  });

  const result = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /HTTP 403/);

  const bodyWarn = warnCalls.find((c) => c.msg && c.msg.includes('4xx response body'));
  assert.ok(bodyWarn,
    `expected a "4xx response body" WARN; got: ${warnCalls.map(c => c.msg).join(', ') || '(none)'}`);
  assert.equal(bodyWarn.meta.jobId,      job.id);
  assert.equal(bodyWarn.meta.fileId,     'bdy-1111-2222-3333-4444-555555555555');
  assert.equal(bodyWarn.meta.statusCode, 403);
  assert.match(bodyWarn.meta.bodyPreview, /AccessDenied/);
  assert.ok(bodyWarn.meta.bodyPreview.length <= 500,
    `expected bodyPreview ≤ 500 chars; got ${bodyWarn.meta.bodyPreview.length}`);

  // No URL anywhere in the meta — log by id, never URL.
  const serialised = JSON.stringify(bodyWarn);
  assert.equal(serialised.includes('http://'),    false, 'URL must not appear in log meta');
  assert.equal(serialised.includes('/forbidden'), false, 'URL path must not appear in log meta');
});

test('Sidecar contract: exactly one sidecar JSON, named `${order_number}_${id}.json`', async (t) => {
  // POS-5MAMUF-1 produced TWO sidecars because the downloader's first pass
  // used `job.id` (bare UUID) while every other consumer keys on
  // `{order_number}_{job_id}`. Locks the convention.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/y', { body: Buffer.from('FILE-Y') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    order_number: 'POS-NAMEY',
    artwork_files: [makeArtworkFile({
      id: 'namy-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      file_name: 'y.jpg', file_url: srv.url('/y'),
    })],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const jobPath = jobPathOf(downloadDir, job);
  const entries = await fs.readdir(jobPath);
  const jsons = entries.filter((n) => n.endsWith('.json'));
  assert.equal(jsons.length, 1, `expected exactly one sidecar JSON; got: ${jsons.join(', ')}`);
  assert.equal(
    jsons[0],
    `${job.order_number}_${job.id}.json`,
    'sidecar must be named per the codebase convention',
  );
  // And it must NOT be named after just the bare id (the M1 regression).
  assert.equal(fssync.existsSync(path.join(jobPath, `${job.id}.json`)), false,
    'no bare-id sidecar should be left behind');
});

// ── Order-level manifest contract (M2 fix 2026-05-24, POS-ZU4LWD / POS-FUN9N5) ──

/**
 * Byte-shape reference, copied verbatim from a real FTP-delivered manifest
 * (`PXDEMO-VRGAMF.json` in production). The print-service dispatch pipeline
 * (`_readManifest` / `_findJobInManifest` in `print-service.js`) reads
 * manifests of this shape, so the M1 downloader's output must match it.
 * Values are illustrative — the byte-shape parity test asserts KEY
 * structure, not values.
 */
const FTP_MANIFEST_FIXTURE = {
  orderId: '6a105ceaa18ecd78',
  orderNumber: 'PXDEMO-VRGAMF',
  jobs: [
    {
      jobId: '38439878',
      images: [
        {
          filename:         'PXDEMO-VRGAMF_38439878/PXDEMO-VRGAMF_38439878_IMG-20240809-WA0003.jpg_Q1_pages1.jpeg',
          originalFilename: 'PXDEMO-VRGAMF_38439878/original-files/1-IMG-20240809-WA0003.jpg',
          size:             '8x8',
          quantity:         1,
        },
      ],
    },
  ],
};

function manifestPathOf(downloadDir, job) {
  return path.join(downloadDir, `${job.order_number}_${job.order_id}`, `${job.order_number}.json`);
}

test('Manifest: created on first download with the expected shape', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/m1', { body: Buffer.from('FIRST-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    quantity: 4,
    artwork_files: [makeArtworkFile({
      id: 'manif-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      file_name: 'm1.jpg', file_url: srv.url('/m1'),
    })],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const mPath = manifestPathOf(downloadDir, job);
  assert.equal(fssync.existsSync(mPath), true, 'order manifest must exist after first download');

  const manifest = JSON.parse(await fs.readFile(mPath, 'utf8'));
  assert.equal(manifest.orderId,     job.order_id);
  assert.equal(manifest.orderNumber, job.order_number);
  assert.equal(manifest.jobs.length, 1);

  const entry = manifest.jobs[0];
  assert.equal(entry.jobId, job.id);
  assert.equal(entry.images.length, 1);
  // `filename` is order-folder-relative: `{jobFolderName}/{diskName}`.
  assert.equal(entry.images[0].filename, `${job.order_number}_${job.id}/m1.jpg`);
  assert.equal(entry.images[0].originalFilename, null);
  // Intentionally null today — see _upsertOrderManifest header comment.
  assert.equal(entry.images[0].size, null);
  // M3 qty fix (2026-05-25): manifest quantity is sidecar's qtyOriginal,
  // which now equals file.copies (default 1) — NOT job.quantity.
  assert.equal(entry.images[0].quantity, 1);
});

test('Manifest: re-poll is idempotent — content byte-identical second time', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/idem', { body: Buffer.from('IDEM-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const job = makeJob({
    artwork_files: [makeArtworkFile({
      id: 'manif-idem-2222-3333-4444-555555555555',
      file_name: 'idem.jpg', file_url: srv.url('/idem'),
    })],
  });

  await downloader.downloadJobArtwork(job, downloadDir);
  const first = await fs.readFile(manifestPathOf(downloadDir, job), 'utf8');

  await downloader.downloadJobArtwork(job, downloadDir);
  const second = await fs.readFile(manifestPathOf(downloadDir, job), 'utf8');

  assert.equal(second, first, 'manifest content must be bytewise identical after a no-op re-poll');
});

test('Manifest: multi-job merge — two jobs of the same order share one manifest', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/a', { body: Buffer.from('A-BYTES') }],
    ['/b', { body: Buffer.from('B-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();

  // Two distinct jobs sharing the same order_number + order_id — what
  // multi-job manual orders look like in practice (e.g. POS-ZU4LWD with
  // 920dc5a9-… and f29d7391-… inside).
  const baseOrder = { order_number: 'POS-MULTI', order_id: 'shared-order-uuid' };
  const jobA = makeJob({
    ...baseOrder,
    id: 'jobA-uuid',
    artwork_files: [makeArtworkFile({
      id: 'a-1111-2222-3333-4444-555555555555',
      file_name: 'a.jpg', file_url: srv.url('/a'),
    })],
  });
  const jobB = makeJob({
    ...baseOrder,
    id: 'jobB-uuid',
    artwork_files: [makeArtworkFile({
      id: 'b-1111-2222-3333-4444-555555555555',
      file_name: 'b.jpg', file_url: srv.url('/b'),
    })],
  });

  await downloader.downloadJobArtwork(jobA, downloadDir);
  await downloader.downloadJobArtwork(jobB, downloadDir);

  const manifestPath = path.join(
    downloadDir,
    `${baseOrder.order_number}_${baseOrder.order_id}`,
    `${baseOrder.order_number}.json`,
  );
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  assert.equal(manifest.jobs.length, 2,
    'manifest must contain both job entries after sequential per-job downloads');
  const jobIds = manifest.jobs.map(j => j.jobId).sort();
  assert.deepEqual(jobIds, ['jobA-uuid', 'jobB-uuid']);
  // Sanity: each job's images point to its own job folder, not the other's.
  const entryA = manifest.jobs.find(j => j.jobId === 'jobA-uuid');
  const entryB = manifest.jobs.find(j => j.jobId === 'jobB-uuid');
  assert.equal(entryA.images[0].filename, `${baseOrder.order_number}_jobA-uuid/a.jpg`);
  assert.equal(entryB.images[0].filename, `${baseOrder.order_number}_jobB-uuid/b.jpg`);
});

test('Manifest: existing FTP-shape entry is preserved, not overwritten (Fix 2)', async (t) => {
  // The PXDEMO-AUXZWJ-1 regression scenario. A Pixfizz job whose
  // /pending-jobs response includes `artwork_files[]` (e.g. book
  // thumbnails or a manual-replacement file) triggers the downloader.
  // Without this guard, `_upsertOrderManifest` would find the existing
  // FTP-delivered manifest's job entry — with `size: "4x6"` populated and
  // its full _pages*.jpeg image list — and wholesale-replace it with the
  // sidecar-derived reconstruction (size: null, image list scoped to
  // whatever the sidecar saw). Destroys dispatch.
  //
  // Heuristic: an entry with at least one non-null `size` is FTP-shape
  // and must be preserved. (Documented limitation: when OrderHub adds
  // print_size and our entries gain populated sizes, the heuristic
  // mis-classifies our own re-writes as FTP — switch to a `__writer`
  // marker or merge-by-image at that point.)
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/preserve', { body: Buffer.from('PRESERVE-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [makeArtworkFile({
      id: 'preserve-1111-2222-3333-4444-555555555555',
      file_name: 'preserve.jpg', file_url: srv.url('/preserve'),
    })],
  });

  // Pre-seed an FTP-shape manifest: same orderId/orderNumber, an entry
  // for the same jobId with size: "4x6" (FTP-shape marker) and a richer
  // image list than the downloader's sidecar would produce.
  const orderFolderPath = path.join(downloadDir, `${job.order_number}_${job.order_id}`);
  await fs.mkdir(orderFolderPath, { recursive: true });
  const ftpManifest = {
    orderId:     job.order_id,
    orderNumber: job.order_number,
    jobs: [{
      jobId: String(job.id),
      images: [
        {
          filename:         `${job.order_number}_${job.id}/pages1.jpeg`,
          originalFilename: `${job.order_number}_${job.id}/original-files/1.jpg`,
          size:             '4x6',
          quantity:         1,
        },
        {
          filename:         `${job.order_number}_${job.id}/pages2.jpeg`,
          originalFilename: `${job.order_number}_${job.id}/original-files/2.jpg`,
          size:             '4x6',
          quantity:         1,
        },
      ],
    }],
  };
  const seedPath = manifestPathOf(downloadDir, job);
  await fs.writeFile(seedPath, JSON.stringify(ftpManifest, null, 2), 'utf8');
  const beforeBytes = await fs.readFile(seedPath, 'utf8');

  // Now run the downloader — it'll download preserve.jpg into the job
  // folder and reach _upsertOrderManifest. The guard must detect the
  // FTP-shape entry and skip the write.
  await newDownloader().downloadJobArtwork(job, downloadDir);

  const afterBytes = await fs.readFile(seedPath, 'utf8');
  assert.equal(afterBytes, beforeBytes,
    'FTP-shape manifest entry (size populated) MUST be preserved verbatim — '
    + '_upsertOrderManifest must detect by-shape and skip the write entirely. '
    + 'Without this guard, the 4x6 sizes + 2-image list would be replaced with '
    + 'a single sidecar-derived entry with size: null.');
});


test('Manifest: OHD-written entry (all sizes null) is updated on file additions between polls (Fix 2)', async (t) => {
  // Counter-test to the FTP-preservation guard above. When the existing
  // manifest entry was written by us (all sizes null — the S3-channel
  // sentinel until OrderHub exposes print_size), it must NOT be locked.
  // File additions between polls have to reach the manifest, otherwise
  // multi-file manual jobs would be permanently stuck on whatever set of
  // files the first poll saw. This is Scenario 4 (new file added between
  // polls) parity, asserted at the manifest level rather than the
  // sidecar level.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/first',  { body: Buffer.from('FIRST-BYTES') }],
    ['/second', { body: Buffer.from('SECOND-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const baseJob = makeJob({
    artwork_files: [makeArtworkFile({
      id: 'add-1111-2222-3333-4444-555555555555',
      file_name: 'first.jpg', file_url: srv.url('/first'),
    })],
  });

  await downloader.downloadJobArtwork(baseJob, downloadDir);
  const m1 = JSON.parse(await fs.readFile(manifestPathOf(downloadDir, baseJob), 'utf8'));
  assert.equal(m1.jobs[0].images.length, 1, 'first poll: one image in manifest');
  // Sanity: confirm our heuristic precondition — all sizes are null on
  // OHD writes. If this ever flips, the FTP-preservation heuristic
  // breaks (see the comment block in _upsertOrderManifest).
  assert.equal(m1.jobs[0].images[0].size, null,
    'OHD-written entries must keep size: null — heuristic relies on this');

  // Operator adds a second manual file to the same job between polls.
  const job2 = makeJob({
    artwork_files: [
      makeArtworkFile({
        id: 'add-1111-2222-3333-4444-555555555555', // same id as before
        file_name: 'first.jpg', file_url: srv.url('/first'),
      }),
      makeArtworkFile({
        id: 'add-6666-7777-8888-9999-aaaaaaaaaaaa', // new
        file_name: 'second.jpg', file_url: srv.url('/second'),
      }),
    ],
  });

  await downloader.downloadJobArtwork(job2, downloadDir);
  const m2 = JSON.parse(await fs.readFile(manifestPathOf(downloadDir, job2), 'utf8'));

  assert.equal(m2.jobs[0].images.length, 2,
    'second poll with new file: manifest entry MUST update to include the new image — '
    + 'the FTP-preservation heuristic must not lock OHD-written entries (size all null).');
  const filenames = m2.jobs[0].images.map((i) => i.filename).sort();
  assert.deepEqual(filenames, [
    `${baseJob.order_number}_${baseJob.id}/first.jpg`,
    `${baseJob.order_number}_${baseJob.id}/second.jpg`,
  ]);
});


// ── Source-based filter (2026-05-24, third source-gating fix) ─────────────

test('Source filter: Pixfizz-source artwork_files entry is skipped (book-thumbnails regression guard)', async (t) => {
  // PXDEMO-YUED5N-1 surfaced this as image 1 of 41 in the Job Review
  // queue and inflated Total Prints from 40 to 80: the API returns a
  // `book-56931977-thumbnails` entry in `artwork_files[]` with
  // `source: "pixfizz"`, `artwork_type: "pages"`, served from
  // `/v1/pages/…?height=400` — reference material, not printable
  // artwork. Real Pixfizz page artwork ships via FTP. The downloader
  // must skip the file entirely: no download, no sidecar entry, no
  // manifest row. (Existing affected sidecars don't auto-clean — see
  // CHANGELOG; this guard is for FRESH downloads only.)
  //
  // CONTRACT: file.source !== 'manual' → skipped with
  // reason 'non-manual-source' BEFORE the knownIds / on-disk-already
  // checks. Failure of this test means the source filter regressed
  // and Pixfizz reference files would be downloaded again.
  const downloadDir = await makeTempDir();
  // Server URL provided but the request must never actually fire.
  // If it does, that's a test failure too — we'd see a downloaded
  // entry in the result.
  const srv = await startTestServer(new Map([
    ['/should-not-fetch', { body: Buffer.from('SHOULD-NOT-FETCH') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_source: 'pixfizz',
    artwork_files: [makeArtworkFile({
      id: 'pixfizz-book-thumb-1111-2222-3333-444444444444',
      file_name: 'book-56931977-thumbnails',
      file_url: srv.url('/should-not-fetch'),
      artwork_type: 'pages',
      source: 'pixfizz',
      production_ready: false,
      copies: 1,
    })],
  });

  const result = await newDownloader().downloadJobArtwork(job, downloadDir);

  assert.equal(result.downloaded.length, 0,
    'Pixfizz-source file must NOT be downloaded — would fetch the book-thumbnails preview and inflate qty math');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'non-manual-source',
    'skip reason must be "non-manual-source" so log audits can grep cleanly');

  // No file on disk.
  const diskPath = path.join(jobPathOf(downloadDir, job), 'book-56931977-thumbnails');
  assert.equal(fssync.existsSync(diskPath), false, 'no file written to disk for skipped entry');

  // No sidecar entry created (sidecar may not exist at all if this was
  // the only file; either way, the entry must not appear).
  const sidecarPath = path.join(jobPathOf(downloadDir, job), `${job.order_number}_${job.id}.json`);
  if (fssync.existsSync(sidecarPath)) {
    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    const hit = sidecar.images.find((i) => i.filename === 'book-56931977-thumbnails');
    assert.equal(hit, undefined, 'no sidecar entry must be created for a non-manual-source file');
  }
});

test('Source filter: downloader is a no-op when ALL artwork_files entries have source !== "manual" — no manifest written', async (t) => {
  // The all-Pixfizz photo-book case. A Pixfizz order's `artwork_files[]`
  // may contain only Pixfizz-source reference entries (book-thumbnails,
  // low-res previews) and zero manual replacements. The downloader must
  // be a complete no-op in that case: no files, no sidecar updates, AND
  // no order manifest written. Pixfizz orders already have an
  // FTP-delivered manifest at the order-folder root; OHD writing a
  // partial manifest on top would clobber it (Fix 2 / FTP-shape
  // preservation guards against the clobber, but not writing at all is
  // even cleaner — fewer cycles + zero risk).
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/never', { body: Buffer.from('NEVER') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_source: 'pixfizz',
    artwork_files: [
      makeArtworkFile({
        id: 'p1-1111-2222-3333-4444-555555555555',
        file_name: 'book-1-thumbnails', file_url: srv.url('/never'),
        artwork_type: 'pages', source: 'pixfizz', production_ready: false, copies: 1,
      }),
      makeArtworkFile({
        id: 'p2-1111-2222-3333-4444-555555555555',
        file_name: 'book-2-thumbnails', file_url: srv.url('/never'),
        artwork_type: 'text', source: 'pixfizz', production_ready: false, copies: 1,
      }),
    ],
  });

  const result = await newDownloader().downloadJobArtwork(job, downloadDir);

  assert.equal(result.downloaded.length, 0, 'no downloads on all-non-manual job');
  assert.equal(result.skipped.length, 2);
  for (const s of result.skipped) {
    assert.equal(s.reason, 'non-manual-source');
  }

  // CRITICAL: no order manifest written. Pixfizz photo books have an
  // FTP-delivered manifest at this path; OHD must not touch it on an
  // all-non-manual poll.
  const manifestPath = manifestPathOf(downloadDir, job);
  assert.equal(fssync.existsSync(manifestPath), false,
    'order manifest must not be written when zero files were materialised — Pixfizz orders own that manifest via FTP');
});


// ── M3 quantity math + no-migration guard ──────────────────────────────────
//
// M3 qty fix (2026-05-25): `qtyOriginal = file.copies` (default 1 when
// missing/zero/NaN). The original Lovable spec said
// `job.quantity × file.copies`; live testing against POS-539M6D
// (job.quantity=5; three files with copies 1+1+3 summing to 5) showed
// the spec was empirically wrong — multiplying inflated qtyOriginal 5×.
// `job.quantity` is informational only (the expected total — sum of
// copies should match it) and is NOT a multiplier.

test('M3 qty math: single file with copies=1 → qtyOriginal=1 (job.quantity is informational, not a multiplier)', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/q', { body: Buffer.from('Q-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  // job.quantity=3 is deliberately retained from the pre-fix test as a
  // regression sentinel: the new math MUST ignore it. If a future
  // refactor reintroduces multiplication, qtyOriginal would become 3
  // and this test would fail loudly.
  const job = makeJob({
    quantity: 3,
    artwork_files: [makeArtworkFile({
      id: 'q3-1111-2222-3333-4444-555555555555',
      file_name: 'q3.jpg', file_url: srv.url('/q'),
      copies: 1,
    })],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const sidecarPath = path.join(jobPathOf(downloadDir, job), `${job.order_number}_${job.id}.json`);
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  assert.equal(sidecar.images.length, 1);
  assert.equal(sidecar.images[0].qtyOriginal, 1, 'qtyOriginal = file.copies (1) — job.quantity is NOT a multiplier');
  assert.equal(sidecar.images[0].qtyCurrent,  1, 'qtyCurrent mirrors qtyOriginal on first import');
  assert.equal(sidecar.images[0].copies,       1, 'copies persisted verbatim from the API');
});

test('M3 qty math: two files copies=1 and copies=2 → qtyOriginal 1 and 2 (live POS-539M6D-style shape)', async (t) => {
  // Live evidence: POS-539M6D (job.quantity=5; three files with copies
  // 1+1+3 summing to 5). The customer ordered 5 total prints (1 of A +
  // 1 of B + 3 of C); pre-fix math computed 25. This test pins the
  // corrected shape on the simpler two-file equivalent: qtyOriginal
  // per file equals file.copies verbatim, the sum equals job.quantity
  // (loose contract — not asserted, but holds for well-formed orders).
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/a', { body: Buffer.from('A-BYTES') }],
    ['/b', { body: Buffer.from('B-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    // Sum-of-copies = 3; job.quantity=3 to make the loose contract
    // (sum of copies should equal quantity) hold. Pre-fix this would
    // have computed 3 × 1 = 3 and 3 × 2 = 6 (total 9 prints for an
    // order of 3 prints).
    quantity: 3,
    artwork_files: [
      makeArtworkFile({
        id: 'q-a-1111-2222-3333-4444-555555555555',
        file_name: 'a.jpg', file_url: srv.url('/a'),
        copies: 1,
      }),
      makeArtworkFile({
        id: 'q-b-6666-7777-8888-9999-aaaaaaaaaaaa',
        file_name: 'b.jpg', file_url: srv.url('/b'),
        copies: 2,
      }),
    ],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const sidecarPath = path.join(jobPathOf(downloadDir, job), `${job.order_number}_${job.id}.json`);
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  const byName = new Map(sidecar.images.map((e) => [e.filename, e]));
  assert.equal(byName.get('a.jpg').qtyOriginal, 1, 'a.jpg: qtyOriginal = file.copies (1) — NOT job.quantity × copies');
  assert.equal(byName.get('a.jpg').copies,       1);
  assert.equal(byName.get('b.jpg').qtyOriginal, 2, 'b.jpg: qtyOriginal = file.copies (2) — NOT job.quantity × copies');
  assert.equal(byName.get('b.jpg').copies,       2);
});

test('M3 no-migration guard: existing sidecar entry is NEVER recomputed on re-poll, even if file.copies changes (contract lock)', async (t) => {
  // LOAD-BEARING CONTRACT TEST. This protects the existing on-disk
  // sidecars for POS-EFZ9UK, PXDEMO-AUXZWJ, and every other job
  // downloaded before M3 from being silently rewritten with the new
  // quantity math. The downloader's diff against `s3ArtworkFileIdsKnown`
  // must skip known ids BEFORE _buildImageEntry is called; the entry's
  // qtyOriginal must be preserved verbatim regardless of what the API
  // now reports for `copies`.
  //
  // If this test fails, a future refactor has broken the diff guard.
  // The message should make it obvious what regressed.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/legacy', { body: Buffer.from('LEGACY-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const fileId = 'leg-1111-2222-3333-4444-555555555555';

  // First poll: job.quantity=2, copies=1 → qtyOriginal=2.
  const firstJob = makeJob({
    quantity: 2,
    artwork_files: [makeArtworkFile({
      id: fileId, file_name: 'legacy.jpg', file_url: srv.url('/legacy'),
      copies: 1,
    })],
  });
  await downloader.downloadJobArtwork(firstJob, downloadDir);

  const sidecarPath = path.join(jobPathOf(downloadDir, firstJob), `${firstJob.order_number}_${firstJob.id}.json`);

  // Mutate the on-disk entry to a unique sentinel value. This represents
  // a "legacy" sidecar — could equally be a pre-M3 entry that was
  // written when qty=job.quantity (no copies multiplication). Any future
  // recompute would overwrite this and the assertion would fail.
  const beforeSidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  beforeSidecar.images[0].qtyOriginal = 999;
  beforeSidecar.images[0].qtyCurrent  = 999;
  // Also strip the `copies` field so we can assert it stays stripped
  // (a recompute would re-add it from the API's new value).
  delete beforeSidecar.images[0].copies;
  await fs.writeFile(sidecarPath, JSON.stringify(beforeSidecar, null, 2), 'utf8');

  // Second poll: SAME file id (so the diff hits the skip path), but the
  // API now reports copies=4. If anything recomputes, qtyOriginal would
  // become 2 × 4 = 8 and `copies` would re-appear. Neither must happen.
  const secondJob = makeJob({
    quantity: 2,
    artwork_files: [makeArtworkFile({
      id: fileId, file_name: 'legacy.jpg', file_url: srv.url('/legacy'),
      copies: 4,
    })],
  });
  const result = await downloader.downloadJobArtwork(secondJob, downloadDir);

  // Sanity: the file id must have been recognised and skipped, not
  // re-downloaded. If this fails, the diff is broken upstream of the
  // no-migration guarantee.
  assert.equal(result.downloaded.length, 0,
    'existing file id must not be re-downloaded on re-poll (diff against s3ArtworkFileIdsKnown is the gate)');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'already-known');

  // The load-bearing assertion: existing entry's qtyOriginal is the
  // sentinel 999, NOT the freshly-computed 8.
  const after = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  assert.equal(after.images[0].qtyOriginal, 999,
    'existing entry recomputed despite known id in s3ArtworkFileIdsKnown — '
    + 'M3 must NEVER migrate qty on existing entries. The downloader\'s diff '
    + 'guards POS-EFZ9UK / PXDEMO-AUXZWJ / every pre-M3 entry from silent '
    + 'rewrite; this test failing means that contract is broken.');
  assert.equal(after.images[0].qtyCurrent, 999,
    'qtyCurrent must also be preserved on re-poll skip — operator-mutable field');
  assert.equal(Object.prototype.hasOwnProperty.call(after.images[0], 'copies'), false,
    'stripped `copies` field must stay absent on disk — re-poll must not re-introduce it from the API');
});


// ── M4 (2026-05-25): artwork_type 'original' → Customer Originals plumbing ──
//
// M4 adds two behaviours that downstream UI (Customer Originals Phase 1+2)
// reads for free:
//   1. `artwork_type === 'original'` files land in `{jobPath}/original-files/`
//      instead of the flat job folder. They are NOT recorded in
//      `sidecar.images[]` (no entry, no manifest row) — Customer Originals
//      references them only via the lowercase-N `originalFilename` on a
//      sibling printable JPEG entry.
//   2. Conservative single-sibling back-fill: when a non-original sibling
//      exists in the same job whose API `originalFileName` (capital F-N)
//      matches the original's `file_name`, the sibling's lowercase-N
//      `originalFilename` is set to `{jobFolderName}/original-files/<diskName>`.
//      Zero matches or 2+ candidates → silent degrade (Customer Originals UI
//      simply doesn't activate for that entry).

test('M4: original lands in original-files/, not the flat job folder', async (t) => {
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/orig', { body: Buffer.from('ORIGINAL-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [makeArtworkFile({
      id: 'orig-1111-2222-3333-4444-555555555555',
      file_name: 'IMG_lone.jpg', file_url: srv.url('/orig'),
      artwork_type: 'original', source: 'manual',
    })],
  });

  const result = await newDownloader().downloadJobArtwork(job, downloadDir);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.downloaded[0].artworkType, 'original');

  const jobPath = jobPathOf(downloadDir, job);
  // File lives in original-files/, NOT the flat folder.
  assert.equal(fssync.existsSync(path.join(jobPath, 'original-files', 'IMG_lone.jpg')), true,
    'original must land under original-files/ subfolder');
  assert.equal(fssync.existsSync(path.join(jobPath, 'IMG_lone.jpg')), false,
    'original must NOT land flat in the job folder');
  assert.equal(await fs.readFile(path.join(jobPath, 'original-files', 'IMG_lone.jpg'), 'utf8'),
    'ORIGINAL-BYTES');

  // No sidecar.images[] entry for the original — Customer Originals references
  // it only via a sibling's `originalFilename`. Id IS in s3ArtworkFileIdsKnown
  // so idempotency works on re-poll.
  const sidecar = JSON.parse(await fs.readFile(
    path.join(jobPath, `${job.order_number}_${job.id}.json`), 'utf8'));
  assert.deepEqual(sidecar.s3ArtworkFileIdsKnown, ['orig-1111-2222-3333-4444-555555555555'],
    'id must be tracked in s3ArtworkFileIdsKnown even though no images[] entry exists');
  assert.equal(sidecar.images.length, 0,
    'sidecar.images must NOT contain an entry for the lone original — Customer Originals references via originalFilename only');
});

test('M4: optimized sibling gets originalFilename back-filled; manifest carries it through', async (t) => {
  // The happy path. Manual job with one original + one optimized sharing the
  // same API file_name. The optimized's lowercase-N originalFilename must be
  // back-filled to the manifest-relative original-files/ path. The order
  // manifest's _upsertOrderManifest must surface that field so the next
  // Job Review load lights up Customer Originals UI for the sibling.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/orig', { body: Buffer.from('ORIG-RAW') }],
    ['/opt',  { body: Buffer.from('OPT-CROPPED') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [
      makeArtworkFile({
        id: 'org-1111-2222-3333-4444-555555555555',
        file_name: 'IMG_pair.jpg', file_url: srv.url('/orig'),
        artwork_type: 'original',  source: 'manual',
      }),
      makeArtworkFile({
        id: 'opt-6666-7777-8888-9999-aaaaaaaaaaaa',
        file_name: 'IMG_pair.jpg', file_url: srv.url('/opt'),
        artwork_type: 'optimized', source: 'manual',
      }),
    ],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const jobPath = jobPathOf(downloadDir, job);
  // Original in original-files/, optimized in flat folder.
  assert.equal(fssync.existsSync(path.join(jobPath, 'original-files', 'IMG_pair.jpg')), true);
  assert.equal(fssync.existsSync(path.join(jobPath, 'IMG_pair.jpg')), true);
  // The optimized must NOT have been collision-renamed despite sharing
  // file_name with the original — they live in different folders.
  const flatEntries = (await fs.readdir(jobPath)).filter((n) => n.endsWith('.jpg'));
  assert.deepEqual(flatEntries, ['IMG_pair.jpg'],
    'optimized must keep its file_name verbatim — original lives in a different folder, no collision');

  // Sidecar: one images[] entry (the optimized) with back-filled originalFilename.
  const sidecar = JSON.parse(await fs.readFile(
    path.join(jobPath, `${job.order_number}_${job.id}.json`), 'utf8'));
  assert.equal(sidecar.images.length, 1, 'only the optimized produces an images[] entry');
  const opt = sidecar.images[0];
  assert.equal(opt.filename,        'IMG_pair.jpg');
  assert.equal(opt.artworkType,     'optimized');
  assert.equal(opt.originalFileName, 'IMG_pair.jpg', 'capital-N preserved verbatim');
  assert.equal(
    opt.originalFilename,
    `${job.order_number}_${job.id}/original-files/IMG_pair.jpg`,
    'lowercase-n originalFilename must be back-filled to the manifest-relative original-files/ path',
  );

  // Both ids tracked.
  assert.equal(sidecar.s3ArtworkFileIdsKnown.length, 2);
  assert.ok(sidecar.s3ArtworkFileIdsKnown.includes('org-1111-2222-3333-4444-555555555555'));
  assert.ok(sidecar.s3ArtworkFileIdsKnown.includes('opt-6666-7777-8888-9999-aaaaaaaaaaaa'));

  // Order manifest: the optimized's originalFilename must be propagated
  // so the next Job Review load can hand it to Customer Originals.
  const manifest = JSON.parse(await fs.readFile(manifestPathOf(downloadDir, job), 'utf8'));
  assert.equal(manifest.jobs.length, 1);
  assert.equal(manifest.jobs[0].images.length, 1,
    'original is NOT a manifest row — only printable JPEGs appear in images[]');
  assert.equal(
    manifest.jobs[0].images[0].originalFilename,
    `${job.order_number}_${job.id}/original-files/IMG_pair.jpg`,
    'order manifest must surface originalFilename so _buildManifestImageMetaMap can back-fill on next load',
  );
});

test('M4: lone original with no sibling — file lands, no back-fill, no images[] row', async (t) => {
  // Brief acceptance: "Manual job with only an `original` (no optimized
  // counterpart): original lands in `original-files/`, no sidecar back-fill
  // happens, Customer Originals UI does not light up for that file
  // (expected silent degrade)."
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/lone', { body: Buffer.from('LONE-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [makeArtworkFile({
      id: 'lone-1111-2222-3333-4444-555555555555',
      file_name: 'lone.jpg', file_url: srv.url('/lone'),
      artwork_type: 'original', source: 'manual',
    })],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const jobPath = jobPathOf(downloadDir, job);
  assert.equal(fssync.existsSync(path.join(jobPath, 'original-files', 'lone.jpg')), true);

  const sidecarPath = path.join(jobPath, `${job.order_number}_${job.id}.json`);
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  assert.equal(sidecar.images.length, 0, 'no sibling → no images[] entry created');
  // Id still tracked so idempotent re-poll works.
  assert.deepEqual(sidecar.s3ArtworkFileIdsKnown, ['lone-1111-2222-3333-4444-555555555555']);

  // No order manifest written either — _upsertOrderManifest is gated on
  // sidecar.images.length > 0 (a row-less manifest entry would mislead
  // the dispatch pipeline into a no-op "successful" print).
  assert.equal(fssync.existsSync(manifestPathOf(downloadDir, job)), false,
    'no order manifest written when no printable JPEGs were materialised');
});

test('M4: ambiguous siblings (two non-original entries share file_name) — silent degrade, no back-fill', async (t) => {
  // Two optimized files in this poll share `IMG_clash.jpg` (so one is
  // collision-renamed in the flat folder). Both have originalFileName ===
  // 'IMG_clash.jpg'. When the original 'IMG_clash.jpg' lands, the
  // candidate filter finds TWO entries → conservative silent degrade,
  // no back-fill on either. Customer Originals UI stays dark for that
  // file but the originals file itself is preserved on disk so an
  // operator could still find it via Explorer.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/orig', { body: Buffer.from('ORIG-BYTES') }],
    ['/opt1', { body: Buffer.from('OPT1-BYTES') }],
    ['/opt2', { body: Buffer.from('OPT2-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [
      makeArtworkFile({
        id: 'org-aaaa-2222-3333-4444-555555555555',
        file_name: 'IMG_clash.jpg', file_url: srv.url('/orig'),
        artwork_type: 'original',  source: 'manual',
      }),
      makeArtworkFile({
        id: 'opt-bbbb-2222-3333-4444-555555555555',
        file_name: 'IMG_clash.jpg', file_url: srv.url('/opt1'),
        artwork_type: 'optimized', source: 'manual',
      }),
      makeArtworkFile({
        id: 'opt-cccc-2222-3333-4444-555555555555',
        file_name: 'IMG_clash.jpg', file_url: srv.url('/opt2'),
        artwork_type: 'optimized', source: 'manual',
      }),
    ],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const jobPath = jobPathOf(downloadDir, job);
  // Original still lands.
  assert.equal(fssync.existsSync(path.join(jobPath, 'original-files', 'IMG_clash.jpg')), true);

  const sidecar = JSON.parse(await fs.readFile(
    path.join(jobPath, `${job.order_number}_${job.id}.json`), 'utf8'));
  // Both optimized entries exist; neither was back-filled.
  assert.equal(sidecar.images.length, 2);
  for (const e of sidecar.images) {
    assert.equal(e.originalFilename, null,
      `ambiguous match → conservative silent degrade; ${e.filename} must keep originalFilename=null`);
  }
});

test('M4: idempotent re-poll — original not re-downloaded, sibling originalFilename not re-clobbered', async (t) => {
  // Two-poll sequence over the same job. First poll back-fills the
  // sibling. Second poll: both ids in s3ArtworkFileIdsKnown → both
  // skipped → no back-fill pass runs → the previously-set
  // originalFilename stays untouched (first-write-wins). Tests both the
  // download dedup and the back-fill no-clobber contract.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/orig', { body: Buffer.from('ORIG-BYTES') }],
    ['/opt',  { body: Buffer.from('OPT-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const downloader = newDownloader();
  const job = makeJob({
    artwork_files: [
      makeArtworkFile({
        id: 'org-idem-2222-3333-4444-555555555555',
        file_name: 'idem.jpg', file_url: srv.url('/orig'),
        artwork_type: 'original',  source: 'manual',
      }),
      makeArtworkFile({
        id: 'opt-idem-7777-8888-9999-aaaaaaaaaaaa',
        file_name: 'idem.jpg', file_url: srv.url('/opt'),
        artwork_type: 'optimized', source: 'manual',
      }),
    ],
  });

  const first = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(first.downloaded.length, 2);

  // Tamper-proof sentinel: hand-edit the back-filled originalFilename to a
  // sentinel value. A second poll must NOT overwrite it (first-write-wins).
  const sidecarPath = path.join(jobPathOf(downloadDir, job), `${job.order_number}_${job.id}.json`);
  const beforeSidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  beforeSidecar.images[0].originalFilename = 'SENTINEL-MUST-NOT-CHANGE';
  await fs.writeFile(sidecarPath, JSON.stringify(beforeSidecar, null, 2), 'utf8');

  const second = await downloader.downloadJobArtwork(job, downloadDir);
  assert.equal(second.downloaded.length, 0, 'second poll must download nothing');
  assert.equal(second.skipped.length,    2);
  for (const s of second.skipped) {
    assert.equal(s.reason, 'already-known');
  }

  const afterSidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  assert.equal(afterSidecar.images[0].originalFilename, 'SENTINEL-MUST-NOT-CHANGE',
    'sibling originalFilename must NOT be re-clobbered on idempotent re-poll — first-write-wins');
});

test('M4: self-heal — original on disk + id not in known set re-registers without re-download and runs back-fill', async (t) => {
  // Simulate a previous run where the original was renamed into place but
  // saveSidecar failed before recording the id (a process kill at the
  // wrong instant). Next poll must:
  //   - Mark the id known without hitting the network.
  //   - Run the back-fill pass for the existing-on-disk original so a
  //     sibling that DOES land this poll gets linked correctly.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    // Original endpoint MUST NOT be hit — its presence on disk is the
    // self-heal trigger. Optimized endpoint serves the sibling.
    ['/orig-must-not-fetch', { body: Buffer.from('SHOULD-NEVER-FETCH') }],
    ['/opt',                 { body: Buffer.from('OPT-NEW') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [
      makeArtworkFile({
        id: 'org-heal-2222-3333-4444-555555555555',
        file_name: 'heal.jpg', file_url: srv.url('/orig-must-not-fetch'),
        artwork_type: 'original',  source: 'manual',
      }),
      makeArtworkFile({
        id: 'opt-heal-7777-8888-9999-aaaaaaaaaaaa',
        file_name: 'heal.jpg', file_url: srv.url('/opt'),
        artwork_type: 'optimized', source: 'manual',
      }),
    ],
  });

  // Pre-seed: original-files/ already contains the original from a prior
  // failed-save run. No sidecar yet, so id is not in s3ArtworkFileIdsKnown.
  const jobPath = jobPathOf(downloadDir, job);
  await fs.mkdir(path.join(jobPath, 'original-files'), { recursive: true });
  await fs.writeFile(path.join(jobPath, 'original-files', 'heal.jpg'), 'PRE-EXISTING-ORIG');

  const result = await newDownloader().downloadJobArtwork(job, downloadDir);

  // Optimized was downloaded; original was self-healed (skipped).
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.downloaded[0].artworkType, 'optimized');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'on-disk-already');

  // Original on disk byte-identical — not re-downloaded.
  assert.equal(
    await fs.readFile(path.join(jobPath, 'original-files', 'heal.jpg'), 'utf8'),
    'PRE-EXISTING-ORIG',
    'self-heal must NOT overwrite the existing original-files/ file',
  );

  const sidecar = JSON.parse(await fs.readFile(
    path.join(jobPath, `${job.order_number}_${job.id}.json`), 'utf8'));
  assert.equal(sidecar.s3ArtworkFileIdsKnown.length, 2,
    'both ids registered — self-healed original + freshly-downloaded sibling');
  assert.equal(sidecar.images.length, 1, 'only the optimized produces an images[] entry');
  // CRITICAL: self-heal still triggers back-fill.
  assert.equal(
    sidecar.images[0].originalFilename,
    `${job.order_number}_${job.id}/original-files/heal.jpg`,
    'self-healed original must still trigger back-fill of the freshly-downloaded sibling',
  );
});

test('M4: non-original artwork_type (e.g. "manipulated", unknown) keeps landing flat — regression guard', async (t) => {
  // Per the brief: only the literal string `original` routes to the
  // subfolder. Unknown artwork_types must NOT be treated as originals.
  // We test both a recognised non-original type (manipulated) and an
  // unrecognised one (made-up). Both must land flat.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/m', { body: Buffer.from('MAN-BYTES') }],
    ['/u', { body: Buffer.from('UNK-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [
      makeArtworkFile({
        id: 'man-1111-2222-3333-4444-555555555555',
        file_name: 'man.jpg', file_url: srv.url('/m'),
        artwork_type: 'manipulated', source: 'manual',
      }),
      makeArtworkFile({
        id: 'unk-6666-7777-8888-9999-aaaaaaaaaaaa',
        file_name: 'unk.jpg', file_url: srv.url('/u'),
        artwork_type: 'made-up-type', source: 'manual',
      }),
    ],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const jobPath = jobPathOf(downloadDir, job);
  // Both flat, none in original-files/.
  assert.equal(fssync.existsSync(path.join(jobPath, 'man.jpg')), true);
  assert.equal(fssync.existsSync(path.join(jobPath, 'unk.jpg')), true);
  // original-files/ folder must not have been created — lazy mkdir is
  // gated on at least one artwork_type === 'original' file being present.
  assert.equal(fssync.existsSync(path.join(jobPath, 'original-files')), false,
    'original-files/ folder must NOT be created when no artwork_type === "original" files are present');

  // Both have images[] entries, neither has originalFilename (no original
  // was downloaded to link to).
  const sidecar = JSON.parse(await fs.readFile(
    path.join(jobPath, `${job.order_number}_${job.id}.json`), 'utf8'));
  assert.equal(sidecar.images.length, 2);
  for (const e of sidecar.images) {
    assert.equal(e.originalFilename, null,
      `${e.filename}: no original in the job → originalFilename must stay null`);
  }
});

test('M4: collision-renamed sibling — back-fill still matches via originalFileName, ignoring disk-name rename', async (t) => {
  // A subtle but load-bearing case for the capital-N vs lowercase-n
  // distinction. Two optimized files share `IMG_coll.jpg` AND an original
  // also named `IMG_coll.jpg` is present. One optimized lands flat as
  // `IMG_coll.jpg` (disk name); the other is collision-renamed to
  // `IMG_coll__<id8>.jpg`. The collision-renamed optimized's
  // originalFileName (capital-N) is still 'IMG_coll.jpg', but its
  // filename (lowercase) is the renamed form. The back-fill must use
  // originalFileName for matching, NOT filename — otherwise it'd see two
  // candidates with matching disk names (zero, actually — and miss the
  // back-fill entirely). Matching on originalFileName produces 2 → silent
  // degrade. This locks the casing contract.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/orig', { body: Buffer.from('ORIG') }],
    ['/o1',   { body: Buffer.from('O1') }],
    ['/o2',   { body: Buffer.from('O2') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [
      makeArtworkFile({
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        file_name: 'IMG_coll.jpg', file_url: srv.url('/o1'),
        artwork_type: 'optimized', source: 'manual',
      }),
      makeArtworkFile({
        id: 'bbbbbbbb-1111-2222-3333-444444444444',
        file_name: 'IMG_coll.jpg', file_url: srv.url('/o2'),
        artwork_type: 'optimized', source: 'manual',
      }),
      makeArtworkFile({
        id: 'cccccccc-1111-2222-3333-444444444444',
        file_name: 'IMG_coll.jpg', file_url: srv.url('/orig'),
        artwork_type: 'original',  source: 'manual',
      }),
    ],
  });

  await newDownloader().downloadJobArtwork(job, downloadDir);

  const jobPath = jobPathOf(downloadDir, job);
  // Flat folder: one verbatim, one collision-renamed (`__bbbbbbbb`).
  assert.equal(fssync.existsSync(path.join(jobPath, 'IMG_coll.jpg')), true);
  assert.equal(fssync.existsSync(path.join(jobPath, 'IMG_coll__bbbbbbbb.jpg')), true);
  // Original in subfolder, not collision-renamed (lives alone there).
  assert.equal(fssync.existsSync(path.join(jobPath, 'original-files', 'IMG_coll.jpg')), true);

  const sidecar = JSON.parse(await fs.readFile(
    path.join(jobPath, `${job.order_number}_${job.id}.json`), 'utf8'));
  // Both optimized entries: originalFileName (capital-N) preserved as
  // the API's file_name — distinct from the disk-name `filename`.
  const byFile = new Map(sidecar.images.map((e) => [e.filename, e]));
  assert.equal(byFile.get('IMG_coll.jpg').originalFileName,           'IMG_coll.jpg');
  assert.equal(byFile.get('IMG_coll__bbbbbbbb.jpg').originalFileName, 'IMG_coll.jpg',
    'collision-renamed entry must preserve the API file_name in originalFileName (capital-N)');
  // Both have two matching candidates → silent degrade, neither back-filled.
  for (const e of sidecar.images) {
    assert.equal(e.originalFilename, null,
      `${e.filename}: ambiguous candidate set → no back-fill`);
  }
});

test('Manifest: byte-shape parity vs FTP-delivered fixture', async (t) => {
  // Locks the M1 manifest's KEY shape against the FTP-delivered format
  // print-service.js already reads. A future code change that drifts the
  // shape (e.g. renames a field, adds an unexpected one) would fail this
  // test before it can surface as a "manifest unreadable" dispatch error.
  const downloadDir = await makeTempDir();
  const srv = await startTestServer(new Map([
    ['/p', { body: Buffer.from('PARITY-BYTES') }],
  ]));
  t.after(async () => { await srv.close(); await fs.rm(downloadDir, { recursive: true, force: true }); });

  const job = makeJob({
    artwork_files: [makeArtworkFile({
      id: 'pari-1111-2222-3333-4444-555555555555',
      file_name: 'p.jpg', file_url: srv.url('/p'),
    })],
  });
  await newDownloader().downloadJobArtwork(job, downloadDir);

  const manifest = JSON.parse(await fs.readFile(manifestPathOf(downloadDir, job), 'utf8'));

  assert.deepEqual(
    Object.keys(manifest).sort(),
    Object.keys(FTP_MANIFEST_FIXTURE).sort(),
    'top-level manifest keys must match FTP-delivered manifest exactly',
  );

  const expectedJobKeys   = Object.keys(FTP_MANIFEST_FIXTURE.jobs[0]).sort();
  const expectedImageKeys = Object.keys(FTP_MANIFEST_FIXTURE.jobs[0].images[0]).sort();
  for (const jobEntry of manifest.jobs) {
    assert.deepEqual(Object.keys(jobEntry).sort(), expectedJobKeys,
      'per-job-entry keys must match FTP-delivered manifest exactly');
    for (const img of jobEntry.images) {
      assert.deepEqual(Object.keys(img).sort(), expectedImageKeys,
        'per-image keys must match FTP-delivered manifest exactly');
    }
  }
});
