/**
 * Apex rollouts v5 — exact Discord guild % (Wumpus method) + optional advaith cache
 *
 * Reality (2026):
 *  - Discord GET /experiments?with_guild_experiments=true returns ~6 guild experiments
 *    with EXACT population ranges → real %. Same as Wumpus-Central/guild-experiments.
 *  - Full catalog with partial user/guild % historically comes from api.rollouts.advaith.io
 *    which is Cloudflare-blocked from GitHub Actions. Put a copy in data/advaith_cache.json
 *    (run scripts/sync_advaith.py on your PC/bot host where the API works).
 *  - User assignments from tokens = per-account bucket only, not global %.
 *
 * Secrets: DISCORD_USER_TOKENS (comma) or DISCORD_USER_TOKEN / _1.._5
 *          APEX_WEBHOOK_URL (or ROLLOUT_WEBHOOK_URL / DISCORD_WEBHOOK_URL)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'apex_rollouts.json');
const ADVAITH_CACHE = path.join(DATA_DIR, 'advaith_cache.json');
const LOCAL_EXP = path.join(DATA_DIR, 'experiments.json');
const KNOWN_EXP = path.join(DATA_DIR, 'known_experiment_ids.json');
const DEFS_URL =
  process.env.APEX_DEFS_URL ||
  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';

const WEBHOOK =
  process.env.APEX_WEBHOOK_URL ||
  process.env.ROLLOUT_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;
const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/assets/datamining-avatar.svg';
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || '1');
const YEAR_MIN = Number(process.env.APEX_RECENT_YEAR || '2024');
const SCALE = 10000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function loadUserTokens() {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const s = String(t || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const part of String(process.env.DISCORD_USER_TOKENS || '').split(/[,;\n]+/)) push(part);
  for (let i = 1; i <= 10; i++) push(process.env['DISCORD_USER_TOKEN_' + i]);
  push(process.env.DISCORD_USER_TOKEN);
  push(process.env.DISCORD_TOKEN);
  return out;
}
const USER_TOKENS = loadUserTokens();

function murmur3(key, seed = 0) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51,
    c2 = 0x1b873593;
  const bytes = Buffer.from(String(key), 'utf8');
  const len = bytes.length,
    nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k1 =
      bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
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

function isRecent(id) {
  const m = String(id).match(/^(20\d{2})/);
  return m ? Number(m[1]) >= YEAR_MIN : false;
}

function tLabel(b) {
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Treatment ' + b;
}

/** Merge rollout intervals → percent of 0..10000 space */
function rangesToPct(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return 0;
  const iv = [];
  for (const r of ranges) {
    let a, b;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      a = Number(r.s ?? r.start);
      b = Number(r.e ?? r.end);
    } else if (Array.isArray(r) && r.length >= 2) {
      a = Number(r[0]);
      b = Number(r[1]);
    } else continue;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    iv.push([a, b]);
  }
  if (!iv.length) return 0;
  iv.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [iv[0].slice()];
  for (let i = 1; i < iv.length; i++) {
    const [a, b] = iv[i];
    const L = merged[merged.length - 1];
    if (a <= L[1]) L[1] = Math.max(L[1], b);
    else merged.push([a, b]);
  }
  let c = 0;
  for (const [a, b] of merged) c += b - a;
  return Math.min(100, Math.round((c / SCALE) * 1000) / 10);
}

/**
 * Wumpus-style decode of guild experiment wire tuple:
 * [hash, key|null, revision, populations, overrides, overridesFormatted?, ..., aaMode]
 * population = [ [ [bucket, ranges[]], ... ], filters[] ]
 * range = {s,e} or [s,e]
 */
