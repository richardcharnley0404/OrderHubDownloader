const {
  S3Client, PutObjectCommand, HeadBucketCommand,
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand
} = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const presignService = require('./presign-service');
const logger = require('./logger');

// Files larger than this are streamed for Amazon multipart; all Pixfizz files are streamed
const MULTIPART_THRESHOLD = 50 * 1024 * 1024; // 50 MB
const PART_SIZE = 10 * 1024 * 1024;            // 10 MB per part

class S3Service {

  // ── Public API ──────────────────────────────────────────────────────────────

  async testConnection(credentials) {
    if (credentials.provider === 'amazon') {
      return this._testConnectionAmazon(credentials);
    }
    // Pixfizz — test via presign endpoint (confirms API reachability + auth)
    return presignService.testConnection(credentials.locationId || null);
  }

  /**
   * Upload every file inside localFolderPath to S3 under s3Prefix/folderName/.
   *
   * credentials shape:
   *   Pixfizz:  { provider: 'pixfizz', bucketName, locationId }
   *   Amazon:   { provider: 'amazon',  bucketName, accessKeyId, secretAccessKey, region }
   *
   * @param {string}   localFolderPath  - absolute path to local folder
   * @param {string}   s3Prefix         - e.g. 'film-scans/LOC1/' (trailing slash)
   * @param {object}   credentials
   * @param {Function} [progressCallback]
   * @returns {Promise<{ uploaded: number, failed: number, total: number }>}
   */
  async uploadFolder(localFolderPath, s3Prefix, credentials, progressCallback) {
    if (credentials.provider === 'amazon') {
      return this._uploadFolderAmazon(localFolderPath, s3Prefix, credentials, progressCallback);
    }
    return this._uploadFolderPixfizz(localFolderPath, s3Prefix, credentials, progressCallback);
  }

  // ── Pixfizz (pre-signed URL) path ───────────────────────────────────────────

