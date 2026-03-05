'use strict';

const fs = require('fs');
const path = require('path');
const configService = require('./config-service');
const logger = require('./logger');

/**
 * DPI Validator Service
 *
 * Reads image pixel dimensions from file headers (no external dependencies —
 * pure Node.js Buffer reads for JPEG, PNG, and TIFF) and calculates effective
 * print DPI based on the configured print size from the order manifest.
 *
 * Status levels (driven by user-configured thresholds):
 *   excellent — DPI >= excellentThreshold
 *   good      — DPI >= warningThreshold AND < excellentThreshold
 *   warning   — DPI >= poorThreshold AND < warningThreshold
 *   poor      — DPI < poorThreshold
 *   blocked   — DPI is critically low (< poorThreshold AND canAutoSubmit=false)
 */
class DpiValidator {

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the current DPI validation settings from config.
   */
  getSettings() {
    return {
      enabled: configService.get('dpiValidationEnabled') !== false, // default true
      excellentThreshold: configService.get('dpiExcellentThreshold') || 300,
      warningThreshold: {
        dpi: configService.get('dpiWarningThreshold') || 275,
        allowAutoSubmit: configService.get('dpiWarningAllowAutoSubmit') !== false // default true
      },
      poorThreshold: {
        dpi: configService.get('dpiPoorThreshold') || 200,
        allowAutoSubmit: configService.get('dpiPoorAllowAutoSubmit') || false // default false
      }
    };
  }

  /**
   * Validate all images in a job manifest.
   *
   * @param {string} orderFolderPath  Absolute path to the order folder
   * @param {object} jobManifest      { images: [{ filename, size, quantity }] }
   * @returns {object} {
   *   valid: boolean,
   *   canAutoSubmit: boolean,
   *   requiresManualApproval: boolean,
   *   overallStatus: 'excellent'|'good'|'warning'|'poor',
   *   images: [ <per-image result> ]
   * }
   */
  async validateJob(orderFolderPath, jobManifest) {
    const settings = this.getSettings();

    if (!settings.enabled) {
      return {
        valid: true,
        canAutoSubmit: true,
        requiresManualApproval: false,
        overallStatus: 'excellent',
        images: [],
        disabled: true
      };
    }

    if (!jobManifest || !Array.isArray(jobManifest.images) || jobManifest.images.length === 0) {
      return {
        valid: false,
        canAutoSubmit: false,
        requiresManualApproval: false,
        overallStatus: 'poor',
        images: [],
        error: 'No images found in job manifest'
      };
    }

    const imageResults = [];

    for (const img of jobManifest.images) {
      const result = await this._validateImage(orderFolderPath, img, settings);
      imageResults.push(result);
    }

    // Overall status = worst individual status
    const statusRank = { excellent: 0, good: 1, warning: 2, poor: 3 };
    const worstResult = imageResults.reduce((worst, r) => {
      return statusRank[r.status] > statusRank[worst.status] ? r : worst;
    }, imageResults[0]);

    const overallStatus = worstResult.status;
    const canAutoSubmit = imageResults.every(r => r.canAutoSubmit);
    const requiresManualApproval = !canAutoSubmit;
    const valid = overallStatus !== 'poor' || settings.poorThreshold.allowAutoSubmit;

    logger.info('DPI validation complete', {
      imageCount: imageResults.length,
      overallStatus,
      canAutoSubmit,
      requiresManualApproval,
      worst: worstResult.actualDPI
    });

    return {
      valid,
      canAutoSubmit,
      requiresManualApproval,
      overallStatus,
      images: imageResults
    };
  }

