const { app } = require('electron');
const windowManager = require('./window-manager');
const trayManager = require('./tray-manager');
const { setupIpcHandlers } = require('./ipc-handlers');
const pollingService = require('./services/polling-service');
const ftpService = require('./services/ftp-service');
const configService = require('./services/config-service');
const logger = require('./services/logger');
const updater = require('./updater');

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window
    logger.info('Second instance detected, showing window');
    windowManager.showWindow();
  });

  // This method will be called when Electron has finished initialization
  app.whenReady().then(() => {
    logger.info('Application starting', { version: app.getVersion() });

    // Setup IPC handlers (pass windowManager so jobs:updated events can reach renderer)
    setupIpcHandlers(pollingService, ftpService, windowManager);

    // Create main window
    windowManager.createWindow();

    // Give the updater a reference to the window, then start the check-in schedule
    updater.setMainWindow(windowManager.getWindow());
    updater.startUpdateSchedule();

    // Create system tray
    trayManager.create(pollingService);

    // Start polling if any mode is configured and enabled
    const config = configService.getAll();
    const anyModeEnabled = (config.pollingEnabled && configService.isConfigured()) ||
      config.filmScansEnabled || config.fileUploadsEnabled;
    if (anyModeEnabled) {
      logger.info('Auto-starting polling service');
      try {
        pollingService.start();
      } catch (error) {
        logger.logError('Failed to auto-start polling', error);
      }
    }

    // Update tray status periodically
    setInterval(() => {
      trayManager.updateStatus();
    }, 5000);

    app.on('activate', () => {
      // On macOS, re-create window when dock icon is clicked
      if (windowManager.getWindow() === null) {
        windowManager.createWindow();
      }
    });

    logger.info('Application ready');
  });

  // Prevent app from quitting when all windows are closed (system tray app)
  app.on('window-all-closed', () => {
    // Don't quit - keep running in tray
    logger.debug('All windows closed, app continues in tray');
  });

  // Handle app quit
  app.on('before-quit', () => {
    logger.info('Application quitting');

    // Stop polling
    if (pollingService.isRunning()) {
      pollingService.stop();
    }

    // Allow window to close
    const mainWindow = windowManager.getWindow();
    if (mainWindow) {
      mainWindow.removeAllListeners('close');
    }

    // Destroy tray
    trayManager.destroy();
  });

  app.on('quit', () => {
    logger.info('Application quit');
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.logError('Uncaught exception', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.logError('Unhandled rejection', new Error(String(reason)));
  });
}
