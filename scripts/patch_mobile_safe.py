#!/usr/bin/env python3
"""Minimal safe transactional patches for mobile_*.js"""
from pathlib import Path

def patch_post_webhook(src: str) -> str:
    old = """async function postWebhook(payload) {
  if (!WEBHOOK_URL) return;
  const body = {
    username: BOT_NAME,
    avatar_url: BOT_AVATAR,
    ...payload,
  };
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.warn('Webhook', res.status, await res.text());
  else console.log('Webhook OK');
  await new Promise((r) => setTimeout(r, 400));
}"""
    new = """async function postWebhook(payload) {
  if (!WEBHOOK_URL) return false;
  const body = {
    username: BOT_NAME,
    avatar_url: BOT_AVATAR,
    ...payload,
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 30000,
      });
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') || 0);
        const wait = ra > 0 ? ra * 1000 : Math.min(15000, 500 * 2 ** attempt);
        console.warn('Webhook 429 wait', wait + 'ms');
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, Math.min(10000, 400 * 2 ** attempt)));
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        console.warn('Webhook', res.status, t);
        throw new Error('Webhook HTTP ' + res.status);
      }
      console.log('Webhook OK');
      await new Promise((r) => setTimeout(r, 400));
      return true;
    } catch (e) {
      if (String(e.message || e).startsWith('Webhook HTTP')) throw e;
      console.warn('Webhook network', e.message);
      await new Promise((r) => setTimeout(r, Math.min(10000, 400 * 2 ** attempt)));
    }
  }
  throw new Error('Webhook failed after retries');
}"""
    if old not in src:
        if 'Webhook failed after retries' in src:
            return src
        raise SystemExit('postWebhook not found')
    return src.replace(old, new)

def patch_from_files(src: str) -> str:
    src = patch_post_webhook(src)
    if 'MOBILE_FILES_DEGRADED' in src:
        return src
    needle = "  const newExps = findings.experiments.filter((e) => !known.has(e.id));\n  for (const e of findings.experiments) known.add(e.id);"
    if needle not in src:
        raise SystemExit('newExps block not found')
    src = src.replace(
        needle,
        "  const newExps = findings.experiments.filter((e) => e && e.id && !known.has(String(e.id)));",
        1,
    )
    old_state = """  const state = {
    scrapedAt: new Date().toISOString(),
    sourceCommit: meta.commit,
    sourceMessage: meta.message,
    experimentCount: findings.experiments.length,
    stringCount: Object.keys(findings.strings).length,
    newExperimentCount: newExps.length,
    experiments: findings.experiments,
    strings: findings.strings,
  };
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
  await saveKnown(known);

  console.log('New mobile experiments:', newExps.length);
  console.log('New mobile strings:', Object.keys(stringDiff.added).length);

  await notify(newExps, stringDiff, meta);
  console.log('=== Mobile files done ===');
}"""
    new_state = """  console.log('New mobile experiments:', newExps.length);
  console.log('New mobile strings:', Object.keys(stringDiff.added).length);

  const prevExpN = (previous && previous.experiments ? previous.experiments.length : 0);
  const prevStrN = Object.keys((previous && previous.strings) || {}).length;
  const curExpN = findings.experiments.length;
  const curStrN = Object.keys(findings.strings).length;
  if (prevExpN >= 30 && curExpN < Math.max(5, prevExpN * 0.5)) {
    console.error('MOBILE_FILES_DEGRADED: experiments too low', { prevExpN, curExpN });
    process.exit(1);
  }
  if (prevStrN >= 100 && curStrN < Math.max(20, prevStrN * 0.5)) {
    console.error('MOBILE_FILES_DEGRADED: strings too low', { prevStrN, curStrN });
    process.exit(1);
  }

  const hasDiff = newExps.length > 0 || Object.keys(stringDiff.added).length > 0;
  if (hasDiff && WEBHOOK_URL) {
    try {
      await notify(newExps, stringDiff, meta);
    } catch (e) {
      console.warn('NOTIFY_FAIL:', e.message, '- not advancing known/state');
      process.exit(2);
    }
  } else if (hasDiff && !WEBHOOK_URL) {
    console.log('No webhook - seed state without notify');
  }

  for (const e of findings.experiments) {
    if (e && e.id) known.add(String(e.id));
  }

  const state = {
    scrapedAt: new Date().toISOString(),
    sourceCommit: meta.commit,
    sourceMessage: meta.message,
    experimentCount: findings.experiments.length,
    stringCount: Object.keys(findings.strings).length,
    newExperimentCount: newExps.length,
    experiments: findings.experiments,
    strings: findings.strings,
  };
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
  await saveKnown(known);

  console.log('=== Mobile files done ===');
}"""
    if old_state not in src:
        raise SystemExit('state block not found in from_files')
    return src.replace(old_state, new_state)

