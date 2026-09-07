"""
Cog Discord.py — trigger Canary ultra-réactif

Place dans: cogs/canary_trigger.py
Load: await bot.load_extension("cogs.canary_trigger")

IMPORTANT vitesse:
  - INTERVAL_SECONDS = 20  → détection ~20s max après un build
  - GitHub Actions démarre en ~30–90s après le dispatch
  - Total réaliste: ~1–2 min derrière le build (souvent mieux que le seul cron)

Remplis GITHUB_TOKEN ci-dessous (classic PAT: repo + workflow).
"""
from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

import discord
from discord.ext import commands, tasks

# ═══════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════
GITHUB_TOKEN = "GITHUB_TOKEN"  # ← colle ton PAT classic ici (repo + workflow)
GITHUB_REPO = "kmljkjj/discord-canary-scraper"
DISPATCH_EVENT = "trigger-scraping"
INTERVAL_SECONDS = 20  # 15–25s = proche de Wumpus ; ne pas descendre sous 15
STATE_FILE = Path(__file__).resolve().parent / "last_canary_build.txt"
# ═══════════════════════════════════════════════════════

CANARY_URL = "https://canary.discord.com/app"
UA = "Mozilla/5.0 (compatible; Datamining-cog/3.0)"


def _http_get(url: str, timeout: int = 18) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "text/html"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", errors="replace")


def _get_build() -> str | None:
    try:
        html = _http_get(CANARY_URL)
    except Exception as e:
        print(f"[canary-cog] fetch fail: {e}", flush=True)
        return None
    m = re.search(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?', html)
    return m.group(1) if m else None


def _load_last() -> str | None:
    try:
        if STATE_FILE.exists():
            return STATE_FILE.read_text(encoding="utf-8").strip() or None
    except Exception:
        pass
    return None


def _save_last(bn: str) -> None:
    try:
        STATE_FILE.write_text(bn + "\n", encoding="utf-8")
    except Exception as e:
        print(f"[canary-cog] save fail: {e}", flush=True)


def _dispatch() -> tuple[bool, str]:
    token = GITHUB_TOKEN.strip()
    if not token or token == "GITHUB_TOKEN":
        return False, "colle ton PAT dans GITHUB_TOKEN du cog"
    url = f"https://api.github.com/repos/{GITHUB_REPO}/dispatches"
    body = json.dumps({"event_type": DISPATCH_EVENT}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "datamining-cog",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as res:
            return True, f"OK {res.status}"
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        return False, f"HTTP {e.code}: {err[:200]}"
    except Exception as e:
        return False, str(e)


def _tick_sync() -> str:
    bn = _get_build()
    if not bn:
        return "build=? fetch fail"
    last = _load_last()
    if last == bn:
        return f"build={bn} same"
    ok, msg = _dispatch()
    if ok:
        _save_last(bn)
        return f"NEW build={bn} (was {last}) dispatched {msg}"
    return f"NEW build={bn} dispatch FAIL {msg}"


class CanaryTrigger(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.auto_check.start()

    def cog_unload(self):
        self.auto_check.cancel()

    @tasks.loop(seconds=INTERVAL_SECONDS)
    async def auto_check(self):
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _tick_sync)
        print(f"[canary-cog] {result}", flush=True)

    @auto_check.before_loop
    async def before_auto(self):
        await self.bot.wait_until_ready()
        print(
            f"[canary-cog] start — check toutes les {INTERVAL_SECONDS}s → {GITHUB_REPO}",
            flush=True,
        )

    @commands.command(name="canary_check")
    @commands.is_owner()
    async def canary_check(self, ctx: commands.Context):
        """Vérif Canary + dispatch si nouveau build."""
        await ctx.send("Check Canary…")
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _tick_sync)
        await ctx.send(f"```\n{result}\n```")

    @commands.command(name="canary_force")
    @commands.is_owner()
    async def canary_force(self, ctx: commands.Context):
        """Force un dispatch même si le build n'a pas changé."""
        loop = asyncio.get_event_loop()
        ok, msg = await loop.run_in_executor(None, _dispatch)
        await ctx.send(f"{'✅' if ok else '❌'} `{msg}`")


async def setup(bot: commands.Bot):
    await bot.add_cog(CanaryTrigger(bot))
