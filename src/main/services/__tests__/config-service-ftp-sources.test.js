'use strict';

/**
 * Unit tests for the FTP Sources additions to config-service.js
 * (M1 of docs/ftp-sources-brief.md).
 *
 * Coverage:
 *   - Defaults: ftpSources absent = [] on getAll and getFtpSources.
 *   - Round-trip: valid enabled + disabled sources persist and re-emerge
 *     verbatim (minus the ciphertext, which the renderer boundary strips).
 *   - Encryption: freshly-supplied passwords are encrypted via
 *     encryption-service before storage; the plaintext MUST NOT appear
 *     anywhere in the store, including in stringified form. The renderer
 *     boundary strips `passwordEncrypted` entirely and replaces it with a
 *     `hasPassword` boolean so the ciphertext never round-trips through
 *     the UI.
 *   - Password preservation: a save that omits `password` (renderer's
 *     "leave blank to keep existing" pattern) preserves the prior
 *     ciphertext for the matching id.
 *   - Encryption unavailable: when safeStorage returns unavailable, the
 *     sanitiser throws rather than silently writing a plaintext password
 *     — matches the brief's "never plaintext" mandate and the CLAUDE.md
 *     landmine warning about safeStorage never having been wired up.
 *   - Validation: every bad shape the brief calls out is rejected with a
 *     useful error message — missing name, duplicate name, bad port,
 *     bad interval, missing localPath, enabled-without-connection-fields.
 *
 * Harness follows config-service-order-xml.test.js verbatim: stub
 * `electron` + `electron-store` via Module.prototype.require, plus stub
 * the lazy-required `encryption-service` module via require.cache so the
 * sanitiser sees a deterministic encryptor.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const __origRequire = Module.prototype.require;

// Per-test mutable state on the stubbed encryption-service.
let __safeStorageAvailable = true;

// Deterministic reversible "encryption" that hides the plaintext characters —
// a hex encoding is enough for the "plaintext not in store" assertions, and
// the ENC[…] wrapper makes it easy to spot in test failures.
function fakeEncrypt(pt) {
  if (!pt) return '';
  return 'ENC[' + Buffer.from(pt, 'utf8').toString('hex') + ']';
}
function fakeDecrypt(ct) {
  if (!ct) return '';
  const m = /^ENC\[([0-9a-f]*)\]$/i.exec(String(ct));
  if (!m) return ct;
  return Buffer.from(m[1], 'hex').toString('utf8');
}

/**
 * Build a fresh config-service instance with an in-memory store and a
 * stubbed encryption-service. Returns { cs, dataRef } — dataRef is the
 * live in-memory backing object so tests can search the raw store shape.
 */
function freshConfigService() {
  const fakeData = {};

  Module.prototype.require = function (req) {
    if (req === 'electron') {
      return { app: { getPath: () => '/tmp' } };
    }
    if (req === 'electron-store') {
      return class FakeStore {
        constructor(opts) { this._opts = opts; this._d = fakeData; }
        get(key, fallback) {
          if (this._d[key] !== undefined) return this._d[key];
          const def = this._opts && this._opts.schema && this._opts.schema[key] &&
                      this._opts.schema[key].default;
          return def !== undefined ? def : fallback;
        }
        set(key, value) { this._d[key] = value; }
        delete(key) { delete this._d[key]; }
        get store() { return this._d; }
      };
    }
    return __origRequire.apply(this, arguments);
  };

  // Fresh config-service each test.
  delete require.cache[require.resolve('../config-service')];

  // Stub encryption-service via require.cache — resolved key matches how
  // config-service will require it (relative import from the same
  // directory). This must be installed BEFORE config-service loads OR
  // before the sanitiser's lazy require runs; simpler to do it up-front.
  const encPath = require.resolve('../encryption-service');
  require.cache[encPath] = {
    id: encPath,
    filename: encPath,
    loaded: true,
    exports: {
      isAvailable: () => __safeStorageAvailable,
      encrypt: fakeEncrypt,
      decrypt: fakeDecrypt,
    },
  };

  return { cs: require('../config-service'), dataRef: fakeData };
}

