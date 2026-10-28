/**
 * Pannes d'exposition : une expérience connue absente de TOUTES les réponses d'un lot
 * n'est pas un 0 % mesuré. Cas réel (28/10/2026) : 2025-11_tida_webform disparaissait de
 * lots entiers, l'estimation oscillait 93 → 98 % autour de ~100 % et chaque oscillation
 * partait en notification Discord (25 en 16 h).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.USER_ROLLOUT_NOTIFY_HASH = '1';
const { windowAggregate, detectOutages, main } = require('../src/user_rollouts');

const TIDA = 4055210228;

// Ancien algorithme (avant correction), recopié pour vérifier l'équivalence hors pannes.
function legacyAggregate(win) {
  const state = new Map();
  for (const b of win.batches) {
    const c = b.c || {}; const rev = b.rev || {}; const ok = Math.max(0, Number(b.ok) || 0);
    for (const hashS of Object.keys(c)) {
      const hash = Number(hashS); const r = rev[hashS]; const cur = state.get(hash);
      if (!cur || (r != null && cur.rev != null && cur.rev !== r)) state.set(hash, { counts: new Map(), n: 0, rev: r != null ? r : null });
      else if (cur && r != null && cur.rev == null) cur.rev = r;
    }
    for (const [hashS, cur] of state) {
      cur.n += ok;
      const buckets = c[hashS]; if (!buckets) continue;
      for (const [bS, k] of Object.entries(buckets)) cur.counts.set(Number(bS), (cur.counts.get(Number(bS)) || 0) + Number(k));
    }
  }
  return state;
}
const kOf = (m) => [...m.values()].reduce((s, x) => s + x, 0);
const mkBatch = (i, ok, spec, rev = 0) => ({ bid: 'b' + i, ts: 1000 + i, ok,
  rev: Object.fromEntries(Object.keys(spec).map((h) => [h, rev])),
  c: Object.fromEntries(Object.entries(spec).map(([h, k]) => [h, k == null ? undefined : { 1: k }]).filter(([, v]) => v)) });
const win = (batches) => ({ batches, pos: {} });
const rng = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const pct = (a, h) => (100 * kOf(a.winCounts.get(h))) / a.winN.get(h);

test('lot isolé sans aucune réponse contenant un hash à ~100 % : exclu, pas compté comme 0', () => {
  const batches = Array.from({ length: 20 }, (_, i) => mkBatch(i, 150, { 1: i === 7 ? null : 150, 2: 8 }));
  const a = windowAggregate(win(batches));
  assert.equal(a.winN.get(1), 19 * 150);
  assert.equal(pct(a, 1), 100);
  assert.deepEqual([...a.outages.get(1)], [7]);
  assert.equal(a.winN.get(2), 20 * 150, 'l\'autre expérience garde tous ses lots');
});

test('expérience à ~5 % : un 0 sur 150 improbable est une panne, un 0 sur 20 est normal', () => {
  const big = Array.from({ length: 20 }, (_, i) => mkBatch(i, 150, { 1: i === 5 ? null : 8, 2: 150 }));
  assert.deepEqual([...detectOutages(win(big)).get(1) || []], [5]);
  const small = Array.from({ length: 20 }, (_, i) => mkBatch(i, 20, { 1: i === 5 ? null : 1, 2: 20 }));
  assert.equal(detectOutages(win(small)).get(1), undefined, '0.95^20 = 36 % : rien d\'anormal');
});

test('retrait réel : absence jusqu\'au dernier lot (≥ 4) conservée comme 0 ; 3 lots seulement = panne en cours', () => {
  const mk = (tail) => Array.from({ length: 20 }, (_, i) => mkBatch(i, 150, { 1: i >= 20 - tail ? null : 150, 2: 150 }));
  const removed = windowAggregate(win(mk(4)));
  assert.equal(removed.winN.get(1), 20 * 150);
  assert.equal(removed.outages.get(1), undefined);
  assert.ok(pct(removed, 1) < 85, 'le retrait fait baisser le pourcentage');
  const pending = windowAggregate(win(mk(3)));
  assert.equal(pct(pending, 1), 100);
  assert.equal(pending.winN.get(1), 17 * 150);
});

test('panne longue au milieu de la fenêtre puis retour : exclue', () => {
  const batches = Array.from({ length: 30 }, (_, i) => mkBatch(i, 150, { 1: i >= 10 && i < 16 ? null : 150, 2: 150 }));
  const a = windowAggregate(win(batches));
  assert.equal(pct(a, 1), 100);
  assert.equal(a.outages.get(1).size, 6);
});

test('changement de révision : une absence avant le reset ne pollue pas la nouvelle configuration', () => {
  const batches = [
    ...Array.from({ length: 8 }, (_, i) => mkBatch(i, 150, { 1: i === 3 ? null : 150, 2: 150 }, 0)),
    ...Array.from({ length: 8 }, (_, i) => mkBatch(8 + i, 150, { 1: 75, 2: 150 }, 1)),
  ];
  const a = windowAggregate(win(batches));
  assert.equal(a.winN.get(1), 8 * 150, 'n repart de la révision 1');
  assert.equal(pct(a, 1), 50);
  assert.equal(a.outages.get(1), undefined);
});

test('équivalence : sans lot absent, résultat identique à l\'ancien algorithme (propriété, 300 fenêtres)', () => {
  const r = rng(99);
  for (let t = 0; t < 300; t++) {
    const nb = 5 + Math.floor(r() * 40);
    const batches = Array.from({ length: nb }, (_, i) => {
      const ok = 20 + Math.floor(r() * 150);
      const spec = {};
      for (const h of [1, 2, 3]) if (i >= (h === 3 ? 4 : 0)) spec[h] = Math.max(1, Math.floor(ok * [0.5, 0.05, 0.9][h - 1] * (0.8 + 0.4 * r())));
      return mkBatch(i, ok, spec, t % 3 === 0 && i > nb / 2 ? 1 : 0);
    });
    const legacy = legacyAggregate(win(batches)); const a = windowAggregate(win(batches));
    for (const [h, cur] of legacy) {
      assert.equal(a.winN.get(h), cur.n, `n hash ${h} fenêtre ${t}`);
      assert.equal(kOf(a.winCounts.get(h)), kOf(cur.counts));
    }
  }
});

test('robustesse : fenêtres vides, malformées, ok = 0, sans exception', () => {
  for (const w of [null, undefined, {}, { batches: null }, { batches: [] }, { batches: [{}] }, { batches: [{ ok: 0, c: { 1: { 1: 5 } } }, { ok: 0, c: {} }] }]) {
    assert.doesNotThrow(() => windowAggregate(w));
  }
  const a = windowAggregate({ batches: [{ ok: 0, c: { 1: { 1: 5 } } }, { ok: 0, c: {} }] });
  assert.equal(a.winN.get(1), 0);
});

test('seuil configurable (USER_ROLLOUT_OUTAGE_P0=0 désactive la détection)', () => {
  const batches = Array.from({ length: 20 }, (_, i) => mkBatch(i, 150, { 1: i === 7 ? null : 150, 2: 8 }));
  process.env.USER_ROLLOUT_OUTAGE_P0 = '0';
  try {
    const a = windowAggregate(win(batches));
    assert.equal(a.winN.get(1), 20 * 150);
    assert.ok(pct(a, 1) < 100);
  } finally { delete process.env.USER_ROLLOUT_OUTAGE_P0; }
});

test('jeu réel : fenêtre de production du 28/10/2026 — tida redevient 100 %, les autres sont inchangées', () => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'user_rollouts_window_20261028.json'), 'utf8'));
  assert.equal(f.batches.length, 60);
  const a = windowAggregate(win(f.batches));
  const legacy = legacyAggregate(win(f.batches));
  assert.deepEqual([...a.outages.get(TIDA)].sort((x, y) => x - y), [16, 32, 35]);
  assert.equal(kOf(a.winCounts.get(TIDA)), a.winN.get(TIDA), 'tida : k = n, 100 %');
  assert.ok(100 * kOf(legacy.get(TIDA).counts) / legacy.get(TIDA).n < 96, 'l\'ancien calcul donnait ~95,3 %');
  for (const [h, cur] of legacy) {
    if (h === TIDA) continue;
    assert.equal(a.winN.get(h), cur.n, `hash ${h} inchangé`);
    assert.equal(kOf(a.winCounts.get(h)), kOf(cur.counts));
  }
});

// ─── bout en bout : plus de notification quand l'expérience clignote ─────────

function tmpState() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-outage-')); return { stateFile: path.join(d, 'user_rollouts.json'), reportFile: path.join(d, 'user_rollouts.md') }; }
const sampler = (spec, ok = 300) => async () => {
  const byHash = new Map(); const byRev = new Map();
  for (const [h, k] of Object.entries(spec)) {
    if (k == null) continue;
    byHash.set(Number(h), new Map([[1, Array.from({ length: k }, (_, i) => (i * 31) % 10000)]]));
    byRev.set(Number(h), 0);
  }
  return { byHash, byRev, ok, fail: 0 };
};
async function quietMain(deps) {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { await main(deps); const c = process.exitCode; process.exitCode = 0; return c; } finally { Object.assign(console, o); }
}
async function scenario(pattern) {
  const paths = tmpState(); const calls = [];
  const postWebhook = async (embeds) => { calls.push(embeds); return { ok: true, status: 204 }; };
  for (const present of pattern) {
    await quietMain({ ...paths, sampler: sampler({ 910001: present ? 300 : null, 910002: 15 }), tokenSnapshot: async () => [], postWebhook });
  }
  return calls.length;
}

test('bout en bout : une expérience à 100 % qui clignote ne déclenche aucune notification', async () => {
  const pattern = [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1];
  assert.equal(await scenario(pattern), 0);
});

test('bout en bout (témoin) : sans la détection, le même scénario notifie', async () => {
  process.env.USER_ROLLOUT_OUTAGE_P0 = '0';
  try {
    const pattern = [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1];
    assert.ok((await scenario(pattern)) > 0, 'le scénario doit reproduire le spam sans correction');
  } finally { delete process.env.USER_ROLLOUT_OUTAGE_P0; }
});

test('bout en bout : un vrai retrait (absent ≥ 4 runs) est toujours annoncé', async () => {
  const pattern = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.ok((await scenario(pattern)) >= 1);
});
