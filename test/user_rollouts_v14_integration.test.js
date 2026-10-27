/**
 * Tests d'intégration V14 — user_rollouts.main() avec dépendances injectées :
 * état temporaire, sampler et webhook factices. Couvre les bugs corrigés :
 * notifications perdues après échec de webhook, annonces « new » retentées,
 * livraisons partielles par lots de 10, revisions retentées.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Notifier aussi les hash sans nom (les expériences de test n'existent pas
// dans data/experiments.json).
process.env.USER_ROLLOUT_NOTIFY_HASH = '1';

const { main } = require('../src/user_rollouts');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ur-v14-'));
}

/** Sampler factice : hash → { bucket → k }, k positions générées. */
function makeSampler(spec, ok = 400) {
  const byHash = new Map();
  const byRev = new Map();
  for (const [hash, { rev, buckets }] of Object.entries(spec)) {
    const m = new Map();
    const nBuckets = Object.keys(buckets).length;
    let slot = 0;
    for (const [bucket, k] of Object.entries(buckets)) {
      const positions = [];
      for (let i = 0; i < k; i++) {
        positions.push(Math.floor((slot + i * (900 / Math.max(k, 1))) % 10000));
      }
      slot += 900 / Math.max(nBuckets, 1);
      m.set(Number(bucket), positions);
    }
    byHash.set(Number(hash), m);
    byRev.set(Number(hash), rev ?? 1);
  }
  return async () => ({ byHash, byRev, ok, fail: 0 });
}

function makeTokenSnapshot(list) {
  return async () => list;
}

/** Webhook factice : file de résultats (un par lot envoyé). */
function makeWebhook(results) {
  const calls = [];
  const fn = async (embeds) => {
    calls.push(embeds);
    const r = results.length ? results.shift() : { ok: true, status: 204 };
    return r;
  };
  fn.calls = calls;
  return fn;
}

async function runMain(deps) {
  await main(deps);
  const code = process.exitCode;
  process.exitCode = 0;
  return code;
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'user_rollouts.json'), 'utf8'));
}

// ─── Scénario A : nouvelle expérience, échec webhook, retry ──────────────────

