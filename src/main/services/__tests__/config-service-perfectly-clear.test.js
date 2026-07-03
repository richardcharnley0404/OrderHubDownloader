'use strict';

/**
 * Unit tests for the Perfectly Clear QuickServer config M1 contract.
 *
 * Covers:
 *   - _sanitisePerfectlyClear canonicalises shape (missing scopes / arrays /
 *     autoApplyConfigId that doesn't match any config id).
 *   - _validatePerfectlyClear enforces the four M1 rules:
 *       1. enabled scope requires ≥1 config
 *       2. every config needs friendlyName + all three folders
 *       3. inputFolder unique across ALL scopes' configs
 *       4. output/rejected must NOT be path-prefixed by ANY inputFolder
 *       5. all three folders must exist on disk (injectable existsSync)
 *
 * Run via:  npm test
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const Module  = require('node:module');
const os      = require('node:os');

// electron-store constructor runs at config-service module load. Stub it out
// so the tests don't touch the real config.json.
const __originalRequire = Module.prototype.require;
Module.prototype.require = function (req) {
  if (req === 'electron-store') {
    return function FakeStore() {
      const data = {};
      return {
        get:    (k, d) => (k in data ? data[k] : d),
        set:    (k, v) => { data[k] = v; },
        delete: (k)    => { delete data[k]; },
        get store() { return { ...data }; },
      };
    };
  }
  return __originalRequire.apply(this, arguments);
};

const configService = require('../config-service.js');
const { _sanitisePerfectlyClear, _validatePerfectlyClear } = configService;

// Test-injectable existsSync — passes for every path so shape tests don't
// need a real filesystem. The one filesystem test below builds its own.
const existsAlways = () => true;
const existsNever  = () => false;

function makeConfig(overrides = {}) {
  return {
    id:             'cfg-1',
    friendlyName:   'Phone Enhancement',
    inputFolder:    'C:\\qs\\input1',
    outputFolder:   'C:\\qs\\output1',
    rejectedFolder: 'C:\\qs\\rejected1',
    ...overrides,
  };
}

// ── _sanitisePerfectlyClear ──────────────────────────────────────────────────

test('sanitise: undefined input → three empty scopes with the canonical shape', () => {
  const out = _sanitisePerfectlyClear(undefined);
  assert.deepEqual(Object.keys(out).sort(), ['fileUploads', 'filmScans', 'jobs']);
  for (const scope of ['jobs', 'filmScans', 'fileUploads']) {
    assert.equal(out[scope].enabled, false);
    assert.equal(out[scope].autoApplyConfigId, null);
    assert.deepEqual(out[scope].configs, []);
  }
});

test('sanitise: partial input (missing filmScans) is filled with the default scope', () => {
  const out = _sanitisePerfectlyClear({
    jobs: { enabled: true, autoApplyConfigId: null, configs: [makeConfig()] },
  });
  assert.equal(out.jobs.enabled, true);
  assert.equal(out.filmScans.enabled, false);
  assert.deepEqual(out.filmScans.configs, []);
});

test('sanitise: trims folder + name strings; coerces booleans', () => {
  const out = _sanitisePerfectlyClear({
    jobs: {
      enabled: 1,
      configs: [{
        id: 'x',
        friendlyName:   '  Phone  ',
        inputFolder:    ' C:\\a ',
        outputFolder:   ' C:\\b ',
        rejectedFolder: ' C:\\c ',
      }],
    },
  });
  assert.equal(out.jobs.enabled, true);
  assert.equal(out.jobs.configs[0].friendlyName,   'Phone');
  assert.equal(out.jobs.configs[0].inputFolder,    'C:\\a');
  assert.equal(out.jobs.configs[0].outputFolder,   'C:\\b');
  assert.equal(out.jobs.configs[0].rejectedFolder, 'C:\\c');
});

test('sanitise: autoApplyConfigId that does NOT match any config in that scope → nulled', () => {
  const out = _sanitisePerfectlyClear({
    filmScans: {
      enabled: true,
      autoApplyConfigId: 'ghost-id',
      configs: [makeConfig({ id: 'real-id' })],
    },
  });
  assert.equal(out.filmScans.autoApplyConfigId, null);
});

test('sanitise: autoApplyConfigId that MATCHES a config id → preserved', () => {
  const out = _sanitisePerfectlyClear({
    filmScans: {
      enabled: true,
      autoApplyConfigId: 'real-id',
      configs: [makeConfig({ id: 'real-id' })],
    },
  });
  assert.equal(out.filmScans.autoApplyConfigId, 'real-id');
});

test('sanitise: generates an id when a config row has none (operator added a fresh row)', () => {
  const out = _sanitisePerfectlyClear({
    jobs: {
      enabled: false,
      configs: [{
        friendlyName:   'row without id',
        inputFolder:    'C:\\a',
        outputFolder:   'C:\\b',
        rejectedFolder: 'C:\\c',
      }],
    },
  });
  assert.ok(out.jobs.configs[0].id, 'a fresh id should be assigned');
  assert.equal(typeof out.jobs.configs[0].id, 'string');
});

// ── _validatePerfectlyClear — Rule 1: enabled → ≥1 config ────────────────────

test('validate: enabled scope with zero configs → error naming the scope', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: { enabled: true, configs: [] },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /Perfectly Clear "Jobs" is enabled but has no configurations/,
  );
});

test('validate: disabled scope with zero configs → OK (no work required)', () => {
  const pc = _sanitisePerfectlyClear(undefined);
  assert.doesNotThrow(() => _validatePerfectlyClear(pc, { existsSync: existsAlways }));
});

// ── _validatePerfectlyClear — Rule 2: required fields per config ─────────────

test('validate: config with empty friendlyName → error naming the row', () => {
  const pc = _sanitisePerfectlyClear({
    filmScans: { enabled: false, configs: [makeConfig({ friendlyName: '' })] },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /Film Scans row 1: friendly name is required/,
  );
});

test('validate: config with empty inputFolder → error', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: { enabled: false, configs: [makeConfig({ inputFolder: '' })] },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /Jobs row 1 \(Phone Enhancement\): input folder is required/,
  );
});

test('validate: config with empty outputFolder → error', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: { enabled: false, configs: [makeConfig({ outputFolder: '' })] },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /Jobs row 1 \(Phone Enhancement\): output folder is required/,
  );
});

test('validate: config with empty rejectedFolder → error', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: { enabled: false, configs: [makeConfig({ rejectedFolder: '' })] },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /Jobs row 1 \(Phone Enhancement\): rejected folder is required/,
  );
});

test('validate: fully-populated config with all folders passing existence → OK', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: { enabled: true, configs: [makeConfig()] },
  });
  assert.doesNotThrow(() => _validatePerfectlyClear(pc, { existsSync: existsAlways }));
});

// ── _validatePerfectlyClear — Rule 3: inputFolder unique across ALL scopes ───

test('validate: two configs in the SAME scope sharing an inputFolder → error', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: {
      enabled: true,
      configs: [
        makeConfig({ id: 'a', friendlyName: 'A', inputFolder: 'C:\\qs\\input', outputFolder: 'C:\\qs\\out1', rejectedFolder: 'C:\\qs\\rej1' }),
        makeConfig({ id: 'b', friendlyName: 'B', inputFolder: 'C:\\qs\\input', outputFolder: 'C:\\qs\\out2', rejectedFolder: 'C:\\qs\\rej2' }),
      ],
    },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /Jobs row 2 \(B\): input folder "C:\\qs\\input" is already used by Jobs row 1 \(A\)/,
  );
});

test('validate: two configs across DIFFERENT scopes sharing an inputFolder → error (QuickServer channels are global)', () => {
  const pc = _sanitisePerfectlyClear({
    jobs:      { enabled: true, configs: [makeConfig({ id: 'a', friendlyName: 'A', inputFolder: 'C:\\shared' })] },
    filmScans: { enabled: true, configs: [makeConfig({ id: 'b', friendlyName: 'B', inputFolder: 'C:\\shared', outputFolder: 'C:\\o2', rejectedFolder: 'C:\\r2' })] },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /Film Scans row 1 \(B\): input folder "C:\\shared" is already used by Jobs row 1 \(A\)/,
  );
});

test('validate: inputFolder uniqueness is case-insensitive (Windows-safe)', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: {
      enabled: true,
      configs: [
        makeConfig({ id: 'a', friendlyName: 'A', inputFolder: 'C:\\QS\\Input', outputFolder: 'C:\\o1', rejectedFolder: 'C:\\r1' }),
        makeConfig({ id: 'b', friendlyName: 'B', inputFolder: 'c:\\qs\\input', outputFolder: 'C:\\o2', rejectedFolder: 'C:\\r2' }),
      ],
    },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /already used by Jobs row 1/,
  );
});

// ── _validatePerfectlyClear — Rule 4: no output/rejected under any input ─────

test('validate: outputFolder sits UNDER inputFolder → error (ingestion loop)', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: {
      enabled: true,
      configs: [makeConfig({
        inputFolder:    'C:\\qs\\input',
        outputFolder:   'C:\\qs\\input\\output',
        rejectedFolder: 'C:\\qs\\rejected',
      })],
    },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /output folder .* sits inside input folder .*ingestion loop/,
  );
});

test('validate: rejectedFolder sits UNDER inputFolder → error', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: {
      enabled: true,
      configs: [makeConfig({
        inputFolder:    'C:\\qs\\input',
        outputFolder:   'C:\\qs\\output',
        rejectedFolder: 'C:\\qs\\input\\rejected',
      })],
    },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /rejected folder .* sits inside input folder .*ingestion loop/,
  );
});

test("validate: cross-scope prefix check — Jobs' outputFolder under Film Scans' inputFolder → error", () => {
  const pc = _sanitisePerfectlyClear({
    jobs:      { enabled: true, configs: [makeConfig({ id: 'j', friendlyName: 'J', inputFolder: 'C:\\a', outputFolder: 'C:\\shared\\out', rejectedFolder: 'C:\\r1' })] },
    filmScans: { enabled: true, configs: [makeConfig({ id: 'f', friendlyName: 'F', inputFolder: 'C:\\shared', outputFolder: 'C:\\o2', rejectedFolder: 'C:\\r2' })] },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsAlways }),
    /Jobs row 1 \(J\): output folder ".*" sits inside input folder ".*" \(Film Scans row 1 \(F\)\)/,
  );
});

test('validate: sibling folders (output next to input, not under it) → OK', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: {
      enabled: true,
      configs: [makeConfig({
        inputFolder:    'C:\\qs\\input',
        outputFolder:   'C:\\qs\\output',
        rejectedFolder: 'C:\\qs\\rejected',
      })],
    },
  });
  assert.doesNotThrow(() => _validatePerfectlyClear(pc, { existsSync: existsAlways }));
});

// ── _validatePerfectlyClear — Rule 5: folders must exist on disk ─────────────

test('validate: folder that does not exist → error naming the folder + role', () => {
  const pc = _sanitisePerfectlyClear({
    jobs: { enabled: true, configs: [makeConfig({ inputFolder: 'C:\\does-not-exist' })] },
  });
  assert.throws(
    () => _validatePerfectlyClear(pc, { existsSync: existsNever }),
    /input folder "C:\\does-not-exist" does not exist on disk/,
  );
});

test('validate: filesystem check honours real fs — a real temp folder passes', async (t) => {
  const fsp = require('node:fs/promises');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-validate-'));
  const input    = path.join(root, 'input');
  const output   = path.join(root, 'output');
  const rejected = path.join(root, 'rejected');
  await Promise.all([
    fsp.mkdir(input),
    fsp.mkdir(output),
    fsp.mkdir(rejected),
  ]);
  t.after(() => require('node:fs').rmSync(root, { recursive: true, force: true }));

  const pc = _sanitisePerfectlyClear({
    jobs: {
      enabled: true,
      configs: [makeConfig({ inputFolder: input, outputFolder: output, rejectedFolder: rejected })],
    },
  });
  // Real fs.existsSync via default.
  assert.doesNotThrow(() => _validatePerfectlyClear(pc));
});

// ── save()/getAll() round-trip via the singleton ─────────────────────────────
//
// save() calls _validatePerfectlyClear, which honours real fs.existsSync — so
// these tests use real temp folders. The other tests above inject a fake
// existsSync to focus on shape.

const fsp = require('node:fs/promises');

async function makeRealConfig(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohd-pc-rt-'));
  const input    = path.join(root, 'input');
  const output   = path.join(root, 'output');
  const rejected = path.join(root, 'rejected');
  await Promise.all([fsp.mkdir(input), fsp.mkdir(output), fsp.mkdir(rejected)]);
  t.after(() => require('node:fs').rmSync(root, { recursive: true, force: true }));
  return makeConfig({ inputFolder: input, outputFolder: output, rejectedFolder: rejected });
}

test('save + getAll: perfectlyClear round-trips through the store, sanitising on read', async (t) => {
  const cfg = await makeRealConfig(t);
  configService.save({
    perfectlyClear: {
      jobs: {
        enabled: false,
        configs: [{ ...cfg, friendlyName: '  Phone  ' }],
      },
    },
  });
  const round = configService.getAll();
  assert.equal(round.perfectlyClear.jobs.configs[0].friendlyName, 'Phone', 'trims via sanitise on read');
  assert.equal(round.perfectlyClear.filmScans.enabled, false, 'missing scope filled with default on read');
  assert.equal(round.perfectlyClear.fileUploads.enabled, false);
});

test('save: absent perfectlyClear key does NOT nuke on-disk value (hasOwnProperty guard)', async (t) => {
  const cfg = await makeRealConfig(t);
  // First save a real value…
  configService.save({
    perfectlyClear: {
      jobs: { enabled: false, configs: [{ ...cfg, friendlyName: 'A' }] },
    },
  });
  const before = configService.getAll().perfectlyClear;
  // …then save a slice that doesn't know about perfectlyClear. The previous
  // value must survive — mirrors the pattern the Film Scan rotation keys use
  // to protect themselves from partial saves.
  configService.save({ enhancementProvider: 'local' });
  const after = configService.getAll().perfectlyClear;
  assert.deepEqual(after, before, 'partial save must not reset perfectlyClear');
});
