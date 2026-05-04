/**
 * Unit tests for the FTP service's integrity-check pipeline.
 *
 * Run via:
 *   npm test
 *
 * Two surfaces under test:
 *
 *   1. The narrow `INTEGRITY_CHECK_EXTENSIONS` filter — only .jpg/.jpeg/.png
 *      get the magic-byte check. Originally introduced after a regression
 *      where order-manifest JSONs starting with `{` (0x7B) were treated as
 *      bad-magic images and quarantined; that gate still applies under the
 *      v1.3.2 flag-and-allow model.
 *
 *   2. The `markIntegritySuspect()` helper that replaced the v1.3.0 quarantine
 *      flow. The new contract: keep the file's original extension, stamp the
 *      per-image sidecar's `integritySuspect` field, log at info level. Sidecar
 *      I/O failures are caught and swallowed so a corrupt download still
 *      proceeds downstream.
 *
 * ftp-service requires logger (electron-bound), so we stub it before requiring
 * ftp-service. sidecarManager + jobSchema are real (no electron deps) — the
 * markIntegritySuspect tests use real on-disk sidecars in a tmp directory.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC = path.join(REPO, 'src', 'main', 'services');

// ----- Logger stub: capture calls so tests can assert log output -----
const __logCalls = { info: [], warn: [], error: [] };
function resetLogCalls() {
  __logCalls.info.length = 0;
  __logCalls.warn.length = 0;
  __logCalls.error.length = 0;
}

function stubModule(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubModule(path.join(SVC, 'logger.js'), {
  info:       (msg, fields)      => __logCalls.info.push({ msg, fields }),
  logInfo:    (msg, fields)      => __logCalls.info.push({ msg, fields }),
  logWarning: (msg, fields)      => __logCalls.warn.push({ msg, fields }),
  logError:   (msg, err, fields) => __logCalls.error.push({ msg, err, fields }),
  warn:  () => {},
  error: () => {},
  logDebug: () => {},
});

const ftpService = require(path.join(SVC, 'ftp-service.js'));
const {
  _shouldIntegrityCheck,
  _INTEGRITY_CHECK_EXTENSIONS,
  _markIntegritySuspect,
} = ftpService;


// ─────────────────────────────────────────────────────────────────────────
// 1. Integrity-gate (extension filter) — unchanged from the v1.3.0 era.
//    Keeping these tests because the gate itself still applies: only image
//    extensions get the magic-byte check at all. The action taken on a bad
//    magic changed from "quarantine" to "flag in sidecar" (covered below).
// ─────────────────────────────────────────────────────────────────────────

test('integrity-gate exposes the narrow extension set (.jpg/.jpeg/.png only)', () => {
  assert.equal(typeof _shouldIntegrityCheck, 'function');
  assert.ok(_INTEGRITY_CHECK_EXTENSIONS instanceof Set);
  assert.deepEqual(
    [..._INTEGRITY_CHECK_EXTENSIONS].sort(),
    ['.jpeg', '.jpg', '.png'],
    'must be exactly .jpg/.jpeg/.png — narrower than the codebase-wide IMAGE_EXTENSIONS',
  );
});


test('integrity-gate: image extensions are checked', () => {
  assert.equal(_shouldIntegrityCheck('photo.jpg'), true);
  assert.equal(_shouldIntegrityCheck('photo.jpeg'), true);
  assert.equal(_shouldIntegrityCheck('photo.png'), true);
});


test('integrity-gate is case-insensitive (FTP servers may return uppercase)', () => {
  assert.equal(_shouldIntegrityCheck('PHOTO.JPG'), true);
  assert.equal(_shouldIntegrityCheck('Photo.JPEG'), true);
  assert.equal(_shouldIntegrityCheck('Photo.PNG'), true);
});


test('integrity-gate bypasses .json files (the bug that caught this originally)', () => {
  // PXDEMO-PT7HM2.json was the smoke-test false-positive — order-manifest JSONs
  // start with `{` (0x7B), trip the JPEG/PNG check, and got quarantined under
  // the old model. The narrow gate prevents that regression even after pivot.
  assert.equal(
    _shouldIntegrityCheck('PXDEMO-PT7HM2.json'),
    false,
    'order-manifest JSON must bypass the integrity check',
  );
  assert.equal(_shouldIntegrityCheck('manifest.JSON'), false);
});


test('integrity-gate bypasses .pdf files (downstream consumer surfaces corruption)', () => {
  assert.equal(_shouldIntegrityCheck('layout.pdf'), false);
  assert.equal(_shouldIntegrityCheck('layout.PDF'), false);
});


test('integrity-gate bypasses .tif/.tiff files (Pixfizz does not accept TIFF uploads)', () => {
  // The codebase-wide IMAGE_EXTENSIONS set keeps .tif/.tiff for compatibility
  // with other code paths, but the FTP integrity check should NOT fire on
  // TIFFs — checkImageMagic only knows JPEG and PNG, so a TIFF would trip
  // a false-positive integrity-suspect flag here.
  assert.equal(_shouldIntegrityCheck('scan.tif'), false);
  assert.equal(_shouldIntegrityCheck('scan.tiff'), false);
});


test('integrity-gate bypasses other miscellaneous non-image extensions', () => {
  assert.equal(_shouldIntegrityCheck('inventory.csv'), false);
  assert.equal(_shouldIntegrityCheck('readme.txt'), false);
  assert.equal(_shouldIntegrityCheck('archive.zip'), false);
  assert.equal(_shouldIntegrityCheck('noext'), false);
  assert.equal(_shouldIntegrityCheck('.hiddenfile'), false);
});


test('integrity-gate handles bare filename and full path equivalently (extname semantics)', () => {
  assert.equal(_shouldIntegrityCheck('/some/dir/photo.jpg'), true);
  assert.equal(_shouldIntegrityCheck('C:\\Users\\test\\manifest.json'), false);
});


// ─────────────────────────────────────────────────────────────────────────
// 2. markIntegritySuspect — the v1.3.2 flag-and-allow contract.
//    Replaces the old moveToQuarantine. Asserts: file is NOT renamed, the
//    per-image sidecar's integritySuspect block is populated, the
//    [integrity-check] log line is emitted, and sidecar I/O failures are
//    swallowed so the file still proceeds downstream.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Construct an OHD-shaped tmp folder: outer-order/inner-job/<filename>.
 * The inner-job folder name is the sidecar's jobId per the OHD layout
 * convention — markIntegritySuspect derives it via path.basename(dirname).
 */
