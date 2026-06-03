/**
 * Unit tests for backup-service.js
 *
 * Tests use node --test and exercise the BackupService class directly with a
 * temporary userData directory + an in-memory fake configService. We avoid
 * the singleton wrapper (`getDefault()`) so tests don't have to mock electron.
 *
 * Coverage maps to the brief's test plan:
 *   - Sanitization (every SECRET_KEY → null, redactedKeys populated)
 *   - Customer directory opt-out (in/out both directions)
 *   - Atomic write (rename-throws path falls back; tmp cleaned)
 *   - _shouldRunDailyBackup (null / <24h / >24h)
 *   - Prune keeps newest 30; never deletes *_latest.json
 *   - Restore round-trip
 *   - Restore version skew (higher refused; lower runs migrations on next launch)
 *   - Restore selections (unchecked section untouched)
 *   - Multi-machine isolation (different hostnames; collision; take-over)
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

const {
  BackupService,
  SECRET_KEYS,
  BACKUP_SCHEMA_VERSION,
  MAX_BACKUPS_PER_HOST,
  STORE_FILES,
} = require('../backup-service.js');

// =============================================================================
// Test helpers
// =============================================================================

const SILENT_LOGGER = {
  info: () => {}, warn: () => {}, error: () => {}, logError: () => {},
};

function makeFakeConfig(initial = {}) {
  const store = new Map(Object.entries({
    backupEnabled: true,
    backupFolderPath: '',
    backupIncludeCustomerDirectory: true,
    backupLastRunAt: null,
    backupLastError: null,
    _machineId: 'machine-aaaa-1111',
    ...initial,
  }));
  return {
    get: (k) => store.has(k) ? store.get(k) : undefined,
    set: (k, v) => { store.set(k, v); },
    getAll: () => Object.fromEntries(store),
    _dump: () => Object.fromEntries(store),
  };
}

function makeTmpDir(label = 'ohd-backup-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function writeStoreFile(userData, key, contents) {
  const file = path.join(userData, `${STORE_FILES[key]}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
}

function readStoreFile(userData, key) {
  const file = path.join(userData, `${STORE_FILES[key]}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Seed the userData dir with a representative set of stores. */
function seedStores(userData, opts = {}) {
  writeStoreFile(userData, 'config', {
    orderhubApiKey:     opts.populateSecrets ? 'oh_secret_abc' : '',
    ftpPassword:        opts.populateSecrets ? 'super-secret-pw' : '',
    s3SecretAccessKey:  opts.populateSecrets ? 'aws-secret' : '',
    topazApiKey:        opts.populateSecrets ? 'topaz-key' : '',
    orderhubApiUrl:     'https://example.com/api',
    ftpHost:            'ftp.lab.example.com',
    ftpUsername:        'lab-user',
    downloadDirectory:  'C:\\OHD\\Downloads',
    orderXmlCustomers:  opts.includeCustomers !== false ? [{ customerId: 'C1', customerName: 'Acme', customerEmail: 'a@b.com' }] : [],
    _machineId:         opts.machineIdInConfig || 'machine-aaaa-1111',
  });
  writeStoreFile(userData, 'routing', {
    orderControllers: [{ id: 'ctrl-1', name: 'Frontline' }],
    channelMappings: [],
  });
  writeStoreFile(userData, 'printControllers', {
    controllers: { 'pc-1': { id: 'pc-1', name: 'Old DPOF' } },
    productMappings: [],
  });
  writeStoreFile(userData, 'appPrefs', { theme: 'dark' });
  writeStoreFile(userData, 'filmReviewPrefs', { density: 'comfy', theme: 'dark', showKbdHint: false });
}

// =============================================================================
// Sanitization
// =============================================================================

