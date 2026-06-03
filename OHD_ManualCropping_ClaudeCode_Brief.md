# OHD Manual Cropping (M5) — Claude Code Brief

**Status:** Ready for implementation. Scope and contract locked with Richard 2026-05-24.

**Owner of this brief:** Richard Charnley (richard_charnley@pixfizz.com)

**Date:** 2026-05-24

**Prerequisite:** M1–M4 of the S3 Artwork Channel feature (see `OHD_S3ArtworkChannel_ClaudeCode_Brief.md`) — M5 builds on top of the M1 download pipeline, the M2 hold gate, and the M3 quantity math fix.

---

## Goal

Add a **batch crop mode** to the Job Review drawer for manual-source jobs. The operator opens a held manual job, sees all uploaded images with crop windows pre-positioned at the target print size, optionally toggles the batch orientation (Portrait ↔ Landscape), positions a default crop window on one image and applies it to all, then can override individual images using a film-review-style focused mode. Cropped production files land in `{jobPath}/working/`. When all images are cropped, the existing Send to Print flow dispatches them via the normal pipeline.

This is the manual analogue of Pixfizz Customer Originals Phase 2 — but instead of operating on a single image with a known customer-side crop, it operates on a batch of operator uploads with no prior crop. The output goes to the same place (`working/`), the dispatch contract is unchanged, and the M2 hold gate stays in front of auto-print.

---

## Locked-in scope (do NOT renegotiate without checking with Richard)

These are confirmed and shouldn't be re-litigated during implementation:

1. **Applies only to manual-source jobs.** The trigger is `job.artwork_source === 'manual'` (or any file with `artworkSource === 'manual'` in mixed jobs — Pixfizz/FTP jobs are unaffected). Existing Customer Originals Phase 1+2 handles the Pixfizz pre-crop case; M5 does NOT modify it.

2. **Target print size comes from the assigned route, pre-selected.** Read the resolved size from the job's routing config (the same value the existing "Crop to Size" dropdown shows). The operator does NOT choose it — it's dictated by the product code → size translation in the routing service. If the job has no route assigned (or no size translation), the batch crop button is disabled with a tooltip explaining why.

3. **Orientation toggle is batch-level, manual override per-image.**
   - Default orientation determined heuristically at job-open: pick whichever of Portrait or Landscape matches more of the images' native aspect ratios.
   - Operator can flip the batch default (one button) — applies to all *uncropped* images.
   - For images whose native orientation doesn't match the batch default, the crop window will not fit cleanly. **Do NOT auto-rotate the image.** Operator handles the mismatch in per-image focused mode.

4. **Production files live in `{jobPath}/working/`.** Same folder the existing dispatch flow already reads. Originals stay in the flat job folder for audit. Filename pattern: `{original_stem}_cropped.jpeg` (collision-resolved with `__id8` suffix if the operator re-crops, per the M1 convention).

5. **Crop status = file exists in `working/` AND sidecar entry's `filename` points at it.** Two conditions in AND. A stray `working/` file from a different code path doesn't count; a sidecar pointer to a missing file doesn't count.

6. **Send to Print is operator-triggered.** Same as today. The button stays disabled until all images in the job have crop status = true. No auto-dispatch.

7. **Film-review-style keyboard shortcuts** for the per-image focused mode (see §"UI flow" below).

---

## Architecture

### What's new

- **Renderer component:** a `BatchCropMode` view inside `JobReviewDrawer` that replaces the standard thumbnail grid for manual-source jobs when the operator enters batch crop mode. Contains: the batch orientation toggle, the "Apply default to all" button, the per-image crop overlay rendering, the progress indicator, and the launch point into focused per-image mode.
- **Renderer component:** a `FocusedCropFrame` modal/overlay (mirrors `FocusedFrame.jsx` from Film Review) for per-image override. Keyboard-driven, film-review patterns.
- **IPC channel:** `ohd:job:batch-crop-apply` — given a job, a default crop rect (in image-relative fractions, not pixels), and a list of file ids, the main process generates cropped JPEGs for each, writes them to `working/`, updates the sidecar.
- **IPC channel:** `ohd:job:crop-one` — same but for a single image with explicit pixel coordinates from focused mode. Convenience wrapper that already exists or can be reused from Customer Originals Phase 2 (`customerRecropActions.js`).

