'use strict';

// SEE ALSO src/main/services/ftp-service.js — it constructs its own
// basic-ftp sessions (one per public method call). Any change to how
// sessions are constructed there (client options, `client.access`
// arguments — timeouts, secure/TLS, encoding, passive-mode) MUST be
// mirrored HERE or one FTP server will silently work only via
// whichever caller happens to match its expectations. BACKLOG.md
// notes the eventual fix (a shared `withSession(credentials, fn)`
// helper on ftp-service.js) — not now.
const path = require('path');
const fs   = require('fs');
const ftp  = require('basic-ftp');
const logger            = require('./logger');
const encryptionService = require('./encryption-service');

/**
 * src/main/services/ftp-source-service.js
 *
 * The pure-ish core for the generic "FTP sources" file mover (M2 of
 * docs/ftp-sources-brief.md). Given ONE source config from
 * `configService.getFtpSources()` (raw shape, includes
 * `passwordEncrypted`), runs a single pass:
 *
 *   1. Open ONE basic-ftp session for the whole pass.
 *   2. List `remotePath` — FILES ONLY, NON-RECURSIVE for v1
 *      (brief §M2 scopes this explicitly).
 *   3. For each file:
 *      a. Pre-check destination: if the real-named file already exists
 *         at `localPath`, count as skipped, warn, continue. Never
 *         overwrite (brief §Guardrails).
 *      b. Sweep any stale `.<name>.part` left over from a prior crash.
 *      c. Download to `.<name>.part` in `localPath`.
 *      d. Rename into place via `fs.link` + `fs.unlink` — atomic
 *         "move iff target doesn't exist" on BOTH POSIX and Windows.
 *         `fs.rename` overwrites silently on POSIX (Windows throws
 *         EEXIST) — link+unlink is the cross-platform primitive that
 *         matches the brief's never-overwrite mandate exactly, and
 *         closes the race window between the step-3a check and step-3d
 *         rename.
 *      e. Only AFTER the local move succeeds AND `deleteAfterDownload`
 *         is true, delete the remote file. Never delete the remote
 *         copy before the local file is safely at its final name.
 *   4. Close the session.
 *
 * Returns `{ moved, skipped, failed, errors[] }` where each
 * `errors[i] = { filename, message }`. `filename === null` marks a
 * whole-pass failure (connect / auth / list) — M5's per-pass logger
 * uses that discriminator to log at ERROR (whole-pass) vs WARN
 * (per-file), and the M4 UI surfaces it in the "last result" cell.
 *
 * Scope boundary. This service NEVER touches `job-service`,
 * `routing-service`, `print-service`, or `runAutoPrint`. Files moved
 * by this service do not become jobs, do not appear on the Jobs grid,
 * are not routed, are not dispatched. The pass ends when the file is
 * on local disk.
 *
 * Session management. Holds ONE `basic-ftp` client open for the whole
 * pass (1 connect vs the 2N+1 connects a strict ftp-service reuse
 * would need). See BACKLOG.md "`basic-ftp` client construction is
 * duplicated" for the design trade-off.
 *
 * Encryption unavailable. `encryption-service.decrypt` falls back to
 * returning the input verbatim when safeStorage isn't available (the
 * CLAUDE.md landmine); on an M1-encrypted source that means we'd
 * pass the base64 ciphertext string to `access({ password: … })` and
 * the FTP server would reject the login. The whole-pass error would
 * then be a login failure, which is a legible-enough surface for the
 * operator to diagnose. The sanitiser at save time is where we
 * PREVENT plaintext ever landing in the store — this module trusts
 * the store shape M1 created.
 */

// Default deps kept behind a factory so tests can substitute per-call
// without global monkey-patching. Production callers use
// `runFtpSourcePass(source)` with no `deps` arg.
const DEFAULT_DEPS = Object.freeze({
  createClient:      () => new ftp.Client(),
  fs:                fs,
  encryptionService: encryptionService,
  logger:            logger,
});

