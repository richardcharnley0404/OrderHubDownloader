# Open threads after v1.8.0

Everything outstanding as of 2026-08-06, so a new piece of work can start without losing
these. Order is roughly "most likely to need attention first".

---

## Waiting on someone else

**Fuji PIC Pro lab test.** v1.8.0 ships PIC Pro support that has never run against real
hardware. A customer lab with PIC Pro is testing. Pack to send them with the exe:
`docs/fuji-pic-pro-lab-test-pack.md` — setup guide, what to check, feedback form.

When their report comes back, the four things most likely to have gone wrong, in order, are
in `docs/fuji-pic-pro-investigation-and-plan.md`: the Order ID format (we send `job_name`
like `ORD-O4YK5Z-1`; the spec says IDs are "normally defined with numbers"), whether
OrderGateway deletes a file it *can't* parse, text encoding (we write UTF-8 + CRLF), and
handshake timing.

**Confirm 1.15.3's two cross-volume safety hypotheses when the lab reports back.**
1.15.3 shipped with cross-volume delivery restored via the N-lite path, resting on two
hypotheses about PIC Pro / OrderGateway that were named as unverified in the shipped
CHANGELOG and operator notes: (a) PIC Pro's DIGIN watcher ignores a folder whose name
does not match an order/container id (i.e., `.ohd-inbox-{controller}-{instance}-{ts}-{rand}`
is invisible to the watcher), and (b) OrderGateway waits indefinitely for the DIGIN
folder to appear after consuming the `.txt`. The lab is now testing on 1.15.3; a
successful test order confirms both. Handling when their report arrives:

- **Success** (test order delivers and prints normally) — confirms both hypotheses.
  Update `docs/picpro-cross-volume-investigation.md` with the observation date and what
  was seen (which order id, timings, any surprises). Fold the confirmation into the
  1.16.0 CHANGELOG entry — **do NOT retro-edit 1.15.3's released notes**. The shipped
  wording said "unverified" and rewriting history there would create the exact "docs
  assert as fact what was actually expectation" trap the CLAUDE.md "never document
  unrun tests as fact" convention exists to prevent. The confirmation belongs in the
  next release's notes as "1.15.3's hypotheses confirmed by the lab on {date}", not
  back-patched into the release that shipped unverified.

- **Blank duplicate order** (the .ohdtmp shape from 1.14.x returns) — falsifies the
  name hypothesis. The `.ohd-inbox-` prefix is not sufficient discrimination for
  PIC Pro's DIGIN watcher. Rework: try a name built entirely from random hex with no
  OHD-branded prefix (`.{16-byte-hex}` or similar) so PIC Pro has nothing to
  pattern-match on. If PIC Pro ingests THAT too, cross-volume delivery has to go back
  to a design conversation — the design's discriminator was the name shape, and if
  the watcher ignores name shape entirely, N-lite is bankrupt. Update the
  investigation doc with the observed symptom and the ruled-out design.

- **Order stalls on PIC Pro's side** (container generated in Merge Data, DIGIN folder
  eventually rejected or timed out) — falsifies the OrderGateway-patience hypothesis.
  Cross-volume orders whose copy time exceeds OrderGateway's internal timeout would
  need to switch to Option N (pre-`.txt` copy — dispatch pays the copy latency, but
  OrderGateway sees the DIGIN folder within milliseconds of consuming the `.txt`).
  Option N is fully spec'd in `docs/picpro-cross-volume-investigation.md` as a
  fallback design; the reason N-lite was chosen over N was the empirical prediction
  that OrderGateway would be patient. Update the investigation doc with the observed
  OrderGateway timeout value (if measurable), then plan Option N as the 1.16.x fix.

**Release upload.** `dist\OrderHub Desktop Setup 1.8.0.exe` → S3 → link into OrderHub. See
`docs/RELEASE.md`.

---

## Known defects, none blocking

