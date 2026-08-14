# Order-level submission — Darkroom Pro + Fuji PIC Pro

**Status:** feasibility investigation, 2026-08-13.
**Phase 1 (Fuji PIC Pro) built 2026-08-14** — see
`docs/order-level-submission-picpro-brief.md` for the milestone list and
the CHANGELOG Unreleased entry for operator-facing behaviour. Off by
default per controller; every guardrail in §3 is enforced or explicitly
deferred (see `docs/BACKLOG.md` for the merge-vs-batch-cap decision that
Phase 2 will need to make).
**Phase 2 (Darkroom Pro) not started.**
**Ask:** two labs (one Darkroom Pro, one Fuji PIC Pro) want every job in an
order to reach the controller as a **single submission**, with mixed print
sizes in that one submission. Both controllers support multiple sizes per
order.

**Verdict: feasible, and cheaper on the format side than batch splitting was.**
Neither file format needs inventing — one already does this natively and the
other is two lines away. Essentially all of the cost is in *orchestration*:
deciding when an order is ready to go, and grouping the dispatch loop.

---

## 1. The formats already support it

### Fuji PIC Pro — no generator change at all

`fuji-pic-pro-generator.js` is **already one-file-per-order by design**:

```
[Order]
OrderId={orderId}
[Neg]  NegNumber=…      ← repeats
[Unit] Code=… Qty=… Color=…
```

Its own header comment says it outright: *"PIC Pro is one-file-per-order
(unlike JobMaker's one-file-per-surface), because OrderGateway ties surface to
the per-image `Code=` value rather than the file itself."* Size and surface ride
on the per-image `Code=`, so **mixed sizes in one submission is exactly what
this format was built for**.

It behaves per-job today only because of the caller. `print-service.js:2542`:

```js
// orderId is per-job (job_name, e.g. ORD-O4YK5Z-1) — matches
// JobMaker's convention so two jobs from one order can't collide
// in PIC Pro's staging or Order Data folders.
const orderId = job.job_name || job.order_number || '';
```

That comment is the feature request inverted: the collision it avoids is the
merge the lab now wants.

### Darkroom Pro — one small generator change

`darkroom-pro-output.js` emits a header then **one complete block per image**,
and `Size=` / `Media=` are written *inside each block* (`:303-305`). The comment
at `:287-290` explains why: explicit-per-image beats relying on Darkroom Pro's
sticky-field inheritance.

- **Media already varies per block** — resolved per line item at `:265-271`.
- **Size does not.** It is resolved once from `job.productCode` at `:193` and
  reused in every block.

So the *file format* already carries mixed sizes; only the generator assumes
one. Making `size` per-block mirrors what `media` already does.

The other per-job coupling is identity: `ExtOrderNum`, `Orderid` and the
filename all come from `outputFilenameStem` (`:238, :284, :307, :330`), which is
per-job precisely so *"the second job's .txt doesn't overwrite the first"*. For
order-level that becomes the order number, and the reason for the per-job stem
disappears.

**Caveat I cannot close from here:** I have verified what OHD emits and what the
code's cited specs say (PIC Pro v3.0 User Guide pp. 339-370; the Darkroom Pro
format doc). I have not tested either controller's actual behaviour with mixed
sizes in one order. Worth one manual test file per controller before building.

---

## 2. What actually has to be built

### (a) Knowing when an order is ready — the real cost

Today every gate in `runAutoPrint` (`ipc-handlers.js:2944-3065`) is per job:
awaiting-manifest, AI Quality, and `computeHoldForReview` (manual review,
routing hold, batch threshold). Order-level dispatch inverts that: **the order
can only go when every job in it has cleared every gate.** One held job holds
the whole order.

The good news is the completeness signal already exists on disk. The order
manifest is order-level and carries `manifest.jobs[]` — that is what
`_findJobInManifest` searches. So OHD can tell how many jobs an order has, and
which are present, without asking the server.

The bad news is this is genuinely new, user-visible behaviour. Jobs will sit in
Awaiting Processing for reasons that have nothing to do with themselves. It
needs:

- an operator-visible reason on the row — *"waiting for 2 of 4 jobs in this
  order"* — or labs will think work has vanished;
- an escape hatch. An order where one job never clears (cancelled, quarantined,
  stuck in review) must not strand the others forever. Recommend a **"Send
  anyway"** action plus a configurable wait cap.

### (b) All jobs must route to the same controller

`resolveRoute` is per job, keyed on product code + options. An order carrying a
Darkroom Pro product and a Fuji product cannot be one submission. The grouping
key is **(order, controller)**, not (order). A mixed order becomes one
submission per controller — which is what "single submission" means in practice
and is fine, but it must be said out loud to the labs.

### (c) The dispatch loop is per-job

`runAutoPrint` iterates `for (const job of jobs)` and dispatches each one.
Order grouping needs a pre-pass that buckets eligible jobs by
`(order_number, controllerId)` and dispatches the bucket once. The existing
per-job path has to stay intact for every other controller type.

Lifecycle is the easy part: `_markCompleted` / `_markInProduction` take a job
id, so a group dispatch just calls them for each member. No redesign needed.

