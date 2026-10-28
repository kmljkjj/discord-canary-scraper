'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/lib/position_bounds');
const { murmur3 } = require('../src/lib/murmur3');
const { processSamples, parseSample, trackedNames, main } = require('../src/user_rollout_positions');
const { buildComparison, positionsEntry } = require('../src/lib/user_rollout_comparison');

const NAME = '2025-06_client_heartbeat_skipped';
const HASH = murmur3(NAME);
// PRNG déterministe pour des fingerprints reproductibles.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const fpId = (r) => String(1500000000000000000n + BigInt(Math.floor(r() * 1e15)));
// Rollout simulé : positions dans les plages (demi-ouvertes) → présent dans assignments.
function simulate(name, ranges, n, seed, revision = 0) {
  const r = rng(seed); const out = []; const h = murmur3(name);
  for (let i = 0; i < n; i++) {
    const id = fpId(r); const pos = murmur3(`${name}:${id}`) % 10000;
    const inside = ranges.some(([a, b]) => pos >= a && pos < b);
    out.push({ id, assignments: inside ? [[h, revision, 1, -1, 0, pos, 0, 0, null, null, null]] : [] });
  }
  return out;
}

test('état vide : aucune borne', () => {
  assert.equal(P.bounds(P.emptyState()), null);
  assert.equal(P.emptyState().map.length, 10000);
});

test('addPoint : positions invalides ou type non booléen ignorés', () => {
  const s = P.emptyState();
  for (const p of [-1, 10000, 1.5, NaN, '5', null, undefined]) P.addPoint(s, p, true);
  P.addPoint(s, 5, 'oui'); P.addPoint(s, 5, 1);
  assert.equal(s.points, 0);
  assert.equal(s.map, P.emptyState().map);
});

test('addPoint : conflit compté sans modifier la carte', () => {
  const s = P.emptyState();
  P.addPoint(s, 42, true); P.addPoint(s, 42, false); P.addPoint(s, 42, true);
  assert.equal(s.conflicts, 1);
  assert.equal(s.map[42], 'I');
  assert.equal(P.bounds(s).conflicts, 1);
});

test('bornes : une seule plage [0,500[ avec points de part et d\'autre', () => {
  const s = P.emptyState();
  [10, 250, 499].forEach((p) => P.addPoint(s, p, true));
  [502, 700, 9000].forEach((p) => P.addPoint(s, p, false));
  const b = P.bounds(s);
  // min : étendue des dedans 10..499 ; max : jusqu'au dehors voisin 502 exclu et jusqu'à 0
  assert.equal(b.minPct, 4.9); // 490 positions
  assert.equal(b.maxPct, 5.02); // 0..501
  assert.ok(b.minPct <= b.estPct && b.estPct <= b.maxPct);
  assert.equal(b.knownInPct, 0.03);
});

test('bornes : plage au milieu et aux deux extrémités de l\'espace', () => {
  const s = P.emptyState();
  P.addPoint(s, 3000, false); P.addPoint(s, 3100, true); P.addPoint(s, 3900, true); P.addPoint(s, 4000, false);
  const b = P.bounds(s);
  assert.equal(b.minPct, 8.01);
  assert.equal(b.maxPct, 9.99); // 3001..3999
  const t = P.emptyState();
  P.addPoint(t, 9500, true); P.addPoint(t, 9999, true); P.addPoint(t, 9400, false);
  assert.equal(P.bounds(t).maxPct, 5.99); // 9401..9999 → 599 positions
});

test('bornes : plusieurs plages (alternance) gardées séparées', () => {
  const s = P.emptyState();
  // dedans 100-200 et 600-700, dehors ailleurs
  [[50, false], [100, true], [200, true], [300, false], [600, true], [700, true], [900, false]].forEach(([p, i]) => P.addPoint(s, p, i));
  const b = P.bounds(s);
  assert.equal(b.runs, 5);
  assert.equal(b.minPct, 2.02); // 101 + 101 positions
  assert.ok(b.maxPct > b.minPct);
});

