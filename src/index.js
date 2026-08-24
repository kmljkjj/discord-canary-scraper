/**
 * Canary scraper — compatible hébergement 50s
 *
 * Même build + baseline OK → exit rapide (~10s)
 * Sinon → full download + extract + notify (ne doit PAS être cancel)
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
  const t0 = Date.now();
  console.log('=== Canary Scraper ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  const prev = await loadState(DATA);
  const build = await fetchBuild();

  console.log(
    JSON.stringify({
      remote: build.buildNumber,
      hash: (build.versionHash || '').slice(0, 12),
      assets: (build.assets || []).length,
      prevBuild: prev.build && prev.build.buildNumber,
      initialized: !!prev.initialized,
      prevExp: (prev.experiments || []).length,
      prevStr: Object.keys(prev.strings || {}).length,
    }),
  );

  if (!build.buildNumber || build.buildNumber === 'unknown') {
    console.error('FATAL: no BUILD_NUMBER');
    process.exit(1);
  }

  const isNewBuild =
    !prev.build ||
    !prev.build.buildNumber ||
    String(prev.build.buildNumber) !== String(build.buildNumber);

  const hasBaseline =
    !!prev.initialized &&
    ((prev.experiments || []).length > 0 || Object.keys(prev.strings || {}).length > 100);

  // FAST PATH
  if (!isNewBuild && hasBaseline) {
    console.log('FAST SKIP same build', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  console.log('FULL SCRAPE isNewBuild=' + isNewBuild + ' hasBaseline=' + hasBaseline);

  const findings = await analyzeAssets(build, {
    forceRefresh: true,
    assetsDir: ASSETS,
  });

  console.log(
    'Extracted',
    JSON.stringify({
      experiments: findings.experiments.length,
      strings: Object.keys(findings.strings).length,
      routes: Object.keys(findings.routes).length,
    }),
  );

  if (findings.experiments.length === 0 && Object.keys(findings.strings).length < 30) {
    console.error('Extraction empty — abort save to avoid wiping baseline');
    process.exit(1);
  }

  // Bootstrap
  if (!hasBaseline) {
    await bootstrapSeen(DATA, findings);
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: findings.experiments,
      strings: findings.strings,
      routes: findings.routes,
    });
    console.log('BOOTSTRAP saved', findings.experiments.length, 'experiments');

    if (process.env.DISCORD_WEBHOOK_URL) {
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
    console.log('=== Done bootstrap', Date.now() - t0 + 'ms ===');
    return;
  }

  const diff = computeDiff(prev, findings);
  console.log(
    'Diff',
    JSON.stringify({
      newExp: diff.newExperiments.length,
      addStr: Object.keys(diff.strings.added).length,
      modStr: Object.keys(diff.strings.modified).length,
      addRt: Object.keys(diff.routes.added).length,
    }),
  );

  await notifyAll({
    build,
    isNewBuild,
    diff,
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
    stateDir: DATA,
  });

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergeExp(prev.experiments, findings.experiments),
    strings:
      Object.keys(findings.strings).length > 50
        ? { ...prev.strings, ...findings.strings }
        : prev.strings,
    routes:
      Object.keys(findings.routes).length > 10
        ? { ...prev.routes, ...findings.routes }
        : prev.routes,
  });

  console.log('=== Done', Date.now() - t0 + 'ms ===');
}

function mergeExp(prev, next) {
  const map = new Map();
  for (const e of prev || []) {
    const id = e.id || e;
    map.set(id, typeof e === 'string' ? { id: e, type: 'user', kind: 'apex' } : e);
  }
  for (const e of next || []) map.set(e.id, e);
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