### What's reused (don't reinvent)

- **`sharp.extract({left, top, width, height}).jpeg({quality: 95})`** — the crop primitive. Customer Originals Phase 2 already uses this via `customerRecropActions.js`. Read that file before writing M5's crop code.
- **`CropEditor.jsx`** — the existing crop-window component with Portrait/Landscape toggle (shipped 2026-05-22, see `project_ohd_crop_orientation_toggle` memory entry). Reuse for the focused per-image mode; the batch overlay is a new lightweight read-only renderer.
- **Routing service's resolved size** — `routingService.resolveRouteForJob(job)` (or equivalent — Claude Code should locate the actual function name) returns the target size. Don't reimplement size derivation from product codes.
- **M2 hold gate** — manual jobs are already held. M5 doesn't touch the hold rule. Send to Print stays in front of dispatch.
- **`/working/` dispatch pipeline** — `print-service.sendReprint` already reads cropped files from `working/`. No dispatch changes.

---

## UI flow

### Entering batch crop mode

When the operator opens a manual-source job's Job Review drawer:

- If NO images have been cropped yet → drawer opens directly in batch crop mode. A "Crop All Images" header replaces the standard thumbnail grid.
- If SOME images have been cropped → drawer opens in standard mode. A "Batch Crop Remaining (X uncropped)" button is prominent. Operator clicks it to enter batch mode for the uncropped subset.
- If ALL images are cropped → standard mode, no batch button. The drawer behaves like a Pixfizz job (Send to Print enabled).

### Inside batch crop mode

Layout:
- Top bar: target size (read-only, e.g. "Target: 4×6"), orientation toggle (Portrait ▢ / Landscape ▣ — large, clearly visible), "Apply Default to All" button, progress (e.g. "0 / 23 cropped"), Exit button.
- Main area: a grid of thumbnails (same density as standard Job Review), each thumbnail with the current default crop window overlaid as a translucent rectangle. Thumbnails are click-targets to enter focused mode.
- Bottom bar: persistent "Send to Print" button — disabled with tooltip "Crop all images before sending" until all are cropped.

Orientation toggle behaviour:
- Flips the default crop window's aspect (e.g. 4:6 vertical ↔ 6:4 horizontal).
- Re-renders the overlay on every thumbnail, scaled to fit each image's bounding box.
- For images whose native aspect doesn't allow the chosen orientation to fit without empty bands, render the overlay anyway but tint it (e.g. amber outline) to signal "this one needs manual attention."
- Already-cropped images are NOT affected by orientation toggle changes.

Default crop window:
- Operator drags the window on any one thumbnail (or in focused mode) to establish the default.
- The position is stored as image-relative fractions (e.g. `{x: 0.1, y: 0.15, w: 0.8, h: 0.6}`) so it scales correctly across images of different dimensions.
- "Apply Default to All" iterates over uncropped images, scales the fractional rect to each image's pixel dimensions, calls the crop primitive, writes the result to `working/`, updates the sidecar.

### Focused per-image mode

Click a thumbnail (or press `[`/`]` to navigate from one focused frame to the next):

- Full-image view with the crop window overlaid, draggable + resizable (reuse CropEditor.jsx).
- Keyboard shortcuts mirroring `FocusedFrame.jsx`:
  - `[` / `]` — previous / next image
  - `R` / `→` — rotate image 90° CW (the IMAGE, not the crop window)
  - `L` / `←` — rotate image 90° CCW
  - `Enter` / `Space` — apply crop and auto-advance to next image
  - `Esc` — exit focused mode back to batch grid
  - `F` — flag for review (per existing pattern, optional for M5)
- The aspect ratio of the crop window is LOCKED to the target size's aspect. Operator can change orientation per-image via a toggle in the focused header (Portrait ↔ Landscape) — same control as the batch toggle, scoped to this image only.
- "Apply" writes the production file, advances to the next uncropped image automatically.

---

## Disk + sidecar contract

### Disk layout

