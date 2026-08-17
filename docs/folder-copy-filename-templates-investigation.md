# Folder Copy — configurable filenames: available variables

**Status:** investigation, 2026-08-16. Nothing built.
**Ask:** when Folder Copy writes files out, let each controller define a
filename template so the receiving operator can tell from the name alone what
needs doing — quantity, product type, size, finish options and so on.

**Verdict: feasible, and most of the machinery already exists.** A shared
`{token}` resolver is already used by Darkroom Pro photo lines and Fuji
back-print. The real design work is three things the current token set does not
handle: **options**, **size**, and **collisions**.

---

## 1. What Folder Copy does today

`_sendViaFolderCopyRouted` (`print-service.js`) copies each image to
`{outputPath}/{orderNumber}_{jobId}/` keeping **the original basename
unchanged**:

```js
fs.copyFileSync(img.sourcePath, path.join(destFolder, img.filename));
```

There is no naming logic at all — that single line is where a template would
apply.

## 2. The existing token vocabulary

`src/main/services/template-tokens.js` already supports eight tokens, shared
across emitters:

| Token | Source | Notes |
|---|---|---|
| `{customerName}` | `job.customer_name` | full name |
| `{firstName}` | derived | first word |
| `{lastName}` | derived | everything after the first space |
| `{jobId}` | `job.id` | OrderHub numeric job id |
| `{orderNumber}` | `job.order_number` | e.g. `PXDEMO-091YEC` |
| `{jobName}` | `job.job_name` | e.g. `PXDEMO-091YEC-1`, falls back to order number |
| `{filename}` | per-image | current filename with extension |
| `{originalFilename}` | per-image | customer's upload name, index prefix stripped |

Reusing this resolver rather than writing a second one is the obvious call —
one vocabulary, one place to extend, and the Settings UI already has a
click-to-copy token panel driven by `SUPPORTED_TOKENS`.

## 3. Every job field currently available

From `job-service._mapApiJob` — this is the complete set on a job object:

**Identity**
`id`, `order_id`, `internal_job_id`, `internal_order_id`, `order_number`,
`job_name`

**Product**
`process`, `category`, `product`, `product_code`, `quantity`

**Options**
`options` — an **array** of `{ name, value }`, e.g.
`[{name:'finish-options', value:'lustre'}, {name:'layout-options', value:'full-bleed'}]`

**Customer**
`customer_name`, `customer_email`, `website`

**Dates / handling**
`created_at`, `artwork_ready_at`, `due_date`, `date_format`, `is_rush`

**Notes**
`notes`, `order_notes`, `production_notes`

**Artwork**
`artwork_files`, `artwork_source`, `preview_image_url`, `locations`,
`twin_checks`, `is_film_development`

**Per image** (from the order manifest, `jobManifest.images[]`)
`filename`, `quantity`, `originalFilename`

**Route / controller** (folder-copy routes)
`outputPath` / `folderPath` only. Folder Copy has **no channel mapping**, so
none of the print-size or channel fields other controller types carry are
available here.

## 4. Mapping the request to what exists

| Wanted | Available? | How |
|---|---|---|
| **Quantity** | Yes, but read §5 | `job.quantity` or the per-image `quantity` |
| **Product type** | Yes | `job.product` (display name) or `job.product_code` |
| **Product size** | **Not directly** | see §6 |
| **Finish / array options** | Yes, but needs a new token shape | `job.options[]` — see §7 |

Also worth offering, since they cost nothing: `{category}`, `{process}`,
`{dueDate}`, `{isRush}`, `{website}`.

## 5. `quantity` is a trap — pick the right one

`job.quantity` is **not** a reliable print count. Recorded during the
batch-splitting work:

- film jobs — copies *per image*
- manual jobs — total
- Pixfizz jobs — skipped entirely by `recompute_job_quantity_from_artwork`

