/**
 * Discord Canary scraper — inspired by Wumpus Central (guild-experiments + discrapper)
 * and Discord Previews style notifications.
 *
 * Sources:
 * 1) GLOBAL_ENV from canary.discord.com/app  → build number / version hash
 * 2) GET /api/v10/experiments?with_guild_experiments=true → official experiments
 * 3) Public experiment definitions gist (DiscrapperManager / Wumpus)
 * 4) Client JS assets → experiment IDs, routes, UI names
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const CANARY_APP = 'https://canary.discord.com/app';
const EXPERIMENTS_API = 'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true';
const DEFINITIONS_URL =
  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const GUILD_EXP_FILE = path.join(DATA_DIR, 'guild_experiments.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// 1) GLOBAL_ENV + asset list (Wumpus / discrapper style)
// ─────────────────────────────────────────────

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
  env.API_ENDPOINT = grab('API_ENDPOINT');
  env.GATEWAY_ENDPOINT = grab('GATEWAY_ENDPOINT');
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

async function downloadLimited(urls, maxFiles = 80) {
  await fs.ensureDir(ASSETS_DIR);
  const list = urls.slice(0, maxFiles);
  const files = [];
  for (const url of list) {
    const name = path.basename(url.split('?')[0]);
    const dest = path.join(ASSETS_DIR, name);
    try {
      if (!(await fs.pathExists(dest))) {
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) continue;
        await fs.writeFile(dest, await res.buffer());
      }
      files.push(name);
      console.log(`✓ ${name}`);
    } catch {
      /* skip */
    }
  }
  return files;
}

// ─────────────────────────────────────────────
// 2) Official experiments API (Wumpus guild-experiments)
// ─────────────────────────────────────────────

function decodeGuildExperiment(raw) {
  // Array format from Discord API (same as Wumpus decoder)
  // [hash, id|null, revision, populations, overrides, overridesFormatted?, ..., aaMode]
  const hash = raw[0];
  const id = raw[1] ?? null;
  const revision = raw[2];
  const aaMode = raw[raw.length - 1] === 1;
  return { hash, id, revision, aaMode, raw };
}

async function fetchOfficialExperiments() {
  const data = await httpGetJson(EXPERIMENTS_API);
  const guild = (data.guild_experiments || []).map(decodeGuildExperiment);
  const assignments = data.assignments || [];
  return {
    fingerprint: data.fingerprint || null,
    guildExperiments: guild,
    assignmentCount: assignments.length,
    rawAssignmentHashes: assignments.map((a) => a[0]),
  };
}