  async _uploadFolderPixfizz(localFolderPath, s3Prefix, credentials, progressCallback) {
    const folderName = path.basename(localFolderPath);
    const S3_EXCLUDED_EXTENSIONS = ['.thm', '.txt'];
    const files = this._getAllFiles(localFolderPath)
      .filter(f => !S3_EXCLUDED_EXTENSIONS.includes(path.extname(f).toLowerCase()));

    if (files.length === 0) {
      return { uploaded: 0, failed: 0, total: 0 };
    }

    // The OH API uses a folder token ('film-scans', 'file-uploads', etc.) rather than
    // full S3 keys. Extract it from the leading segment of s3Prefix.
    const s3Folder = s3Prefix.split('/')[0]; // e.g. 'film-scans' or 'file-uploads'

    let uploaded = 0;
    let failed = 0;

    try {
      for (const filePath of files) {
        // Build descriptor for this single file.
        // sub_path = folderName[/relativeDir] so the server reconstructs the full key as:
        //   {s3Folder}/{locationId}/{sub_path}/{name}
        const relPath = path.relative(localFolderPath, filePath).replace(/\\/g, '/');
        const name = path.basename(relPath);
        const relDir = path.dirname(relPath);
        const sub_path = relDir === '.' ? folderName : `${folderName}/${relDir}`;
        const stat = fs.statSync(filePath);
        const apiDescriptor = { name, folder: s3Folder, sub_path, size: stat.size, type: this._getContentType(filePath) };

        // Request a fresh pre-signed URL for this file immediately before uploading.
        let presignEntry;
        try {
          const presigned = await presignService.getPresignedUrls([apiDescriptor], credentials.locationId || null);
          presignEntry = presigned[0];
        } catch (error) {
          failed++;
          logger.logError(`Failed to obtain pre-signed URL for ${name}`, error);
          continue;
        }

        if (!presignEntry || !presignEntry.upload_url) {
          failed++;
          logger.logWarning(`presignService returned no URL for ${name}`, { name, sub_path, size: stat.size, type: apiDescriptor.type });
          continue;
        }

        try {
          await this._uploadWithRetry(filePath, presignEntry.upload_url, presignEntry.s3_key || name);
          uploaded++;
          if (progressCallback) {
            progressCallback({ message: `Uploaded ${uploaded}/${files.length}: ${relPath}`, status: 'uploading' });
          }
        } catch (error) {
          failed++;
          logger.logError(`Failed to upload ${presignEntry.s3_key || name} after retries`, error);
        }
      }
    } catch (outerError) {
      // Unexpected error outside per-file handling (e.g. fs failure mid-loop).
      // Treat all remaining files as failed and fall through to manifest write.
      failed = files.length - uploaded;
      logger.logError(`filmScans: unexpected error during upload loop for ${folderName} — falling through to manifest`, outerError);
    }

    // ── Manifest ─────────────────────────────────────────────────────────────
    // Always written, regardless of upload errors, so OH always knows the folder exists.
    try {
      const { name: manifestName, buffer: manifestBuffer } =
        this._buildManifestPayload(folderName, files, failed);

      const manifestDescriptor = {
        name:     manifestName,
        folder:   s3Folder,
        sub_path: folderName,
        size:     manifestBuffer.length,
        type:     'application/json'
      };

      const presigned = await presignService.getPresignedUrls([manifestDescriptor], credentials.locationId || null);
      const manifestEntry = presigned[0];

      if (manifestEntry && manifestEntry.upload_url) {
        await this._uploadBufferViaPresignedUrl(manifestBuffer, 'application/json', manifestEntry.upload_url);
        if (failed > 0) {
          logger.logWarning(`filmScans: manifest written with ${failed} error(s) for folder ${folderName} — lab must re-upload after deleting in OH`);
        } else {
          logger.info(`filmScans: manifest uploaded — ${manifestName}`);
        }
      } else {
        logger.logWarning(`filmScans: no pre-signed URL returned for manifest ${manifestName}`, {});
      }
    } catch (manifestError) {
      // Manifest failure must never affect the reported upload result
      logger.logError('filmScans: failed to upload manifest', manifestError);
    }

    return { uploaded, failed, total: files.length };
  }

  /**
   * PUT an in-memory Buffer to a pre-signed URL.
   */
  _uploadBufferViaPresignedUrl(buffer, contentType, presignedUrl) {
    return new Promise((resolve, reject) => {
      const urlObj   = new URL(presignedUrl);
      const protocol = urlObj.protocol === 'https:' ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path:     urlObj.pathname + urlObj.search,
        method:   'PUT',
        headers: {
          'Content-Type':   contentType,
          'Content-Length': buffer.length
        },
        timeout: 30000
      };

      const req = protocol.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Sentinel upload failed: HTTP ${res.statusCode} — ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Sentinel upload request timed out'));
      });

