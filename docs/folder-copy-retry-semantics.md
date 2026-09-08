# Folder Copy retry semantics — investigation

**Status:** investigation only, no code changes. Written 2026-09-08.

**Question.** 1.16.2 turned the never-overwrite guarantee on for
Folder Copy dispatch. The tradeoff was that re-dispatching the same
job to the same destination now writes `_2` copies alongside the
first attempt's files instead of replacing them. Is that the right
tradeoff, and if not, what would a narrow "replace this job's own
previous files, never anyone else's" exception look like?

This document establishes what happens today, enumerates the paths
that produce a re-dispatch, considers the Auto Print interaction,
checks whether the operator can even tell duplicates were written,
and then designs (does not build) the narrow exception. It ends with
a recommendation.

Whole investigation applies to Folder Copy controllers only. DPOF,
Darkroom Pro, Fuji, PDF Copy, Frontline all have their own dispatch
lifecycles and are out of scope.

---

## 1. What happens today when the same job is dispatched twice

Both cases below assume Folder Copy dispatch through
`_sendViaFolderCopyRouted` (`src/main/services/print-service.js:2310`),
per-job layout, and either `omitJobId: false` (destination
`{OutputPath}/{orderNumber}_{jobId}/`) or `omitJobId: true`
(destination `{OutputPath}/{orderNumber}/`). The behaviour is
identical either way — collision detection runs against on-disk
state in whatever the destination folder resolves to.

### 1a. Clean retry — first dispatch fully succeeded

Sequence:
1. Dispatch 1 produces the planner set `{p1, p2, …, pE}` from
   `buildCopyFilenames`. `dedupeAgainstDisk`
   (`src/main/services/folder-copy-filename.js:459`) walks each
   planned name against the (empty) destination folder — no
   collisions, no suffixing. All E files are copied under their
   planner names.
2. Job is marked completed at line 2478 via `_markCompleted`,
   which calls `jobService.markCompleted` — the API is told the
   job printed. Local `_status` becomes `completed`.
3. Something re-dispatches the same job (paths for that are §2).
   The planner produces the same set `{p1, …, pE}` (assuming the
   template hasn't changed — §2 covers the "template changed"
   case).
4. `dedupeAgainstDisk` checks each planned name against on-disk
   state. Every planner name exists from dispatch 1. Each is
   walked forward via `_nextSuffixed` in
   `folder-copy-filename.js:219` — `p1` → `p1_2`, `p2` → `p2_2`,
   …, `pE` → `pE_2`.
5. `fs.mkdirSync({recursive: true})` is a no-op on the
   pre-existing folder. The loop copies the sources under their
   suffixed names.

**Result:** 2E files in the destination. Bytes preserved on both
sets. Dispatch log carries `diskSuffixedCount: E`; no operator
notification (§4). Job's `_status` transitions again through
`_markCompleted` — a no-op if it was already `completed`.

### 1b. Retry after partial failure — some files written, then an error

Sequence:
1. Dispatch 1: planner produces `{p1, …, pE}`. `dedupeAgainstDisk`
   passes through cleanly on an empty folder. `fs.mkdirSync`
   succeeds. The `for` loop at
   `print-service.js:2446` starts calling `fs.copyFileSync` in
   order.
2. Copy N fails — out of space, SMB share dropped, permissions
   changed mid-write, one of the sources went unreadable, etc.
   The catch at `print-service.js:2449` returns
   `{success: false, error: writeErr.message}`.
3. Files `p1..p(N-1)` are on disk with correct bytes. `pN..pE`
   are not. There is no cleanup — the partial state stays.
4. The caller stamps `_status: 'error'` (auto-print at
   `ipc-handlers.js:4602-4607`, or the direct IPC handler at
   `ipc-handlers.js:812-813` for a manual Process click).
5. Operator sees the red job with the error, clicks the Retry
   button (§2), which resets `_status` back to `received` and
   fires `runAutoPrint()`.
6. Dispatch 2 runs. Planner produces the same `{p1, …, pE}`.
   `dedupeAgainstDisk` finds `p1..p(N-1)` on disk. Each is
   walked to its `_2` variant. `pN..pE` are not on disk, so
   they pass through unchanged.
