/**
 * Discord Canary scraper
 * Webhook messages: Strings · Endpoints · New Apex / New Experiment
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const CANARY_APP = 'https://canary.discord.com/app';
const EXPERIMENTS_API =
  'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true';
const DEFINITIONS_URL =
  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const GUILD_EXP_FILE = path.join(DATA_DIR, 'guild_experiments.json');
const STRINGS_FILE = path.join(DATA_DIR, 'strings.json');
const STRINGS_NEW_FILE = path.join(DATA_DIR, 'strings_new.json');
const ENDPOINTS_FILE = path.join(DATA_DIR, 'endpoints.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function murmur3_full(key) {
  const data = Buffer.from(key, 'utf8');
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

async function httpGet(url, asText = true) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return asText ? res.text() : res.json();
}

async function httpGetJson(url) {
  return httpGet(url, false);
}

function parseGlobalEnv(html) {
  const m = html.match(/window\.GLOBAL_ENV\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return {};
  const block = m[1];
  const env = {};
  const grab = (key) => {
    const re = new RegExp(`"${key}"\\s*:\\s*"?([^,"}]+)"?`);
    const mm = block.match(re);
    return mm ? mm[1].replace(/^"|"$/g, '').trim() : null;
  };
  env.BUILD_NUMBER = grab('BUILD_NUMBER');
  env.VERSION_HASH = grab('VERSION_HASH');
  env.BUILT_AT = grab('BUILT_AT');
  env.RELEASE_CHANNEL = grab('RELEASE_CHANNEL') || 'canary';
  return env;
}

function extractAssetUrls(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  const add = (href) => {
    if (!href || !href.includes('/assets/')) return;
    urls.add(href.startsWith('http') ? href : `https://canary.discord.com${href}`);
  };
  $('script[src]').each((_, el) => add($(el).attr('src')));
  $('link[rel="stylesheet"]').each((_, el) => add($(el).attr('href')));
  $('link[rel="preload"],link[rel="modulepreload"]').each((_, el) => add($(el).attr('href')));
  const re = /\/assets\/([a-zA-Z0-9._-]+\.(?:js|css))/g;
  let m;
  while ((m = re.exec(html)) !== null) add(`/assets/${m[1]}`);
  return [...urls];
}

async function downloadFile(url) {
  const name = path.basename(url.split('?')[0]);
  const dest = path.join(ASSETS_DIR, name);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`download ${name} ${res.status}`);
  await fs.writeFile(dest, await res.buffer());
  const stat = await fs.stat(dest);
  console.log(`✓ ${name} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  return name;
}

async function downloadPriorityAssets(assetUrls) {
  await fs.ensureDir(ASSETS_DIR);
  const web = assetUrls.filter((u) => /\/assets\/web\.[a-f0-9]+\.js/i.test(u));
  const otherJs = assetUrls.filter((u) => u.endsWith('.js') && !/\/assets\/web\./i.test(u));
  const toFetch = [...web, ...otherJs.slice(0, 40)];
  const got = [];
  for (const url of toFetch) {
    const name = path.basename(url.split('?')[0]);
    const dest = path.join(ASSETS_DIR, name);
    try {
      if (await fs.pathExists(dest)) {
        const st = await fs.stat(dest);
        if (/^web\./i.test(name) && st.size < 1_000_000) await downloadFile(url);
        else console.log(`· cached ${name}`);
        got.push(name);
        continue;
      }
      await downloadFile(url);
      got.push(name);
    } catch (e) {
      console.warn(`✗ ${name}: ${e.message}`);
    }
  }
  return got;
}

function rangesToPercent(ranges) {
  if (!ranges?.length) return 0;
  let total = 0;
  for (const r of ranges) {
    const s = Number(r.s ?? r.start ?? 0);
    const e = Number(r.e ?? r.end ?? 0);
    if (e > s) total += e - s;
  }
  return Math.round((total / 10000) * 10000) / 100;
}

function formatRanges(ranges) {
  return (ranges || []).map((r) => `${r.s ?? r.start}–${r.e ?? r.end}`).join(', ');
}

function parsePopulation(population) {
  const buckets = {};
  if (!population || !population[0]) return { buckets, filters: [] };
  for (const bucket of population[0]) {
    const bucketId = String(bucket[0]);
    const rollouts = (bucket[1] || []).map((r) => ({
      start: r.s,
      end: r.e,
      s: r.s,
      e: r.e,
    }));
    buckets[bucketId] = {
      rollout: rollouts,
      percent: rangesToPercent(rollouts),
      rangesLabel: formatRanges(rollouts),
    };
  }
  return { buckets, filters: population[1] || [] };
}

function decodeGuildExperiment(raw) {
  const hash = raw[0];
  const id = raw[1] ?? null;
  const revision = raw[2];
  const populations = (raw[3] || []).map(parsePopulation);
  const aaMode = raw[raw.length - 1] === 1;
  const summary = [];
  const main = populations[0];
  if (main?.buckets) {
    for (const [bucketId, b] of Object.entries(main.buckets)) {
      const label =
        bucketId === '-1' || bucketId === 'null'
          ? 'None'
          : bucketId === '0'
            ? 'Control'
            : `Treatment ${bucketId}`;
      summary.push({
        bucket: bucketId,
        label,
        percent: b.percent,
        ranges: b.rangesLabel,
      });
    }
  }
  return { hash, id, revision, aaMode, populations, rolloutSummary: summary };
}

async function fetchOfficialExperiments() {
  const data = await httpGetJson(EXPERIMENTS_API);
  return {
    guildExperiments: (data.guild_experiments || []).map(decodeGuildExperiment),
    assignmentCount: (data.assignments || []).length,
    assignments: data.assignments || [],
  };
}

async function fetchDefinitions() {
  try {
    const list = await httpGetJson(DEFINITIONS_URL);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('Definitions gist unavailable:', e.message);
    return [];
  }
}

function matchDefinitionByHash(hash, definitions) {
  for (const d of definitions) {
    if (!d.id) continue;
    if (murmur3_full(String(d.id)) === (hash >>> 0)) return d;
  }
  return null;
}

function unescapeStr(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function shouldKeepString(key, val) {
  if (!key || val == null || typeof val !== 'string') return false;
  const v = val.trim();
  if (v.length < 1 || v.length > 600) return false;
  if (/^https?:\/\//i.test(v) && !/\s/.test(v)) return false;
  if (/^\/[a-z0-9_\-{}\/]+$/i.test(v)) return false;
  if (/^[a-f0-9]{20,}$/i.test(v)) return false;
  if (/webpack|function\s*\(|=>\s*\{/.test(v)) return false;
  if (/^[\d.]+$/.test(v)) return false;
  // Discord short i18n keys like KdgI4k / 67PpcP
  if (/^[A-Za-z0-9]{5,12}$/.test(key) && /[A-Za-z]/.test(v) && v.length >= 2) return true;
  if (/^[A-Z][A-Z0-9_]{4,}$/.test(key) && v.length >= 2) return true;
  if (/\s/.test(v)) return true;
  if (/^[A-Z][a-z]/.test(v) && v.length >= 4) return true;
  return false;
}

/** Extract Discord-style strings (short keys + SCREAMING keys) */
function extractStringsFromContent(content, outMap) {
  // "KdgI4k": "Interrupt the current work"
  const reQuoted =
    /["']([A-Za-z0-9_]{4,80})["']\s*:\s*["']((?:[^"'\\]|\\.){1,500})["']/g;
  let m;
  while ((m = reQuoted.exec(content)) !== null) {
    const key = m[1];
    const val = unescapeStr(m[2]);
    if (shouldKeepString(key, val)) outMap.set(key, val);
  }
  // KdgI4k: "text" or KdgI4k:"text"
  const reBare =
    /(?:^|[,{;\s])([A-Za-z][A-Za-z0-9_]{4,80})\s*:\s*["']((?:[^"'\\]|\\.){1,500})["']/g;
  while ((m = reBare.exec(content)) !== null) {
    const key = m[1];
    const val = unescapeStr(m[2]);
    if (shouldKeepString(key, val)) outMap.set(key, val);
  }
}

function isExpId(id) {
  if (!/^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80}$/i.test(id)) return false;
  if (/^20\d{2}-\d{2}$/.test(id)) return false;
  return true;
}

/** Named endpoints: GIFTING_...: "/users/@me/..." */
function extractEndpointsFromContent(content, outMap) {
  const reNamed =
    /["']?([A-Z][A-Z0-9_]{6,120})["']?\s*:\s*["'](\/(?:api\/v\d+|users|guilds|channels|quests|oauth2|store|partners|applications)[a-zA-Z0-9_\-\/{}.@]*)["']/g;
  let m;
  while ((m = reNamed.exec(content)) !== null) {
    const name = m[1];
    const route = m[2];
    if (route.length < 4 || route.length > 160) continue;
    outMap.set(name, route);
  }
  // bare path strings as anonymous endpoints (keyed by path)
  const rePath =
    /["'](\/(?:api\/v\d+|users\/@me|guilds|channels|quests)[a-zA-Z0-9_\-\/{}.]*)["']/g;
  while ((m = rePath.exec(content)) !== null) {
    const route = m[1];
    if (route.length > 6 && route.length < 120) {
      if (![...outMap.values()].includes(route)) {
        // only add if not already named
        const key = route.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase().slice(0, 80);
        if (!outMap.has(key)) outMap.set(key, route);
      }
    }
  }
}

function analyzeClientJS(content) {
  const experiments = new Map();
  const endpoints = new Map();
  const ui = new Map();
  const idRe = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80})["']/gi;
  let m;
  while ((m = idRe.exec(content)) !== null) {
    const id = m[1].toLowerCase();
    if (!isExpId(id)) continue;
    if (!experiments.has(id)) {
      experiments.set(id, {
        id,
        type: /guild/i.test(id) ? 'guild' : 'user',
        isApex: /apex|_aa_|-aa-/i.test(id),
      });
    }
  }
  extractEndpointsFromContent(content, endpoints);
  const uiRe =
    /["']([A-Z][A-Za-z0-9]*(?:Modal|Panel|Popout|Drawer|Sheet|Sidebar|Overlay))["']/g;
  while ((m = uiRe.exec(content)) !== null) {
    const name = m[1];
    if (ui.has(name)) continue;
    let kind = 'component';
    if (/Modal/i.test(name)) kind = 'modal';
    else if (/Panel|Sidebar|Drawer|Sheet/i.test(name)) kind = 'panel';
    else if (/Popout|Overlay/i.test(name)) kind = 'overlay';
    ui.set(name, { name, kind });
  }
  return {
    experiments: [...experiments.values()],
    endpoints: Object.fromEntries(endpoints),
    ui: [...ui.values()],
  };
}

async function analyzeDownloadedAssets() {
  if (!(await fs.pathExists(ASSETS_DIR))) {
    return { experiments: [], endpoints: {}, ui: [], strings: {} };
  }
  const files = (await fs.readdir(ASSETS_DIR)).filter((f) => f.endsWith('.js'));
  files.sort((a, b) => (/^web\./i.test(a) ? 0 : 1) - (/^web\./i.test(b) ? 0 : 1));
  const expMap = new Map();
  const endpointMap = new Map();
  const uiMap = new Map();
  const stringMap = new Map();
  for (const file of files) {
    try {
      const full = path.join(ASSETS_DIR, file);
      const st = await fs.stat(full);
      let content = await fs.readFile(full, 'utf8');
      if (st.size > 15_000_000 && !/^web\./i.test(file)) content = content.slice(0, 8_000_000);
      console.log(`  scan ${file} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
      const found = analyzeClientJS(content);
      for (const e of found.experiments) expMap.set(e.id, e);
      for (const [k, v] of Object.entries(found.endpoints || {})) endpointMap.set(k, v);
      for (const u of found.ui) uiMap.set(u.name, u);
      extractStringsFromContent(content, stringMap);
      if (/^web\./i.test(file)) {
        console.log(`    → ${found.experiments.length} experiment IDs in web bundle`);
      }
    } catch (e) {
      console.warn(`  skip ${file}: ${e.message}`);
    }
  }
  const stringsObj = {};
  for (const [k, v] of [...stringMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    stringsObj[k] = v;
  }
  const endpointsObj = Object.fromEntries(
    [...endpointMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
  console.log(`    → ${Object.keys(stringsObj).length} strings extracted`);
  console.log(`    → ${Object.keys(endpointsObj).length} endpoints extracted`);
  return {
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    endpoints: endpointsObj,
    ui: [...uiMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    strings: stringsObj,
  };
}

function enrichWithDefinitions(experiments, definitions) {
  const byId = new Map(definitions.map((d) => [String(d.id).toLowerCase(), d]));
  return experiments.map((e) => {
    const def = byId.get(e.id.toLowerCase());
    if (!def) return { ...e, label: null, treatments: [], kind: e.type };
    return {
      ...e,
      label: def.label || null,
      kind: def.kind || e.type,
      treatments: (def.treatments || []).map((t) => ({
        id: t.id,
        label: t.label || `Variation ${t.id}`,
      })),
    };
  });
}

function chunkLines(lines, maxChars = 3800) {
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + 1;
    if (buf.length && len + add > maxChars) {
      chunks.push(buf.join('\n'));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += add;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

/** Example format: Strings / + KEY: value / Build Id - N */
function stringsEmbeds(stringDiff, buildNumber) {
  const lines = [];
  for (const [k, v] of Object.entries(stringDiff.added || {})) {
    lines.push(`+ ${k}: ${v}`);
  }
  for (const [k, v] of Object.entries(stringDiff.modified || {})) {
    lines.push(`~ ${k}: ${v}`);
  }
  for (const k of stringDiff.removed || []) {
    lines.push(`- ${k}`);
  }
  if (!lines.length) return [];
  const header = '**Strings**\n_Added · removed · modified_\n';
  const footer = `\n\n**Build Id** — ${buildNumber}`;
  const embeds = [];
  const chunks = chunkLines(lines, 3500);
  chunks.forEach((body, i) => {
    embeds.push({
      title: i === 0 ? 'Strings' : `Strings (${i + 1})`,
      description: (i === 0 ? header : '') + '```\n' + body + '\n```' + (i === chunks.length - 1 ? footer : ''),
      color: 0x57F287,
      timestamp: new Date().toISOString(),
    });
  });
  return embeds;
}

/** Example: Endpoints / + NAME: /path */
function endpointsEmbeds(epDiff, buildNumber) {
  const lines = [];
  for (const [name, route] of Object.entries(epDiff.added || {})) {
    lines.push(`+ ${name}: ${route}`);
  }
  for (const [name, route] of Object.entries(epDiff.modified || {})) {
    lines.push(`~ ${name}: ${route}`);
  }
  for (const name of epDiff.removed || []) {
    lines.push(`- ${name}`);
  }
  if (!lines.length) return [];
  const header = '**Endpoints**\n_Added · removed · modified_\n';
  const footer = `\n\n**Build Id** — ${buildNumber}`;
  const embeds = [];
  const chunks = chunkLines(lines, 3500);
  chunks.forEach((body, i) => {
    embeds.push({
      title: i === 0 ? 'Endpoints' : `Endpoints (${i + 1})`,
      description: (i === 0 ? header : '') + '```\n' + body + '\n```' + (i === chunks.length - 1 ? footer : ''),
      color: 0x5865F2,
      timestamp: new Date().toISOString(),
    });
  });
  return embeds;
}

/** Example: New Apex Experiments / + id (user) / * Variant 1 / Type / Build */
function experimentEmbed(exp, buildNumber) {
  const isApex = exp.isApex || exp.aaMode;
  const type = exp.kind || exp.type || 'user';
  const variants = (exp.treatments || []).length
    ? exp.treatments.map((t) => `* Variant ${t.id}${t.label ? ` — ${t.label}` : ''}`)
    : ['* Variant 0', '* Variant 1'];
  const desc = [
    `+ \`${exp.id}\` (**${type}**)`,
    ...variants.slice(0, 12),
    `Type: **${type}**`,
    `Build: **${buildNumber}**`,
  ].join('\n');
  return {
    title: isApex ? 'New Apex Experiment' : 'New Experiment',
    description: desc,
    color: isApex ? 0xFEE75C : 0xEB459E,
    timestamp: new Date().toISOString(),
  };
}

function guildExperimentEmbed(g, buildNumber) {
  const name = g.id || g.definitionId || `hash:${g.hash}`;
  const type = 'guild';
  const variants = (g.rolloutSummary || []).map(
    (b) => `* ${b.label} — **${b.percent}%**`,
  );
  const desc = [
    `+ \`${name}\` (**${type}**)`,
    ...(variants.length ? variants : ['* Variant 0', '* Variant 1']),
    `Type: **${type}**`,
    `Build: **${buildNumber}**`,
  ].join('\n');
  return {
    title: g.aaMode ? 'New Apex Experiment' : 'New Experiment',
    description: desc,
    color: 0xFEE75C,
    timestamp: new Date().toISOString(),
  };
}

async function postWebhook(payload) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.warn('Webhook failed', res.status, await res.text());
  else console.log('Webhook sent');
  // Discord rate limit: small pause between multi-posts
  await new Promise((r) => setTimeout(r, 600));
}

async function notify({
  build,
  isNewBuild,
  diff,
  enriched,
  clientFindings,
  guildEnriched,
  stringDiff,
  endpointDiff,
}) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL — skip notify');
    return;
  }

  const hasStrings =
    Object.keys(stringDiff.added || {}).length +
      Object.keys(stringDiff.modified || {}).length +
      (stringDiff.removed || []).length >
    0;
  const hasEndpoints =
    Object.keys(endpointDiff.added || {}).length +
      Object.keys(endpointDiff.modified || {}).length +
      (endpointDiff.removed || []).length >
    0;
  const hasNewExp =
    (diff.newClientExperiments?.length || 0) + (diff.newGuild?.length || 0) > 0;
  const hasNewUI = (diff.newUI?.length || 0) > 0;

  // 1) Summary only on new build or important deltas
  if (isNewBuild || hasNewExp || hasNewUI || hasStrings || hasEndpoints) {
    await postWebhook({
      username: 'Canary Scraper',
      embeds: [
        {
          title: isNewBuild ? 'New Discord Canary Build' : 'Canary Changes',
          color: hasNewExp ? 0xED4245 : 0x57F287,
          fields: [
            { name: 'Build', value: String(build.buildNumber), inline: true },
            { name: 'Channel', value: build.releaseChannel || 'canary', inline: true },
            {
              name: 'Delta',
              value: [
                hasNewExp ? 'Experiments' : null,
                hasStrings ? 'Strings' : null,
                hasEndpoints ? 'Endpoints' : null,
                hasNewUI ? 'UI' : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'check',
              inline: false,
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  // 2) Strings (exact style)
  for (const emb of stringsEmbeds(stringDiff, build.buildNumber).slice(0, 4)) {
    await postWebhook({ username: 'Canary Scraper', embeds: [emb] });
  }

  // 3) Endpoints
  for (const emb of endpointsEmbeds(endpointDiff, build.buildNumber).slice(0, 4)) {
    await postWebhook({ username: 'Canary Scraper', embeds: [emb] });
  }

  // 4) New experiments (Apex first)
  const sortedNew = [...(diff.newClientExperiments || [])].sort((a, b) => {
    const aa = a.isApex ? 0 : 1;
    const bb = b.isApex ? 0 : 1;
    if (aa !== bb) return aa - bb;
    return b.id.localeCompare(a.id);
  });
  for (const exp of sortedNew.slice(0, 8)) {
    await postWebhook({
      username: 'Canary Scraper',
      embeds: [experimentEmbed(exp, build.buildNumber)],
    });
  }
  for (const g of (diff.newGuild || []).slice(0, 5)) {
    await postWebhook({
      username: 'Canary Scraper',
      embeds: [guildExperimentEmbed(g, build.buildNumber)],
    });
  }

  // 5) New UI (important)
  if (hasNewUI) {
    await postWebhook({
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'New UI',
          color: 0xF47B67,
          description: diff.newUI
            .slice(0, 25)
            .map((u) => `+ \`${u.name}\` (**${u.kind}**)`)
            .join('\n'),
          footer: { text: `Build Id — ${build.buildNumber}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}

async function main() {
  console.log('🔍 Canary scrape — Strings / Endpoints / Experiments webhook\n');
  await fs.ensureDir(DATA_DIR);

  const html = await httpGet(CANARY_APP);
  const env = parseGlobalEnv(html);
  const assetUrls = extractAssetUrls(html);
  const buildNumber =
    env.BUILD_NUMBER ||
    `hash-${crypto.createHash('sha256').update(html).digest('hex').slice(0, 10)}`;

  console.log(`Build        : ${buildNumber}`);
  console.log(`Version hash : ${env.VERSION_HASH || '—'}`);

  let previousBuild = null;
  try {
    if (await fs.pathExists(BUILD_FILE)) previousBuild = await fs.readJson(BUILD_FILE);
  } catch {}
  const isNewBuild = !previousBuild || previousBuild.buildNumber !== buildNumber;

  console.log('\n📡 /api/v10/experiments …');
  let official = { guildExperiments: [], assignmentCount: 0 };
  try {
    official = await fetchOfficialExperiments();
    console.log(`  Guild experiments : ${official.guildExperiments.length}`);
  } catch (e) {
    console.warn('  API error:', e.message);
  }

  console.log('\n📚 Definitions …');
  const definitions = await fetchDefinitions();
  console.log(`  Definitions : ${definitions.length}`);

  const guildEnriched = official.guildExperiments.map((g) => {
    const def = matchDefinitionByHash(g.hash, definitions);
    return {
      ...g,
      definitionId: def?.id || g.id,
      id: def?.id || g.id,
      label: def?.label || null,
      kind: def?.kind || 'guild',
    };
  });

  const webUrl = assetUrls.find((u) => /\/web\.[a-f0-9]+\.js/i.test(u));
  const webName = webUrl ? path.basename(webUrl.split('?')[0]) : null;
  const webPath = webName ? path.join(ASSETS_DIR, webName) : null;
  let webOk = false;
  if (webPath && (await fs.pathExists(webPath))) {
    webOk = (await fs.stat(webPath)).size > 2_000_000;
  }

  if (isNewBuild || !webOk) {
    if (isNewBuild) await fs.emptyDir(ASSETS_DIR);
    console.log('\n📦 Downloading assets …');
    await downloadPriorityAssets(assetUrls);
  } else {
    console.log('\nSame build + web.js OK');
  }

  console.log('\n🧠 Scan client JS …');
  const clientFindings = await analyzeDownloadedAssets();
  console.log(`  Experiments : ${clientFindings.experiments.length}`);
  console.log(`  Strings     : ${Object.keys(clientFindings.strings || {}).length}`);
  console.log(`  Endpoints   : ${Object.keys(clientFindings.endpoints || {}).length}`);

  const enriched = enrichWithDefinitions(clientFindings.experiments, definitions);

  let previous = null;
  try {
    if (await fs.pathExists(FINDINGS_FILE)) previous = await fs.readJson(FINDINGS_FILE);
  } catch {}
  let previousGuild = [];
  try {
    if (await fs.pathExists(GUILD_EXP_FILE)) previousGuild = await fs.readJson(GUILD_EXP_FILE);
  } catch {}

  const prevExpIds = new Set((previous?.experiments || []).map((e) => e.id));
  const prevUI = new Set((previous?.ui || []).map((u) => u.name));
  const prevGuildHashes = new Set((previousGuild || []).map((g) => g.hash));

  const diff = {
    newClientExperiments: enriched.filter((e) => !prevExpIds.has(e.id)),
    newUI: clientFindings.ui.filter((u) => !prevUI.has(u.name)),
    newGuild: guildEnriched.filter((g) => !prevGuildHashes.has(g.hash)),
  };

  // —— Strings diff (added / removed / modified)
  const allStrings = clientFindings.strings || {};
  let prevStrings = {};
  try {
    if (await fs.pathExists(STRINGS_FILE)) prevStrings = await fs.readJson(STRINGS_FILE);
  } catch {}
  const stringDiff = { added: {}, removed: [], modified: {} };
  for (const [k, v] of Object.entries(allStrings)) {
    if (!(k in prevStrings)) stringDiff.added[k] = v;
    else if (prevStrings[k] !== v) stringDiff.modified[k] = v;
  }
  for (const k of Object.keys(prevStrings)) {
    if (!(k in allStrings)) stringDiff.removed.push(k);
  }
  await fs.writeJson(STRINGS_FILE, allStrings, { spaces: 2 });
  await fs.writeJson(
    STRINGS_NEW_FILE,
    {
      scrapedAt: new Date().toISOString(),
      buildNumber,
      added: Object.keys(stringDiff.added).length,
      removed: stringDiff.removed.length,
      modified: Object.keys(stringDiff.modified).length,
      strings: stringDiff.added,
    },
    { spaces: 2 },
  );

  // —— Endpoints diff
  const allEndpoints = clientFindings.endpoints || {};
  let prevEndpoints = {};
  try {
    if (await fs.pathExists(ENDPOINTS_FILE)) prevEndpoints = await fs.readJson(ENDPOINTS_FILE);
  } catch {}
  const endpointDiff = { added: {}, removed: [], modified: {} };
  for (const [k, v] of Object.entries(allEndpoints)) {
    if (!(k in prevEndpoints)) endpointDiff.added[k] = v;
    else if (prevEndpoints[k] !== v) endpointDiff.modified[k] = v;
  }
  for (const k of Object.keys(prevEndpoints)) {
    if (!(k in allEndpoints)) endpointDiff.removed.push(k);
  }
  await fs.writeJson(ENDPOINTS_FILE, allEndpoints, { spaces: 2 });

  const build = {
    buildNumber,
    versionHash: env.VERSION_HASH || null,
    builtAt: env.BUILT_AT || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    scrapedAt: new Date().toISOString(),
    experimentCount: enriched.length,
  };

  await fs.writeJson(BUILD_FILE, build, { spaces: 2 });
  await fs.writeJson(
    FINDINGS_FILE,
    {
      experiments: enriched,
      endpoints: allEndpoints,
      ui: clientFindings.ui,
      scrapedAt: build.scrapedAt,
    },
    { spaces: 2 },
  );

  await fs.writeJson(
    GUILD_EXP_FILE,
    guildEnriched.map((g) => ({
      hash: g.hash,
      id: g.id,
      definitionId: g.definitionId,
      label: g.label,
      revision: g.revision,
      aaMode: g.aaMode,
      rolloutSummary: g.rolloutSummary,
    })),
    { spaces: 2 },
  );

  console.log(
    `\n📝 Strings +${Object.keys(stringDiff.added).length} ~${Object.keys(stringDiff.modified).length} -${stringDiff.removed.length}`,
  );
  console.log(
    `🔗 Endpoints +${Object.keys(endpointDiff.added).length} ~${Object.keys(endpointDiff.modified).length} -${endpointDiff.removed.length}`,
  );
  console.log(`🧪 New experiments: ${diff.newClientExperiments.length} client, ${diff.newGuild.length} guild`);

  await notify({
    build,
    isNewBuild,
    diff,
    enriched,
    clientFindings,
    guildEnriched,
    stringDiff,
    endpointDiff,
  });

  console.log('\n✅ Done');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
