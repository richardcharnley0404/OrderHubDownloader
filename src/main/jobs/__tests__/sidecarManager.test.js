/**
 * Unit tests for src/main/jobs/sidecarManager.js
 *
 * Focus: Customer Originals Phase 1 metaMap support.
 *
 *   - loadSidecar populates `originalFilename` on entries created during
 *     the "fresh sidecar" path when the manifest meta supplies one.
 *   - The reconcile pass back-fills `originalFilename` on existing entries
 *     whose value is null — touching no other field on those entries.
 *   - A pre-existing originalFilename is NEVER clobbered, even if the
 *     manifest now disagrees (first-write wins; keeps the no-clobber
 *     contract clean per the design discussion).
 *   - Legacy `Map<filename, number>` quantity-only meta still works
 *     (back-compat for any caller that hasn't migrated).
 *   - Missing meta degrades to current behaviour (qty=1, originalFilename=null).
 *
 * Pattern: each test uses a temp directory for the job folder, writes
 * fake working images to disk, then exercises loadSidecar. No mocks —
 * we go through the real fs/promises path.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { loadSidecar, sidecarPath } = require('../sidecarManager.js');

// =============================================================================
// Test helpers
// =============================================================================

function makeTmpJob(jobId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ohd-sidecar-test-${jobId}-`));
  // Always include /working/ — the scanner relies on it.
  fs.mkdirSync(path.join(dir, 'working'), { recursive: true });
  return dir;
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function writeWorkingImages(jobPath, names) {
  for (const n of names) {
    fs.writeFileSync(path.join(jobPath, 'working', n), 'fake-jpeg-bytes');
  }
}
async function readSidecar(jobId, jobPath) {
  const raw = await fsp.readFile(sidecarPath(jobId, jobPath), 'utf8');
  return JSON.parse(raw);
}

// =============================================================================
// Fresh sidecar — metaMap populates originalFilename + qty
// =============================================================================

test('fresh sidecar: metaMap populates originalFilename and qty per entry', async () => {
  const jobId = 'PXDEMO-AD31D5_38432891';
  const jobPath = makeTmpJob(jobId);
  try {
    writeWorkingImages(jobPath, [
      'PXDEMO-AD31D5_38432891_A.jpeg',
      'PXDEMO-AD31D5_38432891_B.jpeg',
    ]);
    const meta = new Map([
      ['PXDEMO-AD31D5_38432891_A.jpeg', { qty: 3, originalFilename: 'PXDEMO-AD31D5_38432891/original-files/1-A.jpg' }],
      ['PXDEMO-AD31D5_38432891_B.jpeg', { qty: 1, originalFilename: 'PXDEMO-AD31D5_38432891/original-files/2-B.jpg' }],
    ]);
    const { sidecar } = await loadSidecar(jobId, jobPath, meta);
    assert.equal(sidecar.images.length, 2);

    const byName = new Map(sidecar.images.map(i => [i.filename, i]));
    const a = byName.get('PXDEMO-AD31D5_38432891_A.jpeg');
    const b = byName.get('PXDEMO-AD31D5_38432891_B.jpeg');

    assert.equal(a.qtyOriginal, 3);
    assert.equal(a.originalFilename, 'PXDEMO-AD31D5_38432891/original-files/1-A.jpg');
    assert.equal(b.qtyOriginal, 1);
    assert.equal(b.originalFilename, 'PXDEMO-AD31D5_38432891/original-files/2-B.jpg');
  } finally {
    cleanup(jobPath);
  }
});

test('fresh sidecar: legacy `Map<filename, number>` meta still works (back-compat)', async () => {
  const jobId = 'LEG_1';
  const jobPath = makeTmpJob(jobId);
  try {
    writeWorkingImages(jobPath, ['a.jpg']);
    const meta = new Map([['a.jpg', 5]]); // legacy number-only form
    const { sidecar } = await loadSidecar(jobId, jobPath, meta);
    const entry = sidecar.images[0];
    assert.equal(entry.qtyOriginal, 5);
    assert.equal(entry.originalFilename, null,
      'legacy meta does not carry originalFilename; entry stays null');
  } finally {
    cleanup(jobPath);
  }
});

test('fresh sidecar: missing meta degrades to qty=1, originalFilename=null', async () => {
  const jobId = 'NONE_1';
  const jobPath = makeTmpJob(jobId);
  try {
    writeWorkingImages(jobPath, ['x.jpg']);
    const { sidecar } = await loadSidecar(jobId, jobPath); // no meta arg
    const entry = sidecar.images[0];
    assert.equal(entry.qtyOriginal, 1);
    assert.equal(entry.originalFilename, null);
  } finally {
    cleanup(jobPath);
  }
});

test('fresh sidecar: meta entry with no originalFilename leaves entry.originalFilename=null', async () => {
  const jobId = 'PARTIAL_1';
  const jobPath = makeTmpJob(jobId);
  try {
    writeWorkingImages(jobPath, ['a.jpg', 'b.jpg']);
    // Mixed: a.jpg has a manifest original, b.jpg does not (non-Pixfizz row).
    const meta = new Map([
      ['a.jpg', { qty: 2, originalFilename: 'order/original-files/1-a.jpg' }],
      ['b.jpg', { qty: 1, originalFilename: null }],
    ]);
    const { sidecar } = await loadSidecar(jobId, jobPath, meta);
    const byName = new Map(sidecar.images.map(i => [i.filename, i]));
    assert.equal(byName.get('a.jpg').originalFilename, 'order/original-files/1-a.jpg');
    assert.equal(byName.get('b.jpg').originalFilename, null);
  } finally {
    cleanup(jobPath);
  }
});

// =============================================================================
// Reconcile — back-fill originalFilename on legacy entries
// =============================================================================

test('reconcile: back-fills originalFilename on a legacy entry (field absent / null)', async () => {
  const jobId = 'LEGACY_BACKFILL';
  const jobPath = makeTmpJob(jobId);
  try {
    writeWorkingImages(jobPath, ['a.jpg']);
    // Plant a sidecar in the pre-feature shape: no originalFilename key at all.
    const legacy = {
      jobId,
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      reprintOf: null,
      images: [{
        filename: 'a.jpg',
        qtyOriginal: 1,
        qtyCurrent: 4,                         // operator bumped this
        corrections: { cyan: 3, magenta: 0, yellow: 0 },
        reprint: false,
        reprintJobId: null,
        enhanced: false,
        enhancementSource: null,
        enhancedPath: null,
        enhancedAt: null,
        enhancementModel: null,
        integritySuspect: null,
        aiQuality: { scored: false },
        // intentionally NO originalFilename — pre-feature sidecar
      }],
    };
    await fsp.writeFile(sidecarPath(jobId, jobPath), JSON.stringify(legacy, null, 2));

    const meta = new Map([
      ['a.jpg', { qty: 99, originalFilename: 'order/original-files/1-a.jpg' }],
    ]);
    const { sidecar } = await loadSidecar(jobId, jobPath, meta);
    const entry = sidecar.images[0];

    // The only thing reconcile should have touched is originalFilename.
    assert.equal(entry.originalFilename, 'order/original-files/1-a.jpg',
      'originalFilename back-filled from manifest');
    assert.equal(entry.qtyOriginal, 1,        'qtyOriginal preserved (manifest qty NOT re-applied)');
    assert.equal(entry.qtyCurrent,  4,        'operator-adjusted qtyCurrent preserved');
    assert.equal(entry.corrections.cyan, 3,   'corrections preserved');
    assert.equal(entry.reprint, false,        'reprint preserved');

    // Persisted to disk too.
    const reloaded = await readSidecar(jobId, jobPath);
    assert.equal(reloaded.images[0].originalFilename, 'order/original-files/1-a.jpg');
  } finally {
    cleanup(jobPath);
  }
});

test('reconcile: leaves an already-set originalFilename alone, even when manifest disagrees', async () => {
  const jobId = 'NO_CLOBBER';
  const jobPath = makeTmpJob(jobId);
  try {
    writeWorkingImages(jobPath, ['a.jpg']);
    const existing = {
      jobId,
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      reprintOf: null,
      images: [{
        filename: 'a.jpg',
        qtyOriginal: 1,
        qtyCurrent: 1,
        corrections: { cyan: 0, magenta: 0, yellow: 0 },
        reprint: false,
        reprintJobId: null,
        enhanced: false,
        enhancementSource: null,
        enhancedPath: null,
        enhancedAt: null,
        enhancementModel: null,
        integritySuspect: null,
        aiQuality: { scored: false },
        originalFilename: 'order/original-files/FIRST-WRITE.jpg',
      }],
    };
    await fsp.writeFile(sidecarPath(jobId, jobPath), JSON.stringify(existing, null, 2));

    // Manifest now reports a different path for the same working filename.
    const meta = new Map([
      ['a.jpg', { qty: 1, originalFilename: 'order/original-files/SECOND-CLAIM.jpg' }],
    ]);
    const { sidecar } = await loadSidecar(jobId, jobPath, meta);
    assert.equal(
      sidecar.images[0].originalFilename,
      'order/original-files/FIRST-WRITE.jpg',
      'pre-existing originalFilename must NOT be overwritten — first-write wins',
    );
  } finally {
    cleanup(jobPath);
  }
});

test('reconcile: legacy entries with no manifest meta degrade silently (no spurious save)', async () => {
  const jobId = 'NO_META';
  const jobPath = makeTmpJob(jobId);
  try {
    writeWorkingImages(jobPath, ['a.jpg']);
    const legacy = {
      jobId,
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      reprintOf: null,
      images: [{
        filename: 'a.jpg',
        qtyOriginal: 1,
        qtyCurrent:  1,
        corrections: { cyan: 0, magenta: 0, yellow: 0 },
        reprint: false,
        reprintJobId: null,
        enhanced: false,
        enhancementSource: null,
        enhancedPath: null,
        enhancedAt: null,
        enhancementModel: null,
        integritySuspect: null,
        aiQuality: { scored: false },
      }],
    };
    await fsp.writeFile(sidecarPath(jobId, jobPath), JSON.stringify(legacy, null, 2));

    const before = await fsp.stat(sidecarPath(jobId, jobPath));
    // Sleep 10ms so a re-save (which calls touchSidecar → new mtime) would
    // be detectable. Then load with NO meta — no new files to add either.
    await new Promise(r => setTimeout(r, 10));
    const { sidecar } = await loadSidecar(jobId, jobPath);
    const after = await fsp.stat(sidecarPath(jobId, jobPath));

    assert.equal(sidecar.images.length, 1);
    // No back-fill happened (no manifest meta to back-fill FROM), and there
    // are no new files to add either, so the sidecar file should not have
    // been rewritten.
    assert.equal(after.mtimeMs, before.mtimeMs,
      'with no work to do, reconcile must not rewrite the sidecar');
  } finally {
    cleanup(jobPath);
  }
});

// =============================================================================
// Reconcile — new files on disk inherit meta
// =============================================================================

test('M3 hydration: Reconcile C adds copies:null to legacy entries without triggering a save', async () => {
  // Mirror of the existing "no spurious save" pattern, scoped to the M3
  // schema bump: legacy sidecars (pre-M3) lack the per-image `copies`
  // field. Reconcile C must hydrate it in-memory to `null` (so consumers
  // can read `entry.copies` uniformly), but must NOT rewrite the
  // on-disk file — same "hydration is read-only on disk" contract that
  // governs the other five S3 fields.
  const jobId = 'M3_HYDRATE';
  const jobPath = makeTmpJob(jobId);
  try {
    writeWorkingImages(jobPath, ['a.jpg']);
    // Legacy entry — has the M1 S3 fields (artworkFileId, etc.) but no
    // `copies`. Represents any sidecar created by the M1 downloader
    // between 2026-05-24 and the M3 bump.
    const legacy = {
      jobId,
      schemaVersion: 1,
      createdAt: '2026-05-24T10:00:00.000Z',
      modifiedAt: '2026-05-24T10:00:00.000Z',
      reprintOf: null,
      images: [{
        filename: 'a.jpg',
        qtyOriginal: 2,
        qtyCurrent:  2,
        corrections: { cyan: 0, magenta: 0, yellow: 0 },
        reprint: false,
        reprintJobId: null,
        enhanced: false,
        enhancementSource: null,
        enhancedPath: null,
        enhancedAt: null,
        enhancementModel: null,
        integritySuspect: null,
        aiQuality: { scored: false },
        originalFilename: null,
        artworkFileId:    'm3-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        artworkSource:    'manual',
        artworkType:      'optimized',
        productionReady:  true,
        originalFileName: 'a.jpg',
        // ← no `copies` field; that's the legacy shape we're testing.
      }],
      s3ArtworkFileIdsKnown: ['m3-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    };
    await fsp.writeFile(sidecarPath(jobId, jobPath), JSON.stringify(legacy, null, 2));

    const before = await fsp.stat(sidecarPath(jobId, jobPath));
    await new Promise(r => setTimeout(r, 10));
    const { sidecar } = await loadSidecar(jobId, jobPath);
    const after = await fsp.stat(sidecarPath(jobId, jobPath));

    // In-memory: copies hydrated to null on the returned sidecar.
    assert.equal(sidecar.images.length, 1);
    assert.equal(sidecar.images[0].copies, null,
      'legacy entry must have copies hydrated to null in-memory so consumers can read it uniformly');
    // Other fields untouched.
    assert.equal(sidecar.images[0].qtyOriginal,    2);
    assert.equal(sidecar.images[0].artworkFileId, 'm3-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(sidecar.images[0].productionReady, true);

    // On disk: NOT rewritten — same contract as the other M1 hydration
    // fields. The disk catches up only when a meaningful save fires
    // (new file added, originalFilename back-filled, etc.).
    assert.equal(after.mtimeMs, before.mtimeMs,
      'hydration of `copies` alone must not rewrite the sidecar — preserves "no spurious save" contract');

    // And the on-disk file must still LACK the copies field — proof
    // that the save was skipped, not just that mtime happened to match.
    const onDisk = await readSidecar(jobId, jobPath);
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk.images[0], 'copies'), false,
      'on-disk legacy entry must remain shape-identical — `copies` key absent until a meaningful save lands');
  } finally {
    cleanup(jobPath);
  }
});

test('reconcile: newly-discovered files on disk get originalFilename from meta', async () => {
  const jobId = 'NEW_FILE';
  const jobPath = makeTmpJob(jobId);
  try {
    // Sidecar exists with only a.jpg; b.jpg appears on disk after the fact.
    writeWorkingImages(jobPath, ['a.jpg']);
    const initial = {
      jobId,
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      reprintOf: null,
      images: [{
        filename: 'a.jpg',
        qtyOriginal: 1, qtyCurrent: 1,
        corrections: { cyan: 0, magenta: 0, yellow: 0 },
        reprint: false, reprintJobId: null,
        enhanced: false, enhancementSource: null, enhancedPath: null,
        enhancedAt: null, enhancementModel: null,
        integritySuspect: null,
        aiQuality: { scored: false },
        originalFilename: 'order/original-files/1-a.jpg',
      }],
    };
    await fsp.writeFile(sidecarPath(jobId, jobPath), JSON.stringify(initial, null, 2));

    // Now drop b.jpg into /working/ and re-load with meta covering both.
    writeWorkingImages(jobPath, ['b.jpg']);
    const meta = new Map([
      ['a.jpg', { qty: 1, originalFilename: 'order/original-files/1-a.jpg' }],
      ['b.jpg', { qty: 2, originalFilename: 'order/original-files/2-b.jpg' }],
    ]);
    const { sidecar } = await loadSidecar(jobId, jobPath, meta);

    const byName = new Map(sidecar.images.map(i => [i.filename, i]));
    assert.equal(byName.get('b.jpg').qtyOriginal, 2);
    assert.equal(byName.get('b.jpg').originalFilename, 'order/original-files/2-b.jpg');
    // a.jpg still in shape.
    assert.equal(byName.get('a.jpg').originalFilename, 'order/original-files/1-a.jpg');
  } finally {
    cleanup(jobPath);
  }
});
