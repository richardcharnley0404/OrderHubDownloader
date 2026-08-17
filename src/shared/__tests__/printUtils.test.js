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
  stripOrderNumberPrefixMulti,
  readStripPrefixes,
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
// stripOrderNumberPrefixMulti — the M7 multi-prefix helper
// ═════════════════════════════════════════════════════════════════════════
//
// One OHD install talks to one OrderHub org, but the org can ship orders
// with several prefixes distinguishing the source website (Richard's
// config: ORD-, PXDEMO-, POS-). Rules enforced here:
//   - Longest-match-first, sorted INSIDE the helper. This is the
//     load-bearing rule; a lab finds the bug otherwise and a test doesn't
//     unless someone writes it deliberately.
//   - After a match, drop ONE leading '-' or '_' if present. Both
//     'PXDEMO-' and 'PXDEMO' work the same way.
//   - Never-strip-to-empty per candidate. If a match would empty the
//     string, try the next candidate; if all would, return original.

test('multi: empty prefix list → order number unchanged', () => {
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-091YEC', []), 'PXDEMO-091YEC');
});

test('multi: non-array prefix list → order number unchanged (defensive)', () => {
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-091YEC', 'PXDEMO-'), 'PXDEMO-091YEC');
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-091YEC', null),       'PXDEMO-091YEC');
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-091YEC', undefined),  'PXDEMO-091YEC');
});

test('multi: single-element list with trailing hyphen → same result as single-prefix helper', () => {
  // Parity with the primitive: single-element ['PXDEMO-'] on 'PXDEMO-091YEC'
  // must produce '091YEC' — same as stripOrderNumberPrefix('PXDEMO-091YEC', 'PXDEMO-').
  const singleResult = stripOrderNumberPrefix('PXDEMO-091YEC', 'PXDEMO-');
  const multiResult  = stripOrderNumberPrefixMulti('PXDEMO-091YEC', ['PXDEMO-']);
  assert.equal(multiResult, singleResult);
  assert.equal(multiResult, '091YEC');
});

test('multi: single-element list WITHOUT hyphen → separator dropped (M7-only behaviour)', () => {
  // The primitive would leave the '-' on the front:
  assert.equal(stripOrderNumberPrefix('PXDEMO-091YEC', 'PXDEMO'), '-091YEC');
  // The multi helper drops one leading '-' after the match:
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-091YEC', ['PXDEMO']), '091YEC');
});

test('multi: separator drop applies to underscore too', () => {
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO_091YEC', ['PXDEMO']),  '091YEC');
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO_091YEC', ['PXDEMO_']), '091YEC');
});

test('multi: separator drop takes at most ONE character', () => {
  // '--091YEC' has two leading hyphens; only one is dropped.
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO--091YEC', ['PXDEMO']), '-091YEC');
});

test('multi (M7a): configured PXDEMO must NOT strip PXDEMOX — separator is REQUIRED', () => {
  // M7a fix. Pre-M7a this assertion was written the OTHER WAY —
  // asserting the leading-substring strip succeeded to 'X091YEC' —
  // codifying the bug it should have caught. That was worse than no
  // test: the title said the right thing, the assertion said the
  // wrong thing, and a passing suite gave false confidence.
  //
  // Rule now enforced in the helper: when the configured prefix does
  // NOT itself end in '-'/'_', the character immediately after the
  // prefix in the order number MUST be '-' or '_'. If it's anything
  // else (a letter, digit, '.'), this candidate does NOT match and
  // we try the next one — no leading-substring hijack.
  assert.equal(stripOrderNumberPrefixMulti('PXDEMOX091YEC', ['PXDEMO']), 'PXDEMOX091YEC',
    'no separator between PXDEMO and X — prefix must NOT strip');
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO.091YEC', ['PXDEMO']), 'PXDEMO.091YEC',
    "'.' is not a separator — prefix must NOT strip");
});

test('multi: longest-match-first regardless of input order', () => {
  // With both 'PXDEMO' and 'PXDEMO1' configured, 'PXDEMO1-091YEC' must
  // strip via 'PXDEMO1' — not via 'PXDEMO' (which would leave '1-091YEC').
  // The load-bearing test: try BOTH input orders and both must produce
  // the same result. If a future maintainer moves sorting to the caller,
  // one of these fails.
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO1-091YEC', ['PXDEMO', 'PXDEMO1']),  '091YEC');
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO1-091YEC', ['PXDEMO1', 'PXDEMO']),  '091YEC');
});

test('multi: longest-match-first — real Richard config (ORD, PXDEMO, POS)', () => {
  // The actual prefixes reported for Richard's install.
  const list = ['ORD', 'PXDEMO', 'POS'];
  assert.equal(stripOrderNumberPrefixMulti('ORD-091YEC',    list), '091YEC');
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-091YEC', list), '091YEC');
  assert.equal(stripOrderNumberPrefixMulti('POS-091YEC',    list), '091YEC');
  assert.equal(stripOrderNumberPrefixMulti('ZZZ-091YEC',    list), 'ZZZ-091YEC'); // no match → unchanged
});

