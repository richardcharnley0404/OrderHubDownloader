# Phase 1 Implementation Plan — AI Quality Gate

**Scope:** Local-only quality scoring of every image in every job (Mode 1 FTP polling pipeline), with a job-level hold when any image scores below an operator-configurable threshold. Held jobs surface in the existing Jobs grid via the Flags column with a count badge (e.g. `3/400`). Operator opens the held job into a new dedicated **Quality Review** tab — a sibling of the existing Film Review tab, built in the same two-stage list → focused-image style — sees only the failed images by default, runs a manual or batch fixup using a chosen AI model, and approves the job to release for routing. The existing Job Review drawer is unchanged. No auto-enhancement. No model lazy-download from S3 (models bundled with the installer). No changes to Mode 2/Mode 3 pipelines or print controllers.

**Source of truth for this plan:** `ARCHITECTURE.md` at the repo root, plus the PW-007 Phase 1 plan (`phase-1-implementation-plan.md`) which establishes the conventions for ONNX integration in OHD. This plan extends those conventions; it does not invent parallel patterns. The implementer should verify line-level specifics against the live source tree, especially `enhancementManager.js` (provider system the new local provider slots into) and the existing Activity Log entry format.

**Hard prerequisite:** PW-007 (Film Scan Auto-Rotation) must land first, *and* its ONNX inference must be moved out of the main process into an Electron `utilityProcess` before this work begins. See Section 12 — without that refactor, both AI features compete for the main event loop on every customer image. Doing the move once, as part of PW-007 finalisation, is far cheaper than retrofitting it later for two features at once.

---

## 1. Design principles (non-negotiable)

- **Feature flag, default OFF.** ONNX runtime and models ship in the installer unconditionally, but the quality-scoring step only executes when `config.aiQuality.enabled === true`. New labs opt in explicitly. Same posture as PW-007.
- **Operator stays in the loop.** The system never auto-modifies an image without explicit operator action. It scores, it holds, it surfaces — the operator decides whether to fix, override, or reject.
- **Graceful failure everywhere.** If the model fails to load, inference throws, or scoring produces garbage, the affected job continues through the existing pipeline as if the feature were OFF. The Mode 1 pipeline must never block or lose a job because of this feature.
- **No regression with flag OFF.** With the flag disabled, Mode 1 behaves byte-identically to current behaviour. Verified by regression test.
- **Inference is isolated from the main process.** All ONNX work runs in an Electron `utilityProcess`. The main process queues requests and consumes results; it does not load models or run inference directly. This protects FTP polling, S3 uploads, file watching, and renderer IPC from being starved during long scoring runs.
- **Per-image data, derived job state.** Per-image quality records live in the existing sidecar (`jobs/sidecarManager.js`). The job's "held" state is computed from its images, not stored separately, so there is one source of truth.
- **Originals untouchable without an explicit revert path.** All fixups go through `originalsManager.js` so revert-to-original is always available. The original file is never overwritten.
- **Log everything now.** Score, threshold-used, model version, inference time, fixup attempts (model, before/after score), operator decisions — all written from day one. The PW-007 "log everything, even with no consumer" principle applies — when verification thresholds need calibration in Phase 2, the data is already there.

---

## 2. New dependencies and installer impact

**Already added by PW-007:** `onnxruntime-node`. No new runtime dependencies for this plan.

**New bundled model files** (in `resources/models/`):

| Path | Purpose | Size |
|------|---------|------|
| `resources/models/musiq/model.onnx` | Quality scoring (0–100) | ~30 MB |
| `resources/models/fbcnn/model.onnx` | JPEG artefact removal | ~25 MB |
| `resources/models/realesrgan/model.onnx` | Upscaling (2x/4x) | ~65 MB |
| `resources/models/<each>/LICENSE` | Upstream licence text, verbatim | tiny |

**Total installer impact:** ~120 MB on top of PW-007's runtime + orientation model contribution. Confirmed acceptable by Richard — no lazy-download infrastructure in scope.

**Attribution artifact:** extend `THIRD_PARTY_LICENSES.md` (created by PW-007) with sections for MUSIQ (Apache 2.0), FBCNN (Apache 2.0), Real-ESRGAN (BSD 3-Clause). Apache 2.0 specifically requires NOTICE preservation — copy the upstream NOTICE files alongside the LICENSE files in each model folder.

**Electron-builder config:** `extraResources` already covers `resources/models/**` from PW-007. New folders are picked up automatically.

---

## 3. New files

All paths relative to repo root.

