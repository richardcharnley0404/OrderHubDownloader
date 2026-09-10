/**
 * Rush-reprint destination picker: strings-lock + collapse-by-config
 * source scan.
 *
 * Design context: docs/rush-reprint-controller-selection-investigation.md
 * §Q6 (Option A — split button + chevron), plus the "collapse it by
 * config, not by controller count alone" requirement.
 *
 * Two invariants locked here:
 *
 *   1. Every operator-facing string in the picker is asserted against
 *      the exact literal. The strings are exported from
 *      views/JobReview/reprintPickerStrings.js (extracted from index.jsx
 *      so this node --test file can require() them without a JSX
 *      transformer). Drift in the .js constants OR at the .jsx call
 *      sites is a test failure.
 *
 *   2. The collapse decision reads the ELIGIBLE-CONTROLLERS list, not
 *      a global controller count. The single load-bearing predicate is
 *      `eligible.length <= 1 → plain button`. This test scans the .jsx
 *      source for the predicate shape and fails loudly if it drifts to
 *      "count all darkroompro controllers", "config-level flag", or
 *      any other proxy that doesn't match the per-job list the picker
 *      shows.
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const REPO       = path.resolve(__dirname, '..', '..', '..');
const JSX_PATH   = path.join(REPO, 'src', 'renderer', 'views', 'JobReview', 'index.jsx');
const STRINGS_JS = path.join(REPO, 'src', 'renderer', 'views', 'JobReview', 'reprintPickerStrings.js');

const {
  REPRINT_CHEVRON_TITLE,
  REPRINT_PICKER_HEADER,
  REPRINT_PICKER_DEFAULT_SUFFIX,
} = require(STRINGS_JS);

// ═════════════════════════════════════════════════════════════════════════
// Strings-lock — exact operator-facing values
// ═════════════════════════════════════════════════════════════════════════

test('REPRINT_CHEVRON_TITLE is exactly "Choose reprint destination"', () => {
  assert.equal(REPRINT_CHEVRON_TITLE, 'Choose reprint destination');
});

test('REPRINT_PICKER_HEADER is exactly "Reprint to…"', () => {
  // Note: the ellipsis is the single-character U+2026, not three dots.
  // Locking the character keeps future editors from silently swapping
  // it out for '...' (three dots), which is a different string, breaks
  // the visual centre of the header, and would drift screen-reader
  // announcements.
  assert.equal(REPRINT_PICKER_HEADER, 'Reprint to…');
});

test('REPRINT_PICKER_DEFAULT_SUFFIX is exactly "(default)"', () => {
  assert.equal(REPRINT_PICKER_DEFAULT_SUFFIX, '(default)');
});

// ═════════════════════════════════════════════════════════════════════════
// Call-site sanity — the JSX references the imports (not inline literals)
// ═════════════════════════════════════════════════════════════════════════

test('index.jsx imports the picker strings from reprintPickerStrings.js', () => {
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  assert.match(
    src,
    /from\s+['"]\.\/reprintPickerStrings\.js['"]/,
    'index.jsx must import the picker strings from ./reprintPickerStrings.js so ' +
    'the strings-lock test remains authoritative — an inlined literal in the JSX ' +
    'would drift silently from the exported constant.',
  );
});

test('index.jsx does NOT inline the three picker string literals', () => {
  // Extra guard: even after importing, someone could type the literal
  // directly inside a JSX attribute or child. The strings must ONLY
  // appear through the imported constants at their call sites; if a
  // future author needs one of these strings elsewhere, they should
  // import from the strings module.
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  const forbidden = [
    'Choose reprint destination',
    'Reprint to…',
    '(default)',
  ];
  for (const literal of forbidden) {
    // Allow the literal to appear ONLY inside a comment block. Simple
    // check: strip block/line comments before searching. This is not a
    // full JS parser — but the jsx file uses conventional `//` and
    // `/* ... */` comments, so a substring scan of the stripped body
    // is enough here.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const idx = stripped.indexOf(literal);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end   = Math.min(stripped.length, idx + literal.length + 40);
      assert.fail(
        `index.jsx contains an INLINE picker string literal "${literal}" outside a comment. ` +
        `Import from ./reprintPickerStrings.js instead.\n` +
        `Context: …${stripped.slice(start, end)}…`,
      );
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Collapse-by-config — the load-bearing predicate is per-job eligibility
// ═════════════════════════════════════════════════════════════════════════

test('SendReprintAction collapses by eligible-controllers length (per-job), not by any global controller count', () => {
  const src = fs.readFileSync(JSX_PATH, 'utf8');

  // Positive requirement: the predicate must read the length of the
  // eligible-controllers ARRAY (the same array the picker menu iterates
  // over), and the plain-button branch must fire on length <= 1. The
  // predicate itself is authored as `eligible.length <= 1` in the code
  // — that specific shape is what we lock.
  assert.match(
    src,
    /eligible\.length\s*<=\s*1/,
    'SendReprintAction must decide the collapse via `eligible.length <= 1` — the ' +
    'per-job eligible-controllers list. Any other predicate (a controller-type ' +
    'count, a config flag, `orderControllers.length`, etc.) would fail to ' +
    'collapse when the operator has two DP controllers but only one is eligible ' +
    'for this specific job, defeating the "invisible for single-controller labs" ' +
    'guarantee.',
  );

  // Negative requirement: the collapse decision must NOT read any of
  // the common proxies for "how many controllers exist globally". The
  // list here is not exhaustive — it names the concrete misreads that
  // would ALSO produce a plausible-looking split-button but violate
  // the collapse-by-config rule.
  const forbiddenProxies = [
    /orderControllers\.length/,
    /controllers\.length\s*>\s*1(?![^;]*eligible)/, // any generic controllers.length compare not scoped to `eligible`
    /getControllers\(\)\.length/,
  ];
  for (const rx of forbiddenProxies) {
    if (rx.test(src)) {
      assert.fail(
        `SendReprintAction contains a forbidden collapse proxy matching ${rx}. ` +
        'The collapse must be derived from the per-job eligible list, never from ' +
        'a global controller count.',
      );
    }
  }
});

test('SendReprintAction ONE-eligible collapse renders the classic jr-btn-send button (today\'s shape)', () => {
  // Wire-level assertion: after the length <= 1 check, the returned JSX
  // must be the plain <button className="jr-btn-send">, not the split
  // button. This is what makes the single-controller lab see NO change.
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  // Locate the block guarded by eligible.length <= 1 and check its
  // return uses jr-btn-send (not jr-btn-send--split-primary and not
  // ReprintSplitButton).
  const collapseBlockRe =
    /if\s*\(\s*eligible\.length\s*<=\s*1\s*\)\s*\{[\s\S]*?return\s*\([\s\S]*?<button[^>]*className=(['"])jr-btn-send\1[\s\S]*?\)\s*;\s*\}/;
  assert.match(
    src,
    collapseBlockRe,
    'The eligible.length <= 1 branch must return the plain jr-btn-send button. ' +
    'Rendering the split-button here would change what single-controller labs see, ' +
    'which is the exact guarantee this collapse exists to preserve.',
  );
});

test('SendReprintAction MULTI-eligible path renders the ReprintSplitButton, chevron included', () => {
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  // The split-button path is the return path AFTER the collapse guard —
  // the fall-through. Assert the component name is present so a rename
  // trips this test.
  assert.match(src, /<ReprintSplitButton/,
    'SendReprintAction must render <ReprintSplitButton /> on the multi-eligible path.');
});

test('ReprintSplitButton menu iterates over eligibleControllers (the same array collapse uses)', () => {
  // Extra tie between the collapse decision and the menu content: they
  // must both read the SAME array. If a future change fetches a separate
  // list for the menu, the "collapse-by-config" invariant is bypassed
  // (menu is rendered from list A, collapse decided from list B).
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  assert.match(src, /eligibleControllers\s*\.\s*map\s*\(/,
    'ReprintSplitButton must render menu items via eligibleControllers.map(…) so ' +
    'the collapse predicate and the menu content share a single source of truth.');
});
