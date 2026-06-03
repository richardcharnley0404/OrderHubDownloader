# AI Quality Review API — Spec

Status: Draft for OrderHub server-side implementation
Owner: Richard / Pixfizz
Last updated: 2026-05-01

## Purpose

When OrderHub Desktop (OHD) finishes scoring a job through the AI Quality Gate,
it should send a summary of the scoring run back to OrderHub so an operator
working in OrderHub (rather than at the OHD-equipped print station) can see at
a glance whether a job has a potential quality problem and decide what to do
about it.

This is **alert-grade** information, not a full audit log. The summary is
intended to surface "this job has images that scored below the configured
threshold" so it can be flagged in the OrderHub UI. Per-image detail
(filenames, individual scores, model version, operator notes) lives in OHD
sidecars and is intentionally **not** sent in this payload.

Film Review (Mode 2) QC is out of scope for v1 — this spec covers the AI
Quality Gate (print dispatch QC) only.

---

## Endpoint

```
POST {baseUrl}/jobs/{jobId}/quality-review
```

`baseUrl` is the existing OHD API base
(`https://nazkcvruighrhpgcarxg.supabase.co/functions/v1/ohd-api`).
`jobId` is the OrderHub job ID — same value OHD already uses for
`/jobs/{jobId}/received`, `/jobs/{jobId}/in-production`,
`/jobs/{jobId}/completed`.

### Headers

Identical to the existing `/jobs/{jobId}/...` family, no new auth required:

```
Authorization: Bearer {orderhubApiKey}
Content-Type: application/json
Accept: application/json
X-Organization-ID: {organizationId}    (when configured)
X-Location-ID: {locationId}            (when configured)
```

### Request body

```json
{
  "event": "scored" | "operator_released" | "operator_image_approved",
  "timestamp": "2026-05-01T12:34:56.000Z",
  "mode": "warn" | "block",
  "threshold": 50,
  "held": true,
  "summary": {
    "total": 24,
    "passed": 22,
    "failed": 2,
    "averageScore": 71.4,
    "lowestScore": 38
  }
}
```

**Field semantics:**

- `event` — what triggered the call:
  - `scored` — fresh scoring run completed (the common case)
  - `operator_released` — operator clicked "Release job" in OHD, overriding a hold
  - `operator_image_approved` — operator approved a single sub-threshold image (job may still be held if other images are unresolved)
- `timestamp` — ISO 8601, UTC, when the event occurred in OHD
- `mode` — value of `aiQualityMode` config at scoring time (`warn` or `block`). In `warn` mode `held` will always be false; `block` mode is the only mode that actually pauses dispatch.
- `threshold` — the score floor used for pass/fail (default 50, range 1–100)
- `held` — whether the job is currently held from auto-print routing in OHD as a result of this evaluation. `false` means OHD will route this job; `true` means it is parked waiting for operator action.
- `summary.total` — total images in the job that were considered for scoring (already-scored images skipped during this run still count toward total)
- `summary.passed` — count of images at-or-above threshold
- `summary.failed` — count of images below threshold
- `summary.averageScore` — arithmetic mean of MUSIQ scores across all scored images, rounded to one decimal place. Range 1–100.
- `summary.lowestScore` — single lowest MUSIQ score across all scored images. Range 1–100.

**Notes on optional/missing fields:**

- If scoring produced no usable scores at all (e.g. job had zero images, or every image errored out), `averageScore` and `lowestScore` MAY be omitted. `total`/`passed`/`failed` are always present.
- Errors during scoring (e.g. one corrupt image among many) are not surfaced in this payload. A job with 23 successful scores and 1 error reports `total: 24, passed+failed: 23` — OrderHub should not assume `passed + failed === total`.

### Response

```json
{ "ok": true }
```

- **200** — accepted. Body is parsed but content is ignored by OHD; an empty `{}` is also acceptable.
- **4xx** — OHD logs and gives up. Will not retry. Will not block routing on this.
- **5xx** — OHD logs and gives up. Will not retry in v1. (Retry/backoff is a possible v2 enhancement; see "Open questions" below.)

In all error cases OHD must continue to function normally — the QC outcome itself is already persisted locally in the sidecar regardless of API success.

---

## Trigger semantics (when OHD fires this call)

OHD calls this endpoint at three points:

1. **End of `scoreJob()`** in `src/main/services/ai-job-quality-orchestrator.js`, after the per-image sidecars have been written and `held` has been derived. Fires for every scored job, whether passed or held, in either `warn` or `block` mode. `event = "scored"`.

2. **End of `releaseJob()`** in the same file (called from the `aiQuality:releaseJob` IPC handler at `ipc-handlers.js:2738`). Fires after the operator's bulk override clears the hold. `event = "operator_released"`. The summary reflects the post-override state, so `held` should be `false`.

