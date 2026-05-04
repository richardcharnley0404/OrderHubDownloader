// ══════════════════════════════════════
// DOM elements
// ══════════════════════════════════════
const form = document.getElementById('settingsForm');
const saveBtn = document.getElementById('saveBtn');
const testApiBtn = document.getElementById('testApiBtn');
const testFtpBtn = document.getElementById('testFtpBtn');
const selectDirBtn = document.getElementById('selectDirBtn');
const testS3Btn = document.getElementById('testS3Btn');
const testLocalBtn = document.getElementById('testLocalBtn');
const testTopazBtn = document.getElementById('testTopazBtn');
const selectFilmScansWatchBtn = document.getElementById('selectFilmScansWatchBtn');
const selectFilmScansStorageBtn = document.getElementById('selectFilmScansStorageBtn');
const selectFileUploadsWatchBtn = document.getElementById('selectFileUploadsWatchBtn');
const selectFileUploadsStorageBtn = document.getElementById('selectFileUploadsStorageBtn');
const selectProcessFolderBtn = document.getElementById('selectProcessFolderBtn');
const printControllersList = document.getElementById('printControllersList');
const addControllerBtn = document.getElementById('addControllerBtn');
const statusMessage = document.getElementById('statusMessage');
const toastNotification = document.getElementById('toastNotification');
const refreshJobsBtn = document.getElementById('refreshJobsBtn');
const jobSearch = document.getElementById('jobSearch');
const jobsTableBody = document.getElementById('jobsTableBody');
const jobsEmptyState = document.getElementById('jobsEmptyState');
const jobsTableWrap = document.querySelector('.jobs-table-wrap');
const jobDateRangeSelect = document.getElementById('jobDateRange');
const dateRangeWarning   = document.getElementById('dateRangeWarning');

// ══════════════════════════════════════
// State
// ══════════════════════════════════════
let allJobs = [];
let currentSort = { field: 'created_at', direction: 'desc' };
let currentFilter = 'awaiting'; // 'all', 'awaiting', 'printed', 'dismissed'
let dismissedJobs = []; // Array of job ID strings
let currentDateRange = 30; // days back to show; 0 = all time
let cachedControllers = []; // For process mapping controller dropdowns
let downloadDirectory = ''; // Kept in sync with saved config — used to compute jobPath for Job Review

// AI Quality Gate (v1.2.0) — populated by refreshAiQualityJobState().
// Two views over the same IPC response:
//   - aiQualityHeldByJobId: jobs with unfixed sub-threshold images
//     (`failedImages > 0`). Drives the red flag-quality badge in the
//     Jobs grid and the click-to-release flow.
//   - aiQualityScoringStatusByJobId: phase per job ('scoring' | 'scored').
//     Drives the action-button gating (Process/Assign/Dismiss disabled
//     while AI Quality is still scoring; re-enabled when phase='scored').
// Both maps are empty when the feature is OFF or the IPC isn't available.
let aiQualityHeldByJobId = new Map();
let aiQualityScoringStatusByJobId = new Map();
// Cached at refresh time so isPendingAIQuality can short-circuit cheaply
// without an IPC roundtrip per row.
let aiQualityEnabledCached = false;
// Mode cached at refresh time. 'warn' = scoring runs and the badge is
// informational only; jobs dispatch even with failed images. 'block' =
// failed images actually hold the job, so the Release button is meaningful.
// Drives the Release-button gate in the FLAGS column — in 'warn' mode there
// is nothing to release and showing the button confuses operators.
let aiQualityModeCached = 'warn';

async function refreshAiQualityJobState() {
  try {
    if (!window.electronAPI || !window.electronAPI.aiQualityListHeldJobs) {
      aiQualityHeldByJobId = new Map();
      aiQualityScoringStatusByJobId = new Map();
      aiQualityEnabledCached = false;
      return;
    }
    // Read the feature flag and mode at refresh time — operators can flip
    // them via the Settings panel without a restart, and we want both the
    // pending-scoring gate AND the Release-button gate to respond to that
    // without a stale-cache window.
    try {
      const cfg = await window.electronAPI.getConfig();
      aiQualityEnabledCached = !!(cfg && cfg.aiQualityEnabled);
      aiQualityModeCached    = (cfg && cfg.aiQualityMode === 'block') ? 'block' : 'warn';
    } catch (_) {
      aiQualityEnabledCached = false;
      aiQualityModeCached    = 'warn';
    }

    const list = await window.electronAPI.aiQualityListHeldJobs();
    const heldNext = new Map();
    const statusNext = new Map();
    (list || []).forEach((row) => {
      const key = String(row.jobId);
      statusNext.set(key, {
        phase: row.phase,
        scoredCount: row.scoredCount,
        totalImages: row.totalImages,
        failedCount: row.failedImages,
      });
      if (row.failedImages > 0) {
        heldNext.set(key, {
          failedImages: row.failedImages,
          totalImages: row.totalImages,
        });
      }
    });
    aiQualityHeldByJobId = heldNext;
    aiQualityScoringStatusByJobId = statusNext;
  } catch (err) {
    console.error('[ai-quality] refresh job state failed', err);
  }
}

// Backwards-compatible alias — older call sites referenced the held-only
// refresh by name. The new implementation populates both maps in one
// IPC roundtrip.
const refreshAiQualityHeldJobs = refreshAiQualityJobState;

/**
 * Returns true when AI Quality is enabled AND the given job is in a
 * status where scoring is still in scope AND scoring hasn't completed.
 * Used to gate Process/Assign/Dismiss buttons in the Jobs grid.
 *
 *   - Feature flag OFF → always false (preserves current behaviour)
 *   - Status not received/pending → false (scoring already happened or
 *     job is past the gate's scope)
 *   - No scoring entry yet (files not local, sidecar not built) → true
 *   - Entry says phase='scoring' → true (partial / no images scored yet)
 *   - Entry says phase='scored' → false (all images have a verdict;
 *     held-state may still be true via a separate map but the gate is done)
 */
function isPendingAIQuality(job) {
  if (!aiQualityEnabledCached) return false;
  if (job._status !== 'received' && job._status !== 'pending') return false;
  const status = aiQualityScoringStatusByJobId.get(String(job.id));
  if (!status) return true;
  return status.phase === 'scoring';
}

/**
 * Stricter sibling of isPendingAIQuality used to gate the Dismiss button.
 *
 * Returns true ONLY when scoring is actively in flight — i.e. a sidecar
 * entry exists and its phase is still 'scoring'. The "no entry yet"
 * branch (files not local, sidecar not built) returns false here, unlike
 * the conservative isPendingAIQuality.
 *
 * Why split the two:
 *   - Process / Assign downstream-act on a job and must wait for scoring
 *     to confirm a verdict — they stay on isPendingAIQuality.
 *   - Dismiss is config-only (store:dismissJob just appends the jobId to
 *     a list — no file or sidecar mutation). The original gate comment
 *     said "dismissing mid-scoring would orphan a sidecar mid-update";
 *     that risk only applies when there IS a sidecar mid-update. POS
 *     orders that arrive in 'pending' status with no artwork never
 *     produce a sidecar at all, so there is nothing to orphan and the
 *     operator must be able to remove the row when the artwork is never
 *     going to come (walk-in customer abandoned the order, etc.).
 */
function isAiQualityScoringInProgress(job) {
  if (!aiQualityEnabledCached) return false;
  if (job._status !== 'received' && job._status !== 'pending') return false;
  const status = aiQualityScoringStatusByJobId.get(String(job.id));
  if (!status) return false;
  return status.phase === 'scoring';
}

// DPOF output-status cache: jobId (string) → { prefix, folderName, folderPath }
// Populated after each table render via async folder scan.
// Prefix meanings: p=Import Error, o=Awaiting Import, q=Failed Import, e=Imported (auto-processed)
const outputStatusCache = new Map();

// Routing cache: jobId (string) → route object from routingService.resolveRoute()
// Populated before each render for all 'received' jobs.
// { type: 'controller'|'process-folder'|'unrouted', reason?, controller? }
const jobRouteCache = new Map();

/**
 * Pre-resolve routes for all 'received' jobs and store in jobRouteCache.
 * Called before renderJobTable so the render stays synchronous.
 * @param {Array} jobs
 */
async function resolveRoutesForReceivedJobs(jobs) {
  // Resolve routes for both 'received' and 'pending' jobs so that the Assign
  // button can appear even before local files have been downloaded.
  const jobsToResolve = jobs.filter(j => j._status === 'received' || j._status === 'pending');
  await Promise.all(jobsToResolve.map(async job => {
    try {
      const route = await window.electronAPI.routingResolve(job);
      jobRouteCache.set(String(job.id), route);
    } catch (_) { /* ignore per-job errors — will fall back to Send to Print */ }
  }));
}

// ══════════════════════════════════════
// Tab visibility (mode-driven)
// ══════════════════════════════════════
//
// Jobs and Film Review are only relevant when their underlying mode is
// enabled in Settings. A site-PC running purely as a film-scan uploader
// (pollingEnabled: false, filmScansEnabled: true) shouldn't see a Jobs
// tab at all — and conversely an order-handling PC with filmScansEnabled
// off shouldn't see Film Review. Settings and Activity Log are always
// visible (Settings because the operator needs it to enable the modes
// in the first place, Activity Log because it's a passive read-only view).
//
// Triggered on:
//   - App startup, immediately after getConfig() resolves
//   - Settings save (saveConfig handler), so toggles take effect without restart
//
// If the active tab gets hidden by a config change, focus is moved to
// the first visible tab so the user isn't left staring at nothing.
function updateTabVisibility(config) {
  const showJobs = !!(config && config.pollingEnabled);
  const showFilm = !!(config && config.filmScansEnabled);

  const jobsTab = document.querySelector('.tab-bar .tab[data-tab="jobs"]');
  const filmTab = document.querySelector('.tab-bar .tab[data-tab="film"]');
  if (jobsTab) jobsTab.style.display = showJobs ? '' : 'none';
  if (filmTab) filmTab.style.display = showFilm ? '' : 'none';

  // If the currently-active tab is now hidden, switch to the first
  // visible tab. Programmatic .click() reuses the existing tab handler,
  // which keeps panel-switching, settings-load side-effects, etc. all in
  // one place — no need to duplicate that logic here.
  const activeTab = document.querySelector('.tab-bar .tab.active');
  if (activeTab && activeTab.style.display === 'none') {
    const firstVisible = Array.from(document.querySelectorAll('.tab-bar .tab'))
      .find(t => t.style.display !== 'none');
    if (firstVisible) firstVisible.click();
  }
}

// ══════════════════════════════════════
// Tab switching (main tabs)
// ══════════════════════════════════════
document.querySelectorAll('.tab-bar .tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.tab-bar .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    // Refresh routing data when returning to Settings so changes made elsewhere
    // (e.g. via the Assign Channel modal on the Jobs tab) are always visible.
    if (tab.dataset.tab === 'settings' && routingLoaded) {
      await loadRoutingSection();
    }
  });
});

// Settings sub-tab switching
document.querySelectorAll('.settings-subtab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-subtab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-subtab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('subtab-' + tab.dataset.subtab).classList.add('active');
  });
});

// ══════════════════════════════════════
// Modal dismiss wiring (.pm-modal-overlay)
// ══════════════════════════════════════
// Wires up backdrop-click, × button, and Escape-key dismiss for every
// modal that uses the .pm-modal-overlay / .pm-modal pattern. The existing
// Cancel/Save button click handlers (e.g. ocCancelBtn, ocSaveBtn) are
// untouched — those add explicit `.hidden` themselves and continue to
// work alongside this helper.
function wirePmModalDismiss() {
  document.querySelectorAll('.pm-modal-overlay').forEach((overlay) => {
    // Backdrop click — only when the overlay itself was the target, not a
    // descendant inside .pm-modal. event.target check is the standard guard.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });

    // × close button (added in HTML alongside each <h3>).
    const closeBtn = overlay.querySelector('.pm-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        overlay.classList.add('hidden');
      });
    }
  });

  // Escape key — close any currently-visible pm-modal.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document
      .querySelectorAll('.pm-modal-overlay:not(.hidden)')
      .forEach((m) => m.classList.add('hidden'));
  });
}

// ══════════════════════════════════════
// Startup
// ══════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  wirePmModalDismiss();

  // ── App version display ──
  try {
    const { version, updateReady } = await window.electronAPI.getAppVersion();
    const versionEl = document.getElementById('appVersion');
    if (versionEl) {
      if (updateReady) {
        versionEl.textContent = `v${version} — 🔄 Update Ready`;
        versionEl.classList.add('update-ready');
      } else {
        versionEl.textContent = `v${version}`;
      }
    }
  } catch (error) {
    console.error('Error getting app version:', error);
  }

  // Load print controllers first (needed for process mapping dropdowns)
  try {
    const controllers = await window.electronAPI.getPrintControllers();
    cachedControllers = controllers;
  } catch (error) {
    console.error('Error loading print controllers:', error);
  }

  try {
    const config = await window.electronAPI.getConfig();
    populateForm(config);
    // Set tab visibility based on which modes are enabled — runs after
    // the config is in hand so the first paint already reflects the
    // operator's deployment shape (Jobs vs Film Review vs both).
    updateTabVisibility(config);
    // One-time toast on first launch after the Replicate→local migration.
    // The flag is set by config-service._migrateReplicateProvider() and
    // cleared via clearReplicateMigrationToast on the main side once we
    // acknowledge here, so subsequent launches stay quiet.
    if (config && config._migratedFromReplicate) {
      showToast(
        "Replicate has been removed in this release. You're now using Pixfizz AI Enhancement (local). " +
        "Topaz remains available if your Topaz API key is configured.",
        'info',
        12000,
      );
      try {
        if (typeof window.electronAPI.clearReplicateMigrationToast === 'function') {
          await window.electronAPI.clearReplicateMigrationToast();
        }
      } catch (e) { /* non-fatal — worst case the toast shows once more */ }
    }
  } catch (error) {
    showStatus('Error loading configuration: ' + error.message, 'error');
  }

  // Restore persisted date range before first fetch
  try {
    const storedRange = await window.electronAPI.getJobDateRange();
    currentDateRange = storedRange ?? 30;
    jobDateRangeSelect.value = String(currentDateRange);
    dateRangeWarning.classList.toggle('hidden', currentDateRange !== 0);
  } catch (_) {}

  // Load jobs
  loadJobs();

  // Render print controller cards
  renderPrintControllers(cachedControllers);
});

// ── Window controls ──
document.getElementById('minimiseBtn').addEventListener('click', () => window.electronAPI.minimiseWindow());
document.getElementById('closeBtn').addEventListener('click', () => window.electronAPI.closeWindow());

// ── Theme toggle ──
// Single source of truth for light/dark across the app. The class lives on
// <body> so every panel — Job Review (.jr-root), Film Review (.film-review-panel),
// and the legacy renderer.js UI — picks up the same --app-* token overrides
// from styles.css.
//
// Persistence:
//   read once on startup via electronAPI.appGetTheme(), then write through
//   electronAPI.appSetTheme(value) on each click. Failures fall back silently
//   to whatever the body class currently is.
(async () => {
  const themeBtn = document.getElementById('themeToggleBtn');
  if (!themeBtn) return;

  function applyTheme(theme) {
    if (theme === 'dark') document.body.classList.add('app-theme-dark');
    else                  document.body.classList.remove('app-theme-dark');
  }

  // Initial paint — read persisted value before first frame (preload guarantees
  // electronAPI is available synchronously, so we just await the IPC).
  try {
    const saved = await window.electronAPI.appGetTheme();
    applyTheme(saved === 'dark' ? 'dark' : 'light');
  } catch (err) {
    console.warn('[theme] failed to load saved theme — defaulting to light', err);
  }

  themeBtn.addEventListener('click', async () => {
    const isDark = document.body.classList.contains('app-theme-dark');
    const next   = isDark ? 'light' : 'dark';
    applyTheme(next);
    try { await window.electronAPI.appSetTheme(next); }
    catch (err) {
      console.warn('[theme] persist failed — local class still applied', err);
    }
  });
})();

// Maximise / restore — SVG icons drawn inline so they scale cleanly with currentColor.
const _SVG_MAXIMISE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect x="0.75" y="0.75" width="8.5" height="8.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const _SVG_RESTORE   = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 11 11"><rect x="3" y="0.75" width="7.25" height="7.25" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="0.75" y="3" width="7.25" height="7.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

const maximiseBtn = document.getElementById('maximiseBtn');

function _setMaximiseIcon(isMaximised) {
  maximiseBtn.innerHTML = isMaximised ? _SVG_RESTORE : _SVG_MAXIMISE;
  maximiseBtn.title     = isMaximised ? 'Restore' : 'Maximise';
}

_setMaximiseIcon(false); // initialise to maximise icon on startup
maximiseBtn.addEventListener('click', () => window.electronAPI.maximiseWindow());
window.electronAPI.onWindowMaximised(isMax => _setMaximiseIcon(isMax));

// When an update downloads while the app is open, update the badge immediately
window.electronAPI.onUpdateReady(({ version }) => {
  const versionEl = document.getElementById('appVersion');
  if (versionEl) {
    versionEl.textContent = `v${version} — 🔄 Update Ready`;
    versionEl.classList.add('update-ready');
  }
});

// ── Update available banner ──
window.electronAPI.onUpdateAvailable(({ latest_version, download_url, release_notes, mandatory }) => {
  const banner      = document.getElementById('updateBanner');
  const versionEl  = document.getElementById('updateBannerVersion');
  const notesEl    = document.getElementById('updateBannerNotes');
  const downloadBtn = document.getElementById('updateDownloadBtn');
  const dismissBtn  = document.getElementById('updateDismissBtn');

  if (!banner) return;

  versionEl.textContent  = `Update available: v${latest_version}`;
  notesEl.textContent    = release_notes || '';
  banner.classList.remove('hidden');

  if (mandatory) {
    banner.classList.add('mandatory');
    dismissBtn.classList.add('hidden');
  } else {
    dismissBtn.classList.remove('hidden');
    dismissBtn.onclick = () => banner.classList.add('hidden');
  }

  downloadBtn.onclick = () => window.electronAPI.openExternal(download_url);
});

// Listen for job updates from polling
window.electronAPI.onJobsUpdated(async (data) => {
  if (data && data.jobs) {
    allJobs = data.jobs;
    await resolveRoutesForReceivedJobs(allJobs);
    await refreshAiQualityHeldJobs();
    renderJobTable(getFilteredJobs());
  }
});

// AI Quality Gate (v1.2.0) — refresh badges when autoprint reports a hold
if (window.electronAPI.onAiQualityJobHeld) {
  window.electronAPI.onAiQualityJobHeld(async () => {
    await refreshAiQualityHeldJobs();
    renderJobTable(getFilteredJobs());
  });
}

// Listen for DPOF output-status changes pushed from the main process polling loop.
// Updates the specific job row in-place without a full table re-render.
window.electronAPI.onJobStatusChanged(({ jobId, status, prefix }) => {
  const newStatus = { prefix, folderName: null, folderPath: null };
  outputStatusCache.set(String(jobId), newStatus);

  // Find the job object to rebuild the action cell
  const job = allJobs.find(j => String(j.id) === String(jobId));
  updateJobRowStatus(String(jobId), newStatus, job || null);

  // Notify the operator of significant status transitions
  if (prefix === 'e') {
    showToast(`Job ${jobId} — Imported by controller. Ready to mark as printed.`, 'info', 8000);
  } else if (prefix === 'q') {
    showToast(`Job ${jobId} — Failed Import. Check the controller and use Resend.`, 'error', 12000);
  }
});

// ══════════════════════════════════════
// JOBS: Loading & Rendering
// ══════════════════════════════════════

async function loadJobs() {
  try {
    const [data, dismissed] = await Promise.all([
      window.electronAPI.getJobs(),
      window.electronAPI.getDismissedJobs()
    ]);
    allJobs = data.jobs || [];
    dismissedJobs = dismissed || [];
    updateDismissedBadge();
    await resolveRoutesForReceivedJobs(allJobs);
    await refreshAiQualityHeldJobs();
    renderJobTable(getFilteredJobs());
  } catch (error) {
    console.error('Error loading jobs:', error);
  }
}

refreshJobsBtn.addEventListener('click', async () => {
  refreshJobsBtn.disabled = true;
  refreshJobsBtn.textContent = 'Refreshing...';
  try {
    const [data, dismissed] = await Promise.all([
      window.electronAPI.refreshJobs(),
      window.electronAPI.getDismissedJobs()
    ]);
    allJobs = data.jobs || [];
    dismissedJobs = dismissed || [];
    updateDismissedBadge();
    await resolveRoutesForReceivedJobs(allJobs);
    renderJobTable(getFilteredJobs());
  } catch (error) {
    console.error('Error refreshing jobs:', error);
  } finally {
    refreshJobsBtn.disabled = false;
    refreshJobsBtn.textContent = 'Refresh';
  }
});

// Search filter
jobSearch.addEventListener('input', () => {
  renderJobTable(getFilteredJobs());
});

// Date range selector
jobDateRangeSelect.addEventListener('change', async () => {
  currentDateRange = parseInt(jobDateRangeSelect.value, 10);
  dateRangeWarning.classList.toggle('hidden', currentDateRange !== 0);
  await window.electronAPI.setJobDateRange(currentDateRange);
  renderJobTable(getFilteredJobs());
});

// Job filter buttons (All / Awaiting Processing / Processed)
document.querySelectorAll('.jobs-filter[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.jobs-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderJobTable(getFilteredJobs());
  });
});

