'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.GIST_ROLLOUT_TEST_QUIET = '1';
process.env.USER_ROLLOUT_NOTIFY_HASH = '1';
const { murmur3 } = require('../src/lib/murmur3');
const W = require('../src/lib/wire_reconcile');
const { normalizeGistEntries, CANONICAL_ID, MIRROR_ID, DEFAULT_GIST_IDS, canonicalId } = require('../src/lib/gist_sources');
const gist = require('../src/gist_user_rollouts');
const { main } = require('../src/user_rollouts');

// ─── sources ────────────────────────────────────────────────────────────────
test('sources : canonique = gist complet vivant, miroir = copie réduite synchronisée', () => {
  assert.equal(CANONICAL_ID, 'fb2b6a7ba1301733aa5c2050b3e59a18');
  assert.deepEqual(DEFAULT_GIST_IDS, [CANONICAL_ID, MIRROR_ID]);
  assert.equal(canonicalId({}), CANONICAL_ID);
  assert.equal(canonicalId({ GIST_ROLLOUT_GIST_IDS: ' abc , def' }), 'abc');
});

test('normalizeGistEntries : forme du gist complet → forme réduite, idempotent', () => {
  const full = [
    { id: 'a', title: 'A', kind: 'user', hash: 1, rollout_status: 'ab_test', total: { to: 50 },
      variants: [{ variant: 0, role: 'control', from: 25, to: 50, change: 25, ranges: ['0 - 1000'] },
        { variant: 1, role: 'treatment', ranges: [] }, { variant: 2 }] },
    { id: 'b', kind: 'user', variants: [{ variant: 1 }] },
  ];
  const n = normalizeGistEntries(full);
  assert.deepEqual(n[0], { id: 'a', title: 'A', kind: 'user', variants: [{ variant: 0, role: 'control', ranges: ['0 - 1000'] }] });
  assert.deepEqual(n[1].variants, []);
  assert.deepEqual(normalizeGistEntries(n), n);
});

test('normalizeGistEntries : une variante MALFORMÉE reste visible pour la validation', () => {
  const bad = normalizeGistEntries([{ id: 'x', variants: [null, { variant: 1, ranges: 'oops' }] }]);
  assert.equal(bad[0].variants.length, 2);
  assert.equal(gist && typeof gist.main, 'function');
});

// ─── rapprochement pur ──────────────────────────────────────────────────────
test('gistCoverageByHash : seuls les totaux exacts sont retenus', () => {
  const docs = { experiments: [
    { id: '2025-11_tida_webform', hasData: true, totalsAvailable: true, treatmentPct: 100 },
    { id: 'amb', hasData: true, totalsAvailable: true, ambiguous: true, treatmentPct: 10 },
    { id: 'proj', hasData: true, totalsAvailable: true, projected: true, treatmentPct: 10 },
    { id: 'nod', hasData: false, totalsAvailable: false, treatmentPct: null },
  ] };
  const m = W.gistCoverageByHash(docs);
  assert.deepEqual([...m.keys()], [murmur3('2025-11_tida_webform')]);
  assert.equal(W.gistCoverageByHash(null).size, 0);
});

test('wireByHash / compareGistWire / wireField', () => {
  const ur = { experiments: [
    { hash: 5, status: 'estimated', windowN: 6000, treatments: [{ pctKnown: true, pct: 5.07, ci: { sigma: 0.28 } }] },
    { hash: 6, status: 'degraded', windowN: 6000, treatments: [{ pctKnown: true, pct: 5, ci: { sigma: 0.28 } }] },
    { hash: 7, status: 'estimated', windowN: 50, treatments: [{ pctKnown: true, pct: 5, ci: { sigma: 0.28 } }] },
  ] };
  const m = W.wireByHash(ur);
  assert.deepEqual([...m.keys()], [5]);
  assert.equal(W.compareGistWire(5, m.get(5)).verdict, 'consistent');
  const gap = W.compareGistWire(100, m.get(5));
  assert.equal(gap.verdict, 'gap');
  assert.equal(gap.delta, -94.93);
  assert.match(W.wireField(100, m.get(5)).value, /ÉCART/);
  assert.match(W.wireField(5, m.get(5)).value, /cohérent avec le gist/);
  assert.equal(W.wireField(5, null), null);
});

