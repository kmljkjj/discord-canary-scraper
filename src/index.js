/**
 * Canary Pulse v10.1 — flash + Discord-only + stable diffs
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
const CACHE = path.join(DATA, 'cache');
const KNOWN_EXP = path.join(DATA, 'known_experiment_ids.json');
const KNOWN_STR = path.join(DATA, 'known_string_keys.json');
const KNOWN_RT = path.join(DATA, 'known_route_keys.json');
const LAST_EXTRACT_STR = path.join(DATA, 'last_extract_strings.json');
const LAST_EXTRACT_RT = path.join(DATA, 'last_extract_routes.json');
const ANNOUNCED = path.join(DATA, 'announced_builds.json');

const MAX_NOTIFY_EXP = 25;
const MAX_NOTIFY_STR = 80;
const MAX_NOTIFY_RT = 40;
const MIN_STRINGS_FOR_DIFF = 200;
const MIN_ROUTES_FOR_DIFF = 50;
const MIN_EXP_COVERAGE = 0.5;

const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

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
    if (!(await fs.pathExists(file))) return {};
    const d = await fs.readJson(file);
    const raw =
      d.data && typeof d.data === 'object'
        ? d.data
        : d.strings || d.routes || d || {};
    // Ne garder que des paires utiles (évite pollution metadata)
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'buildNumber' || k === 'updatedAt' || k === 'count' || k === 'data')
        continue;
      if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
    }
    return out;
  } catch (e) {
    console.warn('loadLastExtract fail', e.message);
    return {};
  }
}

async function saveLastExtract(file, data, buildNumber) {
  // compact JSON — moins de RAM sur le runner
  await fs.writeJson(file, {
    buildNumber: String(buildNumber),
    updatedAt: new Date().toISOString(),
    count: Object.keys(data || {}).length,
    data,
  });
}

/** Fingerprint stable: type + nb variations (0 si absent) */
function expFingerprint(e) {
  if (!e || typeof e !== 'object') return '';
  const type = e.type === 'guild' || e.kind === 'guild' ? 'guild' : 'user';
  let n = 0;
  if (typeof e.variationCount === 'number') n = e.variationCount;
  else if (e.variations && typeof e.variations === 'object')
    n = Object.keys(e.variations).length;
  else if (Array.isArray(e.treatments)) n = e.treatments.length;
  return type + '|' + n;
}