      req.write(buffer);
      req.end();
    });
  }

  /**
   * Wrap _uploadFileViaPresignedUrl with a tight retry on transient network
   * failures ("socket hang up", ECONNRESET, ETIMEDOUT, EPIPE, EAI_AGAIN,
   * Upload request timed out). Avoids wasting the roll-level retry — which
   * re-uploads the entire batch — on a single-file blip.
   *
   * Three attempts with 2s → 5s backoff. HTTP 4xx/5xx errors are NOT
   * retried at this layer (a 403 from a bad presigned URL won't get better
   * with more attempts); the caller's roll-level retry will pick those up
   * if needed.
   */
  async _uploadWithRetry(filePath, presignedUrl, label) {
    const MAX_ATTEMPTS = 3;
    const BACKOFFS_MS = [2_000, 5_000];
    const TRANSIENT = /(socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|timed out)/i;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this._uploadFileViaPresignedUrl(filePath, presignedUrl);
        if (attempt > 1) {
          logger.info(`s3: ${label} succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
        }
        return;
      } catch (err) {
        lastErr = err;
        const transient = TRANSIENT.test(err && err.message ? err.message : '');
        if (!transient || attempt === MAX_ATTEMPTS) throw err;
        const wait = BACKOFFS_MS[attempt - 1];
        logger.logWarning(`s3: ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed transiently (${err.message}), retrying in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  /**
   * PUT a single file to a pre-signed URL.
   * Always streams the file — never loads the whole file into memory.
   */
  _uploadFileViaPresignedUrl(filePath, presignedUrl) {
    return new Promise((resolve, reject) => {
      const fileStat = fs.statSync(filePath);
      const contentType = this._getContentType(filePath);
      const urlObj = new URL(presignedUrl);
      const protocol = urlObj.protocol === 'https:' ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': fileStat.size
        },
        timeout: 300000 // 5 min for large files
      };

      const req = protocol.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed: HTTP ${res.statusCode} — ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Upload request timed out'));
      });

      // Stream the file — works for any size without loading into memory
      const readStream = fs.createReadStream(filePath);
      readStream.on('error', reject);
      readStream.pipe(req);
    });
  }

  // ── Amazon S3 path (unchanged) ───────────────────────────────────────────────

  _createAmazonClient(credentials) {
    return new S3Client({
      region: credentials.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey
      }
    });
  }

  async _testConnectionAmazon(credentials) {
    const client = this._createAmazonClient(credentials);
    try {
      await client.send(new HeadBucketCommand({ Bucket: credentials.bucketName }));
      logger.info('S3 connection test successful');
      return { success: true };
    } catch (error) {
      logger.logError('S3 connection test failed', error);
      return { success: false, error: error.message };
    } finally {
      client.destroy();
    }
  }

  async _uploadFolderAmazon(localFolderPath, s3Prefix, credentials, progressCallback) {
    const client = this._createAmazonClient(credentials);
    const S3_EXCLUDED_EXTENSIONS = ['.thm', '.txt'];
    const folderName = path.basename(localFolderPath);
    const files = this._getAllFiles(localFolderPath)
      .filter(f => !S3_EXCLUDED_EXTENSIONS.includes(path.extname(f).toLowerCase()));
    let uploaded = 0;
    let failed = 0;

    try {
      try {
        for (const filePath of files) {
          const relativePath = path.relative(localFolderPath, filePath).replace(/\\/g, '/');
          const s3Key = `${s3Prefix}${folderName}/${relativePath}`;

          try {
            const fileStat = fs.statSync(filePath);
            const contentType = this._getContentType(filePath);

            if (fileStat.size > MULTIPART_THRESHOLD) {
              await this._uploadFileMultipartAmazon(client, credentials.bucketName, s3Key, filePath, contentType);
            } else {
              const fileContent = fs.readFileSync(filePath);
              await client.send(new PutObjectCommand({
                Bucket: credentials.bucketName,
                Key: s3Key,
                Body: fileContent,
                ContentType: contentType
              }));
            }

            uploaded++;
            if (progressCallback) {
              progressCallback({ message: `Uploaded ${uploaded}/${files.length}: ${relativePath}`, status: 'uploading' });
            }
          } catch (error) {
            failed++;
            logger.logError(`Failed to upload ${s3Key}`, error);
          }
        }
      } catch (outerError) {
        // Mirror Pixfizz semantics: even an unexpected error mid-loop must not
        // skip the manifest write — OH relies on it to know the folder is done.
        failed = files.length - uploaded;
        logger.logError(`amazon: unexpected error during upload loop for ${folderName} — falling through to manifest`, outerError);
      }

      // ── Manifest ──────────────────────────────────────────────────────────
      // Mandatory for OH ingest. Always written, regardless of upload errors.
      // Errors here are swallowed so they never affect the reported result.
      try {
        const { name: manifestName, buffer: manifestBuffer } =
          this._buildManifestPayload(folderName, files, failed);
        const manifestKey = `${s3Prefix}${folderName}/${manifestName}`;

        await client.send(new PutObjectCommand({
          Bucket:      credentials.bucketName,
          Key:         manifestKey,
          Body:        manifestBuffer,
          ContentType: 'application/json'
        }));

        if (failed > 0) {
          logger.logWarning(`amazon: manifest written with ${failed} error(s) for folder ${folderName} — lab must re-upload after deleting in OH`);
        } else {
          logger.info(`amazon: manifest uploaded — ${manifestName}`);
        }
      } catch (manifestError) {
        logger.logError('amazon: failed to upload manifest', manifestError);
      }

      return { uploaded, failed, total: files.length };
    } finally {
      client.destroy();
    }
  }

  async _uploadFileMultipartAmazon(client, bucket, key, filePath, contentType) {
    const { UploadId } = await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType
    }));

    try {
      const parts = [];
      let partNumber = 1;
      let buffer = Buffer.alloc(0);
      const stream = fs.createReadStream(filePath, { highWaterMark: PART_SIZE });

      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= PART_SIZE) {
          const partData = buffer.subarray(0, PART_SIZE);
          buffer = buffer.subarray(PART_SIZE);

          const { ETag } = await client.send(new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId,
            PartNumber: partNumber,
            Body: partData
          }));
          parts.push({ PartNumber: partNumber, ETag });
          partNumber++;
        }
      }

      // Upload remaining bytes as the final part
      if (buffer.length > 0) {
        const { ETag } = await client.send(new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId,
          PartNumber: partNumber,
          Body: buffer
        }));
        parts.push({ PartNumber: partNumber, ETag });
      }

      await client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: parts }
      }));

      logger.info(`Multipart upload complete: ${key} (${parts.length} parts)`);
    } catch (error) {
      // Best-effort abort to clean up incomplete upload
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId }));
      } catch (abortErr) {
        logger.logError(`Failed to abort multipart upload for ${key}`, abortErr);
      }
      throw error;
    }
  }

  // ── Shared helpers ───────────────────────────────────────────────────────────

  /**
   * Build the per-folder JSON manifest that signals to OrderHub that an upload
   * session has finished. Provider-agnostic — both the Pixfizz and Amazon paths
   * call this and then upload the buffer with whatever transport they use.
   *
   * The manifest is mandatory for OH ingest of Film Scans and File Uploads:
   * without it, OH never sees the folder as "done".
   *
   * @param {string}   folderName
   * @param {string[]} files     - all files included in the upload (pre-filter)
   * @param {number}   failed    - count of file-level failures
   * @returns {{ name: string, buffer: Buffer }}
   */
  _buildManifestPayload(folderName, files, failed) {
    const { app } = require('electron');
    const tiffExts = new Set(['.tif', '.tiff']);
    const jpegExts = new Set(['.jpg', '.jpeg']);
    const tiffCount = files.filter(f => tiffExts.has(path.extname(f).toLowerCase())).length;
    const jpgCount  = files.filter(f => jpegExts.has(path.extname(f).toLowerCase())).length;

    const body = JSON.stringify({
      folder:       folderName,
      total_files:  files.length,
      tiff_count:   tiffCount,
      jpg_count:    jpgCount,
      errors:       failed,
      completed_at: new Date().toISOString(),
      ohd_version:  app.getVersion()
    });

    return {
      name:   `${folderName}.json`,
      buffer: Buffer.from(body, 'utf8')
    };
  }

  _getAllFiles(dirPath) {
    const files = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...this._getAllFiles(fullPath));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    return files;
  }

  _getContentType(filePath) {
    try {
      const mimeTypes = require('mime-types');
      return mimeTypes.lookup(filePath) || 'application/octet-stream';
    } catch {
      return 'application/octet-stream';
    }
  }
}

module.exports = new S3Service();
