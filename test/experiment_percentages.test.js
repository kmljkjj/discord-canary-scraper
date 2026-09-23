const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeAudiencePercentage,
  calculateFromRanges,
  calculateFromPopulations,
} = require('../src/lib/experiment_percentages');
const { normalizeExperiment } = require('../src/lib/experiment_state');

test('provided percentage from root wins', () => {
  const r = computeAudiencePercentage({ kind: 'guild', percentage: 25 }, 'guild');
  assert.equal(r.status, 'provided');
  assert.equal(r.value, 25);
});

test('provided rate 0-1 becomes percent', () => {
  const r = computeAudiencePercentage({ kind: 'user', rate: 0.4 }, 'user');
  assert.equal(r.status, 'provided');
  assert.equal(r.value, 40);
});

test('user experiment leaves guild unknown', () => {
  const r = computeAudiencePercentage({ kind: 'user', percentage: 50 }, 'guild');
  assert.equal(r.status, 'unknown');
  assert.equal(r.value, null);
});

test('guild experiment leaves user unknown', () => {
  const r = computeAudiencePercentage({ kind: 'guild', percentage: 50 }, 'user');
  assert.equal(r.status, 'unknown');
  assert.equal(r.value, null);
});

test('calculated from populations', () => {
  const pct = calculateFromPopulations({
    0: { enabled: 25, total: 100 },
    1: { enabled: 25, total: 100 },
  });
  assert.equal(pct, 25);
  const r = computeAudiencePercentage(
    {
      kind: 'guild',
      variations: {
        0: { enabled: 50, total: 100 },
        1: { enabled: 0, total: 100 },
      },
    },
    'guild',
  );
  assert.equal(r.status, 'calculated');
  assert.equal(r.value, 25);
});

test('incomplete populations stay unknown', () => {
  const r = computeAudiencePercentage(
    {
      kind: 'guild',
      variations: {
        0: { enabled: 10, total: 100 },
        1: { id: 1 },
      },
    },
    'guild',
  );
  assert.equal(r.status, 'unknown');
});

test('calculated from bucket ranges 0-10000', () => {
  const pct = calculateFromRanges({
    0: { start: 0, end: 2500 },
    1: { start: 2500, end: 5000 },
  });
  assert.equal(pct, 50);
});

test('out of range percentage becomes unknown', () => {
  const r = computeAudiencePercentage({ kind: 'guild', percentage: 150 }, 'guild');
  assert.equal(r.status, 'unknown');
});

test('provided beats calculated', () => {
  const r = computeAudiencePercentage(
    {
      kind: 'guild',
      percentage: 12.5,
      variations: { 0: { enabled: 99, total: 100 } },
    },
    'guild',
  );
  assert.equal(r.status, 'provided');
  assert.equal(r.value, 12.5);
});

test('normalizeExperiment attaches both percentage fields', () => {
  const e = normalizeExperiment({
    id: '2024-01_test_exp',
    kind: 'guild',
    percentage: 33,
    variations: { 0: { id: 0 } },
  });
  assert.equal(e.guildPercentage.status, 'provided');
  assert.equal(e.guildPercentage.value, 33);
  assert.equal(e.userPercentage.status, 'unknown');
  assert.ok(e.fingerprint);
});

test('equal variation count alone is not calculated', () => {
  const r = computeAudiencePercentage(
    {
      kind: 'user',
      variations: { 0: { id: 0 }, 1: { id: 1 } },
    },
    'user',
  );
  assert.equal(r.status, 'unknown');
});
