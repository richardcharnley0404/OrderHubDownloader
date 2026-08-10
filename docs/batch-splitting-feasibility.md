# Batch splitting large print jobs — feasibility

**Status:** investigation only, 2026-08-09. Nothing built.
**Priority controllers:** Darkroom Pro, Epson (DPOF family).
**Requirement:** a lab sets a max images per print job. Jobs above it are split
into batches so a 600-image order doesn't monopolise a printer while smaller
urgent work waits.

---

## RESOLVED 2026-08-09 — the Epson blocking question is answered

Evidence: *SureLab OrderController LE Operation Guide* (CMP0071-00 EN), the
Epson controller software the labs actually run.

**The "Epson prints strictly in arrival order and cannot be managed" premise is
false.** Orders are FIFO *by default* (p.36: "processed one-by-one from the top
of the list"), but the software ships with first-class queue management:

- **Interrupt Order** (p.53) — the manual describes this exact scenario
  verbatim: *"If you have a high-priority order, select the order you want to
  print, and then click **Interrupt Order**… Also, if the order being printed
  has a lot of copies and is therefore taking a long time, you can pause the
  current order to allow the high-priority order to be printed."* The
  interrupting order is moved to the top of the list and starts printing (p.54).
- **Pause/Resume a job mid-print** (p.37) — *"You can print other orders when
  the current print job is paused."*
- **Order Priority** setting, Settings → Basic Settings → Print Settings —
  `Time Received` vs `Processing Priority` (p.38, p.54).
- Stop-all and per-order hold (p.38-39).

Richard has separately confirmed **Darkroom Pro's queue can also be managed
effectively**.

### Consequences

1. **Phase 2 (hold batches, release one at a time) is dropped.** It exists only
   to work around a limitation that isn't real. That removes the hardest,
   riskiest half of the feature — the persisted queue, the release trigger, the
   stall detection, and the "a stuck batch means a job never finishes" failure
   mode.
2. **The labs' original complaint may already be solvable with software they
   own.** Before building anything, check whether they know about Interrupt
   Order. If the answer is "no, nobody showed us", the cheapest fix to their
   stated problem is a page of operator documentation, not a code change.
3. **Splitting is still worth building**, but the justification changes from
   *essential* to *convenience and robustness* — see §8.

**One operational caveat worth passing to labs:** with `Order Priority` set to
`Time Received`, printing **stops** when it reaches a held order even if ready
orders sit behind it (p.38). Under `Processing Priority`, held orders are
postponed and the queue continues. A lab on `Time Received` that holds a batch
will block everything behind it.

---

## 1. The headline: this is two features, not one

The request contains two separable things with very different costs.

**Feature A — split the job into N outputs.** Slice the image list, write N
folders/files instead of one, teach the completion tracking to expect N.
Moderate, well-bounded, no new architecture.

**Feature B — hold the batches and release them one at a time.** Requires a
persisted queue, a trustworthy "the printer has finished the previous batch"
signal, restart recovery, stall detection, and an operator escape hatch.
Substantially harder, and the signal it depends on does not currently exist in
usable form for either priority controller.

**A alone does not deliver the stated goal on Epson.** The brief's own premise
is that the Epson prints strictly in arrival order. If that's true, dropping six
batches into the hot folder at once leaves the printer just as monopolised as
one big job — the urgent small job still queues behind all 600 prints. Feature A
on its own buys you nothing there *unless* the operator can reorder the queue at
the printer.

On Darkroom Pro the picture may differ — worth confirming whether its queue can
be reordered or paused by the operator. If it can, Feature A alone is genuinely
useful there.

**Recommendation: confirm the Epson ordering claim before building anything.**
The brief flags it as "apparently but not confirmed", and it is the single fact
that decides whether this is a moderate feature or a large one.

---

## 2. A finding that improves the proposed design, for free

The brief accepts an imperfection: *"if they want 2 prints of each image then 600
images will be split into 6 jobs but each batch will take twice as long."*

**That imperfection is avoidable at no extra cost.** OHD already knows the
per-image copy count at dispatch time:

- DPOF: `lineItems` is built from `manifestImg.quantity`
  (`print-service.js:262-266`).
- Darkroom Pro: images are grouped by `manifestImg.quantity` into line items
  (`print-service.js:1934-1953`).

So the batch boundary can be computed on **cumulative prints** rather than image
count, with the same one-line-of-arithmetic effort:

```
maxPrintsPerBatch = 100
600 images × 1 copy  → 6 batches of 100 images   (as proposed)
600 images × 2 copies → 12 batches of 50 images  (each batch = 100 prints)
```

Every batch then takes roughly the same time on the printer, which is the actual
goal. The setting should be labelled **"maximum prints per job"**, not
"maximum images" — clearer to the lab and strictly more correct.

Edge case to handle: a single image with a copy count above the cap (e.g. 250
copies of one photo). Either let that batch exceed the cap, or split the copies
across batches. Splitting copies is easy for DPOF and Darkroom Pro because
quantity is just a field — but it changes the print order, so simplest is to let
it exceed and log it.

---

## 3. What's genuinely cheap

**The configuration setting.** Adding one optional per-controller integer is a
well-trodden path — `ignoredOptionNames` (v1.7.18) and `bannerSheet` are the
precedents.

- No new IPC channel — reuse `ohd:routing:save-controller`.
- No `preload.js` change.
- No migration or backfill — absent field read as "off", matching the existing
  `Number.isFinite(x) ? x : default` idiom used for `gatewayTimeoutMs`
  (`routing-service.js:487`).
- **No `npm run build:renderer`.** The controller modal is plain HTML +
  vanilla JS (`index.html:1128`, `renderer.js:4847` / `:5326`), not React.

Roughly 5 files: `index.html`, `renderer.js` (4 edits), `routing-service.js`
(route literals), `print-service.js` (the consumer), `CHANGELOG.md`.

Two traps in that area, both structural rather than conceptual:

1. `resolveRoute` hand-writes **19 separate route object literals**. A missed one
   yields `undefined` rather than an error.
2. The controller save **rebuilds the object from scratch** (`renderer.js:5346`)
   and there is a *second* inline editor at `renderer.js:4119`. A field read in
   one save path but not the other is silently wiped on edit.

**The slicing itself** is a pure function over an array — trivial to write and
trivial to unit test, and it belongs in `src/shared/` so both dispatch paths and
the tests can use it.

---

## 4. What's genuinely hard — the completion accounting

This is where the real work is. Both dispatch paths assume **one job → one
output → one lifecycle transition**, and several places fail *silently* when that
stops being true.

### DPOF / Epson

| # | What breaks | Where |
|---|---|---|
| 1 | **Batch 1 accepted marks the whole job completed.** The folder monitor parses the jobId out of the folder name and calls `markCompleted` on it. Six folders → six completion attempts on one job. The first wins; batches 2-6 return HTTP 400, which is caught and downgraded to a log warning. The operator sees a 600-image job marked done while five batches are still queued. | `polling-service.js:817-858`, `folder-monitor.js:106`, `job-service.js:610-612` |
| 2 | **Folder name collisions.** `buildFolderName` is a pure function of the job — six calls produce the identical string. `mkdir` is `recursive:true` (no error), `copyFile` and the MRK write both overwrite. Batches would silently merge into one folder; only the final rename fails. | `printUtils.js:65-89`, `order-folder-writer.js:51-70` |
| 3 | **Output status can't represent "3 of 6".** `getJobOutputStatus` rebuilds exactly one expected folder name and returns the first prefix match. With suffixed batch folders it returns `null` — so the job shows no status at all, *and* the 10-second status poll concludes there's nothing awaiting and shuts itself off. | `outputStatusManager.js:40-53`, `ipc-handlers.js:2725-2760` |
| 4 | **Duplicate back-print traceability strings.** `PRT PID` restarts at 001 in every MRK, and the Noritsu `CVP1` back-print is `"{orderNumber}, {pid}"`. Six batches back-print the same string on six different photos. | `dpof-generator.js:68, 84` |
| 5 | **Epson MRK contains no job identifier at all** — `USR CID` is suppressed for Epson, and its `CVP1`/`CVP2` are filename and timestamp. The folder name is the *only* thing tying an Epson batch to a job. | `dpof-generator.js:55, 80-81` |

Hazard #1 is **not hypothetical** — it already exists in a one-off form. A
reprint produces a second folder for the same `job.id`, and when that folder is
accepted the monitor calls `markCompleted` on the *parent*, even though the
reprint path deliberately skips the lifecycle update. Batching multiplies an
existing latent bug. Worth fixing regardless of whether this feature is built.

The existing `reprintSuffix` parameter (`order-folder-writer.js:40`,
`printUtils.js:71`) is the natural hook for a batch discriminator — it's already
threaded through the naming path. Note it lands *before* the product segment.

### Darkroom Pro

Simpler in one way, worse in another.

- **One file per send**, named `{job_name}.txt`, no sequence component
  (`darkroom-pro-output.js:331-335`). Six batches overwrite each other silently
  — `writeFile` with no `wx` flag and no existence check. The reprint path
  already establishes the suffix precedent (`-r1`), so `-b1..-bN` follows it.
- Changing the filename also changes `ExtOrderNum` and `Orderid` inside the file
  (both derive from the same identifier, `darkroom-pro-output.js:238, 284, 307`).
  **Unknown downstream:** whether Darkroom Pro treats six distinct `Orderid`
  values as six orders or refuses them. Needs a lab test — the code cannot
  answer it.
- **There is currently no working completion detection for routed Darkroom Pro
  at all.** The monitor's filename regex only matches the *legacy*
  `Order{n}.TXT` shape, so the routed emitter's `{job_name}.txt` is never
  tracked (`darkroom-pro-monitor.js:145-149`), and the routed path never calls
  `trackSubmission` or `startMonitoring`. Completion is decided synchronously at
  dispatch time from the `checkOrderStatus` flag. Nothing notices if a file is
  never consumed.

That last point cuts both ways: nothing needs *teaching* about N files, but
Feature B has no signal to fire on either.

### Partial failure

If batch 4 of 6 throws, batches 1-3 are already in the hot folder and being
printed. There is no rollback, no per-batch record, and nothing persisted that
says "this job was dispatched as N parts". The caller just stamps
`_status:'error'` on the whole job. **Any batching implementation needs a
persisted per-batch ledger** — this is the single largest piece of new state.

### Also worth knowing

- Batch boundaries must be computed **after** the operator-discarded filter and
  **after** banner-sheet insertion, or the boundaries shift when images are
  discarded (`print-service.js:2978-2987`, `:295-316`).
- The expensive per-job preparation (enhanced-path map, CMY corrections
  rendering into `/working/`) must be hoisted **above** the batch loop, or it
  runs 6× — 6× the disk churn for identical output.
- Darkroom Pro's current image order is quantity-grouped, not manifest order — a
  Map insertion-order side effect. If batches are expected to follow manifest
  order, that's a behaviour change to make deliberately.

---

## 5. Feature B — hold and release one at a time

### The blocker is the release trigger, not the queue

There is a good, battle-tested queue chassis to copy: the Fuji PIC Pro monitor
(`fuji-pic-pro-monitor.js`). Its reusable parts are genuinely strong —
per-controller namespaced `electron-store` persistence, persist-on-every-mutation,
tolerant rehydrate on restart, a dual-cadence sweep (1s active / 60s idle) with
`fs.watch` as an accelerator rather than the source of truth, a `present /
absent / **unknown**` classification so a network blip can't fake a signal, a
two-consecutive-observations debounce, and a two-phase enqueue → write → commit
protocol that survives a crash mid-dispatch.

But its *state machine* is Fuji-specific, and its data model is the inverse of
what's needed: it tracks orders **fully in parallel** with no ordering and no
"next" pointer, and actively rejects duplicate ids. Batch release needs N
siblings sharing a parent, strictly ordered, at most one live. That's reusing
the chassis, not the machine.

The harder problem is what fires the release:

| Controller | Available signal | Fit |
|---|---|---|
| Epson / DPOF | folder rename `o…`→`e…` | Weak. Means "ingested", not "printed". Polled at 2s via chokidar. **Discarded entirely on a default install** — the handler is gated behind `autoCompleteOnPrinterAccept`, default false. |
| Darkroom Pro | `.TXT` disappears from hot folder | Moderate, but the routed path isn't wired to it at all (see §4), and tracking is in-memory so a restart loses it. |
| Fuji PIC Pro | three-stage consumption tracking | Strong — but not a priority controller here. |

### A cheaper release trigger worth considering

Rather than tracking each batch individually, poll the **hot folder itself** and
release the next batch when the previous one has been picked up:

- DPOF: are there any `o*` folders left in `route.outputPath`?
- Darkroom Pro: are there any `.txt` files left in `controller.outputPath`?

This is one `readdir` per controller per tick. It needs no per-batch identity, no
rename correlation, and no change to the monitors. It is coarser — it says "the
printer has taken everything I gave it", not "batch 3 specifically is done" —
but that is exactly the condition for releasing the next batch, and it has the
useful property of naturally yielding to *any* other work in the folder,
including the urgent small jobs this feature exists to unblock.

It also degrades safely: if the folder never empties, batches simply don't
release, and a timeout can surface that to the operator rather than silently
stalling.

`film-scan-source-mirror.js:75-80` is the existing precedent for this shape —
`decideIngest()` returns `skip-watch-busy` when a prior copy hasn't been
consumed. Three lines, pure function.

### Where release would hook in

`runAutoPrint` (`ipc-handlers.js:2801-3043`) is the natural host. It already
enumerates work, applies a stack of skip gates, dispatches, and continues. A
batch queue would be one more gate plus a per-controller check. There's an
established precedent for kicking it on an event rather than waiting for the
timer — the routing-hold release calls `runAutoPrint()` directly
(`ipc-handlers.js:1387`).

Two caveats: its default cadence is 60s (server-advertised since v1.9.0), which
would leave the printer idle up to a minute between batches unless the release
kicks the cycle directly; and `_autoPrintRunning` makes it non-reentrant, so a
release fired from a monitor callback mid-cycle is **silently dropped, not
queued**.

---

## 6. Effort

Milestone counts, in the style of this repo's recent work. Each is one commit
with tests.

**Phase 1 — split and send all at once (Darkroom Pro + Epson/DPOF)**

| | Milestone |
|---|---|
| M1 | `maxPrintsPerJob` controller setting + route plumbing + UI (~5 files, no bundle rebuild) |
| M2 | Pure batching function in `src/shared/` — cumulative prints, edge cases, tests |
| M3 | Persisted per-batch ledger (which batches dispatched, which accepted) |
| M4 | DPOF dispatch loop + batch-suffixed folder names |
| M5 | Fix the completion accounting — job completes only when all batches are accounted for. **Also fixes the existing reprint bug.** |
| M6 | Darkroom Pro dispatch loop + batch-suffixed filenames |
| M7 | Output status UI — "batch 3 of 6" instead of a single state |
| M8 | Docs + changelog |

Comparable in size to the ohd-api v1.4.0 work, with more UI and more risk,
because it changes what happens on the printer rather than what happens on the
network. M5 is the one to be careful with.

**Phase 2 — hold and release one at a time**

| | Milestone |
|---|---|
| M9 | Per-controller batch queue with persistence + restart rehydrate |
| M10 | Hot-folder-empty release trigger + poll |
| M11 | Stall detection, timeout, operator "release all now" override |
| M12 | UI for held batches |
| M13 | Lab testing against a real Epson and a real Darkroom Pro |

Similar size again, and carrying a genuine operational risk: **a stuck batch
means a job never finishes printing**, which is worse than the problem being
solved. The override in M11 is not optional.

---

## 7. Open questions to resolve before building

1. **Does the Epson really print strictly in arrival order?** Decides whether
   Phase 1 alone is useful there or whether Phase 2 is mandatory. Currently
   unconfirmed.
2. **Can Darkroom Pro's queue be reordered or paused by the operator?** If yes,
   Phase 1 alone may fully satisfy the Darkroom Pro labs.
3. **Does Darkroom Pro accept six files with six distinct `Orderid` values as
   six separate orders?** Needs a lab test; the code can't answer it.
4. **Should batching be on prints or images?** Recommendation: prints (§2).
5. **What happens to a reprint of a batched job?** Suggest: out of scope for v1,
   reprints stay unbatched.
6. **Should the split be visible in Job Review**, or invisible plumbing? Affects
   M7's size considerably.

---

> **Superseded by §10.** Richard settled the design on 2026-08-09 after
> confirming Darkroom Pro does *not* have the Epson's Interrupt Order feature.
> §8 and §9 below are kept for the reasoning; §10 is what to build.

## 8. Recommendation (revised after the manual)

**Build Phase 1 only. Drop Phase 2.**

Both controllers can be driven manually to unblock an urgent job, so OHD does
not need to become a print scheduler. That removes the half of this feature that
carried real operational risk.

Splitting still earns its place, on three grounds that survive the manual:

1. **No operator intervention needed.** Interrupt Order requires someone to
   notice, pause, select and resume. Batches create natural break points that
   let urgent work through without anyone watching the printer.
2. **Blast radius.** A failure part-way through 600 prints currently loses the
   whole order. Six batches fail one batch.
3. **Even batches, by prints not images** (§2) — a genuine improvement over
   both the current behaviour and the original proposal.

**But ask the labs one question first:** do they know Interrupt Order exists?
The manual describes their exact complaint and solves it with buttons they
already have. If nobody has shown them, a page of operator documentation may
satisfy the request this week, and splitting becomes a considered improvement
rather than a rush job.

Regardless of the decision, **hazard #1 in §4 (a reprint's accepted folder
completing its parent job) is a live bug today** and worth fixing on its own.

