#!/usr/bin/env python3
import json
import subprocess
from pathlib import Path

QUESTS = Path('src/quests.js')
STATE = Path('data/quests.json')

def git_show(rev):
    try:
        return subprocess.check_output(
            ['git', 'show', f'{rev}:src/quests.js'],
            stderr=subprocess.DEVNULL,
        ).decode('utf-8', errors='replace')
    except Exception:
        return None

def find_good():
    log = subprocess.check_output(
        ['git', 'log', '--pretty=format:%H', '-100', '--', 'src/quests.js'],
        text=True,
    ).strip().splitlines()
    for sha in log:
        body = git_show(sha)
        if not body:
            continue
        if 'PLACEHOLDER' in body or len(body) < 15000:
            continue
        if 'function normalizeQuest' in body and 'sendQuestWebhook' in body:
            print('GOOD', sha, len(body))
            return body
    raise SystemExit('no good quests.js found in git history')

src = find_good()

# Patch persistence block if still old style
old = '''  const prevIds = new Set(previous.ids || []);
  const isFirstRun = prevIds.size === 0;

  const newQuests = isFirstRun ? [] : active.filter((q) => !prevIds.has(q.id));'''

if old in src and 'State written: ids=' not in src:
    src = src.replace(
        'const prevIds = new Set(previous.ids || []);',
        'const prevIds = new Set((previous.ids || []).map(String));',
        1,
    )
    src = src.replace(
        'active.filter((q) => !prevIds.has(q.id))',
        'active.filter((q) => q && q.id && !prevIds.has(String(q.id)))',
        1,
    )
    src = src.replace(
        'known.add(q.id);',
        'known.add(String(q.id));',
        1,
    )
    src = src.replace(
        'await writeQuestState(active.map((q) => q.id));',
        'await writeQuestState(active.map((q) => String(q.id)));',
        1,
    )
    src = src.replace(
        '''async function writeQuestState(ids) {
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
  }''',
        '''async function writeQuestState(ids) {
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
  }''',
        1,
    )
    # remove the loop that only re-adds prev active (redundant with Set(prevIds))
    src = src.replace(
        '''  for (const q of active) {
    if (prevIds.has(q.id)) known.add(q.id);
  }

  await writeQuestState(Array.from(known));''',
        '  await writeQuestState(Array.from(known));',
        1,
    )
    print('patched String(id) persistence')
else:
    print('persistence already ok or different shape')

QUESTS.write_text(src)
print('wrote', QUESTS.stat().st_size)

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
        data = {'ids': []}
else:
    data = {'ids': []}
ids = set(map(str, data.get('ids') or []))
for x in EXTRA:
    ids.add(x)
data['ids'] = sorted(ids, key=lambda s: int(s) if s.isdigit() else 0)
STATE.parent.mkdir(parents=True, exist_ok=True)
STATE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
print('state ids', len(data['ids']))
for x in EXTRA:
    assert x in ids
