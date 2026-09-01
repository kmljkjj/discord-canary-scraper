const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function analyzeAssets(build, { forceRefresh, assetsDir }) {
  await fs.ensureDir(assetsDir);
  if (forceRefresh) await fs.emptyDir(assetsDir);

  let assets = [...(build.assets || [])];
  // Prefer likely i18n / main bundles first
  assets.sort((a, b) => scoreAsset(b) - scoreAsset(a));
  await downloadList(assets, assetsDir, forceRefresh);

  const more = await discoverChunks(assetsDir);
  const extra = more.filter((u) => !assets.includes(u));
  console.log('Discovered extra chunks:', extra.length);
  await downloadList(extra.slice(0, 200), assetsDir, true);

  const files = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  console.log('Scanning', files.length, 'JS files');
  // Scan largest files first (string tables live in big chunks)
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

  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
  };
}

function scoreAsset(url) {
  const n = path.basename(String(url)).toLowerCase();
  let s = 0;
  if (/^web\./.test(n)) s += 100;
  if (/i18n|locale|intl|lang|string|message/.test(n)) s += 50;
  if (/vendor|chunk/.test(n)) s += 5;
  return s;
}

async function downloadList(urls, assetsDir, force) {
  let n = 0;
  for (const url of urls) {
    if (!url || !url.includes('/assets/')) continue;
    const name = path.basename(url.split('?')[0]);
    if (!name.endsWith('.js')) continue;
    const dest = path.join(assetsDir, name);
    try {
      if (!force && (await fs.pathExists(dest))) {
        const st = await fs.stat(dest);
        if (st.size > 30_000) continue;
      }
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        timeout: 60000,
      });
      if (!res.ok) throw new Error(String(res.status));
      const buf = await res.buffer();
      await fs.writeFile(dest, buf);
      n++;
      if (n <= 15 || n % 25 === 0)
        console.log('✓', name, Math.round(buf.length / 1024) + 'KB');
    } catch (e) {
      console.warn('✗', name, e.message);
    }
  }
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

/** Discord i18n keys: 6 chars, not pure English words */
function isGoodStringKey(k) {
  if (typeof k !== 'string' || k.length !== 6) return false;
  if (!/^[A-Za-z0-9+/_-]+$/.test(k)) return false;
  if (/^[a-z]{6}$/.test(k)) return false; // height, string, number…
  if (/^[0-9]{6}$/.test(k)) return true; // Wumpus also has numeric-ish keys
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
  // need some human text
  if (!/[A-Za-zÀ-ÿ{]/.test(s)) return false;
  return true;
}

function extractStrings(content, out) {
  // "KEY": "value"
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
  // KEY:"value" without quotes on key sometimes in minified maps
  const re2 =
    /([A-Za-z0-9+/_-]{6})\s*:\s*["']([^"'\\]{2,400})["']/g;
  while ((m = re2.exec(content)) !== null) {
    if (isGoodStringKey(m[1]) && isGoodStringVal(m[2]) && !(m[1] in out))
      out[m[1]] = m[2];
  }
}

function extractRoutes(content, out) {
  const re =
    /["']([A-Z][A-Z0-9_]{3,80})["']\s*:\s*["'](\/[a-zA-Z0-9_\-./{}@:]+)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) out[m[1]] = m[2];
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

module.exports = { analyzeAssets, isGoodStringKey, isGoodStringVal };
