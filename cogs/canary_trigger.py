"""
Cog Discord.py — trigger Canary ultra-rapide
cogs/canary_trigger.py

  await bot.load_extension("cogs.canary_trigger")

Colle ton PAT classic (repo + workflow) dans GITHUB_TOKEN.
Laisse le bot tourner 24/7 pour rivaliser avec Wumpus.
"""

from __future__ import annotations

import asyncio
import json
import re
import socket
import urllib.error
import urllib.request
from pathlib import Path

import discord
from discord.ext import commands, tasks

# ═══════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════
GITHUB_TOKEN = "GITHUB_TOKEN"  # PAT classic : repo + workflow
GITHUB_REPO = "kmljkjj/discord-canary-scraper"
DISPATCH_EVENT = "trigger-scraping"
INTERVAL_SECONDS = 20  # 15–25s idéal ; sous 15 = risque rate-limit inutile
STATE_FILE = Path(__file__).resolve().parent / "last_canary_build.txt"
# ═══════════════════════════════════════════════════════

CANARY_URL = "https://canary.discord.com/app"
UA = "Mozilla/5.0 (compatible; Datamining-cog/3.1)"
_BUILD_RE = re.compile(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?')
_HASH_RE = re.compile(r'"VERSION_HASH"\s*:\s*"([a-f0-9]{8,})"', re.I)

HTTP_TIMEOUT = 12
DISPATCH_TIMEOUT = 15

_OPENER = urllib.request.build_opener()


def _read_build_fast(url: str) -> tuple[str | None, str | None]:
    """Stream le HTML et stop dès BUILD_NUMBER (pas toute la page)."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html",
            "Accept-Encoding": "identity",
            "Connection": "close",
        },
        method="GET",
    )
    try:
        with _OPENER.open(req, timeout=HTTP_TIMEOUT) as res:
            buf = ""
            while True:
                chunk = res.read(4096)
                if not chunk:
                    break
                buf += chunk.decode("utf-8", errors="replace")
                m = _BUILD_RE.search(buf)
                if m:
                    build = m.group(1)
                    h = _HASH_RE.search(buf)
                    if not h and len(buf) < 20000:
                        extra = res.read(8192)
                        if extra:
                            buf += extra.decode("utf-8", errors="replace")
                            h = _HASH_RE.search(buf)
                    return build, (h.group(1)[:12] if h else None)
            m = _BUILD_RE.search(buf)
            if m:
                h = _HASH_RE.search(buf)
                return m.group(1), (h.group(1)[:12] if h else None)
    except Exception as e:
        print(f"[canary-cog] fetch fail: {e}", flush=True)
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
    if (
        not tok
        or len(tok) < 20
        or tok == "GITHUB_TOKEN"
        or "REMPLACE" in tok
        or tok.startswith("ghp_") is False
        and not tok.startswith("github_pat_")
    ):
        # accepte ghp_ (classic) et github_pat_ (fine-grained)
        if not tok or tok == "GITHUB_TOKEN" or len(tok) < 20:
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
    build, vhash = _read_build_fast(CANARY_URL)
    if not build:
        return "pas de BUILD_NUMBER"
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
    """Check Canary toutes les N secondes → dispatch GitHub si nouveau build."""

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
        """Vérif manuelle (dispatch seulement si nouveau)."""
        await ctx.send("Check Canary…")
        result = await asyncio.to_thread(_tick_sync)
        await ctx.send(f"```\n{result}\n```")

    @commands.command(name="canary_force")
    @commands.is_owner()
    async def canary_force(self, ctx: commands.Context):
        """Force un dispatch même si build identique."""
        ok, msg = await asyncio.to_thread(_dispatch)
        await ctx.send(f"{'✅' if ok else '❌'} `{msg}`")


async def setup(bot: commands.Bot):
    await bot.add_cog(CanaryTrigger(bot))
