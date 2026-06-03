/**
 * Unit tests for src/main/services/order-xml-parsers/photo-finale.js.
 *
 * Run via:
 *   npm test
 *
 * The four canonical fixtures live in
 *   src/main/services/__tests__/fixtures/order-xml/photo-finale/
 * and were taken verbatim from the customer's PhotoFinale hot-folder drop on
 * 2026-04-25 → 2026-04-30. They cover:
 *   - 43192748: 6 line items, 4 unique products, UPS shipping, multi-product order
 *   - 43207384: 4 line items, 1 unique product, Mail shipping, simplest case
 *   - 43210574: 3 line items, 2 unique products, Mail shipping, includes OrderTax
 *   - 43229467: 33 line items, forwarded order — 11 Status=1 (this lab prints) +
 *     22 Status=0 (originating lab prints); parser submits only the 11
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parser = require('../order-xml-parsers/photo-finale');

const FIX_DIR = path.join(__dirname, 'fixtures', 'order-xml', 'photo-finale');
const fixture = (name) => fs.readFileSync(path.join(FIX_DIR, name), 'utf8');

// Each fixture references a known set of PhotoFinale product codes. We seed
// the productMap with mappings for every code that appears across all four
// fixtures so existing happy-path tests pass without per-test plumbing.
// New tests that need to exercise unmapped behaviour pass a sparser map.
function fullProductMap() {
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

const HOT_FOLDER = {
  id: 'hf-1', label: 'Test', websiteCode: 'TEST123',
  productMap: fullProductMap(),
};

// ---------------------------------------------------------------------------
// Identity / sniff
// ---------------------------------------------------------------------------

test('exports the expected parser id and label', () => {
  assert.equal(parser.id, 'photofinale');
  assert.equal(parser.label, 'PhotoFinale (Trevoli OrderDataSet)');
});

test('matches() recognises the PhotoFinale namespace', () => {
  const sample = fixture('43192748.xml').slice(0, 512);
  assert.equal(parser.matches(sample), true);
});

test('matches() rejects unrelated XML', () => {
  assert.equal(parser.matches('<?xml version="1.0"?><FooDocument/>'), false);
  assert.equal(parser.matches('<OrderDataSet xmlns="http://example.com/Other"/>'), false);
});

test('matches() handles non-string inputs gracefully', () => {
  assert.equal(parser.matches(null), false);
  assert.equal(parser.matches(undefined), false);
  assert.equal(parser.matches(42), false);
});

// ---------------------------------------------------------------------------
// Happy-path fixtures
// ---------------------------------------------------------------------------

test('43192748 (multi-product UPS): maps order-level fields correctly', () => {
  const { request, summary } = parser.parse(fixture('43192748.xml'), HOT_FOLDER);
  const { order } = request;

  // order_number is "XML-<ExternalId>" — idOrder is intentionally dropped.
  assert.equal(order.order_number,    'XML-43192748');
  assert.equal(order.external_order_id,'43192748');
  assert.equal(order.external_source, 'PhotoFinale');
  assert.equal(order.customer_name,   'Jackie Art');
  assert.equal(order.customer_email,  'jackieart4@aol.com');
  assert.equal(order.customer_phone,  '406-223-3122');
  // total_amount is the wholesale rollup: sum(WholesaleCost × Quantity).
  // 1.73×1 + 2.60×2 + 1.30×1 + 0.25×1 + 1.30×1 + 1.63×1 = 11.41.
  assert.equal(order.total_amount,    11.41);
  assert.equal(order.total_tax,       0);
  assert.equal(order.total_shipping,  25);
  assert.equal(order.total_discount,  0);
  assert.equal(order.shipping_method, 'Expedited UPS (3 Day)');
  assert.equal(order.shipping_street, '405 North 6th St.');
  assert.equal(order.shipping_city,   'Livingston');
  assert.equal(order.shipping_state,  'MT');
  assert.equal(order.shipping_zipcode,'59047');
  assert.equal(order.shipping_country,'US');
  assert.equal(order.website_code,    'TEST123');
  assert.equal(order.paid,            true);

  // Payment fields are intentionally omitted — these orders are settled
  // upstream by PhotoFinale; OrderHub only needs to know the order is paid.
  assert.equal('payment_gateway'   in order, false);
  assert.equal('payment_reference' in order, false);
  // organization_id is the API client's responsibility, not the parser's.
  assert.equal('organization_id' in order, false);

  assert.equal(summary.externalId,    '43192748');
  assert.equal(summary.lineItemCount, 6);
  assert.equal(summary.shipToCity,    'Livingston');
  assert.match(summary.productSummary, /4x4 Print/);
});

test('43192748: maps every OrderLineItem to a JobInput', () => {
  const { request } = parser.parse(fixture('43192748.xml'), HOT_FOLDER);

  assert.equal(request.jobs.length, 6);

  // First line item: idOrderLineItem=16547, idSourceProduct=1082258, qty=1.
  // The productMap maps 1082258 → PX-4X4 / "4x4 Print"; OHD sends the Pixfizz
  // values, not the raw PhotoFinale code.
  assert.deepEqual(request.jobs[0], {
    job_id:                '16547',
    external_line_item_id: '16547',
    product_code:          'PX-4X4',
    product_name:          '4x4 Print',
    quantity:              1,
    artwork_on_file:       true,
  });

  // Second line item: idOrderLineItem=16548, idSourceProduct=1082312, qty=2
  // → mapped to PX-8.5X11.
  assert.equal(request.jobs[1].job_id,       '16548');
  assert.equal(request.jobs[1].product_code, 'PX-8.5X11');
  assert.equal(request.jobs[1].quantity,     2);

  // No options, no artwork_url emitted (per design: artwork is out of scope)
  for (const job of request.jobs) {
    assert.equal('options'     in job, false);
    assert.equal('artwork_url' in job, false);
    assert.equal(job.artwork_on_file,    true);
  }
});

test('43207384 (single-product Mail): maps simplest order shape', () => {
  const { request, summary } = parser.parse(fixture('43207384.xml'), HOT_FOLDER);

  assert.equal(request.order.order_number,    'XML-43207384');
  assert.equal(request.order.customer_name,   'Lisa Hughes');
  assert.equal(request.order.shipping_method, 'Mail');
  assert.equal(request.order.shipping_zipcode,'98273-5637');
  assert.equal(request.jobs.length,           4);
  // All 4 line items use the same idSourceProduct (1082252) → mapped to PX-5X7.
  for (const job of request.jobs) {
    assert.equal(job.product_code, 'PX-5X7');
    assert.equal(job.product_name, '5x7 Print');
    assert.equal(job.quantity,     1);
  }
  assert.equal(summary.lineItemCount, 4);
});

test('43210574 (multi-product Mail): maps OrderTax presence cleanly', () => {
  const { request, summary } = parser.parse(fixture('43210574.xml'), HOT_FOLDER);

  assert.equal(request.order.order_number,  'XML-43210574');
  assert.equal(request.order.customer_name, 'Holly Brown');
  // Wholesale rollup: 1.30×1 + 1.30×1 + 2.43×1 = 5.03.
  assert.equal(request.order.total_amount,  5.03);
  assert.equal(request.order.total_tax,     0);
  assert.equal(request.jobs.length,         3);
  // Mix of products: 2x 1082253 → PX-8X10, 1x 1082254 → PX-11X14.
  const codes = request.jobs.map((j) => j.product_code).sort();
  assert.deepEqual(codes, ['PX-11X14', 'PX-8X10', 'PX-8X10']);
  assert.equal(summary.shipToState, 'MT');
});

// ---------------------------------------------------------------------------
// Product mapping (UNMAPPED_PRODUCTS) — added 2026-05-08 per chunk 7a
// ---------------------------------------------------------------------------

test('throws UNMAPPED_PRODUCTS when no productMap is provided', () => {
  // Defensive fallback: a hot folder with no mappings configured at all
  // should not silently emit raw PhotoFinale codes — it should fail loudly.
  const cfg = { id: 'hf', label: 'x', websiteCode: '' }; // no productMap
  assert.throws(
    () => parser.parse(fixture('43207384.xml'), cfg),
    (err) => {
      assert.equal(err.code, 'UNMAPPED_PRODUCTS');
      assert.deepEqual(err.details.unmappedCodes, ['1082252']);
      return true;
    }
  );
});

test('throws UNMAPPED_PRODUCTS when one product code is missing from the map', () => {
  // Map covers 1082253 but the order also uses 1082254 → unmapped.
  const cfg = { id: 'hf', label: 'x', productMap: new Map([
    ['1082253', { pixfizzCode: 'PX-8X10', label: '8x10' }],
  ])};
  assert.throws(
    () => parser.parse(fixture('43210574.xml'), cfg),
    (err) => {
      assert.equal(err.code, 'UNMAPPED_PRODUCTS');
      assert.deepEqual(err.details.unmappedCodes, ['1082254']);
      assert.match(err.message, /1082254/);
      return true;
    }
  );
});

test('UNMAPPED_PRODUCTS lists every distinct unmapped code, deduplicated', () => {
  // 43192748 has 4 distinct idSourceProduct values (1082258, 1082312×3, 1082294, 1082300).
  // We map only one of them — the error should list the other three exactly
  // once each, in source-order.
  const cfg = { id: 'hf', label: 'x', productMap: new Map([
    ['1082258', { pixfizzCode: 'PX-4X4', label: '4x4 Print' }],
  ])};
  assert.throws(
    () => parser.parse(fixture('43192748.xml'), cfg),
    (err) => {
      assert.equal(err.code, 'UNMAPPED_PRODUCTS');
      // Three distinct unmapped codes; deduped (1082312 appears 3 times in
      // the order but should only show once in the error).
      assert.equal(err.details.unmappedCodes.length, 3);
      assert.ok(err.details.unmappedCodes.includes('1082312'));
      assert.ok(err.details.unmappedCodes.includes('1082294'));
      assert.ok(err.details.unmappedCodes.includes('1082300'));
      return true;
    }
  );
});

test('mapping label flows through to product_name even when the parser would have generated a different name', () => {
  // Map 1082252 to a deliberately weird label to prove the label, not the
  // PhotoFinale-derived name, is what reaches OrderHub.
  const cfg = { id: 'hf', label: 'x', productMap: new Map([
    ['1082252', { pixfizzCode: 'PX-WEIRD', label: 'Customer-facing 5x7 special' }],
  ])};
  const { request } = parser.parse(fixture('43207384.xml'), cfg);
  for (const job of request.jobs) {
    assert.equal(job.product_code, 'PX-WEIRD');
    assert.equal(job.product_name, 'Customer-facing 5x7 special');
  }
});

test('order_number is "XML-<ExternalId>" across every fixture', () => {
  // Spot-check across all PhotoFinale fixtures to lock the format down.
  // idOrder is no longer threaded into order_number (simplified 2026-05-11).
  const cases = [
    ['43192748.xml', 'XML-43192748'],
    ['43207384.xml', 'XML-43207384'],
    ['43210574.xml', 'XML-43210574'],
  ];
  for (const [file, expected] of cases) {
    const { request } = parser.parse(fixture(file), HOT_FOLDER);
    assert.equal(request.order.order_number, expected);
  }
});

test('PhotoFinale line-item id is preserved as external_line_item_id for traceability', () => {
  const { request } = parser.parse(fixture('43192748.xml'), HOT_FOLDER);
  // Original idOrderLineItem values from the fixture
  const expected = ['16547', '16548', '16549', '16550', '16551', '16552'];
  const actual = request.jobs.map((j) => j.external_line_item_id);
  assert.deepEqual(actual, expected);
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

test('43229467 (partial forwarded order): submits only <Status>1</Status> lines, drops Status=0 ones', () => {
  // 43229467 is a forwarded order with 33 OrderLineItem entries: 22 are
  // Status=0 (originating lab prints) and 11 are Status=1 (this lab prints,
  // all idSourceProduct=1082252 with WholesaleCost=0.70). Status=0 lines
  // render as "(product deleted:1328483)" in <ProductSummary> — that token
  // is now treated as benign rather than a validation failure.
  const { request, summary } = parser.parse(fixture('43229467.xml'), HOT_FOLDER);
  assert.equal(request.jobs.length, 11);
  for (const job of request.jobs) {
    assert.equal(job.product_code, 'PX-5X7');
  }
  // Wholesale rollup uses the filtered set: 11 × 0.70 = 7.70.
  assert.equal(request.order.total_amount, 7.70);
  assert.equal(summary.lineItemCount, 11);
});

test('NO_BILLABLE_LINES when every line is <Status>0</Status>', () => {
  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem>
      <idOrderLineItem>1</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>1</Quantity>
      <Status>0</Status>
    </OrderLineItem>
    <OrderLineItem>
      <idOrderLineItem>2</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>1</Quantity>
      <Status>0</Status>
    </OrderLineItem>
    <Order>
      <ExternalId>9999</ExternalId>
      <CustomerFirstName>Jane</CustomerFirstName>
      <CustomerLastName>Doe</CustomerLastName>
      <CustomerEmail>jane@example.com</CustomerEmail>
    </Order>
  </OrderDataSet>`;
  try {
    parser.parse(xml, HOT_FOLDER_MINIMAL);
    assert.fail('parse() should have thrown');
  } catch (err) {
    assert.equal(err.code, 'NO_BILLABLE_LINES');
    assert.equal(err.details.totalLines, 2);
  }
});

test('lines with missing <Status> default to included (back-compat with older XML)', () => {
  // makeMinimalXml omits <Status>, so the single line item has no Status tag.
  // It should be treated as "include" — only the literal string "0" excludes.
  const xml = makeMinimalXml({});
  const { request } = parser.parse(xml, HOT_FOLDER_MINIMAL);
  assert.equal(request.jobs.length, 1);
});

test('Status filter only excludes the literal "0" — other values (2, 3, ...) are included', () => {
  // Defensive: PhotoFinale might use other Status values for future states.
  // The exclusion rule is strictly "0"; anything else flows through.
  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem>
      <idOrderLineItem>1</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>1</Quantity>
      <Status>2</Status>
    </OrderLineItem>
    <Order>
      <ExternalId>9999</ExternalId>
      <CustomerFirstName>Jane</CustomerFirstName>
      <CustomerLastName>Doe</CustomerLastName>
      <CustomerEmail>jane@example.com</CustomerEmail>
    </Order>
  </OrderDataSet>`;
  const { request } = parser.parse(xml, HOT_FOLDER_MINIMAL);
  assert.equal(request.jobs.length, 1);
});

test('rejects empty input', () => {
  assert.throws(
    () => parser.parse('', HOT_FOLDER),
    (err) => err.code === 'PARSE_ERROR'
  );
});

test('rejects truncated XML (no closing tag) so the watcher can requeue', () => {
  // Simulate a partial write: take the real fixture and chop off the closing tag.
  const truncated = fixture('43192748.xml').replace('</OrderDataSet>', '');
  assert.throws(
    () => parser.parse(truncated, HOT_FOLDER),
    (err) => {
      assert.equal(err.code, 'PARSE_ERROR');
      assert.match(err.message, /truncated|closing/i);
      return true;
    }
  );
});

test('rejects XML with no <Order> element', () => {
  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem><idOrderLineItem>1</idOrderLineItem><idSourceProduct>123</idSourceProduct><Quantity>1</Quantity></OrderLineItem>
  </OrderDataSet>`;
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER),
    (err) => err.code === 'MISSING_ORDER'
  );
});

test('rejects XML with no <OrderLineItem> elements', () => {
  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <Order>
      <ExternalId>9999</ExternalId>
      <CustomerFirstName>A</CustomerFirstName>
      <CustomerLastName>B</CustomerLastName>
      <CustomerEmail>a@b.com</CustomerEmail>
    </Order>
  </OrderDataSet>`;
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER),
    (err) => err.code === 'NO_LINE_ITEMS'
  );
});

test('rejects missing ExternalId', () => {
  const xml = makeMinimalXml({ omit: 'ExternalId' });
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER_MINIMAL),
    (err) => err.code === 'MISSING_EXTERNAL_ID'
  );
});

test('rejects missing customer name', () => {
  const xml = makeMinimalXml({ omit: 'CustomerName' });
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER_MINIMAL),
    (err) => err.code === 'MISSING_CUSTOMER_NAME'
  );
});

test('rejects missing customer email', () => {
  const xml = makeMinimalXml({ omit: 'CustomerEmail' });
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER_MINIMAL),
    (err) => err.code === 'MISSING_CUSTOMER_EMAIL'
  );
});

test('rejects line item with missing idSourceProduct', () => {
  const xml = makeMinimalXml({ liOverride: '<idOrderLineItem>1</idOrderLineItem><Quantity>1</Quantity>' });
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER_MINIMAL),
    (err) => err.code === 'INVALID_PRODUCT'
  );
});

test('rejects line item with quantity 0', () => {
  const xml = makeMinimalXml({ liOverride: '<idOrderLineItem>1</idOrderLineItem><idSourceProduct>123</idSourceProduct><Quantity>0</Quantity>' });
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER_MINIMAL),
    (err) => err.code === 'INVALID_QUANTITY'
  );
});

// ---------------------------------------------------------------------------
// Edge cases / config injection
// ---------------------------------------------------------------------------

test('omits website_code when hotFolderConfig has no websiteCode', () => {
  // Provide productMap (required for any real parse) but no websiteCode.
  const cfg = { id: 'hf', label: 'x', productMap: fullProductMap() };
  const { request } = parser.parse(fixture('43207384.xml'), cfg);
  assert.equal('website_code' in request.order, false);
});

test('omits empty optional Order fields rather than sending blank strings', () => {
  // 43192748 has empty <ShipToCompany /> — must NOT appear in the output.
  const { request } = parser.parse(fixture('43192748.xml'), HOT_FOLDER);
  assert.equal('shipping_company' in request.order, false);
  assert.equal('notes'            in request.order, false);
});

test('numeric ExternalId is preserved as a string, not coerced to number', () => {
  const { request, summary } = parser.parse(fixture('43192748.xml'), HOT_FOLDER);
  assert.equal(typeof request.order.order_number, 'string');
  assert.equal(typeof summary.externalId,         'string');
});

test('product_code is always a string even though XML parses as number', () => {
  const { request } = parser.parse(fixture('43192748.xml'), HOT_FOLDER);
  for (const job of request.jobs) {
    assert.equal(typeof job.product_code, 'string');
    assert.equal(typeof job.job_id,       'string');
  }
});

test('paid is hardcoded true regardless of OrderPayment state', () => {
  // Even in synthesised XML with no <OrderPayment> element, `paid` must be true.
  const xml = makeMinimalXml({});
  const { request } = parser.parse(xml, HOT_FOLDER_MINIMAL);
  assert.equal(request.order.paid, true);
});

test('quantity is rounded down to a positive integer', () => {
  // PhotoFinale always emits integer Quantity, but defend against decimals.
  const xml = makeMinimalXml({ liOverride: '<idOrderLineItem>1</idOrderLineItem><idSourceProduct>123</idSourceProduct><Quantity>2.7</Quantity>' });
  const { request } = parser.parse(xml, HOT_FOLDER_MINIMAL);
  assert.equal(request.jobs[0].quantity, 2);
});

// ---------------------------------------------------------------------------
// Helpers for synthesised fixtures
// ---------------------------------------------------------------------------

/**
 * Hot folder config used by tests that build a minimal synthesised XML with
 * idSourceProduct=123. We map 123 → PX-MIN so the productMap-enforcement
 * gate (added 2026-05-08) is satisfied for tests that don't care about the
 * mapping itself.
 */
