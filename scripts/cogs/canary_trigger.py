"""
Cog Discord.py — trigger intelligent Canary

Place ce fichier dans ton bot :
  cogs/canary_trigger.py

Puis dans ton main :
  await bot.load_extension("cogs.canary_trigger")

Le cog vérifie le BUILD_NUMBER Canary toutes les INTERVAL secondes
et dispatch GitHub Actions seulement si le build a changé.
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
# CONFIG — remplis ici
# ═══════════════════════════════════════════════════════
GITHUB_TOKEN = "ghp_REMPLACE_MOI"  # PAT classic : repo + workflow
GITHUB_REPO = "kmljkjj/discord-canary-scraper"
DISPATCH_EVENT = "trigger-scraping"
INTERVAL_SECONDS = 50  # toutes les 50s (comme tu veux)
# Fichier local pour mémoriser le dernier build vu
STATE_FILE = Path(__file__).resolve().parent / "last_canary_build.txt"
# ═══════════════════════════════════════════════════════

CANARY_URL = "https://canary.discord.com/app"
UA = "Mozilla/5.0 (compatible; canary-cog-trigger/2.0)"


def _http_get(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "text/html"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", errors="replace")


def _get_canary_build() -> str | None:
    try:
        html = _http_get(CANARY_URL)
    except Exception as e:
        print(f"[canary-cog] canary fetch fail: {e}", flush=True)
        return None
    m = re.search(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?', html)
    return m.group(1) if m else None


def _read_last() -> str | None:
    try:
        if STATE_FILE.is_file():
            return STATE_FILE.read_text(encoding="utf-8").strip() or None
    except Exception:
        pass
    return None


def _write_last(build: str) -> None:
    try:
        STATE_FILE.write_text(build, encoding="utf-8")
    except Exception as e:
        print(f"[canary-cog] write state fail: {e}", flush=True)


def _dispatch() -> tuple[bool, str]:
    if not GITHUB_TOKEN or GITHUB_TOKEN.startswith("ghp_REMPLACE") or len(GITHUB_TOKEN) < 20:
        return False, "GITHUB_TOKEN manquant / invalide dans le cog"

    url = f"https://api.github.com/repos/{GITHUB_REPO}/dispatches"
    body = json.dumps({"event_type": DISPATCH_EVENT}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "canary-cog-trigger",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return True, f"OK {res.status} dispatch → {GITHUB_REPO}"
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        return False, f"HTTP {e.code}: {err[:250]}"
    except Exception as e:
        return False, str(e)


def _tick_sync() -> str:
    build = _get_canary_build()
    if not build:
        return "pas de BUILD_NUMBER"
    last = _read_last()
    if last == build:
        return f"build {build} inchangé — pas de dispatch"
    ok, msg = _dispatch()
    if ok:
        _write_last(build)
        return f"NOUVEAU {last} → {build} | {msg}"
    return f"NOUVEAU {last} → {build} mais dispatch échoué: {msg}"


class CanaryTrigger(commands.Cog):
    """Vérifie Canary et dispatch GitHub seulement si nouveau build."""

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
            f"[canary-cog] démarré — check toutes les {INTERVAL_SECONDS}s → {GITHUB_REPO}",
            flush=True,
        )

    @commands.command(name="canary_check")
    @commands.is_owner()
    async def canary_check(self, ctx: commands.Context):
        """Force une vérif Canary + dispatch si nouveau build."""
        await ctx.send("Vérification Canary…")
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _tick_sync)
        await ctx.send(f"```\n{result}\n```")

    @commands.command(name="canary_force")
    @commands.is_owner()
    async def canary_force(self, ctx: commands.Context):
        """Force un dispatch GitHub même si le build n'a pas changé."""
        loop = asyncio.get_event_loop()
        ok, msg = await loop.run_in_executor(None, _dispatch)
        await ctx.send(f"{'✅' if ok else '❌'} `{msg}`")


async def setup(bot: commands.Bot):
    await bot.add_cog(CanaryTrigger(bot))
