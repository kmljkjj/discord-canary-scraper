#!/usr/bin/env python3
"""One-shot / re-runnable: anti double-notify for Datamining client."""
from pathlib import Path
import re

def patch_index():
    p = Path("src/index.js")
    t = p.read_text()
    pat = re.compile(
        r"let flashSent = false;\s*if \(isNewBuild && process\.env\.DISCORD_WEBHOOK_URL\) \{.*?\n  \}",
        re.S,
    )
    new = """  // Claim build BEFORE notify so parallel/queued runs don't double-post
  let alreadyBuild = await wasBuildAnnounced(build.buildNumber);
  let flashSent = false;
  if (isNewBuild && process.env.DISCORD_WEBHOOK_URL) {
    if (alreadyBuild) {
      console.log('FLASH skip — build already announced', build.buildNumber);
    } else {
      await markBuild(build.buildNumber);
      alreadyBuild = true;
      try {
        await flashBuild(process.env.DISCORD_WEBHOOK_URL, build, {
          gap,
          prevBuild: prevBuildNum,
        });
        flashSent = true;
        console.log('FLASH', build.buildNumber, Date.now() - t0 + 'ms');
      } catch (e) {
        console.warn('FLASH failed', e.message);
      }
    }
  }"""
    m = pat.search(t)
    if not m:
        if "FLASH skip" in t or "already announced" in t:
            print("index: already patched")
            return True
        print("index: flash pattern NOT found")
        return False
    t = t[: m.start()] + new + t[m.end() :]
    print("index: flash patched")
    old2 = "  const alreadyBuild = await wasBuildAnnounced(build.buildNumber);\n  const shouldAnnounceBuild = isNewBuild && !alreadyBuild && !flashSent;"
    new2 = "  alreadyBuild = (typeof alreadyBuild !== 'undefined' && alreadyBuild) || (await wasBuildAnnounced(build.buildNumber));\n  const shouldAnnounceBuild = isNewBuild && !alreadyBuild && !flashSent;"
    if old2 in t:
        t = t.replace(old2, new2, 1)
        print("index: later patched")
    t = t.replace("Canary Pulse v11.1", "Canary Pulse v11.2 (anti-double notify)", 1)
    p.write_text(t)
    return True


def patch_notify():
    p = Path("src/lib/notify.js")
    t = p.read_text()
    if "notify_dedupe.json" in t and "payloadFingerprint" in t:
        print("notify: already patched")
        return True
    helpers = """
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const DEDUPE_FILE = path.join(__dirname, '..', '..', 'data', 'notify_dedupe.json');
async function wasPosted(fp) {
  try {
    if (!(await fs.pathExists(DEDUPE_FILE))) return false;
    const d = await fs.readJson(DEDUPE_FILE);
    const ts = (d.fps || {})[fp];
    return ts ? Date.now() - Number(ts) < 6 * 3600 * 1000 : false;
  } catch {
    return false;
  }
}
async function markPosted(fp) {
  try {
    let d = { fps: {} };
    if (await fs.pathExists(DEDUPE_FILE)) d = await fs.readJson(DEDUPE_FILE);
    d.fps = d.fps || {};
    d.fps[fp] = Date.now();
    const cut = Date.now() - 12 * 3600 * 1000;
    for (const [k, v] of Object.entries(d.fps)) {
      if (Number(v) < cut) delete d.fps[k];
    }
    const keys = Object.keys(d.fps);
    if (keys.length > 400) {
      keys.sort((a, b) => d.fps[a] - d.fps[b]);
      for (const k of keys.slice(0, keys.length - 400)) delete d.fps[k];
    }
    await fs.ensureDir(path.dirname(DEDUPE_FILE));
    await fs.writeJson(DEDUPE_FILE, d);
  } catch (e) {
    console.warn('dedupe mark fail', e.message);
  }
}
function payloadFingerprint(body) {
  const embeds = body.embeds || [];
  const core = embeds.map((e) => ({
    t: e.title || '',
    d: String(e.description || '').slice(0, 240),
    f: (e.fields || [])
      .map((x) => String(x.name || '') + ':' + String(x.value || '').slice(0, 80))
      .join('|')
      .slice(0, 400),
  }));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ u: body.username, core }))
    .digest('hex')
    .slice(0, 20);
}
"""
    needle = "  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';\n"
    if needle not in t:
        print("notify: avatar needle missing")
        return False
    t = t.replace(needle, needle + helpers + "\n", 1)
    old_post = """async function post(url, body) {
  body.username = BOT;
  body.avatar_url = AVATAR;
  const payload = JSON.stringify(body);"""
    new_post = """async function post(url, body) {
  body.username = BOT;
  body.avatar_url = AVATAR;
  const fp = payloadFingerprint(body);
  if (await wasPosted(fp)) {
    console.log('webhook DEDUPE skip', body.embeds?.[0]?.title || fp);
    return true;
  }
  const payload = JSON.stringify(body);"""
    if old_post not in t:
        print("notify: post block missing")
        return False
    t = t.replace(old_post, new_post, 1)
    t = t.replace(
        """      if (res.ok) {
        await sleep(80);
        return true;
      }""",
        """      if (res.ok) {
        await markPosted(fp);
        await sleep(80);
        return true;
      }""",
        1,
    )
    p.write_text(t)
    print("notify: patched")
    return True


def patch_scrape():
    p = Path(".github/workflows/scrape.yml")
    t = p.read_text()
    if "notify_dedupe.json" in t:
        print("scrape: already has dedupe")
        return True
    if "data/announced_builds.json \\" in t:
        t = t.replace(
            "data/announced_builds.json \\",
            "data/announced_builds.json \\\n            data/notify_dedupe.json \\",
            1,
        )
        p.write_text(t)
        print("scrape: patched")
        return True
    print("scrape: announced line missing")
    return False


if __name__ == "__main__":
    ok = all([patch_index(), patch_notify(), patch_scrape()])
    raise SystemExit(0 if ok else 1)