async function fetchDefinitions() {
  try {
    const list = await httpGetJson(DEFINITIONS_URL);
    if (!Array.isArray(list)) return [];
    return list;
  } catch (e) {
    console.warn('Definitions gist unavailable:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// 3) Client JS scan for experiment IDs / routes / UI
// ─────────────────────────────────────────────

function isExpId(id) {
  return /^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{4,60}$/i.test(id);
}

function analyzeClientJS(content) {
  const experiments = new Map();
  const routes = new Set();
  const ui = new Map();

  const idRe = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{4,70})["']/gi;
  let m;
  while ((m = idRe.exec(content)) !== null) {
    const id = m[1].toLowerCase();
    if (!isExpId(id)) continue;
    if (!experiments.has(id)) {
      experiments.set(id, {
        id,
        type: id.includes('guild') ? 'guild' : 'user',
        isApex: /apex|_aa_|-aa-/i.test(id),
      });
    }
  }

  const routeRe = /["'](\/(?:api\/v\d+|users\/@me|guilds|channels|quests)[a-z0-9_\-\/{}.]*)["']/gi;
  while ((m = routeRe.exec(content)) !== null) {
    if (m[1].length > 6 && m[1].length < 100) routes.add(m[1]);
  }

  // UI: *Modal / *Panel / *Popout displayNames
  const uiRe = /["']([A-Z][A-Za-z0-9]*(?:Modal|Panel|Popout|Drawer|Sheet|Sidebar|Overlay))["']/g;
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
    return { experiments: [], routes: [], ui: [] };
  }
  const files = (await fs.readdir(ASSETS_DIR)).filter((f) => f.endsWith('.js'));
  const expMap = new Map();
  const routes = new Set();
  const uiMap = new Map();

  for (const file of files) {
    try {
      let content = await fs.readFile(path.join(ASSETS_DIR, file), 'utf8');
      if (content.length > 2_000_000) content = content.slice(0, 2_000_000);
      const found = analyzeClientJS(content);
      for (const e of found.experiments) expMap.set(e.id, e);
      found.routes.forEach((r) => routes.add(r));
      for (const u of found.ui) uiMap.set(u.name, u);
    } catch {
      /* skip */
    }
  }

  return {
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    routes: [...routes].sort(),
    ui: [...uiMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ─────────────────────────────────────────────
// Diff + merge with definitions (Discord Previews style)
// ─────────────────────────────────────────────

enrichWithDefinitions(experiments, definitions) {
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
      defaultConfig: def.defaultConfig || null,
    };
  });
}

function diffList(current, previous, keyFn) {
  const prev = new Set((previous || []).map(keyFn));
  return current.filter((x) => !prev.has(keyFn(x)));
}

// ─────────────────────────────────────────────
// Webhook embeds (Discord Previews–like)
// ─────────────────────────────────────────────

function experimentEmbed(exp, buildNumber) {
  const isApex = exp.isApex || exp.aaMode;
  const title = isApex ? 'New Apex Experiment' : 'New Experiment';
  const color = isApex ? 0xFEE75C : 0xEB459E;

  const fields = [
    { name: 'Name', value: `\`${exp.id}\``, inline: false },
    { name: 'Type', value: exp.kind || exp.type || 'user', inline: true },
    { name: 'Build', value: String(buildNumber), inline: true },
  ];

  if (exp.label) {
    fields.push({ name: 'Label', value: exp.label, inline: false });
  }

  if (exp.treatments && exp.treatments.length) {
    const lines = exp.treatments
      .slice(0, 8)
      .map((t) => `• **Variation ${t.id}** — ${t.label}`)
      .join('\n');
    fields.push({ name: 'Variations', value: lines.slice(0, 900), inline: false });
  } else {
    fields.push({
      name: 'Variations',
      value: '• Variation 0\n• Variation 1',
      inline: false,
    });
  }

  if (exp.hash) {
    fields.push({ name: 'Hash', value: String(exp.hash), inline: true });
  }

  return { title, color, fields, timestamp: new Date().toISOString() };
}

function truncate(arr, max = 12) {
  if (!arr?.length) return '—';
  const lines = arr.slice(0, max).map((x) => `• \`${typeof x === 'string' ? x : x.id || x.name}\``);
  if (arr.length > max) lines.push(`… +${arr.length - max} more`);
  return lines.join('\n');
}

async function notify({ build, isNewBuild, diff, enriched, clientFindings }) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL — skip notify');
    return;
  }

  const hasNewExp =
    (diff.newClientExperiments?.length || 0) + (diff.newGuildHashes?.length || 0) > 0;
  const hasNewUI = (diff.newUI?.length || 0) > 0;
  const hasNewRoutes = (diff.newRoutes?.length || 0) > 0;
  const important = hasNewExp || hasNewUI || hasNewRoutes;

  const embeds = [];

  const main = {
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
    ],
    footer: { text: 'Canary Scraper · Wumpus-style' },
    timestamp: new Date().toISOString(),
  };

  if (build.builtAt) {
    const d = new Date(Number(build.builtAt));
    if (!isNaN(d)) {
      main.fields.push({
        name: 'Built at',
        value: d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        inline: true,
      });
    }
  }

  main.fields.push({
    name: 'Tracked',
    value: `Client exp: **${enriched.length}** · Guild API: **${diff.guildCount || 0}** · UI: **${(clientFindings.ui || []).length}**`,
    inline: false,
  });

  embeds.push(main);

  // New experiments — one embed each (like Discord Previews / your example)
  for (const exp of (diff.newClientExperiments || []).slice(0, 6)) {
    embeds.push(experimentEmbed(exp, build.buildNumber));
  }

  if (diff.newGuildHashes?.length) {
    embeds.push({
      title: 'New Guild Experiment hashes (API)',
      color: 0xFEE75C,
      description: truncate(
        diff.newGuildHashes.map((h) => String(h)),
        15,
      ),
      footer: { text: 'From /api/v10/experiments?with_guild_experiments=true' },
    });
  }

  if (hasNewUI) {
    const lines = diff.newUI
      .slice(0, 12)
      .map((u) => `• \`${u.name}\` (**${u.kind}**)`)
      .join('\n');
    embeds.push({
      title: '🧩 New UI',
      color: 0xF47B67,
      description: lines,
      fields: [{ name: 'Build', value: String(build.buildNumber), inline: true }],
    });
  }

  if (hasNewRoutes) {
    embeds.push({
      title: 'New Routes',
      color: 0x5865F2,
      description: truncate(diff.newRoutes, 15),
    });
  }

  // Snapshot on new build if no “new” experiments
  if (isNewBuild && !hasNewExp && enriched.length) {
    embeds.push({
      title: 'Experiments in this build',
      color: 0x9B59B6,
      description: truncate(enriched.map((e) => e.id), 15),
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

// Fix method binding — enrichWithDefinitions as function
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
      defaultConfig: def.defaultConfig || null,
    };
  });
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log('🔍 Canary scrape (Wumpus / Discord Previews style)\n');

  await fs.ensureDir(DATA_DIR);

  // --- Build metadata ---
  const html = await httpGet(CANARY_APP);
  const env = parseGlobalEnv(html);
  const assetUrls = extractAssetUrls(html);

  const buildNumber = env.BUILD_NUMBER || `hash-${crypto.createHash('sha256').update(html).digest('hex').slice(0, 10)}`;
  console.log(`Build        : ${buildNumber}`);
  console.log(`Version hash : ${env.VERSION_HASH || '—'}`);
  console.log(`Assets links : ${assetUrls.length}`);

  let previousBuild = null;
  try {
    if (await fs.pathExists(BUILD_FILE)) previousBuild = await fs.readJson(BUILD_FILE);
  } catch {}
  const isNewBuild = !previousBuild || previousBuild.buildNumber !== buildNumber;

  // --- Official experiments API ---
  console.log('\n📡 Fetching /api/v10/experiments …');
  let official = { guildExperiments: [], assignmentCount: 0, rawAssignmentHashes: [] };
  try {
    official = await fetchOfficialExperiments();
    console.log(`  Guild experiments : ${official.guildExperiments.length}`);
    console.log(`  Assignments       : ${official.assignmentCount}`);
  } catch (e) {
    console.warn('Experiments API error:', e.message);
  }

  // --- Definitions (labels + variations) ---
  console.log('\n📚 Fetching experiment definitions …');
  const definitions = await fetchDefinitions();
  console.log(`  Definitions : ${definitions.length}`);

  // --- Client assets (only on new build or empty cache) ---
  const needDownload =
    isNewBuild || !(await fs.pathExists(ASSETS_DIR)) || (await fs.readdir(ASSETS_DIR)).length < 5;

  if (needDownload) {
    if (isNewBuild) await fs.emptyDir(ASSETS_DIR);
    console.log('\n📦 Downloading client assets (capped) …');
    // Prefer larger JS first (web.*.js often has experiment tables)
    const sorted = assetUrls.sort((a, b) => {
      const score = (u) => (u.includes('web.') ? 0 : u.endsWith('.js') ? 1 : 2);
      return score(a) - score(b);
    });
    await downloadLimited(sorted, 60);
  } else {
    console.log('\nSame build — reusing cached assets');
  }

  console.log('\n🧠 Analyzing client JS …');
  const clientFindings = await analyzeDownloadedAssets();
  console.log(`  Client experiment IDs : ${clientFindings.experiments.length}`);
  console.log(`  Routes                : ${clientFindings.routes.length}`);
  console.log(`  UI surfaces           : ${clientFindings.ui.length}`);

  const enriched = enrichWithDefinitions(clientFindings.experiments, definitions);

  // --- Previous findings ---
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
    newGuildHashes: official.guildExperiments
      .filter((g) => !prevGuildHashes.has(g.hash))
      .map((g) => g.hash),
    guildCount: official.guildExperiments.length,
  };

  console.log('\n📊 New:');
  console.log(`  Experiments : ${diff.newClientExperiments.length}`);
  console.log(`  Guild hash  : ${diff.newGuildHashes.length}`);
  console.log(`  UI          : ${diff.newUI.length}`);
  console.log(`  Routes      : ${diff.newRoutes.length}`);

  // --- Persist ---
  const build = {
    buildNumber,
    versionHash: env.VERSION_HASH || null,
    builtAt: env.BUILT_AT || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    scrapedAt: new Date().toISOString(),
    assetCount: assetUrls.length,
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
  await fs.writeJson(
    GUILD_EXP_FILE,
    official.guildExperiments.map(({ hash, id, revision, aaMode }) => ({
      hash,
      id,
      revision,
      aaMode,
    })),
    { spaces: 2 },
  );

  await notify({ build, isNewBuild, diff, enriched, clientFindings });

  if (diff.newClientExperiments.length || diff.newGuildHashes.length || diff.newUI.length) {
    console.log('\n🚨 Changes notified');
  } else if (isNewBuild) {
    console.log('\n✅ New build saved');
  } else {
    console.log('\n✅ Up to date');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
