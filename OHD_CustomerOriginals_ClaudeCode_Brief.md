# OHD Customer Originals — Claude Code Implementation Brief

## Overview

Pixfizz Core ships two copies of every image with a print order: the **printable JPEG** (already cropped to the ordered print size by the customer in Pixfizz Core) and the **customer original** (the file the customer uploaded before cropping). Both are downloaded to disk by OHD today, but only the printable copy is surfaced in Job Review.

This feature exposes the customer originals to the operator in two phases:

- **Phase 1 — Locate & view.** Job Review shows a small thumbnail of the original next to each image, plus two row actions: *Open original* (OS default viewer) and *Show original in folder* (Explorer/Finder, with the file pre-selected).
- **Phase 2 — Re-crop & dispatch.** The existing crop editor gains a "Source: customer crop / original" toggle. When *original* is selected, the cropper loads the uncropped upload, the aspect ratio is locked to the size resolved via routing, and the operator can produce a new printable JPEG that is then dispatched through the existing `sendReprint` orchestrator. The customer's printable JPEG is preserved alongside (never overwritten).

This brief was produced from a design discussion with the lead developer. The decisions below are locked in — do not relitigate them, but flag if implementation reveals one to be infeasible.

---

## Scope and order

Ship **Phase 1 first** as its own change. It's self-contained, low-risk, and immediately useful. Do not start Phase 2 until Phase 1 is merged and shipped. Phase 2 design notes are included in this brief so the schema and intake plumbing land once.

---

## Locked design decisions

1. **AI quality scoring never runs on customer originals.** Today this is true by construction — `_scanJobImages` in `src/main/services/ai-job-quality-orchestrator.js` reads job root + `/working/` fallback only, and never descends into subfolders. Since customer originals live in `original-files/`, they are out of the scanner's reach. Do not add a new path that would expose original files to the scorer. If you introduce a new scoring entry point or change how images are enumerated, keep `original-files/` excluded.
2. **Keep both files on re-crop.** The customer's printable JPEG must remain on disk after a re-crop. The re-cropped output writes to a sibling location (`{jobPath}/recrops/` — see Phase 2). The job's image record then re-points to the new file; the old print JPEG stays.
3. **Per-image modal cropper.** Re-cropping is a per-image action. No batch re-crop UI in this feature.
4. **Unified cropper with a source toggle.** The existing `CropEditor.jsx` gets a single new control: source = `customerCrop | original`. Do not create a second cropper component.
5. **Re-score on re-crop, gated on the existing artwork-on-disk rule** (shipped 2026-05-12). Re-cropping replaces the image source for the row; the next scoring pass picks it up naturally provided the new file lives where `_scanJobImages` can see it. See *Phase 2 — Scoring re-cropped output* below for the routing.
6. **No flag, no toggle, no order-source check on the UI surface.** The presence of `originalFilename` on the image record is the only gate. No `originalFilename` → no buttons, no thumbnail, no toggle. Older orders, non-Pixfizz orders, and any image that simply didn't ship an original all degrade silently.
7. **Pixfizz orders only.** The data shape itself enforces this — only Pixfizz manifests carry `originalFilename`. No additional check needed.

---

## Folder layout — no collision

Customer originals land in their own folder: `{jobPath}/original-files/{N}-{customerUploadName}` (e.g. `PXDEMO-AD31D5_38432891/original-files/1-IMG-20240602-WA0013b.jpg`). This is a deliberate Pixfizz Core decision to keep customer uploads physically separate from OHD's existing `{jobPath}/originals/` folder, which is the local edit-history backup managed by `src/main/jobs/originalsManager.js` (snapshotted from `/working/` so operator edits can be reverted).

**Implementer note:** do not hardcode the folder name `original-files` in OHD. The manifest's `originalFilename` field carries the full relative path from the order root (see *Filename patterns* below), so OHD resolves paths directly from the manifest and stays agnostic to where Pixfizz Core puts the files. If Core later moves the folder, no OHD change is needed.

No changes to `originalsManager.js` are required for this feature.

---

## Filename patterns and path resolution

From the manifest JSON (delivered as `{orderDir}/{orderNumber}.json`):

```json
{
  "orderNumber": "PXDEMO-AD31D5",
  "jobs": [{
    "jobId": "38432891",
    "images": [{
      "filename":         "PXDEMO-AD31D5_38432891/PXDEMO-AD31D5_38432891_IMG-20240602-WA0013b.jpg_Q1_pages1.jpeg",
      "originalFilename": "PXDEMO-AD31D5_38432891/original-files/1-IMG-20240602-WA0013b.jpg",
      "size": "4x6",
      "quantity": 1
    }]
  }]
}
```

Resolution rules:

