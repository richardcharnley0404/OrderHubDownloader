# ohd-api efficiency contract (v1.4.0)

**Status:** in prod as of the CHANGELOG "Unreleased" section.
**Read alongside:** `docs/ohd-api-v1.4.0-claude-code-brief.md` (design
brief), `src/main/services/server-capabilities.js` (client-side state).

This is the load-bearing doc for four intertwined behaviours that
together cut OHD's polling cost against OrderHub. If you're about to
"fix" one of the trade-offs called out here — read the relevant
section first.

---

## The feature flags

Every efficiency behaviour is gated on a flag OrderHub returns in the
`/checkin` response's `features` bag. When the app runs against a
pre-1.4.0 server, none of the flags appear, all behaviour falls back to
the pre-1.4.0 code paths, and the app works exactly as it did in
v1.8.0.

| Flag                     | Type    | Gates                                            | Fallback when off / older server |
|--------------------------|---------|--------------------------------------------------|----------------------------------|
| `status_batch`           | boolean | `POST /jobs/status-batch` for the sync loop      | Per-job `GET /jobs/{id}` loop, `CHUNK_SIZE = 8` concurrent. Byte-for-byte the v1.8.0 path — the fallback method (`_syncJobStatusFromOHPerJob`) is deliberately kept verbatim. |
| `pending_etag`           | boolean | `If-None-Match` on `GET /jobs/pending`           | Full-body 200 on every poll. |
| `presign_expiry`         | boolean | Consumes `presign_expires_at` from the response  | If absent, no presign gating happens — but we also don't 304, so URLs are always fresh. |
| `status_batch_max`       | number  | Cap for `_syncJobStatusFromOHBatch` chunk size   | 200 (the client-side default in `DEFAULT_FEATURES`). |
| `poll_interval_seconds`  | number  | The main pending-poll cadence                    | `configService.get('pollingInterval')` (user setting, 10–600 seconds). |
| `status_poll_interval_seconds` | number | The out-of-band status-sync cadence         | Every `pollJobs` cycle (v1.8.0 behaviour). |

All flags are read on every check-in and persisted per-install to their
own `server-capabilities` electron-store — a restart before the next
check-in still behaves as the last check-in configured. Invalid /
out-of-range values are ignored (never clamped); absent fields leave the
stored value untouched.

`disableFeatureForSession(flag)` mutes a flag in-memory only. Used
today by the batch-status path on endpoint 404 so one bad server
response doesn't stick across restarts.

## The 304 / presign safety window (PRESIGN_SAFETY_MS = 5 min)

Presigned artwork URLs in `/jobs/pending` have a **1-hour TTL**. A `304
Not Modified` response does **not** extend that TTL — the URLs the
client is still holding are the same URLs, one poll cycle older.

If we blindly took a 304 whenever the etag matched, we would eventually
be holding artwork URLs that expire mid-download. So `fetchJobs` forces
a genuine 200 whenever `Date.parse(_presignExpiresAt) - Date.now() <=
PRESIGN_SAFETY_MS` (5 min). At the default 60s poll cadence that costs
roughly **one full body per hour** — the intended trade-off. Everything
between those hourly refreshes is a cheap 304.

If you're tempted to lower `PRESIGN_SAFETY_MS`: don't unless the server
starts extending the presign window on 304, or unless you've measured
that stale-URL failures are rare enough that a shorter safety margin
pays off in bandwidth. The 5-min margin also covers clock skew — if the
client clock is 90 seconds slow, we can still afford one poll cycle
before hitting the wire.

## Self-healing on download failure

If any file in a poll cycle fails to download,
`polling-service.pollJobs` calls `jobService.invalidatePendingEtag()`.
That sets `_forcePendingRefresh = true`, so the very next `fetchJobs`
omits `If-None-Match` and gets a fresh 200 with new signed URLs —
instead of 304ing against the URLs that just failed. The flag is
cleared automatically on the next successful 200.

This is *cheap* compared to waiting for the safety window to trigger a
refresh, because a single download failure typically means an entire
job's URLs are stale (they were all issued at the same moment).

## The 300s status-lag trade-off

When `status_poll_interval_seconds` is advertised (typical value: 300),
the out-of-band status sync only runs at that cadence, not every
`pollJobs` cycle. That means:

- A job completed in OrderHub can take **up to
  `status_poll_interval_seconds` (300s by default)** to clear from
  OHD's Awaiting Processing view.
- An operator "mark completed" performed in OrderHub Web while OHD is
  looking at the same job takes the same lag.

This is accepted and already signed off. The cost we're buying with it
is roughly `active_jobs / 60` fewer per-job requests to OrderHub every
minute — for a busy lab with 50 active jobs, that's ~40 fewer requests
per minute per install, times every install in the fleet.

