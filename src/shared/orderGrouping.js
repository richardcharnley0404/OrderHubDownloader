'use strict';

/**
 * src/shared/orderGrouping.js
 *
 * Pure order-group readiness evaluation for Fuji PIC Pro's optional
 * mergeOrderJobs setting. Kept Electron-free so both the auto-print
 * loop (main process) and the node:test suite can load it directly
 * (src/shared/__tests__/*.test.js is one of the five test globs in
 * package.json). Same shape as batchSplit.js and configHealth.js —
 * no fs, no requires beyond other src/shared modules.
 *
 * Contract from docs/order-level-submission-picpro-brief.md §M2:
 *
 *   evaluateOrderGroup({
 *     manifestJobIds,   // Array — every sibling job id in this order,
 *                       //         from the order manifest (includes
 *                       //         jobs on other controllers).
 *     localJobs,        // Array — the local job records the caller
 *                       //         has for these ids (from job-service).
 *                       //         Used to test "does the manifest id
 *                       //         have a local record yet".
 *     eligibility,      // Map|Object jobId → boolean. The CALLER decides
 *                       //         membership by only including jobs whose
 *                       //         route resolves to this controllerId
 *                       //         (this module does no routing). The
 *                       //         boolean is the per-job gate result
 *                       //         (awaiting-manifest, AI Quality,
 *                       //         computeHoldForReview).
 *     controllerId,     // string — sanity marker; carried on the return
 *                       //         so a caller can attribute the result.
 *                       //         Not used for routing decisions.
 *     heldSince,        // number — ms since epoch. The clock the cap
 *                       //         measures from. Caller stamps ISO on
 *                       //         the job and passes Date.parse() here.
 *     nowMs,            // number — ms since epoch (Date.now()).
 *     capMs,            // number — orderMergeWaitMinutes * 60 * 1000.
 *                       //         Caller resolves null / absent to the
 *                       //         30-minute default before calling.
 *   })
 *
 *   → { ready, reason, memberJobIds, missingJobIds }
 *
 * Reasons:
 *
 *   'all-ready'            every manifest id has a local record AND
 *                          every member is eligible. Dispatch as one.
 *   'cap-expired'          nowMs - heldSince >= capMs AND at least one
 *                          member is eligible. memberJobIds is the
 *                          eligible subset only; missingJobIds names
 *                          the stragglers. Never dispatches an empty
 *                          submission — cap-expired with zero eligible
 *                          members stays waiting-for-siblings.
 *   'waiting-for-siblings' anything else — either a manifest job has
 *                          no local record yet, or a member is held,
 *                          and the cap has not elapsed.
 *
 * Guardrails (fail closed):
 *   - Never throws. Any garbage input returns { ready:false, reason:
 *     'waiting-for-siblings', memberJobIds:[], missingJobIds:[] }.
 *   - is_film_development jobs are stripped from localJobs and from
 *     eligibility. The caller is supposed to filter them out first
 *     (they never route to a printer); the assertion here is
 *     belt-and-braces so a caller regression can't leak one in.
 *   - Deterministic returned ordering (lexicographic string sort on
 *     the id form) — the returned arrays are used in log lines,
 *     hold-chip counts and test assertions.
 *   - Ids are normalised to strings on output. The caller can pass
 *     numbers or strings interchangeably; the returned arrays are
 *     always strings so equality comparisons downstream are stable.
 */

/**
 * @typedef {Object} OrderGroupResult
 * @property {boolean} ready
 * @property {'all-ready'|'cap-expired'|'waiting-for-siblings'} reason
 * @property {Array<string>} memberJobIds   ids that dispatch together
 * @property {Array<string>} missingJobIds  ids blocking readiness
 */

const NOT_READY = Object.freeze({
  ready: false,
  reason: 'waiting-for-siblings',
  memberJobIds: [],
  missingJobIds: [],
});

function _asId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

function _isFilmDev(job) {
  return !!(job && job.is_film_development);
}

function _sortedUnique(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const id = _asId(raw);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort();
  return out;
}

