# Phase 3 Build Spec — Completeness Model

**Status:** Ready to build (2026-07-18). All OrderHub web (Lovable `pixfizz-oms`).
**Depends on:** Phases 1–2 (shipped).

## Goal

Know, reliably, when a **job** and an **order** are "film-complete", so the Rolls view can show it and later phases (email triggers, auto-complete) can act on it. Introduce the per-job **"scan not required"** flag, and a **reusable** completeness computation used by the UI now and by Phases 5–6 later.

## Guardrail (non-disruptive)

- New `jobs.film_scan_not_required` column defaults `false` (additive, nullable-safe).
- The completeness views are read-only and only consumed by the Film-Development Rolls view (film_development mode). Legacy Film Scans untouched.

## Definitions (get these exact)

**Job → process resolution** (same as elsewhere): `pixfizz_website_categories.process_id` where `category_name = jobs.category AND pixfizz_website_id = jobs.pixfizz_website_id`; fallback `organization_processes.id` where `organization_id = jobs.organization_id AND process_name = jobs.category`.

**Live twin checks** for a job: `job_twin_checks` rows with `released_at IS NULL`. Uploaded = those with `film_scan_uploaded_at IS NOT NULL`.

**Is this a "film job that needs scanning"?** True when ANY of:
- the resolved process_id ∈ the org's `twin_checking_allowed_process_ids`, **or**
- the job has ≥1 live twin check, **or**
- `film_scan_not_required = true`.
(When `twin_checking_allowed_process_ids` is empty — "allow any" — this reduces to "has twins or flagged", which is the correct read of "which jobs need scanning".)
Exclude jobs with `status = 'cancelled'`.

**Job film_status** (only meaningful for film jobs):
- `not_required` — `film_scan_not_required = true`.
- `complete` — has ≥1 live twin AND all live twins uploaded (or job `status = 'completed'`).
- `partial` — has live twins, some but not all uploaded.
- `awaiting` — film job with no live twins yet, or none uploaded.

**Job satisfied** = `not_required` OR `complete`.

**Order film_complete** = the order has ≥1 film job AND **every** film job is satisfied. (Non-film jobs and cancelled jobs ignored. An order with no film jobs is `film_complete = NULL/false` — "not applicable".)

## Design

### 1. Schema
- `jobs.film_scan_not_required boolean NOT NULL DEFAULT false`.

### 2. Reusable completeness views (the primitive Phases 5–6 reuse)
- **`job_film_status`** — per job: `job_id, order_id, organization_id, process_id, is_film_job (bool), film_status (text), satisfied (bool), live_twins int, uploaded_twins int`. Encapsulates the process resolution + twin aggregation + the rules above.
- **`order_film_status`** — per order: `order_id, organization_id, film_job_count int, satisfied_count int, film_complete (bool)`.
- Plain views (SECURITY INVOKER) so they inherit the underlying tables' RLS — safe for the frontend (org-scoped automatically) and usable by service-role callers server-side later.
- Correctness matters here ("MUST get it right"): unit-check the four `film_status` cases and the "film job with no twins blocks the order" case with the pre-flight queries below.

