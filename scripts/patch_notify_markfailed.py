#!/usr/bin/env python3
from pathlib import Path
p = Path('src/lib/notify.js')
src = p.read_text()
if 'markFailed' in src and 'await markFailed(fp' in src:
    print('already patched')
    raise SystemExit(0)
if 'markFailed,' not in src:
    src = src.replace(
        '  markPosted,\n  claimPosted,',
        '  markPosted,\n  markFailed,\n  claimPosted,',
        1,
    )
src = src.replace(
    "else console.warn('Experiments webhook failed — batch NOT locked');",
    "else {\n    console.warn('Experiments webhook failed — batch NOT locked');\n    await markFailed(batchKey, 'experiments batch send failed');\n  }",
)
src = src.replace(
    "else console.warn(kind, 'webhook failed — batch NOT locked');",
    "else {\n    console.warn(kind, 'webhook failed — batch NOT locked');\n    await markFailed(batchKey, kind + ' batch send failed');\n  }",
)
if "await markFailed(fp" not in src:
    src = src.replace(
        "console.warn('webhook fail', lastErr);\n      return false;",
        "console.warn('webhook fail', lastErr);\n      await markFailed(fp, lastErr);\n      return false;",
    )
    src = src.replace(
        "console.warn('webhook gave up', lastErr);\n  return false;",
        "console.warn('webhook gave up', lastErr);\n  await markFailed(fp, lastErr);\n  return false;",
    )
p.write_text(src)
print('patched', p.stat().st_size)
