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
const selectFilmScansSourceBtn = document.getElementById('selectFilmScansSourceBtn');
const clearFilmScansSourceBtn = document.getElementById('clearFilmScansSourceBtn');
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
 * Returns true when AI Quality is enabled AND scoring is actively in
 * flight for the given job. Used to gate Process/Assign buttons in the
 * Jobs grid and surface the "AI scoring…" indicator.
 *
 *   - Feature flag OFF → always false (preserves current behaviour)
 *   - Status not received/pending → false (scoring already happened or
 *     job is past the gate's scope)
 *   - No scoring entry yet → false (artwork not on disk OR job will never
 *     have images — e.g. gift vouchers, non-fulfillment POS items. The
 *     IPC handler `aiQuality:listHeldJobs` only publishes an entry once a
 *     job folder exists on disk with at least one image, so the absence
 *     of an entry means there is nothing to score. Previously this branch
 *     returned true, which made the indicator show on every pre-artwork
 *     job and prevented operators from dismissing erroneous jobs — see
 *     bugfixes.md 2026-05-12 entry.)
 *   - Entry says phase='scoring' → true (partial / no images scored yet)
 *   - Entry says phase='scored' → false (all images have a verdict;
 *     held-state may still be true via a separate map but the gate is done)
 */
function isPendingAIQuality(job) {
  if (!aiQualityEnabledCached) return false;
  if (job._status !== 'received' && job._status !== 'pending') return false;
  const status = aiQualityScoringStatusByJobId.get(String(job.id));
  if (!status) return false;
  return status.phase === 'scoring';
}

/**
 * Used to gate the Dismiss button.
 *
 * Body is now identical to isPendingAIQuality after the 2026-05-12 fix:
 * both return true only when an actual scoring entry exists and its
 * phase is 'scoring'. The historical split (Dismiss had a stricter
 * gate than Process to allow dismissing pre-artwork jobs) is preserved
 * as two named functions for call-site readability, but the underlying
 * predicate is the same — "no entry in the map" now means "nothing to
 * score" rather than "scoring is conservatively assumed pending".
 *
 * Process / Assign and Dismiss should both ungate when there is no
 * artwork on disk — for non-fulfillment jobs (gift vouchers, etc.)
 * scoring will never run, so blocking the operator from acting on the
 * row is wrong. See bugfixes.md 2026-05-12 entry.
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
  // Ensure the renderer's controller cache is populated before we render the
  // Jobs table. It's otherwise only loaded when Settings → Routing is opened,
  // so on a fresh start (Jobs tab, Settings never visited) the per-row "hide
  // ignored options" filter had no ignore lists to consult and showed every
  // chip. Routing/matching is unaffected by this (that runs in the main process
  // off the persisted store) — this is purely so the renderer knows each
  // controller's ignoredOptionNames. Lazy + guarded so it costs one fetch.
  await ensureOrderControllersCached();

  // Resolve routes for every active (non-completed) job, not just
  // received/pending. Two reasons:
  //   1. The Assign button needs the route for received/pending jobs (its
  //      original purpose).
  //   2. The job-row option pills hide options the job's controller ignores,
  //      which needs the resolved controller — so in-production / processed
  //      jobs must be resolved too, or their ignored options would still show.
  // resolveRoute is side-effect-free, so caching extra routes is harmless; the
  // status-badge lookup that reads this cache is gated on _status === 'pending'
  // and is unaffected. Completed-history jobs are skipped to avoid resolving a
  // potentially large archive on every render.
  const jobsToResolve = jobs.filter(j => j._status !== 'completed');
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
// Jobs, Film Review and Order XML are only relevant when their underlying
// mode is enabled in Settings. A site-PC running purely as a film-scan
// uploader (pollingEnabled: false, filmScansEnabled: true) shouldn't see
// a Jobs tab at all — and conversely an order-handling PC with
// filmScansEnabled off shouldn't see Film Review. Settings and Activity
// Log are always visible (Settings because the operator needs it to
// enable the modes in the first place — the Order XML Settings sub-tab
// stays visible even when orderXmlEnabled is false so the operator can
// switch it back on; only the main-window tab is hidden — and Activity
// Log because it's a passive read-only view).
//
// Triggered on:
//   - App startup, immediately after getConfig() resolves
//   - Settings save (saveConfig handler), so toggles take effect without restart
//
// If the active tab gets hidden by a config change, focus is moved to
// the first visible tab so the user isn't left staring at nothing.
function updateTabVisibility(config) {
  const showJobs     = !!(config && config.pollingEnabled);
  const showFilm     = !!(config && config.filmScansEnabled);
  const showOrderXml = !!(config && config.orderXmlEnabled);

  const jobsTab     = document.querySelector('.tab-bar .tab[data-tab="jobs"]');
  const filmTab     = document.querySelector('.tab-bar .tab[data-tab="film"]');
  const orderXmlTab = document.querySelector('.tab-bar .tab[data-tab="orderxml"]');
  if (jobsTab)     jobsTab.style.display     = showJobs     ? '' : 'none';
  if (filmTab)     filmTab.style.display     = showFilm     ? '' : 'none';
  if (orderXmlTab) orderXmlTab.style.display = showOrderXml ? '' : 'none';

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

  // Routing-health check (M6). Fire-and-forget — the banner appears
  // when it can, doesn't block startup. See refreshHealthBanner
  // docstring for why this runs on every launch, unguarded.
  refreshHealthBanner();
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

// ── Routing-health check + banner (M6 of missing-print-size-recovery) ──
//
// Runs on every launch and every Settings → Routing open, unguarded by
// any flag. The M4 backfill's warning fires only on launches that
// actually run the backfill — installs whose _backfill_* flag is
// already set never see it. The health check is the only mechanism
// that surfaces the problem on those installs, so it must stay cheap
// and unconditional. Two consumers:
//   - Startup: `refreshHealthBanner()` below runs after DOMContentLoaded
//     and shows the top-of-app banner when findings.length > 0.
//   - Settings → Routing: `loadChannelMappings()` calls
//     `refreshChannelMappingsHealthRollup()` to update the roll-up above
//     the list every time the pane opens.
//
// Both call sites re-fetch. Do not memoise or gate on any flag.

// Per-run dismissal flag. Set to true by either the Dismiss or Open
// Settings action. Reset naturally on app restart (module reload) —
// deliberately NOT persisted, per the M6 brief: a config this broken
// should reassert itself on the next launch. Once dismissed,
// refreshHealthBanner is a no-op for the rest of the session so
// re-invocations from loadChannelMappings after every save don't
// resurrect the banner the operator has already engaged with.
let _healthBannerDismissed = false;

async function refreshHealthBanner() {
  const banner    = document.getElementById('healthBanner');
  const countEl   = document.getElementById('healthBannerCount');
  const openBtn   = document.getElementById('healthBannerOpenBtn');
  const dismissBtn = document.getElementById('healthBannerDismissBtn');
  if (!banner || !countEl || !openBtn || !dismissBtn) return;
  // Dismissed → don't touch the banner state at all. This handles two
  // cases at once: (a) count stays > 0 across a save cycle — banner
  // stays hidden, not reasserted; (b) count drops to 0 — banner is
  // already hidden from the dismiss, no work needed.
  if (_healthBannerDismissed) return;
  try {
    const findings = await window.electronAPI.checkRoutingHealth();
    const count = Array.isArray(findings) ? findings.length : 0;
    if (count === 0) {
      // Banner auto-hides when the count reaches 0 — the operator
      // fixed everything, no reason to keep showing the alert. Not a
      // dismissal (flag stays false) so if a fresh mapping later
      // breaks the config, the banner will reappear on the next
      // refresh.
      banner.classList.add('hidden');
      return;
    }
    countEl.textContent = String(count);
    banner.classList.remove('hidden');
    openBtn.onclick = () => {
      // Dismiss the banner AND navigate — the roll-up on the Settings
      // pane provides the ongoing surface, so the banner has done its
      // job once the operator is looking at the list. Set the flag so
      // subsequent loadChannelMappings-triggered refreshes don't
      // resurrect the banner across the tab switch.
      _healthBannerDismissed = true;
      banner.classList.add('hidden');
      const settingsTab = document.querySelector('.tab[data-tab="settings"]');
      if (settingsTab) settingsTab.click();
      // Scroll the mappings list into view once the tab has painted.
      // 100ms is enough for the tab switch on every install we ship
      // to; if a slower render race turns up, hook into the tab-click
      // handler rather than growing this timeout.
      setTimeout(() => {
        const list = document.getElementById('channelMappingsList');
        if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    };
    dismissBtn.onclick = () => {
      _healthBannerDismissed = true;
      banner.classList.add('hidden');
    };
  } catch (err) {
    console.error('[health] check failed', err);
  }
}

async function refreshChannelMappingsHealthRollup() {
  const rollup   = document.getElementById('channelMappingsHealthRollup');
  const countEl  = document.getElementById('channelMappingsHealthCount');
  const jumpBtn  = document.getElementById('channelMappingsHealthJumpBtn');
  if (!rollup || !countEl || !jumpBtn) return;
  try {
    const findings = await window.electronAPI.checkRoutingHealth();
    const count = Array.isArray(findings) ? findings.length : 0;
    if (count === 0) {
      rollup.classList.add('hidden');
      return;
    }
    countEl.textContent = String(count);
    rollup.classList.remove('hidden');
    jumpBtn.onclick = () => jumpToChannelMappingRow(findings[0].mappingId);
  } catch (err) {
    console.error('[health] rollup refresh failed', err);
  }
}

function jumpToChannelMappingRow(mappingId) {
  if (!mappingId) return;
  // Attribute selector — mapping ids are UUIDs so no CSS-escape
  // concerns, but use CSS.escape() defensively since a legacy row
  // could carry a non-UUID id from the pre-uuid era of the store.
  const escapedId = window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS.escape(mappingId)
    : String(mappingId).replace(/[^\w-]/g, '');
  const row = document.querySelector(`.channel-mapping-row[data-mapping-id="${escapedId}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('channel-mapping-row--highlight');
  // Re-add on the next frame so the animation restarts if the button
  // is clicked twice.
  requestAnimationFrame(() => row.classList.add('channel-mapping-row--highlight'));
  setTimeout(() => row.classList.remove('channel-mapping-row--highlight'), 2000);
}

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
    } else if (job._awaitingManifest) {
      // Files arrived but {orderNumber}.json hasn't yet. Polling-service is
      // tracking the wait + bounded escalation; auto-print + manual Process
      // are gated until the manifest lands or the timeout fires.
      statusClass = 'badge badge-awaiting_manifest';
      statusLabel = 'Awaiting JSON Manifest';
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
    // Hide any option this job's resolved controller is configured to ignore
    // for matching — it doesn't affect routing, so showing it is just clutter.
    // Display-only: matching/dispatch already strip these names independently.
    // If the job isn't routed to a controller yet, ignoredNames is empty and
    // every option shows (we can't know what's irrelevant without a controller).
    const _pillRoute   = jobRouteCache.get(String(job.id));
    const _pillCtrlId  = _pillRoute
      ? (_pillRoute.controllerId || (_pillRoute.controller && _pillRoute.controller.id))
      : null;
    const ignoredNames = _pillCtrlId ? controllerIgnoredNameSet(_pillCtrlId) : new Set();
    let optionsHtml = '';
    if (Array.isArray(job.options)) {
      for (const opt of job.options) {
        const optName = opt && (opt.name || opt.key);
        if (optName) {
          if (ignoredNames.has(String(optName).trim().toLowerCase())) continue;
          const label = opt.value ? `${optName}: ${opt.value}` : optName;
          optionsHtml += `<span class="option-pill">${escapeHtml(label)}</span>`;
        }
      }
    } else if (job.options && typeof job.options === 'object') {
      // Fallback for legacy object format
      for (const [key, val] of Object.entries(job.options)) {
        if (val) {
          if (ignoredNames.has(String(key).trim().toLowerCase())) continue;
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
    } else if (job._awaitingManifest) {
      // Review stays available so operators can inspect already-downloaded
      // images while waiting; Process is hidden until the manifest lands.
      // Dismiss is appended by the wrapper below.
      actionHtml = reviewBtn;
    } else if (job._status === 'received') {
      const route = jobRouteCache.get(String(job.id));
      // v1.7.8 — Routing-hold Resolve button. Shown alongside the normal
      // action (Process / Assign) when the routing-hold reason is present.
      // Stays alongside (not instead) so the operator can still override via
      // Send-to-Print if they want — same philosophy as the manual-review
      // chip. The button OPENS a modal; the action is per-job.
      const routingHeld = Array.isArray(job._holdReasons) && job._holdReasons.includes('routing-hold');
      const resolveBtn = routingHeld
        ? `<button class="btn-action btn-resolve-routing-hold" data-job-id="${escapeHtml(String(job.id))}" title="Process is set to Hold for manual release. Pick a controller to dispatch.">Destination</button>`
        : '';
      if (route && route.type === 'unrouted') {
        if (route.reason === 'no-channel') {
          // Controller is assigned but no channel mapping yet — show Assign button
          const assignBtn = `<button class="btn-action btn-assign-channel" data-job-id="${escapeHtml(String(job.id))}">Assign</button>`;
          actionHtml = `${reviewBtn}${resolveBtn}${maybeDisable(assignBtn)}`;
        } else {
          // No controller AND no default folder configured
          actionHtml = `${reviewBtn}${resolveBtn}<span class="route-unassigned-msg">No default folder — configure in Settings → Process Folders</span>`;
        }
      } else {
        // Routed (controller / default-folder / process-folder) or not yet resolved — normal Send to Print
        const processBtn = `<button class="btn-action btn-send-print" data-job-id="${escapeHtml(String(job.id))}">Process</button>`;
        actionHtml = `${reviewBtn}${resolveBtn}${maybeDisable(processBtn)}`;
      }
    } else if (job._status === 'pending') {
      const route = jobRouteCache.get(String(job.id));
      const routingHeld = Array.isArray(job._holdReasons) && job._holdReasons.includes('routing-hold');
      const resolveBtn = routingHeld
        ? `<button class="btn-action btn-resolve-routing-hold" data-job-id="${escapeHtml(String(job.id))}" title="Process is set to Hold for manual release. Pick a controller to dispatch.">Destination</button>`
        : '';
      if (route && route.type === 'unrouted') {
        if (route.reason === 'no-channel') {
          // Controller assigned but no channel mapping yet — show Assign
          const assignBtn = `<button class="btn-action btn-assign-channel" data-job-id="${escapeHtml(String(job.id))}">Assign</button>`;
          actionHtml = `${reviewBtn}${resolveBtn}${maybeDisable(assignBtn)}`;
        } else {
          // No controller AND no default folder configured
          actionHtml = `${reviewBtn}${resolveBtn}<span class="route-unassigned-msg">No default folder — configure in Settings → Process Folders</span>`;
        }
      } else if (route && route.type !== 'unrouted') {
        // Valid route — show Review + Send to Print (same as received)
        const processBtn = `<button class="btn-action btn-send-print" data-job-id="${escapeHtml(String(job.id))}">Process</button>`;
        actionHtml = `${reviewBtn}${resolveBtn}${maybeDisable(processBtn)}`;
      } else {
        actionHtml = `${reviewBtn}${resolveBtn}<span style="color:#a0aec0;font-size:11px">--</span>`;
      }
    } else if (job._status === 'warning') {
      const msg = job._warningMessage || 'Unknown warning — check Activity Log';
      actionHtml = `<span class="route-unassigned-msg">⚠ ${escapeHtml(msg)}</span>`;
    } else if (job._status === 'error') {
      // M7 + M8 (missing-print-size-recovery): pre-M7 an errored job
      // showed grey `--` with no in-app recovery. Now, Retry is
      // available on EVERY error state (the operator may have fixed
      // the underlying cause — SMB path reconnected, controller
      // rebooted, config edited elsewhere) and "Fix mapping" is added
      // specifically when the error is the "DPOF-family mapping with
      // a blank printSizeCode" case that M5's health check flags.
      const route = jobRouteCache.get(String(job.id));
      // Same NON_DPOF list as src/shared/controllerTypes.js and the
      // Settings-side renderChannelMappings copy at :5780 (renderer
      // can't require — see the comment on that copy).
      const NON_DPOF_TYPES = new Set(['darkroompro', 'fujijobmaker', 'fujipicpro', 'frontline', 'folder_copy', 'pdf_copy']);
      const isDpofFamily = route
        && route.type === 'controller'
        && !NON_DPOF_TYPES.has(String(route.controllerType || ''));
      const hasBlankPrintSize = route
        && (!route.printSizeCode || String(route.printSizeCode).trim() === '');
      // Retry: resets _status to 'received' via ohd:job:retry so
      // auto-print picks the job up on its next cycle. Does NOT
      // dispatch directly — routing hold, AI quality hold and every
      // other gate must still apply.
      const retryBtn = `<button class="btn-action btn-retry" data-job-id="${escapeHtml(String(job.id))}" title="Reset this errored job — auto-print will pick it up on the next cycle.">Retry</button>`;
      if (isDpofFamily && route.channelMappingId && hasBlankPrintSize) {
        // Label is deliberately "Fix mapping" not "Re-assign" — this
        // edits the existing mapping in place. "Re-assign" would imply
        // creating a new one, and the Assign modal's create-only
        // semantics (renderer.js:1658, :1819 both hardcode
        // crypto.randomUUID()) would silently create a duplicate that
        // resolveRoute's first-match-wins would ignore.
        const fixBtn = `<button class="btn-action btn-fix-mapping" data-mapping-id="${escapeHtml(String(route.channelMappingId))}" title="Open the channel mapping for this product — the print size is missing.">Fix mapping</button>`;
        actionHtml = `${reviewBtn}${fixBtn}${retryBtn}`;
      } else {
        actionHtml = `${reviewBtn}${retryBtn}`;
      }
    } else {
      actionHtml = '<span style="color:#a0aec0;font-size:11px">--</span>';
    }

    // Wrap with dismiss button for non-dismissed tabs. Dismiss is gated
    // on actively-in-progress scoring only. After the 2026-05-12 fix
    // isPendingAIQuality and isAiQualityScoringInProgress have the same
    // body, but the gate stays here so a future divergence (e.g. wider
    // Process gating) doesn't accidentally re-block Dismiss for jobs
    // that will never receive artwork — gift vouchers, abandoned walk-in
    // POS orders, etc.
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

    // Hold-for-review chip. Job is held from AUTO dispatch only; operator
    // Send-to-Print still works. BOTH the chip label AND the tooltip text
    // are pre-computed by job-service._mapApiJob via
    // shared/holdForReview.deriveHoldChipLabel() and formatHoldReasons() so
    // we don't duplicate the reason→text mapping here (vanilla renderer.js
    // has no module imports). Fallback preserves the pre-fix label for any
    // legacy jobs-cache entry that lacks _holdChipLabel — the next poll
    // stamps it and the badge updates.
    if (job._holdForReview) {
      let chipLabel  = job._holdChipLabel   || 'Manual — review required';
      let reasonText = job._holdReasonsText || 'Manual artwork — review before printing';
      let tipText    = `Auto-print held: ${reasonText}. Click Send to Print to dispatch anyway.`;

      // M6 (order-level-submission-picpro-brief): for a job held ONLY by
      // order-merge-waiting, override the chip + tooltip with the
      // count-bearing form the brief spelled out ("Waiting for order —
      // 2 of 4 jobs"). The stamps come from runAutoPrint's pre-pass
      // (see ipc-handlers.js _runFujiPicProOrderMergePass). Mixed-reason
      // jobs keep the generic "Review required" label the shared
      // deriveHoldChipLabel produces — the specific counts only make
      // sense when merge-waiting is the sole reason.
      //
      // Manual Process on any merge-waiting member dispatches every
      // currently-eligible sibling as one submission (M5 handler
      // _dispatchFujiPicProOrderMerge_Manual), so the "Click Send to
      // Print" instruction is accurate: the ready members go, the
      // stragglers keep waiting.
      const reasons = Array.isArray(job._holdReasons) ? job._holdReasons : [];
      const isOrderMergeOnly = reasons.length === 1 && reasons[0] === 'order-merge-waiting';
      if (isOrderMergeOnly) {
        const missing = Number.isFinite(job._orderMergeMissingCount) ? job._orderMergeMissingCount : null;
        const total   = Number.isFinite(job._orderMergeTotalCount)   ? job._orderMergeTotalCount   : null;
        if (missing != null && total != null) {
          chipLabel = `Waiting for order — ${missing} of ${total} jobs missing`;
        }
        const missingIds = Array.isArray(job._orderMergeMissingJobIds) ? job._orderMergeMissingJobIds : [];
        if (missingIds.length > 0) {
          const noun = missingIds.length === 1 ? 'sibling job' : 'sibling jobs';
          const list = missingIds.join(', ');
          tipText = `Auto-print held: waiting on ${missingIds.length} ${noun} (${list}). ` +
                    `Click Send to Print to dispatch the ready members as one submission.`;
        }
      }

      flagsHtml += `<span class="hold-review-chip" title="${escapeHtml(tipText)}">${escapeHtml(chipLabel)}</span>`;
    }

    // Batched Darkroom Pro dispatch chip (M6). M4 populates
    // job._darkroomProBatchLedger on split dispatches only — the byte-for-byte
    // single-batch path leaves no ledger, so this chip is absent there and the
    // grid stays visually identical for every lab that hasn't set a cap.
    // completedAt is the pass/fail signal: only stamped once every batch has
    // been written successfully; partial failure leaves it null and the
    // batches array short (the loop stops at the throw). Tooltip carries the
    // per-batch filenames + outcomes so the operator can reconcile against
    // Darkroom Pro's queue without opening the Activity Log.
    if (job._darkroomProBatchLedger) {
      const ledger    = job._darkroomProBatchLedger;
      const total     = ledger.totalBatches;
      const batches   = Array.isArray(ledger.batches) ? ledger.batches : [];
      const succeeded = batches.filter(b => b && b.outcome === 'success').length;
      const partial   = !ledger.completedAt;
      const chipClass = partial ? 'batch-dispatch-chip batch-dispatch-chip--error' : 'batch-dispatch-chip';
      const chipText  = partial ? `Sent ${succeeded}/${total} batches` : `Sent as ${total} batches`;
      const perBatch  = batches
        .map(b => `${b.filename || '(unnamed)'} — ${b.outcome}${b.error ? `: ${b.error}` : ''}`)
        .join('\n');
      const header    = partial
        ? `Darkroom Pro batches: ${succeeded} of ${total} written, ${total - succeeded} not written. Cap ${ledger.cap}, ${ledger.totalPrints} prints total.`
        : `Darkroom Pro batches: ${total} of ${total} written. Cap ${ledger.cap}, ${ledger.totalPrints} prints total.`;
      const tipText   = perBatch ? `${header}\n\n${perBatch}` : header;
      flagsHtml += `<span class="${chipClass}" title="${escapeHtml(tipText)}">${escapeHtml(chipText)}</span>`;
    }

    // For error-status jobs, surface the _errorMessage right next to the
    // badge (both as a tooltip and as a one-line truncated caption). Without
    // this the operator sees a red "error" pill and nothing else, and has
    // to dig through the Activity Log to find the reason. Tooltip carries
    // the full message; the caption shows the first ~80 chars truncated.
    let errorHintHtml = '';
    let statusTitleAttr = '';
    if (job._awaitingManifest && job._awaitingManifestPath) {
      statusTitleAttr = ` title="Order manifest not yet received: ${escapeHtml(job._awaitingManifestPath)}"`;
    } else if (job._status === 'error' && job._errorMessage) {
      const full = String(job._errorMessage);
      const truncated = full.length > 80 ? full.slice(0, 77) + '…' : full;
      statusTitleAttr = ` title="${escapeHtml(full)}"`;
      errorHintHtml =
        `<div class="job-error-hint" title="${escapeHtml(full)}">${escapeHtml(truncated)}</div>`;
    }

    tr.innerHTML = `
      <td class="job-status-cell"><span class="${statusClass}"${statusTitleAttr}>${escapeHtml(statusLabel)}</span>${errorHintHtml}</td>
      <td>${previewHtml}</td>
      <td>${escapeHtml(job.process || '--')}</td>
      <td>${escapeHtml(job.category || '--')}</td>
      <td class="flags-cell">${flagsHtml || ''}</td>
      <td class="col-job-no"><span class="job-no" data-copy="${escapeHtml(jobNo)}" title="Click to copy">${escapeHtml(jobNo)}</span>${job.id != null ? `<br><span class="job-id" title="OH Job ID — useful for API lookups and folder names">ID ${escapeHtml(String(job.id))}</span>` : ''}${job.customer_name ? `<br><span class="customer-name">${escapeHtml(job.customer_name)}</span>` : ''}${job._routingReleasedAt ? `<br><span class="routing-released-note" title="Routing hold was released by operator">Released to ${escapeHtml(job._routingReleasedTo || 'default')} · ${escapeHtml(formatReleasedTimestamp(job._routingReleasedAt))}</span>` : ''}</td>
      <td>${escapeHtml(job.product || '--')}</td>
      <td>${job.quantity != null ? job.quantity : '--'}</td>
      <td>${optionsHtml || '<span style="color:#a0aec0">--</span>'}</td>
      <td class="order-due-cell">
        <div class="date-row"><span class="date-caption">Ordered</span><span class="date-value">${formatDueDate(job.created_at, job.date_format)}</span></div>
        <div class="date-row"><span class="date-caption">Due</span><span class="date-value">${formatDueDate(job.due_date, job.date_format)}</span></div>
      </td>
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

  // ── Resolve Routing Hold button (v1.7.8) ─────────────────────────────────
  // Per-row click handler — opens the Resolve modal. Wired here (not
  // delegated) to match the pattern of the surrounding action buttons.
  document.querySelectorAll('.btn-resolve-routing-hold[data-job-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const jobId = btn.dataset.jobId;
      const job   = allJobs.find(j => String(j.id) === String(jobId));
      if (job) openResolveRoutingHoldModal(job);
    });
  });

  // ── Retry button (M8 of missing-print-size-recovery) ─────────────────────
  // Resets an errored job's _status back to 'received' via the
  // ohd:job:retry IPC — auto-print's normal cycle picks it up. Does
  // NOT dispatch here; every existing gate (AI quality, routing
  // hold, hold-for-review) must still apply. After the IPC returns,
  // fetch fresh jobs so the row re-renders — the reset alone doesn't
  // trigger onJobsUpdated (that fires only on successful dispatch).
  document.querySelectorAll('.btn-retry[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Retrying...';
      try {
        const result = await window.electronAPI.retryJob(jobId);
        if (result && result.success === false) {
          showToast('Retry failed: ' + (result.error || 'Unknown error'), 'error', 8000);
          btn.disabled = false;
          btn.textContent = originalText;
          return;
        }
        // Refresh the jobs list so the row re-renders with the reset
        // status. loadJobs re-fetches, resolves routes, and re-renders
        // the table in one call — no need to duplicate those steps.
        await loadJobs();
        // Only toast when we actually changed something — a no-op
        // retry (job wasn't errored anymore) is silent.
        if (result && result.changed) {
          showToast('Job reset — auto-print will pick it up on the next cycle.', 'info', 4000);
        }
      } catch (err) {
        showToast('Retry failed: ' + err.message, 'error', 8000);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  // ── Fix mapping button (M7 of missing-print-size-recovery) ────────────────
  // Fetches the specific mapping + the controllers list, then opens the
  // EXISTING mapping in the Channel Mappings modal. Reusing
  // openChannelMappingModal here rather than the Assign modal is critical:
  // the Assign modal hardcodes crypto.randomUUID() (renderer.js:1658,
  // :1819) so it always INSERTs; the Channel Mappings modal preserves
  // modal.dataset.editingId and cmSaveBtn upserts by that id (:6054,
  // :6096). See docs/missing-print-size-recovery-brief.md §"THE TRAP".
  document.querySelectorAll('.btn-fix-mapping[data-mapping-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mappingId = btn.dataset.mappingId;
      try {
        const [mappings, controllers] = await Promise.all([
          window.electronAPI.getChannelMappings(),
          window.electronAPI.getOrderControllers(),
        ]);
        const mapping = (mappings || []).find(m => String(m.id) === String(mappingId));
        if (!mapping) {
          // Mapping was deleted between the row render and the click.
          // Rare, but easier to surface than to guess at recovery.
          showToast('Channel mapping no longer exists — reload the page to refresh routing state.', 'error', 8000);
          return;
        }
        openChannelMappingModal(mapping, controllers || []);
      } catch (err) {
        showToast('Error opening channel mapping: ' + err.message, 'error', 8000);
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
/**
 * Reconcile a controller's ignoredOptionNames from a set of on-screen per-option
 * "Ignore" toggles. Adds names ticked, removes names shown-but-unticked, and
 * leaves ignore names for options NOT shown untouched. Persists via
 * saveOrderController (so matching + display pick it up) and updates the local
 * cache. No-op when nothing changed. Shared by the Assign modal and the Edit
 * Channel Mapping modal so their ignore semantics never drift.
 *
 * @param {string} controllerId
 * @param {string[]} tickedIgnore    option names ticked "Ignore" (as displayed)
 * @param {Set<string>} untickedNames lowercased names shown but NOT ticked
 */
async function reconcileControllerIgnore(controllerId, tickedIgnore, untickedNames) {
  const ctrl = cachedOrderControllers.find(c => c.id === controllerId);
  if (!ctrl) return;
  const existing = Array.isArray(ctrl.ignoredOptionNames) ? ctrl.ignoredOptionNames : [];
  const byLower = new Map();   // lowercased name -> display name
  for (const n of existing) {
    const k = String(n == null ? '' : n).trim().toLowerCase();
    if (k) byLower.set(k, String(n).trim());
  }
  for (const n of tickedIgnore) byLower.set(n.toLowerCase(), n);
  for (const key of untickedNames) {
    if (!tickedIgnore.some(t => t.toLowerCase() === key)) byLower.delete(key);
  }
  const newIgnore   = Array.from(byLower.values());
  const existingSet = new Set(existing.map(x => String(x).trim().toLowerCase()).filter(Boolean));
  const newSet      = new Set(newIgnore.map(x => x.toLowerCase()));
  const changed = existingSet.size !== newSet.size || [...newSet].some(k => !existingSet.has(k));
  if (!changed) return;
  // M3 (darkroom-media-lock-brief): narrow write via ohd:routing:set-
  // ignored-options that patches only `ignoredOptionNames`. The prior
  // implementation re-saved the whole controller through
  // saveOrderController, which drags the media-key guard, the
  // max-prints validator and the Fuji validators into a per-job Ignore
  // edit — the reason a Darkroom Pro controller in the media-lock
  // state ate every Save & Assign click. This function still throws
  // on failure so the Fuji and DPOF assign branches keep their
  // existing behaviour; the darkroompro branch wraps the call and
  // continues on failure (see :1991).
  const res = await window.electronAPI.setIgnoredOptions(controllerId, newIgnore);
  if (res && res.success === false) throw new Error(res.error || 'Failed to save ignored options');
  const updated = { ...ctrl, ignoredOptionNames: newIgnore };
  cachedOrderControllers = cachedOrderControllers.map(c => c.id === updated.id ? updated : c);
}

/** Read the Assign modal's per-option Ignore checkboxes into {tickedIgnore, untickedNames}. */
function _collectAssignModalIgnore() {
  const tickedIgnore = [];
  const untickedNames = new Set();
  document.querySelectorAll('#assignModalOptions .assign-opt-ignore').forEach(cb => {
    const name = (cb.dataset.optname || '').trim();
    if (!name) return;
    if (cb.checked) tickedIgnore.push(name);
    else            untickedNames.add(name.toLowerCase());
  });
  return { tickedIgnore, untickedNames };
}

function openAssignModal(job, route) {
  const modal = document.getElementById('assignChannelModal');
  if (!modal) return;

  const isDarkroomPro = route.controller && route.controller.type === 'darkroompro';
  // v1.7.9: Fuji JobMaker uses PrintCode + Surface (+ optional SurfaceCode)
  // instead of Noritsu-style Channel Number. The Settings → Channel Mappings
  // modal has always handled this correctly; the per-job Assign modal was
  // still routing Fuji jobs through the DPOF default branch and silently
  // failing IPC validation. See CHANGELOG v1.7.9.
  //
  // M0 (Fuji PIC Pro brief): fujipicpro shares the JobMaker per-mapping
  // shape (printCode + printSize + surface), so the Assign modal treats
  // both types identically. printSize is what Manual Crop uses for the
  // aspect ratio; the .txt writer ignores it.
  const isFuji        = route.controller
                     && (route.controller.type === 'fujijobmaker'
                      || route.controller.type === 'fujipicpro');

  // Populate read-only fields
  document.getElementById('assignModalProduct').textContent     = job.product     || '—';
  document.getElementById('assignModalProductCode').textContent = job.product_code || '—';
  document.getElementById('assignModalController').textContent  = route.controller ? route.controller.name : '—';

  // Options — each shown as a pill with an "Ignore" toggle. Ticking Ignore adds
  // the option name to this controller's ignore list (controller-wide) on Save,
  // exactly like the Settings-side Edit Channel Mapping modal. Seeded from the
  // controller's current ignore list so already-ignored options show ticked.
  const optionsEl = document.getElementById('assignModalOptions');
  const assignIgnoreSet = controllerIgnoredNameSet(route.controller ? route.controller.id : '');
  if (Array.isArray(job.options) && job.options.length > 0) {
    optionsEl.innerHTML = job.options
      .filter(o => o && (o.name || o.key))
      .map(o => {
        const name    = o.name || o.key;
        const label   = o.value ? `${name}: ${o.value}` : name;
        const checked = assignIgnoreSet.has(String(name).trim().toLowerCase()) ? 'checked' : '';
        return `<label class="assign-opt-row" style="display:inline-flex;align-items:center;gap:6px;margin:0 10px 6px 0">
          <span class="option-pill">${escapeHtml(label)}</span>
          <span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:#888;cursor:pointer;-webkit-app-region:no-drag" title="Ignore this option when matching jobs on this controller">
            <input type="checkbox" class="assign-opt-ignore" data-optname="${escapeHtml(name)}" ${checked} style="margin:0">Ignore
          </span>
        </label>`;
      })
      .join('');
    document.getElementById('assignModalOptionsGroup').style.display = '';
  } else {
    optionsEl.innerHTML = '—';
    document.getElementById('assignModalOptionsGroup').style.display = 'none';
  }

  // Show DPOF, Darkroom Pro, or Fuji JobMaker input section
  document.getElementById('assignDpofGroup').style.display           = (isDarkroomPro || isFuji) ? 'none' : '';
  document.getElementById('assignSkipAutoPrintGroup').style.display  = (isDarkroomPro || isFuji) ? 'none' : '';
  document.getElementById('assignDpGroup').style.display             = isDarkroomPro ? '' : 'none';
  document.getElementById('assignFujiGroup').style.display           = isFuji        ? '' : 'none';

  if (isFuji) {
    // Reset the Fuji fields each time the modal opens — the Assign
    // affordance always creates a new channel mapping, never edits an
    // existing one, so we deliberately don't pre-fill from any cache.
    const printCodeInput   = document.getElementById('assignPrintCode');
    const printSizeInput   = document.getElementById('assignPrintSize');
    const surfaceInput     = document.getElementById('assignSurface');
    const surfaceCodeInput = document.getElementById('assignSurfaceCode');
    printCodeInput.value   = '';
    printSizeInput.value   = '';
    surfaceInput.value     = '';
    surfaceCodeInput.value = '';
    printCodeInput.setCustomValidity('');
    printSizeInput.setCustomValidity('');
    surfaceInput.setCustomValidity('');
    // Fix 13: PIC Pro-only Color= field. Show + reset to 'C' for
    // fujipicpro; hidden for fujijobmaker (no Color= in that format).
    const isFujiPicPro = route.controller && route.controller.type === 'fujipicpro';
    document.getElementById('assignColorGroup').style.display = isFujiPicPro ? '' : 'none';
    document.getElementById('assignColor').value = 'C';
    // Stash on the dataset for the save handler. The click handler at
    // ~line 1591 must NOT read `route` — it's out of scope there (the
    // handler is registered once in initAssignModal and only closes over
    // `modal` / `saveBtn`, not this function's args). Reading it threw a
    // ReferenceError before the try/catch and the operator saw nothing —
    // every Fuji Assign has been broken since v1.8.0 (519e9f9).
    modal.dataset.isPicPro = isFujiPicPro ? '1' : '';
  }

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
    // M2 (darkroom-media-lock-brief): tracked explicitly at assignment
    // time. TRUE only when the entry came from a real mediaOptionKey
    // name match; the jobOptions[0] fallback below is a HINT-only
    // guess and never sets this true. Do not re-infer later by
    // re-comparing strings — that's how the pre-fix path guessed
    // wrong (jobOptions[0] was `layout-options: full bleed` for a lab
    // without paper-type options) and persisted the guess into
    // mediaTranslations, freezing the controller. See
    // docs/darkroom-media-lock-plan.md §3.
    let mediaOptionEntryFromKey = false;

    if (mediaOptionKey) {
      mediaOptionEntry = jobOptions.find(
        o => o.name && o.name.toLowerCase() === mediaOptionKey.toLowerCase()
      );
      if (mediaOptionEntry) mediaOptionEntryFromKey = true;
    }
    // Fall back to first option when key not configured or not found on job —
    // HINT DISPLAY only. mediaOptionEntryFromKey stays false so the save
    // path skips the corrupt persist (see dpMediaFrom stash below).
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
      // M2: hide the "Save media translation for future orders" tick
      // when this controller has no Paper Type Option Key. The tick
      // offers to persist a rule; with no key the persisted rule
      // would be unreachable by resolveMedia AND the corrupt persist
      // would freeze the controller (M1 rejects it at the IPC
      // boundary, but that fires a warning toast rather than saving —
      // so the button must not be there to click in the first place).
      // Manual media input stays. Toggle both ways because the modal
      // is a singleton reused across controllers.
      document.getElementById('dpSaveMediaTranslationLabel').style.display =
        mediaOptionKey ? '' : 'none';
    }

    // Stash context for save handler. dpMediaFrom is `''` unless the
    // entry came from a real mediaOptionKey match — the tracked
    // boolean is the source of truth. Even if the tick were somehow
    // ticked (stale UI state, devtools), an empty `from` would trip
    // ipc-handlers.js's `mediaTranslation.from` check and the save
    // would be skipped without hitting the M1 rejection path at all.
    modal.dataset.dpMediaAutoResolved  = mediaAutoResolved ? '1' : '0';
    modal.dataset.dpMediaResolvedValue = resolvedMediaValue;
    modal.dataset.dpMediaFrom          = mediaOptionEntryFromKey ? (mediaOptionEntry.value || '') : '';
  } else {
    // Clear DPOF inputs
    const chanInput = document.getElementById('assignChannelNumber');
    chanInput.value = '';
    chanInput.setCustomValidity('');
    const printSizeInput = document.getElementById('assignPrintSizeCode');
    printSizeInput.value = '';
    printSizeInput.setCustomValidity('');
    document.getElementById('assignSkipAutoPrint').checked = false;
  }

  // Store context on the modal element for the save handler
  modal.dataset.jobId         = String(job.id);
  modal.dataset.controllerId  = route.controller ? route.controller.id : '';
  modal.dataset.productCode   = job.product_code || '';
  modal.dataset.isDarkroomPro = isDarkroomPro ? '1' : '';
  modal.dataset.isFuji        = isFuji        ? '1' : '';
  // Serialise job options for save handler (JSON)
  modal.dataset.jobOptions    = JSON.stringify(job.options || []);

  modal.classList.remove('hidden');
  if (isFuji) {
    document.getElementById('assignPrintCode').focus();
  } else if (!isDarkroomPro) {
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
    const isFuji        = modal.dataset.isFuji        === '1';

    if (!controllerId) {
      showToast('No controller found — check Routing settings.', 'error');
      return;
    }

    if (isFuji) {
      // ── Fuji flow (JobMaker + PIC Pro): create a new permanent channel
      // mapping. Payload shape mirrors the Settings-side cmSaveBtn handler
      // so the IPC handler's Fuji validator accepts both entry points
      // identically. M0 adds printSize as a mandatory field.
      const printCodeInput   = document.getElementById('assignPrintCode');
      const printSizeInput   = document.getElementById('assignPrintSize');
      const surfaceInput     = document.getElementById('assignSurface');
      const surfaceCodeInput = document.getElementById('assignSurfaceCode');

      const printCode   = printCodeInput.value.trim();
      const printSize   = printSizeInput.value.trim();
      const surface     = surfaceInput.value.trim();
      const surfaceCode = surfaceCodeInput.value.trim();

      // Hoisted once — used by the printSize gate below and the
      // color-field logic further down (fix 13). Sourced from the dataset
      // stamped in openAssignModal; `route` is out of scope in this handler
      // (see the note there for the v1.8.0 regression this fixes).
      const isPicProParent = modal.dataset.isPicPro === '1';

      // Same bare-WxH check the IPC handler enforces server-side.
      const BARE_WXH = /^\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*$/i;

      // Validate before touching the Save button so the operator can correct
      // errors in place — same setCustomValidity + reportValidity pattern
      // the Darkroom Pro and DPOF branches use.
      if (!printCode) {
        printCodeInput.setCustomValidity('Print Code is required for Fuji mappings.');
        printCodeInput.reportValidity();
        return;
      }
      printCodeInput.setCustomValidity('');

      // Blank is allowed for JobMaker (a lab-package printCode makes
      // printSize unfillable and dispatch is unaffected — see the
      // cmSaveBtn split for the same rationale). PIC Pro still
      // requires it because its mappings are entirely new. Non-blank
      // values get the shape check for both types.
      if (isPicProParent && !printSize) {
        printSizeInput.setCustomValidity('Print Size is required for Fuji PIC Pro mappings — sets the crop aspect (e.g. 6x4, 3.5x5).');
        printSizeInput.reportValidity();
        return;
      }
      if (printSize && !BARE_WXH.test(printSize)) {
        printSizeInput.setCustomValidity('Print Size must be a bare WxH shape like 6x4 or 3.5x5.');
        printSizeInput.reportValidity();
        return;
      }
      printSizeInput.setCustomValidity('');

      if (!surface) {
        surfaceInput.setCustomValidity('Surface is required for Fuji mappings.');
        surfaceInput.reportValidity();
        return;
      }
      surfaceInput.setCustomValidity('');

      saveBtn.disabled    = true;
      saveBtn.textContent = 'Saving...';

      try {
        // Persist any per-option Ignore ticks to the controller first, so the
        // new mapping matches (and displays) with them already in effect.
        {
          const { tickedIgnore, untickedNames } = _collectAssignModalIgnore();
          await reconcileControllerIgnore(controllerId, tickedIgnore, untickedNames);
        }
        // Fix 13: PIC Pro-only Color= field. Read from the
        // dropdown if visible (fujipicpro parent — hoisted above);
        // default 'C' otherwise so JobMaker payloads don't grow an
        // unused key.
        const assignColor    = isPicProParent
          ? (document.getElementById('assignColor').value || 'C')
          : undefined;

        const result = await window.electronAPI.saveChannelMapping({
          id:             crypto.randomUUID(),
          controllerId,
          productCode,
          options:        jobOptions,
          // Fields not used by Fuji but kept in the shape for parity with
          // the Settings-side payload — matches the DPOF/Frontline schema
          // so persisted mappings stay homogeneous on disk.
          channelNumber:  null,
          printSizeCode:  '',
          skipAutoPrint:  false,
          // Fuji-specific — surfaceCode empty is fine; resolveRoute +
          // print-service both default to surface[0].toUpperCase().
          printCode,
          printSize,
          surface,
          surfaceCode,
          // Only include `color` on PIC Pro payloads — see the same
          // guard in `cmSaveBtn`.
          ...(isPicProParent ? { color: assignColor } : {}),
        });

        if (result && result.success === false) {
          throw new Error(result.error || 'Save failed');
        }

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
    } else if (isDarkroomPro) {
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
        // 0. Persist any per-option Ignore ticks to the controller.
        //    M3 (darkroom-media-lock-brief): capture the failure
        //    instead of throwing. Same principle as M2a — an
        //    ancillary "remember this for next time" write must not
        //    abandon the per-job assignment. Before M3 this failure
        //    path was reachable because the write ran through the
        //    whole-controller save which fired the media-lock guard;
        //    the new narrow IPC bypasses that. If it still fails
        //    (controller deleted mid-modal, malformed payload,
        //    storage error) the assignment still completes and the
        //    final toast tells the operator which half failed. The
        //    Fuji (:1900) and DPOF (:2090) branches deliberately
        //    stay on the throw-on-failure behaviour — their channel-
        //    mapping match depends on the ignore set being current
        //    and reordering there is unanalysed (see BACKLOG).
        let ignoreWarning = null;
        {
          const { tickedIgnore, untickedNames } = _collectAssignModalIgnore();
          try {
            await reconcileControllerIgnore(controllerId, tickedIgnore, untickedNames);
          } catch (err) {
            ignoreWarning = err.message || 'Failed to save ignored options';
          }
        }

        // 1. Optionally persist translation entries to the controller.
        //    Ancillary — a "remember this for next time" write, not the
        //    per-job action the operator asked for. Never abandon the
        //    assignment because of a failure here (M2a).
        let translationWarning = null;
        if (saveSizeTick || saveMediaTick) {
          const transResult = await window.electronAPI.updateDarkroomTranslations({
            controllerId,
            sizeTranslation:  saveSizeTick  ? { productCodePrefix: productCode, darkroomSize: sizeValue } : null,
            mediaTranslation: saveMediaTick ? { from: modal.dataset.dpMediaFrom, to: mediaValue }         : null,
          });
          // M2a: sync cachedOrderControllers BEFORE branching on success.
          // M1 returns the controller on both paths — including on
          // {success:false} where a sizeTranslation was persisted while
          // media was rejected. Pre-M2a this sync sat after the throw,
          // so a partial success wrote to disk and left the renderer
          // cards showing the old state until restart.
          if (transResult && transResult.controller) {
            cachedOrderControllers = cachedOrderControllers.map(c =>
              c.id === transResult.controller.id ? transResult.controller : c
            );
            renderOrderControllers(cachedOrderControllers);
          }
          if (transResult && transResult.success === false) {
            // M2a: capture instead of throwing. The translation save is
            // ancillary; aborting the operator's per-job assignment
            // because of it is the exact eating-the-job failure the M1
            // rejection made possible. Continue to
            // assignDarkroomSizeMedia and surface the failure in the
            // final toast with which part failed AND which succeeded.
            translationWarning = transResult.error || 'Failed to save translations';
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
        // M2a + M3: one toast summarising both ancillary writes. Ignore
        // and translation are independent — either or both can fail
        // while the per-job assignment completes. Compose the message
        // so the operator sees exactly which half failed rather than
        // a generic "error" that sends them hunting.
        if (translationWarning || ignoreWarning) {
          const parts = [];
          if (translationWarning) parts.push(translationWarning);
          if (ignoreWarning)      parts.push(`Job assigned, but the Ignore settings could not be saved: ${ignoreWarning}`);
          parts.push('The job assignment completed.');
          showToast(parts.join(' '), 'error', 10000);
        } else {
          showToast('Darkroom Pro assignment saved', 'success');
        }
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
      const channelInput   = document.getElementById('assignChannelNumber');
      const channelNumber  = parseInt(channelInput.value, 10);
      const printSizeInput = document.getElementById('assignPrintSizeCode');
      const printSizeCode  = (printSizeInput.value || '').trim();

      if (!channelNumber || channelNumber < 1) {
        channelInput.focus();
        channelInput.setCustomValidity('Enter a valid channel number.');
        channelInput.reportValidity();
        return;
      }
      channelInput.setCustomValidity('');

      if (!printSizeCode) {
        printSizeInput.focus();
        printSizeInput.setCustomValidity('Print Size Code is required — it sets the print size for this product code.');
        printSizeInput.reportValidity();
        return;
      }
      printSizeInput.setCustomValidity('');

      saveBtn.disabled    = true;
      saveBtn.textContent = 'Saving...';

      const skipAutoPrint = document.getElementById('assignSkipAutoPrint').checked;

      try {
        // Persist any per-option Ignore ticks to the controller first.
        {
          const { tickedIgnore, untickedNames } = _collectAssignModalIgnore();
          await reconcileControllerIgnore(controllerId, tickedIgnore, untickedNames);
        }
        const result = await window.electronAPI.saveChannelMapping({
          id:            crypto.randomUUID(),
          controllerId,
          productCode,
          options:       jobOptions,   // Array<{name,value}> — match this job's options
          channelNumber,
          printSizeCode,
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

// ══════════════════════════════════════
// Resolve Routing Hold Modal (v1.7.8)
// ══════════════════════════════════════
//
// Opens from the row's "Resolve" action button (rendered when
// _holdReasons.includes('routing-hold')). Two radios:
//   - Release to default <controller>     ← default selection
//   - Reassign to <other controller>      ← dropdown of other controllers
//
// On confirm: calls ohd:routing:release-hold. If the reassign target has no
// channel mapping for {productCode, options}, the IPC returns
// { ok:false, reason:'no-channel', controller } and we chain into the existing
// openAssignModal — once the operator adds the mapping, they re-Resolve.

function formatReleasedTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // YYYY-MM-DD HH:MM — short, locale-stable, ASCII-safe for tooltips.
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (_) {
    return iso;
  }
}

function openResolveRoutingHoldModal(job) {
  const modal = document.getElementById('resolveRoutingHoldModal');
  if (!modal) return;

  // Populate read-only fields
  document.getElementById('rhModalProcess').textContent = job.process  || '—';
  document.getElementById('rhModalProduct').textContent = job.product  || '—';

  // Default-controller resolution: read from the cached route. Falls back to
  // a generic label if the route hasn't resolved (rare race — held jobs are
  // typically resolved before this modal opens).
  const route = jobRouteCache.get(String(job.id));
  const defaultName = (route && route.controllerName) || '(default — see Process Routing)';
  document.getElementById('rhDefaultControllerName').textContent = defaultName;

  // Reassign dropdown: exclude the default controller so the operator doesn't
  // "reassign" to the same one (which is the Release path). Disabled until
  // the reassign radio is picked.
  const sel = document.getElementById('rhReassignControllerSelect');
  sel.innerHTML = '';
  const defaultCtrlId = route ? route.controllerId : null;
  const others = (cachedOrderControllers || []).filter(c => c && c.id !== defaultCtrlId);
  if (others.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No other controllers configured';
    sel.appendChild(opt);
    document.getElementById('rhModeReassign').disabled = true;
  } else {
    for (const c of others) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || c.id;
      sel.appendChild(opt);
    }
    document.getElementById('rhModeReassign').disabled = false;
  }

  document.getElementById('rhModeDefault').checked  = true;
  document.getElementById('rhModeReassign').checked = false;
  sel.disabled = true;

  modal.dataset.jobId = String(job.id);
  modal.classList.remove('hidden');
}

(function initResolveRoutingHoldModal() {
  const modal = document.getElementById('resolveRoutingHoldModal');
  if (!modal) return;

  const cancelBtn  = document.getElementById('rhCancelBtn');
  const confirmBtn = document.getElementById('rhConfirmBtn');
  const radioDef   = document.getElementById('rhModeDefault');
  const radioRea   = document.getElementById('rhModeReassign');
  const sel        = document.getElementById('rhReassignControllerSelect');

  if (cancelBtn) cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
  if (radioDef)  radioDef.addEventListener('change', () => { sel.disabled = true; });
  if (radioRea)  radioRea.addEventListener('change', () => { sel.disabled = false; });

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const jobId      = modal.dataset.jobId;
      const isReassign = radioRea && radioRea.checked;
      const controllerId = isReassign ? (sel.value || null) : null;

      if (isReassign && !controllerId) {
        showToast('Pick a controller to reassign to.', 'error');
        return;
      }

      confirmBtn.disabled    = true;
      confirmBtn.textContent = 'Releasing…';

      try {
        const result = await window.electronAPI.routingReleaseHold(jobId, { controllerId });
        if (result && result.ok) {
          showToast(`Released — routed to ${result.releasedTo || 'default'}`, 'success');
          modal.classList.add('hidden');
          return;
        }
        // No-channel fallback — chain into the existing Assign Channel modal
        // pre-filled for the chosen controller. Operator adds mapping, then
        // re-Resolves the hold.
        if (result && result.reason === 'no-channel' && result.controller) {
          const job = allJobs.find(j => String(j.id) === String(jobId));
          if (job) {
            modal.classList.add('hidden');
            openAssignModal(job, { type: 'unrouted', reason: 'no-channel', controller: result.controller });
            showToast('Add a channel mapping for this controller, then re-Resolve the hold.', 'info', 8000);
            return;
          }
        }
        showToast(`Release failed: ${result && result.reason ? result.reason : 'unknown error'}`, 'error');
      } catch (err) {
        showToast('Release error: ' + (err && err.message ? err.message : String(err)), 'error');
      } finally {
        confirmBtn.disabled    = false;
        confirmBtn.textContent = 'Release';
      }
    });
  }
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
  document.getElementById('filmScansSourceFolder').value = config.filmScansSourceFolder || '';
  document.getElementById('filmScansStorageFolder').value = config.filmScansStorageFolder || '';
  document.getElementById('filmScansAutoSyncMinutes').value = config.filmScansAutoSyncMinutes || 5;
  document.getElementById('filmScansWatchguardMinutes').value = config.filmScansWatchguardMinutes || 5;
  {
    const retEl = document.getElementById('filmScansRetentionDays');
    // 0 is a valid value (keep forever), so guard against `|| 30` swallowing it.
    if (retEl) retEl.value = (config.filmScansRetentionDays ?? 30);
  }

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
  // Film Development Auto Assignment Mode — independent of AI Rotation:
  // works even with rotation off (a minimal roll record is stamped at the
  // hold step). Default false; loading a legacy config yields false too.
  const autoAssignEl = document.getElementById('filmScanAutoAssignEnabled');
  if (autoAssignEl) autoAssignEl.checked = !!config.filmScanAutoAssignEnabled;
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

  // Order XML Hot Folders (Mode 4)
  const orderXmlEn = document.getElementById('orderXmlEnabled');
  if (orderXmlEn) orderXmlEn.checked = config.orderXmlEnabled || false;
  const orderXmlSync = document.getElementById('orderXmlAutoSyncMinutes');
  if (orderXmlSync) orderXmlSync.value = config.orderXmlAutoSyncMinutes || 1;
  const orderXmlRetries = document.getElementById('orderXmlMaxRetries');
  if (orderXmlRetries) orderXmlRetries.value = config.orderXmlMaxRetries || 3;
  cachedOrderXmlHotFolders = Array.isArray(config.orderXmlHotFolders)
    ? config.orderXmlHotFolders.map((hf) => ({ ...hf }))
    : [];
  cachedOrderXmlProductMappings = (config.orderXmlProductMappings && typeof config.orderXmlProductMappings === 'object')
    ? Object.fromEntries(
        Object.entries(config.orderXmlProductMappings).map(([k, v]) =>
          [k, Array.isArray(v) ? v.map((r) => ({ ...r })) : []]
        )
      )
    : {};
  cachedOrderXmlCustomers = Array.isArray(config.orderXmlCustomers)
    ? config.orderXmlCustomers.map((c) => ({ ...c }))
    : [];
  loadOrderXmlParserFormats().then(() => {
    renderOrderXmlHotFolders(cachedOrderXmlHotFolders);
    renderOrderXmlProductMappings();
    renderOrderXmlCustomers();
  });

  // Shared
  document.getElementById('pollingInterval').value = config.pollingInterval || 60;

  // ohd-api v1.4.0 — when OrderHub advertises a poll_interval_seconds on
  // /checkin, the server value wins everywhere the timer is read (see
  // polling-service.getPollingInterval). Reflect that in the UI so an
  // operator editing this field doesn't file a bug when nothing changes.
  // The saved config value stays live as the offline fallback (10-600
  // validation in config-service still applies); this only rewrites the
  // input's *displayed* value + locks it while the server owns it.
  window.electronAPI.getServerCapabilities().then((caps) => {
    const input = document.getElementById('pollingInterval');
    if (!input) return;
    const hint = input.parentElement && input.parentElement.querySelector('.field-hint');
    if (caps && caps.pollIntervalSeconds != null) {
      input.value    = caps.pollIntervalSeconds;
      input.readOnly = true;
      if (hint) hint.textContent = `Set centrally by OrderHub (${caps.pollIntervalSeconds}s). Contact Pixfizz to change it.`;
    } else {
      // Advertised value dropped or never present — restore the editable
      // default so the field doesn't stay locked from a prior state.
      input.readOnly = false;
      if (hint) hint.textContent = 'How often to check for new jobs and files (10-600 seconds).';
    }
  }).catch(() => { /* IPC failure — leave the operator-editable default */ });

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

  // Perfectly Clear QuickServer (M1)
  loadPerfectlyClearFromConfig(config);

  // Backup & Restore (v1.6+) — guarded `?` chaining because the subtab is
  // appended after the existing form and may not exist on dev builds during
  // a partial rebuild.
  const backupEnabledEl = document.getElementById('backupEnabled');
  const backupFolderEl = document.getElementById('backupFolderPath');
  const backupIncCustEl = document.getElementById('backupIncludeCustomerDirectory');
  if (backupEnabledEl) backupEnabledEl.checked = Boolean(config.backupEnabled);
  if (backupFolderEl) backupFolderEl.value = config.backupFolderPath || '';
  if (backupIncCustEl) backupIncCustEl.checked = config.backupIncludeCustomerDirectory !== false;
  renderBackupLastStatus(config);
  renderBackupMachineIdentity(config);

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
    filmScansSourceFolder: document.getElementById('filmScansSourceFolder').value.trim(),
    filmScansStorageFolder: document.getElementById('filmScansStorageFolder').value.trim(),
    filmScansAutoSyncMinutes: parseInt(document.getElementById('filmScansAutoSyncMinutes').value, 10) || 5,
    filmScansWatchguardMinutes: parseInt(document.getElementById('filmScansWatchguardMinutes').value, 10) || 5,
    filmScansRetentionDays: (() => {
      const v = parseInt(document.getElementById('filmScansRetentionDays').value, 10);
      return Number.isFinite(v) && v >= 0 ? v : 30; // 0 allowed = keep forever
    })(),
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
    filmScanAutoAssignEnabled: document.getElementById('filmScanAutoAssignEnabled')?.checked || false,
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
    // Order XML Hot Folders (Mode 4) — config-service._sanitiseOrderXmlHotFolders
    // does the integrity validation (no two enabled rows share a watch folder,
    // unknown sourceFormat, etc.) at save-time and throws a useful error.
    orderXmlEnabled: document.getElementById('orderXmlEnabled')?.checked || false,
    orderXmlAutoSyncMinutes: parseInt(document.getElementById('orderXmlAutoSyncMinutes')?.value, 10) || 1,
    orderXmlMaxRetries: parseInt(document.getElementById('orderXmlMaxRetries')?.value, 10) || 3,
    orderXmlHotFolders: readOrderXmlHotFoldersFromUI(),
    orderXmlProductMappings: readOrderXmlProductMappingsFromUI(),
    orderXmlCustomers: readOrderXmlCustomersFromUI(),
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
    // Backup & Restore — only sent when the elements exist (see Phase 2).
    ...(document.getElementById('backupEnabled') ? {
      backupEnabled: document.getElementById('backupEnabled').checked,
      backupFolderPath: document.getElementById('backupFolderPath').value.trim(),
      backupIncludeCustomerDirectory: document.getElementById('backupIncludeCustomerDirectory').checked,
    } : {}),
    // Perfectly Clear QuickServer (M1) — a single structured key.
    perfectlyClear: readPerfectlyClearFromUI(),
  };
}

// ===========================================================================
// Perfectly Clear QuickServer (v1.7.20 M1) — settings list editor
// ===========================================================================
// Three scopes (jobs / filmScans / fileUploads). Each scope has an enable
// flag plus a list of {id, friendlyName, inputFolder, outputFolder,
// rejectedFolder} configs matching one QuickServer channel. filmScans and
// fileUploads also carry an autoApplyConfigId picker; jobs is manual-only.
//
// The DOM is rendered from an in-memory cache so Add / Remove / autoApply
// changes stay live without touching the store. Save/Load funnel through
// getFormData() ↔ populateForm() like every other Settings section.
// Validation happens in config-service.save(); we don't duplicate it here.

const PC_SCOPES = ['jobs', 'filmScans', 'fileUploads'];
const PC_SCOPE_LABELS = {
  jobs: 'Jobs',
  filmScans: 'Film Scans',
  fileUploads: 'File Uploads',
};

let cachedPerfectlyClear = {
  jobs: { enabled: false, configs: [] },
  filmScans: { enabled: false, configs: [], autoApplyConfigId: null },
  fileUploads: { enabled: false, configs: [], autoApplyConfigId: null },
};

function _pcGenerateId() {
  return 'pc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function _pcNormaliseScope(scope, raw) {
  const out = {
    enabled: !!(raw && raw.enabled),
    configs: Array.isArray(raw && raw.configs)
      ? raw.configs.map((c) => ({
          id: (c && typeof c.id === 'string' && c.id.trim()) ? c.id.trim() : _pcGenerateId(),
          friendlyName: (c && typeof c.friendlyName === 'string') ? c.friendlyName : '',
          inputFolder: (c && typeof c.inputFolder === 'string') ? c.inputFolder : '',
          outputFolder: (c && typeof c.outputFolder === 'string') ? c.outputFolder : '',
          rejectedFolder: (c && typeof c.rejectedFolder === 'string') ? c.rejectedFolder : '',
        }))
      : [],
  };
  if (scope !== 'jobs') {
    const id = raw && typeof raw.autoApplyConfigId === 'string' ? raw.autoApplyConfigId : null;
    out.autoApplyConfigId = out.configs.some((c) => c.id === id) ? id : null;
  }
  return out;
}

function loadPerfectlyClearFromConfig(config) {
  const raw = (config && config.perfectlyClear) || {};
  cachedPerfectlyClear = {
    jobs: _pcNormaliseScope('jobs', raw.jobs),
    filmScans: _pcNormaliseScope('filmScans', raw.filmScans),
    fileUploads: _pcNormaliseScope('fileUploads', raw.fileUploads),
  };
  for (const scope of PC_SCOPES) {
    const cb = document.getElementById(_pcEnabledId(scope));
    if (cb) cb.checked = cachedPerfectlyClear[scope].enabled;
    _pcRenderList(scope);
  }
  _pcRefreshAutoApplySelect('filmScans');
  _pcRefreshAutoApplySelect('fileUploads');
}

function readPerfectlyClearFromUI() {
  // Sync cached model from live DOM inputs before serialising.
  for (const scope of PC_SCOPES) {
    const cb = document.getElementById(_pcEnabledId(scope));
    if (cb) cachedPerfectlyClear[scope].enabled = cb.checked;
    const list = document.getElementById(_pcListId(scope));
    if (list) {
      cachedPerfectlyClear[scope].configs = Array.from(
        list.querySelectorAll('.pc-config-row'),
      ).map((row) => ({
        id: row.dataset.pcId,
        friendlyName: row.querySelector('.pc-friendly-name').value.trim(),
        inputFolder: row.querySelector('.pc-input-folder').value.trim(),
        outputFolder: row.querySelector('.pc-output-folder').value.trim(),
        rejectedFolder: row.querySelector('.pc-rejected-folder').value.trim(),
      }));
    }
    if (scope !== 'jobs') {
      const sel = document.getElementById(_pcAutoApplyId(scope));
      cachedPerfectlyClear[scope].autoApplyConfigId = sel && sel.value ? sel.value : null;
    }
  }
  return {
    jobs: {
      enabled: cachedPerfectlyClear.jobs.enabled,
      configs: cachedPerfectlyClear.jobs.configs,
    },
    filmScans: {
      enabled: cachedPerfectlyClear.filmScans.enabled,
      configs: cachedPerfectlyClear.filmScans.configs,
      autoApplyConfigId: cachedPerfectlyClear.filmScans.autoApplyConfigId,
    },
    fileUploads: {
      enabled: cachedPerfectlyClear.fileUploads.enabled,
      configs: cachedPerfectlyClear.fileUploads.configs,
      autoApplyConfigId: cachedPerfectlyClear.fileUploads.autoApplyConfigId,
    },
  };
}

function _pcEnabledId(scope) {
  return scope === 'jobs' ? 'pcJobsEnabled'
    : scope === 'filmScans' ? 'pcFilmScansEnabled'
    : 'pcFileUploadsEnabled';
}
function _pcListId(scope) {
  return scope === 'jobs' ? 'pcJobsList'
    : scope === 'filmScans' ? 'pcFilmScansList'
    : 'pcFileUploadsList';
}
function _pcAutoApplyId(scope) {
  return scope === 'filmScans' ? 'pcFilmScansAutoApply' : 'pcFileUploadsAutoApply';
}

function _pcRenderList(scope) {
  const list = document.getElementById(_pcListId(scope));
  if (!list) return;
  const configs = cachedPerfectlyClear[scope].configs;
  if (configs.length === 0) {
    list.innerHTML = '<p class="empty-list-hint" style="margin:8px 0;color:#888;">No configs. Add one below.</p>';
    return;
  }
  list.innerHTML = configs.map((c, idx) => _pcBuildRow(scope, c, idx)).join('');
}

function _pcBuildRow(scope, cfg, idx) {
  const label = PC_SCOPE_LABELS[scope];
  const safe = (s) => escapeHtml(s || '');
  return `
    <div class="pc-config-row" data-pc-id="${safe(cfg.id)}" data-pc-scope="${scope}" style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:12px;">
      <div class="form-group">
        <label>Friendly name</label>
        <input type="text" class="pc-friendly-name" value="${safe(cfg.friendlyName)}" placeholder="e.g. ${safe(label)} — Portraits">
      </div>
      <div class="form-group">
        <label>Input folder (QuickServer watches this)</label>
        <div style="display:flex;gap:6px;">
          <input type="text" class="pc-input-folder" style="flex:1;" value="${safe(cfg.inputFolder)}" placeholder="\\\\server\\qs\\portraits\\input">
          <button type="button" class="btn-secondary pc-browse" data-pc-field="pc-input-folder">Browse…</button>
        </div>
      </div>
      <div class="form-group">
        <label>Output folder (QuickServer writes enhanced images here)</label>
        <div style="display:flex;gap:6px;">
          <input type="text" class="pc-output-folder" style="flex:1;" value="${safe(cfg.outputFolder)}" placeholder="\\\\server\\qs\\portraits\\output">
          <button type="button" class="btn-secondary pc-browse" data-pc-field="pc-output-folder">Browse…</button>
        </div>
      </div>
      <div class="form-group">
        <label>Rejected folder</label>
        <div style="display:flex;gap:6px;">
          <input type="text" class="pc-rejected-folder" style="flex:1;" value="${safe(cfg.rejectedFolder)}" placeholder="\\\\server\\qs\\portraits\\rejected">
          <button type="button" class="btn-secondary pc-browse" data-pc-field="pc-rejected-folder">Browse…</button>
        </div>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button type="button" class="btn-secondary pc-test">Test</button>
        <button type="button" class="btn-danger pc-remove">Remove</button>
      </div>
    </div>
  `;
}

function _pcRefreshAutoApplySelect(scope) {
  if (scope === 'jobs') return;
  const sel = document.getElementById(_pcAutoApplyId(scope));
  if (!sel) return;
  const current = cachedPerfectlyClear[scope].autoApplyConfigId;
  const configs = cachedPerfectlyClear[scope].configs;
  const offLabel = scope === 'filmScans'
    ? 'Off — manual per frame only'
    : 'Off — upload originals as-is';
  const opts = ['<option value="">' + offLabel + '</option>'].concat(
    configs.map((c) => {
      const name = c.friendlyName || '(unnamed config)';
      const selected = c.id === current ? ' selected' : '';
      return `<option value="${escapeHtml(c.id)}"${selected}>${escapeHtml(name)}</option>`;
    }),
  );
  sel.innerHTML = opts.join('');
}

async function _pcHandleTest(row) {
  const payload = {
    inputFolder: row.querySelector('.pc-input-folder').value.trim(),
    outputFolder: row.querySelector('.pc-output-folder').value.trim(),
    rejectedFolder: row.querySelector('.pc-rejected-folder').value.trim(),
  };
  try {
    const res = await window.electronAPI.pcTestConfig(payload);
    if (res && res.ok) {
      showStatus('Perfectly Clear test succeeded — probe written and cleaned up.', 'success');
    } else {
      showStatus('Perfectly Clear test failed: ' + (res && res.error ? res.error : 'unknown error'), 'error');
    }
  } catch (err) {
    showStatus('Perfectly Clear test error: ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Add-config buttons.
  document.querySelectorAll('.pc-add-config').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.pcScope;
      readPerfectlyClearFromUI(); // capture current edits into cache
      cachedPerfectlyClear[scope].configs.push({
        id: _pcGenerateId(),
        friendlyName: '',
        inputFolder: '',
        outputFolder: '',
        rejectedFolder: '',
      });
      _pcRenderList(scope);
      _pcRefreshAutoApplySelect(scope);
    });
  });

  // Delegated Remove / Test / Browse handling on each list container.
  PC_SCOPES.forEach((scope) => {
    const list = document.getElementById(_pcListId(scope));
    if (!list) return;
    list.addEventListener('click', async (evt) => {
      const row = evt.target.closest('.pc-config-row');
      if (!row) return;
      if (evt.target.matches('.pc-remove')) {
        const id = row.dataset.pcId;
        readPerfectlyClearFromUI();
        cachedPerfectlyClear[scope].configs = cachedPerfectlyClear[scope].configs.filter((c) => c.id !== id);
        if (scope !== 'jobs' && cachedPerfectlyClear[scope].autoApplyConfigId === id) {
          cachedPerfectlyClear[scope].autoApplyConfigId = null;
        }
        _pcRenderList(scope);
        _pcRefreshAutoApplySelect(scope);
      } else if (evt.target.matches('.pc-test')) {
        await _pcHandleTest(row);
      } else if (evt.target.matches('.pc-browse')) {
        const field = evt.target.dataset.pcField;
        const input = row.querySelector('.' + field);
        try {
          const result = await window.electronAPI.selectDirectory();
          if (result && input) input.value = result;
        } catch (err) {
          showStatus('Error selecting directory: ' + err.message, 'error');
        }
      }
    });
    // Refresh the auto-apply select whenever a friendly name is edited.
    list.addEventListener('input', (evt) => {
      if (evt.target.matches('.pc-friendly-name') && scope !== 'jobs') {
        readPerfectlyClearFromUI();
        _pcRefreshAutoApplySelect(scope);
      }
    });
  });
});

