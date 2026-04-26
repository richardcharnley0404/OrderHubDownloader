/**
 * scripts/build-renderer.js
 *
 * Bundles the React views (Job Review Panel + Film Review Panel) into
 * per-view IIFE bundles that are loaded by the Electron renderer alongside
 * the existing vanilla renderer.js.
 *
 * Each bundle has its own mount.jsx entry point and writes to a sibling
 * .bundle.js file; they share node_modules (React etc.) but esbuild
 * inlines React into each IIFE so they don't need a shared runtime.
 *
 * Usage:
 *   node scripts/build-renderer.js           — one-shot production build
 *   node scripts/build-renderer.js --watch   — rebuild on file changes (dev)
 */

'use strict';

const esbuild = require('esbuild');
const path    = require('path');

const isWatch = process.argv.includes('--watch');

// Shared esbuild options — only entry point / outfile / globalName differ
// between bundles. Keeping these defined in one place means new views get
// added by pushing another entry to `bundles` below.
const sharedOptions = {
  bundle:   true,
  platform: 'browser',
  target:   ['chrome120'],   // Electron 32 ships Chromium ~128, 120 is safe
  format:   'iife',
  external: [],               // React is bundled in (not available via require in renderer)
  sourcemap: !isWatch ? false : 'inline',
  minify:   !isWatch,
  logLevel: 'info',
  jsx:      'automatic',     // React 18 automatic JSX transform (no import needed)
};

const bundles = [
  {
    label:      'Job Review Panel',
    entry:      path.join(__dirname, '../src/renderer/views/JobReview/mount.jsx'),
    outfile:    path.join(__dirname, '../src/renderer/job-review.bundle.js'),
    globalName: 'OHDJobReview',
  },
  {
    label:      'Film Review Panel',
    entry:      path.join(__dirname, '../src/renderer/views/FilmReview/mount.jsx'),
    outfile:    path.join(__dirname, '../src/renderer/film-review.bundle.js'),
    globalName: 'OHDFilmReview',
  },
];

function buildOptionsFor(b) {
  return {
    ...sharedOptions,
    entryPoints: [b.entry],
    outfile:     b.outfile,
    globalName:  b.globalName,
  };
}

(async () => {
  if (isWatch) {
    for (const b of bundles) {
      const ctx = await esbuild.context(buildOptionsFor(b));
      await ctx.watch();
      console.log(`esbuild: watching ${b.label} for changes...`);
    }
  } else {
    for (const b of bundles) {
      await esbuild.build(buildOptionsFor(b));
      console.log(`esbuild: ${b.label} bundle built successfully.`);
    }
  }
})();
