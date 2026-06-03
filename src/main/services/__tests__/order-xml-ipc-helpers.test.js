/**
 * Unit tests for src/main/services/order-xml-ipc-helpers.js.
 *
 * Run via:
 *   npm test
 *
 * The helpers are pure-function-style — they take their dependencies
 * (ingestionStore, configService, pollingService) as arguments. Tests pass
 * in-memory fakes so we don't need Electron, electron-store, or any IPC.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('../order-xml-ipc-helpers');
const { OrderXmlIngestionStore, STATUS } = require('../order-xml-ingestion-store');

// In-memory fake of the electron-store surface the ingestion store uses.
function fakeElectronStore() {
  const data = {};
  return { get: (k, d) => (data[k] !== undefined ? data[k] : d), set: (k, v) => { data[k] = v; }, delete: (k) => { delete data[k]; } };
}

function freshIngestionStore() {
  return new OrderXmlIngestionStore({ store: fakeElectronStore() });
}

// Minimal config-service stub the helpers need.
function fakeConfigService(hotFolders, mode = { enabled: true, sync: 1 }) {
  return {
    getAllHotFolders:     () => hotFolders.map((hf) => ({ ...hf })),
    getEnabledHotFolders: () => hotFolders.filter((hf) => hf.enabled).map((hf) => ({ ...hf })),
    get: (key) => {
      if (key === 'orderXmlEnabled')         return mode.enabled;
      if (key === 'orderXmlAutoSyncMinutes') return mode.sync;
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// listRecords
// ---------------------------------------------------------------------------

test('listRecords returns paginated records with total count', () => {
  const store = freshIngestionStore();
  for (let i = 0; i < 5; i++) {
    store.add({
      hotFolderId: i % 2 === 0 ? 'hf-A' : 'hf-B',
      status: STATUS.SUBMITTED, externalId: `e-${i}`,
      ingestedAt: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  const all = helpers.listRecords({ ingestionStore: store }, {});
  assert.equal(all.ok,            true);
  assert.equal(all.records.length, 5);
  assert.equal(all.total,          5);

  // Filter
  const a = helpers.listRecords({ ingestionStore: store }, { filters: { hotFolderId: 'hf-A' } });
  assert.equal(a.records.length, 3);
  assert.equal(a.total,          3);

  // Pagination
  const page1 = helpers.listRecords({ ingestionStore: store }, { limit: 2, offset: 0 });
  const page2 = helpers.listRecords({ ingestionStore: store }, { limit: 2, offset: 2 });
  assert.equal(page1.records.length, 2);
  assert.equal(page2.records.length, 2);
  // Even when limited, total reflects the unfiltered count.
  assert.equal(page1.total, 5);
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('getStatus surfaces enabled flag, running folder count, and record count', () => {
  const store = freshIngestionStore();
  store.add({ hotFolderId: 'hf-A', status: STATUS.SUBMITTED, ingestedAt: new Date().toISOString() });
  const cfg = fakeConfigService(
    [
      { id: 'hf-A', label: 'A', enabled: true },
      { id: 'hf-B', label: 'B', enabled: false },
    ],
    { enabled: true, sync: 5 }
  );
  const ps = { getStatus: () => ({ lastOrderXmlCheck: 1234567890 }) };

  const out = helpers.getStatus({ ingestionStore: store, configService: cfg, pollingService: ps });
  assert.equal(out.ok,                true);
  assert.equal(out.enabled,           true);
  assert.equal(out.autoSyncMinutes,   5);
  assert.equal(out.runningHotFolders, 1); // only hf-A is enabled
  assert.equal(out.recordCount,       1);
  assert.equal(out.lastCheckTime,     1234567890);
});

test('getStatus tolerates a missing pollingService.getStatus()', () => {
  const store = freshIngestionStore();
  const out = helpers.getStatus({
    ingestionStore: store,
    configService:  fakeConfigService([], { enabled: false, sync: 1 }),
    pollingService: {},
  });
  assert.equal(out.ok,            true);
  assert.equal(out.lastCheckTime, null);
});

// ---------------------------------------------------------------------------
// clearRecords
// ---------------------------------------------------------------------------

test('clearRecords wipes the store', () => {
  const store = freshIngestionStore();
  store.add({ hotFolderId: 'hf', status: STATUS.SUBMITTED, ingestedAt: new Date().toISOString() });
  store.add({ hotFolderId: 'hf', status: STATUS.SUBMITTED, ingestedAt: new Date().toISOString() });
  const out = helpers.clearRecords({ ingestionStore: store });
  assert.equal(out.ok, true);
  assert.equal(store.count(), 0);
});

// ---------------------------------------------------------------------------
// retryFailed
// ---------------------------------------------------------------------------

test('retryFailed moves the XML back to watchFolder, deletes sidecar, drops record', () => {
  // Set up a real file layout so the helper can actually do its work.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oxh-'));
  const watchDir = path.join(root, 'in');
  const procDir  = path.join(root, 'out');
  const dateSub  = path.join(procDir, 'failed', '05082026');
  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(dateSub,  { recursive: true });

  // Plant a "failed" XML and its sidecar.
  const failedXml     = path.join(dateSub, '43192748.xml');
  const failedSidecar = `${failedXml}.error.json`;
  fs.writeFileSync(failedXml, '<OrderDataSet/>',                'utf8');
  fs.writeFileSync(failedSidecar, '{"errorCode":"X"}',          'utf8');

  const store = freshIngestionStore();
  const record = store.add({
    hotFolderId:    'hf-1',
    hotFolderLabel: 'PF',
    sourceFormat:   'photofinale',
    filename:       '43192748.xml',
    filePath:       failedXml,
    externalId:     '43192748',
    status:         STATUS.FAILED,
    errorCode:      'PARSE_ERROR',
    errorMessage:   'truncated',
    attempts:       3,
    ingestedAt:     new Date().toISOString(),
  });

  const cfg = fakeConfigService([{
    id: 'hf-1', label: 'PF', enabled: true,
    sourceFormat: 'photofinale', watchFolder: watchDir, processedFolder: procDir,
  }]);

  try {
    const out = helpers.retryFailed({ ingestionStore: store, configService: cfg }, { id: record.id });
    assert.equal(out.ok, true);
    assert.equal(out.restoredTo, path.join(watchDir, '43192748.xml'));

    // XML moved back, sidecar cleaned up, failed location empty.
    assert.equal(fs.existsSync(out.restoredTo),    true);
    assert.equal(fs.existsSync(failedXml),         false);
    assert.equal(fs.existsSync(failedSidecar),     false);

    // Record was removed.
    assert.equal(store.getById(record.id), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retryFailed: collision in watchFolder gets a _retry suffix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oxh-'));
  const watchDir = path.join(root, 'in');
  const procDir  = path.join(root, 'out');
  const dateSub  = path.join(procDir, 'failed', '05082026');
  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(dateSub,  { recursive: true });

  // Existing file already in watchDir with the same name.
  fs.writeFileSync(path.join(watchDir, '43192748.xml'), '<existing/>', 'utf8');
  const failedXml = path.join(dateSub, '43192748.xml');
  fs.writeFileSync(failedXml, '<old-failed/>', 'utf8');

  const store = freshIngestionStore();
  const record = store.add({
    hotFolderId: 'hf-1', filePath: failedXml, filename: '43192748.xml',
    status: STATUS.FAILED, ingestedAt: new Date().toISOString(),
  });
  const cfg = fakeConfigService([{
    id: 'hf-1', label: 'PF', enabled: true,
    sourceFormat: 'photofinale', watchFolder: watchDir, processedFolder: procDir,
  }]);

  try {
    const out = helpers.retryFailed({ ingestionStore: store, configService: cfg }, { id: record.id });
    assert.equal(out.ok, true);
    assert.match(out.restoredTo, /43192748_retry1\.xml$/);
    assert.equal(fs.existsSync(path.join(watchDir, '43192748.xml')),         true);
    assert.equal(fs.existsSync(path.join(watchDir, '43192748_retry1.xml')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retryFailed rejects unknown id', () => {
  const store = freshIngestionStore();
  const cfg = fakeConfigService([]);
  const out = helpers.retryFailed({ ingestionStore: store, configService: cfg }, { id: 'nope' });
  assert.equal(out.ok, false);
  assert.match(out.error, /record not found/);
});

test('retryFailed rejects records that are not in failed state', () => {
  const store = freshIngestionStore();
  const rec = store.add({
    hotFolderId: 'hf-1', status: STATUS.SUBMITTED,
    ingestedAt: new Date().toISOString(),
  });
  const out = helpers.retryFailed({ ingestionStore: store, configService: fakeConfigService([]) }, { id: rec.id });
  assert.equal(out.ok, false);
  assert.match(out.error, /not in failed state/);
});

test('retryFailed errors when the hot folder has been removed from config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oxh-'));
  const failedXml = path.join(root, '43192748.xml');
  fs.writeFileSync(failedXml, '<x/>', 'utf8');
  const store = freshIngestionStore();
  const rec = store.add({
    hotFolderId: 'hf-deleted', filePath: failedXml, status: STATUS.FAILED,
    ingestedAt: new Date().toISOString(),
  });
  try {
    const out = helpers.retryFailed(
      { ingestionStore: store, configService: fakeConfigService([]) },
      { id: rec.id }
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /hot folder hf-deleted no longer exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retryFailed errors when the failed XML no longer exists on disk', () => {
  const store = freshIngestionStore();
  const rec = store.add({
    hotFolderId: 'hf-1', filePath: '/nonexistent/path.xml',
    status: STATUS.FAILED, ingestedAt: new Date().toISOString(),
  });
  const cfg = fakeConfigService([{
    id: 'hf-1', label: 'PF', enabled: true,
    sourceFormat: 'photofinale', watchFolder: '/tmp/x', processedFolder: '/tmp/y',
  }]);
  const out = helpers.retryFailed({ ingestionStore: store, configService: cfg }, { id: rec.id });
  assert.equal(out.ok, false);
  assert.match(out.error, /no longer exists/);
});