```
{downloadDirectory}/
  {order_number}_{order_id}/
    {order_number}_{job_id}/
      <file_name>.jpg                       ← M1 download, raw upload (preserved as audit)
      working/
        <file_name>_cropped.jpeg            ← M5 production file (dispatch reads from here)
      {jobId}.json                          ← sidecar
```

### Sidecar additions

Per-image entry gains the M5b sibling fields alongside the existing pre-M5 ones. **Flat — no `crop: {...}` wrapper.** See §"Brief vs. as-built" under M5a for the rationale.

```jsonc
{
  // ... existing M1/M2/M3 fields ...

  // Pre-M5 (already shipped, used by manual + customer-original crops):
  "filename":         "IMG_0123.jpg",         // basename — UNCHANGED across crop
  "cropApplied":      true,                    // false until production file exists
  "croppedPath":      "<abs>/working/IMG_0123.jpg",  // absolute path; in-place overwrite of working/
  "cropRect":         { "x": 30, "y": 20, "w": 100, "h": 80 },  // image-space PIXELS (not fractions)
  "channelMappingId": "uuid-or-null",         // routing override per crop

  // M5b adds (flat siblings):
  "cropOrientation":  "portrait" | "landscape",
  "cropSource":       "batch" | "per-image",   // which UX produced this crop
  "cropAppliedAt":    "2026-05-25T...",

  // M5c adds (flat sibling):
  "cropRotation":     0                        // 0|90|180|270; baked into the file, persisted for audit
}
```

Note: `cropRect` is in image-space pixels (matches the pre-M5 contract). M5b's batch-default rect is stored at the job level in image-relative fractions because it has to scale across heterogeneous image dimensions; per-image entries snapshot the pixel rect that was actually applied.

Job-level additions (also flat — no `batchCrop: {...}` wrapper):

```jsonc
{
  // ... existing fields ...
  "batchCropDefaultRect":        { "x": 0.1, "y": 0.15, "w": 0.8, "h": 0.6 },  // FRACTIONS; last batch default
  "batchCropDefaultOrientation": "landscape",
  "batchCropLastAppliedAt":      "2026-05-25T..."
}
```

The job-level `batchCropDefault*` fields persist the operator's last-used default so re-opening the drawer mid-job (e.g. after a restart) restores the workflow state.

**`filename` is NOT rewritten on crop.** The cropped pixels live at `working/<filename>` (in-place overwrite); dispatch substitutes via `print-service._getEnhancedPathMap` (crop > enhance priority, file-existence-gated). See §"Brief vs. as-built" under M5a.

The raw upload file at the job folder root is NEVER deleted by M5. Audit / re-crop recovery.

---

## Implementation milestones

Three increments. Land in order. Don't start M5b until M5a is verified working end-to-end. Don't start M5c until M5b is verified.

### M5a — Single-image crop pipeline for manual jobs (foundation) — VERIFIED 2026-05-25

**Outcome:** No source code changes needed. The four functional outcomes the brief calls for already hold via the existing `ohd:job:crop-image` handler. Regression tests added to lock the contract; brief updated to reflect the as-built shape so M5b doesn't build a parallel structure.

#### Brief vs. as-built

The brief originally specified `working/{stem}_cropped.jpeg` + `filename` rewrite. **The existing implementation is functionally equivalent but mechanically different:**

| Brief wording | As-built |
|---|---|
| Output at `working/<stem>_cropped.jpeg` | Output at `working/<filename>` (in-place overwrite of the working copy, atomic via `.crop_tmp` + rename) |
| Sidecar `filename` rewritten to cropped path | Sidecar `filename` STAYS the original basename; `cropApplied: true` + `croppedPath` (absolute) + `cropRect` + `channelMappingId` are added as sibling fields |
| Dispatch reads cropped path directly | Dispatch substitutes via `print-service._getEnhancedPathMap` (crop > enhance priority, file-existence-gated) |
| Raw upload preserved at job folder root | Same — handler reads/writes only within `working/`; the flat upload is never touched |

**Why the as-built shape is load-bearing (do NOT change in M5b):**

