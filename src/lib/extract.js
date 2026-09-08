const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const WUMPUS_ROUTES_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/routes.json';
const WUMPUS_EXP_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/experiments.json';
const WUMPUS_APEX_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/apex_experiments.json';

const DOWNLOAD_CONCURRENCY = 24;
const WEB_ONLY = process.env.SCRAPE_WEB_ONLY !== '0';
const DOWNLOAD_CSS = process.env.SCRAPE_CSS !== '0';

async function analyzeAssets(build, { forceRefresh, assetsDir, cacheDir }) {
  await fs.ensureDir(assetsDir);
  if (cacheDir) await fs.ensureDir(cacheDir);

  let assets = [...(build.assets || [])];
  assets.sort((a, b) => scoreAsset(b) - scoreAsset(a));
  const cssAssets = [...(build.cssAssets || [])];

  const cssInventory = {};
  for (const url of cssAssets) {
    const name = path.basename(String(url).split('?')[0]);
    const m = name.match(/^(.+)\.([a-f0-9]{8,})\.css$/i);
    if (m) cssInventory[m[1]] = m[2];
    else cssInventory[name] = name;
  }
  console.log('CSS listed from HTML:', Object.keys(cssInventory).length);

  if (WEB_ONLY) {
    const web = assets.filter((u) => /\/web\./i.test(u));
    if (web.length) {
      console.log('FAST MODE: web.* + en-US locales first');
      assets = web;
    } else {
      console.warn('No web.* — fallback full list');
    }
  }

  if (forceRefresh) {
    for (const url of assets) {
      const name = path.basename(String(url).split('?')[0]);
      try {
        await fs.remove(path.join(assetsDir, name));
      } catch {}
    }
  }

  await downloadList(assets, assetsDir, true);
  await assertWebBundle(assetsDir);

  const webFiles = (await fs.readdir(assetsDir)).filter((f) =>
    /^web\./i.test(f),
  );
  let webContent = '';
  for (const f of webFiles) {
    webContent += await fs.readFile(path.join(assetsDir, f), 'utf8');
  }

  const strings = {};
  const routes = {};
  const expSet = new Map();

  if (webContent) {
    extractRoutes(webContent, routes);
    extractExperiments(webContent, expSet);
    extractStrings(webContent, strings);
  }

  // en-US locale chunks (real Discord strings)
  const localeUrls = resolveEnUsLocaleUrls(webContent);
  console.log('en-US locale chunks:', localeUrls.length);
  if (localeUrls.length) {
    await downloadList(localeUrls, assetsDir, true);
    let fromLocale = 0;
    for (const url of localeUrls) {
      const name = path.basename(url.split('?')[0]);
      const fp = path.join(assetsDir, name);
      try {
        if (!(await fs.pathExists(fp))) continue;
        const content = await fs.readFile(fp, 'utf8');
        const before = Object.keys(strings).length;
        extractLocaleStrings(content, strings);
        fromLocale += Object.keys(strings).length - before;
      } catch (e) {
        console.warn('locale', name, e.message);
      }
    }
    console.log(
      'Strings from en-US locales +',
      fromLocale,
      'total',
      Object.keys(strings).length,
    );
  }

  // Extra JS chunks discovered inside web.js (not only HTML list)
  if (!WEB_ONLY || process.env.SCRAPE_EXTRA_CHUNKS === '1') {
    const extra = discoverExtraChunks(webContent).slice(0, 40);
    if (extra.length) {
      console.log('Extra chunks from web map:', extra.length);
      await downloadList(extra, assetsDir, false);
      for (const url of extra) {
        const name = path.basename(url.split('?')[0]);
        const fp = path.join(assetsDir, name);
        try {
          if (!(await fs.pathExists(fp))) continue;
          const st = await fs.stat(fp);
          if (st.size > 4_000_000) continue;
          const content = await fs.readFile(fp, 'utf8');
          extractRoutes(content, routes);
          extractExperiments(content, expSet);
        } catch {}
      }
    }
  }

  console.log('Raw extract (Discord)', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    css: Object.keys(cssInventory).length,
  });

  const [meta, wRoutes] = await Promise.all([
    fetchWumpusExperimentMeta(cacheDir),
    cachedJson(cacheDir, 'routes.json', WUMPUS_ROUTES_URL, 3600),
  ]);

  let enriched = 0;
  for (const [id, e] of expSet) {
    const m = meta.get(id);
    if (m) {
      if (m.kind) {
        e.type = m.kind;
        e.kind = m.kind;
      }
      if (m.label) e.label = m.label;
      if (m.treatments) e.treatments = m.treatments;
      if (m.variations) e.variations = m.variations;
      e.source = 'wumpus+extract';
      enriched++;
    } else {
      e.type = inferType(id, e.type);
      e.kind = e.type;
      e.source = 'extract';
    }
  }
  for (const [id, m] of meta) {
    if (!expSet.has(id)) {
      expSet.set(id, {
        id,
        type: m.kind || inferType(id),
        kind: m.kind || inferType(id),
        label: m.label || null,
        treatments: m.treatments || null,
        variations: m.variations || null,
        source: 'wumpus',
      });
    }
  }
  console.log('Wumpus exp enriched', enriched, 'total', expSet.size);

  if (Object.keys(routes).length < 50 && wRoutes) {
    let n = 0;
    for (const [k, v] of Object.entries(wRoutes)) {
      if (!(k in routes) && isValidRouteKey(k) && normalizePath(v)) {
        routes[k] = normalizePath(v);
        n++;
      }
    }
    console.log('Wumpus routes +', n, 'total', Object.keys(routes).length);
  }

  if (DOWNLOAD_CSS && cssAssets.length) {
    console.log('Downloading CSS (post-extract):', cssAssets.length);
    await downloadList(cssAssets, assetsDir, !!forceRefresh);
  }

  console.log('Final counts', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    css: Object.keys(cssInventory).length,
  });

  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    css: cssInventory,
  };
}

