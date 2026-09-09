'use strict';

/**
 * Tests for the Film Scan thumbnail step in folder-watch-service._processFilmScans.
 *
 * Coverage:
 *   - Rotation ON  : thumbnails still land at userData/thumbnails/{rollId}/{frameId}.jpg
 *     (unchanged from 1.16.2 behaviour).
 *   - Rotation ON  : sharp pipeline shape for the thumbnail is byte-identical
 *     to the 1.16.2 shape — same constructor options, same resize args, same
 *     jpeg quality. Captured via argument recording rather than by writing a
 *     real JPEG through native sharp, so the assertion runs headless on any
 *     platform without pulling in the ONNX / libvips deps. Same-sharp-version
 *     + same-pipeline-args + same-input implies byte-identical output.
 *   - Rotation OFF : thumbnails ARE generated for every frame (the new
 *     behaviour this change adds).
 *   - Rotation OFF : a per-frame thumbnail failure logs and continues; the
 *     roll pipeline reaches Step 2b (TIFF→JPEG) and finishes without throwing.
 *   - Ordering     : with rotation ON, the frame's thumbnail sharp call comes
 *     AFTER the frame's rotate sharp call — asserted on the recorded call
 *     sequence so the thumbnail is always taken from the final orientation.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const fs      = require('node:fs');
const path    = require('node:path');

// ── Sharp mock with argument capture ────────────────────────────────────────
//
// Chain-recorder: every call on the fluent chain pushes onto __sharpCalls
// with a monotonically increasing sequence number so the ordering test can
// prove "thumbnail after rotate" without inspecting bytes. Each toFile()
// creates a real file so the on-disk existence tests are meaningful.

let __sharpCalls = [];   // [{ seq, kind, args, src, srcOpts, dest? }, …]
let __seq        = 0;
let __toFileImpl = null; // per-test override — throw here to simulate failure

const __originalRequire = Module.prototype.require;

const __userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-thumb-ud-'));

Module.prototype.require = function (req) {
  if (req === 'electron') {
    return {
      app: { getPath: (_key) => __userDataDir },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (req === 'sharp') {
    const makeSharp = (src, srcOpts) => {
      __sharpCalls.push({ seq: ++__seq, kind: 'ctor', src, srcOpts });
      const chain = {
        rotate(...args) {
          __sharpCalls.push({ seq: ++__seq, kind: 'rotate', args, src });
          return chain;
        },
        resize(...args) {
          __sharpCalls.push({ seq: ++__seq, kind: 'resize', args, src });
          return chain;
        },
        jpeg(...args) {
          __sharpCalls.push({ seq: ++__seq, kind: 'jpeg', args, src });
          return chain;
        },
        tiff(...args) {
          __sharpCalls.push({ seq: ++__seq, kind: 'tiff', args, src });
          return chain;
        },
        async toFile(dest) {
          __sharpCalls.push({ seq: ++__seq, kind: 'toFile', dest, src });
          if (typeof __toFileImpl === 'function') {
            return await __toFileImpl(src, dest);
          }
          try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) { /* ignore */ }
          fs.writeFileSync(dest, Buffer.from(`FAKE-SHARP-OUTPUT-${path.basename(dest)}`));
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

stubViaCache(path.join(SVC, 'orientation-service.js'), {
  async init() { return true; },
  getModelVersion() { return 'stub-orient-v1'; },
  async predictOrientation(_imagePath) {
    return {
      predictedClass: 1,     // 90°  → triggers rotate branch
      predictedAngle: 90,
      confidence:     0.95,
      classScores:    [0.02, 0.95, 0.02, 0.01],
      inferenceMs:    5,
      error:          null,
    };
  },
});

stubViaCache(path.join(ENH, 'perfectlyClearClient.js'), {
  async processBatch(_opts) { return []; },
});

// Only NOW load folder-watch — it picks up all the stubs above.
const folderWatchService = require(path.join(SVC, 'folder-watch-service.js'));
const frameMetadataStore = require(path.join(SVC, 'frame-metadata-store.js'));

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetSharedState() {
  __config     = {};
  __sharpCalls = [];
  __seq        = 0;
  __toFileImpl = null;
  frameMetadataStore._clearAll();
  try {
    const rolls = frameMetadataStore.store.get('rolls', {});
    for (const rollId of Object.keys(rolls)) frameMetadataStore.deleteRoll(rollId);
  } catch (_) { /* best-effort */ }
}

