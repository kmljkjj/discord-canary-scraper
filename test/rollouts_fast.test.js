'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { main, shouldRun, guildSignature, probeGist } = require('../src/rollouts_fast.js');

test('shouldRun : initial, inchangé, changé, backoff, sonde KO', () => {
  const b = { first: false, cur: 'a', okSig: 'a', lastFailAt: 0, now: 1000, retryMs: 500 };
  assert.deepEqual(shouldRun({ ...b, first: true }), { run: true, reason: 'initial' });
  assert.equal(shouldRun(b).run, false);
  assert.deepEqual(shouldRun({ ...b, cur: 'b' }), { run: true, reason: 'changed' });
  assert.equal(shouldRun({ ...b, cur: 'b', lastFailAt: 800 }).reason, 'backoff');
  assert.equal(shouldRun({ ...b, cur: 'b', lastFailAt: 400 }).run, true);
  assert.equal(shouldRun({ ...b, cur: null }).reason, 'probe_failed');
  assert.deepEqual(shouldRun({ ...b, okSig: null }), { run: true, reason: 'retry' });
});

test('guildSignature : stable, indépendante de l’ordre, sensible aux plages', () => {
  const a = [[1, null, 0, [[[[1, [{ s: 0, e: 500 }]]], []]]], [2, null, 0, []]];
  assert.equal(guildSignature(a), guildSignature([a[1], a[0]]));
  const c = JSON.parse(JSON.stringify(a)); c[0][3][0][0][0][1][0].e = 600;
  assert.notEqual(guildSignature(a), guildSignature(c));
  assert.equal(guildSignature(null), null);
});

test('probeGist : 304 conditionnel, 200 avec révision/etag, erreur', async () => {
  let seen;
  const f304 = async (u, o) => { seen = o.headers; return { status: 304, ok: false }; };
  assert.equal((await probeGist('g', 'W/"e1"', f304, '')).status, 'unchanged');
  assert.equal(seen['If-None-Match'], 'W/"e1"');
  const f200 = async () => ({ status: 200, ok: true, headers: { get: () => 'W/"e2"' }, json: async () => ({ history: [{ version: 'abc1234' }] }) });
  assert.deepEqual(await probeGist('g', null, f200, ''), { status: 'changed', revision: 'abc1234', etag: 'W/"e2"' });
  const f403 = async () => ({ status: 403, ok: false });
  assert.deepEqual(await probeGist('g', null, f403, ''), { status: 'error', code: 403 });
});

function harness({ guildSigs, gistRevs, results = {} }) {
  let t = 0, gi = 0, ui = 0;
  const runs = [];
  return {
    runs,
    deps: {
      now: () => t,
      sleep: async (ms) => { t += ms; },
      watchMs: 10 * 60000, tickMs: 60000, gistId: 'g',
      probeGuild: async () => { const s = guildSigs[Math.min(gi++, guildSigs.length - 1)]; return s ? { sig: s } : null; },
      probeGist: async () => { const r = gistRevs[Math.min(ui++, gistRevs.length - 1)]; return r === 'ERR' ? { status: 'error', code: 500 } : { status: 'changed', revision: r, etag: r }; },
      runTracker: async (name) => { runs.push([name, t]); const q = results[name]; return q && q.length ? q.shift() : true; },
    },
  };
}

test('main : passe initiale puis uniquement sur changement', async () => {
  const h = harness({ guildSigs: ['g1', 'g1', 'g1', 'g2', 'g2'], gistRevs: ['r1', 'r1', 'r1', 'r1', 'r2', 'r2'] });
  h.deps.maxTicks = 6;
  const r = await main(h.deps);
  assert.equal(r.ticks, 6);
  assert.deepEqual(h.runs.map((x) => x[0]), ['guild', 'user', 'guild', 'user']);
  assert.equal(r.failures, 0);
});

test('main : un échec n’avance pas l’empreinte → retentative après backoff', async () => {
  const h = harness({ guildSigs: ['g1', 'g1', 'g2'], gistRevs: ['r1'], results: { guild: [true, false, true] } });
  h.deps.maxTicks = 9;
  const r = await main(h.deps);
  const guildRuns = h.runs.filter((x) => x[0] === 'guild');
  assert.equal(guildRuns.length, 3, 'initial + échec + retentative');
  assert.ok(guildRuns[2][1] - guildRuns[1][1] >= 5 * 60000, 'backoff respecté');
  assert.equal(r.failures, 1);
});

test('main : sonde KO → aucune passe hors initiale', async () => {
  const h = harness({ guildSigs: [null], gistRevs: ['ERR'] });
  h.deps.maxTicks = 4;
  await main(h.deps);
  assert.deepEqual(h.runs.map((x) => x[0]), ['guild', 'user']);
});
