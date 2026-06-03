/**
 * End-to-end tests for src/main/services/order-xml-watch-service.js.
 *
 * Run via:
 *   npm test
 *
 * Strategy: real chokidar against real temp directories + a localhost mock
 * OrderHub server. We drop XML into the watch folder and assert that:
 *   - the file ends up in processed/<MMDDYYYY>/ on success or duplicate
 *   - the file ends up in failed/<MMDDYYYY>/ with a sidecar on failure
 *   - the onResult callback is called with the right ingestion record
 *
 * Each test uses fresh temp dirs and tears its watcher down to avoid
 * cross-test interference. Polling-based chokidar means we need to wait a
 * couple of seconds for `add` to fire — pollWith() is the helper that does so.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');

// orderhub-api-client → logger → require('electron'). Stub before require.
const __origRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return __origRequire.apply(this, arguments);
};

const { OrderXmlWatchService, RESULT_STATUS } = require('../order-xml-watch-service');
const { OrderHubApiClient }                   = require('../orderhub-api-client');
const parserRegistry                          = require('../order-xml-parsers');

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const FIX_DIR = path.join(__dirname, 'fixtures', 'order-xml', 'photo-finale');
const FIX     = (name) => fs.readFileSync(path.join(FIX_DIR, name), 'utf8');

function makeTempLayout() {
  const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'oxw-'));
  const watchDir  = path.join(root, 'in');
  const procDir   = path.join(root, 'out');
  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(procDir,  { recursive: true });
  return { root, watchDir, procDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Default productMap covering every idSourceProduct that appears across all
// four PhotoFinale fixtures. Chunk 7a added an UNMAPPED_PRODUCTS gate to the
// parser; the watcher (chunk 7c) loads this from config in production, but
// here we stitch it into the hot folder object directly.
function defaultProductMap() {
  return new Map([
    ['1082252', { pixfizzCode: 'PX-5X7',    label: '5x7 Print' }],
    ['1082253', { pixfizzCode: 'PX-8X10',   label: '8x10 Print' }],
    ['1082254', { pixfizzCode: 'PX-11X14',  label: '11x14 Print' }],
    ['1082258', { pixfizzCode: 'PX-4X4',    label: '4x4 Print' }],
    ['1082294', { pixfizzCode: 'PX-8X8',    label: '8x8 Print' }],
    ['1082300', { pixfizzCode: 'PX-8X12',   label: '8x12 Print' }],
    ['1082312', { pixfizzCode: 'PX-8.5X11', label: '8.5x11 Print' }],
  ]);
}

function makeHotFolder({ watchDir, procDir, label = 'PF Test', enabled = true, websiteCode = 'TEST', productMap = defaultProductMap() }) {
  return {
    id:              'hf-' + Math.random().toString(36).slice(2),
    label,
    enabled,
    sourceFormat:    'photofinale',
    watchFolder:     watchDir,
    processedFolder: procDir,
    websiteCode,
    maxRetries:      null,
    productMap,
  };
}

/** Minimal config-service stub: serves the hot folders we feed it. */
function fakeConfigService(hotFolders, { apiKey = 'oh_test_key', maxRetries = 3 } = {}) {
  return {
    getEnabledHotFolders: () => hotFolders.filter((hf) => hf.enabled),
    getHotFolderMaxRetries: (hf) => hf && hf.maxRetries != null ? hf.maxRetries : maxRetries,
    get: (k) => (k === 'orderhubApiKey' ? apiKey : undefined),
  };
}

