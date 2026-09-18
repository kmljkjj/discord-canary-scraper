#!/usr/bin/env python3
import base64
from pathlib import Path
r = Path('scripts/mparts')
na, nb = map(int, (r/'meta').read_text().split())
ff = ''.join((r/f'a{i}').read_text() for i in range(na))
mv = ''.join((r/f'b{i}').read_text() for i in range(nb))
Path('src/mobile_from_files.js').write_bytes(base64.b64decode(ff))
Path('src/mobile_versions.js').write_bytes(base64.b64decode(mv))
print('ok', Path('src/mobile_from_files.js').stat().st_size, Path('src/mobile_versions.js').stat().st_size)
