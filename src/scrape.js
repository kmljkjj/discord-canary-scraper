const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const CANARY_URL = 'https://canary.discord.com/app';
const ASSET_BASE = 'https://canary.discord.com/assets/';
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

// Cap extra webpack chunks so Actions stays under time/disk limits
const MAX_EXTRA_CHUNKS = 250;
const DOWNLOAD_CONCURRENCY = 12;

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
// Fetch page + GLOBAL_ENV + every asset URL
// ─────────────────────────────────────────────

async function getPage() {
  const res = await fetch(CANARY_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch Canary page: ${res.status}`);
  return res.text();
}

function parseGlobalEnv(html) {
  const m = html.match(/window\.GLOBAL_ENV\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    // GLOBAL_ENV can contain Date.now() — neutralize for JSON
    const raw = m[1]
      .replace(/Date\.now\(\)/g, '0')
      .replace(/([{,])\s*([A-Za-z0-9_]+)\s*:/g, '$1"$2":') // naive key quote if needed
      ;
    // Prefer structured extraction over full JSON.parse (safer)
    const env = {};
    const fields = [
      'BUILD_NUMBER', 'VERSION_HASH', 'BUILT_AT', 'RELEASE_CHANNEL', 'PROJECT_ENV',
      'API_ENDPOINT', 'API_VERSION', 'GATEWAY_ENDPOINT', 'GATEWAY_ALT_ENDPOINT',
      'ASSET_ENDPOINT', 'CDN_HOST', 'MEDIA_PROXY_ENDPOINT', 'WEBAPP_ENDPOINT',
      'REMOTE_AUTH_ENDPOINT', 'PUBLIC_PATH', 'SENTRY_RELEASE', 'PRIMARY_DOMAIN',
    ];
    for (const key of fields) {
      const re = new RegExp(`"${key}"\\s*:\\s*"?([^,"}]+)"?`);
      const mm = m[1].match(re);
      if (mm) env[key] = mm[1].replace(/^"|"$/g, '').trim();
    }
    // Numbers without quotes
    const bn = m[1].match(/"BUILD_NUMBER"\s*:\s*"?(\d+)"?/);
    if (bn) env.BUILD_NUMBER = bn[1];
    const ba = m[1].match(/"BUILT_AT"\s*:\s*"?(\d+)"?/);
    if (ba) env.BUILT_AT = ba[1];
    return env;
  } catch (e) {
    console.warn('GLOBAL_ENV parse soft-fail:', e.message);
    return null;
  }
}

