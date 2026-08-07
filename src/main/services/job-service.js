const https = require('https');
const http = require('http');
const Store = require('electron-store');
const configService = require('./config-service');
const logger = require('./logger');
const { getOhdTelemetryHeaders } = require('./ohd-telemetry-headers');
const { computeHoldForReview, formatHoldReasons } = require('../../shared/holdForReview');
const { recoverManifestErrors } = require('../../shared/manifestErrorRecovery');
// Lazy require — routing-service requires electron-store at module load; lazy
// keeps job-service test-loadable in environments that shim electron later.
function _getRoutingHeldProcesses() {
  try {
    return require('./routing-service').getRoutingHeldProcesses();
  } catch (_e) {
    return new Set();
  }
}

// Tenant date-format enum used by the renderer's formatDueDate helper.
// OrderHub's /jobs/pending returns this at response level (e.g. "MDY"),
// not per-job. We normalise here so a stray casing/whitespace from the API
// can't silently make the renderer fall through to its DMY default.
// Returns null for unknown values — the renderer's switch then takes its
// own DMY fallback.
const _DATE_FORMAT_ENUM = new Set(['DMY', 'YMD', 'MDY']);
function _normaliseDateFormat(raw) {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  return _DATE_FORMAT_ENUM.has(upper) ? upper : null;
}

const jobStore = new Store({
  name: 'jobs-cache',
  defaults: { jobs: [], lastFetchTime: null }
});

// Local statuses we ask OrderHub about on every sync cycle. See the doc
// comment on syncJobStatusFromOH for why the set is broader than
// in_production alone. Shared between the per-job and status-batch paths.
const ACTIVE_LOCAL_STATUSES = ['in_production', 'received', 'pending'];

// OrderHub statuses that collapse to local _status='completed' — from
// OHD's perspective either terminal state means "OH is done with this job".
const TERMINAL_OH_STATUSES = ['completed', 'cancelled'];

// A stored /jobs/pending ETag is only reusable against the same query.
// includeNoArtwork isn't currently sent by OHD, but the server's ETag
// covers it — so the key format is forward-compatible for the day it
// starts being sent. Same rationale for X-Location-ID: switching the
// operator's location must invalidate the etag.
function _pendingEtagKeyFor(locationId, includeNoArtwork = false) {
  return `${locationId || ''}|${includeNoArtwork ? 'true' : 'false'}`;
}

// Presigned URLs in /jobs/pending have a 1-hour TTL. Force a genuine 200
// while at least this much time is still on the clock so a 304 never
// leaves us holding URLs that expire mid-download. With a 60s poll cycle,
// that costs us roughly one full body per hour — the intended trade-off.
const PRESIGN_SAFETY_MS = 5 * 60 * 1000;

class JobService {
  constructor() {
    // Load persisted jobs from disk
    this.jobs = jobStore.get('jobs') || [];
    this.lastFetchTime = jobStore.get('lastFetchTime') || null;
    // M5: conditional /jobs/pending state. Persisted so a restart before
    // the next full 200 still knows what to send as If-None-Match.
    // _pendingEtag is sent verbatim, weak prefix (`W/"..."`) included.
    // _pendingEtagKey pins the etag to the query it was issued against
    // (locationId + includeNoArtwork) — a query-key change drops the
    // stored etag on the next fetch.
    // _presignExpiresAt gates conditional requests off before the URLs
    // go stale (see PRESIGN_SAFETY_MS above).
    // _forcePendingRefresh is set by invalidatePendingEtag() when an
    // artwork download fails on a presumed-expired URL, so the next
    // fetch omits If-None-Match and gets fresh URLs unconditionally.
    this._pendingEtag         = jobStore.get('pendingEtag',         null);
    this._pendingEtagKey      = jobStore.get('pendingEtagKey',      null);
    this._presignExpiresAt    = jobStore.get('presignExpiresAt',    null);
    this._forcePendingRefresh = jobStore.get('forcePendingRefresh', false);
    logger.info('JobService: loaded persisted jobs', { count: this.jobs.length });

    // Startup self-heal: reset sticky "Order manifest not found" errors to
    // 'pending' so they re-dispatch now the manifest has (almost certainly)
    // landed. Clears the backlog accumulated on pre-fix builds the moment the
    // updated app launches. Safe to run every launch — see
    // src/shared/manifestErrorRecovery.js for the rationale and the error
    // classes it deliberately leaves terminal.
    try {
      const recovered = recoverManifestErrors(this.jobs);
      if (recovered > 0) {
        this._persistJobs();
        logger.info(`JobService: reset ${recovered} sticky manifest-not-found job(s) to pending for automatic re-attempt`);
      }
    } catch (err) {
      logger.logError('JobService: manifest-error startup recovery failed', err);
    }
  }

