'use strict';

/**
 * Tests for frame + roll recording in folder-watch-service._processFilmScans.
 *
 * TRIPWIRE tests (test names prefixed "tripwire (rotation-on):") lock every
 * externally-observable output of the rotation-on flow. They MUST pass before
 * the rotation-off decoupling change and after it — that's the whole point.
 * Assertions come from the invariants:
 *   - Frame record shape: exactly these fields, no extras, no drift.
 *   - Rotation state A shape (rotation ran + produced a prediction) locked.
 *   - Rotation state B shape (rotation ran and failed) locked.
 *   - Roll record shape (with and without auto-assign) locked.
 *   - uploadStatus decision from (reviewMode, smart-signals, PC, autoAssign).
 *
 * NEW tests (test names prefixed "rotation-off:") cover the decoupled path
 * that must appear once the change lands. Written now so the change is
 * TDD-driven; they will fail before the folder-watch refactor and pass
 * after.
 *
 * Three-state distinguishability test proves the representation choice:
 *   State A — rotation ran, produced prediction: rotation.skipped !== true,
 *             rotation.error null-or-absent.
 *   State B — rotation ran, failed:              rotation.skipped !== true,
 *             rotation.error is a non-empty string.
 *   State C — rotation did NOT run:              rotation.skipped === true,
 *             rotation.reason names why.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const fs      = require('node:fs');
const path    = require('node:path');

// ── Sharp mock (chainable, records nothing here — the shape-lock tests live
//    in folder-watch-thumbnail.test.js). Every .toFile() writes a marker file.

const __originalRequire = Module.prototype.require;
const __userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-frec-ud-'));

let __toFileImpl = null; // per-test override

Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: { getPath: (_key) => __userDataDir },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (req === 'sharp') {
    const makeSharp = (src, _opts) => {
      const chain = {
        rotate: () => chain,
        resize: () => chain,
        jpeg:   () => chain,
        tiff:   () => chain,
        async toFile(dest) {
          if (typeof __toFileImpl === 'function') return await __toFileImpl(src, dest);
          try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) { /* ignore */ }
          fs.writeFileSync(dest, Buffer.from(`FAKE-SHARP-${path.basename(dest)}`));
          return { size: 1 };
        },
      };
      return chain;
    };
    return makeSharp;
  }
  return __originalRequire.apply(this, arguments);
};

function stubViaCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SVC = path.resolve(__dirname, '..');
const ENH = path.resolve(__dirname, '..', '..', 'enhancement');

stubViaCache(path.join(SVC, 'logger.js'), {
  info: () => {}, warn: () => {}, error: () => {},
  logInfo: () => {}, logWarning: () => {}, logError: () => {}, logDebug: () => {},
});

let __config = {};
stubViaCache(path.join(SVC, 'config-service.js'), {
  get(key) { return __config[key]; },
  getAll() { return { ...__config }; },
});

// __s3Calls captures every uploadFolder invocation so the "single-upload
// invariant" tests below can count how many times a rotation-off roll
// hit S3 in a single _processFilmScans cycle. __s3Result lets a test
// simulate partial-fail / all-fail results to exercise the retry path.
let __s3Calls  = [];
let __s3Result = { uploaded: 1, failed: 0, total: 1 };
stubViaCache(path.join(SVC, 's3-service.js'), {
  async uploadFolder(localFolderPath, s3Prefix, s3Config, _onProgress, manifestExtra) {
    __s3Calls.push({ localFolderPath, s3Prefix, manifestExtra });
    return __s3Result;
  },
});

// Orientation service — behaviour per-test via __orient.
let __orient = {
  ready:         true,
  modelVersion:  'stub-orient-v1',
  // predictOrientation(imagePath, frameIndex) → prediction object
  predict:       null,
  predictThrows: false,
};

stubViaCache(path.join(SVC, 'orientation-service.js'), {
  async init() { return __orient.ready; },
  getModelVersion() { return __orient.modelVersion; },
  async predictOrientation(imagePath) {
    if (__orient.predictThrows) throw new Error('SIMULATED-PREDICT-THROW');
    if (typeof __orient.predict === 'function') return __orient.predict(imagePath);
    // Default: confident, no rotation needed.
    return {
      predictedClass: 0,
      predictedAngle: 0,
      confidence:     0.95,
      classScores:    [0.95, 0.02, 0.02, 0.01],
      inferenceMs:    5,
      error:          null,
    };
  },
});

