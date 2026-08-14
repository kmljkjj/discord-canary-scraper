/**
 * Discord Canary scraper — Wumpus Central + Discord Previews style
 *
 * Critical: experiment IDs live mainly in web.<hash>.js (~10MB).
 * We ALWAYS download + FULL-scan that file (no 2MB truncate).
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

/** Always grab web.*.js first — that's where ~270+ experiment IDs live */
async function downloadPriorityAssets(assetUrls) {
  await fs.ensureDir(ASSETS_DIR);
  const web = assetUrls.filter((u) => /\/assets\/web\.[a-f0-9]+\.js/i.test(u));
  const otherJs = assetUrls.filter(
    (u) => u.endsWith('.js') && !/\/assets\/web\./i.test(u),
  );
  // Prefer entry-like / large named bundles next
  otherJs.sort((a, b) => {
    const score = (u) => {
      const n = path.basename(u);
      if (n.startsWith('chunk') || n.includes('vendor')) return 2;
      if (n.length > 20) return 0;
      return 1;
    };
    return score(a) - score(b);
  });

  const toFetch = [...web, ...otherJs.slice(0, 40)];
  const got = [];
  for (const url of toFetch) {
    const name = path.basename(url.split('?')[0]);
    const dest = path.join(ASSETS_DIR, name);
    try {
      if (await fs.pathExists(dest)) {
        const st = await fs.stat(dest);
        // Re-download web.js if suspiciously small (< 1MB)
        if (/^web\./i.test(name) && st.size < 1_000_000) {
          await downloadFile(url);
        } else {
          console.log(`· cached ${name}`);
        }
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

function decodeGuildExperiment(raw) {
  return {
    hash: raw[0],
    id: raw[1] ?? null,
    revision: raw[2],
    aaMode: raw[raw.length - 1] === 1,
  };
}

async function fetchOfficialExperiments() {
  const data = await httpGetJson(EXPERIMENTS_API);
  return {
    guildExperiments: (data.guild_experiments || []).map(decodeGuildExperiment),
    assignmentCount: (data.assignments || []).length,
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

function isExpId(id) {
  // 2025-11-foo / 2026-08-profile-embed-share-button
  if (!/^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80}$/i.test(id)) return false;
  // reject pure dates
  if (/^20\d{2}-\d{2}$/.test(id)) return false;
  return true;
}

function analyzeClientJS(content) {
  const experiments = new Map();
  const routes = new Set();
  const ui = new Map();

  // Full-file scan — do NOT truncate
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

  // Underscore variant: 2026_08_foo (rare)
  const idRe2 = /["'](20[2-3]\d_[0-1]\d_[a-z0-9_]{3,80})["']/gi;
  while ((m = idRe2.exec(content)) !== null) {
    const id = m[1].toLowerCase().replace(/_/g, '-').replace(/^(\d{4})-(\d{2})-/, '$1-$2-');
    // normalize 2026-08-...
    const norm = m[1].toLowerCase().replace(/_/g, '-');
    if (!isExpId(norm)) continue;
    if (!experiments.has(norm)) {
      experiments.set(norm, {
        id: norm,
        type: /guild/i.test(norm) ? 'guild' : 'user',
        isApex: /apex|_aa_|-aa-/i.test(norm),
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
    return { experiments: [], routes: [], ui: [] };
  }
  const files = (await fs.readdir(ASSETS_DIR)).filter((f) => f.endsWith('.js'));
  // Analyze web.* FIRST and fully
  files.sort((a, b) => {
    const wa = /^web\./i.test(a) ? 0 : 1;
    const wb = /^web\./i.test(b) ? 0 : 1;
    return wa - wb;
  });

  const expMap = new Map();
  const routes = new Set();
  const uiMap = new Map();

  for (const file of files) {
    try {
      const full = path.join(ASSETS_DIR, file);
      const st = await fs.stat(full);
      // Read ENTIRE file for experiment extraction (web.js ~11MB is fine)
      let content = await fs.readFile(full, 'utf8');
      // For non-web huge files, still full-scan for IDs only if < 15MB
      if (st.size > 15_000_000 && !/^web\./i.test(file)) {
        content = content.slice(0, 8_000_000);
      }
      console.log(`  scan ${file} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
      const found = analyzeClientJS(content);
      for (const e of found.experiments) expMap.set(e.id, e);
      found.routes.forEach((r) => routes.add(r));
      for (const u of found.ui) uiMap.set(u.name, u);
      if (/^web\./i.test(file)) {
        console.log(`    → ${found.experiments.length} experiment IDs in web bundle`);
      }
    } catch (e) {
      console.warn(`  skip ${file}: ${e.message}`);
    }
  }

  return {
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    routes: [...routes].sort(),
    ui: [...uiMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
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
    fields.push({
      name: 'Variations',
      value: '• Variation 0\n• Variation 1',
      inline: false,
    });
  }
  return {
    title: isApex ? 'New Apex Experiment' : 'New Experiment',
    color: isApex ? 0xFEE75C : 0xEB459E,
    fields,
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
      {
        name: 'Tracked',
        value: `Experiments: **${enriched.length}** · Guild API: **${diff.guildCount || 0}** · UI: **${(clientFindings.ui || []).length}**`,
        inline: false,
      },
    ],
    footer: { text: 'Canary Scraper · full web.js scan' },
    timestamp: new Date().toISOString(),
  };
  embeds.push(main);

  // Newest experiments first in list embeds
  const sortedNew = [...(diff.newClientExperiments || [])].sort((a, b) =>
    b.id.localeCompare(a.id),
  );
  for (const exp of sortedNew.slice(0, 8)) {
    embeds.push(experimentEmbed(exp, build.buildNumber));
  }
  if (sortedNew.length > 8) {
    embeds.push({
      title: `New Experiments (+${sortedNew.length - 8} more)`,
      color: 0xEB459E,
      description: truncate(sortedNew.slice(8).map((e) => e.id), 50),
    });
  }

  if (diff.newGuildHashes?.length) {
    embeds.push({
      title: 'New Guild Experiment hashes (API)',
      color: 0xFEE75C,
      description: truncate(diff.newGuildHashes.map(String), 20),
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

  // Always attach a rich experiment snapshot on new build (recent first)
  if (isNewBuild && enriched.length) {
    const recent = [...enriched].sort((a, b) => b.id.localeCompare(a.id));
    embeds.push({
      title: `Experiments in this build (${enriched.length})`,
      color: 0x9B59B6,
      description: truncate(
        recent.map((e) => e.id),
        60,
      ),
      footer: { text: 'Sorted newest-first · full list in data/findings.json' },
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
  console.log('🔍 Canary scrape — full web.js experiment scan\n');
  await fs.ensureDir(DATA_DIR);

  const html = await httpGet(CANARY_APP);
  const env = parseGlobalEnv(html);
  const assetUrls = extractAssetUrls(html);
  const buildNumber =
    env.BUILD_NUMBER ||
    `hash-${crypto.createHash('sha256').update(html).digest('hex').slice(0, 10)}`;

  console.log(`Build        : ${buildNumber}`);
  console.log(`Version hash : ${env.VERSION_HASH || '—'}`);
  console.log(`Asset URLs   : ${assetUrls.length}`);
  const webUrl = assetUrls.find((u) => /\/web\.[a-f0-9]+\.js/i.test(u));
  console.log(`web bundle   : ${webUrl ? path.basename(webUrl) : 'NOT FOUND'}`);

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

  console.log('\n📚 Definitions gist …');
  const definitions = await fetchDefinitions();
  console.log(`  Definitions : ${definitions.length}`);

  // Always ensure web.js is present & full — even on same build if missing/small
  const webName = webUrl ? path.basename(webUrl.split('?')[0]) : null;
  const webPath = webName ? path.join(ASSETS_DIR, webName) : null;
  let webOk = false;
  if (webPath && (await fs.pathExists(webPath))) {
    const st = await fs.stat(webPath);
    webOk = st.size > 2_000_000;
  }

  if (isNewBuild || !webOk) {
    if (isNewBuild) await fs.emptyDir(ASSETS_DIR);
    console.log('\n📦 Downloading priority assets (web.js first) …');
    await downloadPriorityAssets(assetUrls);
  } else {
    console.log('\nSame build + web.js OK — reusing cache');
  }

  console.log('\n🧠 Full-scan JS for experiment IDs …');
  const clientFindings = await analyzeDownloadedAssets();
  console.log(`  TOTAL experiments : ${clientFindings.experiments.length}`);
  console.log(`  Routes               : ${clientFindings.routes.length}`);
  console.log(`  UI                   : ${clientFindings.ui.length}`);

  // Show newest IDs in logs
  const newest = [...clientFindings.experiments]
    .map((e) => e.id)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 15);
  console.log('  Newest IDs:', newest.join(', '));

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
    newGuildHashes: official.guildExperiments
      .filter((g) => !prevGuildHashes.has(g.hash))
      .map((g) => g.hash),
    guildCount: official.guildExperiments.length,
  };

  console.log('\n📊 New vs previous:');
  console.log(`  Experiments : ${diff.newClientExperiments.length}`);
  console.log(`  Guild hash  : ${diff.newGuildHashes.length}`);
  console.log(`  UI          : ${diff.newUI.length}`);
  console.log(`  Routes      : ${diff.newRoutes.length}`);

  const build = {
    buildNumber,
    versionHash: env.VERSION_HASH || null,
    builtAt: env.BUILT_AT || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    scrapedAt: new Date().toISOString(),
    assetCount: assetUrls.length,
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
