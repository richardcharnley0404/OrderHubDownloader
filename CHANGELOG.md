## v1.10.0 - 2026-08-10

**Operator-triggered batch splitting for Darkroom Pro.** A lab can now set
a maximum-prints-per-job cap on each Darkroom Pro controller so an over-cap
job is held from auto-print for operator review, and clicking Send to Print
writes the job as N separately-numbered Darkroom Pro `.txt` files that the
operator schedules against urgent work inside Darkroom Pro's own queue.

Darkroom Pro first because unlike the Epson SureLab OrderController it has
no Interrupt Order / pause-mid-print facility, no queue-reordering hook
that OHD or the operator can call, and no way to slip a 5-minute reprint
past a 600-image order once the big job has started printing. Splitting is
the only mechanism available — OHD writes N smaller orders, Darkroom Pro
sees them as N independent jobs in its own queue, and the operator does
the scheduling inside Darkroom Pro. This is not a scheduler in OHD; it is
a mechanism to *let* the operator schedule. Design context in
`docs/batch-splitting-feasibility.md` and the implementation brief in
`docs/batch-splitting-darkroom-pro-brief.md`.

### New: `maxPrintsPerJob` cap on Darkroom Pro controllers
The Add Controller modal for `darkroompro` gains a "Maximum prints per
job" numeric field (1–10000; blank = no cap = pre-release behaviour).
Persisted via the read-time default idiom — no migration — and carried
across every route shape a `darkroompro` job can take, including the
`_channelMappingOverride` short-circuit used by hold-release and
crop-to-size reassignment. Range-guarded in both the renderer's Save
handler and the IPC save handler for defence-in-depth. Surfaced only on
`darkroompro` — the Epson DPOF branch is deliberately untouched pending
its own release.

### New: `over-batch-threshold` hold reason
When the on-disk manifest's total print count exceeds the controller's
cap, the job is added to the hold-for-review set with a new reason
`over-batch-threshold`, alongside the existing `manual-source`,
`manual-file`, and `routing-hold` reasons. Auto-print skips the job; the
operator's Send-to-Print click is the release trigger and bypasses the
gate as it always has. Print count reads from the manifest — the same
source the splitter reads at dispatch — rather than from `job.quantity`,
which carries different meanings across job sources (Pixfizz vs manual
vs film-development) and is empty on FTP-Pixfizz jobs until the manifest
lands. A small first-write cache prevents per-poll re-reads against
SMB-mounted download directories; a failed stamp leaves the field
genuinely unset so cycle-one manifest-not-yet-arrived state cannot
poison the cache. `runAutoPrint` deliberately re-reads fresh at the
last gate before dispatch.

### New: Split dispatch — one Darkroom Pro `.txt` file per batch
When a routed `darkroompro` job's manifest print count exceeds the cap,
the dispatch method writes N files named `{job_name}_1.txt` ...
`{job_name}_N.txt` instead of a single `{job_name}.txt`. The stem
suffix flows into `ExtOrderNum` and `Orderid` inside each file, so each
batch lands as a separate order in Darkroom Pro and the operator can
reorder them inside Darkroom Pro's own queue. Per-job preparation
(manifest read, enhanced-path and corrections maps, and the
`_applyCorrectionsToImageFiles` step which writes corrected JPEGs to
`/working/`) runs exactly once regardless of batch count. Splitting
happens after `_findJobInManifest` applies the operator-discarded
filter, so batch boundaries reflect only images that will actually
print. Reprints stay unbatched. **Single-batch dispatches are
byte-for-byte identical to v1.9.0** — no `_1` suffix, no ledger, no
return-shape change — so every lab that has not set a cap sees no
change at all.

### New: How batches are filled
The cap counts **prints, not images**: 600 images at 2 copies each with
a cap of 100 produces 12 batches of 50 images (100 prints each), not 6
batches that each take double time on the printer. Batches fill image
by image, in manifest order, until the next image's copies would push
the batch over the cap; at that point the current batch closes and a
new one opens with the next image. **An image's copies are never split
across batches** — splitting them would reorder prints on the printer,
which is precisely the thing the operator is buying by scheduling the
batches inside Darkroom Pro. A consequence: an image whose own copy
count exceeds the cap gets its own oversized batch of one image, and
OHD writes it anyway (Darkroom Pro will still accept the file).

Worked examples:

- **40 images × 2 copies each, cap 20 → 4 batches.** Each batch fills to
  10 images (20 prints, cap met exactly); the 11th image would take the
  running total to 22 so a new batch opens. 40 / 10 = 4 batches of 10
  images each.
- **5 images × 21 copies each, cap 20 → 5 batches.** Each image already
  exceeds the cap on its own. Splitting an image's copies is disallowed,
  so every batch contains one image of 21 prints. All five batches are
  oversized (21 > 20). The tooltip on the post-dispatch grid chip shows
  each batch's print count so operators can see the oversize immediately.