function decodeGuildWire(tuple, hashMap) {
  if (!Array.isArray(tuple) || tuple.length < 4) return null;
  const hash = tuple[0];
  const key = tuple[1];
  const revision = tuple[2];
  const pops = tuple[3] || [];
  const ovs = tuple[4] || [];

  let id =
    (typeof key === 'string' && key.trim() && key) ||
    hashMap.get(Number(hash)) ||
    hashMap.get(String(hash)) ||
    'hash:' + hash;

  const byBucket = new Map();
  const filterNotes = [];

  for (const pop of pops) {
    if (!Array.isArray(pop)) continue;
    const positions = pop[0] || [];
    const filters = pop[1] || [];
    if (filters.length) filterNotes.push(filters.length + ' filter(s)');
    for (const pos of positions) {
      if (!Array.isArray(pos)) continue;
      const bucket = pos[0];
      const ranges = pos[1] || [];
      const pct = rangesToPct(ranges);
      if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket, label: tLabel(bucket), intervals: [] });
      // accumulate ranges for global % across populations
      for (const r of ranges) {
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          byBucket.get(bucket).intervals.push([Number(r.s ?? r.start), Number(r.e ?? r.end)]);
        } else if (Array.isArray(r) && r.length >= 2) {
          byBucket.get(bucket).intervals.push([Number(r[0]), Number(r[1])]);
        }
      }
      // also store per-pop pct for display
      byBucket.get(bucket)._lastPct = pct;
    }
  }

  const treatments = [...byBucket.values()]
    .map((t) => ({
      bucket: t.bucket,
      label: t.label,
      pct: rangesToPct(t.intervals.map(([a, b]) => ({ s: a, e: b }))),
    }))
    .sort((a, b) => (a.bucket ?? 9999) - (b.bucket ?? 9999));

  let ovCount = 0;
  if (Array.isArray(ovs)) {
    for (const o of ovs) {
      if (o && typeof o === 'object') ovCount += (o.k || o.ids || []).length || 0;
      else if (Array.isArray(o)) ovCount += (o[1] || []).length || 0;
    }
  }

  const fingerprint = treatments
    .map((t) => t.bucket + ':' + Number(t.pct).toFixed(1))
    .join('|');

  return {
    id: String(id),
    type: 'guild',
    title: String(id),
    treatments,
    overrideIdCount: ovCount,
    populationCount: pops.length,
    fingerprint,
    revision,
    hash: Number(hash),
    recent: isRecent(id),
    source: 'discord',
    hasGlobalPct: treatments.some((t) => t.pct != null && Number.isFinite(t.pct)),
    filterNotes,
  };
}

/** advaith / cache object shape */
function fromAdvaithItem(raw, hashMap) {
  if (!raw || !raw.data) return null;
  const id = String(raw.data.id || '');
  if (!id) return null;
  const title = String(raw.data.title || id).slice(0, 200);
  const type = String(raw.data.type || 'guild').toLowerCase();
  const rollout = raw.rollout;
  if (Array.isArray(rollout) && rollout.length >= 4) {
    const e = decodeGuildWire(rollout, hashMap);
    if (e) {
      e.id = id;
      e.title = title;
      e.type = type === 'user' ? 'user' : 'guild';
      e.recent = isRecent(id);
      e.source = 'advaith-cache';
      e.hash = raw.data.hash != null ? Number(raw.data.hash) : e.hash;
      return e;
    }
  }
  return null;
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
  for (const file of [LOCAL_EXP, KNOWN_EXP]) {
    try {
      if (!(await fs.pathExists(file))) continue;
      const data = await fs.readJson(file);
      const list = Array.isArray(data) ? data : data.experiments || data.ids || [];
      for (const x of list) {
        if (typeof x === 'string') addId(x);
        else if (x && (x.id || x.name)) addId(String(x.id || x.name));
      }
    } catch (_) {}
  }
  try {
    const res = await fetch(DEFS_URL, {
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
      console.log('Defs:', n, 'ids');
    }
  } catch (e) {
    console.warn('Defs:', e.message);
  }
  console.log('Hash map:', Math.floor(map.size / 2), 'ids');
  return map;
}

function clientHeaders(token) {
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
      release_channel: 'stable',
      client_build_number: 360000,
      client_event_source: null,
    }),
  ).toString('base64');
  const h = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Super-Properties': superProps,
    'X-Discord-Locale': 'en-US',
    Origin: 'https://discord.com',
    Referer: 'https://discord.com/channels/@me',
  };
  if (token) h.Authorization = token;
  return h;
}

async function fetchDiscordGuild(hashMap) {
  const urls = [
    'https://discord.com/api/v9/experiments?with_guild_experiments=true',
    'https://canary.discord.com/api/v9/experiments?with_guild_experiments=true',
  ];
  const byId = new Map();
  const tokens = USER_TOKENS.length ? USER_TOKENS : [null];

  console.log('User tokens:', USER_TOKENS.length);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const label = tok ? 'token#' + (i + 1) : 'anon';
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: clientHeaders(tok), timeout: 30000 });
        if (!res.ok) {
          console.warn('Discord', res.status, label);
          continue;
        }
        const data = await res.json();
        const ge = data.guild_experiments || [];
        const asg = data.assignments || [];
        console.log('Discord', label, 'guild_experiments:', ge.length, 'assignments:', asg.length);
        for (const t of ge) {
          const e = decodeGuildWire(t, hashMap);
          if (!e) continue;
          const prev = byId.get(e.id);
          if (!prev || (String(prev.id).startsWith('hash:') && !String(e.id).startsWith('hash:'))) {
            byId.set(e.id, e);
          }
        }
        // assignments: log only — not global %
        if (asg.length) {
          console.log(
            '  assignment sample:',
            asg
              .slice(0, 5)
              .map((a) => (hashMap.get(Number(a[0])) || 'hash:' + a[0]) + '@b' + a[2])
              .join(', '),
          );
        }
        break; // got a response for this token
      } catch (e) {
        console.warn('Discord fail', label, e.message);
      }
    }
    if (tok) await new Promise((r) => setTimeout(r, 300));
  }

  return [...byId.values()];
}

