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

// ── 1.15.3 N-lite cross-volume delivery (B) ────────────────────────────────
//
// The M7b throw-on-EXDEV tests that used to live here were replaced.
// 1.15.3 supports cross-volume delivery via .ohd-inbox-* → intra-DIGIN
// rename per the N-lite design in
// `docs/picpro-cross-volume-investigation.md`. Tests below lock:
//   1. EXDEV triggers the cross-volume path and the final on-disk
//      state is byte-identical to a same-volume delivery.
//   2. The inbox name discipline — order code never appears in the
//      name, prefix is stable, instance-scoping is present.
//   3. Failure modes leave a partial inbox behind (for the sweep) and
//      leave staging intact (retry-safe).
//   4. controllerId is required to reach the cross-volume path — a
//      missing controllerId is a hard error, not a silent inbox
//      without instance-scoping.

test('1.15.3 deliverToDigin: EXDEV triggers cross-volume delivery — final state byte-identical to same-volume', async (t) => {
  // The whole point of N-lite: after the copy-then-rename completes,
  // DIGIN contains {orderId}/ with the same files that would have
  // ended up there on a same-volume rename. No `.ohd-inbox-*` folder
  // remains — the intra-DIGIN rename cleared it. Staging is cleaned
  // up on success (best-effort).
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-XV'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'xv-1');
  await writeJpeg(path.join(stagingFolder, '0002.jpg'), 'xv-2');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  // Inject rename that throws EXDEV on the staging→DIGIN move, but
  // lets the intra-DIGIN inbox→dest rename succeed. The second rename
  // targets a same-share path so a real rename would work — we let
  // the real fs handle it.
  let renameCall = 0;
  const injected = {
    ...fsp,
    rename: async (src, dst) => {
      renameCall++;
      if (renameCall === 1) {
        const err = new Error('EXDEV cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      }
      return fsp.rename(src, dst);
    },
  };

  const result = await deliverToDigin({
    stagingFolder, diginPath, orderId: 'ORD-XV',
    controllerId: 'ctrl-abc',
    deps: { fsPromises: injected, logger: silentLogger },
  });

  assert.equal(result.method, 'copy-then-rename');
  assert.equal(result.destFolder, path.join(diginPath, 'ORD-XV'));
  assert.ok(result.inboxPath && result.inboxPath.includes('.ohd-inbox-'),
    'inboxPath is returned so the caller can persist it for sweep cross-check');

  // Final DIGIN state matches same-volume outcome exactly.
  const dirents = await fsp.readdir(diginPath);
  assert.deepEqual(dirents, ['ORD-XV'],
    `DIGIN must contain only the final folder; found: ${JSON.stringify(dirents)}`);
  const delivered = await fsp.readdir(path.join(diginPath, 'ORD-XV'));
  assert.deepEqual(delivered.sort(), ['0001.jpg', '0002.jpg']);
  assert.equal(await fsp.readFile(path.join(diginPath, 'ORD-XV', '0001.jpg'), 'utf-8'), 'xv-1');
  assert.equal(await fsp.readFile(path.join(diginPath, 'ORD-XV', '0002.jpg'), 'utf-8'), 'xv-2');

  // Staging cleaned up on success.
  assert.equal(fs.existsSync(stagingFolder), false,
    'staging folder must be removed after successful cross-volume delivery');
});

test('1.15.3 deliverToDigin: cross-volume inbox name never contains the order id', async (t) => {
  // The load-bearing safety property. Injects deterministic clock +
  // rand + instanceId + controllerId and asserts the generated inbox
  // name (a) starts with the well-known prefix, (b) contains the
  // sanitised controllerId, (c) contains the instanceId, (d) does
  // NOT contain the orderId as a substring.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-NAME'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'x');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  let renameCall = 0;
  const injected = {
    ...fsp,
    rename: async (src, dst) => {
      renameCall++;
      if (renameCall === 1) { const err = new Error('EXDEV'); err.code = 'EXDEV'; throw err; }
      return fsp.rename(src, dst);
    },
  };

  const result = await deliverToDigin({
    stagingFolder, diginPath, orderId: 'ORD-NAME',
    controllerId: 'ctrl-lab1',
    deps: {
      fsPromises: injected,
      logger: silentLogger,
      instanceId: '11112222-3333-4444-5555-666677778888',
      clock: () => 1_700_000_000_000,
      rand:  () => 'deadbeef',
    },
  });

  const inboxBase = path.basename(result.inboxPath);
  assert.ok(inboxBase.startsWith('.ohd-inbox-'),
    `inbox must start with the OHD prefix; got ${inboxBase}`);
  // Sanitiser replaces `-` (not in [A-Za-z0-9._]) with `_`, so
  // 'ctrl-lab1' arrives as 'ctrl_lab1'. Checking the sanitised form
  // proves the sanitiser ran AND the controllerId reached the name.
  assert.ok(inboxBase.includes('ctrl_lab1'),
    `inbox must include sanitised controllerId for sweep scoping; got ${inboxBase}`);
  assert.ok(inboxBase.includes('1111222233334444555566667777'),
    `inbox must include instanceId (dashes stripped); got ${inboxBase}`);
  assert.ok(!inboxBase.includes('ORD-NAME'),
    `inbox must NOT contain the order id — safety invariant. got ${inboxBase}`);
});

test('1.15.3 deliverToDigin: substring-trap — controllerId containing orderId triggers hard throw', async (t) => {
  // Defensive: controllerId is normally crypto.randomUUID(), which
  // can't collide with real order ids, but a synthetic id
  // deliberately built to embed the orderId proves the invariant is
  // mechanical: _buildInboxName throws instead of returning a name
  // that would silently expose the order id via the controllerId
  // component. If this test ever starts failing because the check
  // was removed for "brevity", DO NOT remove the check — the whole
  // safety property of the cross-volume path depends on it.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-TRAP'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'x');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const injected = {
    ...fsp,
    rename: async () => { const err = new Error('EXDEV'); err.code = 'EXDEV'; throw err; },
  };

  // Uses alphanumeric-only strings so the sanitiser (which replaces
  // anything outside [A-Za-z0-9._] with `_`) doesn't accidentally
  // defeat the trap — we want the trap to hit the includes() check,
  // not be smuggled away by character replacement. The orderId
  // 'ORD123' survives the sanitiser verbatim inside the
  // controllerId, so the generated name provably contains the order
  // id — and the check must throw.
  await assert.rejects(
    deliverToDigin({
      stagingFolder, diginPath, orderId: 'ORD123',
      controllerId: 'prefix.ORD123.suffix', // synthetic trap; survives sanitiser
      deps: {
        fsPromises: injected,
        logger: silentLogger,
        instanceId: 'x',
        clock: () => 0,
        rand:  () => 'r',
      },
    }),
    /refusing to build inbox name that contains the order id/,
  );
});

test('1.15.3 deliverToDigin: cross-volume path requires controllerId — missing throws', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-NC'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'x');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  const injected = {
    ...fsp,
    rename: async () => { const err = new Error('EXDEV'); err.code = 'EXDEV'; throw err; },
  };

  await assert.rejects(
    deliverToDigin({
      stagingFolder, diginPath, orderId: 'ORD-NC',
      // NO controllerId — the monitor should always provide one, but
      // this test locks the failure mode if it doesn't.
      deps: { fsPromises: injected, logger: silentLogger },
    }),
    /cross-volume delivery requires `controllerId`/,
  );
});

