/**
 * Canary scraper — Wumpus-style:
 * - experiments.json + strings.json = baseline (source of truth)
 * - notify ONLY ids/keys present in extract but absent from baseline
 * - always merge + save baseline after (never re-notify next run)
 * - if "new" count is absurd → silent merge (extract noise / catch-up)
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState } = require('./lib/state');
const { notifyAll } = require('./lib/notify');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');

// Above these thresholds = catch-up / noise → merge without webhook flood
const MAX_NOTIFY_EXP = 25;
const MAX_NOTIFY_STR = 80;

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Scraper (Wumpus baseline diff) ===');
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

  // Same build + solid baseline → skip
  if (!isNewBuild && prev.initialized && prev.experiments.length > 20) {
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
    console.error('Extract empty — abort (keep baseline)');
    process.exit(1);
  }

  // ── Baseline sets (source of truth) ───────────────────
  const prevExpIds = new Set(
    (prev.experiments || []).map((e) => String(e.id || e)),
  );
  const prevStrKeys = new Set(Object.keys(prev.strings || {}));

  // ── True diffs only ───────────────────────────────────
  let freshExps = (findings.experiments || []).filter(
    (e) => e && e.id && !prevExpIds.has(String(e.id)),
  );
  let freshStrings = {};
  for (const [k, v] of Object.entries(findings.strings || {})) {
    if (!prevStrKeys.has(k)) freshStrings[k] = v;
  }

  console.log('TRUE DIFF', {
    newExp: freshExps.length,
    newStr: Object.keys(freshStrings).length,
    sampleExp: freshExps.slice(0, 10).map((e) => e.id),
  });

  // First run / empty baseline → seed only, no flood
  const bootstrapping =
    !prev.initialized || prev.experiments.length < 5 || prevStrKeys.size < 50;

  if (bootstrapping) {
    console.log('BOOTSTRAP — save baseline, notify build card only');
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: mergeExp([], findings.experiments),
      strings: findings.strings || {},
      routes: findings.routes || {},
    });
    // remember announced build
    await markBuild(DATA, build.buildNumber);
    if (process.env.DISCORD_WEBHOOK_URL && isNewBuild) {
      await notifyAll({
        build,
        isNewBuild: true,
        freshExps: [],
        freshStrings: {},
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });
    }
    console.log('=== Done bootstrap', Date.now() - t0 + 'ms ===');
    return;
  }

  // Absurd catch-up → silent merge (prevents spam)
  let silent = false;
  if (freshExps.length > MAX_NOTIFY_EXP) {
    console.log(
      'SILENT merge experiments',
      freshExps.length,
      '(>' + MAX_NOTIFY_EXP + ')',
    );
    silent = true;
  }
  if (Object.keys(freshStrings).length > MAX_NOTIFY_STR) {
    console.log(
      'SILENT merge strings',
      Object.keys(freshStrings).length,
      '(>' + MAX_NOTIFY_STR + ')',
    );
    silent = true;
  }

  const alreadyBuild = await wasBuildAnnounced(DATA, build.buildNumber);
  const shouldAnnounceBuild = isNewBuild && !alreadyBuild;

  if (process.env.DISCORD_WEBHOOK_URL) {
    if (silent) {
      // build card only if new build, no exp/str spam
      if (shouldAnnounceBuild) {
        await notifyAll({
          build,
          isNewBuild: true,
          freshExps: [],
          freshStrings: {},
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        });
        await markBuild(DATA, build.buildNumber);
      }
    } else {
      await notifyAll({
        build,
        isNewBuild: shouldAnnounceBuild,
        freshExps,
        freshStrings,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });
      if (shouldAnnounceBuild) await markBuild(DATA, build.buildNumber);
    }
  } else {
    console.error('NO DISCORD_WEBHOOK_URL');
  }

  // ALWAYS union baseline — next run cannot re-see these as new
  const mergedExps = mergeExp(prev.experiments, findings.experiments);
  const mergedStrings = { ...(prev.strings || {}), ...(findings.strings || {}) };
  const mergedRoutes =
    Object.keys(findings.routes || {}).length > 5
      ? { ...(prev.routes || {}), ...(findings.routes || {}) }
      : prev.routes || {};

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergedExps,
    strings: mergedStrings,
    routes: mergedRoutes,
  });

  console.log('Saved baseline', {
    experiments: mergedExps.length,
    strings: Object.keys(mergedStrings).length,
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
