# Phase 1 Implementation Plan — Local AI Image Enhancement

**Scope:** Add a local, on-device AI image enhancement provider (`realesr-general-x4v3` from Real-ESRGAN) to OHD, branded user-facing as **"Pixfizz AI Enhancement"**. This becomes the default enhancement provider on all installs (fresh and upgraded). The existing **Replicate** provider is removed entirely as part of this work. **Topaz** is retained as an optional premium provider — it appears as a second option in Settings only when a valid Topaz API key is configured. With no Topaz key, Pixfizz AI Enhancement is the only provider available. Bundled with the installer; visible by default on existing installs after upgrade.

**Source of truth for this plan:** `ARCHITECTURE.md` at the repo root, the PW-007 Phase 1 plan (`phase-1-implementation-plan.md`), and the AI Quality Gate Phase 1 plan (`phase-1-implementation-plan-ai-quality.md`). This plan extends both — it does not invent parallel patterns. The implementer should verify line-level specifics against the live source tree, especially `enhancement/enhancementManager.js`, `services/ai-inference-host.js`, `services/ai-inference-models/musiq-loader.js` (the closest analogue), and `services/ai-job-quality-orchestrator.js`.

**Hard prerequisites:** None. The PW-007 utilityProcess refactor and the AI Quality Gate's MUSIQ scoring are already shipped (v1.3.x). The infrastructure this plan builds on is in production. The comment at `ai-inference-host.js:164` ("New models (fbcnn, realesrgan) get added here in their respective milestones") and the M4-deferred reference at `ai-job-quality-orchestrator.js:23` ("happens in M4 via ai-fixup-service, not here") are the explicit extension points this work fills.

**Relationship to the AI Quality Gate plan:** The original AI Quality Gate Phase 1 plan listed `realesrgan` and `fbcnn` as fixup models. This plan delivers the `realesrgan` half, intentionally narrower than originally scoped: only one model (`realesr-general-x4v3`), only one task (4× super-resolution + implicit denoise/deblock), and bundling under the existing cloud-provider abstraction so it's reachable from both the user-initiated enhancement path *and* the quality-gate fixup path through a single local-inference plumbing. FBCNN-specific JPEG artefact removal is deferred — Real-ESRGAN-general handles JPEG artefacts adequately as a side effect of its training distribution, and a second model can be added later without re-architecting.

---

## 0. Decisions made before kickoff

The following product decisions are settled and should not be revisited during implementation:

1. **Default provider, all installs:** `'local'` (branded "Pixfizz AI Enhancement") for both fresh installs and upgrades. Existing installs with `enhancementProvider: 'replicate'` are silently migrated to `'local'` at first launch after upgrade, with a release-note callout. Existing installs with `enhancementProvider: 'topaz'` keep Topaz.
2. **Replicate provider removed entirely.** All `replicateClient.js` code, IPC paths, sidecar references, Settings UI fields, and config keys for Replicate are deleted. Not deprecated, not feature-flagged off — removed. See §4 for the deletion list.
3. **Topaz remains as an optional premium provider.** Available only when a valid `topazApiKey` is configured. Settings dropdown shows two options ("Pixfizz AI Enhancement" + "Topaz") when configured, one option (just "Pixfizz AI Enhancement") when not.
4. **Existing-install rollout: visible by default.** Pixfizz AI Enhancement appears in Settings dropdown without requiring opt-in. No `enhancementProviderLocalEnabled` config flag is needed.
5. **Auto-enhance default: OFF.** `enhancementAutoEnhance` continues to default `false` on fresh installs. Operator-in-the-loop principle preserved regardless of cost.
6. **Cloud-provider rescoring (Topaz): YES.** Topaz path also rescores after enhancement, behind a `enhancementRescoreAfter` config flag defaulting `true` for fresh installs and `true` for upgrades (since this is part of a major release that introduces the rescore concept generally).
7. **Score-regression handling: silently accept.** If the enhanced image scores lower than the original, the system records both scores in the sidecar and shows the delta in the drawer ("Score: 72 → 68") but does not warn or force a Keep-vs-Revert decision. The operator can use the existing per-image revert button if they want to undo. Trust the enhancement; surface the data; let the operator notice if they care.
8. **Model re-download path: deferred to follow-up.** No in-app "Re-download model" affordance in this milestone. If MUSIQ has been stable across customer environments, Real-ESRGAN will be too.
9. **Execution provider: CPU only for v1.** No DirectML in Phase 1. CPU latency (40–90 s on a 12 MP source) is accepted as the v1 cost; a Phase 1.1 milestone for DirectML can be planned after field feedback.
10. **Tile size default: 256 × 256 with 16 px overlap.** Exposed as advanced setting for field tuning but not normally touched.
11. **Model dropdown: not exposed in Settings.** The provider is hard-coded to `realesr-general-x4v3` for Pixfizz AI Enhancement in v1. Only Topaz exposes a model dropdown (existing behaviour).

---

## 1. Design principles (non-negotiable)