async function loadAdvaithCache(hashMap) {
  if (!(await fs.pathExists(ADVAITH_CACHE))) {
    console.log('Advaith cache: none (data/advaith_cache.json)');
    return [];
  }
  try {
    const data = await fs.readJson(ADVAITH_CACHE);
    const list = Array.isArray(data) ? data : data.experiments || data.rollouts || [];
    const out = list.map((r) => fromAdvaithItem(r, hashMap)).filter(Boolean);
    console.log('Advaith cache:', out.length, 'parsed');
    return out;
  } catch (e) {
    console.warn('Advaith cache read fail:', e.message);
    return [];
  }
}

function pctKey(e) {
  return (e.treatments || [])
    .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
    .map((t) => {
      const b = t.bucket != null ? String(t.bucket) : String(t.label || '');
      return b + ':' + (Math.round(Number(t.pct) * 10) / 10).toFixed(1);
    })
    .sort()
    .join('|');
}

function isNotifiable(e) {
  if (!e || !e.id) return false;
  if (String(e.id).startsWith('hash:')) return false;
  if (!e.hasGlobalPct) return false;
  // Prefer recent; still allow older if real partial % change later via diff
  return true;
}

function diffExperiments(prev, next) {
  const pMap = new Map((prev || []).map((e) => [e.id, e]));
  const nMap = new Map((next || []).map((e) => [e.id, e]));
  const added = [],
    changed = [],
    removed = [];

  for (const [id, n] of nMap) {
    if (!isNotifiable(n)) continue;
    const treatments = (n.treatments || []).filter(
      (t) => t && t.pct != null && Number.isFinite(Number(t.pct)),
    );
    if (!treatments.length) continue;
    const p = pMap.get(id);
    if (!p) {
      // new: only notify if has non-trivial % (not only 0)
      if (treatments.some((t) => Number(t.pct) > 0)) added.push(n);
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
      if (Math.abs(d) >= MIN_DELTA) deltas.push({ label: t.label, bucket: t.bucket, from, to, delta: d });
    }
    for (const t of p.treatments || []) {
      if (t.pct == null || !Number.isFinite(Number(t.pct))) continue;
      const k = String(t.bucket ?? t.label);
      if (!treatments.some((x) => String(x.bucket ?? x.label) === k) && Math.abs(Number(t.pct)) >= MIN_DELTA) {
        deltas.push({ label: t.label, bucket: t.bucket, from: Number(t.pct), to: 0, delta: -Number(t.pct) });
      }
    }
    if (!deltas.length) continue;
    const maxAbs = deltas.reduce((m, x) => Math.max(m, Math.abs(x.delta)), 0);
    changed.push({ before: p, after: n, deltas, maxAbs });
  }

  for (const [id, p] of pMap) {
    if (nMap.has(id)) continue;
    if (!isNotifiable(p)) continue;
    if (p.recent || isRecent(p.id)) removed.push(p);
  }

  changed.sort((a, b) => b.maxAbs - a.maxAbs);
  return { added, changed, removed };
}

function fmtTreat(ts, max = 12) {
  const lines = (ts || []).slice(0, max).map((t) => {
    return '• **' + (t.label || 'Bucket ' + t.bucket) + '** · `' + t.pct + '%`';
  });
  if ((ts || []).length > max) lines.push('_+' + (ts.length - max) + '_');
  return lines.join('\n') || '_—_';
}

