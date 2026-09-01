/**
 * Canary Pulse — experiments + strings + routes anti re-spam
 */
const fs = require('fs-extra');
const path = require('path');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, saveState } = require('./lib/state');
const { notifyAll } = require('./lib/notify');
const ALREADY_NOTIFIED = require('./lib/already_notified');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');
const KNOWN_EXP = path.join(DATA, 'known_experiment_ids.json');
const KNOWN_STR = path.join(DATA, 'known_string_keys.json');
const KNOWN_RT = path.join(DATA, 'known_route_keys.json');
const ANNOUNCED = path.join(DATA, 'announced_builds.json');

const MAX_NOTIFY_EXP = 20;
const MAX_NOTIFY_STR = 60;
const MAX_NOTIFY_RT = 30;
const MIN_STRINGS_FOR_DIFF = 500;
const MIN_ROUTES_FOR_DIFF = 50;

async function loadKnownExp() {
  const set = new Set();
  for (const id of ALREADY_NOTIFIED) set.add(String(id));
  try {
    if (await fs.pathExists(KNOWN_EXP)) {
      const d = await fs.readJson(KNOWN_EXP);
      for (const id of d.ids || []) set.add(String(id));
    }
  } catch {}
  return set;
}

async function saveKnownExp(set) {
  const ids = [...set]
    .filter((id) => id && !String(id).startsWith('hash:'))
    .sort();
  await fs.writeJson(
    KNOWN_EXP,
    { updatedAt: new Date().toISOString(), count: ids.length, ids },
    { spaces: 2 },
  );
}

async function loadKnownStr() {
  const set = new Set();
  try {
    if (await fs.pathExists(KNOWN_STR)) {
      const d = await fs.readJson(KNOWN_STR);
      for (const k of d.keys || d.ids || []) set.add(String(k));
    }
  } catch {}
  return set;
}

async function saveKnownStr(set) {
  const keys = [...set].sort().slice(-50000);
  await fs.writeJson(
    KNOWN_STR,
    { updatedAt: new Date().toISOString(), count: keys.length, keys },
    { spaces: 2 },
  );
}

async function loadKnownRt() {
  const set = new Set();
  try {
    if (await fs.pathExists(KNOWN_RT)) {
      const d = await fs.readJson(KNOWN_RT);
      for (const k of d.keys || d.ids || []) set.add(String(k));
    }
  } catch {}
  return set;
}

