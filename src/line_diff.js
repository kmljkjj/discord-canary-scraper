/**
 * Line / unit stats for Discord asset JS files.
 * Persisted in data/asset_stats.json for cross-run diffs.
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

function logicalName(filename) {
  // web.abc123.js → web.js
  const m = filename.match(/^([a-zA-Z0-9_-]+)\.[a-f0-9]{8,}\.(js)$/i);
  if (m) return `${m[1]}.${m[3]}`;
  return filename;
}

function measureContent(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  // Approx "units" = tokens-ish (split on non-alnum)
  const units = text.split(/[^a-zA-Z0-9_$]+/).filter(Boolean).length;
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  return { units, bytes: Buffer.byteLength(text), hash };
}

async function collectAssetStats(assetsDir) {
  const files = {};
  if (!(await fs.pathExists(assetsDir))) return { files, totalUnits: 0 };

  const names = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  for (const name of names) {
    const full = path.join(assetsDir, name);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (st.size > 25_000_000) continue;
    const buf = await fs.readFile(full);
    const m = measureContent(buf);
    const key = logicalName(name);
    if (!files[key] || m.bytes > files[key].bytes) {
      files[key] = { ...m, file: name };
    }
  }

  let totalUnits = 0;
  for (const f of Object.values(files)) totalUnits += f.units;
  return { files, totalUnits };
}

/**
 * Compare previous vs current stats.
 * Wholesale hash renames (all files replaced, similar size) → net-only + flag.
 */
function diffAssetStats(prev, curr) {
  const prevFiles = (prev && prev.files) || {};
  const currFiles = (curr && curr.files) || {};

  if (!Object.keys(prevFiles).length) {
    return {
      added: 0,
      removed: 0,
      changedFiles: 0,
      skipped: true,
      reason: 'no_baseline',
      meaningful: false,
    };
  }
  if (!Object.keys(currFiles).length) {
    return {
      added: 0,
      removed: 0,
      changedFiles: 0,
      skipped: true,
      reason: 'no_current',
      meaningful: false,
    };
  }

  let added = 0;
  let removed = 0;
  let changedFiles = 0;
  const keys = new Set([...Object.keys(prevFiles), ...Object.keys(currFiles)]);

  for (const key of keys) {
    const a = prevFiles[key];
    const b = currFiles[key];
    if (a && !b) {
      removed += a.units;
      changedFiles++;
      continue;
    }
    if (!a && b) {
      added += b.units;
      changedFiles++;
      continue;
    }
    if (a && b && a.hash !== b.hash) {
      removed += a.units;
      added += b.units;
      changedFiles++;
    }
  }

  const max = Math.max(added, removed, 1);
  const ratio = Math.abs(added - removed) / max;
  // Full asset refresh: huge + and − almost equal → not useful in Discord
  const wholesale = added > 5000 && removed > 5000 && ratio < 0.08;

  if (wholesale) {
    const net = added - removed;
    return {
      added: net > 0 ? net : 0,
      removed: net < 0 ? -net : 0,
      changedFiles,
      skipped: false,
      wholesale: true,
      meaningful: Math.abs(net) > 50,
      rawAdded: added,
      rawRemoved: removed,
    };
  }

  return {
    added,
    removed,
    changedFiles,
    skipped: false,
    wholesale: false,
    meaningful: changedFiles > 0 && (added > 0 || removed > 0),
  };
}

async function loadStats(statsPath) {
  try {
    if (await fs.pathExists(statsPath)) return await fs.readJson(statsPath);
  } catch {}
  return { files: {}, totalUnits: 0 };
}

async function saveStats(statsPath, stats, buildNumber) {
  await fs.writeJson(
    statsPath,
    {
      buildNumber: buildNumber || null,
      scrapedAt: new Date().toISOString(),
      totalUnits: stats.totalUnits,
      files: stats.files,
    },
    { spaces: 2 },
  );
}

module.exports = {
  logicalName,
  measureContent,
  collectAssetStats,
  diffAssetStats,
  loadStats,
  saveStats,
};
