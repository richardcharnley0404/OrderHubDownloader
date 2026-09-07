'use strict';

/**
 * Integration tests for _sendViaFolderCopyRouted (M4 of
 * docs/folder-copy-filename-templates-brief.md).
 *
 * The epson batch-name bug (v1.13.x) shipped past every unit test it
 * had because the writer was stubbed out and the tests never saw
 * what actually landed on disk. This suite deliberately uses the
 * REAL fs writer against a real temp directory, and asserts on
 * fs.existsSync / fs.readFileSync at the destination. §5 of the
 * brief and the tripwire section both call this out.
 *
 * The "blank template + blank strip prefix" test runs FIRST — it is
 * the no-change lock for every existing installation. If M4 ever
 * changes byte-for-byte pre-M4 output on that branch, that test
 * fails before any of the new-behaviour tests run.
 *
 * Stub scope kept as tight as possible: only configService (for
 * downloadDirectory) and printService._markCompleted (so the test
 * does not touch the OH API). Everything else — _readManifest,
 * _findJobInManifest, _getEnhancedPathMap, resolveDispatchImageSource,
 * buildCopyFilenames, fs — runs for real.
 *
 * Run via: npm test
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const fs      = require('node:fs');
const fsp     = require('node:fs/promises');
const os      = require('node:os');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC  = path.join(REPO, 'src', 'main', 'services');

// ── Stubs (require.cache injection) ──────────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// downloadDirectory is set per-test via __configOverrides so we can point at
// a fresh temp dir each time without race between tests.
let __downloadDirectory = null;
const fakeConfigService = {
  get: (key) => (key === 'downloadDirectory' ? __downloadDirectory : undefined),
  getProcessMapping:    () => ({}),
  getApiSettings:       () => ({ baseUrl: '', key: '' }),
};

const fakePrintControllerStore = {
  printControllerStore: {
    getController:      () => null,
    findChannelForJob:  () => null,
    getAllControllers:  () => [],
  },
};

const fakeRoutingService = {
  resolveRoute:            () => ({ type: 'unrouted' }),
  resolvePrintSizeCode:    () => '',
  getRoutingHeldProcesses: () => new Set(),
  getControllers:          () => [],
};

const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

stubInCache(path.join(SVC, 'config-service.js'),         fakeConfigService);
stubInCache(path.join(SVC, 'print-controller-store.js'), fakePrintControllerStore);
stubInCache(path.join(SVC, 'routing-service.js'),        fakeRoutingService);

const printService = require(path.join(SVC, 'print-service.js'));

// Spy on _markCompleted so we can assert dispatch happened (and skip the
// real jobService.markCompleted → OH API call).
const __markCompletedCalls = [];
printService._markCompleted = async (jobId) => {
  __markCompletedCalls.push(jobId);
  return undefined;
};

// ── Fixture builder ─────────────────────────────────────────────────────────

/**
 * Lay out a fixture like the ingester would:
 *
 *   {downloadRoot}/
 *     {orderNumber}_{orderId}/
 *       {orderNumber}.json         <-- manifest
 *       {orderNumber}_{jobId}/     <-- source job folder (never stripped)
 *         originals/{img}...
 *
 * @returns {{ downloadRoot, orderFolderPath, jobFolderPath, outputRoot }}
 */
async function makeFixture({ orderNumber, orderId, jobId, images }) {
  const downloadRoot   = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-fc-dl-'));
  const outputRoot     = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-fc-out-'));
  const orderFolderName = `${orderNumber}_${orderId}`;
  const jobFolderName   = `${orderNumber}_${jobId}`;
  const orderFolderPath = path.join(downloadRoot, orderFolderName);
  const jobFolderPath   = path.join(orderFolderPath, jobFolderName);

  await fsp.mkdir(path.join(jobFolderPath, 'originals'), { recursive: true });

  for (const img of images) {
    await fsp.writeFile(
      path.join(jobFolderPath, 'originals', img.filename),
      img.body || `body-${img.filename}`,
    );
  }

  await fsp.writeFile(
    path.join(orderFolderPath, `${orderNumber}.json`),
    JSON.stringify({
      jobs: [
        {
          jobId: String(jobId),
          images: images.map(img => ({
            filename:         img.filename,          // basename only — resolver walks /originals fallback
            quantity:         img.quantity ?? 1,
            originalFilename: img.originalFilename ?? img.filename,
          })),
        },
      ],
    }),
  );

  return { downloadRoot, orderFolderPath, jobFolderPath, outputRoot, jobFolderName };
}

