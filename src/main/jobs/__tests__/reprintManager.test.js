'use strict';

/**
 * Unit tests for reprintManager.createReprint — focused on the three-layer
 * source-file fallback chain added 2026-06-19 to fix the
 * PXDEMO-Y64Z3U_38471868 Fuji-reprint regression.
 *
 * Fallback order:
 *   1. {parentJobPath}/originals/<filename>   (canonical)
 *   2. {parentJobPath}/working/<filename>     (Phase 2 re-cropped rows)
 *   3. {parentJobPath}/<filename>             (FTP/S3-delivered bytes —
 *                                              the new third layer)
 * If all three miss, throw a clear named error (not a raw ENOENT).
 *
 * Tests use real fs in a temp directory — no mocks. Pattern mirrors
 * sidecarManager.test.js's "no mocks, real fs" approach.
 *
 * Run via:  npm test
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const fsp     = require('node:fs/promises');
const path    = require('node:path');
const os      = require('node:os');

const { createReprint } = require('../reprintManager.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeJobFolder() {
  const root    = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-rpm-'));
  const jobDir  = path.join(root, 'PXTEST-AB_1234');
  await fsp.mkdir(path.join(jobDir, 'originals'), { recursive: true });
  await fsp.mkdir(path.join(jobDir, 'working'),   { recursive: true });
  return { root, jobDir };
}

function dropFile(absPath, content = 'fake-jpeg') {
  return fsp.writeFile(absPath, content);
}

function makeSidecar(filenames) {
  return {
    jobId:  'PXTEST-AB_1234',
    images: filenames.map(filename => ({
      filename,
      qtyCurrent: 1,
      reprint:    true,
      corrections: { cyan: 0, magenta: 0, yellow: 0 },
    })),
  };
}

// console.warn capture — tests assert on the root-fallback warning text.
function captureWarn(t) {
  const calls = [];
  const orig  = console.warn;
  console.warn = (...args) => { calls.push(args.join(' ')); };
  t.after(() => { console.warn = orig; });
  return calls;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('three-layer fallback: file in /originals/ is the first choice', async (t) => {
  const { root, jobDir } = await makeJobFolder();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warns = captureWarn(t);

  // Same filename present in ALL three layers — distinct content so we can
  // assert which one was copied.
  await dropFile(path.join(jobDir, 'originals', 'a.jpg'), 'from-originals');
  await dropFile(path.join(jobDir, 'working',   'a.jpg'), 'from-working');
  await dropFile(path.join(jobDir,              'a.jpg'), 'from-root');

  const { reprintJobPath } = await createReprint({
    parentJobId:   'PXTEST-AB_1234',
    parentJobPath: jobDir,
    sidecar:       makeSidecar(['a.jpg']),
    reprintJobId:  'PXTEST-AB_1234-r1',
  });

  assert.equal(await fsp.readFile(path.join(reprintJobPath, 'originals', 'a.jpg'), 'utf8'), 'from-originals');
  assert.equal(await fsp.readFile(path.join(reprintJobPath, 'working',   'a.jpg'), 'utf8'), 'from-originals');
  assert.equal(warns.length, 0, 'no warning when /originals/ has the file');
});

test('three-layer fallback: /working/ is preferred over root (existing Phase 2 behaviour preserved)', async (t) => {
  const { root, jobDir } = await makeJobFolder();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warns = captureWarn(t);

  // Skip /originals/, populate /working/ + root. Pre-fix this fell back to
  // /working/ with a "Phase 2 re-cropped row" warning — unchanged here.
  await dropFile(path.join(jobDir, 'working', 'b.jpg'), 'from-working');
  await dropFile(path.join(jobDir,            'b.jpg'), 'from-root');

  const { reprintJobPath } = await createReprint({
    parentJobId:   'PXTEST-AB_1234',
    parentJobPath: jobDir,
    sidecar:       makeSidecar(['b.jpg']),
    reprintJobId:  'PXTEST-AB_1234-r1',
  });

  assert.equal(await fsp.readFile(path.join(reprintJobPath, 'originals', 'b.jpg'), 'utf8'), 'from-working');
  // Two warnings: one per destination (originals + working) since each runs
  // its own fallback chain. Both should be the "fell back to /working/" line.
  assert.equal(warns.length, 2);
  for (const w of warns) {
    assert.match(w, /fell back to \/working\//);
    assert.match(w, /Likely a Phase 2 re-cropped row/);
  }
});

test('three-layer fallback: root-only file resolves via the new third layer', async (t) => {
  // This is the PXDEMO-Y64Z3U_38471868 regression: the sidecar references a
  // file that exists in the parent root but never made it into /working/ or
  // /originals/. Pre-fix this failed with raw ENOENT and bricked the reprint.
  const { root, jobDir } = await makeJobFolder();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warns = captureWarn(t);

  await dropFile(path.join(jobDir, 'PXTEST-AB_1234_Q1_pages28.jpeg'), 'from-root-only');
  // /originals/ and /working/ are intentionally empty.

  const { reprintJobPath } = await createReprint({
    parentJobId:   'PXTEST-AB_1234',
    parentJobPath: jobDir,
    sidecar:       makeSidecar(['PXTEST-AB_1234_Q1_pages28.jpeg']),
    reprintJobId:  'PXTEST-AB_1234-r1',
  });

  assert.equal(
    await fsp.readFile(path.join(reprintJobPath, 'originals', 'PXTEST-AB_1234_Q1_pages28.jpeg'), 'utf8'),
    'from-root-only',
  );
  assert.equal(
    await fsp.readFile(path.join(reprintJobPath, 'working', 'PXTEST-AB_1234_Q1_pages28.jpeg'), 'utf8'),
    'from-root-only',
  );
});

test('three-layer fallback: root-fallback warning names the file and is distinct from the /working/-fallback warning', async (t) => {
  const { root, jobDir } = await makeJobFolder();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warns = captureWarn(t);

  await dropFile(path.join(jobDir, 'late-arriver.jpeg'), 'from-root');

  await createReprint({
    parentJobId:   'PXTEST-AB_1234',
    parentJobPath: jobDir,
    sidecar:       makeSidecar(['late-arriver.jpeg']),
    reprintJobId:  'PXTEST-AB_1234-r1',
  });

  // Two warnings (one per dest: originals + working). Both must be the
  // ROOT-fallback flavour — distinct wording from the /working/ fallback so
  // log greps can tell them apart.
  assert.equal(warns.length, 2);
  for (const w of warns) {
    assert.match(w, /late-arriver\.jpeg/,                    'warning names the file');
    assert.match(w, /missing from BOTH \/originals\/ AND \/working\//, 'warning makes the divergence visible');
    assert.match(w, /fell back to job root/,                 'warning identifies the source layer');
    assert.match(w, /FTP\/S3-delivered/,                     'warning explains where root content comes from');
    assert.match(w, /re-cropped row/,                        'warning calls out the pre-crop substitution risk');
    assert.doesNotMatch(w, /fell back to \/working\//,       'must not be the /working/-fallback warning');
  }
});

test('three-layer fallback: all-three-miss throws a clear named error (not a raw ENOENT)', async (t) => {
  const { root, jobDir } = await makeJobFolder();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // No file anywhere. Sidecar references it.
  await assert.rejects(
    createReprint({
      parentJobId:   'PXTEST-AB_1234',
      parentJobPath: jobDir,
      sidecar:       makeSidecar(['missing.jpeg']),
      reprintJobId:  'PXTEST-AB_1234-r1',
    }),
    (err) => {
      // Clear named error — not a raw ENOENT.
      assert.notEqual(err.code, 'ENOENT', 'must not be a raw ENOENT — needs context');
      assert.match(err.message, /Image not found anywhere for reprint: missing\.jpeg/);
      assert.match(err.message, /Absent from \/originals\/, \/working\/, AND the job root/);
      assert.match(err.message, /Sidecar may reference a file that was deleted or never delivered/);
      return true;
    },
  );
});

test('three-layer fallback: non-ENOENT errors at any layer escalate (don\'t silently fall through)', async (t) => {
  // Safety net: the fallback chain only catches ENOENT. Other fs errors
  // (EACCES, EISDIR, etc.) should bubble. We simulate by making
  // /originals/<filename> a directory so copyFile throws EISDIR.
  const { root, jobDir } = await makeJobFolder();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Make /originals/a.jpg a directory — copyFile will reject with EISDIR.
  await fsp.mkdir(path.join(jobDir, 'originals', 'a.jpg'));
  // Provide a fallback in /working/ — if the fallback chain caught EISDIR
  // it would silently succeed by reading from /working/, masking the bug.
  await dropFile(path.join(jobDir, 'working', 'a.jpg'), 'fallback');

  await assert.rejects(
    createReprint({
      parentJobId:   'PXTEST-AB_1234',
      parentJobPath: jobDir,
      sidecar:       makeSidecar(['a.jpg']),
      reprintJobId:  'PXTEST-AB_1234-r1',
    }),
    (err) => {
      // The exact code varies by platform (EISDIR / EPERM), but it must NOT
      // be our "Image not found anywhere" message — that would mean the
      // chain swallowed a non-ENOENT and tried the next layer.
      assert.doesNotMatch(err.message || '', /not found anywhere/);
      return true;
    },
  );
});
