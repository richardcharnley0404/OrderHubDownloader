'use strict';

const path = require('node:path');
const { UNSAFE_CHARS } = require('../../shared/printUtils');
const { resolveTemplate } = require('./template-tokens');

/**
 * folder-copy-filename
 *
 * Pure filename-generation for named Folder Copy controllers. Zero fs
 * calls, zero logger, zero electron dep. All the safety rules for the
 * new templated filenames live here; M4 wires this into
 * _sendViaFolderCopyRouted and does the actual copy.
 *
 * Contract:
 *   buildCopyFilenames(images, job, opts)
 *     -> {
 *          files: [{ sourcePath, destFilename }],
 *          stats: { suffixed, truncated, fallbacks }
 *        }
 *
 * `images` is an array of `{ sourcePath, filename, quantity }` — the caller
 * supplies only those three per image. `originalFilename` is accepted as a
 * passthrough if present, so an operator template that references it still
 * works, but the caller does not have to shape one. Index context
 * (`ctx.index`, `ctx.imageCount`) is OWNED BY THIS MODULE — M2 owns the
 * loop, so it sets those per image. Callers that try to supply their own
 * would be overridden here anyway; keep the responsibility here so index
 * numbering can never disagree with the array's actual order.
 *
 * `job` is passed through to resolveTemplate unchanged.
 *
 * `opts` carries { template, stripPrefix, now }:
 *   - `template`  — free-text template. Blank/absent → the no-change lock
 *                   (§4.1): the input basenames are returned verbatim. This
 *                   is what every existing installation gets today, so
 *                   every test for this module starts with the blank case.
 *   - `stripPrefix` — passed to resolveTemplate for {orderNumber} and
 *                   {jobName}. Blank/absent = no-op.
 *   - `now`       — TEST-ONLY passthrough to resolveTemplate's opts.now.
 *                   M4 must NEVER thread one through in production:
 *                   resolveTemplate throws on a non-Date opts.now, and any
 *                   value that has been through config or JSON arrives as a
 *                   string. Let the real clock default.
 *
 * ── Why no fs check (§4.4) ──────────────────────────────────────────────
 *
 * Collision handling de-duplicates WITHIN THIS CALL ONLY, via a Set of
 * names already issued in this dispatch. On a repeat, `_2`, `_3`, … is
 * inserted before the extension.
 *
 * It is TEMPTING to add an `fs.existsSync` check to also avoid overwriting
 * files that already sit in the destination from a previous dispatch. DO
 * NOT DO THIS. Re-sending or retrying a job today overwrites the same
 * filenames in the same folder — that is what makes a retry idempotent.
 * An fs-based no-overwrite rule would turn every retry into a folder full
 * of `_2`, `_3` duplicates: a strictly worse failure than the one being
 * fixed, and one the operator would find much later. The vanishing-images
 * failure this module exists to prevent is entirely *within* one dispatch,
 * so within-dispatch de-duplication solves all of it.
 *
 * If you are looking at this comment because you think the module should
 * check the filesystem, read
 * docs/folder-copy-filename-templates-brief.md §4.4 first, then don't.
 *
 * ── Why no logger ───────────────────────────────────────────────────────
 *
 * Keeping this module logger-free keeps it pure and testable with no
 * stubbing. All the operator-visible signal lives in the returned `stats`
 * — M4 reads it and logs once per dispatch.
 */

const STEM_MAX = 120;
const SUFFIX_MAX = 999;

/**
 * Sanitise a resolved template value ready for a filename stem:
 *   - Strip UNSAFE_CHARS (shared with folder naming via printUtils; do NOT
 *     grow a second class here).
 *   - Collapse whitespace runs to a single space and trim ends.
 *   - Strip trailing dots and spaces — Windows silently drops them, which
 *     would turn a collision check into a lie.
 *   - Strip LEADING dots and spaces too — Node's path.extname treats a
 *     leading-dot value as a POSIX dotfile (extname('.jpg') === ''), which
 *     leaves ".jpg" intact through the strip-ext step and would let the
 *     source-ext append yield ".jpg.jpg". Stripping the leading dot turns
 *     that into a saner "jpg.jpg" — still ugly, still an operator signal
 *     that the template is nonsense, but not the pathological dotfile
 *     shape the brief §4.3 explicitly forbids ("Never write a file named
 *     .jpg").
 */
