/**
 * User experiment rollouts v13 — MESURE PROPRE, zéro source communautaire.
 *
 * V13 (indépendance totale) :
 *  - plus aucun gist ni API tierce : les % sont MESURÉS par notre propre
 *    sampling de l'API Discord (empreintes anonymes → assignments user).
 *  - fenêtre glissante : chaque run ajoute ses échantillons à un historique
 *    de USER_ROLLOUT_WINDOW_H heures (défaut 4 h) → plusieurs milliers
 *    d'observations cumulées au lieu de 80 isolées.
 *  - estimation binomiale par variante : pct = k/n (insensible aux trous de
 *    densité), marge de bruit statistique (noiseMargin) appliquée à chaque
 *    delta → on ne notifie que les changements réels.
 *  - noms : uniquement nos propres fichiers de scrape (data/*.json issus du
 *    bundle client / build mobile) — aucune liste externe.
 *
 * Méthode (V13) :
 *  - /experiments anonyme (X-Request-Id unique par requête) → pour chaque
 *    échantillon : hash de l'expérience, bucket assigné, hash_result.
 *  - Par variante : k = nombre d'échantillons assignés, n = nombre total
 *    d'échantillons de la fenêtre → pct = k/n. σ = √(p(1−p)/n) donne la
 *    confiance (high ≤ 1,5 pt, medium ≤ ~3 pts, low = dégradé).
 *  - Les positions hash_result récentes (anneau de 60/valeur) servent à
 *    reconstruire des ranges INDICATIVES pour l'affichage — le % affiché
 *    reste toujours k/n (non biaisé).
 *  - Un changement n'est publié que s'il dépasse max(MIN_DELTA, marge de
 *    bruit z·√(2p(1−p)/n)).
 *
 * Env:
 *   DISCORD_USER_TOKEN(S) / DISCORD_USER_TOKEN_1..10
 *   UR_WEBHOOK | USER_ROLLOUT_WEBHOOK_URL | APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   USER_ROLLOUT_SAMPLES        default 150 (échantillons par run)
 *   USER_ROLLOUT_CONCURRENCY    default 2
 *   USER_ROLLOUT_DELAY_MS      default 300
 *   USER_ROLLOUT_MIN_OK        default 25 (min samples OK pour estimer)
 *   USER_ROLLOUT_MAX_MS        default 90000 (budget temps du sampling)
 *   USER_ROLLOUT_PLATEAU       default 30 (arrêt anticipé sur plateau)
 *   USER_ROLLOUT_WINDOW_H      default 4 (fenêtre glissante, en heures)
 *   USER_ROLLOUT_WINDOW_BATCHES default 60 (max runs gardés dans la fenêtre)
 *   USER_ROLLOUT_NOISE_Z       default 2 (seuil de bruit statistique ; 0 = off)
 *   USER_ROLLOUT_NOTIFY_HASH   default 0 (notifier aussi les hash sans nom)
 *   APEX_MIN_PCT_DELTA         default 1 (% min, en plus de la marge de bruit)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sendEmbeds } = require('./lib/webhook');
const { murmur3 } = require('./lib/murmur3');
const { writeJsonAtomic } = require('./lib/atomic');
const { sleep, redactSecrets, loadTokens, DEFAULT_UA, DEFAULT_BOT_NAME: BOT, DEFAULT_AVATAR_URL: AVATAR } = require('./lib/utils');
const { safeJson } = require('./lib/http');
const {
  mergeIntervals,
  classifyChange,
  noiseMargin,
  stableChangeFingerprint,
  pointsToIntervals,
  DEFAULT_SCALE,
} = require('./lib/rollout_math');

const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'user_rollouts.json');
const KNOWN = path.join(DATA, 'known_experiment_ids.json');
const EXPS = path.join(DATA, 'experiments.json');
const BASELINE = path.join(DATA, 'baseline_experiments.json');
const APEX_EXP = path.join(DATA, 'apex_experiments.json');

const TOKENS = loadTokens();
// Webhook UNIQUE pour les notifs user rollouts : la première var définie gagne.
// Ordre : salon dédié (UR_WEBHOOK) → USER_ROLLOUT_WEBHOOK_URL → APEX → ROLLOUT → DISCORD.
const WEBHOOK_CANDIDATES = [
  ['UR_WEBHOOK', process.env.UR_WEBHOOK],
  ['USER_ROLLOUT_WEBHOOK_URL', process.env.USER_ROLLOUT_WEBHOOK_URL],
  ['APEX_WEBHOOK_URL', process.env.APEX_WEBHOOK_URL],
  ['ROLLOUT_WEBHOOK_URL', process.env.ROLLOUT_WEBHOOK_URL],
  ['DISCORD_WEBHOOK_URL', process.env.DISCORD_WEBHOOK_URL],
];
const firstWebhook = WEBHOOK_CANDIDATES.find(([, v]) => v && String(v).trim());
const WEBHOOK = firstWebhook ? String(firstWebhook[1]).trim() : null;
const WEBHOOK_SOURCE = firstWebhook ? firstWebhook[0] : null;
const SAMPLES = Math.max(20, Math.min(400, Number(process.env.USER_ROLLOUT_SAMPLES || 150)));
const CONC = Math.max(1, Math.min(4, Number(process.env.USER_ROLLOUT_CONCURRENCY || 2)));
const DELAY_MS = Math.max(80, Math.min(5000, Number(process.env.USER_ROLLOUT_DELAY_MS || 300)));
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 1);
const MIN_OK = Math.max(10, Number(process.env.USER_ROLLOUT_MIN_OK || 25));
const MAX_MS = Math.max(15000, Number(process.env.USER_ROLLOUT_MAX_MS || 90000));
const PLATEAU = Math.max(10, Number(process.env.USER_ROLLOUT_PLATEAU || 30));
const NOTIFY_HASH = String(process.env.USER_ROLLOUT_NOTIFY_HASH || '0') === '1';
const NOISE_Z = Math.max(0, Number(process.env.USER_ROLLOUT_NOISE_Z ?? 2));
const SCALE = DEFAULT_SCALE;
// V13 fenêtre glissante : les échantillons des N derniers runs cumulent
// leurs observations → estimation fine (σ ~ 0,5-1 pt sur une fenêtre pleine).
const WINDOW_H = Math.max(1, Number(process.env.USER_ROLLOUT_WINDOW_H || 4));
const WINDOW_H_MS = WINDOW_H * 3600 * 1000;
const MAX_BATCHES = Math.max(5, Number(process.env.USER_ROLLOUT_WINDOW_BATCHES || 60));
// Anneau de positions récentes par bucket (ranges indicatives seulement).
const RING_CAP = 60;

function tLabel(bucket) {
  const b = Number(bucket);
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Variant ' + b;
}

/**
 * Noms des expériences : UNIQUEMENT nos fichiers locaux (notre propre scrape
 * du bundle client + builds). Aucune source externe.
 * Retourne une Map hash → { id, title, type }.
 */
