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
  // Film Scan AI Rotation (PW-007 Phase 1) — flag-gated, default OFF
  filmScanRotationEnabled: {
    type: 'boolean',
    default: false
  },
  filmScanRotationConfidenceThreshold: {
    type: 'number',
    default: 0.9,
    minimum: 0,
    maximum: 1
  },
  filmScanRotationModelPath: {
    type: 'string',
    default: ''        // empty = use bundled default in resources/models/orientation/
  },
  filmScanRotationDebugLog: {
    type: 'boolean',
    default: false
  },
  // PW-007 M7 — Manual Review mode (legacy; superseded by filmScanReviewMode).
  // Kept in the schema only for migration on first load; no code reads it.
  filmScanManualReview: {
    type: 'boolean',
    default: false
  },
  // PW-007 M9 — Review mode tri-state. Drives whether processed rolls are held
  // back from S3 upload pending operator approval in the Film Review panel.
  //   'never'  — Auto: rotate then upload immediately.
  //   'smart'  — Smart Check: rotate, then defer upload only if the roll has
  //              any low-confidence frame (confidence < threshold) OR any
  //              rotation-error frame. Confident rolls upload immediately.
  //   'always' — Manual: every roll waits for operator approval.
  // Forced to no-op when filmScanRotationEnabled is false — the panel only
  // surfaces rolls that have AI metadata to review.
  filmScanReviewMode: {
    type: 'string',
    enum: ['never', 'smart', 'always'],
    default: 'never'
  },
  // One-shot flag used by the constructor to migrate old filmScanManualReview
  // values into filmScanReviewMode exactly once. Internal — not surfaced in UI.
  _filmScanReviewModeMigrated: {
    type: 'boolean',
    default: false
  },
  // AI Quality Gate (v1.2.0) — flag-gated, default OFF.
  // When ON, every image in every Mode-1 job is scored by MUSIQ before the
  // job is dispatched. Jobs with any image scoring below the threshold are
  // held for operator review. See docs/phase-1-implementation-plan-ai-quality.md.
  aiQualityEnabled: {
    type: 'boolean',
    default: false
  },
  // Held-state semantics for sub-threshold images:
  //   'warn'  — score every image, write per-image sidecars (passed: false for
  //             sub-threshold), but do NOT hold the job. Auto-print and manual
  //             print proceed normally. Operators see scores in the UI but
  //             nothing blocks routing. This is the v1.2.0 default — we want
  //             the field data from production scoring before flipping the
  //             gate to 'block'.
  //   'block' — sub-threshold images set held=true on the job. Auto-print is
  //             blocked and the job appears in Quality Review until the
  //             operator approves-as-is or fixes the offending images.
  // Shipped installs default to 'warn'. Operators can flip to 'block' once
  // they've reviewed enough scoring data to trust the threshold.
  aiQualityMode: {
    type: 'string',
    enum: ['warn', 'block'],
    default: 'warn'
  },
  // Default lowered from 75 to 50 based on empirical data from
  // PXDEMO-721XH7 / PXDEMO-PT7HM2 — score distribution clusters 60-75
  // for typical phone uploads with bad-quality tail at 36-45;
  // threshold 50 cleanly separates the tail without rejecting the
  // typical bulk.
  aiQualityThreshold: {
    type: 'number',
    default: 50,
    minimum: 1,
    maximum: 100
  },
  aiQualityModelPath: {
    type: 'string',
    default: ''        // empty = use bundled default in resources/models/musiq/
  },
  aiQualityDebugLog: {
    type: 'boolean',
    default: false
  },
  // Debug-only override. When non-zero, scoring returns this fixed value
  // instead of running real MUSIQ inference. Useful for testing the held-job
  // path without needing to find a deliberately-bad image. Operators should
  // never set this in production — there's no UI for it.
  aiQualityForceScore: {
    type: 'number',
    default: 0,
    minimum: 0,
    maximum: 100
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
  // AI Enhancement (Phase 3+)
  enhancementProvider: {
    type: 'string',
    default: 'local'
  },
  enhancementDefaultModel: {
    type: 'string',
    default: 'Standard V2'
  },
  enhancementFaceEnhancement: {
    type: 'boolean',
    default: false
  },
  enhancementAutoEnhance: {
    type: 'boolean',
    default: false
  },
  // Topaz Direct provider
  topazApiKey: {
    type: 'string',
    default: ''
  },
  topazDefaultModel: {
    type: 'string',
    default: 'Standard V2'
  },
  // Pixfizz AI Enhancement (local Real-ESRGAN). Tile-size and overlap are
  // exposed for field-engineer tuning but normally untouched. Defaults
  // are settled per Phase 1 plan §0.10 (256² with 16 px overlap).
  enhancementLocalTileSize: {
    type: 'number',
    default: 256,
    minimum: 64,
    maximum: 1024
  },
  enhancementLocalTileOverlap: {
    type: 'number',
    default: 16,
    minimum: 0,
    maximum: 255
  },
  // Run a MUSIQ rescore before and after every enhancement (any provider)
  // and write scoreBefore/scoreAfter into the per-image sidecar entry.
  // Default true on fresh installs and at upgrade-time per plan §0.6.
  enhancementRescoreAfter: {
    type: 'boolean',
    default: true
  },
  dismissedJobs: {
    type: 'array',
    default: []
  },
  jobDateRange: {
    type: 'number',
    default: 30
  },
  // One-shot migration marker for the v1.3.2 integrity-quarantine pivot.
  // Set to an ISO 8601 timestamp on first successful run of
  // runIntegrityQuarantineMigration(). Once set, the migration is skipped
  // on every subsequent launch. NEVER cleared by code — clearing is a
  // manual operator action (delete the key from config.json) if a re-run
  // is ever needed. See src/main/services/integrity-quarantine-migration.js.
  _integrityQuarantineMigratedAt: {
    type: ['string', 'null'],
    default: null
  },
  // One-shot migration marker for the Phase 1 local-enhancement release —
  // removes the legacy Replicate provider. Set to an ISO 8601 timestamp on
  // first launch with a Replicate-era config; cleared NEVER (same convention
  // as _integrityQuarantineMigratedAt above). Acts as the idempotency guard
  // for _migrateReplicateProvider().
  _replicateProviderMigratedAt: {
    type: ['string', 'null'],
    default: null
  },
  // One-shot toast trigger: set to true by _migrateReplicateProvider() when
  // an actual replicate→local rewrite happened (i.e. the operator was using
  // Replicate before the upgrade). Renderer reads it on launch, shows a
  // dismissable toast once, and calls ohd:config:clear-migration-toast to
  // flip it back to false. Default false so fresh installs and Topaz-only
  // installs never see the toast.
  _migratedFromReplicate: {
    type: 'boolean',
    default: false
  }
};

