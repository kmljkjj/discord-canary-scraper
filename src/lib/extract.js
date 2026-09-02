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

  // Enrich experiments with Wumpus metadata (kind, label, treatments)
  try {
    const meta = await fetchWumpusExperimentMeta();
    let enriched = 0;
    for (const [id, e] of expSet) {
      const m = meta.get(id);
      if (m) {
        if (m.kind) e.type = m.kind;
        if (m.kind) e.kind = m.kind === 'guild' ? 'guild' : 'user';
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
    // Also add Wumpus-only experiments not found in JS (still useful for catalog)
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
    console.log('Wumpus exp meta enriched', enriched, 'total', expSet.size);
  } catch (e) {
    console.warn('wumpus exp meta', e.message);
    for (const [, e] of expSet) {
      e.type = inferType(e.id, e.type);
      e.kind = e.type;
    }
  }

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
  };
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
  let s = 0;
  if (/^web\./.test(n)) s += 100;
  if (/i18n|locale|intl|lang|string|message|route|api|endpoint|experiment/.test(n))
    s += 50;
  if (/vendor|chunk/.test(n)) s += 5;
  return s;
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
}

/**
 * Extract experiment ids + local context for kind (user/guild).
 * Rich metadata filled later from Wumpus.
 */
function extractExperiments(content, map) {
  const re = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;

    // Context window around match for kind:
    const start = Math.max(0, m.index - 120);
    const end = Math.min(content.length, m.index + id.length + 180);
    const ctx = content.slice(start, end);

    let type = null;
    if (/kind["']?\s*:\s*["']guild["']/i.test(ctx) || /"guild"\s*,/.test(ctx))
      type = 'guild';
    else if (/kind["']?\s*:\s*["']user["']/i.test(ctx))
      type = 'user';
    else type = inferType(id);

    // Rough treatment count from nearby treatment/variation keys
    let treatmentCount = null;
    const tx = ctx.match(/treatments/i);
    const vr = ctx.match(/variations/i);
    if (tx || vr) {
      const nums = ctx.match(/["']?(?:id|variant)["']?\s*:\s*(\d+)/g);
      if (nums && nums.length) treatmentCount = nums.length;
    }

    if (map.has(id)) {
      const prev = map.get(id);
      // Prefer guild if any context said guild
      if (type === 'guild') prev.type = 'guild';
      if (treatmentCount && !prev.treatmentCount)
        prev.treatmentCount = treatmentCount;
      continue;
    }

    map.set(id, {
      id,
      type,
      kind: type,
      treatmentCount: treatmentCount || null,
      label: null,
      treatments: null,
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

async function fetchWumpusExperimentMeta() {
  const map = new Map();
  for (const url of [WUMPUS_EXP_URL, WUMPUS_APEX_URL]) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'canary-pulse', Accept: 'application/json' },
        timeout: 30000,
      });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.experiments || [];
      for (const e of list) {
        const id = e.id || e.name;
        if (!id) continue;
        const kind = (e.kind || e.type || '').toLowerCase();
        const treatments = e.treatments || null;
        let variations = e.variations || null;
        // Normalize variations object → count
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
    } catch (e) {
      console.warn('fetch meta', url, e.message);
    }
  }
  console.log('Wumpus meta loaded', map.size);
  return map;
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