### 3. Rolls view (extend `RollsTab.tsx`)
- **Include no-twin film jobs.** Today the Rolls view only lists jobs that have twin checks. Extend it (via `job_film_status` / by loading the order's film jobs) so a film job with **no** twin checks shows as **"Awaiting twin checks"** — otherwise an order looks complete when it isn't.
- **Per-job:** a status badge (Complete / Partial / Awaiting / No scan needed) from `job_film_status`, and a **"No scan needed"** toggle that writes `jobs.film_scan_not_required` (optimistic update + refetch). Guard the toggle so it can't be turned on for a job that already has uploaded scans without a confirm.
- **Per-order:** a completeness badge — "Film complete" (green) when `order_film_status.film_complete`, else "n/m jobs scanned".
- **Filters:** keep All / Awaiting / Fully scanned; optionally add "Order complete". Wire them off the new statuses.
- Fill the Phase-2 placeholder slots with these badges. Leave the gallery/email/complete **action** buttons for Phases 4–6 (still placeholders).

## Verification (pre-flight / correctness)

```sql
-- Jobs with their resolved film status (spot-check a film order):
-- expect: film jobs satisfied only when not_required or all live twins uploaded.
SELECT * FROM job_film_status WHERE organization_id = '<org>' ORDER BY order_id LIMIT 50;

-- Orders: film_complete should be false while any film job is awaiting/partial.
SELECT * FROM order_film_status WHERE organization_id = '<org>' AND film_job_count > 0 LIMIT 50;
```
Manual: an order with a film job that has **no** twin checks (and not flagged) must show `film_complete = false`; flag that job "no scan needed" → order flips to complete.

---

## Prompt A — Lovable — schema + completeness views

```
Phase 3a — the film completeness primitive. Additive; read-only views; does not affect legacy Film Scans.

1. Migration: add jobs.film_scan_not_required boolean NOT NULL DEFAULT false.

2. Create two SQL VIEWS (SECURITY INVOKER, so they inherit the underlying tables' RLS):

   Resolution used inside: a job's process_id = pixfizz_website_categories.process_id where
   category_name = jobs.category AND pixfizz_website_id = jobs.pixfizz_website_id; fallback
   organization_processes.id where organization_id = jobs.organization_id AND process_name = jobs.category.
   Live twins = job_twin_checks with released_at IS NULL; uploaded = those with film_scan_uploaded_at NOT NULL.
   The org's film processes = organization_preferences.twin_checking_allowed_process_ids (uuid[]).

   a) job_film_status — one row per job (exclude status='cancelled'):
      columns: job_id, order_id, organization_id, process_id, live_twins int, uploaded_twins int,
        is_film_job boolean, film_status text, satisfied boolean.
      is_film_job = (process_id = ANY(org allowed_process_ids)) OR live_twins > 0 OR film_scan_not_required.
      film_status = 'not_required' if film_scan_not_required
                    else 'complete'  if (live_twins > 0 AND uploaded_twins = live_twins) OR jobs.status='completed'
                    else 'partial'    if uploaded_twins > 0
                    else 'awaiting'.
      satisfied = film_status IN ('not_required','complete').

   b) order_film_status — one row per order:
      columns: order_id, organization_id, film_job_count int, satisfied_count int, film_complete boolean.
      Consider only is_film_job rows from job_film_status. film_complete = (film_job_count > 0 AND
      satisfied_count = film_job_count).

3. Do not change any app code in this pass. Keep it correct and idempotent (CREATE OR REPLACE VIEW).
```

## Prompt B — Lovable — Rolls view completeness UI

```
Phase 3b — surface completeness on the Film Development Rolls view (src/components/film-development/RollsTab.tsx).
Only affects film_development mode.

1. Use the new job_film_status / order_film_status views (query them for the org, scoped as the Rolls view
   already is). IMPORTANT: also include film jobs that have NO twin checks yet (is_film_job = true,
   film_status = 'awaiting') so an order can't look complete when a film job hasn't been twin-checked — show
   those jobs with an "Awaiting twin checks" note.

2. Per job: show a status badge from job_film_status — Complete (green) / Partial (amber) / Awaiting (muted) /
   No scan needed. Add a "No scan needed" toggle that writes jobs.film_scan_not_required (optimistic update +
   refetch). If the job already has uploaded scans, require a confirm before turning it on.

3. Per order: show a completeness badge — "Film complete" (green) when order_film_status.film_complete is true,
   otherwise "{satisfied_count}/{film_job_count} jobs done".

4. Replace the Phase-2 completeness placeholders with these. Keep the gallery/email/complete ACTION buttons as
   placeholders (Phases 4–6). Keep existing filters/search; wire them off the new statuses where natural.

Additive; Twin Checking tab and legacy Film Scans unchanged.
```

## Notes

- Build A first (B depends on the views).
- Later phases: Phase 5 email triggers and Phase 6 auto-complete both read `order_film_status` — this is the shared primitive, so getting it right here pays off repeatedly.
- Edge: a `completed` film job counts as satisfied even if its twin rows aren't all stamped (job was closed manually) — intended, avoids stuck orders.
