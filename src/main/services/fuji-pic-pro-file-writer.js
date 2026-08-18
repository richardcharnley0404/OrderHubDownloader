'use strict';

/**
 * src/main/services/fuji-pic-pro-file-writer.js
 *
 * The disk-writing half of Fuji PIC Pro dispatch. Split into four
 * discrete steps so the state machine in `fuji-pic-pro-monitor.js`
 * can call each one at the right phase of the OrderGateway handshake:
 *
 *   1. `stageImages`     — sequence-rename source images into
 *                          {imageStagingRoot}/{orderId}/ as
 *                          0001.<ext>, 0002.<ext>, …
 *   2. `writeOrderFile`  — atomic `.tmp` + rename of {orderId}.txt
 *                          into Order Data.
 *   3. `deliverToDigin`  — folder rename of the staged folder into
 *                          DIGIN. Falls back to recursive copy on
 *                          EXDEV (cross-volume).
 *   4. `writeCommandFile` — plain write of `[command]{orderId}` with
 *                          a timestamped filename.
 *
 * All four functions accept a `deps` object for dependency injection
 * (fs, fsPromises, logger, clock) so the tests can drive real tmpdir
 * I/O without touching Electron. The default deps use `node:fs` /
 * `node:fs/promises` directly.
 *
 * See docs/fuji-pic-pro-claude-code-brief.md §M3 for the sequence-
 * rename + EXDEV + do-not-auto-create-folders rationale.
 */

const path = require('node:path');
const nodeFs         = require('node:fs');
const nodeFsPromises = require('node:fs/promises');

const CMD_FILENAME_PREFIX = 'ohd_';
const ORDER_FILE_TMP_SUFFIX = '.tmp';

// ── stageImages ─────────────────────────────────────────────────────────────

/**
 * Sequence-rename `imageFiles` into `{imageStagingRoot}/{orderId}/` as
 * 0001.<ext>, 0002.<ext>, … in the input order. The source extension is
 * preserved (case-lowered so DIGIN's case-sensitive Frontier build
 * doesn't reject `.JPG` vs `.jpg` mismatches).
 *
 * @param {object}  args
 * @param {string}  args.imageStagingRoot
 * @param {string}  args.orderId
 * @param {Array<{ sourcePath: string, originalFilename?: string }>} args.imageFiles
 *   Manifest order matters — the position in this array becomes the
 *   `NegNumber` in the order.txt. `originalFilename` (the customer's
 *   upload name, if known) is echoed back in the negNumberMap so the
 *   caller can answer "which file is 0007?" after the fact.
 * @param {object}  [args.deps]
 * @returns {Promise<{
 *   stagingFolder: string,
 *   negNumberMap: Array<{
 *     negNumber:        string,   // '0001', '0002', ...
 *     sourcePath:       string,
 *     originalFilename: string,
 *     stagedName:       string,   // '0001.jpg'
 *     stagedPath:       string,   // {stagingFolder}/{stagedName}
 *   }>,
 * }>}
 */
async function stageImages({
  imageStagingRoot,
  orderId,
  imageFiles,
  deps = {},
}) {
  const fs         = deps.fs         || nodeFs;
  const fsPromises = deps.fsPromises || nodeFsPromises;

  if (!imageStagingRoot) throw new Error('Fuji PIC Pro writer: `imageStagingRoot` is required');
  if (!orderId)          throw new Error('Fuji PIC Pro writer: `orderId` is required');
  if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
    throw new Error('Fuji PIC Pro writer: `imageFiles` must contain at least one image');
  }
  for (let i = 0; i < imageFiles.length; i++) {
    const img = imageFiles[i];
    if (!img || !img.sourcePath) {
      throw new Error(`Fuji PIC Pro writer: imageFiles[${i}] is missing sourcePath`);
    }
  }

  // Staging root MUST exist. mkdir recursive would auto-create a
  // typoed root and leave a legit-looking folder on the wrong disk;
  // fail loudly instead so the operator sees the misconfig.
  if (!fs.existsSync(imageStagingRoot)) {
    throw new Error(`Fuji PIC Pro writer: imageStagingRoot does not exist: ${imageStagingRoot}`);
  }

  const stagingFolder = path.join(imageStagingRoot, orderId);
  // Fuji PIC Pro review fix 8. Wipe any leftover files from a
  // previous partial attempt before staging. Without this, a retry
  // after a failed dispatch could ship stale `000N.<oldext>` files
  // — the extension in the previous attempt would bind to the
  // spec-mandated ext-less `NegNumber` and print the wrong picture
  // (spec p. 347: NegNumber is filename minus extension). Also
  // prevents staging from growing without bound across retries.
  //
  // Safe to `rm -rf`: the per-order staging folder is OHD-owned
  // scratch space (unlike `imageStagingRoot` which is operator-
  // configured and must exist — the guard above enforces that).
  await fsPromises.rm(stagingFolder, { recursive: true, force: true });
  await fsPromises.mkdir(stagingFolder, { recursive: true });

  const negNumberMap = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const img = imageFiles[i];
    const negNumber = _padNegNumber(i + 1);
    // Preserve extension, lowercase it. path.extname includes the dot,
    // so an extensionless source produces stagedName '0001' which
    // matches the spec's "digital filename with no extension" — but
    // it's rare enough that we don't warn.
    const ext = path.extname(img.sourcePath).toLowerCase();
    const stagedName = `${negNumber}${ext}`;
    const stagedPath = path.join(stagingFolder, stagedName);

    await fsPromises.copyFile(img.sourcePath, stagedPath);

    negNumberMap.push({
      negNumber,
      sourcePath:       img.sourcePath,
      originalFilename: img.originalFilename || '',
      stagedName,
      stagedPath,
    });
  }

  return { stagingFolder, negNumberMap };
}

