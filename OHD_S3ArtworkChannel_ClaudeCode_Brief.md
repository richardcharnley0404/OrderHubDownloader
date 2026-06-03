# OHD S3 Artwork Channel — Claude Code Brief

**Status:** Ready for implementation. OrderHub backend changes have shipped and been verified against a live test order.

**Owner of this brief:** Richard Charnley (richard_charnley@pixfizz.com)

**Date:** 2026-05-24

---

## Goal

Add S3-hosted artwork delivery as a second ingestion channel for jobs that arrive via `/ohd-api/pending-jobs`, sitting alongside the existing Pixfizz FTP pull. Jobs whose artwork was uploaded manually via the OrderHub web UI must be held from auto-print so the operator can crop and proof before dispatch. Jobs whose artwork came from the trusted Pixfizz pipeline continue to auto-print as today.

Both channels are **permanent and parallel** — FTP is NOT being retired. The two can co-exist on the same job (operator-added replacement file on a Pixfizz job).

This brief covers four milestones (M1–M4). M5 (stale-skip for `artwork_source: 'none'`) was previously planned but has been **deleted** — OrderHub now filters those jobs out server-side, so OHD never sees them.

---

## Locked-in contract from OrderHub

These are confirmed by the OrderHub team and will not change for this work:

1. **`/ohd-api/pending-jobs` response** now includes per-job:
   - `artwork_source`: `"pixfizz"` | `"manual"` | `"none"` (the last is now filtered out server-side and OHD should never see it in practice — assert if it appears)
   - `artwork_ready_at`: ISO timestamp (MIN of file `created_at`; does NOT bump on re-upload)
   - `artwork_files[]`: array of file descriptors
   - `quantity`: job-level set multiplier

2. **`artwork_files[]` shape** per element:
   - `id`: UUID — the **dedup key within a job**. Two files in one job can share the same `file_name`
   - `file_name`: original upload filename (server-validated extension; no further client validation needed)
   - `file_url`: stable persisted public URL. **NOT a short-TTL signed URL** — no expiry-refresh dance. Treat the URL as sensitive (grants read until rotated); log by `id` not URL
   - `artwork_type`: `"original"` | `"optimized"` | `"manipulated"` (possibly others; treat unknowns as `manipulated`)
   - `production_ready`: boolean — false = "uploaded but not finalised", soft hold
   - `copies`: integer per-file copies (defaults to 1)
   - `source`: `"pixfizz"` | `"manual"` — per-file origin; usually equals job-level `artwork_source` but can differ in mixed jobs

3. **Print dispatch precedence** for `artwork_type`: `optimized` > `manipulated` > `original`. The `original` slot is conceptually identical to Pixfizz's existing `originalFilename` (Customer Originals Phase 1+2) and should feed into that subsystem, not a new one.

4. **Quantity math:** total prints for a file = `job.quantity * artwork_files[i].copies`. Sidecar should store `qtyOriginal = job.quantity * file.copies` on first import; `qtyCurrent` stays operator-mutable.

5. **Mutation detection:** uploads create new rows, never mutate existing ones. So caching the set of `artwork_files[].id` per job and diffing against the next poll is the canonical "what's new" check. A future per-file `updated_at` is not on the OrderHub roadmap.

6. **Hold-from-auto-print is job-level, not file-level**, but the decision rule is a logical OR across three conditions (see §"Behaviour rules" below).

7. **`X-Organization-ID` header** is already wired up in `job-service.js:217`. It's optional server-side and derivable from the API key — leave the existing logic alone.

8. **OHD continues to call `markReceived` (`POST /jobs/{jobId}/received`)** the moment files are present on disk, even for held-for-review manual jobs. The hold only blocks the auto-print dispatcher, not the receive ack. Print transition (`markInProduction`) happens when the operator dispatches.

---

## Architecture

### New service

`src/main/services/s3-artwork-downloader.js` — sibling of the existing `s3-service.js` (which stays upload-only). Public surface:

