/**
 * Unit tests for the shared {token} resolver, focused on the new
 * {originalFilename} token (and a guard that the existing tokens still work).
 *
 * template-tokens.js has no electron/electron-store deps, so no shims needed.
 *
 * Run via: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { resolveTemplate, SUPPORTED_TOKENS } = require(
  path.join(REPO, 'src', 'main', 'services', 'template-tokens.js'),
);

test('{originalFilename} resolves from ctx', () => {
  assert.equal(
    resolveTemplate('{originalFilename}', {}, { originalFilename: '576629810005.jpg' }),
    '576629810005.jpg',
  );
});

test('{originalFilename} resolves blank when absent (no throw)', () => {
  assert.equal(resolveTemplate('{originalFilename}', {}, {}), '');
  assert.equal(resolveTemplate('{originalFilename}', {}), '');
});

test('{originalFilename} composes with other tokens', () => {
  const out = resolveTemplate(
    '{jobName} / {filename} / {originalFilename}',
    { job_name: 'PXDEMO-1' },
    { filename: 'a.jpg', originalFilename: 'orig.jpg' },
  );
  assert.equal(out, 'PXDEMO-1 / a.jpg / orig.jpg');
});

test('SUPPORTED_TOKENS advertises {originalFilename}', () => {
  assert.ok(SUPPORTED_TOKENS.includes('{originalFilename}'));
});

test('existing tokens unaffected', () => {
  assert.equal(
    resolveTemplate('{customerName}|{firstName}|{lastName}', { customer_name: 'Richard Charnley' }),
    'Richard Charnley|Richard|Charnley',
  );
});

// ─── TRIPWIRE: 3-arg call shape must stay byte-identical ─────────────────────
//
// resolveTemplate is shared by four emitters (Frontline back-print, Darkroom
// Pro photo lines, Fuji JobMaker back-print, Fuji PIC Pro back-print) plus
// src/pdf-pipeline/steps.js. M1 of docs/folder-copy-filename-templates-brief.md
// widens the signature to a 4-arg form with an `opts` parameter — the tripwire
// exists to lock the eight existing tokens against any drift introduced by
// that change or by future maintenance.
//
// The whole set is expressed as one table so a regression shows exactly which
// input diverges. If you're staring at a failure here, DO NOT relax the
// assertions — either the change is unintended or the release note owes an
// operator an explanation.
//
// Concrete negative-control check performed OUT OF BAND during M1 build:
// temporarily give the new opts.stripPrefix a default of 'PXDEMO-' and this
// suite fails at the {orderNumber} and {jobName} rows for 'PXDEMO-091YEC'.
// That confirms the tripwire notices the exact class of mistake the brief
// warns about — do not codify that broken variant here (it is a build-time
// verification, not a permanent test).

const RICHARD = {
  customer_name: 'Richard Charnley',
  id: 38461218,
  order_number: 'PXDEMO-091YEC',
  job_name: 'PXDEMO-091YEC-1',
};

const CTX_A = {
  filename: '5_576629810005.jpg',
  originalFilename: '576629810005.jpg',
};

const TRIPWIRE_CASES = [
  // ── each existing token in isolation, populated ────────────────────────
  { name: '{customerName} populated',
    tpl: '{customerName}', job: RICHARD, ctx: CTX_A, expect: 'Richard Charnley' },
  { name: '{firstName} populated',
    tpl: '{firstName}',    job: RICHARD, ctx: CTX_A, expect: 'Richard' },
  { name: '{lastName} populated',
    tpl: '{lastName}',     job: RICHARD, ctx: CTX_A, expect: 'Charnley' },
  { name: '{jobId} populated',
    tpl: '{jobId}',        job: RICHARD, ctx: CTX_A, expect: '38461218' },
  { name: '{orderNumber} populated',
    tpl: '{orderNumber}',  job: RICHARD, ctx: CTX_A, expect: 'PXDEMO-091YEC' },
  { name: '{jobName} populated',
    tpl: '{jobName}',      job: RICHARD, ctx: CTX_A, expect: 'PXDEMO-091YEC-1' },
  { name: '{filename} populated',
    tpl: '{filename}',     job: RICHARD, ctx: CTX_A, expect: '5_576629810005.jpg' },
  { name: '{originalFilename} populated',
    tpl: '{originalFilename}', job: RICHARD, ctx: CTX_A, expect: '576629810005.jpg' },

  // ── each token, missing/empty source → empty resolution ────────────────
  { name: '{customerName} missing → empty',
    tpl: '{customerName}', job: {}, ctx: {}, expect: '' },
  { name: '{firstName} missing → empty',
    tpl: '{firstName}',    job: {}, ctx: {}, expect: '' },
  { name: '{lastName} missing → empty',
    tpl: '{lastName}',     job: {}, ctx: {}, expect: '' },
  { name: '{jobId} missing → empty',
    tpl: '{jobId}',        job: {}, ctx: {}, expect: '' },
  { name: '{orderNumber} missing → empty',
    tpl: '{orderNumber}',  job: {}, ctx: {}, expect: '' },
  { name: '{jobName} missing → empty',
    tpl: '{jobName}',      job: {}, ctx: {}, expect: '' },
  { name: '{filename} missing → empty',
    tpl: '{filename}',     job: {}, ctx: {}, expect: '' },
  { name: '{originalFilename} missing → empty',
    tpl: '{originalFilename}', job: {}, ctx: {}, expect: '' },

  // ── {jobName} falls back to {orderNumber} when job_name is absent ──────
  { name: '{jobName} falls back to order_number',
    tpl: '{jobName}',
    job:  { order_number: 'PXDEMO-091YEC' },
    ctx:  {},
    expect: 'PXDEMO-091YEC' },
  { name: '{jobName} empty when neither job_name nor order_number set',
    tpl: '{jobName}', job: {}, ctx: {}, expect: '' },

  // ── name splitting corners ─────────────────────────────────────────────
  { name: 'single-word name → firstName = whole, lastName = empty',
    tpl: '{firstName}|{lastName}',
    job:  { customer_name: 'Cher' },
    ctx:  {},
    expect: 'Cher|' },
  { name: 'multi-space name → firstName = first word, lastName = rest trimmed',
    tpl: '{firstName}|{lastName}',
    job:  { customer_name: 'Mary Jane  Watson' },
    ctx:  {},
    expect: 'Mary|Jane  Watson' },
  { name: 'leading/trailing whitespace on customer_name is trimmed for split',
    tpl: '{firstName}|{lastName}',
    job:  { customer_name: '  Richard Charnley  ' },
    ctx:  {},
    expect: 'Richard|Charnley' },

  // ── jobId numeric vs string ────────────────────────────────────────────
  { name: '{jobId} numeric zero → empty (falsy fallback)',
    tpl: '{jobId}', job: { id: 0 }, ctx: {}, expect: '' },
  { name: '{jobId} string → passed through',
    tpl: '{jobId}', job: { id: '38461218' }, ctx: {}, expect: '38461218' },

  // ── composed templates matching the four live emitters' shapes ─────────
  // NOTE: pre-M1 this suite pinned the Fuji seeded default's buggy behaviour
  // (`{firstName}/{filename}/{date}` emitting a literal `{date}` because
  // resolveTemplate never handled it — see §3.5 of
  // docs/folder-copy-filename-templates-brief.md). M1 fixes that by resolving
  // {date} from opts.now (or the real clock as fallback). Coverage for the
  // fix moves to the "M1 tokens" section below; the shape-composition part
  // still lives here so 3-arg composition stays locked.
  { name: 'Fuji seeded default sans date: {firstName}/{filename} still composes',
    tpl: '{firstName}/{filename}',
    job: RICHARD, ctx: CTX_A,
    expect: 'Richard/5_576629810005.jpg' },
  { name: 'Darkroom-style compose {jobName} / {filename} / {originalFilename}',
    tpl: '{jobName} / {filename} / {originalFilename}',
    job: RICHARD, ctx: CTX_A,
    expect: 'PXDEMO-091YEC-1 / 5_576629810005.jpg / 576629810005.jpg' },

  // ── same token appearing twice must resolve on every occurrence ────────
  { name: 'repeated {jobId} both slots resolve',
    tpl: '{jobId}_{jobId}',
    job: RICHARD, ctx: CTX_A,
    expect: '38461218_38461218' },
  { name: 'repeated {orderNumber} both slots resolve',
    tpl: '{orderNumber}-{orderNumber}',
    job: RICHARD, ctx: CTX_A,
    expect: 'PXDEMO-091YEC-PXDEMO-091YEC' },

  // ── empty / blank template → empty string ──────────────────────────────
  { name: 'empty template → empty',
    tpl: '', job: RICHARD, ctx: CTX_A, expect: '' },
  { name: 'null template → empty',
    tpl: null, job: RICHARD, ctx: CTX_A, expect: '' },
  { name: 'undefined template → empty',
    tpl: undefined, job: RICHARD, ctx: CTX_A, expect: '' },

  // ── unrecognised tokens are left in place (documented behaviour) ───────
  { name: 'unknown {foo} token left untouched',
    tpl: '{foo}',
    job: RICHARD, ctx: CTX_A,
    expect: '{foo}' },
];

for (const c of TRIPWIRE_CASES) {
  test(`TRIPWIRE 3-arg: ${c.name}`, () => {
    const actual = resolveTemplate(c.tpl, c.job, c.ctx);
    assert.equal(actual, c.expect);
  });
}

// ═════════════════════════════════════════════════════════════════════════
// M1 — new tokens, {option:NAME}, {indexPadded}, opts.stripPrefix, opts.now
// ═════════════════════════════════════════════════════════════════════════
//
// Per docs/folder-copy-filename-templates-brief.md §3.6. Every date-dependent
// test MUST inject opts.now — real-clock output is not reproducible and
// hiding a non-determinism inside a test suite is worse than not testing it.

// ── job with all new job-level fields populated ─────────────────────────
const JOB_M1 = {
  customer_name: 'Richard Charnley',
  id: 38461218,
  order_number: 'PXDEMO-091YEC',
  job_name: 'PXDEMO-091YEC-1',
  product: '4x6" Photo Print',
  product_code: '0406-cut-print',
  category: 'Prints',
  process: 'Silver Halide',
  due_date: '2026-08-20T09:00:00Z',
  options: [
    { name: 'finish-options', value: 'lustre' },
    { name: 'layout-options', value: 'full-bleed' },
    { name: 'border-options', value: '' }, // present but empty
  ],
};

const FIXED_NOW = new Date(2026, 7, 17); // 2026-08-17 (local midnight)

// ── SUPPORTED_TOKENS extension ──────────────────────────────────────────
test('M1 SUPPORTED_TOKENS advertises the new tokens', () => {
  for (const t of [
    '{product}', '{productCode}', '{category}', '{process}',
    '{dueDate}', '{date}', '{options}', '{option:NAME}',
    '{quantity}', '{index}', '{indexPadded}',
  ]) {
    assert.ok(SUPPORTED_TOKENS.includes(t), `missing ${t}`);
  }
});

// ── {product} ───────────────────────────────────────────────────────────
test('M1 {product} populated', () => {
  assert.equal(resolveTemplate('{product}', JOB_M1), '4x6" Photo Print');
});
test('M1 {product} missing → empty', () => {
  assert.equal(resolveTemplate('{product}', {}), '');
});
test('M1 {product} empty string → empty', () => {
  assert.equal(resolveTemplate('{product}', { product: '' }), '');
});

// ── {productCode} ───────────────────────────────────────────────────────
test('M1 {productCode} populated', () => {
  assert.equal(resolveTemplate('{productCode}', JOB_M1), '0406-cut-print');
});
test('M1 {productCode} missing → empty', () => {
  assert.equal(resolveTemplate('{productCode}', {}), '');
});
test('M1 {productCode} empty string → empty', () => {
  assert.equal(resolveTemplate('{productCode}', { product_code: '' }), '');
});

// ── {category} ──────────────────────────────────────────────────────────
test('M1 {category} populated', () => {
  assert.equal(resolveTemplate('{category}', JOB_M1), 'Prints');
});
test('M1 {category} missing → empty', () => {
  assert.equal(resolveTemplate('{category}', {}), '');
});

// ── {process} ───────────────────────────────────────────────────────────
test('M1 {process} populated', () => {
  assert.equal(resolveTemplate('{process}', JOB_M1), 'Silver Halide');
});
test('M1 {process} missing → empty', () => {
  assert.equal(resolveTemplate('{process}', {}), '');
});

// ── {quantity} ──────────────────────────────────────────────────────────
test('M1 {quantity} populated from ctx', () => {
  assert.equal(resolveTemplate('{quantity}', {}, { quantity: 3 }), '3');
});
test('M1 {quantity} zero renders as "0" (not blank)', () => {
  // A per-image manifest quantity of 0 is legitimately writeable; the token
  // reflects the number rather than filtering it. Callers that want to hide
  // "0" can filter at the sanitisation layer.
  assert.equal(resolveTemplate('{quantity}', {}, { quantity: 0 }), '0');
});
test('M1 {quantity} missing → empty', () => {
  assert.equal(resolveTemplate('{quantity}', {}, {}), '');
});
test('M1 {quantity} deliberately ignores job.quantity', () => {
  // §3.3: job.quantity is untrustworthy; the resolver never reads it.
  assert.equal(resolveTemplate('{quantity}', { quantity: 99 }, {}), '');
});

// ── {index} ─────────────────────────────────────────────────────────────
test('M1 {index} populated from ctx', () => {
  assert.equal(resolveTemplate('{index}', {}, { index: 3 }), '3');
});
test('M1 {index} missing → empty', () => {
  assert.equal(resolveTemplate('{index}', {}, {}), '');
});

// ── {indexPadded} widths ────────────────────────────────────────────────
test('M1 {indexPadded} width 1 for 9 images (no padding)', () => {
  assert.equal(resolveTemplate('{indexPadded}', {}, { index: 3, imageCount: 9 }),  '3');
});
test('M1 {indexPadded} width 2 for 10 images', () => {
  assert.equal(resolveTemplate('{indexPadded}', {}, { index: 3, imageCount: 10 }), '03');
});
test('M1 {indexPadded} width 2 for 99 images', () => {
  assert.equal(resolveTemplate('{indexPadded}', {}, { index: 3, imageCount: 99 }), '03');
});
test('M1 {indexPadded} width 3 for 100 images', () => {
  assert.equal(resolveTemplate('{indexPadded}', {}, { index: 3, imageCount: 100 }), '003');
});
test('M1 {indexPadded} width 3 for 200 images', () => {
  assert.equal(resolveTemplate('{indexPadded}', {}, { index: 3, imageCount: 200 }), '003');
});
test('M1 {indexPadded} unpadded fallback when imageCount missing', () => {
  assert.equal(resolveTemplate('{indexPadded}', {}, { index: 3 }), '3');
});
test('M1 {indexPadded} missing index → empty', () => {
  assert.equal(resolveTemplate('{indexPadded}', {}, { imageCount: 20 }), '');
});
test('M1 {indexPadded} does not confuse {index}', () => {
  // Sanity: both tokens in one template resolve independently.
  assert.equal(
    resolveTemplate('{index}_{indexPadded}', {}, { index: 4, imageCount: 100 }),
    '4_004',
  );
});

// ── {option:NAME} ───────────────────────────────────────────────────────
test('M1 {option:NAME} found → value', () => {
  assert.equal(resolveTemplate('{option:finish-options}', JOB_M1), 'lustre');
});
test('M1 {option:NAME} not found → empty', () => {
  assert.equal(resolveTemplate('{option:nonexistent}', JOB_M1), '');
});
test('M1 {option:NAME} case-insensitive on the name', () => {
  assert.equal(resolveTemplate('{option:Finish-Options}', JOB_M1), 'lustre');
  assert.equal(resolveTemplate('{option:FINISH-OPTIONS}', JOB_M1), 'lustre');
});
test('M1 {option:NAME} whitespace inside NAME is trimmed', () => {
  assert.equal(resolveTemplate('{option: finish-options }', JOB_M1), 'lustre');
});
test('M1 {option:NAME} option present with empty value → blank', () => {
  assert.equal(resolveTemplate('{option:border-options}', JOB_M1), '');
});
test('M1 {option:} malformed → blank AND token consumed (never literal)', () => {
  // §3.4: a leftover literal `{option:}` in a filename is the kind of thing
  // nobody notices until a lab complains. Regex is `[^}]*` so this matches
  // and resolves blank, rather than surviving as a substring.
  assert.equal(resolveTemplate('a{option:}b', JOB_M1), 'ab');
});
test('M1 {option:NAME} two different lookups in one template', () => {
  assert.equal(
    resolveTemplate('{option:finish-options}/{option:layout-options}', JOB_M1),
    'lustre/full-bleed',
  );
});
test('M1 {option:NAME} same lookup twice both resolve', () => {
  assert.equal(
    resolveTemplate('{option:finish-options}-{option:finish-options}', JOB_M1),
    'lustre-lustre',
  );
});
test('M1 {option:NAME} job.options missing → blank', () => {
  assert.equal(resolveTemplate('{option:finish-options}', {}), '');
});
test('M1 {option:NAME} job.options not an array → blank', () => {
  assert.equal(resolveTemplate('{option:finish-options}', { options: 'oops' }), '');
});

// ── {options} — all values joined ───────────────────────────────────────
test('M1 {options} joins non-empty values with _ in array order', () => {
  assert.equal(resolveTemplate('{options}', JOB_M1), 'lustre_full-bleed');
});
test('M1 {options} skips empty values', () => {
  assert.equal(
    resolveTemplate('{options}', {
      options: [
        { name: 'a', value: 'one' },
        { name: 'b', value: '' },
        { name: 'c', value: 'three' },
      ],
    }),
    'one_three',
  );
});
test('M1 {options} missing → empty', () => {
  assert.equal(resolveTemplate('{options}', {}), '');
});
test('M1 {options} empty array → empty', () => {
  assert.equal(resolveTemplate('{options}', { options: [] }), '');
});

// ── {dueDate} ───────────────────────────────────────────────────────────
// Verified real shape at job-service.js:404 — OrderHub sends UTC ISO
// datetime like '2026-05-22T13:21:15Z'. The fixture uses T09:00:00Z, which
// converts to a local Y/M/D of 2026-08-20 in every real-world timezone
// (worst case is UTC+15, which puts it at 00:00 on 2026-08-21 — outside
// the range of any inhabited timezone). Deterministic across CI machines
// and Richard's Windows box.
test('M1 {dueDate} formats as local YMD from UTC ISO datetime', () => {
  assert.equal(resolveTemplate('{dueDate}', JOB_M1), '2026-08-20');
});
test('M1 {dueDate} missing → empty', () => {
  assert.equal(resolveTemplate('{dueDate}', {}), '');
});
test('M1 {dueDate} null → empty', () => {
  assert.equal(resolveTemplate('{dueDate}', { due_date: null }), '');
});
test('M1 {dueDate} unparseable → empty (never emits NaN-NaN-NaN)', () => {
  assert.equal(resolveTemplate('{dueDate}', { due_date: 'not-a-date' }), '');
});

// ── {date} with injected opts.now ───────────────────────────────────────
test('M1 {date} resolves from opts.now (local YYYY-MM-DD)', () => {
  assert.equal(
    resolveTemplate('{date}', JOB_M1, {}, { now: FIXED_NOW }),
    '2026-08-17',
  );
});
test('M1 {date} pads month and day', () => {
  assert.equal(
    resolveTemplate('{date}', JOB_M1, {}, { now: new Date(2026, 0, 5) }),
    '2026-01-05',
  );
});
test('M1 {date} composes with other tokens under opts.now', () => {
  assert.equal(
    resolveTemplate('{firstName}/{filename}/{date}', JOB_M1,
      { filename: 'a.jpg' }, { now: FIXED_NOW }),
    'Richard/a.jpg/2026-08-17',
  );
});
test('M1 {date} 3-arg call (no opts) falls back to real clock', () => {
  // Real-clock fallback — assert the SHAPE, not a specific date. Locks the
  // fact that 3-arg callers still get *some* date, so the seeded Fuji
  // default `{firstName}/{filename}/{date}` stops emitting a literal `{date}`.
  const out = resolveTemplate('{date}', JOB_M1);
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/, `expected YYYY-MM-DD, got "${out}"`);
});

// ── opts.stripPrefix ────────────────────────────────────────────────────
test('M1 stripPrefix applies to {orderNumber}', () => {
  assert.equal(
    resolveTemplate('{orderNumber}', JOB_M1, {}, { stripPrefix: 'PXDEMO-' }),
    '091YEC',
  );
});
test('M1 stripPrefix applies to {jobName}', () => {
  assert.equal(
    resolveTemplate('{jobName}', JOB_M1, {}, { stripPrefix: 'PXDEMO-' }),
    '091YEC-1',
  );
});
test('M1 stripPrefix applies to {jobName} fallback (order_number)', () => {
  assert.equal(
    resolveTemplate('{jobName}',
      { order_number: 'PXDEMO-091YEC' }, {}, { stripPrefix: 'PXDEMO-' }),
    '091YEC',
  );
});
test('M1 stripPrefix does NOT apply to {jobId}, {customerName}, {product}', () => {
  // stripPrefix is scoped to order-derived tokens. Verifying it doesn't
  // leak into other tokens whose values happen to share the prefix text.
  const job = {
    id: 12345,
    order_number: 'PXDEMO-1',
    job_name: 'PXDEMO-1',
    customer_name: 'PXDEMO-Richard',
    product: 'PXDEMO-Prints',
  };
  assert.equal(
    resolveTemplate('{jobId}|{customerName}|{product}', job, {}, { stripPrefix: 'PXDEMO-' }),
    '12345|PXDEMO-Richard|PXDEMO-Prints',
  );
});
test('M1 stripPrefix blank is a no-op', () => {
  assert.equal(
    resolveTemplate('{orderNumber}', JOB_M1, {}, { stripPrefix: '' }),
    'PXDEMO-091YEC',
  );
});
test('M1 stripPrefix absent is a no-op (opts unset)', () => {
  assert.equal(
    resolveTemplate('{orderNumber}', JOB_M1, {}, {}),
    'PXDEMO-091YEC',
  );
});
test('M1 stripPrefix never strips to empty', () => {
  // Delegates to printUtils.stripOrderNumberPrefix, which returns the original
  // when the prefix matches the whole value. Locking the delegation here
  // rather than duplicating the rule.
  assert.equal(
    resolveTemplate('{orderNumber}',
      { order_number: 'PXDEMO-' }, {}, { stripPrefix: 'PXDEMO-' }),
    'PXDEMO-',
  );
});
test('M1 stripPrefix is case-insensitive on the match', () => {
  assert.equal(
    resolveTemplate('{orderNumber}',
      { order_number: 'pxdemo-Abc9' }, {}, { stripPrefix: 'PXDEMO-' }),
    'Abc9',
  );
  assert.equal(
    resolveTemplate('{orderNumber}',
      { order_number: 'PXDEMO-Abc9' }, {}, { stripPrefix: 'pxdemo-' }),
    'Abc9',
  );
});
test('M1 stripPrefix non-leading match untouched', () => {
  assert.equal(
    resolveTemplate('{orderNumber}',
      { order_number: 'X-PXDEMO-1' }, {}, { stripPrefix: 'PXDEMO-' }),
    'X-PXDEMO-1',
  );
});
test('M1 stripPrefix ignored for non-string values (defensive)', () => {
  // opts.stripPrefix must be a string; anything else falls back to no-op.
  // Belt-and-braces against a caller passing e.g. undefined via config load.
  assert.equal(
    resolveTemplate('{orderNumber}', JOB_M1, {}, { stripPrefix: undefined }),
    'PXDEMO-091YEC',
  );
  assert.equal(
    resolveTemplate('{orderNumber}', JOB_M1, {}, { stripPrefix: null }),
    'PXDEMO-091YEC',
  );
});

// ═════════════════════════════════════════════════════════════════════════
// M1a — single-pass resolution + opts.now typecheck
// ═════════════════════════════════════════════════════════════════════════
//
// Before M1a the 16 chained .replace() calls ran on each other's output,
// so an earlier-substituted value became a re-scannable input for every
// later token. Failure modes:
//   - a customer named literally "{date}" got substituted with today's date
//   - an option value literally "{options}" got substituted with the join
//   - an originalFilename literally "{product}.jpg" got substituted with
//     the product name
// The single-pass regex fixes the class. These tests lock the fix so a
// future maintainer who "simplifies" back to chained replaces sees loud
// failures rather than a silent regression.

test('M1a single-pass: customer_name "{date}" survives verbatim (not substituted)', () => {
  const out = resolveTemplate(
    '{customerName}',
    { customer_name: '{date}' },
    {},
    { now: FIXED_NOW },
  );
  assert.equal(out, '{date}');
});

test('M1a single-pass: originalFilename "{product}.jpg" survives verbatim', () => {
  const out = resolveTemplate(
    '{originalFilename}',
    { product: '4x6 Photo Print' },
    { originalFilename: '{product}.jpg' },
  );
  assert.equal(out, '{product}.jpg');
});

test('M1a single-pass: option value "{options}" survives verbatim', () => {
  // The op value literally contains another token's shape; that value must
  // be inserted into the output without re-scanning, otherwise `{options}`
  // (which joins all option values) would substitute recursively.
  const out = resolveTemplate(
    '{option:paper}',
    { options: [{ name: 'paper', value: '{options}' }] },
  );
  assert.equal(out, '{options}');
});

test('M1a single-pass: {options} value containing another value survives', () => {
  // Sibling case: {options} joins raw values without re-scanning them.
  const out = resolveTemplate(
    '{options}',
    { options: [
      { name: 'a', value: '{product}' },
      { name: 'b', value: 'plain' },
    ], product: 'THE_PRODUCT' },
  );
  assert.equal(out, '{product}_plain');
});

test('M1a single-pass: {firstName} = "{jobId}" survives verbatim', () => {
  // Belt-and-braces on the derived-token path (firstName/lastName come from
  // customer_name split, so they take a different code path than the raw
  // job-field tokens).
  const out = resolveTemplate(
    '{firstName}|{lastName}',
    { customer_name: '{jobId} {orderNumber}', id: 42, order_number: 'ABC' },
  );
  assert.equal(out, '{jobId}|{orderNumber}');
});

test('M1a single-pass: two adjacent tokens both resolve independently', () => {
  // Regression guard: replace-all under a single regex handles adjacent
  // matches without state carry-over.
  assert.equal(
    resolveTemplate('{jobId}{orderNumber}', { id: 1, order_number: 'A' }),
    '1A',
  );
});

// ── opts.now typecheck ──────────────────────────────────────────────────
test('M1a opts.now: number timestamp throws (must be a Date)', () => {
  assert.throws(
    () => resolveTemplate('{date}', {}, {}, { now: 1_700_000_000_000 }),
    /opts\.now must be a valid Date.*number/,
  );
});

test('M1a opts.now: ISO string throws (must be a Date)', () => {
  assert.throws(
    () => resolveTemplate('{date}', {}, {}, { now: '2026-08-17' }),
    /opts\.now must be a valid Date.*string/,
  );
});

test('M1a opts.now: Invalid Date throws (getTime is NaN)', () => {
  const bogus = new Date('nope');
  assert.equal(Number.isNaN(bogus.getTime()), true, 'setup: bogus IS invalid');
  assert.throws(
    () => resolveTemplate('{date}', {}, {}, { now: bogus }),
    /opts\.now must be a valid Date/,
  );
});

test('M1a opts.now: null uses real clock (does not throw)', () => {
  const out = resolveTemplate('{date}', {}, {}, { now: null });
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
});

test('M1a opts.now: undefined uses real clock (does not throw)', () => {
  const out = resolveTemplate('{date}', {}, {}, { now: undefined });
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
});

test('M1a opts.now: valid Date resolves exactly (regression on the happy path)', () => {
  assert.equal(
    resolveTemplate('{date}', {}, {}, { now: new Date(2026, 0, 1) }),
    '2026-01-01',
  );
});
