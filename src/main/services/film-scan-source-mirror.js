'use strict';

const fs = require('fs');
const path = require('path');

let Store;
try { Store = require('electron-store'); } catch (_) { Store = null; }

/**
 * Film-scan "scanner source folder" mirror (2026-06-26).
 *
 * OPTIONAL, ADDITIVE, UPSTREAM step. When config.filmScansSourceFolder is set,
 * OHD COPIES new/changed roll folders from it into the watch folder, then the
 * existing (unchanged) watch → storage → rotate → upload pipeline takes over.
 * The source folder is NEVER deleted from or modified — it stays the lab's
 * pristine archive. This module deliberately touches NOTHING in the consume
 * pipeline; it only feeds the watch folder.
 *
 * Dedup: a persisted ledger maps each source folder name to a content signature
 * (fileCount : totalBytes : newestMtime). A folder is copied only when it is
 * stable (scanner finished writing), is not already sitting in the watch folder
 * (the pipeline hasn't consumed a prior copy yet), and is either unseen or its
 * content changed since the last ingest (a re-scan under the same name).
 */

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/** Recursive content signature: "<fileCount>:<totalBytes>:<newestMtimeMs>". */
function folderSignature(dirPath) {
  let count = 0, bytes = 0, newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        const st = fs.statSync(full);
        count += 1;
        bytes += st.size;
        const m = Math.max(st.mtimeMs, st.birthtimeMs || 0);
        if (m > newest) newest = m;
      } catch (_) { /* ignore unreadable file */ }
    }
  };
  walk(dirPath);
  return `${count}:${bytes}:${Math.round(newest)}`;
}

/** True if the folder is non-empty and every file is older than cutoffMs. */
function isFolderStable(dirPath, cutoffMs) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch (_) { return false; }
  if (entries.length === 0) return false;
  for (const e of entries) {
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      if (!isFolderStable(full, cutoffMs)) return false;
    } else {
      try {
        const st = fs.statSync(full);
        if (Math.max(st.mtimeMs, st.birthtimeMs || 0) > cutoffMs) return false;
      } catch (_) { return false; }
    }
  }
  return true;
}

/**
 * Decide what to do with one source folder. Pure.
 * @returns 'copy' | 'skip-unstable' | 'skip-watch-busy' | 'skip-unchanged'
 */
function decideIngest({ stable, watchExists, ledgerSig, currentSig }) {
  if (!stable)       return 'skip-unstable';     // scanner still writing
  if (watchExists)   return 'skip-watch-busy';   // prior copy not yet consumed
  if (ledgerSig && ledgerSig === currentSig) return 'skip-unchanged'; // already mirrored
  return 'copy';
}

/** Recursive copy — own helper; does NOT reuse the pipeline's copy logic. */
function copyFolderRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyFolderRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** True if the folder directly contains at least one file (not just subdirs). */
function hasDirectFile(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(e => e.isFile());
  } catch (_) {
    return false;
  }
}

/**
 * Discover the actual roll folders (the ones with images) under the source,
 * supporting two scanner layouts:
 *   - Flat:        source/<roll>/*.tif         → roll = <roll>
 *   - Date-nested: source/<date>/<roll>/*.tif  → roll = <roll>  (date dropped)
 *
 * Rule: a top-level child that directly contains files is itself a roll. A
 * top-level child that contains only subfolders (e.g. a scanner's per-day
 * folder) is a container — we descend ONE level and treat each subfolder as a
 * roll. Rolls are mirrored into the watch folder under their own LEAF name, so
 * the date level is flattened away (which is the layout the pipeline expects).
 *
 * Each entry is { relPath, abs, leaf }. `relPath` (relative to the source) is
 * the dedup ledger key, so two rolls that share a leaf name under different
 * date folders stay distinct. `leaf` is the watch-folder destination name.
 */
