#!/usr/bin/env python3
from pathlib import Path
p = Path('src/quests.js')
src = p.read_text()
if 'Known ids loaded:' in src:
    print('already')
    raise SystemExit(0)
old = 'const prevIds = new Set((previous.ids || []).map(String));'
# try variants
candidates = [
    'const prevIds = new Set((previous.ids || []).map(String));',
    'const prevIds = new Set((previous.ids || []).map((x) => String(x)));',
    'const prevIds = new Set(previous.ids || []);',
]
for old in candidates:
    if old in src:
        src = src.replace(
            old,
            "const prevIds = new Set((previous.ids || []).map((x) => String(x)));\n  console.log('Known ids loaded:', prevIds.size, 'from', STATE_FILE);",
            1,
        )
        p.write_text(src)
        print('patched')
        raise SystemExit(0)
raise SystemExit('prevIds line not found')
