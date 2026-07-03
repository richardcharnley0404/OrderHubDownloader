# Perfectly Clear QuickServer Hot-Folder Integration — Feasibility

**Date:** 2026-07-02 · **Status:** Feasible — all design questions answered; ready for an implementation plan.

## Verdict

Feasible with moderate effort (~2 weeks). All three integration points (Jobs, Film Scans, File Uploads) have clean insertion seams, and the existing AI Enhancement architecture is modular enough that Perfectly Clear can slot in as a new "provider" for Jobs with almost no changes to sidecar tracking or print dispatch. The riskiest part is not OHD code — it's the correlation/completion contract with QuickServer's output folder (how we know a processed file is *done* and *ours*).

## What exists today

**AI Enhancement (Jobs).** `enhancementManager.js` orchestrates two providers (local Real-ESRGAN in `localClient.js`, Topaz cloud in `topazClient.js`). The file contract is clean and provider-agnostic:

1. Copy `/working/{file}` → `/cache/{basename}_enhanced.jpg`
2. Provider enhances the cache file **in place**
3. Copy cache → `/working/` and stamp the sidecar (`enhanced: true`, `enhancedPath`, `enhancementSource`, `enhancementModel`)
4. Every print route (`print-service.js` `_getEnhancedPathMap`, line ~2492) transparently substitutes the enhanced file at dispatch. Crop still wins over enhance. Reprints deliberately ignore enhancement (dispatch from `/originals/`).

The Job Review panel (`ControlPanel.jsx` `EnhancementPanel`, line 119–370) is **single-image only** — there is no multi-select today. "Flag all" exists only for reprints. Settings live in `index.html` (lines 787–879) + `config-service.js` (flat keys: `enhancementProvider`, `topazApiKey`, `enhancementAutoEnhance`, etc.).

**Film Scans.** `folder-watch-service.js`: detect roll → copy to storage → AI rotation + thumbnails → review gate (`filmScanReviewMode`: auto/smart/manual) → `_uploadRollFromStorage` → S3. Config is flat keys (`filmScansWatchFolder`, `filmScansStorageFolder`, …). Images sit in the storage folder between detection and upload — a natural place to insert an enhancement pass.

**File Uploads.** Same pattern, simpler: watch folder → storage → S3 upload. No metadata/review layer. Keys: `fileUploadsWatchFolder`, `fileUploadsStorageFolder`, etc.

**Folder watching.** Film Scans / File Uploads use plain polling (`fs.readdir` per timer tick) with stability checks; Order XML uses chokidar with 2 s polling for SMB. Either pattern is reusable for watching the QuickServer *output* folder. No existing mention of Perfectly Clear/QuickServer beyond a Phase-3 stub comment in `imageProcessor.js`.

## Proposed design

### Shared config model

One new structured config block (single JSON key in electron-store, mirroring how `printControllers` are stored, rather than dozens of flat keys):

```json
{
  "perfectlyClear": {
    "jobs":        { "enabled": true,  "autoApplyConfigId": null,   "configs": [ ... ] },
    "filmScans":   { "enabled": true,  "autoApplyConfigId": "cfg1", "configs": [ ... ] },
    "fileUploads": { "enabled": false, "autoApplyConfigId": null,   "configs": [ ... ] }
  }
}
```

Each config: `{ id, friendlyName, inputFolder, outputFolder, rejectedFolder }` — matching a QuickServer **channel**, which has exactly these three folders (plus an optional Originals backup folder QuickServer manages itself). E.g. "Phone Enhancement", "Sports Enhancement". One or more per scope. `autoApplyConfigId` implements "run all film scans through X automatically". Non-sensitive, so it flows into Backup & Restore for free.

Save-time validation should mirror QuickServer's own channel rules: input folders must be unique across all configs (QuickServer forbids two channels watching the same input), and output/rejected folders must not sit under the input folder.

### Shared hot-folder client (`src/main/enhancement/perfectlyClearClient.js`)

One service used by all three scopes:

1. Copy the batch (one image or many) into a **unique subfolder** under `{inputFolder}` (e.g. `input/ohd_{jobId}_{ts}/…`). QuickServer mirrors the subfolder structure to output, so results appear under `output/ohd_{jobId}_{ts}/…` — collision-free correlation across concurrent requests.
2. Watch **both** `{outputFolder}` and `{rejectedFolder}` for the mirrored subfolder. Per-file accounting: each input file must turn up in output (success) or rejected (failure — corrupt image, empty file, unsupported type). Batch is complete when `output + rejected == input count`. Apply a file-stability check (size unchanged across N polls) before consuming each file — same guard the film scan watcher already uses. Note QuickServer also passes non-image "skipped" files (e.g. `.txt`) through to output; we won't send any, but the consumer should tolerate them.
3. Copy results back to the caller's destinations; report rejected files as per-image errors (original left untouched). Clean up the input/output/rejected subfolders. Wall-clock timeout for files that never appear in either folder (QuickServer down or channel disabled) → fail those files, leave originals.

We do not use QuickServer's "save originals" backup option — OHD keeps its own originals (`/originals/` for jobs) and the input copy is already a duplicate.

### Scope 1 — Jobs (Job Review)

Register Perfectly Clear as a provider inside `enhancementManager` and reuse the existing cache→working→sidecar contract unchanged. Print dispatch then needs **zero changes**. Sidecar gets `enhancementSource: 'perfectly-clear'` and `enhancementModel: <friendlyName>`.

