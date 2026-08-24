/**
 * Anti-spam: claim keys + permanent seen registry + per-run budget.
 * NO per-message cooldown (that blocked experiments after watch_build).
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = path.join(__dirname, '..', 'data', 'notify_state.json');
const SEEN_FILE = path.join(__dirname, '..', 'data', 'seen.json');
const MAX_KEYS = 1000;
const MAX_WEBHOOKS_PER_RUN = Number(process.env.MAX_WEBHOOKS_PER_RUN || 20);

let runCount = 0;

async function loadState() {
  try {
    if (await fs.pathExists(STATE_FILE)) return await fs.readJson(STATE_FILE);
  } catch {}
  return { keys: {}, lastBuildAnnounced: null };
}

async function saveState(state) {
  const entries = Object.entries(state.keys || {});
  if (entries.length > MAX_KEYS) {
    entries.sort((a, b) => (a[1] || 0) - (b[1] || 0));
    state.keys = Object.fromEntries(entries.slice(-MAX_KEYS));
  }
  await fs.ensureDir(path.dirname(STATE_FILE));
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
}

async function loadSeen() {
  try {
    if (await fs.pathExists(SEEN_FILE)) return await fs.readJson(SEEN_FILE);
  } catch {}
  return {
    experiments: [],
    stringKeys: [],
    ui: [],
    endpoints: [],
    mobileVersions: [],
  };
}

async function saveSeen(seen) {
  const cap = (arr, n) => [...new Set((arr || []).map(String))].slice(-n);
  seen.experiments = cap(seen.experiments, 8000);
  seen.stringKeys = cap(seen.stringKeys, 25000);
  seen.ui = cap(seen.ui, 8000);
  seen.endpoints = cap(seen.endpoints, 8000);
  seen.mobileVersions = cap(seen.mobileVersions, 500);
  await fs.ensureDir(path.dirname(SEEN_FILE));
  await fs.writeJson(SEEN_FILE, seen, { spaces: 2 });
}

function hashPayload(obj) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .slice(0, 20);
}

/** true = first time */
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
  state.keys['build-announce:' + buildNumber] = Date.now();
  await saveState(state);
}

async function wasBuildAnnounced(buildNumber) {
  return wasClaimed('build-announce:' + buildNumber);
}

/** Never-seen ids only; marks them seen */
async function takeNew(bucket, ids) {
  const seen = await loadSeen();
  const set = new Set((seen[bucket] || []).map(String));
  const fresh = [];
  for (const id of ids || []) {
    const k = String(id);
    if (!k || set.has(k)) continue;
    set.add(k);
    fresh.push(k);
  }
  if (fresh.length) {
    seen[bucket] = [...set];
    await saveSeen(seen);
  }
  return fresh;
}

/** Peek without marking */
async function peekNew(bucket, ids) {
  const seen = await loadSeen();
  const set = new Set((seen[bucket] || []).map(String));
  return (ids || []).map(String).filter((k) => k && !set.has(k));
}

function canSend() {
  if (runCount >= MAX_WEBHOOKS_PER_RUN) return false;
  runCount += 1;
  return true;
}

function resetRunBudget() {
  runCount = 0;
}

module.exports = {
  claim,
  wasClaimed,
  markBuildAnnounced,
  wasBuildAnnounced,
  hashPayload,
  takeNew,
  peekNew,
  canSend,
  resetRunBudget,
  loadSeen,
  STATE_FILE,
  SEEN_FILE,
  MAX_WEBHOOKS_PER_RUN,
};
