/**
 * Apex rollouts v4.5 — crowd hash_result (Escoteiros/Wumpus) + guild
 * Secrets:
 *   DISCORD_USER_TOKENS = token1,token2,token3  (preferred)
 *   DISCORD_USER_TOKEN / DISCORD_USER_TOKEN_1..5 (fallback)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

// Prefer structured decoder when available
let decodeGuildExperiment = null;
try {
  decodeGuildExperiment = require('./lib/guild_decode').decodeGuildExperiment;
} catch (_) {
  try {
    decodeGuildExperiment = require('../lib/guild_decode').decodeGuildExperiment;
  } catch (_) {}
}


const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'apex_rollouts.json');
const LOCAL_EXP = path.join(DATA_DIR, 'experiments.json');
const KNOWN_EXP = path.join(DATA_DIR, 'known_experiment_ids.json');

function loadUserTokens() {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const s = String(t || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const bulk = process.env.DISCORD_USER_TOKENS || '';
  for (const part of bulk.split(/[,;\n]+/)) push(part);
  for (let i = 1; i <= 10; i++) push(process.env['DISCORD_USER_TOKEN_' + i]);
  push(process.env.DISCORD_USER_TOKEN);
  push(process.env.DISCORD_TOKEN);
  return out;
}
const USER_TOKENS = loadUserTokens();
const DISCORD_TOKEN = USER_TOKENS[0] || '';
const ADVAITH = process.env.APEX_ADVAITH_URL || 'https://api.rollouts.advaith.io';
const WORKERS = process.env.APEX_API_URL || 'https://experiments.dscrd.workers.dev/experiments';
const FALLBACK = process.env.APEX_FALLBACK_URL || 'https://raw.githubusercontent.com/discordexperimenthub/experimentAPI/master/experiments.json';
const WUMPUS_DEFS =
  process.env.APEX_DEFS_URL ||
  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';
const APEX_LOCAL = path.join(DATA_DIR, 'apex_experiments.json');
const WEBHOOK = process.env.APEX_WEBHOOK_URL || process.env.ROLLOUT_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR = process.env.ORBIT_AVATAR_URL || 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4ca.png';
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || '0.5');
const YEAR_MIN = Number(process.env.APEX_RECENT_YEAR || '2024');
const SCALE = 10000;

function murmur3(key, seed = 0) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  const bytes = Buffer.from(String(key), 'utf8');
  const len = bytes.length, nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k1 = bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
    k1 = Math.imul(k1, c1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, c2);
    h1 ^= k1; h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }
  let k1 = 0, off = nblocks * 4, tail = len & 3;
  if (tail === 3) k1 ^= bytes[off + 2] << 16;
  if (tail >= 2) k1 ^= bytes[off + 1] << 8;
  if (tail >= 1) { k1 ^= bytes[off]; k1 = Math.imul(k1, c1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, c2); h1 ^= k1; }
  h1 ^= len; h1 ^= h1 >>> 16; h1 = Math.imul(h1, 0x85ebca6b); h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35); h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

function mergeIntervals(iv) {
  const s = iv.map(([a, b]) => [Number(a), Number(b)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!s.length) return [];
  const out = [s[0].slice()];
  for (let i = 1; i < s.length; i++) {
    const [a, b] = s[i]; const L = out[out.length - 1];
    if (a <= L[1]) L[1] = Math.max(L[1], b); else out.push([a, b]);
  }
  return out;
}
function intervalsToPct(iv) {
  let c = 0; for (const [a, b] of mergeIntervals(iv)) c += b - a;
  return Math.min(100, Math.round((c / SCALE) * 10000) / 100);
}
function toIntervals(rollouts) {
  const out = []; if (!Array.isArray(rollouts)) return out;
  for (const r of rollouts) {
    if (Array.isArray(r) && r.length >= 2) { out.push([Number(r[0]), Number(r[1])]); continue; }
    if (r && typeof r === 'object') {
      const a = r.start ?? r.s, b = r.end ?? r.e;
      if (a != null && b != null) out.push([Number(a), Number(b)]);
    }
  }
  return out;
}
function isRecent(id) {
  const m = String(id).match(/^(20\d{2})/);
  return m ? Number(m[1]) >= YEAR_MIN : false;
}
function tLabel(b) {
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Treatment ' + b;
}

function parsePopulations(pops) {
  const byB = new Map(), details = [];
  if (!Array.isArray(pops)) return { treatments: [], details };
  for (const pop of pops) {
    if (!Array.isArray(pop)) continue;
    const positions = pop[0] || [];
    const filters = pop[1] || [];
    const dt = [];
    for (const pos of positions) {
      if (!Array.isArray(pos)) continue;
      const bucket = pos[0];
      const ranges = pos[1] || [];
      const iv = toIntervals(ranges);
      const pct = intervalsToPct(iv);
      const label = tLabel(bucket);
      dt.push({ bucket, label, pct });
      if (!byB.has(bucket)) byB.set(bucket, { bucket, label, intervals: [] });
      byB.get(bucket).intervals.push(...iv);
    }
    details.push({ filters: filters.length ? String(filters.length) + ' filter(s)' : null, treatments: dt });
  }
  const treatments = [...byB.values()]
    .map((t) => ({ bucket: t.bucket, label: t.label, pct: intervalsToPct(t.intervals) }))
    .sort((a, b) => (a.bucket ?? 9999) - (b.bucket ?? 9999));
  return { treatments, details };
}

function countOverrides(ovs) {
  let ov = 0;
  if (!Array.isArray(ovs)) return 0;
  for (const o of ovs) {
    if (Array.isArray(o)) ov += (o[1] || []).length || 0;
    else if (o && typeof o === 'object') ov += (o.ids || o.k || []).length || 0;
  }
  return ov;
}

function fromWire(tuple, hashMap) {
  if (typeof decodeGuildExperiment === 'function') {
    try {
      const d = decodeGuildExperiment(tuple, hashMap);
      if (d) return d;
    } catch (_) {}
  }
  if (!Array.isArray(tuple) || tuple.length < 4) return null;
  const hash = tuple[0];
  const key = tuple[1];
  const rev = tuple[2];
  const pops = tuple[3] || [];
  const ovs = tuple[4] || [];
  let id =
    (typeof key === 'string' && key.trim() && key) ||
    hashMap.get(Number(hash)) ||
    hashMap.get(String(hash)) ||
    ('hash:' + hash);
  const { treatments, details } = parsePopulations(pops);
  const ov = countOverrides(ovs);
  const fingerprint =
    treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(1)).join(',') +
    '|ov:' + ov + '|pops:' + pops.length + '|rev:' + rev;
  return {
    id: String(id),
    type: 'guild',
    title: String(id),
    treatments,
    populations: details,
    overrideIdCount: ov,
    populationCount: pops.length,
    fingerprint,
    revision: rev,
    hash: Number(hash),
    recent: isRecent(id),
    source: 'discord',
  };
}


/** User assignment from GET /experiments → assignments[]
 * [hash, revision, bucket, override, population, hash_result, aa_mode, trigger_debugging, holdout_name?, ...]
 * Discord does NOT expose global user % here — only this account's bucket.
 * We still track revision/bucket changes; global user % comes from workers/fallback.
 */
