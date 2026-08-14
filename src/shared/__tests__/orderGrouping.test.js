'use strict';

/**
 * Unit tests for src/shared/orderGrouping.js.
 *
 * Pure derivation — no fs, no electron, no async. Covers every case
 * in the M2 section of docs/order-level-submission-picpro-brief.md:
 *
 *   1. All ready → dispatch as one.
 *   2. One member held → NOT ready; missing list names the holdback.
 *   3. Manifest job with no local record → NOT ready; conservative
 *      block (we cannot know whether it belongs to this controller).
 *   4. Cap not yet expired → NOT ready.
 *   5. Cap expired with a partial set → ready with eligible subset;
 *      missing list names the stragglers.
 *   6. Cap expired with ZERO eligible members → stays NOT ready
 *      (never dispatch an empty submission — the load-bearing rule).
 *   7. Film-dev jobs in localJobs and eligibility are ignored, even
 *      if the caller forgot to filter them (belt-and-braces).
 *   8. Single-job order → treated like any other group of size 1.
 *   9. Empty / null / garbage input → NOT ready, never throws.
 *
 * Plus:
 *   - Deterministic ordering (lexicographic string sort) on returned arrays.
 *   - Ids normalised to strings on output (caller can pass numbers).
 *   - eligibility as a Map and as a plain object both accepted.
 *   - A local job not in eligibility is not a member (membership is
 *     caller-scoped by design — this module does no routing).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateOrderGroup } = require('../orderGrouping');

// Fixtures — a local job is anything with an `id`. is_film_development
// defaults to false; other fields aren't consulted by this module.
function job(id, extras = {}) {
  return { id, is_film_development: false, ...extras };
}

function makeInput(overrides = {}) {
  return {
    manifestJobIds: [],
    localJobs:      [],
    eligibility:    new Map(),
    controllerId:   'ctrl-picpro-1',
    heldSince:      0,
    nowMs:          0,
    capMs:          30 * 60 * 1000,   // 30 minutes
    ...overrides,
  };
}

// ── Case 1 — all ready ───────────────────────────────────────────────────────

test('all ready → dispatch as one, no missing', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B', 'C'],
    localJobs:      [job('A'), job('B'), job('C')],
    eligibility:    new Map([['A', true], ['B', true], ['C', true]]),
  }));
  assert.equal(result.ready,  true);
  assert.equal(result.reason, 'all-ready');
  assert.deepEqual(result.memberJobIds,  ['A', 'B', 'C']);
  assert.deepEqual(result.missingJobIds, []);
});

// ── Case 2 — one member held ─────────────────────────────────────────────────

test('one member held → NOT ready; missing lists the held member', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B', 'C'],
    localJobs:      [job('A'), job('B'), job('C')],
    eligibility:    new Map([['A', true], ['B', false], ['C', true]]),
  }));
  assert.equal(result.ready,  false);
  assert.equal(result.reason, 'waiting-for-siblings');
  assert.deepEqual(result.memberJobIds,  [],
    'never dispatch until either ready-all or cap-expired');
  assert.deepEqual(result.missingJobIds, ['B']);
});

// ── Case 3 — manifest job with no local record ──────────────────────────────

test('manifest job with no local record → NOT ready; conservative block', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B', 'C'],   // C not landed yet
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', true], ['B', true]]),
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'waiting-for-siblings');
  assert.deepEqual(result.missingJobIds, ['C'],
    'no-local-record blocks the group even if the caller has never seen the job');
});

// ── Case 4 — cap not yet expired ────────────────────────────────────────────

test('cap not yet expired → NOT ready', () => {
  const heldSince = 1_000_000_000_000;
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', true], ['B', false]]),
    heldSince,
    nowMs:          heldSince + (5 * 60 * 1000),   // 5 min in
    capMs:          30 * 60 * 1000,                // 30-min cap
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'waiting-for-siblings');
});

// ── Case 5 — cap expired with a partial set ─────────────────────────────────

test('cap expired with a partial set → ready with eligible subset', () => {
  const heldSince = 1_000_000_000_000;
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B', 'C', 'D'],
    localJobs:      [job('A'), job('B'), job('C'), job('D')],
    eligibility:    new Map([
      ['A', true],
      ['B', true],
      ['C', false],   // held past cap → straggler
      ['D', true],
    ]),
    heldSince,
    nowMs:          heldSince + (31 * 60 * 1000),  // 1 min past 30-min cap
    capMs:          30 * 60 * 1000,
  }));
  assert.equal(result.ready,  true);
  assert.equal(result.reason, 'cap-expired');
  assert.deepEqual(result.memberJobIds,  ['A', 'B', 'D'],
    'eligible subset only — never dispatch a held member');
  assert.deepEqual(result.missingJobIds, ['C'],
    'the straggler is named so the caller can log which one went and which did not');
});

test('cap expired exactly on the boundary (>=) still fires', () => {
  const heldSince = 1_000_000_000_000;
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', true], ['B', false]]),
    heldSince,
    nowMs:          heldSince + (30 * 60 * 1000),   // exactly on the cap
    capMs:          30 * 60 * 1000,
  }));
  assert.equal(result.ready, true);
  assert.equal(result.reason, 'cap-expired');
});

// ── Case 6 — cap expired with ZERO eligible members ─────────────────────────

test('cap expired with ZERO eligible members → stays NOT ready (never dispatch empty)', () => {
  const heldSince = 1_000_000_000_000;
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', false], ['B', false]]),   // both held
    heldSince,
    nowMs:          heldSince + (60 * 60 * 1000),   // way past cap
    capMs:          30 * 60 * 1000,
  }));
  assert.equal(result.ready, false,
    'cap alone does not create an empty submission — the load-bearing rule');
  assert.equal(result.reason, 'waiting-for-siblings');
  assert.deepEqual(result.missingJobIds, ['A', 'B']);
});

// ── Case 7 — film-dev jobs ──────────────────────────────────────────────────

test('film-dev job in localJobs is stripped (belt-and-braces)', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B', { is_film_development: true })],
    eligibility:    new Map([['A', true]]),
  }));
  // 'B' is film-dev — locally present but not a member, and NOT missing
  // in the "waiting on the S3 downloader" sense: film-dev is never in
  // scope for print. Since B has no local (non-film-dev) record, it
  // reads as missing from local. That is the conservative block the
  // brief calls out; a manifest that mixes film-dev + print jobs on
  // a merge-enabled PIC Pro controller is a caller-side bug the
  // caller must handle by filtering the manifest itself.
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingJobIds, ['B']);
});

test('film-dev id in eligibility is stripped (belt-and-braces)', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A'],
    localJobs:      [job('A'), job('B', { is_film_development: true })],
    // Caller regression: film-dev id leaked into eligibility.
    // Its local record IS film-dev, so it must be stripped and cannot
    // contribute to readiness or membership.
    eligibility:    new Map([['A', true], ['B', true]]),
  }));
  assert.equal(result.ready, true);
  assert.equal(result.reason, 'all-ready');
  assert.deepEqual(result.memberJobIds, ['A'],
    'film-dev must not become a member — it never routes to a printer');
});

// ── Case 8 — single-job order ───────────────────────────────────────────────

test('single-job order all-ready → dispatch alone', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A'],
    localJobs:      [job('A')],
    eligibility:    new Map([['A', true]]),
  }));
  assert.equal(result.ready, true);
  assert.equal(result.reason, 'all-ready');
  assert.deepEqual(result.memberJobIds, ['A']);
});

test('single-job order held → NOT ready', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A'],
    localJobs:      [job('A')],
    eligibility:    new Map([['A', false]]),
  }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingJobIds, ['A']);
});

// ── Case 9 — empty / garbage input ──────────────────────────────────────────

test('null input → NOT ready, no throw', () => {
  const result = evaluateOrderGroup(null);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'waiting-for-siblings');
  assert.deepEqual(result.memberJobIds, []);
  assert.deepEqual(result.missingJobIds, []);
});

test('undefined input → NOT ready, no throw', () => {
  const result = evaluateOrderGroup(undefined);
  assert.equal(result.ready, false);
});

test('non-object input (string, number) → NOT ready, no throw', () => {
  for (const bad of ['nope', 42, true, [], NaN]) {
    const result = evaluateOrderGroup(bad);
    assert.equal(result.ready, false, `input ${JSON.stringify(bad)} must not throw`);
  }
});

test('empty input (all defaults) → NOT ready — nothing to dispatch', () => {
  const result = evaluateOrderGroup(makeInput({}));
  assert.equal(result.ready, false,
    'no manifest jobs AND no members means nothing to dispatch — not "all-ready"');
  assert.equal(result.reason, 'waiting-for-siblings');
});

test('missing controllerId → NOT ready', () => {
  const result = evaluateOrderGroup(makeInput({ controllerId: '' }));
  assert.equal(result.ready, false);
});

test('manifestJobIds not an array → NOT ready', () => {
  const result = evaluateOrderGroup(makeInput({ manifestJobIds: 'ABC' }));
  assert.equal(result.ready, false);
});

test('localJobs not an array → NOT ready', () => {
  const result = evaluateOrderGroup(makeInput({ localJobs: null }));
  assert.equal(result.ready, false);
});

test('eligibility of unexpected type (string, number) → NOT ready', () => {
  for (const bad of ['nope', 42, true]) {
    const result = evaluateOrderGroup(makeInput({ eligibility: bad }));
    assert.equal(result.ready, false, `eligibility ${JSON.stringify(bad)} must not throw`);
  }
});

// ── Deterministic ordering ──────────────────────────────────────────────────

test('returned arrays are deterministically sorted (lexicographic)', () => {
  // Insertion order is reverse — deliberate. The output must not
  // depend on Map iteration order.
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['C', 'A', 'B'],
    localJobs:      [job('C'), job('A'), job('B')],
    eligibility:    new Map([['C', true], ['A', true], ['B', true]]),
  }));
  assert.deepEqual(result.memberJobIds, ['A', 'B', 'C']);
});

test('missingJobIds is deterministically sorted', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['Z', 'A', 'M'],
    localJobs:      [job('M')],
    eligibility:    new Map([['M', false]]),
  }));
  assert.deepEqual(result.missingJobIds, ['A', 'M', 'Z'],
    'missing includes both no-local-record (A, Z) and held-members (M) — all sorted');
});

// ── Id-type normalisation ───────────────────────────────────────────────────

test('numeric ids are normalised to strings on output', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: [1, 2, 3],
    localJobs:      [job(1), job(2), job(3)],
    eligibility:    { 1: true, 2: true, 3: true },   // plain object form
  }));
  assert.equal(result.ready, true);
  assert.deepEqual(result.memberJobIds, ['1', '2', '3'],
    'strings on output so equality comparisons downstream are stable');
});

test('duplicate ids across manifest + eligibility do not double-count in missing', () => {
  // 'B' is missing from local AND absent from eligibility. It must
  // appear at most once in missingJobIds — the caller uses this list
  // for a count in the hold-chip label.
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B', 'B'],   // deliberate duplicate
    localJobs:      [job('A')],
    eligibility:    new Map([['A', false]]),   // A held too, missing includes both
  }));
  assert.deepEqual(result.missingJobIds, ['A', 'B']);
});

// ── Membership is caller-scoped ─────────────────────────────────────────────

test('a local job NOT in eligibility is not a member (caller decides routing)', () => {
  // 'B' has a local record but is not in eligibility — the caller has
  // decided it routes to a different controller. It must not block
  // this group's readiness.
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', true]]),   // B intentionally absent
  }));
  assert.equal(result.ready, true,
    'membership is scoped by the caller — a local job routed elsewhere does not block');
  assert.deepEqual(result.memberJobIds, ['A']);
  assert.deepEqual(result.missingJobIds, []);
});

// ── eligibility formats ─────────────────────────────────────────────────────

test('eligibility as a plain object is accepted', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    { A: true, B: true },
  }));
  assert.equal(result.ready, true);
  assert.deepEqual(result.memberJobIds, ['A', 'B']);
});

test('eligibility as a Map is accepted', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', true], ['B', true]]),
  }));
  assert.equal(result.ready, true);
});

// ── Cap-validity edge cases (must not crash into cap-expired state) ─────────

test('capMs missing → cap check is skipped (never dispatches on missing cap)', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', true], ['B', false]]),
    heldSince:      1_000_000_000_000,
    nowMs:          9_999_999_999_999,
    capMs:          undefined,
  }));
  assert.equal(result.ready, false,
    'a missing cap must not accidentally allow the group through — caller is meant to default it');
});

test('capMs zero → cap check is skipped', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', true], ['B', false]]),
    heldSince:      1_000_000_000_000,
    nowMs:          9_999_999_999_999,
    capMs:          0,
  }));
  assert.equal(result.ready, false);
});

test('heldSince missing → cap check is skipped', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A', 'B'],
    localJobs:      [job('A'), job('B')],
    eligibility:    new Map([['A', true], ['B', false]]),
    heldSince:      null,
    nowMs:          9_999_999_999_999,
    capMs:          30 * 60 * 1000,
  }));
  assert.equal(result.ready, false,
    'no heldSince stamp yet → cap cannot have expired');
});

// ── Local record that is null / malformed ───────────────────────────────────

test('null entries in localJobs are ignored, do not throw', () => {
  const result = evaluateOrderGroup(makeInput({
    manifestJobIds: ['A'],
    localJobs:      [null, job('A'), undefined],
    eligibility:    new Map([['A', true]]),
  }));
  assert.equal(result.ready, true);
});