async function loadExperimentDefs() {
  const defs = new Map();
  const addLocal = (id, type, title) => {
    if (!id || typeof id !== 'string') return;
    const clean = id.trim();
    if (!clean || clean.startsWith('hash:')) return;
    const h = murmur3(clean);
    if (!defs.has(h)) {
      defs.set(h, {
        id: clean,
        hash: h,
        title: title || clean,
        type: type || 'user',
        source: 'local',
      });
    }
  };

  for (const f of [EXPS, BASELINE, KNOWN, APEX_EXP]) {
    if (!(await fs.pathExists(f))) continue;
    try {
      const j = await fs.readJson(f);
      const arr = Array.isArray(j)
        ? j
        : j.experiments || j.ids || (typeof j === 'object' ? Object.keys(j) : []);
      for (const e of arr) {
        if (typeof e === 'string') addLocal(e, 'user');
        else if (e && (e.id || e.name)) {
          addLocal(String(e.id || e.name), e.type || e.kind || 'user', e.title || e.label || e.id);
        }
      }
    } catch (_) {}
  }

  console.log('Local experiment names:', Math.floor(defs.size), 'ids');
  return defs;
}

// ─── Fenêtre glissante ──────────────────────────────────────────────────────

/**
 * Normalise + élague la fenêtre : batches plus vieux que WINDOW_H jetés,
 * au plus MAX_BATCHES gardées, anneaux de positions capés à RING_CAP.
 */
function pruneWindow(raw, now) {
  const w = raw && typeof raw === 'object' && Array.isArray(raw.batches) ? raw : { batches: [], pos: {} };
  const cutoff = now - WINDOW_H_MS;
  const batches = w.batches
    .filter((b) => b && Number.isFinite(b.ts) && b.ts >= cutoff && b.c && typeof b.c === 'object')
    .slice(-MAX_BATCHES);
  const posIn = w.pos && typeof w.pos === 'object' ? w.pos : {};
  const pos = {};
  for (const [hashS, buckets] of Object.entries(posIn)) {
    const nb = {};
    for (const [bS, arr] of Object.entries(buckets || {})) {
      const a = Array.isArray(arr) ? arr.filter((x) => Number.isFinite(x)) : [];
      if (a.length) nb[bS] = a.slice(-RING_CAP);
    }
    if (Object.keys(nb).length) pos[hashS] = nb;
  }
  return { batches, pos };
}

