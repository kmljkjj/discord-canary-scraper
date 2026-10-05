/**
 * Experiment Rollouts Fetcher
 *
 * Fetches the latest experiment rollout percentages from multiple sources:
 *
 * 1. Discord API /experiments (no auth required) — returns guild experiment
 *    rollouts with bucket ranges. This gives the most up-to-date guild data.
 * 2. Worker API (experiments.dscrd.workers.dev) — has experiment definitions
 *    with bucket ranges for older experiments (guild + user).
 * 3. Local experiments.json — experiment IDs extracted from the client JS bundle.
 *
 * For GUILD experiments: calculates exact percentages from bucket ranges.
 * For USER experiments: the Discord API only returns assignments for the current
 *   fingerprint (not overall rollout). Overall user rollout percentages require
 *   token-based sampling (see user_rollouts.js).
 *
 * Output: data/experiment_rollouts.json with percentages per experiment.
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic');
const { murmur3 } = require('./lib/murmur3');
const { mergeIntervals, intervalsCoverage, coveragePercent, DEFAULT_SCALE } = require('./lib/rollout_math');
const { DEFAULT_UA, sleep } = require('./lib/utils');
const { safeJson } = require('./lib/http');

const DATA = path.join(__dirname, '..', 'data');
const OUTPUT = path.join(DATA, 'experiment_rollouts.json');
const EXPERIMENTS_FILE = path.join(DATA, 'experiments.json');
const CURRENT_FILE = path.join(DATA, 'current_experiments.json');

const DISCORD_API = 'https://discord.com/api/v9';
const WORKER_API = 'https://experiments.dscrd.workers.dev/experiments';
const SCALE = DEFAULT_SCALE; // 10000
const FP_SAMPLES = Math.max(0, Math.min(500, Number(process.env.EXP_FP_SAMPLES || 50)));
const FP_CONCURRENCY = 1; // Must be 1 — Discord rate-limits fingerprint generation
const FP_DELAY_MS = Math.max(1000, Math.min(10000, Number(process.env.EXP_FP_DELAY_MS || 5000)));

// ── HTTP helpers ──────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    timeout: 20000,
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const data = await safeJson(res);
  if (data === null) throw new Error(`${url} → JSON invalide`);
  return data;
}

// ── Parse guild experiment rollouts from Discord API ──

/**
 * Parse the compact array format returned by Discord API /experiments.
 * Format: [hash, name, revision, populations, overrides, ...]
 * Populations: [[[positions], [filters]], ...]
 * Positions: [[bucket, [{s, e}, ...]], ...]
 */
function parseGuildExperiment(ge) {
  if (!Array.isArray(ge) || ge.length < 4) return null;
  const hash = ge[0];
  const name = ge[1];
  const revision = ge[2];
  const populations = ge[3] || [];

  // Collect all bucket ranges for treatment buckets (bucket > 0)
  const treatmentRanges = [];
  const allRanges = [];
  const filtersByPop = [];

  for (const pop of populations) {
    const positions = pop[0] || [];
    const filters = pop[1] || [];
    const filterDesc = describeFilters(filters);
    filtersByPop.push(filterDesc);

    for (const pos of positions) {
      const bucket = pos[0];
      const rollouts = pos[1] || [];
      for (const r of rollouts) {
        const start = typeof r === 'object' ? (r.s ?? 0) : 0;
        const end = typeof r === 'object' ? (r.e ?? 0) : 0;
        allRanges.push([start, end, bucket]);
        if (bucket > 0) {
          treatmentRanges.push([start, end]);
        }
      }
    }
  }

  // Calculate coverage percentage
  const merged = mergeIntervals(treatmentRanges);
  const coverage = intervalsCoverage(merged, SCALE);
  const pct = coveragePercent(treatmentRanges, SCALE);

  // Determine rollout status
  let status = 'unknown';
  if (pct != null) {
    if (pct <= 0) status = 'not_started';
    else if (pct >= 100) status = 'full_rollout';
    else status = 'partial';
  }

  return {
    hash,
    name,
    revision,
    percentage: pct,
    status,
    coverage,
    populations: populations.length,
    filters: filtersByPop,
    treatmentRanges: merged,
    allRanges,
  };
}

