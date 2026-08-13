/**
 * ROES (Pixfizz XML) order parser.
 *
 * Maps a ROES order XML — a much thinner payload than PhotoFinale, used by
 * labs that have ROES as the upstream order-entry system — into the OrderHub
 * `POST /api-webhook` request shape.
 *
 * Despite sharing the same `OrderDataSet` root element and namespace as
 * PhotoFinale, ROES files only carry:
 *   - <idOrder>            — alphanumeric, e.g. "RO068713"
 *   - <OrderLineItem>      — with <idOrderLineItem>, <idProduct>, <Quantity>
 *   - <SpecialInstructions>
 *   - <BillTo*> + <ShipTo*> address blocks (ShipTo is often empty)
 *
 * Notably absent: ExternalId, ProductSummary, Total/Tax/Shipping/Discount,
 * ShippingMethod, OrderPayment, deleted-product markers, Status. The mapping
 * therefore boils down to identity + line items + addresses.
 *
 * The parser is *pure* (same contract as photo-finale.js — see that file's
 * docstring for conventions). Errors carry the same shape so the watcher
 * doesn't need to know which format produced them.
 *
 * Decisions confirmed with Richard 2026-05-13 (pickup wiring added 2026-05-23):
 *   1. Shipping fields are only sent when ShipTo* has at least one non-empty
 *      value. An ALL-empty ShipTo means the order is in-store pickup —
 *      pickup_location_id is set from hotFolderConfig.pickupLocationId
 *      (mirroring photo-finale.js); a missing pickupLocationId throws
 *      MISSING_PICKUP_LOCATION so the operator can configure it and retry.
 *      Partial ShipTo (e.g. city without street) still counts as shipping;
 *      ShipToFirstName / ShipToLastName alone do not — a recipient name
 *      without an address is not a delivery address.
 *   2. customer_name is BillToFirstName + ' ' + BillToLastName, trimmed. The
 *      samples put the full name in FirstName with LastName empty, so trim
 *      handles "Kathy Chandler " → "Kathy Chandler".
 *   3. Auto-confirm fires the same way as PhotoFinale (watcher passes
 *      confirmAfterSubmit:true regardless of source format).
 */

'use strict';

const { XMLParser } = require('fast-xml-parser');

// ---------------------------------------------------------------------------
// Errors (mirror photo-finale.js so the watcher can handle them uniformly)
// ---------------------------------------------------------------------------

class RoesParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoesParseError';
    this.code = 'PARSE_ERROR';
  }
}

class RoesValidationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RoesValidationError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// XML parser instance
// ---------------------------------------------------------------------------

// Only <OrderLineItem> can repeat at the OrderDataSet level for ROES; we still
// declare it so a single-item order parses as a one-element array (avoiding
// the "object vs array" downstream branch).
const ARRAY_TAGS = new Set(['OrderLineItem']);

const PARSER = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PARSER_ID = 'roes';
const PARSER_LABEL = 'ROES (Pixfizz XML)';
const EXTERNAL_SOURCE = 'ROES';

/**
 * Quick-reject sniff. Reads the first ~512 bytes of file content.
 *
 * ROES and PhotoFinale share the `<OrderDataSet xmlns="trevoli.com/...">`
 * root, so we can't discriminate on namespace alone. The reliable signal:
 * PhotoFinale always emits both `<idProduct>` and `<idSourceProduct>` on each
 * line item; ROES emits only `<idProduct>`. Spotting `<idSourceProduct>` in
 * the snippet → PhotoFinale → not ours.
 *
 * Both sample files fit a single `<OrderLineItem>` inside the first 512 bytes,
 * so the sniff sees a representative line item.
 *
 * @param {string} xmlSnippet
 * @returns {boolean}
 */
function matches(xmlSnippet) {
  if (typeof xmlSnippet !== 'string') return false;
  if (!xmlSnippet.includes('<OrderDataSet')) return false;
  // PhotoFinale marker — reject.
  if (xmlSnippet.includes('<idSourceProduct>')) return false;
  // ROES marker — accept only if at least one <idProduct> appears in the
  // snippet (avoids picking up a totally empty OrderDataSet).
  return xmlSnippet.includes('<idProduct>');
}

