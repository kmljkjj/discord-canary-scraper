/**
 * Guild / User experiment percentages with explicit provenance.
 * status: provided | calculated | unknown
 * Never invent a percentage when data is incomplete.
 */
'use strict';

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function clampPct(n) {
  if (!isFiniteNumber(n)) return null;
  if (n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

function normalizeStatusValue(status, value, extra) {
  const out = {
    status: status === 'provided' || status === 'calculated' ? status : 'unknown',
    value: status === 'unknown' ? null : clampPct(value),
  };
  if (out.status !== 'unknown' && out.value == null) {
    return { status: 'unknown', value: null };
  }
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null) out[k] = v;
    }
  }
  return out;
}

/**
 * Coerce a numeric percentage without inventing units.
 * - rate/fraction fields: 0..1 → *100
 * - percentage/percent/pct/rollout*: (0,1) exclusive → null (ambiguous)
 *   0 and 1 and 2..100 accepted as literal percent values
 */
function coerceProvidedNumber(n, { isRate } = {}) {
  if (!isFiniteNumber(n)) return null;
  if (isRate) {
    if (n >= 0 && n <= 1) return clampPct(n * 100);
    return clampPct(n);
  }
  if (n > 0 && n < 1) return null;
  return clampPct(n);
}

function readProvidedPercentage(obj) {
  if (!obj || typeof obj !== 'object') return null;

  for (const c of [obj.rate, obj.fraction]) {
    if (isFiniteNumber(c)) {
      const v = coerceProvidedNumber(c, { isRate: true });
      if (v != null) return v;
    } else if (typeof c === 'string' && c.trim() !== '' && !Number.isNaN(Number(c))) {
      const v = coerceProvidedNumber(Number(c), { isRate: true });
      if (v != null) return v;
    }
  }

  for (const c of [
    obj.percentage,
    obj.percent,
    obj.rollout,
    obj.rolloutPercentage,
    obj.pct,
  ]) {
    if (isFiniteNumber(c)) {
      const v = coerceProvidedNumber(c, { isRate: false });
      if (v != null) return v;
    } else if (typeof c === 'string' && c.trim() !== '' && !Number.isNaN(Number(c))) {
      const v = coerceProvidedNumber(Number(c), { isRate: false });
      if (v != null) return v;
    }
  }
  return null;
}

function calculateFromRanges(variations) {
  if (!variations || typeof variations !== 'object') return null;
  const entries = Object.values(variations);
  if (!entries.length) return null;

  const ranges = [];
  for (const v of entries) {
    if (!v || typeof v !== 'object') return null;
    const start = v.start ?? v.min ?? v.from ?? v.low;
    const end = v.end ?? v.max ?? v.to ?? v.high;
    if (!isFiniteNumber(start) || !isFiniteNumber(end) || end < start) return null;
    ranges.push([start, end]);
  }

  const maxEnd = Math.max(...ranges.map((r) => r[1]));
  const scale = maxEnd <= 100 ? 100 : maxEnd <= 10000 ? 10000 : null;
  if (!scale) return null;

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of ranges) {
    if (!merged.length || s > merged[merged.length - 1][1]) {
      merged.push([s, e]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    }
  }

  let covered = 0;
  for (const [s, e] of merged) {
    const a = Math.max(0, Math.min(scale, s));
    const b = Math.max(0, Math.min(scale, e));
    if (b > a) covered += b - a;
  }
  if (covered <= 0) return null;
  return clampPct((covered / scale) * 100);
}

function calculateFromPopulations(variations) {
  if (!variations || typeof variations !== 'object') return null;
  const entries = Object.values(variations);
  if (!entries.length) return null;

  let enabledSum = 0;
  let totalSum = 0;
  for (const v of entries) {
    if (!v || typeof v !== 'object') return null;
    const enabled = v.enabled ?? v.population ?? v.count;
    const total = v.total ?? v.populationTotal ?? v.size;
    if (!isFiniteNumber(enabled) || !isFiniteNumber(total) || total <= 0) return null;
    if (enabled < 0 || enabled > total) return null;
    enabledSum += enabled;
    totalSum += total;
  }
  if (totalSum <= 0) return null;
  return clampPct((enabledSum / totalSum) * 100);
}

function readRootProvided(experiment) {
  if (!experiment || typeof experiment !== 'object') return null;
  const fromRoot = readProvidedPercentage(experiment);
  if (fromRoot != null) return fromRoot;
  if (experiment.defaultConfig) {
    const fromCfg = readProvidedPercentage(experiment.defaultConfig);
    if (fromCfg != null) return fromCfg;
  }
  const vars = experiment.variations || experiment.treatments;
  if (vars && typeof vars === 'object') {
    const values = [];
    for (const v of Object.values(vars)) {
      const p = readProvidedPercentage(v);
      if (p != null) values.push(p);
    }
    if (values.length && values.every((x) => x === values[0])) return values[0];
    if (values.length === 1) return values[0];
  }
  return null;
}

function computeAudiencePercentage(experiment, audience) {
  const kind = String(experiment?.kind || experiment?.type || '').toLowerCase();
  // Strict audience isolation: never attribute a % to the wrong kind
  if (audience === 'guild' && kind && kind !== 'guild' && kind !== 'server') {
    return normalizeStatusValue('unknown', null);
  }
  if (audience === 'user' && kind && kind !== 'user') {
    return normalizeStatusValue('unknown', null);
  }

  // Nested audience payload first (guild.rollout / user.percentage, etc.)
  const nest =
    audience === 'guild'
      ? experiment?.guild || experiment?.server || null
      : audience === 'user'
        ? experiment?.user || null
        : null;
  if (nest && typeof nest === 'object') {
    const nested = readProvidedPercentage(nest);
    if (nested != null) {
      return normalizeStatusValue('provided', nested, { source: 'audience_nested' });
    }
  }

  const provided = readRootProvided(experiment);
  if (provided != null) {
    return normalizeStatusValue('provided', provided, { source: 'payload' });
  }

  // Calculated only when kind matches the requested audience (or kind unknown)
  const vars = experiment?.variations || experiment?.treatments;
  const fromPop = calculateFromPopulations(vars);
  if (fromPop != null) {
    return normalizeStatusValue('calculated', fromPop, {
      source: 'variation_populations',
    });
  }

  const fromRanges = calculateFromRanges(vars);
  if (fromRanges != null) {
    return normalizeStatusValue('calculated', fromRanges, {
      source: 'bucket_ranges',
    });
  }

  return normalizeStatusValue('unknown', null);
}

function attachPercentages(experiment) {
  if (!experiment || typeof experiment !== 'object') return experiment;
  return {
    ...experiment,
    guildPercentage: computeAudiencePercentage(experiment, 'guild'),
    userPercentage: computeAudiencePercentage(experiment, 'user'),
  };
}

module.exports = {
  isFiniteNumber,
  clampPct,
  readProvidedPercentage,
  coerceProvidedNumber,
  calculateFromRanges,
  calculateFromPopulations,
  computeAudiencePercentage,
  attachPercentages,
};
