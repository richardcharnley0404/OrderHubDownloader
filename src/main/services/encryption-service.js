const { safeStorage } = require('electron');
const logger = require('./logger');

class EncryptionService {
  isAvailable() {
    return safeStorage.isEncryptionAvailable();
  }

  encrypt(plaintext) {
    if (!plaintext) return '';
    if (!this.isAvailable()) {
      logger.logWarning('Encryption not available, storing as plain text');
      return plaintext;
    }
    const encrypted = safeStorage.encryptString(plaintext);
    return encrypted.toString('base64');
  }

  decrypt(base64String) {
    if (!base64String) return '';
    if (!this.isAvailable()) {
      logger.logWarning('Encryption not available, returning as-is');
      return base64String;
    }
    try {
      const buffer = Buffer.from(base64String, 'base64');
      return safeStorage.decryptString(buffer);
    } catch (error) {
      logger.logWarning('Failed to decrypt value, may be stored unencrypted');
      return base64String;
    }
  }
}

module.exports = new EncryptionService();