test('sanitization: every SECRET_KEY is null in envelope and redactedKeys covers them', async () => {
  const userData = makeTmpDir('sanitization');
  const backupRoot = makeTmpDir('sanitization-backups');
  try {
    seedStores(userData, { populateSecrets: true });
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      appVersion: '1.6.0', hostname: 'TEST-HOST',
    });

    const env = await svc._buildEnvelope();
    for (const k of SECRET_KEYS) {
      assert.equal(env.stores.config[k], null, `${k} must be null in envelope`);
    }
    for (const k of SECRET_KEYS) {
      assert.ok(env.redactedKeys.includes(k), `redactedKeys must include ${k}`);
    }
    assert.equal(env.backupSchemaVersion, BACKUP_SCHEMA_VERSION);
    assert.equal(env.appVersion, '1.6.0');
    assert.equal(env.createdBy.hostname, 'TEST-HOST');
    assert.equal(env.createdBy.machineId, 'machine-aaaa-1111');
    assert.equal(env.customerDirectoryExcluded, false);
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

test('sanitization: non-secret config keys round-trip intact', async () => {
  const userData = makeTmpDir('roundtrip');
  const backupRoot = makeTmpDir('roundtrip-backups');
  try {
    seedStores(userData, { populateSecrets: true });
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      appVersion: '1.6.0', hostname: 'TEST-HOST',
    });

    const env = await svc._buildEnvelope();
    assert.equal(env.stores.config.ftpHost, 'ftp.lab.example.com');
    assert.equal(env.stores.config.ftpUsername, 'lab-user');
    assert.equal(env.stores.config.downloadDirectory, 'C:\\OHD\\Downloads');
    assert.equal(env.stores.config.orderhubApiUrl, 'https://example.com/api');
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

// =============================================================================
// Customer directory opt-out
// =============================================================================

test('customer directory opt-in: orderXmlCustomers is present, customerDirectoryExcluded=false', async () => {
  const userData = makeTmpDir('cust-in');
  const backupRoot = makeTmpDir('cust-in-backups');
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({
      backupFolderPath: backupRoot,
      backupIncludeCustomerDirectory: true,
    });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'HOST-A',
    });
    const env = await svc._buildEnvelope();
    assert.ok(Array.isArray(env.stores.config.orderXmlCustomers));
    assert.equal(env.stores.config.orderXmlCustomers.length, 1);
    assert.equal(env.customerDirectoryExcluded, false);
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

test('customer directory opt-out: orderXmlCustomers absent, customerDirectoryExcluded=true', async () => {
  const userData = makeTmpDir('cust-out');
  const backupRoot = makeTmpDir('cust-out-backups');
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({
      backupFolderPath: backupRoot,
      backupIncludeCustomerDirectory: false,
    });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'HOST-A',
    });
    const env = await svc._buildEnvelope();
    assert.equal(Object.prototype.hasOwnProperty.call(env.stores.config, 'orderXmlCustomers'), false,
      'orderXmlCustomers must be removed when opted out');
    assert.equal(env.customerDirectoryExcluded, true);
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

// =============================================================================
// Atomic write — rename failure falls back; tmp cleaned
// =============================================================================

test('atomic write: rename throwing EPERM falls back to copy+unlink', async () => {
  // Monkey-patch fs.promises.rename to throw EPERM on the first call. Restore
  // after the test so it doesn't bleed into other cases.
  const userData = makeTmpDir('atomic-eperm');
  const backupRoot = makeTmpDir('atomic-eperm-backups');
  const origRename = fsp.rename;
  let renameCalls = 0;
  fsp.rename = async (...args) => {
    renameCalls++;
    if (renameCalls === 1) {
      const err = new Error('SMB rename flake');
      err.code = 'EPERM';
      throw err;
    }
    return origRename(...args);
  };
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'EPERM-HOST',
    });
    const result = await svc.runBackup({ trigger: 'manual' });
    assert.equal(result.success, true, `runBackup must succeed via the fallback (got ${result.error})`);
    assert.ok(fs.existsSync(result.filePath), 'timestamped backup exists');
    const hostFolder = path.join(backupRoot, 'EPERM-HOST');
    const tmps = fs.readdirSync(hostFolder).filter((n) => n.endsWith('.tmp'));
    assert.equal(tmps.length, 0, 'no leftover *.tmp files after EPERM fallback');
  } finally {
    fsp.rename = origRename;
    cleanup(userData); cleanup(backupRoot);
  }
});