```
async downloadJobArtwork(job, downloadDirectory) → {
  downloaded: [{ id, fileName, diskName, artworkType, source, productionReady }],
  skipped:    [{ id, fileName, reason }],   // e.g. already on disk
  failed:     [{ id, fileName, error }]
}
```

Internally:
- Enumerates `job.artwork_files[]`
- For each file, computes the target disk name (see §"Disk layout" below)
- Skips files whose target name already exists on disk (idempotent — handles re-poll of a half-downloaded job)
- Downloads with bounded concurrency (4 parallel max) via `https.get` to match the existing project style (see `presign-service.js`, `s3-service.js`)
- Streams to a `.tmp` file, fsyncs, renames to final name (so partial downloads never get picked up by `checkLocalFiles`)
- Logs by `id`, never logs the full `file_url`

### Polling integration point

`src/main/services/polling-service.js`, inside `pollJobs()` between the existing `jobService.fetchJobs()` call and the `pendingJobs.filter(...)` loop (around line 194):

```
const jobs = await jobService.fetchJobs();
// existing syncJobStatusFromOH call stays here

const pendingJobs = jobService.getLocalJobs().jobs.filter(j => j._status === 'pending');

// NEW: download S3 artwork for any job whose artwork_files[] is non-empty
//      AND whose target files aren't already on disk. Idempotent.
for (const job of pendingJobs) {
  if (Array.isArray(job.artwork_files) && job.artwork_files.length > 0) {
    try {
      await s3ArtworkDownloader.downloadJobArtwork(job, configService.get('downloadDirectory'));
    } catch (err) {
      logger.logError('[s3-artwork] download failed', err, { jobId: job.id });
      // Do NOT bail the poll; continue with checkLocalFiles which will still
      // detect any partial success.
    }
  }
}

// existing checkLocalFiles loop continues unchanged
```

The FTP path runs in parallel (`scanFtp()` is called from `runAllModes()` independently). Pixfizz jobs that arrive via FTP will land on disk through that route; S3-source manual jobs will land through the new route. Both end up in the same job folder, and `checkLocalFiles` is agnostic to which channel populated it.

### Hold gate on auto-print

`polling-service.js`, where `onAutoPrint` is invoked (line 244):

```
if (this.onAutoPrint) {
  this.onAutoPrint().catch(err => logger.logError('[auto-print] callback error', err));
}
```

`onAutoPrint` is wired in `src/main/index.js` (search for `setAutoPrintCallback`). Inside that callback (or in `print-service.js` wherever it dispatches the print), check the per-job hold flag before dispatching. See §"Behaviour rules" for the exact rule.

---

## On-disk layout

The target layout matches today's FTP-produced layout byte-for-byte. Existing pipelines (`sidecarManager`, `working/`, `recrops/`, `sendReprint`, AI scoring) work unchanged.

```
{downloadDirectory}/
  {order_number}_{order_id}/
    {order_number}_{job_id}/
      <file_name>.jpg                ← S3 download lands flat here (same as FTP)
      <file_name>__a1b2c3d4.jpg      ← collision-resolved name (see below)
      {jobId}.json                   ← sidecar; gains new fields, see below
      working/                       ← existing — populated by Job Review / re-crop
      recrops/                       ← existing — Customer Originals Phase 2 audit trail
      original-files/                ← existing — populated for artwork_type='original' (see M4)
```

### Filename rules

The disk name for an `artwork_files[]` entry is computed as follows:

1. **Default:** `file_name` from the API verbatim
2. **Collision-resolution:** if a different `id` already maps to the same disk name within this job folder, fall back to `${stem}__${id.slice(0,8)}.${ext}` where `stem`/`ext` are derived from `file_name` (e.g. `IMG_0123__a1b2c3d4.jpg`)
3. **Idempotency:** if the SAME `id` already exists on disk at its computed name, skip the download
4. The chosen disk name must be persisted to the sidecar so the renderer can present the original `file_name` separately

Reserved-character handling: trust the OrderHub-side validation; do not sanitise. If a filename causes a Windows write error, log + skip — do not silently mangle.

---

## Sidecar additions

The sidecar (`{jobId}.json`) is the canonical per-job manifest the renderer reads. See `src/main/jobs/sidecarManager.js` for the current shape.

