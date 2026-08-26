'use strict';

/**
 * Integration tests for src/main/services/fuji-pic-pro-file-writer.js.
 *
 * Uses real os.tmpdir I/O (same posture as fuji-jobmaker-file-writer.test.js
 * and the sharp-based batchCrop tests). Every test cleans up after
 * itself via `t.after`.
 *
 * Coverage:
 *   stageImages
 *     - sequence naming: 0001, 0002, ... zero-padded to 4 chars
 *     - extension preservation (case-lowered)
 *     - correct negNumberMap (source + original + staged paths)
 *     - staging folder is created but the root is NOT auto-created
 *     - re-run overwrites existing staged files (idempotency)
 *     - arg validation (missing root / orderId / empty images)
 *
 *   writeOrderFile
 *     - .tmp is renamed to final; no .tmp left behind on success
 *     - Order Data folder must exist (does not auto-create)
 *     - re-submit overwrites existing file
 *     - contents match input byte-for-byte
 *
 *   deliverToDigin
 *     - happy path: rename same-volume; destFolder exists, staging gone
 *     - EXDEV fallback: injects a throwing rename → uses copy path,
 *       destFolder exists byte-for-byte, staging removed, warning
 *       logged
 *     - missing DIGIN throws + writes nothing
 *     - missing staging throws
 *
 *   writeCommandFile
 *     - contents are exactly `[{command}]{orderId}` (no newline)
 *     - filename includes timestamp so two files can coexist
 *     - missing orderData throws
 *
 * Run via: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  stageImages,
  writeOrderFile,
  deliverToDigin,
  writeCommandFile,
  isSameVolume,
  _internals,
} = require('../fuji-pic-pro-file-writer');

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {},
};

// ── Fixture helpers ────────────────────────────────────────────────────────

async function makeTempDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'fpp-writer-'));
}

async function writeJpeg(destPath, bytes = 'fake-jpeg-bytes') {
  await fsp.writeFile(destPath, bytes);
}

/**
 * Build N source JPEGs in a scratch directory and return the
 * `imageFiles` shape stageImages expects.
 */
async function makeSourceImages(root, count) {
  const files = [];
  for (let i = 1; i <= count; i++) {
    const name = `IMG_${i}.JPG`;
    const srcPath = path.join(root, name);
    await writeJpeg(srcPath, `image-${i}-bytes`);
    files.push({ sourcePath: srcPath, originalFilename: `customer-${i}.jpg` });
  }
  return files;
}

// ── stageImages ────────────────────────────────────────────────────────────

test('stageImages: renames to 0001/0002/... in input order, extension preserved and lowercased', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const sources = await makeSourceImages(dir, 5);
  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);

  const result = await stageImages({
    imageStagingRoot: stagingRoot,
    orderId:          'ORD-1',
    imageFiles:       sources,
    deps:             { logger: silentLogger },
  });

  assert.equal(result.stagingFolder, path.join(stagingRoot, 'ORD-1'));
  assert.equal(result.negNumberMap.length, 5);

  const expectedNames = ['0001.jpg', '0002.jpg', '0003.jpg', '0004.jpg', '0005.jpg'];
  const stagedNames   = result.negNumberMap.map(e => e.stagedName);
  assert.deepEqual(stagedNames, expectedNames,
    'staged names must be sequence-padded to 4 digits with the lower-cased source extension');

  // Every staged file exists at the expected path.
  for (const entry of result.negNumberMap) {
    assert.ok(fs.existsSync(entry.stagedPath), `staged file missing: ${entry.stagedPath}`);
  }
});

test('stageImages: bytes are copied faithfully (not moved) — source files remain', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const sources = await makeSourceImages(dir, 2);
  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);

  const { negNumberMap } = await stageImages({
    imageStagingRoot: stagingRoot, orderId: 'ORD-1', imageFiles: sources,
  });

  for (let i = 0; i < 2; i++) {
    const stagedBytes = await fsp.readFile(negNumberMap[i].stagedPath, 'utf-8');
    const sourceBytes = await fsp.readFile(sources[i].sourcePath,       'utf-8');
    assert.equal(stagedBytes, sourceBytes, 'staged bytes must match source');
    assert.ok(fs.existsSync(sources[i].sourcePath), 'source file must still exist (copy, not move)');
  }
});

test('stageImages: negNumberMap carries originalFilename and negNumber verbatim', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const sources = await makeSourceImages(dir, 3);
  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);

  const { negNumberMap } = await stageImages({
    imageStagingRoot: stagingRoot, orderId: 'ORD-1', imageFiles: sources,
  });

  assert.equal(negNumberMap[0].negNumber, '0001');
  assert.equal(negNumberMap[0].originalFilename, 'customer-1.jpg');
  assert.equal(negNumberMap[2].negNumber, '0003');
  assert.equal(negNumberMap[2].originalFilename, 'customer-3.jpg');
});