The **per-image `quantity` in the manifest** is the number the splitter and the
print-count gate both use, and it's the one an operator means by "how many of
this". A `{quantity}` token should resolve to the per-image value, and if a
job-level total is also wanted it needs a separate, differently-named token
with the caveat documented.

Getting this wrong would put a confidently incorrect number in a filename,
which is worse than leaving it out.

## 6. Size is the genuinely missing piece

There is **no size field on a job**. Where size lives today:

- **Inside `product_code`** — e.g. `0406-cut-print` means 4x6, `0507-cut-print`
  means 5x7. That's a Pixfizz convention, not a guarantee, and Wide Format
  codes may not follow it.
- **Inside `product`** — e.g. `4x6" Photo Print`. Human-readable but free text.
- **In a channel mapping** — `printSizeCode` (DPOF) or `sizeTranslations`
  (Darkroom Pro). **Folder Copy has neither.**
- **As an option** — some products may carry size as an option value.

So `{productSize}` cannot be implemented reliably from what exists. Three
options, in order of preference:

1. **Use `{product}`** and accept the size is embedded in the product name.
   Zero work, no new failure mode.
2. **Add a size-translation table to Folder Copy controllers**, like Darkroom
   Pro's — product code → size string. Explicit, operator-controlled, and
   reuses a pattern that already exists.
3. Parse the size out of `product_code`. **Do not do this** — it bakes a
   Pixfizz naming convention into OHD, and it will silently produce wrong
   filenames the first time a product code doesn't follow it.

**This is the main thing to decide before building.**

## 7. Options need a new token shape

Options are a list, not fixed fields, and they vary per product. So a fixed
token can't work — it needs a lookup:

```
{option:finish-options}      → lustre
{option:layout-options}      → full-bleed
```

Plus, probably, `{options}` for "all option values joined", which is what the
hot-folder names already do (`..._lustre_full-bleed`).

Decisions needed: what happens when the named option is absent — blank, or the
literal token left in place? Blank is consistent with every other token, and
the existing "empty resolves to empty" rule.

## 8. Collisions — the thing that will bite

A job with 20 images and a template of
`{quantity}_{product}_{option:finish-options}` produces **the same filename
twenty times**. `copyFileSync` will overwrite silently, and nineteen images
vanish with no error.

Non-negotiable requirements:

- An index token — `{index}` (1, 2, 3…) and probably `{indexPadded}` (001, 002)
- **Refuse to overwrite.** If a resolved name already exists in the destination,
  either fail the job loudly or auto-suffix — never clobber. The FTP-sources
  mover made the same decision for the same reason.
- Extension always preserved from the source; a template must not be able to
  produce `photo.jpg.png` or drop the extension entirely.

## 9. Filesystem safety

Product names and option values are free text and will contain characters
Windows rejects (`\ / : * ? " < > |`). `printUtils.buildFolderName` already has
an `UNSAFE_CHARS` strip — reuse it rather than writing a second one. Also
needs: length cap (Windows path limit), no trailing dots or spaces, and a
guard against a template resolving to an empty string.

## 10. Suggested shape

- Per-controller **Filename template** field on Folder Copy controllers, blank
  = keep the original name (so nothing changes for anyone who doesn't set one).
- Reuse `resolveTemplate`, extended with `{option:name}`, `{index}`,
  `{quantity}`, `{product}`, `{productCode}`, `{category}`.
- A **live preview** in Settings showing the template resolved against a real
  recent job — the single highest-value control here, because the operator will
  otherwise discover their mistake in the destination folder.
- Never overwrite; strip unsafe characters; always keep the extension.

## 11. Decisions needed before a brief

1. **Size** — `{product}` as-is, or a size-translation table on the controller?
2. **Quantity** — per-image (recommended) or job-level? Both, with distinct names?
3. **Collision behaviour** — fail the job, or auto-suffix `_2`, `_3`?
4. **Does this apply to Default Folder / Process Folder routes too**, or only
   named Folder Copy controllers? They share `_sendViaFolderCopyRouted`.
