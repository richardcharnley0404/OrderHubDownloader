const https = require('https');
const http = require('http');
const configService = require('./config-service');
const logger = require('./logger');

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

    const response = await this._httpRequest('POST', url, apiKey, body, extraHeaders);

    // Always log the raw response body in the message string so it appears in the
    // log file regardless of how the logger formats metadata.
    logger.info(
      `presignService: response HTTP ${response.statusCode} — ${response.body.substring(0, 500)}`
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Presign request failed: HTTP ${response.statusCode} — ${response.body.substring(0, 300)}`
      );
    }

    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new Error(`Presign response was not valid JSON: ${response.body.substring(0, 200)}`);
    }

    // Some endpoints return { success: false, error: "..." } with a 200 status.
    // Treat this as a hard error so it surfaces in logs rather than silently
    // yielding zero URLs.
    if (data.success === false) {
      throw new Error(
        `Presign API error: ${data.error || data.message || JSON.stringify(data).substring(0, 200)}`
      );
    }

    // Normalise field names: API returns { uploads: [...] } with file_name/file_key per entry
    const results = (data.uploads || data.files || []).map(r => ({
      name:       r.name      || r.file_name,
      s3_key:     r.s3_key    || r.file_key,
      upload_url: r.upload_url,
      expires_in: r.expires_in
    }));

    logger.info(`presignService: received ${results.length}/${fileDescriptors.length} pre-signed URL(s)`, {
      returned: results.map(r => ({ name: r.name, s3_key: r.s3_key }))
    });
    return results; // [{ name, upload_url, s3_key, expires_in }]
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

        const req = protocol.request(options, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });

        if (bodyStr) req.write(bodyStr);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = new PresignService();
