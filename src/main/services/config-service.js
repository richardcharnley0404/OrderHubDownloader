const Store = require('electron-store');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// Hardcoded OrderHub API base URL (not user-configurable)
const OH_API_BASE_URL = 'https://nazkcvruighrhpgcarxg.supabase.co/functions/v1/ohd-api';

// ----- Internal helpers (module-level so they're testable in isolation) -----

/**
 * Generate a stable identifier for a hot folder row. Used when the operator
 * adds a new row without supplying an id. Uses crypto.randomUUID() when
 * available (Node 14.17+) and falls back to a hex string.
 */
function _genHotFolderId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Returns true when `child` is the same as `parent` or sits inside it.
 * Path comparison is case-insensitive (Windows-friendly) and uses
 * path.relative so trailing-slash variants don't confuse it.
 *
 * Both arguments are expected to be already lowercased by the caller.
 */
function _pathContains(parent, child) {
  if (!parent || !child) return false;
  if (parent === child) return true;
  // path.relative('C:/foo', 'C:/foo/bar') = 'bar'  → child is inside parent
  // path.relative('C:/foo', 'C:/baz')     = '..\\baz' → not inside
  // path.relative('C:/foo', 'D:/foo')     = 'D:/foo' (with absolute prefix)
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Perfectly Clear QuickServer helpers
// ---------------------------------------------------------------------------

const PC_SCOPES = Object.freeze(['jobs', 'filmScans', 'fileUploads']);
const PC_SCOPE_LABELS = Object.freeze({
  jobs:        'Jobs',
  filmScans:   'Film Scans',
  fileUploads: 'File Uploads',
});

function _pcScopeDefault() {
  return { enabled: false, autoApplyConfigId: null, configs: [] };
}

/**
 * Normalise a `perfectlyClear` value into the canonical shape so downstream
 * validation + persistence can trust the structure. Missing scopes are
 * defaulted; missing config fields are coerced to strings; `configs` is
 * always an array; `autoApplyConfigId` is null when it doesn't match an id
 * in the same scope's configs. Never throws — validation is a separate step.
 */
function _sanitisePerfectlyClear(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const scope of PC_SCOPES) {
    const scopeSrc = (src[scope] && typeof src[scope] === 'object') ? src[scope] : {};
    const configsSrc = Array.isArray(scopeSrc.configs) ? scopeSrc.configs : [];
    const configs = configsSrc
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        id:              typeof c.id === 'string' && c.id ? c.id : _genHotFolderId(),
        friendlyName:    typeof c.friendlyName    === 'string' ? c.friendlyName.trim()    : '',
        inputFolder:     typeof c.inputFolder     === 'string' ? c.inputFolder.trim()     : '',
        outputFolder:    typeof c.outputFolder    === 'string' ? c.outputFolder.trim()    : '',
        rejectedFolder:  typeof c.rejectedFolder  === 'string' ? c.rejectedFolder.trim()  : '',
      }));
    const knownIds = new Set(configs.map((c) => c.id));
    const rawAutoId = scopeSrc.autoApplyConfigId;
    const autoApplyConfigId = (typeof rawAutoId === 'string' && knownIds.has(rawAutoId)) ? rawAutoId : null;
    out[scope] = {
      enabled: Boolean(scopeSrc.enabled),
      autoApplyConfigId,
      configs,
    };
  }
  return out;
}

/**
 * Validate a sanitised `perfectlyClear` value against the M1 rules:
 *   - enabled scope needs ≥1 config
 *   - every config needs friendlyName + all three folders
 *   - inputFolder unique across ALL scopes' configs
 *   - outputFolder/rejectedFolder must NOT be path-prefixed by ANY inputFolder
 *   - all three folders must exist on disk (existence-only, no write probe —
 *     hot folders often live on SMB and a write probe can be expensive)
 *
 * Throws Error with an operator-readable message on the first failure.
 * A caller that wants "collect all errors" behaviour would extend this;
 * "fail fast, name the offending row" is the shape we want for M1.
 *
 * @param {object} pc - Value returned by _sanitisePerfectlyClear.
 * @param {object} [opts]
 * @param {(p: string) => boolean} [opts.existsSync] - Injectable for tests.
 */