/**
 * Evaluate whether an order-level group is ready to dispatch as one
 * PIC Pro submission. See module doc-comment for the full contract.
 *
 * @param {Object} input
 * @returns {OrderGroupResult}
 */
function evaluateOrderGroup(input) {
  if (!input || typeof input !== 'object') return { ...NOT_READY };

  const {
    manifestJobIds,
    localJobs,
    eligibility,
    controllerId,
    heldSince,
    nowMs,
    capMs,
  } = input;

  if (!Array.isArray(manifestJobIds)) return { ...NOT_READY };
  if (!Array.isArray(localJobs))      return { ...NOT_READY };
  if (typeof controllerId !== 'string' || controllerId.length === 0) {
    return { ...NOT_READY };
  }

  // Coerce eligibility to Map<string,boolean>. Accept a Map or a plain
  // object; anything else is treated as no-members-known, which by the
  // "never dispatch an empty submission" rule collapses to NOT_READY.
  const elig = new Map();
  if (eligibility instanceof Map) {
    for (const [k, v] of eligibility) {
      const id = _asId(k);
      if (id) elig.set(id, !!v);
    }
  } else if (eligibility && typeof eligibility === 'object') {
    for (const k of Object.keys(eligibility)) {
      const id = _asId(k);
      if (id) elig.set(id, !!eligibility[k]);
    }
  } else {
    return { ...NOT_READY };
  }

  // Lookup by id, film-dev stripped. Also strip film-dev from
  // eligibility — a caller regression that leaks one in must not be
  // able to make an order dispatch.
  const localById = new Map();
  for (const j of localJobs) {
    if (!j || _isFilmDev(j)) continue;
    const id = _asId(j.id);
    if (id) localById.set(id, j);
  }
  for (const id of Array.from(elig.keys())) {
    const job = localById.get(id);
    if (!job) elig.delete(id);
  }

  // Manifest ids that have no local record yet — the S3 job downloader
  // hasn't landed them, or the operator hasn't received them, or they
  // simply don't exist. Cannot know whether they belong to this
  // controller, so conservatively they block. Film-dev manifest ids
  // (rare, but possible if the manifest is malformed) are filtered
  // out on the caller side by convention; strip them here too against
  // any local job we do have that's film-dev.
  const missingFromLocal = [];
  for (const raw of manifestJobIds) {
    const id = _asId(raw);
    if (id === null) continue;
    const job = localById.get(id);
    if (!job) missingFromLocal.push(id);
  }

  const ineligibleMembers = [];
  const eligibleMembers = [];
  for (const [id, ok] of elig) {
    if (ok) eligibleMembers.push(id);
    else ineligibleMembers.push(id);
  }

  const missing = _sortedUnique([...missingFromLocal, ...ineligibleMembers]);
  const allMembers      = _sortedUnique([...elig.keys()]);
  const eligibleSorted  = _sortedUnique(eligibleMembers);

  // All-ready: every manifest id accounted for AND every member eligible.
  // Requires at least one member — an empty eligibility map means we
  // have nothing on this controller for this order, which is not
  // "ready to dispatch" but "nothing to do".
  if (
    missingFromLocal.length === 0 &&
    ineligibleMembers.length === 0 &&
    allMembers.length > 0
  ) {
    return {
      ready: true,
      reason: 'all-ready',
      memberJobIds: allMembers,
      missingJobIds: [],
    };
  }

  // Cap-expired: past the wait, and at least one eligible member to
  // send. Never dispatch an empty submission even at cap.
  const capValid =
    Number.isFinite(nowMs) &&
    Number.isFinite(heldSince) &&
    Number.isFinite(capMs) &&
    capMs > 0;
  const capExpired = capValid && (nowMs - heldSince) >= capMs;

  if (capExpired && eligibleSorted.length > 0) {
    return {
      ready: true,
      reason: 'cap-expired',
      memberJobIds: eligibleSorted,
      missingJobIds: missing,
    };
  }

  return {
    ready: false,
    reason: 'waiting-for-siblings',
    memberJobIds: [],
    missingJobIds: missing,
  };
}

module.exports = { evaluateOrderGroup };
