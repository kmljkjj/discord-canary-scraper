#!/usr/bin/env python3
"""Stop apex guild % spam: stable fingerprint (pct only), strict diff, no recap."""
from pathlib import Path
import re

# --- guild_decode: remove filterSummary from fingerprint ---
gd = Path('src/lib/guild_decode.js')
if gd.exists():
    t = gd.read_text()
    old = '''  const fingerprint =
    treatments.map((t) => t.bucket + ':' + t.pct.toFixed(2)).join(',') +
    '|ov:' +
    ovCount +
    '|pops:' +
    populations.length +
    '|rev:' +
    revision +
    '|f:' +
    filterSummary;'''
    new = '''  // % only — filter ID ranges change often and caused false "changed" spam
  const fingerprint =
    treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(1)).join(',') +
    '|ov:' +
    ovCount +
    '|rev:' +
    revision;'''
    if old in t:
        t = t.replace(old, new, 1)
        print('guild_decode fingerprint fixed')
    elif '|f:' in t and 'filterSummary' in t:
        t = re.sub(
            r'const fingerprint =\s*treatments\.map\([\s\S]*?filterSummary;',
            new.strip() + ';',
            t,
            count=1,
        )
        print('guild_decode fingerprint fixed (regex)')
    else:
        print('guild_decode already ok or different')
    gd.write_text(t)

# --- apex_rollouts.js ---
p = Path('src/apex_rollouts.js')
t = p.read_text()

# Stabilize all fingerprints that use toFixed(2) for pct
t = t.replace(
    "treatments.map((t) => t.bucket + ':' + t.pct.toFixed(2)).join(',')",
    "treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(1)).join(',')",
)
t = t.replace(
    "treatments.map((t) => (t.bucket != null ? t.bucket : t.label) + ':' + t.pct.toFixed(2)).join(',')",
    "treatments.map((t) => (t.bucket != null ? t.bucket : t.label) + ':' + Number(t.pct).toFixed(1)).join(',')",
)

# Replace diffExperiments entirely with strict version
NEW_DIFF = r'''
function pctKey(e) {
  return (e.treatments || [])
    .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
    .map((t) => String(t.bucket ?? t.label) + ':' + Number(t.pct).toFixed(1))
    .sort()
    .join('|');
}
function isLiveGuild(e) {
  return e && (e.source === 'discord' || e.source === 'advaith') && e.type !== 'user';
}
/** Only real guild % changes from Discord/advaith — never workers spam. */
function diffExperiments(prev, next) {
  const pMap = new Map(prev.map((e) => [e.id, e]));
  const nMap = new Map(next.map((e) => [e.id, e]));
  const added = [], removed = [], changed = [];
  for (const [id, n] of nMap) {
    if (!isLiveGuild(n)) continue;
    const treatments = (n.treatments || []).filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)));
    if (!treatments.length) continue;
    const p = pMap.get(id);
    if (!p) {
      // new live guild with real %
      if (treatments.some((t) => Number(t.pct) > 0))
        added.push(n);
      continue;
    }
    if (pctKey(p) === pctKey(n)) continue;
    const deltas = [];
    const pt = new Map((p.treatments || []).map((t) => [String(t.bucket ?? t.label), t]));
    for (const t of treatments) {
      const k = String(t.bucket ?? t.label);
      const old = pt.get(k);
      const from = old && old.pct != null ? Number(old.pct) : 0;
      const to = Number(t.pct);
      const d = Math.round((to - from) * 10) / 10;
      if (Math.abs(d) >= MIN_DELTA)
        deltas.push({ label: t.label, bucket: t.bucket, from, to, delta: d });
    }
    for (const t of p.treatments || []) {
      if (t.pct == null || !Number.isFinite(Number(t.pct))) continue;
      const k = String(t.bucket ?? t.label);
      if (!treatments.some((x) => String(x.bucket ?? x.label) === k) && Math.abs(Number(t.pct)) >= MIN_DELTA)
        deltas.push({ label: t.label, bucket: t.bucket, from: Number(t.pct), to: 0, delta: -Number(t.pct) });
    }
    if (!deltas.length) continue;
    const maxAbs = deltas.reduce((m, x) => Math.max(m, Math.abs(x.delta)), 0);
    changed.push({ before: p, after: n, deltas, ovDelta: null, maxAbs });
  }
  for (const [id, p] of pMap) {
    if (nMap.has(id)) continue;
    if (!isLiveGuild(p)) continue;
    if (p.recent || isRecent(p.id)) removed.push(p);
  }
  changed.sort((a, b) => b.maxAbs - a.maxAbs);
  return { added, removed, changed };
}
'''

