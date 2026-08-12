'use strict';

/**
 * src/shared/configHealth.js
 *
 * Pure configuration-health checks for the routing store. Electron-free
 * so `node --test` can load it directly.
 *
 * Currently exports one check: `findUnroutableMappings` — the DPOF-family
 * "no print size" scan that surfaces mappings which will fail at
 * dispatch. Wired into the app in M6 of missing-print-size-recovery:
 *
 *   - Startup: called during app boot and the result flows into the
 *     dismissible startup banner.
 *   - Settings open: called every time the Settings → Routing pane
 *     opens, backing the roll-up line above the channel-mappings list.
 *
 * Both call sites re-run the check every time — no flag guard, no
 * memoisation. The check MUST stay pure and cheap so that's safe. This
 * is deliberate and load-bearing: the M4 backfill's warning only fires
 * on launches where the backfill actually executes, so any install
 * whose `_backfill_*` flag was set by an older version never sees it.
 * The health check is the ONLY mechanism that surfaces the problem on
 * those installs — including the lab that triggered this whole piece
 * of work.
 */

const { NON_DPOF_CONTROLLER_TYPES } = require('./controllerTypes');

/**
 * Reason codes on flagged mappings. String constants so callers can
 * switch on them without stringly-typed drift.
 */
const REASON = Object.freeze({
  NO_PRINT_SIZE: 'no-print-size',
});

/**
 * Scan the routing store for channel mappings that WILL fail at
 * dispatch — DPOF-family (noritsu / epson / unknown-treated-as-DPOF)
 * with a blank `printSizeCode`. This is exactly the condition the
 * dispatch-time gate at print-service.js:253 rejects, so a hit here
 * predicts a dispatch failure.
 *
 * Non-DPOF controllers are never flagged — their print size lives in
 * type-specific fields (see NON_DPOF_CONTROLLER_TYPES).
 *
 * Defensive on shape: null / non-array inputs return `[]`, individual
 * null / non-object mappings are skipped, mappings pointing at an
 * unknown controllerId are treated as DPOF-shaped (matches
 * `validateDPOFPrintSizeCode` and `resolvePrintSizeCode`). Never
 * throws.
 *
 * Result is sorted deterministically by (controllerName, productCode,
 * mappingId) so the Settings roll-up displays mappings grouped by
 * controller, and diffing two runs is meaningful.
 *
 * @param {Array<object>} mappings    Channel mappings from the routing store.
 * @param {Array<object>} controllers Order controllers from the routing store.
 * @returns {Array<{
 *   mappingId:      string,
 *   controllerId:   string,
 *   controllerName: string,
 *   productCode:    string,
 *   reason:         string,
 * }>}
 */
function findUnroutableMappings(mappings, controllers) {
  if (!Array.isArray(mappings) || mappings.length === 0) return [];

  const controllersById = new Map();
  if (Array.isArray(controllers)) {
    for (const c of controllers) {
      if (c && c.id) controllersById.set(c.id, c);
    }
  }

  const findings = [];
  for (const m of mappings) {
    if (!m || typeof m !== 'object') continue;

    const ctrl = controllersById.get(m.controllerId);
    // Unknown controllerId → treat as DPOF-shaped (matches the runtime
    // gates). The orphan mapping might get re-linked to a Noritsu
    // controller later; the health check surfaces it now so the
    // operator can decide.
    const type = String((ctrl && ctrl.type) || '');
    if (NON_DPOF_CONTROLLER_TYPES.has(type)) continue;

    const printSizeCode = String(m.printSizeCode != null ? m.printSizeCode : '').trim();
    if (printSizeCode) continue;

    findings.push({
      mappingId:      String(m.id != null ? m.id : ''),
      controllerId:   String(m.controllerId != null ? m.controllerId : ''),
      controllerName: String((ctrl && ctrl.name) || ''),
      productCode:    String(m.productCode != null ? m.productCode : ''),
      reason:         REASON.NO_PRINT_SIZE,
    });
  }

  // Sort by (controllerName, productCode, mappingId). Empty controllerName
  // (orphan mappings) sort to the top of the list — they stand out
  // visually and are usually the ones an operator should look at first.
  findings.sort((a, b) => {
    if (a.controllerName !== b.controllerName) return a.controllerName < b.controllerName ? -1 : 1;
    if (a.productCode    !== b.productCode)    return a.productCode    < b.productCode    ? -1 : 1;
    if (a.mappingId      !== b.mappingId)      return a.mappingId      < b.mappingId      ? -1 : 1;
    return 0;
  });

  return findings;
}

module.exports = { findUnroutableMappings, REASON };
