/**
 * User experiment rollouts v15 — MESURE PROPRE, zéro source communautaire.
 *
 * V15 (précision) :
 *  - % EXACTS pour les expériences NOMMÉES : la position d'un fingerprint
 *    est déterministe (murmur3(`id:fingerprintId`) % 10000). On la recalcule
 *    pour CHAQUE échantillon de la fenêtre — y compris ceux HORS rollout —
 *    et on la vérifie contre hash_result. Points positifs + négatifs →
 *    chaque borne est encadrée → plages et % exacts (± 10000/n) au lieu
 *    de k/n (±0,5 % typiquement, notifications bruitées).
 *  - Repli automatique sur k/n si la vérification échoue ou si le rollout
 *    est filtré (plateforme, ancienneté…) — détecté par points contradictoires.
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
 *   USER_ROLLOUT_SAMPLE_CAP     default 4000 (échantillons gardés pour la mesure exacte)
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
const { inferExactRanges } = require('./lib/exact_ranges');

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
// V15 : échantillons individuels gardés pour la mesure EXACTE (positions
// recalculées pour TOUS les fingerprints, y compris hors rollout).
const SAMPLE_CAP = Math.max(500, Number(process.env.USER_ROLLOUT_SAMPLE_CAP || 4000));
// Label interne « absent des assignments » (hors rollout).
const ABSENT = -99;
const STATE_VERSION = 15;

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
  const samples = (Array.isArray(w.samples) ? w.samples : [])
    .filter((x) => x && typeof x.f === 'string' && Number.isFinite(x.t) && x.t >= cutoff && x.a && typeof x.a === 'object')
    .slice(-SAMPLE_CAP);
  const since = w.since && typeof w.since === 'object' ? { ...w.since } : {};
  return { batches, pos, samples, since };
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
function windowAggregateCore(win, skip) {
  const state = new Map(); // hash → { counts: Map, n, rev, absent: [indices de batch sans aucune réponse contenant le hash] }
  const batches = (win && Array.isArray(win.batches)) ? win.batches : [];
  batches.forEach((b, idx) => {
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
        state.set(hash, { counts: new Map(), n: 0, rev: r != null ? r : null, absent: [] });
      } else if (cur && r != null && cur.rev == null) {
        cur.rev = r;
      }
    }

    // 2. Accumulation : chaque hash connu voit TOUT le batch, sauf un batch jugé
    //    « panne » pour ce hash (cf. detectOutages) qui n'est pas compté du tout.
    for (const [hash, cur] of state) {
      const hashS = String(hash);
      const buckets = c[hashS];
      if (!buckets) cur.absent.push(idx);
      if (skip && skip.has(hash) && skip.get(hash).has(idx)) continue;
      cur.n += ok;
      if (!buckets) continue;
      for (const [bS, k] of Object.entries(buckets)) {
        const bucket = Number(bS);
        const kk = Number(k);
        if (!Number.isFinite(bucket) || !Number.isFinite(kk)) continue;
        cur.counts.set(bucket, (cur.counts.get(bucket) || 0) + kk);
      }
    }
  });
  return { state, batches };
}

// Probabilité sous laquelle « 0 observation sur ok » est traité comme une panne d'exposition
// (l'expérience n'est servie dans aucune réponse du lot) et non comme un 0 % mesuré.
const outageP0 = () => { const v = Number(process.env.USER_ROLLOUT_OUTAGE_P0); return Number.isFinite(v) && process.env.USER_ROLLOUT_OUTAGE_P0 !== undefined && process.env.USER_ROLLOUT_OUTAGE_P0 !== '' ? v : 1e-3; };
// Une absence qui dure jusqu'au dernier lot sur au moins ce nombre de lots est un retrait réel.
const outageSustained = () => Number(process.env.USER_ROLLOUT_OUTAGE_SUSTAINED) || 4;

/**
 * Lots où un hash connu est absent de TOUTES les réponses alors que son taux estimé
 * rendrait ce résultat quasi impossible ((1-p)^ok < P0). Observé en production :
 * tida_webform disparaissait de lots entiers (150 réponses sur 150) alors que 100 % des
 * réponses anonymes la contiennent par ailleurs ; compter ces lots comme « 0 sur 150 »
 * faisait osciller l'estimation (93 → 98 %) et déclenchait des notifications en boucle.
 * Une absence qui se prolonge jusqu'à la fin de la fenêtre (retrait réel) n'est pas exclue.
 * @returns {Map<number, Set<number>>} hash → indices de lots à ne pas compter
 */