test('atomic write: non-recoverable rename error cleans tmp and surfaces failure', async () => {
  const userData = makeTmpDir('atomic-eacces');
  const backupRoot = makeTmpDir('atomic-eacces-backups');
  const origRename = fsp.rename;
  fsp.rename = async () => {
    const err = new Error('permission denied');
    err.code = 'EACCES';
    throw err;
  };
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'EACCES-HOST',
    });
    const result = await svc.runBackup({ trigger: 'manual' });
    assert.equal(result.success, false, 'runBackup must surface failure on EACCES');
    const hostFolder = path.join(backupRoot, 'EACCES-HOST');
    const tmps = fs.existsSync(hostFolder)
      ? fs.readdirSync(hostFolder).filter((n) => n.endsWith('.tmp'))
      : [];
    assert.equal(tmps.length, 0, 'no leftover *.tmp files after non-recoverable rename failure');
    assert.equal(cfg.get('backupLastError'), result.error, 'backupLastError stored on failure');
  } finally {
    fsp.rename = origRename;
    cleanup(userData); cleanup(backupRoot);
  }
});

// =============================================================================
// Daily trigger
// =============================================================================

test('_shouldRunDailyBackup: returns true when backupLastRunAt is null', () => {
  const cfg = makeFakeConfig({ backupLastRunAt: null });
  const svc = new BackupService({ configService: cfg, logger: SILENT_LOGGER });
  assert.equal(svc._shouldRunDailyBackup(), true);
});

test('_shouldRunDailyBackup: returns true when last run was >24h ago', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const cfg = makeFakeConfig({ backupLastRunAt: '2026-05-14T11:59:00Z' }); // 24h 1min ago
  const svc = new BackupService({ configService: cfg, logger: SILENT_LOGGER, now: () => now });
  assert.equal(svc._shouldRunDailyBackup(), true);
});

test('_shouldRunDailyBackup: returns false when last run was <24h ago', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const cfg = makeFakeConfig({ backupLastRunAt: '2026-05-14T13:00:00Z' }); // 23h ago
  const svc = new BackupService({ configService: cfg, logger: SILENT_LOGGER, now: () => now });
  assert.equal(svc._shouldRunDailyBackup(), false);
});

test('_shouldRunDailyBackup: returns true when timestamp is unparseable', () => {
  const cfg = makeFakeConfig({ backupLastRunAt: 'definitely not a date' });
  const svc = new BackupService({ configService: cfg, logger: SILENT_LOGGER });
  assert.equal(svc._shouldRunDailyBackup(), true);
});

// =============================================================================
// Prune
// =============================================================================

test(`prune: keeps newest ${MAX_BACKUPS_PER_HOST}, deletes older, never touches *_latest.json`, async () => {
  const userData = makeTmpDir('prune');
  const backupRoot = makeTmpDir('prune-backups');
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'PRUNE-HOST',
    });
    const hostFolder = path.join(backupRoot, 'PRUNE-HOST');
    fs.mkdirSync(hostFolder, { recursive: true });

    // Plant 35 old timestamped backups + a latest pointer.
    for (let i = 0; i < 35; i++) {
      const ts = `2026-04-${String(i + 1).padStart(2, '0')}_10-00-00`;
      const name = `ohd-backup_PRUNE-HOST_${ts}.json`;
      fs.writeFileSync(path.join(hostFolder, name),
        JSON.stringify({ backupSchemaVersion: 1, createdAt: `2026-04-${String(i + 1).padStart(2, '0')}T10:00:00Z`, stores: {} }));
    }
    const latestName = `ohd-backup_PRUNE-HOST_latest.json`;
    fs.writeFileSync(path.join(hostFolder, latestName),
      JSON.stringify({ backupSchemaVersion: 1, createdAt: '2026-04-01T10:00:00Z', stores: {} }));

    // Run a backup → triggers prune. Use a fresh machineId so no collision.
    const result = await svc.runBackup({ trigger: 'manual' });
    assert.equal(result.success, true, `runBackup must succeed (got ${result.error})`);

    const remaining = fs.readdirSync(hostFolder)
      .filter((n) => /^ohd-backup_PRUNE-HOST_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(n));
    assert.ok(remaining.length <= MAX_BACKUPS_PER_HOST,
      `at most ${MAX_BACKUPS_PER_HOST} timestamped backups should remain, got ${remaining.length}`);

    assert.ok(fs.existsSync(path.join(hostFolder, latestName)),
      '*_latest.json must never be pruned');
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