7. The write loop copies:
   - `p1` from source → `p1_2` on disk (because `p1` exists)
   - …
   - `p(N-1)` from source → `p(N-1)_2` on disk
   - `pN` from source → `pN` on disk (fresh)
   - …
   - `pE` from source → `pE` on disk (fresh)

**Result:** `N + E - 1` files. Excess: `N - 1` duplicated files —
one `_2` copy per file that landed successfully in dispatch 1.
Byte-identical to what the retry would have re-written anyway
(sources unchanged between the two dispatches).

Dispatch log for dispatch 2 carries `diskSuffixedCount: N - 1`.
Job's `_status` becomes `completed`. Nothing tells the operator
that `N - 1` extra files are sitting in the destination.

This is the case the current design is worst at. A partial failure
was previously self-healing on retry — the second attempt would
overwrite the first `N - 1` files with identical bytes and write
`N..E` fresh. Under 1.16.2 the retry double-writes the successful
prefix.

---

## 2. What triggers a re-dispatch in practice?

Every path that can cause the same job's files to be written to the
same Folder Copy destination twice, ranked by practical likelihood.

### 2.1. Operator clicks Retry on an errored job

Trigger: Jobs grid renders a Retry button for any job at
`_status: 'error'` (`renderer.js:1040`). Clicking calls
`electronAPI.retryJob(jobId)` → `ohd:job:retry`
(`ipc-handlers.js:1940`). The handler resets `_status` to `received`
and clears `_errorMessage`, then fires `runAutoPrint()`. The auto-
print loop picks the job up on this cycle and dispatches through the
normal path.

Previous attempt's files on disk? **Yes, if the first attempt was a
partial failure (§1b).** If the first attempt failed before any file
was written (bad manifest, missing source, mkdir failed on an
unreachable share), the destination folder either doesn't exist or
is empty, and dedupe is a no-op.

Practical frequency: this is the primary retry path. Every "job
turned red, operator clicked Retry" flow lands here.

### 2.2. Auto Print picks up a job the operator has re-armed

Trigger: `runAutoPrint()` at `ipc-handlers.js:4269` only dispatches
jobs at `_status` of `received` or `pending`
(`ipc-handlers.js:4295`). A job that has been dispatched successfully
is at `completed` (folder_copy calls `_markCompleted` at
`print-service.js:2478` synchronously on write success) and auto-
print skips it. Auto Print therefore cannot on its own re-dispatch a
successfully-completed folder_copy job.

The only way auto-print re-dispatches is via 2.1 — the Retry button
resets `_status` and auto-print picks it up on the next cycle.

Previous attempt's files on disk? Same as §2.1.

### 2.3. `ohd:job:resend` — an explicit resend that bypasses the status gate

Trigger: `ohd:job:resend` at `ipc-handlers.js:968` explicitly
bypasses the `_status === 'received'` guard — "Bypass the
`_status === 'received'` guard — resend is intentional." (comment at
`:978`). The renderer only wires this handler to a `.btn-resend-dpof`
button (`renderer.js:1432`), which is rendered only for DPOF jobs at
`q` prefix (rejected by controller, `renderer.js:1670`). Folder_copy
jobs do not surface a Resend button in the Jobs grid.

However, the IPC channel is exposed on the preload bridge
(`preload.js:96`), so a devtools invocation or a future feature
could reach it. Not a common path in practice.

Previous attempt's files on disk? **Very likely yes** — this path
is deliberately used against jobs at `completed` or `error`, both
of which imply a first dispatch already happened. All-files-written
case = §1a shape (2E files after resend). Partial-failure case =
§1b shape.

### 2.4. Reprints via `_sendReprintViaFolderCopy`

Trigger: operator creates a reprint in the Reprint drawer; dispatch
routes through `sendReprint` → `_sendReprintViaFolderCopy`
(`print-service.js:1442`). The destination folder is `path.join(
route.outputPath, path.basename(reprintJobPath))` — i.e.,
`{OutputPath}/{orderNumber}_{jobId}-r{n}/` — always distinct from
the parent job's `{OutputPath}/{orderNumber}_{jobId}/` (or
`{orderNumber}/` under omitJobId). The `-r{n}` suffix disambiguates
reprint 1 from reprint 2 as well.

