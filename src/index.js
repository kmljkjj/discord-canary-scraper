/**
 * Canary Pulse — anti re-spam
 * known_experiment_ids.json = liste PERMANENTE (jamais re-notifier)
 * Commitée à chaque run → plus de flood à chaque build
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState } = require('./lib/state');
const { notifyAll } = require('./lib/notify');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');
const KNOWN_EXP = path.join(DATA, 'known_experiment_ids.json');
const KNOWN_STR = path.join(DATA, 'known_string_keys.json');
const ANNOUNCED = path.join(DATA, 'announced_builds.json');

const MAX_NOTIFY_EXP = 20;
const MAX_NOTIFY_STR = 60;
const MAX_NOTIFY_RT = 30;

async function loadKnownExp() {
  try {
    if (await fs.pathExists(KNOWN_EXP)) {
      const d = await fs.readJson(KNOWN_EXP);
      return new Set((d.ids || []).map(String));
    }
  } catch {}
  return new Set();
}

async function saveKnownExp(set) {
  const ids = [...set].filter((id) => id && !String(id).startsWith('hash:')).sort();
  await fs.writeJson(
    KNOWN_EXP,
    {
      updatedAt: new Date().toISOString(),
      count: ids.length,
      ids,
    },
    { spaces: 2 },
  );
}

async function loadKnownStr() {
  try {
    if (await fs.pathExists(KNOWN_STR)) {
      const d = await fs.readJson(KNOWN_STR);
      return new Set((d.keys || d.ids || []).map(String));
    }
  } catch {}
  return new Set();
}

async function saveKnownStr(set) {
  // Cap to keep git diffs reasonable
  const keys = [...set].sort().slice(-40000);
  await fs.writeJson(
    KNOWN_STR,
    {
      updatedAt: new Date().toISOString(),
      count: keys.length,
      keys,
    },
    { spaces: 2 },
  );
}

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Pulse v6 (permanent known ids) ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  const prev = await loadState(DATA);
  const knownExp = await loadKnownExp();
  const knownStr = await loadKnownStr();

  // Seed known from baseline if empty
  if (knownExp.size < 10) {
    for (const e of prev.experiments || []) {
      if (e && e.id) knownExp.add(String(e.id));
    }
    if (knownExp.size) {
      await saveKnownExp(knownExp);
      console.log('Seeded knownExp from baseline:', knownExp.size);
    }
  }
  if (knownStr.size < 50) {
    for (const k of Object.keys(prev.strings || {})) knownStr.add(k);
    if (knownStr.size) {
      await saveKnownStr(knownStr);
      console.log('Seeded knownStr from baseline:', knownStr.size);
    }
  }

  const build = await fetchBuild();
  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prev.build && prev.build.buildNumber,
      knownExp: knownExp.size,
      knownStr: knownStr.size,
      baselineExp: (prev.experiments || []).length,
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

  if (!isNewBuild && prev.initialized && knownExp.size > 20) {
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

  // True new = not in PERMANENT known set AND not in baseline
  const prevExpIds = new Set(
    (prev.experiments || []).map((e) => String(e.id || e)),
  );
  for (const id of prevExpIds) knownExp.add(id);

  let freshExps = (findings.experiments || []).filter((e) => {
    if (!e || !e.id) return false;
    const id = String(e.id);
    if (id.startsWith('hash:')) return false;
    if (knownExp.has(id)) return false;
    if (prevExpIds.has(id)) return false;
    return true;
  });

  let freshStrings = {};
  for (const [k, v] of Object.entries(findings.strings || {})) {
    if (knownStr.has(k)) continue;
    if (k in (prev.strings || {})) continue;
    freshStrings[k] = v;
  }

  const prevRt = prev.routes || {};
  let freshRoutes = {};
  for (const [k, v] of Object.entries(findings.routes || {})) {
    if (!(k in prevRt)) freshRoutes[k] = v;
  }

  console.log('TRUE DIFF', {
    newExp: freshExps.length,
    newStr: Object.keys(freshStrings).length,
    newRt: Object.keys(freshRoutes).length,
    sampleExp: freshExps.slice(0, 10).map((e) => e.id),
  });

  const bootstrapping =
    !prev.initialized || knownExp.size < 10 || (prev.experiments || []).length < 5;

  if (bootstrapping) {
    console.log('BOOTSTRAP — mark everything known, no flood');
    for (const e of findings.experiments || []) {
      if (e && e.id) knownExp.add(String(e.id));
    }
    for (const k of Object.keys(findings.strings || {})) knownStr.add(k);
    await saveKnownExp(knownExp);
    await saveKnownStr(knownStr);
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: mergeExp(prev.experiments, findings.experiments),
      strings: { ...(prev.strings || {}), ...(findings.strings || {}) },
      routes: { ...(prev.routes || {}), ...(findings.routes || {}) },
    });
    await markBuild(build.buildNumber);
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

  // Mark ALL extracted IDs known BEFORE notify (even if we silent)
  // so a failed webhook never causes re-spam next run
  for (const e of findings.experiments || []) {
    if (e && e.id) knownExp.add(String(e.id));
  }
  for (const e of freshExps) knownExp.add(String(e.id));
  for (const k of Object.keys(findings.strings || {})) knownStr.add(k);
  await saveKnownExp(knownExp);
  await saveKnownStr(knownStr);

  let silent =
    freshExps.length > MAX_NOTIFY_EXP ||
    Object.keys(freshStrings).length > MAX_NOTIFY_STR;

  if (silent) {
    console.log('SILENT merge (catch-up / noise)', {
      exp: freshExps.length,
      str: Object.keys(freshStrings).length,
    });
    freshExps = [];
    freshStrings = {};
    freshRoutes = {};
  }

  if (Object.keys(freshRoutes).length > MAX_NOTIFY_RT) {
    freshRoutes = {};
  }

  const alreadyBuild = await wasBuildAnnounced(build.buildNumber);
  const shouldAnnounceBuild = isNewBuild && !alreadyBuild;

  if (process.env.DISCORD_WEBHOOK_URL) {
    await notifyAll({
      build,
      isNewBuild: shouldAnnounceBuild,
      freshExps,
      freshStrings,
      freshRoutes,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    });
    if (shouldAnnounceBuild) await markBuild(build.buildNumber);
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

  console.log('Saved knownExp', knownExp.size, 'knownStr', knownStr.size);
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

async function markBuild(buildNumber) {
  let data = { builds: [] };
  try {
    if (await fs.pathExists(ANNOUNCED)) data = await fs.readJson(ANNOUNCED);
  } catch {}
  const set = new Set((data.builds || []).map(String));
  set.add(String(buildNumber));
  await fs.writeJson(
    ANNOUNCED,
    { builds: [...set].slice(-300), updatedAt: new Date().toISOString() },
    { spaces: 2 },
  );
}

async function wasBuildAnnounced(buildNumber) {
  try {
    if (!(await fs.pathExists(ANNOUNCED))) return false;
    const data = await fs.readJson(ANNOUNCED);
    return (data.builds || []).map(String).includes(String(buildNumber));
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
