/**
 * Unit tests for src/main/services/fuji-jobmaker-generator.js.
 *
 * Two flavours of test:
 *   1. Golden-file — emit the BALLY-Q7F39E_Lustre.txt sample from a
 *      hand-constructed job/controller and compare structurally.
 *   2. Behavioural — cover field-level rules: AutoCorrect, BackPrint modes,
 *      multi-surface emission, Order_ID generation, DueTime formatting, etc.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  generateFujiJobMakerFiles,
  _internals,
} = require('../fuji-jobmaker-generator');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const GOLDEN = path.join(REPO, 'docs', 'Fuji Jobmaker', 'BALLY-Q7F39E_Lustre.txt');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Split a file into non-empty, trimmed lines. Lets us compare two files for
 * structural equivalence (same lines, same order) without being tripped up by
 * cosmetic whitespace differences (e.g. the production sample has a leading
 * blank line and a double-blank between two photo packages that aren't
 * structurally required).
 */
function structuralLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Build the per-image entry the BALLY example expects. The example pairs each
 * front image with a back-print image filename — so for the golden-file test
 * we'll hand-feed those via `backPrint` and use 'image' mode (which emits the
 * backPrint field verbatim).
 */
function bImg(filename, backPrint) {
  return {
    filename,
    printCode: '3.5x5',
    quantity: 1,
    backPrint,
  };
}

function bMakeBallyJob() {
  return {
    orderRef: 'BALLY-Q7F39E',
    customer: { fullName: 'Jersey Smith' },
    surfaceGroups: [{
      surface: 'Lustre',
      surfaceCode: 'L',
      images: [
        // First photo package (job 100000004876)
        bImg('03505-cut-print_BALLY-Q7F39E_L1_100000004876_1_Q1.jpg', 'IMG_20260506_234158.jpg'),
        bImg('03505-cut-print_BALLY-Q7F39E_L2_100000004876_1_Q1.jpg', 'IMG_20260506_234033.jpg'),
        bImg('03505-cut-print_BALLY-Q7F39E_L3_100000004876_1_Q1.jpg', 'Screenshot_20260506_234757_Photos.jpg'),
        bImg('03505-cut-print_BALLY-Q7F39E_L4_100000004876_1_Q1.jpg', 'Screenshot_20260506_234811_Photos.jpg'),
        // Second photo package (job 100000004877)
        bImg('03505-cut-print_BALLY-Q7F39E_L1_100000004877_1_Q1.jpg', 'Screenshot_20260506_234811_Photos.jpg'),
        bImg('03505-cut-print_BALLY-Q7F39E_L2_100000004877_1_Q1.jpg', 'Screenshot_20260506_234757_Photos.jpg'),
        bImg('03505-cut-print_BALLY-Q7F39E_L3_100000004877_1_Q1.jpg', 'IMG_20260506_234158.jpg'),
        bImg('03505-cut-print_BALLY-Q7F39E_L4_100000004877_1_Q1.jpg', 'IMG_20260506_234033.jpg'),
      ],
    }],
  };
}

function bMakeBallyController() {
  return {
    imageStagingRoot: '\\\\MASTER\\Pixfizz\\Artwork',
    printerName: 'DL650-A1',
    autoCorrect: null,
    backprintMode: 'image',
  };
}

// ── 1. Golden-file structural equivalence ────────────────────────────────────

test('generateFujiJobMakerFiles reproduces the BALLY-Q7F39E_Lustre.txt sample structurally', () => {
  const golden = fs.readFileSync(GOLDEN, 'utf8');

  const result = generateFujiJobMakerFiles(bMakeBallyJob(), bMakeBallyController());
  assert.equal(result.length, 1, 'one surface group → one file');
  assert.equal(result[0].filename, 'BALLY-Q7F39E_Lustre.txt');

  const actual = structuralLines(result[0].contents);
  const expected = structuralLines(golden);

  assert.deepEqual(
    actual,
    expected,
    'structural lines (non-empty, trimmed) must match the production sample'
  );
});

test('generator output uses CRLF line endings', () => {
  const { contents } = generateFujiJobMakerFiles(bMakeBallyJob(), bMakeBallyController())[0];
  assert.match(contents, /\r\n/, 'must contain CRLF');
  // Every newline should be preceded by \r — no bare \n.
  const lfPositions = [...contents.matchAll(/\n/g)].map((m) => m.index);
  for (const i of lfPositions) {
    assert.equal(contents[i - 1], '\r', `bare LF at offset ${i}`);
  }
});

// ── 2. Order_ID generation ───────────────────────────────────────────────────

