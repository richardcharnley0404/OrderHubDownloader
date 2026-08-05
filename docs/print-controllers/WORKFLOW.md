# Print Controller Workflow Reference

> **This document was rewritten in v1.8.0 to reflect the current
> architecture.** Earlier versions described a single-pipeline
> DPOF-only path (`sendToPrint(job)` → `configService.getProcessMapping`
> → `_sendViaDPOF`) that the app hasn't used since routing-service
> landed. If you're reading a v1.7.x checkout, the file may be
> stale; check `git log` before trusting it.

The dispatch pipeline has three fixed steps regardless of controller:

1. **Routing.** `routingService.resolveRoute(job)` walks a three-
   layer decision tree and returns either a controller route or an
   `unrouted` marker.
2. **Dispatch.** `printService.sendViaDPOFRouted(job, route)`
   dispatches to a per-controller-type pipeline based on
   `route.controllerType`.
3. **Status.** A per-controller monitor (created by
   `printControllerService.startMonitoring`) watches for the
   controller-specific completion signal. Some controller types
   have no monitor.

Each layer is independent — the operator's manual "Send to Print"
button, the auto-print loop, and the per-controller reprint arm
all share these three steps.

---

## Routing — `routingService.resolveRoute(job)`

Three layers, evaluated top-to-bottom. First match wins.

### Short-circuit: `_channelMappingOverride`

