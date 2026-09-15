#!/usr/bin/env python3
from pathlib import Path

def patch_index():
    p = Path('src/index.js')
    t = p.read_text()
    if 'no flash webhook' in t or 'BUILD claimed (no flash webhook)' in t:
        print('index: already no-build')
        return True
    old = '''  // Claim build BEFORE notify so parallel/queued runs don't double-post
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
  }'''
    new = '''  // Claim build in state only — NO build webhook (focus: experiments / routes / strings)
  let alreadyBuild = await wasBuildAnnounced(build.buildNumber);
  let flashSent = false;
  if (isNewBuild) {
    if (alreadyBuild) {
      console.log('BUILD claim skip — already marked', build.buildNumber);
    } else {
      await markBuild(build.buildNumber);
      alreadyBuild = true;
      flashSent = true; // treat as announced so catalog build embed stays off
      console.log('BUILD claimed (no flash webhook)', build.buildNumber, Date.now() - t0 + 'ms');
    }
  }'''
    if old not in t:
        print('index: flash block missing')
        return False
    t = t.replace(old, new, 1)
    t = t.replace(
        '''      const okN = await notifyNormal({
        build,
        isNewBuild: shouldAnnounceBuild,
        strDiff,
        rtDiff,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });''',
        '''      const okN = await notifyNormal({
        build,
        isNewBuild: false, // never send build/catalog embed — only strings & routes
        strDiff,
        rtDiff,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });''',
        1,
    )
    for a, b in [
        ('Canary Pulse v11.3 (stable experiments)', 'Canary Pulse v11.4 (no build webhooks — exp/routes/strings only)'),
        ('Canary Pulse v11.2 (anti-double notify)', 'Canary Pulse v11.4 (no build webhooks — exp/routes/strings only)'),
        ('Canary Pulse v11.1', 'Canary Pulse v11.4 (no build webhooks)'),
    ]:
        if a in t:
            t = t.replace(a, b, 1)
            break
    p.write_text(t)
    print('index: patched')
    return True

def patch_notify():
    p = Path('src/lib/notify.js')
    t = p.read_text()
    if 'Build/catalog webhook disabled' in t:
        print('notify: already no-build')
        return True
    start = t.find('  if (isNewBuild && (nStr || nRt)) {')
    if start < 0:
        print('notify: catalog block missing')
        return False
    end = t.find('  if (nStr) {', start)
    if end < 0:
        print('notify: end marker missing')
        return False
    t = t[:start] + '  // Build/catalog webhook disabled — Strings + Routes only\n\n' + t[end:]
    p.write_text(t)
    print('notify: patched')
    return True

if __name__ == '__main__':
    ok = patch_index() and patch_notify()
    raise SystemExit(0 if ok else 1)
