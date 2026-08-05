# Fuji PIC Pro — investigation & implementation plan

**Status:** investigation complete, nothing built.
**Date:** 2026-08-02
**Sources:** *PIC Pro v3.0 User Guide — order.txt Specification* (pp. 339–370, FUJIFILM e-Systems, rev. 01/26/07); OHD `fujijobmaker` implementation as the structural precedent.

---

## 1. Headline finding — read this first

Your instinct was right that PIC Pro works "similar to Fuji JobMaker", and the code structure carries over almost one-for-one. But there are **two substantive differences**, and one of them is a pre-existing bug in the JobMaker path that "pre-cropped only" depends on.

### 1a. PIC Pro's delivery order is the *reverse* of JobMaker's

JobMaker stages the images first and drops the `.txt` last, precisely so the Frontier can't see a job before its pixels exist. The `.txt` is the trigger.

PIC Pro is the opposite, and it is strict about it:

1. `<OrderId>.txt` goes into **Order Data**.
2. `OrderGateway.exe` polls that folder, parses the file, **deletes it**, and writes `.con` container files into **Merge Data**.
3. *Only then* may a folder named `<OrderId>` containing the images be dropped into **DIGIN**.
4. The containers and the DIGIN folder are deleted automatically as the order is built.

> "The important thing to remember is the digital files should not get dropped into Digin before the respective container are created in the Merge Data file folder." — p. 369

So this is not fire-and-forget. It needs a real handshake, which is what you picked. That's section 5.

### 1b. Crop target size does not resolve for Fuji JobMaker today — so "pre-cropped as per JobMaker" is not currently a working reference

This is the one that matters. `resolveTargetSize()` in `src/main/jobs/batchCropActions.js:718` only understands two families:

- **DPOF** (`noritsu`/`epson`/`dpof`) — via `channelNumber` → channel mapping → size option
- **Darkroom Pro** — via the controller's `sizeTranslations`

`fujijobmaker` has **no branch at all**. Worse, the Fuji route deliberately sets `channelNumber: null` and `printSizeCode: ''` (`renderer.js:5798-5808`), and `getAllSizeOptions()` only reads `size || printSizeCode || batchCode` — so a Fuji mapping contributes no size option even in principle. A routed Fuji job therefore **always** returns `{ ok:false, reason:'no-size-translation' }`.

What the operator actually sees in Manual Crop on a Fuji job:

- a `⚠ No size translation` pill instead of a target size
- the crop box **silently locked to 1:1 square**, because `CropEditor.jsx:298` falls back to `aspectRatio = 1` when `sizeOption` is null
- no Portrait/Landscape toggle, no crop overlays on the thumbnail rail
- **Approve All disabled** — but the per-image **Approve button is not gated**, so an operator can approve every image one at a time at a square crop and hit Send to Print

That last point looks like a genuine bug rather than intent (there's a comment at `ManualCropMode.jsx:546` claiming the Approve button *is* gated; it isn't). Worth confirming on a real Fuji job before we treat it as fact — but if it holds, JobMaker has been shipping square crops to the Frontier whenever anyone used Manual Crop.

**Implication for PIC Pro:** if we copy JobMaker exactly, PIC Pro inherits the same broken crop. Since the entire point is to send pre-cropped files at the right aspect, target-size resolution has to work. That's milestone **M0** below, and it is a prerequisite, not a nice-to-have.

---

## 2. The order.txt contract, reduced to what we actually need

The spec covers film, crop cards, templates/composites, greeting cards, CD products and index prints. **We need none of it.** For pre-cropped digital files the file collapses to this:

```
[Order]
OrderId=ORD-O4YK5Z-1
[Neg]
NegNumber=0001
Backprint1=Jane Smith/DSC_0042.jpg
[Unit]
Code=64
Qty=2
Color=C
[Neg]
NegNumber=0002
[Unit]
Code=64
Qty=1
Color=C
```

Rules that bind us:

| Rule | Source | Consequence for OHD |
|---|---|---|
| INI-style; **headers and variables are case sensitive** | p. 339 | Emit exactly as above. Golden-file test. |
| File must be named for the Order ID with a `.txt` extension | p. 340 | `<OrderId>.txt` |
| One `[Order]`; `OrderId=` mandatory | p. 343 | From `job.job_name \|\| job.order_number`, same as JobMaker |
| `NegNumber` = digital filename **with no extension**, **max 15 characters**, mandatory | p. 347 | See §4 — this is why we rename |
| Every `[Neg]` needs at least one `[Unit]` (unless it's only used in a `[Comp]`) | p. 342 | One `[Unit]` per image |
| `Code=` mandatory — lab-defined print/package code | p. 351 | Comes from the channel mapping |
| `Qty=` mandatory | p. 352 | From the manifest's per-image `quantity` |
| `Color=` mandatory — `C`/`B`/`S`/`S2`/`S3` | p. 353 | Default `C`, overridable per mapping |
| `Crop=` is **for crop-carded negatives only** | p. 349 | Omit entirely |
| `UnitCrop=` is for files that still need cropping | p. 353 | **Omit** — that's the whole point |
| `Orient=` "is only mandatory when scanning crop carded negative. It is not necessary for order text files that contain parameters for digital files" | p. 351 | Omit. Rotation is already baked into the cropped file. |
| `Retouch=` absent ≡ no value | p. 348 | Omit |
| `CustomerName=` "will also be printed on the back of the print as long as there is no Backprint2 header used" | p. 343 | **Omit by default** — a controller toggle, off. Otherwise customer names appear on the back of every print unexpectedly. |
| Backprint precedence: per-`[Neg]` `Backprint1/2` supersede order-level `JBackprint1/2`, which supersede the Frontier Backprint Setup | pp. 344–347 | Use per-image `Backprint1`/`Backprint2` so `{originalFilename}` works per image, same as JobMaker |
| Backprint lines cap at 40 characters | p. 344 | Reuse JobMaker's `_sanitiseBackprintText` (40-char slice + character stripping) |

### Command files (printing, reprinting, deleting)

Dropped into **Order Data** as a `.txt` whose *name doesn't matter*; contents are `[command]<ordernumber>`, no spaces. Multiple commands per file are allowed (pp. 359–360).

- `[release]2342344` — print the order. **Requires the Autoprint Console to be running somewhere on the network.**
- `[restart]2342344` — reprint
- `[delete]2342344` — delete (does *not* need the Autoprint Console)

Spec caveat, p. 369: before sending `[release]`, make sure the containers **and** the DIGIN folder have been consumed from Merge Data — otherwise you're releasing an order that isn't fully built.

---

## 3. Proposed controller: type `fujipicpro`

Modelled on `fujijobmaker`, which means the following existing seams all get one new arm each: `index.html` type list + field groups, `renderer.js` (`updateOcTypeFields`, `_updateCmFields`, `ocSaveBtn`, `cmSaveBtn`, `openAssignModal`, `assignChannelSaveBtn`, `getControllerTypeLabel`), `routing-service.js` (Layer-3 branch, `_channelMappingOverride` twin, `NON_DPOF_CONTROLLER_TYPES`), `ipc-handlers.js` (save-controller + save-channel-mapping validation), `print-service.js` (`sendViaDPOFRouted` + `sendReprint`), `print-controller-service.js` (`startMonitoring`).

### Controller fields

| Field | Required | Notes |
|---|---|---|
| `orderDataPath` | ✅ | Where `<OrderId>.txt` and command files are written. Usually `\\Labserver1\Order Data`. |
| `diginPath` | ✅ | Where the `<OrderId>` image folder lands. May be `DIGIN`, `DIGIN1`, `DIGIN2`… |
| `mergeDataPath` | optional | Only used to confirm the order finished building before `[release]`. If blank we fall back to watching the DIGIN folder disappear. |
| `imageStagingRoot` | ✅ | Images are assembled here, then moved into DIGIN, so DIGIN never sees a half-copied folder. |
| `sendReleaseCommand` | default **off** | Your per-controller option. When on, OHD writes `[release]<OrderId>` once the build completes. |
| `gatewayTimeoutMs` | default 120 000 | How long to wait for OrderGateway to consume the `.txt` before failing the job. Bounds 10 s – 30 min. |
| `buildTimeoutMs` | default 1 800 000 | How long to wait for the order to finish building before warning. Mirrors JobMaker's `failureTimeoutMs`. |
| `backprintMode` | `none` \| `text` | Same as JobMaker. `image` not supported. |
| `backprintTemplate` | when mode is `text` | Line 1 → `Backprint1=` |
| `backprintTemplate2` | optional | Line 2 → `Backprint2=`. New vs JobMaker; PIC Pro genuinely has two lines. |
| `includeCustomerName` | default **off** | Emits `CustomerName=`. Off because of the back-print side effect above. |
| `autoprint`, `checkOrderStatus`, `ignoredOptionNames` | — | Shared, unchanged. |

Deliberately **not** a single root path with derived subfolders — you said labs lay these out differently, and the spec confirms the folders can live on different servers (`\\Labserver1\Order Data` on the master, DIGIN possibly on a secondary). Three explicit paths, browse buttons on each.

### Channel mapping fields

| Field | Required | Maps to |
|---|---|---|
| `printCode` | ✅ | `Code=` — the lab's package/print code |
| `printSize` | ✅ | **Not written to order.txt.** Bare `WxH` (e.g. `6x4`) purely so the crop box gets the right aspect. See M0. |
| `color` | default `C` | `Color=` |
| `channelNumber: null`, `printSizeCode: ''`, `skipAutoPrint: false` | — | Shape parity, exactly as Fuji does today |

Making `printSize` mandatory at save time follows the precedent you already set with `printSizeCode` for DPOF in 1.7.22 — a mapping that can't produce a correct crop should fail loudly at configuration time, not silently print a square.

---

## 4. Filenames — why we rename

`NegNumber` is capped at **15 characters** and must equal the image filename minus its extension. OHD's dispatched filenames routinely exceed that (Pixfizz index prefixes, customer originals like `IMG_20260714_113355.jpg` = 23 chars).

Per your answer: **rename on staging to a zero-padded sequence** — `0001.jpg`, `0002.jpg`, … in manifest order. That gives us:

- `NegNumber` always valid and always unique
- deterministic print order
- no collisions
- the customer's real filename still reaches the back of the print, because the `{originalFilename}` back-print token reads the *manifest*, not the dispatched file (this is exactly how `{originalFilename}` already works for Darkroom Pro and JobMaker — see `project_ohd_original_filename_token`)

The sequence-to-original mapping gets logged and written into the job's dispatch record so a "which file is 0007?" question is answerable after the fact.

---

## 5. The gateway handshake

You chose "watch for the txt to vanish". Two ways to build it:

### Option A — inline blocking wait (simpler)

`_sendViaFujiPicProRouted` writes the `.txt`, then `await`s a poll loop until it disappears or `gatewayTimeoutMs` expires, then moves the folder into DIGIN.

- ✅ ~150 lines, no new persistence, easy to test
- ❌ blocks the auto-print loop for the duration. `runAutoPrint()` dispatches jobs sequentially, so a stopped OrderGateway means every job in the batch waits out the full timeout in turn
- ❌ an app restart mid-wait strands the order: `.txt` consumed, images never delivered

### Option B — pending-submission queue (recommended)

Dispatch is split into phases, driven by a `FujiPicProMonitor` sweep (1 s while anything is pending, 60 s idle) exactly like `FujiJobMakerMonitor`:

| Phase | Action | Transition |
|---|---|---|
| `awaiting-gateway` | `.txt` written to Order Data, images staged | `.txt` gone → next phase; timeout → job error |
| `delivering` | move `{staging}/{OrderId}` → `{digin}/{OrderId}` | move done → next phase |
| `building` | wait for DIGIN folder (and Merge Data containers, if configured) to clear | cleared → `accepted`; timeout → warn + `timed_out` |
| `releasing` | if `sendReleaseCommand`, write `[release]<OrderId>` | written → complete |

State persists in a small `fuji-picpro-pending.json` store, so a restart mid-handshake resumes rather than stranding the order. Dispatch returns immediately with `method: 'fujipicpro-routed'`.

- ✅ non-blocking, restart-safe, and the status feedback loop (`accepted`/`timed_out` → `jobStore.updateJobStatus`) is the same shape JobMaker already uses
- ❌ ~400 lines and one new store

I'd build B. The failure mode A hides — order created in PIC Pro with no images — is the kind that surfaces at the printer rather than on screen.

---

## 6. Milestones

| # | Scope | Notes |
|---|---|---|
| **M0** | **Crop target size for non-DPOF typed controllers** | Add a `picpro` source to `getAllSizeOptions()` and a branch to `resolveTargetSize()` keyed on the mapping's `printSize`. Prerequisite for pre-cropped output. Optionally extend the same fix to `fujijobmaker` (see §7). |
| M1 | `fuji-pic-pro-config.js` validators + type registration across the renderer + routing-service + ipc-handlers | Mirrors `fuji-jobmaker-config.js` one-for-one |
| M2 | `fuji-pic-pro-generator.js` — the order.txt emitter | Pure function, golden-file test against a hand-built reference |
| M3 | `fuji-pic-pro-file-writer.js` — staging, sequence rename, atomic `.txt` write, DIGIN move | `.tmp`+rename for the txt; folder rename (copy fallback on EXDEV) for DIGIN |
| M4 | `fuji-pic-pro-monitor.js` + pending store — the handshake state machine | The bulk of the new work |
| M5 | `print-service._sendViaFujiPicProRouted` + dispatch wiring | Reuses `_getEnhancedPathMap` → `resolveDispatchImageSource` → `_applyCorrectionsToImageFiles`, i.e. the cropped file in `/working/` is what ships |
| M6 | `[release]` / `[delete]` command emitter behind `sendReleaseCommand` | `[restart]` deliberately unused — see §7 |
| M7 | Reprints — `_sendReprintViaFujiPicPro` | New order with the `-r1` suffix, mirroring JobMaker |
| M8 | Docs: `docs/print-controllers/FUJI-PIC-PRO-FORMAT.md` + operator guide + CHANGELOG | Matches the JobMaker doc set |

Test files to mirror, one per module: `*-generator.test.js`, `*-file-writer.test.js`, `*-monitor.test.js`, `*-config.test.js`, `print-service-reprint-fujipicpro.test.js`, plus one-line additions to `print-service-reprint-dispatch.test.js`'s completeness matrix, `routing-backfill-print-size.test.js` and `validateDPOFPrintSizeCode.test.js`.

---

## 7. Decisions I'd like your call on

1. **Do we fix JobMaker's crop at the same time?** M0 fixes PIC Pro. Extending it to `fujijobmaker` means adding a `printSize` field to existing Fuji mappings (backfillable from `printCode` where it parses as `WxH`, blank otherwise). If Manual Crop has been used on Fuji jobs, those crops were square. Worth checking a recent Fuji order before deciding urgency.

2. **The ungated Approve button.** If confirmed, an operator can approve square crops on any controller with no size translation. Independent of PIC Pro, arguably worth fixing first as a one-liner.

3. **Reprints: new order vs `[restart]`.** PIC Pro has a native `[restart]<orderid>` that reprints the order it already holds. But OHD reprints are a *subset* of images, possibly re-cropped, so `[restart]` would reprint the wrong thing. I'd create a fresh order with the `-r1` suffix (JobMaker's model) and leave `[restart]` unused. Flagging in case your operators expect the PIC Pro-native behaviour.

4. **Your existing `folder_copy` controller.** "Fuji Pic Pro - Folders" writes a flat folder and marks the job complete, with no order.txt at all. I'd leave it in place, add the new typed controller alongside, test against a real order, then delete the old one. No automatic migration — the paths and semantics differ.

## 8. What I need from you before M1

- The three real paths on the PIC Pro machine (Order Data, DIGIN, Merge Data) — or confirmation that you'll fill them in at test time
- Whether "Container Path Use Subdirs" is checked in `OrderGateway.exe`. If it is, containers land in `Merge Data\<OrderId>\`; if not, flat. Only affects the Merge Data clearance check, and only when `mergeDataPath` is configured.
- One or two real `Code=` values from the lab's print-code table, so the golden-file test uses something realistic
- Your PIC Pro version. The spec notes behaviour differences at 2.5.56 (JBackprint replacing order-level Backprint1/2) and 2.6.x (container subdirectories).
