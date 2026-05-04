const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const os = require('os');
const { getInstanceId } = require('./instance');
const configService = require('./services/config-service');
const logger = require('./services/logger');

// ── State ────────────────────────────────────────────────────────────────────

let _updateReady = false;      // true once an update has been downloaded
let _mainWindow = null;        // set by setMainWindow() so we can push events to the renderer

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Give the updater a reference to the main window so it can push
 * 'app:updateReady' events to the renderer when a download completes.
 */
function setMainWindow(win) {
  _mainWindow = win;
}

/** True if a downloaded update is waiting to be installed. */
function isUpdateReady() {
  return _updateReady;
}

/**
 * Start the check-in schedule: run immediately on startup, then every 4 hours.
 * Safe to call before the main window exists.
 */
function startUpdateSchedule() {
  _configureAutoUpdater();
  _checkIn();
  setInterval(_checkIn, 4 * 60 * 60 * 1000); // every 4 hours
}

// ── electron-updater setup ───────────────────────────────────────────────────

function _configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // we handle logging ourselves

  autoUpdater.on('update-available', (info) => {
    logger.info(`Update available: v${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('OHD is up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    logger.info(`Downloading update: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    logger.info(`Update downloaded: v${info.version}`);
    _updateReady = true;

    // Push event to renderer so the header badge appears
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.webContents.send('app:updateReady', { version: info.version });
    }

    const isMandatory = !!info.isMandatory;
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `OHD v${info.version} has been downloaded.`,
      detail: isMandatory
        ? 'This is a required update. OHD will restart now.'
        : 'Restart OHD to apply the update.',
      buttons: isMandatory ? ['Restart Now'] : ['Restart Now', 'Later'],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0 || isMandatory) {
        autoUpdater.quitAndInstall();
      }
    }).catch(() => {});
  });

  autoUpdater.on('error', (err) => {
    logger.logError('Auto-updater error', err);
  });
}

// ── Check-in ─────────────────────────────────────────────────────────────────

async function _checkIn() {
  try {
    // Only register this install with OrderHub when it is actively
    // downloading artwork (i.e. polling is enabled). Upload-only
    // deployments — a PC running solely to push Film Scans or File
    // Uploads to S3 — don't need to appear as an online OHD in the
    // OrderHub admin console because they aren't doing artwork work
    // and the operator wouldn't expect them to.
    //
    // Multi-PC site context: a common deployment splits work across
    // boxes (PC #1 polls + dispatches; PC #2 watches a film-scan
    // folder and uploads). Without this gate both PCs would check in
    // with separate `instance_id`s and `machine_name`s every 4 hours,
    // making the admin console list confusing and giving the appearance
    // of "two OHDs running" when in practice only one is doing OH-side
    // work. See docs/orderhub/bugfixes.md 2026-04-30 for the full
    // rationale.
    if (!configService.get('pollingEnabled')) {
      return;
    }

    const { baseUrl, key: apiKey, organizationId, locationId } = configService.getApiSettings();

    if (!apiKey || !organizationId) {
      // Not yet configured — skip silently
      return;
    }

    const checkinUrl = `${baseUrl}/checkin`;
    const body = JSON.stringify({
      instance_id: getInstanceId(),
      organisation_id: organizationId,
      location_id: locationId || null,
      machine_name: os.hostname(),
      current_version: app.getVersion()
    });

    const https = require('https');
    const http = require('http');
    const urlObj = new URL(checkinUrl);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      };

      const req = protocol.request(options, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, raw }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Check-in timeout')); });
      req.write(body);
      req.end();
    });

    if (response.statusCode === 404) {
      // Endpoint not yet deployed on the OH server — skip quietly
      logger.logWarning('Check-in endpoint not yet available (404) — skipping');
      return;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      logger.logError(`Check-in failed (non-fatal): HTTP ${response.statusCode}`, new Error(response.raw.substring(0, 200)));
      return;
    }

    let data = {};
    try { data = JSON.parse(response.raw); } catch { /* ignore non-JSON 2xx */ }

    logger.info('Check-in successful', {
      is_up_to_date: data.is_up_to_date,
      latest_version: data.latest_version
    });

    // Push update banner to renderer if the API signals one is available
    if (data.update && data.update.available === true) {
      if (_mainWindow && !_mainWindow.isDestroyed()) {
        _mainWindow.webContents.send('app:updateAvailable', data.update);
      }
    }

    // If a newer version is available, point electron-updater at the download URL and trigger check
    if (data.is_up_to_date === false && data.download_url) {
      autoUpdater.setFeedURL({ provider: 'generic', url: data.download_url });
      autoUpdater.checkForUpdates().catch(() => {});
    }
  } catch (err) {
    // Network failure — always fail silently, never block startup
    logger.logError('Check-in failed (non-fatal)', err);
  }
}

module.exports = { startUpdateSchedule, setMainWindow, isUpdateReady };
