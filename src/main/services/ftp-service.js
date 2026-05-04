const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { checkImageMagic } = require('./file-integrity');
const { loadSidecar, saveSidecar } = require('../jobs/sidecarManager');
const { createImageEntry } = require('../../shared/jobSchema');

const EXPECTED_MAGIC_DESC = 'JPEG (FF D8 FF) or PNG (89 50 4E 47 0D 0A 1A 0A)';

// Extensions for which the FTP layer runs the magic-byte integrity check.
// Deliberately narrower than the codebase-wide IMAGE_EXTENSIONS set: that
// one means "what OHD considers an image at all" (and includes .tif/.tiff
// for compatibility with code paths that may reference them), while this
// one means "what the FTP layer can validate via JPEG/PNG magic bytes".
// Files outside this set (order manifests, sidecars, future PDFs, anything
// else upstream might land in the FTP slot) bypass the check entirely —
// surfacing corruption for those formats is the responsibility of the
// downstream consumer that actually parses them.
const INTEGRITY_CHECK_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

function shouldIntegrityCheck(filename) {
  return INTEGRITY_CHECK_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/**
 * Flag a downloaded file as integrity-suspect without renaming, deleting,
 * or otherwise hiding it. The pivot from the v1.3.0 quarantine model:
 * detection and decision are separate concerns. OHD's job is to detect and
 * surface; whether the file ultimately prints is decided downstream by the
 * printer, the operator, or the customer.
 *
 *   1. Leave the file at `localPath` with its original extension. Do NOT
 *      rename. Downstream consumers (orchestrator's _scanJobImages, print
 *      pipeline, sidecarManager) all match by extension, so the file is
 *      now visible to them. The graceful-fail path in ai-quality-service
 *      (sharp throws → score 100 + aiQuality.error) handles it cleanly.
 *   2. Stamp the per-image sidecar's `integritySuspect` field via
 *      sidecarManager. The sidecar is the canonical forensic record under
 *      the new model — no separate per-job manifest is written.
 *   3. Emit an [integrity-check] info-level log line with the same
 *      structured fields the old [quarantine] log carried.
 *
 * Sidecar I/O failures are logged and swallowed: the file is still going
 * downstream regardless, and the orchestrator's later scoring pass will
 * surface corruption via aiQuality.error even if the integritySuspect
 * write didn't land. Do not throw from this function.
 *
 * The sidecar this writes to is the inner-job sidecar at
 * `<dirname(localPath)>/<basename(dirname(localPath))>.json`, matching
 * the convention used by the orchestrator and ai-quality-store.
 */
async function markIntegritySuspect(localPath, remoteItemPath, integrity, expectedSize) {
  const jobPath = path.dirname(localPath);
  const jobId = path.basename(jobPath);
  const filename = path.basename(localPath);

  let actualSize = null;
  try {
    actualSize = fs.statSync(localPath).size;
  } catch {
    // Stat failure is non-fatal — diagnostic field stays null.
  }

  const reason = integrity.magicHex === null ? 'read-error' : 'magic-byte-mismatch';
  const detectedAt = new Date().toISOString();
  const suspect = {
    detected: true,
    detectedAt,
    firstBytesHex: integrity.magicHex,
    expectedMagic: EXPECTED_MAGIC_DESC,
    ftpRemotePath: remoteItemPath,
  };

  try {
    const { sidecar } = await loadSidecar(jobId, jobPath);
    if (!Array.isArray(sidecar.images)) sidecar.images = [];

    let idx = sidecar.images.findIndex((img) => img.filename === filename);
    if (idx === -1) {
      // Mode-1 (FTP) jobs land images at the job root, not /working/, so
      // sidecarManager's auto-populate from /working/ won't include them.
      // Upsert a fresh entry — same pattern ai-quality-store.setImageQuality
      // uses. createImageEntry already defaults integritySuspect to null,
      // which we immediately overwrite below.
      sidecar.images.push(createImageEntry(filename, 1));
      idx = sidecar.images.length - 1;
    }

    sidecar.images[idx] = {
      ...sidecar.images[idx],
      integritySuspect: suspect,
    };

    await saveSidecar(sidecar, jobPath);
  } catch (err) {
    logger.logError('[integrity-check] Failed to update sidecar — file still proceeds downstream', err, {
      localPath,
      jobPath,
      jobId,
      filename,
    });
  }

  logger.info('[integrity-check] Suspect file flagged', {
    filename,
    ftpRemotePath: remoteItemPath,
    expectedSize: expectedSize ?? null,
    actualSize,
    firstBytesHex: integrity.magicHex,
    expectedMagic: EXPECTED_MAGIC_DESC,
    reason,
    detectedAt,
  });
}

class FtpService {
  constructor() {
    this.client = null;
  }

  /**
   * Test FTP connection
   */
  async testConnection(credentials) {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
      logger.info('Testing FTP connection', { host: credentials.host });

      await client.access({
        host: credentials.host,
        port: credentials.port || 21,
        user: credentials.user,
        password: credentials.password,
        secure: false
      });

      logger.info('FTP test connection successful');
      return true;
    } catch (error) {
      logger.logError('FTP test connection failed', error);
      throw error;
    } finally {
      client.close();
    }
  }

  /**
   * Download file from FTP server
   */
  async downloadFile(credentials, remotePath, localPath) {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
      logger.info('Starting FTP download', { remotePath, localPath });

      // Connect to FTP server
      await client.access({
        host: credentials.host,
        port: credentials.port || 21,
        user: credentials.user,
        password: credentials.password,
        secure: false
      });

      // Ensure local directory exists
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        logger.info('Creating local directory', { localDir });
        fs.mkdirSync(localDir, { recursive: true });
      }

      // Download file
      await client.downloadTo(localPath, remotePath);

      // Verify file was downloaded
      if (fs.existsSync(localPath)) {
        const stats = fs.statSync(localPath);
        logger.info('FTP download successful', {
          remotePath,
          localPath,
          size: stats.size
        });
        return {
          success: true,
          localPath,
          size: stats.size
        };
      } else {
        throw new Error('Downloaded file not found on disk');
      }
    } catch (error) {
      logger.logError('FTP download failed', error, { remotePath, localPath });
      throw error;
    } finally {
      client.close();
    }
  }

  /**
   * Download multiple files
   */
  async downloadFiles(credentials, files) {
    const results = [];

    for (const file of files) {
      try {
        const result = await this.downloadFile(
          credentials,
          file.remotePath,
          file.localPath
        );
        results.push({ ...file, ...result });
      } catch (error) {
        logger.logError('Failed to download file', error, {
          remotePath: file.remotePath
        });
        results.push({
          ...file,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Scan FTP directory and download all folders/files recursively
   */
  async scanAndDownload(credentials, remotePath, localBasePath, onProgress) {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };

    try {
      onProgress({ status: 'connecting', message: 'Connecting to FTP...' });

      await client.access({
        host: credentials.host,
        port: credentials.port || 21,
        user: credentials.user,
        password: credentials.password,
        secure: false
      });

      onProgress({ status: 'scanning', message: `Scanning ${remotePath}...` });

      // Recursively download directory contents.
      await this._downloadDirectory(client, remotePath, localBasePath, onProgress, summary, false);

      onProgress({
        status: 'complete',
        message: `Complete - ${summary.downloaded} files downloaded, ${summary.skipped} skipped`,
        summary
      });

      return summary;
    } catch (error) {
      logger.logError('Scan and download failed', error);
      onProgress({ status: 'error', message: 'Error: ' + error.message });
      throw error;
    } finally {
      client.close();
    }
  }

  /**
   * Recursively download a directory's contents
   */
  async _downloadDirectory(client, remotePath, localPath, onProgress, summary, isSubfolder = false) {
    // Ensure local directory exists
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true });
    }

    const items = await client.list(remotePath);
    let allFilesSucceeded = true;

    for (const item of items) {
      const remoteItemPath = remotePath.replace(/\/$/, '') + '/' + item.name;
      const localItemPath = path.join(localPath, item.name);

      if (item.isDirectory) {
        onProgress({
          status: 'downloading',
          message: `Scanning folder: ${item.name}`
        });
        await this._downloadDirectory(client, remoteItemPath, localItemPath, onProgress, summary, true);
      } else {
        // Skip if file already exists with same size — but for known image
        // formats also verify magic bytes first. A size-match on a corrupt
        // file (sparse-zero allocation, HTML error page, etc.) would
        // otherwise look like a valid cache hit. Non-image files (order
        // manifests, sidecars, PDFs, etc.) bypass the integrity check —
        // see INTEGRITY_CHECK_EXTENSIONS.
        if (fs.existsSync(localItemPath)) {
          const localStats = fs.statSync(localItemPath);
          if (localStats.size === item.size) {
            if (shouldIntegrityCheck(item.name)) {
              const integrity = checkImageMagic(localItemPath);
              if (!integrity.valid) {
                // Cached file looks corrupt by magic-byte check. Under the
                // v1.3.2 flag-and-allow model we don't re-download or hide
                // the file — we mark it suspect in the sidecar and treat
                // it as a normal cache hit. The print pipeline attempts it;
                // AI Quality scoring's graceful-fail (sharp throws → score
                // 100 + aiQuality.error) surfaces the issue to the operator.
                await markIntegritySuspect(localItemPath, remoteItemPath, integrity, item.size);
              }
            }
            summary.skipped++;
            // Still delete from FTP since we already have it
            try {
              await client.remove(remoteItemPath);
              logger.info('Deleted already-downloaded file from FTP', { remoteItemPath });
            } catch (delError) {
              logger.logError('Failed to delete skipped file from FTP', delError, { remoteItemPath });
            }
            continue;
          }
        }

        try {
          onProgress({
            status: 'downloading',
            message: `Downloading: ${item.name}`,
            downloaded: summary.downloaded,
            skipped: summary.skipped
          });

          await client.downloadTo(localItemPath, remoteItemPath);
          summary.downloaded++;
          logger.info('Downloaded file', { remoteItemPath, localItemPath });

          // Verify download — size match is hard-required (mismatched size
          // means an incomplete download we shouldn't trust). For image
          // extensions we additionally run the magic-byte check, but under
          // the v1.3.2 flag-and-allow model an integrity failure no longer
          // hides the file: we mark it suspect in the sidecar and treat it
          // as a normal successful download. Non-image files (order
          // manifests, sidecars, PDFs) bypass the integrity check entirely
          // — surfacing corruption for those formats is the responsibility
          // of the downstream consumer that parses them.
          if (fs.existsSync(localItemPath)) {
            const localStats = fs.statSync(localItemPath);
            if (localStats.size !== item.size) {
              logger.logWarning('Downloaded file size mismatch, keeping FTP copy', {
                remoteItemPath,
                expected: item.size,
                actual: localStats.size
              });
              allFilesSucceeded = false;
            } else {
              if (shouldIntegrityCheck(item.name)) {
                const integrity = checkImageMagic(localItemPath);
                if (!integrity.valid) {
                  await markIntegritySuspect(localItemPath, remoteItemPath, integrity, item.size);
                }
              }
              try {
                await client.remove(remoteItemPath);
                logger.info('Deleted file from FTP after successful download', { remoteItemPath });
              } catch (delError) {
                logger.logError('Failed to delete file from FTP', delError, { remoteItemPath });
                allFilesSucceeded = false;
              }
            }
          }
        } catch (error) {
          summary.failed++;
          summary.errors.push({ file: remoteItemPath, error: error.message });
          logger.logError('Failed to download file', error, { remoteItemPath });
          allFilesSucceeded = false;
        }
      }
    }

    // If this is a subfolder and all files succeeded, try to remove the empty folder
    if (isSubfolder && allFilesSucceeded) {
      try {
        const remaining = await client.list(remotePath);
        if (remaining.length === 0) {
          await client.removeDir(remotePath);
          logger.info('Removed empty FTP folder', { remotePath });
        }
      } catch (dirError) {
        logger.logError('Failed to remove FTP folder', dirError, { remotePath });
      }
    }
  }

  /**
   * List files in directory
   */
  async listFiles(credentials, remotePath = '/') {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
      await client.access({
        host: credentials.host,
        port: credentials.port || 21,
        user: credentials.user,
        password: credentials.password,
        secure: false
      });

      const fileList = await client.list(remotePath);
      return fileList;
    } catch (error) {
      logger.logError('Failed to list FTP directory', error, { remotePath });
      throw error;
    } finally {
      client.close();
    }
  }
}

const ftpService = new FtpService();

// Expose private file-level helpers for diagnostics + tests. These are not
// part of the public service API; consumers go through ftpService methods.
ftpService._markIntegritySuspect = markIntegritySuspect;
ftpService._shouldIntegrityCheck = shouldIntegrityCheck;
ftpService._INTEGRITY_CHECK_EXTENSIONS = INTEGRITY_CHECK_EXTENSIONS;

module.exports = ftpService;
