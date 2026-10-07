#!/usr/bin/env python3
import base64
from pathlib import Path
chunk_dir = Path('scripts/chunks')
def assemble(prefix, dest):
    parts = sorted(chunk_dir.glob(prefix + '.*'), key=lambda p: int(p.name.rsplit('.',1)[-1]))
    data = ''.join(p.read_text().strip() for p in parts)
    Path(dest).write_bytes(base64.b64decode(data))
    print('wrote', dest, Path(dest).stat().st_size)
assemble('_dismissible_content_src.js.b64', 'scripts/_dismissible_content_src.js')
assemble('patch_dismissible.py.b64', 'scripts/patch_dismissible.py')