test('stageImages: preserves varied extensions and lowercases them', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const sources = [];
  for (const ext of ['.jpg', '.JPEG', '.PNG', '.tif']) {
    const p = path.join(dir, `src${ext}`);
    await writeJpeg(p, `bytes-${ext}`);
    sources.push({ sourcePath: p });
  }

  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const { negNumberMap } = await stageImages({
    imageStagingRoot: stagingRoot, orderId: 'ORD-EXT', imageFiles: sources,
  });

  assert.equal(negNumberMap[0].stagedName, '0001.jpg');
  assert.equal(negNumberMap[1].stagedName, '0002.jpeg');
  assert.equal(negNumberMap[2].stagedName, '0003.png');
  assert.equal(negNumberMap[3].stagedName, '0004.tif');
});

test('stageImages: imageStagingRoot must exist (no auto-create)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const sources = await makeSourceImages(dir, 1);
  await assert.rejects(
    stageImages({
      imageStagingRoot: path.join(dir, 'doesnt-exist'),
      orderId:          'ORD-1',
      imageFiles:       sources,
    }),
    /imageStagingRoot does not exist/,
    'a typoed staging root must fail loudly rather than silently create a folder in the wrong place',
  );
});

test('stageImages: re-run overwrites existing staged files (idempotent for retry)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const sources = await makeSourceImages(dir, 2);
  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);

  // First pass with original bytes.
  await stageImages({ imageStagingRoot: stagingRoot, orderId: 'ORD-1', imageFiles: sources });

  // Rewrite the source bytes and re-run — staged folder should
  // reflect the new bytes.
  await writeJpeg(sources[0].sourcePath, 'updated-1');
  await writeJpeg(sources[1].sourcePath, 'updated-2');

  const { negNumberMap } = await stageImages({
    imageStagingRoot: stagingRoot, orderId: 'ORD-1', imageFiles: sources,
  });

  const b1 = await fsp.readFile(negNumberMap[0].stagedPath, 'utf-8');
  const b2 = await fsp.readFile(negNumberMap[1].stagedPath, 'utf-8');
  assert.equal(b1, 'updated-1');
  assert.equal(b2, 'updated-2');
});

test('fix 8: retry clears stale files from a prior partial attempt (wrong-extension NegNumber bug)', async (t) => {
  // Simulates the operator retrying a job that failed part-way
  // through staging on a previous attempt, with a DIFFERENT source
  // extension this time (e.g. .png replaced by .jpg). Pre-fix the
  // `mkdir -p` silently reused the folder → the second attempt's
  // `0001.jpg` landed alongside the prior `0001.png`, and
  // `NegNumber=0001` (ext-less per spec p. 347) is ambiguous —
  // DIGIN could pick either. Wrong picture printed.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-RETRY');
  await fsp.mkdir(stagingFolder);
  // Pre-populate: leftover 0001.png + a 0007.jpg from a bigger prior batch
  // that we're now retrying with fewer images.
  await fsp.writeFile(path.join(stagingFolder, '0001.png'), 'stale-png-bytes');
  await fsp.writeFile(path.join(stagingFolder, '0007.jpg'), 'stale-jpg-from-larger-batch');

  const sources = await makeSourceImages(dir, 2);   // two source .JPGs

  const result = await stageImages({
    imageStagingRoot: stagingRoot,
    orderId:          'ORD-RETRY',
    imageFiles:       sources,
  });

  const entries = (await fsp.readdir(stagingFolder)).sort();
  assert.deepEqual(entries, ['0001.jpg', '0002.jpg'],
    'staging folder must contain ONLY the current run — no stale 0001.png (ambiguous with the new 0001.jpg on NegNumber lookup) and no leftover 0007.jpg from a larger prior batch');
  assert.equal(result.negNumberMap.length, 2);
});

test('stageImages: arg validation — missing / empty inputs throw before any I/O', async () => {
  await assert.rejects(stageImages({ orderId: 'x', imageFiles: [{}] }),
    /imageStagingRoot.+is required/);
  await assert.rejects(stageImages({ imageStagingRoot: '/x', imageFiles: [{}] }),
    /orderId.+is required/);
  await assert.rejects(stageImages({ imageStagingRoot: '/x', orderId: 'y' }),
    /must contain at least one image/);
  await assert.rejects(stageImages({ imageStagingRoot: '/x', orderId: 'y', imageFiles: [] }),
    /must contain at least one image/);
  await assert.rejects(stageImages({ imageStagingRoot: '/x', orderId: 'y', imageFiles: [{}] }),
    /imageFiles\[0\] is missing sourcePath/);
});

// ── writeOrderFile ─────────────────────────────────────────────────────────

test('writeOrderFile: writes via .tmp + rename; final file has exact bytes and no leftover .tmp', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const orderData = path.join(dir, 'order-data'); await fsp.mkdir(orderData);

  const contents = '[Order]\r\nOrderId=ORD-1\r\n';
  const { writtenPath } = await writeOrderFile({
    orderDataPath: orderData,
    filename:      'ORD-1.txt',
    contents,
  });

  assert.equal(writtenPath, path.join(orderData, 'ORD-1.txt'));
  const bytes = await fsp.readFile(writtenPath, 'utf-8');
  assert.equal(bytes, contents, 'file contents must match input verbatim (CRLF preserved)');

  const dirents = await fsp.readdir(orderData);
  assert.deepEqual(dirents, ['ORD-1.txt'],
    'no .tmp sibling may be left behind after a successful write');
});

test('writeOrderFile: orderDataPath must exist (do not auto-create)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    writeOrderFile({
      orderDataPath: path.join(dir, 'doesnt-exist'),
      filename: 'x.txt', contents: 'x',
    }),
    /orderDataPath does not exist/,
  );
});

