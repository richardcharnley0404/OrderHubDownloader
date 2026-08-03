/**
 * Unit tests for src/main/services/fuji-pic-pro-config.js.
 *
 * Modelled 1:1 on fuji-jobmaker-config.test.js so the two validators
 * are trivial to diff. Coverage:
 *
 *   validateControllerConfig
 *     - minimal-valid (three required paths only)
 *     - full-valid (every optional field set)
 *     - type must be fujipicpro
 *     - each required field is rejected when missing / whitespace
 *     - backprintMode: 'image' rejected, 'text' requires template,
 *       unknown mode rejected
 *     - gatewayTimeoutMs + buildTimeoutMs: default when unset, bounds
 *       enforced, non-finite rejected
 *     - sendReleaseCommand + includeCustomerName: strict booleans
 *
 *   validateProductMappingConfig
 *     - minimal-valid (color defaults to 'C', surfaceCode defaults from surface)
 *     - color: default, uppercase normalisation, accepted set, rejection
 *     - printSize: required, bare WxH shape (shared regex with JobMaker
 *       via src/shared/printSizeShapes)
 *     - options as array rejected, object preserved (values coerced to string)
 *     - all required fields listed in the missing-everything case
 *
 * Run via: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateControllerConfig,
  validateProductMappingConfig,
  BACKPRINT_MODES,
  DEFAULT_BACKPRINT_MODE,
  DEFAULT_GATEWAY_TIMEOUT_MS,
  DEFAULT_BUILD_TIMEOUT_MS,
  ALLOWED_COLORS,
  DEFAULT_COLOR,
  CONTROLLER_TYPE,
} = require('../fuji-pic-pro-config');

// Belt-and-braces: constants sanity so future changes to the
// exported surface trip the tests.
test('exports: constants are the expected shape and values', () => {
  assert.equal(CONTROLLER_TYPE, 'fujipicpro');
  assert.deepEqual(BACKPRINT_MODES, ['none', 'text', 'image']);
  assert.equal(DEFAULT_BACKPRINT_MODE, 'none');
  assert.equal(DEFAULT_GATEWAY_TIMEOUT_MS, 2 * 60 * 1000);
  assert.equal(DEFAULT_BUILD_TIMEOUT_MS,   30 * 60 * 1000);
  assert.equal(DEFAULT_COLOR, 'C');
  assert.deepEqual([...ALLOWED_COLORS].sort(), ['B', 'C', 'S', 'S2', 'S3']);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateControllerConfig
// ─────────────────────────────────────────────────────────────────────────────

test('valid minimal controller — only the three required paths + name set', () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: 'PIC Pro DL650',
    orderDataPath:    '\\\\Labserver1\\Order Data',
    diginPath:        '\\\\Labserver1\\DIGIN1',
    imageStagingRoot: 'C:\\OrderHub\\Staging',
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.normalized.type,             'fujipicpro');
  assert.equal(result.normalized.mergeDataPath,    '', 'unset → blank (monitor falls back to DIGIN-only signal)');
  assert.equal(result.normalized.sendReleaseCommand, false, 'off by default — safe first-run');
  assert.equal(result.normalized.gatewayTimeoutMs, DEFAULT_GATEWAY_TIMEOUT_MS);
  assert.equal(result.normalized.buildTimeoutMs,   DEFAULT_BUILD_TIMEOUT_MS);
  assert.equal(result.normalized.backprintMode,    'none');
  assert.equal(result.normalized.backprintTemplate,  '');
  assert.equal(result.normalized.backprintTemplate2, '');
  assert.equal(result.normalized.includeCustomerName, false);
  assert.equal(result.normalized.isActive, true);
});

test('valid full controller — every field set', () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: 'PIC Pro DL650',
    orderDataPath:      '\\\\Labserver1\\Order Data',
    diginPath:          '\\\\Labserver1\\DIGIN1',
    mergeDataPath:      '\\\\Labserver1\\Merge Data',
    imageStagingRoot:   'C:\\OrderHub\\Staging',
    sendReleaseCommand: true,
    gatewayTimeoutMs:   300000,
    buildTimeoutMs:     3600000,
    backprintMode:      'text',
    backprintTemplate:  '{firstName}/{filename}',
    backprintTemplate2: '{jobId}',
    includeCustomerName: true,
    isActive:           false,
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.deepEqual(result.normalized, {
    type: 'fujipicpro',
    name: 'PIC Pro DL650',
    orderDataPath:      '\\\\Labserver1\\Order Data',
    diginPath:          '\\\\Labserver1\\DIGIN1',
    mergeDataPath:      '\\\\Labserver1\\Merge Data',
    imageStagingRoot:   'C:\\OrderHub\\Staging',
    sendReleaseCommand: true,
    gatewayTimeoutMs:   300000,
    buildTimeoutMs:     3600000,
    backprintMode:      'text',
    backprintTemplate:  '{firstName}/{filename}',
    backprintTemplate2: '{jobId}',
    includeCustomerName: true,
    isActive:           false,
  });
});

test('type must be fujipicpro', () => {
  const result = validateControllerConfig({
    type: 'noritsu',
    name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('|'), /type must be 'fujipicpro'/);
});

test('name, orderDataPath, diginPath, imageStagingRoot are all required', () => {
  const result = validateControllerConfig({ type: 'fujipicpro' });
  assert.equal(result.valid, false);
  const errs = result.errors.join('|');
  assert.match(errs, /name is required/);
  assert.match(errs, /orderDataPath is required/);
  assert.match(errs, /diginPath is required/);
  assert.match(errs, /imageStagingRoot is required/);
});

test('whitespace-only required fields are rejected', () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: '   ',
    orderDataPath: '   ',
    diginPath: '   ',
    imageStagingRoot: '   ',
  });
  assert.equal(result.valid, false);
  const errs = result.errors.join('|');
  assert.match(errs, /name is required/);
  assert.match(errs, /orderDataPath is required/);
  assert.match(errs, /diginPath is required/);
  assert.match(errs, /imageStagingRoot is required/);
});

test('mergeDataPath is optional (blank normalises to blank)', () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
    mergeDataPath: '   ',
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.mergeDataPath, '', 'whitespace-only counts as unset');
});

test("backprintMode 'image' is rejected in v0", () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
    backprintMode: 'image',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('|'), /backprintMode 'image' is not enabled/);
});

test("backprintMode 'text' requires a non-empty backprintTemplate", () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
    backprintMode: 'text', backprintTemplate: '   ',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('|'), /backprintTemplate is required when backprintMode is 'text'/);
});

test("backprintMode 'text' with a template is valid; backprintTemplate2 is not required", () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
    backprintMode: 'text', backprintTemplate: '{filename}',
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.normalized.backprintTemplate2, '', 'line 2 is genuinely optional');
});

test('unknown backprintMode is rejected', () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
    backprintMode: 'weird',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('|'), /backprintMode must be one of none\|text\|image/);
});

test('gatewayTimeoutMs / buildTimeoutMs: default when unset or empty string', () => {
  for (const raw of [undefined, null, '']) {
    const result = validateControllerConfig({
      type: 'fujipicpro',
      name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
      gatewayTimeoutMs: raw, buildTimeoutMs: raw,
    });
    assert.equal(result.valid, true, `raw=${JSON.stringify(raw)} errors: ${result.errors.join('; ')}`);
    assert.equal(result.normalized.gatewayTimeoutMs, DEFAULT_GATEWAY_TIMEOUT_MS);
    assert.equal(result.normalized.buildTimeoutMs,   DEFAULT_BUILD_TIMEOUT_MS);
  }
});

test('gatewayTimeoutMs: bounds 10000–1800000; anything outside is rejected', () => {
  for (const bad of [0, 9999, 1800001, -1, 'not-a-number', NaN, Infinity]) {
    const result = validateControllerConfig({
      type: 'fujipicpro',
      name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
      gatewayTimeoutMs: bad,
    });
    assert.equal(result.valid, false, `${JSON.stringify(bad)} must be rejected`);
    assert.match(result.errors.join('|'), /gatewayTimeoutMs must be a number between/);
  }
});

test('gatewayTimeoutMs: accepts numeric string within bounds', () => {
  const result = validateControllerConfig({
    type: 'fujipicpro',
    name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
    gatewayTimeoutMs: '60000',
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.gatewayTimeoutMs, 60000);
});

test('buildTimeoutMs: bounds 60000–86400000; anything outside is rejected', () => {
  for (const bad of [0, 59999, 86400001, -1, 'nope', NaN, Infinity]) {
    const result = validateControllerConfig({
      type: 'fujipicpro',
      name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
      buildTimeoutMs: bad,
    });
    assert.equal(result.valid, false, `${JSON.stringify(bad)} must be rejected`);
    assert.match(result.errors.join('|'), /buildTimeoutMs must be a number between/);
  }
});

test('sendReleaseCommand + includeCustomerName: strict boolean semantics (default false)', () => {
  // Falsy but non-boolean values must not accidentally enable the toggle
  // — auto-print + back-print-of-customer-name are both operator-
  // visible side effects worth guarding.
  for (const raw of [undefined, null, 0, '', 'true', 'false', 1, {}]) {
    const result = validateControllerConfig({
      type: 'fujipicpro',
      name: 'x', orderDataPath: 'a', diginPath: 'b', imageStagingRoot: 'c',
      sendReleaseCommand: raw,
      includeCustomerName: raw,
    });
    assert.equal(result.valid, true);
    assert.equal(result.normalized.sendReleaseCommand, raw === true,
      `sendReleaseCommand with raw=${JSON.stringify(raw)} must only be true when raw === true`);
    assert.equal(result.normalized.includeCustomerName, raw === true,
      `includeCustomerName with raw=${JSON.stringify(raw)} must only be true when raw === true`);
  }
});

test('non-object input is rejected cleanly', () => {
  // typeof [] === 'object' in JS, so arrays fall through the guard
  // and are rejected via the required-fields checks below rather than
  // this branch. That's the same shape as JobMaker's validator and
  // fine as long as they're rejected somehow — this test pins the
  // early-exit branch that catches genuine non-objects.
  for (const bad of [null, undefined, 'nope', 42]) {
    const result = validateControllerConfig(bad);
    assert.equal(result.valid, false);
    assert.equal(result.normalized, null);
    assert.match(result.errors[0], /controller must be an object/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// validateProductMappingConfig
// ─────────────────────────────────────────────────────────────────────────────

test('valid minimal mapping fills surfaceCode + defaults color to C', () => {
  const result = validateProductMappingConfig({
    controllerId: 'ctrl-1',
    productCode:  'PROD-6X4',
    printCode:    '64',            // lab-defined package code, not a size
    printSize:    '6x4',
    surface:      'Lustre',
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.normalized.color,       'C', 'color defaults to Colour when unset');
  assert.equal(result.normalized.surfaceCode, 'L', 'surfaceCode defaults to first letter uppercase');
  assert.equal(result.normalized.printSize,   '6x4');
  assert.deepEqual(result.normalized.options, {});
  assert.equal(result.normalized.isActive, true);
});

test('explicit surfaceCode wins over auto-derived; explicit color persists uppercase', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c', productCode: 'p',
    printCode: '64', printSize: '6x4',
    surface: 'Glossy', surfaceCode: 'Glo', color: 'b',
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.surfaceCode, 'Glo');
  assert.equal(result.normalized.color,       'B', 'lower-case operator input is normalised to uppercase for the printer');
});

test('color accepts every value in the spec set (C/B/S/S2/S3)', () => {
  for (const c of ['C', 'B', 'S', 'S2', 'S3']) {
    const result = validateProductMappingConfig({
      controllerId: 'c', productCode: 'p',
      printCode: '64', printSize: '6x4', surface: 'L', color: c,
    });
    assert.equal(result.valid, true, `color=${c} must be accepted`);
    assert.equal(result.normalized.color, c);
  }
});

test('color rejects values outside the spec set', () => {
  for (const c of ['G', 'RGB', 'x', 's4']) {
    const result = validateProductMappingConfig({
      controllerId: 'c', productCode: 'p',
      printCode: '64', printSize: '6x4', surface: 'L', color: c,
    });
    assert.equal(result.valid, false, `color=${JSON.stringify(c)} must be rejected`);
    assert.match(result.errors.join('|'), /color must be one of/);
  }
});

test('options object is preserved with values coerced to strings', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c', productCode: 'p',
    printCode: '64', printSize: '6x4', surface: 'L',
    options: { Finish: 'Lustre', Quantity: 4, Border: null },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.normalized.options, { Finish: 'Lustre', Quantity: '4', Border: '' });
});

test('options as array is rejected', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c', productCode: 'p',
    printCode: '64', printSize: '6x4', surface: 'L',
    options: [['Finish', 'Lustre']],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /options must be a plain object/);
});

test('mapping requires controllerId, productCode, printCode, printSize, surface', () => {
  const result = validateProductMappingConfig({});
  assert.equal(result.valid, false);
  const errs = result.errors.join('|');
  assert.match(errs, /controllerId is required/);
  assert.match(errs, /productCode is required/);
  assert.match(errs, /printCode is required/);
  assert.match(errs, /printSize is required/);
  assert.match(errs, /surface is required/);
});

test('printSize accepts bare WxH shapes (shared regex with JobMaker)', () => {
  for (const size of ['6x4', '3.5x5', '8 x 10', '8X8', '8×8']) {
    const result = validateProductMappingConfig({
      controllerId: 'c', productCode: 'p',
      printCode: '64', printSize: size, surface: 'L',
    });
    assert.equal(result.valid, true, `${size}: ${result.errors.join('; ')}`);
  }
});

test('printSize rejects non-WxH shapes (KG, 2L, half-shapes)', () => {
  for (const size of ['KG', '2L', '4x', 'x6']) {
    const result = validateProductMappingConfig({
      controllerId: 'c', productCode: 'p',
      printCode: '64', printSize: size, surface: 'L',
    });
    assert.equal(result.valid, false, `${size} must be rejected`);
    assert.match(result.errors.join('|'), /printSize must be a bare WxH shape/);
  }
});

test('valid mapping with isActive=false', () => {
  const result = validateProductMappingConfig({
    controllerId: 'c', productCode: 'p',
    printCode: '64', printSize: '6x4', surface: 'L', isActive: false,
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.isActive, false);
});

test('non-object mapping rejected cleanly', () => {
  const result = validateProductMappingConfig('not a mapping');
  assert.equal(result.valid, false);
  assert.equal(result.normalized, null);
});
