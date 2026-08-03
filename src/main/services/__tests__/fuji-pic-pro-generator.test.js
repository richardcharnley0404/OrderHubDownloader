'use strict';

/**
 * Unit tests for src/main/services/fuji-pic-pro-generator.js.
 *
 * The generator is a pure function — no fs, no Electron — so we can
 * exercise it directly with hand-built job/controller shapes and
 * compare against a hand-built golden file at docs/Fuji Pic Pro/
 * sample-order.txt.
 *
 * Coverage:
 *   1. Golden-file structural equivalence
 *   2. CRLF line endings (matches JobMaker's byte pattern)
 *   3. Section-header ordering (spec is case-sensitive)
 *   4. `Qty=` defaults to 1 when omitted
 *   5. `Color=` defaults to 'C' when omitted
 *   6. `CustomerName=` present only when includeCustomerName===true AND name is set
 *   7. Backprint1/2 resolution + sanitisation + truncation shared with JobMaker
 *   8. Every throw case (missing job, missing orderId, empty images,
 *      missing controller, image missing negNumber / printCode,
 *      negNumber over 15 chars)
 *   9. Explicit-omission regression locks: Crop=, UnitCrop=, Orient=
 *      must NEVER appear (the whole point of pre-cropped digital)
 *
 * Run via: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { generateFujiPicProOrderFile, _internals } = require('../fuji-pic-pro-generator');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const GOLDEN = path.join(REPO, 'docs', 'Fuji Pic Pro', 'sample-order.txt');

// The .gitattributes stores .txt files with LF and the working tree
// carries CRLF on Windows. `structuralLines` strips both so the golden
// comparison is line-ending-agnostic (a separate test pins CRLF on
// the generator's output directly).
function structuralLines(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSampleJob(overrides = {}) {
  return {
    orderId: 'ORD-O4YK5Z-1',
    id: 'jobid-1',
    jobName: 'ORD-O4YK5Z-1',
    customer: { fullName: 'Jane Smith' },
    images: [
      // File-writer stages these as 0001.<ext> / 0002.<ext> / etc.,
      // so negNumber is the basename. `filename` and `originalFilename`
      // feed the {filename} / {originalFilename} back-print tokens.
      { negNumber: '0001', printCode: '64', quantity: 2, color: 'C',
        filename: '0001.jpg', originalFilename: 'DSC_0042.jpg' },
      { negNumber: '0002', printCode: '64', quantity: 1, color: 'C',
        filename: '0002.jpg', originalFilename: 'DSC_0043.jpg' },
      { negNumber: '0003', printCode: '65', quantity: 1, color: 'B',
        filename: '0003.jpg', originalFilename: 'DSC_0044.jpg' },
    ],
    ...overrides,
  };
}

function makeSampleController(overrides = {}) {
  return {
    backprintMode: 'text',
    backprintTemplate: '{customerName}/{originalFilename}',
    ...overrides,
  };
}

// ── 1. Golden-file structural equivalence ──────────────────────────────────

test('generateFujiPicProOrderFile reproduces docs/Fuji Pic Pro/sample-order.txt structurally', () => {
  const golden = fs.readFileSync(GOLDEN, 'utf8');
  const { filename, contents } = generateFujiPicProOrderFile(
    makeSampleJob(),
    makeSampleController(),
  );
  assert.equal(filename, 'ORD-O4YK5Z-1.txt', 'filename is {orderId}.txt per spec p. 340');

  assert.deepEqual(
    structuralLines(contents),
    structuralLines(golden),
    'structural lines must match the hand-built golden fixture (line-ending-agnostic)',
  );
});

// ── 2. CRLF line endings ───────────────────────────────────────────────────

test('generator output uses CRLF line endings (no bare LF)', () => {
  const { contents } = generateFujiPicProOrderFile(
    makeSampleJob(),
    makeSampleController(),
  );
  assert.match(contents, /\r\n/, 'must contain CRLF');
  const lfPositions = [...contents.matchAll(/\n/g)].map((m) => m.index);
  for (const i of lfPositions) {
    assert.equal(contents[i - 1], '\r', `bare LF at offset ${i}`);
  }
  assert.ok(contents.endsWith('\r\n'), 'trailing CRLF at EOF (matches JobMaker byte pattern)');
});

// ── 3. Section header ordering ─────────────────────────────────────────────

test('emits [Order] once at top, then [Neg]/[Unit] pair per image in input order', () => {
  const { contents } = generateFujiPicProOrderFile(
    makeSampleJob(),
    makeSampleController(),
  );
  const headers = contents.split(/\r\n/).filter((l) => /^\[.+\]$/.test(l));
  assert.deepEqual(headers, [
    '[Order]',
    '[Neg]', '[Unit]',
    '[Neg]', '[Unit]',
    '[Neg]', '[Unit]',
  ], 'section headers must appear in exactly this order — spec is case-sensitive');
});

// ── 4. Qty default ─────────────────────────────────────────────────────────

test('Qty= defaults to 1 when image.quantity is omitted', () => {
  const job = makeSampleJob({
    images: [
      { negNumber: '0001', printCode: '64' }, // no quantity
    ],
  });
  const { contents } = generateFujiPicProOrderFile(job, { backprintMode: 'none' });
  assert.match(contents, /^Qty=1\r?$/m,
    'omitted quantity must default to 1 rather than emit `Qty=` blank (spec p. 352 — mandatory)');
});

test('Qty=0 is preserved (not treated as unset)', () => {
  // Belt-and-braces: the default guard uses `!= null`, so 0 (falsy but
  // not null) must persist as-is — an operator explicitly setting
  // Qty=0 is a valid "cancel this print" signal even if unlikely.
  const job = makeSampleJob({
    images: [{ negNumber: '0001', printCode: '64', quantity: 0 }],
  });
  const { contents } = generateFujiPicProOrderFile(job, { backprintMode: 'none' });
  assert.match(contents, /^Qty=0\r?$/m);
});

// ── 5. Color default ──────────────────────────────────────────────────────

test('Color= defaults to "C" when image.color is omitted', () => {
  const job = makeSampleJob({
    images: [{ negNumber: '0001', printCode: '64' }], // no color
  });
  const { contents } = generateFujiPicProOrderFile(job, { backprintMode: 'none' });
  assert.match(contents, /^Color=C\r?$/m,
    'Color= is mandatory (spec p. 353); default to C rather than emit blank');
});

test('Color= is preserved verbatim when set', () => {
  const job = makeSampleJob({
    images: [
      { negNumber: '0001', printCode: '64', color: 'B' },
      { negNumber: '0002', printCode: '64', color: 'S2' },
    ],
  });
  const { contents } = generateFujiPicProOrderFile(job, { backprintMode: 'none' });
  const colorLines = contents.split(/\r\n/).filter((l) => l.startsWith('Color='));
  assert.deepEqual(colorLines, ['Color=B', 'Color=S2']);
});

// ── 6. CustomerName= toggle ────────────────────────────────────────────────

test('CustomerName= is emitted only when includeCustomerName===true AND name is set', () => {
  const cases = [
    { include: true,  customer: { fullName: 'Jane Smith' }, expect: true,  desc: 'toggle on + name present' },
    { include: false, customer: { fullName: 'Jane Smith' }, expect: false, desc: 'toggle off + name present' },
    { include: true,  customer: {},                          expect: false, desc: 'toggle on + no name' },
    { include: true,  customer: null,                        expect: false, desc: 'toggle on + no customer object' },
    { include: 1,     customer: { fullName: 'Jane Smith' }, expect: false, desc: 'toggle truthy-but-not-true' },
  ];
  for (const { include, customer, expect, desc } of cases) {
    const job = makeSampleJob({ customer });
    const { contents } = generateFujiPicProOrderFile(job, { includeCustomerName: include, backprintMode: 'none' });
    const has = /^CustomerName=/m.test(contents);
    assert.equal(has, expect, `CustomerName expected=${expect} for case: ${desc}`);
  }
});

// ── 7. Backprint1 + Backprint2 ─────────────────────────────────────────────

test('Backprint1 is emitted per image when backprintMode is "text" with a template', () => {
  const { contents } = generateFujiPicProOrderFile(
    makeSampleJob(),
    { backprintMode: 'text', backprintTemplate: '{customerName}/{originalFilename}' },
  );
  const lines = contents.split(/\r\n/).filter((l) => l.startsWith('Backprint1='));
  assert.equal(lines.length, 3, 'one Backprint1 per image');
  assert.equal(lines[0], 'Backprint1=Jane Smith/DSC_0042.jpg');
  assert.equal(lines[1], 'Backprint1=Jane Smith/DSC_0043.jpg');
  assert.equal(lines[2], 'Backprint1=Jane Smith/DSC_0044.jpg');
});

test('Backprint2 is emitted only when backprintTemplate2 is set', () => {
  // Line 1 alone
  {
    const { contents } = generateFujiPicProOrderFile(
      makeSampleJob({ images: [{ negNumber: '0001', printCode: '64', originalFilename: 'A.jpg' }] }),
      { backprintMode: 'text', backprintTemplate: '{originalFilename}' },
    );
    assert.match(contents, /Backprint1=A\.jpg/, 'line 1 present');
    assert.doesNotMatch(contents, /Backprint2=/, 'line 2 must be entirely omitted when template2 is unset');
  }

  // Both lines
  {
    const { contents } = generateFujiPicProOrderFile(
      makeSampleJob({ images: [{ negNumber: '0001', printCode: '64', originalFilename: 'A.jpg' }] }),
      { backprintMode: 'text', backprintTemplate: '{originalFilename}', backprintTemplate2: 'Order #{jobId}' },
    );
    assert.match(contents, /Backprint1=A\.jpg/);
    assert.match(contents, /Backprint2=Order #jobid-1/);
  }
});

test('Backprint text is sanitised and truncated per JobMaker rules (shared helper)', () => {
  // Verifies that `%(;'` → space, `~` → `-`, and 40-char slice all
  // apply — the shared _sanitiseBackprintText from the JobMaker
  // generator is what produces this, so parity is the contract.
  const longName = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN01234567890'; // 51 chars
  const job = makeSampleJob({
    images: [{ negNumber: '0001', printCode: '64', originalFilename: longName + " %'(;~end.jpg" }],
  });
  const { contents } = generateFujiPicProOrderFile(job, {
    backprintMode: 'text',
    backprintTemplate: '{originalFilename}',
  });
  const bp = contents.split(/\r\n/).find((l) => l.startsWith('Backprint1='));
  const val = bp.slice('Backprint1='.length);
  assert.equal(val.length, 40, 'sanitiser truncates to 40 chars');
  assert.doesNotMatch(val, /[%(;']/, "forbidden chars %('; must be replaced");
  assert.doesNotMatch(val, /~/, 'tilde must be replaced with hyphen');
});

test('Backprint lines are omitted entirely when the resolved template is empty', () => {
  // A template that resolves to blank (e.g. {customerName} on a
  // customer with no name) mustn't emit `Backprint1=` — that would
  // print a blank line on the back of the physical print.
  const job = makeSampleJob({
    customer: { fullName: '' },
    images: [{ negNumber: '0001', printCode: '64' }],
  });
  const { contents } = generateFujiPicProOrderFile(job, {
    backprintMode: 'text',
    backprintTemplate: '{customerName}',
  });
  assert.doesNotMatch(contents, /Backprint1=/,
    'empty resolved template must drop the whole line, not emit "Backprint1="');
});

test('Backprint is entirely omitted when backprintMode is "none"', () => {
  const { contents } = generateFujiPicProOrderFile(makeSampleJob(), { backprintMode: 'none' });
  assert.doesNotMatch(contents, /Backprint[12]=/,
    'mode "none" must never emit either back-print line');
});

// ── 8. Explicit-omission regression locks ─────────────────────────────────

test('Crop=, UnitCrop=, and Orient= NEVER appear in the output', () => {
  // The whole point of pre-cropped digital dispatch: those fields
  // would override the baked-in crop/orientation from Manual Crop and
  // corrupt the print. This test locks the omission so a future
  // "we should emit Orient= anyway just in case" change is impossible
  // without the test failing first.
  const { contents } = generateFujiPicProOrderFile(makeSampleJob(), makeSampleController());
  assert.doesNotMatch(contents, /^Crop=/m,      'Crop= (crop-carded negatives only, spec p. 349) must never appear');
  assert.doesNotMatch(contents, /^UnitCrop=/m,  'UnitCrop= (files that still need cropping, spec p. 353) must never appear');
  assert.doesNotMatch(contents, /^Orient=/m,    'Orient= (not required for digital files, spec p. 351) must never appear');
});

test('No composites, no template blocks, no logo/slim-text fields', () => {
  const { contents } = generateFujiPicProOrderFile(makeSampleJob(), makeSampleController());
  for (const excluded of ['[Comp]', '[Node]', 'Retouch=', 'Logo=', 'LogoPos=', 'SlimText', 'Product=']) {
    assert.ok(!contents.includes(excluded),
      `output must never contain "${excluded}" — pre-cropped prints only`);
  }
});

// ── 9. Throw cases ────────────────────────────────────────────────────────

test('throws when job is missing', () => {
  assert.throws(() => generateFujiPicProOrderFile(undefined, makeSampleController()), /`job` is required/);
  assert.throws(() => generateFujiPicProOrderFile(null,      makeSampleController()), /`job` is required/);
  assert.throws(() => generateFujiPicProOrderFile('nope',    makeSampleController()), /`job` is required/);
});

test('throws when job.orderId is missing', () => {
  const job = makeSampleJob();
  delete job.orderId;
  assert.throws(() => generateFujiPicProOrderFile(job, makeSampleController()), /`job\.orderId` is required/);
});

test('throws when job.images is empty or not an array', () => {
  for (const bad of [[], undefined, null, 'nope', {}]) {
    assert.throws(
      () => generateFujiPicProOrderFile(makeSampleJob({ images: bad }), makeSampleController()),
      /must contain at least one image/,
      `images=${JSON.stringify(bad)} must throw`,
    );
  }
});

test('throws when controller is missing', () => {
  assert.throws(() => generateFujiPicProOrderFile(makeSampleJob(), undefined), /`controller` is required/);
  assert.throws(() => generateFujiPicProOrderFile(makeSampleJob(), null),      /`controller` is required/);
  assert.throws(() => generateFujiPicProOrderFile(makeSampleJob(), 'nope'),    /`controller` is required/);
});

test('throws when an image is missing negNumber', () => {
  const job = makeSampleJob({
    images: [
      { negNumber: '0001', printCode: '64' },
      { printCode: '65' }, // no negNumber
    ],
  });
  assert.throws(
    () => generateFujiPicProOrderFile(job, makeSampleController()),
    /images\[1\] is missing a negNumber/,
    'index should be present in the error message so operators can find the row',
  );
});

test('throws when an image is missing printCode', () => {
  const job = makeSampleJob({
    images: [
      { negNumber: '0001', printCode: '64' },
      { negNumber: '0002' }, // no printCode
    ],
  });
  assert.throws(
    () => generateFujiPicProOrderFile(job, makeSampleController()),
    /images\[1\].+is missing a printCode/,
  );
});

test('throws when a negNumber exceeds the 15-character spec cap', () => {
  const job = makeSampleJob({
    images: [{ negNumber: 'a'.repeat(16), printCode: '64' }],
  });
  assert.throws(
    () => generateFujiPicProOrderFile(job, makeSampleController()),
    /exceeds the 15-char PIC Pro cap/,
    'the guard is redundant in practice (M3 stages images as 0001.<ext>) but shields callers who bypass staging',
  );
  assert.equal(_internals.NEG_NUMBER_MAX_LEN, 15, 'cap constant is 15 per spec p. 347');
});

test('accepts a negNumber of exactly 15 characters (edge)', () => {
  const job = makeSampleJob({
    images: [{ negNumber: 'a'.repeat(15), printCode: '64' }],
  });
  assert.doesNotThrow(() => generateFujiPicProOrderFile(job, makeSampleController()));
});
