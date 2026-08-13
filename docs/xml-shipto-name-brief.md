# XML import — ShipTo recipient name not reaching OrderHub

**Status:** diagnosis + fix brief, 2026-08-10. Nothing built.
**Reported:** ShipTo FirstName / LastName / Company not passed, or passed
incorrectly, on Order XML hot-folder imports.

---

## Root cause

**Both XML parsers deliberately omit `ShipToFirstName` / `ShipToLastName`, for a
reason that is no longer true.**

`src/main/services/order-xml-parsers/roes.js:307-311` states it outright:

> *"ShipToFirstName / ShipToLastName are intentionally NOT in the shipTo object
> — a recipient name without an address is not a delivery address (**OrderInput
> has no first/last recipient field anyway; the addressed-to name is
> customer_name**)."*

That was correct when written (Richard's decision, 2026-05-13). It stopped being
correct when OrderHub gained a recipient field, and nobody revisited the parsers.

**OrderHub is ready and waiting:**

| Layer | Status |
|---|---|
| `orders.shipping_recipient_name` | **exists** (text, nullable) |
| `api-webhook` `OrderData` interface | **declares** `shipping_recipient_name?: string` |
| `api-webhook` insert | **writes** `shipping_recipient_name: order.shipping_recipient_name \|\| null` |
| OHD `photo-finale.js` | **never sets it** — `ShipToFirstName`/`LastName` are read nowhere |
| OHD `roes.js` | **never sets it** — explicitly excluded, see above |

Result: the column is accepted end-to-end and is always `null` for XML orders.
Across the whole database only 30 of 56,228 orders carry a recipient name (those
come from other ingest paths), against 374 XML orders — none of which can have
one.

## Company is a different story — probably not a bug

Both parsers **do** send `shipping_company` from `<ShipToCompany>`
(`photo-finale.js:427`, `roes.js:318`), and the webhook accepts it. 9,482 orders
in the database carry one, so the path works.

In **all three** sample files `<ShipToCompany>` is empty. There is nothing to
pass. If the lab expects to see "ETSY", that is `<BillToCompany>` — billing, not
shipping. **Confirm with the client which they mean before changing anything**;
mapping a billing company into a shipping field would be wrong.

## The bigger problem on the two Etsy orders

`order_4141229168.xml` and `order_4141030858.xml` contain **no `Customer*`
elements at all** — only `BillTo*` and `ShipTo*`.

- `roes.js` sets `customer_name` from `BillToFirstName + BillToLastName` → on
  these files that is **"Etsy"**.
- `photo-finale.js` would instead throw `MISSING_CUSTOMER_NAME` on these files
  (no `CustomerFirstName`), so they must be going through the ROES parser.
  **Worth confirming which `sourceFormat` that hot folder is set to** — the
  parser is chosen by hot-folder config, not sniffed
  (`order-xml-parsers/index.js`).

So on those orders OrderHub currently records the customer as **"Etsy"** and the
actual recipient — Julie Johnson, Corina Bardwell — **appears nowhere at all**.
That is almost certainly what the lab is actually complaining about.

The third file (`43978161.xml`) is a full Photo Finale export where
`CustomerFirstName/LastName` = `ShipToFirstName/LastName` = "Rebecca Spear", so
the recipient happens to match the customer and the bug is invisible. That is
why it only shows up on marketplace orders.

---

## Fix

**F1 — `photo-finale.js`.** In the shipping branch (the `else` of the pickup
check, ~`:421-428`), add:

```js
setIfPresent(order, 'shipping_recipient_name',
  [strField(orderRaw.ShipToFirstName), strField(orderRaw.ShipToLastName)]
    .filter(Boolean).join(' ').trim());
```

**F2 — `roes.js`.** Same, in the branch that emits the `shipTo` fields.

**Keep the existing rule that a name alone is not a delivery address.** Both
parsers treat an all-empty `ShipTo` as pickup; the recipient name must **not**
count toward `hasAnyShipTo`, or a name-only order would flip from pickup to
shipping. Recipient name rides along *only* when there is a real address.

**F3 — update both stale comments**, including the parenthetical in
`roes.js:310` that asserts OrderInput has no recipient field. Leaving it there
guarantees someone re-derives the old conclusion.

**F4 — do not touch `shipping_company`.** It already works.

**F5 — tests.** Both parsers have fixture-driven suites
(`order-xml-parsers-photo-finale.test.js`, `-roes.test.js`) and fixtures under
`src/main/services/__tests__/fixtures/order-xml/`. Add the two Etsy files as
fixtures. Cover: first+last present; first only; last only; both empty →
field omitted entirely (not empty string); pickup order → field absent;
name-present-but-no-address → still pickup.

---

## The OrderHub side is already done — and this is why it stalled

Lovable plan `editable-shipping-company-recipient-name-xml-ohd-orders-2026-08-05.md`
in the pixfizz-oms project describes this exact problem, *including* the symptom
that the delivery address on these orders reads "Etsy". It shipped on 5 August:

- `api-webhook` accepts and persists `shipping_recipient_name`
- The Delivery Address editor has a **Ship-to name** field
- Read-only display order is **ship-to name → customer name → company → address**
- The **shipping label builder already prefers `shipping_recipient_name` over
  `customer_name`**; `to_address.company` comes from `shipping_company`
- `{shipping_recipient_name}` / `{shipping_company}` are PDF Layout Studio
  tokens, so packing slips pick them up
- Editing either field re-triggers PDF ticket regeneration

**No OrderHub-side work is needed.** The field is stored, displayed, editable,
printed and sent to the carrier.

That plan closes with an open question addressed to Richard:

> *"If OrderHub Desktop's XML actually puts the business name in a specific
> element (e.g. an Etsy shop name) and the human recipient elsewhere, tell me
> which element maps to which… otherwise the API just exposes both fields and
> OHD decides."*

**It was never answered.** OrderHub shipped its half, handed the mapping
decision back to OHD, and the OHD half was never written. That is the whole
reason this is still broken.

The answer, decided 2026-08-10:

| XML element | OrderHub field |
|---|---|
| `ShipToFirstName` + `ShipToLastName` | `shipping_recipient_name` |
| `ShipToCompany` | `shipping_company` (already mapped — no change) |

## `customer_name` stays as it is — decided 2026-08-10

**Do not overwrite `customer_name` with the ShipTo name.** Because OrderHub
already displays `shipping_recipient_name` in preference to `customer_name` and
already uses it on carrier labels, populating the recipient field alone makes
the delivery address and the label read "Julie Johnson" without touching the
customer.

Leaving `customer_name` as "Etsy" is also more accurate — Etsy *is* the paying
party, and it tells the lab the order arrived via the marketplace. Overwriting
it would lose that and would change behaviour for every existing XML lab, not
just this one.
