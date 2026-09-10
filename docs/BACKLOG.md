# Open threads after v1.8.0

Everything outstanding as of 2026-08-06, so a new piece of work can start without losing
these. Order is roughly "most likely to need attention first".

---

## REQUIRED for the 1.16.3 operator release notes

The 1.16.3 rotation-decoupling change opens Review Mode and
Auto Assignment to labs running with Enable AI Rotation off.
This is a **new capability**, not a silent behaviour change:
Smart Check and Manual Check were previously unreachable in
that configuration — the radios were disabled and greyed at
50 % opacity, force-reset to Auto on every AI-off toggle, and
the save path overwrote `filmScanReviewMode` back to `'never'`
regardless of any user selection. So no lab running through
the UI can be in "AI off + Manual selected" today; the state
was mechanically unreachable. The release notes should sell
this as an unlock, not warn labs that their pipeline will
stop.

**The one residual case that IS a behaviour change** — call
this out so a lab that hits it can identify what happened:

- A `config.json` written **before** the AI-off gating was
  introduced (or written by a hand-edit / an import from an
  older config) can hold `filmScanReviewMode: 'always'` or
  `'smart'` with `filmScanRotationEnabled: false` on disk.
- Pre-1.16.3, the load path displayed Auto in Settings for
  that config (the disabler forced the radio) and the runtime
  ignored the persisted value (the save path would have
  overwritten it back to `'never'` on the next save; the
  pipeline had no rotation-off review surface anyway). Rolls
  uploaded automatically.
- Post-1.16.3, the load path shows the on-disk value as it
  really is (Manual / Smart Check selected) AND the runtime
  honours it: Manual Check holds every roll for operator
  approval; Smart Check holds rolls with a low-confidence
  frame, rotation error, or Perfectly Clear rejection.
- Symptom on upgrade for this narrow case: film scans stop
  flowing to S3 automatically; the Film Review panel fills
  with pending rolls.
- Recovery: flip Review Mode to Auto in Film Scans settings
  (matches how the UI displayed it pre-upgrade), or start
  approving rolls in the panel if the persisted value was
  actually the intent.

**Change 2 — Auto Assignment + Manual Check + rotation off.**
Same story as above, restricted to labs using Auto Assignment.
Pre-1.16.3 the same UI gating prevented reaching this state
through Settings; a hand-edited or pre-gating config could
persist `filmScanReviewMode: 'always'` + `filmScanAutoAssignEnabled: true`
+ `filmScanRotationEnabled: false`. Pre-upgrade, the matcher
stamped `reviewPassed=true` regardless (no review surface
existed), so matched rolls uploaded immediately. Post-upgrade,
`reviewPassed` reflects the review-hold decision:
`filmScanReviewMode='always'` sets `reviewPassed=false`; the
matcher stamps the match but does NOT queue the upload
(`film-scan-auto-assign.js:196` gates the upload queue push on
`roll.reviewPassed === true`). Symptom: rolls appear as
"Matched — awaiting review" without auto-uploading. Recovery
same as above.

**Change 3 — Smart Check with rotation off AND Perfectly Clear
off is a valid selection now, but has no signals to hold on.**
Not a behaviour change (the pre-1.16.3 UI gating made this
combination unreachable too), but a new configuration that
reads confusingly in the unlocked world:

- Smart Check's contract is "hold on evidence of problems".
- With rotation off, `lowConfCount` and `rotErrorCount` are
  both 0 (no rotation loop produces signals).
- With Perfectly Clear off, `pcRejectedCount` is 0.
- Net: nothing to defer on → Smart Check behaves identically
  to Auto. No holds.
- The `smart-check` log line spells this out
  (`... (rotation off — no AI signals) → auto upload`) but
  operators don't read logs, so the Smart Check help text in
  Settings now names this case explicitly.
- Recovery for a lab that expected rolls held: switch Review
  Mode to Manual Check. Smart Check needs at least one of the
  signal sources — AI Rotation OR Perfectly Clear — to have
  anything to reason about.

