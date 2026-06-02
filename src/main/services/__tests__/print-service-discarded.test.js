'use strict';

/**
 * Manual Crop redesign (2026-06-02) — operator-discarded image
 * exclusion in print-service.
 *
 * Locks the central `_findJobInManifest` filter contract: when the
 * IPC handler stamps `job._excludedFilenames` (Set<string> of bare
 * basenames) onto the job object, `_findJobInManifest` must return a
 * jobManifest whose `images` array has those entries filtered out.
 *
 * The property-stamping mechanism is load-bearing because it means
 * every dispatch pipeline (Darkroom Pro, DPOF, Fuji JobMaker,
 * Frontline, file-copy, process-folder, etc.) inherits the filter
 * via the single `_findJobInManifest` call site at the top of each
 * pipeline — no signature-change ripple through 10+ methods.
 *
 * `_copyFolder`'s exclusion is covered separately (line 2021+ of
 * print-service.js): it filters at the directory-entry level so files
 * in /working/, /originals/, and the job root all get pruned. Not
 * unit-tested here because exercising it requires a real temp folder
 * tree, which the integration tests cover indirectly.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const Module  = require('node:module');
const os      = require('node:os');
const path    = require('node:path');

// print-service → logger → electron.app. We don't care about logger
// output here; replace `electron` with a minimal fake so the require
// chain resolves without booting the runtime.
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __originalRequire.apply(this, arguments);
};

const printService = require(path.join(__dirname, '..', 'print-service.js'));

function makeManifest() {
  return {
    jobs: [{
      jobId: 42,
      images: [
        { filename: 'a.jpg', size: '4x6', quantity: 1 },
        { filename: 'b.jpg', size: '4x6', quantity: 1 },
        { filename: 'c.jpg', size: '4x6', quantity: 1 },
        { filename: 'subdir/d.jpg', size: '4x6', quantity: 1 },
      ],
    }],
  };
}

test('M6: _findJobInManifest returns full image list when no discarded set is stamped', () => {
  const manifest = makeManifest();
  const job = { id: 42 };

  const result = printService._findJobInManifest(manifest, job);
  assert.equal(result.images.length, 4);
  assert.deepEqual(
    result.images.map((i) => i.filename),
    ['a.jpg', 'b.jpg', 'c.jpg', 'subdir/d.jpg'],
  );
});

test('M6: _findJobInManifest filters discarded basenames when job._excludedFilenames is stamped', () => {
  const manifest = makeManifest();
  const job = { id: 42 };
  Object.defineProperty(job, '_excludedFilenames', {
    value:        new Set(['b.jpg', 'd.jpg']),
    enumerable:   false,
    configurable: true,
  });

  const result = printService._findJobInManifest(manifest, job);
  assert.equal(result.images.length, 2,
    'b.jpg and d.jpg (matched via basename of "subdir/d.jpg") must be excluded');
  assert.deepEqual(
    result.images.map((i) => i.filename),
    ['a.jpg', 'c.jpg'],
  );
});

test('M6: _findJobInManifest with empty exclusion set is a no-op (defensive)', () => {
  const manifest = makeManifest();
  const job = { id: 42 };
  Object.defineProperty(job, '_excludedFilenames', {
    value:        new Set(),
    enumerable:   false,
    configurable: true,
  });

  const result = printService._findJobInManifest(manifest, job);
  assert.equal(result.images.length, 4,
    'empty Set must not filter anything — guard avoids returning a needlessly cloned object');
});

test('M6: _findJobInManifest returns falsy job-not-found result unchanged (no crash on missing match)', () => {
  const manifest = makeManifest();
  const job = { id: 999 }; // no match in manifest
  Object.defineProperty(job, '_excludedFilenames', {
    value:        new Set(['a.jpg']),
    enumerable:   false,
    configurable: true,
  });

  const result = printService._findJobInManifest(manifest, job);
  assert.equal(result, undefined,
    'when the manifest has no matching jobId, the filter step must short-circuit; not crash on null.images');
});

test('M6: _isExcludedForDispatch helper reflects the same source of truth', () => {
  const job = { id: 42 };
  assert.equal(printService._isExcludedForDispatch(job, 'a.jpg'), false,
    'no stamp = nothing excluded');
  Object.defineProperty(job, '_excludedFilenames', {
    value:        new Set(['x.jpg', 'y.jpg']),
    enumerable:   false,
    configurable: true,
  });
  assert.equal(printService._isExcludedForDispatch(job, 'x.jpg'), true);
  assert.equal(printService._isExcludedForDispatch(job, 'z.jpg'), false);
});
