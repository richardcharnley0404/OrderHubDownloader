/**
 * Unit tests for buildCopyFilenames — the pure filename planner used by
 * named Folder Copy controllers. Zero fs, so no temp dir, no stubs, and
 * portable across Linux CI and Richard's Windows box (path.extname is
 * platform-agnostic on both).
 *
 * Test order mirrors §4.5 of docs/folder-copy-filename-templates-brief.md
 * with two additions:
 *   - the 20-image collision case, asserting a non-colliding image in the
 *     same batch gets NO suffix
 *   - stats-shape and opts.now-passthrough locks per the M2 amendments
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { buildCopyFilenames, buildDestFolder } = require(
  path.join(REPO, 'src', 'main', 'services', 'folder-copy-filename.js'),
);

const FIXED_NOW = new Date(2026, 7, 17); // 2026-08-17 local

// ═════════════════════════════════════════════════════════════════════════
// §4.1 — Blank/absent template = the no-change lock. Runs first.
// ═════════════════════════════════════════════════════════════════════════

test('blank template → basenames verbatim, empty stats (the no-change lock)', () => {
  const images = [
    { sourcePath: '/x/a.jpg', filename: 'a.jpg', quantity: 1 },
    { sourcePath: '/x/b.png', filename: 'b.png', quantity: 2 },
  ];
  const out = buildCopyFilenames(images, {}, { template: '' });
  assert.deepEqual(out.files, [
    { sourcePath: '/x/a.jpg', destFilename: 'a.jpg' },
    { sourcePath: '/x/b.png', destFilename: 'b.png' },
  ]);
  assert.deepEqual(out.stats, { suffixed: 0, truncated: 0, fallbacks: [] });
});

test('template key absent → same as blank (no-change lock)', () => {
  const images = [{ sourcePath: '/x/a.jpg', filename: 'a.jpg', quantity: 1 }];
  const out = buildCopyFilenames(images, {}, {});
  assert.deepEqual(out.files, [{ sourcePath: '/x/a.jpg', destFilename: 'a.jpg' }]);
  assert.deepEqual(out.stats, { suffixed: 0, truncated: 0, fallbacks: [] });
});

test('opts entirely absent → same as blank (no-change lock)', () => {
  const images = [{ sourcePath: '/x/a.jpg', filename: 'a.jpg' }];
  const out = buildCopyFilenames(images, {});
  assert.deepEqual(out.files, [{ sourcePath: '/x/a.jpg', destFilename: 'a.jpg' }]);
});

// ═════════════════════════════════════════════════════════════════════════
// §4.2 — Extension is never template-controlled
// ═════════════════════════════════════════════════════════════════════════

test('extension always sourced from path.extname(sourcePath)', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/original.png', filename: 'original.png' }],
    { job_name: 'JOB-1' },
    { template: '{jobName}' },
  );
  assert.equal(out.files[0].destFilename, 'JOB-1.png');
});

test('template-supplied extension is stripped (no photo.jpg.jpg)', () => {
  // {filename} = "photo.jpg" — extname is .jpg, would produce "photo.jpg.jpg"
  // without the strip step. The whole reason §4.2 exists.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/photo.jpg', filename: 'photo.jpg' }],
    {},
    { template: '{filename}' },
  );
  assert.equal(out.files[0].destFilename, 'photo.jpg');
});

test('template {filename}_{quantity} yields "photo_2.jpg", preserving the quantity', () => {
  // Pre-M2-fix this asserted the WRONG output (a plain "photo.jpg" losing
  // the quantity) because _stripTemplateExt was calling path.extname on
  // the resolved value — path.extname("photo.jpg_2") returns ".jpg_2" and
  // ate everything after "photo". After M2-fix _stripSourceExt only strips
  // the literal source ext (".jpg"), leaving "photo_2" behind. Source ext
  // appends → "photo_2.jpg". This is what the brief §4.2 actually wants:
  // the ".jpg" that {filename} smuggled in gets de-duplicated so we end
  // with one trailing ".jpg" and the quantity survives verbatim.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/photo.jpg', filename: 'photo.jpg', quantity: 2 }],
    {},
    { template: '{filename}_{quantity}' },
  );
  assert.equal(out.files[0].destFilename, 'photo_2.jpg');
});

test('enhanced source with a different extension: source ext wins', () => {
  // img.sourcePath is the enhanced .jpg; img.filename retained the .png.
  // Extension MUST come from sourcePath (that is the file being copied).
  const out = buildCopyFilenames(
    [{ sourcePath: '/enhanced/photo.jpg', filename: 'photo.png' }],
    { job_name: 'JOB-1' },
    { template: '{jobName}' },
  );
  assert.equal(out.files[0].destFilename, 'JOB-1.jpg');
});

test('source with no extension → no extension appended', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/README', filename: 'README' }],
    { job_name: 'JOB-1' },
    { template: '{jobName}' },
  );
  assert.equal(out.files[0].destFilename, 'JOB-1');
});

// ═════════════════════════════════════════════════════════════════════════
// §4.3 — Sanitising
// ═════════════════════════════════════════════════════════════════════════

test('unsafe characters (" / \\ : * ? < > |) are stripped', () => {
  // Force the raw resolved value to contain every unsafe char via a job
  // field. product ends up in {product} and hits the sanitiser.
  const job = { product: 'a"b/c\\d:e*f?g<h>i|j' };
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.jpg', filename: 'one.jpg' }],
    job,
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, 'abcdefghij.jpg');
});

test('path separators cannot be injected via {product}', () => {
  // Belt-and-braces on the previous test: a template output containing "/"
  // or "\\" cannot survive into a filename. This is the concrete failure
  // mode the brief calls out — a template that could bury a file in a
  // sibling directory the operator did not intend.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.jpg', filename: 'one.jpg' }],
    { product: 'foo/bar\\baz' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, 'foobarbaz.jpg');
  assert.ok(!out.files[0].destFilename.includes('/'), 'no forward slash');
  assert.ok(!out.files[0].destFilename.includes('\\'), 'no backslash');
});

test('trailing dots and spaces are stripped (Windows would silently drop)', () => {
  // A template of "{product}." with product "foo" and source ".jpg" would
  // otherwise yield "foo..jpg" then the trailing-dot rule bites — after
  // sanitise+strip-ext we should land at "foo".
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.jpg', filename: 'one.jpg' }],
    { product: 'foo   ' },
    { template: '{product}...  ' },
  );
  assert.equal(out.files[0].destFilename, 'foo.jpg');
});

test('whitespace runs collapse to a single space, ends trimmed', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.jpg', filename: 'one.jpg' }],
    { product: '  four    x   six  ' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, 'four x six.jpg');
});

test('120-char truncation counted in stats.truncated', () => {
  const bigProduct = 'x'.repeat(300);
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.jpg', filename: 'one.jpg' }],
    { product: bigProduct },
    { template: '{product}' },
  );
  const expectedStem = 'x'.repeat(120);
  assert.equal(out.files[0].destFilename, `${expectedStem}.jpg`);
  assert.equal(out.stats.truncated, 1);
});

test('120-char cap does NOT include the extension', () => {
  // Stem is exactly 120; final filename is 120 + len(".jpg") = 124.
  const stem = 'a'.repeat(120);
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.jpg', filename: 'one.jpg' }],
    { product: stem },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, `${stem}.jpg`);
  assert.equal(out.stats.truncated, 0);
});

test('empty resolution → falls back to original basename, recorded in stats.fallbacks', () => {
  // Template resolves against a template-token that doesn't exist for this
  // image, then sanitises to empty. Fallback = img.filename verbatim.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/photo.jpg', filename: 'photo.jpg' }],
    {},                          // no options, no product
    { template: '{option:nonexistent}' },
  );
  assert.equal(out.files[0].destFilename, 'photo.jpg');
  assert.deepEqual(out.stats.fallbacks, ['photo.jpg']);
});

test('empty-after-sanitising (only unsafe chars) → fallback', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/photo.jpg', filename: 'photo.jpg' }],
    { product: '///:::' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, 'photo.jpg');
  assert.deepEqual(out.stats.fallbacks, ['photo.jpg']);
});

test('never emits a file literally named ".jpg" (brief §4.3 hard rule)', () => {
  // Literal '.jpg' template — Node's path.extname treats '.jpg' as a
  // dotfile (returns '' rather than '.jpg'), so without the leading-dot
  // sanitisation the strip-ext step would do nothing and the output would
  // be '.jpg.jpg'. Not literally '.jpg', but a hidden dotfile with a
  // bogus double extension is still pathological. The leading-dot strip
  // turns '.jpg' into 'jpg' before strip-ext, giving a saner 'jpg.jpg'.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/only-source-has-a-name.jpg', filename: 'safe.jpg' }],
    {},
    { template: '.jpg' },
  );
  assert.notEqual(out.files[0].destFilename, '.jpg',      'must not be literally ".jpg"');
  assert.notEqual(out.files[0].destFilename, '.jpg.jpg',  'must not be a dotfile double-ext');
  assert.ok(!out.files[0].destFilename.startsWith('.'),   'must not start with a dot');
});

// ═════════════════════════════════════════════════════════════════════════
// §4.4 — Collisions: within-call de-duplication only
// ═════════════════════════════════════════════════════════════════════════

test('20 identical resolutions produce 20 unique names (name.jpg .. name_20.jpg), order preserved', () => {
  // The whole reason this module exists. A template of `{product}` with 20
  // images of the same product would otherwise write the same filename 20
  // times and 19 images vanish.
  const images = Array.from({ length: 20 }, (_, i) => ({
    sourcePath: `/x/img${i + 1}.jpg`,
    filename:   `img${i + 1}.jpg`,
    quantity:   1,
  }));
  const out = buildCopyFilenames(
    images,
    { product: 'name' },
    { template: '{product}' },
  );
  const names = out.files.map(f => f.destFilename);
  assert.equal(names.length, 20);
  assert.equal(new Set(names).size, 20, 'all unique');
  assert.equal(names[0],  'name.jpg');
  assert.equal(names[1],  'name_2.jpg');
  assert.equal(names[19], 'name_20.jpg');
  // Source path order preserved — image #7's source stays paired with
  // whatever we named it, which for this template is 'name_7.jpg'.
  assert.equal(out.files[6].sourcePath,   '/x/img7.jpg');
  assert.equal(out.files[6].destFilename, 'name_7.jpg');
  assert.equal(out.stats.suffixed, 19);
});

test('mixed collide + non-collide: the non-colliding image gets NO suffix', () => {
  // Template resolves image-dependently for one image but identically for
  // the other two. The unique one MUST NOT pick up a suffix just because
  // its siblings collided — a bug that would look like "the auto-suffix
  // logic is broken" but is actually about the Set of *issued* names
  // rather than the set of *seen* names.
  const images = [
    { sourcePath: '/x/a.jpg', filename: 'a.jpg', quantity: 3 },  // → same_3
    { sourcePath: '/x/b.jpg', filename: 'b.jpg', quantity: 5 },  // → same_5
    { sourcePath: '/x/c.jpg', filename: 'c.jpg', quantity: 5 },  // → same_5 → same_5_2
  ];
  const out = buildCopyFilenames(
    images,
    { product: 'same' },
    { template: '{product}_{quantity}' },
  );
  assert.equal(out.files[0].destFilename, 'same_3.jpg');
  assert.equal(out.files[1].destFilename, 'same_5.jpg');
  assert.equal(out.files[2].destFilename, 'same_5_2.jpg');
  assert.equal(out.stats.suffixed, 1);
});

test('20-image collision + one non-colliding sibling — sibling gets NO suffix', () => {
  // Added per M2 amendment: prove the Set-of-issued-names discipline holds
  // at scale. 20 images that all resolve to the same stem plus 1 that
  // resolves independently. The independent one must land un-suffixed.
  const images = [];
  for (let i = 0; i < 20; i++) {
    images.push({ sourcePath: `/x/dup${i}.jpg`, filename: `dup${i}.jpg`, quantity: 1 });
  }
  images.push({ sourcePath: '/x/unique.jpg', filename: 'unique.jpg', quantity: 999 });

  const out = buildCopyFilenames(
    images,
    { product: 'same' },
    // Dup images resolve to same_1 (quantity=1); the last resolves to
    // same_999 (quantity=999) and does not collide with anything.
    { template: '{product}_{quantity}' },
  );

  const dupNames    = out.files.slice(0, 20).map(f => f.destFilename);
  const uniqueName  = out.files[20].destFilename;

  assert.equal(dupNames[0], 'same_1.jpg');
  assert.equal(dupNames[1], 'same_1_2.jpg');
  assert.equal(dupNames[19], 'same_1_20.jpg');
  assert.equal(new Set(dupNames).size, 20, 'all 20 collided names are unique');

  assert.equal(uniqueName, 'same_999.jpg', 'the non-colliding image did NOT pick up a suffix');
  assert.equal(out.stats.suffixed, 19);
});

test('collision de-dup does NOT touch fs (idempotence on retry)', () => {
  // Two back-to-back calls with the same inputs must produce IDENTICAL
  // filenames. This is the §4.4 idempotence contract — if we retried a
  // dispatch, the destination folder would get the same names, so a retry
  // overwrites cleanly rather than accumulating `_2` duplicates over time.
  //
  // No fs is touched (there's nothing to touch in this pure module), so
  // this test is really locking that the module has no hidden state
  // between calls. Any global mutation (a module-level Set, a cached
  // counter) would break this.
  const images = [
    { sourcePath: '/x/a.jpg', filename: 'a.jpg', quantity: 1 },
    { sourcePath: '/x/b.jpg', filename: 'b.jpg', quantity: 1 },
  ];
  const opts = { template: '{product}_{quantity}' };
  const job  = { product: 'same' };
  const first  = buildCopyFilenames(images, job, opts);
  const second = buildCopyFilenames(images, job, opts);
  assert.deepEqual(first, second);
});

test('collision cap: throws (with template in message) when exhausted', () => {
  // Pre-seed the issued-set indirectly by making 999 unavoidable collisions
  // via manufactured images. The 1000th same-stem image should throw.
  //
  // Faster than actually generating 1000 identical images: use a template
  // that resolves to a fixed string. The suffix goes _2 through _999
  // (cap). The 1001st image (1 base + 999 suffixed) would be #1001 with no
  // slot — throws.
  const images = Array.from({ length: 1001 }, (_, i) => ({
    sourcePath: `/x/img${i}.jpg`,
    filename:   `img${i}.jpg`,
  }));
  assert.throws(
    () => buildCopyFilenames(images, {}, { template: 'name' }),
    /exceeded 999 suffix attempts/,
  );
});

test('suffix insertion respects extension boundary (no ext → suffix at end)', () => {
  // If source has no extension the suffix still lands at end (there's
  // nothing to insert before).
  const images = [
    { sourcePath: '/x/one', filename: 'one' },
    { sourcePath: '/x/two', filename: 'two' },
  ];
  const out = buildCopyFilenames(
    images,
    { product: 'same' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, 'same');
  assert.equal(out.files[1].destFilename, 'same_2');
});

// ═════════════════════════════════════════════════════════════════════════
// M2 amendments — return shape, opts.now passthrough, M2-owned index ctx
// ═════════════════════════════════════════════════════════════════════════

test('M2 return shape: { files, stats } with three stats fields', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/a.jpg', filename: 'a.jpg' }],
    {},
    { template: '{jobName}' },
  );
  assert.ok(Array.isArray(out.files));
  assert.equal(typeof out.stats, 'object');
  // Three fields exactly — no extras that would encourage callers to
  // depend on undocumented shape.
  assert.deepEqual(Object.keys(out.stats).sort(), ['fallbacks', 'suffixed', 'truncated']);
  assert.ok(Array.isArray(out.stats.fallbacks));
  assert.equal(typeof out.stats.suffixed,  'number');
  assert.equal(typeof out.stats.truncated, 'number');
});

test('M2 files entries have exactly sourcePath and destFilename', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/a.jpg', filename: 'a.jpg', quantity: 1 }],
    {},
    { template: '{jobName}' },
  );
  const entry = out.files[0];
  assert.deepEqual(Object.keys(entry).sort(), ['destFilename', 'sourcePath']);
});

test('M2 opts.now passthrough: {date} resolves deterministically under injected clock', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/a.jpg', filename: 'a.jpg' }],
    {},
    { template: '{date}', now: FIXED_NOW },
  );
  assert.equal(out.files[0].destFilename, '2026-08-17.jpg');
});

test('M2 opts.now type mismatch propagates the resolveTemplate throw', () => {
  // The whole point of the M1a hardening. A string that has been through
  // config or JSON gets caught here rather than silently falling back to
  // the wall clock and producing today's date in place of the intended one.
  assert.throws(
    () => buildCopyFilenames(
      [{ sourcePath: '/x/a.jpg', filename: 'a.jpg' }],
      {},
      { template: '{date}', now: '2026-08-17' },
    ),
    /opts\.now must be a valid Date/,
  );
});

test('M2 index context is OWNED here — caller-supplied index is ignored', () => {
  // The caller shape declared in the amendment is
  // { sourcePath, filename, quantity } — index/imageCount are not on it.
  // Even if a well-meaning caller passes an index, the module owns the
  // loop and sets its own so the numbering can never disagree with the
  // array's actual order.
  const images = [
    { sourcePath: '/x/a.jpg', filename: 'a.jpg', index: 999 },
    { sourcePath: '/x/b.jpg', filename: 'b.jpg', index: 999 },
  ];
  const out = buildCopyFilenames(
    images,
    {},
    { template: 'img-{indexPadded}' },
  );
  // imageCount = 2 → width = 1 → '1'/'2', not padded to '999'
  assert.equal(out.files[0].destFilename, 'img-1.jpg');
  assert.equal(out.files[1].destFilename, 'img-2.jpg');
});

test('M2 {indexPadded} width comes from images.length automatically', () => {
  const images = Array.from({ length: 100 }, (_, i) => ({
    sourcePath: `/x/${i}.jpg`,
    filename:   `${i}.jpg`,
  }));
  const out = buildCopyFilenames(
    images,
    {},
    { template: 'p{indexPadded}' },
  );
  assert.equal(out.files[0].destFilename,  'p001.jpg');
  assert.equal(out.files[9].destFilename,  'p010.jpg');
  assert.equal(out.files[99].destFilename, 'p100.jpg');
});

test('M2 per-image {quantity} threads through from the caller', () => {
  const out = buildCopyFilenames(
    [
      { sourcePath: '/x/a.jpg', filename: 'a.jpg', quantity: 2 },
      { sourcePath: '/x/b.jpg', filename: 'b.jpg', quantity: 7 },
    ],
    { product: 'p' },
    { template: '{product}-x{quantity}' },
  );
  assert.equal(out.files[0].destFilename, 'p-x2.jpg');
  assert.equal(out.files[1].destFilename, 'p-x7.jpg');
});

test('M2 stripPrefixes passes through to resolveTemplate (M7: array)', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/a.jpg', filename: 'a.jpg' }],
    { order_number: 'PXDEMO-091YEC', job_name: 'PXDEMO-091YEC-1' },
    { template: '{orderNumber}_{jobName}', stripPrefixes: ['PXDEMO-'] },
  );
  assert.equal(out.files[0].destFilename, '091YEC_091YEC-1.jpg');
});
test('M7 buildCopyFilenames: multi-prefix, longest-match-first via resolveTemplate', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/a.jpg', filename: 'a.jpg' }],
    { order_number: 'PXDEMO1-091YEC', job_name: 'PXDEMO1-091YEC-1' },
    { template: '{orderNumber}_{jobName}', stripPrefixes: ['PXDEMO', 'PXDEMO1'] },
  );
  // 'PXDEMO1' wins over 'PXDEMO' because it's longer.
  assert.equal(out.files[0].destFilename, '091YEC_091YEC-1.jpg');
});

// ═════════════════════════════════════════════════════════════════════════
// Argument validation
// ═════════════════════════════════════════════════════════════════════════

test('non-array images throws (defensive)', () => {
  assert.throws(
    () => buildCopyFilenames(null, {}, {}),
    /images must be an array/,
  );
  assert.throws(
    () => buildCopyFilenames({}, {}, {}),
    /images must be an array/,
  );
});

test('empty images array → empty files, empty stats (well-defined)', () => {
  const out = buildCopyFilenames([], {}, { template: '{product}' });
  assert.deepEqual(out.files, []);
  assert.deepEqual(out.stats, { suffixed: 0, truncated: 0, fallbacks: [] });
});

// ═════════════════════════════════════════════════════════════════════════
// M2-fix — extension stripping uses the KNOWN source ext, never path.extname
//
// The initial M2 shipped a bug: _stripTemplateExt called path.extname on
// the RESOLVED template output. path.extname finds the last dot in the
// last path segment, so any token value containing an embedded dot got
// truncated there — {product} = "8.5x11 Canvas" with source ".tif" would
// silently produce "8.tif", losing the entire product name. Decimal sizes
// (8.5x11, 11x8.5, 1.5in) are normal in Wide Format, the primary use case
// for this feature, so the bug would hit real dispatches on day one.
//
// _nextSuffixed had the same flaw for the fallback path — a dotted
// no-extension name like "8.5x11 Canvas" would suffix mid-name at the
// first dot ("8_2.5x11 Canvas") because it re-derived the ext via
// path.extname rather than using the known source ext.
//
// The fix: _stripSourceExt(s, sourceExt) removes case-insensitive
// occurrences of the LITERAL source ext, then the caller appends
// sourceExt once. _nextSuffixed takes sourceExt explicitly and inserts
// _N before it when present, appends at end otherwise.
//
// path.extname now appears exactly once in the module — on img.sourcePath,
// its correct anchor.
// ═════════════════════════════════════════════════════════════════════════

// The seven exact cases from the fix directive, run as one table so a
// regression shows which specific input diverges.
const STRIP_SOURCE_EXT_CASES = [
  // Resolved                            sourceExt   expected destFilename
  { tpl: 'photo.jpg',                    src: '.jpg', exp: 'photo.jpg' },
  { tpl: 'photo.jpg.jpg',                src: '.jpg', exp: 'photo.jpg' },
  { tpl: 'photo.jpg_2',                  src: '.jpg', exp: 'photo_2.jpg' },
  { tpl: 'my.photo.final.jpg',           src: '.jpg', exp: 'my.photo.final.jpg' },
  { tpl: '8.5x11 Canvas',                src: '.tif', exp: '8.5x11 Canvas.tif' },
  { tpl: '12x18 Canvas 1.5in',           src: '.tif', exp: '12x18 Canvas 1.5in.tif' },
  { tpl: 'Jpg Print',                    src: '.jpg', exp: 'Jpg Print.jpg' },
];

for (const c of STRIP_SOURCE_EXT_CASES) {
  test(`M2-fix strip-source-ext: "${c.tpl}" + src "${c.src}" → "${c.exp}"`, () => {
    // Drive the whole pipeline via a literal-template with no tokens so
    // the resolved value is exactly `c.tpl` — this isolates strip-source-ext
    // behaviour from the token resolver's own quirks.
    const out = buildCopyFilenames(
      [{ sourcePath: `/x/source${c.src}`, filename: `source${c.src}` }],
      {},
      { template: c.tpl },
    );
    assert.equal(out.files[0].destFilename, c.exp);
  });
}

test('M2-fix strip-source-ext: case-insensitive on the source ext match', () => {
  // Resolved "PHOTO.JPG", source ".jpg" — strip case-insensitively, then
  // append the source ext as-cased. Symmetric: resolved "photo.jpg",
  // source ".JPG" strips the ".jpg" and appends ".JPG".
  const outA = buildCopyFilenames(
    [{ sourcePath: '/x/one.jpg', filename: 'one.jpg' }],
    {},
    { template: 'PHOTO.JPG' },
  );
  assert.equal(outA.files[0].destFilename, 'PHOTO.jpg');

  const outB = buildCopyFilenames(
    [{ sourcePath: '/x/one.JPG', filename: 'one.JPG' }],
    {},
    { template: 'photo.jpg' },
  );
  assert.equal(outB.files[0].destFilename, 'photo.JPG');
});

test('M2-fix strip-source-ext: source with no extension leaves value alone', () => {
  // sourceExt "" → early return; nothing stripped, nothing appended.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/README', filename: 'README' }],
    {},
    { template: '8.5x11 Canvas' },
  );
  assert.equal(out.files[0].destFilename, '8.5x11 Canvas');
});

test('M2-fix strip-source-ext: does NOT truncate embedded dots (the regression)', () => {
  // The bug being fixed: {product} = "8.5x11 Canvas" with source ".tif"
  // used to yield "8.tif" via path.extname eating ".5x11 Canvas". Explicit
  // negative assertion so a future maintainer sees the exact failure the
  // regression created, not just the correct value.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/original.tif', filename: 'original.tif' }],
    { product: '8.5x11 Canvas' },
    { template: '{product}' },
  );
  assert.notEqual(out.files[0].destFilename, '8.tif',
    'regression: path.extname on resolved value ate the product name');
  assert.equal(out.files[0].destFilename, '8.5x11 Canvas.tif');
});

// ── Embedded-dot coverage across the rest of the suite ──────────────────
// The gap that let the M2 bug through was that no test used a resolved
// value with an embedded dot. These cover sanitisation, 120-char cap,
// collision, and fallback — every path.extname-touching site.

test('M2-fix sanitise: decimal size with an unsafe char survives correctly', () => {
  // Product contains "/" (unsafe) alongside decimal dots. UNSAFE_CHARS
  // strips the slash; the dots are preserved (they are safe on Windows
  // when not leading/trailing).
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.tif', filename: 'one.tif' }],
    { product: '8.5x11/Canvas' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, '8.5x11Canvas.tif');
});

test('M2-fix sanitise: decimal size with runs of whitespace collapses cleanly', () => {
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.tif', filename: 'one.tif' }],
    { product: '  8.5x11    Canvas  ' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, '8.5x11 Canvas.tif');
});

test('M2-fix truncation: 120-char cap on a decimal-dot stem preserves the dot', () => {
  // Build a stem containing legitimate dots that runs past 120 chars.
  // The cap should slice at exactly char 120 without any dot-based
  // truncation shenanigans.
  const stem = '8.5x11 Canvas ' + 'x'.repeat(200);  // >> 120 chars, has a dot
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/one.tif', filename: 'one.tif' }],
    { product: stem },
    { template: '{product}' },
  );
  const truncated = stem.slice(0, 120);
  assert.equal(out.files[0].destFilename, `${truncated}.tif`);
  assert.equal(out.files[0].destFilename.length, 120 + '.tif'.length);
  assert.equal(out.stats.truncated, 1);
  // Sanity: the truncated stem STILL contains the decimal dot — proves
  // truncation didn't happen at the first dot.
  assert.ok(truncated.startsWith('8.5x11'), 'dot preserved through truncation');
});

test('M2-fix collision: templated decimal-size product suffixes at correct spot', () => {
  // Three images with the same product-name template → suffix inserted
  // BEFORE the source ext, not mid-name at the decimal dot.
  const images = Array.from({ length: 3 }, (_, i) => ({
    sourcePath: `/x/img${i}.tif`,
    filename:   `img${i}.tif`,
  }));
  const out = buildCopyFilenames(
    images,
    { product: '8.5x11 Canvas' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, '8.5x11 Canvas.tif');
  assert.equal(out.files[1].destFilename, '8.5x11 Canvas_2.tif');
  assert.equal(out.files[2].destFilename, '8.5x11 Canvas_3.tif');
  // Explicit negative: no image gets a suffix inserted mid-name.
  for (const f of out.files) {
    assert.ok(!/^8_\d+\.5x11/.test(f.destFilename),
      `regression: suffix inserted at first dot: ${f.destFilename}`);
  }
});

test('M2-fix fallback + collision: dotted no-ext filename suffixes at end, not mid-name', () => {
  // The exact scenario from the fix directive. Real source paths (with
  // proper .jpg extensions — the trusted upstream contract) but
  // img.filename is a bare dotted product-code shape with no extension of
  // its own. Fallback kicks in (template resolves empty), so
  // destFilename = img.filename = "8.5x11 Canvas". Collision on image 2
  // must land the suffix at the END, not mid-name at the first dot.
  //
  // Pre-fix, _nextSuffixed called path.extname("8.5x11 Canvas") →
  // ".5x11 Canvas" and produced "8_2.5x11 Canvas". After the fix the
  // known sourceExt (".jpg") is passed in; "8.5x11 Canvas" does not end
  // in ".jpg" case-insensitively, so the suffix appends at the end.
  const images = [
    { sourcePath: '/x/actual-file-1.jpg', filename: '8.5x11 Canvas' },
    { sourcePath: '/x/actual-file-2.jpg', filename: '8.5x11 Canvas' },
  ];
  const out = buildCopyFilenames(
    images,
    {},                                         // no data for the template
    { template: '{option:nonexistent}' },       // resolves empty → fallback
  );
  assert.equal(out.files[0].destFilename, '8.5x11 Canvas');
  assert.equal(out.files[1].destFilename, '8.5x11 Canvas_2',
    'fallback suffix must land at the END for a name that does not end in sourceExt');
  // Explicit negative on the exact regression string:
  assert.notEqual(out.files[1].destFilename, '8_2.5x11 Canvas',
    'regression: path.extname on the fallback name inserted _2 mid-name');
  assert.deepEqual(out.stats.fallbacks, ['8.5x11 Canvas', '8.5x11 Canvas']);
  assert.equal(out.stats.suffixed, 1);
});

test('M2-fix contract lock: img.sourcePath is the one trusted extension anchor', () => {
  // The module has ONE path.extname call — on img.sourcePath. Node's
  // path.extname returns "whatever comes after the last dot in the last
  // segment" and is not aware of what a real file extension looks like.
  // Production sourcePaths always come from the download directory or an
  // enhanced-image path, both of which carry real image extensions
  // (.jpg/.png/.tif). Constructing a pathological sourcePath in a test
  // fixture produces a pathological extension — that is Node's contract,
  // not ours to second-guess. This test documents the boundary so a
  // future maintainer understands why we don't defensively sniff.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/8.5x11 Canvas', filename: 'x' }],
    { product: 'anything' },
    { template: '{product}' },
  );
  // path.extname('/x/8.5x11 Canvas') === '.5x11 Canvas' → strip from
  // "anything" (no match) → append '.5x11 Canvas'. Documented behaviour.
  assert.equal(out.files[0].destFilename, 'anything.5x11 Canvas');
});

test('M2-fix fallback + collision: dotted filename with matching source ext inserts _N before ext', () => {
  // Complement to the previous test. Fallback = "8.5x11.jpg", sourceExt =
  // ".jpg" — the fallback ends in the source ext, so _N inserts BEFORE the
  // ext (not at the end).
  const images = [
    { sourcePath: '/x/8.5x11.jpg', filename: '8.5x11.jpg' },
    { sourcePath: '/x/8.5x11.jpg', filename: '8.5x11.jpg' },
  ];
  const out = buildCopyFilenames(
    images,
    {},
    { template: '{option:nonexistent}' },
  );
  assert.equal(out.files[0].destFilename, '8.5x11.jpg');
  assert.equal(out.files[1].destFilename, '8.5x11_2.jpg');
});

test('M2-fix fallback + collision: case preservation when tail matches case-insensitively', () => {
  // sourceExt = ".jpg" but filename ends in ".JPG" — the tail-match is
  // case-insensitive so we insert before ".JPG", preserving the original
  // capitalisation.
  const images = [
    { sourcePath: '/x/PHOTO.JPG', filename: 'PHOTO.JPG' },
    { sourcePath: '/x/PHOTO.JPG', filename: 'PHOTO.JPG' },
  ];
  const out = buildCopyFilenames(
    images,
    {},
    { template: '{option:nonexistent}' },
  );
  assert.equal(out.files[0].destFilename, 'PHOTO.JPG');
  assert.equal(out.files[1].destFilename, 'PHOTO_2.JPG');
});

// ═════════════════════════════════════════════════════════════════════════
// M2b — Win32 reserved device names guarded on the stem
// ═════════════════════════════════════════════════════════════════════════
//
// CON/PRN/AUX/NUL/COM1-9/LPT1-9 are refused by Win32 regardless of
// extension, so a resolved stem that matches must be prefixed with an
// underscore before dispatch. Applies to the templated path only; the
// fallback path uses img.filename verbatim by design.

const WIN32_RESERVED_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

for (const reserved of WIN32_RESERVED_NAMES) {
  test(`M2b Win32 reserved: stem "${reserved}" gets underscore prefix (with source ext)`, () => {
    const out = buildCopyFilenames(
      [{ sourcePath: '/x/source.jpg', filename: 'source.jpg' }],
      { product: reserved },
      { template: '{product}' },
    );
    assert.equal(out.files[0].destFilename, `_${reserved}.jpg`);
  });
}

test('M2b Win32 reserved: guard triggers WITHOUT a source extension', () => {
  // sourceExt is empty → the appended extension is empty. Guard still
  // fires because the STEM is a reserved name — Win32 refuses "CON"
  // just as flatly as "CON.jpg".
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/no-extension-here', filename: 'no-extension-here' }],
    { product: 'CON' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, '_CON');
});

test('M2b Win32 reserved: case-insensitive on the match, but original case preserved', () => {
  // Regex is /i so "con" / "Con" / "CON" all match. The template output
  // preserves whatever casing the operator's data had — we only prefix.
  for (const casing of ['con', 'Con', 'CoN', 'CON']) {
    const out = buildCopyFilenames(
      [{ sourcePath: '/x/source.jpg', filename: 'source.jpg' }],
      { product: casing },
      { template: '{product}' },
    );
    assert.equal(out.files[0].destFilename, `_${casing}.jpg`);
  }
});

test('M2b Win32 reserved: names starting with a reserved prefix are NOT guarded', () => {
  // "CONstruction" starts with "CON" but is not the reserved name. The
  // regex is anchored on both ends so partial matches don't trigger.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/source.jpg', filename: 'source.jpg' }],
    { product: 'CONstruction' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, 'CONstruction.jpg');
});

test('M2b Win32 reserved: COM0/LPT0 and COM10+ are NOT reserved by this guard', () => {
  // Per the M2b spec: COM1-COM9 and LPT1-LPT9 only. Node's own docs and
  // Microsoft's list historically treat "COM0"/"LPT0" as unreserved on
  // most Windows versions, and multi-digit COM/LPT are outside the
  // legacy set. Locking the boundary so a future maintainer doesn't
  // silently widen it.
  for (const nonReserved of ['COM0', 'LPT0', 'COM10', 'LPT10', 'COM']) {
    const out = buildCopyFilenames(
      [{ sourcePath: '/x/source.jpg', filename: 'source.jpg' }],
      { product: nonReserved },
      { template: '{product}' },
    );
    assert.equal(out.files[0].destFilename, `${nonReserved}.jpg`,
      `${nonReserved} should not be guarded`);
  }
});

test('M2b Win32 reserved: guard composes with collision de-dup', () => {
  // Two images resolving to the same reserved-name stem: first becomes
  // "_CON.jpg", second collides (issued set already has "_CON.jpg") and
  // _nextSuffixed inserts _2 before the ext → "_CON_2.jpg".
  const images = [
    { sourcePath: '/x/a.jpg', filename: 'a.jpg' },
    { sourcePath: '/x/b.jpg', filename: 'b.jpg' },
  ];
  const out = buildCopyFilenames(
    images,
    { product: 'CON' },
    { template: '{product}' },
  );
  assert.equal(out.files[0].destFilename, '_CON.jpg');
  assert.equal(out.files[1].destFilename, '_CON_2.jpg');
  assert.equal(out.stats.suffixed, 1);
});

test('M2b Win32 reserved: fallback path is NOT guarded (by design)', () => {
  // If img.filename is literally "CON.jpg" and the template resolves to
  // empty (fallback), we pass img.filename through verbatim. That is a
  // data-plumbing problem upstream, and dressing it up here would hide
  // it from whoever needs to fix it. Documented behaviour.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/actual.jpg', filename: 'CON.jpg' }],
    {},
    { template: '{option:nonexistent}' },
  );
  assert.equal(out.files[0].destFilename, 'CON.jpg');
  assert.deepEqual(out.stats.fallbacks, ['CON.jpg']);
});

test('M2b Win32 reserved: full option-lookup source (not just literals)', () => {
  // Reserved names can slip in via any resolved token, not just {product}.
  // Prove it via an option value — the same guard fires regardless of
  // which token produced the stem.
  const out = buildCopyFilenames(
    [{ sourcePath: '/x/source.jpg', filename: 'source.jpg' }],
    { options: [{ name: 'device', value: 'PRN' }] },
    { template: '{option:device}' },
  );
  assert.equal(out.files[0].destFilename, '_PRN.jpg');
});

test('M2-fix audit: exactly one path.extname call is on img.sourcePath', () => {
  // Meta-test — path.extname on template output was the whole reason for
  // the bug. Reading the module source with fs is the only way to lock
  // that no future change reintroduces it. This test is unashamedly
  // structural; if the module is refactored the assertion is trivial to
  // update, but a silent regression here would recreate the exact
  // failure mode the fix was written to prevent.
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'services', 'folder-copy-filename.js'),
    'utf8',
  );
  // Count actual calls — strip line comments and block-comment lines so
  // the docstring's several `path.extname` warning mentions do not count.
  const codeOnly = src
    .split('\n')
    .filter(line => {
      const t = line.trim();
      // Drop lines that are ONLY a comment. Block-comment continuation
      // lines start with `*`; single-line comments start with `//`.
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');
  const calls = codeOnly.match(/path\.extname\s*\(/g) || [];
  assert.equal(calls.length, 1,
    `expected exactly one path.extname call in code; found ${calls.length}: ${calls.join(', ')}`);
  // And that one call must be on img.sourcePath — the trusted anchor.
  assert.match(codeOnly, /path\.extname\(img\.sourcePath\)/,
    'the surviving path.extname call must be on img.sourcePath');
});

// ═════════════════════════════════════════════════════════════════════════
// M5a — buildDestFolder: one implementation of §6.2
// ═════════════════════════════════════════════════════════════════════════
//
// Extracted from _sendViaFolderCopyRouted (dispatch) and the M5 preview
// so both callers go through the same rule. Prevents the drift hazard of
// two independent copies (same shape as the two folder_copy route
// literals in routing-service — except here the fix is a single helper,
// not a parity test).
//
// The critical case is the NO-CHANGE LOCK: layout 'job' + blank strip
// prefix must produce EXACTLY `${orderNumber}_${jobId}` under
// `outputPath`, byte-identical to pre-M4 output. print-service-folder-
// copy-routed.test.js's no-change-lock test then locks the whole chain.

test('buildDestFolder no-change lock: layout=job + no prefixes → path.join(outputPath, `${order}_${id}`)', () => {
  const got = buildDestFolder({
    outputPath:  '/hot/wf',
    orderNumber: 'PXDEMO-091YEC',
    jobId:       42,
    // destinationLayout absent → defaults to 'job'
    // stripPrefixes absent    → defaults to empty
  });
  assert.equal(got, path.join('/hot/wf', 'PXDEMO-091YEC_42'));
});

test('buildDestFolder no-change lock: explicit "job" + empty prefixes → byte-identical to pre-M4', () => {
  const got = buildDestFolder({
    outputPath:        '/hot/wf',
    orderNumber:       'PXDEMO-091YEC',
    jobId:             42,
    destinationLayout: 'job',
    stripPrefixes:     [],
  });
  assert.equal(got, path.join('/hot/wf', 'PXDEMO-091YEC_42'));
});

test('buildDestFolder layout=job + single-prefix array: destination stripped, jobId preserved', () => {
  const got = buildDestFolder({
    outputPath:        '/hot/wf',
    orderNumber:       'PXDEMO-091YEC',
    jobId:             42,
    destinationLayout: 'job',
    stripPrefixes:     ['PXDEMO-'],
  });
  assert.equal(got, path.join('/hot/wf', '091YEC_42'));
});

test('M7 buildDestFolder layout=job + MULTIPLE prefixes: longest-match-first wins', () => {
  const got = buildDestFolder({
    outputPath:        '/hot/wf',
    orderNumber:       'PXDEMO1-091YEC',
    jobId:             42,
    destinationLayout: 'job',
    stripPrefixes:     ['PXDEMO', 'PXDEMO1'],  // longer wins regardless of input order
  });
  assert.equal(got, path.join('/hot/wf', '091YEC_42'));
});

test('M7 buildDestFolder layout=job + prefix without separator: leading "-" dropped', () => {
  const got = buildDestFolder({
    outputPath:        '/hot/wf',
    orderNumber:       'PXDEMO-091YEC',
    jobId:             42,
    destinationLayout: 'job',
    stripPrefixes:     ['PXDEMO'],   // no trailing hyphen
  });
  assert.equal(got, path.join('/hot/wf', '091YEC_42'));
});

test('buildDestFolder layout=root: returns outputPath verbatim (no per-job subfolder)', () => {
  const got = buildDestFolder({
    outputPath:        '/hot/wf',
    orderNumber:       'PXDEMO-091YEC',
    jobId:             42,
    destinationLayout: 'root',
  });
  assert.equal(got, '/hot/wf');
});

test('buildDestFolder layout=root ignores stripPrefixes (no folder segment to strip into)', () => {
  const got = buildDestFolder({
    outputPath:        '/hot/wf',
    orderNumber:       'PXDEMO-091YEC',
    jobId:             42,
    destinationLayout: 'root',
    stripPrefixes:     ['PXDEMO-'],
  });
  assert.equal(got, '/hot/wf');
});

test('buildDestFolder blank outputPath + layout=job: relative folder segment (preview-friendly)', () => {
  // Preview may call this before Save with a blank outputPath; the
  // operator still gets to see the shape.
  const got = buildDestFolder({
    outputPath:        '',
    orderNumber:       'PXDEMO-091YEC',
    jobId:             42,
    destinationLayout: 'job',
  });
  assert.equal(got, 'PXDEMO-091YEC_42');
});

test('buildDestFolder blank outputPath + layout=root: returns "" (nothing to show)', () => {
  const got = buildDestFolder({
    outputPath:        '',
    orderNumber:       'PXDEMO-091YEC',
    jobId:             42,
    destinationLayout: 'root',
  });
  assert.equal(got, '');
});

test('buildDestFolder destinationLayout: anything not "root" resolves to "job"', () => {
  // Belt-and-braces read-time coercion — matches the routing-service
  // literal's read-time coercion at print-service.js.
  for (const bad of [undefined, null, '', 'JOB', 'Root', 'garbage', 0, false]) {
    const got = buildDestFolder({
      outputPath:        '/o',
      orderNumber:       'PXT',
      jobId:             9,
      destinationLayout: bad,
    });
    assert.equal(got, path.join('/o', 'PXT_9'),
      `destinationLayout ${JSON.stringify(bad)} must fall back to "job"`);
  }
});

test('buildDestFolder stripPrefixes never strips to empty (delegates to printUtils rule)', () => {
  // Delegated behaviour lock — the multi-prefix helper's per-candidate
  // never-strip-to-empty rule.
  const got = buildDestFolder({
    outputPath:    '/o',
    orderNumber:   'PXDEMO-',
    jobId:         42,
    stripPrefixes: ['PXDEMO-'],
  });
  assert.equal(got, path.join('/o', 'PXDEMO-_42'),
    'stripped-to-empty must NOT happen — order number preserved when the strip would empty it');
});

test('buildDestFolder non-array stripPrefixes ignored (defensive)', () => {
  const got = buildDestFolder({
    outputPath:    '/o',
    orderNumber:   'PXDEMO-091',
    jobId:         42,
    stripPrefixes: undefined,
  });
  assert.equal(got, path.join('/o', 'PXDEMO-091_42'));
});

test('M7 buildDestFolder legacy single-string stripPrefixes is IGNORED (caller must migrate)', () => {
  // If a caller forgets to migrate from the old single-string
  // stripPrefix arg to the new array stripPrefixes, we do NOT
  // silently accept the string — it falls to the "not an array"
  // defensive branch and no-op. Loud + fixable in tests, not a
  // hidden production surprise.
  const got = buildDestFolder({
    outputPath:    '/o',
    orderNumber:   'PXDEMO-091',
    jobId:         42,
    stripPrefixes: 'PXDEMO-',   // wrong shape (was the old API)
  });
  assert.equal(got, path.join('/o', 'PXDEMO-091_42'));
});