test('bornes : aucun dedans connu → seulement un plafond', () => {
  const s = P.emptyState();
  P.addPoint(s, 0, false); P.addPoint(s, 9999, false);
  const b = P.bounds(s);
  assert.equal(b.minPct, 0);
  assert.equal(b.estPct, null);
  assert.equal(b.maxPct, null, 'aucune preuve de borne haute sans point dedans');
});

test('normalize : état corrompu → état vide, jamais d\'exception', () => {
  for (const bad of [null, undefined, 5, 'x', {}, { map: 'abc' }, { map: 'I'.repeat(9999) }, { map: 'Z'.repeat(10000) }]) {
    assert.equal(P.normalize(bad).map, P.emptyState().map);
  }
  const ok = P.normalize({ revision: 3, map: 'I' + '.'.repeat(9999), conflicts: 2, points: 9 });
  assert.equal(ok.revision, 3); assert.equal(ok.conflicts, 2); assert.equal(ok.points, 9);
  assert.equal(P.normalize({ map: '.'.repeat(10000), conflicts: -4, points: 1.5 }).conflicts, 0);
});

test('unionRanges : fusion, bornage, plages invalides ignorées', () => {
  assert.deepEqual(P.unionRanges([[0, 100], [50, 200], [300, 400]]), [[0, 200], [300, 400]]);
  assert.deepEqual(P.unionRanges([[-5, 20], [9990, 20000]]), [[0, 20], [9990, 10000]]);
  assert.deepEqual(P.unionRanges([[5, 5], [9, 3], ['a', 1], null, [1]]), []);
  assert.deepEqual(P.unionRanges(null), []);
});

test('agreement : cohérent, contradictoire et gist hors plage', () => {
  const s = P.emptyState();
  P.addPoint(s, 10, true); P.addPoint(s, 700, false);
  assert.deepEqual(P.agreement(s, [[0, 500]]), { consistentPositions: 2, contradictingPositions: 0, gistPct: 5, examples: [] });
  const c = P.agreement(s, [[0, 10000]]);
  assert.equal(c.contradictingPositions, 1);
  assert.deepEqual(c.examples, [[700, false]]);
  assert.equal(P.agreement(s, []).contradictingPositions, 1);
});

test('propriété : les bornes encadrent toujours le vrai pourcentage (plage unique)', () => {
  const r = rng(7);
  for (let t = 0; t < 300; t++) {
    const a = Math.floor(r() * 9000); const b = a + 1 + Math.floor(r() * (10000 - a - 1));
    const n = 50 + Math.floor(r() * 400);
    const s = P.emptyState();
    for (let i = 0; i < n; i++) { const p = Math.floor(r() * 10000); P.addPoint(s, p, p >= a && p < b); }
    const bd = P.bounds(s);
    if (!bd) continue;
    const truth = (b - a) / 100;
    if (bd.estPct == null) { assert.equal(bd.maxPct, null); continue; }
    assert.ok(bd.minPct <= truth + 0.011 && truth <= bd.maxPct + 0.011, `vrai ${truth} hors [${bd.minPct}, ${bd.maxPct}] (n=${n})`);
  }
});

test('propriété : la largeur des bornes diminue quand les points s\'accumulent', () => {
  const r = rng(11); const s = P.emptyState(); let prev = Infinity; let tightened = 0;
  for (let batch = 0; batch < 8; batch++) {
    for (let i = 0; i < 250; i++) { const p = Math.floor(r() * 10000); P.addPoint(s, p, p < 500); }
    const w = P.bounds(s).widthPoints;
    assert.ok(w <= prev + 1e-9, `la largeur ne doit pas augmenter (${w} > ${prev})`);
    if (w < prev) tightened++;
    prev = w;
  }
  assert.ok(prev < 0.2, `largeur finale ${prev}`);
  assert.ok(tightened >= 3);
});

test('commutativité : l\'ordre des points ne change pas la carte', () => {
  const r = rng(3); const pts = Array.from({ length: 400 }, () => { const p = Math.floor(r() * 10000); return [p, p < 1234]; });
  const a = P.emptyState(); pts.forEach(([p, i]) => P.addPoint(a, p, i));
  const b = P.emptyState(); [...pts].reverse().forEach(([p, i]) => P.addPoint(b, p, i));
  assert.equal(a.map, b.map);
  assert.deepEqual(P.bounds(a), P.bounds(b));
});

