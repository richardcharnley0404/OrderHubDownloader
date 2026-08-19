# XML import — shipping methods

**Status:** investigation, 2026-08-19. Nothing built.
**Ask:** recognise `<ShippingMethod>` on XML import, pass it to OrderHub, and
have OrderHub apply the matching Shipping Method and its cost.

**Verdict: the OHD half is nearly done already.** The work is almost entirely
OrderHub-side, plus one small ROES parser change. The API probably needs
nothing. There is one decision with money attached (§4.2) that should be made
before anyone writes code.

---

## 1. What already works, end to end

PhotoFinale already reads the tag and already sends it. Proven with real data:

| | |
|---|---|
| Sample XML | `docs/OrderXML Hotfolder/43229467.xml` → `<ShippingMethod>Mail</ShippingMethod>` |
| Parser | `photo-finale.js:426` — `setIfPresent(order, 'shipping_method', strField(orderRaw.ShippingMethod))` |
| API schema | `OrderInput.shipping_method` (string, "Shipping method name") — already in `docs/orderhub/openapi.json` |
| Order in OrderHub | `XML-43229467` → `shipping_method: "Mail"` |

So the string reaches OrderHub today and is stored. What is *not* happening is
the new part: that order has `shipping_method_id: null`. Nothing links the
free-text string to a defined Shipping Method, and nothing derives a cost
from it.

Other real values seen in the sample files: `Expedited UPS (3 Day)`. Note
neither of these looks like `USPS Ground Advantage` — see §4.1.

## 2. What ROES does — nothing ~~(before 2026-08-19)~~

~~`roes.js:16` lists `ShippingMethod` under **"Notably absent"** from ROES files,
alongside Total/Tax/Shipping/Discount. The parser never looks for the element.~~

**Both built 2026-08-19.** The tag names and their positions
(`<ShippingMethod>` and `<ShippingTotal>` inside `<Order>`, same as
PhotoFinale) were specified by Richard — the lab defines the ROES
schema. No sample-first requirement in the end: the ROES parser now
calls

```js
setIfPresent(order, 'shipping_method',   strField(orderRaw.ShippingMethod));
setIfPresent(order, 'total_shipping',    numField(orderRaw.ShippingTotal));
```

OUTSIDE the pickup/shipping branch, mirroring `photo-finale.js:426`
and `photo-finale.js:418` exactly. Docstring updated to remove both
fields from the "notably absent" list. Tests cover the full matrix for
each (populated, absent, whitespace-only, non-numeric-for-total, and —
the one someone will later try to "fix" by moving inside the else —
pickup order still carrying the label). The `<ShippingTotal>` addition
was deferred from the earlier ShippingMethod change because it
interacts with §4.2 (cost precedence) and needed Richard's confirmation
that ROES should be able to state its own shipping cost. That
confirmation came 2026-08-19 after the real-world verification of
XML-ROES068883: `<ShippingTotal>5</ShippingTotal>` in the XML,
`shipping_amount 12` on the OrderHub side because the tag was never
read and OrderHub correctly fell back to the matched method's price.
The gap was ours; this closes it.

**Load-bearing implementation detail.** ROES now uses the same
`numField` helper PhotoFinale does — byte-identical to
`photo-finale.js#numField`, copied into `roes.js`. The blank-vs-zero
distinction (§4.2) is preserved by the pairing of numField's
`v === '' → null` guard with setIfPresent's "finite number wins,
null skips" contract. A hand-rolled `Number(x) || 0` here would
collapse blank into 0 and silently defeat the rule for ROES only —
the hardest kind of inconsistency to find, because PhotoFinale would
keep behaving correctly. Docstring on ROES's `numField` calls this
out.

## 3. Where `shipping_amount` comes from today

Separate field, separate source, and it matters for §4.2.

PhotoFinale sends `total_shipping` from `<ShippingTotal>`
(`photo-finale.js:406`). On order `XML-43229467` that produced
`shipping_amount: 5.95`, matching `<ShippingTotal>5.9500</ShippingTotal>` in
the XML.