function getFilteredJobs() {
  const query = jobSearch.value.toLowerCase().trim();
  let jobs = [...allJobs];

  // Tab filter
  if (currentFilter === 'awaiting') {
    jobs = jobs.filter(j => j._status !== 'completed' && !dismissedJobs.includes(String(j.id)));
  } else if (currentFilter === 'printed') {
    jobs = jobs.filter(j => j._status === 'completed' && !dismissedJobs.includes(String(j.id)));
  } else if (currentFilter === 'dismissed') {
    jobs = jobs.filter(j => dismissedJobs.includes(String(j.id)));
  } else {
    // 'all' — exclude dismissed
    jobs = jobs.filter(j => !dismissedJobs.includes(String(j.id)));
  }

  // Date range filter (not applied to the Dismissed tab — dismissed jobs have no active date relevance)
  if (currentDateRange > 0 && currentFilter !== 'dismissed') {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - currentDateRange);
    jobs = jobs.filter(j => {
      if (!j.created_at) return true; // keep jobs with no date rather than hide them
      return new Date(j.created_at) >= cutoff;
    });
  }

  // Search filter
  if (query) {
    jobs = jobs.filter(job => {
      const searchable = [
        job._status, job.process, job.category,
        job.order_id, job.id, job.product,
        job.due_date, job.order_number, job.job_name,
        job.customer_name, formatJobNo(job)
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }

  // Sort
  jobs.sort((a, b) => {
    let aVal = getSortValue(a, currentSort.field);
    let bVal = getSortValue(b, currentSort.field);
    if (aVal < bVal) return currentSort.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return currentSort.direction === 'asc' ? 1 : -1;
    return 0;
  });

  return jobs;
}

function getSortValue(job, field) {
  switch (field) {
    case 'status': return job._status || '';
    case 'process': return job.process || '';
    case 'category': return job.category || '';
    case 'job_no': return formatJobNo(job);
    case 'product': return job.product || '';
    case 'quantity': return job.quantity || 0;
    case 'due_date': return job.due_date || '';
    case 'created_at': return job.created_at || '';
    default: return '';
  }
}

function formatJobNo(job) {
  if (job.job_name) {
    return job.job_name;
  }
  if (job.order_number && job.id) {
    return `${job.order_number}_${job.id}`;
  }
  return job.id || '';
}

function formatDueDate(dateStr, dateFormat) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return escapeHtml(dateStr);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  switch (dateFormat) {
    case 'YMD': return `${yyyy}-${mm}-${dd}`;
    case 'MDY': return `${mm}/${dd}/${yyyy}`;
    case 'DMY':
    default:    return `${dd}/${mm}/${yyyy}`;
  }
}

function getStatusLabel(status) {
  switch (status) {
    case 'pending': return 'Pending';
    case 'received': return 'Received';
    case 'in_production': return 'In Production';
    case 'completed': return 'Processed';
    default: return status || 'Unknown';
  }
}

function renderJobTable(jobs) {
  // Show/hide empty state
  if (jobs.length === 0) {
    const titleEl = jobsEmptyState.querySelector('.empty-title');
    if (titleEl) titleEl.textContent = currentFilter === 'dismissed' ? 'No dismissed jobs' : 'No jobs found';
    jobsEmptyState.classList.remove('hidden');
    jobsTableWrap.style.display = 'none';
  } else {
    jobsEmptyState.classList.add('hidden');
    jobsTableWrap.style.display = '';
  }

  // Build table rows
  jobsTableBody.innerHTML = '';

  for (const job of jobs) {
    const tr = document.createElement('tr');
    tr.dataset.jobId = String(job.id);
    if (currentFilter === 'dismissed') tr.classList.add('dismissed-row');

    // Status badge — DPOF prefix-driven status takes highest priority,
    // then legacy DPOF flags, then standard _status.
    let statusClass, statusLabel;
    const outputStatus = outputStatusCache.get(String(job.id));
    if (outputStatus) {
      ({ statusClass, statusLabel } = getDpofOutputBadge(outputStatus.prefix));
    } else if (job._dpofFailed) {
      statusClass = 'badge badge-dpof_failed';
      statusLabel = 'Print Failed';
    } else if (job._dpofAccepted) {
      statusClass = 'badge badge-dpof_accepted';
      statusLabel = 'Print Accepted';
    } else if (job._status === 'pending') {
      // For pending jobs, "Pending" badge only makes sense when routing is incomplete
      // (action = Assign). If a valid route exists, show "Received" so the operator
      // knows the job is ready to print.
      const pendingRoute = jobRouteCache.get(String(job.id));
      if (pendingRoute && pendingRoute.type !== 'unrouted') {
        statusClass = 'badge badge-received';
        statusLabel = 'Received';
      } else {
        statusClass = 'badge badge-pending';
        statusLabel = 'Pending';
      }
    } else {
      statusClass = `badge badge-${(job._status || 'unknown').replace(/\s+/g, '_')}`;
      statusLabel = getStatusLabel(job._status);
    }

    // Options pills (array of { name, value })
    let optionsHtml = '';
    if (Array.isArray(job.options)) {
      for (const opt of job.options) {
        const optName = opt && (opt.name || opt.key);
        if (optName) {
          const label = opt.value ? `${optName}: ${opt.value}` : optName;
          optionsHtml += `<span class="option-pill">${escapeHtml(label)}</span>`;
        }
      }
    } else if (job.options && typeof job.options === 'object') {
      // Fallback for legacy object format
      for (const [key, val] of Object.entries(job.options)) {
        if (val) {
          const label = val === true ? key : `${key}: ${val}`;
          optionsHtml += `<span class="option-pill">${escapeHtml(label)}</span>`;
        }
      }
    }

    // Preview image
    let previewHtml = '';
    if (job.preview_image_url) {
      previewHtml = `<img class="job-preview-img" src="${escapeHtml(job.preview_image_url)}" alt="Preview" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><div class="job-preview" style="display:none">&#128444;</div>`;
    } else {
      previewHtml = '<div class="job-preview">&#128444;</div>';
    }

    // Action button
    // Compute the local folder path so the Review button can open the Job Review drawer.
    // Formula: {downloadDirectory}\{order_number}_{order_id}\{order_number}_{job.id}
    // The sidecar jobId matches the inner folder name: {order_number}_{job.id}
    const sidecarJobId  = job.order_number
      ? `${job.order_number}_${job.id}`
      : String(job.id);
    const jobFolderName = job.order_number && job.order_id
      ? `${job.order_number}_${job.order_id}`
      : '';
    const jobFolderPath = downloadDirectory && jobFolderName
      ? `${downloadDirectory}\\${jobFolderName}\\${sidecarJobId}`
      : '';
    // AI Quality Gate (v1.2.0) — when scoring is still pending for this job,
    // dispatch-related buttons (Process / Assign / Dismiss / DPOF status
    // actions) are rendered disabled with a tooltip. Review stays enabled
    // throughout (operator can inspect the job, see "no images" or
    // partially-scored state, while scoring continues). The feature-flag
    // off case bypasses this entirely — see isPendingAIQuality.
    const pendingAIQ = isPendingAIQuality(job);
    const pendingAttrs = pendingAIQ
      ? ' disabled class="btn-action pending" title="Pending AI Quality check"'
      : '';
    // Helper: take a button HTML snippet that uses the standard pattern
    // class="btn-action btn-foo" data-job-id="..." and inject the disabled
    // state without duplicating the class attribute.
    function maybeDisable(btnHtml, extraClass = '') {
      if (!pendingAIQ) return btnHtml;
      // Replace the class="btn-action ..." with class="btn-action ... pending" + disabled.
      const withClass = btnHtml.replace(
        /class="btn-action ([^"]*)"/,
        `class="btn-action $1 pending"`,
      );
      return withClass.replace(
        /<button /,
        '<button disabled title="Pending AI Quality check" ',
      );
    }

    // Review button shown alongside any downloaded job (received / in_production / completed).
    // Review is NOT gated on AI Quality — operators can inspect a job whose
    // scoring is still in progress.
    const reviewBtn = `<button class="btn-action btn-review" data-sidecar-job-id="${escapeHtml(sidecarJobId)}" data-job-path="${escapeHtml(jobFolderPath)}" data-oh-job-id="${escapeHtml(String(job.id))}">Review</button>`;

    let actionHtml = '';
    if (currentFilter === 'dismissed') {
      // Restore is out of scope of the AI Quality gate (already-dismissed
      // jobs are by definition past scoring).
      actionHtml = `<div class="actions-cell-wrap"><button class="btn-action btn-restore" data-job-id="${escapeHtml(String(job.id))}">Restore</button></div>`;
    } else if (outputStatus) {
      // DPOF prefix-driven action buttons. These are post-dispatch actions
      // (resend, retry, mark-printed) — gate on pending AI Quality so an
      // operator can't trigger a re-dispatch on a job that's mid-scoring.
      const dpofHtml = getDpofOutputActionHtml(reviewBtn, String(job.id), outputStatus.prefix);
      actionHtml = pendingAIQ
        ? dpofHtml.replace(/<button /g, '<button disabled title="Pending AI Quality check" ')
                  .replace(/class="btn-action ([^"]*)"/g, 'class="btn-action $1 pending"')
        : dpofHtml;
    } else if (job._status === 'completed') {
      // Already-completed jobs are past scoring — no gate needed.
      actionHtml = `${reviewBtn}<button class="btn-action btn-printed" disabled>Processed</button>`;
    } else if (job._status === 'in_production') {
      // Job already dispatched — review-only, no gate.
      actionHtml = reviewBtn;
    } else if (job._status === 'received') {
      const route = jobRouteCache.get(String(job.id));
      if (route && route.type === 'unrouted') {
        if (route.reason === 'no-channel') {
          // Controller is assigned but no channel mapping yet — show Assign button
          const assignBtn = `<button class="btn-action btn-assign-channel" data-job-id="${escapeHtml(String(job.id))}">Assign</button>`;
          actionHtml = `${reviewBtn}${maybeDisable(assignBtn)}`;
        } else {
          // No controller AND no default folder configured
          actionHtml = `${reviewBtn}<span class="route-unassigned-msg">No default folder — configure in Settings → Process Folders</span>`;
        }
      } else {
        // Routed (controller / default-folder / process-folder) or not yet resolved — normal Send to Print
        const processBtn = `<button class="btn-action btn-send-print" data-job-id="${escapeHtml(String(job.id))}">Process</button>`;
        actionHtml = `${reviewBtn}${maybeDisable(processBtn)}`;
      }
    } else if (job._status === 'pending') {
      const route = jobRouteCache.get(String(job.id));
      if (route && route.type === 'unrouted') {
        if (route.reason === 'no-channel') {
          // Controller assigned but no channel mapping yet — show Assign
          const assignBtn = `<button class="btn-action btn-assign-channel" data-job-id="${escapeHtml(String(job.id))}">Assign</button>`;
          actionHtml = `${reviewBtn}${maybeDisable(assignBtn)}`;
        } else {
          // No controller AND no default folder configured
          actionHtml = `${reviewBtn}<span class="route-unassigned-msg">No default folder — configure in Settings → Process Folders</span>`;
        }
      } else if (route && route.type !== 'unrouted') {
        // Valid route — show Review + Send to Print (same as received)
        const processBtn = `<button class="btn-action btn-send-print" data-job-id="${escapeHtml(String(job.id))}">Process</button>`;
        actionHtml = `${reviewBtn}${maybeDisable(processBtn)}`;
      } else {
        actionHtml = '<span style="color:#a0aec0;font-size:11px">--</span>';
      }
    } else if (job._status === 'warning') {
      const msg = job._warningMessage || 'Unknown warning — check Activity Log';
      actionHtml = `<span class="route-unassigned-msg">⚠ ${escapeHtml(msg)}</span>`;
    } else {
      actionHtml = '<span style="color:#a0aec0;font-size:11px">--</span>';
    }

    // Wrap with dismiss button for non-dismissed tabs. Dismiss is gated
    // ONLY on actively-in-progress scoring (isAiQualityScoringInProgress),
    // not on the broader isPendingAIQuality. The narrower gate keeps the
    // original "don't orphan a sidecar mid-update" safety while letting
    // operators remove jobs that will never have a sidecar — most
    // commonly POS / walk-in orders that come in as 'pending' and never
    // receive artwork. With the broader gate those rows were stuck in
    // the grid permanently.
    if (currentFilter !== 'dismissed') {
      const scoringInFlight = isAiQualityScoringInProgress(job);
      const dismissBtnAttrs = scoringInFlight
        ? ' disabled class="btn-dismiss pending" title="Pending AI Quality check"'
        : ' class="btn-dismiss" title="Hide this job from the list"';
      actionHtml = `<div class="actions-cell-wrap">${actionHtml}<button${dismissBtnAttrs} data-job-id="${escapeHtml(String(job.id))}">Dismiss</button></div>`;
    }

    // Surface the AI-Quality-scoring state explicitly. The buttons above
    // already get .pending styling from the same flag, but a greyed-out
    // button doesn't tell the operator *why* it's inactive — this caption
    // makes the wait visible. Stacked outside .actions-cell-wrap so it
    // sits beneath the buttons via normal block flow + the TD's
    // vertical-align: middle.
    if (pendingAIQ) {
      actionHtml += `<div class="ai-q-indicator" title="AI Quality scoring in progress">AI scoring…</div>`;
    }

    const jobNo = formatJobNo(job);

    // Flags: rush + order notes + AI quality hold icons
    let flagsHtml = '';
    if (job.is_rush) {
      flagsHtml += '<span class="flag-icon flag-rush" title="Rush Order">&#9889;</span>';
    }
    if (job.order_notes) {
      flagsHtml += `<span class="flag-icon flag-notes" title="${escapeHtml(job.order_notes)}">&#128196;</span>`;
    }
    const heldQuality = aiQualityHeldByJobId.get(String(job.id));
    if (heldQuality) {
      // Two-part badge: a non-interactive count on top, an explicit Release
      // button below. Earlier UX was an icon-only badge with a "click to
      // release" tooltip — operators new to the AI Quality Gate were
      // missing that affordance and getting stuck on the toast that says
      // "release via the Quality flag in the Jobs grid". The button keeps
      // the existing click handler (still binds to `.flag-quality
      // [data-quality-job]`) but makes the action discoverable at a
      // glance.
      //
      // For jobs no longer in the autoprint pool (printed, dismissed, etc.)
      // the badge is rendered in a muted style and the Release button is
      // suppressed — the action doesn't apply once the job is through, but
      // the count stays visible as historical record of "X images failed
      // AI Quality at processing time".
      const isLive = job._status === 'received' || job._status === 'pending';
      // Release is only meaningful in block mode. In warn mode the
      // orchestrator returns held=false even with failed images, so the
      // job dispatches normally — there is nothing held and nothing to
      // release. Showing the button there leaves operators clicking it,
      // hitting the confirm dialog, and ending up in the same state they
      // could already reach by just clicking Process. Suppress in warn.
      const isHoldingMode = aiQualityModeCached === 'block';
      const liveTip = isHoldingMode
        ? `${heldQuality.failedImages}/${heldQuality.totalImages} images failed AI Quality scoring — job held, click Release to dispatch`
        : `${heldQuality.failedImages}/${heldQuality.totalImages} images flagged by AI Quality (warn mode — job will dispatch normally)`;
      const histTip = `${heldQuality.failedImages}/${heldQuality.totalImages} images flagged by AI Quality at processing time`;
      const tip = isLive ? liveTip : histTip;
      const stackClass = isLive ? 'flag-quality-stack' : 'flag-quality-stack flag-quality-stack--muted';
      const countClass = isLive ? 'flag-quality-count' : 'flag-quality-count flag-quality-count--muted';
      const releaseBtn = (isLive && isHoldingMode)
        ? `<button type="button" class="flag-quality flag-quality-release" data-quality-job="${escapeHtml(String(job.id))}" title="Release the AI Quality hold and allow this job to print as-is">Release</button>`
        : '';
      flagsHtml +=
        `<span class="${stackClass}">` +
          `<span class="${countClass}" title="${escapeHtml(tip)}">&#9888; ${heldQuality.failedImages}/${heldQuality.totalImages}</span>` +
          releaseBtn +
        `</span>`;
    }

    tr.innerHTML = `
      <td class="job-status-cell"><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td>${previewHtml}</td>
      <td>${escapeHtml(job.process || '--')}</td>
      <td>${escapeHtml(job.category || '--')}</td>
      <td class="flags-cell">${flagsHtml || ''}</td>
      <td><span class="job-no" data-copy="${escapeHtml(jobNo)}" title="Click to copy">${escapeHtml(jobNo)}</span>${job.customer_name ? `<br><span class="customer-name">${escapeHtml(job.customer_name)}</span>` : ''}${job.created_at ? `<br><span class="ordered-date">${formatDueDate(job.created_at, job.date_format)}</span>` : ''}</td>
      <td>${escapeHtml(job.product || '--')}</td>
      <td>${job.quantity != null ? job.quantity : '--'}</td>
      <td>${optionsHtml || '<span style="color:#a0aec0">--</span>'}</td>
      <td>${formatDueDate(job.due_date, job.date_format)}</td>
      <td class="job-action-cell">${actionHtml}</td>
    `;

    jobsTableBody.appendChild(tr);
  }

  // Attach click-to-copy on job numbers
  document.querySelectorAll('.job-no[data-copy]').forEach(el => {
    el.addEventListener('click', (e) => {
      const text = el.dataset.copy;
      navigator.clipboard.writeText(text).then(() => {
        showCopiedTooltip(e, text);
      });
    });
  });

  // AI Quality flag — clicking the badge releases the held job
  // (M1+M2 minimal UX; M3 will replace this with the Quality Review tab).
  document.querySelectorAll('.flag-quality[data-quality-job]').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const jobId = el.dataset.qualityJob;
      const meta = aiQualityHeldByJobId.get(String(jobId));
      const failed = meta ? `${meta.failedImages}/${meta.totalImages}` : '?';
      const ok = window.confirm(
        `Release this job for printing?\n\n` +
        `${failed} images failed the AI quality check. ` +
        `Approving means these images will print as-is without further review.`
      );
      if (!ok) return;
      try {
        await window.electronAPI.aiQualityReleaseJob(jobId, 'released from Jobs grid');
        await refreshAiQualityHeldJobs();
        renderJobTable(getFilteredJobs());
      } catch (err) {
        console.error('[ai-quality] releaseJob failed', err);
        window.alert('Release failed — see logs for details.');
      }
    });
  });

  // Attach Send to Print handlers
  document.querySelectorAll('.btn-send-print[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;

      try {
        btn.textContent = 'Sending...';
        const result = await window.electronAPI.sendToPrint(jobId);

        if (result.success) {
          btn.textContent = 'Sent to Printer';
          btn.className = 'btn-action btn-sent';
          showToast('Job sent to printer', 'success');
          loadJobs();
        } else {
          btn.disabled = false;
          btn.textContent = 'Process';
          showToast('Process failed: ' + (result.error || 'Unknown error'), 'error', 10000);
        }
      } catch (error) {
        btn.disabled = false;
        btn.textContent = 'Process';
        showToast('Process error: ' + error.message, 'error', 10000);
      }
    });
  });

  // Attach Review panel handlers — dispatch CustomEvent to open the React drawer.
  document.querySelectorAll('.btn-review').forEach(btn => {
    btn.addEventListener('click', () => {
      const jobId   = btn.dataset.sidecarJobId;
      const jobPath = btn.dataset.jobPath;
      const ohJobId = btn.dataset.ohJobId || null;
      window.dispatchEvent(new CustomEvent('ohd:open-job-review', {
        detail: { jobId, jobPath, ohJobId },
      }));
    });
  });

  // ── DPOF output-status action handlers ──

  // "Resend" (q status) — full re-send through DPOF pipeline
  document.querySelectorAll('.btn-resend-dpof[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;
      btn.textContent = 'Resending...';
      try {
        const result = await window.electronAPI.resendJob(jobId);
        if (result.success) {
          showToast('Job resent to printer', 'success');
          loadJobs();
        } else {
          btn.disabled = false;
          btn.textContent = 'Resend';
          showToast('Resend failed: ' + (result.error || 'Unknown error'), 'error', 8000);
        }
      } catch (error) {
        btn.disabled = false;
        btn.textContent = 'Resend';
        showToast('Resend error: ' + error.message, 'error', 8000);
      }
    });
  });

  // "Retry" (p status) — same full re-send pipeline
  document.querySelectorAll('.btn-retry-dpof[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;
      btn.textContent = 'Retrying...';
      try {
        const result = await window.electronAPI.resendJob(jobId);
        if (result.success) {
          showToast('Job retry sent to printer', 'success');
          loadJobs();
        } else {
          btn.disabled = false;
          btn.textContent = 'Retry';
          showToast('Retry failed: ' + (result.error || 'Unknown error'), 'error', 8000);
        }
      } catch (error) {
        btn.disabled = false;
        btn.textContent = 'Retry';
        showToast('Retry error: ' + error.message, 'error', 8000);
      }
    });
  });

  // ── Assign channel handlers (Step 9 / 10) ───────────────────────────────────

  // "Assign" button — opens the Assign Channel modal for jobs that have a
  // controller but no channel mapping yet (route.reason === 'no-channel').
  document.querySelectorAll('.btn-assign-channel[data-job-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const jobId = btn.dataset.jobId;
      const job   = allJobs.find(j => String(j.id) === String(jobId));
      const route = jobRouteCache.get(String(jobId));
      if (job && route && route.type === 'unrouted' && route.reason === 'no-channel') {
        openAssignModal(job, route);
      }
    });
  });

  // ── Dismiss / Restore handlers ──
  document.querySelectorAll('.btn-dismiss[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;
      try {
        dismissedJobs = await window.electronAPI.dismissJob(jobId);
        updateDismissedBadge();
        const row = jobsTableBody.querySelector(`tr[data-job-id="${CSS.escape(jobId)}"]`);
        if (row) row.remove();
        if (jobsTableBody.children.length === 0) {
          const titleEl = jobsEmptyState.querySelector('.empty-title');
          if (titleEl) titleEl.textContent = 'No jobs found';
          jobsEmptyState.classList.remove('hidden');
          jobsTableWrap.style.display = 'none';
        }
        showToast('Job dismissed', 'success');
      } catch (error) {
        btn.disabled = false;
        showToast('Dismiss error: ' + error.message, 'error', 5000);
      }
    });
  });

  document.querySelectorAll('.btn-restore[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;
      try {
        dismissedJobs = await window.electronAPI.undismissJob(jobId);
        updateDismissedBadge();
        const row = jobsTableBody.querySelector(`tr[data-job-id="${CSS.escape(jobId)}"]`);
        if (row) row.remove();
        if (jobsTableBody.children.length === 0) {
          const titleEl = jobsEmptyState.querySelector('.empty-title');
          if (titleEl) titleEl.textContent = 'No dismissed jobs';
          jobsEmptyState.classList.remove('hidden');
          jobsTableWrap.style.display = 'none';
        }
        showToast('Job restored', 'success');
      } catch (error) {
        btn.disabled = false;
        showToast('Restore error: ' + error.message, 'error', 5000);
      }
    });
  });

  // Async scan: populate outputStatusCache for all jobs and update rows in-place
  refreshOutputStatuses(jobs);
}

function updateDismissedBadge() {
  const btn = document.getElementById('dismissedFilterBtn');
  if (!btn) return;
  const count = dismissedJobs.length;
  btn.textContent = count > 0 ? `Dismissed (${count})` : 'Dismissed';
}

// ── DPOF output-status helpers ─────────────────────────────────────────────────

/**
 * Map a folder prefix (or virtual prefix) to a badge CSS class and label.
 * @param {string} prefix - 'p', 'o', 'q', 'e', or 'printed'
 * @returns {{ statusClass: string, statusLabel: string }}
 */
function getDpofOutputBadge(prefix) {
  const map = {
    p:       { statusClass: 'badge badge-import_error',    statusLabel: 'Import Error' },
    o:       { statusClass: 'badge badge-awaiting_import', statusLabel: 'Awaiting Import' },
    q:       { statusClass: 'badge badge-failed_import',   statusLabel: 'Failed Import' },
    e:       { statusClass: 'badge badge-imported',        statusLabel: 'Imported' },
    printed: { statusClass: 'badge badge-printed',         statusLabel: 'Processed' },
  };
  return map[prefix] || { statusClass: 'badge badge-unknown', statusLabel: 'Unknown' };
}

