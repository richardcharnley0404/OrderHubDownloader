/**
 * Unit tests for server-capabilities.js
 *
 * The class accepts an injected store + logger + poll-interval fallback,
 * so tests build fresh instances against an in-memory Map-backed store
 * and a silent logger — no need to mock electron / electron-store.
 *
 * Test plan (from the M2 brief):
 *   1. Absent fields leave defaults; present-and-valid fields are stored.
 *   2. Out-of-range and non-numeric values are ignored, not clamped into nonsense.
 *   3. getPollIntervalMs falls back to the config value when unadvertised.
 *   4. getStatusPollIntervalMs returns null when unadvertised.
 *   5. disableFeatureForSession does not survive a fresh instance.
 *   6. updateFromCheckin returns true only when the poll cadence actually changed.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ServerCapabilities, DEFAULT_FEATURES } = require('../server-capabilities');

// ── helpers ─────────────────────────────────────────────────────────────────

function makeFakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get(key, fallback) {
      return data.has(key) ? data.get(key) : fallback;
    },
    set(key, value) {
      data.set(key, value);
    },
    // Peek for assertions (not on the electron-store API — tests only).
    _data: data,
  };
}

const SILENT_LOGGER = {
  info: () => {}, warn: () => {}, error: () => {},
  logError: () => {}, logWarning: () => {},
};

function makeCaps(opts = {}) {
  return new ServerCapabilities({
    store: opts.store || makeFakeStore(opts.initial),
    logger: opts.logger || SILENT_LOGGER,
    getPollingIntervalFallback: opts.fallback || (() => 60),
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

test('absent fields leave defaults; present-and-valid fields are stored', () => {
  const store = makeFakeStore();
  const caps = makeCaps({ store });

  // Fresh instance = defaults.
  assert.equal(caps.pollIntervalSeconds, null);
  assert.equal(caps.statusPollIntervalSeconds, null);
  assert.deepEqual(caps.features, { ...DEFAULT_FEATURES });

  // Partial update — only poll_interval_seconds and status_batch flag.
  caps.updateFromCheckin({
    poll_interval_seconds: 120,
    features: { status_batch: true },
  });
  assert.equal(caps.pollIntervalSeconds, 120);
  assert.equal(caps.statusPollIntervalSeconds, null, 'unset field stays at default');
  assert.equal(caps.features.status_batch, true);
  assert.equal(caps.features.pending_etag, false, 'unset flag stays at default');
  assert.equal(caps.features.status_batch_max, 200, 'unset max stays at default');

  // Persistence — a fresh instance backed by the same store rehydrates.
  const rehydrated = makeCaps({ store });
  assert.equal(rehydrated.pollIntervalSeconds, 120);
  assert.equal(rehydrated.features.status_batch, true);
});

test('out-of-range and non-numeric values are ignored, not clamped', () => {
  const caps = makeCaps();

  caps.updateFromCheckin({ poll_interval_seconds: 60 });      // baseline
  caps.updateFromCheckin({ poll_interval_seconds: 9 });       // below min
  assert.equal(caps.pollIntervalSeconds, 60, 'below min ignored, prev value kept');

  caps.updateFromCheckin({ poll_interval_seconds: 601 });     // above max
  assert.equal(caps.pollIntervalSeconds, 60, 'above max ignored');

  caps.updateFromCheckin({ poll_interval_seconds: 60.5 });    // non-integer
  assert.equal(caps.pollIntervalSeconds, 60, 'non-integer ignored');

  caps.updateFromCheckin({ poll_interval_seconds: '90' });    // string
  assert.equal(caps.pollIntervalSeconds, 60, 'string ignored');

  caps.updateFromCheckin({ status_poll_interval_seconds: 29 });
  assert.equal(caps.statusPollIntervalSeconds, null, 'below min ignored');

  caps.updateFromCheckin({ status_poll_interval_seconds: 3601 });
  assert.equal(caps.statusPollIntervalSeconds, null, 'above max ignored');

  caps.updateFromCheckin({ features: { status_batch: 'yes' } });
  assert.equal(caps.features.status_batch, false, 'non-boolean feature ignored');

  caps.updateFromCheckin({ features: { status_batch_max: 0 } });
  assert.equal(caps.features.status_batch_max, 200, 'batch max below range ignored');

  caps.updateFromCheckin({ features: { status_batch_max: 201 } });
  assert.equal(caps.features.status_batch_max, 200, 'batch max above range ignored');
});

test('getPollIntervalMs falls back to the config value when unadvertised', () => {
  const caps = makeCaps({ fallback: () => 45 });
  assert.equal(caps.getPollIntervalMs(), 45 * 1000);

  caps.updateFromCheckin({ poll_interval_seconds: 90 });
  assert.equal(caps.getPollIntervalMs(), 90 * 1000, 'server value wins once advertised');
});

test('getStatusPollIntervalMs returns null when unadvertised', () => {
  const caps = makeCaps();
  assert.equal(caps.getStatusPollIntervalMs(), null);

  caps.updateFromCheckin({ status_poll_interval_seconds: 300 });
  assert.equal(caps.getStatusPollIntervalMs(), 300 * 1000);
});

test('disableFeatureForSession does not survive a fresh instance', () => {
  const store = makeFakeStore();
  const caps = makeCaps({ store });

  caps.updateFromCheckin({ features: { status_batch: true } });
  assert.equal(caps.isEnabled('status_batch'), true);

  caps.disableFeatureForSession('status_batch');
  assert.equal(caps.isEnabled('status_batch'), false, 'disabled this session');

  // Snapshot still reflects what the server advertised — session mute is
  // separate from stored state.
  assert.equal(caps.getSnapshot().features.status_batch, true);

  // Rebuild against the same store — session mute must NOT persist.
  const rehydrated = makeCaps({ store });
  assert.equal(rehydrated.isEnabled('status_batch'), true, 'session mute did not persist');
});

test('updateFromCheckin returns true only when the poll cadence actually changed', () => {
  const caps = makeCaps();

  // null → 60: change.
  assert.equal(caps.updateFromCheckin({ poll_interval_seconds: 60 }), true);
  // 60 → 60: no change.
  assert.equal(caps.updateFromCheckin({ poll_interval_seconds: 60 }), false);
  // 60 → 90: change.
  assert.equal(caps.updateFromCheckin({ poll_interval_seconds: 90 }), true);
  // Field absent: no change (leaves 90 in place).
  assert.equal(caps.updateFromCheckin({ features: { status_batch: true } }), false);
  assert.equal(caps.pollIntervalSeconds, 90);
  // Invalid value: no change.
  assert.equal(caps.updateFromCheckin({ poll_interval_seconds: 5 }), false);
  assert.equal(caps.pollIntervalSeconds, 90);
  // Changing statusPoll alone is NOT a cadence change — only the primary
  // poll interval drives re-clocking (M4 handles status cadence).
  assert.equal(caps.updateFromCheckin({ status_poll_interval_seconds: 300 }), false);
});
