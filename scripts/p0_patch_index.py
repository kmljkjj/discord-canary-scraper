#!/usr/bin/env python3
"""Surgical P0 patches for src/index.js."""
from pathlib import Path
import re

p = Path("src/index.js")
t = p.read_text()

old_fp = re.search(
    r"function expFingerprint\(e\) \{[\s\S]*?\n\}\n\nfunction expSnapshot",
    t,
)
if old_fp and "createExperimentFingerprint" not in old_fp.group(0):
    t = t[: old_fp.start()] + (
        "function expFingerprint(e) {\n"
        "  if (!e || typeof e !== 'object') return '';\n"
        "  const n = e.fingerprint\n"
        "    ? e\n"
        "    : experimentState.normalizeExperiment(e) || e;\n"
        "  return experimentState.createExperimentFingerprint(n);\n"
        "}\n\nfunction expSnapshot"
    ) + t[old_fp.end() :]
    print("fingerprint delegated")
else:
    print("fingerprint skip")

old_ok = "const strRtOk = typeof okN === 'undefined' ? true : okN;"
if old_ok in t:
    t = t.replace(old_ok, "const strRtOk = okN === true;", 1)
    print("okN fixed")

old_conf = (
    "    confirmedRemovedIds: (\n"
    "      (rawDiff && (rawDiff.removedAll || rawDiff.removed)) ||\n"
    "      expDiff.removed ||\n"
    "      []\n"
    "    ).map((e) => String(typeof e === 'string' ? e : e && e.id)),"
)
new_conf = (
    "    confirmedRemovedIds: (() => {\n"
    "      const candidates =\n"
    "        (rawDiff && (rawDiff.removedAll || rawDiff.removed)) ||\n"
    "        expDiff.removed ||\n"
    "        [];\n"
    "      const out = [];\n"
    "      const seen = new Set();\n"
    "      for (const e of candidates) {\n"
    "        const id = String(typeof e === 'string' ? e : (e && e.id) || '');\n"
    "        if (!id || seen.has(id) || knownRemoved.has(id)) continue;\n"
    "        seen.add(id);\n"
    "        out.push(id);\n"
    "      }\n"
    "      return out;\n"
    "    })(),"
)
if old_conf in t:
    t = t.replace(old_conf, new_conf, 1)
    print("confirmedRemovedIds fixed")
else:
    print("confirmedRemovedIds skip")

p.write_text(t)
print("wrote", p)
