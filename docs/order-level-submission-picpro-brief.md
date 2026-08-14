# Claude Code brief — order-level submission, Fuji PIC Pro (Phase 1)

> Paste everything below the line into Claude Code CLI, run from
> `C:\Dev\OrderHubDownloader` on `main`, working tree clean, after the
> darkroom-media-lock work has landed.
> Background: `docs/order-level-submission-feasibility.md`.

---

Read `CLAUDE.md`, then `docs/order-level-submission-feasibility.md` in full —
especially §1 (why PIC Pro needs no generator change), §2 (what does have to be
built) and §5 (the settled decisions). That document is the analysis; this is
the build order.

**Context.** A lab wants every job in an order to reach PIC Pro as one
submission, with mixed print sizes. PIC Pro's `order.txt` is already
one-file-per-order and carries print size on the per-image `Code=` value, so
**`fuji-pic-pro-generator.js` does not change**. The work is entirely in the
caller, the readiness gate, and the grouping.

**Decisions already made — do not revisit:**
- Wait for all siblings, but with a **configurable cap**; after the cap, ready
  jobs go and stragglers follow separately.
- A late job for an already-submitted order gets a **suffixed id**
  (`ORD-1234-2`). **Never reuse an id.**
- **Per-controller setting, off by default.** With it off, behaviour must be
  byte-identical to today.
- When on, **every** submission from that controller is identified by the order
  number — including single-job orders.
- **Reprints stay per-job and untouched.** Do not merge them, do not alter any
  reprint path.

Work in **seven commits, in order**. Do not start a milestone until the previous
one's tests pass. Stop and tell me if you hit something this brief did not
anticipate — do not improvise.

I run `npm test` and all manual testing on Windows. Do not claim anything is
production ready. Show me the diff before committing each milestone.

---

## Two things to understand before designing

**1. `stageImages` deletes the staging folder.**
`fuji-pic-pro-file-writer.stageImages` does `rm -rf` on
`{imageStagingRoot}/{orderId}` before staging (review fix 8). Reusing an
`orderId` therefore destroys the previous submission's staged images — and PIC
Pro may not have moved them into DIGIN yet. This is the hard reason ids must
never be reused, and why the suffix counter has to be **persistent**, not
derived from the monitor's in-flight state.

**2. The monitor refuses a duplicate in-flight orderId.**
`fuji-pic-pro-monitor.js:291` (review fix 9). That check stays exactly as it is.
The suffix scheme means it should never fire for a legitimate late job; if it
does, something else is wrong and it must still fail loudly.

---

## M1 — Controller settings

Add to the `fujipicpro` controller:

- `mergeOrderJobs: boolean` — default `false`.
- `orderMergeWaitMinutes: number|null` — default `30`. Null or absent means use
  the default; do not treat null as "wait forever".

Work needed:

- Settings → Routing controller modal: a tick and a number box, shown only for
  `fujipicpro`. Mirror how `ocMaxPrintsPerJob` is presented for darkroompro.
- Renderer-side validation: integer 1–1440, or blank for the default. Reject a
  typo rather than clamping — same posture as `maxPrintsPerJob`
  (`renderer.js:5651-5661`).
- Defence-in-depth mirror at the IPC boundary in `ohd:routing:save-controller`,
  alongside the existing `maxPrintsPerJob` check (`ipc-handlers.js:1076-1096`).
- Surface both on the resolved route so dispatch can read them, the same way
  `maxPrintsPerJob` is carried today. **Only the `fujipicpro` route literal** —
  do not touch the other 18.

**Tests** → extend the routing save-controller tests: valid values persist;
out-of-range and non-integer rejected; absent fields default correctly; a
darkroompro controller is unaffected.

---

## M2 — `src/shared/orderGrouping.js` (pure)

Electron-free, no fs, no requires beyond other `src/shared` modules. Same shape
as `batchSplit.js` and `configHealth.js`.

```js
/**
 * @returns {{
 *   ready: boolean,
 *   reason: 'all-ready'|'waiting-for-siblings'|'cap-expired',
 *   memberJobIds: Array<string|number>,
 *   missingJobIds: Array<string|number>,
 * }}
 */
function evaluateOrderGroup({ manifestJobIds, localJobs, eligibility, controllerId, heldSince, nowMs, capMs })
```

Rules:

- A **member** is a local job whose route resolves to `controllerId`. Membership
  is decided by the caller and passed in via `eligibility` — this function does
  no routing.
- A manifest job id with **no local job record** counts as missing. We cannot
  know whether it belongs to this controller, so conservatively it blocks.
- `is_film_development` jobs are never members and never block. The caller
  filters them, but assert it here too.