test('writeOrderFile: re-submit overwrites in place (final rename is atomic)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const orderData = path.join(dir, 'order-data'); await fsp.mkdir(orderData);
  await writeOrderFile({ orderDataPath: orderData, filename: 'ORD.txt', contents: 'first' });
  await writeOrderFile({ orderDataPath: orderData, filename: 'ORD.txt', contents: 'second' });
  const bytes = await fsp.readFile(path.join(orderData, 'ORD.txt'), 'utf-8');
  assert.equal(bytes, 'second');
});

test('writeOrderFile: arg validation', async () => {
  await assert.rejects(writeOrderFile({ filename: 'x', contents: '' }),
    /orderDataPath.+is required/);
  await assert.rejects(writeOrderFile({ orderDataPath: '/x', contents: '' }),
    /filename.+is required/);
  await assert.rejects(writeOrderFile({ orderDataPath: '/x', filename: 'x' }),
    /contents.+must be a string/);
});

test('writeOrderFile: leaves NO .tmp when the rename itself fails', async (t) => {
  // Injected fsPromises where rename always throws. The writer must
  // best-effort remove the .tmp so a follow-up attempt doesn't
  // rename over stale bytes. We inject a REAL writeFile so the .tmp
  // actually lands on disk, then a stub rename to force the failure,
  // and a real unlink so the cleanup can succeed.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const orderData = path.join(dir, 'order-data'); await fsp.mkdir(orderData);

  let cleanupCalled = false;
  const injected = {
    ...fsp,
    rename: async () => { throw new Error('simulated rename failure'); },
    unlink: async (...args) => { cleanupCalled = true; return fsp.unlink(...args); },
  };

  await assert.rejects(
    writeOrderFile({
      orderDataPath: orderData, filename: 'ORD.txt', contents: 'x',
      deps: { fsPromises: injected },
    }),
    /simulated rename failure/,
  );

  assert.ok(cleanupCalled, 'unlink must be attempted on rename failure so no .tmp is left behind');
  const dirents = await fsp.readdir(orderData);
  assert.deepEqual(dirents, [], '.tmp cleanup must succeed even after rename failure');
});

// ── deliverToDigin ─────────────────────────────────────────────────────────

test('deliverToDigin: same-volume rename → destFolder exists, staging gone, method="rename"', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-1'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'bytes-1');
  await writeJpeg(path.join(stagingFolder, '0002.jpg'), 'bytes-2');

  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const result = await deliverToDigin({
    stagingFolder, diginPath, orderId: 'ORD-1',
    deps: { logger: silentLogger },
  });

  assert.equal(result.method, 'rename');
  assert.equal(result.destFolder, path.join(diginPath, 'ORD-1'));
  assert.ok(fs.existsSync(result.destFolder), 'destFolder must exist');
  assert.equal(fs.existsSync(stagingFolder), false, 'staging folder must be gone after rename');
  const bytes = await fsp.readFile(path.join(result.destFolder, '0001.jpg'), 'utf-8');
  assert.equal(bytes, 'bytes-1');
});

// ── TRIPWIRES (1.15.3) — same-volume no-change lock ──────────────────────
//
// 1.15.3 introduces an EXDEV cross-volume path that writes into
// `{diginPath}/.ohd-inbox-{...}` and then renames intra-DIGIN. These
// tripwires assert same-volume delivery is byte-identical to today:
// atomic rename, no inbox, no extra file / folder anywhere. If the
// 1.15.3 fix accidentally engages the cross-volume plumbing when
// same-volume would have worked, these tests fail loudly.
//
// Do NOT delete these when the cross-volume path is added — the whole
// point is to lock that the healthy-config majority of labs sees zero
// change from 1.15.3.

test('TRIPWIRE (1.15.3): same-volume rename creates NO `.ohd-inbox-*` folder inside DIGIN', async (t) => {
  // Locks that cross-volume plumbing is not engaged when a plain
  // rename works. If a future edit unifies the code paths and always
  // routes through the inbox (even on same-volume), this test fails
  // — same-volume must NOT create the inbox scaffolding.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-TW1'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'tw1-1');
  await writeJpeg(path.join(stagingFolder, '0002.jpg'), 'tw1-2');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const result = await deliverToDigin({
    stagingFolder, diginPath, orderId: 'ORD-TW1',
    deps: { logger: silentLogger },
  });

  assert.equal(result.method, 'rename',
    'same-volume path must return method:"rename" — not any inbox variant');
  const dirents = await fsp.readdir(diginPath);
  assert.deepEqual(dirents, ['ORD-TW1'],
    `DIGIN must contain ONLY the delivered folder; found: ${JSON.stringify(dirents)}. ` +
    'If an `.ohd-inbox-*` appears here on a same-volume delivery, the fix is engaging ' +
    'cross-volume plumbing when it shouldn\'t.');
  const inboxLike = dirents.filter(n => n.startsWith('.ohd-inbox-'));
  assert.deepEqual(inboxLike, [],
    'no .ohd-inbox-* folder may exist in DIGIN after a same-volume delivery');
});