function _sanitise(raw) {
  return String(raw)
    .replace(UNSAFE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+/g, '')
    .replace(/[. ]+$/g, '');
}

// Backslash-escape every regex metachar in a literal source-extension so
// we can splice it into a `new RegExp(...)` safely. sourceExt in practice
// is always `.` + alphanumerics, but the escape is cheap and defensive.
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Remove case-insensitive occurrences of the LITERAL sourceExt from `s`.
 *
 * The caller appends sourceExt once after this returns, so the net effect
 * on a resolved value that already contains the source ext is
 * "de-duplicate the ext into a single trailing occurrence." A resolved
 * value that doesn't mention the source ext passes through unchanged.
 *
 * DO NOT reintroduce path.extname on template output here. path.extname
 * finds the LAST dot in a string and treats everything after it as the
 * extension — for a resolved value like "8.5x11 Canvas" it returns
 * ".5x11 Canvas" and any strip step would eat the whole product name.
 * Decimal sizes (8.5x11, 1.5in) are normal in Wide Format, which is the
 * primary use case for this feature — silently truncating them at the
 * first dot is exactly the class of failure this module exists to
 * prevent. path.extname belongs on img.sourcePath and nowhere else in
 * this module.
 *
 * Required outputs (source ".jpg" unless stated), locked in the tests:
 *   "photo.jpg"                          -> "photo.jpg"
 *   "photo.jpg.jpg"                      -> "photo.jpg"
 *   "photo.jpg_2"                        -> "photo_2.jpg"
 *   "my.photo.final.jpg"                 -> "my.photo.final.jpg"
 *   "8.5x11 Canvas"      src ".tif"      -> "8.5x11 Canvas.tif"
 *   "12x18 Canvas 1.5in" src ".tif"      -> "12x18 Canvas 1.5in.tif"
 *   "Jpg Print"                          -> "Jpg Print.jpg"  (no dot, no match)
 */
function _stripSourceExt(s, sourceExt) {
  if (!sourceExt) return s;
  const escaped = sourceExt.replace(REGEX_META, '\\$&');
  return s.replace(new RegExp(escaped, 'gi'), '');
}

/**
 * Given a filename that has already collided in this call, find the next
 * `_N` variant that hasn't been issued yet. The extension to insert
 * around is passed in explicitly — path.extname on the collided name
 * would repeat the very bug _stripSourceExt exists to avoid (see above),
 * and for fallback filenames like "8.5x11 Canvas" (no ext) it would
 * insert the suffix mid-name.
 *
 *   name "photo.jpg", sourceExt ".jpg"       -> "photo_2.jpg"
 *   name "photo.JPG", sourceExt ".jpg"       -> "photo_2.JPG"  (case preserved)
 *   name "8.5x11 Canvas", sourceExt ""       -> "8.5x11 Canvas_2"
 *   name "8.5x11 Canvas", sourceExt ".tif"   -> "8.5x11 Canvas_2"  (no match at tail → append)
 *   name "photo.png",     sourceExt ".jpg"   -> "photo.png_2"      (mismatched fallback: append)
 *
 * Bounded to _2../_SUFFIX_MAX; returns null if exhausted so the caller
 * can throw with more context than a raw error here would carry.
 */