function fromUserAssignment(tuple, hashMap) {
  if (!Array.isArray(tuple) || tuple.length < 3) return null;
  const hash = tuple[0];
  const revision = tuple[1];
  const bucket = tuple[2];
  const override = tuple[3];
  const population = tuple[4];
  const hashResult = tuple[5];
  const holdout = typeof tuple[8] === 'string' ? tuple[8] : null;
  let id =
    hashMap.get(Number(hash)) ||
    hashMap.get(String(hash)) ||
    (holdout && String(holdout)) ||
    ('hash:' + hash);
  const label = tLabel(bucket);
  const treatments = [{ bucket, label, pct: null, assigned: true }];
  const fingerprint =
    'user|b:' +
    bucket +
    '|rev:' +
    revision +
    '|pop:' +
    population +
    '|hr:' +
    hashResult +
    '|ov:' +
    override;
  return {
    id: String(id),
    type: 'user',
    title: String(id),
    treatments,
    populations: [],
    overrideIdCount: override === 0 ? 1 : 0,
    populationCount: 0,
    fingerprint,
    revision,
    hash: Number(hash),
    hashResult: hashResult != null ? Number(hashResult) : null,
    assignedBucket: bucket,
    recent: isRecent(id),
    source: 'discord-assignment',
    // no global % available from API for user experiments
    hasGlobalPct: false,
  };
}

/** advaith shape: { data: { id, type, title, hash }, rollout: [hash, key, rev, pops, ovs, ...] } */
function fromAdvaith(raw, hashMap) {
  if (!raw || !raw.data) return null;
  const id = String(raw.data.id || '');
  if (!id) return null;
  const title = String(raw.data.title || id).slice(0, 200);
  const type = String(raw.data.type || 'guild').toLowerCase();
  const rollout = raw.rollout;
  if (Array.isArray(rollout) && rollout.length >= 4) {
    const e = fromWire(rollout, hashMap);
    if (e) {
      e.id = id;
      e.title = title;
      e.type = type;
      e.recent = isRecent(id);
      e.source = 'advaith';
      e.hash = raw.data.hash != null ? Number(raw.data.hash) : e.hash;
      return e;
    }
  }
  return {
    id,
    type,
    title,
    treatments: [],
    populations: [],
    overrideIdCount: 0,
    populationCount: 0,
    fingerprint: 'empty',
    revision: null,
    hash: raw.data.hash != null ? Number(raw.data.hash) : null,
    recent: isRecent(id),
    source: 'advaith',
  };
}

