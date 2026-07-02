# Fuji JobMaker — Order File Format Specification

**Controller type identifier**: `fujijobmaker`

> **Source**: Fujifilm "JobMaker API Technical Reference Manual", First Edition — MS01 Software Version 3.1, 31 March 2011 (`docs/Fuji Jobmaker/jobmaker_v3.1_api_technical_reference_manual.pdf`).
>
> Supplemented by a confirmed Pixfizz production example (`docs/Fuji Jobmaker/BALLY-Q7F39E_Lustre.txt`) and OHD integration decisions captured during the 2026-05-07 design session with Richard.

---

## Overview

Fuji JobMaker is the order ingest interface for Fujifilm Frontier Workflow Management Software (MS01). Like Darkroom Pro it watches a hot folder for plain-text order files (`.txt`) and reads referenced images by absolute / UNC path. Unlike Darkroom Pro the file is structured into named INI-style sections (`[OrderInfo]`, `[ImageInfo]`, `[Print]`) and is **scoped to a single print Surface** — orders that span multiple paper types must be split into one file per surface.

**Key differences from DPOF and Darkroom Pro:**

| Aspect | DPOF (Noritsu/Epson) | Darkroom Pro | Fuji JobMaker |
|--------|---------------------|--------------|---------------|
| File format | `[HDR]` / `[JOB]` | Flat `Key=Value` (sticky) | INI-style sections (`[OrderInfo]`, `[ImageInfo]`, `[Print]`) |
| File per job | Folder + `DPOF.001` | One `.TXT` per order | **One `.txt` per Surface** within an order |
| Section model | Header + per-image jobs | Order header + sticky line items | Order header + per-image blocks; each image can have multiple `[Print]` sub-sections |
| Image staging | Copied into `IMAGES/` subfolder | Referenced by absolute path (not copied) | **Copied** into a per-order folder; `ImagePath=` is set to that folder |
| Channel/paper routing | `PRT PCH` channel number | `Media=` value | `PrintCode=` (Frontier Quick Print code) + `Surface=` (one per file) |
| Status: accepted | Folder prefix rename `o→e` | `.TXT` moved to `processed/` | `.txt` **disappears** from hot folder root |
| Status: failed | Folder prefix rename `o→q` | `.TXT` renamed to `.err` | File remains in hot folder; error written to Frontier universal log (no in-band signal) |
| Backprint | n/a | Not part of spec | Optional `BackPrint=` per image — text **or** an image filename, depending on Frontier configuration |

---

## File Naming Convention

```
{orderNumber}_{Surface}.txt
```

Examples (matching the BALLY production sample):
- `BALLY-Q7F39E_Lustre.txt`
- `BALLY-Q7F39E_Glossy.txt`

> The Fuji v3.1 spec recommends `<jobID>.txt` and notes Order_ID must be 6–10 digits. Pixfizz's Frontier installation accepts non-numeric Order_IDs and the production example uses `Order_ID=L-BALLY-Q7F39E`. OHD therefore treats Order_ID as an opaque string (see [Order_ID generation](#order_id-generation) below) and uses the readable `{orderNumber}_{Surface}.txt` filename convention so multiple surface files for the same order coexist in the hot folder.

The file extension is lowercase `.txt` (matching the spec and the BALLY example). No subfolder structure is required.

---

## File Structure

A JobMaker file is composed of three section types in fixed order:

```
{orderNumber}_{Surface}.txt
─────────────────────────────────────
[OrderInfo]                ← exactly one, at top of file
  ...order-level fields...
─────────────────────────────────────
[ImageInfo]                ← one block per image
  ImageFile=...
  BackPrint=... (optional)
[Print]                    ← one or more per [ImageInfo]
  PrintCode=...
  PrintQty=...

[ImageInfo]                ← repeats for each image in the file
  ...
```

