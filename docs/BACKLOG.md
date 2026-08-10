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

**Flaky test.** `perfectlyClearClient.test.js` — "stability polling" and "hard wall-clock
deadline" fail intermittently under full-suite load. A ~30 ms write race, pre-existing,
untouched by 1.8.0. Re-run before believing a red suite.

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

---

Older items from before 1.8.0 — the working-set divergence Phase 2, the FTP 550 noise on
customer-original paths, the film gallery/email workflow plan — are not repeated here.
They're recorded in project memory and in their own `docs/` files.
