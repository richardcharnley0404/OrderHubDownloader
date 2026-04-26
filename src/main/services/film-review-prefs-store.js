/**
 * src/main/services/film-review-prefs-store.js
 *
 * User preferences for the Film Review panel (PW-007 Phase 1 — Milestone 4).
 *
 * Held in a dedicated electron-store file (`film-review-prefs.json` under
 * userData), separate from both `config.json` (app-wide settings) and
 * `frame-metadata.json` (per-frame data). This separation keeps UI state
 * out of the feature-flag config so saving a preference cannot affect
 * pipeline behaviour, and keeps the pref file small enough to back up /
 * blow away without losing anything load-bearing.
 *
 * The panel itself calls these over IPC (`ohd:filmReview:get-tweaks`,
 * `ohd:filmReview:set-tweak`); direct consumers in the main process
 * should not need this module outside of IPC handlers.
 *
 * Shape and defaults match the prototype's `Tweaks`:
 *   {
 *     density:      'tight' | 'regular' | 'comfy'   (default 'regular')
 *     theme:        'light' | 'dark'                (default 'light')
 *     showKbdHint:  boolean                         (default true)
 *   }
 *
 * Unknown keys are accepted but not persisted — set() validates against
 * DEFAULTS so a malformed renderer can't pollute the store.
 */

'use strict';

const Store = require('electron-store');

const DEFAULTS = Object.freeze({
  density: 'regular',
  theme: 'light',
  showKbdHint: true,
});

const ALLOWED_VALUES = Object.freeze({
  density: ['tight', 'regular', 'comfy'],
  theme: ['light', 'dark'],
  showKbdHint: null, // boolean — validated by typeof
});

class FilmReviewPrefsStore {
  constructor() {
    this.store = new Store({
      name: 'film-review-prefs',
      defaults: { ...DEFAULTS },
    });
  }

  /**
   * Return the full prefs object, with defaults filled in for any missing key.
   * Never returns undefined for a known key.
   */
  getAll() {
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const v = this.store.get(key);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  /**
   * Read a single preference, falling back to the default if unset.
   */
  get(key) {
    if (!(key in DEFAULTS)) return undefined;
    const v = this.store.get(key);
    return v === undefined ? DEFAULTS[key] : v;
  }

  /**
   * Persist one preference. Silently ignores unknown keys and invalid values
   * — renderer bugs should not be able to corrupt the store.
   *
   * Returns true on write, false if rejected.
   */
  set(key, value) {
    if (!(key in DEFAULTS)) return false;

    const allowed = ALLOWED_VALUES[key];
    if (Array.isArray(allowed)) {
      if (!allowed.includes(value)) return false;
    } else if (allowed === null) {
      // Boolean slot — expect typeof boolean.
      if (typeof value !== 'boolean') return false;
    }

    this.store.set(key, value);
    return true;
  }

  /**
   * Devtools helper — reset every preference to its default.
   * Not exposed over IPC.
   */
  _resetAll() {
    for (const key of Object.keys(DEFAULTS)) {
      this.store.set(key, DEFAULTS[key]);
    }
  }
}

const filmReviewPrefsStore = new FilmReviewPrefsStore();
module.exports = filmReviewPrefsStore;
module.exports.FilmReviewPrefsStore = FilmReviewPrefsStore;
module.exports.DEFAULTS = DEFAULTS;
module.exports.ALLOWED_VALUES = ALLOWED_VALUES;
