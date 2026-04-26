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
  deleteProcessMapping:  (process) => ipcRenderer.invoke('ohd:routing:delete-process-mapping', { process }),
  getChannelMappings:       ()                               => ipcRenderer.invoke('ohd:routing:get-channel-mappings'),
  getAllSizeOptions:         ()                               => ipcRenderer.invoke('ohd:routing:get-all-size-options'),
  saveChannelMapping:       (mapping)                        => ipcRenderer.invoke('ohd:routing:save-channel-mapping',  mapping),
  deleteChannelMapping:     (id)                             => ipcRenderer.invoke('ohd:routing:delete-channel-mapping', { id }),
  assignDarkroomChannel:    (jobId, channelMappingId)        => ipcRenderer.invoke('jobs:assignDarkroomChannel', { jobId, channelMappingId }),
  assignDarkroomSizeMedia:  (jobId, size, media)            => ipcRenderer.invoke('jobs:assignDarkroomSizeMedia', { jobId, size, media }),
  updateDarkroomTranslations: (payload)                     => ipcRenderer.invoke('controllers:updateDarkroomTranslations', payload),
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
  jobLoad:        (payload) => ipcRenderer.invoke('ohd:job:load',       payload),
  jobSave:        (payload) => ipcRenderer.invoke('ohd:job:save',       payload),
  jobResetImage:  (payload) => ipcRenderer.invoke('ohd:job:reset-image', payload),
  jobResetAll:    (payload) => ipcRenderer.invoke('ohd:job:reset-all',   payload),
  jobCropImage:   (payload) => ipcRenderer.invoke('ohd:job:crop-image',  payload),
  reprintCreate:  (payload) => ipcRenderer.invoke('ohd:reprint:create',  payload),

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

  // Film Review panel (PW-007 Phase 1 — Milestone 4)
  //
  // Queries return plain data (arrays / records / null). Commands return the
  // updated record so the renderer can optimistically patch its local state.
  // Tweaks persist to a dedicated electron-store, distinct from config.json.
  filmReviewListRolls:        ()                       => ipcRenderer.invoke('ohd:filmReview:list-rolls'),
  filmReviewGetRoll:          (rollId)                 => ipcRenderer.invoke('ohd:filmReview:get-roll',   rollId),
  filmReviewGetFrame:         (frameId)                => ipcRenderer.invoke('ohd:filmReview:get-frame',  frameId),
  filmReviewGetThumbnail:     (frameId)                => ipcRenderer.invoke('ohd:filmReview:get-thumbnail', frameId),
  filmReviewFlagFrame:        (frameId, flag)          => ipcRenderer.invoke('ohd:filmReview:flag-frame',   { frameId, flag }),
  filmReviewUnflagFrame:      (frameId, flagIndex)     => ipcRenderer.invoke('ohd:filmReview:unflag-frame', { frameId, flagIndex }),
  filmReviewMarkRollReviewed: (rollId)                 => ipcRenderer.invoke('ohd:filmReview:mark-roll-reviewed', rollId),
  filmReviewOpenFolder:       (rollId)                 => ipcRenderer.invoke('ohd:filmReview:open-folder', rollId),
  filmReviewRotateFrame:      (frameId, delta)         => ipcRenderer.invoke('ohd:filmReview:rotate-frame', { frameId, delta }),
  filmReviewApproveRoll:      (rollId)                 => ipcRenderer.invoke('ohd:filmReview:approve-roll', rollId),
  filmReviewGetTweaks:        ()                       => ipcRenderer.invoke('ohd:filmReview:get-tweaks'),
  filmReviewSetTweak:         (key, value)             => ipcRenderer.invoke('ohd:filmReview:set-tweak',  { key, value }),
  onFilmReviewRollProcessed:  (callback) =>
    ipcRenderer.on('ohd:filmReview:roll-processed', (event, data) => callback(data)),

  // AI Quality Gate (v1.2.0)
  aiQualityListHeldJobs:    ()                                => ipcRenderer.invoke('aiQuality:listHeldJobs'),
  aiQualityGetJobQuality:   (jobId)                           => ipcRenderer.invoke('aiQuality:getJobQuality', jobId),
  aiQualityReleaseJob:      (jobId, note)                     => ipcRenderer.invoke('aiQuality:releaseJob', { jobId, note }),
  aiQualityApproveImage:    (jobId, filename, note)           => ipcRenderer.invoke('aiQuality:approveImage', { jobId, filename, note }),
  onAiQualityJobHeld:       (callback) =>
    ipcRenderer.on('aiQuality:jobHeld', (event, data) => callback(data)),
});
