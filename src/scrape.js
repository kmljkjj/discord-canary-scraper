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

// UI keywords → often signal Discord is shipping a real feature surface
const UI_KEYWORDS = [
  'Modal', 'Panel', 'Sidebar', 'Drawer', 'Sheet', 'Overlay', 'Popout',
  'Tooltip', 'Popover', 'Dropdown', 'Menu', 'Banner', 'Toast', 'Snackbar',
  'Dialog', 'Card', 'TabBar', 'Toolbar', 'Header', 'Footer', 'Layout',
  'Button', 'Input', 'Form', 'Toggle', 'Switch', 'Slider', 'Badge',
  'Avatar', 'Profile', 'Settings', 'Channel', 'Guild', 'Member',
  'Quest', 'Shop', 'Store', 'Nitro', 'Gift', 'Boost', 'Premium',
  'Voice', 'Video', 'Stream', 'Stage', 'Forum', 'Thread', 'Message',
  'Inbox', 'Notification', 'Activity', 'Status', 'Presence',
  'Call', 'ScreenShare', 'GoLive', 'Camera', 'Mic',
];

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
// Experiment / Route / String / UI analysis
// ─────────────────────────────────────────────

function isValidExperimentId(id) {
  if (!id || id.length < 10 || id.length > 90) return false;
  if (!/^20[2-3][0-9]-[0-1][0-9][_-]/.test(id)) return false;
  if (/^20[0-9]{2}-[0-9]{2}$/.test(id)) return false;
  return true;
}

function looksLikeUIComponent(name) {
  if (!name || name.length < 5 || name.length > 60) return false;
  if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) return false;
  return UI_KEYWORDS.some(k => name.includes(k));
}