const HOT_FOLDER_MINIMAL = {
  id: 'hf-min', label: 'Min', websiteCode: 'TEST',
  productMap: new Map([
    ['123', { pixfizzCode: 'PX-MIN', label: 'Minimal Test Product' }],
  ]),
};

/**
 * Build a minimal valid PhotoFinale XML, with one targeted mutation for
 * negative-test cases. Lets us exercise validation branches without committing
 * 18 separate fixture files.
 */

function makeMinimalXml({
  omit = null,
  liOverride = null,
  retailerCode = null,
  retailerStreet = null,
  shipToAddress = null,
} = {}) {
  const externalId = omit === 'ExternalId'    ? '' : '<ExternalId>9999</ExternalId>';
  const firstName  = omit === 'CustomerName'  ? '' : '<CustomerFirstName>Jane</CustomerFirstName>';
  const lastName   = omit === 'CustomerName'  ? '' : '<CustomerLastName>Doe</CustomerLastName>';
  const email      = omit === 'CustomerEmail' ? '' : '<CustomerEmail>jane@example.com</CustomerEmail>';
  const retailer   = retailerCode   === null  ? '' : `<RetailerDealerCode>${retailerCode}</RetailerDealerCode>`;
  const street     = retailerStreet === null  ? '' : `<RetailerStreet>${retailerStreet}</RetailerStreet>`;
  const shipTo     = shipToAddress  === null  ? '' : `<ShipToAddress>${shipToAddress}</ShipToAddress>`;
  const liInner    = liOverride
    || '<idOrderLineItem>1</idOrderLineItem><idSourceProduct>123</idSourceProduct><Quantity>1</Quantity>';
  return `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
  <OrderLineItem>${liInner}</OrderLineItem>
  <Order>
    ${externalId}
    ${firstName}
    ${lastName}
    ${email}
    ${retailer}
    ${street}
    ${shipTo}
  </Order>
</OrderDataSet>`;
}

