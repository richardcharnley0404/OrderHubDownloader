'use strict';

/**
 * Unit tests for src/main/services/film-scan-auto-assign.js.
 *
 * Two layers of coverage:
 *   1. Normaliser table — digit-only comparison for twin-check IDs vs
 *      folder names (locked in the brief: strip trailing _N, strip
 *      non-digits, strip leading zeros).
 *   2. runMatchCycle behaviour — driven by stubbed dependencies:
 *        - job-service       (getFilmDevelopmentJobs + fetchJobs)
 *        - frame-metadata-store (listRollsWithSummary + updateRoll)
 *        - folder-watch-service (_uploadRollFromStorage +
 *          _emitFilmReviewRoll)
 *      Real module logic runs against fake state — no disk, no network.
 *
 * The two-gate model is asserted here at the matcher edge:
 *   - reviewPassed:true  → match + upload fired.
 *   - reviewPassed:false → match stamped; upload NOT fired
 *     (Gate A still open — approve-roll completes the pair in M5).
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const Module  = require('node:module');

const SVC = path.resolve(__dirname, '..');
const __originalRequire = Module.prototype.require;

// ── Stub setup ───────────────────────────────────────────────────────────────

function stubInCache(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// electron-store stub so frame-metadata-store's constructor doesn't blow up
// on module load. Backed by a plain object; every method the tests use
// (list/update/read) is provided by our stub below, so the store's own
// internal state isn't exercised.
const FakeStore = function () {
  const data = {};
  return {
    get:    (k, d) => (k in data ? data[k] : d),
    set:    (k, v) => { data[k] = v; },
    delete: (k)    => { delete data[k]; },
    store:  data,
  };
};
Module.prototype.require = function (req) {
  if (req === 'electron')       return { app: { getPath: () => require('os').tmpdir() } };
  if (req === 'electron-store') return FakeStore;
  return __originalRequire.apply(this, arguments);
};

// config-service is required at module load — stub it before loading the SUT.
let __cfg = {};
stubInCache(path.join(SVC, 'config-service.js'), {
  get: (k) => __cfg[k],
  getAll: () => ({ ...__cfg }),
});

// logger stub captures per-level lines so the tests can assert operator-
// readable emissions.
const __logs = { info: [], warn: [], error: [] };
const stubLogger = {
  info:       (m) => __logs.info.push(String(m)),
  warn:       (m) => __logs.warn.push(String(m)),
  error:      (m) => __logs.error.push(String(m)),
  logInfo:    (m) => __logs.info.push(String(m)),
  logWarning: (m) => __logs.warn.push(String(m)),
  logError:   (m) => __logs.error.push(String(m)),
};
stubInCache(path.join(SVC, 'logger.js'), stubLogger);

// frame-metadata-store stub. Backing state is a Map for rolls; the matcher
// only uses listRollsWithSummary + updateRoll. Kept minimal on purpose.
let __rolls = new Map();  // rollId → record
let __rollUpdateCalls = [];  // captured update calls
stubInCache(path.join(SVC, 'frame-metadata-store.js'), {
  listRollsWithSummary() {
    return Array.from(__rolls.values());
  },
  updateRoll(rollId, patch) {
    __rollUpdateCalls.push({ rollId, patch });
    const cur = __rolls.get(rollId) || { rollId };
    __rolls.set(rollId, { ...cur, ...patch });
  },
  getRoll(rollId) { return __rolls.get(rollId) || null; },
});

// job-service stub — matcher calls getFilmDevelopmentJobs + optionally fetchJobs.
let __filmDevJobs = [];
let __fetchJobsCalls = 0;
let __fetchJobsShouldThrow = null;
stubInCache(path.join(SVC, 'job-service.js'), {
  getFilmDevelopmentJobs() { return __filmDevJobs; },
  async fetchJobs() {
    __fetchJobsCalls += 1;
    if (__fetchJobsShouldThrow) throw __fetchJobsShouldThrow;
    return __filmDevJobs;
  },
});

// folder-watch-service stub — captures which rollIds get handed to the
// upload path and lets the test control whether it succeeds or throws.
let __uploadCalls = [];
let __uploadShouldThrow = null;
stubInCache(path.join(SVC, 'folder-watch-service.js'), {
  async _uploadRollFromStorage(rollId, config) {
    __uploadCalls.push({ rollId, config });
    if (__uploadShouldThrow) throw __uploadShouldThrow;
    // Simulate the real upload path stamping the roll uploaded.
    const cur = __rolls.get(rollId) || { rollId };
    __rolls.set(rollId, { ...cur, uploadStatus: 'uploaded' });
  },
  _emitFilmReviewRoll() { /* no-op in tests */ },
});

