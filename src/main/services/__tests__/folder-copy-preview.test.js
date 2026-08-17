/**
 * Tests for the M5 live-preview service (folder-copy-preview.js).
 *
 * The non-negotiable per §7 of the brief: the preview MUST run the real
 * M1+M2 code path. The core test in this suite asserts equality against
 * `buildCopyFilenames` DIRECTLY — not against a literal string — so any
 * future change to the M2 planner flows through the preview and the
 * suite continues to lock the equivalence without a manual update.
 *
 * Deps are injected per-test; no electron-store shim required.
 *
 * Run via: npm test
 */

'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

const {
  buildFolderCopyPreview,
  SYNTHETIC_JOB,
  SYNTHETIC_IMAGES,
  MAX_PREVIEW_SAMPLES,
} = require(path.join(SVC, 'folder-copy-preview.js'));

const { buildCopyFilenames } = require(path.join(SVC, 'folder-copy-filename.js'));

// ── Fixtures ────────────────────────────────────────────────────────────

const JOB_RECENT = {
  id: 12345,
  order_number: 'PXDEMO-RECENT',
  order_id:     'ord-r',
  created_at:   '2026-08-16T10:00:00Z',
};
const JOB_OLDER = {
  id: 22222,
  order_number: 'PXDEMO-OLDER',
  order_id:     'ord-o',
  created_at:   '2026-08-01T10:00:00Z',
};
const JOB_ANCIENT = {
  id: 33333,
  order_number: 'PXDEMO-ANCIENT',
  order_id:     'ord-a',
  created_at:   '2025-01-01T10:00:00Z',
};

// A stub readManifest that returns a canned manifest keyed by orderNumber.
// Only knows about the fixtures we set up per-test.
function manifestReaderFor(mapByOrderNumber) {
  return (orderFolder, orderNumber) => {
    return mapByOrderNumber[orderNumber] || null;
  };
}

const REAL_MANIFEST = {
  jobs: [{
    jobId: '12345',
    images: [
      { filename: 'IMG_0001.jpg', quantity: 2, originalFilename: 'IMG_0001.jpg' },
      { filename: 'IMG_0002.jpg', quantity: 3, originalFilename: 'IMG_0002.jpg' },
      { filename: 'IMG_0003.jpg', quantity: 5, originalFilename: 'IMG_0003.jpg' },
      { filename: 'IMG_0004.jpg', quantity: 1, originalFilename: 'IMG_0004.jpg' },
    ],
  }],
};

// Baseline deps — no jobs, no download directory. Forces the synthetic
// branch, which most tests want.
const NO_JOBS_DEPS = {
  listJobs:             () => [],
  resolveRouteFor:      () => null,
  getDownloadDirectory: () => null,
  readManifest:         () => null,
};

// ═════════════════════════════════════════════════════════════════════════
// THE core test: preview output == buildCopyFilenames output, directly
// ═════════════════════════════════════════════════════════════════════════

test('preview runs the REAL M2 planner — equality with buildCopyFilenames, no literal comparisons', async () => {
  // Force the synthetic sample so the inputs to both calls are identical
  // and reproducible. Under a template that produces a collision plus a
  // truncation we exercise all three stats fields at once, so if any of
  // {suffixed, truncated, fallbacks} silently drift between the preview
  // and the planner this test catches it.
  const template = '{product}';   // all 3 synthetic images collide on the same product name

  const preview = await buildFolderCopyPreview(
    { filenameTemplate: template, destinationLayout: 'job', outputPath: '/x' },
    NO_JOBS_DEPS,
  );

  // Recompute by calling the PLANNER DIRECTLY with the same sample.
  const sample = SYNTHETIC_IMAGES.slice(0, MAX_PREVIEW_SAMPLES).map(i => ({ ...i }));
  const direct = buildCopyFilenames(sample, SYNTHETIC_JOB, {
    template,
    stripPrefix: '',
  });

  // Filenames must match exactly.
  assert.deepEqual(
    preview.files.map(f => f.destFilename),
    direct.files.map(f => f.destFilename),
    'preview filenames must be byte-identical to what the M2 planner produced',
  );
  // Stats must match exactly.
  assert.deepEqual(preview.stats, direct.stats,
    'preview stats must be identical to the planner stats');
});