`omitJobId` is deliberately NOT applied to reprints
(`print-service.js:1482-1485`, `1.16.2 note on omitJobId`) — the
reprint's disambiguator IS the `-r{n}` suffix, and collapsing the
`{jobId}` would put `-r1` and `-r2` in the same folder.

Previous attempt's files on disk? **Only if the operator
re-dispatches the same reprint suffix twice** — an unusual path,
but the never-overwrite pass in `_sendReprintViaFolderCopy` covers
it just as it does the main path. Reprints therefore stay
architecturally isolated from parent-job re-dispatch collisions and
are not the interesting case for this investigation.

### 2.5. OrderHub itself re-issues the job

Trigger: OH's `/get-new-jobs` returns a job that OHD already has
locally. The polling merge in `job-service.js:485-509` preserves any
non-pending `_status` on the local record — a `completed` folder_copy
job stays `completed`, not resurrected to `pending`. Auto-print's
gate at `ipc-handlers.js:4295` therefore skips it.

Previous attempt's files on disk? Irrelevant — the merge blocks the
re-dispatch entry.

### 2.6. Manual Process click on a job that isn't `received`/`pending`

Trigger: the `jobs:sendToPrint` handler
(`ipc-handlers.js:697`) rejects with "Job cannot be sent to print
(status: X)" for any status other than `received`/`pending`
(`ipc-handlers.js:707`). So a completed job's Process button, if
somehow surfaced, returns an error and does not dispatch. The
renderer does not render a Process button on completed jobs
anyway.

Previous attempt's files on disk? Not reachable.

### 2.7. Anything else?

Not that I've found:
- The DPOF `folder-monitor.js` `o`/`e`/`q` prefix rename dance is
  DPOF-only. `folder_copy` output folders don't match `^[oeq](.+)$`
  so the monitor's callback never fires for them, even though
  `polling-service._startFolderMonitors` starts a watcher on the
  folder (`polling-service.js:735-736`).
- No AI-quality release path re-dispatches a completed job; the
  release lifts a hold before first dispatch, not after.
- No routing-service change re-dispatches; changing a route affects
  future dispatches only.
- No auto-updater path re-dispatches.

### Summary of §2

For all practical purposes, "re-dispatch of a Folder Copy job to the
same destination" collapses to **one** operator path: **Retry after
an error**. The `ohd:job:resend` IPC exists and bypasses the status
gate, but has no folder_copy UI. Everything else is
architecturally blocked.

That narrows the design space substantially — the exception, if
built, only needs to serve the Retry-after-error case, which is a
predictable single-step operator action against a single failing
job.

---

## 3. Auto Print interaction — what consumes the destination folder?

**Nothing that OHD controls.** The destination is whatever the
operator points the controller's `outputPath` at — typically a
Windows folder that a downstream product watches. Common shapes
Richard has mentioned in prior notes: a Wide Format press hot
folder, a lab review folder that a human operator files from, a
watched folder for a third-party imposition tool. What that
consumer does with a `_2` file, OHD does not know.

What we do know:
- OHD does **not** watch the folder_copy destination for consumer
  activity. The DPOF `folder-monitor.js` is DPOF-specific (`o`/`e`/
  `q` prefix renames); folder_copy destinations don't match that
  pattern (`folder-monitor.js:80` — `/^[oeq](.+)$/`).
- OHD does **not** clean up the destination. Files land and stay.
- OHD does **not** know whether the consumer already picked up a
  file when a re-dispatch fires. From OHD's point of view a
  destination file is just "on disk"; whether the press already
  printed it, whether the operator already filed it, whether a
  watcher already ingested it into another queue — invisible.