ROES sends both as of 2026-08-19 — see §2. `<ShippingTotal>` is read
via `numField` + `setIfPresent`, so blank / absent → key omitted (let
OrderHub apply the method price), `0` → sent as `0`
(free-shipping, method price NOT used), positive → sent verbatim.
Same rule as PhotoFinale.

So today: **both parsers supply the cost when the XML has one, and let
OrderHub apply the matched method's price when it doesn't.**

## 4. The design questions

### 4.1 Name matching will mostly fail on exact comparison

The strings the XML actually emits are the *source system's* names, not the
lab's:

| Source emits | A lab's Shipping Method might be called |
|---|---|
| `Mail` | `USPS Ground Advantage` |
| `Expedited UPS (3 Day)` | `UPS 3 Day Select` |

An exact (or even case-insensitive) string match between those two columns
will not land. Something has to map one to the other. Two places it could
live:

1. **OrderHub — aliases on each Shipping Method.** The lab defines a method
   once and lists the inbound names that mean it. Every intake path benefits
   — XML, API, POS, anything future.
2. **OHD — a per-hot-folder mapping table.** There is direct precedent: the
   ROES parser already takes a `productMap` threaded through
   `hotFolderConfig` (`roes.js:229`, `config-service.js:1428`), configured in
   Settings, which maps ROES product codes to Pixfizz codes.

**Recommend (1).** The mapping is a property of the lab's shipping setup, not
of one hot folder, and doing it OHD-side means rebuilding it for every future
intake path. The precedent in (2) exists but solves a different problem —
product codes genuinely differ per hot folder; shipping methods don't.

### 4.2 Cost precedence — decide this first, it involves money

PhotoFinale already sends a shipping amount. If OrderHub now also applies the
matched Shipping Method's cost, **two numbers claim the same field** and one
silently wins.

- The XML's `<ShippingTotal>` is what the customer was actually charged
  upstream.
- The Shipping Method's configured cost is what the lab wants to charge.

Overwriting either without a stated rule is a money bug — either the lab
under-recovers, or the customer's order shows a figure they never paid.

**DECIDED 2026-08-19 (Richard).** The XML states the cost when it has one;
OrderHub supplies it when the XML doesn't:

| XML | Cost used |
|---|---|
| `<ShippingTotal></ShippingTotal>` (blank or absent) | the matched Shipping Method's configured cost |
| `<ShippingTotal>0</ShippingTotal>` | **0** — free shipping is a statement, not an absence |
| `<ShippingTotal>5.9500</ShippingTotal>` | 5.95 |

The method is still matched and `shipping_method_id` still set in every case —
only the *cost* defers to the XML.

### 4.2.1 How this reaches OrderHub — and the one way it breaks

OrderHub never sees the XML, only the JSON payload. The rule must therefore be
expressed as **field absence**, not as a falsy check.

The existing parser helpers already preserve the distinction, so no OHD change
is needed for PhotoFinale:

| XML | `numField()` | payload |
|---|---|---|
| `<ShippingTotal></ShippingTotal>` | `null` | key **omitted entirely** |
| `<ShippingTotal>0</ShippingTotal>` | `0` | `total_shipping: 0` |
| `<ShippingTotal>5.9500</ShippingTotal>` | `5.95` | `total_shipping: 5.95` |

`numField` (`photo-finale.js:523`) maps `''` to `null`; `setIfPresent`
(`:530`) writes any finite number — including `0` — and skips `null`.

**The trap.** An implementation of the form

```js
if (!order.total_shipping) { applyMethodCost(); }     // WRONG
```

treats a deliberate `0` as an absence and overwrites free shipping with the
method's cost. It must be an explicit absence check:

```js
if (order.total_shipping === undefined) { applyMethodCost(); }
```

This will pass every test written with a non-zero amount and fail on the first
free-shipping order, which is the worst possible place to find it.

### 4.2.2 ROES work item that followed from this — DONE 2026-08-19