- `ready: true, reason: 'all-ready'` when every manifest job is accounted for
  and every member is eligible.
- `ready: true, reason: 'cap-expired'` when `nowMs - heldSince >= capMs` and at
  least one member is eligible. `memberJobIds` is then the eligible subset only.
- `ready: false` otherwise, with `missingJobIds` populated so the UI can say
  "waiting for 2 of 4".
- Deterministic ordering of returned ids. Never throw — tolerate null/garbage
  input and return `ready:false`.

**Tests** → `src/shared/__tests__/orderGrouping.test.js`: all ready; one member
held; a manifest job with no local record; cap not yet expired; cap expired with
a partial set; cap expired with **zero** eligible members (must stay
`ready:false` — never dispatch an empty submission); film-dev job present and
ignored; single-job order; empty/garbage input.

---

## M3 — Persistent submission-sequence store

New `src/main/services/order-submission-seq.js`, own electron-store (follow the
pattern in `server-capabilities.js`).

- `nextSubmissionId(orderNumber)` → `ORD-1234` first time, `ORD-1234-2`,
  `ORD-1234-3` after. Persisted, so a restart cannot reissue an id.
- The counter is per order number, not per controller — an id must be unique on
  disk regardless of which controller wrote it.
- Provide a read-only `peek(orderNumber)` for logging/tests. Do **not** expose a
  reset.
- Bound the store: prune entries older than the `jobDateRange` window on load so
  it can't grow forever.

**Tests** → `src/main/services/__tests__/order-submission-seq.test.js`: first
call unsuffixed; subsequent calls increment; values survive a store reload;
two different orders don't interfere; pruning drops old entries and keeps
recent ones.

---

## M4 — Order-level dispatch method

New `_sendViaFujiPicProOrderRouted(jobs, route)` in `print-service.js`, sitting
alongside the existing `_sendViaFujiPicProRouted(job, route)`. **Do not modify
the single-job method** — with the setting off it must remain the only path.

Build it by lifting, not rewriting, from the existing method
(`print-service.js:2439-2712`):

- Read each job's folder and manifest as today. Every job in the group shares
  one order folder, so `_readManifest` should be called **once** per order, not
  once per job.
- Resolve image paths per job exactly as today (enhanced → cropped → corrected →
  raw), including `_applyCorrectionsToImageFiles` and the existence check.
- **Concatenate** the per-job image lists into one array, and build a parallel
  metadata array in the same order carrying, per image: the originating
  `jobId`, that job's `route.printCode`, `route.color`, the manifest
  `quantity`, and `originalFilename`. The existing code zips
  `stageResult.negNumberMap[i]` with `jobManifest.images[i]`; do the same but
  against the concatenated metadata array.
- **One `stageImages` call for the whole group**, so `0001…000N` sequencing runs
  across the order automatically. `orderId` is the id from M3.
- Build `picProJob.images` with **each image carrying its own job's
  `printCode`** — this is the entire point of the feature. Everything else
  (backprint config, `includeCustomerName`) is controller-level and shared;
  assert the group's routes agree on `controllerId`, `orderDataPath`,
  `diginPath` and fail loudly if not.
- Enqueue → write → `markCommitted` in the existing order, with the same
  rollback on write failure (`monitor.dequeue`). Do not reorder these; review
  fix 11 exists for a reason and its comment explains it.
- Lifecycle: apply the existing `checkOrderStatus` rule **per member job** —
  `_markCompleted` for each when disabled, `_markInProduction` for each
  otherwise.
- On failure at any point, mark **every** member job errored with a message that
  names the order and lists the member job ids, so the operator can see the blast
  radius. Do not mark some completed and some errored.
- `route.printSize` blank stays a warning, not a failure — same rationale as the
  existing method.

**Tests** → `src/main/services/__tests__/print-service-picpro-order.test.js`:
two jobs with different printCodes produce one file with both `Code=` values in
the right per-image positions; NegNumber sequence continues across jobs;
one `stageImages` call; all member jobs marked in_production; a staging failure
errors every member and writes no `.txt`; a group whose routes disagree on
controller fails loudly.

---

## M5 — Readiness gate and wiring

**Auto-print** (`ipc-handlers.js` `runAutoPrint`):

- Keep the existing per-job loop as the default path. Add a pre-pass that, for
  jobs routing to a `fujipicpro` controller with `mergeOrderJobs` on, buckets by
  `(order_number, controllerId)` and hands each bucket to `evaluateOrderGroup`.
- The per-job gates (awaiting-manifest, AI Quality, `computeHoldForReview`) are
  the eligibility input — run them unchanged, per job, and feed the results in.
  **Do not weaken any of them.**
