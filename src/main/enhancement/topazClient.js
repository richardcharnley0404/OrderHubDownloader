'use strict';

/**
 * src/main/enhancement/topazClient.js
 *
 * Topaz Image API client for cloud AI image enhancement.
 * API base: https://api.topazlabs.com/image/v1
 *
 * Async enhancement flow:
 *   1. POST /enhance/async    — upload image (multipart/form-data), receive process_id + eta
 *   2. Poll GET /status/{id}  — every 5 s until 'Completed' or 'Failed'
 *   3. GET /download/{id}     — receive presigned download URL
 *   4. Download enhanced file — overwrite destPath
 *
 * HTTP 429 responses are retried with exponential backoff (5 s start, doubling).
 *
 * Exports:
 *   testApiKey(apiKey)                 → { valid: boolean, error?: string }
 *   enhance(destPath, options, apiKey) → Promise<void>  (overwrites destPath)
 */

const fs   = require('fs');
const https = require('https');
const path  = require('path');

const BASE_HOST = 'api.topazlabs.com';
const BASE_PATH = '/image/v1';

// ── Low-level HTTP helpers ────────────────────────────────────────────────────

/**
 * Make an HTTPS request and return { statusCode, headers, body } where body
 * is the raw response string.  Rejects only on network errors.
 *
 * @param {object} options  Node https.request options object
 * @param {Buffer} [body]   Request body for POST/PUT requests
 * @returns {Promise<{ statusCode: number, headers: object, body: string }>}
 */
function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          body:       Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Authenticated GET to the Topaz API.
 */
function apiGet(apiKey, urlPath) {
  return makeRequest({
    hostname: BASE_HOST,
    path:     BASE_PATH + urlPath,
    method:   'GET',
    headers: {
      'X-API-Key': apiKey,
      'Accept':    'application/json',
    },
  });
}

/**
 * POST multipart/form-data to the Topaz API.
 *
 * @param {string} apiKey
 * @param {string} urlPath
 * @param {object} fields    Plain string fields: { name: value, ... }
 * @param {object} fileField { name, filename, contentType, buffer }
 */
