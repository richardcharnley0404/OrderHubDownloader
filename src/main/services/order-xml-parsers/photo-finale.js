/**
 * PhotoFinale (Trevoli OrderDataSet) XML parser.
 *
 * Maps a PhotoFinale order XML — the format produced by Photo Finale Mobile
 * desktop and dropped into a hot folder by the lab's PhotoFinale instance —
 * into the OrderHub `POST /api-webhook` request shape (`SubmitOrderRequest`).
 *
 * Field mapping reference: docs/orderhub/openapi.json (OrderInput / JobInput),
 * cross-referenced against the four canonical sample XMLs in
 * src/main/services/__tests__/fixtures/order-xml/photo-finale/.
 *
 * Conventions:
 *   - The parser is *pure*: same input → same output, no fs / network / config.
 *   - It receives a `hotFolderConfig` for per-folder values (websiteCode).
 *   - It does NOT inject `organization_id` (the API key); that's the
 *     OrderHub API client's job, since auth is global rather than per-folder.
 *   - Validation failures throw a `PhotoFinaleValidationError` with a stable
 *     `code` so the watcher can route to `failed/` and surface a useful
 *     `errorMessage` in the ingestion record.
 */

'use strict';

const { XMLParser } = require('fast-xml-parser');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class PhotoFinaleParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhotoFinaleParseError';
    this.code = 'PARSE_ERROR';
  }
}

class PhotoFinaleValidationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PhotoFinaleValidationError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// XML parser instance
// ---------------------------------------------------------------------------

// Tags that may legitimately repeat as siblings inside <OrderDataSet>. Without
// this hint, fast-xml-parser collapses single-occurrence tags into objects and
// only auto-promotes to arrays when 2+ are present, which would force every
// caller to do `Array.isArray() ? x : [x]` everywhere.
const ARRAY_TAGS = new Set([
  'OrderLineItem',
  'OrderLineItemPhoto',
  'OrderPayment',
  'OrderTax',
  'OrderLineItemPriceBreakdown',
]);

const PARSER = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,        // numeric tags (Total, Quantity, etc.) auto-coerced
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PARSER_ID = 'photofinale';
const PARSER_LABEL = 'PhotoFinale (Trevoli OrderDataSet)';
const EXTERNAL_SOURCE = 'PhotoFinale';

/**
 * Quick-reject sniff. Reads the first ~512 bytes of the file and confirms it
 * looks like an OrderDataSet document. Used by the watcher to fail fast on
 * misrouted files without paying full-parse cost.
 *
 * @param {string} xmlSnippet - first ~512 bytes of file content
 * @returns {boolean}
 */
function matches(xmlSnippet) {
  if (typeof xmlSnippet !== 'string') return false;
  return xmlSnippet.includes('<OrderDataSet') &&
         xmlSnippet.includes('trevoli.com/OrderDataSet');
}

/**
 * Parse + map a PhotoFinale OrderDataSet XML into an OrderHub submission.
 *
 * @param {string} xmlString
 * @param {object} hotFolderConfig - { websiteCode?: string, label?: string, ... }
 * @returns {{ request: { order: object, jobs: object[] }, summary: object }}
 *   `request` is the body for POST /api-webhook (less `order.organization_id`,
 *   which the API client injects).
 *   `summary` is the human-readable record fields used by the ingestion store
 *   and panel.
 *
 * @throws {PhotoFinaleParseError}      on malformed XML
 * @throws {PhotoFinaleValidationError} on structural / business validation
 */