| Path | Purpose |
|------|---------|
| `src/main/services/ai-inference-host.js` | Electron `utilityProcess` host. Loads ONNX sessions for all models (orientation, musiq, fbcnn, realesrgan), exposes a request/response message protocol over IPC. Single instance per app. Replaces the in-main-process inference from PW-007. |
| `src/main/services/ai-inference-client.js` | Main-process client for the host. Promise-based API: `inference.run(modelId, input) → Promise<output>`. Handles host lifecycle (spawn on first use, restart on crash), serialises calls. |
| `src/main/services/ai-quality-service.js` | Domain service for quality scoring. `scoreImage(imagePath) → { score, modelVersion, inferenceMs, error? }`. Wraps the inference client; handles tensor pre-processing for MUSIQ. Single concurrency-capped queue (default cap: 2). |
| `src/main/services/ai-fixup-service.js` | Domain service for fixup. `applyFixup(imagePath, modelId, opts) → { outputPath, beforeScore, afterScore, kept, error? }`. Pre/post MUSIQ scoring built in. Writes through `originalsManager.js`. |
| `src/main/services/ai-job-quality-orchestrator.js` | Plugs into the Mode 1 download pipeline. As each image lands, queue it for scoring. When all images for a job are scored, derive job state (`route` or `hold`). |
| `src/main/services/ai-quality-store.js` | Thin wrapper over `sidecarManager.js` for reading/writing the AI quality block of each image's sidecar. Keeps the AI shape isolated from the broader sidecar. |
| `src/renderer/views/QualityReview/index.jsx` | Top-level component for the Quality Review tab. Owns the two pieces of state that survive view transitions: `tweaks` (density, theme, showKbdHint — same shape as Film Review) and `openJobId` (null = show JobList, set = show JobReview → FocusedImage). Mirrors `src/renderer/views/FilmReview/index.jsx`. |
| `src/renderer/views/QualityReview/mount.jsx` | React entry point. Mounts a React root into `<div id="quality-review-root">` inside the Quality tab. Mirrors `src/renderer/views/FilmReview/mount.jsx`. |
| `src/renderer/views/QualityReview/JobList.jsx` | Held-jobs list (the parallel of `RollList`). Each row shows job code, customer, total/failed counts, oldest hold time, and a status indicator. Click → opens the JobReview view. Re-fetches when an `aiQuality.onJobHeld` event fires. |
| `src/renderer/views/QualityReview/JobReview.jsx` | Per-job thumbnail grid (the parallel of `RollReview`). Default filter: "Show failed only". Failed images get a red corner indicator on the thumbnail. Batch action above the grid: `[Apply [Auto ▼] to all 3 failed images]`. Header `[Approve & Route]` button enabled only when no failed-without-decision image remains. |
| `src/renderer/views/QualityReview/FocusedImage.jsx` | Single-image view (the parallel of `FocusedFrame`). Large preview, score overlay, fixup dropdown (Clean compression / Sharpen / Upscale / Auto), Apply Fixup, Approve as-is, Revert, fixup history. Keyboard shortcuts mirror `FocusedFrame` where they apply (←/→ to move between failed images, etc). |
| `src/renderer/views/QualityReview/ImageCell.jsx` | Single thumbnail cell with score badge and red-corner-indicator. Parallel of `FrameCell`. |
| `src/renderer/views/QualityReview/FixupMenu.jsx` | Reusable fixup-model dropdown component (used by both `JobReview` batch action and `FocusedImage` per-image action). Parallel of `FlagMenu`. |
| `src/renderer/quality-review.bundle.js` | esbuild entry — same convention as `film-review.bundle.js`. |
| `src/renderer/quality-review.css` | Tab-scoped styles. Same convention as `film-review.css`. Inherits the design tokens used by Film Review for visual consistency. |
| `src/renderer/views/jobs-grid/QualityFlag.jsx` | Renderer-side flag badge for the existing Flags column on the Jobs grid (`3/400` red triangle). Click navigates to the Quality tab and opens the job. |
| `src/main/services/quality-review-prefs-store.js` | electron-store-backed prefs (density / theme / showKbdHint), parallel of `film-review-prefs-store.js`. |
| `docs/AI-QUALITY.md` | User-facing doc: what it does, how the threshold works, the MUSIQ guidance text shown in settings, what each fixup model does, troubleshooting. |

---

## 4. Files to modify

| Path | Change |
|------|--------|
| `src/main/services/orientation-service.js` (PW-007) | Refactor to call `ai-inference-client.js` instead of loading ONNX in main process. Behaviour unchanged. This is the prerequisite refactor referenced in Section 12. |
| `src/main/services/config-service.js` | Add `aiQuality` config section (see Section 8). Default `enabled: false`, `threshold: 75`. |
| `src/main/services/job-download-service.js` | Add hook: as each image finishes downloading, call `ai-job-quality-orchestrator.queueImage(jobId, imagePath)`. No blocking — orchestrator handles async scoring. |
| `src/main/services/print-service.js` | Before routing a job, check `ai-job-quality-orchestrator.canRoute(jobId)`. If held, do not route; surface the held state to the renderer instead. |
| `src/main/jobs/sidecarManager.js` | Add `aiQuality` block to the per-image sidecar schema (Section 5). |
| `src/main/jobs/originalsManager.js` | Confirm fixup writes preserve original. Likely no code change — the existing pattern already handles this — but verify and add a test. |
| `src/main/ipc-handlers.js` | Register IPC handlers for: get-quality-state-for-job, run-fixup, approve-as-is, revert-fixup, list-models. |
| `src/preload/preload.js` | Expose those handlers via contextBridge under `window.electronAPI.aiQuality.*`. |
| `src/renderer/index.html` | Add new "Quality" tab next to "Film". Add `<div id="quality-review-root">` inside its tab panel. Add Quality flag column to Jobs grid (or extend the existing Flags column to render the new badge type). |
| `src/renderer/renderer.js` | Wire up the new Quality tab in the existing vanilla tab-switcher (same pattern used for Film). Wire up Quality flag rendering on the Jobs grid; click handler switches to the Quality tab and dispatches a `quality-review:open-job` event the React tree listens for. |
| `scripts/build-renderer.js` | Add `quality-review.bundle.js` to the esbuild entry list (same pattern as `film-review.bundle.js`). |
| `ARCHITECTURE.md` | Add an "AI Quality Gate" section under the AI Image Enhancement service map. Add a new pending-work row marking Phase 2 (verification calibration). |
| About screen | Extend the third-party licences link to cover the new models. |

