#!/usr/bin/env python3
"""Restore src/quests.js from last good commit and fix String(id) state persistence."""
import json
import subprocess
from pathlib import Path

ROOT = Path('.')
QUESTS = ROOT / 'src' / 'quests.js'
STATE = ROOT / 'data' / 'quests.json'

# Prefer a known-good commit; fall back to git history scan
GOOD_SHAS = [
    '79727f1ff3c8e1e0e0e0e0e0e0e0e0e0e0e0e0e0',  # placeholder invalid
]

def git_show(path, rev):
    try:
        return subprocess.check_output(['git', 'show', f'{rev}:{path}'], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return None

def find_good_quests():
    # scan recent commits
    try:
        log = subprocess.check_output(
            ['git', 'log', '--pretty=format:%H', '-80', '--', 'src/quests.js'],
            text=True,
        ).strip().splitlines()
    except Exception:
        log = []
    for sha in log:
        body = git_show('src/quests.js', sha)
        if not body:
            continue
        if 'PLACEHOLDER' in body or len(body) < 15000:
            continue
        if 'function normalizeQuest' in body and 'writeQuestState' in body:
            print('using', sha, 'len', len(body))
            return body
    raise SystemExit('no good quests.js in history')

src = find_good_quests()

old = '''  const prevIds = new Set(previous.ids || []);
  const isFirstRun = prevIds.size === 0;

  const newQuests = isFirstRun ? [] : active.filter((q) => !prevIds.has(q.id));
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

new = '''  // Always compare as strings (snowflake id type mismatch caused re-notifies)
  const prevIds = new Set((previous.ids || []).map(String));
  const isFirstRun = prevIds.size === 0;

  const newQuests = isFirstRun
    ? []
    : active.filter((q) => q && q.id && !prevIds.has(String(q.id)));
  const questSnapshot = active.map((q) => ({
    id: String(q.id),
    name: q.name,
    expiresAt: q.expiresAt,
    videoUrl: q.videoUrl || null,
    heroImage: q.heroImage || null,
    rewardCount: (q.rewards || []).length,
  }));

  async function writeQuestState(ids) {
    const unique = [...new Set((ids || []).map(String))];
    await fs.writeJson(
      STATE_FILE,
      {
        scrapedAt: new Date().toISOString(),
        count: active.length,
        ids: unique,
        quests: questSnapshot,
      },
      { spaces: 2 },
    );
    console.log('State written: ids=', unique.length, 'active=', active.length);
  }

  if (isFirstRun) {
    await writeQuestState(active.map((q) => String(q.id)));
    console.log('Premier run - seed de', active.length, 'ids (pas de flood)');
    return;
  }

  // Keep full history of known ids — never drop (prevents re-spam after failed pushes)
  const known = new Set(prevIds);
  const pending = newQuests.slice();
  const batch = pending.slice(0, 15);
  console.log('Nouvelles quetes:', pending.length, '| notify batch:', batch.length);

  let sentOk = 0;
  let sentFail = 0;
  for (const q of batch) {
    const ok = await sendQuestWebhook(q);
    if (ok) {
      known.add(String(q.id));
      sentOk++;
    } else {
      sentFail++;
      console.warn('NOTIFY_FAIL quest', q.id, '- will retry next run');
    }
  }

  await writeQuestState(Array.from(known));
  console.log(
    'Quetes termine - sent',
    sentOk,
    'failed',
    sentFail,
    'still pending',
    Math.max(0, pending.length - sentOk),
  );
  if (sentFail > 0 && sentOk === 0 && batch.length > 0) {
    process.exitCode = 2;
  }
}'''

if 'State written: ids=' in src:
    print('already patched persistence')
elif old in src:
    src = src.replace(old, new)
    print('persistence patched')
else:
    # already different — write restored body as-is if large enough
    print('WARN: exact block not found, writing restored body without patch')

QUESTS.write_text(src)
print('quests.js', QUESTS.stat().st_size)

# Merge known-notified IDs into state to stop immediate re-spam
EXTRA = [
    '1539421708417765386',
    '1549171029241233449',
    '1551999809626439731',
    '1552002448975994942',
    '1552010656952356925',
    '1550379237335367680',
]
if STATE.exists():
    try:
        data = json.loads(STATE.read_text())
    except Exception:
        data = {'ids': [], 'quests': []}
else:
    data = {'ids': [], 'quests': []}
ids = set(map(str, data.get('ids') or []))
for x in EXTRA:
    ids.add(x)
data['ids'] = sorted(ids, key=lambda s: int(s) if s.isdigit() else 0)
data['scrapedAt'] = data.get('scrapedAt') or '2026-09-23T13:30:00.000Z'
STATE.parent.mkdir(parents=True, exist_ok=True)
STATE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
print('state ids', len(data['ids']))
