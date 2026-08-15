'use strict';

/**
 * Unit tests for src/shared/holdForReview.js.
 *
 * Pure derivation — no fs, no electron, no async. Asserts the five M2
 * scenarios from the S3 Artwork Channel brief plus edge cases (missing
 * fields, multi-cause holds, the manual-source-suppresses-manual-file
 * coalesce rule).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeHoldForReview,
  formatHoldReasons,
  deriveHoldChipLabel,
  REASON,
  REASON_TEXT,
} = require('../holdForReview');

// Helpers for terser test bodies — the bare minimum a job needs for the
// derivation to work.
function jobOf({ source = null, files = [] } = {}) {
  return { artwork_source: source, artwork_files: files };
}
function file({ source = 'pixfizz', production_ready = true } = {}) {
  return { source, production_ready };
}

// ── Brief M2 scenarios (1–5) ─────────────────────────────────────────────────

test('Scenario 1: manual job → held with manual-source reason', () => {
  const r = computeHoldForReview(jobOf({
    source: 'manual',
    files: [file({ source: 'manual' }), file({ source: 'manual' })],
  }));
  assert.equal(r._holdForReview, true);
  // manual-source suppresses the redundant manual-file (every file is
  // already manual, that's implied by the job-level statement).
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_SOURCE]);
});

test('Scenario 2: pixfizz job + one manual replacement file → held with manual-file reason', () => {
  const r = computeHoldForReview(jobOf({
    source: 'pixfizz',
    files: [file({ source: 'pixfizz' }), file({ source: 'manual' })],
  }));
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_FILE]);
});

test('Scenario 4 (regression baseline): pure pixfizz job, all production_ready=true → NOT held', () => {
  const r = computeHoldForReview(jobOf({
    source: 'pixfizz',
    files: [file({ source: 'pixfizz' }), file({ source: 'pixfizz' }), file({ source: 'pixfizz' })],
  }));
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Regression (2026-05-24): pixfizz job with ALL files production_ready=false is NOT held', () => {
  // OrderHub returns production_ready: false as a DEFAULT state on
  // Pixfizz-source artwork_files entries; the original hold-rule clause
  // that treated that as a hold reason mis-flagged every Pixfizz job
  // (PXDEMO-YUED5N-1, PXDEMO-6M49PK-1, PXDEMO-AUXZWJ-1 were the field
  // evidence). The clause was removed; this test guards against
  // re-introduction. Hold should fire on manual *source*, never on
  // finalisation flags.
  const r = computeHoldForReview(jobOf({
    source: 'pixfizz',
    files: [
      file({ source: 'pixfizz', production_ready: false }),
      file({ source: 'pixfizz', production_ready: false }),
      file({ source: 'pixfizz', production_ready: false }),
    ],
  }));
  assert.equal(r._holdForReview, false,
    'Pixfizz-source files with production_ready: false are a DEFAULT API state — never a hold reason on their own');
  assert.deepEqual(r._holdReasons, []);
});

// ── Combo / coalesce rules ───────────────────────────────────────────────────

test('Coalesce: manual-source suppresses redundant manual-file even when files exist', () => {
  const r = computeHoldForReview(jobOf({
    source: 'manual',
    files: [file({ source: 'manual' })],
  }));
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_SOURCE],
    'manual-source implies manual-file; do not list both');
});

// ── Edge cases — graceful handling ───────────────────────────────────────────

test('Edge: null job → not held, empty reasons', () => {
  const r = computeHoldForReview(null);
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Edge: missing artwork_files → not held when source is pixfizz', () => {
  const r = computeHoldForReview({ artwork_source: 'pixfizz' });
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Edge: artwork_files is not an array → treated as empty', () => {
  const r = computeHoldForReview({ artwork_source: 'pixfizz', artwork_files: 'oops' });
  assert.equal(r._holdForReview, false);
});

test('Edge: empty artwork_files + manual source → still held by source', () => {
  const r = computeHoldForReview(jobOf({ source: 'manual', files: [] }));
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_SOURCE]);
});

test('Edge: file entry null does not crash and does not trigger hold', () => {
  const r = computeHoldForReview({ artwork_source: 'pixfizz', artwork_files: [null, undefined] });
  assert.equal(r._holdForReview, false);
});

// ── formatHoldReasons ────────────────────────────────────────────────────────

test('formatHoldReasons: joins operator-readable text with "; "', () => {
  // formatHoldReasons is reason-agnostic — it joins whatever it gets. Use
  // both currently-defined reasons even though computeHoldForReview never
  // emits them together (manual-source suppresses manual-file).
  const text = formatHoldReasons([REASON.MANUAL_SOURCE, REASON.MANUAL_FILE]);
  assert.equal(text, `${REASON_TEXT[REASON.MANUAL_SOURCE]}; ${REASON_TEXT[REASON.MANUAL_FILE]}`);
});

test('formatHoldReasons: empty array → empty string', () => {
  assert.equal(formatHoldReasons([]), '');
});

test('formatHoldReasons: non-array → empty string (defensive)', () => {
  assert.equal(formatHoldReasons(null), '');
  assert.equal(formatHoldReasons(undefined), '');
});

test('formatHoldReasons: unknown reason code falls through verbatim', () => {
  assert.equal(formatHoldReasons(['nonsense']), 'nonsense');
});

// ── Routing hold (v1.7.8) ────────────────────────────────────────────────────

test('Routing hold: process in held set → ROUTING_HOLD reason', () => {
  const r = computeHoldForReview(
    { artwork_source: 'pixfizz', artwork_files: [], process: 'Lab' },
    { routingHeldProcesses: new Set(['Lab']) },
  );
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.ROUTING_HOLD]);
});

test('Routing hold: process NOT in held set → no routing reason', () => {
  const r = computeHoldForReview(
    { artwork_source: 'pixfizz', artwork_files: [], process: 'Lab' },
    { routingHeldProcesses: new Set(['Dyesub']) },
  );
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Routing hold: _routingHoldReleased=true overrides the held set', () => {
  const r = computeHoldForReview(
    { artwork_source: 'pixfizz', artwork_files: [], process: 'Lab', _routingHoldReleased: true },
    { routingHeldProcesses: new Set(['Lab']) },
  );
  assert.equal(r._holdForReview, false,
    'operator-released job stays released even when the process is still flagged hold');
  assert.deepEqual(r._holdReasons, []);
});

test('Routing hold: stacks with manual-source (both reasons listed)', () => {
  const r = computeHoldForReview(
    { artwork_source: 'manual', artwork_files: [], process: 'Lab' },
    { routingHeldProcesses: new Set(['Lab']) },
  );
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_SOURCE, REASON.ROUTING_HOLD]);
});

test('Routing hold: omitting ctx is backward-compatible (no routing reason)', () => {
  // Pre-v1.7.8 callers pass no ctx — must behave identically to before.
  const r = computeHoldForReview({
    artwork_source: 'pixfizz', artwork_files: [], process: 'Lab',
  });
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Routing hold: ctx without routingHeldProcesses is treated as empty', () => {
  const r = computeHoldForReview(
    { artwork_source: 'pixfizz', artwork_files: [], process: 'Lab' },
    {},
  );
  assert.equal(r._holdForReview, false);
});

test('Routing hold: ROUTING_HOLD has operator-readable text in REASON_TEXT', () => {
  assert.equal(
    REASON_TEXT[REASON.ROUTING_HOLD],
    'Held for manual routing — pick a controller',
  );
});

// ── Over-batch-threshold (M3, 2026-08-09) ────────────────────────────────────
//
// The reason fires when the job's total print count exceeds the controller's
// maxPrintsPerJob cap. Darkroom Pro only in M1/M3. The resolver contract
// is deliberately "both-sides-known-or-null": the caller resolves the route
// AND reads the manifest (same source M4's splitter uses; job.quantity is
// unreliable across sources — see the M3 investigation). This keeps the
// derivation itself trivially pure — no fs, no store, no per-source
// arithmetic. Tests exercise the contract directly.

const baseJob = { artwork_source: 'pixfizz', artwork_files: [] };
const checkOf = (cap, prints) => (() => ({ cap, prints }));

test('Batch threshold: prints over cap → OVER_BATCH_THRESHOLD in _holdReasons', () => {
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOf(100, 1200) });
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.OVER_BATCH_THRESHOLD]);
});

test('Batch threshold: prints equal to cap → NOT held (cap is inclusive upper bound)', () => {
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOf(100, 100) });
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Batch threshold: prints under cap → NOT held', () => {
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOf(100, 50) });
  assert.equal(r._holdForReview, false);
});

test('Batch threshold: resolver returns null (no cap / non-darkroompro / unrouted) → NOT held', () => {
  // Null is now reserved for "feature off entirely" — no cap configured,
  // non-darkroompro route, or unrouted job. Manifest-missing WITH a
  // configured cap uses the `unsizable: true` sentinel instead (see the
  // fail-safe tests below); the "prints == null → null" fall-open was
  // the exact bug fixed on 2026-08-15.
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: () => null });
  assert.equal(r._holdForReview, false);
});

test('Batch threshold: resolver returns invalid cap → NOT held (feature-off contract)', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', null, undefined]) {
    const r = computeHoldForReview(baseJob, { batchThresholdCheck: () => ({ cap: bad, prints: 1200 }) });
    assert.equal(r._holdForReview, false, `bad cap ${JSON.stringify(bad)} must not trip the hold`);
  }
});

test('Batch threshold: resolver returns invalid prints → NOT held (defensive)', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'abc', null, undefined]) {
    const r = computeHoldForReview(baseJob, { batchThresholdCheck: () => ({ cap: 100, prints: bad }) });
    assert.equal(r._holdForReview, false, `bad prints ${JSON.stringify(bad)} must not trip the hold`);
  }
});

test('Batch threshold: omitting the resolver from ctx is backward-compatible (M1 behaviour)', () => {
  const r = computeHoldForReview(baseJob, { routingHeldProcesses: new Set() });
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Batch threshold: derivation ignores job.quantity entirely — count comes from resolver only', () => {
  // Regression guard against the earlier draft that trusted job.quantity.
  // job.quantity means different things across sources (Pixfizz vs manual
  // vs film — see s3-artwork-downloader.js:434-479). The pure derivation
  // must not read it; the caller owns the print-count source.
  const r = computeHoldForReview(
    { ...baseJob, quantity: 9999 },
    { batchThresholdCheck: checkOf(100, 50) },
  );
  assert.equal(r._holdForReview, false, 'job.quantity of 9999 must not override resolver-supplied prints of 50');
});

test('Batch threshold: stacks with manual-source', () => {
  const r = computeHoldForReview(
    { artwork_source: 'manual', artwork_files: [] },
    { batchThresholdCheck: checkOf(100, 1200) },
  );
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_SOURCE, REASON.OVER_BATCH_THRESHOLD]);
});

test('Batch threshold: stacks with routing-hold', () => {
  const r = computeHoldForReview(
    { artwork_source: 'pixfizz', artwork_files: [], process: 'Lab' },
    {
      routingHeldProcesses: new Set(['Lab']),
      batchThresholdCheck:  checkOf(100, 1200),
    },
  );
  assert.deepEqual(r._holdReasons, [REASON.ROUTING_HOLD, REASON.OVER_BATCH_THRESHOLD]);
});

test('Batch threshold: stacks with manual-source AND routing-hold (all three)', () => {
  const r = computeHoldForReview(
    { artwork_source: 'manual', artwork_files: [], process: 'Lab' },
    {
      routingHeldProcesses: new Set(['Lab']),
      batchThresholdCheck:  checkOf(100, 1200),
    },
  );
  assert.deepEqual(r._holdReasons, [
    REASON.MANUAL_SOURCE,
    REASON.ROUTING_HOLD,
    REASON.OVER_BATCH_THRESHOLD,
  ]);
});

test('Batch threshold: contract — _holdForReview flips true so auto-print skips (runAutoPrint reads this exact field)', () => {
  // ipc-handlers.runAutoPrint gate:
  //   const hold = computeHoldForReview(job, { …, batchThresholdCheck });
  //   if (hold._holdForReview) continue;
  // The gate reads only _holdForReview. Locking the shape here means the
  // auto-print skip works as long as this flag is true — no separate
  // integration test needed against the auto-print loop.
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOf(100, 1200) });
  assert.equal(r._holdForReview, true, 'runAutoPrint continues (skips dispatch) on this exact truthy value');
});

test('Batch threshold: contract — manual Send-to-Print bypasses this gate (documented by inspection)', () => {
  // ipc-handlers.jobs:sendToPrint (:518) never calls computeHoldForReview
  // and does not read _holdForReview. Verified by:
  //   grep -n 'computeHoldForReview\|_holdForReview' src/main/ipc-handlers.js
  //   → the only auto-print references, plus this doc-only assertion.
  // This test exists to lock the intent: a batch-threshold hold must
  // never block the operator's explicit click. If a future refactor
  // adds a hold gate to jobs:sendToPrint, this test becomes a marker
  // to reason about that decision explicitly.
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOf(100, 1200) });
  assert.equal(r._holdForReview, true);
  assert.ok(true, 'manual send-to-print is intentionally hold-agnostic — see ipc-handlers.js:518-660');
});

test('Batch threshold: resolver contract — callers wrap; a throwing resolver propagates', () => {
  // The pure derivation does NOT try/catch the resolver — that's the
  // caller's responsibility (job-service._getBatchThresholdCheck and the
  // ipc-handlers runAutoPrint mirror both wrap and return null on catch,
  // giving the fail-open behaviour "an unrelated store failure can't
  // spuriously hold every job"). This test locks the module boundary:
  // holdForReview stays pure; callers own the safety net.
  assert.throws(() => computeHoldForReview(baseJob, {
    batchThresholdCheck: () => { throw new Error('routing store unavailable'); },
  }));
});

test('Batch threshold: OVER_BATCH_THRESHOLD has operator-readable text in REASON_TEXT', () => {
  const t = REASON_TEXT[REASON.OVER_BATCH_THRESHOLD];
  assert.ok(typeof t === 'string' && t.length > 0);
  assert.ok(/send to print/i.test(t), 'tooltip should tell the operator what to do next');
});

// ── autoSendBatches (M2, 2026-08-15) ────────────────────────────────────────
//
// Opt-in on the resolving Darkroom Pro controller: when the resolver returns
// { …, autoSendBatches: true }, the OVER_BATCH_THRESHOLD reason is suppressed
// so auto-print dispatches the job and the existing splitter writes the
// multiple _1.txt, _2.txt files unchanged. Only that one reason is suppressed
// — every other hold reason (manual-source, routing-hold, …) still fires,
// stacked as before.
//
// Strict `=== true` check: a truthy non-boolean (e.g. a string "true" from
// hand-edited config) must NOT silently suppress the operator-review gate.

const checkOfAuto = (cap, prints, autoSendBatches) =>
  (() => ({ cap, prints, autoSendBatches }));

test('autoSendBatches: cap exceeded + off → OVER_BATCH_THRESHOLD raised (regression baseline)', () => {
  // Explicit false — proves the flag being present-and-false behaves
  // identically to it being absent (M1/M3 behaviour).
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOfAuto(100, 1200, false) });
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.OVER_BATCH_THRESHOLD]);
});

test('autoSendBatches: cap exceeded + on → OVER_BATCH_THRESHOLD suppressed, job dispatches unattended', () => {
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOfAuto(100, 1200, true) });
  assert.equal(r._holdForReview, false, 'auto-print gate reads _holdForReview; false = dispatch');
  assert.deepEqual(r._holdReasons, [], 'no reason emitted → chip does not render');
});

test('autoSendBatches: cap exceeded + on + manual-source → still held (only batch reason is suppressed)', () => {
  // The whole point of the "only one reason" contract — auto-send never
  // unhides a job that is held for another reason. Manual-review is the
  // canonical example; routing-hold behaves the same way (below).
  const r = computeHoldForReview(
    { artwork_source: 'manual', artwork_files: [] },
    { batchThresholdCheck: checkOfAuto(100, 1200, true) },
  );
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_SOURCE],
    'manual-source still fires; only OVER_BATCH_THRESHOLD is suppressed');
});

test('autoSendBatches: cap exceeded + on + routing-hold → still held, only batch reason suppressed', () => {
  const r = computeHoldForReview(
    { artwork_source: 'pixfizz', artwork_files: [], process: 'Lab' },
    {
      routingHeldProcesses: new Set(['Lab']),
      batchThresholdCheck:  checkOfAuto(100, 1200, true),
    },
  );
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.ROUTING_HOLD]);
});

test('autoSendBatches: no cap set + on → no reason either way (resolver returned null contract holds)', () => {
  // When there is no cap the resolver returns null altogether — the module
  // never sees autoSendBatches, and the reason cannot fire. This test locks
  // that "on without a cap is a no-op" invariant so an operator ticking
  // the box without a maximum can't produce surprising behaviour.
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: () => null });
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('autoSendBatches: cap NOT exceeded + on → no reason (auto-send only bites over-cap)', () => {
  // Under-cap jobs never trip the reason regardless of the flag; check the
  // ordering is right (auto-send is a post-comparison suppression, not a
  // pre-comparison short-circuit that could hide arithmetic bugs).
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOfAuto(100, 50, true) });
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('autoSendBatches: prints equal to cap + on → not held (cap-inclusive contract unchanged)', () => {
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOfAuto(100, 100, true) });
  assert.equal(r._holdForReview, false);
});

test('autoSendBatches: absent from the resolver return → treated as false (backward compat)', () => {
  // Pre-M2 callers return { cap, prints } with no autoSendBatches field.
  // Must behave exactly like the old code: reason fires when over-cap.
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: () => ({ cap: 100, prints: 1200 }) });
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.OVER_BATCH_THRESHOLD]);
});

test('autoSendBatches: truthy non-boolean does NOT suppress — strict === true only', () => {
  // Defence-in-depth: the IPC boundary rejects non-booleans on save, but
  // the shared derivation must not depend on that guard. A stray string
  // (from a hand-edited config that round-tripped through legacy code)
  // must NOT silently disable the operator-review gate.
  for (const bad of ['true', 1, {}, [], 'yes']) {
    const r = computeHoldForReview(baseJob, {
      batchThresholdCheck: () => ({ cap: 100, prints: 1200, autoSendBatches: bad }),
    });
    assert.equal(r._holdForReview, true,
      `autoSendBatches: ${JSON.stringify(bad)} must NOT suppress the reason`);
    assert.deepEqual(r._holdReasons, [REASON.OVER_BATCH_THRESHOLD]);
  }
});

test('autoSendBatches: falsy non-boolean leaves the reason intact (defensive)', () => {
  // Same principle from the other side — the shared derivation should
  // only recognise strict `true` as opt-in. Anything else preserves M1
  // behaviour.
  for (const falsy of [null, undefined, 0, '', false]) {
    const r = computeHoldForReview(baseJob, {
      batchThresholdCheck: () => ({ cap: 100, prints: 1200, autoSendBatches: falsy }),
    });
    assert.equal(r._holdForReview, true, `falsy ${JSON.stringify(falsy)} → reason still fires`);
  }
});

// ── Fail-safe on unsizable (2026-08-15) ─────────────────────────────────────
//
// Bug fixed on this date: when a Darkroom Pro controller has a positive
// maxPrintsPerJob AND the manifest print-count cannot be read at dispatch
// time (parse error / permission race / EBUSY on SMB past the
// _awaitingManifest gate), the runAutoPrint resolver USED to return null.
// null in this module means "feature off entirely — do not raise the
// reason", so the job dispatched unheld while the Jobs-grid chip
// (which reads the stamped cache) still showed "Large job — review
// required" — badge and gate disagreed, and an unsized job made it
// past a cap the operator had explicitly configured.
//
// New contract: the resolver signals this scenario with
// `{ cap, prints: null, unsizable: true, autoSendBatches }`. The
// derivation HOLDS the job unconditionally on that flag —
// `autoSendBatches` does NOT bypass because we won't split-dispatch a
// job we can't size. The resolver logs a warn line at the same time so
// the operator has a traceable diagnostic; this module stays fs-free.

test('Fail-safe (user brief): cap set + count unavailable → held via OVER_BATCH_THRESHOLD', () => {
  const r = computeHoldForReview(baseJob, {
    batchThresholdCheck: () => ({ cap: 100, prints: null, unsizable: true }),
  });
  assert.equal(r._holdForReview, true, 'unsizable sentinel must HOLD the job');
  assert.deepEqual(r._holdReasons, [REASON.OVER_BATCH_THRESHOLD]);
});

test('Fail-safe (user brief): cap set + count available + under cap → NOT held (regression baseline)', () => {
  // Second of the three tests the user asked for explicitly. Not new
  // behaviour — just locks that the happy path is unchanged after the
  // fail-safe branch was added.
  const r = computeHoldForReview(baseJob, { batchThresholdCheck: checkOf(100, 50) });
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Fail-safe (user brief): cap set + over cap + autoSendBatches on → NOT held (M2 regression baseline)', () => {
  // Third of the three. Ensures the fail-safe branch didn't accidentally
  // catch the M2 "autoSendBatches suppresses over-cap" path.
  const r = computeHoldForReview(baseJob, {
    batchThresholdCheck: () => ({ cap: 100, prints: 1200, autoSendBatches: true }),
  });
  assert.equal(r._holdForReview, false);
});

test('Fail-safe: unsizable + autoSendBatches ON → STILL held (auto-send must not bypass a size-unknown job)', () => {
  // The critical invariant. autoSendBatches means "over-cap? split and
  // dispatch". If we don't KNOW whether the job is over-cap, we cannot
  // safely split-and-dispatch — the operator opted into unattended
  // over-cap handling, not into unsized dispatch. Fail-safe hold.
  const r = computeHoldForReview(baseJob, {
    batchThresholdCheck: () => ({ cap: 100, prints: null, unsizable: true, autoSendBatches: true }),
  });
  assert.equal(r._holdForReview, true,
    'autoSendBatches must NOT bypass the unsizable sentinel');
  assert.deepEqual(r._holdReasons, [REASON.OVER_BATCH_THRESHOLD]);
});

test('Fail-safe: unsizable stacks with manual-source (both reasons listed)', () => {
  const r = computeHoldForReview(
    { artwork_source: 'manual', artwork_files: [] },
    { batchThresholdCheck: () => ({ cap: 100, prints: null, unsizable: true }) },
  );
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_SOURCE, REASON.OVER_BATCH_THRESHOLD]);
});

test('Fail-safe: unsizable=true takes precedence even when prints happens to be a number', () => {
  // Defensive: a resolver that sets both `unsizable: true` AND a
  // sensible-looking `prints` (e.g. from a partial read) must still
  // hold — the flag is the caller's authoritative "don't trust the
  // count" signal. Prevents a subtle bug where a caller-side
  // half-measure (compute-then-flag) accidentally reverts to counting.
  const r = computeHoldForReview(baseJob, {
    batchThresholdCheck: () => ({ cap: 100, prints: 50, unsizable: true }),
  });
  assert.equal(r._holdForReview, true, 'unsizable must dominate an accompanying prints value');
  assert.deepEqual(r._holdReasons, [REASON.OVER_BATCH_THRESHOLD]);
});

test('Fail-safe: unsizable=false is NOT the sentinel — falls through to the normal branch', () => {
  // Strict `=== true`, same posture as autoSendBatches. Explicit false
  // means "we sized the job, use the prints field", not "we tried and
  // failed". Prevents a caller from accidentally opting jobs INTO the
  // fail-safe by passing `unsizable: someExpression()`.
  const r = computeHoldForReview(baseJob, {
    batchThresholdCheck: () => ({ cap: 100, prints: 50, unsizable: false }),
  });
  assert.equal(r._holdForReview, false, 'unsizable=false is a no-op — normal branch applies');
});

test('Fail-safe: unsizable=true with an INVALID cap → still NOT held (feature-off wins)', () => {
  // The cap gate is the outer condition — a route with no cap has the
  // feature off entirely, and the unsizable branch must not fire there.
  // Guards against a future refactor moving the flag check outside the
  // cap gate.
  for (const badCap of [0, -5, Number.NaN, null, undefined]) {
    const r = computeHoldForReview(baseJob, {
      batchThresholdCheck: () => ({ cap: badCap, prints: null, unsizable: true }),
    });
    assert.equal(r._holdForReview, false,
      `unsizable with badCap ${JSON.stringify(badCap)} must NOT hold — feature-off invariant`);
  }
});

// ── Order-merge-waiting (M5, 2026-08-14) ────────────────────────────────────
//
// Fires for a Fuji PIC Pro job that routes to a merge-enabled controller and
// has passed its per-job gates, but whose order-level group isn't ready yet
// (siblings still arriving, siblings still held, or the wait cap hasn't
// elapsed). The auto-print pre-pass stamps _orderMergeHeldSince on the job;
// the resolver here is a trivial "does this stamp exist?" — the module
// stays count-agnostic (M6 handles the "X of Y" tooltip in the renderer).
// Same shape as batchThresholdCheck: absent resolver, or one returning
// falsy, keeps the reason quiet (feature-off / non-merge controller).

test('Order-merge-waiting: resolver returns true → ORDER_MERGE_WAITING in _holdReasons', () => {
  const r = computeHoldForReview(baseJob, { orderMergeCheck: () => true });
  assert.equal(r._holdForReview, true);
  assert.deepEqual(r._holdReasons, [REASON.ORDER_MERGE_WAITING]);
});

test('Order-merge-waiting: resolver returns false → NOT held', () => {
  const r = computeHoldForReview(baseJob, { orderMergeCheck: () => false });
  assert.equal(r._holdForReview, false);
  assert.deepEqual(r._holdReasons, []);
});

test('Order-merge-waiting: omitting the resolver is backward-compatible', () => {
  const r = computeHoldForReview(baseJob, {});
  assert.equal(r._holdForReview, false);
});

test('Order-merge-waiting: stacks with manual-source', () => {
  const r = computeHoldForReview(
    { artwork_source: 'manual', artwork_files: [] },
    { orderMergeCheck: () => true },
  );
  assert.deepEqual(r._holdReasons, [REASON.MANUAL_SOURCE, REASON.ORDER_MERGE_WAITING]);
});

test('Order-merge-waiting: ORDER_MERGE_WAITING has operator-readable text in REASON_TEXT', () => {
  const t = REASON_TEXT[REASON.ORDER_MERGE_WAITING];
  assert.ok(typeof t === 'string' && t.length > 0);
  assert.ok(/waiting/i.test(t) && /order/i.test(t), 'tooltip should name the wait reason');
});

// ── deriveHoldChipLabel — short label for the Jobs-grid chip ────────────────
//
// Fix for a live bug: the pre-M3 renderer hard-coded "Manual — review
// required" for any _holdForReview. When M3 introduced OVER_BATCH_THRESHOLD
// a large Pixfizz order rendered as "Manual" in the Jobs grid, even though
// the hold reason was actually the batch cap. The chip label now derives
// from _holdReasons; the tooltip (formatHoldReasons) is unchanged.

test('deriveHoldChipLabel: manual-source only → "Manual — review required" (unchanged from pre-M3)', () => {
  assert.equal(deriveHoldChipLabel([REASON.MANUAL_SOURCE]), 'Manual — review required');
});

test('deriveHoldChipLabel: manual-file only → "Manual — review required"', () => {
  assert.equal(deriveHoldChipLabel([REASON.MANUAL_FILE]), 'Manual — review required');
});

test('deriveHoldChipLabel: both manual reasons → "Manual — review required" (still all-manual)', () => {
  assert.equal(deriveHoldChipLabel([REASON.MANUAL_SOURCE, REASON.MANUAL_FILE]), 'Manual — review required');
});

test('deriveHoldChipLabel: over-batch-threshold only → "Large job — review required" (the M3 fix)', () => {
  assert.equal(deriveHoldChipLabel([REASON.OVER_BATCH_THRESHOLD]), 'Large job — review required');
});

test('deriveHoldChipLabel: order-merge-waiting only → "Waiting for order" (M5)', () => {
  // M5 label: a merge-held job must NOT fall through to "Manual — review
  // required". M6 refines this in the renderer to "Waiting for order —
  // X of Y jobs" using sibling-count stamps on the job.
  assert.equal(deriveHoldChipLabel([REASON.ORDER_MERGE_WAITING]), 'Waiting for order');
});

test('deriveHoldChipLabel: order-merge-waiting stacked with any other reason → generic "Review required"', () => {
  assert.equal(
    deriveHoldChipLabel([REASON.MANUAL_SOURCE, REASON.ORDER_MERGE_WAITING]),
    'Review required',
  );
  assert.equal(
    deriveHoldChipLabel([REASON.ORDER_MERGE_WAITING, REASON.ROUTING_HOLD]),
    'Review required',
  );
});

test('deriveHoldChipLabel: routing-hold only → "Review required" (generic, not "Manual")', () => {
  // Also a pre-existing renderer bug — the pre-fix chip would have said
  // "Manual" for a routing-hold. The generic label is strictly better.
  assert.equal(deriveHoldChipLabel([REASON.ROUTING_HOLD]), 'Review required');
});

test('deriveHoldChipLabel: manual + batch → generic "Review required" (mixed set)', () => {
  assert.equal(
    deriveHoldChipLabel([REASON.MANUAL_SOURCE, REASON.OVER_BATCH_THRESHOLD]),
    'Review required',
  );
});

test('deriveHoldChipLabel: manual + routing → generic "Review required"', () => {
  assert.equal(
    deriveHoldChipLabel([REASON.MANUAL_SOURCE, REASON.ROUTING_HOLD]),
    'Review required',
  );
});

test('deriveHoldChipLabel: routing + batch → generic "Review required"', () => {
  assert.equal(
    deriveHoldChipLabel([REASON.ROUTING_HOLD, REASON.OVER_BATCH_THRESHOLD]),
    'Review required',
  );
});

test('deriveHoldChipLabel: all three reason categories → generic "Review required"', () => {
  assert.equal(
    deriveHoldChipLabel([REASON.MANUAL_SOURCE, REASON.ROUTING_HOLD, REASON.OVER_BATCH_THRESHOLD]),
    'Review required',
  );
});

test('deriveHoldChipLabel: empty / non-array → "Review required" (defensive)', () => {
  assert.equal(deriveHoldChipLabel([]),        'Review required');
  assert.equal(deriveHoldChipLabel(null),      'Review required');
  assert.equal(deriveHoldChipLabel(undefined), 'Review required');
  assert.equal(deriveHoldChipLabel('nope'),    'Review required');
});

test('deriveHoldChipLabel: unknown reason token → generic "Review required" (not "Manual")', () => {
  // Forward-compat: a future reason emitted by holdForReview but not yet
  // known here must NOT mislabel as manual. Fall through to generic.
  assert.equal(deriveHoldChipLabel(['some-future-reason']), 'Review required');
});
