/**
 * Rush-reprint controller selection: `sendReprint` accepts an optional
 * 5th `controllerId` argument that steers a Darkroom Pro reprint to a
 * specific controller other than the parent job's default route. When
 * omitted the reprint routes exactly as it always has (via
 * `resolveRoute(parent)`); when supplied, the reprint routes via
 * `resolveRouteForController(parent, controllerId)`.
 *
 * Design context: docs/rush-reprint-controller-selection-investigation.md
 * (§Q2 for the four-site chain, §Q3 for one-shot semantics). The route
 * shape between the two resolvers for Darkroom Pro was made byte-parity-
 * equivalent by the earlier hotfix locked in routing-darkroompro-fields.test.js
 * and routing-darkroompro-txt-byte-equality.test.js — this file's tests
 * are the dispatch-level equivalent of those.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * TRIPWIRE (written BEFORE touching dispatch): the no-controllerId path
 * ═════════════════════════════════════════════════════════════════════════
 * The first test in this file locks the invariant that calling
 * `sendReprint(parent, path, suffix, images)` with NO `controllerId`
 * argument produces a .TXT file byte-identical to what it produces when
 * called with `controllerId = <the parent's routed controller id>`. On
 * today's code this passes because the 5th argument is ignored (both
 * calls go through resolveRoute). After the dispatch change it still
 * passes because both routes resolve to the same controller and the
 * hotfix ensures the two resolvers agree on shape for DP.
 *
 * The test is written the byte-equality way, not the observed-value way,
 * on purpose. It is asserting a comparison invariant — "the same input
 * via two entry points yields the same output" — not a literal snapshot
 * of a specific expected file content. A future format change to the
 * emitter can shift both sides of the equality without touching this
 * test; a dispatch-side regression that made one entry point diverge
 * from the other would fail it immediately.
 *
 * Store/electron shimmed the same way the sibling routing tests do.
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');
const Module = require('node:module');

const __storeData = {};
function FakeStore() {
  return {
    get: (k, d) => (k in __storeData ? __storeData[k] : d),
    set: (k, v) => { __storeData[k] = v; },
    delete: (k) => { delete __storeData[k]; },
    has:  (k) => (k in __storeData),
  };
}
function __seed(data) {
  for (const k of Object.keys(__storeData)) delete __storeData[k];
  Object.assign(__storeData, data);
}

const fakeElectron = {
  app: { getPath: () => os.tmpdir(), on: () => {} },
};

const fakeLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  logInfo: () => {}, logError: () => {}, logDebug: () => {},
  logWarning: () => {},
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron')       return fakeElectron;
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

{
  const loggerPath = require.resolve(path.join(REPO, 'src', 'main', 'services', 'logger.js'));
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: fakeLogger };
}

const printService = require(path.join(REPO, 'src', 'main', 'services', 'print-service.js'));

// ── Fixtures ────────────────────────────────────────────────────────────────

const CTRL_ID_650 = 'ctrl-dp-650';
const CTRL_ID_400 = 'ctrl-dp-400';
const PRODUCT     = '0406-print';

function seedTwoDpControllers({ hot650, hot400 }) {
  const controller650 = {
    id:                   CTRL_ID_650,
    name:                 'Darkroom Pro 650',
    type:                 'darkroompro',
    outputPath:           hot650,
    artworkRootPath:      'Z:\\Art',
    orderLastNameFormat:  'orderRef_lastName',
    checkOrderStatus:     true,
    sizeTranslations:     [{ productCodePrefix: PRODUCT, darkroomSize: '4x6' }],
    mediaOptionKey:       'finish',
    mediaTranslations:    [{ from: 'Lustre', to: 'Thick Luster' }],
    photoLines:           [],
  };
  const controller400 = {
    ...controller650,
    id:                CTRL_ID_400,
    name:              'Darkroom Pro 400',
    outputPath:        hot400,
    // The DIFFERENCE that matters at the printer: media translation.
    mediaTranslations: [{ from: 'Lustre', to: 'Lustre' }],
  };
  __seed({
    processControllerMappings: [{ process: 'Lab', controllerId: CTRL_ID_650 }],
    orderControllers:          [controller650, controller400],
    channelMappings:           [
      { id: 'cm-650', controllerId: CTRL_ID_650, productCode: PRODUCT, options: [{ name: 'finish', value: 'Lustre' }] },
      { id: 'cm-400', controllerId: CTRL_ID_400, productCode: PRODUCT, options: [{ name: 'finish', value: 'Lustre' }] },
    ],
  });
}

const PARENT = {
  id:             777,
  order_number:   'PXDEMO-REF',
  order_id:       42,
  job_name:       'PXDEMO-REF-1',
  process:        'Lab',
  product_code:   PRODUCT,
  options:        [{ name: 'finish', value: 'Lustre' }],
  customer_name:  'Jane Smith',
  customer_email: 'jane@example.com',
  created_at:     '2026-01-15T10:00:00.000Z',
  website:        'LAB',
};

/**
 * Build a reprint folder tree with one image on disk. Corrections are
 * zero, so _applyCorrectionsToImageFiles is a passthrough — no sharp
 * dependency needed at test time. The .jpg file is empty (0 bytes)
 * because the emitter only references the path; it does not read the
 * file's contents.
 */