function makeWorkspace() {
  const base    = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-thumb-'));
  const watch   = path.join(base, 'watch');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(watch,   { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
  return { base, watch, storage };
}

function backdate(dir, ageMs = 20 * 60 * 1000) {
  const past = new Date(Date.now() - ageMs);
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        try { fs.utimesSync(p, past, past); } catch (_) { /* ignore */ }
      }
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
    // Negative watchguard: puts stability cutoff in the future so every fresh
    // test file counts as stable. Node's fs.utimesSync can't backdate
    // birthtime on Windows; same trick the PC test file uses.
    filmScansWatchguardMinutes:  -1,
    filmScanRotationEnabled:     true,
    filmScanRotationConfidenceThreshold: 0.9,
    filmScanReviewMode:          'never',
    locationId:                  'loc-1',
    s3BucketName:                null,
    ...overrides,
  };
}

// Expected thumbnail-step pipeline shape locked in 1.16.2. If any of these
// change, byte-output for the same input MAY change too — force a deliberate
// review by failing this assertion.
const THUMB_CTOR_OPTS  = { limitInputPixels: false, failOn: 'none' };
const THUMB_RESIZE     = [512, null, { withoutEnlargement: true, fit: 'inside' }];
const THUMB_JPEG       = [{ quality: 85 }];

function assertThumbnailPipelineShape(t, callsForOneFrame, expectedDest) {
  // Constructor
  assert.equal(callsForOneFrame[0].kind, 'ctor', `${t}: first call is sharp() constructor`);
  assert.deepEqual(callsForOneFrame[0].srcOpts, THUMB_CTOR_OPTS, `${t}: ctor opts locked`);

  // Then resize → jpeg → toFile in that order
  const kinds = callsForOneFrame.map((c) => c.kind);
  assert.deepEqual(kinds, ['ctor', 'resize', 'jpeg', 'toFile'], `${t}: pipeline shape locked`);

  const resize = callsForOneFrame[1];
  assert.deepEqual(resize.args, THUMB_RESIZE, `${t}: resize args locked (512, inside, withoutEnlargement)`);

  const jpeg = callsForOneFrame[2];
  assert.deepEqual(jpeg.args, THUMB_JPEG, `${t}: jpeg quality locked (85)`);

  const toFile = callsForOneFrame[3];
  assert.equal(toFile.dest, expectedDest, `${t}: toFile writes to expected thumbnail path`);
}

function callsForFrame(imagePath) {
  return __sharpCalls.filter((c) => c.src === imagePath);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('rotation ON: thumbnails still land at userData/thumbnails/{rollId}/{frameId}.jpg for each frame', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage);

  const rollName = 'ROLL-ROT-ON';
  seedRoll(watch, rollName, {
    'a.jpg': Buffer.from('A'),
    'b.jpg': Buffer.from('B'),
  });

  await folderWatchService._processFilmScans(__config);

  const thumbDir = path.join(__userDataDir, 'thumbnails', rollName);
  const thumbA = path.join(thumbDir, `${rollName}_0.jpg`);
  const thumbB = path.join(thumbDir, `${rollName}_1.jpg`);
  assert.ok(fs.existsSync(thumbA), 'thumbnail written for frame 0');
  assert.ok(fs.existsSync(thumbB), 'thumbnail written for frame 1');

  // Frame records exist — legacy rotation-on behaviour is untouched.
  const frames = frameMetadataStore.listByRoll(rollName);
  assert.equal(frames.length, 2, 'rotation-on writes per-frame records');
  assert.equal(frames[0].thumbnailPath, thumbA);
  assert.equal(frames[1].thumbnailPath, thumbB);
});

test('rotation ON: thumbnail sharp pipeline shape is byte-identical-locked (ctor opts, resize, jpeg quality) — 1.16.2 tripwire', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, {
    // Push the confidence threshold above the stub's 0.95 so the rotate
    // branch does NOT fire — leaves only the thumbnail sharp() invocation
    // on the frame, so pipeline-shape assertions target it unambiguously.
    filmScanRotationConfidenceThreshold: 0.999,
  });

  const rollName = 'ROLL-TRIPWIRE';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const dateSub  = folderWatchService._getDateSubfolder();
  const srcA     = path.join(storage, dateSub, rollName, 'a.jpg');
  const thumbA   = path.join(__userDataDir, 'thumbnails', rollName, `${rollName}_0.jpg`);
  const frameCalls = callsForFrame(srcA);

  assertThumbnailPipelineShape('rotation-on', frameCalls, thumbA);
});

test('rotation OFF: thumbnails ARE generated for every frame', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });

  const rollName = 'ROLL-ROT-OFF';
  seedRoll(watch, rollName, {
    'a.jpg': Buffer.from('A'),
    'b.jpg': Buffer.from('B'),
    'c.tif': Buffer.from('C'),
  });

  await folderWatchService._processFilmScans(__config);

  const thumbDir = path.join(__userDataDir, 'thumbnails', rollName);
  assert.ok(fs.existsSync(path.join(thumbDir, `${rollName}_0.jpg`)), 'thumb for a.jpg');
  assert.ok(fs.existsSync(path.join(thumbDir, `${rollName}_1.jpg`)), 'thumb for b.jpg');
  assert.ok(fs.existsSync(path.join(thumbDir, `${rollName}_2.jpg`)), 'thumb for c.tif');
});

