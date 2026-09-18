/**
 * Minimal unit checks (run: node test/extract.test.js)
 */
const assert = require('assert');
const {
  isGoodStringKey,
  isGoodStringVal,
  inferType,
} = require('../src/lib/extract');

assert.strictEqual(isGoodStringKey('5UxMLx'), true);
assert.strictEqual(isGoodStringKey('abcdef'), false);
assert.strictEqual(isGoodStringVal('Buy Nitro'), true);
assert.strictEqual(isGoodStringVal(''), false);
assert.strictEqual(inferType('2026-09-guild-members'), 'guild');
assert.strictEqual(inferType('2026-09-single-cpu-copy'), 'user');
console.log('extract.test.js OK');