// Rename-fallback control (2026-08-15).
//
// `fs.link` requires hard-link support on the destination filesystem.
// Local NTFS handles it fine, but the primary use case for this feature
// is "watch an FTP folder, drop files onto a lab share" — the local
// destination is typically an SMB/UNC path. SMB shares commonly reject
// hard-link creation with EPERM (Samba, some Windows Server versions)
// or ENOTSUP (POSIX-behaved shares). EXDEV is the "cross-device" case
// that shouldn't fire in-directory but is included for the same reason
// EEXIST is caught in the primary path — defensive breadth is cheap.
//
// When link fails with one of these codes we fall back to fs.rename
// after re-checking the target is still absent. On Windows (our
// deployment target) fs.rename throws EEXIST if the target exists, so
// the re-check + rename gives us the same never-overwrite guarantee
// there. On POSIX fs.rename would silently overwrite — the re-check
// narrows the race window but doesn't eliminate it; that's a
// deployment-platform trade-off we accept because Windows is where
// this code actually runs.
const _RENAME_FALLBACK_CODES = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV']);

// Log-once-per-source set for the "destination uses rename fallback"
// INFO line. Module-scoped so it persists across passes for the same
// source (which is what the brief's "once per source" means — the
// operator wants to know the mode once, not on every polling tick).
// Set grows monotonically at one string per source-ever-fallen-back —
// negligible. Never cleared on source delete; a re-created source with
// the same id won't re-log, but ids are uuids so re-use is a
// non-issue in practice. Exposed via a test-only reset helper so unit
// tests can assert on the log-once contract deterministically.
const _renameFallbackLogged = new Set();

function _shouldLogFallbackFor(sourceId) {
  if (_renameFallbackLogged.has(sourceId)) return false;
  _renameFallbackLogged.add(sourceId);
  return true;
}

function _clearFallbackLoggedForTests() {
  _renameFallbackLogged.clear();
}

/**
 * Run one pass over one source config.
 *
 * @param {object} source - raw shape from `configService.getFtpSources()`.
 *   Required: name, host, port, username, passwordEncrypted, remotePath,
 *   localPath, deleteAfterDownload. `enabled` is not consulted here —
 *   the scheduler (M3) is responsible for only calling for enabled
 *   sources.
 * @param {object} [deps] - injectable dependencies for tests.
 *   `createClient()` returns something with the basic-ftp Client shape
 *   (`ftp.verbose`, `access`, `list`, `downloadTo`, `remove`, `close`).
 * @returns {Promise<{moved:number, skipped:number, failed:number, errors:Array<{filename:string|null, message:string}>}>}
 */