stubViaCache(path.join(ENH, 'perfectlyClearClient.js'), {
  async processBatch(_opts) { return []; },
});

const folderWatchService = require(path.join(SVC, 'folder-watch-service.js'));
const frameMetadataStore = require(path.join(SVC, 'frame-metadata-store.js'));

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetSharedState() {
  __config = {};
  __toFileImpl = null;
  __s3Calls = [];
  __s3Result = { uploaded: 1, failed: 0, total: 1 };
  __orient = {
    ready: true,
    modelVersion: 'stub-orient-v1',
    predict: null,
    predictThrows: false,
  };
  frameMetadataStore._clearAll();
  try {
    const rolls = frameMetadataStore.store.get('rolls', {});
    for (const rollId of Object.keys(rolls)) frameMetadataStore.deleteRoll(rollId);
  } catch (_) { /* best-effort */ }
}

function makeWorkspace() {
  const base    = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-frec-'));
  const watch   = path.join(base, 'watch');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(watch,   { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
  return { base, watch, storage };
}

function backdate(dir) {
  const past = new Date(Date.now() - 20 * 60 * 1000);
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else { try { fs.utimesSync(p, past, past); } catch (_) { /* ignore */ } }
    }
  };
  walk(dir);
}

function seedRoll(watchDir, name, files) {
  const rollDir = path.join(watchDir, name);
  fs.mkdirSync(rollDir, { recursive: true });
  for (const [fname, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(rollDir, fname), content);
  }
  backdate(watchDir);
  return rollDir;
}

function baseFilmConfig(watch, storage, overrides = {}) {
  return {
    filmScansEnabled:            true,
    filmScansWatchFolder:        watch,
    filmScansStorageFolder:      storage,
    filmScansWatchguardMinutes:  -1,
    filmScanRotationEnabled:     true,
    filmScanRotationConfidenceThreshold: 0.9,
    filmScanReviewMode:          'never',
    locationId:                  'loc-1',
    s3BucketName:                null,
    ...overrides,
  };
}

// Invariant: the frame record has EXACTLY these top-level keys. Any drift
// (new key, dropped key) is a shape change that IPC readers may not handle.
const FRAME_TOP_KEYS = new Set([
  'frameId',
  'rollId',
  'frameIndex',
  'fileName',
  'originalPath',
  'thumbnailPath',
  'thumbnailError',
  'rotation',
  'operatorFlags',
  'createdAt',
  'updatedAt',
]);

function assertFrameTopKeysExact(t, frame) {
  const got = new Set(Object.keys(frame));
  for (const k of FRAME_TOP_KEYS) {
    assert.ok(got.has(k), `${t}: frame missing key "${k}"`);
  }
  for (const k of got) {
    assert.ok(FRAME_TOP_KEYS.has(k), `${t}: frame has unexpected key "${k}"`);
  }
}

// ── TRIPWIRE (rotation-on) ──────────────────────────────────────────────────

test('tripwire (rotation-on): frame record shape — state A (rotation ran, prediction succeeded)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage);
  // Default orient: conf 0.95, angle 0 → applied=false, error=null (state A subcase)

  const rollName = 'ROLL-TRIP-A';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const frames = frameMetadataStore.listByRoll(rollName);
  assert.equal(frames.length, 1, 'one frame recorded');
  const f = frames[0];

  assertFrameTopKeysExact('state A', f);
  assert.equal(f.rollId,       rollName);
  assert.equal(f.frameIndex,   0);
  assert.equal(f.fileName,     'a.jpg');
  assert.equal(f.frameId,      `${rollName}_0`);
  assert.equal(f.thumbnailError, null);
  assert.deepEqual(f.operatorFlags, []);

  // State-A distinguishing invariants
  const rot = f.rotation;
  assert.notStrictEqual(rot.skipped, true, 'state A: rotation.skipped is NOT true');
  assert.equal(rot.error, null, 'state A: rotation.error is null');

  // Full rotation shape when the ML pipeline produced a prediction
  assert.equal(rot.applied,             false);   // angle=0 → no rotate applied
  assert.equal(rot.predictedClass,      0);
  assert.equal(rot.predictedAngle,      0);
  assert.equal(rot.confidence,          0.95);
  assert.deepEqual(rot.classScores,     [0.95, 0.02, 0.02, 0.01]);
  assert.equal(rot.confidenceThreshold, 0.9);
  assert.equal(rot.modelVersion,        'stub-orient-v1');
  assert.equal(rot.inferenceMs,         5);
});

