#!/usr/bin/env python3
"""Restore apex_rollouts.js with transactional announced + APEX_DEGRADED."""
import sys
from pathlib import Path

src_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
src = src_path.read_text()

needle = '  let diff = diffExperiments(prev, experiments);'
guard = '''  if (!isFirst && prev.length >= 20 && experiments.length < Math.max(5, prev.length * 0.4)) {
    console.error('APEX_DEGRADED: collection too small vs previous', {
      prev: prev.length,
      now: experiments.length,
    });
    process.exit(1);
  }

'''
if 'APEX_DEGRADED' not in src and needle in src:
    src = src.replace(needle, guard + needle)
    print('inserted APEX_DEGRADED guard')

marker = '  for (const e of compact) {\n    if (e.id && e.fingerprint) announced[e.id] = e.fingerprint;\n  }'
idx = src.find(marker)
if idx < 0:
    print('WARN: announced loop not found; writing restored file as-is')
    out_path.write_text(src)
    sys.exit(0)

end = src.find('if (require.main === module)', idx)
if end < 0:
    raise SystemExit('module.main marker not found')

new_tail = '''  async function writeState(announcedMap) {
    await fs.writeJson(
      STATE_FILE,
      {
        scrapedAt: new Date().toISOString(),
        count: compact.length,
        experiments: compact,
        announced: announcedMap,
      },
      { spaces: 2 },
    );
  }

  if (isFirst) {
    const seedAnn = { ...announced };
    for (const e of compact) {
      if (e.id && e.fingerprint) seedAnn[e.id] = e.fingerprint;
    }
    await writeState(seedAnn);
    console.log('Seed', compact.length, '- no notify');
    return;
  }

  if (!(diff.added.length || diff.changed.length || diff.removed.length)) {
    await writeState(announced);
    console.log('No significant % change');
    return;
  }

  if (!WEBHOOK) {
    await writeState(announced);
    console.warn('No webhook - state saved without advancing announced');
    return;
  }

  const embeds = buildEmbeds(diff);
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);
  if (sent.ok) {
    const nextAnn = { ...announced };
    for (const e of diff.added) if (e && e.id) nextAnn[e.id] = pctKey(e);
    for (const c of diff.changed) if (c.after && c.after.id) nextAnn[c.after.id] = pctKey(c.after);
    for (const e of diff.removed) if (e && e.id) nextAnn[e.id] = 'REMOVED';
    for (const e of compact) {
      if (e.id && e.fingerprint && nextAnn[e.id] !== 'REMOVED') {
        if (!(e.id in nextAnn) || nextAnn[e.id] === e.fingerprint) nextAnn[e.id] = e.fingerprint;
      }
    }
    await writeState(nextAnn);
    console.log('Done - announced advanced after successful webhook');
  } else {
    await writeState(announced);
    console.warn('Webhook failed - announced NOT advanced (will retry next run)');
    process.exit(2);
  }
}

'''

src = src[:idx] + new_tail + src[end:]
out_path.write_text(src)
print('wrote', out_path, 'bytes', len(src))
assert 'announced NOT advanced' in src
