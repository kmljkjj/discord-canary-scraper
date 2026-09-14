#!/usr/bin/env python3
"""Restore src/index.js from gzip+base64 parts."""
import base64
import gzip
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parts = [
    ROOT / "scripts" / "index_v11_2.gz.b64.a",
    ROOT / "scripts" / "index_v11_2.gz.b64.b",
]
b64 = "".join(p.read_text().strip() for p in parts)
raw = gzip.decompress(base64.b64decode(b64))
out = ROOT / "src" / "index.js"
out.write_bytes(raw)
print("Restored", out, "bytes", len(raw))
text = raw.decode("utf-8")
assert "Canary Pulse v11.2" in text
assert "FLASH skip" in text
assert "async function main" in text
print("OK")
