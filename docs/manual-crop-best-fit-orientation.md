# Manual Crop — auto best-fit crop-box orientation

**Status:** Shipped 2026-07-23
**Scope:** Manual Crop / Job Review (`ManualCropMode`) and the standalone
CropEditor drawer.

## What changed

When seeding a fresh image's crop box, the default orientation now matches
the **image's** own aspect, not the target size's:

- Landscape source (`naturalWidth >= naturalHeight`) → landscape crop box
- Portrait source (`naturalWidth < naturalHeight`) → portrait crop box
- Square source → falls back to the target size's own orientation

This changes **crop-box aspect orientation only**. It does NOT touch image
rotation (`pendingRotation` / the L/R rotate buttons).

Previously the default came from the target size's aspect, so a landscape
photo on a 4×6 target got a portrait box until the operator manually flipped
it every single time. That was noisy and error-prone on rolls where most
images share one shape but a handful are flipped the other way.

## Decisions

1. **Per-image only.** Each image auto-orients to its own shape. A manual
   Portrait / Landscape flip sets only that image's `pendingOrientation` —
   it does NOT propagate to other images. This replaces the pre-2026-07-23
   `sessionOrientation` memory that made every image follow the operator's
   last toggle.
2. **Approve All also uses best-fit.** Bulk-approve orients each image by
   its own shape, not one shared orientation. Images the operator
   explicitly flipped keep their choice via `pendingOrientation`.
3. **Saved/approved crop rects are respected.** Best-fit only seeds fresh
   or untouched images — an already-approved image keeps the orientation
   implied by its saved `cropRect` on reopen.

## Square targets

Non-behaviour: square targets are unaffected — the Portrait/Landscape
toggle stays hidden and every crop is square regardless of source aspect.
`effectiveAspect` returns `1` for a square target so the resolved
orientation string is orientation-invariant at that point.

## Where it lives

| Concern | File | Function / lines |
|---|---|---|
| The decision function | `src/shared/cropRectMath.js` | `bestFitOrientation(w, h, fallback)` |
| CropEditor's crop-box default | `src/renderer/views/JobReview/CropEditor.jsx` | orientation resolution (~line 297) + `onNaturalSize` emit |
| ManualCropMode toggle state | `src/renderer/views/JobReview/ManualCropMode.jsx` | `naturalByFilename` state + `CropStage`'s per-image orientation chain |
| ManualCropMode Approve/Approve-All | `src/renderer/views/JobReview/ManualCropMode.jsx` | `approveAndAdvance` + `approveAll` — both compute per-image `cropOrientation` and pass it to `jobCropImage` |
| Batch driver (dormant from renderer) | `src/main/jobs/batchCropActions.js` | `applyBatchCrop({ orientation: 'auto', perImageOrientations })` |

## Tests

- `src/shared/__tests__/cropRectMath.test.js` — direct unit tests for
  `bestFitOrientation`: landscape / portrait / square+fallback / invalid dims /
  fallback respected / default fallback.
- `src/main/services/__tests__/batchCrop.test.js` — seven integration cases
  under the `auto orientation:` prefix: landscape source, portrait source,
  mixed batch, per-image override map wins, square target invariance,
  explicit non-auto regression lock, invalid-payload rejection.

The React live path (`CropEditor` + `ManualCropMode.approveAll`) has no
unit-test harness in this repo; it's covered by manual verification.

## Manual verification checklist

- [ ] Open a mixed-orientation roll — first image with a landscape source
      shows a landscape 4×6 crop box on load with no operator flip.
      Navigate to a portrait source — box flips to portrait automatically.
- [ ] Toggle Portrait on a landscape source, navigate to the next image
      (also landscape) — the next image is still landscape (per-image only,
      no session leak).
- [ ] Approve All on a roll with mixed orientations — every image gets a
      shape-appropriate crop rect; the sidecar's `cropOrientation` matches
      each image's source aspect.
- [ ] Open the standalone CropEditor drawer on an already-approved image —
      the saved crop rect and its implied orientation are preserved (no
      best-fit override).
- [ ] Square target (e.g. 8×8) — Portrait/Landscape toggle is hidden and
      crop is square regardless of source aspect.
