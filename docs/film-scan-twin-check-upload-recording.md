# Film-Scan Twin-Check Upload Recording

**Status:** Live on OrderHub (all orgs); shipped in OrderHub Desktop **v1.7.20** (built, not yet published to the auto-update channel).
**Last updated:** 2026-07-18

## Purpose

When a lab scans a roll of developed film, OrderHub Desktop (OHD) uploads the images to S3. This feature makes OrderHub **record that the scans were uploaded against the correct job's twin check**, and surfaces a **"Scanned ✓ · date · N images"** badge on the Film Development → Twin Checking tab so counter staff can see, per twin check, that the roll is in.

It builds on the existing **Film Development Auto Assignment** feature (OHD matches a scanned roll folder to a job by 4-digit twin check).

---

## End-to-end flow

1. **Assign twin checks (OrderHub).** On Film Development → Twin Checking, an operator scans a job and assigns one or more 4-digit codes. Stored in `job_twin_checks` (`job_id`, `organization_id`, `code`, `position`).
2. **Serve the job to OHD (OrderHub `ohd-api`).** `GET /ohd-api/jobs/pending` includes the film-development job via the *twin-check exception* and tags it `is_film_development: true` with `twin_checks: ["9001", ...]`. (See "Configuration" — this requires `disable_ohd = true`.)
3. **Match (OHD).** The auto-assign matcher pairs a held scan-roll folder (e.g. `00009001`) to the job by normalised twin code (`00009001` → `9001`) and stamps the roll record with `matchedJobId`, `matchedJobNumber`, `matchedOrderId`, `matchedOrderNumber`, `matchedTwinCheck`, `matchedAt`.
4. **Upload + manifest (OHD).** OHD uploads the roll's images to `film-scans/{locationId}/{folder}/` and writes a completion manifest `{folder}.json`. When the roll is matched, the manifest now **also carries the matched job/twin context** (see "Manifest format").
5. **Ingest + stamp (OrderHub `sync-film-scans-from-s3`).** The sync reads the manifest, upserts a `film_scans` row, and — when the manifest has `job_id` + `twin_check` — stamps the matching `job_twin_checks` row with `film_scan_uploaded_at`, `film_scan_id`, `film_scan_image_count`.
6. **Display (OrderHub Twin Checking tab).** Each stamped code shows the green **Scanned ✓** badge with the upload date (org date format) and image count.

---

## OrderHub Desktop side

### Auto-assign matcher
`src/main/services/film-scan-auto-assign.js` — compares held rolls (`uploadStatus:'pending'`, `awaitingAssignment:true`) against cached film-dev jobs (`jobService.getFilmDevelopmentJobs()` → jobs with `is_film_development:true`). Twin normalisation: strip trailing `_N`, strip non-digits, strip leading zeros. Stamps the `matched*` fields on the roll record.

### Manifest enrichment (this feature)
- `src/main/services/s3-service.js` — `uploadFolder(localFolderPath, s3Prefix, credentials, progressCallback, manifestExtra)` gained the optional `manifestExtra`. `_buildManifestPayload(folderName, files, failed, manifestExtra)` shallow-merges it **after** the built-in fields, so built-ins always win on key collision. Null/non-object `manifestExtra` is ignored (byte-identical legacy manifest).
- `src/main/services/folder-watch-service.js` — `_buildFilmScanManifestExtra(rollId)` returns the snake_case block **only when `matchedJobId` is set**, else `null`.

### The three film-scan upload sites (all patched)
There are **three** places OHD uploads a film-scan roll; all now pass `manifestExtra`:
1. `folder-watch-service.js` `_processFilmScans` inline (Auto / Smart-confident path).
2. `folder-watch-service.js` `_uploadRollFromStorage` (auto-assign match trigger + startup resume).
3. `ipc-handlers.js` `ohd:filmReview:approve-roll` (**manual "Approve & Upload"** — a matched roll in Manual review mode clears the gate and uploads here). *This was missed in the first pass and is the classic gotcha — see below.*

