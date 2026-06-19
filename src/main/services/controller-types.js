'use strict';

/**
 * src/main/services/controller-types.js
 *
 * Shared classifier for "this controller speaks DPOF" — the umbrella that
 * covers Noritsu, Epson, and the legacy literal 'dpof' / empty-default
 * shape that pre-dates typed controllers. Hoisted to a single source of
 * truth so the two dispatch sites that need this classification can't
 * drift apart:
 *
 *   - print-service.js   sendReprint()   — pick the DPOF reprint pipeline
 *   - ipc-handlers.js    runAutoPrint()  — gate channelNumber presence
 *
 * The duplicate `new Set(['noritsu','epson','dpof'])` declared inline at
 * each site was the root cause of the v1.7.11 Noritsu reprint bug:
 * sendReprint's narrower `=== 'dpof'` check skipped Noritsu/Epson and
 * sent them to the "not yet supported" branch, while runAutoPrint's
 * canonical set treated them correctly. One shared const, one rule.
 */

const DPOF_TYPES = new Set(['noritsu', 'epson', 'dpof']);

/**
 * True when the controller type should be handled by the DPOF dispatch
 * path. Empty/missing type is treated as DPOF for back-compat with
 * legacy untyped controllers (matches the historical fallthrough).
 *
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
function isDpofType(type) {
  return !type || DPOF_TYPES.has(type);
}

module.exports = { DPOF_TYPES, isDpofType };