- **Pixfizz AI Enhancement is the default everywhere.** On fresh installs and upgrades, the provider defaults to `'local'`. The model file ships in the installer unconditionally; the inference rails are always live. There is no opt-in flag.
- **Operator stays in the loop.** Auto-enhance on quality-gate fail remains gated by the existing `enhancementAutoEnhance` config (default OFF). The new provider does not change trigger semantics, only the backend.
- **Graceful failure everywhere.** If the model file is missing, the ONNX session fails to load, or inference throws, the local provider reports failure to the caller. If Topaz is configured, the operator can manually retry via Topaz; otherwise the operator decides whether to accept the image as-is or reject the job. Quality-gate fixup falls back to "operator decides" — never to silent damage.
- **Replicate is gone.** Existing installs configured for Replicate are migrated to Pixfizz AI Enhancement at first launch after upgrade. No Replicate code paths remain in the codebase. No fallback to Replicate is possible — it doesn't exist.
- **Inference is isolated from the main process.** The new model is loaded into the existing `ai-inference-host` utilityProcess alongside MUSIQ and the orientation model. The main process queues requests through `ai-inference-client` and consumes results — it does not load the model or run inference directly. This protects FTP polling, S3 uploads, file watching, and renderer IPC during long upscaling runs.
- **Tile-based inference is mandatory, not optional.** Naive whole-image inference will OOM on a 12 MP source at 4× upscale. Every code path that reaches the model goes through the tiling preprocessor.
- **Originals untouchable without an explicit revert path.** Enhancement output is written to `/cache/{baseName}_enhanced.jpg` and the working copy is updated to point to it; the original sits in `/originals/{filename}` and is never modified. On the first edit of any image in a job, `originalsManager.js` snapshots all images from `/working/` into `/originals/` — local enhancement counts as an edit and triggers this snapshot like any other. Revert-to-original is always available via `originalsManager.resetImage()` (single image) or `resetJob()` (full job). Same posture as the existing cloud providers.
- **Always rescore after enhancement.** Every enhancement run (whether user-initiated or quality-gate-triggered) is followed by a MUSIQ rescore on the enhanced output. Both pre- and post-fixup scores are written to the sidecar. This gives the operator immediate quantitative feedback, captures the improvement (or regression) for audit, and handles the rare case where enhancement worsens the image. MUSIQ is already loaded in the host; rescore overhead is ~1–2 s and negligible alongside the 40–90 s enhancement.
- **Log everything now.** Tile counts, per-tile inference time, total wall-clock, peak memory if available, EP used, model version, before/after MUSIQ score (when called via the quality-gate path). Same posture as the AI Quality Gate.

---

## 2. New dependencies and installer impact

**Already added by PW-007 and AI Quality Gate:** `onnxruntime-node@^1.20.0`, `sharp@^0.34.5`, the utilityProcess host, the inference client. No new runtime dependencies.

**New bundled model file** (in `resources/models/`):

| Path | Purpose | Size |
|------|---------|------|
| `resources/models/realesrgan/realesr-general-x4v3.onnx` | 4× super-resolution + implicit denoise/deblock | ~5 MB |
| `resources/models/realesrgan/LICENSE` | BSD-3-Clause text, verbatim from upstream | tiny |
| `resources/models/realesrgan/MODEL_CARD.md` | Source, training, licence, conversion provenance | tiny |

**Total installer impact:** ~5 MB on top of the existing MUSIQ (131 MB) and orientation (77 MB) models. Negligible.

**Attribution artefact:** extend `THIRD_PARTY_LICENSES.md` with a section for Real-ESRGAN (BSD-3-Clause, copyright Xintao Wang 2021). The full LICENSE text is a verbatim drop of the upstream `xinntao/Real-ESRGAN/LICENSE` file. No NOTICE preservation requirement (BSD-3-Clause has none); only the copyright + permission text.

**Electron-builder config:** `extraResources` already covers `resources/models/**`. New folder is picked up automatically.

**No Python runtime dependency at runtime.** Python is needed only for the one-shot conversion at build prep time. The output `.onnx` is the only artefact that ships.

---

## 3. New files

All paths relative to repo root.

