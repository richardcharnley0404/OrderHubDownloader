# Claude Code brief — adopt ohd-api v1.4.0 (polling cost reduction)

> Paste everything below the line into Claude Code CLI, run from
> `C:\Dev\OrderHubDownloader` on `main`. It is written against the actual code
> in this repo as of `9cf6a3d`, not against the generic Lovable brief.

---

Read `CLAUDE.md` before touching anything. We are adopting **ohd-api v1.4.0**,
an additive, backwards-compatible server change already deployed at
`https://nazkcvruighrhpgcarxg.supabase.co/functions/v1/ohd-api`. Goal: stop
issuing one `GET /jobs/{id}` per tracked job per poll cycle. That loop is ~99%
of our API traffic and ~94% of OrderHub's backend compute.

Work in **seven commits, in order**. Do not start a milestone until the
previous one is complete and its tests pass. Stop and tell me if you hit
something the brief did not anticipate — do not improvise around it.

I will run `npm test` and do all manual testing on Windows. Do not claim
anything is production ready.

---

## Server contract (what v1.4.0 added)

Auth is unchanged: `Authorization: Bearer <key>` (we use Bearer, not
`X-API-Key`, in `job-service._httpRequest` — keep it that way).

**1. `POST /jobs/status-batch`** — one call replaces N status lookups.

```
POST /jobs/status-batch
Content-Type: application/json
{ "job_ids": ["7151fe30-…", "38526437", "ORDER-123_1"] }
```

- Accepts the same id forms as `GET /jobs/{id}`: internal UUID, Pixfizz
  `external_line_item_id`, or legacy `ORDER-NUMBER_JOB-NUMBER`.
- Max 200 ids per request (`features.status_batch_max`). Duplicates are
  de-duped server side.
- Response `200`:
  ```json
  { "success": true, "total_requested": 3, "total_found": 2,
    "jobs":   [ { "requested_job_id": "38526437", "job_id": "38526437",
                  "internal_job_id": "7151fe30-…", "status": "New",
                  "order_status": "pending", "…": "…" } ],
    "errors": [ { "requested_job_id": "bogus", "status": 400,
                  "error": "Invalid job_id format. …" } ] }
  ```
- Each `jobs[]` object is byte-identical to the single `GET /jobs/{id}` payload
  minus `success`, plus `requested_job_id`.
- **Per-id failures do not fail the request.** HTTP stays 200; the id lands in
  `errors[]` with the status/message the single endpoint would have returned
  (`404 Job not found.`, `403 Job belongs to a different organization.`,
  `404 Order not found.`, `400 Invalid job_id format…`).
- Request-level 400 (missing/empty `job_ids`, or >200) returns
  `{ "success": false, "error": "…" }`.

**2. `GET /jobs/pending` now supports ETag / 304.** Response carries an `ETag`
header and an `etag` body field. Send it back as `If-None-Match`. Unchanged
work → `304`, **empty body**, `ETag` header present. Changed → normal `200`
with a new etag. The etag covers job/order status, artwork files and twin-check
codes for the filtered set, and includes `include_no_artwork` and
`X-Location-ID` — different query, different tag. It **deliberately ignores
presigned URL values**, so a 304 does *not* mean the artwork URLs are still
valid.

**3. `GET /jobs/pending` now returns `presign_expires_at`** (ISO instant, 1 hour
TTL). Signed artwork URLs in that payload are valid until then.

**4. `POST /checkin` response gained:**
```json
{ "poll_interval_seconds": 60, "status_poll_interval_seconds": 300,
  "features": { "status_batch": true, "pending_etag": true,
                "presign_expiry": true, "status_batch_max": 200 } }
```
Per-organisation, adjustable from OrderHub without a client release. Re-read on
every check-in.

**5. Version telemetry headers** on every request:
```
X-OHD-Version:     1.8.0
X-OHD-Instance-ID: <the same instance_id we send to /checkin>
```
Both must be present for the server to record them. Fire-and-forget; they never
affect the response.

