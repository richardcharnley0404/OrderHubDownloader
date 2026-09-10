/**
 * Drawer-defers-Escape-to-inner-owner invariant.
 *
 * Background: two document-level Escape handlers fire together — the
 * ReprintSplitButton's picker effect (closes the menu) and the
 * JobReviewDrawer's own key handler (closes the whole drawer). Without
 * a guard, pressing Escape to dismiss the picker ALSO closes Job Review
 * and discards the operator's in-progress reprint flagging.
 *
 * Two-part fix locked here:
 *
 *   1. A pure helper `shouldDeferEscapeToInner({ reprintPickerOpen })`
 *      that returns true iff an inner owner claims Escape. Extracted so
 *      the drawer's keydown effect can consult it and this file can
 *      test the decision directly, without a React test runner.
 *
 *   2. A source-scan asserting the drawer's onKey handler imports and
 *      consults the helper on every Escape, and that the pickerOpen
 *      state is LIFTED (owned by JobReviewDrawer, not by
 *      SendReprintAction) so the drawer's handler can see it.
 *
 * Written test-first per the standing rule — the source-scan tests fail
 * against pre-fix code (pickerOpen is local to SendReprintAction; drawer
 * onKey has no guard).
 *
 * Run via: npm test
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const REPO      = path.resolve(__dirname, '..', '..', '..');
const HELPER    = path.join(REPO, 'src', 'renderer', 'views', 'JobReview', 'drawerKeyPolicy.js');
const JSX_PATH  = path.join(REPO, 'src', 'renderer', 'views', 'JobReview', 'index.jsx');

const { shouldDeferEscapeToInner } = require(HELPER);

// ═════════════════════════════════════════════════════════════════════════
// Pure predicate
// ═════════════════════════════════════════════════════════════════════════

test('shouldDeferEscapeToInner: reprint picker open → defer (true)', () => {
  assert.equal(shouldDeferEscapeToInner({ reprintPickerOpen: true }), true);
});

test('shouldDeferEscapeToInner: reprint picker closed → do NOT defer (false)', () => {
  assert.equal(shouldDeferEscapeToInner({ reprintPickerOpen: false }), false);
});

test('shouldDeferEscapeToInner: empty state object → do NOT defer (false)', () => {
  // Defensive: missing keys must not accidentally read as truthy.
  assert.equal(shouldDeferEscapeToInner({}), false);
});

test('shouldDeferEscapeToInner: null / undefined state → do NOT defer (false)', () => {
  assert.equal(shouldDeferEscapeToInner(null),      false);
  assert.equal(shouldDeferEscapeToInner(undefined), false);
});

test('shouldDeferEscapeToInner: non-boolean truthy reprintPickerOpen → do NOT defer', () => {
  // Only strict `=== true` counts. A truthy-but-not-true value
  // (a stringy "open", 1, {}) is a bug at the callsite; deferring on
  // it would mask the bug by making Escape "silently work" for
  // unrelated states.
  assert.equal(shouldDeferEscapeToInner({ reprintPickerOpen: 'yes' }), false);
  assert.equal(shouldDeferEscapeToInner({ reprintPickerOpen: 1 }),     false);
  assert.equal(shouldDeferEscapeToInner({ reprintPickerOpen: {} }),    false);
});

// ═════════════════════════════════════════════════════════════════════════
// Source-scan — the drawer consults the helper AND owns the picker state
// ═════════════════════════════════════════════════════════════════════════

test('index.jsx imports shouldDeferEscapeToInner from drawerKeyPolicy.js', () => {
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  assert.match(
    src,
    /shouldDeferEscapeToInner[\s\S]*?from\s+['"]\.\/drawerKeyPolicy\.js['"]/,
    'index.jsx must import shouldDeferEscapeToInner from ./drawerKeyPolicy.js so ' +
    'the drawer\'s keydown handler can consult a single predicate rather than ' +
    're-implementing the defer rule inline.',
  );
});

test('drawer keydown handler calls shouldDeferEscapeToInner and returns early when true', () => {
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  // The keydown handler in JobReviewDrawer must consult the helper on
  // Escape BEFORE calling handleClose. Shape-check: within the handler,
  // shouldDeferEscapeToInner(...) must appear and its truthy branch
  // must `return` (not `handleClose()`). We locate the specific
  // "Escape → handleClose" region and assert the guard sits above it.
  //
  // Match: `if (e.key === 'Escape') {`
  //          `  if (shouldDeferEscapeToInner(...)) return;`
  //          `  handleClose();`
  const escapeBlockRe =
    /if\s*\(\s*e\.key\s*===\s*['"]Escape['"]\s*\)\s*\{\s*if\s*\(\s*shouldDeferEscapeToInner\s*\([\s\S]*?\)\s*\)\s*return\s*;\s*handleClose\s*\(/;
  assert.match(
    src,
    escapeBlockRe,
    'The drawer\'s Escape branch must consult shouldDeferEscapeToInner(...) and ' +
    'return early on true BEFORE calling handleClose(). Missing guard = Escape ' +
    'while the reprint picker is open closes the whole drawer and discards the ' +
    'operator\'s in-progress flagging.',
  );
});

test('reprintPickerOpen state is LIFTED to JobReviewDrawer (not owned by SendReprintAction)', () => {
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  // The state variable must be declared with useState inside
  // JobReviewDrawer so the drawer's keydown handler can read it. If it
  // stays local to SendReprintAction (`const [pickerOpen, ...] =
  // useState(false)` inside function SendReprintAction), the drawer
  // has no way to see it and the defer rule cannot work.
  //
  // Strategy:
  //   (a) SendReprintAction body must NOT contain `useState` for
  //       pickerOpen — the identifier "pickerOpen" comes in as a prop.
  //   (b) JobReviewDrawer body must contain `useState` producing the
  //       lifted state (identifier "reprintPickerOpen").
  //
  // Locate the function bodies via balanced-brace matching would need a
  // parser; simpler regex bounded by the function's opening declaration
  // is enough since the two functions don't nest inside each other.

  // (a) Isolate the SendReprintAction body (function SendReprintAction … function ReprintSplitButton or another top-level `function`).
  const sendActionMatch = src.match(
    /function\s+SendReprintAction\s*\([\s\S]*?\)\s*\{([\s\S]*?)\n\}\s*\n\s*(?:\/\*\*|function\s|export\s)/,
  );
  assert.ok(sendActionMatch, 'Could not locate SendReprintAction function body — regex needs updating.');
  const sendActionBody = sendActionMatch[1];
  assert.doesNotMatch(
    sendActionBody,
    /useState\s*\(\s*[^)]*\)[^\n]*pickerOpen|const\s*\[\s*pickerOpen\s*,/,
    'SendReprintAction must NOT own pickerOpen via local useState — the drawer\'s ' +
    'Escape handler needs to read it, so it must be lifted to JobReviewDrawer and ' +
    'passed down as a prop.',
  );

  // (b) JobReviewDrawer body must own the lifted state.
  const drawerMatch = src.match(
    /(?:function|const)\s+JobReviewDrawer[\s\S]*?\{([\s\S]*?)\n\}\s*\n\s*(?:export|$)/,
  );
  assert.ok(drawerMatch, 'Could not locate JobReviewDrawer body — regex needs updating.');
  const drawerBody = drawerMatch[1];
  assert.match(
    drawerBody,
    /const\s*\[\s*reprintPickerOpen\s*,\s*setReprintPickerOpen\s*\]\s*=\s*useState/,
    'JobReviewDrawer must declare `const [reprintPickerOpen, setReprintPickerOpen] = useState(...)` ' +
    'so the drawer\'s keydown handler can consult it.',
  );
});

test('drawer keydown effect deps include reprintPickerOpen so a stale closure cannot ignore the guard', () => {
  // React effect closures capture the value at mount. If the deps array
  // omits reprintPickerOpen, the handler sees the initial value forever
  // and the guard silently degrades to always-false. Assert the dep is
  // named in the deps array of the keydown-registering useEffect.
  const src = fs.readFileSync(JSX_PATH, 'utf8');
  // Locate the DRAWER's keydown useEffect specifically. The picker also
  // has a document-level keydown effect with a handler called `onKeyDown`,
  // so the pattern must anchor on the drawer's `window.addEventListener`
  // (picker uses `document.`) and require a word-boundary after `onKey`
  // so `onKeyDown` cannot match.
  const effectRe =
    /useEffect\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?window\s*\.\s*addEventListener\s*\(\s*['"]keydown['"]\s*,\s*onKey\b[\s\S]*?\},\s*\[([^\]]*)\]\)/;
  const m = src.match(effectRe);
  assert.ok(m, 'Could not locate the drawer keydown useEffect — regex needs updating.');
  assert.match(
    m[1],
    /reprintPickerOpen/,
    'The drawer keydown useEffect deps must list reprintPickerOpen so the handler ' +
    'closure sees fresh values — otherwise Escape checks a stale snapshot of the ' +
    'state and the guard silently misses.',
  );
});