function makeJobFolder(filename, bytes = Buffer.alloc(8)) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-ftp-'));
  const innerJobName = 'PXTEST-ABC_999';
  const innerJob = path.join(outer, innerJobName);
  fs.mkdirSync(innerJob);
  const filePath = path.join(innerJob, filename);
  fs.writeFileSync(filePath, bytes);
  return { outer, innerJob, innerJobName, filePath };
}


test('markIntegritySuspect: does NOT rename the file (no .quarantine sibling created)', async () => {
  resetLogCalls();
  const { filePath } = makeJobFolder('photo.jpg');
  const integrity = { valid: false, format: null, magicHex: '0000000000000000' };

  await _markIntegritySuspect(filePath, '/the-root/JOB/photo.jpg', integrity, 8);

  assert.equal(fs.existsSync(filePath), true, 'original .jpg path must still exist');
  assert.equal(fs.existsSync(filePath + '.quarantine'), false,
    'no .quarantine sibling — that was the v1.3.0 behavior we pivoted away from');
});


test('markIntegritySuspect: writes integritySuspect block to the per-image sidecar', async () => {
  resetLogCalls();
  const { innerJob, innerJobName, filePath } = makeJobFolder('photo.jpg');
  const integrity = { valid: false, format: null, magicHex: '3c21444f4354595045' };
  const remote = '/the-root/JOB/photo.jpg';

  await _markIntegritySuspect(filePath, remote, integrity, 8);

  const sidecarPath = path.join(innerJob, `${innerJobName}.json`);
  assert.equal(fs.existsSync(sidecarPath), true, 'sidecar JSON must be written');

  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  const entry = sidecar.images.find((i) => i.filename === 'photo.jpg');
  assert.ok(entry, 'image entry must exist in sidecar');
  assert.ok(entry.integritySuspect, 'integritySuspect block must be set');
  assert.equal(entry.integritySuspect.detected, true);
  assert.equal(entry.integritySuspect.firstBytesHex, '3c21444f4354595045');
  assert.equal(entry.integritySuspect.ftpRemotePath, remote);
  assert.match(entry.integritySuspect.detectedAt, /^\d{4}-\d{2}-\d{2}T/,
    'detectedAt must be an ISO 8601 timestamp');
  assert.match(entry.integritySuspect.expectedMagic, /JPEG.*PNG/,
    'expectedMagic must describe both supported formats');
});


