    // Do not advance known_* on notify failure — next run must still see new items
    process.exit(2);
  }

  // --- Atomic data generation (all-or-nothing after successful notify) ---
  const runId = makeRunId(build.buildNumber);
  const bn = String(build.buildNumber);
  const tsIso = new Date().toISOString();

  const knownExpIds = [...knownExp]
    .filter((id) => id && !String(id).startsWith('hash:'))
    .sort();
  const knownStrIds = [...knownStr].filter(Boolean).sort();
  const knownRtIds = [...knownRt].filter(Boolean).sort();
  if (knownExpIds.length > 8000) knownExpIds.splice(0, knownExpIds.length - 8000);
  if (knownStrIds.length > 50000) knownStrIds.splice(0, knownStrIds.length - 50000);
  if (knownRtIds.length > 10000) knownRtIds.splice(0, knownRtIds.length - 10000);

  const normalized = (findings.experiments || [])
    .map(experimentState.normalizeExperiment)
    .filter(Boolean);
  const previousCurrent = await experimentState.loadCurrentExperiments(DATA);
  const previousRemoved = await experimentState.loadRemovedExperiments(DATA);
  const cov = experimentState.assessCoverage({
    currentCount: normalized.length,
    previousCount: previousCurrent.length,
    extractionStatus: 'complete',
  });
  console.log('EXP_STATE coverage', cov);
  const nextKnown = experimentState.mergeKnownIds(knownExpIds, normalized);
  const nextRemoved = experimentState.updateRemovedExperiments({
    previousCurrent,
    current: normalized,
    existingRemoved: previousRemoved,
    allowRemovals: cov.reliable && expDiff.removed.length > 0,
    buildNumber: bn,
  });

  const allExps = findings.experiments || [];
  const apexList = allExps
    .filter((e) => e.system !== 'legacy')
    .map((e) => ({
      kind: e.kind || e.type || 'user',
      name: e.id,
      defaultConfig: e.defaultConfig || null,
      variations: e.variations || null,
      label: e.label || null,
    }));
  const legacyList = allExps.filter((e) => e.system === 'legacy');

  let mergedExps = mergeExp(prev.experiments, findings.experiments);
  if (expDiff.removed.length) {
    const drop = new Set(expDiff.removed.map((e) => String(e.id || e)));
    mergedExps = mergedExps.filter((e) => !drop.has(String(e.id)));
  }
  const mergedStrings = { ...(prev.strings || {}), ...extractedStrings };
  for (const k of Object.keys(strDiff.removed)) delete mergedStrings[k];
  const mergedRoutes = { ...(prev.routes || {}), ...nextRt };
  for (const k of Object.keys(rtDiff.removed)) delete mergedRoutes[k];

  const stamp = { runId, buildNumber: bn };
  const files = {
    'known_experiment_ids.json': {
      ...stamp,
      updatedAt: tsIso,
      count: nextKnown.length,
      ids: nextKnown,
    },
    'known_string_keys.json': {
      ...stamp,
      updatedAt: tsIso,
      count: knownStrIds.length,
      ids: knownStrIds,
    },
    'known_route_keys.json': {
      ...stamp,
      updatedAt: tsIso,
      count: knownRtIds.length,
      ids: knownRtIds,
    },
    'last_extract_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: Object.keys(nextExpSnap || {}).length,
      data: nextExpSnap || {},
    },
    'last_extract_strings.json': {
      ...stamp,
      updatedAt: tsIso,
      count: Object.keys(extractedStrings || {}).length,
      data: extractedStrings || {},
    },
    'last_extract_routes.json': {
      ...stamp,
      updatedAt: tsIso,
      count: Object.keys(nextRt || {}).length,
      data: nextRt || {},
    },
    'current_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: normalized.length,
      experiments: normalized,
    },
    'removed_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: nextRemoved.length,
      experiments: nextRemoved,
    },
    'apex_experiments.json': apexList,
    'experiments.json': {
      ...stamp,
      scrapedAt: tsIso,
      totals: { all: mergedExps.length },
      experiments: legacyList.length ? legacyList : mergedExps,
    },
    'build.json': {
      ...stamp,
      versionHash: build.versionHash || null,
      releaseChannel: build.releaseChannel || 'canary',
      scrapedAt: build.scrapedAt || tsIso,
      assetCount: Array.isArray(build.assets) ? build.assets.length : null,
      cssCount: Array.isArray(build.cssAssets) ? build.cssAssets.length : null,
    },
    'findings.json': {
      ...stamp,
      scrapedAt: tsIso,
      totals: { all: mergedExps.length },
      experiments: mergedExps,
    },
    'strings.json': mergedStrings,
    'routes.json': mergedRoutes,
    'meta.json': {
      ...stamp,
      initialized: true,
      updatedAt: tsIso,
      experimentCount: mergedExps.length,
      stringCount: Object.keys(mergedStrings).length,
      routeCount: Object.keys(mergedRoutes).length,
      lastBuild: bn,
    },
    'last_run_meta.json': {
      schemaVersion: 1,
      runId,
      buildNumber: bn,
      ts: Date.now(),
      status: 'success',
      ok: true,
      versionHash: build.versionHash || null,
      durationMs: Date.now() - t0,
      experiments: (findings.experiments || []).length,
      strings: Object.keys(extractedStrings || {}).length,
      routes: Object.keys(nextRt || {}).length,
      downloadStats: findings.downloadStats || null,
    },
  };

  try {
    await publishDataGeneration(DATA, {
      runId,
      buildNumber: bn,
      files,
    });
    console.log('EXP_STATE published', {
      current: normalized.length,
      known: nextKnown.length,
      removed: nextRemoved.length,
      reliable: cov.reliable,
    });
  } catch (e) {
    console.error('DATA_PUBLISH failed — baseline not advanced', e.message);
    try {
      await fs.writeJson(LAST_RUN_META, {
        schemaVersion: 1,
        runId,
        buildNumber: bn,
        ts: Date.now(),
        status: 'publish_failed',
        ok: false,
        reason: String(e.message || e).slice(0, 500),
        durationMs: Date.now() - t0,
      });
    } catch {}
    process.exit(1);
  }

  console.log('=== Done', Date.now() - t0 + 'ms ===');
}
