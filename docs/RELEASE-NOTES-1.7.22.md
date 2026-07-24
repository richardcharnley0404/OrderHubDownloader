# OrderHub Desktop 1.7.22 — Release Notes

**Release period:** 2026-07-23 → 2026-07-24
**Focus:** Print-size correctness (mandatory + product-code driven), Job Review UI
standardisation, and lab-safety for the film-scan upload path (Perfectly Clear
enhancement recovery + resilient S3 uploads).

Everything below is presentation / correctness / resilience work — no new user-visible
features, no schema changes, no config migrations required. Existing installs will
continue to work unchanged; sub-thresholds and behaviour changes are described inline.

---

## Mandatory print size (product-code driven)

Replaces the vestigial `img.size` gate in the DPOF dispatch path with the
product-code channel mapping as the single source of truth for print size. S3-delivered
jobs (which set `img.size: null` by design) now dispatch correctly. Historical mappings
without a size on file are backfilled from the legacy `size` field; new mappings must
carry a `printSizeCode` at save time in every entry point (Settings routing editor + the
per-job Assign Channel modal). Unmapped or blank-size DPOF mappings are surfaced in the
routing list with a "No print size" chip so the lab can fix them before a job hits them.

- `effc139` — fix(print): gate DPOF dispatch on mapping print size, not manifest img.size
- `5686ac8` — feat(routing): backfill legacy `size` into `printSizeCode` for DPOF mappings
- `baef230` — feat(routing): make printSizeCode mandatory; drop legacy `size`/'KG' fallback
- `07dd20c` — feat(routing/ui): flag DPOF mappings with no print size in the routing list
- `0822954` — feat(routing/ui): require Print Size Code in per-job Assign modal (DPOF)

**Behaviour change:** the silent `'KG'` fallback for a blank `printSizeCode` is gone —
a mis-configured mapping now fails at dispatch with an actionable "No print size
configured for product X" message rather than printing at the wrong size.

Docs: `docs/orderhub-mandatory-print-size-plan.md` (spec).

---

## Best-fit crop orientation (per-image auto-orient)

Fresh crop boxes in Job Review and the manual-mode crop rail now default to the source
image's aspect (landscape source → landscape 4×6 box; portrait → portrait), not the
target size's. Per-image only — a manual Portrait/Landscape flip sets that image's
`pendingOrientation` and does not propagate to other images. Approve All auto-orients
each image by its own shape; saved/approved `cropRect`s keep their existing orientation.
Square target sizes are unaffected (toggle stays hidden).

- `c80e682` — feat(job-review): auto best-fit crop-box orientation per image
- `613d267` — chore(build): rebuild job-review bundle for best-fit orientation

Docs: `docs/manual-crop-best-fit-orientation.md`.

---

## Job Review — info strip + shared readable score element

Filename and AI quality score now live in a thin top bar directly above the main preview
in both review modes (standard grid + manual crop stage). The score digits are dark ink
on a light surface for readability in both light and dark themes; sub-threshold shows a
thick red border but the digits stay legible (previous red-on-dark styling was
unreadable). Thumbnail dots are unchanged. Score tooltip trimmed to `Score: N.N`
(errored: `Score: n/a — <reason>`); model/mode/threshold/timestamp lines dropped as dead
weight.

- `bc5f113` — feat(job-review): standardise selected-image info strip + shared score element across both review modes
- `0875f7e` — chore(build): rebuild job-review bundle for info strip + score dot
- `83543c2` — refactor(job-review): move filename + high-contrast score into preview top bar (both modes); trim score tooltip
- `35c575b` — chore(build): rebuild job-review bundle for preview top bar

Two commits because the initial info-strip landed below the preview (rendered as a
floating column beside it due to the flex-row `.jr-body`), and a follow-up moved it into
a proper top bar above the preview.

---

## Lab-safe Perfectly Clear enhancement

A film-scan roll can no longer permanently wedge at `processingStatus:'enhancing'` when
Perfectly Clear QuickServer is slow, dead, or misconfigured. Four mechanisms:

