/**
 * Extraction — Wumpus-style strings / routes / experiments
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function analyzeAssets(build, { forceRefresh, assetsDir }) {
  await fs.ensureDir(assetsDir);
  if (forceRefresh) {
    console.log('Refreshing assets…');
    await fs.emptyDir(assetsDir);
  }

  const assets = build.assets || [];
  const web = assets.filter((u) => /\/assets\/web\.[a-f0-9]+\.js/i.test(u));
  const other = assets.filter(
    (u) => u.endsWith('.js') && !/\/assets\/web\./i.test(u),
  );
  // Prefer web bundle first (contains most strings/experiments)
  const toFetch = [...web, ...other.slice(0, 120)];
  console.log('Will fetch', toFetch.length, 'JS files (web=', web.length, ')');

  let downloaded = 0;
  for (const url of toFetch) {
    const name = path.basename(url.split('?')[0]);
    const dest = path.join(assetsDir, name);
    try {
      if (!forceRefresh && (await fs.pathExists(dest))) {
        const st = await fs.stat(dest);
        if (st.size > 50_000) {
          console.log('· cached', name);
          continue;
        }
      }
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        timeout: 60000,
      });
      if (!res.ok) throw new Error(String(res.status));
      const buf = await res.buffer();
      await fs.writeFile(dest, buf);
      downloaded++;
      console.log('✓', name, Math.round(buf.length / 1024) + 'KB');
    } catch (e) {
      console.warn('✗', name, e.message);
    }
  }
  console.log('Downloaded', downloaded, 'files');

  const files = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  console.log('Scanning', files.length, 'local JS files');
  files.sort((a, b) => (/^web\./i.test(a) ? 0 : 1) - (/^web\./i.test(b) ? 0 : 1));

  const strings = {};
  const routes = {};
  const expSet = new Map();

  for (const file of files) {
    try {
      const full = path.join(assetsDir, file);
      const st = await fs.stat(full);
      let content = await fs.readFile(full, 'utf8');
      // web.js can be huge — still scan more of it
      if (st.size > 20_000_000) content = content.slice(0, 15_000_000);
      else if (st.size > 12_000_000 && !/^web\./i.test(file))
        content = content.slice(0, 8_000_000);
      extractStrings(content, strings);
      extractRoutes(content, routes);
      extractExperiments(content, expSet);
    } catch (e) {
      console.warn('skip', file, e.message);
    }
  }

  console.log('Raw extract:', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
  });

  // Seed from Wumpus if still thin
  if (Object.keys(strings).length < 300) {
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
        console.log('Seeded', n, 'strings from Wumpus');
      }
    } catch (e) {
      console.warn('Wumpus seed failed', e.message);
    }
  }

  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
  };
}

function isGoodStringKey(k) {
  if (typeof k !== 'string') return false;
  if (/^[A-Za-z0-9+/]{6}$/.test(k) && /[A-Za-z]/.test(k)) return true;
  return false;
}

function isGoodStringVal(v) {
  if (typeof v !== 'string') return false;
  if (v.length < 2 || v.length > 400) return false;
  if (/^[a-f0-9]{16,}$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return false;
  return true;
}

function extractStrings(content, out) {
  const re =
    /["']([A-Za-z0-9+/]{6})["']\s*:\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const key = m[1];
    let val = m[2];
    try {
      val = JSON.parse('"' + val + '"');
    } catch {}
    if (isGoodStringKey(key) && isGoodStringVal(val)) out[key] = val;
  }
}

function extractRoutes(content, out) {
  const re =
    /["']([A-Z][A-Z0-9_]{3,80})["']\s*:\s*["'](\/[a-zA-Z0-9_\-./{}@:]+)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    out[m[1]] = m[2];
  }
}

function extractExperiments(content, map) {
  // Quoted experiment ids
  const re = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;
    if (!map.has(id)) {
      map.set(id, {
        id,
        type: /guild|server/i.test(id) ? 'guild' : 'user',
        kind: id.includes('_') ? 'legacy' : 'apex',
      });
    }
  }
  // Also unquoted in some minified forms: experimentId:"2026-..."
  const re2 =
    /(?:experiment(?:Id|Name)?|name)\s*[:=]\s*["'](20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,90})["']/gi;
  while ((m = re2.exec(content)) !== null) {
    const id = m[1];
    if (!map.has(id)) {
      map.set(id, {
        id,
        type: /guild|server/i.test(id) ? 'guild' : 'user',
        kind: id.includes('_') ? 'legacy' : 'apex',
      });
    }
  }
}

module.exports = { analyzeAssets };