/**
 * en-US loaders in web.js:
 *   "en-US":()=>n.e("177761").then(...)
 * chunk map:
 *   177761:"2cb8cfba..."
 * Also: "./en-US.json":"444819"
 */
function resolveEnUsLocaleUrls(webContent) {
  if (!webContent) return [];
  const chunkMap = {};
  const reMap = /(\d{3,6}):["']([a-f0-9]{16,20})["']/g;
  let m;
  while ((m = reMap.exec(webContent)) !== null) {
    chunkMap[m[1]] = m[2];
  }

  const chunkIds = new Set();
  const reEn =
    /["']en-US["']\s*:\s*\(\)\s*=>\s*n\.e\(["'](\d+)["']\)/g;
  while ((m = reEn.exec(webContent)) !== null) chunkIds.add(m[1]);

  // secondary: "./en-US.json":"chunkId"
  const reJson = /\.\/en-US\.json["']\s*:\s*["'](\d+)["']/g;
  while ((m = reJson.exec(webContent)) !== null) chunkIds.add(m[1]);

  const urls = [];
  const seen = new Set();
  for (const id of chunkIds) {
    const hash = chunkMap[id];
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    urls.push('https://canary.discord.com/assets/' + hash + '.js');
  }
  return urls;
}

/** High-value extra chunks (not locale) from webpack map — optional */
function discoverExtraChunks(webContent) {
  if (!webContent) return [];
  const chunkMap = {};
  const reMap = /(\d{3,6}):["']([a-f0-9]{16,20})["']/g;
  let m;
  while ((m = reMap.exec(webContent)) !== null) {
    chunkMap[m[1]] = m[2];
  }
  // Prefer chunks referenced near experiment-looking strings — skip, just skip locales
  const localeIds = new Set();
  const reEn =
    /["']en-US["']\s*:\s*\(\)\s*=>\s*n\.e\(["'](\d+)["']\)/g;
  while ((m = reEn.exec(webContent)) !== null) localeIds.add(m[1]);

  const urls = [];
  let n = 0;
  for (const [id, hash] of Object.entries(chunkMap)) {
    if (localeIds.has(id)) continue;
    // skip tiny hashes already in HTML list by not caring
    urls.push('https://canary.discord.com/assets/' + hash + '.js');
    if (++n >= 40) break;
  }
  return urls;
}

/**
 * Locale modules are typically:
 *   JSON.parse('{"/cp93l":["Next month"],...}')
 * Values can be ICU arrays: ["Hello ", [1, "name"]]
 */
function extractLocaleStrings(content, out) {
  // 1) Full JSON.parse('...') blobs
  const reParse = /JSON\.parse\('((?:\\'|[^'])*)'\)/g;
  let m;
  while ((m = reParse.exec(content)) !== null) {
    let raw = m[1];
    try {
      raw = raw
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        );
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        if (!isGoodStringKey(k)) continue;
        const text = flattenIcu(v);
        if (isGoodStringVal(text)) out[k] = text;
      }
    } catch {
      // fallback regex on the raw blob
      extractStringsFromLocaleBlob(raw, out);
    }
  }

  // 2) Direct "key":["value"] outside parse
  extractStringsFromLocaleBlob(content, out);
  // 3) Plain "key":"value"
  extractStrings(content, out);
}

function flattenIcu(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((part) => {
        if (typeof part === 'string') return part;
        if (Array.isArray(part) && part.length >= 2) return '{' + part[1] + '}';
        return '';
      })
      .join('');
  }
  return null;
}

function extractStringsFromLocaleBlob(content, out) {
  const reArr =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*\[\s*([\s\S]*?)\s*\]/g;
  let m;
  while ((m = reArr.exec(content)) !== null) {
    if (!isGoodStringKey(m[1])) continue;
    // simple: ["text"] or ["a", [1,"x"], "b"]
    const inner = m[2];
    const parts = [];
    const rePart = /["']([^"'\\]*(?:\\.[^"'\\]*)*)["']|\[\s*\d+\s*,\s*["']([^"']+)["']\s*\]/g;
    let p;
    while ((p = rePart.exec(inner)) !== null) {
      if (p[1] != null) {
        try {
          parts.push(JSON.parse('"' + p[1] + '"'));
        } catch {
          parts.push(p[1]);
        }
      } else if (p[2] != null) {
        parts.push('{' + p[2] + '}');
      }
    }
    if (!parts.length) continue;
    const text = parts.join('');
    if (isGoodStringVal(text)) out[m[1]] = text;
  }
}

