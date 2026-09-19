#!/usr/bin/env python3
from pathlib import Path

p = Path('src/quests.js')
src = p.read_text()

# reward types
old_rt = '''function rewardTypeFr(type) {
  const map = {
    1: 'Récompense en jeu',
    2: 'Collectible',
    3: 'Monnaie virtuelle',
    4: 'Orbes',
    5: 'Fraction d\'orbes',
  };
  return map[type] || 'Type ' + type;
}'''

new_rt = '''function rewardTypeFr(type) {
  const map = {
    1: 'Récompense en jeu',
    2: 'Collectible',
    3: 'Monnaie virtuelle',
    4: 'Orbes',
    5: 'Fraction d\'orbes',
    6: 'Décoration de profil',
    7: 'Effet de profil',
    8: 'Avatar / décoration',
  };
  return map[type] || 'Type ' + type;
}'''

if old_rt in src:
    src = src.replace(old_rt, new_rt)
    print('rewardTypeFr ok')
elif "6: 'Décoration" in src:
    print('rewardTypeFr already')
else:
    print('WARN rewardTypeFr')

# broader image detection (CDN assets sometimes lack extension)
old_img = '''function isImageUrl(url) {
  return /\\.(png|jpe?g|gif|webp)(\\?|$)/i.test(url || '');
}'''
new_img = '''function isImageUrl(url) {
  if (!url) return false;
  if (/\\.(png|jpe?g|gif|webp)(\\?|$)/i.test(url)) return true;
  // Discord quest CDN paths often include asset names without query
  if (/cdn\\.discordapp\\.com\\/(quests|assets|collectibles|avatar)/i.test(url)) {
    if (/\\.(mp4|webm|mov)(\\?|$)/i.test(url)) return false;
    return true;
  }
  return false;
}'''
if old_img in src:
    src = src.replace(old_img, new_img)
    print('isImageUrl ok')
elif 'collectibles' in src and 'isImageUrl' in src:
    print('isImageUrl maybe already')
else:
    # try without extra escapes
    if 'function isImageUrl(url)' in src and 'collectibles' not in src.split('function isImageUrl')[1][:400]:
        import re
        src = re.sub(
            r'function isImageUrl\(url\) \{[^}]+\}',
            '''function isImageUrl(url) {
  if (!url) return false;
  if (/\\.(png|jpe?g|gif|webp)(\\?|$)/i.test(url)) return true;
  if (/cdn\\.discordapp\\.com\\/(quests|assets|collectibles|avatar)/i.test(url)) {
    if (/\\.(mp4|webm|mov)(\\?|$)/i.test(url)) return false;
    return true;
  }
  return false;
}''',
            src,
            count=1,
        )
        print('isImageUrl regex replaced')

# Insert reward MediaGallery after rewards text block in V2
marker = '''    blocks.push({
      type: 10,
      content: ('**Récompenses**\n' + rLines.join('\n')).slice(0, 4000),
    });
  }

  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({
    type: 10,
    content: '**ID** · `' + quest.id + '`' ,
  });'''

insert = '''    blocks.push({
      type: 10,
      content: ('**Récompenses**\n' + rLines.join('\n')).slice(0, 4000),
    });

    // Images des récompenses (décorations, collectibles, etc.)
    const rewardMedia = [];
    for (const r of rewards.slice(0, 8)) {
      if (r.asset && isImageUrl(r.asset)) {
        rewardMedia.push({
          media: { url: r.asset },
          description: String(r.name || r.typeLabel || 'Récompense').slice(0, 100),
        });
      }
    }
    if (rewardMedia.length) {
      blocks.push({ type: 14, divider: true, spacing: 1 });
      blocks.push({
        type: 10,
        content: '**Aperçu récompense' + (rewardMedia.length > 1 ? 's' : '') + '**',
      });
      blocks.push({ type: 12, items: rewardMedia.slice(0, 4) });
    }
  }

  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({
    type: 10,
    content: '**ID** · `' + quest.id + '`' ,
  });'''

if marker in src:
    src = src.replace(marker, insert)
    print('V2 reward media ok')
elif 'Aperçu récompense' in src:
    print('V2 reward media already')
else:
    print('WARN V2 marker not found')
    # debug
    if "**Récompenses**" in src:
        print('has Recompenses text')

# classic embed: thumbnail = first reward image
old_th = '''    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: undefined,'''
new_th = '''    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: (() => {
      const first =
        (quest.rewards || []).find((r) => r.asset && isImageUrl(r.asset)) || null;
      return first ? { url: first.asset } : undefined;
    })(),'''
if old_th in src:
    src = src.replace(old_th, new_th)
    print('classic thumbnail ok')
elif 'first reward' in src or 'quest.rewards || []).find' in src:
    print('classic thumbnail already')
else:
    print('WARN classic thumbnail')

p.write_text(src)
print('size', p.stat().st_size)
