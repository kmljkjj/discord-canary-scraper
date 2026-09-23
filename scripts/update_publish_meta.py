#!/usr/bin/env python3
from pathlib import Path
import json

pkg_path = Path('package.json')
p = json.loads(pkg_path.read_text())
if 'publish_data' not in p['scripts']['check']:
    p['scripts']['check'] += ' && node --check src/lib/publish_data.js'
if 'publish_data' not in p['scripts'].get('test', ''):
    p['scripts']['test'] = (
        p['scripts'].get('test', 'node --test')
        + ' test/publish_data.test.js'
    )
pkg_path.write_text(json.dumps(p, indent=2) + '\n')
print('package.json updated')

sp = Path('.github/workflows/scrape.yml')
t = sp.read_text()
if 'generation.json' not in t:
    t = t.replace(
        '            data/meta.json \\\n',
        '            data/meta.json \\\n            data/generation.json \\\n',
    )
    sp.write_text(t)
    print('scrape whitelist updated')
else:
    print('scrape already has generation.json')
