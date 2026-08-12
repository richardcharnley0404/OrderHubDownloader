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

  // Order XML Hot Folders (Mode 4)
  orderXmlListRecords: (args) => ipcRenderer.invoke('orderXml:listRecords', args),
  orderXmlGetStatus:   ()     => ipcRenderer.invoke('orderXml:getStatus'),
  orderXmlClear:       ()     => ipcRenderer.invoke('orderXml:clearRecords'),
  orderXmlRetryFailed: (id)   => ipcRenderer.invoke('orderXml:retryFailed', { id }),
  orderXmlGetHotFolders: ()   => ipcRenderer.invoke('orderXml:getHotFolders'),
  orderXmlListParserFormats: () => ipcRenderer.invoke('orderXml:listParserFormats'),
  orderXmlOpenFolder:  (id, which) => ipcRenderer.invoke('orderXml:openFolder', { id, which }),

  // Status updates from main process
  onStatusUpdate: (callback) => ipcRenderer.on('status:update', (event, data) => callback(data)),

  // Job management
  getJobs: () => ipcRenderer.invoke('jobs:getAll'),
  refreshJobs: () => ipcRenderer.invoke('jobs:refresh'),
  sendToPrint: (jobId) => ipcRenderer.invoke('jobs:sendToPrint', jobId),
  markCompleted: (jobId) => ipcRenderer.invoke('jobs:markCompleted', jobId),
  onJobsUpdated: (callback) => ipcRenderer.on('jobs:updated', (event, data) => callback(data)),

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
  parseChannelMappingsCsv:  (csv)                            => ipcRenderer.invoke('ohd:routing:parse-mappings-csv', csv),
  checkRoutingHealth:       ()                               => ipcRenderer.invoke('ohd:routing:check-health'),
  retryJob:                 (jobId)                          => ipcRenderer.invoke('ohd:job:retry', { jobId }),
  assignDarkroomChannel:    (jobId, channelMappingId)        => ipcRenderer.invoke('jobs:assignDarkroomChannel', { jobId, channelMappingId }),
  assignDarkroomSizeMedia:  (jobId, size, media)            => ipcRenderer.invoke('jobs:assignDarkroomSizeMedia', { jobId, size, media }),
  updateDarkroomTranslations: (payload)                     => ipcRenderer.invoke('controllers:updateDarkroomTranslations', payload),
  getExceptions:         ()        => ipcRenderer.invoke('ohd:routing:get-exceptions'),
  saveException:         (exc)     => ipcRenderer.invoke('ohd:routing:save-exception',        exc),
  deleteException:       (id)      => ipcRenderer.invoke('ohd:routing:delete-exception',      { id }),
  getProcessValues:      ()        => ipcRenderer.invoke('ohd:routing:get-process-values'),

  // ohd-api v1.4.0 — server-advertised polling cadence + feature flags.
  // Returned shape: { pollIntervalSeconds, statusPollIntervalSeconds,
  // features: { status_batch, pending_etag, presign_expiry, status_batch_max },
  // lastCheckinAt }. Null intervals mean "server hasn't advertised one".
  getServerCapabilities: () => ipcRenderer.invoke('ohd:server:get-capabilities'),
  // v1.7.8 — release a routing-hold. controllerId=null releases to default;
  // controllerId=<string> reassigns. Returns { ok, reason?, controller?, releasedTo? }.
  // ok=false with reason='no-channel' carries `controller` so the renderer
  // can chain into the existing Assign Channel modal.
  routingReleaseHold:    (jobId, opts) => ipcRenderer.invoke('ohd:routing:release-hold', {
    jobId,
    controllerId: (opts && opts.controllerId) || null,
  }),

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
  // Payload: { jobPath, sidecar, filename, cropRect: {x,y,w,h}, channelMappingId?,
  //            darkroomSize?, ohJobId?, cropRotation?: 0|90|180|270,
  //            sourceFrom?: 'working'|'originals' }
  // M5c (2026-05-26): cropRotation default 0 keeps byte-identical sharp chain;
  // non-zero applies sharp.rotate(N).extract(rect) — rect is in POST-rotation
  // image coords (per the brief's implementer note).
  // Manual Crop redesign (2026-06-02): sourceFrom default 'working' preserves
  // M5a semantics; 'originals' (set by ManualCropMode) reads pristine pixels
  // from /originals/<filename> so re-approves don't crop a previous crop's
  // output. Falls back to /working/ if /originals/ is missing.
  jobCropImage:   (payload) => ipcRenderer.invoke('ohd:job:crop-image',  payload),
  reprintCreate:  (payload) => ipcRenderer.invoke('ohd:reprint:create',  payload),
  reprintCreateSingle: (payload) => ipcRenderer.invoke('ohd:reprint:createSingle', payload),

  // Customer Originals (Phase 1) — open / reveal the customer's uncropped
  // upload in the OS's default viewer / Explorer-Finder. Both take the
  // manifest-relative path stored on the sidecar entry and let the main
  // side resolve to absolute + verify existence before the shell call.
  originalOpen:   (payload) => ipcRenderer.invoke('ohd:original:open',   payload),
  originalReveal: (payload) => ipcRenderer.invoke('ohd:original:reveal', payload),

  // Customer Originals (Phase 2) — re-crop the customer's uncropped upload
  // through sharp into /recrops/ + /working/, then return the updated sidecar.
  // Payload: { jobPath, sidecar, filename, cropRect: {x,y,w,h} }
  jobRecropFromOriginal: (payload) => ipcRenderer.invoke('ohd:job:recrop-from-original', payload),

  // Manual Cropping M5b (2026-05-25) — batch crop for manual-source jobs.
  // Payload: { jobPath, sidecar, filenames, fractionalSpec, sizeOption,
  //            orientation: 'portrait'|'landscape'|'auto',
  //            perImageOrientations?: { [filename]: 'portrait'|'landscape' },
  //            channelMappingId?, darkroomSize?, ohJobId?,
  //            sourceFrom?: 'working'|'originals' }
  // Returns: { success, sidecar, succeeded, failed, skipped, aborted? }
  // Manual Crop redesign (2026-06-02): sourceFrom default 'working' preserves
  // M5b semantics; 'originals' (set by ManualCropMode's Apply Default to All)
  // sources every target image from /originals/<filename>.
  // 2026-07-23: orientation:'auto' + perImageOrientations enable per-image
  // best-fit crop-box orientation for the (currently dormant from renderer)
  // batch driver — the persisted cropOrientation is the resolved per-image
  // value, never the top-level 'auto' literal. See
  // docs/manual-crop-best-fit-orientation.md.
  jobBatchCropApply:  (payload) => ipcRenderer.invoke('ohd:job:batch-crop-apply', payload),

  // Manual Crop redesign (2026-06-01) — persist in-progress per-image crop
  // state when the operator closes the drawer mid-job without approving.
  // Partial mutation: only pendingCropRect / pendingRotation /
  // pendingOrientation on matched image entries are written. Applied-crop
  // fields (cropApplied, cropRect, cropRotation, cropOrientation) are
  // never touched here — those are owned by jobCropImage / jobBatchCropApply.
  // Payload: { jobPath, sidecar, updates: [{ filename, pendingCropRect,
  //            pendingRotation, pendingOrientation }] }
  // Returns: { success, sidecar } | { success: false, error }
  jobSavePendingCrops: (payload) => ipcRenderer.invoke('ohd:job:save-pending-crops', payload),

  // Manual Crop redesign (2026-06-02) — Delete / Restore. Toggles the
  // operator-driven `discarded` flag on a single sidecar image entry
  // and persists. Recoverable: cropApplied / cropRect / pendingCropRect
  // are left intact. No file deletion on disk.
  // Payload: { jobPath, sidecar, filename, discarded: boolean }
  // Returns: { success, sidecar } | { success: false, error }
  jobSetImageDiscarded: (payload) => ipcRenderer.invoke('ohd:job:set-image-discarded', payload),
  // Read-only target-size resolution: route → matching allSizeOptions
  // entry. Used by the batch crop top-bar's size pill. If no route or
  // no size translation, returns { ok: false, reason }.
  resolveTargetSize:  (payload) => ipcRenderer.invoke('ohd:job:resolve-target-size', payload),
  // Per-image progress stream from a running batch. Channel-specific
  // (matches the existing onJobsUpdated / onDownloadProgress pattern).
  // Returns an unsubscribe function so the renderer can clean up on
  // mode exit / unmount.
  onBatchCropProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('ohd:batch-crop:progress', handler);
    return () => ipcRenderer.removeListener('ohd:batch-crop:progress', handler);
  },

  // AI Enhancement (Phase 3+)
  enhancementTest:   (payload) => ipcRenderer.invoke('ohd:enhancement:test',   payload),
  enhancementRun:    (payload) => ipcRenderer.invoke('ohd:enhancement:run',    payload),
  enhancementStatus: (payload) => ipcRenderer.invoke('ohd:enhancement:status', payload),
  enhancementCancel: (payload) => ipcRenderer.invoke('ohd:enhancement:cancel', payload),

  // AI Enhancement — Perfectly Clear batch + revert (M3, 2026-07-03).
  // batchRun kicks off one processBatch through the shared client for any
  // subset (one / many / Select All) of a job's images and returns a
  // synthetic batch ID. Renderer polls batchStatus for per-file states +
  // counts; batchCancel is cooperative. revert restores the pre-PC snapshot
  // from /cache/ and strips the enhancement bookkeeping fields (crop
  // fields left intact).
  enhancementBatchRun:    (payload) => ipcRenderer.invoke('ohd:enhancement:batchRun',    payload),
  enhancementBatchStatus: (payload) => ipcRenderer.invoke('ohd:enhancement:batchStatus', payload),
  enhancementBatchCancel: (payload) => ipcRenderer.invoke('ohd:enhancement:batchCancel', payload),
  enhancementRevert:      (payload) => ipcRenderer.invoke('ohd:enhancement:revert',      payload),

  // Perfectly Clear QuickServer — M1 (2026-07-03). Config read/write goes
  // through the existing getConfig / saveConfig plumbing (perfectlyClear is
  // just another key on the config object). Only the test action needs its
  // own IPC because it touches the filesystem at click-time.
  pcTestConfig: (payload) => ipcRenderer.invoke('ohd:pc:testConfig', payload),

  // Phase 1 local-enhancement: ack the post-upgrade migration toast so it
  // doesn't re-show on the next launch.
  clearReplicateMigrationToast: () => ipcRenderer.invoke('ohd:config:clear-replicate-migration-toast'),

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
  filmReviewDeleteFrame:      (frameId)                => ipcRenderer.invoke('ohd:filmReview:delete-frame', frameId),
  filmReviewDeleteFrames:     (frameIds)               => ipcRenderer.invoke('ohd:filmReview:delete-frames', frameIds),
  filmReviewApproveRoll:      (rollId)                 => ipcRenderer.invoke('ohd:filmReview:approve-roll', rollId),
  // Film Development Auto Assignment (M5): explicit operator override
  // for a reviewed-but-unmatched held roll (walk-in / typo in twin
  // check). See ipc-handlers.js for the preconditions.
  filmReviewUploadUnmatched:  (rollId)                 => ipcRenderer.invoke('ohd:filmReview:upload-unmatched', rollId),
  filmReviewDeleteRoll:       (rollId)                 => ipcRenderer.invoke('ohd:filmReview:delete-roll',  rollId),
  filmReviewGetTweaks:        ()                       => ipcRenderer.invoke('ohd:filmReview:get-tweaks'),

  // Perfectly Clear per-frame — Film Scans (M4, 2026-07-03).
  // enhanceFrame blocks until the one-file processBatch returns; the
  // renderer shows a local spinner meanwhile. revertFrame restores the
  // pre-enhance/ backup and clears the PC metadata. enhanceStatus is a
  // lightweight query for the in-flight case when reopening a panel.
  filmScanEnhanceFrame:  (payload) => ipcRenderer.invoke('ohd:filmscan:enhanceFrame',  payload),
  filmScanRevertFrame:   (payload) => ipcRenderer.invoke('ohd:filmscan:revertFrame',   payload),
  filmScanEnhanceStatus: (payload) => ipcRenderer.invoke('ohd:filmscan:enhanceStatus', payload),
  // 2026-07-23 — operator "Reset enhancement" for a roll wedged at
  // processingStatus:'enhancing'. Aborts a live in-flight batch when
  // one is running; falls through to sweep-style cleanup when the
  // record is a phantom. Returns { success, wasLive, error? }.
  filmScansResetEnhancement: (rollId) => ipcRenderer.invoke('ohd:filmScans:reset-enhancement', rollId),
  filmReviewSetTweak:         (key, value)             => ipcRenderer.invoke('ohd:filmReview:set-tweak',  { key, value }),
  onFilmReviewRollProcessed:  (callback) =>
    ipcRenderer.on('ohd:filmReview:roll-processed', (event, data) => callback(data)),

  // App-wide theme (light | dark). Drives body.app-theme-dark — see
  // job-review.css / film-review.css / styles.css token definitions.
  appGetTheme:                ()                       => ipcRenderer.invoke('ohd:app:get-theme'),
  appSetTheme:                (value)                  => ipcRenderer.invoke('ohd:app:set-theme', value),
  // AI Quality Gate (v1.2.0)
  aiQualityListHeldJobs:    ()                                => ipcRenderer.invoke('aiQuality:listHeldJobs'),
  aiQualityGetJobQuality:   (jobId)                           => ipcRenderer.invoke('aiQuality:getJobQuality', jobId),
  aiQualityReleaseJob:      (jobId, note)                     => ipcRenderer.invoke('aiQuality:releaseJob', { jobId, note }),
  aiQualityApproveImage:    (jobId, filename, note)           => ipcRenderer.invoke('aiQuality:approveImage', { jobId, filename, note }),
  onAiQualityJobHeld:       (callback) =>
    ipcRenderer.on('aiQuality:jobHeld', (event, data) => callback(data)),

  // Backup & Restore (v1.6+)
  //
  // Snapshots all non-sensitive electron-store state to a single JSON file on
  // a network share (UNC), local disk, or mapped drive. Credentials are
  // never written; the operator re-enters them after restore. See
  // docs/backup-restore.md.
  backupRunNow:         (opts)                      => ipcRenderer.invoke('ohd:backup:run-now', opts || {}),
  backupList:           (args)                      => ipcRenderer.invoke('ohd:backup:list', args || {}),
  backupRead:           (filePath)                  => ipcRenderer.invoke('ohd:backup:read', { filePath }),
  backupRestore:        (filePath, selections)      => ipcRenderer.invoke('ohd:backup:restore', { filePath, selections }),
  backupRelaunch:       ()                          => ipcRenderer.invoke('ohd:backup:relaunch'),
  backupChooseFolder:   ()                          => ipcRenderer.invoke('ohd:backup:choose-folder'),
  backupChooseFile:     ()                          => ipcRenderer.invoke('ohd:backup:choose-file'),
  backupValidateFolder: (folderPath)                => ipcRenderer.invoke('ohd:backup:validate-folder', { folderPath }),
});