| Path | Purpose |
|------|---------|
| `src/main/services/ai-inference-models/realesrgan-loader.js` | Host-side loader for the Real-ESRGAN ONNX session. Mirrors `musiq-loader.js`. Exports `modelId`, `modelFile`, `resolveModelPath()`, `prepareTensor()`, `postprocess()`. Inputs: float32 NCHW image tile in `[1, 3, H, W]`, normalised to `[0, 1]`. Outputs: same shape, spatial dimensions ×4. Postprocess clamps to `[0, 1]` and converts to uint8. |
| `src/main/services/ai-inference-models/realesrgan-preprocessor.js` | The new conceptual piece: tile-based inference. Splits a source image into overlapping square tiles (default 256×256, 16-px overlap), tracks tile coordinates, returns an iterator of `{tile: Float32Array, srcX, srcY, w, h}` records. Companion `stitch(tiles, sourceWidth, sourceHeight, scale)` blends overlapping output tiles with linear feathering and returns the final 4×-scaled image as a sharp pipeline. Tile size is configurable for memory/perf tuning; overlap is fixed. |
| `src/main/services/ai-inference-models/__tests__/realesrgan-preprocessor.test.js` | Unit tests for tiling and stitching: correct tile count for various source sizes, no seam artefacts at overlap boundaries, output dimensions exactly 4× input, edge tiles handled (right and bottom edges with partial coverage). |
| `src/main/enhancement/localClient.js` | Sibling to the retained `topazClient.js` (Replicate is deleted — see §4). Surface: `enhance(srcPath, options)`, `startEnhancement(srcPath, options) → jobId`, `checkEnhancement(jobId) → { status, outputPath?, progress? }`, `cancelEnhancement(jobId)`. Internally: sends an inference request per tile through `ai-inference-client`, accumulates tile outputs, runs `realesrgan-preprocessor.stitch()`, writes the final JPEG, resolves the job. Tracks active jobs in a Map keyed by synthetic `local_*` IDs (mirrors the `topaz_*` pattern). |
| `src/main/services/ai-fixup-service.js` | The deferred service from the AI Quality Gate Phase 1 plan. `applyFixup(imagePath, options) → { outputPath, beforeScore, afterScore, kept, model, error? }`. Calls `localClient.enhance()` for the local provider, optionally re-scores with MUSIQ (pre/post comparison), and writes through `originalsManager.js`. Used by the quality-gate fixup path; not by the user-initiated enhancement path (which goes through `enhancementManager.js` directly). |
| `tools/onnx-export/_realesrgan_src/convert.py` | One-shot Python conversion script: download the official `realesr-general-x4v3.pth` from the `xinntao/Real-ESRGAN` v0.2.5.0 release, load via `RealESRGANer` / `SRVGGNetCompact`, export with `torch.onnx.export()` using `dynamic_axes` on H and W, opset 18. ~50 lines incl. error handling. |
| `tools/onnx-export/_realesrgan_src/validate-parity.py` | Parity validation script: run the same test image (a fixture under `tools/onnx-export/_realesrgan_src/fixtures/`) through both the original `.pth` (PyTorch reference) and the exported `.onnx` (via `onnxruntime`). Compare outputs pixel-wise, fail if max abs diff > 1/255. ~40 lines. |
| `tools/onnx-export/_realesrgan_src/README.md` | Provenance: where the `.pth` came from, exact commit/release tag, conversion command, parity test command, expected output. Same convention as the MUSIQ conversion docs. |
| `tools/onnx-export/realesr-general-x4v3.model.json` | Sidecar metadata file (input/output names, shapes, opset, sha256 of the `.onnx`). Mirrors the MUSIQ pattern. |
| `tools/onnx-export/_realesrgan_src/fixtures/test-image-input.jpg` | A small (e.g. 256×384) test image used by the parity test. Copyright-clean — use one of the existing test fixtures from `tests/fixtures/` or generate a synthetic image. |
| `docs/local-enhancement/README.md` | User/operator-facing doc: what Pixfizz AI Enhancement does, when to use it vs Topaz (when configured), performance expectations, troubleshooting, migration note for Replicate users. |
| `docs/local-enhancement/conversion-audit.md` | Engineering doc: ONNX conversion provenance, parity validation results, EP fallback chain, tile-size sensitivity analysis (if measured). Same convention as `docs/ai-quality-gate/conversion-audit.md`. |
| `docs/local-enhancement/licensing-audit.md` | Trace from upstream BSD-3-Clause through to the bundled LICENSE file and the third-party-licenses screen. Same convention as `docs/ai-quality-gate/licensing-audit.md`. |

---

## 4. Files to modify

| Path | Change |
|------|---------|
| `src/main/services/ai-inference-host.js` | Register the Real-ESRGAN loader in `loadAllModels()` alongside the existing MUSIQ and orientation registrations (~3 lines around line 154). Update the comment at line 164 to reflect that realesrgan is now landed. |
| `src/main/enhancement/enhancementManager.js` | Significant rework: remove all Replicate handling, add local-provider handling. Delete the `replicateClient` import and all `provider === 'replicate'` branches in `enhanceImage()`, `startEnhancement()`, `checkEnhancement()`, `cancelEnhancement()`, and `validateApiKey()`. Add `provider === 'local'` branches with the integration shape per §8.1. After enhancement succeeds (any provider), run a MUSIQ rescore via `aiQualityService.scoreImage()` if `enhancementRescoreAfter === true`, and write `scoreBefore` / `scoreAfter` to the sidecar. Default provider when unconfigured: `'local'`. |
| `src/main/services/ai-job-quality-orchestrator.js` | If `aiQualityMode === 'block'` and `enhancementAutoEnhance === true`, call `ai-fixup-service.applyFixup()` on quality-gate-failed images before holding the job. Provider used is whatever `enhancementProvider` is configured (`'local'` or `'topaz'`). Behaviour with auto-enhance off is unchanged. (Note: this delivers M4 of the original AI Quality Gate plan.) |
| `src/main/services/config-service.js` | Migration logic: on first launch after upgrade, if `enhancementProvider === 'replicate'`, change it to `'local'` and log the migration. Delete `replicateApiKey` config key. Add `enhancementLocalTileSize` (default `256`), `enhancementLocalTileOverlap` (default `16`), `enhancementRescoreAfter` (default `true`). The `enhancementProvider` enum becomes `'local' \| 'topaz'` (drops `'replicate'`); default `'local'`. |
| `src/main/ipc-handlers.js` | Remove any `ohd:replicate:*` IPC handlers if present. The existing `ohd:enhancement:run`, `:status`, `:cancel` handlers route through `enhancementManager` and handle the new provider transparently. The `enhancement:test` handler special-cases `'local'` to do a one-tile dry run rather than an API key check. |
| `src/renderer/index.html` | Remove the Replicate API key input field and any Replicate-only disclosure sections. Rename the `enhancementProvider` `<select>` options: `"Pixfizz AI Enhancement"` (value `'local'`), `"Topaz"` (value `'topaz'`, hidden via JS when `topazApiKey` is unset). Add a new disclosure section for advanced local-provider settings (tile size and overlap), collapsed by default, only shown when `'local'` is selected. |
| `src/renderer/renderer.js` | Remove all Replicate-specific code paths (populate/save/validate/test for the Replicate API key). Update `populate` and `save` handlers around lines 1505–1600 for the `'local'` provider and the new advanced fields. Rewrite `updateEnhancementProviderSections()` (~line 1936) to: (a) hide the Topaz option entirely if no Topaz API key is configured, (b) show advanced local-settings disclosure when `'local'` is selected, (c) show Topaz model-selection / API-key fields when `'topaz'` is selected. Add `Test` button behaviour for `'local'` (dry-run inference on a small bundled fixture). |
| `src/main/enhancement/topazClient.js` | Minor: confirm output path returned to `enhancementManager` so the manager-level rescore in M2 can read the enhanced file. Probably no change, but verify. |
| `ARCHITECTURE.md` | Add a "Pixfizz AI Enhancement" subsection under the AI Image Enhancement service map. Update the AI Inference Host model registry table to include `realesr-general-x4v3`. Add a pending-work row for Phase 1.1 (DirectML execution provider) and Phase 2 (additional local models — FBCNN if needed). Note Replicate's removal in the changelog/migration log section. |
| About / third-party-licenses screen | Add Real-ESRGAN (BSD-3-Clause) entry. Remove Replicate API attribution if present. |
| Release notes | New section: "Replicate has been removed. Existing labs configured for Replicate will be migrated to Pixfizz AI Enhancement automatically. Topaz remains available for labs with a configured API key." |

