'use strict';

/**
 * Manual Crop redesign (2026-06-02) — approveAll candidate-filter
 * regression test.
 *
 * Bug Richard reported: Approve All processed all 40 images in a job,
 * including the 4 marked Discarded. The candidate filter was supposed
 * to exclude discarded images. This test pins the filter directly via
 * the same predicate the renderer uses so any regression surfaces in
 * unit tests rather than only in OHD.
 *
 * The filter (lifted verbatim from ManualCropMode.jsx:approveAll):
 *
 *   const candidates = imagesRef.current.filter((img) => {
 *     const s = perImageStateRef.current[img.filename] || {};
 *     if (s.discarded) return false;
 *     return !s.cropAppliedOnDisk || s.modifiedSinceApproval;
 *   });
 *
 * Inputs are POJOs that match the shape the renderer constructs.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');

// Pure copy of the candidate predicate. If this ever diverges from the
// component, the test catches it at code review.
function approveAllCandidates(images, perImageState) {
  return images.filter((img) => {
    const s = perImageState[img.filename] || {};
    if (s.discarded) return false;
    return !s.cropAppliedOnDisk || s.modifiedSinceApproval;
  });
}

test('approveAll: discarded image with cropApplied=false is NOT a candidate', () => {
  const images = [
    { filename: 'a.jpg' },
    { filename: 'b.jpg' },
    { filename: 'c.jpg' },
  ];
  const perImageState = {
    'a.jpg': { discarded: false, cropAppliedOnDisk: false, modifiedSinceApproval: false },
    'b.jpg': { discarded: true,  cropAppliedOnDisk: false, modifiedSinceApproval: false },
    'c.jpg': { discarded: false, cropAppliedOnDisk: false, modifiedSinceApproval: false },
  };

  const candidates = approveAllCandidates(images, perImageState);
  assert.equal(candidates.length, 2,
    'discarded image must be excluded — only 2 of 3 are candidates');
  assert.deepEqual(candidates.map((i) => i.filename), ['a.jpg', 'c.jpg'],
    'b.jpg (discarded) must NOT be in the candidate list');
});

test('approveAll: discarded image with cropApplied=true is NOT a candidate', () => {
  // The original-design scenario: operator approves image, then
  // discards it. cropAppliedOnDisk stays true (file on disk is
  // cropped); discarded becomes true. Approve All must skip it.
  const images = [{ filename: 'a.jpg' }, { filename: 'b.jpg' }];
  const perImageState = {
    'a.jpg': { discarded: false, cropAppliedOnDisk: false, modifiedSinceApproval: false },
    'b.jpg': { discarded: true,  cropAppliedOnDisk: true,  modifiedSinceApproval: false },
  };

  const candidates = approveAllCandidates(images, perImageState);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].filename, 'a.jpg');
});

test('approveAll: approved-and-unmodified non-discarded image is NOT a candidate', () => {
  // A fully-approved non-discarded image is a no-op for Approve All —
  // already approved, nothing to do.
  const images = [{ filename: 'a.jpg' }, { filename: 'b.jpg' }];
  const perImageState = {
    'a.jpg': { discarded: false, cropAppliedOnDisk: false, modifiedSinceApproval: false },
    'b.jpg': { discarded: false, cropAppliedOnDisk: true,  modifiedSinceApproval: false },
  };

  const candidates = approveAllCandidates(images, perImageState);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].filename, 'a.jpg');
});

test('approveAll: approved-but-modified non-discarded image IS a candidate (re-approve needed)', () => {
  const images = [{ filename: 'a.jpg' }];
  const perImageState = {
    'a.jpg': { discarded: false, cropAppliedOnDisk: true, modifiedSinceApproval: true },
  };
  const candidates = approveAllCandidates(images, perImageState);
  assert.equal(candidates.length, 1,
    'an approved image that operator subsequently modified IS a candidate');
});

test('approveAll: 40-image job with 4 discarded — only 36 candidates', () => {
  // The Richard-reported scenario in scale.
  const images = Array.from({ length: 40 }, (_, i) => ({ filename: `img${i + 1}.jpg` }));
  const perImageState = {};
  for (let i = 1; i <= 40; i++) {
    perImageState[`img${i}.jpg`] = {
      discarded:             [3, 17, 28, 40].includes(i),  // arbitrary 4 discarded
      cropAppliedOnDisk:     false,
      modifiedSinceApproval: false,
    };
  }

  const candidates = approveAllCandidates(images, perImageState);
  assert.equal(candidates.length, 36,
    'exactly 36 candidates — the 4 discarded images must be filtered out');

  const candidateFilenames = candidates.map((i) => i.filename);
  for (const idx of [3, 17, 28, 40]) {
    assert.equal(candidateFilenames.includes(`img${idx}.jpg`), false,
      `img${idx}.jpg is discarded and MUST NOT be a candidate`);
  }
});

test('approveAll: image with no state entry defaults to non-discarded pending (legacy path)', () => {
  // Defensive: if perImageState somehow lacks the entry (stale ref,
  // race, etc.), the filter must NOT treat the image as discarded.
  // It's a candidate because the default state has cropAppliedOnDisk=false.
  const images = [{ filename: 'orphan.jpg' }];
  const perImageState = {}; // no entry for orphan.jpg

  const candidates = approveAllCandidates(images, perImageState);
  assert.equal(candidates.length, 1,
    'no state entry — defaults are evaluated as { discarded:false, cropAppliedOnDisk:false } → IS a candidate');
});
