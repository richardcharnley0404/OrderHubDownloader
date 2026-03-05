const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

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

      // Recursively download directory contents
      await this._downloadDirectory(client, remotePath, localBasePath, onProgress, summary);

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
        // Skip if file already exists with same size
        if (fs.existsSync(localItemPath)) {
          const localStats = fs.statSync(localItemPath);
          if (localStats.size === item.size) {
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

          // Verify download then delete from FTP
          if (fs.existsSync(localItemPath)) {
            const localStats = fs.statSync(localItemPath);
            if (localStats.size === item.size) {
              try {
                await client.remove(remoteItemPath);
                logger.info('Deleted file from FTP after successful download', { remoteItemPath });
              } catch (delError) {
                logger.logError('Failed to delete file from FTP', delError, { remoteItemPath });
                allFilesSucceeded = false;
              }
            } else {
              logger.logWarning('Downloaded file size mismatch, keeping FTP copy', {
                remoteItemPath,
                expected: item.size,
                actual: localStats.size
              });
              allFilesSucceeded = false;
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

module.exports = new FtpService();
