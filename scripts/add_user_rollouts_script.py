#!/usr/bin/env python3
from pathlib import Path
import json
p = Path('package.json')
j = json.loads(p.read_text())
j.setdefault('scripts', {})['user-rollouts'] = 'node src/user_rollouts.js'
p.write_text(json.dumps(j, indent=2) + '\n')
print('ok')
