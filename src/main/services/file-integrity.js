/**
 * src/main/services/file-integrity.js
 *
 * Synchronous magic-byte check for downloaded image files. Used by the
 * FTP service to detect corruption (e.g., sparse-allocated leading-zero
 * files from interrupted upstream uploads — see
 * docs/ai-quality-gate/conversion-audit.md "Production Observation:
 * Download-Side Corruption with Cached Size-Match" for context).
 *
 * Magic byte signatures recognised:
 *   JPEG: FF D8 FF                       (3 bytes — covers JFIF, EXIF, raw)
 *   PNG:  89 50 4E 47 0D 0A 1A 0A        (8 bytes — full PNG signature)
 *
 * Anything else is treated as invalid. The caller decides what to do.
 */

'use strict';

const fs = require('fs');

/**
 * Inspect the first 8 bytes of a file and decide whether they match a
 * supported image magic.
 *
 * Synchronous on purpose — called from inside the FTP download loop and
 * we don't want to introduce additional async cycles. The cost is one
 * 8-byte read per file (negligible vs the download itself).
 *
 * Returns one of:
 *   { valid: true,  format: 'jpeg' | 'png', magicHex: '<hex>' }
 *   { valid: false, format: null, magicHex: '<hex>' }
 *   { valid: false, format: null, magicHex: null, error: '<msg>' }   // I/O error
 *
 * For the invalid-but-readable case, magicHex carries the actual leading
 * bytes seen (truncated to the file's size if shorter than 8). This
 * makes the failure log line diagnostically useful — operators can
 * spot a sparse-allocated leading-zeros file as `00000000...`, an
 * HTML error page as `3c21444f...` (`<!DO`), etc.
 */
function checkImageMagic(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);

    if (n < 3) {
      // Smaller than even the JPEG signature — definitely not an image.
      return {
        valid: false,
        format: null,
        magicHex: buf.slice(0, n).toString('hex'),
      };
    }

    // JPEG: 3-byte signature, check first since it's shorter
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return {
        valid: true,
        format: 'jpeg',
        magicHex: buf.slice(0, 3).toString('hex'),
      };
    }

    // PNG: 8-byte signature, must have read all 8 bytes
    if (
      n >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return {
        valid: true,
        format: 'png',
        magicHex: buf.toString('hex'),
      };
    }

    return {
      valid: false,
      format: null,
      magicHex: buf.slice(0, n).toString('hex'),
    };
  } catch (err) {
    return {
      valid: false,
      format: null,
      magicHex: null,
      error: err.message,
    };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

module.exports = {
  checkImageMagic,
};
