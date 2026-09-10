/**
 * Drawer-level keyboard policy — pure decisions the JobReviewDrawer's
 * document-level key handler consults.
 *
 * Extracted from index.jsx to a plain .js file so drawerKeyPolicy.test.js
 * can require() the helper without a JSX transformer, and so the drawer's
 * onKey handler stays a thin dispatcher over these named predicates
 * rather than a growing pile of inline conditions.
 *
 * ─────────────────────────────────────────────────────────────────────
 * shouldDeferEscapeToInner — the reprint-picker Escape trap fix
 *
 * Two `document`-level Escape handlers fire independently:
 *   - ReprintSplitButton's picker effect (closes the menu on Escape)
 *   - JobReviewDrawer's own key handler   (closes the drawer on Escape)
 *
 * Both listeners are on `document`, so stopPropagation is not a
 * reliable fix — one handler cannot silence the other, and the
 * ordering is a latent trap. The picker is a lightweight popover
 * without a modal chrome to preventDefault around.
 *
 * The drawer must defer Escape while an inner owner claims it. Today
 * the only such owner is the reprint picker; if a future inner surface
 * also wants Escape (e.g. a nested confirmation), OR its "open" flag
 * into this predicate here — not into another inline branch in the
 * drawer effect.
 *
 * Only strict `=== true` counts as an "inner owner claim". A truthy-
 * but-not-true value at the callsite is a bug that would otherwise be
 * masked by deferring on it — better to fail loud at whichever
 * component fed the wrong shape than to silently pass Escape events
 * through the drawer for it.
 */

'use strict';

function shouldDeferEscapeToInner(state) {
  if (state == null) return false;
  return state.reprintPickerOpen === true;
}

module.exports = { shouldDeferEscapeToInner };