function _validatePerfectlyClear(pc, opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;

  // Pass 1: per-scope shape checks (before uniqueness/prefix so we bail
  // early on completely-empty rows the operator hasn't finished typing).
  for (const scope of PC_SCOPES) {
    const { enabled, configs } = pc[scope];
    if (enabled && configs.length === 0) {
      throw new Error(`Perfectly Clear "${PC_SCOPE_LABELS[scope]}" is enabled but has no configurations. Add at least one, or turn the scope off.`);
    }
    for (let i = 0; i < configs.length; i++) {
      const c = configs[i];
      const rowLabel = `${PC_SCOPE_LABELS[scope]} row ${i + 1}${c.friendlyName ? ` (${c.friendlyName})` : ''}`;
      if (!c.friendlyName)   throw new Error(`${rowLabel}: friendly name is required.`);
      if (!c.inputFolder)    throw new Error(`${rowLabel}: input folder is required.`);
      if (!c.outputFolder)   throw new Error(`${rowLabel}: output folder is required.`);
      if (!c.rejectedFolder) throw new Error(`${rowLabel}: rejected folder is required.`);
    }
  }

  // Pass 2: input-folder uniqueness across all scopes (case-insensitive).
  // Mirrors QuickServer's own channel rule — two channels can't watch the
  // same input directory. Enforced across scopes so Jobs and Film Scans
  // can't accidentally share a channel.
  const seenInputs = new Map(); // lowercased path → "Scope row N (name)"
  const allInputs = []; // {lower, original}
  for (const scope of PC_SCOPES) {
    for (let i = 0; i < pc[scope].configs.length; i++) {
      const c = pc[scope].configs[i];
      const lower = c.inputFolder.toLowerCase();
      const rowLabel = `${PC_SCOPE_LABELS[scope]} row ${i + 1}${c.friendlyName ? ` (${c.friendlyName})` : ''}`;
      if (seenInputs.has(lower)) {
        throw new Error(`${rowLabel}: input folder "${c.inputFolder}" is already used by ${seenInputs.get(lower)}. Each Perfectly Clear config needs its own input folder (QuickServer forbids two channels watching the same directory).`);
      }
      seenInputs.set(lower, rowLabel);
      allInputs.push({ lower, original: c.inputFolder, rowLabel });
    }
  }

  // Pass 3: output/rejected must not sit under ANY inputFolder. Prevents
  // OHD-created inputs from being ingested by the same-or-another channel
  // as their own output, which would loop the file.
  for (const scope of PC_SCOPES) {
    for (let i = 0; i < pc[scope].configs.length; i++) {
      const c = pc[scope].configs[i];
      const rowLabel = `${PC_SCOPE_LABELS[scope]} row ${i + 1}${c.friendlyName ? ` (${c.friendlyName})` : ''}`;
      for (const { lower, original, rowLabel: inputRow } of allInputs) {
        if (_pathContains(lower, c.outputFolder.toLowerCase())) {
          throw new Error(`${rowLabel}: output folder "${c.outputFolder}" sits inside input folder "${original}" (${inputRow}). Output must be outside every input to avoid an ingestion loop.`);
        }
        if (_pathContains(lower, c.rejectedFolder.toLowerCase())) {
          throw new Error(`${rowLabel}: rejected folder "${c.rejectedFolder}" sits inside input folder "${original}" (${inputRow}). Rejected must be outside every input to avoid an ingestion loop.`);
        }
      }
    }
  }

  // Pass 4: existence on disk. Deferred until last so the earlier
  // structural errors surface first — a folder that doesn't exist is less
  // useful feedback if the operator hasn't set a friendly name yet.
  for (const scope of PC_SCOPES) {
    for (let i = 0; i < pc[scope].configs.length; i++) {
      const c = pc[scope].configs[i];
      const rowLabel = `${PC_SCOPE_LABELS[scope]} row ${i + 1}${c.friendlyName ? ` (${c.friendlyName})` : ''}`;
      for (const [label, folder] of [['input', c.inputFolder], ['output', c.outputFolder], ['rejected', c.rejectedFolder]]) {
        if (!existsSync(folder)) {
          throw new Error(`${rowLabel}: ${label} folder "${folder}" does not exist on disk. Create it in QuickServer or on the target share before saving.`);
        }
      }
    }
  }
}

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
  // When ON, a printer-driven folder rename o→e (DPOF "accepted") triggers a
  // POST to {baseUrl}/jobs/{jobId}/completed and marks the job locally
  // completed. Default OFF — staging-only until validated; toggle via
  // electron-store / devtools, no UI yet.
  autoCompleteOnPrinterAccept: {
    type: 'boolean',
    default: false
  },
  // How long (ms) a job's order folder may exist with image files but no
  // {orderNumber}.json manifest before polling-service escalates the job to
  // _status:'error'. Default 10 minutes — 20× safety margin over typical
  // FTP/S3 manifest-arrival windows. Keeps the job dispatchable (status
  // 'pending' + _awaitingManifest flag) for the duration; the bounded
  // escalation stops jobs sitting awaiting forever.
  awaitingManifestTimeoutMs: {
    type: 'number',
    default: 600000,
    minimum: 0
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
  // Optional scanner source folder. When set, OHD COPIES new/changed folders
  // from here into the watch folder and NEVER deletes or modifies anything in
  // here — it stays the lab's pristine archive. Empty = feature off (the watch
  // folder is fed directly, as before).
  filmScansSourceFolder: {
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
  // Film Review history retention. Reviewed/uploaded rolls are dropped from
  // the Film tab's history (metadata + thumbnail cache only — NEVER the scan
  // files in the permanent storage folder) once they are older than this many
  // days. 0 = keep forever.
  filmScansRetentionDays: {
    type: 'number',
    default: 30,
    minimum: 0,
    maximum: 3650
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
  // Film Development Auto Assignment Mode. When enabled every scan roll is
  // held at Step 3 (S3 upload) until a Film Development job with a matching
  // Twin Check ID arrives from OrderHub, at which point the matcher uploads
  // it automatically. Wholly inert when false — no code path changes for
  // existing installs. Requires job polling to be reachable (matcher does
  // its own direct fetchJobs when pollingEnabled is off).
  filmScanAutoAssignEnabled: {
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
  // Order XML Hot Folder (Mode 4)
  // Watches one or more folders for vendor order XML drops (PhotoFinale today;
  // ROES / dotphoto via the parser registry later) and submits them to
  // OrderHub via POST /api-webhook. Each entry in `orderXmlHotFolders` is one
  // independent watcher with its own format, paths, and websiteCode.
  orderXmlEnabled: {
    type: 'boolean',
    default: false
  },
  orderXmlAutoSyncMinutes: {
    type: 'number',
    default: 1,
    minimum: 1,
    maximum: 60
  },
  // Default retry cap shared across all hot folders. Each folder may override
  // via its own `maxRetries`. Retries apply only to transient (5xx / network)
  // failures; 4xx errors route straight to failed/.
  orderXmlMaxRetries: {
    type: 'number',
    default: 3,
    minimum: 1,
    maximum: 10
  },
  // Array of hot folder configs. Schema enforced loosely here (electron-store
  // can't express the inner shape without a JSON schema for objects); strict
  // shape validation is done in save().
  //
  // Per-entry shape:
  //   {
  //     id:              string (uuid, stable identifier),
  //     label:           string (operator-chosen name, e.g. 'PhotoFinale F-11'),
  //     enabled:         boolean,
  //     sourceFormat:    string (parser id from order-xml-parsers registry),
  //     watchFolder:     string (absolute path to drop folder),
  //     processedFolder: string (absolute path to root of processed/failed/),
  //     websiteCode:     string (OrderHub website_code, e.g. 'PPPF'; may be ''),
  //     maxRetries:      number|null (null = inherit orderXmlMaxRetries)
  //   }
  orderXmlHotFolders: {
    type: 'array',
    default: []
  },
  // Vendor product code → Pixfizz product code mapping, scoped per parser
  // sourceFormat. OrderHub today accepts any string as `product_code` and
  // creates a generic line item — without this gate, unmapped PhotoFinale
  // codes silently end up in OrderHub as orphan items. The watcher loads the
  // matching slice into a Map and threads it through hotFolderConfig.productMap;
  // the parser throws UNMAPPED_PRODUCTS for any line item whose vendor code
  // isn't present, holding the whole order back.
  //
  // Shape:
  //   {
  //     [sourceFormat]: [
  //       { photoFinaleCode: string, pixfizzCode: string, label: string }
  //     ]
  //   }
  // Only the photofinale slice is populated today; ROES / dotphoto get their
  // own keys when those parsers ship. 1:1 (each vendor code resolves to
  // exactly one Pixfizz product); duplicate vendor codes within a slice are
  // rejected at save time.
  orderXmlProductMappings: {
    type: 'object',
    default: {}
  },
  // Customer directory used by the Order XML pipeline. PhotoFinale's XML carries
  // a per-tenant RetailerDealerCode but no customer email — without a lookup
  // table here we'd be submitting the cardholder's name from the XML against
  // the lab's own customer record on OrderHub. Each record maps a Customer ID
  // (matched against RetailerDealerCode) to the Customer Name + Email that
  // should be sent in OrderInput.customer_name / customer_email instead.
  //
  // Shape: [{ customerId: string, customerName: string, customerEmail: string }]
  // Lookup is case-insensitive on customerId. No match → parser throws
  // CUSTOMER_NOT_FOUND and the watcher routes the order to failed/ so the
  // operator can add the missing customer and retry.
  orderXmlCustomers: {
    type: 'array',
    default: []
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
  // ─── Perfectly Clear QuickServer integration (M1, 2026-07-03) ──────────────
  // Single structured key for all three scopes (Jobs, Film Scans, File Uploads)
  // rather than a dozen flat keys — mirrors the printControllers pattern.
  // See docs/perfectly-clear-quickserver-implementation-plan.md.
  //
  // Per scope:
  //   enabled            — master toggle; when true, ≥1 config required.
  //   autoApplyConfigId  — id of the default config to auto-apply. Jobs is
  //                        manual-only by decision; the field is kept for
  //                        shape symmetry but never surfaced in the Jobs UI.
  //   configs[]          — array of { id, friendlyName, inputFolder,
  //                        outputFolder, rejectedFolder }, matching a
  //                        QuickServer channel.
  //
  // Non-sensitive → rides along in backup-service snapshots automatically
  // (backup reads the raw config.json; only SECRET_KEYS are stripped).
  perfectlyClear: {
    type: 'object',
    default: {
      jobs:        { enabled: false, autoApplyConfigId: null, configs: [] },
      filmScans:   { enabled: false, autoApplyConfigId: null, configs: [] },
      fileUploads: { enabled: false, autoApplyConfigId: null, configs: [] },
    }
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
  },
  // ===========================================================================
  // Backup & Restore (v1.6+) — non-sensitive configuration snapshots to a
  // network share. See docs/backup-restore.md and backup-service.js.
  // ===========================================================================
  backupEnabled: {
    type: 'boolean',
    default: false
  },
  // UNC, local, or mapped-drive path. Empty until operator configures.
  backupFolderPath: {
    type: 'string',
    default: ''
  },
  // Customer directory (orderXmlCustomers) is PII; included by default but
  // operators can opt out per-lab.
  backupIncludeCustomerDirectory: {
    type: 'boolean',
    default: true
  },
  // ISO 8601 of last successful backup. Drives the >24h "daily" trigger.
  backupLastRunAt: {
    type: ['string', 'null'],
    default: null
  },
  // Last error message from a failed backup. Cleared on next success. Surfaced
  // in the Settings UI so operators can see why automatic backups are silent.
  backupLastError: {
    type: ['string', 'null'],
    default: null
  },
  // Persistent UUID for this install. Set once by _ensureMachineId() in the
  // constructor; never overwritten by save(). Survives a Windows rename but
  // intentionally does NOT survive a reinstall — that's the signal the
  // collision check in backup-service.js uses to detect "another PC is using
  // this hostname's subfolder".
  _machineId: {
    type: 'string',
    default: ''
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
    this._ensureMachineId();
  }

  /**
   * Generate a persistent UUID for this install on first launch. Used by the
   * backup-service collision check to distinguish "same PC re-running" from
   * "different PC pointing at the same hostname subfolder on the share".
   *
   * Idempotent — only writes if the key is empty. NEVER overwrites an existing
   * value, otherwise a routine config save could invalidate every backup ever
   * written by this install.
   */
  _ensureMachineId() {
    if (this.store.get('_machineId')) return;
    this.store.set('_machineId', crypto.randomUUID());
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
      filmScansSourceFolder: this.store.get('filmScansSourceFolder'),
      filmScansStorageFolder: this.store.get('filmScansStorageFolder'),
      filmScansAutoSyncMinutes: this.store.get('filmScansAutoSyncMinutes'),
      filmScansWatchguardMinutes: this.store.get('filmScansWatchguardMinutes'),
      filmScansRetentionDays: this.store.get('filmScansRetentionDays'),
      // Film Scan AI Rotation
      filmScanRotationEnabled: this.store.get('filmScanRotationEnabled'),
      filmScanRotationConfidenceThreshold: this.store.get('filmScanRotationConfidenceThreshold'),
      filmScanRotationModelPath: this.store.get('filmScanRotationModelPath'),
      filmScanRotationDebugLog: this.store.get('filmScanRotationDebugLog'),
      filmScanReviewMode: this.store.get('filmScanReviewMode'),
      filmScanAutoAssignEnabled: this.store.get('filmScanAutoAssignEnabled'),
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
      // Order XML Hot Folders (Mode 4)
      orderXmlEnabled: this.store.get('orderXmlEnabled'),
      orderXmlAutoSyncMinutes: this.store.get('orderXmlAutoSyncMinutes'),
      orderXmlMaxRetries: this.store.get('orderXmlMaxRetries'),
      orderXmlHotFolders: this.store.get('orderXmlHotFolders') || [],
      orderXmlProductMappings: this.store.get('orderXmlProductMappings') || {},
      orderXmlCustomers: this.store.get('orderXmlCustomers') || [],
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
      // Perfectly Clear QuickServer (M1). Sanitised on read so the renderer
      // always sees the canonical three-scope shape even if the on-disk value
      // is missing a scope (e.g. mid-upgrade or hand-edited config.json).
      perfectlyClear: _sanitisePerfectlyClear(this.store.get('perfectlyClear')),
      // One-shot toast trigger consumed by the renderer; cleared via
      // clearReplicateMigrationToast() once the toast has been shown.
      _migratedFromReplicate: this.store.get('_migratedFromReplicate'),
      // Backup & Restore
      backupEnabled: this.store.get('backupEnabled'),
      backupFolderPath: this.store.get('backupFolderPath'),
      backupIncludeCustomerDirectory: this.store.get('backupIncludeCustomerDirectory'),
      backupLastRunAt: this.store.get('backupLastRunAt'),
      backupLastError: this.store.get('backupLastError'),
      // _machineId is read-only — exposed for diagnostics + Settings UI display
      _machineId: this.store.get('_machineId'),
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
    this.store.set('filmScansSourceFolder', (config.filmScansSourceFolder || '').trim());
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
    // Film Review history retention (days). 0 = keep forever. Only written when
    // the caller passes the key, so an unrelated save can't reset it.
    if (Object.prototype.hasOwnProperty.call(config, 'filmScansRetentionDays')) {
      const retentionDays = parseInt(config.filmScansRetentionDays, 10);
      if (!isNaN(retentionDays) && retentionDays >= 0 && retentionDays <= 3650) {
        this.store.set('filmScansRetentionDays', retentionDays);
      }
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
    if (Object.prototype.hasOwnProperty.call(config, 'filmScanAutoAssignEnabled')) {
      this.store.set('filmScanAutoAssignEnabled', Boolean(config.filmScanAutoAssignEnabled));
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

    // Save Order XML Hot Folder settings (Mode 4)
    // Validation + sanitisation happens in _sanitiseOrderXmlHotFolders so the
    // schema stays simple and the rules stay testable in one place.
    this.store.set('orderXmlEnabled', Boolean(config.orderXmlEnabled));
    const orderXmlAutoSync = parseInt(config.orderXmlAutoSyncMinutes, 10);
    if (!isNaN(orderXmlAutoSync) && orderXmlAutoSync >= 1 && orderXmlAutoSync <= 60) {
      this.store.set('orderXmlAutoSyncMinutes', orderXmlAutoSync);
    }
    const orderXmlRetries = parseInt(config.orderXmlMaxRetries, 10);
    if (!isNaN(orderXmlRetries) && orderXmlRetries >= 1 && orderXmlRetries <= 10) {
      this.store.set('orderXmlMaxRetries', orderXmlRetries);
    }
    if (Array.isArray(config.orderXmlHotFolders)) {
      const sanitised = this._sanitiseOrderXmlHotFolders(
        config.orderXmlHotFolders,
        Boolean(config.orderXmlEnabled)
      );
      this.store.set('orderXmlHotFolders', sanitised);
    }
    if (config.orderXmlProductMappings && typeof config.orderXmlProductMappings === 'object') {
      const sanitised = this._sanitiseOrderXmlProductMappings(config.orderXmlProductMappings);
      this.store.set('orderXmlProductMappings', sanitised);
    }
    if (Array.isArray(config.orderXmlCustomers)) {
      const sanitised = this._sanitiseOrderXmlCustomers(config.orderXmlCustomers);
      this.store.set('orderXmlCustomers', sanitised);
    }

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

    // Perfectly Clear QuickServer settings. hasOwnProperty guard so panels
    // that don't know about this key (e.g. a Backup restore that only
    // rewrites the OrderHub API slice) can't silently nuke it.
    if (Object.prototype.hasOwnProperty.call(config, 'perfectlyClear')) {
      const sanitised = _sanitisePerfectlyClear(config.perfectlyClear);
      _validatePerfectlyClear(sanitised);
      this.store.set('perfectlyClear', sanitised);
    }

    // Backup & Restore settings. `_machineId` is intentionally NOT writable from
    // here — it is set exactly once by _ensureMachineId() at first launch.
    // Each backup* key uses `hasOwnProperty` so panels that don't know about
    // these keys can save their own slice without resetting these to defaults.
    if (Object.prototype.hasOwnProperty.call(config, 'backupEnabled')) {
      this.store.set('backupEnabled', Boolean(config.backupEnabled));
    }
    if (Object.prototype.hasOwnProperty.call(config, 'backupFolderPath')) {
      this.store.set('backupFolderPath', (config.backupFolderPath || '').trim());
    }
    if (Object.prototype.hasOwnProperty.call(config, 'backupIncludeCustomerDirectory')) {
      this.store.set('backupIncludeCustomerDirectory', Boolean(config.backupIncludeCustomerDirectory));
    }
    // backupLastRunAt / backupLastError are written by backup-service, not the
    // settings panel, but we still tolerate them being round-tripped through
    // save() via getAll() so callers that re-save the full object don't
    // accidentally null them out.
    if (Object.prototype.hasOwnProperty.call(config, 'backupLastRunAt')) {
      const v = config.backupLastRunAt;
      if (v === null || typeof v === 'string') this.store.set('backupLastRunAt', v);
    }
    if (Object.prototype.hasOwnProperty.call(config, 'backupLastError')) {
      const v = config.backupLastError;
      if (v === null || typeof v === 'string') this.store.set('backupLastError', v);
    }

    // Fire-and-forget daily-trigger hook. A successful save that happens after
    // the >24h window will produce a snapshot in the background. Lazy require
    // to avoid a circular import (backup-service depends on configService).
    // Wrapped in try/catch so a broken backup module never breaks save().
    try {
      if (this.store.get('backupEnabled') && this.store.get('backupFolderPath')) {
        // eslint-disable-next-line global-require
        const backupModule = require('./backup-service');
        const backupService = typeof backupModule.getDefault === 'function'
          ? backupModule.getDefault()
          : backupModule;
        if (backupService && typeof backupService._shouldRunDailyBackup === 'function' &&
            backupService._shouldRunDailyBackup()) {
          Promise.resolve(backupService.runBackup({ trigger: 'first-save-of-day' }))
            .catch(() => { /* logged by backup-service */ });
        }
      }
    } catch (_) { /* never let backup wiring block save */ }

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
  // ===========================================================================
  // Order XML Hot Folders (Mode 4) — helpers
  // ===========================================================================

  /**
   * Return only the hot folder configs that are currently enabled. The watcher
   * uses this to decide which chokidar instances to start. Each entry is a
   * fully validated, deep-cloned object — safe to mutate in the caller.
   */
  getEnabledHotFolders() {
    if (!this.store.get('orderXmlEnabled')) return [];
    const all = this.store.get('orderXmlHotFolders') || [];
    if (!Array.isArray(all)) return [];
    return all
      .filter((hf) => hf && typeof hf === 'object' && hf.enabled)
      .map((hf) => ({ ...hf }));
  }

  /**
   * Return all hot folder configs (enabled or not). Used by the settings UI.
   */
  getAllHotFolders() {
    const all = this.store.get('orderXmlHotFolders') || [];
    return Array.isArray(all) ? all.map((hf) => ({ ...hf })) : [];
  }

  /**
   * Return the effective max-retries for a given hot folder, falling back to
   * the global default when the per-folder override is null/undefined.
   */
  getHotFolderMaxRetries(hotFolder) {
    if (hotFolder && Number.isInteger(hotFolder.maxRetries) &&
        hotFolder.maxRetries >= 1 && hotFolder.maxRetries <= 10) {
      return hotFolder.maxRetries;
    }
    return this.store.get('orderXmlMaxRetries') || 3;
  }

  /**
   * Return the product mapping table for a given parser sourceFormat as a
   * Map<vendorCode, { pixfizzCode, label }>. Empty Map when nothing is
   * configured for that format. Used by the watcher to thread the right
   * slice through into hotFolderConfig.productMap on each parse.
   *
   * The map is rebuilt on each call (cheap — typically <200 entries) so
   * settings changes propagate immediately to the next watcher tick.
   */
  getProductMappingsFor(sourceFormat) {
    const all = this.store.get('orderXmlProductMappings') || {};
    const slice = (sourceFormat && all[sourceFormat]) || [];
    if (!Array.isArray(slice)) return new Map();
    const out = new Map();
    for (const row of slice) {
      if (!row || typeof row !== 'object') continue;
      const code = String(row.photoFinaleCode || '').trim();
      const px   = String(row.pixfizzCode     || '').trim();
      const lbl  = String(row.label           || '').trim();
      if (!code || !px) continue;
      out.set(code, { pixfizzCode: px, label: lbl || px });
    }
    return out;
  }

  /**
   * Return all configured product mappings (every sourceFormat's slice).
   * Used by the settings UI list editor.
   */
  getAllProductMappings() {
    const all = this.store.get('orderXmlProductMappings') || {};
    return all && typeof all === 'object' ? { ...all } : {};
  }

  /**
   * Return the customer directory as a Map<lowercaseCustomerId, { customerId,
   * customerName, customerEmail }>. Empty Map when nothing is configured. Used
   * by the watcher to thread the lookup table through into hotFolderConfig so
   * the PhotoFinale parser can resolve RetailerDealerCode → customer.
   *
   * Lookup is case-insensitive — operators paste codes from many sources and
   * "9052" vs "9052 " vs " 9052" should all hit the same record. We store the
   * trimmed value and key the Map by its lowercase form; the resolved value
   * preserves the original casing so logs / errors stay readable.
   */
  getCustomerMap() {
    const list = this.store.get('orderXmlCustomers') || [];
    const out = new Map();
    if (!Array.isArray(list)) return out;
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const id    = String(row.customerId    || '').trim();
      const name  = String(row.customerName  || '').trim();
      const email = String(row.customerEmail || '').trim();
      if (!id) continue;
      out.set(id.toLowerCase(), { customerId: id, customerName: name, customerEmail: email });
    }
    return out;
  }

  /**
   * Return all configured customer records (raw array). Used by the settings
   * UI list editor.
   */
  getAllCustomers() {
    const list = this.store.get('orderXmlCustomers') || [];
    return Array.isArray(list) ? list.map((r) => ({ ...r })) : [];
  }

  /**
   * Sanitise + validate the hot folder array prior to writing it to the store.
   *
   * Rules (only enforced for ENABLED entries — disabled rows are kept for the
   * operator's convenience but don't have to be valid yet):
   *   - id must be a non-empty string (auto-generated if missing).
   *   - label must be non-empty.
   *   - sourceFormat must be a registered parser id.
   *   - watchFolder and processedFolder must be non-empty.
   *   - watchFolder must not equal processedFolder, and one must not be
   *     contained inside the other (would create a feedback loop).
   *   - No two enabled rows can share the same watchFolder.
   *
   * @param {object[]} rows
   * @param {boolean}  modeEnabled - whether the master orderXmlEnabled toggle
   *   is on. When off, the rules above are NOT enforced — operator can save
   *   half-configured rows while drafting.
   * @returns {object[]} sanitised rows
   */
  _sanitiseOrderXmlHotFolders(rows, modeEnabled) {
    // Lazy require to avoid loading the parser registry at app startup if
    // Mode 4 is unused — keeps cold-start cheap.
    const parserRegistry = require('./order-xml-parsers');

    const seenWatchFolders = new Map();
    const result = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row !== 'object') continue;

      const enabled = Boolean(row.enabled);
      const id     = String(row.id || '').trim() || _genHotFolderId();
      const label  = String(row.label || '').trim();
      const sourceFormat    = String(row.sourceFormat || '').trim();
      const watchFolder     = String(row.watchFolder || '').trim();
      const processedFolder = String(row.processedFolder || '').trim();
      const websiteCode     = String(row.websiteCode || '').trim();

      let maxRetries = null;
      if (row.maxRetries !== null && row.maxRetries !== undefined && row.maxRetries !== '') {
        const n = parseInt(row.maxRetries, 10);
        if (Number.isInteger(n) && n >= 1 && n <= 10) maxRetries = n;
      }

      if (!enabled || !modeEnabled) {
        result.push({
          id, label, enabled, sourceFormat, watchFolder, processedFolder,
          websiteCode, maxRetries,
        });
        continue;
      }

      const where = label ? `"${label}"` : `Hot folder #${i + 1}`;

      if (!label) {
        throw new Error(`Order XML hot folder #${i + 1} requires a label`);
      }
      if (!sourceFormat) {
        throw new Error(`${where}: source format is required`);
      }
      if (!parserRegistry.has(sourceFormat)) {
        const available = parserRegistry.list().map((p) => p.id).join(', ');
        throw new Error(
          `${where}: unknown source format "${sourceFormat}" (available: ${available})`
        );
      }
      if (!watchFolder) {
        throw new Error(`${where}: watch folder is required`);
      }
      if (!processedFolder) {
        throw new Error(`${where}: processed folder is required`);
      }

      const watchLower     = watchFolder.toLowerCase();
      const processedLower = processedFolder.toLowerCase();

      if (watchLower === processedLower) {
        throw new Error(`${where}: watch folder and processed folder must be different`);
      }
      if (_pathContains(processedLower, watchLower) || _pathContains(watchLower, processedLower)) {
        throw new Error(
          `${where}: watch folder and processed folder must not be nested inside each other`
        );
      }

      if (seenWatchFolders.has(watchLower)) {
        const otherLabel = seenWatchFolders.get(watchLower);
        throw new Error(
          `${where}: watch folder "${watchFolder}" is already used by "${otherLabel}"`
        );
      }
      seenWatchFolders.set(watchLower, label);

      result.push({
        id, label, enabled, sourceFormat, watchFolder, processedFolder,
        websiteCode, maxRetries,
      });
    }

    return result;
  }

  /**
   * Sanitise + validate the per-format product-mappings object before write.
   *
   * Rules:
   *   - Top-level keys must be registered parser ids (otherwise dropped).
   *   - Each entry { photoFinaleCode, pixfizzCode, label } is trimmed.
   *   - Rows missing photoFinaleCode OR pixfizzCode are silently dropped.
   *   - Within a single sourceFormat slice, duplicate photoFinaleCode values
   *     are rejected with a useful error so the operator can see which row
   *     conflicts.
   *   - label defaults to pixfizzCode if blank.
   */
  _sanitiseOrderXmlProductMappings(mappings) {
    const parserRegistry = require('./order-xml-parsers');
    const out = {};

    for (const [format, rows] of Object.entries(mappings || {})) {
      if (!parserRegistry.has(format)) continue;
      if (!Array.isArray(rows)) continue;

      const seenCodes = new Map();
      const cleaned = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || typeof row !== 'object') continue;
        const photoFinaleCode = String(row.photoFinaleCode || '').trim();
        const pixfizzCode     = String(row.pixfizzCode     || '').trim();
        const label           = String(row.label           || '').trim();
        if (!photoFinaleCode || !pixfizzCode) continue;

        if (seenCodes.has(photoFinaleCode)) {
          throw new Error(
            `Order XML product mapping for "${format}": ` +
            `vendor code "${photoFinaleCode}" appears in row ${seenCodes.get(photoFinaleCode) + 1} and row ${i + 1}. Each vendor code must map to exactly one Pixfizz product.`
          );
        }
        seenCodes.set(photoFinaleCode, i);

        cleaned.push({
          photoFinaleCode,
          pixfizzCode,
          label: label || pixfizzCode,
        });
      }

      out[format] = cleaned;
    }

    return out;
  }

  /**
   * Sanitise + validate the customer directory before write.
   *
   * Rules:
   *   - customerId, customerName, customerEmail are all required (rows missing
   *     any of the three are dropped silently — keeps the renderer's "blank
   *     row" Add affordance from blowing up the save).
   *   - All three fields are trimmed.
   *   - customerEmail must contain an "@" with non-empty local + domain parts;
   *     otherwise the row is rejected with a useful error.
   *   - Duplicate customerId (case-insensitive) is rejected with a useful
   *     error citing both row positions — operators need to know which to fix.
   */
  _sanitiseOrderXmlCustomers(rows) {
    const seenIds = new Map();
    const cleaned = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row !== 'object') continue;
      const customerId    = String(row.customerId    || '').trim();
      const customerName  = String(row.customerName  || '').trim();
      const customerEmail = String(row.customerEmail || '').trim();

      if (!customerId && !customerName && !customerEmail) continue;
      if (!customerId || !customerName || !customerEmail) {
        throw new Error(
          `Order XML customer row ${i + 1}: Customer ID, Name and Email are all required`
        );
      }

      const at = customerEmail.indexOf('@');
      if (at <= 0 || at === customerEmail.length - 1 || customerEmail.indexOf('.', at) === -1) {
        throw new Error(
          `Order XML customer row ${i + 1}: "${customerEmail}" is not a valid email address`
        );
      }

      const key = customerId.toLowerCase();
      if (seenIds.has(key)) {
        throw new Error(
          `Order XML customer "${customerId}" appears in row ${seenIds.get(key) + 1} and row ${i + 1}. Each Customer ID must be unique.`
        );
      }
      seenIds.set(key, i);

      cleaned.push({ customerId, customerName, customerEmail });
    }

    return cleaned;
  }

}

const configService = new ConfigService();
// Test hooks — module-scoped helpers exposed for unit tests of the Perfectly
// Clear validation contract. Production callers go through save() / getAll().
configService._sanitisePerfectlyClear = _sanitisePerfectlyClear;
configService._validatePerfectlyClear = _validatePerfectlyClear;
module.exports = configService;
