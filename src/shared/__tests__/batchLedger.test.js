'use strict';

/**
 * Unit tests for src/shared/batchLedger.js — the M2 generalisation of
 * the Darkroom Pro batch ledger (docs/epson-batch-splitting-brief.md).
 *
 * The shape is documented in the module docblock. These tests lock:
 *   - The canonical vs legacy field-name migration (readLedger fallback).
 *   - Every helper's mutation invariant.
 *   - Restart-safety via JSON round-trip (the ledger is persisted to
 *     electron-store, which JSON-serialises everything).
 *   - The DPOF acceptedAt/acceptedPrefix fields exist as null on every
 *     fresh entry (so downstream readers don't need per-controller
 *     branches).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_FIELD,
  LEGACY_FIELD,
  newLedger,
  recordBatchDispatched,
  recordBatchError,
  recordBatchAccepted,
  completeLedger,
  readLedger,
} = require('../batchLedger.js');

// ── Field name migration ───────────────────────────────────────────────────

test('CANONICAL_FIELD and LEGACY_FIELD are the expected strings', () => {
  // Pin the constants so a rename in the module doesn't silently break
  // any consumer that hard-codes the string.
  assert.equal(CANONICAL_FIELD, '_batchLedger');
  assert.equal(LEGACY_FIELD,    '_darkroomProBatchLedger');
});

test('readLedger: canonical field present → returned', () => {
  const ledger = { totalBatches: 3, batches: [] };
  const job    = { id: 1, _batchLedger: ledger };
  assert.strictEqual(readLedger(job), ledger);
});

test('readLedger: legacy field only (pre-M2 persisted job) → returned', () => {
  // The single backward-compat contract the brief asks for. A Darkroom
  // Pro job dispatched pre-M2 that hasn't completed by upgrade time
  // still has its ledger under the old name. readLedger must find it.
  const legacyLedger = { totalBatches: 5, batches: [{ index: 1, outcome: 'success' }] };
  const job          = { id: 42, _darkroomProBatchLedger: legacyLedger };
  assert.strictEqual(readLedger(job), legacyLedger);
});

test('readLedger: both fields present → canonical wins', () => {
  // Should never happen in practice (writers only touch one field), but
  // if a hand-edited config or a partial migration ever produced both,
  // the canonical name wins. Locks the tie-break so a future bug that
  // wrote to both fields doesn't silently regress to the legacy value.
  const canonical = { totalBatches: 2, batches: [], _tag: 'canonical' };
  const legacy    = { totalBatches: 9, batches: [], _tag: 'legacy' };
  const job       = { _batchLedger: canonical, _darkroomProBatchLedger: legacy };
  assert.strictEqual(readLedger(job), canonical);
});

test('readLedger: neither field present → null', () => {
  assert.equal(readLedger({ id: 1 }), null);
});

test('readLedger: defensive on null/undefined/non-object inputs', () => {
  assert.equal(readLedger(null),      null);
  assert.equal(readLedger(undefined), null);
  assert.equal(readLedger('not-an-object'), null);
  assert.equal(readLedger(42),        null);
});

// ── newLedger ─────────────────────────────────────────────────────────────

test('newLedger: canonical shape with the caller-supplied cap/totals + timestamps', () => {
  const before = Date.now();
  const ledger = newLedger({ cap: 100, totalBatches: 6, totalPrints: 600 });
  const after  = Date.now();

  assert.equal(ledger.cap,          100);
  assert.equal(ledger.totalBatches, 6);
  assert.equal(ledger.totalPrints,  600);
  assert.equal(ledger.completedAt,  null);
  assert.deepEqual(ledger.batches,  []);
  // startedAt is an ISO string in the [before, after] window.
  const startedAtMs = Date.parse(ledger.startedAt);
  assert.ok(startedAtMs >= before && startedAtMs <= after,
    `startedAt ${ledger.startedAt} must be within the test window`);
});

// ── recordBatchDispatched ─────────────────────────────────────────────────

test('recordBatchDispatched: appends a success entry with all canonical fields including DPOF nulls', () => {
  const ledger = newLedger({ cap: 100, totalBatches: 3, totalPrints: 300 });
  recordBatchDispatched(ledger, {
    index: 1, total: 3, filename: 'PXT-1_1.txt', destPath: '/hot/PXT-1_1.txt',
  });

  assert.equal(ledger.batches.length, 1);
  const b = ledger.batches[0];
  assert.equal(b.index,          1);
  assert.equal(b.total,          3);
  assert.equal(b.filename,       'PXT-1_1.txt');
  assert.equal(b.destPath,       '/hot/PXT-1_1.txt');
  assert.equal(b.outcome,        'success');
  assert.ok(b.dispatchedAt, 'dispatchedAt stamped');
  // DPOF fields present as null on every fresh entry — keeping the
  // shape uniform means readers don't need per-controller branches.
  assert.equal(b.acceptedAt,     null);
  assert.equal(b.acceptedPrefix, null);
});

test('recordBatchDispatched: returns the same ledger (chaining ergonomics)', () => {
  const ledger = newLedger({ cap: 10, totalBatches: 1, totalPrints: 5 });
  const r = recordBatchDispatched(ledger, { index: 1, total: 1, filename: 'x', destPath: '/x' });
  assert.strictEqual(r, ledger);
});

// ── recordBatchError ──────────────────────────────────────────────────────

test('recordBatchError: appends an error entry with destPath:null + error message', () => {
  const ledger = newLedger({ cap: 100, totalBatches: 3, totalPrints: 300 });
  recordBatchError(ledger, {
    index: 2, total: 3, filename: 'PXT-1_2.txt', error: 'ENOSPC no space left on device',
  });

  assert.equal(ledger.batches.length, 1);
  const b = ledger.batches[0];
  assert.equal(b.index,       2);
  assert.equal(b.outcome,     'error');
  assert.equal(b.destPath,    null);
  assert.equal(b.error,       'ENOSPC no space left on device');
  assert.ok(b.dispatchedAt);
  assert.equal(b.acceptedAt,     null);
  assert.equal(b.acceptedPrefix, null);
});

// ── recordBatchAccepted (DPOF signal) ─────────────────────────────────────

test('recordBatchAccepted: stamps acceptedAt + acceptedPrefix on the matching batch', () => {
  const ledger = newLedger({ cap: 100, totalBatches: 3, totalPrints: 300 });
  recordBatchDispatched(ledger, { index: 1, total: 3, filename: '_1', destPath: '/hot/1' });
  recordBatchDispatched(ledger, { index: 2, total: 3, filename: '_2', destPath: '/hot/2' });
  recordBatchDispatched(ledger, { index: 3, total: 3, filename: '_3', destPath: '/hot/3' });

  recordBatchAccepted(ledger, { index: 2, prefix: 'e', at: '2026-08-16T10:00:00.000Z' });

  assert.equal(ledger.batches[0].acceptedPrefix, null,  'batch 1 not signalled — still null');
  assert.equal(ledger.batches[1].acceptedPrefix, 'e',   'batch 2 stamped');
  assert.equal(ledger.batches[1].acceptedAt,     '2026-08-16T10:00:00.000Z');
  assert.equal(ledger.batches[2].acceptedPrefix, null,  'batch 3 not signalled');
});

test('recordBatchAccepted: prefix "q" (failed import) is stamped like "e" (accepted)', () => {
  const ledger = newLedger({ cap: 10, totalBatches: 1, totalPrints: 10 });
  recordBatchDispatched(ledger, { index: 1, total: 1, filename: 'x', destPath: '/x' });
  recordBatchAccepted(ledger, { index: 1, prefix: 'q' });
  assert.equal(ledger.batches[0].acceptedPrefix, 'q');
  assert.ok(ledger.batches[0].acceptedAt, 'acceptedAt still stamped for a failed import — "when did the terminal signal arrive"');
});

test('recordBatchAccepted: default `at` timestamp is set to now when omitted', () => {
  const ledger = newLedger({ cap: 10, totalBatches: 1, totalPrints: 10 });
  recordBatchDispatched(ledger, { index: 1, total: 1, filename: 'x', destPath: '/x' });
  const before = Date.now();
  recordBatchAccepted(ledger, { index: 1, prefix: 'e' });
  const after  = Date.now();
  const stampedMs = Date.parse(ledger.batches[0].acceptedAt);
  assert.ok(stampedMs >= before && stampedMs <= after);
});

test('recordBatchAccepted: unknown index → silent no-op, ledger unchanged', () => {
  // A stray monitor event with an out-of-range or already-torn-down
  // index should NOT throw and should NOT append a phantom entry.
  const ledger = newLedger({ cap: 10, totalBatches: 2, totalPrints: 10 });
  recordBatchDispatched(ledger, { index: 1, total: 2, filename: '1', destPath: '/1' });
  recordBatchDispatched(ledger, { index: 2, total: 2, filename: '2', destPath: '/2' });
  const before = JSON.stringify(ledger);
  recordBatchAccepted(ledger, { index: 999, prefix: 'e' });
  assert.equal(JSON.stringify(ledger), before, 'ledger unchanged on unknown index');
});

// ── completeLedger ────────────────────────────────────────────────────────

test('completeLedger: stamps completedAt (default now)', () => {
  const ledger = newLedger({ cap: 10, totalBatches: 1, totalPrints: 5 });
  assert.equal(ledger.completedAt, null, 'starts null');
  const before = Date.now();
  completeLedger(ledger);
  const after  = Date.now();
  const ms = Date.parse(ledger.completedAt);
  assert.ok(ms >= before && ms <= after);
});

test('completeLedger: honours explicit `at` string', () => {
  const ledger = newLedger({ cap: 10, totalBatches: 1, totalPrints: 5 });
  completeLedger(ledger, '2026-08-16T10:00:00.000Z');
  assert.equal(ledger.completedAt, '2026-08-16T10:00:00.000Z');
});

// ── Restart-safety via JSON round-trip ────────────────────────────────────

test('ledger survives a JSON round-trip verbatim (restart-safe on disk)', () => {
  // electron-store JSON-serialises everything on write and parses on
  // read. Every field type in the ledger must survive that cycle
  // unchanged — otherwise a mid-loop crash + restart would misread the
  // last-persisted state.
  const original = newLedger({ cap: 20, totalBatches: 2, totalPrints: 40 });
  recordBatchDispatched(original, { index: 1, total: 2, filename: 'a', destPath: '/a' });
  recordBatchError(original, { index: 2, total: 2, filename: 'b', error: 'boom' });
  recordBatchAccepted(original, { index: 1, prefix: 'e', at: '2026-08-16T10:00:00.000Z' });
  completeLedger(original, '2026-08-16T10:05:00.000Z');

  const roundTripped = JSON.parse(JSON.stringify(original));
  assert.deepEqual(roundTripped, original,
    'JSON.stringify/parse preserves every ledger field — no getters, no non-JSON types');
});

// ── Cross-controller shape uniformity ─────────────────────────────────────

test('a DP-authored ledger (no acceptedPrefix ever stamped) reads correctly via readLedger', () => {
  // The Darkroom Pro writer never calls recordBatchAccepted (there is
  // no accept signal on that pipeline). The ledger's batch entries
  // carry acceptedAt/acceptedPrefix as null forever. Verify that a
  // reader can still consume such a ledger without special-casing.
  const dpLedger = newLedger({ cap: 100, totalBatches: 2, totalPrints: 200 });
  recordBatchDispatched(dpLedger, { index: 1, total: 2, filename: '_1', destPath: '/1' });
  recordBatchDispatched(dpLedger, { index: 2, total: 2, filename: '_2', destPath: '/2' });
  completeLedger(dpLedger);

  const job = { _batchLedger: dpLedger };
  const read = readLedger(job);
  assert.strictEqual(read, dpLedger);
  for (const b of read.batches) {
    assert.equal(b.acceptedAt,     null, 'DP entries never have an accept signal');
    assert.equal(b.acceptedPrefix, null);
  }
});
