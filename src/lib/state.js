const fs = require('fs-extra');
const path = require('path');

/**
 * experiments.json peut être:
 *  A) [ {id}, ... ]
 *  B) { experiments: [ {id}, ... ], totals, ... }  ← format actuel du repo
 */
function normalizeExperiments(raw) {
  if (!raw) return [];

  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.experiments)) list = raw.experiments;
  else if (raw && typeof raw === 'object') {
    // map id -> obj (sans prendre scrapedAt/totals)
    list = Object.entries(raw)
      .filter(([k, v]) => k.includes('-') || k.includes('_') || (v && v.id))
      .map(([k, v]) => (v && typeof v === 'object' ? { id: v.id || k, ...v } : { id: k }));
  }
  if (!list) return [];

  return list
    .map((e) => {
      if (typeof e === 'string') {
        return {
          id: e,
          type: /guild|server/i.test(e) ? 'guild' : 'user',
          kind: e.includes('_') ? 'legacy' : 'apex',
        };
      }
      if (!e || !e.id) return null;
      return {
        id: String(e.id),
        type: e.kind || e.type || (/guild|server/i.test(e.id) ? 'guild' : 'user'),
        kind: e.isApex === false || String(e.id).includes('_') ? 'legacy' : 'apex',
        label: e.label || null,
      };
    })
    .filter(Boolean);
}

async function loadState(dataDir) {
  const build = await readJson(path.join(dataDir, 'build.json'));
  const experimentsRaw = await readJson(path.join(dataDir, 'experiments.json'), null);
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
    strings: typeof strings === 'object' && !Array.isArray(strings) ? strings : {},
    routes: typeof routes === 'object' && !Array.isArray(routes) ? routes : {},
    experimentsRawFormat: experimentsRaw && experimentsRaw.experiments ? 'wrapped' : 'array',
  };
}

async function saveState(dataDir, state) {
  await fs.ensureDir(dataDir);
  await fs.writeJson(path.join(dataDir, 'build.json'), state.build, { spaces: 2 });

  // Toujours format clair : { experiments: [...] }
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

  await fs.writeJson(path.join(dataDir, 'strings.json'), state.strings || {}, {
    spaces: 2,
  });
  await fs.writeJson(path.join(dataDir, 'routes.json'), state.routes || {}, {
    spaces: 2,
  });
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

async function bootstrapSeen(dataDir, findings) {
  await fs.writeJson(
    path.join(dataDir, 'seen.json'),
    {
      experiments: findings.experiments.map((e) => e.id),
      stringKeys: Object.keys(findings.strings || {}),
      routes: Object.keys(findings.routes || {}),
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

module.exports = { loadState, saveState, bootstrapSeen, normalizeExperiments };
