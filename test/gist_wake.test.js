'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, main, EVENT } = require('../src/gist_wake.js');

const NOW = Date.parse('2026-10-28T12:30:00Z');
const base = { localRevision: 'aaaaaaa1', localFetchedAt: '2026-10-28T12:20:00Z', remoteRevision: 'aaaaaaa1', now: NOW, maxAgeMin: 25 };

test('decide: révision identique et état récent → pas de réveil', () => {
  assert.deepEqual(decide(base), { wake: false, reason: 'up_to_date' });
});
test('decide: révision distante différente → réveil', () => {
  assert.deepEqual(decide({ ...base, remoteRevision: 'bbbbbbb2' }), { wake: true, reason: 'revision_changed' });
});
test('decide: état plus vieux que le seuil → réveil de sécurité', () => {
  assert.equal(decide({ ...base, localFetchedAt: '2026-10-28T11:00:00Z' }).reason, 'stale_state');
  assert.equal(decide({ ...base, localFetchedAt: '2026-10-28T12:05:01Z' }).wake, false);
});
test('decide: révision distante inconnue → jamais de réveil', () => {
  assert.equal(decide({ ...base, remoteRevision: null }).wake, false);
});
test('decide: état local vide ou sans date → réveil', () => {
  assert.equal(decide({ ...base, localRevision: null }).wake, true);
  assert.equal(decide({ ...base, localFetchedAt: null }).wake, true);
});

function fakeFetch(remoteVersion, calls, dispatchStatus = 204) {
  return async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('/dispatches')) return { ok: dispatchStatus < 300, status: dispatchStatus };
    return { ok: true, status: 200, json: async () => ({ history: [{ version: remoteVersion }] }) };
  };
}
function stateFile(rev, fetchedAt) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')), 's.json');
  fs.writeFileSync(f, JSON.stringify({ source: { gistId: 'g1', revision: rev, fetchedAt } }));
  return f;
}

test('main: changement → un seul dispatch trigger-gist-user-rollouts, lecture du gist sans jeton', async () => {
  const calls = [];
  const r = await main({ fetch: fakeFetch('bbbbbbb2', calls), token: 'tok', repo: 'o/r', now: NOW, stateFile: stateFile('aaaaaaa1', '2026-10-28T12:25:00Z') });
  assert.equal(r.dispatched, true);
  const d = calls.filter((c) => c.url.includes('/dispatches'));
  assert.equal(d.length, 1);
  assert.equal(d[0].url, 'https://api.github.com/repos/o/r/dispatches');
  assert.equal(JSON.parse(d[0].opts.body).event_type, EVENT);
  assert.equal(d[0].opts.headers.Authorization, 'Bearer tok');
  const g = calls.find((c) => c.url.includes('/gists/g1'));
  assert.ok(g && !g.opts.headers.Authorization);
});
test('main: aucun changement → aucun dispatch', async () => {
  const calls = [];
  const r = await main({ fetch: fakeFetch('aaaaaaa1', calls), token: 'tok', repo: 'o/r', now: NOW, stateFile: stateFile('aaaaaaa1', '2026-10-28T12:25:00Z') });
  assert.equal(r.dispatched, false);
  assert.equal(calls.filter((c) => c.url.includes('/dispatches')).length, 0);
});
test('main: dry-run et absence de jeton → pas de dispatch', async () => {
  const calls = [];
  const sf = stateFile('aaaaaaa1', '2026-10-28T12:25:00Z');
  assert.equal((await main({ fetch: fakeFetch('bbbbbbb2', calls), token: 't', repo: 'o/r', now: NOW, stateFile: sf, dryRun: true })).dispatched, false);
  assert.equal((await main({ fetch: fakeFetch('bbbbbbb2', calls), token: '', repo: 'o/r', now: NOW, stateFile: sf, dryRun: false })).dispatched, false);
  assert.equal(calls.filter((c) => c.url.includes('/dispatches')).length, 0);
});
test('main: échec du dispatch → rejet (l’étape CLI l’absorbe, exit 0)', async () => {
  await assert.rejects(main({ fetch: fakeFetch('bbbbbbb2', [], 403), token: 't', repo: 'o/r', now: NOW, stateFile: stateFile('aaaaaaa1', '2026-10-28T12:25:00Z') }));
});