test('preview equality holds under strip prefix — {orderNumber}/{jobName} paths flow through', async () => {
  const template = '{orderNumber}-{index}';
  const stripPrefix = 'PXDEMO-';
  const preview = await buildFolderCopyPreview(
    { filenameTemplate: template, destinationLayout: 'job', outputPath: '/x', stripOrderNumberPrefix: stripPrefix },
    NO_JOBS_DEPS,
  );
  const sample = SYNTHETIC_IMAGES.slice(0, MAX_PREVIEW_SAMPLES).map(i => ({ ...i }));
  const direct = buildCopyFilenames(sample, SYNTHETIC_JOB, { template, stripPrefix });
  assert.deepEqual(
    preview.files.map(f => f.destFilename),
    direct.files.map(f => f.destFilename),
    'stripPrefix must reach the planner through the preview call unchanged',
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Sample-source resolution (order matters)
// ═════════════════════════════════════════════════════════════════════════

test('no jobs available → synthetic sample with the "Preview using sample data" label', async () => {
  const out = await buildFolderCopyPreview({}, NO_JOBS_DEPS);
  assert.equal(out.source.kind,  'synthetic');
  assert.equal(out.source.label, 'Preview using sample data');
  assert.equal(out.source.jobId, SYNTHETIC_JOB.id);
  assert.equal(out.sampleSize,   MAX_PREVIEW_SAMPLES);
});

test('empty controllerId + no jobs → synthetic (does not throw on missing route info)', async () => {
  const out = await buildFolderCopyPreview({ controllerId: '' }, NO_JOBS_DEPS);
  assert.equal(out.source.kind, 'synthetic');
});

test('jobs exist but none have a readable manifest → synthetic', async () => {
  const out = await buildFolderCopyPreview({}, {
    listJobs:             () => [JOB_RECENT, JOB_OLDER],
    resolveRouteFor:      () => ({ type: 'controller', controllerId: 'X' }),
    getDownloadDirectory: () => '/tmp/dl',
    readManifest:         () => null,   // no manifest for any job
  });
  assert.equal(out.source.kind, 'synthetic');
  assert.equal(out.source.label, 'Preview using sample data');
});

test('any-manifest fallback picks the most recent readable manifest when no controllerId matches', async () => {
  const out = await buildFolderCopyPreview({}, {
    listJobs: () => [JOB_ANCIENT, JOB_RECENT, JOB_OLDER],  // deliberately out of order
    resolveRouteFor:      () => ({ type: 'controller', controllerId: 'X' }),
    getDownloadDirectory: () => '/tmp/dl',
    readManifest: manifestReaderFor({
      // Only the recent order has a readable manifest.
      'PXDEMO-RECENT': REAL_MANIFEST,
    }),
  });
  assert.equal(out.source.kind,  'any-manifest');
  assert.equal(out.source.jobId, JOB_RECENT.id);
  assert.equal(out.source.label, `Preview using job ${JOB_RECENT.id}`);
});

test('routed-to-controller wins over any-manifest when both match', async () => {
  const CONTROLLER_ID = 'CTRL-A';
  const routedManifest = {
    jobs: [{ jobId: String(JOB_OLDER.id), images: [{ filename: 'r.jpg', quantity: 1 }] }],
  };
  const anyManifest = {
    jobs: [{ jobId: String(JOB_RECENT.id), images: [{ filename: 'a.jpg', quantity: 1 }] }],
  };
  const out = await buildFolderCopyPreview({ controllerId: CONTROLLER_ID }, {
    listJobs: () => [JOB_RECENT, JOB_OLDER],
    // The older job is the one routed to this controller; the newer one
    // is routed to a different controller. Step 1 must prefer the older
    // (routed) even though step 2 would pick the newer.
    resolveRouteFor: (job) => ({
      type:         'controller',
      controllerId: job.id === JOB_OLDER.id ? CONTROLLER_ID : 'CTRL-OTHER',
    }),
    getDownloadDirectory: () => '/tmp/dl',
    readManifest: manifestReaderFor({
      'PXDEMO-OLDER':  routedManifest,
      'PXDEMO-RECENT': anyManifest,
    }),
  });
  assert.equal(out.source.kind,  'routed-job');
  assert.equal(out.source.jobId, JOB_OLDER.id);
});

test('routed-to-controller with no manifest falls THROUGH to any-manifest', async () => {
  // Routed job has no manifest → step 1 rejects it; step 2 finds a
  // different job with a readable manifest and uses that. The label
  // switches to 'any-manifest' so the operator sees that the shown job
  // is NOT the routed one.
  const CONTROLLER_ID = 'CTRL-A';
  const out = await buildFolderCopyPreview({ controllerId: CONTROLLER_ID }, {
    listJobs: () => [JOB_OLDER, JOB_RECENT],
    resolveRouteFor: (job) => ({
      type:         'controller',
      controllerId: job.id === JOB_OLDER.id ? CONTROLLER_ID : 'CTRL-OTHER',
    }),
    getDownloadDirectory: () => '/tmp/dl',
    readManifest: manifestReaderFor({
      // Only the non-routed job has a manifest.
      'PXDEMO-RECENT': REAL_MANIFEST,
    }),
  });
  assert.equal(out.source.kind,  'any-manifest');
  assert.equal(out.source.jobId, JOB_RECENT.id);
});

test('resolveRouteFor throwing on a job is treated as "does not match" and moves on', async () => {
  const CONTROLLER_ID = 'CTRL-A';
  const out = await buildFolderCopyPreview({ controllerId: CONTROLLER_ID }, {
    listJobs:             () => [JOB_RECENT, JOB_OLDER],
    resolveRouteFor:      (_job) => { throw new Error('bad route'); },
    getDownloadDirectory: () => '/tmp/dl',
    readManifest:         manifestReaderFor({ 'PXDEMO-RECENT': REAL_MANIFEST }),
  });
  // Step 1 skips every job (throw). Step 2 finds JOB_RECENT.
  assert.equal(out.source.kind,  'any-manifest');
  assert.equal(out.source.jobId, JOB_RECENT.id);
});

// ═════════════════════════════════════════════════════════════════════════
// Warnings — three signals the M4 dispatch log also emits
// ═════════════════════════════════════════════════════════════════════════

test('warnings: suffixed count is named with the fix ("add {index} or {indexPadded}")', async () => {
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{product}', destinationLayout: 'job', outputPath: '/x' },
    NO_JOBS_DEPS,
  );
  const suffixWarn = out.warnings.find(w => w.kind === 'suffixed');
  assert.ok(suffixWarn, 'a suffixed-count warning must fire');
  assert.match(suffixWarn.text, /\{index\}/);
  assert.match(suffixWarn.text, /\{indexPadded\}/);
});

test('warnings: fallback count is named when template resolves empty', async () => {
  // Template resolves to blank for every sample image → fallback path.
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{option:nonexistent}', destinationLayout: 'job', outputPath: '/x' },
    NO_JOBS_DEPS,
  );
  const fbWarn = out.warnings.find(w => w.kind === 'fallback');
  assert.ok(fbWarn, 'a fallback-count warning must fire');
  assert.match(fbWarn.text, /fell back to the original basename/);
});

test('warnings: none when the template distinguishes every sample', async () => {
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{jobId}-{indexPadded}', destinationLayout: 'job', outputPath: '/x' },
    NO_JOBS_DEPS,
  );
  assert.deepEqual(out.warnings, [], 'no signals to raise on a healthy template');
});

