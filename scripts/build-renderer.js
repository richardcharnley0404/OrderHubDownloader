/**
 * scripts/build-renderer.js
 *
 * Bundles the Job Review Panel React components into a single JS file
 * that is loaded by the Electron renderer alongside the existing vanilla
 * renderer.js.
 *
 * Usage:
 *   node scripts/build-renderer.js           — one-shot production build
 *   node scripts/build-renderer.js --watch   — rebuild on file changes (dev)
 */

'use strict';

const esbuild = require('esbuild');
const path    = require('path');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: [
    path.join(__dirname, '../src/renderer/views/JobReview/mount.jsx'),
  ],
  bundle:   true,
  outfile:  path.join(__dirname, '../src/renderer/job-review.bundle.js'),
  platform: 'browser',
  target:   ['chrome120'],   // Electron 32 ships Chromium ~128, 120 is safe
  format:   'iife',
  globalName: 'OHDJobReview', // not really used but keeps the IIFE tidy
  external: [],               // React is bundled in (not available via require in renderer)
  sourcemap: !isWatch ? false : 'inline',
  minify:   !isWatch,
  logLevel: 'info',
  jsx:      'automatic',     // uses the React 18 automatic JSX transform (no import needed)
};

(async () => {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('esbuild: watching for changes…');
  } else {
    await esbuild.build(buildOptions);
    console.log('esbuild: Job Review Panel bundle built successfully.');
  }
})();
