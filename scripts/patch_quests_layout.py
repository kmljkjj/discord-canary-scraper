#!/usr/bin/env python3
"""Photo en haut, une seule vidéo, embed noir, vidéo en bas."""
from pathlib import Path
import re

def main():
    p = Path('src/quests.js')
    t = p.read_text()
    if 'videoLabel' in t and 'accent_color: 0' in t:
        print('already patched')
        return

    old_vid = """  let videoUrl = null;
  for (const key of ['hero_video', 'quest_bar_hero_video', 'video', 'preview_video']) {
    if (assets[key]) {
      videoUrl = assetUrl(id, assets[key]);
      break;
    }
  }
  const taskVideos = extractTaskVideos(root, id);
  if (!videoUrl && taskVideos.length) videoUrl = taskVideos[0];

  return {
    id,
    name:"""

    new_vid = """  // Une seule vidéo : tâche (à regarder) prioritaire, sinon présentation
  const taskVideos = extractTaskVideos(root, id);
  let videoUrl = null;
  let videoKind = null;
  let videoLabel = null;
  if (taskVideos.length) {
    videoUrl = taskVideos[0];
    videoKind = 'task';
    videoLabel = 'Vidéo à regarder';
  } else {
    for (const key of [
      'hero_video',
      'quest_bar_hero_video',
      'preview_video',
      'video',
    ]) {
      if (assets[key]) {
        videoUrl = assetUrl(id, assets[key]);
        videoKind = 'presentation';
        videoLabel = 'Vidéo de présentation';
        break;
      }
    }
  }

  return {
    id,
    name:"""

    if old_vid not in t:
        raise SystemExit('video block miss')
    t = t.replace(old_vid, new_vid, 1)

    old_ret = """    videoUrl,
    taskVideos,
    primaryColor: colors.primary || null,"""
    new_ret = """    videoUrl,
    videoKind,
    videoLabel,
    taskVideos: videoUrl && videoKind === 'task' ? [videoUrl] : [],
    primaryColor: colors.primary || null,"""
    if old_ret not in t:
        raise SystemExit('ret miss')
    t = t.replace(old_ret, new_ret, 1)

    start = t.find('  const blocks = [];')
    end = t.find('  // Link buttons (style 5)')
    if start < 0 or end < 0:
        raise SystemExit(f'blocks miss {start} {end}')

    new_blocks = """  const blocks = [];

  // 1) Photo en haut — une seule image (hero)
  if (quest.heroImage && isImageUrl(quest.heroImage)) {
    blocks.push({
      type: 12,
      items: [
        {
          media: { url: quest.heroImage },
          description: String(quest.name).slice(0, 100),
        },
      ],
    });
  }

  // 2) Texte
  blocks.push({ type: 10, content: header.join('\\n').slice(0, 4000) });
  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({ type: 10, content: info.join('\\n').slice(0, 4000) });

  if (quest.tasksText) {
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({
      type: 10,
      content: ('**Tâches**\\n' + quest.tasksText).slice(0, 4000),
    });
  }

  const rewards = quest.rewards || [];
  if (rewards.length) {
    const rLines = [];
    for (const r of rewards.slice(0, 8)) {
      let line = '• **' + r.typeLabel + '**';
      if (r.name) line += ' — ' + r.name;
      if (r.orbQuantity != null) line += ' · **' + r.orbQuantity + ' orbes**';
      if (r.skuId) line += '\\n　SKU `' + r.skuId + '`;
      rLines.push(line);
    }
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({
      type: 10,
      content: ('**Récompenses**\\n' + rLines.join('\\n')).slice(0, 4000),
    });
  }

  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({
    type: 10,
    content: '**ID** · `' + quest.id + '`' ,
  });

  // 3) Vidéo en bas — une seule (tâche ou présentation)
  if (quest.videoUrl && isVideoUrl(quest.videoUrl)) {
    const vLabel = quest.videoLabel || 'Vidéo';
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({
      type: 10,
      content: '**' + vLabel + '**',
    });
    blocks.push({
      type: 12,
      items: [
        {
          media: { url: quest.videoUrl },
          description: vLabel.slice(0, 100),
        },
      ],
    });
  }

"""
    # Fix: new_blocks used escaped \\n in source strings incorrectly for JS
    # Rebuild with proper JS newlines in string literals
    new_blocks = (
        "  const blocks = [];\n\n"
        "  // 1) Photo en haut — une seule image (hero)\n"
        "  if (quest.heroImage && isImageUrl(quest.heroImage)) {\n"
        "    blocks.push({\n"
        "      type: 12,\n"
        "      items: [\n"
        "        {\n"
        "          media: { url: quest.heroImage },\n"
        "          description: String(quest.name).slice(0, 100),\n"
        "        },\n"
        "      ],\n"
        "    });\n"
        "  }\n\n"
        "  // 2) Texte\n"
        "  blocks.push({ type: 10, content: header.join('\\n').slice(0, 4000) });\n"
        "  blocks.push({ type: 14, divider: true, spacing: 1 });\n"
        "  blocks.push({ type: 10, content: info.join('\\n').slice(0, 4000) });\n\n"
        "  if (quest.tasksText) {\n"
        "    blocks.push({ type: 14, divider: true, spacing: 1 });\n"
        "    blocks.push({\n"
        "      type: 10,\n"
        "      content: ('**Tâches**\\n' + quest.tasksText).slice(0, 4000),\n"
        "    });\n"
        "  }\n\n"
        "  const rewards = quest.rewards || [];\n"
        "  if (rewards.length) {\n"
        "    const rLines = [];\n"
        "    for (const r of rewards.slice(0, 8)) {\n"
        "      let line = '• **' + r.typeLabel + '**';\n"
        "      if (r.name) line += ' — ' + r.name;\n"
        "      if (r.orbQuantity != null) line += ' · **' + r.orbQuantity + ' orbes**';\n"
        "      if (r.skuId) line += '\\n　SKU `' + r.skuId + '`;\n"
        "      rLines.push(line);\n"
        "    }\n"
        "    blocks.push({ type: 14, divider: true, spacing: 1 });\n"
        "    blocks.push({\n"
        "      type: 10,\n"
        "      content: ('**Récompenses**\\n' + rLines.join('\\n')).slice(0, 4000),\n"
        "    });\n"
        "  }\n\n"
        "  blocks.push({ type: 14, divider: true, spacing: 1 });\n"
        "  blocks.push({\n"
        "    type: 10,\n"
        "    content: '**ID** · `' + quest.id + '`' ,\n"
        "  });\n\n"
        "  // 3) Vidéo en bas — une seule (tâche ou présentation)\n"
        "  if (quest.videoUrl && isVideoUrl(quest.videoUrl)) {\n"
        "    const vLabel = quest.videoLabel || 'Vidéo';\n"
        "    blocks.push({ type: 14, divider: true, spacing: 1 });\n"
        "    blocks.push({\n"
        "      type: 10,\n"
        "      content: '**' + vLabel + '**',\n"
        "    });\n"
        "    blocks.push({\n"
        "      type: 12,\n"
        "      items: [\n"
        "        {\n"
        "          media: { url: quest.videoUrl },\n"
        "          description: vLabel.slice(0, 100),\n"
        "        },\n"
        "      ],\n"
        "    });\n"
        "  }\n\n"
    )
    # Fix SKU line - had typo with semicolon inside string
    new_blocks = new_blocks.replace(
        "if (r.skuId) line += '\\n　SKU `' + r.skuId + '`;",
        "if (r.skuId) line += '\\n　SKU `' + r.skuId + '`';",
    )
    t = t[:start] + new_blocks + t[end:]

    t = t.replace(
        """  if (quest.videoUrl) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'Ouvrir la vidéo',
      url: quest.videoUrl.slice(0, 512),
    });
  }""",
        """  if (quest.videoUrl) {
    buttons.push({
      type: 2,
      style: 5,
      label: (quest.videoLabel || 'Vidéo').slice(0, 80),
      url: quest.videoUrl.slice(0, 512),
    });
  }""",
        1,
    )

    t, n = re.subn(
        r'(type:\s*17[^\n]*\n\s*)accent_color:\s*parseColor\(quest\.primaryColor\)',
        r'\1accent_color: 0',
        t,
        count=1,
    )
    print('accent', n)

    old_emb = """  if (quest.videoUrl) {
    fields.push({ name: 'Vidéo', value: '[Lire](' + quest.videoUrl + ')' });
  }"""
    new_emb = """  if (quest.videoUrl) {
    fields.push({
      name: quest.videoLabel || 'Vidéo',
      value: '[Ouvrir](' + quest.videoUrl + ')',
    });
  }"""
    if old_emb in t:
        t = t.replace(old_emb, new_emb, 1)

    old_color = """    color: parseColor(quest.primaryColor),
    fields,
    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: quest.gameTile ? { url: quest.gameTile } : undefined,"""
    new_color = """    color: 0x000000,
    fields,
    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: undefined,"""
    if old_color in t:
        t = t.replace(old_color, new_color, 1)

    p.write_text(t)
    print('patched ok')

if __name__ == '__main__':
    main()