function buildEmbeds(diff) {
  const embeds = [];
  for (const e of diff.added.slice(0, 8)) {
    embeds.push({
      title: '+ ' + e.id,
      description: ['**' + e.title + '**', 'Type · `' + e.type + '`', '', fmtTreat(e.treatments)]
        .join('\n')
        .slice(0, 4000),
      color: 0x57f287,
      footer: { text: e.source || 'discord' },
    });
  }
  for (const c of diff.changed.slice(0, 10)) {
    const e = c.after;
    const lines = c.deltas.slice(0, 12).map(
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
        '`)',
    );
    embeds.push({
      title: '~ ' + e.id,
      description: ['**' + e.title + '**', 'Type · `' + e.type + '`', '', lines.join('\n')]
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
  if (!WEBHOOK || !embeds.length) return { ok: false, status: 0, text: 'skip' };
  let last = { ok: true, status: 204, text: '' };
  for (let i = 0; i < embeds.length; i += 10) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: BOT.slice(0, 80),
        avatar_url: AVATAR,
        embeds: embeds.slice(i, i + 10),
      }),
    });
    const text = await res.text().catch(() => '');
    last = { ok: res.ok, status: res.status, text: text.slice(0, 300) };
    if (!res.ok) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('📊 Apex rollouts v5 (Discord exact + optional advaith cache)');
  console.log('Webhook:', WEBHOOK ? 'set' : 'MISSING');
  console.log('Tokens:', USER_TOKENS.length);

  const hashMap = await buildHashMap();
  const fromDiscord = await fetchDiscordGuild(hashMap);
  const fromCache = await loadAdvaithCache(hashMap);

  // Merge: Discord wins over cache for same id (live exact)
  const byId = new Map();
  for (const e of fromCache) byId.set(e.id, e);
  for (const e of fromDiscord) byId.set(e.id, e);
  const experiments = [...byId.values()];

  console.log('Merged', experiments.length, {
    discord: fromDiscord.length,
    advaithCache: fromCache.length,
    withPct: experiments.filter((e) => e.hasGlobalPct).length,
    recent: experiments.filter((e) => e.recent).length,
  });

  let previous = { experiments: [], announced: {} };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (_) {}
  }
  const prev = previous.experiments || [];
  const announced =
    previous.announced && typeof previous.announced === 'object' ? { ...previous.announced } : {};
  if (!Object.keys(announced).length) {
    for (const e of prev) {
      if (e && e.id) announced[e.id] = e.fingerprint || pctKey(e);
    }
  }

  const isFirst = !prev.length;
  let diff = isFirst ? { added: [], changed: [], removed: [] } : diffExperiments(prev, experiments);

  // Anti-spam: drop already-announced same fingerprint
  const filter = (list, getId, getKey) =>
    list.filter((item) => {
      const id = getId(item);
      const key = getKey(item);
      if (!id || !key) return false;
      return announced[id] !== key;
    });

  if (!isFirst) {
    diff = {
      added: filter(diff.added, (e) => e.id, (e) => pctKey(e)),
      changed: filter(diff.changed, (c) => c.after && c.after.id, (c) => pctKey(c.after)),
      removed: diff.removed.filter((e) => e && e.id && announced[e.id] !== 'REMOVED'),
    };
  }

  console.log('Diff', {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    first: isFirst,
  });

  const compact = experiments
    .filter((e) => e && e.hasGlobalPct && !String(e.id).startsWith('hash:'))
    .map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      fingerprint: pctKey(e),
      treatments: (e.treatments || [])
        .filter((t) => t && t.pct != null)
        .map((t) => ({
          bucket: t.bucket,
          label: t.label,
          pct: Math.round(Number(t.pct) * 10) / 10,
        })),
      revision: e.revision,
      recent: !!e.recent,
      hash: e.hash,
      source: e.source,
      hasGlobalPct: true,
    }));

  // Baseline announced = current fingerprints
  for (const e of compact) {
    if (e.id && e.fingerprint) announced[e.id] = e.fingerprint;
  }

  async function writeState() {
    await fs.writeJson(
      STATE_FILE,
      {
        scrapedAt: new Date().toISOString(),
        count: compact.length,
        experiments: compact,
        announced,
      },
      { spaces: 2 },
    );
  }

  if (isFirst) {
    await writeState();
    console.log('Seed', compact.length, '— no notify');
    return;
  }
  if (!(diff.added.length || diff.changed.length || diff.removed.length)) {
    await writeState();
    console.log('No significant % change');
    return;
  }
  if (!WEBHOOK) {
    await writeState();
    console.warn('No webhook');
    return;
  }

  const embeds = buildEmbeds(diff);
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);

  if (sent.ok) {
    for (const e of diff.added) if (e && e.id) announced[e.id] = pctKey(e);
    for (const c of diff.changed) if (c.after && c.after.id) announced[c.after.id] = pctKey(c.after);
    for (const e of diff.removed) if (e && e.id) announced[e.id] = 'REMOVED';
  } else {
    console.warn('Webhook failed — will retry next run');
  }

  await writeState();
  console.log(sent.ok ? '✅ Done' : '⚠️ Done with webhook error');
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
module.exports = { main, decodeGuildWire, rangesToPct, murmur3 };
