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

const DOWNLOAD_CONCURRENCY = 12;
// web.js is ~12MB — must read fully
const MAX_READ_BYTES = 25_000_000;

async function analyzeAssets(build, { forceRefresh, assetsDir }) {
  await fs.ensureDir(assetsDir);
  if (forceRefresh) await fs.emptyDir(assetsDir);

  let assets = [...(build.assets || [])];
  // web.* first
  assets.sort((a, b) => scoreAsset(b) - scoreAsset(a));

  console.log(
    'Asset queue: web first →',
    assets
      .slice(0, 5)
      .map((u) => path.basename(u))
      .join(', '),
  );

  await downloadList(assets, assetsDir, forceRefresh);

  // Verify web.* is present and large
  await assertWebBundle(assetsDir);

  const more = await discoverChunks(assetsDir);
  const extra = more.filter((u) => !assets.includes(u));
  console.log('Discovered extra chunks:', extra.length);
  if (extra.length) await downloadList(extra.slice(0, 100), assetsDir, true);

  const files = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  const withSize = [];
  for (const f of files) {
    try {
      const st = await fs.stat(path.join(assetsDir, f));
      withSize.push({ f, size: st.size });
    } catch {
      withSize.push({ f, size: 0 });
    }
  }
  // Largest first (web.js ~12MB)
  withSize.sort((a, b) => b.size - a.size);

  console.log(
    'Top files by size:',
    withSize
      .slice(0, 5)
      .map((x) => x.f + '=' + Math.round(x.size / 1024) + 'KB')
      .join(', '),
  );
  console.log('Scanning', files.length, 'JS files');

  const strings = {};
  const routes = {};
  const expSet = new Map();

  for (const { f: file, size } of withSize) {
    try {
      const full = path.join(assetsDir, file);
      let content = await fs.readFile(full, 'utf8');
      if (size > MAX_READ_BYTES) content = content.slice(0, MAX_READ_BYTES);
      extractStrings(content, strings);
      extractRoutes(content, routes);
      extractExperiments(content, expSet);
    } catch (e) {
      console.warn('skip', file, e.message);
    }
  }

  console.log('Raw extract (from Discord JS only)', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
  });

  // ── Enrich experiments (Wumpus kind/label/treatments) ─
  try {
    const meta = await fetchWumpusExperimentMeta();
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
    console.log('Wumpus exp meta enriched', enriched, 'total', expSet.size);
  } catch (e) {
    console.warn('wumpus exp meta', e.message);
    for (const [, e] of expSet) {
      e.type = inferType(e.id, e.type);
      e.kind = e.type;
    }
  }

  // ── Routes fallback Wumpus ────────────────────────────
  if (Object.keys(routes).length < 50) {
    try {
      const wr = await fetchJson(WUMPUS_ROUTES_URL);
      if (wr) {
        let n = 0;
        for (const [k, v] of Object.entries(wr)) {
          if (!(k in routes) && isValidRouteKey(k) && normalizePath(v)) {
            routes[k] = normalizePath(v);
            n++;
          }
        }
        console.log('Wumpus routes +', n, 'total', Object.keys(routes).length);
      }
    } catch (e) {
      console.warn('wumpus routes', e.message);
    }
  }

  // ── Strings: Discord JS has almost none (i18n elsewhere).
  // Always merge Wumpus strings catalog so we can detect real changes.
  try {
    const ws = await fetchJson(WUMPUS_STRINGS_URL);
    if (ws && typeof ws === 'object') {
      let n = 0;
      for (const [k, v] of Object.entries(ws)) {
        if (typeof k === 'string' && k.length === 6 && typeof v === 'string') {
          if (!(k in strings)) {
            strings[k] = v;
            n++;
          }
        }
      }
      console.log(
        'Wumpus strings merge +',
        n,
        'total',
        Object.keys(strings).length,
      );
    }
  } catch (e) {
    console.warn('wumpus strings', e.message);
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
  const files = (await fs.readdir(assetsDir)).filter((f) =>
    /^web\./i.test(f),
  );
  if (!files.length) {
    console.warn(
      '⚠️  No web.*.js downloaded — experiments/routes will be incomplete',
    );
    return;
  }
  for (const f of files) {
    const st = await fs.stat(path.join(assetsDir, f));
    console.log(
      'web bundle:',
      f,
      Math.round(st.size / 1024) + 'KB',
      st.size < 1_000_000 ? '⚠️ unexpectedly small' : 'OK',
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
  let s = 0;
  if (n.startsWith('web.')) s += 1000;
  if (/i18n|locale|intl|lang|string|message|route|api|endpoint|experiment/.test(n))
    s += 50;
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
          // Always re-fetch tiny files; keep large cached
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
        const kb = Math.round(buf.length / 1024);
        if (job.name.startsWith('web.') || n <= 8 || n % 40 === 0)
          console.log('✓', job.name, kb + 'KB');
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
  // Prefer scanning large files for nested chunk refs
  const ranked = [];
  for (const f of files) {
    try {
      const st = await fs.stat(path.join(assetsDir, f));
      ranked.push({ f, size: st.size });
    } catch {}
  }
  ranked.sort((a, b) => b.size - a.size);

  const urls = new Set();
  const re = /["'](?:\/?assets\/)?([a-zA-Z0-9._-]+\.js)["']/g;
  for (const { f: file, size } of ranked.slice(0, 15)) {
    if (size < 1000) continue;
    try {
      let content = await fs.readFile(path.join(assetsDir, file), 'utf8');
      if (content.length > 8_000_000) content = content.slice(0, 8_000_000);
      let m;
      while ((m = re.exec(content)) !== null) {
        if (/^web\./i.test(m[1])) continue;
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
  // Proven on live web.js: KEY: "/path" or KEY: `/path` (~447 matches)
  const re =
    /\b([A-Z][A-Z0-9_]{2,80})\s*:\s*["'`](\/[a-zA-Z0-9_\-./{}@:]+)["'`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  // "KEY": "/path"
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
    const end = Math.min(content.length, m.index + id.length + 180);
    const ctx = content.slice(start, end);

    let type = null;
    if (/kind["']?\s*:\s*["']guild["']/i.test(ctx)) type = 'guild';
    else if (/kind["']?\s*:\s*["']user["']/i.test(ctx)) type = 'user';
    else type = inferType(id);

    if (map.has(id)) {
      const prev = map.get(id);
      if (type === 'guild') prev.type = 'guild';
      continue;
    }

    map.set(id, {
      id,
      type,
      kind: type,
      label: null,
      treatments: null,
    });
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'canary-pulse', Accept: 'application/json' },
    timeout: 45000,
  });
  if (!res.ok) return null;
  return await res.json();
}

async function fetchWumpusExperimentMeta() {
  const map = new Map();
  for (const url of [WUMPUS_EXP_URL, WUMPUS_APEX_URL]) {
    try {
      const data = await fetchJson(url);
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
