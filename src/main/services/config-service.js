const Store = require('electron-store');

// Hardcoded OrderHub API base URL (not user-configurable)
const OH_API_BASE_URL = 'https://nazkcvruighrhpgcarxg.supabase.co/functions/v1/ohd-api';

// Define configuration schema with defaults
const schema = {
  orderhubApiUrl: {
    type: 'string',
    default: ''
  },
  orderhubApiKey: {
    type: 'string',
    default: ''
  },
  organizationId: {
    type: 'string',
    default: ''
  },
  locationId: {
    type: 'string',
    default: ''
  },
  ftpHost: {
    type: 'string',
    default: ''
  },
  ftpPort: {
    type: 'number',
    default: 21,
    minimum: 1,
    maximum: 65535
  },
  ftpUsername: {
    type: 'string',
    default: ''
  },
  ftpPassword: {
    type: 'string',
    default: ''
  },
  ftpRemotePath: {
    type: 'string',
    default: '/'
  },
  downloadDirectory: {
    type: 'string',
    default: ''
  },
  pollingEnabled: {
    type: 'boolean',
    default: false
  },
  launchOnStartup: {
    type: 'boolean',
    default: false
  },
  // Shared S3 settings
  s3Provider: {
    type: 'string',
    default: 'pixfizz'    // 'pixfizz' or 'amazon'
  },
  s3BucketName: {
    type: 'string',
    default: ''
  },
  // Amazon S3 only
  s3Region: {
    type: 'string',
    default: ''
  },
  s3AccessKeyId: {
    type: 'string',
    default: ''
  },
  s3SecretAccessKey: {
    type: 'string',
    default: ''
  },
  // Film Scans (Mode 2)
  filmScansEnabled: {
    type: 'boolean',
    default: false
  },
  filmScansWatchFolder: {
    type: 'string',
    default: ''
  },
  filmScansStorageFolder: {
    type: 'string',
    default: ''
  },
  filmScansAutoSyncMinutes: {
    type: 'number',
    default: 5,
    minimum: 1,
    maximum: 60
  },
  filmScansWatchguardMinutes: {
    type: 'number',
    default: 5,
    minimum: 1,
    maximum: 60
  },
  // File Uploads (Mode 3)
  fileUploadsEnabled: {
    type: 'boolean',
    default: false
  },
  fileUploadsWatchFolder: {
    type: 'string',
    default: ''
  },
  fileUploadsStorageFolder: {
    type: 'string',
    default: ''
  },
  fileUploadsAutoSyncMinutes: {
    type: 'number',
    default: 5,
    minimum: 1,
    maximum: 60
  },
  fileUploadsWatchguardMinutes: {
    type: 'number',
    default: 5,
    minimum: 1,
    maximum: 60
  },
  // Shared settings
  fileStabilityMinutes: {
    type: 'number',
    default: 5,
    minimum: 1,
    maximum: 60
  },
  // Polling interval in seconds
  pollingInterval: {
    type: 'number',
    default: 60,
    minimum: 10,
    maximum: 600
  },
  // Process folder for Send to Print (default fallback)
  processFolderPath: {
    type: 'string',
    default: ''
  },
  // Process folder mappings: { "Print": "C:\\Print", "Cut": "C:\\Cut" }
  processFolderMappings: {
    type: 'object',
    default: {}
  },
  // DPI Validation
  dpiValidationEnabled: {
    type: 'boolean',
    default: true
  },
  dpiExcellentThreshold: {
    type: 'number',
    default: 300,
    minimum: 72,
    maximum: 1200
  },
  dpiWarningThreshold: {
    type: 'number',
    default: 275,
    minimum: 72,
    maximum: 1200
  },
  dpiWarningAllowAutoSubmit: {
    type: 'boolean',
    default: true
  },
  dpiPoorThreshold: {
    type: 'number',
    default: 200,
    minimum: 72,
    maximum: 1200
  },
  dpiPoorAllowAutoSubmit: {
    type: 'boolean',
    default: false
  }
};

class ConfigService {
  constructor() {
    this.store = new Store({ schema });
  }

