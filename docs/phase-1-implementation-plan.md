# Phase 1 Implementation Plan — Film Scan AI Rotation (PW-007)

**Scope:** Entirely local to OrderHub Downloader (OHD). No OrderHub/Lovable changes, no cross-app contract changes, no manual rotation UI. Adds AI-driven auto-rotation to the Mode 2 film scan pipeline, a new Film Review Panel for QC, and local per-frame telemetry logging to enable a feedback loop in a later phase.

**Source of truth for this plan:** `OrderHub Dowloader/ARCHITECTURE.md` (note: it lives in the subfolder, not the repo root — historical artefact). Section references below are to that doc. The implementer will have access to the live source tree and should verify line-level specifics (IPC handler registration order in `src/main/ipc-handlers.js`, esbuild config in `scripts/build-renderer.js`, electron-builder config in `electron-builder.yml`) against current code.

---

## 1. Design principles (non-negotiable)

- **Feature flag, default OFF.** The ONNX runtime and model ship in the installer unconditionally, but the orientation step only executes when `config.filmScanRotation.enabled === true`. New labs opt in explicitly.
- **Graceful failure everywhere.** If model load fails, inference fails, or `sharp.rotate()` fails, the frame flows through unrotated with the error captured in the per-frame metadata. The Mode 2 pipeline must never block or lose a frame because of this feature.
- **No regression with flag OFF.** With the flag disabled, Mode 2 behaves byte-identically to current behaviour. Unit/integration tests need to confirm this.
- **Film Review Panel mirrors the Job Review Panel architecture.** React view mounted into the main window via a dedicated root `<div>`, bundled by esbuild into its own IIFE (`film-review.bundle.js`) loaded alongside `renderer.js`. **Not** a separate BrowserWindow. Added as a new **"Film" tab** in the existing tab bar of `src/renderer/index.html`, alongside Jobs / Settings / Activity Log.
- **Log everything now, even with no consumer.** AI prediction, confidence, full class scores, rotation status, operator flags — all written to local metadata storage from day one, so when Phase 2 wants a feedback loop there's a year of data ready.

---

## 2. New dependencies and installer impact

**Add to `package.json`:**

- `onnxruntime-node` — ONNX Runtime bindings for Node.js. Used in the main process to run inference. ~80–90 MB native binary contribution to the installer.

**Already present (no changes):** `sharp` (0.34.5), `jimp`, `electron-store`, `winston`.

**Bundle the model weights file.** The `.onnx` export from the HuggingFace repo lives in `resources/models/orientation/` (already created). Config lives in `electron-builder.yml` — the active config file; the inline `build` key in `package.json` is legacy and should be removed to avoid confusion. Add to the YAML:

```yaml
extraResources:
  - from: resources/models
    to: models
asarUnpack:
  - resources/models/**
```

`asarUnpack` is mandatory — onnxruntime-node loads the model by filesystem path and cannot read from inside an asar archive.

Size: ~77 MB model (FP32 export of EfficientNetV2-S) + ~85 MB onnxruntime-node native binary = ~160 MB addition to the installer. Not a blocker. Phase 2 optimisation can INT8-quantise the model to ~20 MB with a small accuracy hit.

**Attribution artifact:** `THIRD_PARTY_LICENSES.md` at the repo root (or extend if present). Section for `DuarteBarbosa/deep-image-orientation-detection` — MIT notice, copyright line from the repo LICENSE, HuggingFace URL.

---

## 3. New files

All paths relative to repo root.

| Path | Purpose |
|------|---------|
| `src/main/services/orientation-service.js` | Loads the ONNX model at startup (gated by feature flag), exposes `predictOrientation(imagePath) → { predictedAngle, confidence, classScores, error? }`. Single instance of the inference session; handles warm-up, concurrency guard, graceful failure. Holds a `MODEL_FILE` constant pointing at `orientation_model_v2_0.9882.onnx` so future model swaps are a one-line change. |
| `src/main/services/frame-metadata-store.js` | electron-store wrapper for per-frame records (separate store from config — `name: 'frame-metadata'`, follows the pattern used by `dpof-state` in `ipc-handlers.js`). Key by `frame_id`. Writes are append-only per frame (add AI decision, later add operator flags). Exposes query helpers for the Film Review Panel. |
| `src/renderer/views/FilmReview/mount.jsx` | React entry point — mounts into `<div id="film-review-root">` via `createRoot`. Mirrors `src/renderer/views/JobReview/mount.jsx`. |
| `src/renderer/views/FilmReview/index.jsx` | Top-level component — the `App` from the design prototype (tab state, roll list vs. roll review switch). |
| `src/renderer/views/FilmReview/RollList.jsx` | Rolls index table. |
| `src/renderer/views/FilmReview/RollReview.jsx` | 6×6 frame grid + `Stat`, `Chip`, `FrameCell`, `ConfidenceDot`, `FlagMenu` as co-located sub-components. |
| `src/renderer/views/FilmReview/FocusedFrame.jsx` | Detail overlay. |
| `src/renderer/views/FilmReview/OHDChrome.jsx` | Optional — may collapse to a simple header since this is a tab, not a separate window. |
| `src/renderer/views/FilmReview/styles.css` | Port of the prototype's `styles.css`, with prototype-only rules stripped. |
| `src/renderer/views/FilmReview/tokens.css` | Port of `lib/pixfizz-tokens.css`, verbatim (fonts switched from `@import` to local `@font-face` — see § 15). |
| `src/renderer/views/FilmReview/fonts/` | Locally bundled Hind + JetBrains Mono WOFF2 files (fonts cannot load from CDN in a packaged Electron app offline). |
| `src/renderer/film-review.bundle.js` | esbuild output (generated, not hand-written). Added as a second entry in `scripts/build-renderer.js`. |
| `resources/models/orientation/orientation_model_v2_0.9882.onnx` | The model weights, downloaded from HuggingFace. ~77 MB FP32 export of EfficientNetV2-S. Filename preserves version (`v2`) and validation accuracy (`0.9882`) for provenance — reference from `orientation-service.js` via a `MODEL_FILE` constant. |
| `resources/models/orientation/LICENSE` | Copy of the MIT licence text from the upstream repo, preserved verbatim. |
| `resources/models/orientation/README.md` | Copy of the upstream model card — handy for future reference on input shape, class convention, training data. |
| `THIRD_PARTY_LICENSES.md` | New or extended, containing model attribution. |

