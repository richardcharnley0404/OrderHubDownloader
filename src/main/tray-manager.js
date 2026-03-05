const { Tray, Menu, nativeImage, app, shell } = require('electron');
const path = require('path');
const windowManager = require('./window-manager');
const configService = require('./services/config-service');
const jobService = require('./services/job-service');
const logger = require('./services/logger');

class TrayManager {
  constructor() {
    this.tray = null;
    this.pollingService = null;
    this.isRefreshing = false;
  }

  /**
   * Initialize system tray
   */
  create(pollingService) {
    this.pollingService = pollingService;

    try {
      // Create tray icon
      const iconPath = path.join(__dirname, '../../assets/favicon hub.png');
      const icon = nativeImage.createFromPath(iconPath);

      this.tray = new Tray(icon.resize({ width: 16, height: 16 }));
      this.tray.setToolTip('OrderHub Downloader');

      // Handle tray icon click
      this.tray.on('click', () => {
        windowManager.showWindow();
      });

      // Build context menu
      this.updateContextMenu();

      logger.info('System tray created');
    } catch (error) {
      logger.logError('Error creating system tray', error);
    }
  }

  /**
   * Update context menu
   */
  updateContextMenu() {
    if (!this.tray) return;

    const pollingStatus = this.pollingService
      ? this.pollingService.getStatus()
      : { isRunning: false, lastCheck: null };

    const config = configService.getAll();
    const { jobs } = jobService.getLocalJobs();

    // ── Build menu items ──

    const menuItems = [];

    // ── Header: Service status & last check ──
    const statusDot = pollingStatus.isRunning ? '\u25CF' : '\u25CB';
    const statusText = pollingStatus.isRunning ? 'ON' : 'OFF';
    menuItems.push({
      label: `${statusDot} Service: ${statusText}`,
      enabled: false
    });

    if (pollingStatus.lastCheck) {
      const time = new Date(pollingStatus.lastCheck).toLocaleTimeString();
      menuItems.push({
        label: `    Last check: ${time}`,
        enabled: false
      });
    }

    menuItems.push({ type: 'separator' });

    // ── Job counts ──
    if (jobs.length > 0) {
      menuItems.push({
        label: `Jobs: ${jobs.length} total`,
        enabled: false
      });

      const statusCounts = [
        { status: 'pending', label: 'Pending' },
        { status: 'received', label: 'Received' },
        { status: 'in_production', label: 'In Production' }
      ];

      for (const { status, label } of statusCounts) {
        const count = jobs.filter(j => j._status === status).length;
        if (count > 0) {
          menuItems.push({
            label: `    ${count} ${label}`,
            enabled: false
          });
        }
      }
    } else {
      menuItems.push({
        label: 'No jobs loaded',
        enabled: false
      });
    }

    menuItems.push({ type: 'separator' });

    // ── Actions ──
    menuItems.push({
      label: 'Open OrderHub Downloader',
      click: () => {
        windowManager.showWindow();
      }
    });

    const downloadDir = config.downloadDirectory;
    if (downloadDir) {
      menuItems.push({
        label: 'Open Download Folder',
        click: () => {
          shell.openPath(downloadDir).catch(err => {
            logger.logError('Error opening download folder', err);
          });
        }
      });
    }

    menuItems.push({ type: 'separator' });

    // ── Controls ──
    menuItems.push({
      label: pollingStatus.isRunning ? 'Stop Service' : 'Start Service',
      click: () => {
        try {
          if (pollingStatus.isRunning) {
            this.pollingService.stop();
          } else {
            this.pollingService.start();
          }
          this.updateContextMenu();
        } catch (error) {
          logger.logError('Error toggling polling from tray', error);
        }
      }
    });

    menuItems.push({
      label: this.isRefreshing ? 'Refreshing...' : 'Refresh Jobs Now',
      enabled: !this.isRefreshing && pollingStatus.isRunning,
      click: () => {
        this.refreshNow();
      }
    });

    menuItems.push({ type: 'separator' });

    // ── Quit ──
    menuItems.push({
      label: 'Quit',
      click: () => {
        app.quit();
      }
    });

    const contextMenu = Menu.buildFromTemplate(menuItems);
    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Trigger an immediate poll cycle and update menu
   */
  async refreshNow() {
    if (this.isRefreshing || !this.pollingService) return;

    try {
      this.isRefreshing = true;
      this.updateContextMenu();
      logger.info('Tray: manual refresh triggered');

      await this.pollingService.runAllModes();

      logger.info('Tray: manual refresh complete');
    } catch (error) {
      logger.logError('Tray: error during manual refresh', error);
    } finally {
      this.isRefreshing = false;
      this.updateContextMenu();
    }
  }

  /**
   * Update tooltip
   */
  updateTooltip() {
    if (!this.tray) return;

    const status = this.pollingService ? this.pollingService.getStatus() : {};
    const { jobs } = jobService.getLocalJobs();

    const serviceLabel = status.isRunning ? 'ON' : 'OFF';
    const jobsLabel = `${jobs.length} jobs`;
    const timeLabel = status.lastCheck
      ? `Last: ${new Date(status.lastCheck).toLocaleTimeString()}`
      : '';

    const parts = [`Service: ${serviceLabel}`, jobsLabel];
    if (timeLabel) parts.push(timeLabel);

    this.tray.setToolTip(`OrderHub Downloader\n${parts.join(' | ')}`);
  }

  /**
   * Update status and refresh menu
   */
  updateStatus() {
    this.updateContextMenu();
    this.updateTooltip();
  }

  /**
   * Destroy tray
   */
  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
      logger.info('System tray destroyed');
    }
  }
}

module.exports = new TrayManager();