**Change 4 — the save-time override that discarded the
operator's Review Mode selection whenever AI Rotation was off
is gone.** Quiet fix in the same commit, worth a one-liner in
the release notes: pre-1.16.3, saving Settings with AI
Rotation off would silently overwrite the persisted Review
Mode value back to Auto regardless of what the operator had
selected (the UI disabler made this normally invisible, but
combined with any programmatic tick / untick of AI Rotation
it could destroy an intentional setting). Post-1.16.3 an
operator's Review Mode choice is persisted as made.

**What to write in the release notes.** Lead with the
positive framing: "Manual Check and Smart Check now work
whether Enable AI Rotation is on or off — previously these
options were greyed out with AI off." Then the recovery note
for the narrow pre-gating-config case ("If your config was
edited outside Settings and had one of these modes saved with
AI off, upgrading will now honour that selection — flip
Review Mode to Auto in Settings if that's not what you
want"). Then the Smart-Check-with-no-signals warning as a
follow-up under Smart Check itself. Include the config path
— Film Scans settings → Review Mode — so an operator can
locate the setting without searching. Use the operator's
language throughout ("Manual Check", "Auto Assignment",
"Enable AI Rotation" — never `filmScanReviewMode`).

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

**~~Confirm 1.15.3's two cross-volume safety hypotheses when the lab reports back.~~
CLOSED 2026-09-09 — both CONFIRMED by successful field dispatch at the trigger lab.**
The lab whose 1.15.2 stall triggered the whole cross-volume investigation upgraded
to 1.15.3 and dispatched a real cross-volume test order. The order delivered
end-to-end and no phantom / blank duplicate appeared. That single dispatch
confirms both underlying hypotheses simultaneously: (a) PIC Pro's DIGIN watcher
ignores the `.ohd-inbox-{controller}-{instance}-{ts}-{rand}` name — evidenced
by the absence of a phantom during the copy window; (b) OrderGateway waits for
the DIGIN folder to appear after consuming the `.txt` — evidenced by the
delivery completing at all (a cross-volume copy is non-trivial). Full write-up
of what was and was not observed in `docs/picpro-cross-volume-investigation.md`
under the "Field result — 2026-09-09" section. Confirmation folded into the
1.16.3 CHANGELOG under the current Unreleased section per the "do NOT retro-
edit 1.15.3's released notes" discipline (that entry correctly recorded what
was known at the time and stays as-is).

**Not confirmed by this test — carry as separate open items if they matter.**
Only the healthy happy-path delivery ran. What we still have no field data on:
the mid-copy failure branch and its cleanup; the startup sweep for leftover
`.ohd-inbox-*` folders (nothing was left over); the 1.16.1 Fuji reachability
check (unrelated feature, not touched); OrderGateway's actual timeout value
(we only know it exceeded this order's copy duration at this lab). See the
Field result section of the investigation doc for the full "does not tell us"
list.

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

**No operator-visible signal when a Folder Copy dispatch suffixes
files against existing on-disk state.** 1.16.2's never-overwrite
guarantee walks `_2`/`_3` when a planned filename collides with a
file already in the destination — and reports the count on
`stats.diskSuffixed` (surfaced on the dispatch result and on the
`Job sent to print via folder copy (routed)` Winston log line as
`diskSuffixedCount`). That's the only signal today. It lands
inside the JSON meta blob of a log line the Activity Log tab
renders as text — visible if the operator searches for it, invisible
otherwise. No badge, no toast, no per-job indicator, no distinction
in `_status` between a clean write and a write that produced N
duplicates. An operator whose Retry duplicated files has nothing
linking the extra `_2` files in the destination back to the retry.

Why this matters: the retry-semantics investigation
(`docs/folder-copy-retry-semantics.md`) recommends leaving the
1.16.2 tradeoff as-is, and names a lab report of duplicate-file
pain as the primary trigger for revisiting that decision. Without
a visible signal that duplication happened, the report is unlikely
to ever reach us — the operator sees `_status: completed` and moves
on; the extras sit in the destination folder attributed to nothing.

Small change: surface `diskSuffixedCount` on the Jobs grid row
(a badge / column entry when non-zero) or as a completion toast
("Job N sent — 4 files suffixed against existing destination
files"). Either would be enough to close the feedback loop.
Details of the signal path and the "no consumer of diskSuffixed"
grep in `docs/folder-copy-retry-semantics.md` §4.

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

**1.16.1 Fuji JobMaker dispatch check: known false-fail when
`fujiImageRoot` is a drive-letter that resolves to unrelated content on
OHD's machine.** The dispatch-time reachability check in
`fuji-jobmaker-file-writer.js` `_verifyFujiReachability` discriminates
"root resolves, order subfolder missing" (hard fail — real config bug)
from "root does not resolve at all" (soft warn — OHD may legitimately
not see the share the Fuji machine reaches). That discrimination is
correct in the common cross-machine case where `fujiImageRoot` is a
UNC share the OHD box has no route to. It gives a **false hard fail**
in one specific configuration:

- The Fuji JobMaker machine has a drive letter mapped, say
  `Z:\Artwork`, pointing at `\\labserver1\Pixfizz\Artwork`.
- The operator sets `fujiImageRoot` to `Z:\Artwork` because that is
  what the Fuji machine sees.
- The OHD machine has its own `Z:` drive too — for example, an
  unrelated network drive, an SD card, or a personal folder the
  operator mounted for something else. That drive does NOT contain
  the Pixfizz artwork tree.
- OHD's `stat('Z:\Artwork')` succeeds (SOME folder exists at that
  path, just not the same one Fuji sees).
- OHD's `stat('Z:\Artwork\{orderRef}')` fails with ENOENT (the
  order subfolder OHD wrote is in `imageStagingRoot`, not on OHD's
  own `Z:`).