async function assertWebBundle(assetsDir) {
  const files = (await fs.readdir(assetsDir)).filter((f) => /^web\./i.test(f));
  if (!files.length) {
    console.warn('⚠️  No web.*.js');
    return;
  }
  for (const f of files) {
    const st = await fs.stat(path.join(assetsDir, f));
    console.log(
      'web bundle:',
      f,
      Math.round(st.size / 1024) + 'KB',
      st.size < 1_000_000 ? '⚠️ small' : 'OK',
    );
  }
}

function inferType(id, fallback) {
  const s = String(id || '').toLowerCase();
  if (/guild|server|role|channel_list|community|moderat|automod|raid/.test(s))
    return 'guild';
  if (fallback === 'guild' || fallback === 'user') return fallback;
  return 'user';
}

function scoreAsset(url) {
  const n = path.basename(String(url)).toLowerCase();
  if (n.startsWith('web.')) return 1000;
  return 0;
}

async function downloadList(urls, assetsDir, force) {
  const jobs = [];
  for (const url of urls) {
    if (!url || !url.includes('/assets/')) continue;
    const name = path.basename(url.split('?')[0]);
    if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
    jobs.push({ url, name });
  }

  let n = 0;
  let i = 0;

  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      const fp = path.join(assetsDir, job.name);
      try {
        if (!force && (await fs.pathExists(fp))) {
          const st = await fs.stat(fp);
          if (st.size > 0) continue;
        }
        const res = await fetch(job.url, {
          headers: { 'User-Agent': UA, Accept: '*/*' },
          timeout: 60000,
        });
        if (!res.ok) {
          console.warn('✗', job.name, res.status);
          continue;
        }
        const buf = await res.buffer();
        await fs.writeFile(fp, buf);
        n++;
        if (n <= 6) {
          console.log('✓', job.name, Math.round(buf.length / 1024) + 'KB');
        }
      } catch (e) {
        console.warn('✗', job.name, e.message);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < DOWNLOAD_CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  console.log('Downloaded', n, 'file(s) this pass');
}

async function cachedJson(cacheDir, name, url, ttlSec) {
  if (!cacheDir) return null;
  const fp = path.join(cacheDir, name);
  try {
    if (await fs.pathExists(fp)) {
      const st = await fs.stat(fp);
      if (Date.now() - st.mtimeMs < ttlSec * 1000) {
        return await fs.readJson(fp);
      }
    }
  } catch {}
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      timeout: 20000,
    });
    if (!res.ok) return null;
    const data = await res.json();
    await fs.writeJson(fp, data);
    return data;
  } catch {
    try {
      if (await fs.pathExists(fp)) return await fs.readJson(fp);
    } catch {}
    return null;
  }
}

