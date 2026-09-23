#!/usr/bin/env python3
"""Wire experiment_state into src/index.js (idempotent)."""
from pathlib import Path

p = Path('src/index.js')
src = p.read_text()
changed = False

if "require('./lib/experiment_state')" not in src:
    old = "const { writeJsonAtomic } = require('./lib/atomic');"
    new = old + "\nconst experimentState = require('./lib/experiment_state');"
    if old not in src:
        raise SystemExit('atomic require not found')
    src = src.replace(old, new, 1)
    changed = True
    print('require wired')
else:
    print('require already present')

old_mm = '''function isMeaningfulExpMod(prev, next) {
  if (!prev || !next) return false;
  const prevKeys = variationKeySet(prev);
  const nextKeys = variationKeySet(next);
  const prevN = prevKeys ? prevKeys.split(',').filter(Boolean).length : 0;
  const nextN = nextKeys ? nextKeys.split(',').filter(Boolean).length : 0;
  if (prevN === 0 || nextN === 0) return false;
  if (prevKeys !== nextKeys) return true;
  const prevLabel = (prev.label || '').trim();
  const nextLabel = (next.label || '').trim();
  if (prevLabel && nextLabel && prevLabel !== nextLabel) return true;
  return false;
}'''

new_mm = '''function isMeaningfulExpMod(prev, next) {
  if (!prev || !next) return false;
  const prevFp = prev.fp || prev.fingerprint;
  const nextFp = next.fp || next.fingerprint || expFingerprint(next);
  if (prevFp && nextFp && prevFp !== nextFp) {
    const prevKeys = variationKeySet(prev);
    const nextKeys = variationKeySet(next);
    if (!prevKeys && !nextKeys) return false;
    return true;
  }
  const prevKeys = variationKeySet(prev);
  const nextKeys = variationKeySet(next);
  const prevN = prevKeys ? prevKeys.split(',').filter(Boolean).length : 0;
  const nextN = nextKeys ? nextKeys.split(',').filter(Boolean).length : 0;
  if (prevN === 0 || nextN === 0) return false;
  if (prevKeys !== nextKeys) return true;
  const prevLabel = (prev.label || '').trim();
  const nextLabel = (next.label || '').trim();
  if (prevLabel && nextLabel && prevLabel !== nextLabel) return true;
  const pk = (prev.kind || prev.type || '').toLowerCase();
  const nk = (next.kind || next.type || '').toLowerCase();
  if (pk && nk && pk !== nk) return true;
  return false;
}'''

if 'prev.fp || prev.fingerprint' not in src:
    if old_mm not in src:
        raise SystemExit('isMeaningfulExpMod block not found')
    src = src.replace(old_mm, new_mm, 1)
    changed = True
    print('isMeaningfulExpMod patched')
else:
    print('isMeaningfulExpMod already patched')

old_tasks = '''  const tasks = [
    saveKnownIds(KNOWN_EXP, knownExp, 8000),
    saveKnownIds(KNOWN_STR, knownStr, 50000),
    saveKnownIds(KNOWN_RT, knownRt, 10000),
    saveLastMap(LAST_EXTRACT_EXP, nextExpSnap, build.buildNumber),
    saveLastMap(LAST_EXTRACT_STR, extractedStrings, build.buildNumber),
    saveLastMap(LAST_EXTRACT_RT, nextRt, build.buildNumber),
  ];
  await Promise.all(tasks);'''

new_tasks = '''  const tasks = [
    saveKnownIds(KNOWN_EXP, knownExp, 8000),
    saveKnownIds(KNOWN_STR, knownStr, 50000),
    saveKnownIds(KNOWN_RT, knownRt, 10000),
    saveLastMap(LAST_EXTRACT_EXP, nextExpSnap, build.buildNumber),
    saveLastMap(LAST_EXTRACT_STR, extractedStrings, build.buildNumber),
    saveLastMap(LAST_EXTRACT_RT, nextRt, build.buildNumber),
  ];
  await Promise.all(tasks);

  // current / known / removed (only after successful notify gate)
  try {
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
    const nextKnown = experimentState.mergeKnownIds([...knownExp], normalized);
    const nextRemoved = experimentState.updateRemovedExperiments({
      previousCurrent,
      current: normalized,
      existingRemoved: previousRemoved,
      allowRemovals: cov.reliable && expDiff.removed.length > 0,
      buildNumber: build.buildNumber,
    });
    await experimentState.writeExperimentState(DATA, {
      current: normalized,
      knownIds: nextKnown,
      removed: nextRemoved,
      buildNumber: build.buildNumber,
    });
    console.log('EXP_STATE written', {
      current: normalized.length,
      known: nextKnown.length,
      removed: nextRemoved.length,
      reliable: cov.reliable,
    });
  } catch (e) {
    console.warn('EXP_STATE write failed', e.message);
  }'''

if 'EXP_STATE written' not in src:
    if old_tasks not in src:
        raise SystemExit('tasks block not found')
    src = src.replace(old_tasks, new_tasks, 1)
    changed = True
    print('EXP_STATE write wired')
else:
    print('EXP_STATE already wired')

if changed:
    p.write_text(src)
    print('wrote', p, 'bytes', p.stat().st_size)
else:
    print('no changes')