---

## 5. Data model — per-image AI quality record

Stored as part of the existing per-job sidecar JSON (one sidecar per job, one entry per image). New `aiQuality` block per image:

```json
{
  "aiQuality": {
    "scored": true,
    "score": 64,
    "thresholdAtScoreTime": 75,
    "passed": false,
    "modelVersion": "musiq-spaq-v1.0.0",
    "inferenceMs": 187,
    "scoredAt": "2026-04-26T08:14:22.910Z",

    "fixupHistory": [
      {
        "modelId": "fbcnn",
        "ranAt": "2026-04-26T08:16:01.220Z",
        "beforeScore": 64,
        "afterScore": 78,
        "kept": true,
        "outputPath": "absolute path to fixed-up image",
        "error": null
      }
    ],

    "operatorDecision": {
      "kind": "fixed | approved_as_is | reverted | none",
      "decidedAt": "ISO-8601 or null",
      "note": "string or null"
    }
  }
}
```

Design notes:

- `score` is the *current* score reflecting any kept fixup. `fixupHistory[].beforeScore` and `afterScore` capture the chain.
- `passed = score >= thresholdAtScoreTime`. Stored, not derived, so changing the threshold later doesn't retroactively un-flag historical jobs.
- `fixupHistory` is append-only. `kept: true` on the latest entry means the current image on disk is the output of that fixup. Multiple fixups may stack (operator runs FBCNN then Real-ESRGAN). Operator can revert to original at any point — this writes a synthetic entry with `kind: 'reverted'` to `operatorDecision`, but the original file always lives in the originals folder.
- `operatorDecision.kind === 'approved_as_is'` is the override path for intentional artistic looks. The job releases despite the failing score.
- `modelVersion` is the SHA256-prefix or filename-derived version string. Change of model = new field automatically.

Job-level "held" is derived: any image with `aiQuality.passed === false` AND no `operatorDecision.kind` of `fixed | approved_as_is` → job is held.

---

## 6. Pipeline insertion point (Mode 1)

Current Mode 1 flow (from ARCHITECTURE.md § Mode 1):

```
polling-service → job-service (fetch) → job-download-service → ftp-service → print-service (route)
```

Modified flow:

```
polling-service
  → job-service (fetch)
  → job-download-service
       ├─ for each image as it lands:
       │    └─ (if flag enabled) ai-job-quality-orchestrator.queueImage(jobId, imagePath)
       │           └─ ai-quality-service.scoreImage(...)
       │                 └─ ai-inference-client.run('musiq', ...)
       │                       └─ utility process performs MUSIQ inference
       │           └─ write per-image score to sidecar
       │           └─ if all images for jobId scored: derive job state
       │
       └─ when download complete + scoring complete:
            ├─ if no images failed → print-service.route(job)  [unchanged behaviour]
            └─ if any image failed → mark job held, emit jobHeld event to renderer
```

Critical detail: scoring is pipelined with download, not gated behind it. A 400-image job whose download takes 90 seconds will have most of its scoring done by the time download completes, because images are queued for scoring as they land. Operators see throughput close to the no-AI baseline for jobs that pass cleanly.

All scoring is wrapped in try/catch. Any throw → log to Winston with `[ai-quality]` tag, write `aiQuality.scored: true, error: '...'` to sidecar, treat as `passed: true` (do not block routing on infrastructure failures), continue.

---

## 7. IPC contract — AI Quality

All exposed via contextBridge under `window.electronAPI.aiQuality.*`. Naming follows the existing electronAPI convention — verify against the current preload and adjust.

**Queries:**

- `aiQuality.listHeldJobs() → [{ jobId, jobCode, customer, totalImages, failedImages, oldestHoldAt }]` — drives the JobList stage of the Quality Review tab.
- `aiQuality.getJobQuality(jobId) → { jobId, held, images: [{ imageId, score, passed, fixupHistory, operatorDecision, thumbnailPath }] }`
- `aiQuality.listFixupModels() → [{ modelId: 'fbcnn', label: 'Clean compression', description: '...', estimatedMs: 800 }, ...]`
- `aiQuality.getActivityLog({ jobId? }) → ActivityLogEntry[]` — passthrough/filter on the existing Activity Log if its API supports it; otherwise rely on the global Activity Log tab and just emit entries.

