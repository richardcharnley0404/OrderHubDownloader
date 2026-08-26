# Fuji PIC Pro cross-volume delivery — investigation and design

**Status.** Investigation and design only. No code changes in this pass.

**Trigger.** A PIC Pro lab reported that after upgrading to v1.15.2, save
succeeds but per-order subfolders never move from staging into DIGIN. Their
paths are four separate UNC shares on one server:

| Setting | Value |
|---|---|
| Image Staging Root | `\\Labserver1\Pixfizz Digin Staging` |
| Order Data Path | `\\Labserver1\Order Data` |
| DIGIN Path | `\\labserver1\Digin` |
| Merge Data Path | `\\labserver1\Merge Data` |

**Working hypothesis (confirmed below).** The 1.15.0 M7b commit deleted the
only delivery mechanism this lab's configuration supported. The 1.15.1 M7c
commit un-blocked the save, but did nothing about delivery. Every dispatched
order today reaches `_stepDelivering`, throws EXDEV, resolves silently as
`failed`, and leaves the staged folder in Image Staging Root. The operator
sees nothing on the Jobs grid — the job stays "in production".

---

## Part 1 — facts

### 1.1 The deleted fallback

**Commit.** `017652a` — *fix(fuji-pic-pro): enforce staging/DIGIN co-location,
delete the EXDEV slow path* (2026-08-18, M7b).

**What was removed (`src/main/services/fuji-pic-pro-file-writer.js`, pre-M7b).**
The `deliverToDigin` function's EXDEV branch, plus its `_copyDirRecursive`
helper and the `DIGIN_COPY_TMP_SUFFIX = '.ohdtmp'` constant. The pre-M7b flow:

```js
// Fast path — same-volume rename.
try {
  await fsPromises.rename(stagingFolder, destFolder);
  return { destFolder, method: 'rename' };
} catch (err) {
  if (!err || err.code !== 'EXDEV') { throw err; }
  // Cross-volume: fall through to the copy path.
  log.logWarning('[fuji-pic-pro] staging and DIGIN are on different volumes …');
}

// Slow path — copy into `.ohdtmp`, rename in place, then remove staging.
const tmpDest = destFolder + DIGIN_COPY_TMP_SUFFIX;  // = {diginPath}/{orderId}.ohdtmp
try { await fsPromises.rm(tmpDest, { recursive: true, force: true }); } catch (_) {}
try {
  await _copyDirRecursive(stagingFolder, tmpDest, fsPromises);
  await fsPromises.rename(tmpDest, destFolder);
} catch (copyErr) {
  try { await fsPromises.rm(tmpDest, { recursive: true, force: true }); } catch (_) {}
  throw copyErr;
}
try { await fsPromises.rm(stagingFolder, { recursive: true, force: true }); } catch (…) {}
return { destFolder, method: 'copy' };
```

Answers:

- **Temp folder full path & naming scheme:** `{diginPath}/{orderId}.ohdtmp` —
  literally the final path with `.ohdtmp` appended. It contained the order
  code, sat **inside DIGIN**, and was the ONLY writer of the `.ohdtmp`
  suffix in the repo.
- **Copy-then-rename, or copy-in-place:** copy-then-rename. Recursive copy
  into `.ohdtmp`, then `rename(.ohdtmp → {orderId})` as the reveal step.
- **Cleanup on success:** best-effort `rm(stagingFolder)`.
- **Cleanup on failure or crash mid-copy:** three separate mechanisms:
  - **Fix 8 (pre-stage wipe):** the *next* dispatch of the same orderId
    would `rm -rf {stagingFolder}` before staging.
  - **Fix 10 (pre-copy wipe):** the current dispatch would `rm -rf`
    `{tmpDest}` before starting the copy, so a leftover `.ohdtmp` from a
    crashed prior run couldn't merge into the fresh copy.
  - **In-catch cleanup:** on a copy/rename error, `rm(tmpDest)` before
    rethrowing.

### 1.2 The phantom order's real mechanism

**Confidence: high, mechanism (a) — watcher ingested the temp folder
mid-copy.** Both the commit message (`017652a`) and the operator release
notes (`docs/RELEASE-NOTES-1.15.0-operator.md:37-50`) describe the same
mechanism from independent framings:

> "PIC Pro's DIGIN watcher ingested the .ohdtmp folder mid-copy (blank
> order), then re-ingested the renamed folder (correct order)."
> — commit body

> "PIC Pro's watcher was picking up the temp folder mid-copy, ingesting
> it as a blank order, and then also ingesting the real one — one good
> order, one blank duplicate."
> — release notes 1.15.0

**What discriminates (a) from (b):** the customer reported *every* order
arriving twice. A leftover-after-failure mechanism (b) would show only after
crashes; it wouldn't produce a duplicate on every dispatch. Mechanism (a)
races on every cross-volume delivery. The universality points at (a).

**Corroborating detail.** The `.ohdtmp` suffix in the phantom folder's name
in DIGIN is the pre-M7b writer's constant. Fix 10's pre-copy wipe rules out
any world where a stale leftover survived — so the folder must have been
present at ingest time either because (a) PIC Pro scanned during the copy
window, or (b) PIC Pro scanned after the copy but before the rename. Both
are the same race, both are mechanism (a).

**What (b) would have required and doesn't fit.** For "leftover after
failure" to be the mechanism, we would expect duplicates to correlate with
prior failures (not every order), and we would expect fix 10 to have
prevented the duplicate on retry (which the customer reported did not
happen). Neither holds.

**The assumption that failed.** The pre-M7b comment above the copy path
asserted "Frontier's DIGIN watch ignores it until the rename lands
(Frontier only picks up folders whose names look like OrderIds, not our tmp
sibling)". That was an assertion about a third-party product written as
fact. The customer disproved it: PIC Pro treated `{orderId}.ohdtmp` as
`{orderId}` (or at least ingested it), producing a blank duplicate.

### 1.3 Current EXDEV behaviour (this is where the lab is stuck)

Trace, dispatch to failure:

1. `src/main/services/print-service.js:2973 _sendViaFujiPicProRouted` stages
   images, writes the `.txt` (atomic), enqueues, calls `markCommitted`, then
   `_markInProduction(job.id)` and returns `{success: true}` synchronously.
   **The Jobs grid shows "in production" from this point.**
2. The monitor's state machine advances the entry through
   `awaiting-gateway` (until `_classifyPath` returns `absent` twice for
   `{orderDataPath}/{orderId}.txt`) into `delivering`.
3. `src/main/services/fuji-pic-pro-monitor.js:563 _stepDelivering` calls
   `deliverToDigin`.
4. `rename(stagingFolder, destFolder)` throws EXDEV (the lab's two paths
   are on different physical volumes even though they're on the same
   server).
