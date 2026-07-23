'use strict';

/**
 * M5b regression tests — batch crop pipeline.
 *
 * Run via:
 *   npm test
 *
 * Coverage:
 *   1. Unit: `_fractionalToPixelRect` at multiple image dimensions +
 *      clamping behaviour.
 *   2. Integration: 5+ image manual job, batch-apply with a fractional
 *      rect, asserts production files land in working/, sidecar gains
 *      the full M5b field set, raw uploads byte-identical, progress
 *      callback fires per-image, job-level batchCropDefault* persisted.
 *   3. Continue-best-effort failure policy: per-image failures don't
 *      abort the batch.
 *   4. Safety belt: 10 consecutive same-error-code → abort.
 *   5. Idempotency: already-cropped images are skipped (defensive).
 *   6. M5a regression sanity: a one-image batch behaves the same as
 *      ohd:job:crop-image (the shared primitive contract).
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs/promises');
const fssync  = require('node:fs');
const path    = require('node:path');
const os      = require('node:os');

const {
  applyBatchCrop,
  _applyCropToSingleImage,
  resolveTargetSize,
  CONSECUTIVE_SAME_ERROR_LIMIT,
} = require('../../jobs/batchCropActions');
// 2026-05-25: math helpers now live in /shared and the storage model
// is { centerX, centerY, scale } + sizeOption + orientation. The old
// { x, y, w, h } fractional rect tests have been superseded.
const {
  effectiveAspect,
  maxFitAreaFraction,
  minScaleForArea,
  computeAspectLockedSpec,
  clampSpec,
  specToOverlayLayout,
  specToPixelRect,
  resizeSpecFromHandle,
} = require('../../../shared/cropRectMath');
const { createImageEntry, createSidecar } = require('../../../shared/jobSchema');
const sidecarManager = require('../../jobs/sidecarManager');

// Real sharp — node:test boots without Electron. Same approach as M5a's
// manualCrop.test.js: write actual JPEGs into a tempdir + exercise the
// real sharp pipeline.
const sharp = require('sharp');

// ─── Fixture helpers ────────────────────────────────────────────────────────

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {},
};

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'm5b-batch-'));
}

async function writeJpeg(destPath, { width, height, r = 200, g = 100, b = 50 } = {}) {
  await sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  }).jpeg({ quality: 90 }).toFile(destPath);
}

/**
 * Build a manual-source job folder ready for batch-apply:
 *
 *   {jobPath}/{filename}           ← raw audit copies (M1 download shape)
 *   {jobPath}/working/{filename}   ← what ensureWorkingSetup would mirror
 *   {jobPath}/{jobId}.json         ← sidecar with manual-source entries
 *
 * Each image gets its own dimensions so the fractional → pixel scaling
 * test can verify divergent absolute rects.
 */
async function setupManualBatchJob(downloadDir, {
  orderNumber = 'POS-M5B',
  orderId     = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  jobId       = '11111111-2222-3333-4444-555555555555',
  images      = [
    { filename: 'a.jpg', width: 200, height: 150 },
    { filename: 'b.jpg', width: 200, height: 150 },
    { filename: 'c.jpg', width: 200, height: 150 },
    { filename: 'd.jpg', width: 200, height: 150 },
    { filename: 'e.jpg', width: 200, height: 150 },
  ],
} = {}) {
  const jobFolderName = `${orderNumber}_${jobId}`;
  const jobPath = path.join(downloadDir, `${orderNumber}_${orderId}`, jobFolderName);
  await fs.mkdir(path.join(jobPath, 'working'), { recursive: true });

  const flatBytes = new Map();
  const sidecarImages = [];
  for (const img of images) {
    const flatPath    = path.join(jobPath, img.filename);
    const workingPath = path.join(jobPath, 'working', img.filename);
    await writeJpeg(flatPath, img);
    await fs.copyFile(flatPath, workingPath);
    flatBytes.set(img.filename, await fs.readFile(flatPath));

    sidecarImages.push(createImageEntry(img.filename, 1, null, {
      artworkFileId:    `id-${img.filename}`,
      artworkSource:    'manual',
      artworkType:      'optimized',
      productionReady:  true,
      originalFileName: img.filename,
      copies:           1,
    }));
  }
  const sidecar = createSidecar(jobFolderName, sidecarImages);
  const sidecarPath = path.join(jobPath, `${jobFolderName}.json`);
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
  return { jobPath, sidecarPath, sidecarJobId: jobFolderName, sidecar, flatBytes, jobFolderName };
}

// ─── 1. Unit: specToPixelRect — new spec model (2026-05-25 rewrite) ────────
//
// The pre-rewrite tests exercised `_fractionalToPixelRect({x,y,w,h})`.
// That model rendered the overlay at the IMGBOX's aspect (so a square
// 8×8 target on a landscape image surfaced as a landscape overlay).
// The new {centerX, centerY, scale} spec computes pixel rects at the
// TARGET aspect — square targets give square crops regardless of
// source aspect.

test('specToPixelRect: square target on landscape image → square pixel rect, centered (locks the 8×8 bug)', () => {
  const r = specToPixelRect(
    { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    { w: 8, h: 8 }, 'landscape', 800, 600,
  );
  // imageAspect = 4/3 ≈ 1.333; effAspect = 1 (square).
  // maxFitW = min(800, 600 × 1) = 600. maxFitH = 600. scale=1 → 600×600.
  // Centered: x = (800-600)/2 = 100, y = (600-600)/2 = 0.
  assert.equal(r.w, 600, 'square target must produce square pixel width');
  assert.equal(r.h, 600, 'square target must produce square pixel height');
  assert.equal(r.x, 100, 'centered horizontally within landscape image');
  assert.equal(r.y, 0,   'centered vertically');
});

test('specToPixelRect: 4×6 portrait orientation on landscape image → tall narrow pixel rect', () => {
  const r = specToPixelRect(
    { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    { w: 4, h: 6 }, 'portrait', 800, 600,
  );
  // effAspect = min(4/6, 6/4) = 0.667. maxFitH = min(600, 800/0.667) = min(600, 1199) = 600.
  // maxFitW = 600 × 0.667 = 400. scale=1 → 400×600.
  assert.equal(r.w, 400);
  assert.equal(r.h, 600);
  assert.equal(r.x, 200); // (800-400)/2
  assert.equal(r.y, 0);
});

test('specToPixelRect: 4×6 landscape orientation on portrait image → wide pixel rect, height-bound', () => {
  const r = specToPixelRect(
    { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    { w: 4, h: 6 }, 'landscape', 600, 800,
  );
  // effAspect = max(4/6, 6/4) = 1.5. maxFitW = min(600, 800 × 1.5) = 600.
  // maxFitH = 600 / 1.5 = 400. scale=1 → 600×400.
  assert.equal(r.w, 600);
  assert.equal(r.h, 400);
  assert.equal(r.x, 0);
  assert.equal(r.y, 200); // (800-400)/2
});

test('specToPixelRect: scale < 1.0 scales the maxFit rect proportionally', () => {
  const r = specToPixelRect(
    { centerX: 0.5, centerY: 0.5, scale: 0.5 },
    { w: 8, h: 8 }, 'landscape', 800, 600,
  );
  // Square maxFit is 600×600; scale=0.5 → 300×300, centered.
  assert.equal(r.w, 300);
  assert.equal(r.h, 300);
  assert.equal(r.x, 250); // (800 - 300) / 2
  assert.equal(r.y, 150); // (600 - 300) / 2
});

test('specToPixelRect: off-center spec stays inside image bounds (slide-inward)', () => {
  // centerX = 0.9 with a 600×600 maxFit on 800px-wide image would
  // place rect at x = 720 - 300 = 420, x + w = 1020 > 800. Must slide
  // back to x = 200 so x + w = 800.
  const r = specToPixelRect(
    { centerX: 0.9, centerY: 0.5, scale: 1.0 },
    { w: 8, h: 8 }, 'landscape', 800, 600,
  );
  // maxFit = 600×600. Without clamp x = 0.9*800 - 300 = 420; clamp slides to 800-600=200.
  assert.equal(r.x, 200);
  assert.equal(r.w, 600);
  // Should remain square.
  assert.equal(r.h, 600);
});

test('specToPixelRect: produces minimum 1×1 (defensive against degenerate spec)', () => {
  const r = specToPixelRect(
    { centerX: 0.5, centerY: 0.5, scale: 0 },
    { w: 8, h: 8 }, 'landscape', 100, 100,
  );
  assert.ok(r.w >= 1);
  assert.ok(r.h >= 1);
});

// ─── 2. Integration: 5-image batch happy path ───────────────────────────────

test('M5b integration: 5-image batch — all production files land in working/, full M5b sidecar fields persisted', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const ctx = await setupManualBatchJob(dl);
  // 2026-05-25 spec rewrite: payload now {fractionalSpec, sizeOption, orientation}.
  // 200×150 landscape source + 4×6 landscape target (aspect 1.5):
  //   effAspect = 1.5, imageAspect = 200/150 ≈ 1.333
  //   maxFitW = min(200, 150×1.5) = min(200, 225) = 200
  //   maxFitH = 200 / 1.5 ≈ 133.33
  //   scale=1.0 → 200×133, centered. centerX=0.5, centerY=0.5.
  const fractionalSpec = { centerX: 0.5, centerY: 0.5, scale: 1.0 };
  const sizeOption     = { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' };
  const progressCalls  = [];

  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'],
    fractionalSpec,
    sizeOption,
    orientation:    'landscape',
    channelMappingId: 'test-mapping',
    onProgress:     (p) => progressCalls.push(p),
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, true);
  assert.equal(result.succeeded.length, 5, 'all 5 images must succeed');
  assert.equal(result.failed.length,    0);
  assert.equal(result.skipped.length,   0);

  // Production files exist in working/, each at the TARGET aspect (1.5).
  for (const fn of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']) {
    const meta = await sharp(path.join(ctx.jobPath, 'working', fn)).metadata();
    assert.equal(meta.width,  200, `${fn}: width = maxFitW for landscape 4×6 on 200×150 source`);
    assert.equal(meta.height, 133, `${fn}: height = round(maxFitW / 1.5)`);
    assert.equal(meta.format, 'jpeg');
    // Aspect ratio holds (within rounding tolerance).
    const aspect = meta.width / meta.height;
    assert.ok(Math.abs(aspect - 1.5) < 0.02, `${fn}: cropped aspect ${aspect} must equal target 1.5`);

    // Raw upload at the flat root is byte-identical to before.
    const after = await fs.readFile(path.join(ctx.jobPath, fn));
    assert.deepEqual(after, ctx.flatBytes.get(fn),
      `${fn}: raw upload at flat root MUST remain byte-identical (audit copy)`);
  }

  // Sidecar — read from disk to lock the persisted shape.
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  for (const entry of onDisk.images) {
    // M5a fields:
    assert.equal(entry.cropApplied, true,                            `${entry.filename}: cropApplied`);
    assert.equal(typeof entry.croppedPath, 'string',                  `${entry.filename}: croppedPath set`);
    assert.equal(entry.croppedPath, path.join(ctx.jobPath, 'working', entry.filename));
    // cropRect is the actual PIXEL rect that sharp.extract used.
    assert.equal(entry.cropRect.w, 200, `${entry.filename}: cropRect.w (full maxFit width)`);
    assert.equal(entry.cropRect.h, 133, `${entry.filename}: cropRect.h (height-bound by target aspect)`);
    assert.equal(entry.channelMappingId, 'test-mapping',              `${entry.filename}: channelMappingId persisted`);
    // M5b flat siblings:
    assert.equal(entry.cropOrientation, 'landscape',                  `${entry.filename}: cropOrientation`);
    assert.equal(entry.cropSource,      'batch',                      `${entry.filename}: cropSource = batch`);
    assert.equal(typeof entry.cropAppliedAt, 'string',                `${entry.filename}: cropAppliedAt set`);
    assert.ok(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'].includes(entry.filename),
      `${entry.filename}: filename stays the original basename`);
  }

  // Job-level telemetry. Manual Crop redesign (2026-06-01): the two
  // batchCropDefault* fields were removed from the schema when per-image
  // pending state replaced the shared spec, so applyBatchCrop only stamps
  // the last-applied timestamp now. The two removed fields must NOT be
  // re-introduced by applyBatchCrop — sidecarManager.js Reconcile E would
  // just drop them again on next load.
  assert.equal(typeof onDisk.batchCropLastAppliedAt, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'batchCropDefaultRect'),        false,
    'batchCropDefaultRect must not be re-written by applyBatchCrop (redesign 2026-06-01)');
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'batchCropDefaultOrientation'), false,
    'batchCropDefaultOrientation must not be re-written by applyBatchCrop (redesign 2026-06-01)');

  // Progress callback fired 5 times, monotonic increasing completed counts.
  assert.equal(progressCalls.length, 5);
  for (let i = 0; i < progressCalls.length; i++) {
    assert.equal(progressCalls[i].total, 5);
    assert.equal(progressCalls[i].completed, i + 1);
    assert.equal(progressCalls[i].ok, true);
  }
});