function fromObject(raw) {
  if (!raw || !raw.id) return null;
  const id = String(raw.id);
  const type = String(raw.type || 'unknown').toLowerCase();
  const title = String(raw.title || raw.name || id).slice(0, 200);
  const rollout = raw.rollout || {};
  let pops = Array.isArray(rollout.populations) ? rollout.populations : [];
  // wire-style nested under rollout array
  if (Array.isArray(raw.rollout) && raw.rollout.length >= 4) {
    const e = fromWire(raw.rollout, new Map());
    if (e) {
      e.id = id; e.title = title; e.type = type; e.recent = isRecent(id); e.source = 'object';
      return e;
    }
  }
  const byB = new Map(), details = [];
  for (const pop of pops) {
    if (pop && !Array.isArray(pop)) {
      const buckets = pop.buckets || pop.positions || [];
      const dt = [];
      for (const pos of buckets) {
        const bucket = pos.bucket;
        const iv = toIntervals(pos.rollouts || pos.ranges || []);
        const pct = intervalsToPct(iv);
        const label = pos.treatment || tLabel(bucket);
        dt.push({ bucket, label, pct });
        if (!byB.has(bucket)) byB.set(bucket, { bucket, label, intervals: [] });
        byB.get(bucket).intervals.push(...iv);
      }
      details.push({ filters: null, treatments: dt });
      continue;
    }
    if (Array.isArray(pop)) {
      const positions = pop[0] || [];
      const dt = [];
      for (const pos of positions) {
        if (!Array.isArray(pos)) continue;
        const bucket = pos[0];
        const iv = toIntervals(pos[1] || []);
        const pct = intervalsToPct(iv);
        const label = tLabel(bucket);
        dt.push({ bucket, label, pct });
        if (!byB.has(bucket)) byB.set(bucket, { bucket, label, intervals: [] });
        byB.get(bucket).intervals.push(...iv);
      }
      details.push({ filters: null, treatments: dt });
    }
  }
  const treatments = [...byB.values()].map((t) => ({
    bucket: t.bucket,
    label: t.label,
    pct: intervalsToPct(t.intervals),
  }));
  const ovs = rollout.overrides || [];
  const ov = Array.isArray(ovs) ? ovs.reduce((n, o) => n + ((o.ids || o.k || []).length || 0), 0) : 0;
  const fingerprint =
    treatments.map((t) => (t.bucket != null ? t.bucket : t.label) + ':' + Number(t.pct).toFixed(1)).join(',') +
    '|ov:' + ov + '|pops:' + pops.length;
  return {
    id,
    type,
    title,
    treatments,
    populations: details,
    overrideIdCount: ov,
    populationCount: pops.length,
    fingerprint,
    revision: rollout.revision ?? null,
    hash: raw.hash ?? null,
    recent: isRecent(id),
    source: 'object',
    hasGlobalPct: treatments.some((x) => x.pct != null && Number.isFinite(x.pct)),
  };
}

async function buildHashMap() {
  const map = new Map();
  const addId = (id) => {
    if (!id || typeof id !== 'string') return;
    const clean = id.trim();
    if (!clean) return;
    const h = murmur3(clean);
    map.set(h, clean);
    map.set(String(h), clean);
  };
  for (const file of [LOCAL_EXP, APEX_LOCAL, KNOWN_EXP]) {
    try {
      if (!(await fs.pathExists(file))) continue;
      const data = await fs.readJson(file);
      const list = Array.isArray(data) ? data : data.experiments || data.ids || [];
      for (const x of list) {
        if (typeof x === 'string') addId(x);
        else if (x && (x.id || x.name)) addId(String(x.id || x.name));
      }
    } catch (e) {
      console.warn('Hash map', path.basename(file) + ':', e.message);
    }
  }
  try {
    const res = await fetch(WUMPUS_DEFS, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeout: 20000,
    });
    if (res.ok) {
      const data = await res.json();
      let n = 0;
      for (const e of Array.isArray(data) ? data : []) {
        if (e && (e.id || e.name)) {
          addId(String(e.id || e.name));
          n++;
        }
      }
      console.log('Defs gist:', n, 'ids');
    }
  } catch (e) {
    console.warn('Defs gist:', e.message);
  }
  console.log('Hash map:', Math.floor(map.size / 2), 'ids');
  return map;
}

