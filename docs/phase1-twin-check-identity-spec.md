# Phase 1 Build Spec — Twin-Check Identity & Uniqueness

**Status:** Ready to build (2026-07-18). Foundational phase of the Film Development gallery/email workflow.
**Systems:** OrderHub web (Lovable `pixfizz-oms`) — bulk; OrderHub Desktop — one defensive change.

## Goal

Guarantee that a scanned roll folder (`00000001`) is always matched to the **right** job, given that twin-check codes `0000`–`9999` are reused over time. Rule: **at most one *live* twin check per (scan location, code)**, where **live = assigned but not yet scanned** (`film_scan_uploaded_at IS NULL` and not released). A code is freed the instant its roll is scanned, or when its job/order is cancelled.

## Guardrail (non-disruptive)

- Legacy Film Scans workflow does **not** use `job_twin_checks` — none of this touches it.
- All columns additive & nullable; the new uniqueness index is **partial** (bites only live twin-check rows), so existing/historic data is unaffected.
- The `/jobs/pending` change only affects film-development (twin-check) jobs, refining behaviour the shipped v1.7.20 feature already relies on.
- Verify the existing twin-check match/upload flow (our `9002` test) still works after each change.

## Current state (verified 2026-07-18)

- `job_twin_checks`: `id, job_id, organization_id, code, position, created_by, created_at, updated_at, film_scan_uploaded_at, film_scan_id, film_scan_image_count`. `UNIQUE(job_id, code)`, `CHECK code ~ '^[0-9]{4}$'`, `job_id → jobs ON DELETE CASCADE`. **No location, no live-uniqueness.**
- OHD matcher (`film-scan-auto-assign.js`) does arbitrary **last-wins** when two live jobs share a code.
- `ohd-api` `getPendingJobs` exposes **all** of a job's twin checks (incl. already-scanned) until the job closes.
- Job statuses: `New / in_production / completed / cancelled`.

## Design

### 1. Scan-location resolution (get this right — it defines the uniqueness scope)
A twin check's scan location **must equal where its roll will be uploaded** (OHD's `X-Location-ID`, i.e. the `film-scans/{locationId}/` prefix). That is the same location `/jobs/pending` routes the film-dev job to. **Resolve identically to `getPendingJobs`:**
`scan_location_id = store_locations[order.pickup_location_id].film_processing_location_id ?? order.pickup_location_id` (with `production_location_id` / process `override_locations` as the fuller chain if the org uses them). **Recommendation:** extract one shared resolver used by both `getPendingJobs` and twin-check assignment so they can never diverge.

### 2. Data model (migration)
- Add `job_twin_checks.location_id uuid NULL REFERENCES store_locations(id) ON DELETE SET NULL` — the resolved scan location, stamped at assignment.
- Add `job_twin_checks.released_at timestamptz NULL` — set when a twin check is released (job/order cancelled) so its code frees for reuse.
- **Backfill** `location_id` for existing rows from each job's resolved scan location.
- **Partial unique index** (the hard guarantee):
  `CREATE UNIQUE INDEX job_twin_checks_live_unique ON job_twin_checks (organization_id, location_id, code) WHERE film_scan_uploaded_at IS NULL AND released_at IS NULL AND location_id IS NOT NULL;`
- Keep `UNIQUE(job_id, code)`.
- **Pre-flight:** before creating the index, verify no existing live duplicates (query below); resolve any before migrating.

### 3. Assignment guard (Twin Checking tab, `TwinCheckingTab.tsx`)
- On job lookup, resolve and hold the job's `scan_location_id`.
- On save, for each **new/edited** code, pre-check: does a **live** twin check with the same `(organization_id, scan_location_id, code)` exist on a **different** job (`film_scan_uploaded_at IS NULL AND released_at IS NULL`)? If yes → **block** with a clear message naming the order/job that holds it ("Twin 0001 is already live on order X at London — scan or release it first").
- Stamp `location_id = scan_location_id` on inserted rows.
- Treat a `23505` from the partial index as a friendly race-condition error (backstop).
- If `scan_location_id` can't be resolved (no pickup location), warn — uniqueness can't be guaranteed.

### 4. `/jobs/pending` — offer unscanned twin checks only (`ohd-api/index.ts`)
- The `twinChecksByJobId` fetch filters to `film_scan_uploaded_at IS NULL AND released_at IS NULL`.
- `is_film_development` = (unscanned twin_checks > 0). A fully-scanned film-dev job then drops out of `/jobs/pending` (nothing left to match) even while it stays open awaiting gallery/email — which is what frees a code cleanly.

### 5. Release-on-cancel (DB trigger)
- Trigger on `jobs`: when `status` → `cancelled`, stamp `released_at = now()` on that job's twin checks where `film_scan_uploaded_at IS NULL AND released_at IS NULL`.
- Confirm whether cancelling an **order** sets its jobs to `cancelled` (if so this covers it; if not, add an equivalent order-cancel path).