// ===========================================================================
// Order XML Hot Folders (Mode 4) — settings list editor
// ===========================================================================
// UX: each hot folder is an always-editable card. Add appends a fresh card
// with a generated id; Remove drops one. Save flows through the global
// settings save — config-service.save() validates the array and throws on
// integrity violations (duplicate watch folders, unknown source format, etc.).

let cachedOrderXmlHotFolders = [];
let cachedOrderXmlParserFormats = [
  // Fallback if the IPC fetch fails — keeps the dropdown usable so the UI
  // doesn't crash. The real list comes from order-xml-parsers/index.js.
  { id: 'photofinale', label: 'PhotoFinale (Trevoli OrderDataSet)' },
];

async function loadOrderXmlParserFormats() {
  try {
    const res = await window.electronAPI.orderXmlListParserFormats();
    if (res && res.ok && Array.isArray(res.formats) && res.formats.length > 0) {
      cachedOrderXmlParserFormats = res.formats;
    }
  } catch (_) { /* stay on fallback */ }
}

function renderOrderXmlHotFolders(rows) {
  const list = document.getElementById('orderXmlHotFoldersList');
  if (!list) return;
  list.innerHTML = '';
  if (!rows || rows.length === 0) {
    list.innerHTML = '<p class="routing-empty">No hot folders configured yet. Click "+ Add Hot Folder" to add one.</p>';
    return;
  }
  rows.forEach((row, idx) => list.appendChild(buildOrderXmlHotFolderCard(row, idx)));
}

