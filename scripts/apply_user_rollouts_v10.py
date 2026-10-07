#!/usr/bin/env python3
import base64
from pathlib import Path
parts = sorted(Path('scripts/chunks').glob('user_rollouts_v10.b64.*'), key=lambda p: int(p.name.rsplit('.',1)[-1]))
data = base64.b64decode(''.join(p.read_text().strip() for p in parts))
Path('src/user_rollouts.js').write_bytes(data)
print('wrote', len(data))
