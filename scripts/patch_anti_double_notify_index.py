#!/usr/bin/env python3
from pathlib import Path

def patch_notify():
    p = Path('src/lib/notify.js')
    t = p.read_text()
    if 'expbatch:' in t and 'claimPosted' in t:
        print('notify already')
        return True
    t = t.replace(
        "const { wasPosted, markPosted, payloadFingerprint } = require('./webhook_dedupe');",
        "const { wasPosted, markPosted, claimPosted, payloadFingerprint, stableExpKey, stableMapKey } = require('./webhook_dedupe');",
    )
    old_post = """  const fp = payloadFingerprint(body);
  if (await wasPosted(fp)) {
    console.log('webhook DEDUPE skip', body.embeds?.[0]?.title || fp);
    return true;
  }"""
    new_post = """  const fp = payloadFingerprint(body);
  if (!(await claimPosted(fp))) {
    console.log('webhook CLAIM skip', body.embeds?.[0]?.title || fp);
    return true;
  }"""
    if old_post not in t:
        if 'claimPosted(fp)' in t:
            print('post already claim')
        else:
            print('post miss')
            return False
    else:
        t = t.replace(old_post, new_post, 1)
    old = "async function sendExperiments(webhookUrl, bn, exp, ts) {\n  const sections = [];\n"
    new = (
        "async function sendExperiments(webhookUrl, bn, exp, ts) {\n"
        "  const batchKey = 'expbatch:' + stableExpKey(bn, exp);\n"
        "  if (!(await claimPosted(batchKey))) {\n"
        "    console.log('Experiments batch CLAIM skip', batchKey);\n"
        "    return true;\n"
        "  }\n"
        "  await markPosted(batchKey);\n\n"
        "  const sections = [];\n"
    )
    if 'expbatch:' not in t:
        if old not in t:
            print('sendExperiments miss')
            return False
        t = t.replace(old, new, 1)
    old2 = "async function sendMapDiff(webhookUrl, bn, diff, ts, kind) {\n  const isRoutes = kind === 'Routes';\n"
    new2 = (
        "async function sendMapDiff(webhookUrl, bn, diff, ts, kind) {\n"
        "  const batchKey = 'mapbatch:' + stableMapKey(bn, kind, diff);\n"
        "  if (!(await claimPosted(batchKey))) {\n"
        "    console.log(kind, 'batch CLAIM skip', batchKey);\n"
        "    return true;\n"
        "  }\n"
        "  await markPosted(batchKey);\n\n"
        "  const isRoutes = kind === 'Routes';\n"
    )
    if 'mapbatch:' not in t:
        if old2 not in t:
            print('sendMapDiff miss')
            return False
        t = t.replace(old2, new2, 1)
    p.write_text(t)
    print('notify patched')
    return True

def patch_index():
    p = Path('src/index.js')
    t = p.read_text()
    if 'LAST_RUN_META' in t and 'COOLDOWN SKIP' in t:
        print('index already')
        return True
    if "const ANNOUNCED = path.join(DATA, 'announced_builds.json');" in t and 'LAST_RUN_META' not in t:
        t = t.replace(
            "const ANNOUNCED = path.join(DATA, 'announced_builds.json');",
            "const ANNOUNCED = path.join(DATA, 'announced_builds.json');\nconst LAST_RUN_META = path.join(DATA, 'last_run_meta.json');",
            1,
        )
    old = """  if (
    !isNewBuild &&
    prev.initialized &&
    !needsExtractSeed &&
    Object.keys(lastExp).length > 40
  ) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }"""
    new = """  try {
    if (await fs.pathExists(LAST_RUN_META)) {
      const meta = await fs.readJson(LAST_RUN_META);
      const same = String(meta.buildNumber || '') === String(build.buildNumber);
      const age = Date.now() - Number(meta.ts || 0);
      if (same && age >= 0 && age < 3 * 60 * 1000 && meta.ok && !needsExtractSeed) {
        console.log('COOLDOWN SKIP', build.buildNumber, Math.round(age / 1000) + 's since last success');
        process.exit(0);
      }
    }
  } catch (e) {
    console.warn('last_run_meta read', e.message);
  }

  if (
    !isNewBuild &&
    prev.initialized &&
    !needsExtractSeed &&
    Object.keys(lastExp).length > 40
  ) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }"""
    if old not in t:
        print('FAST SKIP miss')
        return False
    t = t.replace(old, new, 1)
    t = t.replace(
        "console.log('=== Done', Date.now() - t0 + 'ms ===');",
        """try {
    await fs.writeJson(LAST_RUN_META, {
      buildNumber: String(build.buildNumber),
      ts: Date.now(),
      ok: true,
      versionHash: build.versionHash || null,
    });
  } catch (e) {
    console.warn('last_run_meta write', e.message);
  }

  console.log('=== Done', Date.now() - t0 + 'ms ===');""",
        1,
    )
    t = t.replace(
        'Canary Pulse v11.5 (apex/legacy · snapshots · richer routes)',
        'Canary Pulse v11.6 (anti-double under FORCE dispatch)',
        1,
    )
    p.write_text(t)
    print('index patched')
    return True

if __name__ == '__main__':
    import sys
    sys.exit(0 if patch_notify() and patch_index() else 1)
