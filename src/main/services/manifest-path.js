'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve which file in an order folder is the order manifest.
 *
 * Primary name is `{orderNumber}.json` (e.g. PRLE-EL2KTR.json). If that file
 * isn't present, fall back to a generic `order.json` in the same folder — this
 * lets upstream/FTP deliveries that don't name the manifest after the order
 * still be recognised.
 *
 * Resolution is by EXISTENCE only (not readability): callers re-validate that
 * the chosen file is non-empty and JSON-parseable. We deliberately prefer the
 * primary whenever it exists — even if it's momentarily empty mid-write — so a
 * half-written `{orderNumber}.json` doesn't cause a flip-flop to `order.json`;
 * the caller's readability check + retry handles that case.
 *
 * When neither file exists, returns the primary `{orderNumber}.json` path so
 * error messages and the awaiting-manifest tooltip reference the expected name.
 *
 * @param {string} orderFolderPath
 * @param {string} orderNumber
 * @returns {string} absolute path to the manifest (resolved or primary)
 */
function resolveManifestPath(orderFolderPath, orderNumber) {
  const primary = path.join(orderFolderPath, `${orderNumber}.json`);
  try {
    if (fs.existsSync(primary)) return primary;
    const fallback = path.join(orderFolderPath, 'order.json');
    if (fs.existsSync(fallback)) return fallback;
  } catch (_) {
    /* fall through to primary */
  }
  return primary;
}

module.exports = { resolveManifestPath };
