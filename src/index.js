/**
 * Canary Pulse v11.7 — priority pipeline + integrity gates
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState } = require('./lib/state');
const { notifyUrgent, notifyNormal } = require('./lib/notify');
const { archiveBuildChunks, writeZipHint } = require('./lib/archive_chunks');
const { writeJsonAtomic } = require('./lib/atomic');
const ALREADY_NOTIFIED = require('./lib/already_notified');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');
const BUILDS = path.join(__dirname, '..', 'builds');
const CACHE = path.join(DATA, 'cache');
const KNOWN_EXP = path.join(DATA, 'known_experiment_ids.json');
const KNOWN_STR = path.join(DATA, 'known_string_keys.json');
const KNOWN_RT = path.join(DATA, 'known_route_keys.json');
const LAST_EXTRACT_STR = path.join(DATA, 'last_extract_strings.json');
const LAST_EXTRACT_RT = path.join(DATA, 'last_extract_routes.json');
const LAST_EXTRACT_EXP = path.join(DATA, 'last_extract_experiments.json');
const ANNOUNCED = path.join(DATA, 'announced_builds.json');
const LAST_RUN_META = path.join(DATA, 'last_run_meta.json');

const MAX_NOTIFY_EXP = 30;
const MAX_NOTIFY_STR = 80;
const MAX_NOTIFY_RT = 40;
const MIN_STRINGS_FOR_DIFF = 200;
const MIN_ROUTES_FOR_DIFF = 50;
const MIN_EXP_FOR_DIFF = 80;

const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

async function loadKnownIds(file, fromAlready) {
  const set = new Set();
  if (fromAlready) for (const id of ALREADY_NOTIFIED) set.add(String(id));
  try {
    if (await fs.pathExists(file)) {
      const d = await fs.readJson(file);
      for (const id of d.ids || d.keys || []) set.add(String(id));
    }
  } catch {}
  return set;
}

async function saveKnownIds(file, set, maxKeep) {
  let ids = [...set].filter((id) => id && !String(id).startsWith('hash:')).sort();
  if (maxKeep && ids.length > maxKeep) ids = ids.slice(-maxKeep);
  await writeJsonAtomic(file, {
    updatedAt: new Date().toISOString(),
    count: ids.length,
    ids,
  });
}

async function loadLastMap(file) {
  try {
    if (!(await fs.pathExists(file))) return {};
    const d = await fs.readJson(file);
    const raw =
      d.data && typeof d.data === 'object'
        ? d.data
        : d.strings || d.routes || d.experiments || d || {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'buildNumber' || k === 'updatedAt' || k === 'count' || k === 'data')
        continue;
      out[k] = v;
    }
    return out;
  } catch (e) {
    console.warn('loadLastMap fail', file, e.message);
    return {};
  }
}

async function saveLastMap(file, data, buildNumber) {
  await writeJsonAtomic(file, {
    buildNumber: String(buildNumber),
    updatedAt: new Date().toISOString(),
    count: Object.keys(data || {}).length,
    data,
  });
}

module.exports = {}; // PLACEHOLDER_PARTIAL — run Restore index v11.8 workflow
console.error('index.js is incomplete — run workflow Restore index v11.8');
process.exit(1);
