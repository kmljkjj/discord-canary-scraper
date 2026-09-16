/**
 * User experiment rollouts — fingerprint sampling (DEH-style)
 *
 * GET /experiments without auth returns anonymous fingerprint + assignments.
 * Sampling many fingerprints estimates bucket ranges / %.
 *
 * Soft on rate-limits (429): low concurrency, delays, Retry-After.
 *
 * Env:
 *   DISCORD_USER_TOKEN / DISCORD_USER_TOKENS / TOKEN_1..5  optional
 *   APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   USER_ROLLOUT_SAMPLES       default 40 (was 150 — too aggressive)
 *   USER_ROLLOUT_CONCURRENCY   default 2
 *   USER_ROLLOUT_DELAY_MS      default 250 between requests
 *   APEX_MIN_PCT_DELTA         default 2
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'user_rollouts.json');
const KNOWN = path.join(DATA, 'known_experiment_ids.json');
const EXPS = path.join(DATA, 'experiments.json');
const BASELINE = path.join(DATA, 'baseline_experiments.json');

function loadTokens() {
  const out = [];
  const push = (t) => {
    const s = String(t || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  const multi = process.env.DISCORD_USER_TOKENS || '';
  if (multi) multi.split(/[,\n;]+/).forEach(push);
  push(process.env.DISCORD_USER_TOKEN);
  push(process.env.DISCORD_TOKEN);
  for (let i = 1; i <= 5; i++) {
    push(process.env['DISCORD_USER_TOKEN_' + i]);
    push(process.env['DISCORD_USER_TOKENS' + i]);
  }
  return out;
}

const TOKENS = loadTokens();
const TOKEN = TOKENS[0] || '';
const WEBHOOK =
  process.env.APEX_WEBHOOK_URL ||
  process.env.ROLLOUT_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;
const SAMPLES = Math.max(10, Math.min(400, Number(process.env.USER_ROLLOUT_SAMPLES || 40)));
const CONC = Math.max(1, Math.min(4, Number(process.env.USER_ROLLOUT_CONCURRENCY || 2)));
const DELAY_MS = Math.max(50, Math.min(5000, Number(process.env.USER_ROLLOUT_DELAY_MS || 250)));
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 2);
const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/assets/datamining-avatar.svg';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SCALE = 10000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function murmur3(key, seed = 0) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51,
    c2 = 0x1b873593;
  const bytes = Buffer.from(String(key), 'utf8');
  const len = bytes.length,
    nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k1 =
      bytes[i * 4] |
      (bytes[i * 4 + 1] << 8) |
      (bytes[i * 4 + 2] << 16) |
      (bytes[i * 4 + 3] << 24);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }
  let k1 = 0,
    off = nblocks * 4,
    tail = len & 3;
  if (tail === 3) k1 ^= bytes[off + 2] << 16;
  if (tail >= 2) k1 ^= bytes[off + 1] << 8;
  if (tail >= 1) {
    k1 ^= bytes[off];
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

async function loadHashMap() {
  const map = new Map();
  const add = (id, type, title) => {
    if (!id || typeof id !== 'string') return;
    const h = murmur3(id);
    if (!map.has(h)) map.set(h, { id, type: type || 'user', title: title || id });
  };
  for (const f of [EXPS, BASELINE, KNOWN]) {
    if (!(await fs.pathExists(f))) continue;
    try {
      const j = await fs.readJson(f);
      const arr = Array.isArray(j) ? j : j.experiments || j.ids || Object.keys(j);
      for (const e of arr) {
        if (typeof e === 'string') add(e, 'user');
        else if (e && e.id) add(e.id, e.type || e.kind || 'user', e.title || e.label || e.id);
      }
    } catch (_) {}
  }
  console.log('Hash map:', map.size, 'ids');
  return map;
}

async function fetchAssignments(extraHeaders = {}, attempt = 0) {
  const res = await fetch('https://canary.discord.com/api/v10/experiments', {
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...extraHeaders,
    },
    timeout: 25000,
  });
  if (res.status === 429 && attempt < 4) {
    const ra = Number(res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset-after') || 2);
    const wait = Math.min(30, Math.max(1, ra)) * 1000 + attempt * 500;
    console.warn('429 → wait', Math.round(wait / 1000) + 's');
    await sleep(wait);
    return fetchAssignments(extraHeaders, attempt + 1);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return {
    fingerprint: data.fingerprint,
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
  };
}

/**
 * Sample anonymous fingerprints slowly (avoid Cloudflare / Discord 429).
 */