function startMockOrderHub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = tryJson(raw);
        // The watcher now passes `confirmAfterSubmit: true`, which causes the
        // API client to fire /update-order-status after every successful
        // /api-webhook submit. Tests' handlers were written before that and
        // assume `body.jobs.length` etc., which breaks on the confirm body
        // ({ order_id, status }). Auto-handle the confirm here so individual
        // tests don't all need updating; tests that care about the confirm
        // pass their own /update-order-status handler in by checking req.url.
        if (req.url === '/update-order-status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            order_id: (body && body.order_id) || 'unknown',
            old_status: 'pending',
            new_status: (body && body.status) || 'confirmed',
          }));
          return;
        }
        handler(req, res, body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `predicate` (sync) at 100ms intervals up to `timeoutMs`. Resolves true
 * if it ever returns truthy; false on timeout. Used because chokidar's
 * polling-watcher fires events 1-2s after the file appears.
 */
async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Atomic-write helper: write to <name>.tmp then rename. Mirrors how a sane
 * upstream (PhotoFinale) is expected to drop XML into the hot folder.
 */
function dropXmlAtomic(dir, name, content) {
  const tmp = path.join(dir, `${name}.tmp`);
  const final = path.join(dir, name);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, final);
  return final;
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

test('drops a PhotoFinale XML in → submits to OrderHub → moves to processed/<date>/', async () => {
  const layout = makeTempLayout();
  const hf     = makeHotFolder(layout);

  let receivedBody = null;
  const mock = await startMockOrderHub((req, res, body) => {
    receivedBody = body;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order_id: 'oh-uuid-001', jobs_created: body.jobs.length }));
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  fakeConfigService([hf]),
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl }),
    onResult:       (r) => records.push(r),
  });

  try {
    svc.start();
    // Drop the smallest fixture (single product, no edge cases).
    dropXmlAtomic(layout.watchDir, '43207384.xml', FIX('43207384.xml'));

    // Wait until the watcher emits a record.
    const ok = await waitFor(() => records.length === 1);
    assert.equal(ok, true, 'expected one ingestion record within timeout');

    // Watcher submitted the right body.
    assert.equal(receivedBody.order.order_number,    'XML-43207384');
    assert.equal(receivedBody.order.organization_id, 'oh_test_key');
    assert.equal(receivedBody.jobs.length,           4);

    // Original file no longer exists in watch dir.
    assert.equal(fs.existsSync(path.join(layout.watchDir, '43207384.xml')), false);

    // It moved to processed/<MMDDYYYY>/ — find the dated subfolder dynamically.
    const dateSubs = fs.readdirSync(layout.procDir).filter((n) => /^\d{8}$/.test(n));
    assert.equal(dateSubs.length, 1, 'expected exactly one dated subfolder');
    const moved = path.join(layout.procDir, dateSubs[0], '43207384.xml');
    assert.equal(fs.existsSync(moved), true, `expected file at ${moved}`);

    // Record shape.
    const rec = records[0];
    assert.equal(rec.status,          RESULT_STATUS.SUBMITTED);
    assert.equal(rec.externalId,      '43207384');
    assert.equal(rec.orderhubOrderId, 'oh-uuid-001');
    assert.equal(rec.errorMessage,    null);
    assert.equal(rec.attempts,        1);
    assert.equal(rec.hotFolderId,     hf.id);
  } finally {
    await svc.stop();
    await mock.close();
    layout.cleanup();
  }
});

test('classifies a 409 as duplicate and still moves to processed/', async () => {
  const layout = makeTempLayout();
  const hf     = makeHotFolder(layout);

  const mock = await startMockOrderHub((req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false, error: 'Duplicate order',
      existing_order_id: 'oh-existing-uuid',
    }));
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  fakeConfigService([hf]),
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl }),
    onResult:       (r) => records.push(r),
  });

  try {
    svc.start();
    dropXmlAtomic(layout.watchDir, '43207384.xml', FIX('43207384.xml'));
    await waitFor(() => records.length === 1);

    assert.equal(records[0].status,          RESULT_STATUS.DUPLICATE);
    assert.equal(records[0].orderhubOrderId, 'oh-existing-uuid');
    // Still moves to processed/ — duplicates are a success path.
    const dateSubs = fs.readdirSync(layout.procDir).filter((n) => /^\d{8}$/.test(n));
    assert.equal(dateSubs.length, 1);
    assert.equal(fs.existsSync(path.join(layout.procDir, dateSubs[0], '43207384.xml')), true);
    // And NOT in failed/.
    assert.equal(fs.existsSync(path.join(layout.procDir, 'failed')), false);
  } finally {
    await svc.stop(); await mock.close(); layout.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Failure routing
// ---------------------------------------------------------------------------

test('forwarded PhotoFinale order (mixed line Status) → submits only Status=1 lines', async () => {
  // 43229467 is a forwarded order: 12 lines are Status=1 (this lab prints,
  // submit to OrderHub) + 23 are Status=0 (originating lab prints, skip).
  // Previously OHD rejected this on the (product deleted:...) token; the
  // 2026-05-11 reinterpretation submits the 12 billable lines.
  const layout = makeTempLayout();
  const hf     = makeHotFolder(layout);

  let submittedBody = null;
  const mock = await startMockOrderHub((req, res, body) => {
    submittedBody = body;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order_id: 'oh-forwarded' }));
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  fakeConfigService([hf]),
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl }),
    onResult:       (r) => records.push(r),
  });

  try {
    svc.start();
    dropXmlAtomic(layout.watchDir, '43229467.xml', FIX('43229467.xml'));
    await waitFor(() => records.length === 1);

    assert.equal(records[0].status, RESULT_STATUS.SUBMITTED);
    // 11 OrderLineItem entries carry Status=1; the remaining 22 are Status=0.
    // (Note: one extra <Status>1</Status> sits inside <OrderPayment> in the
    // fixture but isn't a line item, so it's correctly excluded.)
    assert.equal(submittedBody.jobs.length, 11);
    for (const job of submittedBody.jobs) {
      assert.equal(job.product_code, 'PX-5X7');
    }
  } finally {
    await svc.stop(); await mock.close(); layout.cleanup();
  }
});