test('TRIPWIRE (1.15.3): same-volume rename calls rename EXACTLY once and mkdir/copyFile ZERO times on DIGIN side', async (t) => {
  // Byte-identical means the syscall shape doesn't change: one atomic
  // rename, no directory creation on the DIGIN side, no file copy.
  // This test instruments the fs so any deviation surfaces.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-TW2'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'tw2');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const calls = { rename: 0, mkdir: 0, copyFile: 0, cp: 0, writeFile: 0 };
  const instrumented = {
    ...fsp,
    rename:   async (...args) => { calls.rename++;   return fsp.rename(...args); },
    mkdir:    async (...args) => { calls.mkdir++;    return fsp.mkdir(...args); },
    copyFile: async (...args) => { calls.copyFile++; return fsp.copyFile(...args); },
    cp:       async (...args) => { calls.cp++;       return fsp.cp(...args); },
    writeFile:async (...args) => { calls.writeFile++;return fsp.writeFile(...args); },
  };

  const result = await deliverToDigin({
    stagingFolder, diginPath, orderId: 'ORD-TW2',
    deps: { fsPromises: instrumented, logger: silentLogger },
  });

  assert.equal(result.method, 'rename');
  assert.equal(calls.rename, 1, `rename must be called exactly once; was ${calls.rename}`);
  assert.equal(calls.mkdir, 0, `no mkdir on same-volume delivery; was ${calls.mkdir}`);
  assert.equal(calls.copyFile, 0, `no copyFile on same-volume delivery; was ${calls.copyFile}`);
  assert.equal(calls.cp, 0, `no fsp.cp on same-volume delivery; was ${calls.cp}`);
  assert.equal(calls.writeFile, 0, `no writeFile on same-volume delivery; was ${calls.writeFile}`);
});

test('TRIPWIRE (1.15.3): after same-volume rename, destFolder contents are byte-identical to staging', async (t) => {
  // Redundant with the older happy-path test that reads 0001.jpg,
  // but stronger: locks the WHOLE folder byte-for-byte so any future
  // "post-rename normalisation" would surface here.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-TW3'); await fsp.mkdir(stagingFolder);
  const expected = new Map();
  for (let i = 1; i <= 5; i++) {
    const name  = `${String(i).padStart(4, '0')}.jpg`;
    const bytes = `tw3-content-${i}-${'x'.repeat(i * 17)}`;
    await fsp.writeFile(path.join(stagingFolder, name), bytes);
    expected.set(name, bytes);
  }
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const result = await deliverToDigin({
    stagingFolder, diginPath, orderId: 'ORD-TW3',
    deps: { logger: silentLogger },
  });

  assert.equal(result.method, 'rename');
  const delivered = new Set(await fsp.readdir(result.destFolder));
  assert.equal(delivered.size, expected.size,
    `delivered file count must equal staged file count; got ${delivered.size} vs ${expected.size}`);
  for (const [name, bytes] of expected) {
    assert.ok(delivered.has(name), `${name} must appear in destFolder`);
    const got = await fsp.readFile(path.join(result.destFolder, name), 'utf-8');
    assert.equal(got, bytes, `${name} bytes must be identical to staged`);
  }
});

test('M7b deliverToDigin: EXDEV throws the co-location error AND nothing is written inside DIGIN before the rename', async (t) => {
  // Pre-M7b, an EXDEV cross-volume rename triggered the "slow path":
  // copy the staged folder into `{diginPath}/{orderId}.ohdtmp`, rename
  // that in place, remove staging. A customer disproved the "Frontier
  // ignores .ohdtmp" assumption written into that code (2026-08-18):
  // PIC Pro ingested the .ohdtmp folder mid-copy as a blank order and
  // then re-ingested the renamed folder as the correct order. Slow
  // path deleted. Now: rename attempts (fast path), EXDEV throws with
  // an actionable message naming both configured paths and the fix.
  //
  // This test locks TWO invariants:
  //   1. EXDEV throws the named error — never falls back to a
  //      copy-into-DIGIN slow path that could reintroduce the bug.
  //   2. DIGIN is untouched — no file, no folder, no `.ohdtmp`
  //      sibling appears there. Since v1.15.1 the save-time
  //      isSameVolume check is ADVISORY (three-state; only
  //      certain-same suppresses a warning, and it never rejects a
  //      save), so THIS dispatch-time throw is the AUTHORITATIVE
  //      cross-volume check. Do not weaken it — the string check
  //      cannot tell same-server-different-share apart from a real
  //      cross-volume misconfiguration, so the filesystem has to.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-2'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'exdev-1');
  await writeJpeg(path.join(stagingFolder, '0002.jpg'), 'exdev-2');

  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const injected = {
    ...fsp,
    rename: async () => {
      const err = new Error('EXDEV cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    },
  };

  await assert.rejects(
    deliverToDigin({
      stagingFolder, diginPath, orderId: 'ORD-2',
      deps: { fsPromises: injected, logger: silentLogger },
    }),
    /same volume/,
    'EXDEV must throw the co-location error, never silently fall through to a slow path',
  );

  // Load-bearing: DIGIN must be untouched. No `.ohdtmp` sibling, no
  // partial folder, no anything. Locks that a future maintainer
  // doesn't reintroduce a slow-path fallback that lands even one
  // byte inside diginPath before the (never-reached) rename.
  const dirents = await fsp.readdir(diginPath);
  assert.deepEqual(dirents, [],
    'nothing may be written inside diginPath when the rename fails');

  // Staging is untouched too — the slow path used to clean it up,
  // but with no slow path there's nothing to clean up. The staged
  // folder stays where it was so the operator can inspect it after
  // fixing the config and retrying.
  assert.ok(fs.existsSync(stagingFolder),
    'staging folder is left in place when delivery fails');
});

test('M7b deliverToDigin: EXDEV error text names both configured paths and the fix', async (t) => {
  // Named the paths + the fix in the error so the operator sees
  // exactly what to change without having to read the log. Locking
  // the wording so a future refactor can't quietly weaken it.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-3'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'x');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const injected = {
    ...fsp,
    rename: async () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; },
  };

  let caught;
  try {
    await deliverToDigin({
      stagingFolder, diginPath, orderId: 'ORD-3',
      deps: { fsPromises: injected, logger: silentLogger },
    });
  } catch (err) { caught = err; }
  assert.ok(caught, 'must throw');
  assert.match(caught.message, /Image Staging Root and DIGIN Path must be on the same volume/);
  assert.match(caught.message, new RegExp(stagingFolder.replace(/[\\/]/g, '\\$&')),
    'error must name the configured Image Staging Root so the operator sees exactly which path is wrong');
  assert.match(caught.message, new RegExp(diginPath.replace(/[\\/]/g, '\\$&')),
    'error must name the configured DIGIN Path');
  assert.match(caught.message, /Save-time validation now enforces this/,
    'error must reference the save-time enforcement so the operator knows the retry gate exists');
});

