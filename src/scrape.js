const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const CANARY_URL = 'https://canary.discord.com/app';
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

// ─────────────────────────────────────────────
// Fetch & extract assets
// ─────────────────────────────────────────────

async function getPage() {
  const res = await fetch(CANARY_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch Canary page: ${res.status}`);
  return res.text();
}

function extractAssets(html) {
  const $ = cheerio.load(html);
  const assets = {
    scripts: [],
    styles: [],
    buildNumber: null,
    releaseChannel: 'canary',
  };

  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && src.includes('/assets/')) {
      assets.scripts.push(src.startsWith('http') ? src : `https://canary.discord.com${src}`);
    }
  });

  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/assets/')) {
      assets.styles.push(href.startsWith('http') ? href : `https://canary.discord.com${href}`);
    }
  });

  const scriptsText = $('script:not([src])').map((_, el) => $(el).html()).get().join('\n');

  const buildMatch =
    scriptsText.match(/BUILD_NUMBER["']?\s*[:=]\s*["']?(\d+)/i) ||
    scriptsText.match(/buildNumber["']?\s*[:=]\s*["']?(\d+)/i) ||
    scriptsText.match(/"build_number"\s*:\s*"?(\d+)/i);

  if (buildMatch) {
    assets.buildNumber = buildMatch[1];
  } else {
    const hash = crypto
      .createHash('sha256')
      .update([...assets.scripts, ...assets.styles].sort().join('|'))
      .digest('hex')
      .slice(0, 12);
    assets.buildNumber = `hash-${hash}`;
  }

  return assets;
}

async function downloadFile(url, dest) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) {
    console.warn(`Failed to download ${url}: ${res.status}`);
    return false;
  }
  const buffer = await res.buffer();
  await fs.ensureDir(path.dirname(dest));
  await fs.writeFile(dest, buffer);
  return true;
}

async function downloadAssets(assets) {
  await fs.emptyDir(ASSETS_DIR);
  const downloaded = [];

  for (const url of [...assets.scripts, ...assets.styles]) {
    const filename = path.basename(url.split('?')[0]);
    const dest = path.join(ASSETS_DIR, filename);
    const ok = await downloadFile(url, dest);
    if (ok) {
      downloaded.push(filename);
      console.log(`✓ ${filename}`);
    }
  }
  return downloaded;
}

// ─────────────────────────────────────────────
// Experiment / Route / String analysis
// Real Discord experiment IDs look like:
//   2026-08-profile-embed-share-button
//   2025-05_push_to_talk_latching
//   2026-04-mltargetingv6
// ─────────────────────────────────────────────

function isValidExperimentId(id) {
  if (!id || id.length < 10 || id.length > 90) return false;
  // Must start with year-month
  if (!/^20[2-3][0-9]-[0-1][0-9][_-]/.test(id)) return false;
  // Avoid pure noise
  if (/^20[0-9]{2}-[0-9]{2}$/.test(id)) return false;
  return true;
}

function analyzeJSContent(content) {
  const experiments = new Map(); // id -> { id, type, isApex }
  const routes = new Set();
  const strings = new Set();

  // ── Primary experiment ID pattern (YYYY-MM_xxx or YYYY-MM-xxx)
  const idRegex = /["'](20[2-3][0-9]-[0-1][0-9][_-][a-z0-9_\-]{4,70})["']/gi;
  let m;
  while ((m = idRegex.exec(content)) !== null) {
    const id = m[1].toLowerCase();
    if (!isValidExperimentId(id)) continue;

    const isApex =
      id.includes('apex') ||
      id.includes('-aa-') ||
      /_aa_/.test(id);

    if (!experiments.has(id)) {
      experiments.set(id, { id, type: 'user', isApex });
    }
  }

  // ── Try to associate type (user / guild) near the ID
  // Look for nearby kind/type/unit_type
  for (const [id, exp] of experiments) {
    const idx = content.toLowerCase().indexOf(id);
    if (idx === -1) continue;
    const window = content.slice(Math.max(0, idx - 300), idx + id.length + 400);

    if (/["'](?:kind|type|unit_type)["']\s*[:=]\s*["']guild["']/i.test(window) ||
        /guild[_-]?experiment/i.test(window)) {
      exp.type = 'guild';
    } else if (/["'](?:kind|type|unit_type)["']\s*[:=]\s*["']user["']/i.test(window)) {
      exp.type = 'user';
    } else if (/apex_user|unit_type.{0,5}1/i.test(window)) {
      exp.type = 'user';
      exp.isApex = true;
    } else if (/apex_guild|unit_type.{0,5}3/i.test(window)) {
      exp.type = 'guild';
      exp.isApex = true;
    }
  }

  // ── Routes
  const routePatterns = [
    /["'](\/api\/v\d+\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /["'](\/channels\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /["'](\/guilds\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /["'](\/users\/@me\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /path:\s*["'](\/[a-z0-9_\-\/{}.:]+)["']/gi,
  ];

  for (const re of routePatterns) {
    while ((m = re.exec(content)) !== null) {
      const r = m[1];
      if (r.length > 5 && r.length < 120) routes.add(r);
    }
  }

  // ── Interesting strings
  const keywords = [
    'nitro', 'boost', 'quest', 'gift', 'premium', 'hypesquad',
    'voice', 'video', 'stream', 'stage', 'forum', 'thread',
    'profile', 'banner', 'avatar', 'activity', 'status',
    'payment', 'billing', 'subscription', 'trial', 'shop',
    'moderation', 'automod', 'timeout', 'role', 'permission',
  ];

  const strRegex = /["']([A-Za-z][A-Za-z0-9 _\-]{6,55})["']/g;
  while ((m = strRegex.exec(content)) !== null) {
    const s = m[1].trim();
    const lower = s.toLowerCase();
    if (keywords.some(k => lower.includes(k)) && !/^20[0-9]{2}/.test(s)) {
      strings.add(s);
    }
  }

  const allExps = [...experiments.values()];
  return {
    apexExperiments: allExps.filter(e => e.isApex),
    experiments: allExps.filter(e => !e.isApex),
    routes: [...routes].sort(),
    strings: [...strings].sort().slice(0, 80),
  };
}

async function analyzeAssets() {
  const files = await fs.readdir(ASSETS_DIR);
  const jsFiles = files.filter(f => f.endsWith('.js'));

  const apexMap = new Map();
  const expMap = new Map();
  const routes = new Set();
  const strings = new Set();

  for (const file of jsFiles) {
    try {
      const content = await fs.readFile(path.join(ASSETS_DIR, file), 'utf8');
      const sample = content.length > 2_500_000 ? content.slice(0, 2_000_000) : content;
      const found = analyzeJSContent(sample);

      for (const e of found.apexExperiments) apexMap.set(e.id, e);
      for (const e of found.experiments) {
        if (!apexMap.has(e.id)) expMap.set(e.id, e);
      }
      found.routes.forEach(r => routes.add(r));
      found.strings.forEach(s => strings.add(s));
    } catch (err) {
      console.warn(`Could not analyze ${file}:`, err.message);
    }
  }

  return {
    apexExperiments: [...apexMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    routes: [...routes].sort(),
    strings: [...strings].sort().slice(0, 100),
  };
}

// ─────────────────────────────────────────────
// Diff
// ─────────────────────────────────────────────

async function loadPreviousFindings() {
  try {
    if (await fs.pathExists(FINDINGS_FILE)) return await fs.readJson(FINDINGS_FILE);
  } catch (e) {}
  return null;
}

function diffFindings(current, previous) {
  if (!previous) {
    return {
      newApexExperiments: current.apexExperiments,
      newExperiments: current.experiments,
      newRoutes: current.routes,
      newStrings: current.strings.slice(0, 15),
      isFirstRun: true,
    };
  }

  const prevApex = new Set((previous.apexExperiments || []).map(e => (typeof e === 'string' ? e : e.id)));
  const prevExp = new Set((previous.experiments || []).map(e => (typeof e === 'string' ? e : e.id)));
  const prevRoutes = new Set(previous.routes || []);
  const prevStrings = new Set(previous.strings || []);

  return {
    newApexExperiments: current.apexExperiments.filter(e => !prevApex.has(e.id)),
    newExperiments: current.experiments.filter(e => !prevExp.has(e.id)),
    newRoutes: current.routes.filter(r => !prevRoutes.has(r)),
    newStrings: current.strings.filter(s => !prevStrings.has(s)).slice(0, 20),
    isFirstRun: false,
  };
}

function hasImportantChanges(diff) {
  return (
    (diff.newApexExperiments && diff.newApexExperiments.length > 0) ||
    (diff.newExperiments && diff.newExperiments.length > 0) ||
    (diff.newRoutes && diff.newRoutes.length > 0)
  );
}

// ─────────────────────────────────────────────
// Discord embeds – clean format
// ─────────────────────────────────────────────

function formatExperimentEmbed(exp, buildNumber, isApex) {
  const title = isApex ? 'New Apex Experiment' : 'New Experiment';
  const color = isApex ? 0xFEE75C : 0xEB459E;

  return {
    title,
    color,
    fields: [
      { name: 'Name', value: `\`${exp.id}\``, inline: false },
      { name: 'Type', value: exp.type || 'user', inline: true },
      { name: 'Build', value: String(buildNumber), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

function truncateList(arr, max = 12) {
  if (!arr || arr.length === 0) return '—';
  const shown = arr.slice(0, max).map(x => `• \`${x}\``);
  if (arr.length > max) shown.push(`… +${arr.length - max} more`);
  return shown.join('\n');
}

async function sendWebhook({ buildInfo, diff, isNewBuild }) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL set – skipping notification');
    return;
  }

  const important = hasImportantChanges(diff);
  const embeds = [];

  // Summary embed
  const mainColor = important ? 0xED4245 : isNewBuild ? 0x57F287 : 0x5865F2;
  let mainTitle = 'ℹ️ Discord Canary Check';
  if (important) mainTitle = '🚨 Important Canary Changes';
  else if (isNewBuild) mainTitle = '🚀 New Discord Canary Build';

  const main = {
    title: mainTitle,
    color: mainColor,
    fields: [
      { name: 'Build', value: String(buildInfo.buildNumber), inline: true },
      { name: 'Channel', value: 'Canary', inline: true },
      { name: 'Assets', value: String(buildInfo.assetCount || 0), inline: true },
    ],
    footer: { text: 'Canary Scraper' },
    timestamp: new Date().toISOString(),
  };

  if (diff.isFirstRun) {
    main.description = 'First run — baseline saved. Next runs will only report **new** items.';
  }

  embeds.push(main);

  // One embed per new Apex experiment (clean format)
  if (diff.newApexExperiments?.length) {
    for (const exp of diff.newApexExperiments.slice(0, 6)) {
      embeds.push(formatExperimentEmbed(exp, buildInfo.buildNumber, true));
    }
    if (diff.newApexExperiments.length > 6) {
      embeds.push({
        title: 'New Apex Experiments (more)',
        color: 0xFEE75C,
        description: truncateList(diff.newApexExperiments.slice(6).map(e => e.id), 10),
      });
    }
  }

  // One embed per new classic experiment
  if (diff.newExperiments?.length) {
    for (const exp of diff.newExperiments.slice(0, 6)) {
      embeds.push(formatExperimentEmbed(exp, buildInfo.buildNumber, false));
    }
    if (diff.newExperiments.length > 6) {
      embeds.push({
        title: 'New Experiments (more)',
        color: 0xEB459E,
        description: truncateList(diff.newExperiments.slice(6).map(e => e.id), 10),
      });
    }
  }

  if (diff.newRoutes?.length) {
    embeds.push({
      title: 'New Routes',
      color: 0x5865F2,
      description: truncateList(diff.newRoutes, 15),
    });
  }

  if (diff.newStrings?.length && (important || diff.isFirstRun)) {
    embeds.push({
      title: 'Interesting Strings',
      color: 0x57F287,
      description: truncateList(diff.newStrings, 12),
    });
  }

  const body = {
    username: 'Canary Scraper',
    avatar_url: 'https://cdn.discordapp.com/emojis/1044610189761052752.webp',
    embeds: embeds.slice(0, 10),
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn('Webhook failed:', res.status, await res.text());
    else console.log('Webhook notification sent');
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function loadPreviousBuild() {
  try {
    if (await fs.pathExists(BUILD_FILE)) return await fs.readJson(BUILD_FILE);
  } catch (e) {}
  return null;
}

async function saveBuild(info) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(BUILD_FILE, info, { spaces: 2 });
}

async function saveFindings(findings) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(FINDINGS_FILE, findings, { spaces: 2 });
}

async function main() {
  console.log('🔍 Scraping Discord Canary...\n');

  const html = await getPage();
  const assets = extractAssets(html);

  console.log(`Build number : ${assets.buildNumber}`);
  console.log(`Scripts found: ${assets.scripts.length}`);
  console.log(`Styles found : ${assets.styles.length}\n`);

  const previousBuild = await loadPreviousBuild();
  const isNewBuild = !previousBuild || previousBuild.buildNumber !== assets.buildNumber;

  const assetsExist = await fs.pathExists(ASSETS_DIR) && (await fs.readdir(ASSETS_DIR)).length > 0;
  let downloaded = previousBuild?.files || [];

  if (isNewBuild || !assetsExist) {
    console.log(isNewBuild ? '✨ New build – downloading assets...\n' : '📦 Assets missing – downloading...\n');
    downloaded = await downloadAssets(assets);
  } else {
    console.log('Same build – analyzing existing assets.\n');
  }

  console.log('🧠 Analyzing for experiments, routes & strings...\n');
  const currentFindings = await analyzeAssets();

  console.log(`  Apex Experiments : ${currentFindings.apexExperiments.length}`);
  console.log(`  Experiments      : ${currentFindings.experiments.length}`);
  console.log(`  Routes           : ${currentFindings.routes.length}`);
  console.log(`  Strings          : ${currentFindings.strings.length}\n`);

  const previousFindings = await loadPreviousFindings();
  const diff = diffFindings(currentFindings, previousFindings);

  console.log('📊 New items:');
  console.log(`  Apex Exp : ${diff.newApexExperiments.length}`);
  console.log(`  Exp      : ${diff.newExperiments.length}`);
  console.log(`  Routes   : ${diff.newRoutes.length}`);
  console.log(`  Strings  : ${diff.newStrings.length}\n`);

  const buildInfo = {
    buildNumber: assets.buildNumber,
    releaseChannel: 'canary',
    scrapedAt: new Date().toISOString(),
    assetCount: downloaded.length,
    scripts: assets.scripts,
    styles: assets.styles,
    files: downloaded,
  };

  await saveBuild(buildInfo);
  await saveFindings(currentFindings);
  await sendWebhook({ buildInfo, diff, isNewBuild });

  if (hasImportantChanges(diff)) {
    console.log('🚨 Important changes notified.');
  } else if (isNewBuild) {
    console.log('✅ New build archived.');
  } else {
    console.log('✅ Up to date.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
