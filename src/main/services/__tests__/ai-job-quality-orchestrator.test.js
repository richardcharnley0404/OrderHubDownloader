/**
 * Unit tests for src/main/services/ai-job-quality-orchestrator.js.
 *
 * Run via:
 *   npm test
 *
 * The orchestrator depends on logger (electron-bound), config-service,
 * ai-quality-service (loads the inference host), and ai-quality-store
 * (touches sidecar JSON on disk). Each is stubbed in require.cache before
 * the orchestrator module is loaded, so tests stay fast and don't need a
 * model file or sidecar fixtures.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC = path.join(REPO, 'src', 'main', 'services');

// ----- Mutable test state read by the stubs -----
let __config = {};
let __scoreImageReturn = null;
let __scoreImageCalls = [];
let __setImageQualityCalls = [];
let __getJobQualityReturn = [];

function stubModule(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubModule(path.join(SVC, 'config-service.js'), {
  get(key) { return __config[key]; },
});

stubModule(path.join(SVC, 'logger.js'), {
  info: () => {},
  warn: () => {},
  error: () => {},
  logInfo: () => {},
  logWarning: () => {},
  logError: () => {},
  logDebug: () => {},
});

stubModule(path.join(SVC, 'ai-quality-service.js'), {
  async init() { return true; },
  async scoreImage(imagePath) {
    __scoreImageCalls.push(imagePath);
    return __scoreImageReturn;
  },
  isReady: () => true,
  getModelVersion: () => 'stub-1.0',
});

stubModule(path.join(SVC, 'ai-quality-store.js'), {
  async getJobQuality(_jobId, _jobPath) {
    // Deep-clone so the orchestrator's later writes don't mutate by reference.
    return __getJobQualityReturn.map((r) => ({
      filename: r.filename,
      aiQuality: { ...(r.aiQuality || {}) },
    }));
  },
  async setImageQuality(_jobId, _jobPath, filename, update) {
    __setImageQualityCalls.push({ filename, update });
    // Mirror into __getJobQualityReturn so the orchestrator's post-write
    // re-read sees the latest state.
    const idx = __getJobQualityReturn.findIndex((r) => r.filename === filename);
    const prev = idx === -1 ? {} : (__getJobQualityReturn[idx].aiQuality || {});
    const next = { ...prev, ...update };
    if (idx === -1) {
      __getJobQualityReturn.push({ filename, aiQuality: next });
    } else {
      __getJobQualityReturn[idx] = { filename, aiQuality: next };
    }
    return next;
  },
  // Mirror the real deriveHeld so tests exercise the production logic.
  deriveHeld(rows) {
    for (const { aiQuality } of rows) {
      if (!aiQuality || !aiQuality.scored) continue;
      if (aiQuality.passed) continue;
      const decision = (aiQuality.operatorDecision && aiQuality.operatorDecision.kind) || 'none';
      if (decision === 'fixed' || decision === 'approved_as_is') continue;
      return true;
    }
    return false;
  },
});

// Now safe to load the orchestrator.
const orchestrator = require(path.join(SVC, 'ai-job-quality-orchestrator.js'));

function makeJobDir(filenames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-orch-'));
  for (const name of filenames) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(16));
  }
  return dir;
}

function resetState() {
  __config = {
    aiQualityEnabled: true,
    aiQualityThreshold: 75,
    aiQualityForceScore: 0,
    aiQualityMode: 'warn',
  };
  __scoreImageReturn = null;
  __scoreImageCalls = [];
  __setImageQualityCalls = [];
  __getJobQualityReturn = [];
}


test('warn-mode: sub-threshold image does NOT set held, but is recorded with passed:false', async () => {
  resetState();
  __config.aiQualityMode = 'warn';
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };

  const jobDir = makeJobDir(['img1.jpg']);
  const r = await orchestrator.scoreJob('JOB-WARN', jobDir);

  assert.equal(r.ok, true);
  assert.equal(r.held, false, 'warn-mode must not set held=true');
  assert.equal(r.summary.mode, 'warn');
  assert.equal(r.summary.qualityHeld, true, 'underlying signal must still report quality issue');
  assert.equal(r.summary.subThreshold, 1);

  const write = __setImageQualityCalls.find((c) => c.filename === 'img1.jpg');
  assert.ok(write, 'sidecar write must occur for the scored image');
  assert.equal(write.update.scored, true);
  assert.equal(write.update.passed, false, 'passed:false must still be recorded');
  assert.equal(write.update.score, 30);
  // New Phase 3 fingerprint fields must be present in the write.
  assert.equal(typeof write.update.fileSizeAtScoreTime, 'number');
  assert.equal(typeof write.update.fileMtimeAtScoreTime, 'number');

  // canRoute must agree with held=false in warn-mode.
  assert.equal(await orchestrator.canRoute('JOB-WARN', jobDir), true);
});


test('block-mode: sub-threshold image sets held=true and blocks routing', async () => {
  resetState();
  __config.aiQualityMode = 'block';
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };

  const jobDir = makeJobDir(['img1.jpg']);
  const r = await orchestrator.scoreJob('JOB-BLOCK', jobDir);

  assert.equal(r.held, true, 'block-mode must set held=true');
  assert.equal(r.summary.mode, 'block');
  assert.equal(r.summary.qualityHeld, true);
  assert.equal(r.summary.subThreshold, 1);

  // canRoute must agree with held=true in block-mode.
  assert.equal(await orchestrator.canRoute('JOB-BLOCK', jobDir), false);
});


test('re-score: errored entry with file fingerprint changed triggers a fresh score', async () => {
  resetState();
  __config.aiQualityMode = 'warn';
  __scoreImageReturn = { score: 80, modelVersion: 'm1', inferenceMs: 5, error: null };

  const jobDir = makeJobDir(['img1.jpg']);
  const filePath = path.join(jobDir, 'img1.jpg');
  const stat = fs.statSync(filePath);

  // Pre-existing sidecar entry: previous run errored, fingerprint mismatches
  // the file currently on disk (simulates the operator dropping a fresh copy
  // after a Phase-2 quarantine event).
  __getJobQualityReturn = [{
    filename: 'img1.jpg',
    aiQuality: {
      scored: true,
      passed: true,
      score: 100,
      error: 'inference failed',
      fileSizeAtScoreTime: stat.size + 999,
      fileMtimeAtScoreTime: stat.mtimeMs - 60000,
    },
  }];

  const r = await orchestrator.scoreJob('JOB-RESCORE-CHANGED', jobDir);

  assert.equal(r.ok, true);
  assert.equal(__scoreImageCalls.length, 1, 'scoreImage must be invoked exactly once');
  const write = __setImageQualityCalls.find((c) => c.filename === 'img1.jpg');
  assert.ok(write, 'a re-score must write a fresh sidecar entry');
  assert.equal(write.update.error, null, 'fresh score clears the previous error');
  assert.equal(write.update.score, 80);
  assert.equal(write.update.fileSizeAtScoreTime, stat.size);
  assert.equal(write.update.fileMtimeAtScoreTime, stat.mtimeMs);
});


test('re-score: errored entry with unchanged file is skipped (no inference call, no write)', async () => {
  resetState();
  __config.aiQualityMode = 'warn';
  __scoreImageReturn = { score: 80, modelVersion: 'm1', inferenceMs: 5, error: null };

  const jobDir = makeJobDir(['img1.jpg']);
  const filePath = path.join(jobDir, 'img1.jpg');
  const stat = fs.statSync(filePath);

  // Pre-existing sidecar entry: previous run errored, fingerprint matches
  // the file currently on disk — no point re-running on the same broken file.
  __getJobQualityReturn = [{
    filename: 'img1.jpg',
    aiQuality: {
      scored: true,
      passed: true,
      score: 100,
      error: 'inference failed',
      fileSizeAtScoreTime: stat.size,
      fileMtimeAtScoreTime: stat.mtimeMs,
    },
  }];

  const r = await orchestrator.scoreJob('JOB-RESCORE-UNCHANGED', jobDir);

  assert.equal(r.ok, true);
  assert.equal(__scoreImageCalls.length, 0, 'scoreImage must NOT be invoked');
  const writes = __setImageQualityCalls.filter((c) => c.filename === 'img1.jpg');
  assert.equal(writes.length, 0, 'no sidecar write should occur on skip');
});


test('re-score: clean previous score (no error) is skipped regardless of mode', async () => {
  resetState();
  __config.aiQualityMode = 'block';
  __scoreImageReturn = { score: 30, modelVersion: 'm1', inferenceMs: 5, error: null };

  const jobDir = makeJobDir(['img1.jpg']);
  __getJobQualityReturn = [{
    filename: 'img1.jpg',
    aiQuality: {
      scored: true,
      passed: true,
      score: 92,
      error: null,
      fileSizeAtScoreTime: 12345,
      fileMtimeAtScoreTime: 99999999999,
    },
  }];

  const r = await orchestrator.scoreJob('JOB-CLEAN-SKIP', jobDir);

  assert.equal(__scoreImageCalls.length, 0, 'scoreImage must NOT be invoked when previous score is clean');
  assert.equal(r.summary.scored, 0);
  assert.equal(r.summary.passed, 1);
  assert.equal(r.held, false, 'a passed clean score must not set held');
});


test('legacy sidecar without fingerprint fields: errored entry is skipped (cannot tell)', async () => {
  resetState();
  __config.aiQualityMode = 'warn';
  __scoreImageReturn = { score: 80, modelVersion: 'm1', inferenceMs: 5, error: null };

  const jobDir = makeJobDir(['img1.jpg']);
  __getJobQualityReturn = [{
    filename: 'img1.jpg',
    aiQuality: {
      scored: true,
      passed: true,
      score: 100,
      error: 'inference failed',
      // fileSizeAtScoreTime / fileMtimeAtScoreTime intentionally absent
      // (simulates a sidecar written before Phase 3).
    },
  }];

  const r = await orchestrator.scoreJob('JOB-LEGACY-ERROR', jobDir);

  assert.equal(__scoreImageCalls.length, 0,
    'legacy errored entry must be skipped (no fingerprint to compare against)');
  assert.equal(r.summary.scored, 0);
});


// ─────────────────────────────────────────────────────────────────────────
// Bug A regression — phase derivation against disk truth.
//
// The aiQuality:listHeldJobs IPC reports `phase: 'scoring' | 'scored'` per
// job. Pre-fix, total was derived from sidecar.images.length. For fresh
// Mode-1 jobs (sidecar starts empty; orchestrator's setImageQuality
// upserts entries as it scores), `rows.length === scored count` mid-loop
// and the IPC reported `phase: 'scored'` from the very first image.
// Buttons re-enabled prematurely.
//
// The fix: derive total from disk truth via _scanJobImages. These tests
// model the fresh Mode-1 flow that the original Phase 3 unit tests didn't
// exercise (they pre-populated the sidecar to look like a Job-Review-
// touched layout, where rows.length happens to equal disk truth).
// ─────────────────────────────────────────────────────────────────────────

test('_scanJobImages: disk truth excludes non-image extensions', () => {
  // Under v1.3.2 flag-and-allow the .quarantine extension no longer exists
  // on disk (migration restores files to their real extensions). The disk-
  // truth filter still matters for the OTHER non-image artifacts that share
  // the job folder: sidecar JSONs, the post-migration archived manifest,
  // and any operator-dropped junk like readme.txt.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-disktruth-'));
  for (const name of [
    'a.jpeg', 'b.jpeg', 'c.png',
    '12345.json',                    // sidecar
    '_ohd-quarantine.archived.json', // post-migration archived manifest
    'readme.txt', 'data.csv',        // miscellaneous
  ]) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(8));
  }

  const found = orchestrator._scanJobImages(dir);
  assert.equal(found.length, 3, 'only the 3 image-extension files count');
  assert.deepEqual(found.sort(), ['a.jpeg', 'b.jpeg', 'c.png']);
});


test('phase derivation: fresh Mode-1 scoring progression', () => {
  // Simulates the IPC handler's exact total / scored / phase computation,
  // walking through the fresh-job lifecycle the original regression missed.
  // Disk has 5 image files; sidecar starts empty; orchestrator scores them
  // one at a time, upserting sidecar entries as it goes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-phase-fresh-'));
  for (const name of ['img1.jpeg', 'img2.jpeg', 'img3.jpeg', 'img4.jpeg', 'img5.jpeg']) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(8));
  }

  // The IPC handler's logic, inlined for testing:
  function computePhase(jobDir, sidecarRows) {
    const total = orchestrator._scanJobImages(jobDir).length;
    const scored = sidecarRows.filter((r) => r.aiQuality && r.aiQuality.scored).length;
    return { total, scored, phase: scored >= total ? 'scored' : 'scoring' };
  }

  // Start: empty sidecar (Mode-1 fresh job — sidecarManager creates no
  // entries because /working/ doesn't exist yet).
  let rows = [];
  assert.deepEqual(
    computePhase(dir, rows),
    { total: 5, scored: 0, phase: 'scoring' },
    'empty sidecar with files on disk must be scoring (REGRESSION CASE)',
  );

  // Orchestrator scores image 1 → upserts entry 1.
  rows = [{ filename: 'img1.jpeg', aiQuality: { scored: true, passed: true } }];
  assert.deepEqual(
    computePhase(dir, rows),
    { total: 5, scored: 1, phase: 'scoring' },
    '1/5 must still be scoring — pre-fix this returned phase=scored (REGRESSION)',
  );

  // Mid-loop — 3 of 5 scored.
  rows = [
    { filename: 'img1.jpeg', aiQuality: { scored: true, passed: true } },
    { filename: 'img2.jpeg', aiQuality: { scored: true, passed: false } },
    { filename: 'img3.jpeg', aiQuality: { scored: true, passed: true } },
  ];
  assert.deepEqual(
    computePhase(dir, rows),
    { total: 5, scored: 3, phase: 'scoring' },
    '3/5 mid-loop must be scoring',
  );

  // All 5 scored — now done.
  rows = [
    { filename: 'img1.jpeg', aiQuality: { scored: true, passed: true } },
    { filename: 'img2.jpeg', aiQuality: { scored: true, passed: false } },
    { filename: 'img3.jpeg', aiQuality: { scored: true, passed: true } },
    { filename: 'img4.jpeg', aiQuality: { scored: true, passed: true } },
    { filename: 'img5.jpeg', aiQuality: { scored: true, passed: true } },
  ];
  assert.deepEqual(
    computePhase(dir, rows),
    { total: 5, scored: 5, phase: 'scored' },
    '5/5 all scored must be scored',
  );
});


test('phase derivation: graceful-fail entries do not block phase=scored', () => {
  // v1.3.2 flag-and-allow flow. A corrupt image now keeps its real extension
  // (the migration restored anything renamed by the v1.3.0 quarantine model)
  // so it appears in the disk-truth count. When scoring reaches such a file,
  // sharp throws inside the preprocessor → ai-quality-service catches and
  // returns _passResult, which the orchestrator persists as
  //   { scored: true, score: 100, passed: true, error: '<msg>' }.
  // The scored count must INCLUDE these entries — otherwise the IPC handler's
  // `phase: scored >= total ? 'scored' : 'scoring'` calc would get stuck at
  // 'scoring' for any job containing a graceful-fail image, and the Jobs-grid
  // action buttons would never re-enable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-phase-graceful-'));
  for (const name of ['a.jpeg', 'b.jpeg', 'c.jpeg', 'd.jpeg', 'e.jpeg']) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(8));
  }

  // 3 normal scored entries + 2 graceful-fail entries. All scored=true,
  // passed=true; the latter two carry an error message.
  const rows = [
    { filename: 'a.jpeg', aiQuality: { scored: true, passed: true, score: 80,  error: null } },
    { filename: 'b.jpeg', aiQuality: { scored: true, passed: true, score: 90,  error: null } },
    { filename: 'c.jpeg', aiQuality: { scored: true, passed: true, score: 70,  error: null } },
    { filename: 'd.jpeg', aiQuality: { scored: true, passed: true, score: 100, error: 'Input image dimension invalid' } },
    { filename: 'e.jpeg', aiQuality: { scored: true, passed: true, score: 100, error: 'sharp: failed to decode' } },
  ];

  const total  = orchestrator._scanJobImages(dir).length;
  const scored = rows.filter((r) => r.aiQuality.scored).length;
  assert.equal(total, 5,
    'disk count includes corrupt files — they keep their real extension under flag-and-allow');
  assert.equal(scored, 5,
    'graceful-fail entries (error populated, score=100, passed=true) count as scored');
  assert.equal(scored >= total ? 'scored' : 'scoring', 'scored',
    'phase must reach scored even when some entries carried errors');
});