def patch_versions(src: str) -> str:
    src = patch_post_webhook(src)
    if 'NOTIFY_FAIL' in src and 'fingerprints NOT advanced' in src:
        return src
    old = """  const { changes, notified } = detectChanges(previous, snapshot);

  for (const c of snapshot.channels) {
    const fp = versionFingerprint(c);
    if (fp) notified.add(fp);
  }
  for (const fp of previous?.notifiedFingerprints || []) {
    notified.add(String(fp));
  }
  for (const ch of changes) {
    if (ch.fp) notified.add(ch.fp);
  }

  const history = previous?.history || [];
  const willNotify = hadPriorState && changes.length > 0;

  if (willNotify) {
    for (const ch of changes) {
      history.unshift({
        at: snapshot.scrapedAt,
        key: channelKey(ch.channel),
        from: ch.previous?.version || null,
        to: ch.channel.version,
        build: ch.channel.build || null,
      });
    }
  }

  snapshot.history = history.slice(0, 100);
  snapshot.previousScrapedAt = previous?.scrapedAt || null;
  snapshot.notifiedFingerprints = [...notified].sort().slice(-2000);
  snapshot.changes = willNotify
    ? changes.map((c) => ({
        type: c.type,
        key: channelKey(c.channel),
        from: c.previous?.version || null,
        to: c.channel.version,
        build: c.channel.build || null,
      }))
    : [];
  snapshot.paused = false;

  await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });

  for (const c of snapshot.channels) {
    console.log(
      `  ${c.platform}/${c.channel}: ${c.version || 'n/a'}${c.build ? ` [${c.build}]` : ''}`,
    );
  }
  console.log(
    'Candidates:',
    changes.length,
    '| hadPriorState:',
    !!hadPriorState,
    '| fingerprints:',
    notified.size,
  );

  if (!hadPriorState) {
    console.log('Seed run — no webhook');
  } else if (willNotify) {
    await notify(changes);
  } else {
    console.log('No version bumps — no webhook');
  }
  console.log('=== Mobile versions done ===');
}"""
    new = """  const { changes, notified } = detectChanges(previous, snapshot);

  for (const fp of previous?.notifiedFingerprints || []) {
    notified.add(String(fp));
  }

  const history = previous?.history || [];
  const willNotify = hadPriorState && changes.length > 0 && !!WEBHOOK_URL;

  for (const c of snapshot.channels) {
    console.log(
      `  ${c.platform}/${c.channel}: ${c.version || 'n/a'}${c.build ? ` [${c.build}]` : ''}`,
    );
  }
  console.log(
    'Candidates:',
    changes.length,
    '| hadPriorState:',
    !!hadPriorState,
    '| prior fingerprints:',
    notified.size,
  );

  if (!hadPriorState) {
    console.log('Seed run - no webhook; recording fingerprints');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  } else if (willNotify) {
    try {
      await notify(changes);
    } catch (e) {
      snapshot.history = history.slice(0, 100);
      snapshot.previousScrapedAt = previous?.scrapedAt || null;
      snapshot.notifiedFingerprints = [...notified].sort().slice(-2000);
      snapshot.changes = [];
      snapshot.paused = false;
      snapshot.notifyOk = false;
      await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });
      console.warn('NOTIFY_FAIL:', e.message, '- fingerprints NOT advanced');
      process.exit(2);
    }
    for (const ch of changes) {
      if (ch.fp) notified.add(ch.fp);
      history.unshift({
        at: snapshot.scrapedAt,
        key: channelKey(ch.channel),
        from: ch.previous?.version || null,
        to: ch.channel.version,
        build: ch.channel.build || null,
      });
    }
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  } else {
    console.log('No version bumps - no webhook');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  }

  snapshot.history = history.slice(0, 100);
  snapshot.previousScrapedAt = previous?.scrapedAt || null;
  snapshot.notifiedFingerprints = [...notified].sort().slice(-2000);
  snapshot.changes = willNotify
    ? changes.map((c) => ({
        type: c.type,
        key: channelKey(c.channel),
        from: c.previous?.version || null,
        to: c.channel.version,
        build: c.channel.build || null,
      }))
    : [];
  snapshot.paused = false;
  snapshot.notifyOk = true;

  await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });
  console.log('=== Mobile versions done ===');
}"""
    if old not in src:
        raise SystemExit('versions main not found')
    return src.replace(old, new)

def main():
    ff = Path('src/mobile_from_files.js')
    mv = Path('src/mobile_versions.js')
    ff.write_text(patch_from_files(ff.read_text()))
    mv.write_text(patch_versions(mv.read_text()))
    print('patched', ff.stat().st_size, mv.stat().st_size)

if __name__ == '__main__':
    main()
