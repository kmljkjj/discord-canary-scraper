/**
 * Discord Canary scraper — Wumpus Central style
 *
 * Guild experiment % : real, from /api/v10/experiments populations (s/e over 10000)
 * User experiment %  : Discord does NOT publish global rollouts publicly
 * Strings             : data/strings.json (like discrapper-canary) — NOT sent to Discord
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

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function murmur3(str) {
  return murmur3_full(str);
}

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

function shouldKeepString(key, val) {
  if (!key || !val || typeof val !== 'string') return false;
  if (val.length < 2 || val.length > 500) return false;
  if (/^https?:\/\//i.test(val) && !/\s/.test(val)) return false;
  if (/^\/[a-z0-9_\-{}\/]+$/i.test(val)) return false;
  if (/^[a-f0-9]{16,}$/i.test(val)) return false;
  if (/webpack|function\s*\(|=>\s*\{/.test(val)) return false;
  if (/^[\d.]+$/.test(val)) return false;
  if (/\s/.test(val)) return true;
  if (/^[A-Z][a-z]/.test(val) && val.length >= 4) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(key) && val.length >= 3) return true;
  return false;
}

/** Wumpus-style string extraction → data/strings.json only */
function extractStringsFromContent(content, outMap) {
  const re1 = /(?:^|[,{;])([A-Z][A-Z0-9_]{5,100})\s*:\s*"((?:[^"\\]|\\.){2,400})"/g;
  let m;
  while ((m = re1.exec(content)) !== null) {
    if (shouldKeepString(m[1], m[2])) outMap.set(m[1], m[2]);
  }
  const re2 = /"([A-Z][A-Z0-9_]{5,100})"\s*:\s*"((?:[^"\\]|\\.){2,400})"/g;
  while ((m = re2.exec(content)) !== null) {
    if (shouldKeepString(m[1], m[2])) outMap.set(m[1], m[2]);
  }
  const re3 = /"([a-zA-Z][a-zA-Z0-9_.]{4,80})"\s*:\s*"((?:[^"\\]|\\.){8,300})"/g;
  while ((m = re3.exec(content)) !== null) {
    if (!/[ _]/.test(m[2]) && !/[a-z]/.test(m[2])) continue;
    if (shouldKeepString(m[1], m[2])) outMap.set(m[1], m[2]);
  }
}

function isExpId(id) {
  if (!/^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80}$/i.test(id)) return false;
  if (/^20\d{2}-\d{2}$/.test(id)) return false;
  return true;
}

function analyzeClientJS(content) {
  const experiments = new Map();
  const routes = new Set();
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
  const routeRe =
    /["'](\/(?:api\/v\d+|users\/@me|guilds|channels|quests)[a-z0-9_\-\/{}.]*)["']/gi;
  while ((m = routeRe.exec(content)) !== null) {
    if (m[1].length > 6 && m[1].length < 100) routes.add(m[1]);
  }
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
    routes: [...routes].sort(),
    ui: [...ui.values()],
  };
}

