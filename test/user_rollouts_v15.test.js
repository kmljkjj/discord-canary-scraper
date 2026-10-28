/**
 * Tests V15 — mesure EXACTE des plages user (positions recalculées pour
 * tous les échantillons, positifs ET négatifs).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferExactRanges, snapBoundary } = require('../src/lib/exact_ranges');
const {
  sampleRecord,
  userPosition,
  exactForExperiment,
  buildWindowTreatments,
} = require('../src/user_rollouts');

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('snapBoundary préfère les valeurs rondes', () => {
  assert.equal(snapBoundary(497, 503), 500);
  assert.equal(snapBoundary(9498, 9502), 9500);
  assert.equal(snapBoundary(1234, 1236), 1235);
});

test('inferExactRanges retrouve des plages exactes', () => {
  const r = rng(1);
  const pts = [];
  for (let i = 0; i < 3000; i++) {
    const p = Math.floor(r() * 10000);
    pts.push({ pos: p, label: p < 500 ? 1 : p >= 2000 && p < 2600 ? 2 : -99 });
  }
  const res = inferExactRanges(pts);
  assert.equal(res.ok, true);
  assert.deepEqual(res.ranges['1'], [[0, 500]]);
  assert.deepEqual(res.ranges['2'], [[2000, 2600]]);
  assert.equal(res.pct['1'], 5);
  assert.equal(res.pct['2'], 6);
});

test('inferExactRanges signale un rollout filtré (points contradictoires)', () => {
  const r = rng(2);
  const pts = [];
  for (let i = 0; i < 2000; i++) {
    const p = Math.floor(r() * 10000);
    // plage [0,5000) mais 1 échantillon sur 4 filtré (plateforme…)
    pts.push({ pos: p, label: p < 5000 && i % 4 !== 0 ? 1 : -99 });
  }
  assert.equal(inferExactRanges(pts).ok, false);
});

test('inferExactRanges : < 20 points → null', () => {
  assert.equal(inferExactRanges([{ pos: 1, label: 1 }]), null);
});

test('sampleRecord extrait fingerprint et assignments valides', () => {
  const rec = sampleRecord('1565016717283823826.abc', [[2180379513, 0, 1, -1, 4, 5072], [1, 0, 1, -1, 0, 99999]], 5);
  assert.deepEqual(rec, { f: '1565016717283823826', t: 5, a: { '2180379513': [1, 5072] } });
  assert.equal(sampleRecord('bad', [], 1), null);
});

test('userPosition = hash_result Discord (valeur réelle observée)', () => {
  // Réponse réelle /experiments : [2180379513, 0, 1, -1, 4, 6916, ...]
  // pour le fingerprint 1565016717283823826 (2023-09_iar_user_reporting).
  assert.equal(userPosition('2023-09_iar_user_reporting', '1565016717283823826'), 6916);
});

function fakeSamples(id, hash, n, inRange, seed) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = String(10n ** 18n + BigInt(Math.floor(r() * 1e15)));
    const pos = userPosition(id, f);
    const a = {};
    if (inRange(pos)) a[String(hash)] = [1, pos];
    out.push({ f, t: 1000 + i, a });
  }
  return out;
}

test('exactForExperiment : plage [0,1500) → 15 % exact', () => {
  const s = fakeSamples('test_exp', 42, 2500, (p) => p < 1500, 3);
  const ex = exactForExperiment('test_exp', 42, s, 0);
  assert.equal(ex.ok, true);
  assert.deepEqual(ex.ranges['1'], [[0, 1500]]);
  assert.equal(ex.pct['1'], 15);
  const k = s.filter((x) => x.a['42']).length;
  const out = buildWindowTreatments(new Map([[1, k]]), s.length, {}, ex);
  assert.equal(out.status, 'exact');
  assert.equal(out.treatments[0].pct, 15);
  assert.equal(out.treatments[0].sourceKind, 'exact_ranges');
});

test('exactForExperiment : hash_result incohérent → null (repli k/n)', () => {
  const s = fakeSamples('test_exp', 42, 200, (p) => p < 5000, 4);
  for (const x of s) if (x.a['42']) x.a['42'][1] = (x.a['42'][1] + 1) % 10000;
  assert.equal(exactForExperiment('test_exp', 42, s, 0), null);
});

test('exactForExperiment : expérience sans nom → null', () => {
  assert.equal(exactForExperiment('hash:42', 42, [], 0), null);
});

test('exactForExperiment : échantillons antérieurs au changement de revision ignorés', () => {
  const s = fakeSamples('test_exp', 42, 1000, (p) => p < 1000, 5);
  const ex = exactForExperiment('test_exp', 42, s, 1000 + 500);
  assert.equal(ex.points, 500);
});