// ─── embed du gist : les deux chiffres dans un seul message ─────────────────
test('embed du gist : la mesure API est attachée (cohérent / écart)', () => {
  const raw = { id: 'e1', kind: 'user', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 500'] }] };
  const { list } = gist.computeAll([raw], new Map());
  const after = list[0];
  const wire = { pct: 5.07, sigma: 0.28, n: 6253, status: 'estimated' };
  const e = gist.buildEmbed({ kind: 'new', id: 'e1', before: null, after, deltaPct: null, wire }, { revision: 'abc', updatedAt: null });
  assert.ok(e.fields.some((f) => f.name === 'Mesure API Discord' && /cohérent/.test(f.value)));
  const e2 = gist.buildEmbed({ kind: 'new', id: 'e1', before: null, after, deltaPct: null, wire: { ...wire, pct: 60 } }, { revision: 'abc', updatedAt: null });
  assert.ok(e2.fields.some((f) => /ÉCART/.test(f.value)));
  const e3 = gist.buildEmbed({ kind: 'new', id: 'e1', before: null, after, deltaPct: null }, { revision: 'abc', updatedAt: null });
  assert.ok(!e3.fields.some((f) => f.name === 'Mesure API Discord'));
});

test('classification : le champ kind du gist complet complète les définitions locales, sans les écraser', () => {
  const rows = [
    { id: 'k-user', kind: 'user', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 100'] }] },
    { id: 'k-guild', kind: 'guild', variants: [] },
    { id: 'k-apex', kind: 'apex_user', variants: [] },
    { id: 'k-local', kind: 'installation', title: 'Titre du gist', variants: [] },
  ];
  const defs = new Map([['k-local', { type: 'user', title: 'k-local' }]]);
  const { byId } = gist.computeAll(rows, defs);
  assert.equal(byId['k-user'].type, 'user');
  assert.equal(byId['k-guild'].type, 'guild');
  assert.equal(byId['k-apex'].type, 'unclassified');
  assert.equal(byId['k-local'].type, 'user', 'la définition locale prime');
  assert.equal(byId['k-local'].title, 'Titre du gist', 'titre du gist quand la définition locale n’en a pas');
});

// ─── migration de source : pas de flood, vrais changements annoncés ──────────
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wgu-')); return { stateFile: path.join(d, 's.json'), reportFile: path.join(d, 'r.md') }; }
const row = (id, to) => ({ id, kind: 'user', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - ' + to] }] });
const fetchOf = (rows, gistId = CANONICAL_ID) => async () => ({
  source: { gistId, htmlUrl: 'h', rawUrl: 'r', updatedAt: '2026-10-28T17:52:02Z', revision: 'b3a1621a', fallback: false },
  data: rows, mirror: null,
});

test('migration : anciennes expériences notifiées si changées, nouvelles acquittées en silence, une seule fois', async () => {
  const paths = tmp();
  const sent = [];
  const post = async (e) => { sent.push(...e); return true; };
  const defs = new Map();
  const legacyRows = [row('old-same', 500), row('old-moved', 100)];
  await gist.main({ ...paths, quiet: true, defs, minEntries: 1, fetchGists: fetchOf(legacyRows, 'e3e99062983e6bd0feaef833f14fd931'), postWebhook: post }); // baseline silencieuse
  // état « ancienne génération » : sans classifierVersion
  const s = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')); delete s.classifierVersion; fs.writeFileSync(paths.stateFile, JSON.stringify(s));
  assert.equal(sent.length, 0);
  const live = [row('old-same', 500), row('old-moved', 2500), row('new-1', 300), row('new-2', 400)];
  const r1 = await gist.main({ ...paths, quiet: true, defs, minEntries: 1, fetchGists: fetchOf(live), postWebhook: post });
  assert.equal(r1.delivered, 1, 'seul le vrai changement est notifié');
  assert.match(sent[0].title, /old-moved/);
  const st = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
  assert.equal(st.classifierVersion, 2);
  assert.ok(st.acknowledged['new-1'] && st.acknowledged['new-2'], 'nouvelles expériences acquittées');
  assert.equal(st.lastRun.silentAck, 2);
  sent.length = 0;
  const r2 = await gist.main({ ...paths, quiet: true, defs, minEntries: 1, fetchGists: fetchOf([...live, row('later-new', 100)]), postWebhook: post });
  assert.equal(r2.delivered, 1, 'après migration, une vraie nouvelle expérience est annoncée');
  assert.match(sent[0].title, /later-new/);
});

// ─── un seul annonceur : le gist couvre → l'échantillonnage se tait ──────────
const sampler = (k, ok = 300) => async () => {
  const byHash = new Map([[910003, new Map([[1, Array.from({ length: k }, (_, i) => (i * 31) % 10000)]])]]);
  return { byHash, byRev: new Map([[910003, 0]]), ok, fail: 0 };
};
async function quiet(deps) {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { await main(deps); process.exitCode = 0; } finally { Object.assign(console, o); }
}
async function wireScenario(gistCoverage) {
  const paths = tmp(); let sent = 0;
  const postWebhook = async () => { sent += 1; return { ok: true, status: 204 }; };
  for (let i = 0; i < 6; i++) await quiet({ stateFile: paths.stateFile, reportFile: paths.reportFile, sampler: sampler(15), tokenSnapshot: async () => [], postWebhook, gistCoverage });
  for (let i = 0; i < 14; i++) await quiet({ stateFile: paths.stateFile, reportFile: paths.reportFile, sampler: sampler(150), tokenSnapshot: async () => [], postWebhook, gistCoverage });
  return { sent, state: JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) };
}

test('un seul annonceur : hash couvert par le gist → aucune notification de % côté échantillonnage', async () => {
  const covered = await wireScenario(new Map([[910003, { id: 'x', pct: 50 }]]));
  assert.equal(covered.sent, 0);
  assert.ok(covered.state.acknowledged['910003'], 'acquittement avancé en silence');
});

test('un seul annonceur (témoin) : hash NON couvert → l’échantillonnage annonce toujours le changement', async () => {
  const open = await wireScenario(new Map());
  assert.ok(open.sent >= 1);
});

test('USER_ROLLOUT_WIRE_DEDUPE=0 désactive la déduplication', async () => {
  process.env.USER_ROLLOUT_WIRE_DEDUPE = '0';
  try {
    const r = await wireScenario(new Map([[910003, { id: 'x', pct: 50 }]]));
    assert.ok(r.sent >= 1);
  } finally { delete process.env.USER_ROLLOUT_WIRE_DEDUPE; }
});
