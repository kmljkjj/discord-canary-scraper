/**
 * Discord Canary scraper
 * Strings: strict Wumpus-style i18n (merge partial scans)
 * Routes: Wumpus data/routes.json style
 * Lines: persistent stats in data/asset_stats.json
 * Notify: deduped via notify_guard
 */
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {
  extractUiAndExperiments,
  formatNewUiDescription,
  formatExperimentWithUi,
} = require('./ui_experiments');
const {
  extractStringsFromContent,
  diffStrings,
  formatStringsEmbed,
  fetchWumpusStrings,
  sanitizeStringsMap,
} = require('./strings_extract');
const {
  collectAssetStats,
  diffAssetStats,
  loadStats,
  saveStats,
} = require('./line_diff');
const { log } = require('./logger');
const { claim, wasBuildAnnounced, hashPayload } = require('./notify_guard');
const {
  extractEndpointsFromContent,
  sanitizeRoutesMap,
  diffRoutes,
  formatEndpointsEmbed,
  fetchWumpusRoutes,
} = require('./endpoints_extract');

const CANARY_APP = 'https://canary.discord.com/app';
const EXPERIMENTS_API =
  'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true';

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const STRINGS_FILE = path.join(DATA_DIR, 'strings.json');
const ENDPOINTS_FILE = path.join(DATA_DIR, 'endpoints.json');
const ROUTES_FILE = path.join(DATA_DIR, 'routes.json');
const ASSET_STATS_FILE = path.join(DATA_DIR, 'asset_stats.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const SEED_WUMPUS = process.env.SEED_WUMPUS_STRINGS !== '0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function httpGet(url, asText = true) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return asText ? res.text() : res.json();
}

function parseGlobalEnv(html) {
  const m = html.match(/window\.GLOBAL_ENV\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return {};
  const block = m[1];
  const grab = (key) => {
    const re = new RegExp(`"${key}"\\s*:\\s*"?([^,"}]+)"?`);
    const mm = block.match(re);
    return mm ? mm[1].replace(/^"|"$/g, '').trim() : null;
  };
  return {
    BUILD_NUMBER: grab('BUILD_NUMBER'),
    VERSION_HASH: grab('VERSION_HASH'),
    BUILT_AT: grab('BUILT_AT'),
    RELEASE_CHANNEL: grab('RELEASE_CHANNEL') || 'canary',
  };
}

function extractAssetUrls(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  const add = (href) => {
    if (!href || !href.includes('/assets/')) return;
    urls.add(href.startsWith('http') ? href : `https://canary.discord.com${href}`);
  };
  $('script[src]').each((_, el) => add($(el).attr('src')));
  const re = /\/assets\/([a-zA-Z0-9._-]+\.js)/g;
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
  console.log(`✓ ${name}`);
  return name;
}

async function downloadPriorityAssets(assetUrls) {
  await fs.ensureDir(ASSETS_DIR);
  const web = assetUrls.filter((u) => /\/assets\/web\.[a-f0-9]+\.js/i.test(u));
  const otherJs = assetUrls.filter((u) => u.endsWith('.js') && !/\/assets\/web\./i.test(u));
  const toFetch = [...web, ...otherJs.slice(0, 100)];
  for (const url of toFetch) {
    const name = path.basename(url.split('?')[0]);
    const dest = path.join(ASSETS_DIR, name);
    try {
      if (await fs.pathExists(dest)) {
        const st = await fs.stat(dest);
        if (/^web\./i.test(name) && st.size < 1_000_000) await downloadFile(url);
        else console.log(`· cached ${name}`);
        continue;
      }
      await downloadFile(url);
    } catch (e) {
      console.warn(`✗ ${name}: ${e.message}`);
    }
  }
}

function isExpId(id) {
  return /^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80}$/i.test(id) && !/^20\d{2}-\d{2}$/.test(id);
}

