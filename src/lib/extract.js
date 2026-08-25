const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function analyzeAssets(build, { forceRefresh, assetsDir }) {
  await fs.ensureDir(assetsDir);
  if (forceRefresh) await fs.emptyDir(assetsDir);

  let assets = [...(build.assets || [])];
  // Download listed assets first
  await downloadList(assets, assetsDir, forceRefresh);

  // Discover more chunks from downloaded JS (webpack)
  const more = await discoverChunks(assetsDir);
  const extra = more.filter((u) => !assets.includes(u));
  console.log('Discovered extra chunks:', extra.length);
  await downloadList(extra.slice(0, 150), assetsDir, true);

  const files = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  console.log('Scanning', files.length, 'JS files');
  files.sort((a, b) => (/^web\./i.test(a) ? 0 : 1) - (/^web\./i.test(b) ? 0 : 1));

  const strings = {};
  const routes = {};
  const expSet = new Map();

  for (const file of files) {
    try {
      const full = path.join(assetsDir, file);
      const st = await fs.stat(full);
      let content = await fs.readFile(full, 'utf8');
      if (st.size > 18_000_000) content = content.slice(0, 14_000_000);
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

  if (Object.keys(strings).length < 200) {
    try {
      const w = await fetch(
        'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/strings.json',
        { timeout: 30000 },
      );
      if (w.ok) {
        const j = await w.json();
        let n = 0;
        for (const [k, v] of Object.entries(j)) {
          if (isGoodStringKey(k) && isGoodStringVal(v) && !(k in strings)) {
            strings[k] = v;
            n++;
          }
        }
        console.log('Wumpus string seed', n);
      }
    } catch (e) {
      console.warn('wumpus seed', e.message);
    }
  }

  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
  };
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
      const res = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 60000 });
      if (!res.ok) throw new Error(String(res.status));
      const buf = await res.buffer();
      await fs.writeFile(dest, buf);
      n++;
      if (n <= 15 || n % 20 === 0) console.log('✓', name, Math.round(buf.length / 1024) + 'KB');
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
  for (const file of files.slice(0, 30)) {
    try {
      const content = await fs.readFile(path.join(assetsDir, file), 'utf8');
      const slice = content.length > 5_000_000 ? content.slice(0, 5_000_000) : content;
      let m;
      while ((m = re.exec(slice)) !== null) {
        urls.add('https://canary.discord.com/assets/' + m[1]);
      }
    } catch {}
  }
  return [...urls];
}

function isGoodStringKey(k) {
  return typeof k === 'string' && /^[A-Za-z0-9+/]{6}$/.test(k) && /[A-Za-z]/.test(k);
}
function isGoodStringVal(v) {
  if (typeof v !== 'string') return false;
  if (v.length < 2 || v.length > 400) return false;
  if (/^[a-f0-9]{16,}$/i.test(v) || /^\d+$/.test(v)) return false;
  return true;
}

function extractStrings(content, out) {
  const re =
    /["']([A-Za-z0-9+/]{6})["']\s*:\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    let val = m[2];
    try {
      val = JSON.parse('"' + val + '"');
    } catch {}
    if (isGoodStringKey(m[1]) && isGoodStringVal(val)) out[m[1]] = val;
  }
}

function extractRoutes(content, out) {
  const re =
    /["']([A-Z][A-Z0-9_]{3,80})["']\s*:\s*["'](\/[a-zA-Z0-9_\-./{}@:]+)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) out[m[1]] = m[2];
}

function extractExperiments(content, map) {
  // 2026-08-foo-bar OR 2026-08_foo_bar
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

module.exports = { analyzeAssets };
