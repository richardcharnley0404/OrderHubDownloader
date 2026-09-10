/**
 * Exact operator-facing strings for the rush-reprint destination picker
 * (Option A per docs/rush-reprint-controller-selection-investigation.md).
 *
 * Extracted from index.jsx to a plain .js file so the strings-lock test in
 * __tests__/reprintPicker-strings.test.js can `require()` these constants
 * without needing a JSX transformer at test time. The .jsx SendReprintAction
 * imports from here so the two references stay in lock-step.
 *
 * Do NOT inline these strings at their JSX call sites — the strings-lock
 * test asserts on the exported values, and inlining would silently drift
 * from what the test locks.
 */

'use strict';

// Chevron button title / aria-label. Shown as a tooltip on hover and read
// out by screen readers so the assistive-tech experience is not "button".
const REPRINT_CHEVRON_TITLE = 'Choose reprint destination';

// Header row at the top of the picker menu. Not a screen reader label —
// the menu itself carries aria-label={REPRINT_PICKER_HEADER} so the two
// stay identical without double-authoring.
const REPRINT_PICKER_HEADER = 'Reprint to…';

// Suffix appended after the controller name for the entry whose id
// matches the parent job's default route. Rendered as a separate span
// (jr-send-picker__item-default) so it can be styled distinctly without
// affecting the name span, and so the exact suffix wording (parentheses
// included) is easy to lock in the strings test.
const REPRINT_PICKER_DEFAULT_SUFFIX = '(default)';

module.exports = {
  REPRINT_CHEVRON_TITLE,
  REPRINT_PICKER_HEADER,
  REPRINT_PICKER_DEFAULT_SUFFIX,
};