const filmScanAutoAssign = require(path.join(SVC, 'film-scan-auto-assign.js'));

// ── Per-test state helpers ───────────────────────────────────────────────────

function resetState() {
  __cfg = {};
  __rolls = new Map();
  __rollUpdateCalls = [];
  __filmDevJobs = [];
  __fetchJobsCalls = 0;
  __fetchJobsShouldThrow = null;
  __uploadCalls = [];
  __uploadShouldThrow = null;
  __logs.info.length = 0;
  __logs.warn.length = 0;
  __logs.error.length = 0;
}

function seedHeldRoll(rollId, overrides = {}) {
  __rolls.set(rollId, {
    rollId,
    uploadStatus:       'pending',
    awaitingAssignment: true,
    reviewPassed:       true,
    storagePath:        `/tmp/${rollId}`,
    ...overrides,
  });
}

function seedJob(overrides) {
  __filmDevJobs.push({
    id: 'JOB-1',
    order_number: 'PXDEMO-WT6L0M',
    order_id: 'ORD-1',
    job_name: 'PXDEMO-WT6L0M-1',
    is_film_development: true,
    twin_checks: [],
    ...overrides,
  });
}

// ── Normaliser table ─────────────────────────────────────────────────────────

test('_normalise: bare digit strings preserved (leading zeros stripped)', () => {
  assert.equal(filmScanAutoAssign._normalise('1847'),      '1847');
  assert.equal(filmScanAutoAssign._normalise('00001847'),  '1847');
  assert.equal(filmScanAutoAssign._normalise('0001'),      '1');
});

test('_normalise: trailing _N suffix stripped (rescan disambiguation)', () => {
  assert.equal(filmScanAutoAssign._normalise('00001847_1'), '1847');
  assert.equal(filmScanAutoAssign._normalise('1847_23'),    '1847');
});

test('_normalise: symmetry — folder-name form matches twin-check form', () => {
  assert.equal(
    filmScanAutoAssign._normalise('00001847_1'),
    filmScanAutoAssign._normalise('1847'),
  );
});

test('_normalise: non-digits stripped mid-string (dashes / spaces)', () => {
  // NB: an underscore + trailing digits is treated as a rescan suffix per
  // the brief, so 'ROLL_1847' → '' (not '1847'). Real folder-name inputs
  // are the twin-check itself (possibly zero-padded, possibly with an
  // _N rescan suffix); mid-underscore inputs aren't a realistic case.
  assert.equal(filmScanAutoAssign._normalise('twin-1847'), '1847');
  assert.equal(filmScanAutoAssign._normalise(' 1847 '),    '1847');
});

test('_normalise: prefix + rescan suffix — "PAD00001847_1" → "1847"', () => {
  // Realistic composite: alphanumeric prefix + zero-padded twin check +
  // rescan suffix. Only the trailing _N is peeled; remaining non-digits
  // are stripped; leading zeros go last.
  assert.equal(filmScanAutoAssign._normalise('PAD00001847_1'), '1847');
});

test('_normalise: empty / no-digit → "" (must never match empty against empty)', () => {
  assert.equal(filmScanAutoAssign._normalise(''),       '');
  assert.equal(filmScanAutoAssign._normalise(null),     '');
  assert.equal(filmScanAutoAssign._normalise(undefined),'');
  assert.equal(filmScanAutoAssign._normalise('abc_de'), '');
});

test('_normalise: numeric input accepted', () => {
  assert.equal(filmScanAutoAssign._normalise(1847), '1847');
});

// ── runMatchCycle: feature-off ───────────────────────────────────────────────

test('runMatchCycle: feature off → skipped, no store reads, no fetch', async () => {
  resetState();
  seedHeldRoll('1847');
  seedJob({ twin_checks: ['1847'] });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: false,
  }, stubLogger);

  assert.equal(result.skipped, true);
  assert.equal(__rollUpdateCalls.length, 0);
  assert.equal(__uploadCalls.length, 0);
  assert.equal(__fetchJobsCalls, 0);
});

