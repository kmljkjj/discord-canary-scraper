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

function readProvidedPercentage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.percentage,
    obj.percent,
    obj.rollout,
    obj.rolloutPercentage,
    obj.pct,
  ];
  for (const c of candidates) {
    if (isFiniteNumber(c)) {
      if (c >= 0 && c <= 1) return clampPct(c * 100);
      return clampPct(c);
    }
    if (typeof c === 'string' && c.trim() !== '' && !Number.isNaN(Number(c))) {
      const n = Number(c);
      if (n >= 0 && n <= 1) return clampPct(n * 100);
      return clampPct(n);
    }
  }
  if (isFiniteNumber(obj.rate)) {
    const r = obj.rate;
    if (r >= 0 && r <= 1) return clampPct(r * 100);
    return clampPct(r);
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
  for (const [s, e] of merged) covered += e - s;
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
  if (audience === 'guild' && kind && kind !== 'guild' && kind !== 'server') {
    return normalizeStatusValue('unknown', null);
  }
  if (audience === 'user' && kind && kind !== 'user') {
    return normalizeStatusValue('unknown', null);
  }

  const provided = readRootProvided(experiment);
  if (provided != null) {
    return normalizeStatusValue('provided', provided, { source: 'payload' });
  }

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
  calculateFromRanges,
  calculateFromPopulations,
  computeAudiencePercentage,
  attachPercentages,
  normalizeStatusValue,
};
