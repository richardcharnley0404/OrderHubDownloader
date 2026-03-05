const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const INSTANCE_FILE = path.join(app.getPath('userData'), 'instance.json');

/**
 * Returns the persistent instance ID for this OHD installation.
 * Generated once on first launch and stored in userData/instance.json.
 */
function getInstanceId() {
  if (fs.existsSync(INSTANCE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'));
      if (data.instanceId) return data.instanceId;
    } catch {
      // Fall through and generate a new one
    }
  }
  const instanceId = uuidv4();
  fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ instanceId }), 'utf8');
  return instanceId;
}

module.exports = { getInstanceId };