function discordClientHeaders(withToken) {
  const superProps = Buffer.from(
    JSON.stringify({
      os: 'Windows',
      browser: 'Chrome',
      device: '',
      system_locale: 'en-US',
      browser_user_agent: UA,
      browser_version: '131.0.0.0',
      os_version: '10',
      referrer: '',
      referring_domain: '',
      release_channel: 'canary',
      client_build_number: 609601,
      client_event_source: null,
    }),
  ).toString('base64');
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Super-Properties': superProps,
    'X-Discord-Locale': 'en-US',
    Origin: 'https://canary.discord.com',
    Referer: 'https://canary.discord.com/channels/@me',
  };
  const tok = typeof withToken === 'string' ? withToken : (withToken ? DISCORD_TOKEN : '');
  if (tok) headers.Authorization = tok;
  return headers;
}

async function fetchDiscordOnce(url, headers, hashMap, label) {
  const res = await fetch(url, { headers, timeout: 30000 });
  if (!res.ok) {
    console.warn('Discord', res.status, label, url);
    return { guild: [], user: [] };
  }
  const data = await res.json();
  const ge = data.guild_experiments || [];
  const asg = data.assignments || [];
  console.log('Discord guild_experiments:', ge.length, '(' + label + ')');
  console.log('Discord user assignments:', asg.length, '(' + label + ')');
  const guild = ge.map((t) => fromWire(t, hashMap)).filter(Boolean);
  const user = asg.map((t) => fromUserAssignment(t, hashMap)).filter(Boolean);
  console.log(
    '  guild sample:',
    guild.map((e) => e.id).slice(0, 8).join(', ') || '(none)',
  );
  console.log(
    '  user sample:',
    user.map((e) => e.id + '@b' + e.assignedBucket).slice(0, 8).join(', ') || '(none)',
  );
  console.log(
    '  recent guild/user ≥' + YEAR_MIN + ':',
    guild.filter((e) => e.recent).length,
    '/',
    user.filter((e) => e.recent).length,
  );
  return { guild, user };
}