async function sampleFingerprints(n, concurrency) {
  const ranges = new Map();
  let ok = 0,
    fail = 0,
    consecutive429 = 0;
  let next = 0;

  async function worker() {
    while (true) {
      const my = next++;
      if (my >= n) break;
      if (consecutive429 > 8) {
        fail++;
        continue;
      }
      try {
        await sleep(DELAY_MS + Math.floor(Math.random() * 80));
        const { assignments } = await fetchAssignments({
          'X-Request-Id': crypto.randomBytes(16).toString('hex'),
        });
        consecutive429 = 0;
        for (const a of assignments) {
          if (!Array.isArray(a) || a.length < 6) continue;
          const hash = a[0],
            bucket = a[2],
            hr = a[5];
          if (hr == null || !Number.isFinite(Number(hr))) continue;
          if (!ranges.has(hash)) ranges.set(hash, new Map());
          const bm = ranges.get(hash);
          if (!bm.has(bucket)) bm.set(bucket, []);
          bm.get(bucket).push(Number(hr));
        }
        ok++;
      } catch (e) {
        fail++;
        if (String(e.message).includes('429')) consecutive429++;
        if (fail <= 6) console.warn('sample fail', e.message);
        if (consecutive429 > 3) await sleep(3000);
      }
      if (my && my % 20 === 0) console.log('  sampled', my, '/', n, 'ok', ok);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log('Samples ok', ok, 'fail', fail, 'hashes', ranges.size);
  return ranges;
}

function rangesToTreatments(bucketMap) {
  const treatments = [];
  for (const [bucket, hrs] of bucketMap) {
    if (!hrs.length) continue;
    const min = Math.min(...hrs);
    const max = Math.max(...hrs);
    const start = Math.round(min / 500) * 500;
    const end = Math.min(SCALE, Math.round(max / 500) * 500 || max);
    const span = Math.max(0, end - start);
    const pct = Math.round((span / SCALE) * 10000) / 100;
    treatments.push({
      bucket: Number(bucket),
      label: Number(bucket) === -1 ? 'None' : Number(bucket) === 0 ? 'Control' : 'Variant ' + bucket,
      pct: Math.min(100, pct),
      range: [start, end],
      samples: hrs.length,
      rawMin: min,
      rawMax: max,
    });
  }
  if (treatments.length === 1 && treatments[0].samples > 5) {
    const t = treatments[0];
    if (t.rawMax - t.rawMin > 8000) t.pct = 100;
  }
  const totalSamples = treatments.reduce((s, t) => s + t.samples, 0);
  if (treatments.length > 1 && totalSamples > 0) {
    for (const t of treatments) {
      t.pct = Math.round((t.samples / totalSamples) * 10000) / 100;
    }
  }
  return treatments.sort((a, b) => a.bucket - b.bucket);
}

function fingerprintOf(treatments) {
  return treatments
    .map((t) => t.bucket + ':' + Number(t.pct).toFixed(1))
    .sort()
    .join('|');
}

async function fetchTokenSnapshot(hashMap) {
  if (!TOKENS.length) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < TOKENS.length; i++) {
    const tok = TOKENS[i];
    try {
      await sleep(400);
      const { assignments } = await fetchAssignments({
        Authorization: tok,
        'X-Discord-Locale': 'en-US',
      });
      console.log('Token#' + (i + 1) + ' assignments:', assignments.length);
      for (const a of assignments) {
        if (!Array.isArray(a) || a.length < 3) continue;
        const hash = a[0],
          revision = a[1],
          bucket = a[2];
        const key = hash + '@' + revision + '@' + bucket;
        if (seen.has(key)) continue;
        seen.add(key);
        const meta = hashMap.get(hash) || { id: 'hash:' + hash, type: 'user', title: 'hash:' + hash };
        out.push({
          id: meta.id,
          hash,
          type: meta.type || 'user',
          title: meta.title,
          revision,
          bucket,
          override: a[3],
          population: a[4],
          hash_result: a[5],
          tokenIndex: i + 1,
        });
      }
    } catch (e) {
      console.warn('Token#' + (i + 1) + ' snapshot fail:', e.message);
    }
  }
  return out;
}

function buildEmbeds(changes) {
  const embeds = [];
  for (const c of changes.slice(0, 12)) {
    const lines = [];
    lines.push('**Type** · `user`');
    if (c.kind === 'pct') {
      for (const d of c.deltas || []) {
        const arrow = d.to > d.from ? '↑' : '↓';
        lines.push(
          '• **' +
            d.label +
            '** · `' +
            d.from +
            '%` → `' +
            d.to +
            '%` (' +
            arrow +
            Math.abs(d.to - d.from).toFixed(1) +
            ')',
        );
        if (d.range) lines.push('  `(' + d.range[0] + ' - ' + d.range[1] + ')`');
      }
    } else if (c.kind === 'revision') {
      lines.push('**Revision** · `' + c.fromRev + '` → `' + c.toRev + '`');
      lines.push('**Bucket** · `' + c.bucket + '`');
    } else if (c.kind === 'new') {
      for (const t of c.treatments || []) {
        lines.push('• **' + t.label + '** · `' + t.pct + '%`');
        if (t.range) lines.push('  `(' + t.range[0] + ' - ' + t.range[1] + ')`');
      }
    }
    lines.push('_estimé par sampling fingerprint_');
    embeds.push({
      author: { name: 'Datamining', icon_url: AVATAR },
      title: (c.kind === 'new' ? '➕ ' : '🔁 ') + (c.title || c.id),
      description: lines.join('\n').slice(0, 3900),
      color: c.kind === 'new' ? 0x3ba55d : 0xfaa61a,
      footer: { text: String(c.id || '') },
    });
  }
  return embeds;
}

async function postWebhook(embeds) {
  if (!WEBHOOK || !embeds.length) return { ok: false, status: 0 };
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: BOT, avatar_url: AVATAR, embeds: embeds.slice(0, 10) }),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text: text.slice(0, 200) };
}

