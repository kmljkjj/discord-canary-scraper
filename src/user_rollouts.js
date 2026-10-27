/**
 * User experiment rollouts v14 — MESURE PROPRE, zéro source communautaire.
 *
 * V14 (fiabilité + précision honnête) :
 *  - FENÊTRE UNIFIÉE : l'estimation est TOUJOURS agrégée sur la fenêtre
 *    complète (batches précédents élagués + batch du run courant) avec une
 *    seule politique de comptage. Avant, le dénominateur du run courant
 *    différait de celui que la fenêtre donnerait au run suivant.
 *  - RÉVISIONS : un changement de revision d'une expérience remet à zéro
 *    son historique dans la fenêtre (rollout reconfiguré ≠ bruit).
 *  - VALIDATION DU WIRE : réponse sans `assignments` = échec (avant : succès
 *    vide), doublons d'une même réponse ignorés, bucket/position validés.
 *  - NOTIFICATIONS PERDUES CORRIGÉES : les deltas sont calculés contre un
 *    « acknowledged » (dernier état NOTIFIÉ avec succès), pas contre le
 *    dernier état mesuré. Un échec de webhook ne perd plus le changement.
 *  - TOUS les changements sont envoyés (lots de 10 embeds) ; seuls les lots
 *    réellement livrés font avancer « acknowledged ».
 *  - MARGE DE BRUIT EXACTE : Var(Δp̂) calculée au niveau batch — les
 *    échantillons partagés entre deux fenêtres glissantes ne sont plus
 *    comptés deux fois (l'ancienne formule z·√(2p(1−p)/n) sur-estimait
 *    l'indépendance des fenêtres).
 *  - WILSON : intervalle de confiance de Wilson sur chaque % (valide aux
 *    extrêmes k=0 / k=n, contrairement à σ binomial brut).
 *  - BORNES RECONSTRUITES (INDICATIVES) : les positions hash_result
 *    observées permettent de reconstruire les plages d'un bucket
 *    (ordre-statistiques + correction « German tank »). C'est une seconde
 *    mesure, dépendante du modèle, affichée à côté de k/n — jamais
 *    présentée comme exacte.
 *
 * Méthode de mesure (inchangée dans son principe) :
 *  - /experiments anonyme (X-Request-Id unique par requête) → pour chaque
 *    échantillon : hash de l'expérience, revision, bucket assigné, position.
 *  - Par variante : k = nombre d'échantillons assignés, n = nombre total
 *    d'échantillons de la fenêtre → pct = k/n + IC de Wilson.
 *
 * Env:
 *   DISCORD_USER_TOKEN(S) / DISCORD_USER_TOKEN_1..10
 *   UR_WEBHOOK | USER_ROLLOUT_WEBHOOK_URL | APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   USER_ROLLOUT_SAMPLES        default 150 (échantillons par run — cible fixe)
 *   USER_ROLLOUT_CONCURRENCY    default 2
 *   USER_ROLLOUT_DELAY_MS       default 300
 *   USER_ROLLOUT_MIN_OK         default 25 (min samples OK pour estimer)
 *   USER_ROLLOUT_MAX_MS         default 90000 (budget temps du sampling)
 *   USER_ROLLOUT_WINDOW_H       default 4 (fenêtre glissante, en heures)
 *   USER_ROLLOUT_WINDOW_BATCHES default 60 (max runs gardés dans la fenêtre)
 *   USER_ROLLOUT_NOISE_Z        default 2 (seuil de bruit statistique ; 0 = off)
 *   USER_ROLLOUT_NOTIFY_HASH    default 0 (notifier aussi les hash sans nom)
 *   USER_ROLLOUT_PLATFORM_UAS   optionnel — User-Agents séparés par ||
 *                              (défaut : web + app desktop + Android + iOS)
 *   APEX_MIN_PCT_DELTA          default 1 (% min, en plus de la marge de bruit)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sendEmbeds } = require('./lib/webhook');
const { murmur3 } = require('./lib/murmur3');
const { fetchGistSnapshot } = require('./lib/gist_source');
const { writeJsonAtomic } = require('./lib/atomic');
const { sleep, redactSecrets, loadTokens, DEFAULT_UA, DEFAULT_BOT_NAME: BOT, DEFAULT_AVATAR_URL: AVATAR } = require('./lib/utils');
const { safeJson } = require('./lib/http');
const {
  classifyChange,
  stableChangeFingerprint,
  noiseMargin,
  wilsonPctInterval,
  slidingWindowDeltaMargin,
  reconstructBucketRanges,
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
const NOTIFY_HASH = String(process.env.USER_ROLLOUT_NOTIFY_HASH || '0') === '1';
const NOISE_Z = Math.max(0, Number(process.env.USER_ROLLOUT_NOISE_Z ?? 2));
const SCALE = DEFAULT_SCALE;
const WINDOW_H = Math.max(1, Number(process.env.USER_ROLLOUT_WINDOW_H || 4));
const WINDOW_H_MS = WINDOW_H * 3600 * 1000;
const MAX_BATCHES = Math.max(5, Number(process.env.USER_ROLLOUT_WINDOW_BATCHES || 60));
// Anneau de positions par (hash, bucket) — alimente la reconstruction de
// bornes (indicative). Capé pour garder l'état JSON compact.
const RING_CAP = 150;
// Limite Discord : 10 embeds par message → lots de 10 changements.
const EMBED_BATCH = 10;

/**
 * Rotation de plateformes : certains rollouts sont ciblés par plateforme
 * (ex. « android, desktop »). Chaque échantillon tire un contexte de
 * plateforme → couverture de tous les rollouts.
 */
const PLATFORM_UAS = String(process.env.USER_ROLLOUT_PLATFORM_UAS || '')
  .split('||')
  .map((s) => s.trim())
  .filter(Boolean);
const UAS = PLATFORM_UAS.length
  ? PLATFORM_UAS
  : [
      DEFAULT_UA,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9203 Chrome/124.0.0.0 Electron/30.5.0 Safari/537.36',
      'Discord-Android/261223; Android 15; PKQ1.241001.002',
      'Discord iOS/261223; iOS 18.5; iPhone16,2',
    ];

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

