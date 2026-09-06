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
// 2026-07-23 — bound any single I/O op (readdir / stat / copy-back). A
// hung SMB share must not be able to consume the whole batch's remaining
// wall-clock via one stuck syscall. Callers can override.
const DEFAULT_PER_OP_TIMEOUT_MS = 30 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Marker error raised when `_withDeadline` fires. Callers can distinguish
 * a genuine I/O failure from "the syscall never came back in time" and
 * decide how to escalate. Keeps the error message actionable in logs.
 */
class DeadlineError extends Error {
  constructor(op, ms) {
    super(`pc: ${op} deadline (${ms} ms) exceeded`);
    this.name    = 'DeadlineError';
    this.op      = op;
    this.timeout = ms;
  }
}

/**
 * Race a promise against a timeout. If `promise` doesn't settle within
 * `ms`, the returned promise rejects with a DeadlineError. `ms <= 0`
 * disables the deadline (returns the promise unchanged). Used to
 * guarantee the batch loop can't wedge on a hung fs op on an SMB share.
 *
 * Note: this does NOT cancel the underlying promise — Node fs ops
 * aren't cancellable. It just stops us waiting for it. In practice the
 * underlying handle unblocks eventually and its resolution is discarded.
 */
function _withDeadline(promise, ms, op = 'op') {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new DeadlineError(op, ms)), ms);
    // unref so a stuck deadline handle doesn't hold the event loop open
    // past app shutdown when the underlying op is the only thing pending.
    if (typeof t.unref === 'function') t.unref();
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

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

async function _copyViaTemp(srcPath, dstPath, deadlineMs) {
  const tmpName = path.basename(dstPath) +
    '.tmp_' + process.pid + '_' + crypto.randomBytes(3).toString('hex');
  const tmpPath = path.join(path.dirname(dstPath), tmpName);
  try {
    // 2026-07-23 — copyFile can hang on a wedged SMB share. Bound it so
    // one stuck file can't consume the whole remaining wall clock.
    await _withDeadline(fs.copyFile(srcPath, tmpPath), deadlineMs, 'copyFile');
    await _withDeadline(fs.rename(tmpPath, dstPath),   deadlineMs, 'rename');
  } catch (err) {
    // Any failure (deadline, rename error, copy error) → clean up the
    // stray temp file so we don't litter the caller's folder. Best-effort
    // cleanup uses its own tight deadline so cleanup itself can't hang.
    try {
      await _withDeadline(fs.unlink(tmpPath), Math.min(5000, deadlineMs || 5000), 'unlink');
    } catch (_) { /* ignore — stale temp files are cosmetic vs. the batch's outcome */ }
    throw err;
  }
}

async function _statFile(p, deadlineMs) {
  try {
    const st = await _withDeadline(fs.stat(p), deadlineMs, 'stat');
    return st.isFile() ? st : null;
  } catch (_) {
    // Deadline or genuine stat failure — both mean "not observable this
    // poll" from the caller's perspective. Next poll will retry.
    return null;
  }
}