A single `[ImageInfo]` may be followed by **multiple** `[Print]` sections — each one prints the image at a different `PrintCode` / `PrintQty`. (See the spec's "Sample file – Simplex" example where `DSCF0009.JPG` has both a 5x7 and a 6x4 print.)

### CD images (not used by OHD initially)

The Fuji spec also supports `[ImageInfo]` blocks that contain only `OriginalPath=<value>` to write images to CD. OHD does not currently produce CDs — these blocks are out of scope and will be omitted unless a future feature is added.

---

## Emit Structure (planned OHD implementation)

Pixfizz produces **one `.txt` file per Surface (paper type) per order**. The OHD emitter (`fuji-jobmaker-output.js`, planned) will:

1. Match each image in the manifest to a Fuji JobMaker channel (size + finish).
2. Group images by the channel's `surface` value.
3. For each surface group, emit a separate file `{orderNumber}_{Surface}.txt` with its own `[OrderInfo]` section.
4. Within a file, emit one `[ImageInfo]` block per image followed by one `[Print]` section per quantity bucket (typically just one).
5. Stage all images referenced in the file to a per-order folder, and set `ImagePath=` to that folder.

Example (matching the BALLY-Q7F39E_Lustre.txt sample, abridged):

```
[OrderInfo]
Order_ID=L-BALLY-Q7F39E
ImagePath=\\MASTER\Pixfizz\Artwork\BALLY-Q7F39E\
Printer=DL650-A1
CustomerName=Jersey Smith
Surface=Lustre

[ImageInfo]
ImageFile=03505-cut-print_BALLY-Q7F39E_L1_100000004876_1_Q1.jpg
BackPrint=IMG_20260506_234158.jpg
[Print]
PrintCode=3.5x5
PrintQty=1

[ImageInfo]
ImageFile=03505-cut-print_BALLY-Q7F39E_L2_100000004876_1_Q1.jpg
BackPrint=IMG_20260506_234033.jpg
[Print]
PrintCode=3.5x5
PrintQty=1
```

> The blank line between `[OrderInfo]` and the first `[ImageInfo]` (and between successive image blocks) is cosmetic and not required by the parser, but is included to match the production example.

---

## `[OrderInfo]` Fields

Exactly one `[OrderInfo]` section appears at the top of the file.

```
[OrderInfo]
Order_ID=L-BALLY-Q7F39E
ImagePath=\\MASTER\Pixfizz\Artwork\BALLY-Q7F39E\
Printer=DL650-A1
CustomerName=Jersey Smith
Surface=Lustre
```

| Field | Required | Example | Source in OHD | Description |
|-------|----------|---------|---------------|-------------|
| `Order_ID` | **Yes** | `L-BALLY-Q7F39E` | Generated per-file via [Order_ID generation](#order_id-generation) | Unique Order ID for this surface file. The spec recommends 6–10 digits but Frontier accepts non-numeric strings — OHD treats it as opaque. |
| `ImagePath` | **Yes** | `\\MASTER\Pixfizz\Artwork\BALLY-Q7F39E\` | Per-order staging folder created by `FujiJobMakerFileWriter` | UNC path or local path to the folder Frontier reads images from. **Trailing backslash present** to match production example. |
| `Printer` | Optional | `DL650-A1` | Controller config `printerName` | Frontier Panda printer logical name. Routes the surface's prints to a specific physical Frontier. Omit if controller config has none. |
| `Surface` | Optional (per spec) — **always written** by OHD | `Lustre` | Channel config `surface` (the grouping key for this file) | Frontier surface preference. One per file (the file is the unit of surface grouping). Must match a value in Frontier's `paperinfo.ini` exactly (case-sensitive). |
| `CustomerName` | Optional | `Jersey Smith` | `job.customer_name` | Customer's full name. |
| `AutoCorrect` | Optional | `1` or `0` | Controller config `autoCorrect` | If non-zero, Frontier applies automatic image corrections. Omitted entirely if `controller.autoCorrect` is unset → falls back to Frontier's default. |
| `Phone` | Optional | `303-555-1212` | `job.customer_phone` (if present) | Customer phone — emit only when set on the job. |
| `Email` | Optional | `customer@example.com` | `job.customer_email` (if present) | Customer email. |
| `DueTime` | Optional | `05/07/2026 12:12:12 AM` | `job.due_at` (if present) | Order due date/time. **Format is fixed by spec**: `mm/dd/yyyy HH:MM:SS AM/PM`. **Time zone**: emitted in the OHD machine's local time (tz-naive). Confirmed working at the Bally site. |
| `CD` | Optional | `2` | n/a (out of scope) | Number of CDs to make. OHD does not emit `CD` in the initial implementation. |

> **OHD mapping notes**:
> - Always emit `Surface=` (it's the grouping key — leaving it blank would let Frontier fall back to the IC's default and break per-paper routing).
> - Always emit `ImagePath=` with a trailing backslash to match the production example.
> - Treat the spec's "6–10 digits" Order_ID rule as advisory — Pixfizz Frontier accepts arbitrary strings. Document but don't enforce.

### Order_ID generation

OHD generates a per-file Order_ID by combining a single-letter **surface code** with the order number:

```
Order_ID = {surfaceCode}-{orderNumber}
```

Examples:
- Lustre → `L-BALLY-Q7F39E`
- Glossy → `G-BALLY-Q7F39E`
- Matte  → `M-BALLY-Q7F39E`

`surfaceCode` is a per-channel field (or derived from the first letter of `surface` if not set). This guarantees that two surface files for the same order receive distinct Order_IDs, which is what Frontier uses to track separate jobs.

---

## `[ImageInfo]` Fields

One `[ImageInfo]` section per image. Each can be followed by one or more `[Print]` sections.

```
[ImageInfo]
ImageFile=03505-cut-print_BALLY-Q7F39E_L1_100000004876_1_Q1.jpg
BackPrint=IMG_20260506_234158.jpg
```

| Field | Required | Example | Source in OHD | Description |
|-------|----------|---------|---------------|-------------|
| `ImageFile` | **Yes** | `03505-cut-print_BALLY-Q7F39E_L1_100000004876_1_Q1.jpg` | `manifest.images[].filename` | Filename **relative to `ImagePath`**. Frontier copies the file from `{ImagePath}\{ImageFile}` into the IC Orders folder. |
| `BackPrint` | Optional | `IMG_20260506_234158.jpg` (image mode) **or** `Smith/05May26/Order123` (text mode) | See [BackPrint mode](#backprint-mode) | Per-image back-print value. The interpretation depends on a controller-level toggle. |
| `OriginalPath` | Not used by OHD | `\\server\path\file.jpg` | n/a | Used by Frontier for CD writes — out of scope. Mutually exclusive with `ImageFile`. |

### BackPrint mode

The Fuji v3.1 spec defines `BackPrint` as up to 40 alphanumeric characters of text printed on Line 2 of the photo's reverse. Pixfizz's Frontier installation extends this — when configured to do so, Frontier accepts an **image filename** in `BackPrint=` and prints that image on the reverse instead of (or in addition to) text.

OHD makes this a per-controller setting:

| `controller.backprintMode` | Behaviour |
|---------------------------|-----------|
| `'text'` | OHD generates a backprint string from a configurable template (similar to the Frontline / Darkroom Pro `photoLines` token system) and emits it as `BackPrint=<text>`. The value is sanitised: non-alphanumeric chars in the spec's exclusion list (`%`, `(`, `;`, `'`) are replaced with a space; `~` is replaced with `-`; the result is truncated to 40 chars. |
| `'image'` *(deferred — post-v0)* | OHD reads a per-image **back-print image** from the OH job, stages it into `ImagePath`, and emits `BackPrint=<filename>`. **Not implemented in v0** — the OH-side source of the back-print image is still unknown (see [Outstanding Questions](#outstanding-questions) #1). Producing the BALLY-style file via image mode is unblocked once that's resolved. |
| `'none'` *(default)* | Field omitted entirely. |

v0 ships `'none'` and `'text'` only. Selecting `'image'` in the UI will be disabled (or labelled "coming soon") until the back-print image source is defined.

> Once `'image'` mode lands, the back-print image will need to be staged into the same `ImagePath` folder as the front image, since `BackPrint=` is interpreted relative to `ImagePath` (mirroring `ImageFile=`).

### Text-mode template tokens

When `backprintMode = 'text'`, the template uses the same shared `template-tokens.js` resolver as Frontline back-prints and Darkroom Pro `photoLines`:

| Token | Source | Example |
|-------|--------|---------|
| `{customerName}` | `job.customer_name` | `Jersey Smith` |
| `{firstName}` | First word of customer name | `Jersey` |
| `{lastName}` | Remainder | `Smith` |
| `{orderNumber}` | OH order number | `BALLY-Q7F39E` |
| `{jobName}` | `job.job_name` (fallback `{orderNumber}`) | `BALLY-Q7F39E-1` |
| `{jobId}` | `job.id` | `38414838` |
| `{filename}` | Per-image filename | `03505-cut-print_..._Q1.jpg` |
| `{originalFilename}` | Customer's original upload filename, leading image-index prefix stripped (`5_576629810005.jpg` → `576629810005.jpg`); from the manifest/job record, so reprint-safe. Blank when none shipped. Note the back-print is still sanitised + truncated to 40 chars. | `576629810005.jpg` |
| `{date}` | Current date `dd/MMM/yy` | `07/May/26` |

Default template seed for new controllers (matches a common Frontline convention):

```
{firstName}/{filename}/{date}
```

Missing token values resolve to empty strings.

---

## `[Print]` Fields

`[Print]` sections appear after an `[ImageInfo]` section. There may be zero, one, or many — each one prints the image with a different `PrintCode` / `PrintQty`.

```
[Print]
PrintCode=3.5x5
PrintQty=1
```

| Field | Required | Example | Source in OHD | Description |
|-------|----------|---------|---------------|-------------|
| `PrintCode` | **Yes** | `3.5x5`, `6x4`, `5x7`, `85x11CAL` | Channel config `printCode` | Frontier Quick Print code. Must match a value configured on the IC's Quick Print list exactly. |
| `PrintQty` | Optional (defaults to `1`) | `2` | `manifest.images[].quantity` | Number of prints to make at this code. Always written by OHD even when `1`, to match the production example and avoid ambiguity. |

> An image with quantities at multiple sizes (rare in OHD's current model) would emit one `[Print]` per size. The initial OHD implementation emits a single `[Print]` per image — the channel-matching layer ensures a job lands in the right surface file with a matching `PrintCode`.

---

## How OHD Generates the Order File

### OHD field mapping summary

| Order file field | OHD source | Notes |
|-----------------|------------|-------|
| Filename | `{orderNumber}_{Surface}.txt` | Lowercase `.txt`. Surface taken from the channel grouping key. |
| `Order_ID` | `{surfaceCode}-{orderNumber}` | Surface code from channel config; falls back to first letter of `surface`. |
| `ImagePath` | `{controller.imageStagingRoot}\{orderNumber}\` *(trailing slash)* | OHD writes/copies images into this folder before emitting the file. |
| `Printer` | Controller config `printerName` | Omitted if blank. |
| `Surface` | Channel config `surface` | The per-file grouping key; same value for every image in the file. |
| `CustomerName` | `job.customer_name` | |
| `AutoCorrect` | Controller config `autoCorrect` (`true`→`1`, `false`→`0`, unset→omit) | |
| `Phone` / `Email` / `DueTime` | Job fields if present | DueTime formatted `mm/dd/yyyy HH:MM:SS AM/PM`. |
| `ImageFile` | `manifest.images[].filename` | Relative to `ImagePath` after staging. |
| `BackPrint` | Per [BackPrint mode](#backprint-mode) | Mode-dependent — text template or staged image filename. |
| `PrintCode` | Channel config `printCode` | Selected via channel matching. |
| `PrintQty` | `manifest.images[].quantity` | Always written; defaults to `1`. |

### Multi-surface order handling

A single OH order can require multiple `.txt` files when its images span surfaces:

```
Order BALLY-Q7F39E with:
  - 4 images @ 3.5x5 Lustre  ─┐
  - 4 images @ 3.5x5 Lustre   │→  BALLY-Q7F39E_Lustre.txt   (Order_ID: L-BALLY-Q7F39E)
  - 2 images @ 8x10 Glossy ──── →  BALLY-Q7F39E_Glossy.txt  (Order_ID: G-BALLY-Q7F39E)
```

The two files share an `ImagePath` (the staged per-order folder) but list disjoint sets of `ImageFile=` values. Each file is independently submitted to Frontier and tracked separately by OHD.

### Image staging

`FujiJobMakerFileWriter` performs the following before writing the `.txt`:

1. Compute `ImagePath = {controller.imageStagingRoot}\{orderNumber}\`.
2. Create the folder if missing.
3. Copy every image referenced by any surface file for this order (front images and, in `'image'` BackPrint mode, back-print images) into `ImagePath`.
4. Write each `_{Surface}.txt` file into the controller's hot folder.

> Staging root (`controller.imageStagingRoot`) is configured per-controller — typically a UNC path like `\\MASTER\Pixfizz\Artwork\` so that both OHD (writer) and Frontier (reader) see the same folder.

### Channel matching

Channel matching for Fuji JobMaker controllers extends the standard size/finish match with a Frontier-specific `printCode`:

```
manifest image (size + finish)  →  channel  →  printCode + surface + surfaceCode
```

`surface` becomes the file grouping key; `printCode` becomes the `PrintCode=` value; `surfaceCode` becomes the `Order_ID` prefix.

---

## Product Mapping Configuration (OHD) for Fuji JobMaker

OHD routes jobs to controllers via **product mappings** in `PrintControllerStore` — each mapping pairs an OH `productCode` + a set of `options` (e.g. `{ "Finish": "Lustre" }`) with the destination metadata for one channel of a controller. (Older docs sometimes call these "channels"; the codebase has used "product mapping" since the DPOF refactor and the term is preserved here for clarity.)

| Mapping field | Example | Description |
|---------------|---------|-------------|
| `productCode` | `0305-cut-print` | OH product code this mapping handles. Matched exactly against `job.product_code`. |
| `options` | `{ "Finish": "Lustre" }` | OH option key/values that must all match the job's options for this mapping to win. |
| `printCode` | `3.5x5` | Value emitted as `PrintCode=`. Must match a Frontier Quick Print code exactly. |
| `surface` | `Lustre` | Value emitted as `Surface=` and used as the per-file grouping key. Must match Frontier's `paperinfo.ini`. |
| `surfaceCode` | `L` | Single-letter (or short string) prefix used in `Order_ID`. Falls back to first letter of `surface` if unset. |
| `isActive` | `true` | Whether this mapping is available for matching. |

> `channelNumber` and `printSizeCode` are **not used** by Fuji JobMaker mappings (those are Noritsu/Epson concepts kept on the same mapping record for the DPOF pipeline). A Fuji mapping leaves them undefined.

---

## Controller-Level Configuration for Fuji JobMaker

| Controller field | Example | Description |
|------------------|---------|-------------|
| `type` | `fujijobmaker` | Controller type identifier. |
| `name` | `Frontier MS01 — DL650-A1` | Display name. |
| `hotFolderPath` | `\\MASTER\jobmaker\` | Frontier JobMaker hot folder. Default install path is `D:\jobmaker` per the spec but is operator-configurable. |
| `imageStagingRoot` | `\\MASTER\Pixfizz\Artwork\` | Root directory under which per-order subfolders are created and referenced as `ImagePath=`. |
| `printerName` | `DL650-A1` | Frontier Panda printer logical name written to `Printer=`. Optional. |
| `autoCorrect` | `true` / `false` / `null` | Maps to `AutoCorrect=1` / `AutoCorrect=0` / field omitted. |
| `backprintMode` | `'none'` / `'text'` / `'image'` | Controls `BackPrint=` emission. See [BackPrint mode](#backprint-mode). |
| `backprintTemplate` | `{firstName}/{filename}/{date}` | Template string used when `backprintMode = 'text'`. Resolved per image via `template-tokens.js`. |
| `isActive` | `true` | Whether this controller is available for routing. |

---

## Hot Folder Structure

OHD writes one `.txt` per surface; no subfolder structure is required.

```
\\MASTER\jobmaker\               ← Watch folder (configured in OHD)
├── BALLY-Q7F39E_Lustre.txt      ← Written by OHD (status: submitted)
├── BALLY-Q7F39E_Glossy.txt      ← Written by OHD (status: submitted)
└── ...
```

Images are staged separately under `imageStagingRoot`:

```
\\MASTER\Pixfizz\Artwork\
└── BALLY-Q7F39E\                ← One folder per order
    ├── 03505-cut-print_..._L1_..._Q1.jpg   ← Front images
    ├── 03505-cut-print_..._L2_..._Q1.jpg
    ├── IMG_20260506_234158.jpg             ← Back-print images (image mode)
    └── ...
```

---

## Status Detection Mechanism

The Fuji v3.1 spec is silent on file-level success/failure signalling — it only states that "if an error occurs during ingest, a log is created and logged to the system's universal log."

In practice, Frontier consumes accepted order files: the `.txt` **disappears** from the hot folder root once Frontier has ingested it.

| Status | What happens | How OHD detects it |
|--------|-------------|--------------------|
| `submitted` | OHD writes `{orderNumber}_{Surface}.txt` to the hot folder | n/a — set by OHD |
| `accepted` | Frontier consumes the file (deletes or moves internally) | `fs.watch` — tracked filename no longer exists in hot folder root |
| `failed` | File remains in the hot folder; an error is appended to Frontier's universal log | **No in-band signal**. OHD timeout policy: if a tracked `.txt` is still present after a configurable threshold (default 30 minutes), surface a warning to the operator with a pointer to Frontier's log. |

```
Event timeline:

  OHD writes:   BALLY-Q7F39E_Lustre.txt  ─────────────── (submitted)
                          │
         ┌────────────────┴────────────────┐
         │                                 │
  Frontier accepts:                  Frontier rejects:
  file disappears                    file remains in hot folder
         │                                 │
  fs.watch:                          OHD timeout watcher:
  removal → accepted                 still present after N min → warn
```

### Monitor implementation notes

`FujiJobMakerMonitor` watches the hot folder for **file removal** events. It also runs a periodic sweep (every ~60 s) over tracked files to flag any that have exceeded the failure-detection threshold. This is a weaker signal than DPOF (folder rename) or Darkroom Pro (`.err` rename); the timeout sweep is the only way OHD can surface a stuck file without manual operator action.

> An optional enhancement (post-v0): poll Frontier's universal log file if its location is known and parse for failures. Out of scope until we have visibility into the log format.

---

## Implementation Plan for OHD

### New services required

| Service | Analogous to | Purpose |
|---------|-------------|---------|
| `FujiJobMakerGenerator` | `dpof-generator.js` / planned `darkroom-pro-output.js` | Builds the file content for one surface group: `[OrderInfo]` + per-image `[ImageInfo]` / `[Print]` blocks. |
| `FujiJobMakerFileWriter` | `order-folder-writer.js` | Stages images into `imageStagingRoot\{orderNumber}\` and writes one `.txt` per surface to the hot folder. |
| `FujiJobMakerMonitor` | `folder-monitor.js` / planned `darkroom-pro-monitor.js` | Watches for `.txt` removal (accepted); runs a timeout sweep for stuck files (failed/unknown). |

### Schema additions

`PrintControllerStore` records are stored freeform (no JSON-Schema validation in the store itself), so adding new fields requires no migration. Validation lives in `fuji-jobmaker-config.js` and runs at the IPC / UI boundary before a record is persisted.

Add to a **product mapping** record (when `controller.type === 'fujijobmaker'`):

```js
{
  controllerId:  '<uuid>',
  productCode:   '0305-cut-print',
  options:       { Finish: 'Lustre' },        // OH options that must match the job
  isActive:      true,

  // Fuji-specific (alongside or instead of the DPOF channelNumber / printSizeCode):
  printCode:     '3.5x5',                      // PrintCode= value
  surface:       'Lustre',                     // Surface= value AND per-file grouping key
  surfaceCode:   'L'                           // Order_ID prefix; defaults to first char of surface
}
```

Add to **controller** schema:

```js
{
  type: 'fujijobmaker',
  hotFolderPath: '\\\\MASTER\\jobmaker\\',
  imageStagingRoot: '\\\\MASTER\\Pixfizz\\Artwork\\',
  printerName: 'DL650-A1',
  autoCorrect: null,                           // null → omit AutoCorrect=
  backprintMode: 'none',                       // 'none' | 'text' | 'image'
  backprintTemplate: '{firstName}/{filename}/{date}',
  failureTimeoutMs: 30 * 60 * 1000             // ms before unconsumed file is flagged
}
```

### Routing update

`PrintService._sendViaPrintController()` must branch on `controller.type`:
- `noritsu` / `epson` → existing DPOF pipeline
- `darkroompro` → Darkroom Pro pipeline
- `fujijobmaker` → new Fuji JobMaker pipeline

Multi-surface orders return multiple file write results — `PrintService` should treat the per-surface files as separate trackable jobs in `JobStore`, each with its own status lifecycle.

---

## Outstanding Questions

Only two questions remain unresolved — both block features that are deferred to a post-v0 milestone, so v0 implementation is unblocked.

| # | Question | Status | Impact |
|---|----------|--------|--------|
| 1 | In `backprintMode = 'image'`, where does the back-print image come from in the OH job model? (Job option pointing at a file? Paired manifest entry? Paired Pixfizz job?) | ❓ Open — **blocks `'image'` mode**; v0 ships `'none'` and `'text'` only | Drives the manifest schema and the staging copy step when image-mode is enabled. |
| 2 | When a `.txt` is rejected by Frontier, does it remain in the hot folder verbatim, or is it renamed/quarantined (e.g. `.err`, moved to a `failed/` subfolder)? | ❓ Open — v0 assumes "remains in place" and relies on the timeout sweep | If Frontier produces an in-band failure marker, `FujiJobMakerMonitor` should detect that instead of (or alongside) the timeout. Discoverable by deliberately submitting a malformed `.txt` to a real Frontier during integration testing. |

### Resolved decisions (folded into v0 spec)

| Topic | Decision |
|-------|----------|
| Hot folder location | Operator-configurable (`controller.hotFolderPath`). No default baked in — operator types in whatever path Frontier was installed to watch. |
| Surface case sensitivity | OHD emits exactly what's in the channel config (no normalisation). If `paperinfo.ini` doesn't match, the operator sees Frontier's error and corrects the channel. |
| `AutoCorrect=` default | Omitted when `controller.autoCorrect` is `null`/unset. Frontier falls back to its IC default. |
| `DueTime` time zone | Emitted in the OHD machine's local time. Confirmed working at the Bally site. |
| Non-numeric Order_ID | Confirmed accepted by Pixfizz Frontier via the BALLY sample. Ship as-is; if a future customer's Frontier rejects, add a numeric-template fallback then. |
| Multi-`[Print]` per image | Honoured per the spec's own sample. OHD emits `[Print]` blocks in manifest order. |

---

## Comparison: Fuji JobMaker vs Darkroom Pro vs DPOF

```
DPOF (Noritsu/Epson)          Darkroom Pro                            Fuji JobMaker
──────────────────────        ─────────────────────────────────       ──────────────────────────────────────
Folder per job                Single .TXT file per order              One .txt per Surface within an order
Images copied to IMAGES/      Images at absolute paths (not copied)   Images copied into per-order ImagePath
[HDR] + [JOB] sections        Flat Key=Value (sticky inheritance)     INI sections: [OrderInfo] / [ImageInfo] / [Print]
Channel = paper roll #        Channel = Media= name                   Channel = PrintCode + Surface + surfaceCode
Vendor metadata in [HDR]      Order header: name/email/Ext*           [OrderInfo]: name/printer/surface/etc.
                              Configurable photo lines (back print)   BackPrint= field — text or image filename
                                                                        (controller-level mode)
Status: folder prefix rename  Status: .TXT moved to processed/        Status: file disappears → accepted
       (o→e accepted, o→q failed)      OR renamed to .err (failed)            no in-band failure signal — timeout sweep
One [JOB] per image           One block per image (current emitter)   Multi-[Print] per image supported by spec
No customer data in DPOF      Order-level customer + Ext* fields      [OrderInfo] customer fields (Phone/Email/etc.)
No index print                Optional index print (Index=1)          n/a
Template config on channel    Template config on controller           Backprint template config on controller
                              (templateMappings)                       (backprintTemplate)
```
