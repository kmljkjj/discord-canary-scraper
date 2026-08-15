/**
 * Estimate USER experiment rollout % — same idea as Discord Experiment Hub
 * (rollout-calculation.js) and Wumpus Apex research crowd-sampling.
 *
 * Discord does NOT publish global user rollout ranges. We approximate by:
 *  1) Hitting GET /api/v10/experiments many times (new fingerprint each time)
 *  2) Recording (hash → bucket → hash_result samples)
 *  3) Converting observed ranges / frequencies into %
 *
 * With secret DISCORD_TOKEN (user token), assignments list is much richer.
 * Without token, only fingerprint-level experiments are visible.
 */

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(DATA_DIR, 'user_rollouts.json');
const EXPERIMENTS_API = 'https://canary.discord.com/api/v10/experiments';
const DEFINITIONS_URL =
  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Keep Actions time reasonable; raise via env if you run on VPS
const SAMPLE_COUNT = Number(process.env.USER_ROLLOUT_SAMPLES || 80);
const DELAY_MS = Number(process.env.USER_ROLLOUT_DELAY_MS || 400);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchAssignments(token) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
  };
  if (token) headers.Authorization = token.startsWith('Bot ') ? token : token;

  const res = await fetch(EXPERIMENTS_API, { headers });
  if (!res.ok) throw new Error(`experiments ${res.status}`);
  return res.json();
}

function murmur3(key) {
  const data = Buffer.from(String(key), 'utf8');
  const len = data.length;
  const nblocks = (len / 4) | 0;
  let h = 0;
  for (let i = 0; i < nblocks; i++) {
    const i4 = i * 4;
    let k =
      (data[i4] & 0xff) |
      ((data[i4 + 1] & 0xff) << 8) |
      ((data[i4 + 2] & 0xff) << 16) |
      ((data[i4 + 3] & 0xff) << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const tail = nblocks * 4;
  switch (len & 3) {
    case 3:
      k ^= (data[tail + 2] & 0xff) << 16;
    case 2:
      k ^= (data[tail + 1] & 0xff) << 8;
    case 1:
      k ^= data[tail] & 0xff;
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h ^= k;
  }
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Aggregate samples → estimated ranges & % per bucket (DEH style).
 * ranges from min/max hash_result observed in that bucket.
 */
function aggregate(samplesByHash) {
  const out = {};
  for (const [hash, buckets] of Object.entries(samplesByHash)) {
    const bucketStats = {};
    let totalHits = 0;
    for (const [bucket, hits] of Object.entries(buckets)) {
      totalHits += hits.hashResults.length;
    }
    for (const [bucket, hits] of Object.entries(buckets)) {
      const hrs = hits.hashResults;
      const min = Math.min(...hrs);
      const max = Math.max(...hrs);
      const span = Math.max(0, max - min);
      // frequency-based % (more stable with few samples)
      const freqPercent =
        totalHits > 0
          ? Math.round((hrs.length / totalHits) * 10000) / 100
          : 0;
      // range-based % (DEH style) — optimistic span
      const rangePercent = Math.round((span / 10000) * 10000) / 100;
      bucketStats[bucket] = {
        bucket: Number(bucket),
        samples: hrs.length,
        hashResultMin: min,
        hashResultMax: max,
        estimatedRange: { start: min, end: max },
        percentByFrequency: freqPercent,
        percentByRangeSpan: rangePercent,
        // Prefer frequency when we have enough samples
        percent: hrs.length >= 5 ? freqPercent : rangePercent,
      };
    }
    out[hash] = {
      hash: Number(hash),
      buckets: bucketStats,
      totalSamples: totalHits,
    };
  }
  return out;
}

async function loadDefinitions() {
  try {
    const res = await fetch(DEFINITIONS_URL, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  const token = process.env.DISCORD_TOKEN || null;
  console.log(
    `🎲 Sampling user experiments (${SAMPLE_COUNT} requests)${
      token ? ' [with token]' : ' [fingerprint only]'
    }…`,
  );

  // hash -> bucket -> { hashResults: number[] }
  const samplesByHash = {};
  let lastError = null;

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    try {
      const data = await fetchAssignments(token);
      for (const a of data.assignments || []) {
        const hash = a[0];
        const bucket = a[2];
        const hashResult = a[5];
        if (hash == null || bucket == null || hashResult == null) continue;
        const h = String(hash);
        const b = String(bucket);
        if (!samplesByHash[h]) samplesByHash[h] = {};
        if (!samplesByHash[h][b]) samplesByHash[h][b] = { hashResults: [] };
        samplesByHash[h][b].hashResults.push(hashResult);
      }
      if ((i + 1) % 20 === 0) {
        console.log(
          `  ${i + 1}/${SAMPLE_COUNT} — ${Object.keys(samplesByHash).length} hashes`,
        );
      }
    } catch (e) {
      lastError = e.message;
      console.warn(`  sample ${i + 1} failed:`, e.message);
      await sleep(DELAY_MS * 2);
      continue;
    }
    await sleep(DELAY_MS);
  }

  const aggregated = aggregate(samplesByHash);

  // Map hash → definition id via murmur3
  const definitions = await loadDefinitions();
  const byHash = new Map();
  for (const d of definitions) {
    if (!d.id) continue;
    byHash.set(murmur3(String(d.id)), d);
  }

  const experiments = [];
  for (const [hash, info] of Object.entries(aggregated)) {
    const def = byHash.get(Number(hash) >>> 0) || null;
    const treatments = Object.values(info.buckets).map((b) => ({
      id: b.bucket,
      label:
        b.bucket === -1
          ? 'None'
          : b.bucket === 0
            ? 'Control'
            : `Treatment ${b.bucket}`,
      percent: b.percent,
      percentByFrequency: b.percentByFrequency,
      percentByRangeSpan: b.percentByRangeSpan,
      samples: b.samples,
      ranges: `${b.hashResultMin}–${b.hashResultMax}`,
    }));

    experiments.push({
      hash: Number(hash),
      id: def?.id || null,
      label: def?.label || null,
      kind: def?.kind || 'user',
      source: 'sampled',
      method: 'fingerprint_or_token_sampling',
      reliability: token ? 'medium' : 'low',
      note:
        'Estimated — Discord does not publish global user rollout ranges. ' +
        'Same approach as DEH rollout-calculation / Wumpus crowd sampling.',
      totalSamples: info.totalSamples,
      treatments,
      count: treatments.length,
    });
  }

  experiments.sort((a, b) => String(b.id || b.hash).localeCompare(String(a.id || a.hash)));

  const payload = {
    scrapedAt: new Date().toISOString(),
    sampleCount: SAMPLE_COUNT,
    usedToken: Boolean(token),
    experimentCount: experiments.length,
    lastError,
    experiments,
  };

  await fs.writeJson(OUT_FILE, payload, { spaces: 2 });
  console.log(
    `\n✅ user_rollouts.json — ${experiments.length} experiments estimated`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