~~ROES currently parses no shipping money fields at all.~~ ROES now
reads `<ShippingTotal>` via the same `numField` + `setIfPresent` pair
PhotoFinale uses (both parsers hold byte-identical copies of the
helper — see §2). Blank-vs-zero survives. The `Number(x) || 0` trap
this section warned about was avoided by copying PhotoFinale's helper
verbatim rather than hand-rolling; docstring on `roes.js#numField`
calls out the "do NOT swap for Number(x) || 0" rule so a later reader
sees the reasoning before touching it.

### 4.3 No-match behaviour

When the inbound string matches no Shipping Method, three options:

1. Reject the order. There is precedent — the ROES parser rejects unknown
   product codes outright.
2. Import, store the raw string in `shipping_method` as it does today, leave
   `shipping_method_id` null.
3. Import and flag for attention.

**Recommend (2) plus visibility.** A product code is load-bearing — the wrong
one prints the wrong thing. A shipping name is not, and blocking a lab's
order intake over an unrecognised courier name is disproportionate. Today's
behaviour is already (2); it just needs the operator to be able to see it, so
they know to add the alias.

### 4.4 Pickup orders

`shipping_method` is currently sent regardless of pickup/ship — the comment at
`photo-finale.js:423` calls it "informational regardless", so the lab UI can
show "Pickup" verbatim. If OrderHub starts attaching a *cost* to the method,
applying it to a pickup order would charge shipping on a collection. Whatever
matching runs server-side should skip orders with a `pickup_location_id`.

## 5. Work split

**OrderHub — the bulk.**
- Match the inbound `shipping_method` string to a defined Shipping Method.
- Alias support per §4.1.
- Set `shipping_method_id` on the order.
- Apply cost per the rule agreed in §4.2.
- Skip matching on pickup orders (§4.4).
- No-match behaviour per §4.3.

**API — probably nothing.** `shipping_method` is already in `OrderInput` and
already arrives. A change is only needed if OHD is expected to send a
`shipping_method_id` or validate against the lab's list — and that would
require a lookup endpoint, the same shape as the customer-lookup ask in
`docs/orderhub-customer-endpoint-spec.md`. Matching server-side avoids that
entirely and is the simpler design.

**OHD — small.**
- ~~ROES parser reads `<ShippingMethod>` and sends it (§2), once a real sample
  confirms the element exists.~~ **Done 2026-08-19** — no sample-first
  requirement; tag name specified by Richard. See §2.
- Nothing needed for PhotoFinale.
- Nothing needed if matching happens server-side.

## 6. Open questions

1. ~~Which format does `<ShippingMethod>USPS Ground Advantage</ShippingMethod>`
   come from — ROES or PhotoFinale? The ROES parser says ROES doesn't emit it,
   and the sample file confirms that. A real file with the tag settles it.~~
   **Answered 2026-08-19** — the tag is expected on BOTH formats; ROES
   support built alongside the existing PhotoFinale reader.
2. ~~§4.2 — does an XML-supplied shipping amount win, or the Shipping Method's
   configured cost?~~ **Answered 2026-08-19** — see §4.2.
3. §4.1 — aliases in OrderHub, or a mapping table in OHD Settings?
4. Should the lab see, somewhere, that an order arrived with an unmatched
   shipping method name?
5. What happens when `total_shipping` is absent AND no Shipping Method
   matches? There is then no cost from either source. Zero, or hold the order?
   Zero is the quiet answer and probably right, but it should be stated rather
   than fallen into.
6. Is the lab adding `<ShipOrder>` to the ROES schema? PhotoFinale carries the
   element but the parser ignores it — pickup is inferred from
   `ShipToAddress == RetailerStreet` (`photo-finale.js:344`), and ROES infers
   it from an all-empty `ShipTo`. Both are guesses. An explicit flag would be
   authoritative for the one format the lab controls, with today's rule as the
   fallback when it's absent — and `ShipOrder=true` with no address should be
   rejected rather than silently filed as a pickup.
