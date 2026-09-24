const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeExperiment,
  diffExperiments,
  toNotifyExpDiff,
  assessCoverage,
  createExperimentFingerprint,
} = require('../src/lib/experiment_state');

test('added experiment', () => {
  const prev = [normalizeExperiment({ id: 'a', kind: 'guild', variations: { 0: {} } })];
  const cur = [
    normalizeExperiment({ id: 'a', kind: 'guild', variations: { 0: {} } }),
    normalizeExperiment({ id: 'b', kind: 'user', variations: { 0: {} } }),
  ];
  const d = diffExperiments(prev, cur, true, {});
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].id, 'b');
  assert.equal(d.removed.length, 0);
});

test('removed only when allowRemovals true', () => {
  const prev = [normalizeExperiment({ id: 'a', kind: 'guild', variations: { 0: {} } })];
  const cur = [];
  const blocked = diffExperiments(prev, cur, false, {});
  assert.equal(blocked.removed.length, 0);
  const allowed = diffExperiments(prev, cur, true, {});
  assert.equal(allowed.removed.length, 1);
  assert.equal(allowed.removed[0].id, 'a');
});

test('coverage unreliable blocks removals via assessCoverage', () => {
  const cov = assessCoverage({
    currentCount: 10,
    previousCount: 100,
    extractionStatus: 'complete',
  });
  assert.equal(cov.reliable, false);
  const prev = [normalizeExperiment({ id: 'a', kind: 'guild', variations: { 0: {} } })];
  const d = diffExperiments(prev, [], cov.reliable, {});
  assert.equal(d.removed.length, 0);
});

test('fingerprint change produces modified', () => {
  const a = normalizeExperiment({
    id: 'x',
    kind: 'guild',
    label: 'Old',
    variations: { 0: { n: 1 }, 1: { n: 2 } },
  });
  const b = normalizeExperiment({
    id: 'x',
    kind: 'guild',
    label: 'New',
    variations: { 0: { n: 1 }, 1: { n: 2 }, 2: { n: 3 } },
  });
  assert.notEqual(a.fingerprint, b.fingerprint);
  const d = diffExperiments([a], [b], true, {});
  assert.equal(d.modified.length, 1);
  assert.equal(d.categoryChanged.length, 0);
});

test('kind change is category_changed not modified', () => {
  const a = normalizeExperiment({
    id: 'x',
    kind: 'user',
    variations: { 0: {} },
  });
  const b = normalizeExperiment({
    id: 'x',
    kind: 'guild',
    variations: { 0: {} },
  });
  const d = diffExperiments([a], [b], true, {});
  assert.equal(d.categoryChanged.length, 1);
  assert.equal(d.modified.length, 0);
  assert.equal(d.categoryChanged[0].from, 'user');
  assert.equal(d.categoryChanged[0].to, 'guild');
});

test('unchanged fingerprint yields empty diff', () => {
  const a = normalizeExperiment({
    id: 'x',
    kind: 'guild',
    label: 'Same',
    variations: { 0: { a: 1 } },
  });
  const b = normalizeExperiment({
    id: 'x',
    kind: 'guild',
    label: 'Same',
    variations: { 0: { a: 1 } },
  });
  assert.equal(a.fingerprint, b.fingerprint);
  const d = diffExperiments([a], [b], true, {});
  assert.equal(d.added.length, 0);
  assert.equal(d.modified.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.categoryChanged.length, 0);
});

test('knownIds filters re-adds', () => {
  const cur = [normalizeExperiment({ id: 'new1', kind: 'user', variations: { 0: {} } })];
  const d = diffExperiments([], cur, true, { knownIds: new Set(['new1']) });
  assert.equal(d.added.length, 0);
});

test('toNotifyExpDiff flattens modified and category', () => {
  const a = normalizeExperiment({ id: 'x', kind: 'user', variations: { 0: {} } });
  const b = normalizeExperiment({ id: 'x', kind: 'guild', variations: { 0: {} } });
  const raw = diffExperiments([a], [b], true, {});
  const n = toNotifyExpDiff(raw);
  assert.equal(n.categoryChanged.length, 1);
  assert.equal(n.categoryChanged[0].id, 'x');
  assert.ok(n.categoryChanged[0].from === 'user');
});

test('createExperimentFingerprint is stable', () => {
  const e1 = { id: 'z', kind: 'guild', label: 'L', variations: { 1: {}, 0: {} } };
  const e2 = { id: 'z', kind: 'guild', label: 'L', variations: { 0: {}, 1: {} } };
  assert.equal(
    createExperimentFingerprint(normalizeExperiment(e1)),
    createExperimentFingerprint(normalizeExperiment(e2)),
  );
});

test('deep variation body change does NOT produce modified', () => {
  const a = normalizeExperiment({
    id: 'noise',
    kind: 'user',
    variations: { 0: { heavy: 'aaa' }, 1: { heavy: 'bbb' } },
  });
  const b = normalizeExperiment({
    id: 'noise',
    kind: 'user',
    variations: { 0: { heavy: 'zzz' }, 1: { heavy: 'yyy' } },
  });
  assert.equal(a.fingerprint, b.fingerprint);
  const d = diffExperiments([a], [b], true);
  assert.equal(d.modified.length, 0);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
});
