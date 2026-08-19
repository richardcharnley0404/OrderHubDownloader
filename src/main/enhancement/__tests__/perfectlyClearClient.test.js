'use strict';

/**
 * Unit tests for src/main/enhancement/perfectlyClearClient.js.
 *
 * The client talks to a Perfectly Clear QuickServer via three hot folders
 * (input/output/rejected). Rather than run a real QuickServer instance for
 * CI, we set up three temp dirs and drive them with a `FakeQuickServer`
 * helper that polls the input folder and moves each staged file into
 * either the output or rejected batch subfolder after a short delay —
 * exactly the shape the real product exhibits.
 *
 * Covers, per plan §M2:
 *   - success             — all files land in output
 *   - reject              — all files land in rejected
 *   - timeout             — QuickServer never moves the file
 *   - cancel              — AbortSignal fires mid-batch
 *   - partial batch       — mixed output+rejected
 *   - concurrent batches  — two overlapping processBatch calls on the
 *                           same config do not collide
 *
 * Plus a couple of guard-rail tests:
 *   - stability polling: the client won't consume a file until it has
 *     been stable across 2 consecutive polls
 *   - onFileDone: per-file callback fires exactly once per file with the
 *     terminal status
 *
 * Run via:  npm test
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const fsp    = require('node:fs/promises');
const path   = require('node:path');
const os     = require('node:os');
const Module = require('node:module');

// ── Stub electron-store and logger before loading the client ────────────────
// The client imports config-service (for the `_machineId` key) and logger.
// Neither should touch real electron state during tests.

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');
const ENH  = path.join(REPO, 'src', 'main', 'enhancement');

function stubModule(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubModule(path.join(SVC, 'logger.js'), {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
});

let __config = {};
stubModule(path.join(SVC, 'config-service.js'), {
  get(key) { return __config[key]; },
});

const perfectlyClearClient = require(path.join(ENH, 'perfectlyClearClient.js'));
const { processBatch, _machineTag } = perfectlyClearClient;

// ── Test scaffolding ─────────────────────────────────────────────────────────

const TEST_POLL_MS = 25;   // fast enough that each test finishes in <1 s

/**
 * Build the three folders required for one QuickServer channel and return
 * a config object plus a cleanup helper.
 */