If the lag becomes annoying, there's a `TODO` in
`polling-service.pollJobs` for a `forceStatusSyncNext()` hook that
operator actions (mark complete, retry, etc.) could call to reset
`lastStatusSyncAt = null` for the next cycle. **Do not build this
speculatively** — build it when a specific operator workflow is being
measured as painful. Building it broadly would give up most of the
efficiency win we just paid the design cost to earn.

`lastStatusSyncAt` advances in a `finally` block so a throwing sync
still counts as "attempted" and can't collapse the gate back to every
cycle. This is defensive — an actual sync throw would already be logged
by the polling-service `catch`.

## Changing the cadence — server-side dials

The two cadences live in the `organization_preferences` table in the
**pixfizz-oms Supabase project** — that's where the ohd-api Edge
Function reads them from before answering `/checkin`. Both are
per-organisation and take effect on the very next check-in from every
OHD install in that org, so **no client release is needed** to change
them.

| Preference column                       | Default | Purpose |
|-----------------------------------------|---------|---------|
| `ohd_poll_interval_seconds`             | `60`    | Cadence of the main `/jobs/pending` poll. Clamped to 10–600 client-side. Lower = more responsive to new jobs, higher = less traffic. |
| `ohd_status_poll_interval_seconds`      | `300`   | Cadence of the batched status sync (see `status_batch` above). Clamped to 30–3600 client-side. This is what the 300s completion-lag trade-off refers to. |

**There is no admin UI for these fields as of 2026-08-09.** Both
columns exist on the schema and the Edge Function reads them, but no
Lovable screen has been built to edit them yet — changing either
means a direct SQL update against `organization_preferences` in
Supabase (or scripting one through the CLI). As of writing, all 30
orgs are still on the defaults.

Once you write a new value, every OHD install in that org picks it up
on its next `/checkin`: 4-hour schedule, or immediately on next
launch. `polling-service.applyServerCadence()` re-clocks the running
timer without waiting for a restart. If/when an admin UI lands,
update this section.

## Where the server value wins vs the client config

`configService.get('pollingInterval')` (the user's setting in
Settings → Polling) is now the **offline fallback only**. Once
`/checkin` returns `poll_interval_seconds`, the server value wins:

- `polling-service.getPollingInterval()` returns from
  `serverCapabilities.getPollIntervalMs()`.
- `start()` clocks the initial timer off that value (so persisted
  server values apply at boot, not just after the next check-in).
- `getStatus().interval` reflects the same value (the UI reads it).
- `applyServerCadence()` re-clocks live when a check-in changes it.

The Settings input marks itself `readOnly` and rewrites its `.field-hint`
text to `Set centrally by OrderHub (Ns). Contact Pixfizz to change it.`
when the server value is present. That prevents the "I edited the
field, nothing happened" bug report.

## When the server contract lies

- **Endpoint 404 on `/jobs/status-batch`** — an older server. We call
  `serverCapabilities.disableFeatureForSession('status_batch')` (so we
  don't repeat the fallback every cycle) and fall through to the
  per-job path for the whole cycle.
- **Endpoint returns `success: false` (2xx body-level failure)** — treat
  the same as a non-2xx: log, return 0, don't mutate any job.
- **`errors[]` `status:400`** — the id is genuinely bad and will not
  resolve on retry. Stamp `_status='error'` with the exact legacy
  message so the operator sees it in the UI.
- **`errors[]` any other status (403/404/5xx)** — transient or scope
  issue. Warn and leave the job alone. **Do NOT mark 404s as errored**
  — that would strand a transiently-missing active job.
- **304 with an unexpected non-empty body** — don't `JSON.parse` it.
  The 304 handler doesn't touch `this.jobs` regardless.
- **500 on `/jobs/pending`** — leave the stored etag intact. A
  transient 5xx shouldn't force a full body on the next cycle.

## What we deliberately didn't do

- **We didn't rip out `GET /jobs/{id}`.** It's still there for genuine
  one-off lookups (currently unused in the polling loop, but keep it —
  it will save future contributors from re-implementing it).
- **We didn't touch `orderhub-api-client.js`.** That's a different
  service with the `X-API-Key` contract. The telemetry headers and the
  ohd-api additions are scoped to the ohd-api host only.
- **We didn't lower the presign safety window below 5 min** — see
  above.
- **We didn't build a `forceStatusSyncNext()` hook** — see above.
- **We didn't remove the `pollingEnabled` early-return in
  `updater._checkIn`.** Upload-only PCs (Film Scans / File Uploads
  only, no Mode 1) must not register as online instances. See
  `docs/orderhub/bugfixes.md 2026-04-30` and the multi-PC deployment
  note in the code comment.
