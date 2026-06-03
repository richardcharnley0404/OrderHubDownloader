## Unreleased

### Added — M5b batch crop UI + propagation for manual-source jobs (2026-05-25)

Manual-source jobs with uncropped images now open Job Review directly in
batch crop mode. Operator drags a default crop rectangle on a preview
frame, toggles Portrait / Landscape, and clicks Apply Default to All —
the new `ohd:job:batch-crop-apply` IPC loops the M5a-verified crop
primitive over the uncropped subset and streams per-image progress to
the renderer.

- **Shared trigger predicate** (`src/shared/batchCropTrigger.js`): pure
  `shouldEnterBatchCropMode(job, sidecar)` returning `{ enter, mode,
  uncroppedCount, totalCount, reason }`. Mode `auto` → drawer opens
  directly in batch mode; `button` → standard drawer with a prominent
  "Batch Crop Remaining (X)" CTA above the grid; `standard` → no
  manual signal or fully cropped, standard drawer. Mirrors
  `holdForReview.js`'s placement so renderer + main agree.
- **Shared crop primitive** (`src/main/jobs/batchCropActions.js`):
  `_applyCropToSingleImage` was extracted from the body of
  `ohd:job:crop-image` so both the per-image IPC (M5a) and the new
  batch IPC call the same code path. The M5a 11 regression tests stay
  green — the refactor is mechanical, the IPC's external contract
  unchanged. New helper `_fractionalToPixelRect` scales a fractional
  rect to per-image pixel coordinates and clamps to source bounds.
- **Batch driver** (`applyBatchCrop` in the same file): strictly serial
  per job (libvips cache + SMB sensitivity), per-image sidecar save,
  per-image progress callback, one final save for the job-level
  `batchCropDefaultRect` / `batchCropDefaultOrientation` /
  `batchCropLastAppliedAt` fields. **Failure policy is
  continue-best-effort**: per-image failures (corrupt uploads,
  unreadable EXIF, libvips errors) land in `failed[]` but do NOT
  abort the batch — successful images persist either way and operators
  want all failures surfaced in one batch run rather than serially.
  **Safety belt**: 10 consecutive failures sharing the same
  `error.code` aborts the remainder (reason `consecutive-same-error`)
  to prevent a runaway systemic failure (network drive unmounted,
  sharp init crash) from spinning through 100 images.
- **Sidecar schema** (flat sibling fields, no nested wrapper — see
  M5a's "Brief vs. as-built" subsection): per-image `cropOrientation`,
  `cropSource: 'batch' | 'per-image'`, `cropAppliedAt`, `cropRotation`
  (null until M5c bakes rotation); job-level `batchCropDefaultRect`
  (fractions), `batchCropDefaultOrientation`, `batchCropLastAppliedAt`.
  Reconcile D in `sidecarManager.js` hydrates these on legacy sidecars
  in-memory only — no spurious save (regression-tested).
- **New IPC channels**:
  - `ohd:job:batch-crop-apply` — accepts `filenames`, `fractionalRect`,
    `orientation`; emits `ohd:batch-crop:progress` per image.
  - `ohd:job:resolve-target-size` — reads the assigned route via
    `routingService.resolveRoute(job)` and matches against
    `allSizeOptions`. If no route or no size translation, returns a
    structured `{ ok: false, reason }` so the UI can disable batch
    mode with a tooltip. **No silent default fallback** — operator
    must assign a route before cropping.
- **Renderer** (`src/renderer/views/JobReview/BatchCropMode.jsx`):
  top-bar with read-only target size pill, segmented orientation
  toggle, primary Apply Default to All CTA, per-image progress text;
  large draggable preview frame on the left for setting the default
  rect (aspect locked to target size, drag-to-move, orientation swap
  flips w/h); thumbnail grid on the right with the same fractional
  rect overlaid on every uncropped thumb (cropped thumbs get a green
  check); bottom bar surfaces post-batch summary + collapsible
  failure details. Operator override (Exit Batch / Batch Crop
  Remaining CTA) flips between batch and standard modes within the
  same drawer without a reload.
- **Tests**: 14 new tests in `batchCrop.test.js` — fractional → pixel
  scaling unit tests at 200×150 / 4000×3000 / 1080×1920 / clamping /
  zero-minimum; 5-image integration with full M5b sidecar assertions
  + progress callback verification + raw-upload audit preservation;
  mixed-dimension propagation; idempotency; continue-best-effort
  failure handling; safety belt abort + counter reset; M5a regression
  via single-image batch; cropSource default; Reconcile D no-spurious-
  save. Full suite **520 / 520 pass** (was 506; +14 new).

**Out of scope for M5b** — M5c will add focused per-image override mode
(click a thumb to open a CropEditor-based modal with `[`/`]` navigation,
R/L rotation baked into the file). Renderer bundle rebuilt; visual
verification pending against a live manual job.

### Verified — M5a single-image crop pipeline for manual jobs (2026-05-25)

Verified the existing `ohd:job:crop-image` handler against the brief's M5a four-point contract for manual-source files. All four functional outcomes hold without source changes: cropped pixels at `working/<filename>` with matching dimensions; raw upload at the flat job folder root byte-identical before/after; sidecar gains `cropApplied + croppedPath + cropRect + channelMappingId` (and `filename` stays the original basename — load-bearing for `originalsManager.resetImage`, AI scoring's `_scanJobImages`, and reprint manager); dispatch substitution via `print-service._getEnhancedPathMap` sends the cropped path. Two new test files lock the contract: `manualCrop.test.js` (5 tests against the handler) and `manualCrop.dispatch.test.js` (6 tests against `_getEnhancedPathMap`). Brief updated with a "Brief vs. as-built" section under M5a and the M5b/M5c schema rewritten as flat sibling fields (`cropOrientation`, `cropSource`, `cropAppliedAt`, `cropRotation`, `batchCropDefaultRect`, etc.) — no nested `crop: {...}` / `batchCrop: {...}` wrappers, so M5b doesn't build a parallel structure and no on-disk sidecar migration is needed.

