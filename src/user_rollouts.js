/**
 * User experiment rollouts v12 — EXACT percentages, runs rapides et stables.
 *
 * V12 (rapidité + stabilité) :
 *  - phases réseau en parallèle : defs + gist, puis token snapshot + sampling
 *  - sampling adaptatif : arrêt anticipé sur plateau de découverte + budget
 *    temps → le job tient largement dans la cadence 2 min (jamais de file)
 *  - fetchWithRetry (lib/http) sur defs + gist : backoff 429/5xx/réseau
 *  - URLs defs dédoublonnées (un seul fetch au lieu de deux identiques)
 *  - timeout d'un échantillon 25s → 15s (une requête qui traîne ne bloque
 *    plus un worker un quart de minute)
 *
 * Sources, par priorité :
 *  1. Gist communautaire des rollouts (agnonotdev) — expériences user avec
 *     ranges exactes par variante (échelle 0–10000, intervalles [start, end)).
 *     % exact = Σ(end − start) / 10000. Même technique que les trackers
 *     communautaires (Wumpus Central & co) : on lit les ranges, on ne devine pas.
 *  2. Worker API (experiments.dscrd.workers.dev) — définitions avec bucket
 *     ranges (exact aussi, souvent moins à jour que le gist).
 *  3. Fingerprint sampling — DÉTECTION UNIQUEMENT. Les % estimés sont
 *     désactivés par défaut : une expérience sans ranges s'affiche « 0% ».
 *     (USER_ROLLOUT_ALLOW_ESTIMATE=1 pour réactiver l'ancien comportement.)
 *
 * Key changes vs v10:
 *  - Source primaire : gist communautaire (ranges exactes des user rollouts)
 *  - % estimés par sampling désactivés par défaut → plus de faux pourcentages
 *  - Nouvelle expérience détectée sans ranges → notif honnête « 0% »
 *  - Bump état v11 : premier run après upgrade = seed silencieux (pas de flood
 *    de « corrections » lors du passage estimé → exact)
 *  - Webhook UNIQUE : la première var définie gagne (UR_WEBHOOK
 *    → APEX_WEBHOOK_URL → ROLLOUT_WEBHOOK_URL → DISCORD_WEBHOOK_URL)
 *
 * Env:
 *   DISCORD_USER_TOKEN(S) / DISCORD_USER_TOKEN_1..5
 *   UR_WEBHOOK | USER_ROLLOUT_WEBHOOK_URL | APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   USER_ROLLOUT_SAMPLES       default 80
 *   USER_ROLLOUT_CONCURRENCY   default 2
 *   USER_ROLLOUT_DELAY_MS      default 300
 *   APEX_MIN_PCT_DELTA         default 3
 *   USER_ROLLOUT_NOTIFY_HASH   default 0 (do not notify unknown hash names)
 *   USER_ROLLOUT_MIN_OK        default 25 (min successful samples before any %)
 *   USER_ROLLOUT_MAX_MS        default 90000 (budget temps du sampling)
 *   USER_ROLLOUT_PLATEAU       default 30 (échantillons consécutifs sans
 *                              nouvelle paire hash/bucket → arrêt anticipé)
 *   USER_ROLLOUT_COMMUNITY_URL default agnonotdev rollouts gist (raw)
 *   USER_ROLLOUT_ALLOW_ESTIMATE default 0 (never publish estimated %)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sendEmbeds } = require('./lib/webhook');
const { murmur3 } = require('./lib/murmur3');
const { writeJsonAtomic } = require('./lib/atomic');
const { sleep, redactSecrets, loadTokens, DEFAULT_UA, DEFAULT_BOT_NAME: BOT, DEFAULT_AVATAR_URL: AVATAR } = require('./lib/utils');
const { safeJson, fetchWithRetry } = require('./lib/http');
const {
  mergeIntervals,
  intervalsCoverage,
  coveragePercent,
  classifyChange,
  noiseMargin,
  stableChangeFingerprint,
  estimateFromPoints,
  parseRangeStrings,
  rangesPercentExclusive,
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
  // Nom court pour secret GitHub (limite UI) ; ancien nom garde en fallback
  ['UR_WEBHOOK', process.env.UR_WEBHOOK],
  ['USER_ROLLOUT_WEBHOOK_URL', process.env.USER_ROLLOUT_WEBHOOK_URL],
  ['APEX_WEBHOOK_URL', process.env.APEX_WEBHOOK_URL],
  ['ROLLOUT_WEBHOOK_URL', process.env.ROLLOUT_WEBHOOK_URL],
  ['DISCORD_WEBHOOK_URL', process.env.DISCORD_WEBHOOK_URL],
];
const firstWebhook = WEBHOOK_CANDIDATES.find(([, v]) => v && String(v).trim());
const WEBHOOK = firstWebhook ? String(firstWebhook[1]).trim() : null;
const WEBHOOK_SOURCE = firstWebhook ? firstWebhook[0] : null;
const SAMPLES = Math.max(20, Math.min(400, Number(process.env.USER_ROLLOUT_SAMPLES || 80)));
const CONC = Math.max(1, Math.min(4, Number(process.env.USER_ROLLOUT_CONCURRENCY || 2)));
const DELAY_MS = Math.max(80, Math.min(5000, Number(process.env.USER_ROLLOUT_DELAY_MS || 300)));
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 1);
const MIN_OK = Math.max(10, Number(process.env.USER_ROLLOUT_MIN_OK || 25));
// V12 rapidité : sampling adaptatif — budget temps max et sortie sur plateau
// de découverte (N échantillons consécutifs sans nouvelle paire hash/bucket).
const MAX_MS = Math.max(15000, Number(process.env.USER_ROLLOUT_MAX_MS || 90000));
const PLATEAU = Math.max(10, Number(process.env.USER_ROLLOUT_PLATEAU || 30));
const NOTIFY_HASH = String(process.env.USER_ROLLOUT_NOTIFY_HASH || '0') === '1';
const NOISE_Z = Math.max(0, Number(process.env.USER_ROLLOUT_NOISE_Z ?? 2));
const SCALE = DEFAULT_SCALE;
const DEFS_URL =
  process.env.APEX_DEFS_URL ||
  'https://experiments.dscrd.workers.dev/experiments';
const WORKERS_URL =
  process.env.APEX_API_URL || 'https://experiments.dscrd.workers.dev/experiments';
// Gist communautaire (agnonotdev) : rollouts des expériences Discord avec les
// ranges exactes par variante. Source primaire des % user.
const COMMUNITY_URL =
  process.env.USER_ROLLOUT_COMMUNITY_URL ||
  'https://gist.githubusercontent.com/agnonotdev/fb2b6a7ba1301733aa5c2050b3e59a18/raw/rollouts.json';
// v11 : par défaut on ne publie JAMAIS de % estimé (v10 publiait des faux %).
const ALLOW_ESTIMATE = String(process.env.USER_ROLLOUT_ALLOW_ESTIMATE || '0') === '1';

function tLabel(bucket) {
  const b = Number(bucket);
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Variant ' + b;
}

/**
 * Load experiment definitions from the worker API and local files.
 * Returns a Map of hash → {id, title, type, buckets, populations, rollout}.
 * The worker API returns full rollout definitions with bucket ranges.
 */
