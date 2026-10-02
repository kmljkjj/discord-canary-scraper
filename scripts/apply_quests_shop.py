#!/usr/bin/env python3
"""One-shot: quests V2 sendWebhook path + shop pending batches."""
from pathlib import Path

def patch_quests():
    p = Path("src/quests.js")
    t = p.read_text()
    if "quests-v2" in t:
        print("quests: already patched")
        return
    t2 = t.replace(
        "const { sendEmbeds } = require('./lib/webhook');",
        "const { sendEmbeds, sendWebhook } = require('./lib/webhook');",
        1,
    )
    old = (
        "async function postWebhook(url, body) {\n"
        "  if (!url) return { ok: false, status: 0, text: 'no webhook' };\n"
        "  const embeds = body.embeds || [];\n"
        "  const base = { username: body.username || BOT_NAME, avatar_url: body.avatar_url || AVATAR };\n"
        "  return sendEmbeds(url, base, embeds, { label: 'quests', withDismiss: true });\n"
        "}"
    )
    new = (
        "async function postWebhook(url, body) {\n"
        "  if (!url) return { ok: false, status: 0, text: 'no webhook' };\n"
        "  if (body && Array.isArray(body.components) && body.components.length) {\n"
        "    return sendWebhook(url, body, { label: 'quests-v2' });\n"
        "  }\n"
        "  const embeds = body.embeds || [];\n"
        "  const base = { username: body.username || BOT_NAME, avatar_url: body.avatar_url || AVATAR };\n"
        "  return sendEmbeds(url, base, embeds, { label: 'quests', withDismiss: true });\n"
        "}"
    )
    if old not in t2:
        raise SystemExit("quests: postWebhook block not found")
    p.write_text(t2.replace(old, new, 1))
    print("quests: patched")

def patch_shop():
    p = Path("src/shop.js")
    t = p.read_text()
    if "pendingNew" in t:
        print("shop: already patched")
        return
    marker = "  const toNotify = newItems.slice(0, 15);"
    if marker not in t:
        raise SystemExit("shop: toNotify marker not found")
    start = t.index(marker)
    log = "  console.log('\u2705 Shop done \u2014 announced', toNotify.length);"
    if log not in t:
        # try ascii dash variant
        log = "  console.log('\u2705 Shop done \u2014 announced', toNotify.length);"
    if log not in t:
        log = "  console.log('\u2705 Shop done \u2014 announced', toNotify.length);"
    # fallback: search by prefix
    if "Shop done" not in t[start:start+2500]:
        raise SystemExit("shop: done log region not found")
    # Find exact line
    import re
    m = re.search(r"  console\.log\('.*?Shop done.*?toNotify\.length\);", t[start:])
    if not m:
        raise SystemExit("shop: done log regex not found")
    log_i = start + m.start()
    end = t.index("\n}", log_i) + 2
    block = """  let remaining = newItems.slice();
  const announced = { ...(prev.announced || {}) };
  const notified = [];
  while (remaining.length) {
    const batch = remaining.slice(0, 15);
    remaining = remaining.slice(15);
    const sent = await postWebhook(batch.map(buildEmbed));
    console.log('Webhook batch', batch.length, sent.status, sent.ok ? 'OK' : sent.text);
    if (!sent.ok) {
      console.warn('NOTIFY_FAIL shop \u2014 remaining will retry');
      process.exitCode = 2;
      remaining = batch.concat(remaining);
      break;
    }
    const ts = new Date().toISOString();
    for (const it of batch) {
      announced[it.id] = ts;
      notified.push(it.id);
    }
  }
  const knownIds = new Set([...(prev.ids || []), ...Object.keys(announced)]);
  const nextIds = allIds.filter((id) => knownIds.has(id));
  await writeJsonAtomic(
    STATE,
    {
      scrapedAt: new Date().toISOString(),
      count: items.length,
      ids: nextIds,
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        image: i.image,
      })),
      announced,
      lastNew: notified,
      pendingNew: remaining.map((i) => i.id),
    },
    2,
  );
  console.log('\u2705 Shop done \u2014 announced', notified.length, 'pending', remaining.length);
}"""
    p.write_text(t[:start] + block + t[end:])
    print("shop: patched")

if __name__ == "__main__":
    patch_quests()
    patch_shop()
    print("done")
