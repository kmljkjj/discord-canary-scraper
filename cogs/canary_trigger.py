"""
Cog Discord.py — trigger Canary ultra-rapide
cogs/canary_trigger.py

  await bot.load_extension("cogs.canary_trigger")

Colle ton PAT classic (repo + workflow) dans GITHUB_TOKEN.
"""

from __future__ import annotations

import asyncio
import json
import re
import socket
import ssl
import urllib.error
import urllib.request
from pathlib import Path

import discord
from discord.ext import commands, tasks

# ═══════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════
GITHUB_TOKEN = "ghp_COLLLE_TON_TOKEN_ICI"  # PAT classic : repo + workflow
GITHUB_REPO = "kmljkjj/discord-canary-scraper"
DISPATCH_EVENT = "trigger-scraping"
INTERVAL_SECONDS = 20
STATE_FILE = Path(__file__).resolve().parent / "last_canary_build.txt"
# ═══════════════════════════════════════════════════════

# Plusieurs URLs : si /app renvoie 400, /login a souvent le même BUILD_NUMBER
CANARY_URLS = (
    "https://canary.discord.com/app",
    "https://canary.discord.com/login",
    "https://canary.discord.com/channels/@me",
)

# UA navigateur réel (les UA "bot" se font parfois 400 / Cloudflare)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
_BUILD_RE = re.compile(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?')
_HASH_RE = re.compile(r'"VERSION_HASH"\s*:\s*"([a-f0-9]{8,})"', re.I)

HTTP_TIMEOUT = 15
DISPATCH_TIMEOUT = 15

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
            # Pas besoin de toute la page : BUILD_NUMBER est en début de HTML
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
    except urllib.error.HTTPError as e:
        print(f"[canary-cog] HTTP {e.code} {url}", flush=True)
        raise
    except Exception as e:
        print(f"[canary-cog] fetch fail {url}: {e}", flush=True)
        raise
    return None, None


def _read_build_fast() -> tuple[str | None, str | None]:
    """Essaie plusieurs URLs + 1 retry."""
    last_err = None
    for attempt in range(2):
        for url in CANARY_URLS:
            try:
                build, h = _read_build_from_url(url)
                if build:
                    return build, h
            except Exception as e:
                last_err = e
                continue
        if attempt == 0:
            # petite pause avant retry
            import time

            time.sleep(1.2)
    if last_err:
        print(f"[canary-cog] all URLs failed: {last_err}", flush=True)
    return None, None


def _read_last() -> str | None:
    try:
        if STATE_FILE.is_file():
            return STATE_FILE.read_text(encoding="utf-8").strip() or None
    except Exception:
        pass
    return None


def _write_last(token: str) -> None:
    try:
        STATE_FILE.write_text(token, encoding="utf-8")
    except Exception as e:
        print(f"[canary-cog] state write fail: {e}", flush=True)


def _state_token(build: str, version_hash: str | None) -> str:
    if version_hash:
        return f"{build}:{version_hash}"
    return build


def _dispatch() -> tuple[bool, str]:
    tok = (GITHUB_TOKEN or "").strip()
    if not tok or len(tok) < 20 or "COLLLE" in tok or tok == "GITHUB_TOKEN":
        return False, "GITHUB_TOKEN manquant / invalide"

    url = f"https://api.github.com/repos/{GITHUB_REPO}/dispatches"
    body = json.dumps({"event_type": DISPATCH_EVENT}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {tok}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "datamining-cog-trigger",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=DISPATCH_TIMEOUT) as res:
            return True, f"OK {res.status} → {GITHUB_REPO}"
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        return False, f"HTTP {e.code}: {err[:200]}"
    except Exception as e:
        return False, str(e)


def _tick_sync() -> str:
    build, vhash = _read_build_fast()
    if not build:
        return "pas de BUILD_NUMBER (fetch 400/blocked — retry next tick)"
    token = _state_token(build, vhash)
    last = _read_last()
    if last == token:
        return f"build {build} inchangé — skip"
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
        except Exception:
            pass
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
