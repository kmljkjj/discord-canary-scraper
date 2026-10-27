/**
 * Tests V15 — user rollouts : plages exactes (range_recon), vérification du
 * fingerprint, positions « outside », double mesure % plages + contre-vérif
 * k/n, signature de reconfiguration dans l'empreinte.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWindowTreatments,
  fingerprintOf,
  verifyPositions,
  recordOutsidePositions,
  localPos,
} = require('../src/user_rollouts');
const { murmur3 } = require('../src/lib/murmur3');

/** PRNG déterministe (les positions murmur3 de vrais fingerprints sont
 * uniformes ; on simule ce tirage uniforme de façon reproductible). */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── localPos / verifyPositions : formule murmur3(nom:fp) % 10000 ────────────

const NAME = '2026-01_v15_unit_test_xp';
const HASH = murmur3(NAME);

test('localPos : murmur3(nom + ":" + fp) % 10000', () => {
  const fp = '123456.1234567890';
  assert.equal(localPos(NAME, fp), murmur3(NAME + ':' + fp) % 10000);
});

test('verifyPositions : formule correcte → tried/matched', () => {
  const defs = new Map([[HASH, { id: NAME, type: 'user' }]]);
  const fp = '424242.0000000001';
  const pos = murmur3(NAME + ':' + fp) % 10000;
  const responses = [
    { fp, assignments: [[HASH, 3, 1, -1, 1, pos, 0, 0, null, null, null]] },
  ];
  const v = verifyPositions(responses, defs);
  assert.equal(v.tried, 1);
  assert.equal(v.matched, 1);
});

test('verifyPositions : position incohérente → pas matched', () => {
  const defs = new Map([[HASH, { id: NAME }]]);
  const v = verifyPositions(
    [{ fp: '424242.0000000001', assignments: [[HASH, 3, 1, -1, 1, 123, 0, 0, null, null, null]] }],
    defs,
  );
  assert.equal(v.tried, 1);
  assert.equal(v.matched, 0);
});

test('verifyPositions : hash sans nom (hash:…) → ignoré', () => {
  const defs = new Map([[HASH, { id: 'hash:' + HASH }]]);
  const v = verifyPositions(
    [{ fp: '1.1', assignments: [[HASH, 3, 1, -1, 1, 5, 0, 0, null, null, null]] }],
    defs,
  );
  assert.equal(v.tried, 0);
  assert.equal(v.matched, 0);
});

// ─── recordOutsidePositions : positions non enrôlées sous clé « o » ─────────

test('recordOutsidePositions : non enrôlé → clé o, position locale', () => {
  const defs = new Map([[HASH, { id: NAME }]]);
  const byHash = new Map([[HASH, new Map([[1, [100, 200]]])]]);
  const fp = '777777.7777777777';
  const added = recordOutsidePositions(
    byHash,
    [
      {
        fp,
        // Le hash 42 est enrôlé ; HASH ne l'est pas dans cette réponse.
        assignments: [[42, 3, 2, -1, 1, 10, 0, 0, null, null, null]],
      },
    ],
    defs,
  );
  assert.equal(added, 1);
  assert.deepEqual(byHash.get(HASH).get('o'), [murmur3(NAME + ':' + fp) % 10000]);
  assert.deepEqual(byHash.get(HASH).get(1), [100, 200]);
});

test('recordOutsidePositions : hash présent dans la réponse → pas de o', () => {
  const defs = new Map([[HASH, { id: NAME }]]);
  const byHash = new Map([[HASH, new Map([[1, [100]]])]]);
  const added = recordOutsidePositions(
    byHash,
    [{ fp: '5.5', assignments: [[HASH, 3, 1, -1, 1, 7, 0, 0, null, null, null]] }],
    defs,
  );
  assert.equal(added, 0);
  assert.ok(!byHash.get(HASH).has('o'));
});

test('recordOutsidePositions : expérience jamais observée enrôlée → ignorée', () => {
  const defs = new Map([[HASH, { id: NAME }]]);
  const byHash = new Map(); // HASH absent → pas encore mesurée
  const added = recordOutsidePositions(
    byHash,
    [{ fp: '5.5', assignments: [[42, 3, 1, -1, 1, 7, 0, 0, null, null, null]] }],
    defs,
  );
  assert.equal(added, 0);
});

// ─── buildWindowTreatments v15 : plages EXACTES, % plages + k/n ──────────────