// Live Discord: client headers + multi user tokens
// Guild = global % (same for all). User = per-account bucket → aggregate across tokens.
async function fetchDiscord(hashMap) {
  const urls = [
    'https://canary.discord.com/api/v9/experiments?with_guild_experiments=true',
    'https://discord.com/api/v9/experiments?with_guild_experiments=true',
  ];
  const byKey = new Map();
  // hash -> { id, buckets: Map(bucket -> count), revision, samples }
  const userAgg = new Map();

  const ingest = (list) => {
    for (const e of list) {
      if (!e) continue;
      if (e.source === 'discord-assignment' || e.type === 'user') {
        const hk = e.hash != null ? String(e.hash) : e.id;
        let ag = userAgg.get(hk);
        if (!ag) {
          ag = {
            id: e.id,
            hash: e.hash,
            revision: e.revision,
            buckets: new Map(),
            hrs: new Map(),
            samples: 0,
            recent: e.recent,
            title: e.title,
            contributors: [],
          };
          userAgg.set(hk, ag);
        }
        if (String(ag.id).startsWith('hash:') && !String(e.id).startsWith('hash:')) {
          ag.id = e.id;
          ag.title = e.title || e.id;
        }
        const bkt = e.assignedBucket;
        if (bkt != null) {
          ag.buckets.set(bkt, (ag.buckets.get(bkt) || 0) + 1);
          if (e.hashResult != null && Number.isFinite(Number(e.hashResult))) {
            if (!ag.hrs.has(bkt)) ag.hrs.set(bkt, []);
            ag.hrs.get(bkt).push(Number(e.hashResult));
          }
        }
        ag.samples++;
        if (e.revision != null) ag.revision = e.revision;
        continue;
      }
      const key = (e.type || 'x') + ':' + (e.hash != null ? String(e.hash) : e.id);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, e);
        continue;
      }
      const prevHashId = String(prev.id).startsWith('hash:');
      const nextHashId = String(e.id).startsWith('hash:');
      if (prevHashId && !nextHashId) byKey.set(key, e);
      else if ((e.treatments || []).length > (prev.treatments || []).length) byKey.set(key, e);
    }
  };

  // anonymous client (guild list)
  for (const url of urls) {
    try {
      const { guild, user } = await fetchDiscordOnce(
        url,
        discordClientHeaders(false),
        hashMap,
        'client',
      );
      ingest(guild);
      ingest(user);
      break;
    } catch (e) {
      console.warn('Discord client fail', e.message);
    }
  }

  // multi-token
  console.log('User tokens loaded:', USER_TOKENS.length);
  for (let i = 0; i < USER_TOKENS.length; i++) {
    const tok = USER_TOKENS[i];
    let ok = false;
    for (const url of urls) {
      try {
        const { guild, user } = await fetchDiscordOnce(
          url,
          discordClientHeaders(tok),
          hashMap,
          'token#' + (i + 1),
        );
        ingest(guild);
        ingest(user);
        ok = true;
        break;
      } catch (e) {
        console.warn('Discord token#' + (i + 1) + ' fail', e.message);
      }
    }
    if (!ok) console.warn('token#' + (i + 1) + ' no response');
    // small pause between tokens
    await new Promise((r) => setTimeout(r, 350));
  }

  // build aggregated user entries — crowd method (Escoteiros/Wumpus Apex research)
  for (const ag of userAgg.values()) {
    const total = Math.max(1, ag.samples);
    const treatments = [];
    const bucketKeys = new Set([...ag.buckets.keys(), ...(ag.hrs ? ag.hrs.keys() : [])]);
    for (const bucket of [...bucketKeys].sort((x, y) => x - y)) {
      const n = ag.buckets.get(bucket) || 0;
      const hrs = (ag.hrs && ag.hrs.get(bucket)) || [];
      let pct = Math.round((n / total) * 1000) / 10;
      let range = null;
      if (hrs.length >= 1) {
        const mn = Math.min(...hrs);
        const mx = Math.max(...hrs);
        const start = Math.round(mn / 500) * 500;
        const end = Math.min(SCALE, Math.round(mx / 500) * 500 || mx);
        range = [start, end];
        if (hrs.length >= 2 || total >= 2) {
          const span = Math.max(0, end - start);
          pct = Math.min(100, Math.round((span / SCALE) * 10000) / 100);
        }
        if (hrs.length === 1 && total === 1) pct = null;
      } else if (total < 2) {
        pct = null;
      }
      treatments.push({
        bucket,
        label: tLabel(bucket),
        pct,
        range,
        samples: Math.max(n, hrs.length),
        assigned: true,
      });
    }
    const fingerprint =
      'user-crowd|' +
      treatments
        .map((t) => t.bucket + ':' + (t.pct != null ? Number(t.pct).toFixed(1) : 'x') + (t.range ? '@' + t.range.join('-') : ''))
        .join(',') +
      '|n:' +
      total +
      '|rev:' +
      ag.revision;
    byKey.set('user:' + (ag.hash != null ? ag.hash : ag.id), {
      id: String(ag.id),
      type: 'user',
      title: String(ag.title || ag.id),
      treatments,
      populations: [],
      overrideIdCount: 0,
      populationCount: 0,
      fingerprint,
      revision: ag.revision,
      hash: ag.hash,
      recent: !!ag.recent,
      source: 'apex-crowd',
      hasGlobalPct: treatments.some((t) => t.pct != null && Number.isFinite(t.pct)),
      sampleCount: total,
    });
  }

  const out = [...byKey.values()];
  const u = out.filter((e) => e.type === 'user').length;
  const g = out.filter((e) => e.type === 'guild').length;
  console.log(
    'Discord merged unique:',
    out.length,
    '(user',
    u,
    '/ guild',
    g + ')',
    'recent',
    out.filter((e) => e.recent).length,
    'tokens',
    USER_TOKENS.length,
  );
  return out;
}

async function fetchAdvaith(hashMap) {
  // Direct API is often CF 403 from GitHub Actions. Try mirrors/proxies.
  // Wumpus-style live guild % (incl. 2026-08-profile-read-state-v1, quest gates)
  // come from this dataset — without it we only see ~16 Discord public rollouts.
  const urls = [
    ADVAITH,
    process.env.APEX_ADVAITH_MIRROR || '',
    process.env.APEX_ADVAITH_PROXY || '',
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(ADVAITH),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(ADVAITH + '/'),
  ].filter(Boolean);

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    Referer: 'https://rollouts.advaith.io/',
    Origin: 'https://rollouts.advaith.io',
  };

  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, timeout: 50000 });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let data = await res.json();
      // allorigins sometimes wraps
      if (data && !Array.isArray(data) && Array.isArray(data.contents)) {
        try {
          data = JSON.parse(data.contents);
        } catch (_) {}
      }
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (_) {
          throw new Error('not json');
        }
      }
      if (!Array.isArray(data)) throw new Error('not array');
      if (!data.length) throw new Error('empty');
      const list = data.map((r) => fromAdvaith(r, hashMap)).filter(Boolean);
      if (!list.length) throw new Error('parsed 0');
      const recentN = list.filter((e) => e.recent).length;
      console.log(
        'advaith:',
        list.length,
        'recent',
        recentN,
        'via',
        url.startsWith(ADVAITH) ? 'direct' : url.includes('allorigins') ? 'allorigins' : 'mirror',
      );
      const want = ['profile-read-state', 'quest-home-bounties'];
      for (const w of want) {
        const hit = list.find((e) => String(e.id).includes(w));
        if (hit)
          console.log(
            '  hit',
            hit.id,
            (hit.treatments || []).map((t) => t.label + '=' + t.pct + '%').join(', '),
          );
      }
      if (list.length) console.log('advaith sample:', list.slice(0, 5).map((e) => e.id).join(', '));
      return list;
    } catch (e) {
      lastErr = e;
      console.warn('advaith try fail:', (url || '').slice(0, 60), e.message);
    }
  }
  console.warn('advaith fail (all mirrors):', lastErr && lastErr.message);
  console.warn(
    'Tip: set secret APEX_ADVAITH_MIRROR to a JSON mirror of api.rollouts.advaith.io (Wumpus source).',
  );
  return [];
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 45000 });
  if (!res.ok) throw new Error(url + ' → ' + res.status);
  return res.json();
}
function asArr(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.experiments)) return d.experiments;
  return [];
}