function detectOutages(win) {
  const P0 = outageP0();
  const SUSTAINED = outageSustained();
  let skip = new Map();
  for (let pass = 0; pass < 3; pass++) {
    const { state, batches } = windowAggregateCore(win, skip);
    const next = new Map();
    for (const [hash, cur] of state) {
      if (!cur.absent.length) continue;
      let k = 0;
      for (const v of cur.counts.values()) k += v;
      if (!(cur.n > 0) || k <= 0) continue;
      const p = Math.min(1, k / cur.n);
      // Absence continue jusqu'au dernier lot : retrait réel, on ne l'exclut pas.
      let tail = 0;
      for (let i = cur.absent.length - 1, want = batches.length - 1; i >= 0 && cur.absent[i] === want; i--, want--) tail++;
      const set = new Set();
      cur.absent.forEach((idx, pos) => {
        const inTail = pos >= cur.absent.length - tail;
        if (inTail && tail >= SUSTAINED) return;
        const ok = Math.max(0, Number((batches[idx] || {}).ok) || 0);
        if (ok > 0 && Math.pow(1 - p, ok) < P0) set.add(idx);
      });
      if (set.size) next.set(hash, set);
    }
    const same = next.size === skip.size && [...next].every(([h, s]) => skip.has(h) && skip.get(h).size === s.size);
    skip = next;
    if (same) break;
  }
  return skip;
}

function windowAggregate(win) {
  const skip = detectOutages(win);
  const { state } = windowAggregateCore(win, skip);
  const winCounts = new Map();
  const winN = new Map();
  for (const [hash, cur] of state) {
    winCounts.set(hash, cur.counts);
    winN.set(hash, cur.n);
  }
  return { winCounts, winN, outages: skip };
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
  return { batches, pos: win.pos || {}, samples: win.samples || [], since: win.since || {} };
}

// ─── Estimation (V14 : k/n + Wilson + bornes indicatives) ──────────────────

/**
 * Traitements d'une expérience depuis les comptes cumulés de la fenêtre.
 * mergedCounts : Map(bucket → k) ; n : total d'échantillons de la fenêtre ;
 * ringPos : { bucket: [position, ...] } positions récentes (anneau) ;
 * exact : résultat de exactForExperiment (V15) ou null.
 *
 * Si `exact.ok` : pct = couverture EXACTE des plages (V15).
 * Sinon pct = k/n (binomial, non biaisé) + IC de Wilson, et les positions
 * servent à une reconstruction INDICATIVE des plages.
 */
function buildWindowTreatments(mergedCounts, n, ringPos, exact) {
  const treatments = [];
  const useExact = !!(exact && exact.ok);
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
    const ex = useExact ? exact.pct[String(bucket)] : undefined;
    if (useExact && ex != null && Number.isFinite(ex)) {
      // V15 : plages EXACTES (bornes encadrées par points positifs ET négatifs).
      const u = Number(exact.uncertainty[String(bucket)]) || 0;
      treatments.push({
        bucket: Number(bucket),
        label: tLabel(bucket),
        percentage: ex,
        pct: ex,
        pctKnown: true,
        status: 'exact',
        confidence: exact.points >= 500 ? 'high' : 'medium',
        sampleCount: kk,
        samples: kk,
        coverage: Math.round((ex / 100) * 1000) / 1000,
        ci: { lo: Math.max(0, Math.round((ex - u) * 100) / 100), hi: Math.min(100, Math.round((ex + u) * 100) / 100), sigma: u },
        ranges: exact.ranges[String(bucket)] || [],
        binomialPct: pct,
        binomialCi: { lo: ci.lo, hi: ci.hi, sigma: ci.sigma },
        indicativePct: null,
        indicativeCi: null,
        observed,
        exactPoints: exact.points,
        sourceKind: 'exact_ranges',
      });
      continue;
    }
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
  else if (treatments.every((t) => t.status === 'exact')) globalStatus = 'exact';
  else if (treatments.some((t) => t.status === 'degraded')) globalStatus = 'degraded';
  const sigmaAll = treatments.length
    ? 100 * Math.sqrt(Math.max(0, sumPct / 100) * Math.max(0, 1 - sumPct / 100) / Math.max(n, 1))
    : Infinity;
  return { treatments, status: globalStatus, sumPct, sigma: Math.round(sigmaAll * 100) / 100 };
}

