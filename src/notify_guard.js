/**
 * Prevent duplicate Discord webhook messages across:
 * - watch_build.js + scrape.js (same run)
 * - overlapping GHA runs (schedule + dispatch)
 *
 * State is stored in data/notify_state.json and committed with data/.
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = path.join(__dirname, '..', 'data', 'notify_state.json');
const MAX_KEYS = 400;

async function loadState() {
  try {
    if (await fs.pathExists(STATE_FILE)) return await fs.readJson(STATE_FILE);
  } catch {}
  return { keys: {}, lastBuildAnnounced: null };
}

async function saveState(state) {
  // prune oldest keys
  const entries = Object.entries(state.keys || {});
  if (entries.length > MAX_KEYS) {
    entries.sort((a, b) => (a[1] || 0) - (b[1] || 0));
    state.keys = Object.fromEntries(entries.slice(-MAX_KEYS));
  }
  await fs.ensureDir(path.dirname(STATE_FILE));
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
}

function hashPayload(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 20);
}

/**
 * Returns true if this key was NOT sent yet and records it.
 * Returns false if already sent (caller must skip webhook).
 */
async function claim(key) {
  const state = await loadState();
  if (!state.keys) state.keys = {};
  if (state.keys[key]) return false;
  state.keys[key] = Date.now();
  await saveState(state);
  return true;
}

async function wasClaimed(key) {
  const state = await loadState();
  return !!(state.keys && state.keys[key]);
}

async function markBuildAnnounced(buildNumber) {
  const state = await loadState();
  state.lastBuildAnnounced = String(buildNumber);
  state.keys = state.keys || {};
  state.keys[`build-announce:${buildNumber}`] = Date.now();
  await saveState(state);
}

async function wasBuildAnnounced(buildNumber) {
  return wasClaimed(`build-announce:${buildNumber}`);
}

module.exports = {
  claim,
  wasClaimed,
  markBuildAnnounced,
  wasBuildAnnounced,
  hashPayload,
  STATE_FILE,
};