/**
 * Build the action cell HTML for a DPOF job based on its output folder prefix.
 * Prefix → action mapping:
 *   p (Import Error)    → Retry
 *   o (Awaiting Import) → no action (waiting for controller)
 *   q (Failed Import)   → Resend
 *   e (Imported)        → no action (auto-marked Processed by hot folder watcher)
 *   printed (internal)  → no action (complete)
 * @param {string} reviewBtnHtml - Pre-built Review button HTML
 * @param {string} jobId
 * @param {string} prefix - 'p', 'o', 'q', 'e', or 'printed'
 * @returns {string}
 */
function getDpofOutputActionHtml(reviewBtnHtml, jobId, prefix) {
  const id = escapeHtml(jobId);
  switch (prefix) {
    case 'p':
      return `${reviewBtnHtml}<button class="btn-action btn-retry-dpof" data-job-id="${id}">Retry</button>`;
    case 'o':
      return reviewBtnHtml; // Awaiting controller import — no operator action yet
    case 'q':
      return `${reviewBtnHtml}<button class="btn-action btn-resend-dpof" data-job-id="${id}">Resend</button>`;
    case 'e':
      return reviewBtnHtml; // Accepted by controller — auto-marked Processed by hot folder watcher
    case 'printed':
      return reviewBtnHtml; // Complete — no further action
    default:
      return reviewBtnHtml;
  }
}

// ── Assign Channel Modal (Steps 9 & 10) ──────────────────────────────────────

/**
 * Open the Assign Channel modal for a job that has a controller but no
 * channel mapping yet (route.reason === 'no-channel').
 *
 * Pre-fills product, product code, controller name, and options (all read-only).
 * For DPOF controllers: operator enters a channel number and clicks Save (creates a new mapping).
 * For Darkroom Pro controllers: operator picks from the controller's existing channel mappings.
 *
 * @param {object} job   - Job object from allJobs
 * @param {object} route - Route from jobRouteCache: { type:'unrouted', reason:'no-channel', controller }
 */
function openAssignModal(job, route) {
  const modal = document.getElementById('assignChannelModal');
  if (!modal) return;

  const isDarkroomPro = route.controller && route.controller.type === 'darkroompro';

  // Populate read-only fields
  document.getElementById('assignModalProduct').textContent     = job.product     || '—';
  document.getElementById('assignModalProductCode').textContent = job.product_code || '—';
  document.getElementById('assignModalController').textContent  = route.controller ? route.controller.name : '—';

  // Options pills
  const optionsEl = document.getElementById('assignModalOptions');
  if (Array.isArray(job.options) && job.options.length > 0) {
    optionsEl.innerHTML = job.options
      .filter(o => o && (o.name || o.key))
      .map(o => {
        const label = o.value ? `${o.name || o.key}: ${o.value}` : (o.name || o.key);
        return `<span class="option-pill">${escapeHtml(label)}</span>`;
      })
      .join('');
    document.getElementById('assignModalOptionsGroup').style.display = '';
  } else {
    optionsEl.innerHTML = '—';
    document.getElementById('assignModalOptionsGroup').style.display = 'none';
  }

  // Show DPOF or Darkroom Pro input section
  document.getElementById('assignDpofGroup').style.display          = isDarkroomPro ? 'none' : '';
  document.getElementById('assignSkipAutoPrintGroup').style.display  = isDarkroomPro ? 'none' : '';
  document.getElementById('assignDpGroup').style.display             = isDarkroomPro ? '' : 'none';

  if (isDarkroomPro) {
    // ── Populate the Size / Media fields ──────────────────────────────────
    const controller = cachedOrderControllers.find(c => c.id === route.controller.id) || route.controller;
    const productCode = job.product_code || '';

    // Size: find existing translation, or pre-fill from previous job override
    document.getElementById('dpProductCode').textContent = `Product Code: ${productCode}`;
    const existingSize = (controller.sizeTranslations || []).find(
      t => t.productCodePrefix && t.productCodePrefix.toLowerCase() === productCode.toLowerCase()
    );
    const sizeInput = document.getElementById('dpSizeInput');
    sizeInput.value = existingSize ? existingSize.darkroomSize : (job._darkroomProSize || '');
    sizeInput.setCustomValidity('');
    document.getElementById('dpSaveSizeTranslation').checked = false;

    // Media: attempt to resolve via translation table
    const mediaOptionKey = (controller.mediaOptionKey || '').trim();
    const jobOptions     = job.options || [];
    let resolvedMediaValue = '';
    let mediaOptionEntry   = null; // the raw job option that looks like a paper type

    if (mediaOptionKey) {
      mediaOptionEntry = jobOptions.find(
        o => o.name && o.name.toLowerCase() === mediaOptionKey.toLowerCase()
      );
    }
    // Fall back to first option when key not configured or not found on job
    if (!mediaOptionEntry && jobOptions.length > 0) {
      mediaOptionEntry = jobOptions[0];
    }

    if (mediaOptionEntry) {
      const translation = (controller.mediaTranslations || []).find(
        t => t.from && t.from.toLowerCase() === (mediaOptionEntry.value || '').toLowerCase()
      );
      if (translation) resolvedMediaValue = translation.to;
    }

    // Also accept a previous per-job media override as "resolved"
    if (!resolvedMediaValue && job._darkroomProMedia) {
      resolvedMediaValue = job._darkroomProMedia;
    }

    const mediaAutoResolved = !!resolvedMediaValue;
    document.getElementById('dpMediaResolved').textContent =
      mediaAutoResolved ? `Media: ${resolvedMediaValue}` : '';
    document.getElementById('dpMediaInputGroup').style.display = mediaAutoResolved ? 'none' : '';

    if (!mediaAutoResolved) {
      // Show hint about which raw option was found
      if (mediaOptionEntry) {
        const optKey = mediaOptionEntry.name || mediaOptionEntry.key || '';
        document.getElementById('dpMediaOptionHint').textContent =
          `Option: ${optKey}: ${mediaOptionEntry.value}`;
      } else {
        document.getElementById('dpMediaOptionHint').textContent =
          mediaOptionKey
            ? `Option "${mediaOptionKey}" not found on this job`
            : 'No media option key configured on this controller';
      }
      const mediaInput = document.getElementById('dpMediaInput');
      mediaInput.value = '';
      mediaInput.setCustomValidity('');
      document.getElementById('dpSaveMediaTranslation').checked = false;
    }

    // Stash context for save handler
    modal.dataset.dpMediaAutoResolved  = mediaAutoResolved ? '1' : '0';
    modal.dataset.dpMediaResolvedValue = resolvedMediaValue;
    modal.dataset.dpMediaFrom          = mediaOptionEntry ? (mediaOptionEntry.value || '') : '';
  } else {
    // Clear DPOF inputs
    document.getElementById('assignChannelNumber').value = '';
    document.getElementById('assignSkipAutoPrint').checked = false;
  }

  // Store context on the modal element for the save handler
  modal.dataset.jobId         = String(job.id);
  modal.dataset.controllerId  = route.controller ? route.controller.id : '';
  modal.dataset.productCode   = job.product_code || '';
  modal.dataset.isDarkroomPro = isDarkroomPro ? '1' : '';
  // Serialise job options for save handler (JSON)
  modal.dataset.jobOptions    = JSON.stringify(job.options || []);

  modal.classList.remove('hidden');
  if (!isDarkroomPro) {
    document.getElementById('assignChannelNumber').focus();
  }
}

// Wire up Assign modal save / cancel once (outside renderJobTable — handlers are permanent)
(function initAssignModal() {
  const modal       = document.getElementById('assignChannelModal');
  const saveBtn     = document.getElementById('assignChannelSaveBtn');
  const cancelBtn   = document.getElementById('assignChannelCancelBtn');
  if (!modal || !saveBtn || !cancelBtn) return;

  cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  saveBtn.addEventListener('click', async () => {
    const controllerId  = modal.dataset.controllerId;
    const productCode   = modal.dataset.productCode;
    const jobId         = modal.dataset.jobId;
    const jobOptions    = JSON.parse(modal.dataset.jobOptions || '[]');
    const isDarkroomPro = modal.dataset.isDarkroomPro === '1';

    if (!controllerId) {
      showToast('No controller found — check Routing settings.', 'error');
      return;
    }

    if (isDarkroomPro) {
      // ── Darkroom Pro flow: validate size + media, optionally save translations,
      //    store overrides on the job, then dispatch immediately ────────────────

      // Capture all user inputs immediately — before any async operations or
      // state changes that could affect DOM reads.
      const sizeInput        = document.getElementById('dpSizeInput');
      const sizeValue        = sizeInput.value.trim();
      const saveSizeTick     = !!document.getElementById('dpSaveSizeTranslation')?.checked;
      const mediaAutoResolved = modal.dataset.dpMediaAutoResolved === '1';
      const mediaInput       = mediaAutoResolved ? null : document.getElementById('dpMediaInput');
      const saveMediaTick    = !mediaAutoResolved && !!document.getElementById('dpSaveMediaTranslation')?.checked;

      // Resolve media value — either auto-resolved or from the manual input
      let mediaValue;
      if (mediaAutoResolved) {
        mediaValue = modal.dataset.dpMediaResolvedValue;
      } else {
        mediaValue = mediaInput ? mediaInput.value.trim() : '';
      }

      // Validate before disabling the button so the user can correct errors
      if (!sizeValue) {
        sizeInput.setCustomValidity('Please enter a size value');
        sizeInput.reportValidity();
        return;
      }
      sizeInput.setCustomValidity('');

      if (!mediaValue) {
        if (mediaInput) {
          mediaInput.setCustomValidity('Please enter a media value');
          mediaInput.reportValidity();
        }
        return;
      }
      if (mediaInput) mediaInput.setCustomValidity('');

      saveBtn.disabled    = true;
      saveBtn.textContent = 'Saving...';

      try {
        // 1. Optionally persist translation entries to the controller

        if (saveSizeTick || saveMediaTick) {
          const transResult = await window.electronAPI.updateDarkroomTranslations({
            controllerId,
            sizeTranslation:  saveSizeTick  ? { productCodePrefix: productCode, darkroomSize: sizeValue } : null,
            mediaTranslation: saveMediaTick ? { from: modal.dataset.dpMediaFrom, to: mediaValue }         : null,
          });
          if (transResult && transResult.success === false) {
            throw new Error(transResult.error || 'Failed to save translations');
          }
          // Keep cachedOrderControllers in sync and re-render the controller cards
          // so the translation summary in Settings updates without a restart.
          if (transResult && transResult.controller) {
            cachedOrderControllers = cachedOrderControllers.map(c =>
              c.id === transResult.controller.id ? transResult.controller : c
            );
            renderOrderControllers(cachedOrderControllers);
          }
        }

        // 2. Store per-job size/media overrides in the job record. The
        //    `assignDarkroomSizeMedia` IPC handler fires runAutoPrint() at
        //    its tail (mirrors saveChannelMapping for DPOF) so dispatch
        //    happens through the auto-print loop's `ctrl.autoprint` gate
        //    rather than via a direct sendToPrint call here. With autoprint
        //    OFF the job is left in routable-but-pending state for manual
        //    Process action — see docs/orderhub/bugfixes.md.
        const assignResult = await window.electronAPI.assignDarkroomSizeMedia(jobId, sizeValue, mediaValue);
        if (assignResult && assignResult.success === false) {
          throw new Error(assignResult.error || 'Failed to store assignment');
        }

        modal.classList.add('hidden');
        showToast('Darkroom Pro assignment saved', 'success');
        await resolveRoutesForReceivedJobs(allJobs);
        renderJobTable(getFilteredJobs());
      } catch (err) {
        showToast('Error: ' + err.message, 'error', 8000);
      } finally {
        saveBtn.disabled    = false;
        saveBtn.textContent = 'Save & Assign';
      }
    } else {
      // ── DPOF flow: create a new permanent channel mapping ─────────────────
      const channelInput  = document.getElementById('assignChannelNumber');
      const channelNumber = parseInt(channelInput.value, 10);

      if (!channelNumber || channelNumber < 1) {
        channelInput.focus();
        channelInput.setCustomValidity('Enter a valid channel number.');
        channelInput.reportValidity();
        return;
      }
      channelInput.setCustomValidity('');

      saveBtn.disabled    = true;
      saveBtn.textContent = 'Saving...';

      const skipAutoPrint = document.getElementById('assignSkipAutoPrint').checked;

      try {
        const result = await window.electronAPI.saveChannelMapping({
          id:            crypto.randomUUID(),
          controllerId,
          productCode,
          options:       jobOptions,   // Array<{name,value}> — match this job's options
          channelNumber,
          skipAutoPrint,
        });

        if (result && result.success === false) {
          throw new Error(result.error || 'Save failed');
        }

        // Re-resolve all routes (picks up the newly saved channel mapping) then re-render
        modal.classList.add('hidden');
        showToast('Channel mapping saved — job is ready to print', 'success');
        await resolveRoutesForReceivedJobs(allJobs);
        renderJobTable(getFilteredJobs());
      } catch (err) {
        showToast('Error saving channel mapping: ' + err.message, 'error', 8000);
      } finally {
        saveBtn.disabled    = false;
        saveBtn.textContent = 'Save & Assign';
      }
    }
  });
})();

/**
 * Async-scan all jobs for DPOF output folder status.
 * For each job that has a folder, update the outputStatusCache and the table row
 * in-place without triggering a full re-render.
 */
async function refreshOutputStatuses(jobs) {
  await Promise.all(jobs.map(async job => {
    try {
      const status = await window.electronAPI.getJobOutputStatus(String(job.id));
      if (status) {
        // If the operator has flagged this job as printed (OHD-internal),
        // use the virtual 'printed' prefix so badge/actions render correctly.
        const displayStatus = status.printed
          ? { ...status, prefix: 'printed' }
          : status;
        outputStatusCache.set(String(job.id), displayStatus);
        updateJobRowStatus(String(job.id), displayStatus, job);
      }
    } catch (_) { /* ignore per-job errors */ }
  }));
}

/**
 * Update a single job's STATUS and ACTIONS cells in-place.
 * Called by refreshOutputStatuses and the ohd:job:status-changed listener.
 */
function updateJobRowStatus(jobId, status, job) {
  const tr = document.querySelector(`tr[data-job-id="${CSS.escape(jobId)}"]`);
  if (!tr) return;

  const { statusClass, statusLabel } = getDpofOutputBadge(status.prefix);

  const statusCell = tr.querySelector('.job-status-cell');
  if (statusCell) {
    statusCell.innerHTML = `<span class="${statusClass}">${escapeHtml(statusLabel)}</span>`;
  }

  // Rebuild action cell — need the review button which requires the job object
  const actionCell = tr.querySelector('.job-action-cell');
  if (actionCell && job) {
    const sidecarJobId  = job.order_number ? `${job.order_number}_${job.id}` : String(job.id);
    const jobFolderName = job.order_number && job.order_id ? `${job.order_number}_${job.order_id}` : '';
    const jobFolderPath = downloadDirectory && jobFolderName
      ? `${downloadDirectory}\\${jobFolderName}\\${sidecarJobId}`
      : '';
    const reviewBtn = `<button class="btn-action btn-review" data-sidecar-job-id="${escapeHtml(sidecarJobId)}" data-job-path="${escapeHtml(jobFolderPath)}" data-oh-job-id="${escapeHtml(String(job.id))}">Review</button>`;
    const dpofInnerHtml = getDpofOutputActionHtml(reviewBtn, jobId, status.prefix);
    if (currentFilter !== 'dismissed') {
      actionCell.innerHTML = `<div class="actions-cell-wrap">${dpofInnerHtml}<button class="btn-dismiss" data-job-id="${escapeHtml(jobId)}" title="Hide this job from the list">Dismiss</button></div>`;
      const dismissBtn = actionCell.querySelector('.btn-dismiss');
      if (dismissBtn) dismissBtn.addEventListener('click', async () => {
        dismissBtn.disabled = true;
        try {
          dismissedJobs = await window.electronAPI.dismissJob(jobId);
          updateDismissedBadge();
          const row = jobsTableBody.querySelector(`tr[data-job-id="${CSS.escape(jobId)}"]`);
          if (row) row.remove();
          showToast('Job dismissed', 'success');
        } catch (error) {
          dismissBtn.disabled = false;
          showToast('Dismiss error: ' + error.message, 'error', 5000);
        }
      });
    } else {
      actionCell.innerHTML = dpofInnerHtml;
    }

    // Re-attach listeners for the new buttons
    const resendBtn = actionCell.querySelector('.btn-resend-dpof');
    if (resendBtn) resendBtn.addEventListener('click', async () => {
      resendBtn.disabled = true; resendBtn.textContent = 'Resending...';
      const r = await window.electronAPI.resendJob(jobId);
      if (r.success) { showToast('Job resent to printer', 'success'); loadJobs(); }
      else { resendBtn.disabled = false; resendBtn.textContent = 'Resend'; showToast('Failed: ' + r.error, 'error', 8000); }
    });
    const retryBtn = actionCell.querySelector('.btn-retry-dpof');
    if (retryBtn) retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true; retryBtn.textContent = 'Retrying...';
      const r = await window.electronAPI.resendJob(jobId);
      if (r.success) { showToast('Job retry sent to printer', 'success'); loadJobs(); }
      else { retryBtn.disabled = false; retryBtn.textContent = 'Retry'; showToast('Failed: ' + r.error, 'error', 8000); }
    });

    // Re-attach Review button listener
    const reviewBtnEl = actionCell.querySelector('.btn-review');
    if (reviewBtnEl) reviewBtnEl.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('ohd:open-job-review', {
        detail: { jobId: sidecarJobId, jobPath: jobFolderPath, ohJobId: String(job.id) }
      }));
    });
  }
}

function showCopiedTooltip(event, text) {
  const tooltip = document.createElement('div');
  tooltip.className = 'copied-tooltip';
  tooltip.textContent = 'Copied!';
  tooltip.style.left = event.clientX + 'px';
  tooltip.style.top = (event.clientY - 28) + 'px';
  document.body.appendChild(tooltip);
  setTimeout(() => tooltip.remove(), 1300);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Column sorting
document.querySelectorAll('.jobs-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const field = th.dataset.sort;

    // Toggle direction
    if (currentSort.field === field) {
      currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort.field = field;
      currentSort.direction = 'asc';
    }

    // Update sort indicators
    document.querySelectorAll('.jobs-table th').forEach(h => {
      h.classList.remove('sort-asc', 'sort-desc');
    });
    th.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');

    renderJobTable(getFilteredJobs());
  });
});

// ══════════════════════════════════════
// SETTINGS: Form population & saving
// ══════════════════════════════════════

function populateForm(config) {
  document.getElementById('orderhubApiKey').value = config.orderhubApiKey || '';
  document.getElementById('organizationId').value = config.organizationId || '';
  document.getElementById('locationId').value = config.locationId || '';
  document.getElementById('ftpHost').value = config.ftpHost || '';
  document.getElementById('ftpPort').value = config.ftpPort || 21;
  document.getElementById('ftpUsername').value = config.ftpUsername || '';
  document.getElementById('ftpPassword').value = config.ftpPassword || '';
  document.getElementById('ftpRemotePath').value = config.ftpRemotePath || '/';
  document.getElementById('downloadDirectory').value = config.downloadDirectory || '';
  downloadDirectory = config.downloadDirectory || '';
  document.getElementById('pollingEnabled').checked = config.pollingEnabled || false;
  document.getElementById('launchOnStartup').checked = config.launchOnStartup || false;

  // S3 settings
  document.getElementById('s3Provider').value = config.s3Provider || 'pixfizz';
  document.getElementById('s3BucketName').value = config.s3BucketName || '';
  document.getElementById('s3Region').value = config.s3Region || '';
  document.getElementById('s3AccessKeyId').value = config.s3AccessKeyId || '';
  document.getElementById('s3SecretAccessKey').value = config.s3SecretAccessKey || '';
  toggleS3AmazonFields();

  // Film Scans
  document.getElementById('filmScansEnabled').checked = config.filmScansEnabled || false;
  document.getElementById('filmScansWatchFolder').value = config.filmScansWatchFolder || '';
  document.getElementById('filmScansStorageFolder').value = config.filmScansStorageFolder || '';
  document.getElementById('filmScansAutoSyncMinutes').value = config.filmScansAutoSyncMinutes || 5;
  document.getElementById('filmScansWatchguardMinutes').value = config.filmScansWatchguardMinutes || 5;

  // Film Scans — AI Rotation + Review Mode (M7-8 + M9)
  const aiRotEl = document.getElementById('filmScanRotationEnabled');
  if (aiRotEl) aiRotEl.checked = !!config.filmScanRotationEnabled;
  // Review Mode is a tri-state radio group; default to 'never' if the loaded
  // config is missing or malformed.
  const reviewMode = (config.filmScanReviewMode === 'always' || config.filmScanReviewMode === 'smart')
    ? config.filmScanReviewMode
    : 'never';
  const reviewRadio = document.getElementById('filmScanReviewMode_' + reviewMode);
  if (reviewRadio) reviewRadio.checked = true;
  updateFilmScanRotationEnableState();

  // AI Quality Gate (v1.2.0)
  const aiQEnabled = document.getElementById('aiQualityEnabled');
  const aiQThreshold = document.getElementById('aiQualityThreshold');
  const aiQDebug = document.getElementById('aiQualityDebugLog');
  const aiQHoldAutoPrint = document.getElementById('aiQualityHoldAutoPrint');
  if (aiQEnabled)   aiQEnabled.checked   = !!config.aiQualityEnabled;
  if (aiQThreshold) aiQThreshold.value   = config.aiQualityThreshold || 50;
  if (aiQDebug)     aiQDebug.checked     = !!config.aiQualityDebugLog;
  if (aiQHoldAutoPrint) aiQHoldAutoPrint.checked = config.aiQualityMode === 'block';
  updateAiQualityEnableState();

  // File Uploads
  document.getElementById('fileUploadsEnabled').checked = config.fileUploadsEnabled || false;
  document.getElementById('fileUploadsWatchFolder').value = config.fileUploadsWatchFolder || '';
  document.getElementById('fileUploadsStorageFolder').value = config.fileUploadsStorageFolder || '';
  document.getElementById('fileUploadsAutoSyncMinutes').value = config.fileUploadsAutoSyncMinutes || 5;
  document.getElementById('fileUploadsWatchguardMinutes').value = config.fileUploadsWatchguardMinutes || 5;

  // Shared
  document.getElementById('pollingInterval').value = config.pollingInterval || 60;

  // Process folder
  document.getElementById('processFolderPath').value = config.processFolderPath || '';


  // AI Enhancement
  document.getElementById('enhancementProvider').value = config.enhancementProvider || 'local';
  document.getElementById('topazApiKey').value = config.topazApiKey || '';
  document.getElementById('topazDefaultModel').value = config.topazDefaultModel || 'Standard V2';
  document.getElementById('enhancementFaceEnhancement').checked = config.enhancementFaceEnhancement || false;
  document.getElementById('enhancementAutoEnhance').checked = config.enhancementAutoEnhance || false;
  // Pixfizz AI Enhancement advanced fields — defaults match plan §0.10.
  document.getElementById('enhancementLocalTileSize').value =
    Number.isFinite(config.enhancementLocalTileSize) ? config.enhancementLocalTileSize : 256;
  document.getElementById('enhancementLocalTileOverlap').value =
    Number.isFinite(config.enhancementLocalTileOverlap) ? config.enhancementLocalTileOverlap : 16;
  updateEnhancementProviderSections();

  // Update enable states based on folders
  updateFilmScansEnableState();
  updateFileUploadsEnableState();
}