UI: replace the AI ENHANCEMENT panel with "Enhance via Perfectly Clear": config dropdown (when >1 config), **Enhance This Image**, plus multi-select / **Select All** → batch enhance with per-image progress. Multi-select is new UI work (biggest renderer task in this project) — the reprint "Flag all" pattern is a starting point. Batch = queue through the client sequentially or in small parallel batches; QuickServer does the heavy lifting so OHD just shuttles files.

### Scope 2 — Film Scans

Two triggers (decided 2026-07-02):

- **Auto-apply:** insert in `folder-watch-service.js` after rotation/thumbnails and **before** the review gate — the operator reviews the *enhanced* frames. Batch per roll: copy the whole roll folder into the input hot folder in one go; mirrored-structure behaviour handles correlation. A rejected frame falls back to its unenhanced original (flagged in roll metadata) rather than holding the roll.
- **Manual per-frame:** when auto-apply is off (or on top of it), the lab can select a single frame in **Film Review** and enhance just that one — a small "Enhance via Perfectly Clear" action on the focused frame, with config picker when >1 config. This is a new Film Review UI element and re-uses the same client with a one-file batch; the frame's storage file and thumbnail are refreshed on completion.

Add a roll state (e.g. `enhancing`) so the Film Review UI and pipeline status don't misreport, and a timeout escalation so a dead QuickServer can't pin a roll forever (same failure class as the upload-hang bug fixed in June — build the wall-clock backstop in from day one).

### Scope 3 — File Uploads

Simplest: after stability check, before S3 upload, round-trip the file if auto-apply is set. No review UI in this pipeline, so auto-apply is the only trigger (manual selection has no surface here).

### Settings UI

All three on the existing AI Enhancement settings tab, as you suggested: three sections (Jobs / Film Scans / File Uploads), each with an enable toggle, a config list (add/edit/remove friendly-named input+output folder pairs), and an "apply automatically" selector. Existing Pixfizz/Topaz controls: recommend **hide, don't delete** initially — keep the code path so we can fall back, and keep MUSIQ quality scoring (separate subsystem, `ai-quality-service.js`) untouched either way.

## Risks

- **Completion detection.** Resolved in principle — per-file accounting across output + rejected folders, with stability polling per file and a wall-clock timeout for files that never arrive in either. Remaining unknown: whether QuickServer writes output atomically (temp-then-rename) or in place; stability polling covers both, but atomic writes would let us shorten the poll.
- **Failure semantics.** Resolved — rejects land in the channel's Rejected folder (corrupt images, empty files, non-processable types). Per scope: job image → per-image error, original untouched; film frame → upload unenhanced original + flag; file upload → upload unenhanced original + log.
- **Formats.** Film scan pipeline handles TIFFs; confirm QuickServer channel presets accept TIF in and what they emit (TIF out? or is JPEG-out acceptable/preferred pre-upload?). Also note QuickServer's "empty file with .jpg extension" reject case — our stability check must not ship a half-copied file into the input folder (copy via temp name + rename into place).
- **Network shares.** If hot folders live on SMB, use polling watchers (already the house pattern) and expect latency; also the known sharp/libvips SMB quirks don't apply here since we're only copying.
- **Throughput/licensing.** Confirm QuickServer's concurrency and whether one instance serves all three scopes plus multiple OHD PCs (relevant to the multi-PC deployments where polling is disabled).

## Effort estimate

Config model + settings UI ~2–3 d · shared hot-folder client + tests ~2–3 d · Job Review provider swap + multi-select UI ~3–4 d · film scan insertion + state/timeout handling ~2 d · file uploads insertion ~1 d · end-to-end testing against a real QuickServer ~2 d. **Roughly two working weeks**, sequenceable (Jobs first, then Film Scans, then File Uploads).

## Answered (2026-07-02)

- **Folder contract:** a QuickServer channel = Input + Output + Rejected folders; subfolder structure and filenames mirror from input to output; failures land in Rejected. OHD writes a uniquely-named subfolder per batch and does per-file accounting across output + rejected.
- **Failure behaviour:** rejects appear in the Rejected folder — per-image error handling as described under Risks.
- **Film scan insertion point:** enhance **before** Film Review when auto-apply is on; additionally, manual per-frame enhancement from Film Review when the lab wants to enhance only a selected image.

## Decisions (2026-07-02, second round)

1. **Formats:** QuickServer supports TIFF — film scan pipeline can round-trip TIFs.
2. **Jobs auto-apply:** manual-only. Operator enhances one/many/all from Job Review; auto-apply is reserved for Film Scans and File Uploads.
3. **Old AI Enhancement:** hide the Pixfizz/Topaz UI, keep the code dormant as fallback. MUSIQ scoring untouched.
4. **Revert:** per-image "Revert to original" for both Jobs and Film Scans. Jobs are cheap (`/originals/` already kept); Film Scans keep a pre-enhancement copy per frame (small disk cost per roll, honours retention cleanup).
5. **Topology:** QuickServer runs on a lab PC — sometimes the OHD PC, sometimes another; hot folders just need to be reachable from the OHD PC. Design for the general case: SMB-safe polling watchers, temp-name+rename copies, and a machine-id component in batch subfolder names (cheap insurance for multi-PC sites).
6. **Default config (minor, defaulted):** `autoApplyConfigId` is a single choice per scope; Job Review / Film Review action dropdowns default to the most recently used config (falling back to the first).
7. **Output atomicity (absorbed):** unknown whether QuickServer writes temp-then-rename; per-file stability polling handles either.

## Next step

Turn this into a milestone-by-milestone implementation plan: M1 config model + settings UI, M2 shared hot-folder client + tests, M3 Jobs (provider swap + multi-select), M4 Film Scans (auto-apply + Film Review per-frame action + revert copies), M5 File Uploads, M6 end-to-end test against a real QuickServer channel.