// ── writeOrderFile ──────────────────────────────────────────────────────────

/**
 * Atomic `.tmp` + rename of the order file into Order Data. Same
 * pattern the JobMaker writer uses for surface files.
 *
 * `orderDataPath` MUST exist — a typoed UNC path silently creating
 * a local folder is worse than a hard failure (OrderGateway would
 * never see the file and the operator would spend hours chasing
 * the ghost).
 *
 * @param {object} args
 * @param {string} args.orderDataPath
 * @param {string} args.filename    e.g. 'ORD-O4YK5Z-1.txt'
 * @param {string} args.contents
 * @param {object} [args.deps]
 * @returns {Promise<{ writtenPath: string }>}
 */
async function writeOrderFile({
  orderDataPath,
  filename,
  contents,
  deps = {},
}) {
  const fs         = deps.fs         || nodeFs;
  const fsPromises = deps.fsPromises || nodeFsPromises;

  if (!orderDataPath)               throw new Error('Fuji PIC Pro writer: `orderDataPath` is required');
  if (!filename)                    throw new Error('Fuji PIC Pro writer: `filename` is required');
  if (typeof contents !== 'string') throw new Error('Fuji PIC Pro writer: `contents` must be a string');
  if (!fs.existsSync(orderDataPath)) {
    throw new Error(`Fuji PIC Pro writer: orderDataPath does not exist: ${orderDataPath}`);
  }

  const writtenPath = path.join(orderDataPath, filename);
  const tmpPath     = writtenPath + ORDER_FILE_TMP_SUFFIX;

  try {
    await fsPromises.writeFile(tmpPath, contents, 'utf-8');
    await fsPromises.rename(tmpPath, writtenPath);
  } catch (err) {
    // Best-effort cleanup of the .tmp on failure — otherwise a
    // subsequent submission attempts to rename over a stale sibling.
    try { await fsPromises.unlink(tmpPath); } catch (_) { /* ignore */ }
    throw err;
  }

  return { writtenPath };
}

// ── deliverToDigin ─────────────────────────────────────────────────────────

/**
 * Move the staged image folder into DIGIN as a single unit so DIGIN
 * never sees a half-copied folder. This is always a same-volume
 * atomic rename — cross-volume delivery is not supported (see the
 * EXDEV branch below for the customer incident that removed it).
 *
 * Co-location of `imageStagingRoot` and `diginPath` is enforced at
 * save time by `probeSameVolume` (below) via the IPC save-controller
 * handler. If we ever reach here at dispatch time with cross-volume
 * paths, it's because a pre-M7b controller was never re-saved after
 * the fix landed — throw with a specific message naming both paths
 * and the fix so the operator sees exactly what to change, rather
 * than falling back to a slow-path that could recreate the deleted
 * bug.
 *
 * DIGIN Path MUST exist — same reasoning as writeOrderFile.
 *
 * **Idempotent** (Fuji PIC Pro review fix 7). The monitor persists
 * the `delivering` phase BEFORE calling this function. A crash
 * between the successful move and the subsequent `_advance('building')`
 * persist would rehydrate the entry in `delivering` and replay the
 * call. Rather than throw on the replay (staging is gone or destFolder
 * exists → old EPERM/EEXIST error), we detect the completed state
 * and treat it as a successful no-op.
 *
 * Detection rules (in order):
 *   - `destFolder` exists and `stagingFolder` is gone → previous
 *     run completed. Return `{ method: 'already-delivered' }`.
 *   - `destFolder` exists AND `stagingFolder` still exists → the
 *     paths conflict (this is not a legitimate replay). Throw so the
 *     operator can decide.
 *   - Neither exists → nothing to deliver from. Throw.
 *   - Only `stagingFolder` exists → normal path, proceed.
 *
 * @param {object} args
 * @param {string} args.stagingFolder
 * @param {string} args.diginPath
 * @param {string} args.orderId
 * @param {object} [args.deps]
 * @returns {Promise<{ destFolder: string, method: 'rename' | 'already-delivered' }>}
 */