function makeReprintFolder(imageFilenames = ['img1.jpg']) {
  const reprintDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-reprint-'));
  const originals  = path.join(reprintDir, 'originals');
  fs.mkdirSync(originals, { recursive: true });
  for (const filename of imageFilenames) {
    fs.writeFileSync(path.join(originals, filename), '');
  }
  return reprintDir;
}

// ═════════════════════════════════════════════════════════════════════════
// TRIPWIRE — the no-controllerId invariant
// ═════════════════════════════════════════════════════════════════════════

test('TRIPWIRE: sendReprint with NO controllerId produces .TXT byte-identical to sendReprint with controllerId = parent-route-controller', async () => {
  // Two output paths so the two dispatches don't overwrite each other's
  // .TXT. The controller records for each call use the same outputPath
  // in turn (we reseed between calls).
  const hot650A = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-a-'));
  const hot650B = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-b-'));
  const hot400  = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot400-'));

  const reprintPath = makeReprintFolder();
  const reprintImages = [{ filename: 'img1.jpg', qtyCurrent: 1, corrections: {} }];

  // Call A: no controllerId (5th arg omitted) → today's behaviour, route via resolveRoute(parent)
  seedTwoDpControllers({ hot650: hot650A, hot400 });
  const resultA = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages);
  assert.equal(resultA.success, true, `no-controllerId dispatch failed: ${resultA.error}`);
  const bytesA = fs.readFileSync(resultA.destPath);

  // Call B: explicit controllerId = parent-route-controller → after change, route via
  // resolveRouteForController(parent, CTRL_ID_650); on today's code the 5th arg
  // is ignored and this ALSO goes through resolveRoute — both paths produce
  // identical output either way, which IS the invariant.
  seedTwoDpControllers({ hot650: hot650B, hot400 });
  const resultB = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages, CTRL_ID_650);
  assert.equal(resultB.success, true, `explicit-controllerId dispatch failed: ${resultB.error}`);
  const bytesB = fs.readFileSync(resultB.destPath);

  assert.equal(
    bytesB.equals(bytesA),
    true,
    'reprint .TXT differs between no-controllerId and explicit-controllerId=parent-route: ' +
    'the code change altered no-op behaviour, or the two resolvers disagree for DP.\n' +
    `  A (no controllerId):     ${resultA.destPath}\n` +
    `  B (explicit controllerId): ${resultB.destPath}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Steering — controllerId picks a different destination controller
// ═════════════════════════════════════════════════════════════════════════

test('sendReprint with controllerId targeting a DIFFERENT DP controller writes to that controller\'s outputPath', async () => {
  const hot650 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-c-'));
  const hot400 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot400-c-'));

  const reprintPath = makeReprintFolder();
  const reprintImages = [{ filename: 'img1.jpg', qtyCurrent: 1, corrections: {} }];

  seedTwoDpControllers({ hot650, hot400 });
  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages, CTRL_ID_400);

  assert.equal(result.success, true, `steered dispatch failed: ${result.error}`);
  assert.equal(
    path.dirname(result.destPath), hot400,
    'reprint .TXT must land in the chosen controller\'s outputPath, not the parent-route controller\'s',
  );
});

test('sendReprint result carries controllerName for attribution — no controllerId → parent-route controller name', async () => {
  const hot650 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-attr1-'));
  const hot400 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot400-attr1-'));

  const reprintPath = makeReprintFolder();
  const reprintImages = [{ filename: 'img1.jpg', qtyCurrent: 1, corrections: {} }];

  seedTwoDpControllers({ hot650, hot400 });
  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages);

  assert.equal(result.success, true);
  assert.equal(result.controllerName, 'Darkroom Pro 650',
    'sendReprint must return controllerName on printResult so ipc-handlers.js can stamp the reprint sidecar');
});

test('sendReprint result carries controllerName for attribution — explicit controllerId → chosen controller name', async () => {
  const hot650 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-attr2-'));
  const hot400 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot400-attr2-'));

  const reprintPath = makeReprintFolder();
  const reprintImages = [{ filename: 'img1.jpg', qtyCurrent: 1, corrections: {} }];

  seedTwoDpControllers({ hot650, hot400 });
  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages, CTRL_ID_400);

  assert.equal(result.success, true);
  assert.equal(result.controllerName, 'Darkroom Pro 400',
    'attribution must reflect the CHOSEN controller, not the parent-route controller');
});

test('sendReprint steered to a different DP controller emits that controller\'s Media translation', async () => {
  // The whole point of the feature at the lab: different controller ⇒
  // different Media= line ⇒ different printer inside Darkroom Pro. This
  // asserts the media difference lands in the file — the byte-equality
  // tripwire alone would let a "steered but wrong media" regression
  // through.
  const hot650 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-d-'));
  const hot400 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot400-d-'));

  const reprintPath = makeReprintFolder();
  const reprintImages = [{ filename: 'img1.jpg', qtyCurrent: 1, corrections: {} }];

  seedTwoDpControllers({ hot650, hot400 });

  const result650 = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages, CTRL_ID_650);
  const result400 = await printService.sendReprint(PARENT, reprintPath, 'r2', reprintImages, CTRL_ID_400);

  const text650 = fs.readFileSync(result650.destPath, 'utf8');
  const text400 = fs.readFileSync(result400.destPath, 'utf8');

  const media650 = text650.split('\r\n').find(l => l.startsWith('Media='));
  const media400 = text400.split('\r\n').find(l => l.startsWith('Media='));

  assert.equal(media650, 'Media=Thick Luster', 'DP-650 must emit its configured Media translation');
  assert.equal(media400, 'Media=Lustre',       'DP-400 must emit its configured Media translation');
});

// ═════════════════════════════════════════════════════════════════════════
// One-shot semantics — parent job's routing state is NOT touched
// ═════════════════════════════════════════════════════════════════════════

test('sendReprint with a controllerId does NOT mutate the parent job object', async () => {
  const hot650 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-e-'));
  const hot400 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot400-e-'));

  const reprintPath = makeReprintFolder();
  const reprintImages = [{ filename: 'img1.jpg', qtyCurrent: 1, corrections: {} }];

  seedTwoDpControllers({ hot650, hot400 });

  const parentBefore = JSON.stringify(PARENT);
  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages, CTRL_ID_400);
  const parentAfter  = JSON.stringify(PARENT);

  assert.equal(result.success, true);
  assert.equal(parentAfter, parentBefore,
    'parent job object must not be mutated by a steered reprint — one-shot semantics require the ' +
    'next order to route exactly as before (docs/rush-reprint-controller-selection-investigation.md §Q3)');
});

// ═════════════════════════════════════════════════════════════════════════
// Stale-mapping failure path
// ═════════════════════════════════════════════════════════════════════════

test('sendReprint with a controllerId whose channel mapping no longer exists fails cleanly with a specific message', async () => {
  const hot650 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-f-'));
  const hot400 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot400-f-'));

  const reprintPath = makeReprintFolder();
  const reprintImages = [{ filename: 'img1.jpg', qtyCurrent: 1, corrections: {} }];

  // Seed with both controllers configured — the picker would have offered
  // DP-400 as eligible when the operator opened the menu.
  seedTwoDpControllers({ hot650, hot400 });

  // Simulate: between the operator picking DP-400 and their click reaching
  // dispatch, another user (or the operator in another window) removed
  // the DP-400 mapping for this product. This is the exact race the picker
  // cannot prevent by construction — the failure must be a clean error,
  // not a fall-through to DP-650 or a silent no-op.
  const mappings = __storeData.channelMappings.filter(m => m.controllerId !== CTRL_ID_400);
  __storeData.channelMappings = mappings;

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages, CTRL_ID_400);

  assert.equal(result.success, false, 'stale-mapping dispatch must fail, not fall back to another controller');
  assert.match(
    result.error || '',
    /no.*channel|channel.*mapping|no longer.*take/i,
    'error message must indicate the chosen controller can no longer take this job — got: ' + (result.error || '<blank>'),
  );
});

test('sendReprint with a controllerId that does not exist at all fails cleanly', async () => {
  const hot650 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot650-g-'));
  const hot400 = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-hot400-g-'));

  const reprintPath = makeReprintFolder();
  const reprintImages = [{ filename: 'img1.jpg', qtyCurrent: 1, corrections: {} }];

  seedTwoDpControllers({ hot650, hot400 });

  const result = await printService.sendReprint(PARENT, reprintPath, 'r1', reprintImages, 'nonexistent-controller');

  assert.equal(result.success, false);
  assert.match(
    result.error || '',
    /controller.*(no longer exists|not found|does not exist|deleted)/i,
    'error must indicate the chosen controller does not exist — got: ' + (result.error || '<blank>'),
  );
});

test.after(() => { Module.prototype.require = __originalRequire; });