class ConfigService {
  constructor() {
    this.store = new Store({
      schema,
      // Strip leading UTF-8 BOM if present. PowerShell, Notepad, and various
      // Windows editors default to writing UTF-8 with BOM; electron-store's
      // conf library doesn't strip BOMs and crashes on JSON.parse. This
      // bricked the app during v1.3.2 development when a config flag was
      // edited via PowerShell `Set-Content -Encoding UTF8`. Defensive read
      // prevents the failure mode that bit during dev from biting customers
      // in production.
      deserialize: (raw) => {
        if (raw.charCodeAt(0) === 0xFEFF) {
          raw = raw.slice(1);
        }
        return JSON.parse(raw);
      },
    });
    this._migrateReviewMode();
    this._migrateReplicateProvider();
  }

  /**
   * One-shot migration from the old `filmScanManualReview` boolean to the new
   * `filmScanReviewMode` enum. Runs once per install — guarded by an internal
   * `_filmScanReviewModeMigrated` flag so subsequent UI saves don't get
   * stomped. If the user previously enabled Manual Rotation Check, they land
   * in 'always' mode; otherwise 'never' (== old default behavior).
   */
  _migrateReviewMode() {
    if (this.store.get('_filmScanReviewModeMigrated')) return;
    const legacy = this.store.get('filmScanManualReview');
    if (legacy === true) {
      this.store.set('filmScanReviewMode', 'always');
    }
    this.store.set('_filmScanReviewModeMigrated', true);
  }

