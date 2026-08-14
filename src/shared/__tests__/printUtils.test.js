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

const { buildFolderName, extractSurname, stripOrderNumberPrefix } = require('../printUtils.js');

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

test('stripOrderNumberPrefix: non-string order number returned verbatim (defensive)', () => {
  // Shape errors from the caller are not our problem to translate;
  // the intent of the guard is only "do not throw, do not crash".
  assert.equal(stripOrderNumberPrefix(null,      'X-'), null);
  assert.equal(stripOrderNumberPrefix(undefined, 'X-'), undefined);
  assert.equal(stripOrderNumberPrefix(1234,      'X-'), 1234);
});