function buildOrderXmlHotFolderCard(row, idx) {
  const card = document.createElement('div');
  card.className = 'routing-card orderxml-card';
  card.dataset.idx = String(idx);
  if (row.id) card.dataset.id = row.id;

  const formatOptions = cachedOrderXmlParserFormats.map((f) => `
    <option value="${escapeHtml(f.id)}" ${f.id === row.sourceFormat ? 'selected' : ''}>${escapeHtml(f.label)}</option>
  `).join('');

  card.innerHTML = `
    <div class="routing-card-header orderxml-card-header-bar">
      <span class="routing-card-name">Hot Folder</span>
      <label class="orderxml-enabled-toggle" title="Enable this hot folder">
        <input type="checkbox" class="orderxml-enabled" ${row.enabled ? 'checked' : ''}>
        <span>Enabled</span>
      </label>
      <div class="routing-card-actions">
        <button type="button" class="btn-secondary btn-sm btn-danger-text orderxml-remove">Remove</button>
      </div>
    </div>
    <div class="routing-card-body">
      <div class="form-group">
        <label>Name</label>
        <input type="text" class="orderxml-label" placeholder="e.g. PhotoFinale F-11"
               value="${escapeHtml(row.label || '')}">
      </div>
      <div class="form-row">
        <div class="form-group form-group-grow">
          <label>Source format</label>
          <select class="orderxml-format">${formatOptions}</select>
        </div>
        <div class="form-group form-group-grow">
          <label>Website code</label>
          <input type="text" class="orderxml-website" placeholder="e.g. PPPF"
                 value="${escapeHtml(row.websiteCode || '')}">
        </div>
        <div class="form-group" style="width: 130px;">
          <label>Max retries</label>
          <input type="number" class="orderxml-retries" min="1" max="10"
                 placeholder="(default)"
                 value="${row.maxRetries != null && row.maxRetries !== '' ? String(row.maxRetries) : ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Watch folder</label>
        <div class="input-with-button">
          <input type="text" class="orderxml-watch" readonly
                 placeholder="C:\\PhotoFinale\\Drop"
                 value="${escapeHtml(row.watchFolder || '')}">
          <button type="button" class="btn-browse orderxml-watch-browse">Browse...</button>
        </div>
      </div>
      <div class="form-group">
        <label>Processed folder</label>
        <small class="field-hint" style="margin-top: 0;">Successful submissions land in <code>&lt;processed&gt;/&lt;MMDDYYYY&gt;/</code>; failures land in <code>&lt;processed&gt;/failed/&lt;MMDDYYYY&gt;/</code>.</small>
        <div class="input-with-button">
          <input type="text" class="orderxml-processed" readonly
                 placeholder="C:\\PhotoFinale\\Processed"
                 value="${escapeHtml(row.processedFolder || '')}">
          <button type="button" class="btn-browse orderxml-processed-browse">Browse...</button>
        </div>
      </div>
    </div>
  `;

  // Wire actions
  card.querySelector('.orderxml-remove').addEventListener('click', () => {
    const i = parseInt(card.dataset.idx, 10);
    if (Number.isFinite(i)) {
      // Re-read from UI first so any unsaved typing isn't lost on the rows
      // surrounding the deleted one.
      cachedOrderXmlHotFolders = readOrderXmlHotFoldersFromUI();
      cachedOrderXmlHotFolders.splice(i, 1);
      renderOrderXmlHotFolders(cachedOrderXmlHotFolders);
    }
  });
  card.querySelector('.orderxml-watch-browse').addEventListener('click', async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) card.querySelector('.orderxml-watch').value = dir;
  });
  card.querySelector('.orderxml-processed-browse').addEventListener('click', async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) card.querySelector('.orderxml-processed').value = dir;
  });

  return card;
}

