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
const nodeCrypto     = require('node:crypto');

const CMD_FILENAME_PREFIX = 'ohd_';
const ORDER_FILE_TMP_SUFFIX = '.tmp';

// N-lite cross-volume delivery (1.15.3). See
// `docs/picpro-cross-volume-investigation.md` for the full design.
// This prefix is load-bearing: PIC Pro's DIGIN watcher is presumed to
// ignore folders whose names don't look like order ids, and this name
// deliberately does not. The presumption is confirmed for the specific
// lab that reported the bug — Tests 1 and 2 from the lab test pack.
const INBOX_PREFIX = '.ohd-inbox-';

// Per-process instance id. Generated at module load, stable for the
// life of the OS process, cleared with the process. The age-based
// sweep uses this to scope cleanup to inboxes THIS OHD process
// created; other-process inboxes are handled by the older-than-
// threshold branch.
const _PROCESS_INSTANCE_ID = nodeCrypto.randomUUID();

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
 * Move the staged image folder into DIGIN. Two paths:
 *
 * 1. **Same volume** — atomic `fs.rename` of staging → DIGIN. Byte-
 *    identical to pre-1.15.3 behaviour. This is the healthy-config
 *    path every co-located lab uses.
 * 2. **Cross volume (EXDEV)** — copy staging → `{diginPath}/.ohd-inbox-*`
 *    (recursive copy, cross-volume), then intra-DIGIN atomic rename
 *    of the inbox → `{orderId}`. See
 *    `docs/picpro-cross-volume-investigation.md` for the design (the
 *    "N-lite" variant) and the two hypotheses it rests on:
 *    (a) PIC Pro's DIGIN watcher ignores folders whose names don't
 *    match an order-id pattern, and (b) OrderGateway is patient
 *    about waiting for the DIGIN folder after consuming the `.txt`.
 *    Both were confirmed at the reporting lab before this shipped.
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
 * @param {string} [args.controllerId] — required to enter the
 *   cross-volume branch (used in the inbox name so the sweep can
 *   scope cleanup). Optional for same-volume calls; if a call
 *   without controllerId hits EXDEV, the writer throws a specific
 *   error naming the missing dep.
 * @param {object} [args.deps]
 * @returns {Promise<{
 *   destFolder: string,
 *   method: 'rename' | 'copy-then-rename' | 'already-delivered',
 *   inboxPath?: string
 * }>}
 */
async function deliverToDigin({
  stagingFolder,
  diginPath,
  orderId,
  controllerId,
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

  // Fast path — same-volume atomic rename. Byte-identical to pre-
  // 1.15.3 behaviour; the tripwires in the writer's test suite lock
  // this. Every co-located lab (i.e. every healthy configuration)
  // takes this branch and sees zero change.
  try {
    await fsPromises.rename(stagingFolder, destFolder);
    return { destFolder, method: 'rename' };
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      return await _deliverViaCrossVolumeInbox({
        stagingFolder,
        diginPath,
        destFolder,
        orderId,
        controllerId,
        deps,
      });
    }
    throw err;
  }
}

/**
 * Internal — the EXDEV cross-volume branch of deliverToDigin.
 *
 * Not exported. Callers reach this via deliverToDigin only, so the
 * same-volume rename-first ordering is preserved. See the design doc
 * for why this is variant "N-lite" and not "N": the copy runs INSIDE
 * `_stepDelivering` (after OrderGateway has consumed the `.txt` and
 * the container exists), not synchronously in dispatch — which keeps
 * the exposure window equal to the copy duration and rests on only
 * the name hypothesis, not container-gating.
 *
 * Failure discipline:
 *   - Copy fails → throw, partial inbox left behind for the age-based
 *     sweep. Do NOT rm here — a network flake in the middle is
 *     another opportunity to race a network hiccup.
 *   - Rename fails → throw, inbox left behind (sweep). Staging is
 *     still intact so retry is safe (fresh inbox on the next call).
 *   - rm-staging fails → warn, return success. The dispatched order
 *     is already safely delivered; a lingering staging folder is
 *     cosmetic.
 */
