#!/usr/bin/env node
/**
 * Rollouts FAST — un seul surveillant pour TOUS les % (user + guild).
 *
 * Pourquoi : les crons GitHub (*\/20 apex, *\/30 gist) sont best-effort
 * (souvent décalés de 10 min à 2 h) et le réveil gist_wake ne tournait plus
 * (user-rollouts.yml sans cron). Wumpus Central décode /experiments une fois
 * par HEURE. Ici on sonde toutes les ~60 s, pour un coût quasi nul :
 *
 *   - % guild : GET canary /api/v10/experiments?with_guild_experiments=true
 *     (même source que Wumpus Central) → empreinte sha1 des guild_experiments.
 *     Empreinte changée → apex_rollouts.js (décodage exact + notif) + commit.
 *   - % user  : GET api.github.com/gists/<id> en requête CONDITIONNELLE
 *     (If-None-Match → 304, ne consomme pas le quota) → révision changée →
 *     gist_user_rollouts.js (+ positions + comparaison) + commit.
 *
 * Premier tick = passe complète des deux trackers (couvre le trou entre deux
 * jobs). Échec d'un tracker (webhook KO = exit 2, dégradé = exit 1) →
 * l'empreinte n'avance pas, retentative après RETRY_MS. Seul écrivain
 * automatique des états data/apex_rollouts.json et data/gist_user_rollouts.json
 * (les workflows apex / gist restent en dispatch manuel) → plus de doublons.
 *
 * Env :
 *   ROLLOUTS_FAST_WATCH_MS  durée du job (défaut 28 min ; cron *\/30)
 *   ROLLOUTS_FAST_TICK_MS   intervalle de sonde (défaut 60 s, min 15 s)
 *   ROLLOUTS_FAST_RETRY_MS  délai avant retentative après échec (défaut 5 min)
 *   ROLLOUTS_FAST_MAX_TICKS borne de ticks (tests)
 *   GIST_TOKEN              optionnel (PAT) — sinon lecture anonyme du gist
 */
'use strict';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const { execFileSync, spawnSync } = require('child_process');
const { DEFAULT_UA, sleep } = require('./lib/utils');

const ROOT = path.join(__dirname, '..');
const GIST_STATE = path.join(ROOT, 'data', 'gist_user_rollouts.json');
const DEFAULT_GIST = 'e3e99062983e6bd0feaef833f14fd931';
const GUILD_URLS = [
  'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true',
  'https://discord.com/api/v9/experiments?with_guild_experiments=true',
];

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const WATCH_MS = num(process.env.ROLLOUTS_FAST_WATCH_MS, 28 * 60 * 1000);
const TICK_MS = Math.max(15000, num(process.env.ROLLOUTS_FAST_TICK_MS, 60 * 1000));
const RETRY_MS = num(process.env.ROLLOUTS_FAST_RETRY_MS, 5 * 60 * 1000);
const MAX_TICKS = Number(process.env.ROLLOUTS_FAST_MAX_TICKS || 0);

const TRACKERS = {
  guild: {
    steps: [{ script: 'src/apex_rollouts.js', env: { APEX_MIN_PCT_DELTA: process.env.APEX_MIN_PCT_DELTA || '2', APEX_RECENT_YEAR: process.env.APEX_RECENT_YEAR || '2025' } }],
    files: ['data/apex_rollouts.json'],
    msg: 'apex rollouts state',
  },
  user: {
    steps: [
      { script: 'src/gist_user_rollouts.js', env: { GIST_ROLLOUT_MIN_PCT_DELTA: process.env.GIST_ROLLOUT_MIN_PCT_DELTA || '0.05' } },
      { script: 'src/user_rollout_positions.js', optional: true },
      { script: 'src/user_rollout_comparison.js', optional: true },
    ],
    files: [
      'data/gist_user_rollouts.json',
      'data/gist_user_rollouts.md',
      'data/gist_user_rollouts_docs.json',
      'data/user_rollout_positions.json',
      'data/user_rollout_comparison.json',
    ],
    msg: 'data: gist user rollouts',
  },
};

