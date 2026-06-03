'use strict';

/**
 * src/main/services/backup-service.js
 *
 * Lab-PC backup & restore for OHD. Snapshots all non-sensitive electron-store
 * state to a single JSON file on a network share (UNC), local disk, or mapped
 * drive. Designed for the "PC died, reinstall and bring the lab back online"
 * scenario — credentials are never written; the operator re-enters them after
 * restore.
 *
 * Design notes (see OHD_BackupRestore_ClaudeCode_Brief.md):
 *   - Secrets are stripped via the SECRET_KEYS allow-list. Never deep-merge
 *     them back in; redaction is one-way.
 *   - Atomic writes use *.tmp + rename. On SMB shares rename occasionally
 *     throws EPERM/EBUSY (sharp/libvips folklore) — we fall back to copyFile +
 *     unlink so a flaky share doesn't corrupt the destination.
 *   - Backups are written into a per-hostname subfolder so multiple lab PCs
 *     can share a single root. A persistent `_machineId` on each install
 *     guards against two PCs landing in the same subfolder (e.g. cloned
 *     images) — collision is a loud failure, not silent overwrite.
 *   - Backup failures must never break config-service.save(). All entry
 *     points catch and log; runBackup() returns `{success:false, error}`.
 */

const fs = require('fs/promises');
const fsConstants = require('fs').constants;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const BACKUP_SCHEMA_VERSION = 1;

// Maximum number of timestamped backups kept per host. The `*_latest.json`
// pointer is exempt from pruning.
const MAX_BACKUPS_PER_HOST = 30;

// Orphan *.tmp files older than this are unlinked at the start of every
// runBackup. Anything newer might be an in-flight write from another instance.
const ORPHAN_TMP_AGE_MS = 60 * 60 * 1000; // 1 hour

// Hard cap on a single runBackup. Writing 150KB to a saturated VPN share can
// take 10s in the wild; 60s gives generous headroom without hanging the UI.
const BACKUP_TIMEOUT_MS = 60 * 1000;

// One retry on transient network errors at write time. The next daily trigger
// will pick up persistent failures so we don't burn cycles in a tight loop.
const RETRY_DELAY_MS = 5 * 1000;

// Keys whose values must never be written to the envelope. The list is the
// source of truth — both runBackup (stripping) and restore (re-entry prompt)
// read from here.
const SECRET_KEYS = Object.freeze([
  'orderhubApiKey',
  'ftpPassword',
  's3SecretAccessKey',
  'topazApiKey',
]);

// Logical store name → electron-store file basename (no extension). These are
// the JSON files written under app.getPath('userData') by each store's
// `new Store({ name })` call. Backup snapshots them by reading the file
// directly so the on-disk state — not whatever a long-lived in-memory store
// happens to remember — is what gets captured.
const STORE_FILES = Object.freeze({
  config:           'config',
  routing:          'routing',
  printControllers: 'print-controllers',
  appPrefs:         'app-prefs',
  filmReviewPrefs:  'film-review-prefs',
});

const STORE_KEYS = Object.freeze(Object.keys(STORE_FILES));

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function _exists(p) {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function _readJson(p) {
  const raw = await fs.readFile(p, 'utf8');
  // Strip UTF-8 BOM if present — see config-service-bom.test.js for context.
  const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  return JSON.parse(cleaned);
}

function _safeJsonClone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Atomic write with SMB rename fallback. Writes to `${destPath}.tmp`, fsyncs,
 * then renames into place. On EPERM/EBUSY/EXDEV (common on Synology / mapped
 * drives) falls back to copyFile + unlink so a flaky share doesn't corrupt
 * the destination.
 */
async function _atomicWrite(destPath, contents) {
  const tmpPath = destPath + '.tmp';
  const fh = await fs.open(tmpPath, 'w');
  try {
    await fh.writeFile(contents);
    try { await fh.sync(); } catch (_) { /* sync unsupported on some shares; non-fatal */ }
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EXDEV')) {
      // SMB rename flake or cross-volume — fall back to copy + unlink.
      await fs.copyFile(tmpPath, destPath);
      await fs.unlink(tmpPath).catch(() => { /* best-effort cleanup */ });
    } else {
      await fs.unlink(tmpPath).catch(() => { /* best-effort cleanup */ });
      throw err;
    }
  }
}

