#!/usr/bin/env python3
from pathlib import Path
import base64, re
B64 = open('scripts/avatar.b64').read().strip() if Path('scripts/avatar.b64').exists() else ''
AVATAR_URL = 'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/assets/datamining-avatar.jpg'
if not B64:
    raise SystemExit('missing avatar.b64')
Path('assets').mkdir(exist_ok=True)
Path('assets/datamining-avatar.jpg').write_bytes(base64.b64decode(B64))
print('bytes', Path('assets/datamining-avatar.jpg').stat().st_size)
repls = [
    ('https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4ca.png', AVATAR_URL),
    ('https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/assets/datamining-avatar.svg', AVATAR_URL),
]
for path in list(Path('src').rglob('*.js')) + list(Path('.github').rglob('*.yml')):
    try:
        t = path.read_text()
    except Exception:
        continue
    orig = t
    for a, b in repls:
        t = t.replace(a, b)
    if 'ORBIT_AVATAR_URL' in t and AVATAR_URL not in t:
        t = re.sub(
            r"(process\.env\.ORBIT_AVATAR_URL\s*\|\|\s*)([^\n;]+)",
            lambda m: m.group(1) + "'" + AVATAR_URL + "'",
            t,
            count=1,
        )
    if t != orig:
        path.write_text(t)
        print('updated', path)
print('ok')
