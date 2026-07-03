# Perfectly Clear QuickServer Integration — Implementation Plan (M1–M6)

**Date:** 2026-07-02 · **Feasibility:** `docs/perfectly-clear-quickserver-feasibility.md` (read it first — all design decisions are recorded there).
**Execution:** Claude Code CLI, one milestone per branch/commit sequence. If files carry unrelated WIP, use the foundation-snapshot pattern (snapshot commit first, surgical commit on top).

## Decisions recap (locked)

Three scopes — **Jobs**, **Film Scans**, **File Uploads** — each with 1+ named hot-folder configs (`friendlyName` + input/output/**rejected** folders, matching a QuickServer *channel*). Auto-apply per scope for Film Scans and File Uploads; **Jobs is manual-only** from Job Review (one / many / Select All). Film scans auto-enhance **before** Film Review; Film Review also gets a manual per-frame enhance. Per-image **Revert to original** for Jobs and Film Scans. Old Pixfizz/Topaz UI **hidden, code kept dormant**; MUSIQ scoring untouched. QuickServer may be on the same or a different PC — hot folders reachable from the OHD PC; design SMB-safe everywhere. QuickServer supports TIFF.

## QuickServer contract (what the client is built against)

- A channel watches its **Input** folder; subfolder structure and filenames are **mirrored** to **Output**. Non-processable files (corrupt, empty-with-.jpg-extension, non-image) land in **Rejected**. Non-image "skipped" files (e.g. `.txt`) pass through to Output — tolerate, never send.
- Input folders are unique per channel; Output/Rejected must not be under Input. Enforce the same rules at settings save.
- No documented done-signal → per-file **stability polling** (mtime+size unchanged across 2 consecutive polls) before consuming, and per-file accounting: batch complete when every input file has appeared in Output or Rejected. Wall-clock timeout for files that appear in neither.
- Copy **into** Input via temp name + rename (QuickServer must never see a half-copied file).

---

## M1 — Config model + Settings UI

**Goal:** `perfectlyClear` config block persisted, validated, editable on the AI Enhancement settings tab; old provider UI hidden.

### Files

- `src/main/services/config-service.js` — schema, get/update, validation
- `src/renderer/index.html` — AI Enhancement subtab (`subtab-aienhancement`, lines ~787–879)
- `src/renderer/renderer.js` — settings load (~line 2104) / save (~line 2200) wiring
- `src/main/services/backup-service.js` — confirm new key rides along (non-sensitive)
- Tests: `src/main/services/__tests__/config-service-perfectly-clear.test.js`

### Work

1. **Schema.** Single structured key (do NOT add flat keys — follow the `printControllers` store style but electron-store under config-service is fine):

```json
"perfectlyClear": {
  "jobs":        { "enabled": false, "autoApplyConfigId": null, "configs": [] },
  "filmScans":   { "enabled": false, "autoApplyConfigId": null, "configs": [] },
  "fileUploads": { "enabled": false, "autoApplyConfigId": null, "configs": [] }
}
```

Config entry: `{ id: uuid, friendlyName, inputFolder, outputFolder, rejectedFolder }`.
Note: Jobs has no auto-apply by decision — keep the field for shape symmetry but never surface it in the Jobs UI (harmless, avoids special-casing).

2. **Validation at save** (config-service `update`): when a scope is `enabled`, it needs ≥1 config; every config needs all three folders; `inputFolder` unique across **all** scopes' configs; `outputFolder`/`rejectedFolder` must not be path-prefixed by any `inputFolder`; folders must exist (fs.existsSync — they're often on SMB, so existence only, no write probe at save).

3. **Settings UI.** On the existing AI Enhancement subtab:
   - Hide the Pixfizz/Topaz sections (`display:none` via a wrapper div — do not delete DOM or handlers; `enhancementProvider` remains in config for fallback).
   - Add three sections (Jobs / Film Scans / File Uploads): enable checkbox; config list (friendly name + three folder paths, Browse buttons reusing the existing folder-picker IPC used by Film Scans watch folder); Add/Edit/Remove; for Film Scans and File Uploads an "Apply automatically" `<select>` of that scope's configs (+ "Off").
   - Per-config **Test** button: IPC `ohd:pc:testConfig` → checks all three folders exist and input is writable (write+delete a probe file `ohd_probe_{ts}.txt` — QuickServer passes .txt through as "skipped", it won't be processed; delete the output copy if it shows up, best-effort).

4. **IPC.** `ohd:pc:getConfig` (or ride the existing `getConfig`), `ohd:pc:testConfig`. Register in `src/main/ipc-handlers.js`, expose in `src/preload/preload.js` (`electronAPI.pcTestConfig` etc. — follow the `enhancementRun` naming at preload.js:187).

**Acceptance:** settings round-trip survives restart; invalid configs rejected with clear messages; Pixfizz/Topaz invisible but functional if `enhancementProvider` is set by hand; jest tests for validation rules pass.

---

## M2 — Shared hot-folder client

**Goal:** one battle-tested module that all three scopes call.

### Files

- `src/main/enhancement/perfectlyClearClient.js` (new)
- Tests: `src/main/enhancement/__tests__/perfectlyClearClient.test.js`

### API

```js
processBatch({
  config,            // { inputFolder, outputFolder, rejectedFolder, friendlyName }
  files,             // [{ sourcePath, destPath }]  — destPath = where the enhanced result must land
  timeoutMs,         // wall-clock for the whole batch (caller supplies per-scope default)
  onFileDone,        // optional ({ sourcePath, status, error? }) per-file progress callback
  signal             // optional AbortSignal for cancellation
}) => Promise<[{ sourcePath, destPath, status: 'enhanced'|'rejected'|'timeout'|'cancelled', error? }]>
```

### Behaviour

1. Batch subfolder: `ohd_{machineId}_{ts}_{rand}` (machineId from the existing hostname+machineId used by backup-service isolation — multi-PC-safe on shared channels).
2. Copy each source into `input/{batch}/` as `{name}.tmp_{pid}` then `fs.rename` into final name.
3. Poll `output/{batch}/` and `rejected/{batch}/` every ~1.5 s (`fs.readdir` polling only — no chokidar native events; SMB target). A file counts as arrived when stable across 2 consecutive polls (size+mtime).
4. Arrived in output → copy to `destPath` (again temp+rename), mark `enhanced`. Arrived in rejected → mark `rejected` (leave `destPath` untouched). Batch resolves when all files accounted for or timeout fires; unaccounted files → `timeout`.
5. Cleanup: best-effort `rm -rf` of the batch subfolders under input/output/rejected. Never throw from cleanup.
6. Log via `logger` with a `pc:` prefix; Activity Log entries for batch start/finish/failures.

### Tests

Simulate QuickServer with temp dirs and a fake mover (test moves files input→output or input→rejected after a delay; one test never moves a file to exercise timeout; one aborts mid-batch). No real QuickServer needed for CI.

**Acceptance:** unit tests cover success / reject / timeout / cancel / partial-batch mixes; concurrent `processBatch` calls don't collide.

---

## M3 — Jobs (Job Review)

**Goal:** Perfectly Clear replaces the enhancement UX in Job Review; print dispatch unchanged.

### Files

- `src/main/enhancement/enhancementManager.js` — new provider branch
- `src/main/ipc-handlers.js` (~line 2243 area) + `src/preload/preload.js` — batch IPC
- `src/renderer/views/JobReview/ControlPanel.jsx` — replace `EnhancementPanel` (lines 119–370)
- `src/renderer/views/JobReview/ThumbnailCard.jsx`, `ThumbnailGrid.jsx`, `useJobReview.js` — multi-select
- Tests: extend `src/main/enhancement/__tests__/enhancementManager.test.js`

### Work

1. **Provider.** `getProvider()` returns `'perfectly-clear'` when `perfectlyClear.jobs.enabled` and ≥1 config (overrides `enhancementProvider` while enabled — hidden legacy providers stay reachable by disabling PC). Reuse the existing contract exactly: copy `/working/{file}` → `/cache/{basename}_enhanced.jpg`, hand the cache file to `perfectlyClearClient` (`sourcePath` = `destPath` = cache path is fine — client stages its own input copy), then cache → `/working/`, sidecar `enhanced:true, enhancedPath, enhancementSource:'perfectly-clear', enhancementModel:<friendlyName>`. MUSIQ before/after rescoring runs unchanged. **Result: `print-service._getEnhancedPathMap` needs zero changes.**
2. **Pre-enhance backup for revert.** Before cache→working copy-back, save the current working file to `/cache/{basename}_pre_pc.jpg` (only if not already present — first enhancement wins). Sidecar: `preEnhancePath`.
3. **Batch IPC.** `ohd:enhancement:batchRun` `{jobId, jobPath, filenames[], configId}` → `{batchId}`; `ohd:enhancement:batchStatus` `{batchId}` → per-file states + counts; `ohd:enhancement:batchCancel`. Internally one `processBatch` call; each completed file goes through step 1's copy-back+sidecar individually so partial batches still land.
4. **Revert IPC.** `ohd:enhancement:revert` `{jobId, jobPath, filename}` → restore `/working/{basename}` from `preEnhancePath`, delete `enhanced/enhancedPath/enhancementSource/enhancementModel/preEnhancePath` sidecar fields (leave crop fields alone — crop still wins at dispatch and is orthogonal). Refresh thumbnail.
5. **UI.** New `EnhancementPanel`: config `<select>` (hidden when exactly 1 config; default = last used, persist in `film-review-prefs-store`-style prefs or localStorage), **Enhance This Image**, **Enhance Selected (n)** and **Select All** wired to a new multi-select mode in the thumbnail rail (checkbox overlay per card — model on the reprint "Flag all" pattern in ControlPanel.jsx ~109–115, but as a separate selection set in `useJobReview`), per-image progress states (queued/processing/done/rejected), **Revert** button when `selected.enhanced && selected.enhancementSource === 'perfectly-clear'`. The "AI" badge on `ThumbnailCard` keeps working via `enhanced:true`.
6. **Not-configured state:** panel shows "Configure Perfectly Clear in Settings" + button (mirror the Topaz `not-ready` phase pattern, ControlPanel.jsx ~243–271).

**Gotchas:** the Job Review topbar is a grid, not flex — don't restructure it for new buttons. Any new drawer/overlay near the top ~30px needs `-webkit-app-region: no-drag`.

**Acceptance:** enhance one → dispatch uses enhanced file (verify via `Using enhanced image` log line); Select All on a 36-image job completes with mixed results handled; revert restores byte-identical pre-enhance working file; reprints still dispatch from `/originals/` untouched; legacy provider still works when PC disabled.

---

## M4 — Film Scans

**Goal:** auto-apply per roll before Film Review; manual per-frame enhance + revert in Film Review.

### Files

- `src/main/services/folder-watch-service.js` — pipeline insertion (after rotation+thumbnail loop, ~lines 284–530, before the review-gate/upload decision ~line 555)
- Frame metadata store (`frameMetadataStore`) — new per-frame fields
- `src/main/ipc-handlers.js` + `preload.js` — `ohd:filmscan:enhanceFrame`, `ohd:filmscan:revertFrame`, `ohd:filmscan:enhanceStatus`
- `src/renderer/views/FilmReview/FocusedFrame.jsx`, `RollReview.jsx`, `FrameCell.jsx` — per-frame action + badges
- Tests: folder-watch integration test with a mocked client

### Work

1. **Auto-apply.** When `perfectlyClear.filmScans.enabled && autoApplyConfigId`: after rotation/thumbnails, set roll state `enhancing` (new state — make sure Film Review roll list and pipeline telemetry render it, and that the 'uploading' button-mode gotcha pattern is respected), then `processBatch` the roll's storage files in one call (`sourcePath` = storage file, `destPath` = same path — but stage per-frame pre-enhance copies first, see 3). Timeout: `max(5 min, 30 s × frameCount)` wall-clock; on batch timeout log + escalate the roll into review (reuse the Smart Check trigger path) and continue with whatever enhanced frames landed.
2. **Per-frame results.** Success → storage file replaced, regenerate that frame's thumbnail (reuse the rotation step's thumbnail call), stamp metadata `{ pcEnhanced: true, pcConfigName, pcEnhancedAt }`. Rejected/timeout → keep original, stamp `{ pcEnhanced: false, pcRejected: true }`; roll summary gains `pcRejectedCount` (surface like `lowConfidenceCount` does for Smart Check).
3. **Revert copies.** Before overwriting a storage file, copy it to `{rollFolder}/pre-enhance/{filename}` (once). Retention cleanup (`filmScansRetentionDays`) must sweep `pre-enhance/` with the roll.
4. **Manual per-frame.** Film Review focused frame gets **Enhance** (config dropdown if >1; works regardless of auto-apply) and **Revert** (visible when `pcEnhanced`). One-file `processBatch`; frame + thumbnail refresh on completion; frame shows a spinner state meanwhile. TIF in/TIF out is supported by QuickServer — dest keeps the source extension.
5. **Ordering guard.** Auto-apply must complete (or time out) before the review gate evaluates and before `_uploadRollFromStorage` (~line 865) can run; rolls in `enhancing` are excluded from upload sweeps.

**Acceptance:** roll with auto-apply lands in Film Review with enhanced frames + badges; rejected frame shows original with a flag; revert restores the pre-enhance file; QuickServer offline → roll escalates to review unenhanced after timeout, pipeline never wedges; retention removes `pre-enhance/`.

---

## M5 — File Uploads

**Goal:** optional auto-enhance between detection and S3 upload.

### Files

- `src/main/services/folder-watch-service.js` — file-uploads branch
- Test: mocked-client round-trip

### Work

After the stability check and copy-to-storage, before S3 upload: if `perfectlyClear.fileUploads.enabled && autoApplyConfigId`, round-trip the file (`destPath` = storage path; no revert copies here — no review surface, decision is upload-what-QuickServer-returns). Rejected/timeout → upload the original and log a warning to the Activity Log. No UI beyond settings.

**Acceptance:** enhanced file is what reaches S3; rejects/timeouts upload originals and are visible in the Activity Log; disabled scope is a strict no-op.

---

## M6 — End-to-end + polish

1. **Real QuickServer matrix:** same-PC local folders; QuickServer on another PC via SMB share; two configs on one scope; concurrent Jobs batch + Film Scans roll on different channels; QuickServer stopped mid-batch (timeout paths); junk `.txt` dropped into output (tolerated).
2. **Activity Log:** batch start/finish, per-file rejects, timeouts — operator-readable.
3. **Docs:** update `docs/` with an operator setup guide (creating a QuickServer channel, pointing OHD configs at its folders, the folder-uniqueness rules).
4. **Version + release notes.** Remember: releases ship unsigned (SmartScreen warning is expected), and **never redirect build output into the repo during `npm run build`** (asar two-pass corruption — v1.7.0 incident).

## Suggested sequencing / estimates

M1 2–3 d → M2 2–3 d → M3 3–4 d → M4 2–3 d → M5 1 d → M6 2 d. M2 can start in parallel with M1's UI half. Ship after M3 if desired (Jobs-only release), M4/M5 additive.