// Config de test (multiples de 25) :
//   bucket -1 : [0,1000) + [4000,10000) → 70 %
//   bucket  1 : [1000,2500)             → 15 %
//   bucket  2 : [2500,4000)            → 15 %
// Tout l'espace est enrôlé (pas de « o ») : reconstruction bout-en-bout.
function simulateEnrolled(n, seed) {
  const rnd = mulberry32(seed);
  const b = { '-1': [], '1': [], '2': [] };
  const label = (p) => (p < 1000 ? -1 : p < 2500 ? 1 : p < 4000 ? 2 : -1);
  for (let i = 0; i < n; i++) {
    const p = Math.floor(rnd() * 10000);
    b[String(label(p))].push(p);
  }
  return b;
}

test('v15 : plages exactes reconstruites → pct des plages + k/n en contre-vérif', () => {
  const N = 3000;
  const b = simulateEnrolled(N, 1234);
  const counts = new Map([
    [-1, b['-1'].length],
    [1, b['1'].length],
    [2, b['2'].length],
  ]);
  const { treatments, status } = buildWindowTreatments(counts, N, { rev: 9, b });
  assert.equal(status, 'estimated');
  assert.equal(treatments.length, 3);

  const t1 = treatments.find((t) => t.bucket === 1);
  assert.equal(t1.pctSource, 'ranges', 'le % vient des plages exactes');
  assert.equal(t1.rangesQuality, 'exact');
  assert.deepEqual(t1.ranges, [[1000, 2500]]);
  assert.equal(t1.pct, 15);
  assert.ok(Math.abs(t1.knPct - 15) <= 1, 'k/n ≈ 15, obtenu ' + t1.knPct);
  assert.ok((t1.rangesConfidence ?? 0) >= 0.9, 'confiance ' + t1.rangesConfidence);

  const t2 = treatments.find((t) => t.bucket === 2);
  assert.equal(t2.pctSource, 'ranges');
  assert.deepEqual(t2.ranges, [[2500, 4000]]);
  assert.equal(t2.pct, 15);

  const tC = treatments.find((t) => t.bucket === -1);
  assert.equal(tC.pctSource, 'ranges');
  assert.deepEqual(tC.ranges, [[0, 1000], [4000, 10000]]);
  assert.equal(tC.pct, 70);
});

test('v15 : sans positions de ring → repli k/n binomial, pas de plages', () => {
  const { treatments } = buildWindowTreatments(new Map([[1, 30]]), 200, { rev: 1, b: {} });
  const t = treatments[0];
  assert.equal(t.pctSource, 'binomial');
  assert.equal(t.rangesQuality, null);
  assert.equal(t.ranges.length, 0);
  assert.ok(Math.abs(t.pct - 15) < 0.01);
});

test('v15 : plages contradictoires avec k/n → jamais présentées comme exactes', () => {
  // Anneau qui prétend [0,7000) pour le bucket 1 mais k/n = 50 %.
  const rnd = mulberry32(77);
  const pos = [];
  for (let i = 0; i < 400; i++) pos.push(Math.floor(rnd() * 7000));
  const { treatments } = buildWindowTreatments(new Map([[1, 100]]), 200, {
    rev: 2,
    b: { '1': pos },
  });
  const t = treatments[0];
  assert.equal(t.pctSource, 'binomial', 'k/n reste la mesure publiée');
  assert.notEqual(t.rangesQuality, 'exact');
});

// ─── fingerprintOf : une reconfiguration des plages change l'empreinte ───────

test('fingerprintOf : signature des plages exactes → reconfiguration détectée', () => {
  const base = {
    bucket: 1, pctKnown: true, pct: 15, confidence: 'high', status: 'estimated',
  };
  const a = fingerprintOf([{ ...base, rangesQuality: 'exact', ranges: [[1000, 2500]] }]);
  const b = fingerprintOf([{ ...base, rangesQuality: 'exact', ranges: [[500, 2000]] }]);
  assert.notEqual(a, b, 'mêmes % mais plages différentes → annonce');
  // Mêmes plages → même empreinte.
  const c = fingerprintOf([{ ...base, rangesQuality: 'exact', ranges: [[1000, 2500]] }]);
  assert.equal(a, c);
  // Plages non exactes → pas de signature (comportement v14 conservé).
  const d = fingerprintOf([{ ...base, rangesQuality: 'indicative', ranges: [[1000, 2500]] }]);
  const e = fingerprintOf([{ ...base }]);
  assert.equal(d, e);
});
