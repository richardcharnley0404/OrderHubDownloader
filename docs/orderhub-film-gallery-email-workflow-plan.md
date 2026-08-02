# Twin-Check Film Gallery & Email Workflow — Top-Level Plan

**Status:** Planning only (2026-07-18). No implementation. Decisions still open.
**Scope:** OrderHub web (Lovable `pixfizz-oms`). Builds on the shipped twin-check upload recording feature.

---

## The problem

Film orders don't map cleanly to one roll = one email. A customer may order:
- one job with one twin check (one roll), or
- one job with several rolls (several twin checks), plus another job with one roll, and
- a third job that has nothing to do with film.

We need a workflow that organises rolls into galleries and emails links sensibly across that hierarchy — **order → jobs → twin checks (rolls)** — and that is clearly separate from the way labs upload film today.

---

## Guardrail: do NOT disrupt the existing Film Scans workflow

Non-negotiable. Labs on the legacy Film Scans workflow must be **completely unaffected** during and after implementation:
- Everything new is **gated behind the workflow-mode selector**, which defaults to legacy (off). Ship dormant, exactly like the twin-check upload feature did.
- Shared infrastructure (`sync-film-scans-from-s3`, `process-gallery-queue`, `send-film-scan-email`, `pixfizz_website_email_settings`) is extended **additively** — never in a way that changes legacy behaviour. Behavioural changes (e.g. the TIFF-vs-JPG split, unscanned-only `/jobs/pending` twin checks, auto-link, auto-complete) apply **only when the org is in Film Development mode**.
- DB changes are **additive & nullable**; new constraints are **partial** (only bite live twin-check rows) so historical/legacy data is untouched.
- Roll out in phases behind the flag; verify legacy scanning is byte-identical before enabling for any lab.

## What already exists (we build on this, not rebuild)

