# Prompt for Lovable — apply Shipping Methods to XML-imported orders

> **Status:** implemented on the OrderHub side and published 2026-08-19.
> Two decisions changed during review and are worth recording so a future
> reader doesn't reason from this brief alone:
>
> - **No aliases.** The lab names each Shipping Method in OrderHub exactly
>   as the source XML sends it — `Mail`, `Expedited UPS (3 Day)`,
>   `USPS Ground Advantage` — rather than defining an alias list on each
>   method. Anything that arrives without a match shows up in an
>   "Unrecognised shipping names" card so the lab can see what to name.
> - **`total_amount` only touched when OrderHub supplies the cost.** When
>   the XML states a shipping value (including `0`), the XML's amount
>   wins and `total_amount` is left as-is — OHD is responsible for
>   including stated shipping in the ROES total (done in the ROES
>   parser). When the XML states none, OrderHub applies the matched
>   Shipping Method's price AND adds it to the order total at its end.
>   PhotoFinale's total is deliberately never modified either way; see
>   the deliberate-divergence note in `roes.js` and
>   `docs/order-xml-hotfolder.md`.

## Context

OrderHub Desktop is our Windows companion app that sits at the lab. Among
other things it watches hot folders for order XML files, parses them, and
submits the orders to OrderHub via `POST /api-webhook`.

There are two XML formats, both from third-party photo systems:

- **PhotoFinale** — sends a lot of order metadata including shipping
- **ROES** — a leaner format the lab itself defines, so we can ask for fields
  to be added

We've just added **Shipping Methods** in OrderHub, where a lab defines their
methods and the cost of each. I want XML-imported orders to be matched to
those methods and priced accordingly.

## What already works — please don't rebuild it

The shipping method name **already reaches OrderHub today**. Nothing needs
changing in the Desktop app or the API for that part:

- `OrderInput.shipping_method` is already in the API schema (string, "Shipping
  method name").
- The PhotoFinale parser already reads `<ShippingMethod>` and sends it.
- Verified on real data: order **`XML-43229467`** has
  `shipping_method: "Mail"`, which came from
  `<ShippingMethod>Mail</ShippingMethod>` in the source file.

What's missing is the new half. On that same order, `shipping_method_id` is
`null` — nothing links the free-text string to a defined Shipping Method, and
nothing derives a cost from it.

So this is a server-side job. I'm not expecting API changes.

## What I want built

When an order arrives through `/api-webhook` carrying a `shipping_method`
string:

1. **Match it** to one of the organisation's defined Shipping Methods.
2. **Set `shipping_method_id`** on the order.
3. **Apply the cost**, following the rule in the next section exactly.

## The cost rule — please read this bit carefully

The XML states the shipping cost when it has one; OrderHub supplies it when
the XML doesn't.

| Payload | Cost to use |
|---|---|
| `total_shipping` **absent** | the matched Shipping Method's configured cost |
| `total_shipping: 0` | **0** — free shipping is a deliberate statement |
| `total_shipping: 5.95` | 5.95 |

The method is still matched and `shipping_method_id` still set in all three
cases. Only the **cost** defers to the payload.

### The one way this goes wrong

The rule keys on the field being **absent**, not on it being falsy. Our
Desktop app already preserves that distinction deliberately: a blank
`<ShippingTotal></ShippingTotal>` results in the key being omitted from the
JSON entirely, while `<ShippingTotal>0</ShippingTotal>` sends
`total_shipping: 0`.

So please don't write:

```js
if (!order.total_shipping) { applyMethodCost(); }     // WRONG
```

That treats a deliberate `0` as an absence and overwrites free shipping with
the method's cost. It needs to be an explicit absence check:

```js
if (order.total_shipping === undefined) { applyMethodCost(); }
```

This will pass every test written with a non-zero amount and only fail on the
first free-shipping order, which is the worst place to find it.

## Matching — exact string comparison won't work

The names in the XML are the *source system's* names, not ours. Real values
from our sample files:

- `Mail`
- `Expedited UPS (3 Day)`

A lab's Shipping Method is more likely to be called something like `USPS
Ground Advantage`. Those will never match by string equality, or even
case-insensitively.

My preference is **aliases on each Shipping Method** — the lab defines a
method once and lists the inbound names that mean it. That way it's configured
in one place and works for every intake path, not just XML. But I'd like your
view on the right shape before you build it: whether that's a child table, an
array column, or something else that fits how Shipping Methods are already
modelled.

## Two other behaviours I want

**Skip pickup orders.** If the order has a `pickup_location_id`, the customer
is collecting from the lab. Don't attach a shipping cost to it. Our Desktop
app deliberately still sends the method name on pickup orders so the lab UI
can display it, so please gate on the pickup field rather than on the presence
of a method name.

**Don't block an import over an unmatched name.** If the string matches no
Shipping Method, keep today's behaviour: store the raw string in
`shipping_method`, leave `shipping_method_id` null, and let the order import
normally. An unrecognised courier name isn't a good reason to stop a lab
taking orders. Ideally the lab can see somewhere that this happened, so they
know to add an alias — tell me what you'd suggest.

## Questions before you build

1. **Aliases** — what's the right shape given how Shipping Methods are
   currently modelled? Child table, array column, something else?
2. **No cost from either source** — if `total_shipping` is absent *and* no
   method matches, there's no cost available. I think that should just be
   zero, but I'd rather decide it than fall into it. What do you recommend?
3. **Surfacing unmatched names** — where would a lab see that an order came in
   with a shipping method name we didn't recognise? A flag on the order, a
   settings-level list of unmatched names seen recently, something else?
4. **Retrospective matching** — we have existing orders carrying a
   `shipping_method` string and a null `shipping_method_id`. Should adding an
   alias backfill those, or only apply going forward? I'd lean towards going
   forward only, so historical order values don't move under the lab's feet,
   but tell me if you disagree.
5. Is there anything in how Shipping Methods are modelled today that makes any
   of the above awkward? I'd rather hear it now than work around it later.