/**
 * Snapshot the current state of every hot folder card. Called by getFormData()
 * at save time and by the Remove handler so we don't lose edits to surrounding
 * rows when one is removed.
 */
function readOrderXmlHotFoldersFromUI() {
  const list = document.getElementById('orderXmlHotFoldersList');
  if (!list) return cachedOrderXmlHotFolders;
  const cards = [...list.querySelectorAll('.orderxml-card')];
  return cards.map((card) => {
    const retriesRaw = card.querySelector('.orderxml-retries').value.trim();
    return {
      id:              card.dataset.id || '', // empty → config-service generates one
      label:           card.querySelector('.orderxml-label').value.trim(),
      enabled:         card.querySelector('.orderxml-enabled').checked,
      sourceFormat:    card.querySelector('.orderxml-format').value,
      watchFolder:     card.querySelector('.orderxml-watch').value.trim(),
      processedFolder: card.querySelector('.orderxml-processed').value.trim(),
      websiteCode:     card.querySelector('.orderxml-website').value.trim(),
      maxRetries:      retriesRaw === '' ? null : parseInt(retriesRaw, 10),
    };
  });
}

// Add Hot Folder button — only wires up if the element exists (i.e. when the
// settings panel HTML has been rendered, not on every renderer.js load order).
(function wireAddOrderXmlHotFolderButton() {
  const btn = document.getElementById('addOrderXmlHotFolderBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    cachedOrderXmlHotFolders = readOrderXmlHotFoldersFromUI();
    cachedOrderXmlHotFolders.push({
      id:              '',
      label:           '',
      enabled:         true,
      sourceFormat:    cachedOrderXmlParserFormats[0]?.id || 'photofinale',
      watchFolder:     '',
      processedFolder: '',
      websiteCode:     '',
      maxRetries:      null,
    });
    renderOrderXmlHotFolders(cachedOrderXmlHotFolders);
  });
})();

(function wireAddOrderXmlCustomerButton() {
  const btn = document.getElementById('orderXmlAddCustomerBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    cachedOrderXmlCustomers = readOrderXmlCustomersFromUI();
    cachedOrderXmlCustomers.push({ customerId: '', customerName: '', customerEmail: '' });
    renderOrderXmlCustomers();
    // Focus the new row's first input for fast typing.
    const tbody = document.getElementById('orderXmlCustomersBody');
    const inputs = tbody ? tbody.querySelectorAll('.orderxml-customer-id') : [];
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });
})();

// ===========================================================================
// Order XML Product Mappings (Mode 4 — chunk 7d) — vendor → Pixfizz table
// ===========================================================================
// Per-format editable list. Round-trips through the global settings save;
// validation (1:1 enforcement) lives server-side in
// config-service._sanitiseOrderXmlProductMappings, which throws a useful
// error message that surfaces via the existing settings status banner.

let cachedOrderXmlProductMappings = {}; // { [sourceFormat]: [{ photoFinaleCode, pixfizzCode, label }] }

/**
 * Render every format slice of the mappings table. Called from populateForm()
 * after parser formats are loaded (so we can show empty sections for parser
 * ids the operator hasn't touched yet).
 */
function renderOrderXmlProductMappings() {
  const host = document.getElementById('orderXmlProductMappingsHost');
  if (!host) return;
  host.innerHTML = '';

  // Ensure every registered parser has a slice rendered, even if empty —
  // gives the operator somewhere obvious to add their first mapping.
  for (const fmt of cachedOrderXmlParserFormats) {
    const rows = Array.isArray(cachedOrderXmlProductMappings[fmt.id])
      ? cachedOrderXmlProductMappings[fmt.id]
      : [];
    host.appendChild(buildOrderXmlMappingsSection(fmt, rows));
  }
}

function buildOrderXmlMappingsSection(format, rows) {
  const section = document.createElement('div');
  section.className = 'orderxml-mappings-section';
  section.dataset.sourceFormat = format.id;

  section.innerHTML = `
    <h4 class="orderxml-mappings-heading">${escapeHtml(format.label)}</h4>
    <table class="orderxml-mappings-table">
      <thead>
        <tr>
          <th>Vendor Code (PhotoFinale <code>idSourceProduct</code>)</th>
          <th>Pixfizz Code</th>
          <th>Label (used as <code>product_name</code>)</th>
          <th></th>
        </tr>
      </thead>
      <tbody class="orderxml-mappings-body"></tbody>
    </table>
    <button type="button" class="btn-secondary btn-add-mapping orderxml-mapping-add">+ Add Mapping</button>
  `;

  const tbody = section.querySelector('.orderxml-mappings-body');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="orderxml-mappings-empty"><td colspan="4">No mappings yet. Click "+ Add Mapping" to add one.</td></tr>';
  } else {
    rows.forEach((row) => tbody.appendChild(buildOrderXmlMappingRow(format.id, row)));
  }

  section.querySelector('.orderxml-mapping-add').addEventListener('click', () => {
    cachedOrderXmlProductMappings = readOrderXmlProductMappingsFromUI();
    if (!Array.isArray(cachedOrderXmlProductMappings[format.id])) {
      cachedOrderXmlProductMappings[format.id] = [];
    }
    cachedOrderXmlProductMappings[format.id].push({ photoFinaleCode: '', pixfizzCode: '', label: '' });
    renderOrderXmlProductMappings();
    // Focus the new row's first input for fast typing.
    const newSection = document.querySelector(`.orderxml-mappings-section[data-source-format="${format.id}"]`);
    const inputs = newSection ? newSection.querySelectorAll('.orderxml-mapping-pf') : [];
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });

  return section;
}

function buildOrderXmlMappingRow(formatId, row) {
  const tr = document.createElement('tr');
  tr.className = 'orderxml-mapping-row';
  tr.innerHTML = `
    <td><input type="text" class="orderxml-mapping-pf"     placeholder="e.g. 1082252"    value="${escapeHtml(row.photoFinaleCode || '')}"></td>
    <td><input type="text" class="orderxml-mapping-pixfizz" placeholder="e.g. PX-5X7"    value="${escapeHtml(row.pixfizzCode     || '')}"></td>
    <td><input type="text" class="orderxml-mapping-label"   placeholder="e.g. 5x7 Print" value="${escapeHtml(row.label           || '')}"></td>
    <td><button type="button" class="btn-secondary btn-sm btn-danger-text orderxml-mapping-remove">Remove</button></td>
  `;
  tr.querySelector('.orderxml-mapping-remove').addEventListener('click', () => {
    cachedOrderXmlProductMappings = readOrderXmlProductMappingsFromUI();
    const slice = cachedOrderXmlProductMappings[formatId] || [];
    const section = tr.closest('.orderxml-mappings-section');
    const tbody = section.querySelector('.orderxml-mappings-body');
    const idx = [...tbody.querySelectorAll('.orderxml-mapping-row')].indexOf(tr);
    if (idx >= 0 && idx < slice.length) {
      slice.splice(idx, 1);
      cachedOrderXmlProductMappings[formatId] = slice;
      renderOrderXmlProductMappings();
    }
  });
  return tr;
}

/**
 * Snapshot every section's rows back into the cached object. Called by
 * getFormData() at save time and by Add/Remove handlers so unsaved typing
 * isn't lost when the table re-renders.
 */
function readOrderXmlProductMappingsFromUI() {
  const host = document.getElementById('orderXmlProductMappingsHost');
  if (!host) return cachedOrderXmlProductMappings;
  const out = {};
  host.querySelectorAll('.orderxml-mappings-section').forEach((section) => {
    const formatId = section.dataset.sourceFormat;
    const rows = [...section.querySelectorAll('.orderxml-mapping-row')].map((tr) => ({
      photoFinaleCode: tr.querySelector('.orderxml-mapping-pf').value.trim(),
      pixfizzCode:     tr.querySelector('.orderxml-mapping-pixfizz').value.trim(),
      label:           tr.querySelector('.orderxml-mapping-label').value.trim(),
    }));
    out[formatId] = rows;
  });
  return out;
}

