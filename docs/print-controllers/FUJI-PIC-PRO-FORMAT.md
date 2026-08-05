# Fuji PIC Pro — Order File Format Specification

**Controller type identifier**: `fujipicpro`

> **Source**: FUJIFILM e-Systems *PIC Pro v3.0 User Guide — order.txt
> Specification*, pp. 339–370 (rev. 01/26/07).
>
> Supplemented by the pre-implementation investigation captured in
> `docs/fuji-pic-pro-investigation-and-plan.md` and the M0–M5
> implementation brief `docs/fuji-pic-pro-claude-code-brief.md`.
> The v1.8.0 release-round hardening pass is captured in
> `docs/fuji-pic-pro-review-fixes.md`.

---

## Overview

Fuji PIC Pro is a separate product from Fuji JobMaker — a different
IC, a different order-file format, and a different consumption
model. Both are Fujifilm order-ingest interfaces, but PIC Pro breaks
the "hot folder + text file → done" pattern JobMaker uses. PIC Pro
requires a **three-folder handshake** driven by `OrderGateway.exe`:

1. OHD writes `{OrderId}.txt` into **Order Data**.
2. `OrderGateway.exe` polls Order Data, parses the file, **deletes
   it**, and writes container files into **Merge Data**.
3. **Only then** may OHD drop the `{OrderId}` image folder into
   **DIGIN**. PIC Pro builds the print run from there and clears
   both the DIGIN folder and the containers as it processes.
4. Optionally OHD drops a `[release]{OrderId}` command file into
   Order Data to trigger the Autoprint Console.

> "The important thing to remember is the digital files should not
> get dropped into DIGIN before the respective container are created
> in the Merge Data file folder." — PIC Pro spec p. 369.

The three folders may live on **different servers**. OHD's routing
config exposes them as three separate paths (Order Data / DIGIN /
Merge Data) plus a fourth (Image Staging Root) that OHD owns
internally as scratch space.

### Key differences from other controllers

| Aspect | DPOF (Noritsu/Epson) | Darkroom Pro | Fuji JobMaker | **Fuji PIC Pro** |
|---|---|---|---|---|
| File per order | Folder + `DPOF.001` | One `.TXT` per order | One `.txt` per **Surface** within an order | One `.txt` per **order** (`{OrderId}.txt`) |
| Section model | `[HDR]` / `[JOB]` | Flat `Key=Value` | `[OrderInfo]` / `[ImageInfo]` / `[Print]` | `[Order]` / `[Neg]` / `[Unit]` |
| Handshake | Drop-and-go | Drop-and-go | Drop-and-go (waits for .txt to vanish) | **Three-folder** — .txt → Merge Data containers → DIGIN drop |
| Image location | `IMAGES/` under order folder | Referenced by absolute path | Copied to per-order folder; `ImagePath=` field | Sequence-renamed into staging then MOVED into `DIGIN/{OrderId}/` |
| Filename tolerance | Basename in DPOF file | Absolute path in `Filepath=` | Basename in `ImageFile=` | **NegNumber ≤ 15 chars, no extension** — so OHD renames to `0001` / `0002` / … |
| Channel/paper routing | `PRT PCH` channel number | `Media=` value | `PrintCode=` + `Surface=` | `Code=` (lab-defined package code) + `Color=` |
| Status: accepted | Folder rename `o→e` | `.TXT` moved to `processed/` | `.txt` disappears from hot folder | `.txt` disappears from Order Data → DIGIN folder disappears → optional `[release]` |
| Status: failed | Folder rename `o→q` | `.TXT` renamed to `.err` | `.txt` remains + Frontier log | Gateway timeout or build timeout — no in-band signal, OHD's own monitor drives it |
| Multi-quantity | Not a single field | `Copies=` | Multiple `[Print]` per `[ImageInfo]` | `Qty=` on each `[Unit]` |

---

## File Naming Convention

```
{OrderId}.txt
```

Where `OrderId` is the per-**job** identifier (OHD's `job.job_name`
if set, else `job.order_number`). Job-level not order-level — two
jobs from one OrderHub order become two distinct PIC Pro orders and
two distinct `.txt` filenames. This mirrors JobMaker's convention
and prevents two jobs from an OrderHub order colliding in PIC Pro's
`{OrderId}` staging and DIGIN subfolders.

Reprints append the suffix from the reprint sidecar:
`{OrderId}-r1.txt`, `{OrderId}-r2.txt`, …. Each reprint is a **new**
PIC Pro order — OHD does not use PIC Pro's native `[restart]`
command because OHD reprints are a subset of images with possibly
re-cropped versions; `[restart]` would reprint the ORIGINAL order
untouched.