test('deliverToDigin: non-EXDEV rename error propagates untouched', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-P'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'x');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const injected = {
    ...fsp,
    rename: async () => {
      const err = new Error('EPERM operation not permitted');
      err.code = 'EPERM';
      throw err;
    },
  };

  await assert.rejects(
    deliverToDigin({
      stagingFolder, diginPath, orderId: 'ORD-P',
      deps: { fsPromises: injected, logger: silentLogger },
    }),
    /EPERM/,
    'non-EXDEV errors must NOT trigger the copy fallback',
  );
});

test('deliverToDigin: missing DIGIN path throws, staging untouched', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-X'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'x');

  await assert.rejects(
    deliverToDigin({
      stagingFolder,
      diginPath: path.join(dir, 'no-digin'),
      orderId: 'ORD-X',
    }),
    /diginPath does not exist/,
  );
  assert.ok(fs.existsSync(stagingFolder),
    'a failure to find DIGIN must not touch the staging folder — the caller can retry');
});

test('deliverToDigin: missing staging folder throws', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);
  await assert.rejects(
    deliverToDigin({
      stagingFolder: path.join(dir, 'no-such-staging'),
      diginPath,
      orderId: 'ORD-X',
    }),
    /stagingFolder does not exist/,
  );
});

// ── Fix 7: idempotent replay ──────────────────────────────────────────────

test('fix 7: destFolder already exists + staging gone → idempotent no-op (already-delivered)', async (t) => {
  // Simulates a crash between the successful DIGIN move and the
  // monitor's subsequent `_advance('building')` persist. On restart
  // the entry rehydrates in `delivering`; the monitor replays this
  // function. Without fix 7 the replay would throw (either EEXIST
  // or "stagingFolder does not exist") and mark a successfully-
  // delivered order failed, with [release] never fired.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-IDEM'); // deliberately DOES NOT exist
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);
  const destFolder = path.join(diginPath, 'ORD-IDEM'); await fsp.mkdir(destFolder);
  await fsp.writeFile(path.join(destFolder, '0001.jpg'), 'already-delivered-bytes');

  const result = await deliverToDigin({
    stagingFolder, diginPath, orderId: 'ORD-IDEM',
    deps: { logger: silentLogger },
  });

  assert.equal(result.method, 'already-delivered',
    'must return the idempotent-replay marker rather than throw');
  assert.equal(result.destFolder, destFolder);
  const bytes = await fsp.readFile(path.join(destFolder, '0001.jpg'), 'utf-8');
  assert.equal(bytes, 'already-delivered-bytes',
    'must NOT overwrite the previously delivered file');
});

test('fix 7: destFolder AND staging both exist → refuse to merge (throws)', async (t) => {
  // Ambiguous state: could be a partial prior delivery, or a
  // legitimate name conflict between two dispatches. Refuse rather
  // than merge — the operator investigates.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-CONFLICT');
  await fsp.mkdir(stagingFolder);
  await fsp.writeFile(path.join(stagingFolder, '0001.jpg'), 'from-staging');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);
  const destFolder = path.join(diginPath, 'ORD-CONFLICT'); await fsp.mkdir(destFolder);
  await fsp.writeFile(path.join(destFolder, '0001.jpg'), 'from-earlier');

  await assert.rejects(
    deliverToDigin({
      stagingFolder, diginPath, orderId: 'ORD-CONFLICT',
      deps: { logger: silentLogger },
    }),
    /already exists AND staging folder still exists — refusing to merge/,
  );
  // Neither side was mutated.
  const stagingBytes = await fsp.readFile(path.join(stagingFolder, '0001.jpg'), 'utf-8');
  const destBytes    = await fsp.readFile(path.join(destFolder,    '0001.jpg'), 'utf-8');
  assert.equal(stagingBytes, 'from-staging');
  assert.equal(destBytes,    'from-earlier');
});

