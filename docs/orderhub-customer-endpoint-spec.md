# OrderHub API — customer lookup / create endpoint

**Status:** partly resolved server-side, 2026-08-18. The customer-linking
gap that motivated this brief was fixed on the OrderHub side and verified —
see §2.1 for what was wrong and how it was verified. The only live ask that
remains is §4.1 (`GET /customers/lookup`) for the PhotoFinale Settings
save-time validation described in §3.2, and Richard has parked that with
the client for now — it is not pending on the OrderHub team.
**Driver:** two OHD XML-import requirements that could not be met with the
API as it stood before 2026-08-18.

- **ROES orders** — when the order's billing email doesn't correspond to an
  existing customer, a customer should be created from the `BillTo*` block.
  (Now handled server-side by the webhook — §2.1.)
- **PhotoFinale orders** — the per-retailer Customers directory in OHD Settings
  maps `<RetailerDealerCode>` to a Customer Name + Email. That email should be
  validated against a real OrderHub customer, rather than being trusted.
  (Still open; parked.)

---

## 1. Why this can't be done today

`src/main/services/orderhub-api-client.js` speaks to exactly two endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api-webhook` | submit an order + its jobs |
| `POST /update-order-status` | set an order's status |

`docs/orderhub/openapi.json` (OrderHub API 1.0.0) confirms the full surface is
`/api-webhook`, `/get-new-jobs`, `/update-job-status`, `/update-order-status`.
**There is no customer lookup and no customer create.** OHD therefore cannot
answer "does this customer exist?" before submitting an order, and has no way
to create one.

## 2. What the webhook appears to do already — needs confirming

This is the single most important thing to establish before building anything,
because it may narrow the work substantially.

Observed, not documented:

- `OrderInput` requires `customer_name` and `customer_email`, and accepts an
  optional `customer_phone`. It has **no** `customer_id` field.
- Orders created through the XML path come back with `customer_id` populated
  (e.g. order `XML-RO068727` → `customer_id a89631f3-9d20-4e60-a47a-28edc923f220`).
- The MCP `list_customers` tool describes itself as listing "unique customers
  who have placed orders", and returns nothing for an email that has never
  appeared on an order.

Read together, that suggests **the webhook already resolves-or-creates a
customer from `customer_email` within the organization**. If so, the ROES
requirement ("create a customer if the email doesn't exist") may already be
satisfied implicitly, and what's actually missing is:

1. a way to **look up** a customer before submitting (PhotoFinale validation),
   and
2. whether the implicitly-created customer carries the **address and phone**
   from the order, or only name + email.

**Question for the OrderHub side, to answer before designing anything:**

> On `POST /api-webhook`, what happens to `customer_email` today? Is an
> existing customer matched within the organization, and is a new one created
> when there's no match? What fields does a newly-created customer receive —
> and if a customer already exists, are any of its fields updated from the
> order?

The answers decide whether §4 needs one endpoint or two.

### 2.1 Evidence from a live test — the webhook is NOT linking customers

> **RESOLVED (2026-08-18, server-side).** The webhook was leaving
> `customer_id` null on incoming XML orders where the derived
> `customer_name` was a literal `-` (the honest transform of a ROES
> `BillTo*` block whose `BillToFirstName` is `-` and `BillToLastName` is
> empty). That `-` name appeared to block linking, rather than the
> webhook falling back to matching on `customer_email` as the documented
> behaviour would have. Fix applied server-side on 2026-08-18 and
> back-filled against the affected order.
>
> **Verification.** `XML-ROES068876` — the order captured in the table
> below — now shows `customer_id c22c7976-0c67-4b49-b50e-3d5f084fde88`
> and `customer_name "Richard Charnley"` (was `null` and `"-"`),
> back-filled at 09:26 on 2026-08-18. The webhook now links or creates
> from `customer_email` as originally expected, so the ROES ask ("create
> a customer if the email doesn't exist") is satisfied implicitly by the
> webhook; §4.2 (`POST /customers`) is no longer needed.
>
> Investigation kept below because it is the reason the fix happened.

**Read this before building anything in §4.** A ROES order imported on
2026-08-18 into the Pixfizz demo org shows the following:

| | |
|---|---|
| Order | `XML-ROES068876` (`0a6467ab-6215-4e89-a774-785d09745e4c`) |
| `customer_email` | `richard_charnley@pixfizz.com` |
| `customer_id` | **`null`** |

That email is not a new customer. `list_customers` returns it as an existing
record with **695 orders** against it, name "Richard Charnley", phone
07900682680. So the webhook did not create a customer *and did not link the
existing one* — it left `customer_id` empty on an order whose email matches a
customer the organization has been trading with for hundreds of orders.

It is also inconsistent. `XML-RO068727`, imported through the same parser on
2026-05-14, has `customer_id a89631f3-9d20-4e60-a47a-28edc923f220` populated.
Same code path, different outcome, three months apart.

**This reframes the requirement.** The original ask was "create a customer when
the email doesn't exist". The evidence says matching doesn't happen even when
it *does* exist. Two possibilities, and they lead to very different work:

1. **A regression or a gap in the webhook's customer resolution.** Then the fix
   is server-side and small, and §4.2 (`POST /customers`) may not be needed at
   all — orders would carry a correct `customer_id` again and OHD would need
   nothing beyond §4.1 for the PhotoFinale validation.
2. **Customer linking was never a webhook responsibility** and the May order got
   its `customer_id` some other way. Then §4 stands as written.

**Establish which before designing.** Building create-and-lookup endpoints on
top of a webhook that has stopped linking customers would paper over the
problem and leave OHD doing work the server should be doing.

## 3. What OHD needs, in behaviour terms

### 3.1 ROES (issue 3)

At import time, before submitting the order, OHD has the `BillTo*` block:

```xml
<BillToFirstName>-</BillToFirstName>
<BillToLastName/>
<BillToCompany/>
<BillToAddress/>
<BillToCity>louisville</BillToCity>
<BillToState>KY</BillToState>
<BillToZip>40059</BillToZip>
<BillToCountry/>
<BillToPhone>1234567890</BillToPhone>
<BillToEmail>cs@irisproimaging.com</BillToEmail>
```

It needs to guarantee a customer exists for `cs@irisproimaging.com`, carrying
whatever of the above is populated.

Note the data quality in this real sample: `BillToFirstName` is a literal
hyphen and `BillToLastName` is empty, so the derived customer name is `-`.
Whatever is built should not treat that as a reason to fail — but it is worth
knowing that a customer called `-` is the honest result of this input, and if
the lab is complaining about wrong customer names, this is a candidate.

### 3.2 PhotoFinale (issue 4)

PhotoFinale orders carry `<RetailerDealerCode>`; OHD Settings holds a directory
mapping each code to a Customer Name + Email, and those replace the cardholder
details on the submitted order. `photo-finale.js:226` already rejects an order
whose code has no directory row, so **local** validation exists.

What's missing is confirming the configured email corresponds to a real
OrderHub customer. Two moments matter, and the first is the valuable one:

- **At save time in Settings** — when the operator adds or edits a row, tell
  them immediately if that email isn't a customer. A typo caught here costs
  seconds; caught at import it costs a failed order and a support call.
- **At import time** — a cheaper backstop, since the directory could have been
  edited in OrderHub since.

## 4. Proposed endpoints

Both org-scoped by the API key, same `Authorization: Bearer <key>` as the rest
of the API. Additive; nothing existing changes.

### 4.1 `GET /customers/lookup?email=<email>`

The one OHD genuinely cannot live without.

```
200 { "success": true, "found": true,
      "customer": { "id": "uuid", "name": "...", "email": "...",
                    "phone": "...", "city": "...", "state": "...",
                    "zipcode": "...", "country": "...", "company": "..." } }

