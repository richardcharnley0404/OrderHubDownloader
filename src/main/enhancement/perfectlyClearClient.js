'use strict';

/**
 * src/main/enhancement/perfectlyClearClient.js
 *
 * Shared hot-folder client for Perfectly Clear QuickServer. Used by all
 * three OHD scopes (Jobs, Film Scans, File Uploads); routes a batch of
 * images through one QuickServer channel and returns a per-file result.
 *
 * QuickServer channel contract (see docs/perfectly-clear-quickserver-*):
 *
 *   Input     ── QuickServer watches this folder; subfolder tree and file
 *                names are MIRRORED into Output.
 *   Output    ── successful results appear here under the same subfolder.
 *   Rejected  ── non-processable files (corrupt, empty-with-.jpg, unknown
 *                type) end up here under the same subfolder.
 *
 * There is no documented done-signal, and hot folders often live on SMB
 * shares, so this client is polling-only (`fs.readdir` — never chokidar
 * native events) with per-file stability polling (size+mtime stable across
 * 2 consecutive polls) before consuming a result.
 *
 * Public API
 * ──────────
 *   processBatch({
 *     config,          // { inputFolder, outputFolder, rejectedFolder, friendlyName }
 *     files,           // [{ sourcePath, destPath }]  — destPath = where the
 *                      //   enhanced result must land; sourcePath is not
 *                      //   modified regardless of outcome.
 *     timeoutMs,       // wall-clock timeout for the whole batch
 *     onFileDone,      // optional ({ sourcePath, status, error? }) per-file
 *                      //   progress callback fired as each file resolves
 *     signal,          // optional AbortSignal for cancellation
 *     pollIntervalMs,  // optional override (default 1500 ms) — tests use
 *                      //   a much smaller value; production callers should
 *                      //   leave it defaulted
 *   }) => Promise<[
 *     { sourcePath, destPath, status: 'enhanced'|'rejected'|'timeout'|'cancelled', error? },
 *     …
 *   ]>
 *
 * Behaviour
 * ─────────
 *   1. Unique batch subfolder `ohd_{machineId}_{ts}_{rand}` is created under
 *      Input. `machineId` comes from the persistent electron-store key
 *      `_machineId` (same value backup-service uses for host isolation),
 *      with a sanitised hostname fallback. Uniqueness means concurrent
 *      batches — even across OHD PCs sharing a QuickServer channel —
 *      cannot collide.
 *   2. Each source file is copied into the batch subfolder via a
 *      `{name}.tmp_{pid}_{rand}` temp file, then `fs.rename` into place.
 *      QuickServer never sees a half-copied file.
 *   3. Every `pollIntervalMs`, the batch subfolders under Output and
 *      Rejected are enumerated. Each matching file must exhibit the same
 *      `{size, mtimeMs}` across two consecutive polls before it is
 *      consumed — the same guard the film-scan watcher already uses.
 *   4. An enhanced file is copied to its caller-supplied `destPath` via
 *      the same temp-then-rename pattern (so the destination file is
 *      atomic from the pipeline's point of view). A rejected file leaves
 *      `destPath` untouched.
 *   5. The batch resolves as soon as every file has been accounted for OR
 *      the wall-clock timeout fires OR the AbortSignal is triggered.
 *      Unaccounted files become `timeout` / `cancelled` respectively.
 *   6. Cleanup is best-effort: `fs.rm(recursive:true, force:true)` on all
 *      three batch subfolders in a `finally` block. Cleanup errors are
 *      logged but never thrown.
 *
 * All log lines carry a `pc:` prefix. Failure of a single file never
 * prevents accounting for other files in the same batch.
 */

const fs      = require('fs/promises');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');

const configService = require('../services/config-service');
const logger        = require('../services/logger');

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS       = 5 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return a short, filesystem-safe machine tag for use in batch subfolder
 * names. Prefer the persistent `_machineId` UUID that backup-service uses
 * for host isolation; fall back to a sanitised hostname; fall back to
 * 'unknown' if both are unavailable (tests, sandboxes).
 */
function _machineTag() {
  let raw = '';
  try {
    raw = (configService.get && configService.get('_machineId')) || '';
  } catch (_) { /* config-service unavailable — fall through */ }
  if (!raw) {
    const host = (os.hostname() || '').split('.')[0];
    raw = host.replace(/[^A-Za-z0-9_-]/g, '');
  }
  if (!raw) raw = 'unknown';
  // UUIDs are 36 chars; trim to a compact prefix that still gives ~10^14
  // collision resistance when combined with ts+rand.
  return String(raw).replace(/-/g, '').slice(0, 12);
}

