/**
 * OrderHub API client — the network half of the Order XML hot folder feature.
 *
 * Wraps `POST {OH_BASE}/api-webhook` (see docs/orderhub/openapi.json) and
 * classifies the response so the watcher can decide whether to record success,
 * a duplicate, a hard failure, or a transient error eligible for retry.
 *
 * Why bespoke (rather than reusing presign-service or job-service):
 *   - Different endpoint (`/api-webhook` vs `/ohd-api/...`) on the same host.
 *   - Caller wants structured classification rather than raw status codes,
 *     because the same status (4xx) means very different things — 401 is a
 *     "stop everything, fix the API key" while 400 is a "this XML is bad,
 *     move it to failed/".
 *   - Test isolation: this client is the boundary between OHD and OrderHub,
 *     so it gets its own unit tests with a localhost mock server. Folding it
 *     into an existing service would tangle that test surface.
 *
 * Conventions:
 *   - Returns a result object; never throws on HTTP errors. Network-layer
 *     errors (DNS, ECONNRESET, timeout) are caught and surfaced as
 *     `classification: 'network_error'` so the watcher path is uniform.
 *   - Logs every submission and outcome, redacting the API key.
 *   - Accepts a constructor `baseUrl` for tests; production code uses the
 *     default exported URL.
 */

'use strict';