function apiPostMultipart(apiKey, urlPath, fields, fileField) {
  const boundary = `----TopazBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts    = [];

  // String fields
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  // Binary file field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n` +
    `Content-Type: ${fileField.contentType}\r\n\r\n`
  ));
  parts.push(fileField.buffer);
  parts.push(Buffer.from('\r\n'));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return makeRequest({
    hostname:     BASE_HOST,
    path:         BASE_PATH + urlPath,
    method:       'POST',
    headers: {
      'X-API-Key':      apiKey,
      'Accept':         'application/json',
      'Content-Type':   `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  }, body);
}

/**
 * Download a URL to a local file, following one level of HTTP redirect.
 *
 * @param {string} url       HTTPS URL (presigned or plain)
 * @param {string} destPath  Absolute destination path
 * @returns {Promise<void>}
 */
function downloadUrl(url, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search }, res => {
      // Follow one redirect (common for presigned S3 URLs)
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        downloadUrl(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', err => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Retry a request function on HTTP 429 with exponential backoff.
 * startDelay: 5 s, doubles each attempt, up to maxAttempts retries.
 *
 * @param {function(): Promise<{statusCode}>} fn
 * @param {number} [maxAttempts=4]
 * @returns {Promise<object>} Final response
 */
async function withBackoff(fn, maxAttempts = 4) {
  let delay = 5000;
  let res;
  for (let i = 0; i < maxAttempts; i++) {
    res = await fn();
    if (res.statusCode !== 429) return res;
    if (i < maxAttempts - 1) await sleep(delay);
    delay *= 2;
  }
  return res; // return 429 if we exhausted retries
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a Topaz API key by calling GET /status.
 * Returns { valid: true } on HTTP 200, { valid: false, error } otherwise.
 *
 * @param {string} apiKey
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
async function testApiKey(apiKey) {
  try {
    const res  = await withBackoff(() => apiGet(apiKey, '/status'));
    if (res.statusCode === 200) return { valid: true };
    const body = parseJson(res.body);
    return {
      valid: false,
      error: body?.message || body?.error || `HTTP ${res.statusCode}`,
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Enhance an image file using the Topaz Image API.
 *
 * The image at destPath is uploaded as the source, and the enhanced result
 * is downloaded back, overwriting destPath.  enhancementManager copies the
 * working file to the cache path first, then passes the cache path here.
 *
 * @param {string} destPath  Absolute path to the image file (read + overwritten)
 * @param {object} options   { model?: string, face_enhancement?: boolean }
 * @param {string} apiKey
 * @returns {Promise<void>}
 */
async function enhance(destPath, options = {}, apiKey) {
  const model           = options.model           || 'Standard V2';
  const faceEnhancement = options.face_enhancement || false;

  // ── Step 1: Upload and start async job ──────────────────────────────────────
  const imageBuffer = fs.readFileSync(destPath);
  const filename    = path.basename(destPath);
  const ext         = path.extname(filename).toLowerCase().replace('.', '');
  const contentType = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';

  const startRes = await withBackoff(() =>
    apiPostMultipart(apiKey, '/enhance/async',
      {
        model:            model,
        face_enhancement: String(faceEnhancement),
      },
      {
        name:        'image',
        filename,
        contentType,
        buffer:      imageBuffer,
      }
    )
  );

  if (startRes.statusCode < 200 || startRes.statusCode >= 300) {
    const body = parseJson(startRes.body);
    throw new Error(
      `Topaz enhance/async failed (HTTP ${startRes.statusCode}): ` +
      (body?.message || body?.error || startRes.body)
    );
  }

  const startBody = parseJson(startRes.body);
  const processId = startBody?.process_id;
  const eta       = (typeof startBody?.eta === 'number') ? startBody.eta : 120; // seconds

  if (!processId) {
    throw new Error(`Topaz API did not return a process_id. Response: ${startRes.body}`);
  }

  // ── Step 2: Poll /status/{process_id} every 5 s ─────────────────────────────
  // Timeout = 3× ETA, minimum 5 minutes.
  const maxWaitMs = Math.max(eta * 3, 300) * 1000;
  const deadline  = Date.now() + maxWaitMs;
  let   lastStatus;

  while (Date.now() < deadline) {
    await sleep(5000);

    const pollRes  = await withBackoff(() => apiGet(apiKey, `/status/${processId}`));
    if (pollRes.statusCode !== 200) {
      const body = parseJson(pollRes.body);
      throw new Error(
        `Topaz status check failed (HTTP ${pollRes.statusCode}): ` +
        (body?.message || pollRes.body)
      );
    }

    const pollBody = parseJson(pollRes.body);
    lastStatus = pollBody?.status;

    if (lastStatus === 'Completed') break;
    if (lastStatus === 'Failed') {
      throw new Error(
        `Topaz enhancement failed: ${pollBody?.message || pollBody?.error || 'Unknown error'}`
      );
    }
    // 'Processing', 'Queued', etc. — keep polling
  }

  if (lastStatus !== 'Completed') {
    throw new Error(
      `Topaz enhancement timed out after ${Math.round(maxWaitMs / 1000)} s ` +
      `(last status: ${lastStatus || 'unknown'})`
    );
  }

  // ── Step 3: Get presigned download URL ──────────────────────────────────────
  const dlRes = await withBackoff(() => apiGet(apiKey, `/download/${processId}`));
  if (dlRes.statusCode !== 200) {
    const body = parseJson(dlRes.body);
    throw new Error(
      `Topaz download request failed (HTTP ${dlRes.statusCode}): ` +
      (body?.message || dlRes.body)
    );
  }

  const dlBody = parseJson(dlRes.body);
  // Accept any of the common field names the API might use
  const downloadLink =
    dlBody?.url ||
    dlBody?.download_url ||
    dlBody?.presigned_url ||
    dlBody?.link;

  if (!downloadLink) {
    throw new Error(`Topaz API did not return a download URL. Response: ${dlRes.body}`);
  }

  // ── Step 4: Download enhanced image, overwrite destPath ─────────────────────
  await downloadUrl(downloadLink, destPath);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { testApiKey, enhance };