/**
 * Append draft rows for a list of unmapped vendor codes and scroll the
 * section into view. Used by the panel's "Add Mapping" affordance (chunk 7e).
 */
// ===========================================================================
// Order XML Customers (Mode 4) — RetailerDealerCode → name/email directory
// ===========================================================================
// Mirrors the product-mapping pattern: render → snapshot-on-mutate → save via
// the global settings round-trip. Validation (required fields, unique ids,
// email shape) is enforced server-side in
// config-service._sanitiseOrderXmlCustomers so the operator gets a single
// consistent error path via the settings status banner.

let cachedOrderXmlCustomers = []; // [{ customerId, customerName, customerEmail }]

function renderOrderXmlCustomers() {
  const tbody = document.getElementById('orderXmlCustomersBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (cachedOrderXmlCustomers.length === 0) {
    tbody.innerHTML =
      '<tr class="orderxml-mappings-empty"><td colspan="4">No customers yet. Click "+ Add Customer" to add one.</td></tr>';
    return;
  }
  cachedOrderXmlCustomers.forEach((row) => tbody.appendChild(buildOrderXmlCustomerRow(row)));
}

function buildOrderXmlCustomerRow(row) {
  const tr = document.createElement('tr');
  tr.className = 'orderxml-customer-row';
  tr.innerHTML = `
    <td><input type="text"  class="orderxml-customer-id"    placeholder="e.g. 9052"               value="${escapeHtml(row.customerId    || '')}"></td>
    <td><input type="text"  class="orderxml-customer-name"  placeholder="e.g. F-11 Photographic"  value="${escapeHtml(row.customerName  || '')}"></td>
    <td><input type="email" class="orderxml-customer-email" placeholder="e.g. orders@f-11.com"    value="${escapeHtml(row.customerEmail || '')}"></td>
    <td><button type="button" class="btn-secondary btn-sm btn-danger-text orderxml-customer-remove">Remove</button></td>
  `;
  tr.querySelector('.orderxml-customer-remove').addEventListener('click', () => {
    cachedOrderXmlCustomers = readOrderXmlCustomersFromUI();
    const tbody = document.getElementById('orderXmlCustomersBody');
    const idx = [...tbody.querySelectorAll('.orderxml-customer-row')].indexOf(tr);
    if (idx >= 0 && idx < cachedOrderXmlCustomers.length) {
      cachedOrderXmlCustomers.splice(idx, 1);
      renderOrderXmlCustomers();
    }
  });
  return tr;
}

function readOrderXmlCustomersFromUI() {
  const tbody = document.getElementById('orderXmlCustomersBody');
  if (!tbody) return cachedOrderXmlCustomers;
  return [...tbody.querySelectorAll('.orderxml-customer-row')].map((tr) => ({
    customerId:    tr.querySelector('.orderxml-customer-id').value.trim(),
    customerName:  tr.querySelector('.orderxml-customer-name').value.trim(),
    customerEmail: tr.querySelector('.orderxml-customer-email').value.trim(),
  }));
}

