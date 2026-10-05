/**
 * User experiment rollouts v9 — EXACT percentages from bucket ranges.
 *
 * Key changes vs v8:
 *  - Fetches experiment definitions from experiments.dscrd.workers.dev
 *    which returns rollout populations with bucket ranges (start/end)
 *  - Calculates EXACT percentages from bucket ranges instead of
 *    estimating from hash_result spread (which was unreliable)
 *  - Fingerprint sampling still used to detect active experiments
 *  - Falls back to estimation only if no bucket ranges are available
 *  - More recent experiment definitions (fresh from the worker API)
 *
 * Env:
 *   DISCORD_USER_TOKEN(S) / DISCORD_USER_TOKEN_1..5
 *   APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   USER_ROLLOUT_SAMPLES       default 80
 *   USER_ROLLOUT_CONCURRENCY   default 2
 *   USER_ROLLOUT_DELAY_MS      default 300
 *   APEX_MIN_PCT_DELTA         default 3
 *   USER_ROLLOUT_NOTIFY_HASH   default 0 (do not notify unknown hash names)
 *   USER_ROLLOUT_MIN_OK        default 25 (min successful samples before any %)
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
  intervalsCoverage,
  coveragePercent,
  classifyChange,
  noiseMargin,
  stableChangeFingerprint,
  estimateFromPoints,
  DEFAULT_SCALE,
} = require('./lib/rollout_math');

const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'user_rollouts.json');
const KNOWN = path.join(DATA, 'known_experiment_ids.json');
const EXPS = path.join(DATA, 'experiments.json');
const BASELINE = path.join(DATA, 'baseline_experiments.json');
const APEX_EXP = path.join(DATA, 'apex_experiments.json');

const TOKENS = loadTokens();
const WEBHOOK =
  process.env.APEX_WEBHOOK_URL ||
  process.env.ROLLOUT_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;
const SAMPLES = Math.max(20, Math.min(400, Number(process.env.USER_ROLLOUT_SAMPLES || 80)));
const CONC = Math.max(1, Math.min(4, Number(process.env.USER_ROLLOUT_CONCURRENCY || 2)));
const DELAY_MS = Math.max(80, Math.min(5000, Number(process.env.USER_ROLLOUT_DELAY_MS || 300)));
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 1);
const MIN_OK = Math.max(10, Number(process.env.USER_ROLLOUT_MIN_OK || 25));
const NOTIFY_HASH = String(process.env.USER_ROLLOUT_NOTIFY_HASH || '0') === '1';
const NOISE_Z = Math.max(0, Number(process.env.USER_ROLLOUT_NOISE_Z ?? 2));
const SCALE = DEFAULT_SCALE;
const DEFS_URL =
  process.env.APEX_DEFS_URL ||
  'https://experiments.dscrd.workers.dev/experiments';
const WORKERS_URL =
  process.env.APEX_API_URL || 'https://experiments.dscrd.workers.dev/experiments';

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
  for (const url of [DEFS_URL, WORKERS_URL]) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
        timeout: 20000,
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
 * Calculate exact bucket percentages from rollout populations.
 * Returns a Map of bucket → { percentage, ranges, coverage }.
 *
 * For each bucket, sums up the range sizes (end - start) from all
 * populations with no filters (or empty filters = applies to everyone).
 */
function calculateBucketPercentages(def) {
  const result = new Map();
  if (!def || !def.populations || !def.populations.length) return result;

  // Use populations with no filters (applies to everyone)
  const globalPops = def.populations.filter(
    (p) => !p.filters || p.filters.length === 0,
  );
  const pops = globalPops.length ? globalPops : def.populations;

  for (const pop of pops) {
    const positions = pop.position || [];
    for (const pos of positions) {
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
        result.set(bucket, {
          percentage: pct,
          ranges: merged,
          coverage: covered,
          sampleCount: 0,
        });
      } else {
        // Merge with existing ranges
        const existing = result.get(bucket);
        const allRanges = [...(existing.ranges || []), ...merged];
        const mergedAll = mergeIntervals(allRanges);
        existing.ranges = mergedAll;
        existing.coverage = intervalsCoverage(mergedAll, SCALE);
        existing.percentage = coveragePercent(mergedAll, SCALE);
      }
    }
  }

  return result;
}

/**
 * Build treatments for an experiment using exact bucket ranges.
 * Falls back to estimation from hash_result spread if no ranges available.
 */