async function runFtpSourcePass(source, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const summary = { moved: 0, skipped: 0, failed: 0, errors: [] };

  const password = d.encryptionService.decrypt(source.passwordEncrypted || '');

  const client = d.createClient();
  // MIRROR ftp-service.js: verbose off. See the file-top comment — any
  // change to `client.ftp.*` options here must be mirrored in
  // ftp-service.js (and vice versa) or one caller will silently work
  // where the other doesn't.
  client.ftp.verbose = false;

  try {
    await client.access({
      host:     source.host,
      port:     source.port || 21,
      user:     source.username,
      password: password,
      // MIRROR ftp-service.js — `secure: false` hardcoded there in every
      // access() call. The source config's `secure` field is stored for
      // forward-compat (M1) but ignored at the transport layer until
      // ftp-service adds FTPS support. If that changes, update both
      // files in lockstep.
      secure:   false,
    });

    let listing;
    try {
      listing = await client.list(source.remotePath);
    } catch (err) {
      // List failure is a whole-pass error, not per-file — the operator
      // needs to know the remote path is wrong / the auth is stale /
      // the server is down. filename:null tags it as such for M5.
      d.logger.logError('[ftp-sources] failed to list remote folder', err, {
        sourceName: source.name,
        host:       source.host,
        remotePath: source.remotePath,
      });
      summary.errors.push({ filename: null, message: `list ${source.remotePath}: ${err.message}` });
      return summary;
    }

    // Files only, non-recursive. `basic-ftp` marks directory entries
    // with `isDirectory` and file entries with `isFile`; be strict and
    // filter on `isFile === true` so a future entry type (symlink,
    // socket) doesn't accidentally get treated as a file.
    const files = (Array.isArray(listing) ? listing : []).filter((e) => e && e.isFile === true);

    for (const file of files) {
      const filename   = file.name;
      const remoteFile = _joinRemotePath(source.remotePath, filename);
      const finalPath  = path.join(source.localPath, filename);
      const tempPath   = path.join(source.localPath, '.' + filename + '.part');

      try {
        // Pre-check: if the real-named file already exists at the
        // destination, do not overwrite. The brief calls this the
        // "worst failure mode" — silently clobbering a file some other
        // process is using. Skip + warn is the correct posture.
        if (d.fs.existsSync(finalPath)) {
          summary.skipped++;
          d.logger.logWarning('[ftp-sources] destination file already exists — skipped', {
            sourceName: source.name,
            filename,
            finalPath,
          });
          continue;
        }

        // Sweep stale `.part` from a prior crashed pass. Only WE write
        // to `.<name>.part` in this directory (leading dot + `.part`
        // suffix), so it's safe to delete. Doing this here keeps the
        // download step below simple — basic-ftp's downloadTo would
        // fail on some servers if the local file exists.
        if (d.fs.existsSync(tempPath)) {
          d.fs.unlinkSync(tempPath);
        }

        await client.downloadTo(tempPath, remoteFile);

        // Move-into-place. Primary path is `fs.link` + `fs.unlink` — the
        // portable "move iff target doesn't exist" primitive (EEXIST on
        // both POSIX and Windows). Fallback for SMB/UNC destinations
        // (which reject hard-link creation with EPERM/ENOTSUP/…) is a
        // re-check + fs.rename. See _RENAME_FALLBACK_CODES for the
        // rationale and the platform trade-off.
        try {
          await d.fs.promises.link(tempPath, finalPath);
          // Link succeeded — remove the temp so we don't leave a
          // hardlink pair. Kept BEFORE the fallback branch below so
          // the happy path is byte-identical to the pre-fallback code.
          await d.fs.promises.unlink(tempPath);
        } catch (linkErr) {
          if (_RENAME_FALLBACK_CODES.has(linkErr.code)) {
            // Destination doesn't support hard links (typically an
            // SMB/UNC share, the primary use case). Fall back to
            // fs.rename after re-checking the target is still absent
            // — that's the narrowest race window we can achieve
            // without a portable atomic move-no-overwrite syscall.
            if (d.fs.existsSync(finalPath)) {
              // Between our pre-download check and here, someone
              // else's process wrote to the destination. Never
              // clobber — clean up temp and fail this file.
              try { d.fs.unlinkSync(tempPath); } catch (_cleanupErr) { /* best-effort */ }
              const raceErr = new Error(`destination file appeared during download — refusing to overwrite: ${finalPath}`);
              raceErr.code = 'EEXIST';
              throw raceErr;
            }
            if (_shouldLogFallbackFor(source.id)) {
              // Once per source, at INFO — the brief's "do not silently
              // degrade without a log" requirement. Operators need to
              // know which mode a destination is in; a rename fallback
              // means an SMB/UNC share (or an odd filesystem) which
              // has slightly weaker overwrite guarantees on POSIX than
              // the link path. On Windows this is still safe (rename
              // throws EEXIST on target-exists) so the log is
              // informational, not a warning.
              d.logger.info(
                '[ftp-sources] destination does not support hard links — falling back to fs.rename for this source',
                {
                  sourceName:    source.name,
                  localPath:     source.localPath,
                  linkErrorCode: linkErr.code,
                },
              );
            }
            try {
              await d.fs.promises.rename(tempPath, finalPath);
              // rename moves the file — no separate unlink needed.
            } catch (renameErr) {
              try { d.fs.unlinkSync(tempPath); } catch (_cleanupErr) { /* best-effort */ }
              throw renameErr;
            }
          } else {
            // EEXIST (race in the primary path) or any other
            // unexpected error. Never clobber — clean up temp and
            // let the per-file try below count this as failed.
            try { d.fs.unlinkSync(tempPath); } catch (_cleanupErr) { /* best-effort */ }
            throw linkErr;
          }
        }

        // Remote delete is ONLY safe after the local file is at its
        // final name. A failure here is NOT counted as a per-file
        // failure — the file DID land locally. On the next pass we'll
        // re-list, hit the "destination file already exists" branch,
        // and skip it. Not ideal (the file will keep showing up until
        // the remote is manually removed) but not data loss and not
        // enough of a signal to fail the whole pass.
        if (source.deleteAfterDownload) {
          try {
            await client.remove(remoteFile);
          } catch (remErr) {
            d.logger.logWarning('[ftp-sources] downloaded, but remote delete failed — file will re-appear next pass', {
              sourceName: source.name,
              filename,
              remoteFile,
              error:      remErr.message,
            });
          }
        }

        summary.moved++;
      } catch (fileErr) {
        // Per-file failure. downloadTo threw, link failed with EEXIST
        // (race), or an unexpected fs error. Neither the temp file
        // nor the real-named file must be left in a half-written
        // state — link+unlink guarantees that. Best-effort clean any
        // temp we may have left behind.
        try {
          if (d.fs.existsSync(tempPath)) d.fs.unlinkSync(tempPath);
        } catch (_cleanupErr) { /* best-effort */ }

        summary.failed++;
        summary.errors.push({ filename, message: fileErr.message });
        d.logger.logWarning('[ftp-sources] file failed', {
          sourceName: source.name,
          filename,
          error:      fileErr.message,
        });
      }
    }
  } catch (err) {
    // Whole-pass failure — connect refused, auth rejected, network
    // dropped between access() and list(). Distinct from per-file
    // failures above (which land in summary.errors with a filename set).
    d.logger.logError('[ftp-sources] pass failed', err, {
      sourceName: source.name,
      host:       source.host,
    });
    summary.errors.push({ filename: null, message: err.message });
  } finally {
    // Always close, even on early return via the list-failure branch
    // above (that branch's `return summary` runs the finally on its
    // way out, per JS semantics).
    try {
      client.close();
    } catch (_closeErr) {
      // basic-ftp's close is synchronous and swallow-safe; a throw
      // here would only fire on a truly pathological stub. Not worth
      // surfacing.
    }
  }

  return summary;
}

/**
 * Join a remote directory + filename cleanly. `path.posix.join` would
 * normalise "//foo" → "/foo" which we want, but it also strips a
 * leading double-slash which we don't ever produce in practice.
 * Simple concat + normalise is safer than pulling in `path.posix`
 * semantics that vary by node version.
 */
function _joinRemotePath(dir, filename) {
  if (!dir) return filename;
  if (dir.endsWith('/')) return dir + filename;
  return dir + '/' + filename;
}

module.exports = {
  runFtpSourcePass,
  // Exposed for unit tests only — production callers only need
  // runFtpSourcePass. Keeps _joinRemotePath's tiny surface directly
  // testable without exercising a whole pass; _clearFallbackLoggedForTests
  // lets tests reset the log-once-per-source set between cases so the
  // "logs only once" assertion is deterministic (module-scoped state
  // otherwise leaks across tests).
  _joinRemotePath,
  _clearFallbackLoggedForTests,
};
