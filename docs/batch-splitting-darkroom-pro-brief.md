# Claude Code brief — batch splitting, Darkroom Pro release (M1–M6)

> Paste everything below the line into Claude Code CLI, run from
> `C:\Dev\OrderHubDownloader` on `main`. Written against the code as of
> v1.9.0 (`1e10786`). Background and the full investigation are in
> `docs/batch-splitting-feasibility.md` — §10 is the agreed design.

---

Read `CLAUDE.md` before touching anything. Then read
`docs/batch-splitting-feasibility.md` — sections 2, 4 and 10 especially. §4
lists six ways this feature breaks *silently*; treat that as the test plan.

We are building **operator-triggered batch splitting for Darkroom Pro only**.
Epson/DPOF is a separate release and is explicitly out of scope here — do not
touch the DPOF dispatch path.

Work in **six commits, in order**. Do not start a milestone until the previous
one is complete and its tests pass. Stop and tell me if you hit something the
brief did not anticipate — do not improvise around it.

I run `npm test` and all manual testing on Windows. Do not claim anything is
production ready. Show me the diff before committing each milestone.

---

## What we're building

A lab sets a **maximum prints per job** on a Darkroom Pro controller. When a job
exceeds it:

1. OHD **holds** the job — it does not auto-print. The operator sees why.
2. The operator clicks **Send to Print** when they choose.
3. OHD writes **N Darkroom Pro files at once**, named `{job_name}_1.txt`,
   `{job_name}_2.txt`, …
4. The operator reorders and schedules those separate orders inside Darkroom
   Pro's own queue.

This is **not a scheduler**. OHD decides how many jobs to create and when the
set is released. Print order is Darkroom Pro's business. Do not build a release
queue, a release trigger, or any timer-driven dispatch.

**Why Darkroom Pro first:** unlike the Epson SureLab OrderController, Darkroom
Pro has no Interrupt Order / pause-mid-print facility, so splitting is the only
way to let urgent work past a 600-image job.

### Decisions already made — do not revisit

- **The cap counts PRINTS, not images.** OHD already knows per-image copy
  counts at dispatch. 600 images × 2 copies = 1200 prints → 12 batches of 100
  prints, not 6 batches that each run double. Label it "maximum prints per job".
- **Marking complete:** keep the existing per-controller `checkOrderStatus`
  behaviour, but fire it **only once every batch is accounted for** — never on
  the first.
- **Visible, not invisible.** The operator must be able to see a job was split
  and how far through it is.
- Reprints of a batched job are out of scope for v1 — reprints stay unbatched.

---

## Where the relevant code lives

| Concern | File | Detail |
|---|---|---|
| Live Darkroom Pro send | `print-service.js:1879` `_sendViaDarkroomProRouted` | Reached via `sendViaDPOFRouted` `:210` → `:218-220` |
| The emitter | `darkroom-pro-output.js:182` `generateDarkroomProFile` | Writes **one** file, `:331-335`. Returns a single `destPath` |
| Filename stem | `print-service.js:1966` | `outputFilenameStem: job.job_name \|\| '{order_number}_{id}'` |
| Identifier inside the file | `darkroom-pro-output.js:238, 284, 307` | `jobIdentifier` → `ExtOrderNum` **and** `Orderid` |
| Quantity grouping | `print-service.js:1934-1953` | Groups by `manifestImg.quantity` into `lineItems` |
| Reprint suffix precedent | `print-service.js:877-884` | `-r1` stem override — the pattern to follow |
| Post-send lifecycle | `print-service.js:2004-2009` | `checkOrderStatus === false` → `_markCompleted`, else `_markInProduction` |
| Hold derivation | `src/shared/holdForReview.js:46-50` | `manual-source`, `manual-file`, `routing-hold` |
| Auto-print gates | `ipc-handlers.js:2813-2974` | The skip-gate stack; hold check at `:2892-2902` |
| Manual send | `ipc-handlers.js:635` | `jobs:sendToPrint` — **already bypasses the hold gate** |
| Controller modal | `index.html:1128`, `renderer.js:4847` / `:5326` | Vanilla JS — **no bundle rebuild needed** |
| Route builders | `routing-service.js` `resolveRoute` `:102-577`, `resolveRouteForController` `:606-681` | 19 hand-written route literals |

