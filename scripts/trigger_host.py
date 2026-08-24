#!/usr/bin/env python3
"""
Trigger le scrape depuis ton hébergement (VPS, Termux, bot, Katabump, etc.)

Usage rapide — token dans le fichier :
  1. Mets ton PAT classic (repo + workflow) dans TOKEN ci-dessous
  2. python3 scripts/trigger_host.py

Ou par variable d'env :
  export GITHUB_TOKEN=ghp_xxx
  python3 scripts/trigger_host.py

Intervalle conseillé : 60 à 120 secondes.
Même build → Actions fait FAST SKIP (~10s) → pas de spam Discord.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

# ─── CONFIG ───────────────────────────────────────────
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
# Colle ton token ici si tu ne peux pas utiliser les variables d'env :
# TOKEN = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

REPO = os.environ.get("GITHUB_REPO", "kmljkjj/discord-canary-scraper")
EVENT = os.environ.get("DISPATCH_EVENT", "trigger-scraping")
INTERVAL = int(os.environ.get("INTERVAL", "90"))  # secondes (90 = bon équilibre)
# ──────────────────────────────────────────────────────


def log(msg: str) -> None:
    print(msg, flush=True)


def trigger() -> bool:
    if not TOKEN or TOKEN.startswith("ghp_") is False and len(TOKEN) < 20:
        # allow fine-grained tokens too (github_pat_)
        if not TOKEN or len(TOKEN) < 20:
            log("❌ TOKEN manquant — mets GITHUB_TOKEN ou édite TOKEN dans le fichier")
            log("   PAT classic : scope repo + workflow")
            return False

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
            "User-Agent": "canary-host-trigger",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            # 204 = OK pour repository_dispatch
            log(f"✅ OK {res.status} — dispatch '{EVENT}' → {REPO}")
            return True
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        log(f"❌ HTTP {e.code}")
        log(err[:500])
        if e.code == 403:
            log("→ Utilise un PAT classic avec scopes: repo + workflow")
        if e.code == 404:
            log("→ Vérifie REPO (owner/name) et que le token a accès")
        return False
    except Exception as e:
        log(f"❌ Erreur: {e}")
        return False


def main() -> None:
    if INTERVAL <= 0:
        ok = trigger()
        sys.exit(0 if ok else 1)

    log(f"Boucle toutes les {INTERVAL}s → {REPO} (Ctrl+C pour arrêter)")
    while True:
        trigger()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
