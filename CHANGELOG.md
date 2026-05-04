## Unreleased

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