/** Empreinte stable des guild_experiments (ordre des tuples ignoré). */
function guildSignature(guildExperiments) {
  if (!Array.isArray(guildExperiments)) return null;
  const parts = guildExperiments.map((t) => JSON.stringify(t)).sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

async function probeGuild(fetchImpl = fetch) {
  for (const url of GUILD_URLS) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' }, timeout: 15000 });
      if (!res.ok) continue;
      const j = await res.json();
      const sig = guildSignature(j && j.guild_experiments);
      if (sig) return { sig, count: j.guild_experiments.length };
    } catch (_) { /* url suivante */ }
  }
  return null;
}

/**
 * Sonde conditionnelle du gist. Retourne
 * { status: 'unchanged' | 'changed' | 'error', revision?, etag?, code? }.
 */
async function probeGist(gistId, etag, fetchImpl = fetch, token = process.env.GIST_TOKEN || '') {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'canary-rollouts-fast' };
  if (etag) headers['If-None-Match'] = etag;
  if (token) headers.Authorization = 'Bearer ' + token;
  try {
    const res = await fetchImpl('https://api.github.com/gists/' + encodeURIComponent(gistId), { headers, timeout: 15000 });
    if (res.status === 304) return { status: 'unchanged', etag };
    if (!res.ok) return { status: 'error', code: res.status };
    const j = await res.json();
    const v = j && Array.isArray(j.history) && j.history[0] && j.history[0].version;
    const newEtag = (res.headers && typeof res.headers.get === 'function' && res.headers.get('etag')) || null;
    return { status: 'changed', revision: typeof v === 'string' ? v : null, etag: newEtag };
  } catch (e) {
    return { status: 'error', code: String((e && e.message) || e).slice(0, 60) };
  }
}

/**
 * Décision pure : faut-il lancer un tracker ?
 * st = { lastSig, okSig, lastFailAt }, cur = signature courante (null = inconnue).
 */
function shouldRun({ first, cur, okSig, lastFailAt, now, retryMs }) {
  if (first) return { run: true, reason: 'initial' };
  if (!cur) return { run: false, reason: 'probe_failed' };
  if (cur === okSig) return { run: false, reason: 'unchanged' };
  if (lastFailAt && now - lastFailAt < retryMs) return { run: false, reason: 'backoff' };
  return { run: true, reason: okSig ? 'changed' : 'retry' };
}

function gitRefresh(files) {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' });
    if (dirty.trim()) return;
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: ROOT, stdio: 'ignore' });
    for (const f of files) {
      try { execFileSync('git', ['checkout', 'origin/main', '--', f], { cwd: ROOT, stdio: 'ignore' }); } catch (_) { /* fichier absent */ }
    }
  } catch (e) {
    console.warn('git refresh skip:', String((e && e.message) || e).slice(0, 80));
  }
}

function commit(files, msg) {
  try {
    execFileSync('bash', ['scripts/commit-state.sh', msg, ...files], { cwd: ROOT, env: { ...process.env, COMMIT_SOFT_FAIL: '1' }, stdio: 'inherit' });
  } catch (e) {
    console.warn('commit-state fail:', String((e && e.message) || e).slice(0, 80));
  }
}

/** Lance un tracker (étapes enfant) ; retourne true si l'étape principale a réussi. */
function runTracker(name, deps = {}) {
  const t = TRACKERS[name];
  const spawn = deps.spawn || spawnSync;
  const git = deps.git !== false;
  if (git) gitRefresh(t.files);
  let ok = true;
  for (const step of t.steps) {
    const r = spawn(process.execPath, [step.script], { cwd: ROOT, env: { ...process.env, ...(step.env || {}) }, stdio: 'inherit', timeout: 5 * 60 * 1000 });
    const code = r && typeof r.status === 'number' ? r.status : 1;
    console.log(`  ${step.script} → exit ${code}`);
    if (code !== 0 && !step.optional) { ok = false; if (code !== 2) break; }
  }
  if (git) commit(t.files, t.msg);
  return ok;
}