What we don't know (would take a lab conversation to answer for a
specific installation):
- Whether a hot-folder consumer would treat `photo.jpg` and
  `photo_2.jpg` as two distinct jobs to print. Most watched hot
  folders match on filename patterns and would; a few match on
  content hash or explicit manifest and might dedupe. **This is
  the load-bearing unknown** for the operational question — if the
  consumer prints `_2` copies as extra work, a Retry on a partial-
  failure job becomes an operator-visible waste of paper.
- Whether a lab review folder's human operator would notice the
  `_2` variants sitting alongside the originals and file them
  correctly, or would print both and hand the customer double the
  order.

Neither has been reported by a lab in the conversation history I
have access to. This is the space the recommendation should think
in — not "will overwriting break anything" (it certainly wouldn't),
but "does duplicate output cost the lab more than an operator-
intervention step to clean up".

---

## 4. Does anything tell the operator a re-dispatch produced duplicates?

**Log only, and not prominently.** Grep of the renderer for
`diskSuffixed` / `suffixedCount` finds no consumer. The dispatch
completion is logged at `print-service.js:2463` as:

```
Job sent to print via folder copy (routed) {"jobId":100,
"controller":"FC-...","destFolder":"...","destinationLayout":"job",
"omitJobId":true,"templateApplied":true,"images":2,"suffixedCount":0,
"truncatedCount":0,"fallbacksCount":0,"fallbackBasenames":[],
"diskSuffixedCount":2}
```

The Winston format at `services/logger.js:16-27` writes
`${timestamp} [${level}]: ${message}${metaStr}` where `metaStr` is
`' ' + JSON.stringify(meta)`. The `logs:read` handler at
`ipc-handlers.js:1084` matches the full line and puts everything
after `[LEVEL]:` into `entries[i].message`. The Activity Log tab
renders `entry.message` as text (`renderer.js:4054`) — so the JSON
meta blob IS visible, but embedded in the middle of a message line,
not called out.

An operator who knows to search Activity Log for
`diskSuffixedCount` would find it. Nothing on the Jobs grid, no
toast, no per-job badge, no completion-time summary tells them
this happened. `_status` transitions to `completed` on both a
"clean write" and a "wrote a full duplicate set". Same colour.
Same tooltip. Same everything.

Not new to 1.16.2 — the older `suffixedCount` (within-dispatch
planner suffixing) was also log-only. The 1.16.2 CHANGELOG entry
says "the Activity Log records how many files were suffixed... so
you can spot an accidental re-dispatch" — accurate but understates
how buried the signal is.

---

## Design — narrow exception: replace THIS job's own previous files

Design only. Not built. The premise is: if it's the same job going
to the same destination, it's safe to overwrite that job's own
previous output, because we know both attempts came from the same
sources with (usually) the same template.

The whole design turns on **attribution**: given a file in the
destination folder, is it this job's, or is it someone else's? Get
that wrong and 1.16.2's whole point — nothing is ever lost —
regresses.

### A. Attribution — how you decide "its own previous files"

Four candidate mechanisms, ranked. None is unambiguous on its own;
the design would combine them.

**A1. Job-owned folder (strongest, but not always available).** When
`omitJobId: false`, the destination folder is
`{OutputPath}/{orderNumber}_{jobId}/`. Every file in that folder is
this job's — no other job of any order can write there, because
`{jobId}` uniquely identifies the job. Attribution is trivial:
"every file in this destFolder belongs to me". Safe under any
template, safe under a template change between dispatches, safe if
the operator manually renamed or added files to the folder (those
would be attributed to this job too, which is arguably correct —
the folder is namespaced to this job).

**A2. Folder + filename planner-set (medium, template-dependent).**
When `omitJobId: true`, two jobs of one order share
`{OutputPath}/{orderNumber}/`. Attribution has to be per-file, not
per-folder. The simplest per-file rule: run the current planner and
consider the resulting `{p1..pE}` set as "the names this job would
write today". Match those against on-disk state — anything that
matches AND anything that matches with a `_2/_3/…` suffix on that
same stem is a candidate for replacement. But this only works when
the template hasn't changed between the two dispatches AND the
image count / manifest hasn't changed. It fails silently the
moment a template edit reshapes the planner set.

**A3. OHD-written manifest sidecar in the destination folder
(strongest but requires a code change AND accepts that the
destination folder is no longer plain files).** OHD could drop a
`.ohd-dispatch-{jobId}.json` alongside each dispatch's files
listing exactly which destFilenames belong to that jobId. On
re-dispatch, read the sidecar, know exactly which files this job
last wrote, replace those and only those. Robust across template
changes, robust across `omitJobId=true`, robust across manual
edits to the folder (a manual add doesn't appear in any sidecar,
so it's never touched).

The cost: the destination folder is no longer plain-files-only.
Downstream watchers may match on `*.json` patterns; some care
about a stable file count in the folder; some might ingest the
sidecar as a job. This runs directly into the CLAUDE.md landmine
about "files or folders OHD creates inside a folder a third-party
system watches must carry names that cannot be mistaken for real
work" — the `.ohd-dispatch-{jobId}.json` prefix is deliberately
`.`-hidden and job-suffixed, but "may be ingested" is a real risk
that varies per consumer and per lab. The 1.14.x DIGIN
`.ohdtmp` incident is the closest precedent.

**A4. Filename convention embedding jobId (strong but changes the
filenames the operator sees).** Force every file to embed `{jobId}`
in its name (either as an implicit prefix OHD prepends, or by
refusing to save a template that lacks `{jobId}` when `omitJobId`
is on). Attribution becomes an exact prefix/substring match. This
would break the "operators asked for cleaner filenames" motivation
for `omitJobId=true`, which was the whole reason 1.16.2 added the
setting in the first place — self-defeating.

**Recommended attribution stack**: A3 primary, A1 fallback, A2
disallowed, A4 rejected. Rationale below in §D.

### B. Template changed between the two dispatches

Case-by-case:

- **Under A1 (job-owned folder, `omitJobId=false`)**: safe. The
  folder is namespaced; a template edit changes the planner set
  but the exception still replaces every file in the folder,
  which is correct — those files are all this job's, whatever
  their names. On dispatch 2 with the new template, delete the
  contents of the destFolder (or archive to an `_ohd-archive/`
  sibling), then write the new planner set. No collision because
  the folder is now empty.

- **Under A3 (sidecar attribution)**: safe. The sidecar records
  which destFilenames dispatch 1 wrote. Dispatch 2 reads that
  set, deletes those specific files, writes the new set from the
  new template, rewrites the sidecar.

- **Under A2 (name-set matching)**: **unsafe**. The template
  change means the new planner set doesn't match the old on-disk
  set. The exception would fail to identify the old files as this
  job's, so it would fall back to never-overwrite (which appends
  `_2` variants to the new set) OR fail to notice a collision at
  all (if the new template happens to produce names that don't
  overlap the old files). The old files just stay — orphaned but
  not damaged, and nothing tells the operator they're stale. Not
  destructive but a strong argument against A2.

### C. `omitJobId=true` — shared folder between two jobs of one order

The hard case, and the one the exception has to handle
correctly or not at all.

- **Under A1**: doesn't apply — `omitJobId=true` means the folder
  isn't job-owned. Skip A1 entirely for this case; fall through to
  A3.

- **Under A3 (sidecar)**: safe. Each job's own sidecar lists ONLY
  its own destFilenames. Job A re-dispatching reads
  `.ohd-dispatch-{A.id}.json` and replaces the files listed there.
  Job B's files (recorded in `.ohd-dispatch-{B.id}.json`) are
  never touched, because they're not in job A's sidecar.

- **Under A2**: **unsafe in a specific and dangerous way.** If
  jobs A and B share the folder and their templates happen to
  produce overlapping names (which is exactly the collision the
  1.16.2 dispatch pass handles today with `_2` suffixing), A's
  re-dispatch would look at the destination, see files matching
  its planner set, and delete them — but some of those files are
  ACTUALLY B's from B's own dispatch, sitting under names that
  collided with A's set. Attribution failure directly deletes
  another job's file. This is the failure mode §D calls out as
  "the risk that matters".

### D. Failure mode — what would it take for this to delete another job's file?

The 1.16.2 dispatch guarantee protects against silent file loss.
Any exception that reintroduces file deletion on dispatch has to
prove it cannot delete a file that belongs to any other job, ever.

**Under the recommended stack (A3 primary, A1 fallback, A2
disallowed):**

- **A1** deletes ONLY files inside a job-owned folder
  (`{orderNumber}_{jobId}/`). A file in that folder can only be
  there because a prior dispatch of THIS job put it there (or the
  operator manually put a file there, which is user-owned data,
  not another job's). No other job of any order writes to a
  differently-suffixed folder. Safe by construction.
- **A3** deletes ONLY files listed in the sidecar written by
  THIS jobId's prior dispatch. Another job's sidecar lists
  different files; those files are never candidates for deletion.
  Safe by construction, given the sidecar itself isn't corrupted
  or tampered with.

**How you break it:**

- If A3's sidecar is written but the actual copy fails midway (a
  new partial-failure shape), the sidecar could over-list what's
  on disk. On re-dispatch, the exception would try to delete a
  file that doesn't exist — harmless (fs.unlink on a missing file
  can be tolerated) — but the sidecar's promise "these files are
  currently on disk" is now false. Fix: write the sidecar AFTER
  the copy succeeds, and on failure, write a partial-attempt
  sidecar listing the files that DID get copied. Same
  post-write-then-sidecar-write order every other OHD sidecar
  uses.
