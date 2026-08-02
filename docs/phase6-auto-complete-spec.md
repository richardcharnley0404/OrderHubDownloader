# Phase 6 Build Spec — Auto-Complete Pure-Film Pickup Orders

**Status:** Ready to build (2026-07-18). All OrderHub web. Depends on Phases 1–5.

## Goal

Optionally close out an order automatically once its film is fully delivered — but only for **pure-film Pick-Up** orders, so we never touch orders with physical/print work or shipments.

## Rule (agreed)

Org setting **"Auto-complete order when film delivered"** (on/off, default off). When **on**, complete an order only when **all** hold:
- **Pure film:** every job in the order is a film-development job (no non-film jobs remain).
- **Delivered:** every film job is satisfied (twin checks uploaded → gallery → **email sent**) or `film_scan_not_required`.
- **Pickup:** `orders.requires_shipping = false`.

## Design

### Schema
- `organization_preferences.film_auto_complete_pickup_orders boolean NOT NULL DEFAULT false`.

### Trigger — inside `send-film-scan-email`, after a successful send
This is the single point every film email passes through (both the auto trigger from the sync and the manual "Send email now"), and the "email sent" gate is satisfied by definition there. Add, gated so legacy is untouched:
1. Fetch the order's `organization_id` + `requires_shipping`, and the org's `film_workflow_mode` + `film_auto_complete_pickup_orders`.
2. Skip unless `film_workflow_mode = 'film_development'` AND `film_auto_complete_pickup_orders = true`. (Legacy orgs / setting-off → no change; the existing `complete_jobs_on_email_sent` opt-in stays as-is.)
3. Skip unless `requires_shipping = false` (Pick-Up).
4. Skip unless `order_film_status.film_complete = true` for the order.
5. **Pure-film check:** skip if any `job_film_status` row for the order has `is_film_job = false` (i.e. a non-film job exists). (`job_film_status` already excludes cancelled jobs.)
6. Otherwise complete the order: set `orders.status = 'completed'` (only if not already `completed`/`cancelled`), and complete its open jobs (`status = 'completed'`, `completed_at`) — reuse the existing completion code path in `send-film-scan-email`. Idempotent.

### Settings UI
- In Organizations → Film Development settings, add an org-level toggle **"Auto-complete Pick-Up orders when film delivered"** (writes `organization_preferences.film_auto_complete_pickup_orders`), with a one-line explanation that it only closes pure-film pickup orders once the customer's scans are delivered.

## Guardrail (non-disruptive)
- Default off; only runs in FD mode with the toggle on. Legacy `complete_jobs_on_email_sent` behaviour unchanged. Shipped/mixed orders never auto-completed.

## Verification
1. Pure-film pickup order, setting on → after the film email sends and the order is film-complete, the order flips to `completed`.
2. Same order but with a non-film job present → NOT auto-completed.
3. Shipped order (`requires_shipping = true`) → NOT auto-completed.
4. Setting off / legacy mode → no change.

---

## Prompt — Lovable — Phase 6 auto-complete

```
Phase 6 — auto-complete pure-film Pick-Up orders once their film is delivered. Additive; default off;
only runs in film_development mode. Legacy behaviour (including the existing complete_jobs_on_email_sent
opt-in) must be unchanged.

1. Migration: organization_preferences.film_auto_complete_pickup_orders boolean NOT NULL DEFAULT false.

2. In supabase/functions/send-film-scan-email, AFTER a successful customer send (and after/alongside the
   existing complete_jobs_on_email_sent logic), add an auto-complete step:
   - Fetch the order's organization_id and requires_shipping, and the org's film_workflow_mode and
     film_auto_complete_pickup_orders.
   - Proceed only if film_workflow_mode = 'film_development' AND film_auto_complete_pickup_orders = true
     AND requires_shipping = false.
   - Proceed only if order_film_status.film_complete = true for this order.
   - Pure-film check: proceed only if NO job_film_status row for this order has is_film_job = false
     (job_film_status already excludes cancelled jobs).
   - Then complete the order: mark its open (non-completed, non-cancelled) jobs completed (status,
     completed_at) and set orders.status = 'completed' (guard: only if not already completed/cancelled).
     Idempotent. Reuse the existing completion code path where possible.
   - Log clearly what it did / why it skipped.

3. Organizations → Film Development settings: add an org-level toggle "Auto-complete Pick-Up orders when
   film delivered" that writes organization_preferences.film_auto_complete_pickup_orders, with a one-line
   explanation (only closes pure-film pickup orders once the customer's scans are delivered).

Do not change the legacy Film Scan workflow or the existing per-scan complete_jobs_on_email_sent option.
```