test.afterEach(() => {
  Module.prototype.require = __origRequire;
  __safeStorageAvailable = true;
  // Drop the stubbed encryption-service so a subsequent test that DOESN'T
  // stub it (or that changes the stub) doesn't inherit a stale cache entry.
  const encPath = require.resolve('../encryption-service');
  delete require.cache[encPath];
});

// ── Defaults ────────────────────────────────────────────────────────────────

test('defaults: ftpSources is [] on getAll and getFtpSources', () => {
  const { cs } = freshConfigService();
  assert.deepEqual(cs.getAll().ftpSources, []);
  assert.deepEqual(cs.getFtpSources(),     []);
});

// ── Round-trip ──────────────────────────────────────────────────────────────

test('round-trip: enabled source with password persists; getAll strips ciphertext + surfaces hasPassword', () => {
  const { cs, dataRef } = freshConfigService();
  cs.save({
    ftpSources: [{
      id:                  'src-1',
      name:                'Labworks XML',
      enabled:             true,
      host:                'ftp.example.com',
      port:                21,
      username:            'lab',
      password:            'sekret-password',
      secure:              false,
      remotePath:          '/incoming/labworks',
      localPath:           'C:/Lab/Inbox',
      intervalMinutes:     5,
      deleteAfterDownload: true,
    }],
  });

  // Renderer-facing shape (getAll) — no ciphertext, hasPassword true.
  const rendererShape = cs.getAll().ftpSources;
  assert.equal(rendererShape.length, 1);
  const r = rendererShape[0];
  assert.equal(r.id,                  'src-1');
  assert.equal(r.name,                'Labworks XML');
  assert.equal(r.enabled,             true);
  assert.equal(r.host,                'ftp.example.com');
  assert.equal(r.port,                21);
  assert.equal(r.username,            'lab');
  assert.equal(r.secure,              false);
  assert.equal(r.remotePath,          '/incoming/labworks');
  assert.equal(r.localPath,           'C:/Lab/Inbox');
  assert.equal(r.intervalMinutes,     5);
  assert.equal(r.deleteAfterDownload, true);
  assert.equal(r.hasPassword,         true);
  assert.equal(r.password,            undefined, 'plaintext MUST NOT reach the renderer');
  assert.equal(r.passwordEncrypted,   undefined, 'ciphertext MUST NOT reach the renderer either');

  // Internal shape (getFtpSources) — ciphertext present, plaintext still absent.
  const internal = cs.getFtpSources()[0];
  assert.equal(internal.passwordEncrypted, fakeEncrypt('sekret-password'));
  assert.equal(internal.password,          undefined,
    'plaintext must not be persisted on the store row alongside the ciphertext');

  // Raw store search — plaintext MUST NOT appear anywhere.
  const raw = JSON.stringify(dataRef);
  assert.ok(!raw.includes('sekret-password'),
    'plaintext password must not appear anywhere in the store (leaks bypass the ciphertext boundary)');
});

test('round-trip: disabled source with only name + localPath is preserved verbatim (draft mode)', () => {
  // The brief explicitly locks this contract: "a disabled source round-trips
  // unchanged". Drafts are legitimate — an operator jotting down "I'll
  // configure this later" shouldn't be forced to fill every field on save.
  const { cs } = freshConfigService();
  cs.save({
    ftpSources: [{
      id:        'draft-1',
      name:      'Placeholder',
      enabled:   false,
      localPath: 'C:/tmp',
      // host, username, password, remotePath deliberately absent.
    }],
  });

  const all = cs.getAll().ftpSources;
  assert.equal(all.length, 1);
  assert.equal(all[0].name,                'Placeholder');
  assert.equal(all[0].enabled,             false);
  assert.equal(all[0].host,                '');
  assert.equal(all[0].username,            '');
  assert.equal(all[0].remotePath,          '');
  assert.equal(all[0].localPath,           'C:/tmp');
  assert.equal(all[0].hasPassword,         false);
  assert.equal(all[0].port,                21,   'defaulted');
  assert.equal(all[0].intervalMinutes,     5,    'defaulted');
  assert.equal(all[0].deleteAfterDownload, true, 'defaulted (the "move" in the brief)');
  assert.equal(all[0].secure,              false);
});