// ─── 3. Mixed-dimension images: per-image pixel rects diverge ──────────────

test('M5b integration: mixed-dimension images — TARGET aspect (square) produces square crop on every source regardless of source aspect (locks the 8×8 bug)', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  // Five images at different aspects. Same square target → every
  // crop must be square (regression lock for the live-test bug
  // where a 4:3 source produced a 4:3 overlay/crop on an 8×8
  // square target).
  const ctx = await setupManualBatchJob(dl, {
    images: [
      { filename: 'small.jpg',    width: 100,  height: 100 },   // square
      { filename: 'wide.jpg',     width: 800,  height: 200 },   // 4:1 landscape
      { filename: 'tall.jpg',     width: 200,  height: 800 },   // 1:4 portrait
      { filename: 'big.jpg',      width: 2000, height: 1500 },  // 4:3 landscape
      { filename: 'p43.jpg',      width: 1500, height: 2000 },  // 3:4 portrait
    ],
  });

  const fractionalSpec = { centerX: 0.5, centerY: 0.5, scale: 1.0 };
  const sizeOption     = { id: 'cm_8x8', w: 8, h: 8, label: '8×8"' };
  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['small.jpg', 'wide.jpg', 'tall.jpg', 'big.jpg', 'p43.jpg'],
    fractionalSpec,
    sizeOption,
    orientation:    'landscape',  // moot for square targets
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, true);
  assert.equal(result.succeeded.length, 5);

  // Each cropped file is SQUARE (target aspect = 1), with side =
  // min(sourceW, sourceH).
  const expected = new Map([
    ['small.jpg',  100],   // already square
    ['wide.jpg',   200],   // min(800, 200) = 200
    ['tall.jpg',   200],   // min(200, 800) = 200
    ['big.jpg',    1500],  // min(2000, 1500) = 1500
    ['p43.jpg',    1500],  // min(1500, 2000) = 1500
  ]);
  for (const [fn, side] of expected) {
    const meta = await sharp(path.join(ctx.jobPath, 'working', fn)).metadata();
    assert.equal(meta.width,  side, `${fn}: width must be ${side} (square target on any-aspect source)`);
    assert.equal(meta.height, side, `${fn}: height must be ${side} (square target on any-aspect source)`);
    assert.equal(meta.width, meta.height,
      `${fn}: cropped output MUST be square for 8×8 target — regression lock for the live-test bug`);
  }
});

// ─── 4. Idempotency: already-cropped filenames are skipped ──────────────────

test('M5b integration: idempotent — already-cropped images are skipped (defensive)', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const ctx = await setupManualBatchJob(dl);

  // First batch: crop a + b.
  const first = await applyBatchCrop({
    jobPath:     ctx.jobPath,
    sidecar:     ctx.sidecar,
    filenames:   ['a.jpg', 'b.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation: 'landscape',
    deps:        { logger: silentLogger },
  });
  assert.equal(first.succeeded.length, 2);

  // Second batch on the SAME filenames + fresh c-e — should skip a,b
  // and process c,d,e fresh.
  const second = await applyBatchCrop({
    jobPath:     ctx.jobPath,
    sidecar:     first.sidecar,
    filenames:   ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation: 'landscape',
    deps:        { logger: silentLogger },
  });
  assert.equal(second.succeeded.length, 3, 'only c/d/e should crop fresh');
  assert.equal(second.skipped.length,   2, 'a/b should be skipped');
  for (const s of second.skipped) {
    assert.equal(s.reason, 'already-cropped');
    assert.ok(['a.jpg', 'b.jpg'].includes(s.filename));
  }
});

// ─── 5. Continue-best-effort: a missing-source failure doesn't stop the batch ──

test('M5b integration: per-image SOURCE_MISSING failure is recorded but does NOT abort the batch (continue-best-effort)', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const ctx = await setupManualBatchJob(dl);

  // Sabotage one image's source files (both working/ and flat) so the
  // crop primitive cannot find them. Continue-best-effort policy means
  // images BEFORE and AFTER the failure must still process.
  await fs.unlink(path.join(ctx.jobPath, 'working', 'c.jpg'));
  await fs.unlink(path.join(ctx.jobPath, 'c.jpg'));

  const result = await applyBatchCrop({
    jobPath:     ctx.jobPath,
    sidecar:     ctx.sidecar,
    filenames:   ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation: 'landscape',
    deps:        { logger: silentLogger },
  });

  assert.equal(result.success, true,
    'overall result is success: true even with a per-image failure (continue-best-effort)');
  assert.equal(result.succeeded.length, 4, 'a/b/d/e succeed; c fails');
  assert.equal(result.failed.length,    1);
  assert.equal(result.failed[0].filename, 'c.jpg');
  assert.equal(result.failed[0].errorCode, 'SOURCE_MISSING');
  assert.equal(result.aborted, undefined,
    'a single per-image failure must NOT trigger the safety belt abort');

  // a / b / d / e all cropped on disk at the target aspect (1.5).
  // 200×150 source + landscape 4×6 target: 200×133 pixel rect.
  for (const fn of ['a.jpg', 'b.jpg', 'd.jpg', 'e.jpg']) {
    const meta = await sharp(path.join(ctx.jobPath, 'working', fn)).metadata();
    assert.equal(meta.width,  200);
    assert.equal(meta.height, 133);
  }
});

// ─── 6. Safety belt: 10 consecutive same-error abort ────────────────────────