test('idempotence : rejouer les mêmes points ne change ni la carte ni les bornes', () => {
  const r = rng(5); const pts = Array.from({ length: 200 }, () => { const p = Math.floor(r() * 10000); return [p, p < 800]; });
  const a = P.emptyState(); pts.forEach(([p, i]) => P.addPoint(a, p, i));
  const before = P.bounds(a);
  pts.forEach(([p, i]) => P.addPoint(a, p, i));
  const after = P.bounds(a);
  assert.equal(after.conflicts, 0);
  for (const k of ['minPct', 'maxPct', 'estPct', 'knownPositions']) assert.equal(after[k], before[k]);
});

// ─── processSamples ──────────────────────────────────────────────────────

test('processSamples : plage [0,500[ simulée → bornes autour de 5 %', () => {
  const s = simulate(NAME, [[0, 500]], 3000, 1);
  const { state, diagnostics } = processSamples({}, s, [NAME]);
  assert.deepEqual(diagnostics, []);
  const b = P.bounds(state[NAME]);
  assert.ok(b.minPct <= 5 && 5 <= b.maxPct, JSON.stringify(b));
  assert.ok(b.widthPoints < 0.2, JSON.stringify(b));
  assert.equal(state[NAME].hash, HASH);
});

test('processSamples : cumul sur plusieurs runs resserre les bornes', () => {
  let st = {};
  let width = Infinity;
  for (let run = 0; run < 5; run++) {
    st = processSamples(st, simulate(NAME, [[0, 500]], 150, 100 + run), [NAME]).state;
    const w = P.bounds(st[NAME]).widthPoints;
    assert.ok(w <= width + 1e-9); width = w;
  }
  assert.ok(width < 3);
});

test('processSamples : expérience jamais vue et non suivie → aucune entrée', () => {
  const { state } = processSamples({}, simulate('2025-01_autre', [[0, 0]], 30, 2), ['2025-01_autre']);
  assert.deepEqual(state, {});
});

test('processSamples : absente de tout le lot alors que connue → aucun « dehors » enregistré', () => {
  const first = processSamples({}, simulate(NAME, [[0, 500]], 400, 9), [NAME]).state;
  const before = first[NAME].map;
  const { state, diagnostics } = processSamples(first, simulate(NAME, [], 150, 10), [NAME]);
  assert.ok(diagnostics.some((d) => d.code === 'absent_whole_batch'));
  assert.equal(state[NAME].map, before);
});

test('processSamples : changement de révision → carte remise à zéro', () => {
  const first = processSamples({}, simulate(NAME, [[0, 500]], 400, 12, 0), [NAME]).state;
  const { state, diagnostics } = processSamples(first, simulate(NAME, [[0, 1000]], 400, 13, 1), [NAME]);
  assert.ok(diagnostics.some((d) => d.code === 'revision_reset' && d.from === 0 && d.to === 1));
  assert.equal(state[NAME].revision, 1);
  const b = P.bounds(state[NAME]);
  assert.ok(b.minPct > 8, JSON.stringify(b));
});

test('processSamples : révisions mélangées dans un lot → expérience ignorée ce run', () => {
  const a = simulate(NAME, [[0, 5000]], 40, 20, 0); const b = simulate(NAME, [[0, 5000]], 40, 21, 1);
  const { state, diagnostics } = processSamples({}, [...a, ...b], [NAME]);
  assert.ok(diagnostics.some((d) => d.code === 'mixed_revision'));
  assert.equal(state[NAME], undefined);
});

test('processSamples : position annoncée ≠ formule → modèle non fiable, rien d\'enregistré', () => {
  const s = simulate(NAME, [[0, 5000]], 60, 30);
  s.filter((x) => x.assignments.length).slice(0, 5).forEach((x) => { x.assignments[0][5] = (x.assignments[0][5] + 1) % 10000; });
  const { state, diagnostics } = processSamples({}, s, [NAME]);
  assert.ok(diagnostics.some((d) => d.code === 'position_mismatch' && d.count === 5));
  assert.equal(state[NAME], undefined);
});

