/**
 * Unit tests for src/main/services/orderhub-api-client.js.
 *
 * Run via:
 *   npm test
 *
 * Strategy: spin up a localhost http.createServer() stub for each test so we
 * exercise the real protocol path (headers, body framing, JSON parsing) but
 * have full control over the response. No third-party HTTP mock libs.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os   = require('node:os');
const Module = require('node:module');

// orderhub-api-client.js → logger.js → require('electron') at module load.
// Under `node --test` there's no Electron runtime, so we stub the `app`
// surface logger.js needs (just `getPath('userData')`) before requiring the
// client. Mirrors the pattern used in config-service-bom.test.js.
const __origRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return __origRequire.apply(this, arguments);
};

const { OrderHubApiClient, CLASSIFICATIONS } = require('../orderhub-api-client');

const FAKE_API_KEY = 'oh_test_key_redact_me';

const SAMPLE_REQUEST = {
  order: {
    order_number:   '43192748',
    customer_name:  'Jackie Art',
    customer_email: 'jackieart4@aol.com',
    paid:           true,
  },
  jobs: [
    { job_id: '16547', product_name: 'PhotoFinale Product 1082258', product_code: '1082258', quantity: 1, artwork_on_file: true },
  ],
};

/**
 * Spin up a mock OrderHub server. `handler(req, body)` controls the response.
 * Returns `{ baseUrl, captured, close }` where:
 *   - baseUrl is the URL to feed the client constructor
 *   - captured holds the most recent { method, url, headers, body } seen
 *   - close() shuts it down
 */
async function startMockServer(handler) {
  const captured = { method: null, url: null, headers: null, body: null };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      captured.method  = req.method;
      captured.url     = req.url;
      captured.headers = req.headers;
      try {
        captured.body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        captured.body = raw;
      }
      handler(req, res, captured.body);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Header / body wiring
// ---------------------------------------------------------------------------

test('sends X-API-Key header and content-type on POST /api-webhook', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order_id: 'srv-uuid-1' }));
  });
  try {
    const client = new OrderHubApiClient({ baseUrl: mock.baseUrl });
    const result = await client.submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });

    assert.equal(mock.captured.method, 'POST');
    assert.equal(mock.captured.url,    '/api-webhook');
    assert.equal(mock.captured.headers['x-api-key'],   FAKE_API_KEY);
    assert.equal(mock.captured.headers['content-type'], 'application/json');

    assert.equal(result.classification, CLASSIFICATIONS.SUCCESS);
    assert.equal(result.statusCode,     200);
    assert.equal(result.orderhubOrderId,'srv-uuid-1');
  } finally {
    await mock.close();
  }
});

test('injects organization_id (= apiKey) into the body without mutating the input', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success":true}');
  });
  try {
    const client = new OrderHubApiClient({ baseUrl: mock.baseUrl });
    // Snapshot the input shape so we can detect mutation.
    const before = JSON.parse(JSON.stringify(SAMPLE_REQUEST));
    await client.submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });

    // Server saw the API key as organization_id.
    assert.equal(mock.captured.body.order.organization_id, FAKE_API_KEY);
    // Caller's request was not mutated.
    assert.equal('organization_id' in SAMPLE_REQUEST.order, false);
    assert.deepEqual(SAMPLE_REQUEST, before);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Classifications
// ---------------------------------------------------------------------------

test('classifies 200 as success and extracts order_id', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order_id: 'oh-xyz', jobs_created: 1 }));
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification,  CLASSIFICATIONS.SUCCESS);
    assert.equal(result.orderhubOrderId, 'oh-xyz');
    assert.equal(result.errorMessage,    null);
  } finally { await mock.close(); }
});

test('classifies 409 as duplicate and extracts existing_order_id', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false, error: 'Duplicate order',
      message: 'An order with number 43192748 already exists',
      existing_order_id: 'existing-uuid',
    }));
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification,  CLASSIFICATIONS.DUPLICATE);
    assert.equal(result.statusCode,      409);
    assert.equal(result.orderhubOrderId, 'existing-uuid');
    // Duplicates aren't an error; errorMessage stays null so the panel doesn't
    // show a red row.
    assert.equal(result.errorMessage,    null);
  } finally { await mock.close(); }
});

test('classifies 400 as validation_error and surfaces field-level details', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error:   'Validation failed',
      validation_errors: [
        { field: 'customer_email', message: 'Invalid email format', received: 'not-an-email' },
      ],
    }));
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification, CLASSIFICATIONS.VALIDATION_ERROR);
    assert.match(result.errorMessage,   /Validation failed/);
    assert.match(result.errorMessage,   /customer_email: Invalid email format/);
  } finally { await mock.close(); }
});

test('classifies 401 as auth_error with operator-friendly message', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"success":false,"error":"Unauthorized"}');
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification, CLASSIFICATIONS.AUTH_ERROR);
    assert.match(result.errorMessage,   /Unauthorized|API key/);
  } finally { await mock.close(); }
});

test('classifies 403 as auth_error', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(403);
    res.end('Forbidden');
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification, CLASSIFICATIONS.AUTH_ERROR);
    assert.equal(result.statusCode,     403);
  } finally { await mock.close(); }
});

test('classifies 500 as server_error (eligible for retry)', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"Internal server error"}');
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification, CLASSIFICATIONS.SERVER_ERROR);
    assert.equal(result.statusCode,     500);
    assert.match(result.errorMessage,   /Internal server error/);
  } finally { await mock.close(); }
});

