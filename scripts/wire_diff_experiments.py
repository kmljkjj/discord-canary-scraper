#!/usr/bin/env python3
import base64, re
from pathlib import Path

p = Path('src/index.js')
src = p.read_text()

new_fn = r'''function computeExpDiff(findingsExps, lastExp, knownExp, opts) {
  // Build next snapshots for last_extract persistence
  const nextExpSnap = {};
  const currentRaw = [];
  for (const e of findingsExps || []) {
    if (!e || !e.id || String(e.id).startsWith('hash:')) continue;
    const id = String(e.id);
    nextExpSnap[id] = expSnapshot(e);
    currentRaw.push(e);
  }

  const previousList = [];
  for (const [id, e] of Object.entries(lastExp || {})) {
    if (!e) continue;
    previousList.push(
      experimentState.normalizeExperiment({
        ...(typeof e === 'object' ? e : {}),
        id: (e && e.id) || id,
      }),
    );
  }
  const previous = previousList.filter(Boolean);
  const current = currentRaw
    .map((e) => experimentState.normalizeExperiment(e))
    .filter(Boolean);

  const lastExpCount = previous.length;
  const extractedExpCount = current.length;

  // Guard: not enough data for a reliable diff (same thresholds as before)
  if (extractedExpCount < MIN_EXP_FOR_DIFF || lastExpCount < 40) {
    return {
      expDiff: {
        added: [],
        modified: [],
        removed: [],
        categoryChanged: [],
      },
      nextExpSnap,
      coverage: experimentState.assessCoverage({
        currentCount: extractedExpCount,
        previousCount: lastExpCount,
        extractionStatus: 'incomplete',
      }),
    };
  }

  const coverage = experimentState.assessCoverage({
    currentCount: extractedExpCount,
    previousCount: lastExpCount,
    extractionStatus: 'complete',
  });

  // Unique source of truth
  const rawDiff = experimentState.diffExperiments(
    previous,
    current,
    coverage.reliable,
    {
      knownIds: knownExp,
      maxAdded: MAX_NOTIFY_EXP,
      maxModified: 20,
      maxRemoved: 15,
      maxCategoryChanged: 20,
    },
  );

  const expDiff = experimentState.toNotifyExpDiff(rawDiff);
  return { expDiff, nextExpSnap, coverage, rawDiff };
}'''

pat = re.compile(r'function computeExpDiff\([\s\S]*?(?=\nasync function main\()')
if not pat.search(src):
    raise SystemExit('computeExpDiff not found')
src2, n = pat.subn(new_fn + '\n\n', src, count=1)
if n != 1:
    raise SystemExit('replace count ' + str(n))

if 'categoryChanged: (expDiff.categoryChanged' not in src2:
    old_log = '      removed: expDiff.removed.length,\n    },'
    new_log = '      removed: expDiff.removed.length,\n      categoryChanged: (expDiff.categoryChanged || []).length,\n    },'
    if old_log not in src2:
        raise SystemExit('TRUE DIFF log block not found')
    src2 = src2.replace(old_log, new_log, 1)

if 'expDiff.categoryChanged = [];' not in src2:
    old_seed = '    expDiff.added = [];\n    expDiff.modified = [];\n    expDiff.removed = [];'
    new_seed = old_seed + '\n    expDiff.categoryChanged = [];'
    if old_seed not in src2:
        raise SystemExit('seed clear block not found')
    src2 = src2.replace(old_seed, new_seed, 1)

# notify.js patches
np = Path('src/lib/notify.js')
ns = np.read_text()
if 'categoryChanged' not in ns or 'Category ·' not in ns:
    ns = ns.replace(
        'exp.added.length + exp.modified.length + exp.removed.length',
        'exp.added.length + exp.modified.length + exp.removed.length + (exp.categoryChanged || []).length',
        1,
    )
    old_norm = '''  if (diff && (diff.added || diff.modified || diff.removed)) {
    return {
      added: Array.isArray(diff.added) ? diff.added : [],
      modified: Array.isArray(diff.modified) ? diff.modified : [],
      removed: Array.isArray(diff.removed) ? diff.removed : [],
    };
  }
  return { added: [], modified: [], removed: [] };
}'''
    new_norm = '''  if (diff && (diff.added || diff.modified || diff.removed || diff.categoryChanged)) {
    return {
      added: Array.isArray(diff.added) ? diff.added : [],
      modified: Array.isArray(diff.modified) ? diff.modified : [],
      removed: Array.isArray(diff.removed) ? diff.removed : [],
      categoryChanged: Array.isArray(diff.categoryChanged)
        ? diff.categoryChanged
        : [],
    };
  }
  return { added: [], modified: [], removed: [], categoryChanged: [] };
}'''
    if old_norm not in ns:
        raise SystemExit('normalizeExpDiff not found')
    ns = ns.replace(old_norm, new_norm, 1)
    old_rem = '''  if (exp.removed.length) {
    const lines = exp.removed.slice(0, 40).map((e) => {
      const id = typeof e === 'string' ? e : e.id;
      return `- ${id}`;
    });'''
    new_rem = '''  if ((exp.categoryChanged || []).length) {
    const lines = exp.categoryChanged.slice(0, 40).map((e) => {
      const id = e.id || '?';
      const from = e.from || '?';
      const to = e.to || e.kind || '?';
      return `~ ${id} · ${from} → ${to}`;
    });
    if (exp.categoryChanged.length > 40)
      lines.push(`… +${exp.categoryChanged.length - 40} more`);
    sections.push({
      label: label(E.modified, `Category · ${exp.categoryChanged.length}`),
      color: COLOR.modified,
      count: exp.categoryChanged.length,
      lines,
    });
  }
  if (exp.removed.length) {
    const lines = exp.removed.slice(0, 40).map((e) => {
      const id = typeof e === 'string' ? e : e.id;
      return `- ${id}`;
    });'''
    if old_rem not in ns:
        raise SystemExit('removed section not found')
    ns = ns.replace(old_rem, new_rem, 1)
    ns = ns.replace(
        'removed: exp.removed.length,',
        'removed: exp.removed.length,\n    categoryChanged: (exp.categoryChanged || []).length,',
        1,
    )
    np.write_text(ns)
    print('notify patched')
else:
    print('notify already has category')

p.write_text(src2)
print('index wired', p.stat().st_size)
