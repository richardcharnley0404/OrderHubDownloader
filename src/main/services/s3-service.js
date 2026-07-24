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
   * @param {object}   [manifestExtra]  - shallow-merged into the completion
   *                                      manifest JSON AFTER the built-in
   *                                      fields (built-ins win on collision).
   *                                      Used by film-scan uploads to carry
   *                                      matched job / twin-check context.
   * @returns {Promise<{ uploaded: number, failed: number, total: number }>}
   */
  async uploadFolder(localFolderPath, s3Prefix, credentials, progressCallback, manifestExtra = null) {
    if (credentials.provider === 'amazon') {
      return this._uploadFolderAmazon(localFolderPath, s3Prefix, credentials, progressCallback, manifestExtra);
    }
    return this._uploadFolderPixfizz(localFolderPath, s3Prefix, credentials, progressCallback, manifestExtra);
  }

  // ── Pixfizz (pre-signed URL) path ───────────────────────────────────────────

  async _uploadFolderPixfizz(localFolderPath, s3Prefix, credentials, progressCallback, manifestExtra = null) {
    const folderName = path.basename(localFolderPath);
    const S3_EXCLUDED_EXTENSIONS = ['.thm', '.txt'];
    const files = this._getAllFiles(localFolderPath)
      .filter(f => !S3_EXCLUDED_EXTENSIONS.includes(path.extname(f).toLowerCase()));

    if (files.length === 0) {
      return { uploaded: 0, failed: 0, total: 0, failedFiles: [] };
    }

    // The OH API uses a folder token ('film-scans', 'file-uploads', etc.) rather than
    // full S3 keys. Extract it from the leading segment of s3Prefix.
    const s3Folder = s3Prefix.split('/')[0]; // e.g. 'film-scans' or 'file-uploads'

    // 2026-07-24 — track failed files (name + short reason) rather than
    // a bare count. The array is the source of truth for the second-pass
    // retry AND populates the manifest's failed_files[]. Each entry:
    //   { filePath, name, sub_path, reason }
    let uploaded = 0;
    const uploadedSet = new Set();  // absolute filePath → skip in later passes
    let failedFiles = [];           // rewritten per pass; final value goes to manifest

    // Early-abort guard: if presign / S3 keeps returning transient failures
    // (network drop, or a struggling gateway returning 502/503 nonstop),
    // bail out of the batch after N consecutive transient failures instead
    // of grinding every remaining file through its full retry ladder. The
    // 10-min self-heal picks up the roll for another try later.
    // 2026-07-24 widened: HTTP 5xx / 429 responses count toward the abort
    // budget too — the previous version only counted low-level network
    // errors, so a persistent 502 wave burned through every file's retry
    // ladder before falling out.
    const NET_ABORT = 2;

    // Reason truncator — HTML error bodies from 502 pages would bloat the
    // manifest otherwise.
    const reason = (err) => this._truncateReason(err);

    // Single-file try. Returns { ok: true } on success, { ok: false, err,
    // transient: bool } on failure. Doesn't touch outer counters — the
    // caller (loop below) manages uploaded/failedFiles/consecutive.
    const tryOne = async (filePath) => {
      const relPath  = path.relative(localFolderPath, filePath).replace(/\\/g, '/');
      const name     = path.basename(relPath);
      const relDir   = path.dirname(relPath);
      const sub_path = relDir === '.' ? folderName : `${folderName}/${relDir}`;
      const stat     = fs.statSync(filePath);
      const desc     = { name, folder: s3Folder, sub_path, size: stat.size, type: this._getContentType(filePath) };

      let presignEntry;
      try {
        const presigned = await presignService.getPresignedUrls([desc], credentials.locationId || null);
        presignEntry = presigned[0];
      } catch (err) {
        return { ok: false, name, sub_path, err, transient: this._isTransientPresignError(err) };
      }
      if (!presignEntry || !presignEntry.upload_url) {
        return { ok: false, name, sub_path, err: new Error('presignService returned no URL'), transient: false };
      }
      try {
        await this._uploadWithRetry(filePath, presignEntry.upload_url, presignEntry.s3_key || name);
        return { ok: true, name, sub_path, relPath };
      } catch (err) {
        return { ok: false, name, sub_path, err, transient: this._isTransientPutError(err) };
      }
    };

    // Run one full pass over `passFiles`. Mutates `uploaded` / `uploadedSet`
    // and returns the pass's failedFiles[] plus an `aborted` flag.
    const runPass = async (passFiles, passLabel) => {
      let consecutiveTransientFails = 0;
      let aborted = false;
      const passFailed = [];
      for (const filePath of passFiles) {
        if (uploadedSet.has(filePath)) continue;  // belt (never should be in passFiles)
        const r = await tryOne(filePath);
        if (r.ok) {
          uploaded++;
          uploadedSet.add(filePath);
          consecutiveTransientFails = 0;
          if (progressCallback) {
            progressCallback({ message: `Uploaded ${uploaded}/${files.length}: ${r.relPath} (${passLabel})`, status: 'uploading' });
          }
        } else {
          logger.logError(`Failed to upload ${r.sub_path}/${r.name} (${passLabel})`, r.err);
          passFailed.push({ filePath, name: r.name, sub_path: r.sub_path, reason: reason(r.err) });
          if (r.transient) {
            if (++consecutiveTransientFails >= NET_ABORT) { aborted = true; break; }
          } else {
            consecutiveTransientFails = 0;
          }
        }
      }
      // If aborted early, treat every un-attempted file in this pass as
      // failed too, so the final state accurately reflects "nothing else
      // got uploaded this pass".
      if (aborted) {
        const attempted = new Set(passFailed.map((f) => f.filePath));
        for (const filePath of passFiles) {
          if (uploadedSet.has(filePath)) continue;
          if (attempted.has(filePath)) continue;
          passFailed.push({
            filePath,
            name: path.basename(filePath),
            sub_path: (() => {
              const rel = path.relative(localFolderPath, filePath).replace(/\\/g, '/');
              const dir = path.dirname(rel);
              return dir === '.' ? folderName : `${folderName}/${dir}`;
            })(),
            reason: `not attempted — pass aborted after ${NET_ABORT} consecutive transient failures`,
          });
        }
      }
      return { passFailed, aborted };
    };

    // Initial pass — every file.
    try {
      const first = await runPass(files, 'pass 1');
      failedFiles = first.passFailed;
      if (first.aborted) {
        logger.logWarning(`filmScans: pass 1 of ${folderName} aborted early — ${NET_ABORT} consecutive transient failures. ${uploaded}/${files.length} uploaded so far.`);
      }
    } catch (outerError) {
      // Unexpected non-per-file error (e.g. fs failure enumerating).
      logger.logError(`filmScans: unexpected error during pass 1 for ${folderName}`, outerError);
      // Synthesize failedFiles for every not-yet-uploaded so the manifest
      // still records the failure list.
      failedFiles = files
        .filter((fp) => !uploadedSet.has(fp))
        .map((filePath) => ({
          filePath,
          name: path.basename(filePath),
          sub_path: folderName,
          reason: reason(outerError),
        }));
    }

    // Second-pass retries. Up to 2 additional sweeps over ONLY the still-
    // failed files, with a short wait between. Handles the "gateway
    // flapped during the batch" case where the per-file retry couldn't
    // outrun the blip but a 2-second breath is enough.
    const SECOND_PASS_ATTEMPTS = 2;
    const SECOND_PASS_WAIT_MS  = 2000;
    for (let pass = 2; pass <= 1 + SECOND_PASS_ATTEMPTS; pass++) {
      if (failedFiles.length === 0) break;
      const stillFailed = failedFiles.map((f) => f.filePath);
      logger.info(`filmScans: pass ${pass} — retrying ${stillFailed.length} still-failed file(s) after ${SECOND_PASS_WAIT_MS} ms`);
      await new Promise(r => setTimeout(r, SECOND_PASS_WAIT_MS));
      const next = await runPass(stillFailed, `pass ${pass}`);
      failedFiles = next.passFailed;
      if (next.aborted) {
        logger.logWarning(`filmScans: pass ${pass} of ${folderName} aborted early — persistent transient failures. Deferring to 10-min self-heal.`);
        break;
      }
    }

    const failed = failedFiles.length;

    // ── Manifest ─────────────────────────────────────────────────────────────
    // Always written, regardless of upload errors, so OH always knows the folder exists.
    try {
      const { name: manifestName, buffer: manifestBuffer } =
        this._buildManifestPayload(folderName, files, failedFiles, manifestExtra);

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
          logger.logWarning(`filmScans: manifest written with ${failed} error(s) for folder ${folderName} — 10-min self-heal will re-attempt the still-failed files`);
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

    return { uploaded, failed, total: files.length, failedFiles };
  }

  /**
   * Classify a caught presign error as transient (worth retrying at
   * higher levels / counting toward early-abort budget). Mirrors
   * presignService.isRetryableOutcome — for messages produced by
   * getPresignedUrls after its own retry ladder gave up.
   */
  _isTransientPresignError(err) {
    const msg = err && err.message ? err.message : '';
    const httpMatch = msg.match(/HTTP (\d{3})/);
    if (httpMatch) {
      const status = Number(httpMatch[1]);
      if (status === 429) return true;
      if (status >= 500 && status < 600) return true;
      return false;
    }
    return /(socket hang up|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT|timed out|network stalled|Request timeout)/i.test(msg);
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
   * Wrap _uploadFileViaPresignedUrl with retries on transient failures.
   * Transient = network errors (socket hang up, ECONNRESET, ETIMEDOUT,
   * EPIPE, EAI_AGAIN, "timed out") OR HTTP 429 (throttle) OR HTTP 5xx
   * (server-side / gateway). Non-transient HTTP responses (4xx except
   * 429) throw immediately because more attempts won't fix a 403.
   *
   * 4 attempts with backoffs [1s, 3s, 7s] + up to 500 ms jitter per
   * wait — matches the presign layer's rhythm so a bad blip that
   * hits both is handled at roughly the same cadence.
   */
  async _uploadWithRetry(filePath, presignedUrl, label) {
    const MAX_ATTEMPTS = 4;
    const BACKOFFS_MS  = [1_000, 3_000, 7_000];
    const JITTER_MS    = 500;
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
        const transient = this._isTransientPutError(err);
        if (!transient || attempt === MAX_ATTEMPTS) throw err;
        const wait = BACKOFFS_MS[attempt - 1] + Math.floor(Math.random() * JITTER_MS);
        logger.logWarning(`s3: ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed transiently (${err.message}), retrying in ${wait} ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  /**
   * Classify a caught PUT error as transient (worth retrying) or fatal
   * (throw fast). Error messages produced by _uploadFileViaPresignedUrl
   * have the shape "Upload failed: HTTP {N} — …" so we parse the status
   * with a small regex. Anything without a parsable status falls back to
   * the network-error regex.
   */
  _isTransientPutError(err) {
    const msg = err && err.message ? err.message : '';
    const httpMatch = msg.match(/HTTP (\d{3})/);
    if (httpMatch) {
      const status = Number(httpMatch[1]);
      if (status === 429) return true;
      if (status >= 500 && status < 600) return true;
      return false; // 4xx (non-429) — fatal
    }
    return /(socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|timed out|network stalled)/i.test(msg);
  }

  /**
   * Truncate an error message for storage in the manifest's failed_files[]
   * entries. Servers sometimes return a full HTML body on 502 — that
   * would bloat the manifest JSON needlessly. Take the first line only
   * (drop everything past \n) and cap at `max` chars, appending "…" on
   * truncation.
   */
  _truncateReason(err, max = 120) {
    let s = (err && err.message ? err.message : String(err || 'unknown')).trim();
    const nl = s.indexOf('\n');
    if (nl !== -1) s = s.slice(0, nl).trim();
    if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
    return s;
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
        // No-progress (idle) timeout: resets on socket activity, so a healthy
        // transfer never trips it; a stalled/half-open socket does, in ~2 min.
        timeout: 120000
      };

      // Single-settle guard + a wall-clock BACKSTOP. The socket-idle `timeout`
      // above does NOT reliably fire when the network drops mid-transfer and the
      // TCP socket goes half-open (the exact "stuck Uploading… with no network
      // activity" failure). This absolute timer always fires, so the await can
      // never hang forever. Cleared on settle.
      let settled = false;
      let req = null;
      let hardTimer = null;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
        if (err) { try { if (req) req.destroy(); } catch (_) { /* ignore */ } reject(err); }
        else resolve();
      };
      hardTimer = setTimeout(
        () => finish(new Error('Upload request timed out (network stalled)')),
        600000 // 10 min absolute cap
      );

      req = protocol.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) finish();
          else finish(new Error(`Upload failed: HTTP ${res.statusCode} — ${body.substring(0, 200)}`));
        });
        res.on('error', (e) => finish(e));
      });

      req.on('error', (e) => finish(e));
      req.on('timeout', () => finish(new Error('Upload request timed out')));

      // Stream the file — works for any size without loading into memory
      const readStream = fs.createReadStream(filePath);
      readStream.on('error', (e) => finish(e));
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

  async _uploadFolderAmazon(localFolderPath, s3Prefix, credentials, progressCallback, manifestExtra = null) {
    const client = this._createAmazonClient(credentials);
    const S3_EXCLUDED_EXTENSIONS = ['.thm', '.txt'];
    const folderName = path.basename(localFolderPath);
    const files = this._getAllFiles(localFolderPath)
      .filter(f => !S3_EXCLUDED_EXTENSIONS.includes(path.extname(f).toLowerCase()));
    let uploaded = 0;
    // 2026-07-24 — track per-file failures like the Pixfizz path so both
    // providers write a manifest with the same failed_files[] shape. The
    // AWS SDK has its own built-in retry ladder, so no second-pass here.
    const failedFiles = [];
    const reason = (err) => this._truncateReason(err);

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
            failedFiles.push({
              name:     path.basename(relativePath),
              sub_path: path.dirname(relativePath) === '.' ? folderName : `${folderName}/${path.dirname(relativePath)}`,
              reason:   reason(error),
            });
            logger.logError(`Failed to upload ${s3Key}`, error);
          }
        }
      } catch (outerError) {
        // Mirror Pixfizz semantics: even an unexpected error mid-loop must not
        // skip the manifest write — OH relies on it to know the folder is done.
        const alreadyAccountedFor = new Set(failedFiles.map((f) => `${f.sub_path}/${f.name}`));
        for (const filePath of files) {
          const relativePath = path.relative(localFolderPath, filePath).replace(/\\/g, '/');
          const name = path.basename(relativePath);
          const sub_path = path.dirname(relativePath) === '.' ? folderName : `${folderName}/${path.dirname(relativePath)}`;
          const key = `${sub_path}/${name}`;
          if (alreadyAccountedFor.has(key)) continue;
          // Uploaded ones are neither in failedFiles nor should be added here;
          // approximate by only synthesising failures for files beyond the
          // current uploaded count.
          if (uploaded > 0 && files.indexOf(filePath) < uploaded) continue;
          failedFiles.push({ name, sub_path, reason: reason(outerError) });
        }
        logger.logError(`amazon: unexpected error during upload loop for ${folderName} — falling through to manifest`, outerError);
      }

      const failed = failedFiles.length;

      // ── Manifest ──────────────────────────────────────────────────────────
      // Mandatory for OH ingest. Always written, regardless of upload errors.
      // Errors here are swallowed so they never affect the reported result.
      try {
        const { name: manifestName, buffer: manifestBuffer } =
          this._buildManifestPayload(folderName, files, failedFiles, manifestExtra);
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

      return { uploaded, failed, total: files.length, failedFiles };
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
   * @param {object}   [manifestExtra] - optional caller-supplied fields
   *                                     (snake_case) shallow-merged AFTER the
   *                                     built-in fields. Built-in fields
   *                                     always win on key collision so
   *                                     folder/total_files/etc. can never be
   *                                     overwritten.
   * @returns {{ name: string, buffer: Buffer }}
   */
  /**
   * @param {string}   folderName
   * @param {string[]} files
   * @param {number|Array<{name, sub_path?, reason}>} failedOrFailedFiles
   *   Either a bare failure count (back-compat with older callers), or
   *   the full array of failed-file records. When an array is passed,
   *   `errors` is derived from its length and the array is written
   *   verbatim into `failed_files`. When a number is passed,
   *   `failed_files` is an empty array (no per-file detail available).
   * @param {object}   [manifestExtra]
   * @returns {{ name: string, buffer: Buffer }}
   */
  _buildManifestPayload(folderName, files, failedOrFailedFiles, manifestExtra = null) {
    const { app } = require('electron');
    const tiffExts = new Set(['.tif', '.tiff']);
    const jpegExts = new Set(['.jpg', '.jpeg']);
    const tiffCount = files.filter(f => tiffExts.has(path.extname(f).toLowerCase())).length;
    const jpgCount  = files.filter(f => jpegExts.has(path.extname(f).toLowerCase())).length;

    // Normalise: number → derive empty array; array → derive count from it.
    let failedFiles = [];
    let failed = 0;
    if (Array.isArray(failedOrFailedFiles)) {
      failedFiles = failedOrFailedFiles.map((f) => ({
        name:     f && f.name ? String(f.name) : 'unknown',
        // sub_path is optional — omit when the caller didn't set it.
        ...(f && f.sub_path ? { sub_path: String(f.sub_path) } : {}),
        reason:   f && f.reason ? String(f.reason) : 'unknown',
      }));
      failed = failedFiles.length;
    } else if (Number.isFinite(failedOrFailedFiles)) {
      failed = failedOrFailedFiles;
    }

    const builtIn = {
      folder:       folderName,
      total_files:  files.length,
      tiff_count:   tiffCount,
      jpg_count:    jpgCount,
      errors:       failed,
      // 2026-07-24 — per-file failure detail so OrderHub can diagnose which
      // files broke without opening the OHD log. Always present; empty
      // array on a clean run so consumers can key off length interchangeably
      // with `errors`. Reasons are pre-truncated (~120 chars) upstream so
      // this can't blow up the JSON size on an HTML 502 body.
      failed_files: failedFiles,
      completed_at: new Date().toISOString(),
      ohd_version:  app.getVersion()
    };

    // Merge extras AFTER built-ins so built-in keys always win on collision.
    // Null-safe: any non-object (null, undefined, string, array) skips merging.
    let payload = builtIn;
    if (manifestExtra && typeof manifestExtra === 'object' && !Array.isArray(manifestExtra)) {
      payload = { ...manifestExtra, ...builtIn };
    }

    return {
      name:   `${folderName}.json`,
      buffer: Buffer.from(JSON.stringify(payload), 'utf8')
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