test('tripwire (rotation-on): frame record shape — state B (rotation ran, prediction threw)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage);
  __orient.predictThrows = true;

  const rollName = 'ROLL-TRIP-B';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const frames = frameMetadataStore.listByRoll(rollName);
  assert.equal(frames.length, 1, 'error frame still recorded');
  const f = frames[0];

  assertFrameTopKeysExact('state B', f);
  assert.equal(f.rollId, rollName);
  assert.equal(f.fileName, 'a.jpg');

  const rot = f.rotation;
  assert.notStrictEqual(rot.skipped, true, 'state B: rotation.skipped is NOT true');
  assert.equal(typeof rot.error, 'string', 'state B: rotation.error is a string');
  assert.ok(rot.error.length > 0, 'state B: rotation.error is non-empty');
  assert.equal(rot.applied, false, 'state B: rotation.applied is false');
  assert.equal(rot.modelVersion, 'stub-orient-v1');
});

test('tripwire (rotation-on): roll record shape — reviewMode=never, no PC, no auto-assign → uploadStatus undefined', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage);

  const rollName = 'ROLL-TRIP-ROLL';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.ok(rec, 'roll record exists');
  assert.equal(rec.storagePath, path.join(storage, folderWatchService._getDateSubfolder(), rollName));
  assert.equal(rec.locationId, 'loc-1');
  assert.equal(rec.uploadStatus, undefined, 'never mode + confident + no PC → no defer');
  assert.equal(rec.uploadError, null);
  assert.equal(rec.uploadedAt, null);
  assert.equal(rec.processingStatus, null);
  // Auto-assign fields absent when auto-assign is off
  assert.equal(rec.awaitingAssignment, undefined);
  assert.equal(rec.reviewPassed, undefined);
  assert.equal(rec.matchedJobId, undefined);
  // Timeline has the four rotation-on stamps
  assert.ok(rec.timeline);
  assert.ok(rec.timeline.stableAt);
  assert.ok(rec.timeline.copiedAt);
  assert.ok(rec.timeline.rotatedAt);
});

test('tripwire (rotation-on): reviewMode=always → uploadStatus="pending"', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanReviewMode: 'always' });

  const rollName = 'ROLL-TRIP-ALWAYS';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus, 'pending', 'always mode → defer');
});

test('tripwire (rotation-on): smart mode + low-confidence frame → uploadStatus="pending"', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanReviewMode: 'smart' });
  __orient.predict = () => ({
    predictedClass: 0, predictedAngle: 0,
    confidence: 0.60,           // < 0.75 low-conf threshold
    classScores: [0.60, 0.20, 0.15, 0.05],
    inferenceMs: 5, error: null,
  });

  const rollName = 'ROLL-TRIP-SMART-LOW';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus, 'pending', 'smart mode + low-conf → defer');
});

test('tripwire (rotation-on): smart mode + rotation error → uploadStatus="pending"', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanReviewMode: 'smart' });
  __orient.predictThrows = true;

  const rollName = 'ROLL-TRIP-SMART-ERR';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus, 'pending', 'smart mode + rotation error → defer');
});

test('tripwire (rotation-on): smart mode + all-confident + no PC → uploadStatus undefined (no signals)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanReviewMode: 'smart' });

  const rollName = 'ROLL-TRIP-SMART-OK';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus, undefined, 'smart mode + no signals → no defer');
});

