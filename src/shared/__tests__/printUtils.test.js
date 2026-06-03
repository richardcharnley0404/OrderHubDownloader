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

const { buildFolderName, extractSurname } = require('../printUtils.js');

const baseJob = {
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

test('buildFolderName without opts produces the legacy folder name', () => {
  const name = buildFolderName('o', baseJob);
  assert.equal(name, 'oPXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName without opts handles a reprint suffix', () => {
  const name = buildFolderName('o', baseJob, 'r1');
  assert.equal(name, 'oPXDEMO-DR2PE0-1_r1_4x6 Photo Print_lustre_full-bleed');
});

// ── buildFolderName: customer-surname option ────────────────────────────────

test('buildFolderName inserts surname between jobNo and product when enabled', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: true,
    customerName:        'Richard Charnley',
  });
  assert.equal(name, 'oPXDEMO-DR2PE0-1_Charnley_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName falls back to full name when only one token is present', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: true,
    customerName:        'Cher',
  });
  assert.equal(name, 'oPXDEMO-DR2PE0-1_Cher_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName inserts surname before the reprint suffix', () => {
  const name = buildFolderName('o', baseJob, 'r1', {
    includeCustomerName: true,
    customerName:        'Richard Charnley',
  });
  assert.equal(name, 'oPXDEMO-DR2PE0-1_Charnley_r1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName omits the surname segment when the flag is off', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: false,
    customerName:        'Richard Charnley',
  });
  assert.equal(name, 'oPXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName omits the surname segment when the name is empty', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: true,
    customerName:        '',
  });
  assert.equal(name, 'oPXDEMO-DR2PE0-1_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName strips NTFS-unsafe characters from the surname', () => {
  const name = buildFolderName('o', baseJob, null, {
    includeCustomerName: true,
    customerName:        'Mary Anne "Mae" O\\Donnell',
  });
  assert.equal(name, 'oPXDEMO-DR2PE0-1_ODonnell_4x6 Photo Print_lustre_full-bleed');
});

test('buildFolderName preserves the p-prefix for the in-progress folder', () => {
  const name = buildFolderName('p', baseJob, null, {
    includeCustomerName: true,
    customerName:        'Richard Charnley',
  });
  assert.equal(name, 'pPXDEMO-DR2PE0-1_Charnley_4x6 Photo Print_lustre_full-bleed');
});
