'use strict';

/**
 * src/main/services/integrity-quarantine-migration.js
 *
 * One-shot migration for the v1.3.2 integrity-quarantine pivot.
 *
 * The v1.3.0 / v1.3.1 quarantine model renamed corrupt downloads to
 * `<file>.quarantine` and recorded diagnostic data in a per-order
 * `_ohd-quarantine.json` manifest. That model hid suspect files from the
 * print pipeline entirely, costing customers prints they may have wanted.
 *
 * The new "flag and allow" model keeps the file's original extension and
 * stamps an `integritySuspect` block on the per-image sidecar. To bring
 * existing on-disk artifacts forward, this migration:
 *
 *   1. Walks `downloadDirectory` recursively to find every `*.quarantine`
 *      file and every `_ohd-quarantine.json` manifest.
 *   2. For each `.quarantine` file: rename back to original (strip suffix)
 *      and stamp `integritySuspect` on the matching sidecar entry, using
 *      manifest data for the diagnostic fields when available.
 *   3. For each manifest: rename to `_ohd-quarantine.archived.json` so it
 *      survives as an audit record but no code path matches the active
 *      filename.
 *   4. Set `_integrityQuarantineMigratedAt` in config so subsequent
 *      launches skip the walk.
 *
 * Crash safety / idempotency:
 *   - Per-file atomic operations (one rename, then the next).
 *   - Files already restored (no `.quarantine` extension) don't appear in
 *     the find list, so a re-run skips them naturally.
 *   - Sidecar updates are read-modify-write; re-running with the same
 *     manifest data produces the same result.
 *   - The migration flag is set ONLY after the walk completes end-to-end.
 *     A mid-walk crash leaves the flag null; the next launch restarts the
 *     walk from scratch (a no-op for already-restored files, repeatable
 *     for any files that didn't make it through last time).
 *
 * The pure-logic worker `_migrate(downloadDirectory, log)` takes its log
 * sink as a parameter so it can be exercised from a standalone Node test
 * script without dragging the Electron-bound logger into scope.
 */

const fs = require('fs');
const path = require('path');
const { loadSidecar, saveSidecar } = require('../jobs/sidecarManager');
const { createImageEntry } = require('../../shared/jobSchema');

const QUARANTINE_SUFFIX = '.quarantine';
const LEGACY_MANIFEST = '_ohd-quarantine.json';
const ARCHIVED_MANIFEST = '_ohd-quarantine.archived.json';

/**
 * Production entry point. Reads/writes config flag via configService,
 * routes log calls through the Electron-aware logger.
 *
 * Returns one of:
 *   { skipped: true, reason: 'already-migrated' | 'no-download-directory' | 'download-directory-missing' }
 *   { restored: number, archived: number, jobsTouched: number, elapsedMs: number, completedAt: ISO }
 *
 * Throws only if the walk itself can't be started; per-file failures are
 * logged. If the function escapes with an exception, the migrated-at flag
 * is NOT set, so the next launch retries.
 */
async function runIntegrityQuarantineMigration() {
  // Lazy-require the Electron-bound modules so a standalone test loading
  // this file via `require()` doesn't trip on the electron import in
  // ./logger.js. Only `_migrate` is exposed for direct testing.
  const logger = require('./logger');
  const configService = require('./config-service');

  if (configService.get('_integrityQuarantineMigratedAt')) {
    return { skipped: true, reason: 'already-migrated' };
  }

  const downloadDirectory = configService.get('downloadDirectory');
  if (!downloadDirectory) {
    // No download directory configured (fresh install, never set up). Nothing
    // to migrate; mark the flag so we don't keep checking on every launch.
    const ts = new Date().toISOString();
    configService.set('_integrityQuarantineMigratedAt', ts);
    return { skipped: true, reason: 'no-download-directory' };
  }

  if (!fs.existsSync(downloadDirectory)) {
    const ts = new Date().toISOString();
    configService.set('_integrityQuarantineMigratedAt', ts);
    return { skipped: true, reason: 'download-directory-missing' };
  }

  const log = {
    info:  (msg, fields) => logger.info(msg, fields),
    warn:  (msg, fields) => logger.logWarning(msg, fields),
    error: (msg, err, fields) => logger.logError(msg, err, fields),
  };

  const result = await _migrate(downloadDirectory, log);

  // Walk completed without throwing — set the flag so we don't repeat.
  const completedAt = new Date().toISOString();
  configService.set('_integrityQuarantineMigratedAt', completedAt);

  log.info(
    `[migration] Integrity-quarantine pivot: restored ${result.restored} files ` +
    `across ${result.jobsTouched} jobs in ${result.elapsedMs} ms`
  );

  return { ...result, completedAt };
}

/**
 * Pure migration worker. Walks `downloadDirectory`, restores `.quarantine`
 * files, archives manifests. Uses the supplied `log` interface for all
 * structured logging — no global logger import.
 *
 * `log` must implement: { info(msg, fields), warn(msg, fields), error(msg, err, fields) }.
 * A no-op default is provided for tests that don't care about output.
 */
