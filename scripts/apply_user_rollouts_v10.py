#!/usr/bin/env python3
import base64, zlib
from pathlib import Path
parts = []
for i in range(4):
    parts.append(Path(f"scripts/chunks/ur_v10_b64_{i}.txt").read_text().strip())
B64 = "".join(parts)
data = zlib.decompress(base64.b64decode(B64))
Path("src/user_rollouts.js").write_bytes(data)
print("wrote", len(data))
