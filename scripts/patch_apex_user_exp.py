#!/usr/bin/env python3
"""Add user-experiment support to apex_rollouts.js (assignments + type=user)."""
from pathlib import Path
import re

def main():
    p = Path('src/apex_rollouts.js')
    t = p.read_text()
    if 'fromUserAssignment' in t and 'sources.user' in t:
        print('already has user support')
        return

    # 1) fromUserAssignment after fromWire return block — insert before fromAdvaith
    marker = "/** advaith shape:"
    if marker not in t:
        marker = "function fromAdvaith"
    insert = r'''
/** User assignment from GET /experiments → assignments[]
 * [hash, revision, bucket, override, population, hash_result, aa_mode, trigger_debugging, holdout_name?, ...]
 * Discord does NOT expose global user % here — only this account's bucket.
 * We still track revision/bucket changes; global user % comes from workers/fallback.
 */
function fromUserAssignment(tuple, hashMap) {
  if (!Array.isArray(tuple) || tuple.length < 3) return null;
  const hash = tuple[0];
  const revision = tuple[1];
  const bucket = tuple[2];
  const override = tuple[3];
  const population = tuple[4];
  const hashResult = tuple[5];
  const holdout = typeof tuple[8] === 'string' ? tuple[8] : null;
  let id =
    hashMap.get(Number(hash)) ||
    hashMap.get(String(hash)) ||
    (holdout && String(holdout)) ||
    ('hash:' + hash);
  const label = tLabel(bucket);
  const treatments = [{ bucket, label, pct: null, assigned: true }];
  const fingerprint =
    'user|b:' +
    bucket +
    '|rev:' +
    revision +
    '|pop:' +
    population +
    '|hr:' +
    hashResult +
    '|ov:' +
    override;
  return {
    id: String(id),
    type: 'user',
    title: String(id),
    treatments,
    populations: [],
    overrideIdCount: override === 0 ? 1 : 0,
    populationCount: 0,
    fingerprint,
    revision,
    hash: Number(hash),
    hashResult: hashResult != null ? Number(hashResult) : null,
    assignedBucket: bucket,
    recent: isRecent(id),
    source: 'discord-assignment',
    // no global % available from API for user experiments
    hasGlobalPct: false,
  };
}

'''
    if 'function fromUserAssignment' not in t:
        t = t.replace(marker, insert + marker, 1)

    # 2) Ensure fromObject preserves type and hasGlobalPct
    old_fo_ret = """  return {
    id,
    type,
    title,
    treatments,
    populations: details,
    overrideIdCount: ov,
    populationCount: pops.length,
    fingerprint,
    revision: rollout.revision ?? null,
    hash: raw.hash ?? null,
    recent: isRecent(id),
    source: 'object',
  };
}"""
    new_fo_ret = """  return {
    id,
    type,
    title,
    treatments,
    populations: details,
    overrideIdCount: ov,
    populationCount: pops.length,
    fingerprint,
    revision: rollout.revision ?? null,
    hash: raw.hash ?? null,
    recent: isRecent(id),
    source: 'object',
    hasGlobalPct: treatments.some((x) => x.pct != null && Number.isFinite(x.pct)),
  };
}"""
    if old_fo_ret in t:
        t = t.replace(old_fo_ret, new_fo_ret, 1)

    # 3) fetchDiscordOnce: also parse assignments
    old_once = """async function fetchDiscordOnce(url, headers, hashMap, label) {
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
}"""
    new_once = """async function fetchDiscordOnce(url, headers, hashMap, label) {
  const res = await fetch(url, { headers, timeout: 30000 });
  if (!res.ok) {
    console.warn('Discord', res.status, label, url);
    return { guild: [], user: [] };
  }
  const data = await res.json();
  const ge = data.guild_experiments || [];
  const asg = data.assignments || [];
  console.log('Discord guild_experiments:', ge.length, '(' + label + ')');
  console.log('Discord user assignments:', asg.length, '(' + label + ')');
  const guild = ge.map((t) => fromWire(t, hashMap)).filter(Boolean);
  const user = asg.map((t) => fromUserAssignment(t, hashMap)).filter(Boolean);
  console.log(
    '  guild sample:',
    guild.map((e) => e.id).slice(0, 8).join(', ') || '(none)',
  );
  console.log(
    '  user sample:',
    user.map((e) => e.id + '@b' + e.assignedBucket).slice(0, 8).join(', ') || '(none)',
  );
  console.log(
    '  recent guild/user ≥' + YEAR_MIN + ':',
    guild.filter((e) => e.recent).length,
    '/',
    user.filter((e) => e.recent).length,
  );
  return { guild, user };
}"""
    if old_once not in t:
        raise SystemExit('fetchDiscordOnce miss')
    t = t.replace(old_once, new_once, 1)

    # 4) fetchDiscord merge guild + user
    old_fd = """async function fetchDiscord(hashMap) {
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
}"""
    new_fd = """async function fetchDiscord(hashMap) {
  const urls = [
    'https://canary.discord.com/api/v9/experiments?with_guild_experiments=true',
    'https://discord.com/api/v9/experiments?with_guild_experiments=true',
  ];
  const byKey = new Map();
  const ingest = (list) => {
    for (const e of list) {
      const key = (e.type || 'x') + ':' + (e.hash != null ? String(e.hash) : e.id);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, e);
        continue;
      }
      const prevHashId = String(prev.id).startsWith('hash:');
      const nextHashId = String(e.id).startsWith('hash:');
      if (prevHashId && !nextHashId) byKey.set(key, e);
      else if ((e.treatments || []).length > (prev.treatments || []).length)
        byKey.set(key, e);
      // prefer assignment with named id
      else if (prev.source === 'discord-assignment' && !nextHashId) byKey.set(key, e);
    }
  };

  for (const url of urls) {
    try {
      const { guild, user } = await fetchDiscordOnce(
        url,
        discordClientHeaders(false),
        hashMap,
        'client',
      );
      ingest(guild);
      ingest(user);
      break;
    } catch (e) {
      console.warn('Discord client fail', e.message);
    }
  }
  if (DISCORD_TOKEN) {
    for (const url of urls) {
      try {
        const { guild, user } = await fetchDiscordOnce(
          url,
          discordClientHeaders(true),
          hashMap,
          'token',
        );
        ingest(guild);
        ingest(user);
        break;
      } catch (e) {
        console.warn('Discord token fail', e.message);
      }
    }
  }

  const out = [...byKey.values()];
  const u = out.filter((e) => e.type === 'user').length;
  const g = out.filter((e) => e.type === 'guild').length;
  console.log(
    'Discord merged unique:',
    out.length,
    '(user',
    u,
    '/ guild',
    g + ')',
    'recent',
    out.filter((e) => e.recent).length,
  );
  return out;
}"""
    if old_fd not in t:
        raise SystemExit('fetchDiscord miss')
    t = t.replace(old_fd, new_fd, 1)

    # 5) loadExperiments sources + prefer workers user % over assignment-only
    old_src = """  const sources = {
    discord: 0,
    advaith: 0,
    workers: 0,
    fallback: 0,
    merged: 0,
    recent: 0,
    hasToken: !!DISCORD_TOKEN,
  };
  const byId = new Map();

  // 1) Live Discord (priority for % accuracy)
  try {
    const live = await fetchDiscord(hashMap);
    sources.discord = live.length;
    for (const e of live) byId.set(e.id, e);
  } catch (e) {
    console.warn(e.message);
  }"""
    new_src = """  const sources = {
    discord: 0,
    advaith: 0,
    workers: 0,
    fallback: 0,
    merged: 0,
    recent: 0,
    user: 0,
    guild: 0,
    hasToken: !!DISCORD_TOKEN,
  };
  const byId = new Map();

  // 1) Live Discord — guild wire (global %) + user assignments (bucket only)
  try {
    const live = await fetchDiscord(hashMap);
    sources.discord = live.length;
    for (const e of live) byId.set(e.id, e);
  } catch (e) {
    console.warn(e.message);
  }"""
    if old_src not in t:
        raise SystemExit('sources miss')
    t = t.replace(old_src, new_src, 1)

    # Prefer object/workers with global % over assignment-only for same id
    old_workers = """      for (const raw of arr) {
        const n = fromObject(raw);
        if (!n) continue;
        if (byId.has(n.id)) continue; // never replace live
        byId.set(n.id, n);
        added++;
      }"""
    new_workers = """      for (const raw of arr) {
        const n = fromObject(raw);
        if (!n) continue;
        const prev = byId.get(n.id);
        if (prev) {
          // Upgrade assignment-only user entry with global % from workers/fallback
          if (
            prev.source === 'discord-assignment' &&
            n.hasGlobalPct &&
            (n.type === 'user' || n.type === 'guild')
          ) {
            n.assignedBucket = prev.assignedBucket;
            byId.set(n.id, n);
            added++;
          }
          continue; // never replace richer live guild wire / advaith
        }
        byId.set(n.id, n);
        added++;
      }"""
    if old_workers not in t:
        raise SystemExit('workers loop miss')
    t = t.replace(old_workers, new_workers, 1)

    old_stats = """  sources.merged = experiments.length;
  sources.recent = experiments.filter((e) => e.recent).length;

  if (!DISCORD_TOKEN) console.warn('⚠️ DISCORD_USER_TOKEN manquant');
  if (sources.advaith === 0 && sources.recent === 0)
    console.warn('⚠️ Peu de rollouts récents — advaith KO ou Cloudflare');
"""
    new_stats = """  sources.merged = experiments.length;
  sources.recent = experiments.filter((e) => e.recent).length;
  sources.user = experiments.filter((e) => e.type === 'user').length;
  sources.guild = experiments.filter((e) => e.type === 'guild').length;

  if (!DISCORD_TOKEN) console.warn('⚠️ DISCORD_USER_TOKEN manquant');
  if (sources.advaith === 0 && sources.recent === 0)
    console.warn('⚠️ Peu de rollouts récents — advaith KO ou Cloudflare');
  console.log(
    'Types: user',
    sources.user,
    'guild',
    sources.guild,
    'with global %',
    experiments.filter((e) => e.hasGlobalPct).length,
  );
"""
    if old_stats not in t:
        raise SystemExit('stats miss')
    t = t.replace(old_stats, new_stats, 1)

    # 6) Embed: show type user/guild
    if "e.type || 'guild'" not in t and 'Type `' not in t:
        # find treatment lines builder
        pass

    t = t.replace(
        "console.log('📊 Apex rollouts v4 (Wumpus-style)…');",
        "console.log('📊 Apex rollouts v4.1 (user + guild)…');",
        1,
    )
    t = t.replace(
        'Apex rollouts v4 (Wumpus-style)',
        'Apex rollouts v4.1 (user + guild)',
        1,
    )

    # Improve embed field to include type
    old_field = "value: lines.join('\\n') || '—',"
    # try multiple patterns for embed body lines
    # In buildEmbeds when listing experiments, add type prefix
    if "` + (e.type === 'user' ? 'user' : 'guild')" not in t:
        t2 = re.sub(
            r"(\*\*`\$\{e\.id\}`\*\*)",
            r"**`${e.id}`** · `${e.type || 'guild'}`",
            t,
            count=3,
        )
        # if template literals use different style
        if t2 == t:
            t = t.replace(
                "'**`' + e.id + '`**'",
                "'**`' + e.id + '`** · `' + (e.type || 'guild') + '`'",
            )
            t = t.replace(
                '"**`" + e.id + "`**"',
                '"**`" + e.id + "`** · `" + (e.type || "guild") + "`"',
            )
        else:
            t = t2

    p.write_text(t)
    print('patched ok', len(t))

if __name__ == '__main__':
    main()
