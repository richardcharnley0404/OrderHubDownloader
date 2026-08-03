'use strict';

/**
 * src/shared/printSizeShapes.js
 *
 * Single source of truth for the bare `WxH` size-shape detector used by
 * every layer that has to accept-or-reject a print-size string.
 *
 * Callers today:
 *   - src/main/services/routing-service.js — DPOF `resolvePrintSizeCode`
 *     read-time wrap and the legacy-`size` backfill.
 *   - src/main/services/fuji-jobmaker-config.js — save-time validation of
 *     the Fuji-family `printSize` field (M0 of the Fuji PIC Pro brief).
 *
 * The regex is deliberately duplicated in the renderer's Fuji save
 * handlers (renderer.js) purely for a friendlier pre-submit alert; the
 * IPC handler enforces the authoritative check via this module.
 *
 * Accepted shapes (whitespace-tolerant, case-insensitive on the `x`):
 *   6x4, 3.5x5, "8 x 10", 8X8, 8×8 (Unicode multiplication sign)
 *
 * Rejected:
 *   KG, 2L, NML -PSIZE "8x4", "" (empty), 4x, x6, arbitrary text.
 *
 * Kept in `src/shared/` — Electron-free — so `node --test` and the
 * renderer bundle can both load it without pulling in electron-store.
 */

// Whitespace around numbers is tolerated; the `x` may be Unicode × or
// ASCII (case-insensitive). Decimal fractions allowed on either side —
// covers 3.5x5, 4.5x6.5, and every mixed variant lab operators actually
// enter.
const BARE_WXH_PATTERN = /^\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*$/i;

/**
 * @param {*} value
 * @returns {boolean} true iff `value` (coerced to string) is a bare WxH.
 *   null / undefined coerce to '' and return false — the caller doesn't
 *   need a separate null-check.
 */
function isBareWxH(value) {
  return BARE_WXH_PATTERN.test(String(value == null ? '' : value));
}

module.exports = { isBareWxH, BARE_WXH_PATTERN };