async function main() {
  await fs.ensureDir(DATA);
  console.log('📊 User rollouts (fingerprint sampling)…');
  console.log(
    'Samples:',
    SAMPLES,
    'concurrency:',
    CONC,
    'delayMs:',
    DELAY_MS,
    'tokens:',
    TOKENS.length,
  );
  console.log('Webhook:', WEBHOOK ? 'set' : 'MISSING');

  const hashMap = await loadHashMap();
  const sampled = await sampleFingerprints(SAMPLES, CONC);

  const experiments = [];
  for (const [hash, bucketMap] of sampled) {
    const meta = hashMap.get(hash) || {
      id: 'hash:' + hash,
      type: 'user',
      title: 'hash:' + hash,
    };
    const treatments = rangesToTreatments(bucketMap);
    if (!treatments.length) continue;
    experiments.push({
      id: meta.id,
      hash,
      type: 'user',
      title: meta.title,
      treatments,
      fingerprint: fingerprintOf(treatments),
      source: 'fingerprint-sample',
    });
  }
  console.log('Estimated user experiments:', experiments.length);

  const tokenSnap = await fetchTokenSnapshot(hashMap);

  let prev = { experiments: [], token: [] };
  if (await fs.pathExists(STATE)) {
    try {
      prev = await fs.readJson(STATE);
    } catch (_) {}
  }
  const isFirst = !(prev.experiments && prev.experiments.length);

  const changes = [];
  if (!isFirst) {
    const pMap = new Map((prev.experiments || []).map((e) => [String(e.hash || e.id), e]));
    for (const n of experiments) {
      const p = pMap.get(String(n.hash)) || pMap.get(n.id);
      if (!p) {
        changes.push({ kind: 'new', ...n });
        continue;
      }
      if (p.fingerprint === n.fingerprint) continue;
      const deltas = [];
      const pt = new Map((p.treatments || []).map((t) => [t.bucket, t]));
      for (const t of n.treatments || []) {
        const old = pt.get(t.bucket);
        const from = old ? Number(old.pct) : 0;
        const to = Number(t.pct);
        if (Math.abs(to - from) >= MIN_DELTA) {
          deltas.push({ label: t.label, from, to, range: t.range });
        }
      }
      if (deltas.length) changes.push({ kind: 'pct', id: n.id, title: n.title, deltas });
    }

    const prevTok = new Map((prev.token || []).map((t) => [t.hash, t]));
    for (const t of tokenSnap) {
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

  await fs.writeJson(
    STATE,
    {
      scrapedAt: new Date().toISOString(),
      samples: SAMPLES,
      okEstimate: experiments.length,
      tokens: TOKENS.length,
      experiments,
      token: tokenSnap,
    },
    { spaces: 2 },
  );

  if (isFirst) {
    console.log('Seed', experiments.length, '· no notify');
    return;
  }
  console.log('Changes', changes.length);
  if (!changes.length) {
    console.log('No significant user % change');
    return;
  }
  const embeds = buildEmbeds(changes);
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);
  console.log('✅ Done');
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { main };
