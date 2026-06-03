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
const __logCalls = { info: [], warn: [], error: [], debug: [] };
function resetLogCalls() {
  __logCalls.info.length = 0;
  __logCalls.warn.length = 0;
  __logCalls.error.length = 0;
  __logCalls.debug.length = 0;
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
  logDebug:   (msg, fields)      => __logCalls.debug.push({ msg, fields }),
  warn:  () => {},
  error: () => {},
  debug: () => {},
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


// ─────────────────────────────────────────────────────────────────────────
// 3. Expected-550 demotion on customer-original deletes.
//
//    Pixfizz Core ships uploads to `…/original-files/…` where the lab FTP
//    user lacks DELE permission. We treat the resulting 550 as a successful
//    no-op (debug log, doesn't trip allFilesSucceeded). Any other 550 (or
//    any non-550 error) keeps its error-level log and the
//    allFilesSucceeded=false consequence.
// ─────────────────────────────────────────────────────────────────────────

const { _isExpected550OnOriginalFiles, _handleFtpDeleteFailure } = ftpService;

function ftpError(code, message) {
  const err = new Error(message || `${code} test error`);
  err.code = code;
  err.name = 'FTPError';
  return err;
}

// ---- Pure-helper matrix --------------------------------------------------

test('_isExpected550OnOriginalFiles: 550 on /original-files/ path → true', () => {
  const err = ftpError(550, '550 Delete operation failed.');
  assert.equal(
    _isExpected550OnOriginalFiles(err,
      '/the-root/PXDEMO-ZW80N5_6a06f3fea1b75f41/PXDEMO-ZW80N5_38432974/original-files/13-576629810013.jpg'),
    true,
  );
});

test('_isExpected550OnOriginalFiles: 550 on /original-files/ with mixed case → true (lenient regex)', () => {
  const err = ftpError(550, '550 nope');
  assert.equal(
    _isExpected550OnOriginalFiles(err, '/order/Original-Files/IMG.jpg'),
    true,
  );
});

test('_isExpected550OnOriginalFiles: 550 on /original-files/ with backslashes → true', () => {
  const err = ftpError(550);
  assert.equal(
    _isExpected550OnOriginalFiles(err, 'C:\\share\\order\\original-files\\IMG.jpg'),
    true,
  );
});

test('_isExpected550OnOriginalFiles: 550 with NO `.code` but message starts with 550 → true (defensive)', () => {
  const err = new Error('550 Delete operation failed.');
  // basic-ftp v5 always sets `.code`, but the fallback exists so a future
  // thrower (or a wrapped error) doesn't silently bypass the gate.
  assert.equal(
    _isExpected550OnOriginalFiles(err, '/order/original-files/x.jpg'),
    true,
  );
});

test('_isExpected550OnOriginalFiles: 550 on any other path → false (real perm issues still surface)', () => {
  const err = ftpError(550, '550 Delete operation failed.');
  assert.equal(_isExpected550OnOriginalFiles(err, '/the-root/order/IMG.jpg'),                 false);
  assert.equal(_isExpected550OnOriginalFiles(err, '/the-root/order/job/IMG.jpg'),             false);
  // Substring "original-files" without slashes either side must NOT trigger.
  assert.equal(_isExpected550OnOriginalFiles(err, '/the-root/order/my-original-files-IMG.jpg'), false);
});

test('_isExpected550OnOriginalFiles: non-550 codes are always false, even on /original-files/', () => {
  for (const code of [451, 500, 530, 553]) {
    const err = ftpError(code, `${code} something else`);
    assert.equal(
      _isExpected550OnOriginalFiles(err, '/order/original-files/IMG.jpg'),
      false,
      `code ${code} must NOT be demoted`,
    );
  }
});

test('_isExpected550OnOriginalFiles: bad inputs degrade to false (defensive)', () => {
  assert.equal(_isExpected550OnOriginalFiles(null,                  '/order/original-files/IMG.jpg'), false);
  assert.equal(_isExpected550OnOriginalFiles(undefined,             '/order/original-files/IMG.jpg'), false);
  assert.equal(_isExpected550OnOriginalFiles({},                    '/order/original-files/IMG.jpg'), false);
  assert.equal(_isExpected550OnOriginalFiles(ftpError(550),         null),                            false);
  assert.equal(_isExpected550OnOriginalFiles(ftpError(550),         ''),                              false);
  assert.equal(_isExpected550OnOriginalFiles(ftpError(550),         42),                              false);
});

// ---- Behaviour contract: log channel + allFilesSucceeded consequence ----

test('_handleFtpDeleteFailure: expected 550 → debug log only, returns {expected:true}', () => {
  resetLogCalls();
  const err = ftpError(550, '550 Delete operation failed.');
  const result = _handleFtpDeleteFailure(err,
    '/the-root/PXDEMO-ZW80N5_6a06f3fea1b75f41/PXDEMO-ZW80N5_38432974/original-files/13.jpg');
  assert.deepEqual(result, { expected: true });
  assert.equal(__logCalls.debug.length, 1, 'exactly one debug entry');
  assert.match(__logCalls.debug[0].msg, /original-files/);
  assert.equal(__logCalls.error.length, 0,
    'expected-550 on /original-files/ must NOT produce an error-level entry');
});

test('_handleFtpDeleteFailure: 550 on non-original-files path → error log, returns {expected:false}', () => {
  resetLogCalls();
  const err = ftpError(550, '550 Delete operation failed.');
  const result = _handleFtpDeleteFailure(err, '/the-root/order/IMG.jpg');
  assert.deepEqual(result, { expected: false });
  assert.equal(__logCalls.error.length, 1, 'real 550 elsewhere keeps its error entry');
  assert.equal(__logCalls.error[0].msg, 'Failed to delete file from FTP');
  assert.equal(__logCalls.debug.length, 0);
});

test('_handleFtpDeleteFailure: non-550 error on /original-files/ → error log (regression guard)', () => {
  resetLogCalls();
  const err = ftpError(530, '530 Login incorrect');
  const result = _handleFtpDeleteFailure(err, '/order/original-files/IMG.jpg');
  assert.deepEqual(result, { expected: false });
  assert.equal(__logCalls.error.length, 1,
    'a non-550 error on /original-files/ must still surface — only the read-only delete is expected');
  assert.equal(__logCalls.debug.length, 0);
});

// `expected:true` is the contract that lets the call site keep
// allFilesSucceeded=true → which is what allows the parent-folder cleanup
// branch (line ~385 in ftp-service.js: `if (isSubfolder && allFilesSucceeded)`)
// to be entered after a 550 on /original-files/. Asserting the return value
// here is the load-bearing test for that behaviour change — the inline call
// site is `if (!expected) allFilesSucceeded = false;` so a true return is
// exactly the gate that keeps the cleanup branch reachable.
test('_handleFtpDeleteFailure: expected:true is what keeps the parent-folder cleanup branch reachable', () => {
  resetLogCalls();
  const err = ftpError(550, '550 Delete operation failed.');

  // Mirror the inline pattern at ftp-service.js line ~370:
  let allFilesSucceeded = true;
  const { expected } = _handleFtpDeleteFailure(err, '/order/original-files/IMG.jpg');
  if (!expected) allFilesSucceeded = false;

  assert.equal(allFilesSucceeded, true,
    'after the demotion the per-folder success flag must stay true so the ' +
    '`if (isSubfolder && allFilesSucceeded) { … client.removeDir … }` branch ' +
    'is still entered (it will short-circuit naturally on the still-present file)');

  // And a sibling regression guard — a NORMAL 550 elsewhere must still flip
  // the flag, otherwise we'd be masking real permission problems.
  resetLogCalls();
  let normalFlag = true;
  const normal = _handleFtpDeleteFailure(ftpError(550, '550'), '/order/job/IMG.jpg');
  if (!normal.expected) normalFlag = false;
  assert.equal(normalFlag, false, 'real 550 elsewhere still trips allFilesSucceeded');
});


// ─────────────────────────────────────────────────────────────────────────
// 4. Windows-basename sanitiser.
//
//    Pixfizz Core occasionally escapes parentheses in upload filenames as
//    `\(` / `\)`. The backslash is a legal character on the Unix-side FTP
//    server but Windows treats it as a path separator — so `path.join` on
//    the local target re-parses `2-AVIS\(3\).jpg` as a nested folder, and
//    the open call ENOENTs on the (non-existent) intermediate folder.
//    `_sanitiseWindowsBasename` replaces every Windows-reserved character
//    in the basename with `_` so the local target survives even when the
//    upstream filename is malformed.
// ─────────────────────────────────────────────────────────────────────────

const { _sanitiseWindowsBasename } = ftpService;

test('_sanitiseWindowsBasename: clean filename → unchanged (no false-positive churn)', () => {
  assert.equal(_sanitiseWindowsBasename('IMG_001.jpg'),                       'IMG_001.jpg');
  assert.equal(_sanitiseWindowsBasename('2-AVIS_26-5FV39e8.jpg'),              '2-AVIS_26-5FV39e8.jpg');
  assert.equal(_sanitiseWindowsBasename('file with spaces and (parens).jpg'), 'file with spaces and (parens).jpg');
  assert.equal(_sanitiseWindowsBasename('résumé.png'),                         'résumé.png');
  assert.equal(_sanitiseWindowsBasename('emoji-😀.jpg'),                       'emoji-😀.jpg');
});

test('_sanitiseWindowsBasename: literal backslash → replaced (the original-files \\( bug)', () => {
  // This is the exact pathology from the customer log line.
  assert.equal(
    _sanitiseWindowsBasename('2-AVIS_26-5FV39e8\\(3\\).jpg'),
    '2-AVIS_26-5FV39e8_(3_).jpg',
  );
});

test('_sanitiseWindowsBasename: forward slash → replaced', () => {
  // A `/` in a basename would let path.join compose an unintended subfolder
  // — same failure mode as backslash, just less common on Windows hosts.
  assert.equal(_sanitiseWindowsBasename('a/b.jpg'), 'a_b.jpg');
});

test('_sanitiseWindowsBasename: each Windows-reserved character is replaced', () => {
  // Per https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
  // the reserved set is `< > : " / \ | ? *`.
  for (const ch of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
    assert.equal(
      _sanitiseWindowsBasename(`x${ch}y.jpg`),
      'x_y.jpg',
      `reserved character ${JSON.stringify(ch)} must be replaced`,
    );
  }
});

test('_sanitiseWindowsBasename: control characters (0x00-0x1F) are replaced', () => {
  // Belt-and-braces — Windows rejects these in CreateFile too. Unlikely in
  // real customer filenames but cheap to guard against. Bad chars are built
  // at runtime via String.fromCharCode so the test source stays ASCII-clean.
  const labels = { 0x00: 'NUL', 0x09: 'TAB', 0x0A: 'LF', 0x0D: 'CR', 0x1F: 'US' };
  for (const code of [0x00, 0x09, 0x0A, 0x0D, 0x1F]) {
    const bad = 'a' + String.fromCharCode(code) + 'b.jpg';
    assert.equal(_sanitiseWindowsBasename(bad), 'a_b.jpg', `control char 0x${code.toString(16)} (${labels[code]}) must be replaced`);
  }
  // Printable space (0x20) is fine in Windows filenames; must NOT be replaced.
  assert.equal(_sanitiseWindowsBasename('a b.jpg'), 'a b.jpg');
});

test('_sanitiseWindowsBasename: multiple adjacent reserved characters are each replaced (no collapsing)', () => {
  // Don't collapse runs — preserving length keeps the relationship between
  // the original and sanitised name visually obvious in logs.
  assert.equal(_sanitiseWindowsBasename('a\\\\b.jpg'), 'a__b.jpg');
  assert.equal(_sanitiseWindowsBasename('a<>?:b.jpg'), 'a____b.jpg');
});

test('_sanitiseWindowsBasename: idempotent — re-sanitising a clean name is a no-op', () => {
  const dirty = '2-AVIS_26-5FV39e8\\(3\\).jpg';
  const clean = _sanitiseWindowsBasename(dirty);
  assert.equal(_sanitiseWindowsBasename(clean), clean,
    'a clean name must round-trip through the sanitiser unchanged');
});

test('_sanitiseWindowsBasename: non-string / empty inputs are returned unchanged (defensive)', () => {
  // These come from upstream client.list parsing — guard so a malformed
  // listing doesn't crash the download loop. The local mkdir / open call
  // downstream will surface the underlying issue if `item.name` was bogus.
  assert.equal(_sanitiseWindowsBasename(''),         '');
  assert.equal(_sanitiseWindowsBasename(null),       null);
  assert.equal(_sanitiseWindowsBasename(undefined),  undefined);
  // Numbers, etc. — bail without throwing.
  assert.equal(_sanitiseWindowsBasename(42),         42);
});