/**
 * Agrège les batches de la fenêtre :
 *  - winCounts : hash → Map(bucket → k)  (observations cumulées)
 *  - winN      : hash → n (échantillons comptés DEPUIS la première apparition
 *    du hash dans la fenêtre — un hash absent d'un batch y compte quand même
 *    dans n : chaque échantillon avait sa chance d'être assigné).
 */
function windowAggregate(win) {
  const firstIdx = new Map();
  win.batches.forEach((b, i) => {
    for (const hashS of Object.keys(b.c)) {
      const hash = Number(hashS);
      if (!Number.isFinite(hash)) continue;
      if (!firstIdx.has(hash)) firstIdx.set(hash, i);
    }
  });
  const winCounts = new Map();
  for (const hash of firstIdx.keys()) winCounts.set(hash, new Map());
  win.batches.forEach((b, i) => {
    for (const [hash, first] of firstIdx) {
      if (i < first) continue;
      const buckets = b.c[String(hash)];
      if (!buckets) continue;
      const m = winCounts.get(hash);
      for (const [bS, k] of Object.entries(buckets)) {
        const bucket = Number(bS);
        const kk = Number(k);
        if (!Number.isFinite(bucket) || !Number.isFinite(kk)) continue;
        m.set(bucket, (m.get(bucket) || 0) + kk);
      }
    }
  });
  const winN = new Map();
  for (const [hash, first] of firstIdx) {
    let n = 0;
    for (let i = first; i < win.batches.length; i++) n += Number(win.batches[i].ok) || 0;
    winN.set(hash, n);
  }
  return { winCounts, winN };
}

/**
 * Construit la fenêtre POUR SAUVEGARDE : batches précédentes (déjà élaguées)
 * + le batch du run courant (comptes compacts hash → bucket → k).
 */
function buildNextWindow(win, curCounts, ok, now) {
  const c = {};
  for (const [hash, buckets] of curCounts) {
    const nb = {};
    for (const [bucket, k] of buckets) nb[String(bucket)] = k;
    c[String(hash)] = nb;
  }
  const batches = [...win.batches, { ts: now, ok, c }].slice(-MAX_BATCHES);
  return { batches, pos: {} };
}

// ─── Estimation binomiale (V13) ─────────────────────────────────────────────

/**
 * Traitements d'une expérience depuis les comptes cumulés de la fenêtre.
 * mergedCounts : Map(bucket → k) ; n : total d'échantillons de la fenêtre ;
 * ringPos : { bucket: [hash_result, ...] } positions récentes (indicatives).
 *
 * pct = k/n (binomial, non biaisé). Les ranges sont reconstruites depuis
 * l'anneau de positions avec un gap adapté à la densité → purement indicatif.
 */
function buildWindowTreatments(mergedCounts, n, ringPos) {
  const treatments = [];
  for (const [bucket, k] of mergedCounts) {
    const kk = Math.max(0, Number(k) || 0);
    const nn = Math.max(0, Number(n) || 0);
    if (!Number.isFinite(bucket) || kk <= 0 || nn <= 0) continue;
    const p = Math.min(1, Math.max(0, kk / nn));
    const pct = Math.round(p * 100 * 100) / 100;
    const sigma = 100 * Math.sqrt(Math.max(p * (1 - p), 1 / Math.max(nn, 1)) / Math.max(nn, 1));
    let confidence = 'low';
    if (kk >= 30 && sigma <= 1.5) confidence = 'high';
    else if (kk >= 12) confidence = 'medium';
    const status = confidence === 'low' ? 'degraded' : 'estimated';

    // Ranges indicatives depuis l'anneau de positions récentes.
    const pts = [
      ...new Set(
        ((ringPos && ringPos[String(bucket)]) || [])
          .map(Number)
          .filter((x) => Number.isFinite(x) && x >= 0 && x < SCALE),
      ),
    ].sort((a, b) => a - b);
    let ranges = [];
    let gapFill = 0;
    if (pts.length >= 3) {
      // Gap ≈ espacement attendu si la couverture estimée est juste.
      gapFill = Math.max(1, Math.min(80, Math.round((p * SCALE) / pts.length) || 1));
      ranges = pointsToIntervals(pts, gapFill, SCALE);
    }
    const observed = pts.length ? [pts[0], pts[pts.length - 1]] : null;
    treatments.push({
      bucket: Number(bucket),
      label: tLabel(bucket),
      percentage: pct,
      pct,
      pctKnown: true,
      status,
      confidence,
      sampleCount: kk,
      samples: kk,
      coverage: Math.round(p * 1000) / 1000,
      intervals: ranges,
      ranges,
      observed,
      gapFill,
      sourceKind: 'window_binomial',
    });
  }
  treatments.sort((a, b) => a.bucket - b.bucket);
  const sumPct = Math.round(
    treatments.reduce((s, t) => s + (t.pctKnown && t.pct != null ? t.pct : 0), 0) * 100,
  ) / 100;
  let globalStatus = 'estimated';
  if (!treatments.length) globalStatus = 'insufficient_data';
  else if (treatments.some((t) => t.status === 'degraded')) globalStatus = 'degraded';
  const sigmaAll = treatments.length
    ? 100 * Math.sqrt(Math.max(0, sumPct / 100) * Math.max(0, 1 - sumPct / 100) / Math.max(n, 1))
    : Infinity;
  return { treatments, status: globalStatus, sumPct, sigma: Math.round(sigmaAll * 100) / 100 };
}

