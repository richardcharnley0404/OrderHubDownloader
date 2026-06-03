/**
 * Unit tests for src/shared/jobSchema.js
 *
 * Focus of this file: the Customer Originals schema bump — verify that
 * createImageEntry defaults originalFilename / recropPath / recropOf /
 * recroppedAt to null, and that an explicitly supplied originalFilename
 * round-trips. The pre-existing fields (qty, corrections, enhancement
 * block, aiQuality, integritySuspect) are not exhaustively re-tested
 * here — the contract for those is already exercised by the consumers
 * (sidecarManager, enhancementManager).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createImageEntry, resetImageEntry } = require('../jobSchema.js');

test('createImageEntry defaults originalFilename + recrop* fields to null', () => {
  const e = createImageEntry('IMG_001.jpg');
  assert.equal(e.originalFilename, null);
  assert.equal(e.recropPath,       null);
  assert.equal(e.recropOf,         null);
  assert.equal(e.recroppedAt,      null);
});

test('createImageEntry stores a supplied originalFilename verbatim (manifest-relative path)', () => {
  const rel = 'PXDEMO-AD31D5_38432891/original-files/1-IMG-20240602-WA0013b.jpg';
  const e = createImageEntry('PXDEMO-AD31D5_38432891_IMG-….jpeg', 2, rel);
  assert.equal(e.originalFilename, rel);
  assert.equal(e.qtyOriginal, 2);
  assert.equal(e.qtyCurrent,  2);
});

test("createImageEntry coerces falsy originalFilename ('', null, undefined) to null", () => {
  assert.equal(createImageEntry('a.jpg', 1, '').originalFilename,        null);
  assert.equal(createImageEntry('a.jpg', 1, null).originalFilename,      null);
  assert.equal(createImageEntry('a.jpg', 1, undefined).originalFilename, null);
});

test('createImageEntry rejects empty filename (pre-existing contract)', () => {
  assert.throws(() => createImageEntry(''),       /non-empty string/);
  assert.throws(() => createImageEntry(null),     /non-empty string/);
  assert.throws(() => createImageEntry(undefined),/non-empty string/);
});

test('resetImageEntry preserves originalFilename + recrop* (reset must not orphan the link)', () => {
  const e = createImageEntry('a.jpg', 1, 'PXDEMO/original-files/1-a.jpg');
  // Mutate a few operator-mutable fields so the reset has work to do.
  e.qtyCurrent = 7;
  e.corrections.cyan = 5;
  e.reprint = true;
  // Pretend a Phase-2 re-crop has already landed on this entry; reset must
  // not erase the link back to the original or the audit fields.
  e.recropPath  = 'C:\\jobs\\PXDEMO\\recrops\\1-a_20260515.jpeg';
  e.recropOf    = '1-a.jpg';
  e.recroppedAt = '2026-05-15T08:35:00.000Z';

  const r = resetImageEntry(e);
  assert.equal(r.qtyCurrent, 1, 'qtyCurrent reset to original');
  assert.equal(r.corrections.cyan, 0, 'corrections cleared');
  assert.equal(r.reprint, false, 'reprint cleared');
  // The link to the customer original must survive a reset.
  assert.equal(r.originalFilename, 'PXDEMO/original-files/1-a.jpg');
  // Phase 2 fields must survive too — once we've produced a re-crop, a
  // reset of corrections must not throw away the re-crop metadata.
  assert.equal(r.recropPath,  'C:\\jobs\\PXDEMO\\recrops\\1-a_20260515.jpeg');
  assert.equal(r.recropOf,    '1-a.jpg');
  assert.equal(r.recroppedAt, '2026-05-15T08:35:00.000Z');
});

// ── M3 (2026-05-24): per-file copies multiplier ─────────────────────────────

test('createImageEntry: copies passed in s3Fields persists verbatim', () => {
  const e = createImageEntry('m3.jpg', 6, null, {
    artworkFileId: 'abc',
    artworkSource: 'manual',
    artworkType:   'optimized',
    productionReady: true,
    originalFileName: 'm3.jpg',
    copies: 3,
  });
  assert.equal(e.copies, 3, 'copies stored verbatim from the API for "×N copies" renderer chip');
  // qtyOriginal is passed in separately by the caller (the downloader
  // does jobQty × copies); the schema doesn't compute it from copies.
  assert.equal(e.qtyOriginal, 6);
  assert.equal(e.qtyCurrent,  6);
});

test('createImageEntry: copies absent / s3Fields=null → copies defaults to null (legacy round-trip)', () => {
  // FTP-delivered entries and any pre-M3 sidecar arrive without copies.
  // Default null suppresses the "×N copies" renderer chip and distinguishes
  // "no S3 metadata" from "explicit copies=1".
  const eNoFields  = createImageEntry('a.jpg', 1);
  const eEmpty     = createImageEntry('b.jpg', 1, null, {});
  const eNoCopies  = createImageEntry('c.jpg', 1, null, { artworkFileId: 'x' }); // partial s3Fields
  const eBadCopies = createImageEntry('d.jpg', 1, null, { copies: 0 });           // ≤0 rejected
  const eNaNCopies = createImageEntry('e.jpg', 1, null, { copies: 'lots' });      // non-finite rejected
  assert.equal(eNoFields.copies,  null);
  assert.equal(eEmpty.copies,     null);
  assert.equal(eNoCopies.copies,  null);
  assert.equal(eBadCopies.copies, null, 'copies=0 not a valid multiplier — falls through to null');
  assert.equal(eNaNCopies.copies, null);
});