### 4a. Files to delete

| Path | Reason |
|------|---------|
| `src/main/enhancement/replicateClient.js` | Replicate provider removed entirely. |
| `src/main/enhancement/__tests__/replicateClient.test.js` (if present) | Same. |
| Any `tools/`, `scripts/`, or `docs/` files referencing only Replicate | Same. |
| `replicateApiKey` references throughout — grep for `replicate` (case-insensitive) and clean up | Same. |

---

## 5. Data model — sidecar enhancement record

The existing `enhancement` block in the per-image sidecar (written by `enhancementManager.js`) already carries `enhancedAt` and `enhancementModel`. Extend with fields populated for the local provider, including the rescore pair which is *always* written when the local provider is used (regardless of whether the path was user-initiated or quality-gate-triggered):

```json
{
  "enhancement": {
    "enhancedAt": "2026-05-12T14:23:01.234Z",
    "enhancementModel": "realesr-general-x4v3",
    "provider": "local",
    "modelVersion": "realesr-general-x4v3",
    "inferenceMs": 47823,
    "tileCount": 192,
    "tileSize": 256,
    "tileOverlap": 16,
    "executionProvider": "cpu",
    "scoreBefore": 38,
    "scoreAfter": 67,
    "scoreModel": "musiq-spaq-3scale-cap1024-v1",
    "triggeredBy": "operator"
  }
}
```

`triggeredBy` is `"operator"` for the user-initiated path (§8.1) and `"quality-gate"` for the auto-enhance path (§8.2). This makes the audit trail unambiguous when reviewing sidecar history.

`scoreBefore` and `scoreAfter` are populated unconditionally for both `'local'` and `'topaz'` (per Decision §0.6 — rescoring applies to both). Topaz sidecar entries do not get the local-specific tile-related fields. Sidecar consumers must handle field absence — extend `jobSchema.js` with optional fields throughout.

**Original file preservation:** the `/originals/{filename}` snapshot is the canonical pre-enhancement source. The sidecar `scoreBefore` is taken from the working file *immediately before* enhancement runs; if the image had earlier edits (rotation, crop) before enhancement, `scoreBefore` reflects the post-rotation/crop state, not the originals-folder state. This is intentional — the operator wants to know if *this* enhancement helped, not whether the cumulative pipeline helped. A separate "score relative to original" can be derived later if needed by re-scoring the originals copy.

---

## 6. Configuration

`config.json` keys (with defaults for fresh install):

```jsonc
{
  // unchanged keys
  "topazApiKey": "",                              // existing — only Topaz key is retained
  "topazDefaultModel": "Standard V2",             // existing
  "enhancementAutoEnhance": false,                // existing — Decision §0.5 keeps default OFF
  "enhancementFaceEnhancement": false,            // existing

  // changed keys
  "enhancementProvider": "local",                 // existing key, enum narrowed to 'local' | 'topaz'

  // new keys
  "enhancementLocalTileSize": 256,                // advanced tuning, default 256
  "enhancementLocalTileOverlap": 16,              // advanced tuning, default 16
  "enhancementRescoreAfter": true                 // rescore after enhancement (any provider)
}
```

**Removed keys** (deleted from config schema; migration silently strips them):
- `replicateApiKey`

**Migration behaviour at first launch after upgrade:**

```
if (config.enhancementProvider === 'replicate') {
  config.enhancementProvider = 'local';
  log.info('Replicate provider removed; migrated to Pixfizz AI Enhancement');
  // optionally: surface a one-time toast in the UI
}
delete config.replicateApiKey;
```

The migration is silent in the config file but called out in release notes and a one-time toast notification: *"Replicate has been removed in this release. You are now using Pixfizz AI Enhancement (local). Topaz remains available if your Topaz API key is configured."*

