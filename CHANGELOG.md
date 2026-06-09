## v1.7.7 - 2026-06-04

### Changed: DPOF subfolder renamed IMAGE → IMAGES per spec
The DPOF specification uses "IMAGES" (plural) as the standard subfolder name; OHD was emitting "IMAGE" (singular). Worked on every controller we've tested, but non-spec. Folder name + .mrk IMG SRC path both updated. Existing dispatched folders on disk are self-consistent and don't need rewriting — only future dispatches use the new layout.

## v1.7.6 - 2026-06-04

### Fixed: Noritsu PRT PSL line corrupt when channel mapping uses a numeric size
When a channel mapping's Print Size Code was set to a paper size like "4x6", OHD emitted `PRT PSL=4x6` directly — an invalid Noritsu paper-size code, rejected by the controller. The generator now wraps sizes that look like W×H in the NML -PSIZE syntax Noritsu expects: `PRT PSL=NML -PSIZE "4x6"`. Standard codes (KG, 2L, A4) and operator-pre-formatted NML strings pass through unchanged.

Also: the helper-text under "Print Size Code" in the channel-mapping editor now mentions you can just enter a paper size (4x6, 8x10) instead of the NML -PSIZE syntax — OHD will format it.

## v1.7.5 - 2026-06-04

### Fixed: Noritsu DPOF jobs rejected when USR CID was alphanumeric
Noritsu controllers require the USR CID field in the .mrk file to be numeric, but OHD was emitting the alphanumeric OrderHub job number (e.g. PXDEMO-RW895E). Affected DPOF jobs were rejected silently at the controller. CID now uses the numeric OrderHub job id (e.g. 38459543). Operator-visible CVP1 traceability line is unchanged — still shows the alphanumeric order code for printer-side identification.

## v1.7.4 - 2026-06-04

### Changed: installer + shortcut + uninstall entry now read "OrderHub Desktop"

Customer-facing strings on the installer filename, Start menu / desktop
shortcut, and Add/Remove Programs entry now read "OrderHub Desktop"
instead of "OrderHub Downloader". Aligns with the v1.4.0 UI rebrand and
the existing tray tooltip. Internal `productName` stays "OrderHub
Downloader" so the `%APPDATA%/OrderHub Downloader/` data folder keeps
loading without migration — existing installs upgrade with zero data
loss. The installer wizard pages themselves still display "OrderHub
Downloader" during install (one-time visibility, not worth the
NSIS-include risk to fix).

## v1.7.3 - 2026-06-03

### Changed: installer version stamping

Pure metadata release. Bumps `package.json` to match the tagged release
version so the installer filename (`OrderHub Downloader Setup 1.7.3.exe`)
and Add/Remove Programs entry align with the git tag. No functional
changes from v1.7.2.

## v1.7.2 - 2026-06-03

### Fixed: v1.7.0 installer crashed silently on launch

The v1.7.0 installer built and installed without error but the app
exited within seconds of launch with no log output. Root cause was
asar-packaging corruption — log files in the project root grew during
the build, shifting payload offsets out of sync with the asar header.
v1.7.1 added exclusion patterns to electron-builder.yml so debris
files can't contaminate the asar.

### Fixed: header logo, tray icon, taskbar icon all missing

The `assets/` folder was being implicitly excluded from the asar by
electron-builder's `buildResources` directive. The header logo
(top-left of the window), tray icon, and taskbar / Alt-Tab icon all
fell back to the generic Electron defaults. v1.7.2 explicitly includes
`assets/**` in the packaged asar.

### Distribution note

v1.7.0 and v1.7.1 installers must not be redistributed. v1.7.2 is the
first release where everything in the v1.7 feature set works
end-to-end in production.

## v1.7.0 - 2026-06-03

### New: Manual Crop redesign — per-image-first workflow

When a job arrives without printable artwork (the customer's images
came in uncropped, or you uploaded files manually through OrderHub),
Job Review now opens a redesigned **Manual Crop** mode with a workflow
built around per-image attention rather than batch-defaults-first.

