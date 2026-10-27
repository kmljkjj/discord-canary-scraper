/**
 * Tests V14 — user rollouts : fenêtre unifiée, revisions, acknowledged,
 * validation du wire, estimation k/n + Wilson + bornes indicatives.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  windowAggregate,
  pruneWindow,
  buildNextWindow,
  buildWindowTreatments,
  ackSnapshot,
  recordAssignments,
} = require('../src/user_rollouts');
const {
  mergeIntervalsHalfOpen,
  mergeIntervals,
  rangesPercentExclusive,
  wilsonPctInterval,
  slidingWindowDeltaMargin,
  reconstructBucketRanges,
  noiseMargin,
} = require('../src/lib/rollout_math');
const { intervalsToPct } = require('../src/lib/guild_decode');

const NOW = 1_800_000_000_000;

function batch(bid, ts, ok, c, rev) {
  return { bid, ts, ok, rev: rev || {}, c };
}

// ─── Bug V13 #1 : notifications perdues après échec de webhook ───────────────
//
// Avant : l'état était sauvé AVANT l'envoi ; au run suivant le fingerprint
// de l'expérience avait déjà changé → le changement n'était plus détecté.
// V14 : acknowledged (dernier état notifié) fait office de baseline.

test('ackSnapshot extrait {bucket: pct} du dernier état notifié', () => {
  const snap = ackSnapshot({
    treatments: [
      { bucket: -1, pctKnown: true, pct: 95 },
      { bucket: 1, pctKnown: true, pct: 5 },
      { bucket: 2, pctKnown: false, pct: null },
    ],
  });
  assert.deepEqual(snap, { '-1': 95, '1': 5 });
});

test('ackSnapshot ignore les entrées sans pct', () => {
  assert.deepEqual(ackSnapshot({ treatments: [{ bucket: 3 }] }), {});
  assert.deepEqual(ackSnapshot(null), {});
});

// ─── Bug V13 #2 : dénominateur incohérent entre runs ─────────────────────────
//
// Avant : le hash absent du batch courant n'avait pas le ok du run dans son
// n, alors que la fenêtre du run suivant le compterait. V14 : l'agrégation se
// fait TOUJOURS sur la fenêtre complète (batches précédents + batch courant).

test('fenêtre unifiée : le hash absent du dernier batch garde tout le ok', () => {
  const win = {
    batches: [
      batch('b1', NOW - 60000, 100, { '111': { '1': 8 } }, { '111': 5 }),
      batch('b2', NOW - 30000, 100, {}, {}),
    ],
  };
  const { winCounts, winN } = windowAggregate(win);
  assert.equal(winN.get(111), 200);
  assert.equal(winCounts.get(111).get(1), 8);
});

test('fenêtre unifiée : le batch courant compte pour les hash déjà connus', () => {
  // hash découvert au batch 1, absent du batch 2, présent au batch 3.
  const win = {
    batches: [
      batch('b1', NOW - 90000, 100, { '111': { '1': 8 } }, { '111': 5 }),
      batch('b2', NOW - 60000, 100, {}, {}),
      batch('b3', NOW - 30000, 100, { '111': { '1': 6 } }, { '111': 5 }),
    ],
  };
  const { winCounts, winN } = windowAggregate(win);
  assert.equal(winN.get(111), 300);
  assert.equal(winCounts.get(111).get(1), 14);
});

test('pruneWindow jette les batches hors fenêtre et normalise', () => {
  const raw = {
    batches: [
      batch('old', NOW - 10 * 3600 * 1000, 50, { '1': { '1': 5 } }),
      batch('b1', NOW - 1000, 50, { '1': { '1': 5 } }),
    ],
    pos: { '1': { '1': Array.from({ length: 400 }, (_, i) => i) } },
  };
  const w = pruneWindow(raw, NOW);
  assert.equal(w.batches.length, 1);
  assert.equal(w.batches[0].bid, 'b1');
  assert.ok(w.pos['1']['1'].length <= 150); // RING_CAP
});

// ─── Revisions : un rollout reconfiguré repart de zéro ──────────────────────

test('changement de revision remet à zéro l\'historique du hash', () => {
  const win = {
    batches: [
      batch('b1', NOW - 90000, 100, { '111': { '1': 8 } }, { '111': 5 }),
      batch('b2', NOW - 60000, 100, { '111': { '1': 6 } }, { '111': 5 }),
      batch('b3', NOW - 30000, 100, { '111': { '2': 50 } }, { '111': 6 }),
    ],
  };
  const { winCounts, winN } = windowAggregate(win);
  // Seul le batch 3 (revision 6) compte.
  assert.equal(winN.get(111), 100);
  assert.equal(winCounts.get(111).get(2), 50);
  assert.equal(winCounts.get(111).get(1), undefined);
});

// ─── Validation du wire ───────────────────────────────────────────────────────

test('recordAssignments valide bucket, position et doublons', () => {
  const byHash = new Map();
  const byRev = new Map();
  const n = recordAssignments(byHash, byRev, [
    [111, 5, 1, -1, 1, 8280, 0, 0, null, null, null], // ok
    [111, 5, 1, -1, 1, 9999, 0, 0, null, null, null], // doublon du même hash → ignoré
    [222, 3, 1.5, -1, 1, 100, 0, 0, null, null, null], // bucket non entier → ignoré
    [333, 3, 1, -1, 1, 10000, 0, 0, null, null, null], // position hors espace → ignoré
    [444, 3, -1, -1, 1, 42, 0, 0, null, null, null], // bucket -1 (None) → ok
    [555, null, 1, -1, 1, 50, 0, 0, null, null, null], // sans revision → ok, pas de rev
    [777, 'x', 1, -1, 1, 60, 0, 0, null, null, null], // revision non numérique → ok, pas de rev
    ['pas-un-hash', 3, 1, -1, 1, 50], // hash invalide → ignoré
    [666, 3, 1], // tuple trop court → ignoré
  ]);
  assert.equal(n, 4);
  assert.equal(byHash.size, 4);
  assert.equal(byHash.get(111).get(1).length, 1);
  assert.equal(byHash.get(444).get(-1)[0], 42);
  assert.equal(byHash.get(555).get(1)[0], 50);
  assert.equal(byRev.get(111), 5);
  assert.ok(!byRev.has(555));
});

test('recordAssignments ignore une réponse sans assignments', () => {
  const byHash = new Map();
  const byRev = new Map();
  assert.equal(recordAssignments(byHash, byRev, []), 0);
  assert.equal(recordAssignments(byHash, byRev, null), 0);
  assert.equal(byHash.size, 0);
});

// ─── Estimation : k/n + Wilson + bornes indicatives ──────────────────────────

test('buildWindowTreatments : pct k/n, Wilson CI, bornes indicatives', () => {
  const counts = new Map([[1, 29]]);
  const ring = {
    '1': [9513, 9525, 9534, 9568, 9578, 9630, 9649, 9660, 9681, 9700, 9721,
      9744, 9768, 9776, 9783, 9790, 9800, 9824, 9863, 9894, 9922, 9945, 9960],
  };
  const { treatments, status } = buildWindowTreatments(counts, 399, ring);
  assert.equal(status, 'estimated');
  const t = treatments[0];
  // k/n = 29/399 = 7,27 %
  assert.ok(Math.abs(t.pct - 7.27) < 0.02);
  // Wilson : contient k/n
  assert.ok(t.ci.lo < 7.27 && t.ci.hi > 7.27);
  // Bornes reconstruites (indicatives) : la vraie plage est [9500, 10000)
  // → 5 % ; l'estimation doit s'en approcher nettement mieux que k/n.
  assert.ok(t.ranges.length >= 1);
  assert.ok(t.indicativePct != null);
  assert.ok(Math.abs(t.indicativePct - 5) < 1.5, 'indicative ~5, obtenu ' + t.indicativePct);
  assert.equal(t.pctKnown, true);
  assert.ok(t.ci.sigma > 0);
});

test('buildWindowTreatments : Wilson couvre les extrêmes k=0 et k=n', () => {
  const { treatments } = buildWindowTreatments(new Map([[1, 0]]), 100, {});
  // 0 échantillon → pas de traitement
  assert.equal(treatments.length, 0);

  const full = buildWindowTreatments(new Map([[1, 100]]), 100, {
    '1': [5, 150, 900, 5000, 9800],
  });
  assert.ok(Math.abs(full.treatments[0].pct - 100) < 0.01);
  assert.ok(full.treatments[0].ci.hi <= 100);
});

// ─── Marge de bruit exacte au niveau batch ──────────────────────────────────

test('slidingWindowDeltaMargin : fenêtres identiques → marge nulle', () => {
  const b = [batch('b1', NOW, 100, { '1': { '1': 5 } }), batch('b2', NOW + 1, 100, { '1': { '1': 6 } })];
  assert.equal(slidingWindowDeltaMargin(b, b, 5, 2), 0);
});

test('slidingWindowDeltaMargin : fenêtres partagées < fenêtres disjointes', () => {
  const b1 = [batch('a', NOW, 100), batch('b', NOW + 1, 100)];
  const b2 = [batch('b', NOW + 1, 100), batch('c', NOW + 2, 100)];
  const disjoint = [batch('d', NOW + 3, 100), batch('e', NOW + 4, 100)];
  const shared = slidingWindowDeltaMargin(b1, b2, 10, 2);
  const indep = slidingWindowDeltaMargin(b1, disjoint, 10, 2);
  assert.ok(shared > 0);
  assert.ok(shared < indep);
});

test('slidingWindowDeltaMargin : cohérente avec la formule indépendante', () => {
  const oldB = [batch('a', NOW, 150)];
  const newB = [batch('x', NOW + 1, 150)];
  const m = slidingWindowDeltaMargin(oldB, newB, 10, 2);
  const expected = noiseMargin(10, 150, 2);
  assert.ok(Math.abs(m - expected) < 0.05, m + ' vs ' + expected);
});

// ─── Fusion demi-ouverte : le trou n'est plus rempli ─────────────────────────

test('mergeIntervalsHalfOpen : [0,1)+[2,3) restent séparés', () => {
  const merged = mergeIntervalsHalfOpen([
    [0, 1],
    [2, 3],
  ]);
  assert.equal(merged.length, 2);
});

test('mergeIntervalsHalfOpen : [0,1)+[1,3) fusionnent', () => {
  const merged = mergeIntervalsHalfOpen([
    [0, 1],
    [1, 3],
  ]);
  assert.deepEqual(merged, [[0, 3]]);
});

test('mergeIntervalsHalfOpen : plages qui se chevauchent', () => {
  const merged = mergeIntervalsHalfOpen([
    [0, 10],
    [5, 15],
  ]);
  assert.deepEqual(merged, [[0, 15]]);
});

test('rangesPercentExclusive ne remplit plus les trous (régression V13)', () => {
  // Avant : la fusion inclusive transformait [0,1)+[2,3) en [0,3) → 0,03 %.
  assert.equal(rangesPercentExclusive([[0, 1], [2, 3]]), 0.02);
  assert.equal(rangesPercentExclusive([[0, 1], [1, 3]]), 0.03);
  assert.equal(rangesPercentExclusive([[0, 1500], [3000, 4000], [5000, 7500]]), 50);
});

test('mergeIntervals (points observés) garde la sémantique inclusive', () => {
  assert.deepEqual(mergeIntervals([[0, 10], [11, 20]]), [[0, 20]]);
});

test('intervalsToPct (guild_decode) : plages qui se chevauchent ne comptent plus double', () => {
  // [0,5000) et [2500,7500) → union = 75 %, pas 100 %.
  assert.equal(intervalsToPct([{ s: 0, e: 5000 }, { s: 2500, e: 7500 }]), 75);
  assert.equal(intervalsToPct([{ s: 0, e: 10000 }, { s: 0, e: 10000 }]), 100);
});

// ─── Wilson CI ────────────────────────────────────────────────────────────────

test('wilsonPctInterval : propriétés de base', () => {
  const mid = wilsonPctInterval(50, 100, 2);
  assert.ok(mid.lo < 50 && mid.hi > 50);
  const zero = wilsonPctInterval(0, 100, 2);
  assert.ok(zero.lo <= 0.1);
  assert.ok(zero.hi > 0 && zero.hi < 5);
  const all = wilsonPctInterval(100, 100, 2);
  assert.ok(all.hi > 99 && all.hi <= 100);
  assert.ok(all.lo > 95);
  const empty = wilsonPctInterval(0, 0, 2);
  assert.deepEqual(empty, { lo: 0, hi: 100, sigma: 100 });
});

// ─── Reconstruction de bornes (indicative, modèle ordre-statistiques) ───────

test('reconstructBucketRanges : plage haute [9500,10000) → ~5 %', () => {
  const pts = [9513, 9525, 9534, 9568, 9578, 9630, 9649, 9660, 9681, 9700,
    9721, 9744, 9768, 9776, 9783, 9790, 9800, 9824, 9863, 9894, 9922, 9945, 9960];
  const rec = reconstructBucketRanges(pts);
  assert.ok(rec, 'assez de points');
  assert.equal(rec.clusters, 1);
  assert.ok(rec.ranges[0][0] <= 9500 + 120, 'borne basse proche de 9500 : ' + rec.ranges[0][0]);
  assert.ok(rec.ranges[0][1] >= 9980, 'borne haute proche de 10000 : ' + rec.ranges[0][1]);
  assert.ok(Math.abs(rec.pct - 5) < 1, 'pct ~5, obtenu ' + rec.pct);
  assert.ok(rec.ci > 0 && rec.ci < 2);
  assert.equal(rec.status, 'indicative');
});

test('reconstructBucketRanges : plage basse [0,500) → ~5 %', () => {
  const pts = [11, 26, 27, 89, 103, 138, 141, 198, 205, 240, 247, 265, 270,
    275, 277, 284, 313, 418, 422, 430, 474, 479, 496];
  const rec = reconstructBucketRanges(pts);
  assert.ok(rec);
  assert.ok(Math.abs(rec.pct - 5) < 1.2, 'pct ~5, obtenu ' + rec.pct);
});

test('reconstructBucketRanges : plages fragmentées → deux clusters', () => {
  const pts = [
    ...[20, 45, 80, 110, 150, 190, 240, 270], // [0, 300)
    ...[5010, 5060, 5120, 5180, 5230, 5270], // [5000, 5300)
  ];
  const rec = reconstructBucketRanges(pts);
  assert.equal(rec.clusters, 2);
  assert.equal(rec.ranges.length, 2);
  assert.ok(Math.abs(rec.pct - 6) < 1.5, 'pct ~6, obtenu ' + rec.pct);
});

test('reconstructBucketRanges : couverture totale → ~100 %', () => {
  // 39 points régulièrement espacés sur tout l'espace 0–9999.
  const pts = Array.from({ length: 39 }, (_, i) => i * 257);
  const rec = reconstructBucketRanges(pts);
  assert.ok(rec.pct > 95, 'pct ~100, obtenu ' + rec.pct);
});

test('reconstructBucketRanges : moins de 3 points → null', () => {
  assert.equal(reconstructBucketRanges([5, 10]), null);
  assert.equal(reconstructBucketRanges([]), null);
  assert.equal(reconstructBucketRanges(null), null);
});

test('reconstructBucketRanges : ignore les positions hors espace', () => {
  const rec = reconstructBucketRanges([100, 200, 300, -5, 10500, NaN]);
  assert.ok(rec);
  assert.equal(rec.m, 3);
});

// ─── buildNextWindow : identifiant unique de batch ───────────────────────────

test('buildNextWindow ajoute le batch courant avec bid unique', () => {
  const win = pruneWindow({ batches: [batch('b1', NOW - 1000, 50, { '1': { '1': 5 } })] }, NOW);
  const cur = new Map([[1, new Map([[1, 5]])]]);
  const revs = new Map([[1, 7]]);
  const w1 = buildNextWindow(win, cur, revs, 60, NOW);
  const w2 = buildNextWindow(pruneWindow(w1, NOW + 1), cur, revs, 60, NOW + 1);
  assert.equal(w1.batches.length, 2);
  assert.ok(w1.batches[1].bid);
  assert.notEqual(w1.batches[1].bid, w2.batches[2].bid);
  assert.equal(w1.batches[1].rev['1'], 7);
});
