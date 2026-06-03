# Order XML Hot Folder (Mode 4)

OrderHub Downloader watches one or more local folders for vendor order XML
drops and submits them to OrderHub via `POST /api-webhook`. Two source
formats ship today — PhotoFinale's Trevoli `OrderDataSet` and ROES (Pixfizz
XML). The parser layer is a registry, so adding dotphoto or any other XML
format is a one-file change.

This doc is the operator-facing reference. Code lives under
`src/main/services/order-xml-*` and `src/main/services/order-xml-parsers/`.

## At a glance

```
┌──────────────────┐   chokidar      ┌──────────────────┐    POST           ┌─────────────┐
│ <watch folder>/  │  ─────────────► │ OrderXmlWatch    │  ───────────────► │  OrderHub   │
│  43192748.xml    │   add event     │  Service         │  /api-webhook     │             │
└──────────────────┘                 └──────────────────┘                   └─────────────┘
                                              │
                                              │   move on success
                                              ▼
                                     <processedFolder>/<MMDDYYYY>/43192748.xml
                                     <processedFolder>/failed/<MMDDYYYY>/43192748.xml
                                                                         + 43192748.xml.error.json
```

## What the lab needs to know

- Drop a vendor XML in the configured watch folder. OHD picks it up within
  about two seconds (chokidar polling interval).
- On success, the file moves to `<processedFolder>/<MMDDYYYY>/`. The order
  appears in OrderHub.
- On failure, the file moves to `<processedFolder>/failed/<MMDDYYYY>/` with
  a `.error.json` sidecar that records the reason. The XML stays put until
  the operator removes or retries it.
- The Order XML tab in OHD shows every ingestion (success, duplicate,
  failure) for the last 30 days, with a Retry action on failed rows.

## Setup

1. Open OHD → **Settings** → **Order XML**.
2. Toggle **Enable Order XML Hot Folders**.
3. Click **+ Add Hot Folder** and fill in:
   - **Name** — operator-chosen label (e.g. "PhotoFinale F-11").
   - **Source format** — sourced from the parser registry. PhotoFinale is
     the only entry shipping today.
   - **Website code** — OrderHub's `website_code` (e.g. `PPPF`). Optional;
     leave blank if your lab doesn't use it.
   - **Max retries** — per-folder override for transient (5xx / network)
     failures. Blank inherits the global default below.
   - **Watch folder** — where the vendor drops XML files. OHD only watches
     the immediate folder, not subfolders.
   - **Processed folder** — root for `processed/` and `failed/`. Must be
     a different path from the watch folder, and the two must not be nested
     inside each other (would create a loop).
4. **Save Settings**. Validation runs at save time — duplicate watch folders
   across enabled hot folders, unknown source formats, and the nesting rule
   above all surface as a banner error.

The master sync timer (default 1 minute) drains the submit-retry queue and
prunes the ingestion store. File arrivals are detected immediately by
chokidar — the timer is only for retries and bookkeeping.

## What gets sent

PhotoFinale → OrderHub field mapping (see
`src/main/services/order-xml-parsers/photo-finale.js` for the canonical
implementation).

| OrderHub field        | XML source                                                  |
|-----------------------|-------------------------------------------------------------|
| `organization_id`     | `orderhubApiKey` setting (also sent as the `X-API-Key` header) |
| `order_number`        | `Order/ExternalId`                                          |
| `external_order_id`   | `Order/ExternalId`                                          |
| `external_source`     | `"PhotoFinale"` (constant)                                  |
| `customer_name`       | `Order/CustomerFirstName` + `' '` + `Order/CustomerLastName` |
| `customer_email`      | `Order/CustomerEmail`                                       |
| `customer_phone`      | `Order/CustomerPhone`                                       |
| `total_amount`        | `Order/Total`                                               |
| `total_tax`           | `Order/Tax`                                                 |
| `total_shipping`      | `Order/ShippingTotal`                                       |
| `total_discount`      | `Order/Discount`                                            |
| `paid`                | hardcoded `true`                                            |
| `notes`               | `Order/SpecialInstructions` (omitted if empty)              |
| `shipping_method`     | `Order/ShippingMethod`                                      |
| `shipping_street`     | `Order/ShipToAddress`                                       |
| `shipping_city`       | `Order/ShipToCity`                                          |
| `shipping_state`      | `Order/ShipToState`                                         |
| `shipping_zipcode`    | `Order/ShipToZip`                                           |
| `shipping_country`    | `Order/ShipToCountry`                                       |
| `shipping_company`    | `Order/ShipToCompany` (omitted if empty)                    |
| `website_code`        | per-hot-folder setting                                      |

