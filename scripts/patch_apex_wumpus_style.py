#!/usr/bin/env python3
"""Align apex_rollouts with Wumpus-Central/guild-experiments approach."""
from pathlib import Path
import re

def main():
    p = Path('src/apex_rollouts.js')
    t = p.read_text()
    if 'discordClientHeaders' in t and 'WUMPUS_DEFS' in t:
        print('already patched')
        return

    # constants
    old_c = "const FALLBACK = process.env.APEX_FALLBACK_URL || 'https://raw.githubusercontent.com/discordexperimenthub/experimentAPI/master/experiments.json';"
    new_c = old_c + "\n" + (
        "const WUMPUS_DEFS =\n"
        "  process.env.APEX_DEFS_URL ||\n"
        "  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';\n"
        "const APEX_LOCAL = path.join(DATA_DIR, 'apex_experiments.json');"
    )
    if old_c not in t:
        raise SystemExit('FALLBACK const miss')
    t = t.replace(old_c, new_c, 1)

    # buildHashMap
    m = re.search(r'async function buildHashMap\(\) \{[\s\S]*?\n\}\n\nasync function fetchDiscord', t)
    if not m:
        raise SystemExit('buildHashMap block miss')
    new_hm = '''async function buildHashMap() {
  const map = new Map();
  const addId = (id) => {
    if (!id || typeof id !== 'string') return;
    const clean = id.trim();
    if (!clean) return;
    const h = murmur3(clean);
    map.set(h, clean);
    map.set(String(h), clean);
  };
  for (const file of [LOCAL_EXP, APEX_LOCAL, KNOWN_EXP]) {
    try {
      if (!(await fs.pathExists(file))) continue;
      const data = await fs.readJson(file);
      const list = Array.isArray(data) ? data : data.experiments || data.ids || [];
      for (const x of list) {
        if (typeof x === 'string') addId(x);
        else if (x && (x.id || x.name)) addId(String(x.id || x.name));
      }
    } catch (e) {
      console.warn('Hash map', path.basename(file) + ':', e.message);
    }
  }
  try {
    const res = await fetch(WUMPUS_DEFS, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeout: 20000,
    });
    if (res.ok) {
      const data = await res.json();
      let n = 0;
      for (const e of Array.isArray(data) ? data : []) {
        if (e && (e.id || e.name)) {
          addId(String(e.id || e.name));
          n++;
        }
      }
      console.log('Defs gist:', n, 'ids');
    }
  } catch (e) {
    console.warn('Defs gist:', e.message);
  }
  console.log('Hash map:', Math.floor(map.size / 2), 'ids');
  return map;
}

async function fetchDiscord'''
    t = t[: m.start()] + new_hm + t[m.end() :]

    # fetchDiscord full replace until fetchAdvaith
    m2 = re.search(
        r'async function fetchDiscord\(hashMap\) \{[\s\S]*?\n\}\n\nasync function fetchAdvaith',
        t,
    )
    if not m2:
        raise SystemExit('fetchDiscord block miss')
    new_fd = r'''function discordClientHeaders(withToken) {
  const superProps = Buffer.from(
    JSON.stringify({
      os: 'Windows',
      browser: 'Chrome',
      device: '',
      system_locale: 'en-US',
      browser_user_agent: UA,
      browser_version: '131.0.0.0',
      os_version: '10',
      referrer: '',
      referring_domain: '',
      release_channel: 'canary',
      client_build_number: 609601,
      client_event_source: null,
    }),
  ).toString('base64');
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Super-Properties': superProps,
    'X-Discord-Locale': 'en-US',
    Origin: 'https://canary.discord.com',
    Referer: 'https://canary.discord.com/channels/@me',
  };
  if (withToken && DISCORD_TOKEN) headers.Authorization = DISCORD_TOKEN;
  return headers;
}

async function fetchDiscordOnce(url, headers, hashMap, label) {
  const res = await fetch(url, { headers, timeout: 30000 });
  if (!res.ok) {
    console.warn('Discord', res.status, label, url);
    return [];
  }
  const data = await res.json();
  const ge = data.guild_experiments || [];
  console.log('Discord guild_experiments:', ge.length, '(' + label + ')');
  const parsed = ge.map((t) => fromWire(t, hashMap)).filter(Boolean);
  console.log(
    '  sample:',
    parsed.map((e) => e.id).slice(0, 12).join(', ') || '(none)',
  );
  console.log('  recent >=' + YEAR_MIN + ':', parsed.filter((e) => e.recent).length);
  return parsed;
}

// Wumpus-Central/guild-experiments: GET experiments?with_guild_experiments=true
// + X-Super-Properties client headers (returns more tuples than bare request)
async function fetchDiscord(hashMap) {
  const urls = [
    'https://canary.discord.com/api/v9/experiments?with_guild_experiments=true',
    'https://discord.com/api/v9/experiments?with_guild_experiments=true',
  ];
  const byHash = new Map();
  const ingest = (list) => {
    for (const e of list) {
      const key = e.hash != null ? String(e.hash) : e.id;
      const prev = byHash.get(key);
      if (!prev) {
        byHash.set(key, e);
        continue;
      }
      const prevHashId = String(prev.id).startsWith('hash:');
      const nextHashId = String(e.id).startsWith('hash:');
      if (prevHashId && !nextHashId) byHash.set(key, e);
      else if ((e.treatments || []).length > (prev.treatments || []).length)
        byHash.set(key, e);
    }
  };

  for (const url of urls) {
    try {
      ingest(await fetchDiscordOnce(url, discordClientHeaders(false), hashMap, 'client'));
      break;
    } catch (e) {
      console.warn('Discord client fail', e.message);
    }
  }
  if (DISCORD_TOKEN) {
    for (const url of urls) {
      try {
        ingest(await fetchDiscordOnce(url, discordClientHeaders(true), hashMap, 'token'));
        break;
      } catch (e) {
        console.warn('Discord token fail', e.message);
      }
    }
  }

  const out = [...byHash.values()];
  console.log(
    'Discord merged unique:',
    out.length,
    'recent',
    out.filter((e) => e.recent).length,
  );
  return out;
}

async function fetchAdvaith'''
    t = t[: m2.start()] + new_fd + t[m2.end() :]

    t = t.replace('Apex rollouts v3.2', 'Apex rollouts v4 (Wumpus-style)', 1)
    t = t.replace(
        "console.log('📊 Apex rollouts v3…');",
        "console.log('📊 Apex rollouts v4 (Wumpus-style)…');",
        1,
    )

    p.write_text(t)
    print('patched ok')

if __name__ == '__main__':
    main()
