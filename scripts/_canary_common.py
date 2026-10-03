#!/usr/bin/env python3
"""
Shared utilities for Canary build trigger scripts.

Used by:
  - scripts/canary_trigger.py
  - scripts/trigger_host.py
  - cogs/canary_trigger.py (async variant)

Centralises: HTTP fetch, BUILD_NUMBER extraction, state file I/O,
and GitHub Actions dispatch.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path

# ── Constants ──────────────────────────────────────────────
CANARY_URLS = (
    "https://canary.discord.com/app",
    "https://canary.discord.com/login",
    "https://canary.discord.com/channels/@me",
)

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

BUILD_RE = re.compile(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?')
HASH_RE = re.compile(r'"VERSION_HASH"\s*:\s*"([a-f0-9]{8,})"', re.I)

DEFAULT_REPO = "kmljkjj/discord-canary-scraper"
DEFAULT_EVENT = "trigger-scraping"


# ── HTTP ───────────────────────────────────────────────────
def http_get(url: str, timeout: int = 20, ua: str = DEFAULT_UA) -> str:
    """Fetch URL and return decoded text."""
    req = urllib.request.Request(
        url, headers={"User-Agent": ua, "Accept": "text/html"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", errors="replace")


def http_post_json(url: str, body: dict, headers: dict, timeout: int = 30) -> tuple:
    """POST JSON and return (status_code, response_text)."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={**headers, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, ""
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        return e.code, err
    except Exception as e:
        return 0, str(e)


# ── Canary build extraction ────────────────────────────────
def get_canary_build(ua: str = DEFAULT_UA, timeout: int = 20) -> tuple:
    """Fetch canary.discord.com and return (build_number, version_hash) or (None, None)."""
    for url in CANARY_URLS:
        try:
            html = http_get(url, timeout=timeout, ua=ua)
        except Exception:
            continue
        bm = BUILD_RE.search(html)
        if bm:
            hm = HASH_RE.search(html)
            return bm.group(1), hm.group(1) if hm else None
    return None, None


# ── State file I/O ─────────────────────────────────────────
def read_state(state_file) -> str | None:
    """Read last known build number from state file."""
    p = Path(state_file) if not isinstance(state_file, Path) else state_file
    try:
        if p.exists():
            return p.read_text(encoding="utf-8").strip() or None
    except Exception:
        return None
    return None


def write_state(state_file, build: str) -> None:
    """Write build number to state file (atomic-ish: write then flush)."""
    p = Path(state_file) if not isinstance(state_file, Path) else state_file
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(build, encoding="utf-8")
        tmp.replace(p)
    except Exception:
        pass


# ── GitHub Actions dispatch ────────────────────────────────
def dispatch_github_actions(
    token: str,
    repo: str = DEFAULT_REPO,
    event: str = DEFAULT_EVENT,
    ua: str = DEFAULT_UA,
    timeout: int = 30,
) -> tuple:
    """Dispatch a GitHub Actions repository_dispatch event.
    Returns (success: bool, message: str).
    """
    if not token or len(token) < 20:
        return False, "TOKEN manquant (GITHUB_TOKEN ou GH_TOKEN)"
    url = f"https://api.github.com/repos/{repo}/dispatches"
    status, err = http_post_json(
        url,
        {"event_type": event},
        {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": ua,
        },
        timeout=timeout,
    )
    if status == 204:
        return True, f"DISPATCH OK → {repo}"
    return False, f"DISPATCH HTTP {status}: {err[:300]}"