### 6. Defensive matcher (OrderHub Desktop, `film-scan-auto-assign.js`)
- Replace arbitrary last-wins: if the matcher ever sees **>1 live** film-dev job for the same normalised code, **do not match** — skip + log/flag the roll as ambiguous for operator resolution. Should never fire once §3–4 hold (OHD only sees its own location's jobs), but must never silently mis-allocate. Low risk; ship with a unit test.

## Migration safety / rollout

Additive and dormant. Sequence: (1) columns + backfill, (2) pre-flight duplicate check, (3) partial index, (4) cancel trigger, (5) assignment guard UI, (6) `/jobs/pending` filter, (7) OHD defensive matcher. Verify the `9002`-style happy path after each OrderHub step.

**Pre-flight duplicate check (must return 0 rows before creating the index):**
```sql
SELECT organization_id, location_id, code, COUNT(*) FROM job_twin_checks
WHERE film_scan_uploaded_at IS NULL AND released_at IS NULL AND location_id IS NOT NULL
GROUP BY 1,2,3 HAVING COUNT(*) > 1;
```

## Verification

1. Assign `0001` to Job A at London → assigning `0001` to Job B at London is **blocked**; assigning `0001` at Manchester is **allowed**.
2. Scan `00000001` → matches Job A, stamps uploaded → `0001` now assignable again at London.
3. `/jobs/pending` no longer lists `0001` for Job A once scanned.
4. Cancel a job with an unscanned `0002` → `0002` becomes assignable again.
5. Existing `9002` match/upload/badge flow still works end-to-end.

---

## Prompt A — Lovable (OrderHub) — schema + guard + pending filter

> Send to `pixfizz-oms` (`dc8eacaf-…`). Large; can be split into A1 (schema/trigger), A2 (guard), A3 (pending) if preferred.

```
Phase 1 of the Film Development workflow: make twin-check codes safe to reuse. Codes 0000–9999 are
reused across sticker rolls, so a code is only unique among LIVE twin checks (assigned but not yet
scanned) per scan LOCATION. Everything here is additive and must not affect any org that isn't using
twin checks.

1. Migration on public.job_twin_checks:
   - Add location_id uuid NULL REFERENCES store_locations(id) ON DELETE SET NULL.
   - Add released_at timestamptz NULL.
   - Backfill location_id for existing rows: for each row's job → order, set it to
     COALESCE( (the pickup location's film_processing_location_id), order.pickup_location_id ).
   - Verify there are no existing live duplicates, then create a PARTIAL UNIQUE INDEX
     job_twin_checks_live_unique ON (organization_id, location_id, code)
     WHERE film_scan_uploaded_at IS NULL AND released_at IS NULL AND location_id IS NOT NULL.
   - Keep the existing UNIQUE(job_id, code).

2. Scan-location resolver: add ONE shared helper that resolves a job's scan location exactly the way
   getPendingJobs routes film-dev jobs — film_processing_location_id of the order's pickup location if
   set, else pickup_location_id (respecting the existing production_location_id/override chain if the
   org uses it). Use it for both the backfill/assignment and (refactor) getPendingJobs so they can't
   diverge.

3. Release-on-cancel: DB trigger on jobs — when status changes to 'cancelled', set released_at = now()
   on that job's twin checks where film_scan_uploaded_at IS NULL AND released_at IS NULL. If cancelling
   an order does not already set its jobs to 'cancelled', cover that path too.

4. Twin Checking tab (src/components/film-development/TwinCheckingTab.tsx): when a job is looked up,
   resolve its scan location. On save, before inserting, block any new/edited code that already exists
   as a LIVE twin check (film_scan_uploaded_at IS NULL AND released_at IS NULL) on a DIFFERENT job at
   the SAME scan location — show a clear toast naming the order/job holding it. Stamp location_id on
   inserted rows. Handle a 23505 unique-violation as a friendly "that code is already live" error. If
   the scan location can't be resolved, warn that uniqueness can't be guaranteed.

5. supabase/functions/ohd-api/index.ts getPendingJobs: when building twin_checks per job, include only
   UNSCANNED, unreleased codes (film_scan_uploaded_at IS NULL AND released_at IS NULL). is_film_development
   should be true only when there is at least one such unscanned code. (A fully-scanned film-dev job then
   drops out of /jobs/pending, which is correct.)

Do not change any legacy Film Scans behaviour. Keep it backwards-compatible for orgs without twin checks.
```

## Prompt B — Claude CLI (OrderHub Desktop) — defensive matcher

> Paste into Claude Code from `C:\Dev\OrderHubDownloader`.

```
Defensive hardening in src/main/services/film-scan-auto-assign.js. Today jobByTwin uses arbitrary
last-wins when two cached film-dev jobs expose the same normalised twin code. Change it so that if more
than one LIVE film-dev job maps to the same normalised code, the matcher does NOT match that roll —
skip it, log a clear warning ("ambiguous twin match: code X on jobs A,B — not auto-assigning"), and
leave the roll for manual resolution, rather than picking arbitrarily. Single-match behaviour is
unchanged. Add a unit test for the ambiguous-collision case (two jobs, same twin) and confirm the
existing auto-assign tests still pass. No version bump, no push.
```

## Open / edge notes

- **Stale location:** if an order's pickup location or film-processing routing changes after assignment, the denormalised `location_id` could drift. Rare; consider a re-resolve on order-location change later.
- **NULL location:** rows with unresolved `location_id` aren't covered by the partial index (Postgres treats NULLs as distinct). The assignment warning mitigates; acceptable for Phase 1.
- **Order-level cancel path** must be confirmed (does it cascade to job status?).