// ─── Sampling ─────────────────────────────────────────────────────────────────────────

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
 * Returns { byHash, byRev, ok, fail, samples } avec
 * byHash : hash → Map(bucket → positions[]) ; byRev : hash → revision ;
 * samples : échantillons individuels (V15, cf. sampleRecord).
 */
async function sampleFingerprints(n, concurrency) {
  const byHash = new Map();
  const byRev = new Map();
  const samples = [];
  const seenFp = new Set();
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
        const { assignments, fingerprint } = await fetchAssignments({
          'X-Request-Id': crypto.randomBytes(16).toString('hex'),
          'User-Agent': UAS[my % UAS.length],
        });
        // V14 : validation stricte + dédoublonnage (cf. recordAssignments).
        recordAssignments(byHash, byRev, assignments);
        // V15 : échantillon individuel (fingerprint + assignments) pour la
        // mesure exacte. Un fingerprint déjà vu n'est pas recompté.
        const rec = sampleRecord(fingerprint, assignments, Date.now());
        if (rec && !seenFp.has(rec.f)) {
          seenFp.add(rec.f);
          samples.push(rec);
        }
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
  return { byHash, byRev, ok, fail, samples };
}

/**
 * V15 — échantillon compact : { f: fingerprintId, t: ts, a: {hash: [bucket, pos]} }.
 * fingerprintId = partie avant le « . » du fingerprint Discord.
 */
function sampleRecord(fingerprint, assignments, ts) {
  const f = String(fingerprint || '').split('.')[0];
  if (!/^\d{5,25}$/.test(f) || !Array.isArray(assignments)) return null;
  const a = {};
  for (const x of assignments) {
    if (!Array.isArray(x) || x.length < 6) continue;
    const hash = Number(x[0]);
    const bucket = Number(x[2]);
    const pos = Number(x[5]);
    if (!Number.isFinite(hash) || !Number.isInteger(bucket) || bucket < -1) continue;
    if (!Number.isInteger(pos) || pos < 0 || pos >= SCALE) continue;
    if (a[String(hash)]) continue;
    a[String(hash)] = [bucket, pos];
  }
  return { f, t: ts, a };
}

/** Position d'un fingerprint dans une expérience user (déterministe). */
function userPosition(expId, fingerprintId) {
  return murmur3(String(expId) + ':' + String(fingerprintId)) % SCALE;
}

/**
 * V15 — mesure EXACTE d'une expérience NOMMÉE : chaque échantillon de la
 * fenêtre donne un point (position recalculée, label = bucket ou ABSENT).
 * Garde-fous : la position recalculée doit égaler hash_result renvoyé par
 * Discord pour TOUS les échantillons assignés ; sinon (formule différente,
 * expérience filtrée…) → null et repli sur k/n.
 */
