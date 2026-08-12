'use strict';

/**
 * Tests for the Channel Mappings CSV parser (main-side, invoked via
 * `ohd:routing:parse-mappings-csv`). Pinning the pre-v1.10.1 positional
 * format so the migration from the renderer's inline parser is a
 * byte-for-byte behaviour-preserving move.
 *
 * The format extension that adds an optional `print_size_code` column
 * lives in a follow-up milestone and its tests land with that change.
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

// ── Positional CSV ──────────────────────────────────────────────────────────

test('parseChannelMappingsCsv: header-less positional CSV', () => {
  const csv = [
    '4,PROD-A,finish:lustre,paper:matte',
    '5,PROD-B,finish:glossy',
  ].join('\n');

  const { rows, skipped } = parseChannelMappingsCsv(csv);

  assert.equal(skipped.length, 0);
  assert.equal(rows.length,    2);

  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.deepEqual(rows[0].options, [
    { name: 'finish', value: 'lustre' },
    { name: 'paper',  value: 'matte'  },
  ]);
  assert.equal(rows[0].lineNum, 1);

  assert.equal(rows[1].channelNumber, 5);
  assert.equal(rows[1].productCode,   'PROD-B');
  assert.equal(rows[1].lineNum,       2);
});

test('parseChannelMappingsCsv: header row is detected and discarded', () => {
  // Pre-v1.10.1 behaviour: the header's column names are not consulted;
  // subsequent rows are parsed positionally regardless of the header
  // shape.
  const csv = [
    'channel,product_code,option,option',
    '4,PROD-A,finish:lustre,paper:matte',
  ].join('\n');

  const { rows, skipped } = parseChannelMappingsCsv(csv);

  assert.equal(skipped.length, 0);
  assert.equal(rows.length,    1);
  assert.equal(rows[0].channelNumber, 4);
  assert.equal(rows[0].productCode,   'PROD-A');
  assert.deepEqual(rows[0].options, [
    { name: 'finish', value: 'lustre' },
    { name: 'paper',  value: 'matte'  },
  ]);
  // Data row is line 2 (header at line 1); the parser's lineNum reflects
  // the CSV line, not the row index.
  assert.equal(rows[0].lineNum, 2);
});

// ── Skipped rows ────────────────────────────────────────────────────────────

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

// ── Comments and blank lines ────────────────────────────────────────────────

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

// ── Defensive ───────────────────────────────────────────────────────────────

test('parseChannelMappingsCsv: null / undefined / empty input → empty result, no throw', () => {
  assert.deepEqual(parseChannelMappingsCsv(null),      { rows: [], skipped: [] });
  assert.deepEqual(parseChannelMappingsCsv(undefined), { rows: [], skipped: [] });
  assert.deepEqual(parseChannelMappingsCsv(''),        { rows: [], skipped: [] });
});