test('M5b integration: safety belt — 10 consecutive same error.code aborts the remainder', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  // 15 images, ALL missing their sources. After 10 consecutive
  // SOURCE_MISSING failures the batch aborts; images 11-15 are
  // untouched (no failed entry — they were never attempted).
  const images = Array.from({ length: 15 }, (_, i) => ({
    filename: `img-${String(i + 1).padStart(2, '0')}.jpg`,
    width: 100, height: 100,
  }));
  const ctx = await setupManualBatchJob(dl, { images });

  // Sabotage ALL sources so every attempt fails SOURCE_MISSING.
  for (const img of images) {
    await fs.unlink(path.join(ctx.jobPath, 'working', img.filename));
    await fs.unlink(path.join(ctx.jobPath, img.filename));
  }

  const result = await applyBatchCrop({
    jobPath:     ctx.jobPath,
    sidecar:     ctx.sidecar,
    filenames:   images.map((i) => i.filename),
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation: 'landscape',
    deps:        { logger: silentLogger },
  });

  assert.equal(result.success, true);
  assert.equal(result.failed.length, CONSECUTIVE_SAME_ERROR_LIMIT,
    `safety belt must abort after ${CONSECUTIVE_SAME_ERROR_LIMIT} consecutive same-error failures — got ${result.failed.length}`);
  assert.ok(result.aborted, 'aborted info must be present');
  assert.equal(result.aborted.reason, 'consecutive-same-error');
  assert.equal(result.aborted.errorCode, 'SOURCE_MISSING');
  assert.equal(result.aborted.count, CONSECUTIVE_SAME_ERROR_LIMIT);
});

// ─── 7. Safety belt does NOT trip when failures are interleaved with successes ──

test('M5b integration: safety belt counter resets on success — interleaved failures do not trip abort', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  // 12 images alternating success / failure. The 12 entries include 6
  // failures total but NO consecutive run reaches the threshold —
  // every failure is followed by a success that resets the counter.
  const images = Array.from({ length: 12 }, (_, i) => ({
    filename: `img-${String(i + 1).padStart(2, '0')}.jpg`,
    width: 100, height: 100,
  }));
  const ctx = await setupManualBatchJob(dl, { images });

  // Sabotage every other image's source.
  for (let i = 0; i < images.length; i += 2) {
    await fs.unlink(path.join(ctx.jobPath, 'working', images[i].filename));
    await fs.unlink(path.join(ctx.jobPath, images[i].filename));
  }

  const result = await applyBatchCrop({
    jobPath:     ctx.jobPath,
    sidecar:     ctx.sidecar,
    filenames:   images.map((i) => i.filename),
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation: 'landscape',
    deps:        { logger: silentLogger },
  });

  assert.equal(result.success, true);
  assert.equal(result.succeeded.length, 6, 'every alternate image should succeed');
  assert.equal(result.failed.length,    6, 'every other should fail');
  assert.equal(result.aborted, undefined,
    'no consecutive run hits the safety belt threshold — must NOT abort');
});

// ─── 8. M5a regression sanity: single-image batch behaves like per-image ────

test('M5b regression: single-image batch passes through the shared primitive with the M5a contract intact', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const ctx = await setupManualBatchJob(dl, {
    images: [{ filename: 'only.jpg', width: 200, height: 150 }],
  });

  const result = await applyBatchCrop({
    jobPath:     ctx.jobPath,
    sidecar:     ctx.sidecar,
    filenames:   ['only.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation: 'landscape',
    deps:        { logger: silentLogger },
  });

  assert.equal(result.success, true);
  assert.equal(result.succeeded.length, 1);

  // Sidecar shape mirrors M5a's plus the M5b flat siblings.
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const entry = onDisk.images[0];
  // M5a:
  assert.equal(entry.cropApplied, true);
  assert.equal(entry.filename, 'only.jpg');
  assert.equal(entry.croppedPath, path.join(ctx.jobPath, 'working', 'only.jpg'));
  // 200×150 source + landscape 4×6 target + spec {0.5, 0.5, 1.0}:
  //   effAspect=1.5, maxFitW=min(200, 150*1.5)=200, maxFitH=200/1.5≈133
  //   centered → x=0, y=(150-133)/2=8 (rounded), w=200, h=133.
  assert.deepEqual(entry.cropRect, { x: 0, y: 8, w: 200, h: 133 });
  // M5b:
  assert.equal(entry.cropOrientation, 'landscape');
  assert.equal(entry.cropSource,      'batch');
});

// ─── 9. _applyCropToSingleImage cropSource defaults to 'per-image' ──────────

test('M5b primitive: _applyCropToSingleImage defaults cropSource to "per-image" so the per-image IPC distinguishes from batch', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const ctx = await setupManualBatchJob(dl, {
    images: [{ filename: 'solo.jpg', width: 200, height: 150 }],
  });

  const result = await _applyCropToSingleImage({
    jobPath:  ctx.jobPath,
    sidecar:  ctx.sidecar,
    filename: 'solo.jpg',
    cropRect: { x: 30, y: 20, w: 100, h: 80 },
    channelMappingId: null,
    // cropSource intentionally omitted — must default to 'per-image'
    deps: { logger: silentLogger },
  });

  assert.equal(result.success, true);

  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const entry = onDisk.images[0];
  assert.equal(entry.cropSource, 'per-image',
    'default cropSource must be "per-image" so the M5a per-image IPC sets this correctly when batchCropActions._applyCropToSingleImage is called as the M5a primitive');
});

// ─── 10. Sidecar Reconcile D hydration: legacy entries get M5b nulls ────────

test('M5b sidecar: Reconcile D adds M5b null defaults to legacy entries without spurious save', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const orderFolderName = 'POS-LEG_orderid';
  const jobFolderName   = 'POS-LEG_jobid';
  const jobPath         = path.join(dl, orderFolderName, jobFolderName);
  await fs.mkdir(path.join(jobPath, 'working'), { recursive: true });

  // Hand-crafted legacy sidecar — pre-M5b (no cropOrientation/Source/AppliedAt/Rotation,
  // no batchCropDefault* at top level).
  const legacy = {
    jobId: jobFolderName,
    schemaVersion: 1,
    createdAt:  '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    reprintOf:  null,
    s3ArtworkFileIdsKnown: [],
    images: [{
      filename: 'legacy.jpg',
      qtyOriginal: 1, qtyCurrent: 1,
      corrections: { cyan: 0, magenta: 0, yellow: 0 },
      reprint: false, reprintJobId: null,
      enhanced: false, enhancementSource: null, enhancedPath: null, enhancedAt: null, enhancementModel: null,
      integritySuspect: null,
      aiQuality: {
        scored: false, score: null, thresholdAtScoreTime: null, passed: true,
        modelVersion: null, inferenceMs: null, scoredAt: null, error: null,
        fixupHistory: [], operatorDecision: { kind: 'none', decidedAt: null, note: null },
      },
      originalFilename: null, recropPath: null, recropOf: null, recroppedAt: null,
      // No M5b fields.
    }],
  };
  const sidecarPath = path.join(jobPath, `${jobFolderName}.json`);
  await fs.writeFile(sidecarPath, JSON.stringify(legacy, null, 2), 'utf8');
  const before = await fs.readFile(sidecarPath, 'utf8');

  const { sidecar } = await sidecarManager.loadSidecar(jobFolderName, jobPath);

  // In-memory hydration applied. M5b per-image flat siblings:
  assert.equal(sidecar.images[0].cropOrientation,           null);
  assert.equal(sidecar.images[0].cropSource,                null);
  assert.equal(sidecar.images[0].cropAppliedAt,             null);
  assert.equal(sidecar.images[0].cropRotation,              null);

  // Manual Crop redesign (2026-06-01): three new per-image pending fields
  // are hydrated to null on legacy entries via the same Reconcile D path.
  assert.equal(sidecar.images[0].pendingCropRect,           null);
  assert.equal(sidecar.images[0].pendingRotation,           null);
  assert.equal(sidecar.images[0].pendingOrientation,        null);

  // Manual Crop redesign (2026-06-02): `discarded` field hydrated to
  // `false` on legacy entries via Reconcile F. Default is `false` (not
  // null) because the contract is boolean — the renderer reads it with
  // strict === true semantics.
  assert.equal(sidecar.images[0].discarded,                 false);

  // Job-level: only batchCropLastAppliedAt survives the redesign.
  // batchCropDefault{Rect,Orientation} are removed from the schema — they
  // are NOT hydrated by Reconcile D, and Reconcile E would drop them from
  // any legacy sidecar that still carries them on disk.
  assert.equal(sidecar.batchCropLastAppliedAt,              null);
  assert.equal(Object.prototype.hasOwnProperty.call(sidecar, 'batchCropDefaultRect'),        false,
    'batchCropDefaultRect must not be hydrated by Reconcile D (redesign 2026-06-01)');
  assert.equal(Object.prototype.hasOwnProperty.call(sidecar, 'batchCropDefaultOrientation'), false,
    'batchCropDefaultOrientation must not be hydrated by Reconcile D (redesign 2026-06-01)');

  // No spurious save — the on-disk bytes must NOT change.
  const after = await fs.readFile(sidecarPath, 'utf8');
  assert.equal(after, before,
    'Reconcile D must hydrate IN-MEMORY only — no disk write when only M5b fields are missing. '
    + 'A spurious save here would write every loaded legacy sidecar on every Job Review open, '
    + 'churning modifiedAt and breaking the existing "no spurious save" contract.');
});

// ─── 11. Target-size matcher — three lookup paths (Bug 1 fix, 2026-05-25) ──
//
// The pre-fix matcher tried to compare route.printSizeCode against
// sizeOption.id and sizeOption.label — both wrong-shape (id is always
// `cm_<uuid>` / `dt_<…>` and label is `'4×6"'` with U+00D7 + inch
// mark). Every routed manual job returned 'no-size-translation', breaking
// BatchCropMode in the UI. These tests pin the three-path lookup so a
// regression here resurfaces the same symptom immediately.

