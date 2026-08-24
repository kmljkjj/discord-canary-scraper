/**
 * Discord Canary Scraper — Wumpus Central style pipeline + Discord Previews style notifies
 *
 * Flow (like Wumpus blog-tracker / discrapper):
 *  1. Fetch canary.discord.com → BUILD_NUMBER + asset list
 *  2. Download priority JS (web.*.js + chunks)
 *  3. Extract strings / routes / experiment ids
 *  4. Diff against data/*.json
 *  5. Notify only real deltas (deduped)
 *  6. Persist state for next run
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState, bootstrapSeen } = require('./lib/state');
const { computeDiff } = require('./lib/diff');
const { notifyAll } = require('./lib/notify');

const DATA = path.join(__dirname, '..', 'data');

async function main() {
  console.log('=== Canary Scraper (Wumpus + Previews style) ===');
  await fs.ensureDir(DATA);

  const prev = await loadState(DATA);
  const build = await fetchBuild();
  console.log('Remote build:', build.buildNumber, build.versionHash?.slice(0, 12));

  const isNewBuild =
    !prev.build || String(prev.build.buildNumber) !== String(build.buildNumber);
  console.log('isNewBuild:', isNewBuild);

  // Always refresh assets on new build (Wumpus-style full re-scrape)
  const findings = await analyzeAssets(build, {
    forceRefresh: isNewBuild,
    assetsDir: path.join(__dirname, '..', 'assets'),
  });

  console.log('Extracted:', {
    experiments: findings.experiments.length,
    strings: Object.keys(findings.strings).length,
    routes: Object.keys(findings.routes).length,
  });

  // First run: seed memory so we don't flood the channel
  if (!prev.initialized) {
    await bootstrapSeen(DATA, findings);
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: findings.experiments,
      strings: findings.strings,
      routes: findings.routes,
    });
    console.log('Bootstrapped state — no flood. Next real deltas will notify.');
    return;
  }

  const diff = computeDiff(prev, findings);
  console.log('Diff:', {
    newExp: diff.newExperiments.length,
    addedStr: Object.keys(diff.strings.added).length,
    removedStr: Object.keys(diff.strings.removed).length,
    modifiedStr: Object.keys(diff.strings.modified).length,
    addedRoutes: Object.keys(diff.routes.added).length,
    removedRoutes: Object.keys(diff.routes.removed).length,
  });

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
    experiments: findings.experiments,
    strings: { ...prev.strings, ...findings.strings },
    routes: { ...prev.routes, ...findings.routes },
  });

  console.log('=== Done ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