- `originalFilename` is **relative to the order root** (the parent of `jobPath`).
- Absolute path: `path.join(path.dirname(jobPath), img.originalFilename)`.
- Sidecar storage: store the **full relative path from the manifest verbatim** (e.g. `PXDEMO-AD31D5_38432891/original-files/1-IMG-20240602-WA0013b.jpg`) in `ImageEntry.originalFilename`. This keeps OHD agnostic to Pixfizz Core's folder naming — no `original-files` string baked into OHD code paths.
- `originalFilename` is **optional**. Treat any falsy/missing value as "no original available" and degrade silently.
- The `size` field can be empty (`""`). Size is resolved at print time via routing on the product code; do not depend on it. See Phase 2.

---

## Phase 1 — Locate & view customer originals

### Goal

Operator can, for any image in Job Review, see the uncropped customer upload as a small thumbnail and open or locate the file on disk.

### Files to change

| File | Change |
|---|---|
| `src/shared/jobSchema.js` | Add `originalFilename: null` to `createImageEntry()`. Update the JSDoc `ImageEntry` typedef. **Do not** set this in `resetImageEntry` (the reset semantics shouldn't drop the link to the original). |
| `src/main/ipc-handlers.js` | Extend `_buildManifestQuantityMap` (or add a sibling `_buildManifestImageMetaMap`) so a single manifest parse produces both quantity and originalFilename per filename. Pass the additional data into `loadSidecar` so first-time sidecar creation populates `originalFilename`. |
| `src/main/jobs/sidecarManager.js` | Widen `loadSidecar`'s third parameter from `quantityMap` to a `metaMap` of `{ filename → { qty, originalFilename } }`. Update both the "fresh sidecar" path and the "reconcile new files" path to use the meta when creating an `ImageEntry`. Keep backward compatibility — `null`/missing meta still works. Reconcile pass must also **back-fill** `originalFilename` on existing entries whose value is null (so sidecars created before this change pick up the field on next load). |
| `src/main/ipc-handlers.js` (new IPC handlers) | `ohd:original:reveal` — calls `shell.showItemInFolder` on the absolute path. `ohd:original:open` — calls `shell.openPath`. Both take `{ jobPath, originalFilename }` (the relative path stored in the sidecar entry). Both resolve to absolute via `path.join(path.dirname(jobPath), originalFilename)`. Return `{ ok: boolean, error?: string }`. Both validate the file exists before invoking shell; return `{ ok: false, error: 'not-found' }` if missing (defence against race / partial download / manual deletion). |
| `src/preload/preload.js` | Expose `originalReveal` and `originalOpen` on the renderer's `ohd` bridge. |
| `src/renderer/views/JobReview/ThumbnailCard.jsx` | New small thumbnail in the card footer (or a hover-revealed inset — implementer's call, keep it unobtrusive). Two icon buttons next to it: "Open original" (default-viewer icon) and "Show in folder" (folder icon). All three render *only when* `image.originalFilename` is truthy. The original thumbnail uses an `<img src="file://...">` reference — no decoding pipeline. |
| `src/renderer/views/JobReview/useJobReview.js` | Add the wiring for the two new actions; no state changes required. |
| `src/renderer/styles/job-review.css` | Style for the original thumbnail and the two new icon buttons. Use existing `--app-*` tokens (see memory: app-wide token system). |

### Acceptance criteria

1. Open Job Review on a job downloaded with `originalFilename` present in the manifest. Each card shows the small original thumbnail and the two action icons.
2. Open Job Review on a job whose manifest does not carry `originalFilename` (or where the field is missing for some images but not others). Cards without originals show no thumbnail and no action icons. Cards with originals show them. No console errors. No empty placeholders.
3. Click "Open original" → file opens in the OS default image viewer.
4. Click "Show in folder" → Explorer/Finder opens with the file pre-selected.
5. Manually delete a customer original from disk, then click "Open original" → UI shows a small inline error ("Original file no longer on disk"), no crash, no shell launch.
6. Open a job that pre-dates this change (sidecar already exists, `originalFilename` not yet in entries). On load, the reconcile pass back-fills `originalFilename` from the manifest, and the card behaves as in (1) on next render.
7. Edit an image (apply CMY corrections), save the sidecar, and reset to original. Reset works correctly — existing `originalsManager` behaviour is unaffected by this feature because customer originals live in a separate folder (`original-files/`, not `originals/`).
8. With AI quality enabled and `forceRescore` off, open a job containing customer originals. AI scoring runs against the printable JPEGs only; no scoring entry is created for the `1-*.jpg` customer originals. Sidecar `images[]` length equals the count of printable JPEGs.

### Tests to add

- Unit: `src/main/jobs/__tests__/sidecarManager.test.js` — `loadSidecar` populates `originalFilename` when meta is supplied; reconcile back-fills the field on legacy entries; null/missing meta degrades to current behaviour.
- Unit: `src/shared/__tests__/jobSchema.test.js` (or wherever schema tests live) — `createImageEntry` defaults `originalFilename` to `null`.
- IPC integration: stub `shell.showItemInFolder` and `shell.openPath`; verify the handlers validate file existence first and return `{ ok: false, error: 'not-found' }` cleanly.

### Out of scope for Phase 1

- No cropping. No new printable output. No routing or dispatch changes.
- No film-review surface — this is Job Review only. (Film Review is scan QC; do not conflate.)
- No batch "open all originals" or "show originals folder" command.

---

## Phase 2 — Re-crop original and dispatch (design notes, not for first PR)

### Flow

1. Operator opens the existing crop editor on an image.
2. New control inside the editor: **Source** = `Customer crop` (default) | `Original`. Toggle is disabled and hidden when `originalFilename` is null.
3. Switching to *Original* loads the customer upload into the cropper. Aspect ratio is **locked to the print size resolved via the existing routing layer** — call into the same product-code-to-size resolver the print path uses (the one referenced by `resolveMedia` and the strict-media-resolution work). Do not trust manifest `size`. If routing returns "no translation" for the product, the toggle is disabled and a short hint is shown (existing unroute + Assign flow handles the actual media assignment).
4. Operator drags the crop frame on the original, confirms.
5. OHD encodes a new JPEG with `sharp` (`.extract()` + `.jpeg({ quality: 95 })`). Honor the existing `sharp.cache(false)` startup guard (see memory: sharp/libvips EPERM on SMB).
6. Output is written to `{jobPath}/recrops/{originalBasename-without-ext}_{timestamp}.jpeg`. The `recrops/` folder is created lazily on first re-crop.
7. The image's sidecar entry is updated:
   - `recropPath`: absolute path to the new file
   - `recropOf`: original basename used as source
   - `recroppedAt`: ISO 8601 timestamp
   - `aiQuality`: reset to `{ scored: false, ... }` (forces re-score on next pass per the artwork-on-disk gate)
8. The next print dispatch for this image (or an immediate "Print re-crop" CTA) calls the existing `sendReprint` orchestrator. The orchestrator handles route resolution, controller-type dispatch, and the Darkroom-Pro strict-media-resolution flow with no changes — it just sees a different source path.

### Scoring re-cropped output

For `_scanJobImages` to pick up the re-cropped file naturally:
- Either re-cropped files are symlinked / hardlinked / copied into `/working/` with a unique name and the row's working filename is updated, OR
- `_scanJobImages` is extended to also include `recrops/` (with a filename pattern guard).

The first option is cleaner — it keeps the scoring scanner unchanged and treats the re-crop as a new image source for the row. Implementer to pick during Phase 2 design.

### Schema additions (Phase 2)

```js
recropPath:   null,  // absolute path; null until first re-crop
recropOf:     null,  // bare basename of the customer original used as source
recroppedAt:  null,  // ISO 8601
```

These can be **landed in Phase 1** as null-defaulted fields in `createImageEntry` if it's cheaper to do one schema bump than two — that's the implementer's call.

### Out of scope for Phase 2

- Multi-image batch re-crop UI.
- Free-aspect cropping (always locked to routed size).
- Re-cropping on Film Review.
- Any change to how the customer crop is stored or rendered — only the *source* of the cropper changes.

---

## Glossary

- **Customer original / upload** — the file the customer uploaded before any cropping. Lives at `{jobPath}/original-files/{N}-{name}.jpg`. Read-only from OHD's perspective. Path comes from the manifest; do not hardcode the folder name in OHD.
- **Printable JPEG / customer crop** — the file Pixfizz Core produced from the customer original after their in-Core crop. Lives at the job root and is mirrored into `/working/` on first Job Review open.
- **Edit-history backup** — local snapshot of the printable JPEG taken before the operator's first edit, used by `originalsManager` to support reset. Lives at `{jobPath}/originals/`. Distinct from `original-files/` and unaffected by this feature.
- **Re-crop** — a new printable JPEG produced by the operator from the customer original. Lives in `{jobPath}/recrops/`. Phase 2 only.

---

## Memory cross-references (context the implementer should be aware of)

- `project_ohd_sharp_smb_eperm` — `sharp.cache(false)` at startup is mandatory; encoding the re-cropped output must honor it.
- `project_ohd_ai_scoring_artwork_gate` (shipped 2026-05-12) — the "no scoring entry until artwork on disk" rule is what allows re-score on re-crop to work cleanly.
- `project_ohd_reprint_dispatch` — Phase 2 dispatch goes through `print-service.sendReprint`, which already handles route resolution per controller type. Do not bypass it.
- `project_ohd_styling_systems` — all new UI must use `--app-*` tokens; no hard-coded colours.
- `project_film_review_vs_job_review` — this feature is **Job Review only**. Film Review is scan QC, a different domain.
