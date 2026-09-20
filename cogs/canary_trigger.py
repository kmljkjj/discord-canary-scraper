"""
Cog Discord.py — trigger Canary ultra-rapide
cogs/canary_trigger.py

  await bot.load_extension("cogs.canary_trigger")

Set env GITHUB_TOKEN (or GH_TOKEN) — PAT classic: repo + workflow.
Never hardcode tokens in this file.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import ssl
import urllib.error
import urllib.request
from pathlib import Path

import discord
from discord.ext import commands, tasks

# ═══════════════════════════════════════════════════════
# CONFIG (secrets via environment only)
# ═══════════════════════════════════════════════════════
GITHUB_TOKEN = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
GITHUB_REPO = os.environ.get("GITHUB_REPO") or "kmljkjj/discord-canary-scraper"
DISPATCH_EVENT = "trigger-scraping"
INTERVAL_SECONDS = 15  # détection build ~15s max (bot 24/7 requis)
STATE_FILE = Path(
    os.environ.get("CANARY_STATE_FILE") or (Path.cwd() / "data" / "last_canary_build.txt")
)
# ═══════════════════════════════════════════════════════

CANARY_URLS = (
    "https://canary.discord.com/app",
    "https://canary.discord.com/login",
    "https://canary.discord.com/channels/@me",
)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
_BUILD_RE = re.compile(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?')
_HASH_RE = re.compile(r'"VERSION_HASH"\s*:\s*"([a-f0-9]{8,})"', re.I)

HTTP_TIMEOUT = 12
DISPATCH_TIMEOUT = 12

_CTX = ssl.create_default_context()


def _headers() -> dict:
    return {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }


def _read_build_from_url(url: str) -> tuple[str | None, str | None]:
    req = urllib.request.Request(url, headers=_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT, context=_CTX) as res:
            buf = b""
            while len(buf) < 65536:
                chunk = res.read(8192)
                if not chunk:
                    break
                buf += chunk
                text = buf.decode("utf-8", errors="replace")
                m = _BUILD_RE.search(text)
                if m:
                    h = _HASH_RE.search(text)
                    return m.group(1), (h.group(1)[:12] if h else None)
            text = buf.decode("utf-8", errors="replace")
            m = _BUILD_RE.search(text)
            if m:
                h = _HASH_RE.search(text)
                return m.group(1), (h.group(1)[:12] if h else None)
    except Exception as e:
        print(f"[canary-cog] read fail {url}: {e}", flush=True)
    return None, None


def _fetch_build() -> tuple[str | None, str | None]:
    for url in CANARY_URLS:
        build, vhash = _read_build_from_url(url)
        if build:
            return build, vhash
    return None, None


def _read_last() -> str | None:
    try:
        if STATE_FILE.is_file():
            return STATE_FILE.read_text(encoding="utf-8").strip() or None
    except Exception as e:
        print(f"[canary-cog] state read fail: {e}", flush=True)
    return None


def _write_last(token: str) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(token, encoding="utf-8")
    except Exception as e:
        print(f"[canary-cog] state write fail: {e}", flush=True)


def _state_token(build: str, version_hash: str | None) -> str:
    if version_hash:
        return f"{build}:{version_hash}"
    return str(build)


def _dispatch() -> tuple[bool, str]:
    tok = (GITHUB_TOKEN or "").strip()
    if not tok or len(tok) < 20 or "COLLLE" in tok or tok == "GITHUB_TOKEN":
        return False, "GITHUB_TOKEN manquant / invalide (export GITHUB_TOKEN=...)"

    url = f"https://api.github.com/repos/{GITHUB_REPO}/dispatches"
    body = json.dumps({"event_type": DISPATCH_EVENT}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {tok}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "canary-trigger-cog",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=DISPATCH_TIMEOUT) as res:
            return True, f"OK {res.status} → {GITHUB_REPO}"
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        if e.code == 403:
            retry_after = int(e.headers.get("Retry-After", 60) or 60)
            return False, f"GitHub rate limit / 403 (retry ~{retry_after}s): {err[:200]}"
        return False, f"DISPATCH HTTP {e.code}: {err[:300]}"
    except Exception as e:
        return False, f"DISPATCH error: {e}"


def _tick_sync() -> str:
    build, vhash = _fetch_build()
    if not build:
        return "SKIP no BUILD_NUMBER"
    token = _state_token(build, vhash)
    last = _read_last()
    if last == token:
        return f"SAME {token}"
    ok, msg = _dispatch()
    if ok:
        _write_last(token)
        return f"NOUVEAU {last} → {token} | {msg}"
    return f"NOUVEAU {last} → {token} mais dispatch fail: {msg}"


class CanaryTrigger(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._lock = asyncio.Lock()
        self.auto_check.start()

    def cog_unload(self):
        self.auto_check.cancel()

    @tasks.loop(seconds=INTERVAL_SECONDS)
    async def auto_check(self):
        if self._lock.locked():
            return
        async with self._lock:
            result = await asyncio.to_thread(_tick_sync)
            print(f"[canary-cog] {result}", flush=True)

    @auto_check.before_loop
    async def before_auto(self):
        await self.bot.wait_until_ready()
        try:
            await asyncio.to_thread(socket.getaddrinfo, "canary.discord.com", 443)
        except (socket.gaierror, OSError) as e:
            print(f"[canary-cog] DNS resolution failed (non-fatal): {e}", flush=True)
        except Exception as e:
            print(f"[canary-cog] warmup error (non-fatal): {e}", flush=True)
        if not GITHUB_TOKEN:
            print(
                "[canary-cog] WARNING: GITHUB_TOKEN env missing — dispatch disabled",
                flush=True,
            )
        print(
            f"[canary-cog] ready — every {INTERVAL_SECONDS}s → {GITHUB_REPO}",
            flush=True,
        )

    @commands.command(name="canary_check")
    @commands.is_owner()
    async def canary_check(self, ctx: commands.Context):
        await ctx.send("Check Canary…")
        result = await asyncio.to_thread(_tick_sync)
        await ctx.send(f"```\n{result}\n```")

    @commands.command(name="canary_force")
    @commands.is_owner()
    async def canary_force(self, ctx: commands.Context):
        ok, msg = await asyncio.to_thread(_dispatch)
        await ctx.send(f"{'✅' if ok else '❌'} `{msg}`")


async def setup(bot: commands.Bot):
    await bot.add_cog(CanaryTrigger(bot))
