// SEE ALSO src/main/services/ftp-source-service.js — it holds its own
// basic-ftp session (one per pass, list + download-each + delete-each,
// for the generic FTP-sources file mover). Any change to how sessions
// are constructed here (client options, `client.access` arguments —
// timeouts, secure/TLS, encoding, passive-mode) MUST be mirrored there
// or one FTP server will silently work only via whichever caller
// happens to match its expectations. BACKLOG.md notes the eventual
// fix (a shared `withSession(credentials, fn)` helper) — not now.
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { checkImageMagic } = require('./file-integrity');
const { loadSidecar, saveSidecar } = require('../jobs/sidecarManager');
const { createImageEntry } = require('../../shared/jobSchema');

const EXPECTED_MAGIC_DESC = 'JPEG (FF D8 FF) or PNG (89 50 4E 47 0D 0A 1A 0A)';

// Extensions for which the FTP layer runs the magic-byte integrity check.
// Deliberately narrower than the codebase-wide IMAGE_EXTENSIONS set: that
// one means "what OHD considers an image at all" (and includes .tif/.tiff
// for compatibility with code paths that may reference them), while this
// one means "what the FTP layer can validate via JPEG/PNG magic bytes".
// Files outside this set (order manifests, sidecars, future PDFs, anything
// else upstream might land in the FTP slot) bypass the check entirely —
// surfacing corruption for those formats is the responsibility of the
// downstream consumer that actually parses them.
const INTEGRITY_CHECK_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