async function analyzeDownloadedAssets() {
  if (!(await fs.pathExists(ASSETS_DIR))) {
    return { experiments: [], routes: [], ui: [], strings: {} };
  }
  const files = (await fs.readdir(ASSETS_DIR)).filter((f) => f.endsWith('.js'));
  files.sort((a, b) => (/^web\./i.test(a) ? 0 : 1) - (/^web\./i.test(b) ? 0 : 1));
  const expMap = new Map();
  const routes = new Set();
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
      found.routes.forEach((r) => routes.add(r));
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
  console.log(`    → ${Object.keys(stringsObj).length} strings extracted`);
  return {
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    routes: [...routes].sort(),
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

function experimentEmbed(exp, buildNumber) {
  const isApex = exp.isApex || exp.aaMode;
  const fields = [
    { name: 'Name', value: `\`${exp.id}\``, inline: false },
    { name: 'Type', value: exp.kind || exp.type || 'user', inline: true },
    { name: 'Build', value: String(buildNumber), inline: true },
  ];
  if (exp.label) fields.push({ name: 'Label', value: exp.label, inline: false });
  if (exp.treatments?.length) {
    fields.push({
      name: 'Variations',
      value: exp.treatments
        .slice(0, 8)
        .map((t) => `• **Variation ${t.id}** — ${t.label}`)
        .join('\n')
        .slice(0, 900),
      inline: false,
    });
  } else {
    fields.push({ name: 'Variations', value: '• Variation 0\n• Variation 1', inline: false });
  }
  fields.push({
    name: 'Rollout %',
    value: '_Non publié par Discord pour les user experiments (API publique)_',
    inline: false,
  });
  return {
    title: isApex ? 'New Apex Experiment' : 'New Experiment',
    color: isApex ? 0xFEE75C : 0xEB459E,
    fields,
    timestamp: new Date().toISOString(),
  };
}

function guildExperimentEmbed(g, buildNumber) {
  const name = g.id || g.definitionId || `hash:${g.hash}`;
  const lines = (g.rolloutSummary || []).map(
    (b) => `• **${b.label}**: **${b.percent}%** \`${b.ranges || '—'}\``,
  );
  const fields = [
    { name: 'Name', value: `\`${name}\``, inline: false },
    { name: 'Type', value: 'guild', inline: true },
    { name: 'Hash', value: String(g.hash), inline: true },
    { name: 'Build', value: String(buildNumber), inline: true },
  ];
  if (g.label) fields.push({ name: 'Label', value: g.label, inline: false });
  fields.push({
    name: 'Rollout (vrai % API)',
    value: (lines.join('\n') || '—').slice(0, 1000),
    inline: false,
  });
  return {
    title: g.aaMode ? 'New Apex Guild Experiment' : 'New Guild Experiment',
    color: 0xFEE75C,
    fields,
    footer: { text: 'Pourcentages = ranges Discord / 10000' },
    timestamp: new Date().toISOString(),
  };
}

function truncate(arr, max = 40) {
  if (!arr?.length) return '—';
  const lines = arr
    .slice(0, max)
    .map((x) => `• \`${typeof x === 'string' ? x : x.id || x.name}\``);
  if (arr.length > max) lines.push(`… +${arr.length - max} more`);
  return lines.join('\n').slice(0, 3900);
}

async function notify({ build, isNewBuild, diff, enriched, clientFindings, guildEnriched }) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL — skip notify');
    return;
  }
  const hasNewExp =
    (diff.newClientExperiments?.length || 0) + (diff.newGuild?.length || 0) > 0;
  const hasNewUI = (diff.newUI?.length || 0) > 0;
  const hasNewRoutes = (diff.newRoutes?.length || 0) > 0;
  const important = hasNewExp || hasNewUI || hasNewRoutes;
  const embeds = [];
  embeds.push({
    title: important
      ? '🚨 Important Canary Changes'
      : isNewBuild
        ? '🚀 New Discord Canary Build'
        : 'ℹ️ Discord Canary Check',
    color: important ? 0xED4245 : isNewBuild ? 0x57F287 : 0x5865F2,
    fields: [
      { name: 'Build', value: String(build.buildNumber), inline: true },
      { name: 'Channel', value: build.releaseChannel || 'canary', inline: true },
      {
        name: 'Version',
        value: build.versionHash ? `\`${build.versionHash.slice(0, 10)}…\`` : '—',
        inline: true,
      },
      {
        name: 'Tracked',
        value: `Client exp: **${enriched.length}** · Guild API: **${(guildEnriched || []).length}** · UI: **${(clientFindings.ui || []).length}** · Strings: **${Object.keys(clientFindings.strings || {}).length}** (fichier only)`,
        inline: false,
      },
    ],
    footer: { text: 'Strings → data/strings.json (pas Discord)' },
    timestamp: new Date().toISOString(),
  });
  for (const g of (diff.newGuild || []).slice(0, 5)) {
    embeds.push(guildExperimentEmbed(g, build.buildNumber));
  }
  const sortedNew = [...(diff.newClientExperiments || [])].sort((a, b) =>
    b.id.localeCompare(a.id),
  );
  for (const exp of sortedNew.slice(0, 5)) {
    embeds.push(experimentEmbed(exp, build.buildNumber));
  }
  if (sortedNew.length > 5) {
    embeds.push({
      title: `New Experiments (+${sortedNew.length - 5} more)`,
      color: 0xEB459E,
      description: truncate(sortedNew.slice(5).map((e) => e.id), 40),
    });
  }
  if (hasNewUI) {
    embeds.push({
      title: '🧩 New UI',
      color: 0xF47B67,
      description: diff.newUI
        .slice(0, 20)
        .map((u) => `• \`${u.name}\` (**${u.kind}**)`)
        .join('\n'),
    });
  }
  if (hasNewRoutes) {
    embeds.push({
      title: 'New Routes',
      color: 0x5865F2,
      description: truncate(diff.newRoutes, 20),
    });
  }
  if ((guildEnriched || []).length && (isNewBuild || (diff.newGuild || []).length)) {
    const lines = guildEnriched.slice(0, 12).map((g) => {
      const name = g.id || g.definitionId || g.hash;
      const top = (g.rolloutSummary || [])
        .filter((b) => b.percent > 0)
        .map((b) => `${b.label} ${b.percent}%`)
        .join(', ');
      return `• \`${name}\` — ${top || '0%'}`;
    });
    embeds.push({
      title: `Guild rollouts (API) — ${(guildEnriched || []).length}`,
      color: 0x1ABC9C,
      description: lines.join('\n').slice(0, 3900),
    });
  }
  if (isNewBuild && enriched.length) {
    const recent = [...enriched].sort((a, b) => b.id.localeCompare(a.id));
    embeds.push({
      title: `Client experiments (${enriched.length})`,
      color: 0x9B59B6,
      description: truncate(recent.map((e) => e.id), 50),
    });
  }
  const body = {
    username: 'Canary Scraper',
    avatar_url: 'https://cdn.discordapp.com/emojis/1044610189761052752.webp',
    embeds: embeds.slice(0, 10),
  };
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.warn('Webhook failed', res.status, await res.text());
  else console.log('Webhook sent');
}