**Crop-to-Size dropdown labels.** `controllerNamesById` never reaches `buildSizeOptions`
(`src/shared/cropSizeDropdown.js`) because the caller in `ControlPanel.jsx` doesn't pass it.
Every row falls back to a generic label: two JobMaker mappings at the same size both render
`4×6" — Fuji` and can't be told apart, a DPOF row with no resolvable name renders bare, and
same-size variants scatter to the bottom of the list. Cosmetic only — Fuji rows set crop
aspect and never stamp a routing override — but confusing. Fix: pass the name map, and
consider deduping identical dimensions per controller. Target 1.8.1.

**CSV channel-mapping import is broken for DPOF, and has been since v1.7.22.** `renderer.js`
always sends `printSizeCode: ''` and then does `imported++` without checking
`result.success`. Since 1.7.22 made print size mandatory server-side, every row is rejected
while the summary reports "N mappings imported, 0 skipped" and nothing persists. Verified
*not* caused by the 1.8.0 work. Good standalone task.

**PIC Pro rehydrate window.** If OHD is killed between `writeOrderFile` returning and
`markCommitted`, the pending entry rehydrates with `txtCommitted: false`, OrderGateway
consumes the `.txt`, and the entry eventually times out as `failed` with images never
delivered. Surfaced rather than silent, so it's safe — but closeable: on rehydrate, if
`txtCommitted` is false *and* the `.txt` is still on disk, the write clearly succeeded and
the flag can be set.

