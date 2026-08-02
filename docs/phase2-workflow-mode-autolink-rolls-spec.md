# Phase 2 Build Spec — Workflow Mode Selector + Auto-Link + Rolls View

**Status:** Ready to build (2026-07-18). All OrderHub web (Lovable `pixfizz-oms`). No OHD change.
**Depends on:** Phase 1 (shipped).

## Goal

Make the Film Development workflow visibly its own thing and cleanly separated from legacy Film Scans:
1. An **org-level mode selector** — Film Scan **or** Film Development, never both.
2. **Auto-link** each matched roll to its order + customer at sync time (no manual association).
3. A new **Rolls view** — the operator hub for the new workflow, organised order → job → twin.

## Guardrail (non-disruptive)

- New mode defaults to **`film_scans`** for every org, so nothing changes until an org explicitly opts in. Richard's own org (which has `film_development_enabled = true` for testing) keeps its legacy Film Scans page until it switches mode.
- Auto-link and the Rolls view only activate in `film_development` mode.
- All additive; legacy Film Scans page/pipeline untouched in `film_scans` mode.

## Current state (verified)

- FD page `src/pages/FilmDevelopment.tsx` is gated on `film_development_enabled`; tabs added conditionally (only Twin Checking today). Config via `useFilmDevelopmentConfig` (`film_development_enabled`, `twin_checking_enabled`, `twin_checking_allowed_statuses`, `twin_checking_allowed_process_ids`).
- FD link is in the sidebar + Orders toolbar (via `useFilmDevelopmentEnabled`).
- Association today is manual: `associate-film-scan` sets `film_scans.{order_id, order_code, customer_name, customer_email, associated_at, associated_by, client_order_id, client_organization_id}`, resolves outsourced orders via `outsourced_jobs`, and queues gallery creation when `pixfizz_website_email_settings.auto_create_gallery` is on.
- `sync-film-scans-from-s3` does **not** set any order linkage today.

## Design

### 1. Mode selector
- Migration: `organization_preferences.film_workflow_mode text NOT NULL DEFAULT 'film_scans'` with `CHECK (film_workflow_mode IN ('film_scans','film_development'))`.
- Only settable to `film_development` when `film_development_enabled = true` (UI gate; keep the two flags — `film_development_enabled` = "FD tools available", `film_workflow_mode` = "which delivery workflow is active").
- Add `film_workflow_mode` to `useFilmDevelopmentConfig`.
- UI: a two-option selector on **Organizations → Film Development** tab, next to the existing enable/twin-checking controls, with a clear explanation ("Film Development mode hides the legacy Film Scans page and uses twin-check auto-matching").
- Effects when `film_development`:
  - Hide the legacy **Film Scans** nav entry; redirect `/film-scans` → the FD Rolls view.
  - FD page shows the new **Rolls** tab.
  - Auto-link (below) active.
- Effects when `film_scans` (default): everything exactly as today; Rolls tab hidden; `/film-scans` normal.

### 2. Auto-link on sync (film_development mode only)
- Extract a shared helper from `associate-film-scan` (order/customer field-set + `outsourced_jobs` resolution) so the manual associator and the sync share one implementation.
- In `sync-film-scans-from-s3`, after a twin check is stamped (we already resolve the internal job id), if the org's `film_workflow_mode = 'film_development'` and the scan isn't already associated, auto-associate the `film_scans` row to that job's **order + customer** via the shared helper (`associated_by = null`/system). Include the outsource resolution.
- **Do not** queue gallery creation here yet — gallery-on-upload is Phase 4 (note the hook point).
- Gate strictly on `film_development` mode so legacy orgs' scans are never auto-associated.