async function analyzeAssets() {
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
      console.log(`  scan ${file}`);
      const linked = extractUiAndExperiments(content);
      extractEndpointsFromContent(content, endpointMap);
      extractStringsFromContent(content, stringMap);
      for (const e of linked.experiments) {
        if (!isExpId(e.id)) continue;
        if (!expMap.has(e.id)) expMap.set(e.id, { ...e });
        else {
          const prev = expMap.get(e.id);
          prev.relatedUI = [
            ...new Set([...(prev.relatedUI || []), ...(e.relatedUI || [])]),
          ].slice(0, 12);
        }
      }
      for (const u of linked.ui) {
        if (!uiMap.has(u.name)) uiMap.set(u.name, { ...u });
        else {
          const prev = uiMap.get(u.name);
          prev.relatedExperiments = [
            ...new Set([
              ...(prev.relatedExperiments || []),
              ...(u.relatedExperiments || []),
            ]),
          ].slice(0, 10);
        }
      }
    } catch (e) {
      console.warn(`  skip ${file}: ${e.message}`);
    }
  }
  return {
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    endpoints: Object.fromEntries(endpointMap),
    ui: [...uiMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    strings: Object.fromEntries(stringMap),
  };
}

async function postWebhook(payload, dedupeKey) {
  if (!WEBHOOK_URL) return false;
  if (dedupeKey) {
    const ok = await claim(dedupeKey);
    if (!ok) {
      await log.info('Webhook skipped (duplicate)', { dedupeKey });
      return false;
    }
  }
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    await log.warn('Webhook failed', { status: res.status, text: text.slice(0, 200) });
  } else {
    await log.info('Webhook sent', { dedupeKey: dedupeKey || null, status: res.status });
  }
  await new Promise((r) => setTimeout(r, 250));
  return res.ok;
}

function countKeys(obj) {
  return Object.keys(obj || {}).length;
}