**Darkroom Pro branch of `resolveRoute` is `:322-387`.**

---

## M1 — `maxPrintsPerJob` controller setting

Follow the `bannerSheet` / `includeCustomerInFolder` precedent exactly.

- **Store:** no schema change needed. `saveController`
  (`routing-service.js:687-707`) is a blind upsert. **No migration** — use the
  read-time default idiom: `Number.isFinite(c.maxPrintsPerJob) &&
  c.maxPrintsPerJob > 0 ? c.maxPrintsPerJob : null`. `null` = feature off.
- **Route:** add `maxPrintsPerJob` to the **darkroompro** literal
  (`routing-service.js:~381`) and to the darkroompro branch of
  `resolveRouteForController`. Leave the other 17 literals alone for now — the
  Epson release adds the DPOF ones. Do NOT add it to types we aren't building.
- **UI:** new `ocMaxPrintsPerJobGroup` in the controller modal near
  `ocIncludeCustomerNameGroup` (`index.html:~1378`). Copy the numeric-input
  markup from `:1214-1215`. Blank = no limit.
  - `updateOcTypeFields()` `renderer.js:~4809` — show only for `darkroompro`.
  - `openOrderControllerModal()` `~4915` — prefill, blank when null.
  - `ocSaveBtn` handler `~5362` — parse, range-guard (1–10000) with the same
    `alert()` + `return` shape as `:5335-5337`, store `null` when blank.
  - **`renderer.js:4119`** — the *second*, inline routing-list row editor.
    Controller saves are a whole-object replace (`renderer.js:5346`), so a field
    read in one save path and not the other is **silently wiped on edit**. Check
    this path and carry the field through, or confirm in writing it can't clobber.
- **IPC / preload:** no change. Reuse `ohd:routing:save-controller`.
- Optional but recommended: defence-in-depth validation in the IPC handler
  (`ipc-handlers.js:1046-1144`), mirroring the Darkroom Pro guard at `:1056-1073`.

**Tests** → `src/main/services/__tests__/routing-max-prints.test.js`, modelled on
`routing-ignored-options.test.js`:
1. Absent field → route carries `null`.
2. Valid integer → route carries it.
3. Zero / negative / non-numeric / absurd → treated as absent, not clamped.

---

## M2 — the pure splitting function

New `src/shared/batchSplit.js`. Must stay Electron-free (`src/shared/` is loaded
by both main and esbuild).

```js
/**
 * @param {Array<{quantity:number}>} images  already filtered + ordered
 * @param {number|null} maxPrints            null/0 => no split
 * @returns {Array<Array<image>>}            [[...], [...]] — one array per batch
 */
function splitIntoBatches(images, maxPrints) { … }
```

Rules:
- Accumulate `image.quantity` (default 1 when absent). Start a new batch when
  adding the next image would exceed `maxPrints`.
- `maxPrints` null, 0, negative or non-finite → return `[images]` (single batch,
  unchanged behaviour).
- Empty input → `[]`.
- **A single image whose quantity exceeds the cap gets its own batch which
  exceeds the cap.** Do not split an image's copies across batches — it changes
  print order. Return that case so the caller can log it.
- **Preserve input order.** Do not sort, do not group.

**Tests** → `src/shared/__tests__/batchSplit.test.js`:
1. 600 × qty 1, cap 100 → 6 batches of 100.
2. 650 × qty 1, cap 100 → 7 batches: six of 100, one of 50.
3. 600 × qty 2, cap 100 → 12 batches of 50 images (100 prints each).
4. Mixed quantities pack correctly and never exceed the cap.
5. One image with qty 250, cap 100 → its own oversized batch, flagged.
6. `null` / `0` / `-5` / `'abc'` cap → one batch, input unchanged.
7. Empty input → `[]`.
8. Input array is not mutated.

---

## M3 — hold jobs over the threshold

Add a fourth hold reason rather than inventing a new mechanism.

- `src/shared/holdForReview.js` — new reason `over-batch-threshold` alongside
  `manual-source` / `manual-file` / `routing-hold` (`:46-50`), with
  operator-readable text in `REASON_TEXT`. Something like *"Large job — N prints
  exceeds this printer's batch limit. Send to Print when ready."*