200 { "success": true, "found": false }
```

- `found: false` is a **200, not a 404** — "no such customer" is a normal
  answer to a lookup, not an error, and OHD's HTTP layer treats non-2xx as a
  transport failure to retry.
- Match on email, case-insensitive, trimmed, scoped to the organization.
- If several customers share an email within an org, return the one the
  webhook would pick, and say in the docs which that is. Silent ambiguity here
  becomes a wrong-customer bug later.

### 4.2 `POST /customers` — create-or-return

Only needed if §2's answer is that the webhook does **not** already create
customers.

```
POST /customers
{ "email": "cs@irisproimaging.com", "name": "-", "phone": "1234567890",
  "company": "", "street": "", "city": "louisville", "state": "KY",
  "zipcode": "40059", "country": "" }

200 { "success": true, "created": true|false, "customer": { ... } }
```

Required semantics:

- **Idempotent on (organization_id, email).** OHD retries imports; a retry must
  not produce a second customer. `created` tells the caller which happened.
- **Never overwrite an existing customer's fields.** If the email already
  exists, return it untouched. A customer's name is shared across their whole
  order history, and letting one import rewrite it would silently rename a
  customer on every past order. If enriching blank fields is wanted, make it an
  explicit opt-in flag, not the default.
- Only `email` is required. Everything else optional — the ROES sample proves
  most of the address block is routinely empty.

## 5. Also worth fixing while the API is open

**`shipping_recipient_name` is not in the OpenAPI spec.** `OrderInput`
documents `shipping_company`, `shipping_street`, `shipping_city`,
`shipping_state`, `shipping_zipcode`, `shipping_country` — but not
`shipping_recipient_name`. Both OHD XML parsers have been sending it since
commit `d35b571` (2026-08-13), and the OrderHub column reportedly exists as of
2026-08-05.

So one of these is true, and they need different fixes:

1. The spec is simply stale → document the field.
2. The webhook validates or whitelists against this schema → the field is being
   **silently dropped**, which would explain a lab reporting a missing shipping
   name on a build that already has the OHD-side fix.

**Cheap decisive test, no code required:** submit a ROES XML with a populated
`<ShipToFirstName>` *and* a shipping address (an address is required — a
name-only order is classified as pickup and the recipient name is omitted by
design, `roes.js:343`). Then read the created order's
`shipping_recipient_name`. Null means the field is being dropped server-side.

## 6. OHD-side work, once the endpoints exist

Small, and deliberately listed after the server work — none of it can be built
or tested first.

1. `orderhub-api-client.js` — add `lookupCustomer({ apiKey, email })` and, if
   built, `createCustomer(...)`. Same error-classification posture as
   `submitOrder`: return a result object, don't throw on transport failure.
2. **ROES parser / watch service** — resolve-or-create before submit. Decide
   deliberately what happens when the lookup itself fails (network down): our
   options are hold the file in `failed/` for retry, or submit anyway and let
   the webhook do what it does today. Submitting anyway is the lower-risk
   default, because a lookup outage should not stop a lab importing orders.
3. **PhotoFinale Customers directory** — save-time validation in Settings with
   a clear message naming the email that didn't match, plus the import-time
   backstop.
4. Tests for each: found, not-found, transport failure, and the retry case that
   proves no duplicate customer is created.

## 7. Open questions, collected

1. ~~What does `/api-webhook` do with `customer_email` today — match, create,
   update?~~ **Answered 2026-08-18** — the webhook resolves-or-creates from
   `customer_email` within the organization (see §2.1 RESOLVED note). §4.2
   `POST /customers` is no longer needed.
2. Is `shipping_recipient_name` accepted and stored, or dropped? (§5.)
3. On PhotoFinale validation failure at import, should the order fail into
   `failed/` as it does now for an unknown `RetailerDealerCode`, or submit with
   the configured details anyway and flag it?
4. ~~Should a customer created from a ROES `BillTo` block carry the address, or
   only name/email/phone?~~ **Answered 2026-08-18** — the webhook handles
   customer creation server-side, so the field set is whatever the webhook
   populates from the order it received. Not an OHD-side decision.

**Live ask:** §4.1 (`GET /customers/lookup`) for the PhotoFinale Settings
save-time validation described in §3.2. **Parked with the client** rather
than pending with the OrderHub team.
