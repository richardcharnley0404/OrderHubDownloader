'use strict';

/**
 * Tests for the Channel Mappings CSV parser (main-side, invoked via
 * `ohd:routing:parse-mappings-csv`).
 *
 * Two eras coexist:
 *
 *   - Pre-v1.10.1 positional CSVs — no header row (or one that the
 *     parser discarded) and no print-size column. Every existing lab
 *     CSV must import byte-identically after v1.10.1.
 *   - v1.10.1 header-driven CSVs — optional `print_size_code` column,
 *     free column order, aliases and case/punctuation-insensitive
 *     header names.
 *
 * Both are pinned here so a future refactor that regresses either era
 * fails the suite.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const { parseChannelMappingsCsv, parseCsvLine } = require(
  path.join(__dirname, '..', 'csvChannelMappingsParser.js'),
);

// ── parseCsvLine ─────────────────────────────────────────────────────────────

test('parseCsvLine: simple comma-separated cells', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
});

test('parseCsvLine: quoted cell with embedded comma', () => {
  assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
});

test('parseCsvLine: escaped double-quote inside quoted cell', () => {
  assert.deepEqual(parseCsvLine('a,"b""c",d'), ['a', 'b"c', 'd']);
});

test('parseCsvLine: trailing empty cell preserved', () => {
  assert.deepEqual(parseCsvLine('a,b,'), ['a', 'b', '']);
});

// ── Pre-v1.10.1 positional format ───────────────────────────────────────────

test('parseChannelMappingsCsv: header-less positional CSV (pre-v1.10.1)', () => {
  const csv = [
    '4,PROD-A,finish:lustre,paper:matte',
    '5,PROD-B,finish:glossy',
  ].join('\n');

  const { rows, skipped } = parseChannelMappingsCsv(csv);

  assert.equal(skipped.length, 0);
  assert.equal(rows.length,    2);

  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.equal(rows[0].printSizeCode, '', 'no header + no printSize column → empty string');
  assert.deepEqual(rows[0].options, [
    { name: 'finish', value: 'lustre' },
    { name: 'paper',  value: 'matte'  },
  ]);
  assert.equal(rows[0].lineNum, 1);

  assert.equal(rows[1].channelNumber, 5);
  assert.equal(rows[1].productCode,   'PROD-B');
  assert.equal(rows[1].printSizeCode, '');
  assert.equal(rows[1].lineNum,       2);
});

test('parseChannelMappingsCsv: pre-v1.10.1 header row (channel,product_code,option,option) parses identically', () => {
  // A pre-v1.10.1 CSV commonly ships with this header. `channel` and
  // `product_code` are recognised names and get remapped to cols 0/1
  // (which is where they already were); `option` cells are not
  // recognised and stay in the positional stream as option candidates.
  // Result: identical output shape to the truly header-less variant
  // above.
  const csv = [
    'channel,product_code,option,option',
    '4,PROD-A,finish:lustre,paper:matte',
  ].join('\n');

  const { rows, skipped } = parseChannelMappingsCsv(csv);

  assert.equal(skipped.length, 0);
  assert.equal(rows.length,    1);
  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.equal(rows[0].printSizeCode, '');
  assert.deepEqual(rows[0].options, [
    { name: 'finish', value: 'lustre' },
    { name: 'paper',  value: 'matte'  },
  ]);
  // Data row is line 2 (header at line 1).
  assert.equal(rows[0].lineNum, 2);
});

test('parseChannelMappingsCsv: missing channel or product → skipped with reason + lineNum', () => {
  const csv = [
    'channel,product_code',
    '4,PROD-A',
    ',PROD-B',           // missing channel
    '5,',                // missing product
    'abc,PROD-C',        // non-numeric channel
  ].join('\n');

  const { rows, skipped } = parseChannelMappingsCsv(csv);

  assert.equal(rows.length,    1, 'only the well-formed row parses');
  assert.equal(skipped.length, 3);
  assert.match(skipped[0].reason, /Channel number missing/);
  assert.equal(skipped[0].lineNum, 3);
  assert.match(skipped[1].reason, /Product code is empty/);
  assert.equal(skipped[1].lineNum, 4);
  assert.match(skipped[2].reason, /Channel number missing/);
  assert.equal(skipped[2].lineNum, 5);
});

test('parseChannelMappingsCsv: cells without a colon are silently dropped from options', () => {
  // Legacy behaviour — a cell in the options range that doesn't parse
  // as `name:value` is ignored. Documented so operators adding a
  // notes/description column don't break the import.
  const csv = [
    '4,PROD-A,junk,finish:lustre',
  ].join('\n');

  const { rows } = parseChannelMappingsCsv(csv);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].options, [{ name: 'finish', value: 'lustre' }]);
});

test('parseChannelMappingsCsv: # comment lines and blank lines ignored, lineNum still correct', () => {
  const csv = [
    'channel,product_code',
    '',
    '# controller block: Noritsu QSS-37',
    '4,PROD-A',
    '',
    '5,PROD-B',
  ].join('\n');

  const { rows, skipped } = parseChannelMappingsCsv(csv);

  assert.equal(skipped.length, 0);
  assert.equal(rows.length,    2);
  assert.equal(rows[0].lineNum, 4);
  assert.equal(rows[1].lineNum, 6);
});

// ── v1.10.1: optional printSizeCode column ──────────────────────────────────

test('parseChannelMappingsCsv: printSizeCode column present → picked up per row', () => {
  const csv = [
    'channel,product_code,print_size_code,option,option',
    '4,PROD-A,KG,finish:lustre,paper:matte',
    '5,PROD-B,3.5x5,finish:glossy,',
  ].join('\n');

  const { rows, skipped } = parseChannelMappingsCsv(csv);

  assert.equal(skipped.length, 0);
  assert.equal(rows.length,    2);
  assert.equal(rows[0].printSizeCode, 'KG');
  assert.equal(rows[1].printSizeCode, '3.5x5');
  // Options still parse correctly around the print-size column.
  assert.deepEqual(rows[0].options, [
    { name: 'finish', value: 'lustre' },
    { name: 'paper',  value: 'matte'  },
  ]);
  assert.deepEqual(rows[1].options, [
    { name: 'finish', value: 'glossy' },
  ]);
});

test('parseChannelMappingsCsv: printSizeCode blank cell → empty string on that row', () => {
  // Partially-populated CSV — some rows have the print size, others
  // don't. Blank cell must yield '' (rather than a stray option or a
  // parse error) so the import loop pairs it with the IPC validator's
  // "Print Size Code is required" rejection on a per-row basis.
  const csv = [
    'channel,product_code,print_size_code,option',
    '4,PROD-A,KG,finish:lustre',
    '5,PROD-B,,finish:glossy',
    '6,PROD-C,4x6,',
  ].join('\n');

  const { rows } = parseChannelMappingsCsv(csv);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].printSizeCode, 'KG');
  assert.equal(rows[1].printSizeCode, '');
  assert.equal(rows[2].printSizeCode, '4x6');
});

test('parseChannelMappingsCsv: out-of-order headers — product,channel,printSizeCode parses identically', () => {
  const csv = [
    'product,channel,printSizeCode,option',
    'PROD-A,4,KG,finish:lustre',
  ].join('\n');

  const { rows } = parseChannelMappingsCsv(csv);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.equal(rows[0].printSizeCode, 'KG');
  assert.deepEqual(rows[0].options, [{ name: 'finish', value: 'lustre' }]);
});

test('parseChannelMappingsCsv: print-size column BEFORE product still works', () => {
  const csv = [
    'print_size_code,channel,product_code,option',
    'KG,4,PROD-A,finish:lustre',
  ].join('\n');

  const { rows } = parseChannelMappingsCsv(csv);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.equal(rows[0].printSizeCode, 'KG');
  assert.deepEqual(rows[0].options, [{ name: 'finish', value: 'lustre' }]);
});

test('parseChannelMappingsCsv: extra unknown header columns do not corrupt row parsing', () => {
  // `extra` is not a recognised header name so its column stays in the
  // positional option stream. Cell content `junk` has no `:` and is
  // silently dropped by the options shape check — same rule the
  // pre-v1.10.1 parser applied.
  const csv = [
    'channel,product_code,extra,print_size_code,option',
    '4,PROD-A,junk,KG,finish:lustre',
  ].join('\n');

  const { rows } = parseChannelMappingsCsv(csv);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.equal(rows[0].printSizeCode, 'KG');
  assert.deepEqual(rows[0].options, [{ name: 'finish', value: 'lustre' }],
    'extra cell without a colon is silently dropped, not treated as an option');
});

test('parseChannelMappingsCsv: extra unknown column containing valid name:value becomes an option', () => {
  // Documenting the current behaviour explicitly rather than silently:
  // an unknown-named column that happens to hold a `name:value` cell
  // DOES become an option. Matches the pre-v1.10.1 rule where every
  // non-fixed column was an option candidate. If the operator wanted
  // this cell ignored, they need to leave it empty or use a value
  // without `:`.
  const csv = [
    'channel,product_code,extra_note,option',
    '4,PROD-A,category:landscape,finish:lustre',
  ].join('\n');

  const { rows } = parseChannelMappingsCsv(csv);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].options.length, 2);
});

test('parseChannelMappingsCsv: header aliases — channelNumber, productCode, printSize all map correctly', () => {
  const csv = [
    'channelNumber,productCode,printSize',
    '4,PROD-A,KG',
  ].join('\n');
  const { rows } = parseChannelMappingsCsv(csv);
  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.equal(rows[0].printSizeCode, 'KG');
});

test('parseChannelMappingsCsv: `size` header alias maps to printSizeCode', () => {
  // Matches the dual-source read in validateDPOFPrintSizeCode which
  // accepts either `printSizeCode` or the legacy `size` field.
  const csv = [
    'channel,product_code,size',
    '4,PROD-A,KG',
  ].join('\n');
  const { rows } = parseChannelMappingsCsv(csv);
  assert.equal(rows[0].printSizeCode, 'KG');
});

test('parseChannelMappingsCsv: header names are case-insensitive and punctuation-insensitive', () => {
  const csv = [
    'CHANNEL,Product-Code,Print Size Code',
    '4,PROD-A,KG',
  ].join('\n');
  const { rows } = parseChannelMappingsCsv(csv);
  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.equal(rows[0].printSizeCode, 'KG');
});

// ── Round-trip stability with the export path ───────────────────────────────

test('parseChannelMappingsCsv: round-trips the shape the exporter emits', () => {
  // Locks the format contract with the export path in renderer.js —
  // header `channel,product_code,print_size_code,option,option,...`,
  // one `# {controllerName}` block marker per controller, no controller
  // column (import is scoped by the modal's controller selector).
  const exported = [
    'channel,product_code,print_size_code,option,option',
    '# Noritsu QSS-37',
    '4,PROD-A,KG,finish:lustre,paper:matte',
    '5,PROD-B,3.5x5,finish:glossy,',
    '# Epson Surelab',
    '6,PROD-C,4x6,,',
  ].join('\r\n');

  const { rows, skipped } = parseChannelMappingsCsv(exported);

  assert.equal(skipped.length, 0);
  assert.equal(rows.length,    3);
  assert.equal(rows[0].printSizeCode, 'KG');
  assert.equal(rows[1].printSizeCode, '3.5x5');
  assert.equal(rows[2].printSizeCode, '4x6');
});

// ── Defensive ───────────────────────────────────────────────────────────────

test('parseChannelMappingsCsv: null / undefined / empty input → empty result, no throw', () => {
  assert.deepEqual(parseChannelMappingsCsv(null),      { rows: [], skipped: [] });
  assert.deepEqual(parseChannelMappingsCsv(undefined), { rows: [], skipped: [] });
  assert.deepEqual(parseChannelMappingsCsv(''),        { rows: [], skipped: [] });
});
