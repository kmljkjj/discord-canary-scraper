#!/usr/bin/env python3
"""Apply transactional notify gates to src/index.js."""
from pathlib import Path

p = Path("src/index.js")
t = p.read_text()
assert len(t) > 15000 and "Canary Pulse" in t

t = t.replace("=== Canary Pulse v11.7 ===", "=== Canary Pulse v11.8 ===")
t = t.replace(
    "priority pipeline + integrity gates",
    "transactional notify + integrity",
)

if "const okN = await notifyNormal" in t:
    t = t.replace("const okN = await notifyNormal", "okN = await notifyNormal", 1)
    t = t.replace(
        "if (process.env.DISCORD_WEBHOOK_URL) {\n    try {",
        "let okN = true;\n  if (process.env.DISCORD_WEBHOOK_URL) {\n    try {",
        1,
    )
    print("okN hoisted")

old_mark = """      if (okN) {
        for (const k of Object.keys(strDiff.added)) knownStr.add(k);
        for (const k of Object.keys(rtDiff.added)) knownRt.add(k);
      } else {
        console.warn('NORMAL webhook failed \u2014 NOT marking known str/rt');
      }
      if (isNewBuild && !alreadyBuild) {
        await markBuild(build.buildNumber);
        alreadyBuild = true;
        console.log('BUILD marked after successful extract', build.buildNumber);
      }"""

# Try both em-dash and regular dash variants
variants = [
    old_mark,
    old_mark.replace("\u2014", "—"),
    old_mark.replace("\u2014", "-"),
]

new_mark = """      if (okN) {
        for (const k of Object.keys(strDiff.added)) knownStr.add(k);
        for (const k of Object.keys(rtDiff.added)) knownRt.add(k);
      } else {
        console.warn('NORMAL webhook failed — NOT marking known str/rt');
      }
      if (isNewBuild && !alreadyBuild && okN) {
        await markBuild(build.buildNumber);
        alreadyBuild = true;
        console.log('BUILD marked after successful notifies', build.buildNumber);
      } else if (isNewBuild && !alreadyBuild && !okN) {
        console.warn('BUILD NOT marked — normal webhook failed (will retry)');
      }"""

marked = False
for v in variants:
    if v in t:
        t = t.replace(v, new_mark, 1)
        marked = True
        print("markBuild gated")
        break
if not marked:
    # looser: only gate the markBuild call after successful extract
    needle = "console.log('BUILD marked after successful extract', build.buildNumber);"
    if needle in t:
        t = t.replace(
            "if (isNewBuild && !alreadyBuild) {\n        await markBuild(build.buildNumber);\n        alreadyBuild = true;\n        console.log('BUILD marked after successful extract', build.buildNumber);\n      }",
            "if (isNewBuild && !alreadyBuild && okN) {\n        await markBuild(build.buildNumber);\n        alreadyBuild = true;\n        console.log('BUILD marked after successful notifies', build.buildNumber);\n      } else if (isNewBuild && !alreadyBuild && !okN) {\n        console.warn('BUILD NOT marked — normal webhook failed (will retry)');\n      }",
            1,
        )
        print("markBuild gated (loose)")
    else:
        print("markBuild MISS")

old_save = """  await Promise.all([
    saveKnownIds(KNOWN_EXP, knownExp, 8000),
    saveKnownIds(KNOWN_STR, knownStr, 50000),
    saveKnownIds(KNOWN_RT, knownRt, 10000),
    saveLastMap(LAST_EXTRACT_STR, extractedStrings, build.buildNumber),
    saveLastMap(LAST_EXTRACT_RT, nextRt, build.buildNumber),
    saveLastMap(LAST_EXTRACT_EXP, nextExpSnap, build.buildNumber),
  ]);"""

new_save = """  // Transactional: do not advance last_extract str/rt if notify failed
  const strRtOk = typeof okN === 'undefined' ? true : okN;
  const tasks = [
    saveKnownIds(KNOWN_EXP, knownExp, 8000),
    saveKnownIds(KNOWN_STR, knownStr, 50000),
    saveKnownIds(KNOWN_RT, knownRt, 10000),
    saveLastMap(LAST_EXTRACT_EXP, nextExpSnap, build.buildNumber),
  ];
  if (strRtOk) {
    tasks.push(saveLastMap(LAST_EXTRACT_STR, extractedStrings, build.buildNumber));
    tasks.push(saveLastMap(LAST_EXTRACT_RT, nextRt, build.buildNumber));
  } else {
    console.warn('SKIP last_extract strings/routes — notify failed (retry next run)');
  }
  await Promise.all(tasks);"""

if old_save in t:
    t = t.replace(old_save, new_save)
    print("last_extract gated")
else:
    print("save MISS")

p.write_text(t)
print("done", len(t))