async function deliverToDigin({
  stagingFolder,
  diginPath,
  orderId,
  deps = {},
}) {
  const fs         = deps.fs         || nodeFs;
  const fsPromises = deps.fsPromises || nodeFsPromises;
  const log        = deps.logger     || { info: () => {}, warn: () => {}, logWarning: () => {}, logError: () => {} };

  if (!stagingFolder) throw new Error('Fuji PIC Pro writer: `stagingFolder` is required');
  if (!diginPath)     throw new Error('Fuji PIC Pro writer: `diginPath` is required');
  if (!orderId)       throw new Error('Fuji PIC Pro writer: `orderId` is required');
  if (!fs.existsSync(diginPath)) {
    throw new Error(`Fuji PIC Pro writer: diginPath does not exist: ${diginPath}`);
  }

  const destFolder    = path.join(diginPath, orderId);
  const destExists    = fs.existsSync(destFolder);
  const stagingExists = fs.existsSync(stagingFolder);

  // Fix 7: idempotent replay after a crash between move + persist.
  if (destExists && !stagingExists) {
    (log.info || (() => {})).call(log,
      '[fuji-pic-pro] deliverToDigin: destFolder already exists, staging gone — treating as completed prior delivery (idempotent replay)',
      { destFolder, orderId },
    );
    return { destFolder, method: 'already-delivered' };
  }
  if (destExists && stagingExists) {
    // Ambiguous — could be a partial prior delivery, or a name
    // conflict between two dispatches. Refuse to merge.
    throw new Error(
      `Fuji PIC Pro writer: DIGIN destination ${destFolder} already exists AND staging folder still exists — refusing to merge. Investigate manually.`
    );
  }
  if (!stagingExists) {
    throw new Error(`Fuji PIC Pro writer: stagingFolder does not exist: ${stagingFolder}`);
  }

  // Same-volume atomic rename — the only supported delivery path.
  //
  // Before M7b (2026-08-18), an EXDEV fallback copied the staged
  // folder into `{diginPath}/{orderId}.ohdtmp` and then renamed it in
  // place. A comment on that code asserted "Frontier's DIGIN watch
  // ignores it until the rename lands" — that was an assumption about
  // a third-party product written as fact. A customer disproved it:
  // PIC Pro ingested the `.ohdtmp` folder while it was still being
  // copied (producing a blank order) and then ingested the renamed
  // folder (the correct order), duplicating every order.
  //
  // The slow path was removed. Co-location of imageStagingRoot and
  // diginPath is now enforced at save time by probeSameVolume(). A
  // pre-M7b controller that was never re-saved would trip here at
  // dispatch time; we throw with the operator-actionable fix.
  try {
    await fsPromises.rename(stagingFolder, destFolder);
    return { destFolder, method: 'rename' };
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      const msg =
        'Fuji PIC Pro delivery failed: Image Staging Root and DIGIN Path must be on the same volume. ' +
        'The previous cross-volume delivery fallback was removed after PIC Pro was observed ingesting ' +
        'the partial .ohdtmp sibling, producing a blank duplicate order per real order. ' +
        `Configured Image Staging Root: ${stagingFolder}. Configured DIGIN Path: ${diginPath}. ` +
        'Fix: in Settings → Routing → Order Controllers → Edit this controller, move Image Staging Root ' +
        'onto the same volume as DIGIN Path, then Save. Save-time validation now enforces this on new ' +
        'and edited controllers.';
      (log.logError || log.error || (() => {})).call(log,
        '[fuji-pic-pro] deliverToDigin: cross-volume paths — refusing the deprecated slow path',
        { stagingFolder, diginPath, orderId },
      );
      throw new Error(msg);
    }
    throw err;
  }
}

// ── writeCommandFile ──────────────────────────────────────────────────────

/**
 * Drop a command file into Order Data. Filename is
 * `ohd_{command}_{orderId}_{timestamp}.txt`. Spec (p. 359) says the
 * filename is irrelevant to OrderGateway but the timestamp avoids
 * clobbering when the same command lands twice for the same order
 * (e.g. two `[delete]`s in quick succession).
 *
 * Contents are literally `[{command}]{orderId}` with no trailing
 * newline — spec allows either shape.
 *
 * @param {object} args
 * @param {string} args.orderDataPath
 * @param {string} args.command   'release' | 'delete' | 'restart'
 * @param {string} args.orderId
 * @param {object} [args.deps]
 * @returns {Promise<{ writtenPath: string }>}
 */