function _makeBatchName() {
  return `ohd_${_machineTag()}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function _copyViaTemp(srcPath, dstPath) {
  const tmpName = path.basename(dstPath) +
    '.tmp_' + process.pid + '_' + crypto.randomBytes(3).toString('hex');
  const tmpPath = path.join(path.dirname(dstPath), tmpName);
  await fs.copyFile(srcPath, tmpPath);
  try {
    await fs.rename(tmpPath, dstPath);
  } catch (err) {
    // If rename fails for any reason, clean up the stray temp file so we
    // don't leave garbage in the caller's folder.
    try { await fs.unlink(tmpPath); } catch (_) { /* ignore */ }
    throw err;
  }
}

async function _statFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st : null;
  } catch (_) {
    return null;
  }
}

async function _bestEffortRemove(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    try {
      logger.logWarning && logger.logWarning(`pc: cleanup failed for ${dir}: ${err.message}`);
    } catch (_) { /* logger itself may be a stub in tests — ignore */ }
  }
}

function _safeCallback(cb, arg) {
  if (typeof cb !== 'function') return;
  try {
    cb(arg);
  } catch (err) {
    try {
      logger.logWarning && logger.logWarning(`pc: onFileDone threw: ${err.message}`);
    } catch (_) { /* ignore */ }
  }
}

function _sleepRacingAbort(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0) { resolve(); return; }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve();
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Round-trip a batch of image files through a QuickServer channel.
 * See file-header docblock for the full contract.
 */
async function processBatch(opts = {}) {
  const {
    config,
    files,
    timeoutMs,
    onFileDone,
    signal,
    pollIntervalMs,
  } = opts;

  if (!config || !config.inputFolder || !config.outputFolder || !config.rejectedFolder) {
    throw new Error('pc: processBatch requires a config with inputFolder, outputFolder, and rejectedFolder');
  }
  if (!Array.isArray(files)) {
    throw new Error('pc: processBatch requires files: Array<{sourcePath, destPath}>');
  }
  if (files.length === 0) return [];

  const pollMs   = (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) ? pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const wallMs   = (Number.isFinite(timeoutMs)      && timeoutMs      > 0) ? timeoutMs      : DEFAULT_TIMEOUT_MS;
  const friendly = config.friendlyName || '(unnamed)';

  const batchName        = _makeBatchName();
  const batchInputDir    = path.join(config.inputFolder,    batchName);
  const batchOutputDir   = path.join(config.outputFolder,   batchName);
  const batchRejectedDir = path.join(config.rejectedFolder, batchName);

  // Build per-file records, keyed by the basename we stage under.
  const records = files.map((f, idx) => {
    if (!f || !f.sourcePath || !f.destPath) {
      throw new Error(`pc: files[${idx}] must have both sourcePath and destPath`);
    }
    return {
      sourcePath:         f.sourcePath,
      destPath:           f.destPath,
      inputName:          path.basename(f.sourcePath),
      status:             'pending',   // 'enhanced' | 'rejected' | 'timeout' | 'cancelled'
      error:              null,
      lastOutputSig:      null,        // { size, mtimeMs } from previous poll
      lastRejectedSig:    null,
    };
  });

  const recordByName = new Map();
  for (const r of records) {
    if (recordByName.has(r.inputName)) {
      throw new Error(
        `pc: duplicate input filename '${r.inputName}' in batch — caller must ensure ` +
        `unique basenames across a single processBatch call`
      );
    }
    recordByName.set(r.inputName, r);
  }

  try {
    logger.info && logger.info(
      `pc: batch ${batchName} starting (config="${friendly}", files=${records.length}, ` +
      `timeoutMs=${wallMs}, pollMs=${pollMs})`
    );
  } catch (_) { /* logger stub */ }

  const startedAt = Date.now();

  // 1. Stage all input files (temp + rename) before any polling starts.
  await fs.mkdir(batchInputDir, { recursive: true });
  try {
    for (const r of records) {
      const finalPath = path.join(batchInputDir, r.inputName);
      await _copyViaTemp(r.sourcePath, finalPath);
    }
  } catch (err) {
    try {
      logger.logError && logger.logError(`pc: batch ${batchName} failed during input staging`, err);
    } catch (_) { /* ignore */ }
    // Nothing has been reported to onFileDone yet, so let the caller see the
    // raw error. Still clean up whatever we may have created.
    await _bestEffortRemove(batchInputDir);
    await _bestEffortRemove(batchOutputDir);
    await _bestEffortRemove(batchRejectedDir);
    throw err;
  }

  // 2. If the caller aborted before we started polling, short-circuit.
  if (signal && signal.aborted) {
    for (const r of records) {
      r.status = 'cancelled';
      _safeCallback(onFileDone, { sourcePath: r.sourcePath, status: 'cancelled' });
    }
    await _bestEffortRemove(batchInputDir);
    await _bestEffortRemove(batchOutputDir);
    await _bestEffortRemove(batchRejectedDir);
    return records.map(_toResult);
  }

  // 3. Poll output + rejected for stable arrivals.
  let pending = records.length;

  function markDone(record, status, error) {
    record.status = status;
    if (error) record.error = error;
    pending -= 1;
    _safeCallback(onFileDone, {
      sourcePath: record.sourcePath,
      status,
      ...(error ? { error } : {}),
    });
  }

  async function pollOnce() {
    let outEntries = [];
    let rejEntries = [];
    try { outEntries = await fs.readdir(batchOutputDir);   } catch (_) { outEntries = []; }
    try { rejEntries = await fs.readdir(batchRejectedDir); } catch (_) { rejEntries = []; }

    // Output — matching files with a stable signature get copied out and
    // marked 'enhanced'.
    for (const name of outEntries) {
      const record = recordByName.get(name);
      if (!record || record.status !== 'pending') continue;
      const filePath = path.join(batchOutputDir, name);
      const st = await _statFile(filePath);
      if (!st) continue;
      const sig = { size: st.size, mtimeMs: st.mtimeMs };
      const prev = record.lastOutputSig;
      if (prev && prev.size === sig.size && prev.mtimeMs === sig.mtimeMs) {
        // Stable — consume it.
        try {
          await fs.mkdir(path.dirname(record.destPath), { recursive: true });
          await _copyViaTemp(filePath, record.destPath);
          markDone(record, 'enhanced');
        } catch (err) {
          // Copy-back failed — surface as a per-file 'rejected' with an error
          // message so the caller can keep working with the original. This
          // is a client-side failure, not a QuickServer verdict, so we log
          // it distinctly.
          try {
            logger.logError && logger.logError(
              `pc: batch ${batchName} copy-back failed for ${name} → ${record.destPath}`, err);
          } catch (_) { /* ignore */ }
          markDone(record, 'rejected', `copy-back failed: ${err.message}`);
        }
      } else {
        record.lastOutputSig = sig;
      }
    }

    // Rejected — stability check still applies; QuickServer might be
    // mid-write when we first see the file.
    for (const name of rejEntries) {
      const record = recordByName.get(name);
      if (!record || record.status !== 'pending') continue;
      const filePath = path.join(batchRejectedDir, name);
      const st = await _statFile(filePath);
      if (!st) continue;
      const sig = { size: st.size, mtimeMs: st.mtimeMs };
      const prev = record.lastRejectedSig;
      if (prev && prev.size === sig.size && prev.mtimeMs === sig.mtimeMs) {
        markDone(record, 'rejected');
      } else {
        record.lastRejectedSig = sig;
      }
    }
  }

  let aborted = signal && signal.aborted;
  const onAbort = () => { aborted = true; };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (pending > 0) {
      if (aborted) break;
      if (Date.now() - startedAt >= wallMs) break;

      await pollOnce();
      if (pending === 0) break;
      if (aborted) break;
      if (Date.now() - startedAt >= wallMs) break;

      const remaining = wallMs - (Date.now() - startedAt);
      const waitMs    = Math.max(0, Math.min(pollMs, remaining));
      await _sleepRacingAbort(waitMs, signal);
    }

    // Any records still pending → assign the terminal reason.
    const finalReason = aborted ? 'cancelled' : 'timeout';
    for (const r of records) {
      if (r.status === 'pending') markDone(r, finalReason);
    }
  } finally {
    if (signal) {
      try { signal.removeEventListener('abort', onAbort); } catch (_) { /* ignore */ }
    }
    await _bestEffortRemove(batchInputDir);
    await _bestEffortRemove(batchOutputDir);
    await _bestEffortRemove(batchRejectedDir);
  }

  const counts = {
    enhanced:  records.filter(r => r.status === 'enhanced').length,
    rejected:  records.filter(r => r.status === 'rejected').length,
    timeout:   records.filter(r => r.status === 'timeout').length,
    cancelled: records.filter(r => r.status === 'cancelled').length,
  };
  try {
    logger.info && logger.info(
      `pc: batch ${batchName} finished (` +
      `enhanced=${counts.enhanced}, rejected=${counts.rejected}, ` +
      `timeout=${counts.timeout}, cancelled=${counts.cancelled}, ` +
      `wallMs=${Date.now() - startedAt})`
    );
  } catch (_) { /* logger stub */ }

  return records.map(_toResult);
}

function _toResult(r) {
  const out = {
    sourcePath: r.sourcePath,
    destPath:   r.destPath,
    status:     r.status,
  };
  if (r.error) out.error = r.error;
  return out;
}

module.exports = {
  processBatch,
  // Test-only handles — not part of the public API.
  _makeBatchName,
  _machineTag,
};