function exactForExperiment(expId, hash, samples, since) {
  if (!expId || String(expId).startsWith('hash:')) return null;
  const key = String(hash);
  const minTs = Number(since) || 0;
  const pts = [];
  let assigned = 0;
  for (const s of samples || []) {
    if (!s || s.t < minTs) continue;
    const pos = userPosition(expId, s.f);
    const hit = s.a && s.a[key];
    if (hit) {
      if (Number(hit[1]) !== pos) return null; // formule de hash invalide
      assigned++;
      pts.push({ pos, label: Number(hit[0]) });
    } else {
      pts.push({ pos, label: ABSENT });
    }
  }
  if (assigned < 3) return null;
  const res = inferExactRanges(pts, SCALE);
  if (!res) return null;
  res.assigned = assigned;
  return res;
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
      const step = t.status === 'exact' ? 0.1 : t.confidence === 'low' ? 5 : 1;
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
          lines.push((d.status === 'exact' ? '  plages exactes : ' : '  bornes reconstruites (indicatif) : ') + d.ranges.map(([a, b]) => '[' + a + ', ' + b + ']').join(' + '));
        }
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
    { identity: 'userRollouts', label: 'user-rollouts', withDismiss: true },
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
    out.push('# Rollouts user — mesure propre (v15)', '');
    out.push('> Mis à jour automatiquement toutes les 20 min · Source : API Discord uniquement · Généré le ' + gen + ' UTC', '');
    out.push('**Fenêtre glissante 4 h — n = ' + n + ' échantillons — ' + (state.tokensConfigured || 0) + ' tokens actifs**', '');
    out.push('**Méthode V15 (expériences nommées)** : la position de chaque échantillon est recalculée (murmur3(`id:fingerprint`) % 10000) — y compris pour les échantillons HORS rollout — et vérifiée contre le `hash_result` renvoyé par Discord. Les points positifs et négatifs encadrent chaque borne → plages et % **exacts** (précision ≈ 10000/n). Repli automatique sur k/n si la vérification échoue ou si le rollout est filtré (plateforme, etc.).', '');
    out.push('**Méthode** : k/n (binomial, non biaisé) + intervalle de confiance de Wilson. Population mesurée : échantillons anonymes multi-contextes (web, desktop, Android, iOS) — pas un recensement des utilisateurs Discord.', '');
    out.push('Les plages « reconstruites » sont une seconde mesure INDICATIVE (ordre-statistiques, dépendante du modèle) : un heuristique de séparation peut fragmenter une plage uniforme → à lire comme un ordre de grandeur, pas une certitude.', '');
    out.push('## Expériences mesurées (' + exps.length + ')', '');
    out.push('| Expérience | % mesuré | IC 95 % | k/n | Confiance | Statut |');
    out.push('|---|---:|---|---:|---|---|');
    for (const e of exps) {
      const ts = e.treatments || [];
      const best = ts.reduce((a, t) => ((t.bucket || 0) > 0 && (a == null || (t.pct || 0) > a) ? t.pct : a), null);
      const bestT = ts.find((t) => t.pct === best) || ts[0] || {};
      const st = e.status === 'exact' ? 'Exact (plages)' : e.status === 'degraded' ? 'Mesuré (n faible)' : 'Mesuré';
      const ci = bestT.ci ? '[' + String(bestT.ci.lo).replace('.', ',') + ' – ' + String(bestT.ci.hi).replace('.', ',') + ']' : '—';
      out.push('| ' + (e.title || e.id || 'hash:' + e.hash) + ' | **' + (best == null ? '—' : fmt(best)) + '** | ' + ci + ' | ' + (bestT.sampleCount != null ? bestT.sampleCount + '/' + (e.windowN || '?') : (e.windowN || '?')) + ' | ' + conf(bestT.confidence) + ' | ' + st + ' |');
    }
    out.push('', '## Détail par variante');
    for (const e of exps) {
      out.push('', '### ' + (e.title || e.id || 'hash:' + e.hash));
      for (const t of e.treatments || []) {
        out.push('- ' + (t.label || 'Bucket ' + t.bucket) + ' : ' + fmt(t.pct) + ' (IC 95 % [' + String((t.ci || {}).lo ?? '?').replace('.', ',') + ' ; ' + String((t.ci || {}).hi ?? '?').replace('.', ',') + '], ' + (t.sampleCount != null ? t.sampleCount + '/' + e.windowN : 'n=' + e.windowN) + ', confiance ' + conf(t.confidence) + ')');
        if (t.status === 'exact' && t.ranges && t.ranges.length) {
          out.push('  - plages exactes : ' + t.ranges.map(([a, b]) => '[' + a + ', ' + b + ')').join(' + ') + ' → ' + fmt(t.pct) + ' (k/n : ' + fmt(t.binomialPct) + ')');
        } else if (t.ranges && t.ranges.length) {
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

// ─── Main ─────────────────────────────────────────────────────────────────────────────

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

  await fs.ensureDir(path.dirname(stateFile));
  console.log('📊 User rollouts v15 (MESURE PROPRE · sampling + fenêtre ' + WINDOW_H + ' h · plages exactes)');
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
  const isFirst = !(prev.experiments && prev.experiments.length);
  // Upgrade < v14 : passage au acknowledged (baseline de notification) —
  // re-seed silencieux, pas de flood de « rattrapage ».
  // V15 garde le schéma V14 (champs ajoutés seulement) → pas de re-seed.
  const isUpgrade = !isFirst && ![14, STATE_VERSION].includes(Number(prev.version));
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
    : { byHash: new Map(), byRev: new Map(), ok: 0, fail: 0, samples: [] };
  const { byHash, byRev, ok, fail } = sampled;
  const curSamples = Array.isArray(sampled.samples) ? sampled.samples : [];
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

  // V15 : échantillons individuels (dédoublonnés par fingerprint) + date de
  // départ par hash — un changement de revision ignore les échantillons
  // antérieurs pour la mesure exacte.
  const since = { ...(winOld.since || {}) };
  for (const [hash, rev] of byRev) {
    const old = (winOld.pos || {})[String(hash)];
    if (old && old.rev != null && rev != null && old.rev !== rev) since[String(hash)] = now - 1;
  }
  const seenF = new Set();
  const allSamples = [];
  for (const smp of [...curSamples.slice().reverse(), ...(winOld.samples || []).slice().reverse()]) {
    if (!smp || seenF.has(smp.f)) continue;
    seenF.add(smp.f);
    allSamples.push(smp);
  }
  allSamples.reverse();
  nextWindow.samples = allSamples.slice(-SAMPLE_CAP);
  for (const k of Object.keys(since)) if (!(k in mergedPos)) delete since[k];
  nextWindow.since = since;

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
    const exact = exactForExperiment(def.id, hash, nextWindow.samples, since[String(hash)]);
    const { treatments, status: rollStatus, sumPct } = buildWindowTreatments(
      m,
      n,
      mergedPos[String(hash)] || {},
      exact,
    );
    if (!treatments.length) continue;
    experiments.push({
      hash,
      id: def.id,
      title: def.title,
      type: 'user',
      quality: rollStatus === 'exact' ? 'exact' : rollStatus === 'estimated' ? 'estimated' : 'degraded',
      status: rollStatus,
      confidence: rollStatus === 'exact' ? 0.99 : rollStatus === 'estimated' ? 0.8 : 0.3,
      method: exact && exact.ok ? 'exact_ranges' : 'binomial',
      exactCheck: exact ? { ok: exact.ok, points: exact.points, runs: exact.runs, conflicts: exact.conflicts, isolated: exact.isolated } : null,
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
    'exact',
    experiments.filter((e) => e.status === 'exact').length,
    'degraded',
    experiments.filter((e) => e.status === 'degraded').length,
  );

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
              exact: t.status === 'exact',
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
        // V15 : mesure exacte → seuil = incertitude des bornes (≥ 0,1 pt),
        // plus besoin de la marge de bruit statistique ni de APEX_MIN_PCT_DELTA.
        const threshold = t.status === 'exact'
          ? Math.max(0.1, 2 * (Number(t.ci && t.ci.sigma) || 0))
          : Math.max(MIN_DELTA, margin);
        const { changeType, change } = classifyChange(from, to, threshold);
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
          exact: t.status === 'exact',
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
          exact: deltas.every((d) => d.exact),
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
      version: STATE_VERSION,
      schemaVersion: STATE_VERSION,
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
    console.log(isUpgrade ? 'Upgrade seed → v15 (acknowledged baseline)' : 'Seed', experiments.length, '· no notify');
    return;
  }

  await writeState(acknowledged);

  console.log('Changes', changes.length);
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

  await writeState(acknowledged, { changes: changes.slice(0, delivered) });

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
  detectOutages,
  buildNextWindow,
  fingerprintOf,
  classifyChange,
  ackSnapshot,
  recordAssignments,
  sampleRecord,
  userPosition,
  exactForExperiment,
};
