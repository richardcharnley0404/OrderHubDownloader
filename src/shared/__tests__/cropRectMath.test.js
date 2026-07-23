'use strict';

/**
 * Unit tests for src/shared/cropRectMath.js.
 *
 * Scoped narrowly to bestFitOrientation — the decision function behind
 * Manual Crop / Job Review's per-image best-fit crop-box orientation.
 * The live path (CropEditor + ManualCropMode.approveAll) has no unit
 * harness in this repo and applyBatchCrop is currently dormant from the
 * renderer, so this file exists specifically to lock the decision.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { bestFitOrientation } = require('../cropRectMath');

test('bestFitOrientation: landscape source (w > h) → "landscape"', () => {
  assert.equal(bestFitOrientation(6000, 4000), 'landscape');
  assert.equal(bestFitOrientation(2, 1),       'landscape');
  assert.equal(bestFitOrientation(1001, 1000), 'landscape');
});

test('bestFitOrientation: portrait source (w < h) → "portrait"', () => {
  assert.equal(bestFitOrientation(4000, 6000), 'portrait');
  assert.equal(bestFitOrientation(1, 2),       'portrait');
  assert.equal(bestFitOrientation(1000, 1001), 'portrait');
});

test('bestFitOrientation: square source (w === h) → fallback', () => {
  assert.equal(bestFitOrientation(1000, 1000, 'landscape'), 'landscape');
  assert.equal(bestFitOrientation(1000, 1000, 'portrait'),  'portrait');
  // Default fallback is 'landscape'.
  assert.equal(bestFitOrientation(500, 500), 'landscape');
});

test('bestFitOrientation: invalid dims → fallback (never throws, never returns undefined)', () => {
  const cases = [
    [0, 4000],
    [4000, 0],
    [-1, 100],
    [100, -1],
    [NaN, 100],
    [100, NaN],
    [Infinity, 100],
    [100, Infinity],
    [undefined, 100],
    [100, undefined],
    [null, null],
  ];
  for (const [w, h] of cases) {
    assert.equal(bestFitOrientation(w, h, 'portrait'),  'portrait',  `[${w}, ${h}] w/ portrait fallback`);
    assert.equal(bestFitOrientation(w, h, 'landscape'), 'landscape', `[${w}, ${h}] w/ landscape fallback`);
  }
});

test('bestFitOrientation: fallback respected — square + fallback pair', () => {
  // These pairs prove the fallback branch is not silently defaulted.
  assert.equal(bestFitOrientation(500, 500, 'portrait'),  'portrait');
  assert.equal(bestFitOrientation(500, 500, 'landscape'), 'landscape');
});

test('bestFitOrientation: default fallback is "landscape" when omitted', () => {
  // Contract: signature is bestFitOrientation(w, h, fallback = 'landscape').
  // A caller that forgets to pass fallback for a square source still gets
  // a valid orientation string — never undefined.
  assert.equal(bestFitOrientation(500, 500),      'landscape');
  assert.equal(bestFitOrientation(NaN, NaN),      'landscape');
  assert.equal(bestFitOrientation(0, 0),          'landscape');
});
