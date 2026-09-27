#!/usr/bin/env python3
"""
Déclencheur rapide Canary → GitHub Actions

Pourquoi : le cron GitHub (*/5) a souvent 5–20 min de retard.
Wumpus tourne hors Actions. Ce script poll canary.discord.com
et ne dispatch QUE si le BUILD_NUMBER change.

Usage:
  export GITHUB_TOKEN="ghp_xxx"   # classic : repo + workflow
  python3 scripts/canary_trigger.py

Vars optionnelles:
  GITHUB_REPO=kmljkjj/discord-canary-scraper
  INTERVAL=20          # secondes entre checks (20 recommandé)
  DISPATCH_EVENT=trigger-scraping
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from _canary_common import (
    get_canary_build,
    read_state,
    write_state,
    dispatch_github_actions,
    DEFAULT_REPO,
    DEFAULT_EVENT,
)

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
REPO = os.environ.get("GITHUB_REPO", DEFAULT_REPO)
EVENT = os.environ.get("DISPATCH_EVENT", DEFAULT_EVENT)
INTERVAL = int(os.environ.get("INTERVAL", "20"))
STATE = Path(os.environ.get("STATE_FILE", str(Path(__file__).resolve().parent / "last_canary_build.txt")))


def tick() -> str:
    bn, _vh = get_canary_build()
    if not bn:
        return "build=? (fetch fail)"
    last = read_state(STATE)
    if last == bn:
        return f"build={bn} inchangé"
    # nouveau build
    ok, msg = dispatch_github_actions(TOKEN, REPO, EVENT)
    if ok:
        write_state(STATE, bn)
        return f"NOUVEAU build={bn} (prev={last}) → {msg}"
    return f"NOUVEAU build={bn} mais dispatch échoué: {msg}"


def main() -> None:
    if not TOKEN:
        print("Erreur: export GITHUB_TOKEN=ghp_... (classic: repo + workflow)")
        sys.exit(1)
    print(
        f"[trigger] repo={REPO} interval={INTERVAL}s event={EVENT}",
        flush=True,
    )
    if INTERVAL <= 0:
        print(tick(), flush=True)
        return
    while True:
        print(f"[trigger] {tick()}", flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