### (d) PIC Pro staging — the one piece of genuinely new code

Images are staged as `0001.<ext>`, `0002.<ext>` … under a per-`orderId` folder,
and `NegNumber` is capped at 15 characters. Order-level means one staging folder
per order, sequence numbering continuing across jobs, and **each image carrying
its own job's `route.printCode`**. The current call site
(`print-service.js:2555-2585`) assumes a single `route` for every image in the
file — that assumption is what has to go.

The PIC Pro monitor also keys on `orderId` and **refuses a duplicate in-flight
orderId** (`fuji-pic-pro-monitor.js:291`, review fix 9). Order-level keys make
that matter more: if an order dispatches and a late job then arrives for the
same order, the second submission is rejected outright. That needs a decided
policy, not a discovered one.

---

## 3. Interactions worth naming before anyone builds

**Batch splitting (v1.10.0) is the exact inverse of this.** One splits a big job
into several submissions; this merges several jobs into one. On a Darkroom Pro
controller with `maxPrintsPerJob` set they collide head-on: merge the order then
split by cap, or split per job and never merge? Recommend **merge first, then
apply the cap to the merged print count** — anything else produces output the
operator can't predict. Either way the batch-threshold hold in
`computeHoldForReview` becomes order-aware, or it holds on per-job counts that
no longer mean anything.

**Reprints stay per-job.** Every reprint path deliberately leaves parent
lifecycle untouched (`print-service.js:1084-1085, :1243, :1406, :1620, :1784`).
A reprint is a sibling job and should remain its own submission. Do not merge
them.

**Darkroom Pro still has no acceptance signal in the routed flow** (already in
`BACKLOG.md`). `DarkroomProMonitor._extractOrderNumber` only matches filenames
of the shape `Order<something>`, while the routed writer emits
`{job_name}.txt` — so for a job named `ORD-XXXX-1` the monitor never matches and
nothing is ever marked accepted. Order-level dispatch does not make this worse,
but "did the order actually land?" stays unanswerable for this lab until it is
fixed. Worth pricing into the same piece of work.

**Per-job Assign overrides** (`_darkroomProSize`, `_darkroomProMedia`) are stored
on the job and must survive into the merged file per block. Free once Size is
per-block.

---

## 4. Shape and rough cost

| Phase | Scope | Relative cost | Status |
|---|---|---|---|
| Prerequisite | Order grouping + readiness gate + operator visibility + escape hatch | **Most of the work** | **Built 2026-08-14** (part of Phase 1) |
| Phase 1 | Fuji PIC Pro — caller + staging + per-image printCode. No generator change. | Moderate | **Built 2026-08-14** |
| Phase 2 | Darkroom Pro — per-block Size, order-level stem, batch-cap interaction | Moderate | Not started |

Overall comparable to batch splitting, possibly a little more, because the
waiting logic is new and operator-visible whereas batch splitting was mostly a
pure function plus a hold reason. The formats — the part that killed the Epson
half of batch splitting — are not the obstacle here.

Recommend PIC Pro first: its format needs nothing, so it proves the grouping
machinery with the least moving parts.

---

## 5. Decisions — settled 2026-08-13

Answered by Richard. Phase 1 (Fuji PIC Pro) is briefed in
`docs/order-level-submission-picpro-brief.md`.

1. **Waiting policy — wait, with a cap.** The order waits for every sibling to
   become eligible. After a configurable wait the ready jobs dispatch as one
   submission and the straggler follows separately. Nothing strands.
2. **Late-arriving job — separate submission, suffixed id.** `ORD-1234`, then
   `ORD-1234-2`, `ORD-1234-3`. Never reuse an id.
3. **Rollout — per-controller, off by default.** A setting on the PIC Pro
   controller, same shape as the Darkroom Pro batch cap.
4. **Single-job orders — always use the order number when the feature is on.**
   One id convention per controller, not two.

Still open, and Darkroom-Pro-only (Phase 2):

- Batch cap + merge on the same Darkroom Pro controller — merge then split, or
  make the two mutually exclusive per controller?

Still open, and worth answering before Phase 1 ships to a lab:

- Has either lab confirmed the controller side? One hand-built order file with
  two different sizes, dropped in the hot folder, settles the format question
  for good and costs an afternoon.

## 6. Original decision list (superseded by §5)

1. **Waiting policy.** Does an order wait indefinitely for a held sibling, or
   dispatch the rest after a cap? If capped, what happens to the straggler?
2. **Batch cap + merge on the same Darkroom Pro controller** — merge then split,
   or make the two features mutually exclusive per controller?
3. **Late-arriving job for an already-dispatched order** — separate submission
   with a suffixed id (recommended), or refuse?
4. **Opt-in per controller**, off by default, like batch splitting? Recommend
   yes — this changes dispatch timing for every order on that controller.
5. **Do the labs want every job, or every job going to the same printer?** These
   differ the moment an order spans two controllers, and the answer changes what
   we promise them.
6. **Has either lab confirmed the controller side?** One hand-built order file
   with two different sizes, dropped in the hot folder, settles the format
   question for good and costs an afternoon.