### New: Persisted per-batch ledger + partial-failure handling
Every split dispatch stamps a `_darkroomProBatchLedger` onto the job
record (via `jobService.updateJobLocally`, which lands in `jobs-cache`
and survives restart) — cap, total batches, total prints, start /
completion timestamps, and one entry per batch with `filename`,
`destPath`, `outcome` (`success` / `error`), and error message on
failure. **The ledger is persisted after every batch, not once at end**,
so a process crash mid-loop still leaves a record on disk of which
batches went out. On partial failure — e.g. batch 4 of 6 throws — the
batches already written are being printed. OHD does not attempt to roll
them back, stamps the ledger with the error entry, marks the job
errored with a message that names which batches went and which did not
(*"Darkroom Pro batch 4/6 failed: ENOSPC ... Batches 1..3 were written
to the hot folder and are being printed; batches 4..6 did NOT. Cancel
the printed ones in Darkroom Pro if needed."*), and returns
immediately. Neither `_markCompleted` nor `_markInProduction` fires
until every batch has been written successfully, so the job stays
visible and recoverable in the operator's queue.

Known limitation, recorded in `docs/BACKLOG.md`: the routed Darkroom
Pro path has no printer acceptance signal — `darkroom-pro-monitor.js`
only matches the legacy `Order{n}.TXT` filename shape, the routed
emitter writes `{job_name}.txt` (and `{job_name}_N.txt` for batches),
and the routed dispatch never calls `trackSubmission` or
`startMonitoring`. Completion here therefore means "all batches
written", not "all batches printed". A `.txt` that Darkroom Pro never
consumes goes unnoticed. Not new in this release, but noted here
because batch splitting depends on it and it is the reason the
"completion" wording above is deliberately narrow.

### New: Jobs-grid chips for the split lifecycle
Two chips render in the Jobs-grid flags-cell to make the feature
visible to the operator:

- **Before dispatch:** the existing hold-review chip's label is now
  derived from `_holdReasons` rather than hard-coded. A
  batch-threshold-only hold reads *"Large job — review required"*; a
  mixed-reason hold reads the generic *"Review required"*; existing
  all-manual holds still read *"Manual — review required"* unchanged.
  Forward-compatible — a future-added reason token never mislabels as
  "Manual".
- **After dispatch:** on split dispatches only, a *"Sent as N batches"*
  chip in green, or *"Sent M/N batches"* chip in red on partial
  failure. Tooltip carries per-batch filenames + outcomes + errors,
  plus a header line with the cap and total prints, so operators can
  reconcile against Darkroom Pro's queue without opening the Activity
  Log. Absent on single-batch dispatches, so the grid stays visually
  identical for every lab that has not set a cap.

### Fixed: Reassigned Darkroom Pro jobs silently lost route fields
`resolveRoute`'s `_channelMappingOverride` short-circuit had no
`darkroompro` branch — reassigned `darkroompro` jobs (via
`ohd:routing:release-hold`, or from crop-to-size) fell into the DPOF
fallthrough and silently lost `artworkRootPath`, `orderLastNameFormat`,
and `channelMappingId`. The routed dispatch method reads the first two
directly off the route object, so operators saw broken artwork paths
and default order-name formatting on reassigned jobs instead of the
controller-configured values. Fixed by adding an explicit `darkroompro`
branch that mirrors the main literal, locked by a key-set parity test
between the two literals so this specific field-drop cannot recur.
`docs/BACKLOG.md` notes the same shape-duplication hazard likely still
applies to the Fuji branches.

### Fixed: Hold-review chip mislabelled non-manual holds as "Manual"
The pre-release Jobs-grid chip hard-coded *"Manual — review required"*
for every `_holdForReview` job. When the batch-threshold reason arrived
in this release, a large Pixfizz order on a real operator's queue
rendered as *"Manual"* — implying manual artwork review, when in fact
nothing was manual. Also fixed a pre-existing case where a
`routing-hold`-only job rendered as *"Manual"*. Chip label now derives
from `_holdReasons` via `deriveHoldChipLabel` in
`src/shared/holdForReview.js`, pre-computed on job intake so the
vanilla `renderer.js` reads a single `_holdChipLabel` field. Legacy-
cache fallback preserves the old label for any job entry that predates
this fix, until the next poll re-stamps.

### Fixed: Fuji Assign on the Jobs grid did nothing on Save (v1.8.0 regression)
The Save button on the Assign Channel Mapping modal — when opened from a
`fujijobmaker` or `fujipicpro` job on the Jobs grid — threw a
`ReferenceError` inside its click handler and returned before entering
the try / catch. **The operator saw nothing at all**: no toast, no
validation message, no error dialog. Save simply did not respond, and
there was no way to complete the assignment from the Jobs grid — the
only workaround was to open Settings → Channel Mappings and create the
mapping there. Both Fuji controller types have been affected since
v1.8.0. The handler referenced `route`, which is out of scope: it is
registered once at page load inside `initAssignModal()` and closes over
`modal` / `saveBtn` only, not the `(job, route)` args of the
`openAssignModal` function that stamps the modal's dataset. Fixed by
stashing the PIC Pro flag on `modal.dataset` in `openAssignModal`
alongside the other context and reading it back in the handler — the
same pattern the handler already uses for `isFuji` and `isDarkroomPro`.
Only manifested from the Jobs-grid entry point; the Settings-side
Channel Mapping modal was unaffected because its Save handler reads
every input fresh from the DOM.

## v1.9.0 - 2026-08-09

Adopts ohd-api v1.4.0 to cut OHD's polling cost against OrderHub. In
prod OHD spends ~99% of its API traffic and ~94% of OrderHub's
backend compute on per-job status GETs that changed nothing. This
release turns that into a single batched call per poll cycle, adds a
conditional `/jobs/pending` (304 on unchanged), and moves both
cadences under OrderHub-side control per organisation. Every new
behaviour is gated on a feature flag the server hands back on
`/checkin`; against a pre-1.4.0 server the app runs exactly as it did
in v1.8.0. Full contract and fallback rules in
`docs/integrations/ohd-api-efficiency.md`.

### New: Batched status sync (POST /jobs/status-batch)
The out-of-band status sync no longer issues one `GET /jobs/{id}` per
active job per poll cycle. Enabled via `features.status_batch`, ids
are sent in sequential batches of `min(100, features.status_batch_max)`
per POST. Behaviour on per-id outcomes mirrors the per-job path
byte-for-byte: `Completed` and `Cancelled` (case-insensitive) collapse
to local `_status='completed'`; `errors[]` with `status:400` stamps
`_status='error'` with the same legacy "OrderHub no longer recognizes
this job" message so 400s surface in the UI instead of log-looping;
any other error status (403/404/5xx) warns and leaves the job alone
— 404 must not mark jobs as errored or transient misses would strand
active work. Ids are sent as strings so numeric local `job.id`s match
server-echoed `requested_job_id`s; response order is not assumed. HTTP
404 on the endpoint itself → the feature is muted for the session and
the per-job path takes over for the rest of the cycle. `GET
/jobs/{id}` is still available for one-off lookups — only removed
from the polling loop.

### New: Conditional /jobs/pending via If-None-Match
`/jobs/pending` sends `If-None-Match` when the server has advertised
`features.pending_etag`. The stored ETag is pinned to its query key
(locationId + `include_no_artwork`) — a query change drops it. Because
a 304 does not extend presigned URL validity, we force a genuine 200
while at least `PRESIGN_SAFETY_MS` (5 min) of the 1-hour TTL is still
on the clock — costs roughly one full body per hour at the default 60
s cadence, everything between those hourly refreshes is a cheap 304.
On 304 the response body is empty and untouched (no `JSON.parse`),
`this.jobs` is not reset, `lastFetchTime` advances, and hold flags are
re-derived so an operator's routing-hold change takes effect on the
very next poll instead of waiting for the next 200. When an artwork
download fails, `polling-service` calls `invalidatePendingEtag()` so
the very next fetch omits the conditional header and gets fresh URLs
— self-heals expired-URL failures within one cycle.

### New: OrderHub-driven polling cadence + feature flags
`/checkin` responses can now carry `poll_interval_seconds`,
`status_poll_interval_seconds`, and a `features` bag. OHD reads them
on every check-in and persists them per-install to a new
`server-capabilities` electron-store, so a restart before the next
check-in still behaves as the last check-in configured. Invalid or
out-of-range values are ignored (never clamped); absent fields leave
the stored value untouched; `disableFeatureForSession` mutes a flag
in-memory only so one bad server response can't stick across
restarts. When a check-in changes the cadence live, the polling timer
re-clocks without waiting for the next app restart. Every request to
the ohd-api host now also carries `X-OHD-Version` and
`X-OHD-Instance-ID` (fire-and-forget) so OrderHub can see which build
+ install is talking to it; the different-service `orderhub-api-client`
with its `X-API-Key` contract is deliberately untouched.

### New: [ohd-api] check-in read-out in the Activity Log
`_checkIn` logs one `[ohd-api] /checkin capabilities` info line per
successful check-in, listing `poll_interval_seconds`,
`status_poll_interval_seconds`, and each feature flag. When the
server hasn't included the `features` block at all, the value
collapses to the sentinel string `absent` — a grep for
`features:'absent'` in the Activity Log surfaces pre-1.4.0 servers
immediately. Bounded to the listed keys — nothing else from the
response leaks in, no API key ever logged. Meant to replace the
"attach a debugger to see what came back" step in support cases.

### Changed: Status sync runs on its own cadence — up to 300 s completion lag
When `status_poll_interval_seconds` is advertised (Pixfizz default:
300 s), the out-of-band status sync only runs at that cadence instead
of every `pollJobs` cycle. That's where most of the traffic saving
comes from — but it means an OrderHub-side change (mark completed,
cancel, another OHD instance completing the job) can take up to
`status_poll_interval_seconds` to clear from OHD's Awaiting Processing
view. The `lastStatusSyncAt` bookkeeping advances in a `finally` so a
throwing sync can't collapse the gate back to every cycle, and
`getStatus().lastStatusSync` surfaces the last attempt alongside
`lastCheck`. When the interval is not advertised (pre-1.4.0 server),
the sync runs on every cycle as before. The trade-off is accepted;
`docs/integrations/ohd-api-efficiency.md` covers the reasoning and
why a `forceStatusSyncNext()` hook is deliberately not built.

### Changed: Polling Interval field in Settings shows who owns it
When OrderHub advertises `poll_interval_seconds`, the Polling Interval
field in Settings → Polling now populates from the server value, marks
itself read-only, and the hint text below reads *Set centrally by
OrderHub (Ns). Contact Pixfizz to change it.* The saved config value
is still sent on save as the offline fallback (config-service's
10–600 validation still applies). Kills the "I edited the field and
nothing changed" bug report. First-launch wrinkle noted in
`docs/BACKLOG.md`: the Settings panel reads capabilities once on open,
so on a brand-new install the field shows editable until the first
check-in lands — self-corrects on next panel open.

## v1.8.0 - 2026-08-05

Fuji PIC Pro controller support + review-round hardening across the
Fuji dispatch pipeline. Full format spec in
`docs/print-controllers/FUJI-PIC-PRO-FORMAT.md`.

### New: Fuji PIC Pro controller type

OHD now dispatches to Fuji PIC Pro alongside Noritsu / Epson DPOF,
Darkroom Pro, Fuji JobMaker, Frontline, PDF Copy and Folder Copy.
Controller type `fujipicpro` in the routing config; three explicit
paths in the Add Controller modal — Order Data (where OHD writes
the `{OrderId}.txt`), DIGIN (where the images land after
OrderGateway consumes the .txt), and an optional Merge Data path
(watched to confirm the build completed before writing
`[release]`). Two timeouts — a short gateway timeout (default 2
min, bounds 10 s – 30 min) and a longer build timeout (default 30
min, bounds 1 min – 24 h). Backprint supports two lines (`Backprint1`
and `Backprint2`); `CustomerName=` is opt-in (off by default —
enabling it back-prints the customer's name on every print unless
`Backprint2` is also set). Optional `[release]` command auto-drop
behind a per-controller toggle.

Dispatch splits image staging from the DIGIN move so the PIC Pro
sequencing (`.txt` first, images only once OrderGateway has
consumed it) is respected. OHD sequence-renames staged images
`0001.<ext>` / `0002.<ext>` / … so `NegNumber=` fits the spec's
15-char cap. A persistent per-controller state-machine monitor
(new `fuji-picpro-pending-{controllerId}.json` electron-store)
drives each order through `awaiting-gateway → delivering →
building → releasing` and survives an OHD restart mid-handshake.
Reprints emit a fresh order with the `-r{n}` suffix rather than
using PIC Pro's native `[restart]` (the OHD reprint is a subset
of images, possibly re-cropped — `[restart]` would reprint the
original order untouched).