function getFormData() {
  return {
    orderhubApiKey: document.getElementById('orderhubApiKey').value.trim(),
    organizationId: document.getElementById('organizationId').value.trim(),
    locationId: document.getElementById('locationId').value.trim(),
    ftpHost: document.getElementById('ftpHost').value.trim(),
    ftpPort: parseInt(document.getElementById('ftpPort').value, 10),
    ftpUsername: document.getElementById('ftpUsername').value.trim(),
    ftpPassword: document.getElementById('ftpPassword').value,
    ftpRemotePath: document.getElementById('ftpRemotePath').value.trim() || '/',
    downloadDirectory: document.getElementById('downloadDirectory').value.trim(),
    pollingEnabled: document.getElementById('pollingEnabled').checked,
    launchOnStartup: document.getElementById('launchOnStartup').checked,
    // S3
    s3Provider: document.getElementById('s3Provider').value,
    s3BucketName: document.getElementById('s3BucketName').value.trim(),
    s3Region: document.getElementById('s3Region').value.trim(),
    s3AccessKeyId: document.getElementById('s3AccessKeyId').value.trim(),
    s3SecretAccessKey: document.getElementById('s3SecretAccessKey').value,
    // Film Scans
    filmScansEnabled: document.getElementById('filmScansEnabled').checked,
    filmScansWatchFolder: document.getElementById('filmScansWatchFolder').value.trim(),
    filmScansStorageFolder: document.getElementById('filmScansStorageFolder').value.trim(),
    filmScansAutoSyncMinutes: parseInt(document.getElementById('filmScansAutoSyncMinutes').value, 10) || 5,
    filmScansWatchguardMinutes: parseInt(document.getElementById('filmScansWatchguardMinutes').value, 10) || 5,
    // Film Scans — AI Rotation + Review Mode (M7-8 + M9). When AI is off we
    // force review mode back to 'never' — Smart/Always are meaningless without
    // AI metadata to review. The UI disables the radios in that state, but
    // defensive code here keeps the IPC boundary clean.
    filmScanRotationEnabled: document.getElementById('filmScanRotationEnabled').checked,
    filmScanReviewMode: (() => {
      const aiOn = document.getElementById('filmScanRotationEnabled').checked;
      if (!aiOn) return 'never';
      const checked = document.querySelector('input[name="filmScanReviewMode"]:checked');
      const v = checked ? checked.value : 'never';
      return (v === 'smart' || v === 'always') ? v : 'never';
    })(),
    // AI Quality Gate (v1.2.0)
    aiQualityEnabled:    document.getElementById('aiQualityEnabled')?.checked || false,
    aiQualityThreshold:  parseInt(document.getElementById('aiQualityThreshold')?.value, 10) || 50,
    aiQualityDebugLog:   document.getElementById('aiQualityDebugLog')?.checked || false,
    aiQualityMode:       document.getElementById('aiQualityHoldAutoPrint')?.checked ? 'block' : 'warn',
    // File Uploads
    fileUploadsEnabled: document.getElementById('fileUploadsEnabled').checked,
    fileUploadsWatchFolder: document.getElementById('fileUploadsWatchFolder').value.trim(),
    fileUploadsStorageFolder: document.getElementById('fileUploadsStorageFolder').value.trim(),
    fileUploadsAutoSyncMinutes: parseInt(document.getElementById('fileUploadsAutoSyncMinutes').value, 10) || 5,
    fileUploadsWatchguardMinutes: parseInt(document.getElementById('fileUploadsWatchguardMinutes').value, 10) || 5,
    // Shared
    pollingInterval: parseInt(document.getElementById('pollingInterval').value, 10) || 60,
    // Process folder
    processFolderPath: document.getElementById('processFolderPath').value.trim(),
    // AI Enhancement
    enhancementProvider: document.getElementById('enhancementProvider').value,
    topazApiKey: document.getElementById('topazApiKey').value,
    topazDefaultModel: document.getElementById('topazDefaultModel').value,
    enhancementFaceEnhancement: document.getElementById('enhancementFaceEnhancement').checked,
    enhancementAutoEnhance: document.getElementById('enhancementAutoEnhance').checked,
    enhancementLocalTileSize: parseInt(document.getElementById('enhancementLocalTileSize').value, 10) || 256,
    enhancementLocalTileOverlap: parseInt(document.getElementById('enhancementLocalTileOverlap').value, 10) || 16,
  };
}

// Show status message (Settings tab only)
function showStatus(message, type = 'info') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
  statusMessage.style.display = '';

  if (type === 'success') {
    setTimeout(() => {
      statusMessage.className = 'status-message';
    }, 5000);
  }
}

// Show global toast notification (visible from any tab)
let toastTimer = null;
function showToast(message, type = 'info', duration = 6000) {
  if (toastTimer) clearTimeout(toastTimer);
  toastNotification.textContent = message;
  toastNotification.className = `toast-notification ${type}`;
  toastTimer = setTimeout(() => {
    toastNotification.className = 'toast-notification hidden';
    toastTimer = null;
  }, duration);
}

// Save configuration
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const config = getFormData();

  // Conditional validation based on enabled modes
  if (config.pollingEnabled) {
    if (!config.orderhubApiKey) {
      showStatus('Please fill in the OrderHub API Key (required for polling)', 'error');
      return;
    }
    if (!config.organizationId) {
      showStatus('Please fill in the Organization ID (required for polling)', 'error');
      return;
    }
    if (!config.locationId) {
      showStatus('Please fill in the Location ID (required for polling)', 'error');
      return;
    }
    if (!config.ftpHost || !config.ftpUsername || !config.ftpPassword) {
      showStatus('Please fill in FTP server settings (required for polling)', 'error');
      return;
    }
    if (!config.downloadDirectory) {
      showStatus('Please select a download directory (required for polling)', 'error');
      return;
    }
  }

  if (config.filmScansEnabled || config.fileUploadsEnabled) {
    if (!config.s3BucketName) {
      showStatus('Please fill in S3 Bucket Name (required for Film Scans / File Uploads)', 'error');
      return;
    }
    if (config.s3Provider === 'amazon') {
      if (!config.s3Region) {
        showStatus('Please fill in AWS Region (required for Amazon S3)', 'error');
        return;
      }
      if (!config.s3AccessKeyId || !config.s3SecretAccessKey) {
        showStatus('Please fill in AWS Access Key ID and Secret Access Key (required for Amazon S3)', 'error');
        return;
      }
    }
  }

  if (config.filmScansEnabled) {
    if (!config.filmScansWatchFolder) {
      showStatus('Please select a Film Scans watch folder', 'error');
      return;
    }
    if (!config.filmScansStorageFolder) {
      showStatus('Please select a Film Scans storage folder', 'error');
      return;
    }
  }

  if (config.fileUploadsEnabled) {
    if (!config.fileUploadsWatchFolder) {
      showStatus('Please select a File Uploads watch folder', 'error');
      return;
    }
    if (!config.fileUploadsStorageFolder) {
      showStatus('Please select a File Uploads storage folder', 'error');
      return;
    }
  }

  try {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    await window.electronAPI.saveConfig(config);
    downloadDirectory = config.downloadDirectory || '';
    // Default folder change may unblock previously-warning jobs — re-evaluate immediately
    resolveRoutesForReceivedJobs(allJobs).then(() => renderJobTable(getFilteredJobs()));
    // Re-evaluate tab visibility — toggling pollingEnabled or filmScansEnabled
    // in Settings should immediately add/remove the corresponding tab without
    // requiring an app restart.
    updateTabVisibility(config);
    showStatus('Settings saved successfully!', 'success');
  } catch (error) {
    showStatus('Error saving settings: ' + error.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  }
});

// ══════════════════════════════════════
// SETTINGS: Directory pickers
// ══════════════════════════════════════

selectDirBtn.addEventListener('click', async () => {
  try {
    const result = await window.electronAPI.selectDirectory();
    if (result) {
      document.getElementById('downloadDirectory').value = result;
    }
  } catch (error) {
    showStatus('Error selecting directory: ' + error.message, 'error');
  }
});

async function selectDirectoryFor(inputId) {
  try {
    const result = await window.electronAPI.selectDirectory();
    if (result) {
      document.getElementById(inputId).value = result;
    }
  } catch (error) {
    showStatus('Error selecting directory: ' + error.message, 'error');
  }
}

selectFilmScansWatchBtn.addEventListener('click', async () => {
  await selectDirectoryFor('filmScansWatchFolder');
  updateFilmScansEnableState();
});
selectFilmScansStorageBtn.addEventListener('click', async () => {
  await selectDirectoryFor('filmScansStorageFolder');
  updateFilmScansEnableState();
});
selectFileUploadsWatchBtn.addEventListener('click', async () => {
  await selectDirectoryFor('fileUploadsWatchFolder');
  updateFileUploadsEnableState();
});
selectFileUploadsStorageBtn.addEventListener('click', async () => {
  await selectDirectoryFor('fileUploadsStorageFolder');
  updateFileUploadsEnableState();
});
selectProcessFolderBtn.addEventListener('click', () => selectDirectoryFor('processFolderPath'));

// M7-8: keep Manual Rotation Check coupled to Enable AI Rotation. Defensive
// optional chaining — these elements only exist on builds that include the
// Film Scans tab markup (they always do today, but render order during
// reload could fire this before the DOM is ready).
const aiRotationCheckbox = document.getElementById('filmScanRotationEnabled');
if (aiRotationCheckbox) {
  aiRotationCheckbox.addEventListener('change', updateFilmScanRotationEnableState);
}

const aiQualityEnabledCheckbox = document.getElementById('aiQualityEnabled');
if (aiQualityEnabledCheckbox) {
  aiQualityEnabledCheckbox.addEventListener('change', updateAiQualityEnableState);
}

/**
 * Enable/disable the Film Scans checkbox based on whether both folders are set.
 */
function updateFilmScansEnableState() {
  const watchFolder = document.getElementById('filmScansWatchFolder').value.trim();
  const storageFolder = document.getElementById('filmScansStorageFolder').value.trim();
  const enableCheckbox = document.getElementById('filmScansEnabled');
  const bothSet = !!(watchFolder && storageFolder);

  enableCheckbox.disabled = !bothSet;
  if (!bothSet) {
    enableCheckbox.checked = false;
  }
}

/**
 * M7-8 + M9: Review Mode is meaningless without AI Rotation, since there's
 * nothing to review. When AI is off we disable all three radio options + grey
 * the group, and force the selection back to 'never' so a save in the AI-off
 * state can't persist Smart/Always.
 */
function updateFilmScanRotationEnableState() {
  const aiEl  = document.getElementById('filmScanRotationEnabled');
  const grp   = document.getElementById('filmScanReviewModeGroup');
  if (!aiEl || !grp) return;
  const aiOn = aiEl.checked;
  const radios = grp.querySelectorAll('input[name="filmScanReviewMode"]');
  radios.forEach((r) => { r.disabled = !aiOn; });
  grp.style.opacity = aiOn ? '' : '0.5';
  if (!aiOn) {
    const neverEl = document.getElementById('filmScanReviewMode_never');
    if (neverEl) neverEl.checked = true;
  }
}

function updateAiQualityEnableState() {
  const enabledEl = document.getElementById('aiQualityEnabled');
  const holdEl = document.getElementById('aiQualityHoldAutoPrint');
  if (!enabledEl || !holdEl) return;
  holdEl.disabled = !enabledEl.checked;
}

/**
 * Enable/disable the File Uploads checkbox based on whether both folders are set.
 */
function updateFileUploadsEnableState() {
  const watchFolder = document.getElementById('fileUploadsWatchFolder').value.trim();
  const storageFolder = document.getElementById('fileUploadsStorageFolder').value.trim();
  const enableCheckbox = document.getElementById('fileUploadsEnabled');
  const bothSet = !!(watchFolder && storageFolder);

  enableCheckbox.disabled = !bothSet;
  if (!bothSet) {
    enableCheckbox.checked = false;
  }
}

// ══════════════════════════════════════
// SETTINGS: Connection testing
// ══════════════════════════════════════

function showTestStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `test-status ${type}`;

  if (type === 'success') {
    setTimeout(() => {
      el.textContent = '';
      el.className = 'test-status';
    }, 5000);
  }
}

// S3 provider toggle
function toggleS3AmazonFields() {
  const provider = document.getElementById('s3Provider').value;
  document.getElementById('s3AmazonFields').style.display = provider === 'amazon' ? '' : 'none';
}
document.getElementById('s3Provider').addEventListener('change', toggleS3AmazonFields);

// Test S3
testS3Btn.addEventListener('click', async () => {
  const provider = document.getElementById('s3Provider').value;
  const bucketName = document.getElementById('s3BucketName').value.trim();

  if (!bucketName) {
    showTestStatus('s3TestStatus', 'Please fill in Bucket Name', 'error');
    return;
  }

  if (provider === 'amazon') {
    const region = document.getElementById('s3Region').value.trim();
    const accessKeyId = document.getElementById('s3AccessKeyId').value.trim();
    const secretAccessKey = document.getElementById('s3SecretAccessKey').value;
    if (!region || !accessKeyId || !secretAccessKey) {
      showTestStatus('s3TestStatus', 'Please fill in AWS Region, Access Key ID and Secret Access Key', 'error');
      return;
    }
  }

  try {
    testS3Btn.disabled = true;
    testS3Btn.textContent = 'Testing...';

    const s3Config = {
      provider,
      bucketName,
      region: document.getElementById('s3Region').value.trim(),
      accessKeyId: document.getElementById('s3AccessKeyId').value.trim(),
      secretAccessKey: document.getElementById('s3SecretAccessKey').value
    };

    const result = await window.electronAPI.testS3Connection(s3Config);

    if (result.success) {
      showTestStatus('s3TestStatus', 'Connection successful!', 'success');
    } else {
      showTestStatus('s3TestStatus', 'Failed: ' + result.error, 'error');
    }
  } catch (error) {
    showTestStatus('s3TestStatus', 'Error: ' + error.message, 'error');
  } finally {
    testS3Btn.disabled = false;
    testS3Btn.textContent = 'Test Connection';
  }
});

// Test FTP
testFtpBtn.addEventListener('click', async () => {
  const credentials = {
    host: document.getElementById('ftpHost').value.trim(),
    port: parseInt(document.getElementById('ftpPort').value, 10),
    user: document.getElementById('ftpUsername').value.trim(),
    password: document.getElementById('ftpPassword').value
  };

  if (!credentials.host || !credentials.user || !credentials.password) {
    showTestStatus('ftpTestStatus', 'Please fill in all FTP settings first', 'error');
    return;
  }

  try {
    testFtpBtn.disabled = true;
    testFtpBtn.textContent = 'Testing...';

    const result = await window.electronAPI.testFtpConnection(credentials);

    if (result.success) {
      showTestStatus('ftpTestStatus', 'Connection successful!', 'success');
    } else {
      showTestStatus('ftpTestStatus', 'Failed: ' + result.error, 'error');
    }
  } catch (error) {
    showTestStatus('ftpTestStatus', 'Error: ' + error.message, 'error');
  } finally {
    testFtpBtn.disabled = false;
    testFtpBtn.textContent = 'Test Connection';
  }
});

// ── AI Enhancement — provider section toggle ──────────────────────────────────

/**
 * Show/hide provider-specific Settings sections based on the dropdown
 * selection. Also hides the Topaz <option> entirely (not just disables it)
 * when no Topaz API key is configured — Pixfizz AI Enhancement is the only
 * choice on installs without a Topaz subscription.
 */
function updateEnhancementProviderSections() {
  const select = document.getElementById('enhancementProvider');
  const topazOption = select.querySelector('option[value="topaz"]');
  const topazKey = (document.getElementById('topazApiKey').value || '').trim();

  if (topazOption) {
    if (topazKey) {
      topazOption.hidden = false;
    } else {
      topazOption.hidden = true;
      // If Topaz is currently selected but no key is set, fall back to local
      // so the user isn't stuck on a hidden option.
      if (select.value === 'topaz') select.value = 'local';
    }
  }

  const provider = select.value;
  document.getElementById('localSection').style.display = (provider === 'local') ? '' : 'none';
  document.getElementById('topazSection').style.display = (provider === 'topaz') ? '' : 'none';
}

document.getElementById('enhancementProvider').addEventListener('change', updateEnhancementProviderSections);
// Re-run the visibility logic when the Topaz key field changes — if the
// user pastes a key, the Topaz option should appear without a save.
document.getElementById('topazApiKey').addEventListener('input', updateEnhancementProviderSections);

// ── Pixfizz AI Enhancement — Test button ─────────────────────────────────────
// Calls localClient.selfTest() via the existing enhancement:test IPC route.
// The main-side handler special-cases provider === 'local' to dispatch to
// selfTest (a real one-tile inference) instead of the API-key validator.

testLocalBtn.addEventListener('click', async () => {
  try {
    testLocalBtn.disabled    = true;
    testLocalBtn.textContent = 'Testing...';
    showTestStatus('localTestStatus', 'Running model on a small test image…', 'info');
    const result = await window.electronAPI.enhancementTest({ apiKey: '', provider: 'local' });
    if (result.valid) {
      const dur = result.durationMs ? ` in ${result.durationMs} ms` : '';
      const ep  = result.executionProvider ? ` (${result.executionProvider.toUpperCase()})` : '';
      showTestStatus('localTestStatus', `✓ Model loaded successfully${dur}${ep}`, 'success');
    } else {
      showTestStatus('localTestStatus', 'Failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    showTestStatus('localTestStatus', 'Error: ' + error.message, 'error');
  } finally {
    testLocalBtn.disabled    = false;
    testLocalBtn.textContent = 'Test';
  }
});

// ── Topaz API key — show/hide toggle and test ─────────────────────────────────

document.getElementById('topazApiKeyToggle').addEventListener('click', () => {
  const input = document.getElementById('topazApiKey');
  const btn   = document.getElementById('topazApiKeyToggle');
  if (input.type === 'password') {
    input.type      = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type      = 'password';
    btn.textContent = 'Show';
  }
});

testTopazBtn.addEventListener('click', async () => {
  const apiKey = document.getElementById('topazApiKey').value.trim();
  if (!apiKey) {
    showTestStatus('topazTestStatus', 'Please enter an API key first', 'error');
    return;
  }
  try {
    testTopazBtn.disabled    = true;
    testTopazBtn.textContent = 'Testing...';
    const result = await window.electronAPI.enhancementTest({ apiKey, provider: 'topaz' });
    if (result.valid) {
      showTestStatus('topazTestStatus', '✓ API key is valid', 'success');
    } else {
      showTestStatus('topazTestStatus', 'Invalid: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    showTestStatus('topazTestStatus', 'Error: ' + error.message, 'error');
  } finally {
    testTopazBtn.disabled    = false;
    testTopazBtn.textContent = 'Test API Key';
  }
});

// Test API
testApiBtn.addEventListener('click', async () => {
  const key = document.getElementById('orderhubApiKey').value.trim();

  if (!key) {
    showTestStatus('apiTestStatus', 'Please fill in the API Key first', 'error');
    return;
  }

  try {
    testApiBtn.disabled = true;
    testApiBtn.textContent = 'Testing...';

    const result = await window.electronAPI.testApiConnection(key);

    if (result.success) {
      showTestStatus('apiTestStatus', 'Connection successful!', 'success');
    } else {
      showTestStatus('apiTestStatus', 'Failed: ' + result.error, 'error');
    }
  } catch (error) {
    showTestStatus('apiTestStatus', 'Error: ' + error.message, 'error');
  } finally {
    testApiBtn.disabled = false;
    testApiBtn.textContent = 'Test Connection';
  }
});

// ══════════════════════════════════════
// SETTINGS: Scan & Download FTP
// ══════════════════════════════════════

const scanDownloadBtn = document.getElementById('scanDownloadBtn');
const downloadProgress = document.getElementById('downloadProgress');

window.electronAPI.onDownloadProgress((progress) => {
  downloadProgress.textContent = progress.message;
  downloadProgress.className = 'download-progress ' + progress.status;
});

scanDownloadBtn.addEventListener('click', async () => {
  try {
    scanDownloadBtn.disabled = true;
    scanDownloadBtn.textContent = 'Downloading...';
    downloadProgress.textContent = 'Starting...';
    downloadProgress.className = 'download-progress downloading';

    const result = await window.electronAPI.scanAndDownloadFtp();

    if (result.success) {
      const s = result.summary;
      downloadProgress.textContent = `Complete - ${s.downloaded} downloaded, ${s.skipped} skipped, ${s.failed} failed`;
      downloadProgress.className = 'download-progress complete';
    } else {
      downloadProgress.textContent = 'Error: ' + result.error;
      downloadProgress.className = 'download-progress error';
    }
  } catch (error) {
    downloadProgress.textContent = 'Error: ' + error.message;
    downloadProgress.className = 'download-progress error';
  } finally {
    scanDownloadBtn.disabled = false;
    scanDownloadBtn.textContent = 'Scan & Download';
  }
});

// ══════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════

const activityLogContainer = document.getElementById('activityLogContainer');
const activityEmptyState = document.getElementById('activityEmptyState');
const activityLevelFilter = document.getElementById('activityLevelFilter');
const activityTextFilter = document.getElementById('activityTextFilter');
const activityTextFilterClear = document.getElementById('activityTextFilterClear');
const activityRefreshBtn = document.getElementById('activityRefreshBtn');
const activityCopyBtn = document.getElementById('activityCopyBtn');
const activityExportBtn = document.getElementById('activityExportBtn');
const activityStatusBar = document.getElementById('activityStatusBar');

let activityLogsPath = '';
let activityLoaded = false;
let allActivityEntries = [];   // full result from last readLogs call
let activityTotalLines = 0;    // raw line count from last readLogs call

// Load logs path on startup
(async () => {
  try {
    activityLogsPath = await window.electronAPI.getLogsPath();
  } catch (e) {
    console.error('Error getting logs path:', e);
  }
})();

async function loadActivityLog() {
  const level = activityLevelFilter.value;

  try {
    const data = await window.electronAPI.readLogs({ level });
    allActivityEntries = data.entries || [];
    activityTotalLines = data.totalLines || 0;
    applyActivityFilters(data);
  } catch (error) {
    console.error('Error loading activity log:', error);
    activityStatusBar.textContent = 'Error loading log: ' + error.message;
  }
}

function applyActivityFilters(data) {
  const level    = activityLevelFilter.value;
  const textRaw  = activityTextFilter ? activityTextFilter.value : '';
  const needle   = textRaw.trim().toLowerCase();
  const entries  = needle
    ? allActivityEntries.filter(e => (e.message || '').toLowerCase().includes(needle))
    : allActivityEntries;

  if (entries.length === 0) {
    activityLogContainer.style.display = 'none';
    activityEmptyState.classList.remove('hidden');
  } else {
    activityEmptyState.classList.add('hidden');
    activityLogContainer.style.display = '';

    activityLogContainer.innerHTML = '';
    for (const entry of entries) {
      const div = document.createElement('div');
      div.className = `log-entry log-level-${entry.level}`;

      const ts = document.createElement('span');
      ts.className = 'log-timestamp';
      ts.textContent = entry.timestamp;

      const badge = document.createElement('span');
      badge.className = 'log-level-badge';
      badge.textContent = entry.level.toUpperCase();

      const msg = document.createElement('span');
      msg.className = 'log-message';
      msg.textContent = entry.message;

      div.appendChild(ts);
      div.appendChild(badge);
      div.appendChild(msg);

      // Show expandable stack trace if present
      if (entry.stack) {
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'log-details-toggle';
        toggleBtn.textContent = '▶';
        toggleBtn.title = 'Show stack trace';
        div.appendChild(toggleBtn);

        const details = document.createElement('pre');
        details.className = 'log-details hidden';
        details.textContent = entry.stack;

        toggleBtn.addEventListener('click', () => {
          const isHidden = details.classList.toggle('hidden');
          toggleBtn.textContent = isHidden ? '▶' : '▼';
          toggleBtn.title = isHidden ? 'Show stack trace' : 'Hide stack trace';
        });

        div.appendChild(details);
      }

      activityLogContainer.appendChild(div);
    }
  }

  // Update status bar
  const levelLabel = level === 'all' ? '' : ` (level: ${level})`;
  const textLabel  = needle ? ` (text: "${textRaw.trim()}")` : '';
  const rawInfo    = (data || {}).rawLineCount ? ` (${data.rawLineCount} raw lines)` : '';
  activityStatusBar.textContent = `Showing ${entries.length} of ${activityTotalLines} entries${rawInfo}${levelLabel}${textLabel} \u2014 ${activityLogsPath}`;
}

// Auto-load when Activity Log tab is clicked
document.querySelectorAll('.tab-bar .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'activity') {
      loadActivityLog();
    }
  });
});