async function _deliverViaCrossVolumeInbox({
  stagingFolder,
  diginPath,
  destFolder,
  orderId,
  controllerId,
  deps,
}) {
  const fsPromises = deps.fsPromises || nodeFsPromises;
  const log        = deps.logger     || { info: () => {}, warn: () => {}, logWarning: () => {}, logError: () => {} };
  const instanceId = deps.instanceId || _PROCESS_INSTANCE_ID;
  const clock      = deps.clock      || (() => Date.now());
  const rand       = deps.rand       || (() => nodeCrypto.randomBytes(4).toString('hex'));

  if (!controllerId) {
    // A pre-1.15.3 caller reaching the cross-volume path with no
    // controllerId — the inbox name loses its instance-scoping and
    // the sweep can no longer discriminate. Fail loud rather than
    // silently generate a controllerId-less inbox.
    throw new Error(
      'Fuji PIC Pro writer: cross-volume delivery requires `controllerId`. ' +
      `staging=${stagingFolder} digin=${diginPath} orderId=${orderId}. ` +
      'This is an internal wiring error — the monitor should have supplied ' +
      'controllerId from the pending entry.'
    );
  }

  const inboxName = _buildInboxName({
    controllerId,
    instanceId,
    orderId,
    ts: clock(),
    rand: rand(),
  });
  const inboxPath = path.join(diginPath, inboxName);

  // Copy the staged folder into a scratch location inside DIGIN. PIC
  // Pro's watcher does not match on this name (per the empirical
  // test at the reporting lab). No merge container matches it
  // either — the merge container is `{orderId}.con`, which we will
  // land into via the rename below.
  try {
    await _copyDirRecursive(stagingFolder, inboxPath, fsPromises);
  } catch (copyErr) {
    (log.logError || log.error || (() => {})).call(log,
      '[fuji-pic-pro] cross-volume copy failed — partial inbox left for age-based sweep',
      copyErr,
      { stagingFolder, inboxPath, orderId, controllerId },
    );
    throw copyErr;
  }

  // Intra-DIGIN atomic rename. Both sides are inside the same share,
  // so this is a same-volume rename by construction — always atomic.
  // The moment this returns, PIC Pro sees `{orderId}` in DIGIN
  // matching the merge container OrderGateway has already produced.
  try {
    await fsPromises.rename(inboxPath, destFolder);
  } catch (renameErr) {
    (log.logError || log.error || (() => {})).call(log,
      '[fuji-pic-pro] intra-DIGIN rename failed — inbox left for sweep, staging preserved for retry',
      renameErr,
      { inboxPath, destFolder, orderId, controllerId },
    );
    throw renameErr;
  }

  // Best-effort cleanup of the emptied-out staging folder. Failure
  // here is cosmetic — the order is already delivered — so warn
  // and return success.
  try {
    await fsPromises.rm(stagingFolder, { recursive: true, force: true });
  } catch (cleanupErr) {
    (log.logWarning || log.warn || (() => {})).call(log,
      '[fuji-pic-pro] failed to clean up staging folder after cross-volume delivery — dispatched order is fine',
      { stagingFolder, error: cleanupErr && cleanupErr.message },
    );
  }

  return { destFolder, method: 'copy-then-rename', inboxPath };
}