// Shape fixtures matching the actual routing-service shapes verbatim.
// DO NOT change without checking against routing-service.js — these
// pretend to be routingService.getAllSizeOptions() output, so the test
// is meaningful only when it mirrors production.
const FIXT_SIZES = [
  // DPOF channel mapping shapes (cm_*).
  { id: 'cm_dpof-4x6',  source: 'dpof', w: 4, h: 6, label: '4×6"', channelMappingId: 'map-4x6',  channelNumber: 1 },
  { id: 'cm_dpof-5x7',  source: 'dpof', w: 5, h: 7, label: '5×7"', channelMappingId: 'map-5x7',  channelNumber: 2 },
  // Darkroom sizeTranslation shapes (dt_*).
  { id: 'dt_DR1_POS',   source: 'darkroom', w: 4, h: 6, label: '4×6"',  darkroomSize: '4x6',   darkroomControllerId: 'DR1', productCodePrefix: 'POS' },
  { id: 'dt_DR1_ENL',   source: 'darkroom', w: 8, h: 10, label: '8×10"', darkroomSize: '8x10', darkroomControllerId: 'DR1', productCodePrefix: 'ENL' },
];

const FIXT_CHANNEL_MAPPINGS = [
  { id: 'map-4x6', controllerId: 'CTRL_DPOF1', productCode: 'POS-4X6', options: [], channelNumber: 1, size: '4x6'  },
  { id: 'map-5x7', controllerId: 'CTRL_DPOF1', productCode: 'POS-5X7', options: [], channelNumber: 2, size: '5x7'  },
];

const FIXT_CONTROLLERS = [
  { id: 'CTRL_DPOF1', type: 'dpof',        name: 'Noritsu 1', outputPath: '/tmp/dpof' },
  {
    id: 'DR1', type: 'darkroompro', name: 'Darkroom A', outputPath: '/tmp/dr',
    sizeTranslations: [
      { productCodePrefix: 'POS', darkroomSize: '4x6'  },
      { productCodePrefix: 'ENL', darkroomSize: '8x10' },
    ],
  },
];

function makeDeps(overrides = {}) {
  return {
    resolveRoute:       overrides.resolveRoute,
    getAllSizeOptions:  overrides.getAllSizeOptions  || (() => FIXT_SIZES),
    getChannelMappings: overrides.getChannelMappings || (() => FIXT_CHANNEL_MAPPINGS),
    getControllers:     overrides.getControllers     || (() => FIXT_CONTROLLERS),
    logger:             silentLogger,
  };
}

test('M5b matcher: Path 1 — DPOF route resolves via controllerId+channelNumber → channelMapping → sizeOption', () => {
  const job = { product_code: 'POS-4X6', process: 'Lab' };
  const route = {
    type: 'controller',
    controllerType: 'dpof',
    controllerId:   'CTRL_DPOF1',
    channelNumber:  1,
    printSizeCode:  'NML -PSIZE "4x6"',
  };
  const res = resolveTargetSize(job, makeDeps({ resolveRoute: () => route }));
  assert.equal(res.ok, true);
  assert.equal(res.sizeOption.id, 'cm_dpof-4x6');
  assert.equal(res.sizeOption.w,  4);
  assert.equal(res.sizeOption.h,  6);
});

test('M5b matcher: Path 2 — Darkroom route resolves via sizeTranslations productCodePrefix → {w,h} → sizeOption', () => {
  const job = { product_code: 'POS-WHATEVER', process: 'Lab' };
  const route = {
    type: 'controller',
    controllerType: 'darkroompro',
    controllerId:   'DR1',
    channelNumber:  null,    // Darkroom doesn't use channel numbers — Path 1 must NOT match
    printSizeCode:  null,
  };
  const res = resolveTargetSize(job, makeDeps({ resolveRoute: () => route }));
  assert.equal(res.ok, true);
  assert.equal(res.sizeOption.id, 'dt_DR1_POS', 'sizeOption must come from the matched sizeTranslations entry');
  assert.equal(res.sizeOption.w, 4);
  assert.equal(res.sizeOption.h, 6);
});

test('M5b matcher: Path 2 — Darkroom productCodePrefix match is case-insensitive prefix match (POS- under POS prefix)', () => {
  // Common case: prefix is "POS" and job.product_code is "POS-4X6".
  const job = { product_code: 'pos-4x6', process: 'Lab' };
  const route = {
    type: 'controller', controllerType: 'darkroompro',
    controllerId: 'DR1', channelNumber: null, printSizeCode: null,
  };
  const res = resolveTargetSize(job, makeDeps({ resolveRoute: () => route }));
  assert.equal(res.ok, true);
  assert.equal(res.sizeOption.id, 'dt_DR1_POS',
    'lowercase product_code "pos-4x6" should match uppercase prefix "POS" — operator-friendly case insensitivity');
});

test('M5b matcher: Path 3 — fallback regex parse of printSizeCode → {w,h} when Path 1+2 fail', () => {
  // Job with no matching channel mapping (channelNumber 99 doesn't
  // exist in FIXT_CHANNEL_MAPPINGS) and no Darkroom productCodePrefix
  // match (product_code 'XYZ-001' doesn't start with POS/ENL). The
  // fallback regex must extract 4×6 from printSizeCode and find the
  // matching DPOF or Darkroom sizeOption by {w,h}.
  const job = { product_code: 'XYZ-001', process: 'Lab' };
  const route = {
    type: 'controller',
    controllerType: 'dpof',
    controllerId:   'CTRL_DPOF1',
    channelNumber:  99,  // doesn't match any FIXT_CHANNEL_MAPPINGS entry
    printSizeCode:  'NML -PSIZE "4x6"',
  };
  const res = resolveTargetSize(job, makeDeps({ resolveRoute: () => route }));
  assert.equal(res.ok, true,
    'fallback regex must extract 4×6 from `NML -PSIZE "4x6"` and find a sizeOption by {w,h}');
  assert.equal(res.sizeOption.w, 4);
  assert.equal(res.sizeOption.h, 6);
});

test('M5b matcher: Path 3 — fallback handles bare "4x6" (no NML wrapper)', () => {
  const job = { product_code: 'XYZ', process: 'Lab' };
  const route = {
    type: 'controller', controllerType: 'dpof',
    controllerId: 'UNKNOWN', channelNumber: null, printSizeCode: '4x6',
  };
  const res = resolveTargetSize(job, makeDeps({ resolveRoute: () => route }));
  assert.equal(res.ok, true);
  assert.equal(res.sizeOption.w, 4);
  assert.equal(res.sizeOption.h, 6);
});

test('M5b matcher: Path 3 — fallback handles unicode multiplication sign "4×6"', () => {
  const job = { product_code: 'XYZ', process: 'Lab' };
  const route = {
    type: 'controller', controllerType: 'dpof',
    controllerId: 'UNKNOWN', channelNumber: null,
    printSizeCode: '4×6', // U+00D7 multiplication sign — what Darkroom configs sometimes carry
  };
  const res = resolveTargetSize(job, makeDeps({ resolveRoute: () => route }));
  assert.equal(res.ok, true);
  assert.equal(res.sizeOption.w, 4);
  assert.equal(res.sizeOption.h, 6);
});