### Per-image entry (existing `images[]` array)

Add to each image entry:

```jsonc
{
  // ... existing fields ...
  "artworkFileId":     "uuid-from-api",        // null for FTP-delivered files
  "artworkSource":     "pixfizz"|"manual",     // null for FTP-delivered files
  "artworkType":       "optimized"|"manipulated"|"original",  // null for FTP-delivered
  "productionReady":   true|false,             // null for FTP-delivered
  "originalFileName":  "<API file_name>"       // distinct from disk filename when collision-renamed
}
```

`null` defaults are important — they let the renderer distinguish "this is a legacy FTP file with no S3 metadata" from "this is an S3 file flagged X".

### Job-level (top of sidecar)

Add a single new field tracking which S3 file ids have been materialised:

```jsonc
{
  // ... existing top-level fields ...
  "s3ArtworkFileIdsKnown": ["uuid-a", "uuid-b"]   // set, persisted; used for mutation diff on next poll
}
```

When `downloadJobArtwork` runs and discovers a NEW id (not in `s3ArtworkFileIdsKnown`), it fetches the file and appends the id to the array.

---

## Implementation milestones

Each milestone is independently shippable and reviewable. Land them in order.

### M1 — S3 downloader + canonical disk layout

**Files to add:**
- `src/main/services/s3-artwork-downloader.js` (new)

**Files to modify:**
- `src/main/services/polling-service.js` — wire the new downloader into `pollJobs()` between fetch and the per-job loop (see §"Polling integration point" above)
- `src/main/services/job-service.js` — `_normalizeJob` (around line 120) already captures `artwork_files`. Confirm the shape; add no-op-safe defaults for `artwork_source`, `artwork_ready_at` if missing
- `src/main/jobs/sidecarManager.js` — extend `loadSidecar` / `saveSidecar` to persist the new per-image fields and the job-level `s3ArtworkFileIdsKnown` array. Migrate legacy sidecars on read by setting new fields to `null` and the id array to `[]`

