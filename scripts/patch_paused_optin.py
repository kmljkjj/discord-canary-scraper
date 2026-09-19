#!/usr/bin/env python3
from pathlib import Path
p = Path('src/mobile_versions.js')
s = p.read_text()
old = "const PAUSED =\n  process.env.MOBILE_VERSIONS_PAUSED !== '0' &&\n  process.env.MOBILE_VERSIONS_PAUSED !== 'false';"
new = "const PAUSED =\n  process.env.MOBILE_VERSIONS_PAUSED === '1' ||\n  process.env.MOBILE_VERSIONS_PAUSED === 'true';"
if old in s:
    p.write_text(s.replace(old, new))
    print('ok opt-in pause')
elif "=== '1'" in s and 'MOBILE_VERSIONS_PAUSED' in s:
    print('already opt-in')
else:
    raise SystemExit('block not found')
