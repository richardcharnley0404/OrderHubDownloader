'use strict';

/**
 * src/shared/batchLedger.js
 *
 * The shared "which batches went out, which landed, which failed"
 * shape used by both controller families that split a job into
 * multiple hot-folder writes. Introduced in M2 of
 * docs/epson-batch-splitting-brief.md — generalises the pre-M2
 * Darkroom Pro `_darkroomProBatchLedger` into a single canonical
 * struct so the M4 completion roll-up + resend-one-batch flows have
 * one answer to consult regardless of controller type.
 *
 * ── Shape ─────────────────────────────────────────────────────────
 *
 *   {
 *     cap:          number,           // maxPrintsPerJob at dispatch time
 *     totalBatches: number,           // splitIntoBatches result count
 *     totalPrints:  number,           // sum of quantities before split
 *     startedAt:    ISO string,       // pass began
 *     completedAt:  ISO string|null,  // all batches reached terminal state
 *     batches:      [
 *       {
 *         index:          number,          // 1-based, matches folder marker `NofM`
 *         total:          number,          // duplicated per-entry for restart-safe reads
 *         filename:       string,          // e.g. 'PXTEST-1_2.txt' (DP) or 'o…_2of5_…' (DPOF)
 *         destPath:       string | null,   // hot-folder path; null when write failed
 *         dispatchedAt:   ISO string,      // when WE wrote the file / folder
 *         outcome:        'success' | 'error',
 *         error?:         string,          // present when outcome === 'error'
 *         acceptedAt:     ISO string|null, // DPOF only — when controller renamed to e/q
 *         acceptedPrefix: 'e' | 'q' | null // DPOF only — 'e' accepted, 'q' failed import
 *       },
 *       ...
 *     ]
 *   }
 *
 * DPOF fields (`acceptedAt`, `acceptedPrefix`) are ALWAYS present on
 * every batch entry — null for both when the controller hasn't (yet)
 * signalled. Darkroom Pro entries carry them as null-forever; keeping
 * the shape uniform means downstream readers don't need per-controller
 * branches. The two null keys per batch are negligible in storage.
 *
 * ── Field name migration ──────────────────────────────────────────
 *
 * Pre-M2 the ledger lived on the job at `_darkroomProBatchLedger`
 * (Darkroom Pro was the only writer). M2 renames the writer's target
 * to `_batchLedger` — the canonical field for both families. Old
 * persisted ledgers (a job dispatched pre-M2 that hasn't completed
 * before an upgrade) still live under the LEGACY_FIELD name.
 *
 * The migration is deliberately soft: `readLedger(job)` checks the
 * canonical field first, then falls back to the legacy field. New
 * writes always land at CANONICAL_FIELD. Old-field ledgers phase out
 * naturally as their jobs complete and age out of the cache; there is
 * no hard-migration step that could corrupt in-flight data.
 *
 * ── Pure functions ────────────────────────────────────────────────
 *
 * Every helper here is pure/mutating-locally-only — none of them
 * touches disk or the electron-store. Persistence is the caller's
 * job (jobService.updateJobLocally). Same posture as
 * src/shared/holdForReview.js and src/shared/batchSplit.js — the
 * caller owns state, the shared module owns shape.
 */

const CANONICAL_FIELD = '_batchLedger';
const LEGACY_FIELD    = '_darkroomProBatchLedger';

/**
 * Fresh ledger for a split-dispatch pass. Called ONCE at the start
 * of the dispatch loop.
 *
 * @param {{cap:number, totalBatches:number, totalPrints:number}} args
 * @returns {object} new ledger
 */
function newLedger({ cap, totalBatches, totalPrints }) {
  return {
    cap,
    totalBatches,
    totalPrints,
    startedAt:   new Date().toISOString(),
    completedAt: null,
    batches:     [],
  };
}

/**
 * Record a successful batch write. Mutates the ledger in place and
 * returns it (for chaining ergonomics; callers usually persist right
 * after via updateJobLocally).
 *
 * @param {object} ledger
 * @param {{index:number, total:number, filename:string, destPath:string}} args
 * @returns {object} the same ledger
 */
function recordBatchDispatched(ledger, { index, total, filename, destPath }) {
  ledger.batches.push({
    index,
    total,
    filename,
    destPath,
    dispatchedAt:   new Date().toISOString(),
    outcome:        'success',
    // DPOF signal starts unset — recordBatchAccepted stamps it when
    // the controller renames the folder to e or q. Darkroom Pro
    // writers never call recordBatchAccepted, so these stay null
    // forever on DP entries.
    acceptedAt:     null,
    acceptedPrefix: null,
  });
  return ledger;
}

/**
 * Record a failed batch write (the write threw). Mutates + returns.
 *
 * @param {object} ledger
 * @param {{index:number, total:number, filename:string, error:string}} args
 * @returns {object} the same ledger
 */
function recordBatchError(ledger, { index, total, filename, error }) {
  ledger.batches.push({
    index,
    total,
    filename,
    destPath:       null,
    dispatchedAt:   new Date().toISOString(),
    outcome:        'error',
    error,
    acceptedAt:     null,
    acceptedPrefix: null,
  });
  return ledger;
}

/**
 * Record the controller's accept/fail signal for a previously-
 * dispatched batch (DPOF only — Darkroom Pro has no accept signal).
 * Locates the batch by index; silent no-op if not found so a stray
 * or out-of-order signal doesn't throw. Mutates + returns.
 *
 * @param {object} ledger
 * @param {{index:number, prefix:'e'|'q', at?:string}} args
 * @returns {object} the same ledger
 */
function recordBatchAccepted(ledger, { index, prefix, at }) {
  const entry = (ledger.batches || []).find((b) => b && b.index === index);
  if (!entry) return ledger;
  entry.acceptedAt     = at || new Date().toISOString();
  entry.acceptedPrefix = prefix;
  return ledger;
}

/**
 * Stamp the ledger as complete. For Darkroom Pro this fires when all
 * batches wrote successfully. For DPOF (M4) this fires when every
 * batch reached its terminal state (all `e`, or one `q` after a
 * partial-failure decision). Semantically both mean "no further
 * per-batch state changes expected on this ledger."
 *
 * @param {object} ledger
 * @param {string} [at] - override for the ISO timestamp (defaults to now)
 * @returns {object} the same ledger
 */
function completeLedger(ledger, at) {
  ledger.completedAt = at || new Date().toISOString();
  return ledger;
}

/**
 * Read the ledger off a job, checking the canonical field first and
 * falling back to the legacy field for pre-M2 persisted jobs. Returns
 * null when neither is present (unsplit dispatch — no ledger written).
 *
 * The fallback is the ONLY reason the legacy field name matters in
 * post-M2 code. Every caller that needs the ledger goes through here;
 * no one should read job._darkroomProBatchLedger directly (that would
 * silently miss new-shape ledgers).
 *
 * @param {object|null|undefined} job
 * @returns {object|null}
 */
function readLedger(job) {
  if (!job || typeof job !== 'object') return null;
  return job[CANONICAL_FIELD] || job[LEGACY_FIELD] || null;
}

module.exports = {
  CANONICAL_FIELD,
  LEGACY_FIELD,
  newLedger,
  recordBatchDispatched,
  recordBatchError,
  recordBatchAccepted,
  completeLedger,
  readLedger,
};
