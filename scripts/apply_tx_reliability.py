#!/usr/bin/env python3
"""Apply high-priority reliability fixes to index/experiment_state/notify."""
from pathlib import Path

def must_replace(path, old, new, label):
    text = Path(path).read_text()
    if new[:40] in text and old not in text:
        print(f'skip {label} (already applied)')
        return text
    if old not in text:
        raise SystemExit(f'MISSING {label} in {path}')
    text = text.replace(old, new)
    Path(path).write_text(text)
    print(f'ok {label}')
    return text

# --- experiment_state.js: removedAll + updateRemoved confirmed ids ---
es = Path('src/lib/experiment_state.js').read_text()
old_ret = '''  return {
    added: added.slice(0, maxAdded),
    removed:
      removed.length > maxRemoved && maxRemoved < Infinity
        ? []
        : removed.slice(0, maxRemoved),
    modified: modified.slice(0, maxModified),
    categoryChanged: categoryChanged.slice(0, maxCat),
  };
}'''
new_ret = '''  const removedAll = removed;
  if (removedAll.length > maxRemoved && maxRemoved < Infinity) {
    console.warn('EXP_DIFF: removed capped for notify', {
      observed: removedAll.length,
      notified: maxRemoved,
    });
  }
  return {
    added: added.slice(0, maxAdded),
    removed: removedAll.slice(0, maxRemoved),
    removedAll,
    modified: modified.slice(0, maxModified),
    categoryChanged: categoryChanged.slice(0, maxCat),
  };
}'''
if old_ret in es:
    es = es.replace(old_ret, new_ret)
    print('ok removedAll')
elif 'removedAll' in es:
    print('skip removedAll')
else:
    raise SystemExit('MISSING return block')

old_ur = '''function updateRemovedExperiments({
  previousCurrent,
  current,
  existingRemoved,
  allowRemovals,
  buildNumber,
}) {
  const out = [...(existingRemoved || [])];
  const seen = new Set(out.map((e) => String(e.id || e)));
  if (!allowRemovals) return out;

  const currentIds = new Set((current || []).map((e) => String(e.id)));
  const ts = new Date().toISOString();
  for (const prev of previousCurrent || []) {
    const id = String(prev.id);
    if (!currentIds.has(id) && !seen.has(id)) {
      out.push({
        id,
        kind: prev.kind || prev.type || null,
        label: prev.label || null,
        removedAt: ts,
        lastBuild: buildNumber != null ? String(buildNumber) : null,
      });
      seen.add(id);
    }
  }
  if (out.length > 5000) return out.slice(-5000);
  return out;
}'''
new_ur = '''function updateRemovedExperiments({
  previousCurrent,
  current,
  existingRemoved,
  allowRemovals,
  buildNumber,
  confirmedRemovedIds,
}) {
  const out = [...(existingRemoved || [])];
  const seen = new Set(out.map((e) => String(e.id || e)));
  if (!allowRemovals) return out;

  const currentIds = new Set((current || []).map((e) => String(e.id)));
  const ts = new Date().toISOString();
  const confirmed =
    Array.isArray(confirmedRemovedIds) && confirmedRemovedIds.length
      ? new Set(confirmedRemovedIds.map(String))
      : null;

  for (const prev of previousCurrent || []) {
    const id = String(prev.id);
    if (currentIds.has(id) || seen.has(id)) continue;
    if (confirmed && !confirmed.has(id)) continue;
    out.push({
      id,
      kind: prev.kind || prev.type || null,
      label: prev.label || null,
      removedAt: ts,
      lastBuild: buildNumber != null ? String(buildNumber) : null,
    });
    seen.add(id);
  }

  if (confirmed) {
    for (const id of confirmed) {
      if (!id || seen.has(id) || currentIds.has(id)) continue;
      out.push({
        id,
        kind: null,
        label: null,
        removedAt: ts,
        lastBuild: buildNumber != null ? String(buildNumber) : null,
      });
      seen.add(id);
    }
  }

  if (out.length > 10000) return out.slice(-10000);
  return out;
}'''
if old_ur in es:
    es = es.replace(old_ur, new_ur)
    print('ok updateRemoved')
elif 'confirmedRemovedIds' in es:
    print('skip updateRemoved')
else:
    raise SystemExit('MISSING updateRemoved')
Path('src/lib/experiment_state.js').write_text(es)

# --- index.js ---
idx = Path('src/index.js').read_text()

old_core = '''        if (ok) {
          urgentSent = true;
          for (const e of urgentDiff.added) knownExp.add(String(e.id || e));
          try {
            await saveKnownIds(KNOWN_EXP, knownExp, 8000);
          } catch (e) {
            console.warn('early knownExp save', e.message);
          }
        } else {
          console.warn('URGENT webhook failed — NOT marking known exp');
        }'''
