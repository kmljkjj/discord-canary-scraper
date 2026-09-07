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

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
REPO = os.environ.get("GITHUB_REPO", "kmljkjj/discord-canary-scraper")
EVENT = os.environ.get("DISPATCH_EVENT", "trigger-scraping")
INTERVAL = int(os.environ.get("INTERVAL", "20"))
STATE = Path(os.environ.get("STATE_FILE", str(Path(__file__).resolve().parent / "last_canary_build.txt")))

CANARY_URL = "https://canary.discord.com/app"
UA = "Mozilla/5.0 (compatible; Datamining-trigger/3.0)"


def http_get(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "text/html"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", errors="replace")


def get_build() -> str | None:
    try:
        html = http_get(CANARY_URL)
    except Exception as e:
        print(f"[trigger] fetch canary fail: {e}", flush=True)
        return None
    m = re.search(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?', html)
    return m.group(1) if m else None


def load_last() -> str | None:
    try:
        if STATE.exists():
            return STATE.read_text(encoding="utf-8").strip() or None
    except Exception:
        pass
    return None


def save_last(bn: str) -> None:
    try:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(bn + "\n", encoding="utf-8")
    except Exception as e:
        print(f"[trigger] save state fail: {e}", flush=True)


def dispatch() -> tuple[bool, str]:
    if not TOKEN:
        return False, "GITHUB_TOKEN manquant (scope repo + workflow)"
    url = f"https://api.github.com/repos/{REPO}/dispatches"
    body = json.dumps({"event_type": EVENT}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {TOKEN}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "datamining-canary-trigger",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return True, f"OK {res.status} dispatch → {REPO}"
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        return False, f"HTTP {e.code}: {err[:300]}"
    except Exception as e:
        return False, str(e)


def tick() -> str:
    bn = get_build()
    if not bn:
        return "build=? (fetch fail)"
    last = load_last()
    if last == bn:
        return f"build={bn} inchangé"
    # nouveau build
    ok, msg = dispatch()
    if ok:
        save_last(bn)
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
