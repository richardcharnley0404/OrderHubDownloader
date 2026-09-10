# Rush-Reprint Controller Selection — Investigation

Read-only investigation, no code changes. Deliverable is this document.

## The lab's problem, restated

A client runs Darkroom Pro connected to two Fuji printers, a DL650 and a DL400.
All orders route to the 650 today: a 4×6 lustre product maps to a Darkroom Pro
controller whose channel mapping emits `Size=4x6` / `Media=Thick Luster`, and
Darkroom sends that to the 650. When a walk-in customer wants prints now, the
job joins the back of the 650's queue and can take hours.

Darkroom can route on media — configure it so `4x6` + `Lustre` goes to the 400
instead. So the escape hatch is: get OHD to emit a **different `Media=` value**
for a single rush job.

The lab's proposal: create a SECOND Darkroom Pro controller ("Darkroom Pro
400") whose channel mappings emit `Media=Lustre` where the first ("Darkroom
Pro 650") emits `Media=Thick Luster`. Normal orders keep going to the 650.
For a rush, the operator cancels the queued parent inside Darkroom on the 650
and reprints the job to the 400 via OHD.

## Corrections to the premises you handed me

Most of what you established is correct. Two amendments:

1. **DarkroomProMonitor is live and per-controller.** You said you could not
   find a construction site. It exists — `src/main/services/print-controller-service.js:130`
   inside `startMonitoring(controllerId)`:
   ```js
   if (controller.type === 'darkroompro') {
     const monitor = new DarkroomProMonitor();
     const processedFolderName = controller.processedFolderName || 'processed';
     monitor.startMonitoring(hotFolderPath, processedFolderName, onStatusChange);
     this.monitors.set(controllerId, monitor);  // Map<controllerId, monitor>
   ```
   The map is keyed by `controllerId` (`print-controller-service.js:17`).
   Startup wires this up eagerly via `polling-service._startAllMonitors` →
   `printControllerService.startMonitoring(controllerId)`. Two DP controllers
   get two independent `fs.watch` instances on two hot folders. The docblock's
   "one instance per Darkroom Pro controller" claim is accurate as-written.

2. **`resolveRouteForController` is close but not identical to `resolveRoute`
   for Darkroom Pro.** It returns the generic DPOF/Darkroom shape at
   `routing-service.js:884–919`. That shape carries `controllerType`,
   `controllerId`, `controllerName`, `outputPath`, `channelMappingId`,
   `channelNumber`, `printSizeCode`, `checkOrderStatus`, `bannerSheet`,
   `maxPrintsPerJob`, `autoSendBatches`. It does **not** carry
   `artworkRootPath` or `orderLastNameFormat`, both of which the
   `resolveRoute` DP branch does return (`routing-service.js:528–529`) and
   both of which `_sendReprintViaDarkroomPro` reads directly off `route`
   (`print-service.js:1366–1367`). See Q2 for what that means for the
   change.

