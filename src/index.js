/**
 * Canary Pulse — diffs added / modified / removed
 * Strings: compare current extract vs last extract (build-to-build)
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
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
const LAST_EXTRACT_STR = path.join(DATA, 'last_extract_strings.json');
const LAST_EXTRACT_RT = path.join(DATA, 'last_extract_routes.json');
const ANNOUNCED = path.join(DATA, 'announced_builds.json');

const WUMPUS_STRINGS_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/strings.json';

const MAX_NOTIFY_EXP = 25;
const MAX_NOTIFY_STR = 80;
const MAX_NOTIFY_RT = 40;
const MIN_STRINGS_FOR_DIFF = 200; // extract-to-extract, not full catalog
const MIN_ROUTES_FOR_DIFF = 50;
const MIN_EXP_COVERAGE = 0.35;

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

async function loadLastExtract(file) {
  try {
    if (await fs.pathExists(file)) {
      const d = await fs.readJson(file);
      if (d && d.map && typeof d.map === 'object') return d.map;
      if (d && typeof d === 'object' && !Array.isArray(d) && !d.map) {
        // plain map
        const { buildNumber, updatedAt, count, ...rest } = d;
        if (Object.keys(rest).length) return rest;
      }
    }
  } catch {}
  return {};
}

async function saveLastExtract(file, map, buildNumber) {
  await fs.writeJson(
    file,
    {
      buildNumber: buildNumber || null,
      updatedAt: new Date().toISOString(),
      count: Object.keys(map || {}).length,
      map: map || {},
    },
    { spaces: 2 },
  );
}

function expFingerprint(e) {
  if (!e || typeof e !== 'object') return null;
  const parts = [];
  if (e.label) parts.push('label:' + String(e.label));
  if (Array.isArray(e.treatments) && e.treatments.length) {
    parts.push('tx:' + e.treatments.length);
    for (const t of e.treatments.slice(0, 8)) {
      parts.push(String(t && (t.id || t.label || t)));
    }
  }
  if (e.hash) parts.push('hash:' + String(e.hash));
  if (!parts.length) return null;
  return parts.join('|');
}

/** Try enrich extract with Wumpus catalog (optional, never blocks) */
async function maybeFetchWumpusStrings() {
  try {
    const res = await fetch(WUMPUS_STRINGS_URL, {
      headers: { 'User-Agent': 'canary-pulse', Accept: 'application/json' },
      timeout: 45000,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (e) {
    console.warn('wumpus strings', e.message);
    return null;
  }
}

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Pulse v8.2 (string extract-to-extract) ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);

  const prev = await loadState(DATA);
  const knownExp = await loadKnownExp();
  const knownStr = await loadKnownStr();
  const knownRt = await loadKnownRt();
  const lastStr = await loadLastExtract(LAST_EXTRACT_STR);
  const lastRt = await loadLastExtract(LAST_EXTRACT_RT);

  for (const e of prev.experiments || []) {
    if (e && e.id) knownExp.add(String(e.id));
  }
  for (const k of Object.keys(prev.strings || {})) knownStr.add(k);
  for (const k of Object.keys(lastStr)) knownStr.add(k);
  for (const k of Object.keys(prev.routes || {})) knownRt.add(k);
  for (const k of Object.keys(lastRt)) knownRt.add(k);

  console.log('Known sets', {
    exp: knownExp.size,
    str: knownStr.size,
    rt: knownRt.size,
    lastExtractStr: Object.keys(lastStr).length,
    lastExtractRt: Object.keys(lastRt).length,
  });

  const build = await fetchBuild();
  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prev.build && prev.build.buildNumber,
      knownExp: knownExp.size,
      baselineExp: (prev.experiments || []).length,
      baselineStr: Object.keys(prev.strings || {}).length,
      lastStr: Object.keys(lastStr).length,
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

  let extractedStrings = { ...(findings.strings || {}) };
  let extractedStrCount = Object.keys(extractedStrings).length;
  const extractedRtCount = Object.keys(findings.routes || {}).length;
  const extractedExpCount = (findings.experiments || []).length;

  // Enrich with Wumpus if our extract is thin (catalog reference)
  if (extractedStrCount < 5000) {
    const wumpus = await maybeFetchWumpusStrings();
    if (wumpus) {
      let added = 0;
      for (const [k, v] of Object.entries(wumpus)) {
        if (typeof k === 'string' && k.length === 6 && !(k in extractedStrings)) {
          if (typeof v === 'string') {
            extractedStrings[k] = v;
            added++;
          }
        }
      }
      extractedStrCount = Object.keys(extractedStrings).length;
      console.log('Wumpus strings merge +', added, 'total', extractedStrCount);
    }
  }

  console.log(
    'EXTRACT',
    JSON.stringify({
      experiments: extractedExpCount,
      strings: extractedStrCount,
      routes: extractedRtCount,
    }),
  );

  if (extractedExpCount < 3 && extractedStrCount < 10) {
    console.error('Extract empty — abort');
    process.exit(1);
  }

  // ── Experiments ───────────────────────────────────────
  const prevExpMap = new Map();
  for (const e of prev.experiments || []) {
    if (e && e.id) prevExpMap.set(String(e.id), e);
  }
  const nextExpMap = new Map();
  for (const e of findings.experiments || []) {
    if (e && e.id && !String(e.id).startsWith('hash:'))
      nextExpMap.set(String(e.id), e);
  }

  const expDiff = { added: [], modified: [], removed: [] };

  for (const [id, e] of nextExpMap) {
    if (!prevExpMap.has(id) && !knownExp.has(id)) {
      expDiff.added.push(e);
    } else if (prevExpMap.has(id)) {
      const prevFp = expFingerprint(prevExpMap.get(id));
      const nextFp = expFingerprint(e);
      if (prevFp && nextFp && prevFp !== nextFp) {
        expDiff.modified.push(e);
      }
    }
  }

  const coverage =
    (prev.experiments || []).length > 0
      ? extractedExpCount / (prev.experiments || []).length
      : 0;
  if (coverage >= MIN_EXP_COVERAGE && (prev.experiments || []).length > 20) {
    for (const [id] of prevExpMap) {
      if (!nextExpMap.has(id)) expDiff.removed.push({ id });
    }
    if (expDiff.removed.length > 40) {
      console.log('Too many exp removals — skip');
      expDiff.removed = [];
    }
  } else {
    console.log('Exp coverage ' + coverage.toFixed(2) + ' — skip removals');
  }

  // ── Strings: EXTRACT vs LAST EXTRACT (build-to-build) ─
  const strDiff = { added: {}, modified: {}, removed: {} };
  const lastStrCount = Object.keys(lastStr).length;

  if (extractedStrCount < MIN_STRINGS_FOR_DIFF) {
    console.log('Strings weak — skip string diffs');
  } else if (lastStrCount < 50) {
    // First solid extract: seed last_extract, no flood
    console.log(
      'Strings seed last_extract (' +
        extractedStrCount +
        ') — no notify this run',
    );
  } else {
    // Added / modified vs previous extract
    for (const [k, v] of Object.entries(extractedStrings)) {
      if (!(k in lastStr)) {
        if (!knownStr.has(k)) strDiff.added[k] = v;
      } else if (String(lastStr[k]) !== String(v)) {
        strDiff.modified[k] = v;
      }
    }
    // Removed: only if both extracts similar size (avoid false mass delete)
    const ratio =
      lastStrCount > 0 ? extractedStrCount / lastStrCount : 0;
    if (ratio >= 0.6 && ratio <= 1.5) {
      for (const [k, v] of Object.entries(lastStr)) {
        if (!(k in extractedStrings)) strDiff.removed[k] = v;
      }
      if (Object.keys(strDiff.removed).length > 150) {
        console.log('Too many str removals — skip');
        strDiff.removed = {};
      }
    } else {
      console.log(
        'String extract size shift (' +
          lastStrCount +
          ' → ' +
          extractedStrCount +
          ') — skip removals',
      );
    }

    // Cap noise
    if (Object.keys(strDiff.added).length > MAX_NOTIFY_STR) {
      console.log(
        'Too many new strings (' +
          Object.keys(strDiff.added).length +
          ') — silent add',
      );
      strDiff.added = {};
    }
    if (Object.keys(strDiff.modified).length > MAX_NOTIFY_STR) {
      strDiff.modified = {};
    }
  }

  // ── Routes: extract vs last extract ───────────────────
  const rtDiff = { added: {}, modified: {}, removed: {} };
  const lastRtCount = Object.keys(lastRt).length;
  const nextRt = findings.routes || {};

  if (extractedRtCount < MIN_ROUTES_FOR_DIFF) {
    console.log('Routes weak — skip route diffs');
  } else if (lastRtCount < 20) {
    console.log('Routes seed last_extract — no notify');
  } else {
    for (const [k, v] of Object.entries(nextRt)) {
      if (!(k in lastRt)) {
        if (!knownRt.has(k)) rtDiff.added[k] = v;
      } else if (String(lastRt[k]) !== String(v)) {
        rtDiff.modified[k] = v;
      }
    }
    const ratio = lastRtCount > 0 ? extractedRtCount / lastRtCount : 0;
    if (ratio >= 0.6 && ratio <= 1.5) {
      for (const [k, v] of Object.entries(lastRt)) {
        if (!(k in nextRt)) rtDiff.removed[k] = v;
      }
      if (Object.keys(rtDiff.removed).length > 50) rtDiff.removed = {};
    }
    if (Object.keys(rtDiff.added).length > MAX_NOTIFY_RT) {
      rtDiff.added = {};
      rtDiff.modified = {};
      rtDiff.removed = {};
    }
  }

  if (expDiff.modified.length > 30) {
    console.log('Discard mass exp modified (' + expDiff.modified.length + ')');
    expDiff.modified = [];
  }

  console.log('TRUE DIFF', {
    exp: {
      added: expDiff.added.length,
      modified: expDiff.modified.length,
      removed: expDiff.removed.length,
    },
    str: {
      added: Object.keys(strDiff.added).length,
      modified: Object.keys(strDiff.modified).length,
      removed: Object.keys(strDiff.removed).length,
    },
    rt: {
      added: Object.keys(rtDiff.added).length,
      modified: Object.keys(rtDiff.modified).length,
      removed: Object.keys(rtDiff.removed).length,
    },
  });

  // Mark known + save last extract BEFORE notify
  for (const e of findings.experiments || []) {
    if (e && e.id) knownExp.add(String(e.id));
  }
  for (const e of expDiff.added) knownExp.add(String(e.id || e));
  for (const k of Object.keys(extractedStrings)) knownStr.add(k);
  for (const k of Object.keys(strDiff.added)) knownStr.add(k);
  for (const k of Object.keys(nextRt)) knownRt.add(k);
  for (const k of Object.keys(rtDiff.added)) knownRt.add(k);

  await saveKnownExp(knownExp);
  await saveKnownStr(knownStr);
  await saveKnownRt(knownRt);
  await saveLastExtract(LAST_EXTRACT_STR, extractedStrings, build.buildNumber);
  await saveLastExtract(LAST_EXTRACT_RT, nextRt, build.buildNumber);

  const bootstrapping =
    !prev.initialized || (prev.experiments || []).length < 5;

  if (bootstrapping) {
    console.log('BOOTSTRAP');
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: mergeExp([], findings.experiments),
      strings: { ...(prev.strings || {}), ...extractedStrings },
      routes: { ...(prev.routes || {}), ...nextRt },
    });
    await markBuild(build.buildNumber);
    if (process.env.DISCORD_WEBHOOK_URL && isNewBuild) {
      await notifyAll({
        build,
        isNewBuild: true,
        expDiff: { added: [], modified: [], removed: [] },
        strDiff: { added: {}, modified: {}, removed: {} },
        rtDiff: { added: {}, modified: {}, removed: {} },
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });
    }
    console.log('=== Done bootstrap', Date.now() - t0 + 'ms ===');
    return;
  }

  if (expDiff.added.length > MAX_NOTIFY_EXP) {
    console.log('SILENT exp catch-up');
    expDiff.added = [];
    expDiff.modified = [];
    expDiff.removed = [];
  }

  const alreadyBuild = await wasBuildAnnounced(build.buildNumber);
  const shouldAnnounceBuild = isNewBuild && !alreadyBuild;

  if (process.env.DISCORD_WEBHOOK_URL) {
    await notifyAll({
      build,
      isNewBuild: shouldAnnounceBuild,
      expDiff,
      strDiff,
      rtDiff,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    });
    if (shouldAnnounceBuild) await markBuild(build.buildNumber);
  }

  let mergedExps = mergeExp(prev.experiments, findings.experiments);
  if (expDiff.removed.length) {
    const drop = new Set(expDiff.removed.map((e) => String(e.id || e)));
    mergedExps = mergedExps.filter((e) => !drop.has(String(e.id)));
  }

  const mergedStrings = { ...(prev.strings || {}), ...extractedStrings };
  for (const k of Object.keys(strDiff.removed)) delete mergedStrings[k];

  const mergedRoutes = { ...(prev.routes || {}), ...nextRt };
  for (const k of Object.keys(rtDiff.removed)) delete mergedRoutes[k];

  await saveState(DATA, {
    initialized: true,
    build,
    experiments: mergedExps,
    strings: mergedStrings,
    routes: mergedRoutes,
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
