/**
 * Extraction aligned with Wumpus-style datamining:
 * - strings: 6-char keys (base64-ish) → UI text
 * - routes: SCREAMING_SNAKE → /path
 * - experiments: 20XX-MM-name ids
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function analyzeAssets(build, { forceRefresh, assetsDir }) {
  await fs.ensureDir(assetsDir);
  if (forceRefresh) await fs.emptyDir(assetsDir);

  const web = (build.assets || []).filter((u) =>
    /\/assets\/web\.[a-f0-9]+\.js/i.test(u),
  );
  const other = (build.assets || []).filter(
    (u) => u.endsWith('.js') && !/\/assets\/web\./i.test(u),
  );
  const toFetch = [...web, ...other.slice(0, 80)];

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
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(String(res.status));
      await fs.writeFile(dest, await res.buffer());
      console.log('✓', name);
    } catch (e) {
      console.warn('✗', name, e.message);
    }
  }

  const files = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  files.sort((a, b) => (/^web\./i.test(a) ? 0 : 1) - (/^web\./i.test(b) ? 0 : 1));

  const strings = {};
  const routes = {};
  const expSet = new Map();

  for (const file of files) {
    try {
      const full = path.join(assetsDir, file);
      const st = await fs.stat(full);
      let content = await fs.readFile(full, 'utf8');
      if (st.size > 12_000_000 && !/^web\./i.test(file))
        content = content.slice(0, 6_000_000);
      extractStrings(content, strings);
      extractRoutes(content, routes);
      extractExperiments(content, expSet);
    } catch (e) {
      console.warn('skip', file, e.message);
    }
  }

  // Optional seed from Wumpus if extraction thin
  if (Object.keys(strings).length < 200) {
    try {
      const w = await fetch(
        'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/strings.json',
      );
      if (w.ok) {
        const j = await w.json();
        for (const [k, v] of Object.entries(j)) {
          if (isGoodStringKey(k) && isGoodStringVal(v) && !(k in strings))
            strings[k] = v;
        }
        console.log('Seeded strings from Wumpus');
      }
    } catch {}
  }

  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
  };
}

function isGoodStringKey(k) {
  if (typeof k !== 'string') return false;
  // Wumpus: mostly 6-char keys with letters
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
  // "KEY": "value" where KEY is 6 chars
  const re = /["']([A-Za-z0-9+/]{6})["']\s*:\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
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
  // SCREAMING_SNAKE: "/path" or '/path'
  const re =
    /["']([A-Z][A-Z0-9_]{3,80})["']\s*:\s*["'](\/[a-zA-Z0-9_\-./{}@:]+)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const p = m[2];
    if (name.includes('HTTP') && name.length < 6) continue;
    out[name] = p;
  }
}

function extractExperiments(content, map) {
  // 2024-01_foo or 2026-07-desktop-channel-tabs
  const re = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,80})["']/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;
    if (!map.has(id)) {
      const type = /guild|server/i.test(id) ? 'guild' : 'user';
      map.set(id, {
        id,
        type,
        kind: id.includes('_') ? 'legacy' : 'apex',
      });
    }
  }
}

module.exports = { analyzeAssets };