// M7b (2026-08-18): the two "fix 10" tests that lived here — one for
// stale `.ohdtmp` cleanup before a fresh copy, one for partial-copy
// cleanup after an EXDEV copy failure — were removed together with
// the EXDEV slow path they guarded. The bug they were originally
// added to prevent (stale files merging into a live delivery) can no
// longer occur: there is no `.ohdtmp` code path to leave anything
// behind. The advisory save-time isSameVolume check (v1.15.1 three-
// state) plus the dispatch-time EXDEV throw above replace both. See
// M7b commit for the customer incident that removed the slow path.

test('fix 7: happy path still returns method:"rename" (idempotency check does not paper over normal flow)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-HP'); await fsp.mkdir(stagingFolder);
  await fsp.writeFile(path.join(stagingFolder, '0001.jpg'), 'hp');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const result = await deliverToDigin({
    stagingFolder, diginPath, orderId: 'ORD-HP',
    deps: { logger: silentLogger },
  });
  assert.equal(result.method, 'rename',
    'when neither dest nor conflict exists the fast path (rename) still runs');
});

// ── writeCommandFile ──────────────────────────────────────────────────────

test('writeCommandFile: contents are literally [command]orderId (no trailing newline)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const orderData = path.join(dir, 'order-data'); await fsp.mkdir(orderData);

  const { writtenPath } = await writeCommandFile({
    orderDataPath: orderData,
    command: 'release',
    orderId: 'ORD-1',
  });
  const bytes = await fsp.readFile(writtenPath, 'utf-8');
  assert.equal(bytes, '[release]ORD-1', 'exact byte content per spec — no whitespace / newline');
});

test('writeCommandFile: filename is prefixed + timestamped so two commands can coexist', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const orderData = path.join(dir, 'order-data'); await fsp.mkdir(orderData);

  // Fake clock returning two different timestamps.
  let t0 = 1000;
  const clock = () => (t0 += 1);

  const a = await writeCommandFile({ orderDataPath: orderData, command: 'release', orderId: 'ORD-1', deps: { clock } });
  const b = await writeCommandFile({ orderDataPath: orderData, command: 'release', orderId: 'ORD-1', deps: { clock } });

  assert.notEqual(a.writtenPath, b.writtenPath, 'timestamp suffix must produce distinct filenames');
  assert.ok(path.basename(a.writtenPath).startsWith(_internals.CMD_FILENAME_PREFIX),
    `filename must start with ${_internals.CMD_FILENAME_PREFIX}`);
  assert.ok(path.basename(a.writtenPath).includes('release'));
  assert.ok(path.basename(a.writtenPath).includes('ORD-1'));
  assert.ok(path.basename(a.writtenPath).endsWith('.txt'));
});

test('writeCommandFile: writes different commands (release / delete / restart)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const orderData = path.join(dir, 'order-data'); await fsp.mkdir(orderData);

  for (const command of ['release', 'delete', 'restart']) {
    const { writtenPath } = await writeCommandFile({
      orderDataPath: orderData, command, orderId: 'X',
    });
    const bytes = await fsp.readFile(writtenPath, 'utf-8');
    assert.equal(bytes, `[${command}]X`);
  }
});

test('writeCommandFile: missing orderDataPath / command / orderId throws', async () => {
  await assert.rejects(writeCommandFile({ command: 'release', orderId: 'x' }),
    /orderDataPath.+is required/);
  await assert.rejects(writeCommandFile({ orderDataPath: '/x', orderId: 'x' }),
    /command.+is required/);
  await assert.rejects(writeCommandFile({ orderDataPath: '/x', command: 'release' }),
    /orderId.+is required/);
});

test('writeCommandFile: orderDataPath must exist', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    writeCommandFile({
      orderDataPath: path.join(dir, 'not-there'),
      command: 'release', orderId: 'x',
    }),
    /orderDataPath does not exist/,
  );
});

// ── _internals ─────────────────────────────────────────────────────────────

test('_padNegNumber pads to 4 digits and preserves longer strings', () => {
  assert.equal(_internals._padNegNumber(1),    '0001');
  assert.equal(_internals._padNegNumber(42),   '0042');
  assert.equal(_internals._padNegNumber(1234), '1234');
  assert.equal(_internals._padNegNumber(12345), '12345',
    'numbers past 4 digits pass through — never hit in practice; matches String.padStart semantics');
});

// ═════════════════════════════════════════════════════════════════════════
// isSameVolume — three-state verdict (M7c → v1.15.1)
// ═════════════════════════════════════════════════════════════════════════
//
// v1.15.1 turned the check three-state after 1.15.0 hard-blocked a real
// lab from saving a valid controller: their two UNC paths were on the
// same server but different shares (`\\labserver1\Pixfizz Digin Staging`
// alongside `\\labserver1\Digin`) — very possibly the same physical
// volume, but the 1.15.0 helper called it cross-volume and refused the
// save. The verdict is now:
//
//   certain-same      — same drive letter, or same UNC host+share
//   certain-different — different drive letters, or different UNC servers
//   indeterminate     — everything else (same-server-different-share,
//                       local-vs-UNC, unparseable strings)
//
// The IPC caller SAVES on every verdict and warns when the verdict
// isn't certain-same. The dispatch-side EXDEV throw in deliverToDigin
// (see the M7b test near line 380) is the authoritative check — it
// stays unchanged. Tests here cover the string-compare rules the
// docstring specifies. NO fs I/O — invariant these tests protect.

