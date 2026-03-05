# Darkroom Pro — Order File Format Specification

**Controller type identifier**: `darkroompro`

> **Source**: Darkroom Pro "Order File Processing Spec Generic.pdf" (Eugene Wise, Jan 2021)
> Reference link: https://workdrive.zohoexternal.com/external/6OolXaIKMgx-JtDtd
>
> Supplemented by confirmed line item examples provided during OHD integration design (2026-02-21).

---

## Overview

Darkroom Pro uses a completely different integration mechanism from DPOF controllers (Noritsu, Epson). Instead of a structured folder with a protocol file, Darkroom Pro watches a hot folder for plain-text **order files** (`.TXT`). Each order file contains:

- **Order-level header fields** (customer name, email, extension fields) — appear **once** at the top
- **Per-image line item blocks** — one or more images, each with `Qty`, `Size`, `Media`, `Filepath`
- An optional **Index print** trigger

**Key differences from DPOF:**

| Aspect | DPOF (Noritsu/Epson) | Darkroom Pro |
|--------|---------------------|--------------|
| File format | Structured `[HDR]` / `[JOB]` sections | Flat `Key=Value` plain text |
| File per job | One folder with `DPOF.001` inside | One `.TXT` file dropped into watch folder |
| Images | Copied into `IMAGES/` subfolder | Referenced by **absolute path** — not copied |
| Channel/paper routing | Channel number (`PRT PCH`) | `Media=` field (paper/media type name) |
| Template/border | Via vendor section | Via `Template=` field (path to `.crd` file) |
| Status: accepted | Controller renames folder prefix `o→e` | `.TXT` file **moved** to `processed` subfolder |
| Status: failed | Controller renames folder prefix `o→q` | `.TXT` renamed in-place to `.err` |

---

## File Naming Convention

```
Order{orderNumber}.TXT
```

Examples:
- `Order1000.TXT`
- `Order100456.TXT`

> Note: the extension is uppercase `.TXT`. Confirm whether Darkroom Pro is case-sensitive on this — use uppercase to be safe.

---

## File Structure

The file has **two sections**:

1. **Order header** — customer and order metadata, written once at the top
2. **Image line items** — one block per image, listed sequentially

```
Order1000.TXT
─────────────────────────────────────
[Order-level header fields]
[Optional: Index=1]
─────────────────────────────────────
[Image 1 fields]
[Image 2 fields]
[Image 3 fields]
...
```

---

## Order Header Fields

These fields appear **once**, at the top of the file, before any image line items.

```
OrderFirstName=Johnny
OrderLastName=Appleseed
OrderEmail=Johnny@appleseed.com
ExtCabin=123
ExtFolio=111111
```

| Field | Example | Source in OHD | Description |
|-------|---------|---------------|-------------|
| `OrderFirstName` | `Johnny` | `job.customer_name` (split) | Customer first name |
| `OrderLastName` | `Appleseed` | `job.customer_name` (split) | Customer last name |
| `OrderEmail` | `Johnny@appleseed.com` | `job.customer_email` | Customer email address |
| `Ext*` fields | `ExtCabin=123` | Job options / custom fields | Extension fields — arbitrary key/value pairs prefixed with `Ext`. Used for cruise ship cabins, folio numbers, student IDs etc. These appear on the index print and can be printed on borders. |

> **OHD mapping note**: `OrderFirstName`/`OrderLastName` should be split from `job.customer_name` on the first space. If no space is present, put the whole value in `OrderFirstName` and leave `OrderLastName` empty (or omit it). `Ext*` fields map from the job's custom option fields — these will need to be configurable per controller in OHD settings.

---

## Index Print

```
Index=1
```

When `Index=1` is present in the header section, Darkroom Pro generates an **index print** — a thumbnail sheet showing all images in the order, along with the order header data fields (`OrderFirstName`, `OrderLastName`, `OrderEmail`, and all `Ext*` fields).

| Value | Meaning |
|-------|---------|
| `Index=1` | Generate one index print |
| `Index=0` or absent | No index print |

> Whether to include `Index=1` will be a per-controller configuration option in OHD (some labs always want an index; others never do).

---

## Image Line Item Fields

Each image is represented by a block of fields. **Fields are sticky** — a field value carries forward to the next image unless explicitly overridden. This means you only need to repeat a field when its value changes.

