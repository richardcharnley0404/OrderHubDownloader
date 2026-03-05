'use strict';

/**
 * Test script for DPI Validation system.
 *
 * Usage (from project root):
 *   node scripts/test-dpi-validation.js
 *
 * This script directly exercises DpiValidator without running the full Electron
 * app — it uses synthetic test cases (creating small in-memory JPEG/PNG buffers
 * with known dimensions) and verifies the DPI calculations and threshold logic.
 *
 * Note: config-service uses electron-store which requires Electron. To avoid that
 * dependency, this script injects settings directly via a mock.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Mock config-service before requiring dpi-validator ─────────────────────

const mockSettings = {
  dpiValidationEnabled: true,
  dpiExcellentThreshold: 300,
  dpiWarningThreshold: 275,
  dpiWarningAllowAutoSubmit: true,
  dpiPoorThreshold: 200,
  dpiPoorAllowAutoSubmit: false
};

// Stub out electron-store / config-service
const Module = require('module');
const _origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  if (request === 'electron-store' || request.includes('config-service')) {
    // Return a minimal stub
    if (request.includes('config-service')) {
      return {
        get: (key) => mockSettings[key],
        getAll: () => mockSettings
      };
    }
    // electron-store stub
    return class Store {
      constructor() { this._data = {}; }
      get(k, def) { return this._data[k] !== undefined ? this._data[k] : def; }
      set(k, v) { this._data[k] = v; }
    };
  }
  return _origLoad(request, parent, isMain);
};

// Also stub logger
Module._load = (function (orig) {
  return function (request, parent, isMain) {
    if (request.includes('logger')) {
      return {
        info: (...a) => console.log('[LOG]', ...a),
        logError: (...a) => console.error('[ERR]', ...a),
        logWarning: (...a) => console.warn('[WARN]', ...a)
      };
    }
    return orig(request, parent, isMain);
  };
})(Module._load);

// Now require the validator
const { DpiValidator } = require('../src/main/services/dpi-validator');

// ─── Synthetic image builders ────────────────────────────────────────────────

/**
 * Build a minimal valid JPEG buffer with the given pixel dimensions.
 * Uses a real JFIF structure with an SOF0 marker.
 */
function makeJpeg(width, height) {
  const buf = Buffer.alloc(32);
  let i = 0;
  // SOI
  buf[i++] = 0xFF; buf[i++] = 0xD8;
  // APP0 marker (JFIF) — length 16
  buf[i++] = 0xFF; buf[i++] = 0xE0;
  buf[i++] = 0x00; buf[i++] = 0x10; // length = 16
  buf.write('JFIF\0', i); i += 5;
  buf[i++] = 0x01; buf[i++] = 0x01; // version
  buf[i++] = 0x00;                   // units = 0 (no units)
  buf.writeUInt16BE(96, i); i += 2;  // Xdensity
  buf.writeUInt16BE(96, i); i += 2;  // Ydensity
  buf[i++] = 0x00; buf[i++] = 0x00; // thumbnail size
  // SOF0 marker
  buf[i++] = 0xFF; buf[i++] = 0xC0;
  buf[i++] = 0x00; buf[i++] = 0x11; // length = 17
  buf[i++] = 0x08;                   // precision
  buf.writeUInt16BE(height, i); i += 2;
  buf.writeUInt16BE(width, i);
  return buf;
}

/**
 * Build a minimal valid PNG buffer with the given pixel dimensions.
 */