// ═════════════════════════════════════════════════════════════════════════
// Destination path — full path, layout-aware, honors stripPrefix
// ═════════════════════════════════════════════════════════════════════════

test('destPath is the FULL path (§7 — path length is half the point)', async () => {
  const out = await buildFolderCopyPreview(
    {
      outputPath:             '/hot/wf',
      filenameTemplate:       '{jobId}-{index}',
      destinationLayout:      'job',
      stripOrderNumberPrefix: 'PXDEMO-',
    },
    NO_JOBS_DEPS,
  );
  // Synthetic sample job.id is 999999, order_number is PXDEMO-SAMPLE
  // → stripped to SAMPLE → destJobFolderName is 'SAMPLE_999999'.
  const expectedFolder = path.join('/hot/wf', 'SAMPLE_999999');
  assert.equal(out.destFolder, expectedFolder);
  assert.equal(out.files[0].destPath, path.join(expectedFolder, out.files[0].destFilename));
});

test('destPath under root layout: files land in outputPath itself', async () => {
  const out = await buildFolderCopyPreview(
    { outputPath: '/hot/wf', filenameTemplate: '{jobId}-{index}', destinationLayout: 'root' },
    NO_JOBS_DEPS,
  );
  assert.equal(out.destFolder, '/hot/wf');
  for (const f of out.files) {
    assert.equal(f.destPath, path.join('/hot/wf', f.destFilename));
  }
});

