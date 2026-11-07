const test = require('node:test');
const assert = require('node:assert');
const { cmpSnowflake } = require('../src/x_watch');
const { trimRecent } = require('../src/lib/utils');

test('cmpSnowflake orders ids numerically across lengths', () => {
  const ids = ['1000000000000000000', '999999999999999999', '2073982489836584960'];
  assert.deepStrictEqual([...ids].sort(cmpSnowflake), ['999999999999999999', '1000000000000000000', '2073982489836584960']);
});

test('trimRecent keeps re-touched fingerprints', () => {
  const s = new Set(['a', 'b', 'c']);
  s.delete('a'); s.add('a');
  assert.deepStrictEqual(trimRecent(s, 2), ['c', 'a']);
});

test('safeIso never throws on malformed dates', () => {
  const { safeIso } = require('../src/lib/utils');
  assert.strictEqual(safeIso('not a date'), null);
  assert.strictEqual(safeIso(undefined, 'x'), 'x');
  assert.strictEqual(safeIso('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z');
});