async function readGistId() {
  try {
    const s = await fs.readJson(GIST_STATE);
    return (s && s.source && s.source.gistId) || DEFAULT_GIST;
  } catch (_) {
    return DEFAULT_GIST;
  }
}

async function main(deps = {}) {
  const now = deps.now || (() => Date.now());
  const wait = deps.sleep || sleep;
  const run = deps.runTracker || runTracker;
  const pGuild = deps.probeGuild || (() => probeGuild());
  const pGist = deps.probeGist || ((id, etag) => probeGist(id, etag));
  const watchMs = deps.watchMs || WATCH_MS;
  const tickMs = deps.tickMs || TICK_MS;
  const maxTicks = deps.maxTicks != null ? deps.maxTicks : MAX_TICKS;
  const gistId = deps.gistId || (await readGistId());
  const deadline = now() + watchMs;
  const st = { guild: { okSig: null, lastFailAt: 0 }, user: { okSig: null, lastFailAt: 0, etag: null, rev: null, gistBackoffUntil: 0 } };
  const log = [];
  let ticks = 0;
  let failures = 0;
  console.log(`Rollouts FAST — sonde toutes les ${Math.round(tickMs / 1000)} s pendant ${Math.round(watchMs / 60000)} min (gist ${gistId})`);

  while (now() < deadline && !(maxTicks > 0 && ticks >= maxTicks)) {
    const first = ticks === 0;
    const t0 = now();

    // ── % guild (wire Discord) ──
    const g = first ? null : await pGuild();
    const gCur = first ? null : g && g.sig;
    const gd = shouldRun({ first, cur: gCur, okSig: st.guild.okSig, lastFailAt: st.guild.lastFailAt, now: t0, retryMs: RETRY_MS });
    if (gd.run) {
      console.log(`[guild] ${gd.reason} → apex_rollouts`);
      const sigBefore = first ? (await pGuild()) : g;
      const ok = await run('guild');
      log.push({ tick: ticks, tracker: 'guild', reason: gd.reason, ok });
      if (ok) { st.guild.okSig = sigBefore && sigBefore.sig; st.guild.lastFailAt = 0; } else { st.guild.lastFailAt = now(); failures++; }
    }

    // ── % user (gist) ──
    let uCur = st.user.rev;
    if (!first && now() >= st.user.gistBackoffUntil) {
      const p = await pGist(gistId, st.user.etag);
      if (p.status === 'changed') { st.user.etag = p.etag || null; st.user.rev = p.revision || st.user.rev; uCur = st.user.rev; }
      else if (p.status === 'error') {
        if (p.code === 403 || p.code === 429) st.user.gistBackoffUntil = now() + RETRY_MS;
        uCur = null;
      }
    }
    const ud = shouldRun({ first, cur: uCur, okSig: st.user.okSig, lastFailAt: st.user.lastFailAt, now: t0, retryMs: RETRY_MS });
    if (ud.run) {
      console.log(`[user] ${ud.reason} → gist_user_rollouts`);
      if (first) {
        const p = await pGist(gistId, null);
        if (p.status === 'changed') { st.user.etag = p.etag || null; st.user.rev = p.revision || null; }
      }
      const ok = await run('user');
      log.push({ tick: ticks, tracker: 'user', reason: ud.reason, ok });
      if (ok) { st.user.okSig = st.user.rev; st.user.lastFailAt = 0; } else { st.user.lastFailAt = now(); failures++; }
    }

    ticks++;
    const remaining = deadline - now();
    if (remaining <= 0 || (maxTicks > 0 && ticks >= maxTicks)) break;
    await wait(Math.max(0, Math.min(tickMs - (now() - t0), remaining)));
  }
  console.log(`Rollouts FAST terminé — ${ticks} ticks, ${log.length} passes, ${failures} échec(s)`);
  return { ticks, log, failures };
}

if (require.main === module) {
  main().then((r) => { if (r.failures && !r.log.some((x) => x.ok)) process.exitCode = 1; }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main, shouldRun, guildSignature, probeGuild, probeGist, runTracker, TRACKERS };
