#!/usr/bin/env python3
"""Assemble src/lib/experiment_state.js from scripts/es_b64/*.txt base64 parts."""
from pathlib import Path
import base64

parts = []
for i in range(12):
    p = Path(f"scripts/es_b64/{i:02d}.txt")
    if not p.exists():
        raise SystemExit(f"missing {p}")
    parts.append(p.read_text().strip())
raw = base64.b64decode("".join(parts))
out = Path("src/lib/experiment_state.js")
out.write_bytes(raw)
print("wrote", out, "bytes", len(raw))
text = raw.decode()
for needle in [
    "retentionRatio",
    "variationSource",
    "variationKeysOnly(row.before)",
    "createExperimentFingerprint",
]:
    if needle not in text:
        raise SystemExit(f"missing marker {needle}")
print("markers ok")