async function loadExperiments() {
  const hashMap = await buildHashMap();
  const sources = {
    discord: 0,
    advaith: 0,
    workers: 0,
    fallback: 0,
    merged: 0,
    recent: 0,
    user: 0,
    guild: 0,
    hasToken: USER_TOKENS.length > 0,
    tokenCount: USER_TOKENS.length,
  };
  const byId = new Map();

  // 1) Live Discord — guild wire (global %) + user assignments (bucket only)
  try {
    const live = await fetchDiscord(hashMap);
    sources.discord = live.length;
    for (const e of live) byId.set(e.id, e);
  } catch (e) {
    console.warn(e.message);
  }

  // 2) advaith live guild rollouts (best source for 2024–2026 names + %)
  try {
    const adv = await fetchAdvaith(hashMap);
    sources.advaith = adv.length;
    for (const e of adv) {
      // advaith = best live guild % source (Wumpus uses this)
      const prev = byId.get(e.id);
      if (!prev) {
        byId.set(e.id, e);
        continue;
      }
      const prevPct = (prev.treatments || []).some((t) => t && t.pct != null);
      const nextPct = (e.treatments || []).some((t) => t && t.pct != null);
      if (nextPct && (!prevPct || e.source === 'advaith')) byId.set(e.id, e);
      else if (String(prev.id).startsWith('hash:')) byId.set(e.id, e);
      else if (e.recent && !prev.recent) byId.set(e.id, e);
    }
  } catch (e) {
    console.warn(e.message);
  }

  // 3) Stale public APIs — only fill gaps, never overwrite live recent
  for (const [label, url] of [
    ['workers', WORKERS],
    ['fallback', FALLBACK],
  ]) {
    try {
      const arr = asArr(await fetchJson(url));
      sources[label] = arr.length;
      let added = 0;
      for (const raw of arr) {
        const n = fromObject(raw);
        if (!n) continue;
        const prev = byId.get(n.id);
        if (prev) {
          // Upgrade assignment-only user entry with global % from workers/fallback
          if (
            prev.source === 'discord-assignment' &&
            n.hasGlobalPct &&
            (n.type === 'user' || n.type === 'guild')
          ) {
            n.assignedBucket = prev.assignedBucket;
            byId.set(n.id, n);
            added++;
          }
          continue; // never replace richer live guild wire / advaith
        }
        byId.set(n.id, n);
        added++;
      }
      console.log(label + ':', arr.length, 'new', added);
    } catch (e) {
      console.warn(label, e.message);
    }
  }

  let experiments = [...byId.values()];
  experiments.sort(
    (a, b) => (a.recent === b.recent ? 0 : a.recent ? -1 : 1) || String(b.id).localeCompare(String(a.id))
  );
  sources.merged = experiments.length;
  sources.recent = experiments.filter((e) => e.recent).length;
  sources.user = experiments.filter((e) => e.type === 'user').length;
  sources.guild = experiments.filter((e) => e.type === 'guild').length;

  if (!USER_TOKENS.length) console.warn('⚠️ Aucun token (DISCORD_USER_TOKENS / DISCORD_USER_TOKEN)');
  if (sources.advaith === 0 && sources.recent === 0)
    console.warn('⚠️ Peu de rollouts récents — advaith KO ou Cloudflare');
  console.log(
    'Types: user',
    sources.user,
    'guild',
    sources.guild,
    'with global %',
    experiments.filter((e) => e.hasGlobalPct).length,
  );

  return { experiments, sources };
}

