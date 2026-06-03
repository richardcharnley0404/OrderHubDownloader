'use strict';

/**
 * src/main/jobs/customerOriginalsActions.js
 *
 * Resolve + verify + shell-out implementations of the two Customer Originals
 * IPC channels. Lifted out of ipc-handlers.js so the existence-check contract
 * is testable without a full Module.prototype.require stub of the IPC layer.
 *
 * Both functions:
 *   1. Validate args (jobPath + originalFilename are strings, non-empty).
 *   2. Resolve the manifest-relative path to an absolute path via
 *      path.join(path.dirname(jobPath), originalFilename).
 *   3. Verify the file exists; return { ok:false, error:'not-found' } if not.
 *   4. Call the supplied shell function and translate its result/throw into
 *      a structured { ok:true | false, error? } return.
 *
 * The shell + fs handles are dependency-injected so tests can stub them.
 * The default factory (`createDefaultActions`) is what ipc-handlers.js uses
 * in production.
 */

const path = require('node:path');
const fsConstants = require('node:fs').constants;
const fsPromises = require('node:fs/promises');

function _validateArgs(jobPath, originalFilename) {
  if (!jobPath || typeof jobPath !== 'string') {
    return { ok: false, error: 'jobPath is required' };
  }
  if (!originalFilename || typeof originalFilename !== 'string') {
    return { ok: false, error: 'originalFilename is required' };
  }
  return null;
}

function _resolveAbs(jobPath, originalFilename) {
  return path.join(path.dirname(jobPath), originalFilename);
}

/**
 * Build the two action functions with explicit dependencies. Tests pass
 * stubs; production passes Electron's `shell` and the real fs/promises.
 *
 * @param {object} deps
 * @param {{ openPath: (p:string)=>Promise<string>, showItemInFolder: (p:string)=>void }} deps.shell
 * @param {(p:string)=>Promise<void>} [deps.access]   - defaults to fs/promises.access
 * @param {object} [deps.logger]   - optional logger with .logError(msg, err, meta)
 * @returns {{ openOriginal: Function, revealOriginal: Function }}
 */
function createCustomerOriginalsActions({ shell, access, logger } = {}) {
  if (!shell || typeof shell.openPath !== 'function' || typeof shell.showItemInFolder !== 'function') {
    throw new Error('createCustomerOriginalsActions: shell must expose openPath and showItemInFolder');
  }
  const fsAccess = typeof access === 'function'
    ? access
    : (p) => fsPromises.access(p, fsConstants.F_OK);
  const log = logger || { logError: () => { /* no-op */ } };

  async function openOriginal({ jobPath, originalFilename } = {}) {
    const argErr = _validateArgs(jobPath, originalFilename);
    if (argErr) return argErr;
    const abs = _resolveAbs(jobPath, originalFilename);
    try {
      await fsAccess(abs);
    } catch {
      return { ok: false, error: 'not-found' };
    }
    try {
      // shell.openPath returns '' on success, or an error string on failure.
      const errMsg = await shell.openPath(abs);
      if (errMsg) return { ok: false, error: errMsg };
      return { ok: true };
    } catch (err) {
      log.logError('[original:open] shell.openPath failed', err, { abs });
      return { ok: false, error: err.message || 'open failed' };
    }
  }

  async function revealOriginal({ jobPath, originalFilename } = {}) {
    const argErr = _validateArgs(jobPath, originalFilename);
    if (argErr) return argErr;
    const abs = _resolveAbs(jobPath, originalFilename);
    try {
      await fsAccess(abs);
    } catch {
      return { ok: false, error: 'not-found' };
    }
    try {
      shell.showItemInFolder(abs);
      return { ok: true };
    } catch (err) {
      log.logError('[original:reveal] shell.showItemInFolder failed', err, { abs });
      return { ok: false, error: err.message || 'reveal failed' };
    }
  }

  return { openOriginal, revealOriginal };
}

module.exports = {
  createCustomerOriginalsActions,
  // Exported for direct testing — the validation + resolution paths.
  _validateArgs,
  _resolveAbs,
};