test('destPath handles blank outputPath gracefully (new-controller mid-edit)', async () => {
  const out = await buildFolderCopyPreview(
    { outputPath: '', filenameTemplate: '{jobId}-{index}', destinationLayout: 'job' },
    NO_JOBS_DEPS,
  );
  // Just the relative folder segment — the renderer can decide to add a
  // "set Output Path" hint. We must not throw and must not lie.
  assert.equal(out.destFolder, 'PXDEMO-SAMPLE_999999');
});

// ═════════════════════════════════════════════════════════════════════════
// Input trim + coercion (mirrors renderer + IPC boundary)
// ═════════════════════════════════════════════════════════════════════════

test('input hygiene: filenameTemplate is trimmed, stripPrefix trimmed, layout coerced', async () => {
  const out = await buildFolderCopyPreview(
    {
      outputPath:             '/o',
      filenameTemplate:       '  {jobId}-{index}  ',
      destinationLayout:      'garbage',   // → coerced to 'job'
      stripOrderNumberPrefix: '  PXDEMO-  ',
    },
    NO_JOBS_DEPS,
  );
  assert.equal(out.destinationLayout, 'job');
  // Template must have been trimmed BEFORE reaching the planner — a
  // whitespace-only template would resolve to blank on every image and
  // hit the fallback path. Same {jobId}-{index} → '999999-1' etc.
  assert.equal(out.files[0].destFilename, '999999-1.jpg');
  // stripPrefix trimmed and applied — SAMPLE, not PXDEMO-SAMPLE, in destFolder.
  assert.ok(out.destFolder.endsWith('SAMPLE_999999'));
});

// ═════════════════════════════════════════════════════════════════════════
// Real-manifest end-to-end (deps only inject the manifest read)
// ═════════════════════════════════════════════════════════════════════════

test('real manifest: sample size clamped to MAX_PREVIEW_SAMPLES and totalImageCount reports the full count', async () => {
  // Manifest has 4 images; sample size should be 3 (MAX_PREVIEW_SAMPLES).
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{jobId}-{index}', outputPath: '/x' },
    {
      listJobs:             () => [JOB_RECENT],
      resolveRouteFor:      () => null,
      getDownloadDirectory: () => '/tmp/dl',
      readManifest:         manifestReaderFor({ 'PXDEMO-RECENT': REAL_MANIFEST }),
    },
  );
  assert.equal(out.source.kind,       'any-manifest');
  assert.equal(out.sampleSize,        MAX_PREVIEW_SAMPLES);
  assert.equal(out.totalImageCount,   4);
  assert.equal(out.files.length,      MAX_PREVIEW_SAMPLES);
});

test('real manifest: preview filenames come from the REAL planner given the REAL sample', async () => {
  // Same equality-with-planner test but using a real job manifest rather
  // than the synthetic sample. If the sample extraction changes shape,
  // the direct call below reproduces it.
  const template = '{jobId}-x{quantity}';
  const out = await buildFolderCopyPreview(
    { filenameTemplate: template, outputPath: '/x' },
    {
      listJobs:             () => [JOB_RECENT],
      resolveRouteFor:      () => null,
      getDownloadDirectory: () => '/tmp/dl',
      readManifest:         manifestReaderFor({ 'PXDEMO-RECENT': REAL_MANIFEST }),
    },
  );
  // Rebuild the same sample locally.
  const sample = REAL_MANIFEST.jobs[0].images.slice(0, MAX_PREVIEW_SAMPLES).map(img => ({
    sourcePath:       path.basename(img.filename),
    filename:         path.basename(img.filename),
    quantity:         img.quantity,
    originalFilename: img.originalFilename,
  }));
  const direct = buildCopyFilenames(sample, JOB_RECENT, { template, stripPrefix: '' });
  assert.deepEqual(
    out.files.map(f => f.destFilename),
    direct.files.map(f => f.destFilename),
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Read-only contract
// ═════════════════════════════════════════════════════════════════════════

test('read-only: no dep is ever mutated by the call', async () => {
  const jobsFrozen = Object.freeze([Object.freeze({ ...JOB_RECENT })]);
  const manifestsFrozen = Object.freeze({ 'PXDEMO-RECENT': REAL_MANIFEST });
  // Passing a frozen jobs array through — if the module tried to sort in
  // place or push to it, freeze would surface the mutation as a throw.
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{jobId}', outputPath: '/x' },
    {
      listJobs:             () => jobsFrozen,
      resolveRouteFor:      () => null,
      getDownloadDirectory: () => '/tmp',
      readManifest:         manifestReaderFor(manifestsFrozen),
    },
  );
  assert.ok(out);
});
