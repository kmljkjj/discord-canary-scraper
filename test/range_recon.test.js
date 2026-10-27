/**
 * Tests de range_recon — run: node test/range_recon.test.js
 * Scénarios synthétiques : on simule le tirage uniforme de fingerprints
 * (positions murmur3 uniformes) sur des configs de rollout réalistes
 * (celles observées publiquement : multiples de 25) et on vérifie que la
 * reconstruction retrouve les plages EXACTES avec la bonne qualité.
 */
const nodeTest = require('node:test');
const a = require('node:assert/strict');
const { reconstructRanges, snapFrontier, rangesToStrings } = require('../src/lib/range_recon');

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

const inR = (rs) => (p) => rs.some(([x, y]) => p >= x && p < y);

function simulate(config, n, seed, withOutside) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = Math.floor(rnd() * 10000);
    const b = config(p);
    if (b != null || withOutside) out.push({ p, b });
  }
  return out;
}

// Config « gist » réelle : control [0,1500)+[3000,4000)+[5000,5500),
// treatment [1500,3000)+[4000,5000)+[5500,6000) — 30 % / 30 %.
const CTRL = [
  [0, 1500],
  [3000, 4000],
  [5000, 5500],
];
const TREAT = [
  [1500, 3000],
  [4000, 5000],
  [5500, 6000],
];
const confGist = (p) => (inR(CTRL)(p) ? 0 : inR(TREAT)(p) ? 1 : null);

nodeTest('gist : plages exactes retrouvées (fallback, n=6300)', () => {
  const r = reconstructRanges(simulate(confGist, 6300, 42, false), {
    knPct: { 0: 30, 1: 30 },
    tolerance: 3,
  });
  a.equal(r.quality, 'exact');
  a.deepEqual(r.rangesByBucket['0'], CTRL);
  a.deepEqual(r.rangesByBucket['1'], TREAT);
  a.equal(r.pctByBucket['0'], 30);
  a.equal(r.pctByBucket['1'], 30);
});

nodeTest('gist : robuste sur 10 graines (fallback)', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = reconstructRanges(simulate(confGist, 6300, seed * 17, false), {
      knPct: { 0: 30, 1: 30 },
      tolerance: 3,
    });
    a.equal(r.quality, 'exact', 'seed ' + seed);
    a.deepEqual(r.rangesByBucket['0'], CTRL, 'seed ' + seed);
    a.deepEqual(r.rangesByBucket['1'], TREAT, 'seed ' + seed);
  }
});

nodeTest('rollout complet : [0,10000) → 100 %', () => {
  const r = reconstructRanges(simulate(() => 1, 500, 7, false), {
    knPct: { 1: 100 },
    tolerance: 3,
  });
  a.equal(r.quality, 'exact');
  a.deepEqual(r.rangesByBucket['1'], [[0, 10000]]);
  a.equal(r.pctByBucket['1'], 100);
});

nodeTest('plages minuscules 0-100 / 100-200 (rollout à 1 %)', () => {
  const conf = (p) => (p < 100 ? 0 : p < 200 ? 1 : null);
  const r = reconstructRanges(simulate(conf, 2000, 99, false), {
    knPct: { 0: 1, 1: 1 },
    tolerance: 2,
  });
  a.equal(r.quality, 'exact');
  a.deepEqual(r.rangesByBucket['0'], [[0, 100]]);
  a.deepEqual(r.rangesByBucket['1'], [[100, 200]]);
});

nodeTest('bucket -1 (Control explicite)', () => {
  const conf = (p) => (p < 2000 ? -1 : p < 3000 ? 1 : null);
  const r = reconstructRanges(simulate(conf, 6300, 6, false), {
    knPct: { '-1': 20, 1: 10 },
    tolerance: 3,
  });
  a.equal(r.quality, 'exact');
  a.deepEqual(r.rangesByBucket['-1'], [[0, 2000]]);
  a.deepEqual(r.rangesByBucket['1'], [[2000, 3000]]);
  a.equal(r.pctByBucket['-1'], 20);
});

nodeTest('premier run clairsemé (n=60) : PAS exact — honnête', () => {
  const r = reconstructRanges(simulate(confGist, 60, 5, false), {
    knPct: { 0: 30, 1: 30 },
    tolerance: 12,
  });
  a.notEqual(r.quality, 'exact');
});

