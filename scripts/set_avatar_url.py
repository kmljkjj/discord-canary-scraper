#!/usr/bin/env python3
from pathlib import Path
import re

AVATAR = "https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/assets/datamining-avatar.svg"
RAW = "https://raw.githubusercontent.com/kmljkjj/discord-canary-scraper/main/assets/datamining-avatar.svg"

repls = [
    ("https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4ca.png", AVATAR),
    ("https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/assets/datamining-avatar.jpg", AVATAR),
]

for path in list(Path("src").rglob("*.js")) + list(Path(".github").rglob("*.yml")):
    try:
        t = path.read_text()
    except Exception:
        continue
    orig = t
    for a, b in repls:
        t = t.replace(a, b)
    if "ORBIT_AVATAR_URL" in t and AVATAR not in t:
        t = re.sub(
            r"(process\.env\.ORBIT_AVATAR_URL\s*\|\|\s*)([^\n;]+)",
            lambda m: m.group(1) + "'" + AVATAR + "'",
            t,
            count=1,
        )
    if t != orig:
        path.write_text(t)
        print("updated", path)
print("avatar ->", AVATAR)
