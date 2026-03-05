const path = require('path');
const fs = require('fs');
const configService = require('./config-service');
const logger = require('./logger');

class JobDownloadService {
  constructor() {
    this.activeDownloads = new Map(); // kept for compatibility
  }

  /**
   * Check if artwork files exist locally for a given job.
   * Looks for: {downloadDirectory}/{order_number}_{order_id}/{order_number}_{job_id}/
   *
   * @param {object} job - Job with order_number, order_id, and id fields
   * @returns {{ found: boolean, localPath?: string, fileCount?: number }}
   */
  checkLocalFiles(job) {
    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      return { found: false };
    }

    const orderNumber = job.order_number || '';
    const orderId = job.order_id;
    const jobId = job.id;

    if (!orderNumber || !orderId || !jobId) {
      logger.logWarning('Cannot check local files: missing order_number, order_id, or job_id', {
        order_number: orderNumber,
        order_id: orderId,
        job_id: jobId
      });
      return { found: false };
    }

    // Build expected path: {downloadDir}/{order_number}_{order_id}/{order_number}_{job_id}/
    const orderFolderName = `${orderNumber}_${orderId}`;
    const jobFolderName = `${orderNumber}_${jobId}`;
    const localPath = path.join(downloadDirectory, orderFolderName, jobFolderName);

    try {
      if (!fs.existsSync(localPath)) {
        return { found: false };
      }

      const stat = fs.statSync(localPath);
      if (!stat.isDirectory()) {
        return { found: false };
      }

      const fileCount = this._countFiles(localPath);

      if (fileCount === 0) {
        // Folder exists but is empty — not ready yet
        return { found: false };
      }

      logger.info('Local files found for job', {
        jobId,
        orderNumber,
        localPath,
        fileCount
      });

      return { found: true, localPath, fileCount };
    } catch (error) {
      logger.logError('Error checking local files for job', error, { jobId, localPath });
      return { found: false };
    }
  }

  /**
   * Check if a job is currently being downloaded (legacy compat)
   */
  isDownloading(jobId) {
    const download = this.activeDownloads.get(jobId);
    return download && download.status === 'downloading';
  }

  /**
   * Get download status for a job (legacy compat)
   */
  getDownloadStatus(jobId) {
    return this.activeDownloads.get(jobId) || null;
  }

  /**
   * Count files recursively in a directory
   */
  _countFiles(dirPath) {
    let count = 0;
    try {
      const items = fs.readdirSync(dirPath);
      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          count++;
        } else if (stat.isDirectory()) {
          count += this._countFiles(fullPath);
        }
      }
    } catch (error) {
      logger.logError('Error counting files', error, { dirPath });
    }
    return count;
  }
}

module.exports = new JobDownloadService();
