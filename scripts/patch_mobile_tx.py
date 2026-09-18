#!/usr/bin/env python3
"""Apply transactional notify + degraded guards to mobile_*.js"""
from pathlib import Path

def patch_from_files(src: str) -> str:
    old_pw = '''async function postWebhook(payload) {
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
}'''
    new_pw = '''async function postWebhook(payload) {
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
        console.warn('Webhook', res.status, 'retry');
        await new Promise((r) => setTimeout(r, Math.min(10000, 400 * 2 ** attempt)));
        continue;
      }
      if (!res.ok) {
        console.warn('Webhook', res.status, await res.text());
        return false;
      }
      console.log('Webhook OK');
      await new Promise((r) => setTimeout(r, 400));
      return true;
    } catch (e) {
      console.warn('Webhook network', e.message);
      await new Promise((r) => setTimeout(r, Math.min(10000, 400 * 2 ** attempt)));
    }
  }
  return false;
}'''
    if old_pw not in src:
        if 'return false' in src and 'NOTIFY_FAIL' in src:
            print('from_files already patched')
            return src
        raise SystemExit('postWebhook block not found in mobile_from_files.js')
    src = src.replace(old_pw, new_pw)

    old_main = '''  const newExps = findings.experiments.filter((e) => !known.has(e.id));
  for (const e of findings.experiments) known.add(e.id);

  const prevStrings = previous?.strings || {};
  const stringDiff = { added: {} };
  const prevCount = Object.keys(prevStrings).length;
  if (prevCount >= 20) {
    for (const [k, v] of Object.entries(findings.strings)) {
      if (!(k in prevStrings)) stringDiff.added[k] = v;
    }
    if (Object.keys(stringDiff.added).length > 80) {
      console.log('String flood \u2014 skip notify, reseed');
      stringDiff.added = {};
    }
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

  console.log('New mobile experiments:', newExps.length);
  console.log('New mobile strings:', Object.keys(stringDiff.added).length);

  await notify(newExps, stringDiff, meta);
  console.log('=== Mobile files done ===');
}'''
    # Try both em-dash and ascii dash variants
    old_main_ascii = old_main.replace('\u2014', '\u2014')
    if old_main not in src:
        # try with actual em dash from file
        old_main2 = old_main.replace('\\u2014', '\u2014') if False else None
        # load flexible
        import re
        m = re.search(
            r"  const newExps = findings\.experiments\.filter\(\(e\) => !known\.has\(e\.id\)\);.*?console\.log\('=== Mobile files done ==='\);\n}",
            src,
            re.S,
        )
        if not m:
            raise SystemExit('main tail not found in mobile_from_files.js')
        old_block = m.group(0)
    else:
        old_block = old_main

    new_main = '''  const newExps = findings.experiments.filter((e) => e?.id && !known.has(String(e.id)));

  const prevExpN = (previous?.experiments || []).length;
  const prevStrN = Object.keys(previous?.strings || {}).length;
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

  const prevStrings = previous?.strings || {};
  const stringDiff = { added: {} };
  const prevCount = Object.keys(prevStrings).length;
  if (prevCount >= 20) {
    for (const [k, v] of Object.entries(findings.strings)) {
      if (!(k in prevStrings)) stringDiff.added[k] = v;
    }
    if (Object.keys(stringDiff.added).length > 80) {
      console.log('String flood - skip notify, reseed');
      stringDiff.added = {};
    }
  }

  console.log('New mobile experiments:', newExps.length);
  console.log('New mobile strings:', Object.keys(stringDiff.added).length);

  const hasDiff = newExps.length > 0 || Object.keys(stringDiff.added).length > 0;
  let notifyOk = true;
  if (hasDiff && WEBHOOK_URL) {
    notifyOk = await notify(newExps, stringDiff, meta);
    if (!notifyOk) {
      console.warn('NOTIFY_FAIL: not advancing known/state - will retry next run');
      process.exit(2);
    }
  } else if (hasDiff && !WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL - skip notify, still seed state');
  }

  for (const e of findings.experiments) {
    if (e?.id) known.add(String(e.id));
  }

  const state = {
    scrapedAt: new Date().toISOString(),
    sourceCommit: meta.commit,
    sourceMessage: meta.message,
    experimentCount: findings.experiments.length,
    stringCount: Object.keys(findings.strings).length,
    newExperimentCount: newExps.length,
    notifyOk,
    experiments: findings.experiments,
    strings: findings.strings,
  };
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
  await saveKnown(known);

  console.log('=== Mobile files done ===');
}'''
    src = src.replace(old_block, new_main)

    # Replace notify to return boolean - locate and rebuild
    n0 = src.find('async function notify(newExps, stringDiff, meta) {')
    n1 = src.find('async function main() {', n0)
    if n0 < 0 or n1 < 0:
        raise SystemExit('notify bounds from_files')
    new_notify = '''async function notify(newExps, stringDiff, meta) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL - skip notify');
    return true;
  }
  if (!newExps.length && !Object.keys(stringDiff.added || {}).length) return true;

  let ok = true;
  if (newExps.length) {
    const r = await postWebhook({
      embeds: [
        {
          title: 'New Mobile Experiments',
          description: newExps
            .slice(0, 20)
            .map((e) => '• `' + e.id + '` (' + (e.type || e.kind || '?') + ')')
            .join('\n'),
          color: 0x5865f2,
          footer: { text: 'Mobile · ' + meta.commit + ' · +' + String(newExps.length) },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    if (!r) ok = false;
  }

  for (const exp of newExps.slice(0, MAX_NOTIFY_EXP)) {
    const r = await postWebhook({ embeds: [experimentEmbed(exp, meta)] });
    if (!r) ok = false;
  }

  const strLines = Object.entries(stringDiff.added || {})
    .slice(0, 40)
    .map(([k, v]) => '+ ' + k + ': ' + String(v).slice(0, 80));
  if (strLines.length) {
    const r = await postWebhook({
      embeds: [
        {
          title: 'Strings (Mobile)',
          description: '_Added_\n```\n' + strLines.join('\n').slice(0, 3500) + '\n```',
          color: 0x57f287,
          footer: { text: 'Mobile files · ' + meta.commit },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    if (!r) ok = false;
  }
  return ok;
}

'''
    src = src[:n0] + new_notify + src[n1:]
    return src


