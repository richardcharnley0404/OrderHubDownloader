'use strict';

/**
 * src/shared/cropSizeDropdown.js
 *
 * Pure helper that assembles the Crop-to-Size dropdown list for the
 * Job Review panel. Extracted from renderer's ControlPanel.jsx so it
 * can be unit-tested from `node --test` — the merge rules here have
 * real reroute consequences (see the Fuji PIC Pro review-fixes doc,
 * unverified section) and need a locked contract.
 *
 * Callers:
 *   - src/renderer/views/JobReview/ControlPanel.jsx (renderer)
 *   - src/shared/__tests__/cropSizeDropdown.test.js  (tests)
 *
 * Must stay Electron-free per CLAUDE.md — imports node built-ins
 * only if needed. Currently uses only Array + Map.
 */

/**
 * Built-in common print sizes that always appear in the dropdown,
 * even if no channel mapping exists at that size. When a DPOF or
 * Darkroom mapping shares the same `{w, h}` its channel/routing
 * fields fold in so cropping to a built-in size also stamps the
 * routing override.
 */
const COMMON_PRINT_SIZES = [
  { id: '__3x3',   w: 3,    h: 3,    label: '3×3"'   },
  { id: '__4x4',   w: 4,    h: 4,    label: '4×4"'   },
  { id: '__4x6',   w: 4,    h: 6,    label: '4×6"'   },
  { id: '__5x5',   w: 5,    h: 5,    label: '5×5"'   },
  { id: '__5x7',   w: 5,    h: 7,    label: '5×7"'   },
  { id: '__6x6',   w: 6,    h: 6,    label: '6×6"'   },
  { id: '__6x8',   w: 6,    h: 8,    label: '6×8"'   },
  { id: '__8x8',   w: 8,    h: 8,    label: '8×8"'   },
  { id: '__8x10',  w: 8,    h: 10,   label: '8×10"'  },
  { id: '__10x10', w: 10,   h: 10,   label: '10×10"' },
  { id: '__10x13', w: 10,   h: 13,   label: '10×13"' },
  { id: '__12x12', w: 12,   h: 12,   label: '12×12"' },
];

/**
 * Assemble the dropdown list from the built-in defaults and the
 * backend's `getAllSizeOptions()` result. Guarantees:
 *
 *   1. Every entry has a unique `id` (dropdown keys are safe).
 *   2. A DPOF or Darkroom mapping that shares `{w, h}` with a
 *      COMMON row folds into that row — pre-fix behaviour, so
 *      picking `4×6"` still stamps the DPOF override.
 *   3. A Fuji-source (`source === 'fuji'`) entry is ALWAYS its own
 *      row and NEVER merges into COMMON — pairs with the
 *      useJobReview channelMappingId-drop so picking a Fuji row
 *      does not stamp `_channelMappingOverride`. Label carries a
 *      controller-name hint when known so operators can tell two
 *      4×6 rows apart.
 *   4. When two DPOF/Darkroom mappings share the same `{w, h}`,
 *      only the first folds into the COMMON row; the second appears
 *      as its own row with a controller-name label.
 *
 * @param {Array<object>} allSizeOptions — output of routingService.getAllSizeOptions()
 * @param {Map<string,string>} [controllerNamesById] — optional map of
 *   controllerId → display name. Absent → labels omit the name
 *   suffix (source-type only for Fuji, unlabeled fallback for
 *   DPOF/Darkroom).
 * @returns {Array<object>} dropdown entries
 */
function buildSizeOptions(allSizeOptions, controllerNamesById) {
  const options = COMMON_PRINT_SIZES.map(s => ({ ...s }));

  for (const opt of allSizeOptions) {
    const controllerName = _resolveControllerName(opt, controllerNamesById);

    if (opt.source === 'fuji') {
      // Fuji rows never fold in — always their own entry.
      options.push({
        ...opt,
        label: controllerName
          ? `${opt.label} — ${controllerName} (Fuji)`
          : `${opt.label} — Fuji`,
      });
      continue;
    }

    // DPOF + Darkroom fold into the first matching COMMON row that
    // hasn't already been claimed. Two mappings at the same `{w, h}`
    // → the second becomes its own row rather than overwriting.
    const idx = options.findIndex(s =>
      s.w === opt.w && s.h === opt.h && !s.channelMappingId && !s.darkroomSize
    );
    if (idx >= 0) {
      options[idx] = { ...options[idx], ...opt };
    } else {
      options.push({
        ...opt,
        label: controllerName ? `${opt.label} — ${controllerName}` : opt.label,
      });
    }
  }
  return options;
}

function _resolveControllerName(opt, controllerNamesById) {
  if (!controllerNamesById) return null;
  const id = opt.controllerId || opt.darkroomControllerId;
  if (!id) return null;
  return controllerNamesById.get(id) || null;
}

module.exports = { buildSizeOptions, COMMON_PRINT_SIZES };