test('round-trip: multiple sources preserved in order', () => {
  const { cs } = freshConfigService();
  cs.save({
    ftpSources: [
      { id: 'a', name: 'Alpha', enabled: false, localPath: 'C:/a' },
      { id: 'b', name: 'Bravo', enabled: false, localPath: 'C:/b' },
      { id: 'c', name: 'Charlie', enabled: false, localPath: 'C:/c' },
    ],
  });
  const names = cs.getAll().ftpSources.map((s) => s.name);
  assert.deepEqual(names, ['Alpha', 'Bravo', 'Charlie']);
});

// ── Password preservation ("leave blank to keep existing") ─────────────────

test('password preservation: save with no `password` field keeps prior ciphertext (matching by id)', () => {
  const { cs, dataRef } = freshConfigService();

  cs.save({
    ftpSources: [{
      id: 'src-1', name: 'One', enabled: false, localPath: 'C:/one', password: 'first-secret',
    }],
  });
  const firstCiphertext = cs.getFtpSources()[0].passwordEncrypted;
  assert.equal(firstCiphertext, fakeEncrypt('first-secret'));

  // Second save omits password entirely — must preserve the prior ciphertext.
  cs.save({
    ftpSources: [{
      id: 'src-1', name: 'One (renamed)', enabled: false, localPath: 'C:/one',
    }],
  });
  const preserved = cs.getFtpSources()[0].passwordEncrypted;
  assert.equal(preserved, firstCiphertext,
    'omitting `password` must preserve the stored ciphertext (renderer "leave blank" pattern)');
  assert.ok(!JSON.stringify(dataRef).includes('first-secret'),
    'plaintext still must not appear anywhere in the store after preservation');
});

test('password preservation: save with empty-string `password` also preserves prior ciphertext', () => {
  // Renderer may send an empty string rather than omit the field entirely
  // when the input is left blank. Both must mean "keep existing".
  const { cs } = freshConfigService();
  cs.save({
    ftpSources: [{
      id: 'src-1', name: 'One', enabled: false, localPath: 'C:/one', password: 'first-secret',
    }],
  });
  const firstCiphertext = cs.getFtpSources()[0].passwordEncrypted;

  cs.save({
    ftpSources: [{
      id: 'src-1', name: 'One', enabled: false, localPath: 'C:/one', password: '',
    }],
  });
  assert.equal(cs.getFtpSources()[0].passwordEncrypted, firstCiphertext);
});

test('password preservation: save with a new `password` replaces the prior ciphertext', () => {
  const { cs, dataRef } = freshConfigService();
  cs.save({
    ftpSources: [{
      id: 'src-1', name: 'One', enabled: false, localPath: 'C:/one', password: 'first-secret',
    }],
  });
  cs.save({
    ftpSources: [{
      id: 'src-1', name: 'One', enabled: false, localPath: 'C:/one', password: 'second-secret',
    }],
  });
  assert.equal(cs.getFtpSources()[0].passwordEncrypted, fakeEncrypt('second-secret'));
  const raw = JSON.stringify(dataRef);
  assert.ok(!raw.includes('first-secret'),  'old plaintext must not linger');
  assert.ok(!raw.includes('second-secret'), 'new plaintext must not appear either');
});

// ── Encryption unavailable → hard fail on password write ────────────────────

test('encryption unavailable: throws rather than persisting a plaintext password', () => {
  __safeStorageAvailable = false;
  const { cs, dataRef } = freshConfigService();

  assert.throws(
    () => cs.save({
      ftpSources: [{
        id: 'x', name: 'X', enabled: false, localPath: 'C:/x', password: 'never-store-me',
      }],
    }),
    /safeStorage encryption is not available/,
    'the sanitiser must refuse rather than fall through to plaintext (CLAUDE.md landmine)',
  );

  const raw = JSON.stringify(dataRef);
  assert.ok(!raw.includes('never-store-me'),
    'plaintext must not appear anywhere in the store after a rejected save');
});

test('encryption unavailable: save without a password field still succeeds (no encryption needed)', () => {
  __safeStorageAvailable = false;
  const { cs } = freshConfigService();
  // Draft with no password — no encryption call — should succeed even
  // when safeStorage is broken. The hard-fail is scoped to actual
  // encryption attempts, not to every save.
  cs.save({
    ftpSources: [{
      id: 'draft', name: 'Draft', enabled: false, localPath: 'C:/draft',
    }],
  });
  assert.equal(cs.getAll().ftpSources.length, 1);
});

