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
 * Save-time volume-relationship check (M7c → v1.15.1). Compares the
 * two paths' parsed volume identifiers as PURE STRINGS — no fs I/O, no
 * artefacts written anywhere. Returns a THREE-STATE verdict:
 *
 *   - `certain-same`      — same drive letter, or same UNC host+share.
 *                           A rename between the two paths is guaranteed
 *                           to succeed (barring permissions).
 *   - `certain-different` — different drive letters, or different UNC
 *                           servers. A rename would EXDEV.
 *   - `indeterminate`     — string-alone cannot tell. Includes
 *                           same-server-different-share (two shares on
 *                           `\\labserver1\` might be one physical
 *                           volume or two — you can't tell from names),
 *                           local-vs-UNC (a mapped drive letter can
 *                           point at any share), and unparseable
 *                           strings.
 *
 * ── Why the check is ADVISORY, not authoritative (v1.15.1) ────────────
 *
 * A false "certain-different" verdict on a lab whose two UNC paths are
 * two shares on the same physical volume BLOCKS them from saving a
 * valid controller with no workaround (their DIGIN path is a share
 * root — there is no other folder on that share to stage into). That
 * happened in production. M7c's argument that "a wrong verdict
 * degrades gracefully into the dispatch-time EXDEV guard" was true for
 * a wrong `certain-same`; a wrong `certain-different` isn't graceful,
 * it's a hard block. So the check no longer decides save/no-save.
 *
 * The caller (IPC save-controller) SAVES on every verdict and surfaces
 * a warning when the verdict isn't `certain-same`. The authoritative
 * check is deliverToDigin's dispatch-time EXDEV throw — it already
 * names both paths and the fix, and it runs against the actual
 * filesystem where OHD can't be wrong about what a rename does.
 *
 * ── Why this is a string compare and NOT a filesystem probe ───────────
 *
 * The M7b (2026-08-18) version of this check used a rename-probe: write
 * a probe file in staging, rename it INTO diginPath, rename it back,
 * unlink. Same-day M7c review caught that this is the exact class of
 * bug M7b existed to remove — the probe file appeared INSIDE `diginPath`
 * on every save of a correctly-configured controller. The probe is
 * gone. DO NOT replace this with a filesystem probe of any kind. If
 * the string compare needs to become smarter about some new path shape
 * (a mount-point convention we haven't seen, say), extend the string
 * parsing — never introduce a write into diginPath.
 *
 * ── Verdict rules ─────────────────────────────────────────────────────
 *
 *   Local paths      | drive letter (`C:` from `C:\Fuji\DIGIN`).
 *                    | Case-insensitive.
 *   UNC paths        | `\\host\share`. Case-insensitive on both parts.
 *                    | A bare `\\server\share` with no subpath is a
 *                    | valid volume identifier.
 *   Trailing / mixed | `C:\` / `C:` / `C:/` behave the same;
 *                    | `\\host/share/DIGIN` matches `\\host\share\DIGIN`.
 *
 *   certain-same          | Same drive letter, OR same UNC host+share.
 *   certain-different     | Different drive letters (different physical
 *                         | drives on the same box — EXDEV certain).
 *                         | OR different UNC servers (different physical
 *                         | boxes — EXDEV certain).
 *   indeterminate         | Same UNC server, different shares — the two
 *   (same-server-         |   shares COULD be different exports of the
 *   different-share)      |   same physical volume (rename succeeds) or
 *                         |   different volumes (EXDEV). You cannot
 *                         |   tell from the paths alone, and the shipped
 *                         |   1.15.0 verdict was wrong here in the field
 *                         |   for a real lab configuring
 *                         |   `\\labserver1\Pixfizz Digin Staging`
 *                         |   alongside `\\labserver1\Digin`. Save;
 *                         |   dispatch decides.
 *   indeterminate         | Local vs UNC — a Windows mapped drive letter
 *   (local-vs-unc)        |   can point at any UNC share, so `Z:\x` and
 *                         |   `\\host\share\y` could be the same
 *                         |   physical volume. Save; dispatch decides.
 *   indeterminate         | Unparseable strings (empty, `/etc/foo`, a
 *   (unparseable-a|b)     |   bare `\\server` with no share, `.`,
 *                         |   `relative\path`). Bias to accept — save;
 *                         |   dispatch decides.
 *
 * Non-string input (`null`, `undefined`, numbers, objects) THROWS.
 * Programmer error, not a runtime configuration state — matches the
 * rest of this module's posture on bad arg types.
 *
 * Uses win32 semantics explicitly so the parsing works identically
 * when this runs on a Linux CI host — the PIC Pro delivery it guards
 * is Windows-only, so Windows path semantics are the right ones
 * regardless of where the check itself is executed.
 *
 * @param {string} pathA
 * @param {string} pathB
 * @returns {{ verdict: 'certain-same' }
 *          | { verdict: 'certain-different', code: 'different-drives' | 'different-servers' }
 *          | { verdict: 'indeterminate',     code: 'same-server-different-share' | 'local-vs-unc' | 'unparseable-a' | 'unparseable-b' }}
 */
function isSameVolume(pathA, pathB) {
  if (typeof pathA !== 'string') {
    throw new Error('isSameVolume: pathA must be a string');
  }
  if (typeof pathB !== 'string') {
    throw new Error('isSameVolume: pathB must be a string');
  }
  const a = _parseVolume(pathA);
  const b = _parseVolume(pathB);

  if (a === null) return { verdict: 'indeterminate', code: 'unparseable-a' };
  if (b === null) return { verdict: 'indeterminate', code: 'unparseable-b' };

  // Mixed shape: a mapped drive letter can point at any UNC share, so
  // we can't tell without hitting the filesystem. Bias to accept.
  if (a.kind !== b.kind) {
    return { verdict: 'indeterminate', code: 'local-vs-unc' };
  }

  if (a.kind === 'local') {
    return a.drive === b.drive
      ? { verdict: 'certain-same' }
      : { verdict: 'certain-different', code: 'different-drives' };
  }

  // Both UNC. Different servers = different physical boxes = certain.
  if (a.host !== b.host) {
    return { verdict: 'certain-different', code: 'different-servers' };
  }
  // Same server, same share = certain-same. Same server, different
  // shares = INDETERMINATE (the shipped 1.15.0 bug was calling this
  // certain-different and hard-rejecting the save).
  return a.share === b.share
    ? { verdict: 'certain-same' }
    : { verdict: 'indeterminate', code: 'same-server-different-share' };
}

/**
 * Parse a Windows-style path into its volume identifier. Returns:
 *   - `{ kind: 'local', drive: 'c:' }`             — drive-letter path
 *   - `{ kind: 'unc', host: 'lab', share: 'x' }`  — UNC path
 *   - `null`                                       — unparseable
 *
 * Lowercases host / share / drive so the returned shape is directly
 * comparable with `===`. Callers treat null as "unknown — accept and
 * defer to dispatch".
 */
function _parseVolume(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  // Normalise: '/' → '\', then strip any trailing separators so
  // `C:\` / `C:` and `\\host\share\` / `\\host\share` behave the same.
  const norm = p.replace(/\//g, '\\').replace(/\\+$/, '');
  if (norm.length === 0) return null;

  // UNC: starts with exactly two backslashes, then host, then share.
  if (norm.startsWith('\\\\')) {
    const afterMark  = norm.slice(2);
    const firstSlash = afterMark.indexOf('\\');
    if (firstSlash === -1) return null;                    // bare `\\server`, no share
    const host       = afterMark.slice(0, firstSlash);
    const afterHost  = afterMark.slice(firstSlash + 1);
    if (host.length === 0 || afterHost.length === 0) return null;
    const shareEnd   = afterHost.indexOf('\\');
    const share      = shareEnd === -1 ? afterHost : afterHost.slice(0, shareEnd);
    if (share.length === 0) return null;
    return { kind: 'unc', host: host.toLowerCase(), share: share.toLowerCase() };
  }

  // Local: `X:` optionally followed by more. Drive letter is [A-Za-z].
  if (/^[A-Za-z]:/.test(norm)) {
    return { kind: 'local', drive: norm.slice(0, 2).toLowerCase() };
  }

  // Anything else — POSIX path, bare `.`, relative path, gibberish —
  // is a shape we don't confidently recognise.
  return null;
}

module.exports = {
  stageImages,
  writeOrderFile,
  deliverToDigin,
  writeCommandFile,
  isSameVolume,
  _internals: {
    _padNegNumber,
    _parseVolume,
    CMD_FILENAME_PREFIX,
    ORDER_FILE_TMP_SUFFIX,
  },
};