test('classifies 502 as server_error', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(502);
    res.end('Bad gateway');
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification, CLASSIFICATIONS.SERVER_ERROR);
    assert.equal(result.statusCode,     502);
  } finally { await mock.close(); }
});

test('classifies a connection refusal as network_error', async () => {
  // Pick a port nothing is listening on. If 1 is somehow occupied on the
  // sandbox, this test would still surface as ECONNREFUSED-or-similar — both
  // map to network_error.
  const client = new OrderHubApiClient({
    baseUrl:   'http://127.0.0.1:1',
    timeoutMs: 2000,
  });
  const result = await client.submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
  assert.equal(result.classification, CLASSIFICATIONS.NETWORK_ERROR);
  assert.equal(result.statusCode,     null);
  assert.ok(result.errorMessage && result.errorMessage.length > 0);
});

test('classifies a hung server as network_error after timeout', async () => {
  // Server accepts the connection but never responds.
  const mock = await startMockServer(() => { /* no res.end() */ });
  try {
    const client = new OrderHubApiClient({
      baseUrl:   mock.baseUrl,
      timeoutMs: 250, // tiny so the test is fast
    });
    const result = await client.submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification, CLASSIFICATIONS.NETWORK_ERROR);
    assert.match(result.errorMessage,   /timed out|timeout/i);
  } finally { await mock.close(); }
});

test('handles non-JSON success bodies gracefully', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(result.classification,  CLASSIFICATIONS.SUCCESS);
    assert.equal(result.orderhubOrderId, null); // no JSON, no order_id
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// Programmer-error guards
// ---------------------------------------------------------------------------

test('throws synchronously when apiKey is missing', async () => {
  const client = new OrderHubApiClient({ baseUrl: 'http://localhost:1' });
  await assert.rejects(
    () => client.submitOrder({ apiKey: '', request: SAMPLE_REQUEST }),
    /apiKey is required/
  );
});

test('throws synchronously when request is malformed', async () => {
  const client = new OrderHubApiClient({ baseUrl: 'http://localhost:1' });
  await assert.rejects(
    () => client.submitOrder({ apiKey: FAKE_API_KEY, request: null }),
    /request must be/
  );
  await assert.rejects(
    () => client.submitOrder({ apiKey: FAKE_API_KEY, request: { order: {} } }),
    /request must be/
  );
});

// ---------------------------------------------------------------------------
// Auto-confirm (chunk 7+ — pending → confirmed after create)
// ---------------------------------------------------------------------------

test('submitOrder({ confirmAfterSubmit: true }) chains a confirm call after 200', async () => {
  const calls = [];
  const mock = await startMockServer((req, res, body) => {
    calls.push({ url: req.url, body });
    if (req.url === '/api-webhook') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, order_id: 'oh-123' }));
    } else if (req.url === '/update-order-status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, order_id: body.order_id, old_status: 'pending', new_status: body.status }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  try {
    const client = new OrderHubApiClient({ baseUrl: mock.baseUrl });
    const result = await client.submitOrder({
      apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST, confirmAfterSubmit: true,
    });
    assert.equal(result.classification,  CLASSIFICATIONS.SUCCESS);
    assert.equal(result.orderhubOrderId, 'oh-123');
    // Both calls fired, in order.
    assert.equal(calls.length,                     2);
    assert.equal(calls[0].url,                     '/api-webhook');
    assert.equal(calls[1].url,                     '/update-order-status');
    assert.equal(calls[1].body.order_id,           'oh-123');
    assert.equal(calls[1].body.status,             'confirmed');
    assert.ok(result.confirmedAt);
    assert.equal(result.confirmError,              null);
  } finally { await mock.close(); }
});

test('submitOrder confirm failure is logged but classification stays SUCCESS', async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url === '/api-webhook') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, order_id: 'oh-456' }));
    } else if (req.url === '/update-order-status') {
      // Simulate the confirm failing — order is created but stuck pending.
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"Status update failed"}');
    } else { res.writeHead(404); res.end(); }
  });
  try {
    const result = await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST, confirmAfterSubmit: true });
    assert.equal(result.classification,  CLASSIFICATIONS.SUCCESS);
    assert.equal(result.orderhubOrderId, 'oh-456');
    assert.equal(result.confirmedAt,     null);
    assert.match(result.confirmError,    /Status update failed|HTTP 500/i);
  } finally { await mock.close(); }
});

test('submitOrder without confirmAfterSubmit does NOT call /update-order-status', async () => {
  let updateHit = false;
  const mock = await startMockServer((req, res) => {
    if (req.url === '/update-order-status') updateHit = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order_id: 'oh-789' }));
  });
  try {
    await new OrderHubApiClient({ baseUrl: mock.baseUrl })
      .submitOrder({ apiKey: FAKE_API_KEY, request: SAMPLE_REQUEST });
    assert.equal(updateHit, false);
  } finally { await mock.close(); }
});

test('setOrderStatus rejects invalid status values', async () => {
  const client = new OrderHubApiClient({ baseUrl: 'http://localhost:1' });
  await assert.rejects(
    () => client.setOrderStatus({ apiKey: FAKE_API_KEY, orderId: 'x', status: 'bogus' }),
    /invalid status "bogus"/
  );
});