3. **End of `approveImage()`** in the same file (called from `aiQuality:approveImage` at `ipc-handlers.js:2762`). Fires after a single-image approval. `event = "operator_image_approved"`. `held` reflects whether other unresolved sub-threshold images still hold the job.

All three calls are **fire-and-forget** from OHD's perspective:

- Wrapped in try/catch
- Logged at error level on failure
- Never blocks the surrounding workflow (printing, dispatch, S3 upload, etc.)
- No retry loop in v1

This mirrors the existing pattern in `print-service._markCompleted()` /
`_markInProduction()` — the job-lifecycle calls already follow exactly this
contract.

---

## Where the data comes from in OHD

For traceability, the source of each summary field in the OHD codebase:

| Field | Source |
|---|---|
| `mode` | `configService.get('aiQualityMode')` |
| `threshold` | `configService.get('aiQualityThreshold')` |
| `held` | computed in `scoreJob()` as `(mode === 'block') && qualityHeld` |
| `summary.total` | `imageFilenames.length` from `_scanJobImages(jobPath)` |
| `summary.passed` / `failed` | tallied during scoring loop in `scoreJob()` |
| `summary.averageScore` | **NEW** — needs to be computed by reading `finalRows` after the scoring loop and averaging `aiQuality.score` across all scored entries |
| `summary.lowestScore` | **NEW** — `Math.min(...scores)` across the same set |

The existing `summary` object returned by `scoreJob()` already contains
`scored`, `passed`, `failed`, `total`, `threshold`, `mode`, `qualityHeld`,
`subThreshold`, `elapsedMs`, `errors`. The OHD-side change is small:

- Add `averageScore` and `lowestScore` to that summary object so the existing
  shape stays consistent with what the sidecar can produce on demand.
- Build the API payload from the summary plus event/timestamp.

---

## What OrderHub should do with this

(Non-binding — final UX is OrderHub's call. Listed here so the data shape can be sanity-checked against intended use.)

Recommended persistence model:

- One row per call, keyed by `(jobId, event, timestamp)` — keeps history of state transitions, since the same job can produce multiple events as the operator works through it.
- Materialise a `current_quality_status` view on the job: latest event, latest summary, `held` flag.

Recommended UI:

- Job list / order list: badge or icon when `held === true`. Optional secondary indicator when `held === false` but `failed > 0` (warn-mode case — passed dispatch but had sub-threshold frames).
- Job detail: show the latest summary line — e.g. "AI Quality: 22/24 passed, lowest 38, avg 71. Held for review." plus event history.
- No need to fetch per-image detail from OHD — that lives in the OHD sidecar and surfaces in the OHD Quality Review tab.

---

## Out of scope (v1)

- **Film Review** (Mode 2 scan QC). Different endpoint, different payload, will be specced separately if/when needed.
- **DPOF accepted/failed** (PW-001). Same architectural pattern, will follow once this lands.
- **Retry / outbox queue** for transient API failures. v1 is fire-and-forget. If field experience shows we lose meaningful events to flaky network conditions, v2 can add a small persistent outbox.
- **Per-image detail in the payload.** Deliberate — alert-grade only.
- **Authentication of operator identity.** OHD does not currently track which operator pressed "Release"; the call is tied to the OHD instance via `instance_id` (already in the check-in flow) and the location/org headers. If OrderHub needs operator-identity attribution, that requires a separate auth/identity story in OHD first.

---

## Open questions

1. **Should `event="scored"` fire for every scored job or only when held / when there are failures?** Firing every time gives OrderHub a complete record (and lets it show "AI Quality: 24/24 passed" as a positive signal). Firing only on hold/failure halves the traffic but makes "no signal" ambiguous (OHD didn't run, vs. ran clean). Default in this spec: fire every time. Cheap to implement either way — flag for confirmation before OHD-side code.

2. **Should `warn`-mode runs that produced sub-threshold images send the call?** Currently yes (mode is in the payload). OrderHub can choose to display them differently. Confirm.

3. **`averageScore` rounding precision.** Spec says one decimal. If OrderHub is going to format the value itself, OHD could send the raw float — let me know which you prefer.

4. **Job vs Order granularity.** OHD calls these "jobs" (matching the existing `/jobs/{id}/...` endpoints). Confirm OrderHub uses the same term/ID space for the new endpoint.

---

## Implementation sequence

Once this spec is agreed:

1. **OrderHub side** (you):
   - Add the new endpoint handler.
   - Persist payloads (table or view of choice).
   - Wire the badge/indicator into the UI.

2. **OHD side** (next conversation):
   - Add `averageScore` / `lowestScore` to the orchestrator summary.
   - Add a small `api-client.js` (or inline if you want to keep scope tight — see the comms investigation note about per-service `_httpRequest` proliferation).
   - Add the three call sites in `ai-job-quality-orchestrator.js`.
   - Manual test against staging OrderHub before release.