test('multi: case-insensitive on the match; tail keeps its original casing', () => {
  assert.equal(stripOrderNumberPrefixMulti('pxdemo-Abc9', ['PXDEMO']), 'Abc9');
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-Abc9', ['pxdemo']), 'Abc9');
});

test('multi: never strips to empty — per candidate', () => {
  // Prefix equals the whole order number → the ONE candidate would empty
  // the string → skipped → return original.
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-', ['PXDEMO-']), 'PXDEMO-');
  // Prefix + separator equals the whole order number → same story.
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO-', ['PXDEMO']), 'PXDEMO-');
});

test('multi: never strips to empty — across candidates, one saves the day', () => {
  // Case 1: only candidate would empty the string → skip → return original.
  // 'PXDEMO' matched by prefix 'PXDEMO' leaves empty. 'ORD' doesn't match.
  assert.equal(stripOrderNumberPrefixMulti('PXDEMO', ['PXDEMO', 'ORD']), 'PXDEMO');
  // Case 2 (M7a-adjusted): one candidate would empty, a SHORTER one
  // that still requires a separator does NOT match without one; the
  // save-the-day only works if the second candidate itself has a
  // valid separator boundary. Pre-M7a this test asserted 'PX' →
  // 'DEMO' via leading-substring hijack; under M7a that hijack no
  // longer happens. Real save-the-day shape: same order number, two
  // candidates where the longer would strip the whole thing empty
  // and the shorter (with baked-in separator) still leaves something.
  //   'ORD-1' with ['ORD-1', 'ORD']:
  //     ['ORD-1'] matches whole 5 chars → remainder '' → skip
  //     'ORD'    matches head 'ORD', remainder '-1', drop '-' → '1' ✓
  assert.equal(stripOrderNumberPrefixMulti('ORD-1', ['ORD-1', 'ORD']), '1');
});

test('multi: order number shorter than any prefix → those candidates skipped', () => {
  assert.equal(stripOrderNumberPrefixMulti('AB', ['PXDEMO', 'PXDEMO1']), 'AB');
});

// ═════════════════════════════════════════════════════════════════════════
// M7a — separator is REQUIRED (exact-string cases from the directive)
// ═════════════════════════════════════════════════════════════════════════
//
// The M7 helper accepted leading-substring matches when the remainder
// didn't start with a separator: 'PXDEMOX-1' with prefix ['PXDEMO']
// returned 'X-1'. Under M7a the separator is mandatory unless it's
// baked into the configured prefix, so leading-substring matches no
// longer strip. Accepted cost: separator-less schemes like
// 'PXDEMO091YEC' no longer strip either — but every real OrderHub
// order number on this install carries the shape PREFIX-CODE
// (ORD-K9AOA6, PXDEMO-AZ5UKP, POS-JBML6D), so it doesn't occur.
//
// Full exact-string list from the M7a directive, all with prefix
// ['PXDEMO'] unless stated. Each is its own assertion so a regression
// names the specific input that diverged.

const M7A_CASES = [
  { name: 'PXDEMO-091YEC   → 091YEC',                             in: 'PXDEMO-091YEC',  prefixes: ['PXDEMO'],   out: '091YEC' },
  { name: 'PXDEMO_091YEC   → 091YEC  (underscore separator)',     in: 'PXDEMO_091YEC',  prefixes: ['PXDEMO'],   out: '091YEC' },
  { name: 'PXDEMO-091YEC   → 091YEC  (prefix baked with hyphen)', in: 'PXDEMO-091YEC',  prefixes: ['PXDEMO-'],  out: '091YEC' },
  { name: 'PXDEMOX-1       → PXDEMOX-1  (no separator = no match — the M7a fix)',
    in: 'PXDEMOX-1', prefixes: ['PXDEMO'], out: 'PXDEMOX-1' },
  { name: 'PXDEMOX         → PXDEMOX    (no separator = no match — the M7a fix)',
    in: 'PXDEMOX',   prefixes: ['PXDEMO'], out: 'PXDEMOX' },
  { name: 'PXDEMO091YEC    → PXDEMO091YEC  (accepted cost — no separator, no strip)',
    in: 'PXDEMO091YEC', prefixes: ['PXDEMO'], out: 'PXDEMO091YEC' },
  { name: 'PXDEMO-         → PXDEMO-   (would strip to empty)',   in: 'PXDEMO-',        prefixes: ['PXDEMO'],   out: 'PXDEMO-' },
  { name: 'PXDEMO          → PXDEMO    (no separator + would empty)',
    in: 'PXDEMO',    prefixes: ['PXDEMO'], out: 'PXDEMO' },
  { name: 'PXDEMO--1       → -1        (only ONE separator dropped)',
    in: 'PXDEMO--1', prefixes: ['PXDEMO'], out: '-1' },
  { name: 'pxdemo-091yec   → 091yec    (case-insens match, tail casing preserved)',
    in: 'pxdemo-091yec', prefixes: ['PXDEMO'], out: '091yec' },
];