## 9. Revised open questions

Superseded: the Epson ordering question (answered) and the Darkroom Pro queue
question (answered).

Still open:

1. **Do the labs know Interrupt Order exists?** Decides whether this is urgent
   or considered.
2. **Does Darkroom Pro accept six files with six distinct `Orderid` values as
   six separate orders?** Needs a lab test; the code cannot answer it. This is
   now the only remaining technical unknown blocking Phase 1.
3. Reprints of a batched job — suggest out of scope for v1.
4. What cap would labs actually set? Informs the default.

---

## 10. AGREED DESIGN (2026-08-09) — operator-triggered split

### Correction to §7/§8

Darkroom Pro does **not** have the Epson OrderController's Interrupt Order /
pause-mid-print capability. That inverts the priority:

- **Darkroom Pro is priority 1** — it's the controller that genuinely needs
  splitting, because there's no way to let an urgent job past a running
  600-image order.
- **Epson OrderController is priority 2** — it can already interrupt, so
  splitting there is a convenience: it produces separate orders the operator
  can reorder and schedule in the OrderController queue rather than one
  monolith.
- **No other controller has been asked for.** Scope to these two.

### The flow

1. A job arrives whose print count exceeds the controller's configured cap.
2. **OHD holds it** — it does not auto-print. The operator sees it flagged in
   the Jobs grid.