---

## File Structure

INI-style, **case sensitive** headers and keys. CRLF line endings
with a trailing CRLF at EOF (matches the JobMaker generator's byte
pattern; Fuji ICs on Windows shares are permissive but the byte
match makes disk diffs cleaner during debugging).

```
[Order]
OrderId={orderId}
CustomerName={customer.fullName}     ← only when includeCustomerName && set
[Neg]
NegNumber={image.negNumber}
Backprint1={resolved}                ← optional, omitted when null/empty
Backprint2={resolved}                ← optional, omitted when null/empty
[Unit]
Code={image.printCode}
Qty={image.quantity ?? 1}
Color={image.color || 'C'}
                                     ← [Neg]/[Unit] pair repeats per image
```

Deliberately omitted from what OHD emits (see the M2 brief for the
full rationale):

- **`Crop=` / `UnitCrop=` / `Orient=`** — the file that ships is
  already pre-cropped and pre-oriented by OHD's Manual Crop stage,
  so per spec p. 351 `Orient=` is not required for digital files.
  Emitting `Crop=` / `UnitCrop=` would override Manual Crop's baked
  decisions.
- **`Retouch=`** — absent ≡ no retouch value.
- **`[Comp]` / `[Node]`** — templates / composites are out of scope
  for v0.
- **`Logo=` / `LogoPos=` / `SlimText*`** — pre-cropped prints only.
- **Greeting cards, CD products, index prints, crop cards** — out
  of scope for v0.

### Fields OHD emits