  /**
   * One-shot migration: remove the legacy Replicate provider from config.
   *
   *   - If `enhancementProvider === 'replicate'`, rewrite to 'local' and set
   *     the `_migratedFromReplicate` flag so the renderer shows the
   *     post-upgrade toast exactly once.
   *   - Always strip the `replicateApiKey` key from disk (orphan key on
   *     installs that switched to Topaz before the upgrade — no functional
   *     impact, but keeps the on-disk config tidy).
   *   - Stamp `_replicateProviderMigratedAt` so we never run again.
   *
   * The defensive remap in enhancementManager.getProvider() stays in place
   * as a defence-in-depth no-op for any rare config that bypasses this path
   * (e.g. a config file hand-edited back to 'replicate' between launches).
   */
  _migrateReplicateProvider() {
    if (this.store.get('_replicateProviderMigratedAt')) return;

    const provider = this.store.get('enhancementProvider');
    const wasReplicate = provider === 'replicate';

    if (wasReplicate) {
      this.store.set('enhancementProvider', 'local');
      this.store.set('_migratedFromReplicate', true);
    }

    // electron-store .delete() is a no-op for keys that don't exist on disk,
    // so this is safe regardless of whether the key was ever populated.
    try {
      this.store.delete('replicateApiKey');
    } catch (_) { /* ignore */ }

    this.store.set('_replicateProviderMigratedAt', new Date().toISOString());

    // Single line of telemetry — a future support investigation may need
    // to know which installs traversed the Replicate→local boundary.
    // eslint-disable-next-line no-console
    console.log(
      `[config-migration] replicate-provider migration done ` +
      `(wasReplicate=${wasReplicate}, replicateApiKeyDeleted=true)`
    );
  }