// ---------------------------------------------------------------------------
// Customer directory lookup (RetailerDealerCode → name/email substitution)
// ---------------------------------------------------------------------------

test('with empty customerMap, falls back to XML CustomerName/Email (backward compatible)', () => {
  // No customerMap at all → legacy behaviour: the parser still requires the
  // XML's CustomerFirstName/CustomerEmail and uses them as the source of truth.
  const xml = makeMinimalXml({});
  const { request } = parser.parse(xml, HOT_FOLDER_MINIMAL);
  assert.equal(request.order.customer_name,  'Jane Doe');
  assert.equal(request.order.customer_email, 'jane@example.com');
});

test('with a configured customerMap, substitutes name + email by RetailerDealerCode', () => {
  const customerMap = new Map([
    ['9052', { customerId: '9052', customerName: 'F-11 Photo', customerEmail: 'orders@f-11.com' }],
  ]);
  const xml = makeMinimalXml({ retailerCode: '9052' });
  const { request } = parser.parse(xml, { ...HOT_FOLDER_MINIMAL, customerMap });
  // The cardholder details from the XML are replaced by the customer record.
  assert.equal(request.order.customer_name,  'F-11 Photo');
  assert.equal(request.order.customer_email, 'orders@f-11.com');
});

test('customerMap lookup is case-insensitive', () => {
  const customerMap = new Map([
    ['ab-9052', { customerId: 'AB-9052', customerName: 'F-11 Photo', customerEmail: 'orders@f-11.com' }],
  ]);
  const xml = makeMinimalXml({ retailerCode: 'AB-9052' });
  const { request } = parser.parse(xml, { ...HOT_FOLDER_MINIMAL, customerMap });
  assert.equal(request.order.customer_name, 'F-11 Photo');
});