function extractAssets(html) {
  const $ = cheerio.load(html);
  const urls = new Set();

  // script src
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && src.includes('/assets/')) {
      urls.add(src.startsWith('http') ? src : `https://canary.discord.com${src}`);
    }
  });

  // stylesheet
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/assets/')) {
      urls.add(href.startsWith('http') ? href : `https://canary.discord.com${href}`);
    }
  });

  // preload / modulepreload / prefetch
  $('link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/assets/')) {
      urls.add(href.startsWith('http') ? href : `https://canary.discord.com${href}`);
    }
  });

  // Any /assets/xxx.js or .css in raw HTML
  const rawAssetRe = /\/assets\/([a-zA-Z0-9._-]+\.(?:js|css))/g;
  let rm;
  while ((rm = rawAssetRe.exec(html)) !== null) {
    urls.add(ASSET_BASE + rm[1]);
  }

  const globalEnv = parseGlobalEnv(html);

  let buildNumber = globalEnv?.BUILD_NUMBER || null;
  if (!buildNumber) {
    const scriptsText = $('script:not([src])').map((_, el) => $(el).html()).get().join('\n');
    const buildMatch =
      scriptsText.match(/BUILD_NUMBER["']?\s*[:=]\s*["']?(\d+)/i) ||
      html.match(/"BUILD_NUMBER"\s*:\s*"?(\d+)/);
    buildNumber = buildMatch ? buildMatch[1] : null;
  }

  if (!buildNumber) {
    const hash = crypto.createHash('sha256').update([...urls].sort().join('|')).digest('hex').slice(0, 12);
    buildNumber = `hash-${hash}`;
  }

  const list = [...urls];
  return {
    scripts: list.filter(u => u.endsWith('.js')),
    styles: list.filter(u => u.endsWith('.css')),
    all: list,
    buildNumber,
    versionHash: globalEnv?.VERSION_HASH || null,
    builtAt: globalEnv?.BUILT_AT || null,
    releaseChannel: globalEnv?.RELEASE_CHANNEL || 'canary',
    globalEnv: globalEnv || {},
  };
}

/** Discover more webpack chunk URLs inside already-downloaded JS */
function discoverChunksFromJS(content, knownBasenames) {
  const found = new Set();

  // /assets/12345.abcdef.js or assets/web.hash.js
  const re1 = /["']\/?assets\/([a-zA-Z0-9._-]+\.js)["']/g;
  let m;
  while ((m = re1.exec(content)) !== null) {
    const name = m[1];
    if (!knownBasenames.has(name)) found.add(ASSET_BASE + name);
  }

  // Webpack style: + "12345." + { ... } or chunk maps "id":"hash"
  // Pattern: digits.hash.js in strings
  const re2 = /["'](\d{2,6}\.[a-f0-9]{8,16}\.js)["']/g;
  while ((m = re2.exec(content)) !== null) {
    const name = m[1];
    if (!knownBasenames.has(name)) found.add(ASSET_BASE + name);
  }

  // function(e){return""+e+"."+{...}[e]+".js"} style hashes
  const mapMatch = content.match(/\.([a-f0-9]{8,16})\.js["']/g);
  // already covered by re1/re2 mostly

  return [...found];
}

async function downloadFile(url, dest) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 30000,
    });
    if (!res.ok) return false;
    const buffer = await res.buffer();
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, buffer);
    return true;
  } catch {
    return false;
  }
}

async function mapPool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function downloadAssets(urls) {
  await fs.ensureDir(ASSETS_DIR);
  const downloaded = [];
  const unique = [...new Set(urls)];

  await mapPool(unique, DOWNLOAD_CONCURRENCY, async (url) => {
    const filename = path.basename(url.split('?')[0]);
    const dest = path.join(ASSETS_DIR, filename);
    if (await fs.pathExists(dest)) {
      downloaded.push(filename);
      return;
    }
    const ok = await downloadFile(url, dest);
    if (ok) {
      downloaded.push(filename);
      console.log(`✓ ${filename}`);
    } else {
      console.warn(`✗ ${filename}`);
    }
  });

  return downloaded;
}

async function expandWebpackChunks(seedUrls) {
  const known = new Set(seedUrls.map(u => path.basename(u.split('?')[0])));
  const extra = new Set();

  const files = await fs.readdir(ASSETS_DIR);
  for (const file of files.filter(f => f.endsWith('.js'))) {
    try {
      const content = await fs.readFile(path.join(ASSETS_DIR, file), 'utf8');
      const sample = content.length > 3_000_000 ? content.slice(0, 2_500_000) : content;
      for (const u of discoverChunksFromJS(sample, known)) {
        const base = path.basename(u);
        if (!known.has(base) && !extra.has(u)) {
          extra.add(u);
          if (extra.size >= MAX_EXTRA_CHUNKS) break;
        }
      }
    } catch {}
    if (extra.size >= MAX_EXTRA_CHUNKS) break;
  }

  if (extra.size === 0) return [];
  console.log(`\n📦 Discovering ${extra.size} extra webpack chunks...\n`);
  return downloadAssets([...extra]);
}

// ─────────────────────────────────────────────
// Analysis
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
  const endpoints = new Set();
  const flags = new Set();

  // Experiment IDs YYYY-MM-name
  const idRegex = /["'](20[2-3][0-9]-[0-1][0-9][_-][a-z0-9_\-]{4,70})["']/gi;
  let m;
  while ((m = idRegex.exec(content)) !== null) {
    const id = m[1].toLowerCase();
    if (!isValidExperimentId(id)) continue;
    const isApex = id.includes('apex') || id.includes('-aa-') || /_aa_/.test(id);
    if (!experiments.has(id)) experiments.set(id, { id, type: 'user', isApex });
  }

  for (const [id, exp] of experiments) {
    const idx = content.toLowerCase().indexOf(id);
    if (idx === -1) continue;
    const window = content.slice(Math.max(0, idx - 300), idx + id.length + 400);
    if (/["'](?:kind|type|unit_type)["']\s*[:=]\s*["']guild["']/i.test(window) || /guild[_-]?experiment/i.test(window)) {
      exp.type = 'guild';
    } else if (/apex_user|unit_type.{0,5}1/i.test(window)) {
      exp.type = 'user';
      exp.isApex = true;
    } else if (/apex_guild|unit_type.{0,5}3/i.test(window)) {
      exp.type = 'guild';
      exp.isApex = true;
    }
  }

  // Routes / API paths
  const routePatterns = [
    /["'](\/api\/v\d+\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /["'](\/channels\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /["'](\/guilds\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /["'](\/users\/@me\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /["'](\/quests\/[a-z0-9_\-\/{}.:]+)["']/gi,
    /path:\s*["'](\/[a-z0-9_\-\/{}.:]+)["']/gi,
  ];
  for (const re of routePatterns) {
    while ((m = re.exec(content)) !== null) {
      if (m[1].length > 5 && m[1].length < 120) routes.add(m[1]);
    }
  }

  // Endpoints / hosts
  const epRe = /["']((?:https?:)?\/\/[a-z0-9.-]*(?:discord|discordapp)[a-z0-9.-]*\/[a-z0-9_\-\/.]*)["']/gi;
  while ((m = epRe.exec(content)) !== null) {
    if (m[1].length < 120) endpoints.add(m[1]);
  }

  // Feature-flag-ish keys
  const flagRe = /["']((?:enable|disable|use|show|hide|is|has)[A-Z][A-Za-z0-9]{4,40})["']/g;
  while ((m = flagRe.exec(content)) !== null) flags.add(m[1]);

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
    if (keywords.some(k => lower.includes(k)) && !/^20[0-9]{2}/.test(s)) strings.add(s);
  }

  const pascalRe = /["']([A-Z][A-Za-z0-9]{4,55})["']/g;
  while ((m = pascalRe.exec(content)) !== null) {
    const name = m[1];
    if (!looksLikeUIComponent(name) || uiItems.has(name)) continue;
    let kind = 'component';
    if (/Modal|Dialog/i.test(name)) kind = 'modal';
    else if (/Panel|Sidebar|Drawer|Sheet/i.test(name)) kind = 'panel';
    else if (/Popout|Popover|Tooltip|Dropdown|Menu/i.test(name)) kind = 'overlay';
    else if (/Banner|Toast|Snackbar/i.test(name)) kind = 'banner';
    else if (/Button|Toggle|Switch|Input|Form/i.test(name)) kind = 'control';
    uiItems.set(name, {
      name, kind,
      where: extractContext(content, m.index, name) || 'client (unknown area)',
      file: sourceFile || null,
    });
  }

  const displayRe = /displayName\s*[:=]\s*["']([A-Za-z0-9_]{5,55})["']/g;
  while ((m = displayRe.exec(content)) !== null) {
    const name = m[1];
    if ((!looksLikeUIComponent(name) && !/Modal|Panel|Popout|Sheet|Drawer/i.test(name)) || uiItems.has(name)) continue;
    let kind = 'component';
    if (/Modal|Dialog/i.test(name)) kind = 'modal';
    else if (/Panel|Sidebar|Drawer|Sheet/i.test(name)) kind = 'panel';
    else if (/Popout|Popover|Tooltip|Menu/i.test(name)) kind = 'overlay';
    uiItems.set(name, {
      name, kind,
      where: extractContext(content, m.index, name) || 'client (unknown area)',
      file: sourceFile || null,
    });
  }

  const allExps = [...experiments.values()];
  return {
    apexExperiments: allExps.filter(e => e.isApex),
    experiments: allExps.filter(e => !e.isApex),
    routes: [...routes].sort(),
    strings: [...strings].sort().slice(0, 100),
    ui: [...uiItems.values()],
    endpoints: [...endpoints].sort().slice(0, 80),
    flags: [...flags].sort().slice(0, 80),
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
  const endpoints = new Set();
  const flags = new Set();

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
      found.endpoints.forEach(e => endpoints.add(e));
      found.flags.forEach(f => flags.add(f));
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
    strings: [...strings].sort().slice(0, 120),
    ui: [...uiMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    endpoints: [...endpoints].sort().slice(0, 100),
    flags: [...flags].sort().slice(0, 100),
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
      newEndpoints: (current.endpoints || []).slice(0, 20),
      newFlags: (current.flags || []).slice(0, 20),
      isFirstRun: true,
    };
  }

  const prevApex = new Set((previous.apexExperiments || []).map(e => (typeof e === 'string' ? e : e.id)));
  const prevExp = new Set((previous.experiments || []).map(e => (typeof e === 'string' ? e : e.id)));
  const prevRoutes = new Set(previous.routes || []);
  const prevStrings = new Set(previous.strings || []);
  const prevUI = new Set((previous.ui || []).map(u => (typeof u === 'string' ? u : u.name)));
  const prevEp = new Set(previous.endpoints || []);
  const prevFlags = new Set(previous.flags || []);

  return {
    newApexExperiments: current.apexExperiments.filter(e => !prevApex.has(e.id)),
    newExperiments: current.experiments.filter(e => !prevExp.has(e.id)),
    newRoutes: current.routes.filter(r => !prevRoutes.has(r)),
    newStrings: current.strings.filter(s => !prevStrings.has(s)).slice(0, 20),
    newUI: (current.ui || []).filter(u => !prevUI.has(u.name)).slice(0, 30),
    newEndpoints: (current.endpoints || []).filter(e => !prevEp.has(e)).slice(0, 25),
    newFlags: (current.flags || []).filter(f => !prevFlags.has(f)).slice(0, 25),
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
  return {
    title: isApex ? 'New Apex Experiment' : 'New Experiment',
    color: isApex ? 0xFEE75C : 0xEB459E,
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
  if (uiList.length > 12) lines.push(`… +${uiList.length - 12} more`);

  return {
    title,
    description: title.includes('New')
      ? 'Discord a ajouté de la **UI** dans ce build.'
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
      { name: 'Channel', value: buildInfo.releaseChannel || 'canary', inline: true },
      { name: 'Assets', value: String(buildInfo.assetCount || 0), inline: true },
    ],
    footer: { text: 'Canary Scraper · max extraction' },
    timestamp: new Date().toISOString(),
  };

  if (buildInfo.versionHash) {
    main.fields.push({ name: 'Version Hash', value: `\`${buildInfo.versionHash.slice(0, 12)}…\``, inline: true });
  }
  if (buildInfo.builtAt) {
    const d = new Date(Number(buildInfo.builtAt));
    if (!isNaN(d.getTime())) {
      main.fields.push({ name: 'Built at', value: d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC', inline: true });
    }
  }

  if (diff.isFirstRun) main.description = 'First run — baseline saved.';
  if (diff.newUI?.length) {
    main.description = (main.description ? main.description + '\n\n' : '') +
      `🧩 **${diff.newUI.length} new UI item(s)** detected.`;
  }

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

  if (diff.newUI?.length) embeds.push(formatUIEmbed(diff.newUI, buildInfo.buildNumber, '🧩 New UI detected'));

  if (diff.newApexExperiments?.length) {
    for (const exp of diff.newApexExperiments.slice(0, 4)) {
      embeds.push(formatExperimentEmbed(exp, buildInfo.buildNumber, true));
    }
  }
  if (diff.newExperiments?.length) {
    for (const exp of diff.newExperiments.slice(0, 4)) {
      embeds.push(formatExperimentEmbed(exp, buildInfo.buildNumber, false));
    }
  }
  if (diff.newRoutes?.length) {
    embeds.push({ title: 'New Routes', color: 0x5865F2, description: truncateList(diff.newRoutes, 15) });
  }
  if (diff.newEndpoints?.length) {
    embeds.push({ title: 'New Endpoints', color: 0x1ABC9C, description: truncateList(diff.newEndpoints, 10) });
  }
  if (diff.newFlags?.length && important) {
    embeds.push({ title: 'New Flags / toggles', color: 0xE67E22, description: truncateList(diff.newFlags, 12) });
  }
  if (diff.newStrings?.length && (important || diff.isFirstRun)) {
    embeds.push({ title: 'Interesting Strings', color: 0x57F287, description: truncateList(diff.newStrings, 12) });
  }

  if (isNewBuild && currentFindings && embeds.length < 9) {
    const allExp = [...(currentFindings.apexExperiments || []), ...(currentFindings.experiments || [])];
    if (allExp.length) {
      embeds.push({
        title: 'Experiments in this build',
        color: 0x9B59B6,
        description: truncateList(allExp.map(e => e.id), 15),
      });
    }
    const uiList = currentFindings.ui || [];
    if (uiList.length && !diff.newUI?.length && embeds.length < 9) {
      embeds.push(formatUIEmbed(uiList.slice(0, 12), buildInfo.buildNumber, '🧩 UI in this build'));
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

async function saveMeta(meta) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(META_FILE, meta, { spaces: 2 });
}

async function main() {
  console.log('🔍 Scraping Discord Canary (max extraction)...\n');

  const html = await getPage();
  const assets = extractAssets(html);

  console.log(`Build number  : ${assets.buildNumber}`);
  console.log(`Version hash  : ${assets.versionHash || '—'}`);
  console.log(`Release       : ${assets.releaseChannel}`);
  console.log(`Scripts+CSS   : ${assets.all.length}\n`);

  const previousBuild = await loadPreviousBuild();
  const isNewBuild = !previousBuild || previousBuild.buildNumber !== assets.buildNumber;

  const assetsExist = await fs.pathExists(ASSETS_DIR) && (await fs.readdir(ASSETS_DIR)).length > 0;
  let downloaded = previousBuild?.files || [];

  if (isNewBuild || !assetsExist) {
    if (isNewBuild) await fs.emptyDir(ASSETS_DIR);
    console.log(isNewBuild ? '✨ New build – downloading assets...\n' : '📦 Assets missing – downloading...\n');
    downloaded = await downloadAssets(assets.all);
    // Second pass: webpack chunks referenced inside JS
    const extra = await expandWebpackChunks(assets.all);
    downloaded = [...new Set([...downloaded, ...extra])];
  } else {
    console.log('Same build – analyzing existing assets.\n');
  }

  console.log('🧠 Analyzing experiments, routes, UI, endpoints, flags...\n');
  const currentFindings = await analyzeAssets();

  console.log(`  Apex Experiments : ${currentFindings.apexExperiments.length}`);
  console.log(`  Experiments      : ${currentFindings.experiments.length}`);
  console.log(`  Routes           : ${currentFindings.routes.length}`);
  console.log(`  Endpoints        : ${(currentFindings.endpoints || []).length}`);
  console.log(`  Flags            : ${(currentFindings.flags || []).length}`);
  console.log(`  Strings          : ${currentFindings.strings.length}`);
  console.log(`  UI items         : ${(currentFindings.ui || []).length}\n`);

  const previousFindings = await loadPreviousFindings();
  const diff = diffFindings(currentFindings, previousFindings);

  console.log('📊 New items:');
  console.log(`  Apex Exp : ${diff.newApexExperiments.length}`);
  console.log(`  Exp      : ${diff.newExperiments.length}`);
  console.log(`  Routes   : ${diff.newRoutes.length}`);
  console.log(`  Endpoints: ${(diff.newEndpoints || []).length}`);
  console.log(`  Flags    : ${(diff.newFlags || []).length}`);
  console.log(`  UI       : ${diff.newUI.length}\n`);

  const buildInfo = {
    buildNumber: assets.buildNumber,
    versionHash: assets.versionHash,
    builtAt: assets.builtAt,
    releaseChannel: assets.releaseChannel,
    scrapedAt: new Date().toISOString(),
    assetCount: downloaded.length,
    scripts: assets.scripts,
    styles: assets.styles,
    files: downloaded,
  };

  await saveBuild(buildInfo);
  await saveFindings(currentFindings);
  await saveMeta({
    globalEnv: assets.globalEnv,
    scrapedAt: buildInfo.scrapedAt,
    buildNumber: assets.buildNumber,
    versionHash: assets.versionHash,
  });
  await sendWebhook({ buildInfo, diff, isNewBuild, currentFindings });

  if (hasImportantChanges(diff)) console.log('🚨 Important changes notified.');
  else if (isNewBuild) console.log('✅ New build archived + snapshot sent.');
  else console.log('✅ Up to date.');

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
