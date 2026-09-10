/**
 * Extract from Discord Canary assets only.
 * Stages: web download → parallel core (exp/routes/strings) → optional onCore → locales
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DOWNLOAD_CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY || 36);
const WEB_ONLY = process.env.SCRAPE_WEB_ONLY !== '0';
const DOWNLOAD_CSS = process.env.SCRAPE_CSS !== '0';

function matchEnd(m) {
  return m.index + m[0].length;
}

async function analyzeAssets(build, { forceRefresh, assetsDir, cacheDir, onCore }) {
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
      console.log('FAST MODE: web.* + en-US locales');
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
    try {
      await extractCoreParallel(webContent, { routes, expSet, strings });
    } catch (e) {
      console.error('web extract error', e.message);
      throw e;
    }
  }

  // Priority hook: experiments + routes ready before slow locales
  if (typeof onCore === 'function') {
    const experiments = [...expSet.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    console.log('CORE ready', {
      experiments: experiments.length,
      routes: Object.keys(routes).length,
      stringsWeb: Object.keys(strings).length,
    });
    await onCore({
      experiments,
      routes: { ...routes },
      stringsWeb: { ...strings },
    });
  }

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

  if (!WEB_ONLY || process.env.SCRAPE_EXTRA_CHUNKS === '1') {
    const extra = discoverExtraChunks(webContent).slice(0, 40);
    if (extra.length) {
      console.log('Extra chunks:', extra.length);
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

  console.log('Extract (Discord only)', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    css: Object.keys(cssInventory).length,
  });

  if (DOWNLOAD_CSS && cssAssets.length) {
    console.log('Downloading CSS (post-extract):', cssAssets.length);
    await downloadList(cssAssets, assetsDir, !!forceRefresh);
  }

  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    css: cssInventory,
  };
}

/** Independent parsers in parallel on the same web bundle */
async function extractCoreParallel(webContent, { routes, expSet, strings }) {
  await Promise.all([
    Promise.resolve().then(() => extractRoutes(webContent, routes)),
    Promise.resolve().then(() => extractExperiments(webContent, expSet)),
    Promise.resolve().then(() => extractStrings(webContent, strings)),
  ]);
}

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

function discoverExtraChunks(webContent) {
  if (!webContent) return [];
  const chunkMap = {};
  const reMap = /(\d{3,6}):["']([a-f0-9]{16,20})["']/g;
  let m;
  while ((m = reMap.exec(webContent)) !== null) {
    chunkMap[m[1]] = m[2];
  }
  const localeIds = new Set();
  const reEn =
    /["']en-US["']\s*:\s*\(\)\s*=>\s*n\.e\(["'](\d+)["']\)/g;
  while ((m = reEn.exec(webContent)) !== null) localeIds.add(m[1]);

  const urls = [];
  let n = 0;
  for (const [id, hash] of Object.entries(chunkMap)) {
    if (localeIds.has(id)) continue;
    urls.push('https://canary.discord.com/assets/' + hash + '.js');
    if (++n >= 40) break;
  }
  return urls;
}

function extractLocaleStrings(content, out) {
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
      extractStringsFromLocaleBlob(raw, out);
    }
  }
  extractStringsFromLocaleBlob(content, out);
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
    const inner = m[2];
    const parts = [];
    const rePart =
      /["']([^"'\\]*(?:\\.[^"'\\]*)*)["']|\[\s*\d+\s*,\s*["']([^"']+)["']\s*\]/g;
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
    console.warn('No web.*.js');
    return;
  }
  for (const f of files) {
    const st = await fs.stat(path.join(assetsDir, f));
    console.log(
      'web bundle:',
      f,
      Math.round(st.size / 1024) + 'KB',
      st.size < 1_000_000 ? 'small?' : 'OK',
    );
  }
}

function inferType(id) {
  const s = String(id || '').toLowerCase();
  if (/guild|server|role|channel_list|community|moderat|automod|raid/.test(s))
    return 'guild';
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
          console.warn('DL fail', job.name, res.status);
          continue;
        }
        const buf = await res.buffer();
        await fs.writeFile(fp, buf);
        n++;
        if (n <= 6) {
          console.log('DL', job.name, Math.round(buf.length / 1024) + 'KB');
        }
      } catch (e) {
        console.warn('DL fail', job.name, e.message);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < DOWNLOAD_CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  console.log('Downloaded', n, 'file(s)');
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
  const re3 =
    /\.([A-Z][A-Z0-9_]{2,80})\s*=\s*["'](\/[a-zA-Z0-9_\-./{}@:]+)["']/g;
  while ((m = re3.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
}

function extractExperiments(content, map) {
  const reNK =
    /\{\s*name\s*:\s*["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']\s*,\s*kind\s*:\s*["'](user|guild)["']/gi;
  let m;
  while ((m = reNK.exec(content)) !== null) {
    upsertExp(map, m[1], m[2].toLowerCase(), content, matchEnd(m));
  }
  const reKN =
    /\{\s*kind\s*:\s*["'](user|guild)["']\s*,\s*name\s*:\s*["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  while ((m = reKN.exec(content)) !== null) {
    upsertExp(map, m[2], m[1].toLowerCase(), content, matchEnd(m));
  }

  const reId = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  while ((m = reId.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;
    if (map.has(id)) continue;
    const start = Math.max(0, m.index - 120);
    const end = Math.min(content.length, m.index + id.length + 200);
    const ctx = content.slice(start, end);
    let type = null;
    if (/kind\s*:\s*["']guild["']/i.test(ctx)) type = 'guild';
    else if (/kind\s*:\s*["']user["']/i.test(ctx)) type = 'user';
    else type = inferType(id);
    const variations = countVariationsNear(content, m.index);
    map.set(id, {
      id,
      type,
      kind: type,
      label: null,
      variations,
      variationCount: variations ? Object.keys(variations).length : 0,
      source: 'discord',
    });
  }
}

function upsertExp(map, id, kind, content, posAfter) {
  if (!id || /^20\d{2}-\d{2}$/.test(id)) return;
  const variations = countVariationsNear(content, posAfter);
  const existing = map.get(id);
  if (existing) {
    if (kind === 'guild') {
      existing.type = 'guild';
      existing.kind = 'guild';
    }
    if (
      variations &&
      (!existing.variations ||
        Object.keys(variations).length >
          Object.keys(existing.variations || {}).length)
    ) {
      existing.variations = variations;
      existing.variationCount = Object.keys(variations).length;
    }
    return;
  }
  map.set(id, {
    id,
    type: kind,
    kind,
    label: null,
    variations,
    variationCount: variations ? Object.keys(variations).length : 0,
    source: 'discord',
  });
}

function countVariationsNear(content, from) {
  const window = content.slice(from, from + 900);
  const m = window.match(/variations\s*:\s*\{/);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  for (; i < window.length && depth > 0; i++) {
    if (window[i] === '{') depth++;
    else if (window[i] === '}') depth--;
  }
  const body = window.slice(start, i - 1);
  const keys = [...body.matchAll(/(?:^|[,{])\s*(\d+)\s*:/g)].map((x) =>
    x[1],
  );
  if (!keys.length) return null;
  const out = {};
  for (const k of keys) out[k] = { id: Number(k) };
  return out;
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
  extractExperiments,
  extractCoreParallel,
};