for (const c of M7A_CASES) {
  test(`M7a: ${c.name}`, () => {
    assert.equal(stripOrderNumberPrefixMulti(c.in, c.prefixes), c.out);
  });
}

test('M7a: longest-first regardless of input order — PXDEMO1-091YEC with [PXDEMO, PXDEMO1]', () => {
  // Both input orders must produce the same result: the longer prefix
  // wins because sort is inside the helper. Locking here explicitly
  // — separately from the general longest-first test above — so the
  // M7a directive's exact case survives even if the general test is
  // ever refactored.
  assert.equal(
    stripOrderNumberPrefixMulti('PXDEMO1-091YEC', ['PXDEMO', 'PXDEMO1']),
    '091YEC',
  );
  assert.equal(
    stripOrderNumberPrefixMulti('PXDEMO1-091YEC', ['PXDEMO1', 'PXDEMO']),
    '091YEC',
  );
});

test('multi: empty and non-string entries in list are ignored', () => {
  // Filter should skip these before the sort.
  assert.equal(
    stripOrderNumberPrefixMulti('PXDEMO-091YEC', ['', null, undefined, 42, 'PXDEMO']),
    '091YEC',
  );
});

test('multi: non-string order number → returned verbatim', () => {
  assert.equal(stripOrderNumberPrefixMulti(null,      ['X']), null);
  assert.equal(stripOrderNumberPrefixMulti(undefined, ['X']), undefined);
  assert.equal(stripOrderNumberPrefixMulti(1234,      ['X']), 1234);
});

// ═════════════════════════════════════════════════════════════════════════
// readStripPrefixes — the ONE tolerant reader
// ═════════════════════════════════════════════════════════════════════════
//
// Every route literal calls this rather than duplicating the coercion.
// Four copies of the same coercion would be the same drift hazard the
// route-literal parity tests exist to catch.

test('readStripPrefixes: new array field wins', () => {
  assert.deepEqual(
    readStripPrefixes({ stripOrderNumberPrefixes: ['ORD', 'PXDEMO'] }),
    ['ORD', 'PXDEMO'],
  );
});

test('readStripPrefixes: legacy string field wrapped as single-element array', () => {
  assert.deepEqual(
    readStripPrefixes({ stripOrderNumberPrefix: 'PXDEMO-' }),
    ['PXDEMO-'],
  );
});

test('readStripPrefixes: new array wins even when legacy string is also present', () => {
  // Downgrade-friendly: we keep the legacy field on save so v1.12.2 code
  // would still see something. On read, the new field wins.
  assert.deepEqual(
    readStripPrefixes({
      stripOrderNumberPrefixes: ['ORD', 'POS'],
      stripOrderNumberPrefix:   'PXDEMO-',
    }),
    ['ORD', 'POS'],
  );
});

test('readStripPrefixes: neither field present → []', () => {
  assert.deepEqual(readStripPrefixes({}),        []);
  assert.deepEqual(readStripPrefixes(null),      []);
  assert.deepEqual(readStripPrefixes(undefined), []);
});

test('readStripPrefixes: filters empty strings and non-strings from the new array', () => {
  assert.deepEqual(
    readStripPrefixes({ stripOrderNumberPrefixes: ['ORD', '', null, undefined, 42, 'POS'] }),
    ['ORD', 'POS'],
  );
});

test('readStripPrefixes: empty new array is not falsy — returns [] rather than falling back to legacy', () => {
  // Operator explicitly cleared the list — respect that and do NOT
  // fall back to a stale legacy value.
  assert.deepEqual(
    readStripPrefixes({
      stripOrderNumberPrefixes: [],
      stripOrderNumberPrefix:   'PXDEMO-',
    }),
    [],
  );
});

test('readStripPrefixes: non-array new field falls through to legacy', () => {
  // If the new field is present but the wrong shape, treat it as absent
  // and try the legacy field. Defensive against a hand-edited config.
  assert.deepEqual(
    readStripPrefixes({
      stripOrderNumberPrefixes: 'not-an-array',
      stripOrderNumberPrefix:   'PXDEMO-',
    }),
    ['PXDEMO-'],
  );
});

test('readStripPrefixes: legacy empty string → [] (never a single-element [""])', () => {
  assert.deepEqual(readStripPrefixes({ stripOrderNumberPrefix: '' }), []);
});