### New: Crop-to-Size dropdown surfaces Fuji targets

The Job Review Crop-to-Size dropdown gains entries for Fuji
mapping print sizes alongside DPOF and Darkroom rows. Multiple
mappings sharing a dimension (e.g. a Noritsu 4×6 channel AND a
PIC Pro 4×6 mapping) now render as separate labelled rows rather
than one hidden-behind-the-other row that would silently reroute
the job. Fuji rows are informational — picking one sets the crop
aspect but does NOT stamp `_channelMappingOverride` (routing
stays whatever the operator's process → controller mapping
resolves to).

### Fixed: Manual Crop aspect for Fuji jobs

Pre-fix `resolveTargetSize()` had no Fuji branch, so every routed
Fuji job returned `no-size-translation` and the crop box silently
fell back to 1:1 square while the ⚠ pill was showing. New Fuji-
family channel-mapping field `printSize` (bare `WxH`) feeds a new
lookup path in `resolveTargetSize` + a new source in
`getAllSizeOptions`. Required at save time for Fuji PIC Pro; a
JobMaker save with blank `printSize` warns rather than blocks so
a live install with lab-package `printCode` values isn't broken
on upgrade. Manual Crop's per-image Approve button and its
Enter/Space keyboard shortcut both share the same gate — no more
approve-at-square-crop while the ⚠ pill is visible.

