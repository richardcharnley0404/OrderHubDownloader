'use strict';

// Same bare-WxH detector routing-service uses for DPOF read-time
// resolution and the legacy-`size` backfill. Loaded from the shared
// module directly (no lazy-require + no cycle) because it's a pure
// regex helper with no Electron deps — see CLAUDE.md on the src/shared
// convention.
const { isBareWxH } = require('../../shared/printSizeShapes');

/**
 * Fuji JobMaker config validation + defaults.
 *
 * The PrintControllerStore is freeform — it stores whatever object shape it's
 * handed. Validation lives here and is called at the IPC / UI boundary before
 * a record is persisted so:
 *   - the UI gets a single source of truth for required vs optional fields
 *   - the generator/writer/monitor can trust their inputs at runtime
 *   - typos and missing fields fail loudly at save time rather than at the
 *     moment a job is dispatched
 *
 * Two public functions:
 *
 *   validateControllerConfig(controller)
 *     → { valid: boolean, errors: string[], normalized: object }
 *
 *   validateProductMappingConfig(mapping)
 *     → { valid: boolean, errors: string[], normalized: object }
 *
 * `normalized` carries the input with defaults filled in and types coerced
 * (booleans, numbers, trimmed strings). Use this as the value to persist.
 *
 * See: docs/print-controllers/FUJI-JOBMAKER-FORMAT.md
 */

const CONTROLLER_TYPE = 'fujijobmaker';

const BACKPRINT_MODES = ['none', 'text', 'image'];
const DEFAULT_BACKPRINT_MODE = 'none';
const DEFAULT_FAILURE_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_FAILURE_TIMEOUT_MS = 60 * 1000;            // 1 min floor — anything less is almost certainly a typo
const MAX_FAILURE_TIMEOUT_MS = 24 * 60 * 60 * 1000;  // 24 h ceiling — same reasoning

// Image-mode is design-complete but not wired into the UI yet — selecting it
// from the validator is allowed (so callers can prepare records ahead of the
// rollout) but produces a warning surfaced via `errors` when strict mode is on.
// For v0 the UI keeps the option hidden; this flag controls validator
// strictness if other callers go around the UI.
const ALLOW_IMAGE_MODE_IN_V0 = false;

// ── Controller validation ────────────────────────────────────────────────────

/**
 * Validate and normalise a Fuji JobMaker controller record.
 *
 * Required fields:
 *   type             must be 'fujijobmaker'
 *   name             non-empty string
 *   hotFolderPath    non-empty string
 *   imageStagingRoot non-empty string
 *   fujiImageRoot    non-empty string (1.16.1; pre-filled from
 *                    imageStagingRoot on migration so existing
 *                    controllers open with a valid value)
 *
 * Optional fields (defaulted in `normalized`):
 *   printerName        '' (omit when blank)
 *   autoCorrect        null (→ AutoCorrect= omitted)
 *   backprintMode      'none'
 *   backprintTemplate  '' (only meaningful when backprintMode === 'text')
 *   failureTimeoutMs   30 * 60 * 1000
 *   isActive           true
 */