**Fresh installs:** `enhancementProvider: 'local'` is the default. No API key needed; works out of the box.

**Tile-size and overlap** are exposed in an advanced/disclosure section in Settings and not normally touched. They exist to give field engineers a knob if a particular site has memory constraints. Default 256/16 is the safe choice everywhere.

**`enhancementRescoreAfter`** defaults to `true` for fresh installs and is *also* set to `true` at migration for upgraded installs (this is part of the major release that introduces rescoring as a concept). Operators on Topaz who want the old "no rescore" behaviour can flip it to `false` in advanced settings.

---

## 7. Inference architecture

### 7.1 Tile-and-stitch

Source image (e.g. 1500 × 2000) → tiles of `tileSize × tileSize` (default 256 × 256) with `tileOverlap` pixels of overlap on each side that has a neighbour. Edge tiles on the right and bottom may be smaller than full size; preprocessor pads with reflection to the model's expected dimensions and crops the corresponding region from the output.

Each tile becomes a separate inference request to the `ai-inference-host`. The host runs them serially within a single inference call (one model session, sequential tile dispatch — not parallel within a single image, as that would oversubscribe the EP).

Output tiles (each `4·tileSize × 4·tileSize`) are stitched into a `4·sourceWidth × 4·sourceHeight` canvas. In overlap regions, output pixels are blended via linear feathering: weight `1.0` at the centre of the tile, ramping down to `0.0` at the outer edge of the overlap zone. This eliminates visible seams.

Reference algorithms exist in:
- The `upscaler` npm package (JS reference).
- Real-ESRGAN's own `realesrgan_utils.py` (Python reference, `RealESRGANer.tile_process()`).

The implementer should not innovate on this algorithm — it is well-trodden ground and divergence will produce visible artefacts.

### 7.2 Execution provider

**Decision §0.9: CPU only for v1.** Phase 1 ships with `onnxruntime-node@1.20` running CPU-only — no integration changes to the runtime, no build-pipeline changes, no new packaging considerations. Latency on a 12 MP source (~190 tiles at default size) is in the range 40–90 s on a recent Intel/Ryzen CPU. This is accepted as the v1 cost.

Why CPU is acceptable for v1:
- Operator workflow already includes progress reporting; a 60-second wait with a tile-by-tile progress bar is tolerable for an operator-initiated action.
- Auto-enhance runs in the background while the operator is doing other work — latency does not block them.
- No new runtime dependencies or build-pipeline complexity in v1.

The `executionProvider` sidecar field is written from day one so we can audit performance retroactively and quantify the win when DirectML lands.

**DirectML is deferred to Phase 1.1.** A separate, smaller plan will pick up GPU acceleration once we have field data on whether CPU latency is genuinely tolerable. The integration approaches under consideration:

- Switching to a custom-built `onnxruntime-node` binary with DML enabled (build-pipeline changes).
- Switching to `onnxruntime-node-gpu` if it ships DML on Windows.
- Using `onnxruntime-web` with WebGPU in a renderer-side worker.

None of these blocks v1.

### 7.3 Concurrency

One enhancement job at a time, queued. Two jobs in flight would compete for the same model session and produce no throughput gain — the GPU/CPU is the bottleneck, not the scheduler. Existing `enhancementManager` already serialises by job ID; no new queue infrastructure needed.

MUSIQ scoring and orientation inference can interleave with enhancement freely — they're separate sessions in the same host process, and a tile-level interleave is fine.

---

## 8. Two integration paths

The local provider is reachable through two distinct call paths. Both go through the same inference plumbing and both produce identical sidecar shape (including the `scoreBefore` / `scoreAfter` pair). The only difference is the `triggeredBy` field and how the result feeds back to the caller.

### 8.1 User-initiated enhancement (Job Review Panel)

Operator clicks "Enhance" on a specific image in the Job Review drawer. The renderer calls `ohd:enhancement:run` over IPC with `{ jobId, jobPath, filename, model, options }`. The IPC handler delegates to `enhancementManager.startEnhancement()`. With `enhancementProvider === 'local'`, the manager:

1. Ensures `/originals/` exists for this job (calls `originalsManager.snapshotOnFirstEdit(jobPath)`).
2. Reads the current working file and runs MUSIQ to capture `scoreBefore`.
3. Calls `localClient.startEnhancement()`, which returns a synthetic `local_<timestamp>_<rand>` job ID immediately and runs tiled inference in a background promise.
4. On inference success, writes the enhanced image to `/cache/{baseName}_enhanced.jpg` and copies it over `/working/{filename}`.
5. Runs MUSIQ again on the enhanced output to capture `scoreAfter`.
6. Writes the sidecar with both scores and `triggeredBy: "operator"`.

The renderer polls `ohd:enhancement:status` every 3 seconds (existing behaviour); the local client returns `{ status: 'running', progress: <tiles_done>/<total_tiles> }` during inference, then `{ status: 'rescoring' }` for the brief MUSIQ pass, then `{ status: 'succeeded', scoreBefore, scoreAfter, outputPath }`. The drawer shows "Score: 38 → 67" alongside the enhanced preview.

### 8.2 Quality-gate-triggered fixup (auto-enhance)