test('Order_ID uses {surfaceCode}-{orderRef} when surfaceCode is set', () => {
  assert.equal(_internals._buildOrderId('BALLY-Q7F39E', 'L', 'Lustre'), 'L-BALLY-Q7F39E');
  assert.equal(_internals._buildOrderId('1000', 'G', 'Glossy'),         'G-1000');
});

test('Order_ID falls back to first letter of surface when surfaceCode is missing', () => {
  assert.equal(_internals._buildOrderId('BALLY-Q7F39E', null, 'Lustre'), 'L-BALLY-Q7F39E');
  assert.equal(_internals._buildOrderId('BALLY-Q7F39E', '',   'matte'),  'M-BALLY-Q7F39E');
});

test('Order_ID falls back to orderRef alone when neither surfaceCode nor surface is usable', () => {
  assert.equal(_internals._buildOrderId('BALLY-Q7F39E', null, null), 'BALLY-Q7F39E');
});

// ── 3. ImagePath formatting ──────────────────────────────────────────────────

test('ImagePath always ends with a single backslash', () => {
  // No trailing slash on input → one is added.
  assert.equal(
    _internals._buildImagePath('\\\\MASTER\\Pixfizz\\Artwork', 'BALLY-Q7F39E'),
    '\\\\MASTER\\Pixfizz\\Artwork\\BALLY-Q7F39E\\'
  );
  // Trailing backslash on input → not doubled.
  assert.equal(
    _internals._buildImagePath('\\\\MASTER\\Pixfizz\\Artwork\\', 'BALLY-Q7F39E'),
    '\\\\MASTER\\Pixfizz\\Artwork\\BALLY-Q7F39E\\'
  );
  // Forward slash on input → still produces a single trailing backslash.
  assert.equal(
    _internals._buildImagePath('Z:/Artwork/', 'X1'),
    'Z:/Artwork\\X1\\'
  );
});

// ── 4. Filename ──────────────────────────────────────────────────────────────

test('Filename is {orderRef}_{surface}.txt', () => {
  assert.equal(_internals._buildFilename('BALLY-Q7F39E', 'Lustre'), 'BALLY-Q7F39E_Lustre.txt');
  assert.equal(_internals._buildFilename('1000', 'Glossy'),         '1000_Glossy.txt');
});

// ── 5. AutoCorrect emission ──────────────────────────────────────────────────

test('AutoCorrect is omitted when controller.autoCorrect is nullish', () => {
  for (const value of [null, undefined]) {
    const ctrl = { ...bMakeBallyController(), autoCorrect: value };
    const { contents } = generateFujiJobMakerFiles(bMakeBallyJob(), ctrl)[0];
    assert.doesNotMatch(contents, /^AutoCorrect=/m, `autoCorrect=${value}`);
  }
});

test('AutoCorrect emits 1 when true and 0 when false', () => {
  const trueOut = generateFujiJobMakerFiles(
    bMakeBallyJob(),
    { ...bMakeBallyController(), autoCorrect: true }
  )[0].contents;
  assert.match(trueOut, /^AutoCorrect=1$/m);

  const falseOut = generateFujiJobMakerFiles(
    bMakeBallyJob(),
    { ...bMakeBallyController(), autoCorrect: false }
  )[0].contents;
  assert.match(falseOut, /^AutoCorrect=0$/m);
});

// ── 6. BackPrint modes ───────────────────────────────────────────────────────

test("BackPrint mode 'none' omits the field entirely", () => {
  const ctrl = { ...bMakeBallyController(), backprintMode: 'none' };
  const { contents } = generateFujiJobMakerFiles(bMakeBallyJob(), ctrl)[0];
  assert.doesNotMatch(contents, /^BackPrint=/m);
});

test("BackPrint mode 'text' resolves the template per image", () => {
  const job = {
    orderRef: 'TEST-1',
    customer: { fullName: 'Jersey Smith' },
    surfaceGroups: [{
      surface: 'Lustre',
      surfaceCode: 'L',
      images: [{ filename: 'foo.jpg', printCode: '6x4', quantity: 1 }],
    }],
  };
  const ctrl = {
    imageStagingRoot: 'Z:\\Artwork',
    backprintMode: 'text',
    backprintTemplate: '{firstName}/{filename}/{orderNumber}',
  };
  const { contents } = generateFujiJobMakerFiles(job, ctrl)[0];
  assert.match(contents, /^BackPrint=Jersey\/foo\.jpg\/TEST-1$/m);
});

