const fs = require('fs-extra');
const path = require('path');

/**
 * experiments.json peut être:
 *  A) [ {id}, ... ]
 *  B) { experiments: [ {id}, ... ], totals, ... }
 */
function normalizeExperiments(raw) {
  if (!raw) return [];

  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.experiments)) list = raw.experiments;
  else if (raw && typeof raw === 'object') {
    list = Object.entries(raw)
      .filter(([k, v]) => k.includes('-') || k.includes('_') || (v && v.id))
      .map(([k, v]) =>
        v && typeof v === 'object' ? { id: v.id || k, ...v } : { id: k },
      );
  }
  if (!list) return [];

  return list
    .map((e) => {
      if (typeof e === 'string') {
        const type = /guild|server/i.test(e) ? 'guild' : 'user';
        return { id: e, type, kind: type, source: 'baseline' };
      }
      if (!e || !e.id) return null;
      // kind/type = user|guild uniquement (jamais apex/legacy)
      let type = e.type || e.kind || null;
      if (type === 'apex' || type === 'legacy' || type === 'user' || type === 'guild') {
        if (type === 'apex' || type === 'legacy') type = null;
      }
      if (type !== 'user' && type !== 'guild') {
        type = /guild|server/i.test(String(e.id)) ? 'guild' : 'user';
      }
      return {
        id: String(e.id),
        type,
        kind: type,
        label: e.label || null,
        variations: e.variations || null,
        variationCount:
          e.variationCount ||
          (e.variations && typeof e.variations === 'object'
            ? Object.keys(e.variations).length
            : 0) ||
          0,
        source: e.source || 'baseline',
      };
    })
    .filter(Boolean);
}

async function loadState(dataDir) {
  const build = await readJson(path.join(dataDir, 'build.json'));
  const experimentsRaw = await readJson(
    path.join(dataDir, 'experiments.json'),
    null,
  );
  const strings = await readJson(path.join(dataDir, 'strings.json'), {});
  const routes =
    (await readJson(path.join(dataDir, 'routes.json'), null)) ||
    (await readJson(path.join(dataDir, 'endpoints.json'), {})) ||
    {};
  const meta = await readJson(path.join(dataDir, 'meta.json'), {});

  const experiments = normalizeExperiments(experimentsRaw);
  console.log('Loaded baseline experiments:', experiments.length);

  const initialized =
    !!meta.initialized ||
    experiments.length > 10 ||
    Object.keys(strings || {}).length > 50 ||
    !!(build && build.buildNumber);

  return {
    initialized,
    build: build || null,
    experiments,
    strings:
      typeof strings === 'object' && !Array.isArray(strings) ? strings : {},
    routes: typeof routes === 'object' && !Array.isArray(routes) ? routes : {},
  };
}

async function saveState(dataDir, state) {
  await fs.ensureDir(dataDir);

  // build sans lister tous les assets (évite fichiers énormes / diffs git inutiles)
  const buildOut = state.build
    ? {
        buildNumber: state.build.buildNumber,
        versionHash: state.build.versionHash || null,
        releaseChannel: state.build.releaseChannel || 'canary',
        scrapedAt: state.build.scrapedAt || new Date().toISOString(),
        assetCount: Array.isArray(state.build.assets)
          ? state.build.assets.length
          : state.build.assetCount || null,
        cssCount: Array.isArray(state.build.cssAssets)
          ? state.build.cssAssets.length
          : state.build.cssCount || null,
      }
    : null;
  await fs.writeJson(path.join(dataDir, 'build.json'), buildOut, { spaces: 2 });

  await fs.writeJson(
    path.join(dataDir, 'experiments.json'),
    {
      scrapedAt: new Date().toISOString(),
      buildNumber: state.build && state.build.buildNumber,
      totals: { all: (state.experiments || []).length },
      experiments: state.experiments || [],
    },
    { spaces: 2 },
  );

  // strings/routes en compact (moins de RAM / I/O sur Actions)
  await fs.writeJson(path.join(dataDir, 'strings.json'), state.strings || {});
  await fs.writeJson(path.join(dataDir, 'routes.json'), state.routes || {});
  await fs.writeJson(
    path.join(dataDir, 'meta.json'),
    {
      initialized: true,
      updatedAt: new Date().toISOString(),
      experimentCount: (state.experiments || []).length,
      stringCount: Object.keys(state.strings || {}).length,
      routeCount: Object.keys(state.routes || {}).length,
      lastBuild: state.build && state.build.buildNumber,
    },
    { spaces: 2 },
  );
}

async function readJson(p, fallback = null) {
  try {
    if (await fs.pathExists(p)) return await fs.readJson(p);
  } catch (e) {
    console.warn('readJson fail', p, e.message);
  }
  return fallback;
}

module.exports = { loadState, saveState, normalizeExperiments };