- The reason needs the route's `maxPrintsPerJob` and the job's total print
  count, neither of which `computeHoldForReview` currently receives. Pass them
  via the existing `ctx` argument (same shape as `routingHeldProcesses`) so the
  function stays pure and the existing callers stay backward-compatible — a
  missing ctx field must yield today's behaviour exactly.
- Wire the derivation into `job-service._mapApiJob` / `_mergeJobs` alongside the
  routing-hold context, and into the `runAutoPrint` re-derive at
  `ipc-handlers.js:2892-2902`.
- **Manual Send-to-Print must remain unaffected** — `ipc-handlers.js:635` does
  not consult the hold gate today and must not start. The operator's click is
  the release. Verify this rather than assuming.
- Jobs-grid badge: reuse whatever `_holdReasonsText` already renders. No new UI
  component.

**Tests** → extend `src/shared/__tests__/holdForReview.test.js`:
1. Print count over cap → `over-batch-threshold` in `_holdReasons`.
2. Under cap → not present.
3. Cap null → not present.
4. Stacks correctly with `manual-source` and `routing-hold`.
5. Omitting the new ctx fields is backward-compatible (existing tests unchanged).
6. `runAutoPrint` skips a job held for this reason.
7. Manual send dispatches it regardless.

---

## M4 — batched Darkroom Pro dispatch

The core milestone. In `_sendViaDarkroomProRouted` (`print-service.js:1879`).

- **Hoist all per-job preparation above the batch loop** — `_readManifest`,
  `_findJobInManifest`, `_getEnhancedPathMap`, `_getCorrectionsMap`,
  `resolveDispatchImageSource`, and especially `_applyCorrectionsToImageFiles`
  (`:1928`), which *writes* corrected JPEGs to `/working/`. Running that N times
  is N× the disk churn for identical output.
- **Split after** the operator-discarded filter (applied inside
  `_findJobInManifest`, `print-service.js:2978-2987`), never before — batch
  boundaries must reflect what will actually print.
- Call `splitIntoBatches(manifestImages, route.maxPrintsPerJob)`.
- **One batch → current behaviour byte-for-byte.** No `_1` suffix, no ledger
  entry shape change, nothing. This is the regression guarantee for every
  existing Darkroom Pro lab.
- Multiple batches → loop, and per batch:
  - Build `lineItems` with the existing quantity grouping (`:1934-1953`) over
    that batch's images only.
  - Override the stem: `outputFilenameStem: '{job_name}_{n}'` where n is 1-based
    — same mechanism the reprint path uses at `:877-884`. This deliberately
    changes `ExtOrderNum` and `Orderid` inside the file, so each batch lands as
    a separate order in Darkroom Pro. That is intended.
  - Call `generateDarkroomProFile` per batch.
- **Persisted per-batch ledger.** Nothing today records that a job was
  dispatched as N parts, so a mid-loop failure leaves files on the printer with
  no trace. Record per batch: index, total, filename, dispatched-at, outcome.
  Put it on the job record via `jobService.updateJobLocally` (it persists to
  `jobs-cache` and survives restart) unless you find a better-fitting store —
  tell me if you do rather than inventing a new one silently.
- **Partial failure:** if batch 4 of 6 throws, batches 1-3 are already being
  printed. Do not roll back and do not pretend it succeeded. Record what
  succeeded in the ledger, stamp the job with a clear error naming which batches
  went and which didn't, and return `{success:false}` with that detail. The
  operator is present at dispatch — this must surface immediately.
- Log one line per batch, tagged so it greps cleanly.

**Tests** → `src/main/services/__tests__/darkroom-pro-batching.test.js`:
1. Cap null → exactly one `generateDarkroomProFile` call, filename unchanged
   (no `_1`).
2. Cap 100, 600 images qty 1 → 6 calls, stems `_1`…`_6`, images partitioned
   correctly with none lost or duplicated.
3. Cap 100, qty 2 → 12 calls of 50 images each.
4. Corrections / enhanced-map preparation runs **once**, not once per batch.
5. Discarded images are excluded before splitting, and boundaries reflect that.
6. Batch 4 throwing → ledger records 1-3 succeeded, job stamped error naming
   them, `{success:false}` returned.
