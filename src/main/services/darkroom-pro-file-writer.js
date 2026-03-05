'use strict';

const fs = require('fs');
const path = require('path');

/**
 * DarkroomProFileWriter
 *
 * Writes the Darkroom Pro order file (.TXT) to the controller's hot folder.
 *
 * Unlike the DPOF pipeline (which creates a subfolder + copies images),
 * Darkroom Pro only needs a single .TXT file written to the watch folder root.
 * Images are NOT copied — Darkroom Pro reads them from their absolute Filepath= paths.
 *
 * See: docs/print-controllers/DARKROOM-PRO-FORMAT.md
 */
class DarkroomProFileWriter {
  /**
   * Write the order file to the hot folder.
   *
   * @param {string} hotFolderPath   - Absolute path to the controller's watch folder
   * @param {string} orderNumber     - Used to construct the filename: Order{n}.TXT
   * @param {string} fileContent     - Content from DarkroomProGenerator.generate()
   * @returns {Promise<string>}      - Absolute path to the written .TXT file
   */
  async writeOrderFile(hotFolderPath, orderNumber, fileContent) {
    // Ensure the hot folder exists
    if (!fs.existsSync(hotFolderPath)) {
      throw new Error(`Darkroom Pro hot folder does not exist: ${hotFolderPath}`);
    }

    const filename = `Order${orderNumber}.TXT`;
    const filePath = path.join(hotFolderPath, filename);

    await fs.promises.writeFile(filePath, fileContent, 'utf-8');

    return filePath;
  }
}

const darkroomProFileWriter = new DarkroomProFileWriter();
module.exports = { darkroomProFileWriter, DarkroomProFileWriter };
