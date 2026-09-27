#!/usr/bin/env python3
"""
Trigger INTELLIGENT pour hébergement (50s OK).

Ne lance GitHub Actions QUE si le BUILD_NUMBER Canary a changé.
Sinon : un simple check HTTP, zéro spam Actions.

Setup:
  1. export GITHUB_TOKEN=... (PAT classic : repo + workflow)
  2. python3 scripts/trigger_host.py

Env:
  GITHUB_TOKEN, GITHUB_REPO, INTERVAL (défaut 50)
"""

from __future__ import annotations

import os
import sys
import time

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
INTERVAL = int(os.environ.get("INTERVAL", "50"))
STATE_FILE = os.environ.get("BUILD_STATE_FILE", "last_canary_build.txt")


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def tick() -> None:
    build, _vh = get_canary_build()
    if not build:
        log("pas de BUILD_NUMBER")
        return
    last = read_state(STATE_FILE)
    if last == build:
        log(f"build {build} inchangé — pas de dispatch")
        return
    log(f"NOUVEAU build {last} → {build} — dispatch Actions")
    ok, msg = dispatch_github_actions(TOKEN, REPO, EVENT)
    if ok:
        write_state(STATE_FILE, build)
    else:
        log(f"dispatch échoué — on réessaiera: {msg}")


def main() -> None:
    log(f"smart trigger interval={INTERVAL}s repo={REPO}")
    if not TOKEN:
        log("ATTENTION: pas de TOKEN")
    while True:
        try:
            tick()
        except Exception as e:
            log(f"tick error: {e}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