async function main() {
  console.log('🔍 Canary scrape + strings.json (no Discord for strings)\n');
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
  const prevRoutes = new Set(previous?.routes || []);
  const prevGuildHashes = new Set((previousGuild || []).map((g) => g.hash));

  const diff = {
    newClientExperiments: enriched.filter((e) => !prevExpIds.has(e.id)),
    newUI: clientFindings.ui.filter((u) => !prevUI.has(u.name)),
    newRoutes: clientFindings.routes.filter((r) => !prevRoutes.has(r)),
    newGuild: guildEnriched.filter((g) => !prevGuildHashes.has(g.hash)),
  };

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
      routes: clientFindings.routes,
      ui: clientFindings.ui,
      scrapedAt: build.scrapedAt,
    },
    { spaces: 2 },
  );

  // Strings — Wumpus style, FILE ONLY (never Discord webhook)
  const allStrings = clientFindings.strings || {};
  let prevStrings = {};
  try {
    if (await fs.pathExists(STRINGS_FILE)) prevStrings = await fs.readJson(STRINGS_FILE);
  } catch {}
  const newStringKeys = Object.keys(allStrings).filter((k) => !(k in prevStrings));
  const newStrings = {};
  for (const k of newStringKeys.sort()) newStrings[k] = allStrings[k];
  await fs.writeJson(STRINGS_FILE, allStrings, { spaces: 2 });
  await fs.writeJson(
    STRINGS_NEW_FILE,
    {
      scrapedAt: build.scrapedAt,
      buildNumber: build.buildNumber,
      count: newStringKeys.length,
      total: Object.keys(allStrings).length,
      strings: newStrings,
    },
    { spaces: 2 },
  );
  console.log(
    `\n📝 Strings: ${Object.keys(allStrings).length} total, ${newStringKeys.length} new → data/strings.json (NOT sent to Discord)`,
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

  await notify({
    build,
    isNewBuild,
    diff,
    enriched,
    clientFindings,
    guildEnriched,
  });

  console.log('\n✅ Done');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
