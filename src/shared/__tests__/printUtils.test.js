/**
 * Unit tests for src/shared/printUtils.js
 *
 * Covers buildFolderName and extractSurname, focused on the
 * customer-surname insertion option (added 2026-05-18 for Epson/Noritsu
 * folder naming).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFolderName,
  parseFolderName,
  extractSurname,
  stripOrderNumberPrefix,
  applyOrderNumberPrefixRules,
  readOrderNumberPrefixRules,
} = require('../printUtils.js');

const baseJob = {
  id: 38461218,
  order_number: 'PXDEMO-DR2PE0',
  job_name: 'PXDEMO-DR2PE0-1',
  product: '4x6" Photo Print',
  options: [
    { name: 'finish-options', value: 'lustre' },
    { name: 'bleed',          value: 'full-bleed' },
  ],
};

// ── extractSurname ──────────────────────────────────────────────────────────

test('extractSurname returns the last whitespace-separated token', () => {
  assert.equal(extractSurname('Richard Charnley'), 'Charnley');
  assert.equal(extractSurname('Mary Anne Smith'),  'Smith');
});

test('extractSurname falls back to the full name when only one token is present', () => {
  assert.equal(extractSurname('Cher'),    'Cher');
  assert.equal(extractSurname('Madonna'), 'Madonna');
});

test('extractSurname strips NTFS-unsafe characters', () => {
  assert.equal(extractSurname('Richard "Tricky" O\\Brien'), 'OBrien');
  assert.equal(extractSurname('Smith/Jones'),               'SmithJones');
});

test('extractSurname returns empty string for empty / nullish input', () => {
  assert.equal(extractSurname(''),         '');
  assert.equal(extractSurname(null),       '');
  assert.equal(extractSurname(undefined),  '');
  assert.equal(extractSurname('   '),      '');
});

// ── buildFolderName: legacy behaviour (no opts) ─────────────────────────────

test('buildFolderName without opts produces the jobId-prefixed folder name', () => {
  const name = buildFolderName('o', baseJob);
  assert.equal(name, 'o38461218_PXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName without opts handles a reprint suffix', () => {
  const name = buildFolderName('o', baseJob, 'r1');
  assert.equal(name, 'o38461218_PXDEMO-DR2PE0-1_r1_4x6 Photo Print_lustre_full-bleed');
});

// ── buildFolderName: jobId prefix ───────────────────────────────────────────

test('buildFolderName places job.id immediately after the prefix, followed by underscore', () => {
  const name = buildFolderName('o', baseJob);
  assert.match(name, /^o38461218_/);
});

test('buildFolderName uses the same jobId for the p (interim) and o (final) prefixes', () => {
  const pName = buildFolderName('p', baseJob);
  const oName = buildFolderName('o', baseJob);
  // p→o rename relies on the only difference being the leading prefix char
  assert.equal('p' + oName.slice(1), pName);
});

test('buildFolderName falls back to order_number when job.id is missing', () => {
  const jobWithoutId = { ...baseJob, id: undefined };
  const name = buildFolderName('o', jobWithoutId);
  assert.equal(name, 'oPXDEMO-DR2PE0_PXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName falls back to order_number when job.id is empty string', () => {
  const jobWithEmptyId = { ...baseJob, id: '' };
  const name = buildFolderName('o', jobWithEmptyId);
  assert.match(name, /^oPXDEMO-DR2PE0_/);
});

// ── buildFolderName: customer-surname option ────────────────────────────────

test('buildFolderName inserts surname between jobNo and product when enabled', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: true,
    customerName:        'Richard Charnley',
  });
  assert.equal(name, 'o38461218_PXDEMO-DR2PE0-1_Charnley_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName falls back to full name when only one token is present', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: true,
    customerName:        'Cher',
  });
  assert.equal(name, 'o38461218_PXDEMO-DR2PE0-1_Cher_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName inserts surname before the reprint suffix', () => {
  const name = buildFolderName('o', baseJob, 'r1', {
    includeCustomerName: true,
    customerName:        'Richard Charnley',
  });
  assert.equal(name, 'o38461218_PXDEMO-DR2PE0-1_Charnley_r1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName omits the surname segment when the flag is off', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: false,
    customerName:        'Richard Charnley',
  });
  assert.equal(name, 'o38461218_PXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName omits the surname segment when the name is empty', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: true,
    customerName:        '',
  });
  assert.equal(name, 'o38461218_PXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName strips NTFS-unsafe characters from the surname', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: true,
    customerName:        'Mary Anne "Mae" O\\Donnell',
  });
  assert.equal(name, 'o38461218_PXDEMO-DR2PE0-1_ODonnell_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName preserves the p-prefix for the in-progress folder', () => {
  const name = buildFolderName('p', baseJob, null, {
    includeCustomerName: true,
    customerName:        'Richard Charnley',
  });
  assert.equal(name, 'p38461218_PXDEMO-DR2PE0-1_Charnley_4x6 Photo Print_lustre_full-bleed');
});

// ── stripOrderNumberPrefix — Fuji PIC Pro per-controller prefix strip ─────
//
// The per-controller "Strip Order Number Prefix" text field on a Fuji
// PIC Pro controller. Applied when building the submission id that
// becomes the {imageStagingRoot}/{id}, {orderDataPath}/{id}.txt, and
// {diginPath}/{id} filesystem names. Purely a display transform — the
// M3 sequence counter still keys on the ORIGINAL order number so two
// prefixed orders can't collide when they strip to the same base.

test('stripOrderNumberPrefix: blank prefix → order number unchanged (default behaviour)', () => {
  assert.equal(stripOrderNumberPrefix('PXDEMO-1234', ''),         'PXDEMO-1234');
  assert.equal(stripOrderNumberPrefix('PXDEMO-1234', null),       'PXDEMO-1234');
  assert.equal(stripOrderNumberPrefix('PXDEMO-1234', undefined),  'PXDEMO-1234');
});

test('stripOrderNumberPrefix: matching leading prefix is stripped', () => {
  assert.equal(stripOrderNumberPrefix('PXDEMO-1234',      'PXDEMO-'),      '1234');
  assert.equal(stripOrderNumberPrefix('DIVPRINTS-A9F2',   'DIVPRINTS-'),   'A9F2');
  assert.equal(stripOrderNumberPrefix('PXDEMO-XYZ-2',     'PXDEMO-'),      'XYZ-2',
    'suffix-shaped tail (looks like a resubmission suffix, but it is not) survives — this is on the raw order number, not the built id');
});

test('stripOrderNumberPrefix: non-matching prefix leaves the order number unchanged', () => {
  assert.equal(stripOrderNumberPrefix('DIVPRINTS-A9F2', 'PXDEMO-'), 'DIVPRINTS-A9F2',
    'prefix does not match this order number, so pass through');
  assert.equal(stripOrderNumberPrefix('X-PXDEMO-1', 'PXDEMO-'), 'X-PXDEMO-1',
    'the prefix appears inside the order number but not at the start — leading match only');
});

test('stripOrderNumberPrefix: prefix equal to the whole order number → NOT stripped (never empty)', () => {
  // A submission id must have SOMETHING to name the staging + Order
  // Data + DIGIN folder with. Falling through to '' would break the
  // whole PIC Pro handshake.
  assert.equal(stripOrderNumberPrefix('PXDEMO-', 'PXDEMO-'), 'PXDEMO-',
    'refuse to strip down to the empty string — return the input verbatim');
  assert.equal(stripOrderNumberPrefix('AAA',    'AAA'),      'AAA');
});

test('stripOrderNumberPrefix: case-insensitive match; result preserves the ORIGINAL order-number casing', () => {
  assert.equal(stripOrderNumberPrefix('pxdemo-1234', 'PXDEMO-'), '1234',
    'lowercase order number, uppercase prefix — match still fires');
  assert.equal(stripOrderNumberPrefix('PXDEMO-Abc9', 'pxdemo-'), 'Abc9',
    'uppercase order number, lowercase prefix — match fires, tail preserves its original case');
  assert.equal(stripOrderNumberPrefix('PxDeMo-42', 'pXdEmO-'),   '42',
    'mixed case both sides');
});

test('stripOrderNumberPrefix: prefix longer than the order number → unchanged (defensive)', () => {
  assert.equal(stripOrderNumberPrefix('ABC', 'PXDEMO-'), 'ABC');
  assert.equal(stripOrderNumberPrefix('', 'PXDEMO-'),    '');
});

// ── Batch discriminator (M1 of docs/epson-batch-splitting-brief.md) ─────
//
// The single non-negotiable: an unsplit non-reprint job's folder name
// must be BYTE-IDENTICAL to the pre-M1 output. The lab reads these
// names by eye — any drift on the common case is a regression they'll
// notice immediately.

test('buildFolderName: no batch, no reprint → byte-identical to pre-M1 output (regression lock)', () => {
  // Pins the golden string for the common case. If this assertion
  // changes in a future edit, it must be a deliberate call — read the
  // brief's "unsplit folder name must not change" constraint first.
  const golden = 'o38461218_PXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed';
  assert.equal(buildFolderName('o', baseJob), golden);
});

test('buildFolderName: no batch, no reprint, with surname → byte-identical pre-M1 output', () => {
  const golden = 'o38461218_PXDEMO-DR2PE0-1_Charnley_4x6 Photo Print_lustre_full-bleed';
  assert.equal(
    buildFolderName('o', baseJob, null, {
      includeCustomerName: true,
      customerName:        'Richard Charnley',
    }),
    golden,
  );
});

test('buildFolderName: reprint → byte-identical pre-M1 output', () => {
  assert.equal(
    buildFolderName('o', baseJob, 'r1'),
    'o38461218_PXDEMO-DR2PE0-1_r1_4x6 Photo Print_lustre_full-bleed',
  );
});

test('buildFolderName: batch marker sits in the same slot reprintSuffix sits in', () => {
  // The brief's "same slot" rule. Marker format is `_{index}of{total}`
  // — human-readable (a lab operator scanning the folder listing
  // reads "2 of 5" without knowing OHD internals) and NTFS-safe
  // (no reserved chars).
  assert.equal(
    buildFolderName('o', baseJob, null, { batch: { index: 2, total: 5 } }),
    'o38461218_PXDEMO-DR2PE0-1_2of5_4x6 Photo Print_lustre_full-bleed',
  );
});

test('buildFolderName: batch renders for every prefix + surname combination', () => {
  // Belt-and-braces: batch works with p/o/e/q and with the surname
  // option (`includeCustomerName`).
  const opts = { batch: { index: 3, total: 4 } };
  assert.equal(
    buildFolderName('p', baseJob, null, opts),
    'p38461218_PXDEMO-DR2PE0-1_3of4_4x6 Photo Print_lustre_full-bleed',
  );
  assert.equal(
    buildFolderName('e', baseJob, null, { ...opts, includeCustomerName: true, customerName: 'Alice Bee' }),
    'e38461218_PXDEMO-DR2PE0-1_Bee_3of4_4x6 Photo Print_lustre_full-bleed',
  );
});

test('buildFolderName: single-batch job (1of1) DOES render the marker — this path is only taken when split is requested', () => {
  // `1of1` at first glance looks like the "unsplit" case, but it's
  // NOT — the caller only supplies opts.batch when the splitter has
  // decided to split. A single-batch split is legitimate (e.g. the
  // splitter's fallthrough for a job that fits under-cap because a
  // discarded image dropped the count between resolve and dispatch)
  // and the marker is correct to render there so the ledger's
  // per-batch folder attribution still works. The "unsplit path
  // never calls with a batch" invariant is enforced at the M3
  // dispatcher, not here.
  assert.equal(
    buildFolderName('o', baseJob, null, { batch: { index: 1, total: 1 } }),
    'o38461218_PXDEMO-DR2PE0-1_1of1_4x6 Photo Print_lustre_full-bleed',
  );
});

test('buildFolderName: reprint + batch together → throws (mutually exclusive by design)', () => {
  assert.throws(
    () => buildFolderName('o', baseJob, 'r1', { batch: { index: 2, total: 5 } }),
    /mutually exclusive/,
    'the "same slot" rule is enforced; reprint-of-split-job needs an explicit design decision, not silent behaviour',
  );
});

test('buildFolderName: invalid batch shapes → throws with useful message', () => {
  for (const bad of [
    { index: 0, total: 3 },        // index < 1
    { index: 4, total: 3 },        // index > total
    { index: 2, total: 0 },        // total < 1
    { index: 2 },                  // total missing
    { total: 3 },                  // index missing
    { index: 1.5, total: 3 },      // non-integer
    { index: '1', total: '3' },    // strings, not numbers
    {},                            // empty
  ]) {
    assert.throws(
      () => buildFolderName('o', baseJob, null, { batch: bad }),
      /opts\.batch must be/,
      `bad batch ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

// ── parseFolderName — inverse for the folder monitor ─────────────────────

test('parseFolderName: round-trips buildFolderName for unsplit / batch / reprint / surname', () => {
  // The M1 monitor invariant: parseFolderName is the inverse of
  // buildFolderName for every combination the writer can produce.
  // If this test fails, the monitor cannot correctly attribute
  // status events — the entire batch-splitting design breaks at
  // the attribution layer.
  const cases = [
    { desc: 'unsplit',            args: [null, {}],                                                                       expect: { batch: null, reprintSuffix: null } },
    { desc: 'reprint',            args: ['r1', {}],                                                                       expect: { batch: null, reprintSuffix: 'r1' } },
    { desc: 'reprint r10',        args: ['r10', {}],                                                                      expect: { batch: null, reprintSuffix: 'r10' } },
    { desc: 'batch 2/5',          args: [null, { batch: { index: 2, total: 5 } }],                                        expect: { batch: { index: 2, total: 5 }, reprintSuffix: null } },
    { desc: 'batch 1/1',          args: [null, { batch: { index: 1, total: 1 } }],                                        expect: { batch: { index: 1, total: 1 }, reprintSuffix: null } },
    { desc: 'batch 10/20',        args: [null, { batch: { index: 10, total: 20 } }],                                      expect: { batch: { index: 10, total: 20 }, reprintSuffix: null } },
    { desc: 'unsplit + surname',  args: [null, { includeCustomerName: true, customerName: 'Charnley' }],                  expect: { batch: null, reprintSuffix: null } },
    { desc: 'batch + surname',    args: [null, { batch: { index: 2, total: 5 }, includeCustomerName: true, customerName: 'Charnley' }], expect: { batch: { index: 2, total: 5 }, reprintSuffix: null } },
    { desc: 'reprint + surname',  args: ['r2', { includeCustomerName: true, customerName: 'Charnley' }],                  expect: { batch: null, reprintSuffix: 'r2' } },
  ];
  for (const c of cases) {
    for (const prefix of ['p', 'o', 'q', 'e']) {
      const built  = buildFolderName(prefix, baseJob, c.args[0], c.args[1]);
      const parsed = parseFolderName(built);
      assert.ok(parsed, `${c.desc} (prefix ${prefix}): parseFolderName returned null for "${built}"`);
      assert.equal(parsed.prefix, prefix, `${c.desc} (prefix ${prefix}): prefix`);
      assert.equal(parsed.jobId,  '38461218', `${c.desc} (prefix ${prefix}): jobId`);
      assert.deepEqual(parsed.batch,         c.expect.batch,         `${c.desc} (prefix ${prefix}): batch`);
      assert.equal(parsed.reprintSuffix, c.expect.reprintSuffix, `${c.desc} (prefix ${prefix}): reprintSuffix`);
    }
  }
});

test('parseFolderName: returns null for foreign folder names', () => {
  // Folders that don't match the DPOF shape at all. The monitor
  // should ignore these silently — a null return is the "not one of
  // ours" signal.
  const foreign = [
    '',
    'random-folder',
    'processed',        // Darkroom Pro's processed subfolder
    'p38461218',        // no `_` separator, malformed
    'x38461218_PXDEMO-1_thing',   // unknown prefix
    'o_PXDEMO-1_thing', // no jobId digits
  ];
  for (const name of foreign) {
    assert.equal(parseFolderName(name), null, `foreign name "${name}" must return null`);
  }
});

test('parseFolderName: nullish input tolerated (defensive)', () => {
  assert.equal(parseFolderName(null),      null);
  assert.equal(parseFolderName(undefined), null);
  assert.equal(parseFolderName(42),        null);
});

test('parseFolderName: batch-shaped substring in product does NOT false-match (space boundary)', () => {
  // Safety net for the "product name contains a substring that looks
  // like a batch marker" edge. The batch regex requires
  // `_(\d+)of(\d+)(?=_|$)` — the marker must be preceded by `_` AND
  // followed by either `_` or end-of-string. Product names contain
  // spaces (e.g. `4x6" Photo Print`, `2of4 sampler pack`), so a
  // batch-shaped substring inside a product name is followed by a
  // SPACE, not a `_`. The (?=_|$) boundary catches this. Test:
  const trapJob = {
    id:           99999999,
    order_number: 'PX-1',
    job_name:     'PX-1-1',
    product:      '2of4 sampler pack',   // starts batch-shaped, followed by space
    options:      [],
  };
  const built  = buildFolderName('o', trapJob);
  const parsed = parseFolderName(built);
  assert.equal(parsed.batch, null,
    'space after `2of4` prevents the batch regex from matching — the marker requires _ on the trailing side too');
});

test('parseFolderName: batch marker at the end of the folder name still matches (options empty)', () => {
  // The other boundary case: batch marker with NO product following
  // (empty options AND empty product). The `(?=_|$)` allows
  // end-of-string on the trailing side so this still parses. Not a
  // real-world case for DPOF jobs (product is always populated), but
  // the regex should handle it consistently.
  const minimalJob = { id: 1, job_name: 'J', product: '', options: [] };
  const built  = buildFolderName('o', minimalJob, null, { batch: { index: 1, total: 2 } });
  assert.equal(built, 'o1_J_1of2');
  assert.deepEqual(parseFolderName(built).batch, { index: 1, total: 2 });
});

test('stripOrderNumberPrefix: non-string order number returned verbatim (defensive)', () => {
  // Shape errors from the caller are not our problem to translate;
  // the intent of the guard is only "do not throw, do not crash".
  assert.equal(stripOrderNumberPrefix(null,      'X-'), null);
  assert.equal(stripOrderNumberPrefix(undefined, 'X-'), undefined);
  assert.equal(stripOrderNumberPrefix(1234,      'X-'), 1234);
});

// ═════════════════════════════════════════════════════════════════════════
// applyOrderNumberPrefixRules — the M7b multi-rule REPLACEMENT helper
// ═════════════════════════════════════════════════════════════════════════
//
// One OHD install talks to one OrderHub org, but the org can ship orders
// with several prefixes distinguishing the source website (Richard's
// config: ORD-, PXDEMO-, POS-). Each rule is a {from, to} pair —
// blank `to` = pure strip (byte-identical to M7 behaviour).
//
// Rules enforced here:
//   - Longest-match-first BY from, sorted INSIDE the helper. The
//     load-bearing rule; move it to the caller and a lab finds the bug
//     one accident away.
//   - After a match, drop ONE leading '-' or '_' if present. Both
//     'PXDEMO-' and 'PXDEMO' work the same way.
//   - Replacement substitutes for EXACTLY what was matched, INCLUDING
//     any M7a-consumed separator. {from:'PXDEMO', to:'PX'} on
//     'PXDEMO-091YEC' → 'PX091YEC', not 'PX-091YEC'.
//   - Never-produce-empty per rule. If a rule would empty the string,
//     skip and try the next; if every rule would, return original.

test('rules: empty rule list → order number unchanged', () => {
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC', []), 'PXDEMO-091YEC');
});

test('rules: non-array rule list → order number unchanged (defensive)', () => {
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC', 'PXDEMO-'), 'PXDEMO-091YEC');
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC', null),       'PXDEMO-091YEC');
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC', undefined),  'PXDEMO-091YEC');
});

test('rules: pure-strip pair (to: "") is byte-identical to M7 behaviour', () => {
  // Migration invariant: every string in the old M7 shape becomes
  // {from: s, to: ''} in the new shape, and produces the same result.
  const before = stripOrderNumberPrefix('PXDEMO-091YEC', 'PXDEMO-');
  const after  = applyOrderNumberPrefixRules('PXDEMO-091YEC', [{ from: 'PXDEMO-', to: '' }]);
  assert.equal(after, before);
  assert.equal(after, '091YEC');
});

test('rules: replacement with `to` non-blank — the M7b feature', () => {
  // The exact case from the customer request. `to` is 'PX-' so the
  // hyphen appears in the result.
  assert.equal(
    applyOrderNumberPrefixRules('PXDEMO-091YEC', [{ from: 'PXDEMO-', to: 'PX-' }]),
    'PX-091YEC',
  );
});

test('rules: replacement substitutes for EXACTLY what was matched, INCLUDING the M7a-consumed separator', () => {
  // The one thing an operator will get wrong — the field help text
  // must call this out. {from:'PXDEMO', to:'PX'} matches 'PXDEMO' + '-'
  // (M7a consumes the separator), and the replacement is just 'PX'
  // — no hyphen. An operator who wants the hyphen bakes it into both
  // sides: {from:'PXDEMO-', to:'PX-'}.
  assert.equal(
    applyOrderNumberPrefixRules('PXDEMO-091YEC', [{ from: 'PXDEMO', to: 'PX' }]),
    'PX091YEC',
    "no separator in `to` — matches 'PXDEMO' + '-', replaces with 'PX' only",
  );
  assert.equal(
    applyOrderNumberPrefixRules('PXDEMO_091YEC', [{ from: 'PXDEMO', to: 'PX' }]),
    'PX091YEC',
    'underscore separator consumed the same way',
  );
});

test('rules: separator drop applies to underscore too (from-side)', () => {
  assert.equal(applyOrderNumberPrefixRules('PXDEMO_091YEC', [{ from: 'PXDEMO',  to: '' }]),  '091YEC');
  assert.equal(applyOrderNumberPrefixRules('PXDEMO_091YEC', [{ from: 'PXDEMO_', to: '' }]),  '091YEC');
});

test('rules: separator drop takes at most ONE character (from-side)', () => {
  // '--091YEC' has two leading hyphens; only one is dropped after the from-match.
  assert.equal(
    applyOrderNumberPrefixRules('PXDEMO--091YEC', [{ from: 'PXDEMO', to: '' }]),
    '-091YEC',
  );
});

test('rules (M7a): configured PXDEMO must NOT match PXDEMOX — separator is REQUIRED', () => {
  // M7a rule survives into M7b unchanged. When `from` does NOT end in
  // '-'/'_', the character immediately after must be '-' or '_';
  // otherwise this rule does NOT match and the next is tried.
  assert.equal(
    applyOrderNumberPrefixRules('PXDEMOX091YEC', [{ from: 'PXDEMO', to: 'X-' }]),
    'PXDEMOX091YEC',
    'no separator between PXDEMO and X — rule must NOT match, `to` must NOT be applied',
  );
  assert.equal(
    applyOrderNumberPrefixRules('PXDEMO.091YEC', [{ from: 'PXDEMO', to: 'X-' }]),
    'PXDEMO.091YEC',
    "'.' is not a separator — rule must NOT match",
  );
});

test('rules: longest-from-first regardless of input order', () => {
  // Coexistence test called out in design decision #4. Both configured
  // orders must produce the same result — the longer `from` wins
  // because sort is inside the helper.
  const rulesA = [{ from: 'PXDEMO-', to: 'PX-' }, { from: 'PXDEMO1-', to: '' }];
  const rulesB = [{ from: 'PXDEMO1-', to: '' }, { from: 'PXDEMO-', to: 'PX-' }];

  for (const rules of [rulesA, rulesB]) {
    assert.equal(applyOrderNumberPrefixRules('PXDEMO1-091YEC', rules), '091YEC',
      'PXDEMO1- is longer, wins, replaces to "" — strip');
    assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC',  rules), 'PX-091YEC',
      'PXDEMO1- does not match, PXDEMO- matches, replaces to "PX-"');
  }
});

test('rules: longest-first — real Richard config (ORD, PXDEMO, POS) all pure-strip', () => {
  const rules = [{ from: 'ORD', to: '' }, { from: 'PXDEMO', to: '' }, { from: 'POS', to: '' }];
  assert.equal(applyOrderNumberPrefixRules('ORD-091YEC',    rules), '091YEC');
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC', rules), '091YEC');
  assert.equal(applyOrderNumberPrefixRules('POS-091YEC',    rules), '091YEC');
  assert.equal(applyOrderNumberPrefixRules('ZZZ-091YEC',    rules), 'ZZZ-091YEC'); // no match → unchanged
});

test('rules: case-insensitive on the from-match; tail keeps its original casing; `to` is inserted verbatim', () => {
  assert.equal(applyOrderNumberPrefixRules('pxdemo-Abc9', [{ from: 'PXDEMO', to: '' }]),   'Abc9');
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-Abc9', [{ from: 'pxdemo', to: '' }]),   'Abc9');
  // `to` is inserted verbatim — its casing is whatever the operator typed.
  assert.equal(applyOrderNumberPrefixRules('pxdemo-Abc9', [{ from: 'PXDEMO', to: 'PX-' }]), 'PX-Abc9');
});

test('rules: never produces empty — per rule', () => {
  // Pure-strip: `to` is '' and match consumes the whole order number.
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-', [{ from: 'PXDEMO-', to: '' }]), 'PXDEMO-');
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-', [{ from: 'PXDEMO',  to: '' }]), 'PXDEMO-');
  // Replacement that would ALSO produce empty is skipped too (defensive
  // — an operator setting `to: ''` on a rule that matches the whole
  // string is the reason this guard exists).
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-', [{ from: 'PXDEMO-', to: '' }, { from: 'PXDEMO', to: '' }]),
    'PXDEMO-');
});

test('rules: never produces empty — across rules, one saves the day', () => {
  // First rule (longer) would empty; second (shorter with baked
  // separator) still leaves something → returned.
  assert.equal(
    applyOrderNumberPrefixRules('ORD-1', [{ from: 'ORD-1', to: '' }, { from: 'ORD', to: '' }]),
    '1',
  );
});

test('rules: non-empty `to` saves an otherwise-empty rule', () => {
  // A rule whose match would leave the tail empty is NOT skipped when
  // `to` is non-empty — the result is `to` itself, which is non-empty.
  // Confirms the never-empty guard operates on the POST-replacement
  // result, not the tail alone.
  assert.equal(
    applyOrderNumberPrefixRules('PXDEMO-', [{ from: 'PXDEMO-', to: 'X' }]),
    'X',
    'to="X" means result is "X" — non-empty, accepted',
  );
});

test('rules: order number shorter than any from → those rules skipped', () => {
  assert.equal(
    applyOrderNumberPrefixRules('AB', [{ from: 'PXDEMO', to: '' }, { from: 'PXDEMO1', to: '' }]),
    'AB',
  );
});

// ═════════════════════════════════════════════════════════════════════════
// M7a-under-M7b — separator-required cases from the original directive
// ═════════════════════════════════════════════════════════════════════════
//
// The M7a directive's exact-string cases were locked as regression tests
// for the leading-substring hijack. They must survive the M7b helper
// rename unchanged, expressed as pure-strip rules ({to: ''}) so the
// meaning is byte-identical to the M7a set.

const M7A_CASES = [
  { name: 'PXDEMO-091YEC   → 091YEC',                             in: 'PXDEMO-091YEC',  rules: [{ from: 'PXDEMO',  to: '' }], out: '091YEC' },
  { name: 'PXDEMO_091YEC   → 091YEC  (underscore separator)',     in: 'PXDEMO_091YEC',  rules: [{ from: 'PXDEMO',  to: '' }], out: '091YEC' },
  { name: 'PXDEMO-091YEC   → 091YEC  (from baked with hyphen)',   in: 'PXDEMO-091YEC',  rules: [{ from: 'PXDEMO-', to: '' }], out: '091YEC' },
  { name: 'PXDEMOX-1       → PXDEMOX-1  (no separator = no match — the M7a fix)',
    in: 'PXDEMOX-1', rules: [{ from: 'PXDEMO', to: '' }], out: 'PXDEMOX-1' },
  { name: 'PXDEMOX         → PXDEMOX    (no separator = no match — the M7a fix)',
    in: 'PXDEMOX',   rules: [{ from: 'PXDEMO', to: '' }], out: 'PXDEMOX' },
  { name: 'PXDEMO091YEC    → PXDEMO091YEC  (accepted cost — no separator, no match)',
    in: 'PXDEMO091YEC', rules: [{ from: 'PXDEMO', to: '' }], out: 'PXDEMO091YEC' },
  { name: 'PXDEMO-         → PXDEMO-   (would produce empty)',    in: 'PXDEMO-',        rules: [{ from: 'PXDEMO',  to: '' }], out: 'PXDEMO-' },
  { name: 'PXDEMO          → PXDEMO    (no separator + would produce empty)',
    in: 'PXDEMO',    rules: [{ from: 'PXDEMO', to: '' }], out: 'PXDEMO' },
  { name: 'PXDEMO--1       → -1        (only ONE separator dropped)',
    in: 'PXDEMO--1', rules: [{ from: 'PXDEMO', to: '' }], out: '-1' },
  { name: 'pxdemo-091yec   → 091yec    (case-insens match, tail casing preserved)',
    in: 'pxdemo-091yec', rules: [{ from: 'PXDEMO', to: '' }], out: '091yec' },
];

for (const c of M7A_CASES) {
  test(`M7a-under-M7b: ${c.name}`, () => {
    assert.equal(applyOrderNumberPrefixRules(c.in, c.rules), c.out);
  });
}

test('rules: malformed entries in list are ignored (defensive)', () => {
  // Non-object, missing from, non-string from, empty from — all filtered
  // BEFORE sort so one bad entry can't hide a good one behind it.
  assert.equal(
    applyOrderNumberPrefixRules('PXDEMO-091YEC', [
      null,
      undefined,
      42,
      'a-string',
      {},
      { to: 'x' },              // missing from
      { from: '', to: 'x' },    // empty from
      { from: 42,  to: 'x' },   // non-string from
      { from: 'PXDEMO', to: '' },
    ]),
    '091YEC',
  );
});

test('rules: missing/non-string `to` is treated as "" (pure strip)', () => {
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC', [{ from: 'PXDEMO' }]),                '091YEC');
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC', [{ from: 'PXDEMO', to: null }]),      '091YEC');
  assert.equal(applyOrderNumberPrefixRules('PXDEMO-091YEC', [{ from: 'PXDEMO', to: 42 }]),        '091YEC');
});

test('rules: non-string order number → returned verbatim', () => {
  assert.equal(applyOrderNumberPrefixRules(null,      [{ from: 'X', to: '' }]), null);
  assert.equal(applyOrderNumberPrefixRules(undefined, [{ from: 'X', to: '' }]), undefined);
  assert.equal(applyOrderNumberPrefixRules(1234,      [{ from: 'X', to: '' }]), 1234);
});

// ═════════════════════════════════════════════════════════════════════════
// readOrderNumberPrefixRules — the ONE tolerant reader (three shapes)
// ═════════════════════════════════════════════════════════════════════════
//
// M7b field: orderNumberPrefixRules: Array<{from, to}>
// M7 field:  stripOrderNumberPrefixes: string[]  → each → {from: s, to: ''}
// Legacy 1.13.0: stripOrderNumberPrefix: string → single [{from: s, to: ''}]
//
// Every route literal calls this rather than duplicating the coercion.
// Four copies of the same coercion would be the same drift hazard the
// route-literal parity tests exist to catch.

test('reader: new pair-array field wins', () => {
  assert.deepEqual(
    readOrderNumberPrefixRules({
      orderNumberPrefixRules: [{ from: 'PXDEMO-', to: 'PX-' }, { from: 'ORD-', to: '' }],
    }),
    [{ from: 'PXDEMO-', to: 'PX-' }, { from: 'ORD-', to: '' }],
  );
});

test('reader: M7 string[] field promotes to pair array with to:""', () => {
  assert.deepEqual(
    readOrderNumberPrefixRules({ stripOrderNumberPrefixes: ['ORD', 'PXDEMO'] }),
    [{ from: 'ORD', to: '' }, { from: 'PXDEMO', to: '' }],
  );
});

test('reader: legacy string field wraps as single pair with to:""', () => {
  assert.deepEqual(
    readOrderNumberPrefixRules({ stripOrderNumberPrefix: 'PXDEMO-' }),
    [{ from: 'PXDEMO-', to: '' }],
  );
});

test('reader: new pair field wins even when M7 string[] AND legacy string are also present', () => {
  // Downgrade-friendly: older fields kept on save so older code sees
  // something. On read, newest field wins.
  assert.deepEqual(
    readOrderNumberPrefixRules({
      orderNumberPrefixRules:   [{ from: 'PXDEMO-', to: 'PX-' }],
      stripOrderNumberPrefixes: ['ORD', 'POS'],
      stripOrderNumberPrefix:   'LEGACY-',
    }),
    [{ from: 'PXDEMO-', to: 'PX-' }],
  );
});

test('reader: M7 string[] wins over legacy string when new pair field absent', () => {
  assert.deepEqual(
    readOrderNumberPrefixRules({
      stripOrderNumberPrefixes: ['ORD', 'POS'],
      stripOrderNumberPrefix:   'PXDEMO-',
    }),
    [{ from: 'ORD', to: '' }, { from: 'POS', to: '' }],
  );
});

test('reader: none of the three fields present → []', () => {
  assert.deepEqual(readOrderNumberPrefixRules({}),        []);
  assert.deepEqual(readOrderNumberPrefixRules(null),      []);
  assert.deepEqual(readOrderNumberPrefixRules(undefined), []);
});

test('reader: filters malformed entries from the new pair array', () => {
  assert.deepEqual(
    readOrderNumberPrefixRules({
      orderNumberPrefixRules: [
        { from: 'ORD', to: '' },
        null,
        undefined,
        42,
        {},
        { to: 'x' },                     // missing from
        { from: '',  to: 'x' },          // empty from
        { from: 42,  to: 'x' },          // non-string from
        { from: 'POS', to: null },       // non-string to → normalises to ''
        { from: 'PXDEMO' },              // missing to → normalises to ''
      ],
    }),
    [
      { from: 'ORD',    to: '' },
      { from: 'POS',    to: '' },
      { from: 'PXDEMO', to: '' },
    ],
  );
});

test('reader: empty new pair array is not falsy — returns [] rather than falling through', () => {
  // Operator explicitly cleared the list — respect that. Do NOT fall
  // through to a stale M7 string[] or legacy string.
  assert.deepEqual(
    readOrderNumberPrefixRules({
      orderNumberPrefixRules:   [],
      stripOrderNumberPrefixes: ['ORD'],
      stripOrderNumberPrefix:   'PXDEMO-',
    }),
    [],
  );
});

test('reader: non-array new field falls through to the M7 field', () => {
  assert.deepEqual(
    readOrderNumberPrefixRules({
      orderNumberPrefixRules:   'not-an-array',
      stripOrderNumberPrefixes: ['ORD'],
    }),
    [{ from: 'ORD', to: '' }],
  );
});

test('reader: filters empty strings and non-strings from the M7 string[]', () => {
  assert.deepEqual(
    readOrderNumberPrefixRules({ stripOrderNumberPrefixes: ['ORD', '', null, undefined, 42, 'POS'] }),
    [{ from: 'ORD', to: '' }, { from: 'POS', to: '' }],
  );
});

test('reader: legacy empty string → [] (never a single-element pair with empty from)', () => {
  assert.deepEqual(readOrderNumberPrefixRules({ stripOrderNumberPrefix: '' }), []);
});