  /**
   * Get all configuration
   */
  getAll() {
    return {
      orderhubApiKey: this.store.get('orderhubApiKey'),
      organizationId: this.store.get('organizationId'),
      locationId: this.store.get('locationId'),
      ftpHost: this.store.get('ftpHost'),
      ftpPort: this.store.get('ftpPort'),
      ftpUsername: this.store.get('ftpUsername'),
      ftpPassword: this.store.get('ftpPassword'),
      ftpRemotePath: this.store.get('ftpRemotePath'),
      downloadDirectory: this.store.get('downloadDirectory'),
      pollingEnabled: this.store.get('pollingEnabled'),
      launchOnStartup: this.store.get('launchOnStartup'),
      // S3
      s3Provider: this.store.get('s3Provider'),
      s3BucketName: this.store.get('s3BucketName'),
      s3Region: this.store.get('s3Region'),
      s3AccessKeyId: this.store.get('s3AccessKeyId'),
      s3SecretAccessKey: this.store.get('s3SecretAccessKey'),
      // Film Scans
      filmScansEnabled: this.store.get('filmScansEnabled'),
      filmScansWatchFolder: this.store.get('filmScansWatchFolder'),
      filmScansStorageFolder: this.store.get('filmScansStorageFolder'),
      filmScansAutoSyncMinutes: this.store.get('filmScansAutoSyncMinutes'),
      filmScansWatchguardMinutes: this.store.get('filmScansWatchguardMinutes'),
      // File Uploads
      fileUploadsEnabled: this.store.get('fileUploadsEnabled'),
      fileUploadsWatchFolder: this.store.get('fileUploadsWatchFolder'),
      fileUploadsStorageFolder: this.store.get('fileUploadsStorageFolder'),
      fileUploadsAutoSyncMinutes: this.store.get('fileUploadsAutoSyncMinutes'),
      fileUploadsWatchguardMinutes: this.store.get('fileUploadsWatchguardMinutes'),
      // Shared
      fileStabilityMinutes: this.store.get('fileStabilityMinutes'),
      pollingInterval: this.store.get('pollingInterval'),
      // Process folder
      processFolderPath: this.store.get('processFolderPath'),
      processFolderMappings: this.store.get('processFolderMappings'),
      // DPI Validation
      dpiValidationEnabled: this.store.get('dpiValidationEnabled'),
      dpiExcellentThreshold: this.store.get('dpiExcellentThreshold'),
      dpiWarningThreshold: this.store.get('dpiWarningThreshold'),
      dpiWarningAllowAutoSubmit: this.store.get('dpiWarningAllowAutoSubmit'),
      dpiPoorThreshold: this.store.get('dpiPoorThreshold'),
      dpiPoorAllowAutoSubmit: this.store.get('dpiPoorAllowAutoSubmit')
    };
  }

