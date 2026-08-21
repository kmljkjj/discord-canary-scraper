/**
 * Discord Canary scraper
 * Strings: strict Wumpus-style i18n only (no hashes / build numbers)
 * Lines: JS asset diff on NEW build only
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

const CANARY_APP = 'https://canary.discord.com/app';
const EXPERIMENTS_API =
  'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true';

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const PREV_ASSETS_DIR = path.join(__dirname, '..', 'assets_prev');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const STRINGS_FILE = path.join(DATA_DIR, 'strings.json');
const ENDPOINTS_FILE = path.join(DATA_DIR, 'endpoints.json');
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

function logicalName(filename) {
  if (/^web\.[a-f0-9]+\.js$/i.test(filename)) return 'web';
  if (/^sentry\./i.test(filename)) return 'sentry';
  return filename.replace(/\.[a-f0-9]{8,}\./i, '.').replace(/\.[a-f0-9]{16,}/i, '');
}

function diffStats(oldText, newText) {
  if (oldText === newText) return { added: 0, removed: 0 };
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const minified = oldLines.length <= 8 && newLines.length <= 8;
  if (minified) {
    const o = oldText.split(';');
    const n = newText.split(';');
    const oSet = new Set(o);
    const nSet = new Set(n);
    let added = 0;
    let removed = 0;
    for (const t of n) if (!oSet.has(t)) added++;
    for (const t of o) if (!nSet.has(t)) removed++;
    return { added, removed };
  }
  const oSet = new Set(oldLines);
  const nSet = new Set(newLines);
  let added = 0;
  let removed = 0;
  for (const l of newLines) if (!oSet.has(l)) added++;
  for (const l of oldLines) if (!nSet.has(l)) removed++;
  return { added, removed };
}

async function snapshotPrevAssets() {
  await fs.remove(PREV_ASSETS_DIR);
  if (!(await fs.pathExists(ASSETS_DIR))) return;
  await fs.copy(ASSETS_DIR, PREV_ASSETS_DIR);
  console.log('Snapshot assets → assets_prev');
}

async function computeLineDiff() {
  let added = 0;
  let removed = 0;
  const details = [];
  const prevFiles = (await fs.pathExists(PREV_ASSETS_DIR))
    ? (await fs.readdir(PREV_ASSETS_DIR)).filter((f) => f.endsWith('.js'))
    : [];
  const currFiles = (await fs.pathExists(ASSETS_DIR))
    ? (await fs.readdir(ASSETS_DIR)).filter((f) => f.endsWith('.js'))
    : [];

  if (!prevFiles.length) {
    console.log('Line diff skipped (no assets_prev baseline)');
    return { added: 0, removed: 0, details: [], skipped: true };
  }

  const prevByLogical = new Map();
  for (const f of prevFiles) {
    const key = logicalName(f);
    const full = path.join(PREV_ASSETS_DIR, f);
    const st = await fs.stat(full);
    const prev = prevByLogical.get(key);
    if (!prev || st.size > prev.size) prevByLogical.set(key, { file: f, size: st.size });
  }
  const currByLogical = new Map();
  for (const f of currFiles) {
    const key = logicalName(f);
    const full = path.join(ASSETS_DIR, f);
    const st = await fs.stat(full);
    const prev = currByLogical.get(key);
    if (!prev || st.size > prev.size) currByLogical.set(key, { file: f, size: st.size });
  }

  const keys = new Set([...prevByLogical.keys(), ...currByLogical.keys()]);
  for (const key of keys) {
    const p = prevByLogical.get(key);
    const c = currByLogical.get(key);
    if (p && !c) {
      const text = await fs.readFile(path.join(PREV_ASSETS_DIR, p.file), 'utf8');
      const n = Math.max(text.split(/\r?\n/).length, text.split(';').length);
      removed += n;
      details.push({ key, removed: n, added: 0 });
      continue;
    }
    if (!p && c) {
      const text = await fs.readFile(path.join(ASSETS_DIR, c.file), 'utf8');
      const n = Math.max(text.split(/\r?\n/).length, text.split(';').length);
      added += n;
      details.push({ key, removed: 0, added: n });
      continue;
    }
    if (p && c) {
      const oldText = await fs.readFile(path.join(PREV_ASSETS_DIR, p.file), 'utf8');
      const newText = await fs.readFile(path.join(ASSETS_DIR, c.file), 'utf8');
      const d = diffStats(oldText, newText);
      added += d.added;
      removed += d.removed;
      if (d.added || d.removed) details.push({ key, ...d });
    }
  }
  console.log(`Line/token diff: +${added} −${removed}`);
  return { added, removed, details: details.slice(0, 20), skipped: false };
}

function isExpId(id) {
  return /^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80}$/i.test(id) && !/^20\d{2}-\d{2}$/.test(id);
}

function extractEndpoints(content, outMap) {
  const re =
    /["']?([A-Z][A-Z0-9_]{6,120})["']?\s*:\s*["'](\/(?:api\/v\d+|users|guilds|channels|quests|oauth2|store|partners|applications)[a-zA-Z0-9_\-\/{}.@]*)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) outMap.set(m[1], m[2]);
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
      extractEndpoints(content, endpointMap);
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

async function postWebhook(payload) {
  if (!WEBHOOK_URL) return;
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.warn('Webhook failed', res.status, await res.text());
  else console.log('Webhook sent');
  await new Promise((r) => setTimeout(r, 250));
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
  const epLines = [];
  for (const [k, v] of Object.entries(endpointDiff.added || {})) epLines.push(`+ ${k}: ${v}`);
  for (const [k, v] of Object.entries(endpointDiff.removed || {})) epLines.push(`- ${k}: ${v}`);
  const hasEndpoints = epLines.length > 0;

  const hasContent = hasNewExp || hasNewUI || hasStrings || hasEndpoints;

  if (!isNewBuild && !hasContent) {
    console.log('No notify (same build, no content delta)');
    return;
  }

  const added = isNewBuild && !lineDiff?.skipped ? lineDiff?.added ?? 0 : 0;
  const removed = isNewBuild && !lineDiff?.skipped ? lineDiff?.removed ?? 0 : 0;

  if (isNewBuild || hasContent) {
    const deltaParts = [
      hasNewExp ? `Experiments +${(diff.newClientExperiments || []).length}` : null,
      hasStrings
        ? `Strings +${countKeys(stringDiff.added)}/−${countKeys(stringDiff.removed)}/~${countKeys(stringDiff.modified)}`
        : null,
      hasEndpoints
        ? `Endpoints +${countKeys(endpointDiff.added)}/−${countKeys(endpointDiff.removed)}`
        : null,
      hasNewUI ? `UI +${(diff.newUI || []).length}` : null,
    ].filter(Boolean);

    await postWebhook({
      username: 'Canary Scraper',
      embeds: [
        {
          title: isNewBuild ? 'New Discord Canary Build' : 'Canary Changes',
          color: hasNewExp ? 0xed4245 : 0x57f287,
          fields: [
            { name: 'Build', value: String(build.buildNumber), inline: true },
            { name: 'Channel', value: 'canary', inline: true },
            {
              name: 'Lines',
              value: isNewBuild ? `+${added} · −${removed}` : '—',
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
    });
  }

  if (hasStrings) {
    const emb = formatStringsEmbed(stringDiff, build.buildNumber);
    if (emb) {
      await postWebhook({
        username: 'Canary Scraper',
        embeds: [emb],
      });
    }
  }

  if (hasEndpoints) {
    await postWebhook({
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'Endpoints',
          description:
            '```\n' +
            epLines.slice(0, 40).join('\n').slice(0, 3500) +
            '\n```\n\n**Build Id** — ' +
            build.buildNumber,
          color: 0x5865f2,
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  for (const exp of (diff.newClientExperiments || []).slice(0, 10)) {
    await postWebhook({
      username: 'Canary Scraper',
      embeds: [formatExperimentWithUi(exp, build.buildNumber)],
    });
  }

  if (hasNewUI) {
    await postWebhook({
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'New UI',
          color: 0xf47b67,
          description: formatNewUiDescription(diff.newUI, build.buildNumber),
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}

async function main() {
  console.log('🔍 Canary scrape (strict Wumpus strings)\n');
  await fs.ensureDir(DATA_DIR);
  const html = await httpGet(CANARY_APP);
  const env = parseGlobalEnv(html);
  const assetUrls = extractAssetUrls(html);
  const buildNumber =
    env.BUILD_NUMBER ||
    `hash-${crypto.createHash('sha256').update(html).digest('hex').slice(0, 10)}`;
  console.log('Build', buildNumber);

  let previousBuild = null;
  try {
    if (await fs.pathExists(BUILD_FILE)) previousBuild = await fs.readJson(BUILD_FILE);
  } catch {}
  const isNewBuild = !previousBuild || previousBuild.buildNumber !== buildNumber;

  try {
    await httpGet(EXPERIMENTS_API, false);
  } catch (e) {
    console.warn('experiments API', e.message);
  }

  const webUrl = assetUrls.find((u) => /\/web\.[a-f0-9]+\.js/i.test(u));
  const webName = webUrl ? path.basename(webUrl.split('?')[0]) : null;
  let webOk = false;
  if (webName) {
    const webPath = path.join(ASSETS_DIR, webName);
    if (await fs.pathExists(webPath)) webOk = (await fs.stat(webPath)).size > 2_000_000;
  }

  if (isNewBuild || !webOk) {
    if (isNewBuild) {
      await snapshotPrevAssets();
      await fs.emptyDir(ASSETS_DIR);
    }
    await downloadPriorityAssets(assetUrls);
  }

  const lineDiff = isNewBuild
    ? await computeLineDiff()
    : { added: 0, removed: 0, details: [], skipped: true };

  const findings = await analyzeAssets();
  findings.strings = sanitizeStringsMap(findings.strings);

  if (SEED_WUMPUS && Object.keys(findings.strings).length < 3000) {
    console.log('Seeding/merging Wumpus strings.json for coverage…');
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
      console.log(`Merged ${merged} keys from Wumpus (${Object.keys(findings.strings).length} total)`);
    }
  }

  console.log(
    'Experiments',
    findings.experiments.length,
    'UI',
    findings.ui.length,
    'Strings',
    Object.keys(findings.strings).length,
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
  findings.strings = sanitizeStringsMap(findings.strings);

  const stringDiff = diffStrings(cleanedPrev, findings.strings);
  // Purging old junk (hashes / build numbers) must not spam the channel
  if (countKeys(stringDiff.removed) > 20 && countKeys(stringDiff.added) < 10) {
    console.log('Strings junk purge — skip notify flood');
    stringDiff.added = {};
    stringDiff.removed = {};
    stringDiff.modified = {};
  }

  await fs.writeJson(STRINGS_FILE, findings.strings, { spaces: 2 });

  let prevEndpoints = {};
  try {
    if (await fs.pathExists(ENDPOINTS_FILE)) prevEndpoints = await fs.readJson(ENDPOINTS_FILE);
  } catch {}
  const endpointDiff = { added: {}, removed: {} };
  for (const [k, v] of Object.entries(findings.endpoints)) {
    if (!(k in prevEndpoints)) endpointDiff.added[k] = v;
  }
  for (const [k, v] of Object.entries(prevEndpoints)) {
    if (!(k in findings.endpoints)) endpointDiff.removed[k] = v;
  }
  await fs.writeJson(ENDPOINTS_FILE, findings.endpoints, { spaces: 2 });

  const build = {
    buildNumber,
    versionHash: env.VERSION_HASH || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    scrapedAt: new Date().toISOString(),
    experimentCount: findings.experiments.length,
    stringCount: Object.keys(findings.strings).length,
    lineDiff: { added: lineDiff.added, removed: lineDiff.removed },
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

  console.log(
    `newBuild=${isNewBuild} Lines +${lineDiff.added} −${lineDiff.removed} | strings +${countKeys(stringDiff.added)}/−${countKeys(stringDiff.removed)}`,
  );
  await notify({ build, isNewBuild, diff, stringDiff, endpointDiff, lineDiff });
  console.log('✅ Done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
