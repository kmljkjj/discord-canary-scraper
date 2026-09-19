#!/usr/bin/env python3
"""Wire user_rollouts.js to rollout_math, 1% delta, change types, history, safer logs."""
from pathlib import Path

p = Path('src/user_rollouts.js')
src = p.read_text()
if "require('./lib/rollout_math')" in src or 'require("./lib/rollout_math")' in src:
    print('already wired')
else:
    # inject require after crypto
    needle = "const crypto = require('crypto');\n"
    inject = needle + (
        "const {\n"
        "  mergeIntervals,\n"
        "  intervalsCoverage,\n"
        "  pointsToIntervals,\n"
        "  estimateFromPoints,\n"
        "  classifyChange,\n"
        "  stableChangeFingerprint,\n"
        "  DEFAULT_SCALE,\n"
        "} = require('./lib/rollout_math');\n"
    )
    if needle not in src:
        raise SystemExit('crypto require not found')
    src = src.replace(needle, inject, 1)
    print('require wired')

# MIN_DELTA default 1
src2 = src.replace(
    "const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 3);",
    "const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 1);",
)
if src2 == src and '|| 1)' not in src:
    # maybe already 1
    if '|| 1)' in src:
        print('MIN_DELTA already 1')
    else:
        print('WARN MIN_DELTA line not found')
else:
    src = src2
    print('MIN_DELTA default 1')

# SCALE from lib if present as const SCALE = 10000
if 'const SCALE = 10000' in src:
    src = src.replace('const SCALE = 10000;', 'const SCALE = DEFAULT_SCALE;')
    print('SCALE from DEFAULT_SCALE')

# Never log token lengths or values — sanitize console of token-ish
if 'function redactSecrets' not in src:
    src = src.replace(
        'function sleep(ms) {',
        '''function redactSecrets(msg) {
  return String(msg || '')
    .replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{10,}/g, '[REDACTED_JWT]')
    .replace(/mfa\.[\w-]{20,}/gi, '[REDACTED_TOKEN]')
    .replace(/Bot\s+[\w.-]{20,}/gi, 'Bot [REDACTED]');
}

function sleep(ms) {''',
        1,
    )
    print('redactSecrets added')

# Soften token snapshot logging: never print Authorization-related
src = src.replace(
    "console.warn('Token snapshot', res.status);",
    "console.warn('Token snapshot HTTP', res.status);",
)
src = src.replace(
    "console.warn('Token snapshot fail:', e.message);",
    "console.warn('Token snapshot fail:', redactSecrets(e.message));",
)

# Improve pct change detection to use classifyChange when comparing
old_delta = '''      for (const t of n.treatments || []) {
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

new_delta = '''      for (const t of n.treatments || []) {
        if (!t.pctKnown || t.pct == null) continue;
        if (t.status === 'degraded' || t.status === 'insufficient_data') continue;
        const oldT = pt.get(t.bucket);
        if (!oldT || !oldT.pctKnown || oldT.pct == null) continue;
        const from = Number(oldT.pct);
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
      }'''

if old_delta in src:
    src = src.replace(old_delta, new_delta)
    print('classifyChange wired')
else:
    print('WARN delta block not exact — skip classify wire')

# announced skip by changeFingerprint if present on announced map for pct
# add history in writeState
old_ws = '''  async function writeState(announcedMap) {
    await fs.writeJson(
      STATE,
      {
        scrapedAt: new Date().toISOString(),
        version: 7,
        samples: SAMPLES,
        ok,
        fail,
        tokens: TOKENS.length,
        experiments,
        token: tokenSnap,
        announced: announcedMap,
      },
      { spaces: 2 },
    );
  }'''

new_ws = '''  async function writeState(announcedMap, extra = {}) {
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
          new Date().toISOString().replace(/[:.]/g, '-') + '_' + Math.random().toString(36).slice(2, 8),
        samples: SAMPLES,
        ok,
        fail,
        tokensConfigured: TOKENS.length, // never store token values
        experiments,
        token: tokenSnap,
        announced: announcedMap,
        history,
        lastChanges: extra.changes || prev.lastChanges || [],
      },
      { spaces: 2 },
    );
  }'''

if old_ws in src:
    src = src.replace(old_ws, new_ws)
    print('writeState history ok')
else:
    # try version 6
    old_ws6 = old_ws.replace('version: 7', 'version: 6')
    if old_ws6 in src:
        src = src.replace(old_ws6, new_ws)
        print('writeState history ok (from v6)')
    else:
        print('WARN writeState block not found')

# module.exports expand
src = src.replace(
    "module.exports = { main, murmur3, loadHashMap, rangesToTreatments };",
    "module.exports = { main, murmur3, loadHashMap, rangesToTreatments, classifyChange, mergeIntervals };",
)

# header version
src = src.replace('rollouts v7', 'rollouts v8')
src = src.replace('v7 — ESTIMATED', 'v8 — ESTIMATED')

p.write_text(src)
print('done', p.stat().st_size)
