const https = require('https');
const http = require('http');
const configService = require('./config-service');
const logger = require('./logger');

// 2026-07-24 — transient-failure retry. Presign is idempotent (returns
// URLs, no server-side state mutation), so retrying on 5xx / 429 /
// network errors is safe. 4 attempts total with backoffs; 4xx (except
// 429) throws fast because they don't get better with retries.
const RETRY_BACKOFFS_MS = [1000, 3000, 7000];  // waits BEFORE attempts 2,3,4
const RETRY_JITTER_MS   = 500;

/**
 * A transient response is one where retrying might work: transport-layer
 * errors (socket hang up, ECONNRESET, timeouts) OR HTTP 429 (throttling)
 * OR HTTP 5xx (server-side / gateway). Exported so callers who compose
 * their own error-handling (folder-watch's consecutive-failure early
 * abort) can classify errors the same way.
 *
 * @param {{ transportError?: Error, statusCode?: number }} outcome
 */
function isRetryableOutcome(outcome) {
  if (!outcome) return false;
  if (outcome.transportError) return true;
  const s = outcome.statusCode;
  if (!Number.isFinite(s)) return false;
  if (s === 429) return true;
  if (s >= 500 && s < 600) return true;
  return false;
}

/**
 * Requests pre-signed S3 upload URLs from the OrderHub API.
 * IBM S3 credentials live only on the OH server — OHD never sees them.
 *
 * POST /ohd-api/uploads/presign
 * x-api-key: {apiKey}
 * X-Location-ID: {locationId}   (optional — scopes film-scan paths to the location)
 *
 * Request body:
 * {
 *   "files": [
 *     { "name": "image001.tif", "folder": "film-scans", "sub_path": "order-1234", "size": 2048000, "type": "image/tiff" },
 *     ...
 *   ]
 * }
 *
 * Allowed folders: film-scans, file-uploads, artwork, production, production-tickets
 *
 * Response:
 * {
 *   "files": [
 *     { "name": "image001.tif", "upload_url": "https://s3...?X-Amz-Expires=900&...", "s3_key": "film-scans/loc/order-1234/image001.tif", "expires_in": 900 },
 *     ...
 *   ]
 * }
 */