// Append a draft row for a known-missing RetailerDealerCode and scroll into
// view. Used by the panel's "Add Customer" affordance when a CUSTOMER_NOT_FOUND
// failure surfaces.
function seedOrderXmlCustomerDraft(retailerCode) {
  cachedOrderXmlCustomers = readOrderXmlCustomersFromUI();
  const code = String(retailerCode || '').trim();
  const exists = cachedOrderXmlCustomers.some((r) => r.customerId.toLowerCase() === code.toLowerCase());
  if (!exists) {
    cachedOrderXmlCustomers.push({ customerId: code, customerName: '', customerEmail: '' });
  }
  renderOrderXmlCustomers();
  const section = document.getElementById('orderXmlCustomersSection');
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ===========================================================================

function seedOrderXmlMappingDrafts(formatId, vendorCodes) {
  if (!Array.isArray(vendorCodes) || vendorCodes.length === 0) return;
  cachedOrderXmlProductMappings = readOrderXmlProductMappingsFromUI();
  if (!Array.isArray(cachedOrderXmlProductMappings[formatId])) {
    cachedOrderXmlProductMappings[formatId] = [];
  }
  for (const code of vendorCodes) {
    // Don't add duplicates if the operator already has the row in flight.
    const exists = cachedOrderXmlProductMappings[formatId].some((r) => r.photoFinaleCode === code);
    if (!exists) {
      cachedOrderXmlProductMappings[formatId].push({ photoFinaleCode: String(code), pixfizzCode: '', label: '' });
    }
  }
  renderOrderXmlProductMappings();
  const section = document.querySelector(`.orderxml-mappings-section[data-source-format="${formatId}"]`);
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ===========================================================================

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
if (selectFilmScansSourceBtn) {
  selectFilmScansSourceBtn.addEventListener('click', async () => {
    await selectDirectoryFor('filmScansSourceFolder');
  });
}
if (clearFilmScansSourceBtn) {
  clearFilmScansSourceBtn.addEventListener('click', () => {
    document.getElementById('filmScansSourceFolder').value = '';
  });
}
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
    if (tab.dataset.tab === 'orderxml') {
      loadOrderXmlPanel();
      startOrderXmlAutoRefresh();
    } else {
      stopOrderXmlAutoRefresh();
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

    const orderXmlEl = document.getElementById('orderXmlLastCheck');
    if (orderXmlEl) orderXmlEl.textContent = formatCheckTime(status.lastOrderXmlCheck);
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

  // Auto Correct + Active row. The customer-surname flag defaults ON for new
  // controllers and for legacy controllers that pre-date the field.
  const includeCustomerChecked = controller ? (controller.includeCustomerInFolder !== false) : true;
  const row4 = document.createElement('div');
  row4.innerHTML = `
    <div class="form-group checkbox-group ctrl-dpof-only">
      <label>
        <input type="checkbox" class="ctrl-auto-correct" ${controller && controller.autoCorrect ? 'checked' : ''}>
        <span>Auto Correct</span>
      </label>
    </div>
    <div class="form-group checkbox-group ctrl-dpof-only">
      <label>
        <input type="checkbox" class="ctrl-include-customer-name" ${includeCustomerChecked ? 'checked' : ''}>
        <span>Include customer surname in folder name</span>
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
      includeCustomerInFolder: isDP ? undefined : body.querySelector('.ctrl-include-customer-name').checked,
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
    _orderControllersCached = true;
    renderOrderControllers(cachedOrderControllers);
  } catch (err) {
    console.error('Error loading order controllers:', err);
  }
}

// Data-only loader for contexts that need the controller cache (e.g. the Jobs
// table's "hide ignored options" filter) but must not touch the Settings DOM.
// Guarded so it fetches once; Settings edits keep cachedOrderControllers fresh
// in place afterwards.
let _orderControllersCached = false;
async function ensureOrderControllersCached() {
  if (_orderControllersCached) return;
  try {
    cachedOrderControllers = await window.electronAPI.getOrderControllers();
    _orderControllersCached = true;
  } catch (err) {
    console.error('Error caching order controllers:', err);
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
    case 'fujijobmaker': return 'Fuji JobMaker';
    case 'fujipicpro':   return 'Fuji PIC Pro';
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
  row.querySelector('button').addEventListener('click', () => {
    row.remove();
    _refreshClearMediaTranslationsBtnState();
  });
  container.appendChild(row);
  _refreshClearMediaTranslationsBtnState();
}

// M4 (darkroom-media-lock-brief): the Clear-media-translations rescue
// button. Visible ONLY when translation rows exist AND the Paper Type
// Option Key is blank — that is the locked state (translations without
// a key are unreachable and the save-controller guard rejects them).
// The button clears the rendered rows in the modal only; the operator
// still has to press Save to persist. Cancel discards. Deliberately
// does NOT auto-clear on load or on save under any circumstances —
// operator data does not disappear without a click.
function _refreshClearMediaTranslationsBtnState() {
  const btn = document.getElementById('ocClearMediaTranslationsBtn');
  if (!btn) return;
  const key      = (document.getElementById('ocMediaOptionKey')?.value || '').trim();
  const rowCount = document.querySelectorAll('#ocMediaTranslationsList .mapping-row').length;
  btn.style.display = (!key && rowCount > 0) ? '' : 'none';
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
  '{originalFilename}',
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
  _refreshClearMediaTranslationsBtnState();
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

// M2 (2026-08-15): the Send-batches-automatically tick is only meaningful
// when a cap is set. Cap blank → disable the tick and swap the help text
// so the operator can see why. Called on modal open AND from an `input`
// listener on the cap field, so the state stays live while the operator
// edits. Checked state is preserved across disable/enable — hiding the
// user's intent behind a silent uncheck would be worse UX than showing
// a disabled tick with a stored `true`.
function _refreshAutoSendBatchesEnabledState() {
  const capInput = document.getElementById('ocMaxPrintsPerJob');
  const cbLabel  = document.getElementById('ocAutoSendBatchesLabel');
  const cb       = document.getElementById('ocAutoSendBatches');
  const help     = document.getElementById('ocAutoSendBatchesHelp');
  if (!capInput || !cbLabel || !cb || !help) return;
  const enabled = capInput.value.trim() !== '';
  cb.disabled = !enabled;
  cbLabel.style.opacity = enabled ? '' : '0.55';
  cbLabel.style.cursor  = enabled ? '' : 'not-allowed';
  help.textContent = enabled
    ? 'When ticked, over-the-cap jobs are split and dispatched without operator action. Off by default.'
    : 'Set a maximum above to enable this option. When ticked, over-the-cap jobs are split and dispatched without operator action.';
}

function updateOcTypeFields() {
  const type = document.getElementById('ocType').value;
  const isFujiJobMaker = type === 'fujijobmaker';
  const isFujiPicPro   = type === 'fujipicpro';
  // Fields shared by both Fuji types (Image Staging Root, Back-Print mode
  // + template). Split out so PIC Pro can also get printer-independent
  // back-print without duplicating the JobMaker markup.
  const isAnyFuji      = isFujiJobMaker || isFujiPicPro;
  document.getElementById('ocProcessedFolderGroup').style.display    = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocArtworkRootPathGroup').style.display     = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocOrderLastNameFormatGroup').style.display  = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocPhotoLinesGroup').style.display           = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocSizeTranslationsGroup').style.display     = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocMediaTranslationsGroup').style.display    = type === 'darkroompro' ? '' : 'none';
  document.getElementById('ocBannerSheetGroup').style.display        = (type === 'noritsu' || type === 'epson' || type === 'dpof' || type === 'pdf_copy') ? '' : 'none';
  document.getElementById('ocPipelineGroup').style.display           = type === 'pdf_copy'     ? '' : 'none';
  document.getElementById('ocCheckOrderStatusGroup').style.display   = (type === 'noritsu' || type === 'epson' || type === 'dpof' || type === 'darkroompro') ? '' : 'none';
  document.getElementById('ocIncludeCustomerNameGroup').style.display = (type === 'noritsu' || type === 'epson' || type === 'dpof') ? '' : 'none';
  document.getElementById('ocMaxPrintsPerJobGroup').style.display     = type === 'darkroompro' ? '' : 'none';
  // Fuji PIC Pro-only: order-level submission (mergeOrderJobs + wait cap)
  // and per-controller Strip Order Number Prefix (v1.13.0).
  document.getElementById('ocMergeOrderJobsGroup').style.display          = type === 'fujipicpro' ? '' : 'none';
  document.getElementById('ocOrderMergeWaitMinutesGroup').style.display    = type === 'fujipicpro' ? '' : 'none';
  document.getElementById('ocStripOrderNumberPrefixGroup').style.display   = type === 'fujipicpro' ? '' : 'none';
  // Frontline-specific fields
  document.getElementById('ocDeviceGroup').style.display     = type === 'frontline' ? '' : 'none';
  document.getElementById('ocBackPrint1Group').style.display = type === 'frontline' ? '' : 'none';
  document.getElementById('ocBackPrint2Group').style.display = type === 'frontline' ? '' : 'none';
  // Fuji-family (JobMaker + PIC Pro) shared fields
  document.getElementById('ocImageStagingRootGroup').style.display  = isAnyFuji ? '' : 'none';
  document.getElementById('ocBackprintModeGroup').style.display     = isAnyFuji ? '' : 'none';
  // JobMaker-only fields
  document.getElementById('ocPrinterNameGroup').style.display       = isFujiJobMaker ? '' : 'none';
  document.getElementById('ocAutoCorrectGroup').style.display       = isFujiJobMaker ? '' : 'none';
  document.getElementById('ocFailureTimeoutMsGroup').style.display  = isFujiJobMaker ? '' : 'none';
  // PIC Pro-only fields
  document.getElementById('ocOrderDataPathGroup').style.display           = isFujiPicPro ? '' : 'none';
  document.getElementById('ocDiginPathGroup').style.display               = isFujiPicPro ? '' : 'none';
  document.getElementById('ocMergeDataPathGroup').style.display           = isFujiPicPro ? '' : 'none';
  document.getElementById('ocGatewayTimeoutGroup').style.display          = isFujiPicPro ? '' : 'none';
  document.getElementById('ocBuildTimeoutGroup').style.display            = isFujiPicPro ? '' : 'none';
  document.getElementById('ocSendReleaseCommandGroup').style.display      = isFujiPicPro ? '' : 'none';
  document.getElementById('ocPicProIncludeCustomerNameGroup').style.display = isFujiPicPro ? '' : 'none';
  // The generic Output Path field is misleading for PIC Pro — the
  // three explicit paths above replace it. Hiding it also stops
  // polling-service._startFolderMonitors from attaching a DPOF
  // FolderMonitor (which watches for o→e/q renames PIC Pro never
  // makes) to whatever the operator happens to type in the box.
  // The ocSaveBtn handler forces controller.outputPath = '' for
  // fujipicpro so the folder-monitor gate at
  // polling-service.js:625 (`if (c.outputPath) {…}`) short-circuits.
  document.getElementById('ocOutputPathGroup').style.display              = isFujiPicPro ? 'none' : '';
  // Back-print template — visible when either Fuji type is selected AND mode === 'text'.
  // Line 2 is PIC Pro-only.
  const backprintMode = document.getElementById('ocBackprintMode').value;
  document.getElementById('ocBackprintTemplateGroup').style.display =
    (isAnyFuji && backprintMode === 'text') ? '' : 'none';
  document.getElementById('ocBackprintTemplate2Group').style.display =
    (isFujiPicPro && backprintMode === 'text') ? '' : 'none';
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
  // Fuji JobMaker fields — autoCorrect is null/true/false on the record; map to '' | 'on' | 'off'
  document.getElementById('ocImageStagingRoot').value = ctrl ? (ctrl.imageStagingRoot || '') : '';
  document.getElementById('ocPrinterName').value      = ctrl ? (ctrl.printerName      || '') : '';
  const fujiAutoCorrect = ctrl && ctrl.type === 'fujijobmaker' ? ctrl.autoCorrect : null;
  document.getElementById('ocAutoCorrect').value      =
    fujiAutoCorrect === true ? 'on' : fujiAutoCorrect === false ? 'off' : '';
  // Back-print mode + template are shared by both Fuji types. Fall back
  // to whichever Fuji type this controller is, otherwise defaults.
  const isFujiCtrl = ctrl && (ctrl.type === 'fujijobmaker' || ctrl.type === 'fujipicpro');
  document.getElementById('ocBackprintMode').value    = isFujiCtrl
    ? (ctrl.backprintMode || 'none')
    : 'none';
  document.getElementById('ocBackprintTemplate').value = isFujiCtrl
    ? (ctrl.backprintTemplate || '{firstName}/{filename}/{date}')
    : '{firstName}/{filename}/{date}';
  // Stored in ms; display in minutes. Default 30. JobMaker only.
  const failureTimeoutMs = ctrl && ctrl.type === 'fujijobmaker' && Number.isFinite(ctrl.failureTimeoutMs)
    ? ctrl.failureTimeoutMs
    : 30 * 60 * 1000;
  document.getElementById('ocFailureTimeoutMinutes').value = Math.round(failureTimeoutMs / 60000);

  // ── PIC Pro-only pre-fill ────────────────────────────────────────────
  const isPicPro = ctrl && ctrl.type === 'fujipicpro';
  document.getElementById('ocOrderDataPath').value        = isPicPro ? (ctrl.orderDataPath   || '') : '';
  document.getElementById('ocDiginPath').value            = isPicPro ? (ctrl.diginPath       || '') : '';
  document.getElementById('ocMergeDataPath').value        = isPicPro ? (ctrl.mergeDataPath   || '') : '';
  document.getElementById('ocBackprintTemplate2').value   = isPicPro ? (ctrl.backprintTemplate2 || '') : '';
  document.getElementById('ocSendReleaseCommand').checked        = isPicPro ? (ctrl.sendReleaseCommand === true) : false;
  document.getElementById('ocPicProIncludeCustomerName').checked = isPicPro ? (ctrl.includeCustomerName === true) : false;
  // Stored in ms; display Gateway in seconds and Build in minutes.
  const gatewayMs = isPicPro && Number.isFinite(ctrl.gatewayTimeoutMs) ? ctrl.gatewayTimeoutMs : 120 * 1000;
  const buildMs   = isPicPro && Number.isFinite(ctrl.buildTimeoutMs)   ? ctrl.buildTimeoutMs   : 30 * 60 * 1000;
  document.getElementById('ocGatewayTimeoutSec').value = Math.round(gatewayMs / 1000);
  document.getElementById('ocBuildTimeoutMin').value   = Math.round(buildMs / 60000);
  document.getElementById('ocAutoPrint').checked        = ctrl ? !!ctrl.autoprint                      : false;
  document.getElementById('ocBannerSheet').checked      = ctrl ? !!ctrl.bannerSheet                    : false;
  document.getElementById('ocCheckOrderStatus').checked = ctrl ? (ctrl.checkOrderStatus === true)      : false;
  // Default ON for new controllers and for legacy controllers missing the field.
  document.getElementById('ocIncludeCustomerName').checked = ctrl ? (ctrl.includeCustomerInFolder !== false) : true;
  // Batch-splitting cap — Darkroom Pro only. Blank field = feature off. A
  // non-numeric or non-positive stored value is also displayed as blank.
  const isDarkroomProCtrl = ctrl && ctrl.type === 'darkroompro';
  document.getElementById('ocMaxPrintsPerJob').value =
    isDarkroomProCtrl && Number.isFinite(ctrl.maxPrintsPerJob) && ctrl.maxPrintsPerJob > 0
      ? String(ctrl.maxPrintsPerJob)
      : '';
  // M2 (2026-08-15) auto-send-batches. Strict === true so a truthy
  // non-boolean from a hand-edited config still renders as unchecked.
  // The disabled state is a function of whether the cap input has a
  // value (see _refreshAutoSendBatchesEnabledState below).
  document.getElementById('ocAutoSendBatches').checked =
    isDarkroomProCtrl && ctrl.autoSendBatches === true;
  _refreshAutoSendBatchesEnabledState();
  // Order-level submission — Fuji PIC Pro only. Checkbox is boolean;
  // blank number field = "use the default" (do not treat null as
  // "wait forever" per the brief). A stray non-numeric or out-of-range
  // stored value is displayed as blank so the operator sees the default
  // hint text rather than being locked into a corrupt value.
  const isFujiPicProCtrl = ctrl && ctrl.type === 'fujipicpro';
  document.getElementById('ocMergeOrderJobs').checked =
    isFujiPicProCtrl ? !!ctrl.mergeOrderJobs : false;
  document.getElementById('ocOrderMergeWaitMinutes').value =
    isFujiPicProCtrl
      && Number.isInteger(ctrl.orderMergeWaitMinutes)
      && ctrl.orderMergeWaitMinutes >= 1
      && ctrl.orderMergeWaitMinutes <= 1440
      ? String(ctrl.orderMergeWaitMinutes)
      : '';
  // v1.13.0 — per-controller Strip Order Number Prefix. Blank on
  // non-picpro types (the field is hidden anyway; this keeps the
  // input value in sync with what the controller actually stores).
  document.getElementById('ocStripOrderNumberPrefix').value =
    isFujiPicProCtrl && typeof ctrl.stripOrderNumberPrefix === 'string'
      ? ctrl.stripOrderNumberPrefix
      : '';
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

// M2 (2026-08-15): live enable/disable for the auto-send-batches tick as
// the operator types the cap. See _refreshAutoSendBatchesEnabledState.
document.getElementById('ocMaxPrintsPerJob').addEventListener('input', _refreshAutoSendBatchesEnabledState);

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

document.getElementById('ocImageStagingRootBrowseBtn').addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) document.getElementById('ocImageStagingRoot').value = dir;
});

// PIC Pro's three explicit paths — one browse button each. Same
// pattern; kept as three separate handlers rather than a loop so the
// intent is obvious in the code.
document.getElementById('ocOrderDataPathBrowseBtn').addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) document.getElementById('ocOrderDataPath').value = dir;
});
document.getElementById('ocDiginPathBrowseBtn').addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) document.getElementById('ocDiginPath').value = dir;
});
document.getElementById('ocMergeDataPathBrowseBtn').addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) document.getElementById('ocMergeDataPath').value = dir;
});

// Re-run the type-fields toggle when back-print mode changes so the template
// input appears only in text mode.
document.getElementById('ocBackprintMode').addEventListener('change', updateOcTypeFields);

document.getElementById('ocAddSizeTranslationBtn').addEventListener('click', () => {
  addSizeTranslationRow(document.getElementById('ocSizeTranslationsList'));
});

document.getElementById('ocAddMediaTranslationBtn').addEventListener('click', () => {
  addMediaTranslationRow(document.getElementById('ocMediaTranslationsList'));
});

// M4 (darkroom-media-lock-brief): the Clear-media-translations rescue
// path. Wipes the rendered rows in the modal only — the operator still
// has to press Save to persist, and Cancel still discards.
// _refreshClearMediaTranslationsBtnState hides the button afterwards
// (both preconditions collapse: rowCount goes to zero).
document.getElementById('ocClearMediaTranslationsBtn').addEventListener('click', () => {
  document.getElementById('ocMediaTranslationsList').innerHTML = '';
  _refreshClearMediaTranslationsBtnState();
});

// The button's visibility depends on the key field too — reveal it when
// the operator blanks out the key on a controller that still has
// translation rows, hide it again if they type a key back in.
document.getElementById('ocMediaOptionKey').addEventListener('input', _refreshClearMediaTranslationsBtnState);

document.getElementById('ocAddPhotoLineBtn').addEventListener('click', () => {
  addPhotoLineRow(document.getElementById('ocPhotoLinesList'));
});

document.getElementById('ocSaveBtn').addEventListener('click', async () => {
  const modal      = document.getElementById('orderControllerModal');
  const name       = document.getElementById('ocName').value.trim();
  const type       = document.getElementById('ocType').value;
  // PIC Pro replaces the generic Output Path with three explicit
  // paths (Order Data / DIGIN / Merge Data). The field is hidden
  // for fujipicpro so we must not read its value AND must persist
  // '' — polling-service._startFolderMonitors gates its DPOF
  // FolderMonitor on `c.outputPath` being non-empty, and attaching
  // that monitor to a PIC Pro controller would watch for folder
  // renames PIC Pro never makes.
  const outputPath = (type === 'fujipicpro')
    ? ''
    : document.getElementById('ocOutputPath').value.trim();

  if (!name)                              { alert('Controller name is required.'); return; }
  if (!outputPath && type !== 'fujipicpro') { alert('Output path is required.');    return; }

  const editingId = modal.dataset.editingId;
  const controller = {
    id:        editingId || crypto.randomUUID(),
    name,
    type,
    outputPath,
    autoprint:        document.getElementById('ocAutoPrint').checked,
    // Fuji-family types (JobMaker + PIC Pro) always run their in-band
    // completion monitor, so checkOrderStatus is implicitly true and the
    // checkbox is hidden in updateOcTypeFields.
    checkOrderStatus: (['noritsu', 'epson', 'dpof', 'darkroompro'].includes(type))
      ? document.getElementById('ocCheckOrderStatus').checked
      : true,
  };
  if (type === 'dpof' || type === 'pdf_copy') {
    controller.bannerSheet = document.getElementById('ocBannerSheet').checked;
  }
  if (type === 'noritsu' || type === 'epson' || type === 'dpof') {
    controller.includeCustomerInFolder = document.getElementById('ocIncludeCustomerName').checked;
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

    // Batch-splitting cap. Blank = null (feature off). A stray non-numeric
    // or out-of-range value is rejected rather than clamped so a typo can't
    // silently split every job (e.g. `10` when the operator meant `100`).
    const maxPrintsRaw = document.getElementById('ocMaxPrintsPerJob').value.trim();
    if (maxPrintsRaw === '') {
      controller.maxPrintsPerJob = null;
    } else {
      const n = parseInt(maxPrintsRaw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 10000 || String(n) !== maxPrintsRaw) {
        alert('Maximum prints per job must be a whole number between 1 and 10000, or blank for no limit.');
        return;
      }
      controller.maxPrintsPerJob = n;
    }

    // M2 (2026-08-15) auto-send-batches. MUST live inside the
    // `if (type === 'darkroompro')` block — assigning outside would
    // silently no-op the field on save. That exact bug shipped in
    // 1.12.0 with the PIC Pro merge flag and cost a release; the
    // discipline is per-type field, per-type block.
    controller.autoSendBatches = document.getElementById('ocAutoSendBatches').checked;

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
        'Either fill in the option key (e.g. "finish-options"), or use the Clear media translations button next to this field to remove the rows.'
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
  if (type === 'fujijobmaker') {
    const imageStagingRoot = document.getElementById('ocImageStagingRoot').value.trim();
    const printerName      = document.getElementById('ocPrinterName').value.trim();
    const autoCorrectRaw   = document.getElementById('ocAutoCorrect').value;
    const backprintMode    = document.getElementById('ocBackprintMode').value || 'none';
    const backprintTemplate = document.getElementById('ocBackprintTemplate').value.trim();
    const failureTimeoutMin = parseInt(document.getElementById('ocFailureTimeoutMinutes').value, 10);

    // Renderer-side guards mirror the required-field checks in
    // validateControllerConfig (src/main/services/fuji-jobmaker-config.js).
    // The validator runs again at the IPC boundary so a bad payload can't
    // slip past, but surfacing errors before IPC keeps the UX snappy.
    if (!imageStagingRoot)         { alert('Image Staging Root is required for Fuji JobMaker controllers.'); return; }
    if (backprintMode === 'text' && !backprintTemplate) {
      alert('Back Print Template is required when Back Print Mode is "Text".'); return;
    }
    if (!Number.isFinite(failureTimeoutMin) || failureTimeoutMin < 1 || failureTimeoutMin > 1440) {
      alert('Failure Timeout must be between 1 and 1440 minutes.'); return;
    }

    controller.hotFolderPath     = outputPath; // The Output Path field IS the Frontier hot folder for Fuji.
    controller.imageStagingRoot  = imageStagingRoot;
    controller.printerName       = printerName;
    controller.autoCorrect       = autoCorrectRaw === 'on' ? true : autoCorrectRaw === 'off' ? false : null;
    controller.backprintMode     = backprintMode;
    controller.backprintTemplate = backprintTemplate;
    controller.failureTimeoutMs  = failureTimeoutMin * 60 * 1000;
  }
  if (type === 'fujipicpro') {
    // Three explicit paths — labs lay these out on different servers,
    // so we don't derive them. Renderer-side guards mirror the
    // required-field checks in fuji-pic-pro-config.validateControllerConfig;
    // the validator runs again at the IPC boundary so a bad payload
    // can't slip past.
    const orderDataPath     = document.getElementById('ocOrderDataPath').value.trim();
    const diginPath         = document.getElementById('ocDiginPath').value.trim();
    const mergeDataPath     = document.getElementById('ocMergeDataPath').value.trim();
    const imageStagingRoot  = document.getElementById('ocImageStagingRoot').value.trim();
    const backprintMode     = document.getElementById('ocBackprintMode').value || 'none';
    const backprintTemplate = document.getElementById('ocBackprintTemplate').value.trim();
    const backprintTemplate2 = document.getElementById('ocBackprintTemplate2').value.trim();
    const gatewayTimeoutSec = parseInt(document.getElementById('ocGatewayTimeoutSec').value, 10);
    const buildTimeoutMin   = parseInt(document.getElementById('ocBuildTimeoutMin').value, 10);

    // Order-level submission (M5 order-level-submission-picpro-brief).
    // Reject an out-of-range wait cap rather than clamping so an
    // operator meaning "30" but typing "300" doesn't silently stretch
    // every merge wait to 5 hours.
    const mergeOrderJobs = document.getElementById('ocMergeOrderJobs').checked;
    const orderWaitRaw   = document.getElementById('ocOrderMergeWaitMinutes').value.trim();

    if (!orderDataPath)    { alert('Order Data Path is required for Fuji PIC Pro controllers.'); return; }
    if (!diginPath)        { alert('DIGIN Path is required for Fuji PIC Pro controllers.'); return; }
    if (!imageStagingRoot) { alert('Image Staging Root is required for Fuji PIC Pro controllers.'); return; }
    if (backprintMode === 'text' && !backprintTemplate) {
      alert('Back Print Template is required when Back Print Mode is "Text".'); return;
    }
    if (!Number.isFinite(gatewayTimeoutSec) || gatewayTimeoutSec < 10 || gatewayTimeoutSec > 1800) {
      alert('Gateway Timeout must be between 10 and 1800 seconds.'); return;
    }
    if (!Number.isFinite(buildTimeoutMin) || buildTimeoutMin < 1 || buildTimeoutMin > 1440) {
      alert('Build Timeout must be between 1 and 1440 minutes.'); return;
    }
    // Wait cap: blank → null ("use the 30-minute default"; null is NOT
    // "wait forever" — see the brief). Non-blank must parse as an
    // integer in [1, 1440].
    let orderMergeWaitMinutes;
    if (orderWaitRaw === '') {
      orderMergeWaitMinutes = null;
    } else {
      const n = parseInt(orderWaitRaw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 1440 || String(n) !== orderWaitRaw) {
        alert('Order-merge wait cap must be a whole number of minutes between 1 and 1440, or blank for the 30-minute default.');
        return;
      }
      orderMergeWaitMinutes = n;
    }

    controller.orderDataPath      = orderDataPath;
    controller.diginPath          = diginPath;
    controller.mergeDataPath      = mergeDataPath;
    controller.imageStagingRoot   = imageStagingRoot;
    controller.backprintMode      = backprintMode;
    controller.backprintTemplate  = backprintTemplate;
    controller.backprintTemplate2 = backprintTemplate2;
    controller.gatewayTimeoutMs   = gatewayTimeoutSec * 1000;
    controller.buildTimeoutMs     = buildTimeoutMin * 60 * 1000;
    controller.sendReleaseCommand = document.getElementById('ocSendReleaseCommand').checked;
    controller.includeCustomerName = document.getElementById('ocPicProIncludeCustomerName').checked;
    controller.mergeOrderJobs        = !!mergeOrderJobs;
    controller.orderMergeWaitMinutes = orderMergeWaitMinutes;
    // v1.13.0 — per-controller Strip Order Number Prefix. Free string,
    // trimmed; blank is the "no strip" default. Semantic validation
    // (leading-match, case-insensitive, never-strip-to-empty) is in
    // src/shared/printUtils.stripOrderNumberPrefix — no renderer-side
    // check needed here.
    controller.stripOrderNumberPrefix = document.getElementById('ocStripOrderNumberPrefix').value.trim();
    // `outputPath` is deliberately forced to '' at the top of the
    // handler for fujipicpro — the three explicit paths above are
    // what the writer consumes, and persisting a non-empty value
    // would let polling-service._startFolderMonitors attach a DPOF
    // FolderMonitor to it.
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

    // v1.7.8 — "Hold for manual release" checkbox. Held jobs surface in
    // Job Review with a Resolve button (chip class = hold-review-chip,
    // reason code = routing-hold). Toggling OFF drops the routing-hold
    // reason on the next derive; already-released jobs stay released
    // (the _routingHoldReleased flag on the job is sticky).
    const holdLabel = document.createElement('label');
    holdLabel.className = 'process-routing-hold-label';
    holdLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#444;cursor:pointer;margin-left:6px;white-space:nowrap;';
    holdLabel.title = 'Hold new jobs matching this process until an operator resolves each one in Job Review.';
    const holdCb = document.createElement('input');
    holdCb.type = 'checkbox';
    holdCb.className = 'process-routing-hold-cb';
    holdCb.checked = !!(current && current.hold);
    const holdText = document.createElement('span');
    holdText.textContent = 'Hold for manual release';
    holdLabel.appendChild(holdCb);
    holdLabel.appendChild(holdText);

    const saveCurrent = async () => {
      // The controller select and the hold checkbox share a single save —
      // saveProcessMapping is an upsert keyed by process name, so we must
      // always send both fields together to preserve the other one.
      await window.electronAPI.saveProcessMapping({
        process,
        controllerId: select.value || null,
        hold: holdCb.checked,
      });
      await resolveRoutesForReceivedJobs(allJobs);
      renderJobTable(getFilteredJobs());
    };

    // Save immediately on change — no separate Save button
    select.addEventListener('change', async () => {
      try {
        await saveCurrent();
      } catch (err) {
        showToast('Error saving process mapping: ' + err.message, 'error');
      }
    });
    holdCb.addEventListener('change', async () => {
      try {
        await saveCurrent();
      } catch (err) {
        showToast('Error saving hold flag: ' + err.message, 'error');
        holdCb.checked = !holdCb.checked; // revert
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
    row.appendChild(holdLabel);
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
    // Refresh BOTH the top-of-app banner and the Settings roll-up on
    // every load. loadChannelMappings runs after every save / delete /
    // CSV import as well as on Settings → Routing open, so both
    // surfaces stay in sync — without this, the roll-up would drop
    // to 0 after a fix while the banner still showed the stale count
    // until app restart. Fire-and-forget for the same reason as the
    // startup banner call — neither surface needs to block the render.
    // refreshHealthBanner is a no-op if the operator has already
    // dismissed the banner this session.
    refreshHealthBanner();
    refreshChannelMappingsHealthRollup();
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

    // Option names this controller ignores when matching — rendered in red in
    // each mapping row so it's obvious which options are non-matching.
    const ignoreSet = new Set(
      (ctrl && Array.isArray(ctrl.ignoredOptionNames) ? ctrl.ignoredOptionNames : [])
        .map(n => String(n == null ? '' : n).trim().toLowerCase())
        .filter(Boolean)
    );

    // Controller types that don't consult `printSizeCode` — same list as
    // src/shared/controllerTypes.NON_DPOF_CONTROLLER_TYPES (the canonical
    // source both routing-service and configHealth import). Duplicated
    // here because renderer.js loads under context isolation and cannot
    // require(); keep the two in sync by grep. Only DPOF-family rows get
    // the "no print size" warning badge for the DPOF `printSizeCode`
    // field (non-DPOF types don't have the field at all).
    const NON_DPOF_TYPES = new Set(['darkroompro', 'fujijobmaker', 'fujipicpro', 'frontline', 'folder_copy', 'pdf_copy']);
    const ctrlType     = ctrl && ctrl.type ? String(ctrl.type) : '';
    const isDpofFamily = !NON_DPOF_TYPES.has(ctrlType);
    // Fuji-family (JobMaker + PIC Pro) — different mapping shape
    // (printCode + printSize + surface) so it renders a bespoke row and
    // gets its own amber badge for M0's `printSize` field.
    const isFujiFamily = ctrlType === 'fujijobmaker' || ctrlType === 'fujipicpro';

    for (const mapping of ctrlMappings) {
      const optionsHtml = (mapping.options || [])
        .map(o => {
          const text    = escapeHtml(`${o.name}: ${o.value}`);
          const ignored = ignoreSet.has(String(o.name == null ? '' : o.name).trim().toLowerCase());
          return ignored
            ? `<span class="cm-opt-ignored" title="Ignored when matching jobs on this controller">${text}</span>`
            : text;
        })
        .join(' · ');

      const row = document.createElement('div');
      row.className = 'channel-mapping-row';
      // M6: enables "Jump to first" in the health roll-up to scroll
      // this row into view via querySelector on the mapping id.
      if (mapping.id != null) row.dataset.mappingId = String(mapping.id);

      const infoDiv = document.createElement('div');
      infoDiv.className = 'channel-mapping-info';
      const isFrontlineMapping = ctrl && ctrl.type === 'frontline';
      // Blank printSizeCode on a DPOF-family mapping gets an amber
      // warning chip instead of the empty size span — flags historical
      // mappings the step-2 backfill couldn't fill (non-WxH legacy
      // values). Non-DPOF types render unchanged.
      const printSizeHtml = mapping.printSizeCode
        ? `<span class="channel-mapping-options">${escapeHtml(mapping.printSizeCode)}</span>`
        : (isDpofFamily
            ? `<span class="badge badge-warning" title="No Print Size Code configured — jobs routed here will fail at dispatch. Edit to set the Print Size Code.">⚠ No print size</span>`
            : '');
      // Fuji-family badge — Manual Crop needs `printSize` to know the
      // crop aspect. Blank means the M0 backfill couldn't derive it
      // from `printCode` (or a fresh mapping was saved via a stale
      // renderer). Jobs still dispatch but Manual Crop falls back to
      // a 1:1 square — flag it so the operator can fix it.
      const fujiPrintSizeHtml = isFujiFamily
        ? (mapping.printSize
            ? `<span class="channel-mapping-options">${escapeHtml(mapping.printSize)}</span>`
            : `<span class="badge badge-warning" title="No Print Size configured — Manual Crop will fall back to a 1:1 square for jobs routed here. Edit to set the crop aspect.">⚠ No print size</span>`)
        : '';
      infoDiv.innerHTML =
        `<span class="channel-mapping-product">${escapeHtml(mapping.productCode)}</span>` +
        (optionsHtml ? `<span class="channel-mapping-options">${optionsHtml}</span>` : '') +
        (isFrontlineMapping
          ? `<span class="channel-mapping-channel">→ ${escapeHtml(mapping.batchCode || '(no batch code)')}</span>` +
            (mapping.sortString ? `<span class="channel-mapping-options">${escapeHtml(mapping.sortString)}</span>` : '')
          : isFujiFamily
            ? `<span class="channel-mapping-channel">→ ${escapeHtml(mapping.printCode || '(no print code)')}</span>` +
              fujiPrintSizeHtml +
              (mapping.surface ? `<span class="channel-mapping-options">${escapeHtml(mapping.surface)}</span>` : '')
            : `<span class="channel-mapping-channel">→ Ch ${mapping.channelNumber}</span>` +
              printSizeHtml) +
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
  // Fuji-family fields (JobMaker + PIC Pro)
  document.getElementById('cmPrintCode').value        = mapping ? (mapping.printCode   || '') : '';
  document.getElementById('cmPrintSize').value        = mapping ? (mapping.printSize   || '') : '';
  document.getElementById('cmSurface').value          = mapping ? (mapping.surface     || '') : '';
  document.getElementById('cmSurfaceCode').value      = mapping ? (mapping.surfaceCode || '') : '';
  // PIC Pro-only: Color=. Default to 'C' when the mapping doesn't
  // carry one (fresh mapping or JobMaker→PIC Pro switch). Fix 13
  // makes this a real UI field so editing a B&W mapping doesn't
  // silently reset to C via the validator's default.
  document.getElementById('cmColor').value            = mapping && mapping.color ? mapping.color : 'C';

  const optsList = document.getElementById('cmOptionsList');
  optsList.innerHTML = '';
  const ignoreSet = controllerIgnoredNameSet(mapping ? mapping.controllerId : '');
  for (const opt of (mapping ? (mapping.options || []) : [])) {
    const isIgnored = ignoreSet.has(String(opt.name == null ? '' : opt.name).trim().toLowerCase());
    addChannelMappingOptionRow(optsList, opt.name, opt.value, isIgnored);
  }

  modal.dataset.editingId = mapping ? mapping.id : '';

  // Show/hide DPOF vs Frontline fields based on selected controller type
  _updateCmFields(ctrlSel.value, ctrlList);

  modal.classList.remove('hidden');
}

function _updateCmFields(controllerId, ctrlList) {
  const ctrl       = (ctrlList || cachedOrderControllers).find(c => c.id === controllerId);
  const isFrontline   = ctrl && ctrl.type === 'frontline';
  const isDarkroomPro = ctrl && ctrl.type === 'darkroompro';
  // Fuji family: JobMaker + PIC Pro share the printCode/printSize/surface
  // channel-mapping shape. Keep the checks in sync — anything that gates
  // on "Fuji-style mapping" must include both types. Color is PIC Pro-
  // only (JobMaker doesn't have Color=).
  const isFuji         = ctrl && (ctrl.type === 'fujijobmaker' || ctrl.type === 'fujipicpro');
  const isFujiPicPro   = ctrl && ctrl.type === 'fujipicpro';

  document.getElementById('cmChannelNumberGroup').style.display  = (!isFrontline && !isDarkroomPro && !isFuji) ? '' : 'none';
  document.getElementById('cmSkipAutoPrintGroup').style.display  = (!isFrontline && !isFuji) ? '' : 'none';
  document.getElementById('cmPrintSizeCodeGroup').style.display  = (!isFrontline && !isDarkroomPro && !isFuji) ? '' : 'none';
  document.getElementById('cmBatchCodeGroup').style.display      = isFrontline ? '' : 'none';
  document.getElementById('cmSortStringGroup').style.display     = isFrontline ? '' : 'none';
  // Fuji-family: JobMaker + PIC Pro
  document.getElementById('cmPrintCodeGroup').style.display      = isFuji ? '' : 'none';
  document.getElementById('cmPrintSizeGroup').style.display      = isFuji ? '' : 'none';
  document.getElementById('cmSurfaceGroup').style.display        = isFuji ? '' : 'none';
  document.getElementById('cmSurfaceCodeGroup').style.display    = isFuji ? '' : 'none';
  // PIC Pro-only: Color= is a mandatory field in order.txt (spec p. 353).
  // JobMaker's format has no Color= equivalent so the group stays hidden
  // for `fujijobmaker`.
  document.getElementById('cmColorGroup').style.display          = isFujiPicPro ? '' : 'none';
}

function addChannelMappingOptionRow(container, name = '', value = '', ignored = false) {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
  row.innerHTML = `
    <input type="text" class="cm-opt-name"  placeholder="name"  value="${escapeHtml(name)}"  style="flex:1">
    <span style="color:#666">:</span>
    <input type="text" class="cm-opt-value" placeholder="value" value="${escapeHtml(value)}" style="flex:1">
    <label title="Ignore this option when matching jobs on this controller (applies to every mapping on the controller)" style="display:flex;align-items:center;gap:3px;font-size:11px;color:#888;white-space:nowrap;cursor:pointer;-webkit-app-region:no-drag">
      <input type="checkbox" class="cm-opt-ignore" ${ignored ? 'checked' : ''} style="margin:0">Ignore
    </label>
    <button type="button" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">&times;</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

/**
 * Build the lowercased set of option names a controller currently ignores for
 * matching. Used to seed the per-row "Ignore" checkboxes in the channel mapping
 * modal. Tolerates missing controller / missing field (returns empty set).
 */
function controllerIgnoredNameSet(controllerId) {
  const ctrl = (cachedOrderControllers || []).find(c => c.id === controllerId);
  const list = ctrl && Array.isArray(ctrl.ignoredOptionNames) ? ctrl.ignoredOptionNames : [];
  return new Set(list.map(n => String(n == null ? '' : n).trim().toLowerCase()).filter(Boolean));
}

/** Re-seed each existing option row's Ignore checkbox from a controller's ignore list. */
function reseedCmIgnoreChecks(controllerId) {
  const ignore = controllerIgnoredNameSet(controllerId);
  document.querySelectorAll('#cmOptionsList .mapping-row').forEach(r => {
    const name = (r.querySelector('.cm-opt-name')?.value || '').trim().toLowerCase();
    const box  = r.querySelector('.cm-opt-ignore');
    if (box) box.checked = !!name && ignore.has(name);
  });
}

document.getElementById('addChannelMappingBtn').addEventListener('click', () => openChannelMappingModal(null));
document.getElementById('cmControllerId').addEventListener('change', (e) => {
  _updateCmFields(e.target.value, cachedOrderControllers);
  // The ignore list belongs to the controller, so re-seed the per-row Ignore
  // checkboxes whenever the selected controller changes.
  reseedCmIgnoreChecks(e.target.value);
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
  const printCode      = document.getElementById('cmPrintCode').value.trim();
  const printSize      = document.getElementById('cmPrintSize').value.trim();
  const surface        = document.getElementById('cmSurface').value.trim();
  const surfaceCode    = document.getElementById('cmSurfaceCode').value.trim();
  const cmColor        = document.getElementById('cmColor').value;

  if (!controllerId)                         { alert('Please select a controller.');                  return; }
  if (!productCode)                          { alert('Product code is required.');                    return; }

  let   selectedController = cachedOrderControllers.find(c => c.id === controllerId);
  const isFrontlineCtrl    = selectedController?.type === 'frontline';
  const isDarkroomProCtrl  = selectedController?.type === 'darkroompro';
  const isFujiCtrl         = selectedController?.type === 'fujijobmaker'
                          || selectedController?.type === 'fujipicpro';

  // Bare-WxH shape check — same regex the IPC-side validator (routing-
  // service.isBareWxH) uses. Duplicated here purely for a friendlier
  // pre-submit message; the IPC handler enforces the same rule server-side.
  const BARE_WXH = /^\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*$/i;

  if (isFujiCtrl) {
    if (!printCode)                             { alert('Print Code is required for Fuji mappings.'); return; }
    // Print Size is a Manual-Crop aspect indicator only. PIC Pro
    // mappings are new so we require it up front. JobMaker allows
    // blank so a live install whose printCode is a lab package code
    // (backfill left printSize blank) can still be edited without
    // rejection — the amber routing-list badge + Manual Crop ⚠ pill
    // keep the problem visible. Non-blank values still get the
    // shape check for both types.
    if (selectedController?.type === 'fujipicpro' && !printSize) {
      alert('Print Size is required for Fuji PIC Pro mappings — sets the crop aspect (e.g. 6x4, 3.5x5).'); return;
    }
    if (printSize && !BARE_WXH.test(printSize)) { alert('Print Size must be a bare WxH shape like 6x4 or 3.5x5.'); return; }
    if (!surface)                               { alert('Surface is required for Fuji mappings.'); return; }
  } else if (isFrontlineCtrl) {
    if (!batchCode) { alert('Batch code is required for Frontline controllers.'); return; }
  } else if (!isDarkroomProCtrl) {
    if (isNaN(channelNumber) || channelNumber < 1) { alert('Channel number must be a positive integer.'); return; }
    if (!printSizeCode)                            { alert('Print Size Code is required — it sets the print size for this product code.'); return; }
  }

  const options = [];
  const tickedIgnore  = [];          // option names ticked "Ignore" (as typed)
  const untickedNames = new Set();   // lowercased names present but NOT ticked
  document.querySelectorAll('#cmOptionsList .mapping-row').forEach(r => {
    const name  = r.querySelector('.cm-opt-name').value.trim();
    const value = r.querySelector('.cm-opt-value').value.trim();
    const ignoreChecked = !!r.querySelector('.cm-opt-ignore')?.checked;
    if (name && value) options.push({ name, value });
    if (name) {
      if (ignoreChecked) tickedIgnore.push(name);
      else               untickedNames.add(name.toLowerCase());
    }
  });

  const skipAutoPrint = document.getElementById('cmSkipAutoPrint').checked;
  const editingId = modal.dataset.editingId;
  try {
    // ── Reconcile the controller-wide ignore list with the per-row toggles ──
    // Semantics: ignore is a property of the CONTROLLER ("ignore this option
    // name when matching any job on this controller"), but it's edited here via
    // the per-row checkboxes. Names ticked are added; names shown-but-unticked
    // are removed; ignore names for options NOT shown in this modal (other
    // products on the same controller) are left untouched. Persist BEFORE the
    // channel-mapping save so the runAutoPrint() that save triggers re-resolves
    // routes with the new ignore list already in effect.
    if (selectedController) {
      const existing = Array.isArray(selectedController.ignoredOptionNames)
        ? selectedController.ignoredOptionNames : [];
      const byLower = new Map();   // lowercased name -> display name
      for (const n of existing) {
        const key = String(n == null ? '' : n).trim().toLowerCase();
        if (key) byLower.set(key, String(n).trim());
      }
      for (const n of tickedIgnore) byLower.set(n.toLowerCase(), n);
      for (const key of untickedNames) {
        if (!tickedIgnore.some(t => t.toLowerCase() === key)) byLower.delete(key);
      }
      const newIgnore   = Array.from(byLower.values());
      const existingSet  = new Set(existing.map(x => String(x).trim().toLowerCase()).filter(Boolean));
      const newSet       = new Set(newIgnore.map(x => x.toLowerCase()));
      const changed = existingSet.size !== newSet.size || [...newSet].some(k => !existingSet.has(k));
      if (changed) {
        const updatedCtrl = { ...selectedController, ignoredOptionNames: newIgnore };
        const ctrlRes = await window.electronAPI.saveOrderController(updatedCtrl);
        if (ctrlRes && ctrlRes.success === false) {
          showToast('Error saving ignored options: ' + (ctrlRes.error || 'Save failed'), 'error', 8000);
          return;
        }
        cachedOrderControllers = cachedOrderControllers.map(c =>
          c.id === updatedCtrl.id ? updatedCtrl : c
        );
        selectedController = updatedCtrl;
      }
    }

    const payload = {
      id: editingId || crypto.randomUUID(),
      controllerId,
      productCode,
      options,
      channelNumber:  (isFrontlineCtrl || isFujiCtrl) ? null : channelNumber,
      printSizeCode:  (isFrontlineCtrl || isFujiCtrl) ? ''   : (printSizeCode || ''),
      batchCode:      isFrontlineCtrl ? batchCode  : '',
      sortString:     isFrontlineCtrl ? sortString : '',
      skipAutoPrint:  (isFrontlineCtrl || isFujiCtrl) ? false : skipAutoPrint,
    };
    if (isFujiCtrl) {
      payload.printCode   = printCode;
      payload.printSize   = printSize;
      payload.surface     = surface;
      payload.surfaceCode = surfaceCode;
      // PIC Pro-only. Sending `color` on a JobMaker payload is a
      // no-op (JobMaker's validator ignores it), but keep the
      // shape narrow so the persisted mapping doesn't grow an
      // extraneous `color` key on JobMaker rows.
      if (selectedController?.type === 'fujipicpro') {
        payload.color = cmColor || 'C';
      }
    }
    const result = await window.electronAPI.saveChannelMapping(payload);
    // Surface validator failures from the IPC handler (e.g. Fuji
    // validateProductMappingConfig). Keep the modal open so the operator
    // can fix the inputs in place — mirrors the controller-save pattern.
    if (result && result.success === false) {
      showToast('Error saving channel mapping: ' + (result.error || 'Save failed'), 'error', 8000);
      return;
    }
    modal.classList.add('hidden');
    await loadChannelMappings();
  } catch (err) {
    showToast('Error saving channel mapping: ' + err.message, 'error');
  }
});

// ── CSV Import / Export ───────────────────────────────────────────────────────

// --- CSV parsing helpers ---

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

  // Parse in the main process via ohd:routing:parse-mappings-csv — the
  // parser lives in src/shared/csvChannelMappingsParser.js. renderer.js
  // loads under context isolation and cannot require() a shared module,
  // so keeping the parser in main is the way to have ONE tested
  // implementation that actually runs. Sub-millisecond round-trip at
  // realistic CSV sizes (labs import <500 rows).
  const { rows, skipped } = await window.electronAPI.parseChannelMappingsCsv(csvImportFileContent);

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
      // saveChannelMapping's IPC contract is {success:true} | {success:false,error}
      // — validator failures RETURN {success:false} rather than throwing (see
      // ipc-handlers.js:1301-1311 for the DPOF print-size validator). Pre-M2
      // this loop only caught thrown errors and bumped `imported++`
      // unconditionally, so every rejected row silently passed and the
      // summary reported "N imported, 0 skipped" while persisting nothing —
      // exactly the bug that stranded a lab's Noritsu CSV import in
      // v1.7.22+. Match the shape the modal and Assign handlers use
      // (renderer.js:6128, :1678, :1826).
      const result = await window.electronAPI.saveChannelMapping({
        id: existingId || crypto.randomUUID(),
        controllerId,
        productCode: row.productCode,
        options: row.options,
        channelNumber: row.channelNumber,
        // Optional print_size_code CSV column (v1.10.1+). Absent → ''
        // from the parser (pre-v1.10.1 byte-identical). Populated →
        // passes through to the IPC handler; DPOF-family controllers
        // require it, non-DPOF (Fuji / DarkroomPro / Frontline /
        // folder_copy / pdf_copy) ignore it — validateDPOFPrintSizeCode
        // early-returns {valid:true} for those types (see
        // routing-service.js:1236).
        printSizeCode: row.printSizeCode || '',
      });
      if (result && result.success === false) {
        importErrors.push({ ...row, reason: result.error || 'Rejected by save handler' });
        continue;
      }
      imported++;
    } catch (err) {
      importErrors.push({ ...row, reason: err.message });
    }
  }

  // Build summary. Both parser-side skips and IPC-side rejections are named
  // by line number so the operator can jump to the offending CSV row —
  // channel + product code carried in parentheses for the IPC-side entries
  // since a single line can be rejected for reasons unrelated to those
  // fields (e.g. missing printSizeCode on a DPOF row).
  const allSkipped = [
    ...skipped.map(s => `Line ${s.lineNum}: ${s.reason}`),
    ...importErrors.map(e => `Line ${e.lineNum} (ch ${e.channelNumber}, product ${e.productCode}): ${e.reason}`),
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

    // Build header — controller column omitted so the file is a clean round-trip with import.
    // print_size_code column emitted from v1.10.1 onward so DPOF-family
    // mappings round-trip losslessly. Non-DPOF controllers leave the
    // cell blank; the parser tolerates the blank cell and the IPC
    // validator ignores populated printSizeCode for non-DPOF types.
    const optionHeaders = Array.from({ length: maxOptions }, () => 'option');
    const header = ['channel', 'product_code', 'print_size_code', ...optionHeaders].join(',');

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
          csvEscape(m.printSizeCode || ''),
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

// ===========================================================================
// Order XML Panel (Mode 4) — operator-facing ingestion history
// ===========================================================================
// Plain HTML/JS panel mirroring the Jobs tab (no React bundle needed). All
// data flows through window.electronAPI.orderXml* — IPC handlers in
// src/main/ipc-handlers.js + helpers in services/order-xml-ipc-helpers.js.

const orderXmlState = {
  records:        [],        // last response from orderXml:listRecords
  hotFolders:     [],        // for the Hot Folder filter dropdown
  filter:         'all',     // 'all' | 'submitted' | 'duplicate' | 'failed'
  hotFolderId:    '',        // '' = all
  search:         '',
  sort:           { col: 'ingestedAt', dir: 'desc' },
  refreshTimer:   null,
};

async function loadOrderXmlPanel() {
  try {
    // Pull records and hot folders in parallel — neither depends on the other.
    const [recordsRes, hotFoldersRes] = await Promise.all([
      window.electronAPI.orderXmlListRecords({}),
      window.electronAPI.orderXmlGetHotFolders(),
    ]);
    if (recordsRes && recordsRes.ok) {
      orderXmlState.records = Array.isArray(recordsRes.records) ? recordsRes.records : [];
    }
    if (hotFoldersRes && hotFoldersRes.ok) {
      orderXmlState.hotFolders = Array.isArray(hotFoldersRes.hotFolders) ? hotFoldersRes.hotFolders : [];
      populateOrderXmlHotFolderFilter();
    }
    renderOrderXmlPanel();
  } catch (err) {
    console.error('[orderxml] loadOrderXmlPanel error', err);
  }
}

function populateOrderXmlHotFolderFilter() {
  const sel = document.getElementById('orderXmlHotFolderFilter');
  if (!sel) return;
  const previous = sel.value;
  // Rebuild while preserving the current selection.
  sel.innerHTML = '<option value="">All hot folders</option>' +
    orderXmlState.hotFolders.map((hf) =>
      `<option value="${escapeHtml(hf.id)}">${escapeHtml(hf.label || '(unnamed)')}</option>`
    ).join('');
  // If the previously-selected folder still exists, keep it selected.
  if (previous && orderXmlState.hotFolders.some((hf) => hf.id === previous)) {
    sel.value = previous;
  }
}

function renderOrderXmlPanel() {
  const tbody = document.getElementById('orderXmlTableBody');
  const empty = document.getElementById('orderXmlEmptyState');
  const table = document.getElementById('orderXmlTable');
  if (!tbody || !empty || !table) return;

  // 1. Filter
  let rows = orderXmlState.records;
  if (orderXmlState.filter !== 'all') {
    rows = rows.filter((r) => r.status === orderXmlState.filter);
  }
  if (orderXmlState.hotFolderId) {
    rows = rows.filter((r) => r.hotFolderId === orderXmlState.hotFolderId);
  }
  const q = orderXmlState.search.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      String(r.customer       || '').toLowerCase().includes(q) ||
      String(r.customerEmail  || '').toLowerCase().includes(q) ||
      String(r.externalId     || '').toLowerCase().includes(q) ||
      String(r.filename       || '').toLowerCase().includes(q)
    );
  }

  // 2. Sort
  const { col, dir } = orderXmlState.sort;
  const mul = dir === 'asc' ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (col === 'total') { va = Number(va) || 0; vb = Number(vb) || 0; }
    if (va === vb) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va > vb ? mul : -mul;
  });

  // 3. Render
  tbody.innerHTML = '';
  if (rows.length === 0) {
    empty.style.display = '';
    table.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  table.style.display = '';
  rows.forEach((r) => tbody.appendChild(buildOrderXmlRow(r)));
}