// Level filter — re-fetches from main process (server-side level filter)
activityLevelFilter.addEventListener('change', () => {
  loadActivityLog();
});

// Text filter — client-side only, no re-fetch needed
activityTextFilter.addEventListener('input', () => {
  const hasText = activityTextFilter.value.length > 0;
  activityTextFilterClear.classList.toggle('hidden', !hasText);
  applyActivityFilters();
});

activityTextFilterClear.addEventListener('click', () => {
  activityTextFilter.value = '';
  activityTextFilterClear.classList.add('hidden');
  applyActivityFilters();
  activityTextFilter.focus();
});

// Refresh
activityRefreshBtn.addEventListener('click', () => {
  loadActivityLog();
});

// Copy to clipboard
activityCopyBtn.addEventListener('click', () => {
  const entries = activityLogContainer.querySelectorAll('.log-entry');
  if (entries.length === 0) return;

  const text = Array.from(entries).map(el => {
    const ts = el.querySelector('.log-timestamp').textContent;
    const level = el.querySelector('.log-level-badge').textContent;
    const msg = el.querySelector('.log-message').textContent;
    return `${ts} [${level}]: ${msg}`;
  }).join('\n');

  navigator.clipboard.writeText(text).then(() => {
    const origText = activityCopyBtn.textContent;
    activityCopyBtn.textContent = 'Copied!';
    setTimeout(() => { activityCopyBtn.textContent = origText; }, 1500);
  });
});

// Export to file
activityExportBtn.addEventListener('click', async () => {
  const entries = activityLogContainer.querySelectorAll('.log-entry');
  if (entries.length === 0) return;

  const text = Array.from(entries).map(el => {
    const ts = el.querySelector('.log-timestamp').textContent;
    const level = el.querySelector('.log-level-badge').textContent;
    const msg = el.querySelector('.log-message').textContent;
    return `${ts} [${level}]: ${msg}`;
  }).join('\n');

  try {
    activityExportBtn.disabled = true;
    activityExportBtn.textContent = 'Exporting...';

    const result = await window.electronAPI.exportLogs(text);

    if (result.success) {
      activityExportBtn.textContent = 'Exported!';
      setTimeout(() => { activityExportBtn.textContent = 'Export'; activityExportBtn.disabled = false; }, 1500);
    } else if (result.canceled) {
      activityExportBtn.textContent = 'Export';
      activityExportBtn.disabled = false;
    } else {
      activityExportBtn.textContent = 'Export';
      activityExportBtn.disabled = false;
      showStatus('Export failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    activityExportBtn.textContent = 'Export';
    activityExportBtn.disabled = false;
    showStatus('Export error: ' + error.message, 'error');
  }
});

// ══════════════════════════════════════
// LAST CHECK TIME POLLING (Film Scans + File Uploads)
// ══════════════════════════════════════

function formatCheckTime(timestamp) {
  if (!timestamp) return 'Never';
  const d = new Date(timestamp);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function updateLastCheckTimes() {
  try {
    const status = await window.electronAPI.getPollingStatus();

    const filmEl = document.getElementById('filmScansLastCheck');
    if (filmEl) filmEl.textContent = formatCheckTime(status.lastFilmScansCheck);

    const fileEl = document.getElementById('fileUploadsLastCheck');
    if (fileEl) fileEl.textContent = formatCheckTime(status.lastFileUploadsCheck);
  } catch (e) {
    // Silently ignore — status endpoint may not be ready yet
  }
}
setInterval(updateLastCheckTimes, 10000);
updateLastCheckTimes();

// ══════════════════════════════════════
// PRINT CONTROLLERS
// ══════════════════════════════════════

async function loadPrintControllers() {
  try {
    const controllers = await window.electronAPI.getPrintControllers();
    cachedControllers = controllers;
    renderPrintControllers(cachedControllers);
  } catch (error) {
    console.error('Error loading print controllers:', error);
  }
}

function renderPrintControllers(controllers) {
  printControllersList.innerHTML = '';
  for (const controller of controllers) {
    addControllerCard(controller);
  }
}

function addControllerCard(controller = null) {
  const isNew = !controller;
  const card = document.createElement('div');
  card.className = 'controller-card' + (isNew ? ' expanded' : '');
  card.dataset.controllerId = controller ? controller.id : '';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'controller-header';

  const expandIcon = document.createElement('span');
  expandIcon.className = 'controller-expand-icon';
  expandIcon.textContent = '\u25B6';

  const headerName = document.createElement('span');
  headerName.className = 'controller-header-name';
  headerName.textContent = controller ? controller.name : 'New Controller';

  const headerType = document.createElement('span');
  headerType.className = 'controller-header-type';
  headerType.textContent = controller ? controller.type : '';

  const activeBadge = document.createElement('span');
  const isActive = controller ? controller.isActive : true;
  activeBadge.className = 'controller-active-badge ' + (isActive ? 'active' : 'inactive');
  activeBadge.textContent = isActive ? 'Active' : 'Inactive';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'controller-delete-btn';
  deleteBtn.textContent = '\u00D7';
  deleteBtn.title = 'Delete controller';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this controller and all its product mappings?')) return;
    if (controller && controller.id) {
      try {
        await window.electronAPI.deletePrintController(controller.id);
      } catch (err) {
        showStatus('Error deleting controller: ' + err.message, 'error');
        return;
      }
    }
    card.remove();
  });

  header.appendChild(expandIcon);
  header.appendChild(headerName);
  header.appendChild(headerType);
  header.appendChild(activeBadge);
  header.appendChild(deleteBtn);

  header.addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'controller-body';

  const currentType = controller ? controller.type : 'noritsu';
  const isDarkroomPro = () => body.querySelector('.ctrl-type').value === 'darkroompro';

  // Type + Name row
  const row1 = document.createElement('div');
  row1.className = 'form-row';
  row1.innerHTML = `
    <div class="form-group">
      <label>Type</label>
      <select class="ctrl-type">
        <option value="noritsu" ${currentType === 'noritsu' ? 'selected' : ''}>Noritsu</option>
        <option value="epson" ${currentType === 'epson' ? 'selected' : ''}>Epson</option>
        <option value="darkroompro" ${currentType === 'darkroompro' ? 'selected' : ''}>Darkroom Pro</option>
      </select>
    </div>
    <div class="form-group" style="flex:2">
      <label>Name</label>
      <input type="text" class="ctrl-name" value="${escapeHtml(controller ? controller.name : '')}" placeholder="e.g. Darkroom Pro Station 1">
    </div>
  `;

  // Vendor row — DPOF only (hidden for Darkroom Pro)
  const row2 = document.createElement('div');
  row2.className = 'form-row ctrl-dpof-only';
  row2.innerHTML = `
    <div class="form-group">
      <label>Vendor Name</label>
      <input type="text" class="ctrl-vendor-name" value="${escapeHtml(controller ? (controller.vendorName || '') : '')}" placeholder="e.g. NORITSU KOKI">
    </div>
    <div class="form-group">
      <label>Vendor Attribute</label>
      <input type="text" class="ctrl-vendor-attr" value="${escapeHtml(controller ? (controller.vendorAttribute || '') : '')}" placeholder="e.g. QSS-3901">
    </div>
  `;

  // Hot folder row — all types
  const row3 = document.createElement('div');
  row3.className = 'form-group';
  row3.innerHTML = `
    <label>Hot Folder Path</label>
    <div class="input-with-button">
      <input type="text" class="ctrl-hot-folder" value="${escapeHtml(controller ? (controller.hotFolderPath || '') : '')}" placeholder="C:\\Print\\HotFolder" readonly>
      <button type="button" class="btn-browse ctrl-browse-btn">Browse...</button>
    </div>
  `;

  // Darkroom Pro extra fields row
  const rowDP = document.createElement('div');
  rowDP.className = 'ctrl-dp-only';
  rowDP.innerHTML = `
    <div class="form-group">
      <label>Processed Folder Name</label>
      <input type="text" class="ctrl-processed-folder" value="${escapeHtml(controller ? (controller.processedFolderName || 'processed') : 'processed')}" placeholder="processed">
    </div>
    <div class="form-group checkbox-group">
      <label>
        <input type="checkbox" class="ctrl-index-print" ${controller && controller.indexPrint ? 'checked' : ''}>
        <span>Index Print</span>
      </label>
    </div>
  `;

  // Auto Correct + Active row
  const row4 = document.createElement('div');
  row4.innerHTML = `
    <div class="form-group checkbox-group ctrl-dpof-only">
      <label>
        <input type="checkbox" class="ctrl-auto-correct" ${controller && controller.autoCorrect ? 'checked' : ''}>
        <span>Auto Correct</span>
      </label>
    </div>
    <div class="form-group checkbox-group">
      <label>
        <input type="checkbox" class="ctrl-active" ${isActive ? 'checked' : ''}>
        <span>Active</span>
      </label>
    </div>
  `;

  // Save button
  const saveRow = document.createElement('div');
  saveRow.style.marginTop = '10px';
  saveRow.innerHTML = `<button type="button" class="btn-primary ctrl-save-btn" style="padding:6px 20px;font-size:12px;">Save Controller</button>`;

  // ── Product Mappings Section ──
  const channelsSection = document.createElement('div');
  channelsSection.className = 'channels-section';

  const channelsTitle = document.createElement('div');
  channelsTitle.className = 'channels-section-title';
  channelsTitle.textContent = 'Product Mappings';

  // Product mappings table header
  const channelsHeader = document.createElement('div');
  channelsHeader.className = 'channels-header';
  channelsHeader.innerHTML = `
    <span style="flex:1.2">Product Code</span>
    <span style="width:60px">Size</span>
    <span style="flex:2">Options</span>
    <span style="width:50px;text-align:center">Ch #</span>
    <span style="width:28px"></span>
  `;

  const channelsList = document.createElement('div');
  channelsList.className = 'channels-list';

  const addChannelBtn = document.createElement('button');
  addChannelBtn.type = 'button';
  addChannelBtn.className = 'btn-secondary btn-add-channel';
  addChannelBtn.textContent = '+ Add Product Mapping';
  addChannelBtn.addEventListener('click', () => {
    const ctrlId = card.dataset.controllerId || (controller ? controller.id : null);
    if (!ctrlId) {
      showStatus('Save the controller first before adding product mappings.', 'error');
      return;
    }
    const ctrlType = body.querySelector('.ctrl-type').value;
    openProductMappingModal(ctrlId, channelsList, ctrlType);
  });

  channelsSection.appendChild(channelsTitle);
  channelsSection.appendChild(channelsHeader);
  channelsSection.appendChild(channelsList);
  channelsSection.appendChild(addChannelBtn);

  // ── Template Mappings Section (Darkroom Pro only) ──
  const templateSection = document.createElement('div');
  templateSection.className = 'channels-section ctrl-dp-only';

  const templateTitle = document.createElement('div');
  templateTitle.className = 'channels-section-title';
  templateTitle.textContent = 'Template Mappings';

  const templateDesc = document.createElement('p');
  templateDesc.style.cssText = 'font-size:11px;color:#888;margin:2px 0 6px;';
  templateDesc.textContent = 'Map an OrderHub job option value to a Darkroom Pro .crd border file path.';

  const templateHeader = document.createElement('div');
  templateHeader.className = 'channels-header';
  templateHeader.innerHTML = `
    <span style="flex:1.2">Option Name</span>
    <span style="flex:1.2">Option Value</span>
    <span style="flex:2">Template Path (.crd)</span>
    <span style="width:56px"></span>
  `;

  const templateList = document.createElement('div');
  templateList.className = 'channels-list';

  const addTemplateBtn = document.createElement('button');
  addTemplateBtn.type = 'button';
  addTemplateBtn.className = 'btn-secondary btn-add-channel';
  addTemplateBtn.textContent = '+ Add Template Mapping';

  templateSection.appendChild(templateTitle);
  templateSection.appendChild(templateDesc);
  templateSection.appendChild(templateHeader);
  templateSection.appendChild(templateList);
  templateSection.appendChild(addTemplateBtn);

  // Populate existing template mappings
  const existingTemplateMappings = (controller && controller.templateMappings) ? controller.templateMappings : [];
  for (const tm of existingTemplateMappings) {
    addTemplateMappingRow(tm, templateList);
  }
  addTemplateBtn.addEventListener('click', () => {
    addTemplateMappingRow(null, templateList);
  });

  // ── Ext* Field Mappings Section (Darkroom Pro only) ──
  const extSection = document.createElement('div');
  extSection.className = 'channels-section ctrl-dp-only';

  const extTitle = document.createElement('div');
  extTitle.className = 'channels-section-title';
  extTitle.textContent = 'Ext* Field Mappings';

  const extDesc = document.createElement('p');
  extDesc.style.cssText = 'font-size:11px;color:#888;margin:2px 0 6px;';
  extDesc.textContent = 'Map an OrderHub option/field name to a Darkroom Pro Ext* header field (e.g. ExtCabin).';

  const extHeader = document.createElement('div');
  extHeader.className = 'channels-header';
  extHeader.innerHTML = `
    <span style="flex:1.5">OH Option / Field Name</span>
    <span style="flex:1">Ext* Key (e.g. ExtCabin)</span>
    <span style="width:36px"></span>
  `;

  const extList = document.createElement('div');
  extList.className = 'channels-list';

  const addExtBtn = document.createElement('button');
  addExtBtn.type = 'button';
  addExtBtn.className = 'btn-secondary btn-add-channel';
  addExtBtn.textContent = '+ Add Ext* Mapping';

  extSection.appendChild(extTitle);
  extSection.appendChild(extDesc);
  extSection.appendChild(extHeader);
  extSection.appendChild(extList);
  extSection.appendChild(addExtBtn);

  // Populate existing ext field mappings
  const existingExtMappings = (controller && controller.extFieldMappings) ? controller.extFieldMappings : [];
  for (const em of existingExtMappings) {
    addExtMappingRow(em, extList);
  }
  addExtBtn.addEventListener('click', () => {
    addExtMappingRow(null, extList);
  });

  // ── Assemble body ──
  body.appendChild(row1);
  body.appendChild(row2);
  body.appendChild(row3);
  body.appendChild(rowDP);
  body.appendChild(row4);
  body.appendChild(saveRow);
  body.appendChild(channelsSection);
  body.appendChild(templateSection);
  body.appendChild(extSection);

  card.appendChild(header);
  card.appendChild(body);
  printControllersList.appendChild(card);

  // ── Helper: update field visibility based on type ──
  function applyTypeVisibility(type) {
    const isDP = type === 'darkroompro';
    body.querySelectorAll('.ctrl-dpof-only').forEach(el => {
      el.style.display = isDP ? 'none' : '';
    });
    body.querySelectorAll('.ctrl-dp-only').forEach(el => {
      el.style.display = isDP ? '' : 'none';
    });
  }

  // Apply initial visibility
  applyTypeVisibility(currentType);

  // Populate existing product mappings
  if (controller && controller.productMappings) {
    for (const pm of controller.productMappings) {
      addProductMappingRow(pm, channelsList);
    }
  }

  // ── Event Handlers ──

  // Browse hot folder
  body.querySelector('.ctrl-browse-btn').addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.selectDirectory();
      if (result) {
        body.querySelector('.ctrl-hot-folder').value = result;
      }
    } catch (error) {
      showStatus('Error selecting directory: ' + error.message, 'error');
    }
  });

  // Update header when name/type changes
  body.querySelector('.ctrl-name').addEventListener('input', (e) => {
    headerName.textContent = e.target.value || 'New Controller';
  });
  body.querySelector('.ctrl-type').addEventListener('change', (e) => {
    headerType.textContent = e.target.value;
    applyTypeVisibility(e.target.value);
  });
  body.querySelector('.ctrl-active').addEventListener('change', (e) => {
    const active = e.target.checked;
    activeBadge.className = 'controller-active-badge ' + (active ? 'active' : 'inactive');
    activeBadge.textContent = active ? 'Active' : 'Inactive';
  });

  // Save controller
  body.querySelector('.ctrl-save-btn').addEventListener('click', async () => {
    const type = body.querySelector('.ctrl-type').value;
    const isDP = type === 'darkroompro';

    // Collect template mappings (Darkroom Pro only)
    const templateMappings = [];
    templateList.querySelectorAll('.mapping-row').forEach(r => {
      const optName = r.querySelector('.tm-option-name').value.trim();
      const optVal = r.querySelector('.tm-option-value').value.trim();
      const tplPath = r.querySelector('.tm-template-path').value.trim();
      if (optName && tplPath) {
        templateMappings.push({ optionName: optName, optionValue: optVal, templatePath: tplPath });
      }
    });

    // Collect ext field mappings (Darkroom Pro only)
    const extFieldMappings = [];
    extList.querySelectorAll('.mapping-row').forEach(r => {
      const srcField = r.querySelector('.em-source-field').value.trim();
      const extKey = r.querySelector('.em-ext-key').value.trim();
      if (srcField && extKey) {
        extFieldMappings.push({ sourceField: srcField, extKeyName: extKey });
      }
    });

    const data = {
      type,
      name: body.querySelector('.ctrl-name').value.trim(),
      hotFolderPath: body.querySelector('.ctrl-hot-folder').value.trim(),
      isActive: body.querySelector('.ctrl-active').checked,
      // DPOF-specific
      vendorName: isDP ? '' : body.querySelector('.ctrl-vendor-name').value.trim(),
      vendorAttribute: isDP ? '' : body.querySelector('.ctrl-vendor-attr').value.trim(),
      autoCorrect: isDP ? false : body.querySelector('.ctrl-auto-correct').checked,
      // Darkroom Pro-specific
      processedFolderName: isDP ? (body.querySelector('.ctrl-processed-folder').value.trim() || 'processed') : undefined,
      indexPrint: isDP ? body.querySelector('.ctrl-index-print').checked : undefined,
      templateMappings: isDP ? templateMappings : undefined,
      extFieldMappings: isDP ? extFieldMappings : undefined
    };

    if (!data.name) {
      showStatus('Controller name is required.', 'error');
      return;
    }
    if (!data.hotFolderPath) {
      showStatus('Hot folder path is required.', 'error');
      return;
    }

    try {
      let saved;
      if (card.dataset.controllerId) {
        saved = await window.electronAPI.updatePrintController(card.dataset.controllerId, data);
      } else {
        saved = await window.electronAPI.addPrintController(data);
        card.dataset.controllerId = saved.id;
      }
      showStatus('Controller saved.', 'success');
    } catch (err) {
      showStatus('Error saving controller: ' + err.message, 'error');
    }
  });
}

// ── Template Mapping Row ──────────────────────────────────────────────────────