test('throws CUSTOMER_NOT_FOUND when RetailerDealerCode has no matching record', () => {
  const customerMap = new Map([
    ['9052', { customerId: '9052', customerName: 'F-11', customerEmail: 'a@b.com' }],
  ]);
  const xml = makeMinimalXml({ retailerCode: '7777' });
  try {
    parser.parse(xml, { ...HOT_FOLDER_MINIMAL, customerMap });
    assert.fail('parse() should have thrown');
  } catch (err) {
    assert.equal(err.code, 'CUSTOMER_NOT_FOUND');
    assert.match(err.message, /7777/);
    assert.deepEqual(err.details, { retailerCode: '7777' });
  }
});

test('throws CUSTOMER_NOT_FOUND when RetailerDealerCode is absent and the directory is configured', () => {
  const customerMap = new Map([
    ['9052', { customerId: '9052', customerName: 'F-11', customerEmail: 'a@b.com' }],
  ]);
  const xml = makeMinimalXml({ retailerCode: null });
  try {
    parser.parse(xml, { ...HOT_FOLDER_MINIMAL, customerMap });
    assert.fail('parse() should have thrown');
  } catch (err) {
    assert.equal(err.code, 'CUSTOMER_NOT_FOUND');
    assert.deepEqual(err.details, { retailerCode: '' });
  }
});