async function fetchWumpusExperimentMeta(cacheDir) {
  const map = new Map();
  const [exps, apex] = await Promise.all([
    cachedJson(cacheDir, 'experiments.json', WUMPUS_EXP_URL, 3600),
    cachedJson(cacheDir, 'apex_experiments.json', WUMPUS_APEX_URL, 3600),
  ]);
  const list = [];
  if (Array.isArray(exps)) list.push(...exps);
  else if (exps && typeof exps === 'object') {
    for (const v of Object.values(exps)) {
      if (Array.isArray(v)) list.push(...v);
      else if (v && v.id) list.push(v);
    }
  }
  if (Array.isArray(apex)) list.push(...apex);
  else if (apex && typeof apex === 'object') {
    for (const v of Object.values(apex)) {
      if (Array.isArray(v)) list.push(...v);
      else if (v && (v.id || v.name)) list.push(v);
    }
  }
  for (const e of list) {
    const id = e.id || e.name || e.experiment_id;
    if (!id) continue;
    map.set(String(id), {
      kind: e.kind || e.type || null,
      label: e.label || e.title || null,
      treatments: e.treatments || e.variants || null,
      variations: e.variations || null,
    });
  }
  console.log('Wumpus meta', map.size);
  return map;
}

function isGoodStringKey(k) {
  if (typeof k !== 'string' || k.length !== 6) return false;
  if (!/^[A-Za-z0-9+/_-]{6}$/.test(k)) return false;
  if (/^[0-9a-f]{6}$/i.test(k)) return false;
  return true;
}

function isGoodStringVal(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 1 || s.length > 800) return false;
  if (/^discord_web-/i.test(s) || /^release:/i.test(s)) return false;
  return true;
}

function extractStrings(content, out) {
  const re =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    let val = m[2];
    try {
      val = JSON.parse('"' + val + '"');
    } catch {}
    if (isGoodStringKey(m[1]) && isGoodStringVal(val)) out[m[1]] = val;
  }
}

function isValidRouteKey(key) {
  if (typeof key !== 'string') return false;
  if (!/^[A-Z][A-Z0-9_]{2,120}$/.test(key)) return false;
  if (/^(GET|PUT|POST|PATCH|DELETE|HEAD|OPTIONS|TRUE|FALSE|NULL)$/.test(key))
    return false;
  return true;
}

function normalizePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p.startsWith('/')) return null;
  if (p.length < 2 || p.length > 300) return null;
  p = p.replace(/\$\{[^}]+\}/g, ':param');
  if (/\.(js|css|map|png|jpg|webp|svg|woff2?)$/i.test(p)) return null;
  if (p.startsWith('/assets/')) return null;
  return p;
}

function extractRoutes(content, out) {
  const re =
    /\b([A-Z][A-Z0-9_]{2,80})\s*:\s*["'`](\/[a-zA-Z0-9_\-./{}@:]+)["'`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re2 =
    /["']([A-Z][A-Z0-9_]{2,80})["']\s*:\s*["'](\/[^"']{1,200})["']/g;
  while ((m = re2.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
}

function extractExperiments(content, map) {
  const re = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;
    const start = Math.max(0, m.index - 120);
    const end = Math.min(content.length, m.index + id.length + 200);
    const ctx = content.slice(start, end);
    let type = null;
    if (/kind["']?\s*:\s*["']guild["']/i.test(ctx)) type = 'guild';
    else if (/kind["']?\s*:\s*["']user["']/i.test(ctx)) type = 'user';
    else type = inferType(id);
    if (map.has(id)) {
      if (type === 'guild') map.get(id).type = 'guild';
      continue;
    }
    map.set(id, { id, type, kind: type, label: null, treatments: null });
  }
}

module.exports = {
  analyzeAssets,
  isGoodStringKey,
  isGoodStringVal,
  extractRoutes,
  isValidRouteKey,
  normalizePath,
  inferType,
  resolveEnUsLocaleUrls,
  extractLocaleStrings,
};
