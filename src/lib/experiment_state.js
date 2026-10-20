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
const { attachPercentages } = require('./experiment_percentages');

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

function variationKeysOnly(exp) {
  if (!exp || typeof exp !== 'object') return [];
  if (exp.variations && typeof exp.variations === 'object' && !Array.isArray(exp.variations)) {
    return Object.keys(exp.variations)
      .map(String)
      .sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)));
  }
  if (Array.isArray(exp.treatments)) {
    return exp.treatments.map((_, i) => String(i));
  }
  const n = Number(exp.variationCount || 0);
  if (Number.isFinite(n) && n > 0) {
    return Array.from({ length: n }, (_, i) => String(i));
  }
  return [];
}

/**
 * STRUCTURAL fingerprint only — never hash full variation bodies / defaultConfig.
 * Deep object noise between builds was producing ~20 false "modified" every scrape.
 */
function createExperimentFingerprint(exp) {
  const keys = variationKeysOnly(exp);
  const pctVal = (p) => {
    if (!p || p.status === 'unknown' || p.value == null) return null;
    const n = Number(p.value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  };
  const payload = stableObject({
    id: String(exp.id || ''),
    kind: String(exp.kind || exp.type || '').toLowerCase() || null,
    label: (exp.label || exp.title || null) && String(exp.label || exp.title).trim() || null,
    keys,
    variationCount: keys.length,
    guildPct: pctVal(exp.guildPercentage),
    userPct: pctVal(exp.userPercentage),
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Modification = structure only (keys, kind, system, label, percentages).
 * Deep variation/defaultConfig bodies are build noise — intentionally ignored.
 */
function isMeaningfulModification(prev, cur) {
  if (!prev || !cur) return false;
  const prevKeys = variationKeysOnly(prev).join(',');
  const curKeys = variationKeysOnly(cur).join(',');
  if (prevKeys !== curKeys) return true;
  const pk = String(prev.kind || prev.type || '').toLowerCase();
  const ck = String(cur.kind || cur.type || '').toLowerCase();
  if (pk && ck && pk !== ck) return true;
  const ps = String(prev.system || '').toLowerCase();
  const cs = String(cur.system || '').toLowerCase();
  if (ps && cs && ps !== cs) return true;
  const pl = (prev.label || prev.title || '').trim();
  const cl = (cur.label || cur.title || '').trim();
  if (pl !== cl && (pl || cl)) return true;
  const num = (p) => {
    if (!p || p.status === 'unknown' || p.value == null) return null;
    const n = Number(p.value);
    return Number.isFinite(n) ? n : null;
  };
  const pg = num(prev.guildPercentage);
  const cg = num(cur.guildPercentage);
  if (pg != null && cg != null && Math.abs(pg - cg) >= 0.5) return true;
  const pu = num(prev.userPercentage);
  const cu = num(cur.userPercentage);
  if (pu != null && cu != null && Math.abs(pu - cu) >= 0.5) return true;
  return false;
}

function normalizeExperiment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.experiment_id || raw.name || '').trim();
  if (!id || id.startsWith('hash:')) return null;
  const kind = normalizeKind(raw);
  const label = raw.label || raw.title || null;
  const system = raw.system || null;
  let variationSource = null;
  let variations = null;
  let treatments = null;
  if (raw.variations && typeof raw.variations === 'object' && !Array.isArray(raw.variations)) {
    variations = raw.variations;
    variationSource = 'variations';
  } else if (Array.isArray(raw.treatments)) {
    treatments = raw.treatments;
    variations = raw.treatments; // legacy consumers still read variations
    variationSource = 'treatments';
  } else if (raw.variations != null) {
    variations = raw.variations;
    variationSource = 'variations';
  }
  const keys = variationKeysOnly({ variations, treatments, variationCount: raw.variationCount });
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
    treatments: treatments || raw.treatments || null,
    variationSource,
    variationCount: keys.length || Number(raw.variationCount) || 0,
    percentage: raw.percentage,
    percent: raw.percent,
    rate: raw.rate,
    rollout: raw.rollout,
    rolloutPercentage: raw.rolloutPercentage,
    pct: raw.pct,
    // Preserve unknown fields for datamine / future normalizers
    raw: { ...raw },
  };
  const withPct = attachPercentages(base);
  withPct.fingerprint = createExperimentFingerprint(withPct);
  return withPct;
}

/**
 * Multi-signal coverage gate.
 * Count ratio alone is insufficient (can hide ID churn at same size).
 */
function assessCoverage({
  currentCount,
  previousCount,
  extractionStatus,
  currentIds,
  previousIds,
  chunksExpected,
  chunksRead,
  readErrors,
  parseErrors,
}) {
  if (
    extractionStatus &&
    extractionStatus !== 'complete' &&
    extractionStatus !== 'ok'
  ) {
    return {
      reliable: false,
      status: 'coverage_degraded',
      reason: 'extraction_not_complete',
      ratio: 0,
      retentionRatio: null,
      chunkRatio: null,
    };
  }
  if (previousCount <= 0) {
    return {
      reliable: currentCount > 0,
      status: currentCount > 0 ? 'coverage_reliable' : 'coverage_unknown',
      reason: currentCount > 0 ? 'bootstrap' : 'empty',
      ratio: currentCount > 0 ? 1 : 0,
      retentionRatio: null,
      chunkRatio: null,
    };
  }
  const ratio = currentCount / previousCount;
  const minRatio = Number(process.env.EXP_COVERAGE_MIN_RATIO || 0.8);
  const maxRatio = Number(process.env.EXP_COVERAGE_MAX_RATIO || 1.25);
  const minRetention = Number(process.env.EXP_COVERAGE_MIN_RETENTION || 0.75);

  let retentionRatio = null;
  if (Array.isArray(previousIds) && Array.isArray(currentIds)) {
    const cur = new Set(currentIds.map(String));
    const prev = previousIds.map(String).filter(Boolean);
    const retained = prev.filter((id) => cur.has(id)).length;
    retentionRatio = prev.length ? retained / prev.length : 1;
  }

  let chunkRatio = null;
  if (chunksExpected != null && Number(chunksExpected) > 0) {
    chunkRatio = Number(chunksRead || 0) / Number(chunksExpected);
  }

  const re = Number(readErrors || 0);
  const pe = Number(parseErrors || 0);

  const ratioOk = ratio >= minRatio && ratio <= maxRatio;
  const retentionOk = retentionRatio == null || retentionRatio >= minRetention;
  const chunkOk = chunkRatio == null || chunkRatio >= 0.9;
  const errorsOk = re === 0 && pe === 0;
  const reliable = ratioOk && retentionOk && chunkOk && errorsOk;

  let reason = 'ok';
  if (!ratioOk) reason = 'coverage_out_of_range';
  else if (!retentionOk) reason = 'retention_too_low';
  else if (!chunkOk) reason = 'chunk_coverage_low';
  else if (!errorsOk) reason = 'read_or_parse_errors';

  return {
    reliable,
    status: reliable ? 'coverage_reliable' : 'coverage_degraded',
    reason,
    ratio,
    retentionRatio,
    chunkRatio,
    readErrors: re,
    parseErrors: pe,
    minRatio,
    maxRatio,
    minRetention,
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

    // Meaningful structural change only (keys / kind / label / pct)
    if (isMeaningfulModification(prev, cur)) {
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

  const removedAll = removed;
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
          _before: row.before || null,
          _prevKeys: variationKeysOnly(row.before).join(','),
          _nextKeys: variationKeysOnly(row.after).join(','),
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
  isMeaningfulModification,
  variationKeysOnly,
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