  /**
   * Validate a batch of jobs at once.
   * Returns a map of jobId -> validation result.
   */
  async validateBatch(jobs, orderFolderPath) {
    const results = {};
    for (const job of jobs) {
      try {
        results[job.jobId] = await this.validateJob(orderFolderPath, job);
      } catch (err) {
        results[job.jobId] = { valid: false, canAutoSubmit: false, error: err.message };
      }
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-image validation
  // ─────────────────────────────────────────────────────────────────────────

  async _validateImage(orderFolderPath, img, settings) {
    const filePath = path.join(orderFolderPath, img.filename);

    // Parse the print size
    let printWidth, printHeight;
    try {
      const parsed = this._parsePrintSize(img.size);
      printWidth = parsed.widthIn;
      printHeight = parsed.heightIn;
    } catch (err) {
      return this._errorResult(img, `Cannot parse print size "${img.size}": ${err.message}`);
    }

    // Read pixel dimensions
    let pixelWidth, pixelHeight;
    try {
      const dims = this._getImageDimensions(filePath);
      pixelWidth = dims.width;
      pixelHeight = dims.height;
    } catch (err) {
      return this._errorResult(img, `Cannot read image dimensions: ${err.message}`);
    }

    // Calculate effective DPI
    // Orient pixels to match print orientation
    const { pw, ph } = this._orientDimensions(pixelWidth, pixelHeight, printWidth, printHeight);
    const dpiX = pw / printWidth;
    const dpiY = ph / printHeight;
    const actualDPI = Math.round(Math.min(dpiX, dpiY));

    // Determine status
    const status = this._classifyDPI(actualDPI, settings);

    // Determine canAutoSubmit
    const canAutoSubmit = this._canAutoSubmit(status, settings);

    // Build messages
    const { message, recommendation } = this._buildMessages(status, actualDPI, settings, img.size);

    return {
      filename: img.filename,
      imageWidth: pixelWidth,
      imageHeight: pixelHeight,
      printSize: img.size,
      printWidthInches: printWidth,
      printHeightInches: printHeight,
      actualDPI,
      requiredDPI: settings.excellentThreshold,
      status,
      canAutoSubmit,
      requiresManualApproval: !canAutoSubmit,
      message,
      recommendation,
      valid: status !== 'poor' || settings.poorThreshold.allowAutoSubmit
    };
  }

  _errorResult(img, errorMsg) {
    return {
      filename: img.filename,
      imageWidth: null,
      imageHeight: null,
      printSize: img.size,
      actualDPI: null,
      requiredDPI: null,
      status: 'poor',
      canAutoSubmit: false,
      requiresManualApproval: true,
      valid: false,
      message: errorMsg,
      recommendation: 'Check that the image file exists and is a valid JPEG, PNG, or TIFF.'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DPI classification
  // ─────────────────────────────────────────────────────────────────────────

  _classifyDPI(dpi, settings) {
    if (dpi >= settings.excellentThreshold) return 'excellent';
    if (dpi >= settings.warningThreshold.dpi) return 'good';
    if (dpi >= settings.poorThreshold.dpi) return 'warning';
    return 'poor';
  }

  _canAutoSubmit(status, settings) {
    if (status === 'excellent' || status === 'good') return true;
    if (status === 'warning') return settings.warningThreshold.allowAutoSubmit;
    if (status === 'poor') return settings.poorThreshold.allowAutoSubmit;
    return false;
  }

  _buildMessages(status, dpi, settings, printSize) {
    switch (status) {
      case 'excellent':
        return {
          message: `Excellent resolution at ${dpi} DPI — ideal print quality.`,
          recommendation: ''
        };
      case 'good':
        return {
          message: `Good resolution at ${dpi} DPI — print quality is acceptable.`,
          recommendation: ''
        };
      case 'warning':
        return {
          message: `Resolution is ${dpi} DPI — below the recommended ${settings.excellentThreshold} DPI for ${printSize}.`,
          recommendation: `Consider using a smaller print size for best quality.`
        };
      case 'poor':
        return {
          message: `Poor resolution at ${dpi} DPI — image may appear pixelated at ${printSize}.`,
          recommendation: `Use a higher-resolution image or reduce the print size.`
        };
      default:
        return { message: 'Unknown DPI status.', recommendation: '' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Parse print size string
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse "4x6" → { widthIn: 4, heightIn: 6 }
   * Handles formats: "4x6", "4X6", "8.5x11", "20x30cm" (cm converted to inches)
   */
  _parsePrintSize(sizeStr) {
    if (!sizeStr) throw new Error('Size string is empty');

    const s = String(sizeStr).toLowerCase().trim();
    const isCm = s.endsWith('cm');
    const cleaned = s.replace('cm', '').trim();
    const parts = cleaned.split('x');

    if (parts.length !== 2) {
      throw new Error(`Expected format like "4x6", got "${sizeStr}"`);
    }

    let w = parseFloat(parts[0]);
    let h = parseFloat(parts[1]);

    if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) {
      throw new Error(`Invalid dimensions in "${sizeStr}"`);
    }

    if (isCm) {
      w = w / 2.54;
      h = h / 2.54;
    }

    return { widthIn: w, heightIn: h };
  }

  /**
   * Orient pixel dimensions to match print orientation.
   * If print is landscape and pixels are portrait (or vice versa), swap pixels.
   */
  _orientDimensions(pixelW, pixelH, printW, printH) {
    const pixelLandscape = pixelW >= pixelH;
    const printLandscape = printW >= printH;
    if (pixelLandscape !== printLandscape) {
      return { pw: pixelH, ph: pixelW };
    }
    return { pw: pixelW, ph: pixelH };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Image dimension reading — pure Node.js, no npm deps
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Read pixel dimensions from image file header.
   * Supports JPEG, PNG, TIFF.
   * Returns { width, height } in pixels.
   */
  _getImageDimensions(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read a chunk large enough for any header (64 KB covers even complex JPEGs)
    const CHUNK = 65536;
    const fd = fs.openSync(filePath, 'r');
    let buf;
    try {
      const stat = fs.fstatSync(fd);
      const readLen = Math.min(CHUNK, stat.size);
      buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, 0);
    } finally {
      fs.closeSync(fd);
    }

    // Detect format by magic bytes
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) {
      return this._readJpegDimensions(buf, filePath);
    }

    if (buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return this._readPngDimensions(buf);
    }

    if (buf.length >= 4 &&
        ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4D && buf[1] === 0x4D))) {
      return this._readTiffDimensions(buf);
    }

    throw new Error(`Unsupported image format: ${path.extname(filePath)}`);
  }

  // ── JPEG ──────────────────────────────────────────────────────────────────

  /**
   * Scan JPEG markers to find SOF0/SOF1/SOF2 (0xFFC0/FFC1/FFC2) which contain
   * the image height and width.
   */
  _readJpegDimensions(buf, filePath) {
    let offset = 2; // skip FF D8

    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xFF) {
        // Re-sync: scan for next 0xFF
        offset++;
        continue;
      }

      const marker = buf[offset + 1];
      offset += 2;

      // Skip padding bytes
      if (marker === 0xFF) {
        continue;
      }

      // SOF markers that carry image dimensions
      // 0xC0=SOF0, 0xC1=SOF1, 0xC2=SOF2 (progressive), 0xC3=SOF3
      // 0xC5=SOF5 ... 0xC7=SOF7, 0xC9=SOF9 ... 0xCB=SOF11, 0xCD=SOF13 ... 0xCF=SOF15
      // Exclude DHT (0xC4), DAC (0xCC)
      if ((marker >= 0xC0 && marker <= 0xC3) ||
          (marker >= 0xC5 && marker <= 0xC7) ||
          (marker >= 0xC9 && marker <= 0xCB) ||
          (marker >= 0xCD && marker <= 0xCF)) {
        // Length (2 bytes) — skip it, then: 1 byte precision, 2 bytes height, 2 bytes width
        if (offset + 7 > buf.length) break;
        const height = buf.readUInt16BE(offset + 3);
        const width  = buf.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }

      // Markers with no length field (standalone)
      if (marker === 0xD8 || marker === 0xD9 ||
          (marker >= 0xD0 && marker <= 0xD7)) {
        continue;
      }

      // All other segments: skip by length
      if (offset + 2 > buf.length) break;
      const segLen = buf.readUInt16BE(offset);
      offset += segLen;
    }

    // Buffer was not large enough — need to read more of the file
    // This handles very large JPEG headers (rare, but possible with EXIF)
    throw new Error(`Could not find JPEG SOF marker in first 64KB of ${path.basename(filePath)}`);
  }

  // ── PNG ───────────────────────────────────────────────────────────────────

  /**
   * PNG IHDR chunk is always at byte offset 16 (8-byte sig + 4-len + 4-type).
   * Width = bytes 16-19 (big-endian uint32)
   * Height = bytes 20-23 (big-endian uint32)
   */
  _readPngDimensions(buf) {
    if (buf.length < 24) {
      throw new Error('PNG file too small to read dimensions');
    }
    const width  = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  }

  // ── TIFF ──────────────────────────────────────────────────────────────────

  /**
   * Read TIFF IFD tags 256 (ImageWidth) and 257 (ImageLength).
   * Supports both little-endian (II) and big-endian (MM) TIFF files.
   */
  _readTiffDimensions(buf) {
    const littleEndian = buf[0] === 0x49; // 'II' = little-endian

    const readUInt16 = (offset) => littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
    const readUInt32 = (offset) => littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);

    // IFD offset at bytes 4-7
    const ifdOffset = readUInt32(4);

    if (ifdOffset + 2 > buf.length) {
      throw new Error('TIFF IFD offset beyond read buffer');
    }

    const numEntries = readUInt16(ifdOffset);
    let width = null;
    let height = null;

    for (let i = 0; i < numEntries; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > buf.length) break;

      const tag = readUInt16(entryOffset);
      const type = readUInt16(entryOffset + 2);
      // const count = readUInt32(entryOffset + 4); // not needed
      const valueOffset = entryOffset + 8;

      // type 3 = SHORT (uint16), type 4 = LONG (uint32)
      let value;
      if (type === 3) {
        value = readUInt16(valueOffset);
      } else if (type === 4) {
        value = readUInt32(valueOffset);
      }

      if (tag === 256) width  = value; // ImageWidth
      if (tag === 257) height = value; // ImageLength

      if (width !== null && height !== null) break;
    }

    if (!width || !height) {
      throw new Error('Could not read ImageWidth/ImageLength tags from TIFF');
    }

    return { width, height };
  }
}

const dpiValidator = new DpiValidator();
module.exports = { dpiValidator, DpiValidator };
