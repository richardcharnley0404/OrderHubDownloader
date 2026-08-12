'use strict';

/**
 * src/shared/controllerTypes.js
 *
 * Single source of truth for the controller-type sets that main-side
 * code and the health check (src/shared/configHealth.js) both consult.
 * Electron-free so `node --test` can load it directly.
 *
 * The list moved out of routing-service.js in M5 of
 * missing-print-size-recovery — configHealth.findUnroutableMappings
 * needs the same classification the DPOF save-time validator uses,
 * and re-declaring the list would have made it three copies (the
 * fourth if you count the renderer's inline copy at renderer.js:5780,
 * which is acknowledged as a fixed duplicate — the renderer loads
 * under context isolation and cannot require this file).
 */

/**
 * Controller types that do NOT consult `mapping.size` / `mapping.printSizeCode`
 * at all. Every other type derives its print size from its own dedicated
 * fields:
 *   - darkroompro   → controller.sizeTranslations
 *   - fujijobmaker  → mapping.printSize / .printCode (M0 migration)
 *   - fujipicpro    → same as JobMaker plus color and surface
 *   - frontline     → mapping.batchCode
 *   - folder_copy   → no print size (just copies files)
 *   - pdf_copy      → no print size (writes PDF)
 *
 * A mapping whose controller type is in this set never flags in the
 * DPOF print-size health check.
 *
 * `noritsu`, `epson`, and any unknown / missing controller type are
 * treated as DPOF-shaped (matches what `resolvePrintSizeCode` and
 * `validateDPOFPrintSizeCode` both do at runtime).
 */
const NON_DPOF_CONTROLLER_TYPES = new Set([
  'darkroompro', 'fujijobmaker', 'fujipicpro', 'frontline', 'folder_copy', 'pdf_copy',
]);

module.exports = { NON_DPOF_CONTROLLER_TYPES };
