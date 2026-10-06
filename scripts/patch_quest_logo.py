#!/usr/bin/env python3
"""Prefer working game logos (hashed logotype / game_tile) over broken game_logotype.png."""
from pathlib import Path

p = Path("src/quests.js")
t = p.read_text()

old = """    gameTile:
      assetUrl(id, assets.game_tile) ||
      assetUrl(id, assets.game_tile_dark) ||
      assetUrl(id, assets.game_tile_light),
    logotype:
      assetUrl(id, assets.logotype) ||
      assetUrl(id, assets.logotype_dark) ||
      assetUrl(id, assets.logotype_light),"""

new = """    // Prefer hashed assets: plain game_logotype.png is often 404 on the CDN.
    gameTile:
      assetUrl(id, assets.game_tile_dark) ||
      assetUrl(id, assets.game_tile_light) ||
      assetUrl(id, assets.game_tile),
    logotype:
      assetUrl(id, assets.logotype_dark) ||
      assetUrl(id, assets.logotype_light) ||
      assetUrl(id, assets.logotype),"""

if "Prefer hashed assets" in t:
    print("normalize already")
elif old not in t:
    raise SystemExit("normalize block not found")
else:
    t = t.replace(old, new, 1)
    print("normalize patched")

old2 = """  const logo =
    (quest.logotype && isImageUrl(quest.logotype) && quest.logotype) ||
    (quest.gameTile && isImageUrl(quest.gameTile) && quest.gameTile) ||
    null;"""

new2 = """  // game_tile = icone jeu (fiable) ; logotype = wordmark (souvent game_logotype.png en 404)
  const logo =
    (quest.gameTile && isImageUrl(quest.gameTile) && quest.gameTile) ||
    (quest.logotype && isImageUrl(quest.logotype) && quest.logotype) ||
    null;"""

if "icone jeu" in t or "icone jeu" in t:
    print("logo select already")
elif old2 not in t:
    # try with accented version already present
    if "quest.gameTile && isImageUrl(quest.gameTile) && quest.gameTile) ||" in t and "const logo" in t:
        print("logo select maybe already preferred gameTile")
    else:
        raise SystemExit("logo select not found")
else:
    t = t.replace(old2, new2, 1)
    print("logo select patched")

old_merge = """        gameTile: prev.gameTile || q.gameTile,"""
new_merge = """        gameTile: prev.gameTile || q.gameTile,
        logotype: prev.logotype || q.logotype,"""

if "logotype: prev.logotype" in t:
    print("merge already")
elif old_merge not in t:
    print("WARN merge block not found")
else:
    t = t.replace(old_merge, new_merge, 1)
    print("merge patched")

old_thumb = """    thumbnail: (() => {
      const first =
        (quest.rewards || []).find((r) => r.asset && isImageUrl(r.asset)) || null;
      return first ? { url: first.asset } : undefined;
    })(),"""

new_thumb = """    thumbnail: (() => {
      if (quest.gameTile && isImageUrl(quest.gameTile)) return { url: quest.gameTile };
      if (quest.logotype && isImageUrl(quest.logotype)) return { url: quest.logotype };
      const first =
        (quest.rewards || []).find((r) => r.asset && isImageUrl(r.asset)) || null;
      return first ? { url: first.asset } : undefined;
    })(),"""

if old_thumb in t:
    t = t.replace(old_thumb, new_thumb, 1)
    print("embed thumb patched")
else:
    print("embed thumb skip")

p.write_text(t)
print("done", p.stat().st_size)
