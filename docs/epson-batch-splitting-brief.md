# Claude Code brief — Epson / DPOF batch splitting

> Paste everything below the line into Claude Code CLI, run from
> `C:\Dev\OrderHubDownloader` on `main`, working tree clean.
> Background and full analysis: `docs/epson-batch-splitting-plan.md`.

---

Read `CLAUDE.md`, then `docs/epson-batch-splitting-plan.md` in full —
especially §1 (why this is not a copy of the Darkroom Pro work) and §2 (this
is the same defect as the known reprint bug). That document is the analysis;
this is the build order.

**Context.** The lab wants the "Maximum prints per job" splitting that Darkroom
Pro has, on their Epson OrderController. Their controller's own queue
management is not good enough in practice.

Unlike Darkroom Pro's fire-and-forget path, DPOF has a **feedback loop**: the
controller renames the hot-folder prefix `o` → `e` (imported) or `q` (failed),
and `FolderMonitor.handlePrefixChange` (`folder-monitor.js:103-119`) parses the
job id straight out of the folder name to attribute the event. Splitting one
job into N folders means N events all claiming the same job id. Fixing that is
the bulk of this work.

**Decisions already made — do not revisit:**
- **Epson only.** `noritsu` and untyped DPOF controllers are untouched, exactly
  as today.
- **A person reads the hot-folder names** at this lab — no script parses them.
  So the new name must stay human-readable at a glance, and an **unsplit job's
  folder name must not change at all**.
- **Partial failure resends only the failed batch.** Resending the whole job
  would duplicate the batches that already printed.
- **A "Send batches automatically" tick**, same shape and default (off) as the
  Darkroom Pro one shipped in 1.13.0.
- **`src/shared/batchSplit.js` is reused unchanged.** It is already
  controller-agnostic.

Work in **six commits, in order**. Do not start a milestone until the previous
one's tests pass. Stop and tell me if you hit something this brief did not
anticipate — do not improvise.

I run `npm test` and all manual testing on Windows. Do not claim anything is
production ready. Show me the diff before committing each milestone.

---

## M1 — Folder→job attribution (prerequisite, and it fixes a live bug)

This milestone is worth landing **even if the rest is dropped**, because it
fixes the backlog item *"a reprint's accepted folder still marks its parent job
completed"* — which is this same defect at N=2.

`buildFolderName(prefix, job, reprintSuffix, opts)`
(`src/shared/printUtils.js`) already has a discriminator slot: `reprintSuffix`,
emitted as `_r1` after the job number. **Batches use the same slot** — do not
invent a parallel mechanism.

- Extend the signature to take a batch descriptor (e.g.
  `{ index, total }`) and emit a compact, human-readable marker in the same
  position: `o38461218_PXDEMO-5LGAKK-1_2of5_4x6 Photo Print`. Pick the exact
  token and show it to me in the diff — an operator has to recognise it at a
  glance in a folder listing.
- **An unsplit job must produce a byte-identical name to today.** No `1of1`.
  Assert this with a test that compares against the current output.
- Update `FolderMonitor.handlePrefixChange`'s regex (`folder-monitor.js:106`)
  to capture the discriminator as well as the job id, and include it in the
  callback payload. It currently captures `(jobId, productCode)` where
  `productCode` is really "everything else" — tighten that.
- The callback consumers must then distinguish *which* folder for a job
  changed state. Find every consumer (`print-controller-service.js`'s
  `onDpofStatusChange`, `_pollAwaitingJobs` in `ipc-handlers.js`, and anything
  else) and make each one batch-aware or explicitly document why it doesn't
  need to be.
- **Fix the reprint attribution bug in the same commit**: a reprint's folder
  must not mark the parent job completed. Reference the BACKLOG entry and
  remove it in M6.

**Tests** → `src/shared/__tests__/printUtils.test.js` and the folder-monitor
tests: unsplit name unchanged from today (regression lock); split names carry
the marker and are filesystem-safe; the monitor round-trips
`buildFolderName` output back to the right `(jobId, batch)` for unsplit,
split, and reprint folders; a reprint folder no longer attributes to the
parent as a plain completion.

---

## M2 — Batch ledger

Darkroom Pro already persists `_darkroomProBatchLedger` on the job
(`print-service.js` M4/M5 of the v1.10.0 work). Generalise it rather than
writing a second one — a shared shape used by both controller families, so
"which batches went out, which landed, which failed" has one answer.

- Restart-safe: written after every batch, not at the end.
- Records per batch: index, total, folder name, dispatched-at, outcome,
  and — new for DPOF — the accepted/failed signal when it arrives.