test("BackPrint text-mode sanitises forbidden chars and truncates to 40", () => {
  const sanitised = _internals._sanitiseBackprintText("It's a (50%) ~test~ string longer than forty chars!");
  // Per v3.1 spec: only OPEN paren, %, ; and ' are forbidden — close paren stays.
  // ~ is replaced with -. Truncated to 40 chars.
  assert.equal(sanitised, 'It s a  50 ) -test- string longer than f');
  assert.equal(sanitised.length, 40);
});

test("BackPrint mode 'image' writes image.backPrint verbatim", () => {
  const { contents } = generateFujiJobMakerFiles(bMakeBallyJob(), bMakeBallyController())[0];
  assert.match(contents, /^BackPrint=IMG_20260506_234158\.jpg$/m);
  assert.match(contents, /^BackPrint=Screenshot_20260506_234811_Photos\.jpg$/m);
});

test("BackPrint mode 'image' with no backPrint on the image omits the field", () => {
  const job = {
    orderRef: 'TEST-1',
    customer: { fullName: 'Jersey Smith' },
    surfaceGroups: [{
      surface: 'Lustre',
      surfaceCode: 'L',
      images: [{ filename: 'foo.jpg', printCode: '6x4', quantity: 1 }],
    }],
  };
  const ctrl = { imageStagingRoot: 'Z:\\Artwork', backprintMode: 'image' };
  const { contents } = generateFujiJobMakerFiles(job, ctrl)[0];
  assert.doesNotMatch(contents, /^BackPrint=/m);
});

// ── 7. Multi-surface emission ────────────────────────────────────────────────

test('A job spanning two surfaces emits two files with distinct Order_IDs', () => {
  const job = {
    orderRef: 'MULTI-1',
    customer: { fullName: 'Jane Doe' },
    surfaceGroups: [
      {
        surface: 'Lustre', surfaceCode: 'L',
        images: [{ filename: 'a.jpg', printCode: '4x6', quantity: 1 }],
      },
      {
        surface: 'Glossy', surfaceCode: 'G',
        images: [{ filename: 'b.jpg', printCode: '8x10', quantity: 2 }],
      },
    ],
  };
  const ctrl = { imageStagingRoot: 'Z:\\Artwork', backprintMode: 'none' };

  const out = generateFujiJobMakerFiles(job, ctrl);
  assert.equal(out.length, 2);

  assert.equal(out[0].filename, 'MULTI-1_Lustre.txt');
  assert.match(out[0].contents, /^Order_ID=L-MULTI-1$/m);
  assert.match(out[0].contents, /^Surface=Lustre$/m);
  assert.match(out[0].contents, /^PrintCode=4x6$/m);
  assert.match(out[0].contents, /^PrintQty=1$/m);

  assert.equal(out[1].filename, 'MULTI-1_Glossy.txt');
  assert.match(out[1].contents, /^Order_ID=G-MULTI-1$/m);
  assert.match(out[1].contents, /^Surface=Glossy$/m);
  assert.match(out[1].contents, /^PrintCode=8x10$/m);
  assert.match(out[1].contents, /^PrintQty=2$/m);
});

// ── 8. DueTime formatting ────────────────────────────────────────────────────

test('DueTime is formatted mm/dd/yyyy HH:MM:SS AM/PM in local time', () => {
  // Construct a Date directly so the test is tz-stable on any host:
  // 2026-05-07 14:37:47 local.
  const due = new Date(2026, 4, 7, 14, 37, 47);
  assert.equal(_internals._formatDueTime(due), '05/07/2026 02:37:47 PM');

  const midnight = new Date(2026, 0, 1, 0, 0, 0);
  assert.equal(_internals._formatDueTime(midnight), '01/01/2026 12:00:00 AM');

  const noon = new Date(2026, 0, 1, 12, 0, 0);
  assert.equal(_internals._formatDueTime(noon), '01/01/2026 12:00:00 PM');
});

test('DueTime is omitted from the file when job.dueAt is falsy', () => {
  const job = bMakeBallyJob();
  const { contents } = generateFujiJobMakerFiles(job, bMakeBallyController())[0];
  assert.doesNotMatch(contents, /^DueTime=/m);
});

// ── 9. Input validation ──────────────────────────────────────────────────────

test('throws when job.orderRef is missing', () => {
  assert.throws(
    () => generateFujiJobMakerFiles({ surfaceGroups: [{ surface: 'Lustre', images: [{}] }] }, bMakeBallyController()),
    /orderRef/
  );
});

test('throws when job has no surfaceGroups', () => {
  assert.throws(
    () => generateFujiJobMakerFiles({ orderRef: 'X', surfaceGroups: [] }, bMakeBallyController()),
    /surfaceGroups/
  );
});

