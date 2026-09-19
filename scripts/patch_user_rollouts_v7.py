#!/usr/bin/env python3
"""Upgrade user_rollouts rangesToTreatments to interval-union + status gates."""
from pathlib import Path

p = Path('src/user_rollouts.js')
src = p.read_text()
if 'mergeIntervals' in src and 'pointsToIntervals' in src:
    print('already v7')
    raise SystemExit(0)

old = '''function rangesToTreatments(bucketMap, totalOk) {
  const treatments = [];
  for (const [bucket, hrs] of bucketMap) {
    if (!hrs || !hrs.length) continue;
    const min = Math.min(...hrs);
    const max = Math.max(...hrs);
    const span = Math.max(0, max - min);
    let pct = span > 0 ? Math.round((span / SCALE) * 10000) / 100 : null;
    if (bucketMap.size === 1 && hrs.length >= 8 && max - min > 8000) {
      pct = 100;
    }
    treatments.push({
      bucket: Number(bucket),
      label: tLabel(bucket),
      pct: pct == null ? 0 : Math.min(100, pct),
      pctKnown: pct != null && hrs.length >= 3,
      observed: [min, max],
      samples: hrs.length,
    });
  }

  treatments.sort((a, b) => a.bucket - b.bucket);
  const conf =
    totalOk > 0
      ? Math.min(
          1,
          treatments.reduce((s, t) => s + t.samples, 0) / (totalOk * Math.max(1, treatments.length)),
        )
      : 0;
  return { treatments, conf };
}'''

new = r'''function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = intervals
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intervalsCoverage(intervals) {
  return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + (b - a + 1), 0);
}

function pointsToIntervals(hrs, gapFill) {
  const pts = [...new Set(hrs.map(Number).filter((n) => Number.isFinite(n)))]
    .filter((n) => n >= 0 && n < SCALE)
    .sort((a, b) => a - b);
  if (!pts.length) return [];
  const intervals = [];
  let start = pts[0];
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i] - prev <= gapFill) prev = pts[i];
    else {
      intervals.push([start, prev]);
      start = prev = pts[i];
    }
  }
  intervals.push([start, prev]);
  return intervals;
}

function rangesToTreatments(bucketMap, totalOk) {
  const gapFill = Math.max(
    1,
    Math.min(80, Math.floor(SCALE / Math.max(totalOk * 2, 40))),
  );
  const treatments = [];
  let coveredAll = 0;

  for (const [bucket, hrs] of bucketMap) {
    if (!hrs || !hrs.length) continue;
    const samples = hrs.length;
    const min = Math.min(...hrs);
    const max = Math.max(...hrs);
    const merged = mergeIntervals(pointsToIntervals(hrs, gapFill));
    const covered = intervalsCoverage(merged);
    coveredAll += covered;

    let pct = null;
    let status = 'unknown';
    let confidence = 'low';

    if (samples < 3) {
      status = 'insufficient_data';
    } else {
      pct = Math.min(100, Math.max(0, Math.round((covered / SCALE) * 10000) / 100));
      const span = Math.max(1, max - min + 1);
      const density = samples / span;
      if (samples >= 30 && density >= 0.02) confidence = 'high';
      else if (samples >= 12) confidence = 'medium';
      else confidence = 'low';
      status = confidence === 'low' || samples < 8 ? 'degraded' : 'estimated';
    }

    if (
      bucketMap.size === 1 &&
      samples >= 12 &&
      pct != null &&
      pct >= 85 &&
      max - min > 8000
    ) {
      pct = 100;
      status = 'estimated';
      confidence = samples >= 25 ? 'high' : 'medium';
    }

    treatments.push({
      bucket: Number(bucket),
      label: tLabel(bucket),
      percentage: pct,
      pct: pct,
      pctKnown: pct != null && status !== 'insufficient_data',
      status,
      confidence,
      sampleCount: samples,
      samples,
      coverage: Math.round((covered / SCALE) * 1000) / 1000,
      intervals: merged.slice(0, 12),
      observed: [min, max],
      gapFill,
    });
  }

  treatments.sort((a, b) => a.bucket - b.bucket);
  const sumPct = treatments.reduce(
    (s, t) => s + (t.pctKnown && t.pct != null ? t.pct : 0),
    0,
  );
  let globalStatus = 'estimated';
  if (treatments.every((t) => t.status === 'insufficient_data')) globalStatus = 'insufficient_data';
  else if (
    treatments.some((t) => t.status === 'degraded' || t.status === 'unknown') ||
    sumPct > 105
  )
    globalStatus = 'degraded';

  const conf =
    totalOk > 0
      ? Math.min(
          1,
          treatments.reduce((s, t) => s + t.sampleCount, 0) /
            (totalOk * Math.max(1, treatments.length)),
        )
      : 0;

  return {
    treatments,
    conf,
    status: globalStatus,
    coverage: Math.round((Math.min(coveredAll, SCALE) / SCALE) * 1000) / 1000,
    sumPct: Math.round(sumPct * 100) / 100,
  };
}'''

if old not in src:
    raise SystemExit('rangesToTreatments block not found on restored base')
src = src.replace(old, new)

# experiments push
old2 = '''    const { treatments, conf } = rangesToTreatments(bucketMap, ok);
    if (!treatments.length) continue;
    const nObs = treatments.reduce((s, t) => s + t.samples, 0);
    if (nObs < 3) continue;
    experiments.push({
      hash,
      id: meta.id,
      title: meta.title,
      type: 'user',
      quality: 'estimated',
      confidence: Math.round(conf * 1000) / 1000,
      treatments,
      fingerprint: fingerprintOf(treatments),
      source: 'fingerprint-sample',
      named: hasName(meta.id),
    });'''