test('tripwire (rotation-on): auto-assign on → uploadStatus="pending", auto-assign gate fields populated', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanReviewMode: 'never',
    filmScanAutoAssignEnabled: true,
  });

  const rollName = 'ROLL-TRIP-AA';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus, 'pending', 'auto-assign forces defer');
  assert.equal(rec.awaitingAssignment, true);
  assert.equal(rec.reviewPassed, true, 'never mode + no signals → reviewPassed=true (Gate A open)');
  assert.equal(rec.matchedJobId, null);
  assert.equal(rec.matchedJobNumber, null);
  assert.equal(rec.matchedOrderId, null);
  assert.equal(rec.matchedOrderNumber, null);
  assert.equal(rec.matchedTwinCheck, null);
  assert.equal(rec.matchedAt, null);
});

// ── NEW (rotation-off): frame + roll recording appears once decoupled ───────

test('rotation-off: every frame is recorded with the same top-level shape as rotation-on', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });

  const rollName = 'ROLL-OFF-SHAPE';
  seedRoll(watch, rollName, {
    'a.jpg': Buffer.from('A'),
    'b.jpg': Buffer.from('B'),
    'c.tif': Buffer.from('C'),
  });

  await folderWatchService._processFilmScans(__config);

  const frames = frameMetadataStore.listByRoll(rollName);
  assert.equal(frames.length, 3, 'all three frames recorded when rotation is off');

  for (const [i, expectedName] of ['a.jpg', 'b.jpg', 'c.tif'].entries()) {
    const f = frames[i];
    assertFrameTopKeysExact(`rotation-off frame ${i}`, f);
    assert.equal(f.rollId, rollName);
    assert.equal(f.frameIndex, i);
    assert.equal(f.fileName, expectedName);
    assert.equal(f.frameId, `${rollName}_${i}`);
    assert.equal(typeof f.thumbnailPath, 'string', 'thumbnail path recorded');
    assert.equal(f.thumbnailError, null);
    assert.deepEqual(f.operatorFlags, []);
  }
});

test('rotation-off: rotation field is state C — skipped:true with a reason', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });

  const rollName = 'ROLL-OFF-STATE-C';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rot = frameMetadataStore.listByRoll(rollName)[0].rotation;
  assert.equal(rot.skipped, true, 'state C: rotation.skipped === true');
  assert.equal(typeof rot.reason, 'string', 'state C: reason present');
  assert.ok(rot.reason.length > 0, 'state C: reason non-empty');
  assert.equal(rot.error, undefined, 'state C: no rotation.error (that would collapse into state B)');
  assert.equal(rot.applied, undefined, 'state C: no rotation.applied (that would collapse into state A)');
  assert.equal(rot.confidence, undefined, 'state C: no confidence (nothing to score)');
});

test('rotation-off: roll record is written even with auto-assign off', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });

  const rollName = 'ROLL-OFF-ROLL';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.ok(rec, 'rotation-off writes a roll record even without auto-assign');
  assert.equal(rec.storagePath, path.join(storage, folderWatchService._getDateSubfolder(), rollName));
  assert.equal(rec.uploadStatus, undefined, 'never mode → no defer');
  assert.equal(rec.processingStatus, null);
});

test('rotation-off: reviewMode=always still defers the roll', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    filmScanReviewMode:      'always',
  });

  const rollName = 'ROLL-OFF-ALWAYS';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus, 'pending', 'always mode still defers with rotation off');
});

test('rotation-off + smart mode + no PC → no defer (no AI signals, no PC signals)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    filmScanReviewMode:      'smart',
  });

  const rollName = 'ROLL-OFF-SMART-NOSIG';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rec = frameMetadataStore.getRoll(rollName);
  assert.equal(rec.uploadStatus, undefined,
    'smart mode with rotation off degrades to auto-upload when nothing (PC or otherwise) is signalling');
});

