// ══════════════════════════════════════
// DOM elements
// ══════════════════════════════════════
const form = document.getElementById('settingsForm');
const saveBtn = document.getElementById('saveBtn');
const testApiBtn = document.getElementById('testApiBtn');
const testFtpBtn = document.getElementById('testFtpBtn');
const selectDirBtn = document.getElementById('selectDirBtn');
const testS3Btn = document.getElementById('testS3Btn');
const testReplicateBtn = document.getElementById('testReplicateBtn');
const selectFilmScansWatchBtn = document.getElementById('selectFilmScansWatchBtn');
const selectFilmScansStorageBtn = document.getElementById('selectFilmScansStorageBtn');
const selectFileUploadsWatchBtn = document.getElementById('selectFileUploadsWatchBtn');
const selectFileUploadsStorageBtn = document.getElementById('selectFileUploadsStorageBtn');
const selectProcessFolderBtn = document.getElementById('selectProcessFolderBtn');
const processMappingsList = document.getElementById('processMappingsList');
const addProcessMappingBtn = document.getElementById('addProcessMappingBtn');
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

// DPOF output-status cache: jobId (string) → { prefix, folderName, folderPath }
// Populated after each table render via async folder scan.
// Prefix meanings: p=Import Error, o=Awaiting Import, q=Failed Import, e=Printed
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
// Tab switching (main tabs)
// ══════════════════════════════════════
document.querySelectorAll('.tab-bar .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab-bar .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
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
// Startup
// ══════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
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
    renderJobTable(getFilteredJobs());
  }
});

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