test('M5b matcher: returns no-size-translation only when ALL three paths fail', () => {
  // Job whose route resolves to a controller, but:
  //   - Path 1: controllerId/channelNumber combination not in mappings
  //   - Path 2: product_code prefix doesn't match any sizeTranslations
  //   - Path 3: printSizeCode is a non-size string ("KG" — Noritsu code, not a dimension)
  // Must return 'no-size-translation' so the UI shows a clean error.
  const job = { product_code: 'CMT-WALLPAPER', process: 'Lab' };
  const route = {
    type: 'controller', controllerType: 'dpof',
    controllerId: 'UNKNOWN_CTRL', channelNumber: 999,
    printSizeCode: 'KG', darkroomSize: null,
  };
  const res = resolveTargetSize(job, makeDeps({ resolveRoute: () => route }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-size-translation');
});

test('M5b matcher: returns unrouted when resolveRoute returns { type: "unrouted" }', () => {
  const res = resolveTargetSize({}, makeDeps({
    resolveRoute: () => ({ type: 'unrouted', reason: 'no-controller' }),
  }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unrouted');
});

test('M5b matcher: returns pdf-or-folder-copy for routes with no print-size dimension', () => {
  for (const ctype of ['folder_copy', 'pdf_copy']) {
    const res = resolveTargetSize({ product_code: 'X' }, makeDeps({
      resolveRoute: () => ({ type: 'controller', controllerType: ctype, controllerId: 'X' }),
    }));
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'pdf-or-folder-copy', `${ctype} must yield pdf-or-folder-copy`);
  }
});

test('M5b matcher: returns error reason (not throw) when resolveRoute throws', () => {
  const res = resolveTargetSize({}, makeDeps({
    resolveRoute: () => { throw new Error('routing-service is dead'); },
  }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'error');
  assert.match(res.error, /routing-service is dead/);
});

test('M5b matcher: returns no-job when job arg is missing — defensive', () => {
  const res = resolveTargetSize(null, makeDeps({ resolveRoute: () => null }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-job');
});

test('M5b matcher: REGRESSION — bare size code "4x6" never matches the wrong-shape sizeOption.id/label (pre-fix bug)', () => {
  // The pre-fix matcher compared route.printSizeCode ("4x6") against
  // sizeOption.id (`cm_dpof-4x6`) and sizeOption.label ("4×6\""). Both
  // wrong-shape, so every job returned no-size-translation. This test
  // exercises a DPOF route that ONLY the new lookup paths can resolve:
  // channelNumber matches → channelMapping match → sizeOption.
  // If the matcher regresses to id/label comparison, Path 1 will fail
  // and this test will too.
  const job = { product_code: 'POS-4X6', process: 'Lab' };
  const route = {
    type: 'controller', controllerType: 'dpof',
    controllerId: 'CTRL_DPOF1', channelNumber: 1,
    printSizeCode: 'NML -PSIZE "4x6"',
  };
  const res = resolveTargetSize(job, makeDeps({ resolveRoute: () => route }));
  assert.equal(res.ok, true,
    'pre-fix matcher returned ok:false here — Path 1 must match via channelMapping. '
    + 'Regression to id/label comparison would resurface the broken-UI symptom from M5b first cut.');
  assert.equal(res.sizeOption.id, 'cm_dpof-4x6');
});

// ─── 12. cropRectMath — new {centerX, centerY, scale} spec helpers ─────────
//
// Storage model rewrite 2026-05-25: the FractionalSpec carries
// {centerX, centerY, scale} (position + size) and the TARGET aspect
// is supplied separately (sizeOption + orientation) at every API
// site. The overlay's on-screen aspect matches the TARGET aspect
// regardless of source-image aspect — the live-test regression
// (8×8 target rendering as 4:3 landscape on a 4:3 source) is locked
// out by the helpers below.

test('cropRectMath: effectiveAspect returns 1 for square targets regardless of orientation', () => {
  assert.equal(effectiveAspect({ w: 8, h: 8 }, 'landscape'), 1);
  assert.equal(effectiveAspect({ w: 8, h: 8 }, 'portrait'),  1);
});

test('cropRectMath: effectiveAspect flips between portrait + landscape for non-square targets', () => {
  const base = 4 / 6;       // ≈ 0.667 — naturally portrait
  assert.ok(Math.abs(effectiveAspect({ w: 4, h: 6 }, 'landscape') - 1.5)   < 1e-9);
  assert.ok(Math.abs(effectiveAspect({ w: 4, h: 6 }, 'portrait')  - base) < 1e-9);
});

test('cropRectMath: effectiveAspect returns null for invalid sizeOption (defensive)', () => {
  assert.equal(effectiveAspect(null,                 'landscape'), null);
  assert.equal(effectiveAspect({ w: 0, h: 4 },       'landscape'), null);
  assert.equal(effectiveAspect({ w: NaN, h: 4 },     'landscape'), null);
});

test('cropRectMath: maxFitAreaFraction = 1 when image and target share aspect', () => {
  // Square target on square image — maxFit IS the image.
  assert.ok(Math.abs(maxFitAreaFraction(1, 1) - 1) < 1e-9);
  // 1.5 target on 1.5 image — same.
  assert.ok(Math.abs(maxFitAreaFraction(1.5, 1.5) - 1) < 1e-9);
});

test('cropRectMath: maxFitAreaFraction < 1 when aspects differ', () => {
  // Square target on 4:3 image (image aspect 1.333) — maxFit is 600×600
  // on an 800×600 image → 360000 / 480000 = 0.75.
  assert.ok(Math.abs(maxFitAreaFraction(1, 4 / 3) - 0.75) < 1e-9);
});

test('cropRectMath: minScaleForArea derives minimum scale for 10% image-area floor', () => {
  // Square target on 4:3 image: maxFit covers 0.75 of image area.
  // For cropped output to be ≥ 0.1 × image area:
  //   scale² × 0.75 ≥ 0.1 → scale ≥ sqrt(0.1/0.75) ≈ 0.365.
  const minS = minScaleForArea(1, 4 / 3, 0.1);
  assert.ok(Math.abs(minS - Math.sqrt(0.1 / 0.75)) < 1e-9);
});

test('cropRectMath: computeAspectLockedSpec produces a centered spec at the given scale', () => {
  const s = computeAspectLockedSpec(0.95);
  assert.equal(s.centerX, 0.5);
  assert.equal(s.centerY, 0.5);
  assert.equal(s.scale,   0.95);
});

test('cropRectMath: specToOverlayLayout — square target on landscape imgbox produces aspect-ratio 1 overlay (LOCKS THE 8×8 BUG)', () => {
  // The renderer applies layout.aspectRatio as the overlay's CSS
  // aspect-ratio. The browser then derives overlay height from
  // overlay width × (1 / aspectRatio). For a square target on a
  // landscape imgbox: aspectRatio = 1, so the overlay is square
  // even though widthFrac/heightFrac are different. THIS is what
  // ensures the 8×8 target shows as a square on screen — the bug
  // fix lives here.
  const layout = specToOverlayLayout(
    { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    { w: 8, h: 8 }, 'landscape',
    4 / 3,                  // imageAspect (landscape)
  );
  assert.ok(layout, 'must return layout for valid spec');
  assert.equal(layout.aspectRatio, 1,
    'aspect-ratio MUST be 1 for an 8×8 target — overlay renders square via CSS aspect-ratio regardless of imgbox aspect. Regression here resurfaces the live-test bug from 2026-05-25.');
  // widthFrac = scale × min(1, effAspect/imageAspect) = 1 × min(1, 1/1.333) = 0.75
  // heightFrac = scale × min(1, imageAspect/effAspect) = 1 × min(1, 1.333/1) = 1.0
  assert.ok(Math.abs(layout.widthFrac  - 0.75) < 1e-9);
  assert.ok(Math.abs(layout.heightFrac - 1.0)  < 1e-9);
});

test('cropRectMath: specToOverlayLayout — portrait 4×6 target on landscape imgbox produces tall narrow overlay (aspect < 1)', () => {
  const layout = specToOverlayLayout(
    { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    { w: 4, h: 6 }, 'portrait',
    4 / 3,
  );
  // effAspect = min(0.667, 1.5) = 0.667 (portrait). aspect-ratio < 1.
  assert.ok(layout.aspectRatio < 1,
    'portrait target must produce aspect-ratio < 1 (taller than wide) regardless of landscape imgbox');
});

test('cropRectMath: clampSpec keeps centerX/centerY inside [0,1] so rect fits in image', () => {
  // centerX = 0.95 with widthFrac of 0.75 (square 8×8 on 4:3 image)
  // means rect would span 0.575 → 1.325 — beyond [0,1]. Clamp must
  // snap centerX to 0.625 (so rect ends at exactly 1.0).
  const s = clampSpec(
    { centerX: 0.95, centerY: 0.5, scale: 1.0 },
    { w: 8, h: 8 }, 'landscape',
    4 / 3, 0.1,
  );
  // widthFrac at scale=1 = 0.75; max centerX = 1 - 0.75/2 = 0.625.
  assert.ok(Math.abs(s.centerX - 0.625) < 1e-9,
    `clampSpec must keep centerX ≤ 1 - widthFrac/2; got ${s.centerX}`);
});

test('cropRectMath: clampSpec enforces minimum scale floor (10% area)', () => {
  const minS = minScaleForArea(1, 1, 0.1);
  const s = clampSpec(
    { centerX: 0.5, centerY: 0.5, scale: 0 },
    { w: 8, h: 8 }, 'landscape', 1.0, 0.1,
  );
  assert.ok(s.scale >= minS - 1e-9,
    `clampSpec must floor scale at minScaleForArea (${minS}); got ${s.scale}`);
});

test('cropRectMath: resizeSpecFromHandle — BR drag preserves anchor TL position', () => {
  // Anchor = TL (0.1, 0.1). BR drag to (0.7, 0.7).
  // sizeOption {w:8,h:8} (square) + imageAspect 1 → effAspect = 1.
  // maxFitWFrac = maxFitHFrac = 1. proposedW = 0.6, proposedH = 0.6.
  // ratio 1 == effAspect 1 → scale = 0.6.
  const s = resizeSpecFromHandle({
    corner: 'br',
    anchor: { x: 0.1, y: 0.1 },
    targetX: 0.7, targetY: 0.7,
    sizeOption: { w: 8, h: 8 }, orientation: 'landscape',
    imageAspect: 1.0, minAreaFraction: 0,
  });
  // After resize, TL of rect must equal anchor:
  //   leftFrac = centerX - widthFrac/2 = anchor.x → centerX = anchor.x + scale/2
  //   For scale=0.6, widthFrac=0.6 → centerX = 0.1 + 0.3 = 0.4.
  assert.ok(Math.abs(s.scale - 0.6)   < 1e-9, `scale ${s.scale} (expected 0.6)`);
  assert.ok(Math.abs(s.centerX - 0.4) < 1e-9, 'TL anchor preserved on X');
  assert.ok(Math.abs(s.centerY - 0.4) < 1e-9, 'TL anchor preserved on Y');
});

test('cropRectMath: resizeSpecFromHandle — aspect-locked, smaller axis bounds the scale', () => {
  // Drag BR with proposed w=0.6, h=0.2. effAspect = 1 (square).
  // sw = 0.6, sh = 0.2; min = 0.2 → scale = 0.2.
  const s = resizeSpecFromHandle({
    corner: 'br',
    anchor: { x: 0, y: 0 },
    targetX: 0.6, targetY: 0.2,
    sizeOption: { w: 8, h: 8 }, orientation: 'landscape',
    imageAspect: 1.0, minAreaFraction: 0,
  });
  assert.ok(Math.abs(s.scale - 0.2) < 1e-9,
    'scale must be bound by the SHORTER drag axis to keep target aspect');
});

test('cropRectMath: resizeSpecFromHandle — enforces 10% min-area floor', () => {
  // Tiny drag on a square-target, square-image → would give scale ≈ 0.05.
  // Min area 0.1 (10%) → min scale = sqrt(0.1) ≈ 0.316.
  const s = resizeSpecFromHandle({
    corner: 'br',
    anchor: { x: 0, y: 0 },
    targetX: 0.05, targetY: 0.05,
    sizeOption: { w: 8, h: 8 }, orientation: 'landscape',
    imageAspect: 1.0, minAreaFraction: 0.1,
  });
  assert.ok(s.scale >= Math.sqrt(0.1) - 1e-9,
    `scale ${s.scale} must be floored at sqrt(0.1) ≈ 0.316 for 10% min-area on a square-on-square setup`);
});

test('cropRectMath: resizeSpecFromHandle — handles each of the 4 corners (anchor on opposite)', () => {
  const sizeOption = { w: 8, h: 8 };
  const orientation = 'landscape';
  const imageAspect = 1.0;
  const minAreaFraction = 0;
  // BR drag → anchor at TL stays put.
  // Already covered above; here verify the OTHER three corners.

  // BL: corner at bottom-left, anchor at TR.
  const bl = resizeSpecFromHandle({
    corner: 'bl', anchor: { x: 0.9, y: 0.1 },
    targetX: 0.3, targetY: 0.7,
    sizeOption, orientation, imageAspect, minAreaFraction,
  });
  // TR of resulting rect = anchor.
  //   TR.x = centerX + widthFrac/2 = anchor.x → centerX = anchor.x - scale/2
  //   TR.y = centerY - heightFrac/2 = anchor.y → centerY = anchor.y + scale/2
  // proposedW=0.6, proposedH=0.6 → scale=0.6 → centerX=0.9-0.3=0.6, centerY=0.1+0.3=0.4.
  assert.ok(Math.abs((bl.centerX + bl.scale / 2) - 0.9) < 1e-9, 'BL drag: TR.x stays at anchor.x');
  assert.ok(Math.abs((bl.centerY - bl.scale / 2) - 0.1) < 1e-9, 'BL drag: TR.y stays at anchor.y');

  // TR: corner at top-right, anchor at BL.
  const tr = resizeSpecFromHandle({
    corner: 'tr', anchor: { x: 0.1, y: 0.9 },
    targetX: 0.7, targetY: 0.3,
    sizeOption, orientation, imageAspect, minAreaFraction,
  });
  assert.ok(Math.abs((tr.centerX - tr.scale / 2) - 0.1) < 1e-9, 'TR drag: BL.x stays at anchor.x');
  assert.ok(Math.abs((tr.centerY + tr.scale / 2) - 0.9) < 1e-9, 'TR drag: BL.y stays at anchor.y');

  // TL: corner at top-left, anchor at BR.
  const tl = resizeSpecFromHandle({
    corner: 'tl', anchor: { x: 0.9, y: 0.9 },
    targetX: 0.3, targetY: 0.3,
    sizeOption, orientation, imageAspect, minAreaFraction,
  });
  assert.ok(Math.abs((tl.centerX + tl.scale / 2) - 0.9) < 1e-9, 'TL drag: BR.x stays at anchor.x');
  assert.ok(Math.abs((tl.centerY + tl.scale / 2) - 0.9) < 1e-9, 'TL drag: BR.y stays at anchor.y');
});

// ─── 13. M5c — rotation baked into the production file (2026-05-26) ─────────
//
// _applyCropToSingleImage now accepts an optional `cropRotation`
// (0/90/180/270, default 0). When 0, the sharp chain MUST be
// byte-identical to the M5a path so the manualCrop regression tests
// stay green. When non-zero, sharp.rotate(N).extract(rect) bakes
// rotation into the output — rect coords are interpreted in
// POST-rotation image space (per the brief).
//
// The cropRotation:0 regression test runs FIRST and the M5c
// implementation aborts if it fails — locking the contract before
// the other rotation values are added.

test('M5c regression: cropRotation:0 byte-identical to no-rotation (M5a contract preserved)', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  // Build two identical jobs side-by-side and crop with EXACTLY the
  // same payload — one through the existing no-rotation path
  // (omit cropRotation), one through the new rotation-0 path
  // (cropRotation: 0). The resulting working/<filename> bytes MUST
  // be byte-identical. A regression here means the sharp pipeline
  // diverged — sharp.rotate(0) is NOT a no-op (it triggers EXIF
  // auto-orient internally) so the implementation must branch on
  // `cropRotation === 0` and call .extract() directly without
  // .rotate() in the chain.
  const ctxA = await setupManualBatchJob(dl, {
    orderNumber: 'POS-ROT0A',
    images: [{ filename: 'rot0.jpg', width: 200, height: 150 }],
  });
  const ctxB = await setupManualBatchJob(dl, {
    orderNumber: 'POS-ROT0B',
    images: [{ filename: 'rot0.jpg', width: 200, height: 150 }],
  });

  const cropRect = { x: 30, y: 20, w: 100, h: 80 };

  // A: existing path — omit cropRotation entirely.
  const resA = await _applyCropToSingleImage({
    jobPath:  ctxA.jobPath,
    sidecar:  ctxA.sidecar,
    filename: 'rot0.jpg',
    cropRect,
    channelMappingId: null,
    cropSource: 'per-image',
    cropAppliedAt: '2026-05-26T12:00:00.000Z',
    deps: { logger: silentLogger },
  });
  assert.equal(resA.success, true);

  // B: M5c path — explicit cropRotation: 0.
  const resB = await _applyCropToSingleImage({
    jobPath:  ctxB.jobPath,
    sidecar:  ctxB.sidecar,
    filename: 'rot0.jpg',
    cropRect,
    channelMappingId: null,
    cropSource: 'per-image',
    cropAppliedAt: '2026-05-26T12:00:00.000Z',
    cropRotation: 0,
    deps: { logger: silentLogger },
  });
  assert.equal(resB.success, true);

  // The LOAD-BEARING ASSERTION: bytes must be identical.
  // Identical source image + identical cropRect + identical sharp
  // chain → identical JPEG output. If sharp.rotate(0) were silently
  // in the chain for the rotation-0 branch, EXIF auto-orient would
  // alter the output bytes.
  const bytesA = await fs.readFile(path.join(ctxA.jobPath, 'working', 'rot0.jpg'));
  const bytesB = await fs.readFile(path.join(ctxB.jobPath, 'working', 'rot0.jpg'));
  assert.deepEqual(bytesA, bytesB,
    'cropRotation:0 must produce byte-identical output to the M5a no-rotation path. '
    + 'A divergence here means the M5c implementation collapsed the rotation:0 branch '
    + 'into a single .rotate(0).extract() chain — sharp.rotate(0) triggers EXIF '
    + 'auto-orient internally and CAN alter output bytes. The implementation must '
    + 'branch explicitly on `rotation === 0` to call .extract() without .rotate().');

  // Sidecar: M5c persists cropRotation: 0 (not null) on every M5c-aware
  // crop so the renderer can distinguish "no rotation applied" from
  // "legacy entry, rotation unknown".
  const sidecarB = JSON.parse(await fs.readFile(ctxB.sidecarPath, 'utf8'));
  assert.equal(sidecarB.images[0].cropRotation, 0,
    'cropRotation persists as 0 (explicit) when the M5c path runs — not null');
});

test('M5c rotation 90 CW: produces a rotated+cropped JPEG with axis-swapped dimensions', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  // 200×150 source. cropRotation:90 → effective dims for the rect are
  // {w:150, h:200}. A {x:0, y:0, w:100, h:80} rect in post-rotation
  // space yields a 100×80 cropped JPEG.
  const ctx = await setupManualBatchJob(dl, {
    orderNumber: 'POS-ROT90',
    images: [{ filename: 'r90.jpg', width: 200, height: 150 }],
  });

  const result = await _applyCropToSingleImage({
    jobPath:  ctx.jobPath,
    sidecar:  ctx.sidecar,
    filename: 'r90.jpg',
    cropRect: { x: 0, y: 0, w: 100, h: 80 },
    channelMappingId: null,
    cropSource: 'per-image',
    cropRotation: 90,
    deps: { logger: silentLogger },
  });
  assert.equal(result.success, true);

  // Verify the cropped file has the requested dimensions. (Rotation
  // baked in: the cropped pixels are taken from the rotated source.)
  const meta = await sharp(path.join(ctx.jobPath, 'working', 'r90.jpg')).metadata();
  assert.equal(meta.width,  100);
  assert.equal(meta.height, 80);

  // Sidecar persists cropRotation: 90.
  const sidecar = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  assert.equal(sidecar.images[0].cropRotation, 90);
});

test('M5c rotation 180: produces a flipped+cropped output at the requested dimensions', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  // 200×150 source. cropRotation:180 keeps axis alignment (W and H
  // don't swap). A {x:50, y:30, w:100, h:80} rect in post-rotation
  // space yields a 100×80 cropped JPEG.
  const ctx = await setupManualBatchJob(dl, {
    orderNumber: 'POS-ROT180',
    images: [{ filename: 'r180.jpg', width: 200, height: 150 }],
  });

  const result = await _applyCropToSingleImage({
    jobPath:  ctx.jobPath,
    sidecar:  ctx.sidecar,
    filename: 'r180.jpg',
    cropRect: { x: 50, y: 30, w: 100, h: 80 },
    channelMappingId: null,
    cropSource: 'per-image',
    cropRotation: 180,
    deps: { logger: silentLogger },
  });
  assert.equal(result.success, true);

  const meta = await sharp(path.join(ctx.jobPath, 'working', 'r180.jpg')).metadata();
  assert.equal(meta.width,  100);
  assert.equal(meta.height, 80);

  const sidecar = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  assert.equal(sidecar.images[0].cropRotation, 180);
});

test('M5c rotation 270: axis-swapped, dimensions correct', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  // 200×150 source. cropRotation:270 → effective dims {w:150, h:200}.
  // Test a rect near the edge so the clamping path also gets exercised.
  const ctx = await setupManualBatchJob(dl, {
    orderNumber: 'POS-ROT270',
    images: [{ filename: 'r270.jpg', width: 200, height: 150 }],
  });

  const result = await _applyCropToSingleImage({
    jobPath:  ctx.jobPath,
    sidecar:  ctx.sidecar,
    filename: 'r270.jpg',
    cropRect: { x: 40, y: 50, w: 100, h: 120 },
    channelMappingId: null,
    cropSource: 'per-image',
    cropRotation: 270,
    deps: { logger: silentLogger },
  });
  assert.equal(result.success, true);

  const meta = await sharp(path.join(ctx.jobPath, 'working', 'r270.jpg')).metadata();
  assert.equal(meta.width,  100);
  assert.equal(meta.height, 120);

  const sidecar = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  assert.equal(sidecar.images[0].cropRotation, 270);
});

test('M5c rotation: invalid value (e.g. 45) normalises to 0 (defensive, no throw)', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const ctx = await setupManualBatchJob(dl, {
    orderNumber: 'POS-ROTBAD',
    images: [{ filename: 'bad.jpg', width: 200, height: 150 }],
  });

  const result = await _applyCropToSingleImage({
    jobPath:  ctx.jobPath,
    sidecar:  ctx.sidecar,
    filename: 'bad.jpg',
    cropRect: { x: 0, y: 0, w: 100, h: 80 },
    channelMappingId: null,
    cropSource: 'per-image',
    cropRotation: 45,  // not in {0, 90, 180, 270} — must normalise
    deps: { logger: silentLogger },
  });
  assert.equal(result.success, true,
    'invalid rotation must degrade to 0, not throw — operator-facing payload may carry junk');

  const sidecar = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  assert.equal(sidecar.images[0].cropRotation, 0,
    'invalid rotation must normalise to 0 in the persisted sidecar');
});

test('M5c rotation: clamping uses POST-rotation effective dimensions, not source dimensions', async (t) => {
  // A rect that would be in-bounds for the unrotated 200×150 source
  // but OUT-of-bounds for the rotated 150×200 image must be clamped
  // to fit the rotated space — not the unrotated one. Otherwise
  // libvips hard-fails on extract_area: bad extract area.
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const ctx = await setupManualBatchJob(dl, {
    orderNumber: 'POS-ROTCLAMP',
    images: [{ filename: 'clamp.jpg', width: 200, height: 150 }],
  });

  // After 90° rotation, the image is 150×200. A rect {x:140, y:0, w:60, h:100}
  // would overshoot the rotated 150-wide image (140+60=200 > 150).
  // Clamping in POST-rotation space slides x back so the rect fits.
  const result = await _applyCropToSingleImage({
    jobPath:  ctx.jobPath,
    sidecar:  ctx.sidecar,
    filename: 'clamp.jpg',
    cropRect: { x: 140, y: 0, w: 60, h: 100 },
    channelMappingId: null,
    cropSource: 'per-image',
    cropRotation: 90,
    deps: { logger: silentLogger },
  });
  assert.equal(result.success, true,
    'rotated-image clamping must slide an over-edge rect inward — libvips hard-fails otherwise');

  // The produced JPEG must be readable; dimensions ≤ rect dims (after clamp).
  const meta = await sharp(path.join(ctx.jobPath, 'working', 'clamp.jpg')).metadata();
  assert.ok(meta.width  > 0 && meta.width  <= 60);
  assert.ok(meta.height > 0 && meta.height <= 100);
});

test('M6 sidecar: a previously-discarded image round-trips through loadSidecar with discarded:true preserved', async (t) => {
  // Manual Crop redesign (2026-06-02) regression-pin. The `discarded` field
  // is operator-driven and persisted to sidecar; loadSidecar must not
  // clobber it on hydrate. We hand-write a sidecar with one image marked
  // discarded:true and one fresh entry, then assert both values survive.
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const orderFolderName = 'POS-DISC_orderid';
  const jobFolderName   = 'POS-DISC_jobid';
  const jobPath         = path.join(dl, orderFolderName, jobFolderName);
  await fs.mkdir(path.join(jobPath, 'working'), { recursive: true });
  // Write two real working files so loadSidecar's filename scan matches
  // both sidecar entries (otherwise Reconcile A adds duplicates).
  await writeJpeg(path.join(jobPath, 'working', 'kept.jpg'),      { width: 200, height: 150 });
  await writeJpeg(path.join(jobPath, 'working', 'discarded.jpg'), { width: 200, height: 150 });

  // Full-shape sidecar with both M5b and M6 fields present. Mirrors what
  // createImageEntry would produce for a freshly-created entry, just with
  // the `discarded` field flipped on the second image.
  const baseFields = {
    qtyOriginal: 1, qtyCurrent: 1,
    corrections: { cyan: 0, magenta: 0, yellow: 0 },
    reprint: false, reprintJobId: null,
    enhanced: false, enhancementSource: null, enhancedPath: null, enhancedAt: null, enhancementModel: null,
    integritySuspect: null,
    aiQuality: {
      scored: false, score: null, thresholdAtScoreTime: null, passed: true,
      modelVersion: null, inferenceMs: null, scoredAt: null, error: null,
      fixupHistory: [], operatorDecision: { kind: 'none', decidedAt: null, note: null },
    },
    originalFilename: null, recropPath: null, recropOf: null, recroppedAt: null,
    artworkFileId: null, artworkSource: null, artworkType: null,
    productionReady: null, originalFileName: null, copies: null,
    cropOrientation: null, cropSource: null, cropAppliedAt: null, cropRotation: null,
    pendingCropRect: null, pendingRotation: null, pendingOrientation: null,
  };
  const hand = {
    jobId: jobFolderName, schemaVersion: 1,
    createdAt:  '2026-06-02T00:00:00.000Z',
    modifiedAt: '2026-06-02T00:00:00.000Z',
    reprintOf:  null,
    s3ArtworkFileIdsKnown: [],
    batchCropLastAppliedAt: null,
    images: [
      { filename: 'kept.jpg',      ...baseFields, discarded: false },
      { filename: 'discarded.jpg', ...baseFields, discarded: true  },
    ],
  };
  const sidecarPath = path.join(jobPath, `${jobFolderName}.json`);
  await fs.writeFile(sidecarPath, JSON.stringify(hand, null, 2), 'utf8');
  const before = await fs.readFile(sidecarPath, 'utf8');

  const { sidecar } = await sidecarManager.loadSidecar(jobFolderName, jobPath);

  // Both values must survive the load — Reconcile F only adds the field
  // when absent; existing values must not be overwritten.
  const kept = sidecar.images.find((i) => i.filename === 'kept.jpg');
  const disc = sidecar.images.find((i) => i.filename === 'discarded.jpg');
  assert.equal(kept.discarded, false,
    'kept.jpg must retain discarded:false from the on-disk sidecar');
  assert.equal(disc.discarded, true,
    'discarded.jpg must retain discarded:true — Reconcile F must NOT overwrite an existing value');

  // No spurious save — every field on disk was complete, so Reconcile F
  // should have been a pure no-op. On-disk bytes unchanged.
  const after = await fs.readFile(sidecarPath, 'utf8');
  assert.equal(after, before,
    'Reconcile F must not save when every entry already has the discarded field present');
});

test('M5d (2026-06-02): sourceFrom=originals reads /originals/<filename>, not /working/', async (t) => {
  // Manual Crop redesign regression-pin. When ManualCropMode approves
  // a re-crop, the source MUST be /originals/<filename> — the pristine
  // pre-edit pixels — not /working/<filename>, which by then is the
  // FIRST crop's output. Otherwise re-cropping compounds: the second
  // rect is applied to the first rect's output instead of to the
  // pristine source.
  //
  // We simulate the post-first-crop on-disk state by writing distinct
  // solid-colour images: /originals/ = pristine red (what the operator
  // wants to re-crop), /working/ = blue (the prior crop's output, used
  // as a sentinel — if it ever ends up in the new crop output, the
  // sourceFrom plumbing is broken).
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));

  const jobPath = path.join(dl, 'ORD-M5D_x', 'ORD-M5D_y');
  await fs.mkdir(path.join(jobPath, 'working'),   { recursive: true });
  await fs.mkdir(path.join(jobPath, 'originals'), { recursive: true });

  // Pristine source — solid red.
  await writeJpeg(path.join(jobPath, 'originals', 'test.jpg'),
    { width: 200, height: 150, r: 240, g: 20, b: 20 });
  // Sentinel — solid blue. Same dimensions so only pixel content disambiguates.
  await writeJpeg(path.join(jobPath, 'working', 'test.jpg'),
    { width: 200, height: 150, r: 20, g: 20, b: 240 });

  const sidecarImages = [createImageEntry('test.jpg', 1, null, {
    artworkSource: 'manual', artworkType: 'optimized',
    productionReady: true, originalFileName: 'test.jpg', copies: 1,
  })];
  // Mark cropApplied to simulate "already approved once" — the
  // ManualCropMode re-crop scenario this test pins.
  sidecarImages[0].cropApplied = true;
  sidecarImages[0].cropRect    = { x: 0, y: 0, w: 200, h: 150 };
  const sidecar = createSidecar('ORD-M5D_y', sidecarImages);
  const sidecarPath = path.join(jobPath, 'ORD-M5D_y.json');
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');

  const result = await _applyCropToSingleImage({
    jobPath, sidecar, filename: 'test.jpg',
    cropRect:         { x: 0, y: 0, w: 100, h: 100 },
    channelMappingId: null,
    cropSource:       'per-image',
    cropAppliedAt:    '2026-06-02T00:00:00.000Z',
    sourceFrom:       'originals',
    deps:             { logger: silentLogger },
  });
  assert.equal(result.success, true,
    'crop with sourceFrom=originals must succeed when /originals/<filename> exists');

  // Decode the first pixel of the crop output. If sourceFrom='originals'
  // was honoured, the pixel reflects the pristine red source; if the
  // primitive read /working/ instead, it would be blue — the destructive
  // re-crop bug that this test pins against regressions.
  const { data, info } = await sharp(path.join(jobPath, 'working', 'test.jpg'))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const [r, g, b] = [data[0], data[1], data[2]];
  assert.ok(r > 150 && r > b,
    `crop output must be red-dominant (originals source), got rgb(${r},${g},${b}). `
    + 'A blue-dominant pixel means the primitive read /working/<filename> instead of '
    + '/originals/<filename> — the destructive re-crop bug from before sourceFrom landed.');
  assert.equal(info.channels, 3, 'sanity: output is 3-channel');
  assert.equal(info.width,    100, 'sanity: crop produced 100px wide output');
  assert.equal(info.height,   100, 'sanity: crop produced 100px tall output');

  // Sentinel check: /originals/<filename> must NOT have been modified.
  // The crop primitive only writes /working/<filename>; /originals/ is
  // sacrosanct by contract.
  const originalsAfter = await sharp(path.join(jobPath, 'originals', 'test.jpg'))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const [or, og, ob] = [originalsAfter.data[0], originalsAfter.data[1], originalsAfter.data[2]];
  assert.ok(or > 150 && or > ob,
    `originals/<filename> must remain red-dominant after crop, got rgb(${or},${og},${ob}). `
    + 'A blue-dominant pixel means the primitive wrote to /originals/ — '
    + 'the contract is read-only on /originals/, write-only to /working/.');
});

// ─── Auto-orientation (2026-07-23) ──────────────────────────────────────────
//
// applyBatchCrop is currently dormant from the renderer (ManualCropMode's
// approveAll went per-image in the 2026-06-02 redesign), but the batch
// driver still needs to honour the new orientation:'auto' contract for
// future callers. bestFitOrientation itself has direct unit tests in
// src/shared/__tests__/cropRectMath.test.js — these five cases lock the
// integration: per-image resolution, override map, square-target
// invariance, and the pre-existing explicit-orientation regression.

test('auto orientation: landscape source (6000×4000) + landscape 4×6 target → cropOrientation="landscape" persisted, rect at landscape aspect', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));
  const ctx = await setupManualBatchJob(dl, {
    images: [{ filename: 'land.jpg', width: 6000, height: 4000 }],
  });

  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['land.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation:    'auto',
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, true);
  assert.equal(result.succeeded.length, 1);

  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const entry = onDisk.images[0];
  assert.equal(entry.cropOrientation, 'landscape',
    'auto orientation on landscape source must persist as "landscape" — not the top-level "auto" literal');
  // Landscape 4×6 (effAspect 1.5) on 6000×4000 source:
  //   maxFitW = min(6000, 4000×1.5) = min(6000, 6000) = 6000
  //   maxFitH = 6000 / 1.5 = 4000. scale=1 → 6000×4000. Full frame.
  assert.equal(entry.cropRect.w, 6000);
  assert.equal(entry.cropRect.h, 4000);
});