  /**
   * Save configuration
   */
  save(config) {
    // Validate Mode 1 fields only if polling is enabled
    if (config.pollingEnabled) {
      if (!config.orderhubApiKey) {
        throw new Error('OrderHub API Key is required when polling is enabled');
      }
      if (!config.organizationId) {
        throw new Error('Organization ID is required when polling is enabled');
      }
      if (!config.locationId) {
        throw new Error('Location ID is required when polling is enabled');
      }
      if (!config.ftpHost || !config.ftpUsername || !config.ftpPassword) {
        throw new Error('FTP host, username, and password are required when polling is enabled');
      }
      if (!config.downloadDirectory) {
        throw new Error('Download directory is required when polling is enabled');
      }
    }

    // Validate S3 fields if either Mode 2 or Mode 3 is enabled
    if (config.filmScansEnabled || config.fileUploadsEnabled) {
      if (!config.s3BucketName) {
        throw new Error('S3 Bucket Name is required when Film Scans or File Uploads are enabled');
      }
      if (config.s3Provider === 'amazon') {
        if (!config.s3Region) {
          throw new Error('AWS Region is required when using Amazon S3');
        }
        if (!config.s3AccessKeyId || !config.s3SecretAccessKey) {
          throw new Error('AWS Access Key ID and Secret Access Key are required when using Amazon S3');
        }
      }
    }

    // Validate Film Scans fields if enabled
    if (config.filmScansEnabled) {
      if (!config.filmScansWatchFolder) {
        throw new Error('Film Scans watch folder is required when Film Scans is enabled');
      }
      if (!config.filmScansStorageFolder) {
        throw new Error('Film Scans storage folder is required when Film Scans is enabled');
      }
    }

    // Validate File Uploads fields if enabled
    if (config.fileUploadsEnabled) {
      if (!config.fileUploadsWatchFolder) {
        throw new Error('File Uploads watch folder is required when File Uploads is enabled');
      }
      if (!config.fileUploadsStorageFolder) {
        throw new Error('File Uploads storage folder is required when File Uploads is enabled');
      }
    }

    // Validate port if provided
    const port = parseInt(config.ftpPort, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) {
      this.store.set('ftpPort', port);
    }

    // Validate stability minutes
    const stabilityMinutes = parseInt(config.fileStabilityMinutes, 10);
    if (!isNaN(stabilityMinutes) && stabilityMinutes >= 1 && stabilityMinutes <= 60) {
      this.store.set('fileStabilityMinutes', stabilityMinutes);
    }

    // Save OrderHub API settings
    this.store.set('orderhubApiKey', (config.orderhubApiKey || '').trim());
    this.store.set('organizationId', (config.organizationId || '').trim());
    this.store.set('locationId', (config.locationId || '').trim());

    // Save FTP settings
    this.store.set('ftpHost', (config.ftpHost || '').trim());
    this.store.set('ftpUsername', (config.ftpUsername || '').trim());
    this.store.set('ftpPassword', config.ftpPassword || '');
    this.store.set('ftpRemotePath', (config.ftpRemotePath || '/').trim());
    this.store.set('downloadDirectory', (config.downloadDirectory || '').trim());
    this.store.set('pollingEnabled', Boolean(config.pollingEnabled));
    this.store.set('launchOnStartup', Boolean(config.launchOnStartup));

    // Save S3 settings
    this.store.set('s3Provider', config.s3Provider || 'pixfizz');
    this.store.set('s3BucketName', (config.s3BucketName || '').trim());
    this.store.set('s3Region', (config.s3Region || '').trim());
    this.store.set('s3AccessKeyId', (config.s3AccessKeyId || '').trim());
    this.store.set('s3SecretAccessKey', config.s3SecretAccessKey || '');

    // Save Film Scans settings
    this.store.set('filmScansEnabled', Boolean(config.filmScansEnabled));
    this.store.set('filmScansWatchFolder', (config.filmScansWatchFolder || '').trim());
    this.store.set('filmScansStorageFolder', (config.filmScansStorageFolder || '').trim());

    // Save Film Scans timer settings
    const filmAutoSync = parseInt(config.filmScansAutoSyncMinutes, 10);
    if (!isNaN(filmAutoSync) && filmAutoSync >= 1 && filmAutoSync <= 60) {
      this.store.set('filmScansAutoSyncMinutes', filmAutoSync);
    }
    const filmWatchguard = parseInt(config.filmScansWatchguardMinutes, 10);
    if (!isNaN(filmWatchguard) && filmWatchguard >= 1 && filmWatchguard <= 60) {
      this.store.set('filmScansWatchguardMinutes', filmWatchguard);
    }

    // Save File Uploads settings
    this.store.set('fileUploadsEnabled', Boolean(config.fileUploadsEnabled));
    this.store.set('fileUploadsWatchFolder', (config.fileUploadsWatchFolder || '').trim());
    this.store.set('fileUploadsStorageFolder', (config.fileUploadsStorageFolder || '').trim());

    // Save File Uploads timer settings
    const autoSyncMinutes = parseInt(config.fileUploadsAutoSyncMinutes, 10);
    if (!isNaN(autoSyncMinutes) && autoSyncMinutes >= 1 && autoSyncMinutes <= 60) {
      this.store.set('fileUploadsAutoSyncMinutes', autoSyncMinutes);
    }
    const watchguardMinutes = parseInt(config.fileUploadsWatchguardMinutes, 10);
    if (!isNaN(watchguardMinutes) && watchguardMinutes >= 1 && watchguardMinutes <= 60) {
      this.store.set('fileUploadsWatchguardMinutes', watchguardMinutes);
    }

    // Save polling interval
    const pollingInterval = parseInt(config.pollingInterval, 10);
    if (!isNaN(pollingInterval) && pollingInterval >= 10 && pollingInterval <= 600) {
      this.store.set('pollingInterval', pollingInterval);
    }

    // Save process folder (default)
    this.store.set('processFolderPath', (config.processFolderPath || '').trim());

    // Save DPI Validation settings
    this.store.set('dpiValidationEnabled', Boolean(config.dpiValidationEnabled));

    const dpiExcellent = parseInt(config.dpiExcellentThreshold, 10);
    if (!isNaN(dpiExcellent) && dpiExcellent >= 72 && dpiExcellent <= 1200) {
      this.store.set('dpiExcellentThreshold', dpiExcellent);
    }

    const dpiWarning = parseInt(config.dpiWarningThreshold, 10);
    if (!isNaN(dpiWarning) && dpiWarning >= 72 && dpiWarning <= 1200) {
      this.store.set('dpiWarningThreshold', dpiWarning);
    }
    this.store.set('dpiWarningAllowAutoSubmit', Boolean(config.dpiWarningAllowAutoSubmit));

    const dpiPoor = parseInt(config.dpiPoorThreshold, 10);
    if (!isNaN(dpiPoor) && dpiPoor >= 72 && dpiPoor <= 1200) {
      this.store.set('dpiPoorThreshold', dpiPoor);
    }
    this.store.set('dpiPoorAllowAutoSubmit', Boolean(config.dpiPoorAllowAutoSubmit));

    // Save process folder mappings
    // Supports both legacy string values and new object values { folderPath, controllerId? }
    const mappings = config.processFolderMappings || {};
    const cleanMappings = {};
    for (const [key, val] of Object.entries(mappings)) {
      const trimKey = (key || '').trim();
      if (!trimKey) continue;

      if (typeof val === 'string') {
        // Legacy format: processName -> folderPath
        const trimVal = val.trim();
        if (trimVal) {
          cleanMappings[trimKey] = { folderPath: trimVal };
        }
      } else if (val && typeof val === 'object') {
        // New format: { folderPath, controllerId? }
        const entry = { folderPath: (val.folderPath || '').trim() };
        if (val.controllerId) {
          entry.controllerId = val.controllerId;
        }
        if (entry.folderPath || entry.controllerId) {
          cleanMappings[trimKey] = entry;
        }
      }
    }
    this.store.set('processFolderMappings', cleanMappings);

    return this.getAll();
  }

