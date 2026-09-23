/**
 * Experiment state: current vs known vs removed.
 * - current: last validated extract snapshot (full objects)
 * - known: ids seen at least once (append-only)
 * - removed: confirmed disappearances when coverage is reliable
 * - diffExperiments: unique source for added/removed/modified/category_changed
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./atomic');

const CURRENT_FILE = 'current_experiments.json';
const KNOWN_FILE = 'known_experiment_ids.json';
const REMOVED_FILE = 'removed_experiments.json';

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, k) => {
        out[k] = stableObject(value[k]);
        return out;
      }, {});
  }
  return value;
}

function normalizeKind(raw) {
  const t = String(raw.type || raw.kind || '').toLowerCase();
  if (t === 'guild' || t === 'server') return 'guild';
  if (t === 'user') return 'user';
  if (t === 'developer' || t === 'dev') return 'developer';
  if (t === 'marketing') return 'marketing';
  return t || 'unknown';
}

function createExperimentFingerprint(exp) {
  const payload = stableObject({
    id: String(exp.id || ''),
    kind: exp.kind || exp.type || null,
    system: exp.system || null,
    label: exp.label || exp.title || null,
    variations: exp.variations || null,
    treatments: exp.treatments || null,
    defaultConfig: exp.defaultConfig || null,
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalizeExperiment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.experiment_id || raw.name || '').trim();
  if (!id || id.startsWith('hash:')) return null;
  const kind = normalizeKind(raw);
  const label = raw.label || raw.title || null;
  const system = raw.system || null;
  const variations = raw.variations || raw.treatments || null;
  const base = {
    id,
    kind,
    type: kind,
    system,
    label,
    title: raw.title || label,
    description: raw.description || null,
    defaultConfig: raw.defaultConfig || null,
    variations,
    treatments: raw.treatments || null,
    variationCount:
      raw.variationCount ||
      (variations && typeof variations === 'object'
        ? Object.keys(variations).length
        : 0) ||
      0,
  };
  base.fingerprint = createExperimentFingerprint(base);
  return base;
}

function assessCoverage({ currentCount, previousCount, extractionStatus }) {
  if (
    extractionStatus &&
    extractionStatus !== 'complete' &&
    extractionStatus !== 'ok'
  ) {
    return { reliable: false, reason: 'extraction_not_complete', ratio: 0 };
  }
  if (previousCount <= 0) {
    return {
      reliable: currentCount > 0,
      reason: currentCount > 0 ? 'bootstrap' : 'empty',
      ratio: currentCount > 0 ? 1 : 0,
    };
  }
  const ratio = currentCount / previousCount;
  const minRatio = Number(process.env.EXP_COVERAGE_MIN_RATIO || 0.8);
  const maxRatio = Number(process.env.EXP_COVERAGE_MAX_RATIO || 1.25);
  const reliable = ratio >= minRatio && ratio <= maxRatio;
  return {
    reliable,
    reason: reliable ? 'ok' : 'coverage_out_of_range',
    ratio,
    minRatio,
    maxRatio,
  };
}

/**
 * Single source of truth for experiment deltas.
 * category_changed is exclusive of modified.
 */
function diffExperiments(previousList, currentList, allowRemovals, opts = {}) {
  const previous = (Array.isArray(previousList) ? previousList : [])
    .map((e) => (e && e.fingerprint ? e : normalizeExperiment(e)))
    .filter(Boolean);
  const current = (Array.isArray(currentList) ? currentList : [])
    .map((e) => (e && e.fingerprint ? e : normalizeExperiment(e)))
    .filter(Boolean);

  const previousById = new Map(previous.map((e) => [String(e.id), e]));
  const currentById = new Map(current.map((e) => [String(e.id), e]));

  const known =
    opts.knownIds instanceof Set
      ? opts.knownIds
      : new Set((opts.knownIds || []).map(String));
  const filterKnown = known.size > 0 || opts.knownIds != null;

  const added = [];
  const removed = [];
  const modified = [];
  const categoryChanged = [];

  for (const [id, cur] of currentById) {
    const prev = previousById.get(id);
    if (!prev) {
      if (filterKnown && known.has(id)) continue;
      added.push(cur);
      continue;
    }

    const prevKind = String(prev.kind || prev.type || '').toLowerCase() || null;
    const curKind = String(cur.kind || cur.type || '').toLowerCase() || null;

    if (prevKind && curKind && prevKind !== curKind) {
      categoryChanged.push({
        before: prev,
        after: cur,
        from: prevKind,
        to: curKind,
      });
      continue;
    }

    const prevFp = prev.fingerprint || prev.fp;
    const curFp = cur.fingerprint || cur.fp;
    if (prevFp && curFp) {
      if (prevFp !== curFp) {
        modified.push({ before: prev, after: cur });
      }
      continue;
    }

    const prevKeys = Object.keys(prev.variations || {}).sort().join(',');
    const curKeys = Object.keys(cur.variations || {}).sort().join(',');
    if (prevKeys && curKeys && prevKeys !== curKeys) {
      modified.push({ before: prev, after: cur });
      continue;
    }
    const pl = (prev.label || '').trim();
    const cl = (cur.label || '').trim();
    if (pl && cl && pl !== cl) {
      modified.push({ before: prev, after: cur });
    }
  }

  if (allowRemovals) {
    for (const [id, prev] of previousById) {
      if (!currentById.has(id)) removed.push(prev);
    }
  }

  const maxAdded = opts.maxAdded != null ? opts.maxAdded : Infinity;
  const maxModified = opts.maxModified != null ? opts.maxModified : Infinity;
  const maxRemoved = opts.maxRemoved != null ? opts.maxRemoved : Infinity;
  const maxCat = opts.maxCategoryChanged != null ? opts.maxCategoryChanged : Infinity;

  return {
    added: added.slice(0, maxAdded),
    removed:
      removed.length > maxRemoved && maxRemoved < Infinity
        ? []
        : removed.slice(0, maxRemoved),
    modified: modified.slice(0, maxModified),
    categoryChanged: categoryChanged.slice(0, maxCat),
  };
}