const http  = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const logger = require('./logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Same Supabase Functions host as `OH_API_BASE_URL` in config-service.js, but
// a different path (api-webhook vs ohd-api). Hardcoded — not user-configurable
// — for the same reason OH_API_BASE_URL is hardcoded: it's part of the app's
// integration contract and changing it requires a release.
const DEFAULT_BASE_URL = 'https://nazkcvruighrhpgcarxg.supabase.co/functions/v1';
const SUBMIT_ORDER_PATH        = '/api-webhook';
const UPDATE_ORDER_STATUS_PATH = '/update-order-status';

// Status values OrderHub accepts on /update-order-status. Sourced from the
// OpenAPI spec (UpdateOrderStatusRequest). We only ever push 'confirmed'
// for hot-folder orders today, but the constant lists the full enum so
// future code paths (cancel-on-delete, etc.) can reuse it.
const ORDER_STATUS = Object.freeze({
  PENDING:       'pending',
  CONFIRMED:     'confirmed',
  IN_PRODUCTION: 'in_production',
  READY:         'ready',
  SHIPPED:       'shipped',
  COMPLETED:     'completed',
  CANCELLED:     'cancelled',
});
const REQUEST_TIMEOUT_MS = 30000;

// Result classifications. Watcher uses these to drive its routing decisions:
//   - success / duplicate → move XML to processed/
//   - validation_error    → move XML to failed/
//   - auth_error          → fatal; pause mode + tray notify; leave XML in place
//   - server_error        → retry up to maxRetries; then failed/
//   - network_error       → retry up to maxRetries; then failed/
const CLASSIFICATIONS = Object.freeze({
  SUCCESS:          'success',
  DUPLICATE:        'duplicate',
  VALIDATION_ERROR: 'validation_error',
  AUTH_ERROR:       'auth_error',
  SERVER_ERROR:     'server_error',
  NETWORK_ERROR:    'network_error',
});

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

class OrderHubApiClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl] - override for tests
   * @param {number} [opts.timeoutMs]
   */
  constructor(opts = {}) {
    this.baseUrl   = opts.baseUrl   || DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  }

  /**
   * Submit an order to OrderHub.
   *
   * The parser produces a body without `order.organization_id`; the OpenAPI
   * spec lists organization_id as required, and explicitly notes the value
   * may equal the API key. We inject the key here so callers don't need to
   * know about that quirk.
   *
   * @param {object} args
   * @param {string} args.apiKey       - X-API-Key header value
   * @param {object} args.request      - { order, jobs } from the parser
   * @returns {Promise<{
   *   classification: string,            // one of CLASSIFICATIONS.*
   *   statusCode:     number|null,       // null on network_error
   *   body:           object|string|null,// parsed JSON if possible, else raw, else null
   *   errorMessage:   string|null,       // human-readable summary of failure
   *   orderhubOrderId: string|null,      // populated on success
   * }>}
   */
  async submitOrder({ apiKey, request, confirmAfterSubmit = false }) {
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      // Never call the API without a key — this is a programmer error in the
      // watcher, not a runtime condition. Surface loudly.
      throw new Error('orderhub-api-client: apiKey is required');
    }
    if (!request || typeof request !== 'object' || !request.order || !Array.isArray(request.jobs)) {
      throw new Error('orderhub-api-client: request must be { order: object, jobs: object[] }');
    }

    // Inject organization_id (= the API key) per OpenAPI requirement. We do
    // not mutate the caller's object — clone the order shallowly so the
    // ingestion record (which references the parser's output) doesn't end up
    // with the API key embedded.
    const body = {
      order: { organization_id: apiKey, ...request.order },
      jobs:  request.jobs,
    };

    const url = `${this.baseUrl}${SUBMIT_ORDER_PATH}`;
    const orderNumber = body.order.order_number || '(no order_number)';

    logger.info(
      `orderhub-api-client: submitting order_number=${orderNumber} ` +
      `jobs=${body.jobs.length} url=${url}`
    );

    let response;
    try {
      response = await this._httpPost(url, apiKey, body);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      logger.logError(
        `orderhub-api-client: network error submitting ${orderNumber}: ${msg}`,
        err
      );
      return {
        classification:  CLASSIFICATIONS.NETWORK_ERROR,
        statusCode:      null,
        body:            null,
        errorMessage:    msg,
        orderhubOrderId: null,
      };
    }

    const result = this._classifyResponse(response, orderNumber);

    // Optional follow-up: bump 'pending' → 'confirmed' so hot-folder orders
    // don't sit in OrderHub awaiting a manual confirm step. /api-webhook
    // creates orders in 'pending'; the only way to advance them is the
    // separate /update-order-status endpoint. If the confirm fails the
    // order is still in OrderHub (just pending), so we log the failure but
    // keep the SUCCESS classification — operators can manually confirm in
    // OrderHub if needed.
    if (confirmAfterSubmit && result.classification === CLASSIFICATIONS.SUCCESS && result.orderhubOrderId) {
      try {
        const conf = await this.setOrderStatus({
          apiKey,
          orderId: result.orderhubOrderId,
          status:  ORDER_STATUS.CONFIRMED,
        });
        if (!conf.ok) {
          logger.logWarning(
            `orderhub-api-client: order ${orderNumber} created (id=${result.orderhubOrderId}) ` +
            `but confirm failed: ${conf.errorMessage || conf.statusCode}`
          );
          result.confirmedAt = null;
          result.confirmError = conf.errorMessage || `HTTP ${conf.statusCode}`;
        } else {
          result.confirmedAt = new Date().toISOString();
          result.confirmError = null;
        }
      } catch (err) {
        // Network failure on confirm — same handling as a non-2xx; the order
        // exists but is still pending. Don't fail the whole submission.
        logger.logWarning(
          `orderhub-api-client: confirm threw for ${orderNumber}: ${err && err.message}`
        );
        result.confirmedAt = null;
        result.confirmError = (err && err.message) || String(err);
      }
    }

    return result;
  }

  /**
   * Update an order's status (e.g. 'pending' → 'confirmed'). Used by the
   * post-submit auto-confirm flow but exposed publicly so future code paths
   * (cancel, mark-shipped) can reuse it.
   *
   * @param {object} args
   * @param {string} args.apiKey  - X-API-Key
   * @param {string} args.orderId - OrderHub order_id (UUID returned by submitOrder)
   * @param {string} args.status  - one of ORDER_STATUS.*
   * @returns {Promise<{
   *   ok: boolean,
   *   statusCode: number|null,
   *   body: object|string|null,
   *   errorMessage: string|null,
   * }>}
   */
  async setOrderStatus({ apiKey, orderId, status }) {
    if (typeof apiKey !== 'string' || !apiKey) {
      throw new Error('orderhub-api-client: apiKey is required');
    }
    if (typeof orderId !== 'string' || !orderId) {
      throw new Error('orderhub-api-client: orderId is required');
    }
    if (typeof status !== 'string' || !Object.values(ORDER_STATUS).includes(status)) {
      throw new Error(`orderhub-api-client: invalid status "${status}"`);
    }

    const url = `${this.baseUrl}${UPDATE_ORDER_STATUS_PATH}`;
    logger.info(`orderhub-api-client: setOrderStatus ${orderId} → ${status}`);

    let response;
    try {
      response = await this._httpPost(url, apiKey, { order_id: orderId, status });
    } catch (err) {
      return {
        ok: false, statusCode: null, body: null,
        errorMessage: (err && err.message) || String(err),
      };
    }

    const parsed = tryParseJson(response.body);
    const ok = response.statusCode === 200;
    return {
      ok,
      statusCode:   response.statusCode,
      body:         parsed ?? response.body,
      errorMessage: ok ? null : (formatErrorMessage(parsed) || `HTTP ${response.statusCode}`),
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Map an HTTP response to a classification + structured result. Pulls
   * meaningful errorMessage strings out of the OrderHub error envelope when
   * present (`{ error, message, validation_errors }` per the spec).
   */
  _classifyResponse(response, orderNumber) {
    const { statusCode, body: rawBody } = response;
    const parsedBody = tryParseJson(rawBody);

    if (statusCode === 200) {
      logger.info(
        `orderhub-api-client: submitted ${orderNumber} → 200 OK ` +
        `order_id=${(parsedBody && parsedBody.order_id) || '?'}`
      );
      return {
        classification:  CLASSIFICATIONS.SUCCESS,
        statusCode,
        body:            parsedBody ?? rawBody,
        errorMessage:    null,
        orderhubOrderId: parsedBody && typeof parsedBody.order_id === 'string'
          ? parsedBody.order_id
          : null,
      };
    }

    if (statusCode === 409) {
      // Per spec: { error: "Duplicate order", existing_order_id: "..." }
      const existingId = parsedBody && (parsedBody.existing_order_id || parsedBody.order_id);
      logger.info(
        `orderhub-api-client: duplicate ${orderNumber} → 409 ` +
        `existing_order_id=${existingId || '?'}`
      );
      return {
        classification:  CLASSIFICATIONS.DUPLICATE,
        statusCode,
        body:            parsedBody ?? rawBody,
        errorMessage:    null,
        orderhubOrderId: typeof existingId === 'string' ? existingId : null,
      };
    }

    if (statusCode === 401 || statusCode === 403) {
      logger.logWarning(
        `orderhub-api-client: auth error submitting ${orderNumber} → ${statusCode}`
      );
      return {
        classification:  CLASSIFICATIONS.AUTH_ERROR,
        statusCode,
        body:            parsedBody ?? rawBody,
        errorMessage:    formatErrorMessage(parsedBody) ||
                         `Authentication failed (HTTP ${statusCode}). Check API key in settings.`,
        orderhubOrderId: null,
      };
    }

    if (statusCode >= 400 && statusCode < 500) {
      // 400 / 422 / etc — order is malformed in some way. The XML is the
      // problem; routing to failed/ is correct.
      const msg = formatErrorMessage(parsedBody) || `Validation failed (HTTP ${statusCode})`;
      logger.logWarning(
        `orderhub-api-client: validation error submitting ${orderNumber} → ${statusCode} ${msg}`
      );
      return {
        classification:  CLASSIFICATIONS.VALIDATION_ERROR,
        statusCode,
        body:            parsedBody ?? rawBody,
        errorMessage:    msg,
        orderhubOrderId: null,
      };
    }

    // 5xx and anything else (e.g. 0 / weird proxy responses) → server error,
    // eligible for retry by the watcher.
    const msg = formatErrorMessage(parsedBody) || `Server error (HTTP ${statusCode})`;
    logger.logWarning(
      `orderhub-api-client: server error submitting ${orderNumber} → ${statusCode} ${msg}`
    );
    return {
      classification:  CLASSIFICATIONS.SERVER_ERROR,
      statusCode,
      body:            parsedBody ?? rawBody,
      errorMessage:    msg,
      orderhubOrderId: null,
    };
  }

  /**
   * Native https POST. Matches the project's existing http style (see
   * presign-service.js, s3-service.js).
   */
  _httpPost(url, apiKey, body) {
    return new Promise((resolve, reject) => {
      let urlObj;
      try { urlObj = new URL(url); }
      catch (err) { reject(new Error(`Invalid URL "${url}": ${err.message}`)); return; }

      const protocol = urlObj.protocol === 'https:' ? https : http;
      const bodyStr  = JSON.stringify(body);

      const options = {
        hostname: urlObj.hostname,
        port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path:     urlObj.pathname + (urlObj.search || ''),
        method:   'POST',
        headers: {
          'X-API-Key':       apiKey,
          'Content-Type':    'application/json',
          'Accept':          'application/json',
          'Content-Length':  Buffer.byteLength(bodyStr),
        },
        timeout: this.timeoutMs,
      };

      const req = protocol.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end',  () => resolve({ statusCode: res.statusCode, body: data }));
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });

      req.write(bodyStr);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function formatErrorMessage(body) {
  if (!body || typeof body !== 'object') return null;
  const parts = [];
  if (typeof body.error   === 'string' && body.error)   parts.push(body.error);
  if (typeof body.message === 'string' && body.message) parts.push(body.message);
  if (Array.isArray(body.validation_errors) && body.validation_errors.length > 0) {
    const fields = body.validation_errors
      .filter((v) => v && typeof v === 'object')
      .map((v) => {
        const field = v.field   ? String(v.field)   : '?';
        const msg   = v.message ? String(v.message) : '';
        return msg ? `${field}: ${msg}` : field;
      })
      .join('; ');
    if (fields) parts.push(`fields: ${fields}`);
  }
  return parts.length > 0 ? parts.join(' — ') : null;
}

module.exports = {
  OrderHubApiClient,
  CLASSIFICATIONS,
  ORDER_STATUS,
  DEFAULT_BASE_URL,
  SUBMIT_ORDER_PATH,
  UPDATE_ORDER_STATUS_PATH,
  default: new OrderHubApiClient(),
};