1. **Startup stale-sweep** — any roll left in `'enhancing'` from a prior session is
   cleared into review on next launch (rate-limited by `pcEnhanceStartedAt` age so a
   genuinely-live enhance from another process can't be clobbered).
2. **Operator "Reset enhancement" button** in the Film Scans UI — aborts the live
   in-flight batch via `AbortController`; the existing cancel path escalates the roll to
   review naturally. Also cleans up phantom `'enhancing'` states with no live batch.
3. **Authoritative timeout** — every fs op inside `perfectlyClearClient` is now
   deadline-bounded, plus each `pollOnce` is raced against the remaining wall clock. A
   hung SMB share cannot wedge the batch past its timeout even for a single second.
   Per-batch timeout + per-op cap are configurable via new config keys
   (`perfectlyClearFilmScanTimeoutMs`, `perfectlyClearFilmScanPerOpTimeoutMs`) — null
   defaults preserve prior behaviour.
4. **Zero-enhanced diagnostic** — a batch that produces no enhanced frames logs a WARN
   naming the QuickServer input folder so misconfigured channels are obvious from the
   activity log.

Recovered rolls escalate to review with `uploadStatus:'pending'` (never silent
auto-upload). When crash-recovery finds the roll incomplete pre-`recordRoll` (missing
S3 metadata), the roll surfaces as `'failed'` with an actionable "re-scan or delete"
error rather than a mysterious later upload failure.

- `b0638a2` — feat(film-scans): lab-safe Perfectly Clear enhancement (startup sweep, reset IPC, hard deadline, diagnostics)
- `966e5a4` — chore(build): rebuild film-review bundle for Reset enhancement button

---

## Film-scan upload resilience

A transient HTTP 502 from the OrderHub presign endpoint could permanently fail one file
per roll, poisoning the completion manifest (`errors > 0`) and having OrderHub reject
the whole roll — requiring a manual delete-and-re-upload in OH. The upload path now
absorbs the blip at every layer:

- **presign retry** — `getPresignedUrls` retries transport errors, HTTP 429, and HTTP
  5xx up to 4 attempts with `[1s/3s/7s]` backoff + jitter. 4xx (non-429) throws fast.
- **PUT retry** — `_uploadWithRetry` broadened from network-only to also retry PUT 5xx
  and 429, 4× attempts with matching backoffs. 4xx (non-429) still fatal.
- **Second-pass retries** — after the per-file loop, up to 2 additional sweeps over
  only the still-failed files with a 2s wait between. Catches "gateway flapped during
  the batch" cases. Widened consecutive-failure early-abort to count 5xx/429 alongside
  network errors so a persistent 502 wave aborts quickly.
- **`failed_files[]` in the manifest** — per-file `{name, sub_path, reason}` records
  alongside the existing `errors` count. Reasons truncated to the first line + 120 chars
  so an HTML 502 body can't bloat the manifest.
- **Self-heal for previously-failed rolls** — `_resumeInterruptedUploads` now runs
  every film-scans cycle (not once per launch), picking up both `'uploading'` and
  `'failed'` rolls, rate-limited to one retry per 10 minutes per roll via
  `lastUploadRetryAt`. Combined with the inner retries, a transient blip can no longer
  permanently kill a roll — worst case is a 10-minute delay before automatic recovery.
- **Concurrent-upload guard** — in-process `Set` on `_uploadRollFromStorage` prevents
  two callers (main-poll auto-assign + film-scans self-heal + operator IPC) from
  starting two concurrent uploads of the same roll when their state guards race.
- Outer roll-level retry trimmed from 3× `[30s, 90s]` to 2× `[15s]` now that inner
  layers absorb transient blips.

- `bc0ea72` — feat(film-scans): resilient upload retries (presign + PUT + second-pass + failed_files manifest + self-heal poisoned rolls)
- `a57a012` — fix(film-scans): add in-process concurrent-upload guard to _uploadRollFromStorage

**Note on recovery of already-poisoned rolls:** self-healing an already-poisoned roll
depends on the OrderHub server treating a re-emitted `errors:0` manifest at the same S3
key as authoritative (see cross-team open questions below). New rolls stop becoming
poisoned regardless.

---

## Cross-team / external (OrderHub / Lovable side, not in this repo)

- **Per-image print quantity via `artwork_files[].copies`** — OrderHub-side fix
  delivered in the release period. Verified working end-to-end. No OHD change was
  needed; the client already honours the `copies` field on the per-file record.
- **OPEN — OrderHub server:** confirm the ingest treats a re-emitted `errors:0`
  film-scan manifest at the same S3 key as authoritative (overrides a prior
  `errors:1` write). Without this, the 10-minute self-heal above only rescues rolls
  that failed *before* their first manifest was written; a roll that already
  committed as broken needs a server-side "reset" hook.
- **OPEN — Perfectly Clear QuickServer:** an observed pickup latency of ~70 minutes
  on a stable channel is a QuickServer-side throughput / configuration issue, not an
  OHD bug. OHD's client is idempotent (see resilience notes above) and will happily
  wait; the concern is operator throughput, not correctness.
