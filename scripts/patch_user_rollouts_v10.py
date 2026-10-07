#!/usr/bin/env python3
"""Apply user_rollouts v10 improvements on top of v9 source."""
from pathlib import Path
import urllib.request

LOCAL = Path("src/user_rollouts.js")
if LOCAL.exists() and LOCAL.stat().st_size > 1000 and b"PLACEHOLDER" not in LOCAL.read_bytes()[:200]:
    src = LOCAL.read_text()
    print("using local", len(src))
else:
    url = "https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@def3baf9e8cfe14c8fe0cbc407c755ee35f51fc0/src/user_rollouts.js"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    src = urllib.request.urlopen(req, timeout=30).read().decode()
    print("fetched v9", len(src))

if "formatFilter" in src and "filterSummary" in src and "version: 10" in src:
    print("already v10")
    raise SystemExit(0)

old_h = """ * User experiment rollouts v9 — EXACT percentages from bucket ranges.
 *
 * Key changes vs v8:
 *  - Fetches experiment definitions from experiments.dscrd.workers.dev
 *    which returns rollout populations with bucket ranges (start/end)
 *  - Calculates EXACT percentages from bucket ranges instead of
 *    estimating from hash_result spread (which was unreliable)
 *  - Fingerprint sampling still used to detect active experiments
 *  - Falls back to estimation only if no bucket ranges are available
 *  - More recent experiment definitions (fresh from the worker API)"""
new_h = """ * User experiment rollouts v10 — EXACT percentages + filter-aware segments.
 *
 * Key changes vs v9:
 *  - Populations filtrées (feature, member_count, range_by_hash, id, hub_type)
 *    analysées et affichées à part (snippet Apex Research / Comunidade Escoteiros)
 *  - % globaux (sans filtres) restent la source principale des notifs
 *  - Embeds enrichis : scope global/filtré + résumé des filtres
 *  - Fingerprint sampling + fallback estimation inchangés"""
if old_h in src:
    src = src.replace(old_h, new_h, 1)
    print("header ok")
else:
    print("WARN header")

marker = "function calculateBucketPercentages(def) {"
idx = src.find(marker)
if idx < 0:
    raise SystemExit("calc not found")
doc = src.rfind("/**", 0, idx)
if doc < 0 or idx - doc > 800:
    doc = idx
end = src.find("\nfunction buildTreatments", idx)
if end < 0:
    raise SystemExit("buildTreatments not found")

new_block = r'''
/**
 * Human-readable label for a single population filter.
 */
function formatFilter(f) {
  if (!f || typeof f !== 'object') return null;
  const t = String(f.type || '').toLowerCase();
  if (t === 'feature') {
    const feats = f.features || f.feature || [];
    const list = Array.isArray(feats) ? feats : [feats];
    return 'feature:' + list.slice(0, 3).join(',');
  }
  if (t === 'member_count') {
    const r = f.range || {};
    return 'members:' + (r.start != null ? r.start : '?') + '-' + (r.end != null ? r.end : '?');
  }
  if (t === 'range_by_hash') return 'hash_range:' + (f.range != null ? f.range : '?');
  if (t === 'id') {
    const ids = f.ids || [];
    return 'ids:' + (Array.isArray(ids) ? ids.length : 0);
  }
  if (t === 'hub_type') return 'hub_type';
  if (t === 'country_code' || t === 'country') {
    const codes = f.country_codes || f.countries || f.values || [];
    const list = Array.isArray(codes) ? codes : [codes];
    return 'country:' + list.slice(0, 6).join(',');
  }
  if (t === 'user_flag') return 'user_flag';
  if (t === 'experiment_enabled') return 'exp_enabled:' + (f.id || '');
  if (t === 'client_version' || t === 'min_build' || t === 'build_number') {
    return 'client:' + JSON.stringify(f.range || f.min || f.max || f).slice(0, 40);
  }
  if (t === 'os' || t === 'platform') {
    return t + ':' + String(f.value || f.os || f.platform || '').slice(0, 20);
  }
  return t || 'filter';
}

function summarizeFilters(filters) {
  if (!filters || !filters.length) return 'global';
  return filters.map(formatFilter).filter(Boolean).slice(0, 4).join(' · ') || 'filtered';
}

function accumulateBucketRanges(result, positions) {
  for (const pos of positions || []) {
    const bucket = Number(pos.bucket);
    if (!Number.isFinite(bucket)) continue;
    const rollouts = pos.rollouts || [];
    const ranges = rollouts
      .map((r) => [Number(r.start), Number(r.end)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (!ranges.length) continue;
    const merged = mergeIntervals(ranges);
    const covered = intervalsCoverage(merged, SCALE);
    const pct = coveragePercent(merged, SCALE);
    if (!result.has(bucket)) {
      result.set(bucket, { percentage: pct, ranges: merged, coverage: covered, sampleCount: 0 });
    } else {
      const existing = result.get(bucket);
      const allRanges = [...(existing.ranges || []), ...merged];
      const mergedAll = mergeIntervals(allRanges);
      existing.ranges = mergedAll;
      existing.coverage = intervalsCoverage(mergedAll, SCALE);
      existing.percentage = coveragePercent(mergedAll, SCALE);
    }
  }
}

/**
 * Prefer global populations for main %; keep filtered segments for display.
 */
function calculateBucketPercentages(def) {
  const empty = { buckets: new Map(), segments: [], hasFilters: false, filterSummary: 'global', usedFallbackFiltered: false };
  if (!def || !def.populations || !def.populations.length) return empty;
  const globalPops = [];
  const filteredPops = [];
  for (const pop of def.populations) {
    if (!pop.filters || pop.filters.length === 0) globalPops.push(pop);
    else filteredPops.push(pop);
  }
  const buckets = new Map();
  let usedFallbackFiltered = false;
  if (globalPops.length) {
    for (const pop of globalPops) accumulateBucketRanges(buckets, pop.position);
  } else if (filteredPops.length) {
    usedFallbackFiltered = true;
    for (const pop of filteredPops) accumulateBucketRanges(buckets, pop.position);
  }
  const segments = [];
  for (const pop of filteredPops) {
    const segBuckets = new Map();
    accumulateBucketRanges(segBuckets, pop.position);
    if (!segBuckets.size) continue;
    const treatments = [...segBuckets.entries()]
      .map(([bucket, info]) => ({ bucket: Number(bucket), label: tLabel(bucket), percentage: info.percentage, pct: info.percentage, ranges: info.ranges }))
      .sort((a, b) => a.bucket - b.bucket);
    segments.push({ filters: pop.filters, filterLabel: summarizeFilters(pop.filters), treatments });
  }
  const filterLabels = segments.map((s) => s.filterLabel);
  const hasFilters = segments.length > 0;
  let filterSummary = 'global';
  if (usedFallbackFiltered) filterSummary = 'filtered-only · ' + (filterLabels[0] || 'filtered');
  else if (hasFilters) filterSummary = 'global + ' + filterLabels.slice(0, 2).join(' | ');
  return { buckets, segments, hasFilters, filterSummary, usedFallbackFiltered };
}
'''

