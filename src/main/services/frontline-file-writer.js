'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * FrontlineFileWriter
 *
 * Creates the job output folder structure and writes the XML + copies all images:
 *
 *   {outputPath}/
 *   └── {jobId}/
 *       ├── {jobId}.xml
 *       ├── image1.jpg
 *       └── image2.jpg
 *
 * Frontline reads the XML and all sibling images from the job folder,
 * then deletes the folder automatically (removeAfterProcess="true").
 */
class FrontlineFileWriter {
  /**
   * Write the job folder to the Frontline hot folder path.
   *
   * @param {string} outputPath   - Absolute path to the Frontline hot folder (must exist)
   * @param {string|number} jobId - OrderHub job ID — used as the folder name and XML filename
   * @param {string} xmlContent   - XML string from FrontlineGenerator.generate()
   * @param {Array}  imageFiles   - [{ sourcePath: string, filename: string }]
   *                                 sourcePath: absolute local path to copy from
   *                                 filename:   basename written into the job folder
   * @returns {Promise<{ jobFolderPath: string, xmlPath: string }>}
   */
  async writeJobFolder(outputPath, jobId, xmlContent, imageFiles) {
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Frontline hot folder does not exist: ${outputPath}`);
    }

    const jobFolderPath = path.join(outputPath, String(jobId));

    // Create the job folder (ok if it already exists)
    await fs.promises.mkdir(jobFolderPath, { recursive: true });

    // Write the XML file
    const xmlFilename = `${jobId}.xml`;
    const xmlPath     = path.join(jobFolderPath, xmlFilename);
    await fs.promises.writeFile(xmlPath, xmlContent, 'utf-8');

    // Copy all image files into the job folder
    for (const img of imageFiles) {
      const destPath = path.join(jobFolderPath, img.filename);
      await fs.promises.copyFile(img.sourcePath, destPath);
    }

    return { jobFolderPath, xmlPath };
  }
}

const frontlineFileWriter = new FrontlineFileWriter();
module.exports = { frontlineFileWriter, FrontlineFileWriter };