```
Index=1
Qty=2
Size=8x10
Media=Luster
Filepath=\\imageserver\folder1\folder2\img_0001.jpg
Qty=1
Filepath=\\imageserver\folder1\folder2\img_0002.jpg
Size=5x7
Filepath=\\imageserver\folder1\folder2\img_0003.jpg
```

### What "sticky" means in practice

| Field | img_0001 | img_0002 | img_0003 |
|-------|----------|----------|----------|
| `Qty` | `2` (explicit) | `1` (explicit reset) | `1` (inherited) |
| `Size` | `8x10` (explicit) | `8x10` (inherited) | `5x7` (explicit override) |
| `Media` | `Luster` (explicit) | `Luster` (inherited) | `Luster` (inherited) |
| `Filepath` | `img_0001.jpg` | `img_0002.jpg` | `img_0003.jpg` |

> `Filepath` always triggers a new image — each new `Filepath=` line starts processing a new image using the current accumulated field values.

### Field reference

| Field | Example | Source in OHD | Required | Description |
|-------|---------|---------------|----------|-------------|
| `Qty` | `2` | `manifest.images[].quantity` | Yes (first image; then only when changing) | Number of copies to print. Defaults to `1` if not set. Must be reset explicitly when it changes. |
| `Size` | `8x10` | `manifest.images[].size` | Yes (first image; then only when changing) | Print size. Must match a valid Darkroom Pro media size string. Carries forward until overridden. |
| `Media` | `Luster` | **Channel config** `mediaName` | Yes (first image; then only when changing) | Paper/media type name as configured in Darkroom Pro. This is the primary channel selector — routes the job to the correct printer and paper roll. `Media=` and `Template=` are **not mutually exclusive** — both can appear together. |
| `Template` | `X:\Templates\Borders\sports\golf_8x10.crd` | **Job option** (e.g. "Border" option) mapped via channel config | Optional | Absolute Windows path to a `.crd` border/template file. **Driven by an OrderHub job option** (e.g. a "Border" or "Template" product option chosen at order time) — not purely from channel config. The channel config may store the template path or a directory to resolve from. Omit entirely for plain prints. Can coexist with `Media=`. |
| `Tmp.Name` | `Megan Brown` | `job.customer_name` | Required when `Template=` is present | Customer name to be printed within the border/template. Always written alongside `Template=`. Omit when no template is in use. |
| `Filepath` | `\\server\share\img.jpg` | Constructed from download dir | Yes | **Absolute** Windows path (local or UNC) to the source image. Each `Filepath=` line marks the start of a new image using all currently active field values. |

---

## Complete Annotated Examples

### Example 1: Plain prints, no border (3 images, mixed sizes)

```
Order1000.TXT

OrderFirstName=Johnny                    ← Customer first name
OrderLastName=Appleseed                  ← Customer last name
OrderEmail=Johnny@appleseed.com          ← Customer email
ExtCabin=123                             ← Custom ext field: cruise cabin number
ExtFolio=111111                          ← Custom ext field: cruise folio number
Index=1                                  ← Print 1 index/thumbnail sheet

Qty=2                                    ┐
Size=8x10                                │ Image 1: 2 copies, 8x10, Luster, plain
Media=Luster                             │
Filepath=\\imageserver\folder1\folder2\img_0001.jpg  ┘

Qty=1                                    ┐ Image 2: 1 copy — Size & Media inherited
Filepath=\\imageserver\folder1\folder2\img_0002.jpg  ┘ → 1× 8x10 Luster, plain

Size=5x7                                 ┐ Image 3: Size overridden; Qty & Media inherited
Filepath=\\imageserver\folder1\folder2\img_0003.jpg  ┘ → 1× 5x7 Luster, plain
```

**Result:**
- 2× 8x10 Luster prints of `img_0001.jpg`
- 1× 8x10 Luster print of `img_0002.jpg`
- 1× 5x7 Luster print of `img_0003.jpg`
- 1× Index print: 3 thumbnails with FirstName=Johnny, LastName=Appleseed, Email=..., Cabin=123, Folio=111111

---

### Example 2: Bordered print using a Template (job option present)

When a customer orders a product with a border option (e.g. "Sports – Golf Magazine"), OHD includes `Template=` and `Tmp.Name=` alongside the existing `Media=` and `Size=` fields. Both `Media=` and `Template=` coexist in the same line item.

