const fs = require('fs');
const path = require('path');
const configService = require('./config-service');
const s3Service = require('./s3-service');
const logger = require('./logger');

class FolderWatchService {
  constructor() {
    this.lastSummary = { filmScans: null, fileUploads: null };
    this._filmScanProcessing = false;
  }

  async processAll() {
    const config = configService.getAll();

    if (config.filmScansEnabled) {
      this.lastSummary.filmScans = await this._processFilmScans(config);
    }

    return this.lastSummary;
  }

  /**
   * Public method for polling-service to call on the independent File Uploads timer.
   */
  async processFileUploads() {
    const config = configService.getAll();
    if (!config.fileUploadsEnabled) return null;
    this.lastSummary.fileUploads = await this._processFileUploads(config);
    return this.lastSummary.fileUploads;
  }

  /**
   * Film Scans processing:
   * 1. Wait for folder stability
   * 2. Copy folder from watch → storage/{MMDDYYYY}/{folderName}
   * 3. Delete folder from watch
   * 4. Upload from storage → S3 (path: film-scans/{locationId}/{folderName}/...)
   *
   * The date subfolder (MMDDYYYY) is derived from the system clock at the
   * moment each folder is processed. If a folder with the same name already
   * exists under today's date subfolder, a numeric suffix (_1, _2, …) is
   * appended to avoid silent overwrites.
   *
   * No upload tracker — duplicate folder names are expected over time.
   */
  async _processFilmScans(config) {
    if (this._filmScanProcessing) {
      logger.info('filmScans: previous processing still running, skipping this cycle');
      return { processed: 0, skipped: 0, failed: 0, errors: [] };
    }

    this._filmScanProcessing = true;
    const summary = { processed: 0, skipped: 0, failed: 0, errors: [] };
    try {
      const watchFolder = config.filmScansWatchFolder;
      const storageFolder = config.filmScansStorageFolder;
      const stabilityMinutes = config.filmScansWatchguardMinutes || config.fileStabilityMinutes;
      const locationId = config.locationId;

      if (!watchFolder || !fs.existsSync(watchFolder)) {
        logger.logWarning(`filmScans: watch folder not configured or missing: ${watchFolder}`);
        return summary;
      }

      if (!storageFolder) {
        logger.logWarning('filmScans: storage folder not configured');
        return summary;
      }

      // Build S3 prefix using locationId
      const s3Prefix = `film-scans/${locationId}/`;

      try {
        const entries = fs.readdirSync(watchFolder, { withFileTypes: true });
        const folders = entries.filter((e) => e.isDirectory());

        for (const folder of folders) {
          const watchPath = path.join(watchFolder, folder.name);

          if (!this._isFolderStable(watchPath, stabilityMinutes)) {
            logger.info(`filmScans: folder not yet stable: ${folder.name}`);
            continue;
          }

          try {
            // Build date-based subfolder (MMDDYYYY) from the current system clock.
            // mkdirSync with recursive:true is a no-op if the folder already exists.
            const dateSubfolder = this._getDateSubfolder();
            const dateStorageDir = path.join(storageFolder, dateSubfolder);
            fs.mkdirSync(dateStorageDir, { recursive: true });

            // Resolve the final destination, adding _1/_2/… if a same-name folder
            // already exists under today's date subfolder.
            const storagePath = this._resolveStoragePath(dateStorageDir, folder.name);

            // Step 1: Copy to permanent storage
            await this._copyFolder(watchPath, storagePath);
            logger.info(`filmScans: copied ${folder.name} to storage (${storagePath})`);

            // Step 2: Delete from watch folder
            this._deleteFolderRecursive(watchPath);
            logger.info(`filmScans: deleted ${folder.name} from watch folder`);

            // Step 2b: Convert any TIFF files in storage to JPEG (quality 90).
            // JPEGs are written alongside the originals and will be picked up
            // automatically by the S3 upload in Step 3.
            // Process sequentially — each TIFF can be ~140 MB decoded in memory.
            {
              const sharp = require('sharp');
              const tiffFiles = fs.readdirSync(storagePath).filter(f => {
                const ext = path.extname(f).toLowerCase();
                return ext === '.tif' || ext === '.tiff';
              });
              for (const tiffFile of tiffFiles) {
                const srcPath  = path.join(storagePath, tiffFile);
                const jpgFile  = path.basename(tiffFile, path.extname(tiffFile)) + '.jpg';
                const destPath = path.join(storagePath, jpgFile);
                try {
                  await sharp(srcPath).jpeg({ quality: 90 }).toFile(destPath);
                  logger.info(`filmScans: converted ${tiffFile} → ${jpgFile}`);
                } catch (convErr) {
                  logger.logError(`filmScans: failed to convert ${tiffFile} to JPEG — skipping`, convErr);
                }
              }
            }

            // Step 3: Upload from storage to S3
            const s3Config = this._buildS3Config(config, locationId);
            if (s3Config) {
              let result;
              try {
                result = await s3Service.uploadFolder(storagePath, s3Prefix, s3Config, (progress) => {
                  logger.info(`filmScans: ${progress.message}`);
                });
              } catch (uploadError) {
                // uploadFolder should never throw after the outer try/catch added in s3-service,
                // but guard here so a summary is still recorded if it somehow does.
                const totalFiles = require('fs').readdirSync(storagePath).length;
                logger.logError(`filmScans: uploadFolder threw unexpectedly for ${folder.name}`, uploadError);
                result = { uploaded: 0, failed: totalFiles, total: totalFiles };
              }

              if (result.failed > 0) {
                const msg = `S3 upload incomplete for ${folder.name}: ${result.uploaded}/${result.total} uploaded, ${result.failed} file(s) failed`;
                logger.logWarning(`filmScans: ${msg}`, result);
                summary.failed++;
                summary.errors.push(msg);
              } else {
                logger.info(`filmScans: S3 upload complete for ${folder.name}`, result);
                summary.processed++;
              }
            } else {
              summary.processed++;
            }
          } catch (error) {
            summary.failed++;
            summary.errors.push(`${folder.name}: ${error.message}`);
            logger.logError(`filmScans: error processing ${folder.name}`, error);
          }

          // Process one folder per poll cycle — break after the first stable folder
          // regardless of success or failure.
          break;
        }
      } catch (error) {
        logger.logError('filmScans: error scanning watch folder', error);
      }

      return summary;
    } finally {
      this._filmScanProcessing = false;
    }
  }