### Fixed: 14 review-round hardening items on the Fuji dispatch path

Bundled from the pre-release review (`docs/fuji-pic-pro-review-fixes.md`).
None of these are latent in v1.7.22 — every one is on a code path
new in 1.8.0.

- **`Qty` and `{originalFilename}` survive CMY corrections.**
  `_applyCorrectionsToImageFiles` strips every per-image key
  except `{sourcePath, filename}` on rows with a non-zero
  correction. Dispatch reads quantity + originalFilename from
  the manifest / reprint sidecar directly now, matching
  JobMaker.
- **Approve button + Enter/Space share one gate** on Manual
  Crop. Pre-fix the keyboard shortcut bypassed the button's
  `targetSizeReady` check.
- **Monitor's file-existence check hardened.** `fs.existsSync`
  returned false on EACCES / EIO / unmounted-share as well as
  ENOENT. Switched to `fs.promises.stat` and treat only ENOENT
  as absent; every phase gate also requires two consecutive
  absent observations before advancing so a single SMB blip
  cannot drive the next phase against an order that isn't
  ready.
- **PIC Pro monitors start at boot** for every configured
  controller. Persisted pending entries now rehydrate on
  restart without waiting for the next dispatch.
- **`_scan` is serialised** with an in-flight guard so a slow
  DIGIN move can't re-enter itself via the `setInterval` tick
  or the `fs.watch` debounce.
- **Pending-store namespace per controllerId.** Two configured
  PIC Pro controllers no longer erase each other's queues.
- **`deliverToDigin` is idempotent** so a crash between the
  move and the phase-persist replays cleanly.
- **`stageImages` clears the per-order folder** before writing
  so a retry doesn't ship a stale `0001.<oldext>` alongside
  the current `0001.<newext>`.
- **`enqueueSubmission` rejects duplicates** for an in-flight
  `orderId` rather than silently overwriting the tracked entry.
- **EXDEV `.ohdtmp` cleanup** — leftover from an interrupted
  cross-volume copy is wiped before the next attempt and on
  the failing attempt itself.
- **Two-phase enqueue → write → markCommitted** with a gateway-
  timeout `[delete]` on the abandoned `.txt`. A crash between
  enqueue and write leaves a recoverable entry (times out via
  `gatewayTimeoutMs`) rather than an orphaned `.txt` that
  OrderGateway consumes with no OHD tracking.
- **`printSize` is not a dispatch gate** — it's a crop-aspect
  indicator only, never written into `order.txt`. Blocking
  auto-print on it broke the Pixfizz artwork-source flow
  (those jobs bypass Manual Crop). Downgraded to a warning
  log; save-time still requires it for PIC Pro.
- **`Color=` is a real UI field** on PIC Pro channel mappings
  now, not silently reset to `C` via the validator default on
  every mapping edit. Options: C / B / S / S2 / S3 per spec p.
  353.
- **Save-time reject** when `imageStagingRoot` / `diginPath` /
  `orderDataPath` / `mergeDataPath` equal each other or nest
  inside each other (sibling folders under a common ancestor
  are fine).

### Fixed: Fuji PIC Pro Add Controller modal cosmetics

