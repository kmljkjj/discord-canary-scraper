/**
 * Guild experiment wire decoder (Datamining)
 * Parses Discord /experiments guild_experiments tuples + named filters.
 * Hash→id via murmur3 against local experiment definitions.
 */
'use strict';

const { murmur3 } = require('./murmur3');

const SCALE = 10000;

/** Discord filter type hashes → human labels */
const FILTER_TYPES = {
  2294888943: 'guild_in_range_by_hash',
  4148745523: 'guild_hub_types',
  188952590: 'guild_has_vanity_url',
  1604612045: 'guild_has_feature',
  3013771838: 'guild_ids',
  2404720969: 'guild_id_range',
  3730341874: 'guild_age_range_days',
  2918402255: 'guild_member_count_range',
};

const DATA_KEYS = {
  2690752156: 'hash_key',
  1982804121: 'target',
  4148745523: 'guild_features',
  1183251248: 'guild_features',
  3013771838: 'guild_ids',
  3399957344: 'min_id',
  1238858341: 'max_id',
};

function intervalsToPct(intervals) {
  if (!intervals || !intervals.length) return 0;
  let c = 0;
  for (const r of intervals) {
    const a = Number(r.start ?? r.s ?? r[0]);
    const b = Number(r.end ?? r.e ?? r[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) c += b - a;
  }
  return Math.min(100, Math.round((c / SCALE) * 10000) / 100);
}

function parsePopulation(population) {
  if (!Array.isArray(population)) return { buckets: {}, filters: [], treatments: [] };
  const buckets = {};
  const treatments = [];
  const positions = population[0] || [];
  for (const bucket of positions) {
    if (!Array.isArray(bucket)) continue;
    const id = bucket[0];
    const ranges = (bucket[1] || []).map((r) => {
      if (Array.isArray(r)) return { start: Number(r[0]), end: Number(r[1]) };
      return { start: Number(r.s ?? r.start), end: Number(r.e ?? r.end) };
    });
    const key = String(id);
    buckets[key] = { rollout: ranges };
    const pct = intervalsToPct(ranges);
    const label =
      id === -1 ? 'None' : id === 0 ? 'Control' : 'Treatment ' + id;
    treatments.push({
      bucket: id,
      label,
      pct,
      ranges: ranges.map((r) => r.start + ' – ' + r.end).join(', '),
    });
  }
  treatments.sort((a, b) => (a.bucket ?? 9999) - (b.bucket ?? 9999));

  const filters = [];
  for (const filter of population[1] || []) {
    if (!Array.isArray(filter)) continue;
    const typeId = filter[0];
    const typeName = FILTER_TYPES[typeId] || FILTER_TYPES[String(typeId)] || 'unknown_filter';
    const entry = { type: typeName };
    for (const data of filter[1] || []) {
      if (!Array.isArray(data)) continue;
      const key = DATA_KEYS[data[0]] || DATA_KEYS[String(data[0])] || 'data_' + data[0];
      entry[key] = data[1];
    }
    const flat = JSON.stringify(filter[1] || []);
    const platforms = [
      ...flat.matchAll(/"(android|ios|desktop|web)"/gi),
    ].map((m) => m[1].toLowerCase());
    if (platforms.length) {
      entry.platforms = [...new Set(platforms)];
      entry.summary =
        'Platform must be one of these: ' + entry.platforms.join(', ');
    } else if (entry.guild_features) {
      entry.summary =
        'Feature: ' +
        (Array.isArray(entry.guild_features)
          ? entry.guild_features.join(', ')
          : entry.guild_features);
    } else if (entry.min_id != null || entry.max_id != null) {
      entry.summary =
        'ID range ' + (entry.min_id ?? '?') + ' – ' + (entry.max_id ?? '?');
    } else if (entry.guild_ids) {
      entry.summary =
        'Guild IDs: ' +
        (Array.isArray(entry.guild_ids)
          ? entry.guild_ids.slice(0, 5).join(', ')
          : entry.guild_ids);
    } else {
      entry.summary = typeName;
    }
    filters.push(entry);
  }

  return { buckets, filters, treatments };
}

function decodeGuildExperiment(tuple, hashMap) {
  if (!Array.isArray(tuple) || tuple.length < 4) return null;
  const hash = tuple[0];
  const key = tuple[1];
  const revision = tuple[2];
  const populationsRaw = tuple[3] || [];
  const overridesArr = tuple[4] || [];
  const overridesFormattedRaw = tuple[5];

  let id =
    (typeof key === 'string' && key.trim() && key) ||
    (hashMap && (hashMap.get(Number(hash)) || hashMap.get(String(hash)))) ||
    null;

  const populations = populationsRaw.map(parsePopulation);
  const overridesFormatted = Array.isArray(overridesFormattedRaw)
    ? overridesFormattedRaw.flat().map(parsePopulation)
    : [];

  const overrides = {};
  for (const o of overridesArr) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      overrides[o.b] = o.k;
    } else if (Array.isArray(o)) {
      overrides[o[0]] = o[1];
    }
  }

  const byBucket = new Map();
  for (const pop of populations) {
    for (const t of pop.treatments || []) {
      if (!byBucket.has(t.bucket)) {
        byBucket.set(t.bucket, {
          bucket: t.bucket,
          label: t.label,
          intervals: [],
        });
      }
      const b = byBucket.get(t.bucket);
      for (const r of (pop.buckets[String(t.bucket)] || {}).rollout || []) {
        b.intervals.push(r);
      }
    }
  }
  const treatments = [...byBucket.values()].map((t) => ({
    bucket: t.bucket,
    label: t.label,
    pct: intervalsToPct(t.intervals),
  }));

  const filterSummary = populations
    .map((p) => (p.filters || []).map((f) => f.summary).filter(Boolean).join(' · '))
    .filter(Boolean)
    .join(' | ');

  const ovCount = Object.values(overrides).reduce(
    (n, v) => n + (Array.isArray(v) ? v.length : 0),
    0,
  );

  // % only — filter ID ranges change often and caused false "changed" spam
  const fingerprint =
    treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(1)).join(',') +
    '|ov:' +
    ovCount +
    '|rev:' +
    revision;

  const idStr = id ? String(id) : 'hash:' + hash;
  const title = humanizeId(idStr);

  return {
    id: idStr,
    hash: Number(hash),
    revision,
    type: 'guild',
    title,
    treatments,
    populations,
    overrides,
    overridesFormatted,
    overrideIdCount: ovCount,
    populationCount: populations.length,
    filterSummary,
    fingerprint,
    recent: isRecent(idStr),
    source: 'discord',
  };
}

function isRecent(id, yearMin = 2024) {
  const m = String(id).match(/^(20\d{2})/);
  return m ? Number(m[1]) >= yearMin : false;
}

function humanizeId(id) {
  const s = String(id || '');
  if (s.startsWith('hash:')) return s;
  return (
    s
      .replace(/^(20\d{2})[-_]/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || s
  );
}

function buildHashMapFromIds(ids) {
  const map = new Map();
  for (const id of ids || []) {
    if (!id || typeof id !== 'string' || id.startsWith('hash:')) continue;
    const h = murmur3(id);
    map.set(h, id);
    map.set(String(h), id);
  }
  return map;
}

module.exports = {
  murmur3,
  decodeGuildExperiment,
  parsePopulation,
  intervalsToPct,
  buildHashMapFromIds,
  FILTER_TYPES,
};