**Behaviour:**
- For each pending job with `artwork_files.length > 0`, download files whose `id` is not already in `s3ArtworkFileIdsKnown` AND whose computed disk name does not already exist
- Use the collision rule above
- Write each file's sidecar entry on successful download (NOT before — partial sidecar = false-positive `checkLocalFiles`)
- Append the `id` to `s3ArtworkFileIdsKnown` after successful sidecar write
- Bounded concurrency: 4 parallel downloads max per job; serialize jobs (don't try to parallelise across jobs in V1)

**Logging:**
- INFO on download start per file: `{ jobId, fileId, fileName, artworkType, source, sizeBytes? }`
- INFO on success: `{ jobId, fileId, diskName, durationMs }`
- WARN on collision-rename: `{ jobId, fileId, originalName, diskName }`
- ERROR on failure: `{ jobId, fileId, error.code, error.message }` — never log `file_url`

**Test plan for M1:**
- Manual job, single file, fresh poll: file lands on disk under `file_name`, sidecar entry created, id appended to job-level array, `markReceived` fires on next `checkLocalFiles`
- Manual job, two files with identical `file_name`: first lands under `file_name`, second lands under collision-renamed form, both sidecar entries present
- Same job polled twice: second poll downloads nothing (idempotent skip)
- Manual job, new file uploaded between polls: second poll picks up the new id only, doesn't re-download existing files
- Pixfizz job with FTP delivery AND empty `artwork_files[]`: downloader is a no-op, FTP path runs unchanged
- Pixfizz job with FTP delivery AND a manual-source replacement file in `artwork_files[]`: FTP files land via FTP, manual file lands via S3, both coexist in the job folder
- Network failure mid-download: `.tmp` file is left behind but not picked up by `checkLocalFiles`; next poll retries cleanly

### M2 — Per-job auto-print hold gate + UI chip

**Files to modify:**
- Wherever `onAutoPrint` is invoked — search the codebase for `setAutoPrintCallback` and trace to the dispatch site. Likely `src/main/index.js` or `src/main/ipc-handlers.js`
- `src/renderer/...` — Job Review job card component (search for the existing AI-quality chip / status badges to find the right file)
- `src/main/jobs/sidecarManager.js` — derive and cache `_holdForReview` on the job object so the renderer can use it without re-computing

**Hold rule (canonical):**

A job is `_holdForReview = true` if **any** of:

```
job.artwork_source === 'manual'
  OR job.artwork_files.some(f => f.source === 'manual')
  OR job.artwork_files.some(f => f.production_ready === false)
```

The auto-print dispatcher MUST skip jobs where `_holdForReview === true`. The operator's manual "Send to Print" action is unaffected — they can still dispatch, the hold only blocks the automatic callback.

**UI chip:**

- Yellow background, text `"Manual — review required"` on the job card
- Tooltip on hover: which of the three conditions triggered the hold (helps diagnose mixed-source jobs)
- Per-file chips on the file list inside the expanded job: small `Pixfizz` or `Manual` tag, ONLY shown when `file.source !== job.artwork_source` (i.e. only highlight the file that differs from the job-level source). Otherwise the file list stays uncluttered.

**Test plan for M2:**
- Manual job + auto-print enabled: dispatch is skipped, yellow chip visible
- Manual job + operator hits Send to Print: dispatch proceeds normally
- Pixfizz job with operator-uploaded replacement file: whole job held, yellow chip on the job card, `Manual` tag only on the replacement file
- Pixfizz job, all files `production_ready: true`: no hold, no chip, auto-print as today (regression baseline)
- Pixfizz job, one file `production_ready: false`: whole job held, chip tooltip explains "file not finalised"

### M3 — Quantity math + production_ready chip

**Files to modify:**
- `src/main/jobs/sidecarManager.js` — on first creation of an image entry from an S3 download, set `qtyOriginal = job.quantity * file.copies` and `qtyCurrent = qtyOriginal`. For FTP-delivered files (where copies is unknown), preserve today's behaviour (`qtyOriginal = job.quantity`, copies implied as 1)
- `src/renderer/...` — Job Review card to display `quantity` more prominently (it's now load-bearing rather than implied by size). Add a small warning chip for files with `productionReady === false`

**Quantity surfacing:**

- Job-level `quantity` shown as a small chip near the job header (e.g. `Qty: 3`)
- Per-file `copies` shown next to the file row only when `copies !== 1` (avoid clutter for the common case)
- Per-file `qtyOriginal` continues to drive print dispatch math

**production_ready chip:**

- Subtle warning-style chip on the file row, text `"Not finalised"`
- Operator can still see the file; the chip is informational. The auto-print hold (M2) handles the actual gating.

**Test plan for M3:**
- Manual job, qty=3, single file with copies=1: `qtyOriginal=3`
- Manual job, qty=2, two files with copies=1 and copies=2: file A gets `qtyOriginal=2`, file B gets `qtyOriginal=4`. Set multiplier = job.quantity, per-file multiplier on top.
- Manual job, file with `production_ready: false`: warning chip visible, job is held (M2 covers the hold)

### M4 — `artwork_type: 'original'` → Customer Originals plumbing

**Files to modify:**
- `src/main/services/s3-artwork-downloader.js` — when `artwork_type === 'original'`, write the file to `{jobPath}/original-files/` instead of the flat job folder
- `src/main/ipc-handlers.js` — `_buildManifestImageMetaMap` (referenced in Customer Originals Phase 1+2 memory) populates `originalFilename` for Pixfizz manifest entries. We need a parallel path that back-fills `originalFilename` from the S3 download for OTHER files in the same job.

  Specifically: when an S3 download produces an `artwork_type: 'original'` file, find the corresponding `optimized` or `manipulated` sibling in the same job (by `id` relationship — Lovable doesn't expose this directly today, so use heuristic: same `file_name` stem after stripping `__id_short` suffix), and set its sidecar `originalFilename` to the relative path of the `original-files/` file.

  If no sibling can be identified, write the `original-files/` file anyway. The Customer Originals UI degrades silently when `originalFilename` is null.

**Why this matters:**

The Customer Originals subsystem (Phase 1 + 2, shipped 2026-05-15) already implements:
- A thumbnail of the customer's pre-crop upload on the Job Review card
- ⤢ "open in OS viewer" and ⌗ "show in Explorer" buttons
- A "Source: Customer crop | Original" toggle in the crop editor that loads the original and lets the operator re-crop, writing the result via `sharp.extract()` into `recrops/` and re-pointing `entry.filename`

By writing S3-delivered `original` files to `original-files/` and back-filling `originalFilename`, we get all of this for free. M4 is the cheapest win in the entire brief — it's nearly all reuse.

See `OHD_CustomerOriginals_ClaudeCode_Brief.md` for the full spec of the existing subsystem.

**Test plan for M4:**
- Manual job with one `original` and one `optimized` file: original lands in `original-files/`, optimized lands flat, `originalFilename` is populated in the optimized's sidecar entry pointing at `original-files/<name>`
- Manual job with only an `original` (no optimized counterpart): original lands in `original-files/`, no sidecar back-fill happens, Customer Originals UI does not light up for that file (expected silent degrade)
- Open the Customer Originals thumbnail + Re-crop modal end-to-end on a manual-source job: behaviour should be byte-identical to a Pixfizz `originalFilename`-driven case

---

## Behaviour rules (canonical reference)

### Hold-from-auto-print

```
job._holdForReview =
     job.artwork_source === 'manual'
  || job.artwork_files.some(f => f.source === 'manual')
  || job.artwork_files.some(f => f.production_ready === false)
```

Applied as a filter in front of the auto-print dispatcher. Operator-initiated dispatch is NOT affected.

### Disk-name resolution

```
candidate = file.file_name
if exists(jobFolder/candidate) and existing.id !== file.id:
  candidate = `${stem(file.file_name)}__${file.id.slice(0,8)}.${ext(file.file_name)}`
if exists(jobFolder/candidate) and existing.id === file.id:
  skip   // idempotent — already downloaded
```

### Print dispatch precedence

When multiple `artwork_type` values exist for what is conceptually the same source image (a job may have `original`, `manipulated`, AND `optimized` for the same upload), the print pipeline picks the highest-precedence one:

```
optimized > manipulated > original
```

`original` is the customer's raw upload and should ONLY be printed if the operator explicitly selects it via the Customer Originals Re-crop flow (which produces a new printable in `working/`).

### `markReceived` timing

Unchanged from today. `checkLocalFiles` runs after `downloadJobArtwork`. The moment files are on disk, `markReceived` fires (whether the source was FTP or S3). For held-for-review jobs, this is correct: OrderHub gets to know "lab has received the artwork" even though the print dispatch is pending operator approval.

---

## Out of scope (do NOT build)

- **Stale-skip / "Awaiting artwork" UI bucket** — OrderHub filters `artwork_source: 'none'` server-side now. OHD never sees those jobs in `/pending-jobs`. Don't reinvent the filter.
- **Cancel back to OrderHub** — OHD never calls `/update-order-status` to cancel art-less jobs. That's manually driven from the OrderHub web UI.
- **Mid-download URL refresh** — `file_url` is a stable public URL, not a signed URL with TTL. Don't add refresh logic.
- **Per-file `updated_at` mutation detection** — uploads create new rows, never mutate. Diff by `id` set; that's sufficient.
- **`upload_batch_id` grouping** — not exposed by OrderHub today. If operator UX demands batch grouping later, we ask OrderHub then.
- **Cross-job download parallelisation** — V1 serialises across jobs. Per-job parallelism is bounded at 4. Don't add a job-level queue.
- **Admin UI for `staleArtworkThresholdDays`** — the config doesn't exist; M5 is deleted.

---

## References to existing code

These are the load-bearing files Claude Code will need to read to navigate confidently:

- `src/main/services/polling-service.js:177-251` — `pollJobs()` is the integration point. The `for (const job of pendingJobs)` loop at line 209 is what the new downloader sits in front of.
- `src/main/services/job-service.js:115-152` — `_normalizeJob` is where `artwork_files`, `artwork_source`, `artwork_ready_at` get captured into the local job object today. They're unused downstream — this is what M1 changes.
- `src/main/services/job-download-service.js` — misnamed (does NOT download). Just `checkLocalFiles` and `_countFiles`. Don't rename it; the new S3 downloader lives in a separate file.
- `src/main/services/ftp-service.js:313+` — `scanAndDownload` is the FTP path. Useful as a reference for "what does the parallel ingestion path look like" but the S3 downloader is materially simpler (no recursive listing, just direct HTTPS GET per URL).
- `src/main/services/s3-service.js` — upload-only today. New file `s3-artwork-downloader.js` is its download counterpart; same project style (native `https.get`, no AWS SDK).
- `src/main/services/presign-service.js` — example of the project's HTTPS request style. The new downloader's network code should match.
- `src/main/jobs/sidecarManager.js` — sidecar shape, the `loadSidecar` reconciliation logic. M1 extends this.
- `src/main/jobs/customerOriginalsActions.js`, `src/main/jobs/customerRecropActions.js` — Customer Originals Phase 1+2. M4 plumbs into this. Read `OHD_CustomerOriginals_ClaudeCode_Brief.md` for the full spec.
- `src/main/ipc-handlers.js` — search `_buildManifestImageMetaMap`. The back-fill mechanism for `originalFilename` lives here.

Memory entries (in the auto-memory store, not the repo):
- `project_ohd_ingestion_architecture` — full breakdown of current FTP + API two-loop architecture
- `project_ohd_s3_artwork_channel` — Lovable contract, decisions
- `project_ohd_customer_originals_phase1` — the existing Phase 1+2 reference for M4

---

## Acceptance checklist (whole feature)

Before declaring the work done, all of these must be true:

- [ ] Pixfizz job with FTP-only delivery: zero behaviour change. Auto-print fires as before.
- [ ] Manual job, single S3 file: file lands on disk, sidecar populated, `markReceived` fires, auto-print is blocked, yellow chip shows on the card.
- [ ] Manual job, 50 files: all 50 land on disk via the S3 downloader, all entries appear in the sidecar, the job is held from auto-print as a single unit.
- [ ] Pixfizz job with one operator-replacement file (mixed source): whole job is held, yellow chip on the card, per-file `Manual` tag only on the replacement file.
- [ ] Manual job with `original` + `optimized` files: original goes to `original-files/`, optimized goes flat, Customer Originals thumbnail and Re-crop modal both work end-to-end on the optimized file.
- [ ] Quantity = 3, two files with copies = 1 and copies = 2: dispatch produces 3 prints of file A and 6 prints of file B.
- [ ] File with `production_ready: false`: visible with "Not finalised" chip, whole job held.
- [ ] Idempotent re-poll: downloading the same job twice writes nothing on the second pass.
- [ ] Mid-poll new file: fetched on next poll, not on the current one.
- [ ] Network failure mid-download: no partial files visible to `checkLocalFiles`; clean retry on next poll.
- [ ] No regressions in `OHD_CustomerOriginals_ClaudeCode_Brief.md` acceptance tests.
- [ ] CHANGELOG entry written under the current version.

---

## Notes for the implementer

- **Treat M1 as the foundation.** Get it solid, including the idempotency and `.tmp`-then-rename pattern, before starting M2. The other three milestones all depend on M1's downloader working cleanly.
- **Don't reinvent the holding mechanism.** Look at how `aiQualityHoldAutoPrint` is wired (see `project_ohd_ai_quality_hold_autoprint` memory entry). The new `_holdForReview` is the same shape with different inputs.
- **Don't sanitise filenames.** Trust the server. If a write fails on Windows due to a reserved name, log and skip the file with a clear error — don't silently mangle.
- **Don't log `file_url`.** Anywhere. Use `id` as the log key. The URLs are sensitive even though they're "public" — they're persisted URLs that grant read access until manually rotated.
- **Keep `s3-service.js` upload-only.** The download counterpart is a new file. Don't merge them.
- **Match existing project style:** native `https`, no AWS SDK, no external HTTP libraries. Match the request shape in `presign-service.js`.

End of brief.
