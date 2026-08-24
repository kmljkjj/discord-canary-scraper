/**
 * Canary scraper — notifs Build / Experiments / Strings / Endpoints
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
      prev: prev.build && prev.build.buildNumber,
      initialized: prev.initialized,
      prevExp: prev.experiments.length,
      prevStr: Object.keys(prev.strings).length,
      assets: (build.assets || []).length,
    }),
  );

  if (!build.buildNumber || build.buildNumber === 'unknown') {
    console.error('No BUILD_NUMBER');
    process.exit(1);
  }

  const isNewBuild =
    !prev.build ||
    !prev.build.buildNumber ||
    String(prev.build.buildNumber) !== String(build.buildNumber);

  // Même build + baseline OK → skip (hébergement 50s)
  if (!isNewBuild && prev.initialized && prev.experiments.length > 20) {
    console.log('FAST SKIP same build', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  console.log('FULL SCRAPE isNewBuild=' + isNewBuild);

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

  // Si extract vide : garder l'ancienne baseline, ne pas bootstrap
  if (
    findings.experiments.length < 5 &&
    Object.keys(findings.strings).length < 30
  ) {
    console.error('Extract too empty — keep previous state, no notify wipe');
    process.exit(1);
  }

  // Premier vrai bootstrap uniquement si vraiment aucune baseline
  if (!prev.initialized || prev.experiments.length < 5) {
    await bootstrapSeen(DATA, findings);
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: findings.experiments,
      strings: findings.strings,
      routes: findings.routes,
    });
    console.log('BOOTSTRAP', findings.experiments.length, 'experiments');

    // Annoncer le build au moins une fois
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
      newExp: diff.newExperiments.map((e) => e.id).slice(0, 30),
      newExpCount: diff.newExperiments.length,
      addStr: Object.keys(diff.strings.added).length,
      modStr: Object.keys(diff.strings.modified).length,
      addRt: Object.keys(diff.routes.added).length,
    }),
  );

  // Toujours notifier si nouveau build OU nouveaux findings
  const shouldNotify =
    isNewBuild ||
    diff.newExperiments.length > 0 ||
    Object.keys(diff.strings.added).length > 0 ||
    Object.keys(diff.strings.modified).length > 0 ||
    Object.keys(diff.routes.added).length > 0;

  if (shouldNotify) {
    if (!process.env.DISCORD_WEBHOOK_URL) {
      console.error('DISCORD_WEBHOOK_URL manquant — rien envoyé');
    } else {
      await notifyAll({
        build,
        isNewBuild,
        diff,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        stateDir: DATA,
      });
    }
  } else {
    console.log('Nothing to notify');
  }

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
  for (const e of prev || []) map.set(e.id, e);
  for (const e of next || []) map.set(e.id, e);
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
