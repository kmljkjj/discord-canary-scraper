#!/usr/bin/env python3
import subprocess
from pathlib import Path

TARGET = Path('src/blog_tracker.js')

def show(rev):
    try:
        return subprocess.check_output(
            ['git', 'show', f'{rev}:src/blog_tracker.js'],
            stderr=subprocess.DEVNULL,
        ).decode('utf-8', errors='replace')
    except Exception:
        return None

log = subprocess.check_output(
    ['git', 'log', '--pretty=format:%H', '-40', '--', 'src/blog_tracker.js'],
    text=True,
).strip().splitlines()

src = None
for sha in log:
    body = show(sha)
    if not body or 'PLACEHOLDER' in body or len(body) < 10000:
        continue
    if 'async function main' in body and 'fetchBlog' in body:
        print('GOOD', sha, len(body))
        src = body
        break
if not src:
    raise SystemExit('no good blog_tracker.js in history')

# --- patches ---
src = src.replace(
'''function indexById(list) {
  const m = {};
  for (const e of list || []) {
    if (e && e.id) m[e.id] = e;
  }
  return m;
}''',
'''function indexById(list) {
  const m = {};
  for (const e of list || []) {
    if (e && e.id != null && e.id !== '') m[String(e.id)] = e;
  }
  return m;
}'''
)

old_body = '''    if (n.bodyHash && o.bodyHash && n.bodyHash !== o.bodyHash) {
      changes.push({
        kind: 'body',
        label: 'Contenu',
        before: o.bodyPreview || null,
        after: n.bodyPreview || null,
      });
    }'''
new_body = '''    if (n.bodyHash && o.bodyHash && n.bodyHash !== o.bodyHash) {
      const before = (o.bodyPreview || '').trim();
      const after = (n.bodyPreview || '').trim();
      if (before && after && before !== after) {
        changes.push({
          kind: 'body',
          label: 'Contenu',
          before: o.bodyPreview || null,
          after: n.bodyPreview || null,
        });
      }
    }'''
if old_body in src:
    src = src.replace(old_body, new_body)
    print('body-noise patch')

old_notify = '''async function notifyAll(diffs) {
  let sent = 0;
  let failed = 0;
  const queue = [];
  for (const [source, d] of Object.entries(diffs)) {
    for (const e of d.added || []) queue.push({ e, action: 'added', source });
    for (const e of d.updated || []) queue.push({ e, action: 'updated', source });
    for (const e of d.removed || []) queue.push({ e, action: 'removed', source });
  }
  const batch = queue.slice(0, 30);
  console.log('Notify queue:', queue.length, 'batch:', batch.length);
  for (const item of batch) {
    const embed = buildEmbed(item.e, item.action);
    const ok = await postWebhook([embed]);
    if (ok) {
      sent++;
      console.log('🔔', item.action, item.source, item.e.title);
    } else {
      failed++;
    }
    await sleep(400);
  }
  return { sent, failed, pending: Math.max(0, queue.length - batch.length) };
}'''

new_notify = '''async function notifyAll(diffs) {
  let sent = 0;
  let failed = 0;
  const queue = [];
  const notifyRemoved = process.env.BLOG_NOTIFY_REMOVED === '1';
  for (const [source, d] of Object.entries(diffs)) {
    for (const e of d.added || []) queue.push({ e, action: 'added', source });
    for (const e of d.updated || []) queue.push({ e, action: 'updated', source });
    if (notifyRemoved) {
      for (const e of d.removed || []) queue.push({ e, action: 'removed', source });
    }
  }
  const batch = queue.slice(0, 20);
  console.log('Notify queue:', queue.length, 'batch:', batch.length);
  const okKeys = new Set();
  const failKeys = new Set();
  for (const item of batch) {
    const embed = buildEmbed(item.e, item.action);
    const ok = await postWebhook([embed]);
    const key = item.source + ':' + item.action + ':' + String(item.e.id);
    if (ok) {
      sent++;
      okKeys.add(key);
      console.log('🔔', item.action, item.source, item.e.title);
    } else {
      failed++;
      failKeys.add(key);
      console.warn('NOTIFY_FAIL', item.action, item.source, item.e.id);
    }
    await sleep(450);
  }
  return {
    sent,
    failed,
    pending: Math.max(0, queue.length - batch.length),
    okKeys,
    failKeys,
    batch,
  };
}

function mergeStateAfterNotify(previousList, newList, result, source) {
  const prevM = indexById(previousList);
  const failedAdded = new Set();
  for (const item of result.batch || []) {
    if (item.source !== source) continue;
    if (item.action !== 'added') continue;
    const key = item.source + ':' + item.action + ':' + String(item.e.id);
    if (result.failKeys && result.failKeys.has(key)) {
      failedAdded.add(String(item.e.id));
    }
  }
  const out = [];
  for (const e of newList || []) {
    const id = String(e.id);
    if (failedAdded.has(id)) {
      if (prevM[id]) out.push(prevM[id]);
      continue;
    }
    out.push(e);
  }
  for (const [id, o] of Object.entries(prevM)) {
    if (out.some((x) => String(x.id) === id)) continue;
    if (o && o.source === source) out.push(o);
  }
  return out;
}'''

if old_notify in src:
    src = src.replace(old_notify, new_notify)
    print('notify patch')
else:
    print('WARN notify block not found')

old_main = '''  if (isFirst) {
    console.log('First run — seed state, no notify flood');
  } else {
    const result = await notifyAll(diffs);
    console.log(
      'Notify done sent',
      result.sent,
      'failed',
      result.failed,
      'pending',
      result.pending,
    );
  }

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      blog,
      zendesk,
      counts: { blog: blog.length, zendesk: zendesk.length },
    },
    { spaces: 2 },
  );
  console.log('State written', STATE_FILE);
}'''

new_main = '''  let nextBlog = blog;
  let nextZendesk = zendesk;

  if (isFirst) {
    console.log('First run — seed state, no notify flood');
  } else {
    const result = await notifyAll(diffs);
    console.log(
      'Notify done sent',
      result.sent,
      'failed',
      result.failed,
      'pending',
      result.pending,
    );
    nextBlog = mergeStateAfterNotify(previous.blog || [], blog, result, 'blog');
    nextZendesk = mergeStateAfterNotify(
      previous.zendesk || [],
      zendesk,
      result,
      'support',
    );
    if (result.failed > 0) process.exitCode = 2;
  }

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      blog: nextBlog,
      zendesk: nextZendesk,
      counts: { blog: nextBlog.length, zendesk: nextZendesk.length },
    },
    { spaces: 2 },
  );
  console.log(
    'State written',
    STATE_FILE,
    'blog',
    nextBlog.length,
    'zendesk',
    nextZendesk.length,
  );
}'''

if old_main in src:
    src = src.replace(old_main, new_main)
    print('main patch')
else:
    print('WARN main block not found')

TARGET.write_text(src)
print('wrote', TARGET.stat().st_size)
assert 'PLACEHOLDER' not in src
assert 'mergeStateAfterNotify' in src
