'use strict';

/**
 * Regression tests for the 1.16.3 → 1.16.4 FTP-settings persistence
 * defect and the class of defect it belongs to.
 *
 * The 1.16.3 release added four settings — ftpKeepFilesOnServer,
 * ftpRetentionSweepEnabled, ftpRetentionSweepDays, ftpRetentionSweepDryRun —
 * with matching renderer inputs and runtime readers, but forgot to wire
 * them through config-service's explicit `save()` and `getAll()`. The
 * result: Settings reported "saved successfully", the four values were
 * silently dropped, `getAll()` returned undefined for them, and the
 * runtime read the fallback default (`false` for Copy mode) — so
 * ticking "Keep files on the server" changed nothing at all, at a
 * client, in production.
 *
 * Two invariants tested here:
 *
 * 1. **Round-trip.** For each of the four keys: save via
 *    `configService.save(...)`, read back via `getAll()`, assert the
 *    value survives verbatim. Explicit coverage that `false` survives
 *    as `false` (not lost to a truthiness fallback) and that a
 *    non-parseable / out-of-range `ftpRetentionSweepDays` restores the
 *    default (7) instead of persisting garbage. This is the direct
 *    regression guard.
 *
 * 2. **Source-scan tripwire.** Read index.html, extract every
 *    `name="X"` input inside `#settingsForm`, and assert each name
 *    appears in BOTH `save()` (has a `this.store.set('X', …)` line)
 *    AND `getAll()` (has an `X: this.store.get('X')` line) in
 *    config-service.js. Derives the field list from the HTML so
 *    future settings are covered automatically — the class-closer.
 *
 * Harness copied from config-service-ftp-sources.test.js: stub
 * `electron-store` via Module.prototype.require so the ConfigService
 * class loads headless.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const Module = require('node:module');

const REPO         = path.resolve(__dirname, '..', '..', '..', '..');
const INDEX_HTML   = path.join(REPO, 'src', 'renderer', 'index.html');
const CONFIG_SVC   = path.join(REPO, 'src', 'main', 'services', 'config-service.js');

const __origRequire = Module.prototype.require;

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
        has(key)    { return key in this._d; }
        get store() { return this._d; }
      };
    }
    return __origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve('../config-service')];
  return { cs: require('../config-service'), dataRef: fakeData };
}

test.afterEach(() => {
  Module.prototype.require = __origRequire;
  delete require.cache[require.resolve('../config-service')];
});

// ── Round-trip tests (invariant 1) ────────────────────────────────────────

test('round-trip: ftpKeepFilesOnServer=true survives save + getAll', () => {
  const { cs } = freshConfigService();
  cs.save({ ftpKeepFilesOnServer: true });
  const round = cs.getAll();
  assert.equal(round.ftpKeepFilesOnServer, true,
    'the value the operator ticked in Settings must be readable back on the ' +
    'next getAll — the 1.16.3 defect was that this was silently dropped');
});

test('round-trip: ftpKeepFilesOnServer=false survives save + getAll (false is not lost to a truthiness fallback)', () => {
  const { cs } = freshConfigService();
  cs.save({ ftpKeepFilesOnServer: true });      // seed true first
  assert.equal(cs.getAll().ftpKeepFilesOnServer, true);
  cs.save({ ftpKeepFilesOnServer: false });     // then set false explicitly
  assert.equal(cs.getAll().ftpKeepFilesOnServer, false,
    'explicit false must persist as false — `Boolean(x || y)` shape would ' +
    'lose it silently');
});

test('round-trip: ftpRetentionSweepEnabled=true and =false both survive', () => {
  const { cs } = freshConfigService();
  cs.save({ ftpRetentionSweepEnabled: true });
  assert.equal(cs.getAll().ftpRetentionSweepEnabled, true);
  cs.save({ ftpRetentionSweepEnabled: false });
  assert.equal(cs.getAll().ftpRetentionSweepEnabled, false);
});

test('round-trip: ftpRetentionSweepDryRun=true and =false both survive', () => {
  const { cs } = freshConfigService();
  cs.save({ ftpRetentionSweepDryRun: true });
  assert.equal(cs.getAll().ftpRetentionSweepDryRun, true);
  cs.save({ ftpRetentionSweepDryRun: false });
  assert.equal(cs.getAll().ftpRetentionSweepDryRun, false);
});

test('round-trip: ftpRetentionSweepDays valid integer survives', () => {
  const { cs } = freshConfigService();
  cs.save({ ftpRetentionSweepDays: 14 });
  assert.equal(cs.getAll().ftpRetentionSweepDays, 14);
});

test('round-trip: ftpRetentionSweepDays missing key → default 7', () => {
  const { cs } = freshConfigService();
  cs.save({});
  assert.equal(cs.getAll().ftpRetentionSweepDays, 7,
    'missing key must fall back to the documented default (7 days) — the ' +
    'operator-facing rationale is a lab is closed 2-3 days, OHD runs ' +
    'continuously, so 7 gives headroom');
});

test('round-trip: ftpRetentionSweepDays garbage input (NaN, negative, string, 0) restores default 7', () => {
  const { cs } = freshConfigService();
  for (const bad of [NaN, -5, 0, 'not a number', {}, null]) {
    cs.save({ ftpRetentionSweepDays: bad });
    assert.equal(cs.getAll().ftpRetentionSweepDays, 7,
      `bad input ${JSON.stringify(bad)} must clamp back to default 7 — never persist garbage`);
  }
});

test('round-trip: all four settings together survive a single save', () => {
  const { cs } = freshConfigService();
  cs.save({
    ftpKeepFilesOnServer: true,
    ftpRetentionSweepEnabled: true,
    ftpRetentionSweepDays: 3,
    ftpRetentionSweepDryRun: true,
  });
  const round = cs.getAll();
  assert.equal(round.ftpKeepFilesOnServer,     true);
  assert.equal(round.ftpRetentionSweepEnabled, true);
  assert.equal(round.ftpRetentionSweepDays,    3);
  assert.equal(round.ftpRetentionSweepDryRun,  true);
});

test('round-trip: an existing config.json value survives when the operator opens Settings and saves without touching the field', () => {
  // Simulates the workaround scenario: value hand-added to
  // config.json OR set by a prior in-app save. Operator opens
  // Settings and saves — the checkbox state (from the loaded
  // getAll) should round-trip unchanged.
  const { cs, dataRef } = freshConfigService();
  dataRef.ftpKeepFilesOnServer = true;   // pre-existing value in the store
  const loaded = cs.getAll();
  assert.equal(loaded.ftpKeepFilesOnServer, true, 'load reads the existing value');
  cs.save(loaded);                        // re-save the same object
  assert.equal(cs.getAll().ftpKeepFilesOnServer, true,
    'a save that re-passes the loaded value must not lose it — this is what ' +
    'the renderer does every time the operator clicks Save');
});

// ── Source-scan tripwire (invariant 2) ────────────────────────────────────

test('source-scan: every name="…" input inside #settingsForm in index.html appears in BOTH config-service.save() and getAll()', () => {
  // The class the 1.16.3 FTP defect belongs to: a settings input
  // in the HTML with a matching renderer collector but NO
  // corresponding line in config-service's save/get. The renderer
  // sends the value, `save()` silently drops it, `getAll()` returns
  // undefined for it, and the next Settings load shows the field
  // in its default state — no error visible to the operator.
  //
  // Derive the field list from index.html so a new setting added
  // in a future release is covered automatically without editing
  // this test.
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const configSrc = fs.readFileSync(CONFIG_SVC, 'utf8');

  // Isolate the #settingsForm block. Anchor from the opening
  // `<form id="settingsForm"` to its matching `</form>`. The file
  // has exactly one such form (verified by the anchor regex
  // returning one match); further forms live inside modals under
  // different ids.
  const formStart = html.search(/<form[^>]*\bid=["']settingsForm["']/);
  assert.notEqual(formStart, -1, 'sanity: index.html must contain <form id="settingsForm">');
  const formEnd = html.indexOf('</form>', formStart);
  assert.notEqual(formEnd, -1, 'sanity: settingsForm must have a closing </form>');
  const formBlock = html.slice(formStart, formEnd);

  // Extract every `name="X"` attribute inside the form. The
  // renderer relies on document.getElementById() rather than
  // form.elements['name'], but the `name` attribute is the stable
  // marker of "this is a persisted field" — HTML boilerplate
  // inputs (search boxes, filter chips) don't carry it. If a
  // future maintainer adds a persisted field without a `name`,
  // they'll skip this tripwire — accept that trade for the
  // false-positive avoidance.
  const nameRe = /\bname=(["'])([^"']+)\1/g;
  const names = new Set();
  let m;
  while ((m = nameRe.exec(formBlock))) {
    names.add(m[2]);
  }
  assert.ok(names.size > 0,
    'sanity: settingsForm must contain at least one input with a name attribute');

  // Fields legitimately inside the form but NOT persisted under
  // their own literal `name` — the value is mapped to a different
  // storage key (aggregate object, checkbox-to-enum, etc). Every
  // exception carries a one-line justification with the mapping so
  // future maintainers don't add exceptions carelessly. If you
  // remove or rename a mapped renderer field, delete the exception
  // in the same commit — the tripwire will flag the plain name.
  const NON_PERSISTED = new Set([
    // Checkbox for "block auto-print on low AI quality score", maps to
    // the stored `aiQualityMode` enum ('block'/'warn'). Renderer at
    // renderer.js:2891 reads `#aiQualityHoldAutoPrint.checked` and
    // sends `aiQualityMode: checked ? 'block' : 'warn'`; config-service
    // persists `aiQualityMode`.
    'aiQualityHoldAutoPrint',
    // Perfectly Clear per-scope checkboxes. Renderer at
    // renderer.js:2926 builds a nested `perfectlyClear: {...}` object
    // via `readPerfectlyClearFromUI()`; config-service persists the
    // aggregate `perfectlyClear` key via `_sanitisePerfectlyClear`
    // (config-service.js:1298-1300). The pc* form field names are the
    // UI-side identifiers, not storage keys.
    'pcJobsEnabled',
    'pcFilmScansEnabled',
    'pcFilmScansAutoApply',
    'pcFileUploadsEnabled',
    'pcFileUploadsAutoApply',
  ]);

  const missingInSave = [];
  const missingInGet  = [];
  for (const name of names) {
    if (NON_PERSISTED.has(name)) continue;
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const setRe = new RegExp(`this\\.store\\.set\\(\\s*['"]${escName}['"]`);
    const getRe = new RegExp(`\\b${escName}\\s*:\\s*this\\.store\\.get\\(\\s*['"]${escName}['"]`);
    if (!setRe.test(configSrc)) missingInSave.push(name);
    if (!getRe.test(configSrc)) missingInGet.push(name);
  }

  const report = [];
  if (missingInSave.length) report.push('missing in save(): ' + missingInSave.join(', '));
  if (missingInGet.length)  report.push('missing in getAll(): ' + missingInGet.join(', '));

  assert.deepEqual([missingInSave, missingInGet], [[], []],
    'settings form inputs must appear in both config-service.save() (as ' +
    'this.store.set(\'<name>\', …)) AND getAll() (as <name>: this.store.get(\'<name>\')). ' +
    `The 1.16.3 FTP defect was exactly this shape — an input was collected by ` +
    `the renderer but neither wired to save nor to get. Report: ` +
    (report.length ? report.join('; ') : 'clean'));
});
