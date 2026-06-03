/**
 * Unit tests for src/main/jobs/customerOriginalsActions.js
 *
 * The shell + fs.access handles are injected so we can verify the
 * pre-shell existence check without touching the real OS.
 *
 * Coverage:
 *   - Happy path open  → access ok, shell.openPath returns ''     → { ok:true }
 *   - Happy path reveal→ access ok, shell.showItemInFolder fires  → { ok:true }
 *   - Missing file     → access throws ENOENT                     → { ok:false, error:'not-found' }
 *                        AND shell.openPath / showItemInFolder NEVER called
 *   - Missing jobPath  → { ok:false, error:'jobPath is required' }
 *   - Missing original → { ok:false, error:'originalFilename is required' }
 *   - shell.openPath returns a non-empty string (Electron's "could not open" signal)
 *                        → propagated as { ok:false, error:<that string> }
 *   - shell.openPath throws → caught, surfaced as { ok:false, error }
 *
 * Path resolution sanity-check: actions.openOriginal feeds the resolved
 * absolute path to access + shell. We capture the path access saw and
 * assert it equals `path.join(path.dirname(jobPath), originalFilename)`.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createCustomerOriginalsActions } = require('../customerOriginalsActions.js');

function makeShellStub() {
  const calls = { open: [], reveal: [] };
  return {
    calls,
    shell: {
      openPath: async (p) => { calls.open.push(p); return ''; }, // '' = success
      showItemInFolder: (p) => { calls.reveal.push(p); },
    },
  };
}
function makeAccessStub(behaviour) {
  // behaviour: 'ok' (resolves) | 'enoent' (rejects with ENOENT) | function
  const calls = [];
  const access = async (p) => {
    calls.push(p);
    if (behaviour === 'ok') return;
    if (behaviour === 'enoent') {
      const err = new Error('no such file');
      err.code = 'ENOENT';
      throw err;
    }
    if (typeof behaviour === 'function') return behaviour(p);
    throw new Error(`unexpected access behaviour: ${behaviour}`);
  };
  return { access, calls };
}
const SILENT_LOGGER = { logError: () => {} };

// =============================================================================
// Happy paths
// =============================================================================

test('openOriginal: file exists → shell.openPath called with absolute path; { ok:true }', async () => {
  const { shell, calls } = makeShellStub();
  const { access, calls: accessCalls } = makeAccessStub('ok');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });

  const jobPath = path.join('C:', 'OHD', 'PXDEMO-X', 'PXDEMO-X_42');
  const rel = 'PXDEMO-X_42/original-files/1-IMG.jpg';
  const result = await actions.openOriginal({ jobPath, originalFilename: rel });

  assert.deepEqual(result, { ok: true });
  // Access must have been called BEFORE shell.openPath with the resolved abs path.
  const expectedAbs = path.join(path.dirname(jobPath), rel);
  assert.deepEqual(accessCalls, [expectedAbs]);
  assert.deepEqual(calls.open,  [expectedAbs]);
  assert.deepEqual(calls.reveal, []);
});

test('revealOriginal: file exists → shell.showItemInFolder called with abs path; { ok:true }', async () => {
  const { shell, calls } = makeShellStub();
  const { access, calls: accessCalls } = makeAccessStub('ok');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });

  const jobPath = path.join('C:', 'OHD', 'PXDEMO-X', 'PXDEMO-X_42');
  const rel = 'PXDEMO-X_42/original-files/1-IMG.jpg';
  const result = await actions.revealOriginal({ jobPath, originalFilename: rel });

  assert.deepEqual(result, { ok: true });
  const expectedAbs = path.join(path.dirname(jobPath), rel);
  assert.deepEqual(accessCalls, [expectedAbs]);
  assert.deepEqual(calls.reveal, [expectedAbs]);
  assert.deepEqual(calls.open,   []);
});

// =============================================================================
// Existence pre-check
// =============================================================================

test('openOriginal: missing file → { ok:false, error:"not-found" } AND shell never called', async () => {
  const { shell, calls } = makeShellStub();
  const { access } = makeAccessStub('enoent');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });

  const result = await actions.openOriginal({
    jobPath: path.join('C:', 'jobs', 'order', 'job'),
    originalFilename: 'order/original-files/1-missing.jpg',
  });
  assert.deepEqual(result, { ok: false, error: 'not-found' });
  assert.equal(calls.open.length,   0, 'shell.openPath must NOT be called when file is missing');
  assert.equal(calls.reveal.length, 0);
});

test('revealOriginal: missing file → { ok:false, error:"not-found" } AND shell never called', async () => {
  const { shell, calls } = makeShellStub();
  const { access } = makeAccessStub('enoent');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });

  const result = await actions.revealOriginal({
    jobPath: path.join('C:', 'jobs', 'order', 'job'),
    originalFilename: 'order/original-files/1-missing.jpg',
  });
  assert.deepEqual(result, { ok: false, error: 'not-found' });
  assert.equal(calls.reveal.length, 0);
  assert.equal(calls.open.length,   0);
});

// =============================================================================
// Arg validation
// =============================================================================

test('openOriginal: missing jobPath → descriptive error', async () => {
  const { shell } = makeShellStub();
  const { access } = makeAccessStub('ok');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });

  for (const bad of [undefined, null, '', 0, {}]) {
    const r = await actions.openOriginal({ jobPath: bad, originalFilename: 'a.jpg' });
    assert.equal(r.ok, false);
    assert.match(r.error, /jobPath is required/);
  }
});

test('openOriginal: missing originalFilename → descriptive error', async () => {
  const { shell } = makeShellStub();
  const { access } = makeAccessStub('ok');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });

  for (const bad of [undefined, null, '', 0, {}]) {
    const r = await actions.openOriginal({ jobPath: 'C:\\j\\x\\y', originalFilename: bad });
    assert.equal(r.ok, false);
    assert.match(r.error, /originalFilename is required/);
  }
});

test('openOriginal / revealOriginal: empty payload also produces a descriptive error', async () => {
  const { shell } = makeShellStub();
  const { access } = makeAccessStub('ok');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });
  const r1 = await actions.openOriginal();
  const r2 = await actions.revealOriginal();
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
});

// =============================================================================
// shell error propagation
// =============================================================================

test('openOriginal: shell.openPath returns non-empty string → propagated as error', async () => {
  const shell = {
    openPath: async () => 'No application is registered for this file type',
    showItemInFolder: () => { throw new Error('unused'); },
  };
  const { access } = makeAccessStub('ok');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });
  const r = await actions.openOriginal({
    jobPath: 'C:\\j\\order\\job',
    originalFilename: 'order/original-files/1-IMG.jpg',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /No application is registered/);
});

test('openOriginal: shell.openPath throws → caught, returned as { ok:false }', async () => {
  const shell = {
    openPath: async () => { throw new Error('shell exploded'); },
    showItemInFolder: () => {},
  };
  const { access } = makeAccessStub('ok');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });
  const r = await actions.openOriginal({
    jobPath: 'C:\\j\\order\\job',
    originalFilename: 'order/original-files/1-IMG.jpg',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /shell exploded/);
});

test('revealOriginal: shell.showItemInFolder throws → caught, returned as { ok:false }', async () => {
  const shell = {
    openPath: async () => '',
    showItemInFolder: () => { throw new Error('explorer launch failed'); },
  };
  const { access } = makeAccessStub('ok');
  const actions = createCustomerOriginalsActions({ shell, access, logger: SILENT_LOGGER });
  const r = await actions.revealOriginal({
    jobPath: 'C:\\j\\order\\job',
    originalFilename: 'order/original-files/1-IMG.jpg',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /explorer launch failed/);
});

// =============================================================================
// Factory contract
// =============================================================================

test('createCustomerOriginalsActions: rejects malformed shell dependency', () => {
  assert.throws(() => createCustomerOriginalsActions({ shell: null }),
    /must expose openPath and showItemInFolder/);
  assert.throws(() => createCustomerOriginalsActions({ shell: { openPath: 'no' } }),
    /must expose openPath and showItemInFolder/);
  assert.throws(() => createCustomerOriginalsActions({ shell: { openPath: async () => '' } }),
    /must expose openPath and showItemInFolder/);
});