def patch_versions(src: str) -> str:
    old_pw = '''async function postWebhook(payload) {
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
}'''
    new_pw = '''async function postWebhook(payload) {
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
        console.warn('Webhook', res.status, 'retry');
        await new Promise((r) => setTimeout(r, Math.min(10000, 400 * 2 ** attempt)));
        continue;
      }
      if (!res.ok) {
        console.warn('Webhook', res.status, await res.text());
        return false;
      }
      console.log('Webhook OK');
      await new Promise((r) => setTimeout(r, 400));
      return true;
    } catch (e) {
      console.warn('Webhook network', e.message);
      await new Promise((r) => setTimeout(r, Math.min(10000, 400 * 2 ** attempt)));
    }
  }
  return false;
}'''
    if old_pw not in src:
        if 'NOTIFY_FAIL' in src and 'return false' in src:
            print('versions already patched')
            return src
        raise SystemExit('postWebhook not found in mobile_versions.js')
    src = src.replace(old_pw, new_pw)

    n0 = src.find('async function notify(changes) {')
    n1 = src.find('async function main() {', n0)
    if n0 < 0 or n1 < 0:
        raise SystemExit('notify bounds versions')
    new_notify = '''async function notify(changes) {
  if (!WEBHOOK_URL || !changes.length) return true;
  let ok = true;
  const summaryLines = changes.map((ch) => {
    const c = ch.channel;
    const arrow =
      ch.type === 'updated' && ch.previous
        ? ch.previous.version + ' → **' + c.version + '**'
        : '**' + c.version + '**';
    return '• **' + c.platform + '/' + c.channel + '** ' + arrow + (c.build ? ' · build `' + c.build + '`' : '');
  });
  const r0 = await postWebhook({
    embeds: [{
      title: 'New Discord Mobile Build',
      description: summaryLines.join('\n'),
      color: 0x5865f2,
      footer: { text: 'Mobile · versions' },
      timestamp: new Date().toISOString(),
    }],
  });
  if (!r0) ok = false;
  for (const ch of changes) {
    const c = ch.channel;
    const lines = [
      '**' + c.platform.toUpperCase() + '** · `' + c.channel + '`',
      ch.type === 'updated'
        ? '* ' + ch.previous.version + ' → **' + c.version + '**'
        : '* Version **' + c.version + '**',
    ];
    if (c.build) lines.push('* Build **' + c.build + '**');
    if (c.commit) lines.push('* Commit `' + String(c.commit).slice(0, 12) + '`');
    if (c.releaseName) lines.push('* `' + c.releaseName + '`');
    if (c.source) lines.push('Source: **' + c.source + '**');
    if (c.releaseDate) lines.push('Released: ' + c.releaseDate);
    if (c.note) lines.push(c.note.slice(0, 180));
    if (c.storeUrl) lines.push(c.storeUrl);
    const r = await postWebhook({
      embeds: [{
        title: 'Mobile ' + c.platform.toUpperCase() + ' · ' + c.channel,
        description: lines.join('\n'),
        color: colorFor(c.channel),
        footer: { text: 'Mobile · ' + c.platform + ' · ' + c.channel },
        timestamp: new Date().toISOString(),
      }],
    });
    if (!r) ok = false;
  }
  return ok;
}

'''
    src = src[:n0] + new_notify + src[n1:]

    import re
    m = re.search(
        r"  const \{ changes, notified \} = detectChanges\(previous, snapshot\);.*?console\.log\('=== Mobile versions done ==='\);\n}",
        src,
        re.S,
    )
    if not m:
        raise SystemExit('versions main tail not found')
    new_main = '''  const { changes, notified } = detectChanges(previous, snapshot);

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

  let notifyOk = true;
  if (!hadPriorState) {
    console.log('Seed run - no webhook; recording current fingerprints');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  } else if (willNotify) {
    notifyOk = await notify(changes);
    if (!notifyOk) {
      snapshot.history = history.slice(0, 100);
      snapshot.previousScrapedAt = previous?.scrapedAt || null;
      snapshot.notifiedFingerprints = [...notified].sort().slice(-2000);
      snapshot.changes = [];
      snapshot.paused = false;
      snapshot.notifyOk = false;
      await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });
      console.warn('NOTIFY_FAIL: fingerprints NOT advanced - will retry next run');
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
  snapshot.changes = willNotify && notifyOk
    ? changes.map((c) => ({
        type: c.type,
        key: channelKey(c.channel),
        from: c.previous?.version || null,
        to: c.channel.version,
        build: c.channel.build || null,
      }))
    : [];
  snapshot.paused = false;
  snapshot.notifyOk = notifyOk;

  await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });
  console.log('=== Mobile versions done ===');
}'''
    src = src[: m.start()] + new_main + src[m.end() :]
    return src


def main():
    ff = Path('src/mobile_from_files.js')
    mv = Path('src/mobile_versions.js')
    ff.write_text(patch_from_files(ff.read_text()))
    mv.write_text(patch_versions(mv.read_text()))
    print('patched', ff.stat().st_size, mv.stat().st_size)

if __name__ == '__main__':
    main()