async function saveKnownRt(set) {
  const keys = [...set].sort().slice(-10000);
  await fs.writeJson(
    KNOWN_RT,
    { updatedAt: new Date().toISOString(), count: keys.length, keys },
    { spaces: 2 },
  );
}

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Pulse v7b (routes guard) ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  const prev = await loadState(DATA);
  const knownExp = await loadKnownExp();
  const knownStr = await loadKnownStr();
  const knownRt = await loadKnownRt();

  for (const e of prev.experiments || []) {
    if (e && e.id) knownExp.add(String(e.id));
  }
  for (const k of Object.keys(prev.strings || {})) knownStr.add(k);
  for (const k of Object.keys(prev.routes || {})) knownRt.add(k);

  console.log('Known sets', {
    exp: knownExp.size,
    str: knownStr.size,
    rt: knownRt.size,
  });

  const build = await fetchBuild();
  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prev.build && prev.build.buildNumber,
      knownExp: knownExp.size,
      knownStr: knownStr.size,
      knownRt: knownRt.size,
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

  if (!isNewBuild && prev.initialized && knownExp.size > 50) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  console.log('FULL SCRAPE isNewBuild=' + isNewBuild);
  const findings = await analyzeAssets(build, {
    forceRefresh: isNewBuild,
    assetsDir: ASSETS,
  });

  const extractedStrCount = Object.keys(findings.strings || {}).length;
  const extractedRtCount = Object.keys(findings.routes || {}).length;

  console.log(
    'EXTRACT',
    JSON.stringify({
      experiments: findings.experiments.length,
      strings: extractedStrCount,
      routes: extractedRtCount,
    }),
  );

  if (findings.experiments.length < 3 && extractedStrCount < 10) {
    console.error('Extract empty — abort');
    process.exit(1);
  }

  let freshExps = (findings.experiments || []).filter((e) => {
    if (!e || !e.id) return false;
    const id = String(e.id);
    if (id.startsWith('hash:')) return false;
    return !knownExp.has(id);
  });

  let freshStrings = {};
  if (extractedStrCount < MIN_STRINGS_FOR_DIFF) {
    console.log(
      'Strings weak (' + extractedStrCount + ') — skip string notify',
    );
    for (const k of Object.keys(findings.strings || {})) knownStr.add(k);
  } else {
    for (const [k, v] of Object.entries(findings.strings || {})) {
      if (knownStr.has(k)) continue;
      if (k in (prev.strings || {})) continue;
      freshStrings[k] = v;
    }
  }

  // Routes: only notify if extract is solid
  let freshRoutes = {};
  if (extractedRtCount < MIN_ROUTES_FOR_DIFF) {
    console.log(
      'Routes weak (' + extractedRtCount + ' < ' + MIN_ROUTES_FOR_DIFF + ') — skip route notify, keep baseline',
    );
    for (const k of Object.keys(findings.routes || {})) knownRt.add(k);
  } else {
    for (const [k, v] of Object.entries(findings.routes || {})) {
      if (knownRt.has(k)) continue;
      if (k in (prev.routes || {})) continue;
      freshRoutes[k] = v;
    }
  }

  console.log('TRUE DIFF', {
    newExp: freshExps.length,
    newStr: Object.keys(freshStrings).length,
    newRt: Object.keys(freshRoutes).length,
    sampleExp: freshExps.slice(0, 8).map((e) => e.id),
    sampleRt: Object.keys(freshRoutes).slice(0, 5),
  });

  for (const e of findings.experiments || []) {
    if (e && e.id) knownExp.add(String(e.id));
  }
  for (const k of Object.keys(findings.strings || {})) knownStr.add(k);
  for (const k of Object.keys(findings.routes || {})) knownRt.add(k);
  await saveKnownExp(knownExp);
  await saveKnownStr(knownStr);
  await saveKnownRt(knownRt);

  const bootstrapping =
    !prev.initialized || (prev.experiments || []).length < 5;

  if (bootstrapping) {
    console.log('BOOTSTRAP');
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: mergeExp([], findings.experiments),
      strings: {
        ...(prev.strings || {}),
        ...(extractedStrCount >= MIN_STRINGS_FOR_DIFF ? findings.strings : {}),
      },
      routes: {
        ...(prev.routes || {}),
        ...(extractedRtCount >= MIN_ROUTES_FOR_DIFF ? findings.routes : {}),
      },
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

  if (
    freshExps.length > MAX_NOTIFY_EXP ||
    Object.keys(freshStrings).length > MAX_NOTIFY_STR
  ) {
    console.log('SILENT', {
      exp: freshExps.length,
      str: Object.keys(freshStrings).length,
    });
    freshExps = [];
    freshStrings = {};
    freshRoutes = {};
  }
  if (Object.keys(freshRoutes).length > MAX_NOTIFY_RT) freshRoutes = {};

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
  }

  const mergedStrings =
    extractedStrCount >= MIN_STRINGS_FOR_DIFF
      ? { ...(prev.strings || {}), ...(findings.strings || {}) }
      : prev.strings || {};

  const mergedRoutes =
    extractedRtCount >= MIN_ROUTES_FOR_DIFF
      ? { ...(prev.routes || {}), ...(findings.routes || {}) }
      : prev.routes || {};

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergeExp(prev.experiments, findings.experiments),
    strings: mergedStrings,
    routes: mergedRoutes,
  });

  console.log('Saved knownExp', knownExp.size, 'rt', knownRt.size);
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