test('throws when a surface group is missing its surface name', () => {
  const job = {
    orderRef: 'X',
    surfaceGroups: [{ surfaceCode: 'L', images: [{ filename: 'a.jpg', printCode: '4x6', quantity: 1 }] }],
  };
  assert.throws(
    () => generateFujiJobMakerFiles(job, bMakeBallyController()),
    /surface/
  );
});

test('throws when a surface group has no images', () => {
  const job = {
    orderRef: 'X',
    surfaceGroups: [{ surface: 'Lustre', images: [] }],
  };
  assert.throws(
    () => generateFujiJobMakerFiles(job, bMakeBallyController()),
    /no images/
  );
});

test('throws when controller.imageStagingRoot is missing', () => {
  assert.throws(
    () => generateFujiJobMakerFiles(bMakeBallyJob(), { backprintMode: 'none' }),
    /imageStagingRoot/
  );
});

// ── 10. PrintQty default ─────────────────────────────────────────────────────

test('PrintQty defaults to 1 when image.quantity is null/undefined', () => {
  const job = {
    orderRef: 'X',
    customer: { fullName: 'A B' },
    surfaceGroups: [{
      surface: 'Lustre', surfaceCode: 'L',
      images: [
        { filename: 'a.jpg', printCode: '4x6' },                    // quantity missing
        { filename: 'b.jpg', printCode: '4x6', quantity: null },    // explicit null
        { filename: 'c.jpg', printCode: '4x6', quantity: 0 },       // explicit 0 — honour it
      ],
    }],
  };
  const out = generateFujiJobMakerFiles(job, { imageStagingRoot: 'Z:\\A' })[0].contents;
  const qty = [...out.matchAll(/^PrintQty=(\d+)$/gm)].map((m) => m[1]);
  assert.deepEqual(qty, ['1', '1', '0']);
});

// ── 1.16.1 fujiImageRoot: emitted ImagePath uses the Fuji-view root ─────────

test('1.16.1: ImagePath emits fujiImageRoot (not imageStagingRoot) when the two differ', () => {
  // Invariant: when the two roots differ (cross-machine case), the
  // emitted `.txt` MUST carry the Fuji-view path in `ImagePath=`, not
  // OHD's local write path — that is the whole reason the field
  // exists. imageStagingRoot continues to govern where OHD writes,
  // asserted separately via the writer's tests.
  const job = bMakeBallyJob();
  const controller = {
    ...bMakeBallyController(),
    imageStagingRoot: 'C:\\Users\\op\\ohd\\Artwork',           // OHD's local view
    fujiImageRoot:    '\\\\labserver1\\Pixfizz\\Artwork',      // Fuji's view
  };
  const [out] = generateFujiJobMakerFiles(job, controller);
  const line = out.contents.split(/\r?\n/).find(l => l.startsWith('ImagePath='));
  assert.ok(line, 'output MUST contain an ImagePath= line');
  // Derived from _buildImagePath's contract: {fujiImageRoot}\{orderRef}\
  // with trailing backslash preserved.
  assert.equal(line, 'ImagePath=\\\\labserver1\\Pixfizz\\Artwork\\BALLY-Q7F39E\\',
    'ImagePath MUST be built from fujiImageRoot, not imageStagingRoot, and end in a single backslash');
  assert.ok(!line.includes('C:\\Users\\op\\ohd\\Artwork'),
    'ImagePath MUST NOT leak OHD\'s local imageStagingRoot into the file the Fuji machine reads');
});