// ---------------------------------------------------------------------------
// Pickup vs shipping (RetailerStreet == ShipToAddress detection)
// ---------------------------------------------------------------------------

test('shipping order (RetailerStreet ≠ ShipToAddress): populates shipping_* fields, no pickup_location_id', () => {
  const xml = makeMinimalXml({
    retailerStreet: '5 W Mendenhall',
    shipToAddress:  '405 North 6th St.',
  });
  const { request } = parser.parse(xml, { ...HOT_FOLDER_MINIMAL, pickupLocationId: 'loc-uuid' });
  assert.equal(request.order.shipping_street, '405 North 6th St.');
  assert.equal('pickup_location_id' in request.order, false);
});

test('pickup order (RetailerStreet == ShipToAddress): sets pickup_location_id, drops shipping address fields', () => {
  const xml = makeMinimalXml({
    retailerStreet: '5 W Mendenhall Suite 200',
    shipToAddress:  '5 W Mendenhall Suite 200',
  });
  const { request } = parser.parse(xml, { ...HOT_FOLDER_MINIMAL, pickupLocationId: 'loc-uuid' });
  assert.equal(request.order.pickup_location_id, 'loc-uuid');
  // Shipping address fields are omitted on pickup so OrderHub doesn't treat
  // the retailer's own address as a delivery destination.
  assert.equal('shipping_street'  in request.order, false);
  assert.equal('shipping_city'    in request.order, false);
  assert.equal('shipping_zipcode' in request.order, false);
});

