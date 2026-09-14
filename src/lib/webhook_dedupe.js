/**
 * Dedupe layer for Discord webhooks
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const DEDUPE_FILE = path.join(__dirname, '..', '..', 'data', 'notify_dedupe.json');

async function wasPosted(fp) {
  try {
    if (!(await fs.pathExists(DEDUPE_FILE))) return false;
    const d = await fs.readJson(DEDUPE_FILE);
    const ts = (d.fps || {})[fp];
    return ts ? Date.now() - Number(ts) < 6 * 3600 * 1000 : false;
  } catch {
    return false;
  }
}

async function markPosted(fp) {
  try {
    let d = { fps: {} };
    if (await fs.pathExists(DEDUPE_FILE)) d = await fs.readJson(DEDUPE_FILE);
    d.fps = d.fps || {};
    d.fps[fp] = Date.now();
    const cut = Date.now() - 12 * 3600 * 1000;
    for (const [k, v] of Object.entries(d.fps)) {
      if (Number(v) < cut) delete d.fps[k];
    }
    const keys = Object.keys(d.fps);
    if (keys.length > 400) {
      keys.sort((a, b) => d.fps[a] - d.fps[b]);
      for (const k of keys.slice(0, keys.length - 400)) delete d.fps[k];
    }
    await fs.ensureDir(path.dirname(DEDUPE_FILE));
    await fs.writeJson(DEDUPE_FILE, d);
  } catch (e) {
    console.warn('dedupe mark fail', e.message);
  }
}

function payloadFingerprint(body) {
  const embeds = body.embeds || [];
  const core = embeds.map((e) => ({
    t: e.title || '',
    d: String(e.description || '').slice(0, 240),
    f: (e.fields || [])
      .map((x) => String(x.name || '') + ':' + String(x.value || '').slice(0, 80))
      .join('|')
      .slice(0, 400),
  }));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ u: body.username, core }))
    .digest('hex')
    .slice(0, 20);
}

module.exports = { wasPosted, markPosted, payloadFingerprint };
