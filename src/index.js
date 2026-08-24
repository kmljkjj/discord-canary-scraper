/**
 * Canary scraper — optimisé hébergement (dispatch fréquent)
 *
 * - Même build  → sortie en quelques secondes (pas de download)
 * - Nouveau build → download + extract + notify + save
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
    'Remote build:',
    build.buildNumber,
    (build.versionHash || '').slice(0, 12),
    '| assets:',
    (build.assets || []).length,
  );

  const isNewBuild =
    !prev.build ||
    !prev.build.buildNumber ||
    String(prev.build.buildNumber) !== String(build.buildNumber);

  console.log(
    'isNewBuild:',
    isNewBuild,
    '| initialized:',
    !!prev.initialized,
    '| prevExp:',
    (prev.experiments || []).length,
  );

  // ── FAST PATH: même build + déjà initialisé → rien à faire ──
  if (!isNewBuild && prev.initialized && (prev.experiments || []).length > 0) {
    console.log(
      'FAST SKIP (same build',
      build.buildNumber,
      ') in',
      Date.now() - t0,
      'ms',
    );
    process.exit(0);
  }

  // ── FULL PATH: nouveau build ou premier run ──
  console.log('FULL SCRAPE…');
  const findings = await analyzeAssets(build, {
    forceRefresh: true, // toujours frais sur full path
    assetsDir: ASSETS,
  });

  console.log('Extracted:', {
    experiments: findings.experiments.length,
    strings: Object.keys(findings.strings).length,
    routes: Object.keys(findings.routes).length,
  });

  if (
    findings.experiments.length === 0 &&
    Object.keys(findings.strings).length < 50
  ) {
    console.error('Extraction quasi vide — réseau ou HTML canary ?');
  }

  // Bootstrap : pose la baseline sans spammer le salon
  const needBootstrap =
    !prev.initialized ||
    ((prev.experiments || []).length === 0 && findings.experiments.length > 0);

  if (needBootstrap) {
    await bootstrapSeen(DATA, findings);
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: findings.experiments,
      strings: findings.strings,
      routes: findings.routes,
    });
    console.log(
      'Bootstrap OK —',
      findings.experiments.length,
      'experiments enregistrés',
    );

    // Annoncer le build si vraiment nouveau (premier passage)
    if (isNewBuild && process.env.DISCORD_WEBHOOK_URL) {
      await notifyAll({
        build,
        isNewBuild: true,
        diff: emptyDiff(),
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        stateDir: DATA,
      });
    }
    console.log('=== Done (bootstrap)', Date.now() - t0, 'ms ===');
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

  const mergedExps = mergeExperiments(
    prev.experiments || [],
    findings.experiments,
  );
  const mergedStrings =
    Object.keys(findings.strings).length > 50
      ? { ...(prev.strings || {}), ...findings.strings }
      : prev.strings || findings.strings;
  const mergedRoutes =
    Object.keys(findings.routes).length > 10
      ? { ...(prev.routes || {}), ...findings.routes }
      : prev.routes || findings.routes;

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergedExps,
    strings: mergedStrings,
    routes: mergedRoutes,
  });

  console.log('=== Done', Date.now() - t0, 'ms ===');
}

function emptyDiff() {
  return {
    newExperiments: [],
    strings: { added: {}, removed: {}, modified: {} },
    routes: { added: {}, removed: {}, modified: {} },
  };
}

function mergeExperiments(prev, next) {
  const map = new Map();
  for (const e of prev) {
    const id = e.id || e;
    map.set(id, typeof e === 'string' ? { id: e, type: 'user', kind: 'apex' } : e);
  }
  for (const e of next) map.set(e.id, e);
  return [...map.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
