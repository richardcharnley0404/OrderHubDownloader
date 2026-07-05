const path = require('path');
const fs = require('fs');
const configService = require('./config-service');
const logger = require('./logger');
const { resolveManifestPath } = require('./manifest-path');

class JobDownloadService {
  constructor() {
    this.activeDownloads = new Map(); // kept for compatibility
  }

  /**
   * Check if artwork files exist locally for a given job.
   * Looks for: {downloadDirectory}/{order_number}_{order_id}/{order_number}_{job_id}/
   *
   * Returns a three-state result so callers (polling-service in particular)
   * can distinguish "still downloading" from "files arrived but manifest
   * hasn't yet" — the two cases that previously collapsed into a single
   * `found:false` and triggered an "Order manifest not found" race when
   * markReceived fired too early.
   *
   *   hasFiles    — at least one file exists under localPath
   *   hasManifest — {orderNumber}.json exists in the order folder (parent
   *                 of localPath); read by print-service._readManifest at
   *                 dispatch time
   *   manifestPath — absolute path where the manifest is expected (always
   *                  populated when localPath resolves, even if absent on
   *                  disk) so the renderer can surface it as a tooltip
   *   found       — preserved for backward compat with existing callers
   *                 (AI Quality Gate at ipc-handlers.js:518, 2590);
   *                 equals hasFiles, NOT hasFiles && hasManifest, so AI
   *                 scoring can begin as soon as files arrive
   *
   * @param {object} job - Job with order_number, order_id, and id fields
   * @returns {{ found: boolean, hasFiles: boolean, hasManifest: boolean,
   *             localPath?: string, manifestPath?: string, fileCount?: number }}
   */
  checkLocalFiles(job) {
    // Belt-and-braces: Film Development jobs have no artwork to check;
    // their `roll_XXX.zip` payload is a scan-instruction manifest that
    // must never be downloaded, opened, or received-marked. The primary
    // filter in job-service.getLocalJobs already stops them from
    // reaching the poll loop; this guard covers any direct call from
    // ipc-handlers or from a devtools poke.
    if (job && job.is_film_development) {
      return { found: false, hasFiles: false, hasManifest: false };
    }

    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      return { found: false, hasFiles: false, hasManifest: false };
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
      return { found: false, hasFiles: false, hasManifest: false };
    }

    // Build expected path: {downloadDir}/{order_number}_{order_id}/{order_number}_{job_id}/
    const orderFolderName = `${orderNumber}_${orderId}`;
    const jobFolderName = `${orderNumber}_${jobId}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const localPath       = path.join(orderFolderPath, jobFolderName);
    const manifestPath    = resolveManifestPath(orderFolderPath, orderNumber);

    try {
      if (!fs.existsSync(localPath)) {
        return { found: false, hasFiles: false, hasManifest: false, localPath, manifestPath };
      }

      const stat = fs.statSync(localPath);
      if (!stat.isDirectory()) {
        return { found: false, hasFiles: false, hasManifest: false, localPath, manifestPath };
      }

      const fileCount   = this._countFiles(localPath);
      const hasFiles    = fileCount > 0;
      // hasManifest = file exists, non-empty, and JSON-parseable.
      // FTP delivery is NOT atomic — basic-ftp's downloadTo (ftp-service.js:429)
      // writes the manifest directly to its final path; during the stream the
      // file is observable with 0 bytes / partial content. A bare existsSync
      // check would let the poll fire markReceived → dispatch → JSON.parse
      // throws — same race we're gating against, just with a parse error
      // instead of "not found". The parse is cheap (manifests are small,
      // a few KB) and the result is the same one print-service._readManifest
      // will parse a moment later. S3-delivered manifests are atomic
      // (.tmp + rename, s3-artwork-downloader.js:421-424) so this check is
      // a no-op for that path.
      const hasManifest = this._manifestIsReadable(manifestPath);

      if (hasFiles) {
        logger.info('Local files found for job', {
          jobId,
          orderNumber,
          localPath,
          fileCount,
          hasManifest,
        });
      }

      return {
        found: hasFiles,
        hasFiles,
        hasManifest,
        localPath,
        manifestPath,
        fileCount,
      };
    } catch (error) {
      logger.logError('Error checking local files for job', error, { jobId, localPath });
      return { found: false, hasFiles: false, hasManifest: false, localPath, manifestPath };
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
   * Return true iff the manifest file exists, is non-empty, and parses as
   * JSON. Used by checkLocalFiles to gate the FTP partial-write race —
   * see the hasManifest comment in checkLocalFiles for the why.
   *
   * Parse errors are swallowed (returns false) — the polling loop's next
   * cycle will re-check, and the file will either parse cleanly once FTP
   * finishes streaming or stay stuck (in which case the
   * awaitingManifestTimeoutMs escalation kicks in).
   */
  _manifestIsReadable(manifestPath) {
    try {
      if (!fs.existsSync(manifestPath)) return false;
      const stat = fs.statSync(manifestPath);
      if (!stat.isFile() || stat.size === 0) return false;
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      JSON.parse(raw);
      return true;
    } catch (_) {
      return false;
    }
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