**Layout.**
- **Left rail** — a thumbnail strip listing every image in the job, each
  carrying its own state badge (pending, modified, applying, applied,
  error, discarded). Click any thumb to load it in the stage. Approved
  images stay visible so you can revisit; discarded ones get a red
  border on their rail thumb so you can spot what you cut at a glance.
- **Centre stage** — the selected image with its own crop editor,
  always on. Drag the crop window, rotate, switch Portrait ↔ Landscape,
  approve. Replaces the old "open a modal per image" flow.

**Per-image controls.**
- Crop window aspect-locked to the routed product size.
- Sticky orientation: toggle Portrait ↔ Landscape once and the choice
  persists as you move through the rail for the rest of the session.
- Keyboard shortcuts: `[` / `]` prev / next image, `R` or → rotate 90°
  CW, `L` or ← rotate 90° CCW, Enter / Space to approve and auto-advance
  to the next unapproved image.

**Approve All (bulk action).**
Approves every image that's still pending or has been modified since
its last approval, in one click. Each image is approved at its own
current crop rect — the operator's drag if they adjusted it, the
auto-fit otherwise. Discarded images and already-approved-and-unchanged
images are skipped. Replaces the M5b "Apply Default to All" workflow
which propagated one image's crop to every other image. The new model
respects per-image intent: if you adjusted image 5's rect specifically,
Approve All keeps that adjustment.

**Delete (recoverable).**
Red Delete button on each image marks it as discarded — sidecar grows
a `discarded: true` flag, the thumb gains a red border in the rail,
and the image is excluded from the approval gate, from progress counts,
and from every dispatch path (DPOF, Darkroom Pro, Frontline, Fuji
JobMaker, folder-copy, process-folder). Restore is a pure inverse —
flip the flag back and the image rejoins the queue with its previous
pending state intact. Useful when a customer uploads a stray screenshot
or a duplicate.

**Non-destructive.**
Crops read from `/originals/` — the customer's pre-crop bytes are never
overwritten. Approving an image writes a fresh cropped JPEG to
`/working/` for dispatch. Re-cropping an already-approved image
re-reads the original, not the previous crop, so successive cuts
compound from the source, not from the most recent baked output. Same
model as the Customer Originals re-crop flow (see below).

**Send to Print** gates on every non-discarded image being approved and
unmodified. The button stays disabled until the gate is green, then
dispatches through the normal routing pipeline.

### New: S3 Artwork Channel — second ingestion path

OHD now has a second way to receive artwork, alongside the FTP pull.
Jobs that arrive through the OrderHub API can carry artwork URLs
directly (the new `artwork_files[]` field on `/ohd-api/pending-jobs`),
and OHD downloads those files to the same on-disk layout as
FTP-delivered ones. The two channels are permanent and parallel — FTP
is NOT retired — and a single job can carry files from both sources
(e.g. an operator-uploaded replacement on a Pixfizz job).

