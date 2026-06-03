/**
 * Unit tests for src/main/services/order-xml-parsers/index.js (the registry).
 *
 * Run via:
 *   npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../order-xml-parsers');
const photoFinale = require('../order-xml-parsers/photo-finale');

test('list() includes the registered parsers', () => {
  const items = registry.list();
  assert.ok(Array.isArray(items));
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('photofinale'));
  assert.ok(ids.includes('roes'));
  // Each entry has a label suitable for the settings dropdown.
  for (const item of items) {
    assert.equal(typeof item.id,    'string');
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
  }
});

test('get() returns the registered parser module', () => {
  const parser = registry.get('photofinale');
  assert.equal(parser, photoFinale);
  assert.equal(parser.id, 'photofinale');
  assert.equal(typeof parser.parse, 'function');
});

test('get() throws a useful error on unknown ids', () => {
  assert.throws(
    () => registry.get('dotphoto'),
    (err) => {
      assert.match(err.message, /Unknown order-xml parser id "dotphoto"/);
      // Mentions what IS available so the operator can fix their config.
      assert.match(err.message, /available:.*photofinale/);
      return true;
    }
  );
});

test('has() reports membership without throwing', () => {
  assert.equal(registry.has('photofinale'), true);
  assert.equal(registry.has('dotphoto'),    false);
  assert.equal(registry.has(''),            false);
  assert.equal(registry.has(null),          false);
});

test('detect() identifies a PhotoFinale snippet', () => {
  const snippet = '<?xml version="1.0"?><OrderDataSet xmlns="http://www.trevoli.com/OrderDataSet.xsd"><Order/></OrderDataSet>';
  const parser = registry.detect(snippet);
  assert.ok(parser);
  assert.equal(parser.id, 'photofinale');
});

test('detect() returns null for unrelated XML', () => {
  assert.equal(registry.detect('<RoesOrder/>'),                                     null);
  assert.equal(registry.detect('<OrderDataSet xmlns="http://example.com/Other"/>'), null);
  assert.equal(registry.detect(null),                                               null);
});
