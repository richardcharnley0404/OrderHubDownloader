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
