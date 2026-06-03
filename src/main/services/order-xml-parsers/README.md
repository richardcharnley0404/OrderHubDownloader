# Order XML parsers

This directory holds parser modules for the Order XML hot folder feature.
Each parser converts a vendor-specific order XML into the OrderHub
`POST /api-webhook` request shape (`SubmitOrderRequest` in
`docs/orderhub/openapi.json`).

The registry in `index.js` is the only place new formats need to be wired in;
the watcher, settings UI dropdown, and ingestion store all read from it.

## When to add a parser

When a customer needs OHD to ingest a new XML order format that isn't
PhotoFinale — e.g. ROES, dotphoto, a bespoke lab format. Each hot folder
configured in settings is bound to exactly one `sourceFormat`; that's the
parser id this registry exposes.

## Contract

Every parser module must export the following:

```js
module.exports = {
  // Stable identifier used in settings.orderXmlHotFolders[].sourceFormat.
  // Lowercase, alphanumeric, no spaces. Once shipped, never rename.
  id: 'photofinale',

  // Human-readable label shown in the settings UI dropdown.
  label: 'PhotoFinale (Trevoli OrderDataSet)',

  // Quick reject sniff. Receives the first ~512 bytes of file content.
  // Used by the registry's detect() helper to spot misconfigured hot folders
  // (e.g. ROES XML dropped into a folder configured for PhotoFinale).
  matches(xmlSnippet: string): boolean,

  // Pure parse + map. No fs, no network, no config side effects.
  // Receives the full XML string and the hot folder config so it can pull
  // per-folder values like websiteCode.
  parse(xmlString: string, hotFolderConfig: object): {
    request: { order: object, jobs: object[] },  // body for POST /api-webhook
    summary: {                                    // ingestion record fields
      externalId:     string,
      customer:       string,
      customerEmail:  string,
      total:          number,
      productSummary: string,
      lineItemCount:  number,
      shippingMethod: string,
      shipToCity:     string,
      shipToState:    string,
    },
  },
};
```

### Error contract

Parsers should throw two distinct error types so the watcher can route them
correctly:

| Error class                  | Meaning                                  | Watcher routing                    |
|------------------------------|------------------------------------------|------------------------------------|
| `*ParseError`                | XML is malformed or truncated            | Requeue with backoff (transient)   |
| `*ValidationError`           | XML parses but fails business validation | Move to `failed/` immediately      |

Both should set a stable `code` property (e.g. `PARSE_ERROR`,
`MISSING_EXTERNAL_ID`, `DELETED_PRODUCT`) so the ingestion-store record and
the panel can group failures by reason.

## What the parser must NOT do

- **Do not inject `organization_id`.** Auth is global, not per-folder; the
  OrderHub API client (`orderhub-api-client.js`) injects the API key just
  before submission.
- **Do not call `fs`, `https`, or `electron`.** The parser is unit-tested in
  isolation. Anything that touches the filesystem belongs in the watcher.
- **Do not mutate `hotFolderConfig`.** Treat it as read-only.

## Testing

Each parser ships with a sibling test file at
`src/main/services/__tests__/order-xml-parsers-<id>.test.js` covering:

1. Identity / sniff (`id`, `label`, `matches()`).
2. Happy path against ≥3 real fixtures stored in
   `__tests__/fixtures/order-xml/<id>/`. Use real customer XMLs where
   possible — synthesised samples drift from production over time.
3. Every error code (`code: 'PARSE_ERROR'`, `code: 'MISSING_*'`, etc.).
4. Edge cases specific to the format (e.g. PhotoFinale's
   `(product deleted:NNN)` markers).

## Reference implementation

`./photo-finale.js` — covers all of the above and is the pattern to copy
when adding a second parser.
