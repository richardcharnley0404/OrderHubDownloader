'use strict';

/**
 * src/main/services/fuji-pic-pro-config.js
 *
 * Save-time validators + default resolution for the `fujipicpro`
 * controller type. Modelled 1:1 on `fuji-jobmaker-config.js` so the two
 * validators are easy to diff — the shape (validate...Config → {valid,
 * errors, normalized}) matches, and the IPC handler wiring in
 * ipc-handlers.js is symmetric.
 *
 * Differences from JobMaker:
 *   - Three explicit paths (orderDataPath / diginPath / mergeDataPath +
 *     imageStagingRoot). The lab can host each on a different server.
 *   - Two timeouts: gatewayTimeoutMs (how long to wait for OrderGateway
 *     to consume the .txt) and buildTimeoutMs (how long to wait for the
 *     containers/DIGIN folder to clear before warning).
 *   - `sendReleaseCommand` toggle — off by default; PIC Pro can build
 *     an order without printing it until [release] is dropped.
 *   - `backprintTemplate2` — a second back-print line (PIC Pro genuinely
 *     supports two).
 *   - `includeCustomerName` — off by default. Emitting `CustomerName=`
 *     causes the customer's name to appear on the back of every print
 *     unless a Backprint2 line is also set (spec p. 343).
 *
 * `image`-mode back-print is rejected in v0, same posture as JobMaker.
 *
 * Channel mapping shape matches JobMaker's post-M0 shape (printCode +
 * printSize + surface) plus `color` (default 'C').
 *
 * See docs/fuji-pic-pro-claude-code-brief.md §M1 and
 * docs/fuji-pic-pro-investigation-and-plan.md §3 for the full field
 * table.
 */

const { isBareWxH } = require('../../shared/printSizeShapes');

const CONTROLLER_TYPE = 'fujipicpro';

const BACKPRINT_MODES = ['none', 'text', 'image'];
const DEFAULT_BACKPRINT_MODE = 'none';

const DEFAULT_GATEWAY_TIMEOUT_MS = 2 * 60 * 1000;         // 2 min
const MIN_GATEWAY_TIMEOUT_MS     = 10 * 1000;             // 10 s floor — anything less is almost certainly a typo
const MAX_GATEWAY_TIMEOUT_MS     = 30 * 60 * 1000;        // 30 min ceiling — same reasoning

const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;          // 30 min
const MIN_BUILD_TIMEOUT_MS     = 60 * 1000;               // 1 min floor
const MAX_BUILD_TIMEOUT_MS     = 24 * 60 * 60 * 1000;     // 24 h ceiling

const ALLOW_IMAGE_MODE_IN_V0 = false;

// Colors PIC Pro accepts on `Color=`. Spec p. 353: C (colour) / B (B&W)
// / S / S2 / S3 (three sepia intensities). We accept the union of the
// spec's uppercase forms + a case-insensitive lookup so operators don't
// have to worry about case, and normalise to uppercase on persist.
const ALLOWED_COLORS = new Set(['C', 'B', 'S', 'S2', 'S3']);
const DEFAULT_COLOR  = 'C';

// ── Controller validation ────────────────────────────────────────────────────

/**
 * Validate + normalise a Fuji PIC Pro controller record.
 *
 * Required (fail-loudly at save time):
 *   type                must be 'fujipicpro'
 *   name                non-empty string
 *   orderDataPath       non-empty string — where {OrderId}.txt + commands land
 *   diginPath           non-empty string — where the {OrderId} image folder lands
 *   imageStagingRoot    non-empty string — images assembled here before the DIGIN move
 *
 * Optional (defaulted in `normalized`):
 *   mergeDataPath        ''      — when set, monitor checks it to confirm the
 *                                  build finished before writing [release]
 *   sendReleaseCommand   false   — per-controller auto-print toggle
 *   gatewayTimeoutMs     120000  — how long to wait for OrderGateway to consume the .txt
 *   buildTimeoutMs       1800000 — how long to wait for the build to finish
 *   backprintMode        'none'  — 'none' | 'text' ('image' rejected in v0)
 *   backprintTemplate    ''      — required when backprintMode === 'text'
 *   backprintTemplate2   ''      — optional second line
 *   includeCustomerName  false   — emit CustomerName= (off by default; see docstring)
 *   isActive             true
 */