async function _bestEffortRemove(dir, deadlineMs) {
  try {
    // 2026-07-23 — the batch's happy-path cleanup runs against the same
    // SMB share that just hosted a potentially-slow QuickServer. Bound
    // it so a hung rm can't hold the whole processBatch open past its
    // deadline. Errors (including DeadlineError) are swallowed exactly
    // as before — cleanup is best-effort by contract.
    await _withDeadline(fs.rm(dir, { recursive: true, force: true }), deadlineMs, 'rm');
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
    // 2026-07-23 — per-op deadline (readdir / stat / copyFile / rename /
    // unlink). Bounds recovery time when a hot-folder share hangs.
    // Undefined / non-positive → use DEFAULT_PER_OP_TIMEOUT_MS.
    perOpTimeoutMs,
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
  const perOpMs  = (Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0) ? perOpTimeoutMs : DEFAULT_PER_OP_TIMEOUT_MS;
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
  //
  // DeadlineErrors during setup — the mkdir here or a per-file copyFile /
  // rename inside `_copyViaTemp` — mean the target filesystem is too slow
  // for the configured `perOpMs`. Pre-2026-09-06 these escaped as
  // unhandled rejections to the caller (the perfectlyClearClient
  // `hard wall-clock deadline` test at :574 caught this asymmetry against
  // the poll loop, where `readdir` DeadlineErrors are already treated as
  // "observation missed, keep polling"). Setup now handles them the same
  // way — a mkdir deadline skips the staging loop entirely, and a
  // per-file staging deadline skips just that file. Every unstaged file
  // surfaces as `timeout` when the poll loop can't find it and the wall
  // clock expires; that is the same terminal outcome as a server that
  // never responded.
  //
  // Non-DeadlineError failures (EACCES, disk full, ENOENT source, etc.)
  // still surface as raw throws — no wall-clock wait, the caller sees
  // the reason immediately. This is what the `per-op deadline on input
  // staging` test at :613 locks (ENOENT source → fast reject, not a
  // wedge).
  let setupDeadlined = false;
  try {
    await _withDeadline(fs.mkdir(batchInputDir, { recursive: true }), perOpMs, 'mkdir');
  } catch (err) {
    if (err instanceof DeadlineError) {
      setupDeadlined = true;
      try {
        logger.logWarning && logger.logWarning(
          `pc: batch ${batchName} setup mkdir deadline exceeded (${err.timeoutMs}ms); no files will be staged, batch will time out at wall clock`
        );
      } catch (_) { /* logger stub */ }
    } else {
      // Real mkdir error. Nothing has been created and nothing has been
      // reported to onFileDone, so let the caller see the raw error.
      try {
        logger.logError && logger.logError(`pc: batch ${batchName} failed during input staging`, err);
      } catch (_) { /* ignore */ }
      throw err;
    }
  }

  if (!setupDeadlined) {
    try {
      for (const r of records) {
        const finalPath = path.join(batchInputDir, r.inputName);
        try {
          await _copyViaTemp(r.sourcePath, finalPath, perOpMs);
        } catch (err) {
          if (err instanceof DeadlineError) {
            // Per-file staging deadline — this file is unstaged; the
            // poll loop will not observe it in output / rejected, and
            // it will be marked `timeout` at wall clock. Continue with
            // the next record so other files still get their chance.
            try {
              logger.logWarning && logger.logWarning(
                `pc: batch ${batchName} staging deadline exceeded for ${r.inputName} (op: ${err.op}, ${err.timeoutMs}ms); file will time out`
              );
            } catch (_) { /* logger stub */ }
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      try {
        logger.logError && logger.logError(`pc: batch ${batchName} failed during input staging`, err);
      } catch (_) { /* ignore */ }
      // Nothing has been reported to onFileDone yet, so let the caller
      // see the raw error. Clean up whatever we may have created.
      await _bestEffortRemove(batchInputDir,    perOpMs);
      await _bestEffortRemove(batchOutputDir,   perOpMs);
      await _bestEffortRemove(batchRejectedDir, perOpMs);
      throw err;
    }
  }

  // 2. If the caller aborted before we started polling, short-circuit.
  if (signal && signal.aborted) {
    for (const r of records) {
      r.status = 'cancelled';
      _safeCallback(onFileDone, { sourcePath: r.sourcePath, status: 'cancelled' });
    }
    await _bestEffortRemove(batchInputDir,    perOpMs);
    await _bestEffortRemove(batchOutputDir,   perOpMs);
    await _bestEffortRemove(batchRejectedDir, perOpMs);
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
    // 2026-07-23 — bound each readdir. On SMB / dead-share the sync can
    // hang forever; a DeadlineError just means "nothing new observable
    // this poll", which is indistinguishable from the empty-folder case.
    try { outEntries = await _withDeadline(fs.readdir(batchOutputDir),   perOpMs, 'readdir(output)');   } catch (_) { outEntries = []; }
    try { rejEntries = await _withDeadline(fs.readdir(batchRejectedDir), perOpMs, 'readdir(rejected)'); } catch (_) { rejEntries = []; }

    // Output — matching files with a stable signature get copied out and
    // marked 'enhanced'.
    for (const name of outEntries) {
      const record = recordByName.get(name);
      if (!record || record.status !== 'pending') continue;
      const filePath = path.join(batchOutputDir, name);
      const st = await _statFile(filePath, perOpMs);
      if (!st) continue;
      const sig = { size: st.size, mtimeMs: st.mtimeMs };
      const prev = record.lastOutputSig;
      if (prev && prev.size === sig.size && prev.mtimeMs === sig.mtimeMs) {
        // Stable — consume it.
        try {
          await _withDeadline(fs.mkdir(path.dirname(record.destPath), { recursive: true }), perOpMs, 'mkdir(dest)');
          await _copyViaTemp(filePath, record.destPath, perOpMs);
          markDone(record, 'enhanced');
        } catch (err) {
          // Copy-back failed — surface as a per-file 'rejected' with an error
          // message so the caller can keep working with the original. This
          // is a client-side failure, not a QuickServer verdict, so we log
          // it distinctly. DeadlineError bubbles through the same path so
          // a hung SMB during copy-back doesn't wedge the batch — the file
          // is rejected with a clear "deadline exceeded" message and the
          // stray temp file in the destination is cleaned up by
          // _copyViaTemp's finally-block-equivalent.
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
      const st = await _statFile(filePath, perOpMs);
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

      // 2026-07-23 — race the whole pollOnce against the remaining wall
      // clock. Per-op deadlines above bound individual syscalls; this is
      // the belt that stops any residual work (async gaps, unref'd
      // handles, JS spins) from carrying the batch past its deadline.
      // A DeadlineError here just means "cut this poll short and let the
      // outer while check terminate the batch" — we already log the error
      // detail as a warning so operators can see what stalled.
      const remainingBeforePoll = Math.max(0, wallMs - (Date.now() - startedAt));
      try {
        await _withDeadline(pollOnce(), remainingBeforePoll, 'pollOnce');
      } catch (err) {
        try {
          logger.logWarning && logger.logWarning(
            `pc: batch ${batchName} pollOnce cut short: ${err.message}`
          );
        } catch (_) { /* logger stub */ }
        // Fall through — the outer wall-clock check on the next iteration
        // will terminate the batch immediately.
      }
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
    await _bestEffortRemove(batchInputDir,    perOpMs);
    await _bestEffortRemove(batchOutputDir,   perOpMs);
    await _bestEffortRemove(batchRejectedDir, perOpMs);
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
  DeadlineError,
  // Test-only handles — not part of the public API.
  _makeBatchName,
  _machineTag,
  _withDeadline,
  DEFAULT_PER_OP_TIMEOUT_MS,
};
