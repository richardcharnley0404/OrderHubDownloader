'use strict';

const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { parseFolderName } = require('../../shared/printUtils');

class FolderMonitor {
  constructor() {
    this.watcher = null;
    this.trackedFolders = new Map(); // folderName -> prefix
    this.hotFolderPath = null;
    this.callback = null;
  }

  startMonitoring(hotFolderPath, callback) {
    this.hotFolderPath = hotFolderPath;
    this.callback = callback;

    // Scan existing folders on startup so we have a baseline for rename detection
    try {
      const entries = fs.readdirSync(hotFolderPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          this.trackedFolders.set(entry.name, entry.name.charAt(0));
        }
      }
    } catch (_) {
      // hotFolderPath may not exist yet — watcher will detect additions when it does
    }

    // Use chokidar with polling for reliable detection on network paths,
    // mapped drives, UNC paths, and NAS locations where fs.watch is unreliable.
    this.watcher = chokidar.watch(hotFolderPath, {
      depth:         0,       // immediate children only — no recursion into job folders
      usePolling:    true,
      pollInterval:  2000,    // check every 2 seconds
      ignoreInitial: true,    // baseline already captured via readdirSync above
      persistent:    true,
    });

    this.watcher.on('addDir', (fullPath) => {
      const name = path.basename(fullPath);
      // Skip the watched root folder itself (chokidar may fire this on startup)
      if (name === path.basename(hotFolderPath)) return;
      setTimeout(() => this.handleChange(name), 500);
    });

    this.watcher.on('unlinkDir', (fullPath) => {
      const name = path.basename(fullPath);
      if (name === path.basename(hotFolderPath)) return;
      setTimeout(() => this.handleChange(name), 500);
    });
  }

  handleChange(filename) {
    const fullPath = path.join(this.hotFolderPath, filename);
    const exists = fs.existsSync(fullPath);
    const isDir = exists && fs.statSync(fullPath).isDirectory();

    if (exists && isDir) {
      // A directory appeared — could be new or a rename of an existing tracked folder
      const currentPrefix = filename.charAt(0);
      const previousPrefix = this.trackedFolders.get(filename);

      this.trackedFolders.set(filename, currentPrefix);

      if (!previousPrefix) {
        // Not previously tracked — check if this is a rename (prefix change)
        this.checkForRenamedFolder(filename, currentPrefix);
      }
    } else if (!exists) {
      // A directory was removed — remove from tracking; the renamed-to folder
      // will arrive as a separate addDir event
      this.trackedFolders.delete(filename);
    }
  }

  checkForRenamedFolder(newFolderName, newPrefix) {
    const match = newFolderName.match(/^[oeq](.+)$/);
    if (!match) return;

    const [, suffix] = match;

    // Look for a previously tracked folder with the same suffix but a different prefix
    for (const [trackedName] of this.trackedFolders) {
      if (trackedName === newFolderName) continue;

      const trackedMatch = trackedName.match(/^[oeq](.+)$/);
      if (trackedMatch && trackedMatch[1] === suffix) {
        // Same suffix, different prefix — this is a rename
        this.trackedFolders.delete(trackedName);
        this.handlePrefixChange(newFolderName, newPrefix, this.callback);
        return;
      }
    }

    // No previous match — treat as a new submission if it has a valid prefix
    if (['o', 'e', 'q'].includes(newPrefix)) {
      this.handlePrefixChange(newFolderName, newPrefix, this.callback);
    }
  }

  handlePrefixChange(folderName, prefix, callback) {
    // Delegate to the shared parser (M1 of docs/epson-batch-splitting-brief.md).
    // It handles the discriminator slot properly — batch (`_2of5`) vs
    // reprint (`_r1`) vs unsplit — so the callback payload can name
    // WHICH folder-for-a-job changed state, not just the job id.
    //
    // The pre-M1 shape captured `(jobId, productCode)` where
    // "productCode" was really "everything after jobId_" (misleading —
    // it was jobNo + surname + product + options concatenated). Renamed
    // to `rest` in the payload for accuracy; consumers that need
    // structured fields read `batch` / `reprintSuffix` instead.
    const parsed = parseFolderName(folderName);
    if (!parsed) return;

    let status;
    switch (prefix) {
      case 'o': status = 'submitted'; break;
      case 'e': status = 'accepted';  break;
      case 'q': status = 'failed';    break;
      default:  return;
    }

    callback({
      jobId:         parsed.jobId,
      batch:         parsed.batch,          // {index, total} for split dispatches, null for unsplit
      reprintSuffix: parsed.reprintSuffix,  // 'r1' etc for reprints, null otherwise
      rest:          parsed.rest,           // legacy productCode-shaped field, kept as-is for existing logging
      status,
      timestamp:     new Date(),
    });
  }

  stopMonitoring() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.trackedFolders.clear();
    this.hotFolderPath = null;
    this.callback = null;
  }
}

const folderMonitor = new FolderMonitor();
module.exports = { folderMonitor, FolderMonitor };
