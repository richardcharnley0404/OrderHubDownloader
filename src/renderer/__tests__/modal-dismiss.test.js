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
const path   = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', 'modal-dismiss.js');
const { shouldDismissBackdrop, snapshotState, isDirty, _snapshotElement } = require(MODULE_PATH);

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