function addTemplateMappingRow(mapping, container) {
  const row = document.createElement('div');
  row.className = 'channel-row mapping-row';
  row.style.gap = '6px';

  const optNameInput = document.createElement('input');
  optNameInput.type = 'text';
  optNameInput.className = 'tm-option-name';
  optNameInput.placeholder = 'e.g. Border';
  optNameInput.value = mapping ? (mapping.optionName || '') : '';
  optNameInput.style.flex = '1.2';

  const optValInput = document.createElement('input');
  optValInput.type = 'text';
  optValInput.className = 'tm-option-value';
  optValInput.placeholder = 'e.g. Sports Golf';
  optValInput.value = mapping ? (mapping.optionValue || '') : '';
  optValInput.style.flex = '1.2';

  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'tm-template-path';
  pathInput.placeholder = 'X:\\Templates\\border.crd';
  pathInput.value = mapping ? (mapping.templatePath || '') : '';
  pathInput.style.flex = '2';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'channel-remove-btn';
  removeBtn.textContent = '\u00D7';
  removeBtn.title = 'Remove mapping';
  removeBtn.style.width = '28px';
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(optNameInput);
  row.appendChild(optValInput);
  row.appendChild(pathInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

// ── Ext* Mapping Row ─────────────────────────────────────────────────────────

function addExtMappingRow(mapping, container) {
  const row = document.createElement('div');
  row.className = 'channel-row mapping-row';
  row.style.gap = '6px';

  const srcInput = document.createElement('input');
  srcInput.type = 'text';
  srcInput.className = 'em-source-field';
  srcInput.placeholder = 'e.g. Cabin Number';
  srcInput.value = mapping ? (mapping.sourceField || '') : '';
  srcInput.style.flex = '1.5';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.className = 'em-ext-key';
  keyInput.placeholder = 'e.g. ExtCabin';
  keyInput.value = mapping ? (mapping.extKeyName || '') : '';
  keyInput.style.flex = '1';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'channel-remove-btn';
  removeBtn.textContent = '\u00D7';
  removeBtn.title = 'Remove mapping';
  removeBtn.style.width = '28px';
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(srcInput);
  row.appendChild(keyInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

// ── Product Mapping Row ──────────────────────────────────────────────────────

function addProductMappingRow(mapping, container) {
  const row = document.createElement('div');
  row.className = 'pm-row';
  row.dataset.mappingId = mapping ? mapping.id : '';

  const codeSpan = document.createElement('span');
  codeSpan.className = 'pm-code';
  codeSpan.textContent = mapping ? (mapping.productCode || '') : '';

  const sizeSpan = document.createElement('span');
  sizeSpan.className = 'pm-size';
  sizeSpan.textContent = mapping ? (mapping.size || '') : '';

  const optsSpan = document.createElement('span');
  optsSpan.className = 'pm-opts';
  if (mapping && mapping.options && Object.keys(mapping.options).length > 0) {
    Object.entries(mapping.options).forEach(([k, v]) => {
      const line = document.createElement('div');
      line.textContent = `${k}: ${v}`;
      optsSpan.appendChild(line);
    });
  } else {
    optsSpan.textContent = '\u2014';
  }

  const chSpan = document.createElement('span');
  chSpan.className = 'pm-ch';
  chSpan.textContent = mapping ? (mapping.channelNumber != null ? mapping.channelNumber : '\u2014') : '';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'channel-remove-btn';
  removeBtn.textContent = '\u00D7';
  removeBtn.title = 'Delete mapping';
  removeBtn.addEventListener('click', async () => {
    if (row.dataset.mappingId) {
      try {
        await window.electronAPI.deleteProductMapping(row.dataset.mappingId);
      } catch (err) {
        showStatus('Error deleting mapping: ' + err.message, 'error');
        return;
      }
    }
    row.remove();
  });

  row.appendChild(codeSpan);
  row.appendChild(sizeSpan);
  row.appendChild(optsSpan);
  row.appendChild(chSpan);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

// ── Product Mapping Modal ────────────────────────────────────────────────────

async function openProductMappingModal(controllerId, mappingsList, controllerType = '') {
  const isDarkroomPro = controllerType === 'darkroompro';
  const modal = document.getElementById('productMappingModal');
  const productCodeInput = document.getElementById('pmProductCode');
  const sizeInput = document.getElementById('pmSize');
  const optionsList = document.getElementById('pmOptionsList');
  const addOptionBtn = document.getElementById('pmAddOptionBtn');
  const saveBtn = document.getElementById('pmSaveBtn');
  const cancelBtn = document.getElementById('pmCancelBtn');
  const channelNumberGroup = document.getElementById('pmChannelNumber').closest('.form-group');

  // Show/hide Channel Number field based on controller type
  channelNumberGroup.style.display = isDarkroomPro ? 'none' : '';

  // Reset form
  productCodeInput.value = '';
  sizeInput.value = '';
  optionsList.innerHTML = '';
  document.getElementById('pmChannelNumber').value = '';

  // Fetch known option names+values from all existing mappings
  let knownOptions = {};
  try {
    knownOptions = await window.electronAPI.getKnownOptions();
  } catch (_) { /* fall back to empty */ }

  // Build a shared datalist for option names
  let nameDatalist = document.getElementById('pmKnownOptionNames');
  if (!nameDatalist) {
    nameDatalist = document.createElement('datalist');
    nameDatalist.id = 'pmKnownOptionNames';
    document.body.appendChild(nameDatalist);
  }
  nameDatalist.innerHTML = Object.keys(knownOptions).sort()
    .map(n => `<option value="${escapeHtml(n)}">`).join('');

  function addOptionRow() {
    const row = document.createElement('div');
    row.className = 'pm-option-row';

    // Value datalist — unique per row, updated when name changes
    const valueDatalist = document.createElement('datalist');
    valueDatalist.id = `pmOptVals_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    row.appendChild(valueDatalist);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Option name (e.g. finish-options)';
    nameInput.setAttribute('list', 'pmKnownOptionNames');

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.placeholder = 'Option value (e.g. lustre)';
    valueInput.setAttribute('list', valueDatalist.id);

    // When a name is chosen, populate its value datalist
    nameInput.addEventListener('change', () => {
      const vals = knownOptions[nameInput.value.trim()] || [];
      valueDatalist.innerHTML = vals.map(v => `<option value="${escapeHtml(v)}">`).join('');
    });
    nameInput.addEventListener('input', () => {
      const vals = knownOptions[nameInput.value.trim()] || [];
      valueDatalist.innerHTML = vals.map(v => `<option value="${escapeHtml(v)}">`).join('');
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'pm-option-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', () => row.remove());

    row.appendChild(nameInput);
    row.appendChild(valueInput);
    row.appendChild(removeBtn);
    optionsList.appendChild(row);
  }

  // Replace event listeners by cloning buttons (avoids duplicate handlers)
  const newAddOptionBtn = addOptionBtn.cloneNode(true);
  addOptionBtn.parentNode.replaceChild(newAddOptionBtn, addOptionBtn);
  newAddOptionBtn.addEventListener('click', addOptionRow);

  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

  const newCancelBtn = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  function closeModal() {
    modal.classList.add('hidden');
  }

  newCancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  }, { once: true });

  newSaveBtn.addEventListener('click', async () => {
    const productCode = document.getElementById('pmProductCode').value.trim();
    const size = document.getElementById('pmSize').value.trim();
    const channelNumber = parseInt(document.getElementById('pmChannelNumber').value, 10);

    if (!productCode) {
      showToast('Product code is required.', 'error');
      return;
    }
    if (!size) {
      showToast('Size is required.', 'error');
      return;
    }
    if (!size.includes('x')) {
      showToast('Size must be in format like "4x6".', 'error');
      return;
    }
    if (!isDarkroomPro && (!channelNumber || channelNumber < 1)) {
      showToast('A valid channel number is required.', 'error');
      return;
    }

    // Collect options
    const options = {};
    optionsList.querySelectorAll('.pm-option-row').forEach(row => {
      const inputs = row.querySelectorAll('input');
      const k = inputs[0].value.trim();
      const v = inputs[1].value.trim();
      if (k) options[k] = v;
    });

    const data = { controllerId, productCode, size, options, channelNumber: isDarkroomPro ? null : channelNumber };

    try {
      const saved = await window.electronAPI.addProductMapping(data);
      addProductMappingRow(saved, mappingsList);
      closeModal();
      showStatus('Product mapping saved.', 'success');
    } catch (err) {
      showStatus('Error saving mapping: ' + err.message, 'error');
    }
  });

  modal.classList.remove('hidden');
  document.getElementById('pmProductCode').focus();
}

// Add Controller button
addControllerBtn.addEventListener('click', () => {
  addControllerCard(null);
});

// ══════════════════════════════════════
// ROUTING — Order Controllers, Process Routing, Channel Mappings, Exceptions
// ══════════════════════════════════════

let routingLoaded = false;
let cachedOrderControllers = []; // Distinct from cachedControllers (old print-controller-store)

// Reload the routing section every time the Routing subtab is activated so that
// newly-arrived jobs (and their process values) are always reflected.
const routingSubtabBtn = document.querySelector('[data-subtab="routing"]');
if (routingSubtabBtn) {
  routingSubtabBtn.addEventListener('click', async () => {
    routingLoaded = true;
    await loadRoutingSection();
  });
}

async function loadRoutingSection() {
  // Load all four sections in parallel.
  await Promise.all([
    loadOrderControllers(),
    loadProcessRouting(),
    loadChannelMappings(),
    loadExceptions(),
  ]);
}

// ── Section 1: Order Controllers ─────────────────────────────────────────────

async function loadOrderControllers() {
  try {
    cachedOrderControllers = await window.electronAPI.getOrderControllers();
    renderOrderControllers(cachedOrderControllers);
  } catch (err) {
    console.error('Error loading order controllers:', err);
  }
}

function renderOrderControllers(controllers) {
  const list = document.getElementById('orderControllersList');
  list.innerHTML = '';
  if (controllers.length === 0) {
    list.innerHTML = '<p class="routing-empty">No controllers configured yet.</p>';
    return;
  }
  for (const ctrl of controllers) {
    list.appendChild(buildOrderControllerCard(ctrl));
  }
}

function getControllerTypeLabel(type) {
  switch ((type || 'noritsu').toLowerCase()) {
    case 'noritsu':     return 'Noritsu (DPOF)';
    case 'epson':       return 'Epson Surelab (DPOF)';
    case 'dpof':        return 'Epson / Noritsu (DPOF)'; // legacy — pre-split controllers
    case 'folder_copy': return 'Folder Copy';
    case 'pdf_copy':    return 'PDF Copy';
    case 'darkroompro': return 'Darkroom Pro';
    case 'frontline':   return 'Frontline';
    default:            return (type || 'noritsu').toUpperCase();
  }
}

function buildOrderControllerCard(ctrl) {
  const card = document.createElement('div');
  card.className = 'routing-card';
  card.innerHTML = `
    <div class="routing-card-header">
      <span class="routing-card-name">${escapeHtml(ctrl.name)}</span>
      <span class="routing-card-badge">${escapeHtml(getControllerTypeLabel(ctrl.type))}</span>
      <div class="routing-card-actions">
        <button type="button" class="btn-secondary btn-sm">Edit</button>
        <button type="button" class="btn-secondary btn-sm btn-danger-text">Delete</button>
      </div>
    </div>
    <div class="routing-card-body">
      <div><span class="routing-card-meta">Output:</span> ${escapeHtml(ctrl.outputPath || '(not set)')}</div>
      ${ctrl.type === 'frontline' ? `<div><span class="routing-card-meta">Device:</span> ${escapeHtml(ctrl.device || 'Pixfizz')}</div>` : ''}
      ${ctrl.type === 'frontline' && ctrl.backPrint1 ? `<div><span class="routing-card-meta">Back Print 1:</span> ${escapeHtml(ctrl.backPrint1)}</div>` : ''}
      ${ctrl.type === 'darkroompro' && ctrl.processedFolderName ? `<div><span class="routing-card-meta">Processed folder:</span> ${escapeHtml(ctrl.processedFolderName)}</div>` : ''}
      ${ctrl.type === 'darkroompro' && ctrl.artworkRootPath ? `<div><span class="routing-card-meta">Artwork root:</span> ${escapeHtml(ctrl.artworkRootPath)}</div>` : ''}
      ${ctrl.type === 'darkroompro' ? (() => {
        const sizeCount  = Array.isArray(ctrl.sizeTranslations)  ? ctrl.sizeTranslations.length  : 0;
        const mediaCount = Array.isArray(ctrl.mediaTranslations) ? ctrl.mediaTranslations.length : 0;
        if (sizeCount === 0 && mediaCount === 0) return '';
        const parts = [];
        if (sizeCount > 0) {
          const entries = ctrl.sizeTranslations.slice(0, 3)
            .map(t => `${escapeHtml(t.productCodePrefix || '')} → ${escapeHtml(t.darkroomSize || '')}`)
            .join(', ');
          const more = sizeCount > 3 ? ` +${sizeCount - 3} more` : '';
          parts.push(`<span class="routing-card-meta">Sizes:</span> ${entries}${more}`);
        }
        if (mediaCount > 0) {
          const entries = ctrl.mediaTranslations.slice(0, 3)
            .map(t => `${escapeHtml(t.from || '')} → ${escapeHtml(t.to || '')}`)
            .join(', ');
          const more = mediaCount > 3 ? ` +${mediaCount - 3} more` : '';
          parts.push(`<span class="routing-card-meta">Media:</span> ${entries}${more}`);
        }
        return parts.map(p => `<div>${p}</div>`).join('');
      })() : ''}
      <label class="routing-card-autoprint">
        <input type="checkbox" class="autoprint-toggle" ${ctrl.autoprint ? 'checked' : ''}>
        Auto Print
      </label>
    </div>
  `;
  const [editBtn, deleteBtn] = card.querySelectorAll('button');

  editBtn.addEventListener('click', () => openOrderControllerModal(ctrl));
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete controller "${ctrl.name}"?\n\nThis will also remove all process routings and channel mappings for this controller.`)) return;
    try {
      await window.electronAPI.deleteOrderController(ctrl.id);
      await loadRoutingSection();
    } catch (err) {
      showToast('Error deleting controller: ' + err.message, 'error');
    }
  });

  const autoPrintToggle = card.querySelector('.autoprint-toggle');
  autoPrintToggle.addEventListener('change', async () => {
    try {
      await window.electronAPI.saveOrderController({ ...ctrl, autoprint: autoPrintToggle.checked });
      cachedOrderControllers = cachedOrderControllers.map(c =>
        c.id === ctrl.id ? { ...c, autoprint: autoPrintToggle.checked } : c
      );
    } catch (err) {
      showToast('Error saving controller: ' + err.message, 'error');
      autoPrintToggle.checked = !autoPrintToggle.checked; // revert on failure
    }
  });

  return card;
}

// ── Darkroom Pro translation table helpers ────────────────────────────────────

function addSizeTranslationRow(container, prefix = '', size = '') {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
  row.innerHTML = `
    <input type="text" class="dp-size-prefix" placeholder="Product Code (e.g. 0406-cut-print)" value="${escapeHtml(prefix)}" style="flex:1">
    <span style="color:#666">→</span>
    <input type="text" class="dp-size-value" placeholder="Size (e.g. 4x6)" value="${escapeHtml(size)}" style="flex:1">
    <button type="button" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">&times;</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function addMediaTranslationRow(container, from = '', to = '') {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
  row.innerHTML = `
    <input type="text" class="dp-media-from" placeholder="Option value (e.g. lustre)" value="${escapeHtml(from)}" style="flex:1">
    <span style="color:#666">→</span>
    <input type="text" class="dp-media-to" placeholder="Darkroom value (e.g. Luster)" value="${escapeHtml(to)}" style="flex:1">
    <button type="button" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">&times;</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// ── Darkroom Pro: configurable Photo Lines ─────────────────────────────────
// Photo lines are operator-defined key/value pairs inserted between Orderid=
// and Filepath= in every per-image block of the Darkroom Pro .txt file. The
// left input is the literal Darkroom field name (free text — vendor-specific,
// e.g. "Photo.First Name"); the right input is an OHD template string with
// {token} placeholders resolved per image. Hard-capped at 2 rows.

const PHOTO_LINE_MAX_ROWS = 2;

// Token list mirrors SUPPORTED_TOKENS in src/main/services/template-tokens.js.
// Kept in sync manually because the renderer can't require Node modules.
const PHOTO_LINE_TOKENS = [
  '{customerName}',
  '{firstName}',
  '{lastName}',
  '{jobId}',
  '{orderNumber}',
  '{jobName}',
  '{filename}',
];

function _refreshPhotoLineAddBtnState() {
  const btn = document.getElementById('ocAddPhotoLineBtn');
  if (!btn) return;
  const count = document.querySelectorAll('#ocPhotoLinesList .mapping-row').length;
  btn.disabled = count >= PHOTO_LINE_MAX_ROWS;
  btn.style.opacity = btn.disabled ? '0.5' : '';
  btn.style.cursor  = btn.disabled ? 'not-allowed' : '';
}

function addPhotoLineRow(container, darkroomField = '', ohdTemplate = '') {
  // Defensive: never exceed the cap even if a stored controller somehow has
  // more entries (shouldn't happen via the UI, but keep parity with the save
  // path which trims to the cap on read).
  if (container.querySelectorAll('.mapping-row').length >= PHOTO_LINE_MAX_ROWS) return;

  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
  row.innerHTML = `
    <input type="text" class="dp-photo-field" placeholder="Darkroom field (e.g. Photo.First Name)" value="${escapeHtml(darkroomField)}" style="flex:1">
    <span style="color:#666">=</span>
    <input type="text" class="dp-photo-template" placeholder="OHD template (e.g. {filename} or {lastName}-{filename})" value="${escapeHtml(ohdTemplate)}" style="flex:1">
    <button type="button" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">&times;</button>
  `;
  row.querySelector('button').addEventListener('click', () => {
    row.remove();
    _refreshPhotoLineAddBtnState();
  });
  container.appendChild(row);
  _refreshPhotoLineAddBtnState();
}

function renderPhotoLines(photoLines) {
  const container = document.getElementById('ocPhotoLinesList');
  container.innerHTML = '';
  // Trim to the cap silently rather than rendering rows the user can't add
  // back via +Add. Persistence stays in insertion order.
  const safeArr = (photoLines || []).slice(0, PHOTO_LINE_MAX_ROWS);
  for (const pl of safeArr) {
    addPhotoLineRow(container, pl.darkroomField || '', pl.ohdTemplate || '');
  }
  _refreshPhotoLineAddBtnState();
}

function readPhotoLines() {
  const rows = document.querySelectorAll('#ocPhotoLinesList .mapping-row');
  const result = [];
  rows.forEach(row => {
    const darkroomField = row.querySelector('.dp-photo-field').value.trim();
    const ohdTemplate   = row.querySelector('.dp-photo-template').value;
    // Drop entries with no field name — the value template is allowed to be
    // empty (resolves to an empty string after the `=`, which is valid).
    if (darkroomField) result.push({ darkroomField, ohdTemplate });
  });
  return result.slice(0, PHOTO_LINE_MAX_ROWS);
}

function renderPhotoLineTokens() {
  const container = document.getElementById('ocPhotoLineTokens');
  if (!container) return;
  // Idempotent — safe to call repeatedly. Only re-render if empty so we
  // don't churn the DOM every modal open.
  if (container.children.length > 0) return;
  for (const token of PHOTO_LINE_TOKENS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = token;
    chip.title = `Click to copy ${token}`;
    chip.style.cssText = [
      'font-family:ui-monospace,Menlo,Consolas,monospace',
      'font-size:12px',
      'padding:3px 8px',
      'background:var(--surface,#fff)',
      'border:1px solid var(--border,#ddd)',
      'border-radius:3px',
      'cursor:pointer',
      'color:var(--text,#333)',
    ].join(';');
    chip.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(token);
        showToast(`Copied ${token}`, 'success', 1500);
      } catch (err) {
        showToast('Could not copy — select and copy manually', 'error', 3000);
      }
    });
    container.appendChild(chip);
  }
}

function renderSizeTranslations(translations) {
  const container = document.getElementById('ocSizeTranslationsList');
  container.innerHTML = '';
  // Display-only alphanumeric sort. Persistence stays in insertion order
  // (no writes on render). The `numeric: true` flag is load-bearing —
  // without it "0406" sorts after "10" lexicographically; with it,
  // 0406 < 0808 < 1212 as operators expect.
  const sorted = [...(translations || [])].sort((a, b) =>
    (a.productCodePrefix || '').localeCompare(
      b.productCodePrefix || '',
      undefined,
      { numeric: true, sensitivity: 'base' },
    ),
  );
  for (const t of sorted) {
    addSizeTranslationRow(container, t.productCodePrefix, t.darkroomSize);
  }
}

function renderMediaTranslations(translations) {
  const container = document.getElementById('ocMediaTranslationsList');
  container.innerHTML = '';
  // Display-only alphanumeric sort, same shape as renderSizeTranslations.
  // numeric:true matters less here (media values are usually pure alpha)
  // but kept for consistency in case operators ever use codes like "lustre-1".
  const sorted = [...(translations || [])].sort((a, b) =>
    (a.from || '').localeCompare(
      b.from || '',
      undefined,
      { numeric: true, sensitivity: 'base' },
    ),
  );
  for (const t of sorted) {
    addMediaTranslationRow(container, t.from, t.to);
  }
}

function readSizeTranslations() {
  const rows = document.querySelectorAll('#ocSizeTranslationsList .mapping-row');
  const result = [];
  rows.forEach(row => {
    const prefix = row.querySelector('.dp-size-prefix').value.trim();
    const size   = row.querySelector('.dp-size-value').value.trim();
    if (prefix && size) result.push({ productCodePrefix: prefix, darkroomSize: size });
  });
  return result;
}

function readMediaTranslations() {
  const rows = document.querySelectorAll('#ocMediaTranslationsList .mapping-row');
  const result = [];
  rows.forEach(row => {
    const from = row.querySelector('.dp-media-from').value.trim();
    const to   = row.querySelector('.dp-media-to').value.trim();
    if (from && to) result.push({ from, to });
  });
  return result;
}

function updateOcTypeFields() {
  const type = document.getElementById('ocType').value;
  document.getElementById('ocProcessedFolderGroup').style.display    = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocArtworkRootPathGroup').style.display     = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocOrderLastNameFormatGroup').style.display  = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocPhotoLinesGroup').style.display           = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocSizeTranslationsGroup').style.display     = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocMediaTranslationsGroup').style.display    = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocBannerSheetGroup').style.display        = (type === 'noritsu' || type === 'epson' || type === 'dpof' || type === 'pdf_copy') ? '' : 'none';
  document.getElementById('ocPipelineGroup').style.display           = type === 'pdf_copy'     ? '' : 'none';
  document.getElementById('ocCheckOrderStatusGroup').style.display   = (type === 'noritsu' || type === 'epson' || type === 'dpof' || type === 'darkroompro') ? '' : 'none';
  // Frontline-specific fields
  document.getElementById('ocDeviceGroup').style.display     = type === 'frontline' ? '' : 'none';
  document.getElementById('ocBackPrint1Group').style.display = type === 'frontline' ? '' : 'none';
  document.getElementById('ocBackPrint2Group').style.display = type === 'frontline' ? '' : 'none';
}

function openOrderControllerModal(ctrl = null) {
  const modal = document.getElementById('orderControllerModal');
  document.getElementById('ocModalTitle').textContent = ctrl ? 'Edit Controller' : 'Add Controller';
  document.getElementById('ocName').value       = ctrl ? ctrl.name       : '';
  document.getElementById('ocType').value       = ctrl ? ctrl.type       : 'noritsu';
  document.getElementById('ocOutputPath').value = ctrl ? (ctrl.outputPath || '') : '';
  document.getElementById('ocProcessedFolderName').value  = ctrl ? (ctrl.processedFolderName  || '') : '';
  document.getElementById('ocArtworkRootPath').value      = ctrl ? (ctrl.artworkRootPath      || '') : '';
  document.getElementById('ocOrderLastNameFormat').value  = ctrl ? (ctrl.orderLastNameFormat  || 'orderRef_lastName') : 'orderRef_lastName';
  document.getElementById('ocMediaOptionKey').value       = ctrl ? (ctrl.mediaOptionKey        || '') : '';
  renderSizeTranslations(ctrl ? ctrl.sizeTranslations  : []);
  renderMediaTranslations(ctrl ? ctrl.mediaTranslations : []);
  // Photo Lines — for an existing controller, render whatever was saved
  // (including the empty array, which means the operator deliberately
  // unchecked them). For a new controller, seed the two defaults that match
  // the legacy hard-coded format we removed, so existing Darkroom Pro setups
  // keep working out of the box without any reconfiguration.
  if (ctrl) {
    renderPhotoLines(ctrl.photoLines || []);
  } else {
    renderPhotoLines([
      { darkroomField: 'Photo.First Name', ohdTemplate: '{filename}' },
      { darkroomField: 'Photo.Last Name',  ohdTemplate: '{lastName}' },
    ]);
  }
  renderPhotoLineTokens();
  // Frontline fields
  document.getElementById('ocDevice').value     = ctrl ? (ctrl.device     || 'Pixfizz')                   : 'Pixfizz';
  document.getElementById('ocBackPrint1').value = ctrl ? (ctrl.backPrint1 || '{jobName}  {customerName}') : '{jobName}  {customerName}';
  document.getElementById('ocBackPrint2').value = ctrl ? (ctrl.backPrint2 || '{jobId}  {filename}')       : '{jobId}  {filename}';
  document.getElementById('ocAutoPrint').checked        = ctrl ? !!ctrl.autoprint                      : false;
  document.getElementById('ocBannerSheet').checked      = ctrl ? !!ctrl.bannerSheet                    : false;
  document.getElementById('ocCheckOrderStatus').checked = ctrl ? (ctrl.checkOrderStatus === true)      : false;
  // Load pipeline steps
  pipelineSteps = (ctrl && ctrl.pdfPipeline && ctrl.pdfPipeline.steps) ? JSON.parse(JSON.stringify(ctrl.pdfPipeline.steps)) : [];
  renderPipelineSteps();
  updateOcTypeFields();
  modal.dataset.editingId = ctrl ? ctrl.id : '';
  modal.classList.remove('hidden');
  document.getElementById('ocName').focus();
}