function discoverRollFolders(sourceDir) {
  const out = [];
  let top;
  try { top = fs.readdirSync(sourceDir, { withFileTypes: true }); }
  catch (_) { return out; }

  for (const e of top) {
    if (!e.isDirectory()) continue;
    const childAbs = path.join(sourceDir, e.name);
    if (hasDirectFile(childAbs)) {
      out.push({ relPath: e.name, abs: childAbs, leaf: e.name });
      continue;
    }
    // Container (e.g. a date folder) — descend exactly one level.
    let subs;
    try { subs = fs.readdirSync(childAbs, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      out.push({ relPath: `${e.name}/${s.name}`, abs: path.join(childAbs, s.name), leaf: s.name });
    }
  }
  return out;
}

// ── The mirror service ───────────────────────────────────────────────────────

class FilmScanSourceMirror {
  constructor() {
    this._store = null;
  }

  _ledger() {
    if (this._store) return this._store;
    if (!Store) return null;
    this._store = new Store({ name: 'film-scan-ingest', defaults: { ingested: {} } });
    return this._store;
  }

  _getSig(name) {
    const s = this._ledger();
    if (!s) return null;
    return (s.get('ingested', {})[name]) || null;
  }

  _recordSig(name, sig) {
    const s = this._ledger();
    if (!s) return;
    const ing = s.get('ingested', {});
    ing[name] = sig;
    s.set('ingested', ing);
  }

  _pruneLedger(existingNames) {
    const s = this._ledger();
    if (!s) return;
    const ing = s.get('ingested', {});
    let changed = false;
    for (const name of Object.keys(ing)) {
      if (!existingNames.has(name)) { delete ing[name]; changed = true; }
    }
    if (changed) s.set('ingested', ing);
  }

  /** Test/devtools helper — wipe the ingest ledger. */
  _clearLedger() {
    const s = this._ledger();
    if (s) s.set('ingested', {});
  }

  /**
   * Copy new/changed stable folders from the source into the watch folder.
   * Best-effort; never throws. `logger` is injected so this stays loadable
   * without the Electron-bound logger in tests.
   *
   * @returns {{ copied:number, skipped:number, errors:string[] }}
   */
  async mirror(config, logger) {
    const summary = { copied: 0, skipped: 0, errors: [] };
    const source = config && config.filmScansSourceFolder;
    const watch  = config && config.filmScansWatchFolder;
    if (!source || !watch) return summary; // feature off (no source configured)

    if (!fs.existsSync(source)) {
      logger && logger.logWarning && logger.logWarning(`filmScans: scanner source folder missing: ${source}`);
      return summary;
    }
    try { fs.mkdirSync(watch, { recursive: true }); } catch (_) { /* ignore */ }

    const stabilityMinutes = config.filmScansWatchguardMinutes || config.fileStabilityMinutes || 5;
    const cutoffMs = Date.now() - stabilityMinutes * 60 * 1000;

    let rolls;
    try {
      rolls = discoverRollFolders(source);
    } catch (err) {
      summary.errors.push(err.message);
      return summary;
    }

    const existingKeys = new Set(rolls.map(r => r.relPath));

    for (const roll of rolls) {
      try {
        const stable      = isFolderStable(roll.abs, cutoffMs);
        const watchExists = fs.existsSync(path.join(watch, roll.leaf));
        const currentSig  = stable ? folderSignature(roll.abs) : null;
        const ledgerSig   = this._getSig(roll.relPath);

        if (decideIngest({ stable, watchExists, ledgerSig, currentSig }) !== 'copy') {
          summary.skipped++;
          continue;
        }

        // Copy the leaf roll folder into the watch folder under its OWN name —
        // the date level (if any) is flattened away, matching what the pipeline
        // expects (roll folders directly in the watch folder).
        copyFolderRecursive(roll.abs, path.join(watch, roll.leaf));
        this._recordSig(roll.relPath, currentSig);
        summary.copied++;
        logger && logger.info && logger.info(`filmScans: mirrored scanner roll "${roll.relPath}" → watch/${roll.leaf}`);
      } catch (err) {
        summary.errors.push(`${roll.relPath}: ${err.message}`);
        logger && logger.logError && logger.logError(`filmScans: failed to mirror scanner roll ${roll.relPath}`, err);
      }
    }

    // Keep the ledger bounded — forget rolls the lab has removed from source.
    try { this._pruneLedger(existingKeys); } catch (_) { /* ignore */ }

    return summary;
  }
}

const filmScanSourceMirror = new FilmScanSourceMirror();
module.exports = filmScanSourceMirror;
module.exports.FilmScanSourceMirror = FilmScanSourceMirror;
module.exports.folderSignature = folderSignature;
module.exports.isFolderStable = isFolderStable;
module.exports.decideIngest = decideIngest;
module.exports.copyFolderRecursive = copyFolderRecursive;
module.exports.discoverRollFolders = discoverRollFolders;