test('isSameVolume: same drive letter (different subpaths) → certain-same', () => {
  assert.deepEqual(isSameVolume('C:\\Fuji\\staging', 'C:\\Fuji\\DIGIN'),
    { verdict: 'certain-same' });
});

test('isSameVolume: different drive letters → certain-different (different-drives)', () => {
  // Two physical drives on one Windows box — rename would EXDEV.
  assert.deepEqual(
    isSameVolume('C:\\Fuji\\staging', 'D:\\Fuji\\DIGIN'),
    { verdict: 'certain-different', code: 'different-drives' },
  );
});

test('isSameVolume: same UNC share (different subpaths) → certain-same', () => {
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin\\staging', '\\\\labserver\\digin\\ORD-1'),
    { verdict: 'certain-same' },
  );
});

test('isSameVolume (v1.15.1 regression): same UNC server, different shares → INDETERMINATE (not cross-volume)', () => {
  // The exact shape that shipped as a hard block in 1.15.0 and stopped
  // a real lab from saving. Two shares on the same UNC server could be
  // one physical volume (rename succeeds) or two (rename EXDEVs) — you
  // cannot tell from the paths alone. Must be indeterminate; the IPC
  // caller must save; the dispatch-time EXDEV throw is the authority.
  assert.deepEqual(
    isSameVolume('\\\\labserver1\\Pixfizz Digin Staging', '\\\\labserver1\\Digin'),
    { verdict: 'indeterminate', code: 'same-server-different-share' },
    'THE 1.15.0 REGRESSION — must NOT be certain-different',
  );
  // Synonym: same-server-different-share regardless of subpaths.
  assert.deepEqual(
    isSameVolume('\\\\labserver\\staging\\x', '\\\\labserver\\digin\\y'),
    { verdict: 'indeterminate', code: 'same-server-different-share' },
  );
});

test('isSameVolume: different UNC servers → certain-different (different-servers)', () => {
  // Two different physical boxes — rename EXDEVs, no ambiguity even
  // if both happen to export a share of the same name.
  assert.deepEqual(
    isSameVolume('\\\\hostA\\digin\\x', '\\\\hostB\\digin\\y'),
    { verdict: 'certain-different', code: 'different-servers' },
  );
});

test('isSameVolume: local vs UNC → INDETERMINATE (mapped drive can point at any share)', () => {
  // A Windows mapped drive letter (Z: → \\host\share) makes local-vs-UNC
  // ambiguous. Cannot tell from paths alone; must be indeterminate.
  assert.deepEqual(
    isSameVolume('C:\\Fuji\\staging', '\\\\labserver\\digin\\ORD-1'),
    { verdict: 'indeterminate', code: 'local-vs-unc' },
  );
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin\\ORD-1', 'C:\\Fuji\\staging'),
    { verdict: 'indeterminate', code: 'local-vs-unc' },
  );
});

test('isSameVolume: trailing slashes and mixed separators are normalised', () => {
  // Local: trailing backslash, trailing forward slash, and no trailing
  // separator all resolve to the same drive.
  assert.deepEqual(isSameVolume('C:\\Fuji\\', 'C:/Fuji'), { verdict: 'certain-same' });
  assert.deepEqual(isSameVolume('C:',        'C:\\'),     { verdict: 'certain-same' });
  // UNC: forward slashes and trailing slashes must not perturb the
  // `\\host\share` extraction.
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin\\', '//labserver/digin/ORD-1'),
    { verdict: 'certain-same' },
  );
});

test('isSameVolume: case differences do not matter (Windows semantics)', () => {
  assert.deepEqual(isSameVolume('c:\\fuji', 'C:\\FUJI'), { verdict: 'certain-same' });
  assert.deepEqual(
    isSameVolume('\\\\LabServer\\DiGiN', '\\\\labserver\\digin\\sub'),
    { verdict: 'certain-same' },
  );
});

test('isSameVolume: bare `\\\\server\\share` with no subpath is a valid volume identifier', () => {
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin', '\\\\labserver\\digin\\ORD-1'),
    { verdict: 'certain-same' },
  );
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin\\', '\\\\labserver\\digin'),
    { verdict: 'certain-same' },
  );
});

