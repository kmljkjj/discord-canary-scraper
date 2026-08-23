/**
 * Anti-spam for Discord webhooks.
 *
 * 1) claim(key) — one-shot keys (build-announce:123, ...)
 * 2) seen registry — experiment / string / UI / endpoint ids never re-notified
 * 3) run budget — max webhooks per process
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = path.join(__dirname, '..', 'data', 'notify_state.json');
const SEEN_FILE = path.join(__dirname, '..', 'data', 'seen.json');
const MAX_KEYS = 500;
const MAX_WEBHOOKS_PER_RUN = Number(process.env.MAX_WEBHOOKS_PER_RUN || 8);

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
  // hard caps to keep file small
  const cap = (arr, n) => [...new Set(arr || [])].slice(-n);
  seen.experiments = cap(seen.experiments, 5000);
  seen.stringKeys = cap(seen.stringKeys, 20000);
  seen.ui = cap(seen.ui, 5000);
  seen.endpoints = cap(seen.endpoints, 5000);
  seen.mobileVersions = cap(seen.mobileVersions, 500);
  await fs.ensureDir(path.dirname(SEEN_FILE));
  await fs.writeJson(SEEN_FILE, seen, { spaces: 2 });
}

function hashPayload(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 20);
}

/** true = first time (allowed). false = already sent */
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

/** Filter list of ids against seen[bucket], mark them seen, return only new */
async function takeNew(bucket, ids) {
  const seen = await loadSeen();
  const set = new Set(seen[bucket] || []);
  const fresh = [];
  for (const id of ids) {
    const k = String(id);
    if (!k || set.has(k)) continue;
    set.add(k);
    fresh.push(k);
  }
  seen[bucket] = [...set];
  await saveSeen(seen);
  return fresh;
}

/** Budget: returns false when this run already sent too many webhooks */
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
  canSend,
  resetRunBudget,
  loadSeen,
  STATE_FILE,
  SEEN_FILE,
  MAX_WEBHOOKS_PER_RUN,
};
