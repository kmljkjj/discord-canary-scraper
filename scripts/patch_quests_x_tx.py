#!/usr/bin/env python3
"""Transactional notify fixes for quests.js and x_watch.js."""
from pathlib import Path

def patch_quests(src: str) -> str:
    if 'still pending' in src and 'NOTIFY_FAIL quest' in src:
        print('quests already patched')
        return src
    old = '''  const newQuests = isFirstRun ? [] : active.filter((q) => !prevIds.has(q.id));
  const allIds = Array.from(
    new Set([].concat(Array.from(prevIds), active.map((q) => q.id))),
  );

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      count: active.length,
      ids: isFirstRun ? active.map((q) => q.id) : allIds,
      quests: active.map((q) => ({
        id: q.id,
        name: q.name,
        expiresAt: q.expiresAt,
        videoUrl: q.videoUrl || null,
        heroImage: q.heroImage || null,
        rewardCount: (q.rewards || []).length,
      })),
    },
    { spaces: 2 },
  );

  if (isFirstRun) {
    console.log('Premier run \u2014 seed de', active.length, 'ids (pas de flood)');
    return;
  }

  console.log('Nouvelles qu\u00eates:', newQuests.length);
  for (const q of newQuests.slice(0, 15)) {
    await sendQuestWebhook(q);
  }
  console.log('\u2705 Qu\u00eates termin\u00e9');
}'''
    # Try unicode forms as in file
    candidates = [old]
    # actual file uses real unicode chars
    old2 = old.replace('\\u2014', '\u2014').replace('\\u00eates', '\u00eates').replace('\\u2705', '\u2705').replace('\\u00e9', '\u00e9')
    # simpler: regex match
    import re
    m = re.search(
        r"  const newQuests = isFirstRun \? \[\] : active\.filter\(\(q\) => !prevIds\.has\(q\.id\)\);.*?console\.log\('.*?Qu.*?termin.*?'\);\n}",
        src,
        re.S,
    )
    if not m:
        raise SystemExit('quests block not found')
    new = '''  const newQuests = isFirstRun ? [] : active.filter((q) => !prevIds.has(q.id));
  const questSnapshot = active.map((q) => ({
    id: q.id,
    name: q.name,
    expiresAt: q.expiresAt,
    videoUrl: q.videoUrl || null,
    heroImage: q.heroImage || null,
    rewardCount: (q.rewards || []).length,
  }));

  async function writeQuestState(ids) {
    await fs.writeJson(
      STATE_FILE,
      {
        scrapedAt: new Date().toISOString(),
        count: active.length,
        ids,
        quests: questSnapshot,
      },
      { spaces: 2 },
    );
  }

  if (isFirstRun) {
    await writeQuestState(active.map((q) => q.id));
    console.log('Premier run - seed de', active.length, 'ids (pas de flood)');
    return;
  }

  const known = new Set(prevIds);
  const pending = newQuests.slice();
  const batch = pending.slice(0, 15);
  console.log('Nouvelles quetes:', pending.length, '| notify batch:', batch.length);

  let sentOk = 0;
  let sentFail = 0;
  for (const q of batch) {
    const ok = await sendQuestWebhook(q);
    if (ok) {
      known.add(q.id);
      sentOk++;
    } else {
      sentFail++;
      console.warn('NOTIFY_FAIL quest', q.id, '- will retry next run');
    }
  }

  for (const q of active) {
    if (prevIds.has(q.id)) known.add(q.id);
  }

  await writeQuestState(Array.from(known));
  console.log('Quetes termine - sent', sentOk, 'failed', sentFail, 'still pending', pending.length - sentOk);
  if (sentFail > 0 && sentOk === 0 && batch.length > 0) {
    process.exitCode = 2;
  }
}'''
    return src[: m.start()] + new + src[m.end() :]


def patch_x_watch(src: str) -> str:
    if 'NOTIFY_FAIL x post' in src:
        print('x_watch already patched')
        return src
    old_x = '''  const toSend = fresh.slice(0, MAX_NOTIFY);
  for (const p of toSend) {
    await postWebhook(p);
    seen.add(String(p.id));
  }
  for (const p of fresh) seen.add(String(p.id));
  await saveSeen(seen);
  console.log('Done. Sent', toSend.length);
}'''
    new_x = '''  const toSend = fresh.slice(0, MAX_NOTIFY);
  let sentOk = 0;
  let sentFail = 0;
  for (const p of toSend) {
    const ok = await postWebhook(p);
    if (ok) {
      seen.add(String(p.id));
      sentOk++;
    } else {
      sentFail++;
      console.warn('NOTIFY_FAIL x post', p.id, '- will retry next run');
    }
  }
  // Do NOT mark unsent fresh posts as seen
  await saveSeen(seen);
  console.log('Done. Sent', sentOk, 'failed', sentFail, 'pending', fresh.length - sentOk);
  if (sentFail > 0 && sentOk === 0 && toSend.length > 0) {
    process.exitCode = 2;
  }
}'''
    if old_x not in src:
        raise SystemExit('x_watch toSend block not found')
    src = src.replace(old_x, new_x)

    old_pw = '''    console.log('webhook', res.status, p.id);
    if (!res.ok) console.warn(await res.text());
  } catch (e) {
    console.warn('webhook error', e.message);
  }
  await sleep(250);
}'''
    new_pw = '''    console.log('webhook', res.status, p.id);
    if (!res.ok) console.warn(await res.text());
    else ok = true;
  } catch (e) {
    console.warn('webhook error', e.message);
  }
  await sleep(250);
  return ok;
}'''
    if old_pw not in src:
        raise SystemExit('x_watch postWebhook end not found')
    # insert let ok = false before try
    if 'let ok = false;' not in src:
        src = src.replace(
            '''  if (p.image) body.embeds[0].image = { url: p.image };
  try {
    const res = await fetch(WEBHOOK, {''',
            '''  if (p.image) body.embeds[0].image = { url: p.image };
  let ok = false;
  try {
    const res = await fetch(WEBHOOK, {''',
        )
    src = src.replace(old_pw, new_pw)

    src = src.replace(
        "console.warn('X watch error (soft):', e.message || e);\n  process.exit(0);",
        "console.error('X watch error:', e.message || e);\n  process.exit(1);",
    )
    return src


def main():
    q = Path('src/quests.js')
    x = Path('src/x_watch.js')
    q.write_text(patch_quests(q.read_text()))
    x.write_text(patch_x_watch(x.read_text()))
    print('patched', q.stat().st_size, x.stat().st_size)

if __name__ == '__main__':
    main()