  /**
   * Called by the renderer once it has rendered (and dismissed, or simply
   * displayed) the post-upgrade Replicate-removal toast. Flips the
   * one-shot flag so the toast doesn't re-show on subsequent launches.
   */
  clearReplicateMigrationToast() {
    this.store.set('_migratedFromReplicate', false);
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
      // Film Scan AI Rotation
      filmScanRotationEnabled: this.store.get('filmScanRotationEnabled'),
      filmScanRotationConfidenceThreshold: this.store.get('filmScanRotationConfidenceThreshold'),
      filmScanRotationModelPath: this.store.get('filmScanRotationModelPath'),
      filmScanRotationDebugLog: this.store.get('filmScanRotationDebugLog'),
      filmScanReviewMode: this.store.get('filmScanReviewMode'),
      // AI Quality Gate
      aiQualityEnabled: this.store.get('aiQualityEnabled'),
      aiQualityMode: this.store.get('aiQualityMode'),
      aiQualityThreshold: this.store.get('aiQualityThreshold'),
      aiQualityModelPath: this.store.get('aiQualityModelPath'),
      aiQualityDebugLog: this.store.get('aiQualityDebugLog'),
      aiQualityForceScore: this.store.get('aiQualityForceScore'),
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
      // AI Enhancement
      enhancementProvider: this.store.get('enhancementProvider'),
      enhancementDefaultModel: this.store.get('enhancementDefaultModel'),
      enhancementFaceEnhancement: this.store.get('enhancementFaceEnhancement'),
      enhancementAutoEnhance: this.store.get('enhancementAutoEnhance'),
      topazApiKey: this.store.get('topazApiKey'),
      topazDefaultModel: this.store.get('topazDefaultModel'),
      enhancementLocalTileSize: this.store.get('enhancementLocalTileSize'),
      enhancementLocalTileOverlap: this.store.get('enhancementLocalTileOverlap'),
      enhancementRescoreAfter: this.store.get('enhancementRescoreAfter'),
      // One-shot toast trigger consumed by the renderer; cleared via
      // clearReplicateMigrationToast() once the toast has been shown.
      _migratedFromReplicate: this.store.get('_migratedFromReplicate'),
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

    // Save Film Scan AI Rotation settings — these keys have no dedicated UI yet,
    // so only write them when the caller explicitly passes them. Otherwise an
    // unrelated settings save (e.g. from the Film Scans tab which doesn't know
    // about these keys) would silently reset them to defaults (flag -> false, etc).
    if (Object.prototype.hasOwnProperty.call(config, 'filmScanRotationEnabled')) {
      this.store.set('filmScanRotationEnabled', Boolean(config.filmScanRotationEnabled));
    }
    if (Object.prototype.hasOwnProperty.call(config, 'filmScanRotationConfidenceThreshold')) {
      const confThreshold = parseFloat(config.filmScanRotationConfidenceThreshold);
      if (!isNaN(confThreshold) && confThreshold >= 0 && confThreshold <= 1) {
        this.store.set('filmScanRotationConfidenceThreshold', confThreshold);
      }
    }
    if (Object.prototype.hasOwnProperty.call(config, 'filmScanRotationModelPath')) {
      this.store.set('filmScanRotationModelPath', (config.filmScanRotationModelPath || '').trim());
    }
    if (Object.prototype.hasOwnProperty.call(config, 'filmScanRotationDebugLog')) {
      this.store.set('filmScanRotationDebugLog', Boolean(config.filmScanRotationDebugLog));
    }
    if (Object.prototype.hasOwnProperty.call(config, 'aiQualityEnabled')) {
      this.store.set('aiQualityEnabled', Boolean(config.aiQualityEnabled));
    }
    if (Object.prototype.hasOwnProperty.call(config, 'aiQualityMode')) {
      const mode = String(config.aiQualityMode);
      if (mode === 'warn' || mode === 'block') {
        this.store.set('aiQualityMode', mode);
      }
    }
    if (Object.prototype.hasOwnProperty.call(config, 'aiQualityThreshold')) {
      const t = parseInt(config.aiQualityThreshold, 10);
      if (!isNaN(t) && t >= 1 && t <= 100) {
        this.store.set('aiQualityThreshold', t);
      }
    }
    if (Object.prototype.hasOwnProperty.call(config, 'aiQualityModelPath')) {
      this.store.set('aiQualityModelPath', (config.aiQualityModelPath || '').trim());
    }
    if (Object.prototype.hasOwnProperty.call(config, 'aiQualityDebugLog')) {
      this.store.set('aiQualityDebugLog', Boolean(config.aiQualityDebugLog));
    }
    if (Object.prototype.hasOwnProperty.call(config, 'aiQualityForceScore')) {
      const f = parseInt(config.aiQualityForceScore, 10);
      if (!isNaN(f) && f >= 0 && f <= 100) {
        this.store.set('aiQualityForceScore', f);
      }
    }
    if (Object.prototype.hasOwnProperty.call(config, 'filmScanReviewMode')) {
      const mode = String(config.filmScanReviewMode);
      if (mode === 'never' || mode === 'smart' || mode === 'always') {
        this.store.set('filmScanReviewMode', mode);
      }
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

    // Save AI Enhancement settings
    this.store.set('enhancementProvider', config.enhancementProvider || 'local');
    this.store.set('enhancementDefaultModel', config.enhancementDefaultModel || 'Standard V2');
    this.store.set('enhancementFaceEnhancement', Boolean(config.enhancementFaceEnhancement));
    this.store.set('enhancementAutoEnhance', Boolean(config.enhancementAutoEnhance));
    this.store.set('topazApiKey', config.topazApiKey || '');
    this.store.set('topazDefaultModel', config.topazDefaultModel || 'Standard V2');
    if (Number.isInteger(config.enhancementLocalTileSize)) {
      this.store.set('enhancementLocalTileSize', config.enhancementLocalTileSize);
    }
    if (Number.isInteger(config.enhancementLocalTileOverlap)) {
      this.store.set('enhancementLocalTileOverlap', config.enhancementLocalTileOverlap);
    }
    if (typeof config.enhancementRescoreAfter === 'boolean') {
      this.store.set('enhancementRescoreAfter', config.enhancementRescoreAfter);
    }

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