**Quality Review tab prefs** (mirror Film Review's `filmReview:get-tweaks` / `filmReview:set-tweak`):

- `qualityReview.getTweaks() → { density, theme, showKbdHint }`
- `qualityReview.setTweak({ key, value }) → { ok }`

**Commands:**

- `aiQuality.runFixup({ jobId, imageId, modelId }) → { ok, beforeScore, afterScore, kept, error? }` — single image.
- `aiQuality.runFixupBatch({ jobId, imageIds, modelId }) → { ok, results: [...] }` — batch.
- `aiQuality.approveAsIs({ jobId, imageId, note? }) → { ok }` — override the threshold for a specific image.
- `aiQuality.revertFixup({ jobId, imageId }) → { ok, restoredScore }` — restore original via originalsManager.
- `aiQuality.releaseJob({ jobId }) → { ok }` — operator's explicit "approve to print" once all images have a decision. Triggers `print-service.route(job)`.

**Events (main → renderer):**

- `aiQuality.onJobHeld(callback)` — fires when a job transitions to held state.
- `aiQuality.onImageScored(callback)` — fires per-image during ongoing scoring (so the held-job review can update progress live).
- `aiQuality.onFixupComplete(callback)` — fires after each fixup so the panel can refresh scores.

What NOT to expose:

- ONNX session handles, model paths, raw tensors.
- Direct sidecar writes — all writes go through the typed commands above.
- Activity Log write API — the AI services write to it directly from main; renderer only reads.

---

## 8. Feature flag and settings

Add to `config-service.js` schema:

```js
aiQuality: {
  enabled: false,
  threshold: 75,            // 1-100, MUSIQ score below this fails the gate
  utilityProcess: {
    concurrency: 2,         // max concurrent inferences in the utility process
    preferGPU: true         // attempt DirectML, fall back to CPU
  },
  perProductTypeOverrides: {  // reserved, not used in Phase 1
    // 'canvas-print': { threshold: 85 }
  },
  debugLog: false
}
```

**Settings UI section** (new, in the existing Settings tab):

```
┌─ AI Quality Gate ────────────────────────────────────────────┐
│ ☐ Enable AI quality checks                                   │
│                                                              │
│ Quality threshold: [75]                                      │
│ Images scoring below this number are flagged for review.    │
│                                                              │
│ Guidance:                                                    │
│   • Below 50 — significant quality issues likely             │
│   • 50–70 — borderline; some labs accept, some don't         │
│   • 70–85 — typical phone uploads, usually fine for print    │
│   • Above 85 — high-quality images                           │
│                                                              │
│ Default 75. Adjust based on your lab's print quality bar.    │
│                                                              │
│ Hardware acceleration: [Auto-detected: DirectML / CPU]      │
│                                                              │
│ ☐ Verbose logging (writes per-image scoring detail to log)  │
└──────────────────────────────────────────────────────────────┘
```

The guidance text is verbatim — Richard explicitly asked for it shown to operators as a tuning aid.

**Startup behaviour:**
- `enabled === false` → orchestrator never runs, utility process never spawns for quality models. (Utility process may still spawn for PW-007 orientation if that flag is on.)
- `enabled === true` → utility process spawns at app startup, MUSIQ session loads, warm-up inference on a small black image. Fixup model sessions load lazily on first use to avoid startup time penalty for labs that rarely fix.
- Model load failure → log fatal, disable feature for the session, notify renderer, continue running.

**Runtime toggling:** restart-required for Phase 1 (matches PW-007 convention). Live toggling deferred.

---

## 9. Held-job review UI — new dedicated Quality Review tab

The held-job review is a **new tab**, sibling of the existing Film Review tab, built in the same two-stage list → focused-image style. It is the primary surface for resolving Quality holds. The existing Job Review drawer is **not** modified by this work — operators can still open Job Review from the Jobs grid for everything else (Quantity, Colour Correction, Crop To Size, AI Enhancement: Standard V2 / Face enhancement).

This decision (versus extending Job Review) was made because:
- Held-job review has different ergonomics: operators want to triage many failed images across many jobs in one sitting, not pop in and out of one job at a time.
- The Film Review pattern already encodes the right interaction shape (folder/job list → grid → focused single-image with keyboard nav and quick action menu) and a consistent visual language.
- A separate surface keeps the existing Job Review drawer focused on its current job, and lets the Quality Review tab be styled and optimised for a triage workflow.

### Architectural mirror of Film Review

| Film Review | Quality Review |
|---|---|
| Tab: **Film** | Tab: **Quality** |
| Mount point: `<div id="film-review-root">` | Mount point: `<div id="quality-review-root">` |
| Bundle: `film-review.bundle.js` | Bundle: `quality-review.bundle.js` |
| Top-level: `views/FilmReview/index.jsx` (`tweaks`, `openRollId`) | Top-level: `views/QualityReview/index.jsx` (`tweaks`, `openJobId`) |
| Stage 1: `RollList.jsx` — list of processed rolls | Stage 1: `JobList.jsx` — list of held jobs |
| Stage 2: `RollReview.jsx` — thumbnail grid of frames | Stage 2: `JobReview.jsx` — thumbnail grid of images |
| Stage 3: `FocusedFrame.jsx` — single frame, manual rotate | Stage 3: `FocusedImage.jsx` — single image, fixup actions |
| Cell: `FrameCell.jsx` | Cell: `ImageCell.jsx` |
| Action menu: `FlagMenu.jsx` | Action menu: `FixupMenu.jsx` |
| Prefs store: `film-review-prefs-store.js` | Prefs store: `quality-review-prefs-store.js` |
| Trigger event: `onFilmReviewRollProcessed` → bumps `refreshKey` | Trigger event: `aiQuality.onJobHeld` → bumps `refreshKey` |

Visual language reuses the design tokens established by Film Review (see `docs/design/film-review-design-brief.md`): same density tweaks (tight / regular / comfy), same theme toggle (light / dark), same keyboard-hint chip pattern. The result should feel like a sister surface, not a new app.

### Stage 1 — Job list (`JobList.jsx`)

A list of all currently held jobs. Each row shows:

```
┌──────────────────────────────────────────────────────────────┐
│ ●  Job 18241  Smith, Jane           3/400   45 min ago   →  │
│ ●  Job 18247  Patel, R.             1/12     3 min ago   →  │
└──────────────────────────────────────────────────────────────┘
```

- Status dot (red = held, amber = scoring in progress, green = resolved).
- Failed/total count badge — same visual as the Jobs-grid Flag badge.
- Time since hold — relative ("45 min ago"), absolute on hover.
- Sort: oldest hold first by default.
- Click row → opens Stage 2 with that job's failed-only filter active.

Re-fetches when `aiQuality.onJobHeld` or `aiQuality.onFixupComplete` fires (refreshKey bump pattern, mirrors Film Review). Newly-resolved jobs animate out.

Empty state: cheerful "No held jobs — quality looks good ✓".

### Stage 2 — Job review grid (`JobReview.jsx`)

Thumbnail grid of the job's images. Filter pill at the top: `[ Failed only (3) ] [ All (400) ]`. Defaults to **Failed only** when arriving from the Job List or a Jobs-grid flag click.

```
┌─ Job 18241 — Smith, Jane ──────── [Failed only (3) ▼] [All (400)] ──┐
│                                                                       │
│  [img]  [img]  [img]                                                  │
│   ●      ●      ●                                                     │
│                                                                       │
│  Batch: [Apply [Auto ▼] to all 3 failed]   [ Approve & Route ]        │
└────────────────────────────────────────────────────────────────────────┘
```

- Failed thumbnails get a red corner indicator (mirrors the Film Review confidence-corner-dot).
- Score badge in the corner of every thumbnail when in "All" view.
- Batch action above the grid: `[Apply [Auto ▼] to all 3 failed]` — wires to `aiQuality.runFixupBatch`.
- Header `[Approve & Route]` — enabled only when every failed image has a decision (`fixed | approved_as_is`). Wires to `aiQuality.releaseJob`.
- Click a thumbnail → opens Stage 3 (FocusedImage).
- Keyboard: `Esc` returns to Job List; `←/→` cycles through job tabs at the top if multiple jobs are pinned (Phase 2 — pinning deferred).

### Stage 3 — Focused image (`FocusedImage.jsx`)

Single-image triage view. Preview pane on the left, action panel on the right.

```
┌─────────────────────────────────────────────────────────┬──────────────────────┐
│                                                         │  AI QUALITY          │
│                                                         │  ────────────────────│
│             [ large image preview ]                     │  Score: 64 / 75      │
│                                                         │  [FAILED]            │
│                                                         │                      │
│                                                         │  Fix: [Clean ▼]      │
│                                                         │   • Clean compression│
│                                                         │   • Sharpen / deblur │
│                                                         │   • Upscale 2x       │
│                                                         │   • Auto             │
│                                                         │                      │
│                                                         │  [ Apply Fixup ]     │
│                                                         │                      │
│                                                         │  ── Or ──            │
│                                                         │  [ Approve as-is ]   │
│                                                         │                      │
│                                                         │  History:            │
│                                                         │   No fixups yet.     │
│  ◄ prev          image 2 of 3 failed         next ►     │                      │
└─────────────────────────────────────────────────────────┴──────────────────────┘
```

After a fixup runs, the right panel updates:

```
│  Score: 64 → 78 ✓  (kept)         │
│                                    │
│  History:                          │
│   FBCNN  64 → 78  [keep] [revert] │
│                                    │
│  [ Run another fixup ]             │
│  [ Revert to original ]            │
```

Keyboard shortcuts (mirroring `FocusedFrame` where applicable):

- `←/→` — previous / next failed image in this job
- `F` — focus the fixup dropdown
- `Enter` — Apply Fixup
- `A` — Approve as-is (with confirmation)
- `R` — Revert to original (only when fixupHistory is non-empty)
- `Esc` — back to JobReview grid

### Triggers — how operators reach the tab

1. **Jobs grid Flag column** — clicking a `3/400` flag badge switches to the Quality tab, opens that job (Stage 2) with Failed-only active.
2. **`aiQuality.onJobHeld` notification** — toast notification with a "Review now" button that switches to the Quality tab and opens the held job.
3. **Direct tab click** — operator opens the Quality tab manually; sees JobList with all currently held jobs.

### Out of scope for this section (deferred)

- Pinning multiple jobs side-by-side or in tabs within the Quality Review screen.
- Cross-job batch fixup ("apply Auto to all failed images across all held jobs").
- Showing non-Quality flags on the Job List (e.g. routing errors). The Quality tab stays Quality-focused; routing/dispatch issues continue to surface in their existing surfaces.

---

## 10. Fixup orchestration

Each fixup model is a thin wrapper around the inference client:

```js
// ai-fixup-service.js (sketch)
async function applyFixup(imagePath, modelId, opts) {
  const beforeScore = await aiQualityService.scoreImage(imagePath);

  let outputPath;
  try {
    if (modelId === 'auto') {
      outputPath = await applyAutoChain(imagePath, beforeScore);
    } else {
      outputPath = await runSingleModel(imagePath, modelId);
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const afterScore = await aiQualityService.scoreImage(outputPath);

  // Phase 1: always keep. Verification threshold is data-collection only.
  // Phase 2 will use the captured before/after distribution to set a real threshold.
  const kept = true;

  if (kept) {
    await originalsManager.preserveOriginal(imagePath);  // no-op if already preserved
    await replaceWorkingImage(imagePath, outputPath);
  }

  await sidecarManager.appendFixupHistory(jobId, imageId, {
    modelId, beforeScore, afterScore, kept, outputPath, ranAt: new Date().toISOString()
  });

  return { ok: true, beforeScore, afterScore, kept };
}

function applyAutoChain(imagePath, score) {
  // Conservative ordering: FBCNN → Real-ESRGAN. Skip Real-ESRGAN unless effective PPI low.
  // No deblur/denoise in Phase 1 — those models defer to a later phase.
}
```

Verification policy is intentionally permissive in Phase 1 (`kept: true` always). The `beforeScore`/`afterScore` capture is enough to choose a real threshold once we have a few weeks of pilot data — matching the same data-first approach used for PW-007 confidence.

---

## 11. Error handling and graceful failure

| Failure | Intended behaviour |
|---------|--------------------|
| Utility process fails to spawn at startup | Log fatal; disable feature for session; renderer shows banner; Mode 1 routes without scoring. |
| Utility process crashes mid-run | Auto-restart once; if it crashes again within 30s, disable feature for session; in-flight jobs treated as scoring-failed (= passed). |
| MUSIQ inference throws on a single image | Log error; write `aiQuality.scored: true, error, score: null, passed: true` to sidecar; do not hold job on this image. |
| Fixup model returns malformed output | Log error; do not replace working image; surface error in QualityPanel; keep original. |
| `sharp` pre/post-processing throws | Same as inference failure for that image. Honour the `sharp.cache(false)` startup setting (already done for SMB EPERM per PW-007/memory). |
| Sidecar write fails | Log warning; do not block; in-memory state still drives the UI for the current session, but a restart will lose it. Acceptable. |
| OOM during inference (very large image) | Catch; same as inference failure. Phase 2 may add tile-based processing for Real-ESRGAN. |
| Operator fixup queued but app shuts down | Best-effort cancel; no harm done — original image is untouched, sidecar shows no completed fixup. |

Every failure path logs via Winston with `[ai-quality]` tag and emits an Activity Log entry (Section 13).

---

## 12. Performance and concurrency architecture (utilityProcess)

This is the prerequisite-and-shared-infrastructure part of the work.

**Why:** ONNX inference on customer images can take 100–500ms each. A 400-image job loaded into the main process pins the JS event loop for tens of seconds and starves FTP polling, S3 uploads, file watchers, and the renderer. Electron has supported `utilityProcess` since v22 — a separate OS process with its own event loop, message-passed via IPC, isolated lifecycle. This is the modern Electron pattern for exactly this case.

**Scope of the refactor:**
1. PW-007's `orientation-service.js` currently (or is planned to) load ONNX in the main process. Move that into a new `ai-inference-host.js` running in a `utilityProcess`. Behaviour-identical from the orientation feature's perspective — it just calls the new client instead of loading the model directly.
2. Add the quality + fixup models to the same host.
3. The host owns model session lifetimes, batching, concurrency capping, and GPU/CPU EP selection.

**Concurrency cap (default 2):**
- Two concurrent inferences inside the utility process. CPU-bound work should not pin all cores.
- Background scoring jobs are the lowest priority. Operator-triggered fixups jump the queue.
- A single `p-queue` (or hand-rolled equivalent) inside the host handles ordering.

**GPU acceleration:**
- On startup, the host attempts DirectML EP, falls back to CPU EP if unavailable.
- The active EP is reported back to the main process and shown in Settings (`Hardware acceleration: DirectML active` or `CPU only`).
- DirectML gives roughly 5–10x throughput on a typical Windows lab PC with an integrated/discrete GPU. This matters most for batch fixups on large jobs.

**Cancellation:**
- The renderer can cancel a queued (not yet running) inference by jobId. In-flight inferences run to completion (cancellation mid-ONNX is fragile).

**Backpressure:**
- The orchestrator does not block the FTP polling loop on scoring depth. Newly arrived jobs queue; if the queue exceeds a threshold (e.g. 200 pending images), polling-service can be told to back off (Phase 2 — for Phase 1 just measure).

---

## 13. Activity Log integration

Every AI event flows into the existing Activity Log. Match the existing entry format and conventions — verify against current entries before writing the first new one. Suggested entries (each prefixed with `AI Quality:` so the existing tab filter can pick them up):

```
AI Quality: Job <code> received - scoring 400 images
AI Quality: Job <code> scoring complete - 397 passed, 3 failed (held)
AI Quality: Operator ran FBCNN on image <id> - score 64 → 78
AI Quality: Operator approved image <id> as-is (score 41, threshold 75)
AI Quality: Job <code> released by operator - all images approved
AI Quality: Inference failed for image <id> - 'CUDA out of memory'; image passed by default
AI Quality: Hardware acceleration - DirectML active
```

Activity Log entries are write-only from the main process; the renderer only reads via the existing Activity Log tab. No new IPC.

---

## 14. Testing plan

**Manual regression (flag OFF):**
1. Fresh install with default config.
2. Trigger Mode 1 download on a job with mixed-quality images.
3. Verify job routes immediately, no sidecar `aiQuality` block written.
4. Compare output to pre-feature behaviour: byte-identical print-controller dispatch.

**Manual smoke (flag ON, all-pass job):**
1. Enable flag in config, threshold 75.
2. Job arrives with images that all score above 75.
3. Verify scoring runs in background (utility process active in Task Manager), Mode 1 routes the job normally without operator interaction.
4. Verify each image's sidecar has `aiQuality.passed: true`.

**Manual smoke (flag ON, mixed job):**
1. Job with 10 images: 8 pass, 2 fail.
2. Verify Jobs grid Flags column shows red triangle + `2/10`.
3. Verify job did NOT route.
4. Click flag → opens Job Review, defaults to "Show only failed (2)".
5. Click `Apply Fixup → Auto` on each → verify before/after scores update, fixup history appears.
6. Click `Approve & Route` → verify job routes to print controller.

**Manual override path:**
1. Job with intentional B&W moody portrait scoring 38.
2. Verify it's flagged.
3. Click `Approve as-is` with a note.
4. Verify job releases, sidecar reflects override decision.

**Manual failure injection:**
1. Delete the MUSIQ model file before startup. Verify feature gracefully disables, app launches normally, jobs route without scoring.
2. Spawn-fail the utility process (rename the binding). Verify same.
3. Force OOM by piping a synthetic 100MP image to the host. Verify the affected image gets `passed: true` (treated as scoring failure), other images continue.

**Performance regression:**
1. With flag ON, drop a 400-image job into Mode 1.
2. Measure: Mode 1 polling cadence stays at ~60s, Mode 2 file-watch latency unchanged, renderer remains interactive (frame test).
3. Measure: total scoring time on representative GPU-equipped PC vs CPU-only PC. Document.

**Accuracy spot-check:**
1. Curate a fixture set of 100 representative lab images with operator-rated quality (good / borderline / bad).
2. Run scoring; tally MUSIQ vs operator agreement.
3. Use distribution to validate the default threshold of 75. Update default if data warrants.

---

## 15. Implementation order (milestones)

**Milestone 0 — utilityProcess refactor (prerequisite, lands before this plan).**
- Move PW-007 orientation ONNX loading from main process into `ai-inference-host.js` under `utilityProcess`.
- Establish the inference-client API.
- Verify PW-007 behaviour unchanged; ship as a patch to PW-007.

**Milestone 1 — Plumbing, no scoring yet.**
- Add MUSIQ model file + LICENSE to `resources/models/musiq/`.
- Extend the inference host to load MUSIQ.
- Skeleton `ai-quality-service.js` that returns hardcoded score 100.
- `ai-job-quality-orchestrator.js` queues images and writes sidecar entries.
- Settings UI — flag + threshold input + guidance text.
- Hook `job-download-service.js` and `print-service.js` behind the flag.
- Regression test: flag OFF byte-identical to before.

**Milestone 2 — Real scoring + Jobs grid flag.**
- Implement real MUSIQ inference and tensor pre-processing in the host.
- Implement per-image score writes to sidecar.
- Implement job-state derivation (`held` if any image failed).
- Add Quality flag to the Flags column in the Jobs grid (`3/400` red triangle).
- Smoke-test with real lab jobs end-to-end up to "job is held."

**Milestone 3 — Quality Review tab (no fixups yet).**
- Add new "Quality" tab to `index.html` next to "Film". Add `<div id="quality-review-root">`. Wire up vanilla tab switching in `renderer.js`.
- Add `quality-review.bundle.js` to `scripts/build-renderer.js`.
- Build the React tree mirroring Film Review:
  - `views/QualityReview/mount.jsx`, `index.jsx`
  - `JobList.jsx` (Stage 1) — wired to `aiQuality.listHeldJobs` + `onJobHeld` event.
  - `JobReview.jsx` (Stage 2) — thumbnail grid, Failed-only filter default, batch fixup placeholder (disabled until M4).
  - `FocusedImage.jsx` (Stage 3) — preview + Approve as-is + Approve & Route paths only (no fixup wiring yet).
  - `ImageCell.jsx`, `FixupMenu.jsx`.
- Add `quality-review-prefs-store.js` and IPC handlers (`qualityReview.getTweaks` / `setTweak`).
- Wire Jobs-grid Quality flag click → switch to Quality tab → open job (Stage 2).
- Operator can: open held jobs, see failed images, approve as-is, release the job. No fixups yet.

**Milestone 4 — Fixup models + history.**
- Add FBCNN and Real-ESRGAN model files.
- Implement `ai-fixup-service.js` with single-model and Auto-chain paths.
- Pre/post MUSIQ verification (always-keep policy in Phase 1, data captured).
- Wire fixup actions and history display in `FocusedImage.jsx`.
- Wire batch fixup action in `JobReview.jsx`.
- Originals preservation via `originalsManager.js` — verified by test.

**Milestone 5 — Activity Log, docs, polish.**
- Activity Log entries for every AI event.
- DirectML auto-detection + Settings display.
- `docs/AI-QUALITY.md` user-facing doc.
- Update `ARCHITECTURE.md`.
- Update third-party licences.
- Update release notes.

**Milestone 6 — Pilot rollout.**
- Enable for one lab.
- Collect score distribution + operator decision data for 2–4 weeks.
- Validate default threshold (75); adjust if data warrants.
- Look at `fixupHistory` distribution to inform Phase 2 verification policy.
- Review findings before wider rollout.

---

## 16. Open items and deferred decisions

- **Verification threshold for keep/revert.** Phase 1 always keeps. Phase 2 picks a real threshold from pilot data (likely a delta in MUSIQ score, possibly per-model).
- **SCUNet (denoise) and NAFNet (deblur).** Not in Phase 1. Defer until pilot data shows they're justified by frequency of those failure modes.
- **Per-product-type threshold overrides.** Schema reserved (Section 8), UI not built. Add in Phase 2 if labs ask.
- **Backpressure on FTP polling when queue is deep.** Measured in Phase 1, implemented in Phase 2 if needed.
- **Pinning multiple held jobs side-by-side or in tabs within the Quality Review screen.** Not in Phase 1.
- **Cross-job batch fixup ("apply Auto to all failed across all held jobs").** Not in Phase 1 — pilot data may not justify it.
- **Tile-based processing for Real-ESRGAN on huge images.** Not in Phase 1. Add when first OOM is reported.
- **GPU detection for non-DirectML hardware** (CUDA on Nvidia Topaz machines). Possible Phase 2 EP option.

---

## 17. What this plan explicitly does NOT do

- No auto-enhancement without operator action.
- No model lazy-download from S3 (models bundled).
- No changes to Mode 2 (Film Scans), Mode 3 (File Uploads), or print controller pipelines.
- No changes to the Film Review Panel.
- No changes to the existing Job Review drawer — Quality Review is a separate new tab. The Job Review drawer keeps its current controls (Quantity, Colour Correction, Crop To Size, AI Enhancement: Standard V2 / Face enhancement) untouched.
- No intelligent cropping (deferred to a Feature B Phase 1 plan that builds on the same infrastructure).
- No face detection or face-weighted scoring.
- No cloud calls for scoring or fixup — local ONNX only.
- No automated model updates separate from OHD installer updates.
- No per-image telemetry sent to Pixfizz or anywhere else. All score data is local-only.

---

## 18. Cross-references

- `ARCHITECTURE.md` — overall OHD architecture, service map, data persistence.
- `phase-1-implementation-plan.md` — PW-007 Film Scan Auto-Rotation, the convention this plan extends.
- `docs/design/film-review-design-brief.md` — visual/interaction patterns this plan reuses (corner dots, two-stage layout, keyboard-first flagging).
- Jobs grid Flags column — existing flag rendering conventions (icons, hover states) to match.
- `enhancementManager.js` / `topazClient.js` / `replicateClient.js` — existing provider system for the Job Review AI Enhancement panel; the new local-ONNX provider should slot in alongside, not replace.
