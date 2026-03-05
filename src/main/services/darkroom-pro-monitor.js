'use strict';

const fs = require('fs');
const path = require('path');

/**
 * DarkroomProMonitor
 *
 * Watches a Darkroom Pro hot folder for status changes on submitted order files.
 *
 * Unlike the DPOF FolderMonitor (which watches for folder prefix renames),
 * this monitor watches for two distinct file-level events:
 *
 *   ACCEPTED: The .TXT file disappears from the watch folder root
 *             (Darkroom Pro moves it to a 'processed' subfolder).
 *
 *   FAILED:   A .err file appears in the watch folder root with the same
 *             base name as the submitted .TXT file
 *             (Darkroom Pro renames Order1000.TXT → Order1000.err in-place).
 *
 * This is a class (not a singleton) so PrintControllerService can create
 * one instance per Darkroom Pro controller, matching how FolderMonitor works.
 *
 * See: docs/print-controllers/DARKROOM-PRO-FORMAT.md
 */
class DarkroomProMonitor {
  constructor() {
    this.watcher = null;
    this.hotFolderPath = null;
    this.processedFolderName = 'processed';
    this.callback = null;

    // Map of baseName (without extension) → orderNumber
    // e.g. 'Order1000' → '1000'
    this.trackedFiles = new Map();
  }

  /**
   * Start monitoring the hot folder.
   *
   * @param {string}   hotFolderPath        - Absolute path to the watch folder
   * @param {string}   processedFolderName  - Name of the subfolder DP moves accepted files to
   * @param {Function} callback             - Called with { orderNumber, status, timestamp }
   *                                         status: 'accepted' | 'failed'
   */
  startMonitoring(hotFolderPath, processedFolderName, callback) {
    this.hotFolderPath = hotFolderPath;
    this.processedFolderName = processedFolderName || 'processed';
    this.callback = callback;

    // Scan existing .TXT files on startup so we can track them
    try {
      const entries = fs.readdirSync(hotFolderPath);
      for (const entry of entries) {
        if (entry.toUpperCase().endsWith('.TXT')) {
          const baseName = entry.slice(0, -4); // strip .TXT
          const orderNumber = this._extractOrderNumber(baseName);
          if (orderNumber !== null) {
            this.trackedFiles.set(baseName.toLowerCase(), orderNumber);
          }
        }
      }
    } catch (err) {
      // If we can't read the folder on startup, continue anyway
    }

    this.watcher = fs.watch(hotFolderPath, (eventType, filename) => {
      if (!filename) return;
      // Debounce — give the file system time to complete the operation
      setTimeout(() => this._handleChange(filename), 500);
    });
  }

  /**
   * Handle a filesystem event in the watch folder.
   */
  _handleChange(filename) {
    const upper = filename.toUpperCase();
    const fullPath = path.join(this.hotFolderPath, filename);
    const exists = fs.existsSync(fullPath);

    // ── Case 1: A .TXT file appeared (new submission — track it) ──
    if (upper.endsWith('.TXT') && exists) {
      const baseName = filename.slice(0, -4);
      const orderNumber = this._extractOrderNumber(baseName);
      if (orderNumber !== null) {
        this.trackedFiles.set(baseName.toLowerCase(), orderNumber);
      }
      return;
    }

    // ── Case 2: A .TXT file disappeared (accepted — moved to processed/) ──
    if (upper.endsWith('.TXT') && !exists) {
      const baseName = filename.slice(0, -4);
      const key = baseName.toLowerCase();
      const orderNumber = this.trackedFiles.get(key);

      if (orderNumber !== null && orderNumber !== undefined) {
        this.trackedFiles.delete(key);
        this.callback({
          orderNumber,
          status: 'accepted',
          timestamp: new Date()
        });
      }
      return;
    }

    // ── Case 3: A .err file appeared (failed — DP renamed .TXT → .err) ──
    if (upper.endsWith('.ERR') && exists) {
      const baseName = filename.slice(0, -4);
      const key = baseName.toLowerCase();

      // The .err base name matches the submitted .TXT base name
      const orderNumber = this.trackedFiles.get(key);

      if (orderNumber !== null && orderNumber !== undefined) {
        this.trackedFiles.delete(key);
        this.callback({
          orderNumber,
          status: 'failed',
          timestamp: new Date()
        });
      } else {
        // Even if we didn't track it (e.g. app restarted mid-job), try to parse
        const parsed = this._extractOrderNumber(baseName);
        if (parsed !== null) {
          this.callback({
            orderNumber: parsed,
            status: 'failed',
            timestamp: new Date()
          });
        }
      }
    }
  }

  /**
   * Extract the order number from an Order file base name.
   * e.g. 'Order1000' → '1000'
   *      'Order100456' → '100456'
   *
   * Returns null if the filename doesn't match the expected pattern.
   */
  _extractOrderNumber(baseName) {
    const match = baseName.match(/^[Oo]rder(.+)$/);
    if (!match) return null;
    return match[1];
  }

  /**
   * Register a file that OHD has just submitted, so the monitor can track it
   * even if the fs.watch event fires before this method is called.
   *
   * Call this immediately after DarkroomProFileWriter.writeOrderFile() returns.
   *
   * @param {string} orderNumber
   */
  trackSubmission(orderNumber) {
    const baseName = `order${orderNumber}`;
    this.trackedFiles.set(baseName, orderNumber);
  }

  stopMonitoring() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.trackedFiles.clear();
    this.hotFolderPath = null;
    this.callback = null;
  }
}

module.exports = { DarkroomProMonitor };
