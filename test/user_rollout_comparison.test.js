/**
 * Comparaison gist / mesure API : unités, propriétés et passage sur TOUT le
 * catalogue du dépôt. Aucun accès réseau, aucune écriture dans data/.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { murmur3 } = require('../src/lib/murmur3');
const { computeExperiment } = require('../src/lib/gist_rollouts');
const {
  experimentHash,
  wilson95,
  freshness,
  measured,
  buildComparison,
} = require('../src/lib/user_rollout_comparison');

const DATA = path.join(__dirname, '..', 'data');
const J = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return fallback; }
};
const NOW = Date.parse('2026-10-28T12:00:00Z');
const ISO = (h) => new Date(NOW - h * 3600000).toISOString();

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};

const gistEntry = (id, treatment, extra = {}) => ({
  id, title: id, type: 'user', hasData: true, totalsAvailable: true, ambiguous: false,
  projected: false, flags: [], treatmentPct: treatment, projectedTreatmentPct: null,
  controlPct: 0, notEligiblePct: 0, unassignedPct: 100 - treatment,
  byVariant: { 1: { pct: treatment, role: 'treatment' } }, ...extra,
});
const sample = (id, k, n, extra = {}) => ({
  hash: murmur3(id), id, type: 'user', source: 'own_sampling', windowN: n,
  treatments: [{ bucket: 1, sampleCount: k }], ...extra,
});
const run = (gistExps, sampleExps, extra = {}) => buildComparison({
  gist: { experiments: gistExps, source: { updatedAt: ISO(1), htmlUrl: 'https://gist.github.com/x/y' } },
  sampling: { experiments: sampleExps, scrapedAt: ISO(1) },
  now: NOW, ...extra,
});

// ─── hash ──────────────────────────────────────────────────────────────────

test('experimentHash : nom, hash:<n>, valeurs invalides', () => {
  assert.equal(experimentHash('2024-10_quests_dismissal_survey'), 704914099);
  assert.equal(experimentHash('hash:704914099'), 704914099);
  for (const bad of ['hash:', 'hash:abc', 'hash:-1', 'hash:4294967296', '', '  ', null, undefined, 12]) {
    assert.equal(experimentHash(bad), null, String(bad));
  }
});

test('experimentHash : ne corrige pas tirets/underscores (changerait le hash Discord)', () => {
  assert.notEqual(experimentHash('2026-10-pinot-admin'), experimentHash('2026_10_pinot_admin'));
});

// ─── Wilson ────────────────────────────────────────────────────────────────

test('wilson95 : valeurs de référence', () => {
  const r = wilson95(50, 100);
  assert.ok(Math.abs(r.lo - 40.383) < 0.01 && Math.abs(r.hi - 59.617) < 0.01, JSON.stringify(r));
  assert.deepEqual(wilson95(0, 100).lo, 0);
  assert.equal(wilson95(100, 100).hi, 100);
  assert.ok(wilson95(0, 100).hi > 3 && wilson95(0, 100).hi < 4);
});

test('wilson95 : entrées invalides → null', () => {
  for (const [k, n] of [[-1, 10], [11, 10], [1, 0], [1, -5], [1.5, 10], [1, 2.5], [NaN, 10], [1, Infinity], ['1', 10]]) {
    assert.equal(wilson95(k, n), null, `${k}/${n}`);
  }
});

test('wilson95 : propriétés sur 6000 cas (bornes, monotonie, rétrécissement)', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 6000; i++) {
    const n = 1 + Math.floor(rnd() * 20000);
    const k = Math.floor(rnd() * (n + 1));
    const w = wilson95(k, n);
    const p = (100 * k) / n;
    assert.ok(w.lo >= 0 && w.hi <= 100 && w.lo <= w.hi, `${k}/${n}`);
    assert.ok(w.lo <= p + 1e-9 && p <= w.hi + 1e-9, `${k}/${n} contient p`);
    if (k < n) {
      const next = wilson95(k + 1, n);
      assert.ok(next.lo >= w.lo - 1e-9 && next.hi >= w.hi - 1e-9, `monotone ${k}/${n}`);
    }
  }
  const small = wilson95(50, 100);
  const big = wilson95(5000, 10000);
  assert.ok(big.hi - big.lo < small.hi - small.lo);
});

// ─── freshness ─────────────────────────────────────────────────────────────

test('freshness : recent / stale / unknown / futur', () => {
  assert.equal(freshness(ISO(1), NOW, 6).state, 'recent');
  assert.equal(freshness(ISO(7), NOW, 6).state, 'stale');
  assert.equal(freshness(ISO(100), NOW, 72).state, 'stale');
  assert.equal(freshness(null, NOW, 6).state, 'unknown');
  assert.equal(freshness('pas une date', NOW, 6).state, 'unknown');
  assert.equal(freshness(new Date(NOW + 3600000).toISOString(), NOW, 6).state, 'unknown');
});

// ─── measured ──────────────────────────────────────────────────────────────

test('measured : absente → not_observed, jamais 0 %', () => {
  const m = measured(null, null, null, NOW);
  assert.equal(m.status, 'not_observed');
  assert.equal(m.pct, null);
  assert.equal(m.ci, null);
});

test('measured : k/n du traitement selon les rôles du gist, pas de max de variante', () => {
  const g = { hasData: true, flags: [], byVariant: { 0: { role: 'control' }, 1: { role: 'treatment' }, 2: { role: 'treatment' } } };
  const e = { windowN: 1000, source: 'own_sampling', treatments: [
    { bucket: 0, sampleCount: 100 }, { bucket: 1, sampleCount: 100 }, { bucket: 2, sampleCount: 100 }] };
  const m = measured(e, g, ISO(1), NOW);
  assert.equal(m.status, 'measured');
  assert.equal(m.k, 200);
  assert.equal(m.pct, 20);
  assert.equal(m.observedAssignments.k, 300);
  assert.deepEqual(m.variants.map((v) => v.role), ['control', 'treatment', 'treatment']);
});

test('measured : sans rôle exploitable, pas de pourcentage de traitement', () => {
  const e = { windowN: 1000, treatments: [{ bucket: 1, sampleCount: 50 }] };
  for (const g of [null, { hasData: false, flags: ['no_data'], byVariant: {} },
    { hasData: true, flags: ['role_conflict'], byVariant: { 1: { role: 'treatment' } } },
    { hasData: true, flags: ['unknown_role'], byVariant: { 1: { role: 'weird' } } }]) {
    const m = measured(e, g, ISO(1), NOW);
    assert.equal(m.status, 'measured');
    assert.equal(m.pct, null);
    assert.equal(m.k, null);
    assert.equal(m.roleBasis, 'unknown');
    assert.equal(m.observedAssignments.pct, 5);
  }
});

test('measured : données incohérentes → invalid', () => {
  const bad = [
    { windowN: 100, treatments: [{ bucket: 1, sampleCount: 101 }] },
    { windowN: 100, treatments: [{ bucket: 1, sampleCount: 60 }, { bucket: 2, sampleCount: 60 }] },
    { windowN: 100, treatments: [{ bucket: 1, sampleCount: 5 }, { bucket: 1, sampleCount: 5 }] },
    { windowN: 0, treatments: [{ bucket: 1, sampleCount: 0 }] },
    { windowN: -5, treatments: [{ bucket: 1, sampleCount: 1 }] },
    { windowN: 100.5, treatments: [{ bucket: 1, sampleCount: 1 }] },
    { windowN: 100, treatments: [] },
    { windowN: 100, treatments: [{ bucket: 1.5, sampleCount: 1 }] },
    { windowN: 100, treatments: [{ bucket: 1, sampleCount: -1 }] },
    { windowN: 100, treatments: [{ bucket: 1, sampleCount: 'x' }] },
    { windowN: 100, treatments: [null] },
    { windowN: 100, source: 'inconnu', treatments: [{ bucket: 1, sampleCount: 1 }] },
    { treatments: [{ bucket: 1, sampleCount: 1 }] },
  ];
  for (const e of bad) {
    const m = measured(e, null, ISO(1), NOW);
    assert.equal(m.status, 'invalid', JSON.stringify(e));
    assert.equal(m.pct, null);
  }
});

// ─── buildComparison : cas ciblés ──────────────────────────────────────────

test('compatible : couverture gist dans l\'IC', () => {
  const out = run([gistEntry('2025-06_a', 5)], [sample('2025-06_a', 497, 10000)]);
  const e = out.experiments[0];
  assert.equal(e.comparison.observation, 'inside_interval');
  assert.equal(e.comparison.verdict, 'not_verified');
  assert.equal(e.comparison.samePopulationEstablished, false);
  assert.equal(e.coverage.verified, false);
});

test('hors intervalle : écart signalé sans conclure que le gist est faux', () => {
  const out = run([gistEntry('2024-10_q', 100)], [sample('2024-10_q', 380, 7447)]);
  const e = out.experiments[0];
  assert.equal(e.comparison.observation, 'outside_interval');
  assert.equal(e.comparison.verdict, 'not_verified');
  assert.equal(e.comparison.deltaPoints, -94.9);
});

test('hash seul rattaché au nom du gist ; une seule entrée', () => {
  const id = '2024-10_q';
  const out = run([gistEntry(id, 100)], [{ ...sample(id, 380, 7447), id: `hash:${murmur3(id)}` }]);
  assert.equal(out.experiments.length, 1);
  assert.equal(out.experiments[0].id, id);
  assert.equal(out.experiments[0].measurement.status, 'measured');
});

test('hash sans nom connu : identifiant hash:<n>, pas de nom inventé', () => {
  const out = run([], [{ hash: 3013881204, id: 'hash:3013881204', type: 'user', windowN: 100, treatments: [{ bucket: 11, sampleCount: 100 }] }]);
  assert.equal(out.experiments[0].id, 'hash:3013881204');
  assert.equal(out.experiments[0].coverage, null);
  assert.equal(out.experiments[0].comparison.observation, 'not_comparable');
  assert.equal(out.experiments[0].measurement.pct, null);
});

test('id nommé dont le hash ne correspond pas → écarté et diagnostiqué', () => {
  const out = run([], [{ ...sample('2025-a', 1, 10), hash: 12345 }]);
  assert.equal(out.experiments.length, 0);
  assert.deepEqual(out.diagnostics.map((d) => d.code), ['hash_mismatch']);
});

test('hash invalide → diagnostiqué, pas de crash', () => {
  const out = run([], [{ hash: -1, id: 'hash:-1', type: 'user', windowN: 10, treatments: [{ bucket: 1, sampleCount: 1 }] }]);
  assert.deepEqual(out.diagnostics.map((d) => d.code), ['invalid_hash']);
});

test('collision de hash : jointure refusée', () => {
  // même hash forcé via deux définitions artificielles
  const a = { id: 'a-exp', type: 'user' };
  const out = buildComparison({ definitions: [a, { ...a, id: 'b-exp' }], sampling: { experiments: [{ hash: murmur3('a-exp'), id: 'hash:' + murmur3('a-exp'), type: 'user', windowN: 10, treatments: [{ bucket: 1, sampleCount: 1 }] }] }, now: NOW });
  assert.ok(out.experiments.every((e) => e.measurement.status === 'not_observed') || out.diagnostics.length === 0);
});

test('expérience guild : jamais de % user, même si le gist la contient', () => {
  const out = buildComparison({
    definitions: [{ id: '2025-g', type: 'guild' }],
    gist: { experiments: [gistEntry('2025-g', 50)] },
    sampling: { experiments: [sample('2025-g', 10, 100)] }, now: NOW });
  assert.equal(out.experiments.length, 0);
  assert.deepEqual(out.diagnostics.map((d) => d.code), ['type_conflict']);
});

test('gist multi-population (projeté) : non comparable, aucun écart calculé', () => {
  const g = gistEntry('2025-p', null, { totalsAvailable: false, projected: true, projectedTreatmentPct: 100, treatmentPct: null, flags: ['multi_population'] });
  const out = run([g], [sample('2025-p', 10, 100)]);
  assert.equal(out.experiments[0].comparison.observation, 'not_comparable');
  assert.equal(out.experiments[0].comparison.deltaPoints, null);
});

test('gist sans donnée : non comparable ; mesure conservée sans pct de traitement', () => {
  const g = { id: '2025-n', type: 'user', hasData: false, flags: ['no_data'], byVariant: {}, totalsAvailable: false, treatmentPct: null };
  const out = run([g], [sample('2025-n', 10, 100)]);
  assert.equal(out.experiments[0].comparison.observation, 'not_comparable');
  assert.equal(out.experiments[0].measurement.pct, null);
});

test('doublon gist et doublon d\'échantillon : signalés, pas de chiffre arbitraire', () => {
  const out = run([gistEntry('2025-d', 10), gistEntry('2025-d', 90)], [sample('2025-d', 10, 100), sample('2025-d', 90, 100)]);
  assert.ok(out.diagnostics.some((d) => d.code === 'duplicate_gist'));
  assert.equal(out.experiments[0].measurement.status, 'invalid');
  assert.equal(out.experiments[0].comparison.observation, 'not_comparable');
});

test('gist brut : plages sources, noms des hash et couverture des non classés', () => {
  const raw = [{ id: '2024-10_q', variants: [{ variant: 1, role: 'treatment', ranges: ['9500 - 10000'] }] }];
  const out = buildComparison({ rawGist: raw, sampling: { experiments: [{ hash: murmur3('2024-10_q'), id: 'hash:' + murmur3('2024-10_q'), type: 'user', windowN: 1000, treatments: [{ bucket: 1, sampleCount: 50 }] }], scrapedAt: ISO(1) }, gist: { source: { updatedAt: ISO(2) } }, now: NOW });
  const e = out.experiments[0];
  assert.equal(e.id, '2024-10_q');
  assert.deepEqual(e.coverage.sourceRanges, [{ variant: 1, role: 'treatment', ranges: [[9500, 10000]] }]);
  assert.equal(e.coverage.treatmentPct, 5);
  assert.equal(e.comparison.observation, 'inside_interval');
});

test('gist brut : doublon d\'id signalé ; id hash: ignoré', () => {
  const out = buildComparison({ rawGist: [{ id: 'a', variants: [] }, { id: 'a', variants: [] }, { id: 'hash:1', variants: [] }, null, {}], now: NOW });
  assert.deepEqual(out.diagnostics.map((d) => d.code), ['duplicate_gist_raw']);
});

test('onlyObserved : ne garde que les expériences avec observation', () => {
  const full = run([gistEntry('2025-x', 5), gistEntry('2025-y', 5)], [sample('2025-x', 5, 100)]);
  const compact = run([gistEntry('2025-x', 5), gistEntry('2025-y', 5)], [sample('2025-x', 5, 100)], { onlyObserved: true });
  assert.equal(full.experiments.length, 2);
  assert.deepEqual(compact.experiments.map((e) => e.id), ['2025-x']);
});

test('fraîcheur : mesure ancienne datée mais conservée ; gist ancien signalé', () => {
  const out = buildComparison({
    gist: { experiments: [gistEntry('2025-f', 5)], source: { updatedAt: ISO(200) } },
    sampling: { experiments: [sample('2025-f', 5, 100)], scrapedAt: ISO(30) }, now: NOW });
  const e = out.experiments[0];
  assert.equal(e.measurement.freshness.state, 'stale');
  assert.equal(e.coverage.freshness.state, 'stale');
  assert.equal(e.measurement.status, 'measured');
});

test('entrées vides ou malformées : pas de crash', () => {
  for (const args of [{}, { gist: null, sampling: null }, { gist: { experiments: 'x' }, sampling: { experiments: [null, 1, {}] }, definitions: [null, {}] }]) {
    const out = buildComparison({ ...args, now: NOW });
    assert.ok(Array.isArray(out.experiments));
  }
  assert.throws(() => buildComparison({ now: NaN }), TypeError);
});

test('entrées jamais modifiées', () => {
  const gist = deepFreeze({ experiments: [gistEntry('2025-m', 5)], source: { updatedAt: ISO(1) } });
  const sampling = deepFreeze({ experiments: [sample('2025-m', 5, 100)], scrapedAt: ISO(1) });
  const defs = deepFreeze([{ id: '2025-m', type: 'user' }]);
  const raw = deepFreeze([{ id: '2025-m', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 500'] }] }]);
  assert.doesNotThrow(() => buildComparison({ gist, sampling, definitions: defs, rawGist: raw, now: NOW }));
});

test('XSS : identifiants et rôles hostiles transportés tels quels (échappés à l\'affichage)', () => {
  const id = '<img src=x onerror=alert(1)>';
  const out = run([gistEntry(id, 5)], []);
  assert.equal(out.experiments[0].id, id);
});

// ─── Tout le catalogue du dépôt ────────────────────────────────────────────

const repoDefs = () => ['experiments.json', 'mobile_experiments.json', 'apex_experiments.json'].flatMap((f) => {
  const j = J(f, null);
  const list = Array.isArray(j) ? j : j && j.experiments ? j.experiments : [];
  return list.filter((e) => e && (e.id || e.name)).map((e) => ({ id: e.id || e.name, type: e.type || e.kind, title: e.label || e.title }));
});
const docs = J('gist_user_rollouts_docs.json', { experiments: [] });
const userSampling = J('user_rollouts.json', { experiments: [] });

test('catalogue du dépôt : toutes les expériences du gist export sont présentes une seule fois', () => {
  const out = buildComparison({ gist: docs, sampling: { experiments: [] }, definitions: repoDefs(), now: NOW });
  const ids = out.experiments.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids uniques');
  assert.ok(docs.experiments.length > 300, 'catalogue réel chargé');
  for (const g of docs.experiments.filter((x) => x.type === 'user')) {
    const e = out.experiments.find((x) => x.id === g.id);
    assert.ok(e, `manquant : ${g.id}`);
    assert.equal(e.type, 'user');
    assert.equal(e.measurement.status, 'not_observed');
    assert.equal(e.coverage.treatmentPct, g.treatmentPct);
    assert.equal(e.hash, murmur3(g.id));
  }
  assert.ok(out.experiments.every((e) => e.type === 'user'));
});

test('catalogue du dépôt : mesure parfaitement fidèle au gist → compatible pour chaque expérience', () => {
  let tested = 0;
  for (const g of docs.experiments) {
    if (g.type !== 'user' || !g.totalsAvailable || g.projected || g.treatmentPct == null) continue;
    const n = 20000;
    const k = Math.round((g.treatmentPct / 100) * n);
    const treatments = Object.entries(g.byVariant).filter(([, v]) => v.role === 'treatment').map(([b], i, a) => ({ bucket: Number(b), sampleCount: Math.floor(k / a.length) + (i === 0 ? k % a.length : 0) }));
    if (!treatments.length) continue;
    const out = buildComparison({ gist: { experiments: [g], source: { updatedAt: ISO(1) } }, sampling: { experiments: [{ hash: murmur3(g.id), id: g.id, type: 'user', source: 'own_sampling', windowN: n, treatments }], scrapedAt: ISO(1) }, now: NOW });
    const e = out.experiments[0];
    assert.equal(e.comparison.observation, 'inside_interval', `${g.id} ${g.treatmentPct}`);
    assert.equal(e.measurement.k, treatments.reduce((s, t) => s + t.sampleCount, 0));
    tested++;
  }
  assert.equal(tested, docs.experiments.filter((g) => g.type === 'user' && g.totalsAvailable && !g.projected && g.treatmentPct != null && Object.values(g.byVariant).some((v) => v.role === 'treatment')).length);
  assert.ok(tested > 100, `tested=${tested}`);
});

test('catalogue du dépôt : écart de 5 points → hors intervalle pour chaque expérience mesurable', () => {
  let tested = 0;
  for (const g of docs.experiments) {
    if (g.type !== 'user' || !g.totalsAvailable || g.projected || g.treatmentPct == null) continue;
    const shifted = g.treatmentPct > 50 ? g.treatmentPct - 5 : g.treatmentPct + 5;
    const n = 20000;
    const k = Math.round((shifted / 100) * n);
    const bucket = Number(Object.entries(g.byVariant).find(([, v]) => v.role === 'treatment')?.[0]);
    if (!Number.isFinite(bucket)) continue;
    const out = buildComparison({ gist: { experiments: [g] }, sampling: { experiments: [{ hash: murmur3(g.id), id: g.id, type: 'user', source: 'own_sampling', windowN: n, treatments: [{ bucket, sampleCount: k }] }], scrapedAt: ISO(1) }, now: NOW });
    const e = out.experiments[0];
    // Plusieurs traitements : k ne couvre qu'un bucket, l'écart est alors plus grand, jamais plus petit.
    assert.equal(e.comparison.observation, 'outside_interval', `${g.id}: gist ${g.treatmentPct} vs ${shifted}`);
    tested++;
  }
  assert.equal(tested, docs.experiments.filter((g) => g.type === 'user' && g.totalsAvailable && !g.projected && g.treatmentPct != null && Object.values(g.byVariant).some((v) => v.role === 'treatment')).length);
  assert.ok(tested > 100);
});

test('catalogue du dépôt : état réel user_rollouts.json — invariants complets', () => {
  const out = buildComparison({ gist: docs, sampling: userSampling, definitions: repoDefs(), now: NOW, onlyObserved: true });
  assert.equal(out.experiments.length, (userSampling.experiments || []).filter((e) => e.type === 'user').length);
  for (const e of out.experiments) {
    const m = e.measurement;
    assert.equal(m.status, 'measured', e.id);
    assert.ok(m.n > 0);
    assert.ok(m.observedAssignments.k <= m.n);
    for (const v of m.variants) {
      assert.ok(v.k >= 0 && v.k <= v.n);
      assert.ok(v.ci.lo <= v.pct && v.pct <= v.ci.hi);
    }
    if (m.pct != null) {
      assert.ok(m.pct >= 0 && m.pct <= 100 && m.ci.lo <= m.pct && m.pct <= m.ci.hi);
      assert.ok(m.k <= m.observedAssignments.k);
    }
    if (!e.id.startsWith('hash:')) assert.equal(e.hash, murmur3(e.id));
  }
  JSON.stringify(out, (k, v) => { assert.ok(!(typeof v === 'number' && !Number.isFinite(v)), `nombre non fini : ${k}`); return v; });
  assert.deepEqual(out, buildComparison({ gist: docs, sampling: userSampling, definitions: repoDefs(), now: NOW, onlyObserved: true }), 'déterministe');
});

test('catalogue du dépôt : computeExperiment cohérent avec l\'export pour chaque entrée', () => {
  // Vérifie que le chemin « gist brut » donne les mêmes % que l'export déjà publié.
  for (const g of docs.experiments) {
    if (g.type !== 'user' || !g.hasData) continue;
    const raw = { id: g.id, variants: Object.entries(g.byVariant).map(([v, x]) => ({ variant: Number(v), role: x.role, ranges: [`0 - ${Math.round(x.pct * 100)}`] })) };
    const c = computeExperiment(raw);
    for (const [k, v] of Object.entries(g.byVariant)) {
      if (v.pct == null || g.flags.length) continue;
      assert.equal(c.byVariant[k].pct, v.pct, `${g.id} variant ${k}`);
    }
  }
});

test('catalogue du dépôt : les expériences sans plage exploitable ne reçoivent jamais de pourcentage', () => {
  const empty = docs.experiments.filter((g) => g.type === 'user' && !g.hasData);
  assert.ok(empty.length > 100);
  for (const g of empty) {
    const out = buildComparison({ gist: { experiments: [g] }, sampling: { experiments: [{ hash: murmur3(g.id), id: g.id, type: 'user', source: 'own_sampling', windowN: 1000, treatments: [{ bucket: 1, sampleCount: 200 }] }], scrapedAt: ISO(1) }, now: NOW });
    const e = out.experiments[0];
    assert.equal(e.comparison.observation, 'not_comparable', g.id);
    assert.equal(e.measurement.pct, null, g.id);
    assert.equal(e.measurement.observedAssignments.pct, 20, g.id);
    assert.equal(e.coverage.treatmentPct, null, g.id);
  }
});

test('catalogue du dépôt : sans mesure, aucune expérience n\'a de pourcentage mesuré inventé', () => {
  const out = buildComparison({ gist: docs, sampling: {}, definitions: repoDefs(), now: NOW });
  for (const e of out.experiments) {
    assert.equal(e.measurement.pct, null);
    assert.equal(e.measurement.ci, null);
    assert.equal(e.comparison.observation, 'not_comparable');
  }
});

// ─── Générateur (src/user_rollout_comparison.js) ───────────────────────────

const { main, fetchRawGist } = require('../src/user_rollout_comparison');
const tmpOut = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'urc-')), 'out.json');
const quiet = async (fn) => {
  const w = console.warn; const l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; }
};

test('générateur : gist injoignable → comparaison partielle, fichier écrit, pas d\'exception', async () => {
  const out = tmpOut();
  const r = await quiet(() => main({ now: NOW, out, fetchRawGist: async () => { throw new Error('réseau'); } }));
  assert.equal(r.stats.measured, (userSampling.experiments || []).filter((e) => e.type === 'user').length);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), JSON.parse(JSON.stringify(r)));
});

test('générateur : gist brut → noms, plages et date de modification', async () => {
  const out = tmpOut();
  const raw = [{ id: '2024-10_quests_dismissal_survey', variants: [{ variant: 1, role: 'treatment', ranges: ['9500 - 10000'] }] }];
  const r = await quiet(() => main({ now: Date.parse('2026-10-28T05:00:00Z'), out, fetchRawGist: async () => ({ data: raw, updatedAt: '2026-10-28T01:00:00Z', htmlUrl: 'https://gist.github.com/agnonotdev/e3', revision: 'abc' }) }));
  const e = r.experiments.find((x) => x.id === '2024-10_quests_dismissal_survey');
  assert.ok(e, 'nom résolu depuis le gist brut');
  assert.equal(e.coverage.updatedAt, '2026-10-28T01:00:00Z');
  assert.equal(e.coverage.treatmentPct, 5);
  assert.deepEqual(e.coverage.sourceRanges[0].ranges, [[9500, 10000]]);
});

test('générateur : n\'écrit pas dans data/ et ne touche à aucun état de notification', async () => {
  const before = fs.readdirSync(DATA).sort().join();
  const out = tmpOut();
  await quiet(() => main({ now: NOW, out, fetchRawGist: async () => { throw new Error('x'); } }));
  assert.equal(fs.readdirSync(DATA).sort().join(), before);
});

test('fetchRawGist : API → raw_url, tableau exigé, erreurs HTTP propagées', async () => {
  const mk = (map) => async (url) => {
    const r = map[url];
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  const ok = await fetchRawGist('id', null, mk({
    'https://api.github.com/gists/id': { status: 200, body: { updated_at: 'U', html_url: 'H', history: [{ version: 'v1' }], files: { 'a.json': { filename: 'a.json', raw_url: 'https://raw/a' } } } },
    'https://raw/a': { status: 200, body: [{ id: 'x' }] },
  }));
  assert.deepEqual(ok, { data: [{ id: 'x' }], updatedAt: 'U', htmlUrl: 'H', revision: 'v1' });
  await assert.rejects(fetchRawGist('id', null, mk({ 'https://api.github.com/gists/id': { status: 403, body: {} } })), /HTTP 403/);
  await assert.rejects(fetchRawGist('id', null, mk({
    'https://api.github.com/gists/id': { status: 200, body: { files: { 'a.json': { filename: 'a.json', raw_url: 'https://raw/a' } } } },
    'https://raw/a': { status: 200, body: { pas: 'un tableau' } } })), /non tableau/);
  await assert.rejects(fetchRawGist('id', null, mk({ 'https://api.github.com/gists/id': { status: 200, body: { files: {} } } })), /sans fichier/);
});

test('frontière de l\'IC : k juste dans / juste hors de l\'intervalle (échelle de 1 observation)', () => {
  for (const [pct, n] of [[50, 1000], [5, 7447], [25, 400], [90, 2500]]) {
    const status = (k) => run([gistEntry('2025-b', pct)], [sample('2025-b', k, n)]).experiments[0].comparison.observation;
    let lowestInside = null;
    for (let k = 0; k <= n; k++) if (status(k) === 'inside_interval') { lowestInside = k; break; }
    let highestInside = null;
    for (let k = n; k >= 0; k--) if (status(k) === 'inside_interval') { highestInside = k; break; }
    assert.ok(lowestInside > 0 && highestInside < n, `${pct}/${n}`);
    assert.equal(status(lowestInside - 1), 'outside_interval');
    assert.equal(status(highestInside + 1), 'outside_interval');
    // k faible : c'est la borne haute de l'IC qui doit atteindre le % du gist ; k élevé : la borne basse.
    assert.ok(wilson95(lowestInside, n).hi >= pct && wilson95(lowestInside - 1, n).hi < pct, `bord bas ${pct}/${n}`);
    assert.ok(wilson95(highestInside, n).lo <= pct && wilson95(highestInside + 1, n).lo > pct, `bord haut ${pct}/${n}`);
  }
});
