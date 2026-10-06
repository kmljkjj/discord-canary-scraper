#!/usr/bin/env python3
import re
from pathlib import Path

p = Path('src/quests.js')
t = p.read_text()
if 'orbImageUrl' in t and 'sectionWithThumb' in t:
    print('already patched')
    raise SystemExit(0)

marker = '/** Components V2 payload — MediaGallery for hero + video */'
if marker not in t:
    raise SystemExit('marker not found')

helpers = r'''
const MEDIA_BASE =
  process.env.QUEST_MEDIA_BASE ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/media';

function orbImageUrl(qty) {
  const n = Number(qty) || 0;
  if (n >= 500) return MEDIA_BASE + '/orbs-700.jpg';
  return MEDIA_BASE + '/orbs-200.jpg';
}

function sectionWithThumb(text, imageUrl, desc) {
  const block = {
    type: 9,
    components: [{ type: 10, content: String(text || '').slice(0, 4000) }],
  };
  if (imageUrl && isImageUrl(imageUrl)) {
    block.accessory = {
      type: 11,
      media: { url: String(imageUrl).slice(0, 2048) },
      description: String(desc || '').slice(0, 100) || undefined,
    };
  }
  return block;
}

'''
t = t.replace(marker, helpers + marker, 1)
m = re.search(r'function buildQuestComponentsV2\(quest\) \{', t)
m2 = re.search(r'\n/\*\* Fallback classic embed \*/\nfunction buildQuestEmbed', t)
if not m or not m2:
    raise SystemExit('bounds')
new_fn = Path('scripts/build_quest_v2_snippet.js').read_text()
t = t[:m.start()] + new_fn + t[m2.start()+1:]
p.write_text(t)
print('patched', p.stat().st_size)