// ── PDF Pipeline Builder ──────────────────────────────────────────────────────

let pipelineSteps = [];

const STEP_LABELS = {
  interleaveBlanks:   'Interleave Blanks',
  insertBlanks:       'Insert Blanks',
  insertPages:        'Insert Pages from PDF',
  addOrderIdentifier: 'Add Order Identifier',
  addBannerSheet:     'Add Banner Sheet',
};

function defaultStep(type) {
  switch (type) {
    case 'interleaveBlanks':   return { type, every: 1 };
    case 'insertBlanks':       return { type, count: 1, beforePage: 1 };
    case 'insertPages':        return { type, assetPath: '', beforePage: 1 };
    case 'addOrderIdentifier': return {
      type,
      page: 1,
      position: { horizontal: 'center', vertical: 'bottom', offsetX: 0, offsetY: 10, unit: 'mm' },
      size: { width: 40, height: 40 },
      content: [],
    };
    case 'addBannerSheet':     return { type };
    default:                   return { type };
  }
}

function stepSummary(step) {
  switch (step.type) {
    case 'interleaveBlanks':   return `every ${step.every} blank(s) after each page`;
    case 'insertBlanks':       return `${step.count} blank(s) before page ${step.beforePage}`;
    case 'insertPages':        return step.assetPath ? `from ${step.assetPath.split(/[\\/]/).pop()} before page ${step.beforePage}` : 'no asset selected';
    case 'addOrderIdentifier': return `page ${step.page} · ${step.position.horizontal}/${step.position.vertical}`;
    case 'addBannerSheet':     return 'prepend QR banner page';
    default:                   return '';
  }
}

function renderPipelineSteps() {
  const container = document.getElementById('ocPipelineSteps');
  container.innerHTML = '';
  if (pipelineSteps.length === 0) {
    container.innerHTML = '<p style="font-size:12px;color:var(--text-muted,#888);margin:4px 0">No steps configured. Add a step below.</p>';
  } else {
    pipelineSteps.forEach((step, index) => {
      container.appendChild(buildStepCard(step, index));
    });
  }
  updatePageSimulator();
}

function buildStepCard(step, index) {
  const card = document.createElement('div');
  card.className = 'pipeline-step-card';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'pipeline-step-header';
  header.innerHTML = `
    <span class="pipeline-step-badge">${index + 1}</span>
    <span class="pipeline-step-badge">${escapeHtml(STEP_LABELS[step.type] || step.type)}</span>
    <span class="pipeline-step-summary">${escapeHtml(stepSummary(step))}</span>
    <div class="pipeline-step-actions">
      <button type="button" class="btn-secondary btn-sm" data-action="up" ${index === 0 ? 'disabled' : ''}>▲</button>
      <button type="button" class="btn-secondary btn-sm" data-action="down" ${index === pipelineSteps.length - 1 ? 'disabled' : ''}>▼</button>
      <button type="button" class="btn-secondary btn-sm btn-danger-text" data-action="delete">✕</button>
    </div>
  `;
  header.querySelector('[data-action="up"]').addEventListener('click', () => movePipelineStep(index, -1));
  header.querySelector('[data-action="down"]').addEventListener('click', () => movePipelineStep(index, 1));
  header.querySelector('[data-action="delete"]').addEventListener('click', () => {
    if (confirm('Remove this pipeline step?')) {
      pipelineSteps.splice(index, 1);
      renderPipelineSteps();
    }
  });

  // ── Body (form fields) ──
  const body = document.createElement('div');
  body.className = 'pipeline-step-body';
  body.appendChild(buildStepForm(step, index));

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function buildStepForm(step, index) {
  const frag = document.createDocumentFragment();

  const field = (label, input) => {
    const g = document.createElement('div');
    g.innerHTML = `<label>${label}</label>`;
    g.appendChild(input);
    return g;
  };

  const numInput = (val, min, onchange) => {
    const el = document.createElement('input');
    el.type = 'number'; el.min = String(min); el.value = String(val);
    el.addEventListener('input', () => { onchange(Number(el.value)); updatePageSimulator(); });
    return el;
  };

  const sel = (options, val, onchange) => {
    const el = document.createElement('select');
    options.forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === val) o.selected = true;
      el.appendChild(o);
    });
    el.addEventListener('change', () => onchange(el.value));
    return el;
  };

  switch (step.type) {
    case 'interleaveBlanks': {
      const row = document.createElement('div');
      row.className = 'form-row';
      row.appendChild(field('Blanks after each page', numInput(step.every, 1, v => { step.every = v; refreshStepHeader(index); })));
      frag.appendChild(row);
      break;
    }
    case 'insertBlanks': {
      const row = document.createElement('div');
      row.className = 'form-row';
      row.appendChild(field('Count', numInput(step.count, 1, v => { step.count = v; refreshStepHeader(index); })));
      row.appendChild(field('Before page', numInput(step.beforePage, 1, v => { step.beforePage = v; refreshStepHeader(index); })));
      frag.appendChild(row);
      break;
    }
    case 'insertPages': {
      const pathRow = document.createElement('div');
      pathRow.style.display = 'flex'; pathRow.style.gap = '6px'; pathRow.style.alignItems = 'flex-end';
      const pathInput = document.createElement('input');
      pathInput.type = 'text'; pathInput.readOnly = true;
      pathInput.value = step.assetPath || '';
      pathInput.style.flex = '1'; pathInput.style.fontSize = '12px';
      pathInput.addEventListener('change', () => { step.assetPath = pathInput.value; refreshStepHeader(index); });
      const browseBtn = document.createElement('button');
      browseBtn.type = 'button'; browseBtn.className = 'btn-secondary btn-sm'; browseBtn.textContent = 'Browse...';
      browseBtn.addEventListener('click', async () => {
        const picked = await window.electronAPI.selectPdfFile();
        if (picked) { step.assetPath = picked; pathInput.value = picked; refreshStepHeader(index); }
      });
      pathRow.appendChild(field('Asset PDF', pathInput));
      pathRow.appendChild(browseBtn);

      const pageRow = document.createElement('div');
      pageRow.className = 'form-row';
      pageRow.appendChild(field('Before page', numInput(step.beforePage, 1, v => { step.beforePage = v; refreshStepHeader(index); })));

      frag.appendChild(pathRow);
      frag.appendChild(pageRow);
      break;
    }
    case 'addOrderIdentifier': {
      // Page selector
      const pageRow = document.createElement('div');
      pageRow.className = 'form-row';
      const pageAllLabel = document.createElement('label');
      pageAllLabel.className = 'modal-checkbox';
      const pageAllCb = document.createElement('input');
      pageAllCb.type = 'checkbox'; pageAllCb.checked = step.page === 'all';
      const pageAllSpan = document.createElement('span');
      pageAllSpan.textContent = 'All pages';
      pageAllLabel.appendChild(pageAllCb); pageAllLabel.appendChild(pageAllSpan);
      const pageNumInput = numInput(step.page === 'all' ? 1 : step.page, 1, v => { if (!pageAllCb.checked) { step.page = v; refreshStepHeader(index); } });
      pageNumInput.style.display = step.page === 'all' ? 'none' : '';
      pageAllCb.addEventListener('change', () => {
        step.page = pageAllCb.checked ? 'all' : Number(pageNumInput.value);
        pageNumInput.style.display = pageAllCb.checked ? 'none' : '';
        refreshStepHeader(index);
      });
      const pageG = document.createElement('div');
      pageG.innerHTML = '<label>Page</label>';
      pageG.appendChild(pageAllLabel);
      pageG.appendChild(pageNumInput);
      pageRow.appendChild(pageG);
      frag.appendChild(pageRow);

      // Position
      const posRow = document.createElement('div');
      posRow.className = 'form-row';
      posRow.appendChild(field('Horizontal', sel([['left','Left'],['center','Center'],['right','Right']], step.position.horizontal, v => { step.position.horizontal = v; refreshStepHeader(index); })));
      posRow.appendChild(field('Vertical', sel([['top','Top'],['middle','Middle'],['bottom','Bottom']], step.position.vertical, v => { step.position.vertical = v; refreshStepHeader(index); })));
      posRow.appendChild(field('Unit', sel([['mm','mm'],['in','in']], step.position.unit, v => { step.position.unit = v; })));
      frag.appendChild(posRow);

      const offsetRow = document.createElement('div');
      offsetRow.className = 'form-row';
      offsetRow.appendChild(field('Offset X', numInput(step.position.offsetX || 0, 0, v => { step.position.offsetX = v; })));
      offsetRow.appendChild(field('Offset Y', numInput(step.position.offsetY || 0, 0, v => { step.position.offsetY = v; })));
      frag.appendChild(offsetRow);

      // Size
      const sizeRow = document.createElement('div');
      sizeRow.className = 'form-row';
      sizeRow.appendChild(field('Width', numInput(step.size.width, 1, v => { step.size.width = v; })));
      sizeRow.appendChild(field('Height', numInput(step.size.height, 1, v => { step.size.height = v; })));
      frag.appendChild(sizeRow);

      // Content items
      const contentLabel = document.createElement('label');
      contentLabel.textContent = 'Content items';
      frag.appendChild(contentLabel);

      const contentList = document.createElement('div');
      contentList.className = 'pipeline-content-items';
      const renderContentItems = () => {
        contentList.innerHTML = '';
        (step.content || []).forEach((item, ci) => {
          const row = document.createElement('div');
          row.className = 'pipeline-content-item';
          if (item.type === 'qrCode') {
            row.innerHTML = `<span class="content-label">QR Code</span><span style="flex:1;color:#888;font-size:11px">Job number</span>`;
          } else {
            const lbl = document.createElement('span');
            lbl.className = 'content-label'; lbl.textContent = 'Text';
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = item.template || '';
            inp.placeholder = 'e.g. Job: {{jobNumber}} | Qty: {{qty}}';
            inp.addEventListener('input', () => { item.template = inp.value; });
            row.appendChild(lbl); row.appendChild(inp);
          }
          const delBtn = document.createElement('button');
          delBtn.type = 'button'; delBtn.className = 'btn-secondary btn-sm btn-danger-text'; delBtn.textContent = '✕';
          delBtn.addEventListener('click', () => { step.content.splice(ci, 1); renderContentItems(); });
          row.appendChild(delBtn);
          contentList.appendChild(row);
        });
      };
      renderContentItems();
      frag.appendChild(contentList);

      const addContentRow = document.createElement('div');
      addContentRow.className = 'pipeline-content-add-row';
      const addQrBtn = document.createElement('button');
      addQrBtn.type = 'button'; addQrBtn.className = 'btn-secondary btn-sm'; addQrBtn.textContent = '+ QR Code';
      addQrBtn.addEventListener('click', () => { step.content.push({ type: 'qrCode', data: 'jobNumber' }); renderContentItems(); });
      const addTextBtn = document.createElement('button');
      addTextBtn.type = 'button'; addTextBtn.className = 'btn-secondary btn-sm'; addTextBtn.textContent = '+ Text';
      addTextBtn.addEventListener('click', () => { step.content.push({ type: 'text', template: '' }); renderContentItems(); });
      addContentRow.appendChild(addQrBtn); addContentRow.appendChild(addTextBtn);
      const hint = document.createElement('small');
      hint.style.cssText = 'color:#888;display:block;margin-top:2px';
      hint.textContent = 'Templates: {{jobNumber}} {{orderId}} {{qty}} {{customerName}}';
      frag.appendChild(addContentRow);
      frag.appendChild(hint);
      break;
    }
    case 'addBannerSheet': {
      const note = document.createElement('p');
      note.style.cssText = 'font-size:12px;color:var(--text-muted,#888)';
      note.textContent = 'Prepends a QR code banner page matching the job number.';
      frag.appendChild(note);
      break;
    }
  }
  return frag;
}

function refreshStepHeader(index) {
  // Re-render just the summary text and badge without rebuilding the whole list
  const cards = document.querySelectorAll('.pipeline-step-card');
  if (cards[index]) {
    const summary = cards[index].querySelector('.pipeline-step-summary');
    if (summary) summary.textContent = stepSummary(pipelineSteps[index]);
  }
  updatePageSimulator();
}

function movePipelineStep(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= pipelineSteps.length) return;
  [pipelineSteps[index], pipelineSteps[target]] = [pipelineSteps[target], pipelineSteps[index]];
  renderPipelineSteps();
}

function updatePageSimulator() {
  const sim = document.getElementById('ocPageSimulator');
  if (pipelineSteps.length === 0) { sim.style.display = 'none'; return; }
  sim.style.display = '';
  sim.innerHTML = '';

  // Input row
  const inputRow = document.createElement('div');
  inputRow.className = 'page-simulator-input';
  const simLabel = document.createElement('label');
  simLabel.textContent = 'Simulate with';
  const simInput = document.createElement('input');
  simInput.type = 'number'; simInput.min = '1'; simInput.value = sim.dataset.inputPages || '1';
  simInput.addEventListener('input', () => { sim.dataset.inputPages = simInput.value; updatePageSimulator(); });
  simLabel.appendChild(document.createTextNode(' '));
  inputRow.appendChild(simLabel);
  inputRow.appendChild(simInput);
  inputRow.appendChild(document.createTextNode(' original pages'));
  sim.appendChild(inputRow);

  // Steps
  const stepsDiv = document.createElement('div');
  stepsDiv.className = 'page-simulator-steps';
  let pages = parseInt(simInput.value, 10) || 1;
  let parts = [`Input: ${pages}`];
  for (const step of pipelineSteps) {
    switch (step.type) {
      case 'interleaveBlanks':
        pages = pages + pages * (step.every || 1);
        parts.push(`after Interleave Blanks: ${pages}`);
        break;
      case 'insertBlanks':
        pages = pages + (step.count || 1);
        parts.push(`after Insert Blanks: ${pages}`);
        break;
      case 'insertPages':
        parts.push(`after Insert Pages: ${pages} + N (asset pages)`);
        break;
      case 'addOrderIdentifier':
        parts.push(`after Add Identifier: ${pages} (unchanged)`);
        break;
      case 'addBannerSheet':
        pages = pages + 1;
        parts.push(`after Banner Sheet: ${pages}`);
        break;
    }
  }
  stepsDiv.textContent = parts.join(' → ');
  sim.appendChild(stepsDiv);
}

document.getElementById('ocPipelineAddBtn').addEventListener('click', () => {
  const type = document.getElementById('ocPipelineAddType').value;
  if (!type) return;
  pipelineSteps.push(defaultStep(type));
  document.getElementById('ocPipelineAddType').value = '';
  renderPipelineSteps();
});

document.getElementById('addOrderControllerBtn').addEventListener('click', () => openOrderControllerModal(null));

document.getElementById('ocType').addEventListener('change', updateOcTypeFields);

document.getElementById('ocCancelBtn').addEventListener('click', () => {
  document.getElementById('orderControllerModal').classList.add('hidden');
});

document.getElementById('ocBrowseBtn').addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) document.getElementById('ocOutputPath').value = dir;
});

document.getElementById('ocProcessedFolderBrowseBtn').addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) document.getElementById('ocProcessedFolderName').value = dir;
});

document.getElementById('ocArtworkRootPathBrowseBtn').addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) document.getElementById('ocArtworkRootPath').value = dir;
});

document.getElementById('ocAddSizeTranslationBtn').addEventListener('click', () => {
  addSizeTranslationRow(document.getElementById('ocSizeTranslationsList'));
});

document.getElementById('ocAddMediaTranslationBtn').addEventListener('click', () => {
  addMediaTranslationRow(document.getElementById('ocMediaTranslationsList'));
});

document.getElementById('ocAddPhotoLineBtn').addEventListener('click', () => {
  addPhotoLineRow(document.getElementById('ocPhotoLinesList'));
});

document.getElementById('ocSaveBtn').addEventListener('click', async () => {
  const modal      = document.getElementById('orderControllerModal');
  const name       = document.getElementById('ocName').value.trim();
  const type       = document.getElementById('ocType').value;
  const outputPath = document.getElementById('ocOutputPath').value.trim();

  if (!name)       { alert('Controller name is required.');  return; }
  if (!outputPath) { alert('Output path is required.');      return; }

  const editingId = modal.dataset.editingId;
  const controller = {
    id:        editingId || crypto.randomUUID(),
    name,
    type,
    outputPath,
    autoprint:        document.getElementById('ocAutoPrint').checked,
    checkOrderStatus: (['noritsu', 'epson', 'dpof', 'darkroompro'].includes(type))
      ? document.getElementById('ocCheckOrderStatus').checked
      : true,
  };
  if (type === 'dpof' || type === 'pdf_copy') {
    controller.bannerSheet = document.getElementById('ocBannerSheet').checked;
  }
  if (type === 'pdf_copy' && pipelineSteps.length > 0) {
    controller.pdfPipeline = { steps: JSON.parse(JSON.stringify(pipelineSteps)) };
  }
  if (type === 'darkroompro') {
    controller.processedFolderName  = document.getElementById('ocProcessedFolderName').value.trim();
    controller.artworkRootPath      = document.getElementById('ocArtworkRootPath').value.trim();
    controller.orderLastNameFormat  = document.getElementById('ocOrderLastNameFormat').value;
    controller.mediaOptionKey       = document.getElementById('ocMediaOptionKey').value.trim();
    controller.sizeTranslations     = readSizeTranslations();
    controller.mediaTranslations    = readMediaTranslations();
    controller.photoLines           = readPhotoLines();

    // Misconfiguration guard: defining translations without a Paper Type
    // Option Key is meaningless — resolveMedia short-circuits at line 129
    // (`if (!mediaOptionKey ...) return ''`) before it ever consults the
    // translations array. The customer-visible failure mode is a silently
    // dispatched .txt file with `Media=` blank. Surface the misconfig at
    // save time so the operator can't accidentally leave a controller in
    // that state. See bug investigation 2026-04-30.
    if (controller.mediaTranslations.length > 0 && !controller.mediaOptionKey) {
      const optionKeyInput = document.getElementById('ocMediaOptionKey');
      optionKeyInput.setCustomValidity(
        'Paper Type Option Key is required when Media Translations are defined. ' +
        'Either fill in the option key (e.g. "finish-options") or delete the translation rows.'
      );
      optionKeyInput.reportValidity();
      optionKeyInput.focus();
      return;
    }
    document.getElementById('ocMediaOptionKey').setCustomValidity('');
  }
  if (type === 'frontline') {
    controller.device     = document.getElementById('ocDevice').value.trim()     || 'Pixfizz';
    controller.backPrint1 = document.getElementById('ocBackPrint1').value.trim() || '{jobName}  {customerName}';
    controller.backPrint2 = document.getElementById('ocBackPrint2').value.trim() || '{jobId}  {filename}';
  }
  try {
    const result = await window.electronAPI.saveOrderController(controller);
    // The IPC handler returns {success:false, error} on validation failures
    // (e.g. the server-side mirror of the translations-without-key guard
    // in ipc-handlers.js `ohd:routing:save-controller`). Surface those
    // without hiding the modal so the operator can fix the inputs in place.
    if (result && result.success === false) {
      showToast('Error saving controller: ' + (result.error || 'Save failed'), 'error', 8000);
      return;
    }
    modal.classList.add('hidden');
    await loadRoutingSection();
    // Editing a controller's translations (or the Paper Type Option Key)
    // can change how existing Received jobs resolve their route. Re-evaluate
    // every received job and re-render the Jobs table so jobs that were
    // pending Assign flip to Process when a matching translation has just
    // been added — without making the operator click Refresh manually.
    if (Array.isArray(allJobs) && allJobs.length > 0) {
      await resolveRoutesForReceivedJobs(allJobs);
      renderJobTable(getFilteredJobs());
    }
  } catch (err) {
    showToast('Error saving controller: ' + err.message, 'error');
  }
});

// ── Section 2: Process Routing ────────────────────────────────────────────────

async function loadProcessRouting() {
  try {
    const [processValues, mappings, controllers] = await Promise.all([
      window.electronAPI.getProcessValues(),
      window.electronAPI.getProcessMappings(),
      window.electronAPI.getOrderControllers(),
    ]);
    cachedOrderControllers = controllers; // keep in sync
    renderProcessRouting(processValues, mappings, controllers);
  } catch (err) {
    console.error('Error loading process routing:', err);
  }
}

function renderProcessRouting(processValues, mappings, controllers) {
  const list = document.getElementById('processRoutingList');
  list.innerHTML = '';

  if (processValues.length === 0) {
    list.innerHTML = '<p class="routing-empty">No process values discovered yet. Process names appear here automatically as jobs are received.</p>';
    return;
  }

  const mappingByProcess = {};
  for (const m of mappings) mappingByProcess[m.process] = m;

  for (const process of processValues) {
    const row = document.createElement('div');
    row.className = 'process-routing-row';

    const label = document.createElement('span');
    label.className = 'process-routing-label';
    label.textContent = process;

    const arrow = document.createElement('span');
    arrow.className = 'process-routing-arrow';
    arrow.textContent = '→';

    const select = document.createElement('select');
    select.className = 'process-routing-select';

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Not assigned';
    select.appendChild(noneOpt);

    for (const ctrl of controllers) {
      const opt = document.createElement('option');
      opt.value = ctrl.id;
      opt.textContent = ctrl.name;
      select.appendChild(opt);
    }

    const current = mappingByProcess[process];
    select.value = current ? (current.controllerId || '') : '';

    // Save immediately on change — no separate Save button
    select.addEventListener('change', async () => {
      try {
        await window.electronAPI.saveProcessMapping({
          process,
          controllerId: select.value || null,
        });
        // Re-resolve routes so previously-warning jobs update immediately
        await resolveRoutesForReceivedJobs(allJobs);
        renderJobTable(getFilteredJobs());
      } catch (err) {
        showToast('Error saving process mapping: ' + err.message, 'error');
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-secondary btn-sm btn-danger-text';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      try {
        await window.electronAPI.deleteProcessMapping(process);
        row.remove();
      } catch (err) {
        showToast('Error deleting process mapping: ' + err.message, 'error');
      }
    });

    row.appendChild(label);
    row.appendChild(arrow);
    row.appendChild(select);
    row.appendChild(deleteBtn);
    list.appendChild(row);
  }
}

