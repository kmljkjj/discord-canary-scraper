#!/usr/bin/env python3
from pathlib import Path

def main():
    apex = Path('src/apex_rollouts.js')
    if not apex.exists():
        print('no apex')
        return 1
    t = apex.read_text()
    if 'guild_decode' in t:
        print('already wired')
        return 0
    inject = """
// Prefer structured decoder when available
let decodeGuildExperiment = null;
try {
  decodeGuildExperiment = require('./lib/guild_decode').decodeGuildExperiment;
} catch (_) {
  try {
    decodeGuildExperiment = require('../lib/guild_decode').decodeGuildExperiment;
  } catch (_) {}
}
"""
    if "const path = require('path');" in t:
        t = t.replace(
            "const path = require('path');",
            "const path = require('path');\n" + inject,
            1,
        )
    old = "function fromWire(tuple, hashMap) {\n  if (!Array.isArray(tuple) || tuple.length < 4) return null;"
    new = """function fromWire(tuple, hashMap) {
  if (typeof decodeGuildExperiment === 'function') {
    try {
      const d = decodeGuildExperiment(tuple, hashMap);
      if (d) return d;
    } catch (_) {}
  }
  if (!Array.isArray(tuple) || tuple.length < 4) return null;"""
    if old not in t:
        print('fromWire start missing')
        return 1
    t = t.replace(old, new, 1)
    for a, b in [
        ('Apex rollouts v3 — live Discord + advaith (2024/2025/2026 %)', 'Apex rollouts v3.2 — Discord live % + structured guild decode'),
        ('Apex rollouts v3.1 — Discord live % (restored + soft fixes)', 'Apex rollouts v3.2 — Discord live % + structured guild decode'),
        ('Apex rollouts v3.1 — Discord live % (restored)', 'Apex rollouts v3.2 — Discord live % + structured guild decode'),
    ]:
        if a in t:
            t = t.replace(a, b, 1)
            break
    apex.write_text(t)
    print('wired ok')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