async function flashBuild(webhookUrl, build) {
  const bn = String(build.buildNumber || '?');
  const hash = build.versionHash ? String(build.versionHash).slice(0, 12) : null;
  const body = {
    username: BOT,
    avatar_url: AVATAR,
    embeds: [
      {
        author: { name: 'Datamining', icon_url: AVATAR },
        title: 'New Discord Canary Build · ' + bn,
        description:
          (hash ? 'Hash `' + hash + '`\n' : '') +
          '_Extracting experiments, strings & routes…_',
        color: 0x5865f2,
        footer: { text: 'Build ' + bn + ' · Datamining · flash' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      'flash HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120),
    );
}

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Pulse v10.1 ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);
  await fs.ensureDir(CACHE);

  const [prev, knownExp, knownStr, knownRt, lastStr, lastRt] =
    await Promise.all([
      loadState(DATA),
      loadKnownExp(),
      loadKnownStr(),
      loadKnownRt(),
      loadLastExtract(LAST_EXTRACT_STR),
      loadLastExtract(LAST_EXTRACT_RT),
    ]);

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

  let build;
  try {
    build = await fetchBuild();
  } catch (e) {
    console.error('fetchBuild failed', e.message);
    process.exit(1);
  }

  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prev.build && prev.build.buildNumber,
      knownExp: knownExp.size,
      lastStr: Object.keys(lastStr).length,
      t_html: Date.now() - t0 + 'ms',
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

  const needsExtractSeed =
    Object.keys(lastStr).length < 50 || Object.keys(lastRt).length < 20;

  if (
    !isNewBuild &&
    prev.initialized &&
    knownExp.size > 50 &&
    !needsExtractSeed
  ) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  if (needsExtractSeed && !isNewBuild) {
    console.log('SEED RUN — fill last_extract, no flood');
  }

  let flashSent = false;
  if (isNewBuild && process.env.DISCORD_WEBHOOK_URL) {
    const already = await wasBuildAnnounced(build.buildNumber);
    if (!already) {
      try {
        await flashBuild(process.env.DISCORD_WEBHOOK_URL, build);
        flashSent = true;
        await markBuild(build.buildNumber);
        console.log('FLASH build', build.buildNumber, Date.now() - t0 + 'ms');
      } catch (e) {
        console.warn('FLASH failed', e.message);
      }
    }
  }

  console.log(
    'FULL SCRAPE isNewBuild=' + isNewBuild,
    'seed=' + needsExtractSeed,
  );

  let findings;
  try {
    findings = await analyzeAssets(build, {
      forceRefresh: isNewBuild || needsExtractSeed,
      assetsDir: ASSETS,
      cacheDir: CACHE,
    });
  } catch (e) {
    console.error('analyzeAssets failed', e);
    // Ne pas planter le job si FLASH déjà parti — commit partial state build only
    try {
      await saveState(DATA, {
        initialized: prev.initialized || true,
        build,
        experiments: prev.experiments || [],
        strings: prev.strings || {},
        routes: prev.routes || {},
      });
    } catch {}
    process.exit(1);
  }
  console.log('Extract done', Date.now() - t0 + 'ms');

  const extractedStrings = { ...(findings.strings || {}) };
  const extractedStrCount = Object.keys(extractedStrings).length;
  const extractedRtCount = Object.keys(findings.routes || {}).length;
  const extractedExpCount = (findings.experiments || []).length;

  console.log(
    'EXTRACT',
    JSON.stringify({
      experiments: extractedExpCount,
      strings: extractedStrCount,
      routes: extractedRtCount,
    }),
  );

  if (extractedExpCount < 20 && extractedStrCount < 100) {
    console.warn('Extract looks empty — skip diffs to avoid flood');
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: prev.experiments || findings.experiments || [],
      strings: prev.strings || extractedStrings,
      routes: prev.routes || findings.routes || {},
    });
    console.log('=== Done (empty extract guard)', Date.now() - t0 + 'ms ===');
    process.exit(0);
  }

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
    if (!prevExpMap.has(id) && !knownExp.has(id)) expDiff.added.push(e);
    else if (prevExpMap.has(id)) {
      const prevFp = expFingerprint(prevExpMap.get(id));
      const nextFp = expFingerprint(e);
      if (prevFp && nextFp && prevFp !== nextFp) expDiff.modified.push(e);
    }
  }

  // Removals seulement si couverture solide
  const coverage =
    (prev.experiments || []).length > 0
      ? extractedExpCount / (prev.experiments || []).length
      : 0;
  if (coverage >= MIN_EXP_COVERAGE && (prev.experiments || []).length > 20) {
    for (const [id] of prevExpMap) {
      if (!nextExpMap.has(id)) expDiff.removed.push({ id });
    }
    if (expDiff.removed.length > 25) {
      console.log('Too many exp removals', expDiff.removed.length, '— clear');
      expDiff.removed = [];
    }
  }

  if (expDiff.modified.length > 20) {
    console.log('Too many exp modified', expDiff.modified.length, '— clear');
    expDiff.modified = [];
  }

  const strDiff = { added: {}, modified: {}, removed: {} };
  const lastStrCount = Object.keys(lastStr).length;
  let strOverlap = 0;
  if (lastStrCount && extractedStrCount) {
    for (const k of Object.keys(extractedStrings)) {
      if (k in lastStr) strOverlap++;
    }
  }
  const strOverlapRatio =
    extractedStrCount > 0 ? strOverlap / extractedStrCount : 0;
  if (lastStrCount >= 50 && extractedStrCount >= 50 && strOverlapRatio < 0.3) {
    console.log(
      'String source shifted (overlap ' +
        strOverlapRatio.toFixed(2) +
        ') — reseed, no flood',
    );
    for (const k of Object.keys(lastStr)) delete lastStr[k];
  }

  if (
    extractedStrCount >= MIN_STRINGS_FOR_DIFF &&
    Object.keys(lastStr).length >= 50
  ) {
    for (const [k, v] of Object.entries(extractedStrings)) {
      if (!(k in lastStr)) {
        if (!knownStr.has(k)) strDiff.added[k] = v;
      } else if (String(lastStr[k]) !== String(v)) strDiff.modified[k] = v;
    }
    const ratio = extractedStrCount / Math.max(Object.keys(lastStr).length, 1);
    if (ratio >= 0.6 && ratio <= 1.5) {
      for (const [k, v] of Object.entries(lastStr)) {
        if (!(k in extractedStrings)) strDiff.removed[k] = v;
      }
      if (Object.keys(strDiff.removed).length > 150) strDiff.removed = {};
    }
    // Cap notify size — keep first N, don't wipe all
    const addKeys = Object.keys(strDiff.added);
    if (addKeys.length > MAX_NOTIFY_STR) {
      const keep = {};
      for (const k of addKeys.slice(0, MAX_NOTIFY_STR)) keep[k] = strDiff.added[k];
      strDiff.added = keep;
    }
    const modKeys = Object.keys(strDiff.modified);
    if (modKeys.length > MAX_NOTIFY_STR) {
      const keep = {};
      for (const k of modKeys.slice(0, MAX_NOTIFY_STR))
        keep[k] = strDiff.modified[k];
      strDiff.modified = keep;
    }
  } else if (Object.keys(lastStr).length < 50) {
    console.log('Strings seed last_extract (' + extractedStrCount + ')');
  }

  const rtDiff = { added: {}, modified: {}, removed: {} };
  const lastRtCount = Object.keys(lastRt).length;
  const nextRt = findings.routes || {};
  if (extractedRtCount >= MIN_ROUTES_FOR_DIFF && lastRtCount >= 20) {
    for (const [k, v] of Object.entries(nextRt)) {
      if (!(k in lastRt)) {
        if (!knownRt.has(k)) rtDiff.added[k] = v;
      } else if (String(lastRt[k]) !== String(v)) rtDiff.modified[k] = v;
    }
    const ratio = extractedRtCount / lastRtCount;
    if (ratio >= 0.6 && ratio <= 1.5) {
      for (const [k, v] of Object.entries(lastRt)) {
        if (!(k in nextRt)) rtDiff.removed[k] = v;
      }
      if (Object.keys(rtDiff.removed).length > 50) rtDiff.removed = {};
    }
    const addKeys = Object.keys(rtDiff.added);
    if (addKeys.length > MAX_NOTIFY_RT) {
      const keep = {};
      for (const k of addKeys.slice(0, MAX_NOTIFY_RT)) keep[k] = rtDiff.added[k];
      rtDiff.added = keep;
    }
  } else if (lastRtCount < 20) {
    console.log('Routes seed');
  }

  if (!isNewBuild && needsExtractSeed) {
    console.log('Seed-only: no webhook');
    expDiff.added = [];
    expDiff.modified = [];
    expDiff.removed = [];
    strDiff.added = {};
    strDiff.modified = {};
    strDiff.removed = {};
    rtDiff.added = {};
    rtDiff.modified = {};
    rtDiff.removed = {};
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

  for (const e of findings.experiments || []) {
    if (e && e.id) knownExp.add(String(e.id));
  }
  for (const e of expDiff.added) knownExp.add(String(e.id || e));
  for (const k of Object.keys(extractedStrings)) knownStr.add(k);
  for (const k of Object.keys(strDiff.added)) knownStr.add(k);
  for (const k of Object.keys(nextRt)) knownRt.add(k);
  for (const k of Object.keys(rtDiff.added)) knownRt.add(k);

  // Cap experiments notify (keep slice, don't drop silently without log)
  if (expDiff.added.length > MAX_NOTIFY_EXP) {
    console.log(
      'Cap exp added',
      expDiff.added.length,
      '→',
      MAX_NOTIFY_EXP,
    );
    expDiff.added = expDiff.added.slice(0, MAX_NOTIFY_EXP);
  }

  const alreadyBuild = await wasBuildAnnounced(build.buildNumber);
  const shouldAnnounceBuild = isNewBuild && !alreadyBuild && !flashSent;

  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await notifyAll({
        build,
        isNewBuild: shouldAnnounceBuild,
        expDiff,
        strDiff,
        rtDiff,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });
      if (shouldAnnounceBuild) await markBuild(build.buildNumber);
    } catch (e) {
      console.warn('notify failed', e.message);
    }
  }
  console.log('Notify done', Date.now() - t0 + 'ms');

  await Promise.all([
    saveKnownExp(knownExp),
    saveKnownStr(knownStr),
    saveKnownRt(knownRt),
    saveLastExtract(LAST_EXTRACT_STR, extractedStrings, build.buildNumber),
    saveLastExtract(LAST_EXTRACT_RT, nextRt, build.buildNumber),
  ]);

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