test('1.16.1: ImagePath normalisation rules unchanged — trailing-separator / UNC / no-slash-conversion apply to fujiImageRoot too', () => {
  // The new field uses the same _buildImagePath helper as the old,
  // so its normalisation invariants transfer. Locked separately here
  // so a future refactor that switched fujiImageRoot to a different
  // normaliser would surface.
  const job = { ...bMakeBallyJob(), orderRef: 'X1' };
  const shared = { ...bMakeBallyController(), imageStagingRoot: 'unused-here' };

  // (a) Trailing separator on input is normalised to a single \.
  const [a] = generateFujiJobMakerFiles(job, { ...shared, fujiImageRoot: '\\\\srv\\share\\Art' });
  const [b] = generateFujiJobMakerFiles(job, { ...shared, fujiImageRoot: '\\\\srv\\share\\Art\\' });
  const aLine = a.contents.split(/\r?\n/).find(l => l.startsWith('ImagePath='));
  const bLine = b.contents.split(/\r?\n/).find(l => l.startsWith('ImagePath='));
  assert.equal(aLine, bLine, 'trailing-separator tolerance MUST match — with or without, same result');
  assert.equal(aLine, 'ImagePath=\\\\srv\\share\\Art\\X1\\');

  // (b) UNC leading backslashes survive.
  assert.ok(aLine.startsWith('ImagePath=\\\\'),
    'UNC leading \\\\ MUST survive — otherwise Fuji cannot resolve the share');

  // (c) Forward slashes on input are NOT converted (matches
  //     _buildImagePath's contract at line 152 of the existing test
  //     suite: `Z:/Artwork/` → `Z:/Artwork\X1\`).
  const [c] = generateFujiJobMakerFiles(job, { ...shared, fujiImageRoot: 'Z:/Artwork/' });
  const cLine = c.contents.split(/\r?\n/).find(l => l.startsWith('ImagePath='));
  assert.equal(cLine, 'ImagePath=Z:/Artwork\\X1\\',
    'forward slashes on input are preserved — no slash conversion in the middle');
});

// ── 11. TRIPWIRE (1.16.1) — fujiImageRoot no-change lock ─────────────────────
//
// 1.16.1 adds a `fujiImageRoot` field to Fuji JobMaker controllers so the
// path OHD writes images to can differ from the path OHD writes into the
// emitted `.txt`'s `ImagePath=` line. Existing controllers must be
// unaffected on upgrade — their post-migration `fujiImageRoot` is
// pre-filled from `imageStagingRoot`, and the emitted `.txt` must be
// BYTE-IDENTICAL to the pre-1.16.1 output.
//
// The invariant this test locks: setting fujiImageRoot to the same value
// as imageStagingRoot (the migration case), or leaving fujiImageRoot
// unset / null / empty (fallback cases), all produce the same output as
// having ONLY imageStagingRoot set (the pre-1.16.1 shape). The assertion
// compares generator outputs across configurations of the SAME test —
// nothing hard-coded from observed output.

test('TRIPWIRE (1.16.1): when fujiImageRoot equals imageStagingRoot (or is absent / null / empty), the emitted .txt is byte-identical to the pre-1.16.1 shape', () => {
  const job = bMakeBallyJob();
  const baseController = bMakeBallyController(); // has imageStagingRoot only — pre-1.16.1 shape

  // Baseline: imageStagingRoot only (pre-1.16.1).
  const [baseline] = generateFujiJobMakerFiles(job, baseController);

  // Case A: fujiImageRoot === imageStagingRoot (migration default: on
  // upgrade OHD pre-fills fujiImageRoot with imageStagingRoot's value
  // so every existing controller keeps working with no operator action).
  const controllerSame = { ...baseController, fujiImageRoot: baseController.imageStagingRoot };
  const [same] = generateFujiJobMakerFiles(job, controllerSame);

  // Case B: fujiImageRoot === '' (explicit empty — falls through to
  // imageStagingRoot).
  const controllerEmpty = { ...baseController, fujiImageRoot: '' };
  const [empty] = generateFujiJobMakerFiles(job, controllerEmpty);

  // Case C: fujiImageRoot === null (falls through to imageStagingRoot).
  const controllerNull = { ...baseController, fujiImageRoot: null };
  const [nullCase] = generateFujiJobMakerFiles(job, controllerNull);

  // Case D: fujiImageRoot === undefined (field never set — same as A on
  // a controller that predates the migration). Already covered by
  // `baseline` above, asserted separately for symmetry.
  assert.equal(baseController.fujiImageRoot, undefined,
    'baseline controller has NO fujiImageRoot — pre-1.16.1 shape');

  // Filename invariant: none of these change the filename.
  assert.equal(same.filename,     baseline.filename, 'A: filename byte-identical');
  assert.equal(empty.filename,    baseline.filename, 'B: filename byte-identical');
  assert.equal(nullCase.filename, baseline.filename, 'C: filename byte-identical');

  // Contents invariant: byte-identical output.
  assert.equal(same.contents,     baseline.contents,
    'A (fujiImageRoot === imageStagingRoot): contents MUST be byte-identical to pre-1.16.1 — this is the no-change lock for existing controllers on upgrade');
  assert.equal(empty.contents,    baseline.contents,
    'B (fujiImageRoot === ""): contents MUST be byte-identical to pre-1.16.1 — empty falls through to imageStagingRoot');
  assert.equal(nullCase.contents, baseline.contents,
    'C (fujiImageRoot === null): contents MUST be byte-identical to pre-1.16.1 — null falls through to imageStagingRoot');
});