**PIC Pro reprint async delivery failure is not surfaced anywhere
(1.15.3 identified, not fixed).** The 1.15.3 silent-stall fix
(`_stepDelivering`'s catch → `updateJobLocally({_status:'error'})`)
works because dispatch stamps `entry.jobIds = [job.id]` on
enqueue and the monitor's terminal-failure callback iterates them.
Reprints cannot use this mechanism: reprints have no JobStore
entity (`src/main/services/print-service.js:1157-1159` — "a
reprint is a sibling job that lives only in OHD's local files and
on the printer's queue"), so there is no `job.id` to pass through.
`parentJob.id` exists but is design-forbidden ("parent lifecycle
untouched"); `reprintJobId` is a filesystem folder name, not a
JobStore key, and `jobService.updateJobLocally` silently no-ops on
non-matching ids (`src/main/services/job-service.js:762-767`,
guarded by `findIndex(...) === -1`). Result: an async PIC Pro
reprint delivery failure logs to Winston, resolves the monitor
entry as `failed`, and shows nowhere in the UI. Sync reprint
dispatch failures ARE surfaced —
`src/main/ipc-handlers.js:2842-2861` returns `{success:false,
error}` to the renderer at the moment `sendReprint` returns — so
this only affects failures that happen after `sendReprint` returned
success. Closing it needs a new surface, not a wiring change:
either a `_deliveryStatus` / `_errorMessage` field on the reprint
sidecar written by `print-controller-service.onPicProStatus` (needs
a callback path from the monitor back to the sidecar plus the
reprintJobPath persisted on the entry), or a
`_lastReprintFailure` field on the parent job (visible via
`updateJobLocally(parentJob.id, ...)` without touching the
parent's `_status` — a design choice). Not release-blocking; the
same class of defect existed before 1.15.3 and was masked by the
broader silent-stall bug that 1.15.3 fixed for real jobs.

**Flaky test — RESOLVED 2026-08-19.** `perfectlyClearClient.test.js`
"stability polling" (`:482` / `:487`) was a scheduling race: the test's
25 ms poll interval + 30 ms rewrite delay put the rewrite ~5 ms AFTER
the expected poll-2 firing time, so any jitter that ran poll-2 first
made the client see v1 twice and consume it instead of v2-longer. By
2026-08-13 this needed ~4 reruns to land green; by 2026-08-19 ~6.
Fix: widened this ONE test's timing to `STABILITY_POLL_MS = 120 ms` and
`REWRITE_DELAY_MS = 60 ms`, chosen so that poll-2 (≥ 120 ms after
poll-1) is ALWAYS after the rewrite (60 ms after write) — the race is
impossible. Clock injection was rejected because the stability check
consults `fs.stat`'s mtime/size, not any clock; injecting a clock
would leave the race untouched. Other tests keep the fast 25 ms
`TEST_POLL_MS`. Test invariant unchanged: consumer must not consume a
file whose signature differed at the previous poll. See the fix
commit's diff comment for the full derivation. Three consecutive
first-attempt-green full-suite runs confirmed the fix on the
originally-flaking Windows dev box.

**`resolveRoute`'s `_channelMappingOverride` block duplicates the route shape per
controller type.** There is a hand-written literal per known type (`fujijobmaker`,
`fujipicpro`, `frontline`, and — 2026-08-09 — `darkroompro`), with a DPOF fallthrough
catching everything else. No shared builder. Any future route-level field has to be added
in **two** places (the type's main branch AND its override branch), and the same
silent-drop hazard the darkroompro branch fixed likely still exists for the Fuji branches:
the override literals for JobMaker and PIC Pro were spot-checked to carry the fields the
dispatch methods read *today*, but they aren't obviously drift-proof against the primary
literals. Consider extracting a per-type route builder shared by both entry points before
the next route field is added — or at minimum add an override/non-override key-set parity
test per type (there is one for darkroompro in `routing-override-darkroompro.test.js`).

**Routed Darkroom Pro has no printer acceptance signal.** `darkroom-pro-monitor.js`
`_extractOrderNumber` (`:145-149`) only matches the legacy `Order{n}.TXT` filename shape;
the routed emitter writes `{job_name}.txt` (e.g. `PXTEST-XYZ-1.txt`, or
`PXTEST-XYZ-1_3.txt` on split dispatches from M4), and `_sendViaDarkroomProRouted`
(`print-service.js`) never calls `trackSubmission` or `startMonitoring`. Completion
is therefore decided **synchronously at dispatch** — a `.txt` that Darkroom Pro
never consumes goes unnoticed. This is the reason M5's "all batches accounted for"
means "all written successfully", not "all printed". Fix would need the monitor to
recognise the routed filename shape (batched too) *and* the routed dispatch to
register each submission with the monitor. Not release-blocking — the legacy
non-routed path still has the acceptance signal for labs on that path.

**Fuji PIC Pro acceptance callback routes to the legacy job store, so printer acceptance currently marks nothing complete for routed jobs.** `print-controller-service.js:103` (`onStatusChange`) calls `jobStore.updateJobStatus(status.orderNumber, status.status)` — the legacy pre-routing store keyed on `order_number`. Routed jobs live in `jobService` keyed on numeric `job.id` and aren't in that store at all, so the monitor's `accepted` / `failed` / `timed_out` callback (wired via `onPicProStatus` at `:190-204`) is effectively a no-op for every routed submission. Two consequences worth naming: (a) routed PIC Pro jobs remain in `in_production` indefinitely on the strength of that signal alone — `route.checkOrderStatus === false` is the only way they currently reach `completed`, because that branch bypasses the acceptance signal by calling `_markCompleted` at dispatch time; (b) since 1.12.2 the monitor's `event.orderRef` is the SUBMISSION id (i.e. the post-strip form when `stripOrderNumberPrefix` is set on the controller), and would never match `order_number` even if the callback were routed at the right store. Anyone wiring completion to this signal must fix the key first — bridge `orderRef` back to the routed `job.id` set (probably via the monitor's pending map, which already carries both) and call `jobService.markCompleted(jobId)` / a matching error path, rather than the legacy `jobStore.updateJobStatus`. Same-shape work is warranted for the JobMaker `onFujiStatus` adapter at `:142-156` (identical pattern, same latent gap).

**Fuji PIC Pro's blank `printSize` still degrades Manual Crop to a 1:1 square silently.** Same class of bug as the DPOF `printSizeCode` recovery, different controller. When a `fujipicpro` (or `fujijobmaker`) channel mapping has a blank `printSize`, dispatch still succeeds (the field is a Manual Crop aspect indicator only — `print-service.js:2466-2478` is the docblock spelling out why the auto-print path deliberately doesn't gate on it), but Manual Crop falls back to a 1:1 square with only a `⚠` pill via `resolveTargetSize` to signal the issue. The M5 configHealth check in this release covers DPOF only; extending it to flag sizeless Fuji mappings the same way — and surfacing them in the startup banner + Settings roll-up — was deliberately kept out of scope for this release. Do when a lab reports it.

**Order-level submission — Phase 2 (Darkroom Pro) not started.** Phase 1
shipped for Fuji PIC Pro (`docs/order-level-submission-picpro-brief.md`
— off by default, per-controller `mergeOrderJobs` setting, wait cap +
suffixed-id late-arriver scheme). Phase 2 would extend the same
grouping/dispatch machinery to `darkroompro`; the format change needed is
smaller than PIC Pro's was — `darkroom-pro-output.js` already writes
`Media=` per image block, but `Size=` is resolved once from
`job.productCode` at `:193` and reused (see feasibility doc §1). Making
size per-block mirrors what media already does. The identity fields
(`ExtOrderNum`, `Orderid`, filename) all derive from
`outputFilenameStem` and would move from per-job to per-order.

**Merge + batch-cap interaction on the same darkroompro controller is
unresolved.** Phase 1 controllers (`fujipicpro`) don't have a batch cap,
so the two features don't collide today — but if Phase 2 ships
`mergeOrderJobs` for Darkroom Pro alongside its existing `maxPrintsPerJob`
cap, someone needs to decide the semantics: merge-then-split (apply the
cap to the merged print count), split-per-job-then-never-merge, or make
the two features mutually exclusive per controller. Recommend
merge-then-split (feasibility doc §3) — anything else produces output
the operator can't predict. Either way `computeHoldForReview`'s
`over-batch-threshold` reason becomes order-aware in the merged case, or
it holds on per-job counts that no longer mean the same thing.

**Neither PIC Pro nor Darkroom Pro's actual behaviour with mixed sizes
in one submission has been tested against real hardware.** The Phase 1
CHANGELOG entry calls this out for operators. One hand-built order file
with two different print codes, dropped in a lab's Order Data hot
folder, settles the format question for good.

**`reconcileControllerIgnore` still performs a whole-controller save on the Fuji and DPOF Assign branches.** M3 of the darkroom-media-lock release repointed the function at the narrow `ohd:routing:set-ignored-options` IPC, but the Fuji (`renderer.js:1910`) and DPOF (`:2124`) call sites still throw on ignore-write failure — that behaviour is preserved because their channel-mapping match logic depends on `optionsMatchWithIgnore` seeing the ignore set as current before the mapping save runs, and any reordering (mapping first, ignore second — or making the ignore write ancillary) needs its own analysis before it can land. If either branch grows the same locked-controller scenario the darkroompro branch had, or if a lab reports a Fuji/DPOF Save & Assign eating jobs, this is the first place to look. The narrow IPC is already available; only the call-site behaviour needs deciding.

**`dpof-generator.js` still emits `PRT PSL=` unvalidated.** M1 guards the reprint caller, but the three first-send callers (`print-service.js:319`, `:490`, `print-controller-service.js:37`) all rely on caller-side print-size guards. A generator-boundary throw would be defence-in-depth and align with the "fail loudly" spirit of v1.7.22, but needs its own audit across all five call sites before landing.

**Settings polling-interval field on a fresh install shows editable until first check-in.**
The Settings panel reads `ohd:server:get-capabilities` once when the panel opens (see
`renderer.js` — `populateForm`), so the first time an operator installs OHD v1.9.0 and opens
Settings *before* the initial `/checkin` has landed, the Polling Interval input renders
editable with today's default text — even in a Pixfizz org where OrderHub is advertising a
central value. The next panel open (or an app restart after the first check-in has run)
shows it correctly read-only with the *Set centrally by OrderHub (Ns)* hint. Cosmetic,
self-correcting, not release-blocking. Fix would be pushing capabilities to the renderer
from `_checkIn` (an `ipcRenderer.send`) so the input flips live rather than only on the
next panel open — worth doing if it starts generating support tickets, but not otherwise.

---

## Unverified

**Manual Crop's Approve gate.** v1.8.0 gates per-image Approve (and the Enter/Space
shortcut) on the target size having resolved, so an operator can't approve a square crop
while the ⚠ pill is showing. It has unit coverage on the logic but has never been exercised
in the app, because Manual Crop only opens for `artwork_source === 'manual'` jobs and the
local test data is all Pixfizz. Needs a manual-source job to confirm.

---

## Decisions parked

**Tmp-in-watched-folder writers: audit and move out of the watched directory.**
Two writers still create a tmp artefact inside a folder a third-party product
watches. Both share the shape of the M7b DIGIN bug — the DIGIN case is confirmed
in production so the class is real, not theoretical, and each of these is a
latent version of it waiting for a customer to trip.

- `fuji-pic-pro-file-writer.js:170` — `writeOrderFile` creates `{orderId}.txt.tmp`
  inside `orderDataPath` before renaming to `{orderId}.txt`. OrderGateway watches
  that folder. The PIC Pro spec (p.359) says filename is irrelevant to
  OrderGateway but doesn't state extension filtering; we don't know whether
  OrderGateway ingests `.tmp` files. The fix would be to write the tmp file
  to a same-volume sibling of `orderDataPath` and rename in.
- `fuji-jobmaker-file-writer.js:92` — same shape: `{surface}.txt.tmp` inside
  the JobMaker hot folder, then rename to `{surface}.txt`. Frontier's JobMaker
  watch is presumed to filter by `.txt`. Presumed, not confirmed.

Neither has a customer report today. Fix pattern is the same for both: introduce
a save-time co-location check between the tmp-write location and the watched
folder (same shape as `isSameVolume` in `fuji-pic-pro-file-writer.js` — a pure
string compare of volume roots, NOT a filesystem probe; the M7b probe version
was itself an instance of the tmp-in-watched-folder bug and was replaced in
M7c) and stop dropping tmp artefacts in the watched folder. Do them together
as a single "harden all tmp-in-watched-folder writers" milestone rather than
one-off, so the class is closed rather than whacked case-by-case. Not
release-blocking — the DIGIN one that DID burn a customer is fixed in M7b.

**Auto-update is wired but dormant.** `src/main/updater.js` polls a feed whose URL comes
back from OrderHub's `/checkin`, but no `latest.yml` has ever been published, so it has
never found anything. Releases are manual: exe to S3, link in OrderHub. Turning auto-update
on is operational, not code — publish `latest.yml` beside the exe (exe first, yml second)
and point the `/checkin` `download_url` at the containing directory rather than the exe.
Full detail in `docs/RELEASE.md`.

Possible side effect worth checking when the lab's logs arrive: if `/checkin` returns
`is_up_to_date: false` plus a `download_url`, electron-updater fetches `{url}/latest.yml`,
404s, and logs `Auto-updater error` every 4 hours in every install. Grep the lab's
`app.log` for that string.

**`docs/RELEASE.md` has a `TODO(richard)`** for the exact S3 bucket and path prefix.

**The old `folder_copy` controller** named "Fuji Pic Pro - Folders" is still configured. It
was the stopgap before the typed controller existed. Delete it once the lab confirms the
real one works.

**Imposition v2 candidates (2026-08-19).** v1 shipped code-complete
(see [`pdf-imposition-investigation.md`](pdf-imposition-investigation.md)
§10 for the build record). The five items below were deliberately kept
out of scope during the v1 build (§8 of that doc) and are the natural
follow-ons if the feature earns real lab demand — recorded here so
they're chosen next time, not missed:

- **Ganging / nesting multiple jobs per sheet.** v1 is one job per
  sheet run. Ganging is a different feature (batching windows, cut
  planning, per-sheet job tracking). Revisit only on real lab demand
  — the order-merge work showed how much complexity "combine jobs"
  hides.
- **Artwork rendered in the live preview** — the template editor
  currently shows the grid as labelled rectangles. Rendering the actual
  card PDF inside each cell would need PDF rasterising in the renderer
  (pdf.js or similar), a new dependency. The v1 preview is enough to
  validate geometry; adding artwork is polish.
- ~~Fill-last-sheet quantity rounding~~ — **shipped in M7 (2026-08-20)**
  after first-hands-on operator feedback. Default true per template;
  see `pdf-imposition-investigation.md` §8.
- **Per-sheet barcode / slug lines** for cut tracking. The existing
  order-identifier pipeline step already draws text; extending it to
  stamp a per-sheet marker outside the cells is small once a lab wants
  it.
- **Imposing raster (JPEG) artwork.** PDF Copy is PDF-only today; the
  imposition engine consumes PDF pages. Adding raster support would
  need a JPEG-to-page wrapper in composeImposition.

**EXIF orientation support in image imposition (M10 follow-on, 2026-08-20).**
`image-artwork.js` reads JPEG SOF stored pixel dimensions and
ignores the EXIF Orientation tag entirely. Consequence: a phone
photo that previews upright but is stored sideways with EXIF
`Orientation=6` (rotate 90° for display) imposes sideways. Design
tools (Photoshop, Illustrator, Affinity) always write pixels in
the intended orientation and are unaffected; only phone-camera
JPEGs and a few web-download shapes carry EXIF rotation. If a lab
reports sideways images: read APP1 → EXIF IFD0 → tag `0x0112`
(Orientation), pre-swap width/height for orientations 5–8 before
`chooseRotation` sees them, and bake the turn into `drawImage`'s
rotation argument. ~40 lines in `image-artwork.js`. Build only if
a lab reports the problem — the operator guide's §8 known-limitation
paragraph already tells them the re-save-in-an-editor workaround.

**Filename templates deliberately don't apply to reprints (M4, 2026-08-17).**
`_sendReprintViaFolderCopy` (`src/main/services/print-service.js`) keeps the
original filenames into its `…_{id}-r{n}` folder — the M3 template on the
controller is not consulted. Reprint images come from the sidecar
(`qtyCurrent`, no manifest), so `{quantity}` and `{index}` would need
different plumbing and different semantics, and the reprint folder name is
its own disambiguator. Deferred per §8 of
`docs/folder-copy-filename-templates-brief.md`. An operator who sets a
template and then can't work out why reprints look different needs to know
this is intentional; a comment in `_sendReprintViaFolderCopy` points here.
Not blocking any release — pick up if a lab reports the inconsistency.

**`basic-ftp` client construction is duplicated between `ftp-service.js` and
`ftp-source-service.js`.** M2 of `docs/ftp-sources-brief.md` chose to hold
one `basic-ftp` session open per pass in `ftp-source-service.js` for
performance (2N+1 connect/close cycles per pass on the strict-reuse path
was unacceptable at WAN latency). The two files construct their sessions
independently; any change to timeout / secure-TLS / passive-mode / encoding
options in one must be mirrored in the other or one server will quietly
work only with the caller that happens to match its expectations. A
`withSession(credentials, fn)` helper on `ftp-service.js` would let the
mover reuse a single connection without inheriting the DPOF-specific
baggage (`_isExpected550OnOriginalFiles`, `markIntegritySuspect`,
recursive `scanAndDownload`). Worth doing if a third caller ever appears
— for two, cross-reference comments in both files are the cheaper guard.

**`configService.save()` is not atomic.** It commits fields incrementally
(`store.set(...)` interleaved with sanitiser throws), so a throw partway
through leaves earlier fields persisted on disk and later ones silently
dropped. The renderer only sees `"Error saving settings: <message>"` — no
indication that a partial write happened, and no way for the operator to
tell which half of their edits survived. Not caused by the FTP-sources
work (which flagged it — see 2026-08-15 M1 of `docs/ftp-sources-brief.md`);
it's been true for every validation path in `save()` since Order XML
landed at least. Two ways to fix:

  1. Front-load every validation before the first `store.set` — a
     "validate everything, then commit everything" pass. Simplest but
     requires collecting every rule currently inline with a `store.set`
     into a top-of-function block.
  2. Make the save transactional — snapshot the store on entry, roll
     back on any throw. `electron-store` doesn't offer this natively;
     would need a shallow-clone snapshot + explicit restore in the
     catch, and care around fields that were legitimately deleted.

Option 1 is the smaller change and matches the shape of Fuji-JobMaker /
Fuji PIC Pro's `validateControllerConfig` at their IPC-boundary
call sites (which validate then let the sanitiser rewrite the object
in one atomic-ish call). Option 2 is more robust against future
sanitisers that mutate the store as a side effect.

For the FTP-sources feature specifically the risk is mitigated by
routing per-source saves through their own IPC handler
(`ohd:ftp-sources:save-source` — Option F chosen 2026-08-15), so the
general Settings save never round-trips `ftpSources`. But the
underlying `save()` non-atomicity remains a footgun for any future
sanitiser added inside it.

**`<ShipOrder>` for the ROES schema — replace the pickup guess with
an authoritative flag.** Both parsers currently INFER pickup:

- PhotoFinale by comparing `ShipToAddress` to `RetailerStreet`
  (`photo-finale.js:344`) — a match means pickup, mismatch means ship.
- ROES from an all-empty `ShipTo` block (`roes.js:330-331`) — empty
  means pickup.

Both are guesses. PhotoFinale's guess breaks quietly if a retailer's
address ever appears as a legitimate ship-to (unlikely, but not
impossible). ROES's is safer because the lab defines the format, but
it still can't distinguish "customer forgot to fill in the ship-to"
from "customer selected in-store pickup" — both look identical.

The lab defines the ROES XML, so an explicit `<ShipOrder>` flag could
replace the guess: **present = authoritative** (`true` = ship,
`false` = pickup), **absent = today's rule** (backwards-compatible
with existing ROES files), and **`ShipOrder=true` with no address
becomes a rejectable error** rather than a silent misfiling as pickup
(which is what today's all-empty-ShipTo rule would do). No lab has
reported a misclassification, so this stays parked. Revisit if one
does — the fix would be one field-read in `roes.js`, one new branch
in the pickup detection, and one rejection case for the missing-
address-with-ShipOrder-true shape.

**PhotoFinale Customers directory: the configured email is never
validated against a real OrderHub customer.** Settings holds a
per-retailer directory mapping `<RetailerDealerCode>` → Customer Name
+ Email; those replace the cardholder details on the submitted order
(`photo-finale.js:220-231`). Two failure modes to distinguish:

- **Unknown `RetailerDealerCode`** — already rejected outright by
  `photo-finale.js:226`, order lands in `failed/`. A bad *code* can
  never import wrong details.
- **Typo'd *email*** — saves cleanly in Settings and only surfaces
  later, either as a mismatched customer_id on the order or as a
  customer created under the wrong address.

Fixing the second requires a customer-lookup endpoint on the OrderHub
API, which doesn't exist today (the API surface is
`/api-webhook`, `/get-new-jobs`, `/update-job-status`,
`/update-order-status`). Specced in
`docs/orderhub-customer-endpoint-spec.md` §4.1 as
`GET /customers/lookup?email=<email>`. Parked 2026-08-19 — Richard
pushed back to the client rather than build it, on the grounds that
the existing code-level rejection already prevents the *damaging*
case (a bad code never imports; a bad email just misroutes to an
addressable customer). Revisit if a lab reports mis-matched customer
records tracing back to a Settings typo.

---

Older items from before 1.8.0 — the working-set divergence Phase 2, the FTP 550 noise on
customer-original paths, the film gallery/email workflow plan — are not repeated here.
They're recorded in project memory and in their own `docs/` files.