// ── runMatchCycle: no held rolls / no jobs ───────────────────────────────────

test('runMatchCycle: no held rolls → returns held:0, no upload attempted', async () => {
  resetState();
  seedJob({ twin_checks: ['1847'] });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.held, 0);
  assert.equal(result.matched, 0);
  assert.equal(__uploadCalls.length, 0);
});

test('runMatchCycle: held rolls but no film-dev jobs → matched:0, no upload', async () => {
  resetState();
  seedHeldRoll('1847');

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.held, 1);
  assert.equal(result.matched, 0);
  assert.equal(__uploadCalls.length, 0);
});

// ── runMatchCycle: match happy paths ─────────────────────────────────────────

test('runMatchCycle: normalisation match — folder "00001847_1", twin "1847" → both gates → upload', async () => {
  resetState();
  seedHeldRoll('00001847_1', { reviewPassed: true });
  seedJob({
    id: 'JOB-PXDEMO-1', job_name: 'PXDEMO-WT6L0M-1', order_id: 'ORD-DEMO',
    order_number: 'PXDEMO-WT6L0M', twin_checks: ['1847'],
  });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.matched, 1);
  assert.equal(result.uploaded, 1);
  assert.equal(__uploadCalls.length, 1);
  assert.equal(__uploadCalls[0].rollId, '00001847_1');

  // Match metadata stamped on the roll before upload.
  const stamp = __rollUpdateCalls.find(c => c.patch.matchedJobId);
  assert.ok(stamp, 'match metadata write happened');
  assert.equal(stamp.patch.matchedJobId,       'JOB-PXDEMO-1');
  assert.equal(stamp.patch.matchedJobNumber,   'PXDEMO-WT6L0M-1');
  assert.equal(stamp.patch.matchedOrderId,     'ORD-DEMO');
  assert.equal(stamp.patch.matchedOrderNumber, 'PXDEMO-WT6L0M');
  assert.equal(stamp.patch.matchedTwinCheck,   '1847');
  assert.ok(stamp.patch.matchedAt);

  // awaitingAssignment cleared before upload fires.
  const clear = __rollUpdateCalls.find(c => c.patch.awaitingAssignment === false);
  assert.ok(clear, 'awaitingAssignment cleared before upload');
});

test('runMatchCycle: two-gate — match arrives before approval → stamped but NOT uploaded', async () => {
  resetState();
  seedHeldRoll('1847', { reviewPassed: false });  // Gate A still open
  seedJob({ id: 'JOB-A', twin_checks: ['1847'] });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.matched, 1);
  assert.equal(result.uploaded, 0, 'upload waits for Gate A (approval)');
  assert.equal(__uploadCalls.length, 0);

  const stamp = __rollUpdateCalls.find(c => c.patch.matchedJobId);
  assert.ok(stamp, 'match metadata still stamped so approve-roll can find it');
  assert.equal(stamp.patch.matchedJobId, 'JOB-A');
});

test('runMatchCycle: two-gate — approval flips reviewPassed, subsequent match cycle uploads', async () => {
  // Simulates the "approval-before-match" ordering: operator approves a
  // roll BEFORE its film-dev job has arrived from OrderHub. The
  // approve-roll IPC would stamp reviewPassed:true and then invoke the
  // matcher; when the job later arrives, the next match cycle finds
  // both gates open and uploads.
  resetState();
  seedHeldRoll('1847', { reviewPassed: false });
  // No matching job yet — first cycle is a no-op.
  let result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);
  assert.equal(result.matched, 0);
  assert.equal(result.uploaded, 0);

  // Simulate approve-roll: flip Gate A on the roll record.
  __rolls.set('1847', { ...__rolls.get('1847'), reviewPassed: true });

  // Job arrives; matcher fires. Now Gate B fills in AND Gate A is
  // already true → both gates → upload.
  seedJob({ id: 'JOB-A', twin_checks: ['1847'] });
  result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);
  assert.equal(result.matched, 1);
  assert.equal(result.uploaded, 1);
  assert.equal(__uploadCalls.length, 1);
});