new2 = '''    const { treatments, conf, status: rollStatus, coverage: rollCov, sumPct } =
      rangesToTreatments(bucketMap, ok);
    if (!treatments.length) continue;
    const nObs = treatments.reduce((s, t) => s + (t.sampleCount || t.samples || 0), 0);
    if (nObs < 3) continue;
    const quality =
      rollStatus === 'estimated'
        ? 'estimated'
        : rollStatus === 'degraded'
          ? 'degraded'
          : 'insufficient_data';
    experiments.push({
      hash,
      id: meta.id,
      title: meta.title,
      type: 'user',
      quality,
      status: rollStatus,
      confidence: Math.round(conf * 1000) / 1000,
      coverage: rollCov,
      sumPct,
      treatments,
      fingerprint: fingerprintOf(treatments),
      source: 'fingerprint-sample',
      named: hasName(meta.id),
    });'''
if old2 not in src:
    raise SystemExit('experiments push not found')
src = src.replace(old2, new2)

old3 = '''function fingerprintOf(treatments) {
  return treatments
    .map((t) => t.bucket + ':' + (t.pctKnown ? Number(t.pct).toFixed(1) : '?'))
    .sort()
    .join('|');
}'''
new3 = '''function fingerprintOf(treatments) {
  return treatments
    .map((t) => {
      if (!t.pctKnown || t.pct == null || t.status === 'insufficient_data') {
        return t.bucket + ':?';
      }
      const step = t.confidence === 'low' ? 5 : 1;
      const rounded = Math.round(Number(t.pct) / step) * step;
      return t.bucket + ':' + rounded.toFixed(1);
    })
    .sort()
    .join('|');
}'''
if old3 not in src:
    raise SystemExit('fingerprintOf not found')
src = src.replace(old3, new3)

old4 = "        const pct = t.pctKnown ? '`' + t.pct + '%` (est.)' : '`?%`;\n        return '• **' + t.label + '** · ' + pct + ' · n=' + t.samples + band;"
# try simpler embed line
if "t.pct + '%` (est.)" in src:
    src = src.replace(
        "const pct = t.pctKnown ? '`' + t.pct + '%` (est.)' : '`?%`';\n        return '• **' + t.label + '** · ' + pct + ' · n=' + t.samples + band;",
        "const pct = t.pctKnown && t.pct != null ? '`≈' + t.pct + '%`' : '`?%`';\n"
        "        const st = t.status && t.status !== 'estimated' ? ' · `' + t.status + '`' : '';\n"
        "        const confL = t.confidence ? ' · conf `' + t.confidence + '`' : '';\n"
        "        return '• **' + t.label + '** · ' + pct + st + confL + ' · n=' + (t.sampleCount || t.samples || 0) + band;",
    )
    print('embeds updated')

old5 = '''      if (!p) {
        changes.push({ kind: 'new', ...n });
        continue;
      }
      if (p.fingerprint === n.fingerprint) continue;
      const deltas = [];
      const pt = new Map((p.treatments || []).map((t) => [t.bucket, t]));
      for (const t of n.treatments || []) {
        if (!t.pctKnown) continue;
        const old = pt.get(t.bucket);
        const from = old && old.pctKnown !== false ? Number(old.pct) : 0;
        const to = Number(t.pct);
        if (Math.abs(to - from) >= MIN_DELTA) {
          deltas.push({ label: t.label, from, to, observed: t.observed });
        }
      }
      if (deltas.length) {
        changes.push({ kind: 'pct', id: n.id, title: n.title, deltas, named: n.named });
      }'''

new5 = '''      if (!p) {
        if (n.status === 'insufficient_data' || n.status === 'unknown') continue;
        changes.push({ kind: 'new', ...n });
        continue;
      }
      if (p.fingerprint === n.fingerprint) continue;
      const deltas = [];
      const pt = new Map((p.treatments || []).map((t) => [t.bucket, t]));
      if (n.status === 'degraded' || n.status === 'insufficient_data' || n.status === 'unknown') {
        continue;
      }
      if (p.status === 'degraded' || p.status === 'insufficient_data') {
        continue;
      }
      for (const t of n.treatments || []) {
        if (!t.pctKnown || t.pct == null) continue;
        if (t.status === 'degraded' || t.status === 'insufficient_data') continue;
        const oldT = pt.get(t.bucket);
        if (!oldT || !oldT.pctKnown || oldT.pct == null) continue;
        const from = Number(oldT.pct);
        const to = Number(t.pct);
        if (Math.abs(to - from) >= MIN_DELTA) {
          deltas.push({
            label: t.label,
            from,
            to,
            observed: t.observed,
            confidence: t.confidence,
            status: t.status,
          });
        }
      }
      if (deltas.length) {
        changes.push({ kind: 'pct', id: n.id, title: n.title, deltas, named: n.named });
      }'''

if old5 not in src:
    # maybe already partially patched transactional - try without old new block
    if 'n.status === \'degraded\'' in src:
        print('delta gates maybe present')
    else:
        raise SystemExit('pct change block not found')
else:
    src = src.replace(old5, new5)
    print('delta gates ok')

src = src.replace(
    'User experiment rollouts v6',
    'User experiment rollouts v7',
)
p.write_text(src)
print('patched', p.stat().st_size)