### Fixed — M3 quantity math: file.copies is authoritative, job.quantity is informational (2026-05-25)

`qtyOriginal` now equals `file.copies` (default 1 when missing / zero /
NaN) — no multiplication by `job.quantity`. Lovable's original spec
(`job.quantity × file.copies`) was empirically wrong: live testing
against POS-539M6D (`job.quantity=5`, three files with `copies=1+1+3`
summing to 5; customer ordered 5 total prints) showed the spec
inflated `qtyOriginal` 5× across the order (25 instead of 5). In
practice `file.copies` IS the per-file print count for the whole
order; `job.quantity` is the expected total (sum-of-copies should
match it, loose contract — not asserted) and is informational only,
not a multiplier. Existing sidecars are not migrated (no-migration
contract from M3) — operator-affected jobs may need manual sidecar
edits, or dismiss-and-re-flow, for accurate Total Prints display.

### Added — S3 Artwork Channel (M1 + M2)

Second ingestion channel for jobs whose artwork arrives via the OrderHub API
(`/ohd-api/pending-jobs`'s `artwork_files[]`), sitting alongside the existing
Pixfizz FTP pull. FTP is **not** retired — the two channels are permanent and
parallel, and can co-exist on the same job (operator-uploaded replacement
files on Pixfizz jobs). See `OHD_S3ArtworkChannel_ClaudeCode_Brief.md`.

- **M1 — S3 downloader + canonical disk layout** (`s3-artwork-downloader.js`):
  per-job, idempotent download of `artwork_files[]` over native `https`,
  bounded at 4-parallel, `.tmp`-then-rename atomic writes, orphan-`.tmp`
  sweep on every call. Diffs against the sidecar's job-level
  `s3ArtworkFileIdsKnown` array so re-polls don't re-download. Sidecar
  filename follows the codebase-wide `${order_number}_${job_id}.json`
  convention; reads existing or builds in-memory and persists only after a
  download succeeds, so the polling loop's `checkLocalFiles` never sees a
  bait sidecar and never fires `markReceived` on a folder with zero
  artwork. 4xx response bodies (S3 / Supabase XML or JSON error envelopes
  like `AccessDenied`, `RequestExpired`, signature mismatches) are
  captured up to ~500 bytes and surfaced as a `[s3-artwork] 4xx response
  body` WARN line, keyed by id never URL.
- **Sidecar schema** (`jobSchema.js`, `sidecarManager.js`): per-image
  entries gain `artworkFileId`, `artworkSource`, `artworkType`,
  `productionReady`, `originalFileName` (null defaults for FTP-delivered
  entries); job-level gains `s3ArtworkFileIdsKnown[]`. Legacy sidecars are
  hydrated to defaults on read (in memory only — no spurious disk write).
- **M2 — Per-job auto-print hold + UI chip** (`shared/holdForReview.js`,
  `job-service.js`, `ipc-handlers.js`, renderer): jobs with manual
  artwork or non-finalised files are skipped by the **auto-print**
  dispatcher; operator Send-to-Print remains unaffected. Yellow "Manual —
  review required" chip on the job-list row with a tooltip listing every
  reason that triggered the hold (`manual-source`, `manual-file`,
  `not-finalised`). Per-file `Manual`/`Pixfizz` tag in the Job Review
  thumbnail grid — only on the file(s) whose source differs from the
  job-level source, so uniform-source jobs stay uncluttered.
- **Order-level manifest write** (`s3-artwork-downloader.js`): the M1
  downloader now writes `{order_number}.json` at the order-folder root
  (byte-shape parity with Pixfizz's FTP-delivered manifest), so the
  print-service dispatch pipeline can read which files belong to which
  job. Without this, S3-delivered jobs threw "Order manifest not found"
  on dispatch. Idempotent + multi-job-merge-aware. One-shot recovery
  script `scripts/rebuild-missing-manifests.js` retroactively writes the
  manifest for existing job folders that pre-date the fix.

**Known caveat — size field:** the M1 manifest leaves
`jobs[].images[].size` as `null` because OrderHub's `/pending-jobs`
doesn't expose a print-size string and we declined to derive it from
`product_code` or `job.options`. **S3-delivered manual jobs routed
through DPOF or Darkroom Pro controllers will throw a "size is missing
on one or more images" error until OrderHub exposes a `print_size`
field**; `folder_copy` controllers (which ignore size) dispatch cleanly.

### Fixed — M2 hold-rule narrowing (2026-05-24)

The M2 auto-print hold gate (`src/shared/holdForReview.js`) previously
fired on any `artwork_files[i].production_ready === false`. In practice
OrderHub returns `production_ready: false` as a **default state** on
Pixfizz-source files (artwork_type `pages` / `text` etc.), so every
Pixfizz order in the queue surfaced a spurious "MANUAL — REVIEW
REQUIRED" chip and was held from auto-print. Field evidence:
PXDEMO-YUED5N-1, PXDEMO-6M49PK-1, PXDEMO-AUXZWJ-1.

The clause was redundant — the scenario it was meant to catch (operator
started a manual replacement upload not yet finalised) is already
covered by the `manual-file` reason. The clause is removed; hold now
fires solely on manual *source* (job-level or per-file). The
`production_ready` field is **not** removed from the data model —
sidecars still persist it per image (M1), and M3 will surface "Not
finalised" as a per-file display chip in Job Review, not as an
auto-print hold reason.

### Fixed — AI scoring "stuck" on M2-held jobs (2026-05-24)

The M2 hold gate was originally placed BEFORE the AI Quality block in
`runAutoPrint`, so held jobs short-circuited before `scoreJob` ran. The
renderer chip stayed on "AI scoring…" indefinitely because
`sidecar.aiQuality.scored` never flipped to `true`. Moved the hold check
to AFTER the AI Quality block: scoring runs for every job that has files
on disk, dispatch is still skipped on the hold reason.

### Fixed — `_upsertOrderManifest` overwriting FTP-delivered manifests (2026-05-24)

When a Pixfizz job's `/pending-jobs` response includes a non-empty
`artwork_files[]`, the M1 downloader engages and (post-M2.1) calls
`_upsertOrderManifest` — which previously wholesale-replaced the
existing FTP-delivered job entry with a sidecar-derived reconstruction
(`size: null`, image list scoped to the S3 sidecar). On PXDEMO-AUXZWJ
this would have destroyed the 40-image / `size: "4x6"` manifest the
moment OHD restarted. The helper now sniffs the existing entry's shape:
if any image has a non-null `size`, the entry is treated as
FTP-authoritative and preserved verbatim. OHD-written entries (all
sizes null) continue to update normally so file additions between
polls reach the manifest. Heuristic limitation: collapses if OrderHub
later populates `print_size` for OHD writes — switch to a `__writer`
marker or merge-by-image strategy at that point.

### Added — M3 (quantity math + production_ready display chip)

- **Quantity math** (`src/main/services/s3-artwork-downloader.js`,
  `src/shared/jobSchema.js`): on first import of an S3-delivered file,
  `qtyOriginal = job.quantity × file.copies` (each factor defaults to
  `1` when missing / non-positive, so a malformed API payload degrades
  to "single copy" rather than NaN). The API's `copies` value is
  persisted per-image so the renderer can show a "×N copies" chip
  alongside the filename. FTP-delivered entries keep today's
  `qtyOriginal = job.quantity` behaviour (copies implied as 1) — the
  copies math fires only through the S3 entry-creation path.
- **"Not finalised" display chip**
  (`src/renderer/views/JobReview/ThumbnailCard.jsx`,
  `src/renderer/job-review.css`): per-file amber chip on the filename
  strip below the thumbnail when `productionReady === false`. Renders
  alongside the M2 source tag (max 3 chips per row: source / "Not
  finalised" / "×N copies"). Informational only — the auto-print hold
  rule no longer cares about `production_ready` (see the 2026-05-24
  hold-rule narrowing fix above). `productionReady === null` (legacy /
  FTP-delivered entries) and `=== true` both suppress.
- **Job-level "Qty: N" chip**
  (`src/renderer/views/JobReview/index.jsx`): small neutral chip in the
  drawer top-bar meta block. Distinct from the existing per-card
  top-right `×{qty}` operator-mod indicator — this is the
  job-wide fan-out multiplier, not a per-file override.

**No migration of existing sidecars.** The quantity math runs only
inside `_buildImageEntry`, which is invoked exclusively on FIRST import
of a file (the call site is gated by the `s3ArtworkFileIdsKnown`
diff). On re-poll, known file ids skip `_buildImageEntry` entirely, so
every pre-M3 entry (POS-EFZ9UK, PXDEMO-AUXZWJ, every job downloaded
between M1 and M3) keeps its existing `qtyOriginal`. A no-migration
guard test in `s3-artwork-downloader.test.js` pins the contract: a
future refactor that re-introduces silent migration would fail it with
the message "existing entry recomputed despite known id in
`s3ArtworkFileIdsKnown`". Schema-level hydration (`sidecarManager.js`
Reconcile C) adds the new `copies` key in-memory only — never touches
disk — preserving the same "no spurious save" contract that governs
the M1 S3 fields.

### Fixed — M3 "Not finalised" chip narrowed to manual-source files (2026-05-24)

Tightened the M3 "Not finalised" chip in `ThumbnailCard.jsx` to fire only
when `artworkSource === 'manual' && productionReady === false`.
Pixfizz-source files (and legacy/null-source files) with
`production_ready: false` no longer show the chip — `production_ready: false`
is OrderHub's default state for non-manual file types (e.g.
book-thumbnails on a photo book order) where there's no operator
finalisation workflow, so the chip carried no actionable meaning there.
Mirrors the same logic as the M2 hold-rule narrowing — both warning
surfaces now agree that `production_ready` is a manual-source concept.

### Fixed — S3 downloader filters `artwork_files[]` to manual source (2026-05-24)

The S3 downloader now skips any `artwork_files[i]` entry whose
`source !== 'manual'`. For Pixfizz orders the real print artwork arrives
via FTP; anything else that appears in `artwork_files[]` is reference /
preview material (e.g. `book-56931977-thumbnails` on a Pixfizz photo
book, served from `/v1/pages/…?height=400`) that we should never have
been downloading. Surfaced by PXDEMO-YUED5N-1 where the
book-thumbnails file appeared as image 1 of 41 in the Job Review queue
and inflated Total Prints from 40 to 80.

This is the **third manifestation of the same source-based gating
pattern** in M2 / M3:
1. M2 hold-rule narrowing — hold fires on manual source only;
   `production_ready: false` on Pixfizz-source files is the API's
   default state, not a hold reason.
2. M3 chip narrowing — the "Not finalised" chip fires only when
   `artworkSource === 'manual'`.
3. **(this fix)** The downloader follows the same rule. All three
   surfaces — hold gate, display chip, ingest — now agree:
   `production_ready` and pixfizz-source are not operator-actionable on
   the S3 channel.

Logged as `[s3-artwork] skipped non-manual file` with file id /
file_name / source / artwork_type for audit. Existing sidecar entries
created before this filter shipped are NOT auto-cleaned (the same
no-migration contract as M3). To remove a stale entry on a previously-
affected job, dismiss the order from the queue and re-flow it, or
manually edit the sidecar to drop the entry — operator action, not
automatic.

### Added — M4 (`artwork_type: 'original'` → Customer Originals plumbing) (2026-05-25)

Customer Originals Phase 1+2 UI automatically activates for S3-delivered
manual jobs that include `artwork_type: 'original'` files alongside an
optimized/manipulated sibling.

- **Sub-folder routing** (`src/main/services/s3-artwork-downloader.js`):
  `artwork_files[]` entries with `artwork_type === 'original'` now land
  under `{jobPath}/original-files/` instead of the flat job folder — the
  same path Pixfizz Customer Originals Phase 1+2 already reads via the
  manifest's lowercase-N `originalFilename` field. Only the literal
  string `'original'` triggers the route; unknown `artwork_type` values
  (`'pages'`, `'text'`, …) keep landing flat. The subfolder is lazy-
  created on first need, so manual jobs with only optimized/manipulated
  files don't clutter disk with an empty subfolder. Orphan `.tmp` sweep
  extends to `original-files/` too. Originals are NOT added to
  `sidecar.images[]` (no entry, no manifest row) — Customer Originals
  references them only via a sibling's `originalFilename`, matching the
  Pixfizz FTP convention so `_scanJobImages`, AI scoring, and the print
  dispatcher all stay scoped to printable JPEGs. The id IS tracked in
  `s3ArtworkFileIdsKnown` so re-polls don't re-download.
- **Conservative single-sibling back-fill**: after every poll, each
  completed original (fresh-downloaded OR self-healed from disk) is
  matched against `sidecar.images[]` + the entries built this poll. A
  candidate is a non-original entry whose API `originalFileName`
  (capital F-N) matches the original's `file_name` AND whose lowercase-N
  `originalFilename` is still empty. **Exactly one** match → sibling's
  `originalFilename` is back-filled to
  `{jobFolderName}/original-files/{diskName}` (manifest-relative
  verbatim). **0 or 2+ matches** → silent degrade, no back-fill (file
  preserved on disk; Customer Originals UI simply doesn't activate for
  that entry). First-write-wins on `originalFilename`: a value already
  set by a prior poll OR an FTP manifest's first load is never
  clobbered.
- **Manifest pass-through** (no change required): `_upsertOrderManifest`
  already serialises `img.originalFilename || null` per row, so once the
  sibling is back-filled in-memory, the order-level
  `{order_number}.json` carries the manifest-relative path verbatim.
  `_buildManifestImageMetaMap` in `ipc-handlers.js` picks it up on the
  next `ohd:job:load` and surfaces it to the renderer — Customer
  Originals Phase 1+2 (thumbnail, "Open original", "Show in folder",
  Phase 2 source-toggle re-crop) lights up with zero renderer changes.

**Casing trap.** `originalFileName` (capital F-N, S3-channel field, API's
`file_name` verbatim) and `originalFilename` (lowercase n, Customer
Originals field, manifest-relative path) are unrelated concepts that
differ only by capitalisation. The back-fill MATCHES on the capital-N
field, WRITES to the lowercase-n field. Documented in
`s3-artwork-downloader.js` and locked by the "collision-renamed sibling
— back-fill still matches via originalFileName" test, which would fail
if the casing was ever mixed up.

**Known limitation — late-arriving siblings.** When an original arrives
in poll N but its optimized counterpart doesn't appear until poll N+1,
the back-fill misses (the original is already in `s3ArtworkFileIdsKnown`
and isn't revisited). The sibling's `originalFilename` stays null; the
file is still on disk and visible via Explorer, just no Customer
Originals thumbnail. Conservative-by-design — solving this would
require a `s3OriginalsKnown[{id, diskName}]` job-level array; deferred
until field evidence shows it's worth the schema bump.

### Fixed — Job Review grid columns no longer stretch on long filenames (2026-05-24)

`src/renderer/job-review.css` — `.jr-grid-scroll`'s
`grid-template-columns` changed from `repeat(3, 1fr)` to
`repeat(3, minmax(0, 1fr))`. Grid items default to `min-width: auto`,
which makes columns grow to fit their content's intrinsic minimum size.
After M2 added the filename label strip below the canvas, long
filenames (~55 chars on Pixfizz page files) forced the columns wider
than 1fr. The card stretched with them but the canvas stayed locked at
its fixed `width="128"` backing-store attribute — producing the
"small image on the left, huge empty whitespace on the right" symptom.
`minmax(0, 1fr)` sets the column minimum to 0 explicitly, so filename
text ellipsis-truncates (already configured on `.jr-card__filename`)
instead of pushing the column wider. Net effect: the canvas fills the
card again as it did pre-M2.

Out of scope for this release: M4 (`artwork_type: 'original'` →
Customer Originals plumbing). Deferred to a future milestone.

## v1.6.0 - 2026-05-13

### Added — Order XML Hot Folder (Mode 4)

New ingestion path that watches local folders for vendor order XML drops and
submits them to OrderHub via POST /api-webhook. Two formats ship: PhotoFinale
(Trevoli OrderDataSet) and ROES (Pixfizz XML). The parser layer is a registry,
so future formats are a one-file change.

- **PhotoFinale parser** — maps Trevoli OrderDataSet → OrderHub. Composite
  order_number `XML-<idOrder>-<ExternalId>`. Rejects orders referencing
  PhotoFinale-deleted products with a clear "Re-issue in PhotoFinale" message.
- **ROES parser** — maps Pixfizz XML → OrderHub. Composite order_number
  `XML-<idOrder>`. Sums `Quantity × UnitPrice` to `total_amount`. Drives
  `paid` from `<PaymentStatus>`.
- **Product Mappings table** — per source format. Operators map vendor codes
  to Pixfizz product codes; OrderHub receives the Pixfizz code + label instead
  of the raw vendor SKU. Failed orders get a one-click "Add Mapping" action.
- **Auto-confirm** — successful submissions automatically advance from
  `pending` to `confirmed` via `/update-order-status`.
- **Order XML panel** — in-app history of every ingestion (last 30 days),
  with filter, search, retry-failed, and open-folder actions.
- **Multi-folder watcher** — each hot folder runs an independent chokidar
  instance with its own retry queue and 1-minute polling tick.

See `docs/order-xml-hotfolder.md` for the operator-facing reference.

## v1.5.0 - 2026-05-04

### Added — AI Fix-up Service (auto-enhancement on quality-gate failure)

A new opt-in path that auto-enhances quality-gate-failing images before holding the job for the operator. Sister of `enhancementManager.js` — both reach the same provider clients (`localClient`, `topazClient`) and produce the same per-image sidecar shape, but this service is invoked by `ai-job-quality-orchestrator.js` when an image fails the gate and `enhancementAutoEnhance === true`.

- **New module** `src/main/services/ai-fixup-service.js` — quality-gate-triggered enhancement path. Goes direct to the provider client (bypassing `enhancementManager`) so there's no ambiguity over which write wins on the sidecar. Records `triggeredBy: 'quality-gate'` for audit.
- **`fixupHistory` on the sidecar** — every fix-up attempt is appended to `aiQuality.fixupHistory[]` so the audit trail is complete even when enhancement or rescore fails.
- **Graceful failure** — enhancement throw → no working-file mutation, history entry only; rescore throw → `afterScore: null`, `aiQuality.score` keeps pre-enhance value, job remains held for operator review.
- **Orchestrator decides** — the service returns `{ beforeScore, afterScore, crossedThreshold, provider, model, … }` and lets the orchestrator make held-vs-routed decisions.

### Added — File integrity check on FTP download

Synchronous magic-byte validation for every downloaded JPEG/PNG, catching the sparse-allocated leading-zero files produced when an upstream upload is interrupted but the size matches a cached header.

- **New module** `src/main/services/file-integrity.js` — JPEG (`FF D8 FF`) and PNG (`89 50 4E 47 0D 0A 1A 0A`) magic-byte validation. Synchronous on purpose to keep the FTP download loop tight.
- **"Flag and allow" model** — corrupt files keep their original extension and get an `integritySuspect` block on the per-image sidecar, instead of being renamed to `.quarantine`. The print pipeline still routes them; operators decide.

### Added — One-shot migration for the v1.3.2 integrity-quarantine pivot

`src/main/services/integrity-quarantine-migration.js` walks `downloadDirectory` on first launch, renames every legacy `*.quarantine` file back to its original extension, stamps `integritySuspect` on the matching sidecar entry from the manifest, and archives `_ohd-quarantine.json` → `_ohd-quarantine.archived.json`. Idempotent — `_integrityQuarantineMigratedAt` config flag prevents re-runs. Only does work on installs that ran v1.3.0 or v1.3.1.

### Added — Pixfizz AI Enhancement (Real-ESRGAN, local provider)

Replaces the Replicate cloud enhancement with a local Real-ESRGAN model running in the inference utility process. Existing Replicate users are silently migrated.

- **New `local` provider** — `enhancementProvider: 'local'` runs Real-ESRGAN in-process. Topaz remains available as `'topaz'`.
- **New modules** — `src/main/enhancement/localClient.js` (provider client, tile loop), `src/main/services/ai-inference-models/realesrgan-loader.js` (ONNX session), `src/main/services/ai-inference-models/realesrgan-preprocessor.js` (HWC RGB tensor prep).
- **New IPC handler** — `inference:tile` on the inference host, validates `modelId`, `tileBuffer`, `tileW`, `tileH`; rejects with `BAD_INPUT` / `MODEL_NOT_LOADED` on shape mismatch or missing loader.
- **`localJobs` tracking** — synthetic `local_<ts>_<rand>` IDs run the same status/cancel/sidecar plumbing as `topaz_*` IDs.
- **`validateApiKey('local')`** — returns valid iff the inference host reports `hasModel('realesrgan')`. No API key required for the local provider.

### Changed — Replicate provider removed

- `src/main/enhancement/replicateClient.js` deleted.
- Config migration: any stored `enhancementProvider: 'replicate'` is silently rewritten to `'local'` on first launch (`config-service-replicate-migration.test.js` covers the path).
- Default `enhancementProvider` is `'local'` for fresh installs.

### Changed — Darkroom Pro: strict media resolution (no raw-value fallback)

`resolveMedia` no longer falls back to the raw option value when no translation is configured. A missing translation now surfaces as **Assign** in the routing UI rather than dispatching with an unmapped media token. Save-time guards block translations-without-`mediaOptionKey` misconfig. `config.json` is now dead — `routing.json` is the canonical source for media translations.

### Changed — Updater check-in gated on `pollingEnabled`

`_checkIn` in `src/main/updater.js` returns early when `configService.get('pollingEnabled') === false`. Upload-only PCs (used in multi-PC site deployments where one PC polls and others upload) no longer register as online OHD instances. They still receive auto-updates because electron-updater operates independently — the change only affects whether the instance appears in the OH dashboard.

### Removed

- `src/main/services/dpi-validator.js` and `scripts/test-dpi-validation.js` — superseded by the AI Quality Gate. DPI is now expressed through the gate's score rather than a hard pass/fail.
- `src/main/enhancement/replicateClient.js` — see above.

### Files added
- `src/main/services/ai-fixup-service.js`
- `src/main/services/file-integrity.js`
- `src/main/services/integrity-quarantine-migration.js`
- `src/main/enhancement/localClient.js`
- `src/main/services/ai-inference-models/realesrgan-loader.js`
- `src/main/services/ai-inference-models/realesrgan-preprocessor.js`
- `src/main/services/ai-inference-models/musiq-preprocessor.js`
- `THIRD_PARTY_LICENSES.md` — Apache-2.0 / BSD-3-Clause attribution for bundled ONNX models, shipped via `electron-builder.yml extraResources`.
- Test suites under `src/main/services/__tests__/`, `src/main/services/ai-inference-models/__tests__/`, and `src/main/enhancement/__tests__/` (122 tests total, run via `npm test`).

### Files removed
- `src/main/services/dpi-validator.js`
- `src/main/enhancement/replicateClient.js`
- `scripts/test-dpi-validation.js`

## v1.3.x — versions shipped between 1.2.0 and 1.4.0

These point releases were built and shipped (installers exist in `dist/`) but never received per-version CHANGELOG entries. Documented retroactively for completeness:

- **v1.3.0 / v1.3.1** — initial integrity-quarantine model: corrupt downloads renamed to `*.quarantine` with diagnostic data in `_ohd-quarantine.json`. Hid suspect files from the print pipeline. Replaced by the "flag and allow" model in v1.3.2.
- **v1.3.2** — pivot to "flag and allow": files keep their original extension and an `integritySuspect` block lands on the per-image sidecar. The v1.5.0 migration brings forward any artifacts left behind from v1.3.0 / v1.3.1.
- **v1.3.3** — point fixes (no detailed notes recorded).

## v1.4.0 - 2026-04-30

### Changed — Darkroom Pro output format

- **`ExtOrderNum` and `Orderid` now emit the per-job filename stem** (e.g. `PXDEMO-D4LNF6-1`) rather than the order-level `order_number`. The value inside the file now matches the `.txt` filename and uniquely identifies each job within a multi-job order. Falls back to `order_number` for back-compat.
- **One complete block per image.** The emitter now writes a full `Qty/Size/Media/Date/Orderid` (+ optional photo lines) + `Filepath=` block for every image rather than grouping multiple images of the same `Qty` into a single block. Repetition is intentional — it removes any ambiguity about which `Qty` applies to which image and lets per-photo qty (e.g. one image at qty 2, another at qty 3) work cleanly without sticky-field semantics.
- **Removed legacy hard-coded `Photo.First Name` / `Photo.Last Name` lines** from each block (replaced by the configurable Photo Lines feature below).

### Added — Configurable Photo Lines (Darkroom Pro)

Operators can now configure up to two free-form key/value lines that get inserted between `Orderid=` and `Filepath=` in every per-image block. Typical use case: writing back-print details on the reverse of each photo.

- **Controller modal — Photo Lines section** between OrderLastName Format and Size Translations. Each row has a free-text Darkroom field name on the left (e.g. `Photo.First Name` — vendor-specific, varies per Darkroom Pro setup) and an OHD template string on the right (e.g. `{filename}` or `{lastName}-{filename}`). Maximum 2 rows.
- **Token reference panel** below the rows with click-to-copy chips for every supported token: `{customerName}`, `{firstName}`, `{lastName}`, `{jobId}`, `{orderNumber}`, `{jobName}`, `{filename}`. Click any chip to copy the literal token to the clipboard.
- **Default seed for new controllers** — two rows pre-populated as `Photo.First Name = {filename}` and `Photo.Last Name = {lastName}`, matching the legacy hard-coded format that was removed. Existing Darkroom Pro setups keep working out of the box on next save; operators can edit, remove, or replace either row.
- **Shared template-tokens helper** — `src/main/services/template-tokens.js` extracted from `frontline-generator.js` so Darkroom Pro photo lines and Frontline back-prints use the same `{token}` resolver. Adds `{firstName}` and `{lastName}` to the existing token set.

### Added
- **AI Quality Gate — "Hold auto-print on quality failure" toggle.** New checkbox in the AI Quality Gate settings panel that maps to the existing `aiQualityMode` config field (`'block'` when ON, `'warn'` when OFF). Default `'warn'` is preserved on upgrade.

### Changed — Product rebranded "OrderHub Downloader" → "OrderHub Desktop"

Display-only rename. Window title, header, tray tooltip, tray menu, signed-binary description, and all docs now read "OrderHub Desktop". Machine identifiers are intentionally unchanged so existing installs keep their data and continue receiving auto-updates:

- `electron-builder.yml` `productName: OrderHub Downloader` and `appId: com.orderhub.downloader` stay as-is. This means `%APPDATA%/OrderHub Downloader/` keeps holding `config.json`, `jobs.json`, `frame-metadata.json`, `film-review-prefs.json`, `app-prefs.json`, and `logs/` for installed users.
- The installer file is still `dist\OrderHub Downloader Setup x.x.x.exe` and the Add/Remove Programs entry still reads "OrderHub Downloader" — that's the controlled trade-off for data continuity.
- Internal acronym `OHD` is unchanged across code and doc filenames; it now reads as "OrderHub Desktop" rather than "OrderHub Downloader".

### Added — App-wide theming with light/dark toggle

A unified design-token system across all three styling surfaces (legacy renderer, Job Review panel, Film Review panel) plus a single header toggle that drives the whole app.

- **`--app-*` design tokens.** `src/renderer/styles.css` now defines a token set on `body` (surfaces, ink, borders, accent, brand-green, status semantics, AI purple) with a single-class swap to `body.app-theme-dark` for the dark variant. Both `film-review.css` (existing `--fr-*` tokens) and the new `job-review.css` alias from these app-wide tokens, so the three styling surfaces stay coherent.
- **Pixfizz blue is the canonical accent.** The 28 occurrences of Pixfizz teal `#1e7b8f` across the legacy UI (tab-active, focus rings, links, primary buttons) all map to `var(--app-accent)` — the brighter Pixfizz blue (#32C5FF) Film Review already used. Visible change: the Jobs tab indicator, focus rings on inputs, and primary action buttons are now blue rather than teal.
- **Theme toggle in the app header.** Sun/moon glyph button next to the version label; click to switch the whole app. Persisted via a new `app-prefs-store.js` (electron-store, file `app-prefs.json`) and IPC pair `ohd:app:get-theme` / `ohd:app:set-theme`. Both panels and the legacy surfaces respond to the same `body.app-theme-dark` class.
- **Job Review panel converted from inline styles to CSS classes.** All six React components (`JobReview/index.jsx`, `ControlPanel.jsx`, `ThumbnailGrid.jsx`, `ThumbnailCard.jsx`, `CMYSliders.jsx`, `CropEditor.jsx`) lifted their inline `style={{...}}` blocks to a new `src/renderer/job-review.css` with `jr-*` selectors consuming `--app-*` tokens. The eight palette JS-constants (`BG_DEEP`, `BG_PANEL`, `BRAND_GREEN`, etc.) are gone. Job Review now renders correctly in both themes; previously it was inline dark blue/grey only.
- **Crop editor preserves the photo-darkroom backdrop.** The crop overlay's dark backdrop (`rgba(10, 18, 24, 0.95)`) stays in both themes — operators are evaluating an image, and a dark backdrop reduces eye strain. To keep the cancel/apply buttons readable in light theme, the overlay re-asserts dark-theme `--app-*` token values inside its own scope, mirroring Film Review's `.fr-focus-overlay` convention.
- **Dark-mode "ink" flip for accent badges.** In dark mode, `--app-accent-ink` is aliased to `var(--app-accent)` so the `(weak fill, ink text)` pattern reads in both themes. Fixes badge-pending, badge-pending_download, status-message.info, the download-progress spinner, and the Activity Log INFO badge — all of which previously had unreadable dark-navy-on-dark in dark mode.

### Changed
- `styles.css` tokenized: 386 hex literals → 70 (the 70 remaining are intentional — token defs themselves, white text on filled-color buttons, the update-banner branded colors, the deprecated-callout yellow scheme, and the Windows close-button hover convention).
- Film Review's panel-local theme toggle removed; the `theme` field stays in the persisted `film-review-prefs.json` shape for back-compat but is no longer read.
- Five descendant selectors in `film-review.css` (`.fr-roll-card__status--processing`, `.fr-focus-backdrop`, `.fr-focus-rotate-badge`, `.fr-focus-pill--accent`, `.fr-focus-flag-pill strong`) now look at `body.app-theme-dark .fr-…` instead of the panel-local `.film-review-theme-dark` class.

### Files added
- `src/renderer/job-review.css` — Job Review styling.
- `src/main/services/app-prefs-store.js` — app-wide UI prefs (currently just `theme`).

## v1.2.0 - 2026-04-26

### Added — AI Quality Gate (M1+M2)

A new opt-in pipeline that scores every image in every Mode-1 job before
dispatch and holds jobs whose images fall below an operator-configurable
quality threshold. **Default OFF** — existing labs see no behaviour change
until the operator explicitly enables it.

- **Settings UI**: new "AI Quality Gate" section under Settings → Film Scans
  with an Enable checkbox, threshold input (default 75), guidance text, and
  a verbose-logging toggle.
- **Backend services**:
  - `ai-quality-service.js` — single chokepoint between callers and the
    inference host. Honours the feature flag and the `aiQualityForceScore`
    debug knob; fails open (treats inference failures as "pass") so
    infrastructure issues never block routing.
  - `ai-quality-store.js` — sidecar wrapper for the per-image `aiQuality`
    block (score, threshold, passed, fixupHistory, operatorDecision).
    Upserts entries for jobs whose sidecars don't already list images.
  - `ai-job-quality-orchestrator.js` — job-level scoring + held-state
    derivation. Scans the job folder directly for image files (covers both
    Mode-1 jobs at root level and Job-Review-touched jobs in `/working/`).
- **Pipeline gate**: `runAutoPrint` and the manual "Process" IPC handler
  now call the orchestrator before dispatch. Held jobs are skipped this
  pass; releasing the operator override clears the hold.
- **Jobs grid Quality flag**: a red `⚠ N/M` badge appears in the FLAGS
  column for held jobs. Clicking the badge opens a confirm dialog and,
  on approval, marks every failed image `approved_as_is` so the job
  routes on the next pass.
- **IPC API**: `aiQuality.listHeldJobs`, `getJobQuality`, `releaseJob`,
  `approveImage`, plus an `aiQuality:jobHeld` push event for live UI
  updates.
- **Inference host**: `musiq-loader.js` registered alongside
  `orientation-loader.js`. The MUSIQ ONNX model is *not* bundled yet —
  when it's added at `resources/models/musiq/model.onnx`, real scoring
  starts automatically. Until then, scoring returns 100 (always pass)
  and the feature is effectively a no-op even when enabled.

### Out of scope for v1.2.0 (deferred to v1.3.0+)

- The MUSIQ model itself (Phase 1 ships the operator workflow
  independent of the model-quality decision).
- The dedicated Quality Review tab (M3) — released held-jobs use the
  Jobs-grid badge for now.
- Fixup actions (M4) — operators can release-as-is or skip; FBCNN /
  Real-ESRGAN come later.

## v1.1.1 - 2026-04-26

### Changed — ONNX inference moved to a dedicated utility process
- **AI inference host** (`src/main/services/ai-inference-host.js`,
  `src/main/services/ai-inference-client.js`,
  `src/main/services/ai-inference-models/orientation-loader.js`).
  The orientation model now loads and runs inside an Electron
  `utilityProcess`, not the main Node process. Prediction results,
  rotation behaviour, Film Review Panel display, and config schema are
  unchanged from v1.1.0 — verified by parity check against historical
  log timings (~870ms median per frame on the same hardware before and
  after the move). The benefit is forward-looking: a future AI feature
  (Quality Gate) cannot starve FTP polling, S3 uploads, or the renderer
  by running long inferences, because they share this single host.
- **Crash recovery.** If the inference host crashes once, it is
  auto-restarted after a 250ms delay. A second crash within 30 seconds
  trips a session-level kill-switch — AI features become unavailable
  until OHD is restarted, but the rest of OHD continues running normally.
- **Graceful shutdown.** `app.before-quit` now sends a typed shutdown
  message to the host with a 2-second grace window before the host is
  killed. No orphan utility-process leaks on quit.

### Fixed
- (electron-builder) `win.sign` moved under `win.signtoolOptions.sign`
  to match electron-builder v26's renamed schema.

## v1.1.0 - 2026-04-26

### Added — Film Scan Auto-Rotation (PW-007)
- **AI auto-rotation for film scans.** A bundled ONNX orientation model
  (EfficientNetV2-S) runs locally on every frame in a scanned roll before
  it's uploaded to S3, applying the predicted rotation in-place to both
  the source TIFF and the JPEG sibling. Configurable per-location confidence
  threshold (default 0.75). Works for both TIFF and JPG roll inputs.
- **Film Review panel** (new "Film" tab). Lists every roll the watcher has
  processed with frame-level confidence stats, low-confidence counts, and
  rotation-error counts. Click into a roll to see a thumbnail grid; click a
  thumbnail for the full FocusedFrame view with manual rotate controls
  (R/L hotkeys or arrow keys).
- **Three review modes** (Settings → Film Scans → Review Mode):
  - **Auto** — every roll uploads to S3 immediately after AI rotation.
  - **Smart Check** — rolls auto-upload unless they contain a
    low-confidence frame or a rotation error, in which case they wait in
    the panel for operator approval. Productivity middle ground.
  - **Manual Check** — every roll waits for operator approval before upload.
- **Provisional roll cards.** Detected-but-not-yet-processed rolls show as
  inert "Watching" / "Processing" cards in the Film tab so operators can
  see their scan is queued.
- **Roll-list auto-refresh during upload.** The Film tab updates badges
  live as rolls move through Uploading → Uploaded (or Upload failed)
  without manual navigation.
- **Auto-retry on transient upload failures.** Per-file retry inside the
  S3 service (3 attempts, 2s/5s backoff) catches single-file blips like
  socket-hangup; a per-roll retry (3 attempts, 30s/90s backoff) catches
  whole-batch network failures. Operators only see UPLOAD FAILED after
  both layers exhaust.

### Fixed
- **EPERM rename failures on Synology / SMB shares** during AI rotation.
  Disabled the libvips operation cache (`sharp.cache(false)` at startup)
  which was retaining JPG file descriptors and causing the rename of the
  `.rot.tmp` file to fail deterministically on the same filenames. The
  rotation pipeline also retries the rename up to 10 times with capped
  exponential backoff (~22s patience), then falls back to an explicit
  unlink + rename, before giving up. Only EPERM/EBUSY/EACCES/ENOTEMPTY
  are retried — real bugs like ENOENT still fail fast.

### Added — New output controllers
- **Frontline output controller.** New print path targeting Fujifilm Frontline
  hot folders. Each job is written as a per-job folder containing a
  `{jobId}.xml` order file plus all sibling images; Frontline consumes the
  folder and removes it after processing (`removeAfterProcess="true"`).
  Configurable per-controller `batchCode`, `sortString`, and back-print
  templates (`backPrint1` / `backPrint2`) with `{customerName}`, `{jobId}`,
  `{orderNumber}`, `{jobName}`, `{filename}` tokens.
- **Darkroom Pro output controller.** New print path that writes a
  plain-text `{orderRef}.txt` order file (Windows CRLF) into Darkroom Pro's
  hot folder. Resolves print size from per-controller `sizeTranslations`
  and media from `mediaOptionKey` + `mediaTranslations`.

### Added — Job Review crop editor
- **CropEditor** (`src/renderer/views/JobReview/CropEditor.jsx`).
  Full-screen interactive crop tool on the Job Review screen, replacing
  the prior static crop-box display. Aspect-ratio is locked from the
  channel mapping; corner-handle resize, interior drag-to-move, rule-of-
  thirds grid, and live size label. The crop rectangle is tracked in
  image-space pixels and passed straight to Sharp by the IPC handler —
  no client-side rescaling.

## v1.0.9 - 2026-04-25

### Added
- "Check Order Status" boolean field on Order Controllers (Epson, Noritsu, DPOF,
  Darkroom Pro). When ticked (default), OHD monitors the hot folder for printer
  acceptance/rejection after dispatch as before. When unticked, the job is marked
  as Printed immediately after dispatch — useful for sites where network conditions
  prevent reliable status folder detection.

## v1.0.7 - 2026-03-27

### Fixed
- Jobs whose process type has no controller assigned in Routing are now automatically
  copied to the configured Default Folder (or Process Folder) during auto-print,
  and marked as completed — previously they were silently skipped

## v1.0.6 - 2026-03-25

### Fixed
- Auto-print concurrency guard: concurrent triggers (polling, config save, routing save)
  no longer cause duplicate dispatch attempts that result in "Job folder not found" errors
- Auto-print date range now reads from user config (jobDateRange) instead of being
  hardcoded to 30 days, matching the Jobs tab filter
