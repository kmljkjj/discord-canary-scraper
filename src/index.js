/**
 * Discord Canary Scraper — Wumpus + Discord Previews style
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState, bootstrapSeen } = require('./lib/state');
const { computeDiff } = require('./lib/diff');
const { notifyAll } = require('./lib/notify');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');

async function main() {
  console.log('=== Canary Scraper ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  const prev = await loadState(DATA);
  const build = await fetchBuild();
  console.log('Remote build:', build.buildNumber, (build.versionHash || '').slice(0, 12));
  console.log('Assets listed:', (build.assets || []).length);

  const isNewBuild =
    !prev.build ||
    !prev.build.buildNumber ||
    String(prev.build.buildNumber) !== String(build.buildNumber);

  // CRITICAL: GitHub Actions disk is empty every run → always download if no JS cached
  let hasLocalJs = false;
  try {
    const files = (await fs.readdir(ASSETS)).filter((f) => f.endsWith('.js'));
    hasLocalJs = files.length > 0;
  } catch {}

  const forceRefresh = isNewBuild || !hasLocalJs;
  console.log('isNewBuild:', isNewBuild, '| forceRefresh:', forceRefresh, '| hasLocalJs:', hasLocalJs);

  const findings = await analyzeAssets(build, {
    forceRefresh,
    assetsDir: ASSETS,
  });

  console.log('Extracted:', {
    experiments: findings.experiments.length,
    strings: Object.keys(findings.strings).length,
    routes: Object.keys(findings.routes).length,
  });

  if (findings.experiments.length === 0 && Object.keys(findings.strings).length === 0) {
    console.error('ERROR: extraction empty — assets may have failed to download');
    // still save build so we do not loop bootstrap forever with empty data
  }

  // Bootstrap once when no prior baseline (or previous baseline was empty)
  const needBootstrap =
    !prev.initialized ||
    ((prev.experiments || []).length === 0 && findings.experiments.length > 0);

  if (needBootstrap && findings.experiments.length + Object.keys(findings.strings).length > 0) {
    await bootstrapSeen(DATA, findings);
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: findings.experiments,
      strings: findings.strings,
      routes: findings.routes,
    });
    console.log('Bootstrapped baseline (', findings.experiments.length, 'experiments ). No flood.');
    // Optional: still announce new build if it is the first time we see this number
    if (isNewBuild && process.env.DISCORD_WEBHOOK_URL) {
      await notifyAll({
        build,
        isNewBuild: true,
        diff: {
          newExperiments: [],
          strings: { added: {}, removed: {}, modified: {} },
          routes: { added: {}, removed: {}, modified: {} },
        },
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        stateDir: DATA,
      });
    }
    console.log('=== Done (bootstrap) ===');
    return;
  }

  const diff = computeDiff(prev, findings);
  console.log('Diff:', {
    newExp: diff.newExperiments.length,
    addedStr: Object.keys(diff.strings.added).length,
    modifiedStr: Object.keys(diff.strings.modified).length,
    addedRoutes: Object.keys(diff.routes.added).length,
  });

  await notifyAll({
    build,
    isNewBuild,
    diff,
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
    stateDir: DATA,
  });

  // Merge strings/routes so we never shrink baseline from a partial download
  const mergedStrings =
    Object.keys(findings.strings).length > 100
      ? { ...(prev.strings || {}), ...findings.strings }
      : prev.strings || findings.strings;
  const mergedRoutes =
    Object.keys(findings.routes).length > 20
      ? { ...(prev.routes || {}), ...findings.routes }
      : prev.routes || findings.routes;
  const mergedExps =
    findings.experiments.length >= (prev.experiments || []).length
      ? findings.experiments
      : mergeExperiments(prev.experiments || [], findings.experiments);

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergedExps,
    strings: mergedStrings,
    routes: mergedRoutes,
  });

  console.log('=== Done ===');
}

function mergeExperiments(prev, next) {
  const map = new Map();
  for (const e of prev) map.set(e.id || e, typeof e === 'string' ? { id: e } : e);
  for (const e of next) map.set(e.id, e);
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