Image Staging Root help text described JobMaker's flow (`Frontier
reads ImageFile= from this path`); rewritten to describe PIC Pro's
staging-then-move flow plus the two operational constraints (same
volume as DIGIN Path; must not overlap the other three paths). DIGIN
Path help said "Frontier builds the print run from here" — PIC Pro,
not Frontier. Back Print Mode help no longer references
`FUJI-JOBMAKER-FORMAT.md`. Generic Output Path field is hidden for
PIC Pro (its three explicit paths replace it) and forced blank on
save so `polling-service._startFolderMonitors` doesn't attach a
DPOF `FolderMonitor` watching for `o→e`/`o→q` renames PIC Pro never
makes.

### Documentation

New `docs/print-controllers/FUJI-PIC-PRO-FORMAT.md` — the emitter
contract, three-folder handshake, monitor state machine, reprint
policy.

`docs/print-controllers/WORKFLOW.md` rewritten. The v1.7.22-era
document described the legacy `sendToPrint` path (single DPOF
pipeline, `configService.getProcessMapping` for routing) that the
app no longer uses. The new document reflects the current
architecture: `routingService.resolveRoute` for routing, seven
controller-type-specific pipelines, per-controller monitors, and
the Fuji-family handshakes.

## v1.7.22 - 2026-07-24

Correctness (print size) + lab-safety (film-scan pipeline) release. Full details in
`docs/RELEASE-NOTES-1.7.22.md`.

### Changed: Print size is now mandatory and product-code driven
DPOF dispatch no longer relies on the upstream manifest's `img.size` field (which S3-delivered jobs set to `null` by design). The channel mapping's `printSizeCode` is now the single source of truth. Historical mappings without a size are backfilled from the legacy `size` field; new mappings must carry a `printSizeCode` at save time in both the Settings routing editor and the per-job Assign Channel modal. Unmapped or blank-size DPOF mappings surface with a "No print size" chip in the routing list so the lab can fix them before a job hits them. The silent `'KG'` fallback is gone — a mis-configured mapping now fails at dispatch with an actionable "No print size configured for product X" message rather than printing at the wrong size.

### New: Best-fit crop-box orientation in Job Review
Fresh crop boxes now default to the source image's aspect (landscape source → landscape 4×6 box; portrait → portrait), not the target size's. Per-image only — a manual Portrait/Landscape flip sets that image's orientation and does not propagate. Approve All auto-orients each image by its own shape; already-approved crops keep their existing orientation. Square target sizes are unaffected. Same behaviour in the standard grid and the manual crop rail. Dropped a lot of unnecessary per-image flipping in mixed-orientation rolls.

### Changed: Job Review preview top bar (filename + AI quality score)
Both review modes (standard grid + manual crop stage) now show filename and AI quality score in a thin top bar directly above the main preview image. Score digits are dark ink on a light surface for readability in both themes; sub-threshold shows a thick red border but the digits stay legible (the previous red-text-on-red styling was unreadable). Thumbnails keep their compact colour-coded score dot for at-a-glance scanning. Score tooltip trimmed to `Score: N.N` (errored: `Score: n/a — <reason>`); model/mode/threshold/timestamp lines dropped.

### New: Lab-safe Perfectly Clear enhancement (never wedges a roll)
A film-scan roll can no longer permanently wedge at `processingStatus:'enhancing'` when Perfectly Clear QuickServer is slow, dead, or misconfigured.
- **Startup stale-sweep:** any roll left in `'enhancing'` from a prior session is cleared into review on next launch, with a staleness guard so a genuinely-live enhance from another process can't be clobbered.
- **Operator "Reset enhancement" button** on enhancing rolls in the Film Scans UI — aborts the live batch via AbortController and escalates the roll to review with whatever it has (enhanced where available, originals otherwise). No operator file-editing required.
- **Authoritative hard timeout:** every fs op inside the Perfectly Clear client is deadline-bounded, plus each poll cycle races against the remaining wall clock. A hung SMB share cannot wedge the batch past its timeout. Timeout and per-op cap are configurable (`perfectlyClearFilmScanTimeoutMs`, `perfectlyClearFilmScanPerOpTimeoutMs`) — null defaults preserve prior behaviour.
- **Zero-enhanced diagnostic:** a batch that produces no enhanced frames logs a WARN naming the QuickServer input folder so a misconfigured or offline channel is obvious from the activity log.

### Fixed: Transient 502 on presign no longer poisons a film-scan roll
A single transient HTTP 502 from the OrderHub presign endpoint could permanently fail one file per roll, poisoning the completion manifest (`errors > 0`) and having OrderHub reject the whole roll — requiring a manual delete-and-re-upload in OH. The upload path now absorbs the blip at every layer:
- **Presign retry:** transport errors, HTTP 429, and HTTP 5xx retried up to 4 attempts with `[1s/3s/7s]` backoff + jitter. 4xx (non-429) throws fast — auth errors don't get better with retries.
- **PUT retry:** broadened from network-only to also retry PUT 5xx and 429, 4× attempts with matching backoffs.
- **Second-pass sweeps:** after the per-file loop, up to 2 additional sweeps over only the still-failed files with a 2s wait between. Catches "gateway flapped during the batch" cases. Widened consecutive-failure early-abort to count 5xx/429 alongside network errors so a persistent 502 wave aborts fast instead of grinding every file's retry ladder.
- **`failed_files[]` in the manifest:** per-file `{name, sub_path, reason}` records alongside the existing `errors` count. Reasons truncated to the first line + 120 chars so an HTML 502 body can't bloat the manifest.
- **Self-heal for previously-failed rolls:** the film-scans cycle now re-attempts both `'uploading'` and `'failed'` rolls every tick, rate-limited to one retry per 10 minutes per roll. Combined with the inner retries, a transient blip cannot permanently kill a roll — worst case is a 10-minute delay before automatic recovery.
- **Concurrent-upload guard:** in-process guard on `_uploadRollFromStorage` prevents two callers (main-poll auto-assign + film-scans self-heal + operator IPC) from starting two concurrent uploads of the same roll when their state guards race.
- Outer roll-level retry trimmed from 3× `[30s, 90s]` to 2× `[15s]` now that inner layers absorb transient blips.

## v1.7.21 - 2026-07-18

### Changed: Film Development Phase 1 — ambiguous twin-check match guard
Film Development Phase 1: ambiguous twin-check match guard in the auto-assign matcher. When two live film-dev jobs expose the same normalised twin check, the matcher now leaves the roll held for manual resolution rather than guessing (previous behaviour was arbitrary last-wins). The operator sees a warning line naming both jobs so the collision is easy to reconcile.

## v1.7.20 - 2026-07-17

### New: Film-scan completion manifest carries matched twin-check + job context
When a film-scan roll uploads via Auto Assignment (or is later approved manually with a match already stamped), the per-folder completion manifest OHD writes to S3 now includes the matched **twin check**, job number, order number and match timestamp alongside the existing file counts. OrderHub reads these fields to record the upload against the correct twin check — the "Scanned" badge on OrderHub's **Twin Checking** tab now lights up automatically when OHD finishes uploading. Rolls with no match (Manual mode without Auto Assignment, File Uploads folders) still get the exact same pre-feature manifest shape, so nothing else is affected. The Film Review UI also gains a persistent **Twin {…}** pill on each roll card and a matched-job header line on the roll detail view, so operators can see at a glance which twin/job a completed roll went to — and rolls held awaiting a job now show an explicit "Awaiting job match" banner in the detail view too.

### New: Film Development Auto Assignment Mode
Labs running Film Development can now let OHD hold every scan roll at the S3-upload step and only upload when a Film Development job with a matching Twin Check ID has arrived from OrderHub. Turn it on with the new **Auto Assignment Mode** checkbox in Settings → Film Scans; off by default so existing installs behave exactly as before.

- **Hold + match:** A new roll waits at the "Awaiting job match" pill on the Film Review card. When a matching film-dev job appears, OHD stamps the match on the roll and uploads it automatically. Match is by Twin Check ID: the roll folder name and the job's `twin_checks[]` are compared on digits only, so a zero-padded folder like `00001847_1` matches a twin check of `1847`.
- **Two-gate rule with review modes:** Auto Assignment stacks with Manual / Smart Check review. Whichever event happens second (operator approval, or matching job) is what actually kicks off the upload. If a job arrives before the operator has approved a Manual-mode roll, the card shows **"Matched — awaiting review"** with the job number so the operator knows which job they're clearing.
- **"Upload without job match" override:** Reviewed rolls whose job never arrives (walk-in scans, mis-scanned twin check, typo in a twin check on the OrderHub side) get an explicit escape hatch in the Roll Review header — a confirm-required "Upload without job match" button next to the disabled "Waiting for job match…" primary action.
- **Film-dev jobs never touch the operator queue:** `is_film_development` jobs are filtered out of the Jobs grid, the auto-print dispatcher, the S3 artwork downloader, and the received-files check. OHD never marks a film-dev job received and never calls the job-status API for it — OrderHub owns the assignment.
- **Works with polling off:** Film-scan-only PCs (job polling disabled) still get matches. When Auto Assignment is on and an OrderHub API key is configured, the film-scans timer fetches film-dev jobs directly on each match cycle. The fetch has no side effects — no artwork download, no received-marking, no status sync.
- **Dead-QuickServer safety carries over:** the roll upload uses the existing storage-side retry chain (3 attempts, 30s→90s backoff), so a network blip while an auto-matched roll is going up doesn't wedge anything.

### Fixed: Intermittent test-suite failures under parallel execution
`npm test` occasionally reported spurious failures in the folder-watch integration tests because three of them share an on-disk electron-store JSON file when run in parallel. Each test file now uses its own sandbox userData directory, and the top-level test runner switches to serial file execution. Zero effect on the app; the test suite is now deterministic (13 s vs 5 s parallel, worth the trade for reliability).

## v1.7.19 - 2026-07-01

### New: Set ignored options straight from the Assign Channel modal
The per-job **Assign Channel** modal now shows an **Ignore** checkbox next to each option, so you can mark options as non-matching at the moment you assign a job — no need to open Settings afterwards. Boxes are pre-ticked for anything the controller already ignores. Ticking one and hitting **Save & Assign** adds it to the controller's ignore list (controller-wide, exactly like the Settings editor), so the new mapping matches with it already in effect and the option drops off the job row. Works for Fuji JobMaker, Darkroom Pro and Noritsu/Epson assignments.

## v1.7.18 - 2026-07-01

### New: {originalFilename} token for Darkroom Pro and Fuji JobMaker back-prints
Darkroom Pro **Photo Lines** and Fuji JobMaker **Back Print Templates** gain an `{originalFilename}` token. It resolves, per image, to the customer's original upload filename with Pixfizz's leading image-index prefix removed — e.g. a file stored as `5_576629810005.jpg` prints as `576629810005.jpg`. Because the value is taken from the order manifest / job record (not from whatever file is physically dispatched), **reprints and re-crops emit the correct original filename** for each image automatically. Orders that didn't ship an original (non-Pixfizz, older orders) leave the token blank rather than failing the job. (On Fuji the back-print is still sanitised and truncated to 40 characters by Frontier's rules.)

### New: Ignore options that don't affect the print route
Some products are sent every variant a customer can pick — finish, layout, border, image enhancement, mounting, and so on — but only one or two of those actually decide where the job prints. A cut print, for example, only cares about **finish**; its layout varies job to job and shouldn't matter. Previously every option on a channel mapping had to match exactly, so a varying option (like `layout-options`) would stop a job matching and push it to manual **Assign**.

You can now mark an option as **Ignore** in a channel mapping (Settings → Routing → edit a mapping): tick the new *Ignore* box next to the option. Ignored options are skipped when matching jobs, so a job still matches no matter what value it carries for them. The setting belongs to the **controller**, so it applies to every mapping on that controller — set it once and it sticks even when new mappings are auto-created. Options you don't tick keep matching exactly as before, and controllers with nothing ticked behave identically to previous versions.

Ignored options are also **hidden from the job list** for jobs routed to that controller, so the row only shows the variants that actually affect the print — less clutter. (The option is still recorded on the order and still visible in the mapping editor; only the job-row chip is hidden.)

### Changed: Fuji JobMaker output uses the Job No
Fuji JobMaker order files (the `.txt` filename, `Order_ID=`, `ImagePath=`, and the image staging folder) now use the **Job No** (e.g. `ORD-O4YK5Z-1`) instead of the bare order number. This prevents two jobs in the same order from colliding on a shared filename/folder. Reprints keep their `-r1` suffix (e.g. `ORD-O4YK5Z-1-r1`).

## v1.7.17 - 2026-06-26

### New: Scanner Source Folder — keep the scanner's output untouched
Labs were manually copying their scanner's output folder before letting OHD run, because OHD *moves* files out of the Watch Folder (and the AI rotation step then edits the stored copies), so there was no pristine, untouched copy left behind. A new optional **Scanner Source Folder** setting (Settings → Film Scans) fixes this: when set, OHD copies new scan folders from it into the Watch Folder and processes those, while **never deleting or changing anything in the Scanner Source Folder** — it stays your clean archive. Leave it empty to keep the current behaviour (feed the Watch Folder directly).

It also handles scanners that group rolls under a per-day folder — e.g. `Scanner\06272026\00000004\…`. OHD recognises the date folders automatically and copies the **roll folders inside them** across (the date level is dropped), so the layout the pipeline sees is unchanged. This whole feature is an additional step on top of the existing pipeline; the consume/rotate/upload path is untouched.

Note: with this enabled a roll waits out the Watchguard time twice (once to confirm the scan finished in the source folder, then again in the Watch Folder), so allow a little extra time before processing starts.

### New: Delete unwanted frames before a roll is uploaded
Scanner leader frames and blank scans can now be removed from a roll before it's uploaded, so they never reach S3 or the gallery. Open a roll in Film Scans, **tick the frames** you want gone (a selection circle appears on each frame as you hover), then click **Delete selected** — a single confirmation removes them all permanently (the image, its matching TIFF/JPEG, and its thumbnail). Only available before a roll is uploaded; once a roll is on S3 the option is hidden.

### Fixed: Large or layered TIFF scans failed to produce a JPEG
TIFF rolls are converted to JPEG so the online galleries have images to show. Very large TIFFs (e.g. ~180 MB) or TIFFs carrying extra layers/metadata from retouching could fail that conversion quietly — the TIFF would upload but no JPEG was created. The conversion now uses the same tolerant settings as the rest of the film pipeline (it allows very large images and ignores non-fatal warnings), matching the rotation and thumbnail steps that already read those same files successfully, so these scans now convert correctly.

## v1.7.16 - 2026-06-26

### Fixed: Film scan uploads could get stuck on "Uploading…" after a network drop
If the internet dropped while a roll was uploading to S3 — even a brief outage — the upload could hang indefinitely. The roll would sit showing "Uploading…" forever with nothing actually transferring, and because the pipeline was held up behind it, all further film-scan processing stalled until OHD was restarted. The upload now has a hard timeout that always fires even on a stalled/half-open connection, bails out early when the network is clearly down, and — on the next launch — automatically resumes any roll left mid-upload, finishing it from the safe copy already in your storage folder. So a network blip no longer wedges a roll or the whole pipeline, and an interrupted upload recovers itself.

### Fixed: Some jobs failed with "Image not found" when the images were in the working/originals folders
A job whose images had ended up in its `working/` or `originals/` subfolders — but not in the job-folder root — could fail to print, with the controller receiving no images, because every dispatch path read images only from the root. Dispatch now falls back through root → working → originals to find the images wherever they validly live (the same way reprints already do), so this no longer fails. Applies to every controller type: Fuji JobMaker, Noritsu/Epson DPOF, Darkroom Pro, folder-copy, PDF, and Frontline.

### Changed: Order manifest can also be named order.json
When reading an order's JSON manifest, OHD still looks for `{ordernumber}.json` first, but now falls back to a generic `order.json` in the same folder if the order-named file isn't present. This makes manifest delivery more forgiving without changing how OHD writes its own manifests.

### New: Film Scans housekeeping — history retention, clearer naming, and TIFF visibility
A few improvements to the film-scan area:

- The **Film Review** tab is now called **Film Scans** (matching its settings), and shows whenever Film Scans is enabled.
- A new **History Retention (days)** setting (default **30**) automatically clears old reviewed rolls from the Film Scans history so the list doesn't grow forever. Set it to **0** to keep everything. This only trims the on-screen history — your stored scan files are never touched.
- **TIFF** rolls now show a distinct **"Converting"** step while they're converted to JPEG, and the *"Where the time goes"* breakdown gains a **TIFF→JPEG** timing figure, so that stage is visible on its own.

## v1.7.15 - 2026-06-24

### Fixed: Existing "Order manifest not found" errors now clear themselves on update
The retry above protects *new* jobs, but any jobs already stuck in this error on the previous version would have stayed stuck — the app treats a manifest error as final and never retries it. On launch, OrderHub Desktop now automatically resets any job sitting in an "Order manifest not found" error back to pending, so it re-attempts on the next poll. Since the manifest has almost always landed by then, the backlog of stuck jobs clears itself shortly after you install this update — no manual action needed. (Genuine failures are left alone: a manifest that's truly missing simply re-enters the normal wait, and corrupt-manifest errors stay flagged.)

### Fixed: Film scans took hours to appear in OrderHub
When several scan rolls were dropped into the watch folder together, they trickled into OrderHub one roll at a time — roughly one every few minutes — so a day's scanning could back up for hours. The film-scan watcher was processing only a single roll per cycle and then waiting for the next timer tick. It now works through every ready roll in one pass, so a batch drains continuously instead of one-per-tick. Rolls still process one at a time, but with no idle wait between them.

### New: Film Review pipeline status panel
The Film Review page now shows a live status strip at the top: how many rolls are watching, processing, uploading, awaiting approval, or failed, plus the roll currently in flight — so you can see what the scan pipeline is doing in the background at a glance. Below it, a "Where the time goes" breakdown averages how long each stage (watchguard wait, copy, AI rotate, S3 upload) takes across recent rolls and highlights the slowest, making it easy to spot where any delay is coming from.

## v1.7.14 - 2026-06-24

### Fixed: Orders occasionally stuck on "Order manifest not found" even though the file was there
Some jobs failed auto-print with a red "Order manifest not found" error while the order's `.json` manifest was clearly sitting in the folder. Seen on order PRLE-EL2KTR: the canvas jobs printed fine, but two Photo Print jobs in the same order errored against the very same manifest the canvas jobs had just read successfully.

Root cause: the manifest arrives over FTP to the watched share without an atomic write, and OrderHub re-pushes the whole order folder whenever later jobs are added to the same order. During that re-push the manifest momentarily vanishes / is zero-byte / is half-written. If a dispatch happened to read it in that split-second window it threw "not found", and the job dropped into a sticky error that was never retried — so it stayed stuck even though the file reappeared a moment later. (The existing "Awaiting JSON Manifest" wait only guards a manifest's *first* arrival, not a later re-push.)

Two-part fix:
- The manifest read now retries up to 4 times, 250ms apart (~750ms total), which absorbs the brief blip in the vast majority of cases.
- If the manifest is still missing after that, the job is no longer marked as a hard error. It drops back into the normal "Awaiting JSON Manifest" wait, so the next poll re-checks it and either resumes automatically when the file returns, or — only if the manifest genuinely never arrives within 10 minutes — escalates to a clear "manifest not received within N minutes" error.

Operator impact: these transient failures should now self-recover with no manual action, and a red manifest error once again means the file really is missing rather than briefly unavailable. Note: the auto-recovery applies to automatic printing; if you click Process manually and hit the same rare blip you may still see an error — just click Process again.

## v1.7.13 - 2026-06-19

### Fixed: Reprints failed on Fuji JobMaker, PDF, and Frontline controllers
Reprinting a job already worked on Noritsu/Epson, Darkroom Pro, and folder-copy controllers, but a job routed to a Fuji JobMaker, PDF-copy, or Frontline controller hit a "reprint not yet supported for controller type" dead end. All three now have full reprint dispatch, completing the matrix so a reprint works from any controller type OHD can print to.

Also fixed: when a re-cropped reprint's source image isn't in the usual /originals/ or /working/ folders, reprint now falls back to the order's root folder instead of failing — this covers files that arrived before the working-set folders were created.

## v1.7.12 - 2026-06-19

### Fixed: Reprints rejected on Noritsu/Epson controllers
After v1.7.11, reprinting a job on a Noritsu or Epson controller failed in two stages — first "reprint not yet supported for controller type", then, once past that, "no controller mapping for process". Both came from the reprint path using older internal lookups that are empty on installs whose routing is configured entirely through Settings → Routing (the modern setup).

Reprint now uses the same routing the normal print path uses, so Noritsu/Epson reprints dispatch correctly. As a bonus, any "hold for manual release" decision on the original job is honoured automatically on the reprint.

## v1.7.11 - 2026-06-18

### New: "Awaiting JSON Manifest" state for jobs whose files arrive before their manifest
A job's image folder sometimes lands on the watched share a moment before the order's `.json` manifest does. OHD used to treat that brief gap as a hard failure and drop the job into a sticky error. Now a job in that state shows an amber "Awaiting JSON Manifest" badge and simply waits: the next poll picks it up automatically once the manifest arrives, or — only if the manifest never shows up within 10 minutes — it escalates to a clear "manifest not received" error. (The current Unreleased fix extends this same safety net to a manifest that briefly disappears during a re-push.)

### New: Order/Due date column, job IDs in the grid, and a Destination picker for held jobs
Several Job Review tweaks landed together:
- The Ordered and Due dates now share one stacked column, shown in your tenant's configured date format.
- The OrderHub job ID now appears in the Job No cell (column widened to fit), making it easier to cross-reference a job back in OrderHub.
- Jobs held for manual release gained a "Destination" button and a cleaner release dialog, so you can pick where a held job goes without digging through menus.

Also in this release: DPOF folder names are now prefixed with the numeric job id (matching the Noritsu USR CID), and an opt-in "gated DPOF hot-folder auto-completion" mode was added (off by default).

## v1.7.10 - 2026-06-04

### Fixed: Fuji JobMaker Process click failed with "Controller not found"
When operators clicked Process on a Fuji-routed job, dispatch crashed with "Controller <id> not found" even though the controller was correctly configured. Root cause: the monitor-startup step looked up the controller in a legacy controller store (print-controllers.json) that's no longer the source of truth — controllers created via the modern Routing settings UI (which is everything except a historical Darkroom Pro entry) were invisible to that lookup. Fixed by routing the lookup through routing-service first, falling back to the legacy store for historical entries. Same pattern already used by the polling-service folder monitors.

Stuck jobs from v1.7.9: just click Process again. The .txt file the previous attempt produced is preserved on disk; the writer is idempotent and the atomic rename means Frontier never saw a half-written file.

## v1.7.9 - 2026-06-04

### Fixed: Fuji JobMaker — per-job Assign modal couldn't save mappings
When operators clicked Assign on a job routed to a Fuji JobMaker controller, the modal showed the wrong fields (Noritsu-style Channel Number) and the save attempt was silently rejected server-side because the required Fuji fields (PrintCode, Surface, optional SurfaceCode) weren't being collected. The Settings → Channel Mappings modal has always been correct; the gap was only in the per-job Assign affordance.

The Assign modal now detects Fuji JobMaker controllers and shows the right inputs. Workflow matches Darkroom Pro: fill the fields, save, mapping persists, job routes correctly on the next dispatch.

## v1.7.8 - 2026-06-04

### New: Process Routing — hold for manual release
When a process is set to "Hold for manual release" in Settings → Routing → Process Routing, every new job matching that process is held the moment it arrives. The held job shows a yellow chip in Job Review with a Resolve button. Click Resolve to:
- Release to the default controller (no change to routing), OR
- Reassign to a different controller (channel mapping validated; missing mapping opens the Assign dialog).

Useful when a controller is offline, busy, or you want a chance to pick per-job. Toggling the hold off in Settings releases all matching held jobs on the next poll.

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