test('1.15.3 deliverToDigin: cross-volume copy failure — partial inbox left, staging preserved for retry', async (t) => {
  // The design says leave the partial inbox for the age-based sweep
  // rather than rm it here (rm on a partial can race a mid-network
  // hiccup). Staging must be intact so the caller can retry with a
  // fresh inbox on the next call.
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-CF'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'a');
  await writeJpeg(path.join(stagingFolder, '0002.jpg'), 'b');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  // rename EXDEVs; the recursive copy proceeds, but we make copyFile
  // fail on the SECOND file (so a partial inbox with 0001 exists).
  let renameCall = 0, copyCall = 0;
  const injected = {
    ...fsp,
    rename: async (src, dst) => {
      renameCall++;
      if (renameCall === 1) { const err = new Error('EXDEV'); err.code = 'EXDEV'; throw err; }
      return fsp.rename(src, dst);
    },
    copyFile: async (src, dst) => {
      copyCall++;
      if (copyCall === 2) {
        const err = new Error('EACCES access denied mid-copy');
        err.code = 'EACCES';
        throw err;
      }
      return fsp.copyFile(src, dst);
    },
  };

  await assert.rejects(
    deliverToDigin({
      stagingFolder, diginPath, orderId: 'ORD-CF',
      controllerId: 'ctrl-cf',
      deps: { fsPromises: injected, logger: silentLogger },
    }),
    /EACCES/,
    'copy failure must propagate untouched — the operator sees the underlying error',
  );

  // Partial inbox left behind for the sweep. Filename is unknown at
  // this level (has a random suffix), so check by prefix.
  const dirents = await fsp.readdir(diginPath);
  const inboxes = dirents.filter(n => n.startsWith('.ohd-inbox-'));
  assert.equal(inboxes.length, 1,
    `exactly one partial inbox must remain in DIGIN for the age-based sweep to clean up; found ${JSON.stringify(dirents)}`);
  // Should have 0001.jpg (succeeded) and NOT 0002.jpg (failed).
  const partial = await fsp.readdir(path.join(diginPath, inboxes[0]));
  assert.deepEqual(partial, ['0001.jpg']);

  // Staging preserved — retry with a fresh inbox is safe.
  assert.ok(fs.existsSync(stagingFolder),
    'staging folder must remain after a copy failure so retry can restart');
  assert.equal(await fsp.readFile(path.join(stagingFolder, '0001.jpg'), 'utf-8'), 'a');
  assert.equal(await fsp.readFile(path.join(stagingFolder, '0002.jpg'), 'utf-8'), 'b');
});

test('1.15.3 deliverToDigin: cross-volume rename failure — inbox left, staging preserved', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const stagingRoot   = path.join(dir, 'staging'); await fsp.mkdir(stagingRoot);
  const stagingFolder = path.join(stagingRoot, 'ORD-RF'); await fsp.mkdir(stagingFolder);
  await writeJpeg(path.join(stagingFolder, '0001.jpg'), 'a');
  const diginPath = path.join(dir, 'digin'); await fsp.mkdir(diginPath);

  // First rename EXDEV, second rename EPERM (the intra-DIGIN one).
  let renameCall = 0;
  const injected = {
    ...fsp,
    rename: async () => {
      renameCall++;
      if (renameCall === 1) { const err = new Error('EXDEV'); err.code = 'EXDEV'; throw err; }
      const err = new Error('EPERM operation not permitted');
      err.code = 'EPERM';
      throw err;
    },
  };

  await assert.rejects(
    deliverToDigin({
      stagingFolder, diginPath, orderId: 'ORD-RF',
      controllerId: 'ctrl-rf',
      deps: { fsPromises: injected, logger: silentLogger },
    }),
    /EPERM/,
  );

  const dirents = await fsp.readdir(diginPath);
  const inboxes = dirents.filter(n => n.startsWith('.ohd-inbox-'));
  assert.equal(inboxes.length, 1, 'inbox left behind for sweep after rename failure');
  assert.ok(fs.existsSync(stagingFolder), 'staging preserved for retry after rename failure');
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