async function loadExperimentDefs() {
  const defs = new Map();

  // 1. Fetch from worker API (primary source — has bucket ranges)
  // V12 : URLs dédoublonnées (DEFS_URL et WORKERS_URL pointent par défaut
  // vers la même API — un seul fetch au lieu de deux) + retry robuste.
  for (const url of [...new Set([DEFS_URL, WORKERS_URL].filter(Boolean))]) {
    try {
      const res = await fetchWithRetry(url, {
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
        timeout: 20000,
        label: 'defs',
      });
      if (!res.ok) continue;
      const data = await safeJson(res);
      const list = Array.isArray(data) ? data : data.experiments || [];
      let n = 0;
      for (const e of list) {
        if (!e || (!e.id && !e.name)) continue;
        const id = String(e.id || e.name);
        const hash = e.hash != null ? Number(e.hash) : murmur3(id);
        const type = e.type || e.kind || 'user';
        const title = e.title || e.label || e.description || id;
        const buckets = e.buckets || [];
        const populations = (e.rollout && e.rollout.populations) || [];
        defs.set(hash, {
          id,
          hash,
          title,
          type,
          buckets,
          populations,
          rollout: e.rollout || null,
          source: 'worker_api',
        });
        n++;
      }
      console.log('Worker defs loaded:', n, 'from', url.split('/').slice(-2).join('/'));
      break; // Use first successful URL
    } catch (e) {
      console.warn('Worker defs fail:', e.message);
    }
  }

  // 2. Merge local experiment files (for additional IDs/names, but no ranges)
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
        buckets: [],
        populations: [],
        rollout: null,
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

  console.log('Total experiment defs:', defs.size, '(worker:', [...defs.values()].filter((d) => d.source === 'worker_api').length, 'local:', [...defs.values()].filter((d) => d.source === 'local').length, ')');
  return defs;
}

/**
 * Load the community user rollouts gist (agnonotdev) — the same technique used
 * by community trackers: read the exact per-variant rollout ranges instead of
 * estimating from samples. Ranges are half-open [start, end) on Discord's
 * 0–10000 hash space, so the exact % is Σ(end − start) / 10000.
 * Returns a Map of hash → { id, title, treatments, rolloutStatus, platforms, total }.
 */