When the AI Quality Gate flags an image as below threshold AND `aiQualityMode === 'block'` AND `enhancementAutoEnhance === true`, `ai-job-quality-orchestrator.js` calls `ai-fixup-service.applyFixup(imagePath, { provider: configuredProvider, model: ... })` before deciding whether to hold the job. The provider is whatever `enhancementProvider` is configured (default `'local'`; `'topaz'` if the operator has chosen it). The fixup service:

1. Reads the existing MUSIQ score from the sidecar (already written by the orchestrator's earlier scoring pass) → `scoreBefore`.
2. Calls `localClient.enhance()` (blocking variant — the orchestrator is already async).
3. Replaces the working file via `originalsManager` semantics (originals snapshot guaranteed, working file updated).
4. Re-scores via `aiQualityService.scoreImage()` → `scoreAfter`.
5. Writes a single sidecar entry with both scores, `triggeredBy: "quality-gate"`, and the orchestrator-level decision.

If `scoreAfter` crosses the configured threshold, the job is no longer held and routing proceeds. If not, the original held-state semantics apply — operator opens the held job in the (existing or planned) Quality Review tab and sees the audit trail with both scores.

The fixup service goes direct to `localClient` rather than via `enhancementManager` because the orchestrator already manages job-level state; routing back through the manager would require a second sidecar write and create ambiguity about which write wins. Two paths, same backend, single sidecar entry per enhancement attempt.

---

## 9. Renderer UX changes

Settings → AI Enhancement section is reworked:

- The Replicate API key field is **deleted entirely**. Any related labels, tooltips, and disclosure UI are removed.
- The provider dropdown now contains: `"Pixfizz AI Enhancement"` (value `'local'`, always present) and `"Topaz"` (value `'topaz'`, hidden via JS unless `topazApiKey` is set and validated).
- When `"Pixfizz AI Enhancement"` is selected: shows the new "Advanced — Pixfizz AI Settings" disclosure (collapsed by default), containing tile size and tile overlap fields.
- When `"Topaz"` is selected: shows the existing Topaz API key + model selection fields (unchanged from current behaviour).
- The provider dropdown's tooltip on the Pixfizz option: *"Runs on this computer. No API key needed. Free per image. Slower than Topaz but works out of the box."*
- The provider dropdown's tooltip on the Topaz option: *"Cloud-based premium upscaler. Requires a Topaz API key. Faster and higher quality on hard cases."*
- "Test" button: when `'local'` is selected, runs a dry-run inference on a small bundled fixture to confirm the model loads and produces output. Returns success/failure with timing. When `'topaz'` is selected, validates the API key (existing behaviour).
- One-time post-upgrade toast: *"Replicate has been removed in this release. You're now using Pixfizz AI Enhancement (local). Topaz remains available if your Topaz API key is configured."* — shown once, dismissable, only to upgraded installs that previously had Replicate selected.

Job Review drawer Enhance button: the existing flow works unchanged because the provider abstraction handles it. Three small additions:

- Progress text reflects staged status: `"Enhancing — tile 47/192"` during inference, then `"Rescoring quality…"` during the brief MUSIQ pass. (Topaz path shows similar staged messaging since it now also rescores.)
- On success, the drawer shows the score delta: `"Quality score: 38 → 67"` alongside the enhanced preview, with colour cues (red/amber/green) matching the existing AI Quality Gate threshold semantics.
- **No regression warning.** If `scoreAfter < scoreBefore`, the drawer simply shows the delta as-is (e.g. `"Quality score: 72 → 68"`). No Keep/Revert dialog is forced. Per Decision §0.7, the operator is trusted to notice and use the existing per-image revert button if they want to undo. The data is captured in the sidecar regardless.

---

## 10. Milestone breakdown

### Spike (1 day)

Goal: convert the model, validate parity, capture baseline CPU latency on a real Windows lab machine for the Phase 1.1 (DirectML) decision later.

- Fetch `realesr-general-x4v3.pth` from the upstream v0.2.5.0 release.
- Write `tools/onnx-export/_realesrgan_src/convert.py` and produce `realesr-general-x4v3.onnx`.
- Write `validate-parity.py`. Pass: max abs diff between PyTorch and ONNX outputs ≤ 1/255 across the test fixture.
- Drop the `.onnx` into `resources/models/realesrgan/`, add a temporary one-off harness in the host to load and run it on a single tile, measure inference time per tile.
- Run end-to-end on a 12 MP source image via a temporary CLI: time the full tile-and-stitch loop.
- **Output:** the `.onnx`, the conversion script archived, parity test passing, latency baseline from at least one Windows lab box.
- **No decision required.** v1 ships CPU-only per Decision §0.9; latency numbers feed into Phase 1.1 planning.

### M1: Loader + preprocessor (2–3 days)

- Implement `realesrgan-loader.js` per the MUSIQ pattern.
- Implement `realesrgan-preprocessor.js` with tile and stitch — this is the bulk of the milestone.
- Unit tests for the preprocessor (tile counts, edge tiles, no seams at overlap, output dimensions).
- Register in `ai-inference-host.js`.
- **Validation:** round-trip a known image through the host and get pixel-equivalent output to the Python reference (within float tolerance).

### M2: Local enhancement client + Replicate removal (2–3 days)

- Implement `localClient.js` with the four-function surface.
- Wire into `enhancementManager.js`.
- **Delete `replicateClient.js` and all Replicate-specific code paths in `enhancementManager.js`** (imports, provider branches, validateApiKey logic).
- Add manager-level rescore-after-enhancement hook: read `enhancementRescoreAfter` config, call `aiQualityService.scoreImage()` before-and-after enhancement for any provider, write `scoreBefore` / `scoreAfter` to sidecar.
- Sidecar writes via the existing manager pathway, extended with new fields.
- Integration test: full enhancement of a real lab image via `enhancementManager.startEnhancement()` with `provider: 'local'`. Same test for `provider: 'topaz'` — verify Topaz still works and now writes scoreBefore/scoreAfter.

### M3: Renderer + settings (1–2 days)

- Settings UI rework: remove Replicate fields, add Pixfizz/Topaz dropdown logic, advanced disclosure, post-upgrade toast.
- `config-service.js` migration logic for existing Replicate users.
- Test button: local-provider dry-run path.
- Manual verification: upgrade test from a v1.3.x install with `enhancementProvider: 'replicate'` configured — verify migration runs, toast appears, dropdown shows the right options.
- Manual verification: switch between Pixfizz and Topaz (with valid Topaz key), run an enhancement against each, observe the sidecar shape.
- Manual verification: with no Topaz key, verify Topaz option is hidden and Pixfizz is the only option.

### M4: Quality-gate fixup integration (1–2 days)

- Implement `ai-fixup-service.js` (the originally-deferred service).
- Wire `ai-job-quality-orchestrator.js` to call it when the conditions in §8.2 are met.
- Sidecar pre/post score recording.
- Integration test: deliberately-poor image, auto-enhance ON, local provider, observe held → fixup → no-longer-held flow.

### M5: Polish and ship (1 day)

- Progress reporting per tile through the existing polling loop.
- Error handling: model load failure, inference failure, OOM, file-write failure — all surfaced to the renderer with actionable messages.
- BSD-3-Clause notice in the third-party-licenses screen.
- `THIRD_PARTY_LICENSES.md` extended.
- `ARCHITECTURE.md` updated.
- Release notes draft.

**Total wall-clock estimate:** 8–11 days of focused work. About a week and a half if uninterrupted. (Slightly larger than the original 7–10 estimate due to the Replicate removal and the universal rescore wiring picked up in M2/M3.)

---

## 11. Edge cases and failure modes

- **Source image larger than typical (e.g. a 60 MP DSLR raw exported as JPEG).** Tile count grows quadratically. At 60 MP with 256 × 256 tiles, ~950 tiles. CPU time runs into many minutes. Surface this as a blocking warning in the UI when the operator clicks Enhance: "This image is unusually large. Estimated time: ~6 minutes. Continue?"
- **Source image smaller than tile size (e.g. 200 × 200).** Single tile, no stitching. Edge case worth a unit test.
- **Source image with non-3:4-ish aspect ratio (e.g. extreme panorama 6000 × 800).** Tile grid is rectangular, not square. Algorithm handles this naturally — but verify with a test.
- **Sharp can't read the source.** Fall back to error; do not enhance. This already happens in the existing cloud path.
- **Disk full while writing the 4×-upscaled output.** Same handling as the existing cloud path — surface to operator, no partial-file writes.
- **Operator cancels mid-enhancement.** `cancelEnhancement(jobId)` sets a cancellation flag; the tile loop checks it between tiles and aborts cleanly. Partial output discarded.
- **App quit during enhancement.** The utilityProcess is torn down with the main process. No partial files in the cache (write to a temp file, rename atomically on success).
- **Multiple enhancements queued back-to-back.** First-come first-served. Existing manager-level queue handles this; local client respects it.
- **Sidecar already has an `enhancement` block from a previous attempt.** Overwrite it. The sidecar is single-state-of-truth, not a history log. (Add a separate history field if and when audit-of-attempts is requested.)
- **Model file missing (corrupted install, AV quarantine, etc.).** Loader logs a warning and skips registration. `localClient.enhance()` rejects with `MODEL_NOT_LOADED`. The provider dropdown shows the Pixfizz option as disabled with a tooltip explaining the model file isn't present and pointing to support contact. Per Decision §0.8, no in-app re-download path in v1 — this is deferred to a follow-up if AV-quarantine issues are seen in the field.
- **Existing install upgrades from `enhancementProvider: 'replicate'`.** Migration logic in `config-service.js` rewrites the value to `'local'` at first launch. One-time toast notifies the operator. `replicateApiKey` is silently stripped from config. Sidecar entries from previous Replicate runs are left untouched (they retain `provider: 'replicate'` for audit).
- **Existing install with `provider: 'topaz'` and a valid Topaz key.** No migration runs. Operator continues using Topaz exactly as before. Pixfizz option is also visible in the dropdown if they want to switch.
- **Existing install with `provider: 'topaz'` but missing/invalid key.** Migration runs to `'local'` (since `'topaz'` without a working key would error on first use anyway). Operator can re-enter the key and switch back if they want.

---

## 12. Open questions

All previously-open product decisions are resolved — see §0. No questions block kickoff.

The only remaining open item is the Phase 1.1 follow-up: after v1 ships and the spike's baseline CPU latency is in hand, decide whether DirectML acceleration is needed based on field feedback from operators. That's a separate, smaller plan — not part of this milestone.

---

## 13. Out of scope

Explicitly not in this plan:

- **DirectML / GPU acceleration.** Phase 1 ships CPU-only. DirectML is Phase 1.1, scoped separately after field feedback.
- **In-app model re-download.** If the model file is missing post-install (AV quarantine etc.), users contact support. A re-download affordance is deferred to a follow-up if it proves necessary.
- **Replicate provider.** Removed entirely as part of this work. Will not return.
- **FBCNN for JPEG artefact removal as a separate model.** Real-ESRGAN-general handles JPEG artefacts adequately for the v1 use case. FBCNN can be added in a future milestone using the same pattern if specific failure modes warrant it.
- **GFPGAN / CodeFormer for face enhancement.** GFPGAN's StyleGAN2 dependency carries a non-commercial Nvidia weights licence. Out of scope for any commercial deployment until a licence-clean alternative is identified.
- **2× model variant.** The `realesr-general-x4v3` is 4×-only. For 2× outputs, run 4× and downsample with sharp. A separate 2× model is not warranted.
- **Anime / illustration model variant.** `RealESRGAN_x4plus_anime_6B` exists and is BSD-3-Clause but has training-data provenance concerns. Not a fit for general lab use.
- **Topaz fallback when Pixfizz fails.** If the local provider errors, surface the error — do not silently retry against Topaz. Operator decides.
- **Model auto-update from a server.** Phase 1 ships the model in the installer. A model-update mechanism is a separate feature.
- **Score-regression Keep/Revert dialog.** Per Decision §0.7, score regressions are silently accepted; the score delta is shown but no dialog is forced.

---

## 14. Verification & testing

- Unit tests: `realesrgan-preprocessor.test.js` covering tile and stitch.
- Integration test: full enhancement run via `enhancementManager` with `provider: 'local'`, asserting sidecar shape and output file existence and dimensions.
- Migration test: simulate a v1.3.x install with `enhancementProvider: 'replicate'` and a non-empty `replicateApiKey`. After upgrade and first launch, verify config has `enhancementProvider: 'local'`, `replicateApiKey` is gone, the migration toast appears once, and a subsequent launch does not re-show the toast.
- Topaz-retention test: simulate a v1.3.x install with `enhancementProvider: 'topaz'` and a valid Topaz key. Verify post-upgrade behaviour is unchanged (still on Topaz, no migration toast, dropdown shows both options).
- Topaz-rescore test: with `enhancementProvider: 'topaz'`, run an enhancement; verify the sidecar gets `scoreBefore` / `scoreAfter` populated (per Decision §0.6).
- Parity test: the upstream `.pth` and the bundled `.onnx` produce visually identical output on the test fixture (max abs diff ≤ 1/255).
- Performance test: latency on the reference Windows lab box for representative print sizes (5 × 7, 8 × 10, 16 × 24).
- Manual test sequence: poor-quality 4 MP customer photo → operator clicks Enhance → progress reports — succeeded → drawer shows "Score: X → Y" → output replaces preview → revert returns working file to original.
- Quality-gate auto-enhance test: deliberately-poor image, `aiQualityMode: 'block'`, `enhancementAutoEnhance: true`, `enhancementProvider: 'local'` — verify auto-fixup runs, sidecar gets `scoreBefore` / `scoreAfter` / `triggeredBy: "quality-gate"`, job is no longer held if `scoreAfter` crosses threshold.
- Rescore consistency test: trigger enhancement via both the user-initiated and quality-gate paths on the same image at different times; verify both sidecar entries have the same shape (modulo `triggeredBy`).
- Originals-preservation test: enhance an image, verify `/originals/{filename}` exists and is byte-identical to the pre-enhancement working file. Then run revert, verify working file is restored byte-for-byte.
- Score-regression test: feed a high-quality image (already scoring 80+) through the enhancer and verify the system silently accepts the result (per Decision §0.7), shows the score delta in the drawer, writes both scores to the sidecar, and does *not* surface a Keep/Revert dialog. The existing per-image revert button continues to work.

---

## 15. Licensing and attribution

Real-ESRGAN is published under BSD-3-Clause, copyright Xintao Wang 2021. The `realesr-general-x4v3` weights ship as part of release `xinntao/Real-ESRGAN@v0.2.5.0` and inherit the same licence.

Compliance obligations (all small):

1. Retain the BSD-3-Clause licence text and copyright notice in distribution. Bundle as `resources/models/realesrgan/LICENSE`. Surface in the third-party-licenses screen.
2. Do not use the upstream author's name to endorse OHD. Calling the technology "Real-ESRGAN" (the project name) is fine; "Xintao Wang's super-resolution" is not.
3. Standard warranty disclaimer (no action required).

The `.onnx` we ship is a derivative work of the upstream `.pth` weights. Because we converted from the original BSD-licensed weights ourselves (per the `tools/onnx-export/_realesrgan_src/convert.py` script), the licence chain is direct — no third-party uploader to attribute.

`docs/local-enhancement/licensing-audit.md` traces this from upstream LICENSE file → bundled file → third-party-licenses screen, and is the document a future legal review should consult.

---

## 16. Activity Log integration

Every enhancement run appends an Activity Log entry (using the existing format established in PW-007 and the AI Quality Gate). Schema:

- `kind: 'enhancement'`
- `provider: 'local' | 'topaz'`
- `model: 'realesr-general-x4v3' | <topaz model name>`
- `imagePath`
- `tileCount` (local only)
- `inferenceMs`
- `executionProvider`
- `outcome: 'succeeded' | 'failed' | 'cancelled'`
- `error?`

Same format as cloud-provider enhancements; the only difference is the new fields populated for the local case.