// Job filter buttons (All / Awaiting Production / Printed)
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
    case 'completed': return 'Printed';
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
    // Review button shown alongside any downloaded job (received / in_production / completed).
    const reviewBtn = `<button class="btn-action btn-review" data-sidecar-job-id="${escapeHtml(sidecarJobId)}" data-job-path="${escapeHtml(jobFolderPath)}">Review</button>`;

    let actionHtml = '';
    if (currentFilter === 'dismissed') {
      actionHtml = `<div class="actions-cell-wrap"><button class="btn-action btn-restore" data-job-id="${escapeHtml(String(job.id))}">Restore</button></div>`;
    } else if (outputStatus) {
      // DPOF prefix-driven action buttons
      actionHtml = getDpofOutputActionHtml(reviewBtn, String(job.id), outputStatus.prefix);
    } else if (job._status === 'completed') {
      actionHtml = `${reviewBtn}<button class="btn-action btn-printed" disabled>Printed</button>`;
    } else if (job._status === 'in_production') {
      actionHtml = `${reviewBtn}<button class="btn-action btn-mark-printed" data-job-id="${escapeHtml(String(job.id))}">Mark as Printed</button>`;
    } else if (job._status === 'received') {
      const route = jobRouteCache.get(String(job.id));
      if (route && route.type === 'unrouted') {
        if (route.reason === 'no-channel') {
          // Controller is assigned but no channel mapping yet — show Assign button
          actionHtml = `${reviewBtn}<button class="btn-action btn-assign-channel" data-job-id="${escapeHtml(String(job.id))}">Assign</button>`;
        } else {
          // No controller assigned to this process at all — inline guidance
          actionHtml = `${reviewBtn}<span class="route-unassigned-msg">No controller — configure in Settings → Routing</span>`;
        }
      } else {
        // Routed (controller / process-folder) or not yet resolved — normal Send to Print
        actionHtml = `${reviewBtn}<button class="btn-action btn-send-print" data-job-id="${escapeHtml(String(job.id))}">Send to Print</button>`;
      }
    } else if (job._status === 'pending') {
      const route = jobRouteCache.get(String(job.id));
      if (route && route.type === 'unrouted') {
        if (route.reason === 'no-channel') {
          // Controller assigned but no channel mapping yet — show Assign
          actionHtml = `${reviewBtn}<button class="btn-action btn-assign-channel" data-job-id="${escapeHtml(String(job.id))}">Assign</button>`;
        } else {
          // No controller assigned to this process at all
          actionHtml = `${reviewBtn}<span class="route-unassigned-msg">No controller — configure in Settings → Routing</span>`;
        }
      } else if (route && route.type !== 'unrouted') {
        // Valid route — show Review + Send to Print (same as received)
        actionHtml = `${reviewBtn}<button class="btn-action btn-send-print" data-job-id="${escapeHtml(String(job.id))}">Send to Print</button>`;
      } else {
        actionHtml = '<span style="color:#a0aec0;font-size:11px">--</span>';
      }
    } else {
      actionHtml = '<span style="color:#a0aec0;font-size:11px">--</span>';
    }

    // Wrap with dismiss button for non-dismissed tabs
    if (currentFilter !== 'dismissed') {
      actionHtml = `<div class="actions-cell-wrap">${actionHtml}<button class="btn-dismiss" data-job-id="${escapeHtml(String(job.id))}" title="Hide this job from the list">Dismiss</button></div>`;
    }

    const jobNo = formatJobNo(job);

    // Flags: rush + order notes icons
    let flagsHtml = '';
    if (job.is_rush) {
      flagsHtml += '<span class="flag-icon flag-rush" title="Rush Order">&#9889;</span>';
    }
    if (job.order_notes) {
      flagsHtml += `<span class="flag-icon flag-notes" title="${escapeHtml(job.order_notes)}">&#128196;</span>`;
    }

    // DPI indicator cell
    let dpiHtml = '<span class="dpi-badge dpi-unknown" title="DPI not checked">–</span>';
    if (job._dpiStatus) {
      const dpiLabels = { excellent: '✅', good: '✅', warning: '⚠️', poor: '❌' };
      const dpiTitles = {
        excellent: `Excellent DPI (${job._dpiMin || ''}+)`,
        good: `Good DPI`,
        warning: `Warning: low DPI`,
        poor: `Poor DPI — manual approval required`
      };
      const icon = dpiLabels[job._dpiStatus] || '–';
      const title = dpiTitles[job._dpiStatus] || job._dpiStatus;
      dpiHtml = `<span class="dpi-badge dpi-${escapeHtml(job._dpiStatus)}" title="${escapeHtml(title)}">${icon}</span>`;
    }

    tr.innerHTML = `
      <td class="job-status-cell"><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td>${previewHtml}</td>
      <td>${escapeHtml(job.process || '--')}</td>
      <td>${escapeHtml(job.category || '--')}</td>
      <td class="flags-cell dpi-cell">${dpiHtml}</td>
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

  // Attach Send to Print handlers (with DPI validation intercept)
  document.querySelectorAll('.btn-send-print[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;

      try {
        // Step 1: DPI validation
        btn.textContent = 'Checking DPI...';
        const dpiResult = await window.electronAPI.validateJobDpi(jobId);

        if (dpiResult.success && !dpiResult.disabled) {
          // Update the DPI badge in the row immediately
          const dpiCell = btn.closest('tr') && btn.closest('tr').querySelector('.dpi-cell');
          if (dpiCell && dpiResult.overallStatus) {
            const icons = { excellent: '✅', good: '✅', warning: '⚠️', poor: '❌' };
            dpiCell.innerHTML = `<span class="dpi-badge dpi-${escapeHtml(dpiResult.overallStatus)}" title="${escapeHtml(dpiResult.overallStatus)}">${icons[dpiResult.overallStatus] || '–'}</span>`;
          }

          if (!dpiResult.canAutoSubmit) {
            // Show the DPI warning modal — user must confirm
            btn.textContent = 'Send to Print';
            const proceed = await showDpiModal(dpiResult);
            if (!proceed) {
              btn.disabled = false;
              return;
            }
            // User approved — mark as manually approved
            await window.electronAPI.approveDpiJob(jobId);
            btn.disabled = true;
          }
        }

        // Step 2: Actually send to print
        btn.textContent = 'Sending...';
        const result = await window.electronAPI.sendToPrint(jobId);

        if (result.success) {
          btn.textContent = 'Sent to Printer';
          btn.className = 'btn-action btn-sent';
          showToast('Job sent to printer', 'success');
          loadJobs();
        } else {
          btn.disabled = false;
          btn.textContent = 'Send to Print';
          showToast('Send to Print failed: ' + (result.error || 'Unknown error'), 'error', 10000);
        }
      } catch (error) {
        btn.disabled = false;
        btn.textContent = 'Send to Print';
        showToast('Send to Print error: ' + error.message, 'error', 10000);
      }
    });
  });

  // Attach Mark as Printed handlers
  document.querySelectorAll('.btn-mark-printed[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;
      btn.textContent = 'Marking...';

      try {
        const result = await window.electronAPI.markCompleted(jobId);

        if (result.success) {
          btn.textContent = 'Printed';
          btn.className = 'btn-action btn-printed';
          loadJobs();
        } else {
          btn.disabled = false;
          btn.textContent = 'Mark as Printed';
          showStatus('Mark as Printed failed: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        btn.disabled = false;
        btn.textContent = 'Mark as Printed';
        showStatus('Mark as Printed error: ' + error.message, 'error');
      }
    });
  });

  // Attach Review panel handlers — dispatch CustomEvent to open the React drawer.
  document.querySelectorAll('.btn-review').forEach(btn => {
    btn.addEventListener('click', () => {
      const jobId   = btn.dataset.sidecarJobId;
      const jobPath = btn.dataset.jobPath;
      window.dispatchEvent(new CustomEvent('ohd:open-job-review', {
        detail: { jobId, jobPath },
      }));
    });
  });

  // ── DPOF output-status action handlers ──

  // "Mark as Printed" (e / Imported status) — OHD-internal flag only, no disk changes
  document.querySelectorAll('.btn-mark-printed-dpof[data-job-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.jobId;
      btn.disabled = true;
      btn.textContent = 'Marking...';
      try {
        const result = await window.electronAPI.markPrinted(jobId);
        if (!result.success) {
          btn.disabled = false;
          btn.textContent = 'Mark as Printed';
          showToast('Mark as Printed failed: ' + (result.error || 'Unknown error'), 'error', 8000);
          return;
        }
        // Update cache to virtual 'printed' prefix and re-render this row in-place
        const current = outputStatusCache.get(jobId) || {};
        const printedStatus = { ...current, prefix: 'printed' };
        outputStatusCache.set(jobId, printedStatus);
        const job = allJobs.find(j => String(j.id) === String(jobId));
        updateJobRowStatus(jobId, printedStatus, job || null);
        showToast('Job marked as printed', 'success');
      } catch (error) {
        btn.disabled = false;
        btn.textContent = 'Mark as Printed';
        showToast('Mark as Printed error: ' + error.message, 'error', 8000);
      }
    });
  });

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
    printed: { statusClass: 'badge badge-printed',         statusLabel: 'Printed' },
  };
  return map[prefix] || { statusClass: 'badge badge-unknown', statusLabel: 'Unknown' };
}

/**
 * Build the action cell HTML for a DPOF job based on its output folder prefix.
 * Prefix → action mapping:
 *   p (Import Error)    → Retry
 *   o (Awaiting Import) → no action (waiting for controller)
 *   q (Failed Import)   → Resend
 *   e (Imported)        → Mark as Printed
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
      return `${reviewBtnHtml}<button class="btn-action btn-mark-printed-dpof" data-job-id="${id}">Mark as Printed</button>`;
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
 * The operator enters a channel number and clicks Save.
 *
 * @param {object} job   - Job object from allJobs
 * @param {object} route - Route from jobRouteCache: { type:'unrouted', reason:'no-channel', controller }
 */
function openAssignModal(job, route) {
  const modal = document.getElementById('assignChannelModal');
  if (!modal) return;

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

  // Clear channel number input
  const channelInput = document.getElementById('assignChannelNumber');
  channelInput.value = '';

  // Store context on the modal element for the save handler
  modal.dataset.jobId = String(job.id);
  modal.dataset.controllerId = route.controller ? route.controller.id : '';
  modal.dataset.productCode  = job.product_code || '';
  // Serialise job options for save handler (JSON)
  modal.dataset.jobOptions   = JSON.stringify(job.options || []);

  modal.classList.remove('hidden');
  channelInput.focus();
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
    const channelInput  = document.getElementById('assignChannelNumber');
    const channelNumber = parseInt(channelInput.value, 10);

    if (!channelNumber || channelNumber < 1) {
      channelInput.focus();
      channelInput.setCustomValidity('Enter a valid channel number.');
      channelInput.reportValidity();
      return;
    }
    channelInput.setCustomValidity('');

    const controllerId = modal.dataset.controllerId;
    const productCode  = modal.dataset.productCode;
    const jobId        = modal.dataset.jobId;
    const jobOptions   = JSON.parse(modal.dataset.jobOptions || '[]');

    if (!controllerId) {
      showToast('No controller found — check Routing settings.', 'error');
      return;
    }

    saveBtn.disabled   = true;
    saveBtn.textContent = 'Saving...';

    try {
      const result = await window.electronAPI.saveChannelMapping({
        id:            crypto.randomUUID(),
        controllerId,
        productCode,
        options:       jobOptions,   // Array<{name,value}> — match this job's options
        channelNumber,
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
    const reviewBtn = `<button class="btn-action btn-review" data-sidecar-job-id="${escapeHtml(sidecarJobId)}" data-job-path="${escapeHtml(jobFolderPath)}">Review</button>`;
    actionCell.innerHTML = getDpofOutputActionHtml(reviewBtn, jobId, status.prefix);

    // Re-attach listeners for the new buttons
    const markBtn = actionCell.querySelector('.btn-mark-printed-dpof');
    if (markBtn) markBtn.addEventListener('click', async () => {
      markBtn.disabled = true; markBtn.textContent = 'Marking...';
      const r = await window.electronAPI.markPrinted(jobId);
      if (r.success) {
        const current = outputStatusCache.get(jobId) || {};
        const printedStatus = { ...current, prefix: 'printed' };
        outputStatusCache.set(jobId, printedStatus);
        updateJobRowStatus(jobId, printedStatus, allJobs.find(j => String(j.id) === String(jobId)) || null);
        showToast('Job marked as printed', 'success');
      } else {
        markBtn.disabled = false; markBtn.textContent = 'Mark as Printed';
        showToast('Failed: ' + r.error, 'error', 8000);
      }
    });
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
        detail: { jobId: sidecarJobId, jobPath: jobFolderPath }
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

  // Process folder mappings
  renderProcessMappings(config.processFolderMappings || {});

  // DPI Validation
  document.getElementById('dpiValidationEnabled').checked = config.dpiValidationEnabled !== false;
  document.getElementById('dpiExcellentThreshold').value = config.dpiExcellentThreshold || 300;
  document.getElementById('dpiWarningThreshold').value = config.dpiWarningThreshold || 275;
  document.getElementById('dpiWarningAllowAutoSubmit').checked = config.dpiWarningAllowAutoSubmit !== false;
  document.getElementById('dpiPoorThreshold').value = config.dpiPoorThreshold || 200;
  document.getElementById('dpiPoorAllowAutoSubmit').checked = config.dpiPoorAllowAutoSubmit || false;
  toggleDpiValidationFields();

  // AI Enhancement
  document.getElementById('replicateApiKey').value = config.replicateApiKey || '';
  document.getElementById('enhancementDefaultModel').value = config.enhancementDefaultModel || 'Standard V2';
  document.getElementById('enhancementFaceEnhancement').checked = config.enhancementFaceEnhancement || false;
  document.getElementById('enhancementAutoEnhance').checked = config.enhancementAutoEnhance || false;

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
    processFolderMappings: collectProcessMappings(),
    // DPI Validation
    dpiValidationEnabled: document.getElementById('dpiValidationEnabled').checked,
    dpiExcellentThreshold: parseInt(document.getElementById('dpiExcellentThreshold').value, 10) || 300,
    dpiWarningThreshold: parseInt(document.getElementById('dpiWarningThreshold').value, 10) || 275,
    dpiWarningAllowAutoSubmit: document.getElementById('dpiWarningAllowAutoSubmit').checked,
    dpiPoorThreshold: parseInt(document.getElementById('dpiPoorThreshold').value, 10) || 200,
    dpiPoorAllowAutoSubmit: document.getElementById('dpiPoorAllowAutoSubmit').checked,
    // AI Enhancement
    replicateApiKey: document.getElementById('replicateApiKey').value,
    enhancementDefaultModel: document.getElementById('enhancementDefaultModel').value,
    enhancementFaceEnhancement: document.getElementById('enhancementFaceEnhancement').checked,
    enhancementAutoEnhance: document.getElementById('enhancementAutoEnhance').checked,
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

// ══════════════════════════════════════
// DPI VALIDATION MODAL
// ══════════════════════════════════════

/**
 * Show the DPI warning modal.
 * Returns a Promise<boolean> — true = "Send Anyway", false = "Cancel".
 */
function showDpiModal(dpiResult) {
  return new Promise((resolve) => {
    const modal = document.getElementById('dpiModal');
    const title = document.getElementById('dpiModalTitle');
    const summary = document.getElementById('dpiModalSummary');
    const tbody = document.getElementById('dpiModalTableBody');
    const cancelBtn = document.getElementById('dpiModalCancel');
    const sendBtn = document.getElementById('dpiModalSendAnyway');
    const icon = document.getElementById('dpiModalIcon');

    // Set title and summary based on overall status
    const isPoor = dpiResult.overallStatus === 'poor';
    icon.textContent = isPoor ? '❌' : '⚠️';
    title.textContent = isPoor ? 'Poor Image Quality Detected' : 'Low DPI Warning';
    summary.textContent = isPoor
      ? 'One or more images have poor resolution and may print with visible pixelation. Manual approval is required to proceed.'
      : 'One or more images are below the recommended DPI. You can still send this job, but print quality may be reduced.';

    sendBtn.textContent = isPoor ? 'Approve & Send' : 'Send Anyway';
    sendBtn.className = isPoor ? 'btn-danger' : 'btn-warning';

    // Build table
    tbody.innerHTML = '';
    const images = dpiResult.images || [];
    for (const img of images) {
      const statusEmoji = { excellent: '✅', good: '✅', warning: '⚠️', poor: '❌' };
      const tr = document.createElement('tr');
      tr.className = `dpi-row-${img.status || 'unknown'}`;
      tr.innerHTML = `
        <td class="dpi-filename">${escapeHtml(img.filename ? img.filename.split(/[\\/]/).pop() : '--')}</td>
        <td>${img.imageWidth && img.imageHeight ? `${img.imageWidth}×${img.imageHeight}` : '--'}</td>
        <td>${escapeHtml(img.printSize || '--')}</td>
        <td class="dpi-value">${img.actualDPI !== null && img.actualDPI !== undefined ? img.actualDPI : '--'}</td>
        <td>${statusEmoji[img.status] || '–'} ${escapeHtml(img.status || '--')}</td>
        <td class="dpi-recommendation">${escapeHtml(img.recommendation || '')}</td>
      `;
      tbody.appendChild(tr);
    }

    // Show modal
    modal.classList.remove('hidden');

    // Wire buttons (one-time handlers to avoid stacking)
    function cleanup() {
      modal.classList.add('hidden');
      cancelBtn.removeEventListener('click', onCancel);
      sendBtn.removeEventListener('click', onSend);
      modal.removeEventListener('click', onOverlayClick);
    }

    function onCancel() { cleanup(); resolve(false); }
    function onSend()   { cleanup(); resolve(true);  }
    function onOverlayClick(e) {
      if (e.target === modal) { cleanup(); resolve(false); }
    }

    cancelBtn.addEventListener('click', onCancel);
    sendBtn.addEventListener('click', onSend);
    modal.addEventListener('click', onOverlayClick);
  });
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
    showStatus('Settings saved successfully!', 'success');
  } catch (error) {
    showStatus('Error saving settings: ' + error.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  }
});

// ══════════════════════════════════════
// SETTINGS: DPI Validation toggle
// ══════════════════════════════════════

function toggleDpiValidationFields() {
  const enabled = document.getElementById('dpiValidationEnabled').checked;
  const fields = document.getElementById('dpiValidationFields');
  if (fields) fields.style.display = enabled ? '' : 'none';
}

document.getElementById('dpiValidationEnabled').addEventListener('change', toggleDpiValidationFields);

// ══════════════════════════════════════
// SETTINGS: Process folder mappings
// ══════════════════════════════════════

function renderProcessMappings(mappings) {
  processMappingsList.innerHTML = '';
  for (const [processName, value] of Object.entries(mappings)) {
    // Backwards compatible: string → { folderPath }
    const mapping = typeof value === 'string' ? { folderPath: value } : value;
    addProcessMappingRow(processName, mapping.folderPath || '', mapping.controllerId || '');
  }
}

function addProcessMappingRow(processName = '', folderPath = '', controllerId = '') {
  const row = document.createElement('div');
  row.className = 'process-mapping-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'mapping-process-name';
  nameInput.placeholder = 'Process name';
  nameInput.value = processName;

  // Controller dropdown
  const controllerSelect = document.createElement('select');
  controllerSelect.className = 'mapping-controller-select';

  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = 'File Copy';
  controllerSelect.appendChild(noneOption);

  for (const ctrl of cachedControllers) {
    const opt = document.createElement('option');
    opt.value = ctrl.id;
    opt.textContent = ctrl.name;
    if (ctrl.id === controllerId) opt.selected = true;
    controllerSelect.appendChild(opt);
  }

  const folderInput = document.createElement('input');
  folderInput.type = 'text';
  folderInput.className = 'mapping-folder-path';
  folderInput.placeholder = 'Select folder...';
  folderInput.value = folderPath;
  folderInput.readOnly = true;

  const browseBtn = document.createElement('button');
  browseBtn.type = 'button';
  browseBtn.className = 'btn-browse';
  browseBtn.textContent = 'Browse...';
  browseBtn.addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.selectDirectory();
      if (result) {
        folderInput.value = result;
      }
    } catch (error) {
      showStatus('Error selecting directory: ' + error.message, 'error');
    }
  });

  // When a controller is selected, auto-fill its hot folder and disable browse
  function updateControllerState() {
    const selectedId = controllerSelect.value;
    if (selectedId) {
      const ctrl = cachedControllers.find(c => c.id === selectedId);
      if (ctrl) {
        folderInput.value = ctrl.hotFolderPath || '';
        folderInput.placeholder = 'Controller hot folder';
      }
      browseBtn.style.display = 'none';
    } else {
      if (!controllerId) folderInput.value = '';
      folderInput.placeholder = 'Select folder...';
      browseBtn.style.display = '';
    }
  }

  controllerSelect.addEventListener('change', updateControllerState);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-mapping';
  removeBtn.textContent = '\u00D7';
  removeBtn.title = 'Remove mapping';
  removeBtn.addEventListener('click', () => {
    row.remove();
  });

  row.appendChild(nameInput);
  row.appendChild(controllerSelect);
  row.appendChild(folderInput);
  row.appendChild(browseBtn);
  row.appendChild(removeBtn);
  processMappingsList.appendChild(row);

  // Set initial state
  updateControllerState();
}

function collectProcessMappings() {
  const mappings = {};
  const rows = processMappingsList.querySelectorAll('.process-mapping-row');
  for (const row of rows) {
    const name = row.querySelector('.mapping-process-name').value.trim();
    const folder = row.querySelector('.mapping-folder-path').value.trim();
    const ctrlId = row.querySelector('.mapping-controller-select').value;
    if (name && (folder || ctrlId)) {
      const entry = { folderPath: folder };
      if (ctrlId) entry.controllerId = ctrlId;
      mappings[name] = entry;
    }
  }
  return mappings;
}

addProcessMappingBtn.addEventListener('click', () => {
  addProcessMappingRow();
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

// Show/Hide toggle for Replicate API key
document.getElementById('replicateApiKeyToggle').addEventListener('click', () => {
  const input = document.getElementById('replicateApiKey');
  const btn   = document.getElementById('replicateApiKeyToggle');
  if (input.type === 'password') {
    input.type    = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type    = 'password';
    btn.textContent = 'Show';
  }
});

// Test Replicate API Key
testReplicateBtn.addEventListener('click', async () => {
  const apiKey = document.getElementById('replicateApiKey').value.trim();

  if (!apiKey) {
    showTestStatus('replicateTestStatus', 'Please enter an API key first', 'error');
    return;
  }

  try {
    testReplicateBtn.disabled    = true;
    testReplicateBtn.textContent = 'Testing...';

    const result = await window.electronAPI.enhancementTest({ apiKey });

    if (result.valid) {
      showTestStatus('replicateTestStatus', '✓ API key is valid', 'success');
    } else {
      showTestStatus('replicateTestStatus', 'Invalid: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    showTestStatus('replicateTestStatus', 'Error: ' + error.message, 'error');
  } finally {
    testReplicateBtn.disabled    = false;
    testReplicateBtn.textContent = 'Test API Key';
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
const activityRefreshBtn = document.getElementById('activityRefreshBtn');
const activityCopyBtn = document.getElementById('activityCopyBtn');
const activityExportBtn = document.getElementById('activityExportBtn');
const activityStatusBar = document.getElementById('activityStatusBar');

let activityLogsPath = '';
let activityLoaded = false;

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
    const entries = data.entries || [];
    const totalLines = data.totalLines || 0;

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
    const filterLabel = level === 'all' ? '' : ` (filtered: ${level})`;
    const rawInfo = data.rawLineCount ? ` (${data.rawLineCount} raw lines)` : '';
    activityStatusBar.textContent = `Showing ${entries.length} of ${totalLines} entries${rawInfo}${filterLabel} \u2014 ${activityLogsPath}`;
  } catch (error) {
    console.error('Error loading activity log:', error);
    activityStatusBar.textContent = 'Error loading log: ' + error.message;
  }
}

// Auto-load when Activity Log tab is clicked
document.querySelectorAll('.tab-bar .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'activity') {
      loadActivityLog();
    }
  });
});

// Level filter
activityLevelFilter.addEventListener('change', () => {
  loadActivityLog();
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
  switch ((type || 'dpof').toLowerCase()) {
    case 'dpof':        return 'Epson / Noritsu (DPOF)';
    case 'folder_copy': return 'Folder Copy';
    case 'pdf_copy':    return 'PDF Copy';
    case 'darkroompro': return 'Darkroom Pro';
    default:            return (type || 'dpof').toUpperCase();
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
      ${ctrl.type === 'darkroompro' && ctrl.processedFolderName ? `<div><span class="routing-card-meta">Processed folder:</span> ${escapeHtml(ctrl.processedFolderName)}</div>` : ''}
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

function updateOcTypeFields() {
  const type = document.getElementById('ocType').value;
  document.getElementById('ocProcessedFolderGroup').style.display = type === 'darkroompro'                     ? '' : 'none';
  document.getElementById('ocBannerSheetGroup').style.display     = (type === 'dpof' || type === 'pdf_copy') ? '' : 'none';
  document.getElementById('ocPipelineGroup').style.display        = type === 'pdf_copy'                       ? '' : 'none';
}

function openOrderControllerModal(ctrl = null) {
  const modal = document.getElementById('orderControllerModal');
  document.getElementById('ocModalTitle').textContent = ctrl ? 'Edit Controller' : 'Add Controller';
  document.getElementById('ocName').value       = ctrl ? ctrl.name       : '';
  document.getElementById('ocType').value       = ctrl ? ctrl.type       : 'dpof';
  document.getElementById('ocOutputPath').value = ctrl ? (ctrl.outputPath || '') : '';
  document.getElementById('ocProcessedFolderName').value = ctrl ? (ctrl.processedFolderName || '') : '';
  document.getElementById('ocAutoPrint').checked   = ctrl ? !!ctrl.autoprint   : false;
  document.getElementById('ocBannerSheet').checked = ctrl ? !!ctrl.bannerSheet : false;
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
    autoprint: document.getElementById('ocAutoPrint').checked,
  };
  if (type === 'dpof' || type === 'pdf_copy') {
    controller.bannerSheet = document.getElementById('ocBannerSheet').checked;
  }
  if (type === 'pdf_copy' && pipelineSteps.length > 0) {
    controller.pdfPipeline = { steps: JSON.parse(JSON.stringify(pipelineSteps)) };
  }
  if (type === 'darkroompro') {
    controller.processedFolderName = document.getElementById('ocProcessedFolderName').value.trim();
  }
  try {
    await window.electronAPI.saveOrderController(controller);
    modal.classList.add('hidden');
    await loadRoutingSection();
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
      } catch (err) {
        showToast('Error saving process mapping: ' + err.message, 'error');
      }
    });

    row.appendChild(label);
    row.appendChild(arrow);
    row.appendChild(select);
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
      infoDiv.innerHTML =
        `<span class="channel-mapping-product">${escapeHtml(mapping.productCode)}</span>` +
        (optionStr ? `<span class="channel-mapping-options">${escapeHtml(optionStr)}</span>` : '') +
        `<span class="channel-mapping-channel">→ Ch ${mapping.channelNumber}</span>` +
        (mapping.printSizeCode ? `<span class="channel-mapping-options">${escapeHtml(mapping.printSizeCode)}</span>` : '');

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
    if (c.type === 'darkroompro') continue; // Darkroom Pro uses its own mapping system
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    ctrlSel.appendChild(opt);
  }
  ctrlSel.value = mapping ? mapping.controllerId : '';

  document.getElementById('cmProductCode').value    = mapping ? mapping.productCode   : '';
  document.getElementById('cmChannelNumber').value  = mapping ? mapping.channelNumber : '';
  document.getElementById('cmPrintSizeCode').value  = mapping ? (mapping.printSizeCode || '') : '';

  const optsList = document.getElementById('cmOptionsList');
  optsList.innerHTML = '';
  for (const opt of (mapping ? (mapping.options || []) : [])) {
    addChannelMappingOptionRow(optsList, opt.name, opt.value);
  }

  modal.dataset.editingId = mapping ? mapping.id : '';
  modal.classList.remove('hidden');
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

  if (!controllerId)                         { alert('Please select a controller.');                  return; }
  if (!productCode)                          { alert('Product code is required.');                    return; }
  if (isNaN(channelNumber) || channelNumber < 1) { alert('Channel number must be a positive integer.'); return; }

  const options = [];
  document.querySelectorAll('#cmOptionsList .mapping-row').forEach(r => {
    const name  = r.querySelector('.cm-opt-name').value.trim();
    const value = r.querySelector('.cm-opt-value').value.trim();
    if (name && value) options.push({ name, value });
  });

  const editingId = modal.dataset.editingId;
  try {
    await window.electronAPI.saveChannelMapping({
      id: editingId || crypto.randomUUID(),
      controllerId,
      productCode,
      options,
      channelNumber,
      printSizeCode: printSizeCode || '',
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
