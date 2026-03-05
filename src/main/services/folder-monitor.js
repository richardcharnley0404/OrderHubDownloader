'use strict';

const path = require('path');
const fs = require('fs');

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

    // Scan existing folders on startup
    const entries = fs.readdirSync(hotFolderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        this.trackedFolders.set(entry.name, entry.name.charAt(0));
      }
    }

    // Watch for changes using Node's built-in fs.watch
    this.watcher = fs.watch(hotFolderPath, (eventType, filename) => {
      if (!filename) return;

      // Small delay to let rename operations complete
      setTimeout(() => {
        this.handleChange(filename);
      }, 500);
    });
  }

  handleChange(filename) {
    const fullPath = path.join(this.hotFolderPath, filename);
    const exists = fs.existsSync(fullPath);
    const isDir = exists && fs.statSync(fullPath).isDirectory();

    if (exists && isDir) {
      // A directory appeared — could be new or renamed
      const currentPrefix = filename.charAt(0);
      const previousPrefix = this.trackedFolders.get(filename);

      this.trackedFolders.set(filename, currentPrefix);

      if (!previousPrefix) {
        // New folder — check if it's a rename of an existing tracked folder
        this.checkForRenamedFolder(filename, currentPrefix);
      }
    } else if (!exists) {
      // A directory was removed — track the deletion for rename detection
      // The renamed-to folder will trigger a separate event
      this.trackedFolders.delete(filename);
    }
  }

  checkForRenamedFolder(newFolderName, newPrefix) {
    const match = newFolderName.match(/^[oeq](.+)$/);
    if (!match) return;

    const [, suffix] = match;

    // Check if we previously tracked a folder with the same suffix but different prefix
    for (const [trackedName, trackedPrefix] of this.trackedFolders) {
      if (trackedName === newFolderName) continue;

      const trackedMatch = trackedName.match(/^[oeq](.+)$/);
      if (trackedMatch && trackedMatch[1] === suffix) {
        // Found a match — this is a rename
        this.trackedFolders.delete(trackedName);
        this.handlePrefixChange(newFolderName, newPrefix, this.callback);
        return;
      }
    }

    // No previous match found — treat as a new submission if it has a valid prefix
    if (['o', 'e', 'q'].includes(newPrefix)) {
      this.handlePrefixChange(newFolderName, newPrefix, this.callback);
    }
  }

  handlePrefixChange(folderName, prefix, callback) {
    const match = folderName.match(/^[oeq](\d+)_(.+)$/);
    if (!match) return;

    const [, orderNumber, productCode] = match;

    let status;

    switch (prefix) {
      case 'o':
        status = 'submitted';
        break;
      case 'e':
        status = 'accepted';
        break;
      case 'q':
        status = 'failed';
        break;
      default:
        return;
    }

    callback({
      orderNumber,
      productCode,
      status,
      timestamp: new Date()
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
