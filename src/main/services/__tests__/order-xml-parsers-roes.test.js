/**
 * Unit tests for src/main/services/order-xml-parsers/roes.js.
 *
 * Run via:
 *   npm test
 *
 * Fixtures live in
 *   src/main/services/__tests__/fixtures/order-xml/roes/
 *
 * Canonical samples (the older RO068712/RO068713 are kept on disk for
 * archival but the parser tests use the post-2026-05-13 format that includes
 * UnitPrice + PaymentStatus):
 *   - RO068726: 6 line items (SP0507, SP0405, SP0710, SP0406, SP0810, SP0305)
 *     with mixed quantities, total = $15.50, PaymentStatus = Paid
 *   - RO068727: 1 line item (PP1117 × 2 @ $5.95), total = $11.90,
 *     PaymentStatus = Paid, ShipTo* populated (different from RO068726
 *     which is in-store pickup with empty ShipTo)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parser = require('../order-xml-parsers/roes');

const FIX_DIR = path.join(__dirname, 'fixtures', 'order-xml', 'roes');
const fixture = (name) => fs.readFileSync(path.join(FIX_DIR, name), 'utf8');

/** Full product map covering every code that appears in either fixture. */
function fullProductMap() {
  return new Map([
    ['PP1117', { pixfizzCode: 'PX-PP1117', label: '7x10 ROES Print' }],
    ['SP0507', { pixfizzCode: 'PX-SP0507', label: '5x7 Print' }],
    ['SP0405', { pixfizzCode: 'PX-SP0405', label: '4x5 Print' }],
    ['SP0710', { pixfizzCode: 'PX-SP0710', label: '7x10 Print' }],
    ['SP0406', { pixfizzCode: 'PX-SP0406', label: '4x6 Print' }],
    ['SP0810', { pixfizzCode: 'PX-SP0810', label: '8x10 Print' }],
    ['SP0305', { pixfizzCode: 'PX-SP0305', label: '3x5 Print' }],
  ]);
}

const HOT_FOLDER = {
  id: 'hf-roes-1', label: 'ROES Test', websiteCode: 'ROESCODE',
  // pickupLocationId — required for the empty-ShipTo pickup branch (2026-05-23).
  pickupLocationId: '00000000-0000-0000-0000-000000000001',
  productMap: fullProductMap(),
};

// ---------------------------------------------------------------------------
// Identity / sniff
// ---------------------------------------------------------------------------

test('exports the expected parser id and label', () => {
  assert.equal(parser.id, 'roes');
  assert.equal(parser.label, 'ROES (Pixfizz XML)');
});

test('matches() recognises a ROES snippet (idProduct without idSourceProduct)', () => {
  const sample = fixture('RO068727_ROESS-PixFizz-2026.xml').slice(0, 512);
  assert.equal(parser.matches(sample), true);
});

test('matches() rejects a PhotoFinale-shaped snippet (idSourceProduct present)', () => {
  const phLike = '<?xml version="1.0"?><OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd"><OrderLineItem><idProduct>1108776</idProduct><idSourceProduct>1082252</idSourceProduct></OrderLineItem>';
  assert.equal(parser.matches(phLike), false);
});

test('matches() rejects unrelated XML', () => {
  assert.equal(parser.matches('<?xml version="1.0"?><FooDocument/>'), false);
  assert.equal(parser.matches('<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd"></OrderDataSet>'), false);
});

// ---------------------------------------------------------------------------
// Happy-path fixtures (post-2026-05-13 format with UnitPrice + PaymentStatus)
// ---------------------------------------------------------------------------

