/**
 * Persistent line/token stats for Discord Canary JS assets.
 *
 * Why not assets_prev/ on disk?
 *   GitHub Actions runners are ephemeral — folders vanish between runs.
 *   Wumpus gets +/- from git commits of chunks; we persist compact stats in
 *   data/asset_stats.json (committed with the rest of data/).
 *
 * Model (minified bundles = often 1 physical line):
 *   - tokens ≈ content.split(';').length  (stable volume signal)
 *   - if file hash changes → count full old tokens as removed, new as added
 *     (same idea as git replacing a whole file)
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

function logicalName(filename) {
  if (/^web\.[a-f0-9]+\.js$/i.test(filename)) return 'web';
  if (/^sentry\./i.test(filename)) return 'sentry';
  return filename
    .replace(/\.[a-f0-9]{8,}\./gi, '.')
    .replace(/\.[a-f0-9]{16,}/gi, '');
}

function measureContent(bufOrStr) {
  const text = Buffer.isBuffer(bufOrStr) ? bufOrStr.toString('utf8') : String(bufOrStr);
  const bytes = Buffer.byteLength(text, 'utf8');
  const lines = text.length ? text.split(/\r?\n/).length : 0;
  // Minified JS: token count is the useful “line” proxy
  const tokens = text.length ? text.split(';').length : 0;
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  // Prefer tokens for volume; fall back to lines if somehow huge line count
  const units = Math.max(tokens, lines > 20 ? lines : 0);
  return { bytes, lines, tokens, units, hash };
}

/**
 * Build map logicalName -> stats for all .js under assetsDir
 */
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
    // Cap read size for safety
    if (st.size > 25_000_000) continue;
    const buf = await fs.readFile(full);
    const m = measureContent(buf);
    const key = logicalName(name);
    // Keep largest file for a logical key (web.*.js)
    if (!files[key] || m.bytes > files[key].bytes) {
      files[key] = { ...m, file: name };
    }
  }

  let totalUnits = 0;
  for (const f of Object.values(files)) totalUnits += f.units;
  return { files, totalUnits };
}

/**
 * Compare previous persisted stats vs current.
 * Returns { added, removed, changedFiles, skipped }
 */
function diffAssetStats(prev, curr) {
  const prevFiles = (prev && prev.files) || {};
  const currFiles = (curr && curr.files) || {};

  if (!Object.keys(prevFiles).length) {
    return { added: 0, removed: 0, changedFiles: 0, skipped: true, reason: 'no_baseline' };
  }
  if (!Object.keys(currFiles).length) {
    return { added: 0, removed: 0, changedFiles: 0, skipped: true, reason: 'no_current' };
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
      // File replaced / rewritten (typical for hashed canary chunks)
      removed += a.units;
      added += b.units;
      changedFiles++;
    }
  }

  return { added, removed, changedFiles, skipped: false };
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
