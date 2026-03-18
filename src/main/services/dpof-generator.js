'use strict';

/**
 * src/main/services/dpof-generator.js
 *
 * Generates AUTPRINT.MRK files in the unified Noritsu VUQ extension format.
 * This format is compatible with both Noritsu EZ Controller and Epson Order
 * Controller without modification.
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
   * @returns {string} AUTPRINT.MRK content with CRLF line endings
   */
  generate({ orderNumber, customerName, channelNumber, printSizeCode, images, timestamp = new Date() }) {
    const pad3 = n => String(n).padStart(3, '0');
    const dt   = this.formatTimestamp(timestamp);

    const lines = [];

    // ── HEADER ──────────────────────────────────────────────────────────────
    lines.push('[HDR]');
    lines.push('GEN REV=01.00');
    lines.push('GEN CRT="OHD" 1.00');
    lines.push(`GEN DTM=${dt}`);
    lines.push(`USR NAM="${customerName}"`);
    lines.push(`USR CID="${orderNumber}"`);
    lines.push('AUTO CORRECT=0');
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
      lines.push(`PRT CVP1=1 -STR "${orderNumber}, ${pid}"`);
      lines.push('PRT CVP2=0');
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