  /**
   * File Uploads processing (mirrors Film Scans):
   * 1. Wait for folder stability (uses fileUploadsWatchguardMinutes)
   * 2. Copy folder from watch → storage
   * 3. Delete folder from watch
   * 4. Upload from storage → S3 (path: media-uploads/{folderName}/...)
   */
  async _processFileUploads(config) {
    const summary = { processed: 0, skipped: 0, failed: 0, errors: [] };
    const watchFolder = config.fileUploadsWatchFolder;
    const storageFolder = config.fileUploadsStorageFolder;
    const stabilityMinutes = config.fileUploadsWatchguardMinutes || config.fileStabilityMinutes;

    if (!watchFolder || !fs.existsSync(watchFolder)) {
      logger.logWarning(`fileUploads: watch folder not configured or missing: ${watchFolder}`);
      return summary;
    }

    if (!storageFolder) {
      logger.logWarning('fileUploads: storage folder not configured');
      return summary;
    }

    const s3Prefix = 'file-uploads/';

    try {
      const entries = fs.readdirSync(watchFolder, { withFileTypes: true });
      const folders = entries.filter((e) => e.isDirectory());

      for (const folder of folders) {
        const watchPath = path.join(watchFolder, folder.name);

        if (!this._isFolderStable(watchPath, stabilityMinutes)) {
          logger.info(`fileUploads: folder not yet stable: ${folder.name}`);
          continue;
        }

        try {
          const storagePath = path.join(storageFolder, folder.name);

          // Step 1: Copy to permanent storage
          await this._copyFolder(watchPath, storagePath);
          logger.info(`fileUploads: copied ${folder.name} to storage`);

          // Step 2: Delete from watch folder
          this._deleteFolderRecursive(watchPath);
          logger.info(`fileUploads: deleted ${folder.name} from watch folder`);

          // Step 3: Upload from storage to S3
          const s3Config = this._buildS3Config(config, null);
          if (s3Config) {
            const result = await s3Service.uploadFolder(storagePath, s3Prefix, s3Config, (progress) => {
              logger.info(`fileUploads: ${progress.message}`);
            });

            if (result.failed > 0) {
              const msg = `S3 upload incomplete for ${folder.name}: ${result.uploaded}/${result.total} uploaded, ${result.failed} file(s) had no pre-signed URL and were skipped`;
              logger.logWarning(`fileUploads: ${msg}`, result);
              summary.failed++;
              summary.errors.push(msg);
            } else {
              logger.info(`fileUploads: S3 upload complete for ${folder.name}`, result);
              summary.processed++;
            }
          } else {
            summary.processed++;
          }
        } catch (error) {
          summary.failed++;
          summary.errors.push(`${folder.name}: ${error.message}`);
          logger.logError(`fileUploads: error processing ${folder.name}`, error);
        }
      }
    } catch (error) {
      logger.logError('fileUploads: error scanning watch folder', error);
    }

    return summary;
  }