  /**
   * Get specific configuration value
   */
  get(key) {
    return this.store.get(key);
  }

  /**
   * Set specific configuration value
   */
  set(key, value) {
    this.store.set(key, value);
  }

  /**
   * Check if configuration is complete for FTP + API polling
   */
  isConfigured() {
    const config = this.getAll();
    return !!(
      config.orderhubApiKey &&
      config.ftpHost &&
      config.ftpUsername &&
      config.ftpPassword &&
      config.downloadDirectory
    );
  }

  isModeConfigured(mode) {
    const config = this.getAll();
    if (mode === 'filmScans') {
      return !!(config.filmScansEnabled && config.filmScansWatchFolder && config.s3Endpoint && config.s3BucketName);
    }
    if (mode === 'fileUploads') {
      return !!(config.fileUploadsEnabled && config.fileUploadsWatchFolder && config.s3Endpoint && config.s3BucketName);
    }
    return false;
  }

  /**
   * Get the process mapping for a given process type.
   * Returns { folderPath, controllerId? } or a plain string (backwards compatible).
   */
  getProcessMapping(processType) {
    const mappings = this.store.get('processFolderMappings') || {};
    if (processType && mappings[processType]) {
      const mapping = mappings[processType];
      // Backwards compatible: string → { folderPath }
      if (typeof mapping === 'string') {
        return { folderPath: mapping };
      }
      return mapping;
    }
    // Default: use the default process folder, no controller
    const defaultPath = this.store.get('processFolderPath') || '';
    return { folderPath: defaultPath };
  }

  /**
   * Get the process folder for a given process type (legacy helper).
   * Returns just the folder path string.
   */
  getProcessFolder(processType) {
    const mapping = this.getProcessMapping(processType);
    return mapping.folderPath || '';
  }

  /**
   * Get FTP credentials
   */
  getFtpCredentials() {
    return {
      host: this.store.get('ftpHost'),
      port: this.store.get('ftpPort'),
      user: this.store.get('ftpUsername'),
      password: this.store.get('ftpPassword')
    };
  }

  /**
   * Get OrderHub API settings
   */
  getApiSettings() {
    return {
      baseUrl: OH_API_BASE_URL,
      key: this.store.get('orderhubApiKey'),
      organizationId: this.store.get('organizationId'),
      locationId: this.store.get('locationId')
    };
  }
}

module.exports = new ConfigService();