The **File Uploads** pipeline (`folder-watch-service.js` ~line 1088) is intentionally **not** patched; its manifest is unchanged.

### Matched-state UI (Film Review panel)
- `RollReview.jsx` detail header: "Matched → Job {number} · Twin {code} · Order {number}" when matched, or "Awaiting job match" when held and unmatched.
- `RollList.jsx` card: persistent "Twin {code}" tag (survives after upload; job/order on hover), alongside the existing held-state "Matched — awaiting review" badge.
- CSS: `fr-roll-card__twin`, `fr-roll-matchbar` in `film-review.css`.

### Config (OHD)
- `filmScanAutoAssignEnabled` (Settings → Film Scans → **Auto Assignment Mode**) must be **on**, and on when the roll is scanned (arming happens at scan time).
- AI Rotation review mode (`filmScanReviewMode`: Auto / Smart / Manual) governs the approval gate; matching is independent of it.

### OHD commits
`fce3633` (manifest enrichment + tests), `d05b11a` (approve-roll fix + tests), `7db0911` (matched-state UI), `12fe979` (Release 1.7.20). 892 tests green. On `main`, unpushed.

---

## OrderHub (Lovable `pixfizz-oms`, project `dc8eacaf-…`) side

### `ohd-api` twin-check exception
`supabase/functions/ohd-api/index.ts` `getPendingJobs`: jobs whose resolved process has `disable_ohd = true` are normally dropped, **except** when they have `job_twin_checks` rows — those are included, tagged `is_film_development: true`, with `twin_checks` populated (ordered by `position`). Normal (non-`disable_ohd`) jobs get `twin_checks: []` and `is_film_development: false` **even if they have twin-check rows** — so the matcher can't see them. The job must also be production-released, non-terminal, order not pre-confirmation, and its effective location must match the polling instance's `X-Location-ID`.

### Schema
- `job_twin_checks` — added nullable `film_scan_uploaded_at timestamptz`, `film_scan_id uuid` (FK `film_scans` ON DELETE SET NULL), `film_scan_image_count integer`, + partial index on `film_scan_id`.
- `film_scans` — carries `twin_check_number`, `folder_name`, `s3_folder_path`, `image_count`, `ohd_version`, `ohd_completed_at`, `ohd_upload_errors`, `location_id`, `order_id`, etc.

### Sync + stamp
`supabase/functions/sync-film-scans-from-s3/index.ts` (cron + manual):
- `OhdManifest` interface extended with the optional job/twin fields.
- `stampTwinCheckFromManifest()` — idempotent; only runs when the manifest has both `job_id` and `twin_check`. Uses `manifest.completed_at` as the timestamp. Called on the new-scan, image-count-update, **and exists-unchanged** paths (the last back-fills scans uploaded before the stamp existed).
- `resolveInternalJobId()` — **critical id mapping.** OHD writes the job's *external* id into `manifest.job_id` (`jobs.external_line_item_id`, e.g. `"38502434"`); `job_twin_checks.job_id` is the *internal* `jobs.id` UUID. Resolution order (scoped to org): `external_line_item_id` → (if UUID) `jobs.id` → `job_number`. The stamp uses the resolved internal id.

### Twin Checking tab badge
`src/components/film-development/TwinCheckingTab.tsx` — loads `film_scan_uploaded_at` + `film_scan_image_count` with each code and renders the green "Scanned ✓ · {date} · {n} images" badge (muted "Not yet scanned" otherwise). Date via the existing `@/lib/dateFormat` `formatDate(iso, dateFormat)` helper, reading `organization_preferences.date_format` (DMY/YMD/MDY). Note: the helper is date-only and does **not** apply `timezone` — consistent with the rest of the app.

### OrderHub commits
`f03c254` (migration + stamp), `8c1bdb3` (tab badge), `952ff7c` (id-resolution fix + exists-path back-fill). Deployed.

---

## Manifest format

