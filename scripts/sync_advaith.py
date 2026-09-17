#!/usr/bin/env python3
"""Sync api.rollouts.advaith.io -> data/advaith_cache.json (run on PC/bot host)."""
from __future__ import annotations
import json, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "advaith_cache.json"
URL = "https://api.rollouts.advaith.io/"
def main():
    req = urllib.request.Request(URL, headers={
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://rollouts.advaith.io/",
        "Origin": "https://rollouts.advaith.io",
    })
    with urllib.request.urlopen(req, timeout=60) as res:
        data = json.loads(res.read().decode())
    if not isinstance(data, list):
        raise SystemExit("bad shape")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Wrote {len(data)} -> {OUT}")
if __name__ == "__main__":
    main()