// ─── Fenêtre glissante (V14 : politique unique, revisions) ──────────────────

/**
 * Normalise + élague la fenêtre : batches plus vieux que WINDOW_H jetés,
 * au plus MAX_BATCHES gardées, anneaux de positions capés à RING_CAP.
 * Un batch = { bid, ts, ok, rev: {hash: revision}, c: {hash: {bucket: k}} }.
 */
function pruneWindow(raw, now) {
  const w = raw && typeof raw === 'object' && Array.isArray(raw.batches) ? raw : { batches: [], pos: {} };
  const cutoff = now - WINDOW_H_MS;
  const batches = w.batches
    .filter((b) => b && Number.isFinite(b.ts) && b.ts >= cutoff && b.c && typeof b.c === 'object')
    .slice(-MAX_BATCHES);
  const posIn = w.pos && typeof w.pos === 'object' ? w.pos : {};
  const pos = {};
  for (const [hashS, entry] of Object.entries(posIn)) {
    const src = entry && typeof entry === 'object' && entry.b && typeof entry.b === 'object' ? entry : null;
    const nb = {};
    if (src) {
      for (const [bS, arr] of Object.entries(src.b)) {
        const a = Array.isArray(arr) ? arr.filter((x) => Number.isFinite(x)) : [];
        if (a.length) nb[bS] = a.slice(-RING_CAP);
      }
    }
    if (Object.keys(nb).length) pos[hashS] = { rev: src && src.rev != null ? src.rev : null, b: nb };
  }
  return { batches, pos };
}

/**
 * Agrège les batches d'une fenêtre en UNE passe cohérente :
 *  - counts : hash → Map(bucket → k) (observations cumulées)
 *  - n      : hash → échantillons comptés DEPUIS la dernière apparition
 *    (ou le dernier changement de revision) du hash — chaque échantillon
 *    de chaque batch avait sa chance d'être assigné.
 * Un changement de revision remet le hash à zéro : un rollout reconfiguré
 * n'est pas mélangé avec ses anciennes mesures.
 */
function windowAggregate(win) {
  const state = new Map(); // hash → { counts: Map, n, rev }
  const batches = (win && Array.isArray(win.batches)) ? win.batches : [];
  for (const b of batches) {
    const c = b.c && typeof b.c === 'object' ? b.c : {};
    const rev = b.rev && typeof b.rev === 'object' ? b.rev : {};
    const ok = Math.max(0, Number(b.ok) || 0);

    // 1. Découverte / reset : hash vu pour la première fois ou revision changée.
    for (const hashS of Object.keys(c)) {
      const hash = Number(hashS);
      if (!Number.isFinite(hash)) continue;
      const r = rev[hashS];
      const cur = state.get(hash);
      if (!cur || (r != null && cur.rev != null && cur.rev !== r)) {
        state.set(hash, { counts: new Map(), n: 0, rev: r != null ? r : null });
      } else if (cur && r != null && cur.rev == null) {
        cur.rev = r;
      }
    }

    // 2. Accumulation : chaque hash connu voit TOUT le batch.
    for (const [hashS, cur] of state) {
      cur.n += ok;
      const buckets = c[hashS];
      if (!buckets) continue;
      for (const [bS, k] of Object.entries(buckets)) {
        const bucket = Number(bS);
        const kk = Number(k);
        if (!Number.isFinite(bucket) || !Number.isFinite(kk)) continue;
        cur.counts.set(bucket, (cur.counts.get(bucket) || 0) + kk);
      }
    }
  }

  const winCounts = new Map();
  const winN = new Map();
  for (const [hash, cur] of state) {
    winCounts.set(hash, cur.counts);
    winN.set(hash, cur.n);
  }
  return { winCounts, winN };
}

/**
 * Construit la fenêtre POUR SAUVEGARDE : batches précédentes (déjà élaguées)
 * + le batch du run courant (comptes compacts hash → bucket → k + revisions).
 * Chaque batch reçoit un identifiant unique (bid) pour la marge de bruit.
 */
function buildNextWindow(win, curCounts, curRevs, ok, now) {
  const c = {};
  for (const [hash, buckets] of curCounts) {
    const nb = {};
    for (const [bucket, k] of buckets) nb[String(bucket)] = k;
    c[String(hash)] = nb;
  }
  const rev = {};
  for (const [hash, r] of curRevs) rev[String(hash)] = r;
  const bid = 'b' + now + '_' + crypto.randomBytes(4).toString('hex');
  const batches = [...win.batches, { bid, ts: now, ok, rev, c }].slice(-MAX_BATCHES);
  return { batches, pos: win.pos || {} };
}

// ─── Estimation (V14 : k/n + Wilson + bornes indicatives) ──────────────────

/**
 * Traitements d'une expérience depuis les comptes cumulés de la fenêtre.
 * mergedCounts : Map(bucket → k) ; n : total d'échantillons de la fenêtre ;
 * ringPos : { bucket: [position, ...] } positions récentes (anneau).
 *
 * pct = k/n (binomial, non biaisé) + IC de Wilson.
 * Les positions servent à une reconstruction INDICATIVE des plages
 * (ordre-statistiques, correction German tank) — jamais présentée comme
 * exacte, affichée comme seconde mesure.
 */