test('auto orientation: portrait source (4000×6000) + 4×6 target → cropOrientation="portrait" persisted, rect at portrait aspect', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));
  const ctx = await setupManualBatchJob(dl, {
    images: [{ filename: 'port.jpg', width: 4000, height: 6000 }],
  });

  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['port.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation:    'auto',
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, true);
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const entry = onDisk.images[0];
  assert.equal(entry.cropOrientation, 'portrait');
  // Portrait 4×6 (effAspect 4/6 ≈ 0.667) on 4000×6000:
  //   maxFitW = min(4000, 6000×0.667) = min(4000, 4000) = 4000
  //   maxFitH = 4000 / 0.667 = 6000. scale=1 → 4000×6000. Full frame.
  assert.equal(entry.cropRect.w, 4000);
  assert.equal(entry.cropRect.h, 6000);
});

test('auto orientation: mixed batch — landscape + portrait sources produce independent per-image orientations', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));
  const ctx = await setupManualBatchJob(dl, {
    images: [
      { filename: 'land.jpg', width: 800, height: 400 }, // 2:1 landscape
      { filename: 'port.jpg', width: 400, height: 800 }, // 1:2 portrait
      { filename: 'sq.jpg',   width: 500, height: 500 }, // square → fallback to targetOrientation
    ],
  });

  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['land.jpg', 'port.jpg', 'sq.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    // Non-square target so targetOrientation is well-defined (4/6 < 1 → 'portrait').
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation:    'auto',
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, true);
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const byName = Object.fromEntries(onDisk.images.map((e) => [e.filename, e]));
  assert.equal(byName['land.jpg'].cropOrientation, 'landscape', 'landscape source → landscape');
  assert.equal(byName['port.jpg'].cropOrientation, 'portrait',  'portrait  source → portrait');
  // Square source falls back to targetOrientation. sizeOption 4×6 has w/h < 1
  // so targetOrientation is 'portrait'.
  assert.equal(byName['sq.jpg'].cropOrientation, 'portrait',
    'square source under auto must fall back to the target size\'s orientation (portrait for 4×6)');
});

