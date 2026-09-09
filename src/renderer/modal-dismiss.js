/**
 * src/renderer/modal-dismiss.js
 *
 * Shared dismissal logic for every `.pm-modal-overlay` modal — pulled
 * out of renderer.js so it is unit-testable via `node --test`. The
 * renderer is otherwise unreachable by the automated suite, which is
 * why the click-target backdrop-dismiss bug (a press starting inside
 * the modal and releasing on the overlay dismissed the modal and
 * discarded the operator's edits) survived shipping.
 *
 * Two-format module: exposes `window.OhdModalDismiss` when loaded via
 * `<script>` in index.html, and `module.exports` when required from
 * node --test. Do not add DOM globals at load time — the tests import
 * this in a bare Node process.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.OhdModalDismiss = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis
   : typeof self !== 'undefined' ? self
   : typeof window !== 'undefined' ? window
   : null,
function () {
  /**
   * A backdrop click is ONLY authorised when all three of the mousedown
   * target, the mouseup target, and the click event's target are the
   * overlay element itself.
   *
   * The reported bug: the pre-fix wiring checked `e.target === overlay`
   * on the click event only. The DOM computes a click target as the
   * nearest common ancestor of the mousedown target and the mouseup
   * target, so a press that STARTED inside the modal and RELEASED on
   * the overlay produced a click whose target was the overlay — and
   * dismissed the modal, discarding whatever the operator had typed.
   * Two everyday actions do exactly that:
   *   1. Dragging the modal's own scrollbar (the panel is 420px wide
   *      and its scrollbar sits on its right edge; release a few
   *      pixels right of the panel and the pointer is on the overlay).
   *   2. Drag-selecting text in a field to retype it, overshooting the
   *      420px panel edge.
   *
   * This predicate is what `wirePmModalDismiss` in renderer.js
   * consults inside its click handler after recording the mousedown /
   * mouseup targets. Reset the recorded values on every mousedown so
   * a stale value from an earlier event chain can never authorise a
   * later dismiss.
   */
  function shouldDismissBackdrop({ mouseDownTarget, mouseUpTarget, clickTarget, overlay }) {
    if (!overlay) return false;
    return mouseDownTarget === overlay
        && mouseUpTarget   === overlay
        && clickTarget     === overlay;
  }

  /**
   * Serialise one form element to a plain object. Exported for tests
   * that want to construct fixtures without a real DOM. Booleans
   * (checkbox / radio) use `.checked`; everything else uses `.value`.
   */
  function _snapshotElement(el) {
    const type   = String(el && el.type || '').toLowerCase();
    const isBool = type === 'checkbox' || type === 'radio';
    return {
      tag:   String(el && el.tagName || ''),
      name:  String(el && el.name    || ''),
      id:    String(el && el.id      || ''),
      type,
      value: isBool ? String(!!(el && el.checked))
                    : String(el && el.value != null ? el.value : ''),
    };
  }

  /**
   * Take a serialised snapshot of every `<input>` / `<select>` /
   * `<textarea>` inside the overlay. The returned string is opaque —
   * callers should only compare it to a later `snapshotState()` result
   * via `isDirty()`.
   *
   * The snapshot is keyed by DOM order + element identity fields
   * (tag/name/id/type), so:
   *   - A value change on an existing element → snapshot differs.
   *   - A checkbox toggle → snapshot differs.
   *   - A dynamically-added row (prefix rule, media translation,
   *     pipeline step) → snapshot's serialised array length grows.
   *   - A removed row → array shrinks.
   *
   * Snapshotting is idempotent and read-only; nothing on the overlay
   * is mutated.
   */
  function snapshotState(overlay) {
    if (!overlay || typeof overlay.querySelectorAll !== 'function') return '[]';
    const els = overlay.querySelectorAll('input, select, textarea');
    const list = [];
    for (const el of els) list.push(_snapshotElement(el));
    return JSON.stringify(list);
  }

  /**
   * Compare a live overlay against a previous snapshot. Returns true
   * when anything visible to `snapshotState` has changed.
   *
   * The caller stashes the snapshot on the overlay (or wherever) at
   * modal-open time — see the `openModal()` wrapper in renderer.js.
   * A missing / null snapshot returns false (treat "we have no
   * baseline" as clean rather than as dirty; the alternative would
   * confirm on every close for modals that weren't instrumented, which
   * is worse than the fail-open cost of missing a dirty check on one).
   */
  function isDirty(overlay, snapshot) {
    if (snapshot == null) return false;
    return snapshotState(overlay) !== snapshot;
  }

  // Operator-facing confirm message shown when a dirty modal is being
  // dismissed via backdrop click or Escape. Exported as a constant
  // (rather than inlined at the call site) so its exact value is
  // test-asserted — the standing rule that exact operator-facing
  // strings are locked by a test. Do not change this string without
  // also updating the assertion in
  // src/renderer/__tests__/modal-dismiss.test.js.
  const DISCARD_CHANGES_CONFIRM = 'Discard unsaved changes in this form?';

  return {
    DISCARD_CHANGES_CONFIRM,
    shouldDismissBackdrop,
    snapshotState,
    isDirty,
    _snapshotElement, // exposed for tests
  };
});