**Every new behaviour must be gated on its `features` flag** so this build still
runs correctly against the pre-1.4.0 server. Old and new builds coexist
indefinitely.

---

## Where the current behaviour lives

| Concern | File | Detail |
|---|---|---|
| Pending poll | `src/main/services/job-service.js` → `fetchJobs()` | `GET {baseUrl}/jobs/pending`, maps via `_mapApiJob`, filters by location, merges via `_mergeJobs`, persists to the `jobs-cache` electron-store |
| **The loop we are killing** | `job-service.js` → `syncJobStatusFromOH()` | `GET /jobs/{id}` for every local job in `['in_production','received','pending']`, `CHUNK_SIZE = 8` concurrent |
| Poll timer | `src/main/services/polling-service.js` → `getPollingInterval()`, `start()`, `pollJobs()` | `setInterval` at `configService.get('pollingInterval')` (default 60s); `pollJobs()` calls `syncJobStatusFromOH()` unconditionally every cycle |
| Check-in | `src/main/updater.js` → `_checkIn()` | POST `/checkin` on startup + every 4h; **early-returns when `pollingEnabled` is false** (deliberate — see `project_ohd_checkin_polling_gate`); already parses `is_up_to_date` / `download_url` |
| HTTP helper | `job-service.js` → `_httpRequest(method, url, apiKey, body, extraHeaders)` | Native `http`/`https`, 15s timeout, resolves `{ statusCode, body }` — **note: it currently discards response headers** |
| Instance id | `src/main/instance.js` → `getInstanceId()` | UUID persisted to `userData/instance.json`; requires `electron` at module load |
| API settings | `src/main/services/config-service.js:1326` → `getApiSettings()` | `{ baseUrl, key, organizationId, locationId }`; `OH_API_BASE_URL` is hardcoded at line 7 |
| Artwork download | `src/main/services/s3-artwork-downloader.js:735` | `_downloadToTmp(file.file_url, …)`; failures push to `result.failed` and attach `err.statusCode` / `err.bodyPreview` |
| Settings field | `src/renderer/index.html:698`, `renderer.js:2171` and `:2274` | `pollingInterval` number input, 10–600 |

---

## M1 — Telemetry headers (Change 5)

Create `src/main/services/ohd-telemetry-headers.js`:

```js
/** Returns { 'X-OHD-Version', 'X-OHD-Instance-ID' }, or {} if unavailable.
 *  Must never throw and must be require-able headless (tests). */
function getOhdTelemetryHeaders() { … }
```

- Resolve the version from `require('electron').app.getVersion()` inside a
  `try`, falling back to `require('../../../package.json').version`, then to
  `null`. Same pattern for `getInstanceId()` — `instance.js` requires `electron`
  at module load, so **lazy-require it inside the function**, in a `try`.
- If either value is missing, omit **both** keys — the server needs the pair.
- Memoise after the first successful resolve.

Wire it into, in this order, so `extraHeaders` from callers still wins:

- `job-service._httpRequest` — spread telemetry **before** `...extraHeaders`.
- `updater._checkIn` — add to the request `options.headers`.
- `presign-service._httpRequest` (`/uploads/presign` and the base-URL probe at
  `presign-service.js:207`) — same ohd-api host, so it should carry them too.

Do **not** touch `orderhub-api-client.js`. That is `/api-webhook` +
`/update-order-status`, a different service; leave its `X-API-Key` contract
alone.

**Tests** → `src/main/services/__tests__/ohd-telemetry-headers.test.js`
1. Returns both keys when version + instance id resolve.
2. Returns `{}` when `getInstanceId` throws.
3. Never throws when `electron` is absent from the require cache.

---

## M2 — Server capability + cadence store (Change 4, part 1)

New `src/main/services/server-capabilities.js`. Single source of truth for what
`/checkin` last told us. Export a live singleton *plus* the class
(`module.exports = { serverCapabilities, ServerCapabilities }`) so tests can
build their own — this repo has both conventions, use the second.

State (persisted to an electron-store named `server-capabilities` so a restart
before the first check-in still behaves correctly):