async function makeChannel(label = 'ch') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `ohd-pc-${label}-`));
  const inputFolder    = path.join(root, 'input');
  const outputFolder   = path.join(root, 'output');
  const rejectedFolder = path.join(root, 'rejected');
  await fsp.mkdir(inputFolder,    { recursive: true });
  await fsp.mkdir(outputFolder,   { recursive: true });
  await fsp.mkdir(rejectedFolder, { recursive: true });
  return {
    root,
    config: { friendlyName: `Fake ${label}`, inputFolder, outputFolder, rejectedFolder },
    async cleanup() {
      try { await fsp.rm(root, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

/**
 * Write a small deterministic fake image so tests can byte-compare.
 * Extension is preserved so the client stages the file under the same
 * basename in the batch subfolder.
 */
async function makeSourceFile(basename, contents) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-src-'));
  const p   = path.join(dir, basename);
  await fsp.writeFile(p, Buffer.from(contents, 'utf8'));
  return p;
}

/**
 * Ephemeral fake QuickServer.
 *
 *   decide(name) => 'output' | 'rejected' | 'skip'
 *
 * On each tick it enumerates all subfolders under `inputFolder`, and for
 * every non-`.tmp_*` file inside them, moves it (via copy+unlink so that
 * mtime changes and the stability check is exercised) into the mirrored
 * subfolder of either output or rejected. Files with decision === 'skip'
 * are left in place — used by the timeout test.
 *
 * The `delay` option (ms) forces at least this many ms to elapse from
 * observation to move; keeps the mover from beating the client's very
 * first poll and lets us exercise stability.
 */
function startFakeQuickServer(config, decide, opts = {}) {
  const delay = opts.delay || 0;
  const seenAt = new Map();  // absolute-path → firstSeenAt
  let stopped = false;

  async function tick() {
    let subDirs = [];
    try { subDirs = await fsp.readdir(config.inputFolder); } catch (_) { return; }
    for (const sub of subDirs) {
      const subInputDir = path.join(config.inputFolder, sub);
      let stat;
      try { stat = await fsp.stat(subInputDir); } catch (_) { continue; }
      if (!stat.isDirectory()) continue;

      let files = [];
      try { files = await fsp.readdir(subInputDir); } catch (_) { continue; }
      for (const name of files) {
        // Skip half-copied files staged by the client.
        if (name.includes('.tmp_')) continue;

        const src = path.join(subInputDir, name);
        let fstat;
        try { fstat = await fsp.stat(src); } catch (_) { continue; }
        if (!fstat.isFile()) continue;

        if (!seenAt.has(src)) seenAt.set(src, Date.now());
        if (Date.now() - seenAt.get(src) < delay) continue;

        const decision = decide(name, sub);
        if (decision === 'skip') continue;
        if (decision !== 'output' && decision !== 'rejected') continue;

        const destRoot = decision === 'output' ? config.outputFolder : config.rejectedFolder;
        const destSubDir = path.join(destRoot, sub);
        try {
          await fsp.mkdir(destSubDir, { recursive: true });
          const destPath = path.join(destSubDir, name);
          // Emulate QuickServer producing a *new* file — different bytes
          // let the tests distinguish "enhanced" from "original".
          const buf = await fsp.readFile(src);
          const enhanced = Buffer.concat([Buffer.from('ENHANCED:'), buf]);
          await fsp.writeFile(destPath, enhanced);
          await fsp.unlink(src);
        } catch (_) {
          // If we lost the race with the client's cleanup, silently drop.
        }
      }
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    tick().catch(() => { /* swallow — this is a test helper */ });
  }, 10);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('_machineTag: returns a compact filesystem-safe token', () => {
  __config = { _machineId: '12345678-abcd-4000-9000-abcdef012345' };
  const tag = _machineTag();
  assert.match(tag, /^[A-Za-z0-9]+$/);
  assert.ok(tag.length > 0 && tag.length <= 12, `expected 1..12 chars, got "${tag}" (${tag.length})`);
});

test('success: every file is copied to destPath with QuickServer output bytes', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('success');
  const qs = startFakeQuickServer(ch.config, () => 'output');
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));

  try {
    const src1 = await makeSourceFile('a.jpg', 'original-a');
    const src2 = await makeSourceFile('b.jpg', 'original-b');
    const dst1 = path.join(destDir, 'a.jpg');
    const dst2 = path.join(destDir, 'b.jpg');

    const results = await processBatch({
      config:         ch.config,
      files:          [{ sourcePath: src1, destPath: dst1 }, { sourcePath: src2, destPath: dst2 }],
      timeoutMs:      5000,
      pollIntervalMs: TEST_POLL_MS,
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'enhanced');
    assert.equal(results[1].status, 'enhanced');

    const a = await fsp.readFile(dst1, 'utf8');
    const b = await fsp.readFile(dst2, 'utf8');
    assert.equal(a, 'ENHANCED:original-a');
    assert.equal(b, 'ENHANCED:original-b');

    // Cleanup ran — the batch subfolders should be gone from all three roots.
    const inputSubs    = await fsp.readdir(ch.config.inputFolder);
    const outputSubs   = await fsp.readdir(ch.config.outputFolder);
    const rejectedSubs = await fsp.readdir(ch.config.rejectedFolder);
    assert.deepEqual(inputSubs,    []);
    assert.deepEqual(outputSubs,   []);
    assert.deepEqual(rejectedSubs, []);
  } finally {
    qs.stop();
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

test('reject: files land in the Rejected folder → status "rejected", destPath untouched', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('reject');
  const qs = startFakeQuickServer(ch.config, () => 'rejected');
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));

  try {
    const src = await makeSourceFile('corrupt.jpg', 'corrupt-bytes');
    const dst = path.join(destDir, 'corrupt.jpg');

    const results = await processBatch({
      config:         ch.config,
      files:          [{ sourcePath: src, destPath: dst }],
      timeoutMs:      5000,
      pollIntervalMs: TEST_POLL_MS,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'rejected');
    // destPath should not exist because the file was rejected.
    assert.equal(fs.existsSync(dst), false);
  } finally {
    qs.stop();
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

test('timeout: file that never appears in output or rejected → status "timeout"', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('timeout');
  // No fake mover — the file just sits in the input folder forever.
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));

  try {
    const src = await makeSourceFile('lost.jpg', 'lost-bytes');
    const dst = path.join(destDir, 'lost.jpg');

    const t0 = Date.now();
    const results = await processBatch({
      config:         ch.config,
      files:          [{ sourcePath: src, destPath: dst }],
      timeoutMs:      200,
      pollIntervalMs: TEST_POLL_MS,
    });
    const elapsed = Date.now() - t0;

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'timeout');
    assert.equal(fs.existsSync(dst), false);
    // We should have honoured the timeout roughly. Allow a wide upper bound
    // for slow CI. The point is: we didn't wait forever.
    assert.ok(elapsed >= 200 && elapsed < 3000, `expected 200..3000 ms, got ${elapsed}`);
  } finally {
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

test('cancel: AbortSignal fires mid-batch → remaining files marked "cancelled"', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('cancel');
  // Mover just sits idle so every file remains pending; we abort while
  // they're still pending.
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));

  try {
    const src1 = await makeSourceFile('c1.jpg', 'c1');
    const src2 = await makeSourceFile('c2.jpg', 'c2');
    const dst1 = path.join(destDir, 'c1.jpg');
    const dst2 = path.join(destDir, 'c2.jpg');

    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 80);

    const results = await processBatch({
      config:         ch.config,
      files:          [{ sourcePath: src1, destPath: dst1 }, { sourcePath: src2, destPath: dst2 }],
      timeoutMs:      10_000,   // long — we should never hit this
      pollIntervalMs: TEST_POLL_MS,
      signal:         ctl.signal,
    });

    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.status, 'cancelled');
    }
    assert.equal(fs.existsSync(dst1), false);
    assert.equal(fs.existsSync(dst2), false);
  } finally {
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

test('partial batch: mixed output + rejected results, onFileDone fires once per file', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('partial');
  // Decide by filename prefix: files starting with 'r' go to rejected.
  const qs = startFakeQuickServer(ch.config, (name) => (name.startsWith('r') ? 'rejected' : 'output'));
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));

  try {
    const files = [];
    const expected = new Map();
    for (const name of ['ok1.jpg', 'r_bad.jpg', 'ok2.jpg', 'r_empty.jpg']) {
      const src = await makeSourceFile(name, `data-${name}`);
      const dst = path.join(destDir, name);
      files.push({ sourcePath: src, destPath: dst });
      expected.set(src, name.startsWith('r') ? 'rejected' : 'enhanced');
    }

    const callbackCalls = [];
    const results = await processBatch({
      config:         ch.config,
      files,
      timeoutMs:      5000,
      pollIntervalMs: TEST_POLL_MS,
      onFileDone:     (evt) => callbackCalls.push(evt),
    });

    assert.equal(results.length, 4);
    for (const r of results) {
      assert.equal(r.status, expected.get(r.sourcePath),
        `${path.basename(r.sourcePath)} expected ${expected.get(r.sourcePath)}, got ${r.status}`);
    }

    // Callback: exactly one per source, statuses match final results.
    assert.equal(callbackCalls.length, 4);
    const seen = new Set();
    for (const evt of callbackCalls) {
      assert.ok(!seen.has(evt.sourcePath), `onFileDone fired twice for ${evt.sourcePath}`);
      seen.add(evt.sourcePath);
      assert.equal(evt.status, expected.get(evt.sourcePath));
    }
  } finally {
    qs.stop();
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

test('concurrent batches on the same config do not collide', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('concurrent');
  const qs = startFakeQuickServer(ch.config, () => 'output');
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));

  try {
    // Two overlapping batches, each with a couple of files. Same-named
    // files across batches are legal because batch subfolders differ.
    const batchA = [
      { sourcePath: await makeSourceFile('shared.jpg', 'A-shared'), destPath: path.join(destDir, 'A-shared.jpg') },
      { sourcePath: await makeSourceFile('a-only.jpg', 'A-only'),   destPath: path.join(destDir, 'A-only.jpg')   },
    ];
    const batchB = [
      { sourcePath: await makeSourceFile('shared.jpg', 'B-shared'), destPath: path.join(destDir, 'B-shared.jpg') },
      { sourcePath: await makeSourceFile('b-only.jpg', 'B-only'),   destPath: path.join(destDir, 'B-only.jpg')   },
    ];

    const [resA, resB] = await Promise.all([
      processBatch({ config: ch.config, files: batchA, timeoutMs: 5000, pollIntervalMs: TEST_POLL_MS }),
      processBatch({ config: ch.config, files: batchB, timeoutMs: 5000, pollIntervalMs: TEST_POLL_MS }),
    ]);

    for (const r of [...resA, ...resB]) assert.equal(r.status, 'enhanced');

    // The two "shared.jpg" sources landed at distinct destPaths carrying
    // their own original bytes, proving the batches did not cross-wire.
    assert.equal(await fsp.readFile(path.join(destDir, 'A-shared.jpg'), 'utf8'), 'ENHANCED:A-shared');
    assert.equal(await fsp.readFile(path.join(destDir, 'B-shared.jpg'), 'utf8'), 'ENHANCED:B-shared');
    assert.equal(await fsp.readFile(path.join(destDir, 'A-only.jpg'),   'utf8'), 'ENHANCED:A-only');
    assert.equal(await fsp.readFile(path.join(destDir, 'B-only.jpg'),   'utf8'), 'ENHANCED:B-only');

    // No lingering batch subfolders anywhere.
    assert.deepEqual(await fsp.readdir(ch.config.inputFolder),    []);
    assert.deepEqual(await fsp.readdir(ch.config.outputFolder),   []);
    assert.deepEqual(await fsp.readdir(ch.config.rejectedFolder), []);
  } finally {
    qs.stop();
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

test('duplicate input basenames in one batch → processBatch throws before doing any work', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('dupes');
  try {
    const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dupA-'));
    const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dupB-'));
    const src1 = path.join(dirA, 'same.jpg');
    const src2 = path.join(dirB, 'same.jpg');
    await fsp.writeFile(src1, 'aaa');
    await fsp.writeFile(src2, 'bbb');
    await assert.rejects(
      () => processBatch({
        config:         ch.config,
        files:          [{ sourcePath: src1, destPath: '/tmp/x1.jpg' }, { sourcePath: src2, destPath: '/tmp/x2.jpg' }],
        timeoutMs:      1000,
        pollIntervalMs: TEST_POLL_MS,
      }),
      /duplicate input filename/i,
    );
    await fsp.rm(dirA, { recursive: true, force: true });
    await fsp.rm(dirB, { recursive: true, force: true });
  } finally {
    await ch.cleanup();
  }
});

test('stability polling: consumer waits until a file is stable across 2 polls', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('stability');
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));

  // We bypass the FakeQuickServer helper and manually write the output
  // file so we can control the exact write pattern.
  //
  // ── Why THIS test uses widened timing (2026-08-19 flake fix) ────────
  // The original test ran at pollIntervalMs = TEST_POLL_MS (25 ms) with
  // a 30 ms rewrite delay. That put the rewrite ~5 ms AFTER the second
  // poll's expected firing time, so ANY scheduler jitter that ran
  // poll-2 before the rewrite left the client seeing v1 twice in a row
  // — stable — and consuming v1 instead of v2-longer. The failure
  // reproduced ~1-in-4 by 2026-08-13 and ~1-in-6 by 2026-08-19 (see
  // docs/BACKLOG.md :48).
  //
  // The invariant this test proves has NOT changed: the client must not
  // consume a file whose signature was different at the previous poll.
  // What changed is the timing so that the intended sequence
  //   poll N   : sees v1        (records size=2, mtime=t1)
  //   poll N+1 : sees v2-longer (differs — records size=9, mtime=t2)
  //   poll N+2 : sees v2-longer (matches — CONSUME v2-longer)
  // is race-free.
  //
  // Guarantee: with STABILITY_POLL_MS = 120 ms and REWRITE_DELAY_MS =
  // 60 ms, ANY poll-1 at time p1 has poll-2 at ≥ p1 + 120 ms, so if
  // poll-1 saw v1 (before the rewrite at t_write + 60), poll-2 fires
  // at ≥ t_write + 60 + 60 = t_write + 120 and therefore AFTER the
  // rewrite — it observes v2-longer, the signatures differ, no
  // consumption. If poll-1 fires AFTER the rewrite (poll-1 at t >
  // t_write + 60), it observes v2-longer directly and the test still
  // passes trivially (final content = v2-longer).
  //
  // Clock injection was considered per the fix brief. The stability
  // check does not consult a clock — it compares fs.stat's mtime/size
  // across two poll cycles — so injecting a clock would leave this
  // race untouched. A scheduler injection would work but is a much
  // larger API change to production code for a test-only benefit;
  // widening the timing meets the same bar cheaper.
  const STABILITY_POLL_MS  = 120;
  const REWRITE_DELAY_MS   = 60;

  try {
    const src = await makeSourceFile('slow.jpg', 'slow');
    const dst = path.join(destDir, 'slow.jpg');

    // Launch the batch first; it will stage input then start polling.
    const running = processBatch({
      config:         ch.config,
      files:          [{ sourcePath: src, destPath: dst }],
      timeoutMs:      5000,
      pollIntervalMs: STABILITY_POLL_MS,
    });

    // Find the batch subfolder that the client created under input, and
    // mirror it under output so we can drop the file in.
    async function findBatchSub() {
      for (let i = 0; i < 200; i++) {
        const subs = await fsp.readdir(ch.config.inputFolder).catch(() => []);
        if (subs.length > 0) return subs[0];
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error('client never created a batch subfolder');
    }
    const batchSub = await findBatchSub();
    const outSubDir = path.join(ch.config.outputFolder, batchSub);
    await fsp.mkdir(outSubDir, { recursive: true });
    const outPath = path.join(outSubDir, 'slow.jpg');

    // Write once, then rewrite with different content after
    // REWRITE_DELAY_MS. The second write changes size+mtime, so the
    // first stat is invalidated and the file needs another poll to
    // stabilise. Total: 3+ polls before consumption.
    await fsp.writeFile(outPath, 'v1');
    await new Promise(r => setTimeout(r, REWRITE_DELAY_MS));
    await fsp.writeFile(outPath, 'v2-longer');

    const [result] = await running;
    assert.equal(result.status, 'enhanced');
    // The bytes we ended up with are the final version, not the intermediate.
    assert.equal(await fsp.readFile(dst, 'utf8'), 'v2-longer');
  } finally {
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

// ─── Hard-deadline contract (2026-07-23) ────────────────────────────────────
//
// Guarantees processBatch cannot hang indefinitely even when the QuickServer
// hot folder lives on a dead SMB share. Two mechanisms working together:
//   1. Per-op deadline (perOpTimeoutMs) around every fs op (readdir, stat,
//      copyFile, rename, unlink). A single stuck syscall can't consume
//      the whole remaining wall clock.
//   2. Wall-clock deadline (timeoutMs) — enforced not just between polls
//      but around each pollOnce() invocation, so any residual work in the
//      poll loop can't carry the batch past the deadline.

const { _withDeadline, DeadlineError, DEFAULT_PER_OP_TIMEOUT_MS } = perfectlyClearClient;

test('_withDeadline: resolves the wrapped promise when it settles in time', async () => {
  const v = await _withDeadline(Promise.resolve(42), 500, 'fast');
  assert.equal(v, 42);
});

test('_withDeadline: rejects with DeadlineError when the promise never settles', async () => {
  const forever = new Promise(() => {});
  await assert.rejects(
    () => _withDeadline(forever, 25, 'never'),
    (err) => err instanceof DeadlineError && err.op === 'never' && err.timeout === 25,
  );
});

test('_withDeadline: propagates the underlying rejection unchanged when the promise fails fast', async () => {
  const boom = Promise.reject(new Error('boom'));
  await assert.rejects(() => _withDeadline(boom, 500, 'op'), /boom/);
});

test('_withDeadline: ms <= 0 disables the deadline (returns the raw promise)', async () => {
  // Confirmed via a non-primitive proof: a slow-but-not-forever promise
  // resolves normally, and the DeadlineError is never surfaced.
  const slow = new Promise((r) => setTimeout(() => r('done'), 40));
  const v = await _withDeadline(slow, 0, 'disabled');
  assert.equal(v, 'done');
});

test('DEFAULT_PER_OP_TIMEOUT_MS is exposed and finite (contract lock)', () => {
  assert.ok(Number.isFinite(DEFAULT_PER_OP_TIMEOUT_MS));
  assert.ok(DEFAULT_PER_OP_TIMEOUT_MS > 0);
});

test('hard wall-clock deadline: batch resolves within timeoutMs even with aggressive per-op cap starving observations', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('hardclock');
  // No fake mover — QuickServer "never responds". With perOpTimeoutMs:1
  // every fs.readdir / fs.stat inside pollOnce deadline-fires (indistinguishable
  // from an empty folder), so the batch has zero observation opportunities
  // and must ride the wall clock to termination.
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));
  try {
    const src = await makeSourceFile('stuck.jpg', 'stuck-bytes');
    const dst = path.join(destDir, 'stuck.jpg');

    const t0 = Date.now();
    const results = await processBatch({
      config:         ch.config,
      files:          [{ sourcePath: src, destPath: dst }],
      timeoutMs:      300,
      perOpTimeoutMs: 1,
      pollIntervalMs: TEST_POLL_MS,
    });
    const elapsed = Date.now() - t0;

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'timeout',
      'unaccounted file resolves as "timeout" — never leaves the batch pending');
    // The batch MUST have resolved close to the wall-clock deadline. Slack
    // covers the input-staging copyFile (which itself has a per-op deadline
    // of 1 ms but the file is tiny + local so it still lands fast), plus
    // finally-block cleanup and the last poll-loop iteration. Ceiling is
    // generous but still MUCH tighter than what a hung SMB share would
    // produce without the deadline.
    assert.ok(elapsed < 3000, `batch must resolve near timeoutMs; took ${elapsed}ms`);
    assert.equal(fs.existsSync(dst), false, 'destPath left untouched on timeout');
  } finally {
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

test('per-op deadline on input staging: staging copyFile deadline surfaces as a client-level throw (not a wedge)', async () => {
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('stagedead');
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));

  try {
    // Point at a nonexistent source so copyFile fails fast. This exercises
    // the input-staging catch path with per-op deadlines active; the batch
    // must throw (per contract — no records reported yet) rather than hang.
    // A hung readdir / copyFile on a dead SMB is the field scenario; the
    // synthetic ENOENT here proves the error path itself isn't gated by
    // the wall clock.
    const src = path.join(destDir, 'does-not-exist.jpg');
    const dst = path.join(destDir, 'landing.jpg');

    const t0 = Date.now();
    await assert.rejects(
      () => processBatch({
        config:         ch.config,
        files:          [{ sourcePath: src, destPath: dst }],
        timeoutMs:      10_000,
        perOpTimeoutMs: 50,
        pollIntervalMs: TEST_POLL_MS,
      }),
      /ENOENT|no such file|failed/i,
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `staging error must surface fast, not ride the wall clock; took ${elapsed}ms`);
  } finally {
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});

