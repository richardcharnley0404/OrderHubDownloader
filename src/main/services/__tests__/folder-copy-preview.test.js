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

test('preview runs the REAL M2 planner on the FULL image list — equality with buildCopyFilenames on ALL images', async () => {
  // The core invariant, restated for M5a: the preview must be honest
  // about what dispatch will do. That means the planner runs on every
  // image in the source, not on a display-slice, so ctx.imageCount and
  // within-call collision detection see the true count. The displayed
  // filenames are the first MAX_PREVIEW_SAMPLES of the planner's output.
  // The stats are the planner's stats verbatim.
  const template = '{product}';   // all synthetic images collide on the same product name

  const preview = await buildFolderCopyPreview(
    { filenameTemplate: template, destinationLayout: 'job', outputPath: '/x' },
    NO_JOBS_DEPS,
  );

  // Recompute by calling the PLANNER DIRECTLY with the FULL image list.
  const allImages = SYNTHETIC_IMAGES.map(i => ({ ...i }));
  const direct    = buildCopyFilenames(allImages, SYNTHETIC_JOB, {
    template,
    stripPrefix: '',
  });

  // Displayed filenames == first MAX_PREVIEW_SAMPLES of the planner's
  // full-run output. NOT compared against a literal — asserted against
  // the planner's own return so any change to buildCopyFilenames flows
  // through this test automatically.
  assert.deepEqual(
    preview.files.map(f => f.destFilename),
    direct.files.slice(0, MAX_PREVIEW_SAMPLES).map(f => f.destFilename),
    'displayed filenames must be the first MAX_PREVIEW_SAMPLES of the FULL planner run',
  );
  // Stats must match the FULL run exactly.
  assert.deepEqual(preview.stats, direct.stats,
    'preview stats must be identical to the planner stats for the FULL image list');
});