/**
 * Recursive directory copy. Flat structure is the current PIC Pro
 * shape (0001.jpg, 0002.jpg, ...) but the helper is deliberately
 * recursive so a future nested-structure change wouldn't silently
 * lose files.
 *
 * WARNING (recorded in `docs/picpro-cross-volume-investigation.md`
 * under the mtime-resets-the-clock caveat): the age-based sweep's
 * threshold defence assumes writes hit the inbox folder DIRECTLY —
 * which they do while the copy is flat. If nested structure is
 * introduced under the inbox, the parent's mtime does not update
 * during the nested writes, and a long copy could let the parent's
 * own mtime age past the sweep threshold while the copy is still
 * in flight. The threshold (6 hours) has 2× headroom against the
 * worst realistic case (2.8 hours), so this is safe today, but a
 * change to either the threshold or the nesting must be considered
 * jointly.
 */
async function _copyDirRecursive(source, dest, fsPromises) {
  await fsPromises.mkdir(dest, { recursive: true });
  const dirents = await fsPromises.readdir(source, { withFileTypes: true });
  for (const dirent of dirents) {
    const s = path.join(source, dirent.name);
    const d = path.join(dest, dirent.name);
    if (dirent.isDirectory()) {
      await _copyDirRecursive(s, d, fsPromises);
    } else {
      await fsPromises.copyFile(s, d);
    }
  }
}

/**
 * Build the inbox folder name.
 *
 * Naming discipline is load-bearing — the safety property of the
 * cross-volume path is that the inbox name does NOT look like an
 * order id, so PIC Pro's DIGIN watcher ignores it. Throws if the
 * generated name would contain the orderId as a substring (which
 * could happen if the controllerId string happens to include it).
 * That check is defensive — controller ids are `crypto.randomUUID()`
 * so a collision with a real order code is vanishingly unlikely —
 * but the assertion makes the invariant mechanical.
 *
 * Characters are restricted to filesystem-safe on Windows/SMB
 * (`[A-Za-z0-9._]`); anything else in controllerId is replaced with
 * `_`. Instance id has its dashes stripped for readability.
 */
function _buildInboxName({ controllerId, instanceId, orderId, ts, rand }) {
  const safeController = String(controllerId).replace(/[^A-Za-z0-9._]/g, '_');
  const safeInstance   = String(instanceId).replace(/[^A-Za-z0-9]/g, '');
  const name = `${INBOX_PREFIX}${safeController}-${safeInstance}-${ts}-${rand}`;
  if (typeof orderId === 'string' && orderId.length > 0 && name.includes(orderId)) {
    throw new Error(
      'Fuji PIC Pro writer: refusing to build inbox name that contains the order id — the whole safety property of the cross-volume path depends on PIC Pro not matching the name against a real order id. ' +
      `controllerId=${controllerId} orderId=${orderId} generated=${name}`
    );
  }
  return name;
}

/**
 * True iff the given DIRECTORY ENTRY name is an OHD inbox this
 * process owns — i.e., it starts with the well-known prefix, the
 * controllerId matches, and the instanceId matches. Used by the
 * age-based sweep to determine "recent, own-process" scope.
 */
function _isOwnInboxName(name, { controllerId, instanceId }) {
  if (typeof name !== 'string') return false;
  const safeController = String(controllerId).replace(/[^A-Za-z0-9._]/g, '_');
  const safeInstance   = String(instanceId).replace(/[^A-Za-z0-9]/g, '');
  return name.startsWith(`${INBOX_PREFIX}${safeController}-${safeInstance}-`);
}

/** True iff the name starts with the inbox prefix (any owner). */
function _isAnyInboxName(name) {
  return typeof name === 'string' && name.startsWith(INBOX_PREFIX);
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
  // Sweep uses these to scope discovery and cleanup.
  INBOX_PREFIX,
  PROCESS_INSTANCE_ID: _PROCESS_INSTANCE_ID,
  _isOwnInboxName,
  _isAnyInboxName,
  _internals: {
    _padNegNumber,
    _parseVolume,
    _buildInboxName,
    _copyDirRecursive,
    _deliverViaCrossVolumeInbox,
    CMD_FILENAME_PREFIX,
    ORDER_FILE_TMP_SUFFIX,
    INBOX_PREFIX,
  },
};
