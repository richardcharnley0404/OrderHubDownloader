const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('./logger');

class UploadTracker {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'upload-tracker.json');
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (error) {
      logger.logError('Error loading upload tracker', error);
    }
    return { uploads: [] };
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      logger.logError('Error saving upload tracker', error);
    }
  }

  isUploaded(folderName, mode) {
    return this.data.uploads.some(
      (entry) => entry.folderName === folderName && entry.mode === mode
    );
  }

  markUploaded(folderName, mode) {
    if (this.isUploaded(folderName, mode)) return;
    this.data.uploads.push({
      folderName,
      mode,
      uploadedAt: new Date().toISOString()
    });
    this._save();
    logger.info(`Upload tracked: ${folderName} (${mode})`);
  }

  getAll(mode) {
    if (mode) {
      return this.data.uploads.filter((entry) => entry.mode === mode);
    }
    return this.data.uploads;
  }
}

module.exports = new UploadTracker();
