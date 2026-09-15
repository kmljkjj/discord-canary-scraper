#!/usr/bin/env python3
"""Remove summary embed; only notify real numeric % changes; stop workers spam."""
from pathlib import Path
import re

p = Path('src/apex_rollouts.js')
t = p.read_text()

# 1) Strip summary embed from buildEmbeds if present
if "Mise à jour des pourcentages" in t or 'Mise à jour des pourcentages' in t or 'title: \'Mise' in t or 'title: "Mise' in t:
    t = re.sub(
        r"const embeds = \[\s*\{[\s\S]*?title:\s*['\"]Mise[^'"]*['\"][\s\S]*?\},\s*",
        'const embeds = [\n',
        t,
        count=1,
    )
    # also French encoding variants
    t = t.replace("title: 'Mise à jour des pourcentages'", "title: 'ROLLUP_REMOVE'")

# More reliable: replace entire buildEmbeds function
NEW_BUILD = r'''
function hasNumericPct(e) {
  return (e.treatments || []).some((t) => t && t.pct != null && Number.isFinite(Number(t.pct)));
}
function pctFingerprint(e) {
  return (e.treatments || [])
    .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
    .map((t) => String(t.bucket ?? t.label) + ':' + Number(t.pct).toFixed(2))
    .sort()
    .join('|');
}
function buildEmbeds(diff, stats) {
  const embeds = [];
  const colorAdd = 0x3ba55d;
  const colorChg = 0xfaa61a;
  const colorRem = 0xed4245;
  const pushExp = (e, prefix, color, extra) => {
    const lines = [];
    if (e.type) lines.push('**Type** · `' + e.type + '`');
    for (const t of (e.treatments || []).slice(0, 12)) {
      if (t.pct == null || !Number.isFinite(Number(t.pct))) continue;
      lines.push('• **' + (t.label || 'Bucket ' + t.bucket) + '** · `' + t.pct + '%`');
    }
    if (extra && extra.length) lines.push(...extra);
    if (lines.length <= (e.type ? 1 : 0)) return;
    embeds.push({
      author: { name: 'Datamining', icon_url: AVATAR },
      title: (prefix + ' ' + (e.title || e.id)).slice(0, 250),
      description: lines.join('\n').slice(0, 3900),
      color,
      footer: { text: String(e.id || '') },
    });
  };
  for (const e of (diff.added || []).slice(0, 12))
    pushExp(e, '\u2795', colorAdd, null);
  for (const c of (diff.changed || []).slice(0, 12)) {
    const extra = (c.deltas || []).slice(0, 10).map((d) => {
      const arrow = d.delta > 0 ? '\u2191' : '\u2193';
      return (
        '\u2022 **' +
        (d.label || 'Bucket ' + d.bucket) +
        '** · `' +
        d.from +
        '%` \u2192 `' +
        d.to +
        '%` (' +
        arrow +
        Math.abs(d.delta) +
        ')'
      );
    });
    pushExp(c.after, '\uD83D\uDD01', colorChg, extra);
  }
  for (const e of (diff.removed || []).slice(0, 6))
    pushExp(e, '\u2796', colorRem, null);
  return embeds;
}
'''

# Insert helpers before buildEmbeds if missing
if 'function pctFingerprint' not in t:
    t = re.sub(
        r'function buildEmbeds\(diff, stats\) \{',
        NEW_BUILD.strip() + '\nfunction buildEmbeds_UNUSED(diff, stats) {',
        t,
        count=1,
    )
    # Remove the unused stub body until next function
    t = re.sub(
        r'function buildEmbeds_UNUSED\(diff, stats\) \{[\s\S]*?\n\}\n\nasync function postWebhook',
        'async function postWebhook',
        t,
        count=1,
    )
else:
    # Replace existing buildEmbeds only
    t = re.sub(
        r'function buildEmbeds\(diff, stats\) \{[\s\S]*?\n\}\n\nasync function postWebhook',
        NEW_BUILD.strip() + '\nasync function postWebhook',
        t,
        count=1,
    )

# 2) Tighten added: only live sources with numeric %
t = t.replace(
    "if (n.recent || (n.source === 'discord' || n.source === 'advaith') && (n.treatments || []).some((t) => t.pct > 0))\n        added.push(n);",
    "if (hasNumericPct(n) && (n.source === 'discord' || n.source === 'advaith'))\n        added.push(n);",
)
# Also handle if already multiline slightly different
if "hasNumericPct(n) && (n.source === 'discord'" not in t:
    t = re.sub(
        r"if \(n\.recent \|\| \(n\.source === 'discord' \|\| n\.source === 'advaith'\) &&[^)]+\)\s*\n\s*added\.push\(n\);",
        "if (hasNumericPct(n) && (n.source === 'discord' || n.source === 'advaith'))\n        added.push(n);",
        t,
        count=1,
    )

# Skip changed when no numeric pct on either side
if 'if (!hasNumericPct(n)) continue' not in t:
    t = t.replace(
        'if (p.fingerprint === n.fingerprint) continue;',
        "if (!hasNumericPct(n) || !hasNumericPct(p)) continue;\n    if (pctFingerprint(n) === pctFingerprint(p)) continue;\n    if (p.fingerprint === n.fingerprint) continue;",
        1,
    )

# 3) Don't notify assignment-only / skip null pct math
t = t.replace(
    'const from = old ? old.pct : 0;\n      const d = Math.round((t.pct - from) * 100) / 100;',
    "if (t.pct == null || !Number.isFinite(Number(t.pct))) continue;\n      const from = old && old.pct != null && Number.isFinite(Number(old.pct)) ? Number(old.pct) : 0;\n      const d = Math.round((Number(t.pct) - from) * 100) / 100;",
)

# 4) post only if embeds
if 'No embeddable' not in t:
    t = t.replace(
        'const sent = await postWebhook(buildEmbeds(diff, { sources }));',
        "const embeds = buildEmbeds(diff, { sources });\n  if (!embeds.length) {\n    console.log('No embeddable % changes (filtered)');\n    return;\n  }\n  const sent = await postWebhook(embeds);",
    )

# 5) version log
t = t.replace('v4.1 (user + guild)', 'v4.2 (pct-only)')
t = t.replace('v4.1 (user + guild)', 'v4.2 (pct-only)')

p.write_text(t)
print('done')
print('summary left', 'Mise' in t and 'pourcentages' in t)
print('pctFingerprint', 'pctFingerprint' in t)
print('hasNumericPct', 'hasNumericPct' in t)
