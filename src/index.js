/**
 * Canary scraper — notifs fiables
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
  console.log('=== Canary Scraper v3 ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  const prev = await loadState(DATA);
  const build = await fetchBuild();

  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prev.build && prev.build.buildNumber,
      initialized: prev.initialized,
      baselineExp: prev.experiments.length,
      baselineStr: Object.keys(prev.strings).length,
      assetsListed: (build.assets || []).length,
    }),
  );

  if (!build.buildNumber || build.buildNumber === 'unknown') {
    console.error('FATAL no BUILD_NUMBER');
    process.exit(1);
  }

  const isNewBuild =
    !prev.build ||
    !prev.build.buildNumber ||
    String(prev.build.buildNumber) !== String(build.buildNumber);

  // FAST SKIP seulement si même build ET baseline OK
  if (!isNewBuild && prev.initialized && prev.experiments.length > 20) {
    console.log('FAST SKIP same build', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  console.log('FULL SCRAPE…');
  const findings = await analyzeAssets(build, {
    forceRefresh: true,
    assetsDir: ASSETS,
  });

  console.log(
    'EXTRACT',
    JSON.stringify({
      experiments: findings.experiments.length,
      strings: Object.keys(findings.strings).length,
      routes: Object.keys(findings.routes).length,
      sampleExp: findings.experiments.slice(0, 5).map((e) => e.id),
    }),
  );

  if (findings.experiments.length < 5 && Object.keys(findings.strings).length < 20) {
    console.error('Extract too empty — abort');
    process.exit(1);
  }

  // Bootstrap réel (première fois)
  if (!prev.initialized || prev.experiments.length < 5) {
    await bootstrapSeen(DATA, findings);
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: findings.experiments,
      strings: findings.strings,
      routes: findings.routes,
    });
    console.log('BOOTSTRAP saved', findings.experiments.length);
    if (process.env.DISCORD_WEBHOOK_URL) {
      await notifyAll({
        build,
        isNewBuild: true,
        diff: emptyDiff(),
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        stateDir: DATA,
      });
    } else {
      console.error('NO DISCORD_WEBHOOK_URL secret');
    }
    console.log('=== Done bootstrap', Date.now() - t0 + 'ms ===');
    return;
  }

  const diff = computeDiff(prev, findings);
  console.log(
    'DIFF',
    JSON.stringify({
      newExpCount: diff.newExperiments.length,
      newExpIds: diff.newExperiments.slice(0, 25).map((e) => e.id),
      addStr: Object.keys(diff.strings.added).length,
      modStr: Object.keys(diff.strings.modified).length,
      addRt: Object.keys(diff.routes.added).length,
    }),
  );

  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.error('NO DISCORD_WEBHOOK_URL — cannot notify');
  } else {
    await notifyAll({
      build,
      isNewBuild,
      diff,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      stateDir: DATA,
    });
  }

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergeExp(prev.experiments, findings.experiments),
    strings:
      Object.keys(findings.strings).length > 30
        ? { ...prev.strings, ...findings.strings }
        : prev.strings,
    routes:
      Object.keys(findings.routes).length > 5
        ? { ...prev.routes, ...findings.routes }
        : prev.routes,
  });

  console.log('=== Done', Date.now() - t0 + 'ms ===');
}

function emptyDiff() {
  return {
    newExperiments: [],
    strings: { added: {}, removed: {}, modified: {} },
    routes: { added: {}, removed: {}, modified: {} },
  };
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
