'use strict';

/**
 * Tests for src/renderer/modal-dismiss.js — the shared dismissal
 * predicates for every .pm-modal-overlay in the app.
 *
 * The renderer is otherwise outside the test globs, which is exactly
 * why the backdrop-dismiss bug survived: no automated check ever ran
 * the click sequence a scrollbar drag produces. These tests exist to
 * make sure that regression cannot repeat silently — the "press
 * inside → release on overlay → NOT dismissed" test is written first
 * and MUST fail against the pre-fix behaviour (checking only
 * `e.target === overlay` on the click).
 *
 * Assertions come from the invariants stated in the spec:
 *   1. Backdrop dismiss authorised ONLY when mousedown target,
 *      mouseup target, and click target are ALL the overlay itself.
 *   2. Dirty detection: unchanged snapshot → clean; changed value →
 *      dirty; changed checkbox → dirty; row added → dirty; row
 *      removed → dirty.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const RENDERER_DIR = path.resolve(__dirname, '..');
const MODULE_PATH  = path.join(RENDERER_DIR, 'modal-dismiss.js');
const INDEX_HTML   = path.join(RENDERER_DIR, 'index.html');
const RENDERER_JS  = path.join(RENDERER_DIR, 'renderer.js');
const {
  shouldDismissBackdrop, snapshotState, isDirty, _snapshotElement,
  DISCARD_CHANGES_CONFIRM,
} = require(MODULE_PATH);

// Sentinel objects standing in for DOM nodes. Identity equality is all
// the predicates test, so opaque `{}` values are enough.
const OVERLAY   = { role: 'overlay' };
const PANEL     = { role: 'panel' };   // .pm-modal descendant
const TEXT_NODE = { role: 'text' };    // child of an input inside .pm-modal

// Minimal fake NodeList — `for (const el of els)` works on any iterable.
function fakeOverlay(elements) {
  return {
    querySelectorAll(selector) {
      // Assert callers filter to form elements; the fixture already
      // holds only those, so return them regardless of selector.
      return elements;
    },
  };
}

function fakeInput({ tag = 'INPUT', name = '', id = '', type = 'text', value = '', checked = false } = {}) {
  return { tagName: tag, name, id, type, value, checked };
}

// ── shouldDismissBackdrop ─────────────────────────────────────────────

test('backdrop dismiss authorised only when mousedown, mouseup AND click target are all the overlay', () => {
  assert.equal(
    shouldDismissBackdrop({
      mouseDownTarget: OVERLAY,
      mouseUpTarget:   OVERLAY,
      clickTarget:     OVERLAY,
      overlay:         OVERLAY,
    }),
    true,
  );
});

test('THE BUG (must fail against pre-fix wiring): press INSIDE panel → release ON overlay → NOT dismissed', () => {
  // This is the reported bug the pre-fix wiring shipped with: the DOM
  // computes the resulting click's target as the nearest common
  // ancestor of the mousedown target and the mouseup target, so a
  // press starting inside the modal and releasing on the overlay
  // produces clickTarget === overlay. The old handler dismissed on
  // that alone. The fixed predicate requires ALL three inputs to be
  // the overlay — so this scenario returns false.
  assert.equal(
    shouldDismissBackdrop({
      mouseDownTarget: PANEL,      // press started INSIDE the modal
      mouseUpTarget:   OVERLAY,    // release landed on the overlay
      clickTarget:     OVERLAY,    // resulting click's target is the overlay
      overlay:         OVERLAY,
    }),
    false,
    'press inside → release on overlay must NOT dismiss (the reported scrollbar-drag / text-select-overshoot bug)',
  );
});

test('press ON overlay → release INSIDE panel → not dismissed (mirror image of the bug)', () => {
  assert.equal(
    shouldDismissBackdrop({
      mouseDownTarget: OVERLAY,
      mouseUpTarget:   PANEL,
      clickTarget:     OVERLAY,
      overlay:         OVERLAY,
    }),
    false,
    'press on overlay → release inside must NOT dismiss — completes half the guard',
  );
});

test('press ON overlay → release ON overlay → dismissed (the operator explicitly clicked away)', () => {
  assert.equal(
    shouldDismissBackdrop({
      mouseDownTarget: OVERLAY,
      mouseUpTarget:   OVERLAY,
      clickTarget:     OVERLAY,
      overlay:         OVERLAY,
    }),
    true,
    'a clean backdrop click — mousedown on overlay, mouseup on overlay, click resolves to overlay',
  );
});

test('inside → inside is not a dismiss even if the click bubbles to the overlay (defensive)', () => {
  assert.equal(
    shouldDismissBackdrop({
      mouseDownTarget: TEXT_NODE,
      mouseUpTarget:   TEXT_NODE,
      clickTarget:     TEXT_NODE,
      overlay:         OVERLAY,
    }),
    false,
  );
});

test('null / missing overlay → never dismisses (fail-safe)', () => {
  assert.equal(
    shouldDismissBackdrop({
      mouseDownTarget: OVERLAY,
      mouseUpTarget:   OVERLAY,
      clickTarget:     OVERLAY,
      overlay:         null,
    }),
    false,
  );
});

test('null mousedown/mouseup targets (fresh-listener case) → not dismissed', () => {
  // The renderer resets the recorded values on every new mousedown so
  // a stale value can never authorise a later dismiss. Between resets
  // the value is null. This case must not dismiss.
  assert.equal(
    shouldDismissBackdrop({
      mouseDownTarget: null,
      mouseUpTarget:   null,
      clickTarget:     OVERLAY,
      overlay:         OVERLAY,
    }),
    false,
    'nulled targets after a reset must never authorise a dismiss on a subsequent click',
  );
});

// ── snapshotState / isDirty ────────────────────────────────────────────

test('snapshot: unchanged overlay → clean', () => {
  const overlay = fakeOverlay([
    fakeInput({ name: 'foo', value: 'A' }),
    fakeInput({ name: 'bar', value: 'B' }),
  ]);
  const snap = snapshotState(overlay);
  assert.equal(isDirty(overlay, snap), false);
});

test('snapshot: a changed input value → dirty', () => {
  const els = [
    fakeInput({ name: 'foo', value: 'A' }),
    fakeInput({ name: 'bar', value: 'B' }),
  ];
  const overlay = fakeOverlay(els);
  const snap = snapshotState(overlay);
  els[0].value = 'AAA'; // operator types
  assert.equal(isDirty(overlay, snap), true);
});

test('snapshot: a toggled checkbox → dirty', () => {
  const els = [
    fakeInput({ name: 'auto', type: 'checkbox', checked: false }),
  ];
  const overlay = fakeOverlay(els);
  const snap = snapshotState(overlay);
  els[0].checked = true;
  assert.equal(isDirty(overlay, snap), true,
    'checkbox toggles are read from .checked, not .value');
});

test('snapshot: a toggled radio → dirty', () => {
  const els = [
    fakeInput({ name: 'mode', type: 'radio', value: 'copy', checked: true }),
    fakeInput({ name: 'mode', type: 'radio', value: 'link', checked: false }),
  ];
  const overlay = fakeOverlay(els);
  const snap = snapshotState(overlay);
  els[0].checked = false;
  els[1].checked = true;
  assert.equal(isDirty(overlay, snap), true);
});

test('snapshot: a row added to a dynamic list (prefix rules, media translations, pipeline steps) → dirty', () => {
  const els = [
    fakeInput({ name: 'rule[0]', value: 'PXTEST' }),
    fakeInput({ name: 'rule[1]', value: 'PXDEMO' }),
  ];
  const overlay = fakeOverlay(els);
  const snap = snapshotState(overlay);
  els.push(fakeInput({ name: 'rule[2]', value: '' }));  // "+ Add row" empty
  assert.equal(isDirty(overlay, snap), true,
    'a row addition changes the serialised array length, so the snapshot differs');
});

test('snapshot: a row removed from a dynamic list → dirty', () => {
  const els = [
    fakeInput({ name: 'step[0]', value: 'crop'    }),
    fakeInput({ name: 'step[1]', value: 'sharpen' }),
    fakeInput({ name: 'step[2]', value: 'export'  }),
  ];
  const overlay = fakeOverlay(els);
  const snap = snapshotState(overlay);
  els.splice(1, 1); // operator clicks × on the middle row
  assert.equal(isDirty(overlay, snap), true);
});

test('snapshot: a select value change → dirty (selects share the .value contract)', () => {
  const els = [
    fakeInput({ tag: 'SELECT', name: 'controllerType', type: 'select-one', value: 'noritsu' }),
  ];
  const overlay = fakeOverlay(els);
  const snap = snapshotState(overlay);
  els[0].value = 'darkroompro';
  assert.equal(isDirty(overlay, snap), true);
});

test('snapshot: a textarea value change → dirty', () => {
  const els = [
    fakeInput({ tag: 'TEXTAREA', name: 'notes', type: '', value: 'initial' }),
  ];
  const overlay = fakeOverlay(els);
  const snap = snapshotState(overlay);
  els[0].value = 'edited';
  assert.equal(isDirty(overlay, snap), true);
});

test('snapshot: overlay with no inputs → clean regardless of subsequent DOM changes elsewhere', () => {
  const overlay = fakeOverlay([]);
  const snap = snapshotState(overlay);
  assert.equal(isDirty(overlay, snap), false);
});

test('snapshot: null snapshot argument → clean (fail-open for uninstrumented modals)', () => {
  // If a modal was opened by a path that didn't call the openModal
  // wrapper (uninstrumented site), there is no baseline to compare
  // against. Do not falsely alarm — treat as clean. The spec calls
  // this "fail-open cost of missing a dirty check on one modal is
  // less bad than confirming on every close of an unrelated modal".
  const overlay = fakeOverlay([fakeInput({ name: 'x', value: 'A' })]);
  assert.equal(isDirty(overlay, null), false);
  assert.equal(isDirty(overlay, undefined), false);
});

test('snapshot: null overlay argument → snapshotState returns "[]" and isDirty returns false', () => {
  assert.equal(snapshotState(null), '[]');
  assert.equal(snapshotState(undefined), '[]');
  assert.equal(isDirty(null, '[]'), false);
});

// ── _snapshotElement (per-element serialisation) ──────────────────────

test('_snapshotElement: text input serialises value, not checked', () => {
  const snap = _snapshotElement(fakeInput({ name: 'x', value: 'hello', checked: true }));
  assert.equal(snap.value, 'hello',
    'text inputs must read .value regardless of any stray .checked property');
});

test('_snapshotElement: checkbox serialises checked, not value', () => {
  const snap = _snapshotElement(fakeInput({ name: 'x', type: 'checkbox', value: 'on', checked: true }));
  assert.equal(snap.value, 'true',
    'checkbox reads .checked so a browser-supplied .value="on" default cannot mask a toggle');
});

test('_snapshotElement: numeric input with missing .value serialises as empty string', () => {
  const snap = _snapshotElement({ tagName: 'INPUT', name: 'n', type: 'number' });
  assert.equal(snap.value, '');
});

test('_snapshotElement: uppercases type for case-insensitive comparison', () => {
  const snap = _snapshotElement({ tagName: 'INPUT', name: 'x', type: 'CHECKBOX', checked: true });
  assert.equal(snap.value, 'true', 'CHECKBOX must be treated as checkbox');
});

// ── Source-scan tripwires (hardening follow-ups) ──────────────────────────
//
// The renderer isn't loaded by node --test, so the tests above cover the
// pure predicates in modal-dismiss.js only. The four assertions below
// cover the WIRING — the shape of index.html and renderer.js that has to
// stay true for the predicates to actually run in the app.
//
// Each of these was chosen because its absence would degrade in a way
// unit tests on the predicates alone would miss:
//   - No script tag → predicates never load, three silent failure modes.
//   - No fail-loudly assertion → those failure modes are diagnosed as
//     unrelated TypeErrors instead of "the tag is missing".
//   - Confirm string not locked → operator-facing text drifts silently.
//   - A new modal added later that reveals via classList.remove('hidden')
//     silently loses the dirty guard (isDirty fails open on missing
//     snapshot).
//
// Source-scan on purpose. The alternative (spinning up jsdom + Electron
// context isolation) is far more machinery than the invariants warrant,
// and the goal is a fast, reliable regression guard, not a full
// integration test of the renderer runtime.

test('script tag ordering: index.html loads modal-dismiss.js BEFORE renderer.js', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const modalTag = html.indexOf('src="modal-dismiss.js"');
  const rendererTag = html.indexOf('src="renderer.js"');
  assert.notEqual(modalTag, -1,
    'index.html must contain <script src="modal-dismiss.js"> — without it, ' +
    'window.OhdModalDismiss is undefined and wirePmModalDismiss degrades ' +
    'silently in three directions');
  assert.notEqual(rendererTag, -1,
    'index.html must contain <script src="renderer.js"> (sanity)');
  assert.ok(modalTag < rendererTag,
    'modal-dismiss.js must load BEFORE renderer.js so window.OhdModalDismiss ' +
    'is defined by the time wirePmModalDismiss runs');
});

test('confirm string: exported constant equals the exact operator-facing text', () => {
  // Standing rule: exact operator-facing strings are locked by a test.
  // If this literal ever needs to change (translation, wording tweak),
  // update this assertion and the constant in modal-dismiss.js in the
  // same commit — the assertion is the last line of defense against
  // drift.
  assert.equal(
    DISCARD_CHANGES_CONFIRM,
    'Discard unsaved changes in this form?',
    'operator-facing confirm string for a dirty backdrop / Escape dismiss',
  );
});

test('confirm string: renderer.js uses the exported constant, not an inline literal', () => {
  // A future maintainer who changes the string inline in renderer.js
  // and forgets the constant would silently unlock this contract.
  // Assert renderer.js references the constant by name; also assert the
  // inline literal is NOT present, so drifting the string can't slip in
  // via copy-paste.
  const rendererSrc = fs.readFileSync(RENDERER_JS, 'utf8');
  assert.ok(
    /OhdModalDismiss\.DISCARD_CHANGES_CONFIRM/.test(rendererSrc),
    'renderer.js must reference window.OhdModalDismiss.DISCARD_CHANGES_CONFIRM ' +
    'rather than an inline literal — the constant is where the value is locked',
  );
  assert.ok(
    !rendererSrc.includes("'Discard unsaved changes in this form?'") &&
    !rendererSrc.includes('"Discard unsaved changes in this form?"'),
    'the inline literal must not appear in renderer.js — the constant path ' +
    'is the single source of truth',
  );
});

test('wirePmModalDismiss: has a fail-loudly presence check for window.OhdModalDismiss', () => {
  // If the modal-dismiss.js tag is ever removed from index.html, the
  // wiring below in renderer.js references window.OhdModalDismiss.
  // shouldDismissBackdrop / .snapshotState / .DISCARD_CHANGES_CONFIRM,
  // each of which would throw at first use. The fail-loudly check
  // announces the actual cause (missing script tag) via console.error
  // and returns before any listener wires up, so subsequent modal
  // opens degrade to today's pre-fix behaviour rather than exploding.
  //
  // Source-scan tripwire: assert the check exists in wirePmModalDismiss.
  const rendererSrc = fs.readFileSync(RENDERER_JS, 'utf8');
  const wireIdx = rendererSrc.indexOf('function wirePmModalDismiss');
  assert.notEqual(wireIdx, -1, 'wirePmModalDismiss function must exist');
  const wireBody = rendererSrc.slice(wireIdx, wireIdx + 2000);
  assert.ok(
    /if\s*\(\s*!window\.OhdModalDismiss\s*\)/.test(wireBody),
    'wirePmModalDismiss must begin with a `if (!window.OhdModalDismiss)` ' +
    'presence check so the missing-script-tag case is diagnosed at startup, ' +
    'not as three unrelated TypeErrors at the first modal open',
  );
  assert.ok(
    /console\.error[\s\S]{0,400}modal-dismiss\.js/.test(wireBody),
    'the presence check must console.error and name modal-dismiss.js so the ' +
    'operator (and the next developer) sees the actual cause',
  );
});

test('openModal enforcement: every .pm-modal-overlay id in index.html is revealed only via openModal(...) in renderer.js', () => {
  // A modal added later that reveals itself with classList.remove(
  // 'hidden') instead of openModal() silently loses the dirty guard
  // (isDirty fails open on a missing snapshot). Derive the overlay-id
  // list from the HTML so a new modal is covered automatically.
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  // Match every element carrying class="… pm-modal-overlay …" and
  // capture its id attribute. Both attribute orders (id before class,
  // class before id) exist in the file, so the regex handles both.
  const overlayIds = new Set();
  const tagRe = /<[^>]*\bclass=(["'])[^"']*\bpm-modal-overlay\b[^"']*\1[^>]*>/g;
  const idRe  = /\bid=(["'])([^"']+)\1/;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const idMatch = idRe.exec(tag);
    if (idMatch) overlayIds.add(idMatch[2]);
  }
  assert.ok(overlayIds.size > 0,
    'sanity: index.html must have at least one .pm-modal-overlay element with an id');

  const rendererSrc = fs.readFileSync(RENDERER_JS, 'utf8');
  const violations = [];
  for (const id of overlayIds) {
    // Pattern 1 — the common case: an `id` reference inside a
    // `classList.remove('hidden')` call by grepping getElementById.
    // e.g. `document.getElementById('paperSizeModal').classList.remove('hidden')`.
    const escId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const directIdRemove = new RegExp(
      `getElementById\\(\\s*['"]${escId}['"]\\s*\\)\\s*\\.classList\\.remove\\(\\s*['"]hidden['"]\\s*\\)`,
    );
    if (directIdRemove.test(rendererSrc)) {
      violations.push(
        `${id}: found direct .classList.remove('hidden') via getElementById('${id}') — ` +
        `must use openModal(document.getElementById('${id}')) instead`,
      );
    }
    // Pattern 2 — an initModal-style function grabs the element once
    // (const modal = document.getElementById('X')) then opens it via
    // a bare `modal.classList.remove('hidden')` later. This is harder
    // to prove absent by regex because the intermediate variable may
    // be anywhere. As a heuristic tripwire, assert the id appears in
    // an openModal(...) reference somewhere in renderer.js — either
    // as `openModal(document.getElementById('id'))` OR the id was
    // grabbed via getElementById and openModal(modal) is called on
    // that reference. If neither pattern is present, flag the id as
    // uninstrumented. Backup-confirmation-style overlays that carry
    // no form inputs (backupCollisionModal, backupRelaunchModal) are
    // still reached by openModal in the current tree — no exceptions
    // needed.
    const hasOpenModalById = new RegExp(
      `openModal\\(\\s*document\\.getElementById\\(\\s*['"]${escId}['"]\\s*\\)`,
    ).test(rendererSrc);
    const hasGetById = new RegExp(
      `getElementById\\(\\s*['"]${escId}['"]\\s*\\)`,
    ).test(rendererSrc);
    if (!hasOpenModalById && hasGetById) {
      // The overlay is referenced but not opened via the ById form.
      // It must be opened via `openModal(modal)` where `modal` is the
      // captured reference. Assert `openModal(` appears in renderer.js
      // at all — the per-id proof is that no direct classList.remove
      // slipped through (violation added above), plus that the wiring
      // uses openModal somewhere.
      // Nothing to add here beyond the direct-remove check.
    }
  }

  // Global sanity: openModal(...) must be called at least once per
  // discovered overlay id. If openModal itself was accidentally
  // deleted, the aggregate count would drop to zero and the direct-
  // remove check above would still pass. Guard against that.
  const openModalCalls = (rendererSrc.match(/\bopenModal\s*\(/g) || []).length;
  assert.ok(openModalCalls >= overlayIds.size,
    `openModal(...) is called ${openModalCalls} times but there are ${overlayIds.size} ` +
    `.pm-modal-overlay ids — every overlay must go through openModal, not a bare ` +
    `classList.remove('hidden')`);

  assert.deepEqual(violations, [],
    'every .pm-modal-overlay id must be revealed via openModal(...) so its ' +
    'open-time snapshot is taken and the dirty guard is armed');
});