test('isSameVolume: unparseable STRING → INDETERMINATE (unparseable-a / unparseable-b)', () => {
  // Bias-to-accept: a shape the string compare can't parse must NOT
  // cause a save rejection — the dispatch-time EXDEV throw is the
  // authority for exotic paths. The code distinguishes WHICH side
  // failed to parse so a diagnostic tool can point at it.
  assert.deepEqual(isSameVolume('\\\\lonely-host', 'C:\\Fuji'),
    { verdict: 'indeterminate', code: 'unparseable-a' }, 'bare `\\\\host` with no share is unparseable');
  assert.deepEqual(isSameVolume('', 'C:\\Fuji'),
    { verdict: 'indeterminate', code: 'unparseable-a' });
  assert.deepEqual(isSameVolume('C:\\Fuji', ''),
    { verdict: 'indeterminate', code: 'unparseable-b' });
  assert.deepEqual(isSameVolume('relative\\path', 'C:\\Fuji'),
    { verdict: 'indeterminate', code: 'unparseable-a' });
  assert.deepEqual(isSameVolume('/etc/foo', 'C:\\Fuji'),
    { verdict: 'indeterminate', code: 'unparseable-a' }, 'POSIX path is not a Windows volume identifier');
});

test('isSameVolume: non-string input throws (programmer error, not runtime state)', () => {
  // Non-string is a caller bug. A malformed string is a runtime state
  // and is separately handled as indeterminate.
  assert.throws(() => isSameVolume(null,       'C:\\Fuji'), /pathA must be a string/);
  assert.throws(() => isSameVolume(undefined,  'C:\\Fuji'), /pathA must be a string/);
  assert.throws(() => isSameVolume(42,         'C:\\Fuji'), /pathA must be a string/);
  assert.throws(() => isSameVolume({},         'C:\\Fuji'), /pathA must be a string/);
  assert.throws(() => isSameVolume('C:\\Fuji', null),       /pathB must be a string/);
  assert.throws(() => isSameVolume('C:\\Fuji', undefined),  /pathB must be a string/);
  assert.throws(() => isSameVolume('C:\\Fuji', 42),         /pathB must be a string/);
});

test('isSameVolume: does not touch the filesystem (paths need not exist)', () => {
  // Synchronous, no throw — proves the check is a pure string compare,
  // not an fs probe. Invariant M7c introduced; v1.15.1 keeps it.
  const result = isSameVolume(
    'C:\\definitely-not-a-real-path-1234',
    'C:\\also-not-real-5678\\deeper',
  );
  assert.deepEqual(result, { verdict: 'certain-same' });
});

test('isSameVolume: no verdict can ever cause a rejection (advisory-only lock)', () => {
  // The v1.15.1 contract with the IPC caller: EVERY return value has a
  // `verdict` that is one of the three known strings. The caller keys
  // ONLY on `verdict === 'certain-same'` to suppress a warning; it
  // never uses the verdict to reject a save. This test locks the
  // return shape so a future maintainer who wants to reintroduce
  // rejection has to also break this assertion.
  const inputs = [
    ['C:\\a', 'C:\\b'],
    ['C:\\a', 'D:\\a'],
    ['\\\\host\\share\\a', '\\\\host\\share\\b'],
    ['\\\\host\\share1',   '\\\\host\\share2'],
    ['\\\\hostA\\x',       '\\\\hostB\\x'],
    ['C:\\a',              '\\\\host\\share\\a'],
    ['',                   'C:\\a'],
    ['/etc/foo',           'C:\\a'],
  ];
  const valid = new Set(['certain-same', 'certain-different', 'indeterminate']);
  for (const [a, b] of inputs) {
    const r = isSameVolume(a, b);
    assert.ok(valid.has(r.verdict), `verdict must be one of the three known strings; got ${JSON.stringify(r)}`);
    // No `ok`, `success` or similar boolean-reject field exists on the
    // return. If a future change reintroduces one, this fails loudly.
    assert.equal('ok'     in r, false, 'no `ok` field — do not reintroduce boolean rejection');
    assert.equal('success' in r, false);
  }
});

test('_parseVolume: extracts drive letter, lowercased, no trailing sep', () => {
  assert.deepEqual(_internals._parseVolume('C:\\Fuji\\DIGIN'), { kind: 'local', drive: 'c:' });
  assert.deepEqual(_internals._parseVolume('D:'),               { kind: 'local', drive: 'd:' });
  assert.deepEqual(_internals._parseVolume('E:/x/y/'),          { kind: 'local', drive: 'e:' });
});

test('_parseVolume: extracts UNC host + share separately, lowercased', () => {
  // Splitting host and share is what v1.15.1 needs to tell
  // different-servers (certain) from different-shares-same-server
  // (indeterminate). Before v1.15.1 the return was a single joined
  // string `\\host\share` which couldn't distinguish the two.
  assert.deepEqual(_internals._parseVolume('\\\\LabServer\\DIGIN\\sub'),
    { kind: 'unc', host: 'labserver', share: 'digin' });
  assert.deepEqual(_internals._parseVolume('\\\\host\\share'),
    { kind: 'unc', host: 'host', share: 'share' });
  assert.deepEqual(_internals._parseVolume('//host/share/sub'),
    { kind: 'unc', host: 'host', share: 'share' });
});

test('_parseVolume: returns null for shapes it does not confidently recognise', () => {
  assert.equal(_internals._parseVolume(''),                null);
  assert.equal(_internals._parseVolume(null),              null);
  assert.equal(_internals._parseVolume(undefined),         null);
  assert.equal(_internals._parseVolume('\\\\lonely-host'), null, 'bare host with no share is not a volume identifier');
  assert.equal(_internals._parseVolume('relative\\path'),  null);
  assert.equal(_internals._parseVolume('/etc/foo'),        null, 'POSIX path is not a Windows volume identifier');
});