Per `OrderLineItem`:

| Job field               | XML source                                                   |
|-------------------------|--------------------------------------------------------------|
| `job_id`                | `idOrderLineItem`                                            |
| `external_line_item_id` | `idOrderLineItem`                                            |
| `product_code`          | resolved via Product Mappings table → Pixfizz code (see below) |
| `product_name`          | resolved via Product Mappings table → label                  |
| `quantity`              | `Quantity`                                                   |
| `artwork_on_file`       | hardcoded `true`                                             |

### Product Mappings (Mode 4 — added 2026-05-08)

OrderHub today accepts any string as `product_code` and creates a generic
line item — without a mapping, vendor codes flow through unlinked from real
Pixfizz products. **OHD's product-mapping gate closes this hole.**

The mapping is per-format (PhotoFinale today, ROES / dotphoto when those
parsers ship). Each entry is a 1:1 pair:

```
{ photoFinaleCode, pixfizzCode, label }
```

- **photoFinaleCode** — the vendor's `idSourceProduct` (e.g. `1082252`).
- **pixfizzCode** — the Pixfizz product code, sent as `product_code`.
- **label** — sent as `product_name` (defaults to `pixfizzCode` if blank).

Operators manage the table at **Settings → Order XML → Product Mappings**.

**Hold-whole-order behaviour:** if any line item in an order references a
vendor code that isn't in the table, the order is held with
`errorCode: UNMAPPED_PRODUCTS` and `errorDetails.unmappedCodes: [...]`. No
partial submission. Reactive workflow:

1. Operator sees a failed row in the Order XML panel with the
   "Add Mapping" action.
2. Click it — settings opens with draft rows pre-seeded for every unmapped
   code from this order.
3. Operator types the Pixfizz code + label, saves.
4. Click **Retry** on the panel row. The watcher re-parses with the updated
   map and submits cleanly.

**Validation at save time:** duplicate `photoFinaleCode` within a format is
rejected with a clear error pointing at the conflicting rows. Empty rows
(missing either code) are silently dropped — operators can save half-typed
drafts without losing them.

### ROES (Pixfizz XML) field mapping

ROES is a much thinner format than PhotoFinale — most fields below either
have no equivalent in ROES (and are omitted from the OrderHub submission)
or live in `BillTo*`. See
`src/main/services/order-xml-parsers/roes.js` for the canonical code.

| OrderHub field          | XML source                                                   |
|-------------------------|--------------------------------------------------------------|
| `organization_id`       | `orderhubApiKey` setting (also sent as the `X-API-Key` header) |
| `order_number`          | `"XML-" + Order/idOrder` (e.g. `XML-RO068713`)               |
| `external_order_id`     | `Order/idOrder`                                              |
| `external_source`       | `"ROES"` (constant)                                          |
| `customer_name`         | `Order/BillToFirstName` + `' '` + `Order/BillToLastName`, trimmed |
| `customer_email`        | `Order/BillToEmail`                                          |
| `customer_phone`        | `Order/BillToPhone`                                          |
| `paid`                  | driven by `Order/PaymentStatus`: `"paid"` (case-insensitive) → `true`, anything else (including missing) → `false` |
| `total_amount`          | computed sum of (`Quantity` × `UnitPrice`) across all line items, rounded to 2 dp. Omitted entirely when no line item carries `UnitPrice` |
| `notes`                 | `Order/SpecialInstructions` (omitted if empty)               |
| `shipping_*`            | `Order/ShipTo*` — only emitted if at least one ShipTo field is non-empty. Does NOT fall back to BillTo (per Richard 2026-05-13). |
| `website_code`          | per-hot-folder setting                                       |

Per `OrderLineItem`:

| Job field               | XML source                                                   |
|-------------------------|--------------------------------------------------------------|
| `job_id`                | `idOrderLineItem` floored to integer string (e.g. `"1.0"` → `"1"`) |
| `external_line_item_id` | same as `job_id`                                             |
| `product_code`          | resolved via Product Mappings → Pixfizz code (ROES has its own slice keyed by `idProduct`, e.g. `SP0710`) |
| `product_name`          | mapping label                                                |
| `quantity`              | `Quantity`                                                   |
| `artwork_on_file`       | `true`                                                       |