test('runMatchCycle: match then approval flips gate → next cycle uploads (both orderings end uploaded exactly once)', async () => {
  // Same end state as the previous test but reached through the
  // opposite ordering: match arrives first, THEN approval. Locks in
  // that only one upload fires no matter which gate flipped first.
  resetState();
  seedHeldRoll('1847', { reviewPassed: false });
  seedJob({ id: 'JOB-A', twin_checks: ['1847'] });

  // Cycle 1: matches but Gate A is open → no upload, roll stays held.
  let result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);
  assert.equal(result.matched, 1);
  assert.equal(result.uploaded, 0);
  assert.equal(__uploadCalls.length, 0);

  // Simulate approve-roll flipping Gate A. Real approve-roll would then
  // invoke the matcher immediately; we mirror that with a second cycle.
  __rolls.set('1847', { ...__rolls.get('1847'), reviewPassed: true });
  result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  // The second cycle re-matches the same twin (matchedJobId being
  // pre-set doesn't stop the match — it's the awaitingAssignment flag
  // that guards re-upload; that flag gets cleared before the first
  // upload fires). So we expect exactly one upload total.
  assert.equal(__uploadCalls.length, 1, 'exactly one upload total');

  // And a third cycle after the upload finishes finds the roll no
  // longer in the held set (awaitingAssignment:false), so it doesn't
  // re-match or re-upload.
  __rolls.set('1847', { ...__rolls.get('1847'), awaitingAssignment: false, uploadStatus: 'uploaded' });
  result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);
  assert.equal(result.held, 0, 'roll left the held set after upload');
  assert.equal(__uploadCalls.length, 1, 'still exactly one upload');
});

test('runMatchCycle: two rolls sharing one twin → only first fires (twin consumed)', async () => {
  resetState();
  seedHeldRoll('1847');
  seedHeldRoll('1847_1');  // normalises to "1847" too (rescan)
  seedJob({ id: 'JOB-X', twin_checks: ['1847'] });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.matched, 1, 'only one roll consumes the shared twin per cycle');
  assert.equal(__uploadCalls.length, 1);
});

test('runMatchCycle: two twins on one job → first matching roll uploads (rest follow on later cycles)', async () => {
  resetState();
  seedHeldRoll('1847');
  seedHeldRoll('2053');
  seedJob({ id: 'JOB-MULTI', twin_checks: ['1847', '2053'] });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.matched, 2, 'both rolls matched by the same job');
  assert.equal(result.uploaded, 2, 'both uploads fire on the same cycle');
  const rollsUploaded = __uploadCalls.map(c => c.rollId).sort();
  assert.deepEqual(rollsUploaded, ['1847', '2053']);
});

test('runMatchCycle: two jobs share one normalised twin → roll skipped, ambiguity warned, no upload', async () => {
  // Two distinct LIVE film-dev jobs both expose a twin that normalises
  // to "1847". The matcher must NOT guess — the roll is left held for
  // manual resolution and the operator sees a clear warning naming both
  // jobs.
  resetState();
  seedHeldRoll('1847');
  seedJob({ id: 'JOB-A', job_name: 'PXDEMO-AAA-1', twin_checks: ['1847'] });
  seedJob({ id: 'JOB-B', job_name: 'PXDEMO-BBB-1', twin_checks: ['00001847'] });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.matched, 0, 'ambiguous twin blocks assignment');
  assert.equal(result.uploaded, 0);
  assert.equal(__uploadCalls.length, 0);
  assert.equal(__rollUpdateCalls.length, 0, 'no metadata written for ambiguous match');
  assert.ok(
    __logs.warn.some(l => /ambiguous twin match: code 1847 on jobs JOB-A,JOB-B/.test(l)),
    'operator sees ambiguity warning naming both jobs'
  );
  // Roll remains held so the operator can resolve manually.
  const roll = __rolls.get('1847');
  assert.equal(roll.uploadStatus, 'pending');
  assert.equal(roll.awaitingAssignment, true);
});