function extractContext(content, index, id) {
  const start = Math.max(0, index - 400);
  const end = Math.min(content.length, index + id.length + 500);
  const window = content.slice(start, end);

  const hints = [];

  const expNear = window.match(/["'](20[2-3][0-9]-[0-1][0-9][_-][a-z0-9_\-]{4,50})["']/i);
  if (expNear) hints.push(`exp: ${expNear[1]}`);

  const routeNear = window.match(/["'](\/(?:channels|guilds|users|quests|settings|activities)[a-z0-9_\-\/{}.:]*)["']/i);
  if (routeNear) hints.push(`route: ${routeNear[1]}`);

  const dn = window.match(/displayName\s*[:=]\s*["']([A-Za-z0-9_]+)["']/);
  if (dn) hints.push(`component: ${dn[1]}`);

  const layer = window.match(/["']((?:user|guild|channel|message|voice|video|settings|profile|shop|quest)[_-]?[a-z0-9_-]{2,30})["']/i);
  if (layer) hints.push(`area: ${layer[1]}`);

  return hints.slice(0, 3).join(' · ') || null;
}

function analyzeJSContent(content, sourceFile) {
  const experiments = new Map();
  const routes = new Set();
  const strings = new Set();
  const uiItems = new Map();

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

  const pascalRe = /["']([A-Z][A-Za-z0-9]{4,55})["']/g;
  while ((m = pascalRe.exec(content)) !== null) {
    const name = m[1];
    if (!looksLikeUIComponent(name)) continue;
    if (uiItems.has(name)) continue;

    let kind = 'component';
    if (/Modal|Dialog/i.test(name)) kind = 'modal';
    else if (/Panel|Sidebar|Drawer|Sheet/i.test(name)) kind = 'panel';
    else if (/Popout|Popover|Tooltip|Dropdown|Menu/i.test(name)) kind = 'overlay';
    else if (/Banner|Toast|Snackbar/i.test(name)) kind = 'banner';
    else if (/Button|Toggle|Switch|Input|Form/i.test(name)) kind = 'control';

    const where = extractContext(content, m.index, name);
    uiItems.set(name, {
      name,
      kind,
      where: where || 'client (unknown area)',
      file: sourceFile || null,
    });
  }

  const displayRe = /displayName\s*[:=]\s*["']([A-Za-z0-9_]{5,55})["']/g;
  while ((m = displayRe.exec(content)) !== null) {
    const name = m[1];
    if (!looksLikeUIComponent(name) && !/Modal|Panel|Popout|Sheet|Drawer/i.test(name)) continue;
    if (uiItems.has(name)) continue;

    let kind = 'component';
    if (/Modal|Dialog/i.test(name)) kind = 'modal';
    else if (/Panel|Sidebar|Drawer|Sheet/i.test(name)) kind = 'panel';
    else if (/Popout|Popover|Tooltip|Menu/i.test(name)) kind = 'overlay';

    const where = extractContext(content, m.index, name);
    uiItems.set(name, {
      name,
      kind,
      where: where || 'client (unknown area)',
      file: sourceFile || null,
    });
  }

  const cssUiRe = /["']((?:[a-z]+[A-Z][A-Za-z0-9]*)?(?:Modal|Panel|Sidebar|Drawer|Sheet|Popout|Overlay|Banner)[A-Za-z0-9]*)["']/g;
  while ((m = cssUiRe.exec(content)) !== null) {
    const name = m[1];
    if (name.length < 6 || name.length > 50) continue;
    if (uiItems.has(name)) continue;

    let kind = 'ui-class';
    if (/Modal/i.test(name)) kind = 'modal';
    else if (/Panel|Sidebar|Drawer|Sheet/i.test(name)) kind = 'panel';
    else if (/Popout|Overlay/i.test(name)) kind = 'overlay';
    else if (/Banner/i.test(name)) kind = 'banner';

    const where = extractContext(content, m.index, name);
    uiItems.set(name, {
      name,
      kind,
      where: where || 'client (unknown area)',
      file: sourceFile || null,
    });
  }

  const allExps = [...experiments.values()];
  return {
    apexExperiments: allExps.filter(e => e.isApex),
    experiments: allExps.filter(e => !e.isApex),
    routes: [...routes].sort(),
    strings: [...strings].sort().slice(0, 80),
    ui: [...uiItems.values()],
  };
}

async function analyzeAssets() {
  const files = await fs.readdir(ASSETS_DIR);
  const jsFiles = files.filter(f => f.endsWith('.js'));

  const apexMap = new Map();
  const expMap = new Map();
  const routes = new Set();
  const strings = new Set();
  const uiMap = new Map();

  for (const file of jsFiles) {
    try {
      const content = await fs.readFile(path.join(ASSETS_DIR, file), 'utf8');
      const sample = content.length > 2_500_000 ? content.slice(0, 2_000_000) : content;
      const found = analyzeJSContent(sample, file);

      for (const e of found.apexExperiments) apexMap.set(e.id, e);
      for (const e of found.experiments) {
        if (!apexMap.has(e.id)) expMap.set(e.id, e);
      }
      found.routes.forEach(r => routes.add(r));
      found.strings.forEach(s => strings.add(s));
      for (const u of found.ui) {
        if (!uiMap.has(u.name)) uiMap.set(u.name, u);
      }
    } catch (err) {
      console.warn(`Could not analyze ${file}:`, err.message);
    }
  }

  return {
    apexExperiments: [...apexMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    routes: [...routes].sort(),
    strings: [...strings].sort().slice(0, 100),
    ui: [...uiMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
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
      newUI: (current.ui || []).slice(0, 25),
      isFirstRun: true,
    };
  }

  const prevApex = new Set((previous.apexExperiments || []).map(e => (typeof e === 'string' ? e : e.id)));
  const prevExp = new Set((previous.experiments || []).map(e => (typeof e === 'string' ? e : e.id)));
  const prevRoutes = new Set(previous.routes || []);
  const prevStrings = new Set(previous.strings || []);
  const prevUI = new Set((previous.ui || []).map(u => (typeof u === 'string' ? u : u.name)));

  return {
    newApexExperiments: current.apexExperiments.filter(e => !prevApex.has(e.id)),
    newExperiments: current.experiments.filter(e => !prevExp.has(e.id)),
    newRoutes: current.routes.filter(r => !prevRoutes.has(r)),
    newStrings: current.strings.filter(s => !prevStrings.has(s)).slice(0, 20),
    newUI: (current.ui || []).filter(u => !prevUI.has(u.name)).slice(0, 30),
    isFirstRun: false,
  };
}

function hasImportantChanges(diff) {
  return (
    (diff.newApexExperiments && diff.newApexExperiments.length > 0) ||
    (diff.newExperiments && diff.newExperiments.length > 0) ||
    (diff.newRoutes && diff.newRoutes.length > 0) ||
    (diff.newUI && diff.newUI.length > 0)
  );
}

// ─────────────────────────────────────────────
// Discord embeds
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

function formatUIEmbed(uiList, buildNumber, title = '🧩 New UI detected') {
  const lines = uiList.slice(0, 12).map(u => {
    const kind = u.kind ? `**${u.kind}**` : 'ui';
    const where = u.where ? ` → _${u.where}_` : '';
    return `• \`${u.name}\` (${kind})${where}`;
  });

  if (uiList.length > 12) {
    lines.push(`… +${uiList.length - 12} more`);
  }

  return {
    title,
    description:
      title.includes('New')
        ? 'Discord a ajouté de la **UI** dans ce build — souvent signe d’une vraie feature en cours.'
        : 'UI détectée dans ce build (aperçu).',
    color: 0xF47B67,
    fields: [
      { name: 'Build', value: String(buildNumber), inline: true },
      { name: 'Count', value: String(uiList.length), inline: true },
      { name: 'Items', value: lines.join('\n').slice(0, 1000) || '—', inline: false },
    ],
    footer: { text: 'UI = modal / panel / overlay / control…' },
    timestamp: new Date().toISOString(),
  };
}

function truncateList(arr, max = 12) {
  if (!arr || arr.length === 0) return '—';
  const shown = arr.slice(0, max).map(x => `• \`${typeof x === 'string' ? x : x.id || x.name || x}\``);
  if (arr.length > max) shown.push(`… +${arr.length - max} more`);
  return shown.join('\n');
}

async function sendWebhook({ buildInfo, diff, isNewBuild, currentFindings }) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL set – skipping notification');
    return;
  }

  const important = hasImportantChanges(diff);
  const embeds = [];

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
    main.description = 'First run — baseline saved.';
  }

  if (diff.newUI?.length) {
    main.description = (main.description ? main.description + '\n\n' : '') +
      `🧩 **${diff.newUI.length} new UI item(s)** detected in this build.`;
  }

  // Summary counts always useful on new builds
  if (isNewBuild && currentFindings) {
    const nApex = (currentFindings.apexExperiments || []).length;
    const nExp = (currentFindings.experiments || []).length;
    const nUi = (currentFindings.ui || []).length;
    const nRoutes = (currentFindings.routes || []).length;
    main.fields.push({
      name: 'In this build',
      value: `Experiments: **${nApex + nExp}** · UI: **${nUi}** · Routes: **${nRoutes}**`,
      inline: false,
    });
  }

  embeds.push(main);

  // Truly NEW items first (high signal)
  if (diff.newUI?.length) {
    embeds.push(formatUIEmbed(diff.newUI, buildInfo.buildNumber, '🧩 New UI detected'));
  }

  if (diff.newApexExperiments?.length) {
    for (const exp of diff.newApexExperiments.slice(0, 5)) {
      embeds.push(formatExperimentEmbed(exp, buildInfo.buildNumber, true));
    }
    if (diff.newApexExperiments.length > 5) {
      embeds.push({
        title: 'New Apex Experiments (more)',
        color: 0xFEE75C,
        description: truncateList(diff.newApexExperiments.slice(5).map(e => e.id), 10),
      });
    }
  }

  if (diff.newExperiments?.length) {
    for (const exp of diff.newExperiments.slice(0, 5)) {
      embeds.push(formatExperimentEmbed(exp, buildInfo.buildNumber, false));
    }
    if (diff.newExperiments.length > 5) {
      embeds.push({
        title: 'New Experiments (more)',
        color: 0xEB459E,
        description: truncateList(diff.newExperiments.slice(5).map(e => e.id), 10),
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

  // On NEW BUILD: always also show snapshot of what's in the build
  // (even if already known — so you see experiments / UI / routes every time)
  if (isNewBuild && currentFindings && embeds.length < 9) {
    const allExp = [
      ...(currentFindings.apexExperiments || []),
      ...(currentFindings.experiments || []),
    ];
    if (allExp.length && !diff.newApexExperiments?.length && !diff.newExperiments?.length) {
      embeds.push({
        title: 'Experiments in this build',
        color: 0xEB459E,
        description: truncateList(allExp.map(e => e.id), 15),
        footer: { text: 'Snapshot — already known, listed because new build' },
      });
    } else if (allExp.length && embeds.length < 9) {
      embeds.push({
        title: 'All experiments in this build',
        color: 0x9B59B6,
        description: truncateList(allExp.map(e => e.id), 12),
      });
    }

    const uiList = currentFindings.ui || [];
    if (uiList.length && !diff.newUI?.length && embeds.length < 9) {
      embeds.push(formatUIEmbed(uiList.slice(0, 15), buildInfo.buildNumber, '🧩 UI in this build'));
    }

    const routes = currentFindings.routes || [];
    if (routes.length && !diff.newRoutes?.length && embeds.length < 9) {
      embeds.push({
        title: 'Routes sample (this build)',
        color: 0x5865F2,
        description: truncateList(routes, 12),
      });
    }
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

  console.log('🧠 Analyzing for experiments, routes, strings & UI...\n');
  const currentFindings = await analyzeAssets();

  console.log(`  Apex Experiments : ${currentFindings.apexExperiments.length}`);
  console.log(`  Experiments      : ${currentFindings.experiments.length}`);
  console.log(`  Routes           : ${currentFindings.routes.length}`);
  console.log(`  Strings          : ${currentFindings.strings.length}`);
  console.log(`  UI items         : ${(currentFindings.ui || []).length}\n`);

  const previousFindings = await loadPreviousFindings();
  const diff = diffFindings(currentFindings, previousFindings);

  console.log('📊 New items:');
  console.log(`  Apex Exp : ${diff.newApexExperiments.length}`);
  console.log(`  Exp      : ${diff.newExperiments.length}`);
  console.log(`  Routes   : ${diff.newRoutes.length}`);
  console.log(`  Strings  : ${diff.newStrings.length}`);
  console.log(`  UI       : ${diff.newUI.length}\n`);

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
  await sendWebhook({ buildInfo, diff, isNewBuild, currentFindings });

  if (hasImportantChanges(diff)) {
    console.log('🚨 Important changes notified.');
  } else if (isNewBuild) {
    console.log('✅ New build archived + snapshot sent.');
  } else {
    console.log('✅ Up to date.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