---

## 4. Files to modify

| Path | Change |
|------|--------|
| `package.json` | Add `onnxruntime-node` to dependencies. Remove the legacy inline `build` key (electron-builder.yml is the active config). |
| `electron-builder.yml` | Add `extraResources` and `asarUnpack` entries for `resources/models/**` (see § 2). |
| `scripts/build-renderer.js` | Refactor the single hardcoded `entryPoints` into an array that bundles both `JobReview/mount.jsx` and `FilmReview/mount.jsx`. Keep the `jsx: 'automatic'` transform — the Film Review components rely on it. |
| `src/main/services/folder-watch-service.js` | Inside `_processFilmScans`, insert orientation-service call **between Step 2 (copy-to-storage) and Step 2b (TIFF→JPG conversion)**. Wrap in feature-flag check + try/catch. On success, apply rotation via `sharp(tiffPath).rotate(angle).toFile(rotatedPath)` on each TIFF in the storage folder, then replace the original. On failure, continue with unrotated frame and log error. Write per-frame metadata via `frame-metadata-store`. |
| `src/main/services/config-service.js` | Add flat config keys (matches existing schema style): `filmScanRotationEnabled` (boolean, default `false`), `filmScanRotationConfidenceThreshold` (number, default `0.9`, reserved for Phase 2), `filmScanRotationModelPath` (string, default `''` meaning use bundled), `filmScanRotationDebugLog` (boolean, default `false`). Do NOT add a nested `filmScanRotation` object — existing schema is entirely flat. |
| `src/main/index.js` | Wire up `orientation-service` initialisation (gated by flag) during startup, after config-service is ready. |
| `src/main/ipc-handlers.js` | Register new handlers under the `ohd:filmReview:*` channel namespace (see § 7). Mirror the existing `ohd:job:*` handler registration pattern. |
| `src/preload/preload.js` | Add Film Review Panel methods to the existing `electronAPI` object (see § 7). Use flat camelCase method names, not dotted paths — mirror the existing `jobLoad`, `enhancementRun` convention. |
| `src/renderer/index.html` | Add a new `Film` tab button in the tab bar (after `Activity Log`), add `<div class="tab-panel" id="panel-film"><div id="film-review-root"></div></div>`, add `<script src="film-review.bundle.js">` (or however the current page loads `job-review.bundle.js` — verify and match). |
| `src/renderer/renderer.js` | Wire the `Film` tab click to show its panel and dispatch a `ohd:open-film-review` custom event if the Film Review mount uses that pattern (or mount it always — simpler). |
| `OrderHub Dowloader/ARCHITECTURE.md` | Update PW-007 row in "Top Pending Work" table to mark Phase 1 in progress. Add a Film Review Panel section under "Key Architecture Points" mirroring how Job Review Panel is documented. |
| Settings tab in `index.html` (no dedicated About screen exists) | Add a "Third-party licences" link in the Settings panel footer that opens `THIRD_PARTY_LICENSES.md` via `shell.openPath` or `shell.openExternal` with a `file://` URL. **Open item:** consider adding a proper Settings > About panel as part of this work. |

---

## 5. Data model — per-frame metadata store

Stored via electron-store in a new file (e.g. `%APPDATA%\Electron\orderhub-downloader\frame-metadata.json`). One record per frame.

```json
{
  "frame_id": "string, stable per frame — e.g. roll_id + scan_order",
  "roll_id": "string",
  "roll_name": "string",
  "source_path": "absolute path to original TIFF on disk",
  "output_path": "absolute path to processed JPG",
  "s3_key": "string or null if not yet uploaded",
  "scan_order_in_roll": 1,
  "scanned_at": "ISO-8601",
  "processed_at": "ISO-8601",

  "ai": {
    "model_version": "string — derived from model filename hash",
    "predicted_class": 0,
    "predicted_angle": 0,
    "confidence": 0.987,
    "class_scores": [0.987, 0.008, 0.003, 0.002],
    "inference_ms": 142,
    "ran_at": "ISO-8601"
  },

  "rotation": {
    "applied": true,
    "angle": 90,
    "method": "sharp-tiff-pre-jpeg",
    "error": null
  },

  "operator_flags": [
    {
      "type": "rotation | scan_quality | exposure | other",
      "note": "string or null",
      "flagged_at": "ISO-8601"
    }
  ],

  "review_status": "unreviewed | reviewed",
  "reviewed_at": "ISO-8601 or null"
}
```

