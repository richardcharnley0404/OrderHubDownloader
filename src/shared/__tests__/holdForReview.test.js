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