3. The operator clicks **Process / Send to Print** when they choose.
4. OHD splits it and sends **all batches at once** into the controller.
5. Batches are identified by a `_1`, `_2`, … suffix.
6. The operator then reorders / schedules those separate jobs inside Darkroom
   Pro or the Epson OrderController as they see fit.

This is deliberately **not** a scheduler. OHD decides *how many* jobs to create
and *when to release the set*; the controller's own queue decides the order they
print in. That keeps all the timing intelligence where it already works and
avoids the persisted release queue that made Phase 2 risky.

### Naming

- **Darkroom Pro:** `{job_name}_1.txt`, `{job_name}_2.txt`, … The identifier is
  also emitted inside the file as `ExtOrderNum` and `Orderid`
  (`darkroom-pro-output.js:238, 284, 307`), so each batch carries a distinct
  order id — **which is exactly what makes them appear as separate orders in
  the Darkroom Pro queue.** That is the desired behaviour here, not a side
  effect. Still needs one lab test to confirm Darkroom Pro accepts it.
- **Epson / DPOF:** folder-name discriminator via the existing `reprintSuffix`
  slot (`order-folder-writer.js:40`, `printUtils.js:71`). Note it lands *after*
  the surname and *before* the product segment, so the result is
  `o{jobId}_{jobNo}[_{surname}]_1_{product}_…`. If the `_1` must sit elsewhere
  in the name, `buildFolderName` needs a dedicated batch parameter rather than
  reusing the reprint slot.

