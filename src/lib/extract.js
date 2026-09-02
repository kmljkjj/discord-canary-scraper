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
const WUMPUS_STRINGS_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/strings.json';

const DOWNLOAD_CONCURRENCY = 16;
const MAX_READ_BYTES = 25_000_000;
// Speed: only web.* is needed for exp+routes (other HTML assets are ~0–2KB stubs)
const WEB_ONLY = process.env.SCRAPE_WEB_ONLY !== '0';

async function analyzeAssets(build, { forceRefresh, assetsDir, cacheDir }) {
  await fs.ensureDir(assetsDir);
  if (cacheDir) await fs.ensureDir(cacheDir);

  let assets = [...(build.assets || [])];
  assets.sort((a, b) => scoreAsset(b) - scoreAsset(a));

  // Fast path: only web.*.js (+ keep any already-large local files)
  if (WEB_ONLY) {
    const web = assets.filter((u) => /\/web\./i.test(u));
    if (web.length) {
      console.log('FAST MODE: download web.* only (' + web.length + ' file)');
      assets = web;
    } else {
      console.warn('No web.* in asset list — fallback full list');
    }
  } else {
    console.log('FULL MODE: all', assets.length, 'assets');
  }

  if (forceRefresh) {
    // Only wipe files we are about to replace (keep unrelated cache)
    for (const url of assets) {
      const name = path.basename(String(url).split('?')[0]);
      try {
        await fs.remove(path.join(assetsDir, name));
      } catch {}
    }
  }

  await downloadList(assets, assetsDir, true);
  await assertWebBundle(assetsDir);

  const files = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  const withSize = [];
  for (const f of files) {
    try {
      const st = await fs.stat(path.join(assetsDir, f));
      // Skip tiny stubs (< 20KB) — no exp/routes/strings
      if (st.size < 20_000 && !/^web\./i.test(f)) continue;
      withSize.push({ f, size: st.size });
    } catch {}
  }
  withSize.sort((a, b) => b.size - a.size);

  console.log(
    'Scan',
    withSize.length,
    'files:',
    withSize
      .slice(0, 4)
      .map((x) => x.f + '=' + Math.round(x.size / 1024) + 'KB')
      .join(', '),
  );

  const strings = {};
  const routes = {};
  const expSet = new Map();

  for (const { f: file, size } of withSize) {
    try {
      let content = await fs.readFile(path.join(assetsDir, file), 'utf8');
      if (size > MAX_READ_BYTES) content = content.slice(0, MAX_READ_BYTES);
      extractStrings(content, strings);
      extractRoutes(content, routes);
      extractExperiments(content, expSet);
    } catch (e) {
      console.warn('skip', file, e.message);
    }
  }

  console.log('Raw extract (Discord JS)', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
  });

  // Parallel Wumpus enrichment (cached)
  const [meta, wRoutes, wStrings] = await Promise.all([
    fetchWumpusExperimentMeta(cacheDir),
    cachedJson(cacheDir, 'routes.json', WUMPUS_ROUTES_URL, 3600),
    cachedJson(cacheDir, 'strings.json', WUMPUS_STRINGS_URL, 3600),
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

  if (wStrings && typeof wStrings === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(wStrings)) {
      if (typeof k === 'string' && k.length === 6 && typeof v === 'string') {
        if (!(k in strings)) {
          strings[k] = v;
          n++;
        }
      }
    }
    console.log('Wumpus strings +', n, 'total', Object.keys(strings).length);
  }

  console.log('Final counts', {
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

async function assertWebBundle(assetsDir) {
  const files = (await fs.readdir(assetsDir)).filter((f) => /^web\./i.test(f));
  if (!files.length) {
    console.warn('⚠️  No web.*.js — incomplete extract');
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

/** Disk cache for Wumpus JSON — avoids re-download every run */
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
  if (!/^[A-Za-z0-9+/_-]+$/.test(k)) return false;
  if (/^[a-z]{6}$/.test(k)) return false;
  if (/^[0-9]{6}$/.test(k)) return true;
  if (!/[A-Za-z]/.test(k)) return false;
  return true;
}

function isGoodStringVal(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 2 || s.length > 500) return false;
  if (/^[a-f0-9]{16,}$/i.test(s) || /^\d+$/.test(s)) return false;
  if (/^discord_web-/i.test(s) || /^release:/i.test(s)) return false;
  if (
    /^(width|height|string|number|boolean|object|symbol|unknown|past|future|month|months|short|long|add|delete|update|start|locale|format|author|rive)$/i.test(
      s,
    )
  )
    return false;
  if (!/[A-Za-zÀ-ÿ{]/.test(s)) return false;
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
};