test('pickup detection is case-insensitive and whitespace-tolerant', () => {
  const xml = makeMinimalXml({
    retailerStreet: '5 W Mendenhall Suite 200',
    shipToAddress:  '5 w MENDENHALL Suite 200',
  });
  const { request } = parser.parse(xml, { ...HOT_FOLDER_MINIMAL, pickupLocationId: 'loc-uuid' });
  assert.equal(request.order.pickup_location_id, 'loc-uuid');
});

test('pickup with both fields blank is NOT treated as a pickup', () => {
  // Empty-string equality is a degenerate match — both fields simply absent
  // shouldn't trigger pickup routing.
  const xml = makeMinimalXml({ retailerStreet: '', shipToAddress: '' });
  const { request } = parser.parse(xml, { ...HOT_FOLDER_MINIMAL, pickupLocationId: 'loc-uuid' });
  assert.equal('pickup_location_id' in request.order, false);
});

test('throws MISSING_PICKUP_LOCATION when a pickup is detected but no locationId is configured', () => {
  const xml = makeMinimalXml({
    retailerStreet: '5 W Mendenhall',
    shipToAddress:  '5 W Mendenhall',
  });
  try {
    // pickupLocationId deliberately omitted from the hot folder config.
    parser.parse(xml, HOT_FOLDER_MINIMAL);
    assert.fail('parse() should have thrown');
  } catch (err) {
    assert.equal(err.code, 'MISSING_PICKUP_LOCATION');
    assert.match(err.message, /Pickup order detected/);
    assert.equal(err.details.retailerStreet, '5 W Mendenhall');
  }
});