1. `originalsManager.resetImage(filename)` reads `{jobPath}/originals/<filename>` → copies to `{jobPath}/working/<filename>`. If the sidecar's `filename` were rewritten to `..._cropped.jpeg`, reset on a cropped image would look for `originals/..._cropped.jpeg` and fail.
2. `ai-job-quality-orchestrator._scanJobImages` enumerates `working/` and keys scoring results by basename. A renamed filename would orphan prior scores.
3. `reprintManager` and renderer state (selected image, file-strip labels) all key by basename. A rename produces ghost rows.
4. `print-service._getEnhancedPathMap`'s crop-over-enhance priority is the single substitution point — the dispatch contract is already correct without any other readers having to change.

Per-image metadata that M5b/M5c add (orientation, source, timestamp) MUST land as **flat sibling fields** on each sidecar entry, NOT as a nested `crop: {...}` wrapper. The flat convention matches the existing `cropApplied / croppedPath / cropRect / channelMappingId` shape and avoids a migration step against on-disk sidecars.

#### As-built field reference

Per-image sidecar entry (after a manual crop):

```jsonc
{
  // ... existing M1-M4 fields ...
  "filename":         "manual-upload.jpg",       // UNCHANGED — the basename
  "cropApplied":      true,                       // shipped pre-M5
  "croppedPath":      "<abs>/working/manual-upload.jpg",  // shipped pre-M5
  "cropRect":         { "x": 30, "y": 20, "w": 100, "h": 80 },  // shipped pre-M5
  "channelMappingId": "uuid-or-null",             // shipped pre-M5
  // M5b will add (flat siblings — NOT nested under crop: {...}):
  //   cropOrientation: "portrait" | "landscape"
  //   cropSource:      "batch" | "per-image"
  //   cropAppliedAt:   "2026-05-25T…"   ISO timestamp
  //   cropRotation:    0 | 90 | 180 | 270    (M5c — baked into the file, persisted for audit)
}
```

Job-level sidecar additions for M5b stay flat at the top level too:

```jsonc
{
  // ... existing top-level fields ...
  "batchCropDefaultRect":        { "x": 0.1, "y": 0.15, "w": 0.8, "h": 0.6 },
  "batchCropDefaultOrientation": "landscape",
  "batchCropLastAppliedAt":      "2026-05-25T…"
}
```