function describeFilters(filters) {
  if (!filters || !filters.length) return 'all';
  const parts = [];
  for (const f of filters) {
    if (!Array.isArray(f) || f.length < 1) continue;
    const type = f[0];
    if (type === 1604612045) {
      // Feature filter
      const features = (f[1] || []).map((ff) => {
        if (Array.isArray(ff) && ff.length >= 2) {
          return typeof ff[1] === 'string' ? ff[1] : `feature_${ff[0]}`;
        }
        return String(ff);
      });
      parts.push('feature:' + features.join(','));
    } else if (type === 2404720969) {
      parts.push('member_count:' + JSON.stringify(f[1]));
    } else if (type === 2918402255) {
      parts.push('id_range:' + JSON.stringify(f[1]));
    } else {
      parts.push(`filter_${type}`);
    }
  }
  return parts.join('; ') || 'all';
}

// ── Parse worker API experiment definitions ───────────

/**
 * Parse experiment definitions from the worker API.
 * Returns percentages for both guild and user experiments.
 */
function parseWorkerExperiment(e) {
  if (!e || !e.rollout || !e.rollout.populations) return null;
  const id = String(e.id || e.name || '');
  if (!id) return null;
  const hash = e.hash != null ? Number(e.hash) : murmur3(id);
  const type = e.type || e.kind || 'unknown';
  const title = e.title || e.label || id;

  const treatmentRanges = [];
  const filtersByPop = [];

  for (const pop of e.rollout.populations) {
    const positions = pop.position || [];
    const filters = pop.filters || [];
    const filterDesc = filters.map((f) => {
      if (f.type === 'feature') return 'feature:' + (f.features || []).join(',');
      if (f.type === 'member_count') return 'member_count';
      return f.type || 'unknown';
    }).join('; ') || 'all';
    filtersByPop.push(filterDesc);

    for (const pos of positions) {
      const bucket = pos.bucket;
      const rollouts = pos.rollouts || [];
      for (const r of rollouts) {
        if (bucket > 0) {
          treatmentRanges.push([r.start, r.end]);
        }
      }
    }
  }

  // Also check overrides_formatted (these are for staff/internal)
  // Overrides are for specific users/guilds, not overall rollout — skipped

  const merged = mergeIntervals(treatmentRanges);
  const coverage = intervalsCoverage(merged, SCALE);
  const pct = coveragePercent(treatmentRanges, SCALE);

  let status = 'unknown';
  if (pct != null) {
    if (pct <= 0) status = 'not_started';
    else if (pct >= 100) status = 'full_rollout';
    else status = 'partial';
  }

  return {
    id,
    hash,
    type,
    title,
    percentage: pct,
    status,
    coverage,
    populations: e.rollout.populations.length,
    filters: filtersByPop,
    revision: e.rollout.revision,
    buckets: e.buckets,
    treatmentRanges: merged,
  };
}

// ── Fingerprint-based user experiment sampling ──────

/**
 * Generate a Discord fingerprint without authentication.
 * Retries on 429 with exponential backoff.
 */