| Field | Section | Source | Notes |
|---|---|---|---|
| `OrderId` | `[Order]` | `job.job_name` \|\| `job.order_number` | Mandatory per spec p. 343. |
| `CustomerName` | `[Order]` | `job.customer_name` | Only emitted when the controller has `includeCustomerName === true` AND the name is set. Off by default: when on, it back-prints on every print unless `Backprint2` is also set (spec p. 343). |
| `NegNumber` | `[Neg]` | Sequence-renamed basename (`0001`, `0002`…) | Mandatory. Filename minus extension; ≤ 15 chars per spec p. 347. Since OHD renames to a 4-digit sequence the cap can never be hit in practice; the guard fires if a caller bypasses staging. |
| `Backprint1` | `[Neg]` | `controller.backprintTemplate` resolved | Only emitted when the controller's `backprintMode === 'text'` AND the template resolves to a non-empty string. Sanitised + truncated per JobMaker rules (40-char cap; `[%(;']` → space; `~` → `-`). Reuses `_sanitiseBackprintText` from JobMaker to keep the two Fuji types in lockstep. |
| `Backprint2` | `[Neg]` | `controller.backprintTemplate2` resolved | Same rules as `Backprint1`. Genuinely optional — spec allows one or two lines. |
| `Code` | `[Unit]` | `route.printCode` (from the channel mapping) | Mandatory per spec p. 351. Lab-defined package code (e.g. `64` for 6×4 lustre). |
| `Qty` | `[Unit]` | `manifest.images[i].quantity` (defaults to 1) | Mandatory per spec p. 352. Zero is allowed and preserved (operator-explicit cancel). |
| `Color` | `[Unit]` | `route.color` (defaults to `C`) | Mandatory per spec p. 353. Accepted: `C` (colour), `B` (B&W), `S` / `S2` / `S3` (three sepia intensities). UI-selectable from a dropdown; save-time validator normalises to uppercase. |

### The `{originalFilename}` back-print token

`{originalFilename}` reads from the **manifest** — the customer's
original upload name (`IMG_20260714_113355.jpg` etc.) — not the
sequence-renamed `0001.jpg` that ships to PIC Pro. Same
`originalDisplayName` helper Darkroom Pro and JobMaker already use.
This keeps the customer-facing back-print meaningful even though
the file OHD stages has a synthetic name.

---

## Three-Folder Handshake

The state machine driving each order is in
`src/main/services/fuji-pic-pro-monitor.js`. Persisted per-controller
in `fuji-picpro-pending-{controllerId}.json` (electron-store) so an
OHD restart mid-handshake resumes.

| Phase | What OHD waits on | Advances when | Times out to |
|---|---|---|---|
| `awaiting-gateway` | `{orderDataPath}/{orderId}.txt` still on disk | Two consecutive `ENOENT` observations → `delivering` | `gatewayTimeoutMs` (default 2 min) → `failed`; abandoned `.txt` cleaned up best-effort |
| `delivering` | Nothing (performs the DIGIN move inline) | `deliverToDigin` returns success → `building` | Failure of the move → `failed` |
| `building` | `{diginPath}/{orderId}` folder AND (if configured) `{mergeDataPath}/{orderId}.con` and/or `{mergeDataPath}/{orderId}/` | Two consecutive absent observations of ALL of the above → `releasing` | `buildTimeoutMs` (default 30 min) → `timed_out`; NO `[release]` written |
| `releasing` | Nothing | If `sendReleaseCommand === true`, writes `[release]{orderId}` to Order Data → `accepted`; otherwise straight to `accepted` | — |

Sweep cadence is 1 s while anything is pending and 60 s when idle.
`fs.watch` on Order Data / DIGIN / Merge Data is attached as a
debounced accelerator; the interval sweep is the source of truth.

Two-observation gate on every classifier — a single `existsSync` /
`stat` blip on an SMB share is not the same signal as "OrderGateway
consumed the file". Only `ENOENT` counts as "absent"; any other
error (EACCES / EIO / ENOTFOUND on an unmounted share) counts as
"unknown" and keeps the entry in its current phase until the answer
is unambiguous. The timeout is the backstop.

### Merge Data variants

Per spec p. 369, containers may be flat (`{orderId}.con`) or under
a per-order subdirectory (`{orderId}/`) depending on whether the
"Container Path Use Subdirs" option is ticked in `OrderGateway.exe`.
OHD checks both variants — the build is only complete when both
absent.

### Restart safety

Every persisted entry captures the four paths, both timeouts, and
the release toggle from the moment of enqueue. If the operator
edits the controller mid-flight, the in-flight entry keeps its
snapshot; only future submissions pick up the new values.

`enqueueSubmission` refuses to overwrite an in-flight entry with the
same `orderId` (throws `FUJI_PICPRO_DUPLICATE_SUBMISSION`); a fresh
dispatch is allowed after the previous entry resolves.

Dispatch uses a **two-phase commit**: enqueue → write → markCommitted.
An entry with `txtCommitted:false` doesn't get observed by
`_stepAwaitingGateway`, so a crash between enqueue and write can't
drive a phony advance to `delivering`. A crash between write and
`markCommitted` is recoverable: on restart the entry sits in
`awaiting-gateway` until the gateway timeout fires and resolves as
`failed`; the abandoned `.txt` is cleaned up.

---

## Image Staging (`Image Staging Root`)

OHD-owned scratch space. Nothing external ever reads from here —
it's where OHD assembles each order's per-order subfolder
(sequence-renamed `0001.<ext>` / `0002.<ext>` / …) before moving
that subfolder into DIGIN.

**Sequence rename.** The `NegNumber` cap (15 chars, no extension)
would let OHD emit `NegNumber=IMG_20260714_113355` and hope PIC Pro
accepts it (it doesn't — the cap is enforced), so OHD renames every
image to a zero-padded 4-digit sequence. The original filename
carries through into the dispatch record's `negNumberMap` so
"which physical file went out as `0007`?" is answerable after the
fact. Extensions are lowercased on stage (a DIGIN watcher that
cares about `.jpg` vs `.JPG` would otherwise reject).

**Two operational constraints on Image Staging Root:**

1. **Same volume as `diginPath`.** The DIGIN delivery is an atomic
   `fs.rename` when both paths share a volume. Cross-volume returns
   `EXDEV`, and OHD falls back to a recursive copy into
   `{diginPath}/{orderId}.ohdtmp` → rename to `{orderId}` → clean up
   staging. That works but is slow on a large order (per-file
   copies over SMB), so co-locate for the fast path.
2. **Must not overlap `orderDataPath` / `diginPath` /
   `mergeDataPath`.** Rejected at save time. Setting them equal or
   nesting inside each other creates ordering / cleanup hazards
   (`stageImages` would `rm -rf` the .txt, DIGIN watching would fire
   during staging, etc.). Sibling folders under a common ancestor
   are fine.

The per-order staging subfolder is wiped before every write so a
retry doesn't ship a stale `0001.<oldext>` alongside a current
`0001.<newext>`.

---

## Reprints

OHD reprints are a subset of the parent order's images, possibly
re-cropped or with different CMY corrections. The reprint arm emits
a **fresh PIC Pro order** with `orderId = {parent}-r{n}` — not a
`[restart]` command. Rationale:

- `[restart]{OrderId}` in PIC Pro re-prints the order PIC Pro
  already has, untouched. Since OHD reprints ship a subset of
  images (potentially with re-crops), `[restart]` would print the
  wrong content.
- A fresh order goes through the same handshake — write .txt →
  Gateway consumes → deliver to DIGIN → optional `[release]`.
- The parent job's OrderHub lifecycle is untouched (no
  `_markCompleted` / `_markInProduction` — the reprint is a
  sibling concept). Same posture as JobMaker reprints.

The one divergence from JobMaker reprints: PIC Pro reprints DO
start the monitor + enqueue. JobMaker reprints skip because
dropping the `.txt` in the hot folder IS the whole handshake; PIC
Pro reprints need the monitor to complete the DIGIN move + optional
release.

---

## Configuration

### Controller record (routing-service)

| Field | Required | Default | Notes |
|---|---|---|---|
| `type` | ✅ | — | Must equal `'fujipicpro'`. |
| `name` | ✅ | — | Free text. |
| `orderDataPath` | ✅ | — | Where `{OrderId}.txt` + command files land. |
| `diginPath` | ✅ | — | Where the `{OrderId}` image folder lands. |
| `imageStagingRoot` | ✅ | — | OHD scratch space. Same volume as `diginPath`; not overlapping the other three. |
| `mergeDataPath` | — | `''` | Blank = trust the DIGIN folder disappearing as the build-complete signal. Set = also require `{orderId}.con` and `{orderId}/` under it to be gone. |
| `sendReleaseCommand` | — | `false` | Per-controller auto-print toggle. Off by default so a fresh controller doesn't print on the first order. |
| `gatewayTimeoutMs` | — | `120000` | Bounds `10000` – `1800000`. |
| `buildTimeoutMs` | — | `1800000` | Bounds `60000` – `86400000`. |
| `backprintMode` | — | `'none'` | `'none'` \| `'text'`. `'image'` is rejected in v0. |
| `backprintTemplate` | when `mode === 'text'` | `''` | Line 1 of the back-print, resolved per image. Sanitised + truncated to 40 chars. |
| `backprintTemplate2` | — | `''` | Optional line 2. Same sanitisation. |
| `includeCustomerName` | — | `false` | Off by default. When on, emits `CustomerName=` in `[Order]`. |
| `checkOrderStatus` | — | `true` | Always `true` for PIC Pro (the state-machine monitor drives status). |

### Channel mapping record

| Field | Required | Default | Notes |
|---|---|---|---|
| `controllerId` | ✅ | — | UUID of the parent controller. |
| `productCode` | ✅ | — | OrderHub product code. |
| `printCode` | ✅ | — | Lab package code — written as `Code=` in `[Unit]`. Not required to be a bare `WxH`. |
| `printSize` | ✅ | — | Bare `WxH` (e.g. `6x4`, `3.5x5`). Sets the Manual Crop aspect. Never written to `order.txt`. |
| `surface` | ✅ | — | Free-form paper surface name. Used for controller-scoped grouping and back-print context; also the fallback for `surfaceCode`. |
| `surfaceCode` | — | First letter of `surface` (uppercased) | Optional shorthand. |
| `color` | — | `'C'` | Written as `Color=`. Allowed: `C` / `B` / `S` / `S2` / `S3`. UI dropdown; normalised to uppercase on persist. |

---

## Command Files

OrderGateway consumes command files from Order Data. Filename is
irrelevant to Gateway (spec p. 359–360); OHD names them
`ohd_{command}_{orderId}_{timestamp}.txt` so a resubmit doesn't
clobber a still-unconsumed prior command. Content is literally
`[{command}]{orderId}` with no trailing newline.

Commands OHD emits:

- **`[release]{OrderId}`** — auto-emitted at the end of the
  `releasing` phase when `sendReleaseCommand === true`. Requires
  the Autoprint Console to be running somewhere on the network.
- **`[delete]{OrderId}`** — used by the writer helper. Not wired
  to any UI in v1.8.0 but available for future use.
- **`[restart]{OrderId}`** — DELIBERATELY NOT USED. See the
  Reprints section above.

---

## Version compatibility

Spec behaviour differs at:

- **PIC Pro 2.5.56** — the `JBackprint` field replaces order-level
  `Backprint1` / `Backprint2` for orders that also carry per-`[Neg]`
  back-print entries. OHD emits back-print per-`[Neg]` only, so
  this is a non-issue.
- **PIC Pro 2.6.x** — the "Container Path Use Subdirs" option in
  `OrderGateway.exe` changes container storage from flat
  `{orderId}.con` to `{orderId}/`. OHD's Merge Data check watches
  for BOTH variants so either configuration works.

Confirmed against the v3.0 User Guide (rev. 01/26/07); no known
behaviour changes in later versions that affect the emitter.