async function loadCommunityUserRollouts() {
  const map = new Map();
  const urls = [...new Set([COMMUNITY_URL].filter(Boolean))];
  for (const url of urls) {
    try {
      const res = await fetchWithRetry(url, {
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
        timeout: 30000,
        label: 'community gist',
      });
      if (!res.ok) {
        console.warn('Community rollouts HTTP', res.status);
        continue;
      }
      const data = await safeJson(res);
      const list = Array.isArray(data) ? data : [];
      let n = 0;
      for (const e of list) {
        if (!e || e.kind !== 'user' || !e.id) continue;
        const hash = e.hash != null ? Number(e.hash) : murmur3(String(e.id));
        if (!Number.isFinite(hash)) continue;
        const treatments = [];
        let hasRanges = false;
        for (const v of Array.isArray(e.variants) ? e.variants : []) {
          const bucket = Number(v.variant);
          if (!Number.isFinite(bucket)) continue;
          const ranges = mergeIntervals(parseRangeStrings(v.ranges));
          if (!ranges.length) continue;
          hasRanges = true;
          const pct = rangesPercentExclusive(ranges);
          treatments.push({
            bucket,
            label: tLabel(bucket),
            percentage: pct,
            pct,
            pctKnown: true,
            status: 'exact',
            confidence: 'high',
            sampleCount: 0,
            samples: 0,
            coverage: pct / 100,
            intervals: ranges,
            ranges,
            observed: null,
            gapFill: 0,
            sourceKind: 'exact_from_community_ranges',
            reported: { from: v.from, to: v.to, change: v.change },
          });
        }
        if (!hasRanges) continue; // pas de ranges → pas de % (pas de faux %)
        treatments.sort((a, b) => a.bucket - b.bucket);
        map.set(hash, {
          hash,
          id: String(e.id),
          title: e.title || String(e.id),
          treatments,
          rolloutStatus: e.rollout_status || null,
          platforms: Array.isArray(e.platforms) ? e.platforms : [],
          total: e.total || null,
        });
        n++;
      }
      console.log('Community user rollouts loaded:', n, 'from', url.split('/').slice(-2).join('/'));
      break;
    } catch (e) {
      console.warn('Community rollouts fail:', e.message);
    }
  }
  return map;
}


/**
 * Human-readable label for a single population filter.
 */
function formatFilter(f) {
  if (!f || typeof f !== 'object') return null;
  const t = String(f.type || '').toLowerCase();
  if (t === 'feature') {
    const feats = f.features || f.feature || [];
    const list = Array.isArray(feats) ? feats : [feats];
    return 'feature:' + list.slice(0, 3).join(',');
  }
  if (t === 'member_count') {
    const r = f.range || {};
    return 'members:' + (r.start != null ? r.start : '?') + '-' + (r.end != null ? r.end : '?');
  }
  if (t === 'range_by_hash') return 'hash_range:' + (f.range != null ? f.range : '?');
  if (t === 'id') {
    const ids = f.ids || [];
    return 'ids:' + (Array.isArray(ids) ? ids.length : 0);
  }
  if (t === 'hub_type') return 'hub_type';
  if (t === 'country_code' || t === 'country') {
    const codes = f.country_codes || f.countries || f.values || [];
    const list = Array.isArray(codes) ? codes : [codes];
    return 'country:' + list.slice(0, 6).join(',');
  }
  if (t === 'user_flag') return 'user_flag';
  if (t === 'experiment_enabled') return 'exp_enabled:' + (f.id || '');
  if (t === 'client_version' || t === 'min_build' || t === 'build_number') {
    return 'client:' + JSON.stringify(f.range || f.min || f.max || f).slice(0, 40);
  }
  if (t === 'os' || t === 'platform') {
    return t + ':' + String(f.value || f.os || f.platform || '').slice(0, 20);
  }
  return t || 'filter';
}

function summarizeFilters(filters) {
  if (!filters || !filters.length) return 'global';
  return filters.map(formatFilter).filter(Boolean).slice(0, 4).join(' · ') || 'filtered';
}