test('rotation-off + auto-assign: EXACTLY ONE roll record with the auto-assign gate fields (no duplicate writers)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled:   false,
    filmScanAutoAssignEnabled: true,
  });

  const rollName = 'ROLL-OFF-AA';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const rollsMap = frameMetadataStore.store.get('rolls', {});
  const matching = Object.keys(rollsMap).filter((k) => k === rollName);
  assert.equal(matching.length, 1, 'exactly one roll record — unified writer, not two');

  const rec = rollsMap[rollName];
  assert.equal(rec.uploadStatus, 'pending', 'auto-assign defers');
  assert.equal(rec.awaitingAssignment, true);
  assert.equal(rec.reviewPassed, true, 'no review surface with rotation off → Gate A trivially open');
  assert.equal(rec.matchedJobId, null);
  assert.equal(rec.matchedOrderId, null);
});

test('rotation-off + auto-assign roll record shape agrees with rotation-on + auto-assign on the gate fields', async () => {
  // Rotation-on run
  resetSharedState();
  {
    const { watch, storage } = makeWorkspace();
    __config = baseFilmConfig(watch, storage, {
      filmScanRotationEnabled:   true,
      filmScanAutoAssignEnabled: true,
    });
    seedRoll(watch, 'ROLL-ON-AA', { 'a.jpg': Buffer.from('A') });
    await folderWatchService._processFilmScans(__config);
  }
  const onRec  = frameMetadataStore.getRoll('ROLL-ON-AA');

  // Rotation-off run
  resetSharedState();
  {
    const { watch, storage } = makeWorkspace();
    __config = baseFilmConfig(watch, storage, {
      filmScanRotationEnabled:   false,
      filmScanAutoAssignEnabled: true,
    });
    seedRoll(watch, 'ROLL-OFF-AA', { 'a.jpg': Buffer.from('A') });
    await folderWatchService._processFilmScans(__config);
  }
  const offRec = frameMetadataStore.getRoll('ROLL-OFF-AA');

  // Same auto-assign gate shape regardless of rotation flag.
  for (const key of ['awaitingAssignment', 'reviewPassed', 'matchedJobId',
                     'matchedJobNumber', 'matchedOrderId', 'matchedOrderNumber',
                     'matchedTwinCheck', 'matchedAt']) {
    assert.deepEqual(offRec[key], onRec[key],
      `unified writer: gate field "${key}" agrees between rotation-on and rotation-off`);
  }
  // Both defer for the same reason
  assert.equal(offRec.uploadStatus, 'pending');
  assert.equal(onRec.uploadStatus,  'pending');
});

test('rotation-off: filmReview IPCs discover the roll and its thumbnails', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });

  const rollName = 'ROLL-OFF-IPC';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A'), 'b.jpg': Buffer.from('B') });

  await folderWatchService._processFilmScans(__config);

  // These are the exact calls ipc-handlers.js makes for filmReviewListRolls,
  // filmReviewGetThumbnail and filmReviewGetRoll — asserted through the
  // store because the IPC handlers are thin passthroughs.
  const summaries = frameMetadataStore.listRollsWithSummary();
  const summary   = summaries.find((r) => r.rollId === rollName);
  assert.ok(summary, 'filmReviewListRolls returns rotation-off rolls');
  assert.equal(summary.frameCount, 2);

  const detail = frameMetadataStore.getRollWithFrames(rollName);
  assert.ok(detail, 'filmReviewGetRoll returns rotation-off rolls');
  assert.equal(detail.frames.length, 2);
  for (const f of detail.frames) {
    assert.equal(typeof f.thumbnailPath, 'string', 'filmReviewGetThumbnail has a path to resolve');
    assert.ok(fs.existsSync(f.thumbnailPath), 'thumbnail file exists on disk');
  }
});

test('rotation-off summary counters: no rotation → autoRotated/lowConf/rotError counts all zero, no false alarms', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });

  const rollName = 'ROLL-OFF-COUNTS';
  seedRoll(watch, rollName, {
    'a.jpg': Buffer.from('A'),
    'b.jpg': Buffer.from('B'),
  });

  await folderWatchService._processFilmScans(__config);

  const summary = frameMetadataStore.listRollsWithSummary().find((r) => r.rollId === rollName);
  assert.equal(summary.autoRotatedCount,   0);
  assert.equal(summary.lowConfidenceCount, 0, 'no confidence scores → no low-conf count');
  assert.equal(summary.rotationErrorCount, 0, 'no rotation ran → no rotation error count');
});