### 3. Rolls view (new FD tab)
- New tab **"Rolls"** on the FD page, shown when `film_workflow_mode = 'film_development'`.
- The operator hub, organised **order → job → twin/roll**, over `job_twin_checks` joined to `jobs` + `orders` (+ `film_scans` via `film_scan_id`), scoped to the org and the lab's allowed film processes (`twin_checking_allowed_process_ids`).
- Per order: show its film jobs; per job: its twin checks; per twin: **scan status** (Scanned ✓ · date · N images, from Phase 1's stamp fields, or "Awaiting scan"), and a gallery link when a gallery exists.
- Useful filters: Awaiting scans / Partially scanned / All. Search by order/twin.
- **Phase 2 = the organisational read view + scan status.** Completeness badges (Phase 3), and gallery/email/complete actions (Phases 4–6) layer on later — leave clear slots for them.
- This is what an operator uses instead of the legacy Film Scans page in FD mode.

## Non-disruption checks

- Default mode `film_scans` → verify legacy Film Scans page, nav, sync, association all byte-identical for a non-opted-in org.
- Auto-link no-op unless mode = `film_development`.
- Twin-check upload recording (Phase 0/1) unaffected in either mode.

## Verification

1. New org (default) → Film Scans page + nav present; no Rolls tab; sync doesn't auto-associate.
2. Switch org to `film_development` → Film Scans nav gone, `/film-scans` redirects; Rolls tab appears.
3. Upload a matched roll → `film_scans` row auto-linked to the order/customer; roll appears under its order → job → twin in the Rolls view with Scanned ✓.
4. Legacy org untouched throughout.

---

## Prompt A — Lovable — mode selector

```
Phase 2a — add an org-level Film workflow mode selector. This is additive and defaults to legacy so no
org is affected until they opt in.

1. Migration: add organization_preferences.film_workflow_mode text NOT NULL DEFAULT 'film_scans'
   with CHECK (film_workflow_mode IN ('film_scans','film_development')).

2. Add film_workflow_mode to useFilmDevelopmentConfig (src/hooks/useFilmDevelopmentEnabled.ts) and its
   FilmDevelopmentConfig interface.

3. Organizations → Film Development settings tab: add a two-option selector "Film workflow" with
   Film Scans (legacy) and Film Development. Only allow choosing Film Development when
   film_development_enabled is true. Explain that Film Development mode hides the legacy Film Scans page
   and uses twin-check auto-matching.

4. When an org's film_workflow_mode = 'film_development': hide the legacy "Film Scans" nav/sidebar entry
   and redirect the /film-scans route to the Film Development page. When 'film_scans' (default): leave the
   Film Scans page, nav, and everything else exactly as today. Do not change any other behaviour.

Backwards-compatible; default keeps every existing org on the legacy workflow.
```

## Prompt B — Lovable — auto-link on sync

```
Phase 2b — auto-link twin-check scans to their order/customer, so operators don't manually associate in
the Film Development workflow. Only for orgs whose film_workflow_mode = 'film_development'.

1. Extract a shared helper (e.g. supabase/functions/_shared/associateFilmScan.ts) from
   supabase/functions/associate-film-scan/index.ts containing the association logic: set order_id,
   order_code, customer_name, customer_email, associated_at, associated_by, and the outsourced_jobs
   client_order_id/client_organization_id resolution. Refactor associate-film-scan to use it (behaviour
   unchanged for the manual path).

2. In supabase/functions/sync-film-scans-from-s3/index.ts, after stampTwinCheckFromManifest resolves the
   internal job id for a scan, if the org's film_workflow_mode = 'film_development' AND the film_scans row
   isn't already associated (order_id IS NULL), auto-associate it to that job's order + customer using the
   shared helper, with associated_by = null (system). Use the job's order (via the resolved job → order).

3. Do NOT queue gallery creation here (that's a later phase). Do NOT auto-associate for orgs in
   film_scans mode. Keep it idempotent and a silent no-op when there's no resolvable order.

Additive; legacy association flow and legacy-mode orgs unchanged.
```

## Prompt C — Lovable — Rolls view

```
Phase 2c — add a "Rolls" tab to the Film Development page: the operator hub for the twin-check workflow,
shown only when the org's film_workflow_mode = 'film_development'.

Build a new tab in src/pages/FilmDevelopment.tsx (component under src/components/film-development/), listing
work organised order → job → twin/roll, over job_twin_checks joined to jobs + orders (+ film_scans via
film_scan_id), scoped to the org and the allowed film processes (twin_checking_allowed_process_ids).

- Group by order (order_number, customer); within each, its film jobs; within each job, its twin checks.
- Per twin check show scan status: if film_scan_uploaded_at is set, a green "Scanned · {date} · {n} images"
  (date via the existing org date-format helper) plus a link to the gallery if film_scans.gallery_url exists;
  otherwise a muted "Awaiting scan".
- Filters: Awaiting scans / Partially scanned / All; search by order number or twin code.
- Read-only for now — leave clear slots for later completeness badges and gallery/email/complete actions.
- Only mount/show the tab when film_workflow_mode = 'film_development'.

Additive; no change to Twin Checking tab or legacy Film Scans.
```

## Open / notes

- Precedence: build A first (unblocks the mode used by B and C).
- The legacy `/film-scans` redirect target should be the FD page (Rolls tab) — confirm the exact route.
- Later phases hook here: gallery-on-upload (Phase 4) queues at the auto-link point; completeness (Phase 3) and email/complete actions (Phases 5–6) render on the Rolls view.