// ─── Sampling ───────────────────────────────────────────────────────────────

/**
 * Global rate limiter — tracks Discord's rate limit headers and pauses
 * all workers when rate limited, instead of per-request retries.
 */
const rateLimit = {
  remaining: 1,
  resetAfter: 0,
  globalBlockUntil: 0,
  consecutive429: 0,
  dynamicDelayMs: DELAY_MS,

  waitMs() {
    const now = Date.now();
    if (now < this.globalBlockUntil) {
      return this.globalBlockUntil - now;
    }
    return 0;
  },

  update(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    const resetAfter = headers.get('x-ratelimit-reset-after');
    if (remaining != null) this.remaining = Number(remaining);
    if (resetAfter != null) this.resetAfter = Number(resetAfter);

    if (this.remaining <= 1 && this.resetAfter > 0) {
      this.dynamicDelayMs = Math.min(3000, DELAY_MS + 200);
    } else if (this.remaining >= 3) {
      this.dynamicDelayMs = Math.max(DELAY_MS, this.dynamicDelayMs - 50);
    }
  },

  block429(retryAfter) {
    this.consecutive429++;
    const wait = Math.min(30, Math.max(1, Number(retryAfter) || 2)) * 1000;
    this.globalBlockUntil = Date.now() + wait;
    this.dynamicDelayMs = Math.min(5000, this.dynamicDelayMs + 500);
    console.warn('429 → global block', Math.round(wait / 1000) + 's · dynamic delay now', this.dynamicDelayMs + 'ms');
    return wait;
  },

  success() {
    if (this.consecutive429 > 0) {
      this.dynamicDelayMs = Math.max(DELAY_MS, this.dynamicDelayMs - 100);
      this.consecutive429 = 0;
    }
  },
};

async function fetchAssignments(extraHeaders = {}, withGuild = false, attempt = 0) {
  const wait = rateLimit.waitMs();
  if (wait > 0) {
    await sleep(wait);
  }

  const url = withGuild
    ? 'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true'
    : 'https://canary.discord.com/api/v10/experiments';
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_UA,
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    },
    timeout: 15000,
  });

  rateLimit.update(res.headers);

  if (res.status === 429) {
    const ra = Number(
      res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset-after') || 2,
    );
    rateLimit.block429(ra);
    if (attempt < 4) {
      await sleep(rateLimit.waitMs());
      return fetchAssignments(extraHeaders, withGuild, attempt + 1);
    }
    throw new Error('429 after ' + (attempt + 1) + ' retries');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  rateLimit.success();
  const data = await safeJson(res);
  if (!data) throw new Error('réponse JSON invalide');
  return {
    fingerprint: data.fingerprint,
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
  };
}

/**
 * Sample fingerprints to detect + measure user experiments.
 * Returns { byHash, ok, fail } avec byHash : hash → bucket → hash_result[].
 */