test('processSamples : fingerprints en double comptés une fois', () => {
  const s = simulate(NAME, [[0, 500]], 100, 40);
  const once = processSamples({}, s, [NAME]).state[NAME];
  const twice = processSamples({}, [...s, ...s], [NAME]).state[NAME];
  assert.equal(twice.points, once.points);
  assert.equal(twice.map, once.map);
});

test('processSamples : entrées malformées sans exception', () => {
  const junk = [null, undefined, {}, { id: 'x' }, { id: '1', assignments: 'non' }, { id: '2', assignments: [null, 5, 'a', []] }];
  assert.doesNotThrow(() => processSamples(null, junk.filter(Boolean).map((j) => ({ id: j.id || 'z', assignments: Array.isArray(j.assignments) ? j.assignments : [] })), [NAME]));
  assert.doesNotThrow(() => processSamples({ [NAME]: 'cassé' }, simulate(NAME, [[0, 500]], 20, 50), [NAME]));
});

test('parseSample : fingerprint et assignments requis', () => {
  assert.deepEqual(parseSample({ fingerprint: '1564852841112404028.sig', assignments: [] }), { id: '1564852841112404028', assignments: [] });
  for (const bad of [null, {}, { fingerprint: 'abc.def', assignments: [] }, { fingerprint: '1564852841112404028.s' }, { fingerprint: 5, assignments: [] }]) assert.equal(parseSample(bad), null);
});

test('trackedNames : noms publiés + noms connus vus sur le wire, hash ambigu ignoré', () => {
  const comparison = { experiments: [{ id: 'a_pub' }, { id: 'hash:12' }] };
  const wire = [{ id: '1', assignments: [[murmur3('connu_wire'), 0, 1, -1, 0, 5]] }];
  const names = trackedNames(comparison, ['connu_wire', 'jamais_vu'], { deja: {} }, wire);
  assert.deepEqual(names.sort(), ['a_pub', 'connu_wire', 'deja']);
});

// ─── jeu réel : échantillons Discord rejoués hors ligne ───────────────────

test('main : échantillonnage injecté → fichier écrit, jamais dans data/', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-')), 'pos.json');
  const sim = simulate(NAME, [[0, 500]], 60, 77);
  let i = 0;
  const fetchImpl = async () => {
    const s = sim[i++ % sim.length];
    return { ok: true, status: 200, json: async () => ({ fingerprint: `${s.id}.sig`, assignments: s.assignments }) };
  };
  const before = fs.readdirSync(path.join(__dirname, '..', 'data')).sort().join();
  const log = console.log; console.log = () => {};
  let r;
  try { r = await main({ out, fetch: fetchImpl, samples: 60, delayMs: 0, comparison: { experiments: [{ id: NAME }] }, knownNames: [NAME], now: Date.parse('2026-10-28T06:00:00Z') }); } finally { console.log = log; }
  assert.equal(r.lastRun.ok, 60);
  assert.ok(P.bounds(r.experiments[NAME]));
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).experiments[NAME].map, r.experiments[NAME].map);
  assert.equal(fs.readdirSync(path.join(__dirname, '..', 'data')).sort().join(), before);
});

test('main : trop peu d\'échantillons (429 / HTML) → état précédent conservé', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-')), 'pos.json');
  const prev = processSamples({}, simulate(NAME, [[0, 500]], 300, 5), [NAME]).state;
  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, experiments: prev }));
  const warn = console.warn; console.warn = () => {};
  let r;
  try { r = await main({ out, fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }), samples: 10, delayMs: 0, maxMs: 500, comparison: {}, knownNames: [] }); } finally { console.warn = warn; }
  assert.equal(r.lastRun.skipped, true);
  assert.equal(r.experiments[NAME].map, prev[NAME].map);
});

// ─── intégration à la comparaison ────────────────────────────────────────

const ranges = (pairs) => [{ variant: 1, role: 'treatment', ranges: pairs }];
const stateFor = (name, rs, n, seed) => processSamples({}, simulate(name, rs, n, seed), [name]).state;

