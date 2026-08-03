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

  // Fuji PIC Pro review fix 14. Reject overlapping paths.
  // Two failure modes if the operator picks the same folder (or
  // nested folders) for two of these fields:
  //
  //   - imageStagingRoot === diginPath → stageImages copies into
  //     {imageStagingRoot}/{orderId}/ = {diginPath}/{orderId}/;
  //     DIGIN sees the images BEFORE the .txt exists in Order Data,
  //     which is exactly the sequencing PIC Pro's spec forbids
  //     (docs/fuji-pic-pro-investigation-and-plan.md §1a). Every
  //     order breaks while the monitor may still report `accepted`
  //     because deliverToDigin's fix-7 idempotency check sees the
  //     dest folder already present.
  //   - Any other pair overlapping (or one being a subfolder of
  //     another) has the same class of ordering / cleanup hazards
  //     — e.g. staging inside Order Data would let the writer's
  //     `rm -rf {staging}` sweep past the .txt.
  //
  // Only validate when the required paths are all present (avoid
  // piling required-field errors on top of an overlap error).
  const pairs = [
    ['orderDataPath',    out.orderDataPath],
    ['diginPath',        out.diginPath],
    ['imageStagingRoot', out.imageStagingRoot],
    ['mergeDataPath',    out.mergeDataPath],   // may be blank; _pathsOverlap short-circuits on blank
  ];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [labelA, pathA] = pairs[i];
      const [labelB, pathB] = pairs[j];
      const overlap = _pathsOverlap(pathA, pathB);
      if (overlap === 'equal') {
        errors.push(`${labelA} and ${labelB} must be different folders (both set to ${JSON.stringify(pathA)})`);
      } else if (overlap === 'contains') {
        errors.push(`${labelA} and ${labelB} must not overlap — one is nested inside the other (${JSON.stringify(pathA)} vs ${JSON.stringify(pathB)}). Use sibling folders instead.`);
      }
    }
  }

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
 * Fuji PIC Pro review fix 14. Compare two operator-entered paths
 * for equality or nesting. Returns:
 *   'none'      → paths are distinct and neither contains the other
 *   'equal'     → the two paths refer to the same folder
 *   'contains'  → one path is inside the other (either direction)
 *
 * Handles Windows conventions:
 *   - `\` and `/` are both directory separators (normalise to `\`)
 *   - Comparison is case-insensitive (NTFS default)
 *   - Trailing separators are stripped so `C:\a\` == `C:\a`
 *
 * Blank inputs short-circuit to 'none' — `mergeDataPath` is
 * optional and blank should never trigger an overlap error.
 */
function _pathsOverlap(a, b) {
  if (!a || !b) return 'none';
  const _norm = (p) => String(p)
    .replace(/[/\\]+/g, '\\')          // collapse any / or \ runs → single \
    .replace(/\\+$/, '')                // strip trailing separators
    .toLowerCase();
  const na = _norm(a);
  const nb = _norm(b);
  if (!na || !nb) return 'none';
  if (na === nb) return 'equal';
  // Prefix check with a trailing separator so `C:\a` isn't
  // treated as a prefix of `C:\ab`. The comparison is symmetric.
  if (nb.startsWith(na + '\\')) return 'contains';
  if (na.startsWith(nb + '\\')) return 'contains';
  return 'none';
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
  _internals: { _pathsOverlap },
};