function pctKey(e) {
  return (e.treatments || [])
    .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
    .map((t) => String(t.bucket ?? t.label) + ':' + Number(t.pct).toFixed(1))
    .sort()
    .join('|');
}
function isLiveGuild(e) {
  return e && (e.source === 'discord' || e.source === 'advaith') && e.type !== 'user';
}
function isLiveRollout(e) {
  if (!e || !e.id) return false;
  if (String(e.id).startsWith('hash:')) return false;
  if (isLiveGuild(e)) return true;
  if (e.type === 'user' && (e.source === 'apex-crowd' || e.source === 'discord-assignment')) {
    return !!(e.hasGlobalPct && (e.sampleCount || 0) >= 2);
  }
  return false;
}
/** Guild exact % + user crowd hash_result ranges */
function diffExperiments(prev, next) {
  const pMap = new Map(prev.map((e) => [e.id, e]));
  const nMap = new Map(next.map((e) => [e.id, e]));
  const added = [], removed = [], changed = [];
  for (const [id, n] of nMap) {
    if (!isLiveRollout(n)) continue;
    const treatments = (n.treatments || []).filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)));
    if (!treatments.length) continue;
    const p = pMap.get(id);
    if (!p) {
      // new live guild with real %
      if (treatments.some((t) => Number(t.pct) > 0))
        added.push(n);
      continue;
    }
    if (pctKey(p) === pctKey(n)) continue;
    const deltas = [];
    const pt = new Map((p.treatments || []).map((t) => [String(t.bucket ?? t.label), t]));
    for (const t of treatments) {
      const k = String(t.bucket ?? t.label);
      const old = pt.get(k);
      const from = old && old.pct != null ? Number(old.pct) : 0;
      const to = Number(t.pct);
      const d = Math.round((to - from) * 10) / 10;
      if (Math.abs(d) >= MIN_DELTA)
        deltas.push({ label: t.label, bucket: t.bucket, from, to, delta: d });
    }
    for (const t of p.treatments || []) {
      if (t.pct == null || !Number.isFinite(Number(t.pct))) continue;
      const k = String(t.bucket ?? t.label);
      if (!treatments.some((x) => String(x.bucket ?? x.label) === k) && Math.abs(Number(t.pct)) >= MIN_DELTA)
        deltas.push({ label: t.label, bucket: t.bucket, from: Number(t.pct), to: 0, delta: -Number(t.pct) });
    }
    if (!deltas.length) continue;
    const maxAbs = deltas.reduce((m, x) => Math.max(m, Math.abs(x.delta)), 0);
    changed.push({ before: p, after: n, deltas, ovDelta: null, maxAbs });
  }
  for (const [id, p] of pMap) {
    if (nMap.has(id)) continue;
    if (!isLiveRollout(p)) continue;
    if (p.recent || isRecent(p.id)) removed.push(p);
  }
  changed.sort((a, b) => b.maxAbs - a.maxAbs);
  return { added, removed, changed };
}

function fmtTreat(ts, max = 10) {
  const lines = (ts || []).slice(0, max).map((t) => {
    let s = '• **' + (t.label || 'Bucket ' + t.bucket) + '** · `' + (t.pct != null ? t.pct + '%' : '?') + '`';
    if (t.range && Array.isArray(t.range)) s += ' `(' + t.range[0] + ' - ' + t.range[1] + ')`';
    return s;
  });
  if ((ts || []).length > max) lines.push('_+' + (ts.length - max) + ' autres_');
  return lines.join('\n') || '_—_';
}

function buildEmbeds(diff, stats) {
  const embeds = [];
  for (const e of diff.added.slice(0, 8)) {
    embeds.push({
      title: '+ ' + e.id,
      description: ['**' + e.title + '**', 'Type · `' + e.type + '`' + (e.recent ? ' · récent' : ''), '', fmtTreat(e.treatments)]
        .join('\n')
        .slice(0, 4000),
      color: 0x57f287,
      footer: { text: 'Nouveau rollout · ' + (e.source || '') },
    });
  }
  for (const c of diff.changed.slice(0, 10)) {
    const e = c.after;
    const lines = c.deltas
      .slice(0, 12)
      .map(
        (d) =>
          '• **' +
          (d.label || 'bucket') +
          '** · `' +
          d.from +
          '%` → `' +
          d.to +
          '%` (`' +
          (d.delta > 0 ? '+' : '') +
          d.delta +
          '`)'
      );
    if (c.ovDelta) lines.push('• Overrides · `' + c.ovDelta.from + '` → `' + c.ovDelta.to + '`');
    embeds.push({
      title: '~ ' + e.id,
      description: ['**' + e.title + '**', 'Type · `' + e.type + '`' + (e.recent ? ' · récent' : ''), '', lines.join('\n')]
        .join('\n')
        .slice(0, 4000),
      color: 0xe67e22,
      footer: { text: 'Δ max ' + c.maxAbs + '%' },
    });
  }
  for (const e of diff.removed.slice(0, 4)) {
    embeds.push({
      title: '- ' + e.id,
      description: '**' + e.title + '** · `' + e.type + '`',
      color: 0xed4245,
      footer: { text: 'Retiré' },
    });
  }
  return embeds.slice(0, 10);
}