test('preview equality holds under strip prefix — full-list run reaches the planner unchanged', async () => {
  const template = '{orderNumber}-{index}';
  const stripPrefix = 'PXDEMO-';
  const preview = await buildFolderCopyPreview(
    { filenameTemplate: template, destinationLayout: 'job', outputPath: '/x', stripOrderNumberPrefix: stripPrefix },
    NO_JOBS_DEPS,
  );
  const allImages = SYNTHETIC_IMAGES.map(i => ({ ...i }));
  const direct    = buildCopyFilenames(allImages, SYNTHETIC_JOB, { template, stripPrefix });
  assert.deepEqual(
    preview.files.map(f => f.destFilename),
    direct.files.slice(0, MAX_PREVIEW_SAMPLES).map(f => f.destFilename),
    'stripPrefix must reach the planner through the preview call unchanged',
  );
  assert.deepEqual(preview.stats, direct.stats);
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

test('real manifest: preview filenames come from the REAL planner run on ALL images', async () => {
  // Same equality-with-planner test but using a real job manifest rather
  // than the synthetic sample. The planner runs on the FULL image list;
  // the preview shows the first MAX_PREVIEW_SAMPLES.
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
  // Rebuild the SAME sample the preview would have extracted — but for
  // ALL images, not just the first three.
  const allImages = REAL_MANIFEST.jobs[0].images.map(img => ({
    sourcePath:       path.basename(img.filename),
    filename:         path.basename(img.filename),
    quantity:         img.quantity,
    originalFilename: img.originalFilename,
  }));
  const direct = buildCopyFilenames(allImages, JOB_RECENT, { template, stripPrefix: '' });
  // Displayed filenames = first 3 of the full-run output.
  assert.deepEqual(
    out.files.map(f => f.destFilename),
    direct.files.slice(0, MAX_PREVIEW_SAMPLES).map(f => f.destFilename),
  );
  // Stats come from the FULL run.
  assert.deepEqual(out.stats, direct.stats);
});

// ═════════════════════════════════════════════════════════════════════════
// M5a — planner runs on FULL images, slice for DISPLAY only
// ═════════════════════════════════════════════════════════════════════════
//
// Pre-M5a the preview sliced source.images to 3 BEFORE calling the M2
// planner. Two silent failures:
//
//   1. ctx.imageCount was 3, so {indexPadded} width was 1. A 40-image
//      job with template `x{indexPadded}` previewed as x1, x2, x3 and
//      then dispatched as x01 … x40. The preview showed filenames that
//      were not the filenames.
//   2. Within-call collision detection only saw 3 of 40, so the
//      suffix warning under-reported. A template lacking any index
//      token previewed with no warning at all and then auto-suffixed
//      39 files at dispatch — the warning went quiet exactly when it
//      mattered.
//
// Fix: run the planner on the FULL image list, slice for display only.

function makeManyImageManifest(count) {
  return {
    jobs: [{
      jobId: String(JOB_RECENT.id),
      images: Array.from({ length: count }, (_, i) => ({
        filename:         `IMG_${String(i + 1).padStart(4, '0')}.jpg`,
        quantity:         1,
        originalFilename: `IMG_${String(i + 1).padStart(4, '0')}.jpg`,
      })),
    }],
  };
}

test('M5a: 40-image source with x{indexPadded} — displayed names are x01, x02, x03 (width from 40, not 3)', async () => {
  const manifest40 = makeManyImageManifest(40);
  const out = await buildFolderCopyPreview(
    { filenameTemplate: 'x{indexPadded}', outputPath: '/x' },
    {
      listJobs:             () => [JOB_RECENT],
      resolveRouteFor:      () => null,
      getDownloadDirectory: () => '/tmp',
      readManifest:         manifestReaderFor({ 'PXDEMO-RECENT': manifest40 }),
    },
  );
  assert.equal(out.totalImageCount, 40);
  assert.equal(out.sampleSize,       MAX_PREVIEW_SAMPLES);
  // Width is String(40).length === 2, so 1 → '01', 2 → '02', 3 → '03'.
  assert.deepEqual(
    out.files.map(f => f.destFilename),
    ['x01.jpg', 'x02.jpg', 'x03.jpg'],
    'displayed padding width must come from the FULL image count (40 → width 2), not from the displayed slice (3 → width 1)',
  );
});

test('M5a: 100-image source with {indexPadded} → width 3 in the displayed slice', async () => {
  // Sanity extension: 100 images → String(100).length === 3, so index
  // 1..3 pad to 001..003.
  const manifest100 = makeManyImageManifest(100);
  const out = await buildFolderCopyPreview(
    { filenameTemplate: 'img-{indexPadded}', outputPath: '/x' },
    {
      listJobs:             () => [JOB_RECENT],
      resolveRouteFor:      () => null,
      getDownloadDirectory: () => '/tmp',
      readManifest:         manifestReaderFor({ 'PXDEMO-RECENT': manifest100 }),
    },
  );
  assert.deepEqual(
    out.files.map(f => f.destFilename),
    ['img-001.jpg', 'img-002.jpg', 'img-003.jpg'],
  );
});

test('M5a: 40-image source with a template lacking any index token — suffix warning names the count from ALL 40', async () => {
  const manifest40 = makeManyImageManifest(40);
  const out = await buildFolderCopyPreview(
    // Every image resolves to 'same.jpg' → 39 auto-suffixes across the
    // FULL 40. Pre-fix the planner only saw 3 and reported suffixed=2.
    { filenameTemplate: 'same', outputPath: '/x' },
    {
      listJobs:             () => [JOB_RECENT],
      resolveRouteFor:      () => null,
      getDownloadDirectory: () => '/tmp',
      readManifest:         manifestReaderFor({ 'PXDEMO-RECENT': manifest40 }),
    },
  );
  assert.equal(out.stats.suffixed, 39,
    'stats.suffixed must reflect the full 40-image run (39 collisions), not the 3-image slice');
  const suffixWarn = out.warnings.find(w => w.kind === 'suffixed');
  assert.ok(suffixWarn, 'suffix warning must fire when 39 of 40 names auto-suffixed');
  // Warning wording quotes the count out of the FULL image count, not
  // the displayed sample size.
  assert.match(suffixWarn.text, /39 of 40/,
    `expected "39 of 40" in warning text, got: ${suffixWarn.text}`);
});

test('M5a: 40-image source with x{index} — displayed slice is 1,2,3 (index token is per-image, not padded)', async () => {
  // Complement to the {indexPadded} test — plain {index} is unpadded so
  // width doesn't matter, but this test still exercises the "run planner
  // on all 40" path. The stats should show zero collisions.
  const manifest40 = makeManyImageManifest(40);
  const out = await buildFolderCopyPreview(
    { filenameTemplate: 'x{index}', outputPath: '/x' },
    {
      listJobs:             () => [JOB_RECENT],
      resolveRouteFor:      () => null,
      getDownloadDirectory: () => '/tmp',
      readManifest:         manifestReaderFor({ 'PXDEMO-RECENT': manifest40 }),
    },
  );
  assert.deepEqual(out.files.map(f => f.destFilename), ['x1.jpg', 'x2.jpg', 'x3.jpg']);
  assert.equal(out.stats.suffixed, 0, 'plain {index} distinguishes every image');
});

test('M5a: 40-image full-run equality — preview.stats == buildCopyFilenames.stats(full)', async () => {
  const manifest40 = makeManyImageManifest(40);
  const template = 'same';
  const out = await buildFolderCopyPreview(
    { filenameTemplate: template, outputPath: '/x' },
    {
      listJobs:             () => [JOB_RECENT],
      resolveRouteFor:      () => null,
      getDownloadDirectory: () => '/tmp',
      readManifest:         manifestReaderFor({ 'PXDEMO-RECENT': manifest40 }),
    },
  );
  const allImages = manifest40.jobs[0].images.map(img => ({
    sourcePath:       path.basename(img.filename),
    filename:         path.basename(img.filename),
    quantity:         img.quantity,
    originalFilename: img.originalFilename,
  }));
  const direct = buildCopyFilenames(allImages, JOB_RECENT, { template, stripPrefix: '' });
  assert.deepEqual(out.stats, direct.stats,
    'preview stats must equal buildCopyFilenames stats for the FULL 40-image list');
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

// ═════════════════════════════════════════════════════════════════════════
// M8 — sampleOptionNames + machine-value warning on {options}
// ═════════════════════════════════════════════════════════════════════════
//
// The preview surfaces the sample job's option NAMES so the renderer can
// render them as clickable chips. `{option:NAME}` is unusable without
// knowing the name; before M8 nothing in the app told the operator.
//
// The `{options}` token is honest, not filtered — some products send
// every option including machine-shaped ids (photo:db:... on MetalPrint,
// shopify_*), and filtering would (a) hide that from the operator and
// (b) be a no-op for folder_copy anyway (ignoredOptionNames is only
// populated from Assign-channel modals, which folder_copy controllers
// never see). Instead we warn in the preview so the operator can pick
// {option:NAME} for the specific option they want.

const {
  _looksLikeMachineValue,
} = require(path.join(SVC, 'folder-copy-preview.js'));

function fixtureRealJobWithOptions(options) {
  // Assembles a listJobs + readManifest deps pair that resolves to a
  // real (any-manifest) sample carrying `options`. Manifest has one
  // trivial image so buildCopyFilenames has something to iterate.
  const jobId = JOB_RECENT.id;
  const job = { ...JOB_RECENT, options };
  return {
    listJobs:             () => [job],
    resolveRouteFor:      () => null,
    getDownloadDirectory: () => '/tmp',
    readManifest:         manifestReaderFor({
      [job.order_number]: {
        jobs: [{ jobId: String(jobId), images: [{ filename: 'IMG_0001.jpg', quantity: 1 }] }],
      },
    }),
  };
}

// ── sampleOptionNames ───────────────────────────────────────────────────

test('M8 sampleOptionNames: real job returns option NAMES in array order', async () => {
  const out = await buildFolderCopyPreview({}, fixtureRealJobWithOptions([
    { name: 'finish-options', value: 'lustre' },
    { name: 'photo',          value: 'db:203545638' },
  ]));
  assert.equal(out.source.kind, 'any-manifest');
  assert.deepEqual(out.sampleOptionNames, ['finish-options', 'photo']);
});

test('M8 sampleOptionNames: synthetic sample returns synthetic option names', async () => {
  const out = await buildFolderCopyPreview({}, NO_JOBS_DEPS);
  assert.equal(out.source.kind, 'synthetic');
  // SYNTHETIC_JOB is frozen with { finish-options, layout-options }.
  assert.deepEqual(out.sampleOptionNames, ['finish-options', 'layout-options']);
});

test('M8 sampleOptionNames: hyphens preserved so chip insertion produces valid {option:...} tokens', async () => {
  // The renderer wraps each name as `{option:${name}}`. The template-
  // tokens resolver already accepts any character except `}` inside the
  // capture, so hyphens work end-to-end. Locking here that the NAME
  // itself doesn't get mangled on the way through the preview module.
  const out = await buildFolderCopyPreview({}, fixtureRealJobWithOptions([
    { name: 'finish-options',  value: 'lustre' },
    { name: 'border-options',  value: '0.25in' },
    { name: 'foam-core-mount', value: 'yes' },
  ]));
  assert.deepEqual(out.sampleOptionNames, ['finish-options', 'border-options', 'foam-core-mount']);
});

test('M8 sampleOptionNames: whitespace-only or missing names filtered out (defensive)', async () => {
  const out = await buildFolderCopyPreview({}, fixtureRealJobWithOptions([
    { name: 'finish-options', value: 'lustre' },
    { name: '   ',            value: 'noise' },
    { name: '',               value: 'more' },
    { value: 'nameless' },
  ]));
  assert.deepEqual(out.sampleOptionNames, ['finish-options']);
});

test('M8 sampleOptionNames: empty options array yields []', async () => {
  const out = await buildFolderCopyPreview({}, fixtureRealJobWithOptions([]));
  assert.deepEqual(out.sampleOptionNames, []);
});

// ── Machine-value classifier ────────────────────────────────────────────

test('M8 _looksLikeMachineValue: db: prefix (case-insensitive) is machine', () => {
  for (const v of ['db:203545638', 'DB:12345', 'Db:abc', '  db:trimmed  ']) {
    assert.equal(_looksLikeMachineValue(v), true, `${JSON.stringify(v)} should be machine`);
  }
});

test('M8 _looksLikeMachineValue: all-digits length > 8 is machine', () => {
  assert.equal(_looksLikeMachineValue('123456789'),    true,  'length 9 = machine');
  assert.equal(_looksLikeMachineValue('1234567890'),   true,  'length 10 = machine');
  assert.equal(_looksLikeMachineValue('12345678'),     false, 'length 8 = borderline, NOT machine');
  assert.equal(_looksLikeMachineValue('123'),          false, 'short numeric = size, not machine');
  assert.equal(_looksLikeMachineValue('12x18'),        false, 'has non-digit = not all-digits');
});

test('M8 _looksLikeMachineValue: readable values are NOT machine', () => {
  for (const v of ['lustre', 'full-bleed', '0.25in', 'MetalPrint 16x20', 'yes', '']) {
    assert.equal(_looksLikeMachineValue(v), false, `${JSON.stringify(v)} should not be machine`);
  }
});

test('M8 _looksLikeMachineValue: non-string is not machine (defensive)', () => {
  for (const v of [null, undefined, 123456789, {}, []]) {
    assert.equal(_looksLikeMachineValue(v), false);
  }
});

// ── Machine-value warning on the preview ────────────────────────────────

test('M8 warning: {options} + db: value → machine-value warning fires and names the fix', async () => {
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{jobId}_{options}', outputPath: '/x' },
    fixtureRealJobWithOptions([{ name: 'photo', value: 'db:203545638' }]),
  );
  const warn = out.warnings.find(w => w.kind === 'machine-value');
  assert.ok(warn, 'machine-value warning must fire for a db: option value');
  // Wording NAMES the fix — same posture as the auto-suffix warning.
  assert.match(warn.text, /\{option:NAME\}/);
  // The offending option is named in the warning so the operator can
  // spot it immediately.
  assert.match(warn.text, /photo=db:203545638/);
});

test('M8 warning: {options} + long numeric value → machine-value warning fires', async () => {
  const out = await buildFolderCopyPreview(
    { filenameTemplate: 'x_{options}', outputPath: '/x' },
    fixtureRealJobWithOptions([{ name: 'variant-id', value: '9876543210' }]),
  );
  const warn = out.warnings.find(w => w.kind === 'machine-value');
  assert.ok(warn, 'long numeric option value must trigger the warning');
});

test('M8 warning: lustre is NOT flagged as machine-shaped', async () => {
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{jobId}_{options}', outputPath: '/x' },
    fixtureRealJobWithOptions([{ name: 'finish-options', value: 'lustre' }]),
  );
  const warn = out.warnings.find(w => w.kind === 'machine-value');
  assert.equal(warn, undefined, 'a plain readable value must NOT trigger the warning');
});

test('M8 warning: template without {options} → warning does NOT fire even on a db: option value', async () => {
  // The fix is "use {option:NAME}" — if the operator already isn't using
  // {options} there is nothing to warn about.
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{jobId}_{index}', outputPath: '/x' },
    fixtureRealJobWithOptions([{ name: 'photo', value: 'db:203545638' }]),
  );
  const warn = out.warnings.find(w => w.kind === 'machine-value');
  assert.equal(warn, undefined,
    'no machine-value warning when the template does not use {options}');
});

test('M8 warning: template uses {option:NAME} for the machine value (not {options}) → no warning', async () => {
  // Belt-and-braces: {option:photo} is a per-option lookup, not the
  // whole-set join. That's the fix the warning was pointing at — using
  // it should silence the warning.
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{jobId}_{option:photo}', outputPath: '/x' },
    fixtureRealJobWithOptions([{ name: 'photo', value: 'db:203545638' }]),
  );
  const warn = out.warnings.find(w => w.kind === 'machine-value');
  assert.equal(warn, undefined,
    'per-option lookup ({option:NAME}) is not the {options} join and must not fire the warning');
});

test('M8 warning: names ALL machine-shaped values when there are several', async () => {
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{options}', outputPath: '/x' },
    fixtureRealJobWithOptions([
      { name: 'finish-options', value: 'lustre' },      // readable — not named
      { name: 'photo',          value: 'db:203545638' },// machine — named
      { name: 'variant-id',     value: '9876543210' },  // machine — named
    ]),
  );
  const warn = out.warnings.find(w => w.kind === 'machine-value');
  assert.ok(warn);
  assert.match(warn.text, /photo=db:203545638/);
  assert.match(warn.text, /variant-id=9876543210/);
  // lustre is readable — must NOT appear in the warning.
  assert.doesNotMatch(warn.text, /lustre/,
    'readable values must not be named in the warning; only machine-shaped ones');
});

test('M8 warning: synthetic sample never triggers machine-value (its options are readable)', async () => {
  const out = await buildFolderCopyPreview(
    { filenameTemplate: '{options}', outputPath: '/x' },
    NO_JOBS_DEPS,
  );
  assert.equal(out.source.kind, 'synthetic');
  const warn = out.warnings.find(w => w.kind === 'machine-value');
  assert.equal(warn, undefined, 'SYNTHETIC_JOB carries only readable option values');
});