If the job carries `_channelMappingOverride` (stamped by Job
Review's Crop-to-Size when the operator picks a DPOF or Darkroom
row — see [Job Review Crop-to-Size](#job-review-crop-to-size)
below), routing skips Layers 1–3 entirely and returns a route
built from the override mapping. This is what lets a cropped
image be sent to the operator's chosen channel without touching
the process → controller mapping.

Fuji rows in the Crop-to-Size dropdown are informational only —
they set the crop aspect but do NOT stamp `_channelMappingOverride`.

### Layer 1 — Process Folder Exception

`processFolderExceptions[]` — one entry per `{productCode, options}`
pair that should bypass a controller entirely and just copy the job
folder to a filesystem path.

If matched → `{ type: 'process-folder', folderPath }`.

### Layer 2 — Process → Controller

`processControllerMappings[]` — one entry per job process
(`"Print"`, `"Cut"`, …) mapping to a controller id.

- Unknown process → default folder fallback (`processFolderPath`);
  if that's blank → `unrouted { reason: 'no-default-folder' }`.
- Mapped process with `hold: true` → route resolves normally but
  the job is marked "held for manual release"; auto-print stops
  before dispatch (see [Routing hold](#routing-hold-v178-forward)).

### Layer 3 — Channel Mapping

`channelMappings[]` — one entry per `{controllerId, productCode,
options}` triple carrying the per-product config the specific
controller type needs.

Layer 3 branches by `controller.type`:

- **`pdf_copy` / `folder_copy`** — no channel mapping needed. Route
  built directly from the controller record.
- **`darkroompro`** — mapping optional. When absent, tries the
  controller's `sizeTranslations` + `mediaTranslations` to derive
  Size and Media at dispatch time. If neither the mapping nor the
  translations produce values, returns `unrouted { reason:
  'no-channel', controller }` so the UI can surface the "Assign
  Channel" button.
- **`fujijobmaker` / `fujipicpro`** — mapping required; must carry
  `printCode` + `surface`. PIC Pro also carries an optional `color`
  (defaults `'C'`). `printSize` is Manual-Crop-aspect metadata (see
  [Manual Crop](#manual-crop) below); required at save time for PIC
  Pro, optional for JobMaker.
- **`frontline`** — mapping required; carries `batchCode` +
  optional `sortString`.
- **Default / DPOF-family** — mapping required; carries
  `channelNumber` + `printSizeCode`. `printSizeCode` may be a short
  standard code (`KG`, `2L`, `A4`), a bare `WxH` (auto-wrapped as
  `NML -PSIZE "..."` on emit), or a pre-formatted `NML -PSIZE`
  string. Blank rejected at save-time by `validateDPOFPrintSizeCode`.

Route shape returned:

```
{ type: 'controller',
  controllerType: 'noritsu' | 'epson' | 'dpof' | 'darkroompro' |
                  'fujijobmaker' | 'fujipicpro' | 'frontline' |
                  'folder_copy' | 'pdf_copy',
  controllerId, controllerName,
  ...controller-type-specific fields }
```

---

## Dispatch — `printService.sendViaDPOFRouted(job, route)`

Despite the name (kept for back-compat with the legacy DPOF-only
history), this is the entry point for ALL controller types.
Dispatch branches by `route.controllerType`:

| `controllerType` | Method | Emits |
|---|---|---|
| `pdf_copy` | `_sendViaPdfCopyRouted` | PDF file(s) copied to `{outputPath}/{orderNumber}_{jobId}/` |
| `folder_copy` | `_sendViaFolderCopyRouted` | Job folder recursively copied to `{outputPath}/{orderNumber}_{jobId}/` |
| `darkroompro` | `_sendViaDarkroomProRouted` | Single `.TXT` in `{outputPath}` |
| `frontline` | `_sendViaFrontlineRouted` | XML file + staged images |
| `fujijobmaker` | `_sendViaFujiJobMakerRouted` | One `.txt` per Surface in `{outputPath}` + staged images in `{imageStagingRoot}/{orderRef}/` (see `FUJI-JOBMAKER-FORMAT.md`) |
| `fujipicpro` | `_sendViaFujiPicProRouted` | One `.txt` in `{orderDataPath}` + staged images in `{imageStagingRoot}/{orderId}/`; DIGIN delivery driven by the state-machine monitor (see `FUJI-PIC-PRO-FORMAT.md`) |
| _default_ | `_sendViaDPOF` (via the routed path with the route in hand) | `o{orderNumber}_{productCode}/` folder in `{outputPath}` with `DPOF.001` + `IMAGES/` |

`isDpofType(route.controllerType)` covers `noritsu` / `epson` /
`dpof` / legacy untyped. That set is the single source of truth
for "DPOF family" — declared once in `services/controller-types.js`
so the two dispatch sites that need it (`sendReprint` +
`runAutoPrint`) can't drift apart.

### Shared image-source resolution

Every pipeline that touches image pixels resolves them through the
same three-step chain so the pre-cropped file wins over the raw:

1. `_getEnhancedPathMap(jobFolderName, jobFolderPath)` — reads the
   sidecar for `enhanced` entries pointing at `working/{filename}`
   AI-upscaled variants.
2. `resolveDispatchImageSource({ rootPath, jobFolderPath, basename,
   enhancedPath })` — walks the precedence: sidecar's `croppedPath`
   → `enhancedPath` → `{jobFolderPath}` root → `working/{basename}`
   → `originals/{basename}`.
3. `_applyCorrectionsToImageFiles(imageFiles, workingPath,
   correctionsMap)` — reads the sidecar for per-image CMY
   corrections and, when non-zero, writes a corrected `.jpg` into
   `working/` and swaps the source path.

The manifest is the source of truth for **per-image metadata**
(quantity, originalFilename, size). Never read those off the array
that comes back from `_applyCorrectionsToImageFiles` — that helper
strips every non-`{sourcePath, filename}` field on rows with a
correction (v1.8.0 fix — a full round-trip through the correction
step could lose `Qty` and blank the back-print).

---

## Status — per-controller monitors

Started by `printControllerService.startMonitoring(controllerId)`.
Also started at boot / on save-controller by
`polling-service._startFolderMonitors` +
`printControllerService.startAllPicProMonitors` so persisted state
rehydrates on restart.

| Controller type | Monitor | Signal |
|---|---|---|
| `noritsu` / `epson` / `dpof` | `FolderMonitor` | Folder rename `o…` → `e…` (accepted) or `o…` → `q…` (failed) |
| `darkroompro` | `DarkroomProMonitor` | `.TXT` moved to `processed/` (accepted) or `.err` sibling appears (failed) |
| `fujijobmaker` | `FujiJobMakerMonitor` | `.txt` disappears from hot folder root (accepted); stuck files past `failureTimeoutMs` reported as `timed_out` |
| `fujipicpro` | `FujiPicProMonitor` (state machine) | Three-folder handshake — see `FUJI-PIC-PRO-FORMAT.md` |
| `folder_copy` / `pdf_copy` / `frontline` | none | Dispatch marks complete or in_production and moves on |

Monitor callbacks feed `jobStore.updateJobStatus(orderNumber,
'accepted' \| 'failed')`. The v1.7.x doc claimed this was "local
only — does not push status back to the OrderHub API"; that's
still accurate for DPOF `o→e`/`o→q`, but the auto-completion
path (`autoCompleteOnPrinterAccept` config, off by default) DOES
POST `/jobs/{jobId}/completed` when the printer confirms.

---

## Job lifecycle

Two independent status trackers, one operator-facing and one
internal.

### OrderHub API status — `job.status` (server-side)

Managed by `job-service.js` via API calls. Every dispatch success
calls `markInProduction(jobId)` unless the controller has
`checkOrderStatus === false` (in which case the dispatch marks
`_markCompleted` immediately — used by Frontline and any
fire-and-forget path).

```
received → in_production → completed
```

`_markCompleted` also runs when the auto-completion gate flips
based on a monitor callback (see above).

### Local dispatch status — `_status` on the cached job

Written into the local job-service cache by dispatch when
something goes wrong before the OrderHub API can be updated. Used
by the Jobs grid to show an actionable error message. The five
values in current use:

- `error` (with `_errorMessage`) — a dispatch guard rejected the
  route, or a downstream write failed. Every controller type
  stamps this on its own failure paths.
- `in_production` — mirror of the API status, written locally as a
  fallback when the API call fails.
- `held` — awaiting release, either routing-held or manual-source
  (see [Hold gates](#hold-gates) below).
- `awaiting-manifest` — sidecar work-item bookkeeping while the
  manifest is late.
- `timed_out` / `failed` — Fuji monitor terminal outcomes.

---

## Auto-print gate

`runAutoPrint()` in `ipc-handlers.js` fires on every job-state
change (channel-mapping save, controller save, process-mapping
save, sidecar mutation, incoming poll cycle). It walks every
cached job and dispatches those that clear a five-gate check:

1. **`_status` clean** — no `error`, no `awaiting-manifest`, no
   `held`.
2. **Not held** — `computeHoldForReview(job)` returns no reasons.
   Held-for-review captures manual-source jobs, jobs with any
   pinned manual artwork file, and any job whose process is on the
   routing-held list.
3. **Route resolved** — `resolveRoute(job)` returns a `controller`
   or `process-folder` route, not `unrouted`.
4. **Controller-specific gate** — DPOF-family jobs need
   `channelNumber != null`; Darkroom Pro can also be gated on
   `_darkroomProSize` / `_darkroomProMedia`; Fuji jobs need
   `printCode` + `surface`; Fuji PIC Pro also `printCode`; the
   channel mapping's `skipAutoPrint` toggle blocks per-mapping.
5. **AI quality clear** — jobs held by the AI quality
   orchestrator (rows below the operator's threshold) are skipped;
   the operator releases individually or in bulk.

Everything that clears all five gets dispatched sequentially via
`sendViaDPOFRouted`. The sequential ordering is why the PIC Pro
monitor is state-machine-driven and returns immediately from
dispatch — an inline blocking wait on the DIGIN handshake would
stall every subsequent job for the full timeout whenever the
gateway is stopped.

### Routing hold (v1.7.8 forward)

A process → controller mapping may carry `hold: true` — the
resolved route is normal but the job is stamped
`_routingHeld: true` at dispatch time. Auto-print stops before
`sendViaDPOFRouted`. The Resolve Routing Hold modal lets the
operator either release to the default controller or reassign to
a different controller (stamping `_channelMappingOverride` when
the reassignment target has a matching channel mapping).

### Hold gates

Three families of hold, evaluated together by
`computeHoldForReview(job, ctx)`:

- **Manual source** — `job.artwork_source === 'manual'`. Never
  auto-prints; needs operator review.
- **Manual file** — any `artwork_files[].production_ready ===
  false` AND `artwork_source === 'manual'` (the flag is
  meaningless on Pixfizz-sourced files — landmine documented in
  CLAUDE.md).
- **Routing hold** — process is on the held set (see above), and
  `_routingHoldReleased !== true`.

---

## Job Review Crop-to-Size

When the operator opens Job Review for a manual-source job and
picks a target size from the Crop-to-Size dropdown:

1. `getAllSizeOptions()` publishes three sources of sizes:
   DPOF channel mappings, Darkroom Pro `sizeTranslations`, and
   Fuji-family `printSize` fields (v1.8.0 addition).
2. `buildSizeOptions(allSizeOptions)` in
   `src/shared/cropSizeDropdown.js` merges those into the built-in
   COMMON_PRINT_SIZES list. DPOF + Darkroom rows fold into the
   matching COMMON `{w,h}` row so picking `4×6"` also stamps the
   routing override. Fuji rows NEVER fold — they appear as
   separate labelled rows, and picking one sets the crop aspect
   without stamping `_channelMappingOverride`. That prevents the
   silent reroute a lab with both a Noritsu 4×6 channel AND a Fuji
   4×6 mapping would otherwise hit.
3. On apply, `jobCropImage` writes a cropped `.jpg` into
   `working/{filename}` and stamps the sidecar's `cropApplied` +
   `croppedPath` fields.
4. When a DPOF or Darkroom row was picked, the dispatch step's
   `resolveRoute` short-circuits on `_channelMappingOverride` and
   sends the cropped image to that specific channel — regardless
   of what the process → controller mapping would normally do.

`resolveTargetSize` (used by Manual Crop's per-image approve to
know what aspect ratio to enforce) resolves a job's route into a
`sizeOption` via four paths in order: DPOF channel-mapping
lookup, Darkroom `sizeTranslations` lookup, Fuji `channelMappingId`
lookup, and a regex-parse of `route.printSizeCode` /
`route.darkroomSize` as a last resort.

---

## Reprints — `printService.sendReprint(parentJob, reprintJobPath,
reprintSuffix, reprintImages)`

Every reprint sources images from `{reprintJobPath}/originals/`
(never `/working/` — CLAUDE.md landmine) and dispatches through
the parent job's resolved route. Branches by
`route.controllerType`:

| controllerType | Reprint method |
|---|---|
| `noritsu` / `epson` / `dpof` / legacy | `_sendReprintViaDPOF` |
| `darkroompro` | `_sendReprintViaDarkroomPro` |
| `folder_copy` | `_sendReprintViaFolderCopy` |
| `pdf_copy` | `_sendReprintViaPdfCopy` |
| `frontline` | `_sendReprintViaFrontline` |
| `fujijobmaker` | `_sendReprintViaFujiJobMaker` |
| `fujipicpro` | `_sendReprintViaFujiPicPro` |

Parent job's OrderHub status is untouched — reprints are a
sibling concept, not a lifecycle transition. Each pipeline emits
its own reprint-suffixed file(s) so parent and reprint don't
collide.

---

## Manual Crop

`resolveTargetSize(job)` in `src/main/jobs/batchCropActions.js`
returns the sizeOption that Manual Crop's aspect resolver locks
the crop box to. Two consequences the operator cares about:

- **`ok: true`** — the ⚠ pill is hidden, the crop box shows the
  right aspect, Approve is enabled.
- **`ok: false`** — the ⚠ pill shows the reason (`no-size-
  translation` / `unrouted` / `no-channel` / `pdf-or-folder-copy`
  / `error`), the crop box falls back to 1:1 square, and per-
  image Approve + Approve All + the Enter/Space keyboard shortcut
  are all disabled. This prevents the pre-v1.8.0 defect where an
  operator could ship a square-cropped file to a controller
  expecting a specific aspect.

---

## File-and-folder conventions

Unchanged from earlier releases; kept here for reference.

### Download directory structure

```
{downloadDirectory}\
└── {orderNumber}_{orderId}\        ← Order folder
    ├── {orderNumber}.json          ← Order manifest
    └── {orderNumber}_{jobId}\      ← Job folder
        ├── photo-001.jpg           ← Raw upload (audit copy)
        ├── originals\              ← Pristine copies (source for reprints)
        └── working\                ← CMY-corrected + cropped files (source for dispatch)
```

### DPOF order folder in the controller's hot folder

```
{prefix}{orderNumber}_{productCode}
```

- Prefix `o` — submitted by OHD.
- Prefix `e` — accepted by the controller.
- Prefix `q` — rejected by the controller.

Order-number regex on `FolderMonitor` requires digits — the legacy
comment in the earlier version of this document about
alphanumeric order numbers not parsing is still accurate for DPOF.
Every controller type that supports non-numeric order numbers
does so through its OWN monitor's parsing logic (JobMaker matches
against the tracked-file map by filename; PIC Pro uses the
`orderId` string as an opaque key).

### Manifest image filenames

Manifest image filenames are relative to the order folder:

```json
{
  "jobs": [
    {
      "jobId": "38334605",
      "images": [
        { "filename": "PXDEMO-K9MYDG_38334605/photo-001.jpg",
          "quantity": 2,
          "originalFilename": "IMG_20260714_113355.jpg" }
      ]
    }
  ]
}
```

The `originalFilename` field is what `{originalFilename}` in
JobMaker + PIC Pro back-prints reads from — the customer's true
upload name, preserved regardless of any OHD-side renaming.
