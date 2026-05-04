/**
 * src/main/services/app-prefs-store.js
 *
 * App-wide UI preferences shared across all panels (Jobs grid, Job Review,
 * Film Review, Settings, Activity Log).
 *
 * Currently holds the single `theme` value driving the body.app-theme-dark
 * class swap. Created during the 2026-04-29 theming consistency pass when
 * theme was lifted out of `film-review-prefs-store` so a single toggle in
 * the app header could control every surface.
 *
 * Held in a dedicated electron-store file (`app-prefs.json` under userData),
 * separate from `config.json` so toggling the theme can never affect
 * pipeline behaviour.
 *
 * Shape:
 *   {
 *     theme: 'light' | 'dark'   (default 'light')
 *   }
 */

'use strict';

const Store = require('electron-store');

const DEFAULTS = Object.freeze({
  theme: 'light',
});

const ALLOWED_VALUES = Object.freeze({
  theme: ['light', 'dark'],
});

class AppPrefsStore {
  constructor() {
    this.store = new Store({
      name: 'app-prefs',
      defaults: { ...DEFAULTS },
    });
  }

  getAll() {
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const v = this.store.get(key);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  get(key) {
    if (!(key in DEFAULTS)) return undefined;
    const v = this.store.get(key);
    return v === undefined ? DEFAULTS[key] : v;
  }

  /**
   * Persist one preference. Silently ignores unknown keys and invalid values.
   * Returns true on write, false if rejected.
   */
  set(key, value) {
    if (!(key in DEFAULTS)) return false;
    const allowed = ALLOWED_VALUES[key];
    if (Array.isArray(allowed) && !allowed.includes(value)) return false;
    this.store.set(key, value);
    return true;
  }
}

const appPrefsStore = new AppPrefsStore();
module.exports = appPrefsStore;
module.exports.AppPrefsStore = AppPrefsStore;
module.exports.DEFAULTS = DEFAULTS;
module.exports.ALLOWED_VALUES = ALLOWED_VALUES;