- The check falls into the "root resolves, subfolder missing → hard
  fail" branch and refuses to dispatch a correct configuration.

Uncommon in practice — mapped drives are per-user Windows state and
labs typically don't have the same drive letters mapped to different
things on the OHD box vs the Fuji box. Almost every cross-machine
setup uses UNC paths for exactly this reason (a UNC on the OHD box
either resolves to the same share the Fuji box sees, or does not
resolve at all — falls into the soft-warn branch).

**Accepted for 1.16.1, recorded here for the day it happens.** (1.16.1
was built but never distributed; labs first receive this code as part
of 1.16.2, so the "day it happens" would come from a 1.16.2-installed
lab.) The mode fails LOUD, not silent — the message the writer throws already
names both paths and the fix ("Fuji JobMaker dispatch stopped: the
order's artwork folder is not visible via the configured
fujiImageRoot. OHD wrote the images to `{imageStagingRoot}/{orderRef}`,
but `{fujiImageRoot}/{orderRef}` does not exist. This means
fujiImageRoot on the controller does not point at the same folder as
imageStagingRoot. Fix: check that fujiImageRoot resolves to the same
physical folder as imageStagingRoot, expressed as the Fuji JobMaker
machine reaches it. If both OHD and Fuji JobMaker run on the same
machine, the two must be equal."). A lab that reports "every
JobMaker dispatch fails with 'dispatch stopped' but the config looks
right" — check for a drive-letter collision on the OHD machine
first. Also visible in the Activity Log via the `logError` call from
`_stepDelivering`'s catch in the print-service call chain, and on the
Jobs grid as a red job with the full message.

Possible fixes if a lab does hit it:

- Simplest — tell the lab to switch `fujiImageRoot` to the UNC form
  (`\\labserver1\Pixfizz\Artwork` instead of `Z:\Artwork`). The
  emitted `.txt` accepts either shape and Fuji resolves both; the
  UNC avoids the drive-letter collision on OHD.
- If a code fix is warranted: compare the order-folder contents
  through `fujiImageRoot` against `imageStagingRoot` (e.g., stat the
  first image file that OHD just wrote and confirm it exists at
  both). If the two disagree on a file OHD KNOWS it wrote, the paths
  are genuinely different physical folders → hard fail. If they
  agree, the drive-letter overlap coincidentally landed on a folder
  containing the right images — accept and dispatch. Costs one extra
  stat per dispatch on a happy path; the current check runs
  post-stage-images so the file we'd stat is already on disk.
  Not worth doing preemptively; hold for a first customer report.

Reference: `src/main/services/fuji-jobmaker-file-writer.js`
`_verifyFujiReachability`. Test coverage for the hard-fail branch is
in `src/main/services/__tests__/fuji-jobmaker-file-writer.test.js`
under `1.16.1 reachability: root resolves, order subfolder MISSING`.

**Field report (2026-09-08).** A Fuji JobMaker lab is now running
1.16.2 in production with the split configuration this feature was
built for — images on one machine, `.txt` job files consumed on
another. They installed 1.16.2 and reported that JobMaker dispatch
is working; no problems have been reported since. 1.16.2 is the
first release to carry the `fujiImageRoot` code to any lab (1.16.1
was built but never distributed).

What is NOT known: we do not have a detailed test report, we have
not verified the error paths at their installation (dispatch-time
hard-fail on a missing order subfolder, soft-warn on an
unreachable root, save-time reachability advisory), and we do not
have confirmation of which specific checks fired during setup.
"No problems reported" is an absence of complaints, not a positive
verification. This is a working same-lab, same-config data point,
not feature verification — the drive-letter false-fail described
above is a specific configuration that a happy-path install would
not necessarily reveal. If this lab or another one hits the
false-fail, the "possible fixes" list above still stands. Do not
close the false-fail entry on the strength of this field report.

Not to be conflated with the Fuji PIC Pro cross-volume hypotheses
in the entry above (a different lab, still on 1.15.3, no report).
Those remain unconfirmed.

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

**Rush-reprint controller attribution has no lasting operator surface.**
The rush-reprint feature (docs/rush-reprint-controller-selection-
investigation.md) writes the destination controller name to the reprint
sidecar as `reprintDispatchedToControllerName` and shows it once in the
transient "sent" pill inside the Job Review drawer. Both of those are
gone by the next drawer open — the pill is auto-dismissed on the next
send, and the sidecar sits on disk unread by any UI. So the day after
a rush, an operator with two DP controllers cannot tell which of the
morning's reprints went to the fast printer without opening a reprint
sidecar file by hand and looking for the field.

The natural home is a per-job reprint history panel — a list of the
parent job's reprints with `{jobId}-r{n}` and the destination
controller name for each. The sidecar field already exists for it to
read, and every reprint dispatched since the feature landed carries it.
It is a separate build: the current work delivered the mechanism
(dispatch to a chosen controller + persistent attribution field), not
the historical surface. See docs/rush-reprint-controller-selection-
investigation.md §Q5 for the fuller shape of the attribution gap.

Documentation correction: an earlier draft of that investigation doc
claimed reprints appear as their own rows in the Jobs grid, which is
wrong — reprints are local job folders, not API jobs, and
`renderJobTable` never receives them. Nobody should design a future
attribution surface against a "reprint row" that does not exist. The
grid does not surface reprints in any form today.

**Multi-location FTP Copy mode — acceptance test outstanding.** The
1.16.3 FTP Copy mode + 1.16.4 persistence fix have been confirmed
in the narrow sense (one lab, one install, files remain on the
server after download — see the 2026-09-10 field-confirmation note
in the v1.16.4 CHANGELOG entry). The feature's actual purpose has
NOT been demonstrated at any lab: two OHD installs at two different
locations, both polling the same shared FTP folder, an order landing
in that folder, and both installs successfully downloading the same
order without either one preventing the other. That is the acceptance
test the feature exists to pass, and nothing automated can prove it —
the interesting cases are timing-dependent (both installs polling
around the same moment, one install mid-download when the other
starts, one install offline for a stretch and catching up) and
require two real, independent OHD installs sharing a real FTP folder
with a real polling cadence. Until that test has been run against a
real deployment we should describe Copy mode as "shipped and file
retention confirmed" rather than "multi-location download confirmed".
The safety property that makes this test survivable — an offline
location eventually catching up as long as no retention sweep has
run past its window — is itself contingent on the retention-sweep
window being set correctly at whichever location enables the sweep,
which is a further unverified interaction if a lab turns both on.

---

## Decisions parked

**FTP retention sweep — deliberately built.** Ships alongside
copy mode (`ftpKeepFilesOnServer`). The earlier version of
this entry (commit `403f146`) recorded a decision NOT to build
this sweep, resting on the assumption that Pixfizz Core's own
FTP cleanup was reliable enough to depend on. Richard has
reversed that decision: Core's cleanup runs on roughly a
10-day cadence per his own report, unverified by us and
outside OHD's control. Depending on another system's cleanup
behaviour for a lab's FTP retention is not something OHD
should do; the prior wording is superseded.

**Design as shipped:**

- Off by default per install (`ftpRetentionSweepEnabled:
  false`). Only ONE location per install should enable it —
  multiple locations running the sweep is harmless but
  pointless.
- 7-day default window (`ftpRetentionSweepDays: 7`). Richard's
  rationale: a lab is typically closed for two or three days,
  OHD runs continuously, 7 gives comfortable headroom while
  still bounding the folder's growth. It is a default, not a
  limit — a lab needing longer raises it.
- Dry-run toggle (`ftpRetentionSweepDryRun`, default false).
  The safety guards below already bound the damage, so
  defaulting dry-run to TRUE would mean an operator enables
  "Delete old files from the server", nothing gets deleted,
  the folder keeps growing, and nothing tells them why. Dry-run
  stays available as an opt-in preview ("tick this first if
  you want to check what would be deleted"), not as a default
  state that silently neuters the control next to it.
- Once-per-24h throttle. A full recursive FTP listing on every
  polling cycle would be roughly 2,880 tree walks per day at
  a 30-second poll, multiplied by every location — over eleven
  thousand listings a day against a shared server for a
  threshold measured in days. Persisted via
  `ftpLastSweepAt` in config so the throttle survives an OHD
  restart; a second scan within the window performs no
  listing and no deletes (locked by test).
- Runs at the end of `scanAndDownload`, reusing the same FTP
  session. Both callers thread the four config fields:
  `polling-service.scanFtp` (scheduled) and
  `ipc-handlers.js` `ftp:scanAndDownload` (manual). Manual
  and scheduled scans behave identically.

**Safety guards (spec §"SAFETY REQUIREMENTS"):**

1. **Refuses at "/" or empty remote path.** Sweeping the FTP
   root could delete files belonging to Pixfizz Core or to
   other systems entirely unrelated to OHD. The refusal is
   logged at WARN every polling cycle until fixed and does
   NOT stamp `ftpLastSweepAt`, so the operator keeps seeing
   the log line every scan (throttle only applies to
   sweeps that actually ran). The refusal string is locked
   verbatim by test — see the "refuses at remotePath '/'"
   assertion in
   `src/main/services/__tests__/ftp-service-retention-sweep.test.js`.
2. **Never traverses outside the configured path.** Item
   names of `.`, `..`, empty string, or anything containing
   `/` or `\` are skipped with a WARN log — no path
   construction can produce a target above `remotePath`.
3. **Age from remote mtime**, not from when OHD downloaded.
   Reads `item.modifiedAt` (basic-ftp on MLSD-capable
   servers), falls back to `item.date` (LIST-only servers).
   Files with neither are skipped. A file no location has
   fetched still ages out; a file recently touched on the
   server is preserved.
4. **Never deletes a file OHD hasn't itself successfully
   downloaded and verified locally.** Per-file guard: local
   path (via the same `_sanitiseWindowsBasename` the download
   loop uses) must exist AND `fs.statSync().size` must match
   the FTP listing's size. Missing local, mismatched size,
   stat failure — all skip. This does NOT protect other
   locations (they might not have downloaded it) — see the
   known hazard below.
5. **Off by default.**
6. **Every deletion logged** at INFO with path, parsed mtime
   (ISO string), and computed age in days. This is the audit
   trail for when a lab asks where a file went.
7. **Dry-run** available (see above).

**Known hazard, in both UI help text and this entry:** a
location whose OHD is offline longer than the retention
window will permanently miss those orders' assets — the
sweep-enabling location will delete them from the shared FTP
folder before the offline location comes back to pick them
up. The failure mode is BENIGN in that it's visible (the job
stalls at the offline location rather than printing something
wrong) and no data is destroyed (every OTHER location holds
its own local copy of the artwork). An operator changing the
window must understand it has to exceed the longest outage
any site could reasonably have.

Guards #1 and #4 mean the worst a mis-set threshold can
produce is this documented hazard — not local data loss on
the OHD that runs the sweep, and not deletion of anything
OHD hasn't verified is safely stored locally. That framing
is why dry-run defaults to false: the damage is bounded to
"other locations' window is now shorter than it needed to
be", which is preferable to "nothing deletes, folder grows,
no operator-visible signal".

**Same-class discipline as the 1.15.0 lesson from PIC Pro's
save-time volume check** (recorded in CLAUDE.md's Landmines
section under the `dedupeAgainstDisk` entry): guard the
dangerous state at the point where the damage happens
(here: dispatch-time guards inside `_sweepOldFiles`), not
by refusing configurations that would have been safe under
the guards. The three UI knobs are unopinionated on their
own; the safety comes from the runtime guards.

**Follow-ups to revisit if the sweep is used at multiple
labs:**

- Sweep frequency: the 24h throttle is a fixed constant.
  If a lab wants a different cadence (e.g. every 12h, or
  weekly), that becomes another knob to add or a follow-up
  design conversation.
- Cross-location coordination: today the "only one location
  should enable it" instruction is UI-only. If two labs
  both enable it, the sweep runs on both — harmless but
  pointless. Making this mechanically-enforced (e.g. via
  an OrderHub API check) is not in this milestone.

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
- `fuji-jobmaker-file-writer.js` (line ~156, post-1.16.1) — same shape:
  `{surface}.txt.tmp` written into the JobMaker hot folder, then
  renamed to `{surface}.txt`. 1.16.1 investigation while adding
  `fujiImageRoot`:
    - **What is written:** the full `.txt` contents in one call to
      `fs.promises.writeFile(tmpPath, contents, 'utf-8')`, followed
      immediately by `fs.promises.rename(tmpPath, finalPath)`. One
      `.tmp` per surface file (a typical order has one surface, so
      one `.tmp` per dispatch).
    - **Where:** inside `hotFolderPath` (Frontier's watch folder) —
      the same directory as the final `.txt`.
    - **How long it exists:** writeFile → rename, no delay between.
      Milliseconds on a local disk; can stretch to seconds on a slow
      SMB share under contention. If OHD crashes between the two
      calls, the `.tmp` is left behind indefinitely; the next
      dispatch of the same `{surface}` overwrites it via writeFile's
      default truncate mode.
    - **Could Frontier match it?** Frontier's JobMaker watch is
      presumed to filter by the `.txt` extension. `.txt.tmp`'s
      actual last extension per `path.extname` is `.tmp`; if
      Frontier does an extension-based match (as its spec implies),
      the temp is safe. If it does a substring match on `.txt`
      anywhere in the filename, the temp is unsafe — a scan while
      the `.tmp` exists could ingest a partial file. **Presumed, not
      confirmed.** Same class as the pre-M7b PIC Pro `.ohdtmp`
      assumption, which is why this class of bug is worth closing
      as a group.
    - **Lower-risk than the PIC Pro case, but still latent.** The
      `.txt.tmp` name does not contain the order code — its
      structure is `{orderRef}_{surface}.txt.tmp` — so a scanner
      matching on order-code presence would still fire. And unlike
      the PIC Pro `.ohdtmp` folder (which was written recursively
      over seconds), this is a single file write followed by an
      atomic rename, so the exposure window is much smaller.
      Neither difference makes it safe, only lower probability.

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

**Push Film Scan thumbnails to S3 alongside the originals.** OHD generates
a 512px q85 JPEG thumbnail per frame under
`userData/thumbnails/{rollId}/{frameId}.jpg` at ingest — since this change,
whether or not AI rotation is enabled. Today those thumbs stay local; the
S3 upload step deliberately leaves them out of `storagePath` to save
upload bandwidth. OrderHub currently generates its own gallery-tile /
customer-email thumbnails from the full uploaded scans via an
edge-function thumbnailer, which has three real problems: a 5 MB decode
cap that rejects large scans, no TIFF decode support at all, and a race
with the outbound notification email (the email can send before the
thumb is ready, and the customer gets a broken image). OHD's sharp-based
pipeline has none of those limits — TIFF in, JPEG out, no per-file size
ceiling — so pushing OHD's thumbs to S3 alongside the originals would let
OrderHub replace the edge function with a static-asset fetch, eliminating
all three failure modes in one move.

Rough cost: 512px q85 is ~40-80 KB/frame → ~2-3 MB extra per 36-frame
roll. The "keep thumbs out of `storagePath`" decision predates this
use case and will need revisiting when the S3 push is built (either
upload thumbs from `userData/thumbnails/{rollId}/` directly, or stage
them into `{storagePath}/thumbnails/` at generation time and let the
existing folder-uploader carry them).

**Open naming decision — required before the S3 push ships.**
Thumbnail filenames today are `{rollId}_{frameIndex}.jpg`, which
does NOT encode the source image filename. `frameIndex` is the
position in a `readdirSync + sort` over the storage folder — stable
within a given roll but meaningless outside it. OrderHub cannot map
a thumbnail S3 key back to its source image from the key alone. The
source filename is stored only on the frame record
(`fileName: imageFile`). Three options for the S3 push, none
picked yet: (a) rename on upload to `${originalStem}.thumb.jpg`
so the S3 key mirrors the source; (b) publish a `frameIndex →
filename` manifest alongside the thumbs; (c) place the thumb at
an S3 key that mirrors the source key exactly (e.g.
`.../thumbs/{originalFilename}.jpg` next to the original). Pick
one BEFORE the S3 push ships — retrofitting a naming scheme
after OrderHub is already consuming a live convention becomes a
migration.

**Metadata is no longer a gap.** The rotation-decoupling change
(2026-... 1.16.3) made frame + roll records unconditional, so
rotation-off installs now carry the same per-frame context
(`fileName`, `rotation.skipped`, `rotation.reason`, etc.) as
rotation-on installs. The S3 push work can rely on per-frame
metadata being present regardless of the rotation flag. Prior
version of this entry noted this as an open concern; superseded.

**Perfectly Clear auto-apply is still gated on AI rotation having
actually run.** In `folder-watch-service.js` the PC block sits
under `if (rotationRan) { … }`, so PC's own feature flag
(`config.perfectlyClear.filmScans.enabled` +
`autoApplyConfigId`) does NOT fire when
`filmScanRotationEnabled === false` or when the orientation
service failed to init. Pre-decoupling this was
`if (config.filmScanRotationEnabled)`; the rotation-decoupling
change moved it to the runtime `rotationRan` flag — same effect,
but this is now the ONE remaining rotation gate in the film-scans
path (frame recording, roll recording, provisional pill,
Step 3 upload status updates all lost their rotation gates).

The gap: a lab that has Perfectly Clear enabled for film scans
but AI rotation off gets no enhancement at all. This is the
same shape of gap as the frame/roll recording one the
rotation-decoupling change closed. Leaving it as a code comment
(`// Still gated on rotation having run — decoupling PC from
rotation is a separate concern outside this change's scope`)
keeps it invisible until someone hits it.

Decoupling scope, when this is picked up:
- Hoist the PC block out of `if (rotationRan)` in
  `folder-watch-service.js`. Keep its own `pcCfg` gate — a
  PC-off install must be unaffected.
- Audit that the per-frame PC update path
  (`frameMetadataStore.update(frameId, { pcEnhanced, … })`)
  works when the frame's `rotation` is state C
  (`{ skipped: true, reason: … }`). Should be fine because PC
  only reads/writes its own `pcEnhanced` / `pcRejected` fields,
  but worth locking with a test.
- Confirm `pcRejectedCount` continues to feed Smart Check's
  rotation-off signal path — today it already does (the smart
  triggered check reads `pcRejectedCount` regardless of
  rotation state), which naturally becomes the correct answer
  once PC runs there.
- Consider whether the "Enhancing…" processingStatus pill in
  the Film Review panel needs a rotation-off variant (today
  it appears for rotation-on rolls only, but that's because
  rotation-off rolls didn't reach PC).

No lab has reported this because rotation-off + PC-on has been
a rare configuration to date; revisit if one turns up or when
the rotation-off Film Review path picks up more users after
1.16.3.

---

Older items from before 1.8.0 — the working-set divergence Phase 2, the FTP 550 noise on
customer-original paths, the film gallery/email workflow plan — are not repeated here.
They're recorded in project memory and in their own `docs/` files.
