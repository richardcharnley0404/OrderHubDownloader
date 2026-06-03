/**
 * Unit tests for the Order XML Hot Folder additions to config-service.js
 * (Mode 4: schema, getAll/save round-trip, sanitisation, helpers).
 *
 * Run via:
 *   npm test
 *
 * Strategy: stub `electron` and `electron-store` via Module.prototype.require
 * (mirrors config-service-bom.test.js) so we exercise the real config-service
 * code without an Electron runtime. The stubbed Store keeps an in-memory map
 * and respects schema defaults, which is enough to unit-test the new logic.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// Test harness — fresh in-memory config-service per test
// ---------------------------------------------------------------------------

const __origRequire = Module.prototype.require;

/**
 * Build a fresh config-service instance with an in-memory store.
 * Each call returns a new module (via cache delete) so per-test state is
 * isolated. Returns the module's default export (the singleton).
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

  // Force a fresh load so each test gets a clean singleton.
  delete require.cache[require.resolve('../config-service')];
  // Also drop the parser registry cache so the lazy require inside
  // _sanitiseOrderXmlHotFolders sees a fresh copy.
  delete require.cache[require.resolve('../order-xml-parsers')];
  delete require.cache[require.resolve('../order-xml-parsers/photo-finale')];

  return require('../config-service');
}

test.afterEach(() => {
  Module.prototype.require = __origRequire;
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('defaults: orderXml mode is OFF with empty folder list', () => {
  const cs = freshConfigService();
  const all = cs.getAll();
  assert.equal(all.orderXmlEnabled,         false);
  assert.equal(all.orderXmlAutoSyncMinutes, 1);
  assert.equal(all.orderXmlMaxRetries,      3);
  assert.deepEqual(all.orderXmlHotFolders,  []);
});

test('getEnabledHotFolders() returns [] when mode is disabled', () => {
  const cs = freshConfigService();
  assert.deepEqual(cs.getEnabledHotFolders(), []);
});

test('getHotFolderMaxRetries() falls back to global default', () => {
  const cs = freshConfigService();
  assert.equal(cs.getHotFolderMaxRetries(null),                3);
  assert.equal(cs.getHotFolderMaxRetries({}),                  3);
  assert.equal(cs.getHotFolderMaxRetries({ maxRetries: null }),3);
  assert.equal(cs.getHotFolderMaxRetries({ maxRetries: 7 }),   7);
  // Invalid overrides ignored.
  assert.equal(cs.getHotFolderMaxRetries({ maxRetries: 0 }),   3);
  assert.equal(cs.getHotFolderMaxRetries({ maxRetries: 99 }),  3);
});

// ---------------------------------------------------------------------------
// Save / round-trip
// ---------------------------------------------------------------------------

test('save+getAll round-trip preserves a valid enabled hot folder', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlEnabled: true,
    orderXmlAutoSyncMinutes: 5,
    orderXmlMaxRetries: 4,
    orderXmlHotFolders: [{
      id:              'hf-1',
      label:           'PhotoFinale F-11',
      enabled:         true,
      sourceFormat:    'photofinale',
      watchFolder:     'C:/lab/in',
      processedFolder: 'C:/lab/out',
      websiteCode:     'PPPF',
      maxRetries:      6,
    }],
  });

  const all = cs.getAll();
  assert.equal(all.orderXmlEnabled,         true);
  assert.equal(all.orderXmlAutoSyncMinutes, 5);
  assert.equal(all.orderXmlMaxRetries,      4);
  assert.equal(all.orderXmlHotFolders.length, 1);

  const stored = all.orderXmlHotFolders[0];
  assert.equal(stored.id,              'hf-1');
  assert.equal(stored.label,           'PhotoFinale F-11');
  assert.equal(stored.enabled,         true);
  assert.equal(stored.sourceFormat,    'photofinale');
  assert.equal(stored.watchFolder,     'C:/lab/in');
  assert.equal(stored.processedFolder, 'C:/lab/out');
  assert.equal(stored.websiteCode,     'PPPF');
  assert.equal(stored.maxRetries,      6);
});

test('save assigns a fresh id when missing', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlEnabled: true,
    orderXmlHotFolders: [{
      label: 'Auto-id Test', enabled: true, sourceFormat: 'photofinale',
      watchFolder: 'C:/a', processedFolder: 'C:/b',
    }],
  });
  const stored = cs.getAllHotFolders()[0];
  assert.ok(stored.id && stored.id.length >= 16, 'expected id to be populated');
});

test('getEnabledHotFolders() filters disabled rows', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlEnabled: true,
    orderXmlHotFolders: [
      { label: 'on',  enabled: true,  sourceFormat: 'photofinale', watchFolder: 'C:/a', processedFolder: 'C:/b' },
      { label: 'off', enabled: false, sourceFormat: 'photofinale', watchFolder: '',     processedFolder: '' }, // intentionally empty — disabled draft
    ],
  });
  const enabled = cs.getEnabledHotFolders();
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].label, 'on');
  // getAllHotFolders includes both
  assert.equal(cs.getAllHotFolders().length, 2);
});

test('getEnabledHotFolders() returns [] when mode toggle is OFF, even if rows are enabled', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlEnabled: false,
    orderXmlHotFolders: [
      { label: 'sleeping', enabled: true, sourceFormat: 'photofinale', watchFolder: 'C:/a', processedFolder: 'C:/b' },
    ],
  });
  assert.deepEqual(cs.getEnabledHotFolders(), []);
  // Row is still in the store though.
  assert.equal(cs.getAllHotFolders().length, 1);
});

// ---------------------------------------------------------------------------
// Validation rejections
// ---------------------------------------------------------------------------

test('save rejects an enabled row with no label', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlEnabled: true,
      orderXmlHotFolders: [{
        enabled: true, sourceFormat: 'photofinale',
        watchFolder: 'C:/a', processedFolder: 'C:/b',
      }],
    }),
    /requires a label/
  );
});

test('save rejects an enabled row with unknown sourceFormat', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlEnabled: true,
      orderXmlHotFolders: [{
        // 'dotphoto' was originally 'roes' — ROES is now a registered parser
        // (chunk 8), so pick another format that genuinely doesn't exist.
        label: 'X', enabled: true, sourceFormat: 'dotphoto',
        watchFolder: 'C:/a', processedFolder: 'C:/b',
      }],
    }),
    /unknown source format "dotphoto".*photofinale/i
  );
});

test('save rejects an enabled row with missing watchFolder', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlEnabled: true,
      orderXmlHotFolders: [{
        label: 'X', enabled: true, sourceFormat: 'photofinale',
        watchFolder: '', processedFolder: 'C:/b',
      }],
    }),
    /watch folder is required/
  );
});

test('save rejects an enabled row where watchFolder == processedFolder', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlEnabled: true,
      orderXmlHotFolders: [{
        label: 'X', enabled: true, sourceFormat: 'photofinale',
        watchFolder: 'C:/same', processedFolder: 'C:/same',
      }],
    }),
    /watch folder and processed folder must be different/
  );
});

test('save rejects an enabled row where one folder is nested inside the other', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlEnabled: true,
      orderXmlHotFolders: [{
        label: 'X', enabled: true, sourceFormat: 'photofinale',
        watchFolder: 'C:/parent', processedFolder: 'C:/parent/sub',
      }],
    }),
    /must not be nested inside each other/
  );
  assert.throws(
    () => cs.save({
      orderXmlEnabled: true,
      orderXmlHotFolders: [{
        label: 'Y', enabled: true, sourceFormat: 'photofinale',
        watchFolder: 'C:/parent/sub', processedFolder: 'C:/parent',
      }],
    }),
    /must not be nested inside each other/
  );
});

test('save rejects two enabled rows sharing a watchFolder', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlEnabled: true,
      orderXmlHotFolders: [
        { label: 'A', enabled: true, sourceFormat: 'photofinale', watchFolder: 'C:/in', processedFolder: 'C:/out-a' },
        { label: 'B', enabled: true, sourceFormat: 'photofinale', watchFolder: 'C:/in', processedFolder: 'C:/out-b' },
      ],
    }),
    /already used by "A"/
  );
});

test('save accepts disabled rows even with empty/invalid fields (operator drafts)', () => {
  const cs = freshConfigService();
  // No throw expected — disabled rows are kept verbatim for the operator.
  cs.save({
    orderXmlEnabled: true,
    orderXmlHotFolders: [
      { label: '', enabled: false, sourceFormat: '', watchFolder: '', processedFolder: '' },
    ],
  });
  const stored = cs.getAllHotFolders();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].enabled, false);
});

// ---------------------------------------------------------------------------
// Numeric coercion / clamping
// ---------------------------------------------------------------------------

test('save clamps autoSyncMinutes outside 1..60 by ignoring invalid values', () => {
  const cs = freshConfigService();
  cs.save({ orderXmlAutoSyncMinutes: 5 });
  assert.equal(cs.getAll().orderXmlAutoSyncMinutes, 5);

  cs.save({ orderXmlAutoSyncMinutes: 0 });
  assert.equal(cs.getAll().orderXmlAutoSyncMinutes, 5); // unchanged

  cs.save({ orderXmlAutoSyncMinutes: 200 });
  assert.equal(cs.getAll().orderXmlAutoSyncMinutes, 5); // unchanged
});

// ---------------------------------------------------------------------------
// Product mappings (Mode 4 — chunk 7b)
// ---------------------------------------------------------------------------

test('orderXmlProductMappings defaults to {} and round-trips a valid slice', () => {
  const cs = freshConfigService();
  assert.deepEqual(cs.getAll().orderXmlProductMappings, {});

  cs.save({
    orderXmlProductMappings: {
      photofinale: [
        { photoFinaleCode: '1082252', pixfizzCode: 'PX-5X7',  label: '5x7 Print' },
        { photoFinaleCode: '1082253', pixfizzCode: 'PX-8X10', label: '8x10 Print' },
      ],
    },
  });

  const stored = cs.getAll().orderXmlProductMappings;
  assert.equal(stored.photofinale.length, 2);
  assert.equal(stored.photofinale[0].photoFinaleCode, '1082252');
  assert.equal(stored.photofinale[0].pixfizzCode,     'PX-5X7');
  assert.equal(stored.photofinale[0].label,           '5x7 Print');
});

test('getProductMappingsFor returns a Map keyed by vendor code', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlProductMappings: {
      photofinale: [
        { photoFinaleCode: '1082252', pixfizzCode: 'PX-5X7',  label: '5x7 Print' },
      ],
    },
  });
  const map = cs.getProductMappingsFor('photofinale');
  assert.ok(map instanceof Map);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get('1082252'), { pixfizzCode: 'PX-5X7', label: '5x7 Print' });
});

test('getProductMappingsFor returns an empty Map for unknown / absent format', () => {
  const cs = freshConfigService();
  assert.equal(cs.getProductMappingsFor('roes').size,        0);
  assert.equal(cs.getProductMappingsFor('photofinale').size, 0);
  assert.equal(cs.getProductMappingsFor('').size,            0);
});

test('save drops entries with missing photoFinaleCode or pixfizzCode (operator drafts)', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlProductMappings: {
      photofinale: [
        { photoFinaleCode: '1082252', pixfizzCode: 'PX-5X7' },          // valid
        { photoFinaleCode: '',        pixfizzCode: 'PX-X' },             // dropped
        { photoFinaleCode: '1082253', pixfizzCode: '' },                 // dropped
        { photoFinaleCode: ' 1082254 ', pixfizzCode: ' PX-11X14 ' },    // valid (trimmed)
      ],
    },
  });
  const stored = cs.getAll().orderXmlProductMappings.photofinale;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].photoFinaleCode, '1082252');
  assert.equal(stored[1].photoFinaleCode, '1082254');
  assert.equal(stored[1].pixfizzCode,     'PX-11X14');
});

test('save defaults label to pixfizzCode when blank, so OrderHub never sees an empty product_name', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlProductMappings: {
      photofinale: [
        { photoFinaleCode: '1082252', pixfizzCode: 'PX-5X7' }, // no label
      ],
    },
  });
  const stored = cs.getAll().orderXmlProductMappings.photofinale;
  assert.equal(stored[0].label, 'PX-5X7');
});

test('save rejects duplicate photoFinaleCode within the same format', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlProductMappings: {
        photofinale: [
          { photoFinaleCode: '1082252', pixfizzCode: 'PX-5X7'  },
          { photoFinaleCode: '1082252', pixfizzCode: 'PX-OTHER' }, // dup
        ],
      },
    }),
    /vendor code "1082252" appears in row 1 and row 2/
  );
});

test('save drops slices keyed under unknown source formats', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlProductMappings: {
      photofinale: [{ photoFinaleCode: '1082252', pixfizzCode: 'PX-5X7' }],
      bogusformat: [{ photoFinaleCode: 'abc',     pixfizzCode: 'X' }],
    },
  });
  const stored = cs.getAll().orderXmlProductMappings;
  assert.ok(stored.photofinale);
  assert.equal('bogusformat' in stored, false);
});

// ---------------------------------------------------------------------------
// Customers — RetailerDealerCode → name/email directory
// ---------------------------------------------------------------------------

test('orderXmlCustomers defaults to empty array', () => {
  const cs = freshConfigService();
  assert.deepEqual(cs.getAll().orderXmlCustomers, []);
});

test('save round-trips a customer list and trims whitespace', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlCustomers: [
      { customerId: '  9052 ', customerName: ' F-11 Photo ', customerEmail: ' orders@f-11.com ' },
    ],
  });
  const stored = cs.getAll().orderXmlCustomers;
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], {
    customerId:    '9052',
    customerName:  'F-11 Photo',
    customerEmail: 'orders@f-11.com',
  });
});

test('save drops fully-blank draft rows but rejects partially-filled rows', () => {
  const cs = freshConfigService();
  // Fully blank row is dropped (no fields filled).
  cs.save({
    orderXmlCustomers: [
      { customerId: '9052', customerName: 'F-11', customerEmail: 'a@b.com' },
      { customerId: '',     customerName: '',     customerEmail: '' },
    ],
  });
  assert.equal(cs.getAll().orderXmlCustomers.length, 1);

  // Partially-filled row throws.
  assert.throws(
    () => cs.save({
      orderXmlCustomers: [
        { customerId: '9052', customerName: 'F-11', customerEmail: '' },
      ],
    }),
    /Customer ID, Name and Email are all required/
  );
});

test('save rejects malformed customer emails', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlCustomers: [
        { customerId: '9052', customerName: 'F-11', customerEmail: 'not-an-email' },
      ],
    }),
    /is not a valid email address/
  );
});

test('save rejects duplicate Customer IDs (case-insensitive)', () => {
  const cs = freshConfigService();
  assert.throws(
    () => cs.save({
      orderXmlCustomers: [
        { customerId: 'AB-9052', customerName: 'F-11', customerEmail: 'a@b.com' },
        { customerId: 'ab-9052', customerName: 'Other', customerEmail: 'c@d.com' },
      ],
    }),
    /appears in row 1 and row 2/
  );
});

test('getCustomerMap exposes a case-insensitive Map keyed by lowercase id', () => {
  const cs = freshConfigService();
  cs.save({
    orderXmlCustomers: [
      { customerId: '9052', customerName: 'F-11', customerEmail: 'orders@f-11.com' },
    ],
  });
  const map = cs.getCustomerMap();
  assert.ok(map instanceof Map);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get('9052'), {
    customerId:    '9052',
    customerName:  'F-11',
    customerEmail: 'orders@f-11.com',
  });
  // Stored key is lowercase — caller normalises lookups.
  assert.equal(map.get('9052').customerId, '9052');
});

test('getCustomerMap returns an empty Map when nothing is configured', () => {
  const cs = freshConfigService();
  assert.equal(cs.getCustomerMap().size, 0);
});
