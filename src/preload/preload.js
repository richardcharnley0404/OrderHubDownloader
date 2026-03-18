const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Configuration
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // Directory picker
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  selectCsvFile:   () => ipcRenderer.invoke('dialog:selectCsvFile'),
  selectPdfFile:   () => ipcRenderer.invoke('dialog:selectPdfFile'),
  exportCsv: (defaultName, content) => ipcRenderer.invoke('dialog:exportCsv', { defaultName, content }),

  // Connection testing
  testFtpConnection: (credentials) => ipcRenderer.invoke('ftp:testConnection', credentials),
  testApiConnection: (key) => ipcRenderer.invoke('api:testConnection', key),

  // FTP scan and download
  scanAndDownloadFtp: () => ipcRenderer.invoke('ftp:scanAndDownload'),
  onDownloadProgress: (callback) => ipcRenderer.on('ftp:downloadProgress', (event, data) => callback(data)),

  // Polling control
  getPollingStatus: () => ipcRenderer.invoke('polling:getStatus'),
  togglePolling: () => ipcRenderer.invoke('polling:toggle'),

  // S3 operations
  testS3Connection: (s3Config) =>
    ipcRenderer.invoke('s3:testConnection', s3Config),

  // File Uploads status
  getFileUploadsStatus: () => ipcRenderer.invoke('fileUploads:getStatus'),

  // Status updates from main process
  onStatusUpdate: (callback) => ipcRenderer.on('status:update', (event, data) => callback(data)),

  // Job management
  getJobs: () => ipcRenderer.invoke('jobs:getAll'),
  refreshJobs: () => ipcRenderer.invoke('jobs:refresh'),
  sendToPrint: (jobId) => ipcRenderer.invoke('jobs:sendToPrint', jobId),
  markCompleted: (jobId) => ipcRenderer.invoke('jobs:markCompleted', jobId),
  onJobsUpdated: (callback) => ipcRenderer.on('jobs:updated', (event, data) => callback(data)),
  validateJobDpi: (jobId) => ipcRenderer.invoke('jobs:validateDpi', jobId),
  approveDpiJob: (jobId) => ipcRenderer.invoke('jobs:approveDpi', jobId),

  // Activity log
  readLogs: (options) => ipcRenderer.invoke('logs:read', options),
  getLogsPath: () => ipcRenderer.invoke('logs:getPath'),
  exportLogs: (content) => ipcRenderer.invoke('logs:export', content),

  // Print Controllers
  getPrintControllers: () => ipcRenderer.invoke('printControllers:getAll'),
  addPrintController: (data) => ipcRenderer.invoke('printControllers:add', data),
  updatePrintController: (id, updates) => ipcRenderer.invoke('printControllers:update', { id, updates }),
  deletePrintController: (id) => ipcRenderer.invoke('printControllers:delete', id),
  addProductMapping: (data) => ipcRenderer.invoke('printControllers:addProductMapping', data),
  deleteProductMapping: (id) => ipcRenderer.invoke('printControllers:deleteProductMapping', id),
  getKnownOptions: () => ipcRenderer.invoke('printControllers:getKnownOptions'),

  // Order Routing
  routingResolve:        (job)     => ipcRenderer.invoke('ohd:routing:resolve',               { job }),
  getOrderControllers:   ()        => ipcRenderer.invoke('ohd:routing:get-controllers'),
  saveOrderController:   (ctrl)    => ipcRenderer.invoke('ohd:routing:save-controller',       ctrl),
  deleteOrderController: (id)      => ipcRenderer.invoke('ohd:routing:delete-controller',     { id }),
  getProcessMappings:    ()        => ipcRenderer.invoke('ohd:routing:get-process-mappings'),
  saveProcessMapping:    (mapping) => ipcRenderer.invoke('ohd:routing:save-process-mapping',  mapping),
  getChannelMappings:    ()        => ipcRenderer.invoke('ohd:routing:get-channel-mappings'),
  saveChannelMapping:    (mapping) => ipcRenderer.invoke('ohd:routing:save-channel-mapping',  mapping),
  deleteChannelMapping:  (id)      => ipcRenderer.invoke('ohd:routing:delete-channel-mapping', { id }),
  getExceptions:         ()        => ipcRenderer.invoke('ohd:routing:get-exceptions'),
  saveException:         (exc)     => ipcRenderer.invoke('ohd:routing:save-exception',        exc),
  deleteException:       (id)      => ipcRenderer.invoke('ohd:routing:delete-exception',      { id }),
  getProcessValues:      ()        => ipcRenderer.invoke('ohd:routing:get-process-values'),

  // Test utilities
  runPrintControllerTest: () => ipcRenderer.invoke('test:printController'),

  // App version & update state
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  onUpdateReady: (callback) => ipcRenderer.on('app:updateReady', (event, data) => callback(data)),
  onUpdateAvailable: (callback) => ipcRenderer.on('app:updateAvailable', (event, data) => callback(data)),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Window controls (frameless window)
  minimiseWindow: () => ipcRenderer.send('window:minimise'),
  maximiseWindow: () => ipcRenderer.send('window:maximise'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onWindowMaximised: (cb) => ipcRenderer.on('window:maximised', (_event, isMax) => cb(isMax)),

  // Job Review Panel
  jobLoad:        (payload) => ipcRenderer.invoke('ohd:job:load', payload),
  jobSave:        (payload) => ipcRenderer.invoke('ohd:job:save', payload),
  jobResetImage:  (payload) => ipcRenderer.invoke('ohd:job:reset-image', payload),
  jobResetAll:    (payload) => ipcRenderer.invoke('ohd:job:reset-all', payload),
  reprintCreate:  (payload) => ipcRenderer.invoke('ohd:reprint:create', payload),

  // AI Enhancement (Phase 3)
  enhancementTest:   (payload) => ipcRenderer.invoke('ohd:enhancement:test',   payload),
  enhancementRun:    (payload) => ipcRenderer.invoke('ohd:enhancement:run',    payload),
  enhancementStatus: (payload) => ipcRenderer.invoke('ohd:enhancement:status', payload),
  enhancementCancel: (payload) => ipcRenderer.invoke('ohd:enhancement:cancel', payload),

  // DPOF output status
  getJobOutputStatus: (jobId) => ipcRenderer.invoke('ohd:job:get-output-status', { jobId }),
  markPrinted:        (jobId) => ipcRenderer.invoke('ohd:job:mark-printed',      { jobId }),
  resendJob:          (jobId) => ipcRenderer.invoke('ohd:job:resend',             { jobId }),
  onJobStatusChanged: (callback) => ipcRenderer.on('ohd:job:status-changed', (event, data) => callback(data)),

  // Dismissed jobs
  getDismissedJobs: () => ipcRenderer.invoke('store:getDismissedJobs'),
  dismissJob: (jobId) => ipcRenderer.invoke('store:dismissJob', jobId),
  undismissJob: (jobId) => ipcRenderer.invoke('store:undismissJob', jobId),

  // Job date range
  getJobDateRange: () => ipcRenderer.invoke('store:getJobDateRange'),
  setJobDateRange: (days) => ipcRenderer.invoke('store:setJobDateRange', days),
});