test('auto orientation: per-image override map wins over auto for the explicit filenames', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));
  const ctx = await setupManualBatchJob(dl, {
    images: [
      { filename: 'land.jpg',    width: 800, height: 400 }, // would auto → landscape
      { filename: 'landflip.jpg', width: 800, height: 400 }, // operator flipped → portrait
    ],
  });

  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['land.jpg', 'landflip.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation:    'auto',
    perImageOrientations: { 'landflip.jpg': 'portrait' },
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, true);
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  const byName = Object.fromEntries(onDisk.images.map((e) => [e.filename, e]));
  assert.equal(byName['land.jpg'].cropOrientation,     'landscape',
    'no override entry → auto resolves to landscape for a landscape source');
  assert.equal(byName['landflip.jpg'].cropOrientation, 'portrait',
    'perImageOrientations entry MUST win over auto — operator-flipped choice is authoritative');
});

test('auto orientation: square target is orientation-invariant — every source crops square regardless of source aspect', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));
  const ctx = await setupManualBatchJob(dl, {
    images: [
      { filename: 'wide.jpg', width: 800, height: 400 },
      { filename: 'tall.jpg', width: 400, height: 800 },
      { filename: 'sq.jpg',   width: 500, height: 500 },
    ],
  });

  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['wide.jpg', 'tall.jpg', 'sq.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_8x8', w: 8, h: 8, label: '8×8"' },
    orientation:    'auto',
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, true);
  // Every crop must be square — effectiveAspect returns 1 for square
  // targets regardless of the resolved orientation string.
  for (const fn of ['wide.jpg', 'tall.jpg', 'sq.jpg']) {
    const meta = await sharp(path.join(ctx.jobPath, 'working', fn)).metadata();
    assert.equal(meta.width, meta.height,
      `${fn}: square target must produce square crop under orientation:'auto' — regression lock`);
  }
});