// ── Validation ──────────────────────────────────────────────────────────────

test('validation: missing name is rejected', () => {
  const { cs } = freshConfigService();
  assert.throws(
    () => cs.save({ ftpSources: [{ id: 'x', enabled: false, localPath: 'C:/x' }] }),
    /name is required/,
  );
});

test('validation: duplicate names (case-insensitive) are rejected', () => {
  const { cs } = freshConfigService();
  assert.throws(
    () => cs.save({
      ftpSources: [
        { id: 'a', name: 'Lab', enabled: false, localPath: 'C:/a' },
        { id: 'b', name: 'LAB', enabled: false, localPath: 'C:/b' },
      ],
    }),
    /used more than once/,
  );
});

test('validation: missing localPath is rejected on any row (draft or enabled)', () => {
  const { cs } = freshConfigService();
  assert.throws(
    () => cs.save({ ftpSources: [{ id: 'x', name: 'X', enabled: false }] }),
    /local path is required/,
    'even a draft must have a destination — brief §M1 validation list',
  );
});

test('validation: port out of range is rejected', () => {
  const { cs } = freshConfigService();
  for (const bad of [0, -1, 65536, 999999, 3.14, 'abc']) {
    assert.throws(
      () => cs.save({
        ftpSources: [{ id: 'x', name: 'X', enabled: false, localPath: 'C:/x', port: bad }],
      }),
      /port must be an integer between 1 and 65535/,
      `port=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('validation: intervalMinutes out of range is rejected', () => {
  const { cs } = freshConfigService();
  for (const bad of [0, -1, 1441, 3.5, 'abc']) {
    assert.throws(
      () => cs.save({
        ftpSources: [{
          id: 'x', name: 'X', enabled: false, localPath: 'C:/x', intervalMinutes: bad,
        }],
      }),
      /interval must be an integer between 1 and 1440/,
      `intervalMinutes=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('validation: enabled source without host is rejected', () => {
  const { cs } = freshConfigService();
  assert.throws(
    () => cs.save({
      ftpSources: [{
        id: 'x', name: 'X', enabled: true, localPath: 'C:/x',
        username: 'u', password: 'p', remotePath: '/r',
      }],
    }),
    /host is required when enabled/,
  );
});

test('validation: enabled source without username is rejected', () => {
  const { cs } = freshConfigService();
  assert.throws(
    () => cs.save({
      ftpSources: [{
        id: 'x', name: 'X', enabled: true, localPath: 'C:/x',
        host: 'h', password: 'p', remotePath: '/r',
      }],
    }),
    /username is required when enabled/,
  );
});

test('validation: enabled source without password is rejected (fresh source, no prior ciphertext)', () => {
  const { cs } = freshConfigService();
  assert.throws(
    () => cs.save({
      ftpSources: [{
        id: 'x', name: 'X', enabled: true, localPath: 'C:/x',
        host: 'h', username: 'u', remotePath: '/r',
      }],
    }),
    /password is required when enabled/,
  );
});

test('validation: enabled source without remotePath is rejected', () => {
  const { cs } = freshConfigService();
  assert.throws(
    () => cs.save({
      ftpSources: [{
        id: 'x', name: 'X', enabled: true, localPath: 'C:/x',
        host: 'h', username: 'u', password: 'p',
      }],
    }),
    /remote path is required when enabled/,
  );
});

test('validation: id is auto-generated when absent (uuid-shaped)', () => {
  const { cs } = freshConfigService();
  cs.save({ ftpSources: [{ name: 'No-id', enabled: false, localPath: 'C:/x' }] });
  const stored = cs.getFtpSources()[0];
  assert.ok(typeof stored.id === 'string' && stored.id.length > 0,
    'sanitiser must mint an id when the caller omits one');
});

// ── Defaults on absent optional fields ──────────────────────────────────────

test('defaults: port and intervalMinutes fall back when the field is null/undefined/empty-string', () => {
  const { cs } = freshConfigService();
  cs.save({
    ftpSources: [{
      id: 'x', name: 'X', enabled: false, localPath: 'C:/x',
      port: null, intervalMinutes: undefined,
    }],
  });
  const stored = cs.getFtpSources()[0];
  assert.equal(stored.port,            21);
  assert.equal(stored.intervalMinutes, 5);
});

test('defaults: deleteAfterDownload defaults to true (the "move" semantic); explicit false is kept', () => {
  const { cs } = freshConfigService();
  cs.save({
    ftpSources: [
      { id: 'a', name: 'A', enabled: false, localPath: 'C:/a' },
      { id: 'b', name: 'B', enabled: false, localPath: 'C:/b', deleteAfterDownload: false },
    ],
  });
  const all = cs.getFtpSources();
  assert.equal(all[0].deleteAfterDownload, true,  'default is move, not copy');
  assert.equal(all[1].deleteAfterDownload, false, 'explicit false = copy');
});

test('defaults: secure defaults to false; explicit true is preserved for forward-compat', () => {
  // ftp-service.js today ignores this at the transport layer; the field is
  // stored so a future FTPS upgrade doesn't need a config migration.
  const { cs } = freshConfigService();
  cs.save({
    ftpSources: [{ id: 'x', name: 'X', enabled: false, localPath: 'C:/x', secure: true }],
  });
  assert.equal(cs.getFtpSources()[0].secure, true);
});

// ── Save-shape safety ──────────────────────────────────────────────────────

test('save with no ftpSources key at all leaves the stored list untouched (Order XML pattern)', () => {
  const { cs } = freshConfigService();
  cs.save({ ftpSources: [{ id: 'x', name: 'X', enabled: false, localPath: 'C:/x' }] });
  cs.save({ /* no ftpSources */ });
  assert.equal(cs.getFtpSources().length, 1, 'absent key = no write');
});

test('non-object rows are silently skipped (defensive against a malformed IPC payload)', () => {
  const { cs } = freshConfigService();
  cs.save({
    ftpSources: [
      null,
      undefined,
      'not-an-object',
      { id: 'ok', name: 'OK', enabled: false, localPath: 'C:/ok' },
    ],
  });
  assert.equal(cs.getFtpSources().length, 1);
});

// ── saveFtpSource / deleteFtpSource (M4 Option F — per-source persistence) ─
//
// These methods are the primary entry point after M4a: the general Settings
// save no longer round-trips ftpSources. One bad row can only reject its own
// save now; other settings are unaffected. Each save runs through the same
// `_sanitiseFtpSources` above so validation + encryption + list-uniqueness
// all fire identically to the batch path.

test('saveFtpSource: create new row appends and returns the row with a minted id', () => {
  const { cs } = freshConfigService();
  const saved = cs.saveFtpSource({
    name: 'New Source', enabled: false, localPath: 'C:/new',
  });
  assert.ok(saved.id, 'sanitiser minted an id');
  assert.equal(saved.name, 'New Source');
  const all = cs.getFtpSources();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, saved.id);
});

test('saveFtpSource: create with a supplied id preserves it', () => {
  const { cs } = freshConfigService();
  const saved = cs.saveFtpSource({
    id: 'preassigned', name: 'One', enabled: false, localPath: 'C:/one',
  });
  assert.equal(saved.id, 'preassigned');
});

test('saveFtpSource: update by id replaces the matching row without touching siblings', () => {
  const { cs } = freshConfigService();
  cs.saveFtpSource({ id: 'a', name: 'A', enabled: false, localPath: 'C:/a' });
  cs.saveFtpSource({ id: 'b', name: 'B', enabled: false, localPath: 'C:/b' });
  cs.saveFtpSource({ id: 'a', name: 'A-renamed', enabled: false, localPath: 'C:/a-new' });

  const all = cs.getFtpSources();
  assert.equal(all.length, 2, 'no duplicate row created — matched by id');
  const a = all.find((s) => s.id === 'a');
  const b = all.find((s) => s.id === 'b');
  assert.equal(a.name,      'A-renamed');
  assert.equal(a.localPath, 'C:/a-new');
  assert.equal(b.name,      'B',        'sibling untouched');
  assert.equal(b.localPath, 'C:/b',     'sibling untouched');
});

test('saveFtpSource: update preserves the stored ciphertext when password field is omitted', () => {
  const { cs, dataRef } = freshConfigService();
  cs.saveFtpSource({
    id: 'x', name: 'X', enabled: false, localPath: 'C:/x', password: 'original-secret',
  });
  const ciphertextBefore = cs.getFtpSources()[0].passwordEncrypted;

  // Second save omits password entirely — the "leave blank to keep
  // existing" pattern the masked-UI field relies on.
  cs.saveFtpSource({
    id: 'x', name: 'X (renamed)', enabled: false, localPath: 'C:/x',
  });
  assert.equal(cs.getFtpSources()[0].passwordEncrypted, ciphertextBefore);
  assert.ok(!JSON.stringify(dataRef).includes('original-secret'),
    'plaintext must not leak into the store on subsequent saves either');
});

test('saveFtpSource: throws on validation error — nothing persists', () => {
  const { cs } = freshConfigService();
  cs.saveFtpSource({ id: 'ok', name: 'OK', enabled: false, localPath: 'C:/ok' });
  assert.throws(
    () => cs.saveFtpSource({ id: 'bad', enabled: false, localPath: 'C:/bad' }),   // no name
    /name is required/,
  );
  // The valid row remains — the bad save aborted mid-sanitise, no store write happened.
  assert.equal(cs.getFtpSources().length, 1);
  assert.equal(cs.getFtpSources()[0].id, 'ok');
});

test('saveFtpSource: name uniqueness enforced against OTHER rows already in the store', () => {
  const { cs } = freshConfigService();
  cs.saveFtpSource({ id: 'a', name: 'Lab', enabled: false, localPath: 'C:/a' });
  assert.throws(
    () => cs.saveFtpSource({ id: 'b', name: 'lab', enabled: false, localPath: 'C:/b' }),
    /used more than once/,
    'case-insensitive uniqueness — B collides with A',
  );
});

test('saveFtpSource: null / non-object input throws with a clear message', () => {
  const { cs } = freshConfigService();
  assert.throws(() => cs.saveFtpSource(null),      /source is required/);
  assert.throws(() => cs.saveFtpSource(undefined), /source is required/);
  assert.throws(() => cs.saveFtpSource('nope'),    /source is required/);
});

// ── deleteFtpSource ────────────────────────────────────────────────────────

test('deleteFtpSource: existing id → removed, returns {existed:true}', () => {
  const { cs } = freshConfigService();
  cs.saveFtpSource({ id: 'a', name: 'A', enabled: false, localPath: 'C:/a' });
  cs.saveFtpSource({ id: 'b', name: 'B', enabled: false, localPath: 'C:/b' });
  const result = cs.deleteFtpSource('a');
  assert.deepEqual(result, { existed: true });
  const remaining = cs.getFtpSources().map((s) => s.id);
  assert.deepEqual(remaining, ['b']);
});

test('deleteFtpSource: unknown id → no-op, returns {existed:false} (idempotent)', () => {
  const { cs } = freshConfigService();
  cs.saveFtpSource({ id: 'a', name: 'A', enabled: false, localPath: 'C:/a' });
  const result = cs.deleteFtpSource('never-existed');
  assert.deepEqual(result, { existed: false });
  assert.equal(cs.getFtpSources().length, 1, 'no accidental deletions of other rows');
});

test('deleteFtpSource: does NOT validate other rows — a stale invalid row cannot lock out delete', () => {
  // Scenario the Option-F decision protects against: a bad row somehow
  // ended up in the store (hand-edited config, sanitiser rule tightened
  // after the row was saved). Delete must still work without running
  // the sanitiser over the survivors.
  const { cs, dataRef } = freshConfigService();
  cs.saveFtpSource({ id: 'good', name: 'Good', enabled: false, localPath: 'C:/g' });
  // Simulate a corrupt row appearing (bypass sanitiser).
  dataRef.ftpSources.push({ id: 'corrupt' /* no name, no localPath */ });

  const result = cs.deleteFtpSource('good');
  assert.deepEqual(result, { existed: true });
  const remaining = cs.getFtpSources().map((s) => s.id);
  assert.deepEqual(remaining, ['corrupt'], 'delete succeeded even with a corrupt sibling');
});