function buildTreatments(def, bucketMap, totalOk) {
  const exactPcts = calculateBucketPercentages(def);
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
    timeout: 25000,
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

  async function worker() {
    while (true) {
      const my = next++;
      if (my >= n) break;
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
        for (const a of assignments) {
          if (!Array.isArray(a) || a.length < 6) continue;
          const hash = Number(a[0]);
          const bucket = Number(a[2]);
          const hr = Number(a[5]);
          if (!Number.isFinite(hash) || !Number.isFinite(hr)) continue;
          if (!byHash.has(hash)) byHash.set(hash, new Map());
          const bm = byHash.get(hash);
          if (!bm.has(bucket)) bm.set(bucket, []);
          bm.get(bucket).push(hr);
        }
        ok++;
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
  console.log('Samples ok', ok, 'fail', fail, 'hashes', byHash.size, '429s', rateLimit.consecutive429);
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

function buildEmbeds(changes) {
  const embeds = [];
  for (const c of changes.slice(0, 10)) {
    if (c.kind === 'new') {
      const lines = (c.treatments || []).slice(0, 10).map((t) => {
        const pct = t.pctKnown && t.pct != null ? '`' + t.pct + '%`' : '`?%`';
        const st = t.status === 'exact' ? ' · **exact**' : t.status && t.status !== 'estimated' ? ' · `' + t.status + '`' : ' · `est.`';
        const n = t.sampleCount || t.samples || 0;
        const band = n > 0 ? ' · n=' + n : '';
        return '• **' + t.label + '** · ' + pct + st + band;
      });
      embeds.push({
        title: '+ ' + c.id,
        description: [
          '**' + c.title + '**',
          'Type · `user` · ' + (c.status === 'exact' ? '**EXACT** (bucket ranges)' : '**ESTIMATED** (sampling)'),
          '',
          lines.join('\n') || '_no treatments_',
        ].join('\n').slice(0, 4000),
        color: 0x57f287,
        footer: { text: c.status === 'exact' ? 'exact % from bucket ranges' : 'user sampling · not exact Discord %' },
      });
    } else if (c.kind === 'pct') {
      const lines = (c.deltas || []).slice(0, 12).map((d) => {
        return '• **' + d.label + '** · `' + d.from + '%` → `' + d.to + '%`' + (d.exact ? ' (exact)' : ' (est.)');
      });
      embeds.push({
        title: '~ ' + c.id,
        description: [
          '**' + c.title + '**',
          'Type · `user`',
          '',
          lines.join('\n'),
        ].join('\n').slice(0, 4000),
        color: 0xe67e22,
        footer: { text: c.exact ? 'exact % from bucket ranges' : 'user sampling · noise possible' },
      });
    } else if (c.kind === 'revision') {
      embeds.push({
        title: '~ ' + c.id + ' revision',
        description:
          '**' + c.title + '**\nRevision `' + c.fromRev + '` → `' + c.toRev + '` · bucket `' + c.bucket + '`',
        color: 0x5865f2,
        footer: { text: 'assignment revision' },
      });
    }
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
  console.log('📊 User rollouts v9 (EXACT from bucket ranges)');
  console.log('Samples:', SAMPLES, 'concurrency:', CONC, 'tokens:', TOKENS.length);
  console.log('Webhook:', WEBHOOK ? 'set' : 'MISSING');
  console.log('Notify unresolved hash:', NOTIFY_HASH ? 'yes' : 'no');

  // Load experiment definitions with bucket ranges
  const defs = await loadExperimentDefs();

  // Fetch token snapshot FIRST (authenticated endpoint returns more experiments)
  const tokenSnap = await fetchTokenSnapshot(defs);
  console.log('Token snapshot:', tokenSnap.length, 'experiments');

  // Sample fingerprints (unauthenticated — for detection + fallback estimation)
  const { byHash, ok, fail } = await sampleFingerprints(SAMPLES, CONC);

  if (ok < MIN_OK) {
    console.warn('Too few ok samples', ok, '<', MIN_OK, '— skip estimates (avoid noise)');
  }

  // Build a set of hashes detected via sampling or token snapshot
  const detectedHashes = new Set();
  for (const hash of byHash.keys()) detectedHashes.add(hash);
  for (const t of tokenSnap) detectedHashes.add(t.hash);

  const experiments = [];
  const processedHashes = new Set();

  // 1. Process ALL worker API definitions that have an active rollout
  //    (non-None bucket with non-zero range) — these give EXACT percentages
  for (const [hash, def] of defs) {
    if (def.source !== 'worker_api' || !def.populations || !def.populations.length) continue;
    if (processedHashes.has(hash)) continue;

    const exactPcts = calculateBucketPercentages(def);
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
    });
  }
  console.log('Worker API experiments with active rollout:', experiments.length);

  // 2. Process experiments detected via fingerprint sampling but NOT in worker API
  //    (fallback to estimation from hash_result spread)
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
        if (!oldT || !oldT.pctKnown || oldT.pct == null) continue;
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
        version: 9,
        schemaVersion: 9,
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

  // First run: seed experiments + announced fingerprints WITHOUT webhooks (no flood).
  if (isFirst) {
    const seedAnnounced = { ...announced };
    for (const e of experiments) {
      if (e.named || NOTIFY_HASH) seedAnnounced[String(e.hash)] = e.fingerprint;
    }
    await writeState(seedAnnounced);
    console.log('Seed', experiments.length, '· no notify');
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

module.exports = { main, murmur3, loadExperimentDefs, calculateBucketPercentages, buildTreatments, classifyChange, mergeIntervals };