src = src[:doc] + new_block + src[end:]
print("calc replaced")

src = src.replace(
    "function buildTreatments(def, bucketMap, totalOk) {\n  const exactPcts = calculateBucketPercentages(def);",
    "function buildTreatments(def, bucketMap, totalOk) {\n  const calc = calculateBucketPercentages(def);\n  const exactPcts = calc.buckets || new Map();",
    1,
)
src = src.replace(
    "        sourceKind: 'exact_from_bucket_ranges',\n      });\n    }\n  } else if (totalOk >= MIN_OK) {",
    "        sourceKind: 'exact_from_bucket_ranges',\n        scope: calc.usedFallbackFiltered ? 'filtered' : 'global',\n      });\n    }\n  } else if (totalOk >= MIN_OK) {",
    1,
)
src = src.replace(
    """  return {
    treatments,
    conf,
    status: globalStatus,
    coverage: Math.round((Math.min(coveredAll, SCALE) / SCALE) * 1000) / 1000,
    sumPct: Math.round(sumPct * 100) / 100,
  };
}""",
    """  return {
    treatments,
    conf,
    status: globalStatus,
    coverage: Math.round((Math.min(coveredAll, SCALE) / SCALE) * 1000) / 1000,
    sumPct: Math.round(sumPct * 100) / 100,
    segments: calc.segments || [],
    hasFilters: !!calc.hasFilters,
    filterSummary: calc.filterSummary || 'global',
    usedFallbackFiltered: !!calc.usedFallbackFiltered,
  };
}""",
    1,
)
print("buildTreatments ok")

old_main = "    const exactPcts = calculateBucketPercentages(def);"
if old_main in src:
    src = src.replace(old_main, "    const calc = calculateBucketPercentages(def);\n    const exactPcts = calc.buckets || new Map();", 1)
    print("main calc ok")

needle = "      source: 'worker_api',\n      named: hasName(def.id),\n    });"
repl = """      source: 'worker_api',
      named: hasName(def.id),
      segments: calc.segments || [],
      hasFilters: !!calc.hasFilters,
      filterSummary: calc.filterSummary || 'global',
      usedFallbackFiltered: !!calc.usedFallbackFiltered,
    });"""
if needle in src:
    src = src.replace(needle, repl, 1)
    print("worker push meta ok")

src = src.replace("version: 9,", "version: 10,", 1)
src = src.replace("schemaVersion: 9,", "schemaVersion: 10,", 1)

LOCAL.write_text(src)
print("wrote", len(src))
