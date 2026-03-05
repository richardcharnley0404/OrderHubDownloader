const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Configuration
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // Directory picker
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),

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

  // Test utilities
  runPrintControllerTest: () => ipcRenderer.invoke('test:printController'),

  // App version & update state
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  onUpdateReady: (callback) => ipcRenderer.on('app:updateReady', (event, data) => callback(data)),
  onUpdateAvailable: (callback) => ipcRenderer.on('app:updateAvailable', (event, data) => callback(data)),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Window controls (frameless window)
  minimiseWindow: () => ipcRenderer.send('window:minimise'),
  closeWindow: () => ipcRenderer.send('window:close')
});