new_core = '''        if (ok) {
          urgentSent = true;
          // In-memory only until publishDataGeneration — no early disk write
          for (const e of urgentDiff.added) knownExp.add(String(e.id || e));
        } else {
          console.warn('URGENT webhook failed — NOT marking known exp');
        }'''
if old_core in idx:
    idx = idx.replace(old_core, new_core)
    print('ok onCore no early known')
elif 'In-memory only until publishDataGeneration' in idx:
    print('skip onCore')
else:
    raise SystemExit('MISSING onCore block')

old_trunc = '''  if (knownExpIds.length > 8000) knownExpIds.splice(0, knownExpIds.length - 8000);
  if (knownStrIds.length > 50000) knownStrIds.splice(0, knownStrIds.length - 50000);
  if (knownRtIds.length > 10000) knownRtIds.splice(0, knownRtIds.length - 10000);'''
new_trunc = '''  // knownExp is append-only — never truncate
  if (knownStrIds.length > 50000) knownStrIds.splice(0, knownStrIds.length - 50000);
  if (knownRtIds.length > 10000) knownRtIds.splice(0, knownRtIds.length - 10000);'''
if old_trunc in idx:
    idx = idx.replace(old_trunc, new_trunc)
    print('ok known append-only')
elif 'knownExp is append-only' in idx:
    print('skip trunc')
else:
    raise SystemExit('MISSING trunc')

old_diff = '''  const { expDiff, nextExpSnap } = computeExpDiff(
    findings.experiments,
    lastExp,
    knownExp,
    { skipKnownFilter: isCatchUp },
  );'''
new_diff = '''  const {
    expDiff,
    nextExpSnap,
    coverage: expCoverage,
    rawDiff,
  } = computeExpDiff(
    findings.experiments,
    lastExp,
    knownExp,
    { skipKnownFilter: isCatchUp },
  );'''
if old_diff in idx:
    idx = idx.replace(old_diff, new_diff)
    print('ok rawDiff capture')
elif 'rawDiff' in idx and 'coverage: expCoverage' in idx:
    print('skip rawDiff')
else:
    raise SystemExit('MISSING computeExpDiff destructure')

old_rem = '''  const nextKnown = experimentState.mergeKnownIds(knownExpIds, normalized);
  const nextRemoved = experimentState.updateRemovedExperiments({
    previousCurrent,
    current: normalized,
    existingRemoved: previousRemoved,
    allowRemovals: cov.reliable && expDiff.removed.length > 0,
    buildNumber: bn,
  });'''
new_rem = '''  const nextKnown = experimentState.mergeKnownIds(knownExpIds, normalized);
  const nextRemoved = experimentState.updateRemovedExperiments({
    previousCurrent,
    current: normalized,
    existingRemoved: previousRemoved,
    allowRemovals: !!cov.reliable,
    buildNumber: bn,
    confirmedRemovedIds: (
      (rawDiff && (rawDiff.removedAll || rawDiff.removed)) ||
      expDiff.removed ||
      []
    ).map((e) => String(typeof e === 'string' ? e : e && e.id)),
  });'''
if old_rem in idx:
    idx = idx.replace(old_rem, new_rem)
    print('ok canonical removals')
elif 'confirmedRemovedIds' in idx:
    print('skip removals')
else:
    raise SystemExit('MISSING removals block')

Path('src/index.js').write_text(idx)

# --- notify.js: pct by kind ---
nty = Path('src/lib/notify.js').read_text()
old_pct = '''  const pct =
    (e && e.guildPercentage && e.guildPercentage.status !== 'unknown'
      ? e.guildPercentage
      : null) ||
    (e && e.userPercentage && e.userPercentage.status !== 'unknown'
      ? e.userPercentage
      : null);
  if (pct && pct.value != null) {
    meta.push(`${pct.value}% (${pct.status})`);
  }'''
new_pct = '''  let pct = null;
  const k = String(kind || '').toLowerCase();
  if ((k === 'guild' || k === 'server') && e && e.guildPercentage && e.guildPercentage.status !== 'unknown') {
    pct = e.guildPercentage;
  } else if (k === 'user' && e && e.userPercentage && e.userPercentage.status !== 'unknown') {
    pct = e.userPercentage;
  } else if (e && e.guildPercentage && e.guildPercentage.status !== 'unknown') {
    pct = e.guildPercentage;
  } else if (e && e.userPercentage && e.userPercentage.status !== 'unknown') {
    pct = e.userPercentage;
  }
  if (pct && pct.value != null) {
    meta.push(`${pct.value}% (${pct.status})`);
  }'''
if old_pct in nty:
    nty = nty.replace(old_pct, new_pct)
    Path('src/lib/notify.js').write_text(nty)
    print('ok notify pct by kind')
elif 'Display percentage matching' in nty or 'const k = String(kind' in nty:
    print('skip notify pct')
else:
    raise SystemExit('MISSING notify pct')

print('ALL PATCHES APPLIED')