// ── Add Process Type (manual) ─────────────────────────────────────────────────

document.getElementById('addProcessTypeBtn').addEventListener('click', () => {
  const form = document.getElementById('addProcessTypeForm');
  form.style.display = 'flex';
  document.getElementById('newProcessTypeName').focus();
});

document.getElementById('cancelNewProcessTypeBtn').addEventListener('click', () => {
  document.getElementById('addProcessTypeForm').style.display = 'none';
  document.getElementById('newProcessTypeName').value = '';
});

document.getElementById('saveNewProcessTypeBtn').addEventListener('click', async () => {
  const input = document.getElementById('newProcessTypeName');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  try {
    await window.electronAPI.saveProcessMapping({ process: name, controllerId: null });
    document.getElementById('addProcessTypeForm').style.display = 'none';
    input.value = '';
    await loadProcessRouting();
  } catch (err) {
    showToast('Error adding process type: ' + err.message, 'error');
  }
});

document.getElementById('newProcessTypeName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('saveNewProcessTypeBtn').click();
  if (e.key === 'Escape') document.getElementById('cancelNewProcessTypeBtn').click();
});

// ── Section 3: Channel Mappings ───────────────────────────────────────────────

async function loadChannelMappings() {
  try {
    const [mappings, controllers] = await Promise.all([
      window.electronAPI.getChannelMappings(),
      window.electronAPI.getOrderControllers(),
    ]);
    renderChannelMappings(mappings, controllers);
  } catch (err) {
    console.error('Error loading channel mappings:', err);
  }
}

function renderChannelMappings(mappings, controllers) {
  const list = document.getElementById('channelMappingsList');
  list.innerHTML = '';

  if (mappings.length === 0) {
    list.innerHTML = '<p class="routing-empty">No channel mappings yet. Use the Assign button on a job, or add one manually below.</p>';
    return;
  }

  const controllerMap = {};
  for (const c of controllers) controllerMap[c.id] = c;

  // Group by controllerId
  const byController = {};
  for (const m of mappings) {
    if (!byController[m.controllerId]) byController[m.controllerId] = [];
    byController[m.controllerId].push(m);
  }

  for (const [controllerId, ctrlMappings] of Object.entries(byController)) {
    const ctrl     = controllerMap[controllerId];
    const ctrlName = ctrl ? ctrl.name : `Unknown controller (${controllerId})`;

    const group = document.createElement('div');
    group.className = 'channel-mapping-group';

    const groupHeader = document.createElement('div');
    groupHeader.className = 'channel-mapping-group-header';
    groupHeader.textContent = ctrlName;
    group.appendChild(groupHeader);

    for (const mapping of ctrlMappings) {
      const optionStr = (mapping.options || [])
        .map(o => `${o.name}: ${o.value}`)
        .join(' · ');

      const row = document.createElement('div');
      row.className = 'channel-mapping-row';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'channel-mapping-info';
      const isFrontlineMapping = ctrl && ctrl.type === 'frontline';
      infoDiv.innerHTML =
        `<span class="channel-mapping-product">${escapeHtml(mapping.productCode)}</span>` +
        (optionStr ? `<span class="channel-mapping-options">${escapeHtml(optionStr)}</span>` : '') +
        (isFrontlineMapping
          ? `<span class="channel-mapping-channel">→ ${escapeHtml(mapping.batchCode || '(no batch code)')}</span>` +
            (mapping.sortString ? `<span class="channel-mapping-options">${escapeHtml(mapping.sortString)}</span>` : '')
          : `<span class="channel-mapping-channel">→ Ch ${mapping.channelNumber}</span>` +
            (mapping.printSizeCode ? `<span class="channel-mapping-options">${escapeHtml(mapping.printSizeCode)}</span>` : '')) +
        (mapping.skipAutoPrint ? `<span class="channel-mapping-options" title="This channel is excluded from Auto Print">skip auto-print</span>` : '');

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'channel-mapping-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-secondary btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openChannelMappingModal(mapping, controllers));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-secondary btn-sm btn-danger-text';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete channel mapping for "${mapping.productCode}"?`)) return;
        try {
          await window.electronAPI.deleteChannelMapping(mapping.id);
          await loadChannelMappings();
        } catch (err) {
          showToast('Error deleting mapping: ' + err.message, 'error');
        }
      });

      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(deleteBtn);
      row.appendChild(infoDiv);
      row.appendChild(actionsDiv);
      group.appendChild(row);
    }
    list.appendChild(group);
  }
}

function openChannelMappingModal(mapping = null, controllers = null) {
  const ctrlList = controllers || cachedOrderControllers;
  const modal    = document.getElementById('channelMappingModal');
  const ctrlSel  = document.getElementById('cmControllerId');

  document.getElementById('cmModalTitle').textContent = mapping ? 'Edit Channel Mapping' : 'Add Channel Mapping';

  ctrlSel.innerHTML = '<option value="">Select controller...</option>';
  for (const c of ctrlList) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    ctrlSel.appendChild(opt);
  }
  ctrlSel.value = mapping ? mapping.controllerId : '';

  document.getElementById('cmProductCode').value      = mapping ? mapping.productCode          : '';
  document.getElementById('cmChannelNumber').value    = mapping ? mapping.channelNumber        : '';
  document.getElementById('cmSkipAutoPrint').checked  = mapping ? Boolean(mapping.skipAutoPrint) : false;
  document.getElementById('cmPrintSizeCode').value    = mapping ? (mapping.printSizeCode || '') : '';
  // Frontline fields
  document.getElementById('cmBatchCode').value        = mapping ? (mapping.batchCode  || '') : '';
  document.getElementById('cmSortString').value       = mapping ? (mapping.sortString || '') : '';

  const optsList = document.getElementById('cmOptionsList');
  optsList.innerHTML = '';
  for (const opt of (mapping ? (mapping.options || []) : [])) {
    addChannelMappingOptionRow(optsList, opt.name, opt.value);
  }

  modal.dataset.editingId = mapping ? mapping.id : '';

  // Show/hide DPOF vs Frontline fields based on selected controller type
  _updateCmFields(ctrlSel.value, ctrlList);

  modal.classList.remove('hidden');
}

function _updateCmFields(controllerId, ctrlList) {
  const ctrl       = (ctrlList || cachedOrderControllers).find(c => c.id === controllerId);
  const isFrontline = ctrl && ctrl.type === 'frontline';
  const isDarkroomPro = ctrl && ctrl.type === 'darkroompro';

  document.getElementById('cmChannelNumberGroup').style.display  = (!isFrontline && !isDarkroomPro) ? '' : 'none';
  document.getElementById('cmSkipAutoPrintGroup').style.display  = !isFrontline ? '' : 'none';
  document.getElementById('cmPrintSizeCodeGroup').style.display  = (!isFrontline && !isDarkroomPro) ? '' : 'none';
  document.getElementById('cmBatchCodeGroup').style.display      = isFrontline ? '' : 'none';
  document.getElementById('cmSortStringGroup').style.display     = isFrontline ? '' : 'none';
}

function addChannelMappingOptionRow(container, name = '', value = '') {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
  row.innerHTML = `
    <input type="text" class="cm-opt-name"  placeholder="name"  value="${escapeHtml(name)}"  style="flex:1">
    <span style="color:#666">:</span>
    <input type="text" class="cm-opt-value" placeholder="value" value="${escapeHtml(value)}" style="flex:1">
    <button type="button" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">&times;</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

document.getElementById('addChannelMappingBtn').addEventListener('click', () => openChannelMappingModal(null));
document.getElementById('cmControllerId').addEventListener('change', (e) => {
  _updateCmFields(e.target.value, cachedOrderControllers);
});
document.getElementById('cmAddOptionBtn').addEventListener('click', () => {
  addChannelMappingOptionRow(document.getElementById('cmOptionsList'));
});
document.getElementById('cmCancelBtn').addEventListener('click', () => {
  document.getElementById('channelMappingModal').classList.add('hidden');
});
document.getElementById('cmSaveBtn').addEventListener('click', async () => {
  const modal          = document.getElementById('channelMappingModal');
  const controllerId   = document.getElementById('cmControllerId').value;
  const productCode    = document.getElementById('cmProductCode').value.trim();
  const channelNumber  = parseInt(document.getElementById('cmChannelNumber').value, 10);
  const printSizeCode  = document.getElementById('cmPrintSizeCode').value.trim();
  const batchCode      = document.getElementById('cmBatchCode').value.trim();
  const sortString     = document.getElementById('cmSortString').value.trim();

  if (!controllerId)                         { alert('Please select a controller.');                  return; }
  if (!productCode)                          { alert('Product code is required.');                    return; }

  const selectedController = cachedOrderControllers.find(c => c.id === controllerId);
  const isFrontlineCtrl    = selectedController?.type === 'frontline';
  const isDarkroomProCtrl  = selectedController?.type === 'darkroompro';

  if (isFrontlineCtrl) {
    if (!batchCode) { alert('Batch code is required for Frontline controllers.'); return; }
  } else if (!isDarkroomProCtrl) {
    if (isNaN(channelNumber) || channelNumber < 1) { alert('Channel number must be a positive integer.'); return; }
  }

  const options = [];
  document.querySelectorAll('#cmOptionsList .mapping-row').forEach(r => {
    const name  = r.querySelector('.cm-opt-name').value.trim();
    const value = r.querySelector('.cm-opt-value').value.trim();
    if (name && value) options.push({ name, value });
  });

  const skipAutoPrint = document.getElementById('cmSkipAutoPrint').checked;
  const editingId = modal.dataset.editingId;
  try {
    await window.electronAPI.saveChannelMapping({
      id: editingId || crypto.randomUUID(),
      controllerId,
      productCode,
      options,
      channelNumber:  isFrontlineCtrl ? null : channelNumber,
      printSizeCode:  isFrontlineCtrl ? ''   : (printSizeCode || ''),
      batchCode:      isFrontlineCtrl ? batchCode  : '',
      sortString:     isFrontlineCtrl ? sortString : '',
      skipAutoPrint:  isFrontlineCtrl ? false : skipAutoPrint,
    });
    modal.classList.add('hidden');
    await loadChannelMappings();
  } catch (err) {
    showToast('Error saving channel mapping: ' + err.message, 'error');
  }
});

// ── CSV Import / Export ───────────────────────────────────────────────────────

// --- CSV parsing helpers ---

function parseCsvLine(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  result.push(field);
  return result;
}

function parseChannelMappingsCsv(content) {
  const lines = content.split(/\r?\n/);
  const rows    = [];
  const skipped = [];
  let firstDataLine = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const cols       = parseCsvLine(line);
    const channelRaw = (cols[0] || '').trim();

    // Skip header row (first cell non-numeric or literally "channel")
    if (firstDataLine && (isNaN(parseInt(channelRaw, 10)) || channelRaw.toLowerCase() === 'channel')) {
      firstDataLine = false;
      continue;
    }
    firstDataLine = false;

    const channelNumber = parseInt(channelRaw, 10);
    const productCode   = (cols[1] || '').trim();

    if (!channelRaw || isNaN(channelNumber)) {
      skipped.push({ lineNum: i + 1, raw: line, reason: 'Channel number missing or non-numeric' });
      continue;
    }
    if (!productCode) {
      skipped.push({ lineNum: i + 1, raw: line, reason: 'Product code is empty' });
      continue;
    }

    const options = [];
    for (let j = 2; j < cols.length; j++) {
      const val = (cols[j] || '').trim();
      if (!val) continue;
      const colonIdx = val.indexOf(':');
      if (colonIdx > 0) {
        options.push({ name: val.slice(0, colonIdx).trim(), value: val.slice(colonIdx + 1).trim() });
      }
    }

    rows.push({ channelNumber, productCode, options });
  }

  return { rows, skipped };
}

// --- Import modal state ---
let csvImportFileContent = null;
let csvImportDone = false;

function openCsvImportModal() {
  const modal = document.getElementById('csvImportModal');
  const ctrlSel = document.getElementById('csvImportControllerId');

  // Reset state
  csvImportFileContent = null;
  csvImportDone = false;
  document.getElementById('csvFileName').textContent = 'No file selected';
  document.getElementById('csvImportSummary').style.display = 'none';
  document.getElementById('csvImportSummary').innerHTML = '';
  document.getElementById('csvImportDoBtn').disabled = true;

  // Populate controllers
  const controllers = cachedOrderControllers || [];
  ctrlSel.innerHTML = '<option value="">Select controller...</option>';
  for (const c of controllers) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    ctrlSel.appendChild(opt);
  }

  modal.classList.remove('hidden');
}

function updateCsvImportBtn() {
  const hasController = !!document.getElementById('csvImportControllerId').value;
  const hasFile = !!csvImportFileContent;
  document.getElementById('csvImportDoBtn').disabled = !(hasController && hasFile);
}

document.getElementById('importChannelMappingsCsvBtn').addEventListener('click', () => {
  openCsvImportModal();
});

document.getElementById('csvImportControllerId').addEventListener('change', updateCsvImportBtn);

document.getElementById('csvChooseFileBtn').addEventListener('click', async () => {
  try {
    const result = await window.electronAPI.selectCsvFile();
    if (result.canceled) return;
    csvImportFileContent = result.content;
    document.getElementById('csvFileName').textContent = result.filePath.split(/[\\/]/).pop();
    updateCsvImportBtn();
  } catch (err) {
    showToast('Error selecting file: ' + err.message, 'error');
  }
});

document.getElementById('csvImportCancelBtn').addEventListener('click', () => {
  document.getElementById('csvImportModal').classList.add('hidden');
});

document.getElementById('csvImportDoBtn').addEventListener('click', async () => {
  // After import completes the button becomes "Done" — close and refresh
  if (csvImportDone) {
    document.getElementById('csvImportModal').classList.add('hidden');
    await loadChannelMappings();
    return;
  }

  const controllerId = document.getElementById('csvImportControllerId').value;
  if (!controllerId || !csvImportFileContent) return;

  const { rows, skipped } = parseChannelMappingsCsv(csvImportFileContent);

  // Disable button during import
  const importBtn = document.getElementById('csvImportDoBtn');
  importBtn.disabled = true;
  importBtn.textContent = 'Importing…';

  // Build a lookup of existing mappings keyed by controllerId+productCode+options
  // so re-importing the same CSV upserts in place rather than creating duplicates.
  const existingMappings = await window.electronAPI.getChannelMappings();
  const optionsKey = (opts) => (opts || []).map(o => `${o.name}:${o.value}`).sort().join('|');
  const existingByKey = {};
  for (const m of existingMappings) {
    const key = `${m.controllerId}\0${m.productCode}\0${optionsKey(m.options)}`;
    existingByKey[key] = m.id;
  }

  let imported = 0;
  const importErrors = [];

  for (const row of rows) {
    try {
      const key = `${controllerId}\0${row.productCode}\0${optionsKey(row.options)}`;
      const existingId = existingByKey[key];
      await window.electronAPI.saveChannelMapping({
        id: existingId || crypto.randomUUID(),
        controllerId,
        productCode: row.productCode,
        options: row.options,
        channelNumber: row.channelNumber,
        printSizeCode: '',
      });
      imported++;
    } catch (err) {
      importErrors.push({ ...row, reason: err.message });
    }
  }

  // Build summary
  const allSkipped = [
    ...skipped.map(s => `Line ${s.lineNum}: ${s.reason}`),
    ...importErrors.map(e => `Ch ${e.channelNumber} ${e.productCode}: ${e.reason}`),
  ];
  const totalSkipped = skipped.length + importErrors.length;

  const summaryEl = document.getElementById('csvImportSummary');
  let html = `<strong>${imported} mapping${imported !== 1 ? 's' : ''} imported, ${totalSkipped} skipped</strong>`;
  if (allSkipped.length) {
    html += '<ul style="margin:6px 0 0 0;padding-left:18px;">';
    for (const msg of allSkipped) html += `<li>${escapeHtml(msg)}</li>`;
    html += '</ul>';
  }
  summaryEl.innerHTML = html;
  summaryEl.style.display = 'block';

  csvImportDone = true;
  importBtn.disabled = false;
  importBtn.textContent = 'Done';
});

// --- Export ---

document.getElementById('exportChannelMappingsCsvBtn').addEventListener('click', async () => {
  try {
    const [mappings, controllers] = await Promise.all([
      window.electronAPI.getChannelMappings(),
      window.electronAPI.getOrderControllers(),
    ]);

    if (!mappings.length) {
      showToast('No channel mappings to export.', 'info');
      return;
    }

    const controllerMap = {};
    for (const c of controllers) controllerMap[c.id] = c;

    // Find max option count across all mappings
    let maxOptions = 0;
    for (const m of mappings) {
      if ((m.options || []).length > maxOptions) maxOptions = m.options.length;
    }

    // Build header — controller column omitted so the file is a clean round-trip with import
    const optionHeaders = Array.from({ length: maxOptions }, () => 'option');
    const header = ['channel', 'product_code', ...optionHeaders].join(',');

    // Group by controller so mappings from different controllers stay organised
    const byController = {};
    for (const m of mappings) {
      if (!byController[m.controllerId]) byController[m.controllerId] = [];
      byController[m.controllerId].push(m);
    }

    const csvRows = [header];
    for (const [controllerId, ctrlMappings] of Object.entries(byController)) {
      const ctrlName = controllerMap[controllerId] ? controllerMap[controllerId].name : controllerId;
      // Write a comment-style row so the user knows which controller the block belongs to
      csvRows.push(`# ${ctrlName}`);
      for (const m of ctrlMappings) {
        const options = (m.options || []).map(o => `${o.name}:${o.value}`);
        while (options.length < maxOptions) options.push('');
        const cols = [
          String(m.channelNumber),
          csvEscape(m.productCode),
          ...options.map(csvEscape),
        ];
        csvRows.push(cols.join(','));
      }
    }

    const content = csvRows.join('\r\n');
    const result = await window.electronAPI.exportCsv('channel-mappings-export.csv', content);
    if (result && result.success) {
      showToast('Channel mappings exported.', 'success');
    }
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
});

function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Section 4: Process Folder Exceptions ─────────────────────────────────────

async function loadExceptions() {
  try {
    const exceptions = await window.electronAPI.getExceptions();
    renderExceptions(exceptions);
  } catch (err) {
    console.error('Error loading exceptions:', err);
  }
}

function renderExceptions(exceptions) {
  const list = document.getElementById('exceptionsList');
  list.innerHTML = '';
  if (exceptions.length === 0) {
    list.innerHTML = '<p class="routing-empty">No exceptions configured.</p>';
    return;
  }
  for (const exc of exceptions) {
    list.appendChild(buildExceptionCard(exc));
  }
}

function buildExceptionCard(exc) {
  const optionStr = (exc.options || []).map(o => `${o.name}: ${o.value}`).join(' · ');
  const card = document.createElement('div');
  card.className = 'routing-card';
  card.innerHTML = `
    <div class="routing-card-header">
      <span class="routing-card-name">${escapeHtml(exc.productCode)}${optionStr ? ` <span class="routing-card-meta">+ ${escapeHtml(optionStr)}</span>` : ''}</span>
      <div class="routing-card-actions">
        <button type="button" class="btn-secondary btn-sm">Edit</button>
        <button type="button" class="btn-secondary btn-sm btn-danger-text">Delete</button>
      </div>
    </div>
    <div class="routing-card-body">
      <span class="routing-card-meta">→</span> ${escapeHtml(exc.folderPath || '(not set)')}
    </div>
  `;
  const [editBtn, deleteBtn] = card.querySelectorAll('button');
  editBtn.addEventListener('click', () => openExceptionModal(exc));
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete exception for "${exc.productCode}"?`)) return;
    try {
      await window.electronAPI.deleteException(exc.id);
      await loadExceptions();
    } catch (err) {
      showToast('Error deleting exception: ' + err.message, 'error');
    }
  });
  return card;
}

function openExceptionModal(exc = null) {
  const modal = document.getElementById('exceptionModal');
  document.getElementById('excModalTitle').textContent = exc ? 'Edit Exception' : 'Add Exception';
  document.getElementById('excProductCode').value = exc ? exc.productCode : '';
  document.getElementById('excFolderPath').value  = exc ? exc.folderPath  : '';

  const optsList = document.getElementById('excOptionsList');
  optsList.innerHTML = '';
  for (const opt of (exc ? (exc.options || []) : [])) {
    addExceptionOptionRow(optsList, opt.name, opt.value);
  }

  modal.dataset.editingId = exc ? exc.id : '';
  modal.classList.remove('hidden');
}

function addExceptionOptionRow(container, name = '', value = '') {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
  row.innerHTML = `
    <input type="text" class="exc-opt-name"  placeholder="name"  value="${escapeHtml(name)}"  style="flex:1">
    <span style="color:#666">:</span>
    <input type="text" class="exc-opt-value" placeholder="value" value="${escapeHtml(value)}" style="flex:1">
    <button type="button" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">&times;</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

document.getElementById('addExceptionBtn').addEventListener('click', () => openExceptionModal(null));
document.getElementById('excAddOptionBtn').addEventListener('click', () => {
  addExceptionOptionRow(document.getElementById('excOptionsList'));
});
document.getElementById('excBrowseBtn').addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) document.getElementById('excFolderPath').value = dir;
});
document.getElementById('excCancelBtn').addEventListener('click', () => {
  document.getElementById('exceptionModal').classList.add('hidden');
});
document.getElementById('excSaveBtn').addEventListener('click', async () => {
  const modal       = document.getElementById('exceptionModal');
  const productCode = document.getElementById('excProductCode').value.trim();
  const folderPath  = document.getElementById('excFolderPath').value.trim();

  if (!productCode) { alert('Product code is required.');  return; }
  if (!folderPath)  { alert('Folder path is required.');   return; }

  const options = [];
  document.querySelectorAll('#excOptionsList .mapping-row').forEach(r => {
    const name  = r.querySelector('.exc-opt-name').value.trim();
    const value = r.querySelector('.exc-opt-value').value.trim();
    if (name && value) options.push({ name, value });
  });

  const editingId = modal.dataset.editingId;
  try {
    await window.electronAPI.saveException({
      id: editingId || crypto.randomUUID(),
      productCode,
      options,
      folderPath,
    });
    modal.classList.add('hidden');
    await loadExceptions();
  } catch (err) {
    showToast('Error saving exception: ' + err.message, 'error');
  }
});
