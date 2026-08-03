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
const DIGIN_COPY_TMP_SUFFIX = '.ohdtmp';

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
 * never sees a half-copied folder. On a same-volume move this is a
 * cheap atomic rename. Across volumes (network shares landing on a
 * different disk), rename returns EXDEV — we then recursively copy
 * into a `.ohdtmp` sibling, rename that to the final name, and log a
 * warning so the operator can co-locate the paths for future orders.
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
 * @returns {Promise<{ destFolder: string, method: 'rename' | 'copy' | 'already-delivered' }>}
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

  // Fast path — same-volume rename.
  try {
    await fsPromises.rename(stagingFolder, destFolder);
    return { destFolder, method: 'rename' };
  } catch (err) {
    if (!err || err.code !== 'EXDEV') {
      throw err;
    }
    // Cross-volume: fall through to the copy path.
    (log.logWarning || log.warn || (() => {})).call(log,
      '[fuji-pic-pro] staging and DIGIN are on different volumes — falling back to recursive copy. Co-locate for a faster (atomic) rename.',
      { stagingFolder, diginPath, orderId },
    );
  }

  // Slow path — copy into `.ohdtmp`, rename in place, then remove
  // the staging folder. The `.ohdtmp` name means Frontier's DIGIN
  // watch ignores it until the rename lands (Frontier only picks up
  // folders whose names look like OrderIds, not our tmp sibling).
  const tmpDest = destFolder + DIGIN_COPY_TMP_SUFFIX;

  // Fuji PIC Pro review fix 10. Wipe any leftover `.ohdtmp` from a
  // prior interrupted copy BEFORE starting this one. Without this,
  // `_copyDirRecursive` merges into the partial folder — copyFile
  // overwrites matching filenames but files that only appeared in
  // the previous attempt (e.g. a 10-image order that got
  // interrupted at 7, then re-submitted as an 8-image order) stay
  // and get delivered to DIGIN alongside the current order's
  // files.
  try {
    await fsPromises.rm(tmpDest, { recursive: true, force: true });
  } catch (_) { /* nothing there / not-permitted / etc. — copy will surface any real issue */ }

  // Wrap the copy + rename so a failure during either step cleans
  // up the partial `.ohdtmp` — otherwise the next attempt (which
  // now has the fix-10 pre-copy wipe) does the cleanup, but
  // there's no reason to leave the leftover between retries.
  try {
    await _copyDirRecursive(stagingFolder, tmpDest, fsPromises);
    await fsPromises.rename(tmpDest, destFolder);
  } catch (copyErr) {
    try {
      await fsPromises.rm(tmpDest, { recursive: true, force: true });
    } catch (_) { /* best-effort */ }
    throw copyErr;
  }
  // Best-effort cleanup of the now-empty staging folder. If it can't
  // be removed (rare — network glitch), the folder just lingers; the
  // dispatched order is already safely in DIGIN.
  try {
    await fsPromises.rm(stagingFolder, { recursive: true, force: true });
  } catch (cleanupErr) {
    (log.logWarning || log.warn || (() => {})).call(log,
      '[fuji-pic-pro] failed to clean up staging folder after cross-volume delivery',
      { stagingFolder, error: cleanupErr && cleanupErr.message },
    );
  }
  return { destFolder, method: 'copy' };
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
 * Minimal recursive copy — we use it only for the EXDEV fallback in
 * deliverToDigin. `fs.cp` (Node 16+) would do this in one call, but
 * it's still marked experimental in some Electron builds and the
 * behaviour under symlinks / special files is version-dependent.
 * Explicit recursion keeps the semantics obvious: directories become
 * directories, regular files get copied byte-for-byte, everything
 * else (symlinks, device nodes) is ignored — which is fine because
 * a PIC Pro staging folder only ever contains our own copyFile'd
 * JPEGs.
 */
async function _copyDirRecursive(src, dst, fsPromises) {
  await fsPromises.mkdir(dst, { recursive: true });
  const entries = await fsPromises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await _copyDirRecursive(srcPath, dstPath, fsPromises);
    } else if (entry.isFile()) {
      await fsPromises.copyFile(srcPath, dstPath);
    }
    // symlinks, sockets, etc. skipped by design.
  }
}

module.exports = {
  stageImages,
  writeOrderFile,
  deliverToDigin,
  writeCommandFile,
  _internals: {
    _padNegNumber,
    _copyDirRecursive,
    CMD_FILENAME_PREFIX,
    ORDER_FILE_TMP_SUFFIX,
    DIGIN_COPY_TMP_SUFFIX,
  },
};
