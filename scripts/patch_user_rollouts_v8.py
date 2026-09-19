#!/usr/bin/env python3
from pathlib import Path
import re

p = Path('src/user_rollouts.js')
src = p.read_text()

if "require('./lib/rollout_math')" not in src:
    needle = "const crypto = require('crypto');\n"
    if needle not in src:
        raise SystemExit('crypto require missing')
    src = src.replace(
        needle,
        needle
        + "const {\n"
        + "  mergeIntervals,\n"
        + "  intervalsCoverage,\n"
        + "  pointsToIntervals,\n"
        + "  estimateFromPoints,\n"
        + "  classifyChange,\n"
        + "  stableChangeFingerprint,\n"
        + "  DEFAULT_SCALE,\n"
        + "} = require('./lib/rollout_math');\n",
        1,
    )

start = src.find('function mergeIntervals(intervals)')
end = src.find('function fingerprintOf(treatments)')
if start >= 0 and end > start:
    replacement = """function rangesToTreatments(bucketMap, totalOk) {
  const treatments = [];
  let coveredAll = 0;
  for (const [bucket, hrs] of bucketMap) {
    if (!hrs || !hrs.length) continue;
    const est = estimateFromPoints(hrs, totalOk, SCALE);
    coveredAll += Math.round((est.coverage || 0) * SCALE);
    treatments.push({
      bucket: Number(bucket),
      label: tLabel(bucket),
      percentage: est.percentage,
      pct: est.percentage,
      pctKnown: est.percentage != null && est.status !== 'insufficient_data',
      status: est.status,
      confidence: est.confidence,
      sampleCount: est.sampleCount,
      samples: est.sampleCount,
      coverage: est.coverage,
      intervals: est.ranges,
      ranges: est.ranges,
      observed: est.observed,
      gapFill: est.gapFill,
      sourceKind: est.sourceKind || 'estimated_from_samples',
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
}

"""
    src = src[:start] + replacement + src[end:]
    print('thin rangesToTreatments')
elif 'estimateFromPoints(hrs' in src:
    print('already thin')
else:
    print('WARN mergeIntervals not found')

src = src.replace(
    "const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 3);",
    "const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 1);",
)
src = src.replace('const SCALE = 10000;', 'const SCALE = DEFAULT_SCALE;')

if 'function redactSecrets' not in src:
    src = src.replace(
        'function sleep(ms) {',
        """function redactSecrets(msg) {
  return String(msg || '')
    .replace(/[\\w-]{20,}\\.[\\w-]{5,}\\.[\\w-]{10,}/g, '[REDACTED_JWT]')
    .replace(/mfa\\.[\\w-]{20,}/gi, '[REDACTED_TOKEN]')
    .replace(/Bot\\s+[\\w.-]{20,}/gi, 'Bot [REDACTED]');
}

function sleep(ms) {""",
        1,
    )

src = src.replace(
    "console.warn('Token snapshot fail:', e.message);",
    "console.warn('Token snapshot fail:', redactSecrets(e.message));",
)

if 'classifyChange(from, to, MIN_DELTA)' not in src:
    old = """        const from = Number(oldT.pct);
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
      }"""
    new = """        const from = Number(oldT.pct);
        const to = Number(t.pct);
        const { changeType, change } = classifyChange(from, to, MIN_DELTA);
        if (!changeType || changeType === 'ROLLOUT_DATA_DEGRADED') continue;
        deltas.push({
          label: t.label,
          bucket: t.bucket,
          from,
          to,
          change,
          changeType,
          observed: t.observed,
          ranges: t.intervals || t.ranges || null,
          confidence: t.confidence,
          status: t.status,
          population: 'user',
          treatment: t.label,
        });
      }
      if (deltas.length) {
        const fp = stableChangeFingerprint({
          id: n.id,
          deltas: deltas.map((d) => [d.bucket, d.from, d.to, d.changeType]),
        });
        changes.push({
          kind: 'pct',
          id: n.id,
          title: n.title,
          deltas,
          named: n.named,
          changeFingerprint: fp,
        });
      }"""
    if old not in src:
        raise SystemExit('delta block not found')
    src = src.replace(old, new)
    print('classifyChange wired')

m = re.search(
    r'  async function writeState\(announcedMap\) \{\n    await fs\.writeJson\(\n      STATE,\n      \{[\s\S]*?announced: announcedMap,\n      \},\n      \{ spaces: 2 \},\n    \);\n  \}',
    src,
)
if m and 'tokensConfigured' not in m.group(0):
    new_ws = """  async function writeState(announcedMap, extra = {}) {
    const prevHist = Array.isArray(prev.history) ? prev.history : [];
    const histEntry = {
      ts: new Date().toISOString(),
      ok,
      fail,
      experimentCount: experiments.length,
      changeCount: (extra.changes && extra.changes.length) || 0,
    };
    const history = [...prevHist, histEntry].slice(-40);
    await fs.writeJson(
      STATE,
      {
        scrapedAt: new Date().toISOString(),
        version: 8,
        schemaVersion: 8,
        runId:
          extra.runId ||
          new Date().toISOString().replace(/[:.]/g, '-') +
            '_' +
            Math.random().toString(36).slice(2, 8),
        samples: SAMPLES,
        ok,
        fail,
        tokensConfigured: TOKENS.length,
        experiments,
        token: tokenSnap,
        announced: announcedMap,
        history,
        lastChanges: extra.changes || prev.lastChanges || [],
      },
      { spaces: 2 },
    );
  }"""
    src = src[: m.start()] + new_ws + src[m.end() :]
    print('writeState updated')
else:
    print('writeState skip')

src = src.replace(
    'module.exports = { main, murmur3, loadHashMap, rangesToTreatments };',
    'module.exports = { main, murmur3, loadHashMap, rangesToTreatments, classifyChange, mergeIntervals };',
)
for a, b in [
    ('User experiment rollouts v6', 'User experiment rollouts v8'),
    ('User experiment rollouts v7', 'User experiment rollouts v8'),
    ('rollouts v6 (ESTIMATED', 'rollouts v8 (ESTIMATED'),
    ('rollouts v7 (ESTIMATED', 'rollouts v8 (ESTIMATED'),
]:
    src = src.replace(a, b)

p.write_text(src)
print('patched', p.stat().st_size)
