/**
 * Unit tests for src/main/services/fuji-jobmaker-config.js.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateControllerConfig,
  validateProductMappingConfig,
  CONTROLLER_TYPE,
  DEFAULT_BACKPRINT_MODE,
  DEFAULT_FAILURE_TIMEOUT_MS,
} = require('../fuji-jobmaker-config');

// ─────────────────────────────────────────────────────────────────────────────
// validateControllerConfig
// ─────────────────────────────────────────────────────────────────────────────

test('valid minimal controller — only required fields set', () => {
  const result = validateControllerConfig({
    type: 'fujijobmaker',
    name: 'Frontier MS01',
    hotFolderPath: '\\\\MASTER\\jobmaker\\',
    imageStagingRoot: '\\\\MASTER\\Pixfizz\\Artwork\\',
    // fujiImageRoot deliberately omitted — the 1.16.1 migration
    // default pre-fills it from imageStagingRoot so an existing
    // "minimal controller" still validates without the operator
    // touching the new field.
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.deepEqual(result.normalized, {
    type: 'fujijobmaker',
    name: 'Frontier MS01',
    hotFolderPath: '\\\\MASTER\\jobmaker\\',
    imageStagingRoot: '\\\\MASTER\\Pixfizz\\Artwork\\',
    // 1.16.1 migration default — same value as imageStagingRoot when
    // the operator has not customised it.
    fujiImageRoot: '\\\\MASTER\\Pixfizz\\Artwork\\',
    printerName: '',
    autoCorrect: null,
    backprintMode: DEFAULT_BACKPRINT_MODE,
    backprintTemplate: '',
    failureTimeoutMs: DEFAULT_FAILURE_TIMEOUT_MS,
    isActive: true,
  });
});

test('valid full controller — every field set', () => {
  const result = validateControllerConfig({
    type: 'fujijobmaker',
    name: '  Frontier MS01  ', // trimmed
    hotFolderPath: '\\\\MASTER\\jobmaker\\',
    imageStagingRoot: '\\\\MASTER\\Pixfizz\\Artwork\\',
    printerName: 'DL650-A1',
    autoCorrect: true,
    backprintMode: 'text',
    backprintTemplate: '{firstName}/{filename}',
    failureTimeoutMs: 60_000,
    isActive: false,
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.normalized.name, 'Frontier MS01');
  assert.equal(result.normalized.autoCorrect, true);
  assert.equal(result.normalized.backprintMode, 'text');
  assert.equal(result.normalized.backprintTemplate, '{firstName}/{filename}');
  assert.equal(result.normalized.failureTimeoutMs, 60_000);
  assert.equal(result.normalized.isActive, false);
});

test('type must be fujijobmaker', () => {
  const result = validateControllerConfig({
    type: 'noritsu',
    name: 'X',
    hotFolderPath: 'X',
    imageStagingRoot: 'X',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /type must be 'fujijobmaker'/);
});

test('name, hotFolderPath, imageStagingRoot are required', () => {
  const result = validateControllerConfig({ type: CONTROLLER_TYPE });
  assert.equal(result.valid, false);
  const errs = result.errors.join('|');
  assert.match(errs, /name is required/);
  assert.match(errs, /hotFolderPath is required/);
  assert.match(errs, /imageStagingRoot is required/);
});

test('whitespace-only required fields are rejected', () => {
  const result = validateControllerConfig({
    type: CONTROLLER_TYPE,
    name: '   ',
    hotFolderPath: '\t',
    imageStagingRoot: '',
    // fujiImageRoot deliberately omitted — with imageStagingRoot
    // blank, the 1.16.1 migration default (fujiImageRoot = imageStagingRoot)
    // yields blank too, so a fourth "fujiImageRoot is required" error
    // fires. This is intentional: after the migration a blank
    // fujiImageRoot is an operator error, same shape as any other
    // blank required field.
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 4);
});

// ── 1.16.1 fujiImageRoot: migration + required-after-migration ──────────────

test('1.16.1 fujiImageRoot migration: absent → pre-filled from imageStagingRoot; save succeeds', () => {
  // Pre-1.16.1 controllers open with fujiImageRoot pre-filled from
  // imageStagingRoot so they save immediately with no operator action.
  // This is the "nobody is ever locked out of their own settings
  // screen" invariant recorded on the field's docstring — a bare
  // required field with no migration default would reproduce the
  // 1.15.0 defect that blocked a lab from saving their controller.
  const result = validateControllerConfig({
    type: 'fujijobmaker',
    name: 'Legacy JM',
    hotFolderPath: '\\\\MASTER\\jm\\',
    imageStagingRoot: '\\\\MASTER\\Artwork\\',
    // fujiImageRoot omitted — this is the migration case
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.normalized.fujiImageRoot, '\\\\MASTER\\Artwork\\',
    'migration MUST pre-fill fujiImageRoot from imageStagingRoot so existing controllers save with no action');
});

test('1.16.1 fujiImageRoot: null → pre-filled from imageStagingRoot (same as absent)', () => {
  const result = validateControllerConfig({
    type: 'fujijobmaker',
    name: 'JM',
    hotFolderPath: 'X',
    imageStagingRoot: 'Y',
    fujiImageRoot: null,
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.fujiImageRoot, 'Y',
    'null MUST fall back to imageStagingRoot — the "field never explicitly set" shape');
});

test('1.16.1 fujiImageRoot: explicit different value is preserved (cross-machine case)', () => {
  const result = validateControllerConfig({
    type: 'fujijobmaker',
    name: 'JM',
    hotFolderPath: 'C:\\ohd\\hot',
    imageStagingRoot: 'C:\\ohd\\artwork',
    fujiImageRoot: '\\\\labserver1\\artwork',
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.imageStagingRoot, 'C:\\ohd\\artwork',
    'imageStagingRoot MUST be preserved separately from fujiImageRoot — this is the cross-machine case the field exists for');
  assert.equal(result.normalized.fujiImageRoot, '\\\\labserver1\\artwork',
    'fujiImageRoot MUST be preserved when explicitly set to a different value');
});

test('1.16.1 fujiImageRoot: explicit empty string AFTER migration is REJECTED', () => {
  // Post-migration, an empty fujiImageRoot is an operator error — every
  // controller had a valid value pre-filled for them. This test locks
  // that the fix does not silently accept blank as "fall back again".
  const result = validateControllerConfig({
    type: 'fujijobmaker',
    name: 'JM',
    hotFolderPath: 'X',
    imageStagingRoot: 'Y',
    fujiImageRoot: '   ',   // whitespace only, trims to ''
  });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(e => /fujiImageRoot is required/.test(e)),
    'errors MUST call out fujiImageRoot specifically; got: ' + result.errors.join('; '),
  );
});

test('autoCorrect coerces 0/1/true/false/null', () => {
  const cases = [
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    ['1', true],
    ['0', false],
    [null, null],
    [undefined, null],
  ];
  for (const [input, expected] of cases) {
    const result = validateControllerConfig({
      type: CONTROLLER_TYPE,
      name: 'X',
      hotFolderPath: 'X',
      imageStagingRoot: 'X',
      autoCorrect: input,
    });
    assert.equal(result.valid, true, `autoCorrect=${input}: ${result.errors.join('; ')}`);
    assert.equal(result.normalized.autoCorrect, expected, `autoCorrect=${input}`);
  }
});

test('autoCorrect rejects garbage values', () => {
  const result = validateControllerConfig({
    type: CONTROLLER_TYPE,
    name: 'X',
    hotFolderPath: 'X',
    imageStagingRoot: 'X',
    autoCorrect: 'maybe',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /autoCorrect must be boolean/);
});

test("backprintMode 'image' is rejected in v0 (deferred)", () => {
  const result = validateControllerConfig({
    type: CONTROLLER_TYPE,
    name: 'X',
    hotFolderPath: 'X',
    imageStagingRoot: 'X',
    backprintMode: 'image',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /not enabled in v0/);
});

test("backprintMode 'text' requires a non-empty backprintTemplate", () => {
  const result = validateControllerConfig({
    type: CONTROLLER_TYPE,
    name: 'X',
    hotFolderPath: 'X',
    imageStagingRoot: 'X',
    backprintMode: 'text',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /backprintTemplate is required/);
});

test('unknown backprintMode is rejected', () => {
  const result = validateControllerConfig({
    type: CONTROLLER_TYPE,
    name: 'X',
    hotFolderPath: 'X',
    imageStagingRoot: 'X',
    backprintMode: 'sticker',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /backprintMode must be one of/);
});

test('failureTimeoutMs accepts a number string within bounds', () => {
  const result = validateControllerConfig({
    type: CONTROLLER_TYPE,
    name: 'X',
    hotFolderPath: 'X',
    imageStagingRoot: 'X',
    failureTimeoutMs: '120000',
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.failureTimeoutMs, 120_000);
});

test('failureTimeoutMs rejects sub-minute values (likely typos)', () => {
  const result = validateControllerConfig({
    type: CONTROLLER_TYPE,
    name: 'X',
    hotFolderPath: 'X',
    imageStagingRoot: 'X',
    failureTimeoutMs: 30, // 30 ms — clearly meant 30 s or 30 min, fail loud
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /failureTimeoutMs/);
});

test('failureTimeoutMs rejects negative / NaN', () => {
  for (const v of [-1, 'soon', NaN]) {
    const result = validateControllerConfig({
      type: CONTROLLER_TYPE,
      name: 'X',
      hotFolderPath: 'X',
      imageStagingRoot: 'X',
      failureTimeoutMs: v,
    });
    assert.equal(result.valid, false, `failureTimeoutMs=${v}`);
  }
});

test('non-object input is rejected cleanly', () => {
  const result = validateControllerConfig(null);
  assert.equal(result.valid, false);
  assert.equal(result.normalized, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateProductMappingConfig
// ─────────────────────────────────────────────────────────────────────────────

test('valid minimal mapping fills surfaceCode from first letter of surface', () => {
  const result = validateProductMappingConfig({
    controllerId: 'ctrl-1',
    productCode: '0305-cut-print',
    printCode: '3.5x5',
    printSize: '3.5x5',
    surface: 'Lustre',
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.normalized.surfaceCode, 'L');
  assert.equal(result.normalized.printSize,   '3.5x5');
  assert.deepEqual(result.normalized.options, {});
  assert.equal(result.normalized.isActive, true);
});

test('explicit surfaceCode wins over auto-derived', () => {
  const result = validateProductMappingConfig({
    controllerId: 'ctrl-1',
    productCode: 'p',
    printCode: '3.5x5',
    printSize: '3.5x5',
    surface: 'Glossy',
    surfaceCode: 'Glo',
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.surfaceCode, 'Glo');
});

test('options object is preserved with values coerced to strings', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c',
    productCode: 'p',
    printCode: '3.5x5',
    printSize: '3.5x5',
    surface: 'L',
    options: { Finish: 'Lustre', Quantity: 4, Border: null },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.normalized.options, {
    Finish: 'Lustre',
    Quantity: '4',
    Border: '',
  });
});

test('options as array is rejected', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c',
    productCode: 'p',
    printCode: '3.5x5',
    printSize: '3.5x5',
    surface: 'L',
    options: [['Finish', 'Lustre']],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /options must be a plain object/);
});

test('mapping requires controllerId, productCode, printCode, surface (printSize is optional for JobMaker)', () => {
  const result = validateProductMappingConfig({});
  assert.equal(result.valid, false);
  const errs = result.errors.join('|');
  assert.match(errs, /controllerId is required/);
  assert.match(errs, /productCode is required/);
  assert.match(errs, /printCode is required/);
  assert.match(errs, /surface is required/);
  assert.doesNotMatch(errs, /printSize is required/,
    'printSize is a Manual-Crop aspect indicator only; a live JobMaker install may have mappings whose printCode is a lab package code that leaves printSize blank via the M0 backfill — rejecting on blank would break a working install on upgrade');
});

test('valid mapping with isActive=false', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c',
    productCode: 'p',
    printCode: '3.5x5',
    printSize: '3.5x5',
    surface: 'Lustre',
    isActive: false,
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.isActive, false);
});

// ── printSize handling (M0 add, 2026-08-05 relax) ──────────────────────────
//
// Sets the Manual Crop aspect ratio for JobMaker jobs. Never written
// into the .txt — its only job is to keep resolveTargetSize away from
// the pre-M0 1:1 fallback. The IPC handler (ipc-handlers.js) is what
// invokes this validator on both the modal save path and CSV import.
//
// 2026-08-05: relaxed to warn-only for JobMaker. A live install may
// carry mappings whose `printCode` is a lab package code — the M0
// backfill leaves `printSize` blank on those. Rejecting on blank
// would break every subsequent edit of those mappings on upgrade,
// even though dispatch is unaffected. PIC Pro (fuji-pic-pro-config)
// still enforces the hard requirement — its mappings are entirely
// new so no legacy state to protect.
//
// Non-blank values still get the bare-WxH shape check so typos like
// "KG" don't slip through silently.

test('printSize blank is ALLOWED (was M0 error, relaxed 2026-08-05 to unbreak live upgrades)', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c', productCode: 'p',
    printCode: '3.5x5', surface: 'Lustre',
  });
  assert.equal(result.valid, true,
    `blank printSize must not be an error on JobMaker; got errors: ${result.errors.join('; ')}`);
  assert.equal(result.normalized.printSize, '',
    'the value persists as blank rather than a fabricated default');
});

test('printSize whitespace-only is treated as blank (allowed)', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c', productCode: 'p',
    printCode: '3.5x5', printSize: '   ', surface: 'Lustre',
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.printSize, '', 'whitespace trims to blank');
});

test('printSize accepts bare WxH shapes: 6x4, 3.5x5, "8 x 10", 8X8, 8×8', () => {
  for (const size of ['6x4', '3.5x5', '8 x 10', '8X8', '8×8', '4.5x6.5']) {
    const result = validateProductMappingConfig({
      controllerId: 'c', productCode: 'p',
      printCode: '3.5x5', printSize: size, surface: 'Lustre',
    });
    assert.equal(result.valid, true, `${size} must be accepted; errors: ${result.errors.join('; ')}`);
    assert.equal(result.normalized.printSize, size.trim(), `${size} persisted verbatim after trim`);
  }
});

test('printSize rejects non-WxH shapes when SET: KG, 2L, arbitrary text, half-shapes (shape check still fires)', () => {
  for (const size of ['KG', '2L', 'A4', 'NML -PSIZE "8x4"', '4x', 'x6', '6x', 'six by four']) {
    const result = validateProductMappingConfig({
      controllerId: 'c', productCode: 'p',
      printCode: '3.5x5', printSize: size, surface: 'Lustre',
    });
    assert.equal(result.valid, false, `${size} must be rejected — a typed value that isn't WxH is a typo, not a legacy blank`);
    assert.match(result.errors.join('|'), /printSize must be a bare WxH shape/);
  }
});

test('printSize error message names the accepted shape family so operators can fix it', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c', productCode: 'p',
    printCode: '3.5x5', printSize: 'KG', surface: 'Lustre',
  });
  assert.equal(result.valid, false);
  const msg = result.errors.find(e => /printSize/.test(e));
  assert.match(msg, /6x4/, 'error must reference the WxH shape so operators know what to type');
  assert.match(msg, /3\.5x5/, 'decimal example belongs in the message — one of the values most likely to be blocked');
});

test('non-object mapping rejected cleanly', () => {
  const result = validateProductMappingConfig('not a mapping');
  assert.equal(result.valid, false);
  assert.equal(result.normalized, null);
});