async function sampleFingerprints(n, concurrency) {
  const byHash = new Map();
  let ok = 0;
  let fail = 0;
  let next = 0;
  // Budget temps + sortie sur plateau de découverte (la mesure continue via
  // la fenêtre : chaque run ajoute ses échantillons aux précédents).
  const deadline = Date.now() + MAX_MS;
  let sinceNew = 0;
  let stopReason = null;

  async function worker() {
    while (true) {
      const my = next++;
      if (my >= n) break;
      if (!stopReason && ok >= MIN_OK && sinceNew >= PLATEAU) stopReason = 'plateau';
      if (!stopReason && Date.now() > deadline) stopReason = 'budget';
      if (stopReason) break;
      if (rateLimit.consecutive429 > 15) {
        fail++;
        continue;
      }
      try {
        const delay = rateLimit.dynamicDelayMs + Math.floor(Math.random() * 150);
        await sleep(delay);
        const { assignments } = await fetchAssignments({
          'X-Request-Id': crypto.randomBytes(16).toString('hex'),
        });
        let foundNew = false;
        for (const a of assignments) {
          if (!Array.isArray(a) || a.length < 6) continue;
          const hash = Number(a[0]);
          const bucket = Number(a[2]);
          const hr = Number(a[5]);
          if (!Number.isFinite(hash) || !Number.isFinite(hr)) continue;
          if (!byHash.has(hash)) { byHash.set(hash, new Map()); foundNew = true; }
          const bm = byHash.get(hash);
          if (!bm.has(bucket)) { bm.set(bucket, []); foundNew = true; }
          bm.get(bucket).push(hr);
        }
        ok++;
        sinceNew = foundNew ? 0 : sinceNew + 1;
      } catch (e) {
        fail++;
        if (String(e.message).includes('429')) {
          await sleep(rateLimit.waitMs());
        } else if (fail <= 6) {
          console.warn('sample fail', e.message);
        }
      }
      if (my && my % 25 === 0) console.log('  sampled', my, '/', n, 'ok', ok, 'delay', rateLimit.dynamicDelayMs + 'ms');
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log('Samples ok', ok, 'fail', fail, 'hashes', byHash.size, '429s', rateLimit.consecutive429, stopReason ? '· early stop: ' + stopReason : '(all ' + n + ')');
  return { byHash, ok, fail };
}

function fingerprintOf(treatments) {
  return treatments
    .map((t) => {
      if (!t.pctKnown || t.pct == null || t.status === 'insufficient_data') {
        return t.bucket + ':?';
      }
      const step = t.confidence === 'low' ? 5 : 1;
      const rounded = Math.round(Number(t.pct) / step) * step;
      return t.bucket + ':' + rounded.toFixed(1);
    })
    .sort()
    .join('|');
}

async function fetchTokenSnapshot(defs) {
  if (!TOKENS.length) return [];
  const out = [];
  for (const token of TOKENS.slice(0, 10)) {
    try {
      const data = await fetchAssignments({ Authorization: token }, true);
      for (const a of data.assignments || []) {
        if (!Array.isArray(a) || a.length < 3) continue;
        const hash = Number(a[0]);
        const meta = defs.get(hash) || {
          id: 'hash:' + hash,
          type: 'user',
          title: 'hash:' + hash,
        };
        out.push({
          hash,
          id: meta.id,
          title: meta.title,
          type: meta.type,
          revision: a[1],
          bucket: a[2],
          hash_result: a[5],
        });
      }
      await sleep(200);
    } catch (e) {
      console.warn('Token snapshot fail:', redactSecrets(e.message));
    }
  }
  return out;
}

// ─── Embeds — format sobre, sans emojis ────────────────────────────────────

function fmtPct(pct) {
  const v = Number(pct);
  if (pct == null || !Number.isFinite(v)) return '0';
  return String(Math.round(v * 10) / 10);
}

/** Label de variante : None / Variant N. */
function variantLabel(bucket) {
  return Number(bucket) === -1 ? 'None' : 'Variant ' + bucket;
}

function buildEmbeds(changes) {
  const embeds = [];
  for (const c of changes.slice(0, 10)) {
    const title = (String(c.id || c.title) + ' (user)').slice(0, 256);
    const lines = [];

    if (c.title && c.title !== c.id) lines.push(String(c.title).slice(0, 300));

    if (c.kind === 'new') {
      for (const t of (c.treatments || []).slice(0, 12)) {
        lines.push(variantLabel(t.bucket) + ' ' + (t.pctKnown && t.pct != null ? fmtPct(t.pct) + '%' : '?%'));
      }
    } else if (c.kind === 'pct') {
      for (const d of (c.deltas || []).slice(0, 12)) {
        lines.push(variantLabel(d.bucket) + ' ' + fmtPct(d.from) + '% -> ' + fmtPct(d.to) + '%');
      }
    } else if (c.kind === 'revision') {
      lines.push('Revision ' + c.fromRev + ' -> ' + c.toRev + ' - ' + variantLabel(c.bucket));
    }

    embeds.push({
      title,
      description: lines.join('\n').slice(0, 4000),
      color:
        c.kind === 'pct'
          ? (c.deltas || []).some((d) => Number(d.to) >= 100)
            ? 0x57f287
            : (c.deltas || []).some((d) => Number(d.to) <= 0)
              ? 0xed4245
              : 0xe67e22
          : 0x5865f2,
      footer: {
        text:
          (c.kind === 'revision' ? 'Rollouts Revision' : 'Rollouts Changes') +
          ' · Source: mesure propre · API Discord',
      },
    });
  }
  return embeds;
}

async function postWebhook(embeds) {
  if (!WEBHOOK || !embeds.length) return { ok: false, status: 0, text: 'skip' };
  return sendEmbeds(
    WEBHOOK,
    { username: BOT.slice(0, 80), avatar_url: AVATAR },
    embeds,
    { label: 'user-rollouts', withDismiss: true },
  );
}

function hasName(id) {
  return id && !String(id).startsWith('hash:');
}

/** Rapport texte lisible (data/user_rollouts.md) — régénéré avec le JSON. */
function writeReport(state) {
  try {
    const fmt = (p) => String(p).replace('.', ',') + ' %';
    const conf = (c) => (c === 'high' ? 'élevée' : c === 'medium' ? 'moyenne' : 'faible');
    const exps = (state.experiments || []).slice();
    const n = exps.reduce((m, e) => Math.max(m, Number(e.windowN) || 0), 0);
    const gen = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const out = [];
    out.push('# Rollouts user — mesure propre (v13)', '');
    out.push('> Mis à jour automatiquement toutes les 20 min · Source : API Discord uniquement · Généré le ' + gen + ' UTC', '');
    out.push('**Fenêtre glissante 4 h — n = ' + n + ' échantillons — ' + (state.tokensConfigured || 0) + ' tokens actifs**', '');
    out.push('## Expériences mesurées (' + exps.length + ')', '');
    out.push('| Expérience | % mesuré | k/n | Confiance | Statut |');
    out.push('|---|---:|---:|---|---|');
    for (const e of exps) {
      const ts = e.treatments || [];
      const best = ts.reduce((a, t) => ((t.bucket || 0) > 0 && (a == null || (t.pct || 0) > a) ? t.pct : a), null);
      const k = (ts[0] || {}).sampleCount;
      const st = e.status === 'degraded' ? 'Mesuré (n faible)' : 'Mesuré';
      out.push('| ' + (e.title || e.id || 'hash:' + e.hash) + ' | **' + (best == null ? '—' : fmt(best)) + '** | ' + (k != null ? k + '/' + (e.windowN || '?') : (e.windowN || '?')) + ' | ' + conf((ts[0] || {}).confidence) + ' | ' + st + ' |');
    }
    out.push('', '## Détail par variante');
    for (const e of exps) {
      out.push('', '### ' + (e.title || e.id || 'hash:' + e.hash));
      for (const t of e.treatments || []) {
        out.push('- ' + (t.label || 'Bucket ' + t.bucket) + ' : ' + fmt(t.pct) + ' (' + (t.sampleCount != null ? t.sampleCount + '/' + e.windowN : 'n=' + e.windowN) + ', confiance ' + conf(t.confidence) + ')');
      }
    }
    fs.writeFileSync(path.join(DATA, 'user_rollouts.md'), out.join('\n') + '\n');
  } catch (e) {
    console.warn('report skip:', String((e && e.message) || e).slice(0, 80));
  }
}
// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  await fs.ensureDir(DATA);
  console.log('📊 User rollouts v13 (MESURE PROPRE · sampling + fenêtre ' + WINDOW_H + ' h)');
  console.log('Samples:', SAMPLES, 'concurrency:', CONC, 'tokens:', TOKENS.length);
  console.log('Webhook:', WEBHOOK ? 'set (' + WEBHOOK_SOURCE + ')' : 'MISSING');
  console.log('Notify unresolved hash:', NOTIFY_HASH ? 'yes' : 'no');

  let prev = { experiments: [], token: [], announced: {} };
  if (await fs.pathExists(STATE)) {
    try {
      prev = await fs.readJson(STATE);
    } catch (_) {}
  }
  const announced = prev.announced && typeof prev.announced === 'object' ? { ...prev.announced } : {};
  const isFirst = !(prev.experiments && prev.experiments.length);
  // Upgrade ≤ v12 → v13 : changement de méthode de mesure — re-seed silencieux
  // (pas de flood de « corrections » au premier run).
  const isUpgrade = !isFirst && Number(prev.version) !== 13;

  // Noms : fichiers locaux uniquement.
  const defs = await loadExperimentDefs();

  const [tokenSnapR, sampledR] = await Promise.allSettled([
    fetchTokenSnapshot(defs),
    sampleFingerprints(SAMPLES, CONC),
  ]);
  const tokenSnap = tokenSnapR.status === 'fulfilled' ? tokenSnapR.value : [];
  const sampled = sampledR.status === 'fulfilled' ? sampledR.value : { byHash: new Map(), ok: 0, fail: 0 };
  const { byHash, ok, fail } = sampled;
  console.log('Token snapshot:', tokenSnap.length, 'experiments');
  if (ok < MIN_OK) {
    console.warn('Too few ok samples', ok, '<', MIN_OK, '— estimation fenêtre seulement');
  }

  // ---- Fenêtre : aggège l'historique, merge le run courant ----
  const now = Date.now();
  const win = pruneWindow(prev.posWindow, now);
  const { winCounts, winN } = windowAggregate(win);

  const curCounts = new Map(); // hash → Map(bucket → k)
  for (const [hash, bucketMap] of byHash) {
    const m = new Map();
    for (const [bucket, hrs] of bucketMap) m.set(Number(bucket), hrs.length);
    curCounts.set(hash, m);
  }

  // Anneaux de positions : anciens + run courant, capés.
  const mergedPos = {};
  const posKeys = new Set([...Object.keys(win.pos || {}), ...[...curCounts.keys()].map(String)]);
  for (const hashS of posKeys) {
    const buckets = {};
    for (const [bS, arr] of Object.entries(((win.pos || {})[hashS]) || {})) {
      if (Array.isArray(arr) && arr.length) buckets[bS] = [...arr];
    }
    const cur = byHash.get(Number(hashS));
    if (cur) {
      for (const [bucket, hrs] of cur) {
        const key = String(bucket);
        buckets[key] = [...(buckets[key] || []), ...(hrs || [])].slice(-RING_CAP);
      }
    }
    if (Object.keys(buckets).length) mergedPos[hashS] = buckets;
  }

  // ---- Estimation par expérience (fenêtre + run courant) ----
  const experiments = [];
  const allHashes = new Set([...winCounts.keys(), ...curCounts.keys()]);
  for (const hash of allHashes) {
    const cur = curCounts.get(hash) || new Map();
    const wC = winCounts.get(hash) || new Map();
    // n courant : le run compte pour les hash détectés maintenant.
    const n = (winN.get(hash) || 0) + (cur.size ? ok : 0);
    if (n < MIN_OK) continue;
    const mergedCounts = new Map();
    for (const [b, k] of wC) mergedCounts.set(b, (mergedCounts.get(b) || 0) + k);
    for (const [b, k] of cur) mergedCounts.set(b, (mergedCounts.get(b) || 0) + k);
    const totalK = [...mergedCounts.values()].reduce((s, x) => s + x, 0);
    if (totalK < 3) continue; // trop peu d'observations → attendre la fenêtre

    const def = defs.get(hash) || {
      id: 'hash:' + hash,
      hash,
      title: 'hash:' + hash,
      type: 'user',
    };
    const { treatments, status: rollStatus, sumPct } = buildWindowTreatments(
      mergedCounts,
      n,
      mergedPos[String(hash)] || {},
    );
    if (!treatments.length) continue;
    experiments.push({
      hash,
      id: def.id,
      title: def.title,
      type: 'user',
      quality: rollStatus === 'estimated' ? 'estimated' : 'degraded',
      status: rollStatus,
      confidence: rollStatus === 'estimated' ? 0.8 : 0.3,
      coverage: Math.round(Math.min(sumPct, 100) * 10) / 1000,
      sumPct,
      treatments,
      fingerprint: fingerprintOf(treatments),
      source: 'own_sampling',
      named: hasName(def.id),
      windowN: n,
    });
  }

  console.log(
    'Experiments:',
    experiments.length,
    'named',
    experiments.filter((e) => e.named).length,
    'estimated',
    experiments.filter((e) => e.status === 'estimated').length,
    'degraded',
    experiments.filter((e) => e.status === 'degraded').length,
  );

  // Fenêtre à persister (batch courant inclus).
  const nextWindow = buildNextWindow(win, curCounts, ok, now);
  nextWindow.pos = mergedPos;

  const changes = [];
  if (!isFirst) {
    const pMap = new Map((prev.experiments || []).map((e) => [String(e.hash || e.id), e]));
    for (const nExp of experiments) {
      if (!nExp.named && !NOTIFY_HASH) continue;

      const key = String(nExp.hash);
      const fp = nExp.fingerprint;
      if (announced[key] === fp) continue;

      const p = pMap.get(key) || pMap.get(nExp.id);
      if (!p) {
        if (nExp.status === 'insufficient_data' || nExp.status === 'degraded') continue;
        changes.push({ kind: 'new', ...nExp });
        continue;
      }
      if (p.fingerprint === nExp.fingerprint) continue;
      const deltas = [];
      const pt = new Map((p.treatments || []).map((t) => [t.bucket, t]));
      if (nExp.status === 'degraded' || nExp.status === 'insufficient_data' || nExp.status === 'unknown') {
        continue;
      }
      if (p.status === 'degraded' || p.status === 'insufficient_data') {
        continue;
      }
      for (const t of nExp.treatments || []) {
        if (!t.pctKnown || t.pct == null) continue;
        if (t.status === 'degraded' || t.status === 'insufficient_data') continue;
        const oldT = pt.get(t.bucket);
        if (!oldT || !oldT.pctKnown || oldT.pct == null) {
          // Nouvelle variante dans le rollout : from = null → « 0% -> X% ».
          if (Number(t.pct) > 0) {
            deltas.push({
              label: t.label,
              bucket: t.bucket,
              from: null,
              to: Number(t.pct),
              change: Number(t.pct),
              changeType: 'ROLLOUT_APPEARED',
              observed: t.observed,
              ranges: t.intervals || t.ranges || null,
              confidence: t.confidence,
              status: t.status,
              exact: false,
              population: 'user',
              treatment: t.label,
            });
          }
          continue;
        }
        const from = Number(oldT.pct);
        const to = Number(t.pct);
        // Marge de bruit binomiale sur la fenêtre (z·√(2p(1−p)/n)) — un
        // changement n'est publié que s'il la dépasse.
        const margin = noiseMargin(
          Math.max(from, to),
          Math.max(Number(nExp.windowN || 0), Number(p.windowN || 0)),
          NOISE_Z,
        );
        const { changeType, change } = classifyChange(from, to, Math.max(MIN_DELTA, margin));
        if (!changeType || changeType === 'ROLLOUT_DATA_DEGRADED') continue;
        deltas.push({
          label: t.label,
          bucket: t.bucket,
          from,
          to,
          change,
          changeType,
          observed: t.observed,
          ranges: t.intervals || t.ranges || null,
          confidence: t.confidence,
          status: t.status,
          exact: false,
          population: 'user',
          treatment: t.label,
        });
      }
      if (deltas.length) {
        const fp2 = stableChangeFingerprint({
          id: nExp.id,
          deltas: deltas.map((d) => [d.bucket, d.from, d.to, d.changeType]),
        });
        changes.push({
          kind: 'pct',
          id: nExp.id,
          title: nExp.title,
          deltas,
          named: nExp.named,
          changeFingerprint: fp2,
          exact: false,
        });
      }
    }

    const prevTok = new Map((prev.token || []).map((t) => [t.hash, t]));
    for (const t of tokenSnap) {
      if (!hasName(t.id) && !NOTIFY_HASH) continue;
      const p = prevTok.get(t.hash);
      if (p && p.revision !== t.revision) {
        changes.push({
          kind: 'revision',
          id: t.id,
          title: t.title,
          fromRev: p.revision,
          toRev: t.revision,
          bucket: t.bucket,
        });
      }
    }
  }

  async function writeState(announcedMap, extra = {}) {
    const prevHist = Array.isArray(prev.history) ? prev.history : [];
    const histEntry = {
      ts: new Date().toISOString(),
      ok,
      fail,
      experimentCount: experiments.length,
      changeCount: (extra.changes && extra.changes.length) || 0,
    };
    const history = [...prevHist, histEntry].slice(-40);
    const stateObj = {
        scrapedAt: new Date().toISOString(),
        version: 13,
        schemaVersion: 13,
        runId:
          extra.runId ||
          new Date().toISOString().replace(/[:.]/g, '-') + '_' + Math.random().toString(36).slice(2, 8),
        samples: SAMPLES,
        ok,
        fail,
        tokensConfigured: TOKENS.length,
        experiments,
        token: tokenSnap,
        announced: announcedMap,
        history,
        lastChanges: extra.changes || prev.lastChanges || [],
        posWindow: nextWindow,
    };
    await writeJsonAtomic(STATE, stateObj, 2);
    writeReport(stateObj);
  }

  // Premier run OU upgrade ≤ v12 → v13 : seed silencieux (pas de flood).
  if (isFirst || isUpgrade) {
    const seedAnnounced = { ...announced };
    for (const e of experiments) {
      if (e.named || NOTIFY_HASH) seedAnnounced[String(e.hash)] = e.fingerprint;
    }
    await writeState(seedAnnounced);
    console.log(isUpgrade ? 'Upgrade seed → v13 (mesure propre)' : 'Seed', experiments.length, '· no notify');
    return;
  }

  await writeState(announced);

  console.log('Changes', changes.length);
  if (!changes.length) {
    console.log('No significant named user % change');
    return;
  }

  const embeds = buildEmbeds(changes);
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);

  if (!sent.ok) {
    console.warn('NOTIFY_FAIL user_rollouts — announced NOT advanced; will retry next run');
    process.exitCode = 2;
    return;
  }

  for (const c of changes) {
    if (c.kind === 'new' && c.hash != null && c.fingerprint) {
      announced[String(c.hash)] = c.fingerprint;
    }
    if (c.kind === 'pct' && c.id) {
      const exp = experiments.find((e) => e.id === c.id);
      if (exp) announced[String(exp.hash)] = exp.fingerprint;
    }
  }
  await writeState(announced);
  console.log('✅ Done (announced advanced after webhook OK)');
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = {
  main,
  murmur3,
  loadExperimentDefs,
  buildWindowTreatments,
  pruneWindow,
  windowAggregate,
  buildNextWindow,
  fingerprintOf,
  classifyChange,
  mergeIntervals,
};