function makePng(width, height) {
  const buf = Buffer.alloc(24);
  // PNG signature
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
  buf[4] = 0x0D; buf[5] = 0x0A; buf[6] = 0x1A; buf[7] = 0x0A;
  // IHDR chunk: length=13, type='IHDR'
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS  ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL  ${label}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  DPI Validation — Test Suite');
  console.log('══════════════════════════════════════════════════════\n');

  const validator = new DpiValidator();
  const tmpDir = os.tmpdir();

  // ── Helper: write temp image and validate ──────────────────────────────
  async function validateImage(imgBuf, filename, printSize, overrideSettings) {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, imgBuf);

    const settings = overrideSettings || {
      enabled: true,
      excellentThreshold: 300,
      warningThreshold: { dpi: 275, allowAutoSubmit: true },
      poorThreshold: { dpi: 200, allowAutoSubmit: false }
    };

    const jobManifest = {
      images: [{ filename, size: printSize, quantity: 1 }]
    };

    const result = await validator.validateJob(tmpDir, jobManifest);
    fs.unlinkSync(filePath);
    return result;
  }

  // ── Test 1: Excellent quality — 4x6 print at 300 DPI ──────────────────
  console.log('Test 1: Excellent quality — 4×6 @ 300 DPI');
  {
    // 4"×6" × 300 DPI = 1200×1800 px
    const result = await validateImage(makeJpeg(1200, 1800), 'test1.jpg', '4x6');
    assert(result.overallStatus === 'excellent', `overallStatus = excellent (got ${result.overallStatus})`);
    assert(result.canAutoSubmit === true, 'canAutoSubmit = true');
    assert(result.images[0].actualDPI === 300, `actualDPI = 300 (got ${result.images[0].actualDPI})`);
  }

  // ── Test 2: Good quality — 4x6 @ 287 DPI ─────────────────────────────
  console.log('\nTest 2: Good quality — 4×6 @ ~287 DPI');
  {
    // 1148×1722 / 4 = 287 DPI
    const result = await validateImage(makeJpeg(1148, 1722), 'test2.jpg', '4x6');
    assert(result.overallStatus === 'good', `overallStatus = good (got ${result.overallStatus})`);
    assert(result.canAutoSubmit === true, 'canAutoSubmit = true');
  }

  // ── Test 3: Warning — 4x6 @ ~250 DPI, allowAutoSubmit=true ───────────
  console.log('\nTest 3: Warning — 4×6 @ 250 DPI, allowAutoSubmit=true');
  {
    // 1000×1500 / 4 = 250 DPI
    const result = await validateImage(makeJpeg(1000, 1500), 'test3.jpg', '4x6');
    assert(result.overallStatus === 'warning', `overallStatus = warning (got ${result.overallStatus})`);
    assert(result.canAutoSubmit === true, 'canAutoSubmit = true (warning allowAutoSubmit=true)');
    assert(result.requiresManualApproval === false, 'requiresManualApproval = false');
  }

  // ── Test 4: Warning — allowAutoSubmit=false ───────────────────────────
  console.log('\nTest 4: Warning — 4×6 @ 250 DPI, allowAutoSubmit=false');
  {
    const settings = {
      enabled: true,
      excellentThreshold: 300,
      warningThreshold: { dpi: 275, allowAutoSubmit: false },
      poorThreshold: { dpi: 200, allowAutoSubmit: false }
    };
    const filePath = path.join(tmpDir, 'test4.jpg');
    fs.writeFileSync(filePath, makeJpeg(1000, 1500));
    const jobManifest = { images: [{ filename: 'test4.jpg', size: '4x6', quantity: 1 }] };

    // Temporarily override the validator's getSettings
    const origGetSettings = validator.getSettings.bind(validator);
    validator.getSettings = () => settings;
    const result = await validator.validateJob(tmpDir, jobManifest);
    validator.getSettings = origGetSettings;
    fs.unlinkSync(filePath);

    assert(result.overallStatus === 'warning', `overallStatus = warning (got ${result.overallStatus})`);
    assert(result.canAutoSubmit === false, 'canAutoSubmit = false');
    assert(result.requiresManualApproval === true, 'requiresManualApproval = true');
  }

  // ── Test 5: Poor quality — 4x6 @ 150 DPI ─────────────────────────────
  console.log('\nTest 5: Poor quality — 4×6 @ 150 DPI');
  {
    // 600×900 / 4 = 150 DPI
    const result = await validateImage(makeJpeg(600, 900), 'test5.jpg', '4x6');
    assert(result.overallStatus === 'poor', `overallStatus = poor (got ${result.overallStatus})`);
    assert(result.canAutoSubmit === false, 'canAutoSubmit = false');
    assert(result.requiresManualApproval === true, 'requiresManualApproval = true');
  }

  // ── Test 6: Poor — allowAutoSubmit=true ──────────────────────────────
  console.log('\nTest 6: Poor quality — allowAutoSubmit=true');
  {
    const settings = {
      enabled: true,
      excellentThreshold: 300,
      warningThreshold: { dpi: 275, allowAutoSubmit: true },
      poorThreshold: { dpi: 200, allowAutoSubmit: true }
    };
    const filePath = path.join(tmpDir, 'test6.jpg');
    fs.writeFileSync(filePath, makeJpeg(600, 900));
    const jobManifest = { images: [{ filename: 'test6.jpg', size: '4x6', quantity: 1 }] };
    const origGetSettings = validator.getSettings.bind(validator);
    validator.getSettings = () => settings;
    const result = await validator.validateJob(tmpDir, jobManifest);
    validator.getSettings = origGetSettings;
    fs.unlinkSync(filePath);

    assert(result.overallStatus === 'poor', `overallStatus = poor (got ${result.overallStatus})`);
    assert(result.canAutoSubmit === true, 'canAutoSubmit = true (poor allowAutoSubmit=true)');
  }

  // ── Test 7: PNG format ─────────────────────────────────────────────────
  console.log('\nTest 7: PNG format — 8×10 @ 300 DPI');
  {
    // 2400×3000 / 8 = 300 DPI
    const result = await validateImage(makePng(2400, 3000), 'test7.png', '8x10');
    assert(result.overallStatus === 'excellent', `overallStatus = excellent (got ${result.overallStatus})`);
    assert(result.images[0].actualDPI === 300, `actualDPI = 300 (got ${result.images[0].actualDPI})`);
  }

  // ── Test 8: Landscape image / portrait print (auto-orient) ────────────
  console.log('\nTest 8: Landscape pixels, portrait print — should orient correctly');
  {
    // 1800×1200 pixels but print is 4×6 (portrait) → swap to 1200w×1800h → 300 DPI
    const result = await validateImage(makeJpeg(1800, 1200), 'test8.jpg', '4x6');
    assert(result.images[0].actualDPI === 300, `actualDPI = 300 after orientation (got ${result.images[0].actualDPI})`);
  }

  // ── Test 9: Multiple images — worst status wins ────────────────────────
  console.log('\nTest 9: Multiple images — worst status dominates');
  {
    const f1 = path.join(tmpDir, 'multi1.jpg');
    const f2 = path.join(tmpDir, 'multi2.jpg');
    fs.writeFileSync(f1, makeJpeg(1200, 1800)); // 300 DPI excellent
    fs.writeFileSync(f2, makeJpeg(600, 900));    // 150 DPI poor
    const jobManifest = {
      images: [
        { filename: 'multi1.jpg', size: '4x6', quantity: 1 },
        { filename: 'multi2.jpg', size: '4x6', quantity: 1 }
      ]
    };
    const result = await validator.validateJob(tmpDir, jobManifest);
    fs.unlinkSync(f1); fs.unlinkSync(f2);
    assert(result.overallStatus === 'poor', `overallStatus = poor when one image is poor (got ${result.overallStatus})`);
    assert(result.canAutoSubmit === false, 'canAutoSubmit = false');
    assert(result.images.length === 2, 'two image results returned');
  }

  // ── Test 10: DPI disabled — always passes ─────────────────────────────
  console.log('\nTest 10: DPI validation disabled');
  {
    const origGetSettings = validator.getSettings.bind(validator);
    validator.getSettings = () => ({ enabled: false });
    const filePath = path.join(tmpDir, 'test10.jpg');
    fs.writeFileSync(filePath, makeJpeg(100, 150)); // would be very poor
    const jobManifest = { images: [{ filename: 'test10.jpg', size: '4x6', quantity: 1 }] };
    const result = await validator.validateJob(tmpDir, jobManifest);
    validator.getSettings = origGetSettings;
    fs.unlinkSync(filePath);
    assert(result.disabled === true, 'disabled flag set');
    assert(result.canAutoSubmit === true, 'canAutoSubmit = true when disabled');
  }

  // ── Test 11: parsePrintSize ────────────────────────────────────────────
  console.log('\nTest 11: _parsePrintSize edge cases');
  {
    const p1 = validator._parsePrintSize('4x6');
    assert(p1.widthIn === 4 && p1.heightIn === 6, '4x6 parses correctly');

    const p2 = validator._parsePrintSize('8.5x11');
    assert(p2.widthIn === 8.5 && p2.heightIn === 11, '8.5x11 parses correctly');

    const p3 = validator._parsePrintSize('10x15cm');
    assert(Math.abs(p3.widthIn - 10 / 2.54) < 0.01, '10x15cm converts to inches');

    let threw = false;
    try { validator._parsePrintSize('invalid'); } catch { threw = true; }
    assert(threw, 'invalid size throws error');
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