async function _migrate(downloadDirectory, log = NULL_LOG) {
  const startedAt = Date.now();

  const { quarantineFiles, manifests } = _walk(downloadDirectory, log);

  // Pre-parse manifests, keyed by their containing folder. The folder is
  // the OUTER order folder, so a quarantine file at OUTER/INNER/file.jpg.q
  // looks up its manifest by `path.dirname(path.dirname(localPath))`.
  const manifestsByDir = new Map();
  for (const manifestPath of manifests) {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        manifestsByDir.set(path.dirname(manifestPath), parsed);
      } else {
        log.warn('[migration] Legacy manifest had unexpected shape — restores in this folder will use minimal data', {
          manifestPath,
        });
      }
    } catch (err) {
      log.warn('[migration] Could not parse legacy manifest — restores in this folder will use minimal data', {
        manifestPath,
        error: err.message,
      });
    }
  }

  let restored = 0;
  const jobsTouched = new Set();

  for (const quarantinePath of quarantineFiles) {
    const originalPath = quarantinePath.slice(0, -QUARANTINE_SUFFIX.length);
    const originalFilename = path.basename(originalPath);
    const innerJobFolder = path.dirname(originalPath);
    const outerOrderFolder = path.dirname(innerJobFolder);
    const jobId = path.basename(innerJobFolder);

    // Defensive: if a real file already sits at the original path (e.g. a
    // re-download landed there before migration ran, leaving a stale
    // .quarantine sibling), don't overwrite it.
    if (fs.existsSync(originalPath)) {
      log.warn('[migration] Restored target already exists — leaving .quarantine in place', {
        quarantinePath,
        originalPath,
      });
      continue;
    }

    try {
      fs.renameSync(quarantinePath, originalPath);
    } catch (err) {
      log.error('[migration] Failed to rename quarantine file — aborting walk, will retry on next launch', err, {
        quarantinePath,
        originalPath,
      });
      throw err;
    }

    const manifest = manifestsByDir.get(outerOrderFolder);
    const manifestEntry = manifest
      ? manifest.entries.find((e) => e.filename === originalFilename) || null
      : null;

    const suspect = {
      detected: true,
      detectedAt:    manifestEntry ? (manifestEntry.quarantinedAt || null) : null,
      firstBytesHex: manifestEntry ? (manifestEntry.firstBytes ?? null)    : null,
      expectedMagic: manifestEntry ? (manifestEntry.expectedMagic || null) : null,
      ftpRemotePath: manifestEntry ? (manifestEntry.ftpRemotePath || null) : null,
    };

    // Sidecar update is best-effort. A degraded outcome (file restored but
    // no integritySuspect data) is acceptable: the file is back in the
    // print pipeline either way, and AI Quality scoring's graceful-fail
    // surfaces the issue downstream regardless.
    try {
      const { sidecar } = await loadSidecar(jobId, innerJobFolder);
      if (!Array.isArray(sidecar.images)) sidecar.images = [];

      let idx = sidecar.images.findIndex((img) => img.filename === originalFilename);
      if (idx === -1) {
        sidecar.images.push(createImageEntry(originalFilename, 1));
        idx = sidecar.images.length - 1;
      }
      sidecar.images[idx] = {
        ...sidecar.images[idx],
        integritySuspect: suspect,
      };
      await saveSidecar(sidecar, innerJobFolder);
    } catch (err) {
      log.warn('[migration] Could not write integritySuspect to sidecar — file restored, diagnostic data lost', {
        innerJobFolder,
        jobId,
        filename: originalFilename,
        error: err.message,
      });
    }

    restored++;
    jobsTouched.add(jobId);
  }

  // Archive manifests after restoring files. Done in a second pass so a
  // crash mid-restore doesn't leave us with archived manifests but
  // un-restored files (manifests are still readable for the next attempt).
  let archived = 0;
  for (const manifestPath of manifests) {
    const archivedPath = path.join(path.dirname(manifestPath), ARCHIVED_MANIFEST);
    try {
      if (fs.existsSync(archivedPath)) {
        // A previous run already archived; this active manifest is an
        // orphan from a partial re-creation. Drop it.
        fs.unlinkSync(manifestPath);
      } else {
        fs.renameSync(manifestPath, archivedPath);
      }
      archived++;
    } catch (err) {
      log.error('[migration] Failed to archive legacy manifest — aborting, will retry on next launch', err, {
        manifestPath,
        archivedPath,
      });
      throw err;
    }
  }

  return {
    restored,
    archived,
    jobsTouched: jobsTouched.size,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Single-pass recursive walk that collects both kinds of artifacts. Uses
 * an explicit stack to avoid recursion depth concerns on deep trees.
 * Per-directory read failures are logged and skipped (a typical cause is
 * a permission glitch on a stale order folder); the walk continues.
 */
function _walk(rootDir, log) {
  const quarantineFiles = [];
  const manifests = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      log.warn('[migration] Could not read directory — skipping', {
        dir,
        error: err.message,
      });
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(QUARANTINE_SUFFIX)) {
          quarantineFiles.push(full);
        } else if (entry.name === LEGACY_MANIFEST) {
          manifests.push(full);
        }
      }
    }
  }

  return { quarantineFiles, manifests };
}

const NULL_LOG = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

module.exports = {
  runIntegrityQuarantineMigration,
  // Pure worker exposed for standalone testing — production callers should
  // use runIntegrityQuarantineMigration() so the config flag is honored.
  _migrate,
  // Constants exposed for migration-test fixture setup.
  _QUARANTINE_SUFFIX: QUARANTINE_SUFFIX,
  _LEGACY_MANIFEST:   LEGACY_MANIFEST,
  _ARCHIVED_MANIFEST: ARCHIVED_MANIFEST,
};