function validateControllerConfig(controller) {
  const errors = [];
  const out = {};

  if (!controller || typeof controller !== 'object') {
    return { valid: false, errors: ['controller must be an object'], normalized: null };
  }

  // type
  if (controller.type !== CONTROLLER_TYPE) {
    errors.push(`type must be '${CONTROLLER_TYPE}', got ${JSON.stringify(controller.type)}`);
  }
  out.type = CONTROLLER_TYPE;

  // name
  const name = _trim(controller.name);
  if (!name) errors.push('name is required');
  out.name = name;

  // hotFolderPath
  const hotFolderPath = _trim(controller.hotFolderPath);
  if (!hotFolderPath) errors.push('hotFolderPath is required');
  out.hotFolderPath = hotFolderPath;

  // imageStagingRoot — where OHD writes the per-order image folder.
  const imageStagingRoot = _trim(controller.imageStagingRoot);
  if (!imageStagingRoot) errors.push('imageStagingRoot is required');
  out.imageStagingRoot = imageStagingRoot;

  // fujiImageRoot (1.16.1) — the artwork root as the Fuji JobMaker
  // machine reaches it. This is what OHD writes into the emitted
  // `.txt`'s `ImagePath=` line. When OHD and Fuji JobMaker run on the
  // same machine, this is identical to imageStagingRoot; when they
  // run on different machines, imageStagingRoot is OHD's local path
  // and fujiImageRoot is the same folder expressed as the Fuji
  // machine sees it (typically a UNC share).
  //
  // Migration rule: a controller that predates 1.16.1 has no
  // fujiImageRoot. On read the field is pre-filled from
  // imageStagingRoot so every existing controller opens with a valid
  // value and saves immediately. This mirrors the same-machine case
  // and is the correct default — a controller whose paths already
  // worked keeps working with no operator action. A bare "required
  // field with no default" would reproduce the 1.15.0 defect that
  // blocked a lab from saving their controller; that lesson is
  // recorded as the "never document unrun tests as fact" convention
  // in CLAUDE.md and applies here as "never require a new field
  // without a migration default that keeps existing configs valid".
  //
  // Save-time validation: required (post-migration a blank value is
  // an operator error — every controller had a valid value pre-filled
  // for them). No reachability check here — that is done by the IPC
  // caller as an advisory warning, and by dispatch as a hard check.
  const fujiImageRootInput = controller.fujiImageRoot;
  const fujiImageRoot = _trim(
    fujiImageRootInput === undefined || fujiImageRootInput === null
      ? imageStagingRoot // migration default
      : fujiImageRootInput
  );
  if (!fujiImageRoot) errors.push('fujiImageRoot is required');
  out.fujiImageRoot = fujiImageRoot;

  // printerName — optional
  out.printerName = _trim(controller.printerName);

  // autoCorrect — must be true/false/null/undefined; reject other shapes
  if (
    controller.autoCorrect === undefined ||
    controller.autoCorrect === null
  ) {
    out.autoCorrect = null;
  } else if (controller.autoCorrect === true || controller.autoCorrect === 1 || controller.autoCorrect === '1') {
    out.autoCorrect = true;
  } else if (controller.autoCorrect === false || controller.autoCorrect === 0 || controller.autoCorrect === '0') {
    out.autoCorrect = false;
  } else {
    errors.push(`autoCorrect must be boolean, 0/1, or null; got ${JSON.stringify(controller.autoCorrect)}`);
    out.autoCorrect = null;
  }

  // backprintMode
  const mode = controller.backprintMode || DEFAULT_BACKPRINT_MODE;
  if (!BACKPRINT_MODES.includes(mode)) {
    errors.push(`backprintMode must be one of ${BACKPRINT_MODES.join('|')}; got ${JSON.stringify(mode)}`);
  } else if (mode === 'image' && !ALLOW_IMAGE_MODE_IN_V0) {
    errors.push(
      "backprintMode 'image' is not enabled in v0. " +
      "Use 'none' or 'text' until the back-print image source is defined " +
      '(see FUJI-JOBMAKER-FORMAT.md Outstanding Question #1).'
    );
  }
  out.backprintMode = mode;

  // backprintTemplate — required when mode is 'text', ignored otherwise
  const template = _trim(controller.backprintTemplate);
  if (out.backprintMode === 'text' && !template) {
    errors.push("backprintTemplate is required when backprintMode is 'text'");
  }
  out.backprintTemplate = template;

  // failureTimeoutMs
  const timeout = controller.failureTimeoutMs;
  if (timeout === undefined || timeout === null || timeout === '') {
    out.failureTimeoutMs = DEFAULT_FAILURE_TIMEOUT_MS;
  } else {
    const n = Number(timeout);
    if (!Number.isFinite(n) || n < MIN_FAILURE_TIMEOUT_MS || n > MAX_FAILURE_TIMEOUT_MS) {
      errors.push(
        `failureTimeoutMs must be a number between ${MIN_FAILURE_TIMEOUT_MS} and ${MAX_FAILURE_TIMEOUT_MS} ms; got ${JSON.stringify(timeout)}`
      );
      out.failureTimeoutMs = DEFAULT_FAILURE_TIMEOUT_MS;
    } else {
      out.failureTimeoutMs = n;
    }
  }

  // isActive — boolean default true
  out.isActive = controller.isActive === undefined ? true : Boolean(controller.isActive);

  return { valid: errors.length === 0, errors, normalized: errors.length === 0 ? out : null };
}