Design notes:
- `frame_id` derivation: `${folderName}_${sortedTiffIndex}` where `sortedTiffIndex` is the zero-padded position of the TIFF in the sorted directory listing at the moment of processing. Deterministic across reprocessing because the filenames don't change. Document this exactly in `frame-metadata-store.js`.
- `roll_id` is the watched folder name (e.g. `00001247`). `roll_name` is the same for now — kept separate in case customer/job metadata lands later.
- Model class convention matches the HuggingFace model card: Class 0 = correct, Class 1 = needs 90° CW, Class 2 = needs 180°, Class 3 = needs 90° CCW. Store both the raw `predicted_class` (for analysis) and the derived `predicted_angle` in degrees-to-rotate (for use).
- `class_scores` is the full softmax over all four classes — critical for future calibration work. Do not throw it away.
- `rotation.applied: false` + `rotation.error` captures the graceful-failure path.
- `operator_flags` is an array, not a single value — frames can be flagged for multiple reasons.

Storage lifecycle: records are written when Mode 2 processes a frame, updated when operator flags it in the Film Review Panel. Consider a rolling retention policy (e.g. keep 90 days) in a later phase; for Phase 1 just let it grow.

---

## 6. Pipeline insertion point (Mode 2)

Actual current Mode 2 flow (from `_processFilmScans` in `folder-watch-service.js`):

```
1.  Wait for folder stability (watchguard minutes)
2.  Copy folder from watch → storage/{MMDDYYYY}/{folderName}
2a. Delete folder from watch
2b. For each .tif/.tiff in storage: sharp(tif).jpeg({quality: 90}).toFile(jpg)
    — both the original TIFF and the new JPEG then sit in the storage folder
3.  Upload entire storage folder to S3 under film-scans/{locationId}/{folderName}/
    — both TIFFs and JPGs get uploaded
```

Modified flow for Phase 1 — rotation inserts as a new **Step 2a.5**, between the delete-from-watch and the TIFF→JPG conversion:

```
1.  Wait for folder stability
2.  Copy folder from watch → storage
2a. Delete folder from watch
2a.5  (IF filmScanRotationEnabled)
    For each .tif/.tiff in storage:
      ├─ frame_id = `${folderName}_${scanOrderIndex}`
      ├─ orientation-service.predictOrientation(tiffPath)
      ├─ IF prediction.error: record metadata (rotation.applied=false, rotation.error),
      │   continue with original TIFF
      ├─ ELSE IF prediction.angle === 0: record metadata (rotation.applied=false because
      │   no rotation needed), continue with original TIFF
      ├─ ELSE:
      │   ├─ await sharp(tiffPath).rotate(prediction.angle).toFile(tiffPath + '.rot')
      │   ├─ fs.renameSync(tiffPath + '.rot', tiffPath)   — atomic replace
      │   └─ record metadata (rotation.applied=true, rotation.angle, AI details)
      └─ generate 512px thumbnail into storage/thumbnails/{frame_id}.jpg (§ 9)
2b. Existing TIFF → JPG conversion (now operating on rotated TIFFs)
3.  S3 upload (unchanged)
```

Critical details:

- Apply rotation **on the TIFF, before JPEG conversion**. Rotating the TIFF is lossless regardless of dimensions; rotating the JPEG afterwards is lossless only when dimensions are MCU-aligned (usually true for scanner output, but "usually" isn't good enough). It also means only one encoder pass for the final JPEG.
- Write rotated pixels to a `.rot` sidecar, then atomic-rename to replace the original — avoids half-written files if the process dies mid-rotation.
- The whole Step 2a.5 block sits inside one try/catch. Any throw → log, skip rotation, record `rotation.applied: false` with the error message, continue to Step 2b with the original TIFF.
- `frame_id` needs to be deterministic and stable: scan order within roll is derivable from `fs.readdirSync(storagePath).filter(...tif).sort()` indexing. Document the exact derivation in `orientation-service.js`.

---

## 7. IPC contract — Film Review Panel

All exposed via `contextBridge.exposeInMainWorld('electronAPI', { ... })` in `preload.js` — add to the existing `electronAPI` object, do not create a new namespace. Method names are **flat camelCase** (mirrors existing `jobLoad`, `enhancementRun`, etc). IPC **channels** (the strings in `ipcMain.handle(...)` / `ipcRenderer.invoke(...)`) follow the newer `ohd:feature:action` convention.

**Queries (renderer → main → response):**

| Preload method | IPC channel | Returns |
|----------------|-------------|---------|
| `filmReviewListRolls(opts)` | `ohd:filmReview:list-rolls` | `Roll[]` with summary stats (`auto_rotated_count`, `low_confidence_count`, `rotation_error_count`, `flagged_count`) |
| `filmReviewGetRoll(rollId)` | `ohd:filmReview:get-roll` | Full roll metadata + frame list |
| `filmReviewGetFrame(frameId)` | `ohd:filmReview:get-frame` | Single-frame detail |
| `filmReviewGetThumbnail(frameId)` | `ohd:filmReview:get-thumbnail` | `file://` URL to the pre-generated thumbnail on disk (see § 9) |

**Commands (renderer → main, side-effectful):**

| Preload method | IPC channel | Notes |
|----------------|-------------|-------|
| `filmReviewFlagFrame(frameId, flag)` | `ohd:filmReview:flag-frame` | Appends to `operator_flags`. `flag` shape: `{ type: 'rotation'\|'scan_quality'\|'exposure'\|'other', note?: string }`. Main stamps `flagged_at`. |
| `filmReviewUnflagFrame(frameId, flagIndex)` | `ohd:filmReview:unflag-frame` | Removes a flag by array index (undo). |
| `filmReviewMarkRollReviewed(rollId)` | `ohd:filmReview:mark-roll-reviewed` | Sets `review_status: reviewed` on all frames in roll. |
| `filmReviewOpenFolder(rollId)` | `ohd:filmReview:open-folder` | Opens the roll's storage folder in Windows Explorer via `shell.openPath()`. |

**User preferences (renderer ↔ main, electron-store backed):**

| Preload method | IPC channel | Notes |
|----------------|-------------|-------|
| `filmReviewGetTweaks()` | `ohd:filmReview:get-tweaks` | Returns `{ density, theme, showKbdHint }`. See § 9 for shape/defaults. |
| `filmReviewSetTweak(key, value)` | `ohd:filmReview:set-tweak` | Persists a single preference. Renderer can update optimistically. |

**Events (main → renderer):**

| Preload listener | IPC channel | Fires when |
|------------------|-------------|------------|
| `onFilmReviewRollProcessed(cb)` | `ohd:filmReview:roll-processed` | Mode 2 finishes processing a roll. Panel can auto-refresh. |
| `onFilmReviewFrameUpdated(cb)` | `ohd:filmReview:frame-updated` | Frame metadata changes from any source. |

What NOT to expose:
- Model internals (inference session handle, weights path, any pointers).
- S3 credentials or the IBM endpoint.
- Direct filesystem access (use `filmReviewOpenFolder` and `filmReviewGetThumbnail` — no arbitrary path reads from the renderer).
- `frame-metadata-store` write APIs — all writes go through the typed IPC commands above.

---

## 8. Feature flag wiring

Add flat keys to the existing schema in `config-service.js` (the schema is entirely flat — do not nest):

```js
filmScanRotationEnabled: {
  type: 'boolean',
  default: false
},
filmScanRotationConfidenceThreshold: {
  type: 'number',
  default: 0.9,      // reserved for Phase 2 — not used to gate rotation in Phase 1
  minimum: 0,
  maximum: 1
},
filmScanRotationModelPath: {
  type: 'string',
  default: ''        // empty string = use bundled default
},
filmScanRotationDebugLog: {
  type: 'boolean',
  default: false     // extra winston output tagged [orientation]
}
```

**Startup behaviour in `index.js`:**
- If `filmScanRotationEnabled === false`: skip `orientation-service` initialisation entirely. The service file is still on disk but not loaded into memory. Mode 2 pipeline executes its original path.
- If `filmScanRotationEnabled === true`: load the ONNX session at startup (not lazily on first frame — startup time is acceptable, per-frame stall is not). Warm-up with a single dummy inference on a small black image to JIT-compile the graph.
- If `filmScanRotationEnabled === true` but model load fails: log fatal-level error, emit a notification to the renderer if visible, and fall back to behaving as if disabled. Never crash the app.

**Model path resolution:** if `filmScanRotationModelPath` is empty, resolve the bundled default via `path.join(process.resourcesPath, 'models/orientation/orientation_model_v2_0.9882.onnx')` in production, or the repo path in dev. Because of `asarUnpack`, `process.resourcesPath` resolves to a real filesystem path onnxruntime-node can read.

**Runtime toggling:** for Phase 1, changing the flag requires a restart (documented, acceptable). The existing `config:save` handler already restarts polling after a save — extend it to also restart orientation-service in a later enhancement.

---

## 9. Film Review Panel — renderer architecture

Build setup mirrors the existing Job Review Panel:

- Source at `src/renderer/views/FilmReview/` (mirrors `src/renderer/views/JobReview/`).
- Entry point `mount.jsx` — mounts React into `<div id="film-review-root">` via `createRoot`. Top-level component (`index.jsx`) is the App from the design prototype.
- Bundled by `scripts/build-renderer.js` — refactor its `entryPoints` to an array of two entries (`JobReview/mount.jsx` and `FilmReview/mount.jsx`) producing `job-review.bundle.js` and `film-review.bundle.js` in `src/renderer/`. The same esbuild options apply to both.
- **esbuild handles JSX at build time** via `jsx: 'automatic'` (already configured). No `import React` needed per file — but prototype's `React.useEffect`/`React.useState` references need converting to `useEffect`/`useState` imported from `'react'`.
- Load the bundle from `index.html` alongside `renderer.js` — match exactly how `job-review.bundle.js` is currently loaded (verify during implementation — it may be loaded dynamically from `renderer.js` rather than via a `<script>` tag).

### Component tree (from `docs/design/film-review-prototype/app/`)

Port the design prototype's components one-for-one, removing prototype-only scaffolding. The file mapping:

| Prototype file | Production location | Notes |
|----------------|---------------------|-------|
| `app/App.jsx` | `src/renderer/views/FilmReview/index.jsx` | Root component. Owns `rolls[]`, `openRollId`, `focusedFrame`, `tweaks` state. Drop the `tab` state (there's only one tab here — the panel IS the `Film` tab in the main window). Remove `BriefPanel` FAB and the prototype `TweaksPanel`. |
| — (new file) | `src/renderer/views/FilmReview/mount.jsx` | Mount wrapper, mirrors `JobReview/mount.jsx`. Imports `App` from `index.jsx` and `createRoot`s into `#film-review-root`. Simple — no open/close event dance needed since the tab is always mounted. |
| `app/Chrome.jsx` | *Do not port.* | Prototype-only — the main window already provides app chrome (header, tab bar). |
| `app/RollList.jsx` | `src/renderer/views/FilmReview/RollList.jsx` | Rolls index. Local state: `filter`, `query`. |
| `app/RollReview.jsx` | `src/renderer/views/FilmReview/RollReview.jsx` | Main grid. Contains `Stat`, `Chip`, `FrameCell`, `ConfidenceDot`, `FlagMenu` as co-located sub-components — keep them in this file, they're tightly coupled. Local state: `filter`, `hoverFrame`, `flagMenuFrame`. Keyboard handler wired at window level inside a `useEffect`. |
| `app/FocusedFrame.jsx` | `src/renderer/views/FilmReview/FocusedFrame.jsx` | Detail overlay. Local state: `showFlagMenu`. Re-uses `FlagMenu` imported from `RollReview`. |
| `app/BriefPanel.jsx` | *Do not port.* | Prototype artefact. Shows the design brief — not needed in production. |
| `lib/tweaks-panel.jsx` | *Do not port as-is.* | Convert to a proper settings surface (see below). |
| `app/styles.css` | `src/renderer/views/FilmReview/styles.css` | Port wholesale, then remove any `.brief-fab`, `.tweaks-panel`, and prototype-demo-only rules. Scope top-level selectors under `#panel-film` to avoid bleeding into other tabs. |
| `lib/pixfizz-tokens.css` | `src/renderer/views/FilmReview/tokens.css` | Port verbatim except fonts (see § 15). Rename CSS custom properties only if they clash with anything in the existing renderer styles — grep for `--pf-` first. |

### Tweaks / user preferences

The prototype treats Tweaks as a live design-variant explorer. In production, three of these (density, theme, keyboard hint visibility) are user preferences worth keeping; two (confidenceViz, flagBadgeStyle) are decisions the team should make once and bake in.

Recommended landing for Phase 1:

- `density` (`tight` | `regular` | `comfy`) — expose as a user preference in the panel's own settings menu. Default `regular`.
- `theme` (`light` | `dark`) — user preference. Default `light`. Persist in electron-store.
- `showKbdHint` (`boolean`) — user preference. Default `true`.
- `confidenceViz` — pick one variant for the first ship. The brief recommends `border`. Bake it in; if labs disagree, expose as a preference in a later release.
- `flagBadgeStyle` — same — pick one, bake in.

Persist preferences in a new electron-store key (`filmReviewPrefs`), separate from the feature flag config.

### State management

Local React state + typed IPC calls. No Redux, no global store, no server sync. The panel is a read/flag/mark-reviewed view and nothing more.

### Data flow

1. On mount, call `filmReview.listRolls()` → populate `rolls` state.
2. Subscribe to `filmReview.onRollProcessed` → prepend new roll on event.
3. When operator opens a roll, call `filmReview.getRoll(rollId)` — the summary list may not include every frame, so hydrate on demand.
4. Flag / unflag / mark-reviewed go through IPC; optimistically update local state, roll back on failure.

### Thumbnails

The design requires thumbnails large enough to spot a misrotation at 300×200 (regular density). Two architectural choices:

- **Pre-generate at ingest time.** When Mode 2 processes a frame, after `sharp.rotate()` and the JPEG conversion, emit a second `sharp` pass producing a 512×? thumbnail (handles both orientations without cropping) into a `thumbnails/` directory alongside the frame's local cache. The metadata record gets a `thumbnail_path`. IPC's `filmReview.getFrame` returns a `file://` URL the renderer `<img>` tag loads directly. **Recommended.**
- **Lazy-on-demand.** Renderer requests `getThumbnail(frameId)`, main process generates on first call, caches. Simpler but slow on first open — a 36-frame roll would jank.

Go with pre-generation. The cost per frame is ~50ms of sharp time once; the payoff is instant roll open.

### Visual states per `FrameCell` (derived from code)

| State | Source | Visual |
|-------|--------|--------|
| Confident, correct, unflagged | `ai_confidence >= 0.75 && rotation_applied` | Clean thumb; corner dot green; no border |
| Low confidence | `ai_confidence < 0.75 && rotation_applied` | Amber border + amber corner dot + numeric % (at regular/comfy density) |
| Very low confidence | `ai_confidence < 0.6` | Red-ish (low) corner dot; same border treatment as above |
| Rotation failed | `rotation_applied === false` | Red border + red corner dot + red "rotation failed" ribbon on thumb |
| Flagged | `operator_flags.length > 0` | Flag badge overlay (style depends on `flagBadgeStyle` tweak — pick `ring` for ship) |
| Hover | React state `hoverFrame === f.frame_id` | Overlay with flag-button affordance |

Confidence thresholds codified in `ConfidenceDot`:

- `< 0.6` → low (red/amber dot)
- `0.6–0.75` → mid (amber dot)
- `>= 0.75` → high (green dot)
- Error state (rotation failed) overrides — red dot regardless of confidence.

### Keyboard shortcuts (codified)

Wire these inside `useEffect` hooks at the relevant component level. **Skip** when the event target is an `INPUT` or `TEXTAREA`.

- **RollReview grid:** `F` → quick-flag hovered frame as `rotation` (no modal, no note). `Enter` → open hovered frame in detail.
- **FocusedFrame:** `←` / `→` navigate frames; `F` → open flag menu; `Esc` → close detail.
- **FlagMenu:** `1`–`4` → pick flag type; `Enter` → submit; `Esc` → cancel.

Surface the shortcuts inline in the UI (a hint row above the grid, footers on side panel and flag menu) — do not rely on a help menu.

---

## 10. Error handling and graceful failure

Failure modes and their intended behaviour:

| Failure | Intended behaviour |
|---------|---------------------|
| ONNX runtime fails to load at startup | Disable the feature (runtime = flag effectively OFF); log fatal; continue app. |
| Model weights file missing or corrupt | Same as above. |
| Inference throws mid-pipeline | Log error to per-frame metadata; skip rotation; continue pipeline with original TIFF. |
| Model returns malformed output (unexpected shape, NaN) | Treat as inference failure; same as above. |
| `sharp.rotate()` throws | Log error; attempt JPEG conversion on original TIFF; continue pipeline. |
| Out-of-memory during inference (big TIFF) | Catch `RangeError` / specific OOM signal; same as inference failure. |
| Metadata store write fails | Log warning; do not block the pipeline; frame proceeds without metadata record (it'll just not appear in Film Review Panel). |

Every one of these logs via Winston to `logs/app.log` with a consistent tag (`[orientation]`) so the feature can be debugged from logs alone.

---

## 11. Testing plan

**Manual regression (flag OFF):**
1. Fresh install with default config.
2. Drop a test TIFF into the watched folder.
3. Verify processed JPEG in S3 is byte-identical to pre-feature behaviour.
4. Verify no entries in `frame-metadata.json`.

**Manual smoke (flag ON, happy path):**
1. Enable flag in config.
2. Drop a known-correct-orientation TIFF into watched folder.
3. Verify AI predicts class 0, confidence >0.9, no rotation applied.
4. Verify metadata record exists with correct fields populated.
5. Open Film Review Panel, verify frame appears with high-confidence visual.

**Manual smoke (flag ON, rotation needed):**
1. Drop a TIFF that is deliberately rotated 90° CCW from correct orientation.
2. Verify AI predicts class 1 (needs 90° CW) with high confidence.
3. Verify output JPEG is correctly oriented.
4. Verify metadata captures predicted_class=1, rotation.applied=true, rotation.angle=90.

**Manual failure-injection:**
1. Rename/delete the model file before startup. Verify feature gracefully disables, app still launches, Mode 2 still works without rotation.
2. Feed a corrupt TIFF. Verify error captured in metadata, pipeline continues.

**Accuracy spot-check on real film scans:**
1. Before any public rollout, run 100+ real film scan frames through the model and tally correct/incorrect predictions.
2. Record confidence distribution for both correct and incorrect predictions. This is the foundation for any future confidence-threshold decision and fine-tuning work.

---

## 12. Implementation order (milestones)

**Milestone 1 — Plumbing, no model yet.**
- Add `onnxruntime-node` dependency.
- Create `orientation-service.js` skeleton (interface, no inference yet — returns class 0 / confidence 1.0 always).
- Create `frame-metadata-store.js`.
- Add `filmScanRotation` config section with flag defaulting to OFF.
- Wire orientation-service into `folder-watch-service.js` behind the flag.
- Write regression test: flag OFF produces identical output to pre-feature.

**Milestone 2 — Model integration.**
- Export ONNX model from the HuggingFace repo, commit to `resources/models/orientation/`.
- Implement real inference in `orientation-service.js`.
- Implement `sharp.rotate()` in the pipeline.
- Implement full metadata capture.
- Smoke-test with real scans. Confirm accuracy matches expectations.

**Milestone 3 — Film Review Panel (shell).**
- Refactor `scripts/build-renderer.js` to bundle both Job Review and Film Review entries.
- Create `src/renderer/views/FilmReview/{mount.jsx,index.jsx}` skeleton.
- Add `Film` tab button + `#panel-film` tab panel + `#film-review-root` div to `src/renderer/index.html`.
- Wire the tab click in `renderer.js` to show the panel (matches existing pattern for other tabs).
- Register Film Review IPC handlers in `src/main/ipc-handlers.js` returning stub data (empty rolls array).
- Expose preload methods on `electronAPI`.
- Verify: clicking the Film tab shows an empty "no rolls yet" state rendered by React.

**Milestone 4 — Film Review Panel (design integration).**

Port the Claude Design prototype from `docs/design/film-review-prototype/` into the renderer. Work in this order — the dependency graph matters.

1. **Tokens and styles first.** Copy `lib/pixfizz-tokens.css` → `src/renderer/views/FilmReview/tokens.css` verbatim. Resolve the font-loading question (§ 15) — replace `@import` with local `@font-face`. Copy `app/styles.css` → `src/renderer/views/FilmReview/styles.css` and strip `.brief-fab`, `.tweaks-panel`, and any other prototype-demo-only rules. Scope top-level selectors under `#panel-film` to avoid bleeding into other tabs.
2. **Remove the mock data layer.** Delete `assets/mockdata.js` and `assets/film-thumbs.js` from the port. Drop the mock-only `display_rotation` field from the frame shape — real pipeline rotations are applied to pixels, not simulated in CSS. Drop the mock `portrait` boolean or let the `<img>` render the thumbnail's natural aspect.
3. **Convert React globals.** The prototype uses `React.useEffect`, `React.useState` etc. via a UMD global. Production uses `jsx: 'automatic'` and named imports. Replace every `React.xxx` call with a named import from `'react'`.
4. **`mount.jsx`.** Create `src/renderer/views/FilmReview/mount.jsx`. `import { App } from './index.jsx'`; `createRoot(document.getElementById('film-review-root')).render(<App />)`.
5. **`index.jsx` (was `App.jsx`).** Port as the root component. Drop the prototype's top-level tab state — the panel IS the Film tab. Skip `Chrome.jsx` entirely.
6. **`RollList`.** Port `app/RollList.jsx` → `src/renderer/views/FilmReview/RollList.jsx`. Wire to `electronAPI.filmReviewListRolls()`. Keep the `filter` (`ready` / `processing` / `reviewed` / `all`) and `query` local state. Sort by `scanned_at` desc.
7. **`RollReview` + co-located sub-components.** Port `app/RollReview.jsx` → `src/renderer/views/FilmReview/RollReview.jsx`. Keep `Stat`, `Chip`, `FrameCell`, `ConfidenceDot`, `FlagMenu` in the same file — they're tightly coupled. Wire `electronAPI.filmReviewGetRoll(rollId)` on mount, `filmReviewFlagFrame` / `filmReviewUnflagFrame` / `filmReviewMarkRollReviewed` / `filmReviewOpenFolder` on the respective buttons. Remove any reference to `display_rotation`.
8. **`FocusedFrame`.** Port `app/FocusedFrame.jsx` → `src/renderer/views/FilmReview/FocusedFrame.jsx`. Import `FlagMenu` from `RollReview.jsx`. Wire keyboard handlers inside `useEffect`. Skip the handlers when the event target is an `INPUT` or `TEXTAREA`.
9. **Typed flag menu.** The prototype's `FlagMenu` has four types with keyboard shortcuts 1–4. Verify the IPC contract in § 7 matches the shape (`{ type, note }`) the component submits. Add the submit/cancel flow.
10. **Keyboard navigation.** Wire at the `RollReview` level for `F` / `Enter`, at the `FocusedFrame` level for `←` / `→` / `F` / `Esc`, at the `FlagMenu` level for `1`–`4` / `Enter` / `Esc`. Show the hint row above the grid and in the panel/menu footers — controlled by the persisted `showKbdHint` preference. Important: only listen to keyboard events when the Film tab is active — compare `document.activeElement` or check the tab panel's `.active` class, to avoid stealing keys from other tabs.
11. **Tweaks conversion.** The prototype's `lib/tweaks-panel.jsx` is a design-variant explorer — do not ship it. Expose `density`, `theme`, `showKbdHint` as user preferences (settings menu in the panel header). Bake `confidenceViz = 'border'` and `flagBadgeStyle = 'ring'` into the FrameCell directly. Wire `electronAPI.filmReviewGetTweaks()` / `filmReviewSetTweak()` for persistence.
12. **"Mark roll reviewed".** Wire the CTA in the roll header to `electronAPI.filmReviewMarkRollReviewed(rollId)`. On success, navigate back to the list and remove the roll from the `ready_for_review` filter.
13. **Smoke pass.** Run a real roll through the pipeline (flag ON), open the panel, confirm every visual state in the § 9 table renders correctly on real thumbnails.

**Milestone 5 — Licence, installer, docs.**
- `THIRD_PARTY_LICENSES.md`.
- Electron-builder config for bundling the model.
- About screen link.
- Update `ARCHITECTURE.md`.
- Update user-facing release notes for the feature flag.

**Milestone 6 — Pilot rollout.**
- Enable flag for one lab.
- Monitor logs and Film Review Panel for a week.
- Collect baseline accuracy data.
- Review findings before wider rollout.

---

## 13. Open items and deferred decisions

- **Thumbnail generation strategy.** Generate alongside JPEG output or lazy-on-demand from the Film Review Panel? Lean: alongside. Decide at Milestone 3.
- **Model file distribution.** Committed to repo vs. git-LFS vs. downloaded on first run. Lean: committed for now; revisit if repo bloat becomes painful.
- **Retention policy on `frame-metadata.json`.** Not an issue for Phase 1; will be at some point. Add a TODO, defer.
- **Runtime flag toggling.** Deferred — restart-to-toggle is acceptable for Phase 1.
- **Concurrency.** Mode 2 can process frames in parallel; orientation-service needs a concurrency guard (onnxruntime-node sessions are not always thread-safe). Lean: single-frame serial inference in Phase 1, parallelise only if throughput becomes an issue.
- **What happens if the operator flags a frame after the roll has been uploaded to S3?** Flag stays local in `frame-metadata.json`. No back-propagation to OrderHub in Phase 1. Accepted.

---

## 14. What this plan explicitly does NOT do

- No OrderHub/Lovable changes.
- No manual rotation UI (operators can flag only).
- No feedback/retraining pipeline — just the data capture that makes it possible later.
- No confidence calibration.
- No Film Production Management workflow (Receipt / Staging / Awaiting Scanning / Scanned / Errors).
- No changes to the Mode 1 (FTP polling), Mode 3 (File Uploads), or print controller pipelines.
- No Job Review Panel changes.
- No automated model updates — a new model ships via the normal OHD installer update cycle.

---

## 15. Design integration notes (prototype → production)

The prototype at `docs/design/film-review-prototype/` is a browser-only React-UMD + in-browser-Babel shell. Several things that are fine in that context will break or be wrong in production. These are the non-obvious ones.

### Font loading

`lib/pixfizz-tokens.css` line 12 imports Hind + JetBrains Mono from Google Fonts via `@import`. This will silently fail in a packaged Electron app on a lab machine with no internet — the font stack will fall back to `-apple-system` / `Segoe UI` and the panel will look subtly wrong.

Resolution: bundle the fonts locally. Download Hind (300/400/500/600/700) and JetBrains Mono (400/500) as WOFF2 files into `src/renderer/film-review/fonts/`, and replace the `@import` in `tokens.css` with `@font-face` declarations pointing at those files. Effra remains in the stack as the preferred font — users with the licensed font installed locally will still pick it up. Verify with the installer actually running offline that the UI renders correctly.

### In-browser Babel removed

The prototype's `Film Review Panel.html` uses `<script type="text/babel">` and the Babel standalone CDN to transpile JSX at page-load time. Production uses esbuild at build time — add a `build:film-review` script to `package.json` that bundles `src/renderer/film-review/index.jsx` into `film-review.bundle.js`, then reference that from the window's loaded HTML (or from a plain `index.html` in the renderer dir).

### React UMD removed

The prototype loads React 18 UMD from a CDN, which is why prototype components call `React.useEffect`, `React.useState`, etc. Production bundles `react` / `react-dom/client` from npm via esbuild — already installed and used by Job Review. Every `React.xxx` reference in the prototype must be converted to a named import from `'react'`. Automatic JSX transform (already configured in `scripts/build-renderer.js`) means no `import React from 'react'` line is needed — only the hooks.

### Mock data removed

`assets/mockdata.js` and `assets/film-thumbs.js` are prototype-only. The production data source is `frame-metadata-store` via the IPC layer. Two subtle differences to fix during the port:

- The mock's `display_rotation` field is a CSS trick to fake a misrotated thumbnail for demo purposes. Production doesn't need it — real misrotations show up as already-rotated pixels on disk. Remove any CSS `transform: rotate()` driven by this field.
- The mock's `portrait` boolean flags aspect ratio. Production can derive this at thumbnail-generation time from the sharp output dimensions and store it on the frame record, or just let the `<img>` render whatever aspect the thumbnail file has. Prefer the latter — one fewer metadata field.

### Prototype-only UI bits to strip

- `app/BriefPanel.jsx` and the `.brief-fab` floating button — a prototype affordance for reading the design brief. Do not port.
- `lib/tweaks-panel.jsx` and the `.tweaks-panel` styles — replaced by the settings menu described in § 9 "Tweaks / user preferences". Do not port as-is.
- Any "mock" or "demo" console.logs in the prototype's entry point.

### Token CSS ported verbatim

`lib/pixfizz-tokens.css` is the brand's design-system file. Port it verbatim (only font `@import` replaced, per above). Rename custom properties only if they clash with tokens already in the Job Review Panel — they shouldn't, since Job Review doesn't currently use `--pf-*` prefixed tokens, but verify.

### Dark theme

The prototype supports a dark theme toggle (`tweaks.theme === 'dark'`). Keep it — lab environments are often dim and operators have asked for dark UIs before. The token file already defines the light palette; the dark swap happens in `styles.css` via a `[data-theme="dark"]` selector. Verify that all prototype-demo-only rules are removed from that selector too.

### CSS scoping — don't leak styles into other tabs

The panel lives inside the existing `src/renderer/index.html` alongside Jobs / Settings / Activity Log. The prototype CSS uses generic selectors (`.frame-cell`, `.stat`, `.chip`, etc) that could collide with existing or future styles. Wrap the top-level selector in `styles.css` under `#panel-film` to sandbox it. Same care for `tokens.css` — the `--pf-*` custom properties are fine because they're namespaced, but do grep the existing renderer CSS for any `--pf-` tokens before porting.

### Keyboard event scoping

The prototype assumes window-level keyboard handlers. In production it shares a BrowserWindow with Jobs / Settings / Activity Log, so its `keydown` listeners must not steal keys when the Film tab isn't active. Gate the handler either by checking `document.getElementById('panel-film').classList.contains('active')` or by listening on the tab panel element itself rather than `window`.

### Accessibility pass

The prototype optimises for speed and density; verify before pilot that:

- All interactive elements (flag icons, filter chips, density buttons) have `aria-label` or visible text.
- Colour is never the only confidence signal — the corner dot is a colour cue, but the amber border and the numeric % provide redundant channels. Keep both.
- Keyboard users can reach every control with Tab in a sensible order. The prototype's keyboard flow is hover-dependent (`F` on hovered frame); add a visible "focused frame" ring for keyboard-only navigation of the grid.