test('PhotoFinale order where every line is Status=0 → failed/<date>/ NO_BILLABLE_LINES', async () => {
  const layout = makeTempLayout();
  const hf     = makeHotFolder(layout);

  let serverHit = false;
  const mock = await startMockOrderHub((req, res) => {
    serverHit = true;
    res.writeHead(200); res.end('{}');
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  fakeConfigService([hf]),
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl }),
    onResult:       (r) => records.push(r),
  });

  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem>
      <idOrderLineItem>1</idOrderLineItem>
      <idSourceProduct>1082252</idSourceProduct>
      <Quantity>1</Quantity>
      <Status>0</Status>
    </OrderLineItem>
    <Order>
      <ExternalId>99999</ExternalId>
      <idOrder>999</idOrder>
      <CustomerFirstName>Jane</CustomerFirstName>
      <CustomerLastName>Doe</CustomerLastName>
      <CustomerEmail>jane@example.com</CustomerEmail>
    </Order>
  </OrderDataSet>`;

  try {
    svc.start();
    dropXmlAtomic(layout.watchDir, 'all-status-zero.xml', xml);
    await waitFor(() => records.length === 1);

    assert.equal(records[0].status,    RESULT_STATUS.FAILED);
    assert.equal(records[0].errorCode, 'NO_BILLABLE_LINES');
    assert.equal(serverHit,            false, 'should not call API for validation failures');

    const failedRoot = path.join(layout.procDir, 'failed');
    const dateSubs = fs.readdirSync(failedRoot).filter((n) => /^\d{8}$/.test(n));
    assert.equal(dateSubs.length, 1);
    const sidecar = path.join(failedRoot, dateSubs[0], 'all-status-zero.xml.error.json');
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(parsed.errorCode, 'NO_BILLABLE_LINES');
  } finally {
    await svc.stop(); await mock.close(); layout.cleanup();
  }
});

test('API 400 validation_error → failed/<date>/', async () => {
  const layout = makeTempLayout();
  const hf     = makeHotFolder(layout);

  const mock = await startMockOrderHub((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false, error: 'Validation failed',
      validation_errors: [{ field: 'customer_email', message: 'Invalid email' }],
    }));
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  fakeConfigService([hf]),
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl }),
    onResult:       (r) => records.push(r),
  });

  try {
    svc.start();
    dropXmlAtomic(layout.watchDir, '43207384.xml', FIX('43207384.xml'));
    await waitFor(() => records.length === 1);

    assert.equal(records[0].status,    RESULT_STATUS.FAILED);
    assert.equal(records[0].errorCode, 'VALIDATION_ERROR');
    assert.match(records[0].errorMessage, /customer_email: Invalid email/);

    const failedRoot = path.join(layout.procDir, 'failed');
    assert.equal(fs.existsSync(failedRoot), true);
  } finally {
    await svc.stop(); await mock.close(); layout.cleanup();
  }
});

test('API 5xx with maxRetries exceeded → failed/ with attempt count', async () => {
  const layout = makeTempLayout();
  const hf     = makeHotFolder(layout);
  hf.maxRetries = 2; // override for speed

  const mock = await startMockOrderHub((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"Internal server error"}');
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  fakeConfigService([hf]),
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl, timeoutMs: 1000 }),
    onResult:       (r) => records.push(r),
  });

  try {
    svc.start();
    dropXmlAtomic(layout.watchDir, '43207384.xml', FIX('43207384.xml'));

    // First attempt fires from the chokidar add event. After that, processAll()
    // runs subsequent retries — drive it manually to skip the polling tick.
    await waitFor(() => records.length === 0 ? false : false, 3000); // wait ~3s for first attempt
    await svc.processAll(); // 2nd attempt → at maxRetries, moves to failed/

    const ok = await waitFor(() => records.length === 1);
    assert.equal(ok, true, 'expected exactly one record after exhausting retries');
    assert.equal(records[0].status,    RESULT_STATUS.FAILED);
    assert.equal(records[0].errorCode, 'SERVER_ERROR');
    assert.equal(records[0].attempts,  2);
  } finally {
    await svc.stop(); await mock.close(); layout.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Multi-folder concurrency
// ---------------------------------------------------------------------------

test('two hot folders watch independently and route via the same parser', async () => {
  // Two layouts with two distinct watch folders. Both are PhotoFinale, but one
  // uses websiteCode "AAA" and the other "BBB" — proves per-folder config
  // flows through to the API call.
  const a = makeTempLayout();
  const b = makeTempLayout();
  const hfA = makeHotFolder({ ...a, label: 'A', websiteCode: 'AAA' });
  const hfB = makeHotFolder({ ...b, label: 'B', websiteCode: 'BBB' });

  const seenWebsiteCodes = [];
  const mock = await startMockOrderHub((req, res, body) => {
    seenWebsiteCodes.push(body.order.website_code);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order_id: `oh-${seenWebsiteCodes.length}` }));
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  fakeConfigService([hfA, hfB]),
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl }),
    onResult:       (r) => records.push(r),
  });

  try {
    svc.start();
    // Different filenames per folder so we can verify routing.
    dropXmlAtomic(a.watchDir, '43207384.xml', FIX('43207384.xml'));
    dropXmlAtomic(b.watchDir, '43210574.xml', FIX('43210574.xml'));

    const ok = await waitFor(() => records.length === 2, 12000);
    assert.equal(ok, true);

    // Sort records for stable assertions.
    records.sort((x, y) => x.hotFolderLabel.localeCompare(y.hotFolderLabel));
    assert.equal(records[0].hotFolderLabel, 'A');
    assert.equal(records[0].externalId,     '43207384');
    assert.equal(records[1].hotFolderLabel, 'B');
    assert.equal(records[1].externalId,     '43210574');

    // Server saw both website codes (order isn't guaranteed).
    assert.deepEqual(seenWebsiteCodes.sort(), ['AAA', 'BBB']);
  } finally {
    await svc.stop(); await mock.close(); a.cleanup(); b.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 
// ---------------------------------------------------------------------------
// Product mapping (chunk 7c)
// ---------------------------------------------------------------------------

test('XML with unmapped products → failed/<date>/ with errorCode UNMAPPED_PRODUCTS', async () => {
  const layout = makeTempLayout();
  // Hot folder with a productMap that's MISSING 1082252 (the only product
  // in 43207384.xml).
  const hf = makeHotFolder({ ...layout, productMap: new Map() });

  let serverHit = false;
  const mock = await startMockOrderHub((req, res) => {
    serverHit = true;
    res.writeHead(200); res.end('{}');
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  fakeConfigService([hf]),
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl }),
    onResult:       (r) => records.push(r),
  });

  try {
    svc.start();
    dropXmlAtomic(layout.watchDir, '43207384.xml', FIX('43207384.xml'));
    await waitFor(() => records.length === 1);

    assert.equal(records[0].status,    RESULT_STATUS.FAILED);
    assert.equal(records[0].errorCode, 'UNMAPPED_PRODUCTS');
    assert.match(records[0].errorMessage, /1082252/);
    assert.equal(serverHit, false, 'should not call OrderHub for unmapped products');

    const failedRoot = path.join(layout.procDir, 'failed');
    assert.equal(fs.existsSync(failedRoot), true);
    const dateSubs = fs.readdirSync(failedRoot).filter((n) => /^\d{8}$/.test(n));
    const sidecar = path.join(failedRoot, dateSubs[0], '43207384.xml.error.json');
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(parsed.errorCode, 'UNMAPPED_PRODUCTS');
  } finally {
    await svc.stop(); await mock.close(); layout.cleanup();
  }
});

test('watcher uses configService.getProductMappingsFor when present', async () => {
  // Confirms the chunk 7c hookup: when the config service exposes
  // getProductMappingsFor, the watcher pulls the relevant slice and the
  // hot folder doesn't need to carry productMap directly.
  const layout = makeTempLayout();
  const hf = makeHotFolder(layout);
  delete hf.productMap; // force the watcher to load from config

  const cfg = {
    ...fakeConfigService([hf]),
    getProductMappingsFor: (fmt) => fmt === 'photofinale' ? defaultProductMap() : new Map(),
  };

  const mock = await startMockOrderHub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order_id: 'oh-uuid-cfg' }));
  });

  const records = [];
  const svc = new OrderXmlWatchService({
    configService:  cfg,
    parserRegistry,
    apiClient:      new OrderHubApiClient({ baseUrl: mock.baseUrl }),
    onResult:       (r) => records.push(r),
  });

  try {
    svc.start();
    dropXmlAtomic(layout.watchDir, '43207384.xml', FIX('43207384.xml'));
    await waitFor(() => records.length === 1);
    assert.equal(records[0].status,          RESULT_STATUS.SUBMITTED);
    assert.equal(records[0].orderhubOrderId, 'oh-uuid-cfg');
  } finally {
    await svc.stop(); await mock.close(); layout.cleanup();
  }
});