function buildOrderXmlRow(r) {
  const tr = document.createElement('tr');
  tr.dataset.id = r.id || '';

  const total    = (r.total != null && r.total !== '')
    ? `$${Number(r.total).toFixed(2)}`
    : '';
  const time     = formatOrderXmlTime(r.ingestedAt);
  const products = truncate(String(r.productSummary || ''), 60);
  const errMsg   = r.errorMessage ? truncate(String(r.errorMessage), 80) : '';

  tr.innerHTML = `
    <td><span class="orderxml-status-badge orderxml-status-${escapeHtml(r.status || '')}">${escapeHtml(r.status || '')}</span></td>
    <td>${escapeHtml(time)}</td>
    <td>${escapeHtml(r.hotFolderLabel || '')}</td>
    <td><code class="orderxml-filename">${escapeHtml(r.filename || '')}</code></td>
    <td>${escapeHtml(r.externalId || '')}</td>
    <td>${escapeHtml(r.customer || '')}</td>
    <td class="orderxml-total">${total}</td>
    <td title="${escapeHtml(r.productSummary || '')}">${escapeHtml(products)}</td>
    <td class="orderxml-notes" title="${escapeHtml(r.errorMessage || '')}">${escapeHtml(errMsg)}</td>
    <td class="orderxml-actions"></td>
  `;

  const actions = tr.querySelector('.orderxml-actions');

  if (r.externalId) {
    actions.appendChild(makeOrderXmlActionBtn('Copy #', async () => {
      try {
        await navigator.clipboard.writeText(String(r.externalId));
        showToast(`Copied ${r.externalId}`, 'success', 1500);
      } catch (_) { showToast('Copy failed', 'error'); }
    }));
  }

  if (r.status === 'failed') {
    // UNMAPPED_PRODUCTS rows get a one-click jump to Settings → Order XML →
    // Product Mappings with draft rows pre-filled for the offending vendor
    // codes. The operator types Pixfizz code + label, saves, then clicks
    // Retry on this row to re-run the pipeline.
    if (r.errorCode === 'UNMAPPED_PRODUCTS' && r.sourceFormat) {
      const codes = (r.errorDetails && Array.isArray(r.errorDetails.unmappedCodes))
        ? r.errorDetails.unmappedCodes
        : extractUnmappedCodesFromMessage(r.errorMessage);
      if (codes.length > 0) {
        actions.appendChild(makeOrderXmlActionBtn('Add Mapping', () => {
          // Switch to Settings → Order XML sub-tab.
          const settingsTab = document.querySelector('.tab[data-tab="settings"]');
          if (settingsTab) settingsTab.click();
          const orderXmlSubtab = document.querySelector('.settings-subtab[data-subtab="orderxml"]');
          if (orderXmlSubtab) orderXmlSubtab.click();
          // Seed draft rows for the unmapped codes.
          seedOrderXmlMappingDrafts(r.sourceFormat, codes);
          showToast(`Draft rows added for ${codes.length} unmapped product(s) — fill in Pixfizz codes and Save Settings`, 'info', 8000);
        }));
      }
    }

    // CUSTOMER_NOT_FOUND rows get a one-click jump to Settings → Order XML →
    // Customers with a draft row pre-filled for the unresolved RetailerDealerCode.
    if (r.errorCode === 'CUSTOMER_NOT_FOUND') {
      const code = r.errorDetails && r.errorDetails.retailerCode;
      if (code) {
        actions.appendChild(makeOrderXmlActionBtn('Add Customer', () => {
          const settingsTab = document.querySelector('.tab[data-tab="settings"]');
          if (settingsTab) settingsTab.click();
          const orderXmlSubtab = document.querySelector('.settings-subtab[data-subtab="orderxml"]');
          if (orderXmlSubtab) orderXmlSubtab.click();
          seedOrderXmlCustomerDraft(code);
          showToast(`Draft row added for Customer ID "${code}" — fill in Name + Email and Save Settings`, 'info', 8000);
        }));
      }
    }

    actions.appendChild(makeOrderXmlActionBtn('Retry', async () => {
      const res = await window.electronAPI.orderXmlRetryFailed(r.id);
      if (res && res.ok) {
        showToast(`Retry queued: ${r.filename}`, 'success');
        loadOrderXmlPanel();
      } else {
        showToast('Retry failed: ' + (res && res.error ? res.error : 'unknown'), 'error');
      }
    }));
  }

  if (r.hotFolderId) {
    const which = r.status === 'failed' ? 'failed' : 'processed';
    const label = r.status === 'failed' ? 'Failed Folder' : 'Processed Folder';
    actions.appendChild(makeOrderXmlActionBtn(label, async () => {
      const res = await window.electronAPI.orderXmlOpenFolder(r.hotFolderId, which);
      if (res && !res.ok) showToast('Open folder failed: ' + (res.error || 'unknown'), 'error');
    }));
  }

  return tr;
}

/**
 * Defensive fallback for older ingestion records that predate the
 * `errorDetails` field. Extracts the codes from the trailing
 * "...mapping: 1082252, 1082312" portion of the stored errorMessage.
 */