test('auto orientation: explicit "landscape" / "portrait" top-level orientation still validates + still applies (non-auto regression lock)', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));
  const ctx = await setupManualBatchJob(dl, {
    images: [{ filename: 'x.jpg', width: 200, height: 150 }],
  });

  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['x.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    // Pre-2026-07-23 behaviour — explicit orientation, no perImage map.
    orientation:    'landscape',
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, true);
  const onDisk = JSON.parse(await fs.readFile(ctx.sidecarPath, 'utf8'));
  assert.equal(onDisk.images[0].cropOrientation, 'landscape',
    'explicit non-auto orientation must round-trip verbatim into cropOrientation');
});

test('auto orientation: invalid perImageOrientations (array instead of object) rejected at validation', async (t) => {
  const dl = await makeTempDir();
  t.after(() => fs.rm(dl, { recursive: true, force: true }));
  const ctx = await setupManualBatchJob(dl, {
    images: [{ filename: 'x.jpg', width: 200, height: 150 }],
  });

  const result = await applyBatchCrop({
    jobPath:        ctx.jobPath,
    sidecar:        ctx.sidecar,
    filenames:      ['x.jpg'],
    fractionalSpec: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
    sizeOption:     { id: 'cm_4x6', w: 4, h: 6, label: '4×6"' },
    orientation:    'auto',
    perImageOrientations: ['bad', 'array'],
    deps:           { logger: silentLogger },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /perImageOrientations/);
});
