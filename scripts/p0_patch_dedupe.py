#!/usr/bin/env python3
"""Add stableExpEventKey to webhook_dedupe.js if missing."""
from pathlib import Path

p = Path("src/lib/webhook_dedupe.js")
t = p.read_text()
if "stableExpEventKey" in t:
    print("stableExpEventKey already present")
else:
    needle = "function stableExpKey(bn, exp) {"
    if needle not in t:
        raise SystemExit("stableExpKey not found")
    addition = (
        "/** Per-event fingerprint: type + build + experiment id (partial batch safe). */\n"
        "function stableExpEventKey(bn, changeType, exp) {\n"
        "  const id = String(\n"
        "    typeof exp === 'string' ? exp : (exp && (exp.id || exp.name)) || '',\n"
        "  ).trim();\n"
        "  const raw = ['expev', String(bn), String(changeType || ''), id].join('|');\n"
        "  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);\n"
        "}\n\n"
    )
    t = t.replace(needle, addition + needle, 1)
    old_exp = "  stableExpKey,\n  stableMapKey,"
    new_exp = "  stableExpKey,\n  stableExpEventKey,\n  stableMapKey,"
    if old_exp not in t:
        raise SystemExit("exports block not found")
    t = t.replace(old_exp, new_exp, 1)
    p.write_text(t)
    print("stableExpEventKey added")
