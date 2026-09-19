#!/usr/bin/env python3
from pathlib import Path

p = Path('src/quests.js')
src = p.read_text()

if "official+public" in src and 'Token officiel:' in src:
    print('already token-first')
    raise SystemExit(0)

src = src.replace(
    "const DISCORD_TOKEN = process.env.DISCORD_TOKEN || null;",
    """const DISCORD_TOKEN =
  process.env.DISCORD_TOKEN ||
  process.env.DISCORD_USER_TOKEN ||
  process.env.DISCORD_USER_TOKEN_1 ||
  null;""",
)

old_off = '''async function fetchOfficialQuests() {
  if (!DISCORD_TOKEN) return [];
  const res = await fetch(OFFICIAL_QUESTS_URL, {
    headers: {
      Authorization: DISCORD_TOKEN,
      'User-Agent': UA,
      Accept: 'application/json',
    },
    timeout: 30000,
  });
  if (!res.ok) {
    console.warn('official /quests/@me', res.status);
    return [];
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.quests || [];
  return list.map(normalizeQuest).filter(Boolean);
}'''

new_off = '''async function fetchOfficialQuests() {
  if (!DISCORD_TOKEN) {
    console.log('No DISCORD_TOKEN / DISCORD_USER_TOKEN — official quests skipped');
    return [];
  }
  const endpoints = [
    'https://canary.discord.com/api/v10/quests/@me',
    'https://discord.com/api/v10/quests/@me',
  ];
  const headers = {
    Authorization: DISCORD_TOKEN,
    'User-Agent': UA,
    Accept: 'application/json',
  };
  let lastStatus = 0;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers, timeout: 25000 });
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) {
        console.warn('official quests auth failed HTTP', res.status, '(check DISCORD_TOKEN secret)');
        return [];
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') || 2);
        console.warn('official quests 429 — wait', ra, 's');
        await new Promise((r) => setTimeout(r, Math.min(15, ra) * 1000));
        continue;
      }
      if (!res.ok) {
        console.warn('official quests HTTP', res.status, url.includes('canary') ? 'canary' : 'stable');
        continue;
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.quests || data.data || [];
      const out = list.map(normalizeQuest).filter(Boolean);
      console.log('Official quests:', out.length, url.includes('canary') ? '(canary)' : '(stable)');
      return out;
    } catch (e) {
      console.warn('official quests error:', String(e.message || e).slice(0, 120));
    }
  }
  if (lastStatus) console.warn('official quests gave up, last HTTP', lastStatus);
  return [];
}'''

if old_off not in src:
    raise SystemExit('fetchOfficialQuests block not found')
src = src.replace(old_off, new_off)

old_main = '''  let quests = [];
  try {
    quests = await fetchPublicQuests();
    console.log('API publique:', quests.length, 'quêtes');
    const sample = quests.find((q) => q.name && !q.name.startsWith('Quête '));
    if (sample) {
      console.log(
        'Sample OK:',
        sample.name,
        '| tasks:',
        !!sample.tasksText,
        '| rewards:',
        (sample.rewards || []).length,
        '| image:',
        !!sample.heroImage,
        '| video:',
        !!sample.videoUrl,
      );
    }
  } catch (e) {
    console.error('API publique échouée:', e.message);
    process.exitCode = 1;
  }

  try {
    const official = await fetchOfficialQuests();
    if (official.length) {
      const byId = new Map(quests.map((q) => [q.id, q]));
      for (const q of official) {
        const prev = byId.get(q.id) || {};
        byId.set(q.id, {
          ...prev,
          ...q,
          rewards: q.rewards?.length ? q.rewards : prev.rewards,
        });
      }
      quests = Array.from(byId.values());
      console.log('Fusion officielle:', quests.length);
    }
  } catch (e) {
    console.warn('Quêtes officielles:', e.message);
  }'''

new_main = '''  let quests = [];
  let official = [];
  let publicList = [];

  if (DISCORD_TOKEN) {
    try {
      official = await fetchOfficialQuests();
    } catch (e) {
      console.warn('Quêtes officielles:', String(e.message || e).slice(0, 120));
    }
  } else {
    console.log('Tip: set secret DISCORD_TOKEN (user token) for faster official quest detection');
  }

  try {
    publicList = await fetchPublicQuests();
    console.log('API publique:', publicList.length, 'quêtes');
  } catch (e) {
    console.error('API publique échouée:', e.message);
    if (!official.length) process.exitCode = 1;
  }

  {
    const byId = new Map();
    for (const q of official) {
      if (q && q.id) byId.set(q.id, { ...q, source: 'official' });
    }
    for (const q of publicList) {
      if (!q || !q.id) continue;
      const prev = byId.get(q.id);
      if (!prev) {
        byId.set(q.id, { ...q, source: 'public' });
        continue;
      }
      byId.set(q.id, {
        ...prev,
        ...q,
        name: prev.name || q.name,
        heroImage: prev.heroImage || q.heroImage,
        gameTile: prev.gameTile || q.gameTile,
        videoUrl: prev.videoUrl || q.videoUrl,
        rewards:
          (prev.rewards && prev.rewards.length ? prev.rewards : null) ||
          q.rewards ||
          [],
        tasksText: prev.tasksText || q.tasksText,
        source: prev.source === 'official' ? 'official+public' : prev.source,
      });
    }
    quests = Array.from(byId.values());
  }

  console.log(
    'Quêtes fusionnées:',
    quests.length,
    '| official',
    official.length,
    '| public',
    publicList.length,
  );
  const sample = quests.find((q) => q.name && !String(q.name).startsWith('Quête '));
  if (sample) {
    console.log(
      'Sample OK:',
      sample.name,
      '| tasks:',
      !!sample.tasksText,
      '| rewards:',
      (sample.rewards || []).length,
      '| image:',
      !!sample.heroImage,
      '| video:',
      !!sample.videoUrl,
      '| src:',
      sample.source || '?',
    );
  }'''

if old_main not in src:
    raise SystemExit('main fetch block not found')
src = src.replace(old_main, new_main)

if 'Token officiel:' not in src:
    src = src.replace(
        "  console.log(\n    'Webhook:',",
        "  console.log('Token officiel:', DISCORD_TOKEN ? 'configured' : 'MISSING');\n  console.log(\n    'Webhook:',",
        1,
    )

p.write_text(src)
print('ok', p.stat().st_size)
