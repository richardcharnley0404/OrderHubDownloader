# Phase 5 Build Spec — Email Trigger Modes + Manual/Override + Unmatched Bucket

**Status:** Ready to build (2026-07-18). All OrderHub web (Lovable `pixfizz-oms`).
**Depends on:** Phases 1–4 (shipped), esp. `order_film_status` / `job_film_status`.

## Goal

In Film Development mode, control **when** the customer email fires (per-job / per-order / manual), send from a per-brand template authored under Film Development Settings, allow a manual/per-roll override, and give a home to **unmatched** rolls. Critically, **retire the legacy delay-based email trigger in FD mode** so we never double-send.

## Confirmed facts (verified 2026-07-18)

- `send-film-scan-email` is invoked with `{ order_id, immediate }` and already sends **one per-order cumulative email** (all the order's galleries via `{{gallery_urls}}` / `{{gallery_links}}` / `{{direct_download_urls}}` / `{{twin_check_numbers}}`), marks the order's `film_scans` `email_status='sent'`, and runs the legacy `complete_jobs_on_email_sent` completion. **Reuse it as the sender unchanged.**
- Template + branding live in `pixfizz_website_email_settings` (per brand): subject/body/logo/from/reply/bcc/`email_delay_minutes`/`gallery_url_prefix`/`direct_download_*`.
- The **legacy trigger** is a delay/scheduler: `film_scans.email_scheduled_at` + `email_status`, driven by `email_delay_minutes`; something calls `send-film-scan-email(order_id)` when due. (In our TIFF test this is what fired the email in FD mode — must be gated off in FD mode.)
- Phase 3 views `order_film_status` / `job_film_status` give completeness.

## Design

### 1. New config (per brand, authored under Film Development Settings)
- `pixfizz_website_email_settings.film_email_trigger_mode text NOT NULL DEFAULT 'per_order'` CHECK in ('per_job','per_order','manual').
  - `per_job` — send an order email each time a **film job** becomes satisfied (cumulative content).
  - `per_order` — send one order email when the **order** becomes film-complete.
  - `manual` — never auto-send; operator triggers.
- The email template itself is the **existing** `pixfizz_website_email_settings` (shared) — Phase 5 just surfaces it (+ the mode) under Film Development Settings, not the legacy dialog.

### 2. De-dup ledger
- `jobs.film_emailed_at timestamptz NULL` — stamped on a film job when an email covering it has been sent. This makes "has a new job completed since the last email?" a simple check and prevents identical re-sends.

### 3. New trigger (FD mode only), evaluated after the sync stamps/auto-links a scan
Run in `sync-film-scans-from-s3` right after the Phase 2b auto-associate for a scan (org in `film_development` mode):
- Resolve the order's brand `film_email_trigger_mode`.
- Compute the order's film jobs via `job_film_status` (satisfied + `film_emailed_at`).
- **per_job:** if there is ≥1 **satisfied** film job with `film_emailed_at IS NULL` → call `send-film-scan-email(order_id)`; on success stamp `film_emailed_at = now()` on **all** satisfied film jobs of the order.
- **per_order:** same, but only when `order_film_status.film_complete = true`.
- **manual:** do nothing.
- Idempotent: the `film_emailed_at IS NULL` check is the de-dup — nothing sends if no newly-satisfied job exists.
- Invoke `send-film-scan-email` via fetch (like `triggerThumbnailGeneration`), awaited best-effort; failures logged, not fatal.

### 4. Retire legacy trigger in FD mode (no double-send)
- Find where `film_scans.email_scheduled_at` is set (likely `process-gallery-queue` / association) and the scheduler that calls `send-film-scan-email` on due scans.
- For FD-mode orgs: **do not** set `email_scheduled_at` (so the legacy scheduler never queues them), **and** have the scheduler skip FD-mode orgs (belt-and-braces). FD emails come solely from the new trigger + manual.
- Legacy (`film_scans` mode) orgs: unchanged.

### 5. Manual send + per-roll override (Rolls view)
- On the Rolls view, per order: a **"Send email now"** button → `send-film-scan-email(order_id, immediate:true)`; on success stamp `film_emailed_at` on satisfied film jobs.
- Per roll / per twin (the "customer wants one roll now" case): a **"Send now"** action that also calls `send-film-scan-email(order_id, immediate:true)` (content is per-order cumulative — it includes whatever galleries exist so far). This covers the override without a separate single-roll email.
- Show last-sent state (from `film_scans.email_sent_at` / `email_status`) so operators see what's gone out.

### 6. Unmatched-rolls bucket
- A synced roll that matched **no** twin check has no `job_twin_checks.film_scan_id` link and no auto-link (`order_id IS NULL`). In FD mode these must not vanish (legacy page is hidden).
- Add an **"Unmatched"** section/tab in the Film Development area listing FD-org `film_scans` that are not referenced by any `job_twin_checks` row and are unassociated, with roll id / twin_check_number / location / image count / date.
- Provide a **manual assign** action: pick a job + twin check (4-digit) for the roll → set `job_twin_checks.film_scan_id` + `film_scan_uploaded_at` for that code, and auto-link the scan to the job's order (reuse the shared associate helper). This is the manual equivalent of the sync stamp. (Reuse the existing `FilmScanAssociator` UX where possible.)

## Guardrail (non-disruptive)

- All additive; new mode column defaults `per_order` but the whole trigger only runs for FD-mode orgs. Legacy orgs' email behaviour is unchanged.
- Retiring the legacy trigger is scoped to FD-mode orgs only.

## Open decision
- **Default `film_email_trigger_mode`** = `per_order` (one email when the order's film is fully in). Change to `manual` if you'd rather labs opt in explicitly. (Recommend `per_order`.)

## Verification
1. per_order brand: upload all of an order's rolls → exactly one cumulative email fires when the order becomes film-complete; a second sync doesn't re-send.
2. per_job brand: two film jobs; completing job A emails once (galleries so far), completing job B emails again (cumulative, includes A); a re-sync with nothing new doesn't send.
3. manual brand: no auto-email; "Send email now" on the Rolls view sends.
4. Legacy `film_scans`-mode org: emails behave exactly as before (delay trigger intact).
5. Unmatched: a roll whose folder matches no twin check appears in the Unmatched bucket; manual-assign links it and it drops out.

---

## Prompt A — Lovable — trigger modes + de-dup + retire legacy trigger in FD mode

```
Phase 5a — Film Development email trigger modes. Reuse send-film-scan-email as the sender (it already
sends one per-order cumulative email). Additive; only affects film_development-mode orgs.

1. Migrations:
   - pixfizz_website_email_settings.film_email_trigger_mode text NOT NULL DEFAULT 'per_order'
     CHECK (film_email_trigger_mode IN ('per_job','per_order','manual')).
   - jobs.film_emailed_at timestamptz NULL.

2. In supabase/functions/sync-film-scans-from-s3, right after the Phase 2b Film Development auto-associate
   for a scan (org in film_development mode, order resolved):
   - Look up the order's brand film_email_trigger_mode (via the order's pixfizz_website_id →
     pixfizz_website_email_settings; default 'per_order' if none).
   - Using job_film_status for the order's film jobs (is_film_job, satisfied) and jobs.film_emailed_at:
     * per_job: if ≥1 satisfied film job has film_emailed_at IS NULL → call send-film-scan-email(order_id)
       and, on success, set film_emailed_at = now() on ALL satisfied film jobs of the order.
     * per_order: same, but only when order_film_status.film_complete = true.
     * manual: do nothing.
   - Invoke send-film-scan-email via fetch (service role, like triggerThumbnailGeneration), best-effort;
     log failures, don't throw. Idempotent — the film_emailed_at IS NULL check is the de-dup.

3. Retire the legacy delay trigger for FD-mode orgs so we never double-send: find where
   film_scans.email_scheduled_at is set (process-gallery-queue and/or the association path) and the
   scheduler that calls send-film-scan-email on due scans. For orgs in film_development mode, do NOT set
   email_scheduled_at, AND make the scheduler skip film_development-mode orgs. Legacy (film_scans-mode)
   orgs must be completely unchanged.

Report what you found for the legacy scheduler and exactly how you gated it.
```

## Prompt B — Lovable — Film Development email settings + manual/override on Rolls

```
Phase 5b — surface the Film Development email settings and add manual send / override to the Rolls view.

1. Under Organizations → Film Development settings, add an "Email" section that edits the SAME per-brand
   pixfizz_website_email_settings (subject, body, from name, reply-to, bcc, logo, gallery_url_prefix,
   direct download domain/enabled) PLUS the new film_email_trigger_mode selector (Per job / Per order /
   Manual) with clear explanations. Per brand (pixfizz website) — let the admin pick the website if the
   org has several. Do not remove the legacy Film Scan email dialog.

2. On the Film Development Rolls view (RollsTab.tsx): per order, add a "Send email now" button that calls
   send-film-scan-email(order_id, immediate:true) and, on success, stamps jobs.film_emailed_at = now() on
   the order's satisfied film jobs. Show last-sent state from film_scans.email_sent_at / email_status
   (e.g. "Emailed {date}"). This button doubles as the per-roll override (content is per-order cumulative).

Additive; Twin Checking tab and legacy Film Scans unchanged.
```

## Prompt C — Lovable — unmatched rolls bucket

```
Phase 5c — an Unmatched rolls bucket for the Film Development workflow.

A synced roll that matched no twin check has no job_twin_checks row referencing it (film_scan_id) and is
unassociated (order_id IS NULL). In film_development mode the legacy Film Scans page is hidden, so these
must be visible and assignable here.

1. Add an "Unmatched" section/tab in the Film Development area, shown only in film_development mode,
   listing the org's film_scans that are NOT referenced by any job_twin_checks.film_scan_id AND have
   order_id IS NULL — with twin_check_number (the folder-derived code), location, image_count, upload date.

2. Manual-assign action per unmatched roll: let the operator pick a Job (by job number) and a 4-digit twin
   check code, then link the roll — set that job_twin_checks row's film_scan_id + film_scan_uploaded_at (or
   create the twin-check row if the operator is assigning a new code, respecting the live-uniqueness guard),
   and auto-associate the scan to the job's order using the shared associate helper. After assignment the
   roll leaves the Unmatched bucket and behaves like any matched roll. Reuse FilmScanAssociator UX where
   sensible.

Additive; only in film_development mode.
```

## Notes
- Build A → B → C.
- The sender (`send-film-scan-email`) is unchanged; Phase 5 is trigger + settings + UI + unmatched.
- Phase 6 (auto-complete) then hangs off the same completeness + the "email sent" state.
