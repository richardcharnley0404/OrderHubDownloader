/**
 * Unit tests for src/main/jobs/customerRecropActions.js — Customer Originals Phase 2.
 *
 * The brief's locked decisions land here:
 *
 *   - The re-crop produces a /recrops/{base}_{ts}.jpeg audit file AND a
 *     /working/{newBasename}.jpeg active source (Option A from §"Scoring
 *     re-cropped output").
 *   - entry.filename re-points to the new basename so /working/{filename}
 *     readers (sendReprint, _scanJobImages, originalsManager) see the new
 *     pixels through the unchanged code paths.
 *   - Pixel-data-derived fields reset (corrections, enhanced + 4 siblings,
 *     integritySuspect, full aiQuality block including operatorDecision).
 *   - Operator-intent fields persist (qtyOriginal, qtyCurrent, reprint,
 *     reprintJobId, originalFilename).
 *   - Re-re-crop on the same row leaves the prior /recrops/ file untouched
 *     (audit trail) — no pruning.
 *
 * sharp + fs are injected so we never touch real disk or the real encoder.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createCustomerRecropActions,
  _buildRecropFilename,
  _mutateImageEntryForRecrop,
  _resolveOriginalAbs,
} = require('../customerRecropActions.js');

const { createImageEntry, createSidecar } = require('../../../shared/jobSchema.js');

// =============================================================================
// Test helpers
// =============================================================================

const SILENT = { info: () => {}, warn: () => {}, logError: () => {} };

function makeFsStub(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));  // path → bytes (string)
  const dirs  = new Set();
  const calls = { mkdir: [], rename: [], copyFile: [], unlink: [], access: [] };

  return {
    files, dirs, calls,
    fs: {
      async access(p) {
        calls.access.push(p);
        if (!files.has(p)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
      },
      async mkdir(p, opts) {
        calls.mkdir.push({ p, opts });
        dirs.add(p);
      },
      async rename(src, dst) {
        calls.rename.push({ src, dst });
        if (!files.has(src)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        files.set(dst, files.get(src));
        files.delete(src);
      },
      async copyFile(src, dst) {
        calls.copyFile.push({ src, dst });
        if (!files.has(src)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        files.set(dst, files.get(src));
      },
      async unlink(p) {
        calls.unlink.push(p);
        files.delete(p);
      },
    },
  };
}

function makeSharpStub({ shouldThrow = false } = {}) {
  // Models a sharp factory: `sharp(srcPath).extract(...).jpeg(...).toFile(dst)`.
  // Records the call chain so tests can assert quality + extract args.
  const calls = [];
  function factory(srcPath) {
    const ctx = { srcPath, extract: null, jpeg: null };
    const chain = {
      // The defensive bounds-clamp added 2026-05-22 calls .metadata() before
      // .extract() to compute the source dimensions. Returning a generously
      // large pair makes the clamp a no-op for every existing test rect
      // (which are all well under 10000×10000), so test assertions on the
      // pre-clamp rect still hold.
      async metadata() { return { width: 10000, height: 10000 }; },
      extract(rect) { ctx.extract = rect; return chain; },
      jpeg(opts)    { ctx.jpeg    = opts; return chain; },
      async toFile(dst) {
        ctx.toFile = dst;
        calls.push(ctx);
        if (shouldThrow) throw new Error('encode boom');
        // Plant the produced bytes into the fs stub the test wires below.
        if (factory._fs) factory._fs.files.set(dst, '«encoded-jpeg-bytes»');
      },
    };
    return chain;
  }
  factory._fs = null; // injected from the test
  factory.calls = calls;
  return factory;
}

function makeSidecar(entryOverrides = {}) {
  // Build a representative sidecar with one row that has originalFilename set.
  const baseEntry = createImageEntry('PXDEMO-X_42_IMG.jpeg', 3, 'PXDEMO-X_42/original-files/1-IMG.jpg');

  // Populate every pixel-data-derived field with non-default values so the
  // reset has visible work to do.
  const dirty = {
    ...baseEntry,
    qtyCurrent: 7,                                   // operator changed qty
    reprint: true,                                   // operator-intent — must persist
    reprintJobId: 'PXDEMO-X_42-r1',
    corrections: { cyan: 5, magenta: -3, yellow: 0 },
    enhanced: true,
    enhancementSource: 'local',
    enhancedPath: 'C:\\j\\PXDEMO-X\\PXDEMO-X_42\\cache\\PXDEMO-X_42_IMG_enhanced.jpg',
    enhancedAt: '2026-05-15T08:00:00.000Z',
    enhancementModel: 'realesr-general-x4v3',
    integritySuspect: {
      detected: true,
      detectedAt: '2026-05-15T07:50:00.000Z',
      firstBytesHex: 'deadbeef',
      expectedMagic: 'JPEG SOI',
      ftpRemotePath: '/whatever/IMG.jpeg',
    },
    aiQuality: {
      scored: true,
      score: 42,
      thresholdAtScoreTime: 50,
      passed: false,
      modelVersion: 'musiq-spaq-v1.0.0',
      inferenceMs: 712,
      scoredAt: '2026-05-15T07:55:00.000Z',
      error: null,
      fixupHistory: [{ kind: 'auto-enhance', at: '2026-05-15T07:56:00Z', ok: true }],
      operatorDecision: {
        kind: 'approved_as_is',
        decidedAt: '2026-05-15T07:57:00.000Z',
        note: 'looks fine',
      },
    },
    ...entryOverrides,
  };
  return createSidecar('PXDEMO-X_42', [dirty]);
}

// =============================================================================
// Pure helper tests
// =============================================================================

test('_buildRecropFilename: stable, sortable, swaps extension to .jpeg', () => {
  const t = new Date('2026-05-15T14:30:22.000Z');
  // Use a UTC-fixed component to avoid timezone flake — the function uses
  // local-time getters, so just check structural shape rather than literal stamp.
  const name = _buildRecropFilename('1-IMG-20240602-WA0013b.jpg', t);
  assert.match(name, /^1-IMG-20240602-WA0013b_\d{8}-\d{6}\.jpeg$/);
  // Different ms in the same second still produce the same name — that's
  // intentional (operator unlikely to re-crop twice within 1s); test just
  // pins down the second-resolution contract.
  const name2 = _buildRecropFilename('1-IMG-20240602-WA0013b.jpg', new Date(t.getTime() + 500));
  assert.equal(name, name2);
});

test('_resolveOriginalAbs: joins order root (path.dirname(jobPath)) with manifest-relative path', () => {
  const jobPath = path.join('C:', 'OHD', 'PXDEMO-X', 'PXDEMO-X_42');
  const rel = 'PXDEMO-X_42/original-files/1-IMG.jpg';
  const abs = _resolveOriginalAbs(jobPath, rel);
  assert.equal(abs, path.join(path.dirname(jobPath), rel));
});

// =============================================================================
// Sidecar mutation (pure)
// =============================================================================

test('_mutateImageEntryForRecrop: pixel-derived fields RESET, intent fields PERSIST, recrop fields POPULATED', () => {
  const sidecar = makeSidecar();
  const oldFilename = sidecar.images[0].filename;
  const newFilename = 'PXDEMO-X_42_IMG_20260515-143022.jpeg';

  const mutated = _mutateImageEntryForRecrop(sidecar.images, oldFilename, {
    newFilename,
    recropPath: 'C:\\j\\PXDEMO-X\\PXDEMO-X_42\\recrops\\1-IMG_20260515-143022.jpeg',
    recropOf: '1-IMG.jpg',
    recroppedAt: '2026-05-15T14:30:22.000Z',
  });
  const e = mutated[0];

  // ── Re-point filename to the new working copy
  assert.equal(e.filename, newFilename);

  // ── Pixel-data-derived → RESET
  assert.deepEqual(e.corrections, { cyan: 0, magenta: 0, yellow: 0 });
  assert.equal(e.enhanced, false);
  assert.equal(e.enhancementSource, null);
  assert.equal(e.enhancedPath, null);
  assert.equal(e.enhancedAt, null);
  assert.equal(e.enhancementModel, null);
  assert.equal(e.integritySuspect, null);
  // Full aiQuality block back to defaults (including operatorDecision).
  assert.equal(e.aiQuality.scored, false);
  assert.equal(e.aiQuality.score, null);
  assert.equal(e.aiQuality.thresholdAtScoreTime, null);
  assert.equal(e.aiQuality.passed, true);
  assert.equal(e.aiQuality.modelVersion, null);
  assert.equal(e.aiQuality.inferenceMs, null);
  assert.equal(e.aiQuality.scoredAt, null);
  assert.equal(e.aiQuality.error, null);
  assert.deepEqual(e.aiQuality.fixupHistory, []);
  assert.deepEqual(e.aiQuality.operatorDecision, { kind: 'none', decidedAt: null, note: null });

  // ── Operator-intent → PRESERVE
  assert.equal(e.qtyOriginal, 3);
  assert.equal(e.qtyCurrent, 7);
  assert.equal(e.reprint, true);
  assert.equal(e.reprintJobId, 'PXDEMO-X_42-r1');
  assert.equal(e.originalFilename, 'PXDEMO-X_42/original-files/1-IMG.jpg');

  // ── Re-crop bookkeeping → populated
  assert.equal(e.recropPath, 'C:\\j\\PXDEMO-X\\PXDEMO-X_42\\recrops\\1-IMG_20260515-143022.jpeg');
  assert.equal(e.recropOf, '1-IMG.jpg');
  assert.equal(e.recroppedAt, '2026-05-15T14:30:22.000Z');
});

test('_mutateImageEntryForRecrop: rows that do not match the filename are untouched', () => {
  const a = createImageEntry('A.jpeg', 1, 'order/original-files/1-A.jpg');
  const b = createImageEntry('B.jpeg', 1, 'order/original-files/2-B.jpg');
  const images = [a, b];
  const out = _mutateImageEntryForRecrop(images, 'B.jpeg', {
    newFilename: 'B_20260101-000000.jpeg',
    recropPath:  'C:\\recrops\\2-B_20260101-000000.jpeg',
    recropOf:    '2-B.jpg',
    recroppedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(out[0], a, 'untouched row A stays === reference');
  assert.equal(out[1].filename, 'B_20260101-000000.jpeg');
});

// =============================================================================
// recropFromOriginal — end-to-end with injected sharp + fs + saver
// =============================================================================

test('recropFromOriginal: happy path — writes /recrops/, copies to /working/, mutates sidecar', async () => {
  const jobPath = path.join('C:', 'OHD', 'PXDEMO-X', 'PXDEMO-X_42');
  const originalAbs = path.join(path.dirname(jobPath), 'PXDEMO-X_42/original-files/1-IMG.jpg');

  const { fs, files, calls } = makeFsStub({ [originalAbs]: '«original-bytes»' });
  const sharp = makeSharpStub();
  sharp._fs = { files }; // plant encoded bytes into the same in-memory fs

  let savedArg = null;
  const saveSidecar = async (s, jp) => { savedArg = { sidecar: s, jobPath: jp }; return s; };

  const fixedNow = new Date('2026-05-15T14:30:22.000Z');
  const actions = createCustomerRecropActions({
    sharp, fs, saveSidecar, logger: SILENT, now: () => fixedNow,
  });

  const sidecar = makeSidecar();
  const result = await actions.recropFromOriginal({
    jobPath,
    sidecar,
    filename: sidecar.images[0].filename,
    cropRect: { x: 10, y: 20, w: 800, h: 600 },
  });

  assert.equal(result.success, true, result.error);
  // /recrops/ path matches the brief pattern.
  assert.match(result.recropPath, /[\\/]recrops[\\/]1-IMG_\d{8}-\d{6}\.jpeg$/);
  // /working/ copy lives under the same new basename.
  assert.equal(path.basename(result.workingPath), path.basename(result.recropPath));
  assert.match(result.workingPath, /[\\/]working[\\/]/);
  // entry.filename re-points to the new working copy.
  assert.equal(result.newFilename, path.basename(result.workingPath));
  assert.equal(result.sidecar.images[0].filename, result.newFilename);
  // /recrops/ + /working/ dirs both ensured.
  const mkdirPaths = calls.mkdir.map((c) => c.p);
  assert.ok(mkdirPaths.some((p) => p.endsWith('recrops')));
  assert.ok(mkdirPaths.some((p) => p.endsWith('working')));
  // Encoding: extract called with rounded integer pixels, jpeg q=95.
  assert.equal(sharp.calls.length, 1);
  assert.deepEqual(sharp.calls[0].extract, { left: 10, top: 20, width: 800, height: 600 });
  assert.deepEqual(sharp.calls[0].jpeg, { quality: 95 });
  assert.equal(sharp.calls[0].srcPath, originalAbs);
  // Both files exist on disk.
  assert.ok(files.has(result.recropPath));
  assert.ok(files.has(result.workingPath));
  // Sidecar save invoked with mutated sidecar.
  assert.ok(savedArg && savedArg.sidecar.images[0].filename === result.newFilename);
  assert.equal(savedArg.jobPath, jobPath);
});

test('recropFromOriginal: rounds non-integer rect to integers before sharp.extract', async () => {
  const jobPath = path.join('C:', 'OHD', 'X', 'X_1');
  const originalAbs = path.join(path.dirname(jobPath), 'X_1/original-files/1.jpg');
  const { fs, files } = makeFsStub({ [originalAbs]: 'b' });
  const sharp = makeSharpStub(); sharp._fs = { files };

  const actions = createCustomerRecropActions({
    sharp, fs, saveSidecar: async (s) => s, logger: SILENT,
  });
  const sidecar = createSidecar('X_1', [createImageEntry('P.jpeg', 1, 'X_1/original-files/1.jpg')]);
  const r = await actions.recropFromOriginal({
    jobPath, sidecar, filename: 'P.jpeg',
    cropRect: { x: 1.4, y: 2.6, w: 10.1, h: 9.9 },
  });
  assert.equal(r.success, true);
  assert.deepEqual(sharp.calls[0].extract, { left: 1, top: 3, width: 10, height: 10 });
});

test('recropFromOriginal: missing originalFilename → graceful failure, no fs work', async () => {
  const { fs, calls } = makeFsStub();
  const sharp = makeSharpStub();
  const actions = createCustomerRecropActions({
    sharp, fs, saveSidecar: async (s) => s, logger: SILENT,
  });
  // Row has no originalFilename (pre-feature / non-Pixfizz).
  const sidecar = createSidecar('X_1', [createImageEntry('P.jpeg', 1)]);
  const r = await actions.recropFromOriginal({
    jobPath: 'C:\\j\\X\\X_1', sidecar, filename: 'P.jpeg',
    cropRect: { x: 0, y: 0, w: 10, h: 10 },
  });
  assert.equal(r.success, false);
  assert.match(r.error, /no customer original/i);
  assert.equal(sharp.calls.length, 0);
  assert.equal(calls.mkdir.length, 0);
});

test('recropFromOriginal: customer original missing on disk → graceful failure, no encode', async () => {
  const jobPath = path.join('C:', 'OHD', 'X', 'X_1');
  const { fs, calls } = makeFsStub(); // no original on disk
  const sharp = makeSharpStub();
  const actions = createCustomerRecropActions({
    sharp, fs, saveSidecar: async (s) => s, logger: SILENT,
  });
  const sidecar = createSidecar('X_1', [
    createImageEntry('P.jpeg', 1, 'X_1/original-files/1.jpg'),
  ]);
  const r = await actions.recropFromOriginal({
    jobPath, sidecar, filename: 'P.jpeg',
    cropRect: { x: 0, y: 0, w: 10, h: 10 },
  });
  assert.equal(r.success, false);
  assert.match(r.error, /not on disk/i);
  assert.equal(sharp.calls.length, 0);
});

test('recropFromOriginal: cropRect missing finite fields → descriptive error', async () => {
  const sharp = makeSharpStub();
  const { fs } = makeFsStub();
  const actions = createCustomerRecropActions({
    sharp, fs, saveSidecar: async (s) => s, logger: SILENT,
  });
  const sidecar = createSidecar('X_1', [createImageEntry('P.jpeg', 1, 'X_1/original-files/1.jpg')]);
  for (const bad of [
    null, undefined, {},
    { x: 0, y: 0, w: 10 },        // missing h
    { x: 'a', y: 0, w: 10, h: 10 },
    { x: NaN, y: 0, w: 10, h: 10 },
  ]) {
    const r = await actions.recropFromOriginal({
      jobPath: 'C:\\j\\X\\X_1', sidecar, filename: 'P.jpeg', cropRect: bad,
    });
    assert.equal(r.success, false);
    assert.match(r.error, /cropRect/i);
  }
  assert.equal(sharp.calls.length, 0);
});

test('recropFromOriginal: re-re-crop on the same row leaves the prior /recrops/ file on disk (audit trail, no pruning)', async () => {
  const jobPath = path.join('C:', 'OHD', 'X', 'X_1');
  const originalAbs = path.join(path.dirname(jobPath), 'X_1/original-files/1.jpg');
  const { fs, files } = makeFsStub({ [originalAbs]: 'b' });
  const sharp = makeSharpStub(); sharp._fs = { files };

  let savedSidecar = null;
  const saveSidecar = async (s) => { savedSidecar = s; return s; };

  let t = Date.parse('2026-05-15T10:00:00.000Z');
  const actions = createCustomerRecropActions({
    sharp, fs, saveSidecar, logger: SILENT, now: () => new Date(t),
  });

  const sidecar = createSidecar('X_1', [
    createImageEntry('P.jpeg', 1, 'X_1/original-files/1.jpg'),
  ]);

  const r1 = await actions.recropFromOriginal({
    jobPath, sidecar, filename: 'P.jpeg',
    cropRect: { x: 0, y: 0, w: 100, h: 100 },
  });
  assert.equal(r1.success, true);
  // Now feed the just-saved sidecar back in (mirrors how useJobReview re-feeds
  // the fresh sidecar to the next call) and re-crop a second time at +1s.
  t += 1000;
  const r2 = await actions.recropFromOriginal({
    jobPath, sidecar: savedSidecar, filename: savedSidecar.images[0].filename,
    cropRect: { x: 10, y: 10, w: 50, h: 50 },
  });
  assert.equal(r2.success, true);
  // Both /recrops/ files survive.
  assert.ok(files.has(r1.recropPath), 'first /recrops/ file persists as audit trail');
  assert.ok(files.has(r2.recropPath), 'second /recrops/ file written');
  assert.notEqual(r1.recropPath, r2.recropPath);
  // entry.filename now points at the second working copy.
  assert.equal(r2.sidecar.images[0].filename, r2.newFilename);
});

test('recropFromOriginal: sharp.toFile throws → returns failure, no sidecar save, no working copy', async () => {
  const jobPath = path.join('C:', 'OHD', 'X', 'X_1');
  const originalAbs = path.join(path.dirname(jobPath), 'X_1/original-files/1.jpg');
  const { fs, files, calls } = makeFsStub({ [originalAbs]: 'b' });
  const sharp = makeSharpStub({ shouldThrow: true });
  let saveCalls = 0;
  const actions = createCustomerRecropActions({
    sharp, fs,
    saveSidecar: async (s) => { saveCalls++; return s; },
    logger: SILENT,
  });
  const sidecar = createSidecar('X_1', [
    createImageEntry('P.jpeg', 1, 'X_1/original-files/1.jpg'),
  ]);
  const r = await actions.recropFromOriginal({
    jobPath, sidecar, filename: 'P.jpeg',
    cropRect: { x: 0, y: 0, w: 10, h: 10 },
  });
  assert.equal(r.success, false);
  assert.match(r.error, /boom/);
  assert.equal(saveCalls, 0, 'sidecar must NOT be saved on encode failure');
  // No /working/ copy left behind (encode failed before that step).
  const workingFiles = [...files.keys()].filter((p) => p.includes(`${path.sep}working${path.sep}`));
  assert.equal(workingFiles.length, 0);
  // Best-effort tmp cleanup attempted.
  assert.ok(calls.unlink.length >= 1);
});

test('createCustomerRecropActions: rejects missing sharp factory', () => {
  assert.throws(() => createCustomerRecropActions({ sharp: null }), /sharp.*required/);
  assert.throws(() => createCustomerRecropActions({}), /sharp.*required/);
  assert.throws(() => createCustomerRecropActions({ sharp: 'not-a-fn' }), /sharp.*required/);
});
