// ══════════════════════════════════════
// DOM elements
// ══════════════════════════════════════
const form = document.getElementById('settingsForm');
const saveBtn = document.getElementById('saveBtn');
const testApiBtn = document.getElementById('testApiBtn');
const testFtpBtn = document.getElementById('testFtpBtn');
const selectDirBtn = document.getElementById('selectDirBtn');
const testS3Btn = document.getElementById('testS3Btn');
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

// ══════════════════════════════════════
// State
// ══════════════════════════════════════
let allJobs = [];
let currentSort = { field: 'created_at', direction: 'desc' };
let currentFilter = 'awaiting'; // 'all', 'awaiting', 'printed'
let cachedControllers = []; // For process mapping controller dropdowns

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

  // Load jobs
  loadJobs();

  // Render print controller cards
  renderPrintControllers(cachedControllers);
});

// ── Window controls ──
document.getElementById('minimiseBtn').addEventListener('click', () => window.electronAPI.minimiseWindow());
document.getElementById('closeBtn').addEventListener('click', () => window.electronAPI.closeWindow());

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
window.electronAPI.onJobsUpdated((data) => {
  if (data && data.jobs) {
    allJobs = data.jobs;
    renderJobTable(getFilteredJobs());
  }
});

// ══════════════════════════════════════
// JOBS: Loading & Rendering
// ══════════════════════════════════════

async function loadJobs() {
  try {
    const data = await window.electronAPI.getJobs();
    allJobs = data.jobs || [];
    renderJobTable(getFilteredJobs());
  } catch (error) {
    console.error('Error loading jobs:', error);
  }
}

refreshJobsBtn.addEventListener('click', async () => {
  refreshJobsBtn.disabled = true;
  refreshJobsBtn.textContent = 'Refreshing...';
  try {
    const data = await window.electronAPI.refreshJobs();
    allJobs = data.jobs || [];
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
    jobs = jobs.filter(j => j._status !== 'completed');
  } else if (currentFilter === 'printed') {
    jobs = jobs.filter(j => j._status === 'completed');
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

    // Status badge (uses _status for OHD-managed state, with DPOF overlay)
    let statusClass, statusLabel;
    if (job._dpofFailed) {
      statusClass = 'badge badge-dpof_failed';
      statusLabel = 'Print Failed';
    } else if (job._dpofAccepted) {
      statusClass = 'badge badge-dpof_accepted';
      statusLabel = 'Print Accepted';
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
    let actionHtml = '';
    if (job._status === 'completed') {
      actionHtml = '<button class="btn-action btn-printed" disabled>Printed</button>';
    } else if (job._status === 'in_production') {
      actionHtml = `<button class="btn-action btn-mark-printed" data-job-id="${escapeHtml(String(job.id))}">Mark as Printed</button>`;
    } else if (job._status === 'received') {
      actionHtml = `<button class="btn-action btn-send-print" data-job-id="${escapeHtml(String(job.id))}">Send to Print</button>`;
    } else {
      actionHtml = '<span style="color:#a0aec0;font-size:11px">--</span>';
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
      <td><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
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
      <td>${actionHtml}</td>
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
    dpiPoorAllowAutoSubmit: document.getElementById('dpiPoorAllowAutoSubmit').checked
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
