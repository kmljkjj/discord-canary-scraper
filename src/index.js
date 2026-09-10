/**
 * Canary Pulse v10.3 — extract-to-extract + catch-up
 *
 * Discord CDN only serves the CURRENT canary assets.
 * Missed intermediate builds cannot be reconstructed one-by-one.
 * When we skip builds (no Actions run), the next scrape reports the
 * NET delta since last successful extract (catch-up), not each missed build.
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
const LAST_EXTRACT_EXP = path.join(DATA, 'last_extract_experiments.json');
const ANNOUNCED = path.join(DATA, 'announced_builds.json');

const MAX_NOTIFY_EXP = 30;
const MAX_NOTIFY_STR = 80;
const MAX_NOTIFY_RT = 40;
const MIN_STRINGS_FOR_DIFF = 200;
const MIN_ROUTES_FOR_DIFF = 50;
const MIN_EXP_FOR_DIFF = 80;

const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

async function loadKnownIds(file, fromAlready) {
  const set = new Set();
  if (fromAlready) {
    for (const id of ALREADY_NOTIFIED) set.add(String(id));
  }
  try {
    if (await fs.pathExists(file)) {
      const d = await fs.readJson(file);
      for (const id of d.ids || d.keys || []) set.add(String(id));
    }
  } catch {}
  return set;
}

async function saveKnownIds(file, set, maxKeep) {
  let ids = [...set].filter((id) => id && !String(id).startsWith('hash:')).sort();
  if (maxKeep && ids.length > maxKeep) ids = ids.slice(-maxKeep);
  await fs.writeJson(
    file,
    { updatedAt: new Date().toISOString(), count: ids.length, ids },
    { spaces: 2 },
  );
}

async function loadLastMap(file) {
  try {
    if (!(await fs.pathExists(file))) return {};
    const d = await fs.readJson(file);
    const raw =
      d.data && typeof d.data === 'object'
        ? d.data
        : d.strings || d.routes || d.experiments || d || {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'buildNumber' || k === 'updatedAt' || k === 'count' || k === 'data')
        continue;
      out[k] = v;
    }
    return out;
  } catch (e) {
    console.warn('loadLastMap fail', file, e.message);
    return {};
  }
}

async function saveLastMap(file, data, buildNumber) {
  await fs.writeJson(file, {
    buildNumber: String(buildNumber),
    updatedAt: new Date().toISOString(),
    count: Object.keys(data || {}).length,
    data,
  });
}

function expFingerprint(e) {
  if (!e || typeof e !== 'object') return '';
  const type = e.type === 'guild' || e.kind === 'guild' ? 'guild' : 'user';
  let keys = [];
  if (e.variations && typeof e.variations === 'object') {
    keys = Object.keys(e.variations).sort((a, b) => Number(a) - Number(b));
  } else if (Array.isArray(e.treatments)) {
    keys = e.treatments.map((_, i) => String(i));
  } else if (typeof e.variationCount === 'number' && e.variationCount > 0) {
    keys = Array.from({ length: e.variationCount }, (_, i) => String(i));
  }
  return type + '|' + keys.join(',');
}

function expSnapshot(e) {
  return {
    id: e.id,
    type: e.type || e.kind || 'user',
    kind: e.kind || e.type || 'user',
    variationCount:
      e.variationCount ||
      (e.variations ? Object.keys(e.variations).length : 0) ||
      0,
    variations: e.variations || null,
    fp: expFingerprint(e),
  };
}

function buildGap(prevBuild, remoteBuild) {
  const a = parseInt(String(prevBuild || ''), 10);
  const b = parseInt(String(remoteBuild || ''), 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}

async function flashBuild(webhookUrl, build, meta) {
  const bn = String(build.buildNumber || '?');
  const hash = build.versionHash ? String(build.versionHash).slice(0, 12) : null;
  const gap = meta && meta.gap ? meta.gap : 0;
  const prev = meta && meta.prevBuild ? String(meta.prevBuild) : null;

  let desc = hash ? 'Hash `' + hash + '`\n' : '';
  if (gap > 1 && prev) {
    desc +=
      '**Catch-up** · last seen `' +
      prev +
      '` → now `' +
      bn +
      '` (+' +
      gap +
      ')\n' +
      '_Intermediate builds are not on Discord CDN — reporting **net** changes since last scrape._\n';
  }
  desc += '_Extracting experiments, strings & routes…_';

  const body = {
    username: BOT,
    avatar_url: AVATAR,
    embeds: [
      {
        author: { name: 'Datamining', icon_url: AVATAR },
        title:
          gap > 1
            ? 'Canary Catch-up · ' + bn
            : 'New Discord Canary Build · ' + bn,
        description: desc,
        color: gap > 1 ? 0xfee75c : 0x5865f2,
        footer: {
          text:
            'Build ' +
            bn +
            (prev ? ' · was ' + prev : '') +
            ' · Datamining · flash',
        },
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
  console.log('=== Canary Pulse v10.3 (catch-up) ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);
  await fs.ensureDir(CACHE);

  const [prev, knownExp, knownStr, knownRt, lastStr, lastRt, lastExp] =
    await Promise.all([
      loadState(DATA),
      loadKnownIds(KNOWN_EXP, true),
      loadKnownIds(KNOWN_STR, false),
      loadKnownIds(KNOWN_RT, false),
      loadLastMap(LAST_EXTRACT_STR),
      loadLastMap(LAST_EXTRACT_RT),
      loadLastMap(LAST_EXTRACT_EXP),
    ]);

  console.log('Known / last extract', {
    knownExp: knownExp.size,
    knownStr: knownStr.size,
    knownRt: knownRt.size,
    lastExp: Object.keys(lastExp).length,
    lastStr: Object.keys(lastStr).length,
    lastRt: Object.keys(lastRt).length,
  });

  let build;
  try {
    build = await fetchBuild();
  } catch (e) {
    console.error('fetchBuild failed', e.message);
    process.exit(1);
  }

  const prevBuildNum = prev.build && prev.build.buildNumber;
  const gap = buildGap(prevBuildNum, build.buildNumber);
  const isCatchUp = gap > 1;

  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prevBuildNum,
      gap,
      catchUp: isCatchUp,
      lastExp: Object.keys(lastExp).length,
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
    Object.keys(lastStr).length < 50 ||
    Object.keys(lastRt).length < 20 ||
    Object.keys(lastExp).length < 40;

  if (
    !isNewBuild &&
    prev.initialized &&
    !needsExtractSeed &&
    Object.keys(lastExp).length > 40
  ) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  if (needsExtractSeed && !isNewBuild) {
    console.log('SEED RUN — fill last_extract, no flood');
  }
  if (isCatchUp) {
    console.log(
      'CATCH-UP mode: last',
      prevBuildNum,
      '→',
      build.buildNumber,
      '(+' + gap + ') — net delta only (CDN has current assets only)',
    );
  }

  let flashSent = false;
  if (isNewBuild && process.env.DISCORD_WEBHOOK_URL) {
    const already = await wasBuildAnnounced(build.buildNumber);
    if (!already) {
      try {
        await flashBuild(process.env.DISCORD_WEBHOOK_URL, build, {
          gap,
          prevBuild: prevBuildNum,
        });
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
    'catchUp=' + isCatchUp,
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
  const nextRt = { ...(findings.routes || {}) };
  const extractedStrCount = Object.keys(extractedStrings).length;
  const extractedRtCount = Object.keys(nextRt).length;
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
    console.warn('Extract looks empty — skip diffs');
    await saveState(DATA, {
      initialized: true,
      build,
      experiments: prev.experiments || findings.experiments || [],
      strings: prev.strings || extractedStrings,
      routes: prev.routes || nextRt,
    });
    console.log('=== Done (empty extract guard)', Date.now() - t0 + 'ms ===');
    process.exit(0);
  }

  const nextExpMap = new Map();
  const nextExpSnap = {};
  for (const e of findings.experiments || []) {
    if (!e || !e.id || String(e.id).startsWith('hash:')) continue;
    const id = String(e.id);
    nextExpMap.set(id, e);
    nextExpSnap[id] = expSnapshot(e);
  }

  const lastExpCount = Object.keys(lastExp).length;
  const expDiff = { added: [], modified: [], removed: [] };

  // Catch-up: trust last_extract only (ignore known* so net-new since last scrape still notifies)
  const skipKnownFilter = isCatchUp;

  if (extractedExpCount >= MIN_EXP_FOR_DIFF && lastExpCount >= 40) {
    for (const [id, e] of nextExpMap) {
      if (!(id in lastExp)) {
        if (skipKnownFilter || !knownExp.has(id)) expDiff.added.push(e);
      } else {
        const prevFp =
          (lastExp[id] && lastExp[id].fp) ||
          expFingerprint(lastExp[id]) ||
          '';
        const nextFp = expFingerprint(e);
        if (prevFp && nextFp && prevFp !== nextFp) {
          expDiff.modified.push({
            ...e,
            _prevFp: prevFp,
            _nextFp: nextFp,
          });
        }
      }
    }

    const coverage = extractedExpCount / lastExpCount;
    if (coverage >= 0.75 && coverage <= 1.35) {
      for (const id of Object.keys(lastExp)) {
        if (!nextExpMap.has(id)) expDiff.removed.push({ id });
      }
      if (expDiff.removed.length > 30) {
        console.log('Too many exp removals', expDiff.removed.length, '— clear');
        expDiff.removed = [];
      }
    } else {
      console.log(
        'Exp coverage',
        coverage.toFixed(2),
        'vs last extract — skip removals',
      );
    }

    if (expDiff.modified.length > 25) {
      console.log('Too many exp modified', expDiff.modified.length, '— clear');
      expDiff.modified = [];
    }
    if (expDiff.added.length > MAX_NOTIFY_EXP) {
      console.log('Cap exp added', expDiff.added.length, '→', MAX_NOTIFY_EXP);
      expDiff.added = expDiff.added.slice(0, MAX_NOTIFY_EXP);
    }
  } else if (lastExpCount < 40) {
    console.log('Experiments seed last_extract (' + extractedExpCount + ')');
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
        ') — reseed',
    );
    for (const k of Object.keys(lastStr)) delete lastStr[k];
  }

  if (
    extractedStrCount >= MIN_STRINGS_FOR_DIFF &&
    Object.keys(lastStr).length >= 50
  ) {
    for (const [k, v] of Object.entries(extractedStrings)) {
      if (!(k in lastStr)) {
        if (skipKnownFilter || !knownStr.has(k)) strDiff.added[k] = v;
      } else if (String(lastStr[k]) !== String(v)) {
        strDiff.modified[k] = v;
      }
    }
    const ratio = extractedStrCount / Math.max(Object.keys(lastStr).length, 1);
    if (ratio >= 0.75 && ratio <= 1.35) {
      for (const [k, v] of Object.entries(lastStr)) {
        if (!(k in extractedStrings)) strDiff.removed[k] = v;
      }
      if (Object.keys(strDiff.removed).length > 120) strDiff.removed = {};
    }
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
    console.log('Strings seed (' + extractedStrCount + ')');
  }

  const rtDiff = { added: {}, modified: {}, removed: {} };
  const lastRtCount = Object.keys(lastRt).length;
  if (extractedRtCount >= MIN_ROUTES_FOR_DIFF && lastRtCount >= 20) {
    for (const [k, v] of Object.entries(nextRt)) {
      if (!(k in lastRt)) {
        if (skipKnownFilter || !knownRt.has(k)) rtDiff.added[k] = v;
      } else if (String(lastRt[k]) !== String(v)) {
        rtDiff.modified[k] = v;
      }
    }
    const ratio = extractedRtCount / lastRtCount;
    if (ratio >= 0.75 && ratio <= 1.35) {
      for (const [k, v] of Object.entries(lastRt)) {
        if (!(k in nextRt)) rtDiff.removed[k] = v;
      }
      if (Object.keys(rtDiff.removed).length > 40) rtDiff.removed = {};
    } else {
      console.log('Route coverage', ratio.toFixed(2), '— skip removals');
    }
    const addKeys = Object.keys(rtDiff.added);
    if (addKeys.length > MAX_NOTIFY_RT) {
      const keep = {};
      for (const k of addKeys.slice(0, MAX_NOTIFY_RT)) keep[k] = rtDiff.added[k];
      rtDiff.added = keep;
    }
  } else if (lastRtCount < 20) {
    console.log('Routes seed (' + extractedRtCount + ')');
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
    catchUp: isCatchUp,
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

  for (const e of expDiff.added) knownExp.add(String(e.id || e));
  for (const k of Object.keys(strDiff.added)) knownStr.add(k);
  for (const k of Object.keys(rtDiff.added)) knownRt.add(k);

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
        catchUp: isCatchUp,
        prevBuild: prevBuildNum,
      });
      if (shouldAnnounceBuild) await markBuild(build.buildNumber);
    } catch (e) {
      console.warn('notify failed', e.message);
    }
  }
  console.log('Notify done', Date.now() - t0 + 'ms');

  await Promise.all([
    saveKnownIds(KNOWN_EXP, knownExp, 8000),
    saveKnownIds(KNOWN_STR, knownStr, 50000),
    saveKnownIds(KNOWN_RT, knownRt, 10000),
    saveLastMap(LAST_EXTRACT_STR, extractedStrings, build.buildNumber),
    saveLastMap(LAST_EXTRACT_RT, nextRt, build.buildNumber),
    saveLastMap(LAST_EXTRACT_EXP, nextExpSnap, build.buildNumber),
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
