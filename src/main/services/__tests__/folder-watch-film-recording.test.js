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

stubViaCache(path.join(SVC, 's3-service.js'), {
  async uploadFolder() { return { uploaded: 0, failed: 0, total: 0 }; },
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