test('RO068727 (single line, ShipTo populated): maps order-level fields incl. total + paid', () => {
  const { request, summary } = parser.parse(fixture('RO068727_ROESS-PixFizz-2026.xml'), HOT_FOLDER);
  const { order } = request;

  assert.equal(order.order_number,     'XML-RO068727');
  assert.equal(order.external_order_id,'RO068727');
  assert.equal(order.external_source,  'ROES');
  assert.equal(order.customer_name,    'Adam C Thomas'); // BillToFirstName has full name
  assert.equal(order.customer_email,   'acthomas1984@gmail.com');
  assert.equal(order.customer_phone,   '5024286949');
  assert.equal(order.website_code,     'ROESCODE');

  // Total: 2 × 5.95 = 11.90 — Richard's spec value for this order.
  assert.equal(order.total_amount,     11.90);

  // PaymentStatus = "Paid" → paid:true
  assert.equal(order.paid,             true);

  // ShipTo* fully populated in this sample → shipping fields ARE emitted.
  assert.equal(order.shipping_street,  '1743 Culbertson Ave');
  assert.equal(order.shipping_city,    'New Albany');
  assert.equal(order.shipping_state,   'IN');
  assert.equal(order.shipping_zipcode, '47150');
  assert.equal(order.shipping_country, 'USA');

  // Payment fields still omitted (PaymentMethod is empty AND we chose to not
  // emit payment_gateway regardless — 2026-05-13).
  assert.equal('payment_gateway'   in order, false);
  assert.equal('payment_reference' in order, false);

  assert.equal(summary.total, 11.90);
});

test('RO068727: single line item mapped to a JobInput with correct fields', () => {
  const { request } = parser.parse(fixture('RO068727_ROESS-PixFizz-2026.xml'), HOT_FOLDER);
  assert.equal(request.jobs.length, 1);
  assert.deepEqual(request.jobs[0], {
    job_id:                '1',
    external_line_item_id: '1',
    product_code:          'PX-PP1117',
    product_name:          '7x10 ROES Print',
    quantity:              2,
    artwork_on_file:       true,
  });
});

test('RO068726 (6 line items, in-store pickup): sums total across all line items', () => {
  const { request, summary } = parser.parse(fixture('RO068726_ROESS-PixFizz-2026.xml'), HOT_FOLDER);
  const { order } = request;

  assert.equal(order.order_number, 'XML-RO068726');
  assert.equal(order.customer_name,'Julie Metcalfe');
  assert.equal(order.customer_email,'juliemetcalfe27@gmail.com');
  assert.equal(order.paid,         true); // PaymentStatus="Paid"

  // Computed total: 5×0.60 + 4×0.29 + 7×0.95 + 6×0.32 + 2×0.95 + 3×0.29
  //               = 3.00  + 1.16  + 6.65  + 1.92  + 1.90  + 0.87 = 15.50
  assert.equal(order.total_amount, 15.50);
  assert.equal(summary.total,      15.50);

  // Empty ShipTo → pickup branch (2026-05-23): pickup_location_id IS set
  // from hotFolderConfig.pickupLocationId, and shipping_* fields are NOT
  // emitted.
  assert.equal(order.pickup_location_id, HOT_FOLDER.pickupLocationId);
  for (const k of ['shipping_street', 'shipping_city', 'shipping_state', 'shipping_zipcode']) {
    assert.equal(k in order, false);
  }

  assert.equal(request.jobs.length, 6);
});

test('RO068726: each line item mapped to its corresponding Pixfizz product', () => {
  const { request } = parser.parse(fixture('RO068726_ROESS-PixFizz-2026.xml'), HOT_FOLDER);
  const codes = request.jobs.map((j) => j.product_code);
  assert.deepEqual(codes, ['PX-SP0507', 'PX-SP0405', 'PX-SP0710', 'PX-SP0406', 'PX-SP0810', 'PX-SP0305']);
  const qtys = request.jobs.map((j) => j.quantity);
  assert.deepEqual(qtys, [5, 4, 7, 6, 2, 3]);
});