async function writeCommandFile({
  orderDataPath,
  command,
  orderId,
  deps = {},
}) {
  const fs         = deps.fs         || nodeFs;
  const fsPromises = deps.fsPromises || nodeFsPromises;
  const clock      = deps.clock      || (() => Date.now());

  if (!orderDataPath) throw new Error('Fuji PIC Pro writer: `orderDataPath` is required');
  if (!command)       throw new Error('Fuji PIC Pro writer: `command` is required');
  if (!orderId)       throw new Error('Fuji PIC Pro writer: `orderId` is required');
  if (!fs.existsSync(orderDataPath)) {
    throw new Error(`Fuji PIC Pro writer: orderDataPath does not exist: ${orderDataPath}`);
  }

  const timestamp   = String(clock());
  const filename    = `${CMD_FILENAME_PREFIX}${command}_${orderId}_${timestamp}.txt`;
  const writtenPath = path.join(orderDataPath, filename);
  const contents    = `[${command}]${orderId}`;

  await fsPromises.writeFile(writtenPath, contents, 'utf-8');

  return { writtenPath };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Zero-pad to at least 4 characters. Never triggers the 15-char cap
 * unless a single order somehow exceeds 999,999,999,999 images
 * (which is beyond well past the point of "no").
 */
function _padNegNumber(n) {
  return String(n).padStart(4, '0');
}

/**
 * Save-time co-location probe (M7b). Confirms `pathA` and `pathB` are
 * on the SAME volume by attempting a rename between them — Windows
 * returns EXDEV across volumes, which is the exact operation
 * deliverToDigin's rename does at dispatch. Using the real rename
 * (rather than `fs.statSync().dev`) matches what actually matters:
 * `dev` is unreliable across Windows network shares (SMB reports
 * device numbers that don't map cleanly to volumes, especially for
 * mounted DFS/reparse points).
 *
 * Cleans up the probe file on EVERY exit path — success, cross-volume
 * refusal, unrelated fs error. Never leaves state behind.
 *
 * Never throws for expected outcomes (returns a `{ok, code, error}`
 * shape). Reserving throws for programmer bugs (bad args) keeps the
 * IPC-handler caller's flow simple: one branch on `ok`.
 *
 * @param {string} pathA
 * @param {string} pathB
 * @param {object} [deps]
 * @returns {Promise<{ ok: true } | { ok: false, code: string, error?: string }>}
 */
async function probeSameVolume(pathA, pathB, deps = {}) {
  const fsPromises = deps.fsPromises || nodeFsPromises;
  if (typeof pathA !== 'string' || pathA.length === 0) {
    throw new Error('probeSameVolume: pathA must be a non-empty string');
  }
  if (typeof pathB !== 'string' || pathB.length === 0) {
    throw new Error('probeSameVolume: pathB must be a non-empty string');
  }

  // Uniquify per call so two concurrent probes can't interfere and a
  // leftover from a prior aborted run can't be mistaken for ours.
  const stamp     = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const probeName = `.ohd-volume-probe-${stamp}`;
  const probeA    = path.join(pathA, probeName);
  const probeB    = path.join(pathB, probeName);

  // Best-effort cleanup helper — called from finally. Swallows every
  // error so the primary result is the one the caller sees. Nothing to
  // report either way: probe files are always safe to remove.
  async function _cleanup() {
    for (const p of [probeA, probeB]) {
      try { await fsPromises.unlink(p); } catch (_) { /* ignore */ }
    }
  }

  try {
    // Write the probe in A. If this fails, A is missing / not writable
    // — surface that as its own code rather than as "cross-volume".
    try {
      await fsPromises.writeFile(probeA, '');
    } catch (err) {
      return { ok: false, code: 'pathA-not-writable', error: (err && err.message) || String(err) };
    }
    // Rename A→B. Same volume → succeeds. Cross-volume → EXDEV. Other
    // codes (ENOENT if B is missing, EACCES if B is read-only) surface
    // as their own class so the operator gets a useful message.
    try {
      await fsPromises.rename(probeA, probeB);
    } catch (err) {
      if (err && err.code === 'EXDEV') {
        return { ok: false, code: 'cross-volume' };
      }
      return { ok: false, code: 'pathB-not-writable', error: (err && err.message) || String(err) };
    }
    // Rename B→A. Same-volume by definition (we just went the other
    // way successfully) — if this fails, the FS is in an unusual state
    // (someone else moved the file?) but we can still report success
    // for the volume question. Errors here are swallowed by _cleanup.
    try {
      await fsPromises.rename(probeB, probeA);
    } catch (_) { /* handled by _cleanup */ }
    return { ok: true };
  } finally {
    await _cleanup();
  }
}

module.exports = {
  stageImages,
  writeOrderFile,
  deliverToDigin,
  writeCommandFile,
  probeSameVolume,
  _internals: {
    _padNegNumber,
    CMD_FILENAME_PREFIX,
    ORDER_FILE_TMP_SUFFIX,
  },
};
