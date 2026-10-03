#!/usr/bin/env python3
from pathlib import Path

p = Path('src/lib/notify.js')
t = p.read_text()
old = """function stringLine(prefix, key, value, maxVal) {
  const k = String(key || '').replace(/`/g, "'");
  const v = cleanText(value, maxVal);
  if (!v) return `${prefix} ${k}`;
  return `${prefix} ${k}: ${v}`;
}"""
new = """function stringLine(prefix, key, value, maxVal) {
  // Show the phrase only — Discord i18n keys (e.g. zVcDfj) are opaque hashes.
  const v = cleanText(value, maxVal);
  if (!v) {
    const k = String(key || '').replace(/`/g, "'");
    return `${prefix} ${k}`;
  }
  return `${prefix} ${v}`;
}"""
if 'Show the phrase only' in t:
    print('already patched')
elif old not in t:
    raise SystemExit('stringLine block not found')
else:
    t = t.replace(old, new, 1)
    t = t.replace(
        '* - Strings/Routes: key + full text',
        '* - Strings: phrase only (no hash key) · Routes: key + path',
        1,
    )
    p.write_text(t)
    print('patched')