function accumulateBucketRanges(result, positions) {
  for (const pos of positions || []) {
    const bucket = Number(pos.bucket);
    if (!Number.isFinite(bucket)) continue;
    const rollouts = pos.rollouts || [];
    const ranges = rollouts
      .map((r) => [Number(r.start), Number(r.end)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (!ranges.length) continue;
    const merged = mergeIntervals(ranges);
    const covered = intervalsCoverage(merged, SCALE);
    const pct = coveragePercent(merged, SCALE);
    if (!result.has(bucket)) {
      result.set(bucket, { percentage: pct, ranges: merged, coverage: covered, sampleCount: 0 });
    } else {
      const existing = result.get(bucket);
      const allRanges = [...(existing.ranges || []), ...merged];
      const mergedAll = mergeIntervals(allRanges);
      existing.ranges = mergedAll;
      existing.coverage = intervalsCoverage(mergedAll, SCALE);
      existing.percentage = coveragePercent(mergedAll, SCALE);
    }
  }
}

/**
 * Prefer global populations for main %; keep filtered segments for display.
 */
function calculateBucketPercentages(def) {
  const empty = { buckets: new Map(), segments: [], hasFilters: false, filterSummary: 'global', usedFallbackFiltered: false };
  if (!def || !def.populations || !def.populations.length) return empty;
  const globalPops = [];
  const filteredPops = [];
  for (const pop of def.populations) {
    if (!pop.filters || pop.filters.length === 0) globalPops.push(pop);
    else filteredPops.push(pop);
  }
  const buckets = new Map();
  let usedFallbackFiltered = false;
  if (globalPops.length) {
    for (const pop of globalPops) accumulateBucketRanges(buckets, pop.position);
  } else if (filteredPops.length) {
    usedFallbackFiltered = true;
    for (const pop of filteredPops) accumulateBucketRanges(buckets, pop.position);
  }
  const segments = [];
  for (const pop of filteredPops) {
    const segBuckets = new Map();
    accumulateBucketRanges(segBuckets, pop.position);
    if (!segBuckets.size) continue;
    const treatments = [...segBuckets.entries()]
      .map(([bucket, info]) => ({ bucket: Number(bucket), label: tLabel(bucket), percentage: info.percentage, pct: info.percentage, ranges: info.ranges }))
      .sort((a, b) => a.bucket - b.bucket);
    segments.push({ filters: pop.filters, filterLabel: summarizeFilters(pop.filters), treatments });
  }
  const filterLabels = segments.map((s) => s.filterLabel);
  const hasFilters = segments.length > 0;
  let filterSummary = 'global';
  if (usedFallbackFiltered) filterSummary = 'filtered-only · ' + (filterLabels[0] || 'filtered');
  else if (hasFilters) filterSummary = 'global + ' + filterLabels.slice(0, 2).join(' | ');
  return { buckets, segments, hasFilters, filterSummary, usedFallbackFiltered };
}

function buildTreatments(def, bucketMap, totalOk) {
  const calc = calculateBucketPercentages(def);
  const exactPcts = calc.buckets || new Map();
  const treatments = [];
  let coveredAll = 0;

  if (exactPcts.size > 0) {
    // Use exact percentages from bucket ranges
    for (const [bucket, info] of exactPcts) {
      coveredAll += info.coverage || 0;
      treatments.push({
        bucket: Number(bucket),
        label: tLabel(bucket),
        percentage: info.percentage,
        pct: info.percentage,
        pctKnown: info.percentage != null,
        status: 'exact',
        confidence: 'high',
        sampleCount: bucketMap.get(bucket)?.length || 0,
        samples: bucketMap.get(bucket)?.length || 0,
        coverage: info.coverage / SCALE,
        intervals: info.ranges,
        ranges: info.ranges,
        observed: null,
        gapFill: 0,
        sourceKind: 'exact_from_bucket_ranges',
        scope: calc.usedFallbackFiltered ? 'filtered' : 'global',
      });
    }
  } else if (totalOk >= MIN_OK) {
    // Fallback: estimate from hash_result spread (less reliable)
    for (const [bucket, hrs] of bucketMap) {
      if (!hrs || !hrs.length) continue;
      const est = estimateFromPoints(hrs, totalOk, SCALE);
      coveredAll += Math.round((est.coverage || 0) * SCALE);
      treatments.push({
        bucket: Number(bucket),
        label: tLabel(bucket),
        percentage: est.percentage,
        pct: est.percentage,
        pctKnown: est.percentage != null && est.status !== 'insufficient_data',
        status: est.status,
        confidence: est.confidence,
        sampleCount: est.sampleCount,
        samples: est.sampleCount,
        coverage: est.coverage,
        intervals: est.ranges,
        ranges: est.ranges,
        observed: est.observed,
        gapFill: est.gapFill,
        sourceKind: 'estimated_from_samples',
      });
    }
  }

  treatments.sort((a, b) => a.bucket - b.bucket);
  const sumPct = treatments.reduce(
    (s, t) => s + (t.pctKnown && t.pct != null ? t.pct : 0),
    0,
  );

  let globalStatus = 'exact';
  if (treatments.length === 0) globalStatus = 'insufficient_data';
  else if (treatments.some((t) => t.status === 'degraded' || t.status === 'unknown')) {
    globalStatus = 'degraded';
  } else if (treatments.some((t) => t.status === 'estimated')) {
    globalStatus = 'estimated';
  }

  const conf = totalOk > 0
    ? Math.min(1, treatments.reduce((s, t) => s + t.sampleCount, 0) / (totalOk * Math.max(1, treatments.length)))
    : 1;

  return {
    treatments,
    conf,
    status: globalStatus,
    coverage: Math.round((Math.min(coveredAll, SCALE) / SCALE) * 1000) / 1000,
    sumPct: Math.round(sumPct * 100) / 100,
    segments: calc.segments || [],
    hasFilters: !!calc.hasFilters,
    filterSummary: calc.filterSummary || 'global',
    usedFallbackFiltered: !!calc.usedFallbackFiltered,
  };
}

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

  /**
 * Check if we should wait before making a request.
 * Returns the number of ms to wait, or 0.
 */
  waitMs() {
    const now = Date.now();
    if (now < this.globalBlockUntil) {
      return this.globalBlockUntil - now;
    }
    return 0;
  },

  /**
   * Update rate limit state from response headers.
   */
  update(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    const resetAfter = headers.get('x-ratelimit-reset-after');
    if (remaining != null) this.remaining = Number(remaining);
    if (resetAfter != null) this.resetAfter = Number(resetAfter);

    // Dynamically adjust delay: if remaining is low, increase delay
    if (this.remaining <= 1 && this.resetAfter > 0) {
      this.dynamicDelayMs = Math.min(3000, DELAY_MS + 200);
    } else if (this.remaining >= 3) {
      this.dynamicDelayMs = Math.max(DELAY_MS, this.dynamicDelayMs - 50);
    }
  },

  /**
   * Handle a 429 response — block all workers.
   */
  block429(retryAfter) {
    this.consecutive429++;
    const wait = Math.min(30, Math.max(1, Number(retryAfter) || 2)) * 1000;
    this.globalBlockUntil = Date.now() + wait;
    // Increase dynamic delay after 429
    this.dynamicDelayMs = Math.min(5000, this.dynamicDelayMs + 500);
    console.warn('429 → global block', Math.round(wait / 1000) + 's · dynamic delay now', this.dynamicDelayMs + 'ms');
    return wait;
  },

  /**
   * Reset consecutive 429 counter on success.
   */
  success() {
    if (this.consecutive429 > 0) {
      // Gradually reduce dynamic delay on success
      this.dynamicDelayMs = Math.max(DELAY_MS, this.dynamicDelayMs - 100);
      this.consecutive429 = 0;
    }
  },
};

async function fetchAssignments(extraHeaders = {}, withGuild = false, attempt = 0) {
  // Wait if globally rate limited
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
    timeout: 15000, // V12 : 15s au lieu de 25s — une requête lente ne bloque pas un worker
  });

  // Update rate limit state from headers
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
 * Sample fingerprints to detect which experiments are active.
 * Returns a map of hash → bucket → hash_result[] (for detection + fallback estimation).
 */