### The hold

Reuse the existing hold machinery rather than inventing one. `runAutoPrint`
already has a stack of skip gates (`ipc-handlers.js:2813-2974`) and
`computeHoldForReview` already produces `{_holdForReview, _holdReasons}` with an
operator-readable tooltip (`src/shared/holdForReview.js:46-50`). A new
`over-batch-threshold` reason slots in alongside `manual-source`, `manual-file`
and `routing-hold`. Manual Send-to-Print is unaffected by that gate today, which
is precisely the behaviour wanted — the operator's click is the release.

### Milestones

Darkroom Pro is shippable at M6; Epson follows as a second release.

| | Milestone | Ships |
|---|---|---|
| M1 | `maxPrintsPerJob` per-controller setting + route plumbing + modal UI (~5 files, no bundle rebuild) | |
| M2 | Pure `splitIntoBatches()` in `src/shared/` — cumulative prints, post-discard, banner handling, over-cap single image; unit tested | |
| M3 | `over-batch-threshold` hold reason + auto-print gate + Jobs-grid badge | |
| M4 | Darkroom Pro batched dispatch — N files, `_1`/`_2` naming, per-job prep hoisted above the loop, persisted per-batch ledger, partial-failure handling | |
| M5 | Darkroom Pro completion accounting — job completes only when all batches are written; today it has no acceptance signal at all (§4) | |
| M6 | Visibility — "sent as 6 batches", per-batch state in the Jobs grid / Job Review | **Darkroom Pro release** |
| M7 | Epson / DPOF batched dispatch — N folders with the `_1` discriminator | |
| M8 | DPOF completion accounting — complete only when all batches accepted. **Also fixes the live reprint-parent-completion bug (§4).** | |
| M9 | Docs + changelog | **Epson release** |

### What this design removes from the risk list

- No persisted release queue, no release trigger, no stall detection, no
  "stuck batch means a job never finishes". All of §5 is gone.
- Partial failure is still real (batch 4 of 6 throwing) and still needs the
  ledger in M4 — but the operator is present at the moment of dispatch, so it
  can surface immediately rather than silently hours later.

### Decisions still needed

1. **Cap in prints or images?** Recommend prints (§2) — even batch durations
   for the same effort. Label it "maximum prints per job".
2. **Ship Darkroom Pro alone first (M1-M6)?** Recommend yes — it's the
   controller that needs it, and it halves the exposure of the first release.
3. **When does the job go `completed` in OrderHub?** Recommend keeping the
   existing per-controller `checkOrderStatus` behaviour, but only firing once
   *all* batches are accounted for — never on the first.
