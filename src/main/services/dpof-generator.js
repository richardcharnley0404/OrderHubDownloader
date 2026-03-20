'use strict';

/**
 * src/main/services/dpof-generator.js
 *
 * Generates AUTPRINT.MRK files for DPOF-based print controllers.
 *
 * Two MRK dialects are supported, selected by the controllerType param:
 *
 *   'noritsu' (default) — Noritsu VUQ extension format:
 *     Header:   USR NAM + USR CID
 *     Per-job:  PRT CVP1=1 -STR "ORDER, PID" / PRT CVP2=0
 *
 *   'epson' — Epson Surelab format:
 *     Header:   USR NAM only (no USR CID)
 *     Per-job:  PRT CVP1="filename" / PRT CVP2="timestamp"
 *
 * Output uses CRLF line endings and ASCII encoding as required by
 * Windows-based print controllers.
 */

class DPOFGenerator {
  /**
   * Generate the content of an AUTPRINT.MRK file.
   *
   * @param {object} params
   * @param {string}   params.orderNumber    - e.g. "002296"
   * @param {string}   params.customerName   - e.g. "Elizabeth Hammond"
   * @param {number}   params.channelNumber  - Print channel, e.g. 1
   * @param {string}   params.printSizeCode  - e.g. "KG", "2L", 'NML -PSIZE "8x4"'
   * @param {Array}    params.images         - [{ filename: string, quantity: number }]
   * @param {Date}     [params.timestamp]    - Defaults to now
   * @param {string}   [params.controllerType] - 'noritsu' (default) or 'epson'
   * @returns {string} AUTPRINT.MRK content with CRLF line endings
   */
  generate({ orderNumber, customerName, channelNumber, printSizeCode, images, timestamp = new Date(), controllerType = 'noritsu' }) {
    const pad3    = n => String(n).padStart(3, '0');
    const dt      = this.formatTimestamp(timestamp);
    const isEpson = (controllerType === 'epson');

    const lines = [];

    // ── HEADER ──────────────────────────────────────────────────────────────
    lines.push('[HDR]');
    lines.push('GEN REV=01.00');
    lines.push('GEN CRT="OHD" 1.00');
    lines.push(`GEN DTM=${dt}`);
    lines.push(`USR NAM="${customerName}"`);
    // Noritsu uses a separate CID field; Epson Surelab uses NAM only.
    if (!isEpson) {
      lines.push(`USR CID="${orderNumber}"`);
    }
    if (!isEpson) lines.push('AUTO CORRECT=0');
    lines.push('VUQ RGN=BGN');
    lines.push('VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"');
    lines.push('VUQ VER=01.00');
    lines.push(`PRT PSL=${printSizeCode}`);
    lines.push(`PRT PCH=${pad3(channelNumber)}`);
    lines.push('VUQ RGN=END');

    // ── JOBS ────────────────────────────────────────────────────────────────
    images.forEach((image, index) => {
      const pid = pad3(index + 1);
      lines.push('[JOB]');
      lines.push(`PRT PID=${pid}`);
      lines.push('PRT TYP=STD');
      lines.push(`PRT QTY=${pad3(image.quantity)}`);
      lines.push('IMG FMT=EXIF2 -J');
      lines.push(`<IMG SRC="../IMAGE/${image.filename}">`);
      lines.push('VUQ RGN=BGN');
      lines.push('VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"');
      lines.push('VUQ VER=01.00');
      if (isEpson) {
        // Epson Surelab: CVP1 = filename, CVP2 = print timestamp
        lines.push(`PRT CVP1="${image.filename}"`);
        lines.push(`PRT CVP2="${dt}"`);
      } else {
        // Noritsu: CVP1 = order + photo ID string, CVP2 disabled
        lines.push(`PRT CVP1=1 -STR "${orderNumber}, ${pid}"`);
        lines.push('PRT CVP2=0');
      }
      lines.push('VUQ RGN=END');
    });

    // CRLF required for Windows-based print controllers
    return lines.join('\r\n') + '\r\n';
  }

  /**
   * Format a Date as YYYY:MM:DD:HH:MM:SS (DPOF timestamp format).
   */
  formatTimestamp(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join(':');
  }
}

const dpofGenerator = new DPOFGenerator();
module.exports = { dpofGenerator, DPOFGenerator };