Notably *not* sent (because ROES doesn't have them): `total_tax`,
`total_shipping`, `total_discount`, `shipping_method`, `payment_gateway`,
`payment_reference`. (`PaymentMethod` from the XML is intentionally **not**
forwarded as `payment_gateway` — same decision as PhotoFinale 2026-05-08.)

### Deliberately omitted

- **Payment fields** (`payment_gateway`, `payment_reference`) — these orders
  are settled upstream by PhotoFinale; OrderHub only needs `paid: true`.
- **Artwork** (`artwork_url`) — out of scope for this lab. OrderHub does not
  pull JPGs through OHD. If the lab ever needs uploads, this is new work.
- **Per-line options** (`Finish`, `Border`, `Crop*`) — kept out of the API
  call to avoid sending values OrderHub would have to interpret. The
  product `idSourceProduct` already encodes the relevant size / finish.

## Idempotency

The `order_number` field doubles as the de-dup key. OrderHub returns
`409 Duplicate order` if the same `order_number` is submitted twice; OHD
treats that as a success (the file moves to `processed/` and the panel row
shows `duplicate` rather than `failed`).

For PhotoFinale this is `Order/ExternalId` — globally unique across the
PhotoFinale tenant and identical to the filename, which means re-dropping
the same file (deliberately or by accident) is safe.

## File layout after processing

```
<watchFolder>/                         (incoming drop point)

<processedFolder>/
  05082026/                            (MMDDYYYY of ingestion date)
    43192748.xml                       (success or duplicate)
    43207384.xml
  failed/
    05082026/
      43229467.xml                     (rejected — see sidecar for reason)
      43229467.xml.error.json
```

The date subfolder convention matches the existing Film Scans / File Uploads
modes. Filename collisions (rare — would only happen if the operator
manually re-drops a file with the same name on the same day) get a `_1`,
`_2`, ... suffix.

`.error.json` sidecar shape:

```json
{
  "errorCode": "DELETED_PRODUCT",
  "errorMessage": "Order references a deleted PhotoFinale product",
  "attempts": 1,
  "failedAt": "2026-05-08T10:32:14.872Z",
  "originalFile": "43229467.xml"
}
```

## Retry model

Two distinct retry channels.

### Parse-error retry (truncated XML)

Triggered when chokidar fires `add` before the upstream finishes writing the
file (rare with atomic-write upstreams; common with naive copy-then-flush).

- 5 attempts at 1 s, 2 s, 4 s, 8 s, 16 s.
- All managed in-process via `setTimeout`, not the polling tick.
- Persistent failure → `failed/` with `errorCode: "PARSE_ERROR"`.

### Submit-error retry (transient 5xx / network)

Triggered when the OrderHub API returns 5xx, the request times out, or the
network is unavailable.

- Up to `maxRetries` attempts (per-folder override; default 3).
- Spaced by the master sync timer (default 1 minute) so we don't hammer the
  endpoint during a real outage.
- Persistent failure → `failed/` with `errorCode: "SERVER_ERROR"` or
  `"NETWORK_ERROR"` and the upstream message preserved in the sidecar.

### Hard failures (no retry)

- `400 / 422 Validation error` from OrderHub → `failed/` with
  `errorCode: "VALIDATION_ERROR"`. The XML is wrong; retrying won't help.
- `401 / 403` → `failed/` with `errorCode: "AUTH_ERROR"`. Operator must
  fix the API key in Settings → Connection.
- Local validation failures (missing email, missing ExternalId, deleted
  product, etc.) → `failed/` with the specific `errorCode`. See
  `photo-finale.js` for the full list.

## The Order XML tab

Every ingestion attempt produces one record in the in-app history.

- **Filters**: status (All / Submitted / Duplicates / Failed) and per-hot-
  folder.
- **Search**: matches customer name, email, order number, or filename.
- **Sortable columns**: Status, Time, Filename, Total.
- **Row actions**:
  - `Copy #` — copies the order number to the clipboard.
  - `Retry` (failed rows only) — moves the XML back to its watch folder so
    the watcher re-runs the pipeline. The old failed record is removed; a
    fresh one is written when the new attempt completes.
  - `Processed Folder` / `Failed Folder` — opens the row's file location in
    the OS file manager.
- **Retention**: 30 days. Older records are pruned on every sync tick.
  The `Clear` button wipes the entire history (does **not** touch files in
  `processed/` or `failed/`).

The panel auto-refreshes every 5 seconds while it's the active tab.

## Adding a new XML format (e.g. dotphoto)

ROES was added this way on 2026-05-13 — `roes.js` plus one line in
`index.js` plus a test fixture-pair plus a doc update. The settings UI
dropdown picked it up automatically.


1. Add a parser file under `src/main/services/order-xml-parsers/`. Use
   `photo-finale.js` as the template; the contract is documented in that
   directory's `README.md`. The parser must export `id`, `label`, `matches`,
   and `parse`.
2. Add one line in `src/main/services/order-xml-parsers/index.js`:
   ```js
   const roes = require('./roes');
   const PARSERS = Object.freeze({
     [photoFinale.id]: photoFinale,
     [roes.id]:        roes,
   });
   ```
3. Drop sample fixtures in
   `src/main/services/__tests__/fixtures/order-xml/<id>/` and write a test
   file `order-xml-parsers-<id>.test.js`. At minimum: happy path on every
   fixture plus every `code` your validation throws.
4. The Settings UI dropdown picks up the new parser automatically via
   `orderXml:listParserFormats`. No renderer changes required.

The parser is *pure* — no fs, no network, no electron. Anything that
touches the filesystem belongs in the watcher.

## Troubleshooting

| Symptom                                                    | Likely cause                                                                                                  |
|------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| "Order XML hot folder #N requires a label"                 | Card has no name. Type one in the **Name** field.                                                             |
| "watch folder and processed folder must not be nested"     | One of the two paths is inside the other. Pick paths on different branches.                                   |
| "watch folder ... is already used by ..."                  | Two enabled hot folders share a watch folder. Either disable one or change paths.                             |
| "unknown source format"                                    | Source format name doesn't match any registered parser. Re-pick from the dropdown.                            |
| Card doesn't appear in the OS picker / drop folder unseen  | The watch folder doesn't exist yet, or OHD doesn't have permission. Check the path; create the folder.        |
| File sits in watch folder, never moves                     | Mode 4 master toggle off, or polling-service isn't running. Look at Activity Log: "Order XML timer started"?  |
| Every drop ends up in `failed/` with `AUTH_ERROR`          | API key invalid or revoked. Settings → Connection → re-enter and Save.                                        |
| Every drop ends up in `failed/` with `VALIDATION_ERROR`    | Field-level mismatch. Open the `.error.json` sidecar — `validation_errors` lists the specific fields.         |
| Drops fail with `UNMAPPED_PRODUCTS`                        | Vendor code(s) not in the Product Mappings table. Click "Add Mapping" on the panel row, fill in Pixfizz code + label, Save Settings, click Retry. |
| "vendor code X appears in row N and row M"                 | Two rows in Product Mappings share the same `photoFinaleCode`. Each vendor code must map to exactly one Pixfizz product. |
| Submitted in OHD panel but not in OrderHub                 | Look at the order number in OrderHub's UI. If duplicate (409) it'd show as `duplicate` in OHD, not submitted. |
| Retry button does nothing                                  | Hot folder removed from settings, or the failed XML was deleted from `failed/`. Sidecar will show the cause.  |

## Code map

```
src/main/services/
  order-xml-parsers/
    index.js                       parser registry (get / has / list / detect)
    photo-finale.js                Trevoli OrderDataSet → SubmitOrderRequest
    README.md                      parser-author contract
  orderhub-api-client.js           POST /api-webhook + classification
  order-xml-watch-service.js       chokidar + per-file lifecycle + retry queues
  order-xml-ingestion-store.js     30-day record store
  order-xml-ipc-helpers.js         pure-fn IPC handler bodies (testable)
  config-service.js                schema + getEnabledHotFolders + sanitiser
  polling-service.js               registers the orderXml independent timer

src/main/
  ipc-handlers.js                  orderXml:* IPC bridges

src/preload/preload.js             window.electronAPI.orderXml*

src/renderer/
  renderer.js                      Settings hot folder list editor + Order XML panel
  index.html                       Settings sub-tab + Order XML tab markup
  styles.css                       .orderxml-* styles (reuses --app-* tokens)

docs/orderhub/openapi.json         OrderHub API spec (reference)
docs/order-xml-hotfolder.md        this file
```

Tests in `src/main/services/__tests__/` covering parser, registry, API client,
watcher, ingestion store, IPC helpers, and config-service additions
(91 tests total). All run under `npm test`.
