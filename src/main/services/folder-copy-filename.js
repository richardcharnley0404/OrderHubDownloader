'use strict';

const path = require('node:path');
const { UNSAFE_CHARS, applyOrderNumberPrefixRules: _applyPrefixRules } = require('../../shared/printUtils');
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
 * `opts` carries { template, prefixRules, now }:
 *   - `template`  — free-text template. Blank/absent → the no-change lock
 *                   (§4.1): the input basenames are returned verbatim. This
 *                   is what every existing installation gets today, so
 *                   every test for this module starts with the blank case.
 *   - `prefixRules` — Array<{from,to}> (M7b); passed to resolveTemplate
 *                   for {orderNumber} and {jobName} via
 *                   printUtils.applyOrderNumberPrefixRules. Non-array or
 *                   empty = no-op. Blank `to` = pure strip (M7 behaviour).
 *   - `now`       — TEST-ONLY passthrough to resolveTemplate's opts.now.
 *                   M4 must NEVER thread one through in production:
 *                   resolveTemplate throws on a non-Date opts.now, and any
 *                   value that has been through config or JSON arrives as a
 *                   string. Let the real clock default.
 *
 * ── Collision handling: within-dispatch (buildCopyFilenames) + against disk (dedupeAgainstDisk, 1.16.2) ──
 *
 * `buildCopyFilenames` de-duplicates WITHIN THIS CALL ONLY, via a Set of
 * names already issued in this dispatch. On a repeat, `_2`, `_3`, … is
 * inserted before the extension. This stays pure — zero fs.
 *
 * 1.16.2 adds a SECOND stage, `dedupeAgainstDisk`, that runs AFTER
 * `buildCopyFilenames` and dedupes the planner's output against
 * whatever files already sit in the destination folder. Pure, but
 * takes an injectable `existsFn` so tests never touch a real fs.
 * Dispatch (`_sendViaFolderCopyRouted`) calls both in sequence.
 *
 * The pre-1.16.2 module docstring warned in strong terms against ANY
 * fs-based no-overwrite rule ("re-sending or retrying a job today
 * overwrites the same filenames — that is what makes a retry
 * idempotent"). The 1.16.2 spec explicitly chose the opposite trade:
 * OHD must never replace an existing file in a Folder Copy
 * destination, even at the cost of retries producing extra `_2`
 * copies. Two reasons drove the reversal:
 *
 *   1. Item 5 (omitJobId) makes two jobs of one order share a folder.
 *      Under omitJobId + a template without a job-distinguishing token,
 *      the pre-1.16.2 within-dispatch dedup does NOT protect the
 *      second job's files — the two dispatches are separate. Only a
 *      dedupe-against-disk pass catches that.
 *   2. A retry that lands `_2` copies is a visible signal (an extra
 *      file the operator can see); a retry that silently overwrites is
 *      invisible until the customer notices. The visible failure mode
 *      is the right trade.
 *
 * The keep-the-module-pure discipline still holds: the fs interaction
 * is confined to `dedupeAgainstDisk` and reaches the module only via
 * a function argument (`existsFn`).
 *
 * ── Why no logger ───────────────────────────────────────────────────────
 *
 * Keeping this module logger-free keeps it pure and testable with no
 * stubbing. All the operator-visible signal lives in the returned `stats`
 * — M4 reads it and logs once per dispatch.
 *
 * ── Win32 device-name guard (M2b) ───────────────────────────────────────
 *
 * A resolved stem of CON/PRN/AUX/NUL/COM1-9/LPT1-9 is prefixed with an
 * underscore before the extension is appended. Win32 refuses to create
 * those regardless of extension, so an unguarded "CON.jpg" would fail
 * copyFileSync with an OS-layer error that points nowhere near the
 * template that caused it. See _guardWin32Reserved for details, and
 * the tests for the full case matrix.
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

/**
 * Windows reserves a handful of device names (CON, PRN, AUX, NUL,
 * COM1-COM9, LPT1-LPT9). The reservation applies to the STEM regardless
 * of extension — Win32 refuses to create "CON.jpg" as flatly as it
 * refuses "CON". Without a guard the dispatch would fail at
 * copyFileSync with a generic EACCES/ENOENT that points at the OS layer
 * rather than at the template that caused it, so the operator sees a
 * cryptic error and has no idea their `{product}` happened to resolve
 * to "CON".
 *
 * This guard is Win32-specific — POSIX has no such reservation — but
 * the app ships and runs on Windows, so the guard runs unconditionally.
 * Prefixing with an underscore is enough to disarm the reservation
 * while keeping the operator's intended name legible ("_CON" beats
 * "CON_safe" or a random-uuid rename). Applies to the STEM only: the
 * appended source extension is not part of the match.
 *
 * Not guarded: the fallback path (img.filename verbatim). If an upstream
 * step handed us a source file literally named "CON.jpg", that is a
 * data-plumbing problem before it reaches this module and dressing it
 * up here would hide it from whoever needs to fix it upstream.
 */
const WIN32_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function _guardWin32Reserved(stem) {
  return WIN32_RESERVED.test(stem) ? `_${stem}` : stem;
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
 *
 * Removing ALL occurrences (not just the trailing one) is a deliberate
 * trade: a product named "Canvas.jpg Print" becomes "Canvas Print.jpg"
 * with source ".jpg". Chosen, not missed. Anchoring the removal to the
 * end of the string (`.jpg$`) would restore that value's readability but
 * would break the {filename}_{quantity} case above — the ".jpg" that
 * {filename} smuggled in sits in the middle, not the end, and would
 * survive an end-anchored strip, yielding the forbidden "photo.jpg_2".
 * The mid-name-.jpg-in-a-product-name shape is vanishingly rare in real
 * data; the {filename}_{quantity} shape is a natural template mistake.
 * Optimise for the common case.
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
  const prefixRules = (opts && Array.isArray(opts.prefixRules)) ? opts.prefixRules : [];

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
  const baseResolveOpts = { prefixRules };
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
      // Win32 device-name guard runs AFTER truncation on the off-chance
      // truncation itself landed on a reserved name (a 121-char stem
      // starting with "CON" + junk sliced to exactly "CON"). Prefix adds
      // at most one character; the +1 over STEM_MAX is deliberate — the
      // reservation must win over the cap.
      stem = _guardWin32Reserved(stem);
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

/**
 * Build the destination folder path for a folder-copy dispatch. The one
 * implementation of §6.2 of the brief — every caller (M4 dispatch, M5
 * preview) must go through here. Two copies of this rule in two files
 * is the same drift hazard as the two route literals in routing-service,
 * except here the fix is a single helper rather than a parity test.
 *
 * Semantics:
 *   layout 'root' → `outputPath` verbatim (or '' if outputPath is blank)
 *   layout 'job'  → path.join(outputPath, `${stripped(orderNumber)}_${jobId}`)
 *                   OR path.join(outputPath, `${stripped(orderNumber)}`)
 *                   when omitJobId is true (1.16.2 — item 5).
 *
 * The blank-outputPath branch is deliberately shared with the preview
 * caller: on a new controller being edited before Save the preview
 * returns just the relative folder segment so the operator still sees
 * the shape. Dispatch never hits that branch (outputPath is required
 * to save the controller) but the shared handling keeps preview and
 * dispatch honest to the same rule.
 *
 * ── The no-change lock (§6.2, §4.1, 1.16.2) ─────────────────────────────
 *
 * With destinationLayout='job', no prefix rules, and omitJobId absent /
 * null / false this returns EXACTLY
 * `path.join(outputPath, `${orderNumber}_${jobId}`)`. That is the pre-M4
 * shape every existing installation depends on. The M4 test suite locks
 * it byte-for-byte at print-service-folder-copy-routed.test.js, and the
 * 1.16.2 TRIPWIRE tests at folder-copy-filename.test.js lock the
 * omitJobId dimension of the migration invariant.
 *
 * @param {object} args
 * @param {string} args.outputPath        — controller.outputPath; blank ok
 * @param {string} args.orderNumber       — job.order_number
 * @param {string|number} args.jobId      — job.id
 * @param {'job'|'root'} [args.destinationLayout] — defaults to 'job'
 * @param {Array<{from:string,to:string}>} [args.prefixRules] — M7b pair
 *   rules; longest-from-first, one leading '-'/'_' consumed after match,
 *   never produces empty. Non-array / empty → no rules applied. Blank
 *   `to` = pure strip. The field is now `orderNumberPrefixRules` on
 *   controller records and the route literals read it via
 *   printUtils.readOrderNumberPrefixRules.
 * @param {boolean} [args.omitJobId] — 1.16.2 (item 5). When TRUE, the
 *   per-job segment is just `${transformedOrder}` — two jobs of the same
 *   order share one folder. Default false: existing controllers keep the
 *   `_${jobId}` disambiguator until an operator ticks the checkbox. Null
 *   and undefined MUST behave identically to false — the migration
 *   invariant, locked by the TRIPWIRE tests. Ignored under
 *   destinationLayout='root' since root has no per-job segment.
 * @returns {string}
 */
function buildDestFolder({ outputPath, orderNumber, jobId, destinationLayout, prefixRules, omitJobId }) {
  const layout   = destinationLayout === 'root' ? 'root' : 'job';
  const outRoot  = typeof outputPath === 'string' ? outputPath : '';
  if (layout === 'root') return outRoot;

  const transformedOrder = _applyPrefixRules(
    orderNumber || '',
    Array.isArray(prefixRules) ? prefixRules : [],
  );
  // 1.16.2 item 5 — omitJobId strips the `_${jobId}` disambiguator so two
  // jobs of the same order share a folder. Strictly `=== true`; null /
  // undefined / false all fall through to the pre-1.16.2 shape. The
  // strict-equals-true is the migration invariant — anything looser
  // would risk a persisted-as-truthy shape (like the string "true"
  // that could arrive from a round-trip via JSON on some legacy
  // renderer path) silently changing a controller's folder name.
  const destJobFolderName = omitJobId === true
    ? transformedOrder
    : `${transformedOrder}_${jobId}`;
  return outRoot ? path.join(outRoot, destJobFolderName) : destJobFolderName;
}

/**
 * 1.16.2 — item 1 — never-overwrite guarantee.
 *
 * Take the planner's `files` (already deduped within-dispatch by
 * `buildCopyFilenames`) and dedupe them AGAINST WHAT IS ACTUALLY ON DISK
 * in the destination folder. Any planned `destFilename` whose target
 * path already exists gets suffixed `_2`, `_3`, ... until an unused
 * name is found — checked against both the on-disk state AND the running
 * set of choices this call has already made, so a suffix never collides
 * with itself.
 *
 * Pure: `existsFn` is injected so tests can drive the check without a
 * real fs. Callers in production pass `p => fs.existsSync(p)` — see
 * `_sendViaFolderCopyRouted` and `_sendReprintViaFolderCopy`.
 *
 * ── Why this reversed the pre-1.16.2 comment ──────────────────────────
 *
 * The pre-1.16.2 module docstring warned in strong terms against an
 * fs-based no-overwrite rule ("re-sending or retrying a job today
 * overwrites the same filenames — that is what makes a retry
 * idempotent"). That reasoning trades one failure mode (silent
 * cross-job overwrite, invisible to the operator) for another (a
 * retry lands a full folder of `_2`, `_3` duplicates). The 1.16.2
 * spec explicitly chose the second: OHD must never replace an
 * existing file in a Folder Copy destination — and item 5's
 * omitJobId setting makes cross-job collisions easy to configure,
 * so the never-overwrite guarantee has to cover both the retry
 * case and the omitJobId case. A retry now produces the extra
 * files; that is a deliberate, operator-visible surprise, not a
 * silent one. The user-facing signal (extra files with _2 suffix)
 * is what tells the operator to stop retrying — which is what a
 * silent overwrite would never have surfaced.
 *
 * @param {Array<{sourcePath:string, destFilename:string}>} files
 *   Output of `buildCopyFilenames`. Order is preserved.
 * @param {(absPath:string) => boolean} existsFn
 *   Injected fs.existsSync equivalent — takes an absolute path,
 *   returns true if a file already exists there.
 * @param {string} [destFolder='']
 *   The destination folder these files will be written into. Used to
 *   build the absolute path each `existsFn` call receives. Blank ok —
 *   the check then runs on the bare destFilename, matching how
 *   dispatch treats a blank outputPath at the buildDestFolder level.
 * @returns {{files: Array<{sourcePath, destFilename}>, stats: {diskSuffixed: number}}}
 *   `stats.diskSuffixed` is the count of files that were renamed
 *   because their planned name collided with on-disk state. Zero on
 *   a fresh destination.
 * @throws when SUFFIX_MAX is exhausted for any one file — the
 *   filename is included in the error so the dispatch caller's
 *   `_status:'error'` message points at the offending name.
 */
function dedupeAgainstDisk(files, existsFn, destFolder = '') {
  if (!Array.isArray(files)) {
    throw new TypeError('dedupeAgainstDisk: files must be an array');
  }
  if (typeof existsFn !== 'function') {
    throw new TypeError('dedupeAgainstDisk: existsFn must be a function');
  }
  const stats = { diskSuffixed: 0 };
  const issued = new Set();
  const out = new Array(files.length);
  for (let i = 0; i < files.length; i++) {
    const orig = files[i];
    let name = orig.destFilename;
    const absOf = (n) => destFolder ? path.join(destFolder, n) : n;
    // If the planned name is free both on disk AND in this call's issued
    // set, take it as-is. Otherwise walk _2/_3/...
    if (!existsFn(absOf(name)) && !issued.has(name)) {
      issued.add(name);
      out[i] = { sourcePath: orig.sourcePath, destFilename: name };
      continue;
    }
    // sourceExt derived from the ORIGINAL source path, same rule the
    // in-call planner uses — do NOT path.extname the destFilename, per
    // the _stripSourceExt landmine at the top of this file.
    const sourceExt = path.extname(orig.sourcePath);
    // Build a candidate-generator that skips both on-disk hits and
    // in-call issued names. _nextSuffixed only checks the issued set,
    // so we augment it by walking until the returned name is also free
    // on disk.
    let candidate = null;
    // Seed the loop by treating the current `name` as already issued
    // — _nextSuffixed will skip it.
    const tempIssued = new Set(issued);
    tempIssued.add(name);
    for (;;) {
      const next = _nextSuffixed(name, sourceExt, tempIssued);
      if (next === null) {
        throw new Error(
          `dedupeAgainstDisk: exceeded ${SUFFIX_MAX} suffix attempts for "${orig.destFilename}" ` +
          `against destination folder ${destFolder || '(blank)'} — the destination may already contain that many _N variants of this filename`
        );
      }
      if (!existsFn(absOf(next))) {
        candidate = next;
        break;
      }
      // Occupied on disk too — mark as issued so _nextSuffixed skips it
      // on the next iteration and continues walking up.
      tempIssued.add(next);
    }
    stats.diskSuffixed += 1;
    issued.add(candidate);
    out[i] = { sourcePath: orig.sourcePath, destFilename: candidate };
  }
  return { files: out, stats };
}

module.exports = { buildCopyFilenames, buildDestFolder, dedupeAgainstDisk };