- **Galleries are per roll.** Each `film_scans` row gets its own Pixfizz gallery (`gallery_id`, `gallery_url`). Creation is queued via `film_scan_gallery_queue` and drained by `process-gallery-queue` (cron, per-org round-robin fairness, ~960 galleries/hr ceiling). **Load-spreading already solved** (item #5).
- **Emails already group per order.** `pixfizz_website_email_settings` (per Pixfizz website) holds the template, `email_delay_minutes` ("wait after first scan so multiple rolls per order go in one email"), and placeholders incl. `{{gallery_urls}}` (multiple) and a stubbed `{{twin_check_numbers}}`. Sent by `send-film-scan-email`. There's also an `auto_create_gallery` toggle (currently fires on **association**, not upload).
- **Completion hook exists.** `complete-jobs-on-upload` can mark all open jobs on an order complete when scans are sent (operator opt-in, order-wide).
- **Twin-check linkage exists (just shipped).** `job_twin_checks.film_scan_id` + `film_scan_uploaded_at` tie each uploaded roll to its job. **This gives us job- and order-level completeness for free.**

So this is mostly **re-wiring existing pieces around the twin-check link + adding completeness-driven triggers**, not a greenfield build.

---

## Legacy workflow vs. new workflow (the core distinction — item #6)

| | Legacy (today) | New (twin-check driven) |
|---|---|---|
| Link scan → order | Operator manually associates | **Automatic** via twin match (job_twin_checks) |
| Gallery creation | On association (optional) | **On upload** (default on, optional off) |
| Email trigger | Time delay after first association | **Completeness** (per job / per order) or manual |
| Job completion | Manual, order-wide | **Automatic** per job when its twin checks all upload |

**Separation mechanism (DECIDED 2026-07-18):** an **org-level workflow-mode selector** — a lab runs **either** the legacy *Film Scan* workflow **or** the new *Film Development* workflow, never both. When Film Development is selected, the legacy Film Scans page/pipeline is not used and the new Rolls view takes over. No per-scan tagging, no double-send. Film Development is expected to become the default going forward, but some labs will keep the legacy Film Scan workflow, so both must remain supported.

---

## Twin-check identity & uniqueness (FOUNDATIONAL — 2026-07-18)

Twin-check codes (`0000`–`9999`) are **printed on physical sticker rolls and reused**. A code is *not* globally unique — the same `0001` will recur (perhaps ~every 100 days in a busy lab). Correct matching depends on this rule:

> **At most one *live* twin check per (scan location, code) at any time.** ("Live" = assigned to a job but **not yet scanned**.)

- A code is **consumed** the moment its roll is scanned (`film_scan_uploaded_at` set) — from then it's reusable. Also released if the job/order is cancelled.
- Two *different* locations may each have `0001` live simultaneously; the constraint is **per scan location**.
- Scan location = the job's routed **film-processing location** (else pickup location), which must equal the OHD upload location (`film-scans/{locationId}/`).

**Current gap:** `job_twin_checks` has no location and no live-uniqueness; the OHD matcher does arbitrary *last-wins* when two live jobs share a code; and `/jobs/pending` exposes already-scanned codes until the job closes. All three must change.

**Defence in depth (proposed):**
1. **Assignment guard (primary):** the Twin Checking tab blocks/warns assigning a code that is already **live at the same location**, pointing to the order/job that holds it. Prevents the ambiguity ever existing.
2. **DB partial-unique index (safety net):** unique on `(organization_id, location_id, code)` **where live** (`film_scan_uploaded_at IS NULL` and not released). Requires denormalising `location_id` onto `job_twin_checks` at assignment. Hard guarantee even against races / API paths.
3. **Consistent "live" everywhere:** OHD `/jobs/pending` (and the matcher) only offer **unscanned** twin checks, so a scanned code stops colliding even while its job stays open — freeing it cleanly for the next roll.
4. **Match-time defence:** if the matcher ever sees >1 live candidate, it **flags the roll as ambiguous** for operator resolution rather than guessing (replaces last-wins). Should never fire if 1–3 hold, but never silently mis-allocate.

**Decided (2026-07-18):** (a) **live until scanned**; (b) `location_id` denormalised onto `job_twin_checks` at assignment, sourced from routed-film-location else pickup; (c) **release on cancel** — cancelling a job/order frees its unscanned twin checks for reuse.

---

## Proposed model (top level)

1. **Auto-link on upload.** When the sync stamps a twin check, also associate the `film_scans` row to the matched job's **order + customer** (known via job_twin_checks → job → order). Removes the manual association step for this workflow.
2. **Gallery on upload (item #5).** Enqueue gallery creation as soon as the roll's completed manifest syncs. Default on; per-website (or per-org) toggle to turn off. Reuses the existing queue — no new load machinery.
   - **TIFF/JPG split (REQUIRED, 2026-07-18):** a roll produces both a **JPG copy** and a **TIFF original** per frame. The **JPG goes into the gallery** (customer viewing); the **TIFF is referenced in the download links** (`{{direct_download_urls}}` / zip), not shown in the gallery. Gallery build must classify by extension and pair JPG↔TIFF by base filename. Change point: the current sync treats *all* image files incl. TIFF as gallery images — TIFF must route to download-only, JPG to gallery. **Cross-system dependency:** this requires OHD to upload **both** the TIFF original and the JPG copy (today's test rolls were JPG-only — verify/adjust the OHD film pipeline so TIFFs are uploaded alongside JPGs).
3. **Completeness (items #1, #2, REFINED 2026-07-18).**
   - New per-job boolean **"scan not required"** (`jobs.film_scan_not_required` or similar), operator-set for now, auto-derived later. Most film-dev jobs *will* have twin checks; this flags the exceptions that need no scanning.
   - *Job film-status* = **satisfied** when it is either flagged *scan-not-required*, **or** all its `job_twin_checks` have `film_scan_uploaded_at` set.
   - *Order film-status* = complete when **every** film-development job in the order is satisfied. Non-film jobs are ignored. (A film-dev job with no twin checks and not flagged scan-not-required = not satisfied → order stays incomplete, preventing premature emails.)
   - Surface both as computed statuses on the new Rolls view and, optionally, on the order.
4. **Email trigger modes (item #3, REFINED 2026-07-18).** The email **content is always the whole order** (cumulative — every gallery uploaded for the order so far). The mode only changes **when** we send:
   - **Per job** — send an order email each time a film job completes (so an order may get several emails over time; each re-lists all links, earlier rolls repeated).
   - **Per order** — send one order email when every film job in the order is complete.
   - **Manual** — operator triggers.
   Config is **per brand** (per Pixfizz website) but authored under **Film Development Settings** (not the legacy Film Scan Email dialog). **DECIDED:** reuse the existing per-brand email template (`pixfizz_website_email_settings` — subject/body/branding/`{{gallery_urls}}`/`{{twin_check_numbers}}`) as one shared source of truth; the new **trigger mode** + **auto-complete** controls are additive, Film-Development-only fields that don't affect the legacy dialog.
5. **Manual + override (item #4).**
   - Manual send UI: pick an order/job and send now for whatever's uploaded.
   - **Per-roll override:** send a single roll's gallery on demand even if the rest of the job isn't in yet (your "customer wants one roll urgently" case). Tracks that roll as individually sent so the later job/order email doesn't double-send it.
6. **Auto-complete order (DECIDED 2026-07-18).** A Film-Development setting **"Auto-complete order when film delivered"** (on/off). When on, auto-complete the order only when **all** hold:
   - **every** job in the order belongs to a Film-Development process (no non-film jobs remain), **and**
   - every film-dev job is **fully delivered** — twin checks uploaded → galleries created → **emails sent** — or is flagged *scan-not-required*, **and**
   - the order is a **Pick-Up** order.
   Aimed at cleanly closing pure-film pickup orders once the customer has their scans. Gates on the whole pipeline (emails sent), a stricter bar than the email trigger. Reuses/extends the existing `complete-jobs-on-upload` completion machinery. **Pick-Up = `orders.requires_shipping = false`** (with `pickup_location_id` set); shipped orders are excluded.

---

## Practical considerations / risks

- **No double-sending.** New-workflow scans must **not** also trigger the legacy time-delay email. Gate cleanly by workflow flag + mode.
- **Customer email required.** Auto-link supplies it from the order; handle the missing-email edge case (hold + flag rather than fail).
- **Idempotency at job & order level.** Today's "sent" tracking is per scan. We'll need per-job and per-order "email sent" markers (mirroring the `jobs_completed_at` idempotency pattern) so re-syncs/re-sends don't re-email.
- **Build gallery from the finished roll.** Trigger gallery creation on the **completed** manifest, not mid-upload (avoids the image-count-lag we saw). Re-scans (new cycle) should refresh the gallery and allow re-send.
- **"Film job with no twin checks yet."** Open question: does it block order-completeness or is completeness only over jobs that actually have twin checks? Affects when the per-order email fires.
- **Multi-website scoping.** Existing email settings are per Pixfizz website; the new trigger settings should probably follow the same scoping (or be org-level) — needs a decision.
- **Mixed & partial orders.** Completeness logic must correctly ignore the non-film job (your job C) and handle rolls arriving across different sync cycles.
- **Load.** Auto-gallery-on-upload raises gallery-creation volume; the queue handles it, but confirm the ceiling is comfortable for your biggest labs.

---

## Suggested phasing (top level, not committed)

1. **Twin-check identity & uniqueness (foundational)** — `location_id` on `job_twin_checks`, live-uniqueness partial index, assignment guard, unscanned-only `/jobs/pending`, match-time ambiguity flag. Correct matching underpins everything.
2. **Workflow mode selector + separation** — org-level Film Scan | Film Development switch; auto-link rolls to order/customer; the new Rolls view. (Fixes item #6.)
3. **Completeness model** — per-job scan-not-required flag; job/order film-status on the Rolls view and Twin Checking tab.
4. **Gallery on upload + TIFF/JPG split** — enqueue on sync; JPG→gallery, TIFF→download.
5. **Email trigger modes** — per-job / per-order / manual, per-brand template under Film Dev settings, manual send + per-roll override, unmatched-rolls bucket.
6. **Auto-complete** — pure-film Pick-Up orders once fully delivered.

Every phase ships behind the mode flag (default legacy), verified non-disruptive before enabling.

---

## Decisions

**Resolved (2026-07-18):**
- Workflow selection → **org-level mode selector**: Film Scan workflow **OR** Film Development workflow, never both. Film Development expected to become the default; legacy must remain supported.
- Unmatched rolls → **"Unmatched / needs assignment" bucket** in the new workflow with a manual-assign UI (doubles as override tooling). No legacy fallback.
- Completeness → per-job **"scan not required"** boolean; order complete when every film-dev job is *satisfied* (scan-not-required OR all twin checks uploaded).
- Email content → **always per-order, cumulative**; mode (per-job / per-order / manual) governs timing only.
- Email settings → **per brand**, authored under **Film Development Settings**.
- Gallery images → **JPG in gallery, TIFF in download links** (paired by base filename).
- Email settings storage → **reuse** the shared per-brand template; new trigger-mode + auto-complete controls are additive Film-Dev-only fields.
- Per-job de-dup → **yes**, suppress a send when no new job has completed since the last email.
- Auto-complete → **on/off setting**; completes a **pure-film Pick-Up** order once every film-dev job is fully delivered (uploaded → gallery → email sent) or scan-not-required.

**Still open:**
1. **Transition:** how to handle in-flight legacy scans when a lab switches to the Film Development workflow. (Lean: switching is a deliberate admin action; in-flight scans finish under the workflow that created them.)
2. **Delay/debounce:** keep a short debounce so several rolls landing seconds apart don't fire multiple emails (independent of the legacy `email_delay_minutes`).
3. **Scan-not-required automation:** later, how to auto-derive the per-job flag rather than manual operator tick.