// =============================================================================
// Restore round-trip
// =============================================================================

test('restore: round-trip — backup → wipe stores → restore → non-secret fields match', async () => {
  const userData = makeTmpDir('rt');
  const backupRoot = makeTmpDir('rt-backups');
  try {
    seedStores(userData, { populateSecrets: true });
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'RT-HOST',
    });
    const backupResult = await svc.runBackup({ trigger: 'manual' });
    assert.equal(backupResult.success, true);

    const originalConfig = readStoreFile(userData, 'config');
    // Wipe all stores to simulate fresh install.
    for (const key of Object.keys(STORE_FILES)) {
      const f = path.join(userData, `${STORE_FILES[key]}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    // Fresh install would have a different machineId. Simulate that.
    cfg.set('_machineId', 'fresh-install-bbbb-2222');

    const restoreResult = await svc.restore({ filePath: backupResult.filePath });
    assert.equal(restoreResult.success, true, `restore failed: ${restoreResult.error}`);
    assert.equal(restoreResult.requiresRelaunch, true);
    assert.ok(restoreResult.restoredSections.includes('config'));
    assert.ok(restoreResult.restoredSections.includes('routing'));

    const restoredConfig = readStoreFile(userData, 'config');
    assert.equal(restoredConfig.ftpHost, originalConfig.ftpHost);
    assert.equal(restoredConfig.ftpUsername, originalConfig.ftpUsername);
    assert.equal(restoredConfig.downloadDirectory, originalConfig.downloadDirectory);
    // Secrets must come back as null.
    for (const k of SECRET_KEYS) {
      assert.equal(restoredConfig[k], null, `${k} must be null after restore`);
    }
    // _machineId must NOT be the source install's UUID — it's THIS install's.
    assert.equal(restoredConfig._machineId, 'fresh-install-bbbb-2222',
      'restore must preserve THIS install\'s machineId, not overwrite with source\'s');

    const restoredRouting = readStoreFile(userData, 'routing');
    assert.deepEqual(restoredRouting.orderControllers, [{ id: 'ctrl-1', name: 'Frontline' }]);
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

// =============================================================================
// Restore version skew
// =============================================================================

test('restore: refuses an envelope with backupSchemaVersion higher than supported', async () => {
  const userData = makeTmpDir('skew-up');
  const backupRoot = makeTmpDir('skew-up-backups');
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'SKEW-HOST',
    });
    const futureBackup = path.join(backupRoot, 'future.json');
    fs.writeFileSync(futureBackup, JSON.stringify({
      backupSchemaVersion: 999,
      appVersion: '99.0.0',
      createdAt: '2099-01-01T00:00:00.000Z',
      createdBy: { hostname: 'FUTURE', user: 'x', machineId: 'm' },
      redactedKeys: SECRET_KEYS.slice(),
      customerDirectoryExcluded: false,
      stores: { config: {}, routing: {}, printControllers: {}, appPrefs: {}, filmReviewPrefs: {} },
    }));
    const result = await svc.restore({ filePath: futureBackup });
    assert.equal(result.success, false);
    assert.match(result.error || '', /newer version/i);
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

test('restore: lower-version envelope is accepted; migration note is recorded', async () => {
  const userData = makeTmpDir('skew-down');
  const backupRoot = makeTmpDir('skew-down-backups');
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'this-install' });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'SKEW-HOST',
    });
    const oldBackup = path.join(backupRoot, 'old.json');
    fs.writeFileSync(oldBackup, JSON.stringify({
      // Simulate a backup written by a hypothetical earlier schema. We do this
      // by treating BACKUP_SCHEMA_VERSION as the current value and writing 0
      // (lower). The lower-version branch records a note rather than refusing.
      backupSchemaVersion: 0,
      appVersion: '1.0.0',
      createdAt: '2025-01-01T00:00:00.000Z',
      createdBy: { hostname: 'OLD', user: 'x', machineId: 'old-id' },
      redactedKeys: SECRET_KEYS.slice(),
      customerDirectoryExcluded: false,
      // Include a legacy migration marker we expect to be stripped so the
      // next launch re-runs the migration code path.
      stores: {
        config: { _integrityQuarantineMigratedAt: '2025-01-01T00:00:00.000Z', ftpHost: 'old.ftp' },
        routing: {}, printControllers: {}, appPrefs: {}, filmReviewPrefs: {},
      },
    }));
    const result = await svc.restore({ filePath: oldBackup });
    assert.equal(result.success, true, `restore should accept lower-version envelopes: ${result.error}`);
    assert.ok(result.migrationNotes.some((n) => /v0/i.test(n) || /v\d+/.test(n)),
      'a migration note must be produced for version skew');
    const restoredConfig = readStoreFile(userData, 'config');
    assert.equal(restoredConfig.ftpHost, 'old.ftp', 'restored data round-trips');
    assert.equal(restoredConfig._integrityQuarantineMigratedAt, undefined,
      'legacy migration marker should be stripped so next launch re-runs migrations');
    assert.ok(result.migrationNotes.some((n) => /_integrityQuarantineMigratedAt/.test(n)),
      'stripped marker is mentioned in migrationNotes');
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

// =============================================================================
// Restore selections
// =============================================================================

test('restore: unselected sections are left untouched on disk', async () => {
  const userData = makeTmpDir('sel');
  const backupRoot = makeTmpDir('sel-backups');
  try {
    seedStores(userData, { populateSecrets: false });
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'SEL-HOST',
    });
    const backupResult = await svc.runBackup({ trigger: 'manual' });
    assert.equal(backupResult.success, true);

    // Mutate the live print-controllers store so we can verify it stays.
    writeStoreFile(userData, 'printControllers', {
      controllers: { 'pc-LIVE': { id: 'pc-LIVE', name: 'Live, not backed up' } },
      productMappings: [],
    });

    const result = await svc.restore({
      filePath: backupResult.filePath,
      selections: { config: true, routing: true, printControllers: false, appPrefs: true, filmReviewPrefs: true },
    });
    assert.equal(result.success, true);
    assert.ok(result.skippedSections.includes('printControllers'));
    const live = readStoreFile(userData, 'printControllers');
    assert.equal(live.controllers['pc-LIVE'].name, 'Live, not backed up',
      'unselected section must not be overwritten');
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

// =============================================================================
// Multi-machine isolation
// =============================================================================

test('multi-machine: different hostnames + different machineIds both succeed in their own subfolders', async () => {
  const userData = makeTmpDir('mm-different');
  const backupRoot = makeTmpDir('mm-different-backups');
  try {
    seedStores(userData);
    const cfg1 = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'mid-1' });
    const cfg2 = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'mid-2' });
    const svc1 = new BackupService({
      configService: cfg1, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'PC-ONE',
    });
    const svc2 = new BackupService({
      configService: cfg2, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'PC-TWO',
    });
    const r1 = await svc1.runBackup({ trigger: 'manual' });
    const r2 = await svc2.runBackup({ trigger: 'manual' });
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.ok(fs.existsSync(path.join(backupRoot, 'PC-ONE')));
    assert.ok(fs.existsSync(path.join(backupRoot, 'PC-TWO')));
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

test('multi-machine: same hostname, different machineId → second write fails with hostname-collision', async () => {
  const userData = makeTmpDir('mm-collide');
  const backupRoot = makeTmpDir('mm-collide-backups');
  try {
    seedStores(userData);
    const cfg1 = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'mid-1' });
    const cfg2 = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'mid-2' });
    const svc1 = new BackupService({
      configService: cfg1, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'SHARED-HOST',
    });
    const svc2 = new BackupService({
      configService: cfg2, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'SHARED-HOST',
    });
    const r1 = await svc1.runBackup({ trigger: 'manual' });
    assert.equal(r1.success, true);
    const r2 = await svc2.runBackup({ trigger: 'manual' });
    assert.equal(r2.success, false, 'second write under same hostname with new machineId must fail');
    assert.equal(r2.code, 'HOSTNAME_COLLISION');
    assert.match(r2.error, /hostname/i);
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

test('multi-machine: same hostname + same machineId → repeat writes overwrite cleanly', async () => {
  const userData = makeTmpDir('mm-same');
  const backupRoot = makeTmpDir('mm-same-backups');
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'stable-mid' });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'HOST-X',
    });
    const r1 = await svc.runBackup({ trigger: 'manual' });
    const r2 = await svc.runBackup({ trigger: 'manual' });
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

test('multi-machine: restore is NOT blocked when source machineId differs from current install', async () => {
  const userData = makeTmpDir('mm-restore');
  const backupRoot = makeTmpDir('mm-restore-backups');
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'mid-SOURCE' });
    const svcSource = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'OLD-PC',
    });
    const sourceBackup = await svcSource.runBackup({ trigger: 'manual' });
    assert.equal(sourceBackup.success, true);

    // Simulate a fresh install: new machineId, different hostname.
    cfg.set('_machineId', 'mid-FRESH');
    const userDataFresh = makeTmpDir('mm-restore-fresh');
    const svcFresh = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userDataFresh,
      hostname: 'NEW-PC',
    });
    const result = await svcFresh.restore({ filePath: sourceBackup.filePath });
    cleanup(userDataFresh);
    assert.equal(result.success, true, `restore must succeed across machineIds: ${result.error}`);
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

test('multi-machine: "take over folder" wipes prior backups for that hostname and writes a fresh one', async () => {
  const userData = makeTmpDir('mm-takeover');
  const backupRoot = makeTmpDir('mm-takeover-backups');
  try {
    seedStores(userData);
    const cfgOld = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'mid-OLD' });
    const cfgNew = makeFakeConfig({ backupFolderPath: backupRoot, _machineId: 'mid-NEW' });
    const svcOld = new BackupService({
      configService: cfgOld, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'TAKE-HOST',
    });
    const svcNew = new BackupService({
      configService: cfgNew, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'TAKE-HOST',
    });

    // Plant several old backups from the prior machine.
    await svcOld.runBackup({ trigger: 'manual' });
    await svcOld.runBackup({ trigger: 'manual' });
    await svcOld.runBackup({ trigger: 'manual' });

    // Without takeover, the new machine would collide.
    const collide = await svcNew.runBackup({ trigger: 'manual' });
    assert.equal(collide.success, false);
    assert.equal(collide.code, 'HOSTNAME_COLLISION');

    // With takeover, it must succeed and remove the old machine's files.
    const ok = await svcNew.runBackup({ trigger: 'manual', overrides: { takeOverFolder: true } });
    assert.equal(ok.success, true, `take-over backup must succeed: ${ok.error}`);

    const remaining = fs.readdirSync(path.join(backupRoot, 'TAKE-HOST'));
    const latestEnvelope = JSON.parse(fs.readFileSync(
      path.join(backupRoot, 'TAKE-HOST', 'ohd-backup_TAKE-HOST_latest.json'), 'utf8'));
    assert.equal(latestEnvelope.createdBy.machineId, 'mid-NEW',
      'latest.json must reflect the new machine after takeover');
    const oldBackupsForOldMachine = remaining.filter((n) => /^ohd-backup_TAKE-HOST_\d/.test(n))
      .map((n) => JSON.parse(fs.readFileSync(path.join(backupRoot, 'TAKE-HOST', n), 'utf8')))
      .filter((env) => env.createdBy.machineId === 'mid-OLD');
    assert.equal(oldBackupsForOldMachine.length, 0,
      'no old-machineId backups should remain after takeover');
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});

// =============================================================================
// Failure isolation — runBackup never throws
// =============================================================================

test('failure isolation: backupFolderPath empty → returns {success:false} without throwing', async () => {
  const cfg = makeFakeConfig({ backupFolderPath: '' });
  const svc = new BackupService({ configService: cfg, logger: SILENT_LOGGER });
  const result = await svc.runBackup({ trigger: 'manual' });
  assert.equal(result.success, false);
  assert.match(result.error, /not configured/i);
});

test('listBackups: returns [] when folder does not exist', async () => {
  const cfg = makeFakeConfig({ backupFolderPath: '/definitely/not/a/real/path/12345' });
  const svc = new BackupService({ configService: cfg, logger: SILENT_LOGGER, hostname: 'NONE' });
  const list = await svc.listBackups();
  assert.deepEqual(list, []);
});

// =============================================================================
// validateFolder
// =============================================================================

test('validateFolder: happy path — writes probe, reads back, deletes, returns ok', async () => {
  const target = makeTmpDir('validate-ok');
  try {
    const cfg = makeFakeConfig();
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, hostname: 'VAL-HOST',
    });
    const result = await svc.validateFolder(target);
    assert.equal(result.ok, true, `expected ok, got ${result.error}`);
    assert.equal(result.resolvedPath, path.resolve(target));
    // Probe file must be cleaned up.
    const hostFolder = path.join(target, 'VAL-HOST');
    const leftover = fs.existsSync(hostFolder)
      ? fs.readdirSync(hostFolder).filter((n) => n.startsWith('.ohd-write-test-'))
      : [];
    assert.equal(leftover.length, 0, 'probe file must be cleaned up');
  } finally {
    cleanup(target);
  }
});

test('validateFolder: creates hostname subfolder on first run', async () => {
  const target = makeTmpDir('validate-mkdir');
  try {
    const cfg = makeFakeConfig();
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, hostname: 'NEW-HOST',
    });
    assert.equal(fs.existsSync(path.join(target, 'NEW-HOST')), false);
    const result = await svc.validateFolder(target);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(target, 'NEW-HOST')), true,
      'hostname subfolder must be created on demand');
  } finally {
    cleanup(target);
  }
});

test('validateFolder: empty path → ok:false with descriptive error', async () => {
  const svc = new BackupService({ configService: makeFakeConfig(), logger: SILENT_LOGGER });
  const r1 = await svc.validateFolder('');
  const r2 = await svc.validateFolder('   ');
  const r3 = await svc.validateFolder(null);
  assert.equal(r1.ok, false); assert.match(r1.error, /required/i);
  assert.equal(r2.ok, false);
  assert.equal(r3.ok, false);
});

test('validateFolder: ENOENT (mkdir fails) → "Path not found" message', async () => {
  const origMkdir = fsp.mkdir;
  fsp.mkdir = async () => {
    const err = new Error('no such file or directory');
    err.code = 'ENOENT';
    throw err;
  };
  try {
    const svc = new BackupService({
      configService: makeFakeConfig(), logger: SILENT_LOGGER, hostname: 'X',
    });
    const result = await svc.validateFolder('\\\\definitely-missing\\share');
    assert.equal(result.ok, false);
    assert.match(result.error, /Path not found/i);
    assert.match(result.error, /UNC/i);
  } finally {
    fsp.mkdir = origMkdir;
  }
});

test('validateFolder: EACCES (open fails) → "Permission denied" message', async () => {
  const target = makeTmpDir('validate-eacces');
  const origOpen = fsp.open;
  fsp.open = async () => {
    const err = new Error('permission denied');
    err.code = 'EACCES';
    throw err;
  };
  try {
    const svc = new BackupService({
      configService: makeFakeConfig(), logger: SILENT_LOGGER, hostname: 'EACCES-HOST',
    });
    const result = await svc.validateFolder(target);
    assert.equal(result.ok, false);
    assert.match(result.error, /Permission denied/i);
    assert.match(result.error, /Windows user/i);
  } finally {
    fsp.open = origOpen;
    cleanup(target);
  }
});

test('validateFolder: EPERM (open fails) → "Permission denied" message', async () => {
  const target = makeTmpDir('validate-eperm');
  const origOpen = fsp.open;
  fsp.open = async () => {
    const err = new Error('operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  try {
    const svc = new BackupService({
      configService: makeFakeConfig(), logger: SILENT_LOGGER, hostname: 'EPERM-HOST',
    });
    const result = await svc.validateFolder(target);
    assert.equal(result.ok, false);
    assert.match(result.error, /Permission denied/i);
  } finally {
    fsp.open = origOpen;
    cleanup(target);
  }
});

test('validateFolder: EROFS → "read-only" message', async () => {
  const target = makeTmpDir('validate-erofs');
  const origOpen = fsp.open;
  fsp.open = async () => {
    const err = new Error('read-only file system');
    err.code = 'EROFS';
    throw err;
  };
  try {
    const svc = new BackupService({
      configService: makeFakeConfig(), logger: SILENT_LOGGER, hostname: 'ROFS-HOST',
    });
    const result = await svc.validateFolder(target);
    assert.equal(result.ok, false);
    assert.match(result.error, /read-only/i);
  } finally {
    fsp.open = origOpen;
    cleanup(target);
  }
});

test('validateFolder: unrecognised error code falls through to raw message', async () => {
  const target = makeTmpDir('validate-weird');
  const origOpen = fsp.open;
  fsp.open = async () => {
    const err = new Error('a weird thing happened');
    err.code = 'EWEIRD';
    throw err;
  };
  try {
    const svc = new BackupService({
      configService: makeFakeConfig(), logger: SILENT_LOGGER, hostname: 'WEIRD-HOST',
    });
    const result = await svc.validateFolder(target);
    assert.equal(result.ok, false);
    assert.match(result.error, /weird thing happened/i,
      'unrecognised codes must surface the raw error so we don\'t hide new failure modes');
  } finally {
    fsp.open = origOpen;
    cleanup(target);
  }
});

test('listBackups: returns newest-first for the current host', async () => {
  const userData = makeTmpDir('list');
  const backupRoot = makeTmpDir('list-backups');
  try {
    seedStores(userData);
    const cfg = makeFakeConfig({ backupFolderPath: backupRoot });
    const svc = new BackupService({
      configService: cfg, logger: SILENT_LOGGER, userDataPath: userData,
      hostname: 'LIST-HOST',
    });
    // Force two distinct timestamps.
    let t = Date.parse('2026-05-10T08:00:00Z');
    svc._now = () => new Date(t);
    await svc.runBackup({ trigger: 'manual' });
    t = Date.parse('2026-05-12T08:00:00Z');
    await svc.runBackup({ trigger: 'manual' });
    const list = await svc.listBackups();
    assert.equal(list.length, 2);
    assert.ok(list[0].createdAt > list[1].createdAt, 'newest first');
  } finally {
    cleanup(userData); cleanup(backupRoot);
  }
});
