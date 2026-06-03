/**
 * Pure (testable) implementations of the Order XML IPC handlers.
 *
 * Why a separate module: ipcMain.handle bodies aren't easy to unit-test, and
 * the retry-failed flow has enough moving parts (find record, find hot folder,
 * move file back to watch folder, delete sidecar, rewrite record) that it
 * really wants its own tests. Each export here takes its dependencies as
 * arguments — no module-level singletons — so the test file can drive them
 * with in-memory fakes.
 *
 * The thin ipcMain.handle wrappers in src/main/ipc-handlers.js call into
 * these functions and stringify the result for the renderer. Keep the IPC
 * layer dumb and this layer smart.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// listRecords
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.ingestionStore - getDefaultInstance() instance
 * @param {object} args - { filters?, limit?, offset? }
 * @returns {{ ok: true, records: object[], total: number }}
 */
function listRecords({ ingestionStore }, args = {}) {
  const filters = args.filters || {};
  const records = ingestionStore.list({
    filters,
    limit:  args.limit,
    offset: args.offset,
  });
  return {
    ok:      true,
    records,
    total:   ingestionStore.count(filters),
  };
}

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

/**
 * Surface enough state for the panel header chip + the settings dialog
 * "currently running" indicator.
 */
function getStatus({ ingestionStore, configService, pollingService }) {
  const enabledFolders = configService.getEnabledHotFolders();
  return {
    ok:                  true,
    enabled:             Boolean(configService.get('orderXmlEnabled')),
    autoSyncMinutes:     configService.get('orderXmlAutoSyncMinutes'),
    lastCheckTime:       pollingService && pollingService.getStatus
                          ? (pollingService.getStatus().lastOrderXmlCheck || null)
                          : null,
    runningHotFolders:   enabledFolders.length,
    recordCount:         ingestionStore.count(),
  };
}

// ---------------------------------------------------------------------------
// clearRecords
// ---------------------------------------------------------------------------

function clearRecords({ ingestionStore }) {
  ingestionStore.clear();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// retryFailed
// ---------------------------------------------------------------------------

/**
 * Move a previously-failed XML back to its hot folder's watch directory so the
 * chokidar watcher picks it up and re-runs the full pipeline. Also removes
 * the .error.json sidecar so we don't leave orphaned metadata behind.
 *
 * The new attempt creates a fresh ingestion record on completion. The old
 * failed record is removed — leaving it behind would mislead the operator
 * (they'd see a "failed" row even though the file is being re-tried).
 *
 * @param {object} deps
 * @param {object} deps.ingestionStore
 * @param {object} deps.configService
 * @param {object} args - { id: string }
 * @returns {{ ok: boolean, error?: string, restoredTo?: string }}
 */
function retryFailed({ ingestionStore, configService }, { id } = {}) {
  if (!id) return { ok: false, error: 'id is required' };

  const record = ingestionStore.getById(id);
  if (!record) return { ok: false, error: 'record not found' };
  if (record.status !== 'failed') {
    return { ok: false, error: `record is not in failed state (status=${record.status})` };
  }
  if (!record.filePath) {
    return { ok: false, error: 'record has no filePath — cannot locate XML' };
  }

  // Locate the hot folder config so we know where to move the XML to.
  const hotFolder = (configService.getAllHotFolders() || [])
    .find((hf) => hf.id === record.hotFolderId);
  if (!hotFolder) {
    return { ok: false, error: `hot folder ${record.hotFolderId} no longer exists in config` };
  }
  if (!hotFolder.watchFolder) {
    return { ok: false, error: `hot folder "${hotFolder.label}" has no watchFolder` };
  }

  const failedXmlPath = record.filePath;
  if (!fs.existsSync(failedXmlPath)) {
    return { ok: false, error: `failed XML no longer exists at ${failedXmlPath}` };
  }

  // Resolve a destination filename in the watch folder. If a file with the
  // same name is already there (rare, but possible on retry-after-redrop),
  // append a suffix rather than overwrite.
  const filename = path.basename(failedXmlPath);
  let destPath = path.join(hotFolder.watchFolder, filename);
  if (fs.existsSync(destPath)) {
    const ext  = path.extname(filename);
    const base = path.basename(filename, ext);
    let n = 1;
    while (fs.existsSync(path.join(hotFolder.watchFolder, `${base}_retry${n}${ext}`))) n++;
    destPath = path.join(hotFolder.watchFolder, `${base}_retry${n}${ext}`);
  }

  // Move the XML and delete the sidecar.
  try {
    fs.mkdirSync(hotFolder.watchFolder, { recursive: true });
    fs.renameSync(failedXmlPath, destPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Cross-device — copy then unlink.
      try {
        fs.copyFileSync(failedXmlPath, destPath);
        fs.unlinkSync(failedXmlPath);
      } catch (cpErr) {
        return { ok: false, error: `failed to move XML: ${cpErr.message}` };
      }
    } else {
      return { ok: false, error: `failed to move XML: ${err.message}` };
    }
  }

  const sidecar = `${failedXmlPath}.error.json`;
  if (fs.existsSync(sidecar)) {
    try { fs.unlinkSync(sidecar); } catch { /* non-fatal */ }
  }

  // Drop the failed record. The new attempt will write a fresh one.
  ingestionStore.removeById(id);

  return { ok: true, restoredTo: destPath };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  listRecords,
  getStatus,
  clearRecords,
  retryFailed,
};