async function notify({ build, isNewBuild, diff, stringDiff, endpointDiff, lineDiff }) {
  if (!WEBHOOK_URL) return;

  const hasNewUI = (diff.newUI || []).length > 0;
  const hasNewExp =
    (diff.newClientExperiments || []).length + (diff.newGuild || []).length > 0;
  const hasStrings =
    countKeys(stringDiff.added) +
      countKeys(stringDiff.removed) +
      countKeys(stringDiff.modified) >
    0;
  const hasEndpoints =
    countKeys(endpointDiff.added) +
      countKeys(endpointDiff.removed) +
      countKeys(endpointDiff.modified || {}) >
    0;

  const hasContent = hasNewExp || hasNewUI || hasStrings || hasEndpoints;

  if (!isNewBuild && !hasContent) {
    await log.info('No notify (same build, no content delta)');
    return;
  }

  // Only show lines when the delta is meaningful (not wholesale asset rename +69545/−69544)
  const showLines =
    isNewBuild &&
    lineDiff &&
    !lineDiff.skipped &&
    lineDiff.meaningful !== false &&
    ((lineDiff.added || 0) + (lineDiff.removed || 0) > 0) &&
    !lineDiff.wholesale;
  const added = showLines ? lineDiff.added : 0;
  const removed = showLines ? lineDiff.removed : 0;
  const alreadyAnnounced = isNewBuild && (await wasBuildAnnounced(build.buildNumber));

  // One build card max per build — never spam empty "Canary Build Details"
  const shouldBuildCard =
    (isNewBuild && !alreadyAnnounced) ||
    (!isNewBuild && hasContent) ||
    (isNewBuild && alreadyAnnounced && hasContent);

  if (isNewBuild && alreadyAnnounced && !hasContent) {
    await log.info('Skip empty build details (already announced)', {
      build: build.buildNumber,
    });
  } else if (shouldBuildCard) {
    const deltaParts = [
      hasNewExp ? `Experiments +${(diff.newClientExperiments || []).length}` : null,
      hasStrings
        ? `Strings +${countKeys(stringDiff.added)}/−${countKeys(stringDiff.removed)}/~${countKeys(stringDiff.modified)}`
        : null,
      hasEndpoints
        ? `Endpoints +${countKeys(endpointDiff.added)}/−${countKeys(endpointDiff.removed)}/~${countKeys(endpointDiff.modified || {})}`
        : null,
      hasNewUI ? `UI +${(diff.newUI || []).length}` : null,
      showLines ? `Lines +${added}/−${removed}` : null,
    ].filter(Boolean);

    const title = isNewBuild
      ? alreadyAnnounced
        ? 'Canary Build Details'
        : 'New Discord Canary Build'
      : 'Canary Changes';

    await postWebhook(
      {
        username: 'Canary Scraper',
        embeds: [
          {
            title,
            color: hasNewExp ? 0xed4245 : 0x57f287,
            fields: [
              { name: 'Build', value: String(build.buildNumber), inline: true },
              { name: 'Channel', value: 'canary', inline: true },
              {
                name: 'Lines',
                value: showLines
                  ? `+${added} · −${removed}`
                  : isNewBuild
                    ? lineDiff && lineDiff.wholesale
                      ? 'assets refreshed'
                      : '—'
                    : '—',
                inline: true,
              },
              {
                name: 'Delta',
                value: deltaParts.join('\n') || (isNewBuild ? 'Build bump' : '—'),
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      },
      `build-card:${build.buildNumber}`,
    );
  }

  if (hasStrings) {
    const emb = formatStringsEmbed(stringDiff, build.buildNumber);
    if (emb) {
      await postWebhook(
        { username: 'Canary Scraper', embeds: [emb] },
        `strings:${build.buildNumber}:${hashPayload(stringDiff)}`,
      );
    }
  }

  if (hasEndpoints) {
    const emb = formatEndpointsEmbed(endpointDiff, build.buildNumber);
    if (emb) {
      await postWebhook(
        { username: 'Canary Scraper', embeds: [emb] },
        `endpoints:${build.buildNumber}:${hashPayload(endpointDiff)}`,
      );
    }
  }

  for (const exp of (diff.newClientExperiments || []).slice(0, 10)) {
    await postWebhook(
      {
        username: 'Canary Scraper',
        embeds: [formatExperimentWithUi(exp, build.buildNumber)],
      },
      `exp:${build.buildNumber}:${exp.id}`,
    );
  }

  if (hasNewUI) {
    await postWebhook(
      {
        username: 'Canary Scraper',
        embeds: [
          {
            title: 'New UI',
            color: 0xf47b67,
            description: formatNewUiDescription(diff.newUI, build.buildNumber),
            timestamp: new Date().toISOString(),
          },
        ],
      },
      `ui:${build.buildNumber}:${hashPayload(diff.newUI)}`,
    );
  }
}

async function main() {
  await log.info('scrape start');
  console.log('🔍 Canary scrape\n');
  await fs.ensureDir(DATA_DIR);
  const html = await httpGet(CANARY_APP);
  const env = parseGlobalEnv(html);
  const assetUrls = extractAssetUrls(html);
  const buildNumber =
    env.BUILD_NUMBER ||
    `hash-${crypto.createHash('sha256').update(html).digest('hex').slice(0, 10)}`;
  console.log('Build', buildNumber);
  await log.info('build detected', { buildNumber });

  let previousBuild = null;
  try {
    if (await fs.pathExists(BUILD_FILE)) previousBuild = await fs.readJson(BUILD_FILE);
  } catch {}
  const isNewBuild = !previousBuild || previousBuild.buildNumber !== buildNumber;

  // Persist build number ASAP so the next run does not re-announce
  await fs.writeJson(
    BUILD_FILE,
    {
      buildNumber,
      versionHash: env.VERSION_HASH || null,
      releaseChannel: env.RELEASE_CHANNEL || 'canary',
      scrapedAt: new Date().toISOString(),
      _partial: true,
    },
    { spaces: 2 },
  ); // early-write-build

  try {
    await httpGet(EXPERIMENTS_API, false);
  } catch (e) {
    console.warn('experiments API', e.message);
  }

  const prevAssetStats = await loadStats(ASSET_STATS_FILE);

  const webUrl = assetUrls.find((u) => /\/web\.[a-f0-9]+\.js/i.test(u));
  const webName = webUrl ? path.basename(webUrl.split('?')[0]) : null;
  let webOk = false;
  if (webName) {
    const webPath = path.join(ASSETS_DIR, webName);
    if (await fs.pathExists(webPath)) webOk = (await fs.stat(webPath)).size > 2_000_000;
  }

  if (isNewBuild || !webOk) {
    if (isNewBuild) await fs.emptyDir(ASSETS_DIR);
    await downloadPriorityAssets(assetUrls);
  }

  const currAssetStats = await collectAssetStats(ASSETS_DIR);
  let lineDiff = { added: 0, removed: 0, skipped: true, changedFiles: 0 };
  if (isNewBuild) {
    lineDiff = diffAssetStats(prevAssetStats, currAssetStats);
    await log.info('line diff', lineDiff);
  } else {
    await log.info('Lines skipped (same build)');
  }

  await saveStats(ASSET_STATS_FILE, currAssetStats, buildNumber);

  const findings = await analyzeAssets();
  findings.strings = sanitizeStringsMap(findings.strings);
  findings.endpoints = sanitizeRoutesMap(findings.endpoints);

  let diskRouteCount = 0;
  try {
    if (await fs.pathExists(ROUTES_FILE)) {
      diskRouteCount = Object.keys(await fs.readJson(ROUTES_FILE)).length;
    }
  } catch {}
  if (diskRouteCount < 50 && Object.keys(findings.endpoints).length < 50) {
    await log.info('Seeding routes from Wumpus routes.json…');
    const wr = await fetchWumpusRoutes(fetch);
    if (wr) {
      let merged = 0;
      for (const [k, v] of Object.entries(wr)) {
        if (!(k in findings.endpoints)) {
          findings.endpoints[k] = v;
          merged++;
        }
      }
      findings.endpoints = sanitizeRoutesMap(findings.endpoints);
      await log.info('Merged Wumpus routes (one-time seed)', {
        merged,
        total: Object.keys(findings.endpoints).length,
      });
    }
  }

  let diskStringCount = 0;
  try {
    if (await fs.pathExists(STRINGS_FILE)) {
      diskStringCount = Object.keys(await fs.readJson(STRINGS_FILE)).length;
    }
  } catch {}
  if (SEED_WUMPUS && diskStringCount < 100 && Object.keys(findings.strings).length < 500) {
    const wumpus = await fetchWumpusStrings(fetch);
    if (wumpus) {
      let merged = 0;
      for (const [k, v] of Object.entries(wumpus)) {
        if (!(k in findings.strings)) {
          findings.strings[k] = v;
          merged++;
        }
      }
      findings.strings = sanitizeStringsMap(findings.strings);
      await log.info('Merged Wumpus strings (one-time seed)', {
        merged,
        total: Object.keys(findings.strings).length,
      });
    }
  }

  console.log(
    'Experiments',
    findings.experiments.length,
    'UI',
    findings.ui.length,
    'Strings',
    Object.keys(findings.strings).length,
    'Routes',
    Object.keys(findings.endpoints).length,
  );

  let previous = null;
  try {
    if (await fs.pathExists(FINDINGS_FILE)) previous = await fs.readJson(FINDINGS_FILE);
  } catch {}
  const prevExpIds = new Set((previous?.experiments || []).map((e) => e.id));
  const prevUI = new Set((previous?.ui || []).map((u) => u.name));
  const currExpIds = new Set(findings.experiments.map((e) => e.id));
  const currUI = new Set(findings.ui.map((u) => u.name));

  const diff = {
    newClientExperiments: findings.experiments.filter((e) => !prevExpIds.has(e.id)),
    removedExperiments: (previous?.experiments || []).filter((e) => !currExpIds.has(e.id)),
    newUI: findings.ui.filter((u) => !prevUI.has(u.name)),
    removedUI: (previous?.ui || []).filter((u) => !currUI.has(u.name)),
    newGuild: [],
  };

  let prevStrings = {};
  try {
    if (await fs.pathExists(STRINGS_FILE)) prevStrings = await fs.readJson(STRINGS_FILE);
  } catch {}
  const cleanedPrev = sanitizeStringsMap(prevStrings);
  const extracted = sanitizeStringsMap(findings.strings);

  const mergedStrings = { ...cleanedPrev, ...extracted };
  findings.strings = mergedStrings;

  const stringDiff = diffStrings(cleanedPrev, mergedStrings);
  if (Object.keys(extracted).length < 500) {
    if (countKeys(stringDiff.removed) > 0) {
      await log.info('Strings: ignore removals (partial scan)', {
        extracted: Object.keys(extracted).length,
        removedIgnored: countKeys(stringDiff.removed),
      });
    }
    stringDiff.removed = {};
  }
  if (countKeys(stringDiff.added) > 500 && Object.keys(cleanedPrev).length < 100) {
    await log.info('Strings baseline seed — skip notify flood');
    stringDiff.added = {};
    stringDiff.removed = {};
    stringDiff.modified = {};
  }

  await fs.writeJson(STRINGS_FILE, findings.strings, { spaces: 2 });

  let prevEndpoints = {};
  try {
    if (await fs.pathExists(ROUTES_FILE)) prevEndpoints = await fs.readJson(ROUTES_FILE);
    else if (await fs.pathExists(ENDPOINTS_FILE)) prevEndpoints = await fs.readJson(ENDPOINTS_FILE);
  } catch {}
  prevEndpoints = sanitizeRoutesMap(prevEndpoints);
  const extractedRoutes = sanitizeRoutesMap(findings.endpoints);
  const mergedRoutes = { ...prevEndpoints, ...extractedRoutes };
  findings.endpoints = mergedRoutes;

  const endpointDiff = diffRoutes(prevEndpoints, mergedRoutes);
  if (Object.keys(extractedRoutes).length < 30) {
    if (countKeys(endpointDiff.removed) > 0) {
      await log.info('Routes: ignore removals (partial scan)', {
        extracted: Object.keys(extractedRoutes).length,
      });
    }
    endpointDiff.removed = {};
  }
  if (
    Object.keys(prevEndpoints).length < 50 ||
    (countKeys(endpointDiff.added) > 200 && Object.keys(prevEndpoints).length < 50)
  ) {
    await log.info('Routes baseline — skip endpoint notify flood');
    endpointDiff.added = {};
    endpointDiff.removed = {};
    endpointDiff.modified = {};
  }

  await fs.writeJson(ROUTES_FILE, findings.endpoints, { spaces: 2 });
  await fs.writeJson(ENDPOINTS_FILE, findings.endpoints, { spaces: 2 });

  const build = {
    buildNumber,
    versionHash: env.VERSION_HASH || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    scrapedAt: new Date().toISOString(),
    experimentCount: findings.experiments.length,
    stringCount: Object.keys(findings.strings).length,
    routeCount: Object.keys(findings.endpoints).length,
    lineDiff: {
      added: lineDiff.added || 0,
      removed: lineDiff.removed || 0,
      skipped: !!lineDiff.skipped,
      wholesale: !!lineDiff.wholesale,
    },
  };
  await fs.writeJson(BUILD_FILE, build, { spaces: 2 });
  await fs.writeJson(
    FINDINGS_FILE,
    {
      experiments: findings.experiments,
      endpoints: findings.endpoints,
      ui: findings.ui,
      scrapedAt: build.scrapedAt,
    },
    { spaces: 2 },
  );

  await log.info('scrape summary', {
    isNewBuild,
    linesAdded: lineDiff.added || 0,
    linesRemoved: lineDiff.removed || 0,
    stringsAdded: countKeys(stringDiff.added),
    stringsRemoved: countKeys(stringDiff.removed),
    routesAdded: countKeys(endpointDiff.added),
    routesRemoved: countKeys(endpointDiff.removed),
  });
  await notify({ build, isNewBuild, diff, stringDiff, endpointDiff, lineDiff });
  await log.info('scrape done');
  console.log('✅ Done');
}

if (require.main === module) {
  main().catch(async (e) => {
    await log.error('scrape failed', { err: String(e.message || e) });
    console.error(e);
    process.exit(1);
  });
}
