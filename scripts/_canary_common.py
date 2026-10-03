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

# Token GitHub conseillé : PAT *fine-grained* limité à ce seul dépôt, avec
# uniquement la permission « Contents: Read and write » (suffit pour
# POST /repos/{repo}/dispatches). Pas de PAT classic repo+workflow.

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


# ── State format ───────────────────────────────────────────
# Format commun aux 3 déclencheurs (scripts + cog) : "BUILD" ou "BUILD:HASH".
def state_token(build: str, version_hash: str | None = None) -> str:
    """Return the shared state token: "build:hash12" (hash optional)."""
    build = str(build).strip()
    if version_hash:
        return f"{build}:{str(version_hash).strip()[:12]}"
    return build


def build_of(token: str | None) -> str | None:
    """Extract the build number from a state token ("123" or "123:abc")."""
    if not token:
        return None
    return str(token).strip().split(":", 1)[0] or None


def is_same_state(last: str | None, current: str) -> bool:
    """True if `current` is already recorded in `last`.

    Compatible with legacy files that only contain the build number: when one
    side has no hash, only build numbers are compared.
    """
    if not last:
        return False
    last = str(last).strip()
    current = str(current).strip()
    if last == current:
        return True
    if ":" not in last or ":" not in current:
        return build_of(last) == build_of(current)
    return False


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


def write_state(state_file, token: str) -> bool:
    """Atomically write the state token (tmp file + replace). Returns success."""
    p = Path(state_file) if not isinstance(state_file, Path) else state_file
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(token, encoding="utf-8")
        tmp.replace(p)
        return True
    except Exception as e:
        print(f"[canary] state write fail {p}: {e}", flush=True)
        return False


def dispatch_body(event: str = DEFAULT_EVENT, build: str | None = None) -> dict:
    """repository_dispatch body. `client_payload.build` lets the scrape.yml
    anti-storm guard compare against the build that triggered the dispatch
    instead of re-fetching canary.discord.com (which may differ)."""
    body: dict = {"event_type": event}
    b = build_of(build)
    if b:
        body["client_payload"] = {"build": b}
    return body


# ── GitHub Actions dispatch ────────────────────────────────
def dispatch_github_actions(
    token: str,
    repo: str = DEFAULT_REPO,
    event: str = DEFAULT_EVENT,
    ua: str = DEFAULT_UA,
    timeout: int = 30,
    build: str | None = None,
) -> tuple:
    """Dispatch a GitHub Actions repository_dispatch event.
    Returns (success: bool, message: str).
    """
    if not token or len(token) < 20:
        return False, "TOKEN manquant (GITHUB_TOKEN ou GH_TOKEN)"
    url = f"https://api.github.com/repos/{repo}/dispatches"
    status, err = http_post_json(
        url,
        dispatch_body(event, build),
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