```
Order2001.TXT

OrderFirstName=Megan
OrderLastName=Brown
OrderEmail=megan@example.com
Index=0

Qty=1
Size=8x10
Media=Luster
Template=X:\Templates\Borders\sample borders\sports\golfmagazine_8x10.crd
Tmp.Name=Megan Brown
Filepath=X:\Sample Data\20020415\ed_0005\sport3.jpg
```

**Result:**
- 1× 8x10 Luster print of `sport3.jpg` with the golf magazine border overlay applied, "Megan Brown" printed within the border template
- No index print (Index=0)

---

## How OHD Generates the Order File

### OHD field mapping summary

| Order file field | OHD source | Notes |
|-----------------|-----------|-------|
| Filename | `Order{job.order_number}.TXT` | Uppercase `.TXT` |
| `OrderFirstName` | First word of `job.customer_name` | Split on first space |
| `OrderLastName` | Remainder of `job.customer_name` | Everything after first space |
| `OrderEmail` | `job.customer_email` | From OrderHub API |
| `Ext*` fields | **Configurable mapping** — job options or custom fields | `Ext*` field names are not fixed. Each installation defines its own field names (e.g. `ExtCabin`, `ExtFolio`, `ExtStudentId`). OHD must allow the admin to configure a mapping: OH job option name → `Ext*` field name → value. See [Ext* Field Mapping](#ext-field-mapping) below. |
| `Index` | Controller config `indexPrint` | `0` or `1`, set by admin per controller |
| `Qty` | `manifest.images[].quantity` | Written when value changes from previous image |
| `Size` | `manifest.images[].size` | Written when value changes from previous image |
| `Media` | **Channel config** `mediaName` | Looked up by matching channel size; written when changes |
| `Template` | **Job option** resolved via channel/controller config | Written only when the job has a border/template option. Source is an OH job option value (e.g. option name "Border", value "Sports – Golf"). OHD maps this to an absolute `.crd` path. See [Template Mapping](#template-mapping) below. |
| `Tmp.Name` | `job.customer_name` | Written whenever `Template=` is written — always accompanies a template line |
| `Filepath` | Constructed absolute path | `{downloadDirectory}\{orderNum}_{orderId}\{orderNum}_{jobId}\{filename}` |

### Sticky field optimisation

OHD should track the last-written value for `Qty`, `Size`, `Media`, `Template`, and `Tmp.Name`, and only emit the field line when the value changes. This keeps the file clean and matches the Darkroom Pro spec's intended compact format.

### Channel matching

For Darkroom Pro controllers, channel matching works the same way as DPOF — match by `size` (and optionally `finish`) — but the channel provides `mediaName` instead of `channelNumber`.

### Template mapping

`Template=` is not a fixed channel property — it is driven by a **job option** present on the OrderHub job (e.g. a "Border" option with a value like `"Sports – Golf Magazine"`). The admin must configure a lookup table in OHD that maps:

```
OH option name  →  OH option value  →  Absolute .crd path
"Border"           "Sports – Golf"     X:\Templates\Borders\sports\golf_8x10.crd
"Border"           "Plain White"       X:\Templates\Borders\plain_white.crd
```

This lookup table is per-controller (since the `.crd` path is local to the Darkroom Pro machine). If no matching template is found for a job's option value, `Template=` and `Tmp.Name=` are omitted and the image prints plain.

### Ext* field mapping

`Ext*` field names vary per Darkroom Pro installation and have no standard names. The admin must configure a mapping in OHD per controller:

```
OH option/field name  →  Ext* key name
"Cabin Number"            ExtCabin
"Folio"                   ExtFolio
"Student ID"              ExtStudentId
```

At file generation time, OHD iterates the job's options/custom fields, checks each against the configured mapping, and writes matching `Ext*` lines into the order header. Fields with no mapping are silently ignored.

---

## Channel Configuration (OHD) for Darkroom Pro

| Channel field | Example | Description |
|--------------|---------|-------------|
| `size` | `8x10` | Matches against manifest image size |
| `finish` | `Gloss` / `Luster` / `Matt` | Optional — for disambiguating multiple channels of the same size |
| `mediaName` | `Luster` | The `Media=` value written to the order file — must match Darkroom Pro's configured media name **exactly** (case-sensitive) |
| `isActive` | `true` | Whether this channel is available for matching |

> `channelNumber` and `printStyleCode` are **not used** for Darkroom Pro controllers.

> `Template=` paths are **not** stored on the channel — they are stored in a separate template lookup table on the **controller**, keyed by OH option name + value. This is because a single channel (size/media combination) can produce either a plain print or any number of different bordered prints depending on the job option chosen by the customer.

## Controller-Level Configuration for Darkroom Pro

In addition to standard controller fields, Darkroom Pro controllers have:

| Controller field | Example | Description |
|-----------------|---------|-------------|
| `type` | `darkroompro` | Controller type identifier |
| `indexPrint` | `true` / `false` | Whether to include `Index=1` in every order file |
| `processedFolderName` | `processed` | Name of the subfolder Darkroom Pro moves accepted `.TXT` files into (confirm from DP installation) |
| `templateMappings` | `[...]` | Array of `{ optionName, optionValue, templatePath }` objects — maps OH job option values to `.crd` file paths |
| `extFieldMappings` | `[...]` | Array of `{ sourceField, extKeyName }` objects — maps OH option/custom field names to `Ext*` key names |

### templateMappings schema

```js
templateMappings: [
  {
    optionName: 'Border',                           // OH job option name
    optionValue: 'Sports – Golf Magazine',          // OH job option value
    templatePath: 'X:\\Templates\\Borders\\sports\\golfmagazine_8x10.crd'  // .crd path
  },
  {
    optionName: 'Border',
    optionValue: 'Plain White',
    templatePath: 'X:\\Templates\\Borders\\plain_white.crd'
  }
]
```

### extFieldMappings schema

```js
extFieldMappings: [
  { sourceField: 'Cabin Number', extKeyName: 'ExtCabin' },
  { sourceField: 'Folio',        extKeyName: 'ExtFolio' },
  { sourceField: 'Student ID',   extKeyName: 'ExtStudentId' }
]
```

---

## Hot Folder Structure

No subfolder structure is required. OHD writes a single `.TXT` file:

```
C:\DarkroomPro\HotFolder\          ← Watch folder (configured in OHD)
├── Order1000.TXT                  ← Written by OHD (status: submitted)
│
└── processed\                     ← Managed by Darkroom Pro
    └── Order1000.TXT              ← Moved here on success (status: accepted)
```

On failure:
```
C:\DarkroomPro\HotFolder\
└── Order1000.err                  ← Renamed in-place (status: failed)
```

> Images are **not copied** to the hot folder. Darkroom Pro reads them directly from the `Filepath=` absolute path.

---

## Status Detection Mechanism

| Status | What happens | How OHD detects it |
|--------|-------------|-------------------|
| `submitted` | OHD writes `Order{n}.TXT` to watch folder | n/a — OHD set this itself |
| `accepted` | Darkroom Pro **moves** `.TXT` to `processed/` subfolder | `fs.watch` detects file disappearing from watch folder root |
| `failed` | Darkroom Pro **renames** `.TXT` → `.err` in watch folder root | `fs.watch` detects new `.err` file appearing with same base name |

```
Event timeline:

  OHD writes:   Order1000.TXT  ─────────────────────────── (submitted)
                      │
         ┌────────────┴────────────┐
         │                         │
  DP accepts:                  DP rejects:
  Order1000.TXT                Order1000.TXT
  moved to                     renamed to
  processed/Order1000.TXT      Order1000.err
         │                         │
  fs.watch: .TXT                fs.watch: .err
  disappears from root          appears → failed
  → accepted
```

### Monitor implementation notes

`DarkroomProMonitor` must watch for **two distinct events** in the watch folder:

1. **File removal event** — a tracked `.TXT` filename no longer exists → `accepted`
2. **New `.err` file event** — a `.err` file appears matching a tracked `.TXT` base name → `failed`

This differs from the DPOF `FolderMonitor` which watches for folder **prefix renames**. A dedicated `DarkroomProMonitor` service is required.

---

## Implementation Plan for OHD

### New services required

| Service | Analogous to | Purpose |
|---------|-------------|---------|
| `DarkroomProGenerator` | `dpof-generator.js` | Generates `.TXT` order file content with sticky field logic |
| `DarkroomProFileWriter` | `order-folder-writer.js` | Writes `Order{n}.TXT` to watch folder (no image copy needed) |
| `DarkroomProMonitor` | `folder-monitor.js` | Watches for `.TXT` removal (accepted) or `.err` appearance (failed) |

### Schema additions

Add to **channel** schema in `PrintControllerStore` (Darkroom Pro channels):
```js
{
  // existing fields (unchanged):
  size: '8x10',
  finish: 'Luster',
  isActive: true,

  // Darkroom Pro specific (replaces channelNumber + printStyleCode):
  mediaName: 'Luster'    // Media= value — routes to correct printer/paper roll
  // NOTE: templatePath is NOT on the channel — it lives on the controller
  //       via templateMappings, keyed by OH option name+value
}
```

Add to **controller** schema:
```js
{
  type: 'darkroompro',
  indexPrint: false,                    // Include Index=1 in every order file
  processedFolderName: 'processed',    // Subfolder DP moves accepted files to
  templateMappings: [                  // Maps OH option values → .crd paths
    {
      optionName: 'Border',
      optionValue: 'Sports – Golf Magazine',
      templatePath: 'X:\\Templates\\Borders\\sports\\golfmagazine_8x10.crd'
    }
  ],
  extFieldMappings: [                  // Maps OH option/field names → Ext* keys
    { sourceField: 'Cabin Number', extKeyName: 'ExtCabin' },
    { sourceField: 'Folio',        extKeyName: 'ExtFolio' }
  ]
}
```

### Routing update

`PrintService._sendViaDPOF()` → needs to branch on `controller.type`:
- `noritsu` / `epson` → existing DPOF pipeline
- `darkroompro` → new Darkroom Pro pipeline

Or rename the method to `_sendViaPrintController()` and handle type routing within it.

---

## Outstanding Questions

| # | Question | Status | Impact |
|---|----------|--------|--------|
| 1 | Is the `processed` subfolder name always `processed`, or is it configurable in Darkroom Pro settings? | ❓ Open | Affects `DarkroomProMonitor` and controller config `processedFolderName` field |
| 2 | Are `Ext*` field names defined per installation? (Assumed yes — confirmed by `ExtCabin`/`ExtFolio` pattern) | ✅ Confirmed — they are arbitrary external fields needing a configurable mapping in OHD | Affects `extFieldMappings` UI design |
| 3 | Is `Index=1` always in the header section, or can it vary per job? | ❓ Open | Assumed header-level, per-controller flag in OHD |
| 4 | If no template matches for a job option, is `Template=` omitted silently, or must `Template=` always be present? | ❓ Open | Omitting assumed safe for plain prints |
| 5 | Can `Filepath=` be a UNC path (`\\server\share\...`)? | ✅ Confirmed YES — shown in Darkroom Pro spec example | No action needed |
| 6 | Is the file extension `.TXT` (uppercase) required, or is `.txt` also accepted? | ❓ Open | Use uppercase `.TXT` to be safe |
| 7 | What is the default `Qty` if omitted for an image with no prior `Qty=` line? | ❓ Open | Assumed `1` — always write `Qty=` for first image to be explicit |
| 8 | Can `Template=` and `Media=` coexist in the same line item? | ✅ Confirmed YES — both can appear together. `Media=` routes to printer/paper; `Template=` adds border overlay on top. | Channel config does NOT store templatePath; template lookup is controller-level via `templateMappings` |

---

## Comparison: Darkroom Pro vs DPOF at a Glance

```
DPOF (Noritsu/Epson)                 Darkroom Pro
────────────────────                 ─────────────────────────────────────────────
Folder per job                       Single .TXT file per job (Order{n}.TXT)
Images copied to IMAGES/ subfolder   Images at absolute/UNC paths — NOT copied
[HDR] + [JOB] sections               Flat Key=Value; sticky field inheritance
Channel = physical paper roll #      Channel = Media= name string
Border/overlay                       Template= (.crd path) — driven by OH job option,
                                       coexists with Media=, not mutually exclusive
Vendor metadata in DPOF header       No vendor metadata
Status: folder prefix rename         Status: .TXT moved to processed/ (accepted)
                                              OR renamed to .err (failed)
One [JOB] per image (always full)    Fields only written when they change (sticky)
No customer data in DPOF             Order header: name, email, configurable Ext* fields
No index print                       Optional index print (Index=1, per-controller flag)
Template config on channel           Template config on controller (templateMappings lookup)
```