5. `src/main/services/fuji-pic-pro-file-writer.js:286-302` catches EXDEV and
   throws the operator-friendly message ("Image Staging Root and DIGIN Path
   must be on the same volume … Fix: in Settings → Routing → Edit this
   controller, move Image Staging Root onto the same volume as DIGIN
   Path…").
6. `_stepDelivering` catches (fuji-pic-pro-monitor.js:573-582):
   - `logger.logError('[fuji-pic-pro] DIGIN delivery failed', err, …)` —
     the full error message hits Winston, visible in the Activity Log tab.
   - `_resolveEntry(entry, 'failed', now)`.
7. `_resolveEntry` (fuji-pic-pro-monitor.js:663-671) deletes the pending
   entry, persists, and calls `_emit(entry, 'failed', now)`.
8. `_emit` fires the callback with `{orderRef, status: 'failed', phase,
   timestamp}`. **The error message is stripped by the callback shape.**
9. `src/main/services/print-controller-service.js:199-213 onPicProStatus`
   receives the event, logs `logger.warn('Fuji PIC Pro submission did not
   complete cleanly', {…})` — again, no error message, just orderRef +
   phase + status — and calls `onStatusChange({orderNumber, status:
   'failed', timestamp})`.
10. `onStatusChange` (print-controller-service.js:102-109) calls
    `jobStore.updateJobStatus(orderNumber, 'failed')` on the legacy
    JobStore. Per `CLAUDE.md`: "job-store.js / jobs.json are effectively
    dead in production; only the dev-only test-print-controller.js harness
    writes to them." So this write is invisible.

**Answers to the specific questions:**

- **Caught or propagated:** caught. Never reaches an uncaught-exception
  path.
- **Exact error message:** the operator-friendly text from
  `deliverToDigin`'s EXDEV branch (fuji-pic-pro-file-writer.js:287-294).
- **Where it goes:** Winston `logError` inside `_stepDelivering`
  (with full message); Winston `warn` inside `onPicProStatus` (without
  message). Both appear in the Activity Log tab.
- **Visible in OHD UI?** **NO.** This is a second, real defect. The Jobs
  grid shows "in production" indefinitely because `_markInProduction` was
  called at dispatch and nothing on the async failure path calls
  `updateJobLocally({_status: 'error', _errorMessage})`. Every other
  synchronous failure path in `_sendViaFujiPicProRouted` (missing route
  fields, stage failure, generation failure, write failure) does exactly
  that (search `print-service.js` for `updateJobLocally.*_status.*error`);
  the async delivery failure path is the one that skips it. Naming this
  as a defect independent of the cross-volume issue: **an async
  post-dispatch delivery failure must set the job to error with the
  message the writer produced, not stay "in production".**
- **Retried, held, or abandoned:** abandoned. `_resolveEntry` deletes the
  pending entry. No retry, no hold. The next dispatch of the same job
  would re-enqueue (a fresh dispatch is allowed after resolution), but
  there is no auto-retry path.
- **Staged folder left behind:** yes.
  `{imageStagingRoot}/{orderId}/` remains until the next dispatch of the
  same orderId wipes it (fix-8 pre-stage wipe in `stageImages`, line
  105). For a job the operator gives up on, the folder lingers.

### 1.4 The 1.15.1 advisory check

`src/main/services/fuji-pic-pro-file-writer.js:458 isSameVolume` — pure
string compare of parsed volume roots (drive letter for local, `host+share`
for UNC). Returns:

- `certain-same` — same drive letter, OR same UNC host+share.
- `certain-different` — different drive letters, OR different UNC hosts.
- `indeterminate` — same UNC host but different shares (the lab's shape);
  local-vs-UNC; unparseable.

Caller: `src/main/ipc-handlers.js:1440-1460` (in `ohd:routing:save-controller`).
The save behaviour:

- `certain-same` → save silently.
- Anything else (`certain-different` OR any `indeterminate`) → save AND
  push a `picpro-volume-uncertain` warning onto the modal's `warnings[]`.
- **Never rejects a save.** Confirmed by inspection: the block is inside
  a `warnings.push(…)` accumulator; the surrounding function returns
  `{success: true, warnings}` regardless of the volume verdict. The
  `warnings[]` renders as an advisory dialog after the save completes.

Confirmed cannot reject: separate UNC shares (the lab's shape → verdict
`indeterminate: same-server-different-share` → warning only), mapped
drives, same-server-different-share, local paths.

### 1.5 Delivery trigger sequence

`_sendViaFujiPicProRouted` → `writeOrderFile` (`.tmp` + rename into
Order Data, atomic) → `enqueueSubmission` + `markCommitted` → returns
success. All synchronous.

The monitor's `_stepAwaitingGateway`
(fuji-pic-pro-monitor.js:491-561) then polls `{orderDataPath}/{orderId}.txt`
via `_classifyPath` on the sweep interval (1s while pending, 60s idle).
Advances to `delivering` on **two consecutive `absent` observations**
(fix 3, SMB-blip guard). Timeout: `gatewayTimeoutMs` (default 120s).

If the timeout fires with the .txt still present (OrderGateway not
running / watching wrong folder), the .txt is best-effort unlinked and
the entry resolves as `failed`.

**Rules out the "move never triggered" alternative.** For the lab, the
customer's observation is that saves succeed and jobs get sent, but the
DIGIN folder never appears. That's the delivering-phase EXDEV failure —
not the awaiting-gateway timeout. If OrderGateway weren't consuming the
.txt, the operator would see a different log line
(`[fuji-pic-pro] cleaned up unconsumed .txt after gateway timeout`,
monitor.js:548) rather than the deliverToDigin EXDEV error.

### 1.6 Completion detection landmine

`_stepBuilding` (fuji-pic-pro-monitor.js:586-626) compares
`path.join(entry.diginPath, entry.orderId)` — the exact folder name — via
`_classifyPath`. A temp folder named `{orderId}.something` or
`.ohd-inbox-{GUID}` does not match this join, so its appearance /
disappearance cannot fire the completion signal.

The invariant a redesign must preserve is: **`{diginPath}/{orderId}`
comes into existence exactly once, as the final delivered folder, at the
moment we transition into `building`.** Any design that introduces a
transient `{diginPath}/{orderId}` before the real delivery — or that
lets the state machine enter `building` before the folder exists — would
break the disappearance-based completion signal (which needs the folder
to have existed for its subsequent absence to mean "PIC Pro consumed
it").

Both candidate designs below preserve this invariant.

### 1.7 Blast radius

The 1.15.0 removal was scoped to Fuji PIC Pro. No other controller path
depends on cross-volume folder rename. Concretely:

- `backup-service.js:106` — single-file writes with an EXDEV/EPERM/EBUSY
  fallback (copy+unlink). Single files, no watcher. Safe.
- `ftp-source-service.js:103` — `_RENAME_FALLBACK_CODES = {EPERM,
  ENOTSUP, ENOSYS, EXDEV}`, single-file. Not delivery-related. Safe.
- `fuji-jobmaker-file-writer.js:97` — `.tmp` + rename in the SAME
  directory. Same-directory rename cannot EXDEV. Safe on volume; but
  BACKLOG (§Decisions parked, `docs/BACKLOG.md:159`) already flags this
  as a same-class latent risk if Frontier ever picks up `.tmp` files.
- `order-xml-ipc-helpers.js:140` and `order-xml-watch-service.js:624` —
  single-file, EXDEV fallback via copy+unlink. Safe.
- `order-folder-writer.js:83` — `p` → `o` rename inside the same DPOF
  hot folder. Same-directory. Safe by construction.

Only Fuji PIC Pro was affected.

---

## Part 2 — design options

Requirements recap:

- **R1** cross-share UNC, mapped drives, local — all work.
- **R2** PIC Pro never sees a partial / phantom order.
- **R3** crash-safe: nothing stranded, nothing duplicated.
- **R4** same-volume path unchanged, byte-for-byte.
- **R5** failures loud in the UI.

The candidate table:

| # | Design | R1 | R2 | R3 | R4 | R5 | Verdict |
|---|---|---|---|---|---|---|---|
| A | Restore pre-M7b: copy into `{diginPath}/{orderId}.ohdtmp` then rename | ✓ | ✗ (this IS the removed bug) | ~ | ✓ | ~ | REJECTED — reintroduces the customer incident. |
| B | Copy into `{diginPath}/.ohd-inbox-{GUID}` (no order-id prefix) then rename | ✓ | ? PIC Pro filter behaviour unproven | ✓ with startup sweep | ✓ | ✓ | Promising — needs one lab test. |
| C | Copy into `{diginPath}/{orderId}.tmp` with HIDDEN attribute, then unhide + rename | ✓ | ? watcher-honours-HIDDEN unproven | ~ | ✓ | ~ | Brittle. HIDDEN is often ignored by directory-scan watchers. Not recommended. |
| D | Copy to a temp folder ELSEWHERE on the destination share, then rename | ✗ | — | — | — | — | REJECTED — lab's DIGIN is a share root; there is no "elsewhere on that share". |
| E | Copy directly to `{orderId}` with a marker-file discipline | ✓ | ✗ | — | — | — | REJECTED — a race we cannot win. |
| F | Reverse the sequence: deliver DIGIN before writing `.txt` | ✓ | ? spec says containers precede DIGIN drop — this violates the sequence but may still be safe | ✓ | ✓ (unchanged for same-volume) | ✓ | Second-best. Needs the same class of empirical test as B. |
| N | Combined: pre-`.txt` cross-volume COPY into `.ohd-inbox-{GUID}` in DIGIN + post-`.txt` intra-DIGIN atomic RENAME to `{orderId}` | ✓ | Strongest safety — the folder that PIC Pro *might* see (`.ohd-inbox-*`) is never present at the same time as a matching merge container; the folder PIC Pro *will* see (`{orderId}`) appears via atomic rename with the container already in place | ✓ startup sweep of stale `.ohd-inbox-*` | ✓ (same-volume path unchanged) | ✓ | **Recommended.** |

Notes on the rejected paths:

- **A** is the removed bug. Not eligible.
- **C** (HIDDEN attribute). Node's `fs.rename` does not preserve the
  Windows HIDDEN attribute across operations, and third-party directory
  scanners on Windows most often use `FindFirstFile` / `ReadDirectoryChangesW`
  variants that surface hidden dirs. HIDDEN would need a native module to
  set and would still depend on PIC Pro honouring it. Not worth the
  complexity relative to B.
- **D** was in the discussion for completeness but doesn't fit the lab's
  config: `\\labserver1\Digin` is a share root, so there is no location
  on that share reachable over UNC that is outside DIGIN. If the
  destination-share had a subfolder outside DIGIN, D would be viable and
  arguably cleanest; it doesn't, so it's out.
- **E** exposes exactly the race the customer already hit.

Notes on F vs N:

- **F**'s assumption is stronger — it requires PIC Pro to tolerate a
  DIGIN folder appearing before its merge container, which is against
  the spec-ordered handshake ("digital files should not get dropped into
  DIGIN before the respective container are created" — PIC Pro spec
  p.369, quoted at `docs/print-controllers/FUJI-PIC-PRO-FORMAT.md:33`).
  Even if PIC Pro tolerates the ordering, it means the folder is exposed
  for the whole time before OrderGateway consumes the .txt.
- **N** collapses the exposure window. The folder PIC Pro might mistake
  as an order (`.ohd-inbox-{GUID}`) never has a matching container. The
  folder PIC Pro is meant to consume (`{orderId}`) appears exactly at
  the moment the container appears, via an atomic intra-DIGIN rename.
  N maintains the spec ordering as observed by PIC Pro on the final
  folder — no ordering violation.

---

## Part 3 — recommendation

### The design

**Option N — pre-`.txt` cross-volume copy + post-`.txt` intra-DIGIN atomic
rename.**

Selection logic. The writer picks path based on the outcome of the atomic
rename, not on the `isSameVolume` verdict:

- Attempt `rename(stagingFolder, destFolder)`. If success → done, method
  `rename` (unchanged from today — R4 lock).
- If EXDEV → invoke the cross-volume path.

The cross-volume path lives partly in dispatch (the copy) and partly in
the monitor (the intra-DIGIN rename). Reasoning: pre-`.txt` copy needs to
happen before `writeOrderFile` so PIC Pro cannot possibly see a matching
merge container while the copy is in flight. Intra-DIGIN rename lives in
`_stepDelivering` so the state machine's `awaiting-gateway → delivering`
gate still fires at the right moment (`.txt` consumed).

Dispatch flow (cross-volume only; same-volume unchanged):

1. `stageImages` → `{imageStagingRoot}/{orderId}/` (unchanged).
2. **Probe:** try `rename` at dispatch time is destructive if it
   succeeds. Instead, do a one-time `isSameVolume` check. If verdict is
   `certain-same`, keep same-volume path. Else, take cross-volume path.
   (If the `certain-same` case ever EXDEVs at delivery — mount changed
   under us — fall back to the current loud-throw. That's a rounding
   error.)
3. **Cross-volume: copy** `{imageStagingRoot}/{orderId}/` to
   `{diginPath}/{inboxPrefix}{GUID}/`. This crosses the volume boundary.
   PIC Pro is not looking for anything matching this name and no merge
   container exists yet for this order.
4. `writeOrderFile` → Order Data (atomic, unchanged).
5. `enqueueSubmission` with an added `inboxPath` field on the entry.
   `markCommitted`.
6. Return success synchronously.

Monitor flow (cross-volume only; same-volume unchanged):

7. `_stepAwaitingGateway` waits for `.txt` to disappear (unchanged).
8. `_stepDelivering` — if `entry.inboxPath` set, `rename(entry.inboxPath,
   destFolder)` (intra-DIGIN — always atomic, always same-share). If not
   set, current same-volume rename from staging.
9. `_stepBuilding` / `_stepReleasing` unchanged.

Startup cleanup (new):

10. On monitor `startMonitoring`, sweep `{diginPath}` for entries
    matching `{inboxPrefix}*` and older than a threshold (e.g. 24h) that
    do NOT match a pending entry's `inboxPath`. `rm -rf` those. Log each.

Failure surface (fixes the second defect from §1.3):

11. In `_stepDelivering`'s catch: `jobService.updateJobLocally(entry.jobId,
    { _status: 'error', _errorMessage: err.message })` before
    `_resolveEntry`. This needs `entry.jobId` to be captured at enqueue
    (currently `orderRef` is captured but not `jobId`). Small
    threading-through change.

The name discipline. Use a prefix that is:

- unmistakably OHD-owned (not likely to collide with a lab file
  convention): `.ohd-inbox-` reads as clearly-not-an-order.
- lexicographically distinct from any order-id shape OHD produces
  (`ORD-…`, `PXDEMO…`, etc.), so any prefix-match rule PIC Pro might use
  cannot accidentally match.
- includes the controllerId so multi-controller setups can't collide.

Concrete: `.ohd-inbox-{controllerId}-{ts}-{4bytesRand}`.

### The load-bearing risk: exposure window

Option N is NOT strictly safer than the deleted M7b `.ohdtmp` path — it
trades one risk profile for another. Being explicit:

**Pre-M7b `.ohdtmp` exposure.** The `.ohdtmp` folder existed only during
step 4 of the state machine (`_stepDelivering`, cross-volume copy). The
merge container `{orderId}.con` already existed at that point (OrderGateway
consumed the `.txt` in step 3). Exposure duration: **copy duration only**,
typically seconds. Failure mode observed: PIC Pro ingested the folder in
that window despite the `.ohdtmp` suffix.

**Option N exposure.** The `.ohd-inbox-{GUID}` folder exists from the
moment cross-volume copy starts (dispatch time) through:

1. the copy itself,
2. the `writeOrderFile` and `enqueueSubmission` window,
3. the `awaiting-gateway` phase (up to `gatewayTimeoutMs`, default **120s**),
4. until the intra-DIGIN rename fires in `_stepDelivering`.

Exposure duration: **copy duration + up to 120s**. In wall-clock terms
that is one to two orders of magnitude LONGER than the `.ohdtmp` bug's
window.

**What makes that longer window potentially safe.** During most of the
window (steps 1–2, and step 3 up until OrderGateway consumes the `.txt`),
no merge container `{orderId}.con` exists in Merge Data. If PIC Pro's
DIGIN scan is *conditional on a matching merge container being present*,
the folder is invisible to it during that pre-container period.

For the window between merge-container creation and the intra-DIGIN
rename (part of step 3 into step 4), the folder is present WITH the
container in play — same shape as the `.ohdtmp` bug's window. The only
thing protecting us there is that the folder's *name* (`.ohd-inbox-*`)
doesn't match the container id.

**Both protections need to hold**: the container-gating hypothesis for the
long pre-container window, AND the name-doesn't-match-container-id
hypothesis for the shorter post-container window. Either failing means
Option N produces phantom orders — potentially at higher volume than the
`.ohdtmp` bug, because the exposure is longer. This is why the empirical
test below is load-bearing, and why the pass criterion is strict.

### The N-lite variant

**N-lite** — same shape as N (cross-volume copy into a non-matching
inbox name, then intra-DIGIN atomic rename to `{orderId}`), but the
copy happens **AFTER** OrderGateway consumes the `.txt` — the old
code's timing. Cross-volume flow:

1. `stageImages` → `{imageStagingRoot}/{orderId}/`.
2. `writeOrderFile` → Order Data (atomic).
3. `enqueueSubmission` + `markCommitted`. Return success synchronously
   — dispatch is fast, unchanged from today.
4. Monitor `_stepAwaitingGateway` waits for `.txt` to disappear
   (unchanged).
5. Monitor `_stepDelivering`, cross-volume branch: copy staging →
   `{diginPath}/{inboxPrefix}{GUID}/`, then intra-DIGIN atomic rename
   → `{orderId}`.
6. Advance to `building`.

Same-volume path in both N and N-lite is byte-for-byte unchanged. The
difference lives entirely in when the cross-volume copy runs.

**N vs N-lite — head-to-head.**

| Axis | N (pre-`.txt` copy) | N-lite (post-`.txt` copy) |
|---|---|---|
| Unverified assumptions | **Two**: (a) PIC Pro DIGIN watcher is gated on matching-container presence, so a folder existing before its container is ignored; (b) `.ohd-inbox-*` name does not match any ingest rule. | **One**: `.ohd-inbox-*` name does not match any ingest rule. Same single hypothesis as pre-M7b `.ohdtmp` implicitly rested on. |
| Exposure window (folder present in DIGIN) | Copy duration + `writeOrderFile` + OrderGateway poll latency + up to `gatewayTimeoutMs` (default 120s). Typically seconds to two minutes; in one to two orders of magnitude MORE than the `.ohdtmp` bug had. | Copy duration only — the folder is created and renamed away entirely within `_stepDelivering`. **Numerically equivalent to the pre-M7b `.ohdtmp` window** (same code phase, same physical operation). |
| Dispatch wall-clock latency | Slow — synchronous copy blocks the dispatch call. On a large order over a slow SMB share, dispatch could block for many seconds. `runAutoPrint` is sequential, so this stalls the entire batch. | Fast — dispatch returns immediately after atomic `.txt` write, same as today. Copy runs asynchronously in the monitor. |
| Time from `.txt` consumed to DIGIN folder visible | Milliseconds (just the intra-DIGIN rename). PIC Pro sees the folder essentially the moment OrderGateway is ready to look. | Full copy duration. PIC Pro will not see the DIGIN folder until the copy completes. |
| Failure if name hypothesis is false | Phantom orders across the entire exposure window — potentially many per real order because the window spans OrderGateway's poll cadence. **Higher blast radius than the `.ohdtmp` bug.** | Phantom orders during copy window only — one blank per real order, same shape and volume as the `.ohdtmp` bug. |
| Failure if container-gating hypothesis is false | Phantom orders during the pre-container part of the exposure. Compounds with the name-hypothesis failure. | Not applicable — the folder never exists during a pre-container period, so container-gating is not required. |
| Failure if OrderGateway is impatient (see §"The deciding question" below) | Not affected — the folder appears within milliseconds of `.txt` consumption. Even a very tight OrderGateway timeout is satisfied. | **Orders silently lost** — if OrderGateway abandons an order when the DIGIN folder fails to appear within its own timeout, and the cross-volume copy exceeds that timeout, PIC Pro discards the container and the order never prints. No phantom, but also no output. |
| Crash-safety before `.txt` write | `.ohd-inbox-{GUID}` in DIGIN, no `.txt`, no container. Sweep cleans it. | No leftover — the copy hasn't started yet. Cleanest crash-safety of the two. |
| Crash-safety between `.txt` written and copy completed | Same as N — leftover inbox in DIGIN, cleanup via sweep. Rehydrated entry knows its inboxPath and can resume. | Same as N — leftover inbox in DIGIN, cleanup via sweep. Rehydrated entry resumes from `_stepDelivering`. |

**N-lite is strictly cleaner on assumption count and exposure window.**
Its only exposure to failure that N doesn't share is the
OrderGateway-timeout risk. Which resolves the ranking to the following
question:

### The deciding question — does OrderGateway time out?

**Question.** After OrderGateway consumes `{orderId}.txt` from Order
Data and creates the merge container in Merge Data, does it wait
indefinitely for the `{orderId}` folder to appear in DIGIN, or does it
abandon the order after some internal timeout?

**What the repo tells us — nothing.** All the timeouts named in the
codebase are OHD-side:

- `gatewayTimeoutMs` (default 120s, bounds 10s–30min,
  `src/main/services/fuji-pic-pro-config.js:76`,
  `src/renderer/index.html:1324`) — how long **OHD** waits for
  OrderGateway to consume the `.txt`. This is our patience with them,
  not theirs with us.
- `buildTimeoutMs` (default 30min, `fuji-pic-pro-config.js:77`) — how
  long **OHD** waits after the DIGIN folder appears for PIC Pro to
  finish building the order. Also our clock, not theirs.

**What the docs tell us — nothing.** The PIC Pro v3.0 User Guide
excerpts in the repo (pp. 339–370, cited across
`docs/fuji-pic-pro-investigation-and-plan.md:5`, `docs/print-controllers/FUJI-PIC-PRO-FORMAT.md:6`)
prescribe an ordering ("digital files should not get dropped into
Digin before the respective container are created", p. 369) but say
nothing about OrderGateway's behaviour when the ordering is honoured
by container arrival but the DIGIN folder is late or never appears.
The three-folder handshake diagram (`FUJI-PIC-PRO-FORMAT.md:22-31`)
describes the happy path only. `docs/BACKLOG.md:161` explicitly
acknowledges an adjacent unverified claim ("The PIC Pro spec (p.359)
says filename is irrelevant to OrderGateway but doesn't state
extension filtering; we don't know…"), which is the same posture we
have to take here.

**Observed behaviour — nothing.** No customer report in the repo
concerns an order stalling between container creation and DIGIN
delivery, because before M7b the `.ohdtmp` slow path always delivered
the folder immediately after the copy — there was never a real gap
for OrderGateway to time out over. Post-M7b, cross-volume dispatch
just fails at EXDEV before OrderGateway ever gets involved, so we
still have no data.

**Verdict: cannot be established from the repo — but the lab's failed
test order on 1.15.2 already created exactly the condition a Test 3
would have had to construct.** When they dispatched from 1.15.2:

1. OHD wrote `{orderId}.txt` to Order Data atomically → OrderGateway
   consumed it (it must have — the alternative would have produced a
   `[fuji-pic-pro] cleaned up unconsumed .txt after gateway timeout`
   log line at 120s, which the lab hasn't reported).
2. OrderGateway created the merge container in Merge Data.
3. OHD's monitor advanced to `_stepDelivering`, threw EXDEV, resolved
   `failed`. **DIGIN folder never delivered.**

That happened days ago. From OrderGateway's perspective, a `.txt` was
consumed, a container was created, and the DIGIN folder for it has
never arrived. This is the Test 3 condition, running live on the
lab's system, with days of elapsed wall-clock time — a longer
observation than any controlled test could give us.

**Ask about state, not about running a new test.** Replaces the
controlled Test 3:

> **Test 3 (retrospective — the test order from 1.15.2 that never
> delivered).** OrderGateway will have consumed that order's `.txt`
> from Order Data, and PIC Pro should have produced a container file
> for it in Merge Data. Can you check three things at the labserver:
>
> - Is that container file still in Merge Data right now? Filename
>   is `{orderId}.con`, or a folder `{orderId}/` depending on your
>   "Container Path Use Subdirs" setting. If you're not sure which
>   `{orderId}` it was, any container older than a day whose order
>   never printed will do.
> - Has PIC Pro or OrderGateway raised an error about it — a
>   message in the console, an entry in an error log, a stuck
>   line in a queue, anything visible on their side?
> - If the container is gone now, do you remember roughly when it
>   disappeared after the failed dispatch — minutes later, hours,
>   the next morning?

Interpretations:

- **Container still present days later, no PIC Pro error.** OrderGateway
  is patient. **This is the strongest possible evidence for the patient
  case** — orders of magnitude beyond any controlled test window we
  could ask for. **N-lite is viable without any further test on this
  axis** (provided Tests 1 and 2 also come back green on the name
  hypothesis).
- **Container was deleted at some point.** OrderGateway has a
  timeout T. If the lab can estimate T from when they noticed the
  disappearance: T > 1h → N-lite still safe, optionally with a
  dispatch-side size-based guard; T tight (minutes) → prefer N.
- **Container was deleted, no timing information.** Fall back to a
  controlled Test 3 (write a real `.txt`, watch at 5 / 15 / 60 min)
  to pin down T, OR just ship N to be safe.
- **PIC Pro did surface an error.** Same handling as the "container
  deleted" case, plus we know the failure isn't silent on PIC Pro's
  side either — capture the error text for CHANGELOG so future
  operators recognise it.
- **Container never existed.** Contradicts our monitor's advancement
  through `awaiting-gateway` (which required the `.txt` to
  disappear). Points at a misunderstanding — ask the lab to confirm
  the Merge Data path they gave us matches OrderGateway's
  configuration, and re-check.

Cost to the lab: they walk to the labserver and look. No test to
set up, no waiting.

### Assumption to test at the lab, before shipping code

**The claim we cannot verify from our code:** PIC Pro's DIGIN watcher
ingests a folder if and only if (a) some scanning condition activates it
AND (b) the folder's name matches an expected order-id pattern (probably
one with a matching merge container).

**The email test.** Three tests. Tests 1 and 2 settle the name
hypothesis; Test 3 (specified in the previous section, "The deciding
question — does OrderGateway time out?") settles the OrderGateway
patience question. All three should go in the same email.

> **Test 1.** In your DIGIN folder (`\\labserver1\Digin`), create an
> empty folder called `.ohd-inbox-test-a`. Put two JPEG images inside
> (any JPEGs — content doesn't matter). Do not create anything in
> Order Data or Merge Data. Leave it for ten minutes. Tell me: did any
> new order appear in PIC Pro's queue? Was the folder touched, moved,
> or deleted?
>
> **Test 2.** Same thing but call the folder `TEST-ORDER-9999`
> instead — a name that looks like a real order id. Two JPEGs inside,
> nothing in Order Data or Merge Data. Ten minutes. Same questions.
>
> **Test 3.** *(retrospective — see the section "The deciding question"
> above. No new setup needed; the failed 1.15.2 order already produced
> the exact conditions. Ask the lab whether the merge container from
> that order is still present in Merge Data, whether PIC Pro surfaced
> any error, and — if it was deleted — roughly when.)*
>
> When you're done with Tests 1 and 2, delete both test folders
> manually. Leave any real containers alone.

**Result interpretation — strict. There is exactly one green light for
the name hypothesis, and a separate outcome from Test 3 for OrderGateway
patience.**

Tests 1 and 2 — name hypothesis. Test 2 is the **positive control** (it
must reproduce the ingest to prove the test setup was capable of
detecting anything). Test 1 is the **treatment** (it must NOT reproduce,
to prove the `.ohd-inbox-*` prefix is the discriminator).

| Test 2 (positive control) | Test 1 (treatment) | Interpretation |
|---|---|---|
| Phantom order appears | Untouched | **GREEN on the name hypothesis.** Ingest reproduces AND the prefix protects. Combine with Test 3 to pick between N and N-lite. |
| Phantom order appears | Phantom order appears | **RED.** Prefix does not protect. N, N-lite, and F all unsafe. Do not ship any. |
| Untouched | Untouched | **INCONCLUSIVE — treat as red.** Positive control failed. The test did not reproduce the ingest mechanism at all, so the test cannot prove the prefix protects. There is a condition (OrderGateway state, PIC Pro scan cadence, time-of-day polling, an in-play merge container we didn't create, an active print queue that changes DIGIN behaviour, permissions on the test folder differing from OHD-written folders, …) we didn't reproduce. Do NOT ship on this result. Ask the lab to try again with a real `.txt` written to Order Data alongside Test 2 so a matching merge container exists — that better matches the ambient state at dispatch time. |
| Untouched | Phantom order appears | **RED and confusing.** Something we don't understand is happening — probably points at a PIC Pro filter rule that treats the `.ohd-inbox-*` name shape as more interesting than a plain order-id-shape (unlikely but possible). Do not ship. Escalate. |

The critical point on Tests 1 and 2: **"neither test produced an order"
is not permission to ship.** It is a failed experiment. The mechanism
the test exists to detect either wasn't active during the test window,
or wasn't reachable without additional setup we didn't do. Either way,
the test's ability to *falsify* the safety hypothesis is zero, and no
design decision can be justified from a zero-power result.

Test 3 — OrderGateway patience.

| Test 3 outcome | Interpretation |
|---|---|
| Container stays untouched past 60 min; nothing appears on PIC Pro side | OrderGateway is patient. **N-lite viable.** |
| Container is removed / an error appears within 60 min | OrderGateway is impatient with some finite timeout. **N-lite unsafe for orders whose copy might exceed that timeout.** If the observed timeout is very generous (e.g. hours), N-lite is still viable with a dispatch-side guard that rejects cross-volume orders projected to run over. If tight, prefer N. |
| Nothing happens: `.txt` never consumed | Broken test setup — the config that consumes real orders should consume this one. Re-run. |

**Combined decision matrix (all three tests):**

| Name hypothesis (Tests 1 & 2) | OrderGateway patience (Test 3) | Ship |
|---|---|---|
| GREEN | Patient | **N-lite** (fewer assumptions, smaller exposure window, no dispatch stall) |
| GREEN | Impatient with tight timeout | **N** (dispatch pays the copy cost so the DIGIN folder appears immediately after `.txt` consumption) |
| GREEN | Impatient with generous timeout (e.g. > 30 min) | N-lite with a dispatch-time guard that refuses cross-volume orders whose staging size / estimated copy time would exceed a safe fraction of the observed OrderGateway timeout. Simpler to ship N in this case unless the extra dispatch-side complexity is warranted. |
| RED or INCONCLUSIVE on name | any | Ship neither. Fall through to the silent-stall-only 1.15.3 (see release framing below) and open a Fujifilm-side conversation about DIGIN watcher semantics. |

### Failure modes N still has, and what the operator sees

- **Copy fails mid-run (network drop, disk full).** Cross-volume copy
  throws before `writeOrderFile`. Dispatch catches, sets job status to
  error with the writer's message. `.ohd-inbox-{GUID}` is left in
  DIGIN. Startup sweep cleans it later. Job is red in the grid.
- **OHD crashes between copy and `writeOrderFile`.** `.ohd-inbox-{GUID}`
  in DIGIN with no `.txt`. No merge container will ever appear.
  Startup sweep cleans it. No orphan order.
- **OHD crashes between `writeOrderFile` and enqueue.** `.ohd-inbox-{GUID}`
  in DIGIN, `.txt` in Order Data, no pending entry. OrderGateway
  consumes the `.txt`, produces a merge container, PIC Pro sees the
  container but the DIGIN folder is still `.ohd-inbox-{GUID}` — no
  matching `{orderId}`. Build times out or errors on PIC Pro's side.
  Same behaviour as any other crash-between-write-and-enqueue today —
  this is the existing "PIC Pro rehydrate window" open item
  (`docs/BACKLOG.md:41`); this design does not make it worse.
- **Intra-DIGIN rename fails at delivering.** Unlikely (same share,
  atomic on Windows/NTFS/SMB), but if it does, error text names both
  paths and the fix. Job goes to error. `.ohd-inbox-{GUID}` still in
  DIGIN — startup sweep or manual cleanup.
- **PIC Pro DOES touch `.ohd-inbox-*` despite the test.** A phantom
  order appears, exactly as pre-M7b. This is why the test comes first.

### Milestone breakdown

**M0 — lab test.** Send the email above. Wait for answer. No code.

**M1 — writer.** In `fuji-pic-pro-file-writer.js`:
- Add `deliverToDiginViaInbox({ inboxPath, diginPath, orderId, deps })`
  that renames `inboxPath` → `destFolder`. Idempotent replay behaviour
  same as current `deliverToDigin`.
- Add `copyStagingToDiginInbox({ stagingFolder, diginPath, deps })` that
  builds the inbox path and does the recursive copy. Returns
  `{ inboxPath }`.
- **Do NOT modify `deliverToDigin`.** The R4 lock is that the
  same-volume path is byte-for-byte unchanged.
- New tests: happy-path copy, EACCES on copy, interrupted copy leaves
  `inboxPath` present (for sweep), `deliverToDiginViaInbox` idempotent
  replay when `{orderId}` already exists.

**M2 — dispatch (Option N only).** In `_sendViaFujiPicProRouted`:
- After `stageImages`, if `isSameVolume(imageStagingRoot, diginPath) !==
  'certain-same'`, call `copyStagingToDiginInbox`. Store `inboxPath` on
  the entry passed to `enqueueSubmission`.
- New tests: cross-volume dispatch produces an entry with `inboxPath`
  set; same-volume dispatch does not; copy failure fails the dispatch
  loudly with the writer's message and sets job to error.
- **Skipped in N-lite.** In the N-lite variant, dispatch is unchanged
  from today — the copy happens asynchronously in the monitor instead.

**M3 — monitor.** In `_stepDelivering`:
- **In Option N:** if `entry.inboxPath` set, call `deliverToDiginViaInbox`
  instead of `deliverToDigin`.
- **In Option N-lite:** if `isSameVolume(entry.stagingFolder,
  entry.diginPath) !== 'certain-same'`, first call
  `copyStagingToDiginInbox` (populating `entry.inboxPath` and
  persisting), then call `deliverToDiginViaInbox`. Both the copy and
  the rename run in the monitor, not dispatch.
- **Both variants:** add `entry.jobId` to the enqueue signature so
  `updateJobLocally({_status: 'error', _errorMessage})` can be called
  from the catch. **This fixes the second defect from §1.3.**
- New tests: cross-volume entry follows the variant-appropriate path;
  same-volume entry uses the current path unchanged; failure sets job
  to error with the message.

**M3 is separable — see the callout below (silent-stall visibility as
its own patch).** The `entry.jobId` + `updateJobLocally` part can be
extracted from M3 and shipped on its own, independent of Options N/F/etc.,
independent of the lab test. If the empirical test comes back
inconclusive or red, the silent-stall fix should still ship — the lab
gains visibility of the failure, which is strictly better than staying
stuck at "in production" with no feedback.

**M4 — orphan cleanup: two-tier age-based sweep.** The leak has to
close by itself — the operator never runs a CLI. Discipline is:
**instance-scoped for recent folders, unconditional for old ones**,
because no in-flight copy can plausibly be older than the threshold.

Naming (unchanged from prior version): inbox path is
`{diginPath}/.ohd-inbox-{controllerId}-{instanceId}-{ts}-{4bytesRand}/`.
`instanceId` is a per-process UUID generated fresh on each OHD launch.
`controllerId` is the routing controller id.

Sweep runs (a) once at monitor `startMonitoring`, after `_loadFromStore`,
and (b) periodically, every 1 hour, for the lifetime of the monitor.
The lifetime sweep matters: a lab that never restarts OHD would
otherwise never clean up mid-run leaks.

Algorithm (per sweep, per monitor):

1. Collect `inFlightInboxPaths` = set of `entry.inboxPath` values from
   the current pending queue for this controller.
2. `readdir({diginPath})` — swallow ENOENT/EACCES with a warn.
3. For each entry name matching `/^\.ohd-inbox-/`:
   a. Full path: `full = path.join(diginPath, name)`.
   b. If `full` is in `inFlightInboxPaths` → **keep**. Always. Even
      an ancient in-flight entry is legitimate (a genuinely huge
      order or a very slow share).
   c. Otherwise, `stat(full)` and read `mtime`. On stat failure,
      warn + skip.
   d. If `Date.now() - mtime.getTime() >= STALE_THRESHOLD_MS` →
      **`rm -rf` unconditionally**, regardless of `controllerId` or
      `instanceId` embedded in the name. Log the path, age, and
      whichever parsed fields we can read from the name so the log
      is self-explanatory in Activity Log.
   e. Otherwise (age below threshold): apply instance-scoping. If
      the name matches `.ohd-inbox-{thisControllerId}-{thisInstanceId}-*`
      → **`rm -rf`** (own-instance leftover — no other actor could
      be writing to it). If not → **keep** (may belong to another
      controller within this OHD, another OHD process, or a prior
      instance of this OHD process that could theoretically still be
      writing).
4. Log a summary: "swept N stale inboxes from `{diginPath}`, kept M
   (K in-flight, L too recent to reap unconditionally)".

**Threshold: `STALE_THRESHOLD_MS = 6 hours`.**

Justification against the slowest plausible copy over a saturated
network share:

- **Largest plausible order.** A photo-heavy PIC Pro order runs
  30–200 images. Assume the extreme end: 300 images × 30 MB each
  (typical high-res JPEG) ≈ **9 GB**. An outlier wedding album with
  larger raw-conversion outputs might hit 20 GB. Above that isn't a
  PIC Pro order shape.
- **Slowest plausible saturated link.** Enterprise labs are on 1 Gbps
  Ethernet (theoretical 125 MB/s, realistic sustained under SMB with
  encryption and light contention: 40–60 MB/s). Older sites might
  still be on 100 Mbps (theoretical 12.5 MB/s, realistic sustained
  4–8 MB/s). Under active contention with backup jobs or PIC Pro's
  own I/O, effective throughput can drop to 1–2 MB/s.
- **Worst realistic case.** 20 GB @ 2 MB/s sustained (100 Mbps under
  heavy contention, an outlier of an outlier) ≈ 10,000 seconds ≈
  **2.8 hours**.
- **6-hour threshold headroom.** 2.1× the worst realistic case, ~15×
  a typical large order (9 GB @ 40 MB/s ≈ 4 min), and far exceeds
  the observed dispatch behaviour of any current PIC Pro lab. If a
  copy is genuinely still in progress at 6 hours, the OHD process
  has been blocked at that dispatch call for 6 hours (dispatch
  copies synchronously in the N variant, in the monitor's
  `_stepDelivering` in N-lite) — long past the point where the
  operator will have noticed and intervened.
- **mtime, not creation time.** During an active recursive copy,
  files are being added inside the inbox folder, which bumps the
  parent folder's `mtime` on NTFS and on all mainstream SMB server
  implementations. So `mtime > threshold` genuinely means "no
  write activity in the last 6 hours", not "created 6 hours ago".
  An active but slow copy keeps refreshing its own mtime and will
  not trigger the unconditional reap. A stalled copy (network
  partitioned, process gone) has a static mtime and IS reaped —
  which is correct.

  **Caveat on mtime-resets-the-clock: it holds only while files are
  written DIRECTLY into the inbox folder.** A PIC Pro order today is
  a flat list of sequence-renamed images (`0001.jpg`, `0002.jpg`,
  …) with no nested subdirectories, so every write during a
  cross-volume copy hits the inbox folder itself and bumps its
  mtime. If a future change introduces nested structure under the
  inbox — a per-surface subfolder, a per-image-variant subfolder,
  an intermediate scratch dir, anything at all — then writes into
  that nested dir will bump the nested dir's mtime but NOT the
  parent inbox's mtime. A copy that spent all its time writing
  into nested subdirs would let the inbox's own mtime age past the
  threshold while the copy was still in flight, and the sweep
  would reap it. **Harmless at 6 hours against a 2.8-hour worst
  case (2× headroom on the outermost estimate, ~90× on a typical
  order).** But it becomes fragile if either the threshold is
  shortened or nested structure is introduced without also
  switching to a recursive newest-mtime walk. Record this so a
  future change that shortens the threshold, adds nesting, or does
  both, is made with the assumption on the table — not
  accidentally. If the threshold ever drops below the plausible
  copy time OR nested structure ever appears, switch the age
  measurement to `Math.max(...allDescendantMtimes)` rather than
  the folder's own mtime, and document that switch here.
- **Config knob, not a fixed constant.** Expose
  `staleInboxThresholdHours` as an advanced-tab controller field,
  default 6, min 1, max 168 (one week). A site with truly
  pathological I/O could raise it; a site that just wants faster
  cleanup could lower it. The default should not need tuning.

Why 6h is safer than the instance-scoped-only version proposed
earlier:

- The prior version left a crash-before-persist orphan lingering
  forever (new process has a new instanceId, so the sweep never
  matched). Age-based reaping catches those on the next sweep past
  6h — at most one extra sweep interval (1h) beyond the threshold.
- The prior version also left orphans from an OHD reinstall or a
  machine swap forever, because their controllerId + instanceId
  don't match anything on the current install. Age-based reaping
  catches those too.
- Zero operator burden. No CLI. No IPC action. No "if you see this
  count grow, run this". The invariant: **`.ohd-inbox-*` folders
  older than 6 hours are always gone by the next sweep**, full
  stop.

Why age-based reaping is safe for folders whose ownership we cannot
verify:

- The threshold is much longer than any legitimate copy could take.
  If a folder is older than 6h and is NOT in any pending queue we
  can see, either (a) the actor that created it is dead, or (b) the
  actor that created it is alive but has forgotten about the folder
  (crashed persistence, config change, restart in a different mode).
  In either case the folder is a leak, not an in-flight operation,
  and reaping is the correct action.
- If two OHD instances are running against the same DIGIN path,
  both will run this sweep on their own schedule. Each will reap
  the other's post-6h leftovers. That is a feature: no leftover
  survives if any OHD instance sees it past 6h.
- If a THIRD-PARTY tool at the lab creates a folder starting with
  `.ohd-inbox-` (extremely unlikely — the prefix is OHD-branded),
  we would reap it at 6h. This is acceptable because (a) the
  prefix collision would be their bug, not ours, and (b) a folder
  with that prefix is by definition undocumented for any
  third-party workflow.

Tests to lock the discipline:

- **Recent + in-flight (in `inFlightInboxPaths`)** → kept regardless
  of age.
- **Recent + own-controllerId + own-instanceId + not in pending**
  → reaped (this-instance orphan).
- **Recent + different controllerId** → kept.
- **Recent + same controllerId + different instanceId** → kept.
- **Old (mtime > threshold) + any name shape starting with
  `.ohd-inbox-`** → reaped, regardless of controllerId /
  instanceId / matches-pending. (Except: if it somehow IS in
  `inFlightInboxPaths`, still keep — the pending list is the
  authoritative override at every age.)
- **Old + non-inbox name** → kept (not our folder).
- **Old + in-flight (in pending)** → kept. Case exists if a real
  order took 6h+ (unlikely but must be safe).
- **ENOENT on DIGIN readdir** → warn, no throw.
- **stat failure on individual entry** → warn + skip, do not throw.
- **Periodic sweep fires every hour** while monitor is running.
  Startup sweep fires once at `startMonitoring`.

**M5 — save-time UX.** The advisory warning added in 1.15.1 becomes
outdated — cross-volume is now supported. Remove the warning for the
`indeterminate` verdict, keep it for `certain-different` (still slower
and more crash-exposed than co-located). Update
`docs/fuji-pic-pro-lab-test-pack.md:66` to remove the "MUST be on the
same volume" language.

**M6 — docs.** CHANGELOG entry naming the mechanism, the customer
paths, the operator-visible improvement, and the second-defect fix.
Landmine entry in CLAUDE.md pointing at the new intra-DIGIN rename
invariant and the sweep prefix so a future edit can't accidentally
introduce a prefix collision.

**Tripwire tests to lock behaviour:**

- Same-volume rename remains the exclusive delivery path when
  `isSameVolume` returns `certain-same` (assertion against the writer,
  same shape as the current M7b test).
- Cross-volume goes exclusively through inbox+rename, never through the
  removed A-shaped `.ohdtmp` path (assertion: reading the writer
  source, the `.ohdtmp` string does not appear).
- The intra-DIGIN rename is the SAME atomic call that the same-volume
  path uses — one call site, not two (the `buildDestFolder` /
  `computeLayout` discipline from `CLAUDE.md`).

### Release framing — 1.15.3, 1.15.4, or 1.16.0?

The recommended shape is TWO patch releases, not one:

**1.15.3 — silent-stall visibility only** (ship immediately, does not
depend on the empirical test).

- Extract from M3: add `jobId` to the enqueue, call
  `updateJobLocally({_status: 'error', _errorMessage: err.message})`
  in `_stepDelivering`'s catch before `_resolveEntry`.
- Same treatment for the other terminal-failure paths in the monitor
  that currently emit `failed` without any UI feedback
  (`_stepAwaitingGateway` timeout, `_stepBuilding` timeout to
  `timed_out`).
- Effect for the affected lab TODAY: they still can't get orders
  through cross-volume, but they see a red job in the grid with the
  deliverToDigin operator message ("Image Staging Root and DIGIN Path
  must be on the same volume …") instead of a silent stall at "in
  production". That is a meaningful improvement independent of any
  cross-volume design decision.
- Why not wait and bundle: the silent stall is orthogonal to
  cross-volume. It affects EVERY delivery-phase failure (EPERM,
  EACCES, ENOENT on the DIGIN mount going away mid-order, ambiguous
  existing-destFolder+existing-staging state, etc.) and always has.
  A lab hitting any of those today gets the same "in production"
  silence. Fixing it should not be gated on the outcome of an
  unrelated experiment.
- Rollback risk: minimal. It ADDS a `updateJobLocally` call on a
  path that today does nothing UI-facing; it cannot make behaviour
  worse in the healthy case.

**1.15.4 — cross-volume delivery (N-lite by preference, N as
fallback)** (contingent on the empirical test coming back green per
the combined decision matrix above).

- Variant selection is determined by Tests 1/2 (name hypothesis) +
  Test 3 (OrderGateway patience). N-lite ships if the name hypothesis
  is green AND OrderGateway is patient; N ships if the name
  hypothesis is green but OrderGateway is impatient with a tight
  timeout. Neither ships if the name hypothesis is red or
  inconclusive.
- M1 (writer), variant-appropriate M2 and M3, M4 (sweep), M5
  (save-time UX), M6 (docs).
- Ships ONLY on a green light per the strict test table above. On
  inconclusive or red, this release does not exist and the lab
  either reconfigures paths or we escalate to Fujifilm.

**Why not bundle both into 1.16.0.** Rationale for the split:

- This is a P0 for the affected lab — orders don't get through.
- The change is scoped: three modules (writer, dispatch, monitor) plus
  the sweep. Well-contained.
- Bundling with 1.16.0 (which will include unrelated feature work) means
  more surface area to review at a moment when this fix specifically
  needs to be as easy to roll back as possible.
- The prior three PIC Pro fixes (M7b, M7c, and this) landed in two
  days each. Discipline is: single-purpose patch releases for
  regressions, features roll up separately.

The pre-condition is the empirical test. Once the lab confirms
`.ohd-inbox-*` is ignored, M1–M6 is a day of work plus a lab-side
verification order. If the test comes back negative on `.ohd-inbox-*`,
this becomes a customer conversation before it becomes a release.

---

## Notes / contradictions found

- `docs/print-controllers/FUJI-PIC-PRO-FORMAT.md:213-218` is stale — it
  still describes the deleted M7b slow path as if it worked. Should be
  updated in M6.
- `docs/BACKLOG.md:159` ("tmp-in-watched-folder writers") already names
  `writeOrderFile`'s `.tmp` and `fuji-jobmaker-file-writer.js`'s
  `.txt.tmp` as same-class latent risks. This design does not address
  those; leave them for the "harden all tmp-in-watched-folder writers"
  milestone as backlogged. But note: if the lab-test result on
  `.ohd-inbox-*` also confirms that PIC Pro ignores `.tmp`-suffixed
  files in Order Data, the `writeOrderFile` latent risk becomes proven
  safe by observation, not just assumed. Worth capturing when the test
  comes back.
- Nothing in the code contradicts the account of events in the task
  brief. The M7b commit removed the fallback for exactly the reason
  described; M7c made the save advisory for exactly the reason
  described; the customer's current stall is precisely the predicted
  consequence of both together on a cross-volume config.