- If someone manually renames files in the destination between
  dispatches, A3 sees the sidecar entries as "still owned by this
  job" and would try to delete non-existent files (safe) and
  wouldn't touch the renamed files (safe — they're now user-owned).
  Not a data loss risk, but the second dispatch would land its
  full new set alongside the manually-renamed files, which is
  probably not what the operator wanted. Acceptable — this is
  the same behaviour they'd see under `omitJobId=false` with
  files added to the folder.
- If two jobs share the folder (`omitJobId=true`) and someone
  edits the sidecars by hand, A3 could be fooled. But
  hand-editing OHD's dispatch record files is not a supported
  workflow and would break plenty of other things too.

**How A2 breaks it (the reason A2 is disallowed):**
Two jobs A and B share the folder, templates happen to collide.
A's first dispatch writes `photo.jpg`. B's first dispatch runs,
collides, gets suffixed to `photo_2.jpg`. Now A re-dispatches. A2
runs its planner and gets `photo.jpg` — matches on disk. The
exception "replaces this job's own previous files" deletes
`photo.jpg` and re-writes it. Fine. But A2's "same-stem-plus-
suffix" rule would ALSO flag `photo_2.jpg` as a candidate,
because it looks like `photo` with a `_2` OHD would have added.
`photo_2.jpg` is B's, not A's. Attribution failure deletes B's
file. This is precisely the class of bug 1.16.2 was written to
prevent. **A2 must not be built.**