function parse(xmlString, hotFolderConfig = {}) {
  if (typeof xmlString !== 'string' || xmlString.length === 0) {
    throw new PhotoFinaleParseError('Empty or non-string XML input');
  }

  // Read-then-validate guard: the watcher calls this on chokidar `add`, so we
  // can hit a partial write where the closing tag hasn't been flushed yet.
  // Surface that as a parse error so the watcher can requeue with backoff.
  if (!xmlString.includes('</OrderDataSet>')) {
    throw new PhotoFinaleParseError('XML appears truncated — no closing </OrderDataSet> tag');
  }

  let parsed;
  try {
    parsed = PARSER.parse(xmlString);
  } catch (err) {
    throw new PhotoFinaleParseError(`Invalid XML: ${err.message}`);
  }

  const dataset = parsed && parsed.OrderDataSet;
  if (!dataset || typeof dataset !== 'object') {
    throw new PhotoFinaleParseError('Missing OrderDataSet root element');
  }

  // <Order> is single-occurrence per spec; not in ARRAY_TAGS so it lands as an object.
  const orderRaw = dataset.Order;
  if (!orderRaw || typeof orderRaw !== 'object' || Array.isArray(orderRaw)) {
    throw new PhotoFinaleValidationError(
      'MISSING_ORDER',
      'XML contains no <Order> element (or contains more than one)'
    );
  }

  const allLineItems = dataset.OrderLineItem || [];
  if (!Array.isArray(allLineItems) || allLineItems.length === 0) {
    throw new PhotoFinaleValidationError(
      'NO_LINE_ITEMS',
      'XML contains no <OrderLineItem> elements'
    );
  }

  // PhotoFinale partial-order semantics (clarified 2026-05-11):
  //
  // When an originating lab forwards an order to another lab, every line
  // carries a per-line <Status>. Status="0" means the originating lab is
  // printing that line themselves and the receiving lab must NOT submit it
  // to OrderHub. Status="1" means the line is for the receiving lab to
  // produce. Status missing or any other value falls through as "include"
  // — we treat the explicit "0" as the only exclusion signal so older
  // single-lab XMLs (no <Status> on lines) keep submitting every line.
  //
  // The `(product deleted:NNN)` token in <ProductSummary> is part of the
  // same forwarded-order mechanism — PhotoFinale renders the originating
  // lab's lines as that token rather than the real product name. It is
  // NOT a true catalogue-deletion signal, so we no longer reject on it
  // (prior behaviour, removed 2026-05-11).
  const lineItems = allLineItems.filter((li) => {
    const status = strField(li && li.Status);
    return status !== '0';
  });
  if (lineItems.length === 0) {
    throw new PhotoFinaleValidationError(
      'NO_BILLABLE_LINES',
      `Every line in this order is marked <Status>0</Status> — the originating lab is printing all ${allLineItems.length} line(s) themselves, leaving nothing to submit to OrderHub.`,
      { totalLines: allLineItems.length }
    );
  }

  // -------------------------------------------------------------------------
  // Order-level validation
  // -------------------------------------------------------------------------

  const externalId = strField(orderRaw.ExternalId);
  if (!externalId) {
    throw new PhotoFinaleValidationError('MISSING_EXTERNAL_ID', 'Missing Order/ExternalId');
  }

  // order_number sent to OrderHub: "XML-<ExternalId>" (simplified 2026-05-11).
  // The "XML-" prefix tells lab staff at-a-glance that these orders came in
  // via the hot folder, and ExternalId is the global PhotoFinale order id.
  // The earlier composite "XML-<idOrder>-<ExternalId>" was dropped because
  // ExternalId alone is unique enough for de-dup and the per-tenant idOrder
  // sequence added noise without identification value.
  const orderNumber = `XML-${externalId}`;

  const firstName = strField(orderRaw.CustomerFirstName);
  const lastName  = strField(orderRaw.CustomerLastName);
  const xmlCustomerName  = [firstName, lastName].filter(Boolean).join(' ').trim();
  const xmlCustomerEmail = strField(orderRaw.CustomerEmail);

  // -------------------------------------------------------------------------
  // Customer directory lookup (added 2026-05-11)
  // -------------------------------------------------------------------------
  //
  // PhotoFinale's <CustomerFirstName>/<CustomerEmail> identify the cardholder
  // (whoever paid for the order), but the lab needs OrderHub to record the
  // *retailer* who placed the bulk order — keyed by <RetailerDealerCode>.
  // The customer directory (Settings → Order XML → Customers) maps each
  // dealer code to a Customer Name + Email that gets written into
  // OrderInput.customer_name / customer_email instead of the cardholder.
  //
  // Opt-in: only enforced when the customer map is non-empty. With zero
  // records configured the parser falls back to the XML's customer fields
  // (legacy behaviour) — keeps existing installations working until the
  // operator has time to populate the directory.
  //
  // No match while the directory has any entries → CUSTOMER_NOT_FOUND, the
  // whole order goes to failed/. errorDetails carries the unresolved code so
  // the panel can offer a one-click "Add Customer" action that pre-seeds the
  // settings UI with the missing id.
  const customerMap = (hotFolderConfig && hotFolderConfig.customerMap) || new Map();
  const retailerCode = strField(orderRaw.RetailerDealerCode);

  let customerName;
  let customerEmail;

  if (customerMap.size > 0) {
    if (!retailerCode) {
      throw new PhotoFinaleValidationError(
        'CUSTOMER_NOT_FOUND',
        'Customer directory is configured but the order has no <RetailerDealerCode> to look up',
        { retailerCode: '' }
      );
    }
    const hit = customerMap.get(retailerCode.toLowerCase());
    if (!hit) {
      throw new PhotoFinaleValidationError(
        'CUSTOMER_NOT_FOUND',
        `No customer record matches RetailerDealerCode "${retailerCode}". Add a customer in Settings → Order XML → Customers and retry.`,
        { retailerCode }
      );
    }
    customerName  = hit.customerName;
    customerEmail = hit.customerEmail;
  } else {
    if (!xmlCustomerName) {
      throw new PhotoFinaleValidationError(
        'MISSING_CUSTOMER_NAME',
        'Missing Order/CustomerFirstName and/or CustomerLastName'
      );
    }
    if (!xmlCustomerEmail) {
      throw new PhotoFinaleValidationError(
        'MISSING_CUSTOMER_EMAIL',
        'Missing Order/CustomerEmail'
      );
    }
    customerName  = xmlCustomerName;
    customerEmail = xmlCustomerEmail;
  }

  // <ProductSummary> is captured for the ingestion record (panel display)
  // only — it's PhotoFinale-rendered free text and not sent to OrderHub. Any
  // "(product deleted:NNN)" tokens inside it correspond to per-line
  // Status="0" entries the receiving lab is NOT printing, so they're
  // intentionally not validated against the Pixfizz mapping table.
  const productSummary = strField(orderRaw.ProductSummary);

  // -------------------------------------------------------------------------
  // Line-item validation
  // -------------------------------------------------------------------------

  for (const li of lineItems) {
    const id = li && li.idOrderLineItem;
    const idSourceProduct = li && li.idSourceProduct;
    if (idSourceProduct === undefined || idSourceProduct === null ||
        idSourceProduct === '' || Number.isNaN(Number(idSourceProduct))) {
      throw new PhotoFinaleValidationError(
        'INVALID_PRODUCT',
        `OrderLineItem ${id ?? '(no id)'} has missing or invalid idSourceProduct`,
        { idOrderLineItem: id, idSourceProduct }
      );
    }
    const qty = Number(li.Quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      throw new PhotoFinaleValidationError(
        'INVALID_QUANTITY',
        `OrderLineItem ${id ?? '(no id)'} has missing or invalid Quantity`,
        { idOrderLineItem: id, Quantity: li.Quantity }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Product mapping enforcement (added 2026-05-08)
  // -------------------------------------------------------------------------
  //
  // OrderHub today accepts any string as `product_code` and creates a generic
  // line item — silent failure mode where unmapped PhotoFinale codes go in
  // unlinked to real Pixfizz products. We close that hole here: every
  // OrderLineItem's idSourceProduct must resolve via the per-format
  // productMap configured in Settings → Order XML → Product Mappings.
  //
  // productMap is a Map<photoFinaleCode (string), { pixfizzCode, label }>.
  // It's read from configService.getProductMappingsFor('photofinale') by the
  // watcher and threaded through hotFolderConfig.productMap.
  //
  // No mapping → UNMAPPED_PRODUCTS, the whole order goes to failed/. Operator
  // adds the missing entries via the Order XML panel's "Add Mapping" action,
  // hits Retry, and the order flows. Hold-whole-order rather than partial
  // submission was Richard's call (2026-05-08 chat).

  const productMap = (hotFolderConfig && hotFolderConfig.productMap) || new Map();
  const unmapped = [];
  const seen = new Set();
  for (const li of lineItems) {
    const code = String(li.idSourceProduct);
    if (!productMap.has(code) && !seen.has(code)) {
      unmapped.push(code);
      seen.add(code);
    }
  }
  if (unmapped.length > 0) {
    throw new PhotoFinaleValidationError(
      'UNMAPPED_PRODUCTS',
      `Order references PhotoFinale product code(s) with no Pixfizz mapping: ${unmapped.join(', ')}`,
      { unmappedCodes: unmapped }
    );
  }

  // -------------------------------------------------------------------------
  // Pickup vs shipping detection (added 2026-05-11)
  // -------------------------------------------------------------------------
  //
  // PhotoFinale represents pickup orders by setting <ShipToAddress> equal to
  // the retailer's own street (<RetailerStreet>) — the cardholder collects
  // from the lab. We mirror that into OrderHub by populating
  // pickup_location_id (UUID) and dropping the shipping_* address fields so
  // downstream consumers don't treat the retailer's address as a delivery
  // destination.
  //
  // pickup_location_id is the lab's default location UUID — the same value
  // configured under Settings → Polling (`locationId`) since one OHD instance
  // is paired with one lab/location. The watcher threads it through as
  // hotFolderConfig.pickupLocationId.
  //
  // Pickup detected but no locationId configured → MISSING_PICKUP_LOCATION,
  // the order is held so the operator can fix the config and retry.
  const retailerStreet = strField(orderRaw.RetailerStreet);
  const shipToAddress  = strField(orderRaw.ShipToAddress);
  const isPickup = retailerStreet.length > 0 && shipToAddress.length > 0 &&
                   retailerStreet.toLowerCase() === shipToAddress.toLowerCase();

  if (isPickup && !strField(hotFolderConfig.pickupLocationId)) {
    throw new PhotoFinaleValidationError(
      'MISSING_PICKUP_LOCATION',
      'Pickup order detected (RetailerStreet matches ShipToAddress) but no Location ID is configured. Set Location ID under Settings → Polling and retry.',
      { retailerStreet, shipToAddress }
    );
  }

  // -------------------------------------------------------------------------
  // Order total — wholesale rollup (added 2026-05-11)
  // -------------------------------------------------------------------------
  //
  // PhotoFinale carries two prices per line: <UnitPrice> (retail — what the
  // cardholder paid) and <WholesaleCost> (what the retailer pays the lab).
  // The XML's order-level <Total> is the retail total. OrderHub should record
  // the wholesale total instead, so we recompute total_amount as the sum of
  // WholesaleCost × Quantity across all line items. Tax/shipping/discount
  // continue to flow through from the XML's order-level totals unchanged
  // (they're independent of which unit price we use).
  //
  // Lines with missing/invalid WholesaleCost contribute 0 — this surfaces as
  // a visibly-low total in OrderHub rather than holding the order. Hold-on-
  // missing was rejected as too aggressive given PhotoFinale's <WholesaleCost>
  // tag is occasionally absent on free / promotional items.
  let wholesaleTotal = 0;
  for (const li of lineItems) {
    const cost = numField(li.WholesaleCost);
    const qty  = Math.max(1, Math.floor(Number(li.Quantity) || 1));
    if (typeof cost === 'number') wholesaleTotal += cost * qty;
  }
  // Round to 2dp so floating-point drift doesn't surface as "$3.0599999" in
  // the OrderHub UI. The XML emits 4-decimal prices but OrderHub displays at
  // cents granularity.
  wholesaleTotal = Math.round(wholesaleTotal * 100) / 100;

  // -------------------------------------------------------------------------
  // Build OrderInput
  // -------------------------------------------------------------------------

  // PhotoFinale orders arriving via the hot folder are always settled upstream
  // (PhotoFinale handles the customer payment) — by the time the XML lands
  // here, the order is paid. We hardcode `paid: true` rather than try to derive
  // it from <OrderPayment>; per Richard's 2026-05-08 decision, payment fields
  // (gateway, reference) are omitted entirely.
  const order = {
    // organization_id is injected by the API client just before submit; the
    // parser keeps zero awareness of API credentials.
    order_number:    orderNumber,
    customer_name:   customerName,
    customer_email:  customerEmail,
    external_source: EXTERNAL_SOURCE,
    paid:            true,
  };

  setIfPresent(order, 'customer_phone',  strField(orderRaw.CustomerPhone));
  setIfPresent(order, 'total_amount',    wholesaleTotal);
  setIfPresent(order, 'total_tax',       numField(orderRaw.Tax));
  setIfPresent(order, 'total_shipping',  numField(orderRaw.ShippingTotal));
  setIfPresent(order, 'total_discount',  numField(orderRaw.Discount));

  setIfPresent(order, 'notes',             strField(orderRaw.SpecialInstructions));
  setIfPresent(order, 'external_order_id', externalId);

  // ShippingMethod is informational regardless of pickup/ship — keep it
  // either way so the lab UI can show "Mail" / "UPS" / "Pickup" verbatim.
  setIfPresent(order, 'shipping_method',   strField(orderRaw.ShippingMethod));

  if (isPickup) {
    setIfPresent(order, 'pickup_location_id', strField(hotFolderConfig.pickupLocationId));
    // Deliberately omit shipping_street/city/state/zip/country/company/
    // recipient_name — the address values would be the retailer's own
    // address (misleading on pickup), and a recipient name without an
    // address is not a delivery.
  } else {
    setIfPresent(order, 'shipping_street',   shipToAddress);
    setIfPresent(order, 'shipping_city',     strField(orderRaw.ShipToCity));
    setIfPresent(order, 'shipping_state',    strField(orderRaw.ShipToState));
    setIfPresent(order, 'shipping_zipcode',  strField(orderRaw.ShipToZip));
    setIfPresent(order, 'shipping_country',  strField(orderRaw.ShipToCountry));
    setIfPresent(order, 'shipping_company',  strField(orderRaw.ShipToCompany));
    // shipping_recipient_name — join first + last, drop either side if
    // blank so a first-only or last-only order still surfaces the name
    // it does have. Both blank → the empty result trips setIfPresent's
    // length check and the field is omitted entirely, matching every
    // other optional string field's convention. Pre-fix this mapping
    // was missing — the OrderHub column has existed since 2026-08-05
    // (api-webhook `shipping_recipient_name`) but neither XML parser
    // wrote it, so 374 XML orders shipped with null recipient. The
    // Etsy marketplace path made the miss visible because the BillTo
    // name reads "Etsy" and the real recipient lives only in ShipTo.
    // See docs/xml-shipto-name-brief.md.
    setIfPresent(order, 'shipping_recipient_name',
      [strField(orderRaw.ShipToFirstName), strField(orderRaw.ShipToLastName)]
        .filter(Boolean).join(' ').trim());
  }

  setIfPresent(order, 'website_code',      strField(hotFolderConfig.websiteCode));

  // -------------------------------------------------------------------------
  // Build JobInput[]
  // -------------------------------------------------------------------------

  const jobs = lineItems.map((li) => {
    const lineId   = String(li.idOrderLineItem);
    const pfCode   = String(li.idSourceProduct);
    // productMap has been validated above; .get() is safe here.
    const mapping  = productMap.get(pfCode);
    return {
      job_id:                lineId,
      // PhotoFinale's line-item id stays as external_line_item_id for
      // traceability — operators / OrderHub can still find their way back to
      // the source line if needed.
      external_line_item_id: lineId,
      product_code:          mapping.pixfizzCode,
      product_name:          mapping.label,
      quantity:              Math.max(1, Math.floor(Number(li.Quantity))),
      artwork_on_file:       true,
    };
  });

  // -------------------------------------------------------------------------
  // Build summary (for ingestion record + panel display)
  // -------------------------------------------------------------------------

  const summary = {
    externalId,
    customer:       customerName,
    customerEmail,
    total:          numField(orderRaw.Total) ?? 0,
    productSummary: productSummary || '',
    lineItemCount:  lineItems.length,
    shippingMethod: strField(orderRaw.ShippingMethod) || '',
    shipToCity:     strField(orderRaw.ShipToCity) || '',
    shipToState:    strField(orderRaw.ShipToState) || '',
  };

  return { request: { order, jobs }, summary };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a parsed XML value to a non-empty trimmed string, or '' if the value
 * is missing / empty. fast-xml-parser returns:
 *   - a string for non-numeric content (`'Jackie Art'`)
 *   - a number for numeric content (`525`)
 *   - an empty string for self-closing tags (`<GiftText />`)
 *   - `undefined` if the tag isn't present
 */
function strField(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return ''; // self-closing tags parse as {}
  return String(v).trim();
}

/**
 * Coerce a parsed XML value to a finite number, or `null` if missing/invalid.
 * Returns `null` (not `0`) so callers can distinguish "field absent" from
 * "field present and zero".
 */
function numField(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function setIfPresent(obj, key, value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    obj[key] = value;
  } else if (typeof value === 'string' && value.length > 0) {
    obj[key] = value;
  }
}

module.exports = {
  id:    PARSER_ID,
  label: PARSER_LABEL,
  matches,
  parse,
  PhotoFinaleParseError,
  PhotoFinaleValidationError,
};
