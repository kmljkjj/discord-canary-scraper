const fs = require('fs-extra');
const path = require('path');

async function loadState(dataDir) {
  const build = await readJson(path.join(dataDir, 'build.json'));
  const experiments = await readJson(path.join(dataDir, 'experiments.json'), []);
  const strings = await readJson(path.join(dataDir, 'strings.json'), {});
  const routes =
    (await readJson(path.join(dataDir, 'routes.json'), null)) ||
    (await readJson(path.join(dataDir, 'endpoints.json'), {})) ||
    {};
  const meta = await readJson(path.join(dataDir, 'meta.json'), {});

  const expList = normalizeExperiments(experiments);
  // Baseline = meta flag OU données déjà présentes (évite bootstrap infini)
  const initialized =
    !!meta.initialized ||
    expList.length > 20 ||
    Object.keys(strings || {}).length > 100 ||
    !!(build && build.buildNumber);

  return {
    initialized,
    build: build || null,
    experiments: expList,
    strings: strings || {},
    routes: routes || {},
  };
}

function normalizeExperiments(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((e) => {
        if (typeof e === 'string') return { id: e, type: 'user', kind: 'apex' };
        if (e && e.id) return e;
        if (e && e.name) return { id: e.name, type: e.type || 'user', kind: e.kind || 'apex' };
        return null;
      })
      .filter(Boolean);
  }
  // object map id -> info
  if (typeof raw === 'object') {
    return Object.keys(raw).map((id) => {
      const v = raw[id];
      if (v && typeof v === 'object') return { id, ...v };
      return { id, type: 'user', kind: 'apex' };
    });
  }
  return [];
}

async function saveState(dataDir, state) {
  await fs.ensureDir(dataDir);
  await fs.writeJson(path.join(dataDir, 'build.json'), state.build, { spaces: 2 });
  await fs.writeJson(path.join(dataDir, 'experiments.json'), state.experiments, {
    spaces: 2,
  });
  await fs.writeJson(path.join(dataDir, 'strings.json'), state.strings, {
    spaces: 2,
  });
  await fs.writeJson(path.join(dataDir, 'routes.json'), state.routes, {
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
      stringKeys: Object.keys(findings.strings),
      routes: Object.keys(findings.routes),
    },
    { spaces: 2 },
  );
}

async function readJson(p, fallback = null) {
  try {
    if (await fs.pathExists(p)) return await fs.readJson(p);
  } catch {}
  return fallback;
}

module.exports = { loadState, saveState, bootstrapSeen, normalizeExperiments };
