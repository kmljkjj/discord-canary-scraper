/**
 * Canary scraper — experiments + strings notifiés UNE seule fois.
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState, bootstrapSeen } = require('./lib/state');
const { computeDiff } = require('./lib/diff');
const {
  notifyAll,
  loadNotified,
  saveNotified,
  loadNotifiedStrings,
  saveNotifiedStrings,
} = require('./lib/notify');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Scraper v5 (no re-notify exp+str) ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  const prev = await loadState(DATA);
  const build = await fetchBuild();

  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prev.build && prev.build.buildNumber,
      baselineExp: prev.experiments.length,
      baselineStr: Object.keys(prev.strings || {}).length,
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

  if (!isNewBuild && prev.initialized && prev.experiments.length > 20) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  console.log('FULL SCRAPE isNewBuild=' + isNewBuild);
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
    }),
  );

  if (
    findings.experiments.length < 5 &&
    Object.keys(findings.strings).length < 20
  ) {
    console.error('Extract empty — abort');
    process.exit(1);
  }

  const mergedExps = mergeExp(prev.experiments, findings.experiments);
  const mergedStrings =
    Object.keys(findings.strings).length > 30
      ? { ...prev.strings, ...findings.strings }
      : prev.strings;
  const mergedRoutes =
    Object.keys(findings.routes).length > 5
      ? { ...prev.routes, ...findings.routes }
      : prev.routes;

  const allCurrentIds = mergedExps.map((e) => e.id);
  const baselineIds = prev.experiments.map((e) => e.id);
  const baselineStringKeys = Object.keys(prev.strings || {});
  const allCurrentStringKeys = Object.keys(mergedStrings || {});

  // Bootstrap
  if (!prev.initialized || prev.experiments.length < 5) {
    await bootstrapSeen(DATA, findings);
    await saveNotified(
      DATA,
      new Set(findings.experiments.map((e) => String(e.id))),
    );
    await saveNotifiedStrings(
      DATA,
      new Set(Object.keys(findings.strings || {})),
    );
    await fs.writeJson(
      path.join(DATA, 'sent.json'),
      {
        builds: [String(build.buildNumber)],
        experiments: findings.experiments.map((e) => e.id),
        strings: Object.keys(findings.strings),
        routes: Object.keys(findings.routes),
        updatedAt: new Date().toISOString(),
      },
      { spaces: 2 },
    );
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: findings.experiments,
      strings: findings.strings,
      routes: findings.routes,
    });
    console.log('BOOTSTRAP — baseline only, no flood');
    if (process.env.DISCORD_WEBHOOK_URL) {
      await notifyAll({
        build,
        isNewBuild: true,
        diff: emptyDiff(),
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        stateDir: DATA,
        baselineIds: findings.experiments.map((e) => e.id),
        allCurrentIds: findings.experiments.map((e) => e.id),
        baselineStringKeys: Object.keys(findings.strings || {}),
        allCurrentStringKeys: Object.keys(findings.strings || {}),
      });
    }
    console.log('=== Done bootstrap', Date.now() - t0 + 'ms ===');
    return;
  }

  // Repair notified sets from baseline
  const notified = await loadNotified(DATA);
  let repairedExp = 0;
  for (const id of baselineIds) {
    if (!notified.has(String(id))) {
      notified.add(String(id));
      repairedExp++;
    }
  }
  if (repairedExp) {
    await saveNotified(DATA, notified);
    console.log('Repaired notified experiments +', repairedExp);
  }

  const notifiedStr = await loadNotifiedStrings(DATA);
  let repairedStr = 0;
  for (const k of baselineStringKeys) {
    if (!notifiedStr.has(String(k))) {
      notifiedStr.add(String(k));
      repairedStr++;
    }
  }
  if (repairedStr) {
    await saveNotifiedStrings(DATA, notifiedStr);
    console.log('Repaired notified strings +', repairedStr);
  }

  const diff = computeDiff(prev, findings);
  diff.newExperiments = (diff.newExperiments || []).filter(
    (e) => e && e.id && !notified.has(String(e.id)),
  );
  // Strings: only keys not already notified
  if (diff.strings && diff.strings.added) {
    const cleaned = {};
    for (const [k, v] of Object.entries(diff.strings.added)) {
      if (!notifiedStr.has(String(k))) cleaned[k] = v;
    }
    diff.strings.added = cleaned;
  }

  console.log(
    'DIFF',
    JSON.stringify({
      newExpCount: diff.newExperiments.length,
      newExpSample: diff.newExperiments.slice(0, 15).map((e) => e.id),
      addStr: Object.keys(diff.strings.added).length,
      addRt: Object.keys(diff.routes.added).length,
    }),
  );

  if (process.env.DISCORD_WEBHOOK_URL) {
    await notifyAll({
      build,
      isNewBuild,
      diff,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      stateDir: DATA,
      baselineIds,
      allCurrentIds,
      baselineStringKeys,
      allCurrentStringKeys,
    });
  } else {
    console.error('NO DISCORD_WEBHOOK_URL');
  }

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergedExps,
    strings: mergedStrings,
    routes: mergedRoutes,
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
  return [...map.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
