'use strict';

/**
 * Unit tests for order-submission-seq.js.
 *
 * The class accepts an injected store + logger + clock + jobDateRange
 * fallback, so tests build fresh instances against an in-memory
 * Map-backed store — no need to mock electron / electron-store.
 *
 * Test plan (from docs/order-level-submission-picpro-brief.md §M3):
 *   1. First call is unsuffixed.
 *   2. Subsequent calls increment (`-2`, `-3`, …).
 *   3. Values survive a store reload — same store, new instance
 *      picks up where the last one left off.
 *   4. Two different orders don't interfere.
 *   5. Pruning drops entries older than jobDateRange, keeps recent ones.
 *
 * Plus, load-bearing guarantees not explicit in the brief but implied
 * by the "never reuse an id" and "no reset" guardrails:
 *   - peek() is read-only and returns null on unknown orders.
 *   - Missing / blank orderNumber throws (caller bug, not runtime).
 *   - Corrupt on-disk entry does not re-issue the unsuffixed id.
 *   - No reset method is exported.
 *   - Store corruption (entries is not an object) resets to empty
 *     without throwing.
 *   - Pruning fires ONLY on construction (not on every allocation).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { OrderSubmissionSeq, DEFAULT_JOB_DATE_RANGE_DAYS } = require('../order-submission-seq');

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

function makeCapturingLogger() {
  const infos    = [];
  const warnings = [];
  return {
    logger: {
      info:       (msg, meta) => infos.push({ msg, meta }),
      warn:       () => {},
      error:      () => {},
      logError:   () => {},
      logWarning: (msg, meta) => warnings.push({ msg, meta }),
    },
    infos,
    warnings,
  };
}

function makeSeq(opts = {}) {
  return new OrderSubmissionSeq({
    store:               opts.store  || makeFakeStore(opts.initial),
    logger:              opts.logger || SILENT_LOGGER,
    now:                 opts.now,
    getJobDateRangeDays: opts.getJobDateRangeDays || (() => DEFAULT_JOB_DATE_RANGE_DAYS),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Brief case 1 — first call unsuffixed ────────────────────────────────────

test('first nextSubmissionId call returns the order number verbatim', () => {
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('ORD-1234'), 'ORD-1234');
});

// ── Brief case 2 — subsequent calls increment ───────────────────────────────

test('subsequent calls produce -2, -3, -4 …', () => {
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('ORD-1234'), 'ORD-1234');
  assert.equal(seq.nextSubmissionId('ORD-1234'), 'ORD-1234-2');
  assert.equal(seq.nextSubmissionId('ORD-1234'), 'ORD-1234-3');
  assert.equal(seq.nextSubmissionId('ORD-1234'), 'ORD-1234-4');
});

// ── Brief case 3 — values survive a store reload ────────────────────────────

test('values survive a reload — a fresh instance backed by the same store keeps counting', () => {
  const store = makeFakeStore();
  const first = makeSeq({ store });
  first.nextSubmissionId('ORD-A');
  first.nextSubmissionId('ORD-A');   // seq now 2

  const second = makeSeq({ store });
  assert.equal(second.nextSubmissionId('ORD-A'), 'ORD-A-3',
    'restart must NOT reissue a used id — this is the load-bearing invariant (rm -rf hazard)');
});

test('a restart between the unsuffixed issue and the first suffixed one still bumps', () => {
  const store = makeFakeStore();
  const first = makeSeq({ store });
  assert.equal(first.nextSubmissionId('ORD-B'), 'ORD-B');

  const second = makeSeq({ store });
  assert.equal(second.nextSubmissionId('ORD-B'), 'ORD-B-2');
});

// ── Brief case 4 — two different orders don't interfere ────────────────────

test('two different order numbers do not interfere', () => {
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('ORD-1'), 'ORD-1');
  assert.equal(seq.nextSubmissionId('ORD-2'), 'ORD-2');
  assert.equal(seq.nextSubmissionId('ORD-1'), 'ORD-1-2');
  assert.equal(seq.nextSubmissionId('ORD-2'), 'ORD-2-2');
  assert.equal(seq.nextSubmissionId('ORD-3'), 'ORD-3',
    'a third order starts fresh, unaffected by the others');
});

// ── Brief case 5 — pruning drops old + keeps recent ────────────────────────

test('pruning horizon is max(jobDateRange, 90) — entries past 90 days are dropped, recent kept', () => {
  const NOW = Date.UTC(2026, 7, 15);   // 2026-08-15
  const daysAgo = (n) => new Date(NOW - (n * DAY_MS)).toISOString();

  const store = makeFakeStore({
    entries: {
      'ORD-ancient':  { lastSeq: 3, lastIssuedAt: daysAgo(120) },  // way past horizon
      'ORD-past':     { lastSeq: 2, lastIssuedAt: daysAgo(100) },  // past 90-day horizon
      'ORD-boundary': { lastSeq: 1, lastIssuedAt: daysAgo(89)  },  // just inside horizon
      'ORD-recent':   { lastSeq: 2, lastIssuedAt: daysAgo(10)  },  // inside
      'ORD-today':    { lastSeq: 1, lastIssuedAt: daysAgo(0)   },  // today
    },
  });

  const { logger, infos } = makeCapturingLogger();
  const seq = makeSeq({
    store,
    logger,
    now: () => NOW,
    getJobDateRangeDays: () => 30,   // default; horizon should still be max(30, 90) = 90
  });

  // Past-horizon entries dropped — their counters restart from 1 on next issue.
  assert.equal(seq.peek('ORD-ancient'), null);
  assert.equal(seq.peek('ORD-past'),    null);
  assert.equal(seq.nextSubmissionId('ORD-ancient'), 'ORD-ancient',
    'a truly-ancient order can reissue from the unsuffixed id — nothing on this host still names it');

  // Everything inside the 90-day horizon is preserved with its counter intact.
  assert.equal(seq.peek('ORD-boundary').lastSeq, 1);
  assert.equal(seq.peek('ORD-recent').lastSeq,   2);
  assert.equal(seq.nextSubmissionId('ORD-boundary'), 'ORD-boundary-2');
  assert.equal(seq.nextSubmissionId('ORD-recent'),   'ORD-recent-3');
  assert.equal(seq.nextSubmissionId('ORD-today'),    'ORD-today-2');

  // Prune count was logged with the effective horizon (not jobDateRange).
  const pruneLog = infos.find((entry) => /pruned old entries/.test(entry.msg));
  assert.ok(pruneLog, 'a load-time prune must log its count');
  assert.equal(pruneLog.meta.pruned, 2);
  assert.equal(pruneLog.meta.days,   90,
    'prune log records the horizon that was actually applied — max(jobDateRange, 90)');
});

test('an entry between jobDateRange (30) and the 90-day horizon SURVIVES pruning', () => {
  // The rationale for the 90-day floor: auto-print skips jobs past
  // jobDateRange, but manual Process does not. If we pruned at 30
  // days, an operator manually processing a 45-day-old job would get
  // the unsuffixed id back — and stageImages rm -rf's the folder
  // named after it. This test locks the guarantee in.
  const NOW = Date.UTC(2026, 7, 15);
  const daysAgo = (n) => new Date(NOW - (n * DAY_MS)).toISOString();

  const store = makeFakeStore({
    entries: {
      'ORD-45d': { lastSeq: 2, lastIssuedAt: daysAgo(45) },   // past jobDateRange, inside horizon
      'ORD-60d': { lastSeq: 3, lastIssuedAt: daysAgo(60) },
      'ORD-89d': { lastSeq: 1, lastIssuedAt: daysAgo(89) },   // last day inside horizon
    },
  });

  const seq = makeSeq({
    store,
    now: () => NOW,
    getJobDateRangeDays: () => 30,   // horizon is max(30, 90) = 90
  });

  assert.equal(seq.peek('ORD-45d').lastSeq, 2, 'a 45-day-old entry must survive — manual Process could re-touch it');
  assert.equal(seq.peek('ORD-60d').lastSeq, 3);
  assert.equal(seq.peek('ORD-89d').lastSeq, 1);
  assert.equal(seq.nextSubmissionId('ORD-45d'), 'ORD-45d-3',
    'a manual re-Process 45 days later increments past the on-disk counter, does not reissue');
});

test('a lab that widens jobDateRange past 90 gets that wider horizon respected', () => {
  const NOW = Date.UTC(2026, 7, 15);
  const daysAgo = (n) => new Date(NOW - (n * DAY_MS)).toISOString();

  const store = makeFakeStore({
    entries: {
      'ORD-100d': { lastSeq: 1, lastIssuedAt: daysAgo(100) },   // outside 90-day floor, inside 120-day setting
      'ORD-200d': { lastSeq: 1, lastIssuedAt: daysAgo(200) },   // outside both
    },
  });

  const { logger, infos } = makeCapturingLogger();
  const seq = makeSeq({
    store,
    logger,
    now: () => NOW,
    getJobDateRangeDays: () => 120,   // widened
  });

  // max(120, 90) = 120 — so 100 days survives, 200 does not.
  assert.equal(seq.peek('ORD-100d').lastSeq, 1);
  assert.equal(seq.peek('ORD-200d'), null);
  const pruneLog = infos.find((entry) => /pruned old entries/.test(entry.msg));
  assert.equal(pruneLog.meta.days, 120,
    'the wider setting wins over the 90-day floor');
});

test('pruning fires ONLY on construction — allocating does not re-prune', () => {
  const NOW = Date.UTC(2026, 7, 15);
  const daysAgo = (n) => new Date(NOW - (n * DAY_MS)).toISOString();

  // A recent entry the constructor keeps.
  const store = makeFakeStore({
    entries: { 'ORD-X': { lastSeq: 1, lastIssuedAt: daysAgo(5) } },
  });

  let nowCallCount = 0;
  const seq = makeSeq({
    store,
    now: () => { nowCallCount++; return NOW; },
    getJobDateRangeDays: () => 30,
  });
  // Constructor: prune loop (1 now-call) + issuing new entries (0 needed for load).
  // Allow small variance for the timestamp on load itself if any.
  const afterCtor = nowCallCount;

  seq.nextSubmissionId('ORD-X');   // seq 2
  // Allocating stamps lastIssuedAt (1 call) but must not re-scan the store.
  assert.ok(nowCallCount - afterCtor <= 2,
    `allocating should not iterate the entire store — now-calls after ctor were ${nowCallCount - afterCtor}`);
});

test('an entry with a missing / unparseable lastIssuedAt is pruned', () => {
  const store = makeFakeStore({
    entries: {
      'ORD-no-ts':      { lastSeq: 5 },                    // no timestamp at all
      'ORD-garbage-ts': { lastSeq: 5, lastIssuedAt: 'nope' },
    },
  });
  const seq = makeSeq({ store, now: () => Date.now() });
  assert.equal(seq.peek('ORD-no-ts'),      null);
  assert.equal(seq.peek('ORD-garbage-ts'), null);
});

// ── peek() is read-only ─────────────────────────────────────────────────────

test('peek() returns the current counter without mutating', () => {
  const seq = makeSeq();
  assert.equal(seq.peek('ORD-Q'), null);
  seq.nextSubmissionId('ORD-Q');
  const before = seq.peek('ORD-Q');
  assert.equal(before.lastSeq, 1);
  assert.equal(before.lastId,  'ORD-Q');

  seq.peek('ORD-Q');
  seq.peek('ORD-Q');
  const after = seq.peek('ORD-Q');
  assert.equal(after.lastSeq, 1, 'peek must not increment');
  assert.equal(seq.nextSubmissionId('ORD-Q'), 'ORD-Q-2',
    'subsequent nextSubmissionId still bumps from the real counter');
});

test('peek() reports the derived lastId including the suffix', () => {
  const seq = makeSeq();
  seq.nextSubmissionId('ORD-P');   // ORD-P
  seq.nextSubmissionId('ORD-P');   // ORD-P-2
  const snap = seq.peek('ORD-P');
  assert.equal(snap.lastSeq, 2);
  assert.equal(snap.lastId,  'ORD-P-2');
  assert.ok(snap.lastIssuedAt, 'lastIssuedAt is stamped');
});

test('peek() on an unknown / blank order returns null', () => {
  const seq = makeSeq();
  assert.equal(seq.peek('ORD-never'), null);
  assert.equal(seq.peek(''),          null);
  assert.equal(seq.peek(null),        null);
  assert.equal(seq.peek(undefined),   null);
});

// ── Validation — orderNumber must be a non-empty string ────────────────────

test('nextSubmissionId throws on missing or blank orderNumber', () => {
  const seq = makeSeq();
  for (const bad of ['', '   ', null, undefined, 42, {}, [], true]) {
    assert.throws(
      () => seq.nextSubmissionId(bad),
      /non-empty orderNumber/,
      `bad orderNumber ${JSON.stringify(bad)} must throw`,
    );
  }
});

// ── Corrupt on-disk entry — must not re-issue the unsuffixed id ────────────

test('a stored entry with a corrupt lastSeq bumps to at least -2 (never re-issues unsuffixed)', () => {
  for (const badSeq of ['3', -1, 0, 0.5, NaN, null, undefined, {}, 'foo']) {
    const store = makeFakeStore({
      entries: {
        'ORD-X': { lastSeq: badSeq, lastIssuedAt: new Date().toISOString() },
      },
    });
    const { logger, warnings } = makeCapturingLogger();
    const seq = makeSeq({ store, logger });

    // Never reissue the unsuffixed id when SOMETHING was previously stored —
    // the whole point of persistence is to prevent the rm -rf collision.
    const id = seq.nextSubmissionId('ORD-X');
    assert.notEqual(id, 'ORD-X',
      `corrupt lastSeq ${JSON.stringify(badSeq)} must not re-issue the unsuffixed id`);
    assert.equal(id, 'ORD-X-2',
      'conservative bump lands at -2, the safest non-colliding suffix');
    assert.ok(warnings.length >= 1, 'corruption must be logged, not silent');
  }
});

// ── Store corruption at the top level ──────────────────────────────────────

test('a stored `entries` that is not an object is treated as empty (no throw)', () => {
  for (const bad of [null, 'nope', 42, [1, 2, 3]]) {
    const store = makeFakeStore({ entries: bad });
    const seq = makeSeq({ store });
    // No throw. Counter starts fresh.
    assert.equal(seq.nextSubmissionId('ORD-A'), 'ORD-A');
  }
});

// ── Persistence write happens on every allocation ──────────────────────────

test('every nextSubmissionId call persists — a crash mid-batch does not lose the counter', () => {
  const store = makeFakeStore();
  const seq = makeSeq({ store });

  seq.nextSubmissionId('ORD-CR');    // 1
  const snapAfterFirst = store._data.get('entries');
  assert.equal(snapAfterFirst['ORD-CR'].lastSeq, 1);

  seq.nextSubmissionId('ORD-CR');    // 2
  const snapAfterSecond = store._data.get('entries');
  assert.equal(snapAfterSecond['ORD-CR'].lastSeq, 2,
    'each allocation writes through — mid-batch crash cannot lose the counter');
});

// ── Guardrail: no reset is exported ────────────────────────────────────────

test('the module exports no reset / clear affordance', () => {
  const mod = require('../order-submission-seq');
  assert.equal(mod.reset,     undefined);
  assert.equal(mod.clear,     undefined);
  assert.equal(mod.resetAll,  undefined);

  const seq = makeSeq();
  assert.equal(typeof seq.reset,     'undefined');
  assert.equal(typeof seq.clear,     'undefined');
  assert.equal(typeof seq.resetAll,  'undefined');
});

// ── Singleton getter is lazy ───────────────────────────────────────────────

test('requiring the module does not construct the singleton (electron-free load)', () => {
  // Contract mirror of server-capabilities.js: `require`-ing the module
  // must not call `new Store()`. If the singleton were eager, loading
  // this test file at all would have crashed on the electron.app access
  // inside electron-store. That we got here at all is the assertion.
  const mod = require('../order-submission-seq');
  assert.equal(typeof mod.OrderSubmissionSeq, 'function');
  // Deliberately NOT accessing `mod.orderSubmissionSeq` here — that
  // getter constructs on first access and would pull electron.
});

// ── displayBase — v1.13.0 (per-controller Strip Order Number Prefix) ───────
//
// The optional second arg lets a caller supply a display base for the
// returned id (typically the post-strip form). The counter is keyed
// on the base — i.e. on displayBase when supplied, else orderNumber —
// so uniqueness is enforced on the string that becomes the folder
// name. Two orders stripping to the same base SHARE the counter and
// get base, base-2, base-3, … in dispatch order. That is the load-
// bearing invariant against the stageImages rm -rf hazard: without
// it, two orders with the same stripped base would both try to
// stage into the same folder.

test('displayBase: first call returns displayBase verbatim (not the raw order number)', () => {
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('PXDEMO-1234', '1234'), '1234',
    'operator-facing id uses the stripped display base');
});

test('displayBase: subsequent calls append -N to the displayBase, not the order number', () => {
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('PXDEMO-1234', '1234'), '1234');
  assert.equal(seq.nextSubmissionId('PXDEMO-1234', '1234'), '1234-2');
  assert.equal(seq.nextSubmissionId('PXDEMO-1234', '1234'), '1234-3');
});

test('displayBase: two orders stripping to the same base SHARE the counter — never emit the same id twice', () => {
  // Load-bearing collision test. The returned id names the staging
  // folder, the .txt filename and the DIGIN folder. If two different
  // raw orders both stripped to base '1234' each got their own
  // counter, both would return '1234' as their first id — the second
  // stageImages call would rm -rf the first submission's staging
  // folder. This is exactly the collision the suffix scheme exists
  // to prevent, so the counter is keyed on the RETURNED id's base.
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('PXDEMO-1234',    '1234'), '1234',
    'first submission stripping to base "1234"');
  assert.equal(seq.nextSubmissionId('DIVPRINTS-1234', '1234'), '1234-2',
    'second submission stripping to the same base MUST get -2 — same folder name would rm -rf the first');
  assert.equal(seq.nextSubmissionId('PXDEMO-1234',    '1234'), '1234-3',
    'a third submission (either raw order) keeps incrementing the shared counter');
  assert.equal(seq.nextSubmissionId('DIVPRINTS-1234', '1234'), '1234-4');
});

test('displayBase: an order using a UNIQUE base has its own counter (isolation between distinct bases)', () => {
  // The counter is keyed on base, not on raw order number — so two
  // orders that strip to DIFFERENT bases don't interfere.
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('PXDEMO-1234',    '1234'), '1234');
  assert.equal(seq.nextSubmissionId('PXDEMO-9999',    '9999'), '9999',
    'different base → fresh counter');
  assert.equal(seq.nextSubmissionId('PXDEMO-1234',    '1234'), '1234-2',
    'first base still increments independently');
});

test('displayBase: absent / null / undefined → falls back to the raw order number (backward compat)', () => {
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('ORD-A', null),      'ORD-A');
  assert.equal(seq.nextSubmissionId('ORD-B', undefined), 'ORD-B');
  assert.equal(seq.nextSubmissionId('ORD-C'),            'ORD-C');
  // And these all increment normally on subsequent calls.
  assert.equal(seq.nextSubmissionId('ORD-A'), 'ORD-A-2');
});

test('displayBase: empty string / non-string → falls back to the raw order number (defence-in-depth)', () => {
  const seq = makeSeq();
  // The caller's stripPrefix guard is supposed to never return '',
  // but if it slips through, we must not emit an id like '' or '-2'
  // (which would name the folder ''/'./-2' — either a rename crash
  // or a security hole).
  assert.equal(seq.nextSubmissionId('ORD-EMPTY-BASE', ''),    'ORD-EMPTY-BASE');
  assert.equal(seq.nextSubmissionId('ORD-NUMBER-BASE', 1234), 'ORD-NUMBER-BASE');
  assert.equal(seq.nextSubmissionId('ORD-BOOL-BASE', true),   'ORD-BOOL-BASE');
});

test('displayBase: counter survives reload (same base across restarts increments correctly)', () => {
  // Restart between two submissions of the same order — the shared
  // counter (keyed on base) is loaded from the store on the second
  // instance's construction, so subsequent id is base-2.
  const store = makeFakeStore();
  const first = makeSeq({ store });
  assert.equal(first.nextSubmissionId('PXDEMO-1234', '1234'), '1234');

  const second = makeSeq({ store });
  assert.equal(second.nextSubmissionId('PXDEMO-1234', '1234'), '1234-2',
    'counter under base "1234" persisted across the restart');
});

test('displayBase: changing the prefix mid-lifecycle creates a fresh id under the NEW base — no collision', () => {
  // Operator submits raw order 'PXDEMO-1234' with no prefix first
  // (base = raw order number). Then sets prefix 'PXDEMO-' and
  // resubmits the SAME raw order. The new base is '1234' — a
  // different counter key, so the id is '1234' (fresh), NOT '1234-2'.
  // No collision because the folder names are different
  // ('PXDEMO-1234' vs '1234').
  //
  // This is the deliberate consequence of keying on base: the counter
  // enforces uniqueness on the returned string, not on the raw order.
  // Changing the prefix creates a distinct namespace.
  const seq = makeSeq();
  assert.equal(seq.nextSubmissionId('PXDEMO-1234', 'PXDEMO-1234'), 'PXDEMO-1234',
    'first submission with no prefix — base equals raw order number');
  assert.equal(seq.nextSubmissionId('PXDEMO-1234', '1234'), '1234',
    'second submission with prefix now set — different base, fresh counter, distinct folder name');
});