// ── Three-state distinguishability (locks item 2's representation) ──────────

test('three states are pairwise distinguishable via a single predicate over rotation shape', async () => {
  // State A — rotation-on, prediction succeeded
  resetSharedState();
  {
    const { watch, storage } = makeWorkspace();
    __config = baseFilmConfig(watch, storage);
    seedRoll(watch, 'A-ROLL', { 'x.jpg': Buffer.from('X') });
    await folderWatchService._processFilmScans(__config);
  }
  const stateA = frameMetadataStore.listByRoll('A-ROLL')[0].rotation;

  // State B — rotation-on, prediction throws
  resetSharedState();
  {
    const { watch, storage } = makeWorkspace();
    __config = baseFilmConfig(watch, storage);
    __orient.predictThrows = true;
    seedRoll(watch, 'B-ROLL', { 'x.jpg': Buffer.from('X') });
    await folderWatchService._processFilmScans(__config);
  }
  const stateB = frameMetadataStore.listByRoll('B-ROLL')[0].rotation;

  // State C — rotation off
  resetSharedState();
  {
    const { watch, storage } = makeWorkspace();
    __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });
    seedRoll(watch, 'C-ROLL', { 'x.jpg': Buffer.from('X') });
    await folderWatchService._processFilmScans(__config);
  }
  const stateC = frameMetadataStore.listByRoll('C-ROLL')[0].rotation;

  // Predicate: (rotation.skipped === true) ? C
  //          : (rotation.error is a non-empty string) ? B
  //          : A
  const classify = (rot) => {
    if (rot && rot.skipped === true) return 'C';
    if (rot && typeof rot.error === 'string' && rot.error.length > 0) return 'B';
    return 'A';
  };

  assert.equal(classify(stateA), 'A', 'state A classifies as A');
  assert.equal(classify(stateB), 'B', 'state B classifies as B');
  assert.equal(classify(stateC), 'C', 'state C classifies as C');
});

test('three-state predicate: existing frame-metadata-store summary counters treat state C as neither error nor low-conf', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });
  seedRoll(watch, 'ROLL-C-SUMMARY', {
    'a.jpg': Buffer.from('A'), 'b.jpg': Buffer.from('B'),
  });
  await folderWatchService._processFilmScans(__config);

  const summary = frameMetadataStore.listRollsWithSummary().find((r) => r.rollId === 'ROLL-C-SUMMARY');
  assert.equal(summary.rotationErrorCount, 0, 'state C is NOT counted as a rotation error');
  assert.equal(summary.lowConfidenceCount, 0, 'state C is NOT counted as low-confidence');
  assert.equal(summary.autoRotatedCount,   0, 'state C is NOT counted as auto-rotated');
});

// ── orientation-service NOT ready (rotation configured on, but unavailable) ──

test('rotation configured on but orientation service NOT ready → frames record state C with reason', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage);
  __orient.ready = false;

  const rollName = 'ROLL-NOT-READY';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const frames = frameMetadataStore.listByRoll(rollName);
  assert.equal(frames.length, 1, 'frame still recorded when orientation not ready');
  const rot = frames[0].rotation;
  assert.equal(rot.skipped, true, 'unready orientation → state C, not a synthetic error');
  assert.equal(typeof rot.reason, 'string');
  assert.ok(/not.?ready/i.test(rot.reason), 'reason mentions not-ready state');
});

// ── Single-upload invariant (rotation-off) ──────────────────────────────────
//
// Once frame + roll recording is unconditional, rotation-off rolls flow
// through the same uploadFolder call sites as rotation-on rolls. There are
// three sites in folder-watch-service.js: (A) inline Step 3 in
// _processFilmScans, (B) inside _uploadRollFromStorage — which is called by
// (i) _resumeInterruptedUploads on every tick, (ii) the auto-assign matcher
// on match, (iii) the operator "upload-unmatched" / "approve-roll" IPCs.
//
// The invariant: a rotation-off roll must hit S3 EXACTLY ONCE per outcome
// in a single _processFilmScans cycle — the same as rotation-on. If a
// future refactor lets Site A AND a Site B caller both fire in the same
// tick for the same roll, that's a double upload to the lab's bucket.
//
// These tests count uploadFolder invocations via the __s3Calls capture on
// the s3-service stub and lock the count for each config combination.