- Migrating the Darkroom Pro ledger to the shared shape must not break
  existing persisted ledgers. If a migration is needed, say so before writing
  it.

**Tests:** ledger written per batch; survives a simulated restart; a
Darkroom Pro job with an old-shape ledger still reads correctly.

---

## M3 — Split dispatch

In `_sendViaDPOFRouted` (`print-service.js:237`), when the route carries a
positive `maxPrintsPerJob` and the print count exceeds it, split with
`batchSplit.js` and write one hot-folder per batch.

- Same image-resolution pipeline per batch (enhanced → cropped → corrected →
  raw) — do not resolve once and slice, the corrections map is per image.
- The banner sheet, if enabled, goes on **batch 1 only**. Confirm that's what
  the operator expects before implementing; if unsure, ask me.
- Print size and channel are per job, not per batch — `resolveRoute` is
  unchanged.
- On failure mid-loop, follow the Darkroom Pro precedent
  (`print-service.js:2086-2110`): stamp the ledger, mark the job errored with a
  message naming which batches landed and which did not, and do **not** mark
  completed or in-production.

**Tests** → new `print-service-dpof-batching.test.js`: 40 prints, cap 20 → two
folders with the right names and 20 prints each; under cap → one folder,
byte-identical to today; mid-loop failure stamps the ledger and errors the job.

---

## M4 — Completion roll-up, partial failure, resend-one-batch

- A split job is **completed only when every batch reaches `e`**. Until then it
  stays in production.
- Any batch reaching `q` marks the job errored, naming the batch.
- New IPC to resend a **single** batch, and a job-row action for it. Resending
  must reuse that batch's exact image set from the ledger, not re-split — a
  re-split after an image was discarded would send different content under the
  same batch number.
- Guard against the obvious double-print: a batch already at `e` must not be
  resendable without an explicit confirm.

**Tests:** all batches accepted → job completed once, not N times; one batch
failed → job errored naming it; resend-one-batch writes only that batch's
folder; resending an already-accepted batch is refused without confirmation.

---

## M5 — Settings

- Show "Maximum prints per job" and "Send batches automatically" for
  `epson` controllers, reusing the Darkroom Pro markup and the
  `.modal-checkbox` pattern.
- Carry both on the epson route literal(s). Mirror any override branch —
  drift between route literals has caused a live bug before; check whether
  epson has one.
- **Assign the fields inside the `if (type === 'epson')` block** in the
  renderer save handler. A field assigned in the wrong type block silently
  never persists — that bug shipped in 1.12.0.
- Defence-in-depth validation at the IPC boundary, scoped to `epson`.
- The `over-batch-threshold` hold and `autoSendBatches` suppression already
  exist in `holdForReview.js` — they are controller-agnostic. Verify the
  resolver in `runAutoPrint` produces the cap for epson routes too.

---

## M6 — Docs + changelog

- `CHANGELOG.md` under `## Unreleased`, in operator language: the cap, the
  auto-send tick, the new folder-name shape (**with an example**, since a
  person at the lab reads these), and the reprint attribution fix.
- Remove the reprint-completion item from `docs/BACKLOG.md` — M1 fixes it.
- Do not bump the version or touch `electron-builder.yml`.

---

## Guardrails

- **An unsplit job's folder name must not change.** This is the single most
  likely thing to upset the lab.
- **Never mark a split job completed until every batch is accepted.**
- **Never re-split on resend** — reuse the ledger's image set.
- **Do not touch `noritsu` or untyped DPOF controllers.**
- **Do not modify `src/shared/batchSplit.js`.**
- **New controller fields go in the matching `if (type === …)` block.**
- **Do not wrap a `require` in a swallowing catch** — see the 2026-08-15
  batch-gate incident in `CHANGELOG.md`.
- **`is_film_development` jobs must never reach** the Jobs grid, auto-print,
  the S3 downloader, or `markReceived`.
- **`.gitattributes` forces `eol=lf`** — check `git diff --ignore-cr-at-eol`
  before believing a whitespace-only diff.
- **Tests must live in one of the five globs in `package.json`.** `node:test` +
  `node:assert/strict`. Direct `node --test` runs need `--test-force-exit`.

## Verification checklist (I will run these)

1. A normal (unsplit) Epson job produces exactly the folder name it does today.
2. A 40-print job with a cap of 20 produces two folders, clearly numbered.
3. Both accepted → the job completes **once**.
4. One batch failed → job errored naming that batch; resending only that batch
   writes one folder with the same images.
5. A reprint no longer marks its parent job completed.
6. Auto-send off → over-cap job waits; on → it splits and goes.
7. A Noritsu controller shows no cap field and behaves exactly as before.

Start with M1. Show me the diff before committing.