function _hostnameSafe() {
  // os.hostname() can include domain suffixes on AD-joined machines. Strip
  // anything that would break Windows filesystem rules. Empty hostname
  // (extremely rare) falls back to a literal "UNKNOWN-HOST".
  const raw = (os.hostname() || '').split('.')[0];
  const sanitized = raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return sanitized || 'UNKNOWN-HOST';
}

function _timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
         `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function _filenameForBackup(hostname, date) {
  return `ohd-backup_${hostname}_${_timestampForFilename(date)}.json`;
}

function _filenameForLatest(hostname) {
  return `ohd-backup_${hostname}_latest.json`;
}

// Filename pattern for the timestamped backups, used by listBackups + prune.
// Anchored so `*_latest.json` is excluded.
const TIMESTAMPED_RE = /^ohd-backup_(.+)_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.json$/;

function _wrapTimeout(promise, ms, errorMessage) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(errorMessage)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------------------
// Class
// ----------------------------------------------------------------------------

class BackupService {
  /**
   * @param {object} opts
   * @param {object} opts.configService    - config-service singleton (or compatible)
   * @param {object} [opts.printControllerStore] - accepted for API symmetry; unused
   * @param {object} [opts.routingStore]         - accepted for API symmetry; unused
   * @param {object} [opts.appPrefsStore]        - accepted for API symmetry; unused
   * @param {object} [opts.filmReviewPrefsStore] - accepted for API symmetry; unused
   * @param {object} [opts.logger]         - winston-like { info, warn, error, logError }
   * @param {object} [opts.app]            - Electron `app` (for getPath, getVersion, relaunch, exit)
   * @param {string} [opts.userDataPath]   - test override for app.getPath('userData')
   * @param {string} [opts.appVersion]     - test override for app.getVersion()
   * @param {string} [opts.hostname]       - test override for os.hostname()
   * @param {() => Date} [opts.now]        - test clock injector
   */
  constructor(opts = {}) {
    this._configService = opts.configService || null;
    this._logger = opts.logger || _consoleLogger();
    this._app = opts.app || null;
    this._userDataPath = opts.userDataPath || null;
    this._appVersionOverride = opts.appVersion || null;
    this._hostnameOverride = opts.hostname || null;
    this._now = typeof opts.now === 'function' ? opts.now : () => new Date();

    // Stores held for API symmetry with the brief signature — backup reads
    // raw JSON files instead so the snapshot reflects on-disk state rather
    // than whatever a long-lived store happens to remember in memory.
    this._printControllerStore = opts.printControllerStore || null;
    this._routingStore = opts.routingStore || null;
    this._appPrefsStore = opts.appPrefsStore || null;
    this._filmReviewPrefsStore = opts.filmReviewPrefsStore || null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal accessors — kept on the prototype so tests can replace them.
  // ──────────────────────────────────────────────────────────────────────────

  _getUserDataPath() {
    if (this._userDataPath) return this._userDataPath;
    if (this._app && typeof this._app.getPath === 'function') {
      return this._app.getPath('userData');
    }
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    return app.getPath('userData');
  }

  _getAppVersion() {
    if (this._appVersionOverride) return this._appVersionOverride;
    if (this._app && typeof this._app.getVersion === 'function') {
      return this._app.getVersion();
    }
    try {
      // eslint-disable-next-line global-require
      return require('electron').app.getVersion();
    } catch {
      return 'unknown';
    }
  }

  _getHostname() {
    return this._hostnameOverride || _hostnameSafe();
  }

  _getMachineId() {
    if (!this._configService) return '';
    try {
      return this._configService.get('_machineId') || '';
    } catch {
      return '';
    }
  }

  _hostFolderFor(folderPath, hostname) {
    return path.join(folderPath, hostname);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public surface
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Probe the backup folder for write+read access. Called by the Settings UI
   * before persisting `backupFolderPath` so the operator sees the specific
   * filesystem failure (missing share, permission denied, read-only, etc)
   * inline next to the field rather than discovering it on the first
   * scheduled run.
   *
   * Behaviour:
   *   1. Resolve the path
   *   2. Ensure the hostname subfolder exists (recursive mkdir)
   *   3. Write a probe file containing a fresh UUID, fsync
   *   4. Read it back and compare contents byte-for-byte
   *   5. Unlink the probe file (best-effort cleanup; non-fatal if it fails)
   *
   * Returns `{ ok: true }` on success or `{ ok: false, error }` with an
   * operator-readable message — never throws. Error messages are mapped from
   * filesystem error codes; anything unrecognised falls through to the raw
   * message so we don't silently absorb new failure modes.
   *
   * @param {string} folderPath
   * @returns {Promise<{ok: boolean, error?: string, resolvedPath?: string}>}
   */
  async validateFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
      return { ok: false, error: 'Backup folder path is required' };
    }
    const resolved = path.resolve(folderPath.trim());
    const hostname = this._getHostname();
    const hostFolder = this._hostFolderFor(resolved, hostname);
    const token = crypto.randomUUID();
    const probePath = path.join(hostFolder, `.ohd-write-test-${token}`);
    const contents = `ohd-probe ${token}`;

    try {
      await fs.mkdir(hostFolder, { recursive: true });
    } catch (err) {
      return { ok: false, error: _mapFsError(err) };
    }

    let fh;
    try {
      fh = await fs.open(probePath, 'w');
      await fh.writeFile(contents);
      try { await fh.sync(); } catch (_) { /* fsync unsupported on some SMB shares; non-fatal */ }
    } catch (err) {
      try { if (fh) await fh.close(); } catch (_) { /* ignore */ }
      await fs.unlink(probePath).catch(() => { /* ignore */ });
      return { ok: false, error: _mapFsError(err) };
    } finally {
      try { if (fh) await fh.close(); } catch (_) { /* ignore */ }
    }

    let readBack;
    try {
      readBack = await fs.readFile(probePath, 'utf8');
    } catch (err) {
      await fs.unlink(probePath).catch(() => { /* ignore */ });
      return { ok: false, error: _mapFsError(err) };
    }

    if (readBack !== contents) {
      await fs.unlink(probePath).catch(() => { /* ignore */ });
      return {
        ok: false,
        error: 'Wrote a probe file but read back different contents. ' +
               'The share may be unstable or have caching that hides write failures.',
      };
    }

    // Best-effort cleanup — failure here is logged but does not invalidate
    // the probe result; we don't want a transient unlink failure to look
    // like a misconfigured folder.
    await fs.unlink(probePath).catch((err) => {
      this._logger.warn?.(`[backup] could not unlink probe file ${probePath}: ${err.message}`);
    });

    return { ok: true, resolvedPath: resolved };
  }

  /**
   * Daily-trigger check. Returns true when no successful backup has run yet
   * or the last successful one is more than 24h old.
   */
  _shouldRunDailyBackup() {
    if (!this._configService) return false;
    const last = this._configService.get('backupLastRunAt');
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (Number.isNaN(lastMs)) return true; // corrupt timestamp → run again
    return (this._now().getTime() - lastMs) > 24 * 60 * 60 * 1000;
  }

  /**
   * Build the in-memory envelope (sanitized; ready to serialize). Public-ish
   * so tests can exercise sanitization without touching the filesystem.
   *
   * @returns {Promise<object>}
   */
  async _buildEnvelope() {
    const stores = {};
    const userData = this._getUserDataPath();

    for (const key of STORE_KEYS) {
      const filePath = path.join(userData, `${STORE_FILES[key]}.json`);
      if (await _exists(filePath)) {
        try {
          stores[key] = await _readJson(filePath);
        } catch (err) {
          // A corrupt source file is logged; the snapshot proceeds with an
          // empty object for that store so the rest of the backup is usable.
          this._logger.warn?.(`[backup] failed to read ${filePath}: ${err.message}`);
          stores[key] = {};
        }
      } else {
        stores[key] = {};
      }
    }

    // Sanitize config — strip secrets to null and record which keys were
    // redacted. Restore reads `redactedKeys` to drive the "you must re-enter
    // these" prompt.
    const sanitizedConfig = _safeJsonClone(stores.config) || {};
    const redactedKeys = [];
    for (const k of SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sanitizedConfig, k)) {
        if (sanitizedConfig[k] !== null && sanitizedConfig[k] !== '') {
          redactedKeys.push(k);
        }
        sanitizedConfig[k] = null;
      } else {
        // Even keys absent from config.json are listed when they exist in
        // the schema and the operator has not yet entered a value — keeps
        // the post-restore checklist consistent.
        sanitizedConfig[k] = null;
      }
    }

    // Customer directory opt-out — strip in place, then surface the flag at
    // envelope level so restore can report it to the operator.
    const include = this._configService
      ? Boolean(this._configService.get('backupIncludeCustomerDirectory'))
      : true;
    let customerDirectoryExcluded = false;
    if (!include) {
      delete sanitizedConfig.orderXmlCustomers;
      customerDirectoryExcluded = true;
    }

    stores.config = sanitizedConfig;

    return {
      backupSchemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: this._getAppVersion(),
      createdAt: this._now().toISOString(),
      createdBy: {
        hostname: this._getHostname(),
        user: (os.userInfo && os.userInfo().username) || '',
        machineId: this._getMachineId(),
      },
      redactedKeys: SECRET_KEYS.slice(),
      _actuallyPopulatedSecretKeys: redactedKeys, // diagnostic — not load-bearing
      customerDirectoryExcluded,
      stores,
    };
  }

  /**
   * Write a backup snapshot. Returns `{success, filePath?, sizeBytes?, error?}`.
   * Errors are caught and logged — they MUST NOT propagate to callers (the
   * fire-and-forget trigger from config-service.save() depends on this).
   *
   * @param {object} args
   * @param {'manual'|'launch-stale'|'first-save-of-day'} args.trigger
   * @param {object} [args.overrides] — { folderPath?, takeOverFolder? } for the
   *   "Take over this folder" recovery action.
   */
  async runBackup({ trigger = 'manual', overrides = {} } = {}) {
    const folderPath = (overrides.folderPath
      || (this._configService && this._configService.get('backupFolderPath'))
      || '').trim();

    if (!folderPath) {
      return this._fail('Backup folder is not configured');
    }

    try {
      const result = await _wrapTimeout(
        this._runBackupInner(folderPath, { takeOverFolder: Boolean(overrides.takeOverFolder) }),
        BACKUP_TIMEOUT_MS,
        'Backup timed out — share may be slow or unreachable',
      );
      // Success path — clear any stale error, stamp last-run.
      this._safeConfigSet('backupLastError', null);
      this._safeConfigSet('backupLastRunAt', this._now().toISOString());
      this._logger.info?.(`[backup] ${trigger} backup written: ${result.filePath} (${result.sizeBytes} bytes)`);
      return { success: true, ...result };
    } catch (err) {
      // One retry on transient errors that look like a flaky share.
      const transient = err && ['ENOENT', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET'].includes(err.code);
      if (transient) {
        this._logger.warn?.(`[backup] transient failure (${err.code}); retrying in ${RETRY_DELAY_MS}ms`);
        await _sleep(RETRY_DELAY_MS);
        try {
          const result = await _wrapTimeout(
            this._runBackupInner(folderPath, { takeOverFolder: Boolean(overrides.takeOverFolder) }),
            BACKUP_TIMEOUT_MS,
            'Backup timed out — share may be slow or unreachable',
          );
          this._safeConfigSet('backupLastError', null);
          this._safeConfigSet('backupLastRunAt', this._now().toISOString());
          this._logger.info?.(`[backup] ${trigger} backup written on retry: ${result.filePath} (${result.sizeBytes} bytes)`);
          return { success: true, ...result };
        } catch (err2) {
          return this._fail(err2.message || String(err2), err2);
        }
      }
      return this._fail(err.message || String(err), err);
    }
  }

  async _runBackupInner(folderPath, { takeOverFolder = false } = {}) {
    const hostname = this._getHostname();
    const hostFolder = this._hostFolderFor(folderPath, hostname);
    await fs.mkdir(hostFolder, { recursive: true });

    // Clean orphan *.tmp files older than 1 hour. Idempotent; errors logged
    // but non-fatal. Anything newer might be a concurrent in-flight write.
    await this._cleanOrphanTmps(hostFolder).catch((err) => {
      this._logger.warn?.(`[backup] orphan tmp cleanup failed: ${err.message}`);
    });

    // Machine-ID collision check before any write. A mismatch with the
    // existing latest.json under this hostname means another PC is using
    // this folder. Refuse loudly rather than silently clobber.
    const myMachineId = this._getMachineId();
    if (!takeOverFolder) {
      const collision = await this._checkMachineIdCollision(hostFolder, hostname, myMachineId);
      if (!collision.ok) {
        const msg =
          `Another machine with hostname "${hostname}" is already using this backup folder ` +
          `(last backup ${collision.existingCreatedAt}). Rename one of the PCs or use a ` +
          `different backup folder.`;
        const err = new Error(msg);
        err.code = 'HOSTNAME_COLLISION';
        err.existingMachineId = collision.existingMachineId;
        err.existingCreatedAt = collision.existingCreatedAt;
        err.existingAppVersion = collision.existingAppVersion;
        throw err;
      }
    } else {
      // "Take over this folder" — explicit operator action. Delete every
      // existing backup file for this hostname so we don't inherit stale
      // metadata, then proceed. The hostFolder itself is left in place.
      await this._wipeHostFolder(hostFolder, hostname);
    }

    const envelope = await this._buildEnvelope();
    const serialized = JSON.stringify(envelope, null, 2);

    const now = this._now();
    const timestampedName = _filenameForBackup(hostname, now);
    const latestName = _filenameForLatest(hostname);
    const timestampedPath = path.join(hostFolder, timestampedName);
    const latestPath = path.join(hostFolder, latestName);

    await _atomicWrite(timestampedPath, serialized);
    await _atomicWrite(latestPath, serialized);

    // Prune oldest timestamped backups; never touch *_latest.json. Errors
    // are logged but non-fatal — losing prune is much less bad than losing
    // the backup we just wrote.
    await this._prune(hostFolder, hostname).catch((err) => {
      this._logger.warn?.(`[backup] prune failed: ${err.message}`);
    });

    const stat = await fs.stat(timestampedPath);
    return { filePath: timestampedPath, sizeBytes: stat.size };
  }

  /**
   * List backups under the given folder for this host (or all hosts if
   * `allHosts:true`). Returns newest-first. Errors propagate so the UI can
   * surface the underlying filesystem error.
   *
   * @param {string} folderPath
   * @param {object} [opts]
   * @param {boolean} [opts.allHosts=false]
   * @returns {Promise<Array<{path, hostname, createdAt, appVersion, sizeBytes, machineId?, customerDirectoryExcluded?}>>}
   */
  async listBackups(folderPath, opts = {}) {
    const target = (folderPath || (this._configService && this._configService.get('backupFolderPath')) || '').trim();
    if (!target) return [];
    const hostname = this._getHostname();
    const dirs = [];
    if (opts.allHosts) {
      try {
        const entries = await fs.readdir(target, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) dirs.push(path.join(target, e.name));
        }
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    } else {
      dirs.push(this._hostFolderFor(target, hostname));
    }

    const all = [];
    for (const dir of dirs) {
      let files;
      try {
        files = await fs.readdir(dir);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const name of files) {
        if (!name.endsWith('.json')) continue;
        if (name.endsWith('.tmp')) continue;
        // Skip the rolling pointer in the timestamped list; the UI shows it
        // separately via readBackup if it wants the "most recent" view.
        if (name.includes('_latest.json')) continue;
        if (!TIMESTAMPED_RE.test(name)) continue;
        const filePath = path.join(dir, name);
        let meta;
        try {
          const env = await _readJson(filePath);
          const stat = await fs.stat(filePath);
          meta = {
            path: filePath,
            hostname: env?.createdBy?.hostname || '',
            createdAt: env?.createdAt || '',
            appVersion: env?.appVersion || '',
            sizeBytes: stat.size,
            machineId: env?.createdBy?.machineId || '',
            customerDirectoryExcluded: Boolean(env?.customerDirectoryExcluded),
          };
        } catch (err) {
          // Malformed envelope — skip but log so the operator can investigate.
          this._logger.warn?.(`[backup] skipping malformed backup ${filePath}: ${err.message}`);
          continue;
        }
        all.push(meta);
      }
    }

    all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return all;
  }

  /**
   * Read a backup file and validate its envelope shape. Returns
   * `{envelope, error?}`. Does NOT apply anything.
   */
  async readBackup(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return { envelope: null, error: 'filePath is required' };
    }
    let envelope;
    try {
      envelope = await _readJson(filePath);
    } catch (err) {
      return { envelope: null, error: `Could not read backup file: ${err.message}` };
    }
    const validation = _validateEnvelope(envelope);
    if (!validation.ok) return { envelope: null, error: validation.error };
    return { envelope };
  }

  /**
   * Apply a backup. Selections is a per-store boolean map. Writes raw JSON
   * files directly to userData; the caller is expected to force a relaunch
   * afterwards so the in-memory electron-store singletons pick up new state.
   *
   * @param {object} args
   * @param {string} args.filePath
   * @param {object} [args.selections] - { config?, routing?, printControllers?, appPrefs?, filmReviewPrefs? }
   *   Defaults: every section true.
   */
  async restore({ filePath, selections } = {}) {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'filePath is required' };
    }
    const { envelope, error } = await this.readBackup(filePath);
    if (error) return { success: false, error };

    const ver = envelope.backupSchemaVersion;
    if (ver > BACKUP_SCHEMA_VERSION) {
      return {
        success: false,
        error: `Backup was written by a newer version of OHD ` +
               `(schema v${ver}; this build supports up to v${BACKUP_SCHEMA_VERSION}). ` +
               `Upgrade OHD and try again.`,
      };
    }

    const sel = _normalizeSelections(selections);
    const migrationNotes = [];
    if (ver < BACKUP_SCHEMA_VERSION) {
      migrationNotes.push(
        `Backup is schema v${ver}; this build is v${BACKUP_SCHEMA_VERSION}. ` +
        `Per-key migrations will run on next launch.`,
      );
    }

    const userData = this._getUserDataPath();
    const restoredSections = [];
    const skippedSections = [];

    for (const key of STORE_KEYS) {
      if (!sel[key]) { skippedSections.push(key); continue; }
      const data = envelope.stores && envelope.stores[key];
      if (!data || typeof data !== 'object') {
        skippedSections.push(key);
        migrationNotes.push(`Section "${key}" was absent from backup; left at current values.`);
        continue;
      }
      const dest = path.join(userData, `${STORE_FILES[key]}.json`);

      // For config: re-merge our local `_machineId` so a restore does NOT
      // overwrite the persistent UUID of THIS install. (The envelope's
      // machineId belongs to the install the backup was taken from.)
      let toWrite = _safeJsonClone(data);
      if (key === 'config') {
        const myMachineId = this._getMachineId();
        if (myMachineId) {
          toWrite._machineId = myMachineId;
        } else {
          // Fresh install — strip the source install's machineId so we
          // generate a brand-new one on next launch via _ensureMachineId().
          delete toWrite._machineId;
        }
        // Clear migration timestamps so the next launch re-runs per-key
        // migrations (covers older legacy keys in the backup).
        for (const k of Object.keys(toWrite)) {
          if (/^_.*MigratedAt$/.test(k) || k === '_filmScanReviewModeMigrated') {
            delete toWrite[k];
            migrationNotes.push(`Cleared migration marker "${k}" so it re-runs on next launch.`);
          }
        }
      }

      await fs.mkdir(path.dirname(dest), { recursive: true });
      await _atomicWrite(dest, JSON.stringify(toWrite, null, 2));
      restoredSections.push(key);
    }

    return {
      success: true,
      requiresRelaunch: true,
      restoredSections,
      skippedSections,
      migrationNotes,
      redactedKeys: Array.isArray(envelope.redactedKeys) ? envelope.redactedKeys.slice() : SECRET_KEYS.slice(),
      customerDirectoryExcluded: Boolean(envelope.customerDirectoryExcluded),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  async _checkMachineIdCollision(hostFolder, hostname, currentMachineId) {
    const latestPath = path.join(hostFolder, _filenameForLatest(hostname));
    if (!await _exists(latestPath)) return { ok: true };

    let existing;
    try {
      existing = await _readJson(latestPath);
    } catch {
      return { ok: true }; // can't read it; treat as missing
    }

    const existingId = existing && existing.createdBy && existing.createdBy.machineId;
    if (!existingId) return { ok: true };           // pre-machineId backup
    if (!currentMachineId) return { ok: true };     // we don't have one (test/edge); allow
    if (existingId === currentMachineId) return { ok: true };

    return {
      ok: false,
      reason: 'hostname-collision',
      existingMachineId: existingId,
      existingCreatedAt: existing.createdAt || '',
      existingAppVersion: existing.appVersion || '',
    };
  }

  async _cleanOrphanTmps(hostFolder) {
    let files;
    try {
      files = await fs.readdir(hostFolder);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const cutoffMs = this._now().getTime() - ORPHAN_TMP_AGE_MS;
    for (const name of files) {
      if (!name.endsWith('.tmp')) continue;
      const p = path.join(hostFolder, name);
      try {
        const stat = await fs.stat(p);
        if (stat.mtimeMs < cutoffMs) {
          await fs.unlink(p);
        }
      } catch (err) {
        this._logger.warn?.(`[backup] could not clean orphan tmp ${p}: ${err.message}`);
      }
    }
  }

  async _prune(hostFolder, hostname) {
    const files = await fs.readdir(hostFolder);
    const candidates = [];
    for (const name of files) {
      if (!TIMESTAMPED_RE.test(name)) continue;
      const m = TIMESTAMPED_RE.exec(name);
      if (!m || m[1] !== hostname) continue;
      candidates.push({ name, sortKey: `${m[2]}T${m[3].replace(/-/g, ':')}` });
    }
    candidates.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    const tooMany = candidates.slice(MAX_BACKUPS_PER_HOST);
    for (const c of tooMany) {
      try {
        await fs.unlink(path.join(hostFolder, c.name));
      } catch (err) {
        this._logger.warn?.(`[backup] prune unlink failed for ${c.name}: ${err.message}`);
      }
    }
  }

  async _wipeHostFolder(hostFolder, hostname) {
    let files;
    try {
      files = await fs.readdir(hostFolder);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const name of files) {
      const isLatest = name === _filenameForLatest(hostname);
      const m = TIMESTAMPED_RE.exec(name);
      const isTimestamped = m && m[1] === hostname;
      if (!isLatest && !isTimestamped) continue;
      try {
        await fs.unlink(path.join(hostFolder, name));
      } catch (err) {
        this._logger.warn?.(`[backup] take-over: could not unlink ${name}: ${err.message}`);
      }
    }
  }

  _fail(message, err) {
    this._logger.error?.(`[backup] ${message}`);
    if (err && err.stack) this._logger.error?.(err.stack);
    this._safeConfigSet('backupLastError', String(message));
    const out = { success: false, error: String(message) };
    if (err && err.code) out.code = err.code;
    return out;
  }

  _safeConfigSet(key, value) {
    if (!this._configService) return;
    try { this._configService.set(key, value); } catch (e) {
      this._logger.warn?.(`[backup] could not set ${key}: ${e.message}`);
    }
  }
}

// ----------------------------------------------------------------------------
// Envelope validation + selection helpers
// ----------------------------------------------------------------------------

function _validateEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, error: 'Backup file is not a valid JSON object' };
  if (typeof env.backupSchemaVersion !== 'number') {
    return { ok: false, error: 'Backup file is missing or has invalid `backupSchemaVersion`' };
  }
  if (!env.stores || typeof env.stores !== 'object') {
    return { ok: false, error: 'Backup file is missing the `stores` section' };
  }
  if (env.stores.config && typeof env.stores.config !== 'object') {
    return { ok: false, error: '`stores.config` must be an object' };
  }
  return { ok: true };
}

function _normalizeSelections(input) {
  const out = {};
  for (const k of STORE_KEYS) out[k] = true; // default: every section restored
  if (input && typeof input === 'object') {
    for (const k of STORE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(input, k)) {
        out[k] = Boolean(input[k]);
      }
    }
  }
  return out;
}

/**
 * Map a filesystem error to an operator-readable message. Used by
 * validateFolder so the Settings UI shows actionable text inline rather than
 * raw "EACCES: permission denied, open '\\\\NAS\\...'" output.
 *
 * Anything unrecognised falls through to the original message so we don't
 * silently absorb a new failure mode the operator could otherwise diagnose.
 */
function _mapFsError(err) {
  if (!err) return 'Unknown filesystem error';
  const code = err.code || '';
  switch (code) {
    case 'ENOENT':
      return 'Path not found. If this is a UNC path, check the share is accessible from this PC.';
    case 'EACCES':
    case 'EPERM':
      return "Permission denied. Check share permissions for this PC's Windows user account.";
    case 'EROFS':
      return 'Share is read-only.';
    case 'ENOTDIR':
      return 'Parent path exists but is not a folder.';
    case 'EBUSY':
      return 'Path is busy. Another process may be holding it.';
    case 'ENOSPC':
      return 'No space left on the destination drive.';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENOTFOUND':
      return 'Could not reach the network share. Check that it is online and reachable from this PC.';
    default:
      return err.message || String(err);
  }
}

function _consoleLogger() {
  // eslint-disable-next-line no-console
  return {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
    logError: (msg, err) => console.error(msg, err),
  };
}

// ----------------------------------------------------------------------------
// Lazy singleton for production callers (ipc-handlers, index.js, config-service)
// ----------------------------------------------------------------------------

let _defaultInstance = null;

function getDefault() {
  if (_defaultInstance) return _defaultInstance;
  // eslint-disable-next-line global-require
  const configService = require('./config-service');
  let logger;
  try {
    // eslint-disable-next-line global-require
    logger = require('./logger');
  } catch {
    logger = _consoleLogger();
  }
  let appHandle = null;
  try {
    // eslint-disable-next-line global-require
    appHandle = require('electron').app;
  } catch { /* tests / non-electron context */ }
  _defaultInstance = new BackupService({
    configService,
    logger,
    app: appHandle,
  });
  return _defaultInstance;
}

module.exports = BackupService;
module.exports.BackupService = BackupService;
module.exports.getDefault = getDefault;
module.exports.SECRET_KEYS = SECRET_KEYS;
module.exports.BACKUP_SCHEMA_VERSION = BACKUP_SCHEMA_VERSION;
module.exports.MAX_BACKUPS_PER_HOST = MAX_BACKUPS_PER_HOST;
module.exports.STORE_FILES = STORE_FILES;
// Test-only — let the suite reset between cases.
module.exports._resetDefault = function _resetDefault() { _defaultInstance = null; };