test('Empty ShipTo with no pickupLocationId configured → MISSING_PICKUP_LOCATION', () => {
  // 2026-05-23: pickup detection requires hotFolderConfig.pickupLocationId.
  // Without it, the parser holds the order so the operator can configure
  // Location ID under Settings → Polling and retry.
  const cfg = {
    id: 'hf', label: 'x',
    productMap: fullProductMap(),
    // pickupLocationId intentionally omitted.
  };
  assert.throws(
    () => parser.parse(fixture('RO068726_ROESS-PixFizz-2026.xml'), cfg),
    (err) => {
      assert.equal(err.code, 'MISSING_PICKUP_LOCATION');
      assert.match(err.message, /no Location ID is configured/i);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// PaymentStatus mapping (2026-05-13)
// ---------------------------------------------------------------------------

test('PaymentStatus "Paid" (mixed case) → paid:true', () => {
  for (const value of ['Paid', 'PAID', 'paid', '  Paid  ']) {
    const xml = makeRoesXml({ paymentStatus: value });
    const { request } = parser.parse(xml, HOT_FOLDER);
    assert.equal(request.order.paid, true, `expected paid:true for "${value}"`);
  }
});

test('PaymentStatus "Unpaid" / "Pending" / other → paid:false', () => {
  for (const value of ['Unpaid', 'Pending', 'Refunded', 'Partial']) {
    const xml = makeRoesXml({ paymentStatus: value });
    const { request } = parser.parse(xml, HOT_FOLDER);
    assert.equal(request.order.paid, false, `expected paid:false for "${value}"`);
  }
});

test('PaymentStatus missing entirely → paid:false (NOT legacy default true)', () => {
  // Confirms Richard's 2026-05-13 decision: no PaymentStatus tag means "we
  // don't know it's paid" rather than "assume paid".
  const xml = makeRoesXml({ omitPaymentStatus: true });
  const { request } = parser.parse(xml, HOT_FOLDER);
  assert.equal(request.order.paid, false);
});

test('Empty PaymentStatus tag → paid:false', () => {
  const xml = makeRoesXml({ paymentStatus: '' });
  const { request } = parser.parse(xml, HOT_FOLDER);
  assert.equal(request.order.paid, false);
});

// ---------------------------------------------------------------------------
// total_amount edge cases
// ---------------------------------------------------------------------------

test('total_amount omitted when no UnitPrice on any line item', () => {
  // Legacy ROES shape (no UnitPrice fields) — total_amount should NOT
  // appear, so OrderHub records the order without a fabricated zero total.
  const xml = makeRoesXml({ unitPrice: null });
  const { request } = parser.parse(xml, HOT_FOLDER);
  assert.equal('total_amount' in request.order, false);
  // summary.total still falls back to 0 for the panel column.
  // (parser doesn't break if total is 0; it just shows as $0.00.)
});

test('total_amount rounds floating-point sums to 2dp', () => {
  // 3 × 0.29 = 0.87 exactly, but JS gives 0.8699999… — the rounding catches it.
  const xml = makeRoesXml({ quantity: 3, unitPrice: 0.29 });
  const { request } = parser.parse(xml, HOT_FOLDER);
  assert.equal(request.order.total_amount, 0.87);
});

test('total_amount handles UnitPrice present on some lines but not others', () => {
  // Multi-line synthetic XML: two lines, one with UnitPrice, one without.
  const xml = `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem>
      <idOrderLineItem>1.0</idOrderLineItem>
      <idProduct>PP1117</idProduct>
      <Quantity>2.0</Quantity>
      <UnitPrice>5.95</UnitPrice>
    </OrderLineItem>
    <OrderLineItem>
      <idOrderLineItem>2.0</idOrderLineItem>
      <idProduct>PP1117</idProduct>
      <Quantity>3.0</Quantity>
    </OrderLineItem>
    <Order>
      <idOrder>RO000099</idOrder>
      <BillToFirstName>Test</BillToFirstName>
      <BillToEmail>t@e.com</BillToEmail>
      <PaymentStatus>Paid</PaymentStatus>
    </Order>
  </OrderDataSet>`;
  const { request } = parser.parse(xml, HOT_FOLDER);
  // Only the priced line contributes — 2 × 5.95 = 11.90. The other line
  // still appears as a job (because it has idProduct+Quantity), but doesn't
  // affect total_amount.
  assert.equal(request.order.total_amount, 11.90);
  assert.equal(request.jobs.length, 2);
});

// ---------------------------------------------------------------------------
// UNMAPPED_PRODUCTS (still applies to the new format)
// ---------------------------------------------------------------------------

test('UNMAPPED_PRODUCTS fires when the productMap is missing a code', () => {
  const cfg = { id: 'hf', label: 'x', productMap: new Map() };
  assert.throws(
    () => parser.parse(fixture('RO068727_ROESS-PixFizz-2026.xml'), cfg),
    (err) => {
      assert.equal(err.code, 'UNMAPPED_PRODUCTS');
      assert.deepEqual(err.details.unmappedCodes, ['PP1117']);
      return true;
    }
  );
});

test('UNMAPPED_PRODUCTS lists every distinct unmapped code on multi-line orders', () => {
  // Map only one of the six codes in RO068726.
  const cfg = { id: 'hf', label: 'x', productMap: new Map([
    ['SP0710', { pixfizzCode: 'PX-7', label: '7x10' }],
  ])};
  assert.throws(
    () => parser.parse(fixture('RO068726_ROESS-PixFizz-2026.xml'), cfg),
    (err) => {
      assert.equal(err.code, 'UNMAPPED_PRODUCTS');
      // Five codes missing (SP0710 is mapped, the others aren't).
      assert.equal(err.details.unmappedCodes.length, 5);
      for (const code of ['SP0507', 'SP0405', 'SP0406', 'SP0810', 'SP0305']) {
        assert.ok(err.details.unmappedCodes.includes(code), `missing ${code}`);
      }
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Structural rejections
// ---------------------------------------------------------------------------

test('rejects empty input', () => {
  assert.throws(
    () => parser.parse('', HOT_FOLDER),
    (err) => err.code === 'PARSE_ERROR'
  );
});

test('rejects truncated XML', () => {
  const truncated = fixture('RO068727_ROESS-PixFizz-2026.xml').replace('</OrderDataSet>', '');
  assert.throws(
    () => parser.parse(truncated, HOT_FOLDER),
    (err) => err.code === 'PARSE_ERROR'
  );
});

test('rejects missing idOrder', () => {
  const xml = makeRoesXml({ omitIdOrder: true });
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER),
    (err) => err.code === 'MISSING_EXTERNAL_ID'
  );
});

test('rejects missing customer email', () => {
  const xml = makeRoesXml({ omitEmail: true });
  assert.throws(
    () => parser.parse(xml, HOT_FOLDER),
    (err) => err.code === 'MISSING_CUSTOMER_EMAIL'
  );
});

// ---------------------------------------------------------------------------
// shipping_recipient_name (docs/xml-shipto-name-brief.md)
// ---------------------------------------------------------------------------
//
// Pre-fix, both parsers deliberately dropped ShipToFirstName / ShipToLastName
// on the grounds that "OrderInput has no first/last recipient field anyway".
// That was true when written on 2026-05-13; it stopped being true on
// 2026-08-05 when OrderHub gained `shipping_recipient_name`. These tests pin
// the fix and the invariants that keep it safe.
//
// Invariants (both parsers):
//   - The recipient name rides ONLY when a real shipping address is
//     present. A name alone must not flip a pickup order to shipping.
//   - customer_name is NOT touched. On the Etsy fixtures the BillTo-derived
//     value is "Etsy"; OrderHub uses shipping_recipient_name in preference
//     to customer_name on the label anyway (per the pixfizz-oms plan
//     referenced in the brief), so leaving customer_name alone preserves
//     the marketplace-origin signal.
//   - Both blank → the field is OMITTED entirely (not sent as '' or ' ').
//     setIfPresent's length check enforces this — same convention every
//     other optional string field on this parser follows.

test('Etsy fixture (order_4141229168 — Julie Johnson): ShipToFirst/Last both present → recipient_name mapped, customer_name unchanged', () => {
  // This is the file that surfaced the bug in production. BillToFirstName
  // = "Etsy", so pre-fix customer_name was "Etsy" and the actual recipient
  // "Julie Johnson" appeared nowhere. The fix maps ShipToFirstName +
  // ShipToLastName into shipping_recipient_name while leaving customer_name
  // as "Etsy" — the pixfizz-oms label builder prefers shipping_recipient_name
  // over customer_name on the shipping label, so this makes the address
  // correct without erasing the marketplace-origin signal.
  const productMap = new Map([
    ['ETSYFILM',      { pixfizzCode: 'PX-ETSYFILM',      label: 'Etsy Film' }],
    ['USPS-PRIORITY', { pixfizzCode: 'PX-USPS-PRIORITY', label: 'USPS Priority' }],
  ]);
  const cfg = { ...HOT_FOLDER, productMap };
  const { request } = parser.parse(fixture('order_4141229168.xml'), cfg);
  assert.equal(request.order.shipping_recipient_name, 'Julie Johnson');
  assert.equal(request.order.customer_name,           'Etsy',
    'customer_name stays as the BillTo-derived value — no overwrite from ShipTo');
  assert.equal(request.order.shipping_street,         '171 Gable Ave');
  assert.equal(request.order.shipping_city,           'POTTSTOWN');
});

test('Etsy fixture (order_4141030858 — Corina Bardwell): same shape, second regression sample', () => {
  const productMap = new Map([
    ['ETSY-YARDSIGN', { pixfizzCode: 'PX-ETSY-YARDSIGN', label: 'Etsy Yard Sign' }],
    ['UPS-GROUND',    { pixfizzCode: 'PX-UPS-GROUND',    label: 'UPS Ground' }],
  ]);
  const { request } = parser.parse(fixture('order_4141030858.xml'), { ...HOT_FOLDER, productMap });
  assert.equal(request.order.shipping_recipient_name, 'Corina Bardwell');
  assert.equal(request.order.customer_name,           'Etsy');
});

test('RO068727 fixture: ShipToFirstName only (LastName blank) → recipient_name = first name alone', () => {
  // Existing canonical fixture — ShipToFirstName is "Adam Thomas" (the
  // whole name landed in the first field on this one; a common
  // marketplace shape), ShipToLastName is empty. Locks the first-only
  // branch on real data.
  const { request } = parser.parse(fixture('RO068727_ROESS-PixFizz-2026.xml'), HOT_FOLDER);
  assert.equal(request.order.shipping_recipient_name, 'Adam Thomas');
});

test('synth: ShipToLastName only (FirstName blank) → recipient_name = last name alone', () => {
  const xml = parser.parse(
    makeRoesXml({ shipToFirstName: '', shipToLastName: 'Solo', shipToAddress: '1 Main' }),
    HOT_FOLDER,
  );
  assert.equal(xml.request.order.shipping_recipient_name, 'Solo');
});

test('synth: both ShipTo name fields blank on a shipping order → field OMITTED (not sent as empty string)', () => {
  // Real shipping order (address present) but no recipient names. Must
  // not send shipping_recipient_name at all — matches how every other
  // optional string field is handled via setIfPresent's length check.
  const { request } = parser.parse(
    makeRoesXml({ shipToFirstName: '', shipToLastName: '', shipToAddress: '1 Main' }),
    HOT_FOLDER,
  );
  assert.equal('shipping_recipient_name' in request.order, false);
  assert.equal(request.order.shipping_street, '1 Main');
});

test('RO068726 fixture (pickup, empty ShipTo): shipping_recipient_name is absent', () => {
  // Pickup branch must not emit shipping_recipient_name even when the
  // XML happens to contain ShipToFirst/LastName. RO068726's ShipTo
  // name fields are empty AND the whole ShipTo block is empty, so
  // this is really the pickup-branch omission that matters.
  const { request } = parser.parse(fixture('RO068726_ROESS-PixFizz-2026.xml'), HOT_FOLDER);
  assert.equal('shipping_recipient_name' in request.order, false);
  assert.equal(request.order.pickup_location_id, HOT_FOLDER.pickupLocationId);
});

test('synth: name present but NO address → still pickup, recipient_name absent', () => {
  // The load-bearing invariant. If ShipToFirstName / ShipToLastName were
  // counted toward `hasAnyShipTo`, a name-only marketplace forward would
  // flip from pickup to shipping and emit recipient_name without any
  // delivery address. The `shipTo` object below the fix deliberately
  // excludes the name fields for this reason — this test pins that.
  const { request } = parser.parse(
    makeRoesXml({ shipToFirstName: 'Ghost', shipToLastName: 'Recipient' }),
    HOT_FOLDER,
  );
  assert.equal(request.order.pickup_location_id, HOT_FOLDER.pickupLocationId,
    'name-only order must still be treated as pickup');
  assert.equal('shipping_recipient_name' in request.order, false,
    'no address → no recipient_name, even when a name is present in the XML');
  for (const k of ['shipping_street', 'shipping_city', 'shipping_state', 'shipping_zipcode', 'shipping_country', 'shipping_company']) {
    assert.equal(k in request.order, false);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal-but-valid ROES XML with optional mutations. Lets us test
 * one branch at a time without committing a fixture file per case.
 */
function makeRoesXml({
  quantity = 2,
  unitPrice = 5.95,            // null → omit UnitPrice entirely
  paymentStatus = 'Paid',      // empty string supported; null → omit tag
  omitPaymentStatus = false,
  omitIdOrder = false,
  omitEmail = false,
  // Ship-to controls added for shipping_recipient_name coverage. Pass a
  // string (including the empty string) to emit the tag with that value;
  // pass null to OMIT the tag entirely — the parser must treat both as
  // "no value" but only one shape may exercise the code path in the wild.
  shipToFirstName = null,
  shipToLastName  = null,
  shipToAddress   = null,
  shipToCity      = null,
} = {}) {
  const unitPriceLine = unitPrice === null ? '' : `<UnitPrice>${unitPrice}</UnitPrice>`;
  const psLine = omitPaymentStatus
    ? ''
    : `<PaymentStatus>${paymentStatus}</PaymentStatus>`;
  const idOrderLine = omitIdOrder ? '' : '<idOrder>RO000099</idOrder>';
  const emailLine   = omitEmail   ? '' : '<BillToEmail>t@e.com</BillToEmail>';
  const stFirst  = shipToFirstName === null ? '' : `<ShipToFirstName>${shipToFirstName}</ShipToFirstName>`;
  const stLast   = shipToLastName  === null ? '' : `<ShipToLastName>${shipToLastName}</ShipToLastName>`;
  const stStreet = shipToAddress   === null ? '' : `<ShipToAddress>${shipToAddress}</ShipToAddress>`;
  const stCity   = shipToCity      === null ? '' : `<ShipToCity>${shipToCity}</ShipToCity>`;
  return `<OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd">
    <OrderLineItem>
      <idOrderLineItem>1.0</idOrderLineItem>
      <idProduct>PP1117</idProduct>
      <Quantity>${quantity}.0</Quantity>
      ${unitPriceLine}
    </OrderLineItem>
    <Order>
      ${idOrderLine}
      <BillToFirstName>Test</BillToFirstName>
      ${emailLine}
      ${psLine}
      ${stFirst}
      ${stLast}
      ${stStreet}
      ${stCity}
    </Order>
  </OrderDataSet>`;
}