function shouldIntegrityCheck(filename) {
  return INTEGRITY_CHECK_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/**
 * Recognise an expected "FTP user can't delete this file" 550 against a
 * customer-original upload. Pixfizz Core ships customer uploads to
 * `…/original-files/…` and the lab FTP user typically only has read+list on
 * that subfolder, so DELE comes back as 550. Treating these as a successful
 * no-op (silent debug log + don't trip `allFilesSucceeded`) eliminates the
 * 41+ error-level entries per sweep we were producing — and lets the parent
 * folder cleanup branch be entered. The actual `removeDir` on the parent
 * folder is gated by `client.list(remotePath).length === 0`, so a folder
 * that's still full because we couldn't delete the contents is silently
 * skipped without further noise. Any non-`original-files/` 550 keeps its
 * error-level log so a real permission regression elsewhere still surfaces.
 *
 * Match is lenient: `/[\\/]original-files[\\/]/i` so forward- or back-slashed
 * paths and any casing variant catch. False-positive risk is essentially
 * zero — no Pixfizz layout is coincidentally going to contain that segment.
 *
 * @param {Error|null} err          - error thrown by basic-ftp's client.remove
 * @param {string}     remotePath   - the path the DELE was attempted against
 * @returns {boolean}
 */
function _isExpected550OnOriginalFiles(err, remotePath) {
  if (!err || typeof err !== 'object') return false;
  // basic-ftp's FTPError carries a numeric `.code` matching the FTP response
  // (see node_modules/basic-ftp/dist/FtpContext.d.ts). Guard against future
  // throwers that don't set `.code` by also matching the message prefix.
  const code = err.code;
  const isFtp550 = code === 550 ||
    (typeof err.message === 'string' && /^\s*550(\b|\D)/.test(err.message));
  if (!isFtp550) return false;
  if (typeof remotePath !== 'string' || !remotePath) return false;
  return /[\\/]original-files[\\/]/i.test(remotePath);
}

/**
 * Centralised handler for a failed FTP DELE. Logs at debug level for the
 * expected-550-on-original-files case and at error level for everything
 * else, returning `{ expected }` so callers know whether to count the
 * failure against `allFilesSucceeded`. Pulled out so both delete sites
 * (skip-already-have and post-download cleanup) stay in sync.
 *
 * @param {Error}  delError
 * @param {string} remoteItemPath
 * @returns {{ expected: boolean }}
 */
// Windows filesystem reserved characters. On the FTP server (Linux-side)
// these are all legal in a filename, but on a Windows client they either
// have a path-separator meaning (`\` `/`) or are outright forbidden
// (`< > : " | ? *` and ASCII 0-31). When Pixfizz Core's upload pipeline
// escapes parentheses to `\(` / `\)` (or similar), the literal backslash
// in the filename gets re-interpreted by the OS as a path separator and
// the download fails with ENOENT on a non-existent intermediate folder.
//
// `_sanitiseWindowsBasename` replaces every reserved character in the
// basename with `_`. The remote name is left untouched — only the local
// target path is built from the sanitised version, so files still
// download from their authentic server-side names and just land under a
// Windows-friendly local name. Idempotent: re-running on a sanitised name
// is a no-op.
const _WINDOWS_RESERVED_CHARS_RE = /[<>:"/\\|?*\x00-\x1F]/g;

function _sanitiseWindowsBasename(name) {
  if (typeof name !== 'string' || !name) return name;
  return name.replace(_WINDOWS_RESERVED_CHARS_RE, '_');
}

/**
 * Save-time ADVISORY (never a block) for the FTP retention sweep.
 * Same shape as the folder-copy advisories in ipc-handlers.js
 * (`folder-copy-root-blank-template` et al.) and the PIC Pro volume-cross
 * advisory (`picpro-volume-cross`): return an array of `{ kind, text }`,
 * let the save proceed regardless. The renderer surfaces each entry via
 * a modal `alert()` so the operator MUST acknowledge before Settings
 * closes.
 *
 * Currently one warning kind:
 *   `ftp-retention-sweep-root-path` — sweep enabled while Remote Path is
 *   "/" or empty. The runtime refuses at root (see _sweepOldFiles
 *   SAFETY 1), so without this advisory the operator would enable
 *   "Delete old files from the server", never see anything deleted,
 *   and have to read the Activity Log to find out why. That is the
 *   same "control that looks on but does nothing" failure we avoided
 *   by defaulting dry-run to false.
 *
 * Pure function — no I/O, no side effects. Takes the config object the
 * operator is trying to save. Called from ipc-handlers.js `config:save`.
 * Uses strict `=== true` on the enabled flag (matches the folder-copy
 * `omitJobId === true` normalisation): a hand-edited config with a
 * truthy-but-not-boolean value doesn't surface an alert the operator
 * didn't cause via the UI.
 */
function _computeFtpSweepSaveWarnings(config) {
  const warnings = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return warnings;
  if (config.ftpRetentionSweepEnabled !== true) return warnings;
  const rp = typeof config.ftpRemotePath === 'string' ? config.ftpRemotePath.trim() : '';
  const isRoot = !rp || rp.replace(/\/+$/, '') === '';
  if (isRoot) {
    warnings.push({
      kind: 'ftp-retention-sweep-root-path',
      text:
        'Heads up — FTP retention sweep is enabled, but Remote Path is "/" (root). ' +
        'The sweep refuses to run at the FTP root because it could delete files ' +
        'belonging to Pixfizz Core or other systems, so nothing will be deleted. ' +
        'Set Remote Path above to a specific folder (e.g. "/orders") to make the ' +
        'sweep active.',
    });
  }
  return warnings;
}

function _handleFtpDeleteFailure(delError, remoteItemPath) {
  if (_isExpected550OnOriginalFiles(delError, remoteItemPath)) {
    logger.logDebug(
      'FTP delete on read-only original-files path (expected 550) — treating as success',
      { remoteItemPath },
    );
    return { expected: true };
  }
  logger.logError('Failed to delete file from FTP', delError, { remoteItemPath });
  return { expected: false };
}

/**
 * Flag a downloaded file as integrity-suspect without renaming, deleting,
 * or otherwise hiding it. The pivot from the v1.3.0 quarantine model:
 * detection and decision are separate concerns. OHD's job is to detect and
 * surface; whether the file ultimately prints is decided downstream by the
 * printer, the operator, or the customer.
 *
 *   1. Leave the file at `localPath` with its original extension. Do NOT
 *      rename. Downstream consumers (orchestrator's _scanJobImages, print
 *      pipeline, sidecarManager) all match by extension, so the file is
 *      now visible to them. The graceful-fail path in ai-quality-service
 *      (sharp throws → score 100 + aiQuality.error) handles it cleanly.
 *   2. Stamp the per-image sidecar's `integritySuspect` field via
 *      sidecarManager. The sidecar is the canonical forensic record under
 *      the new model — no separate per-job manifest is written.
 *   3. Emit an [integrity-check] info-level log line with the same
 *      structured fields the old [quarantine] log carried.
 *
 * Sidecar I/O failures are logged and swallowed: the file is still going
 * downstream regardless, and the orchestrator's later scoring pass will
 * surface corruption via aiQuality.error even if the integritySuspect
 * write didn't land. Do not throw from this function.
 *
 * The sidecar this writes to is the inner-job sidecar at
 * `<dirname(localPath)>/<basename(dirname(localPath))>.json`, matching
 * the convention used by the orchestrator and ai-quality-store.
 */
async function markIntegritySuspect(localPath, remoteItemPath, integrity, expectedSize) {
  const jobPath = path.dirname(localPath);
  const jobId = path.basename(jobPath);
  const filename = path.basename(localPath);

  let actualSize = null;
  try {
    actualSize = fs.statSync(localPath).size;
  } catch {
    // Stat failure is non-fatal — diagnostic field stays null.
  }

  const reason = integrity.magicHex === null ? 'read-error' : 'magic-byte-mismatch';
  const detectedAt = new Date().toISOString();
  const suspect = {
    detected: true,
    detectedAt,
    firstBytesHex: integrity.magicHex,
    expectedMagic: EXPECTED_MAGIC_DESC,
    ftpRemotePath: remoteItemPath,
  };

  try {
    const { sidecar } = await loadSidecar(jobId, jobPath);
    if (!Array.isArray(sidecar.images)) sidecar.images = [];

    let idx = sidecar.images.findIndex((img) => img.filename === filename);
    if (idx === -1) {
      // Mode-1 (FTP) jobs land images at the job root, not /working/, so
      // sidecarManager's auto-populate from /working/ won't include them.
      // Upsert a fresh entry — same pattern ai-quality-store.setImageQuality
      // uses. createImageEntry already defaults integritySuspect to null,
      // which we immediately overwrite below.
      sidecar.images.push(createImageEntry(filename, 1));
      idx = sidecar.images.length - 1;
    }

    sidecar.images[idx] = {
      ...sidecar.images[idx],
      integritySuspect: suspect,
    };

    await saveSidecar(sidecar, jobPath);
  } catch (err) {
    logger.logError('[integrity-check] Failed to update sidecar — file still proceeds downstream', err, {
      localPath,
      jobPath,
      jobId,
      filename,
    });
  }

  logger.info('[integrity-check] Suspect file flagged', {
    filename,
    ftpRemotePath: remoteItemPath,
    expectedSize: expectedSize ?? null,
    actualSize,
    firstBytesHex: integrity.magicHex,
    expectedMagic: EXPECTED_MAGIC_DESC,
    reason,
    detectedAt,
  });
}

class FtpService {
  constructor() {
    this.client = null;
  }

  /**
   * Test FTP connection
   */
  async testConnection(credentials) {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
      logger.info('Testing FTP connection', { host: credentials.host });

      await client.access({
        host: credentials.host,
        port: credentials.port || 21,
        user: credentials.user,
        password: credentials.password,
        secure: false
      });

      logger.info('FTP test connection successful');
      return true;
    } catch (error) {
      logger.logError('FTP test connection failed', error);
      throw error;
    } finally {
      client.close();
    }
  }

  /**
   * Download file from FTP server
   */
  async downloadFile(credentials, remotePath, localPath) {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
      logger.info('Starting FTP download', { remotePath, localPath });

      // Connect to FTP server
      await client.access({
        host: credentials.host,
        port: credentials.port || 21,
        user: credentials.user,
        password: credentials.password,
        secure: false
      });

      // Ensure local directory exists
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        logger.info('Creating local directory', { localDir });
        fs.mkdirSync(localDir, { recursive: true });
      }

      // Download file
      await client.downloadTo(localPath, remotePath);

      // Verify file was downloaded
      if (fs.existsSync(localPath)) {
        const stats = fs.statSync(localPath);
        logger.info('FTP download successful', {
          remotePath,
          localPath,
          size: stats.size
        });
        return {
          success: true,
          localPath,
          size: stats.size
        };
      } else {
        throw new Error('Downloaded file not found on disk');
      }
    } catch (error) {
      logger.logError('FTP download failed', error, { remotePath, localPath });
      throw error;
    } finally {
      client.close();
    }
  }

  /**
   * Download multiple files
   */
  async downloadFiles(credentials, files) {
    const results = [];

    for (const file of files) {
      try {
        const result = await this.downloadFile(
          credentials,
          file.remotePath,
          file.localPath
        );
        results.push({ ...file, ...result });
      } catch (error) {
        logger.logError('Failed to download file', error, {
          remotePath: file.remotePath
        });
        results.push({
          ...file,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Scan FTP directory and download all folders/files recursively
   */
  /**
   * Recursively scan `remotePath` and download every file into
   * `localBasePath`. Options (all fields optional):
   *
   *   options.keepFilesOnServer  — when truthy, suppress every FTP-side
   *     mutation: no per-file DELE after download, no DELE on the skip
   *     path, no parent-folder RMD. Everything else about the download
   *     is unchanged. Default false (delete = today's behaviour;
   *     migration-safe for single-location labs).
   *
   * Copy mode exists because in a multi-location lab, Pixfizz Core pushes
   * an order's artwork to ONE FTP folder — whichever location polls first
   * takes the files and deletes them, and every other location is then
   * permanently unable to download that order. Copy mode leaves the files
   * for every location to fetch. Pixfizz Core removes them on its own
   * schedule; OHD does NOT run a retention sweep (see docs/BACKLOG.md
   * under "Decisions parked" for the reasoning).
   */
  async scanAndDownload(credentials, remotePath, localBasePath, onProgress, options = {}) {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    const summary = { downloaded: 0, skipped: 0, failed: 0, errors: [] };

    try {
      onProgress({ status: 'connecting', message: 'Connecting to FTP...' });

      await client.access({
        host: credentials.host,
        port: credentials.port || 21,
        user: credentials.user,
        password: credentials.password,
        secure: false
      });

      onProgress({ status: 'scanning', message: `Scanning ${remotePath}...` });

      // Recursively download directory contents. `options` threads
      // through unchanged — the copy-mode gate lives inside
      // _downloadDirectory so a single check per FTP-mutating call
      // stays close to the call.
      await this._downloadDirectory(client, remotePath, localBasePath, onProgress, summary, false, options);

      // Retention sweep — runs once per polling cycle over the same
      // session. Throttle (once per 24h) + safety guards live inside
      // _sweepOldFiles; scanAndDownload just wires options through and
      // surfaces the outcome on the summary so the caller can persist
      // the completion timestamp for the throttle.
      summary.sweep = await this._sweepOldFiles(client, remotePath, localBasePath, {
        enabled:     !!options.sweepEnabled,
        ageDays:     options.sweepAgeDays,
        dryRun:      !!options.sweepDryRun,
        lastSweepAt: options.lastSweepAt,
      });

      onProgress({
        status: 'complete',
        message: `Complete - ${summary.downloaded} files downloaded, ${summary.skipped} skipped`,
        summary
      });

      return summary;
    } catch (error) {
      logger.logError('Scan and download failed', error);
      onProgress({ status: 'error', message: 'Error: ' + error.message });
      throw error;
    } finally {
      client.close();
    }
  }

  /**
   * Recursively download a directory's contents.
   *
   * `options.keepFilesOnServer` (copy mode) suppresses all THREE FTP-side
   * mutation points: the post-download DELE (site A), the skip-path DELE
   * (site B), and the parent-folder RMD block (site C). Everything else —
   * dedup by size + magic-byte integrity check, size-mismatch re-download,
   * per-file diagnostic logging — is unchanged. See scanAndDownload's
   * docblock for the multi-location rationale.
   *
   * Options is forwarded verbatim through recursive calls so subfolder
   * dispatches inherit the mode.
   */
  async _downloadDirectory(client, remotePath, localPath, onProgress, summary, isSubfolder = false, options = {}) {
    const keepFilesOnServer = !!(options && options.keepFilesOnServer);
    // Ensure local directory exists
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true });
    }

    const items = await client.list(remotePath);
    let allFilesSucceeded = true;

    for (const item of items) {
      const remoteItemPath = remotePath.replace(/\/$/, '') + '/' + item.name;
      // Local path uses a sanitised basename so Windows-illegal characters
      // (notably literal `\` Pixfizz Core sometimes leaves in customer-
      // upload filenames when escaping parens) don't get reinterpreted as
      // path separators. Server-side name stays intact for the actual
      // download fetch above.
      const localItemName = _sanitiseWindowsBasename(item.name);
      if (localItemName !== item.name) {
        logger.logDebug('Sanitised filename for local target', {
          remoteItemPath, originalName: item.name, sanitisedName: localItemName,
        });
      }
      const localItemPath = path.join(localPath, localItemName);

      if (item.isDirectory) {
        onProgress({
          status: 'downloading',
          message: `Scanning folder: ${item.name}`
        });
        await this._downloadDirectory(client, remoteItemPath, localItemPath, onProgress, summary, true, options);
      } else {
        // Skip if file already exists with same size — but for known image
        // formats also verify magic bytes first. A size-match on a corrupt
        // file (sparse-zero allocation, HTML error page, etc.) would
        // otherwise look like a valid cache hit. Non-image files (order
        // manifests, sidecars, PDFs, etc.) bypass the integrity check —
        // see INTEGRITY_CHECK_EXTENSIONS.
        if (fs.existsSync(localItemPath)) {
          const localStats = fs.statSync(localItemPath);
          if (localStats.size === item.size) {
            if (shouldIntegrityCheck(item.name)) {
              const integrity = checkImageMagic(localItemPath);
              if (!integrity.valid) {
                // Cached file looks corrupt by magic-byte check. Under the
                // v1.3.2 flag-and-allow model we don't re-download or hide
                // the file — we mark it suspect in the sidecar and treat
                // it as a normal cache hit. The print pipeline attempts it;
                // AI Quality scoring's graceful-fail (sharp throws → score
                // 100 + aiQuality.error) surfaces the issue to the operator.
                await markIntegritySuspect(localItemPath, remoteItemPath, integrity, item.size);
              }
            }
            summary.skipped++;
            // Copy mode leaves the file on the server so other locations
            // can still fetch it. Otherwise the historical behaviour:
            // delete on skip (site B) since we already have a local copy.
            if (!keepFilesOnServer) {
              try {
                await client.remove(remoteItemPath);
                logger.info('Deleted already-downloaded file from FTP', { remoteItemPath });
              } catch (delError) {
                // Expected 550 against /original-files/ (Pixfizz read-only
                // subfolder) → debug-level, treated as success. Any other
                // failure stays error-level. No retry change.
                _handleFtpDeleteFailure(delError, remoteItemPath);
              }
            }
            continue;
          }
        }

        try {
          onProgress({
            status: 'downloading',
            message: `Downloading: ${item.name}`,
            downloaded: summary.downloaded,
            skipped: summary.skipped
          });

          await client.downloadTo(localItemPath, remoteItemPath);
          summary.downloaded++;
          logger.info('Downloaded file', { remoteItemPath, localItemPath });

          // Verify download — size match is hard-required (mismatched size
          // means an incomplete download we shouldn't trust). For image
          // extensions we additionally run the magic-byte check, but under
          // the v1.3.2 flag-and-allow model an integrity failure no longer
          // hides the file: we mark it suspect in the sidecar and treat it
          // as a normal successful download. Non-image files (order
          // manifests, sidecars, PDFs) bypass the integrity check entirely
          // — surfacing corruption for those formats is the responsibility
          // of the downstream consumer that parses them.
          if (fs.existsSync(localItemPath)) {
            const localStats = fs.statSync(localItemPath);
            if (localStats.size !== item.size) {
              logger.logWarning('Downloaded file size mismatch, keeping FTP copy', {
                remoteItemPath,
                expected: item.size,
                actual: localStats.size
              });
              allFilesSucceeded = false;
            } else {
              if (shouldIntegrityCheck(item.name)) {
                const integrity = checkImageMagic(localItemPath);
                if (!integrity.valid) {
                  await markIntegritySuspect(localItemPath, remoteItemPath, integrity, item.size);
                }
              }
              if (!keepFilesOnServer) {
                try {
                  await client.remove(remoteItemPath);
                  logger.info('Deleted file from FTP after successful download', { remoteItemPath });
                } catch (delError) {
                  // Expected 550 against /original-files/ keeps
                  // allFilesSucceeded=true so the parent-folder cleanup
                  // branch at the bottom of this function is still entered
                  // (it will short-circuit naturally when list() shows the
                  // undeletable file still present). All other failures
                  // still trip allFilesSucceeded as before.
                  const { expected } = _handleFtpDeleteFailure(delError, remoteItemPath);
                  if (!expected) allFilesSucceeded = false;
                }
              }
            }
          }
        } catch (error) {
          summary.failed++;
          summary.errors.push({ file: remoteItemPath, error: error.message });
          logger.logError('Failed to download file', error, { remoteItemPath });
          allFilesSucceeded = false;
        }
      }
    }

    // If this is a subfolder and all files succeeded, try to remove the
    // empty folder. Suppressed in copy mode — the whole point is to
    // leave the tree intact for other locations. Extra `client.list()`
    // and `client.removeDir()` roundtrips avoided too, not just the
    // mutation.
    if (!keepFilesOnServer && isSubfolder && allFilesSucceeded) {
      try {
        const remaining = await client.list(remotePath);
        if (remaining.length === 0) {
          await client.removeDir(remotePath);
          logger.info('Removed empty FTP folder', { remotePath });
        }
      } catch (dirError) {
        logger.logError('Failed to remove FTP folder', dirError, { remotePath });
      }
    }
  }

  /**
   * FTP retention sweep — delete files on the FTP server older than
   * `options.ageDays` (default 7). Called at the end of scanAndDownload
   * when `options.sweepEnabled` is true. Pure w.r.t. persistence: the
   * caller passes in `lastSweepAt` and, on a successful run, receives
   * `{ ran: true, at: '<ISO>' }` in the return value which the caller
   * persists via configService.
   *
   * SAFETY GUARDS (spec §"SAFETY REQUIREMENTS"):
   *   1. Refuses when remotePath is "/" or empty — sweeping the FTP root
   *      could delete files belonging to Pixfizz Core or other systems.
   *      Refusal is logged at WARN every polling cycle until fixed and
   *      does NOT stamp lastSweepAt (so it re-fires each cycle).
   *   2. Never traverses outside remotePath — item names of ".", "..",
   *      "" or anything containing `/` `\` are skipped with a WARN log.
   *   3. Age from remote mtime (item.modifiedAt, or item.date as fallback
   *      on older basic-ftp), not from when OHD downloaded. A file no
   *      location has fetched still ages out.
   *   4. Never deletes a file OHD hasn't itself successfully downloaded
   *      and verified locally — size-match against the local copy is the
   *      per-file guard.
   *   5. Off by default (`options.sweepEnabled === true` required).
   *   6. Every deletion logged with path, parsed mtime, and age in days.
   *   7. `options.dryRun === true` logs "would delete" candidates without
   *      calling client.remove. Default false — root-refusal + local-verify
   *      already bound the damage, so the worst a mis-set threshold does
   *      is shorten the window for other locations (documented hazard,
   *      not local data loss); against that, silently neutering the sweep
   *      by defaulting dry-run to true would let the folder grow with no
   *      operator-visible signal why. Dry-run stays available as an
   *      opt-in preview.
   *
   * THROTTLE: 24h since last successful sweep. Reads `options.lastSweepAt`
   * (ISO string from configService), skips the entire walk if inside the
   * window. Persistence-agnostic — the throttle window survives an OHD
   * restart because it lives in configService, not in memory.
   *
   * @returns {Promise<object>}  One of:
   *   { ran: true,  at: '<ISO>', deleted, wouldDelete, skipped, errors: [] }
   *   { ran: false, reason: 'disabled' | 'root-path' | 'throttled' }
   */
  async _sweepOldFiles(client, remotePath, localBasePath, options) {
    const opts = options || {};
    // Sweep-scoped option names (`enabled`, `ageDays`, `dryRun`,
    // `lastSweepAt`). scanAndDownload maps its download-scope names
    // (`sweepEnabled`, `sweepAgeDays`, `sweepDryRun`) to these when
    // calling — the sweep-prefix only exists at the download boundary
    // where several sub-features coexist.
    //
    // Off by default: any falsy `enabled` short-circuits.
    if (!opts.enabled) {
      return { ran: false, reason: 'disabled' };
    }

    // Throttle: skip if the last successful sweep is within the last
    // 24 hours. Invalid / missing / non-string values treated as
    // "never run" — the string constraint matters because Date.parse
    // coerces non-string arguments to strings (Date.parse(12345)
    // becomes year-12345, which is finite and in the future) and would
    // silently throttle every scan with no operator-visible signal.
    const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
    if (typeof opts.lastSweepAt === 'string' && opts.lastSweepAt) {
      const lastMs = Date.parse(opts.lastSweepAt);
      if (Number.isFinite(lastMs) && lastMs > 0 && lastMs <= Date.now() && (Date.now() - lastMs) < MIN_INTERVAL_MS) {
        return { ran: false, reason: 'throttled' };
      }
    }

    // SAFETY 1: refuse at root or empty. Exact wording locked by test.
    const normRemote = typeof remotePath === 'string' ? remotePath.trim() : '';
    if (!normRemote || normRemote.replace(/\/+$/, '') === '') {
      logger.logWarning(
        'FTP retention sweep refused: Remote Path is "/" (root). ' +
        'Configure a specific remote folder in FTP Server settings (e.g. "/orders") ' +
        'to enable the sweep. Sweeping the FTP root could delete files belonging ' +
        'to Pixfizz Core or other systems.',
      );
      return { ran: false, reason: 'root-path' };
    }

    const ageDays = typeof opts.ageDays === 'number' && opts.ageDays > 0 ? opts.ageDays : 7;
    const cutoffMs = Date.now() - ageDays * MIN_INTERVAL_MS;
    const dryRun = !!opts.dryRun;
    const stats = { deleted: 0, wouldDelete: 0, skipped: 0, errors: [] };

    await this._sweepDirectory(client, normRemote, localBasePath, cutoffMs, dryRun, stats);

    const at = new Date().toISOString();
    logger.info('FTP retention sweep complete', {
      remotePath: normRemote, ageDays, dryRun,
      deleted: stats.deleted, wouldDelete: stats.wouldDelete,
      skipped: stats.skipped, errors: stats.errors.length,
      at,
    });
    return { ran: true, at, ...stats };
  }

  /**
   * Recursive helper for _sweepOldFiles. See that method's docblock for
   * the safety contract. Kept private (underscore prefix) but exposed on
   * the service export solely so callers can compose their own sweep if
   * they need to (e.g., an operator-triggered one-off).
   */
  async _sweepDirectory(client, remotePath, localBasePath, cutoffMs, dryRun, stats) {
    let items;
    try {
      items = await client.list(remotePath);
    } catch (listErr) {
      logger.logError('FTP retention sweep: list failed', listErr, { remotePath });
      stats.errors.push({ remotePath, error: listErr.message });
      return;
    }

    for (const item of items) {
      // SAFETY 2: never traverse outside — reject anything that could
      // escape or is otherwise malformed. Empty names, path separators,
      // and the two dot-forms are the whole set of items that could
      // move us off the configured subtree.
      if (!item.name || item.name === '.' || item.name === '..' || /[/\\]/.test(item.name)) {
        logger.logWarning('FTP retention sweep: skipping suspicious item name',
          { remotePath, name: item.name });
        stats.skipped++;
        continue;
      }

      const remoteItemPath = remotePath.replace(/\/+$/, '') + '/' + item.name;

      if (item.isDirectory) {
        await this._sweepDirectory(client, remoteItemPath,
          path.join(localBasePath, item.name), cutoffMs, dryRun, stats);
        continue;
      }

      // SAFETY 3: age from remote mtime. basic-ftp exposes modifiedAt
      // (Date) on servers that support MLSD; falls back to `date` on
      // LIST-only servers. Skip items with neither — we cannot safely
      // age them.
      const rawMtime = item.modifiedAt || item.date;
      if (!rawMtime) {
        logger.logDebug('FTP retention sweep: no mtime on item, skipping',
          { remoteItemPath });
        stats.skipped++;
        continue;
      }
      const mtimeMs = rawMtime instanceof Date
        ? rawMtime.getTime()
        : Date.parse(rawMtime);
      if (!Number.isFinite(mtimeMs)) {
        logger.logDebug('FTP retention sweep: unparseable mtime, skipping',
          { remoteItemPath, rawMtime });
        stats.skipped++;
        continue;
      }

      if (mtimeMs >= cutoffMs) {
        // Not old enough — leave it alone.
        continue;
      }

      // SAFETY 4: never delete a file OHD hasn't itself downloaded +
      // verified. Local path is built with the same Windows-basename
      // sanitiser the download loop uses so we look at the actual file
      // OHD wrote (see _sanitiseWindowsBasename docblock for the
      // Pixfizz-Core-escapes-parens case).
      const localItemPath = path.join(localBasePath, _sanitiseWindowsBasename(item.name));
      if (!fs.existsSync(localItemPath)) {
        logger.logDebug('FTP retention sweep: no local copy, skipping',
          { remoteItemPath, localItemPath });
        stats.skipped++;
        continue;
      }
      let localSize;
      try {
        localSize = fs.statSync(localItemPath).size;
      } catch (statErr) {
        logger.logDebug('FTP retention sweep: local stat failed, skipping',
          { remoteItemPath, error: statErr.message });
        stats.skipped++;
        continue;
      }
      if (localSize !== item.size) {
        logger.logDebug('FTP retention sweep: local size mismatch, skipping',
          { remoteItemPath, localSize, remoteSize: item.size });
        stats.skipped++;
        continue;
      }

      // Candidate. Age computed once here so both the dry-run log and
      // the real-delete log carry the same value.
      const ageInDays = Math.floor((Date.now() - mtimeMs) / (24 * 60 * 60 * 1000));
      const mtimeIso  = new Date(mtimeMs).toISOString();

      if (dryRun) {
        logger.info('FTP retention sweep [dry-run]: would delete',
          { remoteItemPath, ageDays: ageInDays, mtime: mtimeIso });
        stats.wouldDelete++;
        continue;
      }

      try {
        await client.remove(remoteItemPath);
        logger.info('FTP retention sweep: deleted',
          { remoteItemPath, ageDays: ageInDays, mtime: mtimeIso });
        stats.deleted++;
      } catch (delErr) {
        logger.logError('FTP retention sweep: delete failed', delErr,
          { remoteItemPath, ageDays: ageInDays, mtime: mtimeIso });
        stats.errors.push({ remoteItemPath, error: delErr.message });
      }
    }
  }

  /**
   * List files in directory
   */
  async listFiles(credentials, remotePath = '/') {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
      await client.access({
        host: credentials.host,
        port: credentials.port || 21,
        user: credentials.user,
        password: credentials.password,
        secure: false
      });

      const fileList = await client.list(remotePath);
      return fileList;
    } catch (error) {
      logger.logError('Failed to list FTP directory', error, { remotePath });
      throw error;
    } finally {
      client.close();
    }
  }
}

const ftpService = new FtpService();

// Expose private file-level helpers for diagnostics + tests. These are not
// part of the public service API; consumers go through ftpService methods.
ftpService._markIntegritySuspect = markIntegritySuspect;
ftpService._shouldIntegrityCheck = shouldIntegrityCheck;
ftpService._INTEGRITY_CHECK_EXTENSIONS = INTEGRITY_CHECK_EXTENSIONS;
ftpService._isExpected550OnOriginalFiles = _isExpected550OnOriginalFiles;
ftpService._handleFtpDeleteFailure = _handleFtpDeleteFailure;
ftpService._sanitiseWindowsBasename = _sanitiseWindowsBasename;
ftpService._computeFtpSweepSaveWarnings = _computeFtpSweepSaveWarnings;

// _sweepOldFiles + _sweepDirectory are already instance methods; no need
// to re-export them here. They ARE the retention sweep's public surface
// for tests.

module.exports = ftpService;
