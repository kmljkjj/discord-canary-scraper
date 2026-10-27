/**
 * Tests V15 — adaptateur gist communautaire (plages exactes publiées) :
 * parsing, union de plages, variants « none », ambiguïtés, collisions de
 * hash, sélection du gist le plus récent, et intégration main() (config
 * attachée aux mesures, notifications de changement avec retry, stale).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.USER_ROLLOUT_NOTIFY_HASH = '1';

const {
  parseRange,
  unionWidth,
  parseRolloutsTag,
  fetchGistSnapshot,
} = require('../src/lib/gist_source');
const { main } = require('../src/user_rollouts');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gist-v15-'));
}

// ─── Unités pures : plages et unions ─────────────────────────────────────────

test('parseRange : format « a - b », bornes valides seulement', () => {
  assert.deepEqual(parseRange('0 - 10000'), [0, 10000]);
  assert.deepEqual(parseRange('400 - 700'), [400, 700]);
  assert.equal(parseRange('10000 - 0'), null); // inversé
  assert.equal(parseRange('0 - 10001'), null); // hors échelle
  assert.equal(parseRange('abc'), null);
  assert.equal(parseRange('500 - 500'), null); // vide
});

test('unionWidth : les chevauchements et doublons ne comptent pas double', () => {
  // Plages disjointes → somme simple.
  assert.equal(unionWidth(['0 - 100', '200 - 300']).width, 200);
  // Chevauchement interne (cas réel du gist : 0-2500 ⊥ 500-1500) → UNION.
  assert.equal(unionWidth(['0 - 2500', '500 - 1500']).width, 2500);
  assert.equal(unionWidth(['0 - 2500', '500 - 1500']).overlaps, true);
  // Doublon exact entre variants → une seule fois.
  assert.equal(unionWidth(['400 - 700', '400 - 700']).width, 300);
  // Plage invalide ignorée.
  assert.equal(unionWidth(['0 - 100', 'nul']).width, 100);
});

test('parseRolloutsTag : variant « none » (not_eligible) jamais comptée', () => {
  const parsed = parseRolloutsTag([
    {
      id: '2026-01_test_exp',
      variants: [
        { variant: 'none', role: 'not_eligible', ranges: ['0 - 10000'] },
        { variant: 1, role: 'treatment', ranges: ['0 - 5000'] },
      ],
    },
  ]);
  assert.equal(parsed.count, 1);
  const e = parsed.byHash.get(parsed.byHash.keys().next().value);
  assert.equal(e.treatment.pct, 50); // pas 150 : « none » exclu
  assert.deepEqual(
    e.roles.map((r) => [r.bucket, r.role]),
    [
      [null, 'not_eligible'],
      [1, 'treatment'],
    ],
  );
});

test('parseRolloutsTag : union entre variants treatment qui se chevauchent', () => {
  const parsed = parseRolloutsTag([
    {
      id: '2026-01_dup_exp',
      variants: [
        { variant: 1, role: 'treatment', ranges: ['400 - 700', '1000 - 1500'] },
        { variant: 2, role: 'treatment', ranges: ['400 - 700', '2000 - 2100'] },
      ],
    },
  ]);
  const e = parsed.byHash.get(parsed.byHash.keys().next().value);
  // 300 + 500 + 100 = 900 points d'union, pas 1200 (doublon 400-700).
  assert.equal(e.treatment.pct, 9);
  assert.equal(e.ambiguous, true); // plages dupliquées entre variants
});

test('parseRolloutsTag : contrôle séparé, enregistrements ambigus signalés', () => {
  const parsed = parseRolloutsTag([
    {
      id: '2026-01_ab_exp',
      variants: [
        { variant: 0, role: 'control', ranges: ['0 - 500'] },
        { variant: 1, role: 'treatment', ranges: ['500 - 1000'] },
      ],
    },
  ]);
  const e = parsed.byHash.get(parsed.byHash.keys().next().value);
  assert.equal(e.control.pct, 5);
  assert.equal(e.treatment.pct, 5);
  assert.equal(e.ambiguous, false); // plages disjointes → propre
});

test('parseRolloutsTag : collisions de hash détectées, entrées invalides ignorées', () => {
  const parsed = parseRolloutsTag([
    { id: '2026-01_a', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 100'] }] },
    { id: '2026-01_a', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 200'] }] },
    { nope: true },
    { id: '2026-01_b', variants: [{ variant: 1, role: 'treatment', ranges: ['zut'] }] },
  ]);
  // 'b' est conservée (id valide, plages invalides → couverture null,
  // jamais un 0 % inventé) ; le doublon 'a' est écarté.
  assert.equal(parsed.count, 2);
  assert.equal(parsed.hashCollisions, 1);
  assert.equal(parsed.malformedRanges, 1);
  const { murmur3 } = require('../src/lib/murmur3');
  const b = parsed.byHash.get(murmur3('2026-01_b'));
  assert.equal(b.treatment, null);
});

test('parseRolloutsTag : hash = murmur3(id), cohérent avec la jointure mesures', () => {
  const { murmur3 } = require('../src/lib/murmur3');
  const parsed = parseRolloutsTag([
    { id: '2025-06_client_heartbeat_skipped', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 500'] }] },
  ]);
  const hash = murmur3('2025-06_client_heartbeat_skipped');
  assert.ok(parsed.byHash.has(hash));
});

// ─── fetchGistSnapshot : sélection et échec ─────────────────────────────────

test('fetchGistSnapshot : choisit le gist le plus récent par publishedAt', async () => {
  const mkBody = (entries, updated) => ({
    ok: true,
    json: async () => ({
      updated_at: updated,
      history: [{ version: 'v' + updated }],
      files: { 'rollouts-tag.json': { content: JSON.stringify(entries) } },
    }),
  });
  const fetchImpl = async (url) => {
    if (url.includes('gist-older')) return mkBody([{ id: 'old', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 100'] }] }], '2026-10-01T00:00:00Z');
    return mkBody([{ id: 'new', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 200'] }] }], '2026-10-27T00:00:00Z');
  };
  const snap = await fetchGistSnapshot(fetchImpl, ['gist-older', 'gist-newer']);
  assert.equal(snap.ok, true);
  const e = snap.parsed.byHash.get(snap.parsed.byHash.keys().next().value);
  assert.equal(e.id, 'new');
  assert.equal(snap.provenance.publishedAt, '2026-10-27T00:00:00Z');
  assert.ok(snap.provenance.gistId);
});

test('fetchGistSnapshot : tous les gists indisponibles → ok:false, pas de 0 % inventé', async () => {
  const fetchImpl = async () => ({ ok: false });
  const snap = await fetchGistSnapshot(fetchImpl, ['a', 'b']);
  assert.equal(snap.ok, false);
});

test('fetchGistSnapshot : gist le plus récent VIDE → candidat rejeté, pas d\'écrasement', async () => {
  // Deux variants du même schéma de fetch : l'un plus récent mais vide.
  const mkBody = (entries, updated) => ({
    ok: true,
    json: async () => ({
      updated_at: updated,
      history: [{ version: 'v' + updated }],
      files: { 'rollouts-tag.json': { content: JSON.stringify(entries) } },
    }),
  });
  let callNewer = false;
  const fetchImpl = async (url) => {
    if (url.includes('gist-newer')) {
      callNewer = true;
      return mkBody([], '2026-10-27T00:00:00Z'); // récent mais VIDE
    }
    return mkBody(
      [{ id: 'old', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 100'] }] }],
      '2026-10-01T00:00:00Z'
    );
  };
  const snap = await fetchGistSnapshot(fetchImpl, ['gist-older', 'gist-newer']);
  assert.ok(callNewer, 'le gist le plus récent (vide) a bien été consulté');
  // Le snapshot VIDE est écarté (pas d'écrasement) et le gist plus ANCIEN
  // VALIDE gagne — dégradation propre, jamais de « [] » accepté comme
  // donnée fraîche.
  assert.equal(snap.ok, true, 'repli sur le gist plus ancien valide');
  const e = snap.parsed.byHash.get(snap.parsed.byHash.keys().next().value);
  assert.equal(e.id, 'old', 'données de l\'ancien gist, pas du vide');
  assert.equal(snap.provenance.publishedAt, '2026-10-01T00:00:00Z');
});

// ─── Intégration main() : config publiée + notifications ────────────────────

function makeGistSnapshot(experiments, updated = '2026-10-27T12:00:00Z') {
  return async () => ({
    ok: true,
    stale: false,
    parsed: parseRolloutsTag(experiments),
    provenance: {
      gistId: 'test-gist',
      version: 'abc',
      publishedAt: updated,
      fetchedAt: '2026-10-27T12:01:00Z',
      source: 'gist communautaire (agnonotdev)',
    },
  });
}

function makeSampler(spec, ok = 400) {
  const byHash = new Map();
  const byRev = new Map();
  for (const [hash, { rev, buckets }] of Object.entries(spec)) {
    const m = new Map();
    for (const [bucket, k] of Object.entries(buckets)) {
      m.set(Number(bucket), Array.from({ length: k }, (_, i) => i));
    }
    byHash.set(Number(hash), m);
    byRev.set(Number(hash), rev ?? 1);
  }
  return async () => ({ byHash, byRev, ok, fail: 0 });
}

const { murmur3 } = require('../src/lib/murmur3');
const H1 = murmur3('2026-01_config_exp');

// main() loggue beaucoup : console neutralisée pendant l'appel (évite la
// corruption du canal du test runner sous `node --test`).
async function runMain(deps) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    await main(deps);
    const code = process.exitCode;
    process.exitCode = 0;
    return code;
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

test('intégration : multi-treatments publiés (25 % + 25 %) vs mesurés (25/25) → « cohérent », pas de faux écart', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const HM = murmur3('2026-01_multi_exp');

  // Gist : DEUX variants treatment, 25 % chacun (plages disjointes, pas
  // d'ambiguïté). Mesure propre : bucket 1 à 100/400, bucket 2 à 100/400.
  // La comparaison doit se faire BUCKET À BUCKET (25 ↔ 25), jamais union
  // (50 %) contre un seul bucket mesuré (25 %) — sinon faux « écart ».
  const gistMulti = [
    {
      id: '2026-01_multi_exp',
      variants: [
        { variant: 1, role: 'treatment', ranges: ['0 - 2500'] },
        { variant: 2, role: 'treatment', ranges: ['2500 - 5000'] },
      ],
    },
  ];
  await runMain({
    stateFile,
    reportFile,
    gistSnapshot: makeGistSnapshot(gistMulti),
    sampler: makeSampler({ [HM]: { buckets: { 1: 100, 2: 100 } } }),
    tokenSnapshot: async () => [],
    postWebhook: async () => ({ ok: true, status: 204 }),
  });

  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const measured = st.experiments.find((e) => e.hash === HM);
  assert.ok(measured, 'expérience mesurée présente');
  // Contrat de données (advisor) : config de l'état ↔ table exacte.
  assert.equal(measured.config.pct, 50, 'union publiée = 50 %');
  assert.deepEqual(measured.config.b, { '1': 25, '2': 25 }, 'config par bucket');
  const table = JSON.parse(fs.readFileSync(path.join(dir, 'user_rollouts_exact.json'), 'utf8'));
  const tEntry = table.experiments.find((x) => x.hash === HM);
  assert.ok(tEntry, 'entrée table présente');
  assert.equal(tEntry.treatmentPct, 50, 'table : union = 50 %');
  assert.deepEqual(tEntry.b, { '1': 25, '2': 25 }, 'table : par bucket');
  // Chaque 25 % publié tombe dans l'IC Wilson du bucket mesuré (25 %,
  // n = 400 → IC ≈ [21,2 ; 29,8]) → « cohérent », AUCUN écart signalé.
  // (Le mot « écart non expliqué » figure dans le préambule de méthode —
  // on vérifie la LIGNE de tableau de l'expérience, pas le document entier.)
  const md = fs.readFileSync(reportFile, 'utf8');
  const row = md.split('\n').find((l) => l.includes(String(HM)) && l.startsWith('|'));
  assert.ok(row, 'ligne de tableau présente');
  assert.match(row, /\| cohérent \|/, 'comparaison bucket à bucket → cohérent');
  assert.doesNotMatch(row, /écart non expliqué/, 'pas de faux écart');
});

test('intégration : premier run avec gist → seed silencieux, état + table exacte écrites', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const deps = { stateFile, reportFile };

  const gistExp = [
    { id: '2026-01_config_exp', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 500'] }] },
  ];
  await runMain({
    ...deps,
    gistSnapshot: makeGistSnapshot(gistExp),
    sampler: makeSampler({ [H1]: { buckets: { 1: 20 } } }),
    tokenSnapshot: async () => [],
    postWebhook: async () => ({ ok: true, status: 204 }),
  });
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // ackConfig seedé silencieusement (pas de notification de masse).
  assert.equal(st.ackConfig[String(H1)].pct, 5);
  assert.equal(st.gist.count, 1);
  assert.equal(st.gist.stale, false);
  // Table complète pour la page.
  const table = JSON.parse(fs.readFileSync(path.join(dir, 'user_rollouts_exact.json'), 'utf8'));
  assert.equal(table.count, 1);
  assert.equal(table.experiments[0].treatmentPct, 5);
  // Config attachée à l'expérience mesurée (même hash).
  const measured = st.experiments.find((e) => e.hash === H1);
  assert.ok(measured, 'expérience mesurée présente');
  assert.equal(measured.config.pct, 5);
  // Rapport : colonnes config + comparabilité.
  const md = fs.readFileSync(reportFile, 'utf8');
  assert.match(md, /Config publiée/);
  assert.match(md, /plages publiées par la communauté/);
});

test('intégration : changement de couverture publiée → notifié, avec retry après échec', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const deps = { stateFile, reportFile };

  const gistA = [
    { id: '2026-01_config_exp', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 500'] }] },
  ];
  await runMain({
    ...deps,
    gistSnapshot: makeGistSnapshot(gistA),
    sampler: makeSampler({}),
    tokenSnapshot: async () => [],
    postWebhook: async () => ({ ok: true, status: 204 }),
  });

  // Run 2 : la couverture publiée passe de 5 % à 50 % ; webhook KO.
  const gistB = [
    { id: '2026-01_config_exp', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 5000'] }] },
  ];
  const whCalls = [];
  const code = await runMain({
    ...deps,
    gistSnapshot: makeGistSnapshot(gistB, '2026-10-27T15:00:00Z'),
    sampler: makeSampler({}),
    tokenSnapshot: async () => [],
    postWebhook: async (embeds) => {
      whCalls.push(embeds);
      return { ok: false, status: 429, text: 'rate' };
    },
  });
  assert.equal(code, 2);
  let st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(st.ackConfig[String(H1)].pct, 5, 'baseline config non avancée après échec');

  // Run 3 : même snapshot → le changement est RETENTÉ puis livré.
  const code2 = await runMain({
    ...deps,
    gistSnapshot: makeGistSnapshot(gistB, '2026-10-27T15:00:00Z'),
    sampler: makeSampler({}),
    tokenSnapshot: async () => [],
    postWebhook: async (embeds) => {
      whCalls.push(embeds);
      return { ok: true, status: 204 };
    },
  });
  assert.notEqual(code2, 2);
  st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(st.ackConfig[String(H1)].pct, 50, 'baseline config avancée après livraison');
  assert.ok(whCalls.length >= 2, 'retry bien effectué');
});

test('intégration : gist indisponible → état conservé marqué stale, pas de notification fantôme', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const deps = { stateFile, reportFile };

  const gistA = [
    { id: '2026-01_config_exp', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 500'] }] },
  ];
  // Run 1 AVEC mesure : l'expérience est mesurée ET la config attachée —
  // le run 2 (gist indisponible) doit conserver les deux.
  await runMain({
    ...deps,
    gistSnapshot: makeGistSnapshot(gistA),
    sampler: makeSampler({ [H1]: { buckets: { 1: 20 } } }),
    tokenSnapshot: async () => [],
    postWebhook: async () => ({ ok: true, status: 204 }),
  });

  const whCalls = [];
  const code = await runMain({
    ...deps,
    gistSnapshot: async () => ({ ok: false }),
    sampler: makeSampler({ [H1]: { buckets: { 1: 20 } } }),
    tokenSnapshot: async () => [],
    postWebhook: async (embeds) => {
      whCalls.push(embeds);
      return { ok: true, status: 204 };
    },
  });
  assert.notEqual(code, 2);
  assert.equal(whCalls.length, 0, 'aucune notification quand le gist est indisponible');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(st.gist.stale, true);
  assert.equal(st.ackConfig[String(H1)].pct, 5, 'baseline conservée');
  // La table exacte précédente n'est pas écrasée par un snapshot vide.
  assert.ok(fs.existsSync(path.join(dir, 'user_rollouts_exact.json')));
  const table = JSON.parse(fs.readFileSync(path.join(dir, 'user_rollouts_exact.json'), 'utf8'));
  assert.equal(table.count, 1);
  // Contrat de données (advisor) : la table conservée est marquée stale,
  // et l'expérience mesurée RETIENT sa config (pct + publié à).
  assert.equal(table.stale, true, 'table marquée stale après échec');
  const measured = st.experiments.find((e) => e.hash === H1);
  assert.ok(measured, 'expérience mesurée conservée');
  assert.equal(measured.config.pct, 5, 'config publiée conservée sur la mesure');
  assert.ok(measured.config.publishedAt, 'date de publication conservée');
  // Le rapport mentionne l'indisponibilité sans casser la provenance
  // (formulation réelle : « dernier snapshot indisponible (stale) »).
  const md = fs.readFileSync(reportFile, 'utf8');
  assert.match(md, /dernier snapshot indisponible/);
});
