/** Load / save Canary scraper state with shared runId + buildNumber stamps. */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');

const SCHEMA_VERSION = 2;

function normalizeExperiments(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.experiments)) list = raw.experiments;
  else if (raw && typeof raw === 'object') {
    list = Object.values(raw).filter((x) => x && typeof x === 'object' && x.id);
  }
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e || !e.id) continue;
    const id = String(e.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: e.type === 'guild' ? 'guild' : e.type === 'user' ? 'user' : e.type || 'unknown',
      title: e.title || e.label || null,
      description: e.description || null,
      defaultConfig: e.defaultConfig || null,
      variations: e.variations || e.treatments || null,
    });
  }
  return out;
}

function makeRunId(buildNumber) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bn = String(buildNumber || 'na');
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${ts}_${bn}_${rnd}`;
}

function stamp(payload, { runId, buildNumber }) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    schemaVersion: SCHEMA_VERSION,
    runId,
    buildNumber: buildNumber != null ? String(buildNumber) : payload.buildNumber || null,
  };
}

async function loadState(dataDir) {
  const build = await readJson(path.join(dataDir, 'build.json'), null);
  const experimentsRaw = await readJson(path.join(dataDir, 'experiments.json'), null);
  const findings = await readJson(path.join(dataDir, 'findings.json'), null);
  const strings = await readJson(path.join(dataDir, 'strings.json'), {});
  const routes = await readJson(path.join(dataDir, 'routes.json'), {});
  const meta = await readJson(path.join(dataDir, 'meta.json'), {});

  const experiments = normalizeExperiments(experimentsRaw || findings);
  console.log('Loaded baseline experiments:', experiments.length);

  // Prefer explicit meta.initialized + schemaVersion; heuristics only for legacy data.
  const explicitInit = meta && meta.initialized === true && Number(meta.schemaVersion || 0) >= 2;
  const legacyInit =
    !!meta.initialized ||
    experiments.length > 10 ||
    Object.keys(strings || {}).length > 50 ||
    !!(build && build.buildNumber && build.buildNumber !== 'unknown');

  // Soft consistency check across stamped files (warn only — do not wipe baseline).
  const stamps = [
    build && build.runId,
    experimentsRaw && experimentsRaw.runId,
    meta && meta.runId,
  ].filter(Boolean);
  if (stamps.length >= 2 && new Set(stamps).size > 1) {
    console.warn(
      'STATE_STAMP_MISMATCH: state files may come from different runs',
      { stamps: [...new Set(stamps)] },
    );
  }

  return {
    initialized: explicitInit || legacyInit,
    build: build || null,
    experiments,
    strings:
      typeof strings === 'object' && !Array.isArray(strings) ? strings : {},
    routes: typeof routes === 'object' && !Array.isArray(routes) ? routes : {},
    meta: meta || {},
  };
}

/**
 * Write a coherent generation of state files:
 *  1) write all JSON into .state_staging/<runId>/
 *  2) atomic-move each into dataDir
 * So a crash mid-write cannot leave experiments.json from run A and strings.json from run B.
 */
async function saveState(dataDir, state) {
  await fs.ensureDir(dataDir);

  const buildNumber =
    state.build && state.build.buildNumber != null
      ? String(state.build.buildNumber)
      : null;
  if (!buildNumber || buildNumber === 'unknown') {
    throw new Error('saveState refused: missing or unknown buildNumber');
  }

  const runId = state.runId || makeRunId(buildNumber);
  const stampCtx = { runId, buildNumber };
  const stagingRoot = path.join(dataDir, '.state_staging');
  const staging = path.join(stagingRoot, runId);
  await fs.emptyDir(staging);

  const buildOut = stamp(
    {
      buildNumber,
      versionHash: (state.build && state.build.versionHash) || null,
      releaseChannel: (state.build && state.build.releaseChannel) || 'canary',
      scrapedAt: (state.build && state.build.scrapedAt) || new Date().toISOString(),
      assetCount: Array.isArray(state.build && state.build.assets)
        ? state.build.assets.length
        : (state.build && state.build.assetCount) || null,
      cssCount: Array.isArray(state.build && state.build.cssAssets)
        ? state.build.cssAssets.length
        : (state.build && state.build.cssCount) || null,
    },
    stampCtx,
  );

  const expPayload = stamp(
    {
      scrapedAt: new Date().toISOString(),
      totals: { all: (state.experiments || []).length },
      experiments: state.experiments || [],
    },
    stampCtx,
  );

  // strings/routes: wrap if plain map so we can stamp without breaking consumers that expect a map.
  // Keep flat map on disk for backward compat, but write a companion .meta is heavy —
  // instead embed _meta only in meta.json and stamp buildNumber/runId on exp/build.
  // For strings/routes we write the map as-is AND rely on meta.json + build.json for stamps.
  // Additional stamp files keep a generation marker.
  const genMarker = stamp(
    {
      files: [
        'build.json',
        'experiments.json',
        'findings.json',
        'strings.json',
        'routes.json',
        'meta.json',
      ],
      experimentCount: (state.experiments || []).length,
      stringCount: Object.keys(state.strings || {}).length,
      routeCount: Object.keys(state.routes || {}).length,
    },
    stampCtx,
  );

  const metaOut = stamp(
    {
      initialized: true,
      updatedAt: new Date().toISOString(),
      experimentCount: (state.experiments || []).length,
      stringCount: Object.keys(state.strings || {}).length,
      routeCount: Object.keys(state.routes || {}).length,
      lastBuild: buildNumber,
    },
    stampCtx,
  );

  // Write everything into staging first
  await writeJsonAtomic(path.join(staging, 'build.json'), buildOut);
  await writeJsonAtomic(path.join(staging, 'experiments.json'), expPayload);
  await writeJsonAtomic(path.join(staging, 'findings.json'), expPayload);
  await writeJsonAtomic(path.join(staging, 'strings.json'), state.strings || {}, null);
  await writeJsonAtomic(path.join(staging, 'routes.json'), state.routes || {}, null);
  await writeJsonAtomic(path.join(staging, 'meta.json'), metaOut);
  await writeJsonAtomic(path.join(staging, 'state_generation.json'), genMarker);

  // Atomic promote: move each staged file into dataDir
  const names = [
    'build.json',
    'experiments.json',
    'findings.json',
    'strings.json',
    'routes.json',
    'meta.json',
    'state_generation.json',
  ];
  for (const name of names) {
    const from = path.join(staging, name);
    const to = path.join(dataDir, name);
    await fs.move(from, to, { overwrite: true });
  }

  // Cleanup staging for this run (best-effort)
  try {
    await fs.remove(staging);
  } catch {}

  console.log('State saved', { runId, buildNumber, schemaVersion: SCHEMA_VERSION });
  return { runId, buildNumber };
}

async function readJson(p, fallback = null) {
  try {
    if (await fs.pathExists(p)) return await fs.readJson(p);
  } catch (e) {
    console.warn('readJson fail', p, e.message);
  }
  return fallback;
}

module.exports = {
  loadState,
  saveState,
  normalizeExperiments,
  makeRunId,
  SCHEMA_VERSION,
};
