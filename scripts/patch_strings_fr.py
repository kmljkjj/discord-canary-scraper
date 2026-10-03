#!/usr/bin/env python3
"""Strings: French section labels + phrase only (no +/~/- prefix, no hash key)."""
from pathlib import Path

p = Path('src/lib/notify.js')
t = p.read_text()

# 1) stringLine: phrase only, no action prefix when value exists
old_sl = '''function stringLine(prefix, key, value, maxVal) {
  // Show the phrase only — Discord i18n keys (e.g. zVcDfj) are opaque hashes.
  const v = cleanText(value, maxVal);
  if (!v) {
    const k = String(key || '').replace(/`/g, "'");
    return `${prefix} ${k}`;
  }
  return `${prefix} ${v}`;
}'''

new_sl = '''function stringLine(prefix, key, value, maxVal) {
  // Phrase only — no hash key, no +/- prefix (section label already says Ajoute/Supprime).
  const v = cleanText(value, maxVal);
  if (!v) {
    const k = String(key || '').replace(/`/g, "'");
    return k;
  }
  return v;
}'''

if 'section label already says' in t:
    print('stringLine already')
elif old_sl in t:
    t = t.replace(old_sl, new_sl, 1)
    print('stringLine patched')
else:
    # fallback: older form still with key
    old2 = '''function stringLine(prefix, key, value, maxVal) {
  const k = String(key || '').replace(/`/g, "'");
  const v = cleanText(value, maxVal);
  if (!v) return `${prefix} ${k}`;
  return `${prefix} ${k}: ${v}`;
}'''
    if old2 in t:
        t = t.replace(old2, new_sl, 1)
        print('stringLine patched (from key form)')
    else:
        print('WARN stringLine not found')

# 2) French labels only for Strings kind in sendMapDiff
# Replace the section labels when kind is Strings
old_added = "label: label(E.added, `Added · ${a.length}`),"
new_added_str = "label: label(E.added, (isRoutes ? `Added · ${a.length}` : `Ajoute · ${a.length}`)),"
# Actually use proper accents via unicode escapes in JS source
new_added = "label: label(E.added, isRoutes ? `Added \u00b7 ${a.length}` : `Ajout\u00e9 \u00b7 ${a.length}`),"
new_mod = "label: label(E.modified, isRoutes ? `Modified \u00b7 ${m.length}` : `Modifi\u00e9 \u00b7 ${m.length}`),"
new_rem = "label: label(E.removed, isRoutes ? `Removed \u00b7 ${r.length}` : `Supprim\u00e9 \u00b7 ${r.length}`),"

# Find exact current labels in sendMapDiff (appear 3 times for a/m/r - but also in experiments)
# Only replace inside sendMapDiff by unique context with maxLines

block_start = t.find('async function sendMapDiff')
if block_start < 0:
    raise SystemExit('sendMapDiff not found')
block_end = t.find('async function post(', block_start)
block = t[block_start:block_end]

block2 = block
block2 = block2.replace(
    'label: label(E.added, `Added · ${a.length}`),',
    'label: label(E.added, isRoutes ? `Added \u00b7 ${a.length}` : `Ajout\u00e9 \u00b7 ${a.length}`),',
    1,
)
block2 = block2.replace(
    'label: label(E.modified, `Modified · ${m.length}`),',
    'label: label(E.modified, isRoutes ? `Modified \u00b7 ${m.length}` : `Modifi\u00e9 \u00b7 ${m.length}`),',
    1,
)
block2 = block2.replace(
    'label: label(E.removed, `Removed · ${r.length}`),',
    'label: label(E.removed, isRoutes ? `Removed \u00b7 ${r.length}` : `Supprim\u00e9 \u00b7 ${r.length}`),',
    1,
)

if block2 == block:
    print('WARN labels unchanged - check exact strings')
else:
    t = t[:block_start] + block2 + t[block_end:]
    print('labels patched')

p.write_text(t)
print('done')