/**
 * Parse + map a ROES OrderDataSet XML into an OrderHub submission.
 *
 * @param {string} xmlString
 * @param {object} hotFolderConfig - { websiteCode?, productMap?, ... }
 * @returns {{ request: { order, jobs }, summary }}
 * @throws {RoesParseError}      on malformed XML
 * @throws {RoesValidationError} on structural / business validation
 */
function parse(xmlString, hotFolderConfig = {}) {
  if (typeof xmlString !== 'string' || xmlString.length === 0) {
    throw new RoesParseError('Empty or non-string XML input');
  }
  if (!xmlString.includes('</OrderDataSet>')) {
    throw new RoesParseError('XML appears truncated — no closing </OrderDataSet> tag');
  }

  let parsed;
  try {
    parsed = PARSER.parse(xmlString);
  } catch (err) {
    throw new RoesParseError(`Invalid XML: ${err.message}`);
  }

  const dataset = parsed && parsed.OrderDataSet;
  if (!dataset || typeof dataset !== 'object') {
    throw new RoesParseError('Missing OrderDataSet root element');
  }

  const orderRaw = dataset.Order;
  if (!orderRaw || typeof orderRaw !== 'object' || Array.isArray(orderRaw)) {
    throw new RoesValidationError(
      'MISSING_ORDER',
      'XML contains no <Order> element (or contains more than one)'
    );
  }

  const lineItems = dataset.OrderLineItem || [];
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new RoesValidationError(
      'NO_LINE_ITEMS',
      'XML contains no <OrderLineItem> elements'
    );
  }

  // -------------------------------------------------------------------------
  // Order-level validation
  // -------------------------------------------------------------------------

  const idOrder = strField(orderRaw.idOrder);
  if (!idOrder) {
    throw new RoesValidationError(
      'MISSING_EXTERNAL_ID',
      'Missing Order/idOrder (the ROES order number)'
    );
  }

  // ROES doesn't carry a separate ExternalId; idOrder *is* the global
  // identifier. We still produce the same "XML-…" prefix so OrderHub UI
  // labels these consistently with PhotoFinale hot-folder orders.
  // Composite shape is identical: `XML-<idOrder>` (no second segment).
  const orderNumber = `XML-${idOrder}`;

  // Customer name — both samples put the full name in BillToFirstName with
  // BillToLastName empty. Concat + trim handles either layout cleanly.
  const firstName = strField(orderRaw.BillToFirstName);
  const lastName  = strField(orderRaw.BillToLastName);
  const customerName = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (!customerName) {
    throw new RoesValidationError(
      'MISSING_CUSTOMER_NAME',
      'Missing Order/BillToFirstName (used as customer name)'
    );
  }

  const customerEmail = strField(orderRaw.BillToEmail);
  if (!customerEmail) {
    throw new RoesValidationError(
      'MISSING_CUSTOMER_EMAIL',
      'Missing Order/BillToEmail'
    );
  }

  // -------------------------------------------------------------------------
  // Line-item validation
  // -------------------------------------------------------------------------

  for (const li of lineItems) {
    const id = li && li.idOrderLineItem;
    const idProduct = li && li.idProduct;
    if (idProduct === undefined || idProduct === null || String(idProduct).trim() === '') {
      throw new RoesValidationError(
        'INVALID_PRODUCT',
        `OrderLineItem ${id ?? '(no id)'} has missing idProduct`,
        { idOrderLineItem: id, idProduct }
      );
    }
    const qty = Number(li.Quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      throw new RoesValidationError(
        'INVALID_QUANTITY',
        `OrderLineItem ${id ?? '(no id)'} has missing or invalid Quantity`,
        { idOrderLineItem: id, Quantity: li.Quantity }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Product mapping enforcement (mirror photo-finale.js)
  // -------------------------------------------------------------------------
  //
  // ROES has its own slice of `orderXmlProductMappings` keyed by sourceFormat
  // (set to 'roes' here). Vendor codes are alphanumeric SKUs like "SP0710"
  // — completely separate code space from PhotoFinale's numeric SKUs, so a
  // single global mapping table would risk silent collisions.

  const productMap = (hotFolderConfig && hotFolderConfig.productMap) || new Map();
  const unmapped = [];
  const seen = new Set();
  for (const li of lineItems) {
    const code = String(li.idProduct).trim();
    if (!productMap.has(code) && !seen.has(code)) {
      unmapped.push(code);
      seen.add(code);
    }
  }
  if (unmapped.length > 0) {
    throw new RoesValidationError(
      'UNMAPPED_PRODUCTS',
      `Order references ROES product code(s) with no Pixfizz mapping: ${unmapped.join(', ')}`,
      { unmappedCodes: unmapped }
    );
  }

  // -------------------------------------------------------------------------
  // Order total + payment status (added 2026-05-13 with the new ROES samples)
  // -------------------------------------------------------------------------
  //
  // Two new fields ROES now emits:
  //   - <UnitPrice> per OrderLineItem  → sum(qty × unitPrice) → total_amount
  //   - <PaymentStatus> on Order        → drives the OrderHub `paid` boolean
  //
  // PaymentStatus mapping (Richard's 2026-05-13 decision):
  //   - "paid" (case-insensitive) → paid:true
  //   - anything else, including missing → paid:false
  //
  // Note this is stricter than the original "hardcoded true" behaviour —
  // any pre-PaymentStatus ROES drops will now land as paid:false. The lab
  // must include PaymentStatus on every order going forward.
  //
  // total_amount: only emitted when at least one line item carries UnitPrice;
  // otherwise we don't fabricate a zero (would mislead operators reading
  // OrderHub). Floating-point sums are rounded to 2dp to avoid 15.499999...

  let computedTotal = null;
  let anyUnitPriceSeen = false;
  for (const li of lineItems) {
    const unitPriceRaw = li && li.UnitPrice;
    if (unitPriceRaw === undefined || unitPriceRaw === null || unitPriceRaw === '') continue;
    const unitPrice = Number(unitPriceRaw);
    if (!Number.isFinite(unitPrice)) continue;
    anyUnitPriceSeen = true;
    const qty = Number(li.Quantity); // already validated > 0 above
    computedTotal = (computedTotal || 0) + (qty * unitPrice);
  }
  if (anyUnitPriceSeen && computedTotal !== null) {
    // Round to 2dp using the standard money-rounding pattern; avoids
    // surprises like 15.499999999999998.
    computedTotal = Math.round(computedTotal * 100) / 100;
  }

  const paymentStatus = strField(orderRaw.PaymentStatus);
  const isPaid = paymentStatus.toLowerCase() === 'paid';

  const order = {
    order_number:    orderNumber,
    customer_name:   customerName,
    customer_email:  customerEmail,
    external_source: EXTERNAL_SOURCE,
    paid:            isPaid,
  };

  setIfPresent(order, 'total_amount',     computedTotal);
  setIfPresent(order, 'customer_phone',   strField(orderRaw.BillToPhone));
  setIfPresent(order, 'notes',            strField(orderRaw.SpecialInstructions));
  setIfPresent(order, 'external_order_id', idOrder);

  // Shipping vs pickup detection (pickup wiring added 2026-05-23).
  //
  // Per Richard's 2026-05-13 decision: shipping_* fields are only sent when
  // ShipTo* has at least one non-empty value. An ALL-empty ShipTo means the
  // order is in-store pickup — pickup_location_id is set from
  // hotFolderConfig.pickupLocationId (mirroring photo-finale.js's pickup
  // branch). Partial ShipTo (e.g. city without street) still counts as
  // shipping.
  //
  // ShipToFirstName / ShipToLastName are deliberately NOT part of the
  // `shipTo` object below — a recipient name alone is not a delivery
  // address. A name-only order stays pickup. The recipient name rides
  // along only when a real address is present, mapped into
  // shipping_recipient_name inside the shipping branch. See
  // docs/xml-shipto-name-brief.md — this parenthetical used to assert
  // "OrderInput has no first/last recipient field anyway"; that was
  // true when written on 2026-05-13 and stopped being true on 2026-08-05
  // when OrderHub gained shipping_recipient_name. The Etsy marketplace
  // path was the one that surfaced the miss (BillTo names read "Etsy",
  // ShipTo carries the real recipient) — customer_name intentionally
  // stays as the BillTo-derived value; recipient rides on the shipping
  // address only.
  const shipTo = {
    street:  strField(orderRaw.ShipToAddress),
    city:    strField(orderRaw.ShipToCity),
    state:   strField(orderRaw.ShipToState),
    zip:     strField(orderRaw.ShipToZip),
    country: strField(orderRaw.ShipToCountry),
    company: strField(orderRaw.ShipToCompany),
  };
  const hasAnyShipTo = Object.values(shipTo).some((v) => v.length > 0);
  const isPickup = !hasAnyShipTo;

  if (isPickup && !strField(hotFolderConfig.pickupLocationId)) {
    throw new RoesValidationError(
      'MISSING_PICKUP_LOCATION',
      'Pickup order detected (no ShipTo address) but no Location ID is configured. Set Location ID under Settings → Polling and retry.',
    );
  }

  if (isPickup) {
    setIfPresent(order, 'pickup_location_id', strField(hotFolderConfig.pickupLocationId));
    // Shipping fields deliberately omitted on pickup — see photo-finale.js
    // for the parallel rationale. shipping_recipient_name is likewise
    // omitted here: a name without an address is not a delivery.
  } else {
    setIfPresent(order, 'shipping_street',  shipTo.street);
    setIfPresent(order, 'shipping_city',    shipTo.city);
    setIfPresent(order, 'shipping_state',   shipTo.state);
    setIfPresent(order, 'shipping_zipcode', shipTo.zip);
    setIfPresent(order, 'shipping_country', shipTo.country);
    setIfPresent(order, 'shipping_company', shipTo.company);
    // shipping_recipient_name — join first + last, drop either side if
    // blank so a first-only or last-only order still surfaces the name
    // it does have. Both blank → the empty result trips setIfPresent's
    // length check and the field is omitted entirely (not sent as ''),
    // matching every other optional string field's convention.
    setIfPresent(order, 'shipping_recipient_name',
      [strField(orderRaw.ShipToFirstName), strField(orderRaw.ShipToLastName)]
        .filter(Boolean).join(' ').trim());
  }

  setIfPresent(order, 'website_code', strField(hotFolderConfig.websiteCode));

  // -------------------------------------------------------------------------
  // Build JobInput[]
  // -------------------------------------------------------------------------

  // ROES emits floats in idOrderLineItem ("1.0", "2.0"). Convert to integer
  // string for cleanliness — OrderHub never sees "1.0".
  const jobs = lineItems.map((li) => {
    const lineId  = String(Math.floor(Number(li.idOrderLineItem)));
    const roCode  = String(li.idProduct).trim();
    const mapping = productMap.get(roCode);
    return {
      job_id:                lineId,
      external_line_item_id: lineId,
      product_code:          mapping.pixfizzCode,
      product_name:          mapping.label,
      quantity:              Math.max(1, Math.floor(Number(li.Quantity))),
      artwork_on_file:       true,
    };
  });

  const summary = {
    externalId:     idOrder,
    customer:       customerName,
    customerEmail,
    total:          computedTotal !== null ? computedTotal : 0,
    productSummary: '',
    lineItemCount:  lineItems.length,
    shippingMethod: '',
    shipToCity:     strField(orderRaw.ShipToCity) || strField(orderRaw.BillToCity) || '',
    shipToState:    strField(orderRaw.ShipToState) || strField(orderRaw.BillToState) || '',
  };

  return { request: { order, jobs }, summary };
}

function strField(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return '';
  return String(v).trim();
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
  RoesParseError,
  RoesValidationError,
};
