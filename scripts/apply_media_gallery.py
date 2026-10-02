#!/usr/bin/env python3
"""Add MediaGallery support for embed.image / embed.thumbnail in Components V2."""
from pathlib import Path

p = Path("src/lib/components_v2.js")
t = p.read_text()
if "mediaGalleryFromUrls" in t:
    print("already patched")
    raise SystemExit(0)

needle = """function separator(divider = true, spacing = 1) {
  return { type: 14, divider, spacing };
}
"""
helpers = """function separator(divider = true, spacing = 1) {
  return { type: 14, divider, spacing };
}

/**
 * Build a MediaGallery (type 12) from image URLs.
 * @param {string[]} urls
 * @returns {{type:number,items:Array}|null}
 */
function mediaGalleryFromUrls(urls) {
  const items = [];
  const seen = new Set();
  for (const u of urls || []) {
    if (!u || typeof u !== 'string') continue;
    const url = String(u).trim();
    if (!/^https?:\\/\\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({ media: { url: url.slice(0, 2048) } });
    if (items.length >= 4) break;
  }
  if (!items.length) return null;
  return { type: 12, items };
}

/** Collect image/thumbnail URLs from a legacy embed. */
function embedImageUrls(embed) {
  if (!embed || typeof embed !== 'object') return [];
  const urls = [];
  if (embed.image && embed.image.url) urls.push(embed.image.url);
  if (embed.thumbnail && embed.thumbnail.url) urls.push(embed.thumbnail.url);
  return urls;
}
"""

if needle not in t:
    raise SystemExit("separator block not found")
t = t.replace(needle, helpers, 1)

old_embed = """  // Description
  if (embed.description) {
    for (const chunk of chunkText(embed.description)) {
      components.push(textDisplay(chunk));
    }
  }

  // Fields
  if (embed.fields && embed.fields.length) {
    for (const field of embed.fields) {
      const fieldText = `**${field.name || ''}**\\n${field.value || ''}`;
      for (const chunk of chunkText(fieldText)) {
        components.push(textDisplay(chunk));
      }
    }
  }

  // Footer
  if (embed.footer && embed.footer.text) {
    if (components.length > 0) components.push(separator(false, 1));
    components.push(textDisplay(`-# ${embed.footer.text}`));
  }
"""

new_embed = """  // Image / thumbnail as MediaGallery (Components V2 drops embed.image otherwise)
  {
    const gallery = mediaGalleryFromUrls(embedImageUrls(embed));
    if (gallery) components.push(gallery);
  }

  // Description
  if (embed.description) {
    for (const chunk of chunkText(embed.description)) {
      components.push(textDisplay(chunk));
    }
  }

  // Fields
  if (embed.fields && embed.fields.length) {
    for (const field of embed.fields) {
      const fieldText = `**${field.name || ''}**\\n${field.value || ''}`;
      for (const chunk of chunkText(fieldText)) {
        components.push(textDisplay(chunk));
      }
    }
  }

  // Footer
  if (embed.footer && embed.footer.text) {
    if (components.length > 0) components.push(separator(false, 1));
    components.push(textDisplay(`-# ${embed.footer.text}`));
  }
"""

if old_embed not in t:
    raise SystemExit("embedToComponents body not found")
t = t.replace(old_embed, new_embed, 1)

old_multi = """    if (headerParts.length) {
      const header = headerParts.join('\\n');
      for (const chunk of chunkText(header)) {
        allComponents.push(textDisplay(chunk));
      }
    }

    if (embed.description) {
"""

new_multi = """    if (headerParts.length) {
      const header = headerParts.join('\\n');
      for (const chunk of chunkText(header)) {
        allComponents.push(textDisplay(chunk));
      }
    }

    // Preserve embed.image / thumbnail as MediaGallery
    {
      const gallery = mediaGalleryFromUrls(embedImageUrls(embed));
      if (gallery) allComponents.push(gallery);
    }

    if (embed.description) {
"""

if old_multi not in t:
    raise SystemExit("embedsToComponents header block not found")
t = t.replace(old_multi, new_multi, 1)

t = t.replace(
    """module.exports = {
  IS_COMPONENTS_V2_FLAG,
  TEXT_DISPLAY_MAX,
  CONTAINER_MAX_COMPONENTS,
  MESSAGE_MAX_COMPONENTS,
  textDisplay,
  separator,
  container,
  linkButton,
  dismissButton,
  addDismissToMessages,
  chunkText,
  chunkIntoMessages,
  buildSectionMessages,
  embedToComponents,
  embedsToComponents,
};
""",
    """module.exports = {
  IS_COMPONENTS_V2_FLAG,
  TEXT_DISPLAY_MAX,
  CONTAINER_MAX_COMPONENTS,
  MESSAGE_MAX_COMPONENTS,
  textDisplay,
  separator,
  container,
  mediaGalleryFromUrls,
  embedImageUrls,
  linkButton,
  dismissButton,
  addDismissToMessages,
  chunkText,
  chunkIntoMessages,
  buildSectionMessages,
  embedToComponents,
  embedsToComponents,
};
""",
)

p.write_text(t)
print("patched OK")
