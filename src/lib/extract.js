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

const DOWNLOAD_CONCURRENCY = 16;
const MAX_READ_BYTES = 25_000_000;
const WEB_ONLY = process.env.SCRAPE_WEB_ONLY !== '0';

async function analyzeAssets(build, { forceRefresh, assetsDir, cacheDir }) {
  await fs.ensureDir(assetsDir);
  if (cacheDir) await fs.ensureDir(cacheDir);

  let assets = [...(build.assets || [])];
  assets.sort((a, b) => scoreAsset(b) - scoreAsset(a));

  if (WEB_ONLY) {
    const web = assets.filter((u) => /\/web\./i.test(u));
    if (web.length) {
      console.log('FAST MODE: web.* + en-US locale chunks');
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

  // Read web.js for exp/routes + locale chunk map
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
    extractStrings(webContent, strings); // few plain strings
  }

  // ── REAL strings: en-US locale chunks (hash.js) ───────
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
    console.log('Strings from en-US locales +', fromLocale, 'total', Object.keys(strings).length);
  }

  console.log('Raw extract (Discord)', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
  });

  // Experiments meta (Wumpus) — kind/label only, not strings
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

  // NOTE: do NOT merge Wumpus strings into diff set — that froze diffs at 0
  console.log('Final counts (Discord-native strings)', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
  });

  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
  };
}

/**
 * From web.js: en-US → n.e("chunkId") + chunkId:"hash" → /assets/{hash}.js
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

  const urls = [];
  for (const id of chunkIds) {
    const hash = chunkMap[id];
    if (!hash) continue;
    urls.push('https://canary.discord.com/assets/' + hash + '.js');
  }
  return urls;
}

/**
 * Locale format: "key":["value"] inside JSON.parse('...')
 */
function extractLocaleStrings(content, out) {
  // Primary: "key":["text"]
  const reArr =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*\[\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
  let m;
  while ((m = reArr.exec(content)) !== null) {
    let val = m[2];
    try {
      val = JSON.parse('"' + val + '"');
    } catch {}
    if (isGoodStringKey(m[1]) && isGoodStringVal(val)) out[m[1]] = val;
  }

  // Fallback plain "key":"value"
  extractStrings(content, out);
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
    if (!name.endsWith('.js')) continue;
    jobs.push({ url, name });
  }

  let n = 0;
  let i = 0;

  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      if (!job) break;
      const dest = path.join(assetsDir, job.name);
      try {
        if (!force && (await fs.pathExists(dest))) {
          const st = await fs.stat(dest);
          if (st.size > 50_000) continue;
        }
        const res = await fetch(job.url, {
          headers: { 'User-Agent': UA },
          timeout: 90000,
        });
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.buffer();
        await fs.writeFile(dest, buf);
        n++;
        if (n <= 8 || job.name.startsWith('web.') || n % 20 === 0)
          console.log('✓', job.name, Math.round(buf.length / 1024) + 'KB');
      } catch (e) {
        console.warn('✗', job.name, e.message);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length || 1) }, () =>
      worker(),
    ),
  );
  console.log('Downloaded', n, 'file(s)');
}

async function cachedJson(cacheDir, name, url, ttlSec) {
  if (!cacheDir) return fetchJson(url);
  const fp = path.join(cacheDir, name);
  try {
    if (await fs.pathExists(fp)) {
      const st = await fs.stat(fp);
      if (Date.now() - st.mtimeMs < ttlSec * 1000) {
        return await fs.readJson(fp);
      }
    }
  } catch {}
  const data = await fetchJson(url);
  if (data) {
    try {
      await fs.writeJson(fp, data);
    } catch {}
  }
  return data;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'canary-pulse', Accept: 'application/json' },
      timeout: 40000,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('fetch', url, e.message);
    return null;
  }
}

async function fetchWumpusExperimentMeta(cacheDir) {
  const map = new Map();
  const [exp, apex] = await Promise.all([
    cachedJson(cacheDir, 'experiments.json', WUMPUS_EXP_URL, 3600),
    cachedJson(cacheDir, 'apex_experiments.json', WUMPUS_APEX_URL, 3600),
  ]);
  for (const data of [exp, apex]) {
    if (!data) continue;
    const list = Array.isArray(data) ? data : data.experiments || [];
    for (const e of list) {
      const id = e.id || e.name;
      if (!id) continue;
      const kind = (e.kind || e.type || '').toLowerCase();
      const treatments = e.treatments || null;
      const variations = e.variations || null;
      const treatmentList = treatments
        ? treatments
        : variations
          ? Object.keys(variations).map((k) => ({
              id: k,
              label: variations[k] && variations[k].label,
            }))
          : null;
      map.set(String(id), {
        kind: kind === 'guild' || kind === 'user' ? kind : null,
        label: e.label || null,
        treatments: treatmentList,
        variations,
      });
    }
  }
  console.log('Wumpus meta', map.size);
  return map;
}

function isGoodStringKey(k) {
  if (typeof k !== 'string' || k.length !== 6) return false;
  // Discord keys: base64-ish, may include + / _ -
  if (!/^[A-Za-z0-9+/_-]{6}$/.test(k)) return false;
  // reject pure lowercase noise words
  if (/^[a-z]{6}$/.test(k)) return false;
  return true;
}

function isGoodStringVal(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 1 || s.length > 500) return false;
  if (/^[a-f0-9]{16,}$/i.test(s) || /^\d+$/.test(s)) return false;
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
    const start = Math.max(0, m.index - 100);
    const end = Math.min(content.length, m.index + id.length + 150);
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