- Stamp `_orderMergeHeldSince` (ISO) on a job the first time it is eligible but
  held for merging. That is the clock the cap measures from, and it must survive
  a restart. Clear it on dispatch.
- **`_orderMergeHeldSince` must never be unparseable.** `evaluateOrderGroup`
  takes numeric ms and deliberately skips the cap check when `heldSince` is
  missing or not a number — fail-closed. That means a corrupt or unparseable
  stamp would make the order wait **forever**, which is the outcome decision 1
  explicitly ruled out. So the caller must treat a missing *or* `NaN`
  `Date.parse(_orderMergeHeldSince)` as "not stamped yet" and re-stamp it to
  now, rather than passing `NaN` through. Cover it with a test.

- Add an `order-merge-waiting` reason to `computeHoldForReview`
  (`src/shared/holdForReview.js`) via a caller-supplied check, in the same style
  as the existing `batchThresholdCheck`. That gets the hold chip machinery for
  free.

**Manual Process** is the escape hatch — no new button. Operator Process on any
job in a merge-enabled order dispatches **all currently-eligible members** of
that order as one submission. Operator Send-to-Print already bypasses the hold
gates by design; keep that.

**Tests** → `src/main/services/__tests__/ipc-handlers-order-merge.test.js`:
a fully-eligible order dispatches once with all members; a partially-eligible
order does not dispatch and stamps `_orderMergeHeldSince`; past the cap it
dispatches the eligible subset; the same order with the setting **off** takes
the per-job path unchanged; a non-PIC-Pro controller is never grouped.

---

## M6 — Operator visibility

- Hold chip: the new `order-merge-waiting` reason must produce its own label via
  `deriveHoldChipLabel` (`renderer.js`), not fall through to "Manual — review
  required". Wording: **"Waiting for order — 2 of 4 jobs"**.
- Tooltip or row detail listing which sibling jobs are outstanding.
- When the cap expires and a partial order goes, log at **warn** naming the
  order, the jobs that went, and the jobs that did not. A silent partial
  dispatch is the failure mode most likely to be blamed on the printer.

`renderer.js` / `index.html` only — **no bundle rebuild**. If you find yourself
editing anything under `src/renderer/views/*.jsx`, stop and tell me.

---

## M7 — Docs + changelog

- `CHANGELOG.md` under `## Unreleased`: the feature, that it is off by default,
  the wait cap and what happens when it expires, and the suffixed-id scheme.
- `docs/order-level-submission-feasibility.md`: mark Phase 1 built.
- `docs/BACKLOG.md`: Phase 2 (Darkroom Pro) still open, and the unresolved
  merge-vs-batch-cap interaction.
- Do not bump the version or touch `electron-builder.yml`.

---

## Guardrails

- **`fuji-pic-pro-generator.js` must not change.** If you think it needs to,
  stop and tell me — that means the analysis is wrong.
- **With `mergeOrderJobs` off, behaviour must be byte-identical to today.**
- **Never reuse a submission id.** See the `rm -rf` note above.
- **Never dispatch an empty submission**, including at cap expiry.
- **Do not touch any reprint path** (`print-service.js:1084-1085, :1243, :1406,
  :1620, :1784`).
- **`is_film_development` jobs must never reach** the Jobs grid, auto-print, the
  S3 downloader, or `markReceived`.
- **`.gitattributes` forces `eol=lf`** — check `git diff --ignore-cr-at-eol`
  before believing a whitespace-only diff.
- **Tests must live in one of the five globs in `package.json`.** `node:test` +
  `node:assert/strict`. Direct `node --test` runs need `--test-force-exit`.
- The `perfectlyClearClient` test file is flaky as a *file* — rerun once; not
  release-blocking.

## Verification checklist (I will run these)

1. Setting off → a two-job order produces two submissions exactly as today,
   with job-name ids.
2. Setting on → the same order produces **one** `.txt` with both print codes,
   images numbered `0001…000N` across both jobs, id = order number.
3. A single-job order on a merge-enabled controller uses the order number as its
   id, not the job name.
4. Holding one job of a four-job order stops the whole order and shows
   "Waiting for order — 3 of 4 jobs".
5. Past the wait cap the eligible three dispatch, a warn is logged naming the
   fourth, and the fourth later dispatches on its own as `ORD-xxxx-2`.
6. Pressing Process on any member dispatches the eligible members immediately.
7. Restarting mid-wait does not reset the clock and does not reissue an id.
8. A reprint of a member job still goes out on its own, unchanged.

Start with M1. Show me the diff before committing.
