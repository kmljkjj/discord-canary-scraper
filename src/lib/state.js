const fs = require('fs-extra');
const path = require('path');

async function loadState(dataDir) {
  const build = await readJson(path.join(dataDir, 'build.json'));
  const experiments = await readJson(path.join(dataDir, 'experiments.json'), []);
  const strings = await readJson(path.join(dataDir, 'strings.json'), {});
  const routes = await readJson(path.join(dataDir, 'routes.json'), {});
  const meta = await readJson(path.join(dataDir, 'meta.json'), {});
  return {
    initialized: !!meta.initialized,
    build,
    experiments: Array.isArray(experiments) ? experiments : [],
    strings: strings || {},
    routes: routes || {},
  };
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
    },
    { spaces: 2 },
  );
}

async function bootstrapSeen(dataDir, findings) {
  // Mark everything currently known so first notify is empty
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

module.exports = { loadState, saveState, bootstrapSeen };