// ---------------------------------------------------------------------------
// Wholesale rollup (total_amount = sum(WholesaleCost × Quantity))
// ---------------------------------------------------------------------------

test('total_amount is the wholesale rollup, not the XML retail Total', () => {
  // Two line items with explicit WholesaleCost; the order-level <Total>
  // (retail) below should be ignored.
  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem>
      <idOrderLineItem>1</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>2</Quantity>
      <UnitPrice>5.99</UnitPrice>
      <WholesaleCost>1.30</WholesaleCost>
    </OrderLineItem>
    <OrderLineItem>
      <idOrderLineItem>2</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>1</Quantity>
      <UnitPrice>7.99</UnitPrice>
      <WholesaleCost>2.50</WholesaleCost>
    </OrderLineItem>
    <Order>
      <ExternalId>9999</ExternalId>
      <CustomerFirstName>Jane</CustomerFirstName>
      <CustomerLastName>Doe</CustomerLastName>
      <CustomerEmail>jane@example.com</CustomerEmail>
      <Total>99.99</Total>
    </Order>
  </OrderDataSet>`;
  const { request } = parser.parse(xml, HOT_FOLDER_MINIMAL);
  // 1.30 × 2 + 2.50 × 1 = 5.10 (not 99.99 from XML <Total>)
  assert.equal(request.order.total_amount, 5.10);
});

test('missing WholesaleCost on a line item contributes 0 to the rollup (does not throw)', () => {
  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem>
      <idOrderLineItem>1</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>1</Quantity>
      <WholesaleCost>1.30</WholesaleCost>
    </OrderLineItem>
    <OrderLineItem>
      <idOrderLineItem>2</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>1</Quantity>
    </OrderLineItem>
    <Order>
      <ExternalId>9999</ExternalId>
      <CustomerFirstName>Jane</CustomerFirstName>
      <CustomerLastName>Doe</CustomerLastName>
      <CustomerEmail>jane@example.com</CustomerEmail>
    </Order>
  </OrderDataSet>`;
  const { request } = parser.parse(xml, HOT_FOLDER_MINIMAL);
  assert.equal(request.order.total_amount, 1.30);
});

test('wholesale rollup is rounded to 2 decimal places (no FP drift to OrderHub UI)', () => {
  // 0.1 + 0.2 = 0.30000000000000004 in IEEE-754. Verify we round before send.
  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem>
      <idOrderLineItem>1</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>1</Quantity>
      <WholesaleCost>0.10</WholesaleCost>
    </OrderLineItem>
    <OrderLineItem>
      <idOrderLineItem>2</idOrderLineItem>
      <idSourceProduct>123</idSourceProduct>
      <Quantity>1</Quantity>
      <WholesaleCost>0.20</WholesaleCost>
    </OrderLineItem>
    <Order>
      <ExternalId>9999</ExternalId>
      <CustomerFirstName>Jane</CustomerFirstName>
      <CustomerLastName>Doe</CustomerLastName>
      <CustomerEmail>jane@example.com</CustomerEmail>
    </Order>
  </OrderDataSet>`;
  const { request } = parser.parse(xml, HOT_FOLDER_MINIMAL);
  assert.equal(request.order.total_amount, 0.30);
});
