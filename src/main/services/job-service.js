const https = require('https');
const http = require('http');
const Store = require('electron-store');
const configService = require('./config-service');
const logger = require('./logger');

const jobStore = new Store({
  name: 'jobs-cache',
  defaults: { jobs: [], lastFetchTime: null }
});

class JobService {
  constructor() {
    // Load persisted jobs from disk
    this.jobs = jobStore.get('jobs') || [];
    this.lastFetchTime = jobStore.get('lastFetchTime') || null;
    logger.info('JobService: loaded persisted jobs', { count: this.jobs.length });
  }

  /**
   * Persist current jobs array to disk
   */
  _persistJobs() {
    jobStore.set('jobs', this.jobs);
    jobStore.set('lastFetchTime', this.lastFetchTime);
  }

  /**
   * Fetch pending jobs from OrderHub API
   * GET {baseUrl}/jobs/pending
   */
  async fetchJobs() {
    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();

    if (!apiKey) {
      logger.logWarning('Cannot fetch jobs: API key not configured');
      return this.jobs;
    }

    try {
      const fullUrl = baseUrl + '/jobs/pending';
      logger.info('Fetching pending jobs from API', { url: fullUrl });

      const extraHeaders = {};
      if (organizationId) extraHeaders['X-Organization-ID'] = organizationId;
      if (locationId) extraHeaders['X-Location-ID'] = locationId;

      const response = await this._httpRequest('GET', fullUrl, apiKey, null, extraHeaders);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const data = JSON.parse(response.body);
        const apiJobs = data.jobs || [];

        // Map API fields to internal format and merge with existing local state
        const mappedJobs = apiJobs.map(apiJob => this._mapApiJob(apiJob));

        // Filter jobs by location: only accept jobs whose locations array includes our locationId
        const filteredJobs = this._filterByLocation(mappedJobs, locationId);

        // Merge: keep local _status for jobs we've already processed
        this.jobs = this._mergeJobs(filteredJobs);
        this.lastFetchTime = Date.now();
        this._persistJobs();
        logger.info('Jobs fetched successfully', { total: mappedJobs.length, afterLocationFilter: filteredJobs.length });
      } else {
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
  _mapApiJob(apiJob) {
    return {
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
      notes: apiJob.notes || '',
      order_notes: apiJob.order_notes || '',
      is_rush: Boolean(apiJob.is_rush),
      production_notes: apiJob.production_notes || '',
      artwork_files: apiJob.artwork_files || [],
      locations: apiJob.locations || [],

      // OHD-managed status (not from API)
      _status: 'pending'
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
      return { ...newJob, ...preserved };
    });

    // Keep locally-tracked jobs that are no longer returned by API
    // (e.g. received/in_production jobs that OH no longer lists as pending)
    for (const existing of this.jobs) {
      if (!newJobIds.has(existing.id) && existing._status && existing._status !== 'pending') {
        merged.push(existing);
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
   * Get locally cached jobs
   */
  getLocalJobs() {
    return {
      jobs: this.jobs,
      lastFetchTime: this.lastFetchTime
    };
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
    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();
    if (!apiKey) return 0;

    const ACTIVE_LOCAL_STATUSES = ['in_production', 'received', 'pending'];
    const TERMINAL_OH_STATUSES  = ['completed', 'cancelled'];
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
            resolve({ statusCode: res.statusCode, body: data });
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

module.exports = new JobService();