async function getFingerprint(retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(`${DISCORD_API}/auth/fingerprint`, {
      method: 'POST',
      headers: { 'User-Agent': DEFAULT_UA, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    if (r.status === 429) {
      const retryAfter = Number(r.headers.get('Retry-After') || 5);
      const delay = Math.min(30, retryAfter + attempt * 2) * 1000;
      if (attempt < retries) {
        await sleep(delay);
        continue;
      }
    }
    if (!r.ok) throw new Error(`fingerprint → ${r.status}`);
    const data = await safeJson(r);
    return data.fingerprint;
  }
}

/**
 * Query /experiments with a given fingerprint.
 * Returns { assignments, guild_experiments }.
 */
async function getExperimentsWithFp(fp) {
  const r = await fetch(`${DISCORD_API}/experiments?with_guild_experiments=true`, {
    headers: { 'User-Agent': DEFAULT_UA, 'X-Fingerprint': fp },
    timeout: 15000,
  });
  if (!r.ok) throw new Error(`experiments(fp) → ${r.status}`);
  const data = await safeJson(r);
  return data;
}

/**
 * Sample user experiment rollouts using anonymous fingerprints.
 *
 * The Discord API /experiments endpoint returns 3-4 user assignments per
 * fingerprint. Each assignment is an array:
 *   [hash, bucket, revision, ?, treatment, hash_result, ...]
 * Where treatment > 0 means the user is enrolled in a treatment variant.
 *
 * By generating many fingerprints and collecting the treatment values,
 * we can estimate the rollout percentage for each user experiment.
 *
 * @param {Map<number, {id, type, title}>} hashToId - hash → experiment info
 * @returns {Map<number, {hash, samples, enrolled, percentage, hashResults}>}
 */
async function sampleFingerprintRollouts(hashToId) {
  console.log(`\n=== Fingerprint sampling (${FP_SAMPLES} samples, concurrency ${FP_CONCURRENCY}) ===`);

  const stats = new Map(); // hash → { samples, enrolled, hashResults, treatments }
  let success = 0;
  let fail = 0;
  let lastProgress = 0;

  async function sampleOne() {
    try {
      const fp = await getFingerprint();
      await sleep(FP_DELAY_MS / 2);
      const data = await getExperimentsWithFp(fp);
      const assignments = data.assignments || {};

      for (const [, val] of Object.entries(assignments)) {
        if (!Array.isArray(val) || val.length < 6) continue;
        const hash = val[0];
        const treatment = val[4];
        const hashResult = val[5];

        if (!stats.has(hash)) {
          stats.set(hash, { samples: 0, enrolled: 0, hashResults: [], treatments: new Map() });
        }
        const s = stats.get(hash);
        s.samples++;
        if (treatment > 0) s.enrolled++;
        s.treatments.set(treatment, (s.treatments.get(treatment) || 0) + 1);
        if (hashResult != null && hashResult >= 0) s.hashResults.push(hashResult);
      }
      success++;
    } catch (e) {
      fail++;
    }

    const progress = Math.floor(((success + fail) / FP_SAMPLES) * 100);
    if (progress >= lastProgress + 10) {
      lastProgress = progress;
      const hits = [...stats.values()].reduce((a, s) => a + s.samples, 0);
      console.log(`  ${progress}% — ${success} ok, ${fail} fail, ${stats.size} unique hashes, ${hits} assignment hits`);
    }
  }

  // Run sequentially (Discord rate-limits fingerprint generation)
  for (let i = 0; i < FP_SAMPLES; i++) {
    await sampleOne();
    if (FP_DELAY_MS > 0 && i < FP_SAMPLES - 1) {
      await sleep(FP_DELAY_MS);
    }
  }

  console.log(`  Done: ${success} ok, ${fail} fail, ${stats.size} unique experiment hashes sampled`);

  // Calculate estimated percentages
  const results = [];
  for (const [hash, s] of stats) {
    const pct = s.samples > 0 ? Math.round((s.enrolled / s.samples) * 10000) / 100 : null;
    const idInfo = hashToId.get(hash);
    const treatmentDist = {};
    for (const [t, c] of s.treatments) {
      treatmentDist[t] = c;
    }

    let status = 'unknown';
    if (pct != null) {
      if (pct <= 0) status = 'not_started';
      else if (pct >= 100) status = 'full_rollout';
      else status = 'partial';
    }

    results.push({
      hash,
      id: idInfo ? idInfo.id : null,
      type: idInfo ? idInfo.type : 'user',
      title: idInfo ? idInfo.title : `hash_${hash}`,
      percentage: pct,
      status,
      samples: s.samples,
      enrolled: s.enrolled,
      treatmentDistribution: treatmentDist,
      source: 'fingerprint_sampling',
      note: !idInfo ? 'No local experiment ID match for this hash' : null,
    });
  }

  return results;
}

// ── Main ─────────────────────────────────────────────

async function main() {
  console.log('=== Experiment Rollouts ===');
  const fetchedAt = new Date().toISOString();
  const results = {
    fetchedAt,
    sources: {},
    guildExperiments: [],
    userExperiments: [],
    matchedExperiments: [],
    summary: { guild: 0, user: 0, withPercentage: 0, withoutPercentage: 0 },
  };

  // 1. Load local experiments (from client JS bundle)
  let localExperiments = [];
  try {
    if (await fs.pathExists(CURRENT_FILE)) {
      const d = await fs.readJson(CURRENT_FILE);
      localExperiments = d.experiments || d;
      if (!Array.isArray(localExperiments)) localExperiments = [];
      console.log('Local experiments:', localExperiments.length);
    }
  } catch (e) {
    console.warn('Local experiments load failed:', e.message);
  }

  // Also try experiments.json
  try {
    if (await fs.pathExists(EXPERIMENTS_FILE)) {
      const d = await fs.readJson(EXPERIMENTS_FILE);
      const exps = d.experiments || d;
      if (Array.isArray(exps)) {
        for (const e of exps) {
          if (!localExperiments.find((le) => le.id === e.id)) {
            localExperiments.push(e);
          }
        }
      }
    }
  } catch (e) {
    console.warn('experiments.json load failed:', e.message);
  }

  // Build hash → ID map from local experiments
  const localHashMap = new Map();
  for (const exp of localExperiments) {
    const id = String(exp.id || '');
    if (!id) continue;
    const hash = murmur3(id);
    localHashMap.set(hash, { id, type: exp.kind || exp.type || 'unknown', title: exp.label || exp.title || id });
  }
  console.log('Local hash map:', localHashMap.size, 'entries');

  // 2. Fetch guild experiment rollouts from Discord API (no auth)
  let guildRollouts = [];
  try {
    const data = await fetchJson(`${DISCORD_API}/experiments?with_guild_experiments=true`);
    const guildExps = data.guild_experiments || [];
    console.log('Discord API guild experiments:', guildExps.length);
    results.sources.discordApi = { url: `${DISCORD_API}/experiments`, count: guildExps.length };

    for (const ge of guildExps) {
      const parsed = parseGuildExperiment(ge);
      if (!parsed) continue;

      // Match hash to experiment ID
      const localMatch = localHashMap.get(parsed.hash);
      if (localMatch) {
        parsed.id = localMatch.id;
        parsed.type = 'guild';
        parsed.title = localMatch.title;
        parsed.source = 'discord_api + local_match';
      } else {
        parsed.id = null;
        parsed.type = 'guild';
        parsed.title = `hash_${parsed.hash}`;
        parsed.source = 'discord_api';
        parsed.note = 'No local experiment ID match for this hash';
      }
      guildRollouts.push(parsed);
    }
    results.guildExperiments = guildRollouts;
    results.summary.guild = guildRollouts.length;
  } catch (e) {
    console.warn('Discord API fetch failed:', e.message);
    results.sources.discordApi = { error: e.message };
  }

  // 3. Fetch experiment definitions from worker API
  let workerExperiments = [];
  try {
    const data = await fetchJson(WORKER_API);
    const list = Array.isArray(data) ? data : data.experiments || [];
    console.log('Worker API experiments:', list.length);
    results.sources.workerApi = { url: WORKER_API, count: list.length };

    for (const e of list) {
      const parsed = parseWorkerExperiment(e);
      if (!parsed) continue;

      // Check if this experiment exists in local data
      const localMatch = localExperiments.find((le) => le.id === parsed.id);
      if (localMatch) {
        parsed.inClient = true;
        parsed.clientKind = localMatch.kind || localMatch.type;
      }

      workerExperiments.push(parsed);
    }
  } catch (e) {
    console.warn('Worker API fetch failed:', e.message);
    results.sources.workerApi = { error: e.message };
  }

  // 4. Sample user experiment rollouts via anonymous fingerprints
  //    This generates N fingerprints, queries /experiments for each, and
  //    estimates rollout percentages based on treatment assignment rates.
  const fpResults = [];
  try {
    const fpRollouts = await sampleFingerprintRollouts(localHashMap);
    results.sources.fingerprintSampling = {
      samples: FP_SAMPLES,
      uniqueHashes: fpRollouts.length,
      matched: fpRollouts.filter((r) => r.id).length,
    };
    for (const r of fpRollouts) {
      fpResults.push(r);
    }
  } catch (e) {
    console.warn('Fingerprint sampling failed:', e.message);
    results.sources.fingerprintSampling = { error: e.message };
  }

  // 5. Merge guild rollouts from Discord API with worker API data
  // Discord API has the latest guild data, worker API has experiment IDs
  const mergedExperiments = new Map();

  // Add Discord API guild experiments
  for (const ge of guildRollouts) {
    const key = ge.id || `hash_${ge.hash}`;
    mergedExperiments.set(key, { ...ge, source: 'discord_api' });
  }

  // Add worker API experiments (both guild and user)
  for (const we of workerExperiments) {
    const key = we.id;
    if (mergedExperiments.has(key)) {
      // Merge: prefer Discord API data for guild experiments, worker for user
      const existing = mergedExperiments.get(key);
      if (existing.type === 'guild' && existing.source === 'discord_api') {
        // Keep Discord API data, add worker info
        existing.workerTitle = we.title;
        existing.workerRevision = we.revision;
        existing.buckets = we.buckets;
      }
    } else {
      mergedExperiments.set(key, { ...we, source: 'worker_api' });
    }
  }

  // Add fingerprint-sampled user experiments
  for (const fp of fpResults) {
    const key = fp.id || `hash_${fp.hash}`;
    if (mergedExperiments.has(key)) {
      // Merge fingerprint data into existing entry
      const existing = mergedExperiments.get(key);
      existing.fpPercentage = fp.percentage;
      existing.fpSamples = fp.samples;
      existing.fpEnrolled = fp.enrolled;
      existing.fpTreatmentDist = fp.treatmentDistribution;
      // Use fingerprint percentage if no other percentage is available
      if (existing.percentage == null && fp.percentage != null) {
        existing.percentage = fp.percentage;
        existing.status = fp.status;
        existing.source = 'fingerprint_sampling';
      }
    } else {
      mergedExperiments.set(key, {
        ...fp,
        fpSamples: fp.samples,
        fpEnrolled: fp.enrolled,
        fpTreatmentDist: fp.treatmentDistribution,
        source: 'fingerprint_sampling',
      });
    }
  }

  // 6. Add local experiments that have no rollout data
  for (const exp of localExperiments) {
    const id = String(exp.id || '');
    if (!id) continue;
    if (!mergedExperiments.has(id)) {
      const hash = murmur3(id);
      const kind = exp.kind || exp.type || 'unknown';
      mergedExperiments.set(id, {
        id,
        hash,
        type: kind,
        title: exp.label || exp.title || id,
        percentage: null,
        status: 'no_rollout_data',
        source: 'client_bundle',
        note: kind === 'user'
          ? 'User experiment — rollout percentage not publicly available. Use user_rollouts.js with tokens for estimation.'
          : 'No rollout data found in Discord API or worker API.',
      });
    }
  }

  // 7. Build final results
  const allExperiments = [...mergedExperiments.values()];
  results.matchedExperiments = allExperiments;

  results.summary = {
    total: allExperiments.length,
    guild: allExperiments.filter((e) => e.type === 'guild').length,
    user: allExperiments.filter((e) => e.type === 'user').length,
    withPercentage: allExperiments.filter((e) => e.percentage != null).length,
    withoutPercentage: allExperiments.filter((e) => e.percentage == null).length,
    fullRollout: allExperiments.filter((e) => e.status === 'full_rollout').length,
    partial: allExperiments.filter((e) => e.status === 'partial').length,
    notStarted: allExperiments.filter((e) => e.status === 'not_started').length,
    fpSampled: allExperiments.filter((e) => e.fpSamples != null || e.source === 'fingerprint_sampling').length,
  };

  // Print summary
  console.log('\n=== Summary ===');
  console.log(`Total: ${results.summary.total}`);
  console.log(`Guild: ${results.summary.guild} | User: ${results.summary.user}`);
  console.log(`With percentage: ${results.summary.withPercentage} | Without: ${results.summary.withoutPercentage}`);
  console.log(`Full rollout: ${results.summary.fullRollout} | Partial: ${results.summary.partial} | Not started: ${results.summary.notStarted}`);

  // Print specific experiments the user asked about
  const interesting = ['silp-direct-to-discoverable', 'soundboard-quick-action'];
  for (const term of interesting) {
    const matches = allExperiments.filter((e) => e.id && e.id.includes(term));
    for (const m of matches) {
      console.log(`\n  ${m.id}: ${m.percentage != null ? m.percentage + '%' : 'no percentage'} (${m.type}, ${m.status}, ${m.source})`);
      if (m.fpSamples != null) {
        console.log(`    FP samples: ${m.fpSamples}, enrolled: ${m.fpEnrolled}, treatment: ${JSON.stringify(m.fpTreatmentDist)}`);
      }
    }
  }

  // Save
  await writeJsonAtomic(OUTPUT, results, 2);
  console.log('\nSaved to', OUTPUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
