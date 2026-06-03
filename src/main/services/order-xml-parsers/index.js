/**
 * Parser registry for the Order XML hot folder feature.
 *
 * Each hot folder configured in settings declares a `sourceFormat` (e.g.
 * 'photofinale'); the watcher uses this registry to look up the matching
 * parser module and dispatch parse() with the file's contents.
 *
 * Adding a new format (ROES, dotphoto, etc.):
 *   1. Add a parser file alongside this one (see ./README.md for the contract).
 *   2. Add one line to PARSERS below.
 *   3. The settings UI dropdown picks it up automatically via list().
 *
 * Why a frozen Object literal rather than a plug-in scan of the directory:
 *   - Auditable: every supported format is visible in one place at code review.
 *   - Tree-shakeable in the renderer bundle if/when we surface format names.
 *   - No runtime fs scan, which would not work cleanly under asar packaging.
 */

'use strict';

const photoFinale = require('./photo-finale');
const roes        = require('./roes');

// Object.freeze() guards against accidental mutation at runtime — the registry
// is part of the application's contract surface, not a mutable lookup table.
const PARSERS = Object.freeze({
  [photoFinale.id]: photoFinale,
  [roes.id]:        roes,
});

/**
 * Look up a parser module by its `sourceFormat` id. Throws if unknown so the
 * watcher can surface a clear "misconfigured hot folder" error rather than
 * silently swallowing the XML.
 *
 * @param {string} id - parser id (e.g. 'photofinale')
 * @returns {object} parser module
 * @throws {Error} when id is not registered
 */
function get(id) {
  const parser = PARSERS[id];
  if (!parser) {
    const available = Object.keys(PARSERS).join(', ') || '(none)';
    throw new Error(`Unknown order-xml parser id "${id}" (available: ${available})`);
  }
  return parser;
}

/**
 * Return `true` if the given parser id is registered. Use this in settings
 * validation rather than try/catching get().
 */
function has(id) {
  return Object.prototype.hasOwnProperty.call(PARSERS, id);
}

/**
 * List all registered parsers as `{ id, label }` pairs. Used by the settings
 * UI to populate the source-format dropdown. Order matches PARSERS insertion.
 */
function list() {
  return Object.values(PARSERS).map((p) => ({ id: p.id, label: p.label }));
}

/**
 * Sniff `xmlSnippet` (typically the first ~512 bytes of a file) and return
 * the *first* parser whose `matches()` returns true, or `null` if none do.
 *
 * Not used by the watcher in normal operation — each hot folder dictates its
 * format. This exists as a defensive helper: if a hot folder is misconfigured
 * (e.g. ROES XML dropped into a folder set to PhotoFinale), the watcher can
 * call detect() on the failing file to suggest the right format in the error.
 */
function detect(xmlSnippet) {
  for (const parser of Object.values(PARSERS)) {
    if (typeof parser.matches === 'function' && parser.matches(xmlSnippet)) {
      return parser;
    }
  }
  return null;
}

module.exports = { get, has, list, detect };