test('single-upload invariant: rotation-off + AA off + never mode + s3 configured → EXACTLY ONE uploadFolder call', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    filmScanReviewMode:      'never',
    // Give _buildS3Config something to return truthy so Step 3 actually
    // enters the uploadFolder branch (rather than the "no s3Config → skip"
    // branch that would give a misleading zero-count pass).
    s3BucketName:            'fake-bucket',
    s3Provider:              'pixfizz',
  });
  seedRoll(watch, 'ROLL-SINGLE-A', { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  assert.equal(__s3Calls.length, 1,
    'Site A fired exactly once — no matcher, no resume, no operator IPC picked it up');
  assert.equal(frameMetadataStore.getRoll('ROLL-SINGLE-A').uploadStatus, 'uploaded');
});

test('single-upload invariant: rotation-off + AA off + reviewMode="always" → ZERO uploadFolder calls (held for operator)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    filmScanReviewMode:      'always',
    s3BucketName:            'fake-bucket',
    s3Provider:              'pixfizz',
  });
  seedRoll(watch, 'ROLL-SINGLE-ALWAYS', { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  assert.equal(__s3Calls.length, 0,
    'always mode holds the roll for operator approval; no auto-upload from Site A or Site B');
  assert.equal(frameMetadataStore.getRoll('ROLL-SINGLE-ALWAYS').uploadStatus, 'pending',
    'roll is held pending, not uploaded');
});

test('single-upload invariant: rotation-off + AA on → ZERO uploadFolder calls in the ingest cycle (waits for matcher)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled:   false,
    filmScanAutoAssignEnabled: true,
    s3BucketName:              'fake-bucket',
    s3Provider:                'pixfizz',
  });
  seedRoll(watch, 'ROLL-SINGLE-AA', { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  assert.equal(__s3Calls.length, 0,
    'auto-assign holds Gate B open; ingest cycle never fires Site A, matcher fires Site B once matched');
  const rec = frameMetadataStore.getRoll('ROLL-SINGLE-AA');
  assert.equal(rec.uploadStatus,       'pending');
  assert.equal(rec.awaitingAssignment, true);
});

test('single-upload invariant: rotation-off self-heal — resume path retries a "failed" roll via Site B exactly once per tick', async () => {
  // Locks that resume (Site B) picks up a rotation-off roll left at
  // uploadStatus='failed' — same self-heal path rotation-on uses.
  // Site A's own retry loop uses real setTimeout backoffs, so we plant
  // the 'failed' state directly rather than running Site A to failure
  // (which would take 120s on real wall-clock waits). The invariant
  // this locks: (a) resume WILL now touch rotation-off rolls
  // post-decoupling (the guard we removed) and (b) it fires uploadFolder
  // for the resumed roll exactly once per tick, not multiple times.
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    filmScanReviewMode:      'never',
    s3BucketName:            'fake-bucket',
    s3Provider:              'pixfizz',
  });

  // Plant a rotation-off roll in the 'failed' state, with a real
  // storagePath resume can uploadFolder from, and a frame record so
  // listRollsWithSummary surfaces it (that method iterates the frames
  // dict, then merges roll records — a roll with no frames only shows
  // up when it has a processingStatus, which a 'failed' upload doesn't).
  const rollId = 'ROLL-SELFHEAL';
  const dateSub = folderWatchService._getDateSubfolder();
  const rollStorage = path.join(storage, dateSub, rollId);
  fs.mkdirSync(rollStorage, { recursive: true });
  fs.writeFileSync(path.join(rollStorage, 'a.jpg'), Buffer.from('A'));
  frameMetadataStore.record(`${rollId}_0`, {
    rollId, frameIndex: 0, fileName: 'a.jpg',
    originalPath: path.join(rollStorage, 'a.jpg'),
    thumbnailPath: null, thumbnailError: null,
    rotation: { skipped: true, reason: 'rotation-disabled' },
    operatorFlags: [],
  });
  frameMetadataStore.recordRoll(rollId, {
    storagePath:      rollStorage,
    locationId:       'loc-1',
    s3Prefix:         'film-scans/loc-1/',
    uploadStatus:     'failed',
    uploadError:      'simulated prior failure',
    processingStatus: null,
  });

  // Empty watch folder → Step 3 (Site A) can't fire for a new roll.
  // The only S3 activity in this tick must come from resume → Site B.
  const beforeCalls = __s3Calls.length;
  await folderWatchService._processFilmScans(__config);
  const totalCalls = __s3Calls.length - beforeCalls;

  assert.equal(totalCalls, 1,
    'resume fires Site B EXACTLY once for the failed rotation-off roll — no double upload');
  assert.equal(frameMetadataStore.getRoll(rollId).uploadStatus, 'uploaded',
    'Site B retry succeeded');
});

