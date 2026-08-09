'use strict';

/**
 * src/shared/batchSplit.js
 *
 * Pure batch-splitting for the Darkroom Pro maxPrintsPerJob cap.
 * Kept Electron-free so both the main-process dispatch method and
 * the node:test suite can load it directly (see the five test globs
 * in package.json — src/shared/__tests__/*.test.js is one of them).
 *
 * The cap counts PRINTS, not images: `image.quantity` is the per-image
 * copy count. A batch is one Darkroom Pro `.txt` file; the operator
 * schedules and reorders those files inside Darkroom Pro's own queue
 * after OHD dispatches them. See docs/batch-splitting-feasibility.md §2
 * for the "prints vs images" derivation.
 *
 * This module deliberately has no I/O and no logging — the caller is
 * responsible for surfacing oversized-batch warnings (M4's dispatch
 * method). Use `batchPrintCount(batch) > cap` to detect the case.
 */

/**
 * Read an image's per-image copy count. Anything non-finite or
 * non-positive is treated as 1 — matches the "default 1 when absent"
 * rule in the feasibility doc. Callers are responsible for filtering
 * discarded images out before calling; a stray 0 or negative quantity
 * here is treated as a defensive default, not a signal to skip.
 *
 * @param {*} image
 * @returns {number} positive integer count of prints for this image
 */
function readQuantity(image) {
  if (image && Number.isFinite(image.quantity) && image.quantity > 0) {
    return image.quantity;
  }
  return 1;
}

/**
 * Total print count for a batch — sum of per-image quantities.
 * Exported so M4 can detect over-cap batches (a single image whose
 * copies exceed the cap gets its own oversized batch by design;
 * see splitIntoBatches).
 *
 * @param {Array<{quantity:number}>} images
 * @returns {number}
 */
function batchPrintCount(images) {
  if (!Array.isArray(images) || images.length === 0) return 0;
  let total = 0;
  for (const img of images) total += readQuantity(img);
  return total;
}

/**
 * Split a list of images into batches whose per-batch print count
 * does not exceed `maxPrints`, EXCEPT for a single image whose own
 * copies already exceed the cap — that image gets its own oversized
 * batch. Copies of a single image are never split across batches:
 * splitting them would reorder prints on the printer, which is
 * exactly what the operator gets after dispatch to reorder in the
 * controller's queue.
 *
 * Contract:
 *   - `maxPrints` null / 0 / negative / non-finite → return one batch
 *     containing all the images (unchanged behaviour = feature off).
 *   - Empty input → `[]`.
 *   - Input is never mutated. The single-batch return copies the
 *     input so callers cannot accidentally mutate the source array.
 *   - Input order is preserved. No sorting, no grouping.
 *
 * @param {Array<{quantity?:number}>} images  already filtered + ordered
 * @param {number|null|undefined} maxPrints   null/0/negative/non-finite = no cap
 * @returns {Array<Array<object>>}            [[...], [...]] — one array per batch
 */
function splitIntoBatches(images, maxPrints) {
  if (!Array.isArray(images) || images.length === 0) return [];

  const capValid = Number.isFinite(maxPrints) && maxPrints > 0;
  if (!capValid) return [images.slice()];

  const batches = [];
  let current      = [];
  let currentTotal = 0;

  for (const img of images) {
    const q = readQuantity(img);
    // Only start a new batch when the CURRENT batch already has content.
    // Otherwise an oversized single image (qty > cap) would trigger an
    // empty batch followed by a batch containing just itself; the guard
    // yields a single oversized batch instead — which is the intended
    // "don't split an image's copies" behaviour.
    if (current.length > 0 && currentTotal + q > maxPrints) {
      batches.push(current);
      current      = [];
      currentTotal = 0;
    }
    current.push(img);
    currentTotal += q;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

module.exports = { splitIntoBatches, batchPrintCount };