test('markIntegritySuspect: emits [integrity-check] info log with diagnostic fields', async () => {
  resetLogCalls();
  const { filePath } = makeJobFolder('photo.jpg');
  const integrity = { valid: false, format: null, magicHex: 'aabbcc' };

  await _markIntegritySuspect(filePath, '/r/photo.jpg', integrity, 8);

  const hit = __logCalls.info.find((c) => c.msg.startsWith('[integrity-check]'));
  assert.ok(hit, '[integrity-check] info log must be emitted');
  assert.equal(hit.fields.filename, 'photo.jpg');
  assert.equal(hit.fields.firstBytesHex, 'aabbcc');
  assert.equal(hit.fields.ftpRemotePath, '/r/photo.jpg');
  assert.equal(hit.fields.reason, 'magic-byte-mismatch');
  assert.equal(hit.fields.expectedSize, 8);
});


test('markIntegritySuspect: read-error case (magicHex null) records reason=read-error', async () => {
  resetLogCalls();
  const { filePath } = makeJobFolder('photo.jpg');
  const integrity = { valid: false, format: null, magicHex: null, error: 'EACCES' };

  await _markIntegritySuspect(filePath, '/r/photo.jpg', integrity, 8);

  const hit = __logCalls.info.find((c) => c.msg.startsWith('[integrity-check]'));
  assert.ok(hit);
  assert.equal(hit.fields.reason, 'read-error');
  assert.equal(hit.fields.firstBytesHex, null);
});


test('markIntegritySuspect: preserves existing image entry fields when upserting', async () => {
  resetLogCalls();
  const { innerJob, innerJobName, filePath } = makeJobFolder('photo.jpg');

  // Pre-write a sidecar with an existing entry that has aiQuality + corrections
  // already populated (simulates the orchestrator having already scored, or the
  // operator having applied corrections, before the FTP layer flags this file).
  const sidecarPath = path.join(innerJob, `${innerJobName}.json`);
  const preExisting = {
    jobId: innerJobName,
    schemaVersion: 1,
    createdAt:  '2026-04-29T00:00:00.000Z',
    modifiedAt: '2026-04-29T00:00:00.000Z',
    reprintOf: null,
    images: [{
      filename:    'photo.jpg',
      qtyOriginal: 3,
      qtyCurrent:  3,
      corrections: { cyan: 5, magenta: 0, yellow: -2 },
      reprint:     false,
      reprintJobId: null,
      enhanced: false,
      enhancementSource: null,
      enhancedPath: null,
      enhancedAt: null,
      enhancementModel: null,
      integritySuspect: null,
      aiQuality: {
        scored: true, score: 85, passed: true, error: null,
        modelVersion: 'm1', inferenceMs: 5, scoredAt: '2026-04-29T00:00:00.000Z',
        thresholdAtScoreTime: 50, modeAtScoreTime: 'warn',
        fileSizeAtScoreTime: 8, fileMtimeAtScoreTime: 0,
        fixupHistory: [],
        operatorDecision: { kind: 'none', decidedAt: null, note: null },
      },
    }],
  };
  await fsp.writeFile(sidecarPath, JSON.stringify(preExisting), 'utf8');

  const integrity = { valid: false, format: null, magicHex: 'ff' };
  await _markIntegritySuspect(filePath, '/r/photo.jpg', integrity, 8);

  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  const entry = sidecar.images.find((i) => i.filename === 'photo.jpg');

  // integritySuspect now set
  assert.equal(entry.integritySuspect.detected, true);
  // Existing aiQuality data preserved
  assert.equal(entry.aiQuality.score, 85);
  assert.equal(entry.aiQuality.scored, true);
  // Existing operator-touched fields preserved
  assert.equal(entry.qtyOriginal, 3, 'qtyOriginal must not be touched');
  assert.equal(entry.qtyCurrent, 3, 'qtyCurrent must not be touched');
  assert.equal(entry.corrections.cyan, 5, 'corrections must not be touched');
  assert.equal(entry.corrections.yellow, -2);
});


test('markIntegritySuspect: sidecar I/O failure is swallowed — does not throw, info log still fires', async () => {
  resetLogCalls();
  // Construct a localPath whose parent folder doesn't exist — sidecarManager
  // will fail to write the fresh sidecar it builds when readFile ENOENTs.
  // The contract is "swallow + log" so the file still flows downstream.
  const fakePath = path.join(os.tmpdir(), `ohd-ftp-no-such-dir-${Date.now()}-${Math.random()}`, 'photo.jpg');
  const integrity = { valid: false, format: null, magicHex: 'ff' };

  // Must not throw.
  await _markIntegritySuspect(fakePath, '/r/photo.jpg', integrity, 8);

  const errLog = __logCalls.error.find((c) =>
    c.msg.includes('[integrity-check] Failed to update sidecar'));
  assert.ok(errLog, 'sidecar failure must be logged at error level');

  const infoHit = __logCalls.info.find((c) =>
    c.msg.startsWith('[integrity-check] Suspect file flagged'));
  assert.ok(infoHit, 'info log fires regardless of sidecar I/O outcome');
});