Everything else in your write-up checks out: `orderControllers[]` keyed by
`id`, channel mappings by `controllerId` (see `routing-service.js:484–486`,
`553–556`); DP `Media=` from the matched channel (docblock line 37, emitter
line 124); `ohd:reprint:create` → `printService.sendReprint(parentJob, …)`
→ `resolveRoute(parentJob)` (`print-service.js:1180`) with no controller
parameter; `resolveRouteForController` docblock ("operator's controller
choice is authoritative, bypassing Layers 1 and 2") is accurate, and
`routing:releaseHold` already uses it (`ipc-handlers.js:2167`).

## Q1 — Is a second controller of the same type safe at runtime?

**Yes, with two caveats.** Per-controller keying is honoured almost
everywhere:

- **Monitors.** Per-`controllerId` (see the correction above). Two DP
  controllers → two watchers. `folder-monitor.js` (DPOF) does the same
  via `polling-service.js:788` `this.folderMonitors.set(target.id, monitor)`.
- **Dispatch.** `print-service.js` picks the controller through the route
  object, which carries `route.controllerId`; `_sendReprintViaDarkroomPro`
  then does `getControllers().find(c => c.id === route.controllerId)` at
  `print-service.js:1362–1363` to fetch the full record for translation
  tables. No "first darkroompro controller" shortcut anywhere.
- **Channel mapping lookup.** Every branch filters by `m.controllerId ===
  controller.id` (`routing-service.js:479, 484, 553, 618, 693, 721, 871`).
- **Routing store CRUD.** `getControllers` / `addOrUpdateController` /
  `deleteController` are all id-keyed (`routing-service.js:928–964`); the
  cascading channel-mapping delete filters by `m.controllerId !== id`
  (`:964`).
- **Filename shape.** DP writes `{job_name}.txt` (or `{job_name}_{batch}.txt`
  when split). `job_name` is unique per job across the whole OrderHub
  world, so two DP controllers writing to *different* hot folders can
  never collide.

Caveat #1 — **legacy `print-controllers.json` migration.** `routing-service.js`
migration code deliberately does NOT migrate DP controllers from the legacy
store — a comment at `routing-service.js:1350` (approx.) explains they're
kept in the legacy store as the source-of-truth, then dual-written on save.
Adding a second DP controller through Settings will write to *both* stores
under a new id; this is idempotent and safe, but the operator will only
see the correct state after saving once through the Settings UI.

Caveat #2 — **same-outputPath misconfiguration.** `outputPath` is a
per-controller field. Nothing enforces uniqueness. If an operator points
BOTH DP controllers at the *same* hot folder, the filename shape
(`{job_name}.txt`) still keeps parent and reprint distinct in that folder,
but two questions arise that the code does not answer:

- Which controller's `mediaTranslations` and `sizeTranslations` won at
  dispatch would still be right — dispatch chooses by the route's
  `controllerId`, not by folder — so the `Media=` inside the `.txt`
  would carry whichever controller was chosen. Darkroom itself picks
  the printer off the `Media=`, not the folder. So there IS a real
  scenario where "both at the same folder" works: Darkroom Pro on
  one PC watching one folder, with its media-routing config sending
  `Thick Luster` to the 650 and `Lustre` to the 400. But it's fragile,
  and the two monitors would race on the .TXT-disappearance event —
  whichever `fs.watch` callback fires first would attribute the
  ACCEPTED signal to its controllerId in the (dead — see Q5) legacy
  jobStore.
- The routing config is opaque about which is which. The operator has
  to keep it straight in their head.

I would not block same-folder as an operator error; I'd flag it in
Settings as a warning ("This controller shares its hot folder with X;
media routing must be configured on the Darkroom side").

**Other places I checked and found safe** (Q1 asked for the checked-safe
list too):

- No ledger / output-status collection keyed by controller `type`. Per-job
  status is API-driven through `jobService.updateJobLocally` and does not
  hold a controller-type map.
- Order-number prefix rules (`orderNumberPrefixRules`) live on the
  controller record and are read per-controller, not per-type.
- Backup/restore surface (settings export) writes `orderControllers`
  as an opaque array — no dedup, no merge.
- Test-print harness (`test-print-controller.js`, dev-only per CLAUDE.md)
  operates on a passed-in controller id, not a type lookup.

## Q2 — What would the reprint flow need?

**Renderer → dispatcher chain today.**

`SendReprintAction` (`src/renderer/views/JobReview/index.jsx:185`) →
`useJobReview.sendReprints` (`useJobReview.js:521`) →
`window.electronAPI.reprintCreate({ jobId, jobPath })` →
`preload.js:167` `ipcRenderer.invoke('ohd:reprint:create', payload)` →
`ipc-handlers.js:2986` handler → `printService.sendReprint(parentJob,
reprintJobPath, reprintSuffix, reprintImages)` →
`print-service.js:1180` `resolveRoute(parentJob)` →
`print-service.js:1195` type-switch → `_sendReprintViaDarkroomPro`.

**Minimal change to thread an optional controller id.** Four sites, none
structural:

1. Renderer callsite adds `controllerId` to the payload (optional; null
   preserves today's behaviour).
2. Preload passes it through unchanged.
3. IPC handler forwards it to `sendReprint(parentJob, …, controllerId)`.
4. `sendReprint` chooses `resolveRouteForController(parentJob,
   controllerId)` when `controllerId` is present, otherwise the current
   `resolveRoute(parentJob)`. Everything after — `_sendReprintViaX` — is
   already route-shaped and does not care where the route came from.

**What does NOT change.** `_sendReprintViaDarkroomPro` already fetches
the full controller for its own reasons (`print-service.js:1362–1363`)
and reads translation tables + photo lines off it. All downstream code
(image assembly, corrections, generator invocation, log line) is
route-driven.

**One real gotcha.** `_sendReprintViaDarkroomPro` reads
`route.artworkRootPath` and `route.orderLastNameFormat`
(`print-service.js:1366–1367`). `resolveRouteForController` does not
populate those two fields on its Darkroom branch (`routing-service.js:884–919`
returns a shape that omits them). Two clean options:

- **(a)** Extend `resolveRouteForController` for `darkroompro` so the
  reassignment route is a strict superset of the DPOF/Darkroom generic
  shape and *includes* both fields. This preserves the docblock's
  invariant that a reassignment route matches a normal route
  ("same shape resolveRoute produces"). The `routing:releaseHold`
  path would inherit the fix automatically.
- **(b)** Have `_sendReprintViaDarkroomPro` pull those two fields off
  `fullController` (which it already fetches) instead of `route`. Smaller
  diff, but breaks the resolveRoute/resolveRouteForController shape
  parity that the `routing:releaseHold` flow relies on today for
  correctness on Darkroom.

I'd take **(a)**. It is the same class of "one implementation of the
resolver" hygiene the `deriveTrim` and `buildDestFolder` landmines in
CLAUDE.md are warning against. Not doing it invites a bug where a
Darkroom Pro job released from routing hold via reassign produces a
subtly different `.txt` (empty `artworkRootPath` in the header) than
the same job routed the normal way — a class of drift that only shows
up when someone happens to test that specific config.

## Q3 — One-shot versus sticky

**One-shot is cleanly achievable without persisting anything.**

`resolveRouteForController` reads nothing per-job — it looks up the
controller by id, then finds the channel mapping by `controllerId +
productCode + options` (`routing-service.js:816, 870–875`). No
reference to `_channelMappingOverride`, `_routingHoldReleased`, or any
per-job stored state.

`_sendReprintViaDarkroomPro` reads only:

- fields off the `route` object (`controllerId`, `controllerName`,
  `outputPath`, `artworkRootPath`, `orderLastNameFormat`, plus the two
  missing ones above);
- fields off the `parentJob` object (`customer_name`, `options`,
  `product_code`, `id`, `job_name`, `order_number`,
  `_darkroomProSize`/`_darkroomProMedia` — but only as *overrides*,
  never as controller pointers);
- the full controller fetched by `getControllers().find(c => c.id ===
  route.controllerId)` for translation tables.

None of that reads a persisted per-job "override controller". So passing
the controller id at the reprint edge, resolving to a route on the fly,
and dispatching in the same call requires zero writes back to the parent
job's routing state.

**Contrast with `routing:releaseHold`.** That path persists
`_channelMappingOverride` on the job (`ipc-handlers.js:2194`) because
the job hasn't been dispatched yet — it's a still-held job in the auto-
print gate, and the later dispatch call needs to know at that time
which mapping to use. The reprint case is genuinely different: dispatch
happens synchronously inside the same IPC call that took the controller
choice.

**Consequence.** After a rush reprint the parent job's routing config
is untouched, `_channelMappingOverride` is not set, `_routingReleasedTo`
is not set. The next time that parent job is anything — an auto-print
retry, a re-dispatch, another reprint — it routes exactly as it would
have before the rush.

## Q4 — What must the lab configure, exactly?

Setup (numbered for the operator):

1. In Settings → Print Controllers, click Add Controller → type =
   "Darkroom Pro". Name it "DP-400" (or similar). Point `outputPath`
   at the DL-400's hot folder — a *different* folder from the 650's.
2. Save. This writes the new controller to `orderControllers[]` and
   dual-writes it into the legacy `print-controllers.json` store so
   `PrintControllerService` picks it up on the next startup (or
   restart-monitors call). The monitor starts eagerly on startup;
   after the first save the app doesn't strictly need a restart, but
   restarting is the safe thing to tell an operator.
3. In Settings → Channel Mappings, add per-product mappings for the
   400 exactly parallel to the 650's, but with the different `Media`
   value that Darkroom's own routing config uses to send that media
   to the 400. If the lab uses `sizeTranslations` /
   `mediaTranslations` instead of per-product channel mappings,
   configure the same translation tables on the new controller with
   the different `Media` values.
4. Leave all process→controller mappings pointing at the 650. Normal
   traffic keeps going where it does today.

**No-mapping failure mode.** If the operator triggers a rush reprint
of a product the 400 has no channel mapping for and no translation
covers, `resolveRouteForController` returns `{ type: 'unrouted',
reason: 'no-channel', controller }` (`routing-service.js:876–877`).
`sendReprint` currently handles `unrouted` at `print-service.js:1182–1187`
by returning `{ success: false, error: "Parent job has no usable route
(reason: no-channel). Configure routing in Settings before sending a
reprint." }`. **The renderer then surfaces this as `reprintError` — a
red pill in the top bar of Job Review with a "Retry Send" button.**

That is a dead end mid-rush. The existing Assign Channel modal (the
one auto-print uses when a fresh job has no channel) is not chained
into the reprint path today. If we ship this feature, either:

- accept the dead end and tell the operator "the 400 needs a mapping
  for this product — set it up in Settings, then retry"; or
- chain into the Assign modal from the reprint error (whichever
  controller the reprint targeted), which is a bigger UI change and
  more state to reason about.

I would ship the dead end first. Rushes on unmapped products are the
lab's problem to configure ahead of time; the mid-rush recovery UX is
optimising for a case that shouldn't happen in a well-configured
install.

## Q5 — Status and visibility after a rush reprint

**Post-acceptance cancels inside Darkroom are invisible to OHD.**
Confirmed. `darkroom-pro-monitor.js` emits exactly two events:

- ACCEPTED (`.js:93–107`) — the `.TXT` disappearing from the hot
  folder (Darkroom moved it into `processed/`).
- FAILED (`.js:110–135`) — a `.err` file appearing with the same
  base name (Darkroom rejected the file).

There is no other signal path — no watcher on Darkroom's internal
queue, no status file follow-up, no callback API. Once the `.TXT`
disappears the monitor forgets the tracked file (`this.trackedFiles.delete(key)`
at `:98`) and can never say anything about it again. A post-acceptance
cancel inside Darkroom's UI produces neither event.

**A related, wider issue you should know about.** The monitor's
callback in `print-controller-service.js:102–109` writes ACCEPTED
and FAILED back through `jobStore.updateJobStatus(status.orderNumber,
status.status)`. `jobStore` is the legacy `jobs.json` store which
CLAUDE.md describes as effectively dead in production — the Jobs
grid reads from the API-driven `jobService` cache, not from
`jobStore`. So the DP monitor's outputs today don't actually affect
anything the operator sees for the parent job. This is a pre-existing
condition, not introduced by dual DP; it means DP dispatch is
effectively fire-and-forget from the Jobs grid's point of view even
now. The Activity Log tab reads Winston, and the monitor logs to
Winston (`print-controller-service.js:104`), so the accepted/failed
transitions are visible in Activity Log — just not in the grid.

**What the operator actually sees after the described sequence.**
Parent job dispatched to 650, later cancelled inside Darkroom on
the 650. The parent job's row in the Jobs grid shows whatever
OrderHub-side status was set by dispatch — typically
`in_production` if dispatch called `_markInProduction`, or
`completed` if the flow that fires for DP dispatch reaches
`_markCompleted`. There is no destination-controller column, no
"was cancelled at the printer" indicator, no visual trace of the
cancel. The reprint row (`{jobId}-r1`) appears next to the parent
in the grid; it looks structurally identical to any other reprint
row and gives no visual hint that it targeted the 400 rather than
the 650.

**Attribution — is the destination controller recorded anywhere?**
Not on the parent job. Not in the reprint sidecar. Grep for
`_controllerId` / `_controllerName` / `sentTo` / `dispatchedTo`
across `src/` finds only one field: `_routingReleasedTo` — set at
`ipc-handlers.js:2196` and preserved in `job-service.js:517`, but
ONLY on jobs that went through routing-hold release. A normal
auto-print dispatch does not set it. The reprint sidecar
(`jobSchema.js` `createSidecar`) carries `jobId`, `schemaVersion`,
`createdAt`, `modifiedAt`, `reprintOf`, `images`,
`s3ArtworkFileIdsKnown`, `batchCropLastAppliedAt` — no destination
field.

Winston does log the controller name on every DP dispatch
(`print-service.js:187–193` for parent, `1388–1394` for reprint),
so the Activity Log surfaces the destination for the digging
operator. Nothing in the Jobs grid does.

**Bottom line for the lab.** The rush reprint will print at the 400
(assuming Darkroom's own routing is set up right). The operator has
to remember which controller they picked, because the UI won't tell
them afterwards. If they need to prove to a customer or a supervisor
that r1 went to the 400, the Activity Log is where that evidence lives.

## Q6 — UI shape options for the controller choice

The Reprint action is only surfaced inside the Job Review drawer
(`SendReprintAction` at `src/renderer/views/JobReview/index.jsx:185`).
Its normal shape is a single button:
`Send N Image(s) for Reprint` (or `… (P prints) for Reprint`). No
picker today.

Three options, trade-offs:

**Option A — Split button with a small chevron.** The primary button
stays exactly as today; click sends to the parent's route (unchanged
behaviour, one click). A small chevron opens a menu of the other
`darkroompro` controllers configured in the same install; picking
one dispatches immediately to that controller.
- *Pro:* preserves the common-case one-click.
- *Pro:* discoverable — the chevron is visible without a click.
- *Con:* takes horizontal space in a top bar that already carries
  `SENDING…` / `sent ✓` / `⚠ error` pill states in the same slot.
  Not a blocker, but a design constraint.
- *Con:* what happens when there is only ONE DP controller configured?
  The chevron should hide (no meaningful choice). That's a small
  conditional but worth calling out — the split button becomes a
  plain button in the common case.

**Option B — Modifier key opens a picker.** Click sends to the
parent's route (same one-click); Ctrl-click (or Alt-click) opens a
modal listing the other DP controllers; picking one dispatches.
- *Pro:* zero visual change to the common case.
- *Con:* undiscoverable. The lab operator is the only person who
  benefits from the feature, and they will not find a modifier they
  don't know about. Would need a tooltip or a hint elsewhere.

**Option C — Always show the picker for reprints.** The button
becomes "Send for Reprint…" (with an ellipsis) and always opens a
modal. Default is pre-selected to the parent's route.
- *Pro:* honest — every reprint is explicit about where it goes.
- *Pro:* consistent with how the Assign Channel modal already
  operates for held jobs.
- *Con:* slows the common case with an extra click and a modal
  dismissal. Reprint is the not-a-rush case 99% of the time.

**Sticky preferences: don't.** A "last DP controller wins" sticky
default is dangerous here — the rush case is *exceptional*, and
having a rush reprint set the default for the next non-rush reprint
means the next non-rush reprint quietly goes to the 400 too. Every
sticky-default feature has this failure mode; the cost of the
mistake here is a print landing on the wrong printer with no
warning.

My recommendation is **Option A**. Aligning with the existing
one-click flow, discoverable, and the chevron collapses cleanly to
nothing in the single-controller install. Whatever modal Option A's
menu leads to would inherit the 1.16.3 dirty-check dismissal work
you named — the reprint picker itself doesn't hold editable state,
so dirty-check has nothing to guard, but any secondary "Assign
channel on DP-400" modal that opens off a no-channel error would.

## Assessment of the lab's proposal

The proposal is mechanically sound. Media is per-mapping-per-controller
(`darkroom-pro-generator.js:37, 124`), the monitor is per-controller,
routing lookup is id-keyed, dispatch reads the full controller from the
route's id, and one-shot is clean because nothing between the reprint
edge and the .txt writer reads a per-job routing override.

**Two things weaker than they look.**

1. **The cancel is invisible.** Once the parent's `.TXT` disappears
   from the 650's hot folder, OHD cannot see the Darkroom-side cancel.
   The parent will still show `in_production` (or `completed`, whichever
   the dispatch flow set) forever unless someone manually corrects it.
   If the lab is used to that state already for other reasons (the
   monitor writes to a dead store today; see Q5), it's not a
   regression. It's still a footgun for the "how did that job end up
   at the 650?" postmortem three weeks later.
2. **Attribution is missing.** No one — grid, sidecar, ledger — records
   which controller a reprint went to. The Activity Log has it in
   Winston, but the Jobs grid doesn't. If the lab plans to run this
   flow tens of times a day, "which printer did r1 go to?" will be a
   question they can only answer by opening the Activity Log.

**Is there a different approach?** Two alternatives worth mentioning
without recommending them:

- **Have Darkroom Pro route on order metadata (a customer field), and
  push a "rush" flag from OHD into that field.** Requires no OHD code
  change beyond a new template extension for a Darkroom `Ext*=` field
  the lab configures Darkroom to route on. Cheapest to build. Downside:
  couples OHD to a lab-specific Darkroom config, invisible to anyone
  else looking at the setup later, and the rush flag is a per-job
  attribute we'd need to plumb through the reprint UI anyway.
- **Model the rush case as "cancel the parent inside OHD then re-route
  the parent, not a reprint."** More correct semantically — the parent
  IS the print, it just needs to go to a different printer. But OHD
  has no "cancel a dispatched job" primitive, and even if it did the
  cancel wouldn't reach Darkroom (same invisibility as Q5). Not worth
  it.

**Recommendation.** Ship the lab's proposal — second DP controller +
optional `controllerId` on the reprint edge + Option A UI — with the
Q2 shape gap in `resolveRouteForController` fixed as part of the same
change (option (a) in Q2). Fix the attribution gap in a follow-up:
persist `_reprintDispatchedTo: controllerName` on the reprint sidecar
at dispatch time and add a small chip on the r1 row in the Jobs grid
that shows it. Do NOT add a sticky "last controller" default. Do NOT
try to make the cancel visible.