test('runMatchCycle: single-match roll still fires when a *different* twin is ambiguous', async () => {
  // Ambiguity on one code must not poison unrelated matches in the same
  // cycle — the "2053" roll should still upload cleanly.
  resetState();
  seedHeldRoll('1847');
  seedHeldRoll('2053');
  seedJob({ id: 'JOB-A', twin_checks: ['1847'] });
  seedJob({ id: 'JOB-B', twin_checks: ['00001847'] });
  seedJob({ id: 'JOB-C', twin_checks: ['2053'] });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.matched, 1, 'only the unambiguous roll matches');
  assert.equal(result.uploaded, 1);
  assert.equal(__uploadCalls.length, 1);
  assert.equal(__uploadCalls[0].rollId, '2053');
  assert.ok(
    __logs.warn.some(l => /ambiguous twin match: code 1847/.test(l)),
    'ambiguity on 1847 still logged'
  );
});

test('runMatchCycle: no matching twin → matched:0, no updates, no upload', async () => {
  resetState();
  seedHeldRoll('9999');
  seedJob({ id: 'JOB-1', twin_checks: ['1847'] });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.matched, 0);
  assert.equal(__uploadCalls.length, 0);
  assert.equal(__rollUpdateCalls.length, 0);
});

// ── runMatchCycle: robustness ────────────────────────────────────────────────

test('runMatchCycle: upload throws → cycle continues, roll left in a diagnosable state', async () => {
  resetState();
  seedHeldRoll('1847');
  seedJob({ id: 'JOB-1', twin_checks: ['1847'] });
  __uploadShouldThrow = new Error('S3 credentials missing');

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  assert.equal(result.matched, 1);
  assert.equal(result.uploaded, 0);
  assert.equal(__uploadCalls.length, 1);
  assert.ok(__logs.error.some(l => /upload failed for 1847/.test(l)),
    'operator sees the upload failure in the log');
});

test('runMatchCycle: matcher never throws to the caller (belt-and-braces)', async () => {
  resetState();
  // Force a wild internal error by seeding a non-array twin_checks — the
  // real _mapApiJob coerces this to [], but the matcher must still be
  // resilient at the API boundary.
  seedHeldRoll('1847');
  seedJob({ id: 'JOB-1', twin_checks: null });

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
  }, stubLogger);

  // Should not throw. The match doesn't fire (twin_checks null → skipped).
  assert.equal(result.matched, 0);
});

// ── runMatchCycle: polling-off direct fetch ──────────────────────────────────

test('runMatchCycle: polling off + auto-assign on + API key → fetchJobs called directly', async () => {
  resetState();
  seedHeldRoll('1847');
  seedJob({ id: 'JOB-1', twin_checks: ['1847'] });

  await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
    pollingEnabled: false,
    orderhubApiKey: 'apiKey_test',
  }, stubLogger);

  assert.equal(__fetchJobsCalls, 1, 'direct fetchJobs to feed the matcher');
});

test('runMatchCycle: polling on → no direct fetchJobs (poll loop drives it)', async () => {
  resetState();
  seedHeldRoll('1847');
  seedJob({ id: 'JOB-1', twin_checks: ['1847'] });

  await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
    pollingEnabled: true,
    orderhubApiKey: 'apiKey_test',
  }, stubLogger);

  assert.equal(__fetchJobsCalls, 0, 'polling-service.pollJobs already fetches');
});

test('runMatchCycle: polling off + no API key → no fetch (nothing to talk to)', async () => {
  resetState();
  seedHeldRoll('1847');

  await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
    pollingEnabled: false,
    orderhubApiKey: '',
  }, stubLogger);

  assert.equal(__fetchJobsCalls, 0);
});

test('runMatchCycle: direct fetchJobs throws → cycle still runs against last-known jobs', async () => {
  resetState();
  seedHeldRoll('1847');
  seedJob({ id: 'JOB-1', twin_checks: ['1847'] });
  __fetchJobsShouldThrow = new Error('network down');

  const result = await filmScanAutoAssign.runMatchCycle({
    filmScanAutoAssignEnabled: true,
    pollingEnabled: false,
    orderhubApiKey: 'apiKey_test',
  }, stubLogger);

  assert.equal(__fetchJobsCalls, 1, 'attempted');
  assert.equal(result.matched, 1, 'still matched against the pre-seeded cache');
  assert.ok(__logs.warn.some(l => /auto-assign fetchJobs failed/.test(l)),
    'operator warned about the network failure');
});
