'use strict';

/**
 * src/main/jobs/imageProcessor.js
 *
 * PHASE 3 STUB — do not implement yet.
 *
 * Will apply CMY colour corrections to image files at print time.
 * Currently exports a no-op applyCorrections() so Phase 3 can add the real
 * implementation without changing import signatures anywhere in the codebase.
 */

/**
 * Apply CMY corrections to an image file.
 *
 * STUB — currently a no-op.  Phase 3 will integrate Perfectly Clear / Topaz
 * here and write the corrected image to the /working/ folder.
 *
 * @param {object} options
 * @param {string} options.inputPath   - Absolute path to the source image
 * @param {string} options.outputPath  - Absolute path for the corrected image
 * @param {object} options.corrections - { cyan: number, magenta: number, yellow: number }
 * @returns {Promise<void>}
 */
async function applyCorrections({ inputPath, outputPath, corrections }) { // eslint-disable-line no-unused-vars
  // Phase 3: implement CMY correction pipeline here.
  // For now, do nothing — the source file is used as-is at print time.
}

module.exports = {
  applyCorrections,
};
