/**
 * Canary Pulse scraper
 * Baseline = experiments.json + strings.json + routes.json
 * Notify only true diffs; never re-send known items.
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState } = require('./lib/state');
const { notifyAll } = require('./lib/notify');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');

const MAX_NOTIFY_EXP = 25;
const MAX_NOTIFY_STR = 80;
const MAX_NOTIFY_RT = 40;

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Pulse ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  const prev = await loadState(DATA);
  const build = await fetchBuild();

  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prev.build && prev.build.buildNumber,
      baselineExp: (prev.experiments || []).length,
      baselineStr: Object.keys(prev.strings || {}).length,
      baselineRt: Object.keys(prev.routes || {}).length,
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

  if (!isNewBuild && prev.initialized && (prev.experiments || []).length > 20) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  console.log('FULL SCRAPE isNewBuild=' + isNewBuild);
  const findings = await analyzeAssets(build, {
    forceRefresh: isNewBuild,
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
    findings.experiments.length < 3 &&
    Object.keys(findings.strings).length < 10
  ) {
    console.error('Extract empty — abort');
    process.exit(1);
  }

  const prevExpIds = new Set(
    (prev.experiments || []).map((e) => String(e.id || e)),
  );
  const prevStrKeys = new Set(Object.keys(prev.strings || {}));
  const prevRtKeys = new Set(Object.keys(prev.routes || {}));

  let freshExps = (findings.experiments || []).filter(
    (e) => e && e.id && !prevExpIds.has(String(e.id)),
  );
  let freshStrings = {};
  for (const [k, v] of Object.entries(findings.strings || {})) {
    if (!prevStrKeys.has(k)) freshStrings[k] = v;
  }
  let freshRoutes = {};
  for (const [k, v] of Object.entries(findings.routes || {})) {
    if (!prevRtKeys.has(k)) freshRoutes[k] = v;
  }

  console.log('TRUE DIFF', {
    newExp: freshExps.length,
    newStr: Object.keys(freshStrings).length,
    newRt: Object.keys(freshRoutes).length,
    sampleExp: freshExps.slice(0, 8).map((e) => e.id),
  });

  const bootstrapping =
    !prev.initialized ||
    (prev.experiments || []).length < 5 ||
    prevStrKeys.size < 50;

  if (bootstrapping) {
    console.log('BOOTSTRAP — baseline only');
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: mergeExp([], findings.experiments),
      strings: findings.strings || {},
      routes: findings.routes || {},
    });
    await markBuild(DATA, build.buildNumber);
    if (process.env.DISCORD_WEBHOOK_URL && isNewBuild) {
      await notifyAll({
        build,
        isNewBuild: true,
        freshExps: [],
        freshStrings: {},
        freshRoutes: {},
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });
    }
    console.log('=== Done bootstrap', Date.now() - t0 + 'ms ===');
    return;
  }

  let silent = false;
  if (freshExps.length > MAX_NOTIFY_EXP) {
    console.log('SILENT exp', freshExps.length);
    silent = true;
  }
  if (Object.keys(freshStrings).length > MAX_NOTIFY_STR) {
    console.log('SILENT str', Object.keys(freshStrings).length);
    silent = true;
  }
  if (Object.keys(freshRoutes).length > MAX_NOTIFY_RT) {
    console.log('SILENT routes', Object.keys(freshRoutes).length);
    // routes alone don't force full silent for exp/str
  }

  const alreadyBuild = await wasBuildAnnounced(DATA, build.buildNumber);
  const shouldAnnounceBuild = isNewBuild && !alreadyBuild;

  if (process.env.DISCORD_WEBHOOK_URL) {
    if (silent) {
      if (shouldAnnounceBuild) {
        await notifyAll({
          build,
          isNewBuild: true,
          freshExps: [],
          freshStrings: {},
          freshRoutes: {},
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        });
        await markBuild(DATA, build.buildNumber);
      }
    } else {
      const rt =
        Object.keys(freshRoutes).length > MAX_NOTIFY_RT ? {} : freshRoutes;
      await notifyAll({
        build,
        isNewBuild: shouldAnnounceBuild,
        freshExps,
        freshStrings,
        freshRoutes: rt,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });
      if (shouldAnnounceBuild) await markBuild(DATA, build.buildNumber);
    }
  } else {
    console.error('NO DISCORD_WEBHOOK_URL');
  }

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergeExp(prev.experiments, findings.experiments),
    strings: { ...(prev.strings || {}), ...(findings.strings || {}) },
    routes:
      Object.keys(findings.routes || {}).length > 5
        ? { ...(prev.routes || {}), ...(findings.routes || {}) }
        : prev.routes || {},
  });

  console.log('=== Done', Date.now() - t0 + 'ms ===');
}

function mergeExp(prev, next) {
  const map = new Map();
  for (const e of prev || []) {
    const id = e && (e.id || e);
    if (id) map.set(String(id), typeof e === 'object' ? e : { id: String(e) });
  }
  for (const e of next || []) {
    if (e && e.id) map.set(String(e.id), e);
  }
  return [...map.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
}

async function markBuild(dataDir, buildNumber) {
  const p = path.join(dataDir, 'announced_builds.json');
  let data = { builds: [] };
  try {
    if (await fs.pathExists(p)) data = await fs.readJson(p);
  } catch {}
  const set = new Set((data.builds || []).map(String));
  set.add(String(buildNumber));
  await fs.writeJson(
    p,
    { builds: [...set].slice(-200), updatedAt: new Date().toISOString() },
    { spaces: 2 },
  );
}

async function wasBuildAnnounced(dataDir, buildNumber) {
  const p = path.join(dataDir, 'announced_builds.json');
  try {
    if (!(await fs.pathExists(p))) return false;
    const data = await fs.readJson(p);
    return (data.builds || []).map(String).includes(String(buildNumber));
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