function _nextSuffixed(name, sourceExt, issued) {
  const endsWithExt =
    !!sourceExt &&
    name.length >= sourceExt.length &&
    name.slice(-sourceExt.length).toLowerCase() === sourceExt.toLowerCase();
  const stem = endsWithExt ? name.slice(0, name.length - sourceExt.length) : name;
  const tail = endsWithExt ? name.slice(name.length - sourceExt.length) : '';
  for (let n = 2; n <= SUFFIX_MAX; n++) {
    const candidate = `${stem}_${n}${tail}`;
    if (!issued.has(candidate)) return candidate;
  }
  return null;
}

function buildCopyFilenames(images, job = {}, opts = {}) {
  if (!Array.isArray(images)) {
    throw new TypeError('buildCopyFilenames: images must be an array');
  }

  const template    = (opts && typeof opts.template === 'string') ? opts.template : '';
  const stripPrefix = (opts && typeof opts.stripPrefix === 'string') ? opts.stripPrefix : '';

  const stats = { suffixed: 0, truncated: 0, fallbacks: [] };

  // Blank template: the no-change lock (§4.1). Nothing changes for any
  // existing installation. This is the branch the tests hit first.
  if (!template) {
    return {
      files: images.map(img => ({
        sourcePath:   img.sourcePath,
        destFilename: img.filename,
      })),
      stats,
    };
  }

  const issued = new Set();
  const imageCount = images.length;
  const files = new Array(imageCount);

  // Passthrough shape for resolveTemplate's opts. `now` is included only
  // when the caller supplied one — leaving it undefined for real dispatch
  // lets resolveTemplate use the wall clock. See the docstring for why M4
  // must not thread one through.
  const baseResolveOpts = { stripPrefix };
  if (opts.now !== undefined) baseResolveOpts.now = opts.now;

  for (let i = 0; i < imageCount; i++) {
    const img = images[i];
    const sourceExt = path.extname(img.sourcePath);

    const ctx = {
      filename:         img.filename,
      originalFilename: img.originalFilename,   // passthrough if present
      quantity:         img.quantity,
      index:            i + 1,                  // 1-based, M2-owned
      imageCount,                               // for {indexPadded}, M2-owned
    };

    const resolved   = resolveTemplate(template, job, ctx, baseResolveOpts);
    const sanitised  = _sanitise(resolved);
    // Remove the SOURCE extension from anywhere in the sanitised value
    // (case-insensitive), then re-strip trailing dots and spaces because
    // stripping an ext like ".jpg" out of "photo..jpg" leaves "photo.".
    // The one-liner append below adds the source ext back exactly once.
    let stem = _stripSourceExt(sanitised, sourceExt).replace(/[. ]+$/g, '');

    let destFilename;
    if (!stem) {
      // §4.3 fallback: never emit a file named ".jpg". Use the caller's
      // original filename verbatim — that's the pre-template state, i.e.
      // what would have been written on the no-change path. Record the
      // basename so M4 can name it in the WARN log; the fallback is quiet
      // per-file so operators find out from the count rather than one
      // warning per image.
      destFilename = img.filename;
      stats.fallbacks.push(img.filename);
    } else {
      if (stem.length > STEM_MAX) {
        stem = stem.slice(0, STEM_MAX);
        stats.truncated += 1;
      }
      destFilename = stem + sourceExt;
    }

    // Within-call de-duplication (§4.4). The per-image sourceExt is passed
    // in explicitly — do not derive it from destFilename with path.extname,
    // that would break decimal-size fallback names like "8.5x11 Canvas"
    // (see _stripSourceExt docstring).
    if (issued.has(destFilename)) {
      const suffixed = _nextSuffixed(destFilename, sourceExt, issued);
      if (suffixed === null) {
        throw new Error(
          `buildCopyFilenames: exceeded ${SUFFIX_MAX} suffix attempts for "${destFilename}" ` +
          `(template "${template}"); the template is too under-specified for this dispatch`
        );
      }
      destFilename = suffixed;
      stats.suffixed += 1;
    }
    issued.add(destFilename);

    files[i] = {
      sourcePath: img.sourcePath,
      destFilename,
    };
  }

  return { files, stats };
}

module.exports = { buildCopyFilenames };
