#!/usr/bin/env python3
import base64
from pathlib import Path
root = Path('scripts/mobile_payload')
meta = root.joinpath('meta.txt').read_text()
ff_n = int(meta.split('ff=')[1].split()[0])
mv_n = int(meta.split('mv=')[1].split()[0])
ff = ''.join((root / f'ff_{i}.b64').read_text().strip() for i in range(ff_n))
mv = ''.join((root / f'mv_{i}.b64').read_text().strip() for i in range(mv_n))
Path('src/mobile_from_files.js').write_bytes(base64.b64decode(ff))
Path('src/mobile_versions.js').write_bytes(base64.b64decode(mv))
print('ok', Path('src/mobile_from_files.js').stat().st_size, Path('src/mobile_versions.js').stat().st_size)
