#!/usr/bin/env python3
"""P0: per-event experiment dedupe in notify.js"""
from pathlib import Path

p = Path("src/lib/notify.js")
t = p.read_text()

if "stableExpEventKey" not in t:
    old = "  stableExpKey,\n  stableMapKey,"
    new = "  stableExpKey,\n  stableExpEventKey,\n  stableMapKey,"
    if old not in t:
        old = "  stableExpKey,"
        new = "  stableExpKey,\n  stableExpEventKey,"
    if old not in t:
        raise SystemExit("import block not found")
    t = t.replace(old, new, 1)
    print("import ok")
else:
    print("import already")

if "wasPosted," not in t and "wasPosted }" not in t:
    if "claimPosted," in t:
        t = t.replace("  claimPosted,", "  claimPosted,\n  wasPosted,", 1)
        print("wasPosted import")

old_block = (
    "  if (!(await claimPosted(batchKey))) {\n"
    "    console.log('Experiments batch CLAIM skip', batchKey);\n"
    "    return true;\n"
    "  }\n"
    "  const sections = [];\n"
)

if "filterEv" not in t and old_block in t:
    new_block = (
        "  if (!(await claimPosted(batchKey))) {\n"
        "    console.log('Experiments batch CLAIM skip', batchKey);\n"
        "    return true;\n"
        "  }\n\n"
        "  // Per-event filter: drop items already sent (partial batch recovery)\n"
        "  const filterEv = async (list, changeType) => {\n"
        "    const out = [];\n"
        "    for (const e of list || []) {\n"
        "      const id = typeof e === 'string' ? e : e && e.id;\n"
        "      if (!id) {\n"
        "        out.push(e);\n"
        "        continue;\n"
        "      }\n"
        "      const ek = 'expev:' + stableExpEventKey(bn, changeType, e);\n"
        "      if (await wasPosted(ek)) continue;\n"
        "      out.push(e);\n"
        "    }\n"
        "    return out;\n"
        "  };\n"
        "  exp = {\n"
        "    ...exp,\n"
        "    added: await filterEv(exp.added, 'added'),\n"
        "    modified: await filterEv(exp.modified, 'modified'),\n"
        "    removed: await filterEv(exp.removed, 'removed'),\n"
        "    categoryChanged: await filterEv(exp.categoryChanged, 'category'),\n"
        "  };\n"
        "  const total =\n"
        "    exp.added.length +\n"
        "    exp.modified.length +\n"
        "    exp.removed.length +\n"
        "    (exp.categoryChanged || []).length;\n"
        "  if (!total) {\n"
        "    await markPosted(batchKey);\n"
        "    console.log('Experiments all events already sent — skip');\n"
        "    return true;\n"
        "  }\n\n"
        "  const sections = [];\n"
    )
    t = t.replace(old_block, new_block, 1)
    print("filter inject ok")
elif "filterEv" in t:
    print("filter already")
else:
    raise SystemExit("claim block not found")

old_ok = (
    "  if (ok) await markPosted(batchKey);\n"
    "  else {\n"
    "    console.warn('Experiments webhook failed — batch NOT locked');\n"
    "    await markFailed(batchKey, 'experiments batch send failed');\n"
    "  }"
)
new_ok = (
    "  if (ok) {\n"
    "    await markPosted(batchKey);\n"
    "    const markList = async (list, changeType) => {\n"
    "      for (const e of list || []) {\n"
    "        const id = typeof e === 'string' ? e : e && e.id;\n"
    "        if (!id) continue;\n"
    "        await markPosted('expev:' + stableExpEventKey(bn, changeType, e));\n"
    "      }\n"
    "    };\n"
    "    await markList(exp.added, 'added');\n"
    "    await markList(exp.modified, 'modified');\n"
    "    await markList(exp.removed, 'removed');\n"
    "    await markList(exp.categoryChanged, 'category');\n"
    "  } else {\n"
    "    console.warn('Experiments webhook failed — batch NOT locked');\n"
    "    await markFailed(batchKey, 'experiments batch send failed');\n"
    "  }"
)
if "markList" not in t and old_ok in t:
    t = t.replace(old_ok, new_ok, 1)
    print("per-event mark ok")
elif "markList" in t:
    print("mark already")
else:
    # try ascii hyphen variants
    print("mark block variant — checking")
    if "if (ok) await markPosted(batchKey);" in t:
        raise SystemExit("mark block shape differs")

p.write_text(t)
print("wrote notify.js", len(t))