test('single-upload invariant: an "uploaded" rotation-off roll is NEVER re-picked-up by resume across successive ticks', async () => {
  // The strictest tripwire against "resume touches uploaded rolls":
  // seed an already-uploaded rotation-off roll and run resume repeatedly.
  // Filter is uploadStatus ∈ {'uploading','failed'}; 'uploaded' must
  // never enter the resume candidates list.
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    s3BucketName:            'fake-bucket',
    s3Provider:              'pixfizz',
  });

  const rollId = 'ROLL-ALREADY-UPLOADED';
  const dateSub = folderWatchService._getDateSubfolder();
  const rollStorage = path.join(storage, dateSub, rollId);
  fs.mkdirSync(rollStorage, { recursive: true });
  fs.writeFileSync(path.join(rollStorage, 'a.jpg'), Buffer.from('A'));
  // Frame record must exist so listRollsWithSummary surfaces the roll —
  // otherwise this test passes trivially (invisible ≠ filter working).
  frameMetadataStore.record(`${rollId}_0`, {
    rollId, frameIndex: 0, fileName: 'a.jpg',
    originalPath: path.join(rollStorage, 'a.jpg'),
    thumbnailPath: null, thumbnailError: null,
    rotation: { skipped: true, reason: 'rotation-disabled' },
    operatorFlags: [],
  });
  frameMetadataStore.recordRoll(rollId, {
    storagePath:  rollStorage,
    locationId:   'loc-1',
    s3Prefix:     'film-scans/loc-1/',
    uploadStatus: 'uploaded',
    uploadedAt:   new Date().toISOString(),
  });

  await folderWatchService._processFilmScans(__config);
  await folderWatchService._processFilmScans(__config);
  await folderWatchService._processFilmScans(__config);

  assert.equal(__s3Calls.length, 0,
    'resume must never re-upload a roll already at uploadStatus="uploaded"');
});

test('single-upload invariant: successive ticks do NOT re-fire uploadFolder on a completed rotation-off roll', async () => {
  // The clearest tripwire against "resume picks up an already-uploaded
  // roll". Site A succeeds in tick 1; ticks 2 and 3 must not call
  // uploadFolder for the same roll again — resume's filter is
  // uploadStatus ∈ {'uploading','failed'} which must exclude 'uploaded'.
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    filmScanRotationEnabled: false,
    filmScanReviewMode:      'never',
    s3BucketName:            'fake-bucket',
    s3Provider:              'pixfizz',
  });
  seedRoll(watch, 'ROLL-DONE', { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);   // tick 1: Site A uploads
  const afterTick1 = __s3Calls.length;
  assert.equal(afterTick1, 1, 'tick 1: one Site A upload');
  assert.equal(frameMetadataStore.getRoll('ROLL-DONE').uploadStatus, 'uploaded');

  await folderWatchService._processFilmScans(__config);   // tick 2: nothing to do
  await folderWatchService._processFilmScans(__config);   // tick 3: nothing to do

  assert.equal(__s3Calls.length, afterTick1,
    'uploaded rolls are NEVER re-uploaded by resume — filter excludes uploadStatus="uploaded"');
});