test('rotation OFF: thumbnail pipeline shape matches rotation-on (same ctor opts, resize, jpeg quality)', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });

  const rollName = 'ROLL-ROT-OFF-SHAPE';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const dateSub = folderWatchService._getDateSubfolder();
  const srcA    = path.join(storage, dateSub, rollName, 'a.jpg');
  const thumbA  = path.join(__userDataDir, 'thumbnails', rollName, `${rollName}_0.jpg`);
  const frameCalls = callsForFrame(srcA);

  assertThumbnailPipelineShape('rotation-off', frameCalls, thumbA);
});

test('rotation OFF: a per-frame thumbnail failure is non-fatal — Step 2b still runs, roll finishes', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage, { filmScanRotationEnabled: false });

  // Fail the thumbnail write for the first file, succeed for the rest.
  const failed = new Set();
  __toFileImpl = async (src, dest) => {
    if (path.basename(src) === 'a.jpg' && !failed.has(src)) {
      failed.add(src);
      throw new Error('SIMULATED-THUMB-FAILURE');
    }
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) { /* ignore */ }
    fs.writeFileSync(dest, Buffer.from(`FAKE-${path.basename(dest)}`));
    return { size: 1 };
  };

  const rollName = 'ROLL-THUMB-FAIL';
  seedRoll(watch, rollName, {
    'a.jpg': Buffer.from('A'),
    'b.tif': Buffer.from('BB'),   // TIFF → Step 2b converts to JPEG
  });

  // Must not throw.
  await folderWatchService._processFilmScans(__config);

  const dateSub    = folderWatchService._getDateSubfolder();
  const rollStore  = path.join(storage, dateSub, rollName);
  const thumbDir   = path.join(__userDataDir, 'thumbnails', rollName);

  // Failed frame — no thumbnail file, but roll proceeded.
  assert.equal(fs.existsSync(path.join(thumbDir, `${rollName}_0.jpg`)), false,
    'failed frame has no thumbnail file');
  // Second frame's thumbnail still landed (loop continued past the failure).
  assert.ok(fs.existsSync(path.join(thumbDir, `${rollName}_1.jpg`)),
    'later frames still get thumbnails after a mid-roll failure');
  // Step 2b (TIFF→JPEG) ran — the .tif became a .jpg alongside it.
  assert.ok(fs.existsSync(path.join(rollStore, 'b.jpg')),
    'Step 2b converted b.tif → b.jpg (thumbnail failure did not short-circuit the roll)');
  // Watch folder was emptied — the roll fully drained.
  assert.equal(fs.existsSync(path.join(watch, rollName)), false,
    'watch folder cleaned up (Step 2 completed)');
});

test('ordering (rotation ON): thumbnail sharp call for a frame comes AFTER the rotate call for the same frame', async () => {
  resetSharedState();
  const { watch, storage } = makeWorkspace();
  __config = baseFilmConfig(watch, storage);   // stub returns confidence 0.95 ≥ threshold 0.9 → rotate

  const rollName = 'ROLL-ORDER';
  seedRoll(watch, rollName, { 'a.jpg': Buffer.from('A') });

  await folderWatchService._processFilmScans(__config);

  const dateSub = folderWatchService._getDateSubfolder();
  const srcA    = path.join(storage, dateSub, rollName, 'a.jpg');
  const thumbA  = path.join(__userDataDir, 'thumbnails', rollName, `${rollName}_0.jpg`);

  const frameCalls = callsForFrame(srcA);

  // There should be TWO sharp() invocations for this frame: one for the
  // rotate pipeline (which produces the .rot.tmp file and renames over the
  // source) and one for the thumbnail.
  const rotateCalls = frameCalls.filter((c) => c.kind === 'rotate');
  const thumbToFile = frameCalls.find((c) => c.kind === 'toFile' && c.dest === thumbA);
  assert.ok(rotateCalls.length >= 1, 'sharp .rotate() was called on the source (rotation branch fired)');
  assert.ok(thumbToFile, 'thumbnail .toFile() was called for the source');

  const rotateSeq = rotateCalls[0].seq;
  const thumbSeq  = thumbToFile.seq;
  assert.ok(thumbSeq > rotateSeq,
    `thumbnail (seq ${thumbSeq}) must run AFTER rotate (seq ${rotateSeq}) so it reflects the final orientation`);
});
