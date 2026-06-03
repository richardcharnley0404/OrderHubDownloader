/**
 * Unit tests for src/main/services/order-xml-ingestion-store.js.
 *
 * Run via:
 *   npm test
 *
 * The store accepts a `store` dependency, so all tests use a tiny in-memory
 * fake — no electron-store, no fs, no Electron runtime needed.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { OrderXmlIngestionStore, STATUS } = require('../order-xml-ingestion-store');

// In-memory store stub matching the electron-store surface this module uses.
function fakeStore() {
  const data = {};
  return {
    _data: data,
    get: (k, d) => (data[k] !== undefined ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
  };
}

function recAt(daysAgo, extra = {}) {
  const ts = new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();
  return {
    hotFolderId:    'hf-1',
    hotFolderLabel: 'PF',
    sourceFormat:   'photofinale',
    filename:       `order-${daysAgo}.xml`,
    externalId:     `ext-${daysAgo}`,
    customer:       'Test Customer',
    customerEmail:  'a@b.com',
    total:          10,
    productSummary: '5x7 Print',
    lineItemCount:  1,
    shippingMethod: 'Mail',
    status:         STATUS.SUBMITTED,
    orderhubOrderId: `oh-${daysAgo}`,
    errorMessage:   null,
    errorCode:      null,
    attempts:       1,
    ingestedAt:     ts,
    submittedAt:    ts,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Add + read back
// ---------------------------------------------------------------------------

test('add() persists a record and assigns an id when missing', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  const out = store.add(recAt(0));
  assert.ok(out.id, 'expected an id to be assigned');
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, out.id);
});

test('add() preserves a caller-supplied id', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  const out = store.add({ ...recAt(0), id: 'custom-id' });
  assert.equal(out.id, 'custom-id');
  assert.equal(store.getById('custom-id').id, 'custom-id');
});

test('add() rejects non-object input', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  assert.throws(() => store.add(null),       /must be an object/);
  assert.throws(() => store.add(undefined),  /must be an object/);
  assert.throws(() => store.add('hello'),    /must be an object/);
});

test('list() returns records newest-first', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  const a = store.add(recAt(5));
  const b = store.add(recAt(1));
  const c = store.add(recAt(10));
  const ids = store.list().map((r) => r.id);
  assert.deepEqual(ids, [b.id, a.id, c.id]); // newest first
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('list() filters by hotFolderId, sourceFormat, status', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  store.add(recAt(0, { hotFolderId: 'hf-A', status: STATUS.SUBMITTED }));
  store.add(recAt(1, { hotFolderId: 'hf-A', status: STATUS.FAILED, errorMessage: 'x', errorCode: 'X' }));
  store.add(recAt(2, { hotFolderId: 'hf-B', status: STATUS.DUPLICATE }));
  store.add(recAt(3, { hotFolderId: 'hf-B', sourceFormat: 'roes' }));

  assert.equal(store.list({ filters: { hotFolderId:  'hf-A' } }).length, 2);
  assert.equal(store.list({ filters: { status:       STATUS.FAILED } }).length, 1);
  assert.equal(store.list({ filters: { sourceFormat: 'photofinale' } }).length, 3);
  assert.equal(store.list({ filters: { sourceFormat: 'roes' } }).length, 1);
  assert.equal(store.list({ filters: { hotFolderId: 'hf-A', status: STATUS.SUBMITTED } }).length, 1);
});

test('count() returns the same total list() would, without slicing', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  store.add(recAt(0, { hotFolderId: 'hf-A' }));
  store.add(recAt(1, { hotFolderId: 'hf-B' }));
  store.add(recAt(2, { hotFolderId: 'hf-A' }));
  assert.equal(store.count(),                         3);
  assert.equal(store.count({ hotFolderId: 'hf-A' }),  2);
});

test('list() supports limit + offset for pagination', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  for (let i = 0; i < 5; i++) store.add(recAt(i, { externalId: `e-${i}` })); // 0..4 days ago

  const page1 = store.list({ limit: 2, offset: 0 });
  const page2 = store.list({ limit: 2, offset: 2 });
  const page3 = store.list({ limit: 2, offset: 4 });

  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.equal(page3.length, 1);
  // Together they reconstruct the full ordering.
  const combined = [...page1, ...page2, ...page3].map((r) => r.externalId);
  assert.deepEqual(combined, ['e-0', 'e-1', 'e-2', 'e-3', 'e-4']);
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

test('updateById() patches a record without losing fields', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  const a = store.add(recAt(0, { status: STATUS.FAILED, errorMessage: 'boom' }));
  const updated = store.updateById(a.id, { status: STATUS.SUBMITTED, errorMessage: null, attempts: 2 });
  assert.equal(updated.status,       STATUS.SUBMITTED);
  assert.equal(updated.errorMessage, null);
  assert.equal(updated.attempts,     2);
  // Untouched fields preserved.
  assert.equal(updated.externalId, a.externalId);
});

test('updateById() returns null for unknown id', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  store.add(recAt(0));
  assert.equal(store.updateById('does-not-exist', { status: STATUS.FAILED }), null);
});

test('removeById() drops a record', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  const a = store.add(recAt(0));
  assert.equal(store.removeById(a.id), true);
  assert.equal(store.removeById(a.id), false); // already gone
  assert.equal(store.list().length,    0);
});

test('clear() wipes everything', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  store.add(recAt(0));
  store.add(recAt(1));
  store.clear();
  assert.equal(store.list().length, 0);
});

// ---------------------------------------------------------------------------
// Pruning / retention
// ---------------------------------------------------------------------------

test('prune() drops records older than the retention window', () => {
  // Seed the underlying fake directly so add()'s inline prune doesn't
  // pre-empt the explicit prune() call we're testing.
  const fake = fakeStore();
  fake.set('records', [recAt(0), recAt(15), recAt(60), recAt(100)]);
  const store = new OrderXmlIngestionStore({ store: fake, retentionDays: 30 });

  const removed = store.prune();
  assert.equal(removed, 2);
  const remaining = store.list();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((r) => Date.parse(r.ingestedAt) >= Date.now() - 30 * 86400000));
});

test('add() prunes inline so the store size stays bounded over time', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore(), retentionDays: 7 });
  // Seed with rows just inside and just outside the window.
  store.add(recAt(2));
  store.add(recAt(5));
  store.add(recAt(8));
  store.add(recAt(20));
  // Adding a fresh row should also drop the 8/20-day-old rows.
  store.add(recAt(0));
  const remaining = store.list();
  assert.equal(remaining.length, 3);
  assert.ok(remaining.every((r) => Date.parse(r.ingestedAt) >= Date.now() - 7 * 86400000));
});

test('prune() tolerates records with missing/invalid ingestedAt', () => {
  const store = new OrderXmlIngestionStore({ store: fakeStore() });
  store.add({ hotFolderId: 'x', status: STATUS.SUBMITTED, ingestedAt: null });
  store.add({ hotFolderId: 'x', status: STATUS.SUBMITTED, ingestedAt: 'not-a-date' });
  // Neither should be pruned.
  assert.equal(store.prune(), 0);
  assert.equal(store.list().length, 2);
});

// ---------------------------------------------------------------------------
// now() injection (deterministic time-travel)
// ---------------------------------------------------------------------------

test('prune() uses the injected clock — supports time-travel', () => {
  // Seed records directly into the fake to bypass add()'s inline prune.
  const fixed = new Date('2026-05-08T12:00:00Z').getTime();
  const fake = fakeStore();
  fake.set('records', [
    { hotFolderId: 'x', status: STATUS.SUBMITTED,
      ingestedAt: new Date(fixed - 31 * 86400000).toISOString() }, // outside
    { hotFolderId: 'x', status: STATUS.SUBMITTED,
      ingestedAt: new Date(fixed - 5  * 86400000).toISOString() }, // inside
  ]);
  const store = new OrderXmlIngestionStore({
    store: fake, retentionDays: 30, now: () => new Date(fixed),
  });
  assert.equal(store.prune(), 1);
  assert.equal(store.list().length, 1);
});