function buildWindowTreatments(mergedCounts, n, ringPos) {
  const treatments = [];
  for (const [bucket, k] of mergedCounts) {
    const kk = Math.max(0, Number(k) || 0);
    const nn = Math.max(0, Number(n) || 0);
    if (!Number.isFinite(bucket) || kk <= 0 || nn <= 0) continue;
    const p = Math.min(1, Math.max(0, kk / nn));
    const pct = Math.round(p * 100 * 100) / 100;
    const ci = wilsonPctInterval(kk, nn, NOISE_Z || 2);
    let confidence = 'low';
    if (kk >= 30 && ci.sigma <= 1.5) confidence = 'high';
    else if (kk >= 12) confidence = 'medium';
    const status = confidence === 'low' ? 'degraded' : 'estimated';

    // Reconstruction INDICATIVE des plages depuis l'anneau de positions.
    const pts = [
      ...new Set(
        ((ringPos && ringPos.b && ringPos.b[String(bucket)]) || [])
          .map(Number)
          .filter((x) => Number.isFinite(x) && x >= 0 && x < SCALE),
      ),
    ];
    const rec = pts.length >= 3 ? reconstructBucketRanges(pts, SCALE) : null;
    const observed = pts.length ? [Math.min(...pts), Math.max(...pts)] : null;
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
      ci: { lo: ci.lo, hi: ci.hi, sigma: ci.sigma },
      // Bornes reconstruites (MODÈLE ordre-statistiques — indicatif).
      ranges: rec ? rec.ranges : [],
      indicativePct: rec ? rec.pct : null,
      indicativeCi: rec ? rec.ci : null,
      observed,
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
  // V14 : une réponse sans tableau `assignments` est INVALIDE (avant : elle
  // comptait comme un échantillon vide réussi et gonflait n à tort).
  if (!data || !Array.isArray(data.assignments)) throw new Error('réponse sans assignments');
  return {
    fingerprint: data.fingerprint,
    assignments: data.assignments,
  };
}

/**
 * Sample fingerprints to detect + measure user experiments.
 * Protocole FIXE : cible SAMPLES échantillons (plus d'arrêt sur « plateau »
 * de découverte, qui biaisait la densité de la fenêtre) ; le budget temps
 * reste la seule sortie anticipée.
 * Returns { byHash, byRev, ok, fail } avec
 * byHash : hash → Map(bucket → positions[]) ; byRev : hash → revision.
 */
async function sampleFingerprints(n, concurrency) {
  const byHash = new Map();
  const byRev = new Map();
  let ok = 0;
  let fail = 0;
  let next = 0;
  const deadline = Date.now() + MAX_MS;
  let stopReason = null;

  async function worker() {
    while (true) {
      const my = next++;
      if (my >= n) break;
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
          'User-Agent': UAS[my % UAS.length],
        });
        // V14 : validation stricte + dédoublonnage (cf. recordAssignments).
        recordAssignments(byHash, byRev, assignments);
        ok++;
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
  return { byHash, byRev, ok, fail };
}

/**
 * Applique une réponse d'assignments aux structures de sampling (PURE et
 * testable) : validation stricte + dédoublonnage par réponse.
 *  - bucket : entier ≥ -1
 *  - position (hash_result) : entier dans [0, SCALE)
 *  - un hash n'est compté qu'une fois par réponse (doublon ignoré)
 */
function recordAssignments(byHash, byRev, assignments) {
  if (!Array.isArray(assignments)) return 0;
  const seenInResponse = new Set();
  let recorded = 0;
  for (const a of assignments) {
    if (!Array.isArray(a) || a.length < 6) continue;
    const hash = Number(a[0]);
    const rev = a[1] == null ? null : Number(a[1]);
    const bucket = Number(a[2]);
    const hr = Number(a[5]);
    if (!Number.isFinite(hash) || seenInResponse.has(hash)) continue;
    seenInResponse.add(hash);
    if (!Number.isFinite(bucket) || bucket < -1 || !Number.isInteger(bucket)) continue;
    if (!Number.isFinite(hr) || hr < 0 || hr >= SCALE || !Number.isInteger(hr)) continue;
    if (rev != null && Number.isFinite(rev)) {
      // Changement de revision AU MILIEU du run : les observations de
      // l'ancienne configuration sont jetées (pas mélangées avec la nouvelle).
      const prevRev = byRev.get(hash);
      if (prevRev != null && prevRev !== rev) byHash.set(hash, new Map());
      byRev.set(hash, rev);
    }
    if (!byHash.has(hash)) byHash.set(hash, new Map());
    const bm = byHash.get(hash);
    if (!bm.has(bucket)) bm.set(bucket, []);
    bm.get(bucket).push(hr);
    recorded++;
  }
  return recorded;
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
  const list = TOKENS.slice(0, 10);
  const runOffset = Math.floor(Date.now() / (20 * 60 * 1000));
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    try {
      const data = await fetchAssignments(
        { Authorization: token, 'User-Agent': UAS[(i + runOffset) % UAS.length] },
        true,
      );
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

// ─── Embeds — format sobre, sans emojis ─────────────────────────────────────

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
  for (const c of changes.slice(0, EMBED_BATCH)) {
    const title = (String(c.id || c.title) + ' (user)').slice(0, 256);
    const lines = [];

    if (c.title && c.title !== c.id) lines.push(String(c.title).slice(0, 300));

    if (c.kind === 'new') {
      for (const t of (c.treatments || []).slice(0, 12)) {
        lines.push(variantLabel(t.bucket) + ' ' + (t.pctKnown && t.pct != null ? fmtPct(t.pct) + '%' : '?%'));
      }
    } else if (c.kind === 'pct') {
      for (const d of (c.deltas || []).slice(0, 12)) {
        let line = variantLabel(d.bucket) + ' ' + fmtPct(d.from) + '% -> ' + fmtPct(d.to) + '%';
        if (d.ci) line += ' (±' + fmtPct(d.ci) + ')';
        lines.push(line);
        if (d.ranges && d.ranges.length) {
          lines.push('  bornes reconstruites (indicatif) : ' + d.ranges.map(([a, b]) => '[' + a + ', ' + b + ']').join(' + '));
        }
      }
    } else if (c.kind === 'revision') {
      lines.push('Revision ' + c.fromRev + ' -> ' + c.toRev + ' - ' + variantLabel(c.bucket));
    } else if (c.kind === 'config') {
      lines.push(
        'Couverture publiée : ' + fmtPct(c.fromPct) + '% -> ' + fmtPct(c.toPct) + '%',
      );
      lines.push('Mesure indépendante k/n non incluse — voir le rapport.');
    } else if (c.kind === 'config-new') {
      lines.push('Nouvelle expérience dans les plages publiées : ' + fmtPct(c.configPct) + '%');
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
          (c.kind === 'revision'
            ? 'Rollouts Revision'
            : c.kind === 'config' || c.kind === 'config-new'
              ? 'Rollouts Config (gist communautaire)'
              : 'Rollouts Changes') +
          (c.source === 'community_gist' ? ' · Source: plages publiées par la communauté' : ' · Source: mesure propre · API Discord'),
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

/** Rapport texte lisible — régénéré avec le JSON. */
function writeReport(state, reportFile) {
  try {
    const fmt = (p) => String(p).replace('.', ',') + ' %';
    const conf = (c) => (c === 'high' ? 'élevée' : c === 'medium' ? 'moyenne' : 'faible');
    const exps = (state.experiments || []).slice();
    const n = exps.reduce((m, e) => Math.max(m, Number(e.windowN) || 0), 0);
    const gen = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const out = [];
    out.push('# Rollouts user — mesure propre (v14)', '');
    const gistInfo = state.gist || null;
    out.push(
      '> Mis à jour automatiquement toutes les 20 min · Source : API Discord + gist communautaire (plages publiées) · Généré le ' +
        gen +
        ' UTC',
      '',
    );
    if (gistInfo && !gistInfo.stale) {
      const pub = gistInfo.publishedAt
        ? 'publié le ' + gistInfo.publishedAt
        : 'date de publication inconnue (repli brut)';
      out.push(
        '**Plages publiées** : ' +
          (gistInfo.count || 0) +
          ' expériences · gist ' +
          (gistInfo.gistId || '?') +
          ' · ' +
          pub +
          ' · [plages publiées par la communauté — producteur non identifié]',
        '',
      );
    } else if (gistInfo && gistInfo.stale) {
      out.push('> Plages publiées : dernier snapshot indisponible (stale) — publié le ' + (gistInfo.publishedAt || '?'), '');
    }
    out.push('**Fenêtre glissante 4 h — n = ' + n + ' échantillons — ' + (state.tokensConfigured || 0) + ' tokens actifs**', '');
    out.push('**Méthode** : k/n (binomial, non biaisé) + intervalle de confiance de Wilson. Population mesurée : échantillons anonymes multi-contextes (web, desktop, Android, iOS) — pas un recensement des utilisateurs Discord.', '');
    out.push('**Deux mesures distinctes** : le % mesuré (k/n + IC, population échantillonnée) et la couverture publiée (plages du gist, parmi la population éligible — filtres non exportés). Un écart entre les deux est signalé « écart non expliqué », sans interprétation.', '');
    out.push('Les plages « reconstruites » sont une seconde mesure INDICATIVE (ordre-statistiques, dépendante du modèle) : un heuristique de séparation peut fragmenter une plage uniforme → à lire comme un ordre de grandeur, pas une certitude.', '');

    // ── Comparabilité (V15) : bucket à bucket, jamais union contre un seul
    // bucket mesuré. La couverture publiée d'un BUCKET doit tomber dans
    // l'IC de Wilson du BUCKET mesuré correspondant. Les enregistrements
    // aux plages ambiguës (populations aplaties) sont EXCLUS de la
    // comparaison statistique — l'union est géométrique, elle ne se
    // prétend pas « % de la population éligible ».
    const comparability = (e, ts) => {
      if (!e.config) return { cmp: '—', cfg: '—' };
      const cfg = e.config.pct != null ? fmt(e.config.pct) : '—';
      if (e.config.ambiguous) {
        return { cmp: 'plages ambiguës — union géométrique, pas de comparaison', cfg };
      }
      let anyCompared = false;
      let allInside = true;
      for (const t of ts) {
        if (!(t.bucket > 0) || !t.ci || t.ci.lo == null) continue;
        const pub = e.config.b && e.config.b[t.bucket];
        if (pub == null) continue;
        anyCompared = true;
        if (pub < t.ci.lo - 1e-9 || pub > t.ci.hi + 1e-9) allInside = false;
      }
      if (!anyCompared) return { cmp: '—', cfg };
      return { cmp: allInside ? 'cohérent' : 'écart non expliqué', cfg };
    };

    out.push('## Expériences mesurées (' + exps.length + ')', '');
    out.push('| Expérience | % mesuré | IC 95 % | Config publiée (union) | Comparabilité (bucket à bucket) | k/n | Confiance | Statut |');
    out.push('|---|---:|---|---:|---|---:|---|---|');
    for (const e of exps) {
      const ts = e.treatments || [];
      const best = ts.reduce((a, t) => ((t.bucket || 0) > 0 && (a == null || (t.pct || 0) > a) ? t.pct : a), null);
      const bestT = ts.find((t) => t.pct === best) || ts[0] || {};
      const st = e.status === 'degraded' ? 'Mesuré (n faible)' : 'Mesuré';
      const ci = bestT.ci ? '[' + String(bestT.ci.lo).replace('.', ',') + ' – ' + String(bestT.ci.hi).replace('.', ',') + ']' : '—';
      const { cmp, cfg } = comparability(e, ts);
      out.push('| ' + (e.title || e.id || 'hash:' + e.hash) + ' | **' + (best == null ? '—' : fmt(best)) + '** | ' + ci + ' | ' + cfg + ' | ' + cmp + ' | ' + (bestT.sampleCount != null ? bestT.sampleCount + '/' + (e.windowN || '?') : (e.windowN || '?')) + ' | ' + conf(bestT.confidence) + ' | ' + st + ' |');
    }
    out.push('', '## Couverture publiée — résumé', '');
    out.push(
      'Table complète (' +
        ((gistInfo && gistInfo.count) || 0) +
        ' expériences, plages exactes) : `data/user_rollouts_exact.json` — couverture CONFIGURÉE (population éligible), pas le % d\'utilisateurs réels.',
    );
    if (gistInfo && gistInfo.url) {
      out.push('', 'Provenance : [gist ' + (gistInfo.gistId || '?') + '](' + gistInfo.url + ')');
    }
    out.push('', '## Détail par variante');
    for (const e of exps) {
      out.push('', '### ' + (e.title || e.id || 'hash:' + e.hash));
      for (const t of e.treatments || []) {
        out.push('- ' + (t.label || 'Bucket ' + t.bucket) + ' : ' + fmt(t.pct) + ' (IC 95 % [' + String((t.ci || {}).lo ?? '?').replace('.', ',') + ' ; ' + String((t.ci || {}).hi ?? '?').replace('.', ',') + '], ' + (t.sampleCount != null ? t.sampleCount + '/' + e.windowN : 'n=' + e.windowN) + ', confiance ' + conf(t.confidence) + ')');
        if (t.ranges && t.ranges.length) {
          out.push('  - plages reconstruites (indicatif, ordre de grandeur) : ' + t.ranges.map(([a, b]) => '[' + a + ', ' + b + ']').join(' + ') + ' → ' + fmt(t.indicativePct));
        }
      }
    }
    // Guild — % exacts + expériences en attente (experiment_rollouts.json, nos propres sources)
    try {
      const er = JSON.parse(fs.readFileSync(path.join(DATA, 'experiment_rollouts.json'), 'utf8'));
      const guild = (er.matchedExperiments || []).filter((g) => g && g.type === 'guild' && g.percentage != null);
      if (guild.length) {
        out.push('', '## Guild — % exacts (API Discord, toutes les 20 min) — ' + guild.length, '');
        out.push('| Expérience | % | Statut |');
        out.push('|---|---:|---|');
        for (const g of guild) {
          const st = g.status === 'full_rollout' ? 'Rollout complet' : g.status === 'not_started' ? 'Pas commencé' : (g.status || '');
          out.push('| ' + (g.title || g.id || 'hash_' + g.hash) + ' | ' + g.percentage + ' % | ' + st + ' |');
        }
      }
      const waiting = (er.matchedExperiments || []).filter((g) => g && g.type === 'user' && g.percentage == null && (g.id || g.title));
      if (waiting.length) {
        out.push('', '## En attente de rollout — ' + waiting.length + ' expériences user', '');
        out.push('Discord ne publie pas encore leur pourcentage. Dès qu\'un rollout démarre, l\'expérience monte dans la section mesurées avec son % réel (2 décimales).');
        out.push('');
        out.push(waiting.map((g) => '- ' + (g.title || g.id)).join('\n'));
      }
    } catch (e2) { /* experiment_rollouts.json absent au premier run */ }
    fs.writeFileSync(reportFile || path.join(DATA, 'user_rollouts.md'), out.join('\n') + '\n');
  } catch (e) {
    console.warn('report skip:', String((e && e.message) || e).slice(0, 80));
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

/** Extrait un snapshot acknowledged {rev, n, b:{bucket:pct}} d'une expérience. */
function ackSnapshot(exp, rev, n) {
  const b = {};
  for (const t of (exp && exp.treatments) || []) {
    if (t && t.pctKnown && t.pct != null) b[String(t.bucket)] = Number(t.pct);
  }
  return { rev: rev ?? null, n: n ?? null, b };
}

async function main(deps = {}) {
  // Injection (tests d'intégration) : stateFile/reportFile pour un état
  // temporaire, sampler/tokenSnapshot/postWebhook pour des doubles purs.
  const stateFile = deps.stateFile || STATE;
  const reportFile = deps.reportFile || path.join(DATA, 'user_rollouts.md');
  const sampler = deps.sampler || sampleFingerprints;
  const tokenSnapFn = deps.tokenSnapshot || fetchTokenSnapshot;
  const postWebhookFn = deps.postWebhook || postWebhook;
  const gistSnapshotFn = deps.gistSnapshot || fetchGistSnapshot;

  await fs.ensureDir(path.dirname(stateFile));
  console.log('📊 User rollouts v14 (MESURE PROPRE · sampling + fenêtre ' + WINDOW_H + ' h)');
  console.log('Samples:', SAMPLES, 'concurrency:', CONC, 'tokens:', TOKENS.length);
  console.log('Webhook:', WEBHOOK ? 'set (' + WEBHOOK_SOURCE + ')' : 'MISSING');
  console.log('Notify unresolved hash:', NOTIFY_HASH ? 'yes' : 'no');

  let prev = { experiments: [], token: [], announced: {}, acknowledged: {} };
  if (await fs.pathExists(stateFile)) {
    try {
      prev = await fs.readJson(stateFile);
    } catch (_) {}
  }
  const announced = prev.announced && typeof prev.announced === 'object' ? { ...prev.announced } : {};
  let acknowledged =
    prev.acknowledged && typeof prev.acknowledged === 'object' ? { ...prev.acknowledged } : {};
  // « Premier run » : aucune mesure ET aucune baseline de couverture publiée
  // (une run sans expérience mesurée mais avec ackConfig n'est PAS un premier
  // run — sinon les changements de couverture publiée seraient perdus).
  const isFirst =
    !(prev.experiments && prev.experiments.length) &&
    !(prev.ackConfig && Object.keys(prev.ackConfig).length);
  // Upgrade < v14 : passage au acknowledged (baseline de notification) —
  // re-seed silencieux, pas de flood de « rattrapage ».
  const isUpgrade = !isFirst && Number(prev.version) !== 14;
  if (isUpgrade) {
    // Migration : initialise acknowledged depuis la dernière mesure connue.
    acknowledged = {};
    const prevTokRev = new Map((prev.token || []).map((t) => [String(t.hash), t.revision]));
    for (const e of prev.experiments || []) {
      if (e && e.hash != null) {
        acknowledged[String(e.hash)] = ackSnapshot(
          e,
          prevTokRev.get(String(e.hash)) ?? null,
          e.windowN ?? null,
        );
      }
    }
  }

  // Noms : fichiers locaux uniquement.
  const defs = await loadExperimentDefs();

  const [tokenSnapR, sampledR] = await Promise.allSettled([
    tokenSnapFn(defs),
    sampler(SAMPLES, CONC),
  ]);
  const tokenSnap = tokenSnapR.status === 'fulfilled' ? tokenSnapR.value : [];
  const sampled = sampledR.status === 'fulfilled'
    ? sampledR.value
    : { byHash: new Map(), byRev: new Map(), ok: 0, fail: 0 };
  const { byHash, byRev, ok, fail } = sampled;
  console.log('Token snapshot:', tokenSnap.length, 'experiments');
  if (ok < MIN_OK) {
    console.warn('Too few ok samples', ok, '<', MIN_OK, '— estimation fenêtre seulement');
  }

  // ---- Fenêtre : agrégation UNIFIÉE (batches précédents + run courant) ----
  const now = Date.now();
  const winOld = pruneWindow(prev.posWindow, now);
  const curCounts = new Map(); // hash → Map(bucket → k)
  for (const [hash, bucketMap] of byHash) {
    const m = new Map();
    for (const [bucket, positions] of bucketMap) m.set(Number(bucket), positions.length);
    curCounts.set(hash, m);
  }
  const nextWindow = buildNextWindow(winOld, curCounts, byRev, ok, now);

  // Anneaux de positions : anciens (revision identique seulement) + run courant.
  const mergedPos = {};
  const posKeys = new Set([...Object.keys(winOld.pos || {}), ...[...curCounts.keys()].map(String)]);
  for (const hashS of posKeys) {
    const curRev = byRev.get(Number(hashS)) ?? null;
    const old = (winOld.pos || {})[hashS];
    const buckets = {};
    // Positions conservées uniquement si la revision n'a pas changé.
    if (old && old.b && (curRev == null || old.rev == null || old.rev === curRev)) {
      for (const [bS, arr] of Object.entries(old.b)) {
        if (Array.isArray(arr) && arr.length) buckets[bS] = [...arr];
      }
    }
    const cur = byHash.get(Number(hashS));
    if (cur) {
      for (const [bucket, positions] of cur) {
        const key = String(bucket);
        buckets[key] = [...(buckets[key] || []), ...(positions || [])].slice(-RING_CAP);
      }
    }
    if (Object.keys(buckets).length) mergedPos[hashS] = { rev: curRev, b: buckets };
  }
  nextWindow.pos = mergedPos;

  // ---- Estimation par expérience : UNE SEULE fenêtre (V14) ----
  const { winCounts, winN } = windowAggregate(nextWindow);
  const experiments = [];
  for (const [hash, m] of winCounts) {
    const n = winN.get(hash) || 0;
    if (n < MIN_OK) continue;
    const totalK = [...m.values()].reduce((s, x) => s + x, 0);
    if (totalK < 3) continue; // trop peu d'observations → attendre la fenêtre

    const def = defs.get(hash) || {
      id: 'hash:' + hash,
      hash,
      title: 'hash:' + hash,
      type: 'user',
    };
    const { treatments, status: rollStatus, sumPct } = buildWindowTreatments(
      m,
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

  // ---- Source communautaire (gist agnonotdev) : plages exactes publiées ----
  // Deux mesures DISTINCTES, jamais fusionnées : la couverture CONFIGURÉE
  // (plages publiées, parmi la population éligible — filtres non exportés)
  // et le taux OBSERVÉ par notre échantillonnage (k/n + Wilson). Les
  // écarts entre les deux sont AFFICHÉS, jamais « expliqués ».
  let gist = { ok: false, stale: true, parsed: { byHash: new Map(), count: 0 }, provenance: null };
  try {
    const r = await gistSnapshotFn();
    if (r && r.ok) gist = r;
  } catch (_) {}
  const gistOk = !!(gist && gist.ok && gist.parsed && gist.parsed.byHash);
  let ackConfig =
    prev.ackConfig && typeof prev.ackConfig === 'object' ? { ...prev.ackConfig } : {};

  const exactFile = path.join(path.dirname(stateFile), 'user_rollouts_exact.json');
  // configByHash : hash → { pct, b: {bucket: pct}, publishedAt, ambiguous }
  // (depuis le gist frais, OU depuis la dernière table valide si le gist
  // est indisponible — jamais de config « fantôme » ni de 0 % inventé).
  let configByHash = null;
  let tableToWrite = null;
  if (gistOk) {
    console.log(
      'Gist communautaire:',
      gist.parsed.count,
      'expériences · publié',
      gist.provenance && gist.provenance.publishedAt,
      gist.parsed.hashCollisions ? '· ' + gist.parsed.hashCollisions + ' collisions hash' : '',
    );

    configByHash = new Map();
    const entries = [];
    for (const g of gist.parsed.byHash.values()) {
      // % publié PAR VARIANT (bucket) — la comparaison avec la mesure se
      // fait bucket à bucket, jamais union contre un seul bucket mesuré.
      const b = {};
      for (const r of g.roles) {
        if (r.role === 'treatment' && r.bucket != null) b[r.bucket] = r.pct;
      }
      const def = defs.get(g.hash);
      configByHash.set(g.hash, {
        pct: g.treatment ? g.treatment.pct : null,
        b,
        publishedAt: gist.provenance ? gist.provenance.publishedAt : null,
        gistId: gist.provenance ? gist.provenance.gistId : null,
        url: gist.provenance ? gist.provenance.url : null,
        ambiguous: !!g.ambiguous,
      });
      entries.push({
        hash: g.hash,
        id: g.id,
        // Type résolu via les définitions locales ; sinon null (inconnu —
        // le gist mélange expériences user et guild, on ne devine JAMAIS).
        type: def && def.type ? def.type : null,
        treatmentPct: g.treatment ? g.treatment.pct : null,
        controlPct: g.control ? g.control.pct : null,
        b,
        ambiguous: !!g.ambiguous,
      });
    }
    tableToWrite = {
      fetchedAt: new Date().toISOString(),
      provenance: gist.provenance,
      stale: !!gist.stale,
      hashCollisions: gist.parsed.hashCollisions || 0,
      count: entries.length,
      experiments: entries,
    };
  } else if (prev.gist && typeof prev.gist === 'object') {
    // Gist indisponible : réutiliser la dernière table valide, marquée
    // stale — état et page restent cohérents (la page lit la table).
    console.warn('Gist communautaire indisponible — dernier snapshot conservé (stale)');
    try {
      if (await fs.pathExists(exactFile)) {
        const t = await fs.readJson(exactFile);
        if (Array.isArray(t.experiments) && t.experiments.length) {
          configByHash = new Map();
          for (const g of t.experiments) {
            configByHash.set(g.hash, {
              pct: g.treatmentPct != null ? g.treatmentPct : null,
              b: g.b || {},
              publishedAt: (t.provenance && t.provenance.publishedAt) || null,
              gistId: (t.provenance && t.provenance.gistId) || null,
              url: (t.provenance && t.provenance.url) || null,
              ambiguous: !!g.ambiguous,
              retained: true,
            });
          }
          // Réécriture avec stale: true (provenance conservée).
          tableToWrite = { ...t, stale: true };
        }
      }
    } catch (_) {}
  } else {
    console.warn('Gist communautaire indisponible — pas encore de snapshot');
  }

  // 1) Attache la couverture publiée aux expériences MESURÉES (même hash).
  if (configByHash) {
    for (const e of experiments) {
      const c = configByHash.get(Number(e.hash));
      if (c && c.pct != null) {
        e.config = {
          pct: c.pct,
          b: c.b || {},
          publishedAt: c.publishedAt,
          gistId: c.gistId,
          url: c.url,
          ambiguous: !!c.ambiguous,
        };
      }
    }
  }

  // 2) Table complète pour la page (data/user_rollouts_exact.json),
  //    écrite même si l'échantillonnage est dégradé.
  if (tableToWrite) {
    await writeJsonAtomic(exactFile, tableToWrite, 2);
  }

  // 3) Changements de couverture publiée : même pipeline de notification
  //    (acknowledged, lots de 10, retry) — jamais perdus.
  //    Détection à la résolution PUBLIÉE (0,01 pt — les plages sont des
  //    entiers exacts, un changement n'est jamais du bruit statistique),
  //    par bucket (une redistribution entre variants est un changement)
  //    ; la suppression éventuelle est une POLITIQUE explicite
  //    (USER_ROLLOUTS_CONFIG_MIN_DELTA, défaut 0,01 pt).
  const configChanges = [];
  const CONFIG_MIN_DELTA = Number(process.env.USER_ROLLOUTS_CONFIG_MIN_DELTA || '0.01') || 0.01;
  if (configByHash && gistOk) {
    const isConfigFirst = !prev.ackConfig; // pas encore de baseline → seed
    for (const g of gist.parsed.byHash.values()) {
      if (!g.treatment) continue;
      if (!hasName(g.id) && !NOTIFY_HASH) continue;
      const key = String(g.hash);
      const pct = g.treatment.pct;
      const b = {};
      for (const r of g.roles) {
        if (r.role === 'treatment' && r.bucket != null) b[r.bucket] = r.pct;
      }
      const prevEntry = ackConfig[key];
      if (prevEntry == null || typeof prevEntry !== 'object') {
        if (pct <= 0) continue; // pas de rollout → rien à annoncer
        if (isConfigFirst) {
          ackConfig[key] = { pct, v: b }; // seed silencieux de la baseline
          continue;
        }
        configChanges.push({
          kind: 'config-new',
          hash: g.hash,
          id: g.id,
          title: g.id,
          configPct: pct,
          configV: b,
          source: 'community_gist',
        });
        continue;
      }
      const prevPct = typeof prevEntry === 'object' ? prevEntry.pct : prevEntry;
      const prevV = (prevEntry && prevEntry.v) || {};
      const totalChanged =
        prevPct != null && pct != null && Math.abs(prevPct - pct) >= CONFIG_MIN_DELTA;
      // Redistribution : un bucket apparaît/disparaît ou change (résolution
      // publiée), même si l'union totale ne bouge pas.
      const bucketChanged = (a, bb) =>
        (a == null) !== (bb == null) || (a != null && bb != null && Math.abs(a - bb) >= CONFIG_MIN_DELTA);
      const allBuckets = new Set([...Object.keys(prevV), ...Object.keys(b)]);
      let redistributed = false;
      for (const bk of allBuckets) {
        if (bucketChanged(prevV[bk], b[bk])) {
          redistributed = true;
          break;
        }
      }
      if (totalChanged || redistributed) {
        configChanges.push({
          kind: 'config',
          hash: g.hash,
          id: g.id,
          title: g.id,
          fromPct: prevPct,
          toPct: pct,
          fromV: prevV,
          toV: b,
          redistributed,
          source: 'community_gist',
        });
      }
    }
    // Les expériences absentes du gist ne sont NI supprimées de ackConfig
    // NI annoncées « terminées » — aucune invention (advisor: pas de 0 %).
  }

  const changes = [];
  if (!isFirst && !isUpgrade) {
    // Base de comparaison : acknowledged (dernier état NOTIFIÉ). L'absence
    // d'entrée acknowledged signifie JAMAIS livré → annonce « new » (le
    // fingerprint announced évite de répéter deux fois le même état).
    for (const nExp of experiments) {
      if (!nExp.named && !NOTIFY_HASH) continue;

      const key = String(nExp.hash);
      const fp = nExp.fingerprint;
      if (announced[key] === fp) continue;

      const ack = acknowledged[key];
      const ackTreatments =
        ack && ack.b && Object.keys(ack.b).length
          ? Object.entries(ack.b).map(([bucket, pct]) => ({ bucket: Number(bucket), pctKnown: true, pct }))
          : null;

      if (!ackTreatments) {
        if (nExp.status === 'insufficient_data' || nExp.status === 'degraded') continue;
        changes.push({ kind: 'new', ...nExp });
        continue;
      }
      if (nExp.status === 'degraded' || nExp.status === 'insufficient_data' || nExp.status === 'unknown') {
        continue;
      }

      const deltas = [];
      const pt = new Map(ackTreatments.map((t) => [t.bucket, t]));
      // Marge de bruit CONSERVATRICE : la formule exacte au niveau batch ne
      // décrit que la fenêtre précédente immédiate ; la baseline acknowledged
      // peut être plus vieille → on prend aussi la marge binomiale sur le
      // plus petit des deux n (acknowledged vs courant).
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
              ranges: t.ranges || null,
              ci: t.ci ? t.ci.sigma : null,
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
        const nAck = Number(ack && ack.n) || 0;
        const margin = Math.max(
          slidingWindowDeltaMargin(winOld.batches, nextWindow.batches, Math.max(from, to), NOISE_Z),
          noiseMargin(Math.max(from, to), Math.max(1, Math.min(nAck || nExp.windowN, nExp.windowN)), NOISE_Z),
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
          ranges: t.ranges || null,
          ci: t.ci ? t.ci.sigma : null,
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
          hash: nExp.hash,
          deltas,
          named: nExp.named,
          changeFingerprint: fp2,
          exact: false,
        });
      }
    }

    // Revisions : comparées au dernier état NOTIFIÉ (acknowledged.rev),
    // avec repli sur le dernier état mesuré — un échec de webhook ne perd
    // plus l'annonce de revision.
    const prevTok = new Map((prev.token || []).map((t) => [t.hash, t]));
    for (const t of tokenSnap) {
      if (!hasName(t.id) && !NOTIFY_HASH) continue;
      const ack = acknowledged[String(t.hash)];
      const prevRev = ack && ack.rev != null ? ack.rev : (prevTok.get(t.hash) || {}).revision;
      if (prevRev != null && prevRev !== t.revision) {
        changes.push({
          kind: 'revision',
          id: t.id,
          title: t.title,
          hash: t.hash,
          fromRev: prevRev,
          toRev: t.revision,
          bucket: t.bucket,
        });
      }
    }
  }

  async function writeState(ackMap, extra = {}) {
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
      version: 14,
      schemaVersion: 14,
      runId:
        extra.runId ||
        new Date().toISOString().replace(/[:.]/g, '-') + '_' + Math.random().toString(36).slice(2, 8),
      samples: SAMPLES,
      ok,
      fail,
      tokensConfigured: TOKENS.length,
      experiments,
      token: tokenSnap,
      announced: extra.announcedMap ?? announced,
      acknowledged: ackMap,
      ackConfig: extra.ackConfig ?? ackConfig,
      gist: gistOk
        ? { ...gist.provenance, stale: !!gist.stale, count: gist.parsed.count }
        : prev.gist && typeof prev.gist === 'object'
          ? { ...prev.gist, stale: true }
          : null,
      history,
      lastChanges: extra.changes || prev.lastChanges || [],
      posWindow: nextWindow,
    };
    await writeJsonAtomic(stateFile, stateObj, 2);
    writeReport(stateObj, reportFile);
    return stateObj;
  }

  // Premier run OU upgrade < v14 : seed silencieux (pas de flood).
  if (isFirst || isUpgrade) {
    const seedAck = { ...acknowledged };
    const seedAnnounced = { ...announced };
    for (const e of experiments) {
      if (e.named || NOTIFY_HASH) {
        seedAnnounced[String(e.hash)] = e.fingerprint;
        seedAck[String(e.hash)] = ackSnapshot(e, byRev.get(e.hash) ?? null, e.windowN);
      }
    }
    await writeState(seedAck, { announcedMap: seedAnnounced });
    console.log(isUpgrade ? 'Upgrade seed → v14 (acknowledged baseline)' : 'Seed', experiments.length, '· no notify');
    return;
  }

  // Les changements de couverture publiée rejoignent le MÊME pipeline de
  // livraison (lots de 10, acknowledged, retry) que les mesures propres.
  changes.push(...configChanges);

  await writeState(acknowledged);

  console.log('Changes', changes.length, '(dont config publiée:', configChanges.length + ')');
  if (!changes.length) {
    console.log('No significant named user % change');
    return;
  }

  // V14 : TOUS les changements partent, par lots de 10 embeds ; acknowledged
  // n'avance que pour les lots réellement livrés (fin sur échec → exit 2).
  const expByHash = new Map(experiments.map((e) => [String(e.hash), e]));
  const expForChange = (c) =>
    expByHash.get(String(c.hash)) ||
    (c.id ? experiments.find((e) => e.id === c.id) : null);
  let delivered = 0;
  let sendFailed = false;
  for (let i = 0; i < changes.length; i += EMBED_BATCH) {
    const chunk = changes.slice(i, i + EMBED_BATCH);
    const embeds = buildEmbeds(chunk);
    const sent = await postWebhookFn(embeds);
    console.log('Webhook lot', Math.floor(i / EMBED_BATCH) + 1, sent.status, sent.ok ? 'OK' : sent.text);
    if (!sent.ok) {
      sendFailed = true;
      break;
    }
    delivered += chunk.length;
    for (const c of chunk) {
      const key = String(c.hash != null ? c.hash : '');
      if (c.kind === 'config' || c.kind === 'config-new') {
        // Même format que le seed ({ pct, v }) — la redistribution par
        // bucket est la baseline de comparaison, pas juste l'union.
        ackConfig[key] =
          c.kind === 'config' ? { pct: c.toPct, v: c.toV } : { pct: c.configPct, v: c.configV };
        continue;
      }
      if (c.kind === 'revision' && c.hash != null) {
        const ack = acknowledged[key] || { rev: null, n: null, b: {} };
        acknowledged[key] = { ...ack, rev: c.toRev };
        continue;
      }
      const exp = expForChange(c);
      if (exp) {
        acknowledged[String(exp.hash)] = ackSnapshot(exp, byRev.get(exp.hash) ?? null, exp.windowN);
        announced[String(exp.hash)] = exp.fingerprint;
      }
    }
  }

  await writeState(acknowledged, { changes: changes.slice(0, delivered), ackConfig });

  if (sendFailed) {
    console.warn('NOTIFY_FAIL user_rollouts — acknowledged avancé pour les ' + delivered + ' changements livrés seulement ; le reste sera retenté');
    process.exitCode = 2;
    return;
  }
  console.log('✅ Done — ' + delivered + ' changements notifiés, acknowledged à jour');
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
  ackSnapshot,
  recordAssignments,
};