test('copy-back stray temp cleanup: no ".tmp_<pid>_<rand>" files left in the destination folder when the batch succeeds normally', async () => {
  // Regression lock. The _copyViaTemp cleanup path (unlink of the temp
  // file on any failure — deadline, rename error, copy error) is invisible
  // on the happy path but must not accidentally start leaving temp files
  // behind either. Assert the destination has ONLY the expected output
  // after a successful batch.
  __config = { _machineId: 'test-machine' };
  const ch = await makeChannel('nolitter');
  const qs = startFakeQuickServer(ch.config, () => 'output');
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-dst-'));
  try {
    const src = await makeSourceFile('clean.jpg', 'clean-bytes');
    const dst = path.join(destDir, 'clean.jpg');

    const results = await processBatch({
      config:         ch.config,
      files:          [{ sourcePath: src, destPath: dst }],
      timeoutMs:      5000,
      pollIntervalMs: TEST_POLL_MS,
    });
    assert.equal(results[0].status, 'enhanced');

    const leftInDest = await fsp.readdir(destDir);
    const strayTemps = leftInDest.filter((n) => n.includes('.tmp_'));
    assert.deepEqual(strayTemps, [],
      `destination MUST NOT contain stray temp files; saw: ${JSON.stringify(leftInDest)}`);
  } finally {
    qs.stop();
    await ch.cleanup();
    await fsp.rm(destDir, { recursive: true, force: true });
  }
});
