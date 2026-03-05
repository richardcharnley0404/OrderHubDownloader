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
    const files = this._getAllFiles(localFolderPath);

    if (files.length === 0) {
      return { uploaded: 0, failed: 0, total: 0 };
    }

    // The OH API uses a folder token ('film-scans', 'file-uploads', etc.) rather than
    // full S3 keys. Extract it from the leading segment of s3Prefix.
    const s3Folder = s3Prefix.split('/')[0]; // e.g. 'film-scans' or 'file-uploads'

    // Build file descriptors for the presign request.
    // sub_path = folderName[/relativeDir] so the server reconstructs the full key as:
    //   {s3Folder}/{locationId}/{sub_path}/{name}
    const fileDescriptors = files.map(filePath => {
      const relPath = path.relative(localFolderPath, filePath).replace(/\\/g, '/');
      const name = path.basename(relPath);
      const relDir = path.dirname(relPath);
      const sub_path = relDir === '.' ? folderName : `${folderName}/${relDir}`;
      const stat = fs.statSync(filePath);
      return {
        _localPath: filePath,           // local only — stripped before sending to API
        name,
        folder: s3Folder,
        sub_path,
        size: stat.size,
        type: this._getContentType(filePath)
      };
    });

    // Request all pre-signed URLs in one round-trip.
    // Send only the fields the API expects; strip the local _localPath.
    const apiDescriptors = fileDescriptors.map(({ name, folder, sub_path, size, type }) =>
      ({ name, folder, sub_path, size, type })
    );

    let presigned;
    try {
      presigned = await presignService.getPresignedUrls(apiDescriptors, credentials.locationId || null);
    } catch (error) {
      logger.logError('Failed to obtain pre-signed upload URLs', error);
      throw error;
    }

    // Index presign results by name for O(1) lookup.
    // NOTE: if two files share a basename across different sub_paths the Map will
    // collide — the diagnostic block below will surface that case.
    const presignByName = new Map(presigned.map(p => [p.name, p]));

    // Identify any files the API silently dropped and log full descriptor details
    const missingDescs = fileDescriptors.filter(d => !presignByName.has(d.name));
    if (missingDescs.length > 0) {
      logger.logWarning(
        `presignService returned no URL for ${missingDescs.length}/${fileDescriptors.length} file(s) — these will not be uploaded`,
        { missing: missingDescs.map(d => ({ name: d.name, sub_path: d.sub_path, size: d.size, type: d.type })) }
      );
    }

    let uploaded = 0;
    let failed = 0;

    for (const desc of fileDescriptors) {
      const presignEntry = presignByName.get(desc.name);
      if (!presignEntry) {
        failed++;
        // Already reported in the batch diagnostic above — no duplicate warning needed
        continue;
      }

      try {
        await this._uploadFileViaPresignedUrl(desc._localPath, presignEntry.upload_url);
        uploaded++;
        if (progressCallback) {
          const rel = path.relative(localFolderPath, desc._localPath).replace(/\\/g, '/');
          progressCallback({ message: `Uploaded ${uploaded}/${files.length}: ${rel}`, status: 'uploading' });
        }
      } catch (error) {
        failed++;
        logger.logError(`Failed to upload ${presignEntry.s3_key || desc.name}`, error);
      }
    }

    return { uploaded, failed, total: files.length };
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
    const folderName = path.basename(localFolderPath);
    const files = this._getAllFiles(localFolderPath);
    let uploaded = 0;
    let failed = 0;

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