### E. Controller setting or unconditional?

Two shapes:

**E1. Unconditional replace-own-files behaviour, applies to every
Folder Copy dispatch.** Simpler, no new setting. Requires operators
to understand that a Retry now overwrites the previous attempt's
output — a change in behaviour from 1.16.2's "always suffix". If
the exception is implemented with A3, the semantic is precise
enough that this is defensible.

**E2. Per-controller "Replace this job's own previous files on
retry" checkbox.** Default OFF (matches 1.16.2 behaviour). Turning
it on opts into the replace semantic. Adds a new saved field,
therefore a new migration invariant (strict `=== true`, both route
literals, parity test — same discipline as `omitJobId`).

**Recommendation if built: E2.** The whole point of 1.16.2's
softening (`folder-copy-root-blank-template` etc. from hard blocks
to advisories) was that a save-time gate on a state dispatch
handles safely is worse than no gate. But this is the reverse
question — a per-controller opt-in for a slightly-less-safe
behaviour a lab has requested. E2 matches the shape of every other
opt-in on the folder_copy controller (destinationLayout,
filenameTemplate, orderNumberPrefixRules, omitJobId) and doesn't
force a behaviour change on labs that are content with the
suffix-on-retry semantics.

---

## Recommendation

**Leave 1.16.2's behaviour as it is. Do not build the exception
now.** Two reasons:

1. **The pain is not documented.** No lab has reported that Retry-
   after-partial-failure duplication is causing operational harm.
   The pain would show up as either (a) a lab printing double
   quantities on a Retry, or (b) an operator having to manually
   clean up `_2` files in a review folder. Neither is in the
   conversation history I have access to; both would be visible
   to Richard within a day of hitting them.

2. **The exception done right is a code and design commitment
   larger than the pain warrants today.** A3 (the sidecar
   approach, which is the only attribution mechanism that safely
   covers `omitJobId=true`) means a new file in every folder_copy
   destination. That crosses the "files OHD creates in a folder a
   third-party system watches" CLAUDE.md landmine and needs
   per-lab verification that no downstream consumer misfiles the
   sidecar. Absent a reported pain, that verification cost
   exceeds the operational benefit.

The current behaviour has a small operator-experience wart —
duplicate output on Retry, and the `diskSuffixedCount` signal is
buried in the Activity Log — but nothing is destructive. The
1.16.2 CHANGELOG and operator notes both call out that Retry
produces duplicates; an operator who reads the notes shouldn't be
surprised.

### What would change my mind

Any one of:

- **A lab reports** that a folder_copy Retry produced unwanted
  duplicate output at a real cost (extra prints, extra operator
  work). That's the case A3's cost is worth carrying.
- **A partial-failure error class becomes common enough** that
  duplicate-on-Retry is a routine occurrence. Today those
  failures are rare (out-of-space, permission drift, SMB share
  drop mid-write). If we start seeing them regularly — for
  example if the lab moves onto a flakier network share, or a new
  destination-type starts partial-failing intermittently — the
  Retry-doubles-output cost multiplies quickly.
- **The signal-visibility problem gets independently addressed**
  (a per-job "wrote N duplicate files" badge on the Jobs grid, or
  a completion toast with the `diskSuffixedCount` — cheap
  work; would need its own investigation on what the badge should
  actually say). Once the operator can see the duplication as it
  happens, the safety-vs-tidiness tradeoff moves — a visible
  duplicate on a rare Retry is easier to accept than an invisible
  one.

If any of those lands, the design in §§A–E is the starting point.
The critical constraint is that any exception must use A3 (or A1
as its subset) — A2's failure mode under `omitJobId=true`
directly regresses 1.16.2's whole point, and A4 defeats
`omitJobId`'s ergonomics. If a smaller change than A3 is wanted,
the honest answer is "don't build the exception at all".

---

## Appendix — code references

Grouped for quick jump-to:

- Dispatch: `src/main/services/print-service.js`
  - `_sendViaFolderCopyRouted` — `:2310`
  - `_sendReprintViaFolderCopy` — `:1442`
  - `_markCompleted` — `:5131`
- Never-overwrite helper: `src/main/services/folder-copy-filename.js`
  - `dedupeAgainstDisk` — `:459`
  - `_nextSuffixed` — `:219`
- Route: `src/main/services/routing-service.js`
  - Both folder_copy literals — `:442`, `:837` (with `omitJobId`
    per 1.16.2)
- Retry / resend IPC: `src/main/ipc-handlers.js`
  - `ohd:job:retry` — `:1940`
  - `ohd:job:resend` — `:968`
  - `jobs:sendToPrint` — `:697`
- Auto-print orchestrator: `src/main/ipc-handlers.js`
  - `runAutoPrint` — `:4269`
  - Status gate — `:4295`
  - Folder-copy dispatch call — `:4575`
- Job status merging: `src/main/services/job-service.js`
  - Preserve-non-pending — `:485-509`
- Activity Log: `src/main/ipc-handlers.js`
  - `logs:read` — `:1069`
- Winston format: `src/main/services/logger.js`
  - `logFormat.printf` — `:16-27`
- DPOF folder monitor (does not fire on folder_copy folders):
  `src/main/services/folder-monitor.js:80` — `/^[oeq](.+)$/`
- 1.16.2 landmine documenting the dedupe/advisory pair: `CLAUDE.md`
  under the "`dedupeAgainstDisk` in `folder-copy-filename.js` is
  what prevents file loss…" bullet.
