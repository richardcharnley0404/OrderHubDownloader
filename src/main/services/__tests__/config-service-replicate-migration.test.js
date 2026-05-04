/**
 * Unit tests for config-service.js's _migrateReplicateProvider() — the
 * one-shot migration that removes the legacy Replicate provider on first
 * launch after upgrade.
 *
 * Verified scenarios (from Phase 1 plan §11 & §14):
 *   - Stored 'replicate' → rewritten to 'local', _migratedFromReplicate=true,
 *     replicateApiKey deleted, _replicateProviderMigratedAt stamped.
 *   - Stored 'topaz' with replicateApiKey orphan → topaz preserved, key
 *     deleted, no toast flag (operator was already on Topaz).
 *   - Already migrated (flag stamped) → idempotent no-op.
 *   - Fresh install (no enhancementProvider stored) → defaults kick in;
 *     migration stamps and runs harmlessly.
 *
 * Pattern: Module.prototype.require override stubs electron-store with an
 * in-memory fake. Same convention as config-service-bom.test.js — except
 * we vary the fake store's initial state per test by loading config-service
 * fresh (cleared from require.cache) on each run.
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SVC = path.join(REPO, 'src', 'main', 'services');
const CONFIG_SERVICE_PATH = require.resolve(path.join(SVC, 'config-service.js'));

// In-memory fake of electron-store. Each instance starts with the supplied
// initial state; .get falls back to the schema default if the key is unset.
function makeFakeStoreClass(initial) {
  return function FakeStore(options) {
    const store = new Map(Object.entries(initial));
    const schema = options && options.schema;

    return {
      get(key, fallback) {
        if (store.has(key)) return store.get(key);
        if (schema && schema[key] && Object.prototype.hasOwnProperty.call(schema[key], 'default')) {
          return schema[key].default;
        }
        return fallback;
      },
      set(key, value) { store.set(key, value); },
      delete(key) { store.delete(key); },
      has(key) { return store.has(key); },
      // Test-only inspection.
      _all() { return Object.fromEntries(store); },
    };
  };
}

/**
 * Load (or reload) config-service against a fresh fake store. Returns
 * the singleton instance and its underlying fake store handle.
 */
function loadConfigServiceWithStore(initial) {
  // Clear the module cache so the constructor runs again.
  delete require.cache[CONFIG_SERVICE_PATH];

  const FakeStore = makeFakeStoreClass(initial);
  let capturedStore;
  const Wrapper = function (...args) {
    const inst = FakeStore.call(this, ...args) || this;
    capturedStore = inst;
    return inst;
  };

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (req) {
    if (req === 'electron-store') return Wrapper;
    return originalRequire.apply(this, arguments);
  };

  try {
    const svc = require(path.join(SVC, 'config-service.js'));
    return { svc, fake: capturedStore };
  } finally {
    Module.prototype.require = originalRequire;
  }
}

// =============================================================================
// Tests
// =============================================================================

test("migration: stored 'replicate' provider is rewritten to 'local' and toast flag set", () => {
  const { fake } = loadConfigServiceWithStore({
    enhancementProvider: 'replicate',
    replicateApiKey: 'r8_legacy_secret',
    topazApiKey: '',
  });

  assert.equal(fake.get('enhancementProvider'), 'local',
    'provider rewritten to local');
  assert.equal(fake.get('_migratedFromReplicate'), true,
    'one-shot toast trigger flagged');
  assert.equal(fake.has('replicateApiKey'), false,
    'orphan replicateApiKey deleted');
  assert.equal(typeof fake.get('_replicateProviderMigratedAt'), 'string',
    'migration timestamp stamped');
});

test("migration: stored 'topaz' provider is preserved; legacy key still scrubbed; no toast", () => {
  const { fake } = loadConfigServiceWithStore({
    enhancementProvider: 'topaz',
    topazApiKey: 'tpz-real-key',
    replicateApiKey: 'r8_dead_key', // user briefly tried Replicate then switched
  });

  assert.equal(fake.get('enhancementProvider'), 'topaz',
    'topaz operators stay on topaz');
  assert.equal(fake.get('_migratedFromReplicate'), false,
    'no toast — they were not USING replicate');
  assert.equal(fake.has('replicateApiKey'), false,
    'orphan replicateApiKey scrubbed regardless');
  assert.equal(typeof fake.get('_replicateProviderMigratedAt'), 'string',
    'migration runs idempotently in any case');
});

test('migration: already-migrated install is a no-op', () => {
  const { fake } = loadConfigServiceWithStore({
    _replicateProviderMigratedAt: '2025-01-01T00:00:00.000Z',
    enhancementProvider: 'replicate',  // somehow set after migration — should be left alone
    replicateApiKey: 'r8_should_be_deleted_only_via_migration',
  });

  // _replicateProviderMigratedAt was already set, so the migration short-circuits.
  // The 'replicate' value lingers, but the runtime defensive remap in
  // enhancementManager.getProvider() will treat it as 'local' — verified by
  // enhancementManager.test.js. Here we just confirm the migration didn't
  // act a second time.
  assert.equal(fake.get('enhancementProvider'), 'replicate',
    'already-stamped install: provider value unchanged by repeat migration');
  assert.equal(fake.has('replicateApiKey'), true,
    'already-stamped install: legacy key preserved (migration is single-shot)');
  assert.equal(fake.get('_replicateProviderMigratedAt'), '2025-01-01T00:00:00.000Z',
    'timestamp not overwritten');
});

test('migration: fresh install (no stored config) stamps + flags benignly', () => {
  // Fresh install: nothing in the store, schema defaults take effect.
  const { fake } = loadConfigServiceWithStore({});

  // Default `enhancementProvider` is 'local' per the schema (M3 default change).
  assert.equal(fake.get('enhancementProvider'), 'local');
  // No real migration happened (was never on replicate), so no toast.
  assert.equal(fake.get('_migratedFromReplicate'), false);
  // Stamp is still set so future launches don't try.
  assert.equal(typeof fake.get('_replicateProviderMigratedAt'), 'string');
});

test('clearReplicateMigrationToast(): flips the one-shot flag back to false', () => {
  const { svc, fake } = loadConfigServiceWithStore({
    enhancementProvider: 'replicate',
    replicateApiKey: 'r8_x',
  });
  // Migration ran during construction and set the flag.
  assert.equal(fake.get('_migratedFromReplicate'), true);

  svc.clearReplicateMigrationToast();
  assert.equal(fake.get('_migratedFromReplicate'), false,
    'flag flipped back to false');

  // Calling again is harmless.
  svc.clearReplicateMigrationToast();
  assert.equal(fake.get('_migratedFromReplicate'), false);
});

test('schema defaults: enhancementProvider defaults to local for fresh installs', () => {
  // Empty store, no overrides — confirm the new default is 'local', not 'replicate'.
  const { fake } = loadConfigServiceWithStore({});
  assert.equal(fake.get('enhancementProvider'), 'local');
  assert.equal(fake.get('enhancementRescoreAfter'), true);
  assert.equal(fake.get('enhancementLocalTileSize'), 256);
  assert.equal(fake.get('enhancementLocalTileOverlap'), 16);
});
