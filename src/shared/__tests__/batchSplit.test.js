'use strict';

/**
 * Unit tests for src/shared/batchSplit.js.
 *
 * Pure derivation — no fs, no electron, no async. Covers every rule
 * in the M2 section of docs/batch-splitting-darkroom-pro-brief.md:
 *
 *   1. 600 × qty 1, cap 100 → 6 batches of 100.
 *   2. 650 × qty 1, cap 100 → 7 batches: 6 × 100 + 1 × 50.
 *   3. 600 × qty 2, cap 100 → 12 batches of 50 images (100 prints each).
 *   4. Mixed quantities pack correctly and never exceed the cap.
 *   5. One image with qty 250, cap 100 → its own oversized batch, flagged.
 *   6. `null` / `0` / `-5` / `'abc'` cap → one batch, input unchanged.
 *   7. Empty input → `[]`.
 *   8. Input array is not mutated.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitIntoBatches, batchPrintCount } = require('../batchSplit');

// Fixtures — an image is anything with a `quantity` field. The function
// preserves the whole object per batch so callers can carry filename,
// sourcePath, etc. verbatim.
function img(id, quantity = 1) {
  return { id, quantity };
}
function makeImages(n, quantity = 1) {
  return Array.from({ length: n }, (_, i) => img(`img-${i + 1}`, quantity));
}

// ── Case 1 — 600 × qty 1, cap 100 ────────────────────────────────────────────

test('600 images × qty 1, cap 100 → 6 batches of 100', () => {
  const images  = makeImages(600, 1);
  const batches = splitIntoBatches(images, 100);
  assert.equal(batches.length, 6);
  for (const b of batches) {
    assert.equal(b.length, 100);
    assert.equal(batchPrintCount(b), 100);
  }
});

// ── Case 2 — 650 × qty 1, cap 100 → 6×100 + 1×50 ─────────────────────────────

test('650 images × qty 1, cap 100 → 7 batches: 6 × 100 + 1 × 50', () => {
  const batches = splitIntoBatches(makeImages(650, 1), 100);
  assert.equal(batches.length, 7);
  for (let i = 0; i < 6; i++) assert.equal(batches[i].length, 100);
  assert.equal(batches[6].length, 50);
});

// ── Case 3 — cap counts prints, not images ───────────────────────────────────

test('600 images × qty 2, cap 100 → 12 batches of 50 images (100 prints each)', () => {
  const batches = splitIntoBatches(makeImages(600, 2), 100);
  assert.equal(batches.length, 12);
  for (const b of batches) {
    assert.equal(b.length, 50);
    assert.equal(batchPrintCount(b), 100);
  }
});

// ── Case 4 — mixed quantities pack correctly ─────────────────────────────────

test('mixed quantities pack correctly and never exceed the cap', () => {
  //  4  3  2  1  4  3  2  1  1  1  1  1  1  1  1  ...
  //  ┗━━━ 10 ━━┛ ┗━━━ 10 ━━━┛ ...  each batch = 10
  const images = [
    img('a', 4), img('b', 3), img('c', 2), img('d', 1),   // sum 10
    img('e', 4), img('f', 3), img('g', 2), img('h', 1),   // sum 10
    img('i', 6), img('j', 4),                              // sum 10
  ];
  const batches = splitIntoBatches(images, 10);
  assert.equal(batches.length, 3);
  for (const b of batches) {
    assert.ok(batchPrintCount(b) <= 10, 'no batch may exceed the cap');
  }
  assert.deepEqual(batches[0].map(i => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(batches[1].map(i => i.id), ['e', 'f', 'g', 'h']);
  assert.deepEqual(batches[2].map(i => i.id), ['i', 'j']);
});

test('mixed quantities: a new batch starts before an item that would overflow, even mid-run', () => {
  // Cap 5. Items 3, 3 — second would push total to 6, so it starts a new batch.
  const batches = splitIntoBatches([img('a', 3), img('b', 3), img('c', 3)], 5);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map(b => b.map(i => i.id)), [['a'], ['b'], ['c']]);
});

// ── Case 5 — single image whose copies exceed the cap ────────────────────────

test('single image with qty 250, cap 100 → own batch which exceeds the cap (flagged via batchPrintCount)', () => {
  const batches = splitIntoBatches([img('big', 250)], 100);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.equal(batchPrintCount(batches[0]), 250);
  // Detection contract for M4: caller uses batchPrintCount(batch) > cap.
  assert.ok(batchPrintCount(batches[0]) > 100, 'caller detects the oversized case via batchPrintCount');
});

test('oversized image sandwiched between normal images: oversized item gets its own batch, neighbours pack normally', () => {
  const images = [
    img('a', 40),   // batch 1: 40 (cap 100)
    img('b', 40),   // batch 1: 80
    img('big', 250), // would overflow → own batch (250, oversized)
    img('c', 40),    // batch 3: 40
    img('d', 40),    // batch 3: 80
    img('e', 40),    // would overflow → batch 4: 40
  ];
  const batches = splitIntoBatches(images, 100);
  assert.deepEqual(batches.map(b => b.map(i => i.id)), [
    ['a', 'b'],
    ['big'],
    ['c', 'd'],
    ['e'],
  ]);
  assert.equal(batchPrintCount(batches[1]), 250);
});

// ── Case 6 — invalid caps → one batch, input unchanged ───────────────────────

for (const bad of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'abc']) {
  test(`invalid cap (${JSON.stringify(bad)}) → single batch containing every input image, in order`, () => {
    const images = makeImages(5, 3);
    const batches = splitIntoBatches(images, bad);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 5);
    assert.deepEqual(batches[0].map(i => i.id), ['img-1', 'img-2', 'img-3', 'img-4', 'img-5']);
  });
}

// ── Case 7 — empty input → [] ────────────────────────────────────────────────

test('empty input → []', () => {
  assert.deepEqual(splitIntoBatches([], 100), []);
});

test('empty input with a no-cap value still → []', () => {
  assert.deepEqual(splitIntoBatches([], null), []);
});

test('non-array input → [] (defensive)', () => {
  assert.deepEqual(splitIntoBatches(null, 100), []);
  assert.deepEqual(splitIntoBatches(undefined, 100), []);
});

// ── Case 8 — input is not mutated ────────────────────────────────────────────

test('input array is not mutated (with a cap)', () => {
  const images = makeImages(10, 5);
  const before = images.slice();
  splitIntoBatches(images, 20);
  assert.deepEqual(images, before);
  assert.equal(images.length, 10);
});

test('input array is not mutated (no cap → returns a defensive copy, not the same reference)', () => {
  const images = makeImages(3, 1);
  const [only] = splitIntoBatches(images, null);
  assert.notEqual(only, images, 'no-cap return must be a copy so caller mutation cannot reach the input');
  assert.deepEqual(only, images, '...but the content matches');
});

test('preserves input order — never re-sorts or groups', () => {
  const images = [
    img('c', 1), img('a', 1), img('b', 1),
    img('d', 5), img('e', 1), img('f', 3),
  ];
  const batches = splitIntoBatches(images, 100);
  assert.deepEqual(batches[0].map(i => i.id), ['c', 'a', 'b', 'd', 'e', 'f']);
});

// ── Quantity default (defensive) ─────────────────────────────────────────────

test('missing / non-finite / non-positive quantity is treated as 1 (default when absent)', () => {
  const images = [
    { id: 'no-qty' },                    // undefined
    { id: 'null-qty',    quantity: null },
    { id: 'zero-qty',    quantity: 0 },
    { id: 'neg-qty',     quantity: -3 },
    { id: 'nan-qty',     quantity: Number.NaN },
    { id: 'string-qty',  quantity: '7' },
  ];
  assert.equal(batchPrintCount(images), 6, 'every non-positive-finite quantity counted as 1');
  // Cap 3 — should split after 3 defaulted images.
  const batches = splitIntoBatches(images, 3);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 3);
  assert.equal(batches[1].length, 3);
});

// ── batchPrintCount helper ───────────────────────────────────────────────────

test('batchPrintCount: empty / non-array → 0', () => {
  assert.equal(batchPrintCount([]), 0);
  assert.equal(batchPrintCount(null), 0);
  assert.equal(batchPrintCount(undefined), 0);
});

test('batchPrintCount: sums quantities correctly', () => {
  assert.equal(batchPrintCount([img('a', 2), img('b', 3), img('c', 5)]), 10);
});