// ── Product mapping validation ───────────────────────────────────────────────

/**
 * Validate and normalise a Fuji-flavoured product mapping.
 *
 * Required:
 *   controllerId   non-empty string
 *   productCode    non-empty string
 *   printCode      non-empty string (the Frontier Quick Print code)
 *   surface        non-empty string (also the per-file grouping key)
 *
 * Optional (defaulted):
 *   surfaceCode    first char of surface (uppercased) when unset
 *   options        {} when unset
 *   isActive       true when unset
 *
 * Returns the canonical shape callers should persist via
 * `printControllerStore.addProductMapping(normalized)`.
 */
function validateProductMappingConfig(mapping) {
  const errors = [];
  const out = {};

  if (!mapping || typeof mapping !== 'object') {
    return { valid: false, errors: ['mapping must be an object'], normalized: null };
  }

  const controllerId = _trim(mapping.controllerId);
  if (!controllerId) errors.push('controllerId is required');
  out.controllerId = controllerId;

  const productCode = _trim(mapping.productCode);
  if (!productCode) errors.push('productCode is required');
  out.productCode = productCode;

  if (mapping.options !== undefined && mapping.options !== null) {
    if (typeof mapping.options !== 'object' || Array.isArray(mapping.options)) {
      errors.push('options must be a plain object of { name: value }');
      out.options = {};
    } else {
      // Coerce values to strings — the matcher does === so anything else is a footgun.
      out.options = {};
      for (const [k, v] of Object.entries(mapping.options)) {
        out.options[k] = v == null ? '' : String(v);
      }
    }
  } else {
    out.options = {};
  }

  const printCode = _trim(mapping.printCode);
  if (!printCode) errors.push('printCode is required');
  out.printCode = printCode;

  // printSize — bare WxH string used ONLY to drive the crop-box aspect
  // in Manual Crop. Never written into JobMaker's .txt (nor PIC Pro's
  // order.txt).
  //
  // Relaxed 2026-08-05 (release-prep, review follow-up): blank is
  // ALLOWED for JobMaker. A live install may have JobMaker mappings
  // whose `printCode` is a lab package code — the M0 backfill leaves
  // `printSize` blank on those, and dispatch is unaffected. A future
  // edit of any other field on the mapping would otherwise be
  // rejected here, breaking a working install on upgrade.
  // Non-blank values still get the bare-WxH shape check so a typo
  // like "KG" doesn't slip through. The amber "no print size" badge
  // on the routing list and the ⚠ pill in Manual Crop keep the
  // problem visible for operators who want to fix it.
  //
  // PIC Pro (`fuji-pic-pro-config.js.validateProductMappingConfig`)
  // still enforces the hard requirement — its mappings are entirely
  // new, so no legacy state to protect.
  const printSize = _trim(mapping.printSize);
  if (printSize && !isBareWxH(printSize)) {
    errors.push(`printSize must be a bare WxH shape like 6x4 or 3.5x5; got ${JSON.stringify(mapping.printSize)}`);
  }
  out.printSize = printSize;

  const surface = _trim(mapping.surface);
  if (!surface) errors.push('surface is required');
  out.surface = surface;

  const surfaceCode = _trim(mapping.surfaceCode);
  out.surfaceCode = surfaceCode || (surface ? surface.charAt(0).toUpperCase() : '');

  out.isActive = mapping.isActive === undefined ? true : Boolean(mapping.isActive);

  return { valid: errors.length === 0, errors, normalized: errors.length === 0 ? out : null };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _trim(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

module.exports = {
  validateControllerConfig,
  validateProductMappingConfig,
  // Exported for the UI's reference panel + test introspection.
  BACKPRINT_MODES,
  DEFAULT_BACKPRINT_MODE,
  DEFAULT_FAILURE_TIMEOUT_MS,
  CONTROLLER_TYPE,
};