7. Ledger survives a simulated restart (re-read from the store).

---

## M5 — completion accounting

Today the routed Darkroom Pro path marks the job complete or in-production
immediately after the single write (`print-service.js:2004-2009`). With batches
that must not fire until every batch is written.

- Move the `checkOrderStatus` branch **after** the batch loop, gated on all
  batches having succeeded.
- Partial failure → neither `_markCompleted` nor `_markInProduction`. The job
  stays visible and recoverable.
- Single-batch path must behave exactly as before.

Note for context, not for action: routed Darkroom Pro has **no printer
acceptance signal at all** — `darkroom-pro-monitor.js:145-149` only recognises
the legacy `Order{n}.TXT` filename and the routed path never calls
`trackSubmission`. So "all batches accounted for" here means "all written
successfully". Do not try to fix that monitor in this milestone; note it in
`docs/BACKLOG.md` if it isn't already there.

**Tests** → extend the M4 test file:
1. All batches succeed + `checkOrderStatus false` → `_markCompleted` called
   exactly once.
2. All batches succeed + `checkOrderStatus true` → `_markInProduction` once.
3. Batch 4 of 6 fails → neither called.
4. Single batch → identical to current behaviour.

---

## M6 — visibility

The operator must be able to see that a job was split.

- Surface batch count and per-batch state from the ledger in the Jobs grid —
  e.g. "Sent as 6 batches" on a dispatched job, and the hold reason text before
  dispatch.
- `renderer.js` and `index.html` only. **If you find yourself editing anything
  under `src/renderer/views/*.jsx`, stop and tell me** — that needs
  `npm run build:renderer` and a separate `chore(build):` commit, and I'd rather
  decide that deliberately.
- Keep it plain. A count and a state, not a new panel.

**Partly done already** (during M3): the pre-dispatch hold chip now derives
its label from `_holdReasons` via `deriveHoldChipLabel` in
`src/shared/holdForReview.js` — a batch-threshold-only hold reads "Large job
— review required" instead of the hard-coded "Manual — review required" that
misfired on a real Pixfizz order. Rendered in `renderer.js` via the
pre-computed `job._holdChipLabel`. **Still to do in M6:** the post-dispatch
"Sent as N batches" chip / state sourced from `job._darkroomProBatchLedger`
(populated by M4).

---

## Guardrails

- **Do not touch the DPOF / Epson dispatch path.** Separate release.
- **`is_film_development` jobs must never reach** the Jobs grid, auto-print, the
  S3 downloader, or `markReceived`. Guards exist at four layers — don't add a
  fifth way in.
- **Reprints stay unbatched.** `_sendReprintViaDarkroomPro` is out of scope.
- **Don't touch `jobDownloadService.checkLocalFiles`** — its
  `found === hasFiles` equality is deliberate; changing it breaks auto-print.
- **`.gitattributes` forces `eol=lf`.** Files showing as modified with no visible
  change → check `git diff --ignore-cr-at-eol` first.
- **Tests must live inside one of the five globs in `package.json`** or they
  never run. `node:test` + `node:assert/strict`, no framework. The dominant
  mocking pattern is `require.cache` injection.
- The `perfectlyClearClient.test.js` "stability polling" case is a known flake —
  rerun it once, it is not release-blocking.

## Verification checklist (I will run these)

1. A Darkroom Pro controller with no cap set behaves **exactly** as v1.9.0 —
   one file, unchanged filename, unchanged lifecycle.
2. A job under the cap is unaffected and does not get held.
3. A job over the cap is held, shows a clear reason, and does not auto-print.
4. Clicking Send to Print on a held job produces N files named `_1`…`_N`, with
   every image present exactly once across them.
5. A 2-copies job produces batches of even print count, not even image count.
6. Darkroom Pro accepts the N files as N separate orders. **(Lab test — this is
   the one thing the code cannot prove.)**
7. The job is marked complete only after all batches are written.
8. Simulated mid-loop failure surfaces which batches went and which didn't.

Start with M1. Show me the diff before committing.