Any job carrying *manual* artwork (you uploaded it in OrderHub
yourself, customer hasn't cropped it) is now held back from auto-print
so you can crop and proof it first. A yellow "Manual — review required"
chip appears on the job-list row with a tooltip explaining why.
Operator Send-to-Print still works manually whenever you want to push
the held job through.

Job Review also surfaces a "Not finalised" per-file chip on
manual-source files whose `production_ready` flag is still false —
useful for spotting files that the operator started uploading but
hasn't yet finalised in OrderHub.

### New: Customer Originals

Pixfizz Core ships two copies of every print job — the cropped
printable JPEG, and the customer's pre-crop upload. OHD now surfaces
both.

- See a small thumbnail of the original next to every image in Job
  Review.
- "Open original" opens it in your OS default viewer.
- "Show original in folder" jumps to it in Explorer with the file
  pre-selected.
- The crop editor gains a "Source: customer crop / original" toggle.
  Switching to *original* loads the uncropped upload, locks the aspect
  ratio to your routed product size, and produces a new printable JPEG
  that dispatches through the normal Send-to-Print flow. The customer's
  original printable is preserved alongside — never overwritten.

### New: Order XML Hot Folders (Mode 4)

A fourth ingestion mode for labs that receive orders as XML files from
vendor desktop apps. Configure one or more watch folders under
**Settings → Order XML**, map each vendor product code to the matching
Pixfizz product, and OHD picks up XML drops, submits the order to
OrderHub via `/api-webhook`, and auto-advances it to `confirmed`.

Two formats ship out of the box:
- **PhotoFinale (Trevoli OrderDataSet)** — typical PhotoFinale kiosk
  export. Rejects orders referencing PhotoFinale-deleted products with
  a clear "Re-issue in PhotoFinale" message.
- **ROES (Pixfizz XML)** — the new Pixfizz ROES integration. Sums
  `Quantity × UnitPrice` to `total_amount`; drives `paid` from
  `<PaymentStatus>`.

The new Order XML tab shows the last 30 days of ingestion history with
filter, search, retry-failed, and open-folder actions. Failed orders
carry actionable messages (unmapped product, customer not found) with a
one-click "Add Mapping" action so you can fix and retry without digging
through logs. Multiple hot folders can run in parallel — each with its
own format, retry queue, and 1-minute polling tick.

### New: Backup & Restore

OHD can now back up your non-sensitive configuration to a network share
once per day. Configure the folder once in **Settings → Backup**, and
OHD writes a timestamped snapshot at app launch (if the last successful
run was more than 24 hours ago) and after the first config save of each
day.

After a wipe + reinstall, point OHD at the same share, pick a backup
file from the list, and the lab is back online in one click + a forced
relaunch.

**Not written to the backup:** OrderHub API Key, FTP password, S3
secret access key, Topaz API key. You re-enter those after restore —
by design.

The Order XML customer directory (PII) is included by default and can
be opted out per-lab.

A persistent per-install machine ID detects collisions before two PCs
accidentally share a hostname subfolder on the share (cloned image,
re-used name) and overwrite each other's snapshots.

### New: Fuji JobMaker routing

The Fuji JobMaker controller (the writer + monitor that ship .txt job
tickets to a Fuji print server) now has a full routing path. Assign
Fuji JobMaker as a destination on a process or channel mapping, and
the dispatcher writes the per-job .txt file to the Fuji hot folder
with `surface` and `printCode` populated from the channel mapping.

### New: Customer surname in DPOF folder names

DPOF controllers (Epson, Noritsu) gain an opt-in customer-surname
segment in the output folder name: `o100456_Smith_8x12GLOSS` instead
of `o100456_8x12GLOSS`. Surname is extracted from the customer name
(last whitespace-separated token), NTFS-unsafe characters stripped.
Defaults ON for existing controllers (no visible change until a new
controller is set up).

### Fixed: AI Quality "AI scoring…" stuck on pre-artwork jobs

The "AI scoring…" indicator used to light up on every job that hadn't
yet received artwork — gift vouchers, abandoned walk-in POS orders —
and **the Dismiss button stayed disabled** so operators couldn't
remove them from the grid. Both Process/Assign and Dismiss now
correctly ungate on these rows. Scoring still gates them when actual
scoring is in flight against on-disk artwork.

### Fixed: AI scoring stuck on auto-print-held manual jobs

The S3 channel's auto-print hold check was firing BEFORE the AI Quality
scoring step, so held manual jobs never got scored at all and the
"AI scoring…" indicator stayed on indefinitely. Scoring now runs for
every job that has files on disk; only dispatch is gated by the hold
reason.

### Fixed: Auto-print hold spuriously fired on every Pixfizz order

The initial S3 channel hold rule treated `production_ready: false` as
a hold trigger. In practice OrderHub returns `production_ready: false`
as a default state on Pixfizz-source `pages` / `text` artwork, so
every Pixfizz order in the queue was being held from auto-print with
a yellow "MANUAL — REVIEW REQUIRED" chip. The hold rule is now
narrowed to manual *source* only.

### Fixed: Quantity math: `file.copies` is authoritative

POS-style multi-image orders (POS-539M6D in production) were showing
5× the actual print count on the Job Review total. Original spec
multiplied `job.quantity × file.copies`, but in practice `file.copies`
IS the per-file total. `qtyOriginal` now equals `file.copies`
directly. Existing sidecars are not migrated — affected jobs may need
to be dismissed and re-flowed.

### Fixed: "Not finalised" chip narrowed to manual-source files

Earlier in the S3 channel cycle the "Not finalised" per-file chip
fired on any file with `production_ready: false`, which included
Pixfizz-source `pages` / `text` files that are not actually
customer-uploadable. The chip is now restricted to manual-source files
where it actually means something.

### Fixed: S3-delivered jobs threw "Order manifest not found" on dispatch

The S3 channel was downloading artwork into per-job folders but not
writing the order-level manifest the dispatch pipeline reads. DPOF +
Darkroom Pro routes crashed on dispatch as a result. The downloader
now writes the manifest with byte-shape parity to FTP-delivered
manifests. One-shot recovery for orders that pre-date the fix:
`scripts/rebuild-missing-manifests.js`.

### Fixed: S3 manifest upsert overwriting FTP-delivered manifests

On Pixfizz jobs where `/pending-jobs` returns a non-empty
`artwork_files[]` (operator-uploaded replacement), the S3 downloader
was wholesale-replacing the FTP-delivered manifest with a
sidecar-derived reconstruction that had `size: null`. Dispatch then
threw "size is missing" on routes that need size. The helper now
sniffs the existing entry's shape and leaves FTP-authoritative
manifests alone.

### Fixed: S3 downloader now filters `artwork_files[]` to manual source

The downloader was attempting to fetch every entry in `artwork_files[]`
regardless of source. On Pixfizz-source jobs that meant trying to
re-download files that had already arrived via FTP. The downloader now
filters to entries with `source: 'manual'`, leaving Pixfizz-source
files to the FTP path.

### Fixed: FTP downloads ENOENT'd on filenames with literal backslashes

Pixfizz Core occasionally escapes parens in customer upload filenames
as `\(` / `\)`. The backslash is legal on the Linux FTP server but
Windows reinterprets it as a path separator. The downloader now
sanitises every Windows-reserved character in the LOCAL basename; the
server-side name is left untouched so the fetch still works.

### Fixed: FTP delete log noise on read-only `/original-files/` paths

Pixfizz Core ships customer originals to `…/original-files/…`, where
the lab FTP user typically only has read+list permission. The expected
DELE 550 there is now demoted to a debug log + treated as a successful
no-op, restoring the parent-folder cleanup branch. A 550 elsewhere
keeps its error-level log.

### Fixed: OrderHub-deleted jobs stuck in poll loop

When OrderHub returned a 400 on `syncJobStatusFromOH` (job deleted
upstream), OHD treated it as transient and retried every poll cycle.
The row now flips to `_status: 'error'` with an operator-readable
`_errorMessage` (surfaced as a truncated caption + full tooltip in the
grid) and stops retrying.

### Fixed: Film Review chrome buttons silently eating clicks

Buttons in the Film Review panel chrome that overlapped the
OS-reserved drag zone (top ~30 px on Windows) silently swallowed
clicks. Same class of bug as the Job Review fix in v1.4. The panel
now opts out of the OS drag region.

### Fixed: Job Review grid columns stretching on long filenames

A `.jr-grid-scroll` column with a very long filename pushed the other
columns out of view. Grid template now uses `minmax(0, 1fr)` so
columns hold their width.

### Changed: Rebrand cleanup

v1.4.0 rebranded the product UI from "OrderHub Downloader" to
"OrderHub Desktop". v1.7.0 finishes the rebrand across 22 spec / doc /
brief files that v1.4.0 missed. The npm package name
(`orderhub-downloader`) is intentionally unchanged.

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
