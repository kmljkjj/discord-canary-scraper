#!/usr/bin/env python3
from pathlib import Path
import re

p = Path('src/quests.js')
src = p.read_text()

if 'rewardMedia' not in src:
    old = """    blocks.push({
      type: 10,
      content: ('**Récompenses**\\n' + rLines.join('\\n')).slice(0, 4000),
    });
  }

  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({
    type: 10,
    content: '**ID** · `' + quest.id + '`' ,
  });"""
    # fix escapes - the file has \\n in the source as backslash-n
    old = (
        "    blocks.push({\n"
        "      type: 10,\n"
        "      content: ('**Récompenses**\\n' + rLines.join('\\n')).slice(0, 4000),\n"
        "    });\n"
        "  }\n"
        "\n"
        "  blocks.push({ type: 14, divider: true, spacing: 1 });\n"
        "  blocks.push({\n"
        "    type: 10,\n"
        "    content: '**ID** · `' + quest.id + '`' ,\n"
        "  });"
    )
    new = (
        "    blocks.push({\n"
        "      type: 10,\n"
        "      content: ('**Récompenses**\\n' + rLines.join('\\n')).slice(0, 4000),\n"
        "    });\n"
        "\n"
        "    // Images des récompenses (décorations, collectibles, etc.)\n"
        "    const rewardMedia = [];\n"
        "    for (const r of rewards.slice(0, 8)) {\n"
        "      if (r.asset && isImageUrl(r.asset)) {\n"
        "        rewardMedia.push({\n"
        "          media: { url: r.asset },\n"
        "          description: String(r.name || r.typeLabel || 'Récompense').slice(0, 100),\n"
        "        });\n"
        "      }\n"
        "    }\n"
        "    if (rewardMedia.length) {\n"
        "      blocks.push({ type: 14, divider: true, spacing: 1 });\n"
        "      blocks.push({\n"
        "        type: 10,\n"
        "        content: '**Aperçu récompense' + (rewardMedia.length > 1 ? 's' : '') + '**',\n"
        "      });\n"
        "      blocks.push({ type: 12, items: rewardMedia.slice(0, 4) });\n"
        "    }\n"
        "  }\n"
        "\n"
        "  blocks.push({ type: 14, divider: true, spacing: 1 });\n"
        "  blocks.push({\n"
        "    type: 10,\n"
        "    content: '**ID** · `' + quest.id + '`' ,\n"
        "  });"
    )
    if old not in src:
        raise SystemExit('rewards block not found')
    src = src.replace(old, new)
    print('rewardMedia inserted')
else:
    print('rewardMedia already present')

src2, n = re.subn(
    r"function rewardTypeFr\(type\) \{\n  const map = \{[^}]+\};\n  return map\[type\] \|\| 'Type ' \+ type;\n\}",
    "function rewardTypeFr(type) {\n  const map = {\n    1: 'Récompense en jeu',\n    2: 'Collectible',\n    3: 'Monnaie virtuelle',\n    4: 'Orbes',\n    5: 'Fraction d\\'orbes',\n    6: 'Décoration de profil',\n    7: 'Effet de profil',\n    8: 'Avatar / décoration',\n  };\n  return map[type] || 'Type ' + type;\n}",
    src,
    count=1,
)
print('rewardTypeFr', n)
src = src2
p.write_text(src)
print('done', p.stat().st_size)