function validateControllerConfig(controller) {
  const errors = [];
  const out = {};

  if (!controller || typeof controller !== 'object') {
    return { valid: false, errors: ['controller must be an object'], normalized: null };
  }

  if (controller.type !== CONTROLLER_TYPE) {
    errors.push(`type must be '${CONTROLLER_TYPE}', got ${JSON.stringify(controller.type)}`);
  }
  out.type = CONTROLLER_TYPE;

  const name = _trim(controller.name);
  if (!name) errors.push('name is required');
  out.name = name;

  const orderDataPath = _trim(controller.orderDataPath);
  if (!orderDataPath) errors.push('orderDataPath is required');
  out.orderDataPath = orderDataPath;

  const diginPath = _trim(controller.diginPath);
  if (!diginPath) errors.push('diginPath is required');
  out.diginPath = diginPath;

  const imageStagingRoot = _trim(controller.imageStagingRoot);
  if (!imageStagingRoot) errors.push('imageStagingRoot is required');
  out.imageStagingRoot = imageStagingRoot;

  // mergeDataPath — optional. Blank means "trust the DIGIN folder
  // disappearing as the build-complete signal"; set means "additionally
  // verify the container files under this path have been consumed."
  out.mergeDataPath = _trim(controller.mergeDataPath);

  // sendReleaseCommand — strict boolean (undefined defaults to false so
  // a fresh controller doesn't accidentally print on the first order).
  out.sendReleaseCommand = controller.sendReleaseCommand === true;

  // gatewayTimeoutMs
  out.gatewayTimeoutMs = _boundedInt(
    controller.gatewayTimeoutMs,
    DEFAULT_GATEWAY_TIMEOUT_MS,
    MIN_GATEWAY_TIMEOUT_MS,
    MAX_GATEWAY_TIMEOUT_MS,
    'gatewayTimeoutMs',
    errors,
  );

  // buildTimeoutMs
  out.buildTimeoutMs = _boundedInt(
    controller.buildTimeoutMs,
    DEFAULT_BUILD_TIMEOUT_MS,
    MIN_BUILD_TIMEOUT_MS,
    MAX_BUILD_TIMEOUT_MS,
    'buildTimeoutMs',
    errors,
  );

  // backprintMode
  const mode = controller.backprintMode || DEFAULT_BACKPRINT_MODE;
  if (!BACKPRINT_MODES.includes(mode)) {
    errors.push(`backprintMode must be one of ${BACKPRINT_MODES.join('|')}; got ${JSON.stringify(mode)}`);
  } else if (mode === 'image' && !ALLOW_IMAGE_MODE_IN_V0) {
    errors.push(
      "backprintMode 'image' is not enabled in v0 for Fuji PIC Pro. " +
      "Use 'none' or 'text'."
    );
  }
  out.backprintMode = mode;

  const template = _trim(controller.backprintTemplate);
  if (out.backprintMode === 'text' && !template) {
    errors.push("backprintTemplate is required when backprintMode is 'text'");
  }
  out.backprintTemplate = template;

  // Second back-print line — never required, just optional. Only ever
  // emitted when backprintMode === 'text' (the writer gates on the mode).
  out.backprintTemplate2 = _trim(controller.backprintTemplate2);

  // includeCustomerName — off by default. See spec p. 343 and the
  // investigation doc (docs/fuji-pic-pro-investigation-and-plan.md §2)
  // for the "back of every print" side effect that motivates the default.
  out.includeCustomerName = controller.includeCustomerName === true;

  out.isActive = controller.isActive === undefined ? true : Boolean(controller.isActive);

  return { valid: errors.length === 0, errors, normalized: errors.length === 0 ? out : null };
}

// ── Product mapping validation ───────────────────────────────────────────────

/**
 * Validate + normalise a Fuji PIC Pro channel mapping.
 *
 * Required:
 *   controllerId
 *   productCode
 *   printCode              non-empty → written as `Code=` in order.txt
 *   printSize              bare WxH (e.g. 6x4, 3.5x5) — Manual Crop aspect only
 *   surface                paper type / grouping key
 *
 * Optional (defaulted):
 *   color                  'C' — accepted: C / B / S / S2 / S3
 *   surfaceCode            first letter of surface (uppercased) when unset
 *   options                {} when unset
 *   isActive               true
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

  // printSize — same M0 contract as fuji-jobmaker-config. Bare WxH only,
  // shared regex via src/shared/printSizeShapes so the two Fuji types can
  // never diverge on what they accept.
  const printSize = _trim(mapping.printSize);
  if (!printSize) {
    errors.push('printSize is required — sets the crop aspect (e.g. 6x4, 3.5x5)');
  } else if (!isBareWxH(printSize)) {
    errors.push(`printSize must be a bare WxH shape like 6x4 or 3.5x5; got ${JSON.stringify(mapping.printSize)}`);
  }
  out.printSize = printSize;

  const surface = _trim(mapping.surface);
  if (!surface) errors.push('surface is required');
  out.surface = surface;

  const surfaceCode = _trim(mapping.surfaceCode);
  out.surfaceCode = surfaceCode || (surface ? surface.charAt(0).toUpperCase() : '');

  // color — default 'C'. Uppercase for the spec's accepted set; anything
  // else fails loudly so the operator doesn't hit a Frontier reject at
  // print time.
  const colorRaw = _trim(mapping.color);
  if (!colorRaw) {
    out.color = DEFAULT_COLOR;
  } else {
    const upper = colorRaw.toUpperCase();
    if (!ALLOWED_COLORS.has(upper)) {
      errors.push(`color must be one of ${[...ALLOWED_COLORS].join('|')}; got ${JSON.stringify(mapping.color)}`);
      out.color = DEFAULT_COLOR;
    } else {
      out.color = upper;
    }
  }

  out.isActive = mapping.isActive === undefined ? true : Boolean(mapping.isActive);

  return { valid: errors.length === 0, errors, normalized: errors.length === 0 ? out : null };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _trim(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/**
 * Common integer-with-bounds pattern used by both timeout fields. Empty
 * / null / undefined → default. Anything outside [min, max] or non-
 * finite → default + push a descriptive error.
 */
function _boundedInt(raw, def, min, max, fieldName, errors) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(
      `${fieldName} must be a number between ${min} and ${max} ms; got ${JSON.stringify(raw)}`
    );
    return def;
  }
  return n;
}

module.exports = {
  validateControllerConfig,
  validateProductMappingConfig,
  BACKPRINT_MODES,
  DEFAULT_BACKPRINT_MODE,
  DEFAULT_GATEWAY_TIMEOUT_MS,
  DEFAULT_BUILD_TIMEOUT_MS,
  ALLOWED_COLORS,
  DEFAULT_COLOR,
  CONTROLLER_TYPE,
};