async function postWebhook(embeds) {
  if (!WEBHOOK) return { ok: false, status: 0, text: 'no webhook' };
  let last = { ok: true, status: 204, text: '' };
  for (let i = 0; i < embeds.length; i += 10) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: BOT, avatar_url: AVATAR, embeds: embeds.slice(i, i + 10) }),
    });
    const text = await res.text().catch(() => '');
    last = { ok: res.ok, status: res.status, text: text.slice(0, 300) };
    if (!res.ok) return last;
    await new Promise((r) => setTimeout(r, 450));
  }
  return last;
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('📊 Apex rollouts v4.4 (multi-token + anti-spam)…');
  console.log('Webhook:', WEBHOOK ? 'set' : 'MISSING');
  console.log('Tokens:', USER_TOKENS.length ? USER_TOKENS.length + ' set' : 'MISSING');
  const { experiments, sources } = await loadExperiments();
  console.log('Merged:', experiments.length, sources);
  let previous = { experiments: [], announced: {} };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {}
  }
  const prev = previous.experiments || [];
  const announced = previous.announced && typeof previous.announced === 'object' ? { ...previous.announced } : {};
  // rebuild announced from prev fingerprints if empty
  if (!Object.keys(announced).length) {
    for (const e of prev) {
      if (e && e.id) announced[e.id] = e.fingerprint || pctKey(e);
    }
  }
  const isFirst = !prev.length;
  let diff = isFirst ? { added: [], removed: [], changed: [] } : diffExperiments(prev, experiments);

  // Anti-spam: drop anything whose pct fingerprint was already announced
  const filterAnnounced = (list, getId, getKey) =>
    list.filter((item) => {
      const id = getId(item);
      const key = getKey(item);
      if (!id || !key) return false;
      if (announced[id] === key) return false;
      return true;
    });

  if (!isFirst) {
    diff = {
      added: filterAnnounced(diff.added, (e) => e.id, (e) => pctKey(e)),
      changed: filterAnnounced(
        diff.changed,
        (c) => c.after && c.after.id,
        (c) => pctKey(c.after),
      ),
      removed: diff.removed.filter((e) => e && e.id && announced[e.id] !== 'REMOVED'),
    };
  }

  console.log('Diff', {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    first: isFirst,
    announcedKeys: Object.keys(announced).length,
  });

  // State: live guild only (stable % keys)
  const compact = experiments
    .filter((e) => e && (e.source === 'discord' || e.source === 'advaith') && e.type !== 'user')
    .map((e) => ({
      id: e.id,
      type: e.type || 'guild',
      title: e.title,
      fingerprint: pctKey(e),
      treatments: (e.treatments || [])
        .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
        .map((t) => ({ bucket: t.bucket, label: t.label, pct: Math.round(Number(t.pct) * 10) / 10 })),
      overrideIdCount: e.overrideIdCount || 0,
      revision: e.revision,
      recent: !!e.recent,
      hash: e.hash,
      source: e.source,
    }));

  // Mark announced for everything we are about to send + current state
  for (const e of compact) {
    if (e.id && e.fingerprint) announced[e.id] = e.fingerprint;
  }
  for (const e of diff.added) {
    if (e && e.id) announced[e.id] = pctKey(e);
  }
  for (const c of diff.changed) {
    if (c && c.after && c.after.id) announced[c.after.id] = pctKey(c.after);
  }
  for (const e of diff.removed) {
    if (e && e.id) announced[e.id] = 'REMOVED';
  }

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      sources,
      count: compact.length,
      experiments: compact,
      announced,
    },
    { spaces: 2 },
  );

  if (isFirst) {
    console.log('Seed', compact.length, '· recent', sources.recent, '· no notify');
    return;
  }
  if (!(diff.added.length || diff.changed.length || diff.removed.length)) {
    console.log('No significant % change (anti-spam)');
    return;
  }
  if (!WEBHOOK) {
    console.warn('No webhook');
    return;
  }
  const sent = await postWebhook(buildEmbeds(diff, { sources }));
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);
  console.log('✅ Done');
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
module.exports = { main, murmur3, intervalsToPct, diffExperiments, loadUserTokens };
