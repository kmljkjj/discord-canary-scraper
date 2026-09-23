#!/usr/bin/env python3
from pathlib import Path
import re

src = Path('src/index.js').read_text()
if 'publishDataGeneration' in src and 'DATA_PUBLISH failed' in src:
    print('already wired')
    raise SystemExit(0)

if 'publish_data' not in src:
    src = src.replace(
        "const experimentState = require('./lib/experiment_state');",
        "const experimentState = require('./lib/experiment_state');\n"
        "const { publishDataGeneration } = require('./lib/publish_data');",
    )

m = re.search(r"const \{([^}]+)\} = require\('\./lib/state'\);", src)
if m and 'makeRunId' not in m.group(1):
    names = [x.strip() for x in m.group(1).split(',') if x.strip()]
    names.append('makeRunId')
    src = (
        src[: m.start()]
        + 'const { '
        + ', '.join(names)
        + " } = require('./lib/state');"
        + src[m.end() :]
    )

fail_marker = 'NOTIFY_FAIL: skipping ALL state advance'
idx_fail = src.find(fail_marker)
if idx_fail < 0:
    raise SystemExit('fail marker missing')
start = src.find(
    '    await Promise.all([\n      saveKnownIds(KNOWN_EXP, knownExp, 8000),',
    idx_fail,
)
if start < 0:
    raise SystemExit('start not found')
end = src.find("  console.log('=== Done', Date.now() - t0 + 'ms ===');\n}", start)
if end < 0:
    raise SystemExit('end not found')
end = end + len("  console.log('=== Done', Date.now() - t0 + 'ms ===');\n}")

block = Path('scripts/publish_success_block.js').read_text()
src2 = src[:start] + block + src[end:]
Path('src/index.js').write_text(src2)
print('wired', len(src2))