nodeTest('fallback : 7 plages fines d\'un même bucket → fusionnées, k/n contredit → indicative', () => {
  // Config réelle type 2026-10-gdm-duration-timer : 7 plages de 25 à 100,
  // total 350 (= 3,5 %). Sans positions outside, la structure est invisible.
  const F = [
    [1000, 1100],
    [1450, 1500],
    [2600, 2650],
    [4500, 4525],
    [5550, 5600],
    [6800, 6825],
    [7750, 7800],
  ];
  const conf = (p) => (inR(F)(p) ? 0 : null);
  const r = reconstructRanges(simulate(conf, 6300, 3, false), {
    knPct: { 0: 3.5 },
    tolerance: 2,
  });
  a.equal(r.quality, 'indicative');
});

nodeTest('mode outside (fingerprint vérifié) : les 7 plages fines sont retrouvées', () => {
  const F = [
    [1000, 1100],
    [1450, 1500],
    [2600, 2650],
    [4500, 4525],
    [5550, 5600],
    [6800, 6825],
    [7750, 7800],
  ];
  const conf = (p) => (inR(F)(p) ? 0 : null);
  const r = reconstructRanges(simulate(conf, 6300, 4, true), {
    knPct: { 0: 3.5, null: 96.5 },
    tolerance: 2,
  });
  a.equal(r.quality, 'exact');
  a.deepEqual(r.rangesByBucket['0'], F);
  a.equal(r.pctByBucket['0'], 3.5);
});

nodeTest('frontière hors grille à l\'intérieur → aucune borne snapped → indicative', () => {
  // vraie frontière 1234 (hors grille 25) entre deux buckets
  const conf = (p) => (p < 1234 ? 1 : p < 5000 ? 2 : null);
  const r = reconstructRanges(simulate(conf, 6300, 6, false), {
    knPct: { 1: 12, 2: 37 },
    tolerance: 2,
  });
  a.equal(r.quality, 'indicative');
});

nodeTest('cohérence k/n : plages contradictoires → jamais exact', () => {
  // k/n prétend 50 % mais les plages reconstruites en couvrent 70
  const r = reconstructRanges(simulate((p) => (p < 7000 ? 1 : null), 6300, 8, false), {
    knPct: { 1: 50 },
    tolerance: 3,
  });
  a.equal(r.quality, 'indicative');
});

nodeTest('snapFrontier : confiance honnête quand 2 candidats se partagent l\'intervalle', () => {
  // gap (964, 1000] : candidats 975 et 1000 → confiance < 1
  const s = snapFrontier(964, 1000, 0.15, 0.13, 25, 10000);
  a.ok(s.snapped === 975 || s.snapped === 1000);
  a.ok(s.confidence > 0.5 && s.confidence < 1, 'confiance=' + s.confidence);
});

nodeTest('snapFrontier : gap plus petit que la grille → candidat unique, confiance 1', () => {
  const s = snapFrontier(1495, 1503, 0.5, 0.5, 25, 10000);
  a.equal(s.snapped, 1500);
  a.equal(Math.round(s.confidence * 1000) / 1000, 1);
});

nodeTest('snapFrontier : côté non observable (λ=0) → frontière près du dernier échantillon', () => {
  // fin de plage côté non-enrôlé invisible : boundary juste au-dessus de x
  const s = snapFrontier(5993, 10000, 0.6, 0, 25, 10000);
  a.equal(s.snapped, 6000);
  a.ok(s.confidence > 0.9);
});

nodeTest('insufficient : aucun échantillon', () => {
  const r = reconstructRanges([], {});
  a.equal(r.quality, 'insufficient');
  a.deepEqual(r.rangesByBucket, {});
});

nodeTest('rangesToStrings : format gist', () => {
  a.equal(
    rangesToStrings([
      [0, 1500],
      [3000, 4000],
    ]),
    '0 - 1500 + 3000 - 4000',
  );
});

nodeTest('positions invalides ignorées', () => {
  const r = reconstructRanges([{ p: -5, b: 1 }, { p: 12000, b: 1 }, { p: 'x', b: 1 }, { p: 50, b: 1 }, { p: 60, b: 1 }], {
    grid: 25,
  });
  a.equal(r.n, 2);
});