function extractUnmappedCodesFromMessage(msg) {
  if (typeof msg !== 'string') return [];
  const m = msg.match(/mapping:\s*(.+)$/i);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function makeOrderXmlActionBtn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-secondary btn-sm';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function formatOrderXmlTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // "May 8, 12:34:56" — short for the table column.
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

// Auto-refresh while the panel is visible. Stops when the user navigates away
// to avoid hammering the IPC layer for nothing.
function startOrderXmlAutoRefresh() {
  if (orderXmlState.refreshTimer) return;
  orderXmlState.refreshTimer = setInterval(loadOrderXmlPanel, 5000);
}
function stopOrderXmlAutoRefresh() {
  if (orderXmlState.refreshTimer) {
    clearInterval(orderXmlState.refreshTimer);
    orderXmlState.refreshTimer = null;
  }
}

// ── Wire toolbar (run once at module load; elements may not exist on
// renderer.js boot for users who haven't enabled Mode 4 yet, so guard each.) ─
(function wireOrderXmlPanel() {
  const filterBar = document.getElementById('orderXmlFilterBar');
  if (filterBar) {
    filterBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-orderxml-filter]');
      if (!btn) return;
      filterBar.querySelectorAll('.jobs-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      orderXmlState.filter = btn.dataset.orderxmlFilter;
      renderOrderXmlPanel();
    });
  }

  const hfFilter = document.getElementById('orderXmlHotFolderFilter');
  if (hfFilter) {
    hfFilter.addEventListener('change', () => {
      orderXmlState.hotFolderId = hfFilter.value;
      renderOrderXmlPanel();
    });
  }

  const search = document.getElementById('orderXmlSearch');
  if (search) {
    search.addEventListener('input', () => {
      orderXmlState.search = search.value;
      renderOrderXmlPanel();
    });
  }

  const refreshBtn = document.getElementById('orderXmlRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadOrderXmlPanel);

  const clearBtn = document.getElementById('orderXmlClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear all Order XML ingestion records?\n\nThis only clears the in-app history — files in the processed/ and failed/ folders are not touched.')) return;
      const res = await window.electronAPI.orderXmlClear();
      if (res && res.ok) {
        showToast('Ingestion records cleared', 'success');
        loadOrderXmlPanel();
      } else {
        showToast('Clear failed: ' + (res && res.error ? res.error : 'unknown'), 'error');
      }
    });
  }

  // Sortable column headers
  document.querySelectorAll('#orderXmlTable th[data-orderxml-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.orderxmlSort;
      if (orderXmlState.sort.col === col) {
        orderXmlState.sort.dir = orderXmlState.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        orderXmlState.sort = { col, dir: 'desc' };
      }
      renderOrderXmlPanel();
    });
  });
})();

// ═══════════════════════════════════════════════════════════════════════════
// Backup & Restore (Settings → Backup subtab + Restore modal)
//
// Plain DOM wiring — mirrors the conventions used by the rest of the file
// (id-based lookups, addEventListener, no component framework). All IPC
// calls return structured `{success/ok, error?}` objects so we never throw
// out of an event handler.
// ═══════════════════════════════════════════════════════════════════════════

const BACKUP_SECTION_LABELS = {
  config: 'Connection / FTP / Mode settings',
  routing: 'Routing',
  printControllers: 'Print Controllers',
  appPrefs: 'App Preferences',
  filmReviewPrefs: 'Film Review Preferences',
};

const BACKUP_REDACTED_LABELS = {
  orderhubApiKey:    'OrderHub API Key',
  ftpPassword:       'FTP Password',
  s3SecretAccessKey: 'S3 Secret Access Key',
  topazApiKey:       'Topaz API Key',
};

let backupRestoreState = {
  hostname: '',
  selectedFilePath: null,
  selectedEnvelope: null,
  // When the user clicks "Browse backups from other machines", widen the list.
  showAllHosts: false,
};

function fmtBackupTimestamp(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch { return iso; }
}

function fmtBackupSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderBackupLastStatus(config) {
  const el = document.getElementById('backupLastStatus');
  if (!el) return;
  el.classList.remove('ok', 'amber', 'red', 'error');
  if (config.backupLastError) {
    el.classList.add('error');
    el.textContent = `Failed — ${config.backupLastError}`;
    return;
  }
  if (!config.backupLastRunAt) {
    el.textContent = 'Never run on this PC.';
    return;
  }
  const last = new Date(config.backupLastRunAt);
  const ageMs = Date.now() - last.getTime();
  const hours = ageMs / (60 * 60 * 1000);
  const days = hours / 24;
  let tone;
  if (days > 7) tone = 'red';
  else if (hours > 48) tone = 'amber';
  else tone = 'ok';
  el.classList.add(tone);
  let suffix = '';
  if (tone === 'amber') suffix = ` — ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} ago`;
  if (tone === 'red')   suffix = ` — ${Math.round(days)} days ago`;
  el.textContent = `${fmtBackupTimestamp(config.backupLastRunAt)}  ✓ Success${suffix}`;
}

function renderBackupMachineIdentity(config) {
  const el = document.getElementById('backupMachineIdentity');
  if (!el) return;
  const hostname = (config._hostname || (config.createdBy && config.createdBy.hostname) || '');
  // The renderer doesn't have direct os.hostname() — we use the machineId as
  // the canonical identity. Hostname is shown via the running backup file
  // when the operator runs a backup. For now, show machineId + a hint.
  const mid = config._machineId || '';
  const shortId = mid ? mid.slice(0, 8) + '…' : '(not yet set — restart OHD)';
  const display = hostname ? `${hostname}  ·  id: ${shortId}` : `id: ${shortId}`;
  el.textContent = display;
  el.dataset.copyValue = mid || '';
}

function setBackupFolderStatus(state, message) {
  const el = document.getElementById('backupFolderStatus');
  if (!el) return;
  el.classList.remove('ok', 'error', 'pending', 'hidden');
  if (!state) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.classList.add(state);
  el.textContent = message || '';
}

async function validateBackupFolderField() {
  const el = document.getElementById('backupFolderPath');
  if (!el) return;
  const value = el.value.trim();
  if (!value) {
    setBackupFolderStatus(null);
    return;
  }
  setBackupFolderStatus('pending', 'Checking access to backup folder…');
  try {
    const result = await window.electronAPI.backupValidateFolder(value);
    if (result && result.ok) {
      setBackupFolderStatus('ok', 'Backup folder is writable.');
    } else {
      setBackupFolderStatus('error', (result && result.error) || 'Could not validate backup folder.');
    }
  } catch (err) {
    setBackupFolderStatus('error', err.message || String(err));
  }
}

async function refreshBackupStatusFromConfig() {
  try {
    const config = await window.electronAPI.getConfig();
    renderBackupLastStatus(config);
    renderBackupMachineIdentity(config);
  } catch (err) {
    console.error('[backup] refreshBackupStatusFromConfig failed', err);
  }
}

// ── Backup Now flow ───────────────────────────────────────────────────────

async function handleBackupNow() {
  const btn = document.getElementById('backupRunNowBtn');
  if (!btn) return;
  const folderEl = document.getElementById('backupFolderPath');
  if (folderEl && !folderEl.value.trim()) {
    showStatus('Configure a backup folder first.', 'error');
    return;
  }
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Backing up…';
  try {
    const result = await window.electronAPI.backupRunNow();
    if (result && result.success) {
      showStatus(`Backup written: ${result.filePath} (${fmtBackupSize(result.sizeBytes)})`, 'success');
    } else if (result && result.code === 'HOSTNAME_COLLISION') {
      openBackupCollisionModal(result.error || 'Hostname conflict on the backup share.');
    } else {
      showStatus(`Backup failed: ${(result && result.error) || 'unknown error'}`, 'error');
    }
  } catch (err) {
    showStatus(`Backup failed: ${err.message || String(err)}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
    await refreshBackupStatusFromConfig();
  }
}

// ── Collision modal ───────────────────────────────────────────────────────

function openBackupCollisionModal(message) {
  const modal = document.getElementById('backupCollisionModal');
  const msgEl = document.getElementById('backupCollisionMessage');
  if (!modal || !msgEl) return;
  msgEl.textContent = message;
  modal.classList.remove('hidden');
}

function closeBackupCollisionModal() {
  const modal = document.getElementById('backupCollisionModal');
  if (modal) modal.classList.add('hidden');
}

async function handleCollisionTakeover() {
  const ok = window.confirm(
    'Take over this folder?\n\n' +
    "This will DELETE every backup currently in this hostname's subfolder " +
    "on the share, then write a fresh one from this PC. Use this only when " +
    'you are certain the previous PC no longer needs those backups.\n\n' +
    'There is no undo.',
  );
  if (!ok) return;
  closeBackupCollisionModal();
  const btn = document.getElementById('backupRunNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Taking over…'; }
  try {
    const result = await window.electronAPI.backupRunNow({ takeOverFolder: true });
    if (result && result.success) {
      showStatus('Folder taken over and fresh backup written.', 'success');
    } else {
      showStatus(`Take-over failed: ${(result && result.error) || 'unknown error'}`, 'error');
    }
  } catch (err) {
    showStatus(`Take-over failed: ${err.message || String(err)}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Backup Now'; }
    await refreshBackupStatusFromConfig();
  }
}

async function handleCollisionPickOther() {
  closeBackupCollisionModal();
  const result = await window.electronAPI.backupChooseFolder();
  if (result && !result.canceled && result.path) {
    const el = document.getElementById('backupFolderPath');
    if (el) {
      el.value = result.path;
      await validateBackupFolderField();
    }
  }
}

// ── Restore modal ─────────────────────────────────────────────────────────

async function openBackupRestoreModal() {
  const modal = document.getElementById('backupRestoreModal');
  if (!modal) return;
  backupRestoreState = { hostname: '', selectedFilePath: null, selectedEnvelope: null, showAllHosts: false };
  modal.classList.remove('hidden');
  document.getElementById('backupRestoreList').classList.remove('hidden');
  document.getElementById('backupRestorePreview').classList.add('hidden');
  await refreshBackupRestoreList();
}

function closeBackupRestoreModal() {
  const modal = document.getElementById('backupRestoreModal');
  if (modal) modal.classList.add('hidden');
}

async function refreshBackupRestoreList() {
  const list = document.getElementById('backupRestoreListItems');
  const intro = document.getElementById('backupRestoreListIntro');
  const switchLink = document.getElementById('backupRestoreSwitchHostLink');
  if (!list) return;
  list.innerHTML = '<div class="backup-list-empty">Loading…</div>';
  try {
    const items = await window.electronAPI.backupList({
      allHosts: Boolean(backupRestoreState.showAllHosts),
    });
    if (!items || !items.length) {
      list.innerHTML = '<div class="backup-list-empty">No backups found in this folder.</div>';
      if (intro) {
        intro.textContent = backupRestoreState.showAllHosts
          ? 'No backups found in any host subfolder. Try Browse to file…'
          : "No backups for this PC's hostname yet.";
      }
      if (switchLink) switchLink.textContent = backupRestoreState.showAllHosts
        ? 'Show only this PC\'s backups'
        : 'Browse backups from other machines';
      return;
    }
    list.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'backup-list-row';
      const when = document.createElement('div');
      when.className = 'backup-list-when';
      when.textContent = fmtBackupTimestamp(item.createdAt);
      const meta = document.createElement('div');
      meta.className = 'backup-list-meta';
      const parts = [];
      if (item.hostname) parts.push(`host ${item.hostname}`);
      if (item.appVersion) parts.push(`OHD v${item.appVersion}`);
      if (item.sizeBytes) parts.push(fmtBackupSize(item.sizeBytes));
      if (item.customerDirectoryExcluded) parts.push('PII excluded');
      meta.textContent = parts.join(' · ');
      row.appendChild(when);
      row.appendChild(meta);
      row.addEventListener('click', () => selectBackupForPreview(item.path));
      list.appendChild(row);
    }
    if (intro) {
      intro.textContent = backupRestoreState.showAllHosts
        ? 'Showing backups from every PC that has written to this share. Pick a backup to preview.'
        : "Showing backups for this PC. Pick a backup to preview, or browse other machines below.";
    }
    if (switchLink) switchLink.textContent = backupRestoreState.showAllHosts
      ? 'Show only this PC\'s backups'
      : 'Browse backups from other machines';
  } catch (err) {
    list.innerHTML = `<div class="backup-list-empty">Could not list backups: ${err.message || err}</div>`;
  }
}

async function selectBackupForPreview(filePath) {
  try {
    const result = await window.electronAPI.backupRead(filePath);
    if (!result || !result.envelope) {
      showStatus(`Could not read backup: ${(result && result.error) || 'unknown'}`, 'error');
      return;
    }
    backupRestoreState.selectedFilePath = filePath;
    backupRestoreState.selectedEnvelope = result.envelope;
    renderBackupPreview(result.envelope, filePath);
  } catch (err) {
    showStatus(`Could not read backup: ${err.message || err}`, 'error');
  }
}

function renderBackupPreview(envelope, filePath) {
  const list = document.getElementById('backupRestoreList');
  const preview = document.getElementById('backupRestorePreview');
  const summary = document.getElementById('backupPreviewSummary');
  const redactedUl = document.getElementById('backupPreviewRedacted');
  const custWarn = document.getElementById('backupPreviewCustomerWarning');
  if (!preview || !summary) return;

  const host = envelope.createdBy?.hostname || '(unknown host)';
  const ver = envelope.appVersion || '?';
  const when = fmtBackupTimestamp(envelope.createdAt);
  const machineId = envelope.createdBy?.machineId || '';
  summary.innerHTML =
    `<strong>From:</strong> ${escapeHtml(host)}<br>` +
    `<strong>App version:</strong> ${escapeHtml(ver)}<br>` +
    `<strong>Created:</strong> ${escapeHtml(when)}<br>` +
    (machineId ? `<strong>Machine ID:</strong> ${escapeHtml(machineId)}<br>` : '') +
    `<strong>File:</strong> ${escapeHtml(filePath)}`;

  redactedUl.innerHTML = '';
  const redacted = Array.isArray(envelope.redactedKeys) ? envelope.redactedKeys : [];
  if (redacted.length === 0) {
    const li = document.createElement('li');
    li.textContent = '(none — but you should still verify credentials after restore)';
    redactedUl.appendChild(li);
  } else {
    for (const key of redacted) {
      const li = document.createElement('li');
      li.textContent = BACKUP_REDACTED_LABELS[key] || key;
      redactedUl.appendChild(li);
    }
  }

  if (envelope.customerDirectoryExcluded) {
    custWarn.classList.remove('hidden');
  } else {
    custWarn.classList.add('hidden');
  }

  list.classList.add('hidden');
  preview.classList.remove('hidden');
}

function backToBackupList() {
  document.getElementById('backupRestoreList').classList.remove('hidden');
  document.getElementById('backupRestorePreview').classList.add('hidden');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function handleBackupRestoreConfirm() {
  if (!backupRestoreState.selectedFilePath) return;
  const selections = {
    config:           document.getElementById('backupSel_config').checked,
    routing:          document.getElementById('backupSel_routing').checked,
    printControllers: document.getElementById('backupSel_printControllers').checked,
    appPrefs:         document.getElementById('backupSel_appPrefs').checked,
    filmReviewPrefs:  document.getElementById('backupSel_filmReviewPrefs').checked,
  };
  const confirmed = window.confirm(
    'Restore the selected backup?\n\n' +
    'This overwrites OHD\'s current configuration on this PC. ' +
    'OHD will restart after the restore.\n\n' +
    'Make sure you have your API keys and passwords ready — they are not in the backup.',
  );
  if (!confirmed) return;
  const btn = document.getElementById('backupPreviewConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
  try {
    const result = await window.electronAPI.backupRestore(
      backupRestoreState.selectedFilePath,
      selections,
    );
    if (result && result.success) {
      closeBackupRestoreModal();
      openBackupRelaunchModal(result);
    } else {
      showStatus(`Restore failed: ${(result && result.error) || 'unknown error'}`, 'error');
    }
  } catch (err) {
    showStatus(`Restore failed: ${err.message || String(err)}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Restore'; }
  }
}

async function handleBackupRestoreBrowseFile() {
  const pick = await window.electronAPI.backupChooseFile();
  if (pick && !pick.canceled && pick.path) {
    await selectBackupForPreview(pick.path);
  }
}

// ── Relaunch modal ────────────────────────────────────────────────────────

function openBackupRelaunchModal(result) {
  const modal = document.getElementById('backupRelaunchModal');
  if (!modal) return;
  const notes = document.getElementById('backupRelaunchNotes');
  const summary = document.getElementById('backupRelaunchSummary');
  if (summary) {
    const restored = (result.restoredSections || []).map((k) => BACKUP_SECTION_LABELS[k] || k);
    const skipped  = (result.skippedSections  || []).map((k) => BACKUP_SECTION_LABELS[k] || k);
    let txt = 'OHD needs to restart to apply the restored settings.';
    if (restored.length) txt += ` Restored: ${restored.join(', ')}.`;
    if (skipped.length)  txt += ` Skipped: ${skipped.join(', ')}.`;
    summary.textContent = txt;
  }
  if (notes) {
    const lines = Array.isArray(result.migrationNotes) ? result.migrationNotes : [];
    if (lines.length === 0) {
      notes.innerHTML = '';
    } else {
      notes.innerHTML = '<strong>Notes:</strong><ul style="margin:4px 0 0 18px;padding:0;">' +
        lines.map((n) => `<li>${escapeHtml(n)}</li>`).join('') + '</ul>';
    }
  }
  modal.classList.remove('hidden');
}

function closeBackupRelaunchModal() {
  const modal = document.getElementById('backupRelaunchModal');
  if (modal) modal.classList.add('hidden');
}

async function handleBackupRelaunchNow() {
  try {
    await window.electronAPI.backupRelaunch();
  } catch (err) {
    showStatus(`Could not relaunch: ${err.message || err}`, 'error');
  }
}

// ── Wire-up ───────────────────────────────────────────────────────────────

(function wireBackupSubtab() {
  // Folder field — validate on blur and on change.
  const folderEl = document.getElementById('backupFolderPath');
  if (folderEl) {
    folderEl.addEventListener('blur', validateBackupFolderField);
    folderEl.addEventListener('change', validateBackupFolderField);
  }

  const browseBtn = document.getElementById('backupFolderBrowseBtn');
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.backupChooseFolder();
        if (result && !result.canceled && result.path && folderEl) {
          folderEl.value = result.path;
          await validateBackupFolderField();
        }
      } catch (err) {
        showStatus(`Could not pick folder: ${err.message || err}`, 'error');
      }
    });
  }

  const runBtn = document.getElementById('backupRunNowBtn');
  if (runBtn) runBtn.addEventListener('click', handleBackupNow);

  const restoreBtn = document.getElementById('backupRestoreBtn');
  if (restoreBtn) restoreBtn.addEventListener('click', openBackupRestoreModal);

  // Restore modal
  const closeRestore = document.getElementById('backupRestoreCloseBtn');
  if (closeRestore) closeRestore.addEventListener('click', closeBackupRestoreModal);
  const backFromPreview = document.getElementById('backupPreviewBackBtn');
  if (backFromPreview) backFromPreview.addEventListener('click', backToBackupList);
  const confirmRestore = document.getElementById('backupPreviewConfirmBtn');
  if (confirmRestore) confirmRestore.addEventListener('click', handleBackupRestoreConfirm);
  const browseFileBtn = document.getElementById('backupRestoreBrowseFileBtn');
  if (browseFileBtn) browseFileBtn.addEventListener('click', handleBackupRestoreBrowseFile);
  const switchHost = document.getElementById('backupRestoreSwitchHostLink');
  if (switchHost) {
    switchHost.addEventListener('click', async (e) => {
      e.preventDefault();
      backupRestoreState.showAllHosts = !backupRestoreState.showAllHosts;
      await refreshBackupRestoreList();
    });
  }

  // Collision modal
  const colTake = document.getElementById('backupCollisionTakeoverBtn');
  if (colTake) colTake.addEventListener('click', handleCollisionTakeover);
  const colPick = document.getElementById('backupCollisionPickOtherBtn');
  if (colPick) colPick.addEventListener('click', handleCollisionPickOther);
  const colCancel = document.getElementById('backupCollisionCancelBtn');
  if (colCancel) colCancel.addEventListener('click', closeBackupCollisionModal);

  // Relaunch modal
  const relNow = document.getElementById('backupRelaunchNowBtn');
  if (relNow) relNow.addEventListener('click', handleBackupRelaunchNow);
  const relLater = document.getElementById('backupRelaunchLaterBtn');
  if (relLater) relLater.addEventListener('click', closeBackupRelaunchModal);

  // Machine identity click-to-copy
  const idEl = document.getElementById('backupMachineIdentity');
  if (idEl) {
    idEl.addEventListener('click', async () => {
      const val = idEl.dataset.copyValue || idEl.textContent;
      try {
        await navigator.clipboard.writeText(val);
        showStatus('Machine ID copied to clipboard.', 'success');
      } catch {
        // Fallback for browsers without clipboard permission.
        const range = document.createRange();
        range.selectNodeContents(idEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  }
})();