test('positionsEntry : cohérent / contradictoire / sans plages gist', () => {
  const st = stateFor(NAME, [[0, 500]], 2500, 61)[NAME];
  const ok = positionsEntry(st, HASH, 5, ranges([[0, 500]]), 'T');
  assert.equal(ok.verdict, 'consistent_with_gist'); assert.equal(ok.gistInBounds, true); assert.equal(ok.agreement.contradictingPositions, 0);
  const contradiction = positionsEntry(st, HASH, 100, ranges([[0, 10000]]), 'T');
  assert.equal(contradiction.verdict, 'contradicts_gist');
  assert.ok(contradiction.agreement.contradictingPositions > 100);
  const noRanges = positionsEntry(st, HASH, 5, null, 'T');
  assert.equal(noRanges.agreement, null); assert.equal(noRanges.verdict, 'consistent_with_gist');
  const differs = positionsEntry(st, HASH, 50, null, 'T');
  assert.equal(differs.verdict, 'differs_from_gist');
  assert.equal(positionsEntry(st, HASH + 1, 5, null, 'T'), null, 'hash différent');
  assert.equal(positionsEntry(null, HASH, 5, null), null);
  assert.equal(positionsEntry({ hash: HASH, map: 'corrompu' }, HASH, 5, null), null);
});

test('buildComparison : positions jointes à l\'expérience, absentes sinon', () => {
  const raw = [{ id: NAME, variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 500'] }] }];
  const sampling = { scrapedAt: '2026-10-28T04:00:00Z', experiments: [{ hash: HASH, id: NAME, type: 'user', windowN: 1000, treatments: [{ bucket: 1, sampleCount: 50 }] }] };
  const positions = { updatedAt: '2026-10-28T05:00:00Z', experiments: stateFor(NAME, [[0, 500]], 2500, 62) };
  const c = buildComparison({ rawGist: raw, sampling, positions, now: Date.parse('2026-10-28T06:00:00Z') });
  const e = c.experiments.find((x) => x.id === NAME);
  assert.equal(e.positions.verdict, 'consistent_with_gist');
  assert.equal(e.positions.updatedAt, '2026-10-28T05:00:00Z');
  assert.ok(e.positions.minPct <= 5 && e.positions.maxPct >= 5);
  const none = buildComparison({ rawGist: raw, sampling, now: Date.parse('2026-10-28T06:00:00Z') });
  assert.equal(none.experiments.find((x) => x.id === NAME).positions, null);
  for (const bad of [null, 5, 'x', [], { experiments: null }, { experiments: { [NAME]: 3 } }]) {
    assert.doesNotThrow(() => buildComparison({ rawGist: raw, sampling, positions: bad, now: 1 }));
  }
});

test('jeu réel Discord (captures du 28/10/2026) : bornes serrées et accord avec le gist', () => {
  const file = path.join(__dirname, 'fixtures', 'discord_positions_20261028.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const samples = data.samples.map(([id, hashes]) => ({ id, assignments: hashes.map((h) => [h.hash, h.rev, h.bucket, -1, 0, h.pos, 0, 0, null, null, null]) }));
  const names = Object.keys(data.gistRanges);
  const { state, diagnostics } = processSamples({}, samples, names);
  assert.deepEqual(diagnostics, []);
  const b = Object.fromEntries(names.map((n) => [n, P.bounds(state[n])]));
  assert.ok(b[NAME].minPct >= 4.9 && b[NAME].maxPct <= 5.1, JSON.stringify(b[NAME]));
  assert.ok(b['2024-10_quests_dismissal_survey'].minPct >= 4.9 && b['2024-10_quests_dismissal_survey'].maxPct <= 5.1);
  for (const n of ['2023-09_iar_user_reporting', '2025-11_tida_webform']) assert.ok(b[n].maxPct === 100 && b[n].minPct >= 99.5);
  for (const n of names) {
    const ag = P.agreement(state[n], data.gistRanges[n]);
    if (n === '2024-10_quests_dismissal_survey') assert.ok(ag.contradictingPositions > 1000, 'le gist annonce 100 %, les positions disent ~5 %');
    else assert.equal(ag.contradictingPositions, 0, n);
  }
});