function cleanup(t, ...dirs) {
  t.after(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  });
}

// ── Test (b) FIRST: no-change lock ──────────────────────────────────────────

test('no-change lock: blank template + blank strip prefix → byte-identical pre-M4 output', async (t) => {
  __markCompletedCalls.length = 0;
  const { downloadRoot, jobFolderPath, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-BASE',
    orderId:     'ORD-BASE',
    jobId:       501,
    images: [
      { filename: 'a.jpg', body: 'A', quantity: 1, originalFilename: 'orig-a.jpg' },
      { filename: 'b.jpg', body: 'B', quantity: 2, originalFilename: 'orig-b.jpg' },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaFolderCopyRouted(
    { id: 501, order_number: 'PXT-BASE', order_id: 'ORD-BASE' },
    { outputPath: outputRoot, controllerName: 'FC-Base' },   // NO M3 fields
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);
  assert.equal(result.method,  'folder_copy');

  // Folder name: byte-identical to pre-M4 = `${order_number}_${id}`.
  const expectedFolder = path.join(outputRoot, jobFolderName);
  assert.ok(fs.existsSync(expectedFolder), 'pre-M4 job subfolder must exist');
  // Filenames byte-identical to pre-M4 (original basenames).
  assert.deepEqual(
    fs.readdirSync(expectedFolder).sort(),
    ['a.jpg', 'b.jpg'],
    'pre-M4 filenames must match exactly — this is the no-change lock',
  );
  // Contents match — proves the writer actually copied the source bytes.
  assert.equal(fs.readFileSync(path.join(expectedFolder, 'a.jpg'), 'utf-8'), 'A');
  assert.equal(fs.readFileSync(path.join(expectedFolder, 'b.jpg'), 'utf-8'), 'B');
  assert.equal(__markCompletedCalls.length, 1, '_markCompleted called for first-send');

  // Belt-and-braces: this test WOULD fail if the folder name changed by
  // even one character. Sanity-check by asserting the folder is exactly
  // what pre-M4 would have produced — no wrapping, no prefix, no drift.
  assert.equal(result.destPath, expectedFolder);

  // Source folder path was jobFolderPath — assert it exists (still
  // un-stripped, though there's no prefix to strip in this fixture).
  assert.ok(fs.existsSync(jobFolderPath));
});

// ── Test (a): template set, 3 images ────────────────────────────────────────

test('template applied: 3 images produce exact filenames + folder name on disk', async (t) => {
  __markCompletedCalls.length = 0;
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-A',
    orderId:     'ORD-A',
    jobId:       42,
    images: [
      { filename: '1.jpg', body: 'one',   quantity: 3 },
      { filename: '2.jpg', body: 'two',   quantity: 1 },
      { filename: '3.jpg', body: 'three', quantity: 5 },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaFolderCopyRouted(
    { id: 42, order_number: 'PXT-A', order_id: 'ORD-A' },
    {
      outputPath:             outputRoot,
      controllerName:         'FC-Template',
      filenameTemplate:       '{jobId}_x{quantity}_{indexPadded}',
      destinationLayout:      'job',
      orderNumberPrefixRules: [],
    },
  );
  assert.equal(result.success, true, `unexpected failure: ${result.error}`);

  const expectedFolder = path.join(outputRoot, jobFolderName);
  const names = fs.readdirSync(expectedFolder).sort();
  // imageCount = 3 → indexPadded width = 1 (no padding).
  assert.deepEqual(names, ['42_x1_2.jpg', '42_x3_1.jpg', '42_x5_3.jpg']);

  // Contents match source — proves the copy happened and the right
  // source was paired with the right destFilename.
  assert.equal(fs.readFileSync(path.join(expectedFolder, '42_x3_1.jpg'), 'utf-8'), 'one');
  assert.equal(fs.readFileSync(path.join(expectedFolder, '42_x1_2.jpg'), 'utf-8'), 'two');
  assert.equal(fs.readFileSync(path.join(expectedFolder, '42_x5_3.jpg'), 'utf-8'), 'three');

  assert.equal(result.stats.suffixed,        0, 'no collisions expected');
  assert.equal(result.stats.truncated,       0, 'no truncation expected');
  assert.equal(result.stats.fallbacks.length, 0, 'no fallbacks expected');
});

// ── Test (c): root layout ───────────────────────────────────────────────────

test('root layout: files land in route.outputPath itself, no subfolder created', async (t) => {
  __markCompletedCalls.length = 0;
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-R',
    orderId:     'ORD-R',
    jobId:       77,
    images: [
      { filename: '1.jpg', body: 'r1' },
      { filename: '2.jpg', body: 'r2' },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaFolderCopyRouted(
    { id: 77, order_number: 'PXT-R', order_id: 'ORD-R' },
    {
      outputPath:             outputRoot,
      controllerName:         'FC-Root',
      filenameTemplate:       '{jobId}_{index}',
      destinationLayout:      'root',
      orderNumberPrefixRules: [],
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.destPath, outputRoot, 'destPath for root layout is outputPath itself');

  // No per-job subfolder anywhere under outputRoot.
  assert.equal(fs.existsSync(path.join(outputRoot, jobFolderName)), false,
    'root layout must NOT create a per-job subfolder');

  // Files at the root.
  assert.deepEqual(
    fs.readdirSync(outputRoot).sort(),
    ['77_1.jpg', '77_2.jpg'],
  );
});

// ── Test (d): strip prefix — dest stripped, source lookup NOT stripped ──────

test('strip prefix: destination folder stripped, source folder read from UN-stripped path (tripwire #3)', async (t) => {
  __markCompletedCalls.length = 0;
  const orderNumber = 'PXDEMO-STRIPME';
  const jobId       = 88;
  const { downloadRoot, orderFolderPath, jobFolderPath, outputRoot } = await makeFixture({
    orderNumber,
    orderId: 'ORD-S',
    jobId,
    images: [
      { filename: '1.jpg', body: 'strip-me-source' },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  // Proof-of-concept for the tripwire: create ONLY the un-stripped source
  // folder. If M4 accidentally strips the source lookup too, existsSync at
  // print-service.js will fail and the dispatch throws. The strip-prefix
  // matches the order number's leading tag ("PXDEMO-") so a naive shared
  // variable would produce sourceJobFolderName = "STRIPME_88" — a folder
  // that does not exist on disk.
  const strippedSourceFolder = path.join(orderFolderPath, `STRIPME_${jobId}`);
  assert.equal(fs.existsSync(strippedSourceFolder), false,
    'setup: stripped source path must NOT exist');
  assert.ok(fs.existsSync(jobFolderPath),
    'setup: un-stripped source path IS what the ingester wrote');

  const result = await printService._sendViaFolderCopyRouted(
    { id: jobId, order_number: orderNumber, order_id: 'ORD-S' },
    {
      outputPath:             outputRoot,
      controllerName:         'FC-Strip',
      filenameTemplate:       '',                  // blank keeps original filename
      destinationLayout:      'job',
      orderNumberPrefixRules: [{ from: 'PXDEMO-', to: '' }],
    },
  );

  assert.equal(result.success, true, `unexpected failure: ${result.error}`);

  // Destination folder IS stripped.
  const expectedDest = path.join(outputRoot, `STRIPME_${jobId}`);
  assert.ok(fs.existsSync(expectedDest), 'destination folder uses the STRIPPED order number');
  assert.equal(fs.existsSync(path.join(outputRoot, `${orderNumber}_${jobId}`)), false,
    'destination folder must NOT retain the un-stripped order number');

  // File content came from the un-stripped source — the byte-check proves
  // the read side went to the right place (not just that a file exists).
  assert.equal(fs.readFileSync(path.join(expectedDest, '1.jpg'), 'utf-8'), 'strip-me-source',
    'destination file must contain the bytes from the UN-stripped source folder');

  // sourcePath in the return is the un-stripped path — locks the
  // two-variables discipline against future reuse-one-variable regressions.
  assert.equal(result.sourcePath, jobFolderPath,
    'result.sourcePath must reference the UN-stripped source folder');
});

// ── Test (e): per-image quantity threads through ────────────────────────────

test('per-image {quantity} reaches the resolver (not blank because caller forgot to thread)', async (t) => {
  __markCompletedCalls.length = 0;
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-Q',
    orderId:     'ORD-Q',
    jobId:       9,
    images: [
      { filename: 'p.jpg', quantity: 4 },
      { filename: 'q.jpg', quantity: 12 },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaFolderCopyRouted(
    { id: 9, order_number: 'PXT-Q', order_id: 'ORD-Q' },
    {
      outputPath:             outputRoot,
      controllerName:         'FC-Q',
      filenameTemplate:       'img-x{quantity}',
      destinationLayout:      'job',
      orderNumberPrefixRules: [],
    },
  );
  assert.equal(result.success, true);
  const dest = path.join(outputRoot, jobFolderName);
  const names = fs.readdirSync(dest).sort();
  assert.deepEqual(names, ['img-x12.jpg', 'img-x4.jpg']);
});

// ── Test (f): default-folder route (only outputPath + controllerName) ───────

test('default-folder route (auto-print D4 shape): original filenames, original folder', async (t) => {
  __markCompletedCalls.length = 0;
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-DFR',
    orderId:     'ORD-DFR',
    jobId:       333,
    images: [
      { filename: 'x.jpg', body: 'X' },
      { filename: 'y.jpg', body: 'Y' },
      { filename: 'z.jpg', body: 'Z' },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  // Exactly the shape ipc-handlers.js:4139 passes — no M3 fields at all.
  // Every M3 default must fall out here, giving pre-M4 behaviour verbatim.
  const result = await printService._sendViaFolderCopyRouted(
    { id: 333, order_number: 'PXT-DFR', order_id: 'ORD-DFR' },
    {
      outputPath:     outputRoot,
      controllerName: 'Default Folder',
    },
  );
  assert.equal(result.success, true);

  const expectedFolder = path.join(outputRoot, jobFolderName);
  assert.ok(fs.existsSync(expectedFolder));
  assert.deepEqual(fs.readdirSync(expectedFolder).sort(), ['x.jpg', 'y.jpg', 'z.jpg']);
});

// ── Test (g): retry produces _2 duplicates in 1.16.2 (never-overwrite) ──────

test('1.16.2 retry: dispatching the same job twice adds _2 variants — the never-overwrite guarantee wins over idempotence', async (t) => {
  // Pre-1.16.2, this test's title read "identical filenames both times,
  // no _2 duplicates" and locked the §4.4 idempotence guarantee. 1.16.2
  // deliberately reverses that: item 1 of the release brief is
  // "OHD must NEVER replace an existing file in a Folder Copy
  // destination", and the tension between "retry is idempotent" and
  // "retry never overwrites" is resolved in favour of safety. Operators
  // who genuinely want to re-dispatch a job now see the second dispatch
  // add `_2` variants instead of silently rewriting the first dispatch's
  // output. The dispatch-log's `diskSuffixedCount` (M-1.16.2) makes this
  // visible so an operator can see when a retry has doubled.
  __markCompletedCalls.length = 0;
  const { downloadRoot, outputRoot, jobFolderName } = await makeFixture({
    orderNumber: 'PXT-RETRY',
    orderId:     'ORD-RETRY',
    jobId:       55,
    images: [
      { filename: 'a.jpg', body: 'A' },
      { filename: 'b.jpg', body: 'B' },
      { filename: 'c.jpg', body: 'C' },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const dispatch = () => printService._sendViaFolderCopyRouted(
    { id: 55, order_number: 'PXT-RETRY', order_id: 'ORD-RETRY' },
    {
      outputPath:             outputRoot,
      controllerName:         'FC-Retry',
      filenameTemplate:       '{jobId}-{index}',
      destinationLayout:      'job',
      orderNumberPrefixRules: [],
    },
  );

  const first  = await dispatch();
  const second = await dispatch();
  assert.equal(first.success,  true);
  assert.equal(second.success, true);

  const dest = path.join(outputRoot, jobFolderName);
  const names = fs.readdirSync(dest).sort();
  // Six files after the second dispatch: three from the first + three _2
  // variants from the second. The pre-1.16.2 assertion (`['55-1.jpg',
  // '55-2.jpg', '55-3.jpg']`) locked the exact behaviour item 1 exists
  // to REPLACE — so an assertion that "hid" as idempotence now surfaces
  // as the never-overwrite guarantee it actually is. The within-dispatch
  // planner stats.suffixed stays 0 (each dispatch's names are distinct
  // WITHIN that dispatch); the cross-dispatch suffixing is reported on
  // stats.diskSuffixed, which is the operator's signal.
  assert.deepEqual(names, [
    '55-1.jpg', '55-1_2.jpg',
    '55-2.jpg', '55-2_2.jpg',
    '55-3.jpg', '55-3_2.jpg',
  ]);
  assert.equal(first.stats.suffixed,      0, 'first dispatch has no within-call collisions');
  assert.equal(first.stats.diskSuffixed,  0, 'first dispatch lands into an empty folder');
  assert.equal(second.stats.suffixed,     0, 'second dispatch also has no within-call collisions');
  assert.equal(second.stats.diskSuffixed, 3,
    'second dispatch collides with three on-disk files → three _2 suffixes reported');
  // Bytes: first dispatch's files are UNTOUCHED.
  assert.equal(fs.readFileSync(path.join(dest, '55-1.jpg'), 'utf-8'), 'A');
  assert.equal(fs.readFileSync(path.join(dest, '55-2.jpg'), 'utf-8'), 'B');
  assert.equal(fs.readFileSync(path.join(dest, '55-3.jpg'), 'utf-8'), 'C');
});

// ── Extra locks: source-path variable name, stats propagation ──────────────

test('result.sourcePath is the un-stripped source folder (name discipline lock)', async (t) => {
  __markCompletedCalls.length = 0;
  const { downloadRoot, jobFolderPath, outputRoot } = await makeFixture({
    orderNumber: 'PXDEMO-XYZ',
    orderId:     'ORD-XYZ',
    jobId:       1234,
    images:      [{ filename: '1.jpg' }],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  const result = await printService._sendViaFolderCopyRouted(
    { id: 1234, order_number: 'PXDEMO-XYZ', order_id: 'ORD-XYZ' },
    {
      outputPath:             outputRoot,
      controllerName:         'FC-src',
      orderNumberPrefixRules: [{ from: 'PXDEMO-', to: '' }],
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.sourcePath, jobFolderPath);
});

test('stats propagate on the return value (M4 log-once source)', async (t) => {
  __markCompletedCalls.length = 0;
  const { downloadRoot, outputRoot } = await makeFixture({
    orderNumber: 'PXT-STATS',
    orderId:     'ORD-STATS',
    jobId:       11,
    images: [
      { filename: '1.jpg' },
      { filename: '2.jpg' },
      { filename: '3.jpg' },
    ],
  });
  __downloadDirectory = downloadRoot;
  cleanup(t, downloadRoot, outputRoot);

  // Template that collides for every image → suffixed count should be 2.
  const result = await printService._sendViaFolderCopyRouted(
    { id: 11, order_number: 'PXT-STATS', order_id: 'ORD-STATS' },
    {
      outputPath:       outputRoot,
      controllerName:   'FC-stats',
      filenameTemplate: 'same',
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.stats.suffixed,  2, 'two collisions across three images');
  assert.equal(result.stats.truncated, 0);
  assert.deepEqual(result.stats.fallbacks, []);
});

// ═════════════════════════════════════════════════════════════════════════
// 1.16.2 items 1 + 5 — never-overwrite across dispatches, combined test
// ═════════════════════════════════════════════════════════════════════════
//
// The combined shape from the release brief: two jobs on the same order,
// omitJobId=true so they share `{orderNumber}/`, and a template that
// deliberately collides ({filename}) so every image maps to the same
// basename in the shared folder. This is the exact scenario the pre-
// 1.16.2 dispatch would silently overwrite on — the never-overwrite
// pass (dedupeAgainstDisk against on-disk state) is what has to save it.
// The test dispatches BOTH jobs into the same outputRoot and asserts
// nothing is overwritten and every source is preserved somewhere in the
// destination with the right bytes.

test('1.16.2 never-overwrite: two jobs on same order + omitJobId + colliding template → all files preserved with _2/_3', async (t) => {
  __markCompletedCalls.length = 0;
  const orderNumber = 'PXT-CO';
  const orderId     = 'ORD-CO';

  // Two jobs on the SAME order — both have images with the same basenames.
  const fixture1 = await makeFixture({
    orderNumber, orderId, jobId: 100,
    images: [
      { filename: 'photo.jpg', body: 'job100-photo' },
      { filename: 'label.jpg', body: 'job100-label' },
    ],
  });
  __downloadDirectory = fixture1.downloadRoot;
  // Extend job1's fixture by writing job100's manifest already has both
  // images. Now add job101 to the same order-folder + a separate job folder.
  const jobFolder101 = path.join(fixture1.orderFolderPath, `${orderNumber}_101`);
  await fsp.mkdir(path.join(jobFolder101, 'originals'), { recursive: true });
  await fsp.writeFile(path.join(jobFolder101, 'originals', 'photo.jpg'), 'job101-photo');
  await fsp.writeFile(path.join(jobFolder101, 'originals', 'label.jpg'), 'job101-label');
  // Overwrite the manifest to include both jobs.
  await fsp.writeFile(
    path.join(fixture1.orderFolderPath, `${orderNumber}.json`),
    JSON.stringify({
      jobs: [
        {
          jobId: '100',
          images: [
            { filename: 'photo.jpg', quantity: 1, originalFilename: 'photo.jpg' },
            { filename: 'label.jpg', quantity: 1, originalFilename: 'label.jpg' },
          ],
        },
        {
          jobId: '101',
          images: [
            { filename: 'photo.jpg', quantity: 1, originalFilename: 'photo.jpg' },
            { filename: 'label.jpg', quantity: 1, originalFilename: 'label.jpg' },
          ],
        },
      ],
    }),
  );
  cleanup(t, fixture1.downloadRoot, fixture1.outputRoot);

  // omitJobId=true + Per-job layout + template {filename} — deliberately
  // collision-heavy across jobs.
  const routeShape = {
    outputPath:             fixture1.outputRoot,
    controllerName:         'FC-shared-folder',
    filenameTemplate:       '{filename}',   // collides across the two jobs
    destinationLayout:      'job',
    orderNumberPrefixRules: [],
    omitJobId:              true,           // both jobs land under `${orderNumber}/`
  };

  // ── Dispatch job 100 ───────────────────────────────────────────────
  const r1 = await printService._sendViaFolderCopyRouted(
    { id: 100, order_number: orderNumber, order_id: orderId },
    routeShape,
  );
  assert.equal(r1.success, true, `job100 dispatch failed: ${r1.error}`);
  // Shared folder is `${outputRoot}/${orderNumber}` (no _{jobId}) — the
  // 1.16.2 omitJobId shape.
  const sharedFolder = path.join(fixture1.outputRoot, orderNumber);
  assert.equal(r1.destPath, sharedFolder, 'omitJobId=true → per-job folder loses _{jobId}');
  assert.deepEqual(
    fs.readdirSync(sharedFolder).sort(),
    ['label.jpg', 'photo.jpg'],
    'job100 lands photo.jpg + label.jpg into the shared folder',
  );
  assert.equal(r1.stats.diskSuffixed, 0, 'empty folder → no on-disk suffixing on first dispatch');

  // ── Dispatch job 101 into the SAME shared folder ───────────────────
  const r2 = await printService._sendViaFolderCopyRouted(
    { id: 101, order_number: orderNumber, order_id: orderId },
    routeShape,
  );
  assert.equal(r2.success, true, `job101 dispatch failed: ${r2.error}`);
  assert.equal(r2.destPath, sharedFolder, 'job101 targets the SAME shared folder — that is the whole test');

  // The never-overwrite guarantee: job100's photo.jpg + label.jpg are
  // still on disk with their original bytes, and job101's got _2
  // suffixed names.
  const finalListing = fs.readdirSync(sharedFolder).sort();
  assert.deepEqual(
    finalListing,
    ['label.jpg', 'label_2.jpg', 'photo.jpg', 'photo_2.jpg'],
    'four files in the shared folder — nothing overwritten, second-dispatch collisions suffixed _2',
  );
  // Byte-level check: original job100 files must be untouched.
  assert.equal(
    fs.readFileSync(path.join(sharedFolder, 'photo.jpg'), 'utf-8'),
    'job100-photo',
    'job100 photo.jpg MUST NOT be overwritten by job101',
  );
  assert.equal(
    fs.readFileSync(path.join(sharedFolder, 'label.jpg'), 'utf-8'),
    'job100-label',
    'job100 label.jpg MUST NOT be overwritten by job101',
  );
  // And job101's suffixed copies carry job101's bytes.
  assert.equal(
    fs.readFileSync(path.join(sharedFolder, 'photo_2.jpg'), 'utf-8'),
    'job101-photo',
    'job101 photo.jpg was preserved as photo_2.jpg',
  );
  assert.equal(
    fs.readFileSync(path.join(sharedFolder, 'label_2.jpg'), 'utf-8'),
    'job101-label',
    'job101 label.jpg was preserved as label_2.jpg',
  );
  // Stats: both collisions were resolved by the on-disk dedupe pass.
  assert.equal(r2.stats.diskSuffixed, 2,
    'both of job101\'s files needed a disk-dedupe suffix — surfaces in the operator log');
});

// ═════════════════════════════════════════════════════════════════════════
// 1.16.2 tripwire — reprint never overwrites its parent's file either
// ═════════════════════════════════════════════════════════════════════════
//
// Reprints don't apply the M3 template (§8 of the brief) — filenames are
// the reprint's own basenames. But the destination (`{outputPath}/…-r1/`)
// is a fresh folder; if the operator dispatches a reprint twice for the
// same suffix (rare but not impossible via re-run), the second dispatch
// still MUST NOT overwrite the first. The dispatch-side dedupe pass
// covers this too — belt-and-braces test that _sendReprintViaFolderCopy
// carries the same guarantee as the main path.

test('1.16.2 reprint never-overwrite: re-dispatching into a non-empty reprint folder suffixes rather than overwriting', async (t) => {
  const outputRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-fc-reprint-'));
  const reprintRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-fc-reprint-src-'));
  cleanup(t, outputRoot, reprintRoot);

  // Build the reprint source (mimicking reprintManager's `/working` layout).
  const reprintJobPath = path.join(reprintRoot, 'PXT-RE_777-r1');
  const workingPath    = path.join(reprintJobPath, 'working');
  await fsp.mkdir(workingPath, { recursive: true });
  await fsp.writeFile(path.join(workingPath, 'a.jpg'), 'second-dispatch');

  // Pre-existing destination has a file with the same name (as if a prior
  // reprint dispatch put it there).
  const destFolder = path.join(outputRoot, 'PXT-RE_777-r1');
  await fsp.mkdir(destFolder, { recursive: true });
  await fsp.writeFile(path.join(destFolder, 'a.jpg'), 'first-dispatch');

  const parentJob = { id: 777, order_number: 'PXT-RE', order_id: 'ORD-RE' };
  const reprintImages = [{ filename: 'a.jpg' }];

  const r = await printService._sendReprintViaFolderCopy(
    parentJob,
    { outputPath: outputRoot, controllerName: 'FC-reprint' },
    reprintJobPath,
    'r1',
    reprintImages,
  );
  assert.equal(r.success, true, `reprint dispatch failed: ${r.error}`);
  assert.deepEqual(
    fs.readdirSync(destFolder).sort(),
    ['a.jpg', 'a_2.jpg'],
    'reprint MUST NOT overwrite the pre-existing file — collision suffixes to _2',
  );
  assert.equal(
    fs.readFileSync(path.join(destFolder, 'a.jpg'), 'utf-8'),
    'first-dispatch',
    'pre-existing a.jpg bytes must be preserved',
  );
  assert.equal(
    fs.readFileSync(path.join(destFolder, 'a_2.jpg'), 'utf-8'),
    'second-dispatch',
    'second-dispatch bytes land under a_2.jpg',
  );
});