  /**
   * Return today's date as a zero-padded MMDDYYYY string, e.g. "03112026".
   * Uses the local system clock at call time.
   */
  _getDateSubfolder() {
    const now  = new Date();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const dd   = String(now.getDate()).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    return `${mm}${dd}${yyyy}`;
  }

  /**
   * Return a conflict-free destination path under dateStorageDir for folderName.
   * If {dateStorageDir}/{folderName} does not exist it is returned unchanged.
   * Otherwise {folderName}_1, {folderName}_2, … are tried until a free name is found.
   */
  _resolveStoragePath(dateStorageDir, folderName) {
    let candidate = path.join(dateStorageDir, folderName);
    if (!fs.existsSync(candidate)) return candidate;
    let n = 1;
    while (true) { // eslint-disable-line no-constant-condition
      candidate = path.join(dateStorageDir, `${folderName}_${n}`);
      if (!fs.existsSync(candidate)) return candidate;
      n++;
    }
  }

  _isFolderStable(folderPath, stabilityMinutes) {
    const cutoff = Date.now() - (stabilityMinutes * 60 * 1000);
    return this._checkAllFilesOlderThan(folderPath, cutoff);
  }

  _checkAllFilesOlderThan(dirPath, cutoffMs) {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      if (entries.length === 0) return false; // empty folder not considered stable

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (!this._checkAllFilesOlderThan(fullPath, cutoffMs)) return false;
        } else {
          const stat = fs.statSync(fullPath);
          // Use the most recent of mtime and birthtime.
          // mtime = last modification (preserved from source on copy).
          // birthtime = when the file was created on THIS filesystem (i.e. when the copy started).
          // This ensures old files freshly copied into the watch folder are detected as recent.
          const latestMs = Math.max(stat.mtimeMs, stat.birthtimeMs);
          if (latestMs > cutoffMs) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async _copyFolder(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this._copyFolder(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Recursively delete a folder and all its contents
   */
  _deleteFolderRecursive(folderPath) {
    if (!fs.existsSync(folderPath)) return;

    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        this._deleteFolderRecursive(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    fs.rmdirSync(folderPath);
  }

  /**
   * Build the S3 provider config object for the current config.
   * For Pixfizz, no credentials are needed here — the presign service handles auth.
   * @param {object} config - result of configService.getAll()
   * @param {string|null} locationId - passed through for Pixfizz presign requests
   * @returns {object|null}
   */
  _buildS3Config(config, locationId) {
    if (!config.s3BucketName) {
      return null;
    }

    const provider = config.s3Provider || 'pixfizz';

    if (provider === 'amazon') {
      if (!config.s3Region || !config.s3AccessKeyId || !config.s3SecretAccessKey) {
        return null;
      }
      return {
        provider: 'amazon',
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
        bucketName: config.s3BucketName,
        region: config.s3Region
      };
    }

    // Pixfizz — credentials are managed server-side via pre-signed URLs
    return {
      provider: 'pixfizz',
      bucketName: config.s3BucketName,
      locationId: locationId || null
    };
  }

  getStatus() {
    return this.lastSummary;
  }
}

module.exports = new FolderWatchService();