async function sampleFingerprints(n, concurrency) {
  const byHash = new Map();
  let ok = 0;
  let fail = 0;
  let next = 0;
  // V12 rapidité : budget temps + sortie sur plateau de découverte.
  // La détection n'a pas besoin d'un N fixe : dès que PLATEAU échantillons
  // consécutifs ne découvrent plus aucune nouvelle paire (hash, bucket),
  // l'ensemble détecté est stable → arrêt anticipé (typiquement ~35 requêtes
  // au lieu de 100). MAX_MS garantit un run rapide quoi qu'il arrive.
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
        // Use dynamic delay from rate limiter + jitter
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
          // Already handled by rate limiter, just wait
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
  for (const token of TOKENS.slice(0, 5)) {
    try {
      // Use with_guild_experiments=true to get guild experiment definitions too
      const data = await fetchAssignments({ Authorization: token }, true);
      // Parse user assignments
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

// ─── Embeds — format sobre, sans emojis ──────────────────────────────────────

function fmtPct(pct) {
  const v = Number(pct);
  if (pct == null || !Number.isFinite(v)) return '0'; // % inconnu (pas de ranges) = 0% déployé
  return String(Math.round(v * 10) / 10);
}

/** Label de variante au format communautaire : None / Variant N. */
function variantLabel(bucket) {
  return Number(bucket) === -1 ? 'None' : 'Variant ' + bucket;
}

/**
 * Format des messages (style communautaire, sans emojis) :
 *   2026-10-gdm-duration-timer (user)
 *   Platform must be one of these: android, desktop, web, iOS
 *   Variant 0 0% -> 3.5%
 *   Variant 1 0% -> 8.5%
 *   -# Rollouts Changes
 */
function buildEmbeds(changes) {
  const embeds = [];
  for (const c of changes.slice(0, 10)) {
    const title = (String(c.id || c.title) + ' (user)').slice(0, 256);
    const lines = [];

    // Ligne description / nom si différent de l'id
    if (c.title && c.title !== c.id) lines.push(String(c.title).slice(0, 300));

    if (c.kind === 'new') {
      for (const t of (c.treatments || []).slice(0, 12)) {
        lines.push(variantLabel(t.bucket) + ' ' + (t.pctKnown && t.pct != null ? fmtPct(t.pct) + '%' : '0%'));
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
      footer: { text: c.kind === 'revision' ? 'Rollouts Revision' : 'Rollouts Changes' },
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

async function main() {
  await fs.ensureDir(DATA);
  console.log('📊 User rollouts v11 (EXACT community ranges · no fake %)');
  console.log('Samples:', SAMPLES, 'concurrency:', CONC, 'tokens:', TOKENS.length);
  console.log('Webhook:', WEBHOOK ? 'set (' + WEBHOOK_SOURCE + ')' : 'MISSING');
  console.log('Notify unresolved hash:', NOTIFY_HASH ? 'yes' : 'no');
  console.log('Estimated % (sampling):', ALLOW_ESTIMATE ? 'ENABLED (legacy)' : 'disabled — exact only');

  // V12 rapidité : phases indépendantes en parallèle.
  //  1) defs (worker API) + gist communautaire : sources disjointes.
  //  2) token snapshot (auth) + sampling (unauth) : ils partagent le rate
  //     limiter, donc la pression réseau reste maîtrisée.
  const [defsR, communityR] = await Promise.allSettled([
    loadExperimentDefs(),
    loadCommunityUserRollouts(),
  ]);
  const defs = defsR.status === 'fulfilled' ? defsR.value : new Map();
  const community = communityR.status === 'fulfilled' ? communityR.value : new Map();
  if (defsR.status === 'rejected')
    console.warn('defs indisponibles:', String((defsR.reason && defsR.reason.message) || defsR.reason));
  if (communityR.status === 'rejected')
    console.warn('community gist indisponible:', String((communityR.reason && communityR.reason.message) || communityR.reason));

  const [tokenSnapR, sampledR] = await Promise.allSettled([
    fetchTokenSnapshot(defs),
    sampleFingerprints(SAMPLES, CONC),
  ]);
  const tokenSnap = tokenSnapR.status === 'fulfilled' ? tokenSnapR.value : [];
  const sampled = sampledR.status === 'fulfilled' ? sampledR.value : { byHash: new Map(), ok: 0, fail: 0 };
  const { byHash, ok, fail } = sampled;
  console.log('Token snapshot:', tokenSnap.length, 'experiments');

  if (ok < MIN_OK) {
    console.warn('Too few ok samples', ok, '<', MIN_OK, '— skip estimates (avoid noise)');
  }

  // Build a set of hashes detected via sampling or token snapshot
  const detectedHashes = new Set();
  for (const hash of byHash.keys()) detectedHashes.add(hash);
  for (const t of tokenSnap) detectedHashes.add(t.hash);

  const experiments = [];
  const processedHashes = new Set();

  // 0. Process community rollout entries FIRST — freshest EXACT ranges.
  for (const [hash, c] of community) {
    if (processedHashes.has(hash)) continue;
    const coveredAll = c.treatments.reduce((s, t) => s + (t.coverage || 0), 0);
    processedHashes.add(hash);
    experiments.push({
      hash,
      id: c.id,
      title: c.title,
      type: 'user',
      quality: 'exact',
      status: 'exact',
      confidence: 1,
      coverage: Math.round(Math.min(coveredAll, 1) * 1000) / 1000,
      sumPct: Math.round(c.treatments.reduce((s, t) => s + (t.pctKnown ? t.pct : 0), 0) * 100) / 100,
      treatments: c.treatments,
      fingerprint: fingerprintOf(c.treatments),
      source: 'community_ranges',
      named: hasName(c.id),
      segments: [],
      hasFilters: false,
      filterSummary: 'global',
      usedFallbackFiltered: false,
      platforms: c.platforms,
      rolloutStatus: c.rolloutStatus,
      communityTotal: c.total,
    });
  }
  console.log('Community experiments with rollout:', experiments.filter((e) => e.source === 'community_ranges').length);

  // 1. Process ALL worker API definitions that have an active rollout
  //    (non-None bucket with non-zero range) — these give EXACT percentages
  for (const [hash, def] of defs) {
    if (def.source !== 'worker_api' || !def.populations || !def.populations.length) continue;
    if (processedHashes.has(hash)) continue;

    const calc = calculateBucketPercentages(def);
    const exactPcts = calc.buckets || new Map();
    if (!exactPcts.size) continue;

    // Check if this experiment has an active rollout (any non-None bucket with non-zero range)
    let hasActiveRollout = false;
    for (const [bucket, info] of exactPcts) {
      if (bucket >= 0 && info.percentage > 0) {
        hasActiveRollout = true;
        break;
      }
    }
    if (!hasActiveRollout) continue;

    // Build treatments from exact bucket ranges
    const treatments = [];
    let coveredAll = 0;
    for (const [bucket, info] of exactPcts) {
      coveredAll += info.coverage || 0;
      // Merge with fingerprint sample counts if available
      const sampleCount = byHash.get(hash)?.get(bucket)?.length || 0;
      treatments.push({
        bucket: Number(bucket),
        label: tLabel(bucket),
        percentage: info.percentage,
        pct: info.percentage,
        pctKnown: info.percentage != null,
        status: 'exact',
        confidence: 'high',
        sampleCount,
        samples: sampleCount,
        coverage: info.coverage / SCALE,
        intervals: info.ranges,
        ranges: info.ranges,
        observed: null,
        gapFill: 0,
        sourceKind: 'exact_from_bucket_ranges',
      });
    }
    treatments.sort((a, b) => a.bucket - b.bucket);
    if (!treatments.length) continue;

    processedHashes.add(hash);
    experiments.push({
      hash,
      id: def.id,
      title: def.title,
      type: 'user',
      quality: 'exact',
      status: 'exact',
      confidence: 1,
      coverage: Math.round((Math.min(coveredAll, SCALE) / SCALE) * 1000) / 1000,
      sumPct: Math.round(treatments.reduce((s, t) => s + (t.pctKnown ? t.pct : 0), 0) * 100) / 100,
      treatments,
      fingerprint: fingerprintOf(treatments),
      source: 'worker_api',
      named: hasName(def.id),
      segments: calc.segments || [],
      hasFilters: !!calc.hasFilters,
      filterSummary: calc.filterSummary || 'global',
      usedFallbackFiltered: !!calc.usedFallbackFiltered,
    });
  }
  console.log('Worker API experiments with active rollout:', experiments.length);

  // 2. Experiments detected via fingerprint sampling but with NO exact ranges.
  //    v11: estimation DISABLED by default — report an honest "detected 0%"
  //    entry instead of publishing fake percentages.
  for (const [hash, bucketMap] of byHash) {
    if (processedHashes.has(hash)) continue;
    if (ok < MIN_OK) continue;
    const def = defs.get(hash) || {
      id: 'hash:' + hash,
      hash,
      title: 'hash:' + hash,
      type: 'user',
      populations: [],
      source: 'unknown',
    };

    if (!ALLOW_ESTIMATE) {
      // Detection only: list observed buckets with UNKNOWN percentages.
      const treatments = [...bucketMap.keys()]
        .map((bucket) => {
          const n = bucketMap.get(bucket)?.length || 0;
          return {
            bucket: Number(bucket),
            label: tLabel(bucket),
            percentage: null,
            pct: null,
            pctKnown: false,
            status: 'detected',
            confidence: 'none',
            sampleCount: n,
            samples: n,
            coverage: 0,
            intervals: [],
            ranges: [],
            observed: null,
            gapFill: 0,
            sourceKind: 'detected_by_sampling',
          };
        })
        .filter((t) => Number.isFinite(t.bucket))
        .sort((a, b) => a.bucket - b.bucket);
      if (!treatments.length) continue;
      processedHashes.add(hash);
      experiments.push({
        hash,
        id: def.id,
        title: def.title,
        type: 'user',
        quality: 'detected',
        status: 'detected',
        confidence: 0,
        coverage: 0,
        sumPct: 0,
        treatments,
        fingerprint: fingerprintOf(treatments),
        source: 'fingerprint-sample',
        named: hasName(def.id),
      });
      continue;
    }

    // Legacy behavior (opt-in via USER_ROLLOUT_ALLOW_ESTIMATE=1):
    // estimate % from hash_result spread.
    const { treatments, conf, status: rollStatus, coverage: rollCov, sumPct } =
      buildTreatments(def, bucketMap, ok);
    if (!treatments.length) continue;
    const nObs = treatments.reduce((s, t) => s + (t.sampleCount || t.samples || 0), 0);
    if (nObs < 3 && rollStatus !== 'exact') continue;
    processedHashes.add(hash);
    const quality =
      rollStatus === 'exact'
        ? 'exact'
        : rollStatus === 'estimated'
          ? 'estimated'
          : rollStatus === 'degraded'
            ? 'degraded'
            : 'insufficient_data';
    experiments.push({
      hash,
      id: def.id,
      title: def.title,
      type: 'user',
      quality,
      status: rollStatus,
      confidence: Math.round(conf * 1000) / 1000,
      coverage: rollCov,
      sumPct,
      treatments,
      fingerprint: fingerprintOf(treatments),
      source: def.source === 'worker_api' ? 'worker_api+sample' : 'fingerprint-sample',
      named: hasName(def.id),
    });
  }

  console.log(
    'Experiments:',
    experiments.length,
    'named',
    experiments.filter((e) => e.named).length,
    'exact',
    experiments.filter((e) => e.status === 'exact').length,
    'estimated',
    experiments.filter((e) => e.status !== 'exact').length,
  );

  let prev = { experiments: [], token: [], announced: {} };
  if (await fs.pathExists(STATE)) {
    try {
      prev = await fs.readJson(STATE);
    } catch (_) {}
  }
  const announced = prev.announced && typeof prev.announced === 'object' ? { ...prev.announced } : {};
  const isFirst = !(prev.experiments && prev.experiments.length);
  // Upgrade v10 → v11 : les % exacts remplacent les anciens % estimés — on
  // re-seed silencieusement pour éviter un flood de « corrections ».
  const isUpgrade = !isFirst && Number(prev.version) !== 11 && Number(prev.schemaVersion) !== 11;

  const changes = [];
  if (!isFirst) {
    const pMap = new Map((prev.experiments || []).map((e) => [String(e.hash || e.id), e]));
    for (const n of experiments) {
      if (!n.named && !NOTIFY_HASH) continue;

      const key = String(n.hash);
      const fp = n.fingerprint;
      if (announced[key] === fp) continue;

      const p = pMap.get(key) || pMap.get(n.id);
      if (!p) {
        if (n.status === 'insufficient_data' || n.status === 'unknown') continue;
        changes.push({ kind: 'new', ...n });
        continue;
      }
      if (p.fingerprint === n.fingerprint) continue;
      const deltas = [];
      const pt = new Map((p.treatments || []).map((t) => [t.bucket, t]));
      if (n.status === 'degraded' || n.status === 'insufficient_data' || n.status === 'unknown') {
        continue;
      }
      if (p.status === 'degraded' || p.status === 'insufficient_data') {
        continue;
      }
      const isExact = n.status === 'exact';
      for (const t of n.treatments || []) {
        if (!t.pctKnown || t.pct == null) continue;
        if (t.status === 'degraded' || t.status === 'insufficient_data') continue;
        const oldT = pt.get(t.bucket);
        if (!oldT || !oldT.pctKnown || oldT.pct == null) {
          // Nouvelle variante dans le rollout, ou % qui devient connu :
          // signaler l'apparition (from = null → affiché « 0% -> X% »).
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
              exact: isExact,
              population: 'user',
              treatment: t.label,
            });
          }
          continue;
        }
        const from = Number(oldT.pct);
        const to = Number(t.pct);
        // For exact percentages: no noise margin needed (exact values)
        // For estimated: use noise margin
        const margin = isExact ? 0 : noiseMargin(Math.max(from, to), Math.min(Number(t.sampleCount || 0), Number(oldT.sampleCount || 0)) || Number(t.sampleCount || 0), NOISE_Z);
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
          exact: isExact,
          population: 'user',
          treatment: t.label,
        });
      }
      if (deltas.length) {
        const fp = stableChangeFingerprint({
          id: n.id,
          deltas: deltas.map((d) => [d.bucket, d.from, d.to, d.changeType]),
        });
        changes.push({
          kind: 'pct',
          id: n.id,
          title: n.title,
          deltas,
          named: n.named,
          changeFingerprint: fp,
          exact: isExact,
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
    await writeJsonAtomic(
      STATE,
      {
        scrapedAt: new Date().toISOString(),
        version: 11,
        schemaVersion: 11,
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
      },
      2,
    );
  }

  // First run OR upgrade v10 → v11: seed experiments + announced fingerprints
  // WITHOUT webhooks (no flood, no one-time wave of "corrected" percentages).
  if (isFirst || isUpgrade) {
    const seedAnnounced = { ...announced };
    for (const e of experiments) {
      if (e.named || NOTIFY_HASH) seedAnnounced[String(e.hash)] = e.fingerprint;
    }
    await writeState(seedAnnounced);
    console.log(isUpgrade ? 'Upgrade seed v10 → v11 (exact %)' : 'Seed', experiments.length, '· no notify');
    return;
  }

  // Persist current estimates for next-run deltas, but keep PREV announced.
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
    console.warn(
      'NOTIFY_FAIL user_rollouts — announced NOT advanced; will retry next run',
    );
    process.exitCode = 2;
    return;
  }

  // Success only: lock fingerprints for notified changes
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

module.exports = { main, murmur3, loadExperimentDefs, loadCommunityUserRollouts, calculateBucketPercentages, buildTreatments, classifyChange, mergeIntervals };

