# Phase 4 Build Spec — Gallery-on-Upload + TIFF/JPG Split

**Status:** Ready to build (2026-07-18). All OrderHub web (Lovable `pixfizz-oms`). **No OHD change needed.**
**Depends on:** Phases 1–3 (shipped).

## Goal

1. **Gallery on upload** — in Film Development mode, create the per-roll Pixfizz gallery as soon as the roll syncs (spreads server load; default on, toggleable).
2. **TIFF/JPG split** — the **JPG copies go into the gallery** (customer viewing); the **TIFF originals feed the download links** (not shown in the gallery), paired by base filename.

## Confirmed facts (verified 2026-07-18)

- OHD uploads **both** the `.tif` original and the `.jpg` copy per frame (folder-watch "Step 2b" converts TIFF→JPG and keeps both; S3 upload excludes only `.thm`/`.txt`). No OHD change needed.
- `film_scan_images` already has rows for **both** types (`mime_type` `image/jpeg` and `image/tiff`; extension in `file_name`). So both are ingested; we classify and pair.
- Galleries are per-roll (per `film_scans`), created by `process-gallery-queue` from `film_scan_gallery_queue`. Enqueue currently happens on manual association / `auto_create_gallery` (per `pixfizz_website_email_settings`).
- Phase 2b's auto-associate call passes `queueGallery: false` (deferred to here).
- Downloads: `{{direct_download_urls}}` / the zip background job (`film_scan_zip_jobs`, DownloadRouter route) serve roll files.

## Guardrail (non-disruptive)

- Gallery-on-upload only fires in `film_development` mode. Legacy manual/`auto_create_gallery` path unchanged.
- The gallery build now excluding TIFFs is a **correctness improvement for everyone** (TIFFs shouldn't be in a customer viewing gallery), but verify legacy galleries still build from their JPGs.
- Additive; no schema change strictly required (classify by `mime_type`/extension). Optional: a cached `image_role` column if it simplifies the queries — only if clean.

## Design

### 1. Gallery on upload (Film Development mode)
- In `sync-film-scans-from-s3`, the Phase 2b auto-associate call should now request gallery queuing (`queueGallery: true`) so a matched roll's gallery is created as soon as it syncs.
- Keep it **default-on with an off switch**: reuse the per-brand `pixfizz_website_email_settings.auto_create_gallery` toggle, but in Film Development mode treat **absent/NULL as ON** (so a lab gets galleries by default; setting `auto_create_gallery = false` turns it off). Idempotent (the queue upsert already dedupes per `film_scan_id`).

### 2. TIFF/JPG split
- **Gallery build (`process-gallery-queue`):** when selecting `film_scan_images` to upload into the Pixfizz gallery, include **JPGs only** (`mime_type = 'image/jpeg'` / `.jpg`/`.jpeg`). Never upload `image/tiff` into the gallery. (This also avoids pushing huge TIFFs to Pixfizz.)
- **Downloads (`{{direct_download_urls}}` / zip / DownloadRouter):** serve the **TIFF originals**. Per frame, pair by base filename (strip extension): if a `.tif`/`.tiff` exists for that frame, the download uses the TIFF; otherwise fall back to the JPG. So the customer views JPGs in the gallery and downloads full-res TIFF originals (JPG where no TIFF exists).
- Pairing: base name = `file_name` without extension. A frame = the set of `film_scan_images` sharing a base name within a `film_scan_id`.
- Thumbnails: TIFF rows don't need gallery thumbnails (download-only) — optional to skip generating them, not required.

## Verification

1. Film Development mode + `auto_create_gallery` unset → upload a matched roll → a `film_scan_gallery_queue` row is created and `process-gallery-queue` builds a gallery containing **only the JPGs**.
2. For a TIFF roll (both `.tif` + `.jpg` in S3): the gallery shows JPGs; the download links / zip resolve to the `.tif` originals (JPG only where a frame has no TIFF).
3. A JPG-only roll: gallery = JPGs; downloads = JPGs (no TIFF to prefer). Unchanged behaviour.
4. Legacy (film_scans mode) org: gallery/download behaviour unchanged except galleries no longer include TIFFs (improvement).

---

## Prompt A — Lovable — gallery-on-upload + JPG-only gallery

```
Phase 4a — Film Development gallery-on-upload, and make galleries JPG-only.

Context: OHD uploads both the .tif original and the .jpg copy per frame, so film_scan_images has both
image/jpeg and image/tiff rows. Galleries are per-roll, built by process-gallery-queue from
film_scan_gallery_queue.

1. Gallery on upload (film_development mode only): in supabase/functions/sync-film-scans-from-s3, the
   Phase 2b auto-associate call currently passes queueGallery:false. Change the Film Development auto-link
   so it requests gallery queuing. Keep it default-on with an off switch: reuse the per-brand
   pixfizz_website_email_settings.auto_create_gallery toggle, but in film_development mode treat an
   absent/NULL auto_create_gallery as ON (lab gets galleries by default; auto_create_gallery=false turns
   it off). Idempotent (queue upsert dedupes per film_scan_id). Do not change the legacy manual path's
   behaviour.

2. Gallery build is JPG-only: in supabase/functions/process-gallery-queue, when selecting the
   film_scan_images to upload into the Pixfizz gallery, include only JPG images
   (mime_type = 'image/jpeg', or .jpg/.jpeg by file_name) and exclude image/tiff. TIFFs must never be
   uploaded into the customer gallery. Keep ordering (display_order) intact among the JPGs.

Additive; legacy film_scans-mode orgs unaffected except that galleries no longer include TIFFs (correct).
```

## Prompt B — Lovable — downloads serve TIFF originals

```
Phase 4b — make the download links serve the TIFF originals (paired to the gallery JPGs by base name).

The customer views JPGs in the gallery (Phase 4a) but should DOWNLOAD the full-res TIFF originals.

In the film-scan download path (the {{direct_download_urls}} builder and the zip background job /
film_scan_zip_jobs, plus the DownloadRouter route if it lists files): for each frame, pair film_scan_images
by base filename (file_name without extension) within a film_scan_id. If a .tif/.tiff exists for that
frame, the download uses the TIFF original; otherwise fall back to the JPG. So a roll's download/zip
contains the TIFF originals where they exist and JPGs only for frames that have no TIFF. Do not change the
gallery (which stays JPG-only).

Keep it correct for JPG-only rolls (no TIFFs → downloads are the JPGs, unchanged) and idempotent.
```

## Notes

- Build A first, then B.
- No new schema needed; classify by mime_type/extension. Only add an `image_role`/`is_original` column if it makes the queries materially cleaner — your call.
- Phase 5 (email) will reference gallery URLs (already per-roll) and, via `{{direct_download_urls}}`, the TIFF downloads from Phase 4b.
