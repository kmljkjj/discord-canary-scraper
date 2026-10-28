#!/usr/bin/env node
/**
 * Génère data/user_rollout_comparison.json : couverture du gist (non vérifiée)
 * et observations de l'API Discord, côte à côte. Lecture seule : aucun
 * webhook, aucun état de notification, aucun appel Discord. Seul le gist public
 * est lu (échec = comparaison sans noms/plages supplémentaires, jamais fatal).
 */
'use strict';
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const { writeJsonAtomic } = require('./lib/atomic');
const { buildComparison } = require('./lib/user_rollout_comparison');

const DATA = path.join(__dirname, '..', 'data');
const GIST_ID = process.env.GIST_ROLLOUT_GIST_IDS?.split(',')[0]?.trim() || 'e3e99062983e6bd0feaef833f14fd931';

async function readJson(file, fallback) {
  try { return await fs.readJson(path.join(DATA, file)); } catch { return fallback; }
}

async function fetchRawGist(id, token, fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'discord-canary-scraper', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const meta = await fetchImpl(`https://api.github.com/gists/${encodeURIComponent(id)}`, { headers, timeout: 20000 });
  if (!meta.ok) throw new Error(`gist HTTP ${meta.status}`);
  const j = await meta.json();
  const files = Object.values(j.files || {}).filter((f) => f && f.raw_url);
  const file = files.find((f) => /\.json$/i.test(f.filename || '')) || files[0];
  if (!file) throw new Error('gist sans fichier');
  const res = await fetchImpl(file.raw_url, { timeout: 20000 });
  if (!res.ok) throw new Error(`gist raw HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('gist non tableau');
  return { data, updatedAt: j.updated_at || null, htmlUrl: j.html_url || null, revision: j.history?.[0]?.version || null };
}

async function main(deps = {}) {
  const now = deps.now ?? Date.now();
  const gistDocs = (await readJson('gist_user_rollouts_docs.json', {})) || {};
  const sampling = (await readJson('user_rollouts.json', {})) || {};
  const positions = deps.positions !== undefined ? deps.positions : ((await readJson('user_rollout_positions.json', {})) || {});
  const defs = [];
  for (const [file, pick] of [['experiments.json', (j) => j.experiments], ['mobile_experiments.json', (j) => j.experiments], ['apex_experiments.json', (j) => (Array.isArray(j) ? j : [])]]) {
    const j = await readJson(file, null);
    for (const e of (j && pick(j)) || []) if (e && (e.id || e.name)) defs.push({ id: e.id || e.name, type: e.type || e.kind, title: e.label || e.title });
  }
  let rawGist = [];
  let gist = gistDocs;
  try {
    const f = deps.fetchRawGist || fetchRawGist;
    const r = await f(GIST_ID, process.env.GITHUB_TOKEN);
    rawGist = r.data;
    gist = { ...gistDocs, source: { ...(gistDocs.source || {}), gistId: GIST_ID, updatedAt: r.updatedAt || gistDocs.source?.updatedAt || null,
      htmlUrl: r.htmlUrl || gistDocs.source?.htmlUrl || null, revision: r.revision || gistDocs.source?.revision || null } };
  } catch (e) {
    console.warn('gist brut indisponible, comparaison partielle :', String(e.message || e).slice(0, 100));
  }
  const out = buildComparison({ gist, rawGist, sampling, definitions: defs, positions, now, onlyObserved: true });
  const file = deps.out || path.join(DATA, 'user_rollout_comparison.json');
  await writeJsonAtomic(file, out, 1);
  console.log('Comparaison:', JSON.stringify(out.stats));
  return out;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, fetchRawGist };
