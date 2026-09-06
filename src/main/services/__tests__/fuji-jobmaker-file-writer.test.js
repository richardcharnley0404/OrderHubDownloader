/**
 * Unit tests for src/main/services/fuji-jobmaker-file-writer.js.
 *
 * Exercises the staging + write flow against a real tmpfs directory — fast
 * enough to keep with the rest of the synchronous test suite.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { FujiJobMakerFileWriter } = require('../fuji-jobmaker-file-writer');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fresh per-test sandbox with hot/staging/source subfolders. */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fuji-writer-'));
  const hot = path.join(root, 'hotFolder');
  const stage = path.join(root, 'staging');
  const src = path.join(root, 'source');
  for (const dir of [hot, stage, src]) fs.mkdirSync(dir, { recursive: true });
  return { root, hot, stage, src };
}

/** Write a tiny binary "image" we can verify by content after the copy. */
function makeSourceImage(srcDir, filename, bytes) {
  const filePath = path.join(srcDir, filename);
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return { sourcePath: filePath, filename };
}

function makeSurfaceFile(filename, contents) {
  return { filename, contents };
}

// ── 1. Happy path ────────────────────────────────────────────────────────────

test('stages images into {imageStagingRoot}/{orderRef}/ and writes .txt to hot folder', async () => {
  const { hot, stage, src } = makeSandbox();

  const img1 = makeSourceImage(src, 'L1.jpg', [0xff, 0xd8, 0xff, 0xe0]);
  const img2 = makeSourceImage(src, 'L2.jpg', [0xff, 0xd8, 0xff, 0xe1]);

  const writer = new FujiJobMakerFileWriter();
  const result = await writer.writeOrderFiles({
    hotFolderPath: hot,
    imageStagingRoot: stage,
    orderRef: 'BALLY-Q7F39E',
    imageFiles: [img1, img2],
    surfaceFiles: [makeSurfaceFile('BALLY-Q7F39E_Lustre.txt', '[OrderInfo]\r\nOrder_ID=L-BALLY-Q7F39E\r\n')],
  });

  const expectedStaging = path.join(stage, 'BALLY-Q7F39E');
  assert.equal(result.imageStagingFolder, expectedStaging);
  assert.ok(fs.existsSync(expectedStaging), 'staging folder created');

  // Images copied with identical content.
  assert.deepEqual(
    fs.readFileSync(path.join(expectedStaging, 'L1.jpg')),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  );
  assert.deepEqual(
    fs.readFileSync(path.join(expectedStaging, 'L2.jpg')),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1])
  );

  // .txt written to hot folder root.
  const txtPath = path.join(hot, 'BALLY-Q7F39E_Lustre.txt');
  assert.equal(result.writtenFiles[0], txtPath);
  assert.match(fs.readFileSync(txtPath, 'utf-8'), /Order_ID=L-BALLY-Q7F39E/);

  // No .tmp leftovers.
  assert.equal(fs.readdirSync(hot).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('multi-surface order writes one .txt per surface, sharing one staging folder', async () => {
  const { hot, stage, src } = makeSandbox();

  const front1 = makeSourceImage(src, 'a.jpg', [1]);
  const front2 = makeSourceImage(src, 'b.jpg', [2]);

  const writer = new FujiJobMakerFileWriter();
  const result = await writer.writeOrderFiles({
    hotFolderPath: hot,
    imageStagingRoot: stage,
    orderRef: 'MULTI-1',
    imageFiles: [front1, front2],
    surfaceFiles: [
      makeSurfaceFile('MULTI-1_Lustre.txt', '[OrderInfo]\r\nOrder_ID=L-MULTI-1\r\n'),
      makeSurfaceFile('MULTI-1_Glossy.txt', '[OrderInfo]\r\nOrder_ID=G-MULTI-1\r\n'),
    ],
  });

  // Two .txt files in hot folder root.
  const txts = fs.readdirSync(hot).filter((f) => f.endsWith('.txt')).sort();
  assert.deepEqual(txts, ['MULTI-1_Glossy.txt', 'MULTI-1_Lustre.txt']);

  // Single staging folder shared across surfaces (no per-surface subfolder).
  const stagedOrders = fs.readdirSync(stage);
  assert.deepEqual(stagedOrders, ['MULTI-1']);

  // Both images present in the single staging folder.
  const stagedImages = fs.readdirSync(path.join(stage, 'MULTI-1')).sort();
  assert.deepEqual(stagedImages, ['a.jpg', 'b.jpg']);

  assert.equal(result.writtenFiles.length, 2);
  assert.equal(result.copiedImages.length, 2);
});

// ── 2. Deduplication ─────────────────────────────────────────────────────────

test('imageFiles entries sharing a target filename are copied once', async () => {
  const { hot, stage, src } = makeSandbox();

  // Same target filename, same source — common when a back-print image is
  // referenced by multiple front images.
  const shared = makeSourceImage(src, 'shared-back.jpg', [9]);
  const front = makeSourceImage(src, 'front.jpg', [1]);

  const writer = new FujiJobMakerFileWriter();
  const result = await writer.writeOrderFiles({
    hotFolderPath: hot,
    imageStagingRoot: stage,
    orderRef: 'DEDUP-1',
    imageFiles: [front, shared, shared, shared],
    surfaceFiles: [makeSurfaceFile('DEDUP-1_Lustre.txt', 'x\r\n')],
  });

  assert.equal(result.copiedImages.length, 2, 'duplicates collapsed');
  const staged = fs.readdirSync(path.join(stage, 'DEDUP-1')).sort();
  assert.deepEqual(staged, ['front.jpg', 'shared-back.jpg']);
});

// ── 3. Atomicity / write order ───────────────────────────────────────────────

test('uses atomic rename (no .tmp file visible after success)', async () => {
  const { hot, stage, src } = makeSandbox();
  const img = makeSourceImage(src, 'a.jpg', [1]);

  const writer = new FujiJobMakerFileWriter();
  await writer.writeOrderFiles({
    hotFolderPath: hot,
    imageStagingRoot: stage,
    orderRef: 'ATOMIC-1',
    imageFiles: [img],
    surfaceFiles: [makeSurfaceFile('ATOMIC-1_Lustre.txt', 'data\r\n')],
  });

  const hotContents = fs.readdirSync(hot);
  assert.deepEqual(hotContents, ['ATOMIC-1_Lustre.txt']);
});

test('images are staged BEFORE any .txt is written', async () => {
  const { hot, stage, src } = makeSandbox();
  const img = makeSourceImage(src, 'a.jpg', [1]);

  // Spy by replacing fs.promises.writeFile with one that asserts the image
  // already exists at the moment the .txt write begins.
  const writer = new FujiJobMakerFileWriter();
  const realWrite = fs.promises.writeFile;
  let imageOnDiskWhenTxtWritten = null;
  fs.promises.writeFile = async (target, ...rest) => {
    if (typeof target === 'string' && target.endsWith('.txt.tmp')) {
      imageOnDiskWhenTxtWritten = fs.existsSync(path.join(stage, 'ORDER-A-Z', 'a.jpg'));
    }
    return realWrite(target, ...rest);
  };

  try {
    await writer.writeOrderFiles({
      hotFolderPath: hot,
      imageStagingRoot: stage,
      orderRef: 'ORDER-A-Z',
      imageFiles: [img],
      surfaceFiles: [makeSurfaceFile('ORDER-A-Z_Lustre.txt', 'data\r\n')],
    });
  } finally {
    fs.promises.writeFile = realWrite;
  }

  assert.equal(imageOnDiskWhenTxtWritten, true, 'image must exist on disk before the .txt write begins');
});

// ── 4. Failure behaviour ─────────────────────────────────────────────────────

test('throws when hot folder is missing (and does not write .txt)', async () => {
  const { stage, src } = makeSandbox();
  const img = makeSourceImage(src, 'a.jpg', [1]);

  const writer = new FujiJobMakerFileWriter();
  await assert.rejects(
    writer.writeOrderFiles({
      hotFolderPath: '/no/such/folder/anywhere',
      imageStagingRoot: stage,
      orderRef: 'MISSING-HF',
      imageFiles: [img],
      surfaceFiles: [makeSurfaceFile('MISSING-HF_Lustre.txt', 'x\r\n')],
    }),
    /hot folder does not exist/i
  );
});

test('throws when source image is missing', async () => {
  const { hot, stage } = makeSandbox();

  const writer = new FujiJobMakerFileWriter();
  await assert.rejects(
    writer.writeOrderFiles({
      hotFolderPath: hot,
      imageStagingRoot: stage,
      orderRef: 'MISSING-IMG',
      imageFiles: [{ sourcePath: '/no/such/file.jpg', filename: 'nope.jpg' }],
      surfaceFiles: [makeSurfaceFile('MISSING-IMG_Lustre.txt', 'x\r\n')],
    }),
    /ENOENT/
  );

  // No .txt written when staging failed.
  assert.equal(fs.readdirSync(hot).length, 0);
});

// ── 5. Input validation ──────────────────────────────────────────────────────

test('rejects missing required args', async () => {
  const { hot, stage } = makeSandbox();
  const writer = new FujiJobMakerFileWriter();
  const base = {
    hotFolderPath: hot,
    imageStagingRoot: stage,
    orderRef: 'X',
    imageFiles: [],
    surfaceFiles: [{ filename: 'X_Lustre.txt', contents: '' }],
  };

  await assert.rejects(() => writer.writeOrderFiles({ ...base, hotFolderPath: '' }),    /hotFolderPath/);
  await assert.rejects(() => writer.writeOrderFiles({ ...base, imageStagingRoot: '' }), /imageStagingRoot/);
  await assert.rejects(() => writer.writeOrderFiles({ ...base, orderRef: '' }),         /orderRef/);
  await assert.rejects(() => writer.writeOrderFiles({ ...base, surfaceFiles: [] }),     /surfaceFiles/);
});

test('rejects malformed imageFiles entries', async () => {
  const { hot, stage } = makeSandbox();
  const writer = new FujiJobMakerFileWriter();

  await assert.rejects(
    () => writer.writeOrderFiles({
      hotFolderPath: hot,
      imageStagingRoot: stage,
      orderRef: 'X',
      imageFiles: [{ sourcePath: '/tmp/x.jpg' /* filename missing */ }],
      surfaceFiles: [{ filename: 'X_Lustre.txt', contents: '' }],
    }),
    /imageFiles/
  );
});

// ── 6. Idempotency ───────────────────────────────────────────────────────────

test('overwrites existing staged images and .txt files on re-submit', async () => {
  const { hot, stage, src } = makeSandbox();

  const v1 = makeSourceImage(src, 'a.jpg', [1]);
  const writer = new FujiJobMakerFileWriter();

  // First submission — content "old".
  await writer.writeOrderFiles({
    hotFolderPath: hot,
    imageStagingRoot: stage,
    orderRef: 'RESUB-1',
    imageFiles: [v1],
    surfaceFiles: [makeSurfaceFile('RESUB-1_Lustre.txt', 'old\r\n')],
  });

  // Replace source bytes and re-submit.
  fs.writeFileSync(v1.sourcePath, Buffer.from([2]));
  await writer.writeOrderFiles({
    hotFolderPath: hot,
    imageStagingRoot: stage,
    orderRef: 'RESUB-1',
    imageFiles: [v1],
    surfaceFiles: [makeSurfaceFile('RESUB-1_Lustre.txt', 'new\r\n')],
  });

  assert.deepEqual(
    fs.readFileSync(path.join(stage, 'RESUB-1', 'a.jpg')),
    Buffer.from([2])
  );
  assert.equal(
    fs.readFileSync(path.join(hot, 'RESUB-1_Lustre.txt'), 'utf-8'),
    'new\r\n'
  );
});

// ── 1.16.1 fujiImageRoot dispatch-time reachability check ───────────────────
//
// The check runs BETWEEN stage-images and .txt-write when fujiImageRoot
// differs from imageStagingRoot. Discriminates two outcomes:
//   (a) fujiImageRoot root RESOLVES from OHD's side, order subfolder is
//       MISSING → HARD FAIL, no .txt written, actionable message.
//   (b) fujiImageRoot root does NOT resolve at all → SOFT WARN,
//       dispatch proceeds. OHD may legitimately not see a share the
//       Fuji machine reaches.
//
// The same-machine case (fujiImageRoot === imageStagingRoot) is
// short-circuited by the caller — the check is a no-op there and the
// pre-1.16.1 test set above proves the writer output is unchanged.
// Tests below inject fs so the "root resolves" outcome can be
// produced deterministically without depending on the filesystem
// hosting the tmpdir.

test('1.16.1 reachability: same-machine (fujiImageRoot === imageStagingRoot) — check is a no-op, .txt is written', async () => {
  const { hot, stage, src } = makeSandbox();
  const img = makeSourceImage(src, 'a.jpg', [1]);
  const writer = new FujiJobMakerFileWriter();
  const result = await writer.writeOrderFiles({
    hotFolderPath:    hot,
    imageStagingRoot: stage,
    fujiImageRoot:    stage,   // same value — check skipped
    orderRef:         'SAME-1',
    imageFiles:       [img],
    surfaceFiles:     [makeSurfaceFile('SAME-1_Lustre.txt', 'ok\r\n')],
  });
  assert.equal(result.writtenFiles[0], path.join(hot, 'SAME-1_Lustre.txt'),
    '.txt MUST be written when the two roots match — same-machine setups pass through unchanged');
});

test('1.16.1 reachability: root resolves, order subfolder MISSING → hard fail with actionable message, .txt NOT written', async () => {
  const { hot, stage, src } = makeSandbox();
  const img = makeSourceImage(src, 'a.jpg', [1]);

  // fujiImageRoot: exists as a real folder on disk BUT it is not the
  // same folder as imageStagingRoot, so the order subfolder OHD just
  // staged into imageStagingRoot/orderRef/ does not exist inside
  // fujiImageRoot. This is the real configuration bug the hard-fail
  // is there to catch.
  const differentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fuji-different-root-'));
  const writer = new FujiJobMakerFileWriter();

  let threw = null;
  try {
    await writer.writeOrderFiles({
      hotFolderPath:    hot,
      imageStagingRoot: stage,
      fujiImageRoot:    differentRoot,
      orderRef:         'HARD-FAIL',
      imageFiles:       [img],
      surfaceFiles:     [makeSurfaceFile('HARD-FAIL_Lustre.txt', 'body\r\n')],
    });
  } catch (err) {
    threw = err;
  }

  // Invariant: hard fail.
  assert.ok(threw, 'writeOrderFiles MUST throw when fujiImageRoot resolves but the order subfolder is missing');

  // Invariant: message names the exact paths the operator needs to
  // check and the fix, per the "actionable at first read" convention
  // recorded on _verifyFujiReachability's docstring.
  assert.match(threw.message, /Fuji JobMaker dispatch stopped/,
    'error message MUST start with a clear "dispatch stopped" preface so it stands out in the Activity Log');
  assert.match(threw.message, new RegExp(path.join(stage, 'HARD-FAIL').replace(/[\\/]/g, '\\$&')),
    'error MUST name the imageStagingRoot-side order folder OHD wrote to');
  assert.match(threw.message, new RegExp(path.join(differentRoot, 'HARD-FAIL').replace(/[\\/]/g, '\\$&')),
    'error MUST name the fujiImageRoot-side order folder that does not exist');
  assert.match(threw.message, /fujiImageRoot on the controller/,
    'error MUST reference the specific controller field the operator needs to fix');
  assert.match(threw.message, /same machine.*equal/i,
    'error MUST tell operators that same-machine setups need both values equal — one of the two config shapes we support');

  // Invariant: .txt NOT written. The whole point of failing at
  // dispatch is that Fuji never sees the job — otherwise it would
  // sit unclaimed until Frontier's Failure Timeout fires 30 minutes
  // later.
  assert.equal(
    fs.existsSync(path.join(hot, 'HARD-FAIL_Lustre.txt')),
    false,
    '.txt MUST NOT be written when the reachability check fails hard',
  );
});

test('1.16.1 reachability: fujiImageRoot NOT resolvable from OHD → soft warn, dispatch proceeds', async () => {
  // Simulates the cross-machine case where OHD legitimately cannot
  // see the share the Fuji machine reads from — for example, OHD is
  // on a separate box that has no route to the labserver1 SMB share.
  // Blocking here would kill a working configuration; the writer
  // must warn and let dispatch proceed. Fuji is the authoritative
  // check for the emitted ImagePath value.
  const { hot, stage, src } = makeSandbox();
  const img = makeSourceImage(src, 'a.jpg', [1]);

  // fujiImageRoot: a path guaranteed to not exist on this box. The
  // real production analogue is a UNC share OHD's machine can't
  // reach; here we use a nonexistent local path because it also
  // produces ENOENT on the initial `stat(fujiImageRoot)` call, which
  // is what the "root not resolvable" branch keys on.
  const unreachableRoot = path.join(os.tmpdir(), 'ohd-fuji-not-reachable-' + Date.now());
  // Explicit sanity — DO NOT create this folder.

  const warnLogged = [];
  const injectedLogger = {
    info: () => {}, warn: () => {}, error: () => {},
    logInfo: () => {}, logWarning: (msg) => warnLogged.push(msg), logError: () => {},
  };

  const writer = new FujiJobMakerFileWriter();
  const result = await writer.writeOrderFiles({
    hotFolderPath:    hot,
    imageStagingRoot: stage,
    fujiImageRoot:    unreachableRoot,
    orderRef:         'SOFT-WARN',
    imageFiles:       [img],
    surfaceFiles:     [makeSurfaceFile('SOFT-WARN_Lustre.txt', 'body\r\n')],
    deps:             { logger: injectedLogger },
  });

  // Invariant: dispatch proceeded — .txt was written.
  assert.equal(result.writtenFiles[0], path.join(hot, 'SOFT-WARN_Lustre.txt'),
    '.txt MUST be written when the fujiImageRoot is unreachable — OHD cannot discriminate wrong-path from legitimate-cross-machine, so the safe default is to proceed');

  // Invariant: a warning was logged so a real config bug still leaves
  // a trail in the Activity Log.
  assert.equal(warnLogged.length, 1,
    'writer MUST log exactly one warning when fujiImageRoot is unreachable — a silent proceed would defeat the purpose');
  assert.match(warnLogged[0], /fujiImageRoot not resolvable from OHD/,
    'warning MUST name what could not be resolved');
  assert.match(warnLogged[0], new RegExp(unreachableRoot.replace(/[\\/]/g, '\\$&')),
    'warning MUST name the exact path');
  assert.match(warnLogged[0], /same folder as imageStagingRoot.*expressed as the Fuji JobMaker machine reaches it/,
    'warning MUST tell operators what to check if the order does not print');
});