m = re.search(r'function diffExperiments\(prev, next\) \{[\s\S]*?\n\}\n\nfunction fmtTreat', t)
if m:
    t = t[: m.start()] + NEW_DIFF.strip() + '\n\nfunction fmtTreat' + t[m.end() :]
    print('diffExperiments replaced')
elif 'function pctKey' in t and 'isLiveGuild' in t:
    print('diff already patched')
else:
    m2 = re.search(r'function diffExperiments\(prev, next\) \{[\s\S]*?\n\}\n\n', t)
    if m2:
        t = t[: m2.start()] + NEW_DIFF.strip() + '\n\n' + t[m2.end() :]
        print('diffExperiments replaced (no fmtTreat)')
    else:
        print('WARN: diffExperiments not found')

# Remove summary embed if present
if "Mise à jour des pourcentages" in t or 'Mise' in t and 'pourcentages' in t:
    # Replace buildEmbeds to not start with summary
    t2 = re.sub(
        r"const embeds = \[\s*\{[\s\S]*?footer: \{ text: 'Datamining · Apex %' \},[\s\S]*?\},\s*\];",
        'const embeds = [];',
        t,
        count=1,
    )
    if t2 != t:
        t = t2
        print('summary embed removed')
    else:
        t = re.sub(
            r"title: 'Mise[^']*',",
            "title: 'SKIP_SUMMARY',",
            t,
            count=1,
        )
        print('summary title neutralized')

# Persist only live guild experiments in state (stops workers churn)
old_compact = '''  const compact = experiments.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    fingerprint: e.fingerprint,
    treatments: e.treatments,
    overrideIdCount: e.overrideIdCount,
    populationCount: e.populationCount,
    populations: (e.populations || []).map((p) => ({ filters: p.filters, treatments: p.treatments })),
    revision: e.revision,
    recent: e.recent,
    hash: e.hash,
    source: e.source,
  }));'''
new_compact = '''  // Only live guild % sources in state — workers/assignments caused false +/~
  const compact = experiments
    .filter((e) => e && (e.source === 'discord' || e.source === 'advaith') && e.type !== 'user')
    .map((e) => ({
      id: e.id,
      type: e.type || 'guild',
      title: e.title,
      fingerprint: pctKey(e),
      treatments: (e.treatments || [])
        .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
        .map((t) => ({ bucket: t.bucket, label: t.label, pct: Math.round(Number(t.pct) * 10) / 10 })),
      overrideIdCount: e.overrideIdCount || 0,
      revision: e.revision,
      recent: !!e.recent,
      hash: e.hash,
      source: e.source,
    }));'''
if old_compact in t:
    t = t.replace(old_compact, new_compact, 1)
    print('compact fixed')
elif 'pctKey(e)' in t and "source === 'discord'" in t and 'workers/assignments' in t:
    print('compact already fixed')
else:
    # try looser
    if 'const compact = experiments.map' in t and 'pctKey(e)' not in t:
        t = re.sub(
            r'const compact = experiments\.map\(\(e\) => \(\{[\s\S]*?source: e\.source,\n  \}\)\);',
            new_compact.strip(),
            t,
            count=1,
        )
        print('compact fixed regex', 'pctKey(e)' in t)

# version bump
t = t.replace('v4.1 (user + guild)', 'v4.3 (guild pct stable)')
t = t.replace('v4.2 (pct-only)', 'v4.3 (guild pct stable)')

p.write_text(t)
print('apex written', len(t))
