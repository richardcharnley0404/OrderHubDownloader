# Epson / DPOF batch splitting — analysis and plan

**Status:** analysis, 2026-08-15. Nothing built.
**Ask:** the lab wants the same "Maximum prints per job" splitting Darkroom Pro
has, on the Epson OrderController. Their queue-management tools are not good
enough in practice, so the earlier decision to skip this (see
`batch-splitting-feasibility.md`) is reversed.

**Verdict: buildable, but materially harder than Darkroom Pro — and it cannot
be done without also settling how a split job completes.**

---

## 1. Why this is not a copy of the Darkroom Pro work

Darkroom Pro's routed path is **fire-and-forget**. `generateDarkroomProFile`
writes one `.txt` per batch, and nothing downstream cares that one job produced
several files — there is no acceptance signal on that path at all (it's an open
item in `BACKLOG.md`).

DPOF is not fire-and-forget. It has a **feedback loop**:

- `orderFolderWriter.writeOrderFolder` writes **one folder per job**, named by
  `buildFolderName('o', job, …)` → `o38461218_PXDEMO-PFTAP4-1_…`.
- `FolderMonitor` watches for the controller renaming that folder's prefix:
  `o` → `e` (imported) or `q` (failed import), and parses **the job id straight
  out of the folder name** (`folder-monitor.js:103-119`) to attribute the event.
- `_pollAwaitingJobs` (`ipc-handlers.js`) turns those prefix changes into the
  Imported / Failed Import badges.

So splitting one job into N folders means **N status events all claiming the
same job id**. Every consumer of that signal currently assumes one folder = one
job.

## 2. This is the same defect as the known reprint bug

`BACKLOG.md` already carries: *a reprint's accepted folder still marks its
parent job completed*. That is precisely this problem in miniature — two
folders on disk map to one job id, and the first one to be accepted wins.

**Batch splitting makes that bug systematic rather than occasional.** The two
must be fixed together; building splitting on top of the current attribution
logic would produce a job that reports "Imported" when only the first of five
batches has been taken.

This is the main reason the work is larger than it looks, and the reason it
should not be estimated from the Darkroom Pro milestone that shipped in a day.

## 3. What has to change

**Folder naming must carry the batch identity.** Today the monitor's regex
captures `(jobId, productCode)` immediately after the prefix. Splitting needs
`(jobId, batchIndex, total)` — or a separate stable token — while remaining
parseable, filesystem-safe, and unchanged in shape for unsplit jobs. Do not
overload `productCode`.

**Completion has to become a roll-up.** A split job is complete only when every
batch reaches `e`. Any batch reaching `q` should surface as a failure naming
which batch. That needs per-job batch state that survives a restart — Darkroom
Pro's `_darkroomProBatchLedger` is the obvious precedent and should be
generalised rather than duplicated.

**Partial failure needs a defined outcome.** Batches 1–3 imported, batch 4
failed: the job is neither complete nor un-sent. Darkroom Pro's answer was to
mark the job errored with a message naming which batches landed
(`print-service.js:2086-2110`). DPOF can reuse that shape, but the operator
also needs a way to resend **only** the failed batch — resending the whole job
would duplicate three batches' worth of prints at the printer.

**The print-size and channel gates stay per job**, not per batch — every batch
of a job shares one channel mapping, so `resolveRoute` is unchanged.

**The splitter itself is already shared and pure.** `src/shared/batchSplit.js`
is controller-agnostic; DPOF reuses it as-is. That part genuinely is a copy.

## 4. Rough shape

| Phase | Scope | Relative cost |
|---|---|---|
| A | Fix folder→job attribution: batch-aware naming + monitor regex + reprint bug | **Largest, and a prerequisite** |
| B | Per-job batch ledger generalised from the Darkroom Pro one, restart-safe | Moderate |
| C | Split dispatch in `_sendViaDPOFRouted` — reuse `batchSplit.js` | Small |
| D | Completion roll-up + partial-failure handling + resend-one-batch | Moderate |
| E | Settings (cap + auto-send tick for DPOF types), docs, changelog | Small |

Phase A is worth doing on its own merits even if splitting were dropped —
it fixes a live bug.

## 5. Decisions needed before a brief

1. **Which DPOF types?** `noritsu`, `epson` and untyped all share this path.
   Enable the cap for all DPOF controllers, or Epson only? (Darkroom Pro's cap
   was deliberately kept off the DPOF branch when v1.10.0 shipped.)
2. **Partial failure:** resend only the failed batch (needs per-batch resend),
   or error the whole job and let the operator sort it at the printer?
3. **Does the lab want the `Send batches automatically` tick here too**, or is
   Epson always operator-released?
4. **Folder naming:** is the lab (or any downstream tooling) reading these
   folder names by eye or by script? If anything parses them, changing the
   shape is a breaking change and needs their sign-off first.

Question 4 is the one most likely to bite — worth asking the lab before any
code is written.