  /**
   * Persist current jobs array + M5 conditional-fetch state to disk
   */
  _persistJobs() {
    jobStore.set('jobs', this.jobs);
    jobStore.set('lastFetchTime', this.lastFetchTime);
    jobStore.set('pendingEtag',         this._pendingEtag);
    jobStore.set('pendingEtagKey',      this._pendingEtagKey);
    jobStore.set('presignExpiresAt',    this._presignExpiresAt);
    jobStore.set('forcePendingRefresh', this._forcePendingRefresh);
  }

  /**
   * Called by polling-service when an artwork download fails on what
   * looks like an expired presigned URL. Guarantees the next fetchJobs
   * omits If-None-Match, so we get a fresh 200 with new URLs on the very
   * next cycle instead of waiting for the presign safety window.
   */
  invalidatePendingEtag() {
    this._forcePendingRefresh = true;
    this._persistJobs();
  }

  /**
   * Fetch pending jobs from OrderHub API
   * GET {baseUrl}/jobs/pending
   *
   * M5 / ohd-api v1.4.0: sends If-None-Match with the stored ETag when
   * the server has advertised `features.pending_etag` AND we still have
   * a fresh presign window AND the current query hasn't changed AND we
   * haven't been asked to force a refresh. On 304 we do not touch the
   * cached jobs array — we only advance lastFetchTime and re-derive the
   * hold flags (routing holds are locally configured and change out-of-
   * band; without re-deriving them here, operator hold changes would
   * appear to do nothing until the next 200).
   */
  async fetchJobs() {
    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();

    if (!apiKey) {
      logger.logWarning('Cannot fetch jobs: API key not configured');
      return this.jobs;
    }

    const { serverCapabilities } = require('./server-capabilities');

    try {
      const fullUrl = baseUrl + '/jobs/pending';

      const extraHeaders = {};
      if (organizationId) extraHeaders['X-Organization-ID'] = organizationId;
      if (locationId)     extraHeaders['X-Location-ID']     = locationId;

      // Drop the stored etag if it belongs to a different query — a
      // location change would otherwise 304 against a set the operator
      // no longer wants.
      const currentKey = _pendingEtagKeyFor(locationId);
      if (this._pendingEtag && this._pendingEtagKey !== currentKey) {
        this._pendingEtag    = null;
        this._pendingEtagKey = null;
      }

      // Decide whether to send If-None-Match. All gates must hold.
      const presignFresh = this._presignExpiresAt
        && (Date.parse(this._presignExpiresAt) - Date.now() > PRESIGN_SAFETY_MS);
      const conditionalOk = serverCapabilities.isEnabled('pending_etag')
        && this._pendingEtag
        && !this._forcePendingRefresh
        && presignFresh;
      if (conditionalOk) {
        extraHeaders['If-None-Match'] = this._pendingEtag;
      }

      logger.info('Fetching pending jobs from API', { url: fullUrl, conditional: conditionalOk });

      const response = await this._httpRequest('GET', fullUrl, apiKey, null, extraHeaders);

      if (response.statusCode === 304) {
        // Empty body — do NOT JSON.parse. Do NOT touch this.jobs, and do
        // not clear or reset anything.
        // DO advance lastFetchTime so the UI's "last checked" stays honest.
        this.lastFetchTime = Date.now();

        // Re-derive hold flags over the cached jobs. On the 200 path this
        // happens inside _mergeJobs; on 304 that path is bypassed, but
        // routing holds are configured LOCALLY and can change between
        // polls, so we must re-derive them here or the operator's hold
        // changes would silently no-op until the next 200.
        const routingHeldProcesses = _getRoutingHeldProcesses();
        const ctx = { routingHeldProcesses };
        this.jobs = this.jobs.map(j => {
          const hold = computeHoldForReview(j, ctx);
          return { ...j, ...hold, _holdReasonsText: formatHoldReasons(hold._holdReasons) };
        });

        // Server may re-issue the etag on 304 — pick it up if so.
        const newEtag = response.headers && (response.headers.etag || response.headers.ETag);
        if (newEtag) {
          this._pendingEtag    = newEtag;
          this._pendingEtagKey = currentKey;
        }

        this._persistJobs();
        logger.info('Jobs unchanged (304)');
        return this.jobs;
      }

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const data = JSON.parse(response.body);
        const apiJobs = data.jobs || [];

        // Map API fields to internal format and merge with existing local state.
        // Read the routing-hold set ONCE per poll so the per-job mapper doesn't
        // re-hit electron-store N times.
        const routingHeldProcesses = _getRoutingHeldProcesses();
        // date_format is response-level (tenant locale) — not per-job. Stamp it
        // onto every mapped job so the renderer's formatDueDate(date, fmt)
        // can render dates without needing access to the raw response.
        const dateFormat = _normaliseDateFormat(data.date_format);
        const mappedJobs = apiJobs.map(apiJob => this._mapApiJob(apiJob, { routingHeldProcesses, dateFormat }));

        // Filter jobs by location: only accept jobs whose locations array includes our locationId
        const filteredJobs = this._filterByLocation(mappedJobs, locationId);

        // Merge: keep local _status for jobs we've already processed
        this.jobs = this._mergeJobs(filteredJobs);
        this.lastFetchTime = Date.now();

        // M5: capture the ETag (prefer header, fall back to body field)
        // and the presign expiry. Reset the force-refresh flag — we just
        // took the full body, so whatever prompted the force is resolved.
        const etagFromHeader = response.headers && (response.headers.etag || response.headers.ETag);
        const etagFromBody   = typeof data.etag === 'string' ? data.etag : null;
        const newEtag        = etagFromHeader || etagFromBody || null;
        this._pendingEtag         = newEtag;
        this._pendingEtagKey      = newEtag ? currentKey : null;
        this._presignExpiresAt    = typeof data.presign_expires_at === 'string' ? data.presign_expires_at : null;
        this._forcePendingRefresh = false;

        this._persistJobs();
        logger.info('Jobs fetched successfully', { total: mappedJobs.length, afterLocationFilter: filteredJobs.length });
      } else {
        // Do NOT clear the stored etag — a transient 5xx shouldn't force
        // a full body on the next cycle.
        logger.logWarning('Failed to fetch jobs', {
          statusCode: response.statusCode,
          body: response.body.substring(0, 200)
        });
      }

      return this.jobs;
    } catch (error) {
      logger.logError('Error fetching jobs from API', error);
      return this.jobs;
    }
  }

  /**
   * Filter jobs by location ID.
   * Only keeps jobs whose `locations` array includes the configured locationId.
   * Jobs with an empty/missing locations array are skipped (logged as warning).
   */
  _filterByLocation(jobs, locationId) {
    if (!locationId) {
      // No location configured — accept all jobs (shouldn't happen if validation enforces it)
      return jobs;
    }

    const accepted = [];
    const skipped = [];

    for (const job of jobs) {
      if (Array.isArray(job.locations) && job.locations.includes(locationId)) {
        accepted.push(job);
      } else {
        skipped.push({ id: job.id, order_number: job.order_number, locations: job.locations });
      }
    }

    if (skipped.length > 0) {
      logger.info('Jobs filtered out by location', {
        locationId,
        skippedCount: skipped.length,
        skippedJobs: skipped.map(j => j.order_number || j.id)
      });
    }

    return accepted;
  }

  /**
   * Map API job response to internal format
   */
  _mapApiJob(apiJob, ctx = {}) {
    const job = {
      // IDs
      id: apiJob.job_id,
      order_id: apiJob.order_id,
      internal_job_id: apiJob.internal_job_id,
      internal_order_id: apiJob.internal_order_id,
      order_number: apiJob.order_number || '',
      job_name: apiJob.job_name || '',

      // Display fields
      process: apiJob.process || '',           // Workflow/process name (e.g. "Lab", "Prints - Cut Prints")
      category: apiJob.category || '',
      product: apiJob.product_name || '',
      product_code: apiJob.product_code || '',
      quantity: apiJob.quantity || 0,
      options: (apiJob.options || []).map(o => ({  // Normalise { key, value } → { name, value }
        name: o.name || o.key || '',
        value: o.value || ''
      })),
      website: apiJob.website || '',
      customer_name: apiJob.customer_name || '',
      customer_email: apiJob.customer_email || '',
      preview_image_url: apiJob.preview_image_url || null,
      created_at: apiJob.created_at || '',
      artwork_ready_at: apiJob.artwork_ready_at || '',
      due_date: apiJob.due_date || null,
      // Tenant date-format hint (DMY | YMD | MDY). Source is response-level
      // (passed via ctx from fetchJobs), not per-job. Renderer's
      // formatDueDate() switches on this; absent/unrecognised falls back to
      // DMY inside the helper.
      date_format: ctx.dateFormat || null,
      notes: apiJob.notes || '',
      order_notes: apiJob.order_notes || '',
      is_rush: Boolean(apiJob.is_rush),
      production_notes: apiJob.production_notes || '',
      artwork_files: apiJob.artwork_files || [],
      // S3 artwork channel (M1, 2026-05-24). null is the no-op-safe default
      // for legacy responses that don't include the field. 'none' should
      // never appear in practice — OrderHub filters those server-side —
      // but if it does the s3-artwork-downloader logs a contract-drift
      // warning rather than asserting here (the mapper stays pure).
      artwork_source: apiJob.artwork_source || null,
      locations: apiJob.locations || [],

      // Film Development Auto Assignment (2026-07-04). Film-dev jobs are
      // hidden from the operator queue and consumed by the film-scan
      // auto-assign matcher; they never route to a printer, never
      // download artwork, and never get marked received. twin_checks is
      // coerced to string[] because OrderHub sends numerics unquoted.
      is_film_development: Boolean(apiJob.is_film_development),
      twin_checks: Array.isArray(apiJob.twin_checks)
        ? apiJob.twin_checks.map(v => String(v))
        : [],

      // OHD-managed status (not from API)
      _status: 'pending'
    };

    // S3 Artwork Channel M2 (2026-05-24): derive the per-job hold-for-review
    // flag from the API fields above. Recomputed every poll (the inputs —
    // artwork_source, artwork_files[].source, artwork_files[].production_ready
    // — can change between polls as files are uploaded or finalised), so we
    // intentionally do NOT cache on the persistent sidecar. The auto-print
    // dispatcher (ipc-handlers.runAutoPrint) reads `_holdForReview` to skip
    // held jobs; the renderer reads `_holdReasons` for the chip tooltip.
    // Operator-initiated Send-to-Print is unaffected by this gate.
    //
    // `_holdReasonsText` is the pre-formatted, operator-readable tooltip
    // string (semicolon-joined) — derived here so the vanilla renderer.js
    // (no module system → can't import from shared/) doesn't have to
    // duplicate the text mapping. The React Job Review panel could also
    // use the raw `_holdReasons` array.
    // v1.7.8: pass routing-hold context if the caller supplied it. Mapper-side
    // derivation works on apiJob fields only — the per-job _routingHoldReleased
    // flag isn't known at this point (lives in the local cache), so the final
    // re-derive happens in _mergeJobs after preservation. Safe to omit ctx:
    // missing routing context yields the same backward-compatible behaviour
    // as pre-v1.7.8 callers.
    const hold = computeHoldForReview(job, ctx);
    return {
      ...job,
      ...hold,
      _holdReasonsText: formatHoldReasons(hold._holdReasons),
    };
  }

  /**
   * Merge newly fetched jobs with existing local state.
   * - Preserves _status for jobs that have been marked received/in_production locally.
   * - Keeps locally-tracked jobs (received/in_production) even if no longer returned by API.
   */
  _mergeJobs(newJobs) {
    const existingMap = new Map(this.jobs.map(j => [j.id, j]));
    const newJobIds = new Set(newJobs.map(j => j.id));

    // Read routing-hold set once for the whole merge — re-derived per job
    // below so the routing-hold reason is consistent across newly-mapped and
    // kept-local jobs and honours any preserved _routingHoldReleased flag.
    const routingHeldProcesses = _getRoutingHeldProcesses();
    const ctx = { routingHeldProcesses };

    // Map new jobs, preserving local-only fields where appropriate
    const merged = newJobs.map(newJob => {
      const existing = existingMap.get(newJob.id);
      if (!existing) return newJob;
      const preserved = {};
      if (existing._status && existing._status !== 'pending') {
        // Preserve local status (received, in_production, warning, error) —
        // don't overwrite with 'pending'. The accompanying explanatory message
        // (set alongside the status by polling-service for warning, by
        // print-service / ipc-handlers for error) must be preserved together;
        // without this the renderer's "Unknown warning/error — check Activity
        // Log" fallback takes over from the next poll onward and the operator
        // loses the diagnostic context.
        preserved._status = existing._status;
        if (existing._warningMessage) preserved._warningMessage = existing._warningMessage;
        if (existing._errorMessage)   preserved._errorMessage   = existing._errorMessage;
      }
      if (existing._dpofNotified) {
        // Preserve the DPOF terminal-notification flag so re-fetching from the API
        // does not cause the "Imported" toast to fire again on the next poll cycle.
        preserved._dpofNotified = existing._dpofNotified;
      }
      if (existing._darkroomProSize)  preserved._darkroomProSize  = existing._darkroomProSize;
      if (existing._darkroomProMedia) preserved._darkroomProMedia = existing._darkroomProMedia;
      // v1.7.8: routing-hold release flag + channel-mapping override survive
      // poll cycles. Without preservation the operator's release would be
      // forgotten on the next poll and the hold would re-apply.
      if (existing._routingHoldReleased) preserved._routingHoldReleased = existing._routingHoldReleased;
      if (existing._routingReleasedAt)   preserved._routingReleasedAt   = existing._routingReleasedAt;
      if (existing._routingReleasedTo)   preserved._routingReleasedTo   = existing._routingReleasedTo;
      if (existing._channelMappingOverride) preserved._channelMappingOverride = existing._channelMappingOverride;

      // Re-derive hold AFTER preservation so the routing-hold reason
      // accounts for the merged _routingHoldReleased flag.
      const mergedJob = { ...newJob, ...preserved };
      const hold = computeHoldForReview(mergedJob, ctx);
      return {
        ...mergedJob,
        ...hold,
        _holdReasonsText: formatHoldReasons(hold._holdReasons),
      };
    });

    // Keep locally-tracked jobs that are no longer returned by API
    // (e.g. received/in_production jobs that OH no longer lists as pending).
    //
    // M2 (2026-05-24): for these kept-local jobs we ALSO re-derive
    // `_holdForReview` from the cached artwork_source / artwork_files,
    // because pre-M2 cache entries lack the field entirely. Without this
    // the auto-print hold gate sees `undefined` on legacy-cached manual
    // jobs and dispatches them. Cheap + idempotent (pure function).
    //
    // Awaiting-manifest narrow exception: a job in _status:'pending' that
    // has been stamped _awaitingManifest is also retained. Without this,
    // a job whose API record drops out of /pending-jobs mid-awaiting would
    // vanish from the cache before the polling-service escalation loop in
    // the same pollJobs() tick could fire — leaving the folder + partial
    // manifest on disk with no error trace for the operator.
    //
    // Why unconditional (not "within timeout"): the awaiting state itself
    // is bounded by the polling escalation loop, which flips _status to
    // 'error' once now - _awaitingManifestSince exceeds the threshold.
    // Once escalated, the general rule above retains the job under the
    // sticky-error path. So a pending+awaiting job persists in the cache
    // for at most one polling cycle past its timeout before becoming
    // 'error' — the bound is expressed through the escalation, not
    // through this filter. A merge-side timeout check would silently drop
    // jobs on the first cycle past threshold, never letting the polling
    // loop fire — exactly the silent-vanish behaviour we are fixing.
    for (const existing of this.jobs) {
      if (newJobIds.has(existing.id)) continue;

      const retain = (existing._status && existing._status !== 'pending')
                  || (existing._status === 'pending' && existing._awaitingManifest === true);

      if (retain) {
        const hold = computeHoldForReview(existing, ctx);
        merged.push({
          ...existing,
          ...hold,
          _holdReasonsText: formatHoldReasons(hold._holdReasons),
        });
      }
    }

    return merged;
  }

  /**
   * Mark a job as received by OHD
   * POST {baseUrl}/jobs/{jobId}/received
   */
  async markReceived(jobId, payload) {
    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();

    if (!apiKey) {
      throw new Error('API key not configured');
    }

    try {
      const fullUrl = `${baseUrl}/jobs/${jobId}/received`;
      logger.info('Marking job as received', { jobId, url: fullUrl });

      const extraHeaders = {};
      if (organizationId) extraHeaders['X-Organization-ID'] = organizationId;
      if (locationId) extraHeaders['X-Location-ID'] = locationId;

      const body = {
        timestamp: payload.timestamp || new Date().toISOString(),
        local_path: payload.local_path || '',
        file_count: payload.file_count || 0
      };

      const response = await this._httpRequest('POST', fullUrl, apiKey, body, extraHeaders);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        logger.info('Job marked as received', { jobId });
        this.updateJobLocally(jobId, { _status: 'received' });
        return JSON.parse(response.body);
      } else {
        const respData = JSON.parse(response.body);
        const msg = respData.error || `HTTP ${response.statusCode}`;
        logger.logWarning('Failed to mark job as received', { jobId, msg });

        // If already received, update local status to match
        if (response.statusCode === 400 && msg.includes('already been marked as received')) {
          this.updateJobLocally(jobId, { _status: 'received' });
        }

        throw new Error(msg);
      }
    } catch (error) {
      if (error.message.startsWith('HTTP ') || error.message.includes('already')) throw error;
      logger.logError('Error marking job as received', error, { jobId });
      throw error;
    }
  }

  /**
   * Mark a job as in production
   * POST {baseUrl}/jobs/{jobId}/in-production
   */
  async markInProduction(jobId) {
    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();

    if (!apiKey) {
      throw new Error('API key not configured');
    }

    try {
      const fullUrl = `${baseUrl}/jobs/${jobId}/in-production`;
      logger.info('Marking job as in production', { jobId, url: fullUrl });

      const extraHeaders = {};
      if (organizationId) extraHeaders['X-Organization-ID'] = organizationId;
      if (locationId) extraHeaders['X-Location-ID'] = locationId;

      const body = {
        timestamp: new Date().toISOString()
      };

      const response = await this._httpRequest('POST', fullUrl, apiKey, body, extraHeaders);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        logger.info('Job marked as in production', { jobId });
        this.updateJobLocally(jobId, { _status: 'in_production' });
        return JSON.parse(response.body);
      } else {
        const respData = JSON.parse(response.body);
        const msg = respData.error || `HTTP ${response.statusCode}`;
        logger.logWarning('Failed to mark job as in production', { jobId, msg });
        throw new Error(msg);
      }
    } catch (error) {
      if (error.message.startsWith('HTTP ')) throw error;
      logger.logError('Error marking job as in production', error, { jobId });
      throw error;
    }
  }

  /**
   * Mark a job as completed (printed)
   * POST {baseUrl}/jobs/{jobId}/completed
   */
  async markCompleted(jobId) {
    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();

    if (!apiKey) {
      throw new Error('API key not configured');
    }

    try {
      const fullUrl = `${baseUrl}/jobs/${jobId}/completed`;
      logger.info('Marking job as completed', { jobId, url: fullUrl });

      const extraHeaders = {};
      if (organizationId) extraHeaders['X-Organization-ID'] = organizationId;
      if (locationId) extraHeaders['X-Location-ID'] = locationId;

      const body = {
        timestamp: new Date().toISOString()
      };

      const response = await this._httpRequest('POST', fullUrl, apiKey, body, extraHeaders);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        logger.info('Job marked as completed', { jobId });
        this.updateJobLocally(jobId, { _status: 'completed' });
        return JSON.parse(response.body);
      } else {
        const respData = JSON.parse(response.body);
        const msg = respData.error || `HTTP ${response.statusCode}`;
        logger.logWarning('Failed to mark job as completed', { jobId, msg });

        // If already completed, update local status to match
        if (response.statusCode === 400 && msg.includes('already')) {
          this.updateJobLocally(jobId, { _status: 'completed' });
        }

        throw new Error(msg);
      }
    } catch (error) {
      if (error.message.startsWith('HTTP ') || error.message.includes('already')) throw error;
      logger.logError('Error marking job as completed', error, { jobId });
      throw error;
    }
  }

  /**
   * Get locally cached jobs.
   *
   * Film Development jobs (`is_film_development: true`) are filtered out
   * here — this is the single choke point for `jobs:getAll` and every
   * `jobs:updated` renderer emit, so they never surface in the operator
   * queue. The film-scan auto-assign matcher consumes them via
   * `getFilmDevelopmentJobs()` instead.
   */
  getLocalJobs() {
    return {
      jobs: this.jobs.filter(j => !j || !j.is_film_development),
      lastFetchTime: this.lastFetchTime
    };
  }

  /**
   * Return only Film Development jobs from the local cache. Consumed by
   * the film-scan-auto-assign matcher. Order does not matter; the
   * matcher walks twin_checks per job.
   */
  getFilmDevelopmentJobs() {
    return this.jobs.filter(j => j && j.is_film_development);
  }

  /**
   * Update a job in the local cache
   */
  updateJobLocally(jobId, updates) {
    const index = this.jobs.findIndex(j => j.id === jobId);
    if (index !== -1) {
      this.jobs[index] = { ...this.jobs[index], ...updates };
      this._persistJobs();
    }
  }

  /**
   * Find a job by order number (for folder monitor callbacks)
   */
  findJobByOrderNumber(orderNumber) {
    return this.jobs.find(j => j.order_number === orderNumber);
  }

  /**
   * Find a job by its numeric OH job id. Used by the DPOF FolderMonitor
   * pipeline, which extracts the id from the folder name as a string —
   * Number() coercion at the boundary so it matches the numeric job.id
   * the OrderHub API returns.
   */
  findJobById(jobId) {
    const numeric = Number(jobId);
    if (!Number.isFinite(numeric)) return undefined;
    return this.jobs.find(j => j.id === numeric);
  }

  /**
   * Get jobs with a specific OHD status
   */
  getJobsByStatus(status) {
    return this.jobs.filter(j => j._status === status);
  }

  /**
   * Sync locally-active jobs against the OrderHub API.
   *
   * For each locally-cached job whose _status is one of
   * ACTIVE_LOCAL_STATUSES (see below), fetches the current status from
   * GET /jobs/{jobId}. If OH reports the job as terminal — `completed`
   * or `cancelled` (case-insensitive) — the local _status is updated to
   * 'completed' directly. No POST back to OH; OH already knows.
   *
   * Why three local statuses are checked instead of just `in_production`:
   *   - in_production: jobs OHD itself dispatched (the original sync target)
   *   - received:      jobs OHD downloaded but hasn't sent to print yet —
   *                    covers OH-side completion via another OHD instance,
   *                    a manual mark-complete in the OH UI, or an external
   *                    integration. Without this branch the row stays in
   *                    Awaiting Processing forever (OH stops returning the
   *                    job from /jobs/pending and _mergeJobs deliberately
   *                    keeps locally-tracked received jobs).
   *   - pending:       jobs OHD has queued but artwork hasn't arrived.
   *                    Covers POS / walk-in orders that get cancelled in OH
   *                    before artwork ever syncs down.
   *
   * Both `completed` and `cancelled` collapse to local _status='completed'
   * — from OHD's perspective they're the same terminal state ("OH is done
   * with this job"); the operator doesn't need to act on either, and
   * existing UI already routes _status='completed' to the Processed tab.
   *
   * Requests are chunked (CHUNK_SIZE concurrent) so a busy lab with 50+
   * active jobs doesn't sit through a 5-second sequential roundtrip on
   * every poll cycle. Individual job failures are logged and skipped;
   * they never abort the chunk or the overall loop.
   *
   * @returns {Promise<number>} Count of jobs auto-completed in this run
   */
  async syncJobStatusFromOH() {
    const { serverCapabilities } = require('./server-capabilities');
    return serverCapabilities.isEnabled('status_batch')
      ? this._syncJobStatusFromOHBatch()
      : this._syncJobStatusFromOHPerJob();
  }

  /**
   * Per-job status sync — one GET /jobs/{id} per active job, chunked
   * `CHUNK_SIZE` concurrent. Used against ohd-api servers older than
   * v1.4.0, or as the fallback when a batch call surfaces a 404. Kept
   * byte-for-byte from the original single implementation so behaviour
   * against those older servers stays identical.
   *
   * @returns {Promise<number>} Count of jobs auto-completed in this run
   */
  async _syncJobStatusFromOHPerJob() {
    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();
    if (!apiKey) return 0;

    const CHUNK_SIZE = 8;

    const activeJobs = this.jobs.filter(j => ACTIVE_LOCAL_STATUSES.includes(j._status));
    if (activeJobs.length === 0) return 0;

    const extraHeaders = {};
    if (organizationId) extraHeaders['X-Organization-ID'] = organizationId;
    if (locationId)     extraHeaders['X-Location-ID']     = locationId;

    let autoCompleted = 0;

    for (let i = 0; i < activeJobs.length; i += CHUNK_SIZE) {
      const chunk = activeJobs.slice(i, i + CHUNK_SIZE);
      const results = await Promise.all(chunk.map(async job => {
        try {
          const response = await this._httpRequest(
            'GET', `${baseUrl}/jobs/${job.id}`, apiKey, null, extraHeaders
          );
          if (response.statusCode >= 200 && response.statusCode < 300) {
            const data = JSON.parse(response.body);
            const ohStatus = (data.status || '').toLowerCase();
            if (TERMINAL_OH_STATUSES.includes(ohStatus)) {
              return { jobId: job.id, terminal: true, ohStatus };
            }
          } else if (response.statusCode === 400) {
            // 400 = OrderHub rejects this job id outright (unknown / malformed).
            // Unlike a 5xx or auth failure it will never resolve on retry, so
            // mark the job _status:'error' locally — that drops it out of the
            // ACTIVE_LOCAL_STATUSES filter, stops the every-poll retry loop,
            // and surfaces it in the UI with a reason instead of failing
            // silently in the log forever.
            return {
              jobId: job.id, terminal: false, badRequest: true,
              statusCode: response.statusCode,
            };
          } else {
            logger.logWarning('[sync] Failed to fetch job status from OH', {
              jobId: job.id, statusCode: response.statusCode,
            });
          }
        } catch (err) {
          logger.logWarning('[sync] Error fetching job status from OH — skipping', {
            jobId: job.id, error: err.message,
          });
        }
        return { jobId: job.id, terminal: false };
      }));
      for (const r of results) {
        if (r.terminal) {
          this.updateJobLocally(r.jobId, { _status: 'completed' });
          logger.info(`[sync] Job ${r.jobId} auto-completed from OH status`, { ohStatus: r.ohStatus });
          autoCompleted++;
        } else if (r.badRequest) {
          this.updateJobLocally(r.jobId, {
            _status: 'error',
            _errorMessage: `OrderHub no longer recognizes this job (HTTP ${r.statusCode} on status sync) — it may have been deleted upstream.`,
          });
          logger.logWarning(`[sync] Job ${r.jobId} marked error — OH returned ${r.statusCode} on status sync`);
        }
      }
    }

    return autoCompleted;
  }

  /**
   * Batched status sync — one POST /jobs/status-batch per chunk instead
   * of one GET /jobs/{id} per active job. Enabled when the server
   * advertises `features.status_batch` on /checkin. This is ohd-api
   * v1.4.0's polling-cost reduction (Change 1 in the brief).
   *
   * Behaviour on per-id outcomes mirrors _syncJobStatusFromOHPerJob
   * exactly:
   *   - terminal (Completed / Cancelled, case-insensitive) → local
   *     _status='completed' + counter.
   *   - errors[] with status 400 → local _status='error' with the same
   *     legacy message; 400 will never resolve on retry, so we surface
   *     it in the UI rather than log-loop.
   *   - errors[] with any other status (403/404/5xx) → warning only,
   *     the job is left alone. Do NOT mark 404s as errors — that would
   *     strand transiently-missing jobs.
   *
   * Cross-cutting rules:
   *   - Chunks run sequentially — the whole point is to reduce load.
   *   - job_ids are sent as strings (`String(job.id)`) so numeric local
   *     ids match the server-echoed `requested_job_id`.
   *   - Response order is not assumed to match request order.
   *   - Request-level failure (transport, non-2xx other than 404,
   *     success:false, parse) returns 0 without mutating any job.
   *   - HTTP 404 on the endpoint means an older server: disable the
   *     feature for this session and fall through to the per-job path
   *     for the entire cycle.
   *
   * @returns {Promise<number>} Count of jobs auto-completed in this run
   */
  async _syncJobStatusFromOHBatch() {
    const { serverCapabilities } = require('./server-capabilities');
    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();
    if (!apiKey) return 0;

    const activeJobs = this.jobs.filter(j => ACTIVE_LOCAL_STATUSES.includes(j._status));
    if (activeJobs.length === 0) return 0;

    const extraHeaders = {};
    if (organizationId) extraHeaders['X-Organization-ID'] = organizationId;
    if (locationId)     extraHeaders['X-Location-ID']     = locationId;

    // Cap the chunk size at 100 even if the server allows more; that keeps
    // individual request payload + response object small.
    const chunkSize = Math.min(100, serverCapabilities.getStatusBatchMax());

    // Response order isn't guaranteed to match request order, so look up
    // the matching local job by String(id).
    const jobsByStringId = new Map();
    for (const job of activeJobs) {
      jobsByStringId.set(String(job.id), job);
    }

    let autoCompleted = 0;

    for (let i = 0; i < activeJobs.length; i += chunkSize) {
      const chunk = activeJobs.slice(i, i + chunkSize);
      const jobIds = chunk.map(j => String(j.id));

      let response;
      try {
        response = await this._httpRequest(
          'POST',
          `${baseUrl}/jobs/status-batch`,
          apiKey,
          { job_ids: jobIds },
          extraHeaders,
        );
      } catch (err) {
        logger.logError('[sync] status-batch request failed', err);
        return 0;
      }

      if (response.statusCode === 404) {
        logger.logWarning(
          '[sync] /jobs/status-batch returned 404 — server does not support batch, falling back to per-job for this cycle'
        );
        serverCapabilities.disableFeatureForSession('status_batch');
        return this._syncJobStatusFromOHPerJob();
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        logger.logError(
          `[sync] status-batch failed (HTTP ${response.statusCode})`,
          new Error(response.body ? String(response.body).substring(0, 200) : ''),
        );
        return 0;
      }

      let data;
      try {
        data = JSON.parse(response.body);
      } catch (err) {
        logger.logError('[sync] status-batch response parse failed', err);
        return 0;
      }

      if (data && data.success === false) {
        logger.logError(
          '[sync] status-batch reported success:false',
          new Error(data.error || 'unknown'),
        );
        return 0;
      }

      const responded = new Set();

      for (const entry of Array.isArray(data.jobs) ? data.jobs : []) {
        const requestedId = String(entry.requested_job_id);
        responded.add(requestedId);
        const job = jobsByStringId.get(requestedId);
        if (!job) continue;
        const ohStatus = (entry.status || '').toLowerCase();
        if (TERMINAL_OH_STATUSES.includes(ohStatus)) {
          this.updateJobLocally(job.id, { _status: 'completed' });
          logger.info(`[sync] Job ${job.id} auto-completed from OH status`, { ohStatus });
          autoCompleted++;
        }
      }

      for (const entry of Array.isArray(data.errors) ? data.errors : []) {
        const requestedId = String(entry.requested_job_id);
        responded.add(requestedId);
        const job = jobsByStringId.get(requestedId);
        if (!job) continue;
        if (entry.status === 400) {
          this.updateJobLocally(job.id, {
            _status: 'error',
            _errorMessage: `OrderHub no longer recognizes this job (HTTP ${entry.status} on status sync) — it may have been deleted upstream.`,
          });
          logger.logWarning(`[sync] Job ${job.id} marked error — OH returned ${entry.status} on status sync`);
        } else {
          logger.logWarning('[sync] Failed to fetch job status from OH', {
            jobId: job.id, statusCode: entry.status,
          });
        }
      }

      for (const requestedId of jobIds) {
        if (!responded.has(requestedId)) {
          logger.logWarning('[sync] status-batch response omitted requested job', { jobId: requestedId });
        }
      }
    }

    return autoCompleted;
  }

  /**
   * Backwards-compatible alias for the renamed sync method.
   * Older call sites referenced the in-production-only name; both now
   * resolve to the broader sync. Kept to avoid breaking anything outside
   * src/ that might reach in (smoke tests, ad-hoc scripts).
   */
  async syncInProductionFromOH() {
    return this.syncJobStatusFromOH();
  }

  /**
   * HTTP request helper
   */
  _httpRequest(method, url, apiKey, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      try {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;

        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json',
            ...getOhdTelemetryHeaders(),
            ...extraHeaders
          },
          timeout: 15000
        };

        if (body) {
          const bodyStr = JSON.stringify(body);
          options.headers['Content-Type'] = 'application/json';
          options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const req = protocol.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            // headers exposed so callers can read ETag / other response
            // metadata (M5 / ohd-api v1.4.0 conditional /jobs/pending).
            // Every existing caller reads statusCode + body by property
            // name — none destructure positionally — so adding a third
            // field is additive.
            resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
          });
        });

        req.on('error', (error) => {
          reject(error);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });

        if (body) {
          req.write(JSON.stringify(body));
        }

        req.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}

const jobService = new JobService();
// Test hook — module-scoped helper exposed for unit tests of the date_format
// pass-through path. Production callers go through fetchJobs / _mapApiJob.
jobService._normaliseDateFormat = _normaliseDateFormat;
module.exports = jobService;
