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
// Deep analysis of JS assets
// ─────────────────────────────────────────────

function analyzeJSContent(content) {
  const findings = {
    experiments: new Set(),
    apexExperiments: new Set(),
    routes: new Set(),
    strings: new Set(),
  };

  // ── Experiments (classic)
  // Patterns like: experimentId: "2024-xx_..." or id: "..._experiment"
  const expPatterns = [
    /["']([a-z0-9_\-]{8,80}_experiment)["']/gi,
    /["'](experiment_[a-z0-9_\-]{4,60})["']/gi,
    /["']([0-9]{4}-[0-9]{2}_[a-z0-9_\-]{5,50})["']/gi,
    /experimentId["']?\s*[:=]\s*["']([a-z0-9_\-]{6,80})["']/gi,
    /["']id["']\s*:\s*["']([a-z0-9_\-]{10,80})["'][^}]{0,200}kind["']?\s*:\s*["'](user|guild)/gi,
  ];

  for (const re of expPatterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const id = (m[1] || m[0]).toLowerCase();
      if (id.length > 6 && id.length < 90) findings.experiments.add(id);
    }
  }

  // ── Apex Experiments (newer system)
  // Often contain "apex" or specific apex experiment patterns
  const apexPatterns = [
    /["']([a-z0-9_\-]*apex[a-z0-9_\-]*)["']/gi,
    /["'](apex_[a-z0-9_\-]{4,60})["']/gi,
    /apexExperiment["']?\s*[:=]\s*["']([a-z0-9_\-]{4,80})["']/gi,
    /["']([0-9]{4}-[0-9]{2}_[a-z0-9_\-]*apex[a-z0-9_\-]*)["']/gi,
  ];

  for (const re of apexPatterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const id = (m[1] || '').toLowerCase();
      if (id.length > 4 && id.length < 90) {
        findings.apexExperiments.add(id);
        findings.experiments.delete(id); // avoid duplicate in both
      }
    }
  }

  // ── Routes (API + client)
  const routePatterns = [
    /["'](\/api\/v[0-9]+\/[a-z0-9_\-\/{}:]+)["']/gi,
    /["'](\/channels\/[a-z0-9_\-\/{}:]+)["']/gi,
    /["'](\/guilds\/[a-z0-9_\-\/{}:]+)["']/gi,
    /["'](\/users\/[a-z0-9_\-\/{}:]+)["']/gi,
    /path:\s*["'](\/[a-z0-9_\-\/{}:]+)["']/gi,
    /route:\s*["']([a-z0-9_\-\/{}:]+)["']/gi,
  ];

  for (const re of routePatterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const r = m[1];
      if (r.length > 3 && r.length < 120 && !r.includes('http')) {
        findings.routes.add(r);
      }
    }
  }

  // ── Interesting strings (UI / feature related)
  // Look for longer quoted strings that look like feature names or labels
  const stringPatterns = [
    /["']([A-Z][a-zA-Z0-9 ]{8,60})["']/g, // Title Case phrases
    /["']([a-z]+_[a-z0-9_]{6,40})["']/g,   // snake_case identifiers
  ];

  const interestingKeywords = [
    'nitro', 'boost', 'quest', 'gift', 'premium', 'hypesquad',
    'voice', 'video', 'stream', 'stage', 'forum', 'thread',
    'role', 'permission', 'moderation', 'automod', 'timeout',
    'server', 'guild', 'channel', 'category', 'emoji', 'sticker',
    'profile', 'banner', 'avatar', 'status', 'activity',
    'payment', 'billing', 'subscription', 'trial',
    'experiment', 'feature', 'flag', 'rollout',
  ];

  for (const re of stringPatterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const s = m[1];
      const lower = s.toLowerCase();
      if (interestingKeywords.some(k => lower.includes(k)) && s.length > 6 && s.length < 70) {
        findings.strings.add(s);
      }
    }
  }

  return {
    experiments: [...findings.experiments].sort(),
    apexExperiments: [...findings.apexExperiments].sort(),
    routes: [...findings.routes].sort(),
    strings: [...findings.strings].sort().slice(0, 80), // limit noise
  };
}

async function analyzeAssets() {
  const files = await fs.readdir(ASSETS_DIR);
  const jsFiles = files.filter(f => f.endsWith('.js'));

  const all = {
    experiments: new Set(),
    apexExperiments: new Set(),
    routes: new Set(),
    strings: new Set(),
  };

  for (const file of jsFiles) {
    try {
      const content = await fs.readFile(path.join(ASSETS_DIR, file), 'utf8');
      // Skip huge minified noise by sampling if too big
      const sample = content.length > 2_000_000 ? content.slice(0, 1_500_000) : content;
      const found = analyzeJSContent(sample);

      found.experiments.forEach(e => all.experiments.add(e));
      found.apexExperiments.forEach(e => all.apexExperiments.add(e));
      found.routes.forEach(r => all.routes.add(r));
      found.strings.forEach(s => all.strings.add(s));
    } catch (err) {
      console.warn(`Could not analyze ${file}:`, err.message);
    }
  }

  return {
    experiments: [...all.experiments].sort(),
    apexExperiments: [...all.apexExperiments].sort(),
    routes: [...all.routes].sort(),
    strings: [...all.strings].sort().slice(0, 100),
  };
}

// ─────────────────────────────────────────────
// Diff against previous findings
// ─────────────────────────────────────────────

async function loadPreviousFindings() {
  try {
    if (await fs.pathExists(FINDINGS_FILE)) {
      return await fs.readJson(FINDINGS_FILE);
    }
  } catch (e) {}
  return null;
}

function diffFindings(current, previous) {
  if (!previous) {
    return {
      newExperiments: current.experiments,
      newApexExperiments: current.apexExperiments,
      newRoutes: current.routes,
      newStrings: current.strings.slice(0, 20),
      isFirstRun: true,
    };
  }

  const prevExp = new Set(previous.experiments || []);
  const prevApex = new Set(previous.apexExperiments || []);
  const prevRoutes = new Set(previous.routes || []);
  const prevStrings = new Set(previous.strings || []);

  return {
    newExperiments: current.experiments.filter(e => !prevExp.has(e)),
    newApexExperiments: current.apexExperiments.filter(e => !prevApex.has(e)),
    newRoutes: current.routes.filter(r => !prevRoutes.has(r)),
    newStrings: current.strings.filter(s => !prevStrings.has(s)).slice(0, 25),
    isFirstRun: false,
  };
}

function hasImportantChanges(diff) {
  return (
    diff.newApexExperiments.length > 0 ||
    diff.newExperiments.length > 0 ||
    diff.newRoutes.length > 0 ||
    diff.newStrings.length > 3
  );
}

// ─────────────────────────────────────────────
// Discord notifications
// ─────────────────────────────────────────────

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
  const color = important ? 0xED4245 : isNewBuild ? 0x57F287 : 0x5865F2;

  let title;
  if (important) title = '🚨 Important Canary Changes Detected';
  else if (isNewBuild) title = '🚀 New Discord Canary Build';
  else title = 'ℹ️ Discord Canary Check';

  const embeds = [];

  // Main embed
  const main = {
    title,
    color,
    fields: [
      { name: 'Build', value: String(buildInfo.buildNumber), inline: true },
      { name: 'Channel', value: 'Canary', inline: true },
      { name: 'Assets', value: String(buildInfo.assetCount || 0), inline: true },
    ],
    footer: { text: 'Discord Canary Scraper • Inspired by Wumpus Central' },
    timestamp: new Date().toISOString(),
  };

  if (diff.isFirstRun) {
    main.description = 'First run – baseline findings saved. Future runs will report only **new** items.';
  }

  embeds.push(main);

  // Detailed embeds only when there is something new & important
  if (important || diff.isFirstRun) {
    if (diff.newApexExperiments?.length) {
      embeds.push({
        title: '🧪 New Apex Experiments',
        color: 0xFEE75C,
        description: truncateList(diff.newApexExperiments, 15),
      });
    }

    if (diff.newExperiments?.length) {
      embeds.push({
        title: '🔬 New Experiments',
        color: 0xEB459E,
        description: truncateList(diff.newExperiments, 15),
      });
    }

    if (diff.newRoutes?.length) {
      embeds.push({
        title: '🛣️ New Routes',
        color: 0x5865F2,
        description: truncateList(diff.newRoutes, 15),
      });
    }

    if (diff.newStrings?.length) {
      embeds.push({
        title: '📝 New / Interesting Strings',
        color: 0x57F287,
        description: truncateList(diff.newStrings, 12),
      });
    }
  }

  // Discord allows max 10 embeds
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

  // Always download when new build, or if assets folder is empty
  const assetsExist = await fs.pathExists(ASSETS_DIR) && (await fs.readdir(ASSETS_DIR)).length > 0;
  let downloaded = previousBuild?.files || [];

  if (isNewBuild || !assetsExist) {
    console.log(isNewBuild ? '✨ New build detected! Downloading assets...\n' : '📦 Assets missing – downloading...\n');
    downloaded = await downloadAssets(assets);
  } else {
    console.log('No new build number – using existing assets for analysis.\n');
  }

  // Analyze
  console.log('🧠 Analyzing JS assets for experiments, routes & strings...\n');
  const currentFindings = await analyzeAssets();

  console.log(`  Experiments     : ${currentFindings.experiments.length}`);
  console.log(`  Apex Experiments: ${currentFindings.apexExperiments.length}`);
  console.log(`  Routes          : ${currentFindings.routes.length}`);
  console.log(`  Strings         : ${currentFindings.strings.length}\n`);

  const previousFindings = await loadPreviousFindings();
  const diff = diffFindings(currentFindings, previousFindings);

  console.log('📊 Diff vs previous:');
  console.log(`  New Apex Exp    : ${diff.newApexExperiments.length}`);
  console.log(`  New Experiments : ${diff.newExperiments.length}`);
  console.log(`  New Routes      : ${diff.newRoutes.length}`);
  console.log(`  New Strings     : ${diff.newStrings.length}\n`);

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

  const important = hasImportantChanges(diff);
  await sendWebhook({ buildInfo, diff, isNewBuild });

  if (important) {
    console.log('🚨 Important changes detected and notified!');
  } else if (isNewBuild) {
    console.log('✅ New build archived (no major experiment/route changes).');
  } else {
    console.log('✅ Everything up to date.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
