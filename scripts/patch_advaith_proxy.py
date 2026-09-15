#!/usr/bin/env python3
"""Replace fetchAdvaith with multi-URL + proxy fallback (CF blocks GHA)."""
from pathlib import Path
import re

p = Path('src/apex_rollouts.js')
t = p.read_text()

OLD = r'''async function fetchAdvaith(hashMap) {
  try {
    const res = await fetch(ADVAITH, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: 'https://rollouts.advaith.io/',
        Origin: 'https://rollouts.advaith.io',
      },
      timeout: 45000,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('not array');
    const list = data.map((r) => fromAdvaith(r, hashMap)).filter(Boolean);
    const recentN = list.filter((e) => e.recent).length;
    console.log('advaith:', list.length, 'recent', recentN);
    if (list.length) console.log('advaith sample:', list.slice(0, 5).map((e) => e.id).join(', '));
    return list;
  } catch (e) {
    console.warn('advaith fail:', e.message);
    return [];
  }
}'''

NEW = r'''async function fetchAdvaith(hashMap) {
  // Direct API is often CF 403 from GitHub Actions. Try mirrors/proxies.
  // Wumpus-style live guild % (incl. 2026-08-profile-read-state-v1, quest gates)
  // come from this dataset — without it we only see ~16 Discord public rollouts.
  const urls = [
    ADVAITH,
    process.env.APEX_ADVAITH_MIRROR || '',
    process.env.APEX_ADVAITH_PROXY || '',
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(ADVAITH),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(ADVAITH + '/'),
  ].filter(Boolean);

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    Referer: 'https://rollouts.advaith.io/',
    Origin: 'https://rollouts.advaith.io',
  };

  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, timeout: 50000 });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let data = await res.json();
      // allorigins sometimes wraps
      if (data && !Array.isArray(data) && Array.isArray(data.contents)) {
        try {
          data = JSON.parse(data.contents);
        } catch (_) {}
      }
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (_) {
          throw new Error('not json');
        }
      }
      if (!Array.isArray(data)) throw new Error('not array');
      if (!data.length) throw new Error('empty');
      const list = data.map((r) => fromAdvaith(r, hashMap)).filter(Boolean);
      if (!list.length) throw new Error('parsed 0');
      const recentN = list.filter((e) => e.recent).length;
      console.log(
        'advaith:',
        list.length,
        'recent',
        recentN,
        'via',
        url.startsWith(ADVAITH) ? 'direct' : url.includes('allorigins') ? 'allorigins' : 'mirror',
      );
      const want = ['profile-read-state', 'quest-home-bounties'];
      for (const w of want) {
        const hit = list.find((e) => String(e.id).includes(w));
        if (hit)
          console.log(
            '  hit',
            hit.id,
            (hit.treatments || []).map((t) => t.label + '=' + t.pct + '%').join(', '),
          );
      }
      if (list.length) console.log('advaith sample:', list.slice(0, 5).map((e) => e.id).join(', '));
      return list;
    } catch (e) {
      lastErr = e;
      console.warn('advaith try fail:', (url || '').slice(0, 60), e.message);
    }
  }
  console.warn('advaith fail (all mirrors):', lastErr && lastErr.message);
  console.warn(
    'Tip: set secret APEX_ADVAITH_MIRROR to a JSON mirror of api.rollouts.advaith.io (Wumpus source).',
  );
  return [];
}'''

if OLD not in t:
    # fuzzy replace by function body
    m = re.search(r'async function fetchAdvaith\(hashMap\) \{[\s\S]*?\n\}\n\nasync function fetchJson', t)
    if not m:
        raise SystemExit('fetchAdvaith not found')
    t = t[: m.start()] + NEW + '\n\nasync function fetchJson' + t[m.end() :]
    print('fuzzy replaced')
else:
    t = t.replace(OLD, NEW, 1)
    print('exact replaced')

# Prefer advaith over discord for same id when both have %
if "e.source === 'advaith'" in t and 'advaith wins' not in t:
    pass

# Ensure loadExperiments: advaith overwrites discord for same id when advaith has more treatments
old_merge = '''    for (const e of adv) {
      // advaith wins on name if discord only had hash:
      const prev = byId.get(e.id);
      if (!prev || String(prev.id).startsWith('hash:') || e.recent) byId.set(e.id, e);
      else if (!prev.recent && e.fingerprint !== 'empty') byId.set(e.id, e);
    }'''
new_merge = '''    for (const e of adv) {
      // advaith = best live guild % source (Wumpus uses this)
      const prev = byId.get(e.id);
      if (!prev) {
        byId.set(e.id, e);
        continue;
      }
      const prevPct = (prev.treatments || []).some((t) => t && t.pct != null);
      const nextPct = (e.treatments || []).some((t) => t && t.pct != null);
      if (nextPct && (!prevPct || e.source === 'advaith')) byId.set(e.id, e);
      else if (String(prev.id).startsWith('hash:')) byId.set(e.id, e);
      else if (e.recent && !prev.recent) byId.set(e.id, e);
    }'''
if old_merge in t:
    t = t.replace(old_merge, new_merge, 1)
    print('merge updated')

p.write_text(t)
print('ok', 'fetchAdvaith multi' in t or 'allorigins' in t)
