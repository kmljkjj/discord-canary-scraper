#!/usr/bin/env python3
from pathlib import Path
import base64
parts = sorted(Path('scripts/ur_chunks').glob('ur_b64_*.txt'))
b64 = ''.join(p.read_text().strip() for p in parts)
data = base64.b64decode(b64)
Path('src/user_rollouts.js').write_bytes(data)
print('assembled', len(data), 'from', len(parts), 'chunks')
text = data.decode()
assert 'mergeIntervals' in text
assert 'NOTIFY_FAIL user_rollouts' in text
assert 'PLACEHOLDER' not in text