(The original brief's `batchCrop: { defaultRect, defaultOrientation, lastAppliedAt }` nested object is replaced with the three top-level fields above. Same reason: no migration, no parallel structure.)

#### Verification

Two test files lock the contract:

- `src/main/services/__tests__/manualCrop.test.js` — five integration tests against the `ohd:job:crop-image` handler (captured via stubbed `ipcMain.handle`): real sharp + real fs in a tempdir. Asserts the four-point contract verbatim plus re-crop idempotency.
- `src/main/services/__tests__/manualCrop.dispatch.test.js` — six tests against `print-service._getEnhancedPathMap`: crop > enhance priority, file-existence gate, plain-row fall-through, stale-pointer gating, multi-image independence.

If any of these fail in the future, M5b/M5c's batch-crop machinery (which assumes single-image crop works correctly) will silently produce dispatchable-but-wrong output.

### M5b — Batch crop UI + propagation — VERIFIED 2026-05-25

**Outcome:** Shipped. 14 new regression tests in `batchCrop.test.js` lock the integration + scaling + failure-handling contracts; full suite 520/520 (was 506 → +14). Renderer bundle rebuilt; visual verification pending against a live manual job.

Key as-built decisions worth recording:

- **Failure policy is continue-best-effort, not abort-on-first.** Per-image failures land in `failed[]`; successful images persist either way. Operator surfaces all failures from one batch run rather than serially discovering them. Safety belt at 10 consecutive same-error-code failures aborts the remainder (reason `consecutive-same-error`) so a systemic failure (network drive unmounted, sharp init crash) doesn't spin through a 100-image job.
- **Crop primitive is shared.** The M5a body of `ohd:job:crop-image` was extracted into `batchCropActions._applyCropToSingleImage`; both IPCs call the same function. M5a's 11 tests still exercise the per-image IPC end-to-end and stay green — the extraction is mechanical, the external contract unchanged.
- **Concurrency is strictly serial within a job.** No per-image parallelism — libvips cache + SMB write sensitivity make it risky here.
- **Target size never silently defaults.** `ohd:job:resolve-target-size` returns `{ ok: false, reason }` when no route is assigned or the route has no size translation. The batch CTA is disabled with a tooltip; operator must assign a route first.
- **No nested `crop:{...}` wrapper.** Per-image fields land as flat siblings (`cropOrientation`, `cropSource`, `cropAppliedAt`, `cropRotation`) alongside the pre-M5 `cropApplied / croppedPath / cropRect / channelMappingId`. Job-level fields likewise flat (`batchCropDefaultRect`, `batchCropDefaultOrientation`, `batchCropLastAppliedAt`). No on-disk sidecar migration needed.

**Files to add:**
- `src/renderer/views/JobReview/BatchCropMode.jsx` — new component
- `src/renderer/job-review.css` — styles for batch mode (overlay rects, orientation toggle, progress)

**Files to modify:**
- `src/renderer/views/JobReview/index.jsx` (the drawer root) — detect manual-source jobs, route to batch mode when uncropped images exist
- `src/main/ipc-handlers.js` — add `ohd:job:batch-crop-apply` IPC handler. The handler is a loop around the existing `ohd:job:crop-image` body (or a shared helper extracted from it); per-image output stays at `working/<filename>` (in-place overwrite). Do NOT introduce a `_cropped.jpeg` suffix or rewrite `entry.filename` — see §"Brief vs. as-built" under M5a.
- `src/shared/jobSchema.js` — extend per-image schema with the flat M5b sibling fields (`cropOrientation`, `cropSource`, `cropAppliedAt`) alongside the existing `cropApplied / croppedPath / cropRect / channelMappingId`. Extend job-level schema with `batchCropDefaultRect`, `batchCropDefaultOrientation`, `batchCropLastAppliedAt` (also flat — no `batchCrop: {...}` wrapper).
- `src/main/jobs/sidecarManager.js` — Reconcile pass D for the new fields (in-memory hydration only, no spurious save — mirror M1's pattern)

**Behaviour:**
- Drawer-open on a manual job with uncropped images → BatchCropMode renders
- Target size auto-selected from routing (read-only display)
- Default orientation chosen heuristically (most-common aspect among job's images)
- Operator drags default crop on any thumbnail → updates job-level `batchCropDefaultRect`
- "Apply Default to All" → calls `ohd:job:batch-crop-apply` → main process iterates uncropped images, scales the fractional rect to each, writes production files, updates sidecar in one transaction
- Progress indicator updates per-image as files land

**Test plan for M5b:**

- Manual job with 5 images, all landscape. Apply default crop. Confirm 5 production files in `working/`, all sidecar entries updated, progress reads "5/5 cropped"
- Apply with mixed orientations (some portrait, some landscape, batch orientation = landscape). Portrait images get amber-outlined overlay (warning). After Apply All, portraits still get cropped to the landscape rect but the result may have empty bands — operator can re-crop in focused mode if needed.
- Re-poll a job after batch apply (simulating OHD restart): drawer re-opens, all crops persist, no re-crop happens, Send to Print is enabled.

### M5c — Focused per-image override mode

**Files to add:**
- `src/renderer/views/JobReview/FocusedCropFrame.jsx` — new component, mirrors `FocusedFrame.jsx` from Film Review

**Files to modify:**
- `BatchCropMode.jsx` (from M5b) — thumbnail click → opens FocusedCropFrame
- `src/renderer/views/JobReview/index.jsx` — keyboard event routing when focused mode is active

**Behaviour:**
- Click any thumbnail in batch mode → opens FocusedCropFrame for that image
- Reuse CropEditor.jsx for the crop window (drag + resize, aspect locked to target size)
- Keyboard shortcuts:
  - `[` / `]` — previous / next image in the job
  - `R` / `→` — rotate image 90° CW
  - `L` / `←` — rotate image 90° CCW
  - `Enter` / `Space` — apply crop, auto-advance
  - `Esc` — back to batch grid
- Per-image orientation toggle (Portrait ↔ Landscape) in the focused header
- "Apply" writes the production file (overwriting any previous crop), updates sidecar

**Test plan for M5c:**

- After batch apply, click any image, re-crop it in focused mode, confirm production file is replaced with new content (or new collision-renamed file written, depending on naming policy — pick one and document)
- Navigate forward/back through 5 images via `[` / `]`, rotate one, crop, advance — confirm each step persists
- Rotate an image 90° CW. The rotation should be baked into the production file (sharp.rotate() before extract), not just metadata. Verify by opening the cropped file in an image viewer and confirming the orientation.
- Esc from focused mode → returns to batch grid with all changes intact

---

## Behaviour rules (canonical reference)

### When does the drawer enter batch crop mode?

```
if job.artwork_source !== 'manual' AND no images have file.source === 'manual':
  standard Job Review mode (today's behaviour)
else if all images have cropApplied === true:
  standard mode, Send to Print enabled
else:
  batch crop mode (or button to enter it if some are already cropped)
```

### What counts as "cropped"?

```
image.cropApplied === true
  AND image.croppedPath is set
  AND file exists at image.croppedPath
```

Three conditions in AND. The sidecar-only state without a file on disk doesn't count (re-crop is needed). A file without the sidecar pointer doesn't count (orphan from a previous run). `image.filename` stays unchanged across the crop — see §"Brief vs. as-built" under M5a. Dispatch substitution flows through `print-service._getEnhancedPathMap` which checks the same three conditions.

### Send to Print gate

```
send_to_print_enabled =
     job._holdForReview is unchanged from M2 (we don't relax it)
  AND every image in job.images[] has cropApplied === true (the M5 gate)
```

The hold-for-review chip stays visible until both gates pass. The button tooltip explains which gate is failing.

### Default orientation selection

```
on drawer-open for a manual job in batch mode:
  count_portrait = images where native_height > native_width
  count_landscape = images where native_width > native_height
  default_orientation = whichever count is larger
  (ties → landscape, since 4x6 prints are conventionally landscape)
```

This is a one-time computation at drawer-open. Operator can override via the orientation toggle thereafter.

### Production file naming + collisions

```
production_filename = {stem(original.file_name)}_cropped.jpeg
if exists(working/production_filename) with different content hash:
  production_filename = {stem(original.file_name)}_cropped__{id.slice(0,8)}.jpeg
```

Same collision rule as M1's flat-folder pattern. Each re-crop overwrites the previous production file by default (operator just wants their latest crop); if you want to preserve history, the collision rule kicks in. Default policy: overwrite. Document in the code comment.

---

## Out of scope (do NOT build)

- **Auto-dispatch** — Send to Print stays manual.
- **Pixfizz job cropping** — Customer Originals Phase 2 handles the Pixfizz re-crop case. M5 only fires on `artwork_source === 'manual'`.
- **Multi-aspect crop within one job** — assume one target size per job (from the route). Mixed-aspect jobs are not supported in M5.
- **Image rotation persisted as metadata only** — rotation is baked into the production file via `sharp.rotate()` before extract.
- **Flag for reprint flow** — the `F` shortcut is optional and can be no-op in M5; Job Review's existing "Flag all for reprint" button is enough.
- **Crop history / undo** — the operator's latest crop wins. Previous production files may be left on disk via the collision-rename path but there's no UI to recover them in M5.

---

## References to existing code (read before implementing)

These are the load-bearing files M5 builds on. Read each before writing code:

- `src/main/jobs/customerRecropActions.js` — sharp.extract + .rotate + .jpeg({quality:95}) pattern. M5's crop primitive should match.
- `src/main/jobs/customerOriginalsActions.js` — IPC pattern for crop actions on a single job.
- `src/renderer/views/FilmReview/FocusedFrame.jsx` — keyboard navigation pattern, focused-mode UI shape. Lines 23, 97–112 are the keymap definitions.
- `src/renderer/views/FilmReview/RollReview.jsx` — list-view ↔ focused-view navigation.
- `src/renderer/views/JobReview/index.jsx` — the drawer root. Where M5's mode-routing slots in.
- `src/renderer/views/JobReview/CropEditor.jsx` — existing crop window component with Portrait/Landscape toggle (shipped 2026-05-22). Reuse for focused mode.
- `src/main/services/routing-service.js` — `resolveRouteForJob` or equivalent. Source of truth for target print size.
- `src/main/services/print-service.js` — `sendReprint` orchestrator. M5's production files flow through this unchanged.

Memory entries to consult:
- `project_ohd_customer_originals_phase1` — Customer Originals Phase 1+2 subsystem context
- `project_ohd_crop_orientation_toggle` — the existing orientation toggle in CropEditor.jsx
- `project_ohd_reprint_dispatch` — sendReprint orchestrator behaviour
- `project_ohd_darkroom_strict_media` — channel-dictated sizing context
- `project_ohd_s3_artwork_channel` — M1-M4 context
- `feedback_production_ready_manual_only` — the source-based gating pattern (source === 'manual' is the trigger)

---

## Acceptance checklist (whole feature)

Before declaring M5 done, all of these must be true:

- [ ] A fresh manual-source job with N images (N ≥ 5) opens directly in batch crop mode
- [ ] Target size is pre-selected and read-only, sourced from the routing service
- [ ] Default orientation matches the majority of images' native aspect
- [ ] Operator can flip the batch orientation; overlay rects update on all uncropped thumbnails
- [ ] Dragging the crop window on one thumbnail updates the default; "Apply Default to All" produces production files for every uncropped image
- [ ] Production files are valid JPEGs at the target aspect; landing in `{jobPath}/working/`
- [ ] Sidecar entries are updated: each image's `cropApplied: true`; `croppedPath` is absolute and points at `working/<filename>`; `cropRect`, `cropOrientation`, `cropSource`, `cropAppliedAt` persisted; `filename` field UNCHANGED (the in-place-overwrite contract from M5a)
- [ ] Progress indicator updates per-image as production files land
- [ ] Send to Print is disabled until all images are cropped; enabled once all are
- [ ] Send to Print dispatches the cropped files through the existing pipeline (verify the controller actually prints them, not the raw uploads)
- [ ] Clicking any thumbnail opens focused mode; keyboard shortcuts `[`/`]`/`R`/`L`/Enter/Esc work as specified
- [ ] Rotating an image 90° in focused mode bakes the rotation into the production file (not metadata-only)
- [ ] Re-cropping an image in focused mode overwrites its production file; sidecar updates
- [ ] Pixfizz/FTP jobs are unaffected — open one, confirm Customer Originals Phase 1+2 still works as before
- [ ] No regressions in `OHD_CustomerOriginals_ClaudeCode_Brief.md` acceptance tests
- [ ] No regressions in M1–M4 (S3 download, hold gate, qty math, original-files routing)
- [ ] CHANGELOG entry written under the current version with the three M5 increments

---

## Notes for the implementer

- **Reuse aggressively.** Customer Originals Phase 2's `customerRecropActions.js` already implements the crop primitive correctly. The new IPC handler should call the same underlying function, just in a loop for batch.
- **The rotation needs to be baked into the file**, not stored as a sidecar field. `sharp.rotate(N).extract({...}).jpeg({quality:95})` is the correct chain. The rotation needs to happen BEFORE the extract because the rect's coordinates are relative to the rotated image.
- **Image-relative fractions, not pixels.** The default crop rect is stored as fractions (`x: 0.1, y: 0.15, w: 0.8, h: 0.6`) so it scales correctly across images of different dimensions. When applying, multiply by the target image's width/height to get pixel coordinates.
- **Aspect-locking the crop window to the target size.** The crop rect's `w/h` ratio is locked to the target size's aspect. Operator can drag the position and resize uniformly (keeping aspect), but cannot change the aspect ratio independently. This is the same lock CropEditor.jsx already does in Customer Originals Phase 2.
- **Don't touch dispatch.** The point of writing production files to `working/` is that the existing `print-service.sendReprint` flow works unchanged. If you find yourself reaching into print-service.js, you're probably over-scoping.
- **Test with at least 25+ images** to verify the batch flow performs reasonably. 100+ is the design target; 25+ is the minimum to catch perf issues.

End of brief.