class PresignService {
  /**
   * Request pre-signed PUT URLs for a batch of files in a single round-trip.
   *
   * @param {Array<{ name: string, folder: string, sub_path?: string, size?: number, type?: string }>} fileDescriptors
   * @param {string|null} locationId  — sent as X-Location-ID header when provided
   * @returns {Promise<Array<{ name: string, upload_url: string, s3_key: string }>>}
   */
  async getPresignedUrls(fileDescriptors, locationId = null) {
    const { baseUrl, key: apiKey } = configService.getApiSettings();

    if (!apiKey) {
      throw new Error('OrderHub API key not configured — cannot request pre-signed upload URLs');
    }

    const url = `${baseUrl}/uploads/presign`;
    const body = { files: fileDescriptors };

    const extraHeaders = {};
    if (locationId) extraHeaders['X-Location-ID'] = locationId;

    logger.info(`presignService: requesting ${fileDescriptors.length} pre-signed URL(s)`, {
      url,
      locationId: locationId || null,
      files: fileDescriptors.map(f => ({ name: f.name, folder: f.folder, sub_path: f.sub_path, size: f.size, type: f.type }))
    });

    // 2026-07-24 — retry loop over transient failures. Each iteration
    // returns an "outcome" (transport error, or HTTP-level parse
    // result); isRetryableOutcome decides whether to try again. Non-
    // retryable outcomes (2xx success OR 4xx-non-429) fall through
    // immediately with either the parsed result or a thrown error.
    const MAX_ATTEMPTS = RETRY_BACKOFFS_MS.length + 1;
    let lastOutcome = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const outcome = await this._attemptPresign(url, apiKey, body, extraHeaders);
      lastOutcome = outcome;

      if (outcome.results) {
        // 2xx and JSON parsed OK — done, whether attempt 1 or the last one.
        if (attempt > 1) {
          logger.info(`presignService: succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
        }
        return outcome.results;
      }

      const retryable = isRetryableOutcome(outcome);
      if (!retryable || attempt === MAX_ATTEMPTS) {
        // Either non-retryable (4xx / non-transient) OR out of attempts.
        // Throw the accumulated error message.
        throw new Error(outcome.errorMessage);
      }

      const wait = RETRY_BACKOFFS_MS[attempt - 1] + Math.floor(Math.random() * RETRY_JITTER_MS);
      const label = outcome.transportError
        ? `network: ${outcome.transportError.message || outcome.transportError}`
        : `HTTP ${outcome.statusCode}`;
      logger.logWarning(`presignService: attempt ${attempt}/${MAX_ATTEMPTS} transient failure (${label}), retrying in ${wait} ms`);
      await new Promise(r => setTimeout(r, wait));
    }

    // Unreachable — the loop either returns or throws — but keep an
    // explicit throw so the type-inference (and future editors) can't
    // misread the fall-through.
    throw new Error(lastOutcome ? lastOutcome.errorMessage : 'Presign request failed');
  }

  /**
   * Single presign attempt. NEVER throws; always resolves with an
   * outcome object:
   *   { results, statusCode }              — 2xx + valid JSON
   *   { errorMessage, statusCode }         — HTTP-level failure (4xx/5xx or 2xx with success:false or JSON parse fail)
   *   { errorMessage, transportError }     — socket / DNS / timeout
   *
   * The retry loop above uses `results` (success) vs `transportError`
   * / `statusCode` (isRetryableOutcome) to decide next action.
   */
  async _attemptPresign(url, apiKey, body, extraHeaders) {
    let response;
    try {
      response = await this._httpRequest('POST', url, apiKey, body, extraHeaders);
    } catch (err) {
      return {
        transportError: err,
        errorMessage:   `Presign request failed: ${err && err.message ? err.message : String(err)}`,
      };
    }

    // Always log the raw response body in the message string so it appears in
    // the log file regardless of how the logger formats metadata.
    logger.info(
      `presignService: response HTTP ${response.statusCode} — ${response.body.substring(0, 500)}`
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        statusCode:   response.statusCode,
        errorMessage: `Presign request failed: HTTP ${response.statusCode} — ${response.body.substring(0, 300)}`,
      };
    }

    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      // Non-retryable — 2xx with an unparseable body is a server bug, not a blip.
      return {
        statusCode:   response.statusCode,
        errorMessage: `Presign response was not valid JSON: ${response.body.substring(0, 200)}`,
      };
    }

    // Some endpoints return { success: false, error: "..." } with a 200 status.
    // Non-retryable — the server is telling us the request itself was bad.
    if (data.success === false) {
      return {
        statusCode:   response.statusCode,
        errorMessage: `Presign API error: ${data.error || data.message || JSON.stringify(data).substring(0, 200)}`,
      };
    }

    // Normalise field names: API returns { uploads: [...] } with file_name/file_key per entry
    const results = (data.uploads || data.files || []).map(r => ({
      name:       r.name      || r.file_name,
      s3_key:     r.s3_key    || r.file_key,
      upload_url: r.upload_url,
      expires_in: r.expires_in
    }));

    logger.info(`presignService: received ${results.length}/${body.files.length} pre-signed URL(s)`, {
      returned: results.map(r => ({ name: r.name, s3_key: r.s3_key }))
    });
    return { results, statusCode: response.statusCode };
  }

  /**
   * Lightweight connectivity/auth check — GET the base API health endpoint.
   * Avoids hitting /uploads/presign (which requires a non-empty files array).
   * A 2xx response confirms the API is reachable and the key is valid.
   * @param {string|null} locationId
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async testConnection(locationId = null) {
    try {
      const { baseUrl, key: apiKey } = configService.getApiSettings();
      if (!apiKey) {
        return { success: false, error: 'OrderHub API key not configured' };
      }

      const response = await this._httpRequest('GET', baseUrl, apiKey, null, {});

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { success: true };
      }
      return {
        success: false,
        error: `HTTP ${response.statusCode} — ${response.body.substring(0, 200)}`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  _httpRequest(method, url, apiKey, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      try {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;

        const bodyStr = body ? JSON.stringify(body) : null;

        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method,
          headers: {
            'x-api-key': apiKey,          // OH presign endpoint uses x-api-key, not Bearer
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...extraHeaders
          },
          timeout: 15000
        };

        if (bodyStr) {
          options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        // Single-settle guard + wall-clock backstop, so a half-open socket
        // (network dropped) can't hang this presign request indefinitely — the
        // socket-idle `timeout` above doesn't reliably fire in that case.
        let settled = false;
        let req = null;
        let hardTimer = null;
        const finish = (err, value) => {
          if (settled) return;
          settled = true;
          if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
          if (err) { try { if (req) req.destroy(); } catch (_) { /* ignore */ } reject(err); }
          else resolve(value);
        };
        hardTimer = setTimeout(() => finish(new Error('Request timed out (network stalled)')), 30000);

        req = protocol.request(options, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => finish(null, { statusCode: res.statusCode, body: data }));
          res.on('error', (e) => finish(e));
        });

        req.on('error', (e) => finish(e));
        req.on('timeout', () => finish(new Error('Request timeout')));

        if (bodyStr) req.write(bodyStr);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

const presignServiceSingleton = new PresignService();
module.exports = presignServiceSingleton;
// 2026-07-24 — exports for callers/tests that need the transient classifier.
module.exports.isRetryableOutcome = isRetryableOutcome;
module.exports.RETRY_BACKOFFS_MS  = RETRY_BACKOFFS_MS;