```js
{
  pollIntervalSeconds:       null,   // null = not advertised
  statusPollIntervalSeconds: null,
  features: { status_batch: false, pending_etag: false,
              presign_expiry: false, status_batch_max: 200 },
  lastCheckinAt: null,
}
```

Methods:

- `updateFromCheckin(data)` — accept only sane values: integers, clamp
  `pollIntervalSeconds` to 10–600 and `statusPollIntervalSeconds` to 30–3600,
  `status_batch_max` to 1–200. **A field absent from the response leaves the
  stored value untouched; a field present but invalid is ignored with a
  `logWarning`.** Returns `true` if the effective poll cadence changed.
- `isEnabled(flag)` — boolean, false for unknown flags.
- `getPollIntervalMs()` — advertised value, else
  `configService.get('pollingInterval') || 60`, ×1000.
- `getStatusPollIntervalMs()` — advertised value ×1000, else `null`
  (meaning "every cycle", i.e. today's behaviour).
- `getStatusBatchMax()` — advertised, else 200.
- `disableFeatureForSession(flag)` — in-memory only, **not persisted**. Used by
  the 404 fallbacks in M3/M5 so one bad server response doesn't stick across
  restarts.

In `updater._checkIn`, after the existing `JSON.parse`, call
`serverCapabilities.updateFromCheckin(data)`. If it returns `true`, call a new
`pollingService.applyServerCadence()` (lazy-require to avoid a load-order
cycle — `polling-service` already requires `config-service`) which clears and
re-creates `this.intervalId` at the new interval **only if `this.isPolling`**.
Log the old and new values at info.

Keep `_checkIn`'s `pollingEnabled` early-return exactly as it is.

**Tests** → `src/main/services/__tests__/server-capabilities.test.js`
1. Absent fields leave defaults; present-and-valid fields are stored.
2. Out-of-range and non-numeric values are ignored, not clamped into nonsense.
3. `getPollIntervalMs` falls back to the config value when unadvertised.
4. `getStatusPollIntervalMs` returns `null` when unadvertised.
5. `disableFeatureForSession` does not survive a fresh instance.
6. `updateFromCheckin` returns `true` only when the poll cadence actually
   changed.

---

## M3 — Batch status polling (Change 1) — the big win

In `job-service.js`:

**Rename** the existing `syncJobStatusFromOH` body to
`_syncJobStatusFromOHPerJob()` — keep it byte-for-byte, including the
`CHUNK_SIZE = 8`, the 400→`_status:'error'` branch and its exact message
string. It is the fallback for older servers.

**Add** `_syncJobStatusFromOHBatch()`:

- Same `ACTIVE_LOCAL_STATUSES` / `TERMINAL_OH_STATUSES` constants — hoist them
  to module scope so both paths share one definition.
- Chunk ids by `Math.min(100, serverCapabilities.getStatusBatchMax())`. Chunks
  run **sequentially**, not concurrently — the whole point is to reduce load.
- `job_ids` must be **strings**: our local `job.id` comes from `apiJob.job_id`
  and is often numeric. Send `String(job.id)`.
- Match responses back by `String(entry.requested_job_id)`. Do **not** assume
  response order matches request order.
- For each `jobs[]` entry: same terminal check as today —
  `TERMINAL_OH_STATUSES.includes((entry.status || '').toLowerCase())` →
  `updateJobLocally(id, { _status: 'completed' })`, increment the counter, log
  `[sync] Job {id} auto-completed from OH status`.
- For each `errors[]` entry, mirror today's single-lookup handling **exactly**:
  - `status === 400` → `_status: 'error'` with the existing message
    `OrderHub no longer recognizes this job (HTTP 400 on status sync) — it may
    have been deleted upstream.`
  - anything else (403/404/5xx) → `logger.logWarning('[sync] Failed to fetch
    job status from OH', { jobId, statusCode })` and leave the job alone.
    **Do not mark 404s as errors** — that is a behaviour change and it would
    strand jobs.
- An id we requested that appears in **neither** `jobs[]` nor `errors[]`: log
  warning, leave alone.
- Request-level failure (`success: false`, or HTTP 4xx/5xx on the endpoint
  itself): log the error and return `0`. **Never mark jobs as errored from a
  request-level failure.**
- HTTP `404` on `/jobs/status-batch` specifically means an older server →
  `serverCapabilities.disableFeatureForSession('status_batch')`, log once at
  warn, and fall through to `_syncJobStatusFromOHPerJob()` for this cycle.

**Dispatcher:**
```js
async syncJobStatusFromOH() {
  return serverCapabilities.isEnabled('status_batch')
    ? this._syncJobStatusFromOHBatch()
    : this._syncJobStatusFromOHPerJob();
}
```
Keep the `syncInProductionFromOH()` alias pointing at the dispatcher.

Keep the `GET /jobs/{id}` helper available for genuine one-off lookups — we are
only removing it from the polling loop.

**Tests** → `src/main/services/__tests__/job-service-status-batch.test.js`
(follow the `require.cache` injection pattern used by the existing
`job-service-*.test.js` files):
1. 250 active jobs → 3 sequential requests at `status_batch_max: 100`, ids
   distributed correctly and sent as strings.
2. `jobs[]` with `status: "Completed"` and `"cancelled"` (mixed case) → both
   collapse to local `_status: 'completed'`; returned count is right.
3. `errors[]` 400 → `_status: 'error'` with the exact legacy message.
4. `errors[]` 404 → warning only, job untouched.
5. Out-of-order `requested_job_id` still maps to the right local job.
6. Numeric local `job.id` matches a string `requested_job_id`.
7. `{ success: false }` → returns 0, no job mutated.
8. Endpoint 404 → feature disabled for session **and** the per-job path runs.
9. `status_batch: false` → per-job path only, zero batch requests.

---

## M4 — Split the status loop onto its own cadence (Change 4, part 2)

In `polling-service.js`:

- Add `this.lastStatusSyncAt = null` to the constructor.
- In `pollJobs()`, wrap the existing `syncJobStatusFromOH()` call:
  ```js
  const statusIntervalMs = serverCapabilities.getStatusPollIntervalMs();
  const due = statusIntervalMs === null
    || this.lastStatusSyncAt === null
    || (Date.now() - this.lastStatusSyncAt) >= statusIntervalMs;
  ```
  When due, run it inside the existing `try/catch` (unchanged — a sync error
  must not take down the cycle) and set `this.lastStatusSyncAt = Date.now()`
  **in a `finally`**, so a failing sync can't spin every cycle.
- `statusIntervalMs === null` ⇒ today's behaviour (every cycle). That is the
  pre-1.4.0 fallback.
- Surface `lastStatusSync` in `getStatus()` alongside `lastCheck`.

Accepted trade-off, already signed off: a job completed in OrderHub can take up
to `status_poll_interval_seconds` (300s) to clear from Awaiting Processing.
Leave a `// TODO` noting that a `forceStatusSyncNext()` hook could be called
after operator actions if that lag proves annoying — do not build it now.

**Tests** → extend `src/main/services/__tests__/polling-*.test.js` or add
`polling-status-cadence.test.js`, with an injected clock:
1. `getStatusPollIntervalMs() === null` → sync runs on every `pollJobs()`.
2. 300s advertised → runs on cycle 1, skipped on cycles 2–5, runs again on 6.
3. A throwing sync still advances `lastStatusSyncAt`.

---

## M5 — Conditional pending poll (Change 2) + presign reuse (Change 3)

These two ship together. They must, because 304 responses are exactly what
makes stale presigned URLs possible.

### 5a. `_httpRequest` must return headers

`job-service._httpRequest` currently resolves `{ statusCode, body }`. Change it
to `{ statusCode, body, headers: res.headers }`. **Grep every call site first**
(`markReceived`, `markInProduction`, `markCompleted`, `syncJobStatusFromOH`,
and the existing tests) and confirm nothing destructures positionally or
asserts on the exact object shape. This is additive but it is the one change in
this brief that touches every API path.

### 5b. ETag state

Add to `JobService`, persisted in the existing `jobs-cache` store so it survives
restarts:

```js
_pendingEtag        // string | null — send verbatim, weak tags included ('W/"…"')
_pendingEtagKey     // `${locationId}|${includeNoArtwork}` — the query it belongs to
_presignExpiresAt   // ISO string | null
_forcePendingRefresh// boolean
```

### 5c. `fetchJobs()` changes

Send `If-None-Match: this._pendingEtag` **only when all of these hold**:

1. `serverCapabilities.isEnabled('pending_etag')`
2. `this._pendingEtag` is set
3. `this._pendingEtagKey` equals the current query key (location id or
   `include_no_artwork` changed ⇒ drop the stored etag, force a 200)
4. `this._forcePendingRefresh` is false
5. **The presign window is not near expiry** — `_presignExpiresAt` exists and
   `Date.parse(_presignExpiresAt) - Date.now() > PRESIGN_SAFETY_MS`, with
   `const PRESIGN_SAFETY_MS = 5 * 60 * 1000`. A 1-hour TTL and a 60s poll means
   we force a genuine 200 roughly once an hour. That is the intended cost.

Handle `304`:
- **Do not** `JSON.parse` the body — it is empty.
- **Do not** touch `this.jobs`, and do not clear or reset anything.
- **Do** update `this.lastFetchTime` and persist, so the UI's "last checked"
  stays honest.
- **Do** re-derive the hold flags over the cached jobs before returning:
  ```js
  const ctx = { routingHeldProcesses: _getRoutingHeldProcesses() };
  this.jobs = this.jobs.map(j => { const hold = computeHoldForReview(j, ctx);
    return { ...j, ...hold, _holdReasonsText: formatHoldReasons(hold._holdReasons) }; });
  ```
  This matters: routing holds are configured **locally**, and today they are
  re-derived on every poll inside `_mergeJobs`. Without this, an operator's
  routing change would appear to do nothing until the next 200. Do not skip it.
- Refresh `this._pendingEtag` from the `ETag` response header if present (the
  server may re-issue it).
- Log at info, compactly — this fires every 60s: `Jobs unchanged (304)`.

Handle `200`: existing path, plus store `data.etag` (or the `ETag` header —
prefer the header, fall back to the body field), the current query key,
`data.presign_expires_at`, and clear `_forcePendingRefresh`.

Handle anything else: leave the etag alone and take the existing warn path.

### 5d. Force-refresh on download failure

In `polling-service.pollJobs()`, where `s3ArtworkDownloader.downloadJobArtwork`
is called: if the returned `result.failed` is non-empty, call a new
`jobService.invalidatePendingEtag()` which sets `_forcePendingRefresh = true`.
Next cycle then fetches fresh signed URLs unconditionally. Cheap, and it means
an expired-URL failure self-heals within one cycle instead of waiting for the
presign window.

Do not change `s3-artwork-downloader.js` itself. It already surfaces
`statusCode` / `bodyPreview` on failures; the trigger belongs in the caller.

**Tests** → `src/main/services/__tests__/job-service-pending-etag.test.js`
1. First fetch sends no `If-None-Match`; stores etag + `presign_expires_at`.
2. Second fetch sends the stored etag verbatim, weak prefix intact.
3. `304` → jobs array identity/content preserved, `lastFetchTime` advanced, no
   `JSON.parse` of an empty body.
4. `304` → hold flags re-derived (change the routing-held set between polls and
   assert `_holdForReview` flips).
5. `presign_expires_at` inside the safety margin → no `If-None-Match` sent.
6. `locationId` change → etag dropped, full 200 requested.
7. `invalidatePendingEtag()` → next fetch omits `If-None-Match`, then resumes.
8. `pending_etag: false` → never sends the header at all.
9. A 500 leaves the stored etag intact.

---

## M6 — Settings shows who owns the poll interval

Decision made: **the server value wins, and the UI must say so** — otherwise an
operator edits the field, sees no effect, and files a bug.

- Add IPC `ohd:server:get-capabilities` in `ipc-handlers.js` returning the
  `serverCapabilities` snapshot. Register it in `src/preload/preload.js` (the
  renderer never touches `ipcRenderer` directly).
- `renderer.js:2171` (`loadSettings` path): after setting
  `pollingInterval.value`, call the new IPC. When
  `pollIntervalSeconds !== null`: set the input's value to the server number,
  set `readOnly = true`, add whatever muted class the settings CSS already uses
  for disabled fields, and rewrite the `.field-hint` under it to
  `Set centrally by OrderHub (Ns). Contact Pixfizz to change it.`
  When it is `null`, leave today's behaviour untouched.
- `renderer.js:2274` (save path): keep sending `pollingInterval` as-is. It stays
  the offline fallback and `config-service`'s 10–600 validation still applies.
  Do not add a second source of truth.

`renderer.js` and `index.html` are loaded directly — **no build step**. If you
end up touching anything under `src/renderer/views/*.jsx`, you must run
`npm run build:renderer` and commit the regenerated bundle as its own
`chore(build):` commit. You should not need to here.

---

## M7 — Docs

- `CHANGELOG.md` — one entry covering all five changes, written from `git log`.
- `docs/integrations/ohd-api-efficiency.md` — new. Cover: what each feature flag
  gates, the fallback behaviour against a pre-1.4.0 server, the
  `PRESIGN_SAFETY_MS` reasoning, and the 300s status-lag trade-off so the next
  person doesn't "fix" it.
- Do **not** bump the version or touch `electron-builder.yml`. I'll handle the
  release separately per `docs/RELEASE.md`.

---

## Guardrails — things that will bite you

- **`is_film_development` jobs must never reach** the Jobs grid, auto-print, the
  S3 artwork downloader, or `markReceived`. Guards exist at four layers. The
  batch-status path must not become a fifth way in — it only ever touches
  `_status`, never `markReceived`.
- **`_mergeJobs` retention rules are load-bearing.** Locally-tracked non-pending
  jobs, and `pending` + `_awaitingManifest` jobs, are deliberately kept when
  they fall off `/jobs/pending`. The 304 path bypasses `_mergeJobs` entirely —
  that is correct (nothing changed server-side), but it is exactly why the hold
  re-derive in 5c is mandatory.
- **Do not touch `jobDownloadService.checkLocalFiles`.** It returns
  `found === hasFiles` (not `hasFiles && hasManifest`) on purpose. Changing that
  equality breaks auto-print.
- **The awaiting-manifest escalation loop** in `pollJobs` reads from the local
  cache and is unaffected by 304s. Verify that in a test rather than assuming.
- **`_checkIn`'s `pollingEnabled` early-return stays.** Upload-only PCs must not
  register as online instances.
- **Line endings**: `.gitattributes` forces `eol=lf`. If files look modified with
  no visible change, check `git diff --ignore-cr-at-eol` before believing it.
- **Tests must live inside one of the five globs in `package.json`** or they
  will never run. `node:test` + `node:assert/strict`, no framework.
- Working tree is clean except two untracked docs
  (`docs/macos-port-feasibility.md`, `docs/signing-and-autoupdate-plan.md`).
  Leave them alone.

## Verification checklist (I will run these)

1. `GET /jobs/{id}` responses unchanged vs the previous build — regression-
   compare one job.
2. A second `/jobs/pending` poll with no data change returns 304, and the UI
   shows **no flicker and no list reset**.
3. A job whose status changes in OrderHub still surfaces within one
   `status_poll_interval_seconds`.
4. Cancelled / unknown ids appear in `errors[]` and are handled exactly as
   before — 400 marks error, 404 warns only.
5. An artwork download that fails on an expired URL recovers on the next cycle.
6. Changing a routing hold in Settings takes effect on the next poll even when
   that poll returns 304.
7. `GET /` on the API reports `"version": "1.4.0"`.
8. Force `features` all-false and confirm the app behaves exactly as it does
   today.

Start with M1. Show me the diff before committing each milestone.