test('intégration : « new » non livré est retenté au run suivant', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const deps = { stateFile, reportFile };

  // Run 1 — seed avec l'expérience 900001 à 5 %.
  await runMain({
    ...deps,
    sampler: makeSampler({ 900001: { buckets: { 1: 20 } } }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: makeWebhook([]),
  });
  let st = readState(dir);
  assert.equal(st.experiments.length, 1);
  assert.ok(st.acknowledged['900001']);

  // Run 2 — nouvelle expérience 900002 (10 %), webhook KO.
  const wh = makeWebhook([{ ok: false, status: 429, text: 'rate' }]);
  const code = await runMain({
    ...deps,
    sampler: makeSampler({
      900001: { buckets: { 1: 20 } },
      900002: { buckets: { 1: 40 } },
    }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: wh,
  });
  assert.equal(code, 2, 'exitCode 2 après échec webhook');
  st = readState(dir);
  // L'état contient la nouvelle expérience, mais elle n'est PAS acknowledged.
  assert.equal(st.experiments.length, 2);
  assert.ok(!st.acknowledged['900002'], '900002 pas acknowledged');
  assert.equal(wh.calls.length, 1, 'un lot envoyé (échoué)');

  // Run 3 — mêmes mesures : l'annonce « new » est RETENTÉE et livrée.
  const wh2 = makeWebhook([{ ok: true, status: 204 }]);
  const code2 = await runMain({
    ...deps,
    sampler: makeSampler({
      900001: { buckets: { 1: 20 } },
      900002: { buckets: { 1: 40 } },
    }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: wh2,
  });
  assert.notEqual(code2, 2);
  st = readState(dir);
  assert.ok(st.acknowledged['900002'], '900002 acknowledged après livraison');
  assert.equal(wh2.calls.length, 1, 'retry envoyé');

  // Run 4 — plus aucun changement.
  const wh3 = makeWebhook([]);
  await runMain({
    ...deps,
    sampler: makeSampler({
      900001: { buckets: { 1: 20 } },
      900002: { buckets: { 1: 40 } },
    }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: wh3,
  });
  assert.equal(wh3.calls.length, 0, 'rien à renvoyer');
});

// ─── Scénario B : 12 changements, échec au 2e lot → livraison partielle ──────

test('intégration : >10 changements, échec au 2e lot, suite retentée', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const deps = { stateFile, reportFile };

  // Run 1 — seed avec 12 expériences à 5 % (k=20 sur n=400).
  const seedSpec = {};
  for (let i = 1; i <= 12; i++) seedSpec[String(910000 + i)] = { buckets: { 1: 20 } };
  await runMain({
    ...deps,
    sampler: makeSampler(seedSpec),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: makeWebhook([]),
  });
  let st = readState(dir);
  assert.equal(st.experiments.length, 12);

  // Run 2 — les 12 passent à 50 % (cumul 400/800) ; lot 1 OK, lot 2 KO.
  // NB : k est CUMULATIF sur la fenêtre → k(run2) = 400 − 20 (seed).
  const changedSpec = {};
  for (let i = 1; i <= 12; i++) changedSpec[String(910000 + i)] = { buckets: { 1: 380 } };
  const wh = makeWebhook([
    { ok: true, status: 204 },
    { ok: false, status: 500, text: 'boom' },
  ]);
  const code = await runMain({
    ...deps,
    sampler: makeSampler(changedSpec),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: wh,
  });
  assert.equal(code, 2);
  assert.equal(wh.calls.length, 2, 'deux lots tentés');
  st = readState(dir);
  const acked = Object.keys(st.acknowledged).filter(
    (h) => st.acknowledged[h].b && st.acknowledged[h].b['1'] === 50,
  );
  assert.equal(acked.length, 10, '10 acknowledged, 2 en attente');

  // Run 3 — les 2 restants sont livrés (delta vs acknowledged, pas vs mesure).
  // k(run3) = 600 − 400 pour rester à 50 % (cumul 600/1200).
  const stableSpec = {};
  for (let i = 1; i <= 12; i++) stableSpec[String(910000 + i)] = { buckets: { 1: 200 } };
  const wh2 = makeWebhook([{ ok: true, status: 204 }]);
  const code2 = await runMain({
    ...deps,
    sampler: makeSampler(stableSpec),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: wh2,
  });
  assert.notEqual(code2, 2);
  st = readState(dir);
  const acked2 = Object.keys(st.acknowledged).filter(
    (h) => st.acknowledged[h].b && st.acknowledged[h].b['1'] === 50,
  );
  assert.equal(acked2.length, 12, 'les 12 acknowledged au final');
  assert.equal(wh2.calls.length, 1, 'un seul lot de 2 embeds');
  assert.equal(wh2.calls[0].length, 2, 'exactement les 2 restants');
});

// ─── Scénario C : revision non livrée → retentée ────────────────────────────

test('intégration : annonce de revision perdue avant V14, retentée maintenant', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const deps = { stateFile, reportFile };

  // Run 1 — seed, token snapshot avec revision 5 (rev passée au sampler).
  await runMain({
    ...deps,
    sampler: makeSampler({ 900001: { rev: 5, buckets: { 1: 20 } } }),
    tokenSnapshot: makeTokenSnapshot([
      { hash: 900001, id: 'x', title: 'x', type: 'user', revision: 5, bucket: 1, hash_result: 100 },
    ]),
    postWebhook: makeWebhook([]),
  });

  // Run 2 — revision 6, webhook KO.
  const wh = makeWebhook([{ ok: false, status: 429, text: 'rate' }]);
  const code = await runMain({
    ...deps,
    sampler: makeSampler({ 900001: { buckets: { 1: 20 }, rev: 6 } }),
    tokenSnapshot: makeTokenSnapshot([
      { hash: 900001, id: 'x', title: 'x', type: 'user', revision: 6, bucket: 1, hash_result: 100 },
    ]),
    postWebhook: wh,
  });
  assert.equal(code, 2);
  let st = readState(dir);
  assert.equal(st.acknowledged['900001'].rev, 5, 'revision pas acknowledged');

  // Run 3 — revision 6 retentée et livrée.
  const wh2 = makeWebhook([{ ok: true, status: 204 }]);
  await runMain({
    ...deps,
    sampler: makeSampler({ 900001: { buckets: { 1: 20 }, rev: 6 } }),
    tokenSnapshot: makeTokenSnapshot([
      { hash: 900001, id: 'x', title: 'x', type: 'user', revision: 6, bucket: 1, hash_result: 100 },
    ]),
    postWebhook: wh2,
  });
  st = readState(dir);
  assert.equal(st.acknowledged['900001'].rev, 6, 'revision acknowledged');
});

// ─── Scénario D : expérience trop petite puis mesurable ──────────────────────

test('intégration : dégradé (trop peu d\'observations) puis mesurable', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const deps = { stateFile, reportFile };

  // Run 1 — seed.
  await runMain({
    ...deps,
    sampler: makeSampler({ 900001: { buckets: { 1: 200 } } }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: makeWebhook([]),
  });

  // Run 2 — 900002 avec k=2 : totalK < 3 → ignorée, pas d'annonce.
  const wh = makeWebhook([]);
  await runMain({
    ...deps,
    sampler: makeSampler({
      900001: { buckets: { 1: 200 } },
      900002: { buckets: { 1: 2 } },
    }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: wh,
  });
  assert.equal(wh.calls.length, 0);

  // Run 3 — 900002 k=40 → annoncée.
  const wh2 = makeWebhook([{ ok: true, status: 204 }]);
  await runMain({
    ...deps,
    sampler: makeSampler({
      900001: { buckets: { 1: 200 } },
      900002: { buckets: { 1: 40 } },
    }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: wh2,
  });
  assert.equal(wh2.calls.length, 1);
  const st = readState(dir);
  assert.ok(st.acknowledged['900002']);
});

// ─── Scénario E : delta contre une baseline acknowledged ancienne ───────────

test('intégration : delta calculé contre acknowledged, pas contre la dernière mesure', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'user_rollouts.json');
  const reportFile = path.join(dir, 'user_rollouts.md');
  const deps = { stateFile, reportFile };

  // Run 1 — seed à 5 % (k=20 sur n=400).
  await runMain({
    ...deps,
    sampler: makeSampler({ 900001: { buckets: { 1: 20 } } }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: makeWebhook([]),
  });

  // Run 2 — passe à 50 % (cumul 400/800 → k=380), webhook KO.
  await runMain({
    ...deps,
    sampler: makeSampler({ 900001: { buckets: { 1: 380 } } }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: makeWebhook([{ ok: false, status: 500, text: 'boom' }]),
  });
  let st = readState(dir);
  assert.equal(st.acknowledged['900001'].b['1'], 5, 'acknowledged reste à 5 %');
  assert.equal(st.experiments[0].treatments[0].pct, 50, 'mesure à 50 %');

  // Run 3 — reste à 50 % (cumul 600/1200 → k=200) : le changement 5 → 50
  // doit partir (baseline acknowledged = 5 %, même si la mesure précédente
  // disait déjà 50 %).
  const wh = makeWebhook([{ ok: true, status: 204 }]);
  await runMain({
    ...deps,
    sampler: makeSampler({ 900001: { buckets: { 1: 200 } } }),
    tokenSnapshot: makeTokenSnapshot([]),
    postWebhook: wh,
  });
  assert.equal(wh.calls.length, 1, 'le delta 5→50 est notifié (pas perdu)');
  st = readState(dir);
  assert.equal(st.acknowledged['900001'].b['1'], 50);
});
