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
  //      sibling appears there. Save-time validation (isSameVolume,
  //      M7c) is the primary defence; this dispatch-time throw is the
  //      belt-and-braces for a pre-M7b controller that was never
  //      re-saved after the fix landed, and for exotic setups (subst,
  //      DFS, reparse points) that a string-only check can't reason
  //      about.
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
// behind. Save-time co-location enforcement (isSameVolume, M7c) plus
// the dispatch-time EXDEV throw above replace both. See M7b commit
// for the customer incident that removed the slow path.

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
// M7c — isSameVolume (save-time co-location check, string compare only)
// ═════════════════════════════════════════════════════════════════════════
//
// M7c replaced M7b's rename-probe with a pure string comparison of volume
// roots. The probe was the exact class of bug M7b existed to remove: it
// wrote `.ohd-volume-probe-*` INSIDE diginPath on every save of a
// correctly-configured controller. See the docstring on isSameVolume for
// the full rationale. Tests below cover the string-comparison rules the
// docstring specifies. NO fs I/O — that's the invariant these tests exist
// to protect.
//
// The dispatch-side EXDEV throw in deliverToDigin (see the M7b test near
// line 380) is the second line of defence for exotic setups the string
// compare can't reason about (subst, DFS, junctions). It stays unchanged.

test('M7c isSameVolume: same drive letter (different subpaths) is ok', () => {
  assert.deepEqual(isSameVolume('C:\\Fuji\\staging', 'C:\\Fuji\\DIGIN'), { ok: true });
});

test('M7c isSameVolume: different drive letters is cross-volume', () => {
  assert.deepEqual(
    isSameVolume('C:\\Fuji\\staging', 'D:\\Fuji\\DIGIN'),
    { ok: false, code: 'cross-volume' },
  );
});

test('M7c isSameVolume: same UNC share (different subpaths) is ok', () => {
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin\\staging', '\\\\labserver\\digin\\ORD-1'),
    { ok: true },
  );
});

test('M7c isSameVolume: same server but different share is cross-volume', () => {
  assert.deepEqual(
    isSameVolume('\\\\labserver\\staging\\x', '\\\\labserver\\digin\\y'),
    { ok: false, code: 'cross-volume' },
  );
});

test('M7c isSameVolume: different servers with the same share name is cross-volume', () => {
  // Two hosts happening to expose a share called `digin` are still two
  // separate volumes — the host is part of the volume identity.
  assert.deepEqual(
    isSameVolume('\\\\hostA\\digin\\x', '\\\\hostB\\digin\\y'),
    { ok: false, code: 'cross-volume' },
  );
});

test('M7c isSameVolume: local vs UNC is cross-volume (mismatched shapes)', () => {
  assert.deepEqual(
    isSameVolume('C:\\Fuji\\staging', '\\\\labserver\\digin\\ORD-1'),
    { ok: false, code: 'cross-volume' },
  );
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin\\ORD-1', 'C:\\Fuji\\staging'),
    { ok: false, code: 'cross-volume' },
  );
});

test('M7c isSameVolume: trailing slashes and mixed separators are normalised', () => {
  // Local: trailing backslash, trailing forward slash, and no trailing
  // separator all resolve to the same drive root.
  assert.deepEqual(isSameVolume('C:\\Fuji\\', 'C:/Fuji'),      { ok: true });
  assert.deepEqual(isSameVolume('C:',        'C:\\'),          { ok: true });
  // UNC: forward slashes and trailing slashes must not perturb the
  // `\\host\share` extraction.
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin\\', '//labserver/digin/ORD-1'),
    { ok: true },
  );
});

test('M7c isSameVolume: case differences do not matter (Windows semantics)', () => {
  assert.deepEqual(isSameVolume('c:\\fuji', 'C:\\FUJI'), { ok: true });
  assert.deepEqual(
    isSameVolume('\\\\LabServer\\DiGiN', '\\\\labserver\\digin\\sub'),
    { ok: true },
  );
});

test('M7c isSameVolume: bare `\\\\server\\share` with no subpath is a valid volume root', () => {
  // Docstring rule: `\\server\share` on its own IS the volume root.
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin', '\\\\labserver\\digin\\ORD-1'),
    { ok: true },
  );
  assert.deepEqual(
    isSameVolume('\\\\labserver\\digin\\', '\\\\labserver\\digin'),
    { ok: true },
  );
});

test('M7c isSameVolume: unrecognisable shape returns ok (defer to dispatch EXDEV guard)', () => {
  // Bias-to-accept: a shape the string compare can't parse must NOT
  // reject the save — the dispatch-time EXDEV throw is the authority
  // for exotic paths. See the docstring "does not have to be
  // authoritative" note. Bare `\\host` with no share is an example.
  assert.deepEqual(isSameVolume('\\\\lonely-host', 'C:\\Fuji'), { ok: true });
  assert.deepEqual(isSameVolume('',    'C:\\Fuji'),              { ok: true });
  assert.deepEqual(isSameVolume(null,  'C:\\Fuji'),              { ok: true });
  assert.deepEqual(isSameVolume('C:\\Fuji', undefined),          { ok: true });
});

test('M7c isSameVolume: does not touch the filesystem (paths need not exist)', () => {
  // Pointing at paths that definitely do not exist must still return a
  // synchronous result without throwing — proves the check is a pure
  // string compare, not an fs probe. This is the invariant that M7c
  // exists to protect; if this test ever fails because someone added
  // an fs call, that is the regression to catch.
  const result = isSameVolume(
    'C:\\definitely-not-a-real-path-1234',
    'C:\\also-not-real-5678\\deeper',
  );
  assert.deepEqual(result, { ok: true });
});

test('M7c _volumeRoot: extracts drive letter, lowercased, no trailing sep', () => {
  assert.equal(_internals._volumeRoot('C:\\Fuji\\DIGIN'), 'c:');
  assert.equal(_internals._volumeRoot('D:'),               'd:');
  assert.equal(_internals._volumeRoot('E:/x/y/'),          'e:');
});

test('M7c _volumeRoot: extracts UNC \\\\host\\share, lowercased', () => {
  assert.equal(_internals._volumeRoot('\\\\LabServer\\DIGIN\\sub'), '\\\\labserver\\digin');
  assert.equal(_internals._volumeRoot('\\\\host\\share'),           '\\\\host\\share');
  assert.equal(_internals._volumeRoot('//host/share/sub'),          '\\\\host\\share');
});

test('M7c _volumeRoot: returns null for shapes it does not confidently recognise', () => {
  assert.equal(_internals._volumeRoot(''),                null);
  assert.equal(_internals._volumeRoot(null),              null);
  assert.equal(_internals._volumeRoot(undefined),         null);
  assert.equal(_internals._volumeRoot('\\\\lonely-host'), null, 'bare host with no share is not a volume root');
  assert.equal(_internals._volumeRoot('relative\\path'),  null);
  assert.equal(_internals._volumeRoot('/etc/foo'),        null, 'POSIX path is not a Windows volume root');
});
