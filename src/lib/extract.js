const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const WUMPUS_ROUTES_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/routes.json';

// Parallel downloads — speed without hammering Discord
const DOWNLOAD_CONCURRENCY = 12;

async function analyzeAssets(build, { forceRefresh, assetsDir }) {
  await fs.ensureDir(assetsDir);
  if (forceRefresh) await fs.emptyDir(assetsDir);

  let assets = [...(build.assets || [])];
  assets.sort((a, b) => scoreAsset(b) - scoreAsset(a));
  await downloadList(assets, assetsDir, forceRefresh);

  const more = await discoverChunks(assetsDir);
  const extra = more.filter((u) => !assets.includes(u));
  console.log('Discovered extra chunks:', extra.length);
  await downloadList(extra.slice(0, 180), assetsDir, true);

  const files = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  console.log('Scanning', files.length, 'JS files');
  const withSize = [];
  for (const f of files) {
    try {
      const st = await fs.stat(path.join(assetsDir, f));
      withSize.push({ f, size: st.size });
    } catch {
      withSize.push({ f, size: 0 });
    }
  }
  withSize.sort((a, b) => b.size - a.size);

  const strings = {};
  const routes = {};
  const expSet = new Map();

  for (const { f: file, size } of withSize) {
    try {
      const full = path.join(assetsDir, file);
      let content = await fs.readFile(full, 'utf8');
      if (size > 20_000_000) content = content.slice(0, 16_000_000);
      extractStrings(content, strings);
      extractRoutes(content, routes);
      extractExperiments(content, expSet);
    } catch (e) {
      console.warn('skip', file, e.message);
    }
  }

  console.log('Raw counts', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
  });

  if (Object.keys(routes).length < 20) {
    try {
      const wr = await fetchWumpusRoutes();
      if (wr) {
        let n = 0;
        for (const [k, v] of Object.entries(wr)) {
          if (!(k in routes) && isValidRouteKey(k) && normalizePath(v)) {
            routes[k] = normalizePath(v);
            n++;
          }
        }
        console.log('Wumpus routes seed +', n, 'total', Object.keys(routes).length);
      }
    } catch (e) {
      console.warn('wumpus routes', e.message);
    }
  }

  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    routesFromExtract: Object.keys(routes).length > 0,
  };
}

function scoreAsset(url) {
  const n = path.basename(String(url)).toLowerCase();
  let s = 0;
  if (/^web\./.test(n)) s += 100;
  if (/i18n|locale|intl|lang|string|message|route|api|endpoint/.test(n)) s += 50;
  if (/vendor|chunk/.test(n)) s += 5;
  return s;
}

/** Parallel download pool */
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
          if (st.size > 30_000) continue;
        }
        const res = await fetch(job.url, {
          headers: { 'User-Agent': UA },
          timeout: 45000,
        });
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.buffer();
        await fs.writeFile(dest, buf);
        n++;
        if (n <= 12 || n % 30 === 0)
          console.log('✓', job.name, Math.round(buf.length / 1024) + 'KB');
      } catch (e) {
        console.warn('✗', job.name, e.message);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < DOWNLOAD_CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  console.log('Downloaded batch', n);
}

async function discoverChunks(assetsDir) {
  const files = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  const urls = new Set();
  const re = /["']\/?assets\/([a-zA-Z0-9._-]+\.js)["']/g;
  for (const file of files.slice(0, 40)) {
    try {
      const content = await fs.readFile(path.join(assetsDir, file), 'utf8');
      const slice =
        content.length > 6_000_000 ? content.slice(0, 6_000_000) : content;
      let m;
      while ((m = re.exec(slice)) !== null) {
        urls.add('https://canary.discord.com/assets/' + m[1]);
      }
    } catch {}
  }
  return [...urls];
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
  const re1 =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
  let m;
  while ((m = re1.exec(content)) !== null) {
    let val = m[2];
    try {
      val = JSON.parse('"' + val + '"');
    } catch {}
    if (isGoodStringKey(m[1]) && isGoodStringVal(val)) out[m[1]] = val;
  }
  const re2 =
    /([A-Za-z0-9+/_-]{6})\s*:\s*["']([^"'\\]{2,400})["']/g;
  while ((m = re2.exec(content)) !== null) {
    if (isGoodStringKey(m[1]) && isGoodStringVal(m[2]) && !(m[1] in out))
      out[m[1]] = m[2];
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
  const reColon =
    /\b([A-Z][A-Z0-9_]{2,120})\s*:\s*["'`](\/[^"'`]{1,300})["'`]/g;
  let m;
  while ((m = reColon.exec(content)) !== null) {
    const path = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && path) out[m[1]] = path;
  }
  const reQuoted =
    /["']([A-Z][A-Z0-9_]{2,120})["']\s*:\s*["'](\/[^"']{1,300})["']/g;
  while ((m = reQuoted.exec(content)) !== null) {
    const path = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && path) out[m[1]] = path;
  }
  const reAssign =
    /\b([A-Z][A-Z0-9_]{2,120})\s*=\s*["'`](\/[^"'`]{1,300})["'`]/g;
  while ((m = reAssign.exec(content)) !== null) {
    const path = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && path) out[m[1]] = path;
  }
  const reUrl =
    /["']([A-Z][A-Z0-9_]{3,80})["']\s*,\s*["'](\/[a-zA-Z0-9_\-./{}@:]+)["']/g;
  while ((m = reUrl.exec(content)) !== null) {
    const path = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && path && !(m[1] in out)) out[m[1]] = path;
  }
}

function extractExperiments(content, map) {
  const re = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;
    if (map.has(id)) continue;
    map.set(id, {
      id,
      type: /guild|server/i.test(id) ? 'guild' : 'user',
      kind: id.includes('_') ? 'legacy' : 'apex',
    });
  }
}

async function fetchWumpusRoutes() {
  const res = await fetch(WUMPUS_ROUTES_URL, {
    headers: { 'User-Agent': 'canary-pulse', Accept: 'application/json' },
    timeout: 25000,
  });
  if (!res.ok) return null;
  return await res.json();
}

module.exports = {
  analyzeAssets,
  isGoodStringKey,
  isGoodStringVal,
  extractRoutes,
  isValidRouteKey,
  normalizePath,
};
