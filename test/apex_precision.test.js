'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rangesToPct } = require('../src/apex_rollouts.js');

test('rangesToPct : précision 0,01 pt (1 position / 10000)', () => {
  assert.strictEqual(rangesToPct([{ s: 0, e: 1 }]), 0.01);
  assert.strictEqual(rangesToPct([{ s: 0, e: 1234 }]), 12.34);
  assert.strictEqual(rangesToPct([{ s: 0, e: 500 }, { s: 400, e: 1000 }]), 10);
  assert.strictEqual(rangesToPct([{ s: 0, e: 10000 }]), 100);
});