**Legacy (unchanged for unmatched rolls & File Uploads):**
```json
{"folder":"00009001","total_files":41,"tiff_count":0,"jpg_count":40,"errors":0,
 "completed_at":"2026-07-17T12:19:13.432Z","ohd_version":"1.7.20"}
```

**Enriched (matched auto-assign roll):** the same, plus:
```json
{"twin_check":"9001","job_id":"38502434","job_number":"PXDEMO-KMK72Q-1",
 "order_id":"…","order_number":"PXDEMO-KMK72Q","matched_at":"…","auto_assigned":true}
```
Built-in fields always win on key collision.

---

## Configuration checklist (per lab)

1. OrderHub org: **Film Development** enabled + **Twin Checking** enabled.
2. The film process (e.g. "Film Processing") has **`disable_ohd = true`**. **This is the on-switch** — counterintuitively, "disable from desktop" is exactly what routes the job down the twin-check-only channel the matcher listens on. With it *off*, the job comes through as an ordinary job (`is_film_development:false`, `twin_checks:[]`) and never matches (and clutters the print queue).
3. Twin checks assigned to the job **before** the roll is scanned/matched.
4. `organization_secrets.film_scans_enabled` + S3 configured.
5. Store location `film_scans_enabled`; the job's effective location matches the OHD instance's location (or film-processing routing points to it).
6. OHD: **Auto Assignment Mode** on; scan folders named to match the twin code (`00009001` ↔ `9001`).

---

## Gotchas & design notes (learned the hard way)

- **`disable_ohd` must be ON.** See checklist #2. Turning it off silently breaks matching.
- **External vs internal job id.** `manifest.job_id` is `external_line_item_id`, not the internal UUID. `resolveInternalJobId()` bridges it. Any future consumer of `manifest.job_id` must resolve, not compare directly to `jobs.id` / `job_twin_checks.job_id`.
- **Three upload paths.** Manual "Approve & Upload" uses its own upload call in `ipc-handlers.js`, separate from the folder-watch paths. Any change to the film-scan manifest must touch all three (not File Uploads).
- **Stamp is gated + idempotent.** Only fires with both `job_id` and `twin_check` present; safe to re-run. Historic uploads (old manifest, no `job_id`) can't be stamped without re-upload.
- **Image count can lag.** `film_scan_image_count` reflects what was in S3 at sync time; a sync mid-upload can undercount. A later sync (update path) re-stamps with the final count.
- **Two OHD instances race.** If the installed tray app and a `npm start` dev build both watch the same hotfolder, either may grab the roll — the non-Stage-2 one produces a legacy manifest. Run only one instance.

---

## Verification (how to confirm end-to-end)

1. Assign a fresh twin check to a film-dev job (e.g. `9002`).
2. With only one OHD instance running and Auto Assignment on, drop folder `00009002`.
3. OHD Film tab: roll shows **Matched → Job … · Twin 9002**; approve & upload.
4. S3 `film-scans/{loc}/00009002/00009002.json` contains `twin_check` + `job_id`.
5. Run the OrderHub sync; `job_twin_checks` for `9002` gets `film_scan_uploaded_at` set.
6. Twin Checking tab shows the **Scanned ✓** badge.

---

## Rollout status & remaining work

- **OrderHub:** live for all orgs (dormant until a lab runs Stage-2 OHD).
- **OHD Desktop:** v1.7.20 built locally, **not published** to the auto-update channel and **not pushed** to origin. To go live for labs: push `main`, then publish (upload installer + set the current `ohd_releases` row).

### Deferred / future
- **Stage 4 — read-time fallback:** show a badge for scans uploaded *without* auto-assign matching (no `job_id`) by matching `film_scans` on code. Only needed if some labs upload film without matching.
- Surface film scans on the **order / customer detail** page (a scan can be linked to an order via `film_scans.order_id`, but no order-side view exists today).
- Cosmetic: the earlier "matched state not shown in the Film tab" gap is now fixed (v1.7.20).