/** Flatten for Discord notify (expects objects with id). */
function toNotifyExpDiff(diff) {
  const d = diff || {};
  return {
    added: d.added || [],
    modified: (d.modified || []).map((row) => {
      if (row && row.after) {
        return {
          ...row.after,
          _prevKeys: Object.keys((row.before && row.before.variations) || {})
            .sort()
            .join(','),
          _nextKeys: Object.keys((row.after && row.after.variations) || {})
            .sort()
            .join(','),
        };
      }
      return row;
    }),
    removed: (d.removed || []).map((e) =>
      e && e.id != null ? { id: String(e.id), kind: e.kind || e.type || null } : e,
    ),
    categoryChanged: (d.categoryChanged || []).map((row) => ({
      id: String(row.after?.id || row.before?.id || ''),
      kind: row.after?.kind || row.to,
      type: row.after?.kind || row.to,
      label: row.after?.label || null,
      from: row.from || row.before?.kind,
      to: row.to || row.after?.kind,
      before: row.before || null,
      after: row.after || null,
    })),
  };
}

async function loadCurrentExperiments(dataDir) {
  const file = path.join(dataDir, CURRENT_FILE);
  try {
    if (!(await fs.pathExists(file))) return [];
    const d = await fs.readJson(file);
    const list = Array.isArray(d) ? d : d.experiments || [];
    return list.map(normalizeExperiment).filter(Boolean);
  } catch {
    return [];
  }
}

async function loadRemovedExperiments(dataDir) {
  const file = path.join(dataDir, REMOVED_FILE);
  try {
    if (!(await fs.pathExists(file))) return [];
    const d = await fs.readJson(file);
    return Array.isArray(d) ? d : d.experiments || d.removed || [];
  } catch {
    return [];
  }
}

function mergeKnownIds(previousIds, currentExperiments) {
  const set = new Set((previousIds || []).map(String));
  for (const e of currentExperiments || []) {
    if (e && e.id) set.add(String(e.id));
  }
  return [...set].sort();
}

function updateRemovedExperiments({
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
}

async function writeExperimentState(dataDir, { current, knownIds, removed, buildNumber }) {
  const stamp = {
    updatedAt: new Date().toISOString(),
    buildNumber: buildNumber != null ? String(buildNumber) : null,
  };
  await writeJsonAtomic(path.join(dataDir, CURRENT_FILE), {
    ...stamp,
    count: (current || []).length,
    experiments: current || [],
  });
  await writeJsonAtomic(path.join(dataDir, KNOWN_FILE), {
    ...stamp,
    count: (knownIds || []).length,
    ids: knownIds || [],
  });
  await writeJsonAtomic(path.join(dataDir, REMOVED_FILE), {
    ...stamp,
    count: (removed || []).length,
    experiments: removed || [],
  });
}

module.exports = {
  CURRENT_FILE,
  KNOWN_FILE,
  REMOVED_FILE,
  normalizeExperiment,
  createExperimentFingerprint,
  assessCoverage,
  diffExperiments,
  toNotifyExpDiff,
  loadCurrentExperiments,
  loadRemovedExperiments,
  mergeKnownIds,
  updateRemovedExperiments,
  writeExperimentState,
  stableObject,
};
